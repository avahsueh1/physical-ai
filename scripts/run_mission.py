#!/usr/bin/env python3
"""Give the crawler an instruction on a course and watch it think.

    python scripts/run_mission.py --course gaps:0 --say "go forward" \
        --driver daredevil --world-model runs/quick/world_model.npz --video runs/gap_safe.mp4

    --driver       expert | daredevil | path/to/policy_*.npz
    --world-model  omit to run with no safety filter
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from brain.agent import Brain              # noqa: E402
from brain.courses import make_course      # noqa: E402
from brain.env import CourseEnv            # noqa: E402
from brain.sim import CreaseSim            # noqa: E402


def run(course_spec, say, driver, world_model=None, video=None, body=None, quiet=False, title=None):
    fam, seed = course_spec.split(":")
    course = make_course(fam, int(seed))
    sim = CreaseSim(); env = CourseEnv(sim, body=body or {})
    obs = env.reset(course)
    brain = Brain.load(driver, world_model, env=env)
    m = brain.set_mission(say)
    if not quiet:
        print(f"course {course_spec}  ({course.length:.1f} long)  meta {json.dumps(course.meta, default=str)[:140]}")
        print(f"instruction: {say!r}\nmission:     {m.to_dict()}  (risk budget {m.tau})")
    rec = None
    if video:
        from brain.render import Recorder
        env.record_frames = 6
        rec = Recorder(env, course, title=title or f'"{say}"  |  {os.path.basename(driver)}'
                       f'{" + safety filter" if brain.filter else ""}')
    done, info = False, {}
    while not done:
        a = brain.act(obs, env)
        obs, _, done, info = env.step(a)
        if rec:
            rec.add(env.frames, f"t={info['t']:3d}  {brain.explain()}")
        if not quiet and (brain.note.find("vetoed") >= 0 or info["t"] % 10 == 0):
            print(f"  t={info['t']:3d}  {brain.explain():<45}  progress {info['progress']:.1f}")
        if brain.done and brain.mission.goal != "traverse":
            done = True
    outcome = ("success" if info["success"] else info["failure"] or
               ("mission complete" if brain.done else "timeout"))
    vetoes = brain.filter.vetoes if brain.filter else 0
    if not quiet:
        print(f"outcome: {outcome}   decisions {info['t']}   progress {info['progress']:.1f}/{course.length:.1f}"
              f"   vetoes {vetoes}")
    if rec:
        if rec.frames:
            rec.add([rec.frames[-1][0].ravel()] * 30, f"t={info['t']:3d}  outcome: {outcome}")
        rec.save(video)
        if not quiet:
            print(f"video: {video}")
    sim.close()
    return outcome, info, vetoes


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--course", default="gaps:0", help="family:seed, family in gaps corridor slopes rubble mixed")
    ap.add_argument("--say", default="crawl to the end")
    ap.add_argument("--driver", default="expert")
    ap.add_argument("--world-model", default=None)
    ap.add_argument("--video", default=None)
    a = ap.parse_args()
    run(a.course, a.say, a.driver, a.world_model, a.video)
