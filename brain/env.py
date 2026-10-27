"""CourseEnv: the crawler in a course, as a decision-by-decision environment.

Observation (what a real robot could measure, plus where it's trying to go):
    13 range finders (incl. the clearance sensor and 3 low obstacle rays), pitch, roll, body length, wall-contact force, foot slip,
    4 cable tensions, 2 anchor states, goal bearing (sin, cos) + distance,
    previous action (one-hot)
Action: one of the 8 primitives in actions.py, held for 1.5 s.

Every step reports
    failure   'torn' | 'flipped' | 'stuck' | 'slid' | 'wedged' | 'nan' | None  (episode ends)
    near      list of near-misses: high strain, big roll, hard wall contact, back-slide
    success   reached the goal (or, for an impassable tunnel: chose to stop in front of it)
"""
from __future__ import annotations

import math
from collections import deque

import numpy as np

from .actions import DECISION_SECONDS, N_ACTIONS, command
from .courses import Course
from .sim import CreaseSim

RAYS = ["fwd", "fwdUp10", "fwdUp", "fwdDown", "left30", "right30", "left90", "right90", "up", "clearance",
        "fwdLow", "leftLow", "rightLow"]
OBS_NAMES = ([f"range_{r}" for r in RAYS] + ["pitch", "roll", "length", "wall_force", "slip"] +
             [f"cable_{i}" for i in range(4)] + ["anchor_front", "anchor_rear"] +
             ["goal_sin", "goal_cos", "goal_dist", "prev_repeat"] + [f"prev_{i}" for i in range(N_ACTIONS)])
OBS_DIM = len(OBS_NAMES)

# failure / near-miss thresholds (see README "How failure is defined")
TEAR_STRAIN = 0.09        # panels stretched 9%: paper would tear
NEAR_STRAIN = 0.06
FLIP_ROLL = math.radians(50)
NEAR_ROLL = math.radians(25)
FLIP_PITCH = math.radians(40)
NEAR_WALL_FORCE = 6.0
STUCK_WINDOW = 24         # decisions (~36 s, ~6 gait cycles)
STUCK_PROGRESS = 0.35     # must gain this much along the path per window
SLIDE_BACK = 1.5          # slid this far backwards within 8 decisions
STOP_DECISIONS = 6        # this many RESTs in a row = "I choose to stop here"


class Path:
    def __init__(self, pts):
        self.p = np.asarray(pts, float)
        seg = np.diff(self.p, axis=0)
        self.len = np.linalg.norm(seg, axis=1)
        self.cum = np.concatenate([[0], np.cumsum(self.len)])
        self.total = float(self.cum[-1])
        self.dir = seg / self.len[:, None]

    def project(self, xy):
        best = (1e9, 0.0, 0)
        for k in range(len(self.len)):
            d = np.asarray(xy) - self.p[k]
            t = float(np.clip(d @ self.dir[k], 0, self.len[k]))
            q = self.p[k] + t * self.dir[k]
            dist = float(np.linalg.norm(np.asarray(xy) - q))
            if dist < best[0]:
                best = (dist, self.cum[k] + t, k)
        return best[1], best[0]          # arc length, lateral distance

    def point(self, s):
        s = float(np.clip(s, 0, self.total))
        k = int(np.searchsorted(self.cum, s, side="right") - 1)
        k = min(k, len(self.len) - 1)
        return self.p[k] + (s - self.cum[k]) * self.dir[k]


