# Crease Lab: origami crawler body + brain

One lab, two halves, one physics engine (`web/core.js`, `web/motion.js`, `web/terrain.js`):

* **`index.html`**: Crease Lab. Design the folding body, simulate it, plan gaits, and build it.
  Open it in a browser.
* **`brain.html`**: the trained brain driving the crawler live through tunnels, corridors,
  slopes, and rubble. Run `python scripts/export_web.py --run runs/full` first, then open it.
* **`BRAIN.md`**: how the mind works (world model, safety filter, tiny controller, synthetic
  data, successor features, co-design), the results, and how to run everything.
* **`SERVER.md`**: running the full pipeline on the shared GPU PC. It only needs CPU cores.

Quick check:

```bash
pip install numpy matplotlib pytest      # + Node.js and ffmpeg
python -m pytest -q tests
python scripts/run_all.py --preset quick
```
