import test from 'node:test';
import assert from 'node:assert/strict';
import {collectEpisodes, summarize} from './evaluate.mjs';

test('evaluation preserves failures, deduplicates geometry and passes equal-speed controls',()=>{
  const episodes=collectEpisodes(), summary=summarize(episodes);
  assert.equal(new Set(episodes.map(e=>e.episodeId)).size,episodes.length);
  assert.equal(episodes.filter(e=>e.source.kind==='open').length,24);
  assert.ok(episodes.some(e=>!e.success));
  for(const e of episodes.filter(e=>!e.success)) {
    assert.equal(e.metrics.time,null);
    assert.equal(e.failureReason,'no_route_on_discretization');
  }
  assert.ok(summary.negativeControl.cases>0);
  assert.equal(summary.negativeControl.violations,0);
  assert.ok(summary.paired.some(p=>p.compactSpeed===0.5 && p.timeSaved>0));
});

test('paired comparison never substitutes zero time for an unsuccessful robot',()=>{
  const common={conditionId:'case',source:{kind:'sealed'},parameters:{compactSpeed:0.5,switchCost:1}};
  const summary=summarize([
    {...common,robot:'Fixed compact',success:false,metrics:{time:null}},
    {...common,robot:'Reconfigurable',success:true,metrics:{time:12}}
  ]);
  assert.equal(summary.paired[0].timeSaved,null);
  assert.equal(summary.rows[0].meanTimeSuccessful,null);
  assert.equal(summary.rows[0].failures,1);
});
