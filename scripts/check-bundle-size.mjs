/*
 * What a consumer downloads to start editing, per profile, and how far that is from its budget.
 *
 * **It measures the eager closure, not the entry.** `media/webview.js` is 232 KB gzipped and the
 * closure it pulls statically is 407 KB, because esbuild splits shared code into chunks under
 * `media/editor/` and the entry imports several of them with plain `import` statements. A browser
 * fetches every one of those before the editor runs. Reading the entry's own size is therefore an
 * understatement of 175 KB, and it is the number the budgets were first written against.
 *
 * Lazily loaded code is excluded, and "lazy" means reached only through `import(...)`. The language
 * grammars are: there are over a hundred of them under `media/editor/` and the entry names each in a
 * dynamic import, which is why 1.7 MB of chunks costs a reader nothing until they open a fenced block
 * in that language.
 *
 * Gzipped separately per file rather than over the concatenation, because that is what a server does
 * and therefore what a consumer pays. Summing separate gzips is slightly larger than gzipping the
 * whole, and the larger number is the honest one here.
 *
 *   node scripts/check-bundle-size.mjs            measure and compare against the committed sizes
 *   node scripts/check-bundle-size.mjs --accept    write what it measured as the new committed sizes
 *   node scripts/check-bundle-size.mjs --floors    build and measure the layers under the editor
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { eagerOutputs, bytesByPackage } from './eager-closure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(REPO, 'scripts', 'bundle-size.json');

/** The budgets, decided 2026-10-01, in gzipped bytes a consumer downloads for that profile. */
const BUDGETS = { document: 250 * 1024, notes: 90 * 1024, field: 60 * 1024 };

/*
 * Whether the number about to be committed describes a commit.
 *
 * The issue behind this file asks for the measurement to run on a clean export rather than on the
 * shared checkout. This is not that, and the difference is worth stating rather than glossing: a
 * clean export would also need an install, which is minutes, and a gate that takes minutes is a gate
 * somebody turns off. What it does instead closes the hole the request is about. A plain run measures
 * whatever is built, which is what you want while working on a change. `--accept` writes a number
 * into the repository, so that run refuses when anything the bundle is built from is uncommitted.
 *
 * The files that decide the bundle, and nothing else: a change to a test or a document cannot move
 * these numbers, and refusing over one would teach people to pass a flag.
 */
const BUNDLE_INPUTS = ['src', 'package.json', 'package-lock.json', 'esbuild.mjs'];

function uncommittedInputs() {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', ...BUNDLE_INPUTS], { cwd: REPO, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    // Not a git checkout, which is what a clean export looks like. Nothing to refuse.
    return [];
  }
}

/**
 * Whether the built entry is older than something it is built from.
 *
 * A real build is a real number about the wrong tree, which reads exactly like a real number about
 * this one. The gate runs straight after `Build` so it cannot happen there; a hand run can, and this
 * says so rather than letting the reader assume.
 */
function staleAgainst(entry) {
  let newest = 0;
  let newestPath = '';
  // The same inputs the uncommitted check uses, rather than `src/` alone: a change to the build
  // script or to the lockfile makes a build just as stale as a change to a module, and checking one
  // of the four while naming four is the kind of near-miss nobody notices until it matters.
  const walk = (path) => {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return;
    if (!st.isDirectory()) {
      if (st.mtimeMs > newest) {
        newest = st.mtimeMs;
        newestPath = path;
      }
      return;
    }
    for (const e of readdirSync(path, { withFileTypes: true })) walk(join(path, e.name));
  };
  for (const input of BUNDLE_INPUTS) walk(join(REPO, input));
  return newest > statSync(entry).mtimeMs ? { at: newest, path: newestPath.slice(REPO.length + 1) } : null;
}

/**
 * Static imports only: `import ... from "x"`, `export ... from "x"` and bare `import "x"`.
 *
 * A dynamic `import("x")` is deliberately not matched, and that is the whole distinction this file
 * rests on. The pattern requires the keyword at a statement boundary so `import(` inside an
 * expression cannot match it.
 */
function staticImports(src) {
  const out = [];
  const re = /(?:^|[;\n])\s*(?:import|export)\b[^;\n(]*?from\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1] ?? m[2]);
  return out.filter(Boolean);
}

