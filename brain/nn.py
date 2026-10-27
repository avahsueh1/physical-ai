"""Tiny neural networks in plain numpy (no PyTorch needed).

Deliberately small: the controller has to fit on a microcontroller, and the
world model has to run hundreds of "imagined" steps per second on a laptop.
Everything trains in seconds to minutes on a CPU.

    net = MLP([in_dim, 64, 64, out_dim], seed=0)
    net.fit(X, Y, loss="mse" | "ce" | "bce", epochs=..., weights=...)
    net.predict(X)          # raw outputs (logits for ce/bce)
"""
from __future__ import annotations

import numpy as np


def softmax(z):
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


class MLP:
    def __init__(self, sizes, seed=0, act="tanh"):
        rng = np.random.default_rng(seed)
        self.sizes = list(sizes)
        self.act = act
        self.W, self.b = [], []
        for i, (a, c) in enumerate(zip(sizes[:-1], sizes[1:])):
            scale = np.sqrt(1.0 / a) if i < len(sizes) - 2 else np.sqrt(0.1 / a)
            self.W.append(rng.normal(0, scale, (a, c)).astype(np.float64))
            self.b.append(np.zeros(c))
        self.mu = np.zeros(sizes[0]); self.sd = np.ones(sizes[0])

    @property
    def n_params(self):
        return int(sum(w.size + b.size for w, b in zip(self.W, self.b)))

    # ------------------------------------------------------------ forward
    def _h(self, z):
        return np.tanh(z) if self.act == "tanh" else np.maximum(z, 0)

    def _dh(self, h):
        return 1 - h * h if self.act == "tanh" else (h > 0).astype(float)

    def forward(self, X, keep=False):
        h = (np.asarray(X, float) - self.mu) / self.sd
        hs = [h]
        for i, (W, b) in enumerate(zip(self.W, self.b)):
            z = h @ W + b
            h = self._h(z) if i < len(self.W) - 1 else z
            hs.append(h)
        return (h, hs) if keep else h

    predict = forward

    # ------------------------------------------------------------- train
    def fit(self, X, Y, loss="mse", epochs=60, batch=256, lr=2e-3, wd=1e-5, weights=None,
            seed=0, verbose=False, normalize=True):
        X = np.asarray(X, float); Y = np.asarray(Y)
        if normalize:
            self.mu = X.mean(0); self.sd = X.std(0) + 1e-6
        n = len(X)
        w = np.ones(n) if weights is None else np.asarray(weights, float)
        rng = np.random.default_rng(seed)
        mW = [np.zeros_like(W) for W in self.W]; vW = [np.zeros_like(W) for W in self.W]
        mb = [np.zeros_like(b) for b in self.b]; vb = [np.zeros_like(b) for b in self.b]
        t = 0
        hist = []
        for ep in range(epochs):
            perm = rng.permutation(n)
            tot = 0.0
            for k in range(0, n, batch):
                idx = perm[k:k + batch]
                out, hs = self.forward(X[idx], keep=True)
                ww = w[idx][:, None]
                if loss == "mse":
                    d = (out - Y[idx]); L = float((ww * d * d).mean()); g = 2 * ww * d / d.size
                elif loss == "ce":
                    p = softmax(out); yy = Y[idx].astype(int)
                    L = float(-(w[idx] * np.log(p[np.arange(len(idx)), yy] + 1e-9)).mean())
                    g = p.copy(); g[np.arange(len(idx)), yy] -= 1; g *= ww / len(idx)
                elif loss == "bce":
                    p = sigmoid(out); yy = Y[idx].astype(float).reshape(out.shape)
                    L = float(-(ww * (yy * np.log(p + 1e-9) + (1 - yy) * np.log(1 - p + 1e-9))).mean())
                    g = ww * (p - yy) / out.size
                else:
                    raise ValueError(loss)
                tot += L * len(idx)
                # backprop
                t += 1
                for i in range(len(self.W) - 1, -1, -1):
                    gW = hs[i].T @ g + wd * self.W[i]; gb = g.sum(0)
                    if i > 0:
                        g = (g @ self.W[i].T) * self._dh(hs[i])
                    for P, G, m, v in ((self.W, gW, mW, vW), (self.b, gb, mb, vb)):
                        m[i] = 0.9 * m[i] + 0.1 * G; v[i] = 0.999 * v[i] + 0.001 * G * G
                        mh = m[i] / (1 - 0.9 ** t); vh = v[i] / (1 - 0.999 ** t)
                        P[i] -= lr * mh / (np.sqrt(vh) + 1e-8)
            hist.append(tot / n)
            if verbose and (ep % 10 == 0 or ep == epochs - 1):
                print(f"  epoch {ep:3d} loss {hist[-1]:.4f}")
        return hist

    # ---------------------------------------------------------- save/load
    def state(self):
        d = {"sizes": np.array(self.sizes), "act": np.array(self.act), "mu": self.mu, "sd": self.sd}
        for i, (W, b) in enumerate(zip(self.W, self.b)):
            d[f"W{i}"] = W; d[f"b{i}"] = b
        return d

    @classmethod
    def from_state(cls, d, prefix=""):
        net = cls([int(s) for s in d[prefix + "sizes"]], act=str(d[prefix + "act"]))
        net.mu, net.sd = d[prefix + "mu"], d[prefix + "sd"]
        net.W = [d[f"{prefix}W{i}"] for i in range(len(net.sizes) - 1)]
        net.b = [d[f"{prefix}b{i}"] for i in range(len(net.sizes) - 1)]
        return net

    def save(self, path):
        np.savez(path, **self.state())

    @classmethod
    def load(cls, path):
        return cls.from_state(np.load(path, allow_pickle=False))


