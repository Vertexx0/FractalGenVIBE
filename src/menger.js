/**
 * Menger sponge geometry core.
 *
 * Pure data, no rendering dependencies: this module runs identically in a
 * browser and in Node, which is what makes it testable.
 *
 * A Menger sponge is built by splitting a cube into a 3x3x3 grid and throwing
 * away the seven subcubes that sit in the middle of a face or in the middle of
 * the cube itself. The twenty survivors are each split the same way again.
 * After `level` steps there are 20^level cubes on a 3^level grid.
 */

/** Cubes kept out of every 27 at each subdivision step. */
export const KEPT_PER_STEP = 20;

/**
 * Highest level this module will build in one piece. 20^6 cubes would need
 * gigabytes; 5 is already 3.2M cubes and is meant for offline export rather
 * than interaction.
 */
export const MAX_LEVEL = 5;

/**
 * Depth ceiling for region builds. Cell coordinates run to 3^depth and must
 * stay exact integers, so the real wall is float64's 2^53 at depth 33; 18 is
 * well inside it and already a 3^18 (387 million) cube grid.
 */
export const HARD_MAX_DEPTH = 18;

/** Hausdorff dimension of the sponge: log(20) / log(3). */
export const FRACTAL_DIMENSION = Math.log(20) / Math.log(3);

/**
 * The twenty kept offsets within a 3x3x3 block, flattened to x,y,z triples.
 * A subcube is removed when two or more of its coordinates are the centre one,
 * which drops the six face centres and the single core.
 */
export const SUBCELL_OFFSETS = (() => {
  const offsets = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 3; z++) {
        const centred = (x === 1) + (y === 1) + (z === 1);
        if (centred < 2) offsets.push(x, y, z);
      }
    }
  }
  return Int32Array.from(offsets);
})();

/**
 * The six cube faces, each as an outward normal plus its four corners wound
 * counter-clockwise when seen from outside. Consistent winding is what keeps
 * backface culling and exported STL solids correct.
 */
