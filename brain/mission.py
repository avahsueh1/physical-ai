"""The language layer: turn an instruction into a *mission* the brain can execute.

    "crawl 3 body lengths forward"             -> distance 3 bodies
    "get through the tunnel if you fit"        -> traverse, refuse if unsafe
    "go carefully over the ice"                -> low risk budget
    "hurry, I don't care if you scrape"        -> high risk budget
    "stop"                                     -> stop

The language model never drives the motors. It only sets the mission: where
to go, how much risk is acceptable, and when to stop. The tiny controller
and the safety filter do the driving. That split is deliberate:

  * the slow, big model (rule parser now; a VLM or SmolVLA later) runs about
    once per instruction, so it can live on a laptop or a GPU box;
  * the fast, tiny model runs every 1.5 s on the robot and fits on a
    microcontroller;
  * however confident the language model is, it cannot talk the robot into
    a move the world model says is unrecoverable. "Go forward" into a tunnel
    it doesn't fit becomes "go forward until the last safe point, then stop".

Swap in a real model by passing `llm=` to `parse`: any callable that takes
(prompt) and returns JSON text matching MISSION_SCHEMA. `llm_prompt` builds
the prompt. A camera image could be described by a VLM first and the
description appended to the instruction.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass

RISK_LEVELS = {"careful": 0.15, "normal": 0.3, "bold": 0.55}

MISSION_SCHEMA = {
    "goal": "traverse | distance | stop",
    "distance_bodies": "number or null (only for goal=distance)",
    "risk": "careful | normal | bold",
    "refuse_if_unsafe": "true | false",
}

NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
             "nine": 9, "ten": 10, "a couple of": 2, "a few": 3, "half a": 0.5, "a": 1}


@dataclass
class Mission:
    goal: str = "traverse"
    distance_bodies: float | None = None
    risk: str = "normal"
    refuse_if_unsafe: bool = True
    text: str = ""

    @property
    def tau(self) -> float:
        return RISK_LEVELS[self.risk]

    def to_dict(self):
        return asdict(self)


def _number(s):
    s = s.strip().lower()
    try:
        return float(s)
    except ValueError:
        return NUM_WORDS.get(s)


def rule_parse(text: str) -> Mission:
    t = " " + text.lower().strip() + " "
    m = Mission(text=text)
    if re.search(r"\b(stop|halt|freeze|stay|wait)\b", t) and not re.search(r"\bdon'?t stop\b", t):
        m.goal = "stop"
    dist = re.search(r"(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few|half a|a)"
                     r"\s+(body[- ]?lengths?|bodies|lengths?|bl)\b", t)
    if dist and m.goal != "stop":
        n = _number(dist.group(1))
        if n:
            m.goal, m.distance_bodies = "distance", float(n)
    if re.search(r"\b(careful(ly)?|gentl[ey]|slow(ly)?|cautious(ly)?|safe(ly)?|don'?t (break|fall|tear))\b", t):
        m.risk = "careful"
    if re.search(r"\b(hurry|fast|quick(ly)?|asap|bold(ly)?|aggressive(ly)?|whatever it takes|don'?t care)\b", t):
        m.risk = "bold"
    if re.search(r"\b(no matter what|even if|force (it|your way)|squeeze through anyway)\b", t):
        m.refuse_if_unsafe = False
    return m


def llm_prompt(text: str) -> str:
    return ("You command a small origami crawler robot. Convert the instruction into JSON with exactly these "
            f"fields: {json.dumps(MISSION_SCHEMA)}. Respond with JSON only.\nInstruction: {text}")


def parse(text: str, llm=None) -> Mission:
    """Rule-based by default; with `llm`, ask the model and fall back to rules on any problem."""
    if llm is None:
        return rule_parse(text)
    try:
        raw = llm(llm_prompt(text))
        d = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
        m = Mission(goal=str(d.get("goal", "traverse")), distance_bodies=d.get("distance_bodies"),
                    risk=str(d.get("risk", "normal")), refuse_if_unsafe=bool(d.get("refuse_if_unsafe", True)),
                    text=text)
        if m.goal not in ("traverse", "distance", "stop") or m.risk not in RISK_LEVELS:
            raise ValueError(d)
        return m
    except Exception:
        return rule_parse(text)