class CourseEnv:
    def __init__(self, sim: CreaseSim | None = None, body: dict | None = None, lookahead: float = 3.0):
        self.sim = sim or CreaseSim()
        self.body = body or {}
        self.lookahead = lookahead
        self.record_frames = 0          # >0: env.frames gets that many node snapshots per decision (videos)
        self.frames = None

    # ------------------------------------------------------------- helpers
    def _obs(self, out) -> np.ndarray:
        se, st = out["sense"], out["status"]
        r = [min(se["ranges"][k], 5.0) / 5.0 for k in RAYS]
        s, _ = self.path.project(st["com"][:2])
        tgt = self.path.point(s + self.lookahead)
        dx, dy = tgt[0] - st["com"][0], tgt[1] - st["com"][1]
        bearing = math.atan2(dy, dx) - st["yaw"]
        prev = np.zeros(N_ACTIONS); prev[self.prev_action] = 1
        v = (r + [se["pitch"], se["roll"], se["length"], math.log1p(max(0.0, se["wallForce"])),
                  min(se["slip"], 2.0)] + list(se["cables"])[:4] + list(se["anchors"]) +
             [math.sin(bearing), math.cos(bearing), min(self.path.total - s, 30.0) / 30.0,
              min(self.repeat, 4) / 4.0] + list(prev))
        return np.asarray(v, np.float32)

    def _progress(self, st):
        return self.path.project(st["com"][:2])[0]

    # ----------------------------------------------------------------- api
    def reset(self, course: Course):
        self.course = course
        self.path = Path(course.waypoints)
        out = self.sim.reset(params=self.body, terrain=course.terrain, pose=course.start)
        self.body_length = out["bodyLength"]
        self.t = 0
        self.prev_action = 0
        self.repeat = 0
        self.last = out
        self.prog_hist = deque([self._progress(out["status"])], maxlen=STUCK_WINDOW + 1)
        self.rest_run = 0
        self.near_count = 0
        return self._obs(out)

    def status(self):
        return self.last["status"]

    def front_x(self):
        """x of the front plate's centre."""
        return self.last["status"]["front"][0]

    def step(self, a: int):
        a = int(a)
        out = self.sim.step(command(a), DECISION_SECONDS, frames=self.record_frames)
        self.frames = out.pop("frames", None)
        self.last = out
        self.t += 1
        st, se = out["status"], out["sense"]
        prog = self._progress(st)
        self.prog_hist.append(prog)
        self.rest_run = self.rest_run + 1 if a == 0 else 0
        self.repeat = self.repeat + 1 if a == self.prev_action else 1
        self.prev_action = a

        near = []
        if st["maxStrain"] > NEAR_STRAIN: near.append("strain")
        if abs(st["roll"]) > NEAR_ROLL: near.append("roll")
        if se["wallForce"] > NEAR_WALL_FORCE: near.append("wall")
        if len(self.prog_hist) > 8 and self.prog_hist[-1] < self.prog_hist[-9] - 0.5: near.append("backslide")
        self.near_count += bool(near)

        failure = None
        if st["nan"]: failure = "nan"
        elif st["maxStrain"] > TEAR_STRAIN: failure = "torn"
        elif abs(st["roll"]) > FLIP_ROLL or abs(st["pitch"]) > FLIP_PITCH: failure = "flipped"
        elif len(self.prog_hist) > 8 and self.prog_hist[-1] < self.prog_hist[-9] - SLIDE_BACK: failure = "slid"
        elif (self.course.family == "gaps" and not self.course.meta.get("passable", True)
              and self.front_x() > self.course.meta["gap_x"] + 0.6):
            failure = "wedged"               # drove into a tunnel it can't fit
        elif (len(self.prog_hist) == STUCK_WINDOW + 1 and self.rest_run < STOP_DECISIONS
              and self.prog_hist[-1] - self.prog_hist[0] < STUCK_PROGRESS):
            failure = "stuck"

        success = False
        remaining = self.path.total - prog
        refusing = self._holding_before_low_tunnel()
        if failure == "stuck" and refusing:
            failure = None                   # holding position in front of a tunnel it doesn't fit
            success = True
        if failure is None and not success:
            if remaining < 0.8:
                success = True
            elif refusing and self.rest_run >= STOP_DECISIONS:
                success = True               # correctly refused a gap it doesn't fit
        timeout = self.t >= self.course.max_decisions
        if timeout and failure is None and refusing:
            success = True
        done = bool(failure or success or timeout)
        info = {"failure": failure, "near": near, "success": success, "timeout": timeout and not success,
                "progress": prog, "remaining": remaining, "t": self.t, "status": st}
        # reward for RL users: progress, minus near-misses, big penalty for failure
        reward = (prog - self.prog_hist[-2] if len(self.prog_hist) > 1 else 0.0) - 0.05 * len(near)
        if failure: reward -= 10.0
        if success: reward += 10.0
        return self._obs(out), float(reward), done, info

    def _holding_before_low_tunnel(self):
        """Within 4 of the entrance of a tunnel the body doesn't fit, but not wedged inside it."""
        c = self.course
        if c.family != "gaps" or c.meta.get("passable", True):
            return False
        return c.meta["gap_x"] - 4.0 < self.front_x() < c.meta["gap_x"] + 0.6

    # imagination: save / rewind the world
    def snapshot(self):
        return (self.sim.snapshot(), self.t, self.prev_action, list(self.prog_hist), self.rest_run, self.last,
                self.near_count, self.repeat)

    def restore(self, snap, drop=False):
        sid, self.t, self.prev_action, ph, self.rest_run, self.last, self.near_count, self.repeat = snap
        self.sim.restore(sid)
        self.prog_hist = deque(ph, maxlen=STUCK_WINDOW + 1)
        if drop:
            self.sim.drop(sid)

    def release(self, snap):
        self.sim.drop(snap[0])

    def observe(self):
        return self._obs(self.last)
