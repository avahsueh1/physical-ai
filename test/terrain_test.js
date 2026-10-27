const assert = require('assert');
const CL = require('../web/terrain.js');
const P = CL.defaultRobot();
function runGait(sim, gaitKey, cycles) {
  const g = CL.GAITS[gaitKey]; const player = new CL.GaitPlayer(g); const per = player.period();
  let t = 0; const end = per * cycles;
  sim.tensionScale = CL.tensionScaleFor(sim);
  while (t < end) { player.apply(sim, t); sim.step(5); t += 5 * sim.dt; }
}
function fwd(sim, c0, h0) { const c = sim.com(); return (c[0]-c0[0])*Math.cos(h0)+(c[1]-c0[1])*Math.sin(h0); }

// 1. flat terrain reproduces the original Move bench crawler
{
  const ref = CL.evaluateGait(P, CL.GAITS.inchworm, { cycles: 3 });
  const s = CL.buildTerrainRobot(P, {});
  const c0 = s.com(), h0 = s.heading(); runGait(s, 'inchworm', 4);
  const d = fwd(s, c0, h0);
  console.log('flat: original perCycle(body len)', ref.perCycle.toFixed(3), '| terrain sim 4 cycles distance', d.toFixed(3), '=> per cycle/body', (d/4/s.bodyLength).toFixed(3));
}
// 2. wall ahead blocks progress, and the forward range finder sees it
{
  const s = CL.buildTerrainRobot(P, { boxes: [{ cx: 6.5, cy: 0, cz: 1, hx: 0.25, hy: 3, hz: 1 }] });
  console.log('wall: fwd range at start', s.sense().ranges.fwd.toFixed(2));
  const c0 = s.com(), h0 = s.heading(); runGait(s, 'inchworm', 12);
  const st = s.status();
  console.log('wall: front plate x', s.frame().front[0].toFixed(2), '(wall face at 6.25) wallForce', st.wallForce.toFixed(2), 'fwd range', s.sense().ranges.fwd.toFixed(2));
}
// 3. uphill ramp slows it, slippery patch slows it
{
  const up = CL.buildTerrainRobot(P, { ground: { segments: [{ x0: -10, x1: 0, z0: 0, z1: 0 }, { x0: 0, x1: 30, z0: 0, z1: 30 * Math.tan(10*Math.PI/180) }] } });
  let c0 = up.com(), h0 = up.heading(); runGait(up, 'inchworm', 4);
  const ice = CL.buildTerrainRobot(P, { patches: [{ x0: -10, x1: 30, y0: -10, y1: 10, mu: 0.25 }] });
  let c1 = ice.com(), h1 = ice.heading(); runGait(ice, 'inchworm', 4);
  console.log('10deg uphill distance', fwd(up, c0, h0).toFixed(3), '| ice distance', fwd(ice, c1, h1).toFixed(3), '| pitch on ramp (deg)', (up.frame().pitch*180/Math.PI).toFixed(1));
}
// 4. low ceiling: range finder 'up' sees it; status height
{
  const s = CL.buildTerrainRobot(P, { boxes: [{ cx: 8, cy: 0, cz: 2.6, hx: 2, hy: 3, hz: 0.5 }] });
  console.log('body height', s.status().height.toFixed(2), '| fwdUp range', s.sense().ranges.fwdUp.toFixed(2));
}
// 5. snapshot/restore is exact (same future after rewind)
{
  const s = CL.buildTerrainRobot(P, { boxes: [{ cx: 5, cy: 1.2, cz: 0.2, hx: 0.3, hy: 0.3, hz: 0.2, yaw: 0.4 }] });
  CL.applyCommand(s, { contract: 1, bend: 0.3, dir: 0 });
  s.step(50);
  const snap = s.snapshot();
  s.step(300); const a = s.nodes();
  s.restore(snap); s.step(300); const b = s.nodes();
  let md = 0; for (let i = 0; i < a.length; i++) md = Math.max(md, Math.abs(a[i]-b[i]));
  console.log('rewind max diff', md);
  assert(md === 0, 'restore must be exact');
}
// 6. timing
{
  const s = CL.buildTerrainRobot(P, { boxes: Array.from({length: 30}, (_, k) => ({ cx: 3 + k, cy: (k%3-1)*2, cz: 0.15, hx: 0.2, hy: 0.2, hz: 0.15 })) });
  const t0 = Date.now(); runGait(s, 'inchworm', 3);
  console.log('3 gait cycles with 30 rocks: wall ms', Date.now() - t0);
}
console.log('OK');
