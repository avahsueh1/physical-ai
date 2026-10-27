// ===== Crease Lab terrain: obstacles, slopes, slippery ground, sensors, save/restore =====
//
// Extends the Move bench's RobotSim so the crawler can be dropped into a course:
//   ground   piecewise-linear height along x (ramps / slopes)
//   patches  rectangles on the ground that scale friction (ice, oil, carpet)
//   boxes    oriented boxes (yaw about z): walls, ceilings, rubble
// Contacts are penalty springs along each surface normal, with Coulomb friction
// applied as a velocity impulse in the tangent plane, exactly like the flat-floor
// RobotSim but for any surface. Feet keep their directional scales on any
// up-facing surface (ground, ramp, top of a rock); walls and ceilings use plain friction.
//
// It also adds what a learning "mind" needs from the body:
//   sense()     range finders, tilt, wall contact, slip  (what a real robot could measure)
//   status()    strain, roll, progress, failure flags    (what the trainer needs to know)
//   snapshot()/restore()   rewind the world to try an action "in imagination"
//
// Works in the browser (window.CreaseLab) and in node (module.exports).
(function (root) {
  'use strict';
  const CL = typeof module !== 'undefined' && module.exports ? require('./motion.js') : root.CreaseLab;

  const MAST = 0.02;   // clearance sensor sits just above the body's peak height

  // ------------------------------------------------------------ terrain geometry
  function makeTerrain(spec) {
    spec = spec || {};
    const segs = (spec.ground && spec.ground.segments) || [];
    const patches = spec.patches || [];
    const boxes = (spec.boxes || []).map((b) => {
      const yaw = b.yaw || 0;
      return Object.assign({ mu: 0.35, kind: 'box' }, b, { c: Math.cos(yaw), s: Math.sin(yaw) });
    });
    // ground height and slope (dz/dx) at x
    function ground(x) {
      if (!segs.length) return { z: 0, dzdx: 0 };
      for (const g of segs) {
        if (x >= g.x0 && x <= g.x1) {
          const k = (g.z1 - g.z0) / Math.max(1e-9, g.x1 - g.x0);
          return { z: g.z0 + k * (x - g.x0), dzdx: k };
        }
      }
      if (x < segs[0].x0) return { z: segs[0].z0, dzdx: 0 };
      const last = segs[segs.length - 1];
      return { z: last.z1, dzdx: 0 };
    }
    // a patch scales friction (mu) and how well directional scales can bite (grip):
    // ice ~ {mu: 0.5, grip: 0.1}: low friction AND the bristles stop working
    function friction(x, y) {
      let m = 1, g = 1;
      for (const p of patches) if (x >= p.x0 && x <= p.x1 && y >= p.y0 && y <= p.y1) { m *= p.mu; g *= (p.grip == null ? 1 : p.grip); }
      return { m, g };
    }
    return { spec, ground, friction, boxes, patches };
  }

  // point-in-oriented-box: returns {pen, nx, ny, nz} for the shallowest way out, or null
  function boxContact(b, px, py, pz) {
    const dx = px - b.cx, dy = py - b.cy, dz = pz - b.cz;
    const lx = b.c * dx + b.s * dy, ly = -b.s * dx + b.c * dy, lz = dz;
    const ox = b.hx - Math.abs(lx), oy = b.hy - Math.abs(ly), oz = b.hz - Math.abs(lz);
    if (ox <= 0 || oy <= 0 || oz <= 0) return null;
    let pen, nlx = 0, nly = 0, nz = 0;
    if (ox <= oy && ox <= oz) { pen = ox; nlx = Math.sign(lx) || 1; }
    else if (oy <= oz) { pen = oy; nly = Math.sign(ly) || 1; }
    else { pen = oz; nz = Math.sign(lz) || 1; }
    return { pen, nx: b.c * nlx - b.s * nly, ny: b.s * nlx + b.c * nly, nz };
  }

  // ray vs oriented box (slab method in the box frame): distance or Infinity
  function rayBox(b, o, d) {
    const dx = o[0] - b.cx, dy = o[1] - b.cy, dz = o[2] - b.cz;
    const ol = [b.c * dx + b.s * dy, -b.s * dx + b.c * dy, dz];
    const dl = [b.c * d[0] + b.s * d[1], -b.s * d[0] + b.c * d[1], d[2]];
    const h = [b.hx, b.hy, b.hz];
    let t0 = -Infinity, t1 = Infinity;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dl[a]) < 1e-12) { if (Math.abs(ol[a]) > h[a]) return Infinity; continue; }
      let ta = (-h[a] - ol[a]) / dl[a], tb = (h[a] - ol[a]) / dl[a];
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return Infinity;
    }
    if (t1 < 0) return Infinity;
    return t0 >= 0 ? t0 : 0;
  }

  // --------------------------------------------------------------- the sim
  class TerrainSim extends CL.RobotSim {
    constructor(mesh) {
      super(mesh);
      const N = this.N;
      this.terrain = makeTerrain({});
      this.cnx = new Float64Array(N); this.cny = new Float64Array(N); this.cnz = new Float64Array(N);
      this.cup = new Uint8Array(N);           // 1 if the contact surface faces up (feet keep their scales)
      this.cmu = new Float64Array(N);         // friction multiplier at the contact
      this.cgrip = new Float64Array(N);       // how well directional scales bite (1 normal, ~0 on ice)
      this.wallForce = 0;                     // total force from non-floor contacts (a bump sensor)
      this.slip = 0;                          // mean foot sliding speed this step
    }
    setTerrain(spec) { this.terrain = makeTerrain(spec); }

    forces() {
      // bars + hinges (+ hand) from the base sim, then our own gravity / contact / cables
      CL.Sim.prototype.forces.call(this);
      const x = this.x, v = this.v, f = this.f, N = this.N, T = this.terrain;
      let wall = 0;
      for (let i = 0; i < N; i++) {
        const p = 3 * i, px = x[p], py = x[p + 1], pz = x[p + 2];
        f[p + 2] -= this.g;
        // ground (possibly sloped)
        const gr = T.ground(px);
        let best = null;
        const pen = gr.z - pz;
        if (pen > 0) {
          const nl = Math.hypot(gr.dzdx, 1);
          best = { pen: pen / nl, nx: -gr.dzdx / nl, ny: 0, nz: 1 / nl, up: 1 };
        }
        for (const b of T.boxes) {
          const c = boxContact(b, px, py, pz);
          if (c && (!best || c.pen > best.pen)) { best = c; best.up = c.nz > 0.7 ? 1 : 0; best.mu = b.mu; }
        }
        if (!best) { this.normal[i] = 0; continue; }
        const vn = v[p] * best.nx + v[p + 1] * best.ny + v[p + 2] * best.nz;
        let n = this.kg * best.pen - this.cg * vn;
        if (n < 0) n = 0;
        f[p] += n * best.nx; f[p + 1] += n * best.ny; f[p + 2] += n * best.nz;
        this.normal[i] = n;
        this.cnx[i] = best.nx; this.cny[i] = best.ny; this.cnz[i] = best.nz;
        this.cup[i] = best.up;
        if (best.up) { const fr = T.friction(px, py); this.cmu[i] = fr.m; this.cgrip[i] = fr.g; }
        else { this.cmu[i] = best.mu || 0.35; this.cgrip[i] = 1; }
        if (!best.up) wall += n;
      }
      this.wallForce = wall;
      // cables (same as RobotSim)
      const cab = this.mesh.pat.cables;
      for (let c = 0; c < cab.length; c++) {
        const Tn = this.cableT[c]; if (!Tn) continue;
        const eyes = cab[c].eyes;
        let pa = this.eyelet(eyes[0]);
        for (let q = 1; q < eyes.length; q++) {
          const pb = this.eyelet(eyes[q]);
          const dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
          const L = Math.hypot(dx, dy, dz) || 1e-9;
          const fx = (Tn * dx) / L, fy = (Tn * dy) / L, fz = (Tn * dz) / L;
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
      const feetIds = this.mesh.pat.feet.rear.all.concat(this.mesh.pat.feet.front.all);
      for (let s = 0; s < nSteps; s++) {
        const lenBefore = this.cableT.some((t) => t) ? this.mesh.pat.cables.map((c) => this.pathLength(c)) : null;
        this.forces();
        for (let i = 0; i < 3 * N; i++) v[i] += f[i] * dt;
        let mx = 0, my = 0, mz = 0;
        for (let i = 0; i < N; i++) { mx += v[3 * i]; my += v[3 * i + 1]; mz += v[3 * i + 2]; }
        mx /= N; my /= N; mz /= N;
        for (let i = 0; i < N; i++) {
          v[3 * i] -= damp * (v[3 * i] - mx); v[3 * i + 1] -= damp * (v[3 * i + 1] - my); v[3 * i + 2] -= damp * (v[3 * i + 2] - mz);
        }
        // Coulomb friction impulse in each contact's tangent plane
        const ax = this.axisVector();
        for (let i = 0; i < N; i++) {
          const nrm = this.normal[i]; if (!nrm) continue;
          const p = 3 * i, nx = this.cnx[i], ny = this.cny[i], nz = this.cnz[i];
          const vn = v[p] * nx + v[p + 1] * ny + v[p + 2] * nz;
          if (this.cup[i]) {
            // directional feet: body axis projected into the surface
            let hx = ax.dx, hy = ax.dy, hz = ax.dz;
            const hn = hx * nx + hy * ny + hz * nz; hx -= hn * nx; hy -= hn * ny; hz -= hn * nz;
            const hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
            const lx = ny * hz - nz * hy, ly = nz * hx - nx * hz, lz = nx * hy - ny * hx;
            let va = v[p] * hx + v[p + 1] * hy + v[p + 2] * hz, vl = v[p] * lx + v[p + 1] * ly + v[p + 2] * lz;
            const m = this.cmu[i], gr = this.cgrip[i];
            const mF = this.muF[i], mB = mF + gr * (this.muB[i] - mF);   // no grip -> scales act like plain
            const mua = (va > 0 ? mF : mB) * m;
            const da = mua * nrm * dt, dl = this.muS[i] * m * nrm * dt;
            va = Math.abs(va) <= da ? 0 : va - Math.sign(va) * da;
            vl = Math.abs(vl) <= dl ? 0 : vl - Math.sign(vl) * dl;
            v[p] = vn * nx + va * hx + vl * lx; v[p + 1] = vn * ny + va * hy + vl * ly; v[p + 2] = vn * nz + va * hz + vl * lz;
          } else {
            // walls / ceilings / rock sides: plain isotropic friction
            let tx = v[p] - vn * nx, ty = v[p + 1] - vn * ny, tz = v[p + 2] - vn * nz;
            const tl = Math.hypot(tx, ty, tz);
            const d = this.cmu[i] * nrm * dt;
            const sc = tl <= d ? 0 : (tl - d) / tl;
            v[p] = vn * nx + tx * sc; v[p + 1] = vn * ny + ty * sc; v[p + 2] = vn * nz + tz * sc;
          }
        }
        for (let i = 0; i < 3 * N; i++) x[i] += v[i] * dt;
        if (lenBefore) {
          const cab = this.mesh.pat.cables;
          for (let c = 0; c < cab.length; c++) { const d = lenBefore[c] - this.pathLength(cab[c]); if (d > 0) this.work += this.cableT[c] * d; }
        }
        this.time += dt;
      }
      // slip sensor: mean sliding speed of feet that touch something
      let sl = 0, nc = 0;
      for (const i of feetIds) if (this.normal[i]) { sl += Math.hypot(v[3 * i], v[3 * i + 1]); nc++; }
      this.slip = nc ? sl / nc : 0;
    }

    // --------------------------------------------------------- sensing
    frame() {
      const pat = this.mesh.pat, a = this.centroid(pat.rings[0]), b = this.centroid(pat.rings[pat.rings.length - 1]);
      const ax = this.axisVector();
      const yaw = Math.atan2(ax.dy, ax.dx), pitch = Math.atan2(ax.dz, Math.hypot(ax.dx, ax.dy));
      // roll from the front foot pad: left feet vs right feet height
      const ff = pat.feet.front, fr = pat.feet.rear;
      const zl = this.centroid(ff.left.concat(fr.left)), zr = this.centroid(ff.right.concat(fr.right));
      const dyw = Math.hypot(zl[0] - zr[0], zl[1] - zr[1]) || 1e-9;
      const roll = Math.atan2(zl[2] - zr[2], dyw);
      return { rear: a, front: b, yaw, pitch, roll, len: ax.len };
    }
    // cast a ray, return distance to the first box or the ground (capped)
    ray(o, d, maxR) {
      maxR = maxR || 5;
      let best = maxR;
      for (const b of this.terrain.boxes) { const t = rayBox(b, o, d); if (t < best) best = t; }
      // ground: march
      const step = 0.05;
      for (let t = 0; t < best; t += step) {
        const px = o[0] + d[0] * t, pz = o[2] + d[2] * t;
        if (pz < this.terrain.ground(px).z) { best = t; break; }
      }
      return best;
    }
    // what an onboard sensor suite could report (body frame, no world coordinates)
    sense() {
      const fr = this.frame(), cy = Math.cos(fr.yaw), sy = Math.sin(fr.yaw);
      const o = fr.front;
      const dirs = {
        fwd: [0, 0], fwdUp10: [0, 10], fwdUp: [0, 25], fwdDown: [0, -30], left30: [30, 0], right30: [-30, 0],
        left90: [90, 0], right90: [-90, 0], up: [0, 90],
        // tilted 12 deg down: on flat ground they just miss (hit at ~5.2), so any reading < 5 is
        // something sticking up out of the ground ahead (a boulder, an up-ramp)
        fwdLow: [0, -12], leftLow: [25, -12], rightLow: [-25, -12],
      };
      const R = {};
      for (const [k, [az, el]] of Object.entries(dirs)) {
        const a = az * Math.PI / 180, e = el * Math.PI / 180;
        const lx = Math.cos(e) * Math.cos(a), ly = Math.cos(e) * Math.sin(a), lz = Math.sin(e);
        const d = [cy * lx - sy * ly, sy * lx + cy * ly, lz];
        R[k] = this.ray(o, d, 5);
      }
      // "clearance" range finder: on a short mast, MAST above the highest point of the body, looking
      // straight ahead. Anything it sees is something the body would hit = a tunnel too low to enter.
      // Fixed mount: the sensor sits at the body's peak gait height (measured once when the robot
      // is built) above the ground under the front plate. A sensor that followed the live body
      // top flickered: the top bobs ~0.1 per cycle and is pushed down when it touches a lintel.
      const zg = this.terrain.ground(o[0]).z;
      R.clearance = this.ray([o[0], o[1], zg + this.mastHeight], [cy, sy, 0], 5);
      return {
        ranges: R, pitch: fr.pitch, roll: fr.roll, length: fr.len / this.bodyLength,
        wallForce: this.wallForce, slip: this.slip,
        cables: Array.from(this.cableT).map((t) => t / (this.tensionScale || 1)),
        anchors: [this.anchors.front ? 1 : 0, this.anchors.rear ? 1 : 0],
      };
    }
    // what the trainer needs (privileged): position, strain, failure flags
    status() {
      const fr = this.frame(), c = this.com();
      let maxStrain = 0, bad = false;
      for (const b of this.bars) {
        const i = 3 * b.i, j = 3 * b.j;
        const L = Math.hypot(this.x[j] - this.x[i], this.x[j + 1] - this.x[i + 1], this.x[j + 2] - this.x[i + 2]);
        const s = Math.abs(L / b.L0 - 1); if (s > maxStrain) maxStrain = s;
      }
      for (let i = 0; i < 3 * this.N; i++) if (!isFinite(this.x[i])) { bad = true; break; }
      let zmax = -Infinity; for (let i = 0; i < this.N; i++) zmax = Math.max(zmax, this.x[3 * i + 2]);
      return { com: c, front: fr.front, rear: fr.rear, yaw: fr.yaw, pitch: fr.pitch, roll: fr.roll, length: fr.len / this.bodyLength,
               maxStrain, wallForce: this.wallForce, height: zmax - this.terrain.ground(c[0]).z, time: this.time, work: this.work, nan: bad };
    }

    // ------------------------------------------------------- imagination
    snapshot() {
      return {
        x: Float64Array.from(this.x), v: Float64Array.from(this.v),
        theta: this.hinges.map((h) => h.theta), target: this.hinges.map((h) => h.target),
        cableT: Float64Array.from(this.cableT), anchors: Object.assign({}, this.anchors), feet: this.feet,
        time: this.time, work: this.work,
      };
    }
    restore(s) {
      this.x.set(s.x); this.v.set(s.v);
      this.hinges.forEach((h, k) => { h.theta = s.theta[k]; h.target = s.target[k]; });
      this.cableT.set(s.cableT); this.setFeet(s.feet, s.anchors);
      this.time = s.time; this.work = s.work;
    }
    nodes() { return Array.from(this.x); }
  }

  // build a crawler (optionally a co-designed body) that lives in a terrain
  function buildTerrainRobot(params, terrainSpec, stiff, pose) {
    const pat = CL.buildCrawlerPattern(Object.assign(CL.defaultRobot(), params || {}));
    const s = Object.assign({ axial: 50, fold: 0.12, facet: 0.12 }, stiff || {}, { SimClass: TerrainSim });
    const sim = CL.buildMesh(pat, s);
    sim.setTerrain(terrainSpec);
    // place it: start pose (x, y, yaw) and lift onto the local ground height
    pose = Object.assign({ x: 0, y: 0, yaw: 0 }, pose || {});
    const c = Math.cos(pose.yaw), sn = Math.sin(pose.yaw), z0 = sim.terrain.ground(pose.x).z;
    for (let i = 0; i < sim.N; i++) {
      const p = 3 * i, X = sim.x[p], Y = sim.x[p + 1];
      sim.x[p] = pose.x + c * X - sn * Y; sim.x[p + 1] = pose.y + sn * X + c * Y; sim.x[p + 2] += z0 + 0.02;
    }
    sim.tensionScale = CL.tensionScaleFor(sim);
    sim.setFeet('scales', { front: false, rear: false });
    sim.step(Math.round(1.5 / sim.dt));
    // clearance-sensor height: settled body top + the bob of a gait cycle (~0.05) + MAST
    let top = -Infinity;
    for (let i = 0; i < sim.N; i++) top = Math.max(top, sim.x[3 * i + 2]);
    sim.mastHeight = top - sim.terrain.ground(pose.x).z + 0.05 + MAST;
    sim.time = 0; sim.work = 0;
    return sim;
  }

  // cable tensions for a motion command (same rule as the Move bench's gait phases)
  //   contract 0..1, bend 0..1 toward dirDeg (0 = left, 180 = right, 90 = up)
  function applyCommand(sim, cmd) {
    const Tmax = sim.tensionScale * (cmd.tension == null ? 0.8 : cmd.tension);
    const dir = (cmd.dir || 0) * Math.PI / 180;
    for (let j = 0; j < sim.cableT.length; j++) {
      const a = sim.cableAngle[j];
      sim.cableT[j] = Tmax * Math.max(0, (cmd.contract || 0) + (cmd.bend || 0) * Math.cos(a - dir));
    }
    // anchors: false | true (both pads grip) | 'left' | 'right' (one pad grips: the body pivots on it)
    const feet = cmd.feet || 'scales';
    const norm = (a) => (a === 'left' || a === 'right' ? a : !!a);
    sim.setFeet(feet, { front: norm(cmd.front), rear: norm(cmd.rear) });
  }

  const API = { makeTerrain, boxContact, rayBox, TerrainSim, buildTerrainRobot, applyCommand };
  Object.assign(CL, API);
  if (typeof module !== 'undefined' && module.exports) module.exports = CL;
})(typeof window !== 'undefined' ? window : globalThis);
