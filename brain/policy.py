"""The lightweight controller: a tiny network that picks a *gait*, plus a rhythm generator.

    sensors ──► tiny MLP ──► gait (inchworm / anchor / left / right / stop), once per cycle
                                │
                     rhythm generator (CPG): plays the gait's 4 moves, one every 1.5 s

This is the same split animals use: a central pattern generator makes the
rhythm, and the brain only decides which rhythm. A first version predicted
the 8 low-level moves directly from sensors plus the previous move. It fell
into the classic copycat trap ("causal confusion"): once it had made one
turning move, the previous-move input told it to keep turning. On rubble it
agreed with the expert only 17% of the time. Choosing a gait once per cycle,
from sensors only, removes that shortcut.

Training: behaviour cloning on the expert's gait choices, then DAgger. The
student drives, the expert labels every cycle start the student reaches, and
the net is retrained on everything.

Sizes: tiny (16x16, ~600 params) fits an Arduino Nano; small (32x32);
medium (64x64). `export` writes a C header with the net + the gait table.
"""
from __future__ import annotations

import math
import multiprocessing as mp
import os

import numpy as np

from .actions import GAIT_NAMES, GAITS, IDX, N_ACTIONS
from .courses import make_course
from .data import N_DYN
from .env import OBS_NAMES, CourseEnv
from .expert import Expert
from .nn import MLP, export_c_header, softmax
from .sim import CreaseSim

SIZES = {"tiny": [16, 16], "small": [32, 32], "medium": [64, 64]}
N_GAITS = len(GAIT_NAMES)
CPG = np.array([[IDX[m] for m in GAITS[g]] for g in GAIT_NAMES])     # (gaits, 4) move table
GOAL_SIN, GOAL_COS = OBS_NAMES.index("goal_sin"), OBS_NAMES.index("goal_cos")
TURN_L, TURN_R = GAIT_NAMES.index("left"), GAIT_NAMES.index("right")


def features(obs):
    """What the gait brain sees: sensors + goal, NOT its own previous moves."""
    return np.atleast_2d(obs)[:, :N_DYN]


class Policy:
    def __init__(self, size="tiny", seed=0):
        self.size = size
        self.net = MLP([N_DYN] + SIZES[size] + [N_GAITS], seed=seed)
        self.reset()

    def reset(self):
        self.phase, self.gait = 0, 0
        self.history = []          # (gait, goal bearing) at recent cycle starts, for the reflex
        self.reflexes = 0
        if not hasattr(self, "use_reflex"):
            self.use_reflex = False    # tried and measured: see _reflex

    def _reflex(self, g, obs):
        """'Turning isn't working' reflex (OFF by default): after two cycles of the same turn with the
        goal bearing changed by < 4 degrees, crawl one cycle instead. Aimed at the controller's most
        common rubble failure, pivoting forever against a boulder. Measured on the full run: it rescued
        5 of 10 failing rubble courses but broke about as many others, so overall success went
        79% -> 78% (tiny) and 79% -> 75% (small, medium). Kept as a switch for experiments."""
        o = np.asarray(obs).reshape(-1)
        b = math.atan2(o[GOAL_SIN], o[GOAL_COS])
        h = self.history
        if (self.use_reflex and g in (TURN_L, TURN_R) and len(h) >= 2 and h[-1][0] == g and h[-2][0] == g
                and abs(b - h[-2][1]) < math.radians(4)):
            g = GAIT_NAMES.index("inchworm"); self.reflexes += 1
        h.append((g, b)); del h[:-4]
        return g

    # ----------------------------------------------------- gait-level brain
    def gait_probs(self, obs):
        return softmax(self.net.predict(features(obs)))

    def choose_gait(self, obs):
        return int(self.gait_probs(obs)[0].argmax())

    # --------------------------------------------- move-level interface (CPG)
    def probs(self, obs):
        """Called once per 1.5 s decision. Advances the rhythm and returns a preference over the
        8 moves: the rhythm's move first, then REST, then the rest (used by the safety filter)."""
        if self.phase == 0:
            self.gait = self._reflex(self.choose_gait(obs), obs)
        a = CPG[self.gait, self.phase]
        self.phase = (self.phase + 1) % 4
        p = np.full((1, N_ACTIONS), 0.01); p[0, IDX["REST"]] = 0.05; p[0, a] = 0.9
        return p / p.sum()

    def __call__(self, obs, env=None):
        return int(self.probs(obs)[0].argmax())

    def batch_act(self, obs):
        """Stateless guess for imagined rollouts: continue the current gait."""
        return np.full(len(np.atleast_2d(obs)), CPG[self.gait, self.phase])

    # -------------------------------------------------------------- training
    def fit(self, obs, gaits, epochs=80, **kw):
        m = gaits >= 0
        y = gaits[m].astype(int)
        # balance the rare gaits (stop, turns) against the common inchworm
        cnt = np.bincount(y, minlength=N_GAITS).astype(float)
        w = (len(y) / (N_GAITS * np.maximum(cnt, 1)))[y] ** 0.5
        return self.net.fit(features(obs[m]), y, loss="ce", epochs=epochs, weights=w, **kw)

    def accuracy(self, obs, gaits):
        m = gaits >= 0
        return float((self.gait_probs(obs[m]).argmax(1) == gaits[m]).mean())

    def save(self, path):
        d = self.net.state(); d["size"] = np.array(self.size)
        np.savez(path, **d)

    @classmethod
    def load(cls, path):
        z = np.load(path, allow_pickle=False)
        p = cls.__new__(cls); p.size = str(z["size"]); p.net = MLP.from_state(z); p.reset()
        return p

    def export(self, path, name="crawler"):
        rows = ",\n  ".join("{" + ", ".join(str(int(v)) for v in r) + "}" for r in CPG)
        extra = (f"// gait index -> 4 moves played by the rhythm generator, one per 1.5 s\n"
                 f"// gaits: {', '.join(GAIT_NAMES)}\n"
                 f"// moves: 0 REST 1 SQUEEZE 2 SQUEEZE_L 3 SQUEEZE_R 4 GRIP_HEAD 5 GRIP_TAIL 6 GRIP_TAIL_L 7 GRIP_TAIL_R\n"
                 f"static const unsigned char {name}_cpg[{N_GAITS}][4] = {{\n  {rows}}};\n"
                 f"// input: the first {N_DYN} observation values (see brain/env.py OBS_NAMES)\n")
        export_c_header(self.net, path, name=name, extra=extra)


