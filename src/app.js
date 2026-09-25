/**
 * Menger sponge generator — scene, controls and UI wiring.
 *
 * Mobile is the target: geometry is built in a worker, hidden faces never reach
 * the GPU, the render loop sleeps when the camera is still, and pixel ratio is
 * trimmed as the mesh grows.
 *
 * What gets built is what the camera can see (see buildViewMesh): cubes are
 * split while they are large on screen, culled when outside the view or behind
 * the surface in front, and left coarse when far away. Near structure therefore
 * runs many iterations deeper than distant structure, and a single view shows
 * depths from the whole sponge down to cubes a few pixels wide. Zooming raises
 * the ceiling by one iteration per 3x, so the detail never runs out.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  buildViewMesh, buildRegionMesh, raycastSponge, HARD_MAX_DEPTH,
} from './menger.js';
import { toBinarySTL, toOBJChunks, stlByteLength, formatBytes } from './exporters.js';

/** Ceiling for the iterations slider: the deepest level allowed at 1x. */
const UI_MAX_LEVEL = 7;
/** Longest edge of an exported model, in millimetres. */
const EXPORT_MM = 100;
/** Most cubes in an exported mesh; deeper requests drop a level to fit. */
const EXPORT_BUDGET = 260000;
/** Deepest dive the zoom slider reaches: 3^12, or one iteration per 3x. */
const MAX_ZOOM = 3 ** 12;
/** Half-width of the neighbourhood the zoom aims within and exports, in view heights. */
const REGION_MARGIN = 1.4;
/**
 * How much wider than the view the culling frustum is. The spare ring is
 * geometry you cannot see yet, and it is what keeps a small orbit from
 * opening a gap at the screen edge before the next build lands.
 */
const CULL_FOV_SCALE = 1.3;
/** Nothing further than this many focus-distances away is built or drawn. */
const FAR_FACTOR = 300;
/** Orbit this far, or dolly by this ratio, and the view is rebuilt. */
const REBUILD_ANGLE = Math.cos((4 * Math.PI) / 180);
const REBUILD_DOLLY = 1.15;
const PALETTES = ['depth', 'axis', 'ember', 'bone'];

/**
 * Detail presets scale the cube budget and set the smallest cube worth
 * splitting. Phones start from a smaller budget than laptops.
 */
const BASE_BUDGET = window.matchMedia('(pointer: coarse)').matches ? 110000 : 200000;
const DETAILS = {
  low: { budget: 0.45, minPixels: 4 },
  medium: { budget: 1, minPixels: 2.5 },
  high: { budget: 1.9, minPixels: 1.75 },
};

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
  detail: $('detail'),
  detailNote: $('detail-note'),
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
  level: 5,
  detail: 'medium',
  palette: 'depth',
  cut: 0,
  cutAxis: 'x',
  spin: false,
};

/**
 * The world point the camera orbits, and the origin every vertex is measured
 * from. A cube at depth 15 is 7e-8 of the sponge wide; in absolute float32
 * coordinates it would round away to nothing, so the origin travels with the
 * view and the mantissa is spent on detail instead of on position.
 */
let focus = [0, 0, 0];
/** Where the geometry currently on the GPU was centred. */
let meshCenter = [0, 0, 0];
let currentMesh = null;
/** The camera and settings the current mesh was built for. */
let built = null;
/** Last build's pixel threshold: the next build's starting guess. */
let thresholdHint = 6;
let building = false;
let needsRender = true;

// ---------------------------------------------------------------- palettes

/** Gradient stops in sRGB 0-255, from deep inside the sponge to its rim. */
const RAMPS = {
  depth: [
    [0.0, 18, 32, 66],
    [0.45, 44, 128, 196],
    [0.75, 124, 198, 255],
    [1.0, 236, 248, 255],
  ],
  ember: [
    [0.0, 46, 12, 22],
    [0.4, 178, 44, 42],
    [0.72, 244, 140, 40],
    [1.0, 255, 232, 156],
  ],
  bone: [
    [0.0, 96, 100, 112],
    [0.6, 208, 210, 214],
    [1.0, 250, 250, 248],
  ],
};

