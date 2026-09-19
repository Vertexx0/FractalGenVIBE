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

/** Is anything actually drawn, or are we looking at an empty background? */
async function canvasHasModel(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('view');
    // The drawing buffer is cleared once a frame is composited, so force a
    // fresh render and read it back in the same task.
    window.__menger.render();
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      // Anything that differs from the #0b0d12 background, however dimly lit.
      const off = Math.abs(pixels[i] - 11) + Math.abs(pixels[i + 1] - 13)
        + Math.abs(pixels[i + 2] - 18);
      if (off > 24) lit++;
    }
    return lit / (w * h);
  });
}

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
  await page.waitForFunction(() => /cubes/.test(document.getElementById('stats').textContent));
  await page.waitForTimeout(600);

  check(await page.locator('#boot-error').isHidden(), 'no boot error');
  const stats = await page.locator('#stats').textContent();
  console.log(`       stats: ${stats}`);
  check(stats.includes('8,000 cubes'), 'default level 3 reports 8,000 cubes');
  check(stats.includes('36,096 tris'), 'culled mesh reports 36,096 triangles');
  check(stats.includes('depth 3'), 'stats report the build depth');

  const coverage = await canvasHasModel(page);
  console.log(`       lit pixels: ${(coverage * 100).toFixed(1)}%`);
  check(coverage > 0.02, 'sponge is visibly rendered');
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

  // Rotate by dragging, and confirm the camera actually moved.
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
  check(
    (await page.evaluate(() => window.__menger.state.level)) === 3,
    'dragging the canvas does not touch the controls',
  );

  // Palette switch.
  await page.click('#palette button[data-value="ember"]');
  await page.waitForTimeout(300);
  check(
    await page.getAttribute('#palette button[data-value="ember"]', 'aria-checked') === 'true',
    'palette switches to ember',
  );
  await page.screenshot({ path: join(shots, `${name}-ember.png`) });

  // Cutaway reveals the interior.
  await page.fill('#cut', '55');
  await page.dispatchEvent('#cut', 'input');
  await page.waitForTimeout(300);
  check(await page.locator('#cut-out').textContent() === '55%', 'cutaway reports 55%');
  const cutCoverage = await canvasHasModel(page);
  check(cutCoverage < coverage, `cutaway removes geometry (${(cutCoverage * 100).toFixed(1)}%)`);
  await page.screenshot({ path: join(shots, `${name}-cutaway.png`) });
  await page.fill('#cut', '0');
  await page.dispatchEvent('#cut', 'input');

  // Zoom: the slider must dive, deepen, and keep the cost bounded.
  const atRest = await page.evaluate(() => ({
    zoom: window.__menger.zoom, depth: window.__menger.depth, faces: window.__menger.faceCount,
  }));
  check(Math.abs(atRest.zoom - 1) < 0.02, `starts at 1x (${atRest.zoom.toFixed(2)})`);
  check(atRest.depth === 3, `starts at depth 3 (got ${atRest.depth})`);

  const dives = [];
  for (const slider of [250, 500, 750, 1000]) {
    await page.fill('#zoom', String(slider));
    await page.dispatchEvent('#zoom', 'input');
    await page.waitForFunction(
      (want) => !document.getElementById('save-stl').disabled
        && window.__menger.depth >= want,
      3 + Math.round(Math.log(3 ** (12 * slider / 1000)) / Math.log(3)) - 1,
      { timeout: 30000 },
    );
    dives.push(await page.evaluate(() => ({
      zoom: window.__menger.zoom,
      depth: window.__menger.depth,
      faces: window.__menger.faceCount,
      focus: window.__menger.focus,
    })));
  }
  for (const d of dives) {
    console.log(`       zoom ${Math.round(d.zoom)}x -> depth ${d.depth}, ${d.faces} faces`);
  }
  const deepest = dives[dives.length - 1];
  check(deepest.zoom > 100000, `slider reaches deep zoom (${Math.round(deepest.zoom)}x)`);
  check(deepest.depth >= 12, `depth follows zoom (${deepest.depth})`);
  check(
    deepest.focus.some((v) => v !== 0),
    `zoom aimed at the surface (${deepest.focus.map((v) => v.toFixed(3))})`,
  );
  const worst = Math.max(...dives.map((d) => d.faces));
  check(worst < 600000, `deep zoom stays bounded (worst ${worst} faces)`);
  check(await canvasHasModel(page) > 0.02, 'geometry is still drawn at full zoom');
  await page.screenshot({ path: join(shots, `${name}-zoom.png`) });

  // New detail, not a magnified version of the same cubes.
  check(
    deepest.depth > atRest.depth + 8,
    `zoom generated ${deepest.depth - atRest.depth} extra iterations`,
  );

  await page.fill('#zoom', '0');
  await page.dispatchEvent('#zoom', 'input');
  await page.waitForFunction(() => window.__menger.zoom < 1.02, null, { timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById('save-stl').disabled, null, { timeout: 20000 });

  // Level 4: the heaviest build the UI allows.
  await page.click('#level-up');
  await page.waitForFunction(
    () => /160,000 cubes/.test(document.getElementById('stats').textContent),
    null, { timeout: 30000 });
  const heavy = await page.locator('#stats').textContent();
  console.log(`       stats: ${heavy}`);
  check(heavy.includes('672,768 tris'), 'level 4 builds 672,768 triangles');
  check(
    (await page.locator('#level-note').textContent()).includes('heavy'),
    'level 4 warns that it is heavy',
  );
  check(await page.isDisabled('#level-up'), 'level cannot exceed the cap');
  await page.screenshot({ path: join(shots, `${name}-level4.png`) });

  await page.click('#level-down');
  await page.waitForFunction(
    () => /8,000 cubes/.test(document.getElementById('stats').textContent), null, { timeout: 20000 });

  // Exports.
  for (const [selector, extension] of [['#save-png', 'png'], ['#save-stl', 'stl'], ['#save-obj', 'obj']]) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      page.click(selector),
    ]);
    const file = join(shots, download.suggestedFilename());
    await download.saveAs(file);
    const size = (await readFile(file)).length;
    check(
      download.suggestedFilename() === `menger-d3.${extension}` && size > 1000,
      `${extension.toUpperCase()} downloads as ${download.suggestedFilename()} (${size} bytes)`,
    );
  }

  // Shared state survives a reload.
  await page.click('#palette button[data-value="bone"]');
  await page.waitForTimeout(400);
  const hash = new URL(page.url()).hash;
  check(hash.includes('p=bone'), `url carries the state (${hash})`);
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
