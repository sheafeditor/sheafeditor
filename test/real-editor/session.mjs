// A real VS Code window running Sheaf from this checkout, driven the way a person drives it: every click, drag
// and hover is a mouse event at window coordinates, and a click on something covered by another element fails,
// the way it fails a person. Scripted reads (DOM state, the file on disk) are only for checking results.
//
//   const S = await session('formatting');
//   await S.fresh('bold-twice', 'Hello world\n');   // a new file, opened in Sheaf
//   await S.caret('world', 5);                        // click at the end of "world"
//   await S.toolbar('Bold'); await S.toolbar('Bold');
//   const text = await S.disk();                      // the file, once auto-save settles
//
// Each run gets its own profile, extensions folder and copy of sample/ in its own run folder, so runs can go side
// by side. Scenarios write key names as on macOS ('Meta+z'); on other platforms Meta is sent as Control.
//
// Environment:
//   VSCODE_BIN         the VS Code executable (default: the usual install location for this platform)
//   PLAYWRIGHT_CORE    a playwright-core package to use, if it is not installed in this checkout
//   SHEAF_EDITOR_RUNS  where run folders go (default: sheaf-real-editor in the OS temp folder)
//   SHEAF_CHECKOUT     another checkout to test, such as a build of another branch (default: the one holding this file)

import { createRequire } from 'node:module';
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout under test: Sheaf runs from here as an extension in development. SHEAF_CHECKOUT points at another. */
export const REPO = process.env.SHEAF_CHECKOUT ? resolve(process.env.SHEAF_CHECKOUT) : resolve(HERE, '..', '..');
export const RUNS = process.env.SHEAF_EDITOR_RUNS || join(tmpdir(), 'sheaf-real-editor');
const MAC = process.platform === 'darwin';

function defaultCode() {
  if (MAC) return '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  return '/usr/share/code/code';
}
const CODE = process.env.VSCODE_BIN || defaultCode();

