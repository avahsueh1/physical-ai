import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { circuit, EXAMPLES } from '../web/engine/examples.js';
import { IN, OUT, PartLibrary } from '../web/engine/parts.js';
import { defaultConfig, distToTrack, isBrain, Vehicle } from '../web/vehicle/world.js';

const DT = 1 / 60;

function lib() {
  const l = new PartLibrary();
  l.load(EXAMPLES);
  return l;
}

function withHigh(l, id, outs, extraNodes = []) {
  l.define({
    id, name: id,
    circuit: circuit(
      [['h', 'HIGH', 0, 0], ...outs.map((p, i) => [`o${i}`, OUT, 1, i, p]), ...extraNodes],
      outs.map((_, i) => `h.out -> o${i}.in`),
    ),
  });
}

describe('vehicle', () => {
  it('recognises brain-shaped parts', () => {
    const l = lib();
    assert.equal(isBrain(l.get('Line Follower')), true);
    assert.equal(isBrain(l.get('Half Adder')), false);
  });

  it('drives straight with both motors on', () => {
    const l = lib();
    withHigh(l, 'Go', ['motorL', 'motorR']);
    const v = Vehicle.withBrain(l, 'Go');
    const h0 = v.heading;
    for (let i = 0; i < 30; i++) v.step(DT);
    assert.ok(Math.abs(v.heading - h0) < 1e-9);
    assert.ok(Math.abs(v.distance - defaultConfig().maxSpeed * 0.5) < 1);
  });

  it('turns toward the side whose motor is off', () => {
    const l = lib();
    withHigh(l, 'Right Only', ['motorR']);
    const v = Vehicle.withBrain(l, 'Right Only');
    const h0 = v.heading;
    for (let i = 0; i < 10; i++) v.step(DT);
    assert.ok(v.heading < h0); // a left turn on a y-down screen
  });

  it('the example Line Follower laps the track without losing the line', () => {
    const v = Vehicle.withBrain(lib(), 'Line Follower');
    const cfg = v.config;
    const cx = cfg.width / 2, cy = cfg.height / 2;
    let swept = 0, worst = 0;
    let prev = Math.atan2(v.y - cy, v.x - cx);
    for (let i = 0; i < 60 * 40; i++) {
      v.step(DT);
      const a = Math.atan2(v.y - cy, v.x - cx);
      let d = a - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      swept += d;
      prev = a;
      worst = Math.max(worst, distToTrack(v, cfg.track));
    }
    assert.ok(Math.abs(swept) > 2 * Math.PI, 'completes at least one lap');
    assert.ok(worst < cfg.sensorSide + cfg.lineWidth, 'stays on the line');
  });

  it('feels a bump at the table edge', () => {
    const l = lib();
    withHigh(l, 'Go', ['motorL', 'motorR'], [['b', IN, 0, 1, 'bump']]);
    const v = Vehicle.withBrain(l, 'Go');
    for (let i = 0; i < 60 * 10 && !v.sensors.bump; i++) v.step(DT);
    assert.equal(v.sensors.bump, true);
  });

  it('a wall bouncer (reverse one wheel on bump) roams the table', () => {
    const l = lib();
    l.define({
      id: 'Wall Bouncer', name: 'Wall Bouncer',
      circuit: circuit(
        [
          ['b', IN, 40, 60, 'bump'], ['h', 'HIGH', 40, 200], ['n', 'NOT', 220, 60],
          ['ml', OUT, 400, 40, 'motorL'], ['rl', OUT, 400, 120, 'revL'], ['mr', OUT, 400, 200, 'motorR'],
        ],
        ['b.out -> n.in', 'n.out -> ml.in', 'b.out -> rl.in', 'h.out -> mr.in'],
      ),
    });
    const v = Vehicle.withBrain(l, 'Wall Bouncer');
    let bumps = 0;
    const cells = new Set();
    for (let i = 0; i < 60 * 60; i++) {
      v.step(DT);
      if (v.sensors.bump) bumps++;
      cells.add(`${Math.floor(v.x / 100)},${Math.floor(v.y / 100)}`);
    }
    assert.ok(bumps > 0);
    assert.ok(cells.size > 6);
  });
});
