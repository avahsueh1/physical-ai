"""Fast checks for the brain pipeline:  python -m pytest -q tests"""
import os
import shutil
import subprocess
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from brain.actions import IDX, N_ACTIONS                  # noqa: E402
from brain.courses import FAMILIES, make_course           # noqa: E402
from brain.env import OBS_DIM, CourseEnv                  # noqa: E402
from brain.mission import parse                           # noqa: E402
from brain.nn import MLP, Ensemble, export_c_header       # noqa: E402
from brain.safety import SafeController                   # noqa: E402


# ------------------------------------------------------------------ language
@pytest.mark.parametrize("text,goal,dist,risk,refuse", [
    ("crawl to the end", "traverse", None, "normal", True),
    ("go 3 body lengths forward", "distance", 3.0, "normal", True),
    ("carefully crawl two body lengths", "distance", 2.0, "careful", True),
    ("hurry up, squeeze through anyway", "traverse", None, "bold", False),
    ("stop", "stop", None, "normal", True),
])
def test_mission_parser(text, goal, dist, risk, refuse):
    m = parse(text)
    assert (m.goal, m.distance_bodies, m.risk, m.refuse_if_unsafe) == (goal, dist, risk, refuse)


def test_mission_llm_fallback():
    assert parse("stop", llm=lambda p: "not json").goal == "stop"
    m = parse("whatever", llm=lambda p: '{"goal":"distance","distance_bodies":4,"risk":"careful","refuse_if_unsafe":true}')
    assert (m.goal, m.distance_bodies, m.risk) == ("distance", 4, "careful")


# ---------------------------------------------------------------- networks
def test_mlp_learns_xor_and_roundtrips(tmp_path):
    X = np.array([[0, 0], [0, 1], [1, 0], [1, 1]] * 50, float); y = (X[:, 0] != X[:, 1]).astype(int)
    net = MLP([2, 16, 2], seed=0); net.fit(X, y, loss="ce", epochs=300, batch=32, lr=1e-2)
    assert (net.predict(X).argmax(1) == y).mean() == 1.0
    net.save(tmp_path / "n.npz"); net2 = MLP.load(tmp_path / "n.npz")
    assert np.allclose(net.predict(X), net2.predict(X))


def test_ensemble_disagrees_off_data():
    rng = np.random.default_rng(0)
    X = rng.uniform(-1, 1, (400, 1)); Y = np.sin(3 * X)
    e = Ensemble([1, 32, 32, 1], k=5); e.fit(X, Y, epochs=80)
    near = e.predict_all(np.array([[0.0]])).std(); far = e.predict_all(np.array([[6.0]])).std()
    assert far > near


@pytest.mark.skipif(shutil.which("gcc") is None, reason="needs gcc")
def test_c_header_matches_python(tmp_path):
    net = MLP([OBS_DIM, 16, 16, N_ACTIONS], seed=3)
    net.mu = np.random.default_rng(1).normal(size=OBS_DIM); net.sd = np.full(OBS_DIM, 1.3)
    export_c_header(net, tmp_path / "p.h", "pol")
    X = np.random.default_rng(2).normal(size=(20, OBS_DIM))
    rows = "\n".join("{" + ",".join(f"{v:.6f}f" for v in x) + "}," for x in X)
    (tmp_path / "m.c").write_text(f'#include <stdio.h>\n#include "p.h"\nstatic const float X[20][{OBS_DIM}] = {{{rows}}};\n'
                                  'int main(){for(int i=0;i<20;i++)printf("%d\\n",pol_act(X[i]));return 0;}\n')
    subprocess.check_call(["gcc", "-O2", "-o", str(tmp_path / "m"), str(tmp_path / "m.c"), "-lm"])
    out = [int(v) for v in subprocess.check_output([str(tmp_path / "m")]).split()]
    assert out == list(net.predict(X).argmax(1))


# ------------------------------------------------------------ safety filter
class _FakeWM:
    def __init__(self, risk):
        self.r = np.asarray(risk, float)

    def risk(self, obs, a):
        return self.r[np.asarray(a)], np.zeros(len(a))


class _FakePolicy:
    def __init__(self, fav):
        self.fav = fav

    def probs(self, obs):
        p = np.full((1, N_ACTIONS), 0.01); p[0, self.fav] = 0.9; p[0, 0] = 0.05
        return p / p.sum()


def test_filter_vetoes_only_when_a_safer_move_exists():
    sq = IDX["SQUEEZE"]
    risky = [0.0] + [0.9] * 7                  # only REST is safe
    f = SafeController(_FakePolicy(sq), _FakeWM(risky), tau=0.3)
    assert f(np.zeros(OBS_DIM)) == IDX["REST"] and f.vetoes == 1
    doomed = [0.9] * 8                         # nothing is safer: don't interfere
    f = SafeController(_FakePolicy(sq), _FakeWM(doomed), tau=0.3)
    assert f(np.zeros(OBS_DIM)) == sq and f.vetoes == 0
    fine = [0.05] * 8
    f = SafeController(_FakePolicy(sq), _FakeWM(fine), tau=0.3)
    assert f(np.zeros(OBS_DIM)) == sq


# ------------------------------------------------------- simulator + courses
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="needs node")


@pytest.mark.parametrize("family", FAMILIES)
def test_courses_build(family):
    c = make_course(family, 0)
    assert c.length > 5 and c.max_decisions > 0 and isinstance(c.terrain, dict)


@needs_node
def test_env_rewind_is_exact():
    env = CourseEnv()
    try:
        obs = env.reset(make_course("mixed", 3))
        assert obs.shape == (OBS_DIM,)
        for a in (1, 1, 0, 0):
            env.step(a)
        snap = env.snapshot()
        o1 = [env.step(a)[0] for a in (4, 4, 5, 5)]
        env.restore(snap, drop=True)
        o2 = [env.step(a)[0] for a in (4, 4, 5, 5)]
        assert np.allclose(o1, o2)
    finally:
        env.sim.close()


@needs_node
def test_frames_for_video():
    env = CourseEnv()
    try:
        env.reset(make_course("corridor", 1)); env.record_frames = 3
        env.step(1)
        assert len(env.frames) == 3 and len(env.frames[0]) % 3 == 0
    finally:
        env.sim.close()
