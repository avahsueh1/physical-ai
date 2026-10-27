// ===== Crease Lab brain, in the browser: the trained tiny controller + world-model safety filter =====
//
// Same physics as everything else (terrain.js). The networks are exported from Python by
// scripts/export_web.py into web/brain-model.js (window.BRAIN_MODEL / module.exports).
//
//   const ep = new CL.BrainEpisode(model, course, { driver: 'brain', filter: true, mission: 'go forward' });
//   ep.decide();            // pick the next move (1.5 s), apply it
//   ep.sim.step(n) ...      // advance physics (the page does this a few substeps per frame)
//   ep.finishDecision();    // bookkeeping + success/failure rules after the 1.5 s
//
// Mirrors brain/env.py (observation, failure rules), brain/policy.py (gait + rhythm generator)
// and brain/safety.py (veto rule). tests/test_web_parity.py checks the moves match Python.
(function (root) {
  'use strict';
  const CL = typeof module !== 'undefined' && module.exports ? require('./terrain.js') : root.CreaseLab;

  // ------------------------------------------------------------------ tiny nets
  function mlp(net, x) {
    let h = x.map((v, i) => (v - net.mu[i]) / net.sd[i]);
    for (let l = 0; l < net.W.length; l++) {
      const W = net.W[l], b = net.b[l], out = new Array(b.length);
      for (let o = 0; o < b.length; o++) {
        let s = b[o]; const row = W[o];
        for (let k = 0; k < h.length; k++) s += row[k] * h[k];
        out[o] = l < net.W.length - 1 ? (net.act === 'tanh' ? Math.tanh(s) : Math.max(0, s)) : s;
      }
      h = out;
    }
    return h;
  }
  const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  function softmax(z) { const m = Math.max(...z), e = z.map((v) => Math.exp(v - m)), s = e.reduce((a, b) => a + b, 0); return e.map((v) => v / s); }

  // ------------------------------------------------------------------ course path
  class Path {
    constructor(pts) {
      this.p = pts; this.len = []; this.cum = [0]; this.dir = [];
      for (let k = 0; k < pts.length - 1; k++) {
        const dx = pts[k + 1][0] - pts[k][0], dy = pts[k + 1][1] - pts[k][1], L = Math.hypot(dx, dy);
        this.len.push(L); this.cum.push(this.cum[k] + L); this.dir.push([dx / L, dy / L]);
      }
      this.total = this.cum[this.cum.length - 1];
    }
    project(xy) {
      let best = [1e9, 0];
      for (let k = 0; k < this.len.length; k++) {
        const dx = xy[0] - this.p[k][0], dy = xy[1] - this.p[k][1];
        const t = Math.max(0, Math.min(this.len[k], dx * this.dir[k][0] + dy * this.dir[k][1]));
        const qx = this.p[k][0] + t * this.dir[k][0], qy = this.p[k][1] + t * this.dir[k][1];
        const d = Math.hypot(xy[0] - qx, xy[1] - qy);
        if (d < best[0]) best = [d, this.cum[k] + t];
      }
      return [best[1], best[0]];
    }
    point(s) {
      s = Math.max(0, Math.min(this.total, s));
      let k = 0; while (k < this.len.length - 1 && this.cum[k + 1] <= s) k++;
      return [this.p[k][0] + (s - this.cum[k]) * this.dir[k][0], this.p[k][1] + (s - this.cum[k]) * this.dir[k][1]];
    }
  }

  // ------------------------------------------------------------------ language -> mission
  const RISK = { careful: 0.15, normal: 0.3, bold: 0.55 };
  const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, 'a couple of': 2, 'a few': 3, 'half a': 0.5, a: 1 };
  function parseMission(text) {
    const t = ' ' + String(text || '').toLowerCase().trim() + ' ';
    const m = { goal: 'traverse', distance: null, risk: 'normal', refuse: true, text };
    if (/\b(stop|halt|freeze|stay|wait)\b/.test(t) && !/\bdon'?t stop\b/.test(t)) m.goal = 'stop';
    const d = t.match(/(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few|half a|a)\s+(body[- ]?lengths?|bodies|lengths?|bl)\b/);
    if (d && m.goal !== 'stop') { const n = isNaN(+d[1]) ? NUM[d[1]] : +d[1]; if (n) { m.goal = 'distance'; m.distance = n; } }
    if (/\b(careful(ly)?|gentl[ey]|slow(ly)?|cautious(ly)?|safe(ly)?|don'?t (break|fall|tear))\b/.test(t)) m.risk = 'careful';
    if (/\b(hurry|fast|quick(ly)?|asap|bold(ly)?|aggressive(ly)?|whatever it takes|don'?t care)\b/.test(t)) m.risk = 'bold';
    if (/\b(no matter what|even if|force (it|your way)|squeeze through anyway)\b/.test(t)) m.refuse = false;
    m.tau = RISK[m.risk];
    return m;
  }

  // ------------------------------------------------------------------ an episode
  class BrainEpisode {
    constructor(model, course, opts) {
      opts = opts || {};
      this.M = model; this.course = course;
      this.driver = opts.driver || 'brain';           // 'brain' | 'reckless'
      this.mission = parseMission(opts.mission || 'crawl to the end');
      this.useFilter = opts.filter !== false && this.mission.refuse;
      this.sim = CL.buildTerrainRobot(opts.body || {}, course.terrain, null, course.start);
      this.path = new Path(course.waypoints);
      this.substeps = Math.max(1, Math.round(model.decision_seconds / this.sim.dt));
      this.t = 0; this.prevAction = 0; this.repeat = 0; this.restRun = 0;
      this.phase = 0; this.gait = 0;
      const st = this.sim.status();
      this.progHist = [this.path.project(st.com)[0]];
      this.startProg = this.progHist[0];
      this.done = false; this.outcome = null; this.vetoes = 0;
      this.last = null;   // what the brain considered on the latest decision
    }

    observe() {
      const M = this.M, se = this.sim.sense(), st = this.sim.status();
      const r = M.rays.map((k) => Math.min(se.ranges[k], 5) / 5);
      const [s] = this.path.project(st.com);
      const tgt = this.path.point(s + M.lookahead);
      const bearing = Math.atan2(tgt[1] - st.com[1], tgt[0] - st.com[0]) - st.yaw;
      const prev = new Array(M.actions.length).fill(0); prev[this.prevAction] = 1;
      return r.concat([se.pitch, se.roll, se.length, Math.log1p(Math.max(0, se.wallForce)), Math.min(se.slip, 2)],
        se.cables.slice(0, 4), se.anchors,
        [Math.sin(bearing), Math.cos(bearing), Math.min(this.path.total - s, 30) / 30, Math.min(this.repeat, 4) / 4], prev);
    }

    // "turning isn't working" reflex (brain/policy.py Policy._reflex): after two cycles of the same
    // turn with the goal bearing changed by < 4 degrees, crawl one cycle instead
    _reflex(g, obs) {
      const M = this.M, b = Math.atan2(obs[M.goal_sin], obs[M.goal_cos]), h = this.history || (this.history = []);
      const L = M.gaits.indexOf('left'), R = M.gaits.indexOf('right');
      if (M.use_reflex && (g === L || g === R) && h.length >= 2 && h[h.length - 1][0] === g && h[h.length - 2][0] === g &&
          Math.abs(b - h[h.length - 2][1]) < 4 * Math.PI / 180) { g = M.gaits.indexOf('inchworm'); this.reflexes = (this.reflexes || 0) + 1; this.reflexNote = true; }
      h.push([g, b]); if (h.length > 4) h.shift();
      return g;
    }

    // the reckless driver: course-following inchworm/steering that ignores tunnel height
    _recklessGait() {
      const st = this.sim.status(), [s] = this.path.project(st.com);
      const tgt = this.path.point(s + this.M.lookahead + 1);
      let err = (Math.atan2(tgt[1] - st.com[1], tgt[0] - st.com[0]) - st.yaw) * 180 / Math.PI;
      err = ((err + 180) % 360 + 360) % 360 - 180;
      return Math.abs(err) > 5 ? (err > 0 ? 2 : 3) : 0;
    }

    risk(obs) {
      const M = this.M, nA = M.actions.length, out = [];
      for (let a = 0; a < nA; a++) {
        const x = obs.concat(Array.from({ length: nA }, (_, i) => (i === a ? 1 : 0)));
        const ps = M.risk.map((net) => sigmoid(mlp(net, x)[0]));
        const mean = ps.reduce((u, v) => u + v, 0) / ps.length;
        const sd = Math.sqrt(ps.reduce((u, v) => u + (v - mean) * (v - mean), 0) / ps.length);
        out.push(mean + M.kappa * sd);
      }
      return out;
    }

    // choose and apply the next move
    decide() {
      const M = this.M, nA = M.actions.length, obs = this.observe();
      const m = this.mission;
      let a, note = '', risk = null, proposed;
      if (m.goal === 'stop') { a = 0; proposed = 0; note = 'mission: stop'; }
      else if (m.goal === 'distance' && this.progHist[this.progHist.length - 1] - this.startProg >= m.distance * this.sim.bodyLength) {
        a = 0; proposed = 0; note = `mission: reached ${m.distance} body lengths`; this.missionDone = true;
      } else {
        if (this.phase === 0) {
          if (this.driver === 'brain') {
            this.gaitProbs = softmax(mlp(M.policy, obs.slice(0, M.n_dyn)));
            this.gait = this._reflex(this.gaitProbs.indexOf(Math.max(...this.gaitProbs)), obs);
          } else { this.gait = this._recklessGait(); this.gaitProbs = null; }
        }
        proposed = M.cpg[this.gait][this.phase];
        this.phase = (this.phase + 1) % 4;
        a = proposed;
        if (this.useFilter) {
          risk = this.risk(obs);
          // preference: the rhythm's move, then REST, then the rest in index order (= Python's stable sort)
          const order = [proposed].concat(proposed === 0 ? [] : [0], [...Array(nA).keys()].filter((k) => k !== proposed && k !== 0));
          const budget = Math.max(m.tau, Math.min(...risk) + M.margin);
          a = order.find((k) => risk[k] <= budget);
          if (a !== proposed) { this.vetoes++; note = `vetoed ${M.actions[proposed].name} (risk ${risk[proposed].toFixed(2)})`; }
        }
      }
      this.last = { action: a, proposed, risk, note, gait: M.gaits[this.gait], gaitProbs: this.gaitProbs, obs };
      CL.applyCommand(this.sim, M.actions[a].cmd);
      this.pending = a;
      return a;
    }

    // after the 1.5 s of physics: same rules as brain/env.py
    finishDecision() {
      const a = this.pending, st = this.sim.status(), se = this.sim.sense();
      this.t++;
      this.restRun = a === 0 ? this.restRun + 1 : 0;
      this.repeat = a === this.prevAction ? this.repeat + 1 : 1;
      this.prevAction = a;
      const prog = this.path.project(st.com)[0];
      this.progHist.push(prog); if (this.progHist.length > 25) this.progHist.shift();
      const c = this.course, low = c.family === 'gaps' && !c.meta.passable;
      const fx = st.front[0];
      let failure = null;
      if (st.nan) failure = 'nan';
      else if (st.maxStrain > 0.09) failure = 'torn';
      else if (Math.abs(st.roll) > 50 * Math.PI / 180 || Math.abs(st.pitch) > 40 * Math.PI / 180) failure = 'flipped';
      else if (this.progHist.length > 8 && prog < this.progHist[this.progHist.length - 9] - 1.5) failure = 'slid';
      else if (low && fx > c.meta.gap_x + 0.6) failure = 'wedged';
      else if (this.progHist.length === 25 && this.restRun < 6 && prog - this.progHist[0] < 0.35) failure = 'stuck';
      const refusing = low && fx > c.meta.gap_x - 4 && fx < c.meta.gap_x + 0.6;
      let success = false;
      if (failure === 'stuck' && refusing) { failure = null; success = true; }
      if (!failure && !success) {
        if (this.path.total - prog < 0.8) success = true;
        else if (refusing && this.restRun >= 6) success = true;
        else if (this.missionDone && this.restRun >= 2) success = true;
      }
      if (this.t >= c.max_decisions && !failure) { success = success || refusing; if (!success) failure = 'timeout'; }
      this.progress = prog; this.wallForce = se.wallForce; this.strain = st.maxStrain;
      if (failure || success) {
        this.done = true;
        this.outcome = failure || (refusing && !(this.path.total - prog < 0.8) ? 'refused the tunnel (success)' : 'success');
      }
      return { failure, success };
    }
  }

  const api = { BrainEpisode, parseMission, Path, mlp };
  if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign({}, CL, api);
  else Object.assign(root.CreaseLab, api);
})(typeof window !== 'undefined' ? window : globalThis);
