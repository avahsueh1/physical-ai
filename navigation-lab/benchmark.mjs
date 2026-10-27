import {compare,makeMap} from './engine.js';
import {writeFileSync} from 'node:fs';
const rows=[];
for(const compactSpeed of [1,0.5])for(const kind of ['open','passages','sealed'])for(const gap of [20,30,50])for(let seed=1;seed<=10;seed++)for(const r of compare(makeMap(seed,gap,kind),{compactSpeed,switchCost:1})) {
  const {path,...metrics}=r;rows.push({seed,kind,gap,compactSpeed,switchCost:1,...metrics});
}
writeFileSync(new URL('benchmark-results.json',import.meta.url),JSON.stringify({model:'geometric-disks-v1',units:'abstract distance; assumed speed; not physical measurements',rows},null,2));
for(const speed of [1,0.5])for(const name of [...new Set(rows.map(r=>r.name))]){const rs=rows.filter(r=>r.compactSpeed===speed&&r.name===name),ok=rs.filter(r=>r.success);console.log(JSON.stringify({compactSpeed:speed,name,successes:ok.length,trials:rs.length,meanTimeSuccessful:ok.length?ok.reduce((a,r)=>a+r.time,0)/ok.length:null}));}
