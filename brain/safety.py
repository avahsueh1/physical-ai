"""The safety filter: imagine before you commit.

The controller proposes moves in order of preference. For each one the world
model answers "if I do this, what is the chance I can't recover?" (its mean
risk plus `kappa` x the ensemble's disagreement, so a move the model is unsure
about counts as risky). A move is vetoed when its risk is over the budget `tau`
AND some other move is clearly safer (by `margin`). So in a state where every
move is equally doomed the filter stays out of the way instead of freezing,
and where one move keeps options open it insists on that one.

    brain = SafeController(policy, world_model, tau=0.3)
    a = brain(obs)               # same call signature as a plain policy
    brain.last                   # what it considered and why
"""
from __future__ import annotations

import numpy as np

from .actions import N_ACTIONS, NAMES


class SafeController:
    def __init__(self, policy, world_model, tau=0.3, kappa=1.0, margin=0.2, lookahead=1):
        self.policy, self.wm = policy, world_model
        self.tau, self.kappa, self.margin, self.lookahead = tau, kappa, margin, lookahead
        self.vetoes = 0
        self.decisions = 0
        self.last = {}

    def scores(self, obs):
        acts = np.arange(N_ACTIONS)
        O = np.repeat(np.atleast_2d(obs), N_ACTIONS, 0)
        if self.lookahead > 1:
            risk, prog, unc = self.wm.imagine(O, acts, self.policy.batch_act, steps=self.lookahead)
        else:
            m, s = self.wm.risk(O, acts)
            risk = m + self.kappa * s
        return risk

    def __call__(self, obs, env=None):
        self.decisions += 1
        p = self.policy.probs(obs)[0]
        risk = self.scores(obs)
        order = np.argsort(-p, kind="stable")
        budget = max(self.tau, float(risk.min()) + self.margin)
        allowed = [int(a) for a in order if risk[a] <= budget]
        choice = allowed[0]                     # the controller's favourite among the allowed moves
        if choice != int(order[0]):
            self.vetoes += 1
        self.last = {"proposed": NAMES[int(order[0])], "chosen": NAMES[choice],
                     "risk": {NAMES[a]: round(float(risk[a]), 3) for a in range(N_ACTIONS)}}
        return choice
