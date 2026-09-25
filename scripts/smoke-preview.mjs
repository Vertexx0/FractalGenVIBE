/**
 * Smoke test for the hosted single-file build (npm run build:preview).
 *
 * The page is wrapped in the skeleton the Artifact host supplies and served
 * under a content security policy modelled on its sandbox, twice: once with
 * Blob workers allowed, and once with workers refused, which must fall back to
 * building on the main thread rather than hang. Each run boots at phone and
 * desktop sizes and flicks the zoom straight to the end.
 *
 * As with smoke.mjs, three.js is served from node_modules, so this runs offline.
 */
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const shots = process.env.SHOT_DIR ?? join(root, '.smoke');
const built = join(root, 'dist', 'menger-sponge.html');

let page;
try {
  page = await readFile(built, 'utf8');
} catch {
  console.error(`no ${built} — run npm run build:preview first`);
  process.exit(1);
}
await mkdir(shots, { recursive: true });

// The host's skeleton, as its page contract describes it.
const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0);padding-bottom:env(safe-area-inset-bottom,0);color-scheme:light}
body{margin:0;font:14px system-ui;background:#faf9f7}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>${page}</body></html>`;

const base = "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/ " +
  "https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src data: blob:; connect-src 'none'";
const policies = {
  'blob workers allowed': `${base}; worker-src blob:`,
  'workers refused': `${base}; worker-src 'none'`,
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle'],
});

let failures = 0;
for (const [mode, csp] of Object.entries(policies)) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, r));

  for (const [name, options] of [['phone', devices['iPhone 13']], ['desktop', { viewport: { width: 1440, height: 900 } }]]) {
    const context = await browser.newContext(options);
    await context.route('https://cdn.jsdelivr.net/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, '');
      try {
        const body = await readFile(join(root, 'node_modules/three', path));
        await route.fulfill({ body, contentType: 'text/javascript' });
      } catch {
        await route.abort();
      }
    });
    const tab = await context.newPage();
    const errors = [];
    tab.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    tab.on('pageerror', (e) => errors.push(String(e)));

    const label = `${mode} / ${name}`;
    try {
      await tab.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' });
      const idle = () => tab.waitForFunction(
        () => window.__menger && !window.__menger.building && window.__menger.cubeCount > 0,
        null, { timeout: 90000 });
      await idle();
      const rest = await tab.evaluate(() => ({ cubes: window.__menger.cubeCount, depth: window.__menger.depth }));
      await tab.fill('#zoom', '1000');
      await tab.dispatchEvent('#zoom', 'input');
      await tab.waitForTimeout(400);
      await idle();
      const deep = await tab.evaluate(() => ({
        cubes: window.__menger.cubeCount, depth: window.__menger.depth, min: window.__menger.depthMin,
      }));
      const exportHidden = await tab.locator('#export-field').isHidden();
      // With workers refused, the browser reports the refusal itself; that one
      // is expected. Anything else is a failure.
      const unexpected = errors.filter((e) => !(mode === 'workers refused' && /worker/i.test(e)));
      const ok = deep.depth >= 14 && exportHidden && unexpected.length === 0;
      console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}: rest ${rest.cubes} cubes to depth ${rest.depth}; ` +
        `full zoom depths ${deep.min}-${deep.depth}, ${deep.cubes} cubes; exports hidden ${exportHidden}` +
        `${unexpected.length ? `; errors: ${unexpected.slice(0, 2)}` : ''}`);
      if (!ok) failures++;
      await tab.screenshot({ path: join(shots, `preview-${name}-${mode.split(' ')[0]}.png`) });
    } catch (error) {
      failures++;
      console.log(` FAIL  ${label}: ${error.message.split('\n')[0]}; errors: ${errors.slice(0, 2)}`);
    }
    await context.close();
  }
  server.close();
}

await browser.close();
console.log(failures ? `\nFAILED (${failures})` : '\nhosted build ok under both policies');
process.exit(failures ? 1 : 0);
