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

/** 3^d and 3^-d for every depth the builders use, off the hot path. */
const POWERS = Float64Array.from({ length: HARD_MAX_DEPTH + 2 }, (_, d) => 3 ** d);
const INVERSE_POWERS = Float64Array.from({ length: HARD_MAX_DEPTH + 2 }, (_, d) => 3 ** -d);

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
 * isSolidCell for the neighbour one step along `axis` of a cell already known
 * to be solid.
 *
 * Stepping by one changes only the lowest digits of that coordinate — as far as
 * the carry reaches, usually a digit or two. Above that every digit triple is
 * the known-solid cell's own, so the test can stop there instead of running all
 * the way to the root. At depth 17 that is the difference between 17 checks
 * and about 1.5.
 */
export function neighbourSolid(x, y, z, axis, step, depth) {
  const size = POWERS[depth];
  let n = (axis === 0 ? x : axis === 1 ? y : z) + step;
  if (n < 0 || n >= size) return false;
  let o = axis === 0 ? x : axis === 1 ? y : z;
  let a = axis === 0 ? y : x;
  let b = axis === 2 ? y : z;
  for (let d = 0; d < depth; d++) {
    if ((n % 3 === 1) + (a % 3 === 1) + (b % 3 === 1) >= 2) return false;
    n = Math.floor(n / 3);
    o = Math.floor(o / 3);
    if (n === o) return true;        // the carry stopped: the rest is the cell's own
    a = Math.floor(a / 3);
    b = Math.floor(b / 3);
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
 * How far into the sponge's nested structure a vertex sits, in [0, 1].
 *
 * Distance from the centre of the whole sponge only means something at 1x: a
 * slice at 500,000x sits entirely at one distance from it and would shade flat.
 * So the same measure is also taken against the vertex's ancestors one, two and
 * three levels up, and blended in. Faces on the rim of a block come out bright
 * and tunnel walls deep inside it come out dark at every scale at once, which
 * is what lets several iterations read on screen together.
 */
function shadeVertex(gx, gy, gz, depth, wx, wy, wz) {
  const ax = wx < 0 ? -wx : wx;
  const ay = wy < 0 ? -wy : wy;
  const az = wz < 0 ? -wz : wz;
  const global = (ax > ay ? (ax > az ? ax : az) : (ay > az ? ay : az)) * 2;

  let local = 0;
  let weight = 0;
  for (let k = 1; k <= 3 && k <= depth; k++) {
    const span = POWERS[k];
    const ux = Math.abs((gx % span) / span - 0.5);
    const uy = Math.abs((gy % span) / span - 0.5);
    const uz = Math.abs((gz % span) / span - 0.5);
    // A coordinate on the ancestor's wall wraps to 0, the same edge as 1.
    const edge = (ux > uy ? (ux > uz ? ux : uz) : (uy > uz ? uy : uz)) * 2;
    const w = LOCAL_SHADE_WEIGHTS[k - 1];
    local += edge * w;
    weight += w;
  }
  if (weight === 0) return global;
  return 0.4 * global + 0.6 * (local / weight);
}

const LOCAL_SHADE_WEIGHTS = [0.2, 0.35, 0.45];

/**
 * Build the part of the sponge a camera can actually see, refined where it is
 * large on screen and left coarse where it is small.
 *
 * Three things a box at one depth gets wrong, each fixed here:
 *
 * - **Edges.** A box around the focus is not what the camera sees. The view is
 *   a frustum that widens with distance, so an oblique surface runs out of the
 *   box and stops in a hard edge inside the picture. Culling against the
 *   frustum covers exactly what is visible.
 * - **Uniform depth.** One depth everywhere spends as much on the far side of
 *   the sponge as on the wall in front of you. Refining by projected size puts
 *   cubes where the pixels are, so near structure runs many levels deeper than
 *   far structure and several iterations show at once.
 * - **Hidden work.** Measured on real views, 92% of a naive build is behind the
 *   front surface. So the tree is walked front to back while a coarse software
 *   depth buffer records what every finished cube covers; anything entirely
 *   behind that is never refined, never counted and never meshed.
 *
 * The occlusion buffer is sampled at pixel centres, as a GPU rasterises, so
 * adjacent cubes tile it without seams. The price is that a cube visible only
 * through a sliver narrower than half a buffer pixel can be dropped; tests are
 * dilated by a few pixels, which absorbs that and also the parallax of a small
 * orbit before the next rebuild lands.
 *
 * Faces between a leaf and a solid neighbour are dropped only when that
 * neighbour was not split further — if it was, its surface is full of holes
 * where the leaf's face would show. Refinement is recorded as it happens, so
 * the question has an exact answer.
 *
 * The pixel threshold that meets the budget is not known in advance. The caller
 * passes the last build's threshold as a hint; an attempt that overruns is
 * abandoned and retried coarser, and one that lands far under budget is retried
 * finer, a bounded number of times.
 *
 * All geometry is relative to `origin`, for the float32 reason in
 * buildRegionMesh.
 *
 * @param {object} view
 * @param {number[]} view.origin          World point vertices are measured from.
 * @param {number[]} view.eye             Camera position, relative to origin.
 * @param {number[][]} view.planes        Culling frustum planes [nx, ny, nz, c],
 *                                        relative to origin; inside where n·p + c >= 0.
 * @param {number[]} [view.viewProjection] Camera matrix (column-major, relative to
 *                                        origin). Omit to switch occlusion off.
 * @param {number[]} [view.viewport]      [width, height] in CSS pixels.
 * @param {number} view.pixelsPerUnit     Focal length in CSS pixels.
 * @param {number} view.maxDepth          Deepest level allowed anywhere.
 * @param {number} [view.budget]          Most visible cubes to generate.
 * @param {number} [view.minPixels]       Never split a cube smaller than this.
 * @param {number} [view.threshold]       Starting pixel threshold (last build's).
 * @param {number} [view.farDistance]     Ignore anything further than this.
 * @param {number} [view.focusDistance]   Beyond this, detail is worth less...
 * @param {number} [view.falloff]         ...by (focus/distance)^falloff.
 * @param {number[]} [view.clip]          Cutaway plane [nx, ny, nz, c]; the side
 *                                        where n·p + c < 0 is removed.
 * @param {boolean} [view.keepCells]      Also return the leaves and face masks.
 */
export function buildViewMesh({
  origin,
  eye,
  planes,
  viewProjection = null,
  viewport = [1, 1],
  pixelsPerUnit,
  maxDepth,
  budget = 200000,
  minPixels = 2.5,
  threshold = 6,
  farDistance = Infinity,
  focusDistance = Infinity,
  falloff = 0,
  clip = null,
  keepCells = false,
}) {
  maxDepth = Math.min(maxDepth, HARD_MAX_DEPTH);
  const [ox, oy, oz] = origin;
  const [ex, ey, ez] = eye;
  const plane = Float64Array.from(planes.flat());
  const planeCount = planes.length;
  const occluder = viewProjection ? new OcclusionBuffer(viewProjection, viewport, eye) : null;

  // Box of a cell, relative to origin, formed in double precision.
  const box = new Float64Array(6);
  const setBox = (depth, x, y, z) => {
    const size = INVERSE_POWERS[depth];
    box[0] = x * size - 0.5 - ox;
    box[1] = y * size - 0.5 - oy;
    box[2] = z * size - 0.5 - oz;
    box[3] = box[0] + size;
    box[4] = box[1] + size;
    box[5] = box[2] + size;
    return size;
  };

  // Nearest distance from the eye to the current box, or -1 if it is culled.
  const nearOf = () => {
    for (let i = 0; i < planeCount * 4; i += 4) {
      const nx = plane[i], ny = plane[i + 1], nz = plane[i + 2], c = plane[i + 3];
      const px = nx >= 0 ? box[3] : box[0];
      const py = ny >= 0 ? box[4] : box[1];
      const pz = nz >= 0 ? box[5] : box[2];
      if (nx * px + ny * py + nz * pz + c < 0) return -1;
    }
    if (clip) {
      const [nx, ny, nz, c] = clip;
      const px = nx >= 0 ? box[3] : box[0];
      const py = ny >= 0 ? box[4] : box[1];
      const pz = nz >= 0 ? box[5] : box[2];
      if (nx * px + ny * py + nz * pz + c < 0) return -1;   // wholly cut away
    }
    const dx = ex < box[0] ? box[0] - ex : ex > box[3] ? ex - box[3] : 0;
    const dy = ey < box[1] ? box[1] - ey : ey > box[4] ? ey - box[4] : 0;
    const dz = ez < box[2] ? box[2] - ez : ez > box[5] ? ez - box[5] : 0;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return distance > farDistance ? -1 : distance;
  };

  const pixelsOf = (size, near) => {
    if (near === 0) return Infinity;
    const pixels = (size * pixelsPerUnit) / near;
    // Beyond the focus, detail is worth progressively less than its pixels.
    return near > focusDistance ? pixels * (focusDistance / near) ** falloff : pixels;
  };

  const farOf = () => {
    const dx = Math.max(Math.abs(box[0] - ex), Math.abs(box[3] - ex));
    const dy = Math.max(Math.abs(box[1] - ey), Math.abs(box[4] - ey));
    const dz = Math.max(Math.abs(box[2] - ez), Math.abs(box[5] - ez));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  // A leaf that the cutaway slices through is drawn only in part, so it must
  // not hide what lies behind its missing half.
  const straddlesClip = () => {
    if (!clip) return false;
    const [nx, ny, nz, c] = clip;
    const qx = nx >= 0 ? box[0] : box[3];
    const qy = ny >= 0 ? box[1] : box[4];
    const qz = nz >= 0 ? box[2] : box[5];
    return nx * qx + ny * qy + nz * qz + c < 0;
  };

  // Offsets from the eye's own cell stay small: a split cell is at least a few
  // pixels wide, so it lies within ~f / minPixels cells of the camera. That
  // keeps refinement keys exact in 51 bits at any depth.
  const eyeCell = [];
  for (let d = 0; d <= maxDepth; d++) {
    eyeCell.push(
      Math.floor((ex + ox + 0.5) * POWERS[d]) - 65536,
      Math.floor((ey + oy + 0.5) * POWERS[d]) - 65536,
      Math.floor((ez + oz + 0.5) * POWERS[d]) - 65536,
    );
  }
  let refined = null;
  const refinedKey = (depth, x, y, z) => {
    const dx = x - eyeCell[depth * 3];
    const dy = y - eyeCell[depth * 3 + 1];
    const dz = z - eyeCell[depth * 3 + 2];
    if (dx < 0 || dy < 0 || dz < 0 || dx >= 131072 || dy >= 131072 || dz >= 131072) return -1;
    return (dx * 131072 + dy) * 131072 + dz;
  };

  let visited = 0;
  let occluded = 0;

  /** One front-to-back walk at a fixed threshold; null if it overruns. */
  const attempt = (limit) => {
    refined = [];
    visited = 0;
    occluded = 0;
    occluder?.clear();
    const cells = [];
    const queue = new DistanceQueue(focusDistance === Infinity ? 1 : focusDistance);
    setBox(0, 0, 0, 0);
    const rootNear = nearOf();
    if (rootNear >= 0) queue.push(rootNear, 0, 0, 0, 0);

    while (queue.pop()) {
      const { near, depth, x, y, z } = queue;
      const size = setBox(depth, x, y, z);
      visited++;
      if (occluder && near > 0 && occluder.hides(box, near)) {
        occluded++;
        continue;
      }
      if (depth < maxDepth && pixelsOf(size, near) > limit) {
        const key = refinedKey(depth, x, y, z);
        if (key >= 0) (refined[depth] ??= new Set()).add(key);
        for (let o = 0; o < SUBCELL_OFFSETS.length; o += 3) {
          const cx = x * 3 + SUBCELL_OFFSETS[o];
          const cy = y * 3 + SUBCELL_OFFSETS[o + 1];
          const cz = z * 3 + SUBCELL_OFFSETS[o + 2];
          setBox(depth + 1, cx, cy, cz);
          const childNear = nearOf();
          if (childNear >= 0) queue.push(childNear, depth + 1, cx, cy, cz);
        }
        continue;
      }
      cells.push(depth, x, y, z);
      if (cells.length > budget * 4) return null;
      if (occluder && !straddlesClip()) occluder.draw(box, farOf());
    }
    return cells;
  };

  // Find a threshold that fits. Cube count scales roughly as threshold^-2.2
  // (the sponge's surface is a little over two-dimensional), so a walk that
  // lands under budget predicts the threshold that would fill ~85% of it. An
  // overrun is abandoned at the budget, so it only says "coarser". The caller's
  // hint from the last build usually makes this a single walk.
  let limit = Math.max(minPixels, threshold);
  let cells = null;
  let accepted = limit;
  let lastRun = limit;
  let tooFine = 0;           // finest threshold known to overrun
  let attempts = 0;
  // Until something fits, keep backing off: this always terminates, because at
  // a threshold wider than the screen the root cube is the only leaf. Once
  // something fits, tightening is capped so a build stays a few walks at most.
  let tightenings = 0;
  for (;;) {
    attempts++;
    lastRun = limit;
    const result = attempt(limit);
    if (!result) {
      tooFine = Math.max(tooFine, limit);
      if (!cells) {
        limit *= 2;
        continue;
      }
      // Split the difference between the overrun and the last good walk.
      const next = Math.sqrt(tooFine * accepted);
      if (next / tooFine < 1.04 || ++tightenings > 3) break;
      limit = next;
      continue;
    }
    cells = result;
    accepted = limit;
    const fill = result.length / 4 / budget;
    if (fill >= 0.6 || limit <= minPixels || ++tightenings > 3) break;
    let next = Math.max(minPixels, limit * (fill / 0.85) ** (1 / 2.2));
    if (tooFine) next = Math.max(next, Math.sqrt(tooFine * limit));
    if (limit / next < 1.04) break;
    limit = next;
  }
  // `refined` belongs to the last walk; redo the accepted one if that differs.
  if (lastRun !== accepted) { attempt(accepted); attempts++; }
  limit = accepted;

  const wasRefined = (depth, x, y, z) => {
    const set = refined[depth];
    if (!set) return false;
    const key = refinedKey(depth, x, y, z);
    return key >= 0 && set.has(key);
  };

  // ---- faces
  const count = cells.length / 4;
  const masks = new Uint8Array(count);
  let faceCount = 0;
  let depthMin = Infinity;
  let depthMax = 0;
  for (let i = 0; i < count; i++) {
    const depth = cells[i * 4];
    const x = cells[i * 4 + 1], y = cells[i * 4 + 2], z = cells[i * 4 + 3];
    if (depth < depthMin) depthMin = depth;
    if (depth > depthMax) depthMax = depth;
    let mask = 0;
    for (let f = 0; f < 6; f++) {
      const axis = f >> 1;
      const step = f & 1 ? -1 : 1;     // FACES alternates +axis, -axis
      if (!neighbourSolid(x, y, z, axis, step, depth)
        || wasRefined(depth, x + (axis === 0 ? step : 0), y + (axis === 1 ? step : 0),
          z + (axis === 2 ? step : 0))) {
        mask |= 1 << f;
        faceCount++;
      }
    }
    masks[i] = mask;
  }

  const positions = new Float32Array(faceCount * 12);
  const normals = new Int8Array(faceCount * 12);
  const shade = new Float32Array(faceCount * 4);
  const indices = new Uint32Array(faceCount * 6);

  const cornerShade = new Float64Array(8);
  let p = 0, nOff = 0, s = 0, t = 0, vertex = 0;
  for (let i = 0; i < count; i++) {
    const mask = masks[i];
    if (mask === 0) continue;
    const depth = cells[i * 4];
    const x = cells[i * 4 + 1], y = cells[i * 4 + 2], z = cells[i * 4 + 3];
    const scale = INVERSE_POWERS[depth];
    for (let c = 0; c < 8; c++) {
      const gx = x + (c & 1), gy = y + ((c >> 1) & 1), gz = z + (c >> 2);
      cornerShade[c] = shadeVertex(gx, gy, gz, depth,
        gx * scale - 0.5, gy * scale - 0.5, gz * scale - 0.5);
    }
    for (let f = 0; f < 6; f++) {
      if ((mask & (1 << f)) === 0) continue;
      const face = FACES[f];
      const n = face.normal;
      for (let c = 0; c < 4; c++) {
        const corner = face.corners[c];
        positions[p++] = (x + corner[0]) * scale - 0.5 - ox;
        positions[p++] = (y + corner[1]) * scale - 0.5 - oy;
        positions[p++] = (z + corner[2]) * scale - 0.5 - oz;
        normals[nOff++] = n[0] * 127;
        normals[nOff++] = n[1] * 127;
        normals[nOff++] = n[2] * 127;
        shade[s++] = cornerShade[corner[0] | (corner[1] << 1) | (corner[2] << 2)];
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
    center: origin,
    cubeCount: count,
    faceCount,
    depth: count ? depthMax : 0,
    depthMin: count ? depthMin : 0,
    depthMax: count ? depthMax : 0,
    threshold: limit,
    visited,
    occluded,
    attempts,
    ...(keepCells ? { cells, masks } : {}),
    positions,
    normals,
    shade,
    indices,
  };
}

/**
 * A coarse depth buffer, one sample per two CSS pixels, over a little more than
 * the screen so the culling margin gets occluded too.
 *
 * Each finished cube writes its farthest distance into every sample its outline
 * covers; a candidate is hidden when every sample over its outline (dilated) is
 * already nearer than its own nearest point. Distances are Euclidean from the
 * eye, which makes that comparison exact along every sample's ray.
 */
class OcclusionBuffer {
  constructor(matrix, [width, height], eye) {
    this.m = matrix;
    this.eye = eye;
    this.reach = 1.4;                     // NDC half-extent covered
    this.w = Math.max(8, Math.ceil((width * this.reach) / 2));
    this.h = Math.max(8, Math.ceil((height * this.reach) / 2));
    this.depth = new Float32Array(this.w * this.h);
    this.dilate = 3;
    this.sx = new Float64Array(8);
    this.sy = new Float64Array(8);
    this.qx = new Float64Array(4);
    this.qy = new Float64Array(4);
    this.edge = new Float64Array(12);
  }

  clear() {
    this.depth.fill(Infinity);
  }

  /** Project the 8 corners into buffer space. False if any is behind the eye. */
  project(b) {
    const m = this.m;
    const kx = this.w / (2 * this.reach);
    const ky = this.h / (2 * this.reach);
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? b[3] : b[0];
      const y = i & 2 ? b[4] : b[1];
      const z = i & 4 ? b[5] : b[2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 1e-12) return false;
      const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      this.sx[i] = (cx + this.reach) * kx;
      this.sy[i] = (this.reach - cy) * ky;
    }
    return true;
  }

  hides(b, near) {
    if (!this.project(b)) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      if (this.sx[i] < x0) x0 = this.sx[i];
      if (this.sx[i] > x1) x1 = this.sx[i];
      if (this.sy[i] < y0) y0 = this.sy[i];
      if (this.sy[i] > y1) y1 = this.sy[i];
    }
    const d = this.dilate;
    const ax = Math.floor(x0) - d, bx = Math.ceil(x1) + d;
    const ay = Math.floor(y0) - d, by = Math.ceil(y1) + d;
    // Anything reaching past the buffer is only partly accounted for: keep it.
    if (ax < 0 || ay < 0 || bx >= this.w || by >= this.h) return false;
    const { depth, w } = this;
    for (let y = ay; y <= by; y++) {
      const row = y * w;
      for (let x = ax; x <= bx; x++) {
        if (depth[row + x] >= near) return false;
      }
    }
    return true;
  }

  /**
   * Stamp a finished cube's outline. The outline is the union of its faces
   * that point at the eye — at most three convex quads with known corners —
   * so no hull has to be built.
   */
  draw(b, far) {
    if (!this.project(b)) return;
    const [ex, ey, ez] = this.eye;
    if (ex > b[3]) this.fill(1, 3, 7, 5, far);
    else if (ex < b[0]) this.fill(0, 4, 6, 2, far);
    if (ey > b[4]) this.fill(2, 6, 7, 3, far);
    else if (ey < b[1]) this.fill(0, 1, 5, 4, far);
    if (ez > b[5]) this.fill(4, 5, 7, 6, far);
    else if (ez < b[2]) this.fill(0, 2, 3, 1, far);
  }

  /**
   * Fill the samples whose centres fall inside one projected quad, stepping the
   * four edge functions incrementally across each row as a rasteriser does.
   */
  fill(a, b, c, d, far) {
    const { sx, sy, depth, w, qx, qy, edge } = this;
    qx[0] = sx[a]; qx[1] = sx[b]; qx[2] = sx[c]; qx[3] = sx[d];
    qy[0] = sy[a]; qy[1] = sy[b]; qy[2] = sy[c]; qy[3] = sy[d];
    // Winding depends on which side the face is seen from; fold it into a sign.
    const area = (qx[1] - qx[0]) * (qy[2] - qy[0]) - (qy[1] - qy[0]) * (qx[2] - qx[0]);
    if (Math.abs(area) < 0.25) return;           // smaller than a sample: nothing to fill
    const sign = area < 0 ? -1 : 1;
    const x0 = Math.max(0, Math.floor(Math.min(qx[0], qx[1], qx[2], qx[3])));
    const x1 = Math.min(this.w - 1, Math.ceil(Math.max(qx[0], qx[1], qx[2], qx[3])));
    const y0 = Math.max(0, Math.floor(Math.min(qy[0], qy[1], qy[2], qy[3])));
    const y1 = Math.min(this.h - 1, Math.ceil(Math.max(qy[0], qy[1], qy[2], qy[3])));
    if (x0 > x1 || y0 > y1) return;
    // Edge i: E(px, py) = A*px + B*py + C, >= 0 inside.
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      const A = -sign * (qy[j] - qy[i]);
      const B = sign * (qx[j] - qx[i]);
      edge[i * 3] = A;
      edge[i * 3 + 1] = B;
      edge[i * 3 + 2] = -(A * qx[i] + B * qy[i]);
    }
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      const px0 = x0 + 0.5;
      let e0 = edge[0] * px0 + edge[1] * py + edge[2];
      let e1 = edge[3] * px0 + edge[4] * py + edge[5];
      let e2 = edge[6] * px0 + edge[7] * py + edge[8];
      let e3 = edge[9] * px0 + edge[10] * py + edge[11];
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        if (e0 >= 0 && e1 >= 0 && e2 >= 0 && e3 >= 0 && far < depth[row + x]) depth[row + x] = far;
        e0 += edge[0];
        e1 += edge[3];
        e2 += edge[6];
        e3 += edge[9];
      }
    }
  }
}

