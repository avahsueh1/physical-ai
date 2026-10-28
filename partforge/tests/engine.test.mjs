// node --test projects/partforge/tests/*.mjs  (no install needed; tests the same files the page runs)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compile, compilePart } from '../web/engine/compile.js';
import { circuit, EXAMPLES } from '../web/engine/examples.js';
import { IN, OUT, PartLibrary } from '../web/engine/parts.js';
import { Simulator } from '../web/engine/simulator.js';

function lib() {
  const l = new PartLibrary();
  l.load(EXAMPLES);
  return l;
}

function truth(l, partId, ins) {
  const sim = new Simulator(compilePart(l, partId));
  for (const [k, v] of Object.entries(ins)) sim.setInput(k, v);
  assert.equal(sim.settle(), true, `${partId} should settle`);
  return Object.fromEntries(l.get(partId).outputs.map((o) => [o, sim.output(o)]));
}

describe('primitives and composites', () => {
  it('evaluates the primitive gates', () => {
    const l = lib();
    for (const [a, b] of [[false, false], [false, true], [true, false], [true, true]]) {
      assert.equal(truth(l, 'NAND', { a, b }).out, !(a && b));
      assert.equal(truth(l, 'XOR', { a, b }).out, a !== b);
      assert.equal(truth(l, 'NOR', { a, b }).out, !(a || b));
    }
  });

  it('builds a NOT from one NAND', () => {
    assert.equal(truth(lib(), 'Inverter', { in: false }).out, true);
    assert.equal(truth(lib(), 'Inverter', { in: true }).out, false);
  });

  it('half adder adds', () => {
    const l = lib();
    assert.deepEqual(truth(l, 'Half Adder', { a: true, b: true }), { sum: false, carry: true });
    assert.deepEqual(truth(l, 'Half Adder', { a: true, b: false }), { sum: true, carry: false });
  });

  it('nests parts several levels deep (full adder from two half adders)', () => {
    const l = lib();
    l.define({
      id: 'Full Adder',
      name: 'Full Adder',
      circuit: circuit(
        [
          ['a', IN, 0, 0, 'a'], ['b', IN, 0, 1, 'b'], ['ci', IN, 0, 2, 'cin'],
          ['h1', 'Half Adder', 1, 0], ['h2', 'Half Adder', 2, 0], ['o', 'OR', 3, 0],
          ['s', OUT, 4, 0, 'sum'], ['co', OUT, 4, 1, 'cout'],
        ],
        [
          'a.out -> h1.a', 'b.out -> h1.b', 'h1.sum -> h2.a', 'ci.out -> h2.b',
          'h1.carry -> o.a', 'h2.carry -> o.b', 'h2.sum -> s.in', 'o.out -> co.in',
        ],
      ),
    });
    for (let n = 0; n < 8; n++) {
      const [a, b, cin] = [1, 2, 4].map((m) => (n & m) !== 0);
      const total = +a + +b + +cin;
      assert.deepEqual(truth(l, 'Full Adder', { a, b, cin }), { sum: total % 2 === 1, cout: total >= 2 });
    }
    assert.deepEqual(l.get('Full Adder').inputs, ['a', 'b', 'cin']); // top-to-bottom order
  });
});

describe('feedback', () => {
  it('SR latch remembers a bit', () => {
    const sim = new Simulator(compilePart(lib(), 'SR Latch'));
    sim.setInput('set', true); sim.settle();
    sim.setInput('set', false); sim.settle();
    assert.equal(sim.output('q'), true);
    sim.setInput('reset', true); sim.settle();
    sim.setInput('reset', false); sim.settle();
    assert.equal(sim.output('q'), false);
  });

  it('a NOT wired to itself oscillates and never settles', () => {
    const c = circuit([['n', 'NOT', 0, 0], ['o', OUT, 1, 0, 'o']], ['n.out -> n.in', 'n.out -> o.in']);
    const sim = new Simulator(compile(new PartLibrary(), c));
    assert.equal(sim.settle(100), false);
    const seen = new Set();
    for (let i = 0; i < 4; i++) { sim.step(); seen.add(sim.output('o')); }
    assert.equal(seen.size, 2);
  });
});

describe('library rules', () => {
  it('rejects a part that contains itself', () => {
    const c = circuit([['a', IN, 0, 0, 'in'], ['x', 'Line Follower', 1, 0], ['o', OUT, 2, 0, 'out']], []);
    assert.throws(() => lib().define({ id: 'Inverter', name: 'Inverter', circuit: c }), /contain itself/);
  });

  it('rejects unlabelled and duplicate pins', () => {
    const l = lib();
    assert.ok(l.validate('X', circuit([['a', IN, 0, 0]], [])).some((e) => /label/.test(e)));
    assert.ok(l.validate('X', circuit([['a', IN, 0, 0, 'p'], ['b', IN, 0, 1, 'p']], [])).some((e) => /Duplicate/.test(e)));
  });

  it('will not delete a part that others use', () => {
    assert.throws(() => lib().remove('Inverter'), /used by/);
  });

  it('round-trips saved parts in dependency order', () => {
    const saved = lib().saved();
    const at = (id) => saved.findIndex((p) => p.id === id);
    assert.ok(at('Inverter') < at('Line Follower'));
    const fresh = new PartLibrary();
    fresh.load(JSON.parse(JSON.stringify(saved)));
    assert.equal(truth(fresh, 'Half Adder', { a: true, b: true }).carry, true);
  });

  it('reads unconnected inputs as low', () => {
    const c = circuit([['g', 'NAND', 0, 0], ['o', OUT, 1, 0, 'o']], ['g.out -> o.in']);
    const sim = new Simulator(compile(new PartLibrary(), c));
    sim.settle();
    assert.equal(sim.output('o'), true);
  });
});
