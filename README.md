# FractalGenVIBE — Menger sponge generator

A Menger sponge you can build, spin, slice open and export, in the browser.
Designed for a phone first: one-thumb controls, geometry built off the main
thread, and a render loop that goes to sleep when nothing is moving.

No build step and no bundler — it is plain ES modules and one CDN import.

```bash
npm run dev        # http://localhost:8080
```

It has to be served over `http://` rather than opened as a `file://` path,
because ES modules and module workers are blocked on `file://`.

## What it does

- **Iterations 0–4** at rest, with the cube count and warning shown as you go.
- **Zoom to 531,441×**, generating new iterations as you dive — see below.
- **Four palettes.** `Depth` and `Ember` shade by distance from the centre, so
  the outer shell and the tunnel walls read as different surfaces; `Axis` maps
  x/y/z straight to red/green/blue; `Bone` is near-white.
- **Cutaway** along any axis, with the interior shaded separately so a slice
  looks hollow instead of solid.
- **Auto-spin** and orbit/pinch controls.
- **Export** to PNG, binary STL or OBJ. Meshes are consistently wound and
  100 mm across, so they drop straight into a slicer.
- **The URL carries the state**, so a view you like is a link you can send.

## The sponge

Split a cube into a 3×3×3 grid and remove the seven subcubes that sit in the
middle of a face or in the middle of the cube itself. Subdivide the twenty
survivors the same way. After *n* steps there are 20ⁿ cubes on a 3ⁿ grid, the
solid fraction is (20/27)ⁿ, and the volume tends to zero while the surface area
grows without bound. Its Hausdorff dimension is log 20 / log 3 ≈ 2.727 — more
than a surface, less than a solid.

| Level | Cubes | Triangles | Solid | STL |
|-------|-------|-----------|-------|-----|
| 0 | 1 | 12 | 100.0% | 684 B |
| 1 | 20 | 144 | 74.1% | 7 KB |
| 2 | 400 | 2,112 | 54.9% | 103 KB |
| 3 | 8,000 | 36,096 | 40.6% | 1.7 MB |
| 4 | 160,000 | 672,768 | 30.1% | 32.1 MB |

Level 4 is the ceiling for building the sponge *whole*. The geometry core will
build level 5 (3.2 million cubes) for offline use, but no phone should be asked
to orbit it. Zoom goes far deeper by never building the whole thing.

## Zooming forever

The zoom slider adds **one iteration per 3× of magnification**, which is the
natural rate: each iteration cuts a cube into thirds, so cubes hold a steady
size on screen however far you dive. At the end of the slider you are at
531,441× and depth 15 — a sponge of 3.3 × 10¹⁹ cubes, if anyone could build one.

Nobody builds one. Three things make the dive affordable:

- **Only the region in front of the camera is generated.** The subdivision tree
  is pruned at every level against a box a little wider than the view, so the
  work tracks what you can see rather than 20ⁿ. Because the region shrinks at
  the same rate the depth grows, a view costs the same at 1× as at 500,000× —
  measurably so: past 81× the builder settles at a near-constant cube count.
- **Faces are culled against cubes that were never generated.** A neighbour's
  solidity comes from the closed form — a cell survives exactly when no base-3
  digit triple of its coordinates holds two or more ones — so the region's own
  walls are not mistaken for surface. An occupancy grid would need 27ⁿ bytes.
- **The origin travels with the view.** At depth 15 a cube is 7 × 10⁻⁸ of the
  sponge wide, far below what float32 resolves near a coordinate of 0.5.
  Vertices come out relative to the region's centre, so the mantissa is spent on
  detail instead of on position. The near and far planes are rescaled each frame
  for the same reason: fixed ones span eight orders of magnitude at full zoom
  and the depth buffer resolves none of it.

**Tap the sponge to aim.** Zoom dives toward the point you last aimed at, and
the first dive aims down the middle of the screen for you. The app also re-aims
on its own each time the depth increases, and it has to: the sponge has zero
volume, so a point that is solid at depth 5 has almost certainly been carved
away by depth 15. Without that, a deep dive lands in a hole and builds nothing.

A budget (120k cubes on touch devices, 220k otherwise) is the backstop. If a
region turns out denser than that, the builder drops a level on its own rather
than handing the GPU something it cannot hold.

## Why it stays fast on a phone

- **Hidden faces never reach the GPU.** Every face shared by two solid cubes is
  dropped at build time. At level 4 that is 673k triangles instead of the 1.92M
  a cube-per-cell mesh would carry, and it is the difference between a slicer
  opening the STL and choking on it.
- **Builds run in a worker**, so the spinner keeps turning and touch keeps
  responding while 160k cubes are generated.
- **Dragging the slider coalesces.** Sweeping 0→4 builds the level your finger
  stopped on, not all five.
- **The render loop sleeps** when the camera is still; battery is only spent on
  frames that differ.
- **Pixel ratio drops to 1.5** once a mesh passes 200k faces — fill rate is the
  wall on mobile, not triangle count.
- **The camera frames itself** against whatever canvas the sheet is not
  covering, so the model is never hidden behind the controls.
- **Palettes rescale to the region.** Shading by distance from the sponge's
  centre collapses to one flat tone once a slice sits entirely at one distance
  from it, so the ramp is stretched over the range actually present.

## Layout

```
index.html           page shell, import map, boot-failure notice
src/menger.js        geometry core — no dependencies, runs in Node
src/exporters.js     binary STL and OBJ writers
src/worker.js        builds meshes off the main thread
src/app.js           scene, camera framing, controls, UI
src/style.css        mobile-first styles; desktop is the media query
tests/               unit tests for the core and the exporters
scripts/dev-server.mjs   static server, no dependencies
scripts/smoke.mjs        Playwright run at phone and desktop sizes
```

`src/menger.js` deliberately knows nothing about three.js: that is what lets the
geometry be tested directly, and what lets the worker stay four lines long.

## Tests

```bash
npm test     # geometry and exporter unit tests
npm run smoke  # drives the real page in Chromium at both sizes
```

The unit tests check the build against the independent base-3 digit rule for
sponge membership, the sponge's symmetry under axis swaps and reflection, that
face windings point outward, that no edge in the surface mesh is left dangling,
and that STL and OBJ come out the size and shape they claim to be. For the
zoomed builder they also check that a full-cube region reproduces the whole
mesh exactly, that faces are still culled against cubes outside the region,
that the budget lowers the depth instead of overrunning, that a depth-12 slice
keeps whole cube edges in float32 rather than collapsing, and that the cost of
a region does not drift as it descends.

The smoke test boots the page, checks the model is actually drawn, drags to
orbit, switches palettes, opens a cutaway, dives the zoom slider to 531,441×
(confirming the depth follows, the focus lands on a surface, the cost stays
bounded and something is still on screen), builds level 4, downloads all three
export formats and reloads to confirm the URL state restores. It serves three.js
from the local `node_modules` copy, so it runs offline.

## Browser support

Needs WebGL 2 and ES modules: current Chrome, Safari, Firefox and Edge, desktop
or mobile. If three.js cannot be reached or WebGL is unavailable, the page says
so rather than sitting black.
