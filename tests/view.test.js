import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  buildViewMesh, buildSurfaceMesh, isSolidCell, neighbourSolid, raycastSponge,
} from '../src/menger.js';

const FOV = 46;
const TAN = Math.tan((FOV * Math.PI) / 360);

/**
 * The same view parameters the app computes: a camera in coordinates relative
 * to `origin`, a culling frustum 1.3x wider, and the matrix for occlusion.
 */
function makeView({ origin = [0, 0, 0], eye, width = 1200, height = 800 }) {
  const camera = new THREE.PerspectiveCamera(FOV, width / height, 1e-9, 100);
  camera.position.set(...eye);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const distance = Math.hypot(...eye);
  camera.near = distance / 40;
  camera.far = distance * 300;
  camera.updateProjectionMatrix();
  const cull = camera.clone();
  cull.fov = FOV * 1.3;
  cull.updateProjectionMatrix();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cull.projectionMatrix, cull.matrixWorldInverse));
  const planes = [0, 1, 2, 3, 5].map((i) => [...frustum.planes[i].normal.toArray(), frustum.planes[i].constant]);
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return {
    camera,
    params: {
      origin, eye, planes,
      viewProjection: matrix.elements.slice(),
      viewport: [width, height],
      pixelsPerUnit: height / (2 * TAN),
      focusDistance: distance,
      farDistance: Math.max(distance * 300, 4),
    },
  };
}

/** Dive toward a surface the way the app does: aim, move in 3x, re-aim. */
function dive(steps, base = 4) {
  const dir = new THREE.Vector3(1.05, 0.78, 1.32).normalize().toArray();
  const back = dir.map((d) => -d);
  let focus = [0, 0, 0];
  let distance = 2.3;
  for (let s = 0; s <= steps; s++) {
    const eye = focus.map((f, a) => f + dir[a] * distance);
    const half = 1.4 * distance * TAN;
    const from = Math.max(0, distance - 3 * half);
    const hit = raycastSponge(eye.map((e, a) => e + back[a] * from), back, base + s,
      distance + 3 * half - from);
    if (hit) {
      distance = Math.hypot(...eye.map((e, a) => e - hit[a]));
      focus = hit;
    }
    if (s < steps) distance /= 3;
  }
  return { focus, eye: dir.map((d) => d * distance), distance };
}

const key = (d, x, y, z) => `${d},${x},${y},${z}`;

/** Would the builder have generated this cell at all? Same test it uses. */
function inView({ origin, eye, planes, farDistance }, d, x, y, z) {
  const size = 3 ** -d;
  const lo = [x, y, z].map((v, a) => v * size - 0.5 - origin[a]);
  const hi = lo.map((v) => v + size);
  for (const [nx, ny, nz, c] of planes) {
    const px = nx >= 0 ? hi[0] : lo[0];
    const py = ny >= 0 ? hi[1] : lo[1];
    const pz = nz >= 0 ? hi[2] : lo[2];
    if (nx * px + ny * py + nz * pz + c < 0) return false;
  }
  const gap = [0, 1, 2].map((a) => Math.max(lo[a] - eye[a], 0, eye[a] - hi[a]));
  return Math.hypot(...gap) <= farDistance;
}

function leafSet(mesh) {
  const set = new Set();
  for (let i = 0; i < mesh.cells.length; i += 4) {
    set.add(key(mesh.cells[i], mesh.cells[i + 1], mesh.cells[i + 2], mesh.cells[i + 3]));
  }
  return set;
}

/** The leaf containing a world point, if any: checked from the root down. */
function leafAt(set, point, maxDepth) {
  for (let d = 0; d <= maxDepth; d++) {
    const scale = 3 ** d;
    const k = key(d, ...point.map((v) => Math.floor((v + 0.5) * scale)));
    if (set.has(k)) return k;
  }
  return null;
}

/** Is cell (x, y, z) at `depth` inside some leaf — itself or an ancestor? */
function coveredByLeaf(set, depth, x, y, z) {
  for (let d = depth; d >= 0; d--) {
    if (set.has(key(d, x, y, z))) return true;
    x = Math.floor(x / 3);
    y = Math.floor(y / 3);
    z = Math.floor(z / 3);
  }
  return false;
}

