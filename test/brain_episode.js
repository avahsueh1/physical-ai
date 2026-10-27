// Run the browser brain headless: node test/brain_episode.js <brain-model.js> <course index> <max moves>
const CL=require(require('path').join(__dirname, '..', 'web', 'brain-web.js'));
const M=require(process.argv[2]); const ci=+process.argv[3], n=+process.argv[4];
const ep=new CL.BrainEpisode(M, M.courses[ci], {driver:'brain', filter:true, mission:'go forward'});
const acts=[];
for(let k=0;k<n && !ep.done;k++){ acts.push(ep.decide()); ep.sim.step(ep.substeps); ep.finishDecision(); }
console.log(JSON.stringify({acts, outcome:ep.outcome, course:M.courses[ci].family+':'+M.courses[ci].seed}));
