// ===== Crease Lab build: turn a simulated design into a real robot =====
// Fold templates at true scale, servo plan from the simulator, Arduino sketch, parts list, zip.
(function (root) {
  'use strict';
  const CL = typeof module !== 'undefined' && module.exports ? require('./motion.js') : root.CreaseLab;
  const PI = Math.PI, DEG = PI / 180;
  const f1 = (v) => (Math.round(v * 10) / 10).toString();
  const f2 = (v) => (Math.round(v * 100) / 100).toString();

  const STYLE = {
    cut: 'stroke="#111" stroke-width="0.35" fill="none"',
    M: 'stroke="#d1453b" stroke-width="0.35" stroke-dasharray="4 1.2 0.8 1.2" fill="none"',
    V: 'stroke="#2a63c9" stroke-width="0.35" stroke-dasharray="2.4 1.4" fill="none"',
    tabFold: 'stroke="#d1453b" stroke-width="0.3" stroke-dasharray="4 1.2 0.8 1.2" fill="none"',
    glue: 'fill="#e7e2d3" stroke="#111" stroke-width="0.35"',
    label: 'font-family="Helvetica, Arial, sans-serif" fill="#333"',
  };

  function legendSVG(x, y) {
    return `<g transform="translate(${x},${y})" ${STYLE.label} font-size="3">
      <line x1="0" y1="0" x2="12" y2="0" ${STYLE.cut}/><text x="14" y="1">cut</text>
      <line x1="26" y1="0" x2="38" y2="0" ${STYLE.M}/><text x="40" y="1">mountain fold</text>
      <line x1="66" y1="0" x2="78" y2="0" ${STYLE.V}/><text x="80" y="1">valley fold</text>
      <rect x="102" y="-2" width="8" height="4" ${STYLE.glue}/><text x="112" y="1">glue tab</text>
      <line x1="130" y1="0" x2="180" y2="0" stroke="#111" stroke-width="0.5"/><line x1="130" y1="-2" x2="130" y2="2" stroke="#111" stroke-width="0.5"/><line x1="180" y1="-2" x2="180" y2="2" stroke="#111" stroke-width="0.5"/>
      <text x="155" y="-3" text-anchor="middle">50 mm: measure this after printing</text>
    </g>`;
  }

  // ---------------------------------------------------------------
  // Template for the crawler body: one strip + plates + foot pads
  // ---------------------------------------------------------------
  function crawlerTemplate(params, opts) {
    opts = Object.assign({ R_mm: 30, page: 'A4' }, opts || {});
    const n = params.n, L = params.cells, R = opts.R_mm, phi = params.phi * DEG, Hc = params.H;
    const same = params.chirality === 'same';
    const rot = (k) => (same ? k * phi : (k % 2 ? phi : 0));
    const base = -PI / 2 + PI / n;
    const P = (k, j) => { const t = base + (2 * PI * j) / n + rot(k); return [k * Hc, Math.cos(t), Math.sin(t)]; };
    const d3 = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
    // edge lengths of one positive cell (all triangles are congruent)
    const a = d3(P(0, 0), P(0, 1)), b = d3(P(0, 0), P(1, 0));
    const c = same || true ? d3(P(0, 0), P(1, 1)) : 0;
    const vx = (c * c - b * b - a * a) / (2 * a), vy = Math.sqrt(Math.max(1e-9, b * b - vx * vx));
    // assignments from the simulated pattern
    const pat = CL.buildCrawlerPattern(params);
    const sim = CL.buildMesh(pat, { SimClass: CL.RobotSim });
    const asg = new Map();
    for (const h of sim.hinges) asg.set(CL.ekey(h.h1, h.h2), h.asg);
    const simId = (k, j) => k * n + (((j % n) + n) % n);
    const A = (k1, j1, k2, j2) => asg.get(CL.ekey(simId(k1, j1), simId(k2, j2))) || 'V';
    // flat strip coordinates (mm), y grows downward in SVG
    const off = [0];
    for (let k = 0; k < L; k++) off.push(off[k] + ((same || k % 2 === 0) ? vx : -vx));
    const pts = []; // pts[k][j]
    for (let k = 0; k <= L; k++) { const row = []; for (let j = 0; j <= n; j++) row.push([(j * a + off[k]) * R, (L - k) * vy * R]); pts.push(row); }
    let minx = Infinity, maxx = -Infinity;
    for (const row of pts) for (const p of row) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); }
    const tab = 6; // mm
    const margin = 12, top0 = 22;
    const shiftX = margin - minx + tab, shiftY = top0 + tab;
    const T = (p) => [p[0] + shiftX, p[1] + shiftY];
    const line = (p, q, st) => { const u = T(p), w = T(q); return `<line x1="${f2(u[0])}" y1="${f2(u[1])}" x2="${f2(w[0])}" y2="${f2(w[1])}" ${st}/>`; };
    const poly = (ps, st) => `<polygon points="${ps.map((p) => T(p).map(f2).join(',')).join(' ')}" ${st}/>`;
    // tab on edge p->q, on the side away from `inside`
    const tabPoly = (p, q, inside) => {
      const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
      let nx = -dy / len, ny = dx / len;
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
      if ((inside[0] - mx) * nx + (inside[1] - my) * ny > 0) { nx = -nx; ny = -ny; }
      const ins = Math.min(tab * 0.8, len * 0.25), ux = dx / len, uy = dy / len;
      return [p, [p[0] + nx * tab + ux * ins, p[1] + ny * tab + uy * ins], [q[0] + nx * tab - ux * ins, q[1] + ny * tab - uy * ins], q];
    };
    let body = '';
    const centroidOf = (k) => { const r = pts[k], s = [0, 0]; for (const p of r) { s[0] += p[0]; s[1] += p[1]; } return [s[0] / r.length, s[1] / r.length]; };
    const mid = [(pts[0][0][0] + pts[L][n][0]) / 2, (pts[0][0][1] + pts[L][0][1]) / 2];
    // glue tabs: right seam (glued under the left edge), bottom and top rings (glued to the end plates)
    for (let k = 0; k < L; k++) body += poly(tabPoly(pts[k][n], pts[k + 1][n], mid), STYLE.glue);
    for (let j = 0; j < n; j++) {
      body += poly(tabPoly(pts[0][j], pts[0][j + 1], mid), STYLE.glue);
      body += poly(tabPoly(pts[L][j], pts[L][j + 1], mid), STYLE.glue);
    }
    // cut: left seam edge
    for (let k = 0; k < L; k++) body += line(pts[k][0], pts[k + 1][0], STYLE.cut);
    // creases
    const st = (s) => (s === 'M' ? STYLE.M : STYLE.V);
    for (let k = 0; k <= L; k++) for (let j = 0; j < n; j++) {
      if (k === 0 || k === L) body += line(pts[k][j], pts[k][j + 1], STYLE.tabFold); // tabs fold inward at the rings
      else body += line(pts[k][j], pts[k][j + 1], st(A(k, j, k, j + 1)));
    }
    for (let k = 0; k < L; k++) {
      const pos = same || k % 2 === 0;
      for (let j = 0; j <= n; j++) body += line(pts[k][j], pts[k + 1][j], j === 0 ? STYLE.cut : st(A(k, j, k + 1, j)));
      for (let j = 0; j < n; j++) {
        if (pos) body += line(pts[k][j], pts[k + 1][j + 1], st(A(k, j, k + 1, j + 1)));
        else body += line(pts[k][j + 1], pts[k + 1][j], st(A(k, j + 1, k + 1, j)));
      }
    }
    // ring labels so plates line up
    for (let k = 0; k <= L; k++) {
      const p = T(pts[k][0]);
      body += `<text x="${f2(p[0] - 2)}" y="${f2(p[1] + (k === 0 ? 4 : -1.5))}" font-size="3" text-anchor="end" ${STYLE.label}>P${k}</text>`;
    }
    const stripW = (maxx - minx) + 2 * tab, stripH = L * vy * R + 2 * tab;
    // ---- page 2: plates and foot pads ----
    const eyeR = 0.72 * Math.cos(PI / n) * R;
    const plateR = R - 0.6; // fits inside the paper ring
    const pageW = 285;
    let plates = '', px = margin + plateR, py = top0 + plateR + 4, rowMax = 0;
    for (let k = 0; k <= L; k++) {
      if (px + plateR > pageW - margin + 0.01) { px = margin + plateR; py += 2 * plateR + 14; }
      const cx = px, cy = py;
      const ang = (j) => base + (2 * PI * j) / n + rot(k);
      const corner = (j) => [cx + plateR * Math.cos(ang(j)), cy - plateR * Math.sin(ang(j))];
      plates += `<polygon points="${Array.from({ length: n }, (_, j) => corner(j).map(f2).join(',')).join(' ')}" ${STYLE.cut}/>`;
      const c0 = corner(0);
      plates += `<circle cx="${f2(c0[0] + (cx - c0[0]) * 0.12)}" cy="${f2(c0[1] + (cy - c0[1]) * 0.12)}" r="0.9" fill="#111"/>`;
      for (const deg of [45, 135, 225, 315]) {
        const t = deg * DEG;
        plates += `<circle cx="${f2(cx + eyeR * Math.cos(t))}" cy="${f2(cy - eyeR * Math.sin(t))}" r="1.25" ${STYLE.cut}/>`;
      }
      plates += `<line x1="${f2(cx - 1.5)}" y1="${f2(cy)}" x2="${f2(cx + 1.5)}" y2="${f2(cy)}" stroke="#999" stroke-width="0.25"/><line x1="${f2(cx)}" y1="${f2(cy - 1.5)}" x2="${f2(cx)}" y2="${f2(cy + 1.5)}" stroke="#999" stroke-width="0.25"/>`;
      plates += `<text x="${f2(cx)}" y="${f2(cy + plateR + 5)}" font-size="3.2" text-anchor="middle" ${STYLE.label}>P${k}${k === 0 ? ' tail' : k === L ? ' head' : ''} · dot = corner 0</text>`;
      plates += `<text x="${f2(cx + eyeR + 2.2)}" y="${f2(cy + 1)}" font-size="2.6" ${STYLE.label}>L</text><text x="${f2(cx - eyeR - 4)}" y="${f2(cy + 1)}" font-size="2.6" ${STYLE.label}>R</text>`;
      rowMax = Math.max(rowMax, cx + plateR); px += 2 * plateR + 8;
    }
    // trays double as foot pads: the servo tray under and behind the tail plate, and (on board) the
    // electronics tray under and in front of the head plate. Their undersides carry the scales.
    const flats = 2 * R * Math.cos(PI / n);
    const trays = trayDims(params, opts);
    let pady = top0 + 10, padx = margin, pads = '';
    const tray = (t, title, notes) => {
      const w = t.len, h = flats;
      if (padx + w > pageW - margin) { padx = margin; pady += h + 22; }
      let g = `<rect x="${f2(padx)}" y="${f2(pady)}" width="${f2(w)}" height="${f2(h)}" ${STYLE.cut}/>`;
      for (const b of t.boxes) g += `<rect x="${f2(padx + b.x)}" y="${f2(pady + b.y)}" width="${f2(b.w)}" height="${f2(b.h)}" fill="none" stroke="#999" stroke-width="0.3" stroke-dasharray="1 1"/><text x="${f2(padx + b.x + b.w / 2)}" y="${f2(pady + b.y + b.h / 2 + 1)}" font-size="2.4" text-anchor="middle" ${STYLE.label}>${b.label}</text>`;
      g += `<line x1="${f2(padx + t.plateAt)}" y1="${f2(pady)}" x2="${f2(padx + t.plateAt)}" y2="${f2(pady + h)}" stroke="#111" stroke-width="0.3" stroke-dasharray="3 1.5"/>`;
      g += `<text x="${f2(padx + w / 2)}" y="${f2(pady - 2)}" font-size="3" text-anchor="middle" ${STYLE.label}>${title}</text>`;
      notes.forEach((nt, i) => { g += `<text x="${f2(padx + w / 2)}" y="${f2(pady + h + 4 + 3.4 * i)}" font-size="2.4" text-anchor="middle" ${STYLE.label}>${nt}</text>`; });
      pads += g; const bottom = pady + h + 4 + 3.4 * notes.length; padx += w + 10; return bottom;
    };
    let padBottom = tray(trays.tail, 'tail tray · also the tail foot pad', ['dashed line: glue under the tail plate here', 'servos on risers, shafts pointing out to the sides', 'scales or bristles underneath, leaning toward the tail']);
    padBottom = Math.max(padBottom, tray(trays.head, trays.onboard ? 'head tray · board and battery · also the head foot pad' : 'head foot pad', trays.onboard ? ['dashed line: glue under the head plate here', 'battery and board flat on top, wires along the body', 'scales or bristles underneath, leaning toward the tail'] : ['glue under the head plate', 'scales or bristles underneath, leaning toward the tail']));
    const W2 = Math.ceil(rowMax + margin), H2 = Math.ceil(py + plateR + 6 + margin + 6);
    const W3 = Math.max(200, Math.ceil(padx - 10 + margin)), H3 = Math.ceil(padBottom + margin + 8);
    const W1 = Math.ceil(stripW + 2 * margin + 4), H1 = Math.ceil(top0 + stripH + margin + 8);
    const W = Math.max(W1, 200);
    const head = (t) => `<text x="${margin}" y="9" font-size="5" font-weight="bold" ${STYLE.label}>${t}</text>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H1}mm" viewBox="0 0 ${W} ${H1}">
<rect width="${W}" height="${H1}" fill="#fff"/>
${head(`Crease Lab · Kresling crawler body · ${L} cells · ${n}-gon · R ${R} mm · page 1 of 3`)}
<text x="${margin}" y="15" font-size="3" ${STYLE.label}>Print at 100% (no fit-to-page) on 160–220 gsm cardstock or 0.2 mm polypropylene. Glue the side tab under the left edge to close the tube.</text>
${body}
${legendSVG(margin, H1 - 5)}
</svg>`;
    const WP = Math.max(W2, 200);
    const partsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WP}mm" height="${H2}mm" viewBox="0 0 ${WP} ${H2}">
