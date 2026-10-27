// Geometric planning model. Units are abstract; no forces or physical energy.
export const MODES = [{name:'Compact',radius:8},{name:'Medium',radius:14},{name:'Wide',radius:22}];
export const ROBOTS = [{name:'Fixed compact',modes:[0],color:'#a26427'},{name:'Fixed medium',modes:[1],color:'#805b99'},{name:'Fixed wide',modes:[2],color:'#567286'},{name:'Reconfigurable',modes:[0,1,2],color:'#087f78'}];
export function makeMap(seed=1,gap=30,kind='passages') {
  let s=seed>>>0; const rand=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};
  const walls=[];
  if(kind!=='open') for(const x of [260,510]) {
    const y=100+Math.round(rand()*16)*10;
    walls.push({x,y:0,w:20,h:y-gap/2},{x,y:y+gap/2,w:20,h:(kind==='sealed'?480:380)-(y+gap/2)});
  }
  return {width:800,height:480,step:10,start:{x:60,y:240},goal:{x:740,y:240},walls,seed,gap,kind};
}
export function clear(map,x,y,r) {
  if(x-r<0||y-r<0||x+r>map.width||y+r>map.height)return false;
  return map.walls.every(o=>Math.hypot(x-Math.max(o.x,Math.min(x,o.x+o.w)),y-Math.max(o.y,Math.min(y,o.y+o.h)))>r+0.001);
}
export function edgeClear(map,a,b,r) {
  // Axis-aligned translation: exact swept disk vs axis-aligned rectangles.
  if(!clear(map,a.x,a.y,r)||!clear(map,b.x,b.y,r))return false;
  const loX=Math.min(a.x,b.x),hiX=Math.max(a.x,b.x),loY=Math.min(a.y,b.y),hiY=Math.max(a.y,b.y);
  return map.walls.every(o=>Math.hypot(Math.max(o.x-hiX,loX-o.x-o.w,0),Math.max(o.y-hiY,loY-o.y-o.h,0))>r+0.001);
}
class Heap {
  a=[];
  push(v){let i=this.a.length;this.a.push(v);while(i){const p=(i-1)>>1;if(this.a[p].cost<=v.cost)break;this.a[i]=this.a[p];i=p;}this.a[i]=v;}
  pop(){const first=this.a[0],last=this.a.pop();if(this.a.length){let i=0;while(i*2+1<this.a.length){let c=i*2+1;if(c+1<this.a.length&&this.a[c+1].cost<this.a[c].cost)c++;if(this.a[c].cost>=last.cost)break;this.a[i]=this.a[c];i=c;}this.a[i]=last;}return first;}
}
export function plan(map,robot,options={}) {
  const {compactSpeed=1,switchCost=1}=options;
  if(!(compactSpeed>0&&compactSpeed<=1&&switchCost>=0))throw Error('Invalid planner options');
  const speed=[40*compactSpeed,40,40],cols=map.width/map.step+1,rows=map.height/map.step+1;
  const key=(x,y,m)=>(y*cols+x)*3+m;
  const decode=k=>({x:Math.floor(k/3)%cols*map.step,y:Math.floor(Math.floor(k/3)/cols)*map.step,m:k%3});
  const costs=new Float64Array(cols*rows*3).fill(Infinity),prev=new Int32Array(costs.length).fill(-1),heap=new Heap();
  // All allowed start modes are free choices; no artificial wide-start disadvantage.
  for(const m of robot.modes)if(clear(map,map.start.x,map.start.y,MODES[m].radius)){const k=key(map.start.x/map.step,map.start.y/map.step,m);costs[k]=0;heap.push({k,cost:0});}
  let end=-1,expanded=0;
  while(heap.a.length){const cur=heap.pop();if(cur.cost!==costs[cur.k])continue;const a=decode(cur.k);expanded++;
    if(a.x===map.goal.x&&a.y===map.goal.y){end=cur.k;break;}
    const relax=(x,y,m,dt)=>{const k=key(x/map.step,y/map.step,m),cost=cur.cost+dt;if(cost+1e-9<costs[k]){costs[k]=cost;prev[k]=cur.k;heap.push({k,cost});}};
    for(const [dx,dy] of [[10,0],[-10,0],[0,10],[0,-10]]){const b={x:a.x+dx,y:a.y+dy};if(edgeClear(map,a,b,MODES[a.m].radius))relax(b.x,b.y,a.m,map.step/speed[a.m]);}
    for(const m of robot.modes)if(m!==a.m&&clear(map,a.x,a.y,Math.max(MODES[m].radius,MODES[a.m].radius)))relax(a.x,a.y,m,switchCost);
  }
  if(end<0)return {name:robot.name,success:false,path:[],time:null,distance:null,switches:0,expanded};
  const path=[];for(let k=end;k>=0;k=prev[k])path.push({...decode(k),t:costs[k]});path.reverse();
  let distance=0,switches=0;for(let i=1;i<path.length;i++){distance+=Math.hypot(path[i].x-path[i-1].x,path[i].y-path[i-1].y);switches+=+(path[i].m!==path[i-1].m);}
  return {name:robot.name,success:true,path,time:costs[end],distance,switches,expanded};
}
export function compare(map,options){return ROBOTS.map(r=>plan(map,r,options));}