test('the carry-limited neighbour test agrees with the full digit rule', () => {
  const depth = 3;
  const size = 27;
  let checked = 0;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        if (!isSolidCell(x, y, z, depth)) continue;
        for (let axis = 0; axis < 3; axis++) {
          for (const step of [-1, 1]) {
            const n = [x, y, z];
            n[axis] += step;
            assert.equal(neighbourSolid(x, y, z, axis, step, depth), isSolidCell(...n, depth),
              `${x},${y},${z} axis ${axis} step ${step}`);
            checked++;
          }
        }
      }
    }
  }
  assert.equal(checked, 8000 * 6);
});

test('with nothing culled and no pixel limit, the view mesh is the whole sponge', () => {
  const { params } = makeView({ eye: [4, 3, 5] });
  const view = buildViewMesh({
    ...params, viewProjection: null, maxDepth: 3,
    budget: Infinity, minPixels: 1e-6, threshold: 1e-6,
  });
  const whole = buildSurfaceMesh(3);
  assert.equal(view.cubeCount, whole.cubeCount);
  assert.equal(view.faceCount, whole.faceCount);
  assert.equal(view.depthMin, 3);
  assert.equal(view.depthMax, 3);
});

test('the budget is a ceiling, and the search uses a fair share of it', () => {
  const { params } = makeView({ eye: [1.4, 1.05, 1.75] });
  const mesh = buildViewMesh({ ...params, maxDepth: 7, budget: 6000, threshold: 1 });
  assert.ok(mesh.cubeCount <= 6000, `overran: ${mesh.cubeCount}`);
  assert.ok(mesh.cubeCount >= 6000 * 0.3, `left most of the budget unused: ${mesh.cubeCount}`);
});