<rect width="${WP}" height="${H2}" fill="#fff"/>
${head(`Crease Lab · plates · page 2 of 3`)}
<text x="${margin}" y="15" font-size="3" ${STYLE.label}>Cut from 1–2 mm card (or 3D print). Plates are drawn seen from the head: L and R holes are the robot's left and right cables. Trays are on page 3.</text>
${plates}
${legendSVG(margin, H2 - 5)}
</svg>`;
    const traysSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W3}mm" height="${H3}mm" viewBox="0 0 ${W3} ${H3}">
<rect width="${W3}" height="${H3}" fill="#fff"/>
${head(`Crease Lab · trays (they are also the foot pads) · page 3 of 3`)}
<text x="${margin}" y="15" font-size="3" ${STYLE.label}>Cut from 2 mm card. Seen from above, head to the right, so the robot's left side is at the top. Dotted boxes show where each part sits.</text>
${pads}
${legendSVG(margin, H3 - 5)}
</svg>`;
    const fit = (w, h) => ((w <= 287 && h <= 200) || (w <= 200 && h <= 287) ? 'A4' : (w <= 410 && h <= 287) || (w <= 287 && h <= 410) ? 'A3' : 'larger than A3');
    const fits = [fit(W, H1), fit(WP, H2), fit(W3, H3)];
    const pageFits = fits.every((f) => f === 'A4') ? 'A4' : fits.includes('larger than A3') ? 'larger than A3' : 'A3';
    return { svg, partsSvg, traysSvg, W, H: H1, W2: WP, H2, W3, H3, page: pageFits, stripLength: stripW, eyeR_mm: eyeR, a_mm: a * R, b_mm: b * R, c_mm: c * R, trays, flats_mm: flats, plateR_mm: plateR, n, cells: L };
  }

  // ---------------------------------------------------------------
  // Template for any flat pattern from the Fold tab (1 unit = 10 mm)
  // ---------------------------------------------------------------
  function sheetTemplate(pat, opts) {
    opts = Object.assign({ unit_mm: 10, title: 'pattern' }, opts || {});
    const s = opts.unit_mm, { verts, edges } = pat.cp;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of verts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const m = 12, top = 22;
    const W = Math.ceil((x1 - x0) * s + 2 * m), H = Math.ceil((y1 - y0) * s + top + 18);
    const X = (x) => f2((x - x0) * s + m), Y = (y) => f2((y1 - y) * s + top);
    let out = '';
    for (const [a, b, t] of edges) {
      if (t === 'F') continue;
      const st = t === 'M' ? STYLE.M : t === 'V' ? STYLE.V : STYLE.cut;
      out += `<line x1="${X(verts[a][0])}" y1="${Y(verts[a][1])}" x2="${X(verts[b][0])}" y2="${Y(verts[b][1])}" ${st}/>`;
    }
    const w = Math.max(W, 200);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${H}mm" viewBox="0 0 ${w} ${H}">
<rect width="${w}" height="${H}" fill="#fff"/>
<text x="${m}" y="9" font-size="5" font-weight="bold" ${STYLE.label}>Crease Lab · ${opts.title}</text>
<text x="${m}" y="15" font-size="3" ${STYLE.label}>Print at 100%. Score every fold line with an empty ballpoint pen against a ruler, then pre-fold each one before collapsing.</text>
${out}
${legendSVG(m, H - 5)}
</svg>`;
  }

  // ---------------------------------------------------------------
  // Servo plan: the simulator says how far each cable pair shortens in
  // each phase; a spool turns that into a servo angle.
  //   left pair = cables at 45° and 315°, right pair = 135° and 225°
  // ---------------------------------------------------------------
  function servoPlan(params, gait, opts) {
    opts = Object.assign({ R_mm: 30, spool_mm: 10, servoRange: 180, stiff: null }, opts || {});
    const phases = gait.phases.map((ph) => {
      const sim = CL.buildRobot(params, opts.stiff);
      sim.tensionScale = CL.tensionScaleFor(sim);
      const Tmax = (gait.tension || 1) * sim.tensionScale;
      sim.cableAngle.forEach((a, c) => { sim.cableT[c] = Tmax * Math.max(0, ph.contract + ph.bend * Math.cos(a - ph.dir * DEG)); });
      sim.setFeet('plain');
      sim.step(Math.round(4 / sim.dt));
      const short = sim.mesh.pat.cables.map((c, i) => Math.max(0, sim.cableRest[i] - sim.pathLength(c)));
      const leftMm = ((short[0] + short[3]) / 2) * opts.R_mm, rightMm = ((short[1] + short[2]) / 2) * opts.R_mm;
      return { dur: ph.dur, leftMm, rightMm, head: ph.front || false, tail: ph.rear || false };
    });
    const maxMm = Math.max(1e-6, ...phases.map((p) => Math.max(p.leftMm, p.rightMm)));
    const deg = (mm) => (mm / opts.spool_mm) / DEG;
    for (const p of phases) { p.leftDeg = deg(p.leftMm); p.rightDeg = deg(p.rightMm); }
    const maxDeg = deg(maxMm);
    const usable = opts.servoRange * 0.85;
    const spoolNeeded = maxMm / (usable * DEG);
    return { phases, maxMm, maxDeg, fits: maxDeg <= usable, spoolNeeded, spool_mm: opts.spool_mm, R_mm: opts.R_mm, anchors: gait.feet === 'anchors', feet: gait.feet };
  }

  // ---------------------------------------------------------------
  // Parts list
  // ---------------------------------------------------------------
  function bom(params, opts) {
    const o = Object.assign({ board: 'nano', anchors: false, R_mm: 30, feet: 'scales', power: 'tether', servo: 'mg90s', spool_mm: 10 }, opts || {});
    const servos = o.anchors ? 4 : 2;
    const sv = PARTS.servo[o.servo] || PARTS.servo.mg90s, onboard = o.power === 'onboard';
    const boardName = { nano: 'Arduino Nano (or Uno while tethered)', esp32: 'ESP32 DevKit (ESP32-WROOM)', pico: 'Raspberry Pi Pico (Arduino-Pico core)' }[o.board];
    const tr = trayDims(params, o);
    const rows = [
      ['Body', 'Cardstock 160–220 gsm, or 0.2 mm polypropylene sheet', '1 sheet', 'Polypropylene survives thousands of folds; card is fine for a first try'],
      ['Body', '1–2 mm card or 3D-printed plates', `${params.cells + 1}`, `n-gon, ${o.R_mm} mm corner radius, from the template`],
      ['Body', '2 mm card for the trays, plus card or foam for the servo risers', '1 sheet', `risers about ${Math.round(tr.riser)} mm tall, so the servo shafts sit level with the middle of the tail plate`],
      ['Actuation', sv.name, `${servos}`, (o.anchors ? '2 pull the cable pairs, 2 lower the anchor feet. ' : 'one pulls the left cable pair, one the right. ') + (o.servo === 'sg90' ? 'Cheaper and lighter; plastic gears can strip if a cable jams.' : 'Metal gears and more torque than an SG90; worth it on the large spools.')],
      ['Actuation', 'Braided fishing line, 0.2–0.3 mm (PE)', '2 m', 'four cables plus knots and spool wraps; braided line barely stretches'],
      ['Actuation', 'Spools', '2', `discs of ${o.spool_mm} mm radius, glued to the servo horns (print, laser-cut, or stack card)`],
      ['Feet', o.feet === 'scales' ? 'Climbing-skin strip, or angled toothbrush bristles' : o.feet === 'anchors' ? 'Rubber pads (bike inner tube)' : 'Plain card', '2 trays', o.feet === 'scales' ? 'under both trays, hairs leaning toward the tail so the robot slides forward only' : 'grip when pressed down by the anchor servo'],
      ['Electronics', boardName, '1', onboard ? 'rides on the head tray' : 'stays on the table, wired to the robot'],
    ];
    if (onboard) rows.push(
      ['Electronics', PARTS.lipo.name, '1', 'about 17 g; a protection circuit and a JST connector. Check the JST polarity with a meter before plugging anything in: LiPo plugs are not all wired the same way.'],
      ['Electronics', 'TP4056 USB LiPo charger module', '1', 'charges at 1 A as sold, too fast for this cell: change its R_PROG resistor to 3 kΩ (about 400 mA). Charge off the robot, never unattended.'],
      ['Electronics', PARTS.boost.name, '1', 'rated by its output current, not its chip. Adjustable ones often ship set above 5 V: set it to 5.0 V with a multimeter before connecting anything.'],
      ['Electronics', 'Slide or toggle switch rated 3 A or more', '1', 'between the battery and the boost converter; tiny switches are rated for 0.3 A'],
      ['Electronics', '470–1000 µF electrolytic capacitor, 10 V or more', '2', 'one across 5 V at the servos, one at the board'],
      ['Electronics', '2-pin header and jumper (the "5V link")', '1', "in the wire to the board's 5V pin; pull it whenever USB is plugged in"],
      ['Electronics', 'Thin flexible wire (silicone, 26–28 AWG)', '1 m', 'runs along the body from the head tray to the servos; leave slack so the body can fold'],
    ); else rows.push(
      ['Electronics', '4× AA NiMH holder (4.8 V), NiMH cells only', '1', "never alkaline: four fresh alkalines give 6.4 V, too much for the board's 5V pin. (USB power banks often switch off at this low current.)"],
      ['Electronics', '470 µF electrolytic capacitor, 10 V or more', '1', 'across the servo supply, absorbs current spikes'],
      ['Electronics', '2-pin header and jumper (the "5V link")', '1', "in the wire from battery + to the board's 5V pin; pull it whenever USB is plugged in"],
      ['Electronics', 'Jumper wires, small breadboard, servo extension leads', '1 set', 'keep the board and battery on the table at first (tethered)'],
    );
    rows.push(['Tools', 'Craft knife, metal ruler, empty ballpoint pen (scoring), tacky glue, hot glue or double-sided foam tape, kitchen scale (0.1 g), multimeter', '', 'the scale checks the weight estimate; the meter sets and checks voltages']);
    return rows;
  }

  // ---------------------------------------------------------------
  // Arduino sketch generated from the gait
  // ---------------------------------------------------------------
  function arduinoSketch(plan, opts) {
    const o = Object.assign({ board: 'nano', name: 'gait' }, opts || {});
    const esp = o.board === 'esp32';
    const pins = esp ? { L: 18, R: 19, H: 21, T: 22 } : o.board === 'pico' ? { L: 2, R: 3, H: 4, T: 5 } : { L: 9, R: 10, H: 5, T: 6 };
    const P = plan.phases;
    const arr = (f) => P.map(f).join(', ');
    return `// Crease Lab: origami crawler controller (${o.name})
// Generated from the simulator. Servo angles come from the cable stroke the
// sim predicted for each phase, wound onto a ${plan.spool_mm} mm spool.
// Board: ${esp ? 'ESP32 (install the "ESP32Servo" library)' : o.board === 'pico' ? 'Raspberry Pi Pico with the Arduino-Pico core' : 'Arduino Nano / Uno'}
//
// Pull the 5V link before plugging in USB, so the laptop never powers the servos.
// Serial monitor (115200): p = pause/resume, n = next phase, z = go to zero
// (slack cables) so you can tie the cables, + / - = scale all strokes.

#include <${esp ? 'ESP32Servo.h' : 'Servo.h'}>

const int PIN_LEFT = ${pins.L};    // pulls the left cable pair
const int PIN_RIGHT = ${pins.R};   // pulls the right cable pair
${plan.anchors ? `const int PIN_HEAD = ${pins.H};    // lowers the head anchor foot
const int PIN_TAIL = ${pins.T};    // lowers the tail anchor foot
` : ''}
// Calibrate: the servo angle where each cable is just slack.
int LEFT_ZERO = 10;
int RIGHT_ZERO = 170;     // the right servo is mirrored, so it winds the other way
const int LEFT_DIR = +1;
const int RIGHT_DIR = -1;
${plan.anchors ? `const int ANCHOR_UP = 20, ANCHOR_DOWN = 100;   // tune so a lowered foot lifts the end off its skid
` : ''}
const int N_PHASES = ${P.length};
const unsigned long PHASE_MS[N_PHASES] = { ${arr((p) => Math.round(p.dur * 1000))} };
const float LEFT_DEG[N_PHASES] = { ${arr((p) => f1(p.leftDeg))} };   // ${arr((p) => f1(p.leftMm) + ' mm')}
const float RIGHT_DEG[N_PHASES] = { ${arr((p) => f1(p.rightDeg))} };  // ${arr((p) => f1(p.rightMm) + ' mm')}
${plan.anchors ? `const bool HEAD_GRIP[N_PHASES] = { ${arr((p) => (p.head ? 'true' : 'false'))} };
const bool TAIL_GRIP[N_PHASES] = { ${arr((p) => (p.tail ? 'true' : 'false'))} };
` : ''}const unsigned long RAMP_MS = 600;   // ease between phases like the simulator does

Servo sLeft, sRight${plan.anchors ? ', sHead, sTail' : ''};
int phase = 0;
unsigned long phaseStart = 0, lastMs = 0;
bool paused = false, zeroing = false;
float strokeScale = 1.0;
float curL = 0, curR = 0;              // what the servos are actually told, in degrees from zero
const float MAX_DEG_PER_S = 200;       // no servo ever jumps: every move is speed-limited

float smooth(float w) { w = constrain(w, 0.0f, 1.0f); return w * w * (3 - 2 * w); }

// largest stroke in the gait, used to stop '+' from driving a servo into its end stop
float maxStroke() { float m = 0; for (int i = 0; i < N_PHASES; i++) { if (LEFT_DEG[i] > m) m = LEFT_DEG[i]; if (RIGHT_DEG[i] > m) m = RIGHT_DEG[i]; } return m; }
bool scaleOk(float sc) {
  float m = maxStroke() * sc;
  float l = LEFT_ZERO + LEFT_DIR * m, r = RIGHT_ZERO + RIGHT_DIR * m;
  return l >= 5 && l <= 175 && r >= 5 && r <= 175;
}

void writeCables(float leftDeg, float rightDeg) {
  sLeft.write(constrain(LEFT_ZERO + LEFT_DIR * (int)(leftDeg * strokeScale), 0, 180));
  sRight.write(constrain(RIGHT_ZERO + RIGHT_DIR * (int)(rightDeg * strokeScale), 0, 180));
}

void setup() {
  Serial.begin(115200);
  sLeft.attach(PIN_LEFT);
  sRight.attach(PIN_RIGHT);
${plan.anchors ? `  sHead.attach(PIN_HEAD);
  sTail.attach(PIN_TAIL);
` : ''}  writeCables(0, 0);
  delay(1000);
  phaseStart = lastMs = millis();
}

void loop() {
  unsigned long now = millis();
  float dt = (now - lastMs) / 1000.0f; lastMs = now;
  if (Serial.available()) {
    char ch = Serial.read();
    if (ch == 'p') { paused = !paused; zeroing = false; phaseStart = now; }   // resume restarts the phase timing
    if (ch == 'n') { phase = (phase + 1) % N_PHASES; phaseStart = now; }
    if (ch == 'z') { paused = true; zeroing = true; }                    // eases the cables back to slack
    if (ch == '+') { if (scaleOk(strokeScale + 0.05f)) strokeScale += 0.05f; else Serial.println("that would drive a servo past its range"); }
    if (ch == '-') { strokeScale -= 0.05f; if (strokeScale < 0.1f) strokeScale = 0.1f; }
    Serial.print("phase "); Serial.print(phase + 1); Serial.print("  scale "); Serial.println(strokeScale);
  }
  float wantL = curL, wantR = curR;
  if (paused) { if (zeroing) { wantL = 0; wantR = 0; } }
  else {
    unsigned long t = now - phaseStart;
    if (t >= PHASE_MS[phase]) { phase = (phase + 1) % N_PHASES; phaseStart = now; t = 0; }
    int prev = (phase + N_PHASES - 1) % N_PHASES;
    float w = smooth((float)t / RAMP_MS);
    wantL = LEFT_DEG[prev] + (LEFT_DEG[phase] - LEFT_DEG[prev]) * w;
    wantR = RIGHT_DEG[prev] + (RIGHT_DEG[phase] - RIGHT_DEG[prev]) * w;
  }
  float step = MAX_DEG_PER_S * dt;
  curL += constrain(wantL - curL, -step, step);
  curR += constrain(wantR - curR, -step, step);
  writeCables(curL, curR);
  if (paused) { delay(10); return; }
${plan.anchors ? `  sHead.write(HEAD_GRIP[phase] ? ANCHOR_DOWN : ANCHOR_UP);
  sTail.write(TAIL_GRIP[phase] ? ANCHOR_DOWN : ANCHOR_UP);
` : ''}  delay(10);
}
`;
  }

  function wiringText(plan, board, power) {
    const esp = board === 'esp32', pico = board === 'pico', onboard = power === 'onboard';
    const pins = esp ? ['GPIO18', 'GPIO19', 'GPIO21', 'GPIO22'] : pico ? ['GP2', 'GP3', 'GP4', 'GP5'] : ['D9', 'D10', 'D5', 'D6'];
    const pw = esp ? '5V (VIN) pin' : pico ? 'VSYS pin' : '5V pin';
    const rows = [
      [`Left cable servo signal (orange)`, pins[0]],
      [`Right cable servo signal (orange)`, pins[1]],
    ];
    if (plan.anchors) rows.push([`Head anchor servo signal`, pins[2]], [`Tail anchor servo signal`, pins[3]]);
    if (onboard) rows.push(['LiPo +', 'switch, then boost converter IN+'], ['LiPo −', 'boost converter IN−'],
      ['Boost OUT+ (set to 5.0 V first)', 'all servo red wires, and through the 5V link to the board ' + pw], ['Boost OUT−', 'all servo brown wires and board GND (always connected)'],
      ['Capacitors', 'one across OUT+ and OUT− at the servos, one at the board (stripe to −)'],
      ['USB', 'pull the 5V link first. The battery then powers only the servos and USB powers only the board, so the laptop never feeds the servos']);
    else rows.push(['All servo red wires', 'battery +'], ['All servo brown wires', 'battery −'], ['Board ' + pw, 'battery +, through the 5V link'], ['Board GND', 'battery − (shared ground, always connected)'], ['470 µF capacitor', 'across battery + and − at the servos (stripe to −)'],
      ['USB', 'pull the 5V link first, so the laptop powers only the board and the battery powers only the servos']);
    return { rows, pins, onboard };
  }

  function readme(params, plan, tmpl, opts) {
    const o = Object.assign({ board: 'nano', gaitName: 'gait', power: 'tether', servo: 'mg90s', payload: null }, opts || {});
    const w = wiringText(plan, o.board, o.power);
    const L = params.cells, onboard = o.power === 'onboard';
    const tr = trayDims(params, { R_mm: plan.R_mm, power: o.power, board: o.board, servo: o.servo, spool_mm: plan.spool_mm });
    const clearance = tr.shaftH - plan.spool_mm;
    const pc = o.payload;
    const steps = [
      'Print the three template pages at 100% (no fit-to-page): the body on cardstock or polypropylene, plates and trays on thin card or plain paper to trace onto 1–2 mm card. Check the 50 mm bar with a ruler.',
      'Score every fold line with an empty ballpoint pen against a metal ruler. Cut the solid lines.',
      'Pre-fold: mountains (red dash-dot) away from you, valleys (blue dashed) toward you. Crease hard.',
      `Roll the strip into a tube and glue the side tab under the left edge. The labels P0…P${L} mark the rings.`,
      'Twist-collapse each cell gently a few times so the creases learn the motion, then let it spring open.',
      `Cut the ${L + 1} plates from 1–2 mm card. Pierce the four eyelet holes and smooth them (a round toothpick works), so the lines don't saw through. L = left side, R = right side when the head points away from you.`,
      `Glue the end plates P0 (tail) and P${L} (head) to the ring tabs, the dot on corner 0 at the P-label column. Fix the middle plates inside their rings with a dab of glue at each corner.`,
      `Cut the trays from 2 mm card and stick scales (climbing skin or bristles) underneath, hairs leaning toward the tail. Tray plus skin should be about ${f1(tr.padThick)} mm thick. Glue the tail tray under P0 and the head ${onboard ? 'tray' : 'pad'} under P${L}, each at its dashed line.`,
      `Make two risers about ${Math.round(tr.riser)} mm tall (stacked card, foam or a printed block) on the tail tray. Hot-glue a servo on its side on each, back to back, shafts pointing out to the left and right. Their shafts should sit about ${f1(tr.shaftH)} mm off the floor${tr.shaftH > tr.centre + 0.5 ? `, a little above the middle of the tail plate (${f1(tr.centre)} mm) so the big spools clear the floor` : ', level with the middle of the tail plate'}.`,
      `Glue a ${f1(plan.spool_mm)} mm radius spool to each servo horn. ${clearance > 3 ? `It clears the floor by about ${f1(clearance)} mm.` : `Careful: a spool this big comes within ${f1(Math.max(0, clearance))} mm of the floor. Use taller risers or a smaller robot.`}`,
      `Thread four lines from the head plate through every plate to the tail. Knot them at the head. Tie both L lines to the left spool and both R lines to the right spool, with the lines just slack. Wind each so that turning the servo away from its zero winds the line in; if it pays out instead, wrap it the other way round.`,
    ];
    if (!onboard) steps.push(
      'Wire it (below) with the board and battery on the table and servo extension leads to the robot. Pull the 5V link, plug in USB and upload crawler.ino. The battery powers the servos, USB powers the board.',
      'Open the serial monitor at 115200 and press z. Adjust LEFT_ZERO / RIGHT_ZERO in the sketch until both cable pairs are just slack, re-upload, and write the numbers down: Stage 2 reuses them.',
      'Press p to run. If the body shortens less than the simulator showed, press + to scale the strokes up (− to scale down).',
      'Weigh the robot and measure how short it gets when fully contracted. Compare with the weight estimate and the simulator (see "Closing the loop").');
    else steps.push(
      'Copy LEFT_ZERO / RIGHT_ZERO from your Stage 1 sketch into this one. They stay right as long as the spools and cables are the same.',
      'Before connecting anything to it, power the boost converter from the LiPo through the switch and set its output to 5.0 V with a multimeter.',
      'Lay the LiPo, board and boost converter on the head tray where the template shows, with double-sided foam tape.',
      'Wire it (below). Run the servo wires along the underside of the body, taped only at the plates, with a slack loop across every cell so the body can still fold.',
      'Charge the LiPo off the robot with the TP4056 module (with R_PROG changed to 3 kΩ). Never charge it unattended, and stop using it if it puffs up.',
      'To upload or use the serial monitor: pull the 5V link, then plug in USB. Afterwards unplug USB, put the link back and switch on: the gait starts one second later.',
      `Expect it to crawl slower than in Stage 1: the simulator predicts ${pc ? f1(100 * pc.loaded) + '% of a body length per cycle with this load' : 'a drop, since it carries the battery'}.`);
    const massRows = pc ? pc.mass.items.map((it) => `| ${it.where} | ${it.name} | ${f1(it.g)} g |`).join('\n') : '';
    return `# Origami crawler build (from Crease Lab)

${onboard ? 'Stage 2: untethered, with the board and battery riding on the head tray.' : 'Stage 1: tethered, with the board and battery on the table.'}
Design: ${L} Kresling cells, ${params.n}-sided, corner radius ${plan.R_mm} mm, twist ${params.phi}° per cell, ${params.chirality === 'same' ? 'all cells the same handedness' : 'alternating handedness'}.
Body length about ${Math.round(L * params.H * plan.R_mm)} mm. Gait: ${o.gaitName}, ${plan.phases.length} phases. Servos: ${(PARTS.servo[o.servo] || PARTS.servo.mg90s).name}.

## Files
- template-body.svg, template-plates.svg and template-trays.svg: print at 100% (${tmpl.page}). Check the 50 mm bar with a ruler.
- crawler/crawler.ino: controller. Open in the Arduino IDE.
- bom.csv: parts.
- gait.json: the gait exactly as simulated.

## Cable stroke from the simulator
Largest cable pull-in: ${f1(plan.maxMm)} mm. On a ${plan.spool_mm} mm spool that is ${f1(plan.maxDeg)}° of servo travel${plan.fits ? '.' : `, more than a hobby servo gives. Use a spool of at least ${f1(plan.spoolNeeded)} mm radius.`}

| Phase | Time | Left pull | Right pull | Left servo | Right servo${plan.anchors ? ' | Head | Tail' : ''} |
|---|---|---|---|---|---${plan.anchors ? '|---|---' : ''}|
${plan.phases.map((p, i) => `| ${i + 1} | ${p.dur} s | ${f1(p.leftMm)} mm | ${f1(p.rightMm)} mm | ${f1(p.leftDeg)}° | ${f1(p.rightDeg)}°${plan.anchors ? ` | ${p.head ? 'grip' : 'slide'} | ${p.tail ? 'grip' : 'slide'}` : ''} |`).join('\n')}
${pc ? `
## Weight
Estimated from the template areas and typical part weights: body ${f1(pc.mass.body)} g, tail tray ${f1(pc.mass.tail)} g, head ${f1(pc.mass.head)} g, ${f1(pc.mass.total)} g in all.

