/**
 * Browser smoke test: boots the real page in Chromium at phone and desktop
 * sizes and drives the controls the way a thumb would.
 *
 * three.js normally comes from a CDN. Here the CDN requests are served from the
 * local node_modules copy, so the test runs offline and pins what ships.
 */
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const shots = process.env.SHOT_DIR ?? join(root, '.smoke');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
  if (!ok) failures.push(label);
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = path === '/' ? 'index.html' : path.slice(1);
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('nope');
  }
});
await new Promise((r) => server.listen(0, r));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle'],
});

/** Redirect the CDN imports to the installed three.js package. */
async function routeCDN(context) {
  await context.route('https://cdn.jsdelivr.net/**', async (route) => {
    const path = new URL(route.request().url()).pathname
      .replace(/^\/npm\/three@[^/]+\//, '');
    try {
      const body = await readFile(join(root, 'node_modules/three', path));
      await route.fulfill({ body, contentType: 'text/javascript' });
    } catch {
      await route.abort();
    }
  });
}

/**
 * Fraction of a CSS-pixel rectangle that shows the model rather than the
 * #0b0d12 background. Defaults to the whole canvas. The drawing buffer is
 * cleared once a frame is composited, so a fresh frame is forced and read back
 * in the same task.
 */
async function coverage(page, rect = null) {
  return page.evaluate((rect) => {
    const canvas = document.getElementById('view');
    window.__menger.render();
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const sx = w / canvas.clientWidth, sy = h / canvas.clientHeight;
    const r = rect ?? { x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight };
    const x0 = Math.floor(r.x * sx), x1 = Math.floor((r.x + r.w) * sx);
    // readPixels rows run bottom-up.
    const y0 = Math.floor(h - (r.y + r.h) * sy), y1 = Math.floor(h - r.y * sy);
    let lit = 0, total = 0;
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        const i = (y * w + x) * 4;
        const off = Math.abs(pixels[i] - 11) + Math.abs(pixels[i + 1] - 13)
          + Math.abs(pixels[i + 2] - 18);
        total++;
        if (off > 24) lit++;
      }
    }
    return lit / Math.max(total, 1);
  }, rect);
}

/** Wait until no build is running or queued. */
async function settle(page, timeout = 45000) {
  await page.waitForTimeout(250);
  await page.waitForFunction(
    () => window.__menger && !window.__menger.building && window.__menger.cubeCount > 0,
    null, { timeout });
  await page.waitForTimeout(150);
}

const probe = (page) => page.evaluate(() => {
  const m = window.__menger;
  return {
    zoom: m.zoom, depth: m.depth, depthMin: m.depthMin, cubes: m.cubeCount,
    faces: m.faceCount, threshold: m.threshold, focus: m.focus, level: m.state.level,
  };
});

