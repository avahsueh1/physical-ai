"""The browser brain (web/brain-web.js) must choose the same moves as the Python brain.
Uses the newest trained run in runs/ (full, else quick); skipped if there is none."""
import json
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

RUN = next((os.path.join(ROOT, "runs", r) for r in ("full", "quick")
            if os.path.exists(os.path.join(ROOT, "runs", r, "world_model.npz"))), None)


@pytest.mark.skipif(RUN is None or shutil.which("node") is None, reason="needs a trained run and node")
def test_browser_brain_matches_python(tmp_path):
    from brain.agent import Brain
    from brain.courses import make_course
    from brain.env import CourseEnv
    size = next(s for s in ("tiny", "small", "medium") if os.path.exists(os.path.join(RUN, f"policy_{s}.npz")))
    out = tmp_path / "model.js"
    subprocess.check_call([sys.executable, os.path.join(ROOT, "scripts", "export_web.py"), "--run", RUN,
                           "--size", size, "--out", str(out)], stdout=subprocess.DEVNULL)
    n_moves, agree, total = 32, 0, 0
    for ci in (0, 5, 9, 13, 17):
        js = json.loads(subprocess.check_output(["node", os.path.join(ROOT, "test", "brain_episode.js"), str(out), str(ci), str(n_moves)]))
        fam, seed = js["course"].split(":")
        env = CourseEnv()
        try:
            obs = env.reset(make_course(fam, int(seed)))
            brain = Brain.load(os.path.join(RUN, f"policy_{size}.npz"), os.path.join(RUN, "world_model.npz"), env=env)
            brain.set_mission("go forward")
            py = []
            for _ in js["acts"]:
                a = brain.act(obs, env); py.append(a)
                obs, _, done, _ = env.step(a)
                if done:
                    break
        finally:
            env.sim.close()
        k = min(len(py), len(js["acts"]))
        agree += sum(int(a == b) for a, b in zip(py[:k], js["acts"][:k])); total += k
    assert agree / total >= 0.97, f"browser and Python brains agree on only {agree}/{total} moves"
