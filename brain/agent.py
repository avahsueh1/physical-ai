"""The whole mind in one object: mission (language) -> controller -> safety filter.

    brain = Brain.load(driver="runs/full/policy_tiny.npz", world_model="runs/full/world_model.npz")
    brain.set_mission("crawl 3 body lengths, carefully")
    a = brain.act(obs, env)          # every 1.5 s
    brain.explain()                  # one line: what it wanted, what it did, why
"""
from __future__ import annotations

import numpy as np

from .actions import IDX, NAMES
from .evaluate import _OneHotPolicy
from .expert import Expert
from .mission import Mission, parse
from .safety import SafeController


class Brain:
    def __init__(self, driver, world_model=None, llm=None):
        self.driver, self.wm, self.llm = driver, world_model, llm
        self.mission = Mission()
        self.filter = None
        self.start_progress = None
        self.note = ""
        self.done = False

    @classmethod
    def load(cls, driver="expert", world_model=None, env=None, llm=None):
        """driver: a policy .npz path, or 'expert' / 'daredevil' (need env)."""
        wm = None
        if world_model:
            from .world_model import WorldModel
            wm = WorldModel.load(world_model)
        if driver in ("expert", "daredevil"):
            ex = Expert(env, ignore_gap=(driver == "daredevil"))
            pol = _OneHotPolicy(lambda obs: ex.act())
        else:
            from .policy import Policy
            pol = Policy.load(driver)
        return cls(pol, wm, llm)

    def set_mission(self, text_or_mission):
        self.mission = text_or_mission if isinstance(text_or_mission, Mission) else parse(text_or_mission, self.llm)
        self.filter = None
        if self.wm is not None and self.mission.refuse_if_unsafe:
            self.filter = SafeController(self.driver, self.wm, tau=self.mission.tau)
        self.start_progress = None
        self.done = False
        return self.mission

    def act(self, obs, env=None):
        m = self.mission
        if m.goal == "stop":
            self.note, self.done = "mission: stop", True
            return IDX["REST"]
        if m.goal == "distance" and env is not None:
            p = env.prog_hist[-1] if env.prog_hist else 0.0
            if self.start_progress is None:
                self.start_progress = p
            body = env.sim.info().get("bodyLength", 4.9)
            if p - self.start_progress >= m.distance_bodies * body:
                self.note, self.done = f"mission: reached {m.distance_bodies:g} body lengths", True
                return IDX["REST"]
        if self.filter is None:
            a = int(np.argmax(self.driver.probs(obs)[0]))
            self.note = f"{NAMES[a]}"
            return a
        a = self.filter(obs)
        L = self.filter.last
        r = L["risk"]
        if L["chosen"] != L["proposed"]:
            self.note = f"{L['chosen']:<11} vetoed {L['proposed']} (risk {r[L['proposed']]:.2f})"
        else:
            self.note = f"{L['chosen']:<11} risk {r[L['chosen']]:.2f}"
        return a

    def explain(self):
        return self.note
