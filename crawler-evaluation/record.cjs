const {createSim}=require('./sweep.cjs');
const path=require('node:path');
const fs=require('node:fs');
const CL=require(path.join(path.resolve(process.env.CREASE_LAB_DIR||path.join(__dirname,'../crease-lab')),'web/motion.js'));
const recordings=[];
for(const config of [{foldScale:1,frictionScale:1},{foldScale:2,frictionScale:0.25}]){
  const sim=createSim(config), player=new CL.GaitPlayer(CL.GAITS.inchworm);
  sim.step(300);
  for(let i=0;i<1200;i++){player.apply(sim,i*sim.dt);sim.step(1);}
  const origin=sim.com(),heading=sim.heading();
  const frames=[];
  for(let frame=0;frame<=360;frame++){
    const com=sim.com();
    frames.push({time:frame*.05,positions:Array.from(sim.x),
      progress:((com[0]-origin[0])*Math.cos(heading)+(com[1]-origin[1])*Math.sin(heading))/sim.bodyLength,
      phase:player.phaseAt(6+frame*.05).i===0?'PULL CABLES':'RELEASE'});
    if(frame<360)for(let j=0;j<10;j++){player.apply(sim,6+(frame*10+j)*sim.dt);sim.step(1);}
  }
  recordings.push({config,origin,bodyLength:sim.bodyLength,
    edges:sim.allBars.map(b=>[b.i,b.j]),bodyEdges:sim.bars.map(b=>[b.i,b.j]),frames});
}
fs.mkdirSync(path.join(__dirname,'results'),{recursive:true});
fs.writeFileSync(path.join(__dirname,'results/replay.json'),JSON.stringify({fps:20,recordings}));
// Check replay endpoint against the independently recorded sweep result.
const results=JSON.parse(fs.readFileSync(path.join(__dirname,'results/sweep.json')));
for(const r of recordings){
  const expected=results.rows.find(e=>e.config.foldScale===r.config.foldScale&&e.config.frictionScale===r.config.frictionScale);
  if(Math.abs(r.frames.at(-1).progress/3-expected.metrics.bodyLengthsPerCycle)>1e-10)throw Error('Replay/sweep mismatch');
}
console.log('Recorded two 18-unit trajectories at 20 frames per unit; sweep endpoints match.');
