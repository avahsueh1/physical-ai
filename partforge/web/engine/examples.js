// Starter parts that ship with the simulator. They double as documentation for
// how to build circuits in code.
import { IN, OUT } from './parts.js';
/**
 * Tiny circuit DSL.
 *   circuit([['a', 'IN', 40, 60, 'a'], ['g', 'NAND', 200, 60]], ['a.out -> g.a', 'a.out -> g.b'])
 */
export function circuit(nodes, wires) {
  return {
    nodes: nodes.map(([id, part, x, y, label]) => ({ id, part, x, y, ...(label ? { label } : {}) })),
    wires: wires.map((w) => {
      const [from, to] = w.split('->').map((s) => s.trim());
      const [fn, fp] = from.split('.');
      const [tn, tp] = to.split('.');
      return { from: { node: fn, pin: fp }, to: { node: tn, pin: tp } };
    }),
  };
}
export const EXAMPLES = [
  {
    id: 'Inverter',
    name: 'Inverter',
    description: 'NOT built from a single NAND with both inputs tied together.',
    circuit: circuit(
      [
        ['a', IN, 60, 100, 'in'],
        ['n', 'NAND', 220, 90],
        ['o', OUT, 400, 100, 'out'],
      ],
      ['a.out -> n.a', 'a.out -> n.b', 'n.out -> o.in'],
    ),
  },
  {
    id: 'Half Adder',
    name: 'Half Adder',
    description: 'Adds two bits: sum and carry.',
    circuit: circuit(
      [
        ['a', IN, 60, 80, 'a'],
        ['b', IN, 60, 180, 'b'],
        ['x', 'XOR', 240, 70],
        ['n', 'AND', 240, 190],
        ['s', OUT, 420, 80, 'sum'],
        ['c', OUT, 420, 200, 'carry'],
      ],
      ['a.out -> x.a', 'b.out -> x.b', 'a.out -> n.a', 'b.out -> n.b', 'x.out -> s.in', 'n.out -> c.in'],
    ),
  },
  {
    id: 'SR Latch',
    name: 'SR Latch',
    description:
      'One bit of memory from two cross-coupled NOR gates. Like real hardware it powers up undecided (it flickers) until you pulse set or reset.',
    circuit: circuit(
      [
        ['r', IN, 60, 80, 'reset'],
        ['s', IN, 60, 200, 'set'],
        ['n1', 'NOR', 240, 70],
        ['n2', 'NOR', 240, 190],
        ['q', OUT, 420, 80, 'q'],
      ],
      ['r.out -> n1.a', 'n2.out -> n1.b', 's.out -> n2.b', 'n1.out -> n2.a', 'n1.out -> q.in'],
    ),
  },
  {
    id: 'Line Follower',
    name: 'Line Follower',
    description:
      'A vehicle brain. A wheel stops while the sensor on its side sees the line, so the car steers back toward it.',
    circuit: circuit(
      [
        ['l', IN, 60, 80, 'lineL'],
        ['r', IN, 60, 200, 'lineR'],
        ['nl', 'Inverter', 240, 70],
        ['nr', 'Inverter', 240, 190],
        ['ml', OUT, 420, 80, 'motorL'],
        ['mr', OUT, 420, 200, 'motorR'],
      ],
      ['l.out -> nl.in', 'r.out -> nr.in', 'nl.out -> ml.in', 'nr.out -> mr.in'],
    ),
  },
];
