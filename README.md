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

- **Iterations 0–7**: the deepest level allowed at 1×.
- **Zoom to 531,441×**, generating new iterations as you dive — see below.
- **Many iterations on screen at once.** Near structure is refined many levels
  deeper than distant structure, so a deep dive shows depths 6 to 17 in one
  frame, from coarse blocks on the horizon to cubes a few pixels wide.
- **Detail: Low / Medium / High** scales the cube budget, and shows how fine
  the smallest cubes on screen came out.
- **Four palettes.** `Depth`, `Ember` and `Bone` shade by how deep inside its
  own nested blocks each face sits, so rims are bright and tunnels dark at every
  scale at once; `Axis` colours faces by the direction they point.
- **Cutaway** along any axis, with the interior shaded separately so a slice
  looks hollow instead of solid.
- **Auto-spin** and orbit/pinch controls.
- **Export** to PNG, binary STL or OBJ. Models are built separately from the
  view — one depth, closed, consistently wound, 100 mm across — so they drop
  straight into a slicer: the whole sponge at 1×, the slice around the focus
  when zoomed in.
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

Nothing on screen is the whole sponge at one level: level 5 is already 3.2
million cubes, and level 7 is 1.3 billion. What gets built is what the camera
can actually see.

## Building only what you can see

Each view is built fresh for the camera by walking the subdivision tree:

- **Split while large on screen.** A cube is divided while its projected size
  is above a pixel threshold, so the wall in front of you goes many levels
  deeper than the far side of the sponge. That is why several iterations show
  at once rather than one.
- **Cull to the frustum.** Anything outside the view — plus a spare ring so a
  small orbit does not open a gap before the next build lands — is dropped.
  An earlier version built a box around the focus instead; the view is a
  frustum that widens with distance, so surfaces seen at an angle ran out of
  the box and stopped in a hard edge inside the picture.
- **Cull what is hidden.** Measured on real views, 92% of a naive build sits
  behind the front surface. So the tree is walked front to back while a coarse
  software depth buffer records what every finished cube covers; anything
  entirely behind that is never split, counted or meshed. Roughly doubling the
  detail the same budget buys at the focus.
- **Fit the budget.** The pixel threshold that fills the budget is not known
  in advance. Each build starts from the last one's threshold and corrects
  from the count it gets (cubes scale roughly as threshold^−2.2), so a build
  is usually a single walk.

Faces between two cubes are dropped only when the neighbour is drawn as one
solid block. Where detail levels meet, the finer side is full of holes, so the
coarser cube keeps its face — otherwise you would see straight through the
seam.

## Zooming forever

The zoom slider adds **one iteration per 3× of magnification** to the ceiling,
which is the natural rate: each iteration cuts a cube into thirds, so cubes hold
a steady size on screen however far you dive. At the end of the slider you are
at 531,441× and depth 17 — a sponge of 10²² cubes, if anyone could build one.

A few things make the dive work:

- **Faces are culled against cubes that were never generated.** A neighbour's
  solidity comes from the closed form — a cell survives exactly when no base-3
  digit triple of its coordinates holds two or more ones — and stepping to a
  neighbour only changes digits as far as the carry reaches, so the check
  usually stops after one or two digits rather than seventeen.
- **The origin travels with the view.** At depth 15 a cube is 7 × 10⁻⁸ of the
  sponge wide, far below what float32 resolves near a coordinate of 0.5.
  Vertices come out relative to the focus, so the mantissa is spent on detail
  instead of on position. The near and far planes, and the fog, are rescaled
  each frame for the same reason.
- **The focus is walked down level by level.** The sponge has zero volume, so
  a point that is solid at depth 5 has almost certainly been carved away by
  depth 15, by a hole cut at any scale in between. Each level is aimed from the
  distance at which it is the ceiling — near enough to resolve it, far enough
  to see past the holes of the level before. Without this, flicking the slider
  straight to the end lands in a hole.

**Tap the sponge to aim.** Zoom dives toward the point you last aimed at, and
the first dive aims down the middle of the screen for you.

## Why it stays fast on a phone

- **Builds run in a worker**, so the page stays responsive while a view of a
  couple of hundred thousand cubes is generated. Orbiting rebuilds in the
  background, throttled rather than debounced, so the edges fill in during a
  long drag instead of after it.
- **Hidden cubes never reach the GPU**, and neither do faces shared by two
  solid cubes.
- **The cube budget is smaller on touch devices** (110k at Medium against 200k),
  and the builder never splits a cube below a few pixels, where more iterations
  would not show.
- **Palettes are a texture lookup on the GPU.** Shading comes from the geometry
  as one value per vertex, so switching palette never touches a vertex.
- **The render loop sleeps** when the camera is still.
- **Pixel ratio drops to 1.5** past 300k faces — fill rate is the wall on
  mobile, not triangle count.
- **The camera frames itself** against whatever canvas the sheet is not
  covering, so the model is never hidden behind the controls.

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
scripts/build-preview.mjs  single-file build for hosting as an Artifact
```

`src/menger.js` deliberately knows nothing about three.js: that is what lets the
geometry be tested directly, and what lets the worker stay four lines long.

## Tests

```bash
npm test               # geometry, exporter and view-builder unit tests
npm run smoke          # drives the real page in Chromium at both sizes
npm run build:preview  # writes dist/menger-sponge.html for hosting
npm run smoke:preview  # that file, under a sandbox-like CSP, workers on and off
```

The unit tests check the build against the independent base-3 digit rule for
sponge membership, the sponge's symmetry under axis swaps and reflection, that
face windings point outward, that no edge in the surface mesh is left dangling,
and that STL and OBJ come out the size and shape they claim to be.

For the view builder they check, among other things:

- that every solid point inside the view is built — sampling deliberately
  outside where the old focus box ended, so the test proves something;
- that occlusion culling drops at least a fifth of the cubes but never one
  that is first along a ray from the camera;
- that where detail levels meet, a face is hidden only by a neighbour drawn
  as one solid block, and kept whenever the neighbour was split;
- that with nothing culled it reproduces the whole-sponge mesh exactly, and
  that the carry-limited neighbour test agrees with the full digit rule on
  every cell at depth 3;
- that a depth-17 dive shows six or more iterations at once, still on the
  exact cube grid in float32.

The smoke test boots the page and checks the model is drawn; drags to orbit
and confirms the view is rebuilt for the new angle; compares Low and High
detail; opens a cutaway; dives the slider to 531,441× in steps and in a single
flick, checking that the depth follows, many iterations show at once, the
budget holds, and the surface covers more than 90% of the free canvas (the
old box-shaped build left around 40% of it empty); exports all three formats;
and reloads to confirm the URL state restores. It serves three.js from the
local `node_modules` copy, so it runs offline.

## Hosted preview

`npm run build:preview` concatenates the same modules into one HTML file that
runs as a claude.ai Artifact: three.js still comes from the CDN through the
import map, the worker is started from a Blob (falling back to the main thread
if the sandbox refuses), and the export buttons are hidden because the sandbox
blocks downloads.

## Browser support

Needs WebGL 2 and ES modules: current Chrome, Safari, Firefox and Edge, desktop
or mobile. If three.js cannot be reached or WebGL is unavailable, the page says
so rather than sitting black.
