// ===== Crease Lab module kit: template, parts, wiring and code for fold modules =====
// One module on its own (the fold test), or N in a row (the crawler), powered by servos, shape-memory
// wire or shape-memory springs. Loads after module.js. Works in the browser and in node.
(function (root) {
  'use strict';
  let CL;
  if (typeof module !== 'undefined' && module.exports) CL = require('./module.js');
  else CL = root.CreaseLab;
  const PI = Math.PI, DEG = PI / 180, MM = 1e-3;
  const f0 = (v) => String(Math.round(v)), f1 = (v) => (Math.round(v * 10) / 10).toFixed(1), f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const KIND_NAME = { servo: 'servo and thread', wire: 'shape-memory wire', spring: 'shape-memory spring' };

  function pins(board) {
    // PWM-capable outputs for up to six modules, plus a start button
    return board === 'esp32' ? { out: [25, 26, 27, 32, 33, 13], names: ['GPIO25', 'GPIO26', 'GPIO27', 'GPIO32', 'GPIO33', 'GPIO13'], btn: 23, btnName: 'GPIO23', logic: 3.3 }
      : board === 'pico' ? { out: [2, 3, 4, 5, 6, 7], names: ['GP2', 'GP3', 'GP4', 'GP5', 'GP6', 'GP7'], btn: 8, btnName: 'GP8', logic: 3.3 }
      : { out: [3, 5, 6, 9, 10, 11], names: ['D3', 'D5', 'D6', 'D9', 'D10', 'D11'], btn: 4, btnName: 'D4', logic: 5 };
  }
  const BOARD_NAME = { nano: 'Arduino Nano / Uno', esp32: 'ESP32 DevKit', pico: 'Raspberry Pi Pico (Arduino-Pico core)' };

  // ---------------------------------------------------------------
  // The plan: everything the files need, worked out once from the simulator
  // ---------------------------------------------------------------
  function modulePlan(p, opts) {
    const o = Object.assign({ build: 'one', modules: 3, gait: 'wave', board: 'nano', feet: 'directional' }, opts || {});
    const N = o.build === 'one' ? 1 : Math.max(1, Math.min(6, Math.round(o.modules))), kind = p.actuator;
    const q = o.build === 'one' ? p : CL.chainModule(p, false);
    const test = o.build === 'one' ? CL.foldTest(q) : CL.foldTest(q, { stop: p.arch });
    const tm = CL.chainTiming(q, test);
    const m = CL.mountOf(p);
    const act = test.act;
    const plan = { kind, N, build: o.build, gait: o.gait, feet: o.feet, board: o.board, p, q, m, test, timing: tm, act, notes: [] };
    plan.lag = o.gait === 'together' ? 0 : tm.onS * 0.6;
    if (kind === 'servo') {
      plan.servoDeg = Math.min(175, act.phiFold / DEG);
      plan.spoolMm = p.spool;
      plan.peakA = N * act.sv.stallA;     // what the supply must survive if every servo stalls
      plan.supplyA = Math.max(2, Math.ceil(plan.peakA * 1.25));
    } else {
      plan.drive = act.drive; plan.R = act.R; plan.Ipk = act.Ipk; plan.V = p.V;
      plan.wireLen = act.wireLen / MM;
      // how many folds heat at once: all of them together, or in a wave, the ones whose on-times overlap
      const lag = o.gait === 'together' ? 0 : tm.onS * 0.6, overlap = lag > 0 ? Math.min(N, Math.ceil(tm.onS / lag)) : N;
      plan.peakA = overlap * act.Ipk;
      plan.coolMs = Math.round(Math.max(1000, (test.openS || 3) * 1000));
      plan.Rs = act.Rs; plan.RsW = [0.25, 0.5, 1, 2, 3, 5].find((w) => w >= 2 * act.Ipk * act.Ipk * act.Rs) || 10;
      plan.fuseA = [0.5, 0.75, 1.1, 1.6, 2, 2.5, 3, 4, 5, 7].find((f) => f >= 1.25 * plan.peakA) || 10;
      plan.heatPwm = Math.round(act.drive.heat * 255); plan.holdPwm = Math.round(act.drive.hold * 255);
      if (plan.holdPwm < 8) plan.notes.push('The holding power is below 3%, too coarse to set accurately: use a longer wire or a lower supply voltage.');
      if (act.drive.underpowered) plan.notes.push('This supply can\'t reach the rated current through this much wire: it heats slowly. Use the higher voltage or a shorter or thicker wire.');
      // where the wire goes: across A–B, then straight back along the fixed panel, round one 10 mm post,
      // or (on the test rig only) off the panel's back edge to the base board
      if (kind === 'wire') {
        const L0 = CL.span(0, m.s1 * MM, m.s2 * MM, m.e * MM).L / MM, extra = Math.max(0, q.wireL - L0);
        const run = Math.max(6, p.a - m.s1 - (N > 1 ? m.s2 + 3 : 4));
        const cap = 2 * run - 2 * 5 - 2 + PI * 5;   // out to a 10 mm post and back, as the template draws it
        plan.route = extra <= run ? { kind: 'straight', extra } : extra <= cap ? { kind: 'post', extra } : o.build === 'one' ? { kind: 'off', extra, off: extra - (p.a - m.s1 - 4) } : { kind: 'nofit', extra, over: extra - cap };
        if (plan.route.kind === 'nofit') plan.notes.push(`${f0(plan.route.over)} mm of wire doesn't fit on a panel. Use longer panels or a smaller arch angle.`);
      }
    }
    if (kind === 'servo') {
      if (act.phiFold / DEG > 165) plan.notes.push('The fold needs more servo travel than the servo has: use a bigger spool.');
    }
    if (o.build !== 'one') {
      const c = CL.chainTest(p, { modules: N, gait: o.gait, feet: o.feet, cycles: 3, timing: tm, trace: false });
      plan.crawl = c;
    }
    return plan;
  }

  // ---------------------------------------------------------------
  // Template: A4 landscape, true size in mm. Printed side = the inside of every fold.
  // ---------------------------------------------------------------
  function moduleTemplate(plan) {
    const { p, q, m, N, kind } = plan, a = p.a, w = p.w, P = N + 1;
    const W = 297, H = 210, M = 10;
    const perRow = Math.max(2, Math.floor((W - 2 * M - 10) / a)), rows = Math.ceil(P / perRow);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`;
    s += `<rect width="${W}" height="${H}" fill="#fff"/>`;
    s += `<text x="${M}" y="${M + 4}" font-size="5" font-weight="bold">Crease Lab fold module${N > 1 ? 's: crawler of ' + N : ''} (${esc(KIND_NAME[kind])})</text>`;
    s += `<text x="${M}" y="${M + 10}" font-size="3.2">Print at 100% (no "fit to page"); the square must measure 20 mm. ${p.gsm} gsm card. Cut solid lines, score and fold dashed lines. This side is the inside of every fold.</text>`;
    s += `<rect x="${W - M - 20}" y="${M}" width="20" height="20" fill="none" stroke="#000" stroke-width="0.3"/><text x="${W - M - 10}" y="${M + 11.5}" font-size="3" text-anchor="middle">20 mm</text>`;
    const y0 = M + 18, rowH = w + 16;
    const crease = [];
    for (let r = 0; r < rows; r++) {
      const first = r * perRow, last = Math.min(P, first + perRow) - 1, n = last - first + 1;
      const x0 = M, y = y0 + r * rowH;
      s += `<rect x="${x0}" y="${y}" width="${n * a}" height="${w}" fill="none" stroke="#000" stroke-width="0.35"/>`;
      if (r < rows - 1) s += `<path d="M${x0 + n * a} ${y} l8 2 v${w - 4} l-8 2" fill="none" stroke="#000" stroke-width="0.35"/><text x="${x0 + n * a + 4}" y="${y + w / 2}" font-size="2.6" text-anchor="middle" transform="rotate(90 ${x0 + n * a + 4} ${y + w / 2})">glue under row ${r + 2}</text>`;
      for (let i = first; i <= last; i++) {
        const xi = x0 + (i - first) * a;
        s += `<text x="${xi + a / 2}" y="${y + w + 4.5}" font-size="2.8" text-anchor="middle" fill="#555">panel ${i}</text>`;
        if (i > first) { s += `<line x1="${xi}" y1="${y}" x2="${xi}" y2="${y + w}" stroke="#1f5fd1" stroke-width="0.35" stroke-dasharray="2 1.2"/>`; crease.push([xi, y, i]); }
      }
      if (r > 0) crease.push([x0, y, first]);   // the crease that falls on the joint between rows
    }
    // each hinge: the anchors and whatever pulls
    const cy = (y) => y + w / 2;
    for (const [x, y, i] of crease) {
      const ax = x - m.s1, bx = x + m.s2, yy = cy(y);
      const k = i;   // hinge k sits between panel k-1 and panel k
      s += `<text x="${x}" y="${y - 1.5}" font-size="2.8" text-anchor="middle" fill="#1f5fd1">fold ${k}</text>`;
      s += `<circle cx="${ax}" cy="${yy}" r="1.3" fill="none" stroke="#d1453b" stroke-width="0.35"/><text x="${ax}" y="${yy - 2.4}" font-size="2.6" text-anchor="middle" fill="#d1453b">A</text>`;
      s += `<circle cx="${bx}" cy="${yy}" r="1.3" fill="none" stroke="#d1453b" stroke-width="0.35"/><text x="${bx}" y="${yy - 2.4}" font-size="2.6" text-anchor="middle" fill="#d1453b">B</text>`;
      // the arch wedges, at both edges of the crease
      // with a servo on the panel its top edge is taken, so both wedges go on the bottom edge
      if (N > 1) {
        const marks = kind === 'servo' ? [[x - 12, y + w - 3], [x, y + w - 3]] : [[x - 12, y + 1], [x - 12, y + w - 3]];
        for (const [ex, ey] of marks) s += `<rect x="${ex}" y="${ey}" width="12" height="2" fill="#eee" stroke="#888" stroke-width="0.2"/>`;
      }
      if (kind === 'servo') {
        // the servo lies along the top edge, out of the way of the anchors on the centre line
        const sx = ax - 3 - 22.5, sy = y + 1, scx = sx + 22.5 - 6, scy = sy + 6.1;
        if (sx >= x - a + 0.5) {
          s += `<rect x="${sx}" y="${sy}" width="22.5" height="12.2" fill="none" stroke="#888" stroke-width="0.3" stroke-dasharray="1 0.8"/>`;
          s += `<circle cx="${scx}" cy="${scy}" r="${q.spool}" fill="none" stroke="#888" stroke-width="0.25"/>`;
          s += `<text x="${sx + 7}" y="${scy + 1}" font-size="2.4" text-anchor="middle" fill="#666">servo</text>`;
          s += `<line x1="${scx}" y1="${scy + q.spool}" x2="${ax}" y2="${yy}" stroke="#e8892b" stroke-width="0.3"/>`;
          if (w < 28) s += `<text x="${x - a / 2}" y="${y + w + 8}" font-size="2.4" text-anchor="middle" fill="#a33">the servo is wider than half the panel: it overhangs the edge</text>`;
        } else s += `<text x="${x - a / 2}" y="${yy + 6}" font-size="2.4" text-anchor="middle" fill="#a33">servo doesn't fit on this panel: mount it beside the strip</text>`;
        s += `<line x1="${ax}" y1="${yy}" x2="${bx}" y2="${yy}" stroke="#e8892b" stroke-width="0.3"/>`;
      } else if (kind === 'wire') {
        // the wire runs A → B across the crease, then on along the fixed panel (no tight bends: Dynalloy
        // asks for a bend radius of about 50 wire diameters, so the only turn is round a 10 mm post)
        const rt = plan.route, back = i - 1 >= 1 ? x - a + m.s2 + 3 : x - a + 4;
        let path = `M${bx} ${yy} L${ax} ${yy}`, cx = ax, cyy = yy;
        if (rt.kind === 'straight' || rt.kind === 'off') {
          cx = rt.kind === 'off' ? x - a : Math.max(back, ax - rt.extra); path += ` L${cx} ${yy}`;
          if (rt.kind === 'off') s += `<path d="M${cx} ${yy} l-6 0 m2 -1.5 l-2 1.5 l2 1.5" fill="none" stroke="#b07a1a" stroke-width="0.35"/><text x="${cx + 1}" y="${yy + 4.5}" font-size="2.3">continues ${f0(rt.off)} mm straight back, past the clamp, to a crimp on the base board</text>`;
        } else {
          const r = 5, px = back + r, run1 = ax - px;
          const left = Math.max(0, rt.extra - run1 - PI * r);
          path += ` L${px} ${yy}`;
          s += `<circle cx="${px}" cy="${yy + r}" r="${r}" fill="none" stroke="#333" stroke-width="0.3"/><text x="${px}" y="${yy + r + 1}" font-size="2" text-anchor="middle">post</text>`;
          cx = Math.min(ax - 2, px + left); cyy = yy + 2 * r;
          path = path + ` M${px} ${cyy} L${cx} ${cyy}`;
        }
        s += `<path d="${path}" fill="none" stroke="#b07a1a" stroke-width="0.35"/>`;
        if (rt.kind !== 'off') s += `<rect x="${cx - 1}" y="${cyy - 1}" width="2" height="2" fill="#333"/><text x="${cx + 1.5}" y="${cyy + 4}" font-size="2.3">crimp</text>`;
        if (rt.kind === 'nofit') s += `<text x="${x - a / 2}" y="${y + w + 8}" font-size="2.4" text-anchor="middle" fill="#a33">${f0(rt.over)} mm of wire doesn't fit on the panel: use a longer panel</text>`;
      } else {
        const Lc = q.turns * q.springD;
        s += `<path d="M${ax} ${yy} ${Array.from({ length: 10 }, (_, j) => `L${ax + ((j + 0.5) / 10) * (bx - ax)} ${yy + (j % 2 ? 1.2 : -1.2)}`).join(' ')} L${bx} ${yy}" fill="none" stroke="#b07a1a" stroke-width="0.35"/>`;
        s += `<text x="${(ax + bx) / 2}" y="${yy + 4.5}" font-size="2.3" text-anchor="middle">spring, ${f1(Lc)} mm closed</text>`;
      }
    }
    // small parts
    const py0 = y0 + rows * rowH + 2;
    s += `<text x="${M}" y="${py0}" font-size="3.4" font-weight="bold">Small parts (cut from 1–2 mm card)</text>`;
    let x = M, yP = py0 + 4;
    for (let k = 0; k < N; k++) { s += `<rect x="${x}" y="${yP}" width="10" height="${Math.min(14, w * 0.45)}" fill="none" stroke="#000" stroke-width="0.3"/>`; x += 13; }
    s += `<text x="${x}" y="${yP + 5}" font-size="2.6">stop tab ×${N}: glue on the outside of the fixed panel, half over the crease, so the fold can't bend backwards</text>`;
    if (N > 1) {
      yP += 18; x = M;
      const h = 12 * Math.tan(p.arch * DEG);
      for (let k = 0; k < 2 * N; k++) { s += `<path d="M${x} ${yP + h} h12 L${x} ${yP} Z" fill="none" stroke="#000" stroke-width="0.3"/>`; x += 15; }
      s += `<text x="${x}" y="${yP + h / 2 + 1}" font-size="2.6">arch wedge ×${2 * N} (${p.arch}°): glue upright on the grey marks, the tall end at the crease</text>`;
    }
    const tip = kind === 'servo' ? 'Thread: tie at B, through an eyelet at A (a 3 mm loop of wire on a ' + m.e + ' mm post), then to the spool.'
      : kind === 'wire' ? `Wire: ${f0(q.wireL)} mm of ${q.wireD} mm Flexinol per fold, crimped at B and at the crimp, over ${m.e} mm card posts at A and B${plan.route.kind === 'post' ? ' and round the 10 mm card post' : ''}. No sharp bends, and never solder it.`
        : `Spring: hook its ends on ${m.e} mm posts at A and B. It is a coil of ${q.springD} mm wire, about ${q.coilD} mm across, ${q.turns} turns.`;
    s += `<text x="${M}" y="${H - M - 6}" font-size="2.8">${esc(tip)}</text>`;
    s += `<text x="${M}" y="${H - M - 1.5}" font-size="2.8">Return band: a small rubber band on the back, hooked on posts behind A and B (preload about ${f1(m.band)} N: stretch it until it just starts to pull).</text>`;
    s += '</svg>';
    return s;
  }

  // ---------------------------------------------------------------
  // Parts
  // ---------------------------------------------------------------
  function moduleBom(plan) {
    const { p, q, N, kind, board } = plan, P = CL.PARTS;
    const rows = [
      ['Body', `Cardstock ${p.gsm} gsm`, '1 sheet', 'the panels (template page)'],
      ['Body', '1–2 mm card (cereal box is fine)', 'a scrap', N > 1 ? 'stop tabs and arch wedges' : 'stop tab'],
      ['Body', 'Small rubber bands', `${N}`, 'the return band on the back of each fold'],
      ['Body', kind === 'servo' ? 'Posts: drinking straw, or rolled card' : 'Posts: rolled card tubes (no plastic: the SMA gets hot)', `${2 * N + 2 * N}`, `${plan.m.e} mm tall: anchors A and B on the inside, band hooks on the back`],
    ];
    if (N > 1) rows.push(['Feet', 'Climbing-skin strip, or angled bristles', `${N + 2}`, 'under every crease and both ends, hairs leaning toward the tail, so it slides forward easily and not back']);
    rows.push(['Electronics', BOARD_NAME[board], '1', 'tethered to your laptop by USB']);
    rows.push(['Electronics', 'Pushbutton', '1', 'the start button, between its pin and GND']);
    if (kind === 'servo') {
      const sv = P.servo[p.servo] || P.servo.sg90;
      rows.push(['Actuation', sv.name, `${N}`, 'one per fold, on the panel behind the crease']);
      rows.push(['Actuation', 'Braided fishing line, 0.2–0.3 mm (PE)', `${N * 15} cm`, 'one thread per fold']);
      rows.push(['Actuation', 'Spool', `${N}`, `${p.spool} mm radius, glued to each servo horn`]);
      rows.push(['Power', plan.supplyA <= 2 ? '4× AA NiMH pack (4.8 V) or a 5 V 2 A supply' : `5 V supply, ${plan.supplyA} A or more (a boost converter rated for it, or a bench supply)`, '1', `servos never run from the board's 5V pin; ${N} stalling servos can pull ${f1(plan.peakA)} A`]);
      rows.push(['Power', '470 µF 10 V capacitor', '1', 'across + and − at the servos']);
    } else {
      const wire = kind === 'wire';
      rows.push(['Actuation', wire ? `Flexinol (Nitinol) actuator wire, ${q.wireD} mm, 70 °C (LT)` : `Nitinol actuator spring, ${q.springD} mm wire, about ${q.coilD} mm coil, ${q.turns}+ turns`,
        wire ? `${f0(N * (q.wireL + 30))} mm` : `${N}`, wire ? `${f0(q.wireL)} mm per fold plus 15 mm at each end for crimping` : 'one per fold; check the seller\'s current rating and activation temperature (70 °C or lower)']);
      rows.push(['Actuation', 'Crimp tubes or ferrules, 1 mm', `${2 * N}`, 'crimp the SMA ends. Solder doesn\'t stick to Nitinol and the heat can ruin it']);
      if (wire && plan.route.kind === 'post') rows.push(['Actuation', 'Round post, 10 mm across (a rolled card tube)', `${N}`, 'the one place the wire turns. Tighter bends wear it out']);
      if (wire && plan.route.kind === 'off') rows.push(['Body', 'Base board (stiff card or plywood) and a clamp', '1', 'the fixed panel is clamped to it, and the wire\'s far end is crimped to it']);
      if (plan.Rs > 0) rows.push(['Switching', `${plan.Rs} Ω resistor, ${plan.RsW} W`, `${N}`, `in series with each ${wire ? 'wire' : 'spring'}, so fully on it carries only its rated ${f2(plan.Ipk)} A. It gets warm`]);
      rows.push(['Switching', pins(board).logic > 4 ? 'Logic-level N-MOSFET, IRLZ44N' : 'N-MOSFET with Rds(on) given at 2.5 V gate, e.g. AO3400A on a breakout', `${N}`, `one per fold; each switches up to ${f1(plan.Ipk)} A`]);
      rows.push(['Switching', '220 Ω and 10 kΩ resistors', `${N} of each`, '220 Ω from the pin to the gate, 10 kΩ from gate to ground so it stays off while the board boots']);
      rows.push(['Power', p.V < 4.5 ? `1S LiPo 3.7 V, 500 mAh or more, with protection board, rated ${f1(Math.max(1, plan.peakA))} A or more` : `5 V wall or bench supply, ${f1(Math.max(1, plan.peakA * 1.25))} A or more (not a power bank: they switch off when the current is low)`, '1', `${f1(plan.peakA)} A when ${N === 1 ? 'it heats' : plan.gait === 'together' ? 'all folds heat at once' : 'the folds that overlap in the wave heat together'}. Never from the board's own 5V or 3V3 pin`]);
      rows.push(['Power', `Slide switch, and a ${plan.fuseA} A polyfuse (PTC)`, '1 each', 'in the + lead from the battery']);
    }
    rows.push(['Wiring', 'Thin silicone wire, jumpers, breadboard', '', 'enough to reach the modules']);
    return rows;
  }

  // ---------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------
  function moduleWiring(plan) {
    const { N, kind, board } = plan, pn = pins(board), rows = [];
    if (kind === 'servo') {
      for (let k = 0; k < N; k++) rows.push([`Fold ${k + 1} servo signal (orange)`, pn.names[k]]);
      rows.push(['Start button', pn.btnName + ' and GND']);
      rows.push(['Servo red wires', 'supply +']);
      rows.push(['Servo brown wires', 'supply − and board GND (shared ground)']);
      rows.push(['Capacitor', 'across supply + and − at the servos (stripe to −)']);
      rows.push(['Board', 'USB from the laptop. Do not connect supply + to the board']);
    } else {
      for (let k = 0; k < N; k++) rows.push([`Fold ${k + 1} MOSFET gate`, `${pn.names[k]} through 220 Ω, and 10 kΩ to GND`]);
      rows.push(['Start button', pn.btnName + ' and GND']);
      rows.push(['Battery + ', `switch, then the ${plan.fuseA} A polyfuse, then ${plan.Rs > 0 ? `a ${plan.Rs} Ω resistor to ` : ''}one end of every SMA ${kind === 'wire' ? 'wire' : 'spring'}${plan.Rs > 0 ? ' (one resistor each)' : ''}`]);
      rows.push(['Other end of each SMA', 'its MOSFET drain (D)']);
      rows.push(['Every MOSFET source (S)', 'battery − and board GND (shared ground)']);
      rows.push(['Board', 'USB from the laptop. Battery + never goes to the board']);
    }
    return { rows, pins: pn.names.slice(0, N) };
  }

  function moduleWiringSvg(plan) {
    const { N, kind, board } = plan, pn = pins(board);
    const SIG = '#e8892b', POS = '#d1453b', NEG = '#7a5a3a', SMA_C = '#b07a1a';
    const rowH = N > 4 ? 30 : 36, H = Math.max(230, 40 + N * rowH + 46);
    const txt = (x, y, t, anchor, ink) => `<text x="${x}" y="${y}" text-anchor="${anchor || 'start'}"${ink ? ' style="fill:var(--ink);font-size:11px;font-family:var(--font-body)"' : ''}>${t}</text>`;
    const box = (x, y, bw, bh) => `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="6" fill="var(--panel)" stroke="var(--line)" stroke-width="1.2"/>`;
    const line = (pts, c, dash) => `<polyline points="${pts.map((q) => q.join(',')).join(' ')}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"${dash ? ' stroke-dasharray="4 3"' : ''}/>`;
    let g = box(10, 14, 100, 60) + txt(60, 38, { nano: 'Arduino Nano', esp32: 'ESP32 DevKit', pico: 'Pi Pico' }[board], 'middle', true) + txt(60, 54, 'USB to laptop', 'middle');
    const supply = kind === 'servo' ? (N > 2 ? '5 V 3 A supply' : '4× AA (4.8 V)') : (plan.V < 4.5 ? 'LiPo → switch → fuse' : '5 V supply → fuse');
    const by = H - 58;
    g += box(10, by, 120, 40) + txt(70, by + 17, supply, 'middle', true) + txt(70, by + 31, kind === 'servo' ? 'servo power' : `${plan.V} V for the SMA`, 'middle');
    const busP = 230, busN = 244, x1 = 262;
    g += line([[40, by], [40, 74]], NEG, true) + txt(46, by - 6, 'GND only', 'start');
    g += txt(12, 88, `button: ${pn.btnName} to GND`, 'start');
    if (kind !== 'servo') g += txt(12, 100, 'each gate: 10 kΩ to GND', 'start');
    if (kind === 'servo') {
      g += line([[130, by + 12], [busP, by + 12], [busP, 26]], POS) + line([[130, by + 28], [busN, by + 28], [busN, 32]], NEG);
    } else {
      // + rail down the right edge, − rail beside the MOSFETs; each row: gate → FET, SMA from + to the drain
      const RP = 344, RN = 176, top = 22, bot = 22 + (N - 1) * rowH + 12;
      g += line([[130, by + 12], [RP, by + 12], [RP, top + 2]], POS) + line([[130, by + 28], [RN, by + 28], [RN, top + 18]], NEG);
      for (let k = 0; k < N; k++) {
        const y = top + k * rowH, mid = y + 10;
        g += line([[110, 22 + k * 7], [128 + k * 6, 22 + k * 7], [128 + k * 6, mid], [196, mid]], SIG);
        g += box(196, y, 34, 22) + txt(213, y + 15, pn.names[k], 'middle');
        if (k === 0) g += txt(213, y - 3, 'MOSFETs', 'middle');
        g += line([[205, y + 22], [205, y + 28], [RN, y + 28]], NEG);
        g += line([[230, mid], [252, mid]], SMA_C);
        g += `<path d="M252 ${mid} ${Array.from({ length: 9 }, (_, j) => `L${256 + j * 8} ${mid + (j % 2 ? 5 : -5)}`).join(' ')} L332 ${mid} L${RP} ${mid}" fill="none" stroke="${SMA_C}" stroke-width="2" stroke-linejoin="round"/>`;
        g += txt(290, y - 1, `${kind === 'wire' ? 'wire' : 'spring'} ${k + 1}${plan.Rs > 0 ? ' + ' + plan.Rs + ' Ω' : ''}`, 'middle');
        if (k === 0) g += txt(150, mid + 12, '220 Ω', 'middle');
        g += `<circle cx="${RP}" cy="${mid}" r="2.5" fill="${POS}"/><circle cx="${RN}" cy="${y + 28}" r="2.5" fill="${NEG}"/>`;
      }
      void bot;
    }
    if (kind === 'servo') {
      for (let k = 0; k < N; k++) {
        const y = 22 + k * rowH, mid = y + 12;
        g += line([[110, 24 + k * 7], [150 + k * 8, 24 + k * 7], [150 + k * 8, mid], [x1, mid]], SIG);
        g += line([[busP, mid + 6], [x1, mid + 6]], POS) + line([[busN, mid + 12], [x1, mid + 12]], NEG);
        g += box(x1, y, 88, 28) + txt(x1 + 44, y + 13, `servo ${k + 1}`, 'middle', true) + txt(x1 + 44, y + 24, pn.names[k], 'middle');
      }
      g += `<circle cx="${busP}" cy="${by + 12}" r="3" fill="${POS}"/><circle cx="${busN}" cy="${by + 28}" r="3" fill="${NEG}"/>`;
    }
    const ly = H - 8;
    if (kind === 'servo') {
      g += `<rect x="10" y="${ly - 5}" width="10" height="4" fill="${SIG}"/>` + txt(24, ly, 'signal', 'start');
      g += `<rect x="70" y="${ly - 5}" width="10" height="4" fill="${POS}"/>` + txt(84, ly, '+', 'start');
      g += `<rect x="100" y="${ly - 5}" width="10" height="4" fill="${NEG}"/>` + txt(114, ly, '− ground', 'start');
    } else {
      g += `<rect x="10" y="${ly - 5}" width="10" height="4" fill="${SIG}"/>` + txt(24, ly, 'gate', 'start');
      g += `<rect x="64" y="${ly - 5}" width="10" height="4" fill="${POS}"/>` + txt(78, ly, '+', 'start');
      g += `<rect x="94" y="${ly - 5}" width="10" height="4" fill="${NEG}"/>` + txt(108, ly, '−', 'start');
      g += `<rect x="124" y="${ly - 5}" width="10" height="4" fill="${SMA_C}"/>` + txt(138, ly, 'SMA', 'start');
    }
    return { svg: g, viewBox: `0 0 360 ${H}` };
  }

  // ---------------------------------------------------------------
  // Arduino sketch
  // ---------------------------------------------------------------
  function moduleSketch(plan) {
    const { N, kind, board, timing: tm } = plan, pn = pins(board), esp = board === 'esp32', pico = board === 'pico';
    const outs = pn.out.slice(0, N).join(', ');
    const onMs = Math.round(tm.onS * 1000), offMs = Math.round(tm.offS * 1000), lagMs = Math.round(plan.lag * 1000);
    const head = `// Crease Lab: ${N === 1 ? 'one fold module' : N + ' fold modules in a row (crawler)'}, ${KIND_NAME[kind]}
// Generated from the simulator. Board: ${BOARD_NAME[board]}${esp && kind === 'servo' ? ' (install the "ESP32Servo" library)' : ''}
//
// Serial monitor at 115200:
${N === 1 ? '//   1 = fold / unfold' : `//   1..${N} = fold / unfold that module on its own`}
//   ${N === 1 ? 'g = repeat fold-and-open' : 'g = crawl (start / stop)'}     x = stop everything${kind === 'servo' ? '\n//   + / - = fold further / less (5 degrees of servo travel)' : ''}
// The start button does the same as g.${kind === 'servo' ? '\n// At power-up each servo goes to its ZERO angle (fold flat). After that nothing moves until you ask.' : ' Nothing heats until you ask.'}
`;
    const gait = `
// Gait (seconds from the simulator: how long each fold takes to close and to open again)
const unsigned long ON_MS = ${onMs};     // keep a fold closed this long
const unsigned long OFF_MS = ${offMs};    // then let it open this long
const unsigned long LAG_MS = ${lagMs};     // ${N === 1 ? 'unused with one module' : plan.gait === 'together' ? 'all folds move together' : 'each fold starts this long after the one behind it'}
const unsigned long PERIOD_MS = ${N > 1 ? '(N_MOD - 1) * LAG_MS + ' : ''}ON_MS + OFF_MS;

bool running = false;
unsigned long runStart = 0;

// the start button, debounced: true once per press
bool btnStable = true, btnRead = true;
unsigned long btnChange = 0;
bool buttonPressed(unsigned long now) {
  bool r = digitalRead(PIN_START) == HIGH;
  if (r != btnRead) { btnRead = r; btnChange = now; }
  if (now - btnChange > 30 && r != btnStable) { btnStable = r; return !r; }
  return false;
}

bool gaitWants(int k, unsigned long now) {
  unsigned long ph = (now - runStart) % PERIOD_MS;
  unsigned long start = (unsigned long)k * LAG_MS;
  return ph >= start && ph < start + ON_MS;
}
`;
    if (kind === 'servo') {
      return head + `
#include <${esp ? 'ESP32Servo.h' : 'Servo.h'}>

const int N_MOD = ${N};
const int PIN_SERVO[N_MOD] = { ${outs} };
const int PIN_START = ${pn.btn};   // start button to GND

// Calibrate with x: each thread just slack with the fold flat. Then fold with 1 and check it
// stops at the ${N === 1 ? plan.q.target : plan.p.arch}° the simulator expects (${f1(plan.servoDeg)}° of servo travel on a ${plan.spoolMm} mm spool).
int ZERO[N_MOD] = { ${Array(N).fill(10).join(', ')} };
const int DIR = +1;                 // -1 if your servo winds the wrong way
float foldDeg = ${f1(plan.servoDeg)};
const float DEG_PER_S = 200;        // never jump: move at most this fast
${gait}
Servo sv[N_MOD];
bool want[N_MOD];
float pos[N_MOD];
unsigned long lastMs = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_START, INPUT_PULLUP);
  // make sure the fold fits every servo's range before anything moves
  for (int k = 0; k < N_MOD; k++) while (foldDeg > 0 && (ZERO[k] + DIR * foldDeg < 5 || ZERO[k] + DIR * foldDeg > 175)) foldDeg -= 1;
  for (int k = 0; k < N_MOD; k++) { want[k] = false; pos[k] = 0; sv[k].write(ZERO[k]); sv[k].attach(PIN_SERVO[k]); sv[k].write(ZERO[k]); }
  lastMs = millis();
  Serial.println("ready: 1..${N} fold, g ${N === 1 ? 'repeat' : 'crawl'}, x stop");
}

