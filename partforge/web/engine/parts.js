// Part model: everything you can place on the board is a "part".
// Primitive parts are evaluated directly; composite parts are circuits made of
// other parts, so you can build a NOT gate out of NANDs, an adder out of your
// NOT gate, and so on.
export const IN = 'IN';
export const OUT = 'OUT';
export const PRIMITIVES = [
  {
    id: IN,
    name: 'Input',
    inputs: [],
    outputs: ['out'],
    builtin: true,
    description: 'A pin into this circuit. Its label becomes the pin name when saved as a part.',
  },
  {
    id: OUT,
    name: 'Output',
    inputs: ['in'],
    outputs: [],
    builtin: true,
    description: 'A pin out of this circuit. Its label becomes the pin name when saved as a part.',
  },
  {
    id: 'NAND',
    name: 'NAND',
    inputs: ['a', 'b'],
    outputs: ['out'],
    builtin: true,
    description: 'The universal gate: every other gate can be built from it.',
    eval: ([a, b]) => [!(a && b)],
  },
  { id: 'AND', name: 'AND', inputs: ['a', 'b'], outputs: ['out'], builtin: true, eval: ([a, b]) => [a && b] },
  { id: 'OR', name: 'OR', inputs: ['a', 'b'], outputs: ['out'], builtin: true, eval: ([a, b]) => [a || b] },
  {
    id: 'NOR',
    name: 'NOR',
    inputs: ['a', 'b'],
    outputs: ['out'],
    builtin: true,
    eval: ([a, b]) => [!(a || b)],
  },
  {
    id: 'XOR',
    name: 'XOR',
    inputs: ['a', 'b'],
    outputs: ['out'],
    builtin: true,
    eval: ([a, b]) => [a !== b],
  },
  { id: 'NOT', name: 'NOT', inputs: ['in'], outputs: ['out'], builtin: true, eval: ([a]) => [!a] },
  {
    id: 'HIGH',
    name: 'HIGH',
    inputs: [],
    outputs: ['out'],
    builtin: true,
    description: 'Always on.',
    eval: () => [true],
  },
];
/** Pin order of a composite part follows the vertical order of its IN/OUT nodes. */
export function deriveInterface(c) {
  const pins = (kind) =>
    c.nodes
      .filter((n) => n.part === kind)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((n) => (n.label ?? '').trim());
  return { inputs: pins(IN), outputs: pins(OUT) };
}
export class PartLibrary {
  parts = new Map();
  constructor() {
    for (const p of PRIMITIVES) this.parts.set(p.id, p);
  }
  get(id) {
    return this.parts.get(id);
  }
  all() {
    return [...this.parts.values()];
  }
  /** True if `partId` uses `target` anywhere inside it (or is it). */
  dependsOn(partId, target, seen = new Set()) {
    if (partId === target) return true;
    if (seen.has(partId)) return false;
    seen.add(partId);
    const def = this.parts.get(partId);
    if (!def?.circuit) return false;
    return def.circuit.nodes.some((n) => this.dependsOn(n.part, target, seen));
  }
  /** Parts whose circuits directly contain `id`. */
  usedBy(id) {
    return this.all()
      .filter((p) => p.circuit?.nodes.some((n) => n.part === id))
      .map((p) => p.id);
  }
  /** Check a circuit could be saved as part `id`. Returns a list of problems. */
  validate(id, circuit) {
    const errors = [];
    const existing = this.parts.get(id);
    if (existing?.builtin) errors.push(`"${id}" is a built-in part.`);
    for (const n of circuit.nodes) {
      if (!this.parts.has(n.part)) errors.push(`Unknown part "${n.part}".`);
      else if (this.dependsOn(n.part, id)) errors.push(`A part can't contain itself (via "${n.part}").`);
    }
    const { inputs, outputs } = deriveInterface(circuit);
    for (const [kind, names] of [
      ['input', inputs],
      ['output', outputs],
    ]) {
      if (names.some((n) => !n)) errors.push(`Every ${kind} needs a label.`);
      const dupes = names.filter((n, i) => n && names.indexOf(n) !== i);
      if (dupes.length) errors.push(`Duplicate ${kind} label "${dupes[0]}".`);
    }
    if (inputs.length + outputs.length === 0) errors.push('Add at least one Input or Output.');
    return errors;
  }
  define(part) {
    const errors = this.validate(part.id, part.circuit);
    if (errors.length) throw new Error(errors.join(' '));
    const def = {
      id: part.id,
      name: part.name,
      description: part.description,
      circuit: structuredClone(part.circuit),
      ...deriveInterface(part.circuit),
    };
    this.parts.set(def.id, def);
    return def;
  }
  remove(id) {
    const def = this.parts.get(id);
    if (!def || def.builtin) throw new Error(`Can't remove "${id}".`);
    const users = this.usedBy(id);
    if (users.length) throw new Error(`"${id}" is used by ${users.join(', ')}.`);
    this.parts.delete(id);
  }
  /** User-defined parts, ordered so each part comes after the parts it uses. */
  saved() {
    const out = [];
    const done = new Set();
    const visit = (id) => {
      const def = this.parts.get(id);
      if (!def?.circuit || done.has(id)) return;
      done.add(id);
      def.circuit.nodes.forEach((n) => visit(n.part));
      out.push({
        id: def.id,
        name: def.name,
        description: def.description,
        circuit: structuredClone(def.circuit),
      });
    };
    this.all().forEach((p) => visit(p.id));
    return out;
  }
  load(parts) {
    for (const p of parts) this.define(p);
  }
}