test('everything solid inside the view is built — not just a box around the focus', () => {
  // The bug this guards: building an axis-aligned box around the focus leaves a
  // hard edge wherever the view (a frustum, widening with distance) runs past it.
  const { focus, eye, distance } = dive(4);
  const { camera, params } = makeView({ origin: focus, eye });
  const mesh = buildViewMesh({
    ...params, viewProjection: null, maxDepth: 10,
    budget: Infinity, minPixels: 14, threshold: 14, keepCells: true,
  });
  const leaves = leafSet(mesh);
  const oldBox = 1.4 * distance * TAN;       // the previous builder's half-extent
  let solid = 0;
  let outsideOldBox = 0;
  let random = 12345;
  const rand = () => ((random = (random * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 4000; i++) {
    const ndc = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, 0.5).unproject(camera);
    const dir = ndc.sub(camera.position).normalize();
    const t = distance * (0.2 + rand() * 12);
    const local = camera.position.clone().addScaledVector(dir, t).toArray();
    const world = local.map((v, a) => v + focus[a]);
    if (world.some((v) => v <= -0.5 || v >= 0.5)) continue;
    const cell = world.map((v) => Math.floor((v + 0.5) * 3 ** mesh.depthMax));
    if (!isSolidCell(...cell, mesh.depthMax)) continue;
    solid++;
    if (local.some((v) => Math.abs(v) > oldBox)) outsideOldBox++;
    assert.ok(leafAt(leaves, world, mesh.depthMax), `solid point in view has no cube: ${world}`);
  }
  assert.ok(solid > 200, `too few solid samples to mean anything: ${solid}`);
  assert.ok(outsideOldBox > 50, `samples never left the old box (${outsideOldBox}), so this proves nothing`);
});

test('occlusion culling drops hidden cubes but never a visible one', () => {
  const { camera, params } = makeView({ eye: [1.3, 0.97, 1.63] });
  const fixed = { maxDepth: 4, budget: Infinity, minPixels: 5, threshold: 5, keepCells: true };
  const all = buildViewMesh({ ...params, ...fixed, viewProjection: null });
  const culled = buildViewMesh({ ...params, ...fixed });
  assert.ok(culled.cubeCount < all.cubeCount * 0.8,
    `occlusion saved too little: ${culled.cubeCount} of ${all.cubeCount}`);

  const full = leafSet(all);
  const kept = leafSet(culled);
  let rays = 0;
  let agree = 0;
  let random = 777;
  const rand = () => ((random = (random * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 500; i++) {
    const ndc = new THREE.Vector3(rand() * 1.9 - 0.95, rand() * 1.9 - 0.95, 0.5).unproject(camera);
    const dir = ndc.sub(camera.position).normalize();
    // March until the first cube of the uncut build: that cube is on screen.
    let first = null;
    for (let t = 0; t < 5; t += 1 / 400) {
      const p = camera.position.clone().addScaledVector(dir, t).toArray();
      if (p.some((v) => v <= -0.5 || v >= 0.5)) continue;
      first = leafAt(full, p, 4);
      if (first) break;
    }
    if (!first) continue;
    rays++;
    if (kept.has(first)) agree++;
  }
  assert.ok(rays > 150, `too few rays hit the sponge: ${rays}`);
  // Occluders are sampled at pixel centres, so a cube seen only through a
  // sub-sample sliver may go; that must stay a rounding error.
  assert.ok(agree / rays >= 0.99, `${rays - agree} of ${rays} visible cubes were culled`);
});

test('no cracks where detail levels meet', () => {
  const { focus, eye } = dive(3);
  const { params } = makeView({ origin: focus, eye });
  const mesh = buildViewMesh({
    ...params, viewProjection: null, maxDepth: 9,
    budget: Infinity, minPixels: 10, threshold: 10, keepCells: true,
  });
  assert.ok(mesh.depthMax - mesh.depthMin >= 3, `expected mixed depths, got ${mesh.depthMin}-${mesh.depthMax}`);
  const leaves = leafSet(mesh);
  let culledShared = 0;
  let keptAtSeam = 0;
  for (let i = 0; i < mesh.cells.length / 4; i++) {
    const [d, x, y, z] = mesh.cells.slice(i * 4, i * 4 + 4);
    for (let f = 0; f < 6; f++) {
      const axis = f >> 1;
      const step = f & 1 ? -1 : 1;
      const n = [x, y, z];
      n[axis] += step;
      if (!isSolidCell(...n, d)) continue;
      const shown = (mesh.masks[i] >> f) & 1;
      const covered = coveredByLeaf(leaves, d, ...n);
      if (!shown) {
        // A face may only be hidden by a neighbour drawn as one solid block —
        // or by one outside the culling frustum, which is never built and so
        // cannot be seen through: the face turned towards it is off screen.
        assert.ok(covered || !inView(params, d, ...n),
          `face ${f} of ${d}:${x},${y},${z} hidden by a neighbour full of holes`);
        culledShared++;
      } else {
        // And a face against a solid block would z-fight: it must have been split.
        assert.ok(!covered, `face ${f} of ${d}:${x},${y},${z} kept against a solid neighbour`);
        keptAtSeam++;
      }
    }
  }
  assert.ok(culledShared > 1000, 'expected plenty of shared faces');
  assert.ok(keptAtSeam > 10, 'expected some seams between detail levels');
});

test('a deep dive shows many iterations at once, in full float32 precision', () => {
  const { focus, eye } = dive(12);
  const { params } = makeView({ origin: focus, eye });
  const mesh = buildViewMesh({ ...params, maxDepth: 17, budget: 40000, threshold: 12 });
  assert.ok(mesh.cubeCount > 1000, `too little built: ${mesh.cubeCount}`);
  assert.ok(mesh.depthMax >= 14, `detail at the focus stopped at depth ${mesh.depthMax}`);
  assert.ok(mesh.depthMax - mesh.depthMin >= 6, `only depths ${mesh.depthMin}-${mesh.depthMax} on screen`);
  // Near the origin, vertices must still sit on the finest cube grid.
  const step = 3 ** -mesh.depthMax;
  let onGrid = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    if (Math.abs(x) > step * 30) continue;
    const off = ((x + focus[0] + 0.5) / step) % 1;
    if (Math.min(off, 1 - off) < 0.02) onGrid++;
  }
  assert.ok(onGrid > 20, `vertices near the focus are off the cube grid (${onGrid})`);
});

test('the cutaway removes cubes wholly on its far side', () => {
  const { params } = makeView({ eye: [1.4, 1.05, 1.75] });
  // Keep x < 0.1: the plane n·p + c >= 0 with n = (-1, 0, 0), c = 0.1.
  const mesh = buildViewMesh({
    ...params, viewProjection: null, maxDepth: 3, budget: Infinity,
    minPixels: 1e-6, threshold: 1e-6, clip: [-1, 0, 0, 0.1], keepCells: true,
  });
  for (let i = 0; i < mesh.cells.length; i += 4) {
    const [d, x] = mesh.cells.slice(i, i + 2);
    assert.ok(x * 3 ** -d - 0.5 < 0.1, `cube at x=${x * 3 ** -d - 0.5} is entirely cut away`);
  }
  // Exactly the solid cubes whose low x edge is on the kept side survive.
  let expected = 0;
  for (let x = 0; x < 27; x++) {
    if (x / 27 - 0.5 >= 0.1) continue;
    for (let y = 0; y < 27; y++) for (let z = 0; z < 27; z++) if (isSolidCell(x, y, z, 3)) expected++;
  }
  assert.equal(mesh.cubeCount, expected);
});
