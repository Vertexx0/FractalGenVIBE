/**
 * Menger sponge generator — scene, controls and UI wiring.
 *
 * Mobile is the target: geometry is built in a worker, hidden faces never reach
 * the GPU, the render loop sleeps when the camera is still, and pixel ratio is
 * trimmed as the mesh grows.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildSurfaceMesh, spongeStats, FRACTAL_DIMENSION } from './menger.js';
import { toBinarySTL, toOBJChunks, stlByteLength, formatBytes } from './exporters.js';

/** Interactive ceiling. The core goes to 5, but 20^5 cubes is not a phone. */
const UI_MAX_LEVEL = 4;
/** Bounding cube edge length of exported models, in millimetres. */
const EXPORT_MM = 100;
const PALETTES = ['depth', 'axis', 'ember', 'bone'];

const num = new Intl.NumberFormat();
const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('view'),
  hud: $('hud'),
  stats: $('stats'),
  busy: $('busy'),
  busyLabel: $('busy-label'),
  sheet: $('sheet'),
  sheetToggle: $('sheet-toggle'),
  level: $('level'),
  levelOut: $('level-out'),
  levelNote: $('level-note'),
  levelUp: $('level-up'),
  levelDown: $('level-down'),
  palette: $('palette'),
  cut: $('cut'),
  cutOut: $('cut-out'),
  cutAxis: $('cut-axis'),
  spin: $('spin'),
  reset: $('reset'),
  savePng: $('save-png'),
  saveStl: $('save-stl'),
  saveObj: $('save-obj'),
  toast: $('toast'),
};

const state = {
  level: 3,
  palette: 'depth',
  cut: 0,
  cutAxis: 'x',
  spin: false,
};

let currentMesh = null;   // last built mesh data, kept for the exporters
let building = false;
let needsRender = true;

// ---------------------------------------------------------------- palettes

const srgbToLinear = (c) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** Gradient stops given in sRGB 0-255, pre-converted to the linear values
 *  three.js expects for vertex colours so the per-vertex loop stays cheap. */
function ramp(stops) {
  return stops.map(([at, r, g, b]) => [
    at,
    srgbToLinear(r / 255),
    srgbToLinear(g / 255),
    srgbToLinear(b / 255),
  ]);
}

const RAMPS = {
  depth: ramp([
    [0.0, 18, 32, 66],
    [0.45, 44, 128, 196],
    [0.75, 124, 198, 255],
    [1.0, 236, 248, 255],
  ]),
  ember: ramp([
    [0.0, 46, 12, 22],
    [0.4, 178, 44, 42],
    [0.72, 244, 140, 40],
    [1.0, 255, 232, 156],
  ]),
  bone: ramp([
    [0.0, 96, 100, 112],
    [0.6, 208, 210, 214],
    [1.0, 250, 250, 248],
  ]),
};

function sampleRamp(stops, t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a0, r0, g0, b0] = stops[i - 1];
      const [a1, r1, g1, b1] = stops[i];
      const k = a1 === a0 ? 0 : (t - a0) / (a1 - a0);
      return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

/**
 * Vertex colours derived from position alone.
 *
 * `depth` uses the Chebyshev distance from the centre, so the outer shell and
 * the walls deep inside the tunnels read as different surfaces — which is the
 * whole point of a sponge, and the thing a flat colour hides.
 */
function paintColors(mesh, palette) {
  const { positions } = mesh;
  const count = positions.length / 3;
  const colors = new Float32Array(positions.length);

  for (let i = 0, p = 0; i < count; i++, p += 3) {
    const x = positions[p], y = positions[p + 1], z = positions[p + 2];
    let r, g, b;
    if (palette === 'axis') {
      r = srgbToLinear(x + 0.5);
      g = srgbToLinear(y + 0.5);
      b = srgbToLinear(z + 0.5);
    } else {
      const ax = x < 0 ? -x : x;
      const ay = y < 0 ? -y : y;
      const az = z < 0 ? -z : z;
      const chebyshev = ax > ay ? (ax > az ? ax : az) : (ay > az ? ay : az);
      // 1 on the outer shell, 0 deep inside, so the faces you actually see are
      // the lit ones and the tunnels fall away into shadow.
      const t = chebyshev * 2;
      [r, g, b] = sampleRamp(RAMPS[palette] || RAMPS.depth, t);
    }
    colors[p] = r;
    colors[p + 1] = g;
    colors[p + 2] = b;
  }
  return colors;
}

// ------------------------------------------------------------------- scene

let renderer, scene, camera, controls, material, innerMaterial, mesh3d, innerMesh;
let geometry = null;
const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.5);
/** Default viewing direction. The distance comes from the layout, not a guess. */
const HOME_DIR = new THREE.Vector3(1.05, 0.78, 1.32).normalize();
/** Bounding-sphere radius of the unit cube the sponge fills. */
const FIT_RADIUS = 0.87;
/** Distance the app last chose, so a user's own zoom is never overridden. */
let autoDistance = null;

