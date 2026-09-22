// E2E scenarios for how Sheaf lives inside VS Code, driven by clicks in a real window:
// the Explorer, the editor title bar (which Sheaf leaves empty), the Command Palette, Settings (written to the
// profile's settings.json, which VS Code watches), split editors and color themes.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { show } from '../session.mjs';

const DEF = 'sheaf.useAsDefaultMarkdownEditor';
const ASSOC = 'workbench.editorAssociations';
const j = (x) => JSON.stringify(x);

// ---- Settings -----------------------------------------------------------------

const userSettingsPath = (S) => join(S.run, 'user', 'User', 'settings.json');
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
};
/** Change user settings the way the Settings editor does: VS Code notices the file change. `undefined` removes a key. */
async function setUser(S, patch, wait = 1800) {
  const cur = readJson(userSettingsPath(S));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete cur[k];
    else cur[k] = v;
  }
  writeFileSync(userSettingsPath(S), JSON.stringify(cur, null, 2));
  await S.sleep(wait);
}
const wsSettingsPath = (S) => join(S.ws, '.vscode', 'settings.json');
async function setWorkspace(S, obj, wait = 2200) {
  mkdirSync(join(S.ws, '.vscode'), { recursive: true });
  writeFileSync(wsSettingsPath(S), JSON.stringify(obj, null, 2));
  await S.sleep(wait);
}
/** Put settings back so the next scenario starts from defaults. */
async function resetSettings(S, keys) {
  await setUser(S, Object.fromEntries(keys.map((k) => [k, undefined])), 1500);
  const cur = readJson(userSettingsPath(S));
  if (cur[ASSOC]) await setUser(S, { [ASSOC]: undefined }, 1200);
  if (existsSync(wsSettingsPath(S))) {
    rmSync(join(S.ws, '.vscode'), { recursive: true, force: true });
    await S.sleep(1500);
  }
}

// ---- Workbench ------------------------------------------------------------------

/** Write a file at the workspace root, where the Explorer lists it without expanding folders. */
async function rootFile(S, name, text) {
  writeFileSync(join(S.ws, name), text);
  await S.sleep(1500);
  return join(S.ws, name);
}

async function explorerRow(S, name) {
  const row = S.page.locator(`.explorer-folders-view .monaco-list-row[aria-label="${name}"]`).first();
  // The explorer draws only the rows in view. After a long run the workspace root holds
  // enough files that a new one sits below the fold and is not in the page at all, so
  // scroll the list towards it, as a person would, before waiting for it.
  const list = S.page.locator('.explorer-folders-view .monaco-list').first();
  if (!(await row.isVisible().catch(() => false))) {
    const box = await list.boundingBox().catch(() => null);
    if (box) {
      await S.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await S.page.mouse.wheel(0, -20000);
      await S.sleep(200);
    }
  }
  for (let i = 0; i < 40 && !(await row.isVisible().catch(() => false)); i++) {
    const box = await list.boundingBox().catch(() => null);
    if (!box) break;
    await S.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await S.page.mouse.wheel(0, 300);
    await S.sleep(120);
  }
  await row.waitFor({ state: 'visible', timeout: 8000 });
  const b = await row.boundingBox();
  return { x: b.x + Math.min(60, b.width / 2), y: b.y + b.height / 2 };
}
async function clickExplorer(S, name, { button = 'left', modifiers = [] } = {}) {
  const p = await explorerRow(S, name);
  for (const m of modifiers) await S.page.keyboard.down(m);
  await S.page.mouse.click(p.x, p.y, { button });
  for (const m of modifiers) await S.page.keyboard.up(m);
  await S.sleep(button === 'right' ? 700 : 1500);
}
async function contextItems(S) {
  return S.page.$$eval('.context-view .monaco-menu .action-label', (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
}
async function clickContextItem(S, label) {
  const item = S.page.locator('.context-view .monaco-menu .action-item', { hasText: label }).first();
  await item.waitFor({ state: 'visible', timeout: 4000 });
  const b = await item.boundingBox();
  await S.page.mouse.click(b.x + 30, b.y + b.height / 2);
  await S.sleep(1800);
}

/** Visible Sheaf frames, left to right. */
async function sheafFrames(S) {
  const out = [];
  for (const f of S.page.frames()) {
    if (f === S.page.mainFrame()) continue;
    let ok = false;
    try {
      ok = await f.evaluate(() => !!document.getElementById('toolbar') && !!document.querySelector('.cm-editor'));
    } catch {}
    if (!ok) continue;
    const el = await f.frameElement().catch(() => null);
    const box = el && (await el.boundingBox().catch(() => null));
    // A Sheaf tab in the background keeps its webview alive with a box but hidden. The hidden style
    // sits on the outer webview element, and Sheaf's editor runs in a frame nested inside it, which
    // reports itself visible. Walk out to the page and require every frame in the chain to be visible.
    let seen = !!el;
    for (let cur = f; seen && cur && cur !== S.page.mainFrame(); cur = cur.parentFrame()) {
      const e = await cur.frameElement().catch(() => null);
      seen = e ? await e.evaluate((n) => (n.checkVisibility ? n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true)).catch(() => false) : false;
    }
    if (seen && box && box.width > 50 && box.height > 50) out.push({ f, box });
  }
  return out.sort((a, b) => a.box.x - b.box.x);
}

/** Close every editor, answering Don't Save, so a dirty tab cannot block the next scenario. */
async function closeAllDiscard(S) {
  for (let i = 0; i < 4; i++) {
    await S.page.keyboard.press('Escape');
    await S.command('View: Close All Editors');
    await S.sleep(600);
    if (!(await dialogUp(S))) return;
    const dont = S.page.locator('.monaco-dialog-box .monaco-button', { hasText: "Don't Save" }).first();
    const b = await dont.boundingBox().catch(() => null);
    if (b) await S.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await S.sleep(600);
  }
}

/** What the active editor group shows: 'sheaf', 'text', or something else, plus its tab labels. */
async function activeEditor(S) {
  await S.sleep(600);
  const group = S.page.locator('.editor-group-container.active');
  const text = await group.locator('.editor-container .monaco-editor').first().isVisible().catch(() => false);
  const gbox = await group.boundingBox().catch(() => null);
  const frames = await sheafFrames(S);
  const inGroup = gbox ? frames.filter(({ box }) => box.x >= gbox.x - 2 && box.x < gbox.x + gbox.width) : [];
  const tabs = await group.locator('.tab').evaluateAll((els) => els.map((e) => ({ label: e.getAttribute('aria-label'), active: e.classList.contains('active'), dirty: e.classList.contains('dirty') }))).catch(() => []);
  const kind = inGroup.length ? 'sheaf' : text ? 'text' : 'other';
  return { kind, tabs, activeTab: (tabs.find((t) => t.active) || {}).label };
}

/** Lines of the text editor in the given group (0 = leftmost), as shown. */
async function textEditorLines(S, groupIndex = null) {
  return S.page.evaluate((gi) => {
    const groups = [...document.querySelectorAll('.editor-group-container')].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const g = gi == null ? document.querySelector('.editor-group-container.active') : groups[gi];
    const lines = [...g.querySelectorAll('.editor-container .view-lines .view-line')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return lines.map((l) => l.textContent.replace(/ /g, ' '));
  }, groupIndex);
}

/** Window coordinates of a character in the text editor of a group, for a mouse click. */
async function textEditorPoint(S, groupIndex, text, offset = 0) {
  const r = await S.page.evaluate(
    ({ gi, text, offset }) => {
      const groups = [...document.querySelectorAll('.editor-group-container')].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const root = groups[gi].querySelector('.editor-container .view-lines');
      if (!root) return { error: 'no text editor in that group' };
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode()); ) {
        const i = n.data.replace(/ /g, ' ').indexOf(text);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i + offset);
        range.setEnd(n, Math.min(n.data.length, i + offset + 1));
        const rect = range.getBoundingClientRect();
        return { x: rect.left + 1, y: rect.top + rect.height / 2 };
      }
      return { error: `text not in text editor: ${text}` };
    },
    { gi: groupIndex, text, offset }
  );
  if (r.error) throw new Error(r.error);
  return r;
}

/** Click a character inside a specific Sheaf frame (for two Sheaf editors side by side). */
async function clickInFrame(S, fr, text, offset = 0, opts = {}) {
  const r = await fr.f.evaluate(
    ({ text, offset }) => {
      const root = document.querySelector('.cm-content');
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode()); ) {
        const i = n.data.indexOf(text);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i + offset);
        range.setEnd(n, i + offset + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + 1, y: rect.top + rect.height / 2 };
      }
      return { error: `text not in frame: ${text}` };
    },
    { text, offset }
  );
  if (r.error) throw new Error(r.error);
  await S.page.mouse.click(fr.box.x + r.x, fr.box.y + r.y, opts);
  await S.sleep(300);
}
/**
 * Click a toolbar button inside one Sheaf editor, named by its title. `S.toolbar` goes
 * to whichever frame the harness is pointed at; a split window needs the button of a
 * particular group, which is the one inside that group's own webview.
 */
async function clickToolbarInFrame(S, fr, title) {
  const r = await fr.f.evaluate((title) => {
    const btn = [...document.querySelectorAll('#toolbar button')].find((b) => (b.getAttribute('title') || '').startsWith(title));
    if (!btn) return { error: `no toolbar button starting "${title}"` };
    const rect = btn.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, title);
  if (r.error) throw new Error(r.error);
  await S.page.mouse.click(fr.box.x + r.x, fr.box.y + r.y);
  await S.sleep(1500);
}
const frameDoc = (fr) =>
  fr.f.evaluate(() => {
    const c = document.querySelector('.cm-content');
    const t = c.cmTile || c.cmView;
    const v = (t.root && t.root.view) || t.view;
    const s = v.state.selection.main;
    return { doc: v.state.doc.toString(), head: s.head, rendered: [...document.querySelectorAll('.cm-content > .cm-line')].map((l) => l.textContent).join('\n'), source: !!document.querySelector('.source-mode'), font: getComputedStyle(document.querySelector('.cm-content')).fontFamily };
  });

const toasts = (S) => S.page.$$eval('.notifications-toasts .notification-list-item-message', (els) => els.map((e) => e.textContent.trim()));

/** Report every failed check by name, with what was on screen behind them. */
const all = (checks, detail) => {
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { ok: failed.length === 0, detail: failed.length ? `failed: ${failed.join(', ')}; ${j(detail)}` : '' };
};

/** True when one of the notices names `text` as what a write from outside took. */
const saidItTook = (said, text) => said.some((t) => t.includes(`your last change is gone: "${text}"`));

/**
 * A tool writing the whole file from text it read earlier, and what Sheaf says about
 * it. Returns once the editor is showing that file, with the notifications on screen.
 */
async function staleWrite(S, path, text, until) {
  writeFileSync(path, text);
  for (let i = 0; i < 120; i++) {
    const st = await S.state().catch(() => null);
    if (st && typeof st.doc === 'string' && st.doc.includes(until)) {
      await S.sleep(300); // The notice goes up a moment after the document arrives.
      return toasts(S);
    }
    await S.sleep(50);
  }
  throw new Error(`the write from outside never reached the editor (waiting for ${j(until)})`);
}
const dialogUp = (S) => S.page.locator('.monaco-dialog-box').isVisible().catch(() => false);

async function reopenWith(S, editorName) {
  await S.command('View: Reopen Editor With...');
  await S.sleep(400);
  await S.page.keyboard.type(editorName, { delay: 5 });
  await S.sleep(400);
  await S.page.keyboard.press('Enter');
  await S.sleep(1500);
}

/** Sheaf on the left and the text editor on the right, on one file. */
async function sheafAndText(S, name, text) {
  await S.fresh(name, text);
  await S.command('View: Split Editor Right');
  await S.sleep(1500);
  await reopenWith(S, 'Text Editor');
  const frames = await sheafFrames(S);
  if (frames.length !== 1) throw new Error(`expected one Sheaf editor beside the text editor, found ${frames.length}`);
  return frames[0];
}

const firstLine = (s) => s.split('\n')[0];

// ---- Theme measurement, run in the Sheaf frame -----------------------------------

function measureColors(opts) {
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
  const lum = (c) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
  };
  const cs = (sel, prop, pseudo) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el, pseudo)[prop] : null;
  };
  const bg = rgba(getComputedStyle(document.body).backgroundColor);
  const vscodeBg = rgba(getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim());
  const text = over(rgba(cs('.cm-line', 'color')), bg);
  const out = {
    bodyClass: document.body.className,
    bg: bg.join(','),
    matchesThemeBg: bg.slice(0, 3).join() === vscodeBg.slice(0, 3).join(),
    text: contrast(text, bg),
    // The Bold button: always enabled, unlike Undo, which starts greyed out.
    toolbarIcon: contrast(over(rgba(getComputedStyle([...document.querySelectorAll('#toolbar button')].find((b) => (b.title || '').startsWith('Bold'))).color), bg), bg),
    link: cs('.tok-link', 'color') ? contrast(over(rgba(cs('.tok-link', 'color')), bg), bg) : null,
    code: cs('.tok-inline-code', 'color') ? contrast(over(rgba(cs('.tok-inline-code', 'color')), over(rgba(cs('.tok-inline-code', 'backgroundColor')), bg)), over(rgba(cs('.tok-inline-code', 'backgroundColor')), bg)) : null,
  };
  if (opts && opts.selection) {
    const layer = document.querySelector('.cm-selectionBackground');
    const selBg = layer ? rgba(getComputedStyle(layer).backgroundColor) : rgba(cs('.cm-line', 'backgroundColor', '::selection'));
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(opts.selection));
    const pseudoColor = line && getComputedStyle(line, '::selection').color;
    const fg = rgba(pseudoColor && pseudoColor !== getComputedStyle(line).color ? pseudoColor : getComputedStyle(line).color);
    const selOver = over(selBg, bg);
    out.selectionLayer = !!layer;
    out.selectionBg = selOver.map(Math.round).join(',');
    out.selectedText = contrast(over(fg, selOver), selOver);
  }
  return out;
}

