/*
 * The package boundary, asserted over the artefact the build just wrote.
 *
 *   node scripts/check-package.mjs
 *
 * Every assertion here is a yes-or-no question about a file on disk, which is what makes this
 * checkable at all: "the library builds correctly" is not a check, and "the `exports` map names
 * these five entries and every one of them resolves" is.
 *
 * It runs after the build, for the reason `check-bundle-size.mjs` does: it reads what a consumer is
 * served. Reading a stale `lib/` would be worse than reading nothing, because the numbers would be
 * real and about a tree nobody has.
 *
 * ## The one assertion that is not about a file existing
 *
 * `@codemirror/view` must not reach `lib/index.js`'s eager closure. That is the claim the whole
 * arrangement rests on — a mounted surface draws its Markdown and becomes an editor on first focus
 * — and it is invisible on the page: a rendered surface and an editor that happens to look rendered
 * are the same picture. `splitting: false` in the library build, or one static import added to
 * `src/lib/index.ts`, would put CodeMirror in the entry and nothing anybody could see would change.
 *
 * Read off the metafile's `imports[].kind` rather than by searching the output text, for the reason
 * `scripts/eager-closure.mjs` sets out at length: a `dynamic-import` costs nothing until something
 * asks for it, and a name in a bundle says a library was mentioned.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesByPackage, eagerOutputs } from './eager-closure.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];
const notes = [];

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));

/*
 * What the map must name, and nothing else.
 *
 * A closed list rather than a minimum, because the cost of `exports` is in the refusal: once a path
 * resolves for a consumer it is public whether or not anybody meant it to be, so a map that grows
 * without a line in a diff is a promise nobody made.
 */
const EXPECTED = ['.', './editor', './render', './chunks/*', './webview.css', './browser-theme.css'];

const exports_ = pkg.exports;
if (!exports_ || typeof exports_ !== 'object') {
  problems.push('package.json has no `exports` map, so nothing in this package is importable by name');
} else {
  const named = Object.keys(exports_);
  for (const want of EXPECTED) if (!named.includes(want)) problems.push(`the \`exports\` map does not name ${want}`);
  for (const got of named) {
    if (!EXPECTED.includes(got)) {
      problems.push(`the \`exports\` map names ${got}, which is not in this check's list. An entry is a promise: add it here with a reason, or take it out`);
    }
  }
}

/** Every file path an entry resolves to, with the entry that named it. */
const targets = [];
for (const [name, value] of Object.entries(exports_ ?? {})) {
  if (typeof value === 'string') targets.push({ name, condition: null, path: value });
  else for (const [condition, path] of Object.entries(value)) targets.push({ name, condition, path });
}

for (const { name, condition, path } of targets) {
  const where = condition ? `${name} (${condition})` : name;
  if (!path.startsWith('./')) {
    problems.push(`${where} points at ${path}, which is not a relative path inside the package`);
    continue;
  }
  if (path.includes('*')) {
    /*
     * A pattern resolves to a directory rather than a file, so what is asserted is that the
     * directory exists and holds something. An empty chunk directory means the build stopped
     * splitting, which is the failure mode worth catching here.
     */
    const dir = join(REPO, dirname(path.replace('*', 'x')));
    if (!existsSync(dir)) problems.push(`${where} is a pattern over ${dir}, which does not exist`);
    else if (readdirSync(dir).length === 0) problems.push(`${where} is a pattern over ${dir}, which is empty`);
    continue;
  }
  if (!existsSync(join(REPO, path))) problems.push(`${where} points at ${path}, which the build did not write`);
}

/*
 * No `files` property, and this one is not a style preference: `vsce` **exits 1** when a manifest
 * carries both a `.vscodeignore` and a non-empty `files`, with "VSCE does not support combining
 * both strategies". This repository has had a `.vscodeignore` since before it was published, so
 * adding `files` to describe the library breaks `npm run package`, which is the release path, and
 * breaks it nowhere the gates look: no gate packages.
 *
 * It was added here and then taken out for that reason. The only thing `files` would buy is a
 * narrower npm tarball, and this package is consumed by a path link, where npm never reads it.
 */
if (Array.isArray(pkg.files) && pkg.files.length && existsSync(join(REPO, '.vscodeignore'))) {
  problems.push(
    'package.json has a `files` property and the repository has a .vscodeignore. vsce refuses that combination and exits 1, so `npm run package` and the release would both fail. Describe what ships in .vscodeignore.'
  );
}

/*
 * `lib/` is excluded from the `.vsix`, which nothing else can tell you.
 *
 * It is gitignored, and `vsce` does not read `.gitignore`; the host suite's top-level path check
 * reads git, so a built directory is invisible to it in both directions. The first `.vsix` built
 * after this directory existed carried 3 MB of library bundles that VS Code never loads.
 *
 * A string in `.vscodeignore` is a proxy for "it is not in the package", and the real assertion is
 * `vsce ls`, which costs a build and a package. The proxy catches the regression that matters:
 * somebody reorganising that file and dropping the line.
 */
const vscodeignore = existsSync(join(REPO, '.vscodeignore')) ? readFileSync(join(REPO, '.vscodeignore'), 'utf8') : '';
for (const pattern of ['lib/**', '.claude-role']) {
  if (!vscodeignore.split('\n').some((l) => l.trim() === pattern)) {
    problems.push(`.vscodeignore does not exclude ${pattern}, so it ships in the .vsix. vsce reads this file and not .gitignore.`);
  }
}