void startStop() { running = !running; runStart = millis(); if (!running) for (int k = 0; k < N_MOD; k++) want[k] = false; }

void loop() {
  unsigned long now = millis();
  float dt = (now - lastMs) / 1000.0f; lastMs = now;
  while (Serial.available()) {
    char c = Serial.read();
    if (c >= '1' && c < '1' + N_MOD) { running = false; want[c - '1'] = !want[c - '1']; }
    else if (c == 'g') startStop();
    else if (c == 'x') { running = false; for (int k = 0; k < N_MOD; k++) want[k] = false; }
    else if (c == '+' || c == '-') {
      float next = foldDeg + (c == '+' ? 5 : -5);
      bool ok = next >= 0;
      for (int k = 0; k < N_MOD; k++) { float a = ZERO[k] + DIR * next; if (a < 5 || a > 175) ok = false; }
      if (ok) foldDeg = next; else Serial.println("can't: that would go past the servo's range");
      Serial.print("fold travel "); Serial.println(foldDeg);
    }
  }
  if (buttonPressed(now)) startStop();
  for (int k = 0; k < N_MOD; k++) {
    if (running) want[k] = gaitWants(k, now);
    float goal = want[k] ? foldDeg : 0;
    float step = DEG_PER_S * dt;
    pos[k] += constrain(goal - pos[k], -step, step);
    sv[k].write((int)(ZERO[k] + DIR * pos[k] + 0.5f));
  }
  delay(10);
}
`;
    }
    const d = plan.drive;
    return head + `//
