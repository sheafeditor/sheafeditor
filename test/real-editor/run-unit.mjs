// Run the person's-eye unit scenarios under jsdom against this checkout's source.
//
//   node test/real-editor/run-unit.mjs [area ...]
//
// An area file unit/<area>.ts exports `scenarios`: [{ id, feature, name, run }], where run returns true or
// { ok, detail }. With no area named, every file in unit/ runs. Results are written to a run folder under
// SHEAF_EDITOR_RUNS (default: sheaf-real-editor in the OS temp folder), whose path is printed.
import { createRequire } from 'node:module';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// The checkout holding these files, and the checkout under test: the same unless SHEAF_CHECKOUT names another.
const OWN = resolve(HERE, '..', '..');
const REPO = process.env.SHEAF_CHECKOUT ? resolve(process.env.SHEAF_CHECKOUT) : OWN;
// Unit files import Sheaf's src/ and test/ by relative path; when another checkout is under test, those resolve there.
const checkoutImports = {
  name: 'checkout-imports',
  setup(build) {
    if (REPO === OWN) return;
    const mine = join(OWN, 'test', 'real-editor') + sep;
    build.onResolve({ filter: /^\.\.\// }, (args) => {
      const abs = resolve(args.resolveDir, args.path);
      if (abs.startsWith(mine)) return undefined;
      for (const top of ['src', 'test']) {
        if (abs.startsWith(join(OWN, top) + sep)) return build.resolve('./' + relative(OWN, abs).split(sep).join('/'), { resolveDir: REPO, kind: args.kind });
      }
      return undefined;
    });
  },
};
const RUNS = process.env.SHEAF_EDITOR_RUNS || join(tmpdir(), 'sheaf-real-editor');
const UNIT = join(HERE, 'unit');
const req = createRequire(join(REPO, 'package.json'));
const esbuild = req('esbuild');
const { JSDOM } = req('jsdom');

const areas = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(UNIT).filter((f) => f.endsWith('.ts') && !f.startsWith('.')).map((f) => f.slice(0, -3));
const out = join(RUNS, `unit-${areas.join('+')}`);
mkdirSync(out, { recursive: true });
// A generated entry that imports each area, kept in the run folder so the checkout stays clean.
const entry = join(out, 'entry.ts');
writeFileSync(
  entry,
  areas.map((a, i) => `import { scenarios as s${i} } from ${JSON.stringify(join(UNIT, a))};`).join('\n') +
    `\nexport const all = [${areas.map((a, i) => `...s${i}.map((s: any) => ({ ...s, area: '${a}' }))`).join(', ')}];\n`
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
  plugins: [checkoutImports],
});

// Some areas load Sheaf's host modules and files at run time; they find the checkout through this.
process.env.SHEAF_REPO = REPO;

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
// jsdom has no layout; CodeMirror measures text ranges, so give ranges empty geometry.
const emptyRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
if (!window.Range.prototype.getClientRects) window.Range.prototype.getClientRects = () => [];
if (!window.Range.prototype.getBoundingClientRect) window.Range.prototype.getBoundingClientRect = emptyRect;
globalThis.window = window;
if (!globalThis.Window && window.Window) globalThis.Window = window.Window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { all } = createRequire(import.meta.url)(bundle);
const results = [];
for (const s of all) {
  let ok = false;
  let detail = '';
  try {
    const r = await s.run();
    ok = r === true || r?.ok === true;
    detail = typeof r === 'object' && r ? r.detail ?? '' : ok ? '' : 'assertion failed';
  } catch (e) {
    detail = `threw: ${e.message}`;
  }
  results.push({ area: s.area, id: s.id, feature: s.feature, name: s.name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${s.id} ${s.name}${ok ? '' : `\n     ${detail}`}`);
}
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} unit scenarios passed (results in ${out})`);
process.exit(pass === results.length ? 0 : 1);
