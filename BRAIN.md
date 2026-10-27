# The crawler's mind: the full pipeline

This is the software half of the project. The **body** is the Kresling crawler in
Crease Lab (`index.html`, `web/`). The **brain** (`brain/`) learns to drive it
through four kinds of space: low tunnels, corridors with turns, slopes and ice,
and rubble. Every number below comes from the simulator. Nothing here has run on
a real robot yet.

```
 "crawl 3 body lengths, carefully"
            │
   ┌────────▼─────────┐  once per instruction: rules now, a VLM / SmolVLA later
   │  language layer  │  -> mission {goal, distance, risk budget, refuse-if-unsafe}
   └────────┬─────────┘
            │                       every 1.5 s, using only the robot's own sensors
   ┌────────▼─────────┐ gait, every 6 s  ┌─────────────┐
   │  tiny controller │ ───────────────► │  rhythm     │ (central pattern generator:
   │  (≈800-6k params)│                  │  generator  │  plays the gait's 4 moves)
   └──────────────────┘                  └──────┬──────┘
                                                │ proposed move, every 1.5 s
                                    ┌───────────▼──────────┐
                                    │    safety filter     │──► one of 8 moves
                                    │ "if I do this, can I │    (cable tensions
                                    │  still recover?"     │     + which feet grip)
                                    └──────────▲───────────┘
                                    ┌──────────┴───────────┐
                                    │     world model      │  ensemble: dynamics,
                                    │ (learned simulator)  │  risk (viability), value
                                    └──────────────────────┘
            all of it trained on synthetic experience from the physics simulator
```

## Results from the first full run

Training used 5 families × 80 courses, plus 40 deliberately reckless runs at low tunnels:
55k transitions and 10k what-if moments. Evaluation used 30 **new** courses per family. The
whole run took about 1.5 h on 2 CPU cores. Full tables are in `runs/full/RESULTS.md`.

| controller | gaps | corridor | slopes | rubble | mixed | all |
|---|---|---|---|---|---|---|
| expert (privileged: sees the map) | 100% | 100% | 93% | 83% | 90% | 93% |
| random moves | 57% | 77% | 87% | 13% | 50% | 57% |
| reckless driver (blind to tunnel height) | 57% | 100% | 93% | 83% | 90% | 85% |
| **reckless driver + safety filter** | **97%** | 100% | 93% | 83% | 90% | **93%** |
| tiny controller, 805 params (sensors only) | 100% | 100% | 93% | 47% | 57% | 79% |
| tiny controller + safety filter | 100% | 100% | 93% | 47% | 57% | 79% |
| 6,277-param controller | 100% | 100% | 93% | 53% | 50% | 79% |

What this shows:

* **The world model's "can I still recover?" works.** On 15 tunnels that are just too low,
  the reckless driver crushed itself in 13. With the filter it stopped safely in 14 of 15,
  and it changed no outcome on the other 135 courses. On unseen courses the risk head ranks
  failing moves above safe ones with AUC 0.98. At moments where some moves are fatal and some
  aren't, it rates a safe move as least risky 81% of the time.
* **805 parameters is enough.** The tiny, small, and medium controllers tie at 79%. They
  learned to stop at low tunnels by themselves (15/15), so the filter had nothing to veto for
  them. Their gap to the expert is all on rubble and mixed terrain, and all of it is "stuck",
  mostly pivoting against a boulder. Closing that gap is the next ML problem: more DAgger
  rounds, wider low sensors, a little memory, or RL fine-tuning starting from this policy.
* **Random moves get you surprisingly far** (57%, and 87% on slopes). The directional scales
  turn almost any shape change into forward motion. That's morphological computation, the body
  doing part of the brain's job. It's also why "the brain" matters mainly for the *decisions*:
  stopping, steering, and ice.
* **Successor features transfer.** One ψ, re-weighted for two different tasks with no
  retraining, predicts the true discounted return on unseen courses with correlation 0.83 for
  "make progress" and 0.84 for "keep clear of obstacles".
* **Co-design (small search, 61 bodies × 8 courses):** 3-cell bodies did best on average
  (96% vs 89% for 4 cells), and twists of 30–45° beat the default 50°. The default body ranked
  40 of 61. The suite is small, so read this as a lead, not a result. `codesign.py --preset
  full` on the shared PC will settle it.

