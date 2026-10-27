"""The world model: the brain's internal simulator.

Three learned pieces, all small MLP ensembles over (observation, action):

  dynamics   z_{t+1} = f(z_t, a_t)             "what will I feel next?"
  risk       P(failure within H | z_t, a_t)    "if I do this, can I still recover?"
             trained on what-if labels: the world was rewound, the action was
             tried, and a sensible recovery was attempted for H decisions.
             1 - risk is an estimate of being inside the *viability kernel*.
  value      progress over H decisions          "how much does this move help?"

The ensembles' disagreement measures how much the model is guessing. An
action the model is unsure about is treated as risky: an imagined future can
be wrong, so the brain is cautious exactly where its imagination is unreliable.
"""
from __future__ import annotations

import numpy as np

from .actions import N_ACTIONS
from .data import N_DYN
from .env import OBS_DIM
from .nn import MLP, Ensemble, sigmoid


def onehot(a, n=N_ACTIONS):
    a = np.asarray(a, int).reshape(-1)
    o = np.zeros((len(a), n), np.float32); o[np.arange(len(a)), a] = 1
    return o


def sa(obs, a):
    obs = np.atleast_2d(obs)
    return np.concatenate([obs, onehot(a)], axis=1)


class WorldModel:
    def __init__(self, k=5, hidden=128, risk_hidden=64, seed=0):
        d = OBS_DIM + N_ACTIONS
        self.dyn = Ensemble([d, hidden, hidden, N_DYN + 1], k=k, seed=seed)
        self.risk_net = Ensemble([d, risk_hidden, risk_hidden, 1], k=k, seed=seed + 1)
        self.value_net = MLP([d, risk_hidden, risk_hidden, 1], seed=seed + 2)

    # ------------------------------------------------------------ training
    def fit(self, data, epochs=60, verbose=True):
        X = sa(data["obs"], data["act"])
        Y = np.concatenate([data["next"][:, :N_DYN] - data["obs"][:, :N_DYN], data["dprog"][:, None]], axis=1)
        self.y_scale = Y.std(0) + 1e-6
        if verbose: print(f"  dynamics: {len(X)} transitions")
        self.dyn.fit(X, Y / self.y_scale, loss="mse", epochs=epochs)

        # risk: every what-if row gives labels for all 8 actions at that moment
        bo = data["b_obs"]
        Xr = np.concatenate([sa(np.repeat(bo, N_ACTIONS, 0), np.tile(np.arange(N_ACTIONS), len(bo)))])
        yr = data["b_fail"].reshape(-1, 1)
        # plus the real transitions that ended in failure (label 1) or didn't (label 0, weak)
        Xr = np.concatenate([Xr, X]); yr = np.concatenate([yr, data["fail"][:, None]])
        w = np.concatenate([np.ones(len(bo) * N_ACTIONS), np.full(len(X), 0.3)])
        pos = yr.mean()
        w = w * np.where(yr[:, 0] > 0.5, 0.5 / max(pos, 1e-3), 0.5 / max(1 - pos, 1e-3))   # balance classes
        if verbose: print(f"  risk: {len(bo)} what-if moments x {N_ACTIONS} actions, failure rate {pos:.3f}")
        self.risk_net.fit(Xr, yr, loss="bce", epochs=epochs, weights=w)
        Xv = Xr[:len(bo) * N_ACTIONS]; yv = data["b_prog"].reshape(-1, 1)
        self.v_scale = float(yv.std() + 1e-6)
        self.value_net.fit(Xv, yv / self.v_scale, loss="mse", epochs=epochs)

    # ----------------------------------------------------------- inference
    def risk(self, obs, a):
        """Return (mean, std) failure probability across the ensemble."""
        p = sigmoid(self.risk_net.predict_all(sa(obs, a)))[..., 0]   # (k, n)
        return p.mean(0), p.std(0)

    def value(self, obs, a):
        return self.value_net.predict(sa(obs, a))[:, 0] * self.v_scale

    def predict(self, obs, a):
        """Imagine one step: next observation (mean), progress, and disagreement."""
        P = self.dyn.predict_all(sa(obs, a)) * self.y_scale         # (k, n, N_DYN+1)
        mean, spread = P.mean(0), (P / self.y_scale).std(0).mean(-1)
        obs = np.atleast_2d(obs).copy()
        nxt = obs.copy()
        nxt[:, :N_DYN] += mean[:, :N_DYN]
        a = np.asarray(a, int).reshape(-1)
        prev = obs[:, -N_ACTIONS:].argmax(1)
        rep = np.where(prev == a, np.minimum(obs[:, N_DYN] * 4 + 1, 4), 1) / 4.0
        nxt[:, N_DYN] = rep
        nxt[:, -N_ACTIONS:] = onehot(a)
        return nxt, mean[:, -1], spread

    def imagine(self, obs, first_action, policy, steps=3):
        """Roll the dream forward: first_action, then `policy` for `steps-1` more.
        Returns worst risk seen, total imagined progress, mean disagreement."""
        o = np.atleast_2d(obs); a = np.atleast_1d(first_action)
        worst, prog, unc = np.zeros(len(o)), np.zeros(len(o)), np.zeros(len(o))
        for k in range(steps):
            r, rs = self.risk(o, a)
            worst = np.maximum(worst, r + rs)
            o, dp, sp = self.predict(o, a)
            prog += dp; unc += sp
            a = policy(o)
        return worst, prog, unc / steps

    # ---------------------------------------------------------- save/load
    def save(self, path):
        d = {}
        for name, e in (("dyn", self.dyn), ("risk", self.risk_net)):
            for k, v in e.state().items():
                d[f"{name}_{k}"] = v
        for k, v in self.value_net.state().items():
            d[f"val_{k}"] = v
        d["y_scale"] = self.y_scale; d["v_scale"] = np.array(self.v_scale)
        np.savez_compressed(path, **d)

    @classmethod
    def load(cls, path):
        z = np.load(path, allow_pickle=False)
        wm = cls.__new__(cls)
        sub = lambda p: {k[len(p):]: z[k] for k in z.files if k.startswith(p)}
        wm.dyn = Ensemble.from_state(sub("dyn_")); wm.risk_net = Ensemble.from_state(sub("risk_"))
        wm.value_net = MLP.from_state(sub("val_")); wm.y_scale = z["y_scale"]; wm.v_scale = float(z["v_scale"])
        return wm