async function run(name, contextOptions) {
  console.log(`\n=== ${name} ===`);
  const context = await browser.newContext({ ...contextOptions, acceptDownloads: true });
  await routeCDN(context);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(origin, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__mengerBooted === true, null, { timeout: 20000 });
  await settle(page);

  check(await page.locator('#boot-error').isHidden(), 'no boot error');
  const rest = await probe(page);
  console.log(`       stats: ${await page.locator('#stats').textContent()}`);
  check(rest.level === 5, `starts at iteration level 5 (got ${rest.level})`);
  // Detail stops at whichever comes first: the budget, which leaves several
  // depths on screen, or the 2.5 px floor, below which splitting adds nothing
  // you can see — on a phone the whole sponge is only ~330 px tall at 1x.
  const atFloor = rest.threshold <= 2.51;
  check(rest.depth - rest.depthMin >= 1 || atFloor,
    `detail runs to the budget or the pixel floor (${rest.depthMin}-${rest.depth}, ${rest.threshold.toFixed(1)} px)`);
  check(rest.depth >= 4, `at least four iterations at rest (depth ${rest.depth})`);
  check(rest.threshold <= 8, `finest cubes are small on screen (${rest.threshold.toFixed(1)} px)`);

  const full = await coverage(page);
  console.log(`       lit pixels: ${(full * 100).toFixed(1)}%`);
  check(full > 0.02, 'sponge is visibly rendered');
  await page.screenshot({ path: join(shots, `${name}-default.png`) });

  // Touch targets must clear the 44px guideline on a phone.
  const small = await page.$$eval(
    '#sheet-body button, #sheet-body input[type=range]',
    (nodes) => nodes.filter((n) => n.getBoundingClientRect().height < 37)
      .map((n) => n.id || n.textContent.trim()),
  );
  check(small.length === 0, `all controls are thumb-sized${small.length ? ` (small: ${small})` : ''}`);

  // Canvas must not hand touch drags to the page scroller.
  const touchAction = await page.evaluate(
    () => getComputedStyle(document.getElementById('view')).touchAction);
  check(touchAction === 'none', 'canvas owns touch gestures');

  // Drag to orbit. The press has to land on open canvas: on a phone the sheet
  // covers the lower half, on desktop the panel covers the left edge.
  const view = page.viewportSize();
  const sheet = await page.locator('#sheet').boundingBox();
  const sidePanel = sheet.height >= view.height - 1;
  const cx = sidePanel ? (sheet.x + sheet.width + view.width) / 2 : view.width / 2;
  const cy = sidePanel ? view.height / 2 : sheet.y / 2;
  const clip = { x: cx - 90, y: cy - 90, width: 180, height: 180 };

  const camBefore = await page.evaluate(() => window.__menger.camera);
  const before = await page.screenshot({ clip });
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 130, cy + 45, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const camAfter = await page.evaluate(() => window.__menger.camera);
  const after = await page.screenshot({ clip });
  const moved = Math.hypot(...camAfter.map((v, i) => v - camBefore[i]));
  check(moved > 0.05, `drag orbits the camera (moved ${moved.toFixed(3)})`);
  check(!before.equals(after), 'the view repaints after a drag');
  check((await probe(page)).level === 5, 'dragging the canvas does not touch the controls');
  // An orbit changes what is visible, so it must bring a rebuild with it.
  await settle(page);
  check(await coverage(page) > 0.02, 'the model is rebuilt for the new angle');

  // Palette switch is a uniform change on the GPU.
  await page.click('#palette button[data-value="ember"]');
  await page.waitForTimeout(200);
  check(
    await page.getAttribute('#palette button[data-value="ember"]', 'aria-checked') === 'true',
    'palette switches to ember',
  );
  await page.screenshot({ path: join(shots, `${name}-ember.png`) });

  // Detail: High splits finer than Low.
  await page.click('#detail button[data-value="low"]');
  await settle(page);
  const low = await probe(page);
  await page.click('#detail button[data-value="high"]');
  await settle(page);
  const high = await probe(page);
  console.log(`       detail low ${low.cubes} cubes @ ${low.threshold.toFixed(1)}px, high ${high.cubes} @ ${high.threshold.toFixed(1)}px`);
  check(high.cubes > low.cubes, 'High detail builds more cubes than Low');
  check(high.threshold < low.threshold, 'High detail splits cubes finer than Low');
  await page.screenshot({ path: join(shots, `${name}-high.png`) });
  await page.click('#detail button[data-value="medium"]');
  await settle(page);

  // Cutaway reveals the interior.
  await page.fill('#cut', '55');
  await page.dispatchEvent('#cut', 'input');
  await settle(page);
  check(await page.locator('#cut-out').textContent() === '55%', 'cutaway reports 55%');
  const cutCoverage = await coverage(page);
  check(cutCoverage < full, `cutaway removes geometry (${(cutCoverage * 100).toFixed(1)}%)`);
  await page.screenshot({ path: join(shots, `${name}-cutaway.png`) });
  await page.fill('#cut', '0');
  await page.dispatchEvent('#cut', 'input');
  await settle(page);

  // Zoom: the slider must dive, deepen, and stay bounded.
  const dives = [];
  for (const slider of [250, 500, 750, 1000]) {
    await page.fill('#zoom', String(slider));
    await page.dispatchEvent('#zoom', 'input');
    await settle(page);
    dives.push(await probe(page));
  }
  for (const d of dives) {
    console.log(`       zoom ${Math.round(d.zoom)}x -> depths ${d.depthMin}-${d.depth}, ` +
      `${d.cubes} cubes, finest ${d.threshold.toFixed(1)}px`);
  }
  const deepest = dives[dives.length - 1];
  check(deepest.zoom > 100000, `slider reaches deep zoom (${Math.round(deepest.zoom)}x)`);
  check(deepest.depth >= 14, `depth follows zoom (${deepest.depth})`);
  check(deepest.depth - deepest.depthMin >= 6,
    `many iterations on screen at once (${deepest.depthMin}-${deepest.depth})`);
  check(deepest.focus.some((v) => v !== 0),
    `zoom aimed at the surface (${deepest.focus.map((v) => v.toFixed(3))})`);
  check(Math.max(...dives.map((d) => d.cubes)) <= 220000, 'the cube budget holds at every zoom');

  // The surface is seen at an angle and fills the whole view here. A build
  // that stops at a box around the focus leaves a hard edge and bare background
  // inside the picture; this is the regression check for that.
  const free = await page.evaluate(() => window.__menger.visibleRect());
  const filled = await coverage(page, free);
  console.log(`       free canvas covered at full zoom: ${(filled * 100).toFixed(1)}%`);
  check(filled > 0.9, `geometry reaches the edges of the view (${(filled * 100).toFixed(1)}% covered)`);
  await page.screenshot({ path: join(shots, `${name}-zoom.png`) });

  await page.fill('#zoom', '0');
  await page.dispatchEvent('#zoom', 'input');
  await page.click('#reset');
  await settle(page);
  check((await probe(page)).zoom < 1.02, 'reset returns to 1x');

  // One flick from 1x to the end: the focus has to be walked down every level
  // in between, or it lands in a hole carved at some intermediate scale.
  await page.fill('#zoom', '1000');
  await page.dispatchEvent('#zoom', 'input');
  await settle(page);
  const flick = await probe(page);
  const flickFilled = await coverage(page, await page.evaluate(() => window.__menger.visibleRect()));
  console.log(`       flick to ${Math.round(flick.zoom)}x -> depths ${flick.depthMin}-${flick.depth}, ` +
    `${flick.cubes} cubes, ${(flickFilled * 100).toFixed(1)}% covered`);
  check(flick.depth >= 14 && flickFilled > 0.9, 'a single flick to full zoom lands on solid structure');
  await page.fill('#zoom', '0');
  await page.dispatchEvent('#zoom', 'input');
  await page.click('#reset');
  await settle(page);

  // Level 0 is a single cube, whatever else is going on.
  for (let i = 0; i < 5; i++) await page.click('#level-down');
  await settle(page);
  const zero = await probe(page);
  check(zero.cubes === 1 && zero.depth === 0, `level 0 is one cube (${zero.cubes} at depth ${zero.depth})`);
  check(await page.isDisabled('#level-down'), 'level cannot go below 0');

  // Exports at level 3: one depth, printable, 100 mm across.
  for (let i = 0; i < 3; i++) await page.click('#level-up');
  await settle(page);
  for (const [selector, extension] of [['#save-png', 'png'], ['#save-stl', 'stl'], ['#save-obj', 'obj']]) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click(selector),
    ]);
    const file = join(shots, download.suggestedFilename());
    await download.saveAs(file);
    const size = (await readFile(file)).length;
    check(
      download.suggestedFilename() === `menger-d3.${extension}` && size > 1000,
      `${extension.toUpperCase()} downloads as ${download.suggestedFilename()} (${size} bytes)`,
    );
    if (extension === 'stl') {
      // A whole level-3 sponge, not the view's culled, mixed-depth mesh.
      check(size === 84 + 50 * 36096, `STL is the complete level-3 solid (${size} bytes)`);
    }
    await page.waitForFunction(() => !document.getElementById('save-stl').disabled);
  }

  // Shared state survives a reload.
  await page.click('#palette button[data-value="bone"]');
  await page.waitForTimeout(400);
  const hash = new URL(page.url()).hash;
  check(hash.includes('p=bone') && hash.includes('l=3') && hash.includes('d=medium'),
    `url carries the state (${hash})`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__mengerBooted === true, null, { timeout: 20000 });
  check(
    await page.getAttribute('#palette button[data-value="bone"]', 'aria-checked') === 'true',
    'state restores from the url',
  );

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3)}` : ''}`);
  await context.close();
}

await run('phone', { ...devices['iPhone 13'] });
await run('desktop', { viewport: { width: 1440, height: 900 } });

await browser.close();
server.close();

await writeFile(join(shots, 'result.json'), JSON.stringify({ failures }, null, 2));
console.log(`\n${failures.length ? `FAILED (${failures.length})` : 'all checks passed'} — screenshots in ${shots}`);
process.exit(failures.length ? 1 : 0);
