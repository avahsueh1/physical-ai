"""Videos of the crawler on a course: top view + side view + what the brain is thinking.

    from brain.render import Recorder
    rec = Recorder(env, course, title="safe tiny controller")
    ...each decision: env.step(a); rec.add(env.frames, caption="SQUEEZE  risk 0.02")
    rec.save("runs/video.mp4")

Static terrain is drawn once; only the robot and captions change per frame,
so a 100-decision episode renders in well under a minute.
"""
from __future__ import annotations

import math
import shutil
import subprocess

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt                       # noqa: E402
import numpy as np                                    # noqa: E402
from matplotlib.collections import LineCollection     # noqa: E402
from matplotlib.patches import Polygon, Rectangle     # noqa: E402

PATCH_COLORS = {"ice": "#9fd3f5", "wet": "#7fc9b8"}
BOX_COLORS = {"wall": "#8a8f98", "rock": "#9a7b5a", "ceiling": "#e0a050"}
XSPAN = 20.0


def _ground_z(segs, x):
    for s in segs:
        if s["x0"] <= x <= s["x1"]:
            f = (x - s["x0"]) / max(1e-9, s["x1"] - s["x0"])
            return s["z0"] + f * (s["z1"] - s["z0"])
    return segs[0]["z0"] if segs and x < segs[0]["x0"] else (segs[-1]["z1"] if segs else 0.0)


class Recorder:
    def __init__(self, env, course, title="", fps=20, dpi=100):
        self.env, self.course, self.title, self.fps = env, course, title, fps
        info = env.sim.info()
        self.edges = np.array([tuple(b) for b in info["bars"]] + [tuple(b[:2]) for b in info.get("extraBars", [])], int)
        self.fig = plt.figure(figsize=(12.8, 7.2), dpi=dpi)
        self.top = self.fig.add_axes([0.04, 0.42, 0.92, 0.50])
        self.side = self.fig.add_axes([0.04, 0.07, 0.92, 0.30])
        self._draw_static()
        self.top_lc = LineCollection([], colors="#1f2a44", linewidths=1.1); self.top.add_collection(self.top_lc)
        self.side_lc = LineCollection([], colors="#1f2a44", linewidths=1.1); self.side.add_collection(self.side_lc)
        self.head = self.fig.text(0.04, 0.955, title, fontsize=14, weight="bold", family="DejaVu Sans")
        self.cap = self.fig.text(0.96, 0.955, "", fontsize=11, ha="right", family="DejaVu Sans Mono")
        self.frames = []

    # -------------------------------------------------------------- terrain
    def _draw_static(self):
        t = self.course.terrain
        for ax in (self.top, self.side):
            ax.set_facecolor("#f6f4ef"); ax.tick_params(labelsize=7)
            for s in ax.spines.values():
                s.set_color("#c8c4bb")
        for p in t.get("patches", []):
            self.top.add_patch(Rectangle((p["x0"], p["y0"]), p["x1"] - p["x0"], p["y1"] - p["y0"],
                                         color=PATCH_COLORS.get(p.get("kind"), "#cde"), alpha=0.45, lw=0))
        for b in t.get("boxes", []):
            c, s = math.cos(b.get("yaw", 0)), math.sin(b.get("yaw", 0))
            corners = [(b["cx"] + c * dx - s * dy, b["cy"] + s * dx + c * dy)
                       for dx, dy in ((-b["hx"], -b["hy"]), (b["hx"], -b["hy"]), (b["hx"], b["hy"]), (-b["hx"], b["hy"]))]
            kind = b.get("kind", "rock")
            col = BOX_COLORS.get(kind, "#999")
            self.top.add_patch(Polygon(corners, closed=True, color=col,
                                       alpha=0.25 if kind == "ceiling" else 0.85, lw=0, zorder=3 if kind != "ceiling" else 1))
            if kind != "wall":
                ex = abs(c) * b["hx"] + abs(s) * b["hy"]
                self.side.add_patch(Rectangle((b["cx"] - ex, b["cz"] - b["hz"]), 2 * ex, 2 * b["hz"], color=col,
                                              alpha=0.6 if kind == "ceiling" else 0.85, lw=0))
        wp = np.array(self.course.waypoints)
        self.top.plot(wp[:, 0], wp[:, 1], ls="--", color="#b9b3a7", lw=1, zorder=0)
        self.top.plot(*wp[-1], marker="*", color="#d4553a", ms=14, zorder=5)
        segs = t.get("ground", {}).get("segments", [])
        xs = np.linspace(wp[:, 0].min() - 25, wp[:, 0].max() + 25, 800)
        zs = np.array([_ground_z(segs, x) for x in xs]) if segs else np.zeros_like(xs)
        self.side.fill_between(xs, zs - 5, zs, color="#d9d2c3", lw=0)
        self.side.plot(xs, zs, color="#a39985", lw=1)
        for p in t.get("patches", []):
            self.side.plot([p["x0"], p["x1"]], [_ground_z(segs, p["x0"]) if segs else 0] * 2,
                           color=PATCH_COLORS.get(p.get("kind"), "#cde"), lw=5, alpha=0.8, solid_capstyle="butt")
        self.top.set_title("top view", fontsize=8, loc="left", color="#777")
        self.side.set_title("side view", fontsize=8, loc="left", color="#777")

    # ------------------------------------------------------------- frames
    def add(self, node_frames, caption=""):
        if not node_frames:
            return
        for nodes in node_frames:
            X = np.asarray(nodes).reshape(-1, 3)
            self.frames.append((X, caption))

    def _render(self, X, caption):
        P = X[self.edges]                       # (E, 2, 3)
        self.top_lc.set_segments(P[:, :, :2]); self.side_lc.set_segments(P[:, :, [0, 2]])
        cx, cy, cz = X[:, 0].mean(), X[:, 1].mean(), X[:, 2].min()
        x0 = cx - XSPAN * 0.4
        tb = self.top.get_window_extent(); sb = self.side.get_window_extent()
        ty = XSPAN * tb.height / tb.width; sz = XSPAN * sb.height / sb.width
        self.top.set_xlim(x0, x0 + XSPAN); self.top.set_ylim(cy - ty / 2, cy + ty / 2)
        self.side.set_xlim(x0, x0 + XSPAN); self.side.set_ylim(cz - 0.6, cz - 0.6 + sz)
        self.cap.set_text(caption)
        self.fig.canvas.draw()
        return np.asarray(self.fig.canvas.buffer_rgba())[..., :3]

    def save(self, path):
        if not self.frames:
            raise RuntimeError("no frames recorded (set env.record_frames > 0 before stepping)")
        w, h = self.fig.canvas.get_width_height()
        ff = shutil.which("ffmpeg")
        if ff is None:
            raise RuntimeError("ffmpeg not found (conda install -c conda-forge ffmpeg)")
        cmd = [ff, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
               "-r", str(self.fps), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for X, cap in self.frames:
            proc.stdin.write(self._render(X, cap).tobytes())
        proc.stdin.close(); proc.wait()
        plt.close(self.fig)
        return path

    def still(self, path, index=-1):
        X, cap = self.frames[index]
        img = self._render(X, cap)
        plt.imsave(path, img)
        return path
