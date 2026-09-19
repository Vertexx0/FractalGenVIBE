/**
 * Menger sponge generator — scene, controls and UI wiring.
 *
 * Mobile is the target: geometry is built in a worker, hidden faces never reach
 * the GPU, the render loop sleeps when the camera is still, and pixel ratio is
 * trimmed as the mesh grows.
 *
 * Zoom is the interesting part. Rather than building a deeper sponge — level 8
 * would be 25 billion cubes — it builds only the region in front of the camera,
 * one iteration deeper for every 3x of magnification. The region shrinks at the
 * same rate the depth grows, so the cost of a view is the same at 1x and at
 * 500,000x, and the detail never runs out.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  buildRegionMesh, raycastSponge, spongeStats,
  FRACTAL_DIMENSION, HARD_MAX_DEPTH,
} from './menger.js';
import { toBinarySTL, toOBJChunks, stlByteLength, formatBytes } from './exporters.js';

/** Ceiling for the base detail slider. Zoom takes it deeper from there. */
const UI_MAX_LEVEL = 4;
/** Longest edge of an exported model, in millimetres. */
const EXPORT_MM = 100;
/** Deepest dive the zoom slider reaches: 3^12, or one iteration per 3x. */
const MAX_ZOOM = 3 ** 12;
/**
 * How much wider than the view the built region is. Every extra bit is geometry
 * you cannot see, but without it the region's cut edges show at the margins.
 */
const REGION_MARGIN = 1.4;
const PALETTES = ['depth', 'axis', 'ember', 'bone'];

const num = new Intl.NumberFormat();
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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
  zoom: $('zoom'),
  zoomOut: $('zoom-out'),
  zoomNote: $('zoom-note'),
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

/**
 * The world point the camera orbits, and the origin every vertex is measured
 * from. A cube at depth 12 is two millionths of the sponge wide; in absolute
 * float32 coordinates it would round away to nothing, so the origin travels
 * with the view and the mantissa is spent on detail instead of on position.
 */
let focus = [0, 0, 0];
/** Where the geometry currently on the GPU was centred. */
let meshCenter = [0, 0, 0];
let currentMesh = null;
let building = false;
let needsRender = true;

/** Phones get a smaller cube budget than laptops; both are hard ceilings. */
const DEVICE_BUDGET = window.matchMedia('(pointer: coarse)').matches ? 120000 : 220000;

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
 * Vertex colours derived from world position, stretched over the region's own
 * range.
 *
 * Shading by distance from the sponge's centre puts the light on the outer
 * shell and lets the tunnels fall into shadow — but a slice at 500,000x sits
 * entirely at one distance from that centre, so the gradient would collapse and
 * the whole view would come out a single flat tone. Rescaling to the range
 * actually present keeps the same reading at every zoom.
 */
function paintColors(mesh, palette) {
  const { positions, center } = mesh;
  const colors = new Float32Array(positions.length);
  if (positions.length === 0) return colors;

  if (palette === 'axis') {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let p = 0; p < positions.length; p += 3) {
      for (let a = 0; a < 3; a++) {
        const v = positions[p + a];
        if (v < lo[a]) lo[a] = v;
        if (v > hi[a]) hi[a] = v;
      }
    }
    // A degenerate axis (a flat slab) keeps a mid tone rather than exploding.
    const span = lo.map((v, a) => Math.max(hi[a] - v, 1e-12));
    for (let p = 0; p < positions.length; p += 3) {
      for (let a = 0; a < 3; a++) {
        const t = hi[a] - lo[a] < 1e-9 ? 0.5 : (positions[p + a] - lo[a]) / span[a];
        colors[p + a] = srgbToLinear(0.08 + t * 0.9);
      }
    }
    return colors;
  }

  const stops = RAMPS[palette] || RAMPS.depth;
  const count = positions.length / 3;
  const signal = new Float32Array(count);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0, p = 0; i < count; i++, p += 3) {
    const x = positions[p] + center[0];
    const y = positions[p + 1] + center[1];
    const z = positions[p + 2] + center[2];
    const ax = x < 0 ? -x : x;
    const ay = y < 0 ? -y : y;
    const az = z < 0 ? -z : z;
    // Chebyshev distance from the centre: 1 on the outer shell, 0 at the core.
    const s = (ax > ay ? (ax > az ? ax : az) : (ay > az ? ay : az)) * 2;
    signal[i] = s;
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }

  const span = hi - lo;
  // The dark end of each ramp means "deep inside the sponge". A zoomed-in
  // region is all surface, so mapping it down there would render the whole view
  // in shadow; as the region's share of the global range shrinks, so does how
  // far into the dark end it is allowed to reach.
  const floor = 0.42 * (1 - Math.min(1, span / 0.6));
  for (let i = 0, p = 0; i < count; i++, p += 3) {
    const local = span < 1e-9 ? 0.75 : (signal[i] - lo) / span;
    const t = floor + (1 - floor) * local;
    const [r, g, b] = sampleRamp(stops, t);
    colors[p] = r;
    colors[p + 1] = g;
    colors[p + 2] = b;
  }
  return colors;
}

