// ===== Crease Lab motion: an origami crawler on the ground, motion primitives, gaits =====
(function (root) {
  'use strict';
  const CL = typeof module !== 'undefined' && module.exports ? require('./core.js') : root.CreaseLab;
  const PI = Math.PI, DEG = PI / 180;

  // ---------------------------------------------------------------
  // The robot body: Kresling cells with rigid ring plates, lying on its side.
  // Cables run along the body through an eyelet on every plate corner.
  // ---------------------------------------------------------------
  const ROBOT_PARAMS = [
    { key: 'cells', label: 'Cells', min: 2, max: 6, step: 1, value: 4, int: true },
    { key: 'n', label: 'Polygon sides', min: 4, max: 8, step: 1, value: 6, int: true },
    { key: 'H', label: 'Cell length', min: 0.6, max: 1.6, step: 0.01, value: 1.0, unit: 'cm' },
    { key: 'phi', label: 'Twist per cell', min: 20, max: 70, step: 0.5, value: 50, unit: '°' },
  ];
  function defaultRobot() {
    const o = { chirality: 'alternate' };
    for (const q of ROBOT_PARAMS) o[q.key] = q.value;
    return o;
  }

  function buildCrawlerPattern(p) {
    const n = p.n, L = p.cells, H = p.H, phi = p.phi * DEG, R = 1;
    const same = p.chirality === 'same';
    const rot = (k) => (same ? k * phi : (k % 2 ? phi : 0));
    const base = -PI / 2 + PI / n; // ring 0 rests on a flat edge
    const P = (k, j) => {
      const t = base + (2 * PI * j) / n + rot(k);
      // tower axis -> world x, cross-section in (y, z)
      return [k * H, R * Math.cos(t), R * Math.sin(t)];
    };
    const verts = [], vmap = [], id = (k, j) => k * (n + 1) + j;
    for (let k = 0; k <= L; k++) for (let j = 0; j <= n; j++) { verts.push([j, k]); vmap.push(k * n + (j % n)); }
    const faces = [], assigned = new Map();
    for (let k = 0; k < L; k++) {
      const pos = same || k % 2 === 0; // twist +phi on this cell
      for (let j = 0; j < n; j++) {
        if (pos) {
          faces.push([id(k, j), id(k, j + 1), id(k + 1, j + 1)], [id(k, j), id(k + 1, j + 1), id(k + 1, j)]);
          assigned.set(CL.ekey(id(k, j), id(k + 1, j + 1)), 'auto');
        } else {
          faces.push([id(k, j), id(k, j + 1), id(k + 1, j)], [id(k, j + 1), id(k + 1, j + 1), id(k + 1, j)]);
          assigned.set(CL.ekey(id(k, j + 1), id(k + 1, j)), 'auto');
        }
        assigned.set(CL.ekey(id(k, j), id(k + 1, j)), 'auto');
        if (k > 0) assigned.set(CL.ekey(id(k, j), id(k, j + 1)), 'auto');
      }
      assigned.set(CL.ekey(id(k, n), id(k + 1, n)), 'auto');
    }
    const edges = [];
    const count = new Map();
    for (const f of faces) for (let s = 0; s < 3; s++) { const kk = CL.ekey(f[s], f[(s + 1) % 3]); count.set(kk, (count.get(kk) || 0) + 1); }
    for (const [kk, c] of count) { const [a, b] = kk.split(',').map(Number); edges.push([a, b, assigned.get(kk) || (c === 1 ? 'B' : 'F')]); }
    const pos3d = [];
    for (let k = 0; k <= L; k++) for (let j = 0; j < n; j++) pos3d.push(P(k, j));
    const rings = [];
    for (let k = 0; k <= L; k++) { const r = []; for (let j = 0; j < n; j++) r.push(k * n + j); rings.push(r); }
    // each plate is a thick rigid disc: two hub points just off its plane, braced to every corner
    // (a flat ring of bars alone can warp out of plane for free)
    const extraBars = [], hubs = [];
    for (let k = 0; k <= L; k++) {
      const ids = [];
      for (const off of [-0.12 * H, 0.12 * H]) {
        const id = pos3d.length; pos3d.push([k * H + off, 0, 0]); ids.push(id);
        for (const r of rings[k]) extraBars.push([id, r]);
      }
      extraBars.push([ids[0], ids[1]]);
      hubs.push(ids);
    }
    // a foot pad under each end plate: four contact points (left/right, fore/aft), braced to the plate
    let zmin = Infinity; for (const q of pos3d) zmin = Math.min(zmin, q[2]);
    const footZ = zmin - 0.18 * R, feet = { rear: { left: [], right: [], all: [] }, front: { left: [], right: [], all: [] } };
    for (const [end, k] of [['rear', 0], ['front', L]]) {
      const pad = [];
      for (const side of [1, -1]) for (const dx of [-0.45 * H, 0.45 * H]) {
        const id = pos3d.length;
        pos3d.push([k * H + dx, side * 0.6 * R, footZ]);
        feet[end][side > 0 ? 'left' : 'right'].push(id); feet[end].all.push(id); pad.push(id);
        for (const r of rings[k].concat(hubs[k])) extraBars.push([id, r]);
      }
      for (let a = 0; a < pad.length; a++) for (let b = a + 1; b < pad.length; b++) extraBars.push([pad[a], pad[b]]);
    }
    for (const q of pos3d) q[2] -= footZ;
    // four cables at fixed angles around the axis (upper-left, upper-right, lower-right, lower-left).
    // Each passes an eyelet on every plate; the eyelet is a fixed weighted mix of that plate's corners.
    const cables = [];
    const eyeR = 0.72 * R * Math.cos(PI / n);
    for (const ang of [45, 135, 225, 315]) {
      const al = ang * DEG, eyes = [];
      for (let k = 0; k <= L; k++) {
        const ring = rings[k];
        const ts = ring.map((_, j) => base + (2 * PI * j) / n + rot(k));
        // bracketing corners a, b around angle al
        let ja = 0, t = 0;
        for (let j = 0; j < n; j++) {
          const t0 = ts[j], t1 = t0 + (2 * PI) / n;
          let d = al - t0; d = ((d % (2 * PI)) + 2 * PI) % (2 * PI);
          if (d <= (2 * PI) / n + 1e-12) { ja = j; t = d / ((2 * PI) / n); break; }
        }
        const jb = (ja + 1) % n;
        const pa = P(k, ja), pb = P(k, jb);
        const ey = pa[1] + t * (pb[1] - pa[1]), ez = pa[2] + t * (pb[2] - pa[2]);
        const sc = eyeR / Math.hypot(ey, ez);
        const w = new Array(n).fill((1 - sc) / n);
        w[ja] += sc * (1 - t); w[jb] += sc * t;
        eyes.push({ nodes: ring, w });
      }
      cables.push({ angle: al, eyes });
    }
    return {
      key: 'crawler', kind: 'robot',
      cp: { verts, faces, edges }, vmap, pos3d, restFromPos: true,
      rings, lids: rings, cables, front: rings[L].concat(feet.front.all, hubs[L]), rear: rings[0].concat(feet.rear.all, hubs[0]), feet, hubs, extraBars,
    };
  }

  // ---------------------------------------------------------------
  // RobotSim: the bar-and-hinge sim plus gravity, a ground plane with
  // Coulomb friction (directional or switchable), and cables.
  // ---------------------------------------------------------------
  const FEET = {
    scales: { label: 'Directional scales', blurb: 'Every contact slides forward easily and grips backward, like the bristles on a ski skin.' },
    anchors: { label: 'Switchable anchors', blurb: 'Plates at each end can grip on command (think suction or electroadhesion). Everything else slides.' },
    plain: { label: 'Plain paper', blurb: 'Same friction in every direction. Shows why a symmetric body cannot crawl by stretching alone.' },
  };

  class RobotSim extends CL.Sim {
    constructor(mesh) {
      super(mesh);
      const N = this.N, pat = mesh.pat;
      this.g = 0.15;           // gravity per node
      this.kg = 120;          // ground stiffness
      this.cg = 2 * Math.sqrt(this.kg);
      this.normal = new Float64Array(N);
      this.muF = new Float64Array(N); this.muB = new Float64Array(N); this.muS = new Float64Array(N);
      this.cableT = new Float64Array(pat.cables.length);
      this.anchors = { front: false, rear: false };
      this.slideMu = 0.04;
      this.feet = 'scales';
      this.damping = 1;       // internal (relative-velocity) damping
      this.work = 0;
      // cable angle around the body axis, measured on the rear plate (0 = left, 90 = up)
      this.cableAngle = pat.cables.map((c) => c.angle);
      this.cableLen = pat.cables.map((c) => this.pathLength(c));
      this.cableRest = this.cableLen.slice();
      this.setFeet('scales');
      this.bodyLength = this.axisVector(mesh.x0).len;
      this.trail = [];
    }
    setStiffness(a, f, fa) {
      super.setStiffness(a, f, fa);
      this.dt = Math.min(this.dt, 0.3 / Math.sqrt(this.kg || 120));
    }
    setFeet(mode, anchors) {
      this.feet = mode;
      if (anchors) this.anchors = Object.assign({}, anchors);
      const pat = this.mesh.pat, N = this.N;
      for (let i = 0; i < N; i++) {
        if (mode === 'scales') { this.muF[i] = 0.12; this.muB[i] = 1.2; this.muS[i] = 0.8; }
        else if (mode === 'anchors') { this.muF[i] = this.muB[i] = this.muS[i] = this.slideMu; }
        else { this.muF[i] = this.muB[i] = this.muS[i] = 0.6; }
      }
      if (mode === 'anchors') {
        // an anchor is true (both pads grip), 'left' or 'right' (one pad grips, so the body pivots on it)
        const grip = (end, how) => {
          if (!how) return;
          const f = pat.feet[end];
          const ids = how === 'left' ? f.left : how === 'right' ? f.right : pat[end];
          for (const i of ids) this.muF[i] = this.muB[i] = this.muS[i] = 40;
        };
        grip('front', this.anchors.front);
        grip('rear', this.anchors.rear);
      }
    }
    eyelet(e, xArr) {
      const x = xArr || this.x, p = [0, 0, 0];
      for (let q = 0; q < e.nodes.length; q++) { const i = 3 * e.nodes[q], w = e.w[q]; p[0] += w * x[i]; p[1] += w * x[i + 1]; p[2] += w * x[i + 2]; }
      return p;
    }
    pathLength(c, xArr) {
      let s = 0, prev = this.eyelet(c.eyes[0], xArr);
      for (let q = 1; q < c.eyes.length; q++) { const p = this.eyelet(c.eyes[q], xArr); s += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]); prev = p; }
      return s;
    }
    centroid(g, xArr) {
      const x = xArr || this.x, c = [0, 0, 0];
      for (const i of g) for (let d = 0; d < 3; d++) c[d] += x[3 * i + d] / g.length;
      return c;
    }
    axisVector(xArr) {
      const pat = this.mesh.pat, a = this.centroid(pat.rear, xArr), b = this.centroid(pat.front, xArr);
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      return { dx, dy, dz, len: Math.hypot(dx, dy, dz) };
    }
    com() { const c = [0, 0, 0]; for (let i = 0; i < this.N; i++) for (let d = 0; d < 3; d++) c[d] += this.x[3 * i + d] / this.N; return c; }
    heading() { const a = this.axisVector(); return Math.atan2(a.dy, a.dx); }
    length() { return this.axisVector().len; }
    forces() {
      super.forces();
      const x = this.x, v = this.v, f = this.f, N = this.N;
      // gravity and ground normal force
      for (let i = 0; i < N; i++) {
        const p = 3 * i;
        f[p + 2] -= this.g;
        const z = x[p + 2];
        if (z < 0) {
          let n = -this.kg * z - this.cg * v[p + 2];
          if (n < 0) n = 0;
          f[p + 2] += n; this.normal[i] = n;
        } else this.normal[i] = 0;
      }
      // cables through eyelets: each straight run pulls its two ends together
      const cab = this.mesh.pat.cables;
      for (let c = 0; c < cab.length; c++) {
        const T = this.cableT[c]; if (!T) continue;
        const eyes = cab[c].eyes;
        let pa = this.eyelet(eyes[0]);
        for (let q = 1; q < eyes.length; q++) {
          const pb = this.eyelet(eyes[q]);
          const dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
          const L = Math.hypot(dx, dy, dz) || 1e-9;
          const fx = (T * dx) / L, fy = (T * dy) / L, fz = (T * dz) / L;
          const A = eyes[q - 1], B = eyes[q];
          for (let r = 0; r < A.nodes.length; r++) { const i = 3 * A.nodes[r], w = A.w[r]; f[i] += w * fx; f[i + 1] += w * fy; f[i + 2] += w * fz; }
          for (let r = 0; r < B.nodes.length; r++) { const i = 3 * B.nodes[r], w = B.w[r]; f[i] -= w * fx; f[i + 1] -= w * fy; f[i + 2] -= w * fz; }
          pa = pb;
        }
      }
    }
    step(nSteps) {
      nSteps = nSteps || 1;
      const x = this.x, v = this.v, f = this.f, N = this.N, dt = this.dt;
      const damp = 1 - Math.exp(-this.damping * dt);
      for (let s = 0; s < nSteps; s++) {
        const lenBefore = this.cableT.some((t) => t) ? this.mesh.pat.cables.map((c) => this.pathLength(c)) : null;
        this.forces();
        for (let i = 0; i < 3 * N; i++) v[i] += f[i] * dt;
        // internal damping: pull every velocity toward the body's mean velocity (keeps momentum)
        let mx = 0, my = 0, mz = 0;
        for (let i = 0; i < N; i++) { mx += v[3 * i]; my += v[3 * i + 1]; mz += v[3 * i + 2]; }
        mx /= N; my /= N; mz /= N;
        for (let i = 0; i < N; i++) {
          v[3 * i] -= damp * (v[3 * i] - mx); v[3 * i + 1] -= damp * (v[3 * i + 1] - my); v[3 * i + 2] -= damp * (v[3 * i + 2] - mz);
        }
        // Coulomb friction as a velocity-level impulse, split along / across the body axis
        const ax = this.axisVector(); let hx = ax.dx, hy = ax.dy; const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
        const lx = -hy, ly = hx;
        for (let i = 0; i < N; i++) {
          const nrm = this.normal[i]; if (!nrm) continue;
          const p = 3 * i;
          let va = v[p] * hx + v[p + 1] * hy, vl = v[p] * lx + v[p + 1] * ly;
          const mua = va > 0 ? this.muF[i] : this.muB[i];
          const da = mua * nrm * dt, dl = this.muS[i] * nrm * dt;
          va = Math.abs(va) <= da ? 0 : va - Math.sign(va) * da;
          vl = Math.abs(vl) <= dl ? 0 : vl - Math.sign(vl) * dl;
          v[p] = va * hx + vl * lx; v[p + 1] = va * hy + vl * ly;
        }
        for (let i = 0; i < 3 * N; i++) x[i] += v[i] * dt;
        if (lenBefore) {
          const cab = this.mesh.pat.cables;
          for (let c = 0; c < cab.length; c++) { const d = lenBefore[c] - this.pathLength(cab[c]); if (d > 0) this.work += this.cableT[c] * d; }
        }
        this.time += dt;
      }
    }
  }

  function buildRobot(params, stiff) {
    const pat = buildCrawlerPattern(params);
    const s = Object.assign({ axial: 50, fold: 0.12, facet: 0.12 }, stiff || {}, { SimClass: RobotSim });
    const sim = CL.buildMesh(pat, s);
    // let it settle under gravity before anything moves
    sim.step(Math.round(1.5 / sim.dt));
    sim.time = 0; sim.work = 0;
    return sim;
  }

  // ---------------------------------------------------------------
  // Motion primitives and gaits.
  // A phase sets the cable pattern and the anchors. Cable tension:
  //   T_j = Tmax * max(0, contract + bend * cos(angle_j - dir))
  // ---------------------------------------------------------------
  const PRIMITIVES = [
    { key: 'contract', name: 'Contract', what: 'All cables pull together. The cells shorten, and each Kresling cell twists as it does.', control: 'contract' },
    { key: 'bend', name: 'Bend', what: 'Cables on one side pull harder. That side shortens and the body curls toward it. Steering comes from this.', control: 'bend' },
    { key: 'twist', name: 'Twist', what: 'With every cell twisting the same way, shortening also screws the front plate around the axis.', control: 'chirality' },
    { key: 'anchor', name: 'Anchor', what: 'Change friction at a plate so it either holds the ground or slides. This decides which end moves.', control: 'feet' },
    { key: 'release', name: 'Release', what: 'Slack cables let the creases spring the body back to its rest length. The return stroke is free.', control: 'contract' },
  ];

  const GAITS = {
    inchworm: {
      name: 'Inchworm', feet: 'scales', tension: 0.8,
      blurb: 'Contract, release, repeat. Directional scales turn the symmetric stretch into forward motion: the head slides when the body extends, the tail slides when it contracts.',
      phases: [
        { dur: 3, contract: 1, bend: 0, dir: 0, front: false, rear: false },
        { dur: 3, contract: 0, bend: 0, dir: 0, front: false, rear: false },
      ],
    },
    twoAnchor: {
      name: 'Two-anchor crawl', feet: 'anchors', tension: 0.8,
      blurb: 'Grip the head and contract to drag the tail up, then grip the tail and release to push the head out. Works on any surface because the robot chooses which end holds.',
      phases: [
        { dur: 3, contract: 1, bend: 0, dir: 0, front: true, rear: false },
        { dur: 3, contract: 0, bend: 0, dir: 0, front: false, rear: true },
      ],
    },
    turnLeft: {
      name: 'Turn left', feet: 'anchors', tension: 0.8,
      blurb: 'Grip the head and contract, then grip the tail and release while the left cables stay tight. The head comes out curved, so each cycle swings the heading a few degrees.',
      phases: [
        { dur: 3, contract: 1, bend: 0, dir: 0, front: true, rear: false },
        { dur: 3, contract: 0, bend: 0.9, dir: 0, front: false, rear: true },
      ],
    },
    turnRight: {
      name: 'Turn right', feet: 'anchors', tension: 0.8,
      blurb: 'The mirror image: the right cables stay tight while the head extends.',
      phases: [
        { dur: 3, contract: 1, bend: 0, dir: 0, front: true, rear: false },
        { dur: 3, contract: 0, bend: 0.9, dir: 180, front: false, rear: true },
      ],
    },
    plainStretch: {
      name: 'Stretch on plain paper', feet: 'plain', tension: 0.8,
      blurb: 'The inchworm cycle with no friction trick. Each end slides back and forth by the same amount, so the body goes nowhere.',
      phases: [
        { dur: 3, contract: 1, bend: 0, dir: 0, front: false, rear: false },
        { dur: 3, contract: 0, bend: 0, dir: 0, front: false, rear: false },
      ],
    },
  };

  function cablePattern(sim, ph, Tmax) {
    return sim.cableAngle.map((a) => Tmax * Math.max(0, ph.contract + ph.bend * Math.cos(a - ph.dir * DEG)));
  }

  class GaitPlayer {
    constructor(gait) { this.gait = gait; this.t = 0; this.prev = null; this.idx = -1; }
    period() { return this.gait.phases.reduce((s, p) => s + p.dur, 0); }
    phaseAt(t) {
      const P = this.period(); let u = ((t % P) + P) % P;
      for (let i = 0; i < this.gait.phases.length; i++) { const d = this.gait.phases[i].dur; if (u < d) return { i, u, d }; u -= d; }
      return { i: this.gait.phases.length - 1, u: 0, d: 1 };
    }
    apply(sim, t) {
      const g = this.gait, ph = this.phaseAt(t), cur = g.phases[ph.i];
      const prev = g.phases[(ph.i - 1 + g.phases.length) % g.phases.length];
      const Tmax = (g.tension || 1) * sim.tensionScale;
      const a = cablePattern(sim, prev, Tmax), b = cablePattern(sim, cur, Tmax);
      const ramp = Math.min(0.5, 0.35 * ph.d), w = Math.min(1, ph.u / ramp);
      const s = w * w * (3 - 2 * w);
      for (let c = 0; c < a.length; c++) sim.cableT[c] = a[c] + (b[c] - a[c]) * s;
      if (g.feet !== sim.feet || ph.i !== this.idx) sim.setFeet(g.feet, { front: cur.front || false, rear: cur.rear || false });
      this.idx = ph.i;
      return ph;
    }
  }

  // run a gait for a number of cycles and report how the robot moved
  function evaluateGait(params, gait, opts) {
    opts = Object.assign({ cycles: 3, stiff: null }, opts || {});
    const sim = buildRobot(params, opts.stiff);
    sim.tensionScale = tensionScaleFor(sim);
    const player = new GaitPlayer(gait);
    const P = player.period();
    // first cycle is a warm-up
    let t = 0;
    const run = (T) => { while (t < T) { player.apply(sim, t); sim.step(5); t += 5 * sim.dt; } };
    run(P);
    const c0 = sim.com(), h0 = sim.heading(), w0 = sim.work, t0 = t;
    let path = [[c0[0], c0[1]]];
    for (let k = 0; k < opts.cycles; k++) { run(P * (k + 2)); const c = sim.com(); path.push([c[0], c[1]]); }
    const c1 = sim.com(), h1 = sim.heading();
    const dx = c1[0] - c0[0], dy = c1[1] - c0[1];
    const fwd = dx * Math.cos(h0) + dy * Math.sin(h0);
    let dh = h1 - h0; while (dh > PI) dh -= 2 * PI; while (dh < -PI) dh += 2 * PI;
    const work = sim.work - w0, T = t - t0;
    const weight = sim.g * sim.N;
    return {
      sim, path,
      speed: fwd / T,                      // cm per second along the starting heading
      perCycle: fwd / opts.cycles / sim.bodyLength, // body lengths per cycle
      turn: dh / DEG / opts.cycles,        // degrees per cycle
      cot: Math.abs(fwd) > 1e-4 ? work / (weight * Math.abs(fwd)) : Infinity,
      work, time: T,
    };
  }

  // tension that shortens the body by roughly a third at full contraction
  function tensionScaleFor(sim) { return 3.2 * Math.sqrt(sim.opts.fold / 0.12); }

  const GAIT_OBJECTIVES = [
    { key: 'speed', label: 'Crawl fastest', hint: 'Body lengths gained per cycle along the starting heading.', score: (r) => r.perCycle },
    { key: 'turn', label: 'Turn tightest (left)', hint: 'Degrees of heading change per cycle, counter-clockwise.', score: (r) => r.turn / 30 },
    { key: 'efficient', label: 'Cheapest distance', hint: 'Forward progress minus a charge for cable work (cost of transport).', score: (r) => r.perCycle - 0.02 * Math.min(r.cot, 200) },
  ];

  // optimisation over the phase timings and cable levels of a gait
  function makeGaitProblem(params, gait, objKey, stiff) {
    const obj = GAIT_OBJECTIVES.find((o) => o.key === objKey);
    const fields = [];
    gait.phases.forEach((ph, i) => {
      fields.push({ i, key: 'dur', min: 0.5, max: 3.5, label: `Phase ${i + 1} time` });
      fields.push({ i, key: 'contract', min: 0, max: 1, label: `Phase ${i + 1} contract` });
      fields.push({ i, key: 'bend', min: 0, max: 1, label: `Phase ${i + 1} bend` });
    });
    const decode = (u) => {
      const g = JSON.parse(JSON.stringify(gait));
      fields.forEach((f, k) => { const c = Math.max(0, Math.min(1, u[k])); g.phases[f.i][f.key] = +(f.min + c * (f.max - f.min)).toFixed(3); });
      return g;
    };
    const encode = (g) => fields.map((f) => (g.phases[f.i][f.key] - f.min) / (f.max - f.min));
    const evaluate = (u) => {
      const g = decode(u);
      let pen = 0; for (const v of u) pen += Math.max(0, -v) + Math.max(0, v - 1);
      let r;
      try { r = evaluateGait(params, g, { cycles: 2, stiff }); r.score = obj.score(r); if (!isFinite(r.score)) r.score = -5; }
      catch (e) { r = { score: -5 }; }
      r.gait = g; r.fitness = -r.score + 5 * pen;
      return r;
    };
    return { dims: fields.length, fields, decode, encode, evaluate, obj };
  }

  // Gym-style environment for learning locomotion directly from cable commands
  class CrawlerEnv {
    constructor(params, opts) {
      this.params = Object.assign(defaultRobot(), params || {});
      this.opts = Object.assign({ feet: 'anchors', substeps: 10, maxSteps: 400, stiff: null }, opts || {});
    }
    reset() {
      this.sim = buildRobot(this.params, this.opts.stiff);
      this.sim.tensionScale = tensionScaleFor(this.sim);
      this.sim.setFeet(this.opts.feet, { front: false, rear: false });
      this.t = 0; this.last = this.sim.com();
      return this.observe();
    }
    get actionSize() { return this.sim.cableT.length + 2; }
    observe() {
      const s = this.sim, pat = s.mesh.pat, c = s.com(), h = s.heading(), ch = Math.cos(h), sh = Math.sin(h);
      const o = [];
      for (const r of pat.rings) { const p = s.centroid(r); const dx = p[0] - c[0], dy = p[1] - c[1]; o.push(dx * ch + dy * sh, -dx * sh + dy * ch, p[2]); }
      for (let i = 0; i < s.cableT.length; i++) o.push(s.cableT[i] / s.tensionScale);
      o.push(s.anchors.front ? 1 : 0, s.anchors.rear ? 1 : 0);
      return Float32Array.from(o);
    }
    // action: [cable_0 .. cable_n-1 in 0..1, frontAnchor 0/1, rearAnchor 0/1]
    step(action) {
      const s = this.sim, n = s.cableT.length;
      for (let i = 0; i < n; i++) s.cableT[i] = Math.max(0, Math.min(1, action[i] || 0)) * s.tensionScale;
      s.setFeet(this.opts.feet, { front: action[n] > 0.5, rear: action[n + 1] > 0.5 });
      const h = s.heading();
      s.step(this.opts.substeps);
      this.t++;
      const c = s.com();
      const fwd = (c[0] - this.last[0]) * Math.cos(h) + (c[1] - this.last[1]) * Math.sin(h);
      this.last = c;
      const bad = !isFinite(c[0]);
      return { obs: this.observe(), reward: bad ? -10 : fwd / (this.opts.substeps * s.dt), done: bad || this.t >= this.opts.maxSteps, info: { com: c } };
    }
  }

  const API = { ROBOT_PARAMS, defaultRobot, buildCrawlerPattern, RobotSim, buildRobot, FEET, PRIMITIVES, GAITS, GaitPlayer, evaluateGait, tensionScaleFor, GAIT_OBJECTIVES, makeGaitProblem, CrawlerEnv };
  Object.assign(CL, API);
  if (typeof module !== 'undefined' && module.exports) module.exports = CL;
})(typeof window !== 'undefined' ? window : globalThis);
