// Crease Lab page: the 3D view, the Fold / Move / Build tabs, and the optimizers' UI.
// The simulator lives in core.js, the crawler and gaits in motion.js, the build exports in build.js.
(function () {
  'use strict';
  const CL = window.CreaseLab;
  const $ = (s) => document.querySelector(s);
  const DEG = Math.PI / 180;
  const fmtPct = (v, d = 0) => (v * 100).toFixed(d) + '%';

  const state = {
    key: 'miura', params: CL.defaultParams('miura'), overrides: {}, custom: null,
    fold: 0.45, tendon: 1.2, animate: false, strainMap: false, showCreases: true, paused: false,
    damping: 1.5, stiff: Object.assign({}, CL.PATTERNS.miura.stiffness),
    sel: null, creaseAngles: {}, memory: true,
  };
  let pat = null, sim = null, opt = null, frame = 0, animT = 0, mode = 'fold';

  // ================= 3D view =================
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  const hasGL = typeof THREE !== 'undefined';
  const view = {
    init() {
      if (!hasGL) { $('#stage').insertAdjacentHTML('beforeend', '<p class="hint" style="position:absolute;inset:auto 12px 60px 12px">The 3D library could not load. The crease pattern, optimizer and measurements still work.</p>'); return; }
      const canvas = $('#gl');
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 500);
      this.camera.up.set(0, 0, 1);
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9690, 0.75));
      const d1 = new THREE.DirectionalLight(0xffffff, 0.65); d1.position.set(3, -4, 8); this.scene.add(d1);
      const d2 = new THREE.DirectionalLight(0xffffff, 0.25); d2.position.set(-5, 3, -4); this.scene.add(d2);
      this.theta = -1.1; this.phi = 0.75; this.dist = 8; this.target = new THREE.Vector3();
      this.grid = null;
      this.bindOrbit(canvas);
      new ResizeObserver(() => this.resize()).observe($('#stage'));
      this.resize();
      this.applyTheme();
    },
    resize() {
      if (!this.renderer) return;
      const el = $('#stage'), w = el.clientWidth, h = el.clientHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h); this.camera.updateProjectionMatrix();
    },
    // pointer: drag the paper to fold it by hand, drag empty space (or right-drag) to turn the view
    pick(e) {
      if (!this.sim || !this.front) return null;
      const r = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.ray = this.ray || new THREE.Raycaster();
      this.ray.setFromCamera(ndc, this.camera);
      const hit = this.ray.intersectObjects([this.front, this.back], false)[0];
      if (!hit) return null;
      const f = this.sim.mesh.faces[hit.faceIndex], x = this.sim.x;
      const V = f.map((n) => new THREE.Vector3(x[3 * n], x[3 * n + 1], x[3 * n + 2]));
      let best = f[0], bd = Infinity;
      f.forEach((n, q) => { const d = hit.point.distanceToSquared(V[q]); if (d < bd) { bd = d; best = n; } });
      const bary = new THREE.Vector3();
      THREE.Triangle.getBarycoord(hit.point, V[0], V[1], V[2], bary);
      return { node: best, nodes: f.slice(), w: [bary.x, bary.y, bary.z], point: hit.point };
    },
    rayPlane(e) {
      const r = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(ndc, this.camera);
      const out = new THREE.Vector3();
      return this.ray.ray.intersectPlane(this.dragPlane, out) ? out : null;
    },
    bindOrbit(canvas) {
      const pts = new Map(); let pinch = 0;
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
        if (pts.size === 1 && e.button === 0 && this.canGrab && this.canGrab()) {
          const h = this.pick(e);
          if (h) {
            const n = h.node, p = h.point.clone();
            const nrm = new THREE.Vector3(); this.camera.getWorldDirection(nrm);
            this.dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(nrm, p);
            this.dragging = { id: e.pointerId, node: n };
            const robot = this.sim.mesh.pat.kind === 'robot';
            this.sim.grab = { nodes: h.nodes, w: h.w, target: [p.x, p.y, p.z], k: robot ? 40 : 25, maxForce: robot ? 8 : 2 };
            canvas.style.cursor = 'grabbing';
            if (this.onGrab) this.onGrab(this.sim, n);
          }
        }
      });
      canvas.addEventListener('pointermove', (e) => {
        if (this.dragging && this.dragging.id === e.pointerId) {
          const q = this.rayPlane(e);
          if (q && this.sim.grab) this.sim.grab.target = [q.x, q.y, q.z];
          return;
        }
        if (!pts.has(e.pointerId)) {
          if (this.canGrab && this.front) canvas.style.cursor = this.canGrab() && this.pick(e) ? 'grab' : '';
          return;
        }
        const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
        if (pts.size === 1) {
          this.theta -= (e.clientX - prev[0]) * 0.008;
          this.phi = Math.max(-1.45, Math.min(1.45, this.phi + (e.clientY - prev[1]) * 0.008));
        } else if (pts.size === 2) {
          const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (pinch) this.dist *= pinch / d; pinch = d;
        }
      });
      const up = (e) => {
        pts.delete(e.pointerId); if (pts.size < 2) pinch = 0;
        if (this.dragging && this.dragging.id === e.pointerId) {
          this.dragging = null; canvas.style.cursor = '';
          if (this.sim) { this.sim.grab = null; if (this.onRelease) this.onRelease(this.sim); }
        }
      };
      canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
      canvas.addEventListener('dblclick', (e) => {
        if (!this.canGrab || !this.canGrab()) return;
        const h = this.pick(e); if (h && this.onPin) this.onPin(this.sim, h.node);
      });
      canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.dist *= Math.exp(e.deltaY * 0.0012); }, { passive: false });
    },
    applyTheme() {
      if (!this.renderer) return;
      this.colors = {
        bg: new THREE.Color(css('--stage')), paper: new THREE.Color(css('--paper')), back: new THREE.Color(css('--paper-back')),
        M: new THREE.Color(css('--m3d')), V: new THREE.Color(css('--v3d')), B: new THREE.Color(css('--b3d')),
        lid: new THREE.Color(css('--lid')), grid: new THREE.Color(css('--grid3d')), accent: new THREE.Color(css('--accent')),
        warm: new THREE.Color('#f2c14e'), hot: new THREE.Color('#d1453b'),
      };
      this.scene.background = this.colors.bg;
      if (this.sim) this.setSim(this.sim, false);
    },
    setSim(s, fit) {
      if (!this.renderer) { this.sim = s; return; }
      this.sim = s;
      for (const o of this.objs || []) { this.scene.remove(o); o.geometry && o.geometry.dispose(); }
      this.objs = [];
      const F = s.mesh.faces.length;
      const pos = new THREE.BufferAttribute(new Float32Array(F * 9), 3);
      const nor = new THREE.BufferAttribute(new Float32Array(F * 9), 3);
      const gF = new THREE.BufferGeometry(), gB = new THREE.BufferGeometry();
      gF.setAttribute('position', pos); gF.setAttribute('normal', nor);
      gB.setAttribute('position', pos); gB.setAttribute('normal', nor);
      this.cF = new THREE.BufferAttribute(new Float32Array(F * 9), 3);
      this.cB = new THREE.BufferAttribute(new Float32Array(F * 9), 3);
      gF.setAttribute('color', this.cF); gB.setAttribute('color', this.cB);
      const mk = (side) => new THREE.MeshStandardMaterial({ vertexColors: true, side, flatShading: true, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      this.front = new THREE.Mesh(gF, mk(THREE.FrontSide));
      this.back = new THREE.Mesh(gB, mk(THREE.BackSide));
      this.gF = gF; this.pos = pos;
      // face -> bars for strain colouring
      const bi = new Map(); s.bars.forEach((b, i) => bi.set(CL.ekey(b.i, b.j), i));
      this.faceBars = s.mesh.faces.map((f) => [bi.get(CL.ekey(f[0], f[1])), bi.get(CL.ekey(f[1], f[2])), bi.get(CL.ekey(f[2], f[0]))]);
      this.strainBuf = new Float64Array(s.bars.length);
      // crease lines
      this.lineBars = s.bars.filter((b) => b.asg === 'M' || b.asg === 'V' || b.asg === 'B');
      const lg = new THREE.BufferGeometry();
      this.lpos = new THREE.BufferAttribute(new Float32Array(this.lineBars.length * 6), 3);
      const lc = new Float32Array(this.lineBars.length * 6);
      this.lineBars.forEach((b, i) => { const c = this.colors[b.asg]; for (let k = 0; k < 2; k++) { lc[6 * i + 3 * k] = c.r; lc[6 * i + 3 * k + 1] = c.g; lc[6 * i + 3 * k + 2] = c.b; } });
      lg.setAttribute('position', this.lpos); lg.setAttribute('color', new THREE.BufferAttribute(lc, 3));
      this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
      this.objs.push(this.front, this.back, this.lines);
      // tower lids and tendon
      this.lids = [];
      if (s.mesh.pat.lids) {
        for (const g of s.mesh.pat.lids) {
          const lgm = new THREE.BufferGeometry();
          const lp = new THREE.BufferAttribute(new Float32Array((g.length - 2) * 9), 3);
          lgm.setAttribute('position', lp);
          const m = new THREE.Mesh(lgm, new THREE.MeshStandardMaterial({ color: this.colors.lid, transparent: true, opacity: s.mesh.pat.kind === 'robot' ? 0.35 : 0.7, side: THREE.DoubleSide, roughness: 1, depthWrite: s.mesh.pat.kind !== 'robot' }));
          this.lids.push({ g, lp, m, geo: lgm }); this.objs.push(m);
        }
      }
      if (s.mesh.pat.groups) {
        const tg = new THREE.BufferGeometry();
        this.tpos = new THREE.BufferAttribute(new Float32Array(6), 3); tg.setAttribute('position', this.tpos);
        this.tendonLine = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: this.colors.accent }));
        this.objs.push(this.tendonLine);
      } else this.tendonLine = null;
      // robot: cables, foot pads, trail
      this.cableObj = null; this.feetObj = null; this.trailObj = null;
      if (s.mesh.pat.kind === 'robot') {
        const cg = new THREE.BufferGeometry(); let segs = 0;
        for (const c of s.mesh.pat.cables) segs += c.eyes.length - 1;
        this.cpos = new THREE.BufferAttribute(new Float32Array(segs * 6), 3);
        this.ccol = new THREE.BufferAttribute(new Float32Array(segs * 6), 3);
        cg.setAttribute('position', this.cpos); cg.setAttribute('color', this.ccol);
        this.cableObj = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
        this.cableObj.renderOrder = 5;
        // foot pads: one flat rectangle under each end plate (two triangles over its four contact points)
        const P = s.mesh.pat.feet;
        this.pads = ['rear', 'front', 'mid'].filter((end) => P[end] && P[end].left.length).map((end) => {
          const f = P[end]; // left: [aft, fore], right: [aft, fore]
          const quad = [f.left[0], f.left[1], f.right[1], f.right[0]];
          const g = new THREE.BufferGeometry();
          const pos = new THREE.BufferAttribute(new Float32Array(18), 3); g.setAttribute('position', pos);
          const mat = new THREE.MeshBasicMaterial({ color: this.colors.B, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
          const mesh = new THREE.Mesh(g, mat);
          this.objs.push(mesh);
          return { end, quad, pos, mat, ids: f };
        });
        // hinged joints (Transform bench): the pin axis, the frame to each plate, and the two tendons
        this.jointObj = null;
        if (s.mesh.pat.joints && s.mesh.pat.joints.length) {
          const jg = new THREE.BufferGeometry(), segs = 7 * s.mesh.pat.joints.length;
          this.jpos = new THREE.BufferAttribute(new Float32Array(segs * 6), 3);
          this.jcol = new THREE.BufferAttribute(new Float32Array(segs * 6), 3);
          jg.setAttribute('position', this.jpos); jg.setAttribute('color', this.jcol);
          this.jointObj = new THREE.LineSegments(jg, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
          this.jointObj.renderOrder = 5; this.objs.push(this.jointObj);
        }
        const tg = new THREE.BufferGeometry();
        this.trailPos = new THREE.BufferAttribute(new Float32Array(3 * 2000), 3);
        tg.setAttribute('position', this.trailPos); tg.setDrawRange(0, 0);
        this.trailObj = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: this.colors.accent, transparent: true, opacity: 0.8 }));
        this.objs.push(this.cableObj, this.trailObj);
      }
      // pinned points, the hand's pull line and the selected crease
      const pg = new THREE.BufferGeometry();
      this.pinPos = new THREE.BufferAttribute(new Float32Array(3 * s.N), 3); pg.setAttribute('position', this.pinPos); pg.setDrawRange(0, 0);
      this.pinObj = new THREE.Points(pg, new THREE.PointsMaterial({ color: this.colors.accent, size: 9, sizeAttenuation: false, depthTest: false }));
      this.pinObj.renderOrder = 6;
      const hg = new THREE.BufferGeometry();
      this.handPos = new THREE.BufferAttribute(new Float32Array(6), 3); hg.setAttribute('position', this.handPos);
      this.handObj = new THREE.Line(hg, new THREE.LineBasicMaterial({ color: this.colors.accent, depthTest: false }));
      this.handObj.renderOrder = 7;
      const sg = new THREE.BufferGeometry();
      this.selPos = new THREE.BufferAttribute(new Float32Array(6), 3); sg.setAttribute('position', this.selPos);
      this.selObj = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: this.colors.warm, depthTest: false }));
      this.selObj.renderOrder = 8;
      this.selEdge = null;
      this.objs.push(this.pinObj, this.handObj, this.selObj);
      // ground grid
      let r = 0; const x0 = s.mesh.x0; const c = [0, 0, 0];
      for (let i = 0; i < s.N; i++) for (let k = 0; k < 3; k++) c[k] += x0[3 * i + k] / s.N;
      for (let i = 0; i < s.N; i++) r = Math.max(r, Math.hypot(x0[3 * i] - c[0], x0[3 * i + 1] - c[1], x0[3 * i + 2] - c[2]));
      this.radius = r;
      const size = Math.ceil(r * 3);
      const grid = new THREE.GridHelper(size * 2, size * 4, this.colors.grid, this.colors.grid);
      grid.rotation.x = Math.PI / 2; grid.material.transparent = true; grid.material.opacity = 0.7;
      this.grid = grid; this.objs.push(grid);
      for (const o of this.objs) this.scene.add(o);
      const kind = s.mesh.pat.kind;
      if (fit) {
        this.dist = kind === 'tower' ? r * 5 + 1 : kind === 'robot' ? r * 4.2 + 2 : r * 3.1 + 0.5; this.target.set(c[0], c[1], c[2]);
        this.phi = kind === 'tower' ? 0.35 : kind === 'robot' ? 0.62 : 0.75; this.theta = kind === 'robot' ? -1.15 : -1.1;
      }
      this.gridZ = null;
      this.update(true);
    },
    update(force) {
      if (!this.renderer || !this.sim) return;
      const s = this.sim, x = s.x, P = this.pos.array, faces = s.mesh.faces;
      let mn = Infinity, cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < s.N; i++) { cx += x[3 * i]; cy += x[3 * i + 1]; cz += x[3 * i + 2]; mn = Math.min(mn, x[3 * i + 2]); }
      cx /= s.N; cy /= s.N; cz /= s.N;
      faces.forEach((f, q) => { for (let k = 0; k < 3; k++) { const n = f[k]; P[9 * q + 3 * k] = x[3 * n]; P[9 * q + 3 * k + 1] = x[3 * n + 1]; P[9 * q + 3 * k + 2] = x[3 * n + 2]; } });
      this.pos.needsUpdate = true;
      this.gF.computeVertexNormals();
      // colours
      const CF = this.cF.array, CB = this.cB.array, col = this.colors;
      if (state.strainMap) s.strains(this.strainBuf);
      const tmp = new THREE.Color();
      faces.forEach((f, q) => {
        let a = col.paper;
        if (state.strainMap) {
          let m = 0; for (const b of this.faceBars[q]) if (b !== undefined) m = Math.max(m, Math.abs(this.strainBuf[b]));
          const t = Math.min(1, m / 0.03);
          if (t < 0.5) tmp.copy(col.paper).lerp(col.warm, t * 2); else tmp.copy(col.warm).lerp(col.hot, (t - 0.5) * 2);
          a = tmp;
        }
        const b = state.strainMap ? a : col.back;
        for (let k = 0; k < 3; k++) {
          const o = 9 * q + 3 * k;
          CF[o] = a.r; CF[o + 1] = a.g; CF[o + 2] = a.b; CB[o] = b.r; CB[o + 1] = b.g; CB[o + 2] = b.b;
        }
      });
      this.cF.needsUpdate = true; this.cB.needsUpdate = true;
      const L = this.lpos.array;
      this.lineBars.forEach((b, i) => { for (let k = 0; k < 3; k++) { L[6 * i + k] = x[3 * b.i + k]; L[6 * i + 3 + k] = x[3 * b.j + k]; } });
      this.lpos.needsUpdate = true;
      this.lines.visible = state.showCreases;
      for (const l of this.lids) {
        const a = l.lp.array, g = l.g;
        for (let t = 1; t < g.length - 1; t++) for (const [k, n] of [[0, g[0]], [1, g[t]], [2, g[t + 1]]]) for (let d = 0; d < 3; d++) a[9 * (t - 1) + 3 * k + d] = x[3 * n + d];
        l.lp.needsUpdate = true; l.geo.computeVertexNormals();
      }
      if (this.tendonLine) {
        const grp = s.mesh.pat.groups, T = this.tpos.array;
        const cen = (g) => { const c = [0, 0, 0]; for (const n of g) for (let d = 0; d < 3; d++) c[d] += x[3 * n + d] / g.length; return c; };
        const a = cen(grp.bottom), b = cen(grp.top);
        T.set([a[0], a[1], a[2], b[0], b[1], b[2]]); this.tpos.needsUpdate = true;
        this.tendonLine.visible = s.tendon > 0;
      }
      // pins, hand, selected crease
      { let c = 0; const P = this.pinPos.array;
        for (let i = 0; i < s.N; i++) if (s.fixed[i] && !(s.mesh.pat.kind === 'tower')) { P[3 * c] = x[3 * i]; P[3 * c + 1] = x[3 * i + 1]; P[3 * c + 2] = x[3 * i + 2]; c++; }
        this.pinObj.geometry.setDrawRange(0, c); this.pinPos.needsUpdate = true;
        if (s.grab) {
          const g = s.grab, t = g.target, p = [0, 0, 0];
          g.nodes.forEach((n, q) => { for (let d = 0; d < 3; d++) p[d] += g.w[q] * x[3 * n + d]; });
          this.handPos.array.set([p[0], p[1], p[2], t[0], t[1], t[2]]); this.handPos.needsUpdate = true;
        }
        this.handObj.visible = !!s.grab;
        const se = this.selEdge;
        if (se) { this.selPos.array.set([x[3 * se[0]], x[3 * se[0] + 1], x[3 * se[0] + 2], x[3 * se[1]], x[3 * se[1] + 1], x[3 * se[1] + 2]]); this.selPos.needsUpdate = true; }
        this.selObj.visible = !!se;
      }
      // smooth camera target and floor
      const k = force ? 1 : (this.dragging ? 0.01 : 0.08);
      const kind = s.mesh.pat.kind;
      if (kind === 'robot') this.updateRobot(s, force);
      if (kind !== 'tower') this.target.lerp(new THREE.Vector3(cx, cy, kind === 'robot' ? cz * 0.6 : cz), k);
      else this.target.lerp(new THREE.Vector3(0, 0, s.restHeight() * 0.45), k);
      const gz = (kind === 'tower' || kind === 'robot' ? 0 : mn - 0.25);
      this.gridZ = this.gridZ === null || force ? gz : this.gridZ + (gz - this.gridZ) * 0.05;
      if (kind === 'robot') this.grid.position.set(Math.round(this.target.x), Math.round(this.target.y), 0);
      else this.grid.position.set(this.target.x, this.target.y, this.gridZ);
      const cp = Math.cos(this.phi);
      this.camera.position.set(this.target.x + this.dist * cp * Math.cos(this.theta), this.target.y + this.dist * cp * Math.sin(this.theta), this.target.z + this.dist * Math.sin(this.phi));
      this.camera.lookAt(this.target);
      this.renderer.render(this.scene, this.camera);
    },
    updateRobot(s, force) {
      const pat = s.mesh.pat, x = s.x, col = this.colors;
      const C = this.cpos.array, K = this.ccol.array; let q = 0;
      const lo = col.grid, hi = col.accent, tmp = new THREE.Color();
      pat.cables.forEach((c, ci) => {
        const t = Math.min(1, s.cableT[ci] / (0.8 * (s.tensionScale || 1)));
        tmp.copy(lo).lerp(hi, 0.25 + 0.75 * t);
        let a = s.eyelet(c.eyes[0]);
        for (let e = 1; e < c.eyes.length; e++) {
          const b = s.eyelet(c.eyes[e]);
          C.set([a[0], a[1], a[2], b[0], b[1], b[2]], 6 * q);
          K.set([tmp.r, tmp.g, tmp.b, tmp.r, tmp.g, tmp.b], 6 * q);
          a = b; q++;
        }
      });
      this.cpos.needsUpdate = true; this.ccol.needsUpdate = true;
      if (this.jointObj) {
        const J = this.jpos.array, Kc = this.jcol.array; let n = 0;
        const put = (a, b, c) => { J.set([a[0], a[1], a[2], b[0], b[1], b[2]], 6 * n); Kc.set([c.r, c.g, c.b, c.r, c.g, c.b], 6 * n); n++; };
        const P = (i) => [x[3 * i], x[3 * i + 1], x[3 * i + 2]];
        pat.joints.forEach((jt, ji) => {
          const p0 = P(jt.pins[0]), p1 = P(jt.pins[1]), ca = s.centroid(pat.rings[jt.a]), cb = s.centroid(pat.rings[jt.b]);
          put(p0, p1, col.B); put(p0, ca, col.B); put(p1, ca, col.B); put(p0, cb, col.B); put(p1, cb, col.B);
          jt.tendons.forEach((t, ti) => { tmp.copy(lo).lerp(col.warm, Math.min(1, (s.jointT[ji][ti] || 0) / 12)); put(s.eyelet(t.a), s.eyelet(t.b), tmp); });
        });
        this.jpos.needsUpdate = true; this.jcol.needsUpdate = true;
      }
      for (const pd of this.pads) {
        const q = pd.quad, A = pd.pos.array;
        const v = (i) => [x[3 * i], x[3 * i + 1], Math.max(0.004, x[3 * i + 2] + 0.004)];
        A.set([...v(q[0]), ...v(q[1]), ...v(q[2]), ...v(q[0]), ...v(q[2]), ...v(q[3])]);
        pd.pos.needsUpdate = true;
        const L = s.muS[pd.ids.left[0]] > 5, R = s.muS[pd.ids.right[0]] > 5;
        pd.mat.color.copy(L && R ? col.accent : L || R ? col.warm : col.B);
        pd.mat.opacity = L || R ? 0.95 : 0.28;
      }
    },
    pushTrail(p) {
      if (!this.trailObj) return;
      const g = this.trailObj.geometry, n = g.drawRange.count, A = this.trailPos.array;
      if (n >= 2000) { A.copyWithin(0, 3); A.set([p[0], p[1], 0.01], 3 * 1999); }
      else { A.set([p[0], p[1], 0.01], 3 * n); g.setDrawRange(0, n + 1); }
      this.trailPos.needsUpdate = true;
    },
  };

  // ================= UI builders =================
  function slider(host, cfg) {
    const id = 'in-' + cfg.id;
    const wrap = document.createElement('div'); wrap.className = 'param';
    wrap.innerHTML = `<label for="${id}">${cfg.label}</label><output for="${id}"></output><input type="range" id="${id}" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}">`;
    const inp = wrap.querySelector('input'), out = wrap.querySelector('output');
    const toVal = cfg.log ? (u) => Math.pow(10, u) : (u) => u;
    const toPos = cfg.log ? (v) => Math.log10(v) : (v) => v;
    inp.value = toPos(cfg.value);
    const show = () => { out.textContent = cfg.fmt(toVal(+inp.value)); };
    show();
    inp.addEventListener('input', () => { show(); cfg.onInput(toVal(+inp.value)); });
    if (cfg.onChange) inp.addEventListener('change', () => cfg.onChange(toVal(+inp.value)));
    host.appendChild(wrap);
    return { set(v) { inp.value = toPos(v); show(); } };
  }

  function renderPatternButtons() {
    const host = $('#patterns'); host.innerHTML = '';
    const items = Object.entries(CL.PATTERNS).map(([k, p]) => [k, p.name, p.kind === 'tower' ? 'tower · tendon' : 'sheet · creases']);
    if (state.custom) items.push(['custom', state.custom.title || 'Imported', 'imported']);
    for (const [k, name, sub] of items) {
      const b = document.createElement('button');
      b.className = 'pbtn'; b.type = 'button'; b.setAttribute('aria-pressed', String(k === state.key));
      b.innerHTML = `<span>${name}</span><small>${sub}</small>`;
      b.addEventListener('click', () => selectPattern(k));
      host.appendChild(b);
    }
    $('#blurb').textContent = state.key === 'custom' ? 'Imported crease pattern. Creases fold toward their assigned angle as you raise the fold slider.' : CL.PATTERNS[state.key].blurb;
  }

  function fmtParam(q) { return (v) => (q.int ? String(v) : (q.unit === '°' ? v.toFixed(1) + '°' : v.toFixed(2) + (q.unit ? ' ' + q.unit : ''))); }

  let paramCtl = {};
  function renderParams() {
    const host = $('#params'); host.innerHTML = ''; paramCtl = {};
    if (state.key === 'custom') { host.innerHTML = '<p class="hint">An imported pattern has fixed geometry. Edit its creases on the mat.</p>'; $('#resetParams').disabled = true; return; }
    $('#resetParams').disabled = false;
    for (const q of CL.PATTERNS[state.key].params) {
      paramCtl[q.key] = slider(host, {
        id: 'p-' + q.key, label: q.label, min: q.min, max: q.max, step: q.step, value: state.params[q.key], fmt: fmtParam(q),
        onInput: (v) => { state.params[q.key] = v; if (q.int) { state.overrides = {}; state.creaseAngles = {}; state.sel = null; } scheduleRebuild(); },
      });
    }
  }

  let foldCtl, tendonCtl;
  function renderActuation() {
    const host = $('#actuation'); host.innerHTML = '';
    if (pat.kind === 'tower') {
      tendonCtl = slider(host, { id: 'tendon', label: 'Tendon pull', min: 0, max: 6, step: 0.05, value: state.tendon, fmt: (v) => v.toFixed(2) + ' N*',
        onInput: (v) => { state.tendon = v; if (sim && !opt) sim.tendon = v; } });
      host.insertAdjacentHTML('beforeend', '<p class="hint">A cable from the base to the top lid. The base is clamped; the top can twist freely. *Units are relative to the bar stiffness.</p>');
      const b = document.createElement('div'); b.className = 'btns';
      b.innerHTML = '<button class="btn" type="button" id="pulse">Pulse tendon</button>';
      host.appendChild(b);
      $('#pulse').addEventListener('click', () => {
        const F = state.tendon; state.tendon = Math.max(F, 3); tendonCtl.set(state.tendon); if (sim) sim.tendon = state.tendon;
        setTimeout(() => { state.tendon = 0; tendonCtl.set(0); if (sim) sim.tendon = 0; }, 900);
      });
    } else {
      foldCtl = slider(host, { id: 'fold', label: 'Fold amount', min: 0, max: 0.98, step: 0.01, value: state.fold, fmt: (v) => fmtPct(v),
        onInput: (v) => { state.fold = v; state.animate = false; $('#animate').checked = false; if (sim && !opt) setFoldAll(v); } });
      host.insertAdjacentHTML('beforeend', '<p class="hint">Every mountain and valley hinge is driven toward ±180° × fold amount, like a uniform actuator on each crease.</p>');
      const t = document.createElement('label'); t.className = 'toggle';
      t.innerHTML = `<input type="checkbox" id="animate" ${state.animate ? 'checked' : ''}> Cycle fold open and closed`;
      host.appendChild(t);
      $('#animate').addEventListener('change', (e) => { state.animate = e.target.checked; animT = Math.asin(Math.min(1, state.fold / 0.9)); });
      const m = document.createElement('label'); m.className = 'toggle';
      m.innerHTML = `<input type="checkbox" id="memory" ${state.memory ? 'checked' : ''}> Creases keep the shape you fold by hand`;
      host.appendChild(m);
      $('#memory').addEventListener('change', (e) => { state.memory = e.target.checked; if (!e.target.checked && sim) setFoldAll(state.fold); });
      host.insertAdjacentHTML('beforeend', '<p class="hint">To fold by hand, drag the paper in the 3D view. Double-click a corner to pin it down first so the sheet does not just slide.</p>');
    }
  }

  let matCtl = {};
  function renderMaterial() {
    const host = $('#material'); host.innerHTML = '';
    const upd = () => { if (sim) sim.setStiffness(state.stiff.axial, state.stiff.fold, state.stiff.facet); };
    matCtl.axial = slider(host, { id: 'axial', label: 'Bar (stretch) stiffness', min: 5, max: 200, step: 1, value: state.stiff.axial, fmt: (v) => v.toFixed(0), onInput: (v) => { state.stiff.axial = v; upd(); } });
    matCtl.fold = slider(host, { id: 'foldk', label: 'Crease stiffness', min: -3, max: 0.7, step: 0.01, log: true, value: state.stiff.fold, fmt: (v) => v.toPrecision(2), onInput: (v) => { state.stiff.fold = v; upd(); } });
    matCtl.facet = slider(host, { id: 'facetk', label: 'Panel bending stiffness', min: -3, max: 1, step: 0.01, log: true, value: state.stiff.facet, fmt: (v) => v.toPrecision(2), onInput: (v) => { state.stiff.facet = v; upd(); } });
    slider(host, { id: 'damp', label: 'Damping', min: 0.2, max: 6, step: 0.1, value: state.damping, fmt: (v) => v.toFixed(1), onInput: (v) => { state.damping = v; if (sim) sim.damping = v; } });
  }

  // ================= crease pattern on the mat =================
  function drawCP() {
    const svg = $('#cp'), { verts, edges } = pat.cp;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of verts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = Math.max(x1 - x0, y1 - y0) * 0.08 + 0.4;
    const W = x1 - x0 + 2 * pad, H = y1 - y0 + 2 * pad;
    svg.setAttribute('viewBox', `${x0 - pad} ${-(y1 + pad)} ${W} ${H}`);
    const step = W > 14 ? 2 : W > 7 ? 1 : 0.5;
    let g = '';
    const gx0 = Math.floor((x0 - pad) / step) * step, gy0 = Math.floor((y0 - pad) / step) * step;
    for (let x = gx0; x <= x1 + pad; x += step) {
      const major = Math.abs(x / (step * 5) - Math.round(x / (step * 5))) < 1e-6;
      g += `<line x1="${x}" y1="${-(y1 + pad)}" x2="${x}" y2="${-(y0 - pad)}" stroke="${major ? 'var(--mat-grid-major)' : 'var(--mat-grid)'}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    }
    for (let y = gy0; y <= y1 + pad; y += step) {
      const major = Math.abs(y / (step * 5) - Math.round(y / (step * 5))) < 1e-6;
      g += `<line x1="${x0 - pad}" y1="${-y}" x2="${x1 + pad}" y2="${-y}" stroke="${major ? 'var(--mat-grid-major)' : 'var(--mat-grid)'}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    }
    const fs = W / 34;
    g += `<text x="${x0 - pad + fs * 0.6}" y="${-(y1 + pad) + fs * 1.4}" font-family="IBM Plex Mono, monospace" font-size="${fs}" fill="var(--mat-label)">grid ${step} cm · ${(x1 - x0).toFixed(1)} × ${(y1 - y0).toFixed(1)} cm</text>`;
    // faces as paper
    let faces = '';
    for (const f of pat.cp.faces) faces += `<polygon points="${f.map((i) => verts[i][0] + ',' + -verts[i][1]).join(' ')}" fill="rgba(250,248,240,0.07)" stroke="none"/>`;
    const locked = pat.kind === 'tower';
    const style = { M: ['var(--cp-m)', '0.9', '6 2.5 1.5 2.5'], V: ['var(--cp-v)', '0.9', '5 3.5'], B: ['var(--cp-b)', '1.6', ''], F: ['var(--cp-f)', '1', '1 3.5'] };
    let es = '';
    edges.forEach((e, i) => {
      const [a, b, s] = e, st = style[s] || style.F;
      const p = verts[a], q = verts[b];
      const w = s === 'B' ? 1.6 : s === 'F' ? 1 : 2.2;
      es += `<g class="edge" data-i="${i}"><line class="e" x1="${p[0]}" y1="${-p[1]}" x2="${q[0]}" y2="${-q[1]}" stroke="${st[0]}" stroke-width="${w}" ${st[2] ? `stroke-dasharray="${st[2]}"` : ''}/>`
        + (s !== 'B' ? `<line class="edge-hit${locked ? ' locked' : ''}" x1="${p[0]}" y1="${-p[1]}" x2="${q[0]}" y2="${-q[1]}"><title>${{ M: 'Mountain', V: 'Valley', F: 'Flat panel line' }[s] || s} crease${locked ? '' : ' (click to change)'}</title></line>` : '') + '</g>';
    });
    let selHi = '';
    if (state.sel !== null && edges[state.sel]) {
      const [a, b] = edges[state.sel], p = verts[a], q = verts[b];
      selHi = `<line x1="${p[0]}" y1="${-p[1]}" x2="${q[0]}" y2="${-q[1]}" stroke="#f2c14e" stroke-width="7" stroke-opacity="0.55" stroke-linecap="round" vector-effect="non-scaling-stroke" pointer-events="none"/>`;
    }
    svg.innerHTML = g + faces + selHi + es;
    $('#cpHint').textContent = locked
      ? 'Unrolled strip. Glue the left and right edges into a tube; folds come from the tower geometry, so they are not editable here.'
      : 'Click a crease to select it: change its type, or fold just that one crease.';
    $('#resetAsg').disabled = locked || (!Object.keys(state.overrides).length && !Object.keys(state.creaseAngles).length);
  }
  $('#cp').addEventListener('click', (e) => {
    const g = e.target.closest('g.edge'); if (!g || pat.kind === 'tower' || opt) return;
    const i = +g.dataset.i;
    if (pat.cp.edges[i][2] === 'B') return;
    state.sel = i; drawCP(); renderSel();
  });
  $('#resetAsg').addEventListener('click', () => { state.overrides = {}; state.creaseAngles = {}; rebuild(false); });

  // ---- one crease at a time ----
  function hingeFor(i) {
    if (!sim || !pat.cp.edges[i]) return null;
    const [a, b] = pat.cp.edges[i], k = CL.ekey(pat.vmap[a], pat.vmap[b]);
    return sim.hinges.find((h) => CL.ekey(h.h1, h.h2) === k) || null;
  }
  function applyCreaseOverrides() {
    for (const [i, deg] of Object.entries(state.creaseAngles)) { const h = hingeFor(+i); if (h) h.target = deg * DEG; }
  }
  function setFoldAll(v) { sim.setFold(v); applyCreaseOverrides(); }
  let selAngleCtl = null;
  function renderSel() {
    const panel = $('#selPanel'), i = state.sel;
    if (i === null || i === undefined || !pat.cp.edges[i] || pat.kind === 'tower') { panel.hidden = true; view.selEdge = null; return; }
    panel.hidden = false;
    const e = pat.cp.edges[i], h = hingeFor(i);
    view.selEdge = [pat.vmap[e[0]], pat.vmap[e[1]]];
    const name = { M: 'Mountain', V: 'Valley', F: 'Flat panel line' }[e[2]] || e[2];
    $('#selTitle').textContent = `Crease ${i + 1} · ${name}`;
    for (const b of $('#selAsg').children) b.setAttribute('aria-pressed', String(b.dataset.v === e[2]));
    const host = $('#selAngle'); host.innerHTML = '';
    const held = state.creaseAngles[i] !== undefined;
    const cur = held ? state.creaseAngles[i] : h ? h.target / DEG : 0;
    selAngleCtl = slider(host, { id: 'selang', label: held ? 'This crease is held at' : 'Fold just this crease', min: -180, max: 180, step: 1, value: Math.round(cur),
      fmt: (v) => (v > 0 ? 'valley ' : v < 0 ? 'mountain ' : '') + Math.abs(v).toFixed(0) + '°',
      onInput: (v) => { state.creaseAngles[i] = v; const hh = hingeFor(i); if (hh) hh.target = v * DEG; $('#selFollow').disabled = false; } });
    host.insertAdjacentHTML('beforeend', '<p class="hint">Positive folds it as a valley, negative as a mountain. It stays held there until you let it follow the fold slider again.</p>');
    $('#selFollow').disabled = !held;
  }
  $('#selAsg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || state.sel === null) return;
    state.overrides[state.sel] = b.dataset.v;
    if (b.dataset.v === 'F') delete state.creaseAngles[state.sel];
    rebuild(false);
  });
  $('#selFollow').addEventListener('click', () => { delete state.creaseAngles[state.sel]; if (sim) setFoldAll(state.fold); renderSel(); });
  $('#selClose').addEventListener('click', () => { state.sel = null; drawCP(); renderSel(); });

  // ---- hands-on: drag the paper, double-click to pin ----
  view.canGrab = () => (mode === 'fold' && !opt) || mode === 'move' || mode === 'transform';
  view.onGrab = () => {
    if (state.paused) { state.paused = false; const b = $('#tPause'); b.setAttribute('aria-pressed', 'false'); b.textContent = 'Pause'; }
    if (mode === 'fold' && state.animate) { state.animate = false; const a = $('#animate'); if (a) a.checked = false; }
  };
  view.onRelease = (s) => {
    if (mode === 'fold' && s.mesh.pat.kind === 'sheet' && state.memory) { s.setCreasesToCurrent(); applyCreaseOverrides(); }
  };
  view.onPin = (s, n) => {
    if (s.mesh.pat.kind === 'tower' && s.mesh.pat.groups.bottom.includes(n)) return;
    s.fixed[n] = s.fixed[n] ? 0 : 1; s.v[3 * n] = s.v[3 * n + 1] = s.v[3 * n + 2] = 0;
    view.update();
  };

  // ================= sim lifecycle =================
  let rebuildQueued = false;
  function scheduleRebuild() { if (rebuildQueued) return; rebuildQueued = true; requestAnimationFrame(() => { rebuildQueued = false; rebuild(false); }); }
  function rebuild(fit) {
    if (opt) stopOpt();
    try {
      pat = CL.buildPattern(state.key, state.params, state.overrides, state.custom);
      sim = CL.buildMesh(pat, state.stiff);
    } catch (err) { console.error(err); return; }
    sim.damping = state.damping;
    if (state.sel !== null && !pat.cp.edges[state.sel]) state.sel = null;
    for (const i of Object.keys(state.creaseAngles)) if (!pat.cp.edges[i] || pat.cp.edges[i][2] === 'F') delete state.creaseAngles[i];
    if (pat.kind === 'tower') sim.tendon = state.tendon; else { setFoldAll(state.fold * 0.5); sim.step(150); setFoldAll(state.fold); }
    if (mode === 'fold') view.setSim(sim, fit);
    drawCP(); renderSel();
    hud(true);
    $('#optApply').disabled = true;
  }
  function selectPattern(k) {
    if (opt) stopOpt();
    state.key = k; state.overrides = {}; state.creaseAngles = {}; state.sel = null;
    if (k !== 'custom') { state.params = CL.defaultParams(k); state.stiff = Object.assign({}, CL.PATTERNS[k].stiffness); }
    else state.stiff = { axial: 50, fold: 0.7, facet: 1.5 };
    rebuild(true);
    renderPatternButtons(); renderParams(); renderActuation(); renderMaterial(); renderObjectives();
    clearOptChart(); measure();
  }
  $('#resetParams').addEventListener('click', () => { state.params = CL.defaultParams(state.key); state.overrides = {}; renderParams(); rebuild(false); });

  // ================= HUD =================
  function hud(force) {
    if (!sim || mode !== 'fold') return;
    if (!force && frame % 8) return;
    const s = opt && opt.preview ? opt.preview : sim;
    const st = s.maxStrain(), E = s.energy().total;
    const chips = [];
    if (s.mesh.pat.kind === 'tower') {
      chips.push(['Height', fmtPct(s.height() / s.restHeight())], ['Twist', s.twist().toFixed(1) + '°'], ['Tendon', s.tendon.toFixed(2)]);
    } else {
      chips.push(['Fold', fmtPct(s.foldPct)], ['Footprint', fmtPct(s.areaRatio())]);
    }
    chips.push(['Max strain', (st * 100).toFixed(2) + '%', st > 0.03], ['Energy', E.toFixed(3)]);
    if (opt) chips.push(['Optimizer', 'showing candidate ' + opt.count]);
    $('#hud').innerHTML = chips.map(([k, v, w]) => `<span class="chip${w ? ' warn' : ''}">${k} <b>${v}</b></span>`).join('')
      + (opt ? '' : `<span class="chip hint">Drag the paper to fold it · double-click to pin a point · drag empty space to turn</span>`);
  }

  // ================= main loop =================
  function loop() {
    frame++;
    if (mode === 'transform' || (mode === 'build' && B.view === '3d' && B.robot === 'transformer')) { transformTick(); requestAnimationFrame(loop); return; }
    if (mode === 'move' || (mode === 'build' && B.view === '3d')) { moveTick(); requestAnimationFrame(loop); return; }
    if (mode === 'build') { requestAnimationFrame(loop); return; }
    if (mode === 'modules') { modTick(); requestAnimationFrame(loop); return; }
    if (sim && !opt && !state.paused) {
      if (state.animate && pat.kind !== 'tower') {
        animT += 0.012;
        state.fold = 0.9 * Math.abs(Math.sin(animT));
        setFoldAll(state.fold);
        if (foldCtl && frame % 3 === 0) foldCtl.set(state.fold);
      }
      sim.step(pat.kind === 'tower' ? 30 : 24);
      if (!isFinite(sim.x[0])) { rebuild(false); }
      view.update();
      hud();
    } else if (opt && opt.preview) { view.update(); hud(); }
    else if (state.paused) view.update();
    requestAnimationFrame(loop);
  }

  // stage tools
  function togglePressed(btn, v) { btn.setAttribute('aria-pressed', String(v)); }
  $('#tStrain').addEventListener('click', (e) => { state.strainMap = !state.strainMap; togglePressed(e.currentTarget, state.strainMap); $('#strainbar').classList.toggle('on', state.strainMap); view.update(); });
  $('#tCreases').addEventListener('click', (e) => { state.showCreases = !state.showCreases; togglePressed(e.currentTarget, state.showCreases); view.update(); });
  $('#tPause').addEventListener('click', (e) => { state.paused = !state.paused; togglePressed(e.currentTarget, state.paused); e.currentTarget.textContent = state.paused ? 'Resume' : 'Pause'; });
  $('#tView').addEventListener('click', () => { if (view.sim) view.setSim(view.sim, true); });

  // ================= charts =================
  function niceTicks(a, b, n) {
    if (a === b) { a -= 1; b += 1; }
    const span = b - a, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const st = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const t = []; for (let v = Math.ceil(a / st) * st; v <= b + 1e-9; v += st) t.push(+v.toFixed(10));
    return { ticks: t, lo: Math.min(a, t[0]), hi: Math.max(b, t[t.length - 1]) };
  }
  function chart(svg, cfg) {
    const W = 360, H = cfg.h || 170, m = { l: 44, r: 10, t: 12, b: 30 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const all = cfg.series.flatMap((s) => s.pts);
    if (!all.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">${cfg.empty || ''}</text>`; return; }
    let xmn = cfg.xmin ?? Math.min(...all.map((p) => p[0])), xmx = cfg.xmax ?? Math.max(...all.map((p) => p[0]));
    let ymn = Math.min(...all.map((p) => p[1])), ymx = Math.max(...all.map((p) => p[1]));
    if (cfg.ymin !== undefined) ymn = Math.min(ymn, cfg.ymin);
    if (cfg.ymax !== undefined) ymx = Math.max(ymx, cfg.ymax);
    if (ymx - ymn < 1e-9) { ymx += 0.5; ymn -= 0.5; }
    const xt = niceTicks(xmn, xmx, 5), yt = niceTicks(ymn, ymx, 4);
    const X = (v) => m.l + ((v - xt.lo) / (xt.hi - xt.lo || 1)) * (W - m.l - m.r);
    const Y = (v) => H - m.b - ((v - yt.lo) / (yt.hi - yt.lo || 1)) * (H - m.t - m.b);
    let s = '';
    for (const t of yt.ticks) s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${m.l - 6}" y="${Y(t) + 3}" text-anchor="end">${cfg.yFmt(t)}</text>`;
    for (const t of xt.ticks) s += `<text x="${X(t)}" y="${H - m.b + 14}" text-anchor="middle">${cfg.xFmt(t)}</text>`;
    s += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
    if (cfg.zero && yt.lo < 0 && yt.hi > 0) s += `<line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    s += `<text x="${(m.l + W - m.r) / 2}" y="${H - 3}" text-anchor="middle">${cfg.xLabel}</text>`;
    s += `<text x="10" y="${(m.t + H - m.b) / 2}" text-anchor="middle" transform="rotate(-90 10 ${(m.t + H - m.b) / 2})">${cfg.yLabel}</text>`;
    for (const se of cfg.series) {
      if (se.dots) for (const p of se.pts) s += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="2.4" fill="${se.color}"/>`;
      else if (se.pts.length) {
        if (se.area) s += `<path d="M${X(se.pts[0][0])},${Y(Math.max(yt.lo, 0))} ${se.pts.map((p) => 'L' + X(p[0]) + ',' + Y(p[1])).join(' ')} L${X(se.pts[se.pts.length - 1][0])},${Y(Math.max(yt.lo, 0))} Z" fill="${se.color}" opacity="0.12"/>`;
        s += `<path d="${se.pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]) + ',' + Y(p[1])).join(' ')}" fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round"/>`;
        const e = se.pts[se.pts.length - 1];
        if (se.end) s += `<circle cx="${X(e[0])}" cy="${Y(e[1])}" r="3.5" fill="${se.color}"/>`;
      }
      if (se.marks) for (const mk of se.marks) s += `<circle cx="${X(mk[0])}" cy="${Y(mk[1])}" r="4" fill="var(--panel)" stroke="${se.color}" stroke-width="2"/><text x="${X(mk[0]) + 6}" y="${Y(mk[1]) - 6}" style="fill:var(--ink)">${mk[2]}</text>`;
    }
    svg.innerHTML = s;
  }

  // ================= optimizer =================
  function renderObjectives() {
    const sel = $('#objective');
    const kind = pat.kind;
    sel.innerHTML = CL.OBJECTIVES[kind].map((o) => `<option value="${o.key}">${o.label}</option>`).join('');
    const custom = state.key === 'custom';
    const cont = custom ? [] : CL.PATTERNS[state.key].params.filter((q) => !q.int);
    const fixed = custom ? [] : CL.PATTERNS[state.key].params.filter((q) => q.int);
    $('#optIntro').textContent = custom
      ? 'Imported patterns have no geometry parameters to search. Pick a built-in pattern to optimize.'
      : `Searches ${cont.map((q) => q.label.toLowerCase()).join(', ')} with CMA-ES, simulating every candidate to equilibrium.` + (fixed.length ? ` ${fixed.map((q) => q.label).join(' and ')} stay fixed.` : '');
    $('#optRun').disabled = custom;
    $('#foldTargetField').hidden = kind === 'tower';
    objHint();
  }
  function objHint() {
    const o = CL.OBJECTIVES[pat.kind].find((x) => x.key === $('#objective').value);
    $('#objHint').textContent = o ? o.hint + (o.key === 'stroke' ? ` Uses the tendon pull from Actuation (${state.tendon.toFixed(2)}).` : '') : '';
  }
  $('#objective').addEventListener('change', objHint);
  function clearOptChart() {
    chart($('#optChart'), { series: [], empty: 'Run a search to see each design scored', xFmt: String, yFmt: String });
    $('#optBest').innerHTML = ''; $('#optStatus').textContent = 'CMA-ES';
  }
  function stopOpt() {
    if (!opt) return;
    opt.stopped = true; opt = null;
    $('#optRun').textContent = 'Run search';
    if (sim) view.setSim(sim, false);
  }
  function startOpt() {
    if (opt) { stopOpt(); return; }
    const key = state.key, objKey = $('#objective').value;
    const ctx = { fold: +$('#optFold').value, tendon: state.tendon };
    const prob = CL.makeProblem(key, Object.assign({}, state.params), objKey, ctx, Object.assign({}, state.stiff));
    const es = new CL.CMAES(prob.encode(state.params), 0.22, { seed: (Math.random() * 1e9) | 0 });
    const start = prob.evaluate(prob.encode(state.params));
    opt = { prob, es, gens: +$('#optGens').value, gen: 0, queue: es.ask(), batch: [], all: [[0, start.score]], best: start, bestLine: [[0, start.score]], count: 0, start, preview: start.sim, stopped: false };
    $('#optRun').textContent = 'Stop';
    $('#optApply').disabled = true;
    view.setSim(start.sim, false);
    const tick = () => {
      if (!opt || opt.stopped) return;
      const t0 = performance.now();
      while (performance.now() - t0 < 28 && opt.queue.length) {
        const u = opt.queue.shift();
        const r = prob.evaluate(u);
        opt.count++;
        opt.batch.push([u, r]);
        opt.all.push([opt.count, r.score]);
        if (r.score > opt.best.score) opt.best = r;
        opt.bestLine.push([opt.count, opt.best.score]);
        opt.preview = r.sim;
      }
      if (!opt.queue.length) {
        opt.es.tell(opt.batch.map((b) => b[0]), opt.batch.map((b) => b[1].fitness));
        opt.batch = []; opt.gen++;
        if (opt.gen >= opt.gens) return finishOpt();
        opt.queue = opt.es.ask();
      }
      view.setSim(opt.preview, false);
      drawOpt();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function drawOpt() {
    if (!opt && !lastOpt) return;
    const o = opt || lastOpt;
    chart($('#optChart'), {
      series: [{ pts: o.all, color: 'var(--dot)', dots: true }, { pts: o.bestLine, color: 'var(--accent)', end: true }],
      xLabel: 'designs simulated', yLabel: 'score', xFmt: (v) => String(Math.round(v)), yFmt: (v) => +v.toPrecision(3) + '', xmin: 0,
    });
    $('#optStatus').textContent = opt ? `generation ${o.gen + 1} / ${o.gens}` : `done · ${o.count} designs`;
    const rows = [];
    const cont = o.prob.cont;
    rows.push(['Score', o.start.score.toFixed(3) + ' → ' + o.best.score.toFixed(3)]);
    for (const q of cont) rows.push([q.label, fmtParam(q)(o.start.params[q.key]) + ' → ' + fmtParam(q)(o.best.params[q.key])]);
    for (const [k, v] of Object.entries(o.best.info || {})) rows.push([k + ' (best)', typeof v === 'number' ? (/strain|Area|Stroke/.test(k) ? fmtPct(v, 1) : v.toFixed(3)) : v]);
    $('#optBest').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }
  let lastOpt = null;
  function finishOpt() {
    lastOpt = opt; opt = null;
    $('#optRun').textContent = 'Run search';
    $('#optApply').disabled = !(lastOpt.best.score > lastOpt.start.score);
    view.setSim(lastOpt.best.sim, false);
    drawOpt();
    hudFor(lastOpt.best.sim);
  }
  function hudFor(s) { const keep = sim; sim = s; hud(true); sim = keep; }
  $('#optRun').addEventListener('click', startOpt);
  $('#optApply').addEventListener('click', () => {
    if (!lastOpt) return;
    state.params = Object.assign({}, lastOpt.best.params);
    for (const [k, c] of Object.entries(paramCtl)) c.set(state.params[k]);
    if (pat.kind !== 'tower') { state.fold = +$('#optFold').value; if (foldCtl) foldCtl.set(state.fold); }
    rebuild(false); measure();
    $('#optApply').disabled = true;
  });

  // ================= characterize =================
  function measure() {
    const host = $('#measCharts'), verdict = $('#measVerdict');
    $('#measRun').disabled = true; $('#measRun').textContent = 'Measuring…';
    setTimeout(() => {
      try {
        const s = CL.buildMesh(CL.buildPattern(state.key, state.params, state.overrides, state.custom), Object.assign({}, state.stiff));
        s.damping = 2;
        if (s.mesh.pat.kind === 'tower') {
          $('#measHint').textContent = 'Push the top lid down step by step and record the force the tower pushes back with. A dip below zero means it snaps shut and stays there (bistable).';
          const c = CL.forceSweep(s, 32, 0.08);
          host.innerHTML = '<svg class="chart" id="mc1" role="img" aria-label="Force versus compression"></svg>';
          let mn = c[0], mx = c[0]; for (const p of c) { if (p.force < mn.force) mn = p; if (p.force > mx.force) mx = p; }
          const marks = [[mx.compression, mx.force, 'peak ' + mx.force.toFixed(2)]];
          if (mn.force < -1e-3) marks.push([mn.compression, mn.force, 'pull ' + mn.force.toFixed(2)]);
          chart($('#mc1'), { series: [{ pts: c.map((p) => [p.compression, p.force]), color: 'var(--accent)', area: true, marks }], zero: true,
            xLabel: 'compression (share of height)', yLabel: 'force', xFmt: (v) => fmtPct(v), yFmt: (v) => +v.toPrecision(2) + '' });
          // find the second zero crossing (stable folded state)
          let stable = null;
          for (let i = c.indexOf(mn) + 1; i < c.length; i++) if (c[i].force >= 0) { stable = c[i]; break; }
          verdict.hidden = false;
          verdict.innerHTML = mn.force < -1e-3
            ? `<b>Bistable.</b> It snaps after ${fmtPct(mx.compression)} compression${stable ? ` and rests again near ${fmtPct(stable.compression)}` : ''}. It takes ${mx.force.toFixed(2)} to trigger the snap.`
            : `<b>Monostable.</b> It always springs back. The peak resistance is ${mx.force.toFixed(2)}. Lower the twist, raise the height or soften the creases to get a snap.`;
        } else {
          $('#measHint').textContent = 'Fold from flat to 95% and record how much area the sheet still covers and how far its panels have to stretch.';
          const c = CL.foldSweep(s, 19, 0.95);
          host.innerHTML = '<svg class="chart" id="mc1" role="img" aria-label="Footprint versus fold"></svg><svg class="chart" id="mc2" role="img" aria-label="Strain versus fold"></svg>';
          chart($('#mc1'), { h: 150, series: [{ pts: c.map((p) => [p.p, p.area]), color: 'var(--accent)', area: true, end: true }], ymin: 0, ymax: 1,
            xLabel: 'fold amount', yLabel: 'footprint', xFmt: (v) => fmtPct(v), yFmt: (v) => fmtPct(v) });
          chart($('#mc2'), { h: 150, series: [{ pts: c.map((p) => [p.p, p.strain * 100]), color: 'var(--warn)', area: true, end: true }], ymin: 0,
            xLabel: 'fold amount', yLabel: 'max strain %', xFmt: (v) => fmtPct(v), yFmt: (v) => +v.toPrecision(2) + '' });
          let pk = c[0]; for (const p of c) if (p.strain > pk.strain) pk = p;
          const last = c[c.length - 1];
          verdict.hidden = false;
          verdict.innerHTML = `Folded to 95% it covers <b>${fmtPct(last.area)}</b> of its flat footprint. Panels stretch at most <b>${(pk.strain * 100).toFixed(2)}%</b> (at ${fmtPct(pk.p)} fold)` +
            (pk.strain < 0.005 ? ', so it folds almost rigidly.' : pk.strain < 0.03 ? ', which paper can absorb by bending panels slightly.' : '. Real paper would need to crumple, so look for a better geometry.');
        }
      } catch (err) { console.error(err); verdict.hidden = false; verdict.textContent = 'The sweep failed: ' + err.message; }
      $('#measRun').disabled = false; $('#measRun').textContent = 'Run sweep';
    }, 30);
  }
  $('#measRun').addEventListener('click', measure);

  // ================= FOLD =================
  function exportText() { const f = CL.toFOLD(pat, state.key === 'custom' ? (state.custom.title || 'imported') : CL.PATTERNS[state.key].name); return JSON.stringify(f, null, 1).replace(/\[\n\s+([^\[\]]*?)\n\s+\]/g, (m, inner) => '[' + inner.replace(/\s*\n\s*/g, ' ') + ']'); }
  $('#foldExport').addEventListener('click', () => { $('#foldText').value = exportText(); $('#foldCopy').hidden = false; $('#foldErr').hidden = true; });
  $('#foldCopy').addEventListener('click', async (e) => {
    const t = $('#foldText'), btn = e.currentTarget;
    try { await navigator.clipboard.writeText(t.value); btn.textContent = 'Copied'; }
    catch (_) { t.focus(); t.select(); btn.textContent = 'Selected, press Ctrl+C'; }
    setTimeout(() => (btn.textContent = 'Copy JSON'), 1800);
  });
  // ---- open any crease pattern (.fold, .cp, .svg) or a saved Crease Lab design (.json) ----
  function designStatus(msg, bad) { const el = $('#designStatus'); el.hidden = !msg; el.textContent = msg || ''; el.classList.toggle('err', !!bad); }
  function openDesign(text, name, errEl) {
    try {
      const res = CL.importDesign(text, name || '');
      if (res.kind === 'project') { restoreDesign(res.project, name); return true; }
      const c = res.pat;
      if (!c.cp.faces.length) throw new Error('No panels found. The lines need to close up into polygons, or the file needs faces_vertices.');
      c.title = (res.fold && res.fold.file_title) || name || 'Imported';
      state.custom = c;
      $('#foldErr').hidden = true;
      if (mode !== 'fold') setMode('fold');
      selectPattern('custom');
      const i = res.info || {};
      designStatus('Opened ' + JSON.stringify(c.title).slice(1, -1) + ' (' + res.format + '): ' + (i.creases != null ? i.creases + ' creases, ' : '') + (i.faces || i.triangles) + ' panels' +
        (i.scaled && Math.abs(i.scaled - 1) > 1e-6 ? ', rescaled to fit the bench' : '') + (i.addedBorder ? ', border added around the lines' : '') +
        (i.dropped ? ', ' + i.dropped + ' loose line' + (i.dropped > 1 ? 's' : '') + ' ignored' : '') + '. Press Fold to watch it fold.');
      return true;
    } catch (e) {
      const msg = 'Could not open that file: ' + e.message;
      if (errEl) { errEl.hidden = false; errEl.textContent = msg; } else designStatus(msg, true);
      return false;
    }
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function snapshotDesign() {
    return {
      creaseLab: 1, saved: new Date().toISOString(), mode,
      fold: { key: state.key, params: state.params, overrides: state.overrides, creaseAngles: state.creaseAngles, custom: state.key === 'custom' ? state.custom : null,
        fold: state.fold, tendon: state.tendon, stiff: state.stiff, damping: state.damping },
      move: { params: M.params, crease: M.crease, gaitKey: M.gaitKey, gait: M.gait },
      transform: { params: T.params, mode: T.mode, neck: T.neck },
      build: { robot: B.robot, camera: B.camera, R_mm: B.R_mm, spool: B.spool, board: B.board, power: B.power, servo: B.servo },
      modules: { p: MD.p, view: MD.view, modules: MD.modules, gait: MD.gait, feet: MD.feet, build: MD.build, board: MD.board },
    };
  }
  function restoreDesign(p, name) {
    if (opt) stopOpt();
    if (M.learn) stopLearn();
    stopMission();
    if (mode !== 'fold') setMode('fold');
    const f = p.fold || {};
    if (f.key === 'custom' && f.custom) state.custom = f.custom;
    const key = f.key === 'custom' ? (state.custom ? 'custom' : state.key) : (CL.PATTERNS[f.key] ? f.key : state.key);
    selectPattern(key);
    if (key !== 'custom' && f.params) Object.assign(state.params, f.params);
    if (f.stiff) Object.assign(state.stiff, f.stiff);
    if (f.overrides) state.overrides = clone(f.overrides);
    if (f.creaseAngles) state.creaseAngles = clone(f.creaseAngles);
    for (const k of ['fold', 'tendon', 'damping']) if (typeof f[k] === 'number') state[k] = f[k];
    rebuild(true); renderParams(); renderActuation(); renderMaterial(); measure();
    const mv = p.move || {};
    if (mv.params) Object.assign(M.params, mv.params);
    if (typeof mv.crease === 'number') M.crease = mv.crease;
    if (mv.gaitKey) M.gaitKey = mv.gaitKey;
    if (mv.gait) M.gait = clone(mv.gait);
    const tr = p.transform || {};
    if (tr.params) Object.assign(T.params, tr.params);
    if (tr.mode) T.mode = tr.mode;
    if (typeof tr.neck === 'number') T.neck = tr.neck;
    const bd = p.build || {};
    for (const k of ['robot', 'camera', 'R_mm', 'spool', 'board', 'power', 'servo']) if (bd[k] !== undefined) B[k] = bd[k];
    B.payloadKey = ''; B.tcheckKey = '';
    M.sim = null; T.sim = null;
    initMove(); initTransform(); renderBuildParams();
    const md = p.modules;
    if (md) {
      if (md.p && typeof md.p === 'object') {
        const d = CL.defaultModule(), q = Object.assign({}, d);
        for (const prm of CL.MODULE_PARAMS) if (prm.group !== 'mount' && typeof md.p[prm.key] === 'number' && isFinite(md.p[prm.key])) q[prm.key] = Math.max(prm.min, Math.min(prm.max, md.p[prm.key]));
        if (['servo', 'wire', 'spring'].includes(md.p.actuator)) q.actuator = md.p.actuator;
        if (CL.SERVOS[md.p.servo]) q.servo = md.p.servo;
        for (const kd of ['servo', 'wire', 'spring']) for (const key of ['s1', 's2', 'e', 'band']) {
          const v = md.p.mount && md.p.mount[kd] && md.p.mount[kd][key], prm = CL.MODULE_PARAMS.find((x) => x.key === key);
          if (typeof v === 'number' && isFinite(v)) q.mount[kd][key] = Math.max(prm.min, Math.min(prm.max, v));
        }
        MD.p = q;
      }
      const pick = (v, ok) => (ok.includes(v) ? v : undefined);
      const vals = { view: pick(md.view, ['rig', 'crawl']), gait: pick(md.gait, ['wave', 'together']), feet: pick(md.feet, ['directional', 'smooth']), build: pick(md.build, ['one', 'crawler']), board: pick(md.board, ['nano', 'esp32', 'pico']),
        modules: typeof md.modules === 'number' ? Math.max(1, Math.min(6, Math.round(md.modules))) : undefined };
      for (const k in vals) if (vals[k] !== undefined) MD[k] = vals[k];
      MD.timing = null; MD.rig = null; MD.crawler = null;
      if (MD.inited) { renderModParams(); modLive(); modAnalyze(); }
    }
    if (p.mode && p.mode !== 'fold') setMode(p.mode);
    designStatus('Opened design ' + JSON.stringify((name || 'file').replace(/(\.creaselab)?\.json$/i, '')).slice(1, -1) + (p.saved ? ' (saved ' + p.saved.slice(0, 10) + ')' : '') + ': every tab is back as it was.');
  }
  function readFile(f, cb) { const r = new FileReader(); r.onload = () => cb(String(r.result), f.name.replace(/\.(fold|json|cp|svg)$/i, ''), f.name); r.readAsText(f); }
  $('#foldLoad').addEventListener('click', () => { if (openDesign($('#foldText').value, '', $('#foldErr'))) $('#foldErr').hidden = true; });
  $('#foldFile').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    readFile(f, (text, title, full) => openFile(text, title, full, $('#foldErr')));
    e.target.value = '';
  });
  $('#openDesign').addEventListener('click', () => $('#designFile').click());
  $('#designFile').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    readFile(f, (text, title, full) => openFile(text, title, full));
    e.target.value = '';
  });
  function openFile(text, title, full, errEl) {
    // pass the extension through so the importer knows .cp from .svg, then put the bare title back
    const ok = openDesign(text, full, errEl);
    if (ok && state.key === 'custom' && state.custom && state.custom.title === full) { state.custom.title = title; designStatus($('#designStatus').textContent.replace(JSON.stringify(full).slice(1, -1), title)); }
    return ok;
  }
  $('#saveDesign').addEventListener('click', () => {
    const name = (state.key === 'custom' ? (state.custom.title || 'imported') : CL.PATTERNS[state.key].name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
    saveFile(name + '.creaselab.json', new Blob([JSON.stringify(snapshotDesign(), null, 1)], { type: 'application/json' }), $('#designStatus'));
    designStatus('Saved ' + name + '.creaselab.json. Open it again with Open design… to pick up where you left off.');
  });
  // drop a file anywhere on the bench
  const bench = document.querySelector('.bench');
  let dragDepth = 0;
  bench.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragDepth++; bench.classList.add('dropping'); } });
  bench.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  bench.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; bench.classList.remove('dropping'); } });
  bench.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    dragDepth = 0; bench.classList.remove('dropping');
    if (!f) return;
    e.preventDefault();
    readFile(f, (text, title, full) => openFile(text, title, full));
  });

  // ================= theme =================
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const retheme = () => { view.applyTheme(); try { MD.colors = null; } catch (_) {} };
  mq.addEventListener && mq.addEventListener('change', retheme);
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });


  // =====================================================================
  // MOVE: an origami crawler, its motion primitives and gaits
  // =====================================================================
  const M = {
    params: CL.defaultRobot(), crease: 0.12, gaitKey: 'inchworm',
    gait: JSON.parse(JSON.stringify(CL.GAITS.inchworm)),
    manual: null, // { contract, bend, dir, front, rear } while driving by hand
    speed: 2, sim: null, player: null, acc: 0, learn: null, lastLearn: null,
    start: null, lastTrail: -1, score: null,
  };
  const ANCHORS = [['', 'Slide'], ['true', 'Grip, both pads'], ['left', 'Grip, left pad'], ['right', 'Grip, right pad']];
  const anchorVal = (v) => (v === 'true' ? true : v || false);
  const anchorStr = (v) => (v === true ? 'true' : v || '');
  const DIRS = [[0, 'Left'], [90, 'Up'], [180, 'Right'], [270, 'Down']];

  function buildRobotSim(fit) {
    if (M.learn) stopLearn();
    M.sim = CL.buildRobot(M.params, { fold: M.crease, facet: M.crease });
    M.sim.tensionScale = CL.tensionScaleFor(M.sim);
    M.player = new CL.GaitPlayer(M.gait);
    M.start = M.sim.com(); M.startHeading = M.sim.heading(); M.lastTrail = -1;
    if (mode === 'move') { view.setSim(M.sim, fit); view.pushTrail(M.start); }
  }

  function renderRobotParams() {
    const host = $('#robotParams'); host.innerHTML = '';
    for (const q of CL.ROBOT_PARAMS) {
      slider(host, { id: 'r-' + q.key, label: q.label, min: q.min, max: q.max, step: q.step, value: M.params[q.key], fmt: fmtParam(q),
        onInput: (v) => { M.params[q.key] = v; scheduleRobot(); } });
    }
    const mat = $('#robotMat'); mat.innerHTML = '';
    slider(mat, { id: 'r-crease', label: 'Crease stiffness', min: -1.6, max: -0.3, step: 0.01, log: true, value: M.crease, fmt: (v) => v.toPrecision(2),
      onInput: (v) => { M.crease = v; scheduleRobot(); } });
    mat.insertAdjacentHTML('beforeend', '<p class="hint">Stiffer creases spring back faster after a contraction but need more cable tension to fold. Cable tension scales with it.</p>');
    renderChirality();
  }
  function renderChirality() {
    for (const b of $('#chirality').children) b.setAttribute('aria-pressed', String(b.dataset.v === M.params.chirality));
    $('#chirHint').textContent = M.params.chirality === 'same'
      ? 'Every cell twists the same way, so contracting also screws the head plate around the body axis. That is the twist primitive.'
      : 'Neighbouring cells twist opposite ways, so their twists cancel and the head contracts straight back.';
  }
  $('#chirality').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; M.params.chirality = b.dataset.v; renderChirality(); buildRobotSim(false); });
  let robotQueued = false;
  function scheduleRobot() { if (robotQueued) return; robotQueued = true; requestAnimationFrame(() => { robotQueued = false; buildRobotSim(false); }); }
  $('#robotReset').addEventListener('click', () => { M.params = CL.defaultRobot(); M.crease = 0.12; renderRobotParams(); buildRobotSim(true); });

  function renderFeet() {
    const host = $('#feet'); host.innerHTML = '';
    for (const [k, f] of Object.entries(CL.FEET)) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = f.label;
      b.setAttribute('aria-pressed', String(k === M.gait.feet));
      b.addEventListener('click', () => { M.gait.feet = k; renderFeet(); renderPhases(); syncAnchorsUI(); });
      host.appendChild(b);
    }
    $('#feetHint').textContent = CL.FEET[M.gait.feet].blurb;
  }

  // ---- primitives (manual drive) ----
  let manCtl = {};
  function renderPrimitives() {
    $('#prims').innerHTML = CL.PRIMITIVES.map((p) => `<li><b>${p.name}</b><span>${p.what}</span></li>`).join('');
    const host = $('#manual'); host.innerHTML = ''; manCtl = {};
    manCtl.contract = slider(host, { id: 'm-contract', label: 'Contract (all cables)', min: 0, max: 1, step: 0.01, value: 0, fmt: (v) => fmtPct(v), onInput: (v) => { takeManual().contract = v; } });
    manCtl.bend = slider(host, { id: 'm-bend', label: 'Bend (one side extra)', min: 0, max: 1, step: 0.01, value: 0, fmt: (v) => fmtPct(v), onInput: (v) => { takeManual().bend = v; } });
    for (const sel of ['#anchorRear', '#anchorFront']) $(sel).innerHTML = ANCHORS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    syncAnchorsUI();
  }
  function takeManual() {
    if (!M.manual) {
      M.manual = { contract: 0, bend: 0, dir: 0, front: false, rear: false };
      setDrive();
    }
    return M.manual;
  }
  function setDrive() {
    $('#driveMode').textContent = M.manual ? 'hand control' : 'gait running';
    $('#resumeGait').disabled = !M.manual;
    for (const b of $('#bendDir').children) b.setAttribute('aria-pressed', String(M.manual && +b.dataset.v === M.manual.dir));
    renderPhaseHighlight(-1);
  }
  function syncAnchorsUI() {
    const on = M.gait.feet === 'anchors';
    $('#anchorRear').disabled = !on; $('#anchorFront').disabled = !on;
    $('#anchorHint').textContent = on ? 'A gripping pad holds the ground; a single pad lets that end pivot.' : 'Anchors only work with switchable-anchor feet. Pick them in Feet.';
    $('#anchorRear').value = anchorStr(M.manual ? M.manual.rear : false);
    $('#anchorFront').value = anchorStr(M.manual ? M.manual.front : false);
  }
  $('#bendDir').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; takeManual().dir = +b.dataset.v; setDrive(); });
  $('#anchorRear').addEventListener('change', (e) => { takeManual().rear = anchorVal(e.target.value); });
  $('#anchorFront').addEventListener('change', (e) => { takeManual().front = anchorVal(e.target.value); });
  $('#manualRelax').addEventListener('click', () => { const m = takeManual(); m.contract = 0; m.bend = 0; manCtl.contract.set(0); manCtl.bend.set(0); });
  $('#resumeGait').addEventListener('click', () => { M.manual = null; manCtl.contract.set(0); manCtl.bend.set(0); syncAnchorsUI(); setDrive(); });

  // ---- gait editor ----
  let tensionCtl = null;
  function renderGaitTension() {
    const host = $('#gaitTension'); host.innerHTML = '';
    tensionCtl = slider(host, { id: 'g-tension', label: 'Cable pull at 100% contract', min: 0.3, max: 1.2, step: 0.05, value: M.gait.tension || 0.8, fmt: (v) => v.toFixed(2) + '×',
      onInput: (v) => { M.gait.tension = v; markCustom(); } });
  }
  function renderGaitSelect() {
    const sel = $('#gaitSel');
    sel.innerHTML = Object.entries(CL.GAITS).map(([k, g]) => `<option value="${k}">${g.name}</option>`).join('') + (M.gaitKey === 'custom' ? '<option value="custom">Edited gait</option>' : '');
    sel.value = M.gaitKey;
    $('#gaitBlurb').textContent = M.gaitKey === 'custom' ? 'Your edited gait. Pick a preset to start over.' : CL.GAITS[M.gaitKey].blurb;
  }
  $('#gaitSel').addEventListener('change', (e) => {
    if (e.target.value === 'custom') return;
    M.gaitKey = e.target.value; M.gait = JSON.parse(JSON.stringify(CL.GAITS[M.gaitKey]));
    M.manual = null; setDrive();
    renderGaitSelect(); renderGaitTension(); renderFeet(); renderPhases(); syncAnchorsUI(); buildRobotSim(false); scoreGait();
  });
  function markCustom() { if (M.gaitKey !== 'custom') { M.gaitKey = 'custom'; renderGaitSelect(); } }
  function renderPhases() {
    const host = $('#phases'); host.innerHTML = '';
    const anchorsOn = M.gait.feet === 'anchors';
    M.gait.phases.forEach((ph, i) => {
      const d = document.createElement('div'); d.className = 'phase'; d.dataset.i = i;
      const opt = (v, cur) => ANCHORS.map(([a, l]) => `<option value="${a}"${a === anchorStr(cur) ? ' selected' : ''}>${l}</option>`).join('');
      d.innerHTML = `<div class="ph-title"><span>Phase ${i + 1}</span>${M.gait.phases.length > 1 ? `<button type="button" data-del="${i}" aria-label="Remove phase ${i + 1}">Remove</button>` : ''}</div>
        <label>Time (s)<input type="number" id="ph${i}-dur" min="0.3" max="8" step="0.1" value="${ph.dur}"></label>
        <label>Contract<input type="number" id="ph${i}-contract" min="0" max="1" step="0.05" value="${ph.contract}"></label>
        <label>Bend<input type="number" id="ph${i}-bend" min="0" max="1" step="0.05" value="${ph.bend}"></label>
        <label>Bend side<select id="ph${i}-dir">${DIRS.map(([v, l]) => `<option value="${v}"${v === ph.dir ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Tail<select id="ph${i}-rear" ${anchorsOn ? '' : 'disabled'}>${opt(0, ph.rear)}</select></label>
        <label>Head<select id="ph${i}-front" ${anchorsOn ? '' : 'disabled'}>${opt(0, ph.front)}</select></label>`;
      host.appendChild(d);
    });
  }
  $('#phases').addEventListener('change', (e) => {
    const m = e.target.id.match(/^ph(\d+)-(\w+)$/); if (!m) return;
    const ph = M.gait.phases[+m[1]], k = m[2];
    if (k === 'front' || k === 'rear') ph[k] = anchorVal(e.target.value);
    else if (k === 'dir') ph.dir = +e.target.value;
    else { const q = { dur: [0.3, 8], contract: [0, 1], bend: [0, 1] }[k]; ph[k] = Math.max(q[0], Math.min(q[1], +e.target.value || 0)); e.target.value = ph[k]; }
    markCustom();
  });
  $('#phases').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-del]'); if (!b) return;
    M.gait.phases.splice(+b.dataset.del, 1); markCustom(); renderPhases();
  });
  $('#addPhase').addEventListener('click', () => {
    if (M.gait.phases.length >= 6) return;
    M.gait.phases.push({ dur: 2, contract: 0, bend: 0, dir: 0, front: false, rear: false }); markCustom(); renderPhases();
  });
  let livePhase = -1;
  function renderPhaseHighlight(i) {
    if (i === livePhase) return; livePhase = i;
    for (const el of document.querySelectorAll('.phase')) el.classList.toggle('live', +el.dataset.i === i);
  }
  $('#robotRestart').addEventListener('click', () => buildRobotSim(true));

  // ---- scoring ----
  function pathChart(svg, path, bodyLen) {
    const W = 360, H = 200, pad = 22;
    if (!path || path.length < 2) { svg.innerHTML = ''; return; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of path) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const span = Math.max(x1 - x0, y1 - y0, bodyLen * 0.6);
    const sc = Math.min((W - 2 * pad) / span, (H - 2 * pad) / span);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const X = (x) => W / 2 + (x - cx) * sc, Y = (y) => H / 2 - (y - cy) * sc;
    let g = '';
    const step = bodyLen * 0.25;
    for (let v = Math.floor((cx - W / 2 / sc) / step) * step; v < cx + W / 2 / sc; v += step) g += `<line class="grid" x1="${X(v)}" x2="${X(v)}" y1="0" y2="${H}"/>`;
    for (let v = Math.floor((cy - H / 2 / sc) / step) * step; v < cy + H / 2 / sc; v += step) g += `<line class="grid" x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    const d = path.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
    const a = path[0], b = path[path.length - 1];
    g += `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>`;
    g += path.slice(1, -1).map((p) => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="2.5" fill="var(--accent)"/>`).join('');
    g += `<circle cx="${X(a[0])}" cy="${Y(a[1])}" r="4" fill="var(--panel)" stroke="var(--muted)" stroke-width="2"/><text x="${X(a[0])}" y="${Y(a[1]) + 16}" text-anchor="middle">start</text>`;
    g += `<circle cx="${X(b[0])}" cy="${Y(b[1])}" r="4.5" fill="var(--accent)"/>`;
    g += `<text x="6" y="${H - 6}">grid ¼ body length · top-down, head starts facing right</text>`;
    svg.innerHTML = g;
  }
  function gaitRows(r) {
    return [
      ['Forward per cycle', (r.perCycle * 100).toFixed(1) + '% of body length'],
      ['Heading change per cycle', (r.turn >= 0 ? '+' : '') + r.turn.toFixed(1) + '° ' + (Math.abs(r.turn) < 0.5 ? '(straight)' : r.turn > 0 ? '(left)' : '(right)')],
      ['Cycle time', CL.GaitPlayer.prototype.period.call({ gait: r.gait || M.gait }).toFixed(1) + ' s'],
      ['Cost of transport', isFinite(r.cot) && r.cot < 1e3 ? r.cot.toFixed(2) : 'goes nowhere'],
    ];
  }
  function scoreGait() {
    const btn = $('#scoreGait'); btn.disabled = true; btn.textContent = 'Crawling…';
    setTimeout(() => {
      try {
        const r = CL.evaluateGait(M.params, M.gait, { cycles: 3, stiff: { fold: M.crease, facet: M.crease } });
        r.gait = M.gait; M.score = r;
        pathChart($('#pathChart'), r.path, r.sim.bodyLength);
        $('#gaitScore').innerHTML = gaitRows(r).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
      } catch (err) { console.error(err); $('#gaitScore').innerHTML = `<dt>Could not score</dt><dd>${err.message}</dd>`; }
      btn.disabled = false; btn.textContent = 'Score this gait';
    }, 20);
  }
  $('#scoreGait').addEventListener('click', scoreGait);
  $('#speed').addEventListener('change', (e) => { M.speed = +e.target.value; });

  // ---- learning ----
  function renderLearnObjectives() {
    $('#learnObj').innerHTML = CL.GAIT_OBJECTIVES.map((o) => `<option value="${o.key}">${o.label}</option>`).join('');
    const hint = () => { const o = CL.GAIT_OBJECTIVES.find((x) => x.key === $('#learnObj').value); $('#learnHint').textContent = o.hint; };
    $('#learnObj').addEventListener('change', hint); hint();
    chart($('#learnChart'), { series: [], empty: 'Run a search to see each gait scored', xFmt: String, yFmt: String });
  }
  function stopLearn() { if (!M.learn) return; M.learn.stopped = true; M.learn = null; $('#learnRun').textContent = 'Run search'; }
  function startLearn() {
    if (M.learn) { stopLearn(); return; }
    const stiff = { fold: M.crease, facet: M.crease };
    const prob = CL.makeGaitProblem(M.params, M.gait, $('#learnObj').value, stiff);
    const es = new CL.CMAES(prob.encode(M.gait), 0.2, { seed: (Math.random() * 1e9) | 0 });
    const start = prob.evaluate(prob.encode(M.gait));
    const L = M.learn = { prob, es, gens: +$('#learnGens').value, gen: 0, queue: es.ask(), batch: [], all: [[0, start.score]], bestLine: [[0, start.score]], best: start, start, count: 0, stopped: false };
    $('#learnRun').textContent = 'Stop'; $('#learnApply').disabled = true;
    const tick = () => {
      if (L.stopped) return;
      const t0 = performance.now();
      while (performance.now() - t0 < 24 && L.queue.length) {
        const u = L.queue.shift(), r = prob.evaluate(u);
        L.count++; L.batch.push([u, r]); L.all.push([L.count, r.score]);
        if (r.score > L.best.score) L.best = r;
        L.bestLine.push([L.count, L.best.score]);
      }
      if (!L.queue.length) {
        es.tell(L.batch.map((b) => b[0]), L.batch.map((b) => b[1].fitness)); L.batch = []; L.gen++;
        if (L.gen >= L.gens) { finishLearn(L); return; }
        L.queue = es.ask();
      }
      drawLearn(L, true);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function drawLearn(L, running) {
    chart($('#learnChart'), { series: [{ pts: L.all, color: 'var(--dot)', dots: true }, { pts: L.bestLine, color: 'var(--accent)', end: true }],
      xLabel: 'gaits simulated', yLabel: 'score', xFmt: (v) => String(Math.round(v)), yFmt: (v) => +v.toPrecision(2) + '', xmin: 0 });
    $('#learnStatus').textContent = running ? `generation ${L.gen + 1} / ${L.gens}` : `done · ${L.count} gaits`;
    const a = L.start, b = L.best;
    const rows = [
      ['Forward per cycle', (a.perCycle * 100).toFixed(1) + '% → ' + (b.perCycle * 100).toFixed(1) + '%'],
      ['Turn per cycle', a.turn.toFixed(1) + '° → ' + b.turn.toFixed(1) + '°'],
    ];
    b.gait.phases.forEach((ph, i) => rows.push([`Phase ${i + 1}`, `${ph.dur.toFixed(1)} s · contract ${fmtPct(ph.contract)} · bend ${fmtPct(ph.bend)}`]));
    $('#learnBest').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }
  function finishLearn(L) {
    M.learn = null; M.lastLearn = L;
    $('#learnRun').textContent = 'Run search';
    $('#learnApply').disabled = !(L.best.score > L.start.score);
    drawLearn(L, false);
  }
  $('#learnRun').addEventListener('click', startLearn);
  $('#learnApply').addEventListener('click', () => {
    const L = M.lastLearn; if (!L) return;
    M.gait = JSON.parse(JSON.stringify(L.best.gait)); M.gaitKey = 'custom';
    M.manual = null; setDrive();
    renderGaitSelect(); renderPhases(); buildRobotSim(false); scoreGait();
    $('#learnApply').disabled = true;
  });

  // ---- per-frame ----
  function moveTick() {
    const s = M.sim; if (!s) return;
    if (!state.paused) {
      // playback: speed x means x * 1 sim-second per real second, at 60 fps
      M.acc += (M.speed * (1 / 60)) / s.dt;
      let n = Math.floor(M.acc); M.acc -= n; n = Math.min(n, 60);
      for (let k = 0; k < n; k++) {
        if (M.manual) {
          const m = M.manual;
          const T = s.cableAngle.map((a) => s.tensionScale * (M.gait.tension || 0.8) * Math.max(0, m.contract + m.bend * Math.cos(a - m.dir * DEG)));
          for (let c = 0; c < T.length; c++) s.cableT[c] += (T[c] - s.cableT[c]) * 0.05;
          if (s.feet !== M.gait.feet || s.anchors.front !== m.front || s.anchors.rear !== m.rear) s.setFeet(M.gait.feet, { front: m.front, rear: m.rear });
        } else {
          const ph = M.player.apply(s, s.time);
          if (k === n - 1) renderPhaseHighlight(ph.i);
        }
        s.step(1);
      }
      if (!isFinite(s.x[0])) buildRobotSim(false);
      const c = s.com();
      if (Math.floor(s.time / 0.25) !== M.lastTrail) { M.lastTrail = Math.floor(s.time / 0.25); view.pushTrail(c); }
    }
    view.update();
    if (frame % 8 === 0) moveHud();
  }
  function moveHud() {
    const s = M.sim, c = s.com();
    const dx = c[0] - M.start[0], dy = c[1] - M.start[1];
    let dh = (s.heading() - M.startHeading) / DEG; while (dh > 180) dh -= 360; while (dh < -180) dh += 360;
    const per = M.player.period();
    const chips = [
      ['Time', s.time.toFixed(1) + ' s'],
      ['Travelled', (Math.hypot(dx, dy) / s.bodyLength).toFixed(2) + ' body lengths'],
      ['Heading', (dh >= 0 ? '+' : '') + dh.toFixed(1) + '°'],
      ['Length', fmtPct(s.length() / s.bodyLength)],
      M.manual ? ['Drive', 'by hand'] : ['Cycle', (Math.floor(s.time / per) + 1) + ' · phase ' + (M.player.idx + 1)],
    ];
    if (pat && mode === 'move') $('#hud').innerHTML = chips.map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join('')
      + '<span class="chip hint">Drag the robot to push or lift it · double-click to pin a point</span>';
  }


  // =====================================================================
  // TRANSFORM: one robot, four body shapes, and a mission that uses all of them
  // =====================================================================
  const T = { params: CL.defaultTransformer(), sim: null, mode: 'crawl', neck: 45, acc: 0, start: null, lastTrail: -1, mission: null, report: null };

  function buildTransformerSim(fit) {
    stopMission();
    T.sim = CL.buildTransformer(T.params);
    T.sim.controller.set(T.mode, { neck: T.neck, hold: true });
    T.start = T.sim.com(); T.lastTrail = -1;
    if (mode === 'transform') { view.setSim(T.sim, fit); view.pushTrail(T.start); }
  }
  let tQueued = false;
  function scheduleTransformer() { if (tQueued) return; tQueued = true; requestAnimationFrame(() => { tQueued = false; buildTransformerSim(false); }); }
  function renderTransformerParams() {
    const host = $('#tParams'); host.innerHTML = '';
    for (const q of CL.TRANSFORMER_PARAMS) {
      slider(host, { id: 't-' + q.key, label: q.label, min: q.min, max: q.max, step: q.step, value: T.params[q.key],
        fmt: q.unit === '×' ? (v) => v.toFixed(1) + '× a cell' : fmtParam(q),
        onInput: (v) => { T.params[q.key] = v; T.report = null; renderWorth(); scheduleTransformer(); } });
    }
  }
  $('#tReset').addEventListener('click', () => { T.params = CL.defaultTransformer(); renderTransformerParams(); buildTransformerSim(true); });
  $('#tRestart').addEventListener('click', () => buildTransformerSim(true));

  let reachCtl = null;
  function renderTransformModes() {
    const host = $('#tModes'); host.innerHTML = '';
    for (const [k, m] of Object.entries(CL.MODES)) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.k = k;
      b.innerHTML = `${m.name}<small>${m.job.toLowerCase()}</small>`;
      b.setAttribute('aria-pressed', String(k === T.mode));
      b.addEventListener('click', () => setTransformMode(k));
      host.appendChild(b);
    }
    const m = CL.MODES[T.mode];
    $('#tModeWhat').textContent = `${m.short} ${m.what}`;
    const r = $('#tReach'); r.innerHTML = '';
    if (m.adjustable) reachCtl = slider(r, { id: 't-neck', label: 'Neck angle', min: 10, max: 85, step: 1, value: T.neck, fmt: (v) => v.toFixed(0) + '°',
      onInput: (v) => { T.neck = v; if (T.sim && T.mode === 'reach' && !T.mission) T.sim.controller.neckTarget = v; } });
  }
  function setTransformMode(k) {
    stopMission();
    T.mode = k;
    if (T.sim) T.sim.controller.set(k, { neck: T.neck });
    renderTransformModes();
  }

  function transformTick() {
    const s = T.sim; if (!s) return;
    if (!state.paused) {
      T.acc += (2 * (1 / 60)) / (5 * s.dt);
      let n = Math.floor(T.acc); T.acc -= n; n = Math.min(n, 20);
      for (let k = 0; k < n; k++) { s.controller.apply(5 * s.dt); s.step(5); }
      if (!isFinite(s.x[0])) { buildTransformerSim(false); return; }
      if (T.mission) missionTick();
      const c = s.com();
      if (Math.floor(s.time / 0.25) !== T.lastTrail) { T.lastTrail = Math.floor(s.time / 0.25); view.pushTrail(c); }
    }
    view.update();
    if (frame % 8 === 0) transformHud();
  }
  function transformHud() {
    const s = T.sim; if (!s || mode !== 'transform') return;
    const m = CL.MODES[s.controller.mode];
    const chips = [
      ['Shape', m.name],
      ['Neck', s.neckAngle().toFixed(0) + '°'],
      ['Camera', s.cameraHeight().toFixed(2) + ' cm up'],
      ['Length', fmtPct(s.length() / s.restLength)],
      T.mission ? ['Mission', `${T.mission.i + 1}/5 · ${CL.MISSION[T.mission.i].name}`] : ['Time', s.time.toFixed(1) + ' s'],
    ];
    $('#hud').innerHTML = chips.map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join('')
      + '<span class="chip hint">Pick a shape on the left · drag the robot to push it · drag empty space to turn</span>';
    $('#tModeStatus').textContent = T.mission ? 'mission running' : '';
  }

  // ---- mission: the table comes from a headless run; the 3D view plays the same steps live ----
  function stopMission() { if (!T.mission) return; T.mission = null; $('#tMission').textContent = 'Run mission'; renderSteps(); }
  function startMission() {
    if (T.mission) { stopMission(); return; }
    const btn = $('#tMission'); btn.textContent = 'Simulating…'; btn.disabled = true;
    setTimeout(() => {
      try { T.report = CL.runMission(T.params); }
      catch (err) { console.error(err); T.report = null; $('#tSteps').innerHTML = `<tbody><tr><td>The mission failed: ${err.message}</td></tr></tbody>`; }
      btn.disabled = false;
      if (!T.report) { btn.textContent = 'Run mission'; return; }
      // live playback: start folded, then walk through the steps
      buildTransformerSim(true);
      T.sim.controller.set('compact', { hold: true }); CL.runFor(T.sim, 6);
      T.start = T.sim.com();
      T.mission = { i: -1, tEnd: 0, done: 0 };
      btn.textContent = 'Stop';
      nextMissionStep();
      renderSteps(); renderMissionChart(); renderWorth();
    }, 20);
  }
  function nextMissionStep() {
    const M_ = T.mission; M_.i++;
    if (M_.i >= CL.MISSION.length) { T.mission = null; $('#tMission').textContent = 'Run mission'; T.mode = 'compact'; renderTransformModes(); renderSteps(true); return; }
    const st = CL.MISSION[M_.i];
    T.sim.controller.set(st.mode, { neck: st.neck, still: st.still });
    M_.tEnd = T.sim.time + st.T;
    T.mode = st.mode; if (st.neck) T.neck = st.neck; renderTransformModes();
    renderSteps();
  }
  function missionTick() { if (T.sim.time >= T.mission.tEnd) { T.mission.done = T.mission.i + 1; nextMissionStep(); } }
  const f2 = (v) => v.toFixed(2);
  function stepResult(st) {
    const sh = st.shape;
    const out = {
      deploy: () => `back to ${fmtPct(sh.length / T.report.rest.length)} length`,
      move: () => `${f2(st.perCycle)} cm per cycle`,
      inspect: () => `camera ${f2(sh.camera)} cm up`,
      intervene: () => `tip held ${f2(sh.tip[2])} cm up, neck ${sh.neck.toFixed(0)}°`,
      recover: () => `${fmtPct(sh.length / T.report.rest.length)} length`,
    }[st.key];
    return out ? out() : '';
  }
  function renderSteps(finished) {
    const R = T.report, live = T.mission ? T.mission.i : -1, shown = T.mission ? T.mission.done : (R ? 5 : 0);
    let h = '<thead><tr><th>Step</th><th>Shape</th><th>Result</th><th>Time</th><th>Work*</th></tr></thead><tbody>';
    CL.MISSION.forEach((st, i) => {
      const r = R && i < shown ? R.steps[i] : null;
      h += `<tr class="${i === live ? 'live' : ''}"><td><b>${st.name}</b></td><td>${CL.MODES[st.mode].name}</td>`
        + (r ? `<td>${stepResult(r)}</td><td class="num">${r.settle != null ? r.settle.toFixed(1) + ' s' : st.T + ' s'}</td><td class="num">${r.work.toFixed(0)}</td>`
          : `<td class="hint">${i === live ? 'running…' : st.what}</td><td></td><td></td>`) + '</tr>';
    });
    h += '</tbody>';
    $('#tSteps').innerHTML = h + (shown ? '<caption class="hint" style="caption-side:bottom;text-align:left;padding-top:6px">Time is how long the shape change took to get within 10% of its final value. *Cable and tendon work, in the simulator\'s force units × cm.</caption>' : '');
  }
  function renderMissionChart() {
    const R = T.report; if (!R) { chart($('#tChart'), { series: [], empty: 'Run the mission to plot it', xFmt: String, yFmt: String }); return; }
    const cam = [], len = []; let t0 = 0;
    for (const st of R.steps) { for (let i = 0; i < st.series.length; i += 6) { const r = st.series[i]; cam.push([t0 + r[0], r[1]]); len.push([t0 + r[0], r[2]]); } t0 += st.time; }
    chart($('#tChart'), { series: [{ pts: len, color: 'var(--warn)' }, { pts: cam, color: 'var(--accent)', end: true }], xLabel: 'mission time (s)', yLabel: 'cm', xFmt: (v) => String(Math.round(v)), yFmt: (v) => v.toFixed(1), xmin: 0 });
  }
  function renderWorth() {
    const R = T.report, tb = $('#tWorth'), v = $('#tVerdict');
    if (!R) { tb.innerHTML = '<tbody><tr><td class="hint">Run the mission to compare.</td></tr></tbody>'; v.hidden = true; return; }
    const S = Object.fromEntries(R.steps.map((s) => [s.key, s])), B0 = R.baseline;
    const rows = [
      ['Camera height (Inspect)', f2(S.inspect.shape.camera) + ' cm', f2(B0.camera) + ' cm', S.inspect.shape.camera / B0.camera, `${(S.inspect.shape.camera / B0.camera).toFixed(1)}× higher`],
      ['Tip held above the floor (Intervene)', f2(S.intervene.shape.tip[2]) + ' cm', 'floor level only', 2, 'only the transformer'],
      ['Crawl speed (Move)', f2(S.move.perCycle) + ' cm/cycle', f2(B0.perCycle) + ' cm/cycle', S.move.perCycle / B0.perCycle, fmtPct(S.move.perCycle / B0.perCycle) + ' of baseline'],
      ['Stowed length (Recover)', fmtPct(S.recover.shape.length / R.rest.length) + ' of full', fmtPct(B0.stowedLength / B0.restLength) + ' of full', (B0.stowedLength / B0.restLength) / (S.recover.shape.length / R.rest.length), S.recover.shape.length / R.rest.length > B0.stowedLength / B0.restLength ? 'folds less' : 'folds more'],
    ];
    tb.innerHTML = '<thead><tr><th>Job</th><th>Transformer</th><th>Fixed-form</th><th></th></tr></thead><tbody>'
      + rows.map(([k, a, b, ratio, note]) => `<tr><td>${k}</td><td class="num">${a}</td><td class="num">${b}</td><td class="${ratio >= 1 ? 'good' : 'bad'}">${note}</td></tr>`).join('') + '</tbody>';
    v.hidden = false;
    v.innerHTML = `<b>Worth it for this mission.</b> The neck lifts the camera ${(S.inspect.shape.camera / B0.camera).toFixed(1)}× higher and holds a tip off the floor, which a fixed-form crawler can't do at all. `
      + `The price is ${fmtPct(1 - S.move.perCycle / B0.perCycle)} slower crawling (the head and sled are dead weight while it moves) and a longer stowed package, because the hinge and head cell don't fold. For a crawl-only job, the plain crawler wins.`;
  }
  $('#tMission').addEventListener('click', startMission);
  function initTransform() { renderTransformerParams(); renderTransformModes(); renderSteps(); renderMissionChart(); }

  // =====================================================================
  // BUILD: from the simulated robot to a real one
  // =====================================================================
  const B = { robot: 'crawler', camera: true, R_mm: 30, spool: 'auto', board: 'nano', power: 'tether', servo: 'mg90s', view: 'body', tmpl: null, plan: null, sketch: '', payload: null, payloadKey: '', tplan: null, tmass: null, tcheck: null, tcheckKey: '' };
  let spoolCtl = null;
  function renderBuildParams() {
    const host = $('#buildParams'); host.innerHTML = '';
    slider(host, { id: 'b-R', label: 'Size: plate corner radius', min: 15, max: 60, step: 1, value: B.R_mm, fmt: (v) => v.toFixed(0) + ' mm',
      onInput: (v) => { B.R_mm = v; scheduleBuild(); } });
    spoolCtl = slider(host, { id: 'b-spool', label: 'Spool radius on the servo', min: 4, max: 30, step: 0.5, value: 10, fmt: (v) => (B.spool === 'auto' ? 'auto · ' : '') + v.toFixed(1) + ' mm',
      onInput: (v) => { B.spool = v; scheduleBuild(); } });
    host.insertAdjacentHTML('beforeend', '<div class="btns"><button class="btn" type="button" id="spoolAuto">Pick the spool for me</button></div>');
    $('#spoolAuto').addEventListener('click', () => { B.spool = 'auto'; scheduleBuild(); });
  }
  $('#board').addEventListener('change', (e) => { B.board = e.target.value; scheduleBuild(); });
  $('#power').addEventListener('change', (e) => { B.power = e.target.value; scheduleBuild(); });
  $('#servo').addEventListener('change', (e) => { B.servo = e.target.value; scheduleBuild(); });
  $('#editInMove').addEventListener('click', () => setMode(B.robot === 'transformer' ? 'transform' : 'move'));
  $('#buildRobot').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.dataset.v === B.robot) return;
    B.robot = b.dataset.v;
    // the transformer's battery-and-board stack has to fit under the neck servo: default it to the slim Pico
    if (B.robot === 'transformer' && B.board !== 'pico') { B.board = 'pico'; $('#board').value = 'pico'; }
    for (const x of $('#buildRobot').children) x.setAttribute('aria-pressed', String(x.dataset.v === B.robot));
    if (B.view === '3d') renderSheet();
    refreshBuild();
  });
  $('#camera').addEventListener('change', (e) => { B.camera = e.target.checked; scheduleBuild(); });
  let buildQueued = false;
  function scheduleBuild() { if (buildQueued) return; buildQueued = true; setTimeout(() => { buildQueued = false; refreshBuild(); }, 60); }

  function gaitName() { return M.gaitKey === 'custom' ? 'your edited gait' : CL.GAITS[M.gaitKey].name; }
  function refreshBuild() {
    if (B.robot === 'transformer') { refreshBuildT(); return; }
    const p = M.params;
    B.tmpl = CL.crawlerTemplate(p, { R_mm: B.R_mm, power: B.power, board: B.board, servo: B.servo });
    const plan = CL.servoPlan(p, M.gait, { R_mm: B.R_mm, spool_mm: 10, stiff: { fold: M.crease, facet: M.crease } });
    const spool = B.spool === 'auto' ? Math.min(30, Math.max(4, Math.ceil(plan.spoolNeeded * 2) / 2)) : B.spool;
    for (const ph of plan.phases) { ph.leftDeg = ph.leftMm / spool / DEG; ph.rightDeg = ph.rightMm / spool / DEG; }
    plan.spool_mm = spool; plan.maxDeg = plan.maxMm / spool / DEG; plan.fits = plan.maxDeg <= 153;
    B.plan = plan;
    if (spoolCtl) spoolCtl.set(spool);
    B.sketch = CL.arduinoSketch(plan, { board: B.board, name: gaitName() });
    renderBuild();
    schedulePayload();
  }
  // weight check: estimate the parts, then run the gait with the tray loads (in a timeout so the page stays responsive)
  let payloadTimer = null;
  function buildOpts() { return { R_mm: B.R_mm, power: B.power, board: B.board, servo: B.servo, anchors: B.plan && B.plan.anchors }; }
  function schedulePayload() {
    const key = JSON.stringify([M.params, M.gait, M.crease, buildOpts()]);
    if (key === B.payloadKey && B.payload) { renderWeight(); return; }
    B.payloadKey = key; B.payload = null; renderWeight();
    clearTimeout(payloadTimer);
    payloadTimer = setTimeout(() => {
      try { B.payload = CL.payloadCheck(M.params, M.gait, Object.assign(buildOpts(), { stiff: { fold: M.crease, facet: M.crease } })); }
      catch (err) { console.error(err); B.payload = { error: err.message }; }
      if (key === B.payloadKey) { renderWeight(); renderBuild(); }
    }, 120);
  }
  function renderWeight() {
    const pc = B.payload, tb = $('#weightTable'), v = $('#weightVerdict');
    if (!pc) { $('#weightStatus').textContent = 'simulating…'; tb.innerHTML = ''; v.textContent = ''; return; }
    if (pc.error) { $('#weightStatus').textContent = ''; v.textContent = 'The weight check failed: ' + pc.error; return; }
    $('#weightStatus').textContent = Math.round(pc.mass.total) + ' g in all';
    const by = (w) => pc.mass.items.filter((it) => it.where === w);
    const sec = (w, title) => `<tr><th colspan="2">${title} · ${by(w).reduce((a, it) => a + it.g, 0).toFixed(1)} g</th></tr>` + by(w).map((it) => `<tr><td>${it.name}</td><td class="num">${it.g.toFixed(1)} g</td></tr>`).join('');
    tb.innerHTML = '<tbody>' + sec('body', 'Paper body') + sec('tail', 'Tail tray') + sec('head', B.power === 'onboard' ? 'Head tray' : 'Head pad') + '</tbody>';
    const pct = (x) => (100 * x).toFixed(1) + '%';
    v.innerHTML = `<b>${pc.ratio > 0.75 ? 'Fine.' : pc.ratio > 0.4 ? 'Slower, but it crawls.' : 'Too heavy for this gait.'}</b> Bare, the body gains ${pct(pc.bare)} of its length per cycle. Carrying ${pc.tailFrac.toFixed(1)}× its weight on the tail${pc.headFrac > 0.3 ? ` and ${pc.headFrac.toFixed(1)}× on the head` : ''}, it gains ${pct(pc.loaded)} (${Math.round(100 * pc.ratio)}% of bare). `
      + (B.power === 'onboard' ? `With the same weight all on the tail it would manage only ${pct(pc.allTail)}, which is why the battery and board ride at the head.` : `Stage 2 adds the board and battery at the head; switch Power to see what that costs.`)
      + (M.gait.feet === 'scales' && pc.ratio < 0.75 ? ' The two-anchor gait copes better with weight, because heavier feet grip harder.' : '');
  }
  function renderBuild() {
    if (B.robot === 'transformer') { renderBuildT(); return; }
    const p = M.params, plan = B.plan, t = B.tmpl, R = B.R_mm;
    $('#powerField').hidden = false; $('#cameraWrap').hidden = true; $('#editInMove').textContent = 'Edit in Move';
    $('#h-servo').textContent = 'Servo plan';
    const len = Math.round(p.cells * p.H * R), dia = Math.round(2 * R);
    $('#powerHint').textContent = B.power === 'onboard'
      ? 'Stage 2: a 1S LiPo, boost converter and the board ride on a tray under the head; the servos stay on the tail tray. Build Stage 1 first and keep its servo zeros.'
      : 'Stage 1: only the servos ride on the robot. The board and battery stay on the table, wired to it, so you can tune it with the serial monitor.';
    $('#botSummary').textContent = `${p.cells} Kresling cells, ${p.n}-sided, ${p.phi}° twist, ${p.chirality === 'same' ? 'same handedness' : 'alternating handedness'}. Gait: ${gaitName()} with ${CL.FEET[M.gait.feet].label.toLowerCase()}. About ${len} mm long and ${dia} mm across.`;
    // stage
    renderSheet();
    // sim -> hardware map
    const rows = [
      ['Paper triangles', `A strip of ${t.a_mm.toFixed(0)} × ${t.b_mm.toFixed(0)} × ${t.c_mm.toFixed(0)} mm triangles, printed and folded (page 1)`],
      ['Rigid plates', `${p.cells + 1} card discs glued inside the rings (page 2)`],
      ['Four cables', 'Braided fishing line through the plate eyelets, tied at the head'],
      ['Cable tension', `Two servos wind the left and right cable pairs onto ${plan.spool_mm} mm spools`],
      ['Foot friction', M.gait.feet === 'scales' ? 'Pads with hairs leaning back (climbing skin or bristles)' : M.gait.feet === 'anchors' ? 'Two more servos press rubber feet down to grip' : 'Plain card pads'],
      ['Gait phases', `${plan.phases.length} keyframes in the sketch, same timing as the simulator`],
      ['Crease stiffness', 'Unknown until you build it: measure the real contraction and tune the sim to match'],
    ];
    $('#simMap').innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
    // servo table
    const an = plan.anchors;
    $('#servoTable').innerHTML = `<thead><tr><th>Phase</th><th>Time</th><th>Left cables</th><th>Right cables</th>${an ? '<th>Anchors</th>' : ''}</tr></thead><tbody>` +
      plan.phases.map((ph, i) => `<tr><td>${i + 1}</td><td class="num">${ph.dur.toFixed(1)} s</td><td class="num">${ph.leftMm.toFixed(1)} mm · ${ph.leftDeg.toFixed(0)}°</td><td class="num">${ph.rightMm.toFixed(1)} mm · ${ph.rightDeg.toFixed(0)}°</td>${an ? `<td>${ph.head && ph.tail ? 'both grip' : ph.head ? 'head grips' : ph.tail ? 'tail grips' : 'both slide'}</td>` : ''}</tr>`).join('') + '</tbody>';
    $('#servoVerdict').innerHTML = plan.fits
      ? `<b>Fits a hobby servo.</b> The longest pull is ${plan.maxMm.toFixed(1)} mm, which is ${plan.maxDeg.toFixed(0)}° on a ${plan.spool_mm} mm spool.`
      : `<b>Too much travel.</b> The longest pull is ${plan.maxMm.toFixed(1)} mm, ${plan.maxDeg.toFixed(0)}° on a ${plan.spool_mm} mm spool. A servo turns about 180°. Use a ${Math.ceil(plan.spoolNeeded)} mm spool, lower the cable pull in Move, or use a 360° servo.`;
    // wiring
    const w = CL.wiringText(plan, B.board, B.power);
    $('#wireList').innerHTML = w.rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
    drawWiring(w, an);
    // bom
    const bom = CL.bom(p, { board: B.board, anchors: an, R_mm: R, feet: M.gait.feet, power: B.power, servo: B.servo, spool_mm: plan.spool_mm });
    $('#bomTable').innerHTML = '<thead><tr><th>Part</th><th>Qty</th><th>Notes</th></tr></thead><tbody>' + bom.map((r) => `<tr><td>${r[1]}</td><td class="num">${r[2]}</td><td>${r[3]}</td></tr>`).join('') + '</tbody>';
    $('#codeBox').textContent = B.sketch;
    // steps: reuse the README's list
    const md = CL.readme(p, plan, t, { board: B.board, gaitName: gaitName(), power: B.power, servo: B.servo, payload: B.payload && !B.payload.error ? B.payload : null });
    const steps = md.split('## Build steps')[1].split('##')[0].trim().split('\n').map((l) => l.replace(/^\d+\.\s*/, ''));
    $('#buildSteps').innerHTML = steps.map((x) => `<li>${x.replace(/</g, '&lt;')}</li>`).join('');
    // hud
    if (mode === 'build') {
      const chips = [['Length', len + ' mm'], ['Across', dia + ' mm'], ['Prints on', t.page], ['Cable stroke', plan.maxMm.toFixed(0) + ' mm'], ['Servos', an ? 4 : 2], ['Weight', B.payload && B.payload.mass ? Math.round(B.payload.mass.total) + ' g' : '…']];
      $('#hud').innerHTML = chips.map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join('');
    }
  }
  function renderSheet() {
    const st = $('#stage');
    st.classList.toggle('three', B.view === '3d');
    for (const b of $('#sheetTabs').children) b.setAttribute('aria-pressed', String(b.dataset.v === B.view));
    if (B.view === '3d') {
      if (B.robot === 'transformer') { if (!T.sim) buildTransformerSim(false); view.setSim(T.sim, false); }
      else if (M.sim) view.setSim(M.sim, false);
      return;
    }
    const svg = B.view === 'body' ? B.tmpl.svg : B.view === 'trays' ? B.tmpl.traysSvg + (B.tmpl.headSvg ? '<div style="height:12px"></div>' + B.tmpl.headSvg : '') : B.tmpl.partsSvg;
    $('#sheetPaper').innerHTML = svg;
    $('#sheetNote').textContent = B.view === 'body'
      ? `Page 1 · ${B.tmpl.W} × ${B.tmpl.H} mm. Red dash-dot = mountain, blue dashes = valley, shaded = glue tabs. The tube closes by gluing the right-hand tabs under the left edge.`
      : B.view === 'trays' && B.robot === 'transformer' ? `Pages 3 and 4. The tail tray, the sled under the shoulder, a side view of the neck with the distances the simulator assumed, and the head box net. The neck brackets are the part most worth drawing in CAD and 3D printing.`
      : B.view === 'trays' ? `Page 3 · ${B.tmpl.W3} × ${B.tmpl.H3} mm. The trays are also the foot pads: scales go underneath. Servos sit on ${Math.round(B.tmpl.trays.riser)} mm risers on the tail tray${B.power === 'onboard' ? '; the battery, board and boost converter go on the head tray' : ''}.`
      : `Page 2 · ${B.tmpl.W2} × ${B.tmpl.H2} mm. One plate per ring; the dot marks corner 0, which goes at the matching P-label on the strip.`;
  }
  $('#sheetTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; B.view = b.dataset.v; renderSheet();
    for (const id of ['#tStrain', '#tCreases', '#tPause', '#tView']) $(id).hidden = B.view !== '3d';
  });


  // ---- Stage 3: the transformer kit ----
  function tOpts() { return { R_mm: B.R_mm, board: B.board, servo: B.servo, camera: B.camera }; }
  function refreshBuildT() {
    const tp = T.params, o = tOpts();
    B.tmass = CL.transformerMass(tp, o);
    B.tplan = CL.transformerPlan(tp, Object.assign({}, o, { mass: B.tmass, spool_mm: B.spool === 'auto' ? 'auto' : B.spool }));
    B.tmpl = CL.transformerTemplates(tp, Object.assign({}, o, { spool: B.tplan.spool_mm }));
    B.sketch = CL.transformerSketch(B.tplan, o);
    if (spoolCtl) spoolCtl.set(B.tplan.spool_mm);
    renderBuildT();
    scheduleTCheck();
  }
  let tcheckTimer = null;
  function scheduleTCheck() {
    const key = JSON.stringify([T.params, tOpts()]);
    if (key === B.tcheckKey && B.tcheck) { renderWeightT(); return; }
    B.tcheckKey = key; B.tcheck = null; renderWeightT();
    clearTimeout(tcheckTimer);
    tcheckTimer = setTimeout(() => {
      try { B.tcheck = CL.transformerCheck(T.params, Object.assign(tOpts(), { mass: B.tmass })); }
      catch (err) { console.error(err); B.tcheck = { error: err.message }; }
      if (key === B.tcheckKey && B.robot === 'transformer') { renderWeightT(); renderBuildT(); }
    }, 120);
  }
  function renderWeightT() {
    const ck = B.tcheck, m = B.tmass, tb = $('#weightTable'), v = $('#weightVerdict'), R = B.R_mm;
    if (!m) return;
    $('#weightStatus').textContent = Math.round(m.total) + ' g in all' + (ck ? '' : ' · simulating…');
    const groups = [['body', 'Paper body'], ['tail', 'Tail tray'], ['sled', 'Sled (shoulder)'], ['neck', 'Neck'], ['head', 'Head']];
    tb.innerHTML = '<tbody>' + groups.map(([w, title]) => { const it = m.items.filter((x) => x.where === w); return `<tr><th colspan="2">${title} · ${it.reduce((a, x) => a + x.g, 0).toFixed(1)} g</th></tr>` + it.map((x) => `<tr><td>${x.name}</td><td class="num">${x.g.toFixed(1)} g</td></tr>`).join(''); }).join('') + '</tbody>';
    if (!ck) { v.textContent = ''; return; }
    if (ck.error) { v.textContent = 'The check failed: ' + ck.error; return; }
    const mm = (u) => Math.round(u * R) + ' mm';
    v.innerHTML = `<b>${ck.tower.neck > 75 && Math.abs(ck.tower.tilt) < 10 ? 'It transforms.' : 'The neck struggles.'}</b> With every part's weight in the simulator, Tower lifts the camera to ${mm(ck.tower.camera)} (${mm(ck.cameraFlat)} lying flat) with the shoulder tipping ${Math.abs(ck.tower.tilt).toFixed(0)}°. `
      + `Reach holds the tip ${mm(ck.reach.tipZ)} up, Compact gets it to ${Math.round(100 * ck.compact.length)}% length, and it crawls ${(ck.crawl * R).toFixed(1)} mm per cycle (the weightless simulated robot does ${(ck.crawlBare * R).toFixed(1)}). `
      + `The head is a rigid card box because a paper Kresling head squashes under it: the camera would sit at ${mm(ck.paperHeadCamera)}. No gripping feet are needed; scales alone hold it in Tower.`;
  }
  function renderBuildT() {
    const tp = T.params, plan = B.tplan, t = B.tmpl, R = B.R_mm, o = tOpts();
    $('#powerField').hidden = true; $('#cameraWrap').hidden = false; $('#editInMove').textContent = 'Edit in Transform';
    const len = Math.round((tp.cells * tp.H + 1.9 + tp.H) * R), dia = Math.round(2 * R);
    $('#botSummary').textContent = `${tp.cells} Kresling body cells, a servo neck and a rigid head${B.camera ? ' with a camera' : ''}. Built on the Stage 2 crawler: same body, tail tray and electronics, with a sled under the last plate. About ${len} mm long and ${dia} mm across.`;
    $('#powerHint').textContent = 'Stage 3 always runs on board: a 1S LiPo, boost converter and the board ride on the sled under the shoulder. Three servos: two for the body cables, one for the neck.';
    renderSheet();
    const rows = [
      ['Body', `The Stage 2 crawler's ${tp.cells} cells and ${tp.cells + 1} plates (pages 1–2); P${tp.cells} becomes the shoulder`],
      ['Neck hinge', `A servo on its side, shaft ${t.pivot.toFixed(1)} mm in front of the shoulder plate: the simulator's hinge pin`],
      ['Neck tendons', 'Not needed: the servo holds the angle the simulator\'s neck controller asked for'],
      ['Battery on the sled', 'The sled is the simulator\'s long shoulder pad (±1.5 R); its weight is what keeps the shoulder down in Tower'],
      ['Head', 'A rigid card box instead of a paper cell, so it can carry a camera'],
      ['Grips', 'None: scales under the trays hold it in Tower in the simulator too'],
      ['Shapes', 'Compact, Crawl, Tower and Reach as serial commands, plus the mission'],
    ];
    $('#simMap').innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
    $('#h-servo').textContent = 'Servo plan by shape';
    $('#servoTable').innerHTML = '<thead><tr><th>Shape</th><th>Left cables</th><th>Right cables</th><th>Neck</th></tr></thead><tbody>'
      + `<tr><td>Compact</td><td class="num">${plan.compact.leftMm.toFixed(0)} mm · ${plan.compact.leftDeg.toFixed(0)}°</td><td class="num">${plan.compact.rightMm.toFixed(0)} mm · ${plan.compact.rightDeg.toFixed(0)}°</td><td>straight</td></tr>`
      + `<tr><td>Crawl stroke</td><td class="num">${plan.crawl.leftMm.toFixed(0)} mm · ${plan.crawl.leftDeg.toFixed(0)}°</td><td class="num">${plan.crawl.rightMm.toFixed(0)} mm · ${plan.crawl.rightDeg.toFixed(0)}°</td><td>straight</td></tr>`
      + `<tr><td>Tower</td><td>slack</td><td>slack</td><td class="num">${plan.neck.tower}° up</td></tr><tr><td>Reach</td><td>slack</td><td>slack</td><td class="num">${plan.neck.reach}°, adjustable</td></tr></tbody>`;
    $('#servoVerdict').innerHTML = plan.fits
      ? `<b>Fits a hobby servo.</b> The longest pull is ${plan.maxMm.toFixed(0)} mm, ${plan.maxDeg.toFixed(0)}° on a ${plan.spool_mm} mm spool.`
      : `<b>Just over.</b> The longest pull (Compact) is ${plan.maxMm.toFixed(0)} mm, ${plan.maxDeg.toFixed(0)}° on a ${plan.spool_mm} mm spool. Most micro servos turn 160–180°; if yours stops short, Compact folds a little less.`;
    const w = CL.transformerWiring(B.board, B.camera);
    $('#wireList').innerHTML = w.rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
    drawWiring(w, false, [['Left cable', w.pins[0]], ['Right cable', w.pins[1]], ['Neck', w.pins[2]]]);
    const bom = CL.transformerBom(tp, plan, o);
    $('#bomTable').innerHTML = '<thead><tr><th>Part</th><th>Qty</th><th>Notes</th></tr></thead><tbody>' + bom.map((r) => `<tr><td>${r[1]}</td><td class="num">${r[2]}</td><td>${r[3]}</td></tr>`).join('') + '</tbody>';
    $('#codeBox').textContent = B.sketch;
    const md = CL.transformerReadme(tp, plan, t, B.tcheck && !B.tcheck.error ? B.tcheck : null, o);
    const steps = md.split('## Build steps')[1].split('##')[0].trim().split('\n').map((l) => l.replace(/^\d+\.\s*/, ''));
    $('#buildSteps').innerHTML = steps.map((x) => `<li>${x.replace(/</g, '&lt;')}</li>`).join('');
    renderWeightT();
    if (mode === 'build') {
      const chips = [['Length', len + ' mm'], ['Across', dia + ' mm'], ['Prints on', t.page], ['Servos', 3], ['Weight', Math.round(B.tmass.total) + ' g']];
      $('#hud').innerHTML = chips.map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join('');
    }
  }

  function drawWiring(w, anchors, list) {
    const svg = $('#wireSvg'), H = 250;
    const txt = (x, y, t, anchor, cls) => `<text x="${x}" y="${y}" text-anchor="${anchor || 'start'}" ${cls === 'ink' ? 'style="fill:var(--ink);font-size:11px;font-family:var(--font-body)"' : ''}>${t}</text>`;
    const box = (x, y, bw, bh) => `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="6" fill="var(--panel)" stroke="var(--line)" stroke-width="1.2"/>`;
    const wire = (pts, color) => `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
    const SIG = '#e8892b', POS = '#d1453b', NEG = '#7a5a3a';
    const servos = list || (anchors ? [['Left cable', w.pins[0]], ['Right cable', w.pins[1]], ['Head anchor', w.pins[2]], ['Tail anchor', w.pins[3]]] : [['Left cable', w.pins[0]], ['Right cable', w.pins[1]]]);
    const sx = 250, sw = 100, sh = 32, gap = servos.length > 3 ? 10 : servos.length === 3 ? 14 : 24, sy0 = 14;
    const busP = 214, busN = 226;     // x of the + and − risers next to the servos
    let g = '';
    // board
    g += box(14, 14, 104, 70) + txt(66, 40, { nano: 'Arduino Nano', esp32: 'ESP32 DevKit', pico: 'Pi Pico' }[B.board], 'middle', 'ink') + txt(66, 56, 'signal pins', 'middle');
    // battery
    g += box(14, 168, 120, 44) + (w.onboard || list ? txt(74, 188, 'LiPo → switch → boost', 'middle', 'ink') + txt(74, 203, '5 V out', 'middle') : txt(74, 188, '4× AA NiMH', 'middle', 'ink') + txt(74, 203, '4.8 V', 'middle'));
    // power risers
    g += wire([[134, 180], [busP, 180], [busP, sy0 + 8]], POS);
    g += wire([[134, 200], [busN, 200], [busN, sy0 + 16]], NEG);
    // board power and ground from the pack
    g += wire([[40, 168], [40, 84]], POS) + wire([[60, 168], [60, 84]], NEG);
    servos.forEach(([name, pin], i) => {
      const y = sy0 + i * (sh + gap), mid = y + sh / 2;
      const ys = 26 + i * 12;
      g += wire([[118, ys], [150 + i * 8, ys], [150 + i * 8, mid - 8], [sx, mid - 8]], SIG);
      g += wire([[busP, mid], [sx, mid]], POS) + wire([[busN, mid + 8], [sx, mid + 8]], NEG);
      g += box(sx, y, sw, sh) + txt(sx + sw / 2, y + 14, name, 'middle', 'ink') + txt(sx + sw / 2, y + 26, pin, 'middle');
    });
    g += `<circle cx="${busP}" cy="180" r="3" fill="${POS}"/><circle cx="${busN}" cy="200" r="3" fill="${NEG}"/>`;
    g += txt(14, 254, 'Put a 470 µF capacitor across + and − at the servos.', 'start');
    g += `<rect x="14" y="230" width="10" height="4" fill="${SIG}"/>` + txt(28, 235, 'signal', 'start');
    g += `<rect x="64" y="230" width="10" height="4" fill="${POS}"/>` + txt(78, 235, '+', 'start');
    g += `<rect x="92" y="230" width="10" height="4" fill="${NEG}"/>` + txt(106, 235, '− ground', 'start');
    svg.innerHTML = g;
  }

  // ---- files ----
  // a normal website can hand files to the browser directly
  function saveFile(filename, data, statusEl) {
    const st = statusEl || $('#dlStatus');
    try {
      const type = filename.endsWith('.svg') ? 'image/svg+xml' : filename.endsWith('.zip') ? 'application/zip' : 'text/plain';
      const blob = data instanceof Blob ? data : new Blob([data], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      st.textContent = `Downloaded ${filename}.`;
    } catch (e) { st.textContent = `Could not save ${filename}: ${e.message}`; }
  }
  function kitFiles() {
    if (B.robot === 'transformer') {
      const tp = T.params, o = tOpts();
      const md = CL.transformerReadme(tp, B.tplan, B.tmpl, B.tcheck, o);
      return [
        { name: 'origami-transformer/README.md', data: md },
        { name: 'origami-transformer/template-body.svg', data: B.tmpl.svg },
        { name: 'origami-transformer/template-plates.svg', data: B.tmpl.partsSvg },
        { name: 'origami-transformer/template-trays-neck.svg', data: B.tmpl.traysSvg },
        { name: 'origami-transformer/template-head.svg', data: B.tmpl.headSvg },
        { name: 'origami-transformer/transformer/transformer.ino', data: B.sketch },
        { name: 'origami-transformer/bom.csv', data: CL.bomCSV(CL.transformerBom(tp, B.tplan, o)) },
        { name: 'origami-transformer/robot.json', data: JSON.stringify({ robot: tp, plan: B.tplan, size_mm: B.R_mm }, null, 2) },
      ];
    }
    const p = M.params, plan = B.plan;
    const md = CL.readme(p, plan, B.tmpl, { board: B.board, gaitName: gaitName(), power: B.power, servo: B.servo, payload: B.payload && !B.payload.error ? B.payload : null });
    const gait = JSON.stringify({ robot: p, creaseStiffness: M.crease, gait: M.gait, size_mm: B.R_mm, spool_mm: plan.spool_mm }, null, 2);
    return [
      { name: 'origami-crawler/README.md', data: md },
      { name: 'origami-crawler/template-body.svg', data: B.tmpl.svg },
      { name: 'origami-crawler/template-plates.svg', data: B.tmpl.partsSvg },
      { name: 'origami-crawler/template-trays.svg', data: B.tmpl.traysSvg },
      { name: 'origami-crawler/crawler/crawler.ino', data: B.sketch },
      { name: 'origami-crawler/bom.csv', data: CL.bomCSV(CL.bom(p, { board: B.board, anchors: plan.anchors, R_mm: B.R_mm, feet: M.gait.feet, power: B.power, servo: B.servo, spool_mm: plan.spool_mm })) },
      { name: 'origami-crawler/gait.json', data: gait },
    ];
  }
  $('#dlZip').addEventListener('click', () => { const z = CL.makeZip(kitFiles()); saveFile(B.robot === 'transformer' ? 'origami-transformer.zip' : 'origami-crawler.zip', new Blob([z], { type: 'application/zip' })); });
  $('#dlBody').addEventListener('click', () => saveFile('origami-crawler-body.svg', B.tmpl.svg));
  $('#dlParts').addEventListener('click', () => saveFile('origami-crawler-plates.svg', B.tmpl.partsSvg));
  $('#dlTrays').addEventListener('click', () => { saveFile(B.robot === 'transformer' ? 'origami-transformer-trays-neck.svg' : 'origami-crawler-trays.svg', B.tmpl.traysSvg); if (B.tmpl.headSvg) setTimeout(() => saveFile('origami-transformer-head.svg', B.tmpl.headSvg), 400); });
  $('#copyCode').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try { await navigator.clipboard.writeText(B.sketch); btn.textContent = 'Copied'; }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('#codeBox')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = 'Selected, press Ctrl+C'; }
    setTimeout(() => (btn.textContent = 'Copy'), 1800);
  });
  $('#cpTemplate').addEventListener('click', () => {
    const title = state.key === 'custom' ? (state.custom.title || 'imported') : CL.PATTERNS[state.key].name;
    saveFile(title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-template.svg', CL.sheetTemplate(pat, { title }), $('#foldErr'));
    $('#foldErr').hidden = false;
  });

  // =====================================================================
  // MODULES: one fold, three ways to power it, and copies in a row
  // =====================================================================
  const MD = {
    p: CL.defaultModule(), view: 'rig', modules: 3, gait: 'wave', feet: 'directional', build: 'one', board: 'nano', speed: 1,
    rig: null, crawler: null, fold: false, run: true, ct: 0, test: null, timing: null, crawl: null, compare: null, plan: null,
    gen: 0, inited: false, last: 0, camX: null, colors: null, hudN: 0,
  };
  const MODP = Object.fromEntries(CL.MODULE_PARAMS.map((q) => [q.key, q]));
  const KIND_LABEL = { servo: 'Servo', wire: 'SMA wire', spring: 'SMA spring' };
  const KIND_HINT = {
    servo: 'A micro servo on the fixed panel winds a thread onto a spool. Fast, strong and exact, but each one weighs as much as 40 panels of card.',
    wire: 'Shape-memory (Nitinol) wire shortens about 4% when current heats it to about 80 °C, then a band stretches it out again as it cools. Almost weightless, but it barely moves, so the extra length runs back and forth over pins, and cooling is the slow part.',
    spring: 'The same metal wound into a coil. It shortens by much more than a straight wire, so it needs no routing, but it pulls more weakly and a coil cools more slowly.',
  };
  const fmtP = (q) => (v) => (q.int ? String(Math.round(v)) : v < 1 && q.step < 0.1 ? (+v).toFixed(2) : v < 10 && q.step < 1 ? (+v).toFixed(q.step < 0.1 ? 2 : 1) : String(Math.round(v))) + (q.unit ? (q.unit === '°' || q.unit === '%' ? q.unit : ' ' + q.unit) : '');
  let modQueued = null, modLiveQueued = null;
  function modChanged() {
    modPlanStale();
    clearTimeout(modLiveQueued); modLiveQueued = setTimeout(() => modLive(), 60);
    clearTimeout(modQueued); modQueued = setTimeout(() => modAnalyze(), 280);
  }
  function modSlider(host, q, get, set) {
    return slider(host, { id: 'mod-' + q.key + '-' + host.id, label: q.label + (q.hint ? ` <small class="hint">${q.hint}</small>` : ''), min: q.min, max: q.max, step: q.step, value: get(), fmt: fmtP(q), onInput: (v) => { set(v); modChanged(); } });
  }
  function renderModParams() {
    const p = MD.p, kind = p.actuator;
    for (const b of $('#modKind').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === kind));
    $('#modKindHint').textContent = KIND_HINT[kind];
    const host = $('#modActParams'); host.innerHTML = '';
    const keys = kind === 'servo' ? ['target', 'spool'] : kind === 'wire' ? ['wireL', 'strain'] : ['springD', 'coilD', 'turns'];
    if (kind === 'wire') {
      const f = document.createElement('div'); f.className = 'field';
      f.innerHTML = `<label for="modWireD">Wire diameter</label><select id="modWireD">${MODP.wireD.choices.map((d) => `<option value="${d}"${Math.abs(d - p.wireD) < 1e-6 ? ' selected' : ''}>${d.toFixed(2)} mm · ${Math.round(CL.ratedCurrent(d * 1e-3) * 1000)} mA · pulls ${Math.round(CL.ratedPull(d * 1e-3) / 9.81 * 1000)} g</option>`).join('')}</select>`;
      host.appendChild(f);
      f.querySelector('select').addEventListener('change', (e) => { p.wireD = +e.target.value; modChanged(); });
    }
    for (const k of keys) modSlider(host, MODP[k], () => p[k], (v) => (p[k] = v));
    $('#modServoField').hidden = kind !== 'servo'; $('#modServo').value = p.servo;
    $('#modSupplyField').hidden = kind === 'servo';
    for (const b of $('#modSupply').querySelectorAll('button')) b.setAttribute('aria-pressed', String(+b.dataset.v === p.V));
    const hh = $('#modHinge'); hh.innerHTML = '';
    for (const k of ['a', 'w', 'gsm', 'tip']) modSlider(hh, MODP[k], () => p[k], (v) => (p[k] = v));
    const mh = $('#modMount'); mh.innerHTML = '';
    $('#modMountHead').textContent = 'Mounting for the ' + KIND_LABEL[kind].toLowerCase().replace('sma', 'SMA');
    const mnt = CL.mountOf(p);
    p.mount[kind] = mnt;
    for (const k of ['s1', 's2', 'e', 'band']) modSlider(mh, MODP[k], () => mnt[k], (v) => (mnt[k] = v));
    const ch = $('#modChain'); ch.innerHTML = '';
    modSlider(ch, { key: 'modules', label: 'Modules', min: 1, max: 6, step: 1, int: true }, () => MD.modules, (v) => (MD.modules = Math.round(v)));
    modSlider(ch, MODP.arch, () => p.arch, (v) => (p.arch = v));
    for (const [id, v] of [['#modGait', MD.gait], ['#modFeet', MD.feet], ['#modBuild', MD.build], ['#modViewTabs', MD.view]]) for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === v));
    for (const b of $('#modSpeed').querySelectorAll('button')) b.setAttribute('aria-pressed', String(+b.dataset.v === MD.speed));
    $('#modBoard').value = MD.board;
  }
  const segBind = (id, fn) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; for (const x of $(id).querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b)); fn(b.dataset.v); });
  segBind('#modKind', (v) => { MD.p.actuator = v; MD.fold = false; renderModParams(); modChanged(); });
  segBind('#modSupply', (v) => { MD.p.V = +v; modChanged(); });
  segBind('#modGait', (v) => { MD.gait = v; modChanged(); });
  segBind('#modFeet', (v) => { MD.feet = v; modChanged(); });
  segBind('#modBuild', (v) => { MD.build = v; modPlanSoon(); });
  segBind('#modViewTabs', (v) => { MD.view = v; MD.camX = null; modButtons(); });
  segBind('#modSpeed', (v) => { MD.speed = +v; });
  $('#modServo').addEventListener('change', (e) => { MD.p.servo = e.target.value; modChanged(); });
  $('#modBoard').addEventListener('change', (e) => { MD.board = e.target.value; modPlanSoon(); });
  $('#modReset').addEventListener('click', () => { const k = MD.p.actuator; MD.p = CL.defaultModule(); MD.p.actuator = k; MD.modules = 3; renderModParams(); modChanged(); });
  $('#modFold').addEventListener('click', () => {
    if (MD.view === 'rig') MD.fold = !MD.fold; else MD.run = !MD.run;
    modButtons();
  });
  $('#modRestart').addEventListener('click', () => { modLive(); });
  function modButtons() {
    const b = $('#modFold');
    b.textContent = MD.view === 'rig' ? (MD.fold ? 'Release' : 'Fold') : (MD.run ? 'Stop' : 'Crawl');
  }

  // live simulations for the side view
  function modLive() {
    const p = JSON.parse(JSON.stringify(MD.p));
    MD.rig = new CL.Hinge(p);
    if (MD.timing) {
      MD.crawler = new CL.Crawler(p, { modules: MD.modules, feet: MD.feet });
      MD.ct = 0; MD.camX = null; MD.x0 = MD.crawler.com();
    }
    modButtons();
  }
  function modTick() {
    const now = performance.now(), dt = Math.min(0.05, MD.last ? (now - MD.last) / 1000 : 1 / 60) * MD.speed;
    MD.last = now;
    if (!MD.rig) modLive();
    const n = Math.max(1, Math.round(dt / 2e-4));
    if (MD.view === 'rig') { MD.rig.cmd = MD.fold; MD.rig.step(n); }
    else if (MD.crawler && MD.timing) {
      let left = dt;
      while (left > 1e-6) {
        const h = Math.min(left, 0.02);
        MD.crawler.cmd = MD.run ? CL.chainCmd(MD.gait, MD.modules, MD.ct, MD.timing).cmd : new Array(MD.modules).fill(false);
        MD.crawler.step(Math.max(1, Math.round(h / 2e-4)));
        MD.ct += h; left -= h;
      }
    }
    modDraw();
    if (++MD.hudN % 6 === 0) modHud();
  }
  function modHud() {
    const chips = [];
    const chip = (k, v, warn) => chips.push(`<span class="chip${warn ? ' warn' : ''}">${k} <b>${v}</b></span>`);
    if (MD.view === 'rig' && MD.rig) {
      const h = MD.rig, a = h.act;
      chip('Fold', Math.round(h.th / DEG) + '°');
      if (a.kind === 'servo') { chip('Servo', Math.round(a.phi / DEG) + '°'); chip('Pull', a.Tn.toFixed(2) + ' N'); }
      else { chip(a.kind === 'wire' ? 'Wire' : 'Spring', Math.round(a.Tc) + ' °C', a.Tc > 140); chip('Pull', a.Tn.toFixed(2) + ' N'); chip('Power', a.duty > 0 ? Math.round(a.duty * 100) + '%' : 'off'); }
      chip('Current', (a.I * 1000 < 1000 ? Math.round(a.I * 1000) + ' mA' : a.I.toFixed(2) + ' A'));
    } else if (MD.crawler) {
      const c = MD.crawler;
      chip('Crawled', Math.round((c.com() - MD.x0) * 1000) + ' mm');
      chip('Time', MD.ct.toFixed(1) + ' s');
      chip('Current', c.current().toFixed(2) + ' A');
      if (c.acts[0].kind !== 'servo') chip('Hottest', Math.round(Math.max(...c.acts.map((a) => a.Tc))) + ' °C');
    }
    $('#modHud').innerHTML = chips.join('');
  }

  // ---- the side view ----
  function modColors() {
    if (MD.colors) return MD.colors;
    const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim();
    MD.colors = { ink: v('--ink'), muted: v('--muted'), line: v('--rule'), paper: v('--paper'), back: v('--paper-back'), accent: v('--accent'), warn: v('--warn'), stage: v('--stage'), grid: v('--grid3d'), panel: v('--surface') };
    return MD.colors;
  }
  function heatColor(T) {
    const u = Math.max(0, Math.min(1, (T - 25) / 80));
    const c0 = [120, 128, 140], c1 = [232, 68, 43];
    return `rgb(${c0.map((c, i) => Math.round(c + (c1[i] - c) * u)).join(',')})`;
  }
  function modDraw() {
    const cv = $('#modCanvas'), dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'), C = modColors();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.font = '12px ' + getComputedStyle(document.body).fontFamily;
    if (MD.view === 'rig') drawRig(g, W, H, C); else drawCrawler(g, W, H, C);
  }
  function drawActuator(g, C, kind, act, A, B, k, extra) {
    // A, B: anchor tops in screen px; k: px per mm
    if (kind === 'servo') {
      g.strokeStyle = '#e8892b'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.stroke();
    } else if (kind === 'wire') {
      g.strokeStyle = heatColor(act.Tc); g.lineWidth = Math.max(1.6, 0.15 * k * 4);
      g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.stroke();
      if (extra) extra();
    } else {
      const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, n = 14, amp = Math.max(2, (act.D || 1.2e-3) * 1000 * k * 0.5);
      g.strokeStyle = heatColor(act.Tc); g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(A[0], A[1]);
      for (let i = 1; i < n; i++) { const t = i / n, s = i % 2 ? 1 : -1; g.lineTo(A[0] + dx * t + nx * amp * s, A[1] + dy * t + ny * amp * s); }
      g.lineTo(B[0], B[1]); g.stroke();
    }
  }
  function post(g, C, base, top) { g.strokeStyle = C.muted; g.lineWidth = 2; g.beginPath(); g.moveTo(base[0], base[1]); g.lineTo(top[0], top[1]); g.stroke(); }
  function drawRig(g, W, H, C) {
    const h = MD.rig; if (!h) return;
    const p = h.p, a = p.a, m = CL.mountOf(p), act = h.act, kind = act.kind;
    const k = Math.min((W * 0.78) / (2 * a + 12), (H * 0.62) / (a + 16));
    const ox = W * 0.52, oy = H * 0.66;
    const S = (x, y) => [ox + x * k, oy - y * k];
    const th = h.th, c = Math.cos(th), s = Math.sin(th);
    const R = (x, y) => S(x * c - y * s, x * s + y * c);       // a point on the moving panel
    // table and clamp
    g.fillStyle = C.grid; g.fillRect(0, oy + 2, ox - 1, H - oy);
    g.fillStyle = C.muted; g.fillRect(S(-a, 0)[0] - 4, oy - 3 * k - 4, 6 * k, 3 * k + 2);
    g.fillStyle = C.ink; g.font = '11px ' + getComputedStyle(document.body).fontFamily; g.fillText('clamped to the table', S(-a, 0)[0] - 4, oy + 20);
    // stop tab under the crease, band underneath
    g.fillStyle = C.line; const st = S(-4, -1.2); g.fillRect(st[0], st[1], 4 * k, 1.2 * k);
    const ra = R(m.s2, -m.e), la = S(-m.s1, -m.e);
    g.strokeStyle = C.ink; g.globalAlpha = 0.55; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(la[0], la[1]); g.lineTo(S(0, -m.e)[0], S(0, -m.e)[1]);
    g.arc(ox, oy, m.e * k, Math.PI / 2, Math.PI / 2 - th, true);
    g.lineTo(ra[0], ra[1]); g.stroke(); g.globalAlpha = 1;
    post(g, C, S(-m.s1, 0), la); post(g, C, R(m.s2, 0), ra);
    // panels
    const pl = (P, Q) => { g.strokeStyle = C.ink; g.lineWidth = Math.max(3, 0.3 * k * 2); g.beginPath(); g.moveTo(P[0], P[1]); g.lineTo(Q[0], Q[1]); g.stroke(); g.strokeStyle = C.paper; g.lineWidth = Math.max(1.5, 0.3 * k * 2) - 1.5; g.stroke(); };
    pl(S(-a, 0), S(0, 0)); pl(S(0, 0), R(a, 0));
    if (p.tip > 0) { const T = R(a, 0); g.fillStyle = C.muted; g.fillRect(T[0] - 4, T[1] - 4, 8, 8); }
    // anchors and the puller
    const A = S(-m.s1, m.e), B = R(m.s2, m.e);
    post(g, C, S(-m.s1, 0), A); post(g, C, R(m.s2, 0), B);
    if (kind === 'servo') {
      const bx0 = S(-m.s1 - 3 - 22.5, 0), w = 22.5 * k, hh = 12 * k;
      g.fillStyle = C.panel; g.strokeStyle = C.muted; g.lineWidth = 1.2; g.fillRect(bx0[0], bx0[1] - hh, w, hh); g.strokeRect(bx0[0], bx0[1] - hh, w, hh);
      const sc = [bx0[0] + w - 6 * k, bx0[1] - hh - p.spool * k];
      g.beginPath(); g.arc(sc[0], sc[1], p.spool * k, 0, 2 * Math.PI); g.stroke();
      g.beginPath(); g.moveTo(sc[0], sc[1]); g.lineTo(sc[0] + p.spool * k * Math.cos(-act.phi), sc[1] + p.spool * k * Math.sin(-act.phi)); g.stroke();
      g.strokeStyle = '#e8892b'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(sc[0] + p.spool * k, sc[1]); g.lineTo(A[0], A[1]); g.stroke();
      g.fillStyle = C.muted; g.fillText('servo', bx0[0] + 4, bx0[1] - hh / 2 + 4);
    }
    drawActuator(g, C, kind, act, A, B, k, () => {
      // the extra wire runs back along the fixed panel over pins
      const extra = act.extra / 1e-3; if (extra < 1) return;
      g.setLineDash([3, 3]); g.lineWidth = 1.2; g.beginPath(); g.moveTo(A[0], A[1]); const back = S(-a + 3, m.e); g.lineTo(back[0], back[1]); g.stroke(); g.setLineDash([]);
      g.fillStyle = C.muted; g.fillText(`+${Math.round(extra)} mm of wire over pins`, back[0], back[1] - 8);
    });
    g.fillStyle = C.muted;
    g.fillText('A', A[0] - 4, A[1] - 6); g.fillText('B', B[0] + 4, B[1] - 6);
    const bl = S(-m.s1, -m.e - 4); g.fillText('return band', bl[0] - 20, bl[1] + 10);
    // the angle
    g.strokeStyle = C.accent; g.lineWidth = 1.2; g.beginPath(); g.arc(ox, oy, a * 0.35 * k, 0, -Math.max(0, th), true); g.stroke();
    g.fillStyle = C.accent; g.font = '600 13px ' + getComputedStyle(document.body).fontFamily;
    const lab = R(a * 0.45, 4); g.fillText(Math.round(th / DEG) + '°', lab[0] + 4, lab[1]);
  }
  function drawCrawler(g, W, H, C) {
    const cr = MD.crawler;
    if (!cr) { g.fillStyle = C.muted; g.fillText('Working out the gait…', 20, H / 2); return; }
    const p = cr.q, m = CL.mountOf(p), a = p.a, N = cr.N, hf = 5;
    const len = (N + 1) * a;
    const k = Math.min((W * 0.8) / (len + 30), (H * 0.6) / (a * 1.4 + 20));
    const cx = cr.com() * 1000;
    MD.camX = MD.camX == null ? cx : MD.camX + (cx - MD.camX) * 0.08;
    const ox = W / 2 - MD.camX * k, oy = H * 0.64;
    const S = (x, y) => [ox + x * k, oy - y * k];
    // ground with marks every 10 mm
    g.fillStyle = C.grid; g.fillRect(0, oy, W, H - oy);
    g.strokeStyle = C.muted; g.lineWidth = 1; g.globalAlpha = 0.5;
    const x0 = Math.floor((-ox / k) / 10) * 10;
    for (let x = x0; x < (W - ox) / k; x += 10) { const P = S(x, 0); g.beginPath(); g.moveTo(P[0], oy); g.lineTo(P[0], oy + (x % 50 === 0 ? 9 : 5)); g.stroke(); }
    g.globalAlpha = 1;
    const st = S(MD.x0 * 1000, 0); g.strokeStyle = C.accent; g.beginPath(); g.moveTo(st[0], oy - 6); g.lineTo(st[0], oy + 12); g.stroke();
    g.fillStyle = C.accent; g.fillText('start', st[0] + 4, oy + 22);
    const X = cr.X.map((v) => v * 1000), Y = cr.Y.map((v) => v * 1000 + hf);
    // feet
    g.strokeStyle = C.muted; g.lineWidth = 2;
    for (let i = 0; i <= N + 1; i++) { const P = S(X[i], Y[i]), Q = S(X[i] - 1.5, Y[i] - hf); g.beginPath(); g.moveTo(P[0], P[1]); g.lineTo(Q[0], Q[1]); g.stroke(); }
    // pullers under each fold (the inside of an arch is underneath)
    for (let j = 1; j <= N; j++) {
      const act = cr.acts[j - 1];
      const u1 = [(X[j] - X[j - 1]) / a, (Y[j] - Y[j - 1]) / a], u2 = [(X[j + 1] - X[j]) / a, (Y[j + 1] - Y[j]) / a];
      const n1 = [u1[1], -u1[0]], n2 = [u2[1], -u2[0]];
      const Ab = [X[j] - u1[0] * m.s1, Y[j] - u1[1] * m.s1], Bb = [X[j] + u2[0] * m.s2, Y[j] + u2[1] * m.s2];
      const A = [Ab[0] + n1[0] * m.e, Ab[1] + n1[1] * m.e], B = [Bb[0] + n2[0] * m.e, Bb[1] + n2[1] * m.e];
      post(g, C, S(...Ab), S(...A)); post(g, C, S(...Bb), S(...B));
      drawActuator(g, C, act.kind, act, S(...A), S(...B), k);
      if (act.kind === 'servo') {
        // the servo sits on top of the panel behind the crease
        const c0 = [X[j] - u1[0] * (m.s1 + 3 + 22.5), Y[j] - u1[1] * (m.s1 + 3 + 22.5)], up = [-n1[0], -n1[1]];
        const q = [c0, [c0[0] + u1[0] * 22.5, c0[1] + u1[1] * 22.5]];
        const pts = [q[0], q[1], [q[1][0] + up[0] * 12, q[1][1] + up[1] * 12], [q[0][0] + up[0] * 12, q[0][1] + up[1] * 12]].map((P) => S(...P));
        g.fillStyle = C.panel; g.strokeStyle = C.muted; g.lineWidth = 1.2; g.beginPath(); pts.forEach((P, i) => (i ? g.lineTo(P[0], P[1]) : g.moveTo(P[0], P[1]))); g.closePath(); g.fill(); g.stroke();
      }
    }
    // the panels
    g.strokeStyle = C.ink; g.lineWidth = Math.max(3, 0.6 * k);
    g.beginPath(); for (let i = 0; i <= N + 1; i++) { const P = S(X[i], Y[i]); i ? g.lineTo(P[0], P[1]) : g.moveTo(P[0], P[1]); } g.stroke();
    g.strokeStyle = C.paper; g.lineWidth = Math.max(1.5, 0.6 * k - 1.5); g.stroke();
    g.fillStyle = C.muted; g.fillText('tail', S(X[0], 0)[0] - 10, oy + 22); g.fillText('head →', S(X[N + 1], 0)[0] - 10, oy + 22);
  }

  // ---- analysis: fold test, crawler, the three-way comparison, the kit ----
  const fN = (v, d) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(d));
  function modAnalyze() {
    const gen = ++MD.gen, p = JSON.parse(JSON.stringify(MD.p)), o = { modules: MD.modules, gait: MD.gait, feet: MD.feet };
    $('#modTestStatus').textContent = 'testing…'; $('#modCrawlStatus').textContent = 'crawling…'; $('#modCmpStatus').textContent = 'comparing…';
    const later = (fn) => setTimeout(() => { if (gen === MD.gen) fn(); }, 0);
    later(() => {
      MD.test = CL.foldTest(p); MD.timing = CL.crawlerTiming(p);   // the crawler's module is cut for the arch stop
      renderModTest(p);
      later(() => {
        MD.crawl = CL.chainTest(p, Object.assign({ cycles: 4, timing: MD.timing }, o));
        renderModCrawl(p, o);
        MD.crawler = new CL.Crawler(p, { modules: MD.modules, feet: MD.feet }); MD.ct = 0; MD.camX = null; MD.x0 = MD.crawler.com();
        const rows = [], kinds = ['servo', 'wire', 'spring'];
        const next = (i) => later(() => {
          if (i === kinds.length) { MD.compare = rows; renderModCompare(rows, true); modPlanSoon(); return; }
          const q = Object.assign(JSON.parse(JSON.stringify(p)), { actuator: kinds[i] });
          const same = kinds[i] === p.actuator;
          const r = same ? MD.test : CL.foldTest(q), tm = same ? MD.timing : CL.crawlerTiming(q);
          const c = same ? MD.crawl : CL.chainTest(q, Object.assign({ cycles: 3, timing: tm, trace: false }, o));
          rows.push({ kind: kinds[i], q, test: r, chain: c, warnings: CL.moduleWarnings(q, r).concat(CL.crawlerWarnings(q, c, o)) });
          renderModCompare(rows, false);
          next(i + 1);
        });
        next(0);
      });
    });
  }
  let modPlanTimer = null;
  function modPlanStale() { MD.plan = null; $('#modZip').disabled = true; $('#modTpl').disabled = true; $('#modDlStatus').textContent = 'Updating the kit…'; }
  function modPlanSoon() { modPlanStale(); clearTimeout(modPlanTimer); modPlanTimer = setTimeout(modPlan, 30); }
  function modPlan() {
    const p = JSON.parse(JSON.stringify(MD.p));
    try { MD.plan = CL.modulePlan(p, { build: MD.build, modules: MD.modules, gait: MD.gait, feet: MD.feet, board: MD.board }); }
    catch (e) { $('#modBuildHint').textContent = 'Could not make the kit: ' + e.message; return; }
    renderModBuild();
    $('#modZip').disabled = false; $('#modTpl').disabled = false; $('#modDlStatus').textContent = MD.plan.notes.length ? 'Check first: ' + MD.plan.notes.join(' ') : '';
  }
  function renderModTest(p) {
    const r = MD.test, a = r.act, kind = r.kind;
    $('#modTestStatus').textContent = KIND_LABEL[kind];
    const ser = [{ pts: r.trace.map((s) => [s.t, s.th]), color: 'var(--accent)', marks: [[r.t0, 0, 'power on'], [r.t0 + r.onS, (r.trace.find((s) => s.t >= r.t0 + r.onS) || {}).th || 0, 'off']] }];
    if (kind !== 'servo') ser.push({ pts: r.trace.map((s) => [s.t, s.T]), color: 'var(--warn)' });
    chart($('#modChart'), { series: ser, xLabel: 'seconds', yLabel: kind === 'servo' ? 'fold (°)' : '° and °C', xFmt: (v) => fN(v, 0), yFmt: (v) => fN(v, 0), ymin: 0, h: 170 });
    $('#modChartKey').innerHTML = `<span><i style="background:var(--accent)"></i>fold angle (°)</span>` + (kind !== 'servo' ? `<span><i style="background:var(--warn)"></i>${kind === 'wire' ? 'wire' : 'spring'} temperature (°C)</span>` : '');
    const kv = [];
    kv.push(['Folds to', fN(r.peak, 0) + '°']);
    kv.push(['Closes in', r.foldS != null ? fN(r.foldS, 2) + ' s' : '—']);
    kv.push(['Opens in', r.openS != null ? fN(r.openS, 1) + ' s' : 'not on its own']);
    kv.push(['Energy per fold', fN(r.energy, 2) + ' J']);
    if (kind === 'servo') { kv.push(['Current, most', fN(r.peakI, 2) + ' A at 5 V']); kv.push(['Pull on the thread, most', fN(r.maxPull, 2) + ' N']); kv.push(['Servo travel', fN(a.phiFold / DEG, 0) + '°']); }
    else {
      kv.push(['Wire', fN(a.wireLen * 1000, 0) + ' mm, ' + fN(a.R, 1) + ' Ω']);
      kv.push(['Current pulses', fN(a.Ipk, 2) + ' A']);
      kv.push(['Power: heat, hold', `${Math.round(a.drive.heat * 100)}%, ${Math.round(a.drive.hold * 100)}%`]);
      kv.push(['Hottest', fN(r.peakT, 0) + ' °C']);
      kv.push(['Pull, most', fN(r.maxPull, 2) + ' N']);
      kv.push(['Stress, most', `${fN(r.peakS / 1e6, 0)} MPa (${fN(a.rated / 1e6, 0)} for long life)`]);
    }
    kv.push(['Puller weighs', fN(a.mass * 1000, 1) + ' g']);
    $('#modStats').innerHTML = kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const w = CL.moduleWarnings(p, r);
    $('#modWarn').innerHTML = w.length ? w.map((t) => `<li>${t}</li>`).join('') : `<li class="ok">Folds and opens cleanly at these settings.</li>`;
  }
  function renderModCrawl(p, o) {
    const c = MD.crawl;
    $('#modCrawlStatus').textContent = `${o.modules} × ${KIND_LABEL[p.actuator]}`;
    chart($('#modCrawlChart'), { series: [{ pts: c.trace, color: 'var(--accent)', end: true }], xLabel: 'seconds', yLabel: 'mm crawled', xFmt: (v) => fN(v, 0), yFmt: (v) => fN(v, 0), zero: true, h: 150 });
    const kv = [
      ['Speed', fN(c.speed, 2) + ' mm/s'], ['Per cycle', fN(c.perCycle, 1) + ' mm every ' + fN(c.period, 1) + ' s'],
      ['Weight', fN(c.mass * 1000, 1) + ' g (on a tether)'], ['Energy', fN(c.energyPerCycle, 1) + ' J per cycle'],
      ['Distance per joule', fN(c.mmPerJ, 1) + ' mm'], ['Current, most', fN(c.peakI, 2) + ' A, all folds'],
    ];
    if (p.actuator === 'wire') kv.push(['Wire per fold', fN(c.wireL, 0) + ' mm (cut to reach the stop)']);
    $('#modCrawlStats').innerHTML = kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const w = CL.crawlerWarnings(p, c, o);
    $('#modCrawlWarn').innerHTML = w.map((t) => `<li>${t}</li>`).join('');
  }
  function renderModCompare(rows, done) {
    $('#modCmpStatus').textContent = done ? '' : 'comparing…';
    const by = (k) => rows.find((r) => r.kind === k);
    const cols = ['servo', 'wire', 'spring'].map(by);
    const R = [
      ['Folds to', (r) => r.test.peak, (v) => fN(v, 0) + '°', null],
      ['Closes in', (r) => r.test.foldS, (v) => fN(v, 2) + ' s', 'min'],
      ['Opens again in', (r) => (r.test.returned ? r.test.openS : null), (v) => (v == null ? 'stuck' : fN(v, 1) + ' s'), 'min'],
      ['Energy per fold', (r) => r.test.energy, (v) => fN(v, 2) + ' J', 'min'],
      ['Current, most', (r) => (r.kind === 'servo' ? r.test.peakI : r.test.act.Ipk), (v) => fN(v, 2) + ' A', 'min'],
      ['Weight per module', (r) => r.test.mass * 1000, (v) => fN(v, 1) + ' g', 'min'],
      ['Parts per module', (r) => CL.moduleCost(r.kind, r.q), (v) => '≈ $' + fN(v, 0), 'min'],
      [`Crawler of ${MD.modules}`, (r) => r.chain.speed, (v) => fN(v, 1) + ' mm/s', 'max'],
      ['Crawler weight', (r) => r.chain.mass * 1000, (v) => fN(v, 1) + ' g', 'min'],
      ['Problems', (r) => r.warnings.length, (v) => (v ? String(v) : 'none'), 'min'],
    ];
    const SHORT = { servo: 'Servo', wire: 'Wire', spring: 'Spring' };
    let h = `<thead><tr><th></th>${['servo', 'wire', 'spring'].map((k) => `<th class="num${k === MD.p.actuator ? ' pick' : ''}">${SHORT[k]}</th>`).join('')}</tr></thead><tbody>`;
    for (const [name, get, fmt, best] of R) {
      const vals = cols.map((r) => (r ? get(r) : undefined));
      const ok = vals.filter((v) => v != null && isFinite(v));
      const target = best && ok.length === 3 ? (best === 'min' ? Math.min(...ok) : Math.max(...ok)) : null;
      h += `<tr><td>${name}</td>${vals.map((v) => `<td class="num${target != null && v === target ? ' good' : ''}">${v === undefined ? '…' : fmt(v)}</td>`).join('')}</tr>`;
    }
    $('#modCompare').innerHTML = h + '</tbody>';
    const vd = $('#modVerdict');
    if (!done || rows.length < 3) { vd.hidden = true; return; }
    const s = by('servo'), w = by('wire'), sp = by('spring');
    const cyc = (r) => (r.test.foldS || 0) + (r.test.openS || 99);
    vd.hidden = false;
    vd.innerHTML = `<b>Servo</b>: a fold and back in ${fN(cyc(s), 1)} s, but ${fN(s.test.mass * 1000, 0)} g per module, so ${MD.modules} of them weigh ${fN(s.chain.mass * 1000, 0)} g. ` +
      `<b>SMA wire</b>: ${fN(w.test.mass * 1000, 1)} g and silent, but ${fN(cyc(w), 1)} s per fold, most of it waiting to cool, and ${fN(w.test.energy / Math.max(1e-6, s.test.energy), 1)}× the servo's energy. ` +
      `<b>SMA spring</b>: no routing, ${fN(cyc(sp), 1)} s per fold, and ${fN(sp.test.maxPull, 2)} N of pull against the wire's ${fN(w.test.maxPull, 2)} N. ` +
      `For a robot that has to carry its own battery, the light pullers win; for speed and control on a tether, the servo does.`;
  }
  function renderModBuild() {
    const pl = MD.plan; if (!pl) return;
    const w = CL.moduleWiring(pl), ws = CL.moduleWiringSvg(pl);
    const svg = $('#modWireSvg'); svg.setAttribute('viewBox', ws.viewBox); svg.innerHTML = ws.svg;
    $('#modWireList').innerHTML = w.rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('#modBom').innerHTML = '<thead><tr><th>For</th><th>Part</th><th>Qty</th><th>Notes</th></tr></thead><tbody>' + CL.moduleBom(pl).map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="num">${r[2]}</td><td>${r[3]}</td></tr>`).join('') + '</tbody>';
    $('#modCode').textContent = CL.moduleSketch(pl);
    const N = pl.N, kind = pl.kind;
    $('#modBuildHint').textContent = (N === 1 ? 'One module to test on the table: ' : `${N} modules in a row, ${MD.gait === 'together' ? 'all folding together' : 'folding in a wave'}: `) +
      (kind === 'servo' ? `${N} servo${N > 1 ? 's' : ''} on a ${pl.p.spool} mm spool, ${fN(pl.servoDeg, 0)}° of travel.` : `${fN(pl.wireLen, 0)} mm of ${kind === 'wire' ? pl.q.wireD : pl.q.springD} mm wire per fold, ${fN(pl.R, 1)} Ω, ${fN(pl.Ipk, 2)} A pulses from ${pl.V} V through a MOSFET.`);
  }
  $('#modZip').addEventListener('click', () => {
    if (!MD.plan) return;
    const name = `fold-module-${MD.plan.kind}${MD.plan.N > 1 ? '-crawler' : ''}.zip`;
    saveFile(name, new Blob([CL.makeZip(CL.moduleKitFiles(MD.plan))], { type: 'application/zip' }), $('#modDlStatus'));
  });
  $('#modTpl').addEventListener('click', () => { if (MD.plan) saveFile(`fold-module-${MD.plan.kind}-template.svg`, CL.moduleTemplate(MD.plan), $('#modDlStatus')); });
  $('#modCopy').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try { await navigator.clipboard.writeText($('#modCode').textContent); btn.textContent = 'Copied'; }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('#modCode')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = 'Selected, press Ctrl+C'; }
    setTimeout(() => (btn.textContent = 'Copy'), 1800);
  });
  function initModules() {
    if (MD.inited) return;
    MD.inited = true;
    renderModParams(); modLive(); modAnalyze();
  }

  // ---- mode switching ----
  function setMode(m) {
    if (m === mode) return;
    if (opt) stopOpt();
    if (M.learn) stopLearn();
    if (m !== 'transform') stopMission();
    mode = m;
    for (const el of document.querySelectorAll('[data-mode]')) el.hidden = !el.dataset.mode.split(' ').includes(m);
    for (const b of document.querySelectorAll('.mode')) b.setAttribute('aria-pressed', String(b.dataset.go === m));
    $('#tagline').textContent = m === 'fold'
      ? 'Design a crease pattern, fold it with a bar-and-hinge simulator, and let an optimizer search the geometry.'
      : m === 'move' ? 'Build gaits from folding alone: contract, bend, twist, anchor and release a Kresling crawler, then let CMA-ES tune the timing.'
      : m === 'modules' ? 'The basic electric fold, three ways: a servo winding a thread, a shape-memory wire, or a shape-memory spring. Test one, compare all three, then chain copies into a crawler.'
      : m === 'transform' ? 'One robot, four body shapes: stow compact, crawl, raise a camera on a hinged neck, and hold the head at an angle to reach. Then check whether changing shape beats a robot that can only crawl.'
      : 'Turn a simulated robot into a real one, in three stages: the crawler tethered to a laptop, then carrying its own battery, then the transformer with a neck. Templates, a weight check, servo angles, wiring and Arduino code for each.';
    $('#stage').classList.remove('three');
    for (const id of ['#tStrain', '#tCreases', '#tPause', '#tView']) $(id).hidden = m === 'build' && B.view !== '3d';
    $('#tCreases').hidden = false;
    if (m === 'modules') for (const id of ['#tStrain', '#tCreases', '#tPause', '#tView']) $(id).hidden = true;
    document.querySelector('.legend-inline').hidden = m !== 'fold';
    if (m === 'move') {
      if (!M.sim) { buildRobotSim(true); scoreGait(); }
      else { view.setSim(M.sim, true); view.pushTrail(M.sim.com()); }
      moveHud();
    } else if (m === 'transform') {
      if (!T.sim) buildTransformerSim(true); else { view.setSim(T.sim, true); view.pushTrail(T.sim.com()); }
      transformHud();
    } else if (m === 'build') {
      if (!M.sim) buildRobotSim(false);
      view.setSim(M.sim, true);
      refreshBuild();
    } else if (m === 'modules') { MD.last = 0; initModules(); }
    else { view.setSim(sim, true); hud(true); }
    try { if (location.hash.slice(1) !== m) history.replaceState(null, '', '#' + m); } catch (_) {}
  }
  for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => setMode(b.dataset.go));
  function initMove() {
    renderRobotParams(); renderFeet(); renderPrimitives(); renderGaitSelect(); renderGaitTension(); renderPhases(); renderLearnObjectives(); setDrive();
  }

  // ================= site chrome: theme toggle (same behaviour as the main site) =================
  $('#theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (e) {}
  });
  $('#yr').textContent = new Date().getFullYear();

  // ================= boot =================
  view.init();
  pat = CL.buildPattern(state.key, state.params);
  renderPatternButtons(); renderParams(); renderActuation(); renderMaterial();
  rebuild(true);
  renderObjectives(); clearOptChart();
  measure();
  initMove(); initTransform(); renderBuildParams();
  if (['#move', '#build', '#transform', '#modules'].includes(location.hash)) setMode(location.hash.slice(1));
  requestAnimationFrame(loop);
})();