/** Every file a browser fetches before the entry's own code runs, the entry included. */
function eagerClosure(entry) {
  const seen = new Set();
  const walk = (file) => {
    const abs = normalize(file);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    for (const spec of staticImports(readFileSync(abs, 'utf8'))) {
      if (spec.startsWith('.')) walk(join(dirname(abs), spec));
    }
  };
  walk(entry);
  return [...seen].sort();
}

const sizeOf = (files) => {
  let raw = 0;
  let gz = 0;
  for (const f of files) {
    const bytes = readFileSync(f);
    raw += bytes.length;
    gz += gzipSync(bytes, { level: 9 }).length;
  }
  return { files: files.length, raw, gz };
};

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/*
 * The floors: what each layer under the editor costs on its own.
 *
 * Built from the entries in `scripts/size-floors/`, which exist only to be measured. A budget argued
 * from the editor's own size cannot say whether the budget is reachable, because it cannot say how
 * much of that size is CodeMirror, how much is the Markdown language layer and how much is Sheaf's.
 *
 * Not run by `npm test`: it builds five bundles, which is seconds rather than milliseconds, and the
 * numbers move only when a dependency does.
 */
if (process.argv.includes('--floors')) {
  const dir = join(REPO, 'scripts', 'size-floors');
  const out = mkdtempSync(join(tmpdir(), 'sheaf-floors-'));
  const esbuild = join(REPO, 'node_modules', '.bin', 'esbuild');
  console.log('What each layer under the editor costs, gzipped, measured on its own:\n');
  try {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
      const built = join(out, file.replace(/\.ts$/, '.js'));
      execFileSync(esbuild, [join(dir, file), '--bundle', '--minify', '--format=esm', '--platform=browser', '--target=es2020', `--outfile=${built}`, '--log-level=error']);
      const size = sizeOf([built]);
      console.log(`  ${kb(size.gz).padStart(7)} gz, ${kb(size.raw).padStart(8)} raw   ${file.replace(/^floor-|\.ts$/g, '')}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  console.log('\nThe budgets to compare these against are in the table at the top of this file.');
  process.exit(0);
}

/*
 * `document` is the editor as it ships, measured from the built entry. The other two profiles have
 * no entry point yet, which the issue behind this file says to expect: until they exist there is
 * nothing to measure, and inventing a number for them would be worse than an absence.
 */
const PROFILES = [{ name: 'document', entry: join(REPO, 'media', 'webview.js') }];

const measured = {};
const rows = [];
for (const { name, entry } of PROFILES) {
  if (!existsSync(entry)) {
    console.log(`${name}: ${entry} is not built, so there is nothing to measure. Run npm run build first.`);
    process.exit(1);
  }
  const closure = eagerClosure(entry);
  const size = sizeOf(closure);
  measured[name] = { raw: size.raw, gz: size.gz };
  rows.push({ name, ...size, budget: BUDGETS[name], closure });
}

/*
 * Whose bytes are in the eager closure, read out of the build's own metafile.
 *
 * The bytes alone say the closure is 407 KB and nothing about what is in it, and the question that
 * decides whether a budget is reachable is which libraries a reader pays for before typing.
 *
 * The walk itself is `scripts/eager-closure.mjs`, shared with the band check in the host suite, which
 * reads a metafile it builds in memory because the suites run before anything is built. Two sources
 * for the metafile are forced by that ordering; two walks over it would not be.
 */
const METAFILE = join(REPO, '.claude', 'scratch', 'webview-metafile.json');

/*
 * Packages that must put nothing in the eager closure.
 *
 * This is the assertion the issue behind this file calls more important than the bytes: bytes drift
 * slowly and an import is a yes or no, so it fails on the day somebody writes it rather than when
 * somebody next measures. No tolerance, and it is not a ratchet.
 *
 * Mermaid is the first: it is 6.5 MB, it is reached only through `await import`, and a static import
 * of it would be the largest single regression available in this repository.
 *
 * The other four are the languages a Markdown editor has no reason to parse before it draws
 * anything. They were all eager until 2026-10-02, 139 KB of them, because `@codemirror/lang-markdown`
 * imports `@codemirror/lang-html` for the HTML a Markdown document may hold, and that brings CSS and
 * JavaScript with it. `src/webview/noEmbeddedHtml.ts` says what was done about it; this is the line
 * that notices if it comes undone. `@lezer/html` and `@lezer/css` are left out on purpose: they are
 * reached through their `@codemirror/lang-*` package, so naming that one is enough, and a list that
 * repeats itself invites a reader to think the shorter entries are the weaker ones.
 */
const FORBIDDEN_EAGER = ['mermaid', '@codemirror/lang-html', '@codemirror/lang-css', '@codemirror/lang-javascript', '@lezer/javascript'];

let packageProblems = [];
const packageReport = [];
if (existsSync(METAFILE)) {
  const metafile = JSON.parse(readFileSync(METAFILE, 'utf8'));
  const outputs = eagerOutputs(metafile, 'media/webview.js');
  const bytes = bytesByPackage(metafile, outputs);

  /*
   * Two methods, compared. The regex walk above reads the built files; this reads the bundler's own
   * record. They answer the same question, so a disagreement means one of them is wrong and the
   * numbers printed by this file cannot be trusted until somebody says which. Cheap, and it is the
   * only thing here that would catch the regex quietly missing an import form.
   */
  const fromRegex = new Set(eagerClosure(join(REPO, 'media', 'webview.js')).map((f) => f.slice(REPO.length + 1)));
  const onlyRegex = [...fromRegex].filter((f) => !outputs.has(f));
  const onlyMeta = [...outputs].filter((f) => !fromRegex.has(f));
  if (onlyRegex.length || onlyMeta.length) {
    packageProblems.push(
      'the two ways of finding the eager closure disagree, so neither number here is trustworthy:' +
        (onlyRegex.length ? `\n  only the regex walk found: ${onlyRegex.join(', ')}` : '') +
        (onlyMeta.length ? `\n  only the metafile found: ${onlyMeta.join(', ')}` : '')
    );
  }

  const rowsByBytes = Object.entries(bytes).sort((a, b) => b[1] - a[1]);
  const total = rowsByBytes.reduce((n, [, b]) => n + b, 0);
  packageReport.push(`\nWhose bytes those are, before gzip, over ${outputs.size} output(s), ${kb(total)} in all:\n`);
  for (const [pkg, b] of rowsByBytes) {
    if (b >= 4 * 1024) packageReport.push(`  ${kb(b).padStart(7)}  ${pkg}`);
  }
  const small = rowsByBytes.filter(([, b]) => b < 4 * 1024);
  if (small.length) packageReport.push(`  ${'under 4 KB each'.padStart(7)}  ${small.map(([p]) => p).join(', ')}`);

  for (const pkg of FORBIDDEN_EAGER) {
    if (bytes[pkg]) packageProblems.push(`${pkg} is in the eager closure, ${kb(bytes[pkg])} of it, and must be reached only through a dynamic import`);
  }
} else {
  /*
   * Said out loud rather than skipped. `npm run build` writes the metafile on every build, watch
   * included, so its absence means the last build predates that and the table below is the only
   * thing this run can report. A check that goes quiet when it cannot see its subject reads as a
   * pass, which is the failure this repository has already had once.
   */
  packageProblems.push(
    `${METAFILE.slice(REPO.length + 1)} is not there, so nothing checked which libraries are in the eager closure. Run npm run build`
  );
}

const committed = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};

/*
 * Read before anything is reported or written, because a stale build is a real number about the wrong
 * tree and that reads exactly like a real number about this one. On a plain run it is a note; on
 * `--accept` it is a refusal, since the number is about to be committed.
 */
const stale = staleAgainst(join(REPO, 'media', 'webview.js'));

if (process.argv.includes('--accept')) {
  // A number committed beside a closure holding something forbidden records the wrong thing as
  // normal, and the next reader has nothing saying it was wrong when it was written.
  if (packageProblems.length) {
    console.log(`Refusing to commit a size while this is true:\n\n${packageProblems.join('\n')}.`);
    process.exit(1);
  }
  if (stale) {
    const when = new Date(stale.at).toISOString().slice(11, 19);
    console.log(`Refusing to commit a size measured from a stale build: ${stale.path} changed at ${when}, after the entry was built.`);
    console.log('Run npm run build first, so the number describes the tree it is committed beside.');
    process.exit(1);
  }
  const dirty = uncommittedInputs();
  if (dirty.length) {
    console.log('Refusing to commit a size measured from a tree with uncommitted work in it:\n');
    for (const line of dirty) console.log(`  ${line}`);
    console.log('\nCommit or revert these first. The number goes into the repository and has to describe a commit.');
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify(measured, null, 2) + '\n');
  console.log(
    `baseline written: ${Object.entries(measured)
      .map(([k, v]) => `${k} ${kb(v.raw)} raw, ${kb(v.gz)} gzipped here`)
      .join(', ')}`
  );
  process.exit(0);
}

if (stale) {
  const when = new Date(stale.at).toISOString().slice(11, 19);
  console.log(`Note: ${stale.path} changed at ${when}, after the entry was built. These numbers are about the last build.\n`);
}

console.log('What a consumer downloads to start editing, per profile:\n');
const grown = [];
for (const row of rows) {
  const was = committed[row.name];
  /*
   * The baseline held a bare gzipped number until 2026-10-02. Said out loud rather than read as
   * "nothing committed yet": a reader of `{raw, gz}` given a number would find `was.raw` undefined,
   * every comparison against it false, and a ratchet that passes whatever it is handed. That is the
   * failure this file exists to prevent, one level up.
   */
  if (typeof was === 'number') {
    console.log(
      `${row.name}: scripts/bundle-size.json holds a bare number, which is the old format. ` +
        'It recorded gzipped bytes, which differ between machines; the ratchet is on raw bytes now. ' +
        'Run with --accept in a clean tree to record both.'
    );
    process.exit(1);
  }
  const toBudget = row.gz - row.budget;
  console.log(
    `  ${row.name}: ${kb(row.gz)} gzipped over ${row.files} file(s), ${kb(row.raw)} raw` +
      `; budget ${kb(row.budget)}, ${toBudget > 0 ? `${kb(toBudget)} over` : `${kb(-toBudget)} under`}` +
      (was === undefined ? ' (nothing committed yet)' : `; committed ${kb(was.raw)} raw, ${kb(was.gz)} gzipped where it was measured`)
  );
  for (const f of row.closure) {
    const g = gzipSync(readFileSync(f), { level: 9 }).length;
    console.log(`      ${kb(g).padStart(7)}  ${f.slice(REPO.length + 1)}`);
  }
  /*
   * It ratchets rather than gates: being over budget is a fact to report on every run, and only
   * growth fails. Growing one deliberately means editing the committed number in the same commit,
   * which puts the increase in a diff somebody reads.
   */
  /*
   * **The ratchet is on the raw bytes, and the headline is the gzipped ones.** A gzipped size is not
   * a number two machines can compare: it is whatever the zlib they were built against produces, so
   * the same file measured here and on a runner gives two answers. Measured rather than assumed, on
   * one identical file: Node's zlib 1.2.12 says 160,088 bytes and the `gzip -9` beside it on the same
   * machine says 160,099, and CI's Node 22 on Linux read the whole closure 728 bytes larger than this
   * machine did while every raw byte count and the file list matched. That difference failed this
   * gate on twelve consecutive CI runs, and because `release:check` requires a green CI, it is what
   * stopped the release all day. What esbuild wrote is the same everywhere, so that is what a ratchet
   * can hold an implementation to.
   *
   * The gzipped number stays in the report, and in the baseline beside the raw one, because it is the
   * one a reader cares about: it is what a consumer downloads. It is just not the one to fail on.
   *
   * The delta in bytes as well as the rounded sizes, because the comparison is in bytes and the
   * display is in kilobytes. A change of a few hundred bytes printed "document grew from 331 KB to
   * 331 KB", which reads as a fault in this check rather than a real and small increase, and the first
   * thing a reader does with a sentence like that is distrust the number instead of the growth.
   */
  if (was !== undefined && row.raw > was.raw) {
    grown.push(`${row.name} grew by ${row.raw - was.raw} raw bytes, ${kb(was.raw)} to ${kb(row.raw)}`);
  }
}

if (packageProblems.length) {
  console.log(`\n${packageProblems.join('\n')}.`);
  process.exit(1);
}

for (const line of packageReport) console.log(line);

if (grown.length) {
  console.log(`\n${grown.join('; ')}.`);
  console.log('Explain the growth and run with --accept in the same commit, or take it back out.');
  process.exit(1);
}

console.log('\nNo profile grew beyond the size committed beside it, and nothing forbidden is loaded eagerly.');