// ------------------------------------------------------------------- scene

let renderer, scene, camera, controls, material, innerMaterial, shell, inner;
let geometry = null;
const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.5);
/** Default viewing direction. The distance comes from the layout, not a guess. */
const HOME_DIR = new THREE.Vector3(1.05, 0.78, 1.32).normalize();
/** Bounding-sphere radius of the unit cube the sponge fills. */
const FIT_RADIUS = 0.87;
/** Camera distance at which the whole sponge fits the free canvas: zoom 1x. */
let baseDistance = 2.2;

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

  camera = new THREE.PerspectiveCamera(46, 1, 0.04, 8);   // rescaled per frame
  camera.position.copy(HOME_DIR).multiplyScalar(baseDistance);

  controls = new OrbitControls(camera, el.canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;       // on a phone panning is an accident, not a gesture
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
  shell = new THREE.Mesh(empty, material);
  inner = new THREE.Mesh(empty, innerMaterial);
  inner.visible = false;
  scene.add(shell, inner);

  resize();
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);

  controls.addEventListener('change', () => {
    needsRender = true;
    syncZoomUI();
    scheduleRebuild();
  });

  renderer.setAnimationLoop(() => {
    if (controls.update() || needsRender) {
      updateCameraClip();
      renderer.render(scene, camera);
      needsRender = false;
    }
  });
}

/**
 * Keep the near and far planes wrapped tightly around the region.
 *
 * At half a million times magnification the camera sits five millionths of a
 * unit from the surface. Fixed planes would span eight orders of magnitude, and
 * the depth buffer resolves none of it — the model renders as nothing at all.
 * Scaling them with the dive holds the ratio near 170 at every zoom.
 */
function updateCameraClip() {
  const distance = camera.position.length();
  const near = Math.max(1e-9, distance / 50);
  const far = distance * 3.4 + 0.01;
  if (camera.near === near && camera.far === far) return;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
}

// ----------------------------------------------------------------- framing

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
 * Centre the sponge in that slice, and work out the distance at which the whole
 * thing fits — which is what 1x means. Zoom is held across the change, so
 * rotating a phone or opening the sheet does not undo a dive.
 */
function frameCamera(refit = false) {
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

  const previousZoom = refit ? 1 : currentZoom();
  const halfV = Math.tan((camera.fov * Math.PI) / 360);
  baseDistance = Math.max(
    FIT_RADIUS / (halfV * (rect.h / h)),
    FIT_RADIUS / (halfV * (w / h) * (rect.w / w)),
  );
  controls.maxDistance = baseDistance;
  controls.minDistance = baseDistance / MAX_ZOOM;

  if (refit) {
    focus = [0, 0, 0];
    camera.position.copy(HOME_DIR).multiplyScalar(baseDistance);
    controls.target.set(0, 0, 0);
  } else {
    camera.position.setLength(baseDistance / previousZoom);
  }
  controls.update();
  syncZoomUI();
  needsRender = true;
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  renderer.setSize(w, h, false);
  frameCamera();
}

/** Big meshes get fewer pixels: fill rate is the wall on mobile, not triangles. */
function tunePixelRatio(faceCount) {
  const cap = faceCount > 200000 ? 1.5 : 2;
  const dpr = Math.min(window.devicePixelRatio || 1, cap);
  if (renderer.getPixelRatio() !== dpr) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    needsRender = true;
  }
}

// -------------------------------------------------------------------- zoom

const currentZoom = () => clamp(baseDistance / camera.position.length(), 1, MAX_ZOOM);

/** Slider position 0-1000 maps to magnification on a log scale. */
const sliderToZoom = (t) => MAX_ZOOM ** (t / 1000);
const zoomToSlider = (z) => (Math.log(z) / Math.log(MAX_ZOOM)) * 1000;

/**
 * What to build for the view as it stands.
 *
 * One extra iteration per 3x is the natural rate: each iteration divides a cube
 * into thirds, so the cubes hold a steady size on screen however far you dive.
 * The budget is a floor on quality, not a target — if a region turns out denser
 * than the device can take, the builder drops a level on its own.
 */