/**
 * Front-to-back queue, bucketed on log distance: 32 buckets per doubling.
 *
 * Exact ordering buys nothing here. A sample only ever hides what lies wholly
 * behind the cube that wrote it, so walking slightly out of order can only
 * make culling a little less effective, never wrong. A child is never nearer
 * than its parent, so the cursor only moves forward.
 */
class DistanceQueue {
  constructor(scale) {
    this.base = Math.log2(scale) - 12;   // 4096x closer than the focus is bucket 0
    this.buckets = [];
    this.cursor = 0;
    this.near = 0;
    this.depth = 0;
    this.x = 0;
    this.y = 0;
    this.z = 0;
  }

  push(near, depth, x, y, z) {
    const slot = near <= 0 ? 0 : Math.max(0, Math.floor((Math.log2(near) - this.base) * 32));
    const bucket = (this.buckets[slot] ??= []);
    bucket.push(near, depth, x, y, z);
    if (slot < this.cursor) this.cursor = slot;
  }

  /** Load the nearest entry into near/depth/x/y/z; false when empty. */
  pop() {
    const { buckets } = this;
    while (this.cursor < buckets.length) {
      const bucket = buckets[this.cursor];
      if (bucket && bucket.length) {
        this.z = bucket.pop();
        this.y = bucket.pop();
        this.x = bucket.pop();
        this.depth = bucket.pop();
        this.near = bucket.pop();
        return true;
      }
      this.cursor++;
    }
    return false;
  }
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
