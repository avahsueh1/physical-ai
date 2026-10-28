// A two-wheeled robot on a table with a line track. Any part whose pins match
// the names below can be dropped in as its brain.
//
//   Brain inputs  (sensors): lineL, lineR, bump
//   Brain outputs (motors) : motorL, motorR   forward
//                            revL,   revR     reverse (optional)
import { compilePart } from '../engine/compile.js';
import { Simulator } from '../engine/simulator.js';
export const SENSOR_PINS = ['lineL', 'lineR', 'bump'];
export const MOTOR_PINS = ['motorL', 'motorR', 'revL', 'revR'];
export function ovalTrack(cx, cy, rx, ry, n = 160) {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  });
}
export function defaultConfig() {
  return {
    width: 600,
    height: 420,
    track: ovalTrack(300, 210, 220, 140),
    lineWidth: 10,
    wheelBase: 24,
    maxSpeed: 70,
    sensorForward: 14,
    sensorSide: 9,
    radius: 14,
    brainTicksPerStep: 32,
  };
}
export function distToTrack(p, track) {
  let best = Infinity;
  for (let i = 0; i < track.length; i++) {
    const a = track[i],
      b = track[(i + 1) % track.length];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}
/** Does this part have the pins to drive the vehicle? */
export function isBrain(def) {
  return def.outputs.some((p) => MOTOR_PINS.includes(p)) && def.inputs.every((p) => SENSOR_PINS.includes(p));
}
export class Vehicle {
  config;
  brain;
  x = 0;
  y = 0;
  heading = 0;
  sensors = { lineL: false, lineR: false, bump: false };
  motors = { left: 0, right: 0 };
  distance = 0;
  time = 0;
  trail = [];
  bumped = false;
  constructor(config, brain = null) {
    this.config = config;
    this.brain = brain;
    this.reset();
  }
  static withBrain(lib, partId, config = defaultConfig()) {
    return new Vehicle(config, new Simulator(compilePart(lib, partId)));
  }
  reset() {
    const [a, b] = this.config.track;
    this.x = a.x;
    this.y = a.y;
    this.heading = Math.atan2(b.y - a.y, b.x - a.x);
    this.distance = this.time = 0;
    this.trail = [];
    this.bumped = false;
    this.motors = { left: 0, right: 0 };
    this.sensors = this.readSensors();
  }
  sensorPositions() {
    const { sensorForward: f, sensorSide: s } = this.config;
    const fx = Math.cos(this.heading),
      fy = Math.sin(this.heading);
    const lx = fy,
      ly = -fx; // left of forward on a y-down screen
    return {
      left: { x: this.x + fx * f + lx * s, y: this.y + fy * f + ly * s },
      right: { x: this.x + fx * f - lx * s, y: this.y + fy * f - ly * s },
    };
  }
  readSensors() {
    const { left, right } = this.sensorPositions();
    const half = this.config.lineWidth / 2;
    return {
      lineL: distToTrack(left, this.config.track) <= half,
      lineR: distToTrack(right, this.config.track) <= half,
      bump: this.bumped,
    };
  }
  /** Sense -> think -> act, for one physics step. */
  step(dt) {
    const c = this.config;
    this.sensors = this.readSensors();
    if (this.brain) {
      for (const pin of SENSOR_PINS) this.brain.setInput(pin, this.sensors[pin]);
      this.brain.run(c.brainTicksPerStep);
      const o = (p) => (this.brain.output(p) ? 1 : 0);
      this.motors = { left: o('motorL') - o('revL'), right: o('motorR') - o('revR') };
    }
    const vl = this.motors.left * c.maxSpeed,
      vr = this.motors.right * c.maxSpeed;
    const v = (vl + vr) / 2;
    this.heading += ((vl - vr) / c.wheelBase) * dt;
    let nx = this.x + Math.cos(this.heading) * v * dt;
    let ny = this.y + Math.sin(this.heading) * v * dt;
    const r = c.radius;
    const cx = Math.max(r, Math.min(c.width - r, nx));
    const cy = Math.max(r, Math.min(c.height - r, ny));
    this.bumped = cx !== nx || cy !== ny;
    nx = cx;
    ny = cy;
    this.distance += Math.hypot(nx - this.x, ny - this.y);
    this.x = nx;
    this.y = ny;
    this.time += dt;
    if (this.trail.length === 0 || Math.hypot(nx - this.trail.at(-1).x, ny - this.trail.at(-1).y) > 4) {
      this.trail.push({ x: nx, y: ny });
      if (this.trail.length > 400) this.trail.shift();
    }
  }
}
