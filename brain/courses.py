"""Procedural courses: the 'different spaces' the crawler has to get through.

Every course is plain data (JSON-able) so the browser app can load the same
course the trainer used. Units are Crease Lab's: the plate radius is 1 and a
cell is 1 long (call it 1 cm). The default body is ~4.9 long, ~2 tall, ~2 wide.

families
  gaps      a tunnel with a low ceiling. Some fit, some don't: the robot has to
            judge clearance *before* committing (and stop if it won't fit).
  corridor  walls on both sides along a gently bending path (steering).
  slopes    ramps up/down plus slippery patches (ice = scales can't bite).
  rubble    scattered rocks to climb over or go around (tipping risk).
  mixed     slopes + ice + rubble together.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np

FAMILIES = ["gaps", "corridor", "slopes", "rubble", "mixed"]
BODY_TOP = 2.05          # top of the default body above the ground (measured)
SPEED_PER_DECISION = 0.19  # inchworm, flat, default body (measured)


@dataclass
class Course:
    family: str
    seed: int
    terrain: dict
    waypoints: list            # centreline [(x, y), ...] from start to goal
    start: dict = field(default_factory=lambda: {"x": 0.0, "y": 0.0, "yaw": 0.0})
    meta: dict = field(default_factory=dict)
    max_decisions: int = 200

    @property
    def length(self) -> float:
        w = np.asarray(self.waypoints, float)
        return float(np.sum(np.linalg.norm(np.diff(w, axis=0), axis=1)))

    def to_dict(self):
        return asdict(self)


def _wall(x0, y0, x1, y1, height=2.6, thick=0.4, extend=0.3):
    """An oriented box wall from (x0,y0) to (x1,y1)."""
    L = math.hypot(x1 - x0, y1 - y0)
    yaw = math.atan2(y1 - y0, x1 - x0)
    return {"cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2, "cz": height / 2,
            "hx": L / 2 + extend, "hy": thick / 2, "hz": height / 2, "yaw": yaw, "kind": "wall"}


def _side_walls(points, half_width, **kw):
    walls = []
    for (xa, ya), (xb, yb) in zip(points[:-1], points[1:]):
        yaw = math.atan2(yb - ya, xb - xa)
        nx, ny = -math.sin(yaw), math.cos(yaw)
        for s in (1, -1):
            o = s * (half_width + 0.2)
            walls.append(_wall(xa + nx * o, ya + ny * o, xb + nx * o, yb + ny * o, **kw))
    return walls


def _max_decisions(length, slow=1.0):
    return int(length / SPEED_PER_DECISION * 2.2 * slow) + 40


# ------------------------------------------------------------------ families
def gaps(rng: np.random.Generator, seed: int) -> Course:
    x_in = float(rng.uniform(7, 10))          # tunnel entrance (front plate starts at ~4.4)
    L_t = float(rng.uniform(2.5, 4.5))
    # clearance = ceiling - body top. check_gaps.py found: >= 0 passes freely; -0.1..0 the body
    # squeezes in by crushing itself (a failure: "wedged"); < -0.1 the lintel is just a wall.
    # So the dangerous tunnels are the ones that are *almost* high enough. Mix: 12% walls,
    # 30% traps (-0.10..-0.04), 58% fits (+0.08..+0.60). The band -0.04..+0.08 is skipped so
    # the label is never a coin flip.
    u = float(rng.uniform(0, 1))
    if u < 0.12:
        c = -0.45 + u / 0.12 * 0.33
    elif u < 0.42:
        c = -0.10 + (u - 0.12) / 0.30 * 0.06
    else:
        c = 0.08 + (u - 0.42) / 0.58 * 0.52
    h = BODY_TOP + c                          # ceiling height above the floor
    half_w = float(rng.uniform(1.6, 2.2))
    x_goal = x_in + L_t + 5.0
    ceiling = {"cx": x_in + L_t / 2, "cy": 0.0, "cz": h + 0.5, "hx": L_t / 2, "hy": half_w + 0.6,
               "hz": 0.5, "yaw": 0.0, "kind": "ceiling"}
    # side walls so the robot can't go around the tunnel
    walls = _side_walls([(-1.0, 0.0), (x_goal + 1.0, 0.0)], half_w, height=h + 1.2)
    terrain = {"boxes": walls + [ceiling]}
    clearance = h - BODY_TOP
    meta = {"gap_height": h, "gap_x": x_in, "gap_len": L_t, "clearance": clearance,
            # rule: fits if clearance > 0; scripts/check_gaps.py tests this rule in simulation
            "passable": bool(clearance > 0.0), "half_width": half_w}
    return Course("gaps", seed, terrain, [(0.0, 0.0), (x_goal, 0.0)], meta=meta,
                  max_decisions=_max_decisions(x_goal))


def corridor(rng: np.random.Generator, seed: int) -> Course:
    half_w = float(rng.uniform(1.6, 2.1))
    n_seg = int(rng.integers(2, 4))
    pts, x, y, yaw = [(0.0, 0.0)], 0.0, 0.0, 0.0
    for k in range(n_seg):
        L = float(rng.uniform(7, 11))
        if k > 0:
            yaw = float(np.clip(yaw + math.radians(rng.uniform(-12, 12)), math.radians(-18), math.radians(18)))
        x, y = x + L * math.cos(yaw), y + L * math.sin(yaw)
        pts.append((x, y))
    terrain = {"boxes": _side_walls(pts, half_w)}
    c = Course("corridor", seed, terrain, pts, meta={"half_width": half_w})
    c.max_decisions = _max_decisions(c.length, slow=1.6)
    return c


def _ramps(rng, length, max_deg):
    segs, x, z = [{"x0": -20.0, "x1": 4.0, "z0": 0.0, "z1": 0.0}], 4.0, 0.0
    while x < length + 10:
        L = float(rng.uniform(5, 9))
        a = math.radians(float(rng.uniform(-max_deg, max_deg)))
        z1 = z + L * math.tan(a)
        segs.append({"x0": x, "x1": x + L, "z0": z, "z1": z1})
        x, z = x + L, z1
    return segs


def _patches(rng, length, n, half_w=6.0):
    out = []
    for _ in range(n):
        x0 = float(rng.uniform(5, max(6, length - 6)))
        Lp = float(rng.uniform(3, 6))
        if rng.random() < 0.6:
            p = {"mu": 0.5, "grip": 0.1, "kind": "ice"}
        else:
            p = {"mu": 0.6, "grip": 0.45, "kind": "wet"}
        out.append(dict(p, x0=x0, x1=x0 + Lp, y0=-half_w, y1=half_w))
    return out


def slopes(rng: np.random.Generator, seed: int) -> Course:
    length = float(rng.uniform(20, 28))
    terrain = {"ground": {"segments": _ramps(rng, length, 8)},
               "patches": _patches(rng, length, int(rng.integers(1, 3)))}
    return Course("slopes", seed, terrain, [(0.0, 0.0), (length, 0.0)],
                  max_decisions=_max_decisions(length, slow=1.8))


def _rock(x, y, h, size, yaw, z0):
    hz = (h + 0.05) / 2                       # box sinks 0.05 into the ground
    return {"cx": x, "cy": y, "cz": z0 + h - hz, "hx": size[0], "hy": size[1], "hz": hz,
            "yaw": yaw, "mu": 0.5, "kind": "rock", "height": h}


def _rocks(rng, length, n_pebbles, n_boulders, ground=None, y_half=3.0):
    """Gravel (<= 0.08 tall, small) can be crawled over; boulders (0.35-0.8) must be steered around.
    Measured: a single 0.1-tall slab 1.1 wide already stalls the body (it high-centres and the
    scales lose the ground), so gravel is kept small. Boulders sit anywhere from dead ahead to
    1.8 off the line, so a straight-line crawler hits about half of them."""
    zf = (lambda x: _ground_z(ground, x)) if ground is not None else (lambda x: 0.0)
    rocks = []
    for _ in range(n_pebbles):
        x = float(rng.uniform(6, length - 2)); y = float(rng.uniform(-y_half, y_half))
        rocks.append(_rock(x, y, float(rng.uniform(0.03, 0.08)), rng.uniform(0.12, 0.35, 2).tolist(),
                           float(rng.uniform(0, math.pi)), zf(x)))
    xs = np.linspace(9, length - 3, max(1, n_boulders)) if n_boulders else []
    for x in xs[:n_boulders]:
        x = float(x + rng.uniform(-1.5, 1.5))
        y = float(rng.choice([-1, 1]) * rng.uniform(0.0, 1.8))   # walls are at +-4: a way round always exists
        rocks.append(_rock(x, y, float(rng.uniform(0.35, 0.8)), rng.uniform(0.35, 0.7, 2).tolist(),
                           float(rng.uniform(0, math.pi)), zf(x)))
    return rocks


def _ground_z(segs, x):
    for g in segs:
        if g["x0"] <= x <= g["x1"]:
            return g["z0"] + (g["z1"] - g["z0"]) * (x - g["x0"]) / (g["x1"] - g["x0"])
    return segs[-1]["z1"]


def rubble(rng: np.random.Generator, seed: int) -> Course:
    length = float(rng.uniform(18, 26))
    rocks = _rocks(rng, length, int(rng.integers(6, 14)), int(rng.integers(2, 4)))
    walls = _side_walls([(-1.0, 0.0), (length + 2, 0.0)], 4.0, height=1.5)
    return Course("rubble", seed, {"boxes": walls + rocks}, [(0.0, 0.0), (length, 0.0)],
                  max_decisions=_max_decisions(length, slow=1.6))


def mixed(rng: np.random.Generator, seed: int) -> Course:
    length = float(rng.uniform(22, 30))
    segs = _ramps(rng, length, 6)
    rocks = _rocks(rng, length, int(rng.integers(4, 10)), int(rng.integers(1, 3)), ground=segs)
    terrain = {"ground": {"segments": segs}, "patches": _patches(rng, length, int(rng.integers(1, 3))),
               "boxes": rocks}
    return Course("mixed", seed, terrain, [(0.0, 0.0), (length, 0.0)],
                  max_decisions=_max_decisions(length, slow=2.0))


GENERATORS = {"gaps": gaps, "corridor": corridor, "slopes": slopes, "rubble": rubble, "mixed": mixed}


def make_course(family: str, seed: int) -> Course:
    rng = np.random.default_rng(seed * 7919 + FAMILIES.index(family) * 104729)
    return GENERATORS[family](rng, seed)


def suite(families=None, n_per_family=4, seed0=0):
    families = families or FAMILIES
    return [make_course(f, seed0 + k) for f in families for k in range(n_per_family)]
