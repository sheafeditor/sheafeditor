import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
for (const key of ['getComputedStyle', 'NodeFilter', 'Node', 'HTMLElement', 'DOMParser', 'Range', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Event', 'CustomEvent', 'DocumentFragment', 'Text']) {
  if (window[key]) globalThis[key] = window[key];
}
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { run } = createRequire(import.meta.url)('./bundle.cjs');

// Each element in its own tiny doc. A leading `.\n\n` keeps the default cursor
// (pos 0) off the element's line, so inactive-line rendering is exercised.
const P = '.\n\n';
const cases = [
  ['heading',    P + '# Title',                      (r) => r.counts.h1 === 1],
  ['bold',       P + 'a **bold** b',                 (r) => r.counts.strong === 1],
  ['italic',     P + 'a _em_ b',                     (r) => r.counts.em === 1],
  ['strike',     P + 'a ~~gone~~ b',                 (r) => r.counts.strike === 1],
  // One tilde is strikethrough too, which is what pins this harness to the
  // dialect the editor reads: the stock Markdown language parses `~gone~` as
  // Pandoc subscript and renders nothing struck through.
  ['oneTilde',   P + 'a ~gone~ b',                   (r) => r.counts.strike === 1],
  ['inlineCode', P + 'a `code` b',                   (r) => r.counts.inlineCode === 1],
  ['link',       P + 'a [text](https://x.com) b',    (r) => r.counts.link === 1],
  ['blockquote', P + '> quoted line',                (r) => r.counts.quote === 1],
  ['bullet',     P + '- one\n- two',                 (r) => r.counts.bullet === 2],
  ['task',       P + '- [ ] todo\n- [x] done',       (r) => r.counts.task === 2],
  ['hr',         P + '---',                          (r) => r.counts.hr === 1],
  ['image',      P + '![alt](https://x.com/i.png)',  (r) => r.counts.img === 1],
  ['codeBlock',  P + '```js\nconst x = 1;\n```',     (r) => r.counts.codeBlock >= 1],
  // Reveal: cursor at pos 2 sits inside the heading, so its `#` marker shows.
  ['reveal',     '# Title',                          (r) => r.revealedMarksOnActiveLine === 1],
];

let pass = 0;
for (const [name, text, check] of cases) {
  let ok = false, detail = '';
  try {
    const r = run(text);
    ok = check(r);
    detail = JSON.stringify(name === 'reveal' ? { revealed: r.revealedMarksOnActiveLine } : r.counts);
  } catch (e) {
    detail = 'threw: ' + e.message;
  }
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(11)} ${ok ? '' : detail}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${cases.length} checks passed`);
process.exit(pass === cases.length ? 0 : 1);
