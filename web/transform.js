// ===== Crease Lab transform: one origami robot, four body shapes =====
// A Kresling body (good at shortening) plus one hinged neck (good at turning), so the same robot can
// stow compact, crawl, raise a camera like a periscope, and hold its head at an angle to reach.
// Loads after motion.js. Works in the browser (window.CreaseLab) and in node (module.exports).
(function (root) {
  'use strict';
  const CL = typeof module !== 'undefined' && module.exports ? require('./motion.js') : root.CreaseLab;
  const PI = Math.PI, DEG = PI / 180;

  const TRANSFORMER_PARAMS = [
    { key: 'cells', label: 'Body cells', min: 3, max: 5, step: 1, value: 4, int: true },
    { key: 'phi', label: 'Twist per cell', min: 30, max: 65, step: 0.5, value: 50, unit: '°' },
    { key: 'battery', label: 'Battery in the shoulder', min: 2, max: 12, step: 0.5, value: 6, unit: '×' },
  ];
  function defaultTransformer() {
    const o = { n: 6, H: 1, chirality: 'alternate' };
    for (const q of TRANSFORMER_PARAMS) o[q.key] = q.value;
    return o;
  }

  // ---------------------------------------------------------------
  // The body: `cells` Kresling cells, a rigid shoulder plate on a weighted sled, a pitch hinge, and one
  // Kresling head cell. Modules are listed tail to head: 'k' = Kresling cell, 'p' = pitch hinge.
  // ---------------------------------------------------------------
  function buildTransformerPattern(p) {
    p = Object.assign(defaultTransformer(), p || {});
    const mods = []; for (let i = 0; i < p.cells; i++) mods.push('k'); mods.push('p', 'k');
    const n = p.n, H = p.H, phi = p.phi * DEG, R = 1, KNUCKLE = 1.9 * R, L = mods.length;
    // ring positions along the body, and each ring's rotation (alternating Kresling handedness)
    const xs = [0], rots = [0]; let kc = 0;
    for (let k = 0; k < L; k++) {
      xs.push(xs[k] + (mods[k] === 'k' ? H : KNUCKLE));
      if (mods[k] === 'k') { kc++; rots.push(p.chirality === 'same' ? kc * phi : (kc % 2 ? phi : 0)); } else rots.push(rots[k]);
    }
    const base = -PI / 2 + PI / n;
    const P = (k, j) => { const t = base + (2 * PI * j) / n + rots[k]; return [xs[k], R * Math.cos(t), R * Math.sin(t)]; };
    // the paper: an unrolled strip, with the hinge gap left empty
    const verts = [], vmap = [], id = (k, j) => k * (n + 1) + j;
    for (let k = 0; k <= L; k++) for (let j = 0; j <= n; j++) { verts.push([j, k]); vmap.push(k * n + (j % n)); }
    const faces = [], assigned = new Map(); let kk = 0;
    for (let k = 0; k < L; k++) {
      if (mods[k] !== 'k') continue;
      const pos = p.chirality === 'same' || kk++ % 2 === 0;
      for (let j = 0; j < n; j++) {
        if (pos) { faces.push([id(k, j), id(k, j + 1), id(k + 1, j + 1)], [id(k, j), id(k + 1, j + 1), id(k + 1, j)]); assigned.set(CL.ekey(id(k, j), id(k + 1, j + 1)), 'auto'); }
        else { faces.push([id(k, j), id(k, j + 1), id(k + 1, j)], [id(k, j + 1), id(k + 1, j + 1), id(k + 1, j)]); assigned.set(CL.ekey(id(k, j + 1), id(k + 1, j)), 'auto'); }
        assigned.set(CL.ekey(id(k, j), id(k + 1, j)), 'auto');
        if (k > 0) assigned.set(CL.ekey(id(k, j), id(k, j + 1)), 'auto');
      }
      assigned.set(CL.ekey(id(k, n), id(k + 1, n)), 'auto');
    }
    const edges = [], count = new Map();
    for (const f of faces) for (let s = 0; s < 3; s++) { const q = CL.ekey(f[s], f[(s + 1) % 3]); count.set(q, (count.get(q) || 0) + 1); }
    for (const [q, c] of count) { const [a, b] = q.split(',').map(Number); edges.push([a, b, assigned.get(q) || (c === 1 ? 'B' : 'F')]); }
    const pos3d = []; for (let k = 0; k <= L; k++) for (let j = 0; j < n; j++) pos3d.push(P(k, j));
    const rings = []; for (let k = 0; k <= L; k++) { const r = []; for (let j = 0; j < n; j++) r.push(k * n + j); rings.push(r); }
    // rigid plates: two hub points just off each plate's plane, braced to every corner
    const extraBars = [], hubs = [];
    for (let k = 0; k <= L; k++) {
      const ids = [];
      for (const off of [-0.12 * H, 0.12 * H]) { const i = pos3d.length; pos3d.push([xs[k] + off, 0, 0]); ids.push(i); for (const r of rings[k]) extraBars.push([i, r]); }
      extraBars.push([ids[0], ids[1]]); hubs.push(ids);
    }
    // the hinge: two pins on a horizontal axis, each braced rigidly to both plates, so the plates share
    // exactly one axis and can only pitch about it. Two short tendons (top and bottom) turn it.
    const joints = [];
    for (let k = 0; k < L; k++) {
      if (mods[k] !== 'p') continue;
      const xm = (xs[k] + xs[k + 1]) / 2, pins = [];
      for (const s of [1, -1]) {
        const i = pos3d.length; pos3d.push([xm, s * 0.95 * R, 0]); pins.push(i);
        for (const r of rings[k].concat(hubs[k], rings[k + 1], hubs[k + 1])) extraBars.push([i, r]);
      }
      // each tendon end is spread over its plate: a weighted mix of the corners, centred 0.85R from the axis
      const end = (kr, s) => {
        const ring = rings[kr], sc = ring.map((r) => Math.max(0, s * pos3d[r][2])), tot = sc.reduce((a, b) => a + b, 0);
        const lift = sc.map((v) => v / tot), off = lift.reduce((a, v, j) => a + v * s * pos3d[ring[j]][2], 0);
        const f = Math.min(1, 0.85 / off);
        return { nodes: ring, w: lift.map((v) => f * v + (1 - f) / ring.length) };
      };
      joints.push({ type: 'pitch', a: k, b: k + 1, pins, tendons: [{ side: 'top', a: end(k, 1), b: end(k + 1, 1) }, { side: 'bottom', a: end(k, -1), b: end(k + 1, -1) }] });
    }
    const shoulder = mods.indexOf('p');
    // option: a rigid head (a card box holding the camera) instead of a Kresling head cell
    if (p.head === 'rigid') {
      const ka = L - 1, kb = L, ids = rings[ka].concat(hubs[ka], rings[kb], hubs[kb]);
      for (let u = 0; u < ids.length; u++) for (let v = u + 1; v < ids.length; v++) extraBars.push([ids[u], ids[v]]);
    }
    // feet: a pad under the tail plate and the head plate, and a long sled under the shoulder (the battery tray)
    let zmin = Infinity; for (const q of pos3d) zmin = Math.min(zmin, q[2]);
    const footZ = zmin - 0.18 * R, feet = {};
    // the sled can reach further forward than back (p.sledRear / p.sledFront, in plate radii)
    const sledRear = (p.sledRear !== undefined ? p.sledRear : 1.5) * R, sledFront = (p.sledFront !== undefined ? p.sledFront : 1.5) * R;
    for (const [nm, k, aft, fore] of [['rear', 0, 0.45 * H, 0.45 * H], ['front', L, 0.45 * H, 0.45 * H], ['mid', shoulder, sledRear, sledFront]]) {
      const f = feet[nm] = { left: [], right: [], all: [] }, pad = [];
      for (const side of [1, -1]) for (const dx of [-aft, fore]) {
        const i = pos3d.length; pos3d.push([xs[k] + dx, side * 0.6 * R, footZ]);
        f[side > 0 ? 'left' : 'right'].push(i); f.all.push(i); pad.push(i);
        for (const r of rings[k].concat(hubs[k])) extraBars.push([i, r]);
      }
      for (let a = 0; a < pad.length; a++) for (let b = a + 1; b < pad.length; b++) extraBars.push([pad[a], pad[b]]);
    }
    for (const q of pos3d) q[2] -= footZ;
    // four body cables, as on the crawler, through an eyelet on every plate (the neck hinge included)
    const cables = [], eyeR = 0.72 * R * Math.cos(PI / n);
    for (const ang of [45, 135, 225, 315]) {
      const al = ang * DEG, eyes = [];
      for (let k = 0; k <= shoulder; k++) {
        const ring = rings[k], ts = ring.map((_, j) => base + (2 * PI * j) / n + rots[k]);
        let ja = 0, t = 0;
        for (let j = 0; j < n; j++) { let d = al - ts[j]; d = ((d % (2 * PI)) + 2 * PI) % (2 * PI); if (d <= (2 * PI) / n + 1e-12) { ja = j; t = d / ((2 * PI) / n); break; } }
        const jb = (ja + 1) % n, pa = P(k, ja), pb = P(k, jb);
        const ey = pa[1] + t * (pb[1] - pa[1]), ez = pa[2] + t * (pb[2] - pa[2]), sc = eyeR / Math.hypot(ey, ez);
        const w = new Array(n).fill((1 - sc) / n); w[ja] += sc * (1 - t); w[jb] += sc * t;
        eyes.push({ nodes: ring, w });
      }
      cables.push({ angle: al, eyes });
    }
    return {
      key: 'transformer', kind: 'robot', mods, params: p,
      cp: { verts, faces, edges }, vmap, pos3d, restFromPos: true, rings, lids: rings, cables, hubs, extraBars, joints, feet, shoulder,
      rear: rings[0].concat(feet.rear.all, hubs[0]), front: rings[L].concat(feet.front.all, hubs[L]),
      mid: rings[shoulder].concat(feet.mid.all, hubs[shoulder]),
    };
  }

  // ---------------------------------------------------------------
  // TransformerSim: the crawler sim plus a hinge (stiff frame, tendons, end stops), a battery, and pads
  // that can each be switched to grip.
  // ---------------------------------------------------------------
  const JOINT_STIFFNESS = 8; // hinge frames are plastic, eight times stiffer than the paper bars
  class TransformerSim extends CL.RobotSim {
    constructor(mesh) {
      super(mesh);
      const pat = mesh.pat;
      this.jointT = pat.joints.map(() => [0, 0]);
      this.tendonWork = 0;
      // hinge end stops: corresponding corners of the two plates can't come closer than 0.15
      this.stops = [];
      for (const J of pat.joints) pat.rings[J.a].forEach((a, j) => this.stops.push({ a, b: pat.rings[J.b][j], min: 0.15 }));
      // weight: the hub and pin points are construction helpers with no mass; the battery sits on the sled
      this.extraG = [];
      const helpers = new Set(pat.hubs.flat().concat(pat.joints.flatMap((J) => J.pins)));
      for (const i of helpers) this.extraG.push([i, -this.g]);
      this.setBattery(pat.params.battery);
      this.grips = { rear: false, mid: false, front: false };
      this.setFeet('scales');
    }
    setBattery(m) {
      const pat = this.mesh.pat, nodes = pat.feet.mid.all.concat(pat.hubs[pat.shoulder]);
      this.extraG = this.extraG.filter((e) => !e.battery);
      for (const i of nodes) this.extraG.push(Object.assign([i, m / nodes.length], { battery: true }));
    }
    setStiffness(a, f, fa) {
      super.setStiffness(a, f, fa);
      const pins = new Set(this.mesh.pat.joints.flatMap((J) => J.pins));
      for (const b of this.allBars) if (pins.has(b.i) || pins.has(b.j)) { b.k *= JOINT_STIFFNESS; b.c = 2 * this.zeta * Math.sqrt(b.k); }
      const nodeK = new Float64Array(this.N);
      for (const b of this.allBars) { nodeK[b.i] += b.k; nodeK[b.j] += b.k; }
      for (const h of this.hinges) for (const w of [h.w1, h.w2]) { const hh = this.wingHeight(w, h.h1, h.h2); if (hh > 1e-6) nodeK[w] += h.k / (hh * hh); }
      let kmax = 0; for (let i = 0; i < this.N; i++) kmax = Math.max(kmax, nodeK[i]);
      this.dt = Math.min(0.05, 0.7 / Math.sqrt(2 * kmax), 0.3 / Math.sqrt(this.kg || 120));
    }
    // feet are directional scales everywhere; any of the three pads can also be told to grip
    setGrips(g) {
      this.grips = Object.assign({ rear: false, mid: false, front: false }, g);
      const pat = this.mesh.pat;
      for (let i = 0; i < this.N; i++) { this.muF[i] = 0.12; this.muB[i] = 1.2; this.muS[i] = 0.8; }
      for (const end of ['rear', 'mid', 'front']) if (this.grips[end]) for (const i of pat[end]) this.muF[i] = this.muB[i] = this.muS[i] = 40;
    }
    setFeet(mode) { this.feet = 'scales'; if (this.grips) this.setGrips(this.grips); else super.setFeet('scales'); }
    plateAxis(k, xArr) {
      const x = xArr || this.x, h = this.mesh.pat.hubs[k];
      const v = [0, 1, 2].map((d) => x[3 * h[1] + d] - x[3 * h[0] + d]), l = Math.hypot(...v) || 1;
      return v.map((q) => q / l);
    }
    // signed neck angle in degrees: positive = head pitched up relative to the shoulder
    neckAngle(J) {
      J = J || this.mesh.pat.joints[0];
      const a = this.plateAxis(J.a), b = this.plateAxis(J.b);
      const pa = this.mesh.pat.joints[0].pins.map((i) => [0, 1, 2].map((d) => this.x[3 * i + d]));
      const ax = [pa[0][0] - pa[1][0], pa[0][1] - pa[1][1], pa[0][2] - pa[1][2]]; // pin axis (points left)
      const cr = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const s = -(cr[0] * ax[0] + cr[1] * ax[1] + cr[2] * ax[2]) / (Math.hypot(...ax) || 1);
      const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      return Math.atan2(s, c) / DEG;
    }
    head() { const pat = this.mesh.pat; return this.centroid(pat.rings[pat.rings.length - 1]); }
    // the camera sits at the centre of the head plate; the tip is the head plate's furthest corner
    cameraHeight() { return this.head()[2]; }
    tip() {
      const pat = this.mesh.pat, ring = pat.rings[pat.rings.length - 1], c = this.head(), ax = this.plateAxis(pat.rings.length - 1);
      return [c[0] + 0.6 * ax[0], c[1] + 0.6 * ax[1], c[2] + 0.6 * ax[2], ring];
    }
    forces() {
      super.forces();
      const x = this.x, f = this.f, pat = this.mesh.pat;
      for (const [i, g] of this.extraG) f[3 * i + 2] -= g;
      pat.joints.forEach((J, ji) => J.tendons.forEach((t, ti) => {
        const T = this.jointT[ji][ti]; if (!T) return;
        const pa = this.eyelet(t.a), pb = this.eyelet(t.b);
        const dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2], L = Math.hypot(dx, dy, dz) || 1e-9;
        const u = [(T * dx) / L, (T * dy) / L, (T * dz) / L];
        t.a.nodes.forEach((nd, q) => { for (let d = 0; d < 3; d++) f[3 * nd + d] += t.a.w[q] * u[d]; });
        t.b.nodes.forEach((nd, q) => { for (let d = 0; d < 3; d++) f[3 * nd + d] -= t.b.w[q] * u[d]; });
      }));
      for (const s of this.stops) {
        const i = 3 * s.a, j = 3 * s.b, dx = x[j] - x[i], dy = x[j + 1] - x[i + 1], dz = x[j + 2] - x[i + 2];
        const L = Math.hypot(dx, dy, dz) || 1e-9; if (L >= s.min) continue;
        const F = (300 * (s.min - L)) / L;
        f[i] -= F * dx; f[i + 1] -= F * dy; f[i + 2] -= F * dz; f[j] += F * dx; f[j + 1] += F * dy; f[j + 2] += F * dz;
      }
    }
    tendonLength(t) { const a = this.eyelet(t.a), b = this.eyelet(t.b); return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }
    step(nSteps) {
      nSteps = nSteps || 1;
      const pat = this.mesh.pat;
      for (let s = 0; s < nSteps; s++) {
        const before = pat.joints.map((J) => J.tendons.map((t) => this.tendonLength(t)));
        super.step(1);
        pat.joints.forEach((J, ji) => J.tendons.forEach((t, ti) => { const d = before[ji][ti] - this.tendonLength(t); if (d > 0) this.tendonWork += this.jointT[ji][ti] * d; }));
      }
    }
    totalWork() { return this.work + this.tendonWork; }
  }

  function buildTransformer(params, stiff) {
    const pat = buildTransformerPattern(params);
    const s = Object.assign({ axial: 50, fold: 0.12, facet: 0.12 }, stiff || {}, { SimClass: TransformerSim });
    const sim = CL.buildMesh(pat, s);
    sim.tensionScale = CL.tensionScaleFor(sim);
    sim.controller = new ModeController(sim);
    sim.controller.set('crawl', { hold: true });
    sim.step(Math.round(1.5 / sim.dt));
    sim.time = 0; sim.work = 0; sim.tendonWork = 0;
    sim.restLength = sim.length();
    return sim;
  }

  // ---------------------------------------------------------------
  // The mode library. Each mode is a set of targets: how hard the body cables pull, what angle the neck
  // servo holds, which pads grip, and (for Crawl) a gait. Switching modes blends the old targets into the
  // new ones; nothing jumps.
  // ---------------------------------------------------------------
  const MODES = {
    compact: {
      name: 'Compact', job: 'Stow', short: 'Folded short for carrying, storage or squeezing through an opening.',
      what: 'All four body cables pull hard and the neck locks straight. The Kresling cells collapse and twist shut.',
      contract: 1, tension: 1.2, neck: 0, grips: { rear: false, mid: false, front: false },
    },
    crawl: {
      name: 'Crawl', job: 'Move', short: 'Low and long, inching forward on directional scales.',
      what: 'The body cables pull and release (the inchworm gait) with the neck locked straight. The scales turn each stretch into forward motion.',
      gait: { phases: [{ dur: 3, contract: 1 }, { dur: 3, contract: 0 }] }, tension: 1.2, neck: 0, grips: { rear: false, mid: false, front: false },
    },
    tower: {
      name: 'Tower', job: 'Inspect', short: 'Head raised upright on the neck hinge, lifting the camera like a periscope.',
      what: 'The tail and the shoulder sled grip, the body cables go slack, and the neck servo pulls the head up to 85°.',
      contract: 0, tension: 1.2, neck: 85, grips: { rear: true, mid: true, front: false },
    },
    reach: {
      name: 'Reach', job: 'Intervene', short: 'Head held at a chosen angle so its tip can press, hook or nudge something ahead.',
      what: 'Same grips as Tower, but the neck servo holds the angle you set, so the tip of the head goes where you aim it.',
      contract: 0, tension: 1.2, neck: 40, grips: { rear: true, mid: true, front: false }, adjustable: true,
    },
  };

  // Neck servo: a PD controller on the hinge angle that drives the top tendon (up) or the bottom one (down).
  class ModeController {
    constructor(sim) { this.sim = sim; this.mode = null; this.t0 = 0; this.neckTarget = 0; this.contract = 0; this.cableLevel = 0; this.lastAngle = 0; this.I = 0; }
    set(key, opts) {
      opts = opts || {};
      const m = MODES[key]; if (!m) throw new Error('Unknown mode ' + key);
      this.mode = key; this.def = m; this.t0 = this.sim.time; this.I = 0; this.still = !!opts.still;
      this.neckTarget = m.adjustable && opts.neck !== undefined ? opts.neck : m.neck;
      this.sim.setGrips(m.grips);
      if (opts.hold) { this.cableLevel = m.contract || 0; }
      return this;
    }
    // cable command for the current mode at sim time t, in 0..1 of full pull
    bodyCommand(t) {
      const m = this.def;
      if (!m.gait) return m.contract;
      if (this.still) return 0;
      const ph = m.gait.phases, P = ph.reduce((a, q) => a + q.dur, 0);
      let u = ((t - this.t0) % P + P) % P, i = 0;
      while (u >= ph[i].dur) { u -= ph[i].dur; i++; }
      const prev = ph[(i - 1 + ph.length) % ph.length].contract, cur = ph[i].contract;
      const w = Math.min(1, u / Math.min(0.5, 0.35 * ph[i].dur)), s = w * w * (3 - 2 * w);
      return prev + (cur - prev) * s;
    }
    apply(dt) {
      const s = this.sim, m = this.def;
      // body cables: follow the command, rate-limited so a mode change blends over about half a second
      const want = this.bodyCommand(s.time);
      const rate = m.gait ? 1e9 : 2 * dt;
      this.cableLevel += Math.max(-rate, Math.min(rate, want - this.cableLevel));
      const T = this.cableLevel * (m.tension || 1) * s.tensionScale;
      for (let c = 0; c < s.cableT.length; c++) s.cableT[c] = T;
      // neck servo
      const th = s.neckAngle(), w = (th - this.lastAngle) / dt; this.lastAngle = th;
      const e = this.neckTarget - th;
      this.I = Math.max(-40, Math.min(40, this.I + e * dt));
      const hold = 6 * Math.cos(Math.max(0, th) * DEG); // feed-forward against the head's weight
      const u = 0.45 * e - 0.08 * w + 0.6 * this.I + (this.neckTarget > 2 ? hold : 0);
      const LOCK = 3, MAX = 24;
      s.jointT[0] = this.neckTarget <= 2 && Math.abs(th) < 6
        ? [LOCK, LOCK] // straight: both tendons snug, so the hinge is locked
        : [Math.max(0, Math.min(MAX, u)), Math.max(0, Math.min(MAX, -u))];
    }
  }

  // advance a transformer by T seconds of sim time under its controller
  function runFor(sim, T, each) {
    const end = sim.time + T;
    while (sim.time < end) {
      sim.controller.apply(sim.dt * 5);
      sim.step(5);
      if (!isFinite(sim.x[0])) throw new Error('The simulation became unstable.');
      if (each) each(sim);
    }
  }

  // shape measurements used by the mode cards and the mission report
  function measureShape(sim) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < sim.N; i++) for (let d = 0; d < 3; d++) { const v = sim.x[3 * i + d]; lo[d] = Math.min(lo[d], v); hi[d] = Math.max(hi[d], v); }
    const box = hi.map((h, d) => h - lo[d]);
    const tip = sim.tip ? sim.tip() : sim.centroid(sim.mesh.pat.rings[sim.mesh.pat.rings.length - 1]);
    return {
      length: sim.length(), footprint: box[0], height: box[2], box, volume: box[0] * box[1] * box[2],
      camera: sim.cameraHeight ? sim.cameraHeight() : sim.centroid(sim.mesh.pat.rings[sim.mesh.pat.rings.length - 1])[2],
      neck: sim.neckAngle ? sim.neckAngle() : 0, tip: [tip[0], tip[1], tip[2]], strain: sim.maxStrain(),
    };
  }

  // ---------------------------------------------------------------
  // A mission: deploy -> move -> inspect -> intervene -> recover, the sequence in the concept brief.
  // Each step reports time, actuator work and the number that step is for, next to what a fixed-form
  // crawler (the Move bench's robot, same size) manages.
  // ---------------------------------------------------------------
  const MISSION = [
    { key: 'deploy', mode: 'crawl', still: true, name: 'Deploy', what: 'Starts folded in Compact, then lets go: the creases spring the body back to crawl shape.', T: 8, from: 'compact' },
    { key: 'move', mode: 'crawl', name: 'Move', what: 'Inchworm gait toward the target, four cycles.', T: 24, cycles: 4 },
    { key: 'inspect', mode: 'tower', name: 'Inspect', what: 'Raise the camera on the neck.', T: 8 },
    { key: 'intervene', mode: 'reach', name: 'Intervene', what: 'Lower the head to 45° and hold its tip on a target ahead, above the floor.', T: 9, neck: 45 },
    { key: 'recover', mode: 'compact', name: 'Recover', what: 'Neck down, fold short for extraction.', T: 8 },
  ];

  function fixedFormBaseline(stiff) {
    // the plain crawler from the Move bench: as many cells as fit the same paper length, no neck
    const sim = CL.buildRobot(Object.assign(CL.defaultRobot(), { cells: 5 }), stiff);
    sim.tensionScale = CL.tensionScaleFor(sim);
    const rest = measureShape(sim);
    // crawl: inchworm with the same pull
    const gait = JSON.parse(JSON.stringify(CL.GAITS.inchworm)); gait.tension = 1.2;
    const r = CL.evaluateGait(Object.assign(CL.defaultRobot(), { cells: 5 }), gait, { cycles: 4, stiff });
    // compact: all cables at the same pull for 8 s
    const c = CL.buildRobot(Object.assign(CL.defaultRobot(), { cells: 5 }), stiff); c.tensionScale = CL.tensionScaleFor(c);
    c.setFeet('scales'); for (let i = 0; i < c.cableT.length; i++) c.cableT[i] = 1.2 * c.tensionScale;
    let t = 0; while (t < 8) { c.step(5); t += 5 * c.dt; }
    const compact = measureShape(c);
    return {
      restLength: rest.length, camera: rest.camera, cameraTop: rest.height, stowedLength: compact.length, stowedVolume: compact.volume,
      perCycle: r.perCycle * r.sim.bodyLength, reach: 0,
    };
  }

  function runMission(params, opts) {
    opts = Object.assign({ stiff: null, onFrame: null, baseline: true }, opts || {});
    const sim = buildTransformer(params, opts.stiff);
    const out = { steps: [], sim };
    const restShape = measureShape(sim);
    out.rest = restShape;
    for (const st of MISSION) {
      if (st.from) { sim.controller.set(st.from); runFor(sim, 6, opts.onFrame); }
      const t0 = sim.time, w0 = sim.totalWork(), c0 = sim.com();
      sim.controller.set(st.mode, { neck: st.neck, still: st.still });
      let settle = null; const series = [];
      runFor(sim, st.T, (s) => { series.push([s.time - t0, s.cameraHeight(), s.length(), s.neckAngle()]); if (opts.onFrame) opts.onFrame(s); });
      const shape = measureShape(sim), c1 = sim.com();
      // time to settle: when the step's key number first gets within 10% of where it ends up
      const idx = st.key === 'inspect' ? 1 : st.key === 'intervene' ? 3 : 2;
      const fin = series[series.length - 1][idx], start = series[0][idx], span = Math.abs(fin - start);
      if (st.key !== 'move' && span > 1e-3) for (const row of series) if (Math.abs(row[idx] - fin) <= 0.1 * span) { settle = row[0]; break; }
      out.steps.push({
        key: st.key, name: st.name, mode: st.mode, what: st.what, time: st.T, settle,
        work: sim.totalWork() - w0, shape, moved: c1[0] - c0[0], perCycle: st.cycles ? (c1[0] - c0[0]) / st.cycles : null, series,
      });
    }
    if (opts.baseline) out.baseline = fixedFormBaseline(opts.stiff);
    return out;
  }

  const API = { TRANSFORMER_PARAMS, defaultTransformer, buildTransformerPattern, TransformerSim, buildTransformer, MODES, ModeController, runFor, measureShape, MISSION, runMission, fixedFormBaseline };
  Object.assign(CL, API);
  if (typeof module !== 'undefined' && module.exports) module.exports = CL;
})(typeof window !== 'undefined' ? window : globalThis);
