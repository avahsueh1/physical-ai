#!/usr/bin/env bash
# Full pipeline on the shared PC. Run inside tmux so a dropped SSH connection doesn't kill it:
#   tmux new -s william-brain      (or: tmux attach -t william-brain)
#   bash scripts/server_run.sh
# Uses at most $WORKERS cores (default: half the machine) so other people can still work.
set -euo pipefail
cd "$(dirname "$0")/.."
WORKERS=${WORKERS:-$(( $(nproc) / 2 ))}
mkdir -p runs
echo "using $WORKERS worker processes; logs in runs/*.log"
python -m pytest -q tests                                                     2>&1 | tee runs/tests.log
python scripts/run_all.py --preset full --workers "$WORKERS"                  2>&1 | tee runs/full.log
python scripts/codesign.py --preset full --workers "$WORKERS"                 2>&1 | tee runs/codesign.log
python scripts/check_gaps.py --n 80 --workers "$WORKERS"                      2>&1 | tee runs/check_gaps.log
python scripts/make_videos.py --run runs/full                                 2>&1 | tee runs/videos.log
python scripts/export_web.py --run runs/full --size tiny --single-file runs/brain-demo.html 2>&1 | tee runs/export.log
echo "done. results: runs/full/RESULTS.md  runs/codesign.log  runs/full/videos/  runs/brain-demo.html"
