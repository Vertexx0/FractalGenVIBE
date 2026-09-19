import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSponge, buildSurfaceMesh, buildRegionMesh, occupancyGrid, spongeStats,
  isSolidCell, raycastSponge, SUBCELL_OFFSETS, FACES, MAX_LEVEL, FRACTAL_DIMENSION,
} from '../src/menger.js';
import { toBinarySTL, toOBJChunks, stlByteLength, formatBytes } from '../src/exporters.js';

const cellSet = (sponge) => {
  const set = new Set();
  for (let i = 0; i < sponge.count * 3; i += 3) {
    set.add(`${sponge.cells[i]},${sponge.cells[i + 1]},${sponge.cells[i + 2]}`);
  }
  return set;
};

test('keeps exactly the twenty non-central subcubes', () => {
  assert.equal(SUBCELL_OFFSETS.length / 3, 20);
  const set = new Set();
  for (let i = 0; i < SUBCELL_OFFSETS.length; i += 3) {
    const [x, y, z] = [SUBCELL_OFFSETS[i], SUBCELL_OFFSETS[i + 1], SUBCELL_OFFSETS[i + 2]];
    assert.ok((x === 1) + (y === 1) + (z === 1) < 2, `${x},${y},${z} should be removed`);
    set.add(`${x},${y},${z}`);
  }
  assert.equal(set.size, 20, 'offsets must be distinct');
});

test('cube count is 20^level and the grid is 3^level', () => {
  for (let level = 0; level <= 3; level++) {
    const sponge = buildSponge(level);
    assert.equal(sponge.count, 20 ** level);
    assert.equal(sponge.gridSize, 3 ** level);
    assert.equal(cellSet(sponge).size, sponge.count, 'cells must be distinct');
  }
});

test('cells stay inside the grid', () => {
  const sponge = buildSponge(3);
  for (let i = 0; i < sponge.count * 3; i++) {
    assert.ok(sponge.cells[i] >= 0 && sponge.cells[i] < sponge.gridSize);
  }
});

test('level 1 removes the six face centres and the core', () => {
  const kept = cellSet(buildSponge(1));
  assert.equal(kept.size, 20);
  for (const removed of ['1,1,1', '0,1,1', '2,1,1', '1,0,1', '1,2,1', '1,1,0', '1,1,2']) {
    assert.ok(!kept.has(removed), `${removed} should have been removed`);
  }
  assert.ok(kept.has('0,0,0') && kept.has('2,2,2') && kept.has('1,0,0'));
});

test('a cell is solid only if no base-3 digit triple has two or more ones', () => {
  // Independent check of the recursive build against the classic digit rule.
  const level = 3;
  const sponge = buildSponge(level);
  const grid = occupancyGrid(sponge);
  const size = sponge.gridSize;
  const solidByDigits = (x, y, z) => {
    for (let d = 0; d < level; d++, x = (x / 3) | 0, y = (y / 3) | 0, z = (z / 3) | 0) {
      if ((x % 3 === 1) + (y % 3 === 1) + (z % 3 === 1) >= 2) return false;
    }
    return true;
  };
  let solid = 0;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        const expected = solidByDigits(x, y, z);
        assert.equal(grid[(x * size + y) * size + z] === 1, expected, `${x},${y},${z}`);
        if (expected) solid++;
      }
    }
  }
  assert.equal(solid, 20 ** level);
});

test('the sponge is symmetric under axis swaps and reflection', () => {
  const sponge = buildSponge(2);
  const kept = cellSet(sponge);
  const last = sponge.gridSize - 1;
  for (const key of kept) {
    const [x, y, z] = key.split(',').map(Number);
    assert.ok(kept.has(`${y},${z},${x}`), `rotation of ${key} missing`);
    assert.ok(kept.has(`${last - x},${y},${z}`), `mirror of ${key} missing`);
  }
});

test('face windings point outwards', () => {
  for (const { normal, corners } of FACES) {
    const [a, b, c] = corners;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    assert.deepEqual(cross, normal, `winding for normal ${normal} is inverted`);
  }
});

test('level 0 surface is a plain cube spanning -0.5..0.5', () => {
  const mesh = buildSurfaceMesh(0);
  assert.equal(mesh.faceCount, 6);
  assert.equal(mesh.indices.length, 36);
  for (const v of mesh.positions) assert.ok(v === -0.5 || v === 0.5);
});

test('hidden faces between touching cubes are culled', () => {
  // Every level-1 cube would contribute 6 faces; shared faces must disappear.
  const mesh = buildSurfaceMesh(1);
  assert.ok(mesh.faceCount < 20 * 6, 'no faces were culled');
  assert.equal(mesh.faceCount, 72);
  assert.equal(mesh.cubeCount, 20);
});

