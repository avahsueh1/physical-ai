import test from 'node:test';import assert from 'node:assert/strict';
import {makeMap,compare,clear,edgeClear,MODES} from './engine.js';
test('seed reproduces geometry',()=>assert.deepEqual(makeMap(7),makeMap(7)));
test('swept collision rejects thin wall between safe endpoints',()=>{const m={width:100,height:100,walls:[{x:49,y:0,w:2,h:100}]};assert(clear(m,40,50,2));assert(clear(m,60,50,2));assert(!edgeClear(m,{x:40,y:50},{x:60,y:50},2));});
test('open world has analytical travel time',()=>{for(const r of compare(makeMap(1,30,'open'))){assert(r.success);assert.equal(r.time,17);assert.equal(r.distance,680);}});
test('blocked passage fails explicitly for larger bodies',()=>{const rs=compare(makeMap(3,20,'sealed'));assert(rs[0].success);assert(!rs[1].success);assert(!rs[2].success);assert(rs[3].success);});
test('equal speed: adaptation cannot beat fixed compact',()=>{for(let seed=1;seed<=8;seed++){const rs=compare(makeMap(seed));assert.equal(rs[0].time,rs[3].time);}});
test('all planned segments and shape transitions are collision free',()=>{for(let seed=1;seed<=5;seed++){const map=makeMap(seed);for(const r of compare(map,{compactSpeed:0.5,switchCost:1})){for(let i=0;i<r.path.length;i++){const a=r.path[i];assert(clear(map,a.x,a.y,MODES[a.m].radius));if(i){const b=r.path[i-1];assert(a.t>=b.t);assert(edgeClear(map,a,b,Math.max(MODES[a.m].radius,MODES[b.m].radius)));}}}}});
