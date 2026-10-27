"""Synthetic data from the simulator: the experience the brain learns from.

Three kinds of data, all generated (no real robot needed yet):

1. demos        the expert driving: (observation, expert action)       -> controller
2. transitions  the expert with random 'mistakes' mixed in (epsilon):    -> world model
                (obs, action, next obs, progress, near-miss, failure)
3. what-ifs     at sampled moments, rewind the world and try EVERY action,
                then let the expert try to recover for H decisions:      -> risk / viability model
                "if I did X now, would I still be OK H steps later?"
                This is the climbing idea: learn which moves remove your
                options *without* the real robot ever having to fall.

Model collapse guard: every dataset comes from the physics simulator, never
from the brain's own imagination. Imagined rollouts are only used to *choose*
actions, not as training targets (see README, "Synthetic data").
"""
from __future__ import annotations

import multiprocessing as mp
import os
import time

import numpy as np

from .actions import N_ACTIONS
from .courses import make_course
from .env import CourseEnv, OBS_DIM
from .expert import Expert
from .sim import CreaseSim

# What the risk model learns to predict: *irreversible* failures. Getting stuck is a
# performance problem, not a safety one, and counting it made REST look like the only safe
# move in any awkward spot (resting never counts as stuck), so the filter froze the robot.
CATASTROPHIC = {"torn", "flipped", "slid", "wedged", "nan"}

H_DEFAULT = 8            # what-if horizon (decisions, ~12 s, ~3 gait cycles)
N_DYN = OBS_DIM - N_ACTIONS - 1   # observation dims the world model predicts (not the prev-action bookkeeping)


def _branch(env, expert, H):
    """Try every action from the current moment, then let a *careful* expert try to
    recover for H decisions. Returns (fail[A], near[A], progress[A])."""
    root = env.snapshot()
    ex_state = expert.state()
    p0 = env.path.project(env.status()["com"][:2])[0]
    fail = np.zeros(N_ACTIONS, np.float32); near = np.zeros(N_ACTIONS, np.float32)
    prog = np.zeros(N_ACTIONS, np.float32)
    for a in range(N_ACTIONS):
        env.restore(root)
        _, _, done, info = env.step(a)
        f = info["failure"] in CATASTROPHIC; n = len(info["near"])
        expert.set_state((expert.gait, 0))          # recovery: expert re-plans from a fresh cycle
        k = 0
        while not done and k < H:
            _, _, done, info = env.step(expert.act())
            f = f or info["failure"] in CATASTROPHIC; n += len(info["near"]); k += 1
        fail[a] = f; near[a] = n
        prog[a] = env.path.project(env.status()["com"][:2])[0] - p0
    env.restore(root, drop=True)
    expert.set_state(ex_state)
    return fail, near, prog


def _near_hazard(env):
    """Privileged check used only to *where* to spend what-if effort (importance sampling):
    the last couple of metres before a tunnel the body doesn't fit."""
    c = env.course
    if c.family != "gaps" or c.meta.get("passable", True):
        return False
    return c.meta["gap_x"] - 3.2 < env.front_x() < c.meta["gap_x"] + 0.6


def rollout_worker(job):
    """One course: expert with epsilon-noise, recording transitions, demos and what-ifs.

    mode 'careful'   the normal expert (stops before tunnels it can't fit)
    mode 'daredevil' a driver that ignores tunnel height, so the data contains the
                     approach to the danger; the what-if recoveries and the demo labels
                     still come from the careful expert.
    """
    family, seed, eps, branch_every, H, body = job[:6]
    mode = job[6] if len(job) > 6 else "careful"
    rng = np.random.default_rng(seed * 31 + 7 + (mode == "daredevil"))
    sim = CreaseSim()
    env = CourseEnv(sim, body=body)
    course = make_course(family, seed)
    obs = env.reset(course)
    expert = Expert(env)                                   # labels + recovery
    driver = Expert(env, ignore_gap=True) if mode == "daredevil" else expert
    out = {k: [] for k in ("obs", "act", "next", "dprog", "near", "fail", "label", "gait",
                           "b_obs", "b_fail", "b_near", "b_prog")}
    done, info = False, {}
    prog = env.path.project(env.status()["com"][:2])[0]
    while not done:
        label = expert.label()
        gait = expert.label_gait()
        hazard = _near_hazard(env)
        if branch_every and env.t > 0 and (env.t % branch_every == 0 or hazard):
            f, n, p = _branch(env, expert, H)
            out["b_obs"].append(obs); out["b_fail"].append(f); out["b_near"].append(n); out["b_prog"].append(p)
        if rng.random() < eps:
            a = int(rng.integers(N_ACTIONS))
            driver.phase = (driver.phase + 1) % 4
        else:
            a = driver.act()
        if driver is not expert:
            expert.phase = driver.phase
        nobs, _, done, info = env.step(a)
        out["obs"].append(obs); out["act"].append(a); out["next"].append(nobs); out["label"].append(label)
        out["gait"].append(gait)
        out["dprog"].append(info["progress"] - prog); out["near"].append(len(info["near"]))
        out["fail"].append(info["failure"] in CATASTROPHIC)
        prog = info["progress"]; obs = nobs
    sim.close()
    res = {k: np.asarray(v, np.float32) for k, v in out.items()}
    res["meta"] = {"family": family, "seed": seed, "mode": mode, "success": bool(info.get("success")),
                   "failure": info.get("failure"), "t": info.get("t")}
    return res


def collect(families, seeds, eps=0.25, branch_every=6, H=H_DEFAULT, workers=None, body=None, verbose=True,
            daredevil=0.5):
    """`daredevil`: extra episodes (as a fraction of len(seeds)) in which a reckless driver
    heads into tunnels the body does NOT fit, so the what-if data covers the edge of the cliff.
    Their seeds come from a separate pool (10000+) and are chosen to be impassable."""
    jobs = [(f, s, eps, branch_every, H, body or {}, "careful") for f in families for s in seeds]
    if "gaps" in families and daredevil > 0:
        n = int(round(daredevil * len(seeds)))
        pool_seeds, s = [], 10000 + min(seeds, default=0)
        while len(pool_seeds) < n:
            if not make_course("gaps", s).meta.get("passable", True):
                pool_seeds.append(s)
            s += 1
        jobs += [("gaps", s, eps * 0.4, branch_every, H, body or {}, "daredevil") for s in pool_seeds]
    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    t0 = time.time()
    results = []
    with mp.get_context("spawn").Pool(workers) as pool:
        for k, r in enumerate(pool.imap_unordered(rollout_worker, jobs), 1):
            results.append(r)
            if verbose and (k % max(1, len(jobs) // 10) == 0 or k == len(jobs)):
                print(f"  [{k}/{len(jobs)}] episodes  {time.time() - t0:.0f}s", flush=True)
    return merge(results)


def merge(results):
    keys = [k for k in results[0] if k != "meta"]
    data = {}
    for k in keys:
        parts = [r[k] for r in results if len(r[k])]
        data[k] = np.concatenate(parts) if parts else np.zeros((0,))
    data["episode_success"] = np.array([r["meta"]["success"] for r in results])
    data["episode_family"] = np.array([r["meta"]["family"] for r in results])
    data["episode_failure"] = np.array([str(r["meta"]["failure"]) for r in results])
    return data


def save(data, path):
    np.savez_compressed(path, **data)


def load(path):
    d = np.load(path, allow_pickle=False)
    return {k: d[k] for k in d.files}