class Ensemble:
    """K independently initialised MLPs trained on bootstrap resamples.
    Disagreement between members = how much the model is guessing."""

    def __init__(self, sizes, k=5, seed=0, act="tanh"):
        self.members = [MLP(sizes, seed=seed + 101 * i, act=act) for i in range(k)]

    def fit(self, X, Y, loss="mse", bootstrap=True, seed=0, weights=None, **kw):
        n = len(X); rng = np.random.default_rng(seed)
        for i, m in enumerate(self.members):
            idx = rng.integers(0, n, n) if bootstrap else np.arange(n)
            m.fit(X[idx], Y[idx], loss=loss, seed=seed + i,
                  weights=None if weights is None else np.asarray(weights)[idx], **kw)

    def predict_all(self, X):
        return np.stack([m.predict(X) for m in self.members])

    def state(self):
        d = {"k": np.array(len(self.members))}
        for i, m in enumerate(self.members):
            for key, val in m.state().items():
                d[f"m{i}_{key}"] = val
        return d

    @classmethod
    def from_state(cls, d):
        e = cls.__new__(cls)
        e.members = [MLP.from_state(d, prefix=f"m{i}_") for i in range(int(d["k"]))]
        return e


def _cf(v):
    s = f"{float(v):.7g}"
    if "." not in s and "e" not in s and "n" not in s:
        s += ".0"
    return s + "f"


def export_c_header(net: MLP, path: str, name: str = "policy", extra: str = ""):
    """Write the network as a C header (float weights + a forward function) for a microcontroller."""
    lines = [f"// Auto-generated by crease-lab brain: {name}, {net.n_params} parameters",
             "#pragma once", "#include <math.h>", ""] + ([extra] if extra else [])
    lines.append(f"static const float {name}_mu[{len(net.mu)}] = {{{', '.join(_cf(v) for v in net.mu)}}};")
    lines.append(f"static const float {name}_sd[{len(net.sd)}] = {{{', '.join(_cf(v) for v in net.sd)}}};")
    for i, (W, b) in enumerate(zip(net.W, net.b)):
        flat = ", ".join(_cf(v) for v in W.T.ravel())   # row = output unit
        lines.append(f"static const float {name}_W{i}[{W.shape[1]}][{W.shape[0]}] = {{{flat}}};")
        lines.append(f"static const float {name}_b{i}[{len(b)}] = {{{', '.join(_cf(v) for v in b)}}};")
    sizes = net.sizes
    lines += ["", f"// returns the index of the chosen action (argmax of the output layer)",
              f"static int {name}_act(const float *obs) {{",
              f"  float a[{max(sizes)}], c[{max(sizes)}];",
              f"  for (int i = 0; i < {sizes[0]}; i++) a[i] = (obs[i] - {name}_mu[i]) / {name}_sd[i];"]
    for i in range(len(sizes) - 1):
        last = i == len(sizes) - 2
        if last:
            nonlin = "s"
        elif net.act == "tanh":
            nonlin = "tanhf(s)"
        else:
            nonlin = "fmaxf(0.f, s)"
        lines += [f"  for (int o = 0; o < {sizes[i + 1]}; o++) {{",
                  f"    float s = {name}_b{i}[o];",
                  f"    for (int k = 0; k < {sizes[i]}; k++) s += {name}_W{i}[o][k] * a[k];",
                  f"    c[o] = {nonlin};",
                  "  }",
                  f"  for (int o = 0; o < {sizes[i + 1]}; o++) a[o] = c[o];"]
    lines += [f"  int best = 0; for (int o = 1; o < {sizes[-1]}; o++) if (a[o] > a[best]) best = o;",
              "  return best;", "}", ""]
    with open(path, "w") as f:
        f.write("\n".join(lines))
