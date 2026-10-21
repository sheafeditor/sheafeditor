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
 *
 * ## The half of the promise this cannot check
 *
 * **Every assertion here asks whether an entry resolves. None asks whether the library stays inside
 * the entries**, and a path the map does not name still resolves perfectly well in this checkout,
 * because the repository's layout puts it where the code looks. `media/mermaid/` sits beside
 * `media/webview.css` and the diagram loader resolves its module against the page's stylesheet, so
 * every host here serves it by accident of layout while no entry reaches it. A probe rooted at the
 * checkout cannot see that and reports a working diagram.
 *
 * `scripts/check-consumer-assets.mjs` asks the other direction, in a tree built out of this map and
 * served from outside the checkout. Nothing here needs to change for it; this is so that a reader
 * of the package boundary knows where the second half is.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * **What the loop above does not establish, which is easy to read it as establishing.**
 *
 * `existsSync` answers a question about *this checkout*. The question a published package raises is
 * whether an entry resolves for a **consumer**, and the two differ here by almost everything: `lib/`
 * and `dist/` are gitignored, this manifest has no `files` field, so npm falls back to `.gitignore`
 * and an `npm pack` ships **neither**. Measured 2026-10-17 at `5885b05`: `main` and 7 of the 9
 * `exports` targets are absent from a tarball, which holds 485 files of `src/`, `scripts/` and
 * `docs/` instead. All three JavaScript entries also carry a `types` condition into `lib/types/`,
 * so the failing state is a compile error with no declaration as well as a missing runtime import:
 * two tools, two symptoms, one cause.
 *
 * **That is recorded rather than enforced, on purpose.** Nothing in this repository produces a
 * tarball — there is no `npm publish` in `scripts` or in `.github/workflows/`, publishing is `vsce`
 * and `ovsx`, and the library is consumed by a path link. A gate over an artefact nobody makes is a
 * check defending a plan. The day an npm distribution is real, the fix is `.npmignore` plus a
 * `prepack` (**not** `files`, which `vsce` refuses alongside `.vscodeignore`; see the guard below),
 * and the control is free because seven entries are already in the failing state.
 *
 * Said out loud because a reader of a green run from a script called `check-package` would
 * otherwise take it for package-surface coverage, which is the one thing it is not.
 */
notes.push(
  `Entry resolution above is checked in this checkout, not in a tarball: no npm tarball is produced ` +
    `by any path here, and an \`npm pack\` today would omit \`main\` and 7 of the ${targets.length} exports targets.`
);

/*
 * `private` keeps an accidental `npm publish` from putting that tarball on a public registry.
 *
 * **Measured before it was set, because this manifest is read by two tools with different rules and
 * the guard below exists because that bit once.** `npm run package` is unaffected: `vsce package`
 * exits 0 with `private: true` and produces the same 270 files at 2.72 MB.
 *
 * **That npm refuses is measured too, and the obvious instrument is blind to it.** `npm publish
 * --dry-run` does **not** enforce `private` in npm 11.19.0: a throwaway package holding nothing but
 * a name, a version and `private: true` still prints "Publishing to https://registry.npmjs.org/".
 * So a dry run saying it would publish is evidence of nothing either way, and the plain command
 * stops at `ENEEDAUTH` before the check is reached.
 *
 * What settles it is a token for a registry that cannot answer, which is safe because nothing can be
 * published to a dead port, run in a throwaway directory:
 *
 *   npm publish --registry=http://127.0.0.1:1 --//127.0.0.1:1/:_authToken=x
 *
 *   without `private`   ECONNREFUSED   npm reached the network
 *   with    `private`   EPRIVATE       "This package has been marked as private"
 *
 * The pair is the point: the refusal fires **ahead of** the network rather than instead of a failure
 * that would have happened anyway.
 *
 * It comes out in one edit the day a distribution is decided. It is here because that decision is
 * reversible and a published version number is not: unpublish is restricted after 72 hours and the
 * number stays burned, and what would be published today is the tarball described above.
 */
