// Tick-based simulator. Every gate has a one-tick delay: on each tick all gates
// read the values from the previous tick. That makes feedback loops (latches,
// flip-flops, oscillators) behave the way real hardware does.
import { LOW } from './compile.js';
export class Simulator {
  netlist;
  values;
  next;
  ticks = 0;
  constructor(netlist) {
    this.netlist = netlist;
    this.values = new Uint8Array(netlist.netCount);
    this.next = new Uint8Array(netlist.netCount);
  }
  get(net) {
    return this.values[net] === 1;
  }
  /** Drive a net from outside (e.g. an input switch or a sensor). */
  set(net, v) {
    if (net === LOW) return;
    this.values[net] = this.next[net] = v ? 1 : 0;
  }
  setInput(name, v) {
    const net = this.netlist.inputs.get(name);
    if (net !== undefined) this.set(net, v);
  }
  output(name) {
    const net = this.netlist.outputs.get(name);
    return net !== undefined && this.get(net);
  }
  /** Advance one tick. Returns true if any signal changed. */
  step() {
    const { values, next } = this;
    next.set(values);
    for (const g of this.netlist.gates) {
      const outs = g.eval(g.ins.map((n) => values[n] === 1));
      for (let i = 0; i < g.outs.length; i++) next[g.outs[i]] = outs[i] ? 1 : 0;
    }
    next[LOW] = 0;
    let changed = false;
    for (let i = 0; i < values.length; i++)
      if (values[i] !== next[i]) {
        changed = true;
        break;
      }
    this.next = values;
    this.values = next;
    this.ticks++;
    return changed;
  }
  run(ticks) {
    for (let i = 0; i < ticks; i++) this.step();
  }
  /** Step until nothing changes. Returns false if it never settles (an oscillator). */
  settle(maxTicks = 1000) {
    for (let i = 0; i < maxTicks; i++) if (!this.step()) return true;
    return false;
  }
}