## How your ideas map onto the code

| Idea | Where it lives | What it actually does |
|---|---|---|
| **World model**: predict instead of fail | `brain/world_model.py` | An ensemble of small MLPs predicts the next sensor reading, the progress, and the probability of failure. |
| **Failure prediction without failing** (the climbing example) | `brain/data.py` `_branch` | At sampled moments the simulator is **rewound** and every one of the 8 moves is tried, each followed by a careful recovery. The labels say "after move X you could / could not recover." The real robot never has to fall to learn this. |
| **Viability kernel** | risk head + `brain/safety.py` | `1 - risk(state, move)` estimates whether you stay inside the set of states you can still recover from. The filter refuses moves that leave it, but only when a safer move exists. |
| **Uncertainty / knowing what you don't know** | `Ensemble` in `brain/nn.py` | Five nets trained on different resamples. Where they disagree, the model is guessing, and the filter treats that as extra risk (`mean + κ·std`). |
| **Successor representations** | `brain/successor.py` | ψ(s,a) predicts the discounted sum of future sensor features, learned by TD from the same synthetic data. A new task is a new weight vector w (one least-squares fit), with value ψ·w and no retraining. The report checks it on two tasks ("make progress", "keep clear of obstacles") on unseen courses. The controller doesn't use it yet; it's a hook for missions that change on the fly. |
| **Synthetic data** | `brain/data.py` | Everything is generated: expert demos, noisy transitions, and what-if branches. "Daredevil" episodes deliberately head for tunnels the body doesn't fit, so the data covers the edge of the cliff. |
| **Model collapse guard** | `brain/data.py` docstring | Training targets always come from the physics simulator, never from the brain's own imagined rollouts. Imagination is only used to *choose* actions. That is the recipe that avoids collapse. |
| **Lightweight models** | `brain/policy.py`, `brain/nn.py` | The controllers are 16×16 / 32×32 / 64×64 MLPs that pick a gait once per cycle, and a fixed rhythm generator plays it (the brain/spinal-cord split animals use). `Policy.export` writes the net plus the gait table as C (`runs/*/policy_*.h`, an Arduino-sized forward pass). A test checks the C output against Python. |
| **Viability ≠ performance** | `brain/data.py` `CATASTROPHIC` | The risk model only predicts *irreversible* failures (torn, flipped, slid, wedged). "Stuck" is left out on purpose. Counting it made REST look like the only safe move anywhere awkward, and the filter froze the robot. |
| **ML as patterns stored in other substrates / intelligence in the body** | `brain/codesign.py` | Searches over bodies (cells, cell length, twist) for the one the *same* driver handles best. Part of the "intelligence" ends up in the folds. |
| **VLA / VLM** | `brain/mission.py`, `brain/agent.py` | The language model sets the mission (where, how much risk, when to stop) and never drives the motors. It plugs in through `parse(text, llm=...)`. However confident it is, it cannot talk the robot into a move the world model says is unrecoverable. |

## The moves (actions)

Eight discrete moves, each held for 1.5 s (`brain/actions.py`):

| | cables | feet |
|---|---|---|
| `REST` | released | scales (directional friction) |
| `SQUEEZE` | all contract | scales |
| `SQUEEZE_L` / `SQUEEZE_R` | contract + bend left/right | scales |
| `GRIP_HEAD` | contract | front anchored |
| `GRIP_TAIL` | release | rear anchored |
| `GRIP_TAIL_L` / `_R` | release + bend | rear anchored |

Gaits are 4-move cycles of these. `inchworm` = SQUEEZE SQUEEZE REST REST. On ice,
`anchor` uses the grippers. `left` and `right` steer, and `stop` rests.