if (pkg.private !== true) {
  problems.push(
    '`private` is not true. Nothing here publishes to npm, and an accidental `npm publish` would put a tarball holding no `lib/` and no `dist/` on a public registry under a version number that cannot be reclaimed. Remove this guard deliberately when an npm distribution is decided.'
  );
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
 * Which module format Node reads each half of the package as.
 *
 * The root manifest must carry no `"type": "module"`: `main` is loaded by VS Code's extension host
 * with `require`, and `dist/serve.js` is CommonJS too, so that one line stops the extension loading.
 * It is also exactly what Node's warning tells a person to add when it reparses `lib/index.js`, so
 * the guard is here for the next person who takes the warning's advice.
 *
 * The build writes `lib/package.json` with `type: module` instead, and `lib/types/package.json` with
 * `type: commonjs`, so the declarations keep the format their extensionless relative imports need.
 * Both are read from disk, and then the three entries are imported by name in a child Node, which is
 * the assertion that matters: the warning is either printed or it is not.
 */
if (pkg.type !== undefined && pkg.type !== 'commonjs') {
  problems.push(
    `package.json has \`"type": ${JSON.stringify(pkg.type)}\`. \`main\` is CommonJS loaded by VS Code's extension host, and dist/serve.js is CommonJS, so neither would load. The library's ES modules are declared by lib/package.json, which the build writes.`
  );
}
const SCOPES = { 'lib/package.json': 'module', 'lib/types/package.json': 'commonjs' };
for (const [file, want] of Object.entries(SCOPES)) {
  const path = join(REPO, file);
  const got = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).type : undefined;
  if (got !== want) problems.push(`${file} declares type ${got === undefined ? '(nothing)' : JSON.stringify(got)}, and the build writes ${JSON.stringify(want)}`);
}
{
  const entries = ['sheafeditor', 'sheafeditor/editor', 'sheafeditor/render'];
  const script = entries.map((e) => `await import(${JSON.stringify(e)});`).join(' ');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, encoding: 'utf8' });
  const typeless = [...(r.stderr ?? '').matchAll(/Module type of (\S+) is not specified/g)].map((m) => m[1].replace(`${pathToFileURL(REPO).href}/`, ''));
  if (r.status !== 0) problems.push(`importing ${entries.join(', ')} in Node exited ${r.status}:\n${r.stderr.trim()}`);
  else if (typeless.length) problems.push(`Node reparses ${typeless.join(', ')} as ES modules and warns on every import, because nothing declares their type`);
  else notes.push(`Node imports ${entries.length} entries by name with no module-type warning.`);
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

/*
 * Every relative `url()` the two stylesheets reach names a file that is there.
 *
 * A consumer imports these stylesheets into their own build, and their bundler resolves every
 * `url()` in them and in what they `@import`. A reference to a missing file is a warning per
 * reference on that build, whether or not a browser would ever follow it: KaTeX's stylesheet names
 * a WOFF and a TrueType copy after each WOFF2 font, the build copies only the WOFF2, and that was
 * 40 warnings on a consumer's first build of the package. Followed through `@import`, because the
 * fonts are named by `katex.css` and not by `webview.css` itself.
 */
{
  const missing = [];
  let followed = 0;
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const ref = m[1].split('?')[0].split('#')[0];
      if (!ref || /^(?:[a-z]+:|\/|#)/i.test(ref)) continue;
      followed += 1;
      const target = join(dirname(file), ref);
      if (!existsSync(target)) missing.push(`${file.slice(REPO.length + 1)} names ${ref}`);
      else if (ref.endsWith('.css')) walk(target);
    }
  };
  walk(webviewCss);
  walk(themeCss);
  if (missing.length) {
    problems.push(
      `${missing.length} relative url() reference(s) in the stylesheets name a file that is not there, which is a warning each on a consumer's build: ${missing.slice(0, 3).join('; ')}${missing.length > 3 ? '; …' : ''}`
    );
  } else {
    notes.push(`The stylesheets name ${followed} relative url() reference(s) across ${seen.size} file(s), and every one is on disk.`);
  }
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

/*
 * Every file in `lib/chunks/` is reached from an entry.
 *
 * The `exports` map serves `./chunks/*`, so anything the build leaves there is part of what the
 * package serves, and the map's comment calls that pattern a complete list of what the package can
 * serve. A chunk no entry imports is a file the package serves for no reason: esbuild wrote a 131 kB
 * table-widget chunk there for an `import()` whose importer tree shaking had removed, and nothing
 * above noticed, because every assertion above starts from an entry and walks forward.
 *
 * Read from the files rather than the metafile, because the files are what a consumer is served and
 * the build prunes them after the metafile is written. Static imports, re-exports and `import()`
 * all count: KaTeX and the emoji table are reached only by `import()`, and a walk over static
 * imports alone would report them as orphans.
 */
{
  const LIB = join(REPO, 'lib');
  const CHUNKS = join(LIB, 'chunks');
  const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.{1,2}\/[^"']+)["']/g;
  const reached = new Set();
  const unresolved = [];
  const queue = ['index.js', 'editor.js', 'render.js'].map((f) => join(LIB, f)).filter((f) => existsSync(f));
  while (queue.length) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const target = join(dirname(file), m[1]);
      if (existsSync(target)) queue.push(target);
      else unresolved.push(`${file.slice(REPO.length + 1)} imports ${m[1]}`);
    }
  }
  const chunks = existsSync(CHUNKS) ? readdirSync(CHUNKS).filter((f) => f.endsWith('.js')).map((f) => join(CHUNKS, f)) : [];
  const orphans = chunks.filter((f) => !reached.has(f)).map((f) => f.slice(REPO.length + 1));
  if (unresolved.length) problems.push(`${unresolved.length} relative import(s) in lib/ name a file the build did not write: ${unresolved.join('; ')}`);
  if (orphans.length) {
    problems.push(
      `${orphans.length} file(s) in lib/chunks/ are imported by no entry, and the exports map serves them all the same: ${orphans.join(', ')}`
    );
  } else {
    notes.push(`Every one of the ${chunks.length} chunks in lib/chunks/ is reached from an entry, by static or dynamic import.`);
  }
}

for (const n of notes) console.log(n);
if (problems.length) {
  console.error(`\n${problems.length} problem(s) with the package boundary:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `\nThe exports map names ${EXPECTED.length} entries, every one resolves **in this checkout**, and the main entry carries no editor.` +
    `\nWhat a consumer receives from a tarball is a different question and this script does not answer it; see the note above.`
);