function initScene() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer = new THREE.WebGLRenderer({
    canvas: el.canvas,
    antialias: dpr < 1.5,          // at 2x the extra samples are not worth the fill rate
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(dpr);
  renderer.localClippingEnabled = true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d12);

  camera = new THREE.PerspectiveCamera(46, 1, 0.01, 100);
  camera.position.copy(HOME_DIR);

  controls = new OrbitControls(camera, el.canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;       // on a phone panning is an accident, not a gesture
  controls.minDistance = 0.75;
  controls.maxDistance = 14;
  controls.autoRotateSpeed = 0.9;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };

  scene.add(new THREE.HemisphereLight(0x9ec7ff, 0x141a26, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2.2, 3.1, 2.0);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x86b6ff, 0.9);
  fill.position.set(-2.4, -1.2, -1.8);
  scene.add(fill);

  material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.06,
  });

  // The sponge is a closed shell, so its back faces are invisible until the
  // cutaway opens it. Shading them separately and darker is what makes a slice
  // read as hollow instead of as a solid block someone sawed through.
  innerMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b3446,
    roughness: 0.95,
    metalness: 0,
    side: THREE.BackSide,
  });

  const empty = new THREE.BufferGeometry();
  mesh3d = new THREE.Mesh(empty, material);
  innerMesh = new THREE.Mesh(empty, innerMaterial);
  scene.add(mesh3d, innerMesh);

  resize();
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  controls.addEventListener('change', () => { needsRender = true; });

  renderer.setAnimationLoop(() => {
    if (controls.update() || needsRender) {
      renderer.render(scene, camera);
      needsRender = false;
    }
  });
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  renderer.setSize(w, h, false);
  frameCamera();
}

/**
 * The slice of canvas the model actually has to itself: on a phone that is the
 * band between the heading and the top of the sheet, on desktop everything to
 * the right of the panel.
 */
function visibleRect() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const sheet = el.sheet.getBoundingClientRect();
  const hud = el.hud.getBoundingClientRect();
  if (sheet.height >= h - 1) {
    const x = Math.min(sheet.right + 8, w * 0.6);
    return { x, y: 0, w: Math.max(120, w - x), h };
  }
  const y = Math.min(hud.bottom + 10, h * 0.3);
  return { x: 0, y, w, h: Math.max(120, sheet.top - y) };
}

/**
 * Centre the sponge in that slice and pull the camera back far enough that the
 * whole thing fits, at any orientation. Without this the model sits behind the
 * sheet on a phone and spills off both edges.
 */
function frameCamera({ refit = false } = {}) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const rect = visibleRect();

  // A positive view offset shows a window further down/right of the frame,
  // which moves the model up/left into the free space.
  const offX = w / 2 - (rect.x + rect.w / 2);
  const offY = h / 2 - (rect.y + rect.h / 2);
  if (Math.abs(offX) < 1 && Math.abs(offY) < 1) camera.clearViewOffset();
  else camera.setViewOffset(w, h, offX, offY, w, h);
  camera.updateProjectionMatrix();

  const halfV = Math.tan((camera.fov * Math.PI) / 360);
  const distance = Math.max(
    FIT_RADIUS / (halfV * (rect.h / h)),
    FIT_RADIUS / (halfV * (w / h) * (rect.w / w)),
  );
  const userZoomed = autoDistance !== null &&
    Math.abs(camera.position.length() - autoDistance) > 0.01;
  if (refit || !userZoomed) {
    camera.position.setLength(Math.min(distance, controls.maxDistance));
    autoDistance = camera.position.length();
  }
  needsRender = true;
}

/** Big meshes get fewer pixels: the fill rate, not the triangles, is the wall. */
function tunePixelRatio(faceCount) {
  const cap = faceCount > 200000 ? 1.5 : 2;
  const dpr = Math.min(window.devicePixelRatio || 1, cap);
  if (renderer.getPixelRatio() !== dpr) {
    renderer.setPixelRatio(dpr);
    resize();
  }
}