function loadPlaywright() {
  const req = createRequire(join(REPO, 'package.json'));
  try {
    return req(process.env.PLAYWRIGHT_CORE || 'playwright-core');
  } catch {
    throw new Error('playwright-core is needed to drive VS Code. Install it in this checkout, or set PLAYWRIGHT_CORE to its folder.');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in the Sheaf frame: find a target and report its centre, and what is on top there. */
function resolveInFrame(spec) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const describe = (el) => (el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : ''}` : 'nothing');
  if (spec.text != null) {
    const root = spec.within ? [...document.querySelectorAll(spec.within)].find(visible) : document.querySelector('.cm-content') || document.body;
    if (!root) return { error: `no visible container ${spec.within}` };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let all = '';
    for (let n; (n = walker.nextNode()); ) {
      nodes.push({ n, start: all.length });
      all += n.data;
    }
    let idx = -1;
    let from = 0;
    for (let k = 0; k <= (spec.occurrence || 0); k++) {
      idx = all.indexOf(spec.text, from);
      if (idx < 0) break;
      from = idx + 1;
    }
    if (idx < 0) return { error: `text not found on screen: ${JSON.stringify(spec.text)}` };
    const at = idx + (spec.offset ?? 0);
    const range = document.createRange();
    // A character's own box: its left edge places the caret before it, the previous character's right edge after it.
    // Text nodes are joined across lines, so the position just past a node's last character is the first character
    // of the next node, which may be on another line. When the offset ends a node, use the previous character's
    // right edge instead.
    const prevNode = at > 0 ? nodes.find(({ n, start }) => at - 1 >= start && at - 1 < start + n.data.length) : null;
    const endsNode = prevNode && spec.offset > 0 && at === prevNode.start + prevNode.n.data.length;
    const hit = endsNode ? null : nodes.find(({ n, start }) => at >= start && at < start + n.data.length);
    let x;
    let rect;
    if (hit) {
      range.setStart(hit.n, at - hit.start);
      range.setEnd(hit.n, at - hit.start + 1);
      rect = range.getBoundingClientRect();
      x = rect.left + Math.min(1, rect.width / 3);
    } else {
      const prev = nodes.find(({ n, start }) => at - 1 >= start && at - 1 < start + n.data.length);
      if (!prev) return { error: 'offset outside the text' };
      range.setStart(prev.n, at - 1 - prev.start);
      range.setEnd(prev.n, at - prev.start);
      rect = range.getBoundingClientRect();
      x = rect.right - Math.min(1, rect.width / 3);
    }
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, covered: !(top && root.contains(top)), by: describe(top), what: `text ${JSON.stringify(spec.text)}+${spec.offset ?? 0}` };
  }
  let els = [...document.querySelectorAll(spec.sel)].filter(visible);
  if (spec.hasText != null) els = els.filter((el) => el.textContent.trim().startsWith(spec.hasText) || (el.getAttribute('title') || '').startsWith(spec.hasText) || (el.getAttribute('aria-label') || '').startsWith(spec.hasText));
  const el = els[spec.nth || 0];
  if (!el) return { error: `no visible element ${spec.sel}${spec.hasText != null ? ` with text ${JSON.stringify(spec.hasText)}` : ''}` };
  const r = el.getBoundingClientRect();
  const x = r.left + (spec.dx ?? r.width / 2);
  const y = r.top + (spec.dy ?? r.height / 2);
  const top = document.elementFromPoint(x, y);
  return { x, y, covered: !(top && (el === top || el.contains(top))), by: describe(top), what: describe(el) };
}

/** Send Meta as Control off macOS, so scenarios can name keys once. Holding a modifier with down() and up() is kept. */
function platformKeys(keyboard) {
  if (MAC) return;
  const map = (k) => String(k).replace(/\bMeta\b/g, 'Control');
  for (const name of ['press', 'down', 'up']) {
    const original = keyboard[name].bind(keyboard);
    keyboard[name] = (key, ...rest) => original(map(key), ...rest);
  }
}

/**
 * Refuse to take a run folder another run is still writing.
 *
 * The wipe below is unconditional, and the run name defaults to the area, so two
 * runs of one area used to end with the second deleting the first's workspace,
 * profile and results while the first was still going. Neither process noticed,
 * and from outside a stolen run is indistinguishable from a slow one. That has
 * been read as a result more than once.
 *
 * `run.json` is what makes the check possible: it names the process and says
 * whether that run reached the end. A marker whose process is gone is a run that
 * stopped, and taking its folder is fine.
 */
function refuseIfHeld(run) {
  let held;
  try {
    held = JSON.parse(readFileSync(join(run, 'run.json'), 'utf8'));
  } catch {
    return;
  }
  if (held.complete || typeof held.pid !== 'number') return;
  try {
    // Signal 0 asks whether the process exists without touching it.
    process.kill(held.pid, 0);
  } catch {
    return;
  }
  throw new Error(
    `${run} is being written by a run that has not finished: pid ${held.pid}, ` +
      `area ${held.area}, commit ${held.commit}, ${held.done} of ${held.selected} scenarios done, started ${held.startedAt}. ` +
      'Wait for it, or give this run a folder of its own with SHEAF_RUN_NAME.'
  );
}

export async function session(area, { settings = {} } = {}) {
  const { _electron } = loadPlaywright();
  const run = join(RUNS, area);
  refuseIfHeld(run);
  rmSync(run, { recursive: true, force: true });
  mkdirSync(join(run, 'shots'), { recursive: true });
  const ws = join(run, 'ws');
  cpSync(join(REPO, 'sample'), ws, { recursive: true });
  mkdirSync(join(ws, 'e2e'), { recursive: true });
  const userDir = join(run, 'user');
  mkdirSync(join(userDir, 'User'), { recursive: true });
  writeFileSync(
    join(userDir, 'User', 'settings.json'),
    JSON.stringify(
      {
        'workbench.startupEditor': 'none',
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'chat.disableAIFeatures': true,
        'window.restoreWindows': 'none',
        // Dialogs drawn by VS Code rather than the OS, so a save prompt is something a scenario can see and answer.
        'window.dialogStyle': 'custom',
        // The same for menus: the Explorer's right-click menu is a native macOS menu otherwise, which the
        // driver cannot see at all, so a scenario that right-clicks in the workbench finds an empty menu.
        'window.menuStyle': 'custom',
        'telemetry.telemetryLevel': 'off',
        'git.enabled': false,
        'workbench.tips.enabled': false,
        'security.workspace.trust.enabled': false,
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        /*
         * A terminal of the test window's own, which reads no startup files.
         *
         * Without this the integrated terminal starts the machine's normal shell, and
         * that shell runs the person's startup files. On a machine where those attach
         * to a tmux session when there is an SSH connection, the test terminal became
         * that person's live session: every scenario that typed into a terminal typed
         * at their prompt, and an Escape sent to cancel something reached whatever was
         * running there. `zsh -f` reads none of them. The environment below removes
         * the trigger as well, so both would have to fail for this to happen again.
         */
        'terminal.integrated.profiles.osx': {
          // The prompt is how a scenario proves the terminal is this one before typing
          // anything into it. No other shell on the machine shows it.
          'sheaf-test': { path: '/bin/zsh', args: ['-f'], env: { TMUX: null, TMUX_PANE: null, SSH_CONNECTION: null, SSH_CLIENT: null, SSH_TTY: null, PS1: 'sheaf-test% ', PROMPT: 'sheaf-test% ' } },
        },
        'terminal.integrated.defaultProfile.osx': 'sheaf-test',
        'terminal.integrated.profiles.linux': {
          'sheaf-test': { path: '/bin/sh', env: { TMUX: null, TMUX_PANE: null, SSH_CONNECTION: null, SSH_CLIENT: null, SSH_TTY: null, PS1: 'sheaf-test% ' } },
        },
        'terminal.integrated.defaultProfile.linux': 'sheaf-test',
        'terminal.integrated.inheritEnv': false,
        ...settings,
      },
      null,
      2
    )
  );
  // VS Code binds a socket inside the profile, and macOS and Linux cap socket paths near 104 characters, which a
  // temp folder can exceed. A short link in /tmp keeps the path short.
  let link = userDir;
  if (process.platform !== 'win32') {
    link = `/tmp/sheaf-re-${area}`;
    try {
      unlinkSync(link);
    } catch {}
    symlinkSync(userDir, link);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Nothing the test window starts may reach a session belonging to a person. A shell
  // that sees an SSH connection and no tmux will attach itself to one on a machine
  // configured that way, and the window would otherwise inherit both facts from
  // whoever launched it. The terminal profile above is the first defence; this is the
  // second, so a scenario that starts a shell some other way is covered too.
  for (const name of ['TMUX', 'TMUX_PANE', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'SSH_AUTH_SOCK']) delete env[name];
  const app = await _electron.launch({
    executablePath: CODE,
    args: [
      `--user-data-dir=${link}`,
      `--extensions-dir=${join(run, 'ext')}`,
      `--extensionDevelopmentPath=${REPO}`,
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--new-window',
      ws,
    ],
    env,
    timeout: 90000,
  });
  const page = await app.firstWindow();
  platformKeys(page.keyboard);
  await page.waitForSelector('.monaco-workbench', { timeout: 60000 });

  const errors = [];
  const note = (kind, text) => errors.push(`${kind}: ${String(text).slice(0, 400)}`);
  const IGNORE = /local-network-access|allow-scripts and allow-same-origin|Failed to load resource.*(marketplace|update|gallery)|punycode/;
  page.on('console', (m) => m.type() === 'error' && !IGNORE.test(m.text()) && note('console', m.text()));
  page.on('pageerror', (e) => note('pageerror', e.stack || e.message));

  // Sheaf activates once startup finishes; wait for it before opening anything.
  const exthostLog = () => {
    const logs = join(userDir, 'logs');
    if (!existsSync(logs)) return null;
    const latest = readdirSync(logs).sort().at(-1);
    const f = join(logs, latest, 'window1', 'exthost', 'exthost.log');
    return existsSync(f) ? f : null;
  };
  for (let i = 0; i < 120; i++) {
    const f = exthostLog();
    if (f && readFileSync(f, 'utf8').includes('sheafeditor.sheafeditor')) break;
    await sleep(250);
  }
  let exthostSeen = 0;

  let current = null; // path of the file under test
  let lastOpenNote = null; // why the last Quick Open looked wrong, for a failure message to carry

  async function frame() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        let ok = false;
        try {
          ok = await f.evaluate(() => !!document.getElementById('toolbar') && !!document.querySelector('.cm-editor'));
        } catch {}
        if (!ok) continue;
        // Only the editor actually on screen: its webview iframe in the workbench must be visible and on top, so a
        // hidden or background editor's frame is never read or aimed at.
        const parent = f.parentFrame();
        const outer = parent && parent !== page.mainFrame() ? await parent.frameElement().catch(() => null) : null;
        if (outer) {
          const onTop = await outer
            .evaluate((el) => {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              if (cs.visibility === 'hidden' || cs.display === 'none' || r.width < 50 || r.height < 50) return false;
              const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              return !!hit && (hit === el || el.contains(hit));
            })
            .catch(() => false);
          if (!onTop) continue;
        }
        const el = await f.frameElement().catch(() => null);
        const box = el && (await el.boundingBox().catch(() => null));
        if (box && box.width > 50 && box.height > 50) return { f, box };
      }
      await sleep(200);
    }
    throw new Error('no visible Sheaf editor');
  }

  /** Window coordinates for a target: a selector, {sel, hasText, nth}, {text, offset, occurrence, within} or {x, y}. */
  async function locate(target) {
    if (target && typeof target.x === 'number' && target.sel == null && target.text == null) return { ...target, covered: false };
    const spec = typeof target === 'string' ? { sel: target } : target;
    const { f, box } = await frame();
    const r = await f.evaluate(resolveInFrame, spec);
    if (r.error) throw new Error(r.error);
    return { ...r, x: box.x + r.x, y: box.y + r.y };
  }

  async function pointAt(target, force) {
    const p = await locate(target);
    if (p.covered && !force) throw new Error(`${p.what} is covered by ${p.by}, so a click there misses it`);
    return p;
  }

  const S = {
    page,
    app,
    ws,
    run,
    sleep,
    locate,
    frame: async () => (await frame()).f,

    /** The system clipboard, read and written through VS Code itself, so it works on every platform. */
    clipboard: {
      write: (text) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text),
      read: () => app.evaluate(({ clipboard }) => clipboard.readText()),
      /** Put an image file on the clipboard, with text alongside when given, as copying from an app does. */
      writeImage: (path, text) =>
        app.evaluate(({ clipboard, nativeImage }, [p, t]) => {
          const image = nativeImage.createFromPath(p);
          if (t == null) clipboard.writeImage(image);
          else clipboard.write({ image, text: t });
        }, [path, text ?? null]),
      formats: () => app.evaluate(({ clipboard }) => clipboard.availableFormats()),
    },

    /** Open a workspace file (relative to the workspace) in Sheaf with Quick Open. */
    async open(rel) {
      current = join(ws, rel);
      // A webview can hold the keyboard so Quick Open never appears; clicking the active tab gives it back to the workbench.
      // In a split window there is an active tab per group, and the leftmost one belongs to the left group:
      // clicking that moves focus there, and Quick Open then opens the file in the wrong group. Take the
      // active tab of the active group, and fall back to the old selector when no group is marked active.
      const inActiveGroup = page.locator('.editor-group-container.active .tabs-container .tab.active').first();
      const tab = (await inActiveGroup.isVisible().catch(() => false)) ? inActiveGroup : page.locator('.tabs-container .tab.active').first();
      if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => {});
      await page.keyboard.press('Meta+p');
      const shown = await page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 8000 }).then(() => true, () => false);
      if (!shown) {
        await page.locator('.monaco-workbench').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
        await page.keyboard.press('Meta+p');
        await page.waitForSelector('.quick-input-widget input', { state: 'visible' });
      }
      // Fill the input rather than typing at the window. A webview can take the keyboard back
      // mid-word, which leaves the widget holding the first letter and a list of whatever that
      // letter matched, and the scenario then opens the wrong file or none.
      const input = page.locator('.quick-input-widget input').first();
      await page.keyboard.type(rel, { delay: 5 });
      // A webview can take the keyboard back mid-word, which leaves the widget holding the first
      // letter and a list of whatever that letter matched. Type the rest rather than pressing Enter
      // on that list.
      if ((await input.inputValue().catch(() => rel)) !== rel) {
        await input.click().catch(() => {});
        await page.keyboard.type(rel, { delay: 10 });
      }
      // Wait for the file to be the first row rather than pressing Enter on a guess. A file written
      // moments ago is not in the workbench's search index yet, and Enter on a list that has not
      // caught up opens whatever is at the top, or nothing, which then reads as the editor refusing
      // to hold the document.
      const wanted = rel.split('/').pop();
      const listed = async () => {
        const rows = await page.$$eval('.quick-input-list .monaco-list-row', (els) =>
          els.map((e) => e.getAttribute('aria-label') || e.textContent || '')
        ).catch(() => []);
        return rows.length > 0 && rows[0].includes(wanted);
      };
      for (let i = 0; i < 20 && !(await listed()); i++) await sleep(150);
      if (!(await listed())) {
        // Quick Open resolves a typed absolute path without its index, so a file the index has
        // not caught up with is still offered by its full path.
        // In a split window the other group's webview takes the keyboard back between keystrokes,
        // which left the box holding one letter, and clicking the box did not keep it. Start again
        // from the status bar, which holds no webview, as `command` does, and insert the path as one
        // input event so nothing can land between its letters.
        await page.keyboard.press('Escape');
        await page.locator('.statusbar').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
        await page.keyboard.press('Meta+p');
        await page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 8000 }).catch(() => {});
        await page.keyboard.insertText(current);
        for (let i = 0; i < 20 && !(await listed()); i++) await sleep(150);
      }
      if (!(await listed())) {
        // The list never caught up. Enter still goes in, because that is what this has always done
        // and most scenarios recover, but the reason is recorded for the one that does not: a file
        // written moments ago is not in the workbench's search index yet.
        const rows = await page.$$eval('.quick-input-list .monaco-list-row', (els) =>
          els.slice(0, 3).map((e) => e.getAttribute('aria-label') || e.textContent || '')
        ).catch(() => []);
        const typed = await input.inputValue().catch(() => '(unreadable)');
        lastOpenNote = `Quick Open did not offer ${rel}; box ${JSON.stringify(typed)}; rows ${JSON.stringify(rows)}`;
      } else {
        lastOpenNote = null;
      }
      await sleep(200);
      await page.keyboard.press('Enter');
      try {
        await frame();
      } catch {
        // Opened before Sheaf activated: reopen it with Sheaf.
        await S.command('View: Reopen Editor With...');
        await sleep(400);
        await page.keyboard.type('Sheaf');
        await sleep(300);
        await page.keyboard.press('Enter');
        await frame();
      }
      await sleep(600);
      return current;
    },

    /** Write a new file under e2e/ in the workspace and open it in Sheaf. */
    async fresh(name, text) {
      writeFileSync(join(ws, 'e2e', `${name}.md`), text);
      await sleep(300);
      const path = await S.open(`e2e/${name}.md`);
      // Confirm the editor on screen holds this file, not the previous one; reopen once if not.
      // CodeMirror holds LF line breaks and no byte order mark, so compare against that form.
      const want = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
      // With two Sheaf editors open, the frame read by `state` is the one on top, which need not be
      // the one just opened. Accept the file being held by any Sheaf frame, so a scenario that split
      // the editor is not torn down by the recovery below.
      const holds = async () => {
        if (((await S.state().catch(() => ({}))).doc ?? '') === want) return true;
        for (const f of page.frames()) {
          const doc = await f
            .evaluate(() => {
              const content = document.querySelector('.cm-content');
              const tile = content && (content.cmTile || content.cmView);
              return tile?.root?.view?.state?.doc?.toString() ?? tile?.view?.state?.doc?.toString() ?? null;
            })
            .catch(() => null);
          if (doc === want) return true;
        }
        return false;
      };
      if (!(await holds())) {
        await sleep(800);
        if (!(await holds())) {
          // Try the open again before reaching for the cleanup: closing every editor is right for a
          // window holding one, and destroys the setup of a scenario that split the editor on
          // purpose, which then fails with a count and no sign of what happened to its second group.
          await S.open(`e2e/${name}.md`);
          if (!(await holds())) {
            const groups = await page.locator('.editor-group-container').count().catch(() => 1);
            if (groups > 1) {
              const tabs = await page
                .$$eval('.tab', (els) => els.map((e) => e.getAttribute('aria-label')))
                .catch(() => []);
              throw new Error(
                `e2e/${name}.md did not open in any of the ${groups} editor groups. Tabs: ${JSON.stringify(tabs)}. ` +
                  (lastOpenNote ? `${lastOpenNote}. ` : '') +
                  'Not closing them: the window was split on purpose, and the cleanup would hide what went wrong.'
              );
            }
            await S.cleanup().catch(() => {});
            await S.open(`e2e/${name}.md`);
            if (!(await holds())) throw new Error(`the editor on screen does not hold e2e/${name}.md`);
          }
        }
      }
      return path;
    },

    /** Run a command from the Command Palette. */
    async command(title) {
      // While a Sheaf webview holds the keyboard the palette key does nothing; give the workbench focus first.
      await page.locator('.statusbar').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press('Meta+Shift+p');
      const shown = await page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 8000 }).then(() => true, () => false);
      if (!shown) {
        await page.locator('.monaco-workbench').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
        await page.keyboard.press('Meta+Shift+p');
        await page.waitForSelector('.quick-input-widget input', { state: 'visible' });
      }
      await page.keyboard.type(title, { delay: 5 });
      await sleep(500);
      await page.keyboard.press('Enter');
      await sleep(500);
    },

    /** Click a target. Modifiers are held down around the click, as a person holds them. */
    async click(target, { button = 'left', count = 1, modifiers = [], force = false } = {}) {
      const p = await pointAt(target, force);
      for (const m of modifiers) await page.keyboard.down(m);
      await page.mouse.click(p.x, p.y, { button, clickCount: count });
      for (const m of modifiers) await page.keyboard.up(m);
      await sleep(250);
      return p;
    },
    dblclick: (target, o = {}) => S.click(target, { ...o, count: 2 }),
    rightClick: (target, o = {}) => S.click(target, { ...o, button: 'right' }),

    /** Click at a character position in the rendered document: before `text[offset]`. */
    caret: (text, offset = 0, o = {}) => S.click({ text, offset, ...o }),

    /** Drag across rendered text from its first character to its last, as a person selects it. */
    async select(text, { occurrence = 0, within } = {}) {
      const a = await pointAt({ text, offset: 0, occurrence, within });
      const b = await pointAt({ text, offset: text.length, occurrence, within });
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 10 });
      await page.mouse.up();
      await sleep(300);
    },

    async hover(target) {
      const p = await locate(target);
      await page.mouse.move(p.x, p.y, { steps: 5 });
      await sleep(400);
      return p;
    },

    async drag(from, to, { steps = 12 } = {}) {
      const a = await pointAt(from);
      const b = await locate(to);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps });
      await sleep(150);
      await page.mouse.up();
      await sleep(400);
    },

    async type(text) {
      await page.keyboard.type(text, { delay: 15 });
      await sleep(200);
    },
    /** Press keys in turn, separated by spaces: 'End Enter Meta+z'. */
    async press(keys) {
      for (const k of keys.split(' ')) {
        await page.keyboard.press(k);
        await sleep(120);
      }
      await sleep(150);
    },

    /** Click a toolbar control by the start of its title, e.g. 'Bold' or 'Insert'. */
    toolbar: (title, o) => S.click({ sel: '#toolbar button', hasText: title }, o),

    /** Click the visible menu item whose text starts with `label`, in whichever Sheaf menu is open. */
    menu: (label, o) =>
      S.click({ sel: '.sheaf-tb-menu-item, .sheaf-ctx-item, .sheaf-slash-item, .sheaf-block-menu-item, [role="menuitem"], [role="menuitemradio"], [role="option"]', hasText: label }, o),

    /** The editor's selection, document and focus, read from CodeMirror in the Sheaf frame. */
    state: () =>
      S.eval(() => {
        const content = document.querySelector('.cm-content');
        // CodeMirror links the content element to its view through `cmTile.root.view` (older builds: `cmView.view`).
        const tile = content && (content.cmTile || content.cmView);
        const view = tile && ((tile.root && tile.root.view) || tile.view);
        if (!view) return { error: 'no CodeMirror view on .cm-content' };
        const s = view.state.selection.main;
        return { anchor: s.anchor, head: s.head, line: view.state.doc.lineAt(s.head).number, doc: view.state.doc.toString(), focused: view.hasFocus, active: document.activeElement && document.activeElement.className };
      }),

    /** True when a visible element matches. */
    async exists(sel, hasText) {
      try {
        await locate({ sel, hasText });
        return true;
      } catch {
        return false;
      }
    },

    /** Evaluate a function in the Sheaf frame. */
    async eval(fn, arg) {
      const { f } = await frame();
      return f.evaluate(fn, arg);
    },

    /** The file on disk once it has stopped changing (auto-save is debounced). */
    async disk(path = current, { quiet = 800, max = 6000 } = {}) {
      const start = Date.now();
      let last = readFileSync(path, 'utf8');
      let since = Date.now();
      while (Date.now() - start < max) {
        await sleep(150);
        const now = readFileSync(path, 'utf8');
        if (now !== last) {
          last = now;
          since = Date.now();
        } else if (Date.now() - since >= quiet) break;
      }
      return last;
    },

    /** Change the file from outside Sheaf, as git or an agent would. */
    async writeDisk(text, path = current) {
      writeFileSync(path, text);
      await sleep(1200);
    },

    /** Text of the rendered document lines, for checks that need what a person reads. */
    rendered: () => S.eval(() => [...document.querySelectorAll('.cm-content > .cm-line')].map((l) => l.textContent).join('\n')),

    /*
     * The open table cell, whichever kind it is.
     *
     * A Markdown cell edits in a nested editor, so there is no element with a `.value`; a CSV field
     * is still a plain text box. Both answer here: `open` is true for either, `value` is the text
     * being edited, and `rendered` is what a person sees, which for a Markdown cell has its markers
     * hidden. A scenario that asks the page for `input, textarea` sees only the CSV kind.
     */
    cell: () =>
      S.eval(() => {
        const el = document.querySelector('.sheaf-table-input');
        if (!el) return { open: false, kind: null, value: null, rendered: null };
        if ('value' in el) return { open: true, kind: 'text', value: el.value, rendered: el.value };
        const content = el.querySelector('.cm-content');
        const tile = content && (content.cmTile || content.cmView);
        const view = tile?.root?.view ?? tile?.view ?? null;
        return {
          open: true,
          kind: 'markdown',
          value: view ? view.state.doc.toString() : null,
          rendered: content ? content.textContent : null,
        };
      }),

    async shot(name, { clipToEditor = true } = {}) {
      const path = join(run, 'shots', `${name}.png`);
      if (clipToEditor) {
        const { box } = await frame().catch(() => ({ box: null }));
        await page.screenshot({ path, ...(box ? { clip: { x: box.x, y: Math.max(0, box.y - 40), width: box.width, height: Math.min(box.height + 40, 900) } } : {}) });
      } else await page.screenshot({ path });
      return path;
    },

    /** Console errors from the window and webviews, plus extension host errors, since the last call. */
    async errors() {
      const out = errors.splice(0);
      const f = exthostLog();
      if (f) {
        const lines = readFileSync(f, 'utf8').split('\n');
        for (const line of lines.slice(exthostSeen)) if (/\[error\]/.test(line) && /sheaf/i.test(line)) out.push(`exthost: ${line.slice(0, 400)}`);
        exthostSeen = lines.length;
      }
      return out;
    },

    /** Close every editor so the next scenario starts clean. */
    async cleanup() {
      await page.keyboard.press('Escape').catch(() => {});
      // Close editors one at a time with revert, so an editor left with unsaved changes never raises a save prompt
      // and nothing stays open to be read by mistake.
      for (let i = 0; i < 15; i++) {
        const tabs = await page.locator('.tabs-container .tab').count().catch(() => 0);
        if (!tabs) break;
        await S.command('View: Revert and Close Editor').catch(() => {});
        await sleep(350);
        if (await page.locator('.monaco-dialog-box').isVisible().catch(() => false)) await page.keyboard.press('Escape');
      }
      const left = await page.locator('.tabs-container .tab').count().catch(() => 0);
      if (left) throw new Error(`cleanup left ${left} editor(s) open`);
    },

    async quit() {
      await app.close().catch(() => {});
      if (link !== userDir) {
        try {
          unlinkSync(link);
        } catch {}
      }
    },
  };
  return S;
}

/** Show a string with its line breaks visible, for detail messages. */
export const show = (s) => JSON.stringify(s);
