/*
 * What a consumer has to serve, measured in a tree built out of the `exports` map and nothing else.
 *
 *   node scripts/check-consumer-assets.mjs
 *
 * `check-package.mjs` asserts that every entry in the map resolves to a file. This asks the
 * question from the other side, which no check here was asking: **does the library ever request a
 * file of its own that the map does not name?** Those are different questions, and the second one
 * is the one a consumer meets. A path can be absent from the map and still resolve perfectly well
 * in this checkout, because the repository's own layout puts it where the code looks.
 *
 * The diagram loader is the case that produced this check. `src/webview/mermaid.ts` resolves
 * `mermaid/mermaid.esm.min.mjs` against the address of the page's `webview.css`, and `media/` holds
 * `mermaid/` right beside that stylesheet, so every host in this repository serves it by accident of
 * layout. The map names no path that reaches `media/mermaid/`. **A probe rooted at the checkout
 * cannot see that**, and the probe that first looked at this was rooted at the checkout and reported
 * a working diagram, which is the reading this check exists to make impossible.
 *
 * ## The tree is derived, which is the whole design
 *
 * Nothing here holds a list of assets. The served tree is built by resolving the `exports` map, and
 * the server 404s everything else, so any file the library asks for that the map does not name
 * **names itself** in the output. A construct added to a profile next year, needing an asset nobody
 * has thought about, fails this check without anybody editing it. A list beside the check would
 * instead have to be remembered, which is the same as not having one.
 *
 * Two roots, because a consumer's bundler does not reproduce this repository's directory names:
 *
 *   /vendor/sheaf/   the three code entries and `chunks/`, which import each other relatively
 *   /assets/         the two stylesheets, where a CSS pipeline would put them
 *
 * `media/` does not exist in that tree, which is the point: it is the directory this repository
 * happens to serve and the map does not name.
 *
 * **The stylesheet keeps its filename**, and that is deliberate rather than careless. The locator
 * finds the media folder by looking for a `<link>` whose href contains `webview.css`, and a bundler
 * that hashed the name would break it for an entirely separate reason, which is its own issue. If
 * this tree hashed the name, a failure here could be either fault and the output could not say
 * which. Keeping the name working leaves exactly one variable: whether the map names what the
 * library fetches.
 *
 * ## What is a finding and what is only reported
 *
 * A 404 under one of the two package roots is a finding: the library asked for a file of its own
 * and the map had nowhere to serve it from. A request anywhere else is the *document's* — a picture
 * a `.md` file references lives in the consumer's content, not in this package — so it is counted
 * and printed and fails nothing. Without that split, a profile that one day draws images would
 * report its document's own pictures as a packaging fault.
 *
 * ## The documents are the repository's own, found rather than written
 *
 * The corpus under `sample/` is scanned for the fences and the delimiters that reach a runtime
 * asset, so the subjects are real documents and the set grows with the corpus. `test/prose/
 * surfaceProfiles.ts` covers the same constructs far more thoroughly under jsdom, and it replaces
 * the loader with a stub to do it (`setMermaidLoader`), which is correct there and is also why that
 * suite can never see a fetch. **This is the only check that watches the real network**, which is
 * what the question needs: the failure being looked for is a request going somewhere nothing is
 * served from, and a stubbed loader makes no request at all.
 *
 * ## What this asserts, and the narrower thing it does not
 *
 * **It asserts that nothing outside the map is needed or fetched. It does not assert that a profile
 * refuses to draw a diagram.** Those are two claims and only the first is measured here: a surface
 * that drew a diagram from a file the tree happened to serve would pass. Which constructs a profile
 * draws is the prose suite's subject, in `test/prose/surfaceProfiles.ts`, and a green run of this
 * check should never be read as covering it.
 *
 * ## Why this is the only thing standing behind the decision not to name the module
 *
 * The map names no mermaid path, and that is right *because* no profile draws a diagram. Those two
 * facts hold each other up, so neither is safe to change alone, and a later reader should not read
 * this check as redundant with `Package` and delete it.
 *
 * `Diagram` has no row in `src/dialect/profileConstructs.ts`, and a construct with no row is
 * carried by no profile. The specification's table gives diagrams to `document` alone, so somebody
 * completing that table faithfully writes `Diagram: DOCUMENT`, which changes nothing here: the
 * library offers `field` and `notes`. **What this check is for is the other edit** — a diagram given
 * to a library profile, deliberately or by mis-transcribing the row — because that makes the loader
 * reachable through `mount` and a consumer gets a module request with nowhere to answer it. That
 * edit is exactly the lever this check's control pulls, and nothing else in the gates notices it.
 *
 * Needs Chromium and `playwright-core`; says so and exits 0 without them, as the other
 * browser-driven checks do. **That is the protocol `scripts/gates.mjs` reads rather than a silent
 * pass**: it treats a skipped gate as a failure unless the gate is named in
 * `SHEAF_ALLOW_SKIPPED_GATES`, because "a skipped gate is not a passed gate".
 */
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

