// Canvas circuit editor: place parts, drag wires from outputs to inputs,
// click Inputs to toggle them, and watch signals flow live.
import { compile } from '../engine/compile.js';
import { IN, OUT } from '../engine/parts.js';
import { Simulator } from '../engine/simulator.js';
const HEADER = 24;
const ROW = 18;
const PIN_R = 5;
export class Editor {
  canvas;
  lib;
  circuit = { nodes: [], wires: [] };
  selected = null;
  error = null;
  onChange = () => {};
  onOpenPart = () => {};
  sim = null;
  net = null;
  inputValues = new Map();
  drag = null;
  hoverPin = null;
  ox = 0;
  /** Board zoom: below 1 on small screens so a whole circuit fits. */
  zoom = 1;
  panned = false;
  oy = 0;
  nextId = 1;
  ctx;
  constructor(canvas, lib) {
    this.canvas = canvas;
    this.lib = lib;
    this.ctx = canvas.getContext('2d');
    this.bindEvents();
  }
  // ---- model ---------------------------------------------------------------
  load(c) {
    this.circuit = structuredClone(c);
    this.inputValues.clear();
    this.selected = null;
    this.nextId =
      1 + Math.max(0, ...this.circuit.nodes.map((n) => parseInt(n.id.replace(/\D/g, ''), 10) || 0));
    this.fit();
    this.changed();
  }
  /** Show the whole circuit: no change if it already fits, otherwise zoom out (to 45% at most) and centre it. */
  fit() {
    this.ox = this.oy = 0;
    this.zoom = 1;
    this.panned = false;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (!this.circuit.nodes.length || !W || !H) return;
    const boxes = this.circuit.nodes.map((n) => this.box(n));
    const x0 = Math.min(...boxes.map((b) => b.x)) - PIN_R - 10, y0 = Math.min(...boxes.map((b) => b.y)) - 10;
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + PIN_R + 10, y1 = Math.max(...boxes.map((b) => b.y + b.h)) + 10;
    if (x0 >= 0 && y0 >= 0 && x1 <= W && y1 <= H - 40) return;
    this.zoom = Math.max(0.45, Math.min(1, W / (x1 - x0), (H - 40) / (y1 - y0)));
    this.ox = (W / this.zoom - (x1 - x0)) / 2 - x0;
    this.oy = Math.max(0, ((H - 40) / this.zoom - (y1 - y0)) / 2) - y0;
  }
  addNode(partId, x, y) {
    const def = this.lib.get(partId);
    const id = `n${this.nextId++}`;
    const node = {
      id,
      part: partId,
      x: Math.round((x ?? this.canvas.clientWidth / this.zoom / 2 - 50) - this.ox),
      y: Math.round((y ?? this.canvas.clientHeight / this.zoom / 2 - 20) - this.oy),
    };
    if (partId === IN || partId === OUT) node.label = this.uniqueLabel(partId === IN ? 'in' : 'out', partId);
    if (!def) throw new Error(`Unknown part ${partId}`);
    this.circuit.nodes.push(node);
    this.selected = node;
    this.changed();
    return node;
  }
  /** Rename an Input/Output pin, or open a composite part. Returns false if there's nothing to do. */
  editNode(node = this.selected) {
    if (!node) return false;
    if (node.part === IN || node.part === OUT) {
      const label = prompt('Pin name', node.label ?? '');
      if (label !== null && label.trim()) {
        node.label = label.trim();
        this.changed();
      }
      return true;
    }
    if (this.def(node).circuit) {
      this.onOpenPart(node.part);
      return true;
    }
    return false;
  }
  deleteSelected() {
    if (!this.selected) return false;
    this.removeNode(this.selected);
    return true;
  }
  removeNode(node) {
    this.circuit.nodes = this.circuit.nodes.filter((n) => n !== node);
    this.circuit.wires = this.circuit.wires.filter((w) => w.from.node !== node.id && w.to.node !== node.id);
    if (this.selected === node) this.selected = null;
    this.changed();
  }
  uniqueLabel(base, kind) {
    const used = new Set(this.circuit.nodes.filter((n) => n.part === kind).map((n) => n.label));
    let i = 1;
    while (used.has(`${base}${i}`)) i++;
    return `${base}${i}`;
  }
  connect(from, to) {
    // An input can only have one driver; a new wire replaces the old one.
    this.circuit.wires = this.circuit.wires.filter((w) => !(w.to.node === to.node && w.to.pin === to.pin));
    this.circuit.wires.push({ from, to });
    this.changed();
  }
  /** Recompile after any structural edit. Input switch states survive. */
  changed() {
    try {
      this.net = compile(this.lib, this.circuit);
      this.sim = new Simulator(this.net);
      this.error = null;
    } catch (e) {
      this.net = this.sim = null;
      this.error = e.message;
    }
    this.onChange();
  }
  // ---- geometry -------------------------------------------------------------
  def(n) {
    return this.lib.get(n.part) ?? { id: n.part, name: `? ${n.part}`, inputs: [], outputs: [] };
  }
  box(n) {
    if (n.part === IN || n.part === OUT) return { x: n.x + this.ox, y: n.y + this.oy, w: 84, h: 30 };
    const d = this.def(n);
    const rows = Math.max(d.inputs.length, d.outputs.length, 1);
    const w = Math.max(96, 14 + 7.5 * Math.max(d.name.length, 0) + 10);
    return { x: n.x + this.ox, y: n.y + this.oy, w, h: HEADER + rows * ROW + 6 };
  }
  pins(n) {
    const b = this.box(n);
    const d = this.def(n);
    if (n.part === IN) return [{ node: n, pin: 'out', dir: 'out', x: b.x + b.w, y: b.y + b.h / 2 }];
    if (n.part === OUT) return [{ node: n, pin: 'in', dir: 'in', x: b.x, y: b.y + b.h / 2 }];
    const at = (i) => b.y + HEADER + i * ROW + ROW / 2;
    return [
      ...d.inputs.map((p, i) => ({ node: n, pin: p, dir: 'in', x: b.x, y: at(i) })),
      ...d.outputs.map((p, i) => ({ node: n, pin: p, dir: 'out', x: b.x + b.w, y: at(i) })),
    ];
  }
  pinPos(node, pin, dir) {
    const n = this.circuit.nodes.find((m) => m.id === node);
    return n && this.pins(n).find((p) => p.pin === pin && p.dir === dir);
  }
  hitPin(x, y) {
    for (const n of [...this.circuit.nodes].reverse())
      for (const p of this.pins(n)) if (Math.hypot(p.x - x, p.y - y) <= PIN_R + 4) return p;
    return null;
  }
  hitNode(x, y) {
    for (const n of [...this.circuit.nodes].reverse()) {
      const b = this.box(n);
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return n;
    }
    return null;
  }
  curve(x1, y1, x2, y2) {
    const c = Math.max(30, Math.abs(x2 - x1) / 2);
    return [x1, y1, x1 + c, y1, x2 - c, y2, x2, y2];
  }
  hitWire(x, y) {
    for (const w of this.circuit.wires) {
      const a = this.pinPos(w.from.node, w.from.pin, 'out'),
        b = this.pinPos(w.to.node, w.to.pin, 'in');
      if (!a || !b) continue;
      const [x0, y0, x1, y1, x2, y2, x3, y3] = this.curve(a.x, a.y, b.x, b.y);
      for (let t = 0; t <= 1; t += 0.04) {
        const u = 1 - t;
        const px = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
        const py = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
        if (Math.hypot(px - x, py - y) < 6) return w;
      }
    }
    return null;
  }
  // ---- input -----------------------------------------------------------------
  bindEvents() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const { x, y } = pos(e);
      const pin = this.hitPin(x, y);
      if (pin?.dir === 'out') {
        this.drag = { kind: 'wire', from: { node: pin.node.id, pin: pin.pin }, x, y };
        return;
      }
      if (pin?.dir === 'in') {
        // Grab an existing wire off an input to move or drop it.
        const w = this.circuit.wires.find((w) => w.to.node === pin.node.id && w.to.pin === pin.pin);
        if (w) {
          this.circuit.wires = this.circuit.wires.filter((v) => v !== w);
          this.changed();
          this.drag = { kind: 'wire', from: w.from, x, y };
        }
        return;
      }
      const node = this.hitNode(x, y);
      if (node) {
        this.selected = node;
        this.circuit.nodes = [...this.circuit.nodes.filter((n) => n !== node), node]; // bring to front
        this.drag = { kind: 'node', node, dx: x - node.x, dy: y - node.y, moved: false };
      } else {
        this.selected = null;
        this.drag = { kind: 'pan', sx: x, sy: y, ox: this.ox, oy: this.oy };
      }
    });
    window.addEventListener('pointermove', (e) => {
      const { x, y } = pos(e);
      this.hoverPin = this.hitPin(x, y);
      const d = this.drag;
      if (!d) {
        c.style.cursor = this.hoverPin ? 'crosshair' : this.hitNode(x, y) ? 'grab' : 'default';
        return;
      }
      if (d.kind === 'wire') {
        d.x = x;
        d.y = y;
      }
      if (d.kind === 'pan') {
        this.panned = true;
        this.ox = d.ox + x - d.sx;
        this.oy = d.oy + y - d.sy;
      }
      if (d.kind === 'node') {
        const nx = Math.round((x - d.dx) / 10) * 10,
          ny = Math.round((y - d.dy) / 10) * 10;
        if (nx !== d.node.x || ny !== d.node.y) d.moved = true;
        d.node.x = nx;
        d.node.y = ny;
      }
    });
    window.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      const { x, y } = pos(e);
      if (d.kind === 'wire') {
        const pin = this.hitPin(x, y);
        if (pin?.dir === 'in') this.connect(d.from, { node: pin.node.id, pin: pin.pin });
      } else if (d.kind === 'node') {
        if (!d.moved && d.node.part === IN) {
          this.inputValues.set(d.node.id, !this.inputValues.get(d.node.id));
        } else if (d.moved) {
          this.onChange(); // position is part of the design (and IN/OUT order sets pin order)
        }
      }
    });
    c.addEventListener('dblclick', (e) => {
      const { x, y } = pos(e);
      const node = this.hitNode(x, y);
      if (node) this.editNode(node);
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { x, y } = pos(e);
      const node = this.hitNode(x, y);
      if (node) return this.removeNode(node);
      const w = this.hitWire(x, y);
      if (w) {
        this.circuit.wires = this.circuit.wires.filter((v) => v !== w);
        this.changed();
      }
    });
    c.addEventListener('dragover', (e) => e.preventDefault());
    c.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = e.dataTransfer?.getData('text/part');
      if (id && this.lib.get(id)) {
        const { x, y } = pos(e);
        this.addNode(id, x - 40, y - 15);
      }
    });
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
        e.preventDefault();
        this.removeNode(this.selected);
      }
    });
  }
  // ---- simulate & draw ---------------------------------------------------------
  tick(ticks) {
    const sim = this.sim,
      net = this.net;
    if (!sim || !net) return;
    for (const n of this.circuit.nodes) {
      if (n.part !== IN) continue;
      const v = net.pinNets.get(`${n.id}:out`);
      if (v !== undefined) sim.set(v, this.inputValues.get(n.id) ?? false);
    }
    sim.run(ticks);
  }
  value(node, pin) {
    const v = this.net?.pinNets.get(`${node}:${pin}`);
    return v !== undefined && !!this.sim?.get(v);
  }
  draw() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== canvas.clientWidth * dpr || canvas.height !== canvas.clientHeight * dpr) {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      if (!this.panned) this.fit(); // the board was resized (rotated phone, narrower window)
    }
    const z = this.zoom;
    const W = canvas.clientWidth / z,
      H = canvas.clientHeight / z;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
    const css = getComputedStyle(canvas);
    const col = (name) => css.getPropertyValue(name).trim();
    const C = {
      bg: col('--board'),
      grid: col('--grid'),
      part: col('--part'),
      partEdge: col('--part-edge'),
      text: col('--text'),
      dim: col('--text-dim'),
      on: col('--on'),
      off: col('--off'),
      sel: col('--accent'),
    };
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = C.grid;
    const gx = ((this.ox % 20) + 20) % 20,
      gy = ((this.oy % 20) + 20) % 20;
    for (let x = gx; x < W; x += 20) for (let y = gy; y < H; y += 20) ctx.fillRect(x, y, 1.2, 1.2);
    // Wires
    ctx.lineCap = 'round';
    for (const w of this.circuit.wires) {
      const a = this.pinPos(w.from.node, w.from.pin, 'out'),
        b = this.pinPos(w.to.node, w.to.pin, 'in');
      if (!a || !b) continue;
      const on = this.value(w.from.node, w.from.pin);
      this.bezier(this.curve(a.x, a.y, b.x, b.y), on ? C.on : C.off, on ? 3 : 2);
    }
    if (this.drag?.kind === 'wire') {
      const a = this.pinPos(this.drag.from.node, this.drag.from.pin, 'out');
      if (a) this.bezier(this.curve(a.x, a.y, this.drag.x, this.drag.y), C.sel, 2, [6, 5]);
    }
    // Parts
    ctx.textBaseline = 'middle';
    for (const n of this.circuit.nodes) {
      const b = this.box(n);
      const d = this.def(n);
      const io = n.part === IN || n.part === OUT;
      const lit =
        n.part === IN ? !!this.inputValues.get(n.id) : n.part === OUT ? this.value(n.id, 'in') : false;
      ctx.fillStyle = io && lit ? C.on : C.part;
      ctx.strokeStyle = n === this.selected ? C.sel : C.partEdge;
      ctx.lineWidth = n === this.selected ? 2 : 1;
      this.roundRect(b, io ? 15 : 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = io && lit ? C.bg : C.text;
      if (io) {
        ctx.font = '600 12px "IBM Plex Mono", ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        const arrow = n.part === IN ? (lit ? '● ' : '○ ') : '→ ';
        ctx.fillText(arrow + (n.label || '?'), b.x + b.w / 2, b.y + b.h / 2 + 1);
      } else {
        ctx.font = `600 12px "IBM Plex Mono", ui-monospace, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(d.name, b.x + b.w / 2, b.y + HEADER / 2 + 1);
        ctx.fillStyle = C.dim;
        ctx.font = '10px "IBM Plex Mono", ui-monospace, Menlo, monospace';
        ctx.textAlign = 'left';
        d.inputs.forEach((p, i) => ctx.fillText(p, b.x + 9, b.y + HEADER + i * ROW + ROW / 2));
        ctx.textAlign = 'right';
        d.outputs.forEach((p, i) => ctx.fillText(p, b.x + b.w - 9, b.y + HEADER + i * ROW + ROW / 2));
      }
      for (const p of this.pins(n)) {
        const on = this.value(n.id, p.pin);
        ctx.beginPath();
        ctx.arc(
          p.x,
          p.y,
          this.hoverPin?.node === n && this.hoverPin.pin === p.pin && this.hoverPin.dir === p.dir
            ? PIN_R + 2
            : PIN_R,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = on ? C.on : C.bg;
        ctx.strokeStyle = on ? C.on : C.partEdge;
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
      }
    }
    if (this.circuit.nodes.length === 0) {
      ctx.fillStyle = C.dim;
      ctx.textAlign = 'center';
      ctx.font = '13px "IBM Plex Mono", ui-monospace, Menlo, monospace';
      ctx.fillText('Add parts from the Parts list.', W / 2, H / 2 - 10);
      ctx.fillText('Wire an output pin (right side) to an input pin (left side).', W / 2, H / 2 + 12);
    }
  }
  bezier(p, color, width, dash = []) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.bezierCurveTo(p[2], p[3], p[4], p[5], p[6], p[7]);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  roundRect(b, r) {
    this.ctx.beginPath();
    this.ctx.roundRect(b.x, b.y, b.w, b.h, r);
  }
}
