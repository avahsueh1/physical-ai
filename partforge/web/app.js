// PartForge page: library sidebar, circuit editor, test-drive panel, saving.
import { compile, compilePart } from './engine/compile.js';
import { circuit, EXAMPLES } from './engine/examples.js';
import { PartLibrary, PRIMITIVES } from './engine/parts.js';
import { Simulator } from './engine/simulator.js';
import { Editor } from './ui/editor.js';
import { drawVehicle } from './ui/vehicleView.js';
import { defaultConfig, isBrain, Vehicle } from './vehicle/world.js';

const STORAGE_KEY = 'partforge.parts.v1';
const CURRENT = '__current__';
const $ = (id) => document.getElementById(id);

// ---- library & persistence ----------------------------------------------------

const lib = new PartLibrary();

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return lib.load(JSON.parse(raw));
  } catch (e) {
    console.warn('PartForge: could not load saved parts, using the examples.', e);
  }
  lib.load(EXAMPLES);
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lib.saved()));
  } catch (e) {
    /* storage unavailable (private window): parts last until the tab closes */
  }
}

loadSaved();

// ---- editor -------------------------------------------------------------------

const editor = new Editor($('editor'), lib);
let editingId = null;
let dirty = false;
let loading = false;

editor.onChange = () => {
  if (!loading) dirty = true;
  updateHeader();
  updateStatus();
  if (brainSelect.value === CURRENT) setBrain(CURRENT);
};
editor.onOpenPart = (id) => openPart(id);

function openPart(id) {
  if (dirty && editor.circuit.nodes.length && !confirm('Discard unsaved changes?')) return;
  loading = true;
  editor.load(id ? lib.get(id).circuit : { nodes: [], wires: [] });
  loading = false;
  editingId = id;
  dirty = false;
  updateHeader();
  renderLibrary();
}

function savePart(asNew) {
  let id = editingId;
  if (asNew || !id) {
    const name = prompt('Name your part', id ?? '')?.trim();
    if (!name) return;
    const existing = lib.get(name);
    if (existing?.builtin) return flash(`"${name}" is a built-in gate. Pick another name.`, true);
    if (existing && name !== editingId && !confirm(`Replace your part "${name}"?`)) return;
    id = name;
  }
  try {
    const prev = lib.get(id);
    lib.define({ id, name: id, description: prev?.description, circuit: editor.circuit });
  } catch (e) {
    return flash(e.message, true);
  }
  editingId = id;
  dirty = false;
  persist();
  renderLibrary();
  renderBrains();
  updateHeader();
  flash(`Saved "${id}".`);
}

// ---- library sidebar -------------------------------------------------------------

function partItem(d) {
  const li = document.createElement('li');
  li.className = 'part' + (d.id === editingId ? ' active' : '');
  li.draggable = true;
  li.title = [
    d.description,
    d.inputs.length ? `in: ${d.inputs.join(', ')}` : '',
    d.outputs.length ? `out: ${d.outputs.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = d.name;
  const pins = document.createElement('span');
  pins.className = 'pins';
  pins.textContent = `${d.inputs.length}→${d.outputs.length}`;
  li.append(name, pins);
  li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/part', d.id));
  li.addEventListener('click', () => editor.addNode(d.id));

  if (!d.builtin) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '✎';
    edit.title = 'Open this part';
    edit.setAttribute('aria-label', `Open ${d.name}`);
    edit.onclick = (e) => {
      e.stopPropagation();
      openPart(d.id);
    };
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Delete this part';
    del.setAttribute('aria-label', `Delete ${d.name}`);
    del.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${d.name}"?`)) return;
      try {
        lib.remove(d.id);
      } catch (err) {
        return flash(err.message, true);
      }
      if (editingId === d.id) editingId = null;
      persist();
      renderLibrary();
      renderBrains();
    };
    li.append(edit, del);
  }
  return li;
}

function renderLibrary() {
  const all = lib.all();
  $('builtin-parts').replaceChildren(...all.filter((d) => d.builtin).map(partItem));
  $('user-parts').replaceChildren(...all.filter((d) => !d.builtin).map(partItem));
}

// ---- header & status -------------------------------------------------------------

function updateHeader() {
  $('editing-name').textContent = editingId ?? 'new circuit';
  $('dirty').textContent = dirty ? '● unsaved' : '';
}

let flashUntil = 0;
function flash(msg, error = false) {
  const s = $('status');
  s.textContent = msg;
  s.classList.toggle('error', error);
  flashUntil = performance.now() + 4000;
}

const HELP_MOUSE =
  'Click an Input to toggle it · double-click to rename a pin or open a part · right-click deletes · drag empty space to pan';
const HELP_TOUCH = 'Tap an Input to toggle it · drag from a pin to wire · Edit and Delete act on the selected part';
const coarse = matchMedia('(pointer: coarse)');