function currentRegion() {
  const distance = camera.position.length();
  const zoom = currentZoom();
  const steps = Math.max(0, Math.round(Math.log(zoom) / Math.log(3)));
  return {
    zoom,
    depth: Math.min(HARD_MAX_DEPTH, state.level + steps),
    center: focus,
    halfExtent: REGION_MARGIN * distance * Math.tan((camera.fov * Math.PI) / 360),
    budget: Math.max(20 ** state.level, DEVICE_BUDGET),
  };
}

/**
 * Point the view at whatever solid surface lies under a screen position, and
 * make that the new origin.
 *
 * The camera keeps its world position, so the picture does not jump — the point
 * being aimed at was already under the finger. What changes is what the camera
 * pivots and dives towards, and where the next region gets generated.
 */
function aimAlong(direction, schedule = true) {
  const region = currentRegion();
  const distance = camera.position.length();
  const worldCamera = [
    focus[0] + camera.position.x,
    focus[1] + camera.position.y,
    focus[2] + camera.position.z,
  ];

  // Only march the stretch of ray near the region — at depth 12 a full sweep of
  // the sponge at cell resolution would be millions of steps.
  const reach = 3 * region.halfExtent;
  const from = Math.max(0, distance - reach);
  const span = distance + reach - from;
  const start = direction.toArray().map((d, a) => worldCamera[a] + d * from);

  const hit = raycastSponge(start, direction.toArray(), region.depth, span);
  if (!hit) return false;

  focus = hit;
  camera.position.set(
    worldCamera[0] - hit[0],
    worldCamera[1] - hit[1],
    worldCamera[2] - hit[2],
  );
  controls.target.set(0, 0, 0);
  controls.update();
  aimedDepth = region.depth;
  // Hold the old geometry in the right place until the rebuild lands.
  placeMesh();
  syncZoomUI();
  if (schedule) scheduleRebuild(true);
  return true;
}

/**
 * Aim down the middle of what the viewer sees.
 *
 * Not NDC (0, 0): the view offset that lifts the model clear of the sheet moves
 * the canvas centre off the view axis, and on a phone that ray misses the
 * sponge entirely. The camera looks at the local origin, so the axis is it.
 */
function aimForward(schedule = true) {
  return aimAlong(camera.position.clone().negate().normalize(), schedule);
}

/** Aim at a point the viewer touched. Canvas NDC is right here: three folds the
 *  view offset into the projection, so unproject already accounts for it. */
function aimAt(ndcX, ndcY, schedule = true) {
  // unproject reads matrixWorld, which is otherwise only refreshed at render.
  camera.updateMatrixWorld();
  const target = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
  return aimAlong(target.sub(camera.position).normalize(), schedule);
}

/** Depth the focus was last checked against; see the re-aim in rebuild(). */
let aimedDepth = null;

function placeMesh() {
  const offset = [0, 1, 2].map((a) => meshCenter[a] - focus[a]);
  shell.position.set(...offset);
  inner.position.set(...offset);
  needsRender = true;
}

function setZoom(zoom) {
  const next = clamp(zoom, 1, MAX_ZOOM);
  // Aim first, from out here where the ray still reaches the surface. Diving
  // before aiming drops the camera into the hollow centre — the first thing the
  // sponge carves away — and from in there the ray finds nothing to aim at.
  if (next > 1.15 && focus[0] === 0 && focus[1] === 0 && focus[2] === 0) aimForward(false);
  camera.position.setLength(baseDistance / next);
  controls.update();
  syncZoomUI();
  scheduleRebuild();
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
      for (const { params, resolve } of pending.values()) resolve(buildRegionMesh(params));
      pending.clear();
    };
  } catch {
    worker = null;
  }
}

function requestMesh(params) {
  if (!worker) return Promise.resolve(buildRegionMesh(params));
  const id = ++buildId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, params });
    worker.postMessage({ id, params });
  });
}

/** Is the geometry on screen still the right thing for where the camera is? */
function stale() {
  if (!currentMesh) return true;
  const region = currentRegion();
  if (region.depth !== currentMesh.depth) return true;
  for (let a = 0; a < 3; a++) if (meshCenter[a] !== focus[a]) return true;
  // Zoomed out past the built region, or far enough in to be worth refining.
  return region.halfExtent > currentMesh.halfExtent * 1.02
    || region.halfExtent < currentMesh.halfExtent * 0.45;
}

