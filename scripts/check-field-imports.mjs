/*
 * A lower layer may not load a higher one.
 *
 *   node scripts/check-field-imports.mjs
 *
 * Two rules, both of that shape, which is why they are one file rather than two more scripts beside
 * `check-dialect-imports.mjs`:
 *
 * **The field may not download the widget it lives inside.** A field is a one-line editor for a
 * table cell, mounted *inside* a grid that has already paid for itself, so a field that fetches the
 * grid again pays twice for something it cannot use.
 *
 * **The drawing layer may not reach the editing surface.** `livePreview.ts` draws a document. The
 * cell editor, the toolbars and the link popover are chrome around it. While the toolbar read a
 * facet defined in `cellEditor.ts`, the arrow pointed both ways and every module in the set was
 * reachable from every other, which made the `notes` floor byte-identical to the `field` one.
 *
 * ## Why this is about the eager closure rather than the whole graph
 *
 * `check-dialect-imports.mjs` bundles without splitting, which is right for its question: a grammar
 * may not reach an editor by any route. These are different. The two table insertions in the
 * toolbar's Insert menu are legitimately reachable from the field, because the menu offers them and
 * draws them unavailable in a cell, and they are fetched when chosen. So `tables.ts` *is* in the
 * field's graph and must not be in what it loads before drawing. Measured without splitting, the
 * first rule would fail on the arrangement it exists to protect.
 *
 * Which is also the one reliable way to ask. A static import edge predicts nothing: the same
 * metafile records an edge to `tables.ts` whether its bytes land or not, and reading the edge rather
 * than `bytesInOutput` got two size claims wrong in one day while this work was being done, once in
 * each direction.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eagerOutputs } from './eager-closure.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const RULES = [
  {
    name: 'the field',
    /*
     * What the field is, until the profiles are entry points of their own.
     * `docs/14-editor-as-components.md` says "`src/webview/cellEditor.ts` is the field", so this
     * measures the thing that exists rather than an entry somebody would have to design first.
     */
    entry: join('scripts', 'size-floors', 'floor-field.ts'),
    /*
     * `images.ts` is deliberately absent and is still eager, at 11 KB. A field draws no images, but
     * the cell editor is also what a table cell uses inside a document, and a cell holding
     * `![dot](dot.png)` does draw the picture: `tables.entry.ts`'s "an image in a cell shows the
     * picture" asserts the `src`, the `alt`, the title and that Escape redraws it. Cutting images
     * out of this path would take that with it, so the seam has to be per-mount rather than
     * per-module. Left out with the reason rather than quietly omitted.
     */
    forbidden: {
      'src/webview/tables.ts': 'the grid itself, 82 KB raw',
      'src/webview/board.ts': 'the kanban view over a grid',
      'src/webview/columnLayout.ts': "the grid's column measuring",
      'src/webview/columnWidths.ts': "the grid's stored column widths",
      'src/webview/emojiTable.ts': '47 KB of generated shortcode data, fetched on first sight of one',
    },
    because:
      'It is mounted inside the grid, which has already loaded, so this is paid twice for something a\none-line field cannot use. Reach it with a dynamic import, or move the seam.',
  },
  {
    name: 'the link resolver',
    entry: join('src', 'webview', 'linkTarget.ts'),
    /*
     * It wants one function, `parseHtmlImage`, to decide whether a link's target is an image. That
     * is a question about text. Before `images.ts` was split it got the widget, the resize handles
     * and the caption machinery with it; now it takes 983 bytes of `imageMarkup.ts` and none of the
     * drawing half, so the boundary is worth holding.
     */
    forbidden: {
      'src/webview/images.ts': 'the image widget, its resize handles and its captions',
    },
    because:
      'Deciding whether a target is an image is a question about text. Take it from `imageMarkup.ts`,\nwhich knows the forms and nothing about the screen.',
  },
  {
    name: 'the formatting toolbar',
    entry: join('src', 'webview', 'toolbar.ts'),
    /*
     * A toolbar runs commands against the text. It has no business downloading the decoration
     * layer, and until the reveal state moved into `revealState.ts` it downloaded 16 KB of it and
     * the 6 KB image widget behind it, through `lineStart.ts` and `invisibleEdges.ts`, both of which
     * wanted two predicates and nothing drawn.
     *
     * This rule would have failed before that move, and the one obvious way to make it pass did
     * not work: cutting `shortcuts.ts -> livePreview.ts` left every byte in place, because
     * `shortcuts.ts` and `toolbar.ts` import each other and the route simply became
     * `shortcuts -> toolbar -> lineStart -> livePreview`. One edge removed is not one route
     * removed, which is the reason this is measured rather than asserted about imports.
     */
    forbidden: {
      'src/webview/livePreview.ts': 'the decoration layer, 16 KB raw',
      'src/webview/images.ts': 'the image widget, reached only through the decoration layer',
    },
    because:
      'A command that changes text needs the reveal state, not the drawing that reads it. Take it from\n`revealState.ts`, which both halves read.',
  },
  {
    name: 'the drawing layer',
    entry: join('src', 'webview', 'livePreview.ts'),
    /*
     * `toolbar.ts` is **not** forbidden here, and leaving it out is deliberate. `blockModel.ts`
     * imports it so `runOnText` can run toolbar commands against a detached editor, which is a real
     * dependency and the reason the toolbar is in this graph at all. The two below are what the
     * toolbar used to drag in behind it, and they are the ones with no business being reachable
     * from a module whose job is to draw.
     */
    forbidden: {
      'src/webview/cellEditor.ts': 'the cell editor, which imports livePreview itself, so this is a cycle',
      'src/webview/selectionToolbar.ts': 'the floating formatting toolbar, reached only through the cell editor',
    },
    because:
      'A module that draws a document must not load the chrome around it. If a predicate here needs a\nfact the surface knows, put the fact in its own module and let both read it, as `inlineOnly.ts` does.',
  },
];

