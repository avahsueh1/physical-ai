"""Plot the geometric benchmark; no physical measurements or inferred error bars."""
import argparse
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "evaluation-output/summary.json")
    parser.add_argument("--output", type=Path, default=ROOT / "plots")
    args = parser.parse_args()
    data = json.loads(args.input.read_text(encoding="utf-8-sig"))
    rows = data["rows"]

    def row(robot, speed, cost):
        matches = [r for r in rows if r["kind"] == "sealed" and
                   r["robot"] == robot and r["compactSpeed"] == speed and r["switchCost"] == cost]
        if len(matches) != 1:
            raise ValueError(f"Expected one result: {robot}, {speed}, {cost}")
        return matches[0]

    names = ["Fixed compact", "Fixed medium", "Fixed wide", "Reconfigurable"]
    colors = ["#ae7137", "#8064a2", "#577e9c", "#087f78"]
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10,
                         "axes.spines.top": False, "axes.spines.right": False,
                         "svg.fonttype": "none"})
    fig, axes = plt.subplots(1, 3, figsize=(15, 5.6))
    fig.subplots_adjust(left=.06, right=.98, top=.76, bottom=.27, wspace=.36)
    fig.suptitle("When does changing shape help?", x=.06, ha="left", fontsize=21, weight="bold", y=.96)
    fig.text(.06, .87, "Geometric navigation baseline  |  Walls with passages and no detour", fontsize=12)

    ax = axes[0]
    results = [row(name, .5, 1) for name in names]
    bars = ax.bar(range(4), [r["successes"] / r["scenarios"] * 100 for r in results], color=colors)
    ax.set_xticks(range(4), ["Fixed\nsmall", "Fixed\nmedium", "Fixed\nlarge", "Can\nresize"])
    ax.set_ylim(0, 119)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_ylabel("Maps with a route (%)")
    ax.set_title("1. Fitting through the openings", loc="left", pad=16, weight="bold", fontsize=11)
    for bar, r in zip(bars, results):
        ax.text(bar.get_x()+bar.get_width()/2, bar.get_height()+3,
                f'{r["successes"]}/{r["scenarios"]}', ha="center")

    ax = axes[1]
    for offset, name, color in [(-.18, names[0], colors[0]), (.18, names[3], colors[3])]:
        values = [row(name, speed, 1)["meanTimeSuccessful"] for speed in [1, .5]]
        assert all(row(name, speed, 1)["successes"] == 30 for speed in [1, .5])
        bars = ax.bar([offset, 1+offset], values, width=.34, color=color, label=name)
        ax.bar_label(bars, fmt="%.1f", padding=3)
    ax.set_xticks([0, 1], ["All shapes\nequally fast", "Small shape\nhalf speed"])
    ax.set_ylim(0, 53)
    ax.set_ylabel("Mean planned time (abstract units)")
    ax.set_title("2. A speed tradeoff creates value", loc="left", pad=16, weight="bold", fontsize=11)
    ax.legend(frameon=False, fontsize=9, loc="upper left")

    ax = axes[2]
    for name, color in [(names[0], colors[0]), (names[3], colors[3])]:
        values = [row(name, .5, cost)["meanTimeSuccessful"] for cost in [0, 1, 5]]
        ax.plot([0, 1, 5], values, marker="o", color=color, linewidth=2, label=name)
        for cost, value in zip([0, 1, 5], values):
            ax.annotate(f"{value:.1f}", (cost, value), xytext=(0, 7), textcoords="offset points", ha="center", fontsize=9)
    ax.set_xticks([0, 1, 5])
    ax.set_ylim(0, 53)
    ax.set_xlabel("Time cost per shape change (abstract units)")
    ax.set_ylabel("Mean planned time (abstract units)")
    ax.set_title("3. Slower reshaping reduces the gain", loc="left", pad=16, weight="bold", fontsize=11)
    ax.legend(frameon=False, fontsize=9, loc="lower right")
    for ax in axes:
        ax.set_axisbelow(True)
        ax.grid(axis="y", alpha=.18)
    fig.text(.06, .12, "Panels 2–3 compare the same 30 maps; both robots succeed on all 30. Panel 3 assumes half-speed small bodies.", fontsize=10)
    fig.text(.06, .075, "Assumed speeds, full-map planning, and free initial shape choice. No physics, learning, or hardware validation.", fontsize=10, color="#555555")
    fig.text(.06, .03, "Deterministic designed cases; no statistical error bars. Medium/large travel times omitted because their successful map sets differ.", fontsize=9, color="#555555")
    args.output.mkdir(parents=True, exist_ok=True)
    for ext in ["png", "svg", "pdf"]:
        fig.savefig(args.output / f"baseline-results.{ext}", dpi=180, facecolor="white")
    plt.close(fig)
    snapshot = {"source": str(args.input.name), "sourceSha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
                "matplotlibVersion": matplotlib.__version__, "rows": rows,
                "negativeControl": data["negativeControl"]}
    (args.output / "plot-data.json").write_text(json.dumps(snapshot, indent=2)+"\n", encoding="utf-8")
    print(f"Wrote PNG, SVG, PDF, and plot-data.json to {args.output}")


if __name__ == "__main__":
    main()
