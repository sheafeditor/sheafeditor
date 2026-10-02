/*
 * The browser host, opened beside a real VS Code window so one gesture can be driven through both
 * and the resulting files compared.
 *
 * ## Why this exists
 *
 * The editor bundle is the same bytes in every host, and a check in the host suite enforces that.
 * The code *around* the editor is not shared and is not checked against itself at all: the provider
 * on one side, `src/server/` on the other, and almost all of it is about reaching the file. Two
 * defects of exactly that shape were found in one evening, both reaching the user's file, and
 * neither was visible to any existing check. The window suite only drives the window, a browser
 * probe only drives the tab, and the bundle check is satisfied in both.
 *
 * So the comparison is the instrument, and it needs no opinion about which host is right. A
 * difference is a finding; which host to change is a separate question answered per case.
 *
 * ## The precondition, asserted rather than assumed
 *
 * **The server holds a document only once something subscribes to `/api/events`.** `GET
 * /edit/<path>` renders the page and opens nothing, so a check that drove the tab with `fetch`
 * would compare a window holding a live document against a tab holding none, and *every* gesture
 * would differ for that reason. That reads exactly like finding a dozen bugs, and it has already
 * cost one false finding and one wrong conclusion about a guard being dead code.
 *
 * A real page load runs the page's own script, which does subscribe, so driving with a browser is
 * the right shape. `opened` below still asserts it, because the whole value of this check is that a
 * difference means something, and a tab holding no document makes every difference meaningless.
 *
 * Reading `/api/events` with `fetch(...).then(r => r.text())` is a separate trap worth naming here:
 * it is a stream designed never to end, so the read hangs, and it hangs **only on the case that
 * works**, because a refusal has a short body and returns at once.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from '../../scripts/serve-for-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = process.env.SHEAF_CHECKOUT ? resolve(process.env.SHEAF_CHECKOUT) : resolve(HERE, '..', '..');
const require = createRequire(join(REPO, 'package.json'));

/*
 * The same list the browser-driven checks in `scripts/` use. It is written out again rather than
 * shared, which is the shape this whole file exists to catch, so it is worth saying why: those
 * scripts exit 0 with `skipped:` when there is no browser, and a test area has to fail instead,
 * since a scenario that silently measures nothing is the thing the gates were taught to refuse.
 * The two behaviours do not belong in one helper, and the list is four lines.
 */
const CHROME = [
  process.env.SHEAF_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));

/** Whether a tab can be opened at all, so a scenario can say so rather than throw. */
export function tabHostAvailable() {
  if (!CHROME) return 'no Chrome or Chromium found; set SHEAF_CHROME to one';
  if (!existsSync(join(REPO, 'dist', 'serve.js'))) return 'dist/serve.js is not built; run npm run build';
  try {
    require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
  } catch {
    return 'playwright-core is not installed; set PLAYWRIGHT_CORE to its folder';
  }
  return null;
}

/**
 * A document open in a browser tab, served from a folder of its own.
 *
 * @param {string} text the document's starting content
 * @param {string} [name] its filename in the served folder
 */
export async function openTab(text, name = 'notes.md') {
  const why = tabHostAvailable();
  if (why) throw new Error(`the browser host could not be opened: ${why}`);
  const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

  const root = mkdtempSync(join(tmpdir(), 'sheaf-crosshost-'));
  const path = join(root, name);
  writeFileSync(path, text);

  const { server, base } = await serveForCheck({
    repo: REPO,
    root,
    whenAbsent: 'Without it the tab holds no document and every comparison would differ for that reason.',
  });
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

  /*
   * Watched before the page is asked for, because the subscription happens during the load and a
   * listener added afterwards sees nothing. The status is read from the response headers, which
   * `fetch` and Playwright both have as soon as they are available; the body is never touched.
   */
  const events = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/events')) events.push(r.status());
  });

  await page.goto(`${base}/edit/${name}`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  await page.waitForTimeout(1500);

  const close = async () => {
    await browser.close().catch(() => {});
    server.kill('SIGKILL');
  };

  return {
    page,
    path,
    root,
    /** The statuses `/api/events` answered with. A 200 among them is the document being held. */
    subscriptions: events,
    /** Whether the server is holding this document, which every comparison depends on. */
    opened: () => events.includes(200),
    /** The file as it stands on disk. */
    disk: () => readFileSync(path, 'utf8'),
    /** What the page is showing, as the editor's own document text. */
    shown: () =>
      page.evaluate(() => {
        const content = document.querySelector('.cm-content');
        const tile = content && (content.cmTile || content.cmView);
        const view = tile?.root?.view ?? tile?.view;
        return view ? view.state.doc.toString() : null;
      }),
    /** Put the caret just before `text` and type. */
    typeAt: async (needle, chars) => {
      await page.evaluate((n) => {
        const content = document.querySelector('.cm-content');
        const tile = content && (content.cmTile || content.cmView);
        const view = tile?.root?.view ?? tile?.view;
        if (!view) return;
        const at = view.state.doc.toString().indexOf(n);
        if (at < 0) return;
        view.dispatch({ selection: { anchor: at } });
        view.focus();
      }, needle);
      await page.waitForTimeout(200);
      await page.keyboard.type(chars);
    },
    /** A write to the file from something that is not Sheaf. */
    writeFromOutside: (next) => writeFileSync(path, next),
    sleep: (ms) => page.waitForTimeout(ms),
    close,
  };
}

/**
 * The two files, and the difference between them, as a line a person reads.
 *
 * A diff rather than a verdict, deliberately. Every assertion written against these hosts today
 * that predicted a *shape* rather than quoting the bytes was wrong at least once: an offset instead
 * of "one character inserted and nothing else", one `<img>` instead of "is this picture on screen",
 * a count of grids instead of asking the renderer. A diff cannot be wrong about what it compares.
 */
export function compareFiles(window_, tab) {
  const same = window_ === tab;
  const lines = (s) => s.split('\n');
  const w = lines(window_);
  const t = lines(tab);
  const differing = [];
  for (let i = 0; i < Math.max(w.length, t.length); i++) {
    if (w[i] !== t[i]) differing.push({ line: i, window: w[i] ?? '(no line)', tab: t[i] ?? '(no line)' });
  }
  return { same, differing };
}
