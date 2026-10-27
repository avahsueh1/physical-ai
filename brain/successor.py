"""Successor features: "what will I sense, on average, from here on?"

    psi(s, a) = E[ sum_k gamma^k phi(s_{t+k}) | s_t = s, a_t = a, then the usual driver ]

phi is a vector of features of a sensor reading (here: the robot's sensor block). If a
task's reward is (approximately) linear in those features, r = phi . w, its value is
just Q(s, a) = psi(s, a) . w. A *new* task means a new w, found by a least-squares fit of
the reward on phi in one pass. psi is not retrained. That is the point of successor
representations (Dayan 1993; Barreto et al. 2017): they separate "how the world unfolds
under my habits" from "what I currently care about".

Here psi is learned from the same synthetic transitions as the world model, by fitted TD:
    target = phi(s') + gamma * psi(s', a') for the action actually taken next,
which needs episode boundaries. Those are recovered from the data (next[i] != obs[i+1]).

This module is a research hook: the controller doesn't use it yet. `report()` checks how
well psi.w predicts the true discounted return on unseen courses for two different tasks.
"""
from __future__ import annotations

import numpy as np

from .actions import N_ACTIONS
from .data import N_DYN
from .nn import MLP
from .world_model import sa


def phi(obs):
    return np.atleast_2d(obs)[:, :N_DYN]


def _episode_ends(d):
    o, n = d["obs"], d["next"]
    end = np.zeros(len(o), bool)
    end[:-1] = np.any(np.abs(n[:-1] - o[1:]) > 1e-6, axis=1)
    end[-1] = True
    return end


class SuccessorFeatures:
    def __init__(self, gamma=0.9, hidden=128, seed=0):
        self.gamma = gamma
        from .env import OBS_DIM
        self.net = MLP([OBS_DIM + N_ACTIONS, hidden, hidden, N_DYN], seed=seed)

    def fit(self, d, iters=6, epochs=25, verbose=True):
        X = sa(d["obs"], d["act"]); P = phi(d["next"])
        end = _episode_ends(d)
        # the action taken in the next state (same episode); at an episode end there is no future
        nxt = np.roll(np.arange(len(X)), -1)
        Xn = X[nxt]
        self.scale = P.std(0) + 1e-6
        target = P / (1 - self.gamma)                    # rough start: phi(s') forever
        for k in range(iters):
            self.net.fit(X, target / self.scale, loss="mse", epochs=epochs, normalize=(k == 0))
            boot = self.net.predict(Xn) * self.scale
            target = P + self.gamma * np.where(end[:, None], 0.0, boot)
            if verbose:
                print(f"  successor features: TD iteration {k + 1}/{iters}")
        return self

    def psi(self, obs, a):
        return self.net.predict(sa(obs, a)) * self.scale

    @staticmethod
    def task_weights(d, reward):
        """Least-squares w with reward(s') ~ phi(s') . w: one cheap fit per new task."""
        P = np.c_[phi(d["next"])]
        w, *_ = np.linalg.lstsq(P, reward, rcond=None)
        return w


def discounted_returns(d, reward, gamma):
    end = _episode_ends(d)
    G = np.zeros(len(reward)); g = 0.0
    for i in range(len(reward) - 1, -1, -1):
        g = reward[i] + gamma * (0.0 if end[i] else g)
        G[i] = g
    return G


TASKS = {
    # name: reward(next-state batch) -> per-transition reward
    "make progress": lambda d: d["dprog"],
    "keep clear of obstacles": lambda d: np.minimum(d["next"][:, 10:13], 1.0).mean(1),   # the 3 low rays (1 = clear)
}


def report(sf, train, val):
    """For each task: fit w on training data, then correlate psi.w with the true return on val."""
    out = {}
    for name, rf in TASKS.items():
        w = sf.task_weights(train, rf(train))
        pred = sf.psi(val["obs"], val["act"]) @ w
        true = discounted_returns(val, rf(val), sf.gamma)
        out[name] = round(float(np.corrcoef(pred, true)[0, 1]), 3)
    return out
