# Simulation folders

This branch collects the supplied browser projects and Ava's AI-assisted
evaluation experiments. It does not implement or validate the new Foldbot
PLA/TPU CAD mechanism or a simulator-plus-VLA training pipeline.

| Folder | Purpose | Run |
|---|---|---|
| `navigation-lab/` | Fixed/resizable circular-footprint planning baseline, benchmark, report and Python plots | `cd navigation-lab`, then `npm start`; `npm test`; `npm run evaluate` |
| `crawler-evaluation/` | Friction/fold-stiffness sweeps using the supplied Crease Lab crawler, diagnostics, plots and motion replay | From this folder: `node sweep.cjs`; `node --test test.cjs`; `python plot.py`; `node record.cjs`; `python animate.py` |
| `crease-lab/` | Supplied browser origami/crawler project; also supplies the evaluation's core dynamics | Serve the repository with a local static server and open `/crease-lab/` |
| `partforge/` | Supplied digital-logic and vehicle simulation project | Serve the repository with a local static server and open `/partforge/` |

For the supplied browser projects, one option from the repository root is
`python -m http.server 8766 --bind 127.0.0.1`. Then visit
`http://127.0.0.1:8766/crease-lab/` or `http://127.0.0.1:8766/partforge/`.
PartForge's tests run from the root with `node --test partforge/tests/*.test.mjs`.

## Provenance

`crease-lab/` and `partforge/` were extracted from ZIPs supplied by the user.
They are preserved as supplied, not claimed as independently authored by Ava.
Crease Lab was described by the team as Claude-assisted. Upstream project pages:
https://williamc.me/projects/crease-lab/ and https://williamc.me/projects/partforge/.
The included Three.js license is retained. No new license is asserted for the
supplied project code. `crawler-evaluation/results/sweep.json` records SHA-256
hashes of the exact Crease Lab core and motion sources used.

## Results and limits

- Navigation: deterministic geometric planning, not contact physics or robot learning.
- Crawler: an uncalibrated bar-and-hinge model with directional ground friction
  and preset actuation; not the later Foldbot design and not hardware evidence.
- Crawler plots, raw sweep data, replay coordinates and GIF are checked in.
- Navigation's large per-run files can be regenerated with `npm run evaluate`;
  its report, plot snapshot data and figures are checked in.
- Tests and timestep checks establish limited numerical/code properties, not
  physical validity. Read each experiment's README before interpreting results.

CAD files, private conversation archives and duplicate inspection folders are
outside this simulation package. Nothing in this update merges into `main`.
