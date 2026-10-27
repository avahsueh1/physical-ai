# Running the brain pipeline on the shared PC

Everything runs on the CPU. More cores means faster runs, and the GPU isn't needed. The
script uses half the machine's cores by default, so other people can keep working.

**Paste one line at a time.**

On your laptop, copy the project up. Skip this if you use git instead:

```bash
scp crease-lab-brain.zip bruinml:~/william/
```

On the server:

```bash
ssh bruinml
cd ~/william && unzip -o crease-lab-brain.zip && cd crease-lab
conda activate william-origami
conda install -y -c conda-forge nodejs ffmpeg        # once: the physics runs in node, videos need ffmpeg
pip install numpy matplotlib pytest
python -m pytest -q tests                            # should say "passed" (about 20 tests)
tmux new -s william-brain                            # a dropped SSH connection won't kill the run
bash scripts/server_run.sh                           # ~1-2 h; detach with Ctrl-b then d
```

Later, reattach to check on it:

```bash
ssh -t bruinml tmux attach -t william-brain
```

Or, without attaching:

```bash
ssh bruinml "tail -n 30 ~/william/crease-lab/runs/full.log"
```

When it's done, copy the results back to your laptop:

```bash
scp -r bruinml:~/william/crease-lab/runs ./runs-from-server
```

The results you'll get back:

* `runs/full/RESULTS.md`: the success-rate table, the world-model stats, and the controller sizes
* `runs/full/policy_tiny.h`: the controller as C, for the microcontroller
* `runs/full/videos/*.mp4`: demo videos
* `runs/brain-demo.html`: the brain driving live in a browser, as one file you can open or share
* `runs/codesign.log`: which body (cells, cell length, twist) is easiest to drive

To use fewer cores, set `WORKERS` before the run, for example `WORKERS=8 bash scripts/server_run.sh`.