/* R3: the extension host entry is VS Code's and a consumer must never reach it. */
if (pkg.main !== './dist/extension.js') problems.push(`\`main\` is ${pkg.main}; the extension host entry is ./dist/extension.js and must stay`);
for (const { name, path } of targets) {
  if (path.includes('dist/extension')) problems.push(`${name} points into the extension host bundle, which a consumer must never import`);
}

/* R2: a declaration per entry, written by the build rather than by hand. */
const DECLARED = { '.': ['mount', 'MountOptions', 'SheafSurface'], './editor': ['createSurfaceEditor'], './render': ['renderMarkdown'] };
for (const [entry, names] of Object.entries(DECLARED)) {
  const types = exports_?.[entry]?.types;
  if (!types) {
    problems.push(`${entry} has no \`types\` condition, so a consumer's type checker learns nothing from it`);
    continue;
  }
  const file = join(REPO, types);
  if (!existsSync(file)) continue; // Already reported above.
  const text = readFileSync(file, 'utf8');
  for (const n of names) {
    if (!new RegExp(`\\b${n}\\b`).test(text)) problems.push(`${types} does not declare ${n}, which ${entry} is supposed to export`);
  }
}

/*
 * R7: both stylesheets, and the one a consumer outside VS Code cannot skip.
 *
 * The count is in the output rather than in a comment, because the number is the argument: a
 * stylesheet written against variables somebody else supplies is not a theme, it is a dependency,
 * and it is the only one in this package that no exports map, dependency graph or type declaration
 * can see.
 */
const webviewCss = join(REPO, 'media', 'webview.css');
const themeCss = join(REPO, 'media', 'browser-theme.css');
if (!existsSync(webviewCss)) problems.push('media/webview.css is missing');
if (!existsSync(themeCss)) problems.push('media/browser-theme.css is missing');
if (existsSync(webviewCss) && existsSync(themeCss)) {
  const used = new Set([...readFileSync(webviewCss, 'utf8').matchAll(/var\(\s*(--vscode-[a-zA-Z0-9-]+)/g)].map((m) => m[1]));
  const defined = new Set([...readFileSync(themeCss, 'utf8').matchAll(/^\s*(--vscode-[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1]));
  /*
   * Three counts rather than two, because two of them are not the same kind of thing.
   *
   * "The shim defines 47" and "47 of the 54" are different sentences and the first draft of this
   * line printed the first while saying the second, which makes 54 − 47 = 7 look like the gap when
   * the gap is 12: five of the shim's definitions are for variables this stylesheet never reads.
   */
  const missing = [...used].filter((v) => !defined.has(v));
  const covered = used.size - missing.length;
  notes.push(
    `webview.css reads ${used.size} distinct --vscode-* variables. browser-theme.css defines ${defined.size} variables, ` +
      `${covered} of which are among those ${used.size}, leaving ${missing.length} of them on their fallbacks.`
  );
}

const readme = join(REPO, 'src', 'lib', 'README.md');
if (!existsSync(readme)) {
  problems.push('src/lib/README.md is missing: a consumer has the entries and no instructions');
} else {
  const text = readFileSync(readme, 'utf8');
  for (const needed of ['webview.css', 'browser-theme.css']) {
    if (!text.includes(needed)) problems.push(`src/lib/README.md does not name ${needed}, which a consumer has to load`);
  }
}

/*
 * The eager closure of the main entry.
 *
 * The forbidden set is the editor and nothing else. `@lezer/markdown` and `@lezer/common` are the
 * parser the render path is built on and belong here; `@codemirror/state` would arrive only with
 * the view, so it is listed too and its presence would mean the same thing.
 */
const METAFILE = join(REPO, '.claude', 'scratch', 'lib-metafile.json');
const FORBIDDEN = ['@codemirror/view', '@codemirror/state', '@codemirror/commands', '@codemirror/lang-markdown', '@codemirror/language-data'];
if (!existsSync(METAFILE)) {
  problems.push(`${METAFILE} is missing, so the entry's eager closure cannot be read. Run the build first.`);
} else {
  const metafile = JSON.parse(readFileSync(METAFILE, 'utf8'));
  const entry = 'lib/index.js';
  const eager = eagerOutputs(metafile, entry);
  const bytes = bytesByPackage(metafile, eager);
  for (const pkgName of FORBIDDEN) {
    if (bytes[pkgName]) problems.push(`${entry} loads ${bytes[pkgName]} bytes of ${pkgName} before anything is focused, so a mounted surface is already an editor`);
  }
  const total = [...eager].reduce((n, f) => n + metafile.outputs[f].bytes, 0);
  notes.push(`${entry} eager closure: ${eager.size} file(s), ${total} bytes raw, from ${Object.keys(bytes).sort().join(', ')}.`);
  const editorEager = eagerOutputs(metafile, 'lib/editor.js');
  const editorBytes = bytesByPackage(metafile, editorEager);
  if (editorBytes['@codemirror/language-data']) {
    problems.push('lib/editor.js loads @codemirror/language-data eagerly, which is the registry of every fenced-code grammar');
  }
  notes.push(`lib/editor.js eager closure: ${editorEager.size} file(s), ${[...editorEager].reduce((n, f) => n + metafile.outputs[f].bytes, 0)} bytes raw.`);
}

for (const n of notes) console.log(n);
if (problems.length) {
  console.error(`\n${problems.length} problem(s) with the package boundary:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\nThe exports map names ${EXPECTED.length} entries, every one resolves, and the main entry carries no editor.`);
