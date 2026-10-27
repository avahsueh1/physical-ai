#!/usr/bin/env python3
"""Body + brain co-design: search over origami bodies (cells, H, phi) for the one
the same driver handles best.

    python scripts/codesign.py --preset quick     # ~10 min on a laptop
    python scripts/codesign.py --preset full      # ~1 h on a many-core box
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from brain.codesign import search   # noqa: E402

PRESETS = {
    "quick": dict(cells=(3, 4), pop=3, gens=1, suite=[("corridor", 500), ("rubble", 500), ("mixed", 500)]),
    "medium": dict(cells=(2, 3, 4, 5, 6), pop=6, gens=2,
                   suite=[(f, s) for f in ("corridor", "rubble", "slopes", "mixed") for s in (500, 501)]),
    "full": dict(cells=(2, 3, 4, 5, 6), pop=8, gens=4,
                 suite=[(f, s) for f in ("corridor", "rubble", "slopes", "mixed") for s in range(500, 504)]),
}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", default="quick", choices=PRESETS)
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    P = PRESETS[a.preset]
    hist = search(cells=P["cells"], suite=P["suite"], pop=P["pop"], gens=P["gens"], workers=a.workers)
    out = a.out or os.path.join("runs", f"codesign_{a.preset}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(hist, open(out, "w"), indent=1)
    ref = next(h for h in hist if h.get("reference"))
    print("\nrank  cells     H    phi   score  success  progress   failures")
    for i, h in enumerate(hist[:10], 1):
        b = h["body"]
        tag = "  <- default body" if h.get("reference") else ""
        print(f"{i:4d}  {b['cells']:5d}  {b['H']:5.2f}  {b['phi']:5.1f}  {h['score']:6.3f}  {h['success']:6.0%}"
              f"  {h['progress']:8.0%}   {','.join(sorted(set(map(str, h['failures'])))) or '-'}{tag}")
    print(f"\ndefault body ranks {hist.index(ref) + 1} of {len(hist)}; wrote {out}")
