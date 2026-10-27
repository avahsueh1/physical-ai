"""Python handle on Crease Lab's physics, run headless in Node.

The browser app and this trainer use the *same* JavaScript physics
(web/core.js + web/motion.js + web/terrain.js). Python just sends commands:

    with CreaseSim() as sim:
        out = sim.reset(terrain=course.terrain, pose=course.start)
        out = sim.step({"contract": 1}, seconds=1.5)
        snap = sim.snapshot(); ...; sim.restore(snap)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


class SimError(RuntimeError):
    pass


class CreaseSim:
    def __init__(self, node: str | None = None):
        node = node or shutil.which("node")
        if not node:
            raise SimError("Node.js not found. Install it (e.g. `conda install -c conda-forge nodejs`).")
        self.proc = subprocess.Popen(
            [node, os.path.join(WEB, "headless.js")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1)
        self._lock = threading.Lock()
        self.info_cache = None

    # ------------------------------------------------------------------ io
    def _call(self, msg: dict) -> dict:
        with self._lock:
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read()
            raise SimError(f"physics process died: {err[-2000:]}")
        out = json.loads(line)
        if not out.get("ok"):
            raise SimError(out.get("error", "unknown error"))
        return out

    # ----------------------------------------------------------------- api
    def reset(self, params=None, terrain=None, pose=None, stiff=None) -> dict:
        self.info_cache = None
        return self._call({"cmd": "reset", "params": params or {}, "terrain": terrain or {},
                           "pose": pose or {}, "stiff": stiff})

    def step(self, action: dict, seconds: float = 1.5, frames: int = 0) -> dict:
        msg = {"cmd": "step", "action": action, "seconds": seconds}
        if frames:
            msg["frames"] = int(frames)
        return self._call(msg)

    def snapshot(self) -> int:
        return self._call({"cmd": "snapshot"})["id"]

    def restore(self, sid: int) -> dict:
        return self._call({"cmd": "restore", "id": sid})

    def drop(self, sid: int):
        self._call({"cmd": "drop", "id": sid})

    def nodes(self):
        return self._call({"cmd": "nodes"})["x"]

    def info(self) -> dict:
        if self.info_cache is None:
            self.info_cache = self._call({"cmd": "info"})
        return self.info_cache

    def close(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