function updateStatus() {
  if (performance.now() < flashUntil) return;
  const s = $('status');
  s.classList.toggle('error', !!editor.error);
  s.textContent = editor.error ?? (coarse.matches ? HELP_TOUCH : HELP_MOUSE);
}

// ---- vehicle ---------------------------------------------------------------------

const brainSelect = $('brain');
const vehicle = new Vehicle(defaultConfig());
let running = false;

function renderBrains() {
  const keep = brainSelect.value;
  const opts = [
    new Option('This circuit (live)', CURRENT),
    ...lib
      .all()
      .filter((d) => !d.builtin && isBrain(d))
      .map((d) => new Option(d.name, d.id)),
  ];
  brainSelect.replaceChildren(...opts);
  const pick = [keep, 'Line Follower', CURRENT].find((v) => opts.some((o) => o.value === v));
  brainSelect.value = pick;
  setBrain(pick);
}

function setBrain(id) {
  try {
    const c = id === CURRENT ? editor.circuit : lib.get(id).circuit;
    vehicle.brain = new Simulator(compile(lib, c));
  } catch {
    vehicle.brain = null;
    vehicle.motors = { left: 0, right: 0 };
  }
}

function setRunning(on) {
  running = on;
  $('btn-run').textContent = running ? 'Pause' : 'Run';
}

brainSelect.onchange = () => setBrain(brainSelect.value);
$('btn-run').onclick = () => setRunning(!running);
$('btn-reset').onclick = () => {
  vehicle.reset();
  setBrain(brainSelect.value);
};

let lastReadout = '';
function renderReadout() {
  const b = (v) => `<span class="${v ? 'on' : ''}">${v ? 'ON' : 'off'}</span>`;
  const m = (v) =>
    `<span class="${v > 0 ? 'on' : v < 0 ? 'rev' : ''}">${v > 0 ? 'fwd' : v < 0 ? 'rev' : 'stop'}</span>`;
  const s = vehicle.sensors;
  const html = `
    <dt>lineL / lineR</dt><dd>${b(s.lineL)} / ${b(s.lineR)}</dd>
    <dt>bump</dt><dd>${b(s.bump)}</dd>
    <dt>motors L / R</dt><dd>${m(vehicle.motors.left)} / ${m(vehicle.motors.right)}</dd>
    <dt>distance</dt><dd>${Math.round(vehicle.distance)} px in ${vehicle.time.toFixed(1)} s</dd>`;
  if (html !== lastReadout) $('readout').innerHTML = lastReadout = html;
}

// ---- toolbar -----------------------------------------------------------------------

$('btn-new').onclick = () => openPart(null);
$('btn-save').onclick = () => savePart(false);
$('btn-save-as').onclick = () => savePart(true);
$('btn-edit').onclick = () => {
  if (!editor.editNode()) flash('Select an Input, an Output or one of your parts first.');
};
$('btn-delete').onclick = () => {
  if (!editor.deleteSelected()) flash('Select a part on the board first.');
};

$('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(lib.saved(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'partforge-parts.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

const fileInput = $('file-import');
$('btn-import').onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    lib.load(JSON.parse(await file.text()));
    persist();
    renderLibrary();
    renderBrains();
    flash(`Imported ${file.name}.`);
  } catch (e) {
    flash(`Import failed: ${e.message}`, true);
  }
  fileInput.value = '';
};

$('btn-examples').onclick = () => {
  if (!confirm('Put the example parts back? Your own parts stay; examples with the same name are replaced.')) return;
  try {
    for (const p of EXAMPLES) lib.define(p); // in dependency order, so Inverter comes back before Line Follower
  } catch (e) {
    return flash(e.message, true);
  }
  persist();
  renderLibrary();
  renderBrains();
  flash('Examples restored.');
};

// ---- site chrome: theme toggle (same behaviour as the main site) ----------------------

$('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', root.dataset.theme);
  } catch (e) {}
});
$('yr').textContent = new Date().getFullYear();

// ---- main loop ------------------------------------------------------------------------

const speed = $('speed');
const DT = 1 / 60;
let last = performance.now();
let acc = 0;

function frame(now) {
  editor.tick(Number(speed.value));
  editor.draw();
  if (running) {
    acc += Math.min(0.1, (now - last) / 1000);
    while (acc >= DT) {
      vehicle.step(DT);
      acc -= DT;
    }
  }
  last = now;
  drawVehicle($('world'), vehicle);
  renderReadout();
  updateStatus();
  requestAnimationFrame(frame);
}

renderLibrary();
openPart(lib.get('Line Follower') ? 'Line Follower' : null);
renderBrains();
requestAnimationFrame(frame);

// Everything on the page, for the browser console.
function refresh() {
  persist();
  renderLibrary();
  renderBrains();
}
window.PartForge = { lib, editor, vehicle, refresh, compile, compilePart, circuit, Simulator, Vehicle, PRIMITIVES, EXAMPLES };