let rebuildTimer;
/** Zoom fires continuously; only chase it once the gesture settles. */
function scheduleRebuild(immediate = false) {
  clearTimeout(rebuildTimer);
  if (!stale()) return;
  rebuildTimer = setTimeout(rebuild, immediate ? 0 : 140);
}

/**
 * Build for the view as it stands, then build again if the view moved while we
 * were busy, so a slider sweep settles on where the finger stopped.
 */
async function rebuild() {
  if (building) return;
  building = true;
  setExportsEnabled(false);
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      let region = currentRegion();
      // The sponge has zero volume: a point solid at depth 5 has almost
      // certainly been carved away by depth 15. Without re-aiming on the way
      // down, a deep dive lands in a hole and builds nothing at all.
      // Only once a dive has actually added depth — at rest the whole sponge is
      // centred on the origin, and aiming there would knock it off centre.
      if (region.depth !== aimedDepth) {
        aimedDepth = region.depth;
        if (region.depth > state.level && aimForward(false)) region = currentRegion();
      }
      setBusy(true, `Building depth ${region.depth}…`);
      try {
        const data = await requestMesh(region);
        applyMesh(data);
      } catch (error) {
        toast(`Build failed: ${error.message}`);
        break;
      }
      if (!stale()) break;
    }
  } finally {
    building = false;
    setBusy(false);
    setExportsEnabled(true);
    syncStats();
    syncZoomUI();
  }
}

