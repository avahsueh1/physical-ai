"""A scripted navigator that knows the whole course (privileged information).

It is the *teacher*: it generates synthetic demonstrations, labels what the
right move would have been (for DAgger), and acts as the "sensible recovery"
when we ask "what if I did X, could I still recover?" (viability labels).
The learned brain never sees what the expert sees; it only sees sensors.

Rules, decided once per gait cycle (4 decisions):
  1. Impassable tunnel ahead (it knows the true clearance): stop before it.
  2. Off course (bearing error > 5 deg) or a tall rock ahead: turn gait.
  3. On / about to reach ice: two-anchor gait (scales can't bite on ice).
  4. Otherwise: inchworm (fastest on normal ground and slopes).
"""
from __future__ import annotations

import math

import numpy as np

from .actions import GAIT_NAMES, GAITS, IDX

TALL_ROCK = 0.22         # rocks taller than this are steered around (measured: >= 0.25 blocks)
TURN_DEG = 5.0
MAX_OFF = 20.0           # degrees away from the course direction


class Expert:
    def __init__(self, env, ignore_gap=False):
        self.env = env
        self.ignore_gap = ignore_gap
        self.gait, self.phase = "inchworm", 0

    def reset(self):
        self.gait, self.phase = "inchworm", 0

    # ---------------------------------------------------------- perception
    def _pose(self):
        st = self.env.status()
        return np.asarray(st["com"][:2]), st["yaw"]

    def _on_ice(self, xy, yaw):
        pats = self.env.course.terrain.get("patches", [])
        for look in (0.0, 1.5, 3.0):
            x = xy[0] + look * math.cos(yaw)
            y = xy[1] + look * math.sin(yaw)
            for p in pats:
                if p.get("grip", 1) < 0.3 and p["x0"] <= x <= p["x1"] and p["y0"] <= y <= p["y1"]:
                    return True
        return False

    def _target(self, xy, yaw):
        env = self.env
        s, _ = env.path.project(xy)
        tgt = env.path.point(s + env.lookahead + 1.0)
        # path direction here (steer relative to the course, not to our own heading)
        p0, p1 = env.path.point(s), env.path.point(s + 1.0)
        pd = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
        fwd, lat = np.array([math.cos(pd), math.sin(pd)]), np.array([-math.sin(pd), math.cos(pd)])
        # steer around tall rocks that sit near the line we are heading along
        for b in env.course.terrain.get("boxes", []):
            if b.get("kind") != "rock" or b.get("height", 0) < TALL_ROCK:
                continue
            rel = np.array([b["cx"], b["cy"]]) - xy
            ahead, side = float(rel @ fwd), float(rel @ lat)
            r = max(b["hx"], b["hy"])
            if -1.0 < ahead < 10.0 and abs(side) < 1.5 + r:
                shift = (1.7 + r) * (-1 if side > 0 else 1)
                tgt = xy + fwd * max(ahead, 2.0) + lat * (side + shift)
                break
        return tgt

    # ---------------------------------------------------------------- act
    def choose_gait(self):
        env = self.env
        xy, yaw = self._pose()
        c = env.course
        if c.family == "gaps" and not self.ignore_gap and not c.meta.get("passable", True):
            if env.front_x() > c.meta["gap_x"] - 2.6:   # a cycle + the release coast before the entrance
                return "stop"
        tgt = self._target(xy, yaw)
        err = math.degrees(math.atan2(tgt[1] - xy[1], tgt[0] - xy[0]) - yaw)
        err = (err + 180) % 360 - 180
        # never swing more than MAX_OFF degrees away from the course direction (turning back is slow)
        s, _ = env.path.project(xy)
        p0, p1 = env.path.point(s), env.path.point(s + 1.0)
        off = (math.degrees(yaw - math.atan2(p1[1] - p0[1], p1[0] - p0[0])) + 180) % 360 - 180
        if abs(off) > MAX_OFF and err * off > 0:
            err = 0.0
        if abs(err) > TURN_DEG:
            return "left" if err > 0 else "right"
        if self._on_ice(xy, yaw):
            return "anchor"
        return "inchworm"

    def act(self) -> int:
        if self.phase == 0:
            self.gait = self.choose_gait()
        a = IDX[GAITS[self.gait][self.phase]]
        self.phase = (self.phase + 1) % 4
        return a

    # what the expert would do *right now*, without advancing its own clock
    def label(self) -> int:
        g = self.choose_gait() if self.phase == 0 else self.gait
        return IDX[GAITS[g][self.phase]]

    def label_gait(self) -> int:
        """At the start of a cycle (phase 0): which gait the expert would pick now. Else -1."""
        return GAIT_NAMES.index(self.choose_gait()) if self.phase == 0 else -1

    def state(self):
        return (self.gait, self.phase)

    def set_state(self, s):
        self.gait, self.phase = s


def run_episode(env, course, policy=None, expert=None, record=False, on_step=None):
    """Roll out `policy(obs, env) -> action` (default: the expert) on one course."""
    obs = env.reset(course)
    expert = expert or Expert(env)
    expert.reset()
    traj = {"obs": [], "act": [], "expert": [], "near": [], "info": []}
    info = {}
    done = False
    while not done:
        lab = expert.label()
        a = expert.act() if policy is None else policy(obs, env)
        if policy is not None:
            expert.phase = (expert.phase + 1) % 4   # keep the expert's gait clock running
        if record:
            traj["obs"].append(obs); traj["act"].append(a); traj["expert"].append(lab)
        obs, r, done, info = env.step(a)
        if record:
            traj["near"].append(info["near"]); traj["info"].append(
                {k: info[k] for k in ("failure", "success", "progress", "t")})
        if on_step:
            on_step(env, a, info)
    return info, traj
