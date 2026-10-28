// ===== Crease Lab transform build: the Stage 3 kit for the four-shape robot =====
// The real transformer is the Stage 2 crawler (4 Kresling cells, servos on a tail tray) plus a sled under
// the last plate (the shoulder), a servo that is itself the neck hinge, and a rigid card head with a camera.
// Loads after transform.js and build.js. Works in the browser and in node.
(function (root) {
  'use strict';
  let CL;
  if (typeof module !== 'undefined' && module.exports) { CL = require('./transform.js'); require('./build.js'); }
  else CL = root.CreaseLab;
  const PI = Math.PI, DEG = PI / 180;
  const f1 = (v) => (Math.round(v * 10) / 10).toString();
  const f0 = (v) => String(Math.round(v));
  const STYLE = {
    cut: 'stroke="#111" stroke-width="0.35" fill="none"',
    fold: 'stroke="#d1453b" stroke-width="0.3" stroke-dasharray="4 1.2 0.8 1.2" fill="none"',
    glue: 'fill="#e7e2d3" stroke="#111" stroke-width="0.35"',
    hint: 'fill="none" stroke="#999" stroke-width="0.3" stroke-dasharray="1 1"',
    dim: 'stroke="#2a63c9" stroke-width="0.25" fill="none"',
    label: 'font-family="Helvetica, Arial, sans-serif" fill="#333"',
  };

  // camera module (optional): an ESP32-CAM board, 27 × 40 mm, about 10 g with its lens
  const CAMERA = { name: 'ESP32-CAM board with OV2640 camera', g: 10, w: 27, l: 40, lens: 9 };
  // the Pico is the default: the stack of battery and board has to fit under the neck servo, and an
  // ESP32 DevKit with its header pins is too tall. The camera board has its own Wi-Fi.
  const T_DEFAULTS = { R_mm: 30, board: 'pico', servo: 'mg90s', camera: true, spool_mm: 'auto' };
  // the real sled reaches 25 mm back under the last cell (any more and it hits the tail tray in Compact)
  // and 55 mm forward, where the battery and board sit under the neck servo
  const SLED = { rear: 25, front: 55 };
  function kitTp(tp, R_mm) { return Object.assign({}, tp, { sledRear: SLED.rear / R_mm, sledFront: SLED.front / R_mm }); }

  function bodyParams(tp) {
    // the transformer's body as a crawler: 4 Kresling cells with the same twist and handedness
    return Object.assign(CL.defaultRobot(), { cells: tp.cells, phi: tp.phi, n: tp.n, H: tp.H, chirality: tp.chirality });
  }

  // ---------------------------------------------------------------
  // Weights: where every real part sits, in grams
  // ---------------------------------------------------------------
  function transformerMass(tp, opts) {
    const o = Object.assign({}, T_DEFAULTS, opts || {});
    const P = CL.PARTS, sv = P.servo[o.servo] || P.servo.mg90s, R = o.R_mm;
    const body = CL.massEstimate(bodyParams(tp), { R_mm: R, power: 'tether', servo: o.servo });
    const flats = 2 * R * Math.cos(PI / tp.n), side = 2 * R * Math.sin(PI / tp.n);
    const card = (area_mm2) => (area_mm2 / 100) * P.plate_g_cm2 * 0.6;
    const items = [];
    const add = (where, name, g) => { items.push({ where, name, g }); return g; };
    for (const it of body.items) if (it.where === 'body' || it.where === 'tail') add(it.where, it.name, it.g);
    const capArea = 0.5 * tp.n * R * R * Math.sin((2 * PI) / tp.n);
    add('sled', 'sled tray and skin', ((SLED.rear + SLED.front) * flats / 100) * (P.plate_g_cm2 * 0.6 + P.skin_g_cm2));
    add('sled', P.lipo3.name, P.lipo3.g); add('sled', P.board[o.board].name, P.board[o.board].g);
    add('sled', P.boost3.name, P.boost3.g); add('sled', P.small.name + ', start button', P.small.g + 1);
    add('neck', 'neck servo ' + sv.name.replace('Micro servo ', ''), sv.g); add('neck', 'neck spacer, bracket, horn and foam pad', 4);
    add('head', 'head box (card)', card(tp.n * side * tp.H * R) + 2 * card(capArea) * 1.6);
    add('head', 'head skin pad', ((tp.H * R * flats) / 100) * P.skin_g_cm2);
    if (o.camera) add('head', CAMERA.name, CAMERA.g);
    const sum = (w) => items.filter((it) => it.where === w).reduce((a, it) => a + it.g, 0);
    const out = { items, body: sum('body'), tail: sum('tail'), sled: sum('sled'), neck: sum('neck'), head: sum('head') };
    out.total = out.body + out.tail + out.sled + out.neck + out.head;
    return out;
  }

  // the transformer sim with a rigid head, no grips (scales only) and every real part's weight in place
  function loadedTransformer(tp0, mass, R_mm) {
    const tp = kitTp(tp0, R_mm || 30);
    const probe = CL.buildTransformer(Object.assign({}, tp, { head: 'rigid' }));
    const pat = probe.mesh.pat, helpers = new Set(pat.hubs.flat().concat(pat.joints.flatMap((J) => J.pins)));
    // paper body (cells and plates, without the head cell) in the sim vs grams
    let massed = 0; for (let i = 0; i < probe.N; i++) if (!helpers.has(i)) massed++;
    const bodyCells = tp.cells + 1; // the sim's head cell is paper too; count it with the body
    const perGram = (massed * probe.g) / (mass.body * bodyCells / tp.cells);
    const sim = CL.buildTransformer(Object.assign({}, tp, { head: 'rigid', battery: mass.sled * perGram }));
    const p2 = sim.mesh.pat, add = (nodes, g) => { for (const i of nodes) sim.extraG.push([i, (g * perGram) / nodes.length]); };
    add(p2.rear, mass.tail); add(p2.joints[0].pins, mass.neck); add(p2.rings[p2.rings.length - 1], mass.head);
    // real feet are directional scales everywhere: no switchable grips
    const setG = sim.setGrips.bind(sim);
    sim.setGrips = () => setG({ rear: false, mid: false, front: false });
    sim.setGrips(); sim.perGram = perGram;
    return sim;
  }

  // run each shape with the real weights; also the bare sim for comparison
  function transformerCheck(tp, opts) {
    const o = Object.assign({}, T_DEFAULTS, opts || {});
    const mass = o.mass || transformerMass(tp, o);
    const out = { mass };
    const shape = (mk, key, T, neck) => { const s = mk(); s.controller.set(key, { neck }); CL.runFor(s, T); return { s, m: CL.measureShape(s) }; };
    const loaded = () => loadedTransformer(tp, mass, o.R_mm);
    const bare = () => CL.buildTransformer(kitTp(tp, o.R_mm));
    const tilt = (s) => Math.asin(Math.max(-1, Math.min(1, s.plateAxis(s.mesh.pat.shoulder)[2]))) / DEG;
    const tw = shape(loaded, 'tower', 8);
    out.tower = { neck: tw.m.neck, camera: tw.m.camera, tilt: tilt(tw.s), strain: tw.m.strain };
    const rc = shape(loaded, 'reach', 10, 45);
    out.reach = { neck: rc.m.neck, tipZ: rc.m.tip[2] };
    const cp = shape(loaded, 'compact', 8);
    out.compact = { length: cp.m.length / cp.s.restLength };
    const crawl = (mk) => { const s = mk(); s.controller.set('crawl'); CL.runFor(s, 6); const x0 = s.com()[0]; CL.runFor(s, 24); return (s.com()[0] - x0) / 4; };
    out.crawl = crawl(loaded); out.crawlBare = crawl(bare);
    const ref = loaded(); out.cameraFlat = ref.cameraHeight(); out.perGram = ref.perGram;
    // what a paper (Kresling) head would do under the same camera: why the kit uses a rigid one
    const soft = CL.buildTransformer(Object.assign(kitTp(tp, o.R_mm), { battery: mass.sled * ref.perGram }));
    const ps = soft.mesh.pat, addS = (nodes, g) => { for (const i of nodes) soft.extraG.push([i, (g * ref.perGram) / nodes.length]); };
    addS(ps.rear, mass.tail); addS(ps.joints[0].pins, mass.neck); addS(ps.rings[ps.rings.length - 1], mass.head);
    soft.controller.set('tower'); CL.runFor(soft, 8); out.paperHeadCamera = soft.cameraHeight();
    return out;
  }

  // ---------------------------------------------------------------
  // Servo plan: cable stroke for Compact and for the crawl stroke, and neck angles, from the sim
  // ---------------------------------------------------------------
  function transformerPlan(tp, opts) {
    const o = Object.assign({}, T_DEFAULTS, opts || {});
    const mass = o.mass || transformerMass(tp, o);
    const stroke = (mode, T) => {
      const s = loadedTransformer(tp, mass, o.R_mm); s.controller.set(mode); CL.runFor(s, T);
      const sh = s.mesh.pat.cables.map((c, i) => Math.max(0, s.cableRest[i] - s.pathLength(c)) * o.R_mm);
      return { left: (sh[0] + sh[3]) / 2, right: (sh[1] + sh[2]) / 2 };
    };
    const compact = stroke('compact', 8);
    // crawl stroke: the most each pair shortens during the contract phase of the gait
    const s = loadedTransformer(tp, mass, o.R_mm); s.controller.set('crawl');
    let cl = 0, cr = 0; const t0 = s.time;
    CL.runFor(s, 12, (q) => { const sh = q.mesh.pat.cables.map((c, i) => Math.max(0, q.cableRest[i] - q.pathLength(c)) * o.R_mm); cl = Math.max(cl, (sh[0] + sh[3]) / 2); cr = Math.max(cr, (sh[1] + sh[2]) / 2); });
    const maxMm = Math.max(compact.left, compact.right, cl, cr);
    const spool = o.spool_mm === 'auto' ? Math.min(30, Math.max(4, Math.ceil((maxMm / (153 * DEG)) * 2) / 2)) : o.spool_mm;
    const deg = (mm) => mm / spool / DEG;
    const gait = CL.MODES.crawl.gait.phases;
    return {
      spool_mm: spool, maxMm, maxDeg: deg(maxMm), fits: deg(maxMm) <= 153,
      compact: { leftMm: compact.left, rightMm: compact.right, leftDeg: deg(compact.left), rightDeg: deg(compact.right) },
      crawl: { leftMm: cl, rightMm: cr, leftDeg: deg(cl), rightDeg: deg(cr), phases: gait.map((p) => ({ dur: p.dur, contract: p.contract })) },
      neck: { tower: CL.MODES.tower.neck, reach: 45 },   // Reach starts where the mission uses it
      // the real robot powers up straight, so the mission starts by folding up (the sim starts folded)
      mission: [{ name: 'Stow', mode: 'compact', T: 6, neck: 0, still: false }].concat(CL.MISSION.map((st) => ({ name: st.name, mode: st.mode, T: st.T, neck: st.neck, still: !!st.still }))),
      R_mm: o.R_mm,
    };
  }

  // ---------------------------------------------------------------
  // Templates: page 1 body strip, page 2 plates, page 3 neck, head and trays
  // ---------------------------------------------------------------
  function transformerTemplates(tp, opts) {
    const o = Object.assign({}, T_DEFAULTS, opts || {});
    const R = o.R_mm, n = tp.n, bp = bodyParams(tp);
    const ct = CL.crawlerTemplate(bp, { R_mm: R, power: 'tether', servo: o.servo });
    const svg = ct.svg.replace(/Kresling crawler body · (\d+) cells/, 'Transformer body · $1 cells').replace('page 1 of 3', 'page 1 of 4 · P' + tp.cells + ' is the shoulder');
    const partsSvg = ct.partsSvg.replace('P' + tp.cells + ' head · dot = corner 0', 'P' + tp.cells + ' shoulder · dot = corner 0').replace('Trays are on page 3.', 'Neck, head and trays are on page 3.');
    // page 3
    const flats = 2 * R * Math.cos(PI / n), side = 2 * R * Math.sin(PI / n), Lh = tp.H * R;
    const sv = CL.PARTS.servo[o.servo] || CL.PARTS.servo.mg90s;
    const tr = CL.trayDims(bp, { R_mm: R, servo: o.servo, spool_mm: o.spool });
    const pivot = 0.95 * R;                     // pivot to each plate, as in the simulator (knuckle 1.9 R)
    const shaftFromFront = 6;                   // micro servo shaft sits about 6 mm from the front of the case
    const m = 12; let x = m, y = 26, rowH = 0, g = '';
    const place = (w, h) => { if (x + w > 285 - m) { x = m; y += rowH + 22; rowH = 0; } const at = [x, y]; x += w + 12; rowH = Math.max(rowH, h); return at; };
    const t = (x0, y0, s, size, anchor) => `<text x="${f1(x0)}" y="${f1(y0)}" font-size="${size || 2.6}" text-anchor="${anchor || 'middle'}" ${STYLE.label}>${s}</text>`;
    const rect = (x0, y0, w, h, st) => `<rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(w)}" height="${f1(h)}" ${st || STYLE.cut}/>`;
    const dimH = (x0, x1, yy, s) => `<line x1="${f1(x0)}" y1="${f1(yy)}" x2="${f1(x1)}" y2="${f1(yy)}" ${STYLE.dim}/><line x1="${f1(x0)}" y1="${f1(yy - 1.5)}" x2="${f1(x0)}" y2="${f1(yy + 1.5)}" ${STYLE.dim}/><line x1="${f1(x1)}" y1="${f1(yy - 1.5)}" x2="${f1(x1)}" y2="${f1(yy + 1.5)}" ${STYLE.dim}/>` + `<text x="${f1((x0 + x1) / 2)}" y="${f1(yy - 1.2)}" font-size="2.4" text-anchor="middle" fill="#2a63c9" font-family="Helvetica, Arial, sans-serif">${s}</text>`;
    // tail tray (same as the crawler's)
    { const w = tr.tail.len, h = flats, [x0, y0] = place(w, h + 14);
      g += rect(x0, y0, w, h) + t(x0 + w / 2, y0 - 2, 'tail tray · tail foot pad', 3);
      for (const b of tr.tail.boxes) g += rect(x0 + b.x, y0 + b.y, b.w, b.h, STYLE.hint) + t(x0 + b.x + b.w / 2, y0 + b.y + b.h / 2 + 1, b.label);
      g += `<line x1="${f1(x0 + tr.tail.plateAt)}" y1="${f1(y0)}" x2="${f1(x0 + tr.tail.plateAt)}" y2="${f1(y0 + h)}" stroke="#111" stroke-width="0.3" stroke-dasharray="3 1.5"/>`;
      g += t(x0 + w / 2, y0 + h + 4, 'dashed line: glue under P0') + t(x0 + w / 2, y0 + h + 7.4, 'servos on ' + f0(tr.riser) + ' mm risers,') + t(x0 + w / 2, y0 + h + 10.8, 'shafts pointing out to the sides'); }
    // sled under the shoulder plate: 25 mm back under the last cell, 55 mm forward under the neck.
    // Drawn from above with the head to the right; the battery stack sits on the front half.
    { const w = SLED.rear + SLED.front, h = flats, [x0, y0] = place(w, h + 18);
      const P = CL.PARTS, bd = P.board[o.board], bt = P.lipo3, bs = P.boost3;
      g += rect(x0, y0, w, h) + t(x0 + w / 2, y0 - 2, 'sled · shoulder foot pad · head to the right →', 3);
      const xp = x0 + SLED.rear;
      g += `<line x1="${f1(xp)}" y1="${f1(y0)}" x2="${f1(xp)}" y2="${f1(y0 + h)}" stroke="#111" stroke-width="0.3" stroke-dasharray="3 1.5"/>`;
      const stackL = Math.max(bt.l, bd.l), stackW = Math.max(bt.w, bd.w), bx = xp + 2, by = y0 + (h - stackW - bs.w - 3) / 2;
      g += rect(bx, by, stackL, stackW, STYLE.hint) + t(bx + stackL / 2, by + stackW / 2 - 0.5, `LiPo, ${bd.name} on top,`) + t(bx + stackL / 2, by + stackW / 2 + 3, 'neck servo above on a foam pad');
      g += rect(bx, by + stackW + 3, bs.l, bs.w, STYLE.hint) + t(bx + bs.l / 2, by + stackW + 3 + bs.w / 2 + 1, 'boost');
      g += t(x0 + w / 2, y0 + h + 4, 'dashed line: glue under the shoulder plate P' + tp.cells) + t(x0 + w / 2, y0 + h + 7.4, `${SLED.rear} mm back under the last cell, ${SLED.front} mm forward under the neck`);
      g += dimH(x0, xp, y0 + h + 13, SLED.rear + ' mm') + dimH(xp, x0 + w, y0 + h + 13, SLED.front + ' mm'); }
    // neck: shoulder spacer and head bracket, with the pivot distances the simulator assumed
    { const w = 2 * pivot + 24, h = 44, [x0, y0] = place(w, h + 20);
      g += t(x0 + w / 2, y0 - 2, 'neck · side view, head to the right · not to cut, a guide', 3);
      const zc = y0 + 24, px0 = x0 + 12, pv = px0 + pivot, px1 = pv + pivot;
      g += `<line x1="${f1(px0)}" y1="${f1(y0 + 2)}" x2="${f1(px0)}" y2="${f1(y0 + h - 2)}" stroke="#111" stroke-width="0.6"/>` + t(px0, y0 + h + 2, 'P' + tp.cells);
      g += `<line x1="${f1(px1)}" y1="${f1(y0 + 2)}" x2="${f1(px1)}" y2="${f1(y0 + h - 2)}" stroke="#111" stroke-width="0.6"/>` + t(px1, y0 + h + 2, 'head box back');
      // servo case lying on its side, shaft at the pivot
      const sx1 = pv + shaftFromFront, sx0 = sx1 - sv.len + 9.5;
      g += rect(sx0, zc - sv.thick / 2, sx1 - sx0, sv.thick, 'fill="#eee" stroke="#555" stroke-width="0.3"') + t((sx0 + sx1) / 2, zc - sv.thick / 2 - 2, 'neck servo');
      g += rect(px0, zc - 6, sx0 - px0, 12, STYLE.glue) + t((px0 + sx0) / 2, zc + 9.5, 'spacer');
      g += rect(sx0 + 2, zc + sv.thick / 2, sx1 - sx0 - 4, 4, 'fill="#f4e9c8" stroke="#999" stroke-width="0.3"') + t((sx0 + sx1) / 2, zc + sv.thick / 2 + 8, 'foam pad on the battery stack');
      g += rect(pv, zc - 2.5, px1 - pv, 5, STYLE.glue) + t((pv + px1) / 2, zc + 7, 'head bracket');
      g += `<circle cx="${f1(pv)}" cy="${f1(zc)}" r="1.6" fill="#d1453b"/>` + t(pv, y0 + 4, 'shaft = hinge axis') + `<line x1="${f1(pv)}" y1="${f1(y0 + 5)}" x2="${f1(pv)}" y2="${f1(zc - sv.thick / 2 - 5)}" stroke="#d1453b" stroke-width="0.25"/>`;
      g += dimH(px0, pv, y0 + h + 7, f1(pivot) + ' mm') + dimH(pv, px1, y0 + h + 7, f1(pivot) + ' mm');
      g += t(x0 + w / 2, y0 + h + 12, `shaft at the plate's centre height,`) + t(x0 + w / 2, y0 + h + 15.4, `${f1(tr.centre)} mm off the floor`); }
    const H3 = Math.ceil(y + rowH + 34);
    const traysSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="287mm" height="${H3}mm" viewBox="0 0 287 ${H3}">
<rect width="287" height="${H3}" fill="#fff"/>
<text x="${m}" y="9" font-size="5" font-weight="bold" ${STYLE.label}>Crease Lab · transformer neck, head and trays · page 3 of 4</text>
<text x="${m}" y="15" font-size="3" ${STYLE.label}>Cut the trays and neck parts from 2 mm card. Scales or bristles go under the tail tray, the sled and the head box (page 4).</text>
${g}
<line x1="${m + 100}" y1="${H3 - 6}" x2="${m + 150}" y2="${H3 - 6}" stroke="#111" stroke-width="0.5"/><text x="${m + 125}" y="${H3 - 8.5}" font-size="3" text-anchor="middle" ${STYLE.label}>50 mm: measure this after printing</text>
</svg>`;
    let g4 = '', H4 = 0;
    // head box net: n side panels side × Lh, a glue tab, and two caps
    { const w = n * side + 8, h = Lh + 2 * R + 10, x0 = m, y0 = 26; H4 = y0 + h + 30;
      g4 += t(x0 + w / 2, y0 - 2, 'head box · fold into a ' + n + '-sided tube, close with the caps', 3);
      for (let k = 0; k < n; k++) g4 += rect(x0 + k * side, y0, side, Lh);
      // panel 0 is the bottom. Top edge of the net = front of the head.
      g4 += t(x0 + side / 2, y0 + 3.5, 'BOTTOM') + t(x0 - 2, y0 + 3, 'front', 2.4, 'end') + t(x0 - 2, y0 + Lh - 1, 'back', 2.4, 'end');
      if (o.camera) g4 += rect(x0 + side / 2 - CAMERA.lens / 2 - 1, y0 + 5, CAMERA.lens + 2, CAMERA.lens + 2) + t(x0 + side / 2 + CAMERA.lens / 2 + 2, y0 + 5 + CAMERA.lens / 2 + 2, 'camera', 2.2, 'start');
      g4 += rect(x0 + 2, y0 + Lh * 0.62, side - 4, Lh * 0.38 - 2, STYLE.hint) + t(x0 + side / 2, y0 + Lh * 0.81 + 1, 'skin pad underneath', 2.2);
      for (let k = 1; k < n; k++) g4 += `<line x1="${f1(x0 + k * side)}" y1="${f1(y0)}" x2="${f1(x0 + k * side)}" y2="${f1(y0 + Lh)}" ${STYLE.fold}/>`;
      g4 += `<polygon points="${f1(x0 + n * side)},${f1(y0)} ${f1(x0 + n * side + 6)},${f1(y0 + 3)} ${f1(x0 + n * side + 6)},${f1(y0 + Lh - 3)} ${f1(x0 + n * side)},${f1(y0 + Lh)}" ${STYLE.glue}/>`;
      const cap = (cx, cy, label, hole) => {
        let s = `<polygon points="${Array.from({ length: n }, (_, j) => { const a = -PI / 2 + PI / n + (2 * PI * j) / n; return f1(cx + (R - 0.6) * Math.cos(a)) + ',' + f1(cy - (R - 0.6) * Math.sin(a)); }).join(' ')}" ${STYLE.cut}/>`;
        if (hole) s += rect(cx - CAMERA.lens / 2 - 1, cy - CAMERA.lens / 2 - 1, CAMERA.lens + 2, CAMERA.lens + 2, STYLE.hint) + t(cx, cy + CAMERA.lens / 2 + 4, 'optional window: a view while crawling');
        return s + t(cx, cy + R + 3, label);
      };
      g4 += cap(x0 + R, y0 + Lh + R + 6, 'front cap', o.camera) + cap(x0 + 3 * R + 4, y0 + Lh + R + 6, 'back cap · head bracket here', false); }
    H4 = Math.ceil(H4);
    const headSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="287mm" height="${H4}mm" viewBox="0 0 287 ${H4}">
<rect width="287" height="${H4}" fill="#fff"/>
<text x="${m}" y="9" font-size="5" font-weight="bold" ${STYLE.label}>Crease Lab · transformer head box · page 4 of 4</text>
<text x="${m}" y="15" font-size="3" ${STYLE.label}>0.5–1 mm card. Score the red lines, fold into a tube and glue the tab; the caps fit just inside the ends. The BOTTOM panel faces forward when the head is raised, so the camera looks out of it in Tower.</text>
${g4}
<line x1="${m + 100}" y1="${H4 - 6}" x2="${m + 150}" y2="${H4 - 6}" stroke="#111" stroke-width="0.5"/><text x="${m + 125}" y="${H4 - 8.5}" font-size="3" text-anchor="middle" ${STYLE.label}>50 mm: measure this after printing</text>
</svg>`;
    const fitA4 = (w, h) => (w <= 287 && h <= 200) || (w <= 200 && h <= 287);
    return { svg, partsSvg, traysSvg, headSvg, W: ct.W, H: ct.H, W2: ct.W2, H2: ct.H2, W3: 287, H3, W4: 287, H4, page: fitA4(ct.W, ct.H) && fitA4(ct.W2, ct.H2) && fitA4(287, H3) && fitA4(287, H4) ? 'A4' : 'A3',
      a_mm: ct.a_mm, b_mm: ct.b_mm, c_mm: ct.c_mm, trays: tr, pivot, spacer: pivot - (sv.len - 9.5) + shaftFromFront, flats_mm: flats };
  }

  // ---------------------------------------------------------------
  // Controller: three servos (left cables, right cables, neck), four shapes, a mission
  // ---------------------------------------------------------------
  function tPins(board) {
    const esp = board === 'esp32', pico = board === 'pico';
    return esp ? { L: 18, R: 19, N: 21, B: 23, names: ['GPIO18', 'GPIO19', 'GPIO21', 'GPIO23'], pw: '5V (VIN) pin' }
      : pico ? { L: 2, R: 3, N: 4, B: 5, names: ['GP2', 'GP3', 'GP4', 'GP5'], pw: 'VSYS pin' }
      : { L: 9, R: 10, N: 11, B: 4, names: ['D9', 'D10', 'D11', 'D4'], pw: '5V pin' };
  }
  function transformerSketch(plan, opts) {
    const o = Object.assign({}, T_DEFAULTS, opts || {});
    const esp = o.board === 'esp32', pico = o.board === 'pico', pins = tPins(o.board);
    const c = plan.compact, w = plan.crawl, ph = w.phases;
    const mission = plan.mission.map((st) => `  { ${st.mode === 'compact' ? 'COMPACT' : st.mode === 'crawl' ? (st.still ? 'REST' : 'CRAWL') : st.mode === 'tower' ? 'TOWER' : 'REACH'}, ${Math.round(st.T * 1000)}UL, ${st.neck || 0} },   // ${st.name}`).join('\n');
    return `// Crease Lab: origami transformer controller (Stage 3)
// One robot, four shapes. Generated from the simulator: cable strokes for Compact and
// for the crawl stroke on a ${f1(plan.spool_mm)} mm spool, and the neck angles for Tower and Reach.
// Board: ${esp ? 'ESP32 (install the "ESP32Servo" library)' : pico ? 'Raspberry Pi Pico with the Arduino-Pico core' : 'Arduino Nano / Uno'}
//
// Pull the 5V link before plugging in USB, so the laptop never powers the servos.
// Serial monitor (115200):
//   c = Compact   w = Crawl   t = Tower   r = Reach   x or z = rest (cables slack, neck straight)
//   [ / ] = Reach angle -5 / +5 degrees     m = run the mission
//   + / - = scale the cable strokes (it refuses to go past a servo's range)
// The start button on the sled also runs the mission. Nothing moves until you ask.

#include <${esp ? 'ESP32Servo.h' : 'Servo.h'}>

const int PIN_LEFT = ${pins.L};    // left cable pair
const int PIN_RIGHT = ${pins.R};   // right cable pair
const int PIN_NECK = ${pins.N};    // neck servo (it is the hinge)
const int PIN_START = ${pins.B};   // start button to GND

// Calibrate with x: cables just slack, head straight in line with the body.
// Copy LEFT_ZERO / RIGHT_ZERO from Stage 2, then check them again: the spools are bigger now.
int LEFT_ZERO = 10;
int RIGHT_ZERO = 170;      // mirrored servo, winds the other way
int NECK_ZERO = 90;        // servo angle with the head straight
const int LEFT_DIR = +1, RIGHT_DIR = -1;
const int NECK_DIR = +1;   // flip to -1 if 't' makes the head dip instead of rise (test it held in the air)

// From the simulator (degrees of servo travel)
const float COMPACT_LEFT = ${f1(c.leftDeg)}, COMPACT_RIGHT = ${f1(c.rightDeg)};   // ${f1(c.leftMm)} / ${f1(c.rightMm)} mm of cable
const float CRAWL_LEFT = ${f1(w.leftDeg)}, CRAWL_RIGHT = ${f1(w.rightDeg)};       // ${f1(w.leftMm)} / ${f1(w.rightMm)} mm per stroke
const unsigned long CONTRACT_MS = ${Math.round(ph[0].dur * 1000)}, RELEASE_MS = ${Math.round(ph[1].dur * 1000)};
const int TOWER_NECK = ${plan.neck.tower};
int reachNeck = ${plan.neck.reach};
const float NECK_DEG_PER_S = 30;    // the neck moves at most this fast, like the simulator's servo
const float CABLE_DEG_PER_S = 200;  // nor do the cable servos ever jump
const unsigned long BLEND_MS = 600;

enum Shape { REST, COMPACT, CRAWL, TOWER, REACH };
struct Step { Shape shape; unsigned long ms; int neck; };
const Step MISSION[] = {
${mission}
};
const int N_STEPS = sizeof(MISSION) / sizeof(MISSION[0]);

Servo sLeft, sRight, sNeck;
Shape shape = REST;
unsigned long shapeStart = 0, lastMs = 0, stepStart = 0;
float cableL = 0, cableR = 0, neck = 0, strokeScale = 1.0;
int missionStep = -1;
bool lastButton = true;

float smooth(float x) { x = constrain(x, 0.0f, 1.0f); return x * x * (3 - 2 * x); }
void setShape(Shape s) { shape = s; shapeStart = millis(); }
void startMission() { missionStep = 0; stepStart = millis(); if (MISSION[0].neck) reachNeck = MISSION[0].neck; setShape(MISSION[0].shape); }

// would this stroke scale drive a cable servo past 5..175 degrees?
bool scaleOk(float sc) {
  float m = (COMPACT_LEFT > CRAWL_LEFT ? COMPACT_LEFT : CRAWL_LEFT) * sc, n = (COMPACT_RIGHT > CRAWL_RIGHT ? COMPACT_RIGHT : CRAWL_RIGHT) * sc;
  float l = LEFT_ZERO + LEFT_DIR * m, r = RIGHT_ZERO + RIGHT_DIR * n;
  return l >= 5 && l <= 175 && r >= 5 && r <= 175;
}

void targets(float &tl, float &tr, float &tn) {
  unsigned long t = millis() - shapeStart;
  tl = 0; tr = 0; tn = 0;
  if (shape == COMPACT) { tl = COMPACT_LEFT; tr = COMPACT_RIGHT; }
  if (shape == CRAWL) {
    unsigned long u = t % (CONTRACT_MS + RELEASE_MS);
    float k = u < CONTRACT_MS ? smooth((float)u / BLEND_MS) : 1 - smooth((float)(u - CONTRACT_MS) / BLEND_MS);
    tl = CRAWL_LEFT * k; tr = CRAWL_RIGHT * k;
  }
  if (shape == TOWER) tn = TOWER_NECK;
  if (shape == REACH) tn = reachNeck;
}

void writeAll() {
  sLeft.write(constrain(LEFT_ZERO + LEFT_DIR * (int)(cableL * strokeScale), 0, 180));
  sRight.write(constrain(RIGHT_ZERO + RIGHT_DIR * (int)(cableR * strokeScale), 0, 180));
  sNeck.write(constrain(NECK_ZERO + NECK_DIR * (int)neck, 0, 180));
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_START, INPUT_PULLUP);
  sLeft.attach(PIN_LEFT); sRight.attach(PIN_RIGHT); sNeck.attach(PIN_NECK);
  writeAll();
  lastMs = millis();
}

void loop() {
  unsigned long now = millis();
  float dt = (now - lastMs) / 1000.0f; lastMs = now;
  if (Serial.available()) {
    char ch = Serial.read();
    if (ch == 'c') { missionStep = -1; setShape(COMPACT); }
    if (ch == 'w') { missionStep = -1; setShape(CRAWL); }
    if (ch == 't') { missionStep = -1; setShape(TOWER); }
    if (ch == 'r') { missionStep = -1; setShape(REACH); }
    if (ch == 'x' || ch == 'z') { missionStep = -1; setShape(REST); }   // eases everything back, never snaps
    if (ch == '[') reachNeck = max(5, reachNeck - 5);
    if (ch == ']') reachNeck = min(90, reachNeck + 5);
    if (ch == 'm') startMission();
    if (ch == '+') { if (scaleOk(strokeScale + 0.05f)) strokeScale += 0.05f; else Serial.println("that would drive a servo past its range"); }
    if (ch == '-') { strokeScale -= 0.05f; if (strokeScale < 0.1f) strokeScale = 0.1f; }
    Serial.print("shape "); Serial.print((int)shape); Serial.print("  reach "); Serial.print(reachNeck);
    Serial.print("  scale "); Serial.println(strokeScale);
  }
  // start button: press (to GND) to run the mission, press again during it to stop
  bool b = digitalRead(PIN_START);
  if (lastButton && !b) { if (missionStep < 0) startMission(); else { missionStep = -1; setShape(REST); } delay(30); }
  lastButton = b;
  if (missionStep >= 0 && now - stepStart >= MISSION[missionStep].ms) {
    missionStep++;
    if (missionStep >= N_STEPS) { missionStep = -1; setShape(REST); }
    else { stepStart = now; if (MISSION[missionStep].neck) reachNeck = MISSION[missionStep].neck; setShape(MISSION[missionStep].shape); }
  }
  float tl, tr, tn; targets(tl, tr, tn);
  // the cables only pull once the head is back down, so the body never folds with the neck raised
  if (tn == 0 && neck > 5) { tl = 0; tr = 0; }
  // and the neck only moves once the cables are nearly slack
  if (tn > 0 && (cableL > 5 || cableR > 5)) tn = 0;
  float cs = CABLE_DEG_PER_S * dt, ns = NECK_DEG_PER_S * dt;
  cableL += constrain(tl - cableL, -cs, cs);
  cableR += constrain(tr - cableR, -cs, cs);
  neck += constrain(tn - neck, -ns, ns);
  writeAll();
  delay(10);
}
`;
  }

  function transformerWiring(board, camera) {
    const pins = tPins(board);
    const rows = [
      ['Left cable servo signal (orange)', pins.names[0]], ['Right cable servo signal (orange)', pins.names[1]], ['Neck servo signal (orange)', pins.names[2]],
      ['Start button', pins.names[3] + ' and GND'],
      ['LiPo +', 'switch, then boost converter IN+'], ['LiPo −', 'boost converter IN−'],
      ['Boost OUT+ (set to 5.0 V first)', 'all three servo red wires, and through the 5V link to the board ' + pins.pw], ['Boost OUT−', 'all servo brown wires and board GND (always connected)'],
      ['Capacitors', 'one across OUT+ and OUT− at the servos, one at the board (stripe to −)'],
    ];
    if (camera) rows.push(['ESP32-CAM 5V and GND', 'boost OUT+ and OUT−, two thin wires through the neck with a slack loop']);
    rows.push(['USB', 'pull the 5V link first: then USB powers only the board and the battery powers the servos (switch on to test, off to only upload)']);
    return { rows, pins: pins.names };
  }

  function transformerBom(tp, plan, opts) {
    const o = Object.assign({}, T_DEFAULTS, opts || {});
    const P = CL.PARTS, sv = P.servo[o.servo] || P.servo.mg90s, tr = CL.trayDims(bodyParams(tp), { R_mm: o.R_mm, servo: o.servo, spool_mm: plan.spool_mm });
    const rows = [
      ['Body', 'Cardstock 160–220 gsm, or 0.2 mm polypropylene sheet', '1 sheet', 'the body strip'],
      ['Body', '1–2 mm card or 3D-printed plates', `${tp.cells + 1}`, `P0…P${tp.cells}; P${tp.cells} is the shoulder`],
      ['Body', '2 mm card', '1 sheet', 'tail tray, sled, neck spacer and bracket'],
      ['Body', '0.5–1 mm card', '1 sheet', 'the head box'],
      ['Body', 'Craft foam, 5–8 mm', 'a scrap', 'the pad between the battery stack and the neck servo'],
      ['Actuation', sv.name, '3', 'two pull the cable pairs, one is the neck hinge'],
      ['Actuation', 'Braided fishing line, 0.2–0.3 mm (PE)', '2 m', 'four cables plus knots and spool wraps'],
      ['Actuation', 'Spools', '2', `${f1(plan.spool_mm)} mm radius, glued to the cable servo horns`],
      ['Actuation', 'Card or foam for the servo risers', '', `about ${f0(tr.riser)} mm tall`],
      ['Feet', 'Climbing-skin strip, or angled toothbrush bristles', '3 pieces', `under the tail tray, the sled and the head box, hairs leaning toward the tail; each pad plus its card about ${f1(tr.padThick)} mm thick`],
      ['Electronics', { esp32: 'ESP32 DevKit (ESP32-WROOM)', nano: 'Arduino Nano', pico: 'Raspberry Pi Pico (Arduino-Pico core)' }[o.board], '1', o.board === 'pico' ? 'on the sled, under the neck; solder wires instead of header pins to keep the stack low' : 'on the sled. Check it fits under the neck servo with the battery: the stack can be about 18 mm tall'],
      ['Electronics', P.lipo3.name, '1', 'about 25 g; two cable servos stalling together can pull 3–4 A from the cell. Check the JST polarity with a meter.'],
      ['Electronics', 'TP4056 USB LiPo charger module', '1', 'charges at 1 A as sold: change R_PROG to 2.4 kΩ (about 500 mA) for this cell. Charge off the robot, never unattended.'],
      ['Electronics', P.boost3.name, '1', 'rated by its output current. Set it to 5.0 V with a multimeter before connecting anything.'],
      ['Electronics', 'Slide or toggle switch rated 3 A or more', '1', 'between the battery and the boost converter'],
      ['Electronics', '470–1000 µF electrolytic capacitor, 10 V or more', '2', 'one at the servos, one at the board'],
      ['Electronics', '2-pin header and jumper (the "5V link")', '1', "in the wire to the board's 5V/VSYS pin; pull it whenever USB is plugged in"],
      ['Electronics', 'Small push button', '1', 'starts and stops the mission'],
      ['Electronics', 'Thin flexible wire (silicone, 26–28 AWG)', '1.5 m', 'servo leads along the body, camera power through the neck'],
    ];
    if (o.camera) rows.push(['Camera', CAMERA.name, '1', 'optional; runs the Arduino "CameraWebServer" example and streams over Wi-Fi. Needs a USB-serial adapter to program.']);
    rows.push(['Tools', 'Craft knife, metal ruler, empty ballpoint pen, tacky glue, hot glue, double-sided foam tape, M2 screws for the neck horn, kitchen scale, multimeter', '', '']);
    return rows;
  }

  function transformerReadme(tp, plan, tmpl, check, opts) {
    const o = Object.assign({}, T_DEFAULTS, opts || {});
    const w = transformerWiring(o.board, o.camera), L = tp.cells, R = o.R_mm;
    const tr = CL.trayDims(bodyParams(tp), { R_mm: R, servo: o.servo, spool_mm: plan.spool_mm });
    const ck = check, sv = CL.PARTS.servo[o.servo] || CL.PARTS.servo.mg90s;
    const pull = (sv.torque_kgcm * 9.81) / (plan.spool_mm / 10);   // stall pull at the spool rim, newtons
    const massRows = ck ? ck.mass.items.map((it) => `| ${it.where} | ${it.name} | ${f1(it.g)} g |`).join('\n') : '';
    const steps = [
      `Build the Stage 2 crawler first, with ${L} cells. P${L}, its head plate, becomes the shoulder. Compact pulls the cables further than crawling, so fit ${f1(plan.spool_mm)} mm radius spools and make the risers ${f0(tr.riser)} mm tall (shafts ${f1(tr.shaftH)} mm off the floor, so the spools clear it by ${f1(tr.shaftH - plan.spool_mm)} mm).`,
      `Take the head tray off. Cut the sled (page 3), stick scales underneath (pad plus card about ${f1(tr.padThick)} mm thick) and glue it under P${L} at its dashed line: ${SLED.rear} mm of it under the last body cell, ${SLED.front} mm sticking out in front.`,
      `Before connecting anything to it, power the boost converter from the LiPo through the switch and set its output to 5.0 V with a multimeter.`,
      `Put the LiPo on the front half of the sled with double-sided foam tape, the board on top of it, and the boost converter beside them, as drawn.`,
      `Glue the neck spacer (2 mm card, about ${f1(tmpl.spacer)} mm long) to the front face of P${L}, and the third servo to it, lying on its side, with a foam pad between the servo and the battery stack so it is supported from below. Its shaft must point left or right, sit ${f1(tr.centre)} mm off the floor (the plate's centre height) and be ${f1(tmpl.pivot)} mm in front of P${L}. The page 3 side view shows the layout.`,
      `Fold the head box (page 4) and close it with the caps. Stick a skin pad under the back half of its BOTTOM panel, built up to about ${f1(tr.padThick)} mm so the head rests on the floor instead of hanging from the servo.`,
      `Screw a single-arm horn to the neck servo. Glue the head bracket (a 2 mm card strip) to the horn and to the back cap of the head box, so the back cap is ${f1(tmpl.pivot)} mm in front of the shaft and the head lines up with the body.`,
      o.camera ? 'Program the ESP32-CAM on the bench first (USB-serial adapter, the CameraWebServer example, your Wi-Fi details). Mount it inside the head box and fold its camera ribbon so the lens looks out of the window in the BOTTOM panel: with the head raised in Tower, that panel faces forward. (The optional front-cap window gives a view while crawling instead.) Run its two power wires back through the neck with a slack loop.' : 'Leave the head box empty, or put a small weight in it (about 10 g) to stand in for a camera, so the robot behaves as simulated.',
      `Wire it (below), including the start button. Run the neck servo's lead along the spacer so the neck can swing.`,
      'Pull the 5V link, plug in USB, and upload transformer.ino. Copy in your Stage 2 LEFT_ZERO / RIGHT_ZERO, then check them again with the bigger spools. Switch the battery on (it powers the servos) and open the serial monitor at 115200. Press x and set NECK_ZERO so the head is straight.',
      'Hold the robot in the air and press t. The head should swing up. If it swings down, set NECK_DIR = -1 and upload again. Press x to bring it back.',
      `Put it on the floor and try c (Compact), w (Crawl) and r (Reach), and [ ] to aim the head. Don't leave it in Compact for long: on ${f1(plan.spool_mm)} mm spools an ${sv.name.replace('Micro servo ', '')} pulls at most about ${f1(pull)} N, so it may be near stall there. If it buzzes and stops short, press - or press x, rather than +.`,
      'Press m, or the button, for the whole mission. To run it untethered: unplug USB, put the 5V link back, switch on and press the button.',
      "Weigh the robot and compare with the estimate above. Measure the camera height in Tower and the crawl distance per cycle, and note them next to the simulator's numbers.",
    ];
    return `# Origami transformer build (Stage 3, from Crease Lab)

The Stage 2 crawler with a neck and a head. ${L} Kresling cells, ${tp.n}-sided, corner radius ${R} mm, twist ${tp.phi}° per cell.
Three servos: two wind the body cables (Compact and Crawl), one is the neck hinge (Tower and Reach).
The head is a rigid card box${o.camera ? ' with a camera' : ''}: in the simulator a paper Kresling head squashes under it${ck ? ` (camera only ${f0(ck.paperHeadCamera * R)} mm up in Tower instead of ${f0(ck.tower.camera * R)} mm)` : ''}.

## Files
- template-body.svg, template-plates.svg, template-trays-neck.svg, template-head.svg: print at 100% (${tmpl.page}). Check the 50 mm bar.
- transformer/transformer.ino: controller. Open in the Arduino IDE.
- bom.csv: parts.

## Safety first
- Pull the 5V link before plugging in USB, every time. Then the laptop only powers the board, and the battery (switched on) powers the servos.
- Set the boost converter to 5.0 V with a multimeter before it is connected to anything.
- Charge the LiPo off the robot, with the TP4056's R_PROG changed to 2.4 kΩ, never unattended. Stop using it if it puffs up.

## From the simulator
| | Cables (left / right) | Servo travel | Neck |
|---|---|---|---|
| Compact | ${f1(plan.compact.leftMm)} / ${f1(plan.compact.rightMm)} mm | ${f0(plan.compact.leftDeg)}° / ${f0(plan.compact.rightDeg)}° | straight |
| Crawl (each stroke) | ${f1(plan.crawl.leftMm)} / ${f1(plan.crawl.rightMm)} mm | ${f0(plan.crawl.leftDeg)}° / ${f0(plan.crawl.rightDeg)}° | straight |
| Tower | slack | 0° | commanded ${plan.neck.tower}° up |
| Reach | slack | 0° | ${plan.neck.reach}° (adjust with [ and ]) |

Spool radius ${f1(plan.spool_mm)} mm. ${plan.fits ? "The longest pull fits in the servo's travel." : `The longest pull needs ${f0(plan.maxDeg)}° of servo travel. Most micro servos turn 160–180°; check yours, and if it stops short, Compact folds a little less (the sketch never drives past 5–175°).`}
${ck ? `
## Weight and what to expect
Estimated: ${f1(ck.mass.total)} g in all (paper body ${f1(ck.mass.body)} g, tail ${f1(ck.mass.tail)} g, sled ${f1(ck.mass.sled)} g, neck ${f1(ck.mass.neck)} g, head ${f1(ck.mass.head)} g).

| Where | Part | Weight |
|---|---|---|
${massRows}

With those weights in the simulator (rigid head, scales only, no grips):
- Tower: commanded ${plan.neck.tower}°, the neck settles at ${f0(ck.tower.neck)}°; the camera is ${f0(ck.tower.camera * R)} mm off the floor (${f0(ck.cameraFlat * R)} mm lying flat) and the shoulder tips back ${f1(Math.abs(ck.tower.tilt))}°.
- Reach at 45°: the head's tip held ${f0(ck.reach.tipZ * R)} mm up.
- Compact: ${f0(100 * ck.compact.length)}% of full length.
- Crawl: ${f1(ck.crawl * R)} mm per cycle (the simulated robot without its parts manages ${f1(ck.crawlBare * R)}). It is heavy for a paper body, so it is slow.
` : ''}
## Build steps
${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}

## Wiring (${o.board === 'esp32' ? 'ESP32' : o.board === 'pico' ? 'Pico' : 'Arduino Nano'}, on board)
${w.rows.map((r) => `- ${r[0]} → ${r[1]}`).join('\n')}

## Closing the loop
The neck brackets here are card. They are the one part worth drawing in CAD and 3D printing: a printed bracket holds the servo at exactly ${f1(tmpl.pivot)} mm and the right height, and won't flex. Then measure the real camera height and crawl distance and compare them with the numbers above.
`;
  }

  const API = { CAMERA, transformerMass, loadedTransformer, transformerCheck, transformerPlan, transformerTemplates, transformerSketch, transformerWiring, transformerBom, transformerReadme };
  Object.assign(CL, API);
  if (typeof module !== 'undefined' && module.exports) module.exports = CL;
})(typeof window !== 'undefined' ? window : globalThis);