| Where | Part | Weight |
|---|---|---|
${massRows}

The simulator puts the tray loads on the tail and head plates and runs the gait again:
- bare body: ${f1(100 * pc.bare)}% of a body length per cycle
- with this load: ${f1(100 * pc.loaded)}% (${Math.round(100 * pc.ratio)}% of bare)
- the same weight all on the tail: ${f1(100 * pc.allTail)}%. ${onboard ? "That's why the battery and board ride at the head." : ''}
` : ''}
## Build steps
${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}

## Wiring (${o.board === 'esp32' ? 'ESP32' : o.board === 'pico' ? 'Pico' : 'Arduino Nano'}, ${onboard ? 'on board' : 'tethered'})
${w.rows.map((r) => `- ${r[0]} → ${r[1]}`).join('\n')}

## Closing the loop with the simulator
Measure the real body length fully contracted and compare with the simulator's "Length" readout. If the real robot is stiffer, raise Crease stiffness in the Move tab until they match, then re-export. Weigh the robot too: if it is much heavier than the estimate above, the payload check is optimistic. That calibrated sim is what you train gaits on.
`;
  }

  function bomCSV(rows) {
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    return ['Group,Part,Qty,Notes', ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n';
  }


  // ---------------------------------------------------------------
  // Real parts: sizes (mm) and weights (g) used for trays, the weight estimate and the payload check.
  // Typical catalogue values; weigh your own parts if you can.
  // ---------------------------------------------------------------
  const PARTS = {
    servo: { sg90: { name: 'Micro servo SG90', g: 9, len: 32.3, hgt: 22.5, thick: 12.2, torque_kgcm: 1.8 },
             mg90s: { name: 'Micro servo MG90S (metal gears)', g: 13.4, len: 32.3, hgt: 22.5, thick: 12.2, torque_kgcm: 2.2 } },
    board: { nano: { name: 'Arduino Nano', g: 7, w: 18, l: 45 }, esp32: { name: 'ESP32 DevKit', g: 10, w: 28, l: 52 }, pico: { name: 'Raspberry Pi Pico', g: 3, w: 21, l: 51 } },
    // a micro servo can draw 0.7–1 A at stall, so batteries and converters are sized for the peaks
    lipo: { name: '1S LiPo 3.7 V 750 mAh, 20C or more, with protection board', g: 17, w: 30, l: 48 },
    lipo3: { name: '1S LiPo 3.7 V 1000 mAh, 20C or more, with protection board', g: 25, w: 30, l: 52 },
    boost: { name: '5 V boost converter, 2 A continuous at the 5 V output', g: 4, w: 17, l: 22 },
    boost3: { name: '5 V boost converter, 3 A continuous at the 5 V output', g: 5, w: 17, l: 25 },
    small: { name: 'switch, capacitors, 5V link, wires', g: 7 },
    spool: 2, riser: 1.5, cardstock_gsm: 200, plate_g_cm2: 0.12, skin_g_cm2: 0.05,
  };
  function trayDims(params, opts) {
    const o = Object.assign({ R_mm: 30, power: 'tether', board: 'nano', servo: 'mg90s', spool_mm: 0 }, opts || {});
    const R = o.R_mm, n = params.n, flats = 2 * R * Math.cos(PI / n), under = 0.45 * params.H * R;
    const sv = PARTS.servo[o.servo] || PARTS.servo.mg90s;
    // two servos lie on their sides behind the tail plate, back to back, shafts pointing out left and right
    const sl = sv.len + 4;
    const tail = { len: sl + under, plateAt: sl, boxes: [
      // drawn from above with the head to the right, so the robot's left is at the top of the page
      { x: 2, y: flats / 2 - sv.hgt - 0.5, w: sv.len, h: sv.hgt, label: 'left servo' },
      { x: 2, y: flats / 2 + 0.5, w: sv.len, h: sv.hgt, label: 'right servo' }] };
    let head;
    if (o.power === 'onboard') {
      // the board sits on top of the battery (foam tape between); the boost converter goes beside them
      const bd = PARTS.board[o.board], bt = PARTS.lipo, bs = PARTS.boost, x = under + 3;
      const stackL = Math.max(bt.l, bd.l), y0 = (flats - bt.w - bs.w - 3) / 2;
      const boxes = [
        { x, y: y0, w: stackL, h: Math.max(bt.w, bd.w), label: `LiPo, with the ${bd.name} on top` },
        { x: x + (stackL - bs.l) / 2, y: y0 + Math.max(bt.w, bd.w) + 3, w: bs.l, h: bs.w, label: 'boost' },
      ];
      const len = x + stackL + 3;
      head = { len, plateAt: under, boxes };
    } else head = { len: 2 * under, plateAt: under, boxes: [] };
    // risers: the servo shaft sits level with the middle of the tail plate, or higher if the spool
    // would otherwise come within 8 mm of the floor (the cables then rise a little into the spool)
    const centre = R * Math.cos(PI / n) + 0.18 * R;    // plate centre above the floor
    const shaftH = Math.max(centre, (o.spool_mm || 0) + 8);
    const riser = shaftH - 0.18 * R - sv.thick / 2;     // tray top is 0.18 R up (tray + skin thickness)
    return { tail, head, flats, under, riser, centre, shaftH, padThick: 0.18 * R, servo: sv, onboard: o.power === 'onboard' };
  }

  // weight of the paper body (what the simulator models) and of what sits on each tray
  function massEstimate(params, opts) {
    const o = Object.assign({ R_mm: 30, power: 'tether', board: 'nano', servo: 'mg90s', anchors: false }, opts || {});
    const t = crawlerTemplate(params, o), tr = t.trays, R = o.R_mm, n = params.n;
    const a = t.a_mm, b = t.b_mm, c = t.c_mm, sp = (a + b + c) / 2;
    const tri = Math.sqrt(Math.max(0, sp * (sp - a) * (sp - b) * (sp - c)));
    const stripArea = 2 * n * params.cells * tri * 1.1;                // +10% for glue tabs, mm^2
    const plateArea = 0.5 * n * t.plateR_mm * t.plateR_mm * Math.sin((2 * PI) / n);
    const paper = (stripArea / 1e6) * PARTS.cardstock_gsm, plates = ((params.cells + 1) * plateArea / 100) * PARTS.plate_g_cm2;
    const trayG = (len) => (len * tr.flats / 100) * (PARTS.plate_g_cm2 * 0.6 + PARTS.skin_g_cm2);
    const sv = tr.servo, items = [];
    const add = (where, name, g) => { items.push({ where, name, g }); return g; };
    const body = add('body', 'paper strip', paper) + add('body', 'plates', plates);
    let tail = add('tail', '2 × ' + sv.name, 2 * sv.g) + add('tail', 'spools and horns', 2 * PARTS.spool) + add('tail', 'risers', 2 * PARTS.riser) + add('tail', 'tail tray and skin', trayG(tr.tail.len));
    let head = add('head', tr.onboard ? 'head tray and skin' : 'head foot pad', trayG(tr.head.len));
    if (o.anchors) { tail += add('tail', 'tail anchor servo', sv.g); head += add('head', 'head anchor servo', sv.g); }
    if (tr.onboard) {
      head += add('head', PARTS.board[o.board].name, PARTS.board[o.board].g) + add('head', 'LiPo 750 mAh', PARTS.lipo.g)
        + add('head', 'boost converter', PARTS.boost.g) + add('head', PARTS.small.name, PARTS.small.g);
    }
    return { body, tail, head, total: body + tail + head, items };
  }

  // simulate the gait with the tray loads added at the tail and head plates
  class LoadedRobotSim extends CL.RobotSim {
    forces() { super.forces(); if (this.load) for (const [i, g] of this.load) this.f[3 * i + 2] -= g; }
  }
  function crawlWithLoad(params, gait, tailFrac, headFrac, stiff, cycles) {
    const pat = CL.buildCrawlerPattern(params);
    const sim = CL.buildMesh(pat, Object.assign({ axial: 50, fold: 0.12, facet: 0.12 }, stiff || {}, { SimClass: LoadedRobotSim }));
    const W = sim.g * sim.N;
    sim.load = pat.rear.map((i) => [i, (tailFrac * W) / pat.rear.length]).concat(pat.front.map((i) => [i, (headFrac * W) / pat.front.length]));
    sim.step(Math.round(1.5 / sim.dt)); sim.time = 0; sim.work = 0;
    sim.tensionScale = CL.tensionScaleFor(sim);
    const pl = new CL.GaitPlayer(gait), P = pl.period();
    let t = 0; const go = (T) => { while (t < T) { pl.apply(sim, t); sim.step(5); t += 5 * sim.dt; } };
    go(P); const c0 = sim.com(); go(P * (cycles + 1)); const c1 = sim.com();
    return ((c1[0] - c0[0]) / cycles) / sim.bodyLength;
  }
  function payloadCheck(params, gait, opts) {
    const o = Object.assign({ stiff: null, cycles: 3 }, opts || {});
    const m = o.mass || massEstimate(params, o);
    const tf = m.tail / m.body, hf = m.head / m.body;
    const bare = crawlWithLoad(params, gait, 0, 0, o.stiff, o.cycles);
    const loaded = crawlWithLoad(params, gait, tf, hf, o.stiff, o.cycles);
    // the same total weight, all on the tail: shows why the electronics go at the head
    const allTail = crawlWithLoad(params, gait, tf + hf, 0, o.stiff, o.cycles);
    return { mass: m, tailFrac: tf, headFrac: hf, bare, loaded, allTail, ratio: bare > 1e-4 ? loaded / bare : 0 };
  }

  // ---------------------------------------------------------------
  // Minimal zip writer (stored, no compression)
  // ---------------------------------------------------------------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(e.buffer)];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }

  const API = { crawlerTemplate, sheetTemplate, servoPlan, bom, bomCSV, arduinoSketch, wiringText, readme, makeZip, crc32, PARTS, trayDims, massEstimate, payloadCheck, LoadedRobotSim };
  Object.assign(CL, API);
  if (typeof module !== 'undefined' && module.exports) module.exports = CL;
})(typeof window !== 'undefined' ? window : globalThis);
