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
 * Highest level this module will build. 20^6 cubes would need gigabytes; 5 is
 * already 3.2M cubes and is meant for offline export rather than interaction.
 */
export const MAX_LEVEL = 5;

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
 * Surface mesh of a sponge, with every face shared by two solid cubes dropped.
 *
 * Culling those hidden faces is the difference between a mesh that a phone can
 * spin and one that it cannot: at level 4 it removes roughly three quarters of
 * the triangles a naive cube-per-cell mesh would carry, and it keeps exported
 * STL files to a size a slicer will open.
 *
 * Positions are normalised so the sponge spans [-0.5, 0.5] on every axis.
 *
 * @param {number} level
 * @returns {{level: number, gridSize: number, cubeCount: number, faceCount: number,
 *            positions: Float32Array, normals: Float32Array, indices: Uint32Array}}
 */
export function buildSurfaceMesh(level) {
  const sponge = buildSponge(level);
  const { gridSize, cells, count } = sponge;
  const grid = occupancyGrid(sponge);

  // Pass one counts exposed faces so the typed arrays are allocated exactly once.
  let faceCount = 0;
  for (let i = 0; i < count * 3; i += 3) {
    const x = cells[i], y = cells[i + 1], z = cells[i + 2];
    for (let f = 0; f < 6; f++) {
      const [nx, ny, nz] = FACES[f].normal;
      const ax = x + nx, ay = y + ny, az = z + nz;
      const outside = ax < 0 || ay < 0 || az < 0 ||
        ax >= gridSize || ay >= gridSize || az >= gridSize;
      if (outside || !grid[(ax * gridSize + ay) * gridSize + az]) faceCount++;
    }
  }

  const positions = new Float32Array(faceCount * 4 * 3);
  const normals = new Float32Array(faceCount * 4 * 3);
  const indices = new Uint32Array(faceCount * 6);
  const scale = 1 / gridSize;

  let p = 0, n = 0, t = 0, vertex = 0;
  for (let i = 0; i < count * 3; i += 3) {
    const x = cells[i], y = cells[i + 1], z = cells[i + 2];
    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const [nx, ny, nz] = face.normal;
      const ax = x + nx, ay = y + ny, az = z + nz;
      const outside = ax < 0 || ay < 0 || az < 0 ||
        ax >= gridSize || ay >= gridSize || az >= gridSize;
      if (!outside && grid[(ax * gridSize + ay) * gridSize + az]) continue;

      for (let c = 0; c < 4; c++) {
        const [cx, cy, cz] = face.corners[c];
        positions[p++] = (x + cx) * scale - 0.5;
        positions[p++] = (y + cy) * scale - 0.5;
        positions[p++] = (z + cz) * scale - 0.5;
        normals[n++] = nx;
        normals[n++] = ny;
        normals[n++] = nz;
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
    level,
    gridSize,
    cubeCount: count,
    faceCount,
    positions,
    normals,
    indices,
  };
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