async function withTheme(S, theme, fn) {
  try {
    await setUser(S, { 'workbench.colorTheme': theme }, 2500);
    return await fn();
  } finally {
    await setUser(S, { 'workbench.colorTheme': undefined }, 2000);
  }
}
const THEME_DOC = 'Plain text with a [link](https://example.com) and `code` here.\n\n## Heading\n\nSecond paragraph of words.\n';

const BOLD_DOC = 'Say hello to the world today.\n\nA **bold** word here.\n\n## Heading two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nLast line\n';

export const scenarios = [
  // ---------------------------------------------------------------- host.default-editor
  {
    id: 'host.default-editor.e01',
    feature: 'host.default-editor',
    name: 'Clicking a .md file in the Explorer opens it in Sheaf',
    run: async (S) => {
      await rootFile(S, 'de-one.md', '# One\n\nBody **bold**.\n');
      await clickExplorer(S, 'de-one.md');
      const ed = await activeEditor(S);
      const r = ed.kind === 'sheaf' ? await S.rendered() : '';
      return { ok: ed.kind === 'sheaf' && r.includes('Body bold.'), detail: `${j(ed)} rendered ${show(r)}` };
    },
  },
  {
    id: 'host.default-editor.e02',
    feature: 'host.default-editor',
    name: 'With the setting off, clicking a .md file opens the text editor and settings gain the association',
    run: async (S) => {
      await rootFile(S, 'de-two.md', '# Two\n');
      try {
        await setUser(S, { [DEF]: false }, 2500);
        const assoc = readJson(userSettingsPath(S))[ASSOC];
        await clickExplorer(S, 'de-two.md');
        const ed = await activeEditor(S);
        return { ok: ed.kind === 'text' && assoc && assoc['*.md'] === 'default' && assoc['*.markdown'] === 'default', detail: `${j(ed)} associations ${j(assoc)}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.default-editor.e03',
    feature: 'host.default-editor',
    name: 'Turning the setting off and back on opens .md files in Sheaf again and removes the association',
    run: async (S) => {
      await rootFile(S, 'de-three.md', '# Three\n');
      try {
        await setUser(S, { [DEF]: false }, 2500);
        await setUser(S, { [DEF]: true }, 2500);
        const assoc = readJson(userSettingsPath(S))[ASSOC];
        await clickExplorer(S, 'de-three.md');
        const ed = await activeEditor(S);
        return { ok: ed.kind === 'sheaf' && !(assoc && assoc['*.md']), detail: `${j(ed)} associations ${j(assoc)}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.default-editor.e04',
    feature: 'host.default-editor',
    name: 'An editor already open in Sheaf keeps working after the setting is turned off',
    run: async (S) => {
      await S.fresh('de-open', 'Some words here.\n');
      try {
        await setUser(S, { [DEF]: false }, 2500);
        await S.caret('words', 2);
        await S.type('Z');
        const d = await S.disk();
        const ed = await activeEditor(S);
        return { ok: ed.kind === 'sheaf' && d === 'Some woZrds here.\n', detail: `${j(ed.kind)} disk ${show(d)}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.default-editor.e05',
    feature: 'host.default-editor',
    name: 'A .md association to another editor survives the setting being turned off and on',
    run: async (S) => {
      await rootFile(S, 'de-five.md', '# Five\n');
      try {
        await setUser(S, { [ASSOC]: { '*.md': 'vscode.markdown.preview.editor' } }, 1500);
        await setUser(S, { [DEF]: false }, 2500);
        const off = readJson(userSettingsPath(S))[ASSOC];
        await setUser(S, { [DEF]: true }, 2500);
        const on = readJson(userSettingsPath(S))[ASSOC];
        await clickExplorer(S, 'de-five.md');
        const ed = await activeEditor(S);
        return { ok: off['*.md'] === 'vscode.markdown.preview.editor' && on['*.md'] === 'vscode.markdown.preview.editor' && ed.kind !== 'sheaf', detail: `off ${j(off)} on ${j(on)} opened ${j(ed)}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.default-editor.e06',
    feature: 'host.default-editor',
    name: 'A .markdown file follows the setting both ways',
    run: async (S) => {
      await rootFile(S, 'de-six.markdown', '# Six\n\nText.\n');
      try {
        await setUser(S, { [DEF]: false }, 2500);
        await clickExplorer(S, 'de-six.markdown');
        const off = await activeEditor(S);
        await S.cleanup();
        await setUser(S, { [DEF]: true }, 2500);
        await clickExplorer(S, 'de-six.markdown');
        const on = await activeEditor(S);
        return { ok: off.kind === 'text' && on.kind === 'sheaf', detail: `off ${off.kind}, on ${on.kind}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.default-editor.e07',
    feature: 'host.default-editor',
    name: 'Turning Sheaf off for one workspace and then removing that workspace setting opens .md files in Sheaf again',
    run: async (S) => {
      await rootFile(S, 'de-seven.md', '# Seven\n');
      try {
        await setWorkspace(S, { [DEF]: false });
        const mid = readJson(wsSettingsPath(S));
        const midCur = readJson(wsSettingsPath(S));
        delete midCur[DEF];
        await setWorkspace(S, midCur);
        const after = readJson(wsSettingsPath(S));
        await clickExplorer(S, 'de-seven.md');
        const ed = await activeEditor(S);
        return { ok: ed.kind === 'sheaf', detail: `opened in ${ed.kind}; workspace settings while off ${j(mid)}, after removing the setting ${j(after)}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.default-editor.e08',
    feature: 'host.default-editor',
    name: 'Off in user settings but on in this workspace opens .md files in Sheaf here',
    run: async (S) => {
      await rootFile(S, 'de-eight.md', '# Eight\n');
      try {
        await setUser(S, { [DEF]: false }, 2500);
        await setWorkspace(S, { [DEF]: true });
        await clickExplorer(S, 'de-eight.md');
        const ed = await activeEditor(S);
        return { ok: ed.kind === 'sheaf', detail: `opened in ${ed.kind}; user associations ${j(readJson(userSettingsPath(S))[ASSOC])}; workspace ${j(readJson(wsSettingsPath(S)))}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.default-editor.e09',
    feature: 'host.default-editor',
    name: 'Flipping the setting off and on four times quickly ends with .md opening in Sheaf',
    run: async (S) => {
      await rootFile(S, 'de-nine.md', '# Nine\n');
      try {
        for (const v of [false, true, false, true]) await setUser(S, { [DEF]: v }, 250);
        await S.sleep(3000);
        const assoc = readJson(userSettingsPath(S))[ASSOC];
        await clickExplorer(S, 'de-nine.md');
        const ed = await activeEditor(S);
        return { ok: ed.kind === 'sheaf' && !(assoc && assoc['*.md']), detail: `${ed.kind}; associations ${j(assoc)}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.default-editor.e10',
    feature: 'host.default-editor',
    name: 'An association to an earlier name (nib.wysiwyg) is cleared when the setting is set on, and .md opens in Sheaf',
    run: async (S) => {
      await rootFile(S, 'de-ten.md', '# Ten\n');
      try {
        await setUser(S, { [ASSOC]: { '*.md': 'nib.wysiwyg' } }, 1500);
        await setUser(S, { [DEF]: true }, 2500);
        const assoc = readJson(userSettingsPath(S))[ASSOC];
        await clickExplorer(S, 'de-ten.md');
        const ed = await activeEditor(S);
        return { ok: ed.kind === 'sheaf' && !(assoc && assoc['*.md']), detail: `${ed.kind}; associations ${j(assoc)}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },

  // ---------------------------------------------------------------- host.open-in-sheaf
  {
    id: 'host.open-in-sheaf.e01',
    feature: 'host.open-in-sheaf',
    name: 'With Sheaf not the default, right-click > Open in Sheaf on a .md file opens it in Sheaf',
    run: async (S) => {
      await rootFile(S, 'ois-one.md', '# Heading\n\nA **bold** word.\n');
      try {
        await setUser(S, { [DEF]: false }, 2500);
        await clickExplorer(S, 'ois-one.md', { button: 'right' });
        await clickContextItem(S, 'Open in Sheaf');
        const ed = await activeEditor(S);
        const r = ed.kind === 'sheaf' ? await S.rendered() : '';
        return { ok: ed.kind === 'sheaf' && r.includes('A bold word.'), detail: `${j(ed)} ${show(r)}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.open-in-sheaf.e02',
    feature: 'host.open-in-sheaf',
    name: 'Right-clicking a .txt file does not offer Open in Sheaf',
    run: async (S) => {
      await rootFile(S, 'ois-two.txt', 'plain\n');
      await clickExplorer(S, 'ois-two.txt', { button: 'right' });
      const items = await contextItems(S);
      await S.page.keyboard.press('Escape');
      return { ok: items.length > 3 && !items.includes('Open in Sheaf'), detail: j(items) };
    },
  },
  {
    id: 'host.open-in-sheaf.e03',
    feature: 'host.open-in-sheaf',
    name: 'A file named NOTES.MD opens in Sheaf, and its right-click menu offers Open in Sheaf',
    run: async (S) => {
      await rootFile(S, 'OIS-NOTES.MD', '# Upper\n\nText.\n');
      await clickExplorer(S, 'OIS-NOTES.MD');
      const ed = await activeEditor(S);
      await clickExplorer(S, 'OIS-NOTES.MD', { button: 'right' });
      const items = await contextItems(S);
      await S.page.keyboard.press('Escape');
      return { ok: items.includes('Open in Sheaf'), detail: `click opened ${ed.kind}; menu ${j(items)}` };
    },
  },
  {
    id: 'host.open-in-sheaf.e04',
    feature: 'host.open-in-sheaf',
    name: 'Open in Sheaf on a file already open in Sheaf keeps one tab for it',
    run: async (S) => {
      await rootFile(S, 'ois-four.md', 'Four words here.\n');
      await clickExplorer(S, 'ois-four.md');
      await clickExplorer(S, 'ois-four.md', { button: 'right' });
      await clickContextItem(S, 'Open in Sheaf');
      const ed = await activeEditor(S);
      const count = ed.tabs.filter((t) => (t.label || '').startsWith('ois-four.md')).length;
      return { ok: ed.kind === 'sheaf' && count === 1, detail: j(ed) };
    },
  },
  {
    id: 'host.open-in-sheaf.e05',
    feature: 'host.open-in-sheaf',
    name: 'Sheaf: Open in Sheaf from the Command Palette turns the active text editor into Sheaf',
    run: async (S) => {
      await rootFile(S, 'ois-five.md', 'Five **words** here.\n');
      try {
        await setUser(S, { [DEF]: false }, 2500);
        await clickExplorer(S, 'ois-five.md');
        const p = await textEditorPoint(S, 0, 'Five', 1);
        await S.page.mouse.click(p.x, p.y);
        await S.command('Sheaf: Open in Sheaf');
        await S.sleep(1500);
        const ed = await activeEditor(S);
        const r = ed.kind === 'sheaf' ? await S.rendered() : '';
        return { ok: ed.kind === 'sheaf' && r.includes('Five words here.'), detail: `${j(ed)} ${show(r)}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.open-in-sheaf.e06',
    feature: 'host.open-in-sheaf',
    name: 'Sheaf: Open in Sheaf run while a Sheaf editor is active does not say there is no Markdown file',
    run: async (S) => {
      await S.fresh('ois-six', 'Six words.\n');
      await S.caret('words', 1);
      await S.command('Sheaf: Open in Sheaf');
      await S.sleep(800);
      const t = await toasts(S);
      return { ok: !t.some((m) => /no Markdown file/i.test(m)), detail: `notifications ${j(t)}` };
    },
  },
  {
    id: 'host.open-in-sheaf.e07',
    feature: 'host.open-in-sheaf',
    name: 'Unsaved typing in the text editor shows in Sheaf after Open in Sheaf, with no save prompt',
    run: async (S) => {
      const path = await rootFile(S, 'ois-seven.md', 'Seven words.\n');
      try {
        await setUser(S, { [DEF]: false }, 2500);
        await clickExplorer(S, 'ois-seven.md');
        const p = await textEditorPoint(S, 0, 'words', 2);
        await S.page.mouse.click(p.x, p.y);
        await S.type('Z');
        await clickExplorer(S, 'ois-seven.md', { button: 'right' });
        await clickContextItem(S, 'Open in Sheaf');
        const dlg = await dialogUp(S);
        const ed = await activeEditor(S);
        const r = ed.kind === 'sheaf' ? await S.rendered() : '';
        return { ok: !dlg && ed.kind === 'sheaf' && r.includes('woZrds'), detail: `dialog ${dlg}; ${ed.kind}; rendered ${show(r)}; disk ${show(readFileSync(path, 'utf8'))}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },
  {
    id: 'host.open-in-sheaf.e08',
    feature: 'host.open-in-sheaf',
    name: 'Two .md files selected in the Explorer both open with Open in Sheaf',
    run: async (S) => {
      await rootFile(S, 'ois-eight-a.md', 'Eight A\n');
      await rootFile(S, 'ois-eight-b.md', 'Eight B\n');
      try {
        await setUser(S, { [DEF]: false }, 2500);
        await clickExplorer(S, 'ois-eight-a.md');
        await clickExplorer(S, 'ois-eight-b.md', { modifiers: ['Meta'] });
        await clickExplorer(S, 'ois-eight-b.md', { button: 'right' });
        await clickContextItem(S, 'Open in Sheaf');
        await S.sleep(1000);
        const labels = await S.page.$$eval('.tab', (els) => els.map((e) => e.getAttribute('aria-label')));
        // Judge by the Sheaf editors and what each one holds, not by a tab label. The Explorer click
        // that built the selection also opened a preview text editor, so the first tab whose label
        // starts with a file's name can be that preview while the file also has a Sheaf tab.
        //
        // Every Sheaf frame, not only the visible ones: two editors in one group means one of them is
        // in the background, and a background tab keeps its webview alive holding its own document.
        const held = [];
        for (const f of S.page.frames()) {
          if (f === S.page.mainFrame()) continue;
          const isSheaf = await f
            .evaluate(() => !!document.getElementById('toolbar') && !!document.querySelector('.cm-editor'))
            .catch(() => false);
          if (!isSheaf) continue;
          const doc = await f
            .evaluate(() => {
              const content = document.querySelector('.cm-content');
              const tile = content && (content.cmTile || content.cmView);
              return tile?.root?.view?.state?.doc?.toString() ?? tile?.view?.state?.doc?.toString() ?? null;
            })
            .catch(() => null);
          if (doc !== null) held.push(doc.trim());
        }
        const both = ['Eight A', 'Eight B'].every((text) => held.includes(text));
        return { ok: both, detail: `${held.length} Sheaf editors holding ${j(held)}; tabs ${j(labels)}` };
      } finally {
        await resetSettings(S, [DEF]);
      }
    },
  },

  {
    id: 'host.open-in-sheaf.e09',
    feature: 'host.open-in-sheaf',
    name: 'Sheaf: Open in Sheaf with no editor open says there is nothing to open',
    run: async (S) => {
      // Click an empty spot of the editor area first, as a person would before reaching for the palette.
      const area = await S.page.locator('.editor-group-container.active').boundingBox();
      await S.page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
      await S.command('Sheaf: Open in Sheaf');
      await S.sleep(800);
      const t = await toasts(S);
      const ed = await activeEditor(S);
      return { ok: t.some((m) => /no Markdown file/i.test(m)) && ed.tabs.length === 0, detail: `notifications ${j(t)} tabs ${j(ed.tabs)}` };
    },
  },

  // ---------------------------------------------------------------- host.open-raw
  {
    id: 'host.open-raw.e01',
    feature: 'host.open-raw',
    name: 'Sheaf puts nothing in the editor title bar, so that bar holds what VS Code draws for any editor',
    run: async (S) => {
      await S.fresh('raw-one', 'A **bold** word.\n');
      await S.caret('word', 1);
      await S.sleep(400);
      // Every action the bar is drawing, by the name a person would read on hover. A
      // contribution with no icon renders as its whole title, so Sheaf's would be the
      // widest label there and impossible to miss.
      const labels = await S.page
        .locator('.editor-group-container.active .editor-actions .action-label')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent || '').filter(Boolean));
      const sheafs = labels.filter((l) => /sheaf|raw markdown/i.test(l));
      return { ok: sheafs.length === 0, detail: `title bar offers ${j(labels)}; Sheaf's own ${j(sheafs)}` };
    },
  },
  {
    id: 'host.open-raw.e02',
    feature: 'host.open-raw',
    name: "Clicking the toolbar's Open raw Markdown button shows the file in the text editor",
    run: async (S) => {
      await S.fresh('raw-two', 'Two **bold** words.\n');
      await S.toolbar('Open raw Markdown');
      await S.sleep(1500);
      const ed = await activeEditor(S);
      const lines = ed.kind === 'text' ? await textEditorLines(S) : [];
      return { ok: ed.kind === 'text' && lines[0] === 'Two **bold** words.', detail: `${j(ed)} lines ${j(lines)}` };
    },
  },
  {
    id: 'host.open-raw.e03',
    feature: 'host.open-raw',
    name: 'Open as Raw Markdown (Text) from the Command Palette shows the Sheaf file in the text editor',
    run: async (S) => {
      await S.fresh('raw-three', 'Three **bold** words.\n');
      await S.caret('words', 1);
      await S.command('Open as Raw Markdown (Text)');
      await S.sleep(1500);
      const ed = await activeEditor(S);
      const lines = ed.kind === 'text' ? await textEditorLines(S) : [];
      return { ok: ed.kind === 'text' && lines[0] === 'Three **bold** words.', detail: `${j(ed)} lines ${j(lines)}` };
    },
  },
  {
    id: 'host.open-raw.e04',
    feature: 'host.open-raw',
    name: 'With auto-save off, an unsaved Sheaf edit shows in the raw text editor and nothing asks to save',
    run: async (S) => {
      const path = await S.fresh('raw-four', 'Four words.\n');
      try {
        await setUser(S, { 'sheaf.autoSave': false }, 1800);
        await S.caret('words', 2);
        await S.type('Z');
        await S.sleep(1200);
        await S.toolbar('Open raw Markdown');
        await S.sleep(1500);
        const dlg = await dialogUp(S);
        const ed = await activeEditor(S);
        const lines = ed.kind === 'text' ? await textEditorLines(S) : [];
        const disk = readFileSync(path, 'utf8');
        return { ok: !dlg && ed.kind === 'text' && lines[0] === 'Four woZrds.' && disk === 'Four words.\n', detail: `dialog ${dlg}; ${ed.kind}; lines ${j(lines)}; disk ${show(disk)}` };
      } finally {
        await S.cleanup();
        if (await dialogUp(S)) {
          const dont = S.page.locator('.monaco-dialog-box .monaco-button', { hasText: "Don't Save" }).first();
          const b = await dont.boundingBox().catch(() => null);
          if (b) await S.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        }
        await resetSettings(S, ['sheaf.autoSave']);
      }
    },
  },
  {
    id: 'host.open-raw.e05',
    feature: 'host.open-raw',
    name: 'Going to raw text and back to Sheaf leaves the file byte for byte as it was',
    run: async (S) => {
      const text = 'Title\n=====\n\n*  loose   list\n*  item\n\n|a|b|\n|-|-|\n|1|2|\n\nTrailing spaces  \nend';
      await rootFile(S, 'raw-five.md', text);
      await clickExplorer(S, 'raw-five.md');
      await S.sleep(1200);
      // The palette rather than the toolbar: this scenario is about the bytes surviving
      // the round trip, and the toolbar's own press is covered by e02.
      await S.command('Open as Raw Markdown (Text)');
      await S.sleep(1500);
      await clickExplorer(S, 'raw-five.md', { button: 'right' });
      await clickContextItem(S, 'Open in Sheaf');
      const ed = await activeEditor(S);
      await S.sleep(1500);
      const disk = readFileSync(join(S.ws, 'raw-five.md'), 'utf8');
      return { ok: ed.kind === 'sheaf' && disk === text, detail: `${ed.kind}; disk ${show(disk)}` };
    },
  },
  {
    id: 'host.open-raw.e06',
    feature: 'host.open-raw',
    name: 'From the Command Palette in a raw text editor, the command does not switch to a different file that is open in Sheaf',
    run: async (S) => {
      await S.fresh('raw-six-a', 'File A words.\n');
      await S.caret('words', 1);
      // c.md is switched over to the text editor, so the only Sheaf editor left is a.md's, in the background.
      await S.fresh('raw-six-c', 'File C words.\n');
      await reopenWith(S, 'Text Editor');
      const before = await activeEditor(S);
      const p = await textEditorPoint(S, 0, 'File C', 2);
      await S.page.mouse.click(p.x, p.y);
      await S.command('Open as Raw Markdown (Text)');
      await S.sleep(1500);
      const after = await activeEditor(S);
      return { ok: before.kind === 'text' && (after.activeTab || '').startsWith('raw-six-c.md'), detail: `before ${j(before)} after ${j(after)}` };
    },
  },
  {
    id: 'host.open-raw.e07',
    feature: 'host.open-raw',
    name: 'The way out of Sheaf travels with the Sheaf editor, and the raw text editor carries none of it',
    run: async (S) => {
      await S.fresh('raw-seven', 'Seven words.\n');
      // Sheaf's chrome is inside its own webview, so leaving Sheaf takes it away with it.
      const onSheaf = await S.eval(() => !!document.querySelector('#toolbar button[title^="Open raw Markdown"]'));
      await S.toolbar('Open raw Markdown');
      await S.sleep(1500);
      const p = await textEditorPoint(S, 0, 'Seven', 1);
      await S.page.mouse.click(p.x, p.y);
      await S.sleep(500);
      const chrome = await S.page.evaluate(() => ({
        frames: document.querySelectorAll('iframe.webview').length,
        title: [...document.querySelectorAll('.editor-group-container.active .editor-actions .action-label')]
          .map((e) => e.getAttribute('aria-label') || e.textContent || '')
          .filter((l) => /sheaf|raw markdown/i.test(l)),
      }));
      return { ok: onSheaf && chrome.title.length === 0, detail: `toolbar button in Sheaf ${onSheaf}; on text, title bar offers ${j(chrome.title)} and ${chrome.frames} webviews remain` };
    },
  },
  {
    id: 'host.open-raw.e08',
    feature: 'host.open-raw',
    name: 'Two Sheaf files side by side: the left toolbar opens the left file, not the focused right one',
    run: async (S) => {
      await S.fresh('raw-eight-left', 'Left file words.\n');
      await S.command('View: Split Editor Right');
      // Wait for the second group rather than sleeping at it: the command runs while the webview
      // still holds the keyboard often enough that a fixed wait leaves one group and no clue why.
      await S.page.locator('.editor-group-container').nth(1).waitFor({ state: 'visible', timeout: 8000 });
      await S.sleep(600);
      const afterSplit = await S.page.evaluate(() => ({
        groups: document.querySelectorAll('.editor-group-container').length,
        tabs: [...document.querySelectorAll('.tab')].map((t) => t.getAttribute('aria-label')),
      }));
      await S.fresh('raw-eight-right', 'Right file words.\n');
      const frames = await sheafFrames(S);
      if (frames.length < 2) {
        // Say what the window actually holds: a count on its own cannot tell a split that did not
        // happen from a webview the visibility walk refused.
        const seen = await S.page.evaluate(() => ({
          groups: document.querySelectorAll('.editor-group-container').length,
          tabs: [...document.querySelectorAll('.tab')].map((t) => t.getAttribute('aria-label')),
          webviews: [...document.querySelectorAll('iframe.webview')].map((el) => ({
            w: Math.round(el.getBoundingClientRect().width),
            visible: el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : null,
          })),
        }));
        return { ok: false, detail: `expected two Sheaf editors, found ${frames.length}; after the split ${j(afterSplit)}; now ${j(seen)}` };
      }
      await clickInFrame(S, frames[1], 'Right', 2);
      // The left group is not the active one, so the first press on it goes to activating
      // the group rather than to the button under the pointer. That is VS Code's own
      // click-to-focus and a person meets it too; what this scenario is about is which
      // file the button acts on once it is pressed, not how many presses that takes.
      await clickToolbarInFrame(S, frames[0], 'Open raw Markdown');
      const still = await sheafFrames(S);
      if (still.length > 1) await clickToolbarInFrame(S, still[0], 'Open raw Markdown');
      const left = await textEditorLines(S, 0).catch(() => []);
      const framesAfter = await sheafFrames(S);
      const rightDoc = framesAfter.length ? (await frameDoc(framesAfter[framesAfter.length - 1])).doc : '';
      return { ok: left[0] === 'Left file words.' && rightDoc === 'Right file words.\n', detail: `left text editor ${j(left)}; right Sheaf ${show(rightDoc)}; Sheaf frames after the first press ${still.length}, at the end ${framesAfter.length}` };
    },
  },

  {
    id: 'host.open-raw.e09',
    feature: 'host.open-raw',
    name: 'Open as Raw Markdown (Text) from the Command Palette after closing the only Sheaf editor opens nothing and shows no error',
    run: async (S) => {
      await S.fresh('raw-nine', 'Nine words.\n');
      const close = S.page.locator('.tab.active .tab-actions .action-label').first();
      const b = await close.boundingBox();
      await S.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await S.sleep(1200);
      await S.command('Open as Raw Markdown (Text)');
      await S.sleep(1200);
      const ed = await activeEditor(S);
      const t = await toasts(S);
      return { ok: ed.tabs.length === 0 && !t.some((m) => /error|failed/i.test(m)), detail: `tabs ${j(ed.tabs)} notifications ${j(t)}` };
    },
  },

  // ---------------------------------------------------------------- host.source-mode
  {
    id: 'host.source-mode.e01',
    feature: 'host.source-mode',
    name: 'Toggle Whole-Document Source Mode shows the Markdown markers of the whole document',
    run: async (S) => {
      await S.fresh('src-one', BOLD_DOC);
      await S.caret('hello', 2);
      const before = await S.rendered();
      await S.command('Toggle Whole-Document Source Mode');
      await S.sleep(600);
      const after = await S.rendered();
      await S.shot('host.source-mode.e01-after');
      return { ok: after.includes('**bold**') && after.includes('## Heading two'), detail: `before ${show(before)} after ${show(after)}` };
    },
  },
  {
    id: 'host.source-mode.e02',
    feature: 'host.source-mode',
    name: 'Toggling source mode twice returns to the rendered view and leaves the file unchanged',
    run: async (S) => {
      const path = await S.fresh('src-two', BOLD_DOC);
      await S.caret('hello', 2);
      const before = await S.rendered();
      await S.command('Toggle Whole-Document Source Mode');
      await S.caret('hello', 2);
      await S.command('Toggle Whole-Document Source Mode');
      await S.sleep(600);
      const after = await S.rendered();
      const disk = await S.disk(path);
      const src = await S.eval(() => !!document.querySelector('.source-mode'));
      return { ok: after === before && disk === BOLD_DOC && !src, detail: `source class ${src}; after ${show(after)}; disk same ${disk === BOLD_DOC}` };
    },
  },
  {
    id: 'host.source-mode.e03',
    feature: 'host.source-mode',
    name: 'Typing in source mode lands in the file where the click put the caret',
    run: async (S) => {
      await S.fresh('src-three', BOLD_DOC);
      await S.caret('hello', 2);
      await S.command('Toggle Whole-Document Source Mode');
      await S.sleep(500);
      await S.caret('world', 2);
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === BOLD_DOC.replace('world', 'woZrld'), detail: show(firstLine(d)) };
    },
  },
  {
    id: 'host.source-mode.e04',
    feature: 'host.source-mode',
    name: 'With one file in two Sheaf editors, source mode switches only the one it was run in',
    run: async (S) => {
      await S.fresh('src-four', BOLD_DOC);
      await S.command('View: Split Editor Right');
      await S.sleep(1500);
      const frames = await sheafFrames(S);
      if (frames.length < 2) return { ok: false, detail: `expected two Sheaf editors, found ${frames.length}` };
      await clickInFrame(S, frames[0], 'hello', 2);
      await S.command('Toggle Whole-Document Source Mode');
      await S.sleep(600);
      const [l, r] = await Promise.all([frameDoc(frames[0]), frameDoc(frames[1])]);
      return { ok: l.source && !r.source, detail: `left source ${l.source} (${l.font}); right source ${r.source} (${r.font})` };
    },
  },
  {
    id: 'host.source-mode.e05',
    feature: 'host.source-mode',
    name: 'Run from a raw text editor, the command leaves a background Sheaf editor as it was',
    run: async (S) => {
      await S.fresh('src-five-a', BOLD_DOC);
      await S.caret('hello', 2);
      // Keep a.md's Sheaf tab, and switch the c.md tab over to the text editor so no Sheaf editor is left for c.md.
      await S.fresh('src-five-c', 'C file words.\n');
      await reopenWith(S, 'Text Editor');
      const p = await textEditorPoint(S, 0, 'C file', 1);
      await S.page.mouse.click(p.x, p.y);
      await S.command('Toggle Whole-Document Source Mode');
      await S.sleep(500);
      const tab = S.page.locator('.tab[aria-label^="src-five-a.md"]').first();
      const b = await tab.boundingBox();
      await S.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await S.sleep(1200);
      const src = await S.eval(() => !!document.querySelector('.source-mode'));
      return { ok: !src, detail: `src-five-a.md is in source mode: ${src}` };
    },
  },
  {
    id: 'host.source-mode.e06',
    feature: 'host.source-mode',
    name: 'Source mode stays on when the file changes on disk',
    run: async (S) => {
      await S.fresh('src-six', BOLD_DOC);
      await S.caret('hello', 2);
      await S.command('Toggle Whole-Document Source Mode');
      await S.sleep(500);
      await S.writeDisk(BOLD_DOC.replace('Last line', 'Last line changed by git'));
      const src = await S.eval(() => !!document.querySelector('.source-mode'));
      const r = await S.rendered();
      await S.hover({ text: 'changed by git', offset: 1 });
      return { ok: src && r.includes('changed by git'), detail: `source ${src}; ${show(r.split('\n').at(-2))}` };
    },
  },
  {
    id: 'host.source-mode.e07',
    feature: 'host.source-mode',
    name: 'A table shows as its pipe rows in source mode',
    run: async (S) => {
      await S.fresh('src-seven', BOLD_DOC);
      await S.caret('hello', 2);
      await S.command('Toggle Whole-Document Source Mode');
      await S.sleep(600);
      const r = await S.rendered();
      const grid = await S.exists('.sheaf-table');
      return { ok: r.includes('| a | b |') && !grid, detail: `grid still shown ${grid}; rendered ${show(r)}` };
    },
  },
  {
    id: 'host.source-mode.e08',
    feature: 'host.source-mode',
    name: 'Selecting text by dragging in source mode does not bring up the floating formatting toolbar',
    run: async (S) => {
      await S.fresh('src-eight', BOLD_DOC);
      await S.caret('hello', 2);
      await S.command('Toggle Whole-Document Source Mode');
      await S.sleep(500);
      await S.select('hello to the');
      await S.sleep(500);
      const tb = await S.exists('.sheaf-seltb');
      return { ok: !tb, detail: `floating toolbar visible ${tb}` };
    },
  },
  {
    id: 'host.source-mode.e09',
    feature: 'host.source-mode',
    name: 'Source mode switches the document to a monospace font',
    run: async (S) => {
      await S.fresh('src-nine', BOLD_DOC);
      await S.caret('hello', 2);
      const before = await S.eval(() => getComputedStyle(document.querySelector('.cm-content')).fontFamily);
      await S.command('Toggle Whole-Document Source Mode');
      await S.sleep(500);
      const after = await S.eval(() => getComputedStyle(document.querySelector('.cm-content')).fontFamily);
      return { ok: before !== after && /mono|Menlo|Consolas|Courier/i.test(after), detail: `before ${before} after ${after}` };
    },
  },

  // ---------------------------------------------------------------- host.autosave
  {
    id: 'host.autosave.e01',
    feature: 'host.autosave',
    name: 'Typing a word reaches the file without saving, and the tab does not stay dirty',
    run: async (S) => {
      await S.fresh('as-one', 'Some words here.\n');
      await S.caret('words', 5);
      await S.type(' more');
      const d = await S.disk();
      const ed = await activeEditor(S);
      const dirty = ed.tabs.some((t) => t.dirty);
      return { ok: d === 'Some words more here.\n' && !dirty, detail: `disk ${show(d)} dirty ${dirty}` };
    },
  },
  {
    id: 'host.autosave.e02',
    feature: 'host.autosave',
    name: 'Typing with pauses long enough to save mid-sentence keeps every character in order',
    run: async (S) => {
      await S.fresh('as-two', 'Start\n');
      await S.caret('Start', 2);
      await S.press('End');
      for (const part of [' one', ' two', ' three']) {
        await S.type(part);
        await S.sleep(1100);
      }
      await S.type(' four');
      const d = await S.disk();
      return { ok: d === 'Start one two three four\n', detail: show(d) };
    },
  },
  {
    id: 'host.autosave.e03',
    feature: 'host.autosave',
    name: 'With sheaf.autoSave off, typing leaves the file unsaved until Cmd+S',
    run: async (S) => {
      const path = await S.fresh('as-three', 'Some words.\n');
      try {
        await setUser(S, { 'sheaf.autoSave': false }, 1800);
        await S.caret('words', 2);
        await S.type('Z');
        await S.sleep(2000);
        const unsaved = readFileSync(path, 'utf8');
        const dirty = (await activeEditor(S)).tabs.some((t) => t.dirty);
        await S.press('Meta+s');
        const saved = await S.disk(path);
        return { ok: unsaved === 'Some words.\n' && dirty && saved === 'Some woZrds.\n', detail: `before save ${show(unsaved)} dirty ${dirty}; after Cmd+S ${show(saved)}` };
      } finally {
        await resetSettings(S, ['sheaf.autoSave']);
      }
    },
  },
  {
    id: 'host.autosave.e04',
    feature: 'host.autosave',
    name: 'Turning sheaf.autoSave back on saves the next edit, earlier unsaved typing included',
    run: async (S) => {
      const path = await S.fresh('as-four', 'Some words.\n');
      try {
        await setUser(S, { 'sheaf.autoSave': false }, 1800);
        await S.caret('words', 2);
        await S.type('X');
        await setUser(S, { 'sheaf.autoSave': true }, 1800);
        await S.caret('Some', 2);
        await S.type('Y');
        const d = await S.disk(path);
        return { ok: d === 'SoYme woXrds.\n', detail: show(d) };
      } finally {
        await resetSettings(S, ['sheaf.autoSave']);
      }
    },
  },
  {
    id: 'host.autosave.e05',
    feature: 'host.autosave',
    name: 'Typing and closing the tab straight away saves the typing and asks nothing',
    run: async (S) => {
      const path = await S.fresh('as-five', 'Some words.\n');
      await S.caret('words', 2);
      await S.type('Z');
      const tab = S.page.locator('.tab.active .tab-actions .action-label').first();
      const b = await tab.boundingBox();
      // A click the length a person's is: the press, then the release about a tenth of a
      // second later. A synthetic click with no time between the two is shorter than any
      // hand makes, and races the page's report that focus has gone.
      await S.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await S.page.mouse.down();
      await S.sleep(100);
      await S.page.mouse.up();
      await S.sleep(800);
      const dlg = await dialogUp(S);
      const msg = dlg ? await S.page.locator('.monaco-dialog-box').innerText().catch(() => '') : '';
      await S.sleep(1500);
      const d = readFileSync(path, 'utf8');
      if (dlg) {
        const save = S.page.locator('.monaco-dialog-box .monaco-button', { hasText: /^Save$/ }).first();
        const sb = await save.boundingBox().catch(() => null);
        if (sb) await S.page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2);
      }
      return { ok: !dlg && d === 'Some woZrds.\n', detail: `dialog ${dlg} ${show(msg.slice(0, 120))}; disk ${show(d)}` };
    },
  },
  {
    id: 'host.autosave.e06',
    feature: 'host.autosave',
    name: 'With trailing-whitespace trimming on for Markdown, pausing after a space and typing on keeps the space',
    run: async (S) => {
      await S.fresh('as-six', 'Start\n');
      try {
        await setUser(S, { '[markdown]': { 'files.trimTrailingWhitespace': true } }, 1800);
        await S.caret('Start', 2);
        await S.press('End');
        await S.type(' hello ');
        await S.sleep(1600);
        await S.type('world');
        const d = await S.disk();
        return { ok: d === 'Start hello world\n', detail: show(d) };
      } finally {
        await resetSettings(S, ['[markdown]']);
      }
    },
  },
  {
    id: 'host.autosave.e10',
    feature: 'host.autosave',
    name: 'VS Code’s own editor is the control: the same keystrokes with trimming on give the same file in both',
    run: async (S) => {
      // Sheaf spares the line the caret is on when a save participant trims it, so a
      // space typed mid-thought survives until the person moves off the line. Whether
      // that matches VS Code is not something to reason about: this runs the same
      // keystrokes in the text editor beside it and compares the two files.
      const keystrokes = async () => {
        await S.caret('Start', 2).catch(() => {});
        await S.press('End');
        await S.type(' hello ');
        await S.sleep(1800);
        await S.type('world');
        await S.sleep(1800);
      };
      let sheaf = null;
      let text = null;
      try {
        await setUser(S, { '[markdown]': { 'files.trimTrailingWhitespace': true } }, 1800);
        await S.fresh('trim-sheaf', 'Start\n');
        await keystrokes();
        sheaf = await S.disk();

        // The same file, the same keys, in VS Code's editor. It does not save by itself,
        // so the control needs the setting that makes it, or the trim never runs.
        await setUser(S, { 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 1000 }, 1800);
        const path = await S.fresh('trim-text', 'Start\n');
        await reopenWith(S, 'Text Editor');
        const p = await textEditorPoint(S, 0, 'Start', 4);
        await S.page.mouse.click(p.x, p.y);
        await S.press('End');
        await S.type(' hello ');
        await S.sleep(2200);
        await S.type('world');
        await S.sleep(2200);
        text = readFileSync(path, 'utf8');
      } finally {
        await resetSettings(S, ['[markdown]', 'files.autoSave', 'files.autoSaveDelay']);
      }
      return {
        ok: sheaf === text,
        detail: `Sheaf wrote ${show(sheaf)}; VS Code's own editor wrote ${show(text)}`,
      };
    },
  },
  {
    id: 'host.autosave.e11',
    feature: 'host.autosave',
    name: 'The control again, for an explicit save: Cmd+S with trimming on gives the same file in both',
    run: async (S) => {
      // Auto-save and an explicit save are two different rules in VS Code: the
      // participant spares a cursor's whitespace on the first and trims everything on
      // the second. Sheaf saves by itself, so this asks what a deliberate Cmd+S does.
      let sheaf = null;
      let text = null;
      try {
        await setUser(S, { '[markdown]': { 'files.trimTrailingWhitespace': true } }, 1800);
        await S.fresh('trim-s-sheaf', 'Start\n');
        await S.caret('Start', 2);
        await S.press('End');
        await S.type(' hello ');
        await S.press('Meta+s');
        await S.sleep(1800);
        sheaf = await S.disk();

        const path = await S.fresh('trim-s-text', 'Start\n');
        await reopenWith(S, 'Text Editor');
        const p = await textEditorPoint(S, 0, 'Start', 4);
        await S.page.mouse.click(p.x, p.y);
        await S.press('End');
        await S.type(' hello ');
        await S.press('Meta+s');
        await S.sleep(1800);
        text = readFileSync(path, 'utf8');
      } finally {
        await resetSettings(S, ['[markdown]']);
      }
      return {
        ok: sheaf === text,
        detail: `Sheaf wrote ${show(sheaf)}; VS Code's own editor wrote ${show(text)}`,
      };
    },
  },
  {
    id: 'host.autosave.e07',
    feature: 'host.autosave',
    name: 'With insert-final-newline on, typing at the end of a file with no newline stays on the same line across a save',
    run: async (S) => {
      await S.fresh('as-seven', 'No newline at the end');
      try {
        await setUser(S, { 'files.insertFinalNewline': true }, 1800);
        await S.caret('end', 1);
        await S.press('End');
        await S.type(' A');
        await S.sleep(1600);
        await S.type(' B');
        const d = await S.disk();
        return { ok: d === 'No newline at the end A B\n', detail: show(d) };
      } finally {
        await resetSettings(S, ['files.insertFinalNewline']);
      }
    },
  },
  {
    id: 'host.autosave.e08',
    feature: 'host.autosave',
    name: 'Clicking Undo until it greys out puts the saved file back byte for byte',
    run: async (S) => {
      const text = 'First line.\n\nSecond line.\n';
      await S.fresh('as-eight', text);
      await S.caret('First', 2);
      await S.type('AB');
      await S.sleep(1100);
      await S.caret('Second', 3);
      await S.type('CD');
      await S.disk();
      for (let i = 0; i < 12; i++) {
        const enabled = await S.eval(() => {
          const b = [...document.querySelectorAll('#toolbar button')].find((x) => (x.title || '').startsWith('Undo'));
          return b && !b.disabled;
        });
        if (!enabled) break;
        await S.toolbar('Undo');
      }
      const d = await S.disk();
      return { ok: d === text, detail: show(d) };
    },
  },
  {
    id: 'host.autosave.e09',
    feature: 'host.autosave',
    name: "With VS Code's own files.autoSave afterDelay also on, typing saves once and shows no conflict",
    run: async (S) => {
      await S.fresh('as-nine', 'Some words.\n');
      try {
        await setUser(S, { 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 500 }, 1800);
        await S.caret('words', 2);
        await S.type('Z1');
        await S.sleep(300);
        await S.type('Z2');
        const d = await S.disk();
        await S.sleep(800);
        const t = await toasts(S);
        return { ok: d === 'Some woZ1Z2rds.\n' && !t.some((m) => /newer|conflict|failed to save/i.test(m)), detail: `disk ${show(d)} notifications ${j(t)}` };
      } finally {
        await resetSettings(S, ['files.autoSave', 'files.autoSaveDelay']);
      }
    },
  },

  // ---------------------------------------------------------------- host.edit-sync
  {
    id: 'host.edit-sync.e01',
    feature: 'host.edit-sync',
    name: 'CRLF file: typing a letter changes only that letter on disk and keeps every CRLF',
    run: async (S) => {
      const text = 'Line one\r\nLine two\r\nLine three\r\n';
      await S.fresh('es-one', text);
      await S.caret('two', 1);
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'Line one\r\nLine tZwo\r\nLine three\r\n', detail: show(d) };
    },
  },
  {
    id: 'host.edit-sync.e02',
    feature: 'host.edit-sync',
    name: 'CRLF file: Enter at the end of a line adds a line ending in CRLF',
    run: async (S) => {
      await S.fresh('es-two', 'Line one\r\n\r\nLine two\r\n\r\nLine three\r\n');
      await S.caret('two', 1);
      await S.press('End');
      await S.press('Enter');
      await S.type('New');
      const d = await S.disk();
      return { ok: /^Line one\r\n\r\nLine two\r\n(\r\n)?New\r\n\r\nLine three\r\n$/.test(d) && !/[^\r]\n/.test(d), detail: show(d) };
    },
  },
  {
    id: 'host.edit-sync.e03',
    feature: 'host.edit-sync',
    name: 'CRLF file: typing then clicking Undo puts the bytes back exactly',
    run: async (S) => {
      const text = 'Line one\r\nLine two\r\n';
      await S.fresh('es-three', text);
      await S.caret('two', 1);
      await S.type('XY');
      await S.disk();
      await S.toolbar('Undo');
      await S.sleep(300);
      const d1 = await S.disk();
      if (d1 !== text) await S.toolbar('Undo');
      const d = await S.disk();
      return { ok: d === text, detail: show(d) };
    },
  },
  {
    id: 'host.edit-sync.e04',
    feature: 'host.edit-sync',
    name: 'Typing a sentence as fast as the keyboard sends it keeps every character in the file',
    run: async (S) => {
      await S.fresh('es-four', 'Start\n');
      await S.caret('Start', 2);
      await S.press('End');
      const typed = ' the quick brown fox jumps over the lazy dog 0123456789';
      await S.page.keyboard.type(typed, { delay: 0 });
      await S.sleep(300);
      const d = await S.disk();
      const shown = (await S.state()).doc;
      return { ok: d === `Start${typed}\n` && shown === d, detail: `disk ${show(d)} Sheaf ${show(shown)}` };
    },
  },
  {
    id: 'host.edit-sync.e05',
    feature: 'host.edit-sync',
    name: 'Replacing a selected emoji with another emoji writes exactly the new emoji',
    run: async (S) => {
      await S.fresh('es-five', 'Face \u{1F600} here\n');
      await S.select('\u{1F600}');
      await S.page.keyboard.insertText('\u{1F603}');
      const d = await S.disk();
      return { ok: d === 'Face \u{1F603} here\n', detail: show(d) };
    },
  },
  {
    id: 'host.edit-sync.e06',
    feature: 'host.edit-sync',
    name: 'Typing at the very start and very end of the document writes only those characters',
    run: async (S) => {
      await S.fresh('es-six', 'Alpha words\n\nOmega words');
      await S.caret('Alpha', 0);
      await S.type('A');
      await S.caret('Omega', 2);
      await S.press('Meta+ArrowDown');
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'AAlpha words\n\nOmega wordsZ', detail: show(d) };
    },
  },
  {
    id: 'host.edit-sync.e07',
    feature: 'host.edit-sync',
    name: 'Clicking into an empty file and typing writes exactly what was typed',
    run: async (S) => {
      await S.fresh('es-seven', '');
      await S.click({ sel: '.cm-content' });
      await S.type('Hello');
      const d = await S.disk();
      return { ok: d === 'Hello', detail: show(d) };
    },
  },
  {
    id: 'host.edit-sync.e08',
    feature: 'host.edit-sync',
    name: 'Selecting everything and deleting it leaves an empty file',
    run: async (S) => {
      await S.fresh('es-eight', 'One\n\nTwo\n\nThree\n');
      await S.caret('Two', 1);
      await S.press('Meta+a');
      await S.press('Backspace');
      const d = await S.disk();
      const st = await S.state();
      return { ok: d === '', detail: `disk ${show(d)} focused ${st.focused}` };
    },
  },
  {
    id: 'host.edit-sync.e09',
    feature: 'host.edit-sync',
    name: 'In a 330 KB handbook, typing one letter changes only that letter on disk',
    run: async (S) => {
      const src = readFileSync(join(S.ws, 'stress', 'long-handbook.md'), 'utf8');
      const path = await S.fresh('es-nine', src);
      // A plain sentence on screen, and a word in it long enough to click into the middle of. The word
      // has to come from the rendered viewport: the click helper only searches what is drawn, and a word
      // taken from the source can sit thousands of lines below the fold, which is where an edit to the
      // corpus put this one.
      const shown = (await S.rendered()).split('\n');
      const line = shown.find((l) => l.length > 40 && !/[#|>*`_\[\]]/.test(l) && l.split(' ').length > 4);
      const word = line && line.split(/\s+/).find((w) => /^[a-z]{5,}$/.test(w));
      if (!word) return { ok: false, detail: `no ordinary sentence on screen to type into; first lines ${show(shown.slice(0, 12))}` };
      await S.caret(word, 1);
      await S.type('Z');
      const d = await S.disk(path, { max: 10000 });
      let i = 0;
      while (i < src.length && src[i] === d[i]) i++;
      const ok = d.length === src.length + 1 && d[i] === 'Z' && d.slice(0, i) + d.slice(i + 1) === src;
      return { ok, detail: `length ${src.length} -> ${d.length}; first difference at ${i}: ${show(d.slice(Math.max(0, i - 20), i + 20))}` };
    },
  },
  {
    id: 'host.edit-sync.e10',
    feature: 'host.edit-sync',
    name: 'A file without a final newline still has none after an edit',
    run: async (S) => {
      await S.fresh('es-ten', 'Alpha beta gamma');
      await S.caret('beta', 2);
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'Alpha beZta gamma', detail: show(d) };
    },
  },
  {
    id: 'host.edit-sync.e11',
    feature: 'host.edit-sync',
    name: 'Typing CJK text into the middle of a word writes it where it was typed',
    run: async (S) => {
      await S.fresh('es-eleven', 'Mixed words here\n');
      await S.caret('words', 2);
      await S.page.keyboard.insertText('日本語');
      const d = await S.disk();
      return { ok: d === 'Mixed wo日本語rds here\n', detail: show(d) };
    },
  },
  {
    id: 'host.edit-sync.e12',
    feature: 'host.edit-sync',
    name: 'A file with mixed line endings comes out of Sheaf exactly as it comes out of VS Code\'s own editor',
    run: async (S) => {
      // Typing one letter into a file that mixes CRLF and LF, once in Sheaf and once in the text editor,
      // and comparing the two files. An absolute expectation here would be testing VS Code: it rewrites
      // the whole file to one ending on save, and Sheaf's promise is that a person loses nothing by
      // using Sheaf instead of the editor beside it.
      const text = 'crlf one\r\n\r\nlf two\n\nlf three\n';
      await S.fresh('es-twelve-sheaf', text);
      await S.caret('three', 1);
      await S.type('Z');
      const inSheaf = await S.disk();

      const path = await S.fresh('es-twelve-text', text);
      await reopenWith(S, 'Text Editor');
      const p = await textEditorPoint(S, 0, 'three', 1);
      await S.page.mouse.click(p.x, p.y);
      await S.type('Z');
      await S.press('Meta+s');
      const inTextEditor = await S.disk(path);

      const kept = inSheaf === 'crlf one\r\n\r\nlf two\n\nlf tZhree\n';
      return {
        ok: inSheaf === inTextEditor,
        detail: `Sheaf ${show(inSheaf)}; text editor ${show(inTextEditor)}; mixed endings ${kept ? 'kept by both' : 'normalised by both, as VS Code does'}`,
      };
    },
  },
  {
    id: 'host.edit-sync.e15',
    feature: 'host.edit-sync',
    name: 'Pasting text with carriage returns into a CRLF file leaves one carriage return per line',
    run: async (S) => {
      // The conversion to CRLF on the way out has to be idempotent: a replacement that already carries a
      // carriage return must not gain a second one. A paste is the nearest a person gets to that input,
      // because the clipboard can hold CRLF even though the editor normalises what it keeps. Both this
      // and e16 pass against the code that had the doubling bug, so neither is its guard: they check the
      // outcome a person can see, and the internal one is host.edit-sync.u04.
      const path = await S.fresh('es-fifteen', 'one\r\ntwo\r\n\r\nthree\r\n');
      await S.clipboard.write('alpha\r\nbeta');
      await S.caret('three', 0);
      await S.press('Meta+v');
      const d = await S.disk(path);
      const doubled = /\r\r\n/.test(d);
      const lf = /(^|[^\r])\n/.test(d);
      return { ok: !doubled && !lf, detail: `${show(d)}${doubled ? ' (a doubled carriage return)' : ''}${lf ? ' (a bare line feed)' : ''}` };
    },
  },
  {
    id: 'host.edit-sync.e16',
    feature: 'host.edit-sync',
    name: 'Pasting a spreadsheet range into a table in a CRLF file leaves one carriage return per line',
    run: async (S) => {
      // The grid writes its own lines rather than going through the editor's input, so it reaches the
      // conversion by a different path from prose.
      const doc = 'Intro.\r\n\r\n| n | v |\r\n| - | - |\r\n| a | 1 |\r\n| b | 2 |\r\n\r\nAfter.\r\n';
      const path = await S.fresh('es-sixteen', doc);
      await S.clipboard.write('x\t9\r\ny\t8');
      await S.click({ sel: '.sheaf-table [data-r="0"][data-c="0"]' });
      await S.press('Meta+v');
      const d = await S.disk(path);
      const doubled = /\r\r\n/.test(d);
      const want = doc.replace('| a | 1 |', '| x | 9 |').replace('| b | 2 |', '| y | 8 |');
      return { ok: !doubled && d === want, detail: `${show(d)}${doubled ? ' (a doubled carriage return)' : ''}` };
    },
  },
  {
    id: 'host.edit-sync.e14',
    feature: 'host.edit-sync',
    name: 'Typing a sentence at full keyboard speed, four times over, never leaves Sheaf showing different text from the file',
    run: async (S) => {
      const rounds = [];
      for (let i = 0; i < 4; i++) {
        await closeAllDiscard(S);
        const path = await S.fresh(`es-fourteen-${i}`, 'Start\n');
        await S.caret('Start', 2);
        await S.press('End');
        const typed = ' the quick brown fox jumps over the lazy dog 0123456789';
        await S.page.keyboard.type(typed, { delay: 0 });
        await S.sleep(400);
        const d = await S.disk(path);
        const shown = (await S.state()).doc;
        rounds.push({ disk: d === `Start${typed}\n`, sheaf: shown === `Start${typed}\n`, shown: shown.slice(0, 40) });
      }
      return { ok: rounds.every((r) => r.disk && r.sheaf), detail: j(rounds) };
    },
  },

  // ---------------------------------------------------------------- host.outside-change
  {
    id: 'host.outside-change.e01',
    feature: 'host.outside-change',
    name: 'A word changed on disk shows in Sheaf',
    run: async (S) => {
      await S.fresh('oc-one', 'Hello old world.\n\nSecond paragraph.\n');
      await S.caret('Second', 2);
      await S.writeDisk('Hello new world.\n\nSecond paragraph.\n');
      const r = await S.rendered();
      return { ok: r.startsWith('Hello new world.'), detail: show(r) };
    },
  },
  {
    id: 'host.outside-change.e02',
    feature: 'host.outside-change',
    name: 'After a line is added on disk above the caret, typing lands in the same word',
    run: async (S) => {
      await S.fresh('oc-two', 'First paragraph.\n\nSecond paragraph.\n');
      await S.caret('Second', 2);
      await S.writeDisk('New top line.\n\nFirst paragraph.\n\nSecond paragraph.\n');
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'New top line.\n\nFirst paragraph.\n\nSeZcond paragraph.\n', detail: show(d) };
    },
  },
  {
    id: 'host.outside-change.e03',
    feature: 'host.outside-change',
    name: 'After the caret line is deleted on disk, typing does not bring the deleted line back',
    run: async (S) => {
      await S.fresh('oc-three', 'Keep one.\n\nDelete me.\n\nKeep two.\n');
      await S.caret('Delete', 2);
      await S.writeDisk('Keep one.\n\nKeep two.\n');
      await S.type('Z');
      const d = await S.disk();
      return { ok: !d.includes('Delete') && d.includes('Keep one.') && d.includes('Keep two.') && d.includes('Z'), detail: show(d) };
    },
  },
  {
    id: 'host.outside-change.e04',
    feature: 'host.outside-change',
    name: 'A disk change arriving before the typing has saved loses neither silently',
    run: async (S) => {
      const path = await S.fresh('oc-four', 'Top line.\n\nBottom line.\n');
      await S.caret('Bottom', 2);
      await S.type('abc');
      writeFileSync(path, 'Top line changed.\n\nBottom line.\n');
      await S.sleep(3000);
      const d = readFileSync(path, 'utf8');
      const shown = (await S.state()).doc;
      const t = await toasts(S);
      const both = d.includes('changed') && d.includes('Boabcttom');
      const noticed = t.length > 0 && shown.includes('Boabcttom');
      return { ok: both || noticed, detail: `disk ${show(d)}; Sheaf ${show(shown)}; notifications ${j(t)}` };
    },
  },
  {
    id: 'host.outside-change.e05',
    feature: 'host.outside-change',
    name: 'The same bytes written to disk again leave the caret where it was',
    run: async (S) => {
      const text = 'Alpha words.\n\nBeta words.\n';
      await S.fresh('oc-five', text);
      await S.caret('Beta', 2);
      await S.writeDisk(text);
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'Alpha words.\n\nBeZta words.\n', detail: show(d) };
    },
  },
  {
    id: 'host.outside-change.e06',
    feature: 'host.outside-change',
    name: 'A line added on disk at the top of a long document keeps the scrolled-to text on screen',
    run: async (S) => {
      const src = readFileSync(join(S.ws, 'stress', 'long-handbook.md'), 'utf8').slice(0, 60000);
      await S.fresh('oc-six', src);
      // Page Down rather than the wheel: a wheel event does not reach the webview from the driver, and
      // the scroller is .cm-scroller, not .sheaf-root, which reports 0 however far the document has moved.
      await S.caret('Operations Handbook', 2);
      for (let i = 0; i < 12; i++) await S.press('PageDown');
      await S.sleep(600);
      const probe = () =>
        S.eval(() => {
          const sc = document.querySelector('.cm-scroller');
          const r = sc.getBoundingClientRect();
          // The first line with text at or below the sampling point, so an empty line does not read as nothing.
          const lines = [...document.querySelectorAll('.cm-line')]
            .map((l) => ({ l, box: l.getBoundingClientRect() }))
            .filter(({ box, l }) => box.top >= r.top + 100 && l.textContent.trim());
          return { top: Math.round(sc.scrollTop), text: lines.length ? lines[0].l.textContent.slice(0, 50) : null };
        });
      const before = await probe();
      await S.writeDisk(`Inserted at the top by an agent.\n\n${src}`);
      await S.sleep(600);
      const after = await probe();
      return {
        ok: before.top > 0 && before.text !== null && after.text === before.text,
        detail: `before ${j(before)} after ${j(after)}${before.top ? '' : ' (the document never scrolled)'}`,
      };
    },
  },
  {
    id: 'host.outside-change.e07',
    feature: 'host.outside-change',
    name: 'After the file is deleted on disk, typing in Sheaf is not lost',
    run: async (S) => {
      const path = await S.fresh('oc-seven', 'Deleted file words.\n');
      await S.caret('words', 2);
      unlinkSync(path);
      await S.sleep(1500);
      await S.type('Z');
      await S.sleep(2500);
      const exists = existsSync(path);
      const d = exists ? readFileSync(path, 'utf8') : null;
      const ed = await activeEditor(S);
      const shown = (await S.state()).doc;
      return { ok: shown.includes('woZrds') && (d === 'Deleted file woZrds.\n' || (ed.tabs[0] && ed.tabs[0].dirty)), detail: `file exists ${exists} ${show(d)}; Sheaf ${show(shown)}; tabs ${j(ed.tabs)}` };
    },
  },
  {
    id: 'host.outside-change.e08',
    feature: 'host.outside-change',
    name: 'Two disk writes in quick succession end with Sheaf showing the second',
    run: async (S) => {
      const path = await S.fresh('oc-eight', 'Version zero.\n');
      await S.caret('Version', 2);
      writeFileSync(path, 'Version one.\n');
      await S.sleep(80);
      writeFileSync(path, 'Version two, final.\n');
      await S.sleep(2500);
      const r = await S.rendered();
      return { ok: r.startsWith('Version two, final.'), detail: show(r) };
    },
  },
  {
    id: 'host.outside-change.e09',
    feature: 'host.outside-change',
    name: 'CRLF file: after a line changes on disk, Sheaf shows no extra blank line and the next letter typed writes no extra line',
    run: async (S) => {
      await S.fresh('oc-nine', 'First line.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n');
      await S.caret('Third', 2);
      const outside = 'First line changed.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n';
      await S.writeDisk(outside);
      const lines = (await S.rendered()).split('\n');
      await S.caret('Second', 2);
      await S.type('Z');
      const d = await S.disk();
      // Five lines of text and the empty line after the final line break, which VS Code's own
      // editor numbers as line 6 too. The bug this guards against drew a seventh.
      const want = ['First line changed.', '', 'Second line.', '', 'Third line.', ''];
      return { ok: j(lines) === j(want) && d === outside.replace('Second', 'SeZcond'), detail: `Sheaf lines ${j(lines)}; disk ${show(d)}` };
    },
  },
  {
    id: 'host.outside-change.e10',
    feature: 'host.outside-change',
    name: 'With auto-save off, unsaved typing stays on screen when the file changes on disk',
    run: async (S) => {
      const path = await S.fresh('oc-ten', 'Top line.\n\nBottom line.\n');
      try {
        await setUser(S, { 'sheaf.autoSave': false }, 1800);
        await S.caret('Bottom', 2);
        await S.type('abc');
        writeFileSync(path, 'Top line changed.\n\nBottom line.\n');
        await S.sleep(2500);
        const r = await S.rendered();
        return { ok: r.includes('Boabcttom'), detail: show(r) };
      } finally {
        await S.cleanup();
        if (await dialogUp(S)) {
          const dont = S.page.locator('.monaco-dialog-box .monaco-button', { hasText: "Don't Save" }).first();
          const b = await dont.boundingBox().catch(() => null);
          if (b) await S.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        }
        await resetSettings(S, ['sheaf.autoSave']);
      }
    },
  },
  {
    id: 'host.outside-change.e11',
    feature: 'host.outside-change',
    name: 'A file emptied on disk shows empty, and clicking in and typing writes just that',
    run: async (S) => {
      await S.fresh('oc-eleven', 'Something here.\n');
      await S.caret('here', 1);
      await S.writeDisk('');
      const r = await S.rendered();
      await S.click({ sel: '.cm-content' });
      await S.type('New');
      const d = await S.disk();
      return { ok: r === '' && d === 'New', detail: `rendered ${show(r)} disk ${show(d)}` };
    },
  },

  {
    id: 'host.outside-change.e12',
    feature: 'host.outside-change',
    name: 'A write made from text read before the typing says what it took, and Cmd+Z brings it back',
    run: async (S) => {
      const path = await S.fresh('oc-twelve', 'Top line.\n\nBottom line.\n');
      await S.caret('Bottom', 2);
      await S.type('ZZ');
      // The typing reaches disk first. That is the race this is about: the tool has
      // already read the file, and writes it back without what was typed since.
      await S.disk(path);
      const said = await staleWrite(S, path, 'Top line changed.\n\nBottom line.\n', 'Top line changed.');
      const gone = (await S.state()).doc;
      // Their own Undo key, in the document they are looking at. Nothing has been put
      // back before this.
      await S.caret('Bottom', 2);
      await S.press('Meta+z');
      await S.sleep(800);
      const back = (await S.state()).doc;
      const d = await S.disk(path);
      return all(
        {
          took: !gone.includes('BoZZttom'),
          said: saidItTook(said, 'ZZ'),
          back: back.includes('BoZZttom'),
          file: d.includes('BoZZttom'),
        },
        { said, gone, back, d }
      );
    },
  },
  {
    id: 'host.outside-change.e13',
    feature: 'host.outside-change',
    name: 'A write that keeps what was typed says nothing, and Undo is still the person’s own edit',
    run: async (S) => {
      const path = await S.fresh('oc-thirteen', 'Top line.\n\nBottom line.\n');
      await S.caret('Bottom', 2);
      await S.type('ZZ');
      await S.disk(path);
      // The tool read the file after the keystroke, so what was typed is in what it
      // wrote. Nothing was taken and there is nothing to say.
      const said = await staleWrite(S, path, 'Top line changed.\n\nBoZZttom line.\n', 'Top line changed.');
      return all({ silent: said.length === 0 }, { said });
    },
  },
  {
    id: 'host.outside-change.e14',
    feature: 'host.outside-change',
    name: 'A write to a part of the file the person never touched says nothing',
    run: async (S) => {
      const path = await S.fresh('oc-fourteen', 'Top line.\n\nMiddle line.\n\nBottom line.\n');
      await S.caret('Middle', 2);
      await S.type('ZZ');
      await S.disk(path);
      const said = await staleWrite(
        S,
        path,
        'Top line.\n\nMiZZddle line.\n\nBottom line changed.\n',
        'Bottom line changed.'
      );
      return all({ silent: said.length === 0 }, { said });
    },
  },

  // ---------------------------------------------------------------- host.split-editors
  {
    id: 'host.split-editors.e01',
    feature: 'host.split-editors',
    name: 'Sheaf and the text editor side by side: typing in Sheaf shows in the text editor',
    run: async (S) => {
      const fr = await sheafAndText(S, 'se-one', 'Shared words here.\n');
      await clickInFrame(S, fr, 'words', 2);
      await S.type('Z');
      await S.sleep(800);
      const lines = await textEditorLines(S, 1);
      return { ok: lines[0] === 'Shared woZrds here.', detail: j(lines) };
    },
  },
  {
    id: 'host.split-editors.e02',
    feature: 'host.split-editors',
    name: 'Typing in the text editor shows in Sheaf beside it',
    run: async (S) => {
      const fr = await sheafAndText(S, 'se-two', 'Shared words here.\n');
      const p = await textEditorPoint(S, 1, 'words', 2);
      await S.page.mouse.click(p.x, p.y);
      await S.type('Z');
      await S.sleep(800);
      const f = await frameDoc(fr);
      return { ok: f.rendered.startsWith('Shared woZrds here.'), detail: show(f.rendered) };
    },
  },
  {
    id: 'host.split-editors.e03',
    feature: 'host.split-editors',
    name: 'One file in two Sheaf editors: typing in the left shows in the right',
    run: async (S) => {
      await S.fresh('se-three', 'Shared words here.\n');
      await S.command('View: Split Editor Right');
      await S.sleep(1500);
      const frames = await sheafFrames(S);
      if (frames.length < 2) return { ok: false, detail: `expected two Sheaf editors, found ${frames.length}` };
      await clickInFrame(S, frames[0], 'words', 2);
      await S.type('Z');
      await S.sleep(800);
      const r = await frameDoc(frames[1]);
      const d = await S.disk(join(S.ws, 'e2e', 'se-three.md'));
      return { ok: r.rendered.startsWith('Shared woZrds') && d === 'Shared woZrds here.\n', detail: `right ${show(r.rendered)} disk ${show(d)}` };
    },
  },
  {
    id: 'host.split-editors.e04',
    feature: 'host.split-editors',
    name: 'Undo in the text editor after typing in Sheaf takes the typing back out of Sheaf too',
    run: async (S) => {
      const fr = await sheafAndText(S, 'se-four', 'Shared words here.\n');
      await clickInFrame(S, fr, 'words', 2);
      await S.type('Z');
      await S.sleep(1500);
      const p = await textEditorPoint(S, 1, 'here', 1);
      await S.page.mouse.click(p.x, p.y);
      await S.press('Meta+z');
      await S.sleep(800);
      const f = await frameDoc(fr);
      const lines = await textEditorLines(S, 1);
      return { ok: lines[0] === 'Shared words here.' && f.rendered.startsWith('Shared words here.'), detail: `text ${j(lines)} Sheaf ${show(f.rendered)}` };
    },
  },
  {
    id: 'host.split-editors.e05',
    feature: 'host.split-editors',
    name: 'Closing one of two Sheaf editors on a file leaves the other saving typed text',
    run: async (S) => {
      const path = await S.fresh('se-five', 'Shared words here.\n');
      await S.command('View: Split Editor Right');
      await S.sleep(1500);
      const close = S.page.locator('.editor-group-container.active .tab.active .tab-actions .action-label').first();
      const b = await close.boundingBox();
      await S.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await S.sleep(1500);
      const frames = await sheafFrames(S);
      if (frames.length !== 1) return { ok: false, detail: `expected one Sheaf editor after closing, found ${frames.length}` };
      await clickInFrame(S, frames[0], 'words', 2);
      await S.type('Z');
      const d = await S.disk(path);
      return { ok: d === 'Shared woZrds here.\n', detail: show(d) };
    },
  },
  {
    id: 'host.split-editors.e06',
    feature: 'host.split-editors',
    name: 'Typing in turn in Sheaf, the text editor, then Sheaf ends with both showing the same text',
    run: async (S) => {
      const fr = await sheafAndText(S, 'se-six', 'Alpha beta gamma.\n');
      await clickInFrame(S, fr, 'Alpha', 2);
      await S.type('1');
      const p = await textEditorPoint(S, 1, 'beta', 2);
      await S.page.mouse.click(p.x, p.y);
      await S.type('2');
      await clickInFrame(S, fr, 'gamma', 2);
      await S.type('3');
      await S.sleep(1500);
      const f = await frameDoc(fr);
      const lines = await textEditorLines(S, 1);
      return { ok: lines[0] === 'Al1pha be2ta ga3mma.' && f.doc === 'Al1pha be2ta ga3mma.\n', detail: `text ${j(lines)} Sheaf ${show(f.doc)}` };
    },
  },
  {
    id: 'host.split-editors.e07',
    feature: 'host.split-editors',
    name: 'A line typed in the text editor above the Sheaf caret leaves that caret in the same word',
    run: async (S) => {
      const fr = await sheafAndText(S, 'se-seven', 'First para.\n\nTarget words here.\n');
      await clickInFrame(S, fr, 'Target', 3);
      const p = await textEditorPoint(S, 1, 'First', 0);
      await S.page.mouse.click(p.x, p.y);
      await S.type('Above\n\n');
      await S.sleep(800);
      const f = await frameDoc(fr);
      return { ok: f.doc.slice(f.head, f.head + 3) === 'get', detail: `Sheaf caret before ${show(f.doc.slice(f.head, f.head + 10))} in ${show(f.doc)}` };
    },
  },
  {
    id: 'host.split-editors.e08',
    feature: 'host.split-editors',
    name: 'CRLF file beside the text editor: typing in the text editor adds no blank lines in Sheaf or the file',
    run: async (S) => {
      const fr = await sheafAndText(S, 'se-eight', 'One line.\r\n\r\nTwo line.\r\n');
      const p = await textEditorPoint(S, 1, 'One', 1);
      await S.page.mouse.click(p.x, p.y);
      await S.type('X');
      await S.sleep(800);
      const f1 = await frameDoc(fr);
      await clickInFrame(S, fr, 'Two', 1);
      await S.type('Y');
      const d = await S.disk(join(S.ws, 'e2e', 'se-eight.md'));
      return { ok: f1.doc === 'OXne line.\n\nTwo line.\n' && d === 'OXne line.\r\n\r\nTYwo line.\r\n', detail: `Sheaf after text-editor typing ${show(f1.doc)}; disk after typing in Sheaf ${show(d)}` };
    },
  },
  {
    id: 'host.split-editors.e09',
    feature: 'host.split-editors',
    name: 'Fast typing in the text editor ends with Sheaf showing exactly the same text',
    run: async (S) => {
      const fr = await sheafAndText(S, 'se-nine', 'Start\n');
      const p = await textEditorPoint(S, 1, 'Start', 2);
      await S.page.mouse.click(p.x, p.y);
      await S.press('End');
      await S.page.keyboard.type(' quick brown fox jumps over the lazy dog', { delay: 0 });
      await S.sleep(1000);
      const f = await frameDoc(fr);
      const lines = await textEditorLines(S, 1);
      return { ok: f.doc === 'Start quick brown fox jumps over the lazy dog\n' && lines[0] === 'Start quick brown fox jumps over the lazy dog', detail: `text ${j(lines)} Sheaf ${show(f.doc)}` };
    },
  },

  // ---------------------------------------------------------------- host.settings-live
  {
    id: 'host.settings-live.e01',
    feature: 'host.settings-live',
    name: 'Setting the content width to 400px narrows the open document column',
    run: async (S) => {
      await S.fresh('sl-one', 'A paragraph long enough to fill the column with words and more words so it wraps.\n');
      await S.caret('paragraph', 2);
      const width = () => S.eval(() => Math.round(document.querySelector('.cm-content').getBoundingClientRect().width));
      const gutter = () => S.eval(() => parseFloat(getComputedStyle(document.querySelector('.cm-content')).paddingLeft));
      const before = await width();
      try {
        await setUser(S, { 'sheaf.contentWidth': '400px' });
        const after = await width();
        const g = await gutter();
        return { ok: Math.abs(after - (400 + 2 * g)) <= 2 && after < before, detail: `before ${before}px, after ${after}px, gutter ${g}px` };
      } finally {
        await resetSettings(S, ['sheaf.contentWidth']);
      }
    },
  },
  {
    id: 'host.settings-live.e02',
    feature: 'host.settings-live',
    name: 'A content width of 40ch applies live',
    run: async (S) => {
      await S.fresh('sl-two', 'A paragraph long enough to fill the column with words and more words so it wraps.\n');
      await S.caret('paragraph', 2);
      try {
        await setUser(S, { 'sheaf.contentWidth': '40ch' });
        const r = await S.eval(() => {
          const c = document.querySelector('.cm-content');
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;visibility:hidden;width:40ch';
          c.appendChild(probe);
          const ch40 = probe.getBoundingClientRect().width;
          probe.remove();
          const cs = getComputedStyle(c);
          return { width: c.getBoundingClientRect().width, ch40, pad: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) };
        });
        return { ok: Math.abs(r.width - r.pad - r.ch40) <= 3, detail: j(r) };
      } finally {
        await resetSettings(S, ['sheaf.contentWidth']);
      }
    },
  },
  {
    id: 'host.settings-live.e03',
    feature: 'host.settings-live',
    name: 'A mistyped content width keeps a readable column instead of spreading text across the whole editor',
    run: async (S) => {
      await S.fresh('sl-three', 'A paragraph long enough to fill the column with words and more words so it wraps and wraps again.\n');
      await S.caret('paragraph', 2);
      const measure = () => S.eval(() => ({ col: Math.round(document.querySelector('.cm-content').getBoundingClientRect().width), pane: Math.round(document.querySelector('.sheaf-root').getBoundingClientRect().width), gutter: parseFloat(getComputedStyle(document.querySelector('.cm-content')).paddingLeft) }));
      const before = await measure();
      try {
        await setUser(S, { 'sheaf.contentWidth': '700pxx' });
        const after = await measure();
        await S.shot('host.settings-live.e03-after');
        return { ok: after.col <= 708 + 2 * after.gutter + 2, detail: `default ${j(before)}; with "700pxx" ${j(after)}` };
      } finally {
        await resetSettings(S, ['sheaf.contentWidth']);
      }
    },
  },
  {
    id: 'host.settings-live.e04',
    feature: 'host.settings-live',
    name: 'Turning reveal-on-line on shows the markers on the line with the caret without moving it',
    run: async (S) => {
      await S.fresh('sl-four', 'A **bold** word here.\n\nAnother line.\n');
      await S.caret('word', 2);
      const before = firstLine(await S.rendered());
      try {
        await setUser(S, { 'sheaf.revealSyntaxOnLine': true });
        const after = firstLine(await S.rendered());
        return { ok: !before.includes('**') && after.includes('**bold**'), detail: `before ${show(before)} after ${show(after)}` };
      } finally {
        await resetSettings(S, ['sheaf.revealSyntaxOnLine']);
      }
    },
  },
  {
    id: 'host.settings-live.e05',
    feature: 'host.settings-live',
    name: 'With reveal-on-line turned on, clicking into another line shows that line\'s markers',
    run: async (S) => {
      await S.fresh('sl-five', 'Plain first line.\n\nA **bold** word here.\n');
      await S.caret('Plain', 2);
      try {
        await setUser(S, { 'sheaf.revealSyntaxOnLine': true });
        await S.caret('word', 2);
        await S.sleep(300);
        const line = (await S.rendered()).split('\n')[2];
        return { ok: line.includes('**bold**'), detail: show(line) };
      } finally {
        await resetSettings(S, ['sheaf.revealSyntaxOnLine']);
      }
    },
  },
  {
    id: 'host.settings-live.e06',
    feature: 'host.settings-live',
    name: 'Turning reveal-on-line off hides the markers on the caret line without moving the caret',
    run: async (S) => {
      await S.fresh('sl-six', 'A **bold** word here.\n\nAnother line.\n');
      try {
        await setUser(S, { 'sheaf.revealSyntaxOnLine': true });
        await S.caret('word', 2);
        await S.sleep(300);
        const before = firstLine(await S.rendered());
        await setUser(S, { 'sheaf.revealSyntaxOnLine': false });
        const after = firstLine(await S.rendered());
        return { ok: before.includes('**bold**') && !after.includes('**'), detail: `before ${show(before)} after ${show(after)}` };
      } finally {
        await resetSettings(S, ['sheaf.revealSyntaxOnLine']);
      }
    },
  },
  {
    id: 'host.settings-live.e07',
    feature: 'host.settings-live',
    name: 'With double-click-to-edit-source off, double-clicking a bold word reveals nothing; back on, it reveals the markers',
    run: async (S) => {
      await S.fresh('sl-seven', 'Intro line.\n\nA **bold** word here.\n');
      await S.caret('Intro', 2);
      try {
        await setUser(S, { 'sheaf.doubleClickToEditSource': false });
        await S.dblclick({ text: 'bold', offset: 2 });
        const off = (await S.rendered()).split('\n')[2];
        await S.caret('Intro', 2);
        await setUser(S, { 'sheaf.doubleClickToEditSource': true });
        await S.dblclick({ text: 'bold', offset: 2 });
        const on = (await S.rendered()).split('\n')[2];
        return { ok: !off.includes('**') && on.includes('**bold**'), detail: `off ${show(off)} on ${show(on)}` };
      } finally {
        await resetSettings(S, ['sheaf.doubleClickToEditSource']);
      }
    },
  },
  {
    id: 'host.settings-live.e08',
    feature: 'host.settings-live',
    name: 'A content width change applies to two Sheaf editors side by side',
    run: async (S) => {
      await S.fresh('sl-eight', 'Shared words go here in a line long enough to wrap around the narrow column twice over.\n');
      await S.command('View: Split Editor Right');
      await S.sleep(1500);
      try {
        const frames = await sheafFrames(S);
        if (frames.length < 2) return { ok: false, detail: `expected two Sheaf editors, found ${frames.length}` };
        await clickInFrame(S, frames[0], 'words', 2);
        await setUser(S, { 'sheaf.contentWidth': '200px' });
        const ws = await Promise.all(frames.map(({ f }) => f.evaluate(() => { const c = document.querySelector('.cm-content'); const cs = getComputedStyle(c); return Math.round(c.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)); })));
        return { ok: ws.every((w) => Math.abs(w - 200) <= 2), detail: `text widths ${j(ws)}` };
      } finally {
        await resetSettings(S, ['sheaf.contentWidth']);
      }
    },
  },
  {
    id: 'host.settings-live.e09',
    feature: 'host.settings-live',
    name: 'A content width set in the workspace .vscode/settings.json applies live',
    run: async (S) => {
      await S.fresh('sl-nine', 'A paragraph long enough to fill the column with words and more words so it wraps.\n');
      await S.caret('paragraph', 2);
      try {
        await setWorkspace(S, { 'sheaf.contentWidth': '300px' });
        const w = await S.eval(() => { const c = document.querySelector('.cm-content'); const cs = getComputedStyle(c); return Math.round(c.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)); });
        return { ok: Math.abs(w - 300) <= 2, detail: `text width ${w}` };
      } finally {
        await resetSettings(S, []);
      }
    },
  },
  {
    id: 'host.settings-live.e10',
    feature: 'host.settings-live',
    name: 'A 2000px content width in a narrow split editor wraps text inside the editor with no sideways scrolling',
    run: async (S) => {
      await S.fresh('sl-ten', 'A paragraph long enough to fill the column with words and more words so it wraps around a few times in a narrow pane.\n');
      await S.command('View: Split Editor Right');
      await S.sleep(1200);
      await S.command('View: Split Editor Right');
      await S.sleep(1500);
      try {
        const frames = await sheafFrames(S);
        await clickInFrame(S, frames[0], 'paragraph', 2);
        await setUser(S, { 'sheaf.contentWidth': '2000px' });
        const r = await frames[0].f.evaluate(() => {
          const sc = document.querySelector('.cm-scroller');
          return { scrollWidth: sc.scrollWidth, clientWidth: sc.clientWidth, pane: Math.round(document.body.getBoundingClientRect().width) };
        });
        return { ok: r.scrollWidth <= r.clientWidth + 1, detail: j(r) };
      } finally {
        await resetSettings(S, ['sheaf.contentWidth']);
      }
    },
  },

  // ---------------------------------------------------------------- host.theme
  ...[
    ['e01', 'Default Light Modern', 'light', 4.5],
    ['e02', 'Default Dark Modern', 'dark', 4.5],
    ['e03', 'Default High Contrast', 'high contrast dark', 7],
    ['e04', 'Default High Contrast Light', 'high contrast light', 7],
  ].map(([n, theme, label, min]) => ({
    id: `host.theme.${n}`,
    feature: 'host.theme',
    name: `In the ${label} theme the page matches the editor background and text, links, code and toolbar icons are readable`,
    run: async (S) =>
      withTheme(S, theme, async () => {
        await S.fresh(`theme-${n}`, THEME_DOC);
        await S.caret('Second', 2);
        await S.hover({ sel: '#toolbar button', hasText: 'Bold' });
        await S.shot(`host.theme.${n}`);
        const m = await S.eval(measureColors, null);
        const ok = m.matchesThemeBg && m.text >= min && m.toolbarIcon >= 3 && (m.link == null || m.link >= 4.5) && (m.code == null || m.code >= 4.5);
        return { ok, detail: j(m) };
      }),
  })),
  {
    id: 'host.theme.e05',
    feature: 'host.theme',
    name: 'Switching from dark to light theme with a document open repaints Sheaf without reopening',
    run: async (S) => {
      await S.fresh('theme-five', THEME_DOC);
      await S.caret('Second', 2);
      const dark = await S.eval(measureColors, null);
      const light = await withTheme(S, 'Default Light Modern', async () => {
        await S.caret('Plain', 2);
        return S.eval(measureColors, null);
      });
      return { ok: dark.bg !== light.bg && light.matchesThemeBg && light.text >= 4.5, detail: `dark ${j(dark)} light ${j(light)}` };
    },
  },
  ...[
    ['e06', 'Default High Contrast', 'high contrast dark'],
    ['e07', 'Default High Contrast Light', 'high contrast light'],
    ['e08', 'Default Dark Modern', 'dark'],
  ].map(([n, theme, label]) => ({
    id: `host.theme.${n}`,
    feature: 'host.theme',
    name: `In the ${label} theme, text selected by dragging stays readable`,
    run: async (S) =>
      withTheme(S, theme, async () => {
        await S.fresh(`theme-${n}`, THEME_DOC);
        await S.select('Second paragraph');
        await S.sleep(300);
        await S.shot(`host.theme.${n}-selection`);
        const m = await S.eval(measureColors, { selection: 'Second paragraph' });
        return { ok: m.selectedText >= 4.5, detail: j(m) };
      }),
  })),
  {
    id: 'host.theme.e09',
    feature: 'host.theme',
    name: 'In the high contrast dark theme, hovering a toolbar button shows a visible change',
    run: async (S) =>
      withTheme(S, 'Default High Contrast', async () => {
        await S.fresh('theme-nine', THEME_DOC);
        await S.caret('Second', 2);
        await S.hover({ text: 'Second', offset: 1 });
        const idle = await S.eval(() => { const b = [...document.querySelectorAll('#toolbar button')].find((x) => (x.title || '').startsWith('Italic')); const cs = getComputedStyle(b); return `${cs.backgroundColor}|${cs.outlineStyle}|${cs.outlineColor}|${cs.borderColor}`; });
        await S.hover({ sel: '#toolbar button', hasText: 'Italic' });
        const hover = await S.eval(() => { const b = [...document.querySelectorAll('#toolbar button')].find((x) => (x.title || '').startsWith('Italic')); const cs = getComputedStyle(b); return `${cs.backgroundColor}|${cs.outlineStyle}|${cs.outlineColor}|${cs.borderColor}`; });
        return { ok: idle !== hover, detail: `idle ${idle} hover ${hover}` };
      }),
  },
];