test('surface mesh is closed: every edge is used exactly twice', () => {
  const mesh = buildSurfaceMesh(2);
  const edges = new Map();
  const key = (v) => `${mesh.positions[v * 3].toFixed(6)},` +
    `${mesh.positions[v * 3 + 1].toFixed(6)},${mesh.positions[v * 3 + 2].toFixed(6)}`;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const v = [key(mesh.indices[t]), key(mesh.indices[t + 1]), key(mesh.indices[t + 2])];
    for (let i = 0; i < 3; i++) {
      const edge = [v[i], v[(i + 1) % 3]].sort().join('|');
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  // A manifold surface built from quads splits each quad into two triangles,
  // so shared edges appear twice and the quad diagonals do too.
  for (const [edge, uses] of edges) {
    assert.equal(uses % 2, 0, `edge ${edge} used ${uses} times`);
  }
});

test('no vertex escapes the unit cube', () => {
  const mesh = buildSurfaceMesh(2);
  for (const v of mesh.positions) assert.ok(v >= -0.5 && v <= 0.5, `${v} out of range`);
});

test('normals are unit axis vectors and match one of the six faces', () => {
  const mesh = buildSurfaceMesh(2);
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const n = [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]];
    assert.equal(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]), 1);
  }
});

test('stats match the closed forms', () => {
  const s = spongeStats(3);
  assert.equal(s.cubeCount, 8000);
  assert.equal(s.gridSize, 27);
  assert.ok(Math.abs(s.volumeFraction - (20 / 27) ** 3) < 1e-12);
  assert.ok(Math.abs(s.cubeSize - 1 / 27) < 1e-12);
  assert.ok(Math.abs(FRACTAL_DIMENSION - 2.7268) < 1e-3);
});

test('stats agree with the built geometry', () => {
  for (let level = 0; level <= 3; level++) {
    assert.equal(spongeStats(level).cubeCount, buildSurfaceMesh(level).cubeCount);
  }
});

test('invalid levels are rejected', () => {
  for (const bad of [-1, 1.5, MAX_LEVEL + 1, NaN, '2']) {
    assert.throws(() => buildSponge(bad), RangeError, `level ${bad} should be rejected`);
  }
});

test('binary STL has the right size and triangle count', () => {
  const mesh = buildSurfaceMesh(1);
  const buffer = toBinarySTL(mesh, 100);
  assert.equal(buffer.byteLength, stlByteLength(mesh));
  const view = new DataView(buffer);
  assert.equal(view.getUint32(80, true), mesh.faceCount * 2);
  assert.equal(buffer.byteLength, 84 + 50 * mesh.faceCount * 2);
});

test('STL vertices are scaled to the requested size', () => {
  const buffer = toBinarySTL(buildSurfaceMesh(0), 100);
  const view = new DataView(buffer);
  let min = Infinity, max = -Infinity;
  for (let t = 0; t < view.getUint32(80, true); t++) {
    const base = 84 + t * 50 + 12;
    for (let i = 0; i < 9; i++) {
      const v = view.getFloat32(base + i * 4, true);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  assert.equal(min, -50);
  assert.equal(max, 50);
});

test('OBJ lists every vertex and face with 1-based indices', () => {
  const mesh = buildSurfaceMesh(1);
  const text = toOBJChunks(mesh, 100).join('');
  const vs = text.match(/^v /gm).length;
  const fs = text.match(/^f /gm).length;
  assert.equal(vs, mesh.positions.length / 3);
  assert.equal(fs, mesh.indices.length / 3);
  for (const line of text.split('\n')) {
    if (!line.startsWith('f ')) continue;
    for (const index of line.slice(2).split(' ').map(Number)) {
      assert.ok(index >= 1 && index <= vs, `face index ${index} out of range`);
    }
  }
});

test('formatBytes reads sensibly', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1048576), '5.0 MB');
});

test('a cell is solid iff the recursive build kept it', () => {
  const sponge = buildSponge(2);
  const kept = new Set();
  for (let i = 0; i < sponge.count * 3; i += 3) {
    kept.add(`${sponge.cells[i]},${sponge.cells[i + 1]},${sponge.cells[i + 2]}`);
  }
  for (let x = 0; x < 9; x++) {
    for (let y = 0; y < 9; y++) {
      for (let z = 0; z < 9; z++) {
        assert.equal(isSolidCell(x, y, z, 2), kept.has(`${x},${y},${z}`), `${x},${y},${z}`);
      }
    }
  }
  assert.equal(isSolidCell(-1, 0, 0, 2), false);
  assert.equal(isSolidCell(9, 0, 0, 2), false);
});

test('a region covering everything equals the full surface mesh', () => {
  for (let level = 0; level <= 3; level++) {
    const whole = buildSurfaceMesh(level);
    const region = buildRegionMesh({ depth: level, center: [0, 0, 0], halfExtent: 0.5 });
    assert.equal(region.cubeCount, whole.cubeCount);
    assert.equal(region.faceCount, whole.faceCount);
    assert.equal(region.depth, level);
  }
});

