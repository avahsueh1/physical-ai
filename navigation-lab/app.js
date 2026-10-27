import {makeMap,compare,ROBOTS,MODES} from './engine.js';
const $=id=>document.getElementById(id),canvas=$('arena'),ctx=canvas.getContext('2d');
let map,results,options,duration=0,elapsed=0,playing=false,last=0;
const fmt=v=>v===null?'—':v.toFixed(2);
$('legend').innerHTML=ROBOTS.map(r=>`<span><i class="dot" style="background:${r.color}"></i>${r.name}</span>`).join('');
function compute(){playing=false;$('play').textContent='Play comparison';map=makeMap(Number($('seed').value),Number($('gap').value),$('kind').value);options={compactSpeed:Number($('speed').value),switchCost:Number($('switchCost').value)};results=compare(map,options);duration=Math.max(0,...results.map(r=>r.time||0));elapsed=0;$('time').value=0;
 $('rows').innerHTML=results.map((r,i)=>`<tr><td><i class="dot" style="background:${ROBOTS[i].color}"></i>${r.name}</td><td>${r.success?'Yes':'No route'}</td><td>${fmt(r.time)}</td><td>${r.distance??'—'}</td><td>${r.switches}</td></tr>`).join('');
 const adaptive=results[3],best=results.slice(0,3).filter(r=>r.success).sort((a,b)=>a.time-b.time)[0];
 $('finding').textContent=!adaptive.success?'No robot found a route on this grid. Try a wider opening or allow a detour.':best&&Math.abs(best.time-adaptive.time)<1e-7?`Reconfiguration ties ${best.name.toLowerCase()}. This setting gives no travel-time advantage to changing shape.`:best?`Reconfiguration saves ${(best.time-adaptive.time).toFixed(2)} time units versus the best fixed body. This result depends on the selected speed and shape-change assumptions.`:'Only the reconfigurable robot found a route.';draw();
}
function pose(r){if(!r.success)return null;let i=1;while(i<r.path.length&&r.path[i].t<elapsed)i++;if(i===r.path.length)return {...r.path.at(-1),radius:MODES[r.path.at(-1).m].radius};const b=r.path[i],a=r.path[i-1],f=b.t===a.t?1:Math.max(0,Math.min(1,(elapsed-a.t)/(b.t-a.t)));return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,radius:MODES[a.m].radius+(MODES[b.m].radius-MODES[a.m].radius)*f};}
function draw(){ctx.clearRect(0,0,800,480);ctx.strokeStyle='#e2eaf0';ctx.lineWidth=1;for(let x=0;x<=800;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,480);ctx.stroke();}for(let y=0;y<=480;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(800,y);ctx.stroke();}
 for(const o of map.walls){ctx.fillStyle='#bccbd4';ctx.fillRect(o.x,o.y,o.w,o.h);ctx.strokeStyle='#8fa6b4';ctx.strokeRect(o.x,o.y,o.w,o.h);}
 for(const [i,r]of results.entries()){if(!r.success)continue;ctx.beginPath();ctx.strokeStyle=ROBOTS[i].color;ctx.globalAlpha=.45;ctx.lineWidth=i===3?3:1.8;ctx.setLineDash(i===3?[]:[5,5]);r.path.forEach((p,j)=>j?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();}ctx.globalAlpha=1;ctx.setLineDash([]);
 for(const [label,p] of [['Start',map.start],['Goal',map.goal]]){ctx.fillStyle='#20343e';ctx.font='13px Segoe UI';ctx.fillText(label,p.x-14,p.y-35);ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fill();}
 for(const i of [2,1,0,3]){const p=pose(results[i]);if(!p)continue;ctx.strokeStyle=ROBOTS[i].color;ctx.fillStyle=ROBOTS[i].color+'25';ctx.lineWidth=i===3?3:2;ctx.beginPath();ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);ctx.fill();ctx.stroke();if(i===3){ctx.beginPath();for(let j=0;j<8;j++){const a=j*Math.PI/4;ctx.moveTo(p.x,p.y);ctx.lineTo(p.x+Math.cos(a)*p.radius,p.y+Math.sin(a)*p.radius);}ctx.stroke();}}
 $('clock').textContent=`${elapsed.toFixed(1)} / ${duration.toFixed(1)} time units`;
}
$('controls').addEventListener('submit',e=>{e.preventDefault();compute();});
for(const id of ['gap','speed'])$(id).addEventListener('input',()=>$(id+'Value').textContent=id==='gap'?$(id).value:Number($(id).value).toFixed(2)+'×');
$('tradeoff').onclick=()=>{$('speed').value=.5;$('speedValue').textContent='0.50×';$('gap').value=20;$('gapValue').textContent='20';$('kind').value='sealed';compute();};
$('play').onclick=()=>{if(elapsed>=duration)elapsed=0;playing=!playing;$('play').textContent=playing?'Pause':'Play comparison';};
$('reset').onclick=()=>{playing=false;elapsed=0;$('time').value=0;$('play').textContent='Play comparison';draw();};
$('time').oninput=()=>{playing=false;$('play').textContent='Play comparison';elapsed=Number($('time').value)/1000*duration;draw();};
$('download').onclick=()=>{const blob=new Blob([JSON.stringify({model:'geometric-disks-v1',map,options,results},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`navigation-seed-${map.seed}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
function frame(t){if(playing){elapsed=Math.min(duration,elapsed+Math.min((t-last)/1000,.1)*3);$('time').value=duration?elapsed/duration*1000:0;if(elapsed>=duration){playing=false;$('play').textContent='Play comparison';}draw();}last=t;requestAnimationFrame(frame);}compute();requestAnimationFrame(frame);