let failed = false;

for (const rule of RULES) {
  const { metafile } = await build({
    entryPoints: [join(REPO, rule.entry)],
    bundle: true,
    write: false,
    metafile: true,
    // Minified, so the byte counts printed below mean the same thing as the floors' do. An import
    // assertion does not need them, but a number beside a module name gets compared to one.
    minify: true,
    splitting: true,
    outdir: join(REPO, '.claude', 'scratch', 'field-imports'),
    entryNames: 'entry',
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'error',
  });

  const entry = Object.keys(metafile.outputs).find((o) => o.endsWith('entry.js'));
  if (!entry) {
    console.error(`check-field-imports: ${rule.entry} produced no entry output, so nothing was checked.`);
    process.exit(1);
  }

  const eager = eagerOutputs(metafile, entry);
  const bytes = {};
  for (const file of eager) {
    for (const [input, info] of Object.entries(metafile.outputs[file].inputs ?? {})) {
      const own = input.replace(/^.*?(src\/)/, '$1');
      if (own.startsWith('src/')) bytes[own] = (bytes[own] ?? 0) + (info.bytesInOutput ?? 0);
    }
  }

  /*
   * A guard that can only pass is not a guard. The entry has to have reached *something* of Sheaf's
   * for an absence to mean anything, and an empty closure would otherwise read as every rule being
   * satisfied. This is the empty case the release build's own vacuous-pass failure was about.
   */
  const reached = Object.keys(bytes).length;
  if (reached === 0) {
    console.error(
      `check-field-imports: ${rule.name} reaches none of Sheaf's own modules, which cannot be right.\n` +
        `  ${rule.entry} built, ${eager.size} eager output(s), and no src/ module had bytes in them.\n` +
        '  Something about the build or the walk is wrong, so the rules were not actually tested.'
    );
    process.exit(1);
  }

  const found = Object.entries(rule.forbidden).filter(([mod]) => bytes[mod]);
  if (found.length) {
    failed = true;
    console.error(`${rule.name} loads ${found.length} module(s) it may not, before it draws anything:\n`);
    for (const [mod, why] of found) console.error(`  ${mod}  (${why})\n    ${bytes[mod]} bytes in the eager closure`);
    console.error(`\n${rule.because}\n`);
    continue;
  }

  const top = Object.entries(bytes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([m, b]) => `${m.replace('src/webview/', '')} ${Math.round(b / 1024)} KB`)
    .join(', ');
  console.log(`${rule.name}: ${reached} of Sheaf's own modules, none forbidden. Largest: ${top}.`);
}

process.exit(failed ? 1 : 0);