def _student_worker(job):
    """Let the student drive one course; the expert labels every cycle start it reaches."""
    family, seed, state, body, beta = job
    rng = np.random.default_rng(seed + 991)
    pol = Policy.__new__(Policy); pol.net = MLP.from_state(state); pol.size = ""; pol.reset()
    sim = CreaseSim(); env = CourseEnv(sim, body=body)
    course = make_course(family, seed)
    obs = env.reset(course); ex = Expert(env)
    O, G = [], []
    done, info = False, {}
    expert_cycle = False
    while not done:
        if pol.phase == 0:
            ex.phase = 0
            g = ex.label_gait()
            O.append(obs); G.append(g)
            expert_cycle = rng.random() < beta
            if expert_cycle:
                pol.gait = g
        if expert_cycle and pol.phase == 0:
            pol.phase = 1; a = int(CPG[pol.gait, 0])
        else:
            a = pol(obs)
        obs, _, done, info = env.step(a)
    sim.close()
    return np.asarray(O, np.float32), np.asarray(G), bool(info.get("success")), info.get("failure")


def dagger(policy: Policy, demo_obs, demo_gaits, families, seeds, rounds=3, workers=None,
           body=None, epochs=80, verbose=True):
    O, G = [demo_obs], [demo_gaits]
    policy.fit(np.concatenate(O), np.concatenate(G), epochs=epochs)
    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    for r in range(rounds):
        beta = 0.3 * (0.5 ** r)          # mix in fewer expert cycles each round
        jobs = [(f, s, policy.net.state(), body or {}, beta) for f in families for s in seeds]
        with mp.get_context("spawn").Pool(workers) as pool:
            res = pool.map(_student_worker, jobs)
        for o, g, _, _ in res:
            O.append(o); G.append(g)
        succ = np.mean([s for _, _, s, _ in res])
        policy.fit(np.concatenate(O), np.concatenate(G), epochs=epochs)
        if verbose:
            print(f"  DAgger round {r + 1}/{rounds}: student success while collecting {succ:.0%}, "
                  f"dataset {sum(int((g >= 0).sum()) for g in G)} labelled cycle starts")
    return policy
