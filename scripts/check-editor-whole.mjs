/*
 * The editor the checks mount is the editor the product mounts.
 *
 *   node scripts/check-editor-whole.mjs
 *
 * `editorExtensions()` returns what the editor is. `src/webview/main.ts` takes that and builds the
 * array it hands to CodeMirror, adding host plumbing: a compartment for line numbers, one for
 * editability, a transaction filter for a CSV document, and an update listener that posts edits
 * back. All of that is legitimately main's, because it is about the process behind the editor rather
 * than about drawing a document.
 *
 * **What is not legitimately main's is a module that draws a construct**, and one was there.
 * `viewBlocks` was composed in main's array rather than inside `editorExtensions`, so a ```` ```view ````
 * fence drew as an ordinary code block in everything that mounts `editorExtensions` alone:
 * `test/harness.ts` and so the prose scenarios, `check-render.mjs`, `check-render-agrees.mjs`, and
 * the jsdom half of the real-editor scenarios. `sample/views.md` holds four of them and
 * `check-render.mjs` reported it clean, because its telltales test rendered text with code stripped
 * and a fence drawn as a fence has nothing for them to catch.
 *
 * So the fault was two definitions of the editor, one of which only the checks ever saw. **It was
 * not host drift**: `main.ts` is the entry of `media/webview.js`, the one bundle both hosts load, so
 * both hosts drew views correctly throughout.
 *
 * ## Why this rather than a telltale for a view fence
 *
 * A telltale would catch this construct. This catches the **class**: any module that draws, reachable
 * from the product's entry and not from the editor's, is a module whose drawing no check can see.
 * The next extension composed in the wrong array fails here on the day it is written, whatever it
 * draws, rather than when somebody happens to write a probe for it.
 *
 * ## What counts as drawing, and that it is a heuristic
 *
 * A module that mentions `Decoration.` — that is how a CodeMirror decoration is made, and there is
 * no other way. Twelve modules match, which is the same twelve a separate walk of
 * `src/webview/` arrived at independently, so the heuristic is corroborated rather than merely
 * plausible. It will over-match a module that names the type without drawing, which is harmless:
 * such a module is in both closures and never trips this. It would under-match a module that drew
 * through a helper and never named `Decoration` itself, and no module does today.
 */
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eagerOutputs } from './eager-closure.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every module under `src/webview/` that makes a decoration. */
function drawingModules() {
  const dir = join(REPO, 'src', 'webview');
  return new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes('Decoration.'))
      .map((f) => `src/webview/${f}`)
  );
}

/** The `src/` modules whose bytes land in `entry`'s eager closure. */
async function closureOf(entry) {
  const { metafile } = await build({
    entryPoints: [join(REPO, entry)],
    bundle: true,
    write: false,
    metafile: true,
    minify: true,
    splitting: true,
    outdir: join(REPO, '.claude', 'scratch', 'editor-whole'),
    entryNames: 'entry',
    chunkNames: 'c/[name]-[hash]',
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'error',
  });
  const out = Object.keys(metafile.outputs).find((o) => o.endsWith('entry.js'));
  if (!out) throw new Error(`${entry}: produced no entry output`);
  const reached = new Set();
  for (const file of eagerOutputs(metafile, out)) {
    for (const [input, info] of Object.entries(metafile.outputs[file].inputs ?? {})) {
      const own = input.replace(/^.*?(src\/)/, '$1');
      // Reached *and* contributing bytes: an import edge whose bytes were shaken out is not a module
      // this entry loads, which is the distinction every size claim in this repository turns on.
      if (own.startsWith('src/') && (info.bytesInOutput ?? 0) > 0) reached.add(own);
    }
  }
  return reached;
}

const drawing = drawingModules();
const product = await closureOf(join('src', 'webview', 'main.ts'));
const editor = await closureOf(join('src', 'webview', 'editorExtensions.ts'));

/*
 * The empty cases, and there are three, because each one would let this pass by measuring nothing.
 */
if (drawing.size === 0) {
  console.error('check-editor-whole: no module under src/webview/ mentions `Decoration.`, which cannot be right.');
  process.exit(1);
}
if (product.size === 0 || editor.size === 0) {
  console.error(
    `check-editor-whole: a closure came back empty, product ${product.size} and editor ${editor.size}, so nothing was compared.`
  );
  process.exit(1);
}
const drawingInProduct = [...drawing].filter((m) => product.has(m));
if (drawingInProduct.length === 0) {
  console.error(
    'check-editor-whole: the product entry reaches none of the drawing modules, so an absence below would mean nothing.\n' +
      `  ${drawing.size} module(s) draw, ${product.size} src/ module(s) in the product's closure, and no overlap.`
  );
  process.exit(1);
}

const missing = drawingInProduct.filter((m) => !editor.has(m));

if (missing.length) {
  console.error(
    `${missing.length} module(s) draw a construct in the product and not in what the checks mount:\n`
  );
  for (const m of missing) console.error(`  ${m}`);
  console.error(
    '\nSomething is composed in `main.ts`\'s own array rather than inside `editorExtensions()`, so the\n' +
      'editor is two things and only the product gets the whole of it. Every jsdom mount goes through\n' +
      '`editorExtensions`, so whatever that module draws is invisible to the prose scenarios,\n' +
      '`check-render.mjs`, `check-render-agrees.mjs` and the jsdom real-editor scenarios — and those\n' +
      'checks report a pass over a rendering the product does not produce.\n' +
      '\nMove it into `editorExtensions()`. Host plumbing stays in `main.ts`; drawing does not.'
  );
  process.exit(1);
}

console.log(
  `${drawingInProduct.length} of ${drawing.size} drawing module(s) are in the product's closure, and the editor's closure has every one of them.`
);
console.log(`  ${drawingInProduct.map((m) => m.replace('src/webview/', '')).sort().join(', ')}`);
console.log(
  `  product ${product.size} src/ module(s), editor ${editor.size}; the ${product.size - editor.size} main.ts adds are host plumbing, which draws nothing.`
);