// SAFETY: the ${kind === 'wire' ? 'wire' : 'spring'} gets to about ${f0(d.Thold)} °C. Don't touch it while it runs, keep it off plastic
// (PLA softens at 60 °C), and switch the battery off when you stop. Never leave it powered unattended.

const int N_MOD = ${N};
const int PIN_GATE[N_MOD] = { ${outs} };   // MOSFET gates, each with 220 ohm in series and 10 k to GND
const int PIN_START = ${pn.btn};            // start button to GND

// Heating, from the simulator for ${f0(plan.wireLen)} mm of ${kind === 'wire' ? plan.q.wireD : plan.q.springD} mm wire (${f1(plan.R)} ohm)${plan.Rs > 0 ? ` with a ${plan.Rs} ohm resistor` : ''} on ${plan.V} V:
// fully on it carries ${f2(plan.Ipk)} A.
const int HEAT_PWM = ${plan.heatPwm};          // 0..255: power while it heats up
const unsigned long HEAT_MS = ${Math.round(d.heatS * 1000)};     // how long it heats at that power
const int HOLD_PWM = ${plan.holdPwm};          // then this much keeps it hot without cooking it
const unsigned long MAX_ON_MS = ${Math.round(d.maxS * 1000)};  // safety: never powered longer than this at a time
const unsigned long MIN_COOL_MS = ${plan.coolMs};  // and not re-heated until it has cooled this long
${gait}
bool on[N_MOD], wasOn[N_MOD];
unsigned long since[N_MOD], offAt[N_MOD];

