// Flattens a circuit (with nested composite parts) into a netlist of primitive
// gates. A "net" is a single signal; every output pin drives exactly one net.
import { IN, OUT } from './parts.js';
/** Net 0 is tied low; unconnected inputs read from it. */
export const LOW = 0;
const MAX_DEPTH = 64;
class Builder {
  parent = [LOW];
  gates = [];
  newNet() {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(n) {
    while (this.parent[n] !== n) {
      this.parent[n] = this.parent[this.parent[n]];
      n = this.parent[n];
    }
    return n;
  }
  /** Make a and b the same signal. LOW always stays the root. */
  alias(a, b) {
    const ra = this.find(a),
      rb = this.find(b);
    if (ra === rb) return;
    if (ra === LOW) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
}
export function compile(lib, circuit) {
  const b = new Builder();
  const topInputs = new Map();
  const topPins = new Map();
  const expand = (c, bind, depth) => {
    if (depth > MAX_DEPTH) throw new Error('Parts are nested too deeply (is a part inside itself?).');
    // Allocate a net for every output pin up front, so wires can form loops.
    const outNet = new Map();
    for (const n of c.nodes) {
      const def = lib.get(n.part);
      if (!def) throw new Error(`Unknown part "${n.part}".`);
      for (const p of def.outputs) outNet.set(`${n.id}:${p}`, b.newNet());
    }
    const driver = new Map();
    for (const w of c.wires) {
      const net = outNet.get(`${w.from.node}:${w.from.pin}`);
      if (net !== undefined) driver.set(`${w.to.node}:${w.to.pin}`, net);
    }
    const src = (node, pin) => driver.get(`${node}:${pin}`) ?? LOW;
    const results = new Map();
    for (const n of c.nodes) {
      const def = lib.get(n.part);
      const label = (n.label ?? '').trim();
      const outs = def.outputs.map((p) => outNet.get(`${n.id}:${p}`));
      const ins = def.inputs.map((p) => src(n.id, p));
      if (bind === null) {
        def.outputs.forEach((p, i) => topPins.set(`${n.id}:${p}`, outs[i]));
        def.inputs.forEach((p, i) => topPins.set(`${n.id}:${p}`, ins[i]));
      }
      if (n.part === IN) {
        if (bind) b.alias(outs[0], bind.get(label) ?? LOW);
        else if (!topInputs.has(label)) topInputs.set(label, outs[0]);
      } else if (n.part === OUT) {
        if (!results.has(label)) results.set(label, ins[0]);
      } else if (def.eval) {
        b.gates.push({ partId: def.id, eval: def.eval, ins, outs });
      } else if (def.circuit) {
        const inner = new Map(def.inputs.map((p, i) => [p, ins[i]]));
        const res = expand(def.circuit, inner, depth + 1);
        def.outputs.forEach((p, i) => b.alias(outs[i], res.get(p) ?? LOW));
      }
    }
    return results;
  };
  const topOutputs = expand(circuit, null, 0);
  // Collapse aliased nets into a compact numbering.
  const index = new Map([[LOW, LOW]]);
  const resolve = (n) => {
    const r = b.find(n);
    if (!index.has(r)) index.set(r, index.size);
    return index.get(r);
  };
  const remap = (m) => new Map([...m].map(([k, v]) => [k, resolve(v)]));
  const gates = b.gates.map((g) => ({ ...g, ins: g.ins.map(resolve), outs: g.outs.map(resolve) }));
  return {
    gates,
    inputs: remap(topInputs),
    outputs: remap(topOutputs),
    pinNets: remap(topPins),
    netCount: Math.max(index.size, 1),
  };
}
/** Compile a saved part by id (its inner circuit becomes the top level). */
export function compilePart(lib, partId) {
  const def = lib.get(partId);
  if (!def) throw new Error(`Unknown part "${partId}".`);
  if (def.circuit) return compile(lib, def.circuit);
  // Wrap a primitive so it can be simulated on its own.
  return compile(lib, {
    nodes: [
      { id: 'g', part: def.id, x: 0, y: 0 },
      ...def.inputs.map((p, i) => ({ id: `i${i}`, part: IN, x: 0, y: i, label: p })),
      ...def.outputs.map((p, i) => ({ id: `o${i}`, part: OUT, x: 0, y: i, label: p })),
    ],
    wires: [
      ...def.inputs.map((p, i) => ({ from: { node: `i${i}`, pin: 'out' }, to: { node: 'g', pin: p } })),
      ...def.outputs.map((p, i) => ({ from: { node: 'g', pin: p }, to: { node: `o${i}`, pin: 'in' } })),
    ],
  });
}