**Why the controller picks gaits, not moves.** A first version predicted the 8 moves
directly from the sensors plus the previous move. It fell into the copycat trap ("causal
confusion"): once it made one turning move, the previous-move input told it to keep turning.
On rubble it agreed with the expert only 17% of the time and finished 0 of 6 courses. Picking
one of 5 gaits per cycle, from the sensors only, with a fixed rhythm generator playing the
moves, fixed that.

**A reflex that didn't pay off.** The learned controller's most common way to fail on rubble
was pivoting forever against a boulder. It kept choosing "turn left", and the turn did nothing
because the body was pinned. I tried a hand-written reflex between the brain and the rhythm
generator: after two cycles of the same turn with the goal bearing changed by less than 4°,
crawl one cycle instead. It rescued 5 of the 10 failing rubble courses, but it broke about as
many others, so overall success didn't improve (79% → 78% for tiny). It's left in
`Policy._reflex`, switched off.

## Sensors (observation, 36 numbers)

The robot has 13 range finders, all capped at 5:

* **On the front plate (9):** ahead, 10° and 25° up, 30° down, ±30°, ±90°, and straight up.
* **Low obstacle rays (3):** ahead and ±25°, tilted 12° down. On flat ground they just miss,
  so any reading under 5 is something sticking up: a boulder or an up-ramp. The plate is about
  1.1 above the ground, so without these the level rays pass right over a 0.5-tall boulder.
* **Clearance sensor (1):** mounted at the body's peak gait height and looking straight
  ahead. Anything it sees is something the body would hit.

The rest of the observation is pitch, roll, body length, wall-contact force, foot slip, the 4
cable tensions, the 2 anchors, the goal direction and distance, a repeat counter, and the
previous move. A real robot could measure all of this with ToF sensors, an IMU, and cable
encoders.

Two of these sensors exist because the first version of the pipeline failed without them.
Both are concrete hardware recommendations that came out of the simulation:

* **No boulder rays → the controller couldn't learn rubble.** The expert steers around
  boulders using the map. The learned controller only sees its sensors, and the level rays
  passed over the rocks.
* **No clearance sensor → the safety filter couldn't stop at a low tunnel.** The 25° ray
  *does* measure tunnel height: once it passes under the lintel, its range is
  `(ceiling - sensor height) / sin 25°`. But that means that within about 1.9 of the entrance
  nothing reports how far away the entrance is. The world model learned "this is dangerous"
  but couldn't tell safe from doomed. A first fix mounted the sensor relative to the live body
  top, and it flickered: the body bobs about 0.1 per gait cycle and gets pushed down by the
  lintel. A fixed mount at peak height fixed that.

## The spaces (`brain/courses.py`)

All courses are procedurally generated from a seed. Training uses seeds 0–79 and
evaluation uses seeds 1000+, so evaluation courses are never seen in training.

* **gaps**: a tunnel between walls. `check_gaps.py` measured the physics: clearance ≥ 0
  passes freely; -0.1 to 0 the body squeezes in by crushing itself, which counts as a failure
  ("wedged"); below -0.1 the lintel is just a wall. So the dangerous tunnels are the ones that
  are *almost* high enough. The mix is 30% traps, 12% walls, and 58% that fit, and courses skip
  the ambiguous band between -0.04 and +0.08. In a tunnel that doesn't fit, the right answer is
  to **stop before it**, and that counts as success.
* **corridor**: 2–3 segments with turns, between walls.
* **slopes**: ramps up to 8°, with ice (low friction, the scales barely grip) and wet patches.
* **rubble**: gravel (crawl over it) and boulders (steer around; some are dead ahead).
* **mixed**: everything at once.

Failures are: torn (crease strain > 9%), flipped, slid back, stuck (no progress in 24
moves), and wedged (drove into a tunnel it doesn't fit).

## Running it

Needs Python 3.10+, numpy, matplotlib, and **Node.js** (the physics is the same JS as the
browser app), plus ffmpeg for videos.

```bash
pip install numpy matplotlib pytest          # or: conda install numpy matplotlib pytest nodejs ffmpeg -c conda-forge
python -m pytest -q tests                    # ~5 s
node test/terrain_test.js                    # physics regression tests

python scripts/run_all.py --preset quick     # whole pipeline, small (~10 min on 2 cores)
python scripts/run_all.py --preset full      # the real run (use the shared PC; ~1-2 h on many cores)

# watch it think, in the browser: export the trained brain, then open brain.html
python scripts/export_web.py --run runs/full --size tiny          # -> web/brain-model.js
python scripts/export_web.py --run runs/full --single-file runs/brain-demo.html   # one shareable file

# or as videos
python scripts/make_videos.py --run runs/full
python scripts/run_mission.py --course gaps:1001 --say "go forward" --driver daredevil \
    --world-model runs/full/world_model.npz --video runs/gap_with_filter.mp4
python scripts/run_mission.py --course mixed:1003 --say "crawl to the end, carefully" \
    --driver runs/full/policy_tiny.npz --world-model runs/full/world_model.npz --video runs/mixed_tiny.mp4

python scripts/codesign.py --preset full     # which body is easiest to drive?
python scripts/check_gaps.py --n 60          # is the "fits if clearance > 0" rule right?
```

Everything is CPU-only. The GPU is not needed: the networks are tiny on purpose. What helps
is **many CPU cores**, because each simulator runs as its own process.

## Files

```
brain/
  sim.py          Python <-> Node bridge to the Crease Lab physics (web/headless.js)
  courses.py      procedural spaces (gaps, corridor, slopes, rubble, mixed)
  env.py          sensors, failure/success rules, rewind (snapshot/restore)
  actions.py      the 8 moves and the gaits
  expert.py       hand-written privileged driver (teacher + reference)
  data.py         synthetic experience + what-if branches
  nn.py           numpy MLPs, ensembles, C-header export
  world_model.py  dynamics / risk / value ensembles, imagined rollouts
  policy.py       tiny gait controller + rhythm generator, behaviour cloning + DAgger
  safety.py       the veto filter
  mission.py      language -> mission (rule parser; LLM/VLM slot)
  agent.py        mission + controller + filter = Brain
  evaluate.py     held-out evaluation
  codesign.py     body search
  render.py       top + side view videos
scripts/          run_all, run_mission, make_videos, codesign, check_gaps, export_web, server_run.sh
brain.html        the brain driving live in the browser (same physics; web/brain-web.js mirrors the Python brain)
tests/            pytest (incl. browser-brain vs Python-brain parity)
web/terrain.js    terrain (ramps, ice, boxes) + sensors + rewind on top of the original sim
web/headless.js   the sim as a line-JSON server
```

## Honest limits

* **Sim-to-real.** The friction model (directional scales, anchors) and the cable model are
  simplified. Before trusting any number, measure on the real robot: cycle speed on flat
  ground, the turn rate, and the tallest climbable bump. Then retune `web/terrain.js` and
  `brain/courses.py`.
* **The expert is the ceiling for imitation.** It still gets stuck on some rubble (gravel
  under the rear while turning). A learned policy that beats it would need RL on top. The
  `reward` in `env.step` is already there for that.
* **What-if labels use one recovery strategy** (the careful expert). "Recoverable" means
  "recoverable by that expert", which is a lower bound on the true viability kernel.
* **Gaps are binary.** The rigid end plates fix the body's height, so tunnels are a
  fit/doesn't-fit decision, not a squeeze. A body with compliant plates would make this
  continuous and more interesting.

## Open directions (good next projects)

1. **Use the successor features for control.** `brain/successor.py` already learns ψ and
   fits w for new tasks. Next: let the language layer emit a w ("stay near the left wall",
   "keep the ice behind you") and pick gaits by ψ·w. That is a mission change with no
   retraining.
2. **Planning in the dream.** `WorldModel.imagine` already rolls the dynamics forward. Use it
   with `SafeController(lookahead=3)`, or with a small MPC, and measure when the imagination
   helps and when it compounds errors.
3. **Model collapse study (small).** Retrain the world model on its own imagined rollouts
   for k generations and watch the risk AUC on real what-ifs decay. This is cheap with the
   code here, but optional.
4. **Real VLM in the loop.** A camera frame goes to a VLM, which writes a description plus the
   instruction, then calls `parse(..., llm=...)`. SmolVLA is the option if you want a model
   that outputs motor actions directly. The original `origami-rl` folder has that pipeline.
5. **Domain randomisation.** Randomise friction, stiffness, and cable strength in
   `buildTerrainRobot` so the brain doesn't overfit to one simulated robot.
