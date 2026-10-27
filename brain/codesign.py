"""Body + brain co-design: which origami body is easiest to drive?

For each candidate body (number of cells, cell length H, twist phi) the
course-following expert drives a fixed suite of courses. The score rewards
finishing, progress and speed, and punishes tearing a crease. Cells are an
integer, so we search each cell count separately with a small evolution
strategy over (H, phi).

This is the "intelligence lives in the body too" experiment: a body that
turns tighter or tears less makes the same small brain look smarter.
"""
from __future__ import annotations

import multiprocessing as mp
import os
import time

import numpy as np

from .courses import make_course
from .env import CourseEnv
from .expert import run_episode
from .sim import CreaseSim

BOUNDS = {"H": (0.7, 1.4), "phi": (25.0, 60.0)}


def body_worker(job):
    body, family, seed = job
    sim = CreaseSim()
    try:
        env = CourseEnv(sim, body=body)
        course = make_course(family, seed)
        info, _ = run_episode(env, course)
        return {"body": body, "family": family, "seed": seed, "success": bool(info["success"]),
                "failure": info["failure"], "progress": min(1.0, info["progress"] / course.length),
                "decisions": info["t"], "length": env.body_length}
    except Exception as e:                    # an unbuildable body is just a bad body
        return {"body": body, "family": family, "seed": seed, "success": False, "failure": f"error:{e}",
                "progress": 0.0, "decisions": 0, "length": 0}
    finally:
        sim.close()


def score(rows):
    s = np.mean([r["success"] for r in rows]); p = np.mean([r["progress"] for r in rows])
    torn = np.mean([r["failure"] == "torn" for r in rows])
    fast = np.mean([r["progress"] / max(r["decisions"], 1) * 100 for r in rows])
    return float(s + 0.5 * p + 0.05 * fast - 1.0 * torn)


def evaluate_bodies(bodies, suite, pool):
    jobs = [(b, f, s) for b in bodies for f, s in suite]
    res = pool.map(body_worker, jobs)
    out = []
    for i, b in enumerate(bodies):
        rows = res[i * len(suite):(i + 1) * len(suite)]
        out.append({"body": b, "score": score(rows), "success": float(np.mean([r["success"] for r in rows])),
                    "progress": float(np.mean([r["progress"] for r in rows])),
                    "failures": [r["failure"] for r in rows if r["failure"]]})
    return out


def search(cells=(2, 3, 4, 5, 6), suite=None, pop=6, gens=3, workers=None, seed=0, verbose=True):
    suite = suite or [(f, s) for f in ("corridor", "rubble", "slopes", "mixed") for s in (500, 501)]
    rng = np.random.default_rng(seed)
    lo = np.array([BOUNDS["H"][0], BOUNDS["phi"][0]]); hi = np.array([BOUNDS["H"][1], BOUNDS["phi"][1]])
    history = []
    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    t0 = time.time()
    with mp.get_context("spawn").Pool(workers) as pool:
        # the hand-designed default body first, as the reference
        ref = evaluate_bodies([{"cells": 4, "H": 1.0, "phi": 50.0}], suite, pool)[0]
        ref["reference"] = True; history.append(ref)
        if verbose:
            print(f"  default body (4 cells, H 1.0, phi 50): score {ref['score']:.3f} success {ref['success']:.0%}")
        for c in cells:
            mean, sigma = np.array([1.0, 40.0]), (hi - lo) / 4
            best = None
            for g in range(gens):
                X = np.clip(mean + sigma * rng.standard_normal((pop, 2)), lo, hi)
                bodies = [{"cells": int(c), "H": round(float(x[0]), 3), "phi": round(float(x[1]), 1)} for x in X]
                res = evaluate_bodies(bodies, suite, pool)
                history += res
                order = np.argsort([-r["score"] for r in res])
                elite = X[order[: max(2, pop // 3)]]
                mean, sigma = elite.mean(0), np.maximum(elite.std(0), (hi - lo) / 20)
                if best is None or res[order[0]]["score"] > best["score"]:
                    best = res[order[0]]
                if verbose:
                    print(f"  cells {c} gen {g + 1}/{gens}: best {best['body']} score {best['score']:.3f} "
                          f"success {best['success']:.0%}   {time.time() - t0:.0f}s", flush=True)
    history.sort(key=lambda r: -r["score"])
    return history
