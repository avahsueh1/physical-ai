// ===== Crease Lab import: open an existing design =====
// Reads crease patterns made elsewhere (FOLD, ORIPA .cp, SVG drawings) and Crease Lab's own design files.
// A crease pattern drawn as loose lines becomes a simulatable sheet: lines are split where they cross,
// near-coincident points are merged, a border is added if there is none, and every face is triangulated.
// Works in the browser (window.CreaseLab) and in node (module.exports).
(function (root) {
  'use strict';
  const CL = typeof module !== 'undefined' && module.exports ? require('./core.js') : root.CreaseLab;
  const TARGET_SIZE = 4;  // imported sheets are rescaled to about this size if they are far off (the presets are 3–6 across)

  // ---------------------------------------------------------------
  // ORIPA / Origami Designer .cp: one line per crease, "type x1 y1 x2 y2"
  //   1 = border (cut), 2 = mountain, 3 = valley, anything else = flat / auxiliary
  // ---------------------------------------------------------------
  function parseCP(text) {
    const segs = [];
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.trim().split(/[\s,]+/).map(Number);
      if (t.length < 5 || t.some((v) => !isFinite(v))) continue;
      const asg = t[0] === 1 ? 'B' : t[0] === 2 ? 'M' : t[0] === 3 ? 'V' : 'F';
      segs.push({ a: [t[1], -t[2]], b: [t[3], -t[4]], asg });   // .cp has y pointing down
    }
    if (!segs.length) throw new Error('No crease lines found. A .cp file has one line per crease: type x1 y1 x2 y2.');
    return segs;
  }

  // ---------------------------------------------------------------
  // SVG: lines, polylines, polygons, rects and paths (M L H V Z, absolute or relative; curves become chords).
  // Colour decides the crease type, following Origami Simulator's convention:
  //   red = mountain, blue = valley, black/dark = border, green = cut (border), yellow/magenta/grey = flat
  // ---------------------------------------------------------------
  function colorToAsg(c, dashed) {
    if (!c || c === 'none') return null;
    c = c.trim().toLowerCase();
    const named = { red: '#ff0000', blue: '#0000ff', black: '#000000', green: '#00ff00', lime: '#00ff00', yellow: '#ffff00', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', cyan: '#00ffff', navy: '#000080', maroon: '#800000' };
    if (named[c]) c = named[c];
    let r, g, b;
    let m = c.match(/^#([0-9a-f]{3})$/);
    if (m) [r, g, b] = m[1].split('').map((h) => parseInt(h + h, 16));
    else if ((m = c.match(/^#([0-9a-f]{6})/))) [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    else if ((m = c.match(/^rgba?\(([^)]+)\)/))) [r, g, b] = m[1].split(',').slice(0, 3).map((v) => (v.includes('%') ? 2.55 * parseFloat(v) : parseFloat(v)));
    else return dashed ? 'F' : 'B';
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (mx < 70) return 'B';                     // black or nearly
    if (d < 40) return 'F';                      // grey: facet or auxiliary line
    let h;
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    if (h < 25 || h >= 335) return 'M';          // red
    if (h >= 190 && h < 265) return 'V';         // blue
    if (h >= 90 && h < 165) return 'B';          // green: cut line
    return 'F';                                  // yellow, magenta, cyan, orange: flat
  }
  const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
  function parseTransform(s) {
    let M = [1, 0, 0, 1, 0, 0];
    if (!s) return M;
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g; let m;
    while ((m = re.exec(s))) {
      const v = m[2].split(/[\s,]+/).filter(Boolean).map(Number); let T;
      if (m[1] === 'matrix') T = v.slice(0, 6);
      else if (m[1] === 'translate') T = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
      else if (m[1] === 'scale') T = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0];
      else if (m[1] === 'rotate') {
        const a = ((v[0] || 0) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
        T = [c, sn, -sn, c, 0, 0];
        if (v.length >= 3) T = mul(mul([1, 0, 0, 1, v[1], v[2]], T), [1, 0, 0, 1, -v[1], -v[2]]);
      } else if (m[1] === 'skewX') T = [1, 0, Math.tan((v[0] * Math.PI) / 180), 1, 0, 0];
      else T = [1, Math.tan((v[0] * Math.PI) / 180), 0, 1, 0, 0];
      M = mul(M, T);
    }
    return M;
  }
  function attrs(tag) {
    const o = {}, re = /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let m;
    while ((m = re.exec(tag))) o[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4];
    if (o.style) for (const part of o.style.split(';')) { const [k, v] = part.split(':').map((x) => x && x.trim()); if (k && v) o[k.toLowerCase()] = v; }
    return o;
  }
  function pathPoints(d) {
    // returns polylines; curves are replaced by straight chords between their end points
    const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
    const lines = []; let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0;
    const num = () => parseFloat(toks[i++]);
    const isNum = () => i < toks.length && !/^[a-zA-Z]$/.test(toks[i]);
    const pt = (nx, ny) => { x = nx; y = ny; cur.push([x, y]); };
    while (i < toks.length) {
      if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++];
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      if (C === 'M') { const nx = num(), ny = num(); cur = []; lines.push(cur); pt(rel ? x + nx : nx, rel ? y + ny : ny); sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
      else if (C === 'L') pt(rel ? x + num() : num(), rel ? y + num() : num());
      else if (C === 'H') pt(rel ? x + num() : num(), y);
      else if (C === 'V') pt(x, rel ? y + num() : num());
      else if (C === 'Z') { if (cur) pt(sx, sy); if (!isNum()) continue; }
      else if (C === 'C') { num(); num(); num(); num(); pt(rel ? x + num() : num(), rel ? y + num() : num()); }
      else if (C === 'S' || C === 'Q') { num(); num(); pt(rel ? x + num() : num(), rel ? y + num() : num()); }
      else if (C === 'T') pt(rel ? x + num() : num(), rel ? y + num() : num());
      else if (C === 'A') { num(); num(); num(); num(); num(); pt(rel ? x + num() : num(), rel ? y + num() : num()); }
      else { i++; continue; }
      if (!cur) { cur = [[x, y]]; lines.push(cur); }
    }
    return lines;
  }
  function parseSVG(text) {
    if (!/<svg[\s>]/i.test(text)) throw new Error('This does not look like an SVG file.');
    const segs = [], stack = [{ M: [1, 0, 0, 1, 0, 0], stroke: null, dash: false }];
    const tagRe = /<\/?([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g; let m;
    while ((m = tagRe.exec(text))) {
      const name = m[1].toLowerCase(), closing = m[0][1] === '/', self = m[3] === '/' || /\/\s*$/.test(m[2]);
      if (closing) { if (name === 'g' || name === 'svg') stack.pop(); continue; }
      const a = attrs(m[2]), top = stack[stack.length - 1];
      const M = mul(top.M, parseTransform(a.transform));
      const stroke = a.stroke !== undefined ? a.stroke : top.stroke;
      const dash = a['stroke-dasharray'] !== undefined ? a['stroke-dasharray'] !== 'none' : top.dash;
      if (name === 'g' || name === 'svg') { if (!self) stack.push({ M, stroke, dash }); continue; }
      const asg = colorToAsg(stroke, dash);
      if (!asg) continue;
      const T = (p) => [M[0] * p[0] + M[2] * p[1] + M[4], -(M[1] * p[0] + M[3] * p[1] + M[5])];   // flip y: SVG y points down
      const poly = (pts, close) => { for (let k = 0; k + 1 < pts.length; k++) segs.push({ a: T(pts[k]), b: T(pts[k + 1]), asg }); if (close && pts.length > 2) segs.push({ a: T(pts[pts.length - 1]), b: T(pts[0]), asg }); };
      const nums = (s) => (s || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
      const f = (k) => parseFloat(a[k] || 0);
      if (name === 'line') poly([[f('x1'), f('y1')], [f('x2'), f('y2')]]);
      else if (name === 'polyline' || name === 'polygon') { const v = nums(a.points), pts = []; for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]); poly(pts, name === 'polygon'); }
      else if (name === 'rect') { const x = f('x'), y = f('y'), w = f('width'), h = f('height'); poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true); }
      else if (name === 'path' && a.d) for (const pl of pathPoints(a.d)) poly(pl, false);
    }
    if (!segs.length) throw new Error('No stroked lines found in the SVG. Crease lines need a stroke colour (red = mountain, blue = valley, black = border).');
    return segs;
  }

  // ---------------------------------------------------------------
  // Loose segments -> a planar crease pattern with triangulated faces
  // ---------------------------------------------------------------
  function segmentsToPattern(segs, opts) {
    opts = Object.assign({ title: 'Imported', normalize: true }, opts || {});
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of segs) for (const p of [s.a, s.b]) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const ext = Math.max(x1 - x0, y1 - y0);
    if (!(ext > 0)) throw new Error('The crease lines have no size.');
    // rescale to a sensible size and centre
    const k = opts.normalize && (ext > 20 || ext < 1) ? TARGET_SIZE / ext : 1;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let S = segs.map((s) => ({ a: [(s.a[0] - cx) * k, (s.a[1] - cy) * k], b: [(s.b[0] - cx) * k, (s.b[1] - cy) * k], asg: s.asg }));
    const eps = Math.max(1e-9, ext * k * 1e-6), snap = ext * k * 2e-4;
    S = S.filter((s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > snap);
    // no border drawn? use the bounding box
    let addedBorder = false;
    if (!S.some((s) => s.asg === 'B')) {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const s of S) for (const p of [s.a, s.b]) { bx0 = Math.min(bx0, p[0]); by0 = Math.min(by0, p[1]); bx1 = Math.max(bx1, p[0]); by1 = Math.max(by1, p[1]); }
      const c = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]];
      for (let i = 0; i < 4; i++) S.push({ a: c[i], b: c[(i + 1) % 4], asg: 'B' });
      addedBorder = true;
    }
    // split every segment where it meets another (crossings, T-junctions, overlaps)
    const cuts = S.map(() => [0, 1]);
    for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
      const p = S[i].a, r = [S[i].b[0] - p[0], S[i].b[1] - p[1]], q = S[j].a, s = [S[j].b[0] - q[0], S[j].b[1] - q[1]];
      const rxs = r[0] * s[1] - r[1] * s[0], qp = [q[0] - p[0], q[1] - p[1]];
      const lr = Math.hypot(...r), ls = Math.hypot(...s);
      if (Math.abs(rxs) < 1e-12 * lr * ls) {
        // parallel: if collinear, each segment is cut at the other's end points
        if (Math.abs(qp[0] * r[1] - qp[1] * r[0]) / lr > snap) continue;
        const proj = (u, base, dir, L2) => ((u[0] - base[0]) * dir[0] + (u[1] - base[1]) * dir[1]) / L2;
        for (const e of [S[j].a, S[j].b]) { const t = proj(e, p, r, lr * lr); if (t > 0 && t < 1) cuts[i].push(t); }
        for (const e of [S[i].a, S[i].b]) { const t = proj(e, q, s, ls * ls); if (t > 0 && t < 1) cuts[j].push(t); }
        continue;
      }
      const t = (qp[0] * s[1] - qp[1] * s[0]) / rxs, u = (qp[0] * r[1] - qp[1] * r[0]) / rxs;
      const tt = snap / lr, tu = snap / ls;
      if (t < -tt || t > 1 + tt || u < -tu || u > 1 + tu) continue;
      if (t > tt && t < 1 - tt) cuts[i].push(t);
      if (u > tu && u < 1 - tu) cuts[j].push(u);
    }
    // vertices, merged within `snap`
    const verts = [], grid = new Map(), cell = snap * 4;
    const vid = (p) => {
      const gx = Math.round(p[0] / cell), gy = Math.round(p[1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of grid.get((gx + dx) + ',' + (gy + dy)) || []) if (Math.hypot(verts[i][0] - p[0], verts[i][1] - p[1]) <= snap) return i;
      const i = verts.length; verts.push([p[0], p[1]]); const key = gx + ',' + gy; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(i); return i;
    };
    // edges, de-duplicated; where lines overlap, a fold beats a flat line beats a border
    const rank = { M: 3, V: 3, F: 2, B: 1 }, edges = new Map();
    S.forEach((s, i) => {
      const ts = [...new Set(cuts[i].map((t) => +t.toFixed(9)))].sort((a, b) => a - b);
      for (let k2 = 0; k2 + 1 < ts.length; k2++) {
        const at = (t) => [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
        const u = vid(at(ts[k2])), v = vid(at(ts[k2 + 1]));
        if (u === v) continue;
        const key = u < v ? u + ',' + v : v + ',' + u, old = edges.get(key);
        if (!old || rank[s.asg] > rank[old]) edges.set(key, s.asg);
      }
    });
    const E = [...edges].map(([key, asg]) => { const [a, b] = key.split(',').map(Number); return [a, b, asg]; });
    // drop dangling edges (an end point used by only one edge) repeatedly: they cannot bound a face
    let changed = true, E2 = E;
    while (changed) {
      const deg = new Map(); for (const [a, b] of E2) { deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); }
      const keep = E2.filter(([a, b]) => deg.get(a) > 1 && deg.get(b) > 1); changed = keep.length !== E2.length; E2 = keep;
    }
    const dropped = E.length - E2.length;
    // faces of the planar graph, then ear-clip each into triangles (handles concave faces)
    const faces = planarFaces(verts, E2);
    if (!faces.length) throw new Error('The lines do not enclose any faces. Make sure the border is closed.');
    const tris = [];
    for (const f of faces) for (const t of earClip(f, verts)) tris.push(t);
    // compact the vertex list
    const used = new Map(), V = [];
    for (const t of tris) for (const v of t) if (!used.has(v)) { used.set(v, V.length); V.push(verts[v]); }
    const fold = {
      file_title: opts.title,
      vertices_coords: V,
      edges_vertices: E2.filter(([a, b]) => used.has(a) && used.has(b)).map(([a, b]) => [used.get(a), used.get(b)]),
      edges_assignment: E2.filter(([a, b]) => used.has(a) && used.has(b)).map((e) => e[2]),
      faces_vertices: tris.map((t) => t.map((v) => used.get(v))),
    };
    const pat = CL.fromFOLD(fold);
    const creases = fold.edges_assignment.filter((a) => a === 'M' || a === 'V').length;
    return { pat, fold, info: { lines: segs.length, vertices: V.length, faces: faces.length, triangles: tris.length, creases, scaled: k, addedBorder, dropped } };
  }
  function planarFaces(verts, edges) {
    const adj = verts.map(() => []);
    for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
    const ang = (a, b) => Math.atan2(verts[b][1] - verts[a][1], verts[b][0] - verts[a][0]);
    adj.forEach((l, a) => l.sort((p, q) => ang(a, p) - ang(a, q)));
    const used = new Set(), faces = [];
    for (let a = 0; a < verts.length; a++) for (const b of adj[a]) {
      if (used.has(a + '>' + b)) continue;
      const face = []; let u = a, v = b, guard = 0;
      while (!used.has(u + '>' + v) && guard++ < 10000) {
        used.add(u + '>' + v); face.push(u);
        const l = adj[v], i = l.indexOf(u);
        const w = l[(i - 1 + l.length) % l.length];
        u = v; v = w;
      }
      if (face.length >= 3 && signedArea(face, verts) > 1e-12) faces.push(face);
    }
    return faces;
  }
  function signedArea(f, verts) { let s = 0; for (let i = 0; i < f.length; i++) { const p = verts[f[i]], q = verts[f[(i + 1) % f.length]]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; }
  function earClip(face, verts) {
    // face is counter-clockwise; drop collinear points first
    let f = face.slice();
    if (f.length === 4) {   // a quad: split along the shorter diagonal, as the built-in patterns do
      const d = (i, j) => Math.hypot(verts[f[i]][0] - verts[f[j]][0], verts[f[i]][1] - verts[f[j]][1]);
      const conv = [0, 1, 2, 3].every((i) => (verts[f[(i + 1) % 4]][0] - verts[f[i]][0]) * (verts[f[(i + 2) % 4]][1] - verts[f[i]][1]) - (verts[f[(i + 1) % 4]][1] - verts[f[i]][1]) * (verts[f[(i + 2) % 4]][0] - verts[f[i]][0]) > 0);
      if (conv) return d(0, 2) <= d(1, 3) ? [[f[0], f[1], f[2]], [f[0], f[2], f[3]]] : [[f[0], f[1], f[3]], [f[1], f[2], f[3]]];
    }
    const cross = (a, b, c) => (verts[b][0] - verts[a][0]) * (verts[c][1] - verts[a][1]) - (verts[b][1] - verts[a][1]) * (verts[c][0] - verts[a][0]);
    const inTri = (p, a, b, c) => { const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p); return d1 > 1e-14 && d2 > 1e-14 && d3 > 1e-14; };
    const out = []; let guard = 0;
    while (f.length > 3 && guard++ < 5000) {
      let clipped = false;
      for (let i = 0; i < f.length; i++) {
        const a = f[(i - 1 + f.length) % f.length], b = f[i], c = f[(i + 1) % f.length];
        if (cross(a, b, c) <= 1e-14) continue;            // reflex or straight: not an ear
        if (f.some((p) => p !== a && p !== b && p !== c && inTri(p, a, b, c))) continue;
        out.push([a, b, c]); f.splice(i, 1); clipped = true; break;
      }
      if (!clipped) break;
    }
    if (f.length === 3) out.push(f);
    else if (f.length > 3) for (let i = 1; i + 1 < f.length; i++) out.push([f[0], f[i], f[i + 1]]);   // fallback: fan
    return out;
  }

  // ---------------------------------------------------------------
  // FOLD files: keep their faces if they have them; rescale if far from the presets' size
  // ---------------------------------------------------------------
  function foldToPattern(data, opts) {
    const d = typeof data === 'string' ? JSON.parse(data) : data;
    if (!d.vertices_coords || !d.edges_vertices) throw new Error('A FOLD file needs vertices_coords and edges_vertices.');
    if (!d.faces_vertices) {
      // build faces the same robust way as for drawings
      const segs = d.edges_vertices.map((e, i) => ({ a: d.vertices_coords[e[0]].slice(0, 2), b: d.vertices_coords[e[1]].slice(0, 2), asg: ((d.edges_assignment || [])[i] || 'U').toUpperCase().replace(/[UJC]/, 'F') }));
      return segmentsToPattern(segs, { title: d.file_title || (opts && opts.title) });
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of d.vertices_coords) { x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]); x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1]); }
    const ext = Math.max(x1 - x0, y1 - y0), k = ext > 20 || ext < 1 ? TARGET_SIZE / ext : 1;
    const dd = Object.assign({}, d, { vertices_coords: d.vertices_coords.map((v) => [(v[0] - (x0 + x1) / 2) * k, (v[1] - (y0 + y1) / 2) * k]) });
    const pat = CL.fromFOLD(dd);
    return { pat, fold: dd, info: { vertices: dd.vertices_coords.length, faces: d.faces_vertices.length, triangles: pat.cp.faces.length, creases: pat.cp.edges.filter((e) => e[2] === 'M' || e[2] === 'V').length, scaled: k } };
  }

  // one entry point: guess the format from the name and the content
  function importDesign(text, name) {
    const n = (name || '').toLowerCase(), t = text.trimStart();
    if (t.startsWith('{')) {
      const d = JSON.parse(text);
      if (d.creaseLab) return { kind: 'project', project: d };
      return Object.assign({ kind: 'pattern', format: 'FOLD' }, foldToPattern(d, { title: name }));
    }
    if (n.endsWith('.svg') || /^<(\?xml|svg|!doctype)/i.test(t)) return Object.assign({ kind: 'pattern', format: 'SVG' }, segmentsToPattern(parseSVG(text), { title: name }));
    if (n.endsWith('.cp') || /^\s*[0-9]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+/.test(t)) return Object.assign({ kind: 'pattern', format: 'ORIPA .cp' }, segmentsToPattern(parseCP(text), { title: name }));
    throw new Error('Unrecognised file. Crease Lab opens .fold, .cp and .svg crease patterns, and its own design files (.json).');
  }

  const API = { parseCP, parseSVG, colorToAsg, segmentsToPattern, foldToPattern, importDesign };
  Object.assign(CL, API);
  if (typeof module !== 'undefined' && module.exports) module.exports = CL;
})(typeof window !== 'undefined' ? window : globalThis);
