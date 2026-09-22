#!/usr/bin/env node
/**
 * Renders every document in the sample corpus through Sheaf's own live preview
 * and reports any Markdown syntax still showing where a rendered construct
 * should be: a `**` that never became bold, an alert marker left as text, a
 * heading drawn with its hashes. The corpus exists so that a construct quietly
 * falling back to its source is noticed; this is what notices it.
 *
 * It mounts the editor under jsdom with the same extensions the webview uses,
 * through test/harness.ts, the way the unit scenarios do. No browser, no
 * install beyond the checkout's own dependencies.
 *
 * Code is never counted. Fenced and indented code, inline code spans and front
 * matter show their syntax on purpose, so their text is removed before checking.
 *
 * Some constructs are known not to render yet. Those are listed in KNOWN_GAPS
 * below, reported as known rather than as failures, and checked the other way
 * too: when a known gap starts rendering, the run fails and says to take it off
 * the list, so the list cannot go stale.
 *
 *   npm run check-render                            # the documents meant to read cleanly
 *   node scripts/check-render.mjs sample/docs       # only these paths
 *   node scripts/check-render.mjs --verbose         # every document, not just the ones with findings
 */

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));

// The documents written to read cleanly. edge/ is left out because its input is
// ambiguous or hostile by design, so raw syntax there is often the right answer;
// stress/ is for performance, and wild/ is other people's writing, fetched on demand.
const DEFAULT_ROOTS = ['sample'];
const SKIP = new Set(['edge', 'stress', 'wild', 'assets']);

/**
 * Syntax that should never survive rendering, outside code. Each is tested on
 * the text a reader sees. `source` is what to look for in the file to tell a
 * construct that was written from one that was not, which is how a known gap is
 * recognised as fixed.
 */
const TELLTALES = [
  { name: 'alert marker', rendered: /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/, source: /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/m },
  { name: 'display maths', rendered: /\$\$/, source: /^\s*\$\$/m },
  { name: 'heading hashes', rendered: /^#{1,6}\s+\S/m, source: /^#{1,6}\s+\S/m },
  { name: 'strong markers', rendered: /\*\*[^*\s][^*\n]*\*\*/, source: /\*\*[^*\s][^*\n]*\*\*/ },
  { name: 'strikethrough', rendered: /~~[^~\s][^~\n]*~~/, source: /~~[^~\s][^~\n]*~~/ },
  { name: 'highlight', rendered: /==[^=\s][^=\n]*==/, source: /==[^=\s][^=\n]*==/ },
  { name: 'image syntax', rendered: /!\[[^\]\n]*\]\([^)\n]*\)/, source: /!\[[^\]\n]*\]\([^)\n]*\)/ },
  { name: 'link syntax', rendered: /(?<!!)\[[^\]\n]+\]\([^)\s\n]+\)/, source: /(?<!!)\[[^\]\n]+\]\([^)\s\n]+\)/ },
  { name: 'inline HTML tag', rendered: /<\/?(kbd|sub|sup|abbr|mark|small)\b[^>]*>/i, source: /<\/?(kbd|sub|sup|abbr|mark|small)\b[^>]*>/i },
  { name: 'emoji shortcode', rendered: /(^|[\s(])(:[a-z][a-z0-9_+-]{2,}:)/m, source: /(^|[\s(])(:[a-z][a-z0-9_+-]{2,}:)/m },
  { name: 'footnote reference', rendered: /\[\^[^\]\n]+\]/, source: /\[\^[^\]\n]+\]/ },
];

/**
 * Constructs Sheaf does not draw yet. Each is reported as known instead of
 * failing, until the day it renders, when the run fails and asks for the entry
 * to be removed. Describe the gap; do not put tracker references here.
 */
const KNOWN_GAPS = {
  'emoji shortcode': 'Shortcodes are parsed but drawn as typed; there is no name-to-character table.',
  'footnote reference': 'The dialect has no footnote extension, so references and definitions show as written.',
};

/* ------------------------------------------------------------- documents -- */

function collect(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const e of readdirSync(path).sort()) {
      if (SKIP.has(e)) continue;
      collect(join(path, e), out);
    }
  } else if (path.endsWith('.md')) {
    out.push(path);
  }
  return out;
}

const roots = (args.length ? args : DEFAULT_ROOTS).map((r) => join(REPO, r));
const docs = roots.flatMap((r) => collect(r, []));
if (!docs.length) {
  console.error('No Markdown documents found under ' + roots.map((r) => relative(REPO, r)).join(', '));
  process.exit(2);
}

/* --------------------------------------------------------------- the dom -- */

const req = createRequire(join(REPO, 'package.json'));
const esbuild = req('esbuild');
const { JSDOM } = req('jsdom');

const out = join(tmpdir(), 'sheaf-check-render');
mkdirSync(out, { recursive: true });
const entry = join(out, 'entry.ts');
writeFileSync(
  entry,
  `export { mountProse } from ${JSON.stringify(join(REPO, 'test', 'harness'))};\n` +
    `export { setLivePreviewConfig } from ${JSON.stringify(join(REPO, 'src', 'webview', 'livePreview'))};\n` +
    `export { forceParsing } from '@codemirror/language';\n`
);
const bundle = join(out, 'bundle.cjs');
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  outfile: bundle,
  logLevel: 'warning',
  nodePaths: [join(REPO, 'node_modules')],
});

