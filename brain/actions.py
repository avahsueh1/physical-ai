"""The robot's move set: 8 motion primitives, each held for one decision (1.5 s).

These are the same building blocks as the Move bench's gait phases (contract,
bend, anchor, release), so anything the brain learns can be played back as a
Crease Lab gait and turned into servo angles by the Build tab.

Classic gaits as sequences (two decisions per phase):
    inchworm      SQUEEZE SQUEEZE REST REST
    two-anchor    GRIP_HEAD GRIP_HEAD GRIP_TAIL GRIP_TAIL         (works on ice)
    turn left     GRIP_HEAD GRIP_HEAD GRIP_TAIL_L GRIP_TAIL_L
"""

DECISION_SECONDS = 1.5

ACTIONS = [
    ("REST",        {"feet": "scales", "contract": 0}),
    ("SQUEEZE",     {"feet": "scales", "contract": 1}),
    ("SQUEEZE_L",   {"feet": "scales", "contract": 1, "bend": 0.6, "dir": 0}),
    ("SQUEEZE_R",   {"feet": "scales", "contract": 1, "bend": 0.6, "dir": 180}),
    ("GRIP_HEAD",   {"feet": "anchors", "front": True, "contract": 1}),
    ("GRIP_TAIL",   {"feet": "anchors", "rear": True, "contract": 0}),
    ("GRIP_TAIL_L", {"feet": "anchors", "rear": True, "contract": 0, "bend": 0.9, "dir": 0}),
    ("GRIP_TAIL_R", {"feet": "anchors", "rear": True, "contract": 0, "bend": 0.9, "dir": 180}),
]
NAMES = [a[0] for a in ACTIONS]
N_ACTIONS = len(ACTIONS)
IDX = {n: i for i, n in enumerate(NAMES)}

GAITS = {
    "inchworm": ["SQUEEZE", "SQUEEZE", "REST", "REST"],
    "anchor": ["GRIP_HEAD", "GRIP_HEAD", "GRIP_TAIL", "GRIP_TAIL"],
    "left": ["GRIP_HEAD", "GRIP_HEAD", "GRIP_TAIL_L", "GRIP_TAIL_L"],
    "right": ["GRIP_HEAD", "GRIP_HEAD", "GRIP_TAIL_R", "GRIP_TAIL_R"],
    "stop": ["REST", "REST", "REST", "REST"],
}


def command(a: int) -> dict:
    return dict(ACTIONS[a][1])

GAIT_NAMES = ["inchworm", "anchor", "left", "right", "stop"]   # what the gait-level brain chooses between
