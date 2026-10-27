#!/usr/bin/env python3
"""Standard demo videos from a finished run (needs ffmpeg).

    python scripts/make_videos.py --run runs/full

  1_gap_reckless.mp4         "go forward" into a tunnel it doesn't fit, no safety filter
  2_gap_reckless_filter.mp4  the same command with the world-model filter
  3_gap_fits.mp4             a tunnel it does fit (the filter should NOT stop it)
  4_corridor.mp4 5_slopes.mp4 6_rubble.mp4 7_mixed.mp4   the tiny controller + filter
  8_rubble_stuck.mp4         the learned controller's most common failure, for honesty
"""
import argparse
import glob
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from brain.courses import make_course     # noqa: E402
from scripts.run_mission import run       # noqa: E402


def first_seed(family, want_passable, start=1000):
    s = start
    while make_course(family, s).meta.get("passable", True) != want_passable:
        s += 1
    return s


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="runs/full")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    out = a.out or os.path.join(a.run, "videos"); os.makedirs(out, exist_ok=True)
    wm = os.path.join(a.run, "world_model.npz")
    pols = sorted(glob.glob(os.path.join(a.run, "policy_*.npz")))
    pol = next((p for p in pols if "tiny" in p), pols[0] if pols else "expert")
    low, high = first_seed("gaps", False), first_seed("gaps", True)
    jobs = [
        (f"gaps:{low}", "go forward", "daredevil", None, "1_gap_reckless.mp4", "reckless driver, no filter"),
        (f"gaps:{low}", "go forward", "daredevil", wm, "2_gap_reckless_filter.mp4", "reckless driver + world-model filter"),
        (f"gaps:{high}", "go forward", pol, wm, "3_gap_fits.mp4", None),
        ("corridor:1001", "crawl to the end", pol, wm, "4_corridor.mp4", None),
        ("slopes:1001", "crawl to the end, carefully", pol, wm, "5_slopes.mp4", None),
        ("rubble:1000", "crawl to the end", pol, wm, "6_rubble.mp4", None),
        ("mixed:1002", "crawl to the end", pol, wm, "7_mixed.mp4", None),
        ("rubble:1001", "crawl to the end", pol, wm, "8_rubble_stuck.mp4",
         "the typical failure: pivoting against a boulder"),
    ]
    for course, say, driver, w, fn, title in jobs:
        print(f"\n=== {fn}")
        if title:
            title = f'"{say}"  |  {title}'
        run(course, say, driver, w, os.path.join(out, fn), title=title)