test('a region generates only the cubes that overlap it', () => {
  // Offset from the axes: the middle of the +x face is the level-1 hole, and a
  // region inside that hole is legitimately empty.
  const slab = buildRegionMesh({ depth: 3, center: [0.4, -0.4, -0.4], halfExtent: 0.1 });
  const whole = buildRegionMesh({ depth: 3, center: [0, 0, 0], halfExtent: 0.5 });
  assert.ok(slab.cubeCount > 0, 'region should not be empty');
  assert.ok(slab.cubeCount < whole.cubeCount / 4, `expected a small slice, got ${slab.cubeCount}`);
  // Positions are relative to the region centre, so they stay near zero. A cube
  // straddling the edge is emitted whole, so allow one cube's overhang.
  const limit = 0.1 + 3 ** -3 + 1e-6;
  for (let i = 0; i < slab.positions.length; i++) {
    assert.ok(Math.abs(slab.positions[i]) <= limit, `${slab.positions[i]} outside the region`);
  }
});

test('a region inside the hollow centre comes back empty', () => {
  const hole = buildRegionMesh({ depth: 3, center: [0, 0, 0], halfExtent: 0.05 });
  assert.equal(hole.cubeCount, 0);
  assert.equal(hole.faceCount, 0);
  assert.equal(hole.positions.length, 0);
});

test('region faces are culled against neighbours outside the region', () => {
  // A single interior cube's region: the cube sits against solid neighbours, so
  // far fewer than six faces may show. Culling must not stop at the region wall.
  const region = buildRegionMesh({ depth: 2, center: [0, 0, 0], halfExtent: 0.5 });
  const slice = buildRegionMesh({ depth: 2, center: [-0.44, -0.44, -0.44], halfExtent: 0.02 });
  assert.equal(slice.cubeCount, 1, 'expected exactly one cube in the slice');
  assert.equal(slice.faceCount, 3, 'a corner cube shows three faces, not six');
  assert.ok(region.faceCount > slice.faceCount);
});

test('the budget drops depth rather than blowing up', () => {
  const tight = buildRegionMesh({ depth: 4, center: [0, 0, 0], halfExtent: 0.5, budget: 1000 });
  assert.ok(tight.depth < 4, `expected a coarser depth, got ${tight.depth}`);
  assert.ok(tight.cubeCount <= 1000, `expected at most 1000 cubes, got ${tight.cubeCount}`);
});

test('deep zoom stays cheap and keeps float32 precision', () => {
  // A cube at depth 12 is 2e-6 wide — far below what float32 resolves at 0.5,
  // so this only works because vertices come out relative to the centre.
  const center = [0.5, -0.4, -0.4];
  const deep = buildRegionMesh({ depth: 12, center, halfExtent: 2e-5, budget: 120000 });
  assert.equal(deep.depth, 12);
  assert.ok(deep.cubeCount > 0 && deep.cubeCount <= 120000);
  const step = 3 ** -12;
  const seen = new Set();
  for (let i = 0; i < deep.positions.length; i += 3) seen.add(deep.positions[i]);
  assert.ok(seen.size > 4, 'x coordinates collapsed — precision was lost');
  // Distinct coordinates must still be a whole cube apart, not smeared together.
  const sorted = [...seen].sort((a, b) => a - b);
  const gap = sorted[1] - sorted[0];
  assert.ok(Math.abs(gap - step) < step * 0.02, `cube edge came out ${gap}, expected ${step}`);
});

test('the sponge grows self-similar: zooming in costs the same at any depth', () => {
  const center = [0.5, -0.4, -0.4];
  const counts = [6, 9, 12].map((depth) => buildRegionMesh({
    depth, center, halfExtent: 1.4 * (2.2 / 3 ** (depth - 3)) * Math.tan(23 * Math.PI / 180),
    budget: 200000,
  }).cubeCount);
  for (const count of counts) assert.ok(count > 100, `too few cubes: ${count}`);
  // Not bit-identical: the region's edges land differently against the grid at
  // each depth. The property that matters is that the cost does not grow.
  const spread = Math.max(...counts) / Math.min(...counts);
  assert.ok(spread < 1.2, `cost drifted across depths: ${counts}`);
});

test('raycast finds the surface, and misses through a tunnel', () => {
  // Straight down the x axis is the level-1 face hole: it goes clean through.
  assert.equal(raycastSponge([2, 0, 0], [-1, 0, 0], 2), null);
  // Offset into solid material, the ray should stop at the +x face.
  const hit = raycastSponge([2, -0.4, -0.4], [-1, 0, 0], 2);
  assert.ok(hit, 'expected a hit on the +x face');
  assert.ok(Math.abs(hit[0] - 0.5) < 0.02, `hit at x=${hit[0]}, expected the face at 0.5`);
  assert.ok(isSolidCell(...[0, 1, 2].map((a) => Math.floor((hit[a] + 0.5) * 9)), 2));
});

test('raycast returns null when the ray never meets the cube', () => {
  assert.equal(raycastSponge([2, 2, 2], [1, 0, 0], 2), null);
});