function applyMesh(data) {
  currentMesh = data;
  meshCenter = data.center;
  geometry?.dispose();
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(paintColors(data, state.palette), 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  shell.geometry = geometry;
  inner.geometry = geometry;
  placeMesh();
  applyCut();
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

/** The cut sweeps across whatever is built, so it still bites when zoomed in. */
function applyCut() {
  let planes = [];
  if (state.cut > 0 && currentMesh) {
    const axis = state.cutAxis;
    const a = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    clipPlane.normal.set(a === 0 ? -1 : 0, a === 1 ? -1 : 0, a === 2 ? -1 : 0);
    const half = Math.min(currentMesh.halfExtent, 0.5);
    // 0 keeps everything, 100 leaves a sliver — never an empty screen.
    clipPlane.constant = half - (state.cut / 100) * 2 * half * 0.98;
    planes = [clipPlane];
  }
  for (const m of [material, innerMaterial]) {
    m.clippingPlanes = planes;
    m.needsUpdate = true;
  }
  inner.visible = state.cut > 0;
  needsRender = true;
}

// ---------------------------------------------------------------------- UI

let busyTimer;
/** Held back briefly: most rebuilds finish faster than a spinner can read. */
function setBusy(on, label = 'Building…') {
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

/** Compact magnification: 1x, 27x, 1.3kx, 531kx. */
function formatZoom(zoom) {
  if (zoom < 10) return `${zoom.toFixed(1).replace(/\.0$/, '')}×`;
  if (zoom < 1000) return `${Math.round(zoom)}×`;
  if (zoom < 1e6) return `${(zoom / 1000).toFixed(zoom < 1e4 ? 1 : 0)}k×`;
  return `${(zoom / 1e6).toFixed(1)}M×`;
}

/** 20^depth, which stops fitting in a person's head somewhere around depth 8. */
function wholeSpongeCubes(depth) {
  const total = 20 ** depth;
  return total < 1e9 ? num.format(total) : total.toExponential(1).replace('e+', 'e');
}

function syncStats() {
  const tris = currentMesh ? currentMesh.faceCount * 2 : 0;
  const cubes = currentMesh ? currentMesh.cubeCount : 0;
  const depth = currentMesh ? currentMesh.depth : state.level;
  el.stats.textContent =
    `${num.format(cubes)} cubes · ${num.format(tris)} tris · depth ${depth} · ` +
    `${formatZoom(currentZoom())} · dim ${FRACTAL_DIMENSION.toFixed(3)}`;
}

function syncZoomUI() {
  const zoom = currentZoom();
  const depth = currentMesh ? currentMesh.depth : currentRegion().depth;
  el.zoom.value = String(Math.round(zoomToSlider(zoom)));
  el.zoomOut.textContent = formatZoom(zoom);
  el.zoomNote.textContent = depth <= state.level
    ? `Depth ${depth} · tap the sponge to aim`
    : `Depth ${depth} · ${wholeSpongeCubes(depth)} cubes if built whole`;
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
  const level = clamp(next, 0, UI_MAX_LEVEL);
  if (level === state.level) return;
  state.level = level;
  syncLevelUI();
  syncZoomUI();
  writeHash();
  scheduleRebuild(true);
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

/** Scale so the exported piece is EXPORT_MM across, whole sponge or slice. */
const exportScale = (mesh) => EXPORT_MM / Math.min(1, Math.max(2 * mesh.halfExtent, 1e-9));

const exportName = (extension) =>
  `menger-d${currentMesh.depth}${currentMesh.halfExtent < 0.5 ? '-slice' : ''}.${extension}`;

function savePNG() {
  // Render immediately before reading: without preserveDrawingBuffer (which
  // costs memory bandwidth on mobile) the buffer is only valid right here.
  renderer.render(scene, camera);
  el.canvas.toBlob((blob) => {
    if (!blob) return toast('Could not capture the canvas');
    download(blob, exportName('png'));
    toast(`Saved PNG · ${formatBytes(blob.size)}`);
  }, 'image/png');
}

function saveSTL() {
  if (!currentMesh) return;
  toast(`Writing STL · ${formatBytes(stlByteLength(currentMesh))}…`);
  setTimeout(() => {
    const buffer = toBinarySTL(currentMesh, exportScale(currentMesh));
    download(new Blob([buffer], { type: 'model/stl' }), exportName('stl'));
    toast(`Saved STL · ${formatBytes(buffer.byteLength)}`);
  }, 30);
}

function saveOBJ() {
  if (!currentMesh) return;
  toast('Writing OBJ…');
  setTimeout(() => {
    const blob = new Blob(toOBJChunks(currentMesh, exportScale(currentMesh)), { type: 'model/obj' });
    download(blob, exportName('obj'));
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
  if (p.has('f')) {
    const parts = p.get('f').split(',').map(Number);
    if (parts.length === 3 && parts.every((v) => Number.isFinite(v) && Math.abs(v) <= 0.5)) {
      focus = parts;
    }
  }
  return p.has('z') ? clamp(Number(p.get('z')) || 1, 1, MAX_ZOOM) : 1;
}

let hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const zoom = currentZoom();
    const p = new URLSearchParams({
      l: state.level,
      p: state.palette,
      c: state.cut,
      a: state.cutAxis,
    });
    if (zoom > 1.01) {
      p.set('z', zoom.toPrecision(6));
      // Deep dives need the focus to many digits or the link lands elsewhere.
      p.set('f', focus.map((v) => Number(v.toPrecision(12))).join(','));
    }
    if (state.spin) p.set('s', '1');
    try {
      history.replaceState(null, '', `#${p}`);
    } catch {
      // Sandboxed frames refuse replaceState; the app does not depend on it.
    }
  }, 250);
}

// ------------------------------------------------------------------- boot

/** A press that neither moved nor lingered is a tap: aim there. */
function bindAiming() {
  let start = null;
  el.canvas.addEventListener('pointerdown', (event) => {
    start = { x: event.clientX, y: event.clientY, at: performance.now(), id: event.pointerId };
  });
  el.canvas.addEventListener('pointerup', (event) => {
    if (!start || start.id !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    const held = performance.now() - start.at;
    start = null;
    if (moved > 8 || held > 500) return;
    const rect = el.canvas.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    if (aimAt(ndcX, ndcY)) writeHash();
    else toast('Nothing solid under there — the sponge is mostly holes');
  });
  el.canvas.addEventListener('pointercancel', () => { start = null; });
}

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

  el.zoom.addEventListener('input', () => {
    setZoom(sliderToZoom(Number(el.zoom.value)));
    writeHash();
  });

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
    aimedDepth = null;
    frameCamera(true);
    scheduleRebuild(true);
    writeHash();
  });

  el.savePng.addEventListener('click', savePNG);
  el.saveStl.addEventListener('click', saveSTL);
  el.saveObj.addEventListener('click', saveOBJ);

  bindAiming();
}

function boot() {
  const startZoom = readHash();
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
  if (startZoom > 1) camera.position.setLength(baseDistance / startZoom);
  controls.update();
  syncZoomUI();
  syncStats();

  rebuild();

  // Forcing a frame is also how the PNG export gets a readable buffer; exposing
  // it lets an automated run sample the canvas the same way.
  window.__menger = {
    render: () => renderer.render(scene, camera),
    state,
    aimAt,
    setZoom,
    get zoom() { return currentZoom(); },
    get focus() { return focus.slice(); },
    get depth() { return currentMesh ? currentMesh.depth : 0; },
    get faceCount() { return currentMesh ? currentMesh.faceCount : 0; },
    get camera() { return camera.position.toArray(); },
  };
  window.__mengerBooted = true;
}

boot();
