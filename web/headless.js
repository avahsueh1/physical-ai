#!/usr/bin/env node
// ===== Crease Lab headless server: the same physics as the browser, driven from Python =====
//
// One JSON object per line on stdin, one JSON reply per line on stdout.
//   {"cmd":"reset", "params":{...}, "terrain":{...}, "pose":{"x":0,"y":0,"yaw":0}, "stiff":{...}}
//   {"cmd":"step", "action":{"contract":1,"bend":0,"dir":0,"feet":"scales","front":false,"rear":false}, "seconds":1.0}
//                                  optional "frames": k -> also returns k node snapshots during the step
//   {"cmd":"snapshot"}             -> {"id": k}
//   {"cmd":"restore", "id": k}     (the snapshot is kept; drop it with {"cmd":"drop","id":k})
//   {"cmd":"nodes"}                -> node positions for rendering
//   {"cmd":"info"}                 -> dt, body length, bars, rings, feet (for rendering / sizing)
// Every reply to reset/step/restore carries {"sense": ..., "status": ...}.
'use strict';
const path = require('path');
const readline = require('readline');
const CL = require(path.join(__dirname, 'terrain.js'));

let sim = null;
const snaps = new Map();
let nextId = 1;

function obs() { return { sense: sim.sense(), status: sim.status() }; }

function handle(msg) {
  switch (msg.cmd) {
    case 'reset': {
      sim = CL.buildTerrainRobot(msg.params || {}, msg.terrain || {}, msg.stiff || null, msg.pose || null);
      snaps.clear();
      return Object.assign({ ok: true, dt: sim.dt, bodyLength: sim.bodyLength }, obs());
    }
    case 'step': {
      if (msg.action) CL.applyCommand(sim, msg.action);
      const n = Math.max(1, Math.round((msg.seconds || 1) / sim.dt));
      if (msg.frames) {                         // also return k evenly spaced node snapshots (for videos)
        const k = Math.max(1, msg.frames | 0), frames = [];
        let done = 0;
        for (let f = 1; f <= k; f++) {
          const upto = Math.round((n * f) / k);
          if (upto > done) sim.step(upto - done);
          done = upto;
          frames.push(Array.from(sim.nodes(), (v) => Math.round(v * 1000) / 1000));
        }
        return Object.assign({ ok: true, frames }, obs());
      }
      sim.step(n);
      return Object.assign({ ok: true }, obs());
    }
    case 'snapshot': { const id = nextId++; snaps.set(id, sim.snapshot()); return { ok: true, id }; }
    case 'restore': { sim.restore(snaps.get(msg.id)); return Object.assign({ ok: true }, obs()); }
    case 'drop': { snaps.delete(msg.id); return { ok: true }; }
    case 'nodes': return { ok: true, x: sim.nodes() };
    case 'info': {
      const pat = sim.mesh.pat;
      return {
        ok: true, dt: sim.dt, N: sim.N, bodyLength: sim.bodyLength,
        bars: sim.bars.map((b) => [b.i, b.j]), extraBars: (pat.extraBars || []),
        rings: pat.rings, feet: pat.feet, cables: pat.cables.length,
      };
    }
    case 'ping': return { ok: true, pong: true };
    default: return { ok: false, error: 'unknown cmd ' + msg.cmd };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let out;
  try { out = handle(JSON.parse(line)); }
  catch (e) { out = { ok: false, error: String(e && e.stack || e) }; }
  process.stdout.write(JSON.stringify(out) + '\n');
});
