// Bundles src/main.js with esbuild and inlines everything (wasm, box STL, sample SVGs, JS)
// into a single self-contained HTML file: docs/index.html (ready for GitHub Pages).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  platform: 'browser',
  external: ['node:*'],
  // manifold's Emscripten loader uses import.meta.url to locate its .wasm file. We pass the
  // wasm bytes in directly (wasmBinary), so any URL works here; it is never fetched.
  define: { 'import.meta.url': '"https://local/manifold.js"' },
  logLevel: 'error',
  write: false,
});
const app = result.outputFiles[0].text.replace(/<\/script/g, '<\\/script');

const b64 = path => readFileSync(path).toString('base64');
const wasm = b64('node_modules/manifold-3d/manifold.wasm');
const box = b64('assets/deck-box-top-loader.stl');

// Sample designs shown when the page opens: [face id, file name].
const SAMPLES = [['left', 'shire.svg'], ['right', 'treebeard.svg'], ['back', 'JRR.svg'], ['top', 'cover.svg']];
const available = new Set(readdirSync('samples'));
const samples = SAMPLES.filter(([, f]) => available.has(f)).map(([id, f]) => [id, f, readFileSync(`samples/${f}`, 'utf8')]);
const sampleJSON = JSON.stringify(samples).replace(/<\//g, '<\\/');

let html = readFileSync('src/template.html', 'utf8');
for (const [key, value] of [['%%WASM%%', wasm], ['%%BOX%%', box], ['%%SAMPLE%%', sampleJSON], ['%%APP%%', app]]) {
  const [before, after] = html.split(key);
  html = before + value + after;   // split/join avoids $-pattern surprises from String.replace
}
mkdirSync('docs', { recursive: true });
writeFileSync('docs/index.html', html);
console.log(`Built docs/index.html (${(html.length / 1048576).toFixed(2)} MB)`);
