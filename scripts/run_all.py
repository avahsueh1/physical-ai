#!/usr/bin/env python3
"""The whole brain pipeline, end to end.

    python scripts/run_all.py --preset quick      # ~10 min on a laptop, sanity check
    python scripts/run_all.py --preset full       # ~1-2 h on a many-core box (the shared PC)

Stages (each saves into runs/<name>/ and is skipped if its output already exists,
so a crashed or interrupted run picks up where it left off; --fresh to redo):

  1 data       synthetic experience from the simulator (demos, transitions, what-ifs)
  2 world      world model: dynamics ensemble + risk (viability) + value
  3 policy     tiny controllers (BC + DAgger) for each size, + C headers
  4 evaluate   held-out courses: expert / random / policies / policies + safety filter /
               reckless driver + safety filter
  5 report     results.json + RESULTS.md
"""
import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from brain import data as D                                   # noqa: E402
from brain.courses import FAMILIES                            # noqa: E402
from brain.evaluate import evaluate, format_table, summarize  # noqa: E402
from brain.policy import Policy, dagger                       # noqa: E402
from brain.nn import MLP                                       # noqa: E402
from brain.successor import SuccessorFeatures                 # noqa: E402
from brain.successor import report as sf_report               # noqa: E402
from brain.world_model import WorldModel                      # noqa: E402


def MLP_load_sf(fn):
    z = np.load(fn, allow_pickle=False)
    sf = SuccessorFeatures.__new__(SuccessorFeatures)
    sf.net = MLP.from_state(z); sf.scale = z["scale"]; sf.gamma = float(z["gamma"])
    return sf