const CHROME = [
  process.env.SHEAF_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));

function skip(why) {
  console.log(`skipped: ${why}`);
  process.exit(0);
}

if (!CHROME) skip('no Chrome or Chromium found; set SHEAF_CHROME to one');

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'));
} catch {
  skip('playwright-core is not installed; set PLAYWRIGHT_CORE to its folder');
}

/*
 * A stale `lib/` would be measured as though it were the one a consumer gets, and a control run
 * against one passes while reading bytes from before the edit under test. `serve-for-check.mjs`
 * refuses for the same reason and says more about why. Modification times rather than content, so a
 * branch switch that leaves a file byte-identical still asks for a build; rebuilding is the answer
 * either way and costs seconds.
 */
const BUILT = join(REPO, 'lib', 'index.js');
if (!existsSync(BUILT)) {
  console.log('lib/index.js is not built, so there is no library for a consumer to resolve. Run npm run build.');
  process.exit(1);
}
const builtAt = statSync(BUILT).mtimeMs;
/*
 * Code only, which `src/lib/` makes necessary: the consumer instructions live in a `README.md`
 * beside the modules, and a directory walk counts editing them as the bundle being out of date. The
 * refusal is worth having and asking for a rebuild after a documentation edit is not.
 */
const COMPILED = ['.ts', '.tsx', '.js', '.mjs', '.json'];
const newer = [join(REPO, 'src', 'lib'), join(REPO, 'src', 'render'), join(REPO, 'src', 'webview'), join(REPO, 'src', 'dialect')]
  .flatMap((dir) => {
    try {
      return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && COMPILED.some((ext) => e.name.endsWith(ext)))
        .map((e) => join(e.parentPath ?? e.path, e.name));
    } catch {
      return [];
    }
  })
  .filter((f) => statSync(f).mtimeMs > builtAt);
if (newer.length) {
  console.log(
    `lib/index.js is older than ${newer.length} of the sources it is built from, ` +
      `${newer.slice(0, 3).map((f) => f.slice(REPO.length + 1)).join(', ')}${newer.length > 3 ? ' and others' : ''}. ` +
      'Run npm run build.'
  );
  process.exit(1);
}

// ---- The consumer's tree, resolved out of the exports map -------------------

/** Where a consumer's build puts each kind of entry. Neither is a directory name this repository has. */
const CODE_ROOT = '/vendor/sheaf';
const CSS_ROOT = '/assets';
/** Where the consumer's own content is served from, which is not the package's and is judged separately. */
const CONTENT_ROOT = '/content';

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const exports_ = pkg.exports;
if (!exports_ || typeof exports_ !== 'object') {
  console.log('package.json has no `exports` map, so there is no consumer surface to build a tree from.');
  process.exit(1);
}

const served = mkdtempSync(join(tmpdir(), 'sheaf-consumer-'));
/*
 * Taken down on every exit, including the ones nobody wrote: a throw out of a case leaves the
 * explicit cleanup below unreached, and this check copies the whole chunk directory and the KaTeX
 * fonts into the tree each run. Measured during development, a crash in the page's module graph left
 * both a tree and a Chromium behind.
 */
process.on('exit', () => {
  try {
    rmSync(served, { recursive: true, force: true });
  } catch {
    /* the run is already over; a leftover temporary directory is not worth a second failure */
  }
});
const problems = [];

