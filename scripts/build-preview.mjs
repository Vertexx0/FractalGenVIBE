/**
 * Build a single-file copy of the app for hosting as a claude.ai Artifact.
 *
 * The hosted page runs the same modules as the repo — no hand-kept port to
 * drift out of step. What changes is only what the sandbox forces:
 *
 * - One file. The page's own modules are concatenated into one inline module;
 *   three.js still comes from the CDN through the import map.
 * - The worker is built from a Blob holding the same geometry core. If the
 *   sandbox refuses Blob workers, app.js already falls back to building on the
 *   main thread.
 * - Downloads are blocked in the sandbox, so the export controls are hidden
 *   rather than left in place doing nothing.
 *
 *   node scripts/build-preview.mjs [out.html]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? join(root, 'dist', 'menger-sponge.html');
const read = (path) => readFile(join(root, path), 'utf8');

const [html, css, core, exporters, app, worker] = await Promise.all([
  read('index.html'), read('src/style.css'), read('src/menger.js'),
  read('src/exporters.js'), read('src/app.js'), read('src/worker.js'),
]);

/** Strip ESM syntax from a module whose imports will already be in scope. */
function inline(source) {
  return source
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(const|let|function|class|async)\b)/gm, '');
}

/** Top-level names a source declares, to catch clashes before they ship. */
function declared(source) {
  return [...source.matchAll(/^(?:const|let|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]);
}

const pieces = { core: inline(core), exporters: inline(exporters), app: inline(app) };
const seen = new Map();
for (const [name, source] of Object.entries(pieces)) {
  for (const id of declared(source)) {
    if (seen.has(id)) throw new Error(`"${id}" is declared in both ${seen.get(id)} and ${name}`);
    seen.set(id, name);
  }
}

// app.js's third-party imports stay, hoisted to the top of the one module.
const thirdParty = [...app.matchAll(/^import[\s\S]*?from\s+['"](three[^'"]*)['"];\s*$/gm)]
  .map((m) => m[0]).join('\n');

// A classic worker: the core with its exports stripped, then the handler.
const workerSource = `${pieces.core}\n${inline(worker)}`;
const workerLine = "worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });";
if (!pieces.app.includes(workerLine)) throw new Error('worker construction in app.js has changed');
pieces.app = pieces.app.replace(workerLine,
  "worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));");

const moduleSource = [
  thirdParty,
  pieces.core,
  pieces.exporters,
  `const WORKER_SOURCE = ${JSON.stringify(workerSource)};`,
  pieces.app,
].join('\n');

// Page pieces from index.html: the title, the import map, the body markup and
// the boot guard. The Artifact host supplies its own doctype, head and body.
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const importMap = html.match(/<script type="importmap">[\s\S]*?<\/script>/)[0];
const bodyStart = html.indexOf('<body>') + '<body>'.length;
const scriptsStart = html.indexOf('<script>', bodyStart);
let body = html.slice(bodyStart, scriptsStart).trim();
const bootGuard = html.slice(scriptsStart, html.indexOf('<script type="module"', scriptsStart)).trim();

const exportField = '<div class="field" id="export-field">';
if (!body.includes(exportField)) throw new Error('export field markup has changed');
body = body.replace(exportField, '<p class="note">PNG, STL and OBJ export are in the full app' +
  ' &mdash; this hosted preview cannot start downloads.</p>\n    <div class="field" id="export-field" hidden>');

const page = `${title}
<style>
${css}
</style>
${importMap}
${body}
${bootGuard}
<script type="module">
${moduleSource}
</script>
`;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, page);
console.log(`wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);
