#!/usr/bin/env python3
"""Does the 'fits if clearance > 0' rule match the physics?

Drives a crawler that ignores tunnel height into many gap courses and records
whether it actually got through. Prints a table by clearance bucket.

    python scripts/check_gaps.py --n 60
"""
import argparse
import multiprocessing as mp
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from brain.courses import make_course   # noqa: E402
from brain.env import CourseEnv         # noqa: E402
from brain.expert import Expert, run_episode  # noqa: E402


def job(seed):
    c = make_course("gaps", seed)
    truth = c.meta["passable"]
    c.meta["passable"] = True               # so the env doesn't call it 'wedged': we want to see what happens
    env = CourseEnv()
    try:
        info, _ = run_episode(env, c, expert=Expert(env, ignore_gap=True))
        return c.meta["clearance"], truth, bool(info["success"]), info["failure"]
    finally:
        env.sim.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--n", type=int, default=60); ap.add_argument("--workers", type=int)
    a = ap.parse_args()
    with mp.get_context("spawn").Pool(a.workers or max(1, os.cpu_count() - 1)) as p:
        rows = p.map(job, range(20000, 20000 + a.n))
    edges = [-1, -0.2, -0.1, -0.05, 0.0, 0.08, 0.2, 0.4, 1.0]
    print("clearance bucket     n   got through   rule says fits")
    for lo, hi in zip(edges[:-1], edges[1:]):
        b = [r for r in rows if lo <= r[0] < hi]
        if b:
            print(f"[{lo:+.2f}, {hi:+.2f})  {len(b):4d}   {np.mean([r[2] for r in b]):10.0%}   {np.mean([r[1] for r in b]):10.0%}")
    agree = np.mean([r[1] == r[2] for r in rows])
    print(f"rule agrees with simulation on {agree:.0%} of {len(rows)} courses")