void power(int k, int pwm) { analogWrite(PIN_GATE[k], constrain(pwm, 0, 255)); }

// returns false if it refused because the metal is still cooling
bool setFold(int k, bool want, unsigned long now) {
  if (want == on[k]) return true;
  if (want && wasOn[k] && now - offAt[k] < MIN_COOL_MS) return false;   // still cooling: try again later
  on[k] = want;
  if (want) { since[k] = now; wasOn[k] = true; } else { offAt[k] = now; power(k, 0); }
  return true;
}

void allOff(unsigned long now) { running = false; for (int k = 0; k < N_MOD; k++) setFold(k, false, now); }

void setup() {
  for (int k = 0; k < N_MOD; k++) { pinMode(PIN_GATE[k], OUTPUT); digitalWrite(PIN_GATE[k], LOW); on[k] = false; wasOn[k] = false; since[k] = 0; offAt[k] = 0; }
  pinMode(PIN_START, INPUT_PULLUP);
  Serial.begin(115200);
  Serial.println("ready: 1..${N} fold, g ${N === 1 ? 'repeat' : 'crawl'}, x stop");
}

void loop() {
  unsigned long now = millis();
  while (Serial.available()) {
    char c = Serial.read();
    if (c >= '1' && c < '1' + N_MOD) {
      running = false;
      if (!setFold(c - '1', !on[c - '1'], now)) Serial.println("still cooling, try again in a moment");
    }
    else if (c == 'g') { if (running) allOff(now); else { running = true; runStart = now; } }
    else if (c == 'x') allOff(now);
  }
  if (buttonPressed(now)) { if (running) allOff(now); else { running = true; runStart = now; } }
  for (int k = 0; k < N_MOD; k++) {
    if (running) setFold(k, gaitWants(k, now), now);
    if (!on[k]) continue;
    unsigned long t = now - since[k];
    if (t > MAX_ON_MS) { setFold(k, false, now); Serial.println("safety stop: on too long"); continue; }
    power(k, t < HEAT_MS ? HEAT_PWM : HOLD_PWM);
  }
  delay(5);
}
`;
  }

  // ---------------------------------------------------------------
  // README
  // ---------------------------------------------------------------
  function moduleReadme(plan) {
    const { N, kind, p, q, test, board } = plan, m = plan.m;
    const L = [];
    L.push(`# Crease Lab: ${N === 1 ? 'one fold module' : `a crawler of ${N} fold modules`} (${KIND_NAME[kind]})`, '');
    L.push('Generated by Crease Lab (Modules tab). The numbers come from the simulator; treat them as a starting point and tune on the real thing.', '');
    L.push('## What the simulator expects', '');
    if (N === 1) {
      L.push(`- Folds to about ${f0(test.peak)}° in ${f2(test.foldS || 0)} s, opens again in ${test.openS ? f1(test.openS) + ' s' : '(it does not open on its own: raise the band preload)'}.`);
      L.push(`- Energy per fold-and-open: ${f2(test.energy)} J. ${kind === 'servo' ? `Current: up to ${f2(test.peakI)} A.` : `Current: ${f2(plan.Ipk)} A in each PWM pulse, ${f2(plan.Ipk * plan.drive.heat)} A on average while it heats.`}`);
    } else {
      const c = plan.crawl;
      L.push(`- Each fold closes to the ${p.arch}° arch stop. Gait: ${plan.gait === 'together' ? 'all folds together' : 'a wave from tail to head'}, ${f1(c.period)} s per cycle.`);
      L.push(`- Crawls about ${f1(c.perCycle)} mm per cycle, ${f2(c.speed)} mm/s, on directional feet. Weight about ${f1(c.mass * 1000)} g plus wires.`);
      L.push(`- Energy: ${f1(c.energyPerCycle)} J per cycle. Current: up to ${f2(c.peakI)} A in total${kind === 'servo' ? '' : ` (each fold draws ${f2(plan.Ipk)} A while its power is on)`}.`);
      if (kind === 'wire') L.push(`- In the crawler each wire is ${f0(q.wireL)} mm: just long enough that its full shortening reaches the arch stop.`);
    }
    if (plan.notes.length) { L.push('', '## Check first', ''); for (const n2 of plan.notes) L.push('- ' + n2); }
    L.push('', '## Parts', '');
    for (const r of moduleBom(plan)) L.push(`- **${r[1]}** × ${r[2] || '—'}: ${r[3]}`);
    L.push('', '## Build', '');
    let n = 1;
    const step = (t) => L.push(`${n++}. ${t}`);
    step('Print `template.svg` at 100%. Check the 20 mm square with a ruler.');
    step(`Cut out the strip. Score every dashed line with a ruler and a dry ballpoint, and fold each one toward the printed side, then flatten it again.`);
    step('Glue a stop tab on the back of each fold, on the fixed panel (the lower-numbered one), half over the crease. It keeps the fold from bending backwards when the band pulls.');
    if (N > 1) step(`Glue two arch wedges upright on the grey marks at each crease, tall end at the crease. The next panel rests on them at ${p.arch}°.`);
    step(`Glue ${m.e} mm posts at A and B on the printed side, and two more on the back for the band.`);
    if (kind === 'servo') {
      step(`Glue a ${p.spool} mm spool on each servo horn and fix each servo on the fixed panel where the template shows it.`);
      step('Tie the thread at B, run it through a small wire eyelet on the A post, and wrap it twice round the spool. Upload the sketch, send x, and set ZERO so the thread is just slack with the fold flat.');
    } else if (kind === 'wire') {
      const rt = plan.route;
      step(`Cut ${f0(q.wireL + 30)} mm of wire per fold. Crimp one end at B, run it over the A post${rt.kind === 'post' ? ', round the 10 mm card post' : rt.kind === 'off' ? ', straight back past the clamp' : ''} and crimp the other end at the crimp mark${rt.kind === 'off' ? ' on the base board' : ''}, pulled straight but not stretched. Never bend it tighter than that: sharp bends wear Nitinol out.`);
      step('Solder the power wires to the crimp tubes, not to the Nitinol.');
    } else {
      step('Hook a spring between the A and B posts. It should be stretched a little with the fold flat.');
    }
    step(`Hook a rubber band on the back posts. Stretch it until it just starts to pull (about ${f1(m.band)} N: it should hold about ${f0(m.band / 9.81 * 1000)} g hanging from it).`);
    step(`Wire it as in the wiring list. ${kind === 'servo' ? 'Servo power comes from its own supply, never from the board.' : 'The SMA current comes from the battery through the MOSFETs, never from the board.'}`);
    step(`Upload \`fold_module.ino\` (${BOARD_NAME[board]}). Open the serial monitor at 115200 and send 1 to fold the first module.`);
    if (N > 1) step('When every module folds on its own, put the crawler on a rough surface and send g.');
    L.push('', '## Tuning', '');
    if (kind === 'servo') L.push('- Folds too little: send + a few times. Servo buzzes while holding: send - , or move the anchors further from the crease.');
    else {
      L.push(`- Doesn't fold all the way: raise HEAT_MS a little (100 ms at a time). Folds but drifts back open while held: raise HOLD_PWM by 5.`);
      L.push('- Doesn\'t open again: the band is too weak to stretch the cold metal back. Use a stronger band, or let it cool longer (raise OFF_MS).');
      L.push('- The battery voltage matters: a full LiPo (4.2 V) heats about 30% harder than a tired one (3.6 V).');
    }
    L.push('', '## Safety', '');
    if (kind !== 'servo') {
      L.push(`- The SMA runs at about ${f0(plan.drive.Thold)} °C. Don't touch it, and keep it off plastic that softens (PLA at 60 °C). Card is fine.`);
      L.push('- The sketch never heats a fold longer than MAX_ON_MS and never re-heats it before MIN_COOL_MS. Keep those limits.');
      if (plan.Rs > 0) L.push(`- The ${plan.Rs} Ω series resistors are a safety part, not an extra: with them, even a MOSFET that fails stuck on only passes the wire's rated current. Don't leave them out.`);
      L.push('- Software limits are not enough on their own: if a fold ever stays hot after the code says off, switch off the battery at once and replace that MOSFET.');
      L.push('- Each gate has a 10 kΩ resistor to ground so the MOSFETs stay off while the board starts.');
    }
    L.push('- Switch the battery off when you stop, and never leave it running or charging unattended. Use a LiPo with a protection board, and a fuse in the + lead.');
    L.push('', '## Files', '', '- `template.svg`: the panels, anchors and small parts', '- `fold_module.ino`: the controller', '- `parts.csv`: the parts list', '- `wiring.txt`: what connects where');
    return L.join('\n') + '\n';
  }

  function moduleKitFiles(plan) {
    const bom = moduleBom(plan), w = moduleWiring(plan);
    const csv = ['Group,Part,Qty,Notes'].concat(bom.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(','))).join('\n') + '\n';
    const enc = (s) => new TextEncoder().encode(s);
    return [
      { name: 'README.md', data: enc(moduleReadme(plan)) },
      { name: 'template.svg', data: enc(moduleTemplate(plan)) },
      { name: 'fold_module/fold_module.ino', data: enc(moduleSketch(plan)) },
      { name: 'parts.csv', data: enc(csv) },
      { name: 'wiring.txt', data: enc(w.rows.map((r) => r[0] + ': ' + r[1]).join('\n') + '\n') },
    ];
  }

  const API = { modulePins: pins, modulePlan, moduleTemplate, moduleBom, moduleWiring, moduleWiringSvg, moduleSketch, moduleReadme, moduleKitFiles };
  Object.assign(CL, API);
  if (typeof module !== 'undefined' && module.exports) module.exports = CL;
})(typeof window !== 'undefined' ? window : globalThis);
