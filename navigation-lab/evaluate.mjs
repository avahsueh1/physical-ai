import {compare, makeMap} from './engine.js';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
export function collectEpisodes() {
  const episodes = [], seen = new Set();
  const engineSha256 = hash(readFileSync(new URL('./engine.js', import.meta.url)));
  for (const compactSpeed of [1, 0.5]) for (const switchCost of [0, 1, 5])
    for (const kind of ['open', 'passages', 'sealed']) for (const gap of [20, 30, 50])
      for (let seed = 1; seed <= 10; seed++) {
        const map = makeMap(seed, gap, kind);
        // Identity is actual geometry, not the generator's seed or gap labels.
        const {seed: unusedSeed, gap: unusedGap, kind: unusedKind, ...geometry} = map;
        const scenarioId = hash(JSON.stringify(geometry));
        const conditionId = `${scenarioId}:${compactSpeed}:${switchCost}`;
        if (seen.has(conditionId)) continue;
        seen.add(conditionId);
        for (const result of compare(map, {compactSpeed, switchCost})) {
          episodes.push({schemaVersion: 1, episodeId: `${conditionId}:${result.name}`,
            scenarioId, conditionId, backend: 'geometric-disks-v1', engineSha256,
            controller: 'full-map-dijkstra', robot: result.name,
            source: {seed, gap, kind}, map: geometry,
            parameters: {compactSpeed, switchCost},
            units: {time: 'abstract', distance: 'abstract', energy: 'unmeasured'},
            success: result.success,
            failureReason: result.success ? null : 'no_route_on_discretization',
            metrics: {time: result.time, distance: result.distance,
              shapeChanges: result.success ? result.switches : null,
              expandedStates: result.expanded, collisions: null, energy: null},
            trajectory: result.path});
        }
      }
  return episodes;
}

export function summarize(episodes) {
  const groups = new Map(), pairs = new Map();
  for (const e of episodes) {
    const key = JSON.stringify([e.source.kind, e.parameters.compactSpeed, e.parameters.switchCost, e.robot]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
    if (!pairs.has(e.conditionId)) pairs.set(e.conditionId, new Map());
    pairs.get(e.conditionId).set(e.robot, e);
  }
  const rows = [...groups.values()].map(es => {
    const first = es[0], ok = es.filter(e => e.success);
    return {kind: first.source.kind, ...first.parameters, robot: first.robot,
      scenarios: es.length, successes: ok.length, failures: es.length-ok.length,
      meanTimeSuccessful: ok.length ? ok.reduce((s,e)=>s+e.metrics.time,0)/ok.length : null};
  });
  const paired = [];
  for (const [conditionId, robots] of pairs) {
    const fixed = robots.get('Fixed compact'), adaptive = robots.get('Reconfigurable');
    if (!fixed || !adaptive) continue;
    paired.push({conditionId, ...fixed.parameters,
      fixedSuccess: fixed.success, adaptiveSuccess: adaptive.success,
      timeSaved: fixed.success && adaptive.success ? fixed.metrics.time-adaptive.metrics.time : null});
  }
  const controls = paired.filter(p=>p.compactSpeed===1);
  const violations = controls.filter(p=>p.fixedSuccess!==p.adaptiveSuccess ||
    (p.timeSaved!==null && Math.abs(p.timeSaved)>1e-7));
  return {rows, paired, negativeControl: {cases: controls.length, violations: violations.length}};
}

export function markdownReport(episodes, summary) {
  const fmt = n => n===null ? 'N/A' : n.toFixed(3);
  return `# Morphology baseline evaluation\n\n` +
    `Generated from engine SHA-256: \`${episodes[0]?.engineSha256 ?? 'none'}\`.\n\n` +
    `${episodes.length} robot runs; duplicate geometries within each parameter condition removed. These are deterministic designed cases, not independent real-world trials.\n\n` +
    `Equal-speed negative control: ${summary.negativeControl.cases} paired cases, ${summary.negativeControl.violations} violations. Fixed compact should tie adaptive when all shapes have equal speed.\n\n` +
    `| Map | Compact speed | Change cost | Robot | Success / cases | Failures | Mean time (success only) |\n|---|---:|---:|---|---:|---:|---:|\n` +
    summary.rows.map(r=>`| ${r.kind} | ${r.compactSpeed} | ${r.switchCost} | ${r.robot} | ${r.successes}/${r.scenarios} | ${r.failures} | ${fmt(r.meanTimeSuccessful)} |`).join('\n') +
    `\n\n## Interpretation limits\n\n` +
    `Times and speed tradeoffs are abstract assumptions. Success means a planner found a route on its grid. Failure is not proof of physical infeasibility. All planners know the complete map. Collision counts and energy are unmeasured (null), not zero. There is no friction, stiffness, sensor, learned-policy, actuator, or hardware model.\n\n` +
    `Conditional means use each robot's successful cases and must not be treated as matched comparisons. summary.json also includes paired fixed-compact/adaptive outcomes; timeSaved is computed only when both succeed. A positive value favors adaptive.\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const episodes = collectEpisodes(), summary = summarize(episodes);
  const output = new URL('./evaluation-output/', import.meta.url);
  mkdirSync(output, {recursive:true});
  writeFileSync(new URL('episodes.jsonl',output), episodes.map(e=>JSON.stringify(e)).join('\n')+'\n');
  writeFileSync(new URL('summary.json',output), JSON.stringify(summary,null,2)+'\n');
  writeFileSync(new URL('report.md',output), markdownReport(episodes,summary));
  console.log(JSON.stringify({episodes:episodes.length, ...summary.negativeControl, output:fileURLToPath(output)}));
  if(summary.negativeControl.violations) process.exitCode=1;
}
