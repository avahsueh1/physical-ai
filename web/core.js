// ===== Crease Lab core: patterns, bar-and-hinge simulator, FOLD, CMA-ES, env =====
// Works in the browser (attaches to window.CreaseLab) and in node (module.exports).
(function (root) {
  'use strict';
  const PI = Math.PI;
  const DEG = PI / 180;

  // ---------- small helpers ----------
  const ekey = (a, b) => (a < b ? a + ',' + b : b + ',' + a);
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * PI * v);
  }

  // =====================================================================
  // Crease patterns.
  // Each builder returns a "cp" (the flat drawing) plus how it maps to the sim:
  //   cp.verts  : [[x,y]]          flat coordinates
  //   cp.faces  : [[a,b,c]]        triangles, counter-clockwise (front = +z)
  //   cp.edges  : [[a,b,asg]]      asg in M V F B  (F = flat facet line)
  //   vmap      : cp vertex -> sim vertex (seams merge vertices)
  //   pos3d     : optional initial 3D positions for sim vertices (else flat)
  //   restFromPos: rest lengths / angles taken from pos3d instead of the flat sheet
  // =====================================================================

  function triEdges(faces, assigned) {
    // collect all edges of a triangle list; return [[a,b,asg]] using `assigned` map, else F/B
    const count = new Map();
    for (const f of faces) for (let s = 0; s < 3; s++) {
      const k = ekey(f[s], f[(s + 1) % 3]);
      count.set(k, (count.get(k) || 0) + 1);
    }
    const out = [];
    for (const [k, c] of count) {
      const [a, b] = k.split(',').map(Number);
      out.push([a, b, assigned.get(k) || (c === 1 ? 'B' : 'F')]);
    }
    return out;
  }

  function quadTris(a, b, c, d, verts) {
    // quad a-b-c-d (ccw) -> two triangles along the shorter diagonal
    const d1 = Math.hypot(verts[a][0] - verts[c][0], verts[a][1] - verts[c][1]);
    const d2 = Math.hypot(verts[b][0] - verts[d][0], verts[b][1] - verts[d][1]);
    return d1 <= d2 ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
  }

  const PATTERNS = {
    miura: {
      name: 'Miura-ori',
      kind: 'sheet',
      stiffness: { axial: 50, fold: 0.7, facet: 1.5 },
      blurb: 'Rigid-foldable zigzag tessellation. One degree of freedom: pull two corners and the whole sheet collapses. Used for solar arrays and deployable panels.',
      params: [
        { key: 'cols', label: 'Columns', min: 2, max: 10, step: 1, value: 4, int: true },
        { key: 'rows', label: 'Rows', min: 2, max: 10, step: 1, value: 4, int: true },
        { key: 'a', label: 'Panel width', min: 0.4, max: 2, step: 0.01, value: 1, unit: 'cm' },
        { key: 'b', label: 'Zigzag edge', min: 0.4, max: 2, step: 0.01, value: 1, unit: 'cm' },
        { key: 'gamma', label: 'Sector angle', min: 35, max: 85, step: 0.5, value: 60, unit: '°' },
      ],
      build(p) {
        const m = p.cols, n = p.rows, g = p.gamma * DEG;
        const h = p.b * Math.sin(g), s = p.b * Math.cos(g), w = p.a;
        const verts = [], id = (i, j) => j * (m + 1) + i;
        for (let j = 0; j <= n; j++) for (let i = 0; i <= m; i++)
          verts.push([i * w + (j % 2 ? s : 0), j * h]);
        const assigned = new Map();
        // zigzag lines (constant i): whole line shares one assignment, alternating by column
        for (let i = 1; i < m; i++) for (let j = 0; j < n; j++)
          assigned.set(ekey(id(i, j), id(i, j + 1)), i % 2 ? 'M' : 'V');
        // straight lines (constant j): alternate segment by segment, offset by row
        for (let j = 1; j < n; j++) for (let i = 0; i < m; i++)
          assigned.set(ekey(id(i, j), id(i + 1, j)), (i + j) % 2 ? 'V' : 'M');
        const faces = [];
        for (let j = 0; j < n; j++) for (let i = 0; i < m; i++)
          faces.push(...quadTris(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1), verts));
        return { cp: { verts, faces, edges: triEdges(faces, assigned) } };
      },
    },

    yoshimura: {
      name: 'Yoshimura',
      kind: 'sheet',
      stiffness: { axial: 50, fold: 0.7, facet: 1.5 },
      blurb: 'Diamond buckling pattern from thin cylinders under compression. Not rigid-foldable: its panels bend to fold, so the strain map stays fairly pale. As a flat sheet it collapses fast, and with no panel collision its layers soon pass through each other.',
      params: [
        { key: 'cols', label: 'Diamonds across', min: 2, max: 10, step: 1, value: 5, int: true },
        { key: 'rows', label: 'Rows', min: 2, max: 10, step: 1, value: 4, int: true },
        { key: 'w', label: 'Diamond width', min: 0.5, max: 2, step: 0.01, value: 1, unit: 'cm' },
        { key: 'h', label: 'Row height', min: 0.2, max: 1.5, step: 0.01, value: 0.55, unit: 'cm' },
      ],
      build(p) {
        const m = p.cols, n = p.rows, w = p.w, h = p.h;
        // rows alternate between m+1 points (even) and m points + 2 half edge points (odd)
        const verts = [], rowIds = [];
        for (let j = 0; j <= n; j++) {
          const ids = [];
          if (j % 2 === 0) for (let i = 0; i <= m; i++) { ids.push(verts.length); verts.push([i * w, j * h]); }
          else {
            ids.push(verts.length); verts.push([0, j * h]);
            for (let i = 0; i < m; i++) { ids.push(verts.length); verts.push([(i + 0.5) * w, j * h]); }
            ids.push(verts.length); verts.push([m * w, j * h]);
          }
          rowIds.push(ids);
        }
        const faces = [];
        for (let j = 0; j < n; j++) {
          const A = rowIds[j], B = rowIds[j + 1];
          // merge the two rows by x and triangulate as a strip
          let i = 0, k = 0;
          while (i < A.length - 1 || k < B.length - 1) {
            const ax = i < A.length - 1 ? verts[A[i + 1]][0] : Infinity;
            const bx = k < B.length - 1 ? verts[B[k + 1]][0] : Infinity;
            if (ax <= bx - 1e-9 || (Math.abs(ax - bx) < 1e-9 && i <= k)) { faces.push([A[i], A[i + 1], B[k]]); i++; }
            else { faces.push([A[i], B[k + 1], B[k]]); k++; }
          }
        }
        const assigned = new Map();
        for (const f of faces) for (let s = 0; s < 3; s++) {
          const a = f[s], b = f[(s + 1) % 3];
          const horiz = Math.abs(verts[a][1] - verts[b][1]) < 1e-9;
          if (horiz) assigned.set(ekey(a, b), 'M');
          else if (Math.abs(verts[a][0] - verts[b][0]) > 1e-9) assigned.set(ekey(a, b), 'V');
          // vertical half-edges on the sides stay boundary
        }
        // remove vertical side segments from the assigned list (they are boundary)
        return { cp: { verts, faces, edges: triEdges(faces, assigned) } };
      },
    },

    waterbomb: {
      name: 'Waterbomb base',
      kind: 'sheet',
      stiffness: { axial: 50, fold: 0.7, facet: 1.5 },
      blurb: 'A single degree-6 vertex: four mountain diagonals and one valley midline. The building block of waterbomb tubes and crawling robots.',
      params: [
        { key: 'size', label: 'Square size', min: 1, max: 4, step: 0.05, value: 2, unit: 'cm' },
        { key: 'aspect', label: 'Aspect ratio', min: 0.6, max: 1.6, step: 0.01, value: 1 },
      ],
      build(p) {
        const W = p.size, H = p.size * p.aspect;
        const verts = [[0, 0], [W, 0], [W, H], [0, H], [W / 2, H / 2], [0, H / 2], [W, H / 2]];
        // 0 1 2 3 corners, 4 centre, 5 left mid, 6 right mid
        const faces = [[0, 1, 4], [1, 6, 4], [6, 2, 4], [2, 3, 4], [3, 5, 4], [5, 0, 4]];
        const assigned = new Map([
          [ekey(0, 4), 'M'], [ekey(1, 4), 'M'], [ekey(2, 4), 'M'], [ekey(3, 4), 'M'],
          [ekey(5, 4), 'V'], [ekey(6, 4), 'V'],
        ]);
        return { cp: { verts, faces, edges: triEdges(faces, assigned) } };
      },
    },

    kresling: {
      name: 'Kresling tower',
      kind: 'tower',
      stiffness: { axial: 50, fold: 0.01, facet: 0.01 },
      blurb: 'Twisted cylinder of triangles. Pushing it down makes it twist, and the right geometry snaps between two stable heights. Popular for crawlers and grippers.',
      params: [
        { key: 'n', label: 'Polygon sides', min: 4, max: 9, step: 1, value: 6, int: true },
        { key: 'levels', label: 'Stacked cells', min: 1, max: 4, step: 1, value: 1, int: true },
        { key: 'H', label: 'Cell height', min: 0.6, max: 2, step: 0.01, value: 1.4, unit: 'cm' },
        { key: 'phi', label: 'Twist per cell', min: 10, max: 60, step: 0.5, value: 25, unit: '°' },
      ],
      build(p) {
        const n = p.n, L = p.levels, H = p.H, phi = p.phi * DEG, R = 1;
        // 3D deployed geometry; level k is rotated by k*phi (alternate chirality would be k*phi*(-1)^k)
        const P = (k, j) => {
          const t = (2 * PI * j) / n + k * phi;
          return [R * Math.cos(t), R * Math.sin(t), k * H];
        };
        const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
        const a = dist(P(0, 0), P(0, 1));
        const b = dist(P(0, 0), P(1, 0));
        const c = dist(P(0, 0), P(1, 1)); // long diagonal = valley
        // flat strip: vertex (k,j) at j*a*x + k*v, |v| = b, |v + a x| = c
        const vx = (c * c - b * b - a * a) / (2 * a);
        const vy = Math.sqrt(Math.max(1e-9, b * b - vx * vx));
        const verts = [], vmap = [], id = (k, j) => k * (n + 1) + j;
        for (let k = 0; k <= L; k++) for (let j = 0; j <= n; j++) {
          verts.push([j * a + k * vx, k * vy]);
          vmap.push(k * n + (j % n));
        }
        const faces = [];
        for (let k = 0; k < L; k++) for (let j = 0; j < n; j++) {
          faces.push([id(k, j), id(k, j + 1), id(k + 1, j + 1)]);
          faces.push([id(k, j), id(k + 1, j + 1), id(k + 1, j)]);
        }
        const pos3d = [];
        for (let k = 0; k <= L; k++) for (let j = 0; j < n; j++) pos3d.push(P(k, j));
        const assigned = new Map();
        for (let k = 0; k <= L; k++) for (let j = 0; j < n; j++) {
          if (k > 0 && k < L) assigned.set(ekey(id(k, j), id(k, j + 1)), 'auto');
          if (k < L) {
            assigned.set(ekey(id(k, j), id(k + 1, j)), 'auto');
            assigned.set(ekey(id(k, j), id(k + 1, j + 1)), 'auto');
          }
        }
        if (true) for (let k = 0; k < L; k++) assigned.set(ekey(id(k, n), id(k + 1, n)), 'auto');
        const groups = { bottom: [], top: [] };
        for (let j = 0; j < n; j++) { groups.bottom.push(j); groups.top.push(L * n + j); }
        return {
          cp: { verts, faces, edges: triEdges(faces, assigned) },
          vmap, pos3d, restFromPos: true, groups,
          lids: [groups.bottom, groups.top], fixed: groups.bottom,
        };
      },
    },
  };

  function defaultParams(key) {
    const o = {};
    for (const q of PATTERNS[key].params) o[q.key] = q.value;
    return o;
  }

  // Build a pattern (or an imported FOLD cp) with optional assignment overrides (cp edge index -> asg)
  function buildPattern(key, params, overrides, custom) {
    const out = key === 'custom' ? JSON.parse(JSON.stringify(custom)) : PATTERNS[key].build(params);
    if (overrides) for (const [i, asg] of Object.entries(overrides)) if (out.cp.edges[i]) out.cp.edges[i][2] = asg;
    out.key = key;
    out.kind = key === 'custom' ? 'sheet' : PATTERNS[key].kind;
    if (!out.vmap) out.vmap = out.cp.verts.map((_, i) => i);
    return out;
  }

  // =====================================================================
  // Mesh: triangles + bars + hinges, in sim vertex indices
  // =====================================================================
  function buildMesh(pat, opts) {
    const base = pat.key && PATTERNS[pat.key] ? PATTERNS[pat.key].stiffness : { axial: 50, fold: 0.7, facet: 1.5 };
    opts = Object.assign({ maxFold: 1 }, base, opts || {});
    const { cp, vmap } = pat;
    const N = Math.max(Math.max(...vmap) + 1, pat.pos3d ? pat.pos3d.length : 0);
    const x = new Float64Array(3 * N);
    if (pat.pos3d) pat.pos3d.forEach((p, i) => { x[3 * i] = p[0]; x[3 * i + 1] = p[1]; x[3 * i + 2] = p[2]; });
    else cp.verts.forEach((v, i) => { const s = vmap[i]; x[3 * s] = v[0]; x[3 * s + 1] = v[1]; x[3 * s + 2] = 0; });
    // centre flat sheets on the origin
    if (!pat.pos3d) {
      let cx = 0, cy = 0;
      for (let i = 0; i < N; i++) { cx += x[3 * i]; cy += x[3 * i + 1]; }
      cx /= N; cy /= N;
      for (let i = 0; i < N; i++) { x[3 * i] -= cx; x[3 * i + 1] -= cy; }
    }
    const faces = cp.faces.map((f) => f.map((v) => vmap[v]));
    const asgMap = new Map();
    for (const [a, b, s] of cp.edges) {
      const k = ekey(vmap[a], vmap[b]);
      const prev = asgMap.get(k);
      if (!prev || prev === 'B' || prev === 'F') asgMap.set(k, s);
    }
    // edges -> adjacent faces (directed)
    const emap = new Map();
    faces.forEach((f, fi) => {
      for (let s = 0; s < 3; s++) {
        const a = f[s], b = f[(s + 1) % 3], c = f[(s + 2) % 3];
        const k = ekey(a, b);
        if (!emap.has(k)) emap.set(k, { a: Math.min(a, b), b: Math.max(a, b), sides: [] });
        emap.get(k).sides.push({ from: a, to: b, wing: c, face: fi });
      }
    });
    const bars = [], hinges = [];
    const len = (i, j) => Math.hypot(x[3 * i] - x[3 * j], x[3 * i + 1] - x[3 * j + 1], x[3 * i + 2] - x[3 * j + 2]);
    for (const [k, e] of emap) {
      let asg = asgMap.get(k) || (e.sides.length === 2 ? 'F' : 'B');
      if (e.sides.length < 2 && asg !== 'B') asg = 'B';
      const L0 = len(e.a, e.b);
      bars.push({ i: e.a, j: e.b, L0, asg });
      if (e.sides.length === 2) {
        const s1 = e.sides[0], s2 = e.sides[1];
        // s1 contains directed from->to; wing1 = s1.wing; s2 contains the reverse; wing2 = s2.wing
        hinges.push({ w1: s1.wing, w2: s2.wing, h1: s1.from, h2: s1.to, L0, asg, rest: 0, target: 0, foldTo: 0, theta: 0 });
      }
    }
    // lids: rigid polygons on tower ends (extra bars, not drawn)
    const lidBars = [];
    if (pat.lids) for (const g of pat.lids) for (let u = 0; u < g.length; u++) for (let v = u + 2; v < g.length; v++) {
      if (u === 0 && v === g.length - 1) continue;
      lidBars.push({ i: g[u], j: g[v], L0: len(g[u], g[v]), asg: 'L' });
    }
    if (pat.extraBars) for (const [a, b] of pat.extraBars) lidBars.push({ i: a, j: b, L0: len(a, b), asg: 'L' });
    const mesh = { N, x0: x, faces, bars, hinges, lidBars, pat, opts };
    // rest angles
    const sim = new (opts.SimClass || Sim)(mesh);
    if (pat.restFromPos) {
      sim.hinges.forEach((h, idx) => {
        const th = sim.hingeAngle(h);
        h.rest = th; h.theta = th; h.target = th;
        if (h.asg === 'auto' || h.asg === 'M' || h.asg === 'V') h.asg = th >= 0 ? 'V' : 'M';
      });
      // copy auto assignments back to the cp drawing
      const hm = new Map(sim.hinges.map((h) => [ekey(h.h1, h.h2), h.asg]));
      for (const e of cp.edges) if (e[2] === 'auto') e[2] = hm.get(ekey(vmap[e[0]], vmap[e[1]])) || 'F';
      for (const bar of sim.bars) if (bar.asg === 'auto') bar.asg = hm.get(ekey(bar.i, bar.j)) || 'F';
    }
    return sim;
  }

  // =====================================================================
  // Simulator: explicit dynamics on a bar-and-hinge model
  //   bars   : axial springs  k = axial / L0, damped along the bar
  //   hinges : rotational springs on the dihedral angle, k = stiffness * L0
  //            M/V creases use `fold` stiffness, facet diagonals (F) use `facet`
  // =====================================================================
  class Sim {
    constructor(mesh) {
      this.mesh = mesh;
      const o = mesh.opts;
      this.opts = o;
      this.N = mesh.N;
      this.x = Float64Array.from(mesh.x0);
      this.v = new Float64Array(3 * this.N);
      this.f = new Float64Array(3 * this.N);
      this.fixed = new Uint8Array(this.N);
      if (mesh.pat.fixed) for (const i of mesh.pat.fixed) this.fixed[i] = 1;
      this.bars = mesh.bars.map((b) => Object.assign({}, b));
      this.allBars = this.bars.concat(mesh.lidBars.map((b) => Object.assign({}, b)));
      this.hinges = mesh.hinges.map((h) => Object.assign({}, h));
      this.zLock = null;     // {nodes, z}
      this.tendon = 0;       // downward force on the top group
      this.damping = 1.0;    // global velocity damping (1/s)
      this.zeta = 0.45;      // bar damping ratio
      this.foldPct = 0;
      this.time = 0;
      this.reaction = 0;
      this.setStiffness(o.axial, o.fold, o.facet);
      if (mesh.pat.groups) this.floor = 0.04 * this.restHeight();
    }
    setStiffness(axial, fold, facet) {
      Object.assign(this.opts, { axial, fold, facet });
      for (const b of this.allBars) { b.k = axial / b.L0; b.c = 2 * this.zeta * Math.sqrt(b.k); }
      for (const h of this.hinges) h.k = (h.asg === 'F' ? facet : fold) * h.L0;
      // stable time step from the stiffest node
      const nodeK = new Float64Array(this.N);
      for (const b of this.allBars) { nodeK[b.i] += b.k; nodeK[b.j] += b.k; }
      for (const h of this.hinges) {
        const L = h.L0;
        for (const w of [h.w1, h.w2]) {
          const hh = this.wingHeight(w, h.h1, h.h2);
          if (hh > 1e-6) nodeK[w] += h.k / (hh * hh);
        }
      }
      let kmax = 0;
      for (let i = 0; i < this.N; i++) kmax = Math.max(kmax, nodeK[i]);
      this.dt = Math.min(0.05, 0.7 / Math.sqrt(2 * kmax));
    }
    wingHeight(w, a, b) {
      const x = this.mesh.x0;
      const ex = x[3 * b] - x[3 * a], ey = x[3 * b + 1] - x[3 * a + 1], ez = x[3 * b + 2] - x[3 * a + 2];
      const rx = x[3 * w] - x[3 * a], ry = x[3 * w + 1] - x[3 * a + 1], rz = x[3 * w + 2] - x[3 * a + 2];
      const cx = ey * rz - ez * ry, cy = ez * rx - ex * rz, cz = ex * ry - ey * rx;
      return Math.hypot(cx, cy, cz) / Math.hypot(ex, ey, ez);
    }
    setFold(p) {
      // drive M/V creases toward +/- pi * p (valley positive, FOLD convention)
      this.foldPct = p;
      const mf = this.opts.maxFold * PI;
      for (const h of this.hinges) {
        if (h.asg === 'V') h.target = h.rest + p * (mf - h.rest);
        else if (h.asg === 'M') h.target = h.rest + p * (-mf - h.rest);
        else h.target = h.rest;
      }
    }
    // signed fold angle (0 flat, valley > 0), continuous across +/-pi
    hingeAngle(h, grad) {
      const x = this.x;
      const i = 3 * h.w1, l = 3 * h.w2, j = 3 * h.h1, k = 3 * h.h2;
      const rijx = x[i] - x[j], rijy = x[i + 1] - x[j + 1], rijz = x[i + 2] - x[j + 2];
      const rkjx = x[k] - x[j], rkjy = x[k + 1] - x[j + 1], rkjz = x[k + 2] - x[j + 2];
      const rklx = x[k] - x[l], rkly = x[k + 1] - x[l + 1], rklz = x[k + 2] - x[l + 2];
      const mx = rijy * rkjz - rijz * rkjy, my = rijz * rkjx - rijx * rkjz, mz = rijx * rkjy - rijy * rkjx;
      const nx = rkjy * rklz - rkjz * rkly, ny = rkjz * rklx - rkjx * rklz, nz = rkjx * rkly - rkjy * rklx;
      const mm = mx * mx + my * my + mz * mz, nn = nx * nx + ny * ny + nz * nz;
      const LL = rkjx * rkjx + rkjy * rkjy + rkjz * rkjz, L = Math.sqrt(LL);
      if (mm < 1e-14 || nn < 1e-14 || L < 1e-9) return h.theta;
      const im = 1 / Math.sqrt(mm), inn = 1 / Math.sqrt(nn);
      const cxm = (my * nz - mz * ny), cym = (mz * nx - mx * nz), czm = (mx * ny - my * nx);
      const sinT = (cxm * rkjx + cym * rkjy + czm * rkjz) * im * inn / L;
      const cosT = -(mx * nx + my * ny + mz * nz) * im * inn;
      let th = Math.atan2(sinT, cosT);
      // unwrap
      const d = th - h.theta;
      if (d > PI) th -= 2 * PI; else if (d < -PI) th += 2 * PI;
      if (grad) {
        // Liu & Paulino (2017) dihedral gradient; sign matched to `th`
        const a1 = (rijx * rkjx + rijy * rkjy + rijz * rkjz) / LL;
        const a2 = (rklx * rkjx + rkly * rkjy + rklz * rkjz) / LL;
        const s = -1;
        const gi = [s * L / mm * mx, s * L / mm * my, s * L / mm * mz];
        const gl = [-s * L / nn * nx, -s * L / nn * ny, -s * L / nn * nz];
        grad[0] = gi[0]; grad[1] = gi[1]; grad[2] = gi[2];
        grad[3] = gl[0]; grad[4] = gl[1]; grad[5] = gl[2];
        for (let c = 0; c < 3; c++) {
          grad[6 + c] = (a1 - 1) * gi[c] - a2 * gl[c];
          grad[9 + c] = (a2 - 1) * gl[c] - a1 * gi[c];
        }
      }
      return th;
    }
    forces() {
      const x = this.x, v = this.v, f = this.f;
      f.fill(0);
      for (const b of this.allBars) {
        const i = 3 * b.i, j = 3 * b.j;
        const dx = x[j] - x[i], dy = x[j + 1] - x[i + 1], dz = x[j + 2] - x[i + 2];
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-12;
        const ux = dx / L, uy = dy / L, uz = dz / L;
        const rv = (v[j] - v[i]) * ux + (v[j + 1] - v[i + 1]) * uy + (v[j + 2] - v[i + 2]) * uz;
        const fs = b.k * (L - b.L0) + b.c * rv;
        f[i] += fs * ux; f[i + 1] += fs * uy; f[i + 2] += fs * uz;
        f[j] -= fs * ux; f[j + 1] -= fs * uy; f[j + 2] -= fs * uz;
      }
      const g = this._g || (this._g = new Float64Array(12));
      for (const h of this.hinges) {
        const th = this.hingeAngle(h, g);
        h.theta = th;
        const tq = -h.k * (th - h.target);
        const ids = [h.w1, h.w2, h.h1, h.h2];
        for (let q = 0; q < 4; q++) {
          const n = 3 * ids[q];
          f[n] += tq * g[3 * q]; f[n + 1] += tq * g[3 * q + 1]; f[n + 2] += tq * g[3 * q + 2];
        }
      }
      const grp = this.mesh.pat.groups;
      if (this.tendon && grp) {
        const fz = this.tendon / grp.top.length;
        for (const n of grp.top) f[3 * n + 2] -= fz;
      }
      // a hand pulling one point toward a target (spring + damper)
      // the grabbed point is a weighted mix of a face's corners (barycentric)
      if (this.grab) {
        const g = this.grab, k = g.k || 25, c = 2 * Math.sqrt(k);
        const nodes = g.nodes || [g.node], w = g.w || [1];
        for (let d = 0; d < 3; d++) {
          let pd = 0, vd = 0;
          for (let q = 0; q < nodes.length; q++) { pd += w[q] * x[3 * nodes[q] + d]; vd += w[q] * v[3 * nodes[q] + d]; }
          g._F = g._F || [0, 0, 0];
          g._F[d] = k * (g.target[d] - pd) - c * vd;
        }
        // a hand, not a vice: cap the pull so panels do not get torn apart
        const Fm = Math.hypot(g._F[0], g._F[1], g._F[2]), cap = g.maxForce || 2;
        const sc = Fm > cap ? cap / Fm : 1;
        for (let d = 0; d < 3; d++) for (let q = 0; q < nodes.length; q++) f[3 * nodes[q] + d] += w[q] * g._F[d] * sc;
      }
    }
    // paper memory: creases keep the angle they were bent to
    setCreasesToCurrent() {
      for (const h of this.hinges) if (h.asg === 'M' || h.asg === 'V') h.target = h.theta;
    }
    step(n) {
      n = n || 1;
      const dt = this.dt, x = this.x, v = this.v, f = this.f, N = this.N;
      const damp = Math.exp(-this.damping * dt);
      for (let s = 0; s < n; s++) {
        this.forces();
        let react = 0;
        for (let i = 0; i < N; i++) {
          const p = 3 * i;
          if (this.fixed[i]) { v[p] = v[p + 1] = v[p + 2] = 0; continue; }
          v[p] = (v[p] + f[p] * dt) * damp;
          v[p + 1] = (v[p + 1] + f[p + 1] * dt) * damp;
          v[p + 2] = (v[p + 2] + f[p + 2] * dt) * damp;
        }
        if (this.zLock) {
          for (const i of this.zLock.nodes) { react += f[3 * i + 2]; v[3 * i + 2] = 0; x[3 * i + 2] = this.zLock.z; }
          this.reaction = react;
        }
        for (let i = 0; i < 3 * N; i++) x[i] += v[i] * dt;
        if (this.floor !== undefined) {
          // end lids touch: the top ring cannot pass through the bottom
          for (const i of this.mesh.pat.groups.top) if (x[3 * i + 2] < this.floor) { x[3 * i + 2] = this.floor; if (v[3 * i + 2] < 0) v[3 * i + 2] = 0; }
        }
        this.time += dt;
      }
    }
    kinetic() { let e = 0; for (let i = 0; i < this.v.length; i++) e += this.v[i] * this.v[i]; return 0.5 * e; }
    settle(maxSteps, tol) {
      tol = tol || 1e-9;
      let s = 0;
      for (; s < maxSteps; s += 50) {
        this.step(50);
        if (this.kinetic() < tol * this.N) break;
      }
      return s;
    }
    strains(out) {
      out = out || new Float64Array(this.bars.length);
      const x = this.x;
      this.bars.forEach((b, q) => {
        const i = 3 * b.i, j = 3 * b.j;
        const L = Math.hypot(x[j] - x[i], x[j + 1] - x[i + 1], x[j + 2] - x[i + 2]);
        out[q] = (L - b.L0) / b.L0;
      });
      return out;
    }
    maxStrain() { let m = 0; for (const s of this.strains()) m = Math.max(m, Math.abs(s)); return m; }
    energy() {
      let eb = 0, eh = 0;
      const x = this.x;
      for (const b of this.allBars) {
        const i = 3 * b.i, j = 3 * b.j;
        const L = Math.hypot(x[j] - x[i], x[j + 1] - x[i + 1], x[j + 2] - x[i + 2]);
        eb += 0.5 * b.k * (L - b.L0) ** 2;
      }
      for (const h of this.hinges) eh += 0.5 * h.k * (h.theta - h.target) ** 2;
      return { bars: eb, hinges: eh, total: eb + eh };
    }
    // ---------- shape measurements ----------
    cornerIds() {
      if (this._corners) return this._corners;
      const { cp, vmap } = this.mesh.pat;
      const pick = (fn) => { let best = -Infinity, id = 0; cp.verts.forEach((v, i) => { const s = fn(v); if (s > best) { best = s; id = vmap[i]; } }); return id; };
      this._corners = [pick((v) => -v[0] - v[1]), pick((v) => v[0] - v[1]), pick((v) => v[0] + v[1]), pick((v) => -v[0] + v[1])];
      return this._corners;
    }
    footprint(xArr) {
      // area of the quad through the 4 corner nodes (rotation invariant)
      const x = xArr || this.x, c = this.cornerIds();
      const d1 = [0, 1, 2].map((k) => x[3 * c[2] + k] - x[3 * c[0] + k]);
      const d2 = [0, 1, 2].map((k) => x[3 * c[3] + k] - x[3 * c[1] + k]);
      const cr = [d1[1] * d2[2] - d1[2] * d2[1], d1[2] * d2[0] - d1[0] * d2[2], d1[0] * d2[1] - d1[1] * d2[0]];
      return 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
    }
    areaRatio() { return this.footprint() / this.footprint(this.mesh.x0); }
    height() {
      const grp = this.mesh.pat.groups;
      if (!grp) return 0;
      let z = 0; for (const n of grp.top) z += this.x[3 * n + 2];
      return z / grp.top.length;
    }
    twist() {
      // rotation of the top ring relative to its rest position (degrees)
      const grp = this.mesh.pat.groups; if (!grp) return 0;
      const n = grp.top[0], x = this.x, x0 = this.mesh.x0;
      let d = Math.atan2(x[3 * n + 1], x[3 * n]) - Math.atan2(x0[3 * n + 1], x0[3 * n]);
      while (d > PI) d -= 2 * PI; while (d < -PI) d += 2 * PI;
      return d / DEG;
    }
    restHeight() {
      const grp = this.mesh.pat.groups;
      let z = 0; for (const n of grp.top) z += this.mesh.x0[3 * n + 2];
      return z / grp.top.length;
    }
  }

  // =====================================================================
  // Experiments used by the UI, the optimizer and the env
  // =====================================================================
  function foldTo(sim, p, steps) {
    const p0 = sim.foldPct, n = Math.max(1, Math.round(steps / 50));
    for (let s = 1; s <= n; s++) { sim.setFold(p0 + (p - p0) * (s / n)); sim.step(50); }
    sim.settle(4000, 1e-9);
    return sim;
  }
  function foldSweep(sim, pts, pmax) {
    const out = [];
    for (let q = 0; q <= pts; q++) {
      const p = (pmax * q) / pts;
      foldTo(sim, p, 600);
      out.push({ p, area: sim.areaRatio(), strain: sim.maxStrain(), energy: sim.energy().total });
    }
    return out;
  }
  function forceSweep(sim, pts, minFrac) {
    // displacement control on the top ring; returns reaction force vs compression
    const H0 = sim.restHeight(), top = sim.mesh.pat.groups.top, out = [];
    sim.tendon = 0;
    for (let q = 0; q <= pts; q++) {
      const z = H0 * (1 - (1 - minFrac) * (q / pts));
      sim.zLock = { nodes: top, z };
      sim.settle(3000, 1e-10);
      // average reaction over a few steps
      let r = 0; for (let s = 0; s < 10; s++) { sim.step(1); r += sim.reaction; }
      out.push({ z, compression: 1 - z / H0, force: r / 10, energy: sim.energy().total });
    }
    sim.zLock = null;
    return out;
  }
  function tendonEquilibrium(sim, F) {
    sim.zLock = null;
    const n = 20;
    for (let s = 1; s <= n; s++) { sim.tendon = (F * s) / n; sim.step(100); }
    sim.settle(6000, 1e-10);
    return 1 - sim.height() / sim.restHeight();
  }

  // Objectives: return a score (higher is better) plus info
  const OBJECTIVES = {
    sheet: [
      { key: 'compact', label: 'Fold most compactly', hint: 'Footprint shrink at the target fold, minus a penalty for stretching panels.',
        eval(sim, ctx) { foldTo(sim, ctx.fold, 1500); const area = sim.areaRatio(), st = sim.maxStrain();
          return { score: (1 - area) - 6 * st, info: { 'Area kept': area, 'Max strain': st } }; } },
      { key: 'rigid', label: 'Fold without stretching', hint: 'Least panel strain at the target fold. Rigid-foldable designs reach ~0.',
        eval(sim, ctx) { foldTo(sim, ctx.fold, 1500); const st = sim.maxStrain(), area = sim.areaRatio();
          return { score: -100 * st + 0.05 * (1 - area), info: { 'Max strain': st, 'Area kept': area } }; } },
    ],
    tower: [
      { key: 'stroke', label: 'Longest stroke for the force', hint: 'Height lost when the tendon pulls with the current force. More stroke for less force.',
        eval(sim, ctx) { const s = tendonEquilibrium(sim, ctx.tendon); return { score: s, info: { Stroke: s, 'Max strain': sim.maxStrain() } }; } },
      { key: 'bistable', label: 'Strongest second stable state', hint: 'How hard the compressed tower pulls itself shut. Positive means it snaps and stays folded.',
        eval(sim) { const c = forceSweep(sim, 24, 0.12); let mn = Infinity; for (const p of c) mn = Math.min(mn, p.force);
          return { score: -mn, info: { 'Snap force': -mn }, curve: c }; } },
    ],
  };

  // =====================================================================
  // CMA-ES (Hansen), minimisation, for small dimensions
  // =====================================================================
  function jacobiEigen(A, n) {
    const a = A.map((r) => r.slice()), V = [];
    for (let i = 0; i < n; i++) { V.push(new Array(n).fill(0)); V[i][i] = 1; }
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
      }
    }
    return { values: a.map((r, i) => r[i]), vectors: V };
  }

  class CMAES {
    constructor(x0, sigma0, opts) {
      opts = opts || {};
      const N = x0.length;
      this.N = N; this.rng = mulberry32(opts.seed || 12345);
      this.lambda = opts.popsize || 4 + Math.floor(3 * Math.log(N));
      this.mu = Math.floor(this.lambda / 2);
      let w = []; for (let i = 0; i < this.mu; i++) w.push(Math.log(this.mu + 0.5) - Math.log(i + 1));
      const sw = w.reduce((a, b) => a + b, 0); w = w.map((v) => v / sw);
      this.w = w; this.mueff = 1 / w.reduce((a, b) => a + b * b, 0);
      const me = this.mueff;
      this.cc = (4 + me / N) / (N + 4 + (2 * me) / N);
      this.cs = (me + 2) / (N + me + 5);
      this.c1 = 2 / ((N + 1.3) ** 2 + me);
      this.cmu = Math.min(1 - this.c1, (2 * (me - 2 + 1 / me)) / ((N + 2) ** 2 + me));
      this.damps = 1 + 2 * Math.max(0, Math.sqrt((me - 1) / (N + 1)) - 1) + this.cs;
      this.chiN = Math.sqrt(N) * (1 - 1 / (4 * N) + 1 / (21 * N * N));
      this.mean = x0.slice(); this.sigma = sigma0;
      this.pc = new Array(N).fill(0); this.ps = new Array(N).fill(0);
      this.C = []; for (let i = 0; i < N; i++) { this.C.push(new Array(N).fill(0)); this.C[i][i] = 1; }
      this.B = this.C.map((r) => r.slice()); this.D = new Array(N).fill(1);
      this.gen = 0; this.best = { x: x0.slice(), f: Infinity };
    }
    ask() {
      const N = this.N, out = [];
      for (let k = 0; k < this.lambda; k++) {
        const z = []; for (let i = 0; i < N; i++) z.push(gauss(this.rng) * this.D[i]);
        const y = new Array(N).fill(0);
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) y[i] += this.B[i][j] * z[j];
        out.push(this.mean.map((m, i) => m + this.sigma * y[i]));
      }
      return out;
    }
    tell(xs, fs) {
      const N = this.N, idx = fs.map((f, i) => i).sort((a, b) => fs[a] - fs[b]);
      if (fs[idx[0]] < this.best.f) this.best = { x: xs[idx[0]].slice(), f: fs[idx[0]] };
      const old = this.mean.slice();
      this.mean = new Array(N).fill(0);
      for (let k = 0; k < this.mu; k++) for (let i = 0; i < N; i++) this.mean[i] += this.w[k] * xs[idx[k]][i];
      const dm = this.mean.map((m, i) => (m - old[i]) / this.sigma);
      // C^{-1/2} dm
      const t = new Array(N).fill(0);
      for (let j = 0; j < N; j++) { let s = 0; for (let i = 0; i < N; i++) s += this.B[i][j] * dm[i]; t[j] = s / this.D[j]; }
      const ic = new Array(N).fill(0);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) ic[i] += this.B[i][j] * t[j];
      const cs = this.cs, cc = this.cc, me = this.mueff;
      for (let i = 0; i < N; i++) this.ps[i] = (1 - cs) * this.ps[i] + Math.sqrt(cs * (2 - cs) * me) * ic[i];
      const psn = Math.hypot(...this.ps);
      const hsig = psn / Math.sqrt(1 - (1 - cs) ** (2 * (this.gen + 1))) / this.chiN < 1.4 + 2 / (N + 1) ? 1 : 0;
      for (let i = 0; i < N; i++) this.pc[i] = (1 - cc) * this.pc[i] + hsig * Math.sqrt(cc * (2 - cc) * me) * dm[i];
      const c1 = this.c1, cmu = this.cmu;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        let rmu = 0;
        for (let k = 0; k < this.mu; k++) {
          const xi = (xs[idx[k]][i] - old[i]) / this.sigma, xj = (xs[idx[k]][j] - old[j]) / this.sigma;
          rmu += this.w[k] * xi * xj;
        }
        this.C[i][j] = (1 - c1 - cmu) * this.C[i][j] + c1 * (this.pc[i] * this.pc[j] + (1 - hsig) * cc * (2 - cc) * this.C[i][j]) + cmu * rmu;
      }
      this.sigma *= Math.exp((cs / this.damps) * (psn / this.chiN - 1));
      this.sigma = Math.min(this.sigma, 1);
      const eg = jacobiEigen(this.C, N);
      this.B = eg.vectors; this.D = eg.values.map((v) => Math.sqrt(Math.max(v, 1e-20)));
      this.gen++;
    }
  }

  // =====================================================================
  // FOLD format (https://github.com/edemaine/fold)
  // =====================================================================
  function toFOLD(pat, title) {
    const { cp } = pat;
    const angle = (a) => (a === 'M' ? -180 : a === 'V' ? 180 : 0);
    return {
      file_spec: 1.1,
      file_creator: 'Crease Lab',
      file_title: title || 'pattern',
      file_classes: ['singleModel'],
      frame_classes: ['creasePattern'],
      frame_attributes: ['2D'],
      frame_unit: 'cm',
      vertices_coords: cp.verts.map((v) => [+v[0].toFixed(6), +v[1].toFixed(6)]),
      edges_vertices: cp.edges.map((e) => [e[0], e[1]]),
      edges_assignment: cp.edges.map((e) => e[2]),
      edges_foldAngle: cp.edges.map((e) => angle(e[2])),
      faces_vertices: cp.faces.map((f) => f.slice()),
    };
  }
  function fromFOLD(json) {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    if (!d.vertices_coords || !d.edges_vertices) throw new Error('A FOLD file needs vertices_coords and edges_vertices.');
    const verts = d.vertices_coords.map((v) => [v[0], v[1]]);
    const asg = d.edges_assignment || d.edges_vertices.map(() => 'U');
    const edges = d.edges_vertices.map((e, i) => {
      let a = (asg[i] || 'U').toUpperCase();
      if (a === 'U' || a === 'J' || a === 'C') a = 'F';
      return [e[0], e[1], a];
    });
    let faces = d.faces_vertices;
    if (!faces) faces = facesFromEdges(verts, edges);
    // fan-triangulate polygons and orient counter-clockwise
    const tris = [];
    for (const f of faces) {
      let area = 0;
      for (let i = 0; i < f.length; i++) { const p = verts[f[i]], q = verts[f[(i + 1) % f.length]]; area += p[0] * q[1] - q[0] * p[1]; }
      const g = area < 0 ? f.slice().reverse() : f;
      for (let i = 1; i < g.length - 1; i++) tris.push([g[0], g[i], g[i + 1]]);
    }
    const known = new Map(edges.map((e) => [ekey(e[0], e[1]), e[2]]));
    const all = triEdges(tris, known);
    return { cp: { verts, faces: tris, edges: all } };
  }
  function facesFromEdges(verts, edges) {
    // planar face finding: walk the half-edge graph turning to the next edge clockwise
    const adj = verts.map(() => []);
    for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
    const ang = (a, b) => Math.atan2(verts[b][1] - verts[a][1], verts[b][0] - verts[a][0]);
    adj.forEach((l, a) => l.sort((p, q) => ang(a, p) - ang(a, q)));
    const used = new Set(), faces = [];
    for (let a = 0; a < verts.length; a++) for (const b of adj[a]) {
      if (used.has(a + '>' + b)) continue;
      const face = []; let u = a, v = b, guard = 0;
      while (!used.has(u + '>' + v) && guard++ < 1000) {
        used.add(u + '>' + v); face.push(u);
        const l = adj[v], i = l.indexOf(u);
        const w = l[(i - 1 + l.length) % l.length];
        u = v; v = w;
      }
      let area = 0;
      for (let i = 0; i < face.length; i++) { const p = verts[face[i]], q = verts[face[(i + 1) % face.length]]; area += p[0] * q[1] - q[0] * p[1]; }
      if (area > 1e-12 && face.length >= 3) faces.push(face);
    }
    return faces;
  }

  // =====================================================================
  // Gym-style environment for learning controllers
  //   sheet: action[0] in [-1,1] = fold rate, reward = -|area - targetArea| - strain penalty
  //   tower: action[0] in [0,1] = tendon force fraction, reward = -|stroke - targetStroke|
  // =====================================================================
  class OrigamiEnv {
    constructor(key, params, opts) {
      this.key = key; this.params = Object.assign(defaultParams(key), params || {});
      this.opts = Object.assign({ substeps: 40, maxSteps: 200, target: 0.5, maxTendon: 3 }, opts || {});
      this.kind = PATTERNS[key].kind;
    }
    reset() {
      this.sim = buildMesh(buildPattern(this.key, this.params));
      this.sim.damping = 2;
      this.t = 0;
      return this.observe();
    }
    get obsSize() { return this.sim ? this.sim.hinges.length + 2 : null; }
    observe() {
      const s = this.sim;
      const o = new Float32Array(s.hinges.length + 2);
      s.hinges.forEach((h, i) => (o[i] = h.theta / PI));
      o[s.hinges.length] = this.kind === 'tower' ? s.height() / s.restHeight() : s.areaRatio();
      o[s.hinges.length + 1] = s.maxStrain();
      return o;
    }
    step(action) {
      const s = this.sim, a = Array.isArray(action) || ArrayBuffer.isView(action) ? action[0] : action;
      if (this.kind === 'tower') s.tendon = Math.max(0, Math.min(1, a)) * this.opts.maxTendon;
      else s.setFold(Math.max(0, Math.min(0.98, s.foldPct + 0.02 * Math.max(-1, Math.min(1, a)))));
      s.step(this.opts.substeps);
      this.t++;
      const obs = this.observe();
      const m = obs[obs.length - 2], st = obs[obs.length - 1];
      const reward = this.kind === 'tower'
        ? -Math.abs((1 - m) - this.opts.target)
        : -Math.abs(m - this.opts.target) - 5 * st;
      const bad = !isFinite(m);
      return { obs, reward: bad ? -10 : reward, done: bad || this.t >= this.opts.maxSteps, info: { strain: st, measure: m } };
    }
  }

  // Optimisation problem over the continuous parameters of a pattern (integers stay fixed)
  function makeProblem(key, baseParams, objKey, ctx, stiff) {
    const def = PATTERNS[key];
    const cont = def.params.filter((q) => !q.int);
    const obj = OBJECTIVES[def.kind].find((o) => o.key === objKey);
    const decode = (u) => {
      const p = Object.assign({}, baseParams);
      cont.forEach((q, i) => {
        const c = Math.max(0, Math.min(1, u[i]));
        p[q.key] = Math.round((q.min + c * (q.max - q.min)) / q.step) * q.step;
      });
      return p;
    };
    const encode = (p) => cont.map((q) => (p[q.key] - q.min) / (q.max - q.min));
    const evaluate = (u) => {
      const p = decode(u);
      let pen = 0; for (const v of u) pen += Math.max(0, -v) + Math.max(0, v - 1);
      let r;
      try {
        const sim = buildMesh(buildPattern(key, p), stiff);
        sim.damping = 2;
        r = obj.eval(sim, ctx);
        r.sim = sim;
        if (!isFinite(r.score)) r.score = -10;
      } catch (e) { r = { score: -10, info: { error: String(e) } }; }
      r.params = p; r.fitness = -r.score + 5 * pen;
      return r;
    };
    return { dims: cont.length, cont, decode, encode, evaluate, obj };
  }

  const API = { makeProblem, PATTERNS, OBJECTIVES, defaultParams, buildPattern, buildMesh, Sim, foldTo, foldSweep, forceSweep, tendonEquilibrium, CMAES, toFOLD, fromFOLD, OrigamiEnv, mulberry32, ekey };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.CreaseLab = API;
})(typeof window !== 'undefined' ? window : globalThis);
