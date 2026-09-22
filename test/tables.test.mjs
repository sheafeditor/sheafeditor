import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
for (const key of [
  'getComputedStyle', 'NodeFilter', 'Node', 'HTMLElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'DOMParser', 'Range', 'MutationObserver', 'ResizeObserver',
  'IntersectionObserver', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'InputEvent', 'DocumentFragment', 'Text',
]) {
  if (window[key]) globalThis[key] = window[key];
}
// A cell editor is a CodeMirror view of its own, so this suite now runs CodeMirror's
// measuring. It asks a range where it is drawn, and asks whether what it scrolls
// inside is the window. jsdom has neither, and without these every measure throws
// into its uncaught-error reporter, which prints and is seen by no scenario. Same
// three lines as test/real-editor/run-unit.mjs, for the same reason.
const emptyRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
if (!window.Range.prototype.getClientRects) window.Range.prototype.getClientRects = () => [];
if (!window.Range.prototype.getBoundingClientRect) window.Range.prototype.getBoundingClientRect = emptyRect;
if (!globalThis.Window && window.Window) globalThis.Window = window.Window;
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { runAll } = createRequire(import.meta.url)('./tables.bundle.cjs');

const results = await runAll();
let pass = 0;
for (const { name, ok, detail } of results) {
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(30)} ${ok ? '' : detail}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${results.length} table checks passed`);
process.exit(pass === results.length ? 0 : 1);