function applyMesh(data) {
  currentMesh = data;
  geometry?.dispose();
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(paintColors(data, state.palette), 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  mesh3d.geometry = geometry;
  innerMesh.geometry = geometry;
  tunePixelRatio(data.faceCount);
  needsRender = true;
}

function repaint() {
  if (!currentMesh || !geometry) return;
  const attr = geometry.getAttribute('color');
  attr.array.set(paintColors(currentMesh, state.palette));
  attr.needsUpdate = true;
  needsRender = true;
}

function applyCut() {
  let planes = [];
  if (state.cut > 0) {
    const axis = state.cutAxis;
    clipPlane.normal.set(axis === 'x' ? -1 : 0, axis === 'y' ? -1 : 0, axis === 'z' ? -1 : 0);
    // 0 -> keep everything, 100 -> a sliver left, never an empty screen.
    clipPlane.constant = 0.5 - (state.cut / 100) * 0.98;
    planes = [clipPlane];
  }
  for (const m of [material, innerMaterial]) {
    m.clippingPlanes = planes;
    m.needsUpdate = true;
  }
  // The dark inner shell is pure overhead while nothing is cut open.
  innerMesh.visible = state.cut > 0;
  needsRender = true;
}

// ------------------------------------------------------------ build queue

let worker = null;
let buildId = 0;
const pending = new Map();

function startWorker() {
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, mesh, error } = event.data;
      const settle = pending.get(id);
      if (!settle) return;
      pending.delete(id);
      error ? settle.reject(new Error(error)) : settle.resolve(mesh);
    };
    worker.onerror = () => {
      // Module workers are unavailable (older Safari, file://): fall back inline.
      worker = null;
      for (const { level, resolve } of pending.values()) resolve(buildSurfaceMesh(level));
      pending.clear();
    };
  } catch {
    worker = null;
  }
}

function requestMesh(level) {
  if (!worker) return Promise.resolve(buildSurfaceMesh(level));
  const id = ++buildId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, level });
    worker.postMessage({ id, level });
  });
}

/**
 * Build the current level, then keep building if the level moved while we were
 * busy. Dragging the slider across four levels therefore settles on the one the
 * finger stopped at instead of queueing four full builds.
 */
async function rebuild() {
  if (building) return;
  building = true;
  setExportsEnabled(false);
  try {
    let level;
    do {
      level = state.level;
      setBusy(true, `Building level ${level}\u2026`);
      try {
        const data = await requestMesh(level);
        if (data.level === state.level) applyMesh(data);
      } catch (error) {
        toast(`Build failed: ${error.message}`);
        break;
      }
    } while (state.level !== level);
  } finally {
    building = false;
    setBusy(false);
    setExportsEnabled(true);
    syncStats();
  }
}

// ---------------------------------------------------------------------- UI

let busyTimer;
/** Held back briefly: a level-2 build finishes faster than a spinner can read. */
function setBusy(on, label = 'Building\u2026') {
  clearTimeout(busyTimer);
  if (!on) {
    el.busy.hidden = true;
    return;
  }
  el.busyLabel.textContent = label;
  busyTimer = setTimeout(() => { el.busy.hidden = false; }, 120);
}

function setExportsEnabled(on) {
  for (const b of [el.savePng, el.saveStl, el.saveObj]) b.disabled = !on;
}

let toastTimer;
function toast(message, ms = 2600) {
  el.toast.textContent = message;
  el.toast.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.dataset.show = 'false'; }, ms);
}

function syncStats() {
  const s = spongeStats(state.level);
  const tris = currentMesh ? currentMesh.faceCount * 2 : 0;
  el.stats.textContent =
    `${num.format(s.cubeCount)} cubes · ${num.format(tris)} tris · ` +
    `${(s.volumeFraction * 100).toFixed(1)}% solid · dim ${FRACTAL_DIMENSION.toFixed(3)}`;
}

function syncLevelUI() {
  const s = spongeStats(state.level);
  el.level.value = String(state.level);
  el.levelOut.textContent = String(state.level);
  el.levelDown.disabled = state.level <= 0;
  el.levelUp.disabled = state.level >= UI_MAX_LEVEL;
  const heavy = state.level >= UI_MAX_LEVEL;
  el.levelNote.textContent = heavy
    ? `${num.format(s.cubeCount)} cubes · heavy on phones`
    : `${num.format(s.cubeCount)} cubes`;
  el.levelNote.dataset.warn = String(heavy);
}

function syncCutUI() {
  el.cutOut.textContent = state.cut === 0 ? 'off' : `${state.cut}%`;
  setRadio(el.cutAxis, state.cutAxis);
}

function setRadio(group, value) {
  for (const b of group.querySelectorAll('[role="radio"]')) {
    b.setAttribute('aria-checked', String(b.dataset.value === value));
  }
}

function onRadioGroup(group, handler) {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('[role="radio"]');
    if (!button) return;
    setRadio(group, button.dataset.value);
    handler(button.dataset.value);
  });
}

function setLevel(next) {
  const level = Math.max(0, Math.min(UI_MAX_LEVEL, next));
  if (level === state.level) return;
  state.level = level;
  syncLevelUI();
  writeHash();
  rebuild();
}

