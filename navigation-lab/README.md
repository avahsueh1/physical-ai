# Morphology navigation lab

A standalone, dependency-free 2D experiment for the Physical AI group. Compares three fixed circular footprints and one robot that can resize, using the same full-map shortest-time planner. No Crease Lab or PartForge files are modified or required. AI-assisted prototype; not validated robotics research.

## Run locally

Requires Node.js 20+ and a modern browser. No npm install, Python, GPU, VLM, or simulator download is required.

```powershell
cd "C:\Users\avahs\OneDrive\Documents\ChatGPT\bruin ml physical ai\navigation-lab"
npm start
```

Open http://127.0.0.1:8765. Compute routes after changing settings, play or scrub the comparison, and export the complete run as JSON. Stop the server with Ctrl+C. The server binds only to localhost.

```powershell
npm test
npm run benchmark
```

Benchmark writes `benchmark-results.json` with 720 robot results (10 seeds × 3 opening widths × 3 map families × 2 speed settings × 4 robots). Reports success counts and conditional mean travel times. These are deterministic designed scenarios, not independent real-world trials or a generalization benchmark. Seeds change opening locations; open maps are identical across seeds. Do not treat repeated open maps as independent evidence.

## Model and fair controls

- 800 × 480 abstract-unit world, 10-unit grid; axis-aligned movement.
- Footprint radii: compact 8, medium 14, wide 22. This is resizing a disk, not an origami kinematic mechanism or physical crawler.
- Dijkstra search over `(x, y, shape)` minimizes translation time plus a fixed cost per resize. Every controller knows all obstacles. Fixed robots use the same search with one permitted shape.
- Translation checks the exact swept disk against rectangles; resizing checks the largest disk at the stationary location. No wall tunneling or instant resizing during translation.
- Base speed is 40 abstract units per time unit. Compact multiplier defaults to 1 for all robots. Medium and wide speeds are equal. All models share the same assumptions.
- Adaptive robot can choose any initial shape for free. No required terminal shape. The fixed compact baseline therefore should tie adaptive performance when all speeds are equal. This negative control is deliberate.
- The optional 0.5 compact-speed multiplier is a hypothetical engineering tradeoff, not a measured relationship. A benefit under it is conditional on that assumption. Shape change costs time (default 1), not measured energy.
- Map families: open, narrow passages with a bottom detour, or full-height barriers with passages only. Same map and start/goal for each robot.
- A failed planner reports no route on this discretization; it does not establish continuous-space infeasibility or physical getting-stuck behavior.

## Evidence limits and next work

No contact dynamics, friction, inertia, actuation, material deformation, sensor noise, local perception, learning, physical energy, or hardware validation. Body mass/area conservation is not modeled. Animation replays planned trajectories; it is not an independent dynamics rollout.

Next: agree with the team on a mechanism and feasible shape changes, calibrate tradeoffs, then implement a dynamics model in an agreed simulator. MuJoCo and PyBullet are candidates; neither is installed or used here. Add realistic sensing and controller execution before making claims about learned navigation or sim-to-real transfer.

## Repository handoff

This folder is self-contained and can be copied into another checkout. The experiment lives on `codex/navigation-lab`; `main` is intentionally empty. `engine.js` is shared by browser and benchmark; `test.mjs` checks collision safety, reproducibility, analytical travel time, blocked passages, and the compact baseline control. Generated benchmark results are ignored and can be reproduced with the command above.