/**
 * A ramp as a 256-texel strip. The shading value comes from the geometry (see
 * shadeVertex), and the palette is looked up per pixel on the GPU — so
 * switching palette is a texture swap, not a pass over a million vertices.
 */
function rampTexture(stops) {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < stops.length - 1 && t > stops[k][0]) k++;
    const [a0, ...c0] = stops[k - 1];
    const [a1, ...c1] = stops[k];
    const f = a1 === a0 ? 0 : clamp((t - a0) / (a1 - a0), 0, 1);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * f);
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const rampTextures = Object.fromEntries(
  Object.entries(RAMPS).map(([name, stops]) => [name, rampTexture(stops)]));

const paletteUniforms = {
  uRamp: { value: rampTextures.depth },
  uAxis: { value: 0 },
};

function applyPalette() {
  paletteUniforms.uRamp.value = rampTextures[state.palette] || rampTextures.depth;
  paletteUniforms.uAxis.value = state.palette === 'axis' ? 1 : 0;
  needsRender = true;
}

/**
 * Standard physically based shading with the base colour replaced: a ramp
 * lookup on the per-vertex `shade` value, or — for `axis` — a colour per face
 * direction, darkened by the same value. Both read the same at any zoom,
 * because `shade` measures depth within a cube's own nested blocks.
 */
function shadeMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0.06,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, paletteUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float shade;
varying float vShade;
varying vec3 vFaceNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vShade = shade;
vFaceNormal = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uRamp;
uniform float uAxis;
varying float vShade;
varying vec3 vFaceNormal;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float shadeT = clamp(vShade * 0.88 + 0.12, 0.0, 1.0);
vec3 tint = texture2D(uRamp, vec2(shadeT, 0.5)).rgb;
if (uAxis > 0.5) {
  vec3 n = abs(vFaceNormal);
  vec3 axisColor = n.x > 0.5 ? vec3(0.86, 0.19, 0.16)
    : n.y > 0.5 ? vec3(0.22, 0.62, 0.26) : vec3(0.14, 0.33, 0.9);
  tint = axisColor * (0.2 + 0.8 * shadeT);
}
diffuseColor.rgb *= tint;`);
  };
  material.customProgramCacheKey = () => 'menger-shade';
  return material;
}

// ------------------------------------------------------------------- scene

let renderer, scene, camera, controls, material, innerMaterial, shell, inner, fog;
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
  // Distant, coarse structure fades into the background, which reads as depth
  // and keeps the far plane from ever showing as an edge.
  fog = new THREE.Fog(0x0b0d12, 10, 100);
  scene.fog = fog;

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

  material = shadeMaterial();

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
 * Keep the near and far planes, and the fog, scaled to the camera's distance
 * from the focus.
 *
 * At half a million times magnification the camera sits a few millionths of a
 * unit from the surface. Planes fixed in world units would span many orders of
 * magnitude and the depth buffer would resolve none of it; scaled with the
 * dive, their ratio holds at FAR_FACTOR * 40 at every zoom. The builder uses
 * the same far distance, so nothing is built that would not be drawn.
 */
function updateCameraClip() {
  const distance = camera.position.length();
  const near = Math.max(1e-10, distance / 40);
  const far = distance * FAR_FACTOR;
  fog.near = distance * 6;
  fog.far = distance * 150;
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
    placeMesh();
  } else {
    camera.position.setLength(baseDistance / previousZoom);
  }
  controls.update();
  syncZoomUI();
  needsRender = true;
  scheduleRebuild();
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
  const cap = faceCount > 300000 ? 1.5 : 2;
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
 * The depth ceiling for the view as it stands, and the scale of the
 * neighbourhood around the focus.
 *
 * One extra iteration per 3x is the natural rate: each iteration divides a cube
 * into thirds, so the finest cubes hold a steady size on screen however far
 * you dive. The builder decides how much of that ceiling each part of the view
 * actually reaches.
 */
function currentRegion() {
  const distance = camera.position.length();
  const zoom = currentZoom();
  const steps = Math.max(0, Math.round(Math.log(zoom) / Math.log(3)));
  return {
    zoom,
    distance,
    depth: Math.min(HARD_MAX_DEPTH, state.level + steps),
    halfExtent: REGION_MARGIN * distance * Math.tan((camera.fov * Math.PI) / 360),
  };
}

/**
 * Point the view at whatever solid surface lies under a screen position, and
 * make that the new origin.
 *
 * The camera keeps its world position, so the picture does not jump — the point
 * being aimed at was already under the finger. What changes is what the camera
 * pivots and dives towards.
 */
function aimAlong(direction, schedule = true) {
  const region = currentRegion();
  const distance = camera.position.length();
  const worldCamera = [
    focus[0] + camera.position.x,
    focus[1] + camera.position.y,
    focus[2] + camera.position.z,
  ];

  // Only march the stretch of ray near the focus — at depth 12 a full sweep of
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

/** Depth the focus was last checked against; see diveFocus. */
let aimedDepth = null;

/**
 * Walk the focus down to `toDepth` one level at a time, keeping it on solid
 * material the whole way.
 *
 * The sponge has zero volume: a point that is solid at depth 5 has almost
 * certainly been carved away by depth 15, and the hole it falls into may have
 * been cut at any scale in between. Re-aiming only at the final depth, from a
 * camera a few millionths of a unit away, cannot see out of a hole cut at depth
 * 8. So each level is aimed from the distance at which that level is the
 * ceiling — close enough to resolve it, far enough to see past the holes of
 * the level before. This is what stepping the slider did implicitly; a flick
 * straight to the end has to do it explicitly.
 */
function diveFocus(fromDepth, toDepth) {
  const dir = camera.position.clone().normalize().toArray();   // focus -> camera
  const back = dir.map((d) => -d);
  const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
  let moved = false;
  for (let depth = Math.max(fromDepth + 1, state.level + 1); depth <= toDepth; depth++) {
    const distance = baseDistance / 3 ** (depth - state.level);
    const eye = focus.map((f, a) => f + dir[a] * distance);
    const reach = 3 * REGION_MARGIN * distance * tanHalf;
    const from = Math.max(0, distance - reach);
    const hit = raycastSponge(eye.map((e, a) => e + back[a] * from), back, depth,
      distance + reach - from);
    if (hit) {
      focus = hit;
      moved = true;
    }
  }
  return moved;
}

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
  followDive();
  controls.update();
  syncZoomUI();
  scheduleRebuild();
  needsRender = true;
}

/**
 * Keep the focus on material as the depth ceiling rises. Zooming back out
 * needs nothing: material at a fine depth is material at every coarser one,
 * and the view builder refines whatever is near the camera regardless.
 */
function followDive() {
  const region = currentRegion();
  if (aimedDepth === null) aimedDepth = state.level;
  if (region.depth > aimedDepth && region.depth > state.level) {
    // The camera is positioned relative to the focus, so it follows along.
    if (diveFocus(aimedDepth, region.depth)) placeMesh();
  }
  aimedDepth = region.depth;
}

// ------------------------------------------------------------ build queue

let worker = null;
let buildId = 0;
const pending = new Map();
const BUILDERS = { view: buildViewMesh, region: buildRegionMesh };

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
    worker.onerror = (event) => {
      // Module workers are unavailable (older Safari, file://, sandboxes):
      // fall back to building on the main thread.
      event.preventDefault?.();
      worker = null;
      for (const { kind, params, resolve } of pending.values()) resolve(BUILDERS[kind](params));
      pending.clear();
    };
  } catch {
    worker = null;
  }
}

function requestMesh(kind, params) {
  if (!worker) return Promise.resolve(BUILDERS[kind](params));
  const id = ++buildId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, kind, params });
    worker.postMessage({ id, kind, params });
  });
}

/** The cutaway plane for the current view, in coordinates relative to focus. */
function currentClip() {
  if (state.cut <= 0) return null;
  const a = state.cutAxis === 'x' ? 0 : state.cutAxis === 'y' ? 1 : 2;
  const half = Math.min(currentRegion().halfExtent, 0.5);
  // 0 keeps everything, 100 leaves a sliver — never an empty screen.
  const constant = half - (state.cut / 100) * 2 * half * 0.98;
  return [a === 0 ? -1 : 0, a === 1 ? -1 : 0, a === 2 ? -1 : 0, constant];
}

const scratchMatrix = new THREE.Matrix4();
const scratchFrustum = new THREE.Frustum();

/** Everything the view builder needs to know about the camera, right now. */
function viewParams(region) {
  camera.updateMatrixWorld();
  const cull = camera.clone();
  cull.fov = Math.min(150, camera.fov * CULL_FOV_SCALE);
  cull.updateProjectionMatrix();
  scratchFrustum.setFromProjectionMatrix(
    scratchMatrix.multiplyMatrices(cull.projectionMatrix, cull.matrixWorldInverse));
  // Sides and near; the far plane is applied as a distance instead.
  const planes = [0, 1, 2, 3, 5].map((i) => {
    const { normal, constant } = scratchFrustum.planes[i];
    return [normal.x, normal.y, normal.z, constant];
  });
  const detail = DETAILS[state.detail];
  const halfV = Math.tan((camera.fov * Math.PI) / 360);
  return {
    origin: focus.slice(),
    eye: camera.position.toArray(),
    planes,
    viewProjection: scratchMatrix
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements.slice(),
    viewport: [window.innerWidth, window.innerHeight],
    pixelsPerUnit: window.innerHeight / (2 * halfV),
    maxDepth: region.depth,
    budget: Math.round(BASE_BUDGET * detail.budget),
    minPixels: detail.minPixels,
    threshold: thresholdHint,
    farDistance: region.distance * FAR_FACTOR,
    focusDistance: region.distance,
    falloff: 1,
    clip: currentClip(),
  };
}

/** Snapshot of what a build was for, to tell when it no longer fits. */
function viewKey(region) {
  return {
    dir: camera.position.clone().normalize(),
    distance: region.distance,
    focus: focus.slice(),
    depth: region.depth,
    level: state.level,
    detail: state.detail,
    cut: `${state.cut}:${state.cutAxis}`,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/** Is the geometry on screen still the right thing for where the camera is? */
function stale() {
  if (!currentMesh || !built) return true;
  const region = currentRegion();
  if (built.depth !== region.depth || built.level !== state.level
    || built.detail !== state.detail || built.cut !== `${state.cut}:${state.cutAxis}`
    || built.width !== window.innerWidth || built.height !== window.innerHeight) return true;
  for (let a = 0; a < 3; a++) if (built.focus[a] !== focus[a]) return true;
  const ratio = region.distance / built.distance;
  if (ratio > REBUILD_DOLLY || ratio < 1 / REBUILD_DOLLY) return true;
  return camera.position.clone().normalize().dot(built.dir) < REBUILD_ANGLE;
}

let rebuildTimer = null;
/**
 * Throttled, not debounced: during a long orbit the view keeps going stale, and
 * waiting for the gesture to end would leave the edges bare the whole time.
 */
function scheduleRebuild(immediate = false) {
  if (!stale()) return;
  if (immediate) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
    rebuild();
    return;
  }
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuild();
  }, 90);
}

/**
 * Build for the view as it stands, then again if the view moved meanwhile.
 * Orbit-driven rebuilds are silent; the spinner is for changes the viewer asked
 * for and is waiting on.
 */
async function rebuild() {
  if (building) return;
  building = true;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      // Pinch and wheel zoom arrive here without passing through setZoom.
      followDive();
      const region = currentRegion();
      const waiting = !built || built.depth !== region.depth || built.level !== state.level
        || built.detail !== state.detail;
      if (waiting) setBusy(true, `Building to depth ${region.depth}…`);
      const key = viewKey(region);
      const data = await requestMesh('view', viewParams(region));
      thresholdHint = data.threshold;
      built = key;
      applyMesh(data);
      if (!stale()) break;
    }
  } catch (error) {
    toast(`Build failed: ${error.message}`);
  } finally {
    building = false;
    setBusy(false);
    syncStats();
    syncZoomUI();
    syncDetailUI();
    if (stale()) scheduleRebuild();
  }
}

function applyMesh(data) {
  currentMesh = data;
  meshCenter = data.center;
  geometry?.dispose();
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3, true));
  geometry.setAttribute('shade', new THREE.BufferAttribute(data.shade, 1));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  shell.geometry = geometry;
  inner.geometry = geometry;
  placeMesh();
  applyCut(false);
  tunePixelRatio(data.faceCount);
  needsRender = true;
}

/**
 * The cut sweeps across the neighbourhood of the focus, so it still bites when
 * zoomed in. The GPU clips immediately; the rebuild that follows fills in the
 * interior the cut exposes, which the previous build had culled as hidden.
 */
function applyCut(rebuildAfter = true) {
  const clip = currentClip();
  let planes = [];
  if (clip) {
    clipPlane.normal.set(clip[0], clip[1], clip[2]);
    clipPlane.constant = clip[3];
    planes = [clipPlane];
  }
  for (const m of [material, innerMaterial]) {
    if (m.clippingPlanes?.length !== planes.length) m.needsUpdate = true;
    m.clippingPlanes = planes;
  }
  inner.visible = state.cut > 0;
  needsRender = true;
  if (rebuildAfter) scheduleRebuild();
}

// ---------------------------------------------------------------------- UI

let busyTimer;
/** Held back: most builds finish faster than a spinner can read. */
function setBusy(on, label = 'Building…') {
  clearTimeout(busyTimer);
  if (!on) {
    el.busy.hidden = true;
    return;
  }
  el.busyLabel.textContent = label;
  busyTimer = setTimeout(() => { el.busy.hidden = false; }, 250);
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

const depthRange = (mesh) => (mesh.depthMin === mesh.depthMax
  ? `depth ${mesh.depthMax}` : `depths ${mesh.depthMin}–${mesh.depthMax}`);

function syncStats() {
  if (!currentMesh) return;
  el.stats.textContent =
    `${num.format(currentMesh.cubeCount)} cubes · ${num.format(currentMesh.faceCount * 2)} tris · ` +
    `${depthRange(currentMesh)} · ${formatZoom(currentZoom())}`;
}

function syncZoomUI() {
  const zoom = currentZoom();
  el.zoom.value = String(Math.round(zoomToSlider(zoom)));
  el.zoomOut.textContent = formatZoom(zoom);
  const deepest = currentMesh ? currentMesh.depthMax : currentRegion().depth;
  el.zoomNote.textContent = zoom < 1.5
    ? `Tap the sponge to aim, then dive`
    : `Depth ${deepest} at the focus · ${wholeSpongeCubes(deepest)} cubes if built whole`;
}

function syncLevelUI() {
  el.level.value = String(state.level);
  el.levelOut.textContent = String(state.level);
  el.levelDown.disabled = state.level <= 0;
  el.levelUp.disabled = state.level >= UI_MAX_LEVEL;
  el.levelNote.textContent =
    `Deepest level at 1× · ${wholeSpongeCubes(state.level)} cubes if built whole`;
}

function syncDetailUI() {
  setRadio(el.detail, state.detail);
  const budget = Math.round(BASE_BUDGET * DETAILS[state.detail].budget);
  const finest = currentMesh ? ` · finest cubes ~${currentMesh.threshold.toFixed(1)} px` : '';
  el.detailNote.textContent = `Up to ${num.format(budget)} visible cubes${finest}`;
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
  aimedDepth = Math.min(aimedDepth ?? level, currentRegion().depth);
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

/**
 * The on-screen mesh is view-dependent — mixed depths, hidden parts culled —
 * which is right for looking at and wrong for printing. Exports are built
 * separately: one depth, closed, around the focus.
 */
async function exportMesh() {
  const region = currentRegion();
  return requestMesh('region', {
    depth: region.depth,
    center: focus.slice(),
    halfExtent: region.halfExtent,
    budget: EXPORT_BUDGET,
  });
}

/** Scale so the exported piece is EXPORT_MM across, whole sponge or slice. */
const exportScale = (mesh) => EXPORT_MM / Math.min(1, Math.max(2 * mesh.halfExtent, 1e-9));

const exportName = (depth, slice, extension) =>
  `menger-d${depth}${slice ? '-slice' : ''}.${extension}`;

/** Does the export neighbourhood stop short of the whole sponge? */
const isSlice = () => {
  const { halfExtent } = currentRegion();
  return focus.some((f) => Math.abs(f) + 0.5 > halfExtent);
};

function savePNG() {
  // Render immediately before reading: without preserveDrawingBuffer (which
  // costs memory bandwidth on mobile) the buffer is only valid right here.
  renderer.render(scene, camera);
  el.canvas.toBlob((blob) => {
    if (!blob) return toast('Could not capture the canvas');
    download(blob, exportName(currentMesh ? currentMesh.depthMax : state.level, isSlice(), 'png'));
    toast(`Saved PNG · ${formatBytes(blob.size)}`);
  }, 'image/png');
}

async function saveModel(extension) {
  setExportsEnabled(false);
  toast(`Building ${extension.toUpperCase()}…`);
  try {
    const mesh = await exportMesh();
    const name = exportName(mesh.depth, isSlice(), extension);
    let blob;
    if (extension === 'stl') {
      toast(`Writing STL · ${formatBytes(stlByteLength(mesh))}…`);
      blob = new Blob([toBinarySTL(mesh, exportScale(mesh))], { type: 'model/stl' });
    } else {
      blob = new Blob(toOBJChunks(mesh, exportScale(mesh)), { type: 'model/obj' });
    }
    download(blob, name);
    toast(`Saved ${extension.toUpperCase()} · ${formatBytes(blob.size)} · depth ${mesh.depth}`);
  } catch (error) {
    toast(`Export failed: ${error.message}`);
  } finally {
    setExportsEnabled(true);
  }
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
  if (p.has('d') && p.get('d') in DETAILS) state.detail = p.get('d');
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
      d: state.detail,
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

  onRadioGroup(el.detail, (value) => {
    state.detail = value;
    syncDetailUI();
    writeHash();
    scheduleRebuild(true);
  });

  onRadioGroup(el.palette, (value) => {
    state.palette = value;
    applyPalette();
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
    aimedDepth = state.level;
    frameCamera(true);
    scheduleRebuild(true);
    writeHash();
  });

  el.savePng.addEventListener('click', savePNG);
  el.saveStl.addEventListener('click', () => saveModel('stl'));
  el.saveObj.addEventListener('click', () => saveModel('obj'));

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
  applyPalette();
  el.spin.setAttribute('aria-pressed', String(state.spin));
  controls.autoRotate = state.spin;
  el.cut.value = String(state.cut);
  syncLevelUI();
  syncDetailUI();
  syncCutUI();
  applyCut(false);
  if (startZoom > 1) camera.position.setLength(baseDistance / startZoom);
  controls.update();
  syncZoomUI();

  rebuild();

  // Forcing a frame is also how the PNG export gets a readable buffer; exposing
  // it lets an automated run sample the canvas the same way.
  window.__menger = {
    render: () => {
      updateCameraClip();
      renderer.render(scene, camera);
    },
    state,
    aimAt,
    setZoom,
    get zoom() { return currentZoom(); },
    get focus() { return focus.slice(); },
    get depth() { return currentMesh ? currentMesh.depthMax : 0; },
    get depthMin() { return currentMesh ? currentMesh.depthMin : 0; },
    get threshold() { return currentMesh ? currentMesh.threshold : 0; },
    get faceCount() { return currentMesh ? currentMesh.faceCount : 0; },
    get cubeCount() { return currentMesh ? currentMesh.cubeCount : 0; },
    get building() { return building || rebuildTimer !== null; },
    get camera() { return camera.position.toArray(); },
    visibleRect,
  };
  window.__mengerBooted = true;
}

boot();