// ------------------------------------------------------------------ export

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function savePNG() {
  // Render immediately before reading: without preserveDrawingBuffer (which
  // costs memory bandwidth on mobile) the buffer is only valid right here.
  renderer.render(scene, camera);
  el.canvas.toBlob((blob) => {
    if (!blob) return toast('Could not capture the canvas');
    download(blob, `menger-L${state.level}.png`);
    toast(`Saved PNG · ${formatBytes(blob.size)}`);
  }, 'image/png');
}

function saveSTL() {
  if (!currentMesh) return;
  toast(`Writing STL · ${formatBytes(stlByteLength(currentMesh))}…`);
  setTimeout(() => {
    const buffer = toBinarySTL(currentMesh, EXPORT_MM);
    download(new Blob([buffer], { type: 'model/stl' }), `menger-L${state.level}.stl`);
    toast(`Saved STL · ${formatBytes(buffer.byteLength)}`);
  }, 30);
}

function saveOBJ() {
  if (!currentMesh) return;
  toast('Writing OBJ…');
  setTimeout(() => {
    const blob = new Blob(toOBJChunks(currentMesh, EXPORT_MM), { type: 'model/obj' });
    download(blob, `menger-L${state.level}.obj`);
    toast(`Saved OBJ · ${formatBytes(blob.size)}`);
  }, 30);
}

// -------------------------------------------------------------- URL state

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  // `has` first: an absent parameter must leave the default alone, and
  // Number(null) is a perfectly valid-looking 0.
  if (p.has('l')) {
    const level = Number(p.get('l'));
    if (Number.isInteger(level) && level >= 0 && level <= UI_MAX_LEVEL) state.level = level;
  }
  if (p.has('p') && PALETTES.includes(p.get('p'))) state.palette = p.get('p');
  if (p.has('c')) {
    const cut = Number(p.get('c'));
    if (Number.isFinite(cut) && cut >= 0 && cut <= 100) state.cut = Math.round(cut);
  }
  if (p.has('a') && ['x', 'y', 'z'].includes(p.get('a'))) state.cutAxis = p.get('a');
  if (p.get('s') === '1') state.spin = true;
}

let hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams({
      l: state.level,
      p: state.palette,
      c: state.cut,
      a: state.cutAxis,
    });
    if (state.spin) p.set('s', '1');
    history.replaceState(null, '', `#${p}`);
  }, 250);
}

// ------------------------------------------------------------------- boot

function bindUI() {
  el.sheetToggle.addEventListener('click', () => {
    const open = el.sheet.dataset.open !== 'false';
    el.sheet.dataset.open = String(!open);
    el.sheetToggle.setAttribute('aria-expanded', String(!open));
    // Collapsing the sheet hands the model more canvas; use it.
    requestAnimationFrame(() => frameCamera());
  });

  el.level.addEventListener('input', () => setLevel(Number(el.level.value)));
  el.levelUp.addEventListener('click', () => setLevel(state.level + 1));
  el.levelDown.addEventListener('click', () => setLevel(state.level - 1));

  onRadioGroup(el.palette, (value) => {
    state.palette = value;
    repaint();
    writeHash();
  });

  el.cut.addEventListener('input', () => {
    state.cut = Number(el.cut.value);
    syncCutUI();
    applyCut();
    writeHash();
  });

  onRadioGroup(el.cutAxis, (value) => {
    state.cutAxis = value;
    applyCut();
    writeHash();
  });

  el.spin.addEventListener('click', () => {
    state.spin = !state.spin;
    el.spin.setAttribute('aria-pressed', String(state.spin));
    controls.autoRotate = state.spin;
    needsRender = true;
    writeHash();
  });

  el.reset.addEventListener('click', () => {
    camera.position.copy(HOME_DIR);
    controls.target.set(0, 0, 0);
    frameCamera({ refit: true });
    controls.update();
  });

  el.savePng.addEventListener('click', savePNG);
  el.saveStl.addEventListener('click', saveSTL);
  el.saveObj.addEventListener('click', saveOBJ);
}

function boot() {
  readHash();
  initScene();
  startWorker();
  bindUI();

  el.sheet.dataset.open = 'true';
  el.level.max = String(UI_MAX_LEVEL);
  setRadio(el.palette, state.palette);
  el.spin.setAttribute('aria-pressed', String(state.spin));
  controls.autoRotate = state.spin;
  el.cut.value = String(state.cut);
  syncLevelUI();
  syncCutUI();
  applyCut();
  syncStats();

  rebuild();

  // Forcing a frame is also how the PNG export gets a readable buffer; exposing
  // it lets an automated run sample the canvas the same way.
  window.__menger = {
    render: () => renderer.render(scene, camera),
    state,
    get faceCount() { return currentMesh ? currentMesh.faceCount : 0; },
    get camera() { return camera.position.toArray(); },
  };
  window.__mengerBooted = true;
}

boot();
