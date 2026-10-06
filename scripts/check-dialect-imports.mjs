/*
 * Nothing the dialect is made of may import an editor.
 *
 *   node scripts/check-dialect-imports.mjs
 *
 * **The rule: a module reachable from `src/dialect/markdown.ts` may not import `@codemirror/view`.**
 * The dialect is what Sheaf *reads*. A consumer that wants to parse Markdown, render a list of rows
 * on a server, or draw a field nobody is typing in should not have to download an editor to do it,
 * and a render path that pulls the view layer is not a render path.
 *
 * `@lezer/highlight` is allowed and is in three of these modules. Its tags say what a node *is*,
 * which is a property of the grammar; how a node is painted is the editor's.
 *
 * ## Why this exists rather than the size number alone
 *
 * Until 2026-10-04 the dialect cost 91 KB gzipped and carried the whole of `@codemirror/view`, for
 * two reasons that both read as ordinary code. `footnotes.ts` and `maths.ts` each held a construct's
 * grammar and the decorations that draw it in one file. And `markdownDialect.ts` held the dialect
 * beside the CodeMirror language built from it, which is constructed at module scope, so the
 * language could not be shaken out of anything that imported the dialect. Split, it is 20 KB and
 * the view layer is absent.
 *
 * A size number would catch that coming back only when somebody next measured, and it would report
 * it as "the bundle grew" rather than as "this import is not allowed". This fails on the day the
 * import is written, which is the same argument `check-bundle-size.mjs` makes for `FORBIDDEN_EAGER`
 * and it applies here unchanged.
 *
 * ## How it reads the graph
 *
 * esbuild's metafile, because it answers what was actually reached rather than what a regex thinks
 * a file says. A module three imports away is caught the same as a direct one, and a path that is
 * only reached through a re-export is still reached.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/*
 * Every entry that must stay clear of an editor, and why each one is here.
 *
 * The dialect is what Sheaf reads. The render path is what a list of a hundred rows and a server
 * render use, and its whole argument is that it is small and runs in Node: a render path that pulls
 * the view layer is not a render path, so the assertion belongs on it as much as on the grammar.
 */
const ENTRIES = [join('src', 'dialect', 'markdown.ts'), join('src', 'render', 'markdown.ts')];

/**
 * What a grammar may never reach.
 *
 * The view layer is the line rather than all of CodeMirror: `@codemirror/state` is a document and a
 * selection, which a parser-side consumer can legitimately want, and `@lezer/*` is the parser itself.
 * If a second package belongs here, add it with the sentence that says why.
 */
const FORBIDDEN = ['@codemirror/view'];

let failed = false;
for (const ENTRY of ENTRIES) {
const result = await build({
  entryPoints: [join(REPO, ENTRY)],
  bundle: true,
  write: false,
  metafile: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  logLevel: 'error',
  absWorkingDir: REPO,
});

/** Every module the entry reaches, with who imported it, so a failure can name the path. */
const importers = new Map();
for (const [file, input] of Object.entries(result.metafile.inputs)) {
  for (const im of input.imports ?? []) {
    if (!importers.has(im.path)) importers.set(im.path, file);
  }
}

const reached = Object.keys(result.metafile.inputs);
const problems = [];
for (const pkg of FORBIDDEN) {
  for (const file of reached) {
    if (!file.includes(`node_modules/${pkg}/`)) continue;
    problems.push(`${importers.get(file) ?? '(the entry)'} imports ${pkg}`);
    break;
  }
}

if (problems.length) {
  console.log(`${ENTRY} reaches an editor, and it may not:\n`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('\nA module on this side of the line holds the grammar, or the rendering, and nothing');
  console.log('about drawing into a CodeMirror document. Put the decorations in src/webview/ and');
  console.log('import from there, the way src/webview/footnotes.ts and src/webview/maths.ts do.');
  failed = true;
  continue;
}

const own = reached.filter((f) => f.startsWith('src/'));
const pkgs = new Set(
  reached.filter((f) => f.includes('node_modules/')).map((f) => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(f)[1])
);
console.log(`${ENTRY} reaches ${own.length} of Sheaf's own modules and ${pkgs.size} package(s), and no editor:`);
console.log(`  ${[...pkgs].sort().join(', ')}`);
}
if (failed) process.exit(1);