// The same environment test/real-editor/run-unit.mjs gives the unit scenarios.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
for (const key of [
  'getComputedStyle', 'NodeFilter', 'Node', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'DOMParser', 'Range',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'InputEvent', 'DocumentFragment', 'Text', 'ClipboardEvent', 'DataTransfer', 'PointerEvent', 'FocusEvent',
]) {
  if (window[key]) globalThis[key] = window[key];
}
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
const emptyRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
if (!window.Range.prototype.getClientRects) window.Range.prototype.getClientRects = () => [];
if (!window.Range.prototype.getBoundingClientRect) window.Range.prototype.getBoundingClientRect = emptyRect;
globalThis.window = window;
if (!globalThis.Window && window.Window) globalThis.Window = window.Window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// jsdom has no layout, so CodeMirror cannot tell how much of a document is on
// screen and draws only the first screenful, which would leave most of every file
// unchecked. Report a window and editor tall enough to hold any document, so its
// viewport takes in all of it. Lines keep jsdom's zero geometry, so none of them
// is mistaken for a tall one.
const TALL = 1e7;
Object.defineProperty(window, 'innerHeight', { value: TALL, configurable: true });
Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
const realRect = window.Element.prototype.getBoundingClientRect;
window.Element.prototype.getBoundingClientRect = function () {
  const tall =
    this === window.document.body ||
    this === window.document.documentElement ||
    ['cm-editor', 'cm-scroller', 'cm-content'].some((c) => this.classList?.contains(c));
  return tall
    ? { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: TALL, width: 1200, height: TALL, toJSON() {} }
    : realRect.call(this);
};

const { mountProse, setLivePreviewConfig, forceParsing } = createRequire(import.meta.url)(bundle);
// The live preview module defaults to revealing syntax on the caret's line, and the
// webview turns that off on load. Without this the first line of every file reads raw.
setLivePreviewConfig({ revealSyntaxOnLine: false });

/* ------------------------------------------------------------- the audit -- */

/** Markdown with its code removed, so a construct inside a fence does not count as written. */
function sourceWithoutCode(md) {
  return md
    .replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, '')
    .replace(/^\n?((?: {4}|\t)[^\n]*\n?)+/gm, '\n')
    .replace(/`+[^`\n]+`+/g, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '');
}

const CODE_LINE = /\b(tok-code-block|tok-code-fence|tok-frontmatter)\b/;

/** What a reader sees, line by line, with code left out. */
function renderedText(p) {
  const lines = [...p.view.contentDOM.querySelectorAll(':scope > .cm-line')];
  const kept = [];
  for (const el of lines) {
    if (CODE_LINE.test(el.className)) continue;
    const clone = el.cloneNode(true);
    for (const c of clone.querySelectorAll('.tok-inline-code, .tok-code-block')) c.remove();
    kept.push(clone.textContent ?? '');
  }
  return kept.join('\n');
}

const failures = [];
const fixedGaps = new Map();
const knownSeen = new Map();
let partial = 0;

for (const file of docs) {
  const rel = relative(REPO, file);
  const md = readFileSync(file, 'utf8');
  const p = mountProse(md);
  let rendered;
  let whole;
  try {
    // The parser works lazily, as far as the viewport and then in the background
    // on idle time, which a script never gives it. Parse to the end now, or every
    // line below the first screen is drawn with no tree under it and reads as raw.
    forceParsing(p.view, p.view.state.doc.length, 10000);
    // Run the measure pass CodeMirror would otherwise schedule on an animation
    // frame, synchronously, until the viewport reaches the end of the document or
    // stops growing. Waiting on the frame instead gives a different answer each run.
    let last = -1;
    for (let i = 0; i < 100; i++) {
      p.view.measure();
      const to = p.view.viewport.to;
      if (to >= p.view.state.doc.length || to === last) break;
      last = to;
    }
    whole = p.view.viewport.from === 0 && p.view.viewport.to >= p.view.state.doc.length;
    rendered = renderedText(p);
  } finally {
    p.destroy();
  }
  const src = sourceWithoutCode(md);
  const found = [];
  const known = [];
  for (const t of TELLTALES) {
    const shows = t.rendered.test(rendered);
    const written = t.source.test(src);
    if (KNOWN_GAPS[t.name]) {
      if (shows) {
        known.push(t.name);
        knownSeen.set(t.name, (knownSeen.get(t.name) ?? []).concat(rel));
      } else if (written) {
        fixedGaps.set(t.name, (fixedGaps.get(t.name) ?? []).concat(rel));
      }
    } else if (shows) {
      found.push(t.name);
    }
  }
  if (!whole) partial++;
  if (found.length) failures.push({ rel, found });
  if (VERBOSE || found.length) {
    const tag = found.length ? 'FAIL' : known.length ? 'known' : 'ok';
    const detail = [...found, ...known.map((k) => `${k} (known)`)].join(', ');
    console.log(`${tag.padEnd(5)} ${rel}${detail ? '  ' + detail : ''}`);
  }
}

console.log(`\n${docs.length} documents audited, ${failures.length} with syntax showing where it should have rendered.`);

if (knownSeen.size) {
  console.log('\nKnown gaps, still not rendered:');
  for (const [name, files] of knownSeen) console.log(`  ${name}: ${KNOWN_GAPS[name]} Seen in ${files.length} document${files.length === 1 ? '' : 's'}.`);
}

if (fixedGaps.size) {
  console.log('\nThese known gaps now render. Take them out of KNOWN_GAPS in scripts/check-render.mjs:');
  for (const [name, files] of fixedGaps) console.log(`  ${name}: written in ${files.join(', ')}, and not showing as source.`);
}

// A document the editor drew only part of was only partly checked, and a clean
// result for it would mean nothing. That is a fault in this script, not in the
// corpus, but it fails the run all the same rather than passing quietly.
if (partial) console.log(`\n${partial} document${partial === 1 ? ' was' : 's were'} only partly drawn and could not be fully checked.`);

process.exit(failures.length || fixedGaps.size || partial ? 1 : 0);