PRESETS = {
    #            train seeds      dagger seeds  rounds  eval seeds         sizes                     ensemble  epochs
    "quick": dict(train=range(0, 8), dag=range(50, 54), rounds=1, evals=range(1000, 1006),
                  sizes=["small"], k=3, epochs=40),
    "full": dict(train=range(0, 80), dag=range(200, 230), rounds=3, evals=range(1000, 1030),
                 sizes=["tiny", "small", "medium"], k=5, epochs=80),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", default="quick", choices=PRESETS)
    ap.add_argument("--name", default=None, help="run folder name (default: the preset)")
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--tau", type=float, default=0.3, help="risk budget of the safety filter")
    ap.add_argument("--fresh", action="store_true")
    args = ap.parse_args()
    P = PRESETS[args.preset]
    out = os.path.join("runs", args.name or args.preset)
    os.makedirs(out, exist_ok=True)
    path = lambda f: os.path.join(out, f)
    have = lambda f: os.path.exists(path(f)) and not args.fresh
    T = {}

    # 1 ---------------------------------------------------------------- data
    t = time.time()
    if have("data.npz"):
        data = D.load(path("data.npz")); print(f"[1/5] data: reusing {path('data.npz')}")
    else:
        print(f"[1/5] data: {len(FAMILIES)} families x {len(P['train'])} seeds (+ reckless gap runs)")
        data = D.collect(FAMILIES, P["train"], workers=args.workers)
        D.save(data, path("data.npz"))
    if have("val.npz"):
        val = D.load(path("val.npz"))
    else:
        nv = max(2, len(P["train"]) // 8)
        print(f"      + validation what-ifs on {nv} unseen seeds per family")
        val = D.collect(FAMILIES, range(900, 900 + nv), workers=args.workers, verbose=False, daredevil=1.0)
        D.save(val, path("val.npz"))
    T["data"] = time.time() - t
    print(f"      {len(data['obs'])} transitions, {len(data['b_obs'])} what-if moments, "
          f"expert success while collecting {data['episode_success'].mean():.0%}")

    # 2 ----------------------------------------------------------- world model
    t = time.time()
    if have("world_model.npz"):
        print("[2/5] world model: reusing"); wm = WorldModel.load(path("world_model.npz"))
    else:
        print("[2/5] world model")
        wm = WorldModel(k=P["k"]); wm.fit(data, epochs=P["epochs"]); wm.save(path("world_model.npz"))
    T["world"] = time.time() - t
    wm_stats = {"train": world_model_report(wm, data), "validation (unseen courses)": world_model_report(wm, val)}
    print("      " + json.dumps(wm_stats))
    if have("successor.npz"):
        sf = MLP_load_sf(path("successor.npz"))
    else:
        print("      + successor features")
        sf = SuccessorFeatures().fit(data, verbose=False)
        np.savez(path("successor.npz"), scale=sf.scale, gamma=sf.gamma, **sf.net.state())
    wm_stats["successor features: corr(psi.w, true return) on unseen courses"] = sf_report(sf, data, val)
    print("      " + json.dumps(wm_stats["successor features: corr(psi.w, true return) on unseen courses"]))

    # 3 ------------------------------------------------------------- policies
    pols = {}
    for size in P["sizes"]:
        t = time.time()
        f = f"policy_{size}.npz"
        if have(f):
            print(f"[3/5] policy {size}: reusing"); pol = Policy.load(path(f))
        else:
            print(f"[3/5] policy {size}: behaviour cloning + {P['rounds']} DAgger rounds")
            pol = Policy(size)
            dagger(pol, data["obs"], data["gait"], FAMILIES, P["dag"], rounds=P["rounds"],
                   workers=args.workers, epochs=P["epochs"])
            pol.save(path(f))
            pol.export(path(f"policy_{size}.h"), name=f"crawler_{size}")
        pols[size] = pol
        T[f"policy_{size}"] = time.time() - t
        print(f"      {pol.net.n_params} parameters, agrees with the expert's gait choice on "
              f"{pol.accuracy(data['obs'], data['gait']):.0%} of collected cycle starts")

    # 4 ------------------------------------------------------------- evaluate
    t = time.time()
    wmp = path("world_model.npz")
    specs = ["expert", "random", "daredevil", f"safe:daredevil|{wmp}|{args.tau}"]
    for size in P["sizes"]:
        pp = path(f"policy_{size}.npz")
        specs += [f"policy:{pp}", f"safe:policy:{pp}|{wmp}|{args.tau}"]
    print(f"[4/5] evaluate: {len(specs)} controllers x {len(FAMILIES)} families x {len(P['evals'])} held-out seeds")
    rows = evaluate(specs, FAMILIES, P["evals"], workers=args.workers)
    T["evaluate"] = time.time() - t
    nice = lambda s: s.replace(path(""), "").replace(".npz", "").replace(f"|world_model|{args.tau}", "")
    for r in rows:
        r["spec"] = nice(r["spec"])
    summ = summarize(rows)

    # 5 --------------------------------------------------------------- report
    table = format_table(summ, FAMILIES)
    print("\n" + table + "\n")
    json.dump({"preset": args.preset, "tau": args.tau, "timing_s": T, "world_model": wm_stats,
               "summary": summ, "episodes": rows,
               "policy_params": {s: p.net.n_params for s, p in pols.items()}},
              open(path("results.json"), "w"), indent=1, default=str)
    write_report(path("RESULTS.md"), args, P, data, wm_stats, pols, table, summ, T)
    print(f"[5/5] wrote {path('results.json')} and {path('RESULTS.md')}")


def world_model_report(wm, data, n_hold=0.2):
    """How well does the risk head rank dangerous vs safe moves (on the what-if data)?"""
    bo = data["b_obs"]
    A = np.tile(np.arange(8), len(bo)); O = np.repeat(bo, 8, 0); y = data["b_fail"].ravel()
    m, s = wm.risk(O, A)
    pos, neg = m[y > 0.5], m[y < 0.5]
    auc = float((pos[:, None] > neg[None, :]).mean()) if len(pos) and len(neg) else float("nan")
    # within-moment discrimination: moments where some moves fail and others don't
    mixed = (data["b_fail"].min(1) < 0.5) & (data["b_fail"].max(1) > 0.5)
    ok = 0
    for i in np.where(mixed)[0]:
        r = m[i * 8:(i + 1) * 8]; f = data["b_fail"][i]
        ok += r[f < 0.5].min() < r[f > 0.5].min()
    return {"what_if_moments": int(len(bo)), "failing_moves": round(float(y.mean()), 4),
            "risk_auc": round(auc, 3), "mixed_moments": int(mixed.sum()),
            "picks_a_safe_move_in_mixed": round(ok / max(1, mixed.sum()), 3)}


def write_report(fn, args, P, data, wm_stats, pols, table, summ, T):
    lines = [f"# Results: preset `{args.preset}`", "",
             f"Training courses: {len(FAMILIES)} families x {len(P['train'])} seeds. "
             f"Held-out evaluation: {len(P['evals'])} *new* seeds per family. Safety budget tau = {args.tau}.", "",
             "## Success rate on held-out courses", "", "```", table, "```", "",
             "* `expert` uses privileged info (the course map); everything else only sees the robot's own sensors,",
             "  except `daredevil`, which is the expert blinded to tunnel height (a stand-in for a reckless",
             "  high-level command such as 'go forward' from a language model).",
             "* `safe:X` = controller X wrapped in the world-model safety filter.", "",
             "## World model", "", "```", json.dumps(wm_stats, indent=1), "```", "",
             "## Controllers", ""]
    for s, p in pols.items():
        lines.append(f"* {s}: {p.net.n_params} parameters "
                     f"({p.net.n_params * 4 / 1024:.1f} KB as float32) -> `policy_{s}.h`")
    lines += ["", "## Time (s)", "", "```", json.dumps({k: round(v) for k, v in T.items()}, indent=1), "```", ""]
    open(fn, "w").write("\n".join(lines))


if __name__ == "__main__":
    main()
