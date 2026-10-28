// Uses the supplied Crease Lab source without modifying it.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const source = path.resolve(process.env.CREASE_LAB_DIR || path.join(__dirname, '../crease-lab'));
const CL = require(path.join(source, 'web/motion.js'));

function createSim({frictionScale=1, foldScale=1, dt=0.005}={}) {
  if (![frictionScale,foldScale,dt].every(Number.isFinite) || frictionScale<0 || foldScale<=0 || dt<=0)
    throw Error('Invalid experiment parameters');
  const sim=CL.buildMesh(CL.buildCrawlerPattern(CL.defaultRobot()), {
    axial:50, fold:0.12*foldScale, facet:0.12, SimClass:CL.RobotSim});
  if(dt>sim.dt) throw Error('Requested step exceeds source stability heuristic');
  sim.dt=dt;
  // GaitPlayer resets friction at phase changes: reapply scale after EVERY reset.
  const original=sim.setFeet.bind(sim);
  sim.setFeet=(mode,anchors)=>{
    original(mode,anchors);
    for(const key of ['muF','muB','muS']) for(let i=0;i<sim.N;i++) sim[key][i]*=frictionScale;
  };
  sim.setFeet('scales');
  sim.tensionScale=3.2; // fixed across stiffness; gait tension 0.8 => peak 2.56
  return sim;
}

function run(config={}) {
  const cfg={frictionScale:1,foldScale:1,dt:0.005,actuation:true,...config};
  const sim=createSim(cfg), player=new CL.GaitPlayer(CL.GAITS.inchworm);
  let maxPenetration=0,maxBarStrain=0, minLength=Infinity,maxLength=0;
  const check=()=>{
    if(!sim.x.every(Number.isFinite)||!sim.v.every(Number.isFinite)||!Number.isFinite(sim.work)) throw Error('non_finite_state');
    for(let i=2;i<sim.x.length;i+=3) maxPenetration=Math.max(maxPenetration,-sim.x[i]);
    for(const b of sim.allBars) {
      const d=Math.hypot(...[0,1,2].map(k=>sim.x[3*b.i+k]-sim.x[3*b.j+k]));
      maxBarStrain=Math.max(maxBarStrain,Math.abs(d/b.L0-1));
    }
  };
  const steps=(duration, driven=false, offset=0, measured=false)=>{
    const count=Math.round(duration/cfg.dt);
    if(Math.abs(count*cfg.dt-duration)>1e-9) throw Error('Step must divide experiment duration');
    for(let i=0;i<count;i++) {
      if(driven) player.apply(sim,offset+i*cfg.dt);
      sim.step(1); check();
      if(measured){const len=sim.length(); minLength=Math.min(minLength,len);maxLength=Math.max(maxLength,len);}
    }
  };
  try {
    steps(1.5); // settle with this condition's friction and stiffness
    steps(6,cfg.actuation); // one complete warm-up cycle
    const c0=sim.com(), heading=sim.heading(), w0=sim.work;
    const trajectory=[{time:0,com:c0,length:sim.length()}];
    for(let cycle=0;cycle<3;cycle++) {
      steps(6,cfg.actuation,6+cycle*6,true);
      trajectory.push({time:(cycle+1)*6,com:sim.com(),length:sim.length()});
    }
    const c1=sim.com();
    const forward=(c1[0]-c0[0])*Math.cos(heading)+(c1[1]-c0[1])*Math.sin(heading);
    return {config:cfg,status:'completed',metrics:{forwardDisplacement:forward,
      bodyLengthsPerCycle:forward/sim.bodyLength/3,meanForwardSpeed:forward/18,
      lateralDisplacement:-(c1[0]-c0[0])*Math.sin(heading)+(c1[1]-c0[1])*Math.cos(heading),
      positiveCableWork:sim.work-w0,minLength,maxLength,maxPenetration,maxBarStrain},trajectory};
  } catch(error) {return {config:cfg,status:'failed',failureReason:error.message,metrics:null};}
}

function sweep(){
  const rows=[];
  for(const foldScale of [0.5,1,2])for(const frictionScale of [0.25,1,2]) rows.push(run({foldScale,frictionScale}));
  const controls=[run({frictionScale:0}),run({actuation:false})];
  // Step-size sensitivity at EVERY swept point, not just one favorable result.
  const refined=rows.map(r=>run({...r.config,dt:0.0025}));
  const convergence=rows.map((r,i)=>({config:r.config,refinedStatus:refined[i].status,
    absoluteDifference:r.metrics&&refined[i].metrics?Math.abs(r.metrics.bodyLengthsPerCycle-refined[i].metrics.bodyLengthsPerCycle):null}));
  const hashes=Object.fromEntries(['core.js','motion.js'].map(f=>[f,createHash('sha256').update(fs.readFileSync(path.join(source,'web',f))).digest('hex')]));
  const result={schemaVersion:1,sourceHashes:hashes,model:'supplied Crease Lab bar-and-hinge crawler',
    protocol:{gait:'inchworm',axial:50,facet:0.12,baseFold:0.12,baseFriction:{forward:0.12,backward:1.2,lateral:0.8},
      peakCableTension:2.56,settle:1.5,warmup:6,measurement:18,units:'uncalibrated simulator units; not SI or hardware measurements'},
    rows,controls,refined,convergence};
  const output=path.join(__dirname,'results'); fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'sweep.json'),JSON.stringify(result,null,2)+'\n');
  console.table(rows.map(r=>({...r.config,status:r.status,progress:r.metrics?.bodyLengthsPerCycle})));
  console.log('Controls',controls.map(r=>({config:r.config,metrics:r.metrics})));
  console.log('Max step-size difference (body lengths/cycle):',Math.max(...convergence.map(c=>c.absoluteDifference??Infinity)));
  if([...rows,...controls,...refined].some(r=>r.status!=='completed'))process.exitCode=1;
}
module.exports={createSim,run};
if(require.main===module)sweep();