export const FACES = [
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { normal: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { normal: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

function assertLevel(level, max = MAX_LEVEL) {
  if (!Number.isInteger(level) || level < 0 || level > max) {
    throw new RangeError(`level must be an integer in 0..${max}, got ${level}`);
  }
}

/**
 * Build the solid cubes of a sponge at `level`.
 *
 * Cells are integer grid coordinates in [0, 3^level). Rather than testing all
 * 27^level grid positions, each step expands the survivors into their twenty
 * children, so the work is proportional to the 20^level cubes actually kept.
 *
 * @param {number} level
 * @returns {{level: number, gridSize: number, count: number, cells: Int32Array}}
 */
export function buildSponge(level) {
  assertLevel(level);
  let cells = new Int32Array(3); // level 0: one cube at the origin
  let count = 1;

  for (let step = 0; step < level; step++) {
    const next = new Int32Array(count * KEPT_PER_STEP * 3);
    let w = 0;
    for (let i = 0; i < count * 3; i += 3) {
      const bx = cells[i] * 3;
      const by = cells[i + 1] * 3;
      const bz = cells[i + 2] * 3;
      for (let o = 0; o < SUBCELL_OFFSETS.length; o += 3) {
        next[w++] = bx + SUBCELL_OFFSETS[o];
        next[w++] = by + SUBCELL_OFFSETS[o + 1];
        next[w++] = bz + SUBCELL_OFFSETS[o + 2];
      }
    }
    cells = next;
    count = w / 3;
  }

  return { level, gridSize: 3 ** level, count, cells };
}

/**
 * Flat occupancy lookup for a sponge, indexed by (x * size + y) * size + z.
 *
 * @param {{gridSize: number, count: number, cells: Int32Array}} sponge
 * @returns {Uint8Array}
 */
export function occupancyGrid(sponge) {
  const { gridSize, cells, count } = sponge;
  const grid = new Uint8Array(gridSize ** 3);
  for (let i = 0; i < count * 3; i += 3) {
    grid[(cells[i] * gridSize + cells[i + 1]) * gridSize + cells[i + 2]] = 1;
  }
  return grid;
}

/**
 * Is the cell (x, y, z) on the 3^depth grid part of the sponge?
 *
 * The recursive definition has a closed form: a cell survives exactly when no
 * base-3 digit triple of its coordinates contains two or more ones. That is an
 * O(depth) test against a sponge of any depth, which is what lets the zoomed
 * builder cull faces against neighbours it never generated — an occupancy grid
 * would need 27^depth bytes and is hopeless past level 5.
 */
export function isSolidCell(x, y, z, depth) {
  if (x < 0 || y < 0 || z < 0) return false;
  const size = 3 ** depth;
  if (x >= size || y >= size || z >= size) return false;
  for (let d = 0; d < depth; d++) {
    if ((x % 3 === 1) + (y % 3 === 1) + (z % 3 === 1) >= 2) return false;
    x = Math.floor(x / 3);
    y = Math.floor(y / 3);
    z = Math.floor(z / 3);
  }
  return true;
}

/**
 * Walk the subdivision tree, keeping only branches that overlap the region.
 *
 * Pruning at every level is what makes deep zoom affordable: the work is
 * proportional to the cells actually inside the region, not to the 20^depth
 * cells of the whole sponge. Returns false if the region holds more than `cap`
 * cells, so the caller can drop a level and try again.
 */
function descend(level, x, y, z, ctx) {
  const size = 3 ** -level;
  const lo = [x * size, y * size, z * size];
  const { min, max } = ctx.box;
  for (let a = 0; a < 3; a++) {
    if (lo[a] >= max[a] || lo[a] + size <= min[a]) return true;
  }
  if (level === ctx.depth) {
    ctx.cells.push(x, y, z);
    return ctx.cells.length <= ctx.cap * 3;
  }
  for (let o = 0; o < SUBCELL_OFFSETS.length; o += 3) {
    const ok = descend(
      level + 1,
      x * 3 + SUBCELL_OFFSETS[o],
      y * 3 + SUBCELL_OFFSETS[o + 1],
      z * 3 + SUBCELL_OFFSETS[o + 2],
      ctx,
    );
    if (!ok) return false;
  }
  return true;
}

/**
 * Surface mesh for the part of the sponge inside an axis-aligned region, at
 * whatever depth fits the budget.
 *
 * Faces shared by two solid cubes are dropped, which at level 4 is 673k
 * triangles instead of 1.92M. Neighbours outside the region still count as
 * solid, so the region's own walls are not mistaken for surface.
 *
 * Vertices come out **relative to `center`**. That is not a convenience: at
 * depth 12 a cube is 2e-6 wide, and absolute float32 coordinates would quantise
 * the whole thing to nothing. Keeping the origin at the region's centre leaves
 * the full float32 mantissa for detail, at any zoom.
 *
 * @param {object} options
 * @param {number} options.depth     Requested depth; lowered until it fits.
 * @param {number[]} [options.center]     Region centre in world space, [-0.5, 0.5].
 * @param {number} [options.halfExtent]   Half the region's edge, world units.
 * @param {number} [options.budget]       Maximum cubes to generate.
 */
export function buildRegionMesh({
  depth,
  center = [0, 0, 0],
  halfExtent = 0.5,
  budget = 260000,
} = {}) {
  assertLevel(depth, HARD_MAX_DEPTH);

  // World [-0.5, 0.5] maps to the unit cube the descent works in.
  const box = {
    min: center.map((c) => c - halfExtent + 0.5),
    max: center.map((c) => c + halfExtent + 0.5),
  };

  let cells = null;
  while (depth >= 0) {
    const ctx = { depth, box, cells: [], cap: budget };
    if (descend(0, 0, 0, 0, ctx)) {
      cells = ctx.cells;
      break;
    }
    depth--;   // too dense for the budget: one level coarser
  }

  const count = cells.length / 3;
  const gridSize = 3 ** depth;

  // Mark exposed faces once, so the fill pass does not redo the digit tests.
  const masks = new Uint8Array(count);
  let faceCount = 0;
  for (let i = 0; i < count; i++) {
    const x = cells[i * 3], y = cells[i * 3 + 1], z = cells[i * 3 + 2];
    let mask = 0;
    for (let f = 0; f < 6; f++) {
      const n = FACES[f].normal;
      if (!isSolidCell(x + n[0], y + n[1], z + n[2], depth)) {
        mask |= 1 << f;
        faceCount++;
      }
    }
    masks[i] = mask;
  }

  const positions = new Float32Array(faceCount * 12);
  const normals = new Float32Array(faceCount * 12);
  const indices = new Uint32Array(faceCount * 6);
  const scale = 1 / gridSize;
  // Folded into the per-vertex sum so the shift to local space happens in
  // double precision, before anything is narrowed to float32.
  const shift = [-0.5 - center[0], -0.5 - center[1], -0.5 - center[2]];

  let p = 0, nOff = 0, t = 0, vertex = 0;
  for (let i = 0; i < count; i++) {
    const mask = masks[i];
    if (mask === 0) continue;
    const x = cells[i * 3], y = cells[i * 3 + 1], z = cells[i * 3 + 2];
    for (let f = 0; f < 6; f++) {
      if ((mask & (1 << f)) === 0) continue;
      const face = FACES[f];
      const n = face.normal;
      for (let c = 0; c < 4; c++) {
        const corner = face.corners[c];
        positions[p++] = (x + corner[0]) * scale + shift[0];
        positions[p++] = (y + corner[1]) * scale + shift[1];
        positions[p++] = (z + corner[2]) * scale + shift[2];
        normals[nOff++] = n[0];
        normals[nOff++] = n[1];
        normals[nOff++] = n[2];
      }
      indices[t++] = vertex;
      indices[t++] = vertex + 1;
      indices[t++] = vertex + 2;
      indices[t++] = vertex;
      indices[t++] = vertex + 2;
      indices[t++] = vertex + 3;
      vertex += 4;
    }
  }

  return {
    level: depth,
    depth,
    gridSize,
    cubeCount: count,
    faceCount,
    center,
    halfExtent,
    cubeSize: scale,
    positions,
    normals,
    indices,
  };
}

/**
 * Surface mesh of the whole sponge at `level` — the region builder over the
 * entire cube.
 *
 * @param {number} level
 */
export function buildSurfaceMesh(level) {
  assertLevel(level);
  return buildRegionMesh({
    depth: level,
    center: [0, 0, 0],
    halfExtent: 0.5,
    budget: Infinity,
  });
}

/**
 * First point where a ray enters solid sponge, or null if it passes through.
 *
 * Used to aim the zoom: the region to generate is centred on whatever surface
 * you are pointing at, because zooming at the sponge's own centre would only
 * dive into the hole that was carved out first.
 *
 * Marched at half a cell per step rather than traced exactly — this picks a
 * point to look at, and being half a cube out is invisible.
 *
 * @param {number[]} origin     Ray start in world space, the cube spanning [-0.5, 0.5].
 * @param {number[]} direction  Unit direction.
 * @param {number} depth        Depth whose cells count as solid.
 * @param {number} maxDistance  How far along the ray to look.
 * @returns {number[]|null}
 */
export function raycastSponge(origin, direction, depth, maxDistance = 6) {
  const size = 3 ** depth;
  // Never fewer steps than a cell is wide, and never more than we can afford.
  const step = Math.max(0.5 / size, maxDistance / 4000);
  let entered = false;
  for (let t = 0; t <= maxDistance; t += step) {
    const x = origin[0] + direction[0] * t;
    const y = origin[1] + direction[1] * t;
    const z = origin[2] + direction[2] * t;
    const inside = x >= -0.5 && x <= 0.5 && y >= -0.5 && y <= 0.5 && z >= -0.5 && z <= 0.5;
    if (!inside) {
      if (entered) break;   // came out the far side without hitting anything
      continue;
    }
    entered = true;
    const gx = Math.floor((x + 0.5) * size);
    const gy = Math.floor((y + 0.5) * size);
    const gz = Math.floor((z + 0.5) * size);
    if (isSolidCell(gx, gy, gz, depth)) return [x, y, z];
  }
  return null;
}

/**
 * Closed-form figures for a level, cheap enough to show while a slider moves.
 *
 * @param {number} level
 */
export function spongeStats(level) {
  assertLevel(level);
  const gridSize = 3 ** level;
  const cubeCount = KEPT_PER_STEP ** level;
  return {
    level,
    gridSize,
    cubeCount,
    /** Fraction of the original cube still solid: (20/27)^level. */
    volumeFraction: (KEPT_PER_STEP / 27) ** level,
    /** Edge length of one cube, as a fraction of the whole. */
    cubeSize: 1 / gridSize,
    dimension: FRACTAL_DIMENSION,
  };
}
