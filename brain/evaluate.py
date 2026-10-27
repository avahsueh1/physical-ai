"""Closed-loop evaluation on held-out courses.

Controller specs (strings, so they can be sent to worker processes):

  expert                         privileged hand-written driver (upper reference)
  daredevil                      the expert but blind to tunnel height (a reckless driver)
  random                         uniform random moves (lower reference)
  policy:PATH                    a trained tiny controller
  safe:POLICY_SPEC|WM_PATH|tau   any of the above wrapped in the world-model safety filter
                                 e.g. safe:daredevil|runs/wm.npz|0.3
"""
from __future__ import annotations

import multiprocessing as mp
import os
import time
from collections import Counter, defaultdict

import numpy as np

from .actions import N_ACTIONS
from .courses import make_course
from .env import CourseEnv
from .expert import Expert
from .sim import CreaseSim

_WM_CACHE = {}


def build_controller(spec, env, rng):
    """Return (controller(obs) -> action, on_override(chosen) or None, safe_filter or None)."""
    if spec.startswith("safe:"):
        inner, wm_path, tau = spec[5:].split("|")
        base, _, _ = build_controller(inner, env, rng)
        from .safety import SafeController
        from .world_model import WorldModel
        if wm_path not in _WM_CACHE:
            _WM_CACHE[wm_path] = WorldModel.load(wm_path)
        probs = _as_probs(base, inner, env)
        filt = SafeController(probs, _WM_CACHE[wm_path], tau=float(tau))
        return filt, None, filt
    if spec == "expert":
        ex = Expert(env); return (lambda obs: ex.act()), None, None
    if spec == "daredevil":
        ex = Expert(env, ignore_gap=True); return (lambda obs: ex.act()), None, None
    if spec == "random":
        return (lambda obs: int(rng.integers(N_ACTIONS))), None, None
    if spec.startswith("policy:"):
        from .policy import Policy
        pol = Policy.load(spec[7:]); return pol, None, None
    raise ValueError(spec)


class _OneHotPolicy:
    """Makes a deterministic driver look like a policy with action probabilities."""
    def __init__(self, fn):
        self.fn = fn

    def probs(self, obs):
        p = np.full((1, N_ACTIONS), 1e-3); p[0, self.fn(obs)] = 1.0
        return p / p.sum()

    def batch_act(self, obs):
        return np.array([self.fn(o) for o in np.atleast_2d(obs)])


def _as_probs(base, spec, env):
    if spec.startswith("policy:"):
        return base
    return _OneHotPolicy(base)


def eval_worker(job):
    spec, family, seed, body = job
    rng = np.random.default_rng(seed)
    sim = CreaseSim(); env = CourseEnv(sim, body=body)
    course = make_course(family, seed)
    obs = env.reset(course)
    ctrl, _, filt = build_controller(spec, env, rng)
    done, info, near = False, {}, 0
    t0 = time.time()
    while not done:
        a = ctrl(obs)
        obs, _, done, info = env.step(a)
        near += len(info["near"])
    sim.close()
    return {"spec": spec, "family": family, "seed": seed, "success": bool(info["success"]),
            "failure": info["failure"] or ("timeout" if info["timeout"] else None),
            "progress": float(min(1.0, info["progress"] / max(course.length, 1e-6))),
            "decisions": info["t"], "near": near,
            "passable": course.meta.get("passable", True),
            "vetoes": filt.vetoes if filt else 0, "wall_s": time.time() - t0}


def evaluate(specs, families, seeds, body=None, workers=None, verbose=True):
    jobs = [(s, f, sd, body or {}) for s in specs for f in families for sd in seeds]
    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    t0 = time.time(); rows = []
    with mp.get_context("spawn").Pool(workers) as pool:
        for k, r in enumerate(pool.imap_unordered(eval_worker, jobs), 1):
            rows.append(r)
            if verbose and (k % max(1, len(jobs) // 10) == 0 or k == len(jobs)):
                print(f"  [{k}/{len(jobs)}] eval episodes  {time.time() - t0:.0f}s", flush=True)
    return rows


def summarize(rows):
    """Table: per controller x family success rate, plus failure counts."""
    by = defaultdict(list)
    for r in rows:
        by[(r["spec"], r["family"])].append(r)
        by[(r["spec"], "ALL")].append(r)
    out = {}
    for (spec, fam), rs in by.items():
        out.setdefault(spec, {})[fam] = {
            "n": len(rs), "success": float(np.mean([r["success"] for r in rs])),
            "progress": float(np.mean([r["progress"] for r in rs])),
            "near_per_ep": float(np.mean([r["near"] for r in rs])),
            "vetoes_per_ep": float(np.mean([r["vetoes"] for r in rs])),
            "failures": dict(Counter(r["failure"] for r in rs if r["failure"])),
        }
    return out


def format_table(summary, families):
    cols = list(families) + ["ALL"]
    w = max(len(s) for s in summary) + 2
    lines = ["controller".ljust(w) + "".join(c[:9].rjust(10) for c in cols) + "   failures (all)"]
    for spec, fams in summary.items():
        cells = "".join(f"{fams[c]['success']:>10.0%}" if c in fams else " " * 10 for c in cols)
        fails = ", ".join(f"{k}:{v}" for k, v in sorted(fams["ALL"]["failures"].items()))
        lines.append(spec.ljust(w) + cells + "   " + fails)
    return "\n".join(lines)
