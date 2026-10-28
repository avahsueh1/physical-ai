// ===== Crease Lab modules: one folding hinge, three ways to power it =====
// A fold module is two paper panels joined by one crease. Something pulls across the crease on the
// inside of the fold, and a rubber band on the outside opens it again. The puller is one of:
//   servo   a micro servo winds a thread onto a spool (the Stages 1-3 way)
//   wire    a straight shape-memory (Nitinol) wire that shortens about 4% when it is heated
//   spring  the same metal coiled into a spring, which shortens far more but pulls less
// The page simulates one module clamped to a table (the fold test), then copies chained in a row on
// the ground (a crawler). Everything is in SI units inside (m, kg, s, N, W); the UI talks in mm and g.
// Loads after transform-build.js. Works in the browser (window.CreaseLab) and in node (module.exports).
(function (root) {
  'use strict';
  let CL;
  if (typeof module !== 'undefined' && module.exports) CL = require('./transform-build.js');
  else CL = root.CreaseLab;
  const PI = Math.PI, DEG = PI / 180, G = 9.81, MM = 1e-3, GRAM = 1e-3;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
  const lerpTable = (tab, x) => {
    if (x <= tab[0][0]) return tab[0][1];
    for (let i = 1; i < tab.length; i++) if (x <= tab[i][0]) { const [x0, y0] = tab[i - 1], [x1, y1] = tab[i]; return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); }
    return tab[tab.length - 1][1];
  };

  // ---------------------------------------------------------------
  // Shape-memory alloy (NiTi). Thermal numbers are calibrated so that the model's cooling time
  // matches Dynalloy's Flexinol table (0.10 mm: 0.8 s, 0.15 mm: 2.0 s, 0.25 mm: 5.5 s for 70 °C wire).
  // ---------------------------------------------------------------
  const SMA = {
    rho: 6450,            // kg/m³
    c: 322,               // J/(kg K), Dynalloy gives 0.077 cal/g °C
    latent: 16000,        // J/kg absorbed going martensite → austenite (literature 12–24 J/g)
    rhoE: 0.85e-6,        // Ω m (Flexinol 0.15 mm is 1.3 Ω/inch = 51 Ω/m)
    EA: 75e9, EM: 28e9,   // tensile modulus, hot (austenite) and cold (martensite)
    GA: 28e9, GM: 10.5e9, // shear modulus, for springs
    sigD: 35e6,           // stress that re-stretches cold wire (detwinning)
    tauD: 20e6,           // the same in shear, for springs
    tauRated: 120e6,      // spring design shear stress for long life
    springStrain: 0.02,   // spring design shear strain for long life
    dTdS: 0.15e-6,        // transformation temperatures rise about 0.15 °C per MPa of stress
    h015: 53,             // W/(m² K) still-air cooling at 0.15 mm; scales as 1/diameter
    coilCooling: 0.7,     // a coil sheds heat less well than a straight wire
    Rcircuit: 0.15,       // Ω of MOSFET, wires and crimps in series with the SMA
  };
  const GRADES = {
    LT: { name: '70 °C (LT)', As: 68, Af: 78, Ms: 52, Mf: 42 },
    HT: { name: '90 °C (HT)', As: 88, Af: 98, Ms: 72, Mf: 62 },
  };
  // Dynalloy Flexinol table: diameter (mm), current for a 1 s contraction (A), recommended pull (g)
  const FLEXINOL = [[0.025, 0.020, 7], [0.038, 0.030, 17], [0.05, 0.050, 35], [0.076, 0.100, 80], [0.10, 0.180, 150], [0.13, 0.250, 230], [0.15, 0.400, 330],
    [0.20, 0.610, 590], [0.25, 1.000, 930], [0.30, 1.750, 1250], [0.38, 2.750, 2000], [0.50, 4.000, 3562]];
  const ratedCurrent = (dm) => lerpTable(FLEXINOL.map((r) => [r[0], r[1]]), dm / MM);
  const ratedPull = (dm) => lerpTable(FLEXINOL.map((r) => [r[0], r[2]]), dm / MM) * GRAM * G;
  const coolH = (dm) => SMA.h015 * (0.15 * MM / dm);
  // standard resistor values, 0.1 to 100 ohm (E12)
  const E12 = [];
  for (const dec of [0.1, 1, 10]) for (const m of [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2]) E12.push(+(m * dec).toFixed(2));
  E12.push(100);

  const SERVO_RATE = 200 * DEG;   // rad/s, the generated sketch's DEG_PER_S
  const SERVOS = {
    sg90: { name: 'SG90', g: 9, torque: 1.8 * 0.0980665, speed: (60 * DEG) / 0.1, stallA: 0.65, moveA: 0.12, idleA: 0.008, V: 5 },
    mg90s: { name: 'MG90S', g: 13.4, torque: 2.2 * 0.0980665, speed: (60 * DEG) / 0.1, stallA: 0.7, moveA: 0.15, idleA: 0.008, V: 5 },
  };

  // ---------------------------------------------------------------
  // The module's parameters (UI units: mm, g, N, V, degrees)
  // ---------------------------------------------------------------
  const MODULE_PARAMS = [
    { key: 'a', label: 'Panel length', min: 25, max: 60, step: 1, value: 45, unit: 'mm', group: 'hinge' },
    { key: 'w', label: 'Panel width', min: 15, max: 50, step: 1, value: 30, unit: 'mm', group: 'hinge' },
    { key: 'gsm', label: 'Paper weight', min: 120, max: 300, step: 10, value: 200, unit: 'gsm', group: 'hinge' },
    { key: 'tip', label: 'Load on the tip', min: 0, max: 20, step: 0.5, value: 0, unit: 'g', group: 'hinge' },
    // how the puller is mounted: each actuator keeps its own (they want different leverage)
    { key: 's1', label: 'Anchor on the fixed panel', min: 4, max: 20, step: 0.5, unit: 'mm', group: 'mount', hint: 'from the crease' },
    { key: 's2', label: 'Anchor on the moving panel', min: 4, max: 25, step: 0.5, unit: 'mm', group: 'mount', hint: 'from the crease' },
    { key: 'e', label: 'Standoff', min: 1, max: 8, step: 0.5, unit: 'mm', group: 'mount', hint: 'how far the anchors stand off the paper' },
    { key: 'band', label: 'Return band preload', min: 0, max: 3, step: 0.05, unit: 'N', group: 'mount' },
    // servo
    { key: 'target', label: 'Fold to', min: 20, max: 150, step: 1, value: 90, unit: '°', group: 'servo' },
    { key: 'spool', label: 'Spool radius', min: 2, max: 10, step: 0.5, value: 5, unit: 'mm', group: 'servo' },
    // straight wire
    { key: 'wireD', label: 'Wire diameter', min: 0.1, max: 0.25, step: 0.01, value: 0.15, unit: 'mm', group: 'wire', choices: [0.10, 0.13, 0.15, 0.20, 0.25] },
    { key: 'wireL', label: 'Wire length', min: 15, max: 400, step: 5, value: 160, unit: 'mm', group: 'wire', hint: 'the extra runs back and forth over pins on the fixed panel' },
    { key: 'strain', label: 'Usable shortening', min: 3, max: 5, step: 0.5, value: 4, unit: '%', group: 'wire' },
    // coil spring
    { key: 'springD', label: 'Spring wire diameter', min: 0.15, max: 0.4, step: 0.05, value: 0.2, unit: 'mm', group: 'spring' },
    { key: 'coilD', label: 'Coil diameter', min: 0.8, max: 4, step: 0.1, value: 1.2, unit: 'mm', group: 'spring' },
    { key: 'turns', label: 'Turns', min: 6, max: 60, step: 1, value: 40, int: true, group: 'spring' },
    // the crawler
    { key: 'arch', label: 'Arch angle', min: 15, max: 70, step: 1, value: 40, unit: '°', group: 'chain', hint: 'a card stop inside each fold' },
    // both SMA kinds
    { key: 'V', label: 'Supply', min: 3.7, max: 5, step: 1.3, value: 3.7, unit: 'V', group: 'sma', choices: [3.7, 5] },
  ];
  const MOUNT_DEFAULTS = {
    servo: { s1: 8, s2: 10, e: 3, band: 0.5 },
    wire: { s1: 10, s2: 6, e: 2, band: 1.8 },
    spring: { s1: 10, s2: 12, e: 2, band: 0.2 },
  };
  function defaultModule() {
    const o = { actuator: 'wire', servo: 'sg90', grade: 'LT', mount: JSON.parse(JSON.stringify(MOUNT_DEFAULTS)) };
    for (const q of MODULE_PARAMS) if (q.group !== 'mount') o[q.key] = q.value;
    return o;
  }
  // the mounting for this module's actuator (or another kind's, for comparisons)
  function mountOf(p, kind) { return Object.assign({}, MOUNT_DEFAULTS[kind || p.actuator], (p.mount || {})[kind || p.actuator]); }

  // ---------------------------------------------------------------
  // Geometry. The crease is the origin; the fixed panel lies along −x, the moving panel turns about the
  // crease by the fold angle θ toward the side the anchors stand on. An anchor sits s from the crease and
  // e off the paper (e < 0 puts it on the outside face, which is where the return band goes).
  // ---------------------------------------------------------------
  function span(th, s1, s2, e) {
    const c = Math.cos(th), s = Math.sin(th);
    const x2 = s2 * c - e * s, y2 = s2 * s + e * c;
    const dx = x2 + s1, dy = y2 - e, L = Math.hypot(dx, dy) || 1e-9;
    const dL = (dx * (-s2 * s - e * c) + dy * (s2 * c - e * s)) / L;  // dL/dθ (negative while it folds)
    return { L, dL, p1: [-s1, e], p2: [x2, y2] };
  }
  function geom(p) { const m = mountOf(p); return { s1: m.s1 * MM, s2: m.s2 * MM, e: m.e * MM }; }

  // the paper crease itself: a scored crease in card resists folding a little, roughly as thickness²
  function creaseStiffness(p) { return 0.02 * Math.pow(p.gsm / 160, 2) * p.w * MM; }  // N m / rad
  // the return band: a small rubber band on the outside, preloaded at flat. It wraps over the outside
  // of the crease on hooks as tall as the standoff, so its lever arm stays about e at any angle.
  // A card tab on the outside face stops the hinge at flat, so the preload can't fold it backwards.
  const BAND_K = 60;   // N/m, a small office rubber band doubled over
  function bandTorque(p, th) {
    const m = mountOf(p), e = m.e * MM, T = Math.max(0, m.band + BAND_K * e * Math.max(0, th));
    return { T, tau: -T * e };
  }

  // ---------------------------------------------------------------
  // Actuators. Each one has tension(θ) (what it pulls with right now, and the torque that makes),
  // step(dt, θ, cmd) (advance its own state: spool angle, or temperature and phase), and electrical
  // readings: current I (A, average from the supply), power P (W), energy E (J since reset).
  // ---------------------------------------------------------------
  class ServoAct {
    constructor(p) {
      this.kind = 'servo'; this.p = p; this.sv = SERVOS[p.servo] || SERVOS.sg90;
      this.g = geom(p); this.r = p.spool * MM; this.kt = 3000;   // braided line, ~5 cm free
      this.L0 = span(0, this.g.s1, this.g.s2, this.g.e).L;
      const need = this.L0 - span(p.target * DEG, this.g.s1, this.g.s2, this.g.e).L;
      this.phiFold = need / this.r;
      this.phiMax = 175 * DEG;
      this.short = this.phiFold > this.phiMax;
      this.mass = (this.sv.g + 1.5) * GRAM;   // servo, spool and thread
      this.reset();
    }
    reset() { this.phi = 0; this.I = this.sv.idleA; this.P = this.I * this.sv.V; this.E = 0; this.Tn = 0; this.peakI = this.I; this.moving = false; }
    tension(th) {
      const s = span(th, this.g.s1, this.g.s2, this.g.e);
      const T = this.kt * Math.max(0, s.L - (this.L0 - this.r * this.phi));
      return { T, tau: -T * s.dL, L: s.L };
    }
    step(dt, th, cmd) {
      const sv = this.sv, load = this.tension(th).T * this.r;
      const goal = cmd ? Math.min(this.phiFold, this.phiMax) : 0;
      const top = Math.min(sv.speed, SERVO_RATE);       // the sketch never moves faster than this
      let w = clamp(25 * (goal - this.phi), -top, top);
      if (w > 0) w = Math.min(w, top, sv.speed * (1 - load / sv.torque));   // slows under load, stalls, or is back-driven
      this.phi = clamp(this.phi + w * dt, 0, this.phiMax);
      this.moving = Math.abs(w) > 0.2;
      this.I = sv.idleA + (this.moving ? sv.moveA : 0) + sv.stallA * Math.min(1.2, load / sv.torque);
      this.P = this.I * sv.V; this.E += this.P * dt; this.peakI = Math.max(this.peakI, this.I);
      this.Tn = load / this.r;
    }
  }

  class SMAAct {
    constructor(p, kind, drive) {
      this.kind = kind; this.p = p; this.g = geom(p); this.gr = GRADES[p.grade] || GRADES.LT;
      const g = this.g, L0 = span(0, g.s1, g.s2, g.e).L;
      this.L0 = L0;
      if (kind === 'wire') {
        this.d = p.wireD * MM; this.Lw = Math.max(p.wireL * MM, L0); this.extra = this.Lw - L0;
        this.epsR = p.strain / 100;
        this.Lmem = this.Lw / (1 + this.epsR);        // the length it remembers, and shrinks to when hot
        this.Ahalf = PI * this.d * this.d / 4;
        this.strainOf = (L) => (this.extra + L) / this.Lmem - 1;
        this.forceOf = (sig) => sig * this.Ahalf;
        this.E1 = SMA.EA; this.E0 = SMA.EM; this.yieldS = SMA.sigD; this.sigMax = 600e6;
        this.rated = ratedPull(this.d) / this.Ahalf;  // stress at Dynalloy's recommended pull
        this.wireLen = this.Lw; this.hA = coolH(this.d) * PI * this.d * this.Lw;
        this.epsMax = this.epsR;
      } else {
        this.d = p.springD * MM; this.D = p.coilD * MM; this.n = p.turns;
        this.Lc = this.n * this.d;                    // closed (remembered) length
        this.shortSpring = this.Lc >= L0;
        const gk = this.d / (PI * this.n * this.D * this.D);
        this.strainOf = (L) => gk * (L - this.Lc);    // shear strain in the coil wire
        this.forceOf = (tau) => tau * PI * this.d ** 3 / (8 * this.D);
        this.E1 = SMA.GA; this.E0 = SMA.GM; this.yieldS = SMA.tauD; this.rated = SMA.tauRated; this.sigMax = 400e6;
        this.epsMax = SMA.springStrain * 1.25;
        this.wireLen = PI * this.D * this.n; this.hA = SMA.coilCooling * coolH(this.d) * PI * this.d * this.wireLen;
      }
      this.A = PI * this.d * this.d / 4;
      this.R = SMA.rhoE * this.wireLen / this.A;
      this.mass = SMA.rho * this.A * this.wireLen + 0.4 * GRAM;   // wire plus two crimps
      this.C = this.mass === 0 ? 1 : SMA.rho * this.A * this.wireLen * SMA.c;
      this.m = SMA.rho * this.A * this.wireLen;
      this.V = p.V;
      // a series resistor sized so that fully on, the current is Dynalloy's rated (1-second) current.
      // Then 100% is the heating power, holding is a fraction of it, and a switch stuck on can only
      // ever put the rated current through the metal.
      this.Irated = ratedCurrent(this.d);
      const need = this.V / this.Irated - this.R - SMA.Rcircuit;
      this.Rs = need > 0.05 ? (E12.find((r) => r >= need) || need) : 0;
      this.Ipk = this.V / (this.R + SMA.Rcircuit + this.Rs);
      this.Pfull = this.Ipk * this.Ipk * this.R;
      this.drive = drive || planDrive(this);
      this.reset();
    }
    reset() {
      this.Tc = 22; this.xi = 0; this.duty = 0; this.onFor = 0; this.offFor = 99; this.I = 0; this.P = 0; this.E = 0; this.peakT = 22; this.peakS = 0; this.sigF = 0; this.peakI = 0; this.Tn = 0;
      this.epsM = Math.max(0, this.strainOf(this.L0));   // installed taut, cold, with no load
      this.overStretch = this.epsM > this.epsMax + 1e-9;
    }
    stress(th) {
      const s = span(th, this.g.s1, this.g.s2, this.g.e), eps = this.strainOf(s.L);
      const E = this.xi * this.E1 + (1 - this.xi) * this.E0, rest = (1 - this.xi) * this.epsM;
      // a fully blocked hot wire can't pull harder than its blocked-recovery stress (~600 MPa in tension)
      return { sig: Math.min(this.sigMax, Math.max(0, E * (eps - rest))), eps, s, E };
    }
    tension(th) { const st = this.stress(th), T = this.forceOf(st.sig); return { T, tau: -T * st.s.dL, L: st.s.L, sig: st.sig }; }
    step(dt, th, cmd) {
      // the controller: full heating power for heatMs, then a lower holding power, never longer than maxMs
      const d = this.drive;
      if (cmd) { this.onFor += dt; this.offFor = 0; } else { this.onFor = 0; this.offFor += dt; }
      this.duty = !cmd || this.onFor > d.maxS ? 0 : this.onFor < d.heatS ? d.heat : d.hold;
      const Pw = this.duty * this.Pfull;
      this.I = this.duty * this.Ipk; this.P = this.duty * this.Ipk * this.Ipk * (this.R + SMA.Rcircuit + this.Rs);
      this.E += this.P * dt; this.peakI = Math.max(this.peakI, this.Ipk * (this.duty > 0 ? 1 : 0));
      // heat balance (lumped: the wire is thin, so it is one temperature)
      this.Tc += (dt * (Pw - this.hA * (this.Tc - 22))) / this.C;
      // phase: heating moves along As→Af, cooling along Ms→Mf, both shifted up by the stress
      let st = this.stress(th);
      const shift = SMA.dTdS * st.sig * (this.kind === 'spring' ? 1.6 : 1), gr = this.gr;
      const xh = smooth((this.Tc - gr.As - shift) / (gr.Af - gr.As)), xc = smooth((this.Tc - gr.Mf - shift) / (gr.Ms - gr.Mf));
      let xn = this.xi;
      if (xh > xn) xn = xh;
      if (xc < xn) xn = xc;
      if (xn < this.xi) {
        // new martensite forms at the length the wire is now
        const keep = (1 - this.xi) * this.epsM + (this.xi - xn) * Math.max(0, st.eps);
        this.epsM = xn < 1 - 1e-9 ? keep / (1 - xn) : this.epsM;
      }
      this.Tc -= (SMA.latent * this.m * (xn - this.xi)) / this.C;   // transforming soaks up (or gives back) heat
      this.xi = xn;
      // a cold wire is soft: the return band can stretch it out again, at the detwinning stress
      st = this.stress(th);
      const ys = this.yieldS / Math.max(1e-3, 1 - this.xi);
      if (st.sig > ys && this.epsM < this.epsMax && this.xi < 0.98) {
        this.epsM = Math.min(this.epsMax, (st.eps - ys / st.E) / (1 - this.xi));
        st = this.stress(th);
      }
      this.sigF += ((st.sig - this.sigF) * dt) / 0.02;     // report sustained pull, not 1 ms spikes
      this.peakT = Math.max(this.peakT, this.Tc); this.peakS = Math.max(this.peakS, this.sigF);
      this.Tn = this.forceOf(st.sig);
    }
  }

  // How hard and how long to heat. Heating power matches what Dynalloy's 1-second current puts into
  // this wire; it heats until it would be fully hot (worked out from the same heat balance), then holds
  // it about 10 °C above Af (Af itself raised by the expected stress), which keeps it contracted
  // without cooking it.
  function planDrive(a) {
    const gr = a.gr, P1 = ratedCurrent(a.d) ** 2 * a.R;
    const heat = Math.min(1, P1 / a.Pfull);
    const shift = SMA.dTdS * (a.kind === 'spring' ? 1.6 : 1) * 0.5 * a.rated;
    const Thold = gr.Af + shift + 10, Phold = a.hA * (Thold - 22);
    const hold = Math.min(heat, Phold / a.Pfull);
    // time to heat (lumped model with the latent heat spread over As..Af)
    let T = 22, t = 0; const Pin = heat * a.Pfull, dt = 0.002;
    const Ttarget = gr.Af + shift + 5;
    const Ceff = a.C + (SMA.latent * a.m) / (gr.Af - gr.As);
    while (T < Ttarget && t < 20) { const C = T > gr.As + shift && T < gr.Af + shift ? Ceff : a.C; T += (dt * (Pin - a.hA * (T - 22))) / C; t += dt; }
    const reach = T >= Ttarget;
    const heatS = Math.max(0.2, t * 1.1);
    // the safety cut-off is 10 s, or longer for a slow, underpowered design (which is warned about)
    return { heat, hold, heatS, maxS: Math.max(10, Math.ceil(heatS + 3)), reach, underpowered: !a.Rs && heat >= 1 && P1 > a.Pfull * 1.05,   // with a series resistor the slight shortfall is by design
      Thold };
  }

  function makeActuator(p, drive) {
    if (p.actuator === 'servo') return new ServoAct(p);
    return new SMAAct(p, p.actuator === 'spring' ? 'spring' : 'wire', drive);
  }

  // ---------------------------------------------------------------
  // One hinge, simulated in time: the moving panel (plus any tip load) turns about the crease under
  // the actuator, the paper's own stiffness, the return band, gravity and a little damping. A stop tab
  // keeps it from folding backwards; another stop (the panels meeting, or the crawler's arch stop)
  // limits how far it can fold.
  // ---------------------------------------------------------------
  class Hinge {
    constructor(p, opts) {
      const o = Object.assign({ stop: 170, tip: true, drive: null }, opts || {});
      this.p = p; this.act = makeActuator(p, o.drive);
      const a = p.a * MM, mP = p.gsm * 1e-3 * a * (p.w * MM), tip = o.tip ? p.tip * GRAM : 0;
      this.I = (mP * a * a) / 3 + tip * a * a;
      this.gTorque = (mP * a) / 2 * G + tip * a * G;   // panel lying flat, lifted by the fold
      this.kc = creaseStiffness(p); this.damp = 4e-4; this.stop = o.stop * DEG;   // paper creases are lossy: about critically damped
      this.th = 0; this.w = 0; this.t = 0; this.cmd = false; this.dt = 2e-4;
    }
    torque() {
      const th = this.th;
      let tau = this.act.tension(th).tau - this.kc * th + bandTorque(this.p, th).tau - this.gTorque * Math.cos(th) - this.damp * this.w;
      return tau;
    }
    step(n) {
      const dt = this.dt;
      for (let i = 0; i < n; i++) {
        this.act.step(dt, this.th, this.cmd);
        this.w += (dt * this.torque()) / this.I;
        this.th += dt * this.w;
        // hard stops: the stop tab at flat, the panels meeting (or the arch wedge)
        if (this.th < 0) { this.th = 0; if (this.w < 0) this.w = 0; }
        if (this.th > this.stop) { this.th = this.stop; if (this.w > 0) this.w = 0; }
        this.t += dt;
      }
    }
  }

  // ---------------------------------------------------------------
  // Copies in a row on the ground: a crawler. Each module's hinge runs on its own (as in the fold test,
  // stopped at the arch angle); the chain's shape follows from the hinge angles. All folds bend the same
  // way, so the chain is an arch standing on its two ends. When the ends get closer (or further apart)
  // one of them has to slide, and it's the one that's easier to slide: friction times the weight on it,
  // with feet that may slide forward more easily than backward. This is slow (quasi-static) crawling:
  // it can't invent distance from bouncing, which a paper robot this light would mostly damp out anyway.
  // ---------------------------------------------------------------
  class Crawler {
    constructor(p, opts) {
      const o = Object.assign({ modules: 3, feet: 'directional', drive: null }, opts || {});
      const N = o.modules, a = p.a * MM;
      this.p = p; this.N = N; this.a = a; this.q = chainModule(p, false);
      this.hinges = []; for (let j = 0; j < N; j++) this.hinges.push(new Hinge(this.q, { stop: p.arch, tip: false, drive: o.drive }));
      this.acts = this.hinges.map((h) => h.act);
      // node masses: each panel half to each end, each actuator on the panel behind its crease
      this.m = new Float64Array(N + 2);
      const mP = p.gsm * 1e-3 * a * (p.w * MM);
      for (let i = 0; i <= N; i++) { this.m[i] += mP / 2; this.m[i + 1] += mP / 2; }
      this.acts.forEach((act, j) => { const f = act.kind === 'servo' ? 0.45 : 0.5; this.m[j + 1] += act.mass * (1 - f); this.m[j] += act.mass * f; });
      this.mass = this.m.reduce((s, v) => s + v, 0);
      if (o.feet === 'directional') { this.muF = 0.25; this.muB = 0.9; } else { this.muF = this.muB = 0.5; }
      this.xr = 0; this.cmd = new Array(N).fill(false); this.t = 0;
      this.pose(); this.d0 = this.d;
    }
    // the shape from the hinge angles, standing on its two ends at x = xr
    pose() {
      const N = this.N, a = this.a, P = [[0, 0]];
      let h = 0;
      for (let i = 0; i <= N; i++) {
        const [x, y] = P[i]; P.push([x + a * Math.cos(h), y + a * Math.sin(h)]);
        if (i < N) h -= this.hinges[i].th;
      }
      const e = P[N + 1], rot = -Math.atan2(e[1], e[0]), c = Math.cos(rot), s = Math.sin(rot);
      this.d = Math.hypot(e[0], e[1]);
      this.X = P.map(([x, y]) => this.xr + x * c - y * s); this.Y = P.map(([x, y]) => Math.max(0, x * s + y * c));
      let cx = 0; for (let i = 0; i < P.length; i++) cx += this.m[i] * (this.X[i] - this.xr);
      this.cx = cx / this.mass;
    }
    com() { return this.xr + this.cx; }
    step(n) {
      for (let j = 0; j < this.N; j++) { this.hinges[j].cmd = this.cmd[j]; this.hinges[j].step(n); }
      this.t = this.hinges[0].t;
      this.move();
    }
    // set the hinge angles directly (radians), then let the feet sort out who slides
    setAngles(th) { for (let j = 0; j < this.N; j++) this.hinges[j].th = th[j]; this.move(); }
    move() {
      const dPrev = this.d, cPrev = this.cx;
      this.pose();
      // feet and paper give a little before anything slides (about 0.3 mm), so tiny back-and-forth
      // jiggles of the hinges don't ratchet the robot along
      const raw = this.d - dPrev, C = 0.3 * MM;
      this.give = (this.give || 0) + raw;
      let dd = 0;
      if (this.give > C) { dd = this.give - C; this.give = C; } else if (this.give < -C) { dd = this.give + C; this.give = -C; }
      if (Math.abs(dd) < 1e-12) return;
      // weight on each end (lever rule about the centre of mass, using the average shape)
      const cAvg = (this.cx + cPrev) / 2, dAvg = (this.d + dPrev) / 2;
      const Nf = clamp(cAvg / dAvg, 0, 1), Nr = 1 - Nf;
      // getting shorter: rear end forward, or front end back; getting longer: rear back, or front forward
      const rear = (dd < 0 ? this.muF : this.muB) * Nr, front = (dd < 0 ? this.muB : this.muF) * Nf;
      let share;                                    // how much of the change the rear end takes
      if (Math.abs(rear - front) < 0.02 * (rear + front)) share = 0.5;
      else share = rear < front ? 1 : 0;
      this.xr -= share * dd;                        // the rear end moves by −dd·share, the front by +dd·(1−share)
      this.pose();
    }
    power() { return this.acts.reduce((s, a) => s + a.P, 0); }
    current() { return this.acts.reduce((s, a) => s + a.I, 0); }
    energy() { return this.acts.reduce((s, a) => s + a.E, 0); }
  }

  function chainModule(p, rig) {
    if (rig) return p;
    const q = Object.assign({}, p, { target: Math.min(p.target, p.arch) });
    if (p.actuator === 'wire') {
      const m = mountOf(p), g = { s1: m.s1 * MM, s2: m.s2 * MM, e: m.e * MM };
      const dL = span(0, g.s1, g.s2, g.e).L - span(p.arch * DEG, g.s1, g.s2, g.e).L, eps = p.strain / 100;
      q.wireL = Math.max(span(0, g.s1, g.s2, g.e).L / MM, Math.min(p.wireL, (1.1 * dL * (1 + eps)) / eps / MM));
    }
    return q;
  }

  // ---------------------------------------------------------------
  // The fold test: clamp the first panel, command a fold, wait, release, watch it come back.
  // ---------------------------------------------------------------
  function foldTest(p, opts) {
    const o = Object.assign({ onS: null, maxS: 16, sample: 0.02, stop: 170 }, opts || {});
    const ch = new Hinge(p, { stop: o.stop }), act = ch.act;
    const onS = o.onS || (act.kind === 'servo' ? 1.0 : act.drive.heatS + 0.6);
    const t0 = 0.2;
    const trace = []; let next = 0, thMax = -1, tMax = 0;
    while (ch.t < t0 + onS + o.maxS) {
      ch.cmd = ch.t >= t0 && ch.t < t0 + onS;
      ch.step(20);
      const th = ch.th;
      if (th > thMax) { thMax = th; tMax = ch.t; }
      if (ch.t >= next) { trace.push({ t: ch.t, th: th / DEG, T: act.Tc || null, I: act.I, F: act.Tn }); next += o.sample; }
      if (ch.t > t0 + onS + 0.3 && th < Math.max(3 * DEG, 0.1 * thMax) && Math.abs(th - (trace.length > 5 ? trace[trace.length - 5].th * DEG : 0)) < 0.2 * DEG) break;
    }
    // timings: from command to 90% of the peak, and from release to back under 10%
    const peak = Math.max(...trace.map((s) => s.th));
    const rise = trace.find((s) => s.t >= t0 && s.th >= 0.9 * peak);
    const after = trace.filter((s) => s.t >= t0 + onS);
    const back = after.find((s) => s.th <= Math.max(0.1 * peak, 3));
    const startTh = trace.find((s) => s.t >= t0) || trace[0];
    const energy = act.E;
    return {
      kind: act.kind, act, trace, t0, onS, peak,
      foldS: rise ? rise.t - t0 : null,
      openS: back ? back.t - (t0 + onS) : null,
      returned: !!back,
      rest: trace[trace.length - 1].th,     // where it settles after opening
      energy, peakI: act.peakI, peakT: act.peakT || null, peakS: act.peakS || null,
      mass: act.mass, servoShort: act.short || false, drive: act.drive || null,
      R: act.R || null, Ipk: act.Ipk || null,
      maxPull: Math.max(...trace.map((s) => s.F || 0)),
    };
  }

  // problems worth telling the user about, in plain words
  function moduleWarnings(p, r) {
    const out = [], a = r.act;
    if (r.kind === 'servo') {
      if (a.short) out.push(`The spool is too small: folding to ${p.target}° needs ${Math.round(a.phiFold / DEG)}° of servo travel, more than it has. Use a bigger spool.`);
      if (r.peak < 0.85 * p.target) out.push(`It only reached ${Math.round(r.peak)}° of the ${p.target}° asked for: the servo can't pull hard enough here. Move the anchors further from the crease, or use a smaller spool.`);
      if (r.maxPull > 0.8 * a.sv.torque / a.r) out.push('The servo is working near its stall torque: it will buzz and get warm holding the fold.');
    } else {
      const gr = a.gr;
      if (a.kind === 'spring' && a.shortSpring) out.push(`The closed spring (${(a.Lc / MM).toFixed(1)} mm) is longer than the gap between the anchors (${(a.L0 / MM).toFixed(1)} mm). Use fewer turns or move the anchors apart.`);
      if (a.overStretch) out.push(a.kind === 'wire' ? 'The wire is too short to reach between the anchors.' : `Stretched across the anchors the spring is past its ${Math.round(SMA.springStrain * 100)}% design strain: it will lose its memory. Use more turns or a bigger coil.`);
      if (a.drive.underpowered) out.push(`${p.V} V can't push the recommended current through ${a.R.toFixed(1)} Ω, so it heats slowly. Use a shorter or thicker wire, or the higher supply.`);
      if (!a.drive.reach) out.push('At this power it never gets hot enough to fully contract.');
      if (r.peakT > 140) out.push(`It reaches ${Math.round(r.peakT)} °C. Lower the holding power: hotter than needed wastes energy and wears the wire out.`);
      if (r.peakS > 2 * a.rated) out.push(`It strains at ${Math.round(r.peakS / 1e6)} MPa, more than twice the ${Math.round(a.rated / 1e6)} MPa recommended: it will lose its memory (stop shortening fully) or snap within a few cycles. Weaken the band, lighten the load, or use ${a.kind === 'wire' ? 'a thicker wire' : 'thicker spring wire'}.`);
      else if (r.peakS > 1.15 * a.rated) out.push(`It pulls at ${Math.round(r.peakS / 1e6)} MPa, above the ${Math.round(a.rated / 1e6)} MPa that's recommended when it has to last. Fine for experiments, but it will wear out sooner: weaken the band or ${a.kind === 'wire' ? 'use a thicker wire' : 'use thicker spring wire'}.`);
      if (!r.returned) out.push(`It doesn't open again on its own: the cold ${a.kind === 'wire' ? 'wire' : 'spring'} needs the band to stretch it back. Raise the return band preload.`);
      else if (r.rest > 8) out.push(`It stays ${Math.round(r.rest)}° folded at rest: the band is barely stronger than the cold ${a.kind}. A bit more preload will open it fully.`);
      if (r.peak < 25 && r.returned) out.push(a.kind === 'wire'
        ? `It only folds ${Math.round(r.peak)}°: ${Math.round(p.strain)}% of ${p.wireL} mm is only ${(p.strain / 100 * p.wireL).toFixed(1)} mm of pull. Use more wire (routed over pins), or anchors closer to the crease.`
        : `It only folds ${Math.round(r.peak)}°: the band is winning. Lower the preload or use a stiffer spring.`);
      void gr;
    }
    return out;
  }

  // ---------------------------------------------------------------
  // Copies in a row on the ground: a crawler. Each module folds the chain into an arch; directional
  // feet make the ends slide one way only, so every fold-and-open moves it forward a little.
  // ---------------------------------------------------------------
  function chainTiming(p, test) {
    const r = test || foldTest(p);
    const onS = r.kind === 'servo' ? Math.max(0.25, (r.foldS || 0.3) * 1.4) : r.onS;
    const offS = Math.max(0.2, (r.openS || 3) * 1.15);
    return { onS, offS, test: r };
  }
  // the crawler's own module (shorter wire, arch stop) tested on the table, then timed
  function crawlerTiming(p) {
    const q = chainModule(p, false);
    return chainTiming(q, foldTest(q, { stop: p.arch }));
  }
  function chainCmd(gait, N, t, tm) {
    const cmd = new Array(N).fill(false);
    if (gait === 'together') { const T = tm.onS + tm.offS, ph = t % T; cmd.fill(ph < tm.onS); return { cmd, period: T }; }
    // a wave from the tail to the head: each module starts as the one before it is half way
    const lag = tm.onS * 0.6, T = (N - 1) * lag + tm.onS + tm.offS, ph = t % T;
    for (let k = 0; k < N; k++) cmd[k] = ph >= k * lag && ph < k * lag + tm.onS;
    return { cmd, period: T };
  }
  // Modules don't push on each other's hinges in this model, so one hinge's response, shifted in time,
  // is every module's response: simulate one, then walk the crawler through the shifted copies.
  function chainTest(p, opts) {
    const o = Object.assign({ modules: 3, feet: 'directional', gait: 'wave', cycles: 4, timing: null, trace: true }, opts || {});
    const tm = o.timing || crawlerTiming(p), N = o.modules;
    const cr = new Crawler(p, { modules: N, feet: o.feet });
    const { period } = chainCmd(o.gait, N, 0, tm);
    const lag = o.gait === 'together' ? 0 : tm.onS * 0.6;
    const tEnd = period * o.cycles, dtS = 0.002, steps = Math.round(dtS / 2e-4);
    const h = new Hinge(cr.q, { stop: p.arch, tip: false });
    const TH = [], I = [];
    for (let t = 0; t <= tEnd + 1e-9; t += dtS) {
      h.cmd = chainCmd(o.gait, 1, ((t % period) + period) % period, tm).cmd[0] && (t % period) < tm.onS;
      TH.push(h.th); I.push(h.act.I);
      h.step(steps);
    }
    const at = (arr, i) => (i < 0 ? (arr === TH ? 0 : 0) : arr[Math.min(i, arr.length - 1)]);
    const sh = Math.round(lag / dtS);
    const x0 = cr.com(), trace = []; let peakI = 0, peakTh = 0, xAfter1 = null;
    const th = new Array(N);
    for (let i = 0; i < TH.length; i++) {
      let cur = 0;
      for (let k = 0; k < N; k++) { th[k] = at(TH, i - k * sh); cur += at(I, i - k * sh); peakTh = Math.max(peakTh, th[k]); }
      cr.setAngles(th);
      peakI = Math.max(peakI, cur);
      const t = i * dtS;
      if (xAfter1 === null && t >= period) xAfter1 = cr.com();
      if (o.trace && i % 25 === 0) trace.push([t, (cr.com() - x0) / MM]);
    }
    const x1 = cr.com();
    const dist = (x1 - (xAfter1 ?? x0)) / MM, steady = (tEnd - period) || tEnd;
    const speed = o.cycles > 1 ? dist / steady : (x1 - x0) / MM / tEnd;    // mm/s, ignoring the first cycle
    const E = h.act.E * N;
    const rated = h.act.rated || null;
    return { speed, perCycle: speed * period, period, mass: cr.mass, energy: E, energyPerCycle: E / o.cycles, mmPerJ: E > 0 ? dist / (E * (o.cycles - 1) / o.cycles) : 0, peakI, peakTh: peakTh / DEG, peakS: h.act.peakS || 0, rated, wireL: cr.q.wireL, turns: cr.q.turns, trace, timing: tm, lag, crawler: cr };
  }

  // problems with the crawler, in plain words
  function crawlerWarnings(p, c, o) {
    const out = [], act = c.crawler.acts[0];
    if (o.feet !== 'directional' && Math.abs(c.perCycle) < 2) out.push('With plain feet it only shuffles back and forth in place: folding pulls both ends in, and with the same grip both ways neither end wins. Directional feet (climbing skin, angled bristles) are what make it go.');
    if (o.gait === 'together' && o.modules * p.arch > 140) out.push(`${o.modules} folds at ${p.arch}° all at once bend the strip right round: its ends would hit. Lower the arch angle or use the wave gait.`);
    if (act.kind !== 'servo' && c.rated && c.peakS > 1.15 * c.rated) out.push(act.kind === 'spring'
      ? `The arch stop blocks the spring before it has finished closing, so it strains at ${Math.round(c.peakS / 1e6)} MPa (about ${Math.round(c.rated / 1e6)} is the long-life figure). A coil with more turns would close nearer the stop, but pulls less.`
      : `Blocked by the arch stop the wire pulls at ${Math.round(c.peakS / 1e6)} MPa, above the ${Math.round(c.rated / 1e6)} MPa recommended for long life.`);
    if (c.peakTh < 0.8 * p.arch) out.push(`The folds only reach ${Math.round(c.peakTh)}° of the ${p.arch}° arch: they don't have time to close, or can't pull hard enough.`);
    if (act.kind === 'servo' && c.mass > 0.02) out.push(`${o.modules} servos make it ${Math.round(c.mass * 1000)} g: heavy for card. Use 250–300 gsm card, or fold a double layer at each servo.`);
    return out;
  }

  // the same hinge, three ways: what each one costs and what it does
  function compareActuators(p, opts) {
    const o = Object.assign({ modules: 3, feet: 'directional', gait: 'wave' }, opts || {});
    const rows = [];
    for (const kind of ['servo', 'wire', 'spring']) {
      const q = Object.assign({}, p, { actuator: kind });
      const r = foldTest(q), tm = crawlerTiming(q);
      const c = chainTest(q, { modules: o.modules, feet: o.feet, gait: o.gait, cycles: 3, timing: tm, trace: false });
      rows.push({ kind, test: r, chain: c, warnings: moduleWarnings(q, r) });
    }
    return rows;
  }

  // parts cost, roughly, per module (USD, small quantities)
  function moduleCost(kind, p) {
    if (kind === 'servo') return p.servo === 'mg90s' ? 4 : 2.5;
    if (kind === 'wire') return 0.6 + (p.wireL / 1000) * 6;   // ~$6/m Flexinol plus crimps and a MOSFET
    return 2;                                                  // a hobby Nitinol spring plus a MOSFET
  }

  const API = { crawlerTiming, crawlerWarnings, Hinge, Crawler, chainModule, MOUNT_DEFAULTS, mountOf, SMA, GRADES, FLEXINOL, SERVOS, MODULE_PARAMS, defaultModule, span, creaseStiffness, bandTorque, ServoAct, SMAAct, planDrive, makeActuator, foldTest, moduleWarnings, chainTiming, chainCmd, chainTest, compareActuators, moduleCost, ratedCurrent, ratedPull };
  Object.assign(CL, API);
  if (typeof module !== 'undefined' && module.exports) module.exports = CL;
})(typeof window !== 'undefined' ? window : globalThis);