/** The file an entry resolves to: a bare string, or the `import` condition of a conditions object. */
function targetOf(value) {
  if (typeof value === 'string') return value;
  return value.import ?? value.default ?? null;
}

/*
 * Copy what the map names, and keep a record of it, because the record is what the output leans on:
 * "the map named these, the tree holds these, and the library asked for this other thing".
 */
const placed = [];

/** Relative references out of a stylesheet: `@import url(x)` and `url(y)`, ignoring absolute ones and data URIs. */
function cssReferences(text) {
  return [...text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
    .map((m) => m[1].split('?')[0].split('#')[0])
    .filter((u) => u && !/^(https?:|data:|\/)/.test(u));
}

/**
 * What a bundler emits beside a stylesheet, and why this is modelled rather than asserted against.
 *
 * **A relative reference inside a stylesheet is not a package specifier, so the `exports` map has no
 * say in it.** `media/webview.css` holds `@import url('katex.css')`, and a bundler handed
 * `sheafeditor/webview.css` resolves that against the file on disk, where it exists, and emits or
 * inlines it; the same goes for the font files `katex.css` names. So a consumer following the
 * instructions gets those files whether or not any entry names them, and a tree that left them out
 * would fail this check over the way the check was built rather than over anything in the package.
 *
 * That is exactly what makes the diagram loader a different case and the reason this check exists:
 * it builds its URL **at runtime, from an address in the page**, so no bundler can see it, no
 * build-time resolution reaches it, and the map is then the only thing that could serve it.
 *
 * What is returned is recorded and printed, so a reader can see which files travel this way and are
 * named by nothing. A consumer who deploys the stylesheets as plain files instead of importing them
 * has to copy these by hand, and nothing in the map tells them so.
 */
function carriedWithCss(from, at, seenAlready = new Set()) {
  const out = [];
  const text = readFileSync(from, 'utf8');
  for (const ref of cssReferences(text)) {
    const source = join(dirname(from), ref);
    const target = `${dirname(at)}/${ref}`;
    if (seenAlready.has(source) || !existsSync(source)) continue;
    seenAlready.add(source);
    mkdirSync(join(served, dirname(target).slice(1)), { recursive: true });
    cpSync(source, join(served, target.slice(1)));
    out.push({ entry: `(relative from ${at.slice(at.lastIndexOf('/') + 1)})`, at: target, files: 1 });
    if (ref.endsWith('.css')) out.push(...carriedWithCss(source, target, seenAlready));
  }
  return out;
}
for (const [name, value] of Object.entries(exports_)) {
  const target = targetOf(value);
  if (!target) {
    problems.push(`the \`exports\` map entry ${name} resolves to no importable file, so a consumer cannot reach it`);
    continue;
  }
  const from = join(REPO, target);
  if (name.includes('*')) {
    /*
     * A pattern is a directory of the package's own split output. It goes under the code root with
     * its own name, because the code entries import it relatively and those imports are internal to
     * the package: `./chunks/*` is the map's promise to serve whatever the build put there.
     */
    const dir = dirname(from.replace('*', 'x'));
    if (!existsSync(dir)) {
      problems.push(`${name} is a pattern over ${relative(REPO, dir)}, which the build did not write`);
      continue;
    }
    const to = join(served, CODE_ROOT.slice(1), 'chunks');
    cpSync(dir, to, { recursive: true });
    placed.push({ entry: name, at: `${CODE_ROOT}/chunks/`, files: readdirSync(dir).length });
    continue;
  }
  if (!existsSync(from)) {
    problems.push(`${name} points at ${target}, which the build did not write`);
    continue;
  }
  const isCss = target.endsWith('.css');
  const base = target.slice(target.lastIndexOf('/') + 1);
  const at = `${isCss ? CSS_ROOT : CODE_ROOT}/${base}`;
  mkdirSync(join(served, dirname(at).slice(1)), { recursive: true });
  cpSync(from, join(served, at.slice(1)));
  placed.push({ entry: name, at, files: 1 });
  if (isCss) placed.push(...carriedWithCss(from, at));
}

if (problems.length) {
  console.error(`${problems.length} problem(s) building a consumer tree from the exports map:`);
  for (const p of problems) console.error(`  - ${p}`);
  rmSync(served, { recursive: true, force: true });
  process.exit(1);
}

// ---- The documents, found in the corpus -------------------------------------

/**
 * The constructs that reach a runtime asset, and how to find a document holding one.
 *
 * Two, because two of the things a `document` draws are fetched rather than bundled: a diagram
 * loads Mermaid, and an equation loads KaTeX. The rest of what a profile refuses draws from bytes
 * already in the page. These are patterns over the corpus rather than documents named here, so the
 * subjects follow the corpus.
 */
const WANTED = [
  {
    construct: 'Diagram',
    asset: 'the diagram library',
    holds: (text) => text.includes('```mermaid'),
    /**
     * The fence as the document holds it, and the line to look for on screen.
     *
     * The line is the fence's first line of *content* rather than its opening delimiter. A fence's
     * delimiter lines are replaced in both states — drawn as a diagram, and refused as an ordinary
     * fence — so looking for ```` ```mermaid ```` finds nothing whatever happened, which is a
     * precondition that fails against correct behaviour.
     */
    extract: (text) => {
      const lines = text.split('\n');
      const open = lines.findIndex((l) => l.trimEnd() === '```mermaid');
      if (open < 0) return null;
      const close = lines.findIndex((l, i) => i > open && l.trimEnd() === '```');
      if (close < 0 || close === open + 1) return null;
      return { source: lines.slice(open, close + 1).join('\n'), onScreen: lines[open + 1].trim() };
    },
  },
  {
    construct: 'InlineMath',
    asset: 'the maths library',
    holds: (text) => /\$[^$\n]+\$/.test(text),
    extract: (text) => {
      const line = text.split('\n').find((l) => /\$[^$\n]+\$/.test(l));
      return line ? { source: line, onScreen: /\$[^$\n]+\$/.exec(line)[0] } : null;
    },
  },
];

const SAMPLE = join(REPO, 'sample');
const corpus = existsSync(SAMPLE)
  ? readdirSync(SAMPLE, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => join(e.parentPath ?? e.path, e.name))
  : [];

/**
 * A line of ordinary prose, put before the construct in every case.
 *
 * The caret starts at 0, and a construct the caret is sitting in shows its source rather than its
 * drawing. With the construct on the first line, every case would be measuring a revealed fence and
 * no loader would run in any of them, which is the pass this check must not be able to give.
 */
const BEFORE = 'A line of prose before it.\n\n';

/*
 * One short document per construct, holding that construct as the corpus writes it.
 *
 * **It is an extract rather than the whole file, and that is a precondition rather than a
 * convenience.** CodeMirror builds DOM for the lines near the viewport and no others, so a
 * construct far enough down a long document is never drawn, no widget is built, and no loader
 * runs. The first run of this check mounted `sample/dialect/sheaf.md` whole, whose fence is at line
 * 61, and the control that gave `notes` the diagram still passed: nothing had asked for the
 * diagram library because nothing had drawn the diagram. That reads exactly like a check that
 * cannot fail, and it was a subject the construct was not visible in.
 *
 * So the construct is taken from a real document and mounted where it is on screen. The file it
 * came from and the number of documents holding one are printed, so the subject stays traceable to
 * the corpus.
 */
const subjects = [];
for (const want of WANTED) {
  const found = corpus.filter((f) => want.holds(readFileSync(f, 'utf8')));
  if (!found.length) {
    problems.push(`no document under sample/ holds ${want.construct}, so nothing here would reach ${want.asset}`);
    continue;
  }
  const file = found[0];
  const taken = want.extract(readFileSync(file, 'utf8'));
  if (!taken) {
    problems.push(`${relative(REPO, file)} matched ${want.construct} and no ${want.construct} could be read out of it`);
    continue;
  }
  subjects.push({ ...want, file, candidates: found.length, value: `${BEFORE}${taken.source}\n`, ...taken });
}

if (problems.length) {
  console.error(`${problems.length} problem(s) finding a subject in the corpus:`);
  for (const p of problems) console.error(`  - ${p}`);
  rmSync(served, { recursive: true, force: true });
  process.exit(1);
}

// ---- The consumer's page ----------------------------------------------------

/*
 * A consumer's page and nothing more: the two stylesheets from where a CSS pipeline put them, and
 * `mount` from the code entry. It is served under the content root so that a relative reference
 * inside a document resolves against the document's own folder, the way it does in any application
 * serving its own content.
 */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${CSS_ROOT}/browser-theme.css">
<link rel="stylesheet" href="${CSS_ROOT}/webview.css">
<style>
  body { margin: 0; padding: 24px; }
  #host { width: 820px; height: 600px; }
</style>
<div id="host"></div>
<script type="module">
  import { mount } from '${CODE_ROOT}/index.js';
  window.make = (value, profile) => {
    window.surface?.destroy();
    const host = document.getElementById('host');
    host.style.height = profile === 'field' ? '' : '600px';
    window.surface = mount(host, { value, profile });
  };
  window.ask = (path) => fetch(path).then((r) => r.status).catch(() => 'threw');
</script>`;

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** Every request the page made, with what the tree answered. */
const seen = [];

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const record = (status) => seen.push({ path, status });
  if (path === '/' || path === `${CONTENT_ROOT}/` || path === `${CONTENT_ROOT}/index.html`) {
    record(200);
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    return;
  }
  /*
   * The content root is the consumer's own files, read out of the corpus so a document's pictures
   * resolve. The package roots are the temporary tree and nothing else, which is what makes an
   * unnamed path 404 here while it would have resolved in the checkout.
   */
  const file = path.startsWith(`${CONTENT_ROOT}/`) ? join(SAMPLE, path.slice(CONTENT_ROOT.length + 1)) : join(served, path.replace(/^\/+/, ''));
  const root = path.startsWith(`${CONTENT_ROOT}/`) ? SAMPLE : served;
  if (!file.startsWith(root + '/') || !existsSync(file) || statSync(file).isDirectory()) {
    record(404);
    res.writeHead(404).end('not here');
    return;
  }
  record(200);
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));

/** A request the library made for a file of its own, which the exports map had nowhere to serve from. */
const unservedPackageAsset = (r) => r.status === 404 && (r.path.startsWith(`${CODE_ROOT}/`) || r.path.startsWith(`${CSS_ROOT}/`));

// ---- The instrument, before anything is measured with it --------------------

/*
 * Whether this run can see an unserved package asset at all.
 *
 * Everything below reports "no request went unserved", and that sentence reads identically when the
 * watcher is wired correctly and when it is wired to nothing. So the page is asked for a path under
 * a package root that the map certainly does not name, and the finding it should produce is checked
 * for and then dropped. Without this, a page that failed to load, a server that answered everything
 * or a recorder that recorded nothing would each read as a clean result.
 */
await page.goto(`${base}${CONTENT_ROOT}/index.html`, { waitUntil: 'load' });

/*
 * The page's own module graph, before anything else, because a tree that cannot boot the library
 * has already answered the question this check asks and would otherwise answer it as a crash.
 *
 * Measured: taking `./chunks/*` out of the map leaves the entry's own static import unserved, so
 * `mount` never arrives and the wait below times out thirty seconds later with a `TimeoutError` and
 * a stack. That is the correct verdict reported in the worst possible way, since a stack trace from
 * a gate reads as the gate being broken rather than as the package being unservable. The requests
 * are what say which it is, so they are printed.
 */
const booted = await page
  .waitForFunction(() => !!window.make, null, { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
if (!booted) {
  const unserved = seen.filter(unservedPackageAsset);
  console.error(
    `the consumer page never reached \`mount\`, so the library could not be loaded from a tree built out of the exports map.\n` +
      `  the map names ${Object.keys(exports_).join(', ')}\n` +
      `  the tree held ${placed.map((p) => p.at).join(', ')}\n` +
      (unserved.length
        ? `  and ${unserved.length} request(s) for a file of the package's went unserved: ${unserved.map((r) => r.path).join(', ')}`
        : `  and every request it made was served, so the failure is in the page or the entry rather than in the map: ${seen.map((r) => `${r.path} ${r.status}`).join(', ')}`)
  );
  await browser.close();
  server.close();
  rmSync(served, { recursive: true, force: true });
  process.exit(1);
}
/*
 * What the page asked for simply by loading, kept before the canary adds a request of its own.
 *
 * **This is a case rather than setup**, and it is the one the first version of this check could not
 * see: it cleared the record before the first mount, so everything the two stylesheets pull in was
 * dropped. A stylesheet is fetched once, at load, by the consumer's own `import` of it, and what it
 * pulls in from beside itself is as much a part of the package surface as a module the editor
 * fetches later.
 */
const onLoad = [...seen];

const CANARY = `${CODE_ROOT}/no-entry-names-this.mjs`;
const canaryStatus = await page.evaluate((p) => window.ask(p), CANARY);
const canaryFound = seen.filter(unservedPackageAsset).filter((r) => r.path === CANARY);
if (canaryStatus !== 404 || canaryFound.length !== 1) {
  console.error(
    'the instrument is not measuring anything: a request for a path the exports map does not name ' +
      `returned ${canaryStatus} and produced ${canaryFound.length} finding(s), where 404 and exactly one were expected. ` +
      'Every result below would have read as clean whatever the library did.'
  );
  await browser.close();
  server.close();
  rmSync(served, { recursive: true, force: true });
  process.exit(1);
}
console.log(`instrument: a request for ${CANARY} returned 404 and was recorded, so an unserved package asset is visible to this run.`);
seen.length = 0;

// ---- The cases --------------------------------------------------------------

const failures = [];
let cases = 0;
const say = (name, ok, detail) => {
  cases += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n     ${detail}`);
  if (!ok) failures.push(name);
};

/**
 * Mount `value` as `profile`, let its editor build, and say what the tree was asked for.
 *
 * **Four preconditions, and each one is a way of measuring nothing.** The finding here is the
 * *absence* of a request, and a document that never arrived, a mount that threw, an editor that was
 * never built and a construct that was never on screen all produce that absence while looking like
 * a pass. The fourth is the one that actually happened: see the comment on `subjects`.
 *
 * `onScreen` is the construct's own first line, looked for in the text CodeMirror has drawn. It is
 * the readable proof that the lines holding the construct exist in the DOM, which is what a
 * decoration needs before it can draw anything or fetch anything.
 */
async function probe({ value, profile, onScreen }) {
  seen.length = 0;
  errors.length = 0;
  await page.evaluate(([v, p]) => window.make(v, p), [value, profile]);
  const mounted = await page.evaluate(() => window.surface.value());
  if (mounted !== value) return { why: `the mounted value is ${mounted.length} characters against the subject's ${value.length}, so the document never arrived whole` };
  await page.evaluate(() => window.surface.focus());
  const built = await page
    .waitForFunction(() => window.surface.editing(), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!built) return { why: 'the surface never became an editor, so nothing that draws was reached' };
  /*
   * Two frames and a settle, because a loader is started by a decoration being built and the
   * request goes out after it. Asserting "no request was made" immediately after the editor appears
   * would be asserting that the request had not happened *yet*.
   */
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await new Promise((r) => setTimeout(r, 750));
  const drawn = await page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    return { text: content?.textContent ?? '', widgets: ['.md-mermaid', '.md-math-inline', '.md-math-block', '.katex'].filter((s) => document.querySelector(s)) };
  });
  if (!drawn.text.includes(BEFORE.trim())) {
    return { why: 'the editor has drawn none of the document, so there was no state to measure' };
  }
  /*
   * **Either state satisfies this, and that is what makes it a precondition rather than an
   * assertion about the answer.** A refused construct is on screen as its own characters; a drawn
   * one is on screen as a widget, its source replaced. Looking for only the first fails against a
   * surface that drew the diagram, which is the state the control produces, so the control would
   * report an unmeasurable case instead of the finding it exists to produce.
   */
  const asSource = drawn.text.includes(onScreen);
  if (!asSource && !drawn.widgets.length) {
    return { why: `neither the construct's own \`${onScreen}\` nor any widget for it is on screen, so the construct was never reached and nothing would have fetched anything for it` };
  }
  return { requests: [...seen], errors: [...errors], widgets: drawn.widgets, asSource };
}

/*
 * The stylesheets, which a consumer imports and which fetch what they name beside themselves.
 *
 * Nothing is mounted for this one. The subject is the two `import` lines the instructions give, and
 * what the browser does with them.
 */
{
  const unserved = onLoad.filter(unservedPackageAsset);
  say(
    'the two stylesheets a consumer imports',
    unserved.length === 0,
    `loading the page asked the tree for ${onLoad.length}: ${onLoad.map((r) => `${r.path} ${r.status}`).join(', ')}. ` +
      (unserved.length
        ? `${unserved.length} for a file of the package's that no entry names: ${unserved.map((r) => r.path).join(', ')}. ` +
          `The map names ${Object.keys(exports_).join(', ')}, so a consumer serving exactly those has nowhere to answer that from.`
        : "None for a file of the package's that no entry names.")
  );
}

/** The two profiles `mount` offers. `document` is the extension's and is not reachable through it. */
const PROFILES = ['notes', 'field'];

for (const subject of subjects) {
  for (const profile of PROFILES) {
    const name = `${subject.construct} in a ${profile} surface, from ${relative(REPO, subject.file)}`;
    const out = await probe({ value: subject.value, profile, onScreen: subject.onScreen });
    if (out.why) {
      say(name, false, `the case could not be measured: ${out.why}`);
      continue;
    }
    const unserved = out.requests.filter(unservedPackageAsset);
    const content = out.requests.filter((r) => r.path.startsWith(`${CONTENT_ROOT}/`) && r.path !== `${CONTENT_ROOT}/index.html`);
    /*
     * Every request is printed rather than counted. A count of nought is the answer a correct
     * library gives and also the answer a page that loaded nothing gives, and the two are only told
     * apart by what the other requests were.
     */
    const detail =
      `asked the tree for ${out.requests.length}: ${out.requests.map((r) => `${r.path} ${r.status}`).join(', ') || 'nothing'}. ` +
      `On screen as ${out.asSource ? `its own \`${subject.onScreen}\`` : 'no source of its own'}` +
      `${out.widgets.length ? `, with ${out.widgets.join(', ')} drawn` : ', with no widget drawn'}. ` +
      `${content.length} of them the document's own files, which are the consumer's. ` +
      (unserved.length
        ? `${unserved.length} for a file of the package's that no entry names: ${unserved.map((r) => r.path).join(', ')}. ` +
          `The map names ${Object.keys(exports_).join(', ')}, so a consumer serving exactly those has nowhere to answer that from.`
        : `None for a file of the package's that no entry names; ${subject.candidates} document(s) in the corpus hold this construct.`) +
      (out.errors.length ? ` Page said: ${out.errors.join('; ')}.` : '');
    say(name, unserved.length === 0 && out.errors.length === 0, detail);
  }
}

const named = placed.filter((p) => !p.entry.startsWith('('));
const relative_ = placed.filter((p) => p.entry.startsWith('('));
console.log(`\nThe consumer tree held ${named.map((p) => `${p.entry} at ${p.at}`).join(', ')}.`);
if (relative_.length) {
  console.log(
    `It also held ${relative_.length} file(s) that no entry names, reached by relative reference out of a stylesheet and ` +
      `placed the way a bundler emits them: ${relative_.map((p) => p.at).join(', ')}. ` +
      'A consumer who imports the stylesheets gets these from their own build. One who deploys them as plain files copies them by hand, ' +
      'and the exports map does not mention them.'
  );
}

await browser.close();
server.close();
rmSync(served, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} of ${cases} case(s) requested a file the exports map does not name: ${failures.join('; ')}.`);
  process.exit(1);
}
console.log(
  `${cases} case(s), ${subjects.length} construct(s) across ${PROFILES.length} profile(s), measured against a tree built out of the ` +
    `exports map and served from ${served}, which is not this checkout. Nothing was asked for that the tree could not serve.`
);
