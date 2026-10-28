const test=require('node:test');
const assert=require('node:assert/strict');
const {createSim,run}=require('./sweep.cjs');
test('friction scaling survives gait phase resets without compounding',()=>{
  const s=createSim({frictionScale:2});
  for(let k=0;k<3;k++){s.setFeet('scales');assert.equal(s.muF[0],0.24);assert.equal(s.muB[0],2.4);}
});
test('fold sweep holds axial stiffness, facet stiffness and force scale fixed',()=>{
  const a=createSim({foldScale:0.5}), b=createSim({foldScale:2});
  assert.equal(b.opts.fold/a.opts.fold,4);
  assert.equal(a.opts.axial,b.opts.axial);assert.equal(a.opts.facet,b.opts.facet);
  assert.equal(a.tensionScale,b.tensionScale);assert.equal(a.dt,b.dt);
});
test('without ground friction internal actuation cannot translate horizontal COM',()=>{
  const r=run({frictionScale:0});assert.equal(r.status,'completed');
  assert.ok(Math.abs(r.metrics.forwardDisplacement)<1e-8);
  assert.ok(Math.abs(r.metrics.lateralDisplacement)<1e-8);
});
