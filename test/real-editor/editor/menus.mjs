// E2E scenarios for the menus, driven by mouse and keyboard in real VS Code:
// right-click menu, its keyboard use, the selection toolbar, the link popover,
// the slash menu and find and replace. Results are read from the file on disk,
// the rendered editor, CodeMirror's selection and the system clipboard.
import { show } from '../session.mjs';

const j = (x) => JSON.stringify(x);

/* ---- Clipboard: the extension host writes the system clipboard ---- */
async function clipboardAfter(S, sentinel) {
  for (let i = 0; i < 20; i++) {
    await S.sleep(150);
    const now = (await S.clipboard.read());
    if (now !== sentinel) return now;
  }
  return (await S.clipboard.read());
}

/* ---- Reads in the Sheaf frame ---- */

/** The on-screen box of the first visible element matching `sel`, and the frame's size. */
const boxOf = (S, sel) =>
  S.eval((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => {
      const r = e.getBoundingClientRect();
      return !e.hidden && r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight, onScreen: r.bottom > 0 && r.top < innerHeight };
  }, sel);

/** The box of `text` in the rendered document. */
const textBox = (S, text) =>
  S.eval((text) => {
    const root = document.querySelector('.cm-content');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) {
      const i = n.data.indexOf(text);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + text.length);
      const r = range.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return null;
  }, text);

/** Items in the open right-click menus: label, disabled, checked. */
const menuItems = (S) =>
  S.eval(() =>
    [...document.querySelectorAll('.sheaf-ctx-menu:not([hidden]) .sheaf-ctx-item')].map((b) => ({ label: b.querySelector('span').textContent, disabled: b.disabled, checked: b.getAttribute('aria-checked') }))
  );
const menuOpen = (S) => S.eval(() => !!document.querySelector('.sheaf-ctx-menu:not(.sheaf-ctx-submenu):not([hidden])'));
const focusedLabel = (S) =>
  S.eval(() => {
    const a = document.activeElement;
    return a && a.classList.contains('sheaf-ctx-item') ? a.querySelector('span').textContent : `<${a ? a.className || a.tagName : 'none'}>`;
  });

/** The text of a visible, non-empty document line near the bottom of the frame. */
const lineNearBottom = (S, pattern) =>
  S.eval((pattern) => {
    const re = new RegExp(pattern);
    const lines = [...document.querySelectorAll('.cm-content > .cm-line')].filter((l) => re.test(l.textContent));
    let best = null;
    for (const l of lines) {
      const r = l.getBoundingClientRect();
      if (r.bottom <= innerHeight - 6 && r.top > 0) best = l.textContent;
    }
    return best;
  }, pattern);

async function waitFor(S, sel, want = true, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await S.exists(sel)) === want) return true;
    await S.sleep(100);
  }
  return (await S.exists(sel)) === want;
}

/** Click the last (empty) line of the document, which has nothing below it. */
const clickLastLine = (S) => S.eval(() => document.querySelectorAll('.cm-content > .cm-line').length).then((n) => S.click({ sel: '.cm-content > .cm-line', nth: n - 1 }));

/** Open find with a real key press after a click; fall back to a key dispatched in the frame when VS Code keeps the shortcut. */
async function openFind(S, word, replace = false) {
  await S.caret(word, 1);
  await S.press(replace ? 'Meta+Alt+f' : 'Meta+f');
  let note = '';
  if (!(await waitFor(S, '.sheaf-find', true, 1200))) {
    note = `shortcut ${replace ? 'Cmd+Alt+F' : 'Cmd+F'} did not open find (lead investigating); opened with a dispatched key. `;
    await S.eval((replace) => {
      const c = document.querySelector('.cm-content');
      c.focus();
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, altKey: replace, bubbles: true, cancelable: true }));
    }, replace);
    await waitFor(S, '.sheaf-find', true, 1200);
  }
  return note;
}
const findCount = (S) => S.eval(() => document.querySelector('.sheaf-find-count')?.textContent ?? null);

const LONG = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} holds some words here`).join('\n\n') + '\n';

export const scenarios = [
  /* ==== menus.context-prose ==== */
  {
    id: 'menus.context-prose.e01',
    feature: 'menus.context-prose',
    name: 'Drag-select a word, right-click inside it, choose Highlight: the word is highlighted in the file',
    run: async (S) => {
      // Bold, Italic and Strikethrough are on the selection toolbar, which opens on the same
      // gesture. Highlight is the mark this menu carries, through the same wiring.
      await S.fresh('ctx-mark', 'Say hello to the world today.\n');
      await S.select('world');
      await S.rightClick({ text: 'world', offset: 2 });
      await S.menu('Highlight');
      const d = await S.disk();
      return { ok: d === 'Say hello to the ==world== today.\n', detail: show(d) };
    },
  },
  {
    id: 'menus.context-prose.e02',
    feature: 'menus.context-prose',
    name: 'Right-click the text of a task and choose Mark done: the box is ticked in the file',
    run: async (S) => {
      await S.fresh('ctx-task', 'Tasks\n\n- [ ] write tests\n');
      await S.rightClick({ text: 'tests', offset: 2 });
      await S.menu('Mark done');
      const d = await S.disk();
      return { ok: d === 'Tasks\n\n- [x] write tests\n', detail: show(d) };
    },
  },
  {
    id: 'menus.context-prose.e03',
    feature: 'menus.context-prose',
    name: 'Right-click a link and choose Remove link: the text stays and the address goes',
    run: async (S) => {
      await S.fresh('ctx-unlink', 'Go to the [site](https://a.io) now.\n');
      await S.rightClick({ text: 'site', offset: 2 });
      await S.menu('Remove link');
      const d = await S.disk();
      return { ok: d === 'Go to the site now.\n', detail: show(d) };
    },
  },
  {
    id: 'menus.context-prose.e04',
    feature: 'menus.context-prose',
    name: 'Right-click a link, type Z while the menu is open, then choose Remove link: the typed Z and the whole link text survive',
    run: async (S) => {
      await S.fresh('ctx-stale', 'Go to the [site](https://a.io) now.\n');
      await S.rightClick({ text: 'site', offset: 2 });
      await S.type('Z');
      const stillOpen = await menuOpen(S);
      const typed = await S.disk();
      if (!stillOpen) return { ok: true, detail: `menu closed on typing; ${show(typed)}` };
      await S.menu('Remove link');
      const d = await S.disk();
      await S.shot('ctx-stale-after');
      return { ok: d === 'Go to the siZte now.\n', detail: `after typing ${show(typed)} after Remove link ${show(d)}` };
    },
  },
  {
    id: 'menus.context-prose.e05',
    feature: 'menus.context-prose',
    name: 'Right-click in a code block: formatting is disabled, and Copy code puts the code on the clipboard',
    run: async (S) => {
      await S.fresh('ctx-code', 'Intro\n\n```js\nlet alpha = 1;\nlet beta = 2;\n```\n');
      await S.rightClick({ text: 'alpha', offset: 2 });
      const items = await menuItems(S);
      // Highlight rather than Bold: the three commonest marks left this menu for the selection
      // toolbar, and Highlight is the one still here to be disabled inside code.
      const mark = items.find((i) => i.label === 'Highlight');
      await S.clipboard.write('SENTINEL-code');
      await S.menu('Copy code');
      const clip = await clipboardAfter(S, 'SENTINEL-code');
      return { ok: mark?.disabled === true && clip === 'let alpha = 1;\nlet beta = 2;', detail: `highlight ${j(mark)} clipboard ${show(clip)}` };
    },
  },
  {
    id: 'menus.context-prose.e06',
    feature: 'menus.context-prose',
    name: 'Triple-click a line, right-click it and choose Copy ref: the ref names only that line',
    run: async (S) => {
      await S.fresh('ctx-ref', 'one\n\ntwo words\n\nthree\n');
      await S.click({ text: 'two words', offset: 2 }, { count: 3 });
      const st = await S.state();
      await S.rightClick({ text: 'two words', offset: 4 });
      await S.clipboard.write('SENTINEL-ref');
      await S.menu('Copy ref');
      const clip = await clipboardAfter(S, 'SENTINEL-ref');
      return { ok: clip.startsWith('e2e/ctx-ref.md:3\n'), detail: `selection ${st.anchor}-${st.head}; clipboard ${show(clip)}` };
    },
  },
  {
    id: 'menus.context-prose.e07',
    feature: 'menus.context-prose',
    name: 'The right-click menu offers no Paste, and Cmd+V still turns a spreadsheet range into a table',
    run: async (S) => {
      // Paste left the menu: the platform binds it, and the menu's own clipboard read is gone with
      // it. What has to keep working is the paste a person actually makes.
      await S.fresh('ctx-paste-range', 'Numbers below\n\n');
      await S.clipboard.write('fruit\tqty\nkiwi\t2\n');
      await clickLastLine(S);
      await S.rightClick({ sel: '.cm-content > .cm-line', nth: 2 });
      const offered = (await menuItems(S)).map((i) => i.label);
      await S.press('Escape');
      await S.sleep(300);
      await clickLastLine(S);
      await S.press('Meta+v');
      await S.sleep(800);
      const d = await S.disk();
      const clipboardItems = offered.filter((l) => ['Cut', 'Copy', 'Paste'].includes(l));
      return {
        ok: clipboardItems.length === 0 && /\| fruit \| qty \|/.test(d),
        detail: `menu offered ${j(offered)}; ${show(d)}`,
      };
    },
  },
  {
    id: 'menus.context-prose.e08',
    feature: 'menus.context-prose',
    name: 'Control for e07: the same spreadsheet range pasted with Cmd+V on an empty line makes a table',
    run: async (S) => {
      await S.fresh('ctx-paste-cmdv', 'Numbers below\n\n');
      await S.clipboard.write('fruit\tqty\nkiwi\t2\n');
      await clickLastLine(S);
      const st = await S.state();
      await S.press('Meta+v');
      await S.sleep(800);
      const d = await S.disk();
      return { ok: /\| fruit \| qty \|/.test(d), detail: `caret line ${st.line} focused ${st.focused}; ${show(d)}` };
    },
  },
  {
    id: 'menus.context-prose.e09',
    feature: 'menus.context-prose',
    name: 'Right-click near the right edge and point at Turn into: the menu and its submenu stay inside the window',
    run: async (S) => {
      const long = 'Start ' + 'filler words keep this line going '.repeat(2) + 'rightmost';
      await S.fresh('ctx-edge-right', `${long}\n`);
      const box = await textBox(S, 'rightmost');
      await S.rightClick({ text: 'rightmost', offset: 4 });
      await S.hover({ sel: '.sheaf-ctx-item', hasText: 'Turn into' });
      const menu = await boxOf(S, '.sheaf-ctx-menu:not(.sheaf-ctx-submenu)');
      const sub = await boxOf(S, '.sheaf-ctx-submenu');
      const inside = (b) => b && b.left >= 0 && b.right <= b.w && b.top >= 0 && b.bottom <= b.h;
      await S.shot('ctx-edge-right');
      return { ok: inside(menu) && inside(sub), detail: `word ${j(box)} menu ${j(menu)} sub ${j(sub)}` };
    },
  },
  {
    id: 'menus.context-prose.e10',
    feature: 'menus.context-prose',
    name: 'Right-click a line at the bottom of the window: the whole menu is inside the window',
    run: async (S) => {
      await S.fresh('ctx-edge-bottom', LONG);
      const line = await lineNearBottom(S, '^Line \\d+ holds');
      if (!line) return { ok: false, detail: 'no line near the bottom' };
      await S.rightClick({ text: line, offset: 6 });
      const menu = await boxOf(S, '.sheaf-ctx-menu:not(.sheaf-ctx-submenu)');
      await S.shot('ctx-edge-bottom');
      return { ok: !!menu && menu.bottom <= menu.h && menu.top >= 0, detail: `line ${j(line)} menu ${j(menu)}` };
    },
  },
  {
    id: 'menus.context-prose.e11',
    feature: 'menus.context-prose',
    name: 'Right-click a front matter value and choose Turn into > Heading 1: the front matter is left as it was',
    run: async (S) => {
      const doc = '---\ntitle: Notes\n---\n\nBody text\n';
      await S.fresh('ctx-front', doc);
      await S.rightClick({ text: 'Notes', offset: 2 });
      await S.hover({ sel: '.sheaf-ctx-item', hasText: 'Turn into' });
      const h1 = (await menuItems(S)).find((i) => i.label === 'Heading 1');
      if (h1 && !h1.disabled) await S.menu('Heading 1');
      const d = await S.disk();
      return { ok: d === doc, detail: `Heading 1 ${j(h1)}; ${show(d)}` };
    },
  },
  {
    id: 'menus.context-prose.e12',
    feature: 'menus.context-prose',
    name: 'Right-click a link written with an angle-bracket address and choose Copy link address: the clipboard holds the address without brackets',
    run: async (S) => {
      await S.fresh('ctx-angle', 'See [the notes](<my notes.md>) here.\n');
      await S.rightClick({ text: 'notes', offset: 2 });
      await S.clipboard.write('SENTINEL-angle');
      await S.menu('Copy link address');
      const clip = await clipboardAfter(S, 'SENTINEL-angle');
      return { ok: clip === 'my notes.md', detail: show(clip) };
    },
  },
  {
    id: 'menus.context-prose.e13',
    feature: 'menus.context-prose',
    name: 'Right-click a word, then scroll the document: the menu closes or stays next to that word',
    run: async (S) => {
      await S.fresh('ctx-scroll', LONG);
      await S.rightClick({ text: 'Line 5 holds', offset: 2 });
      const before = await boxOf(S, '.sheaf-ctx-menu:not(.sheaf-ctx-submenu)');
      await S.hover({ text: 'Line 3 holds', offset: 2 });
      await S.page.mouse.wheel(0, 300);
      await S.sleep(600);
      const menu = await boxOf(S, '.sheaf-ctx-menu:not(.sheaf-ctx-submenu)');
      const word = await textBox(S, 'Line 5 holds');
      await S.shot('ctx-scroll-after');
      if (!menu) return { ok: true, detail: 'menu closed on scroll' };
      const near = word && Math.abs(menu.top - word.bottom) < 40;
      return { ok: !!near, detail: `menu before ${j(before && before.top)} after ${j(menu.top)}, word bottom now ${j(word && word.bottom)}` };
    },
  },
  {
    id: 'menus.context-prose.e14',
    feature: 'menus.context-prose',
    name: 'Right-click a highlighted word: Highlight shows a check, and choosing it takes the highlight off',
    run: async (S) => {
      await S.fresh('ctx-unmark', 'A ==marked== word here.\n');
      await S.rightClick({ text: 'marked', offset: 2 });
      const mark = (await menuItems(S)).find((i) => i.label === 'Highlight');
      await S.menu('Highlight');
      const d = await S.disk();
      return { ok: mark?.checked === 'true' && d === 'A marked word here.\n', detail: `Highlight ${j(mark)}; ${show(d)}` };
    },
  },
  {
    id: 'menus.context-prose.e15',
    feature: 'menus.context-prose',
    name: 'Right-click inside a word and press Escape: the menu closes and typing goes where the right-click was',
    run: async (S) => {
      await S.fresh('ctx-escape', 'Say hello to the world today.\n');
      await S.rightClick({ text: 'world', offset: 2 });
      await S.press('Escape');
      const open = await menuOpen(S);
      await S.type('Z');
      const d = await S.disk();
      return { ok: !open && d === 'Say hello to the woZrld today.\n', detail: `open ${open}; ${show(d)}` };
    },
  },
  {
    id: 'menus.context-prose.e16',
    feature: 'menus.context-prose',
    name: 'Drag across two paragraphs, right-click and choose Turn into > Numbered list: they are numbered 1 and 2',
    run: async (S) => {
      await S.fresh('ctx-ordered', 'first one\n\nsecond two\n');
      await S.drag({ text: 'first one', offset: 0 }, { text: 'second two', offset: 9 });
      await S.rightClick({ text: 'first one', offset: 3 });
      await S.hover({ sel: '.sheaf-ctx-item', hasText: 'Turn into' });
      await S.menu('Numbered list');
      const d = await S.disk();
      return { ok: d === '1. first one\n\n2. second two\n', detail: show(d) };
    },
  },
  {
    id: 'menus.context-prose.e17',
    feature: 'menus.context-prose',
    name: 'Drag from a paragraph above a table to one below it, right-click and choose Turn into > Heading 1: the table rows are left alone',
    run: async (S) => {
      const table = '| fruit | qty |\n| --- | --- |\n| kiwi | 2 |';
      await S.fresh('ctx-table-span', `intro words\n\n${table}\n\nclosing words\n`);
      await S.drag({ text: 'intro words', offset: 0 }, { text: 'closing words', offset: 12 });
      await S.rightClick({ text: 'intro words', offset: 3 });
      const items = (await menuItems(S)).map((i) => i.label);
      if (!items.includes('Turn into')) return { ok: true, detail: `menu without Turn into: ${j(items)}` };
      await S.hover({ sel: '.sheaf-ctx-item', hasText: 'Turn into' });
      await S.menu('Heading 1');
      const d = await S.disk();
      return { ok: d.includes(`\n${table}\n`), detail: show(d) };
    },
  },

  /* ==== menus.context-keyboard ==== */
  {
    id: 'menus.context-keyboard.e01',
    feature: 'menus.context-keyboard',
    name: 'Click inside a word, press Shift+F10: the menu opens at the caret with Turn into focused; Escape closes it and typing lands at the caret',
    run: async (S) => {
      await S.fresh('kb-open', 'Say hello to the world today.\n');
      await S.caret('world', 2);
      await S.press('Shift+F10');
      const open = await menuOpen(S);
      const focused = await focusedLabel(S);
      const menu = await boxOf(S, '.sheaf-ctx-menu:not(.sheaf-ctx-submenu)');
      const word = await textBox(S, 'world');
      await S.press('Escape');
      const closed = !(await menuOpen(S));
      const st = await S.state();
      await S.type('Z');
      const d = await S.disk();
      const near = menu && word && Math.abs(menu.top - word.bottom) < 30 && Math.abs(menu.left - (word.left + (word.right - word.left) * 0.4)) < 40;
      return {
        ok: open && focused === 'Turn into' && !!near && closed && d === 'Say hello to the woZrld today.\n',
        detail: `open ${open} focused ${focused} menu ${j(menu)} word ${j(word)} closed ${closed} editorFocused ${st.focused}; ${show(d)}`,
      };
    },
  },
  {
    id: 'menus.context-keyboard.e02',
    feature: 'menus.context-keyboard',
    name: 'Drag-select a word, press Shift+F10, arrow down to Highlight and press Enter: the word is highlighted and the editor has focus again',
    run: async (S) => {
      // Two steps from Turn into: Edit Markdown, then Highlight.
      await S.fresh('kb-mark', 'Say hello to the world today.\n');
      await S.select('world');
      await S.press('Shift+F10');
      const path = [await focusedLabel(S)];
      for (let i = 0; i < 2; i++) {
        await S.press('ArrowDown');
        path.push(await focusedLabel(S));
      }
      await S.press('Enter');
      const d = await S.disk();
      const st = await S.state();
      return { ok: d === 'Say hello to the ==world== today.\n' && st.focused, detail: `${path.join('>')} focused ${st.focused}; ${show(d)}` };
    },
  },
  {
    id: 'menus.context-keyboard.e03',
    feature: 'menus.context-keyboard',
    name: 'Click in a line, Shift+F10, Home, Right, Down, Enter: the line becomes Heading 1',
    run: async (S) => {
      await S.fresh('kb-turn', 'Top words\n\nLast line\n');
      await S.caret('Last line', 2);
      await S.press('Shift+F10');
      // Home, not End: Turn into leads the menu, and End reaches Copy ref at the bottom.
      await S.press('Home');
      const onTurn = await focusedLabel(S);
      await S.press('ArrowRight');
      await S.press('ArrowDown');
      const onH1 = await focusedLabel(S);
      await S.press('Enter');
      const d = await S.disk();
      return { ok: d === 'Top words\n\n# Last line\n', detail: `${onTurn} > ${onH1}; ${show(d)}` };
    },
  },
  {
    id: 'menus.context-keyboard.e04',
    feature: 'menus.context-keyboard',
    name: 'Click in a word, Shift+F10, Tab: the menu closes and typing goes into the document at the caret',
    run: async (S) => {
      await S.fresh('kb-tab', 'Say hello to the world today.\n');
      await S.caret('hello', 2);
      await S.press('Shift+F10');
      await S.press('Tab');
      const open = await menuOpen(S);
      await S.type('Z');
      const d = await S.disk();
      return { ok: !open && d === 'Say heZllo to the world today.\n', detail: `open ${open}; ${show(d)}` };
    },
  },
  {
    id: 'menus.context-keyboard.e05',
    feature: 'menus.context-keyboard',
    name: 'Right-click with the mouse, then press Down and Enter: focus moves into the menu and Edit Markdown runs on the block',
    run: async (S) => {
      // One step down from Turn into. Paste is no longer in this menu, so the command that proves
      // the keys reached it is the one under the first item.
      await S.fresh('kb-mouse-then-keys', 'Say **hello** to the world today.\n');
      await S.rightClick({ text: 'world', offset: 2 });
      // The first Down moves focus into the menu, onto its first item; the second steps to the one
      // under it.
      await S.press('ArrowDown');
      const entered = await focusedLabel(S);
      await S.press('ArrowDown');
      const focused = await focusedLabel(S);
      await S.press('Enter');
      await S.sleep(700);
      const shown = await S.rendered();
      const d = await S.disk();
      return {
        ok: entered === 'Turn into' && focused === 'Edit Markdown' && shown.includes('**hello**') && d === 'Say **hello** to the world today.\n',
        detail: `entered on ${entered}, then ${focused}; on screen ${show(shown)}; ${show(d)}`,
      };
    },
  },

  /* ==== menus.selection-toolbar ==== */
  {
    id: 'menus.selection-toolbar.e01',
    feature: 'menus.selection-toolbar',
    name: 'Drag-select a word: the toolbar appears clear of the word, and its Bold button bolds it in the file',
    run: async (S) => {
      await S.fresh('seltb-bold', 'Intro line\n\nSay hello to the world today.\n');
      await S.select('world');
      const shown = await waitFor(S, '.sheaf-seltb');
      const bar = await boxOf(S, '.sheaf-seltb');
      const word = await textBox(S, 'world');
      await S.click({ sel: '.sheaf-seltb [data-cmd="bold"]' });
      const d = await S.disk();
      const clear = bar && word && (bar.bottom <= word.top + 1 || bar.top >= word.bottom - 1);
      return { ok: shown && !!clear && d === 'Intro line\n\nSay hello to the **world** today.\n', detail: `bar ${j(bar)} word ${j(word)}; ${show(d)}` };
    },
  },
  {
    id: 'menus.selection-toolbar.e02',
    feature: 'menus.selection-toolbar',
    name: 'Drag across two paragraphs and choose Turn into > Bullet list: two bullets, and the blank line between stays blank',
    run: async (S) => {
      await S.fresh('seltb-bullets', 'Top\n\nfirst one\n\nsecond two\n');
      await S.drag({ text: 'first one', offset: 0 }, { text: 'second two', offset: 9 });
      await waitFor(S, '.sheaf-seltb');
      await S.click({ sel: '.sheaf-seltb-trigger' });
      await S.menu('Bullet list');
      const d = await S.disk();
      const r = await S.rendered();
      return { ok: d === 'Top\n\n- first one\n\n- second two\n', detail: `${show(d)} rendered ${show(r)}` };
    },
  },
  {
    id: 'menus.selection-toolbar.e03',
    feature: 'menus.selection-toolbar',
    name: 'Select a word on the first line of the document: the toolbar does not cover the formatting bar or the word',
    run: async (S) => {
      await S.fresh('seltb-top', 'First words at the very top\n\nmore\n');
      await S.select('words');
      await waitFor(S, '.sheaf-seltb');
      const bar = await boxOf(S, '.sheaf-seltb');
      const top = await boxOf(S, '#toolbar');
      const word = await textBox(S, 'words');
      await S.shot('seltb-top');
      const ok = bar && top && word && bar.top >= top.bottom - 1 && (bar.bottom <= word.top + 1 || bar.top >= word.bottom - 1);
      return { ok: !!ok, detail: `bar ${j(bar)} formatting bar ${j(top)} word ${j(word)}` };
    },
  },
  {
    id: 'menus.selection-toolbar.e04',
    feature: 'menus.selection-toolbar',
    name: 'Select a word, then scroll it out of view: the toolbar goes with it',
    run: async (S) => {
      await S.fresh('seltb-scroll', LONG);
      await S.select('Line 2 holds');
      await waitFor(S, '.sheaf-seltb');
      await S.hover({ text: 'Line 6 holds', offset: 2 });
      await S.page.mouse.wheel(0, 900);
      await S.sleep(700);
      const word = await textBox(S, 'Line 2 holds');
      const bar = await boxOf(S, '.sheaf-seltb');
      const top = await boxOf(S, '#toolbar');
      await S.shot('seltb-scroll');
      const visibleBar = bar && bar.onScreen && bar.bottom > (top ? top.bottom : 0);
      return { ok: !visibleBar, detail: `word ${j(word)} bar ${j(bar)}` };
    },
  },
  {
    id: 'menus.selection-toolbar.e05',
    feature: 'menus.selection-toolbar',
    name: 'Select a word and press Escape: the toolbar closes and the word stays selected',
    run: async (S) => {
      await S.fresh('seltb-escape', 'Say hello to the world today.\n');
      await S.select('world');
      await waitFor(S, '.sheaf-seltb');
      await S.press('Escape');
      const gone = await waitFor(S, '.sheaf-seltb', false, 1000);
      const st = await S.state();
      const selected = st.doc.slice(Math.min(st.anchor, st.head), Math.max(st.anchor, st.head));
      return { ok: gone && selected === 'world', detail: `gone ${gone} selected ${j(selected)} focused ${st.focused}` };
    },
  },
  {
    id: 'menus.selection-toolbar.e06',
    feature: 'menus.selection-toolbar',
    name: 'Drag-select text inside a code block: no toolbar',
    run: async (S) => {
      await S.fresh('seltb-code', 'Intro\n\n```\nlet alpha = beta;\n```\n');
      await S.select('alpha');
      await S.sleep(400);
      const shown = await S.exists('.sheaf-seltb');
      return { ok: !shown, detail: `shown ${shown}` };
    },
  },
  {
    id: 'menus.selection-toolbar.e07',
    feature: 'menus.selection-toolbar',
    name: 'Drag-select a front matter value: no formatting toolbar over the YAML',
    run: async (S) => {
      await S.fresh('seltb-front', '---\ntitle: Notes\n---\n\nBody text\n');
      // Stop the drag inside the word, so the selection lies wholly inside the front matter value.
      await S.select('Note');
      await S.sleep(400);
      const shown = await S.exists('.sheaf-seltb');
      const st = await S.state();
      await S.shot('seltb-front');
      return { ok: !shown, detail: `shown ${shown} selected ${j(st.doc.slice(Math.min(st.anchor, st.head), Math.max(st.anchor, st.head)))}` };
    },
  },
  {
    id: 'menus.selection-toolbar.e08',
    feature: 'menus.selection-toolbar',
    name: 'Select a word and choose Turn into > Heading 2: the line becomes a heading and the trigger reads Heading 2',
    run: async (S) => {
      await S.fresh('seltb-h2', 'Top\n\nLast line here\n');
      await S.select('line');
      await waitFor(S, '.sheaf-seltb');
      await S.click({ sel: '.sheaf-seltb-trigger' });
      await S.menu('Heading 2');
      const d = await S.disk();
      const label = await S.eval(() => document.querySelector('.sheaf-seltb-trigger')?.textContent ?? null);
      return { ok: d === 'Top\n\n## Last line here\n' && (label === null || label === 'Heading 2'), detail: `label ${j(label)}; ${show(d)}` };
    },
  },
  {
    id: 'menus.selection-toolbar.e09',
    feature: 'menus.selection-toolbar',
    name: 'Select a word inside a link: the Link button reads Remove link, and clicking it keeps the text',
    run: async (S) => {
      await S.fresh('seltb-unlink', 'Go to the [home page](https://a.io) now.\n');
      await S.select('page');
      await waitFor(S, '.sheaf-seltb');
      const label = await S.eval(() => document.querySelector('.sheaf-seltb [data-cmd="link"]')?.getAttribute('aria-label'));
      await S.click({ sel: '.sheaf-seltb [data-cmd="link"]' });
      const d = await S.disk();
      return { ok: label === 'Remove link' && d === 'Go to the home page now.\n', detail: `label ${j(label)}; ${show(d)}` };
    },
  },
  {
    id: 'menus.selection-toolbar.e10',
    feature: 'menus.selection-toolbar',
    name: 'Open Turn into from the toolbar: every choice shows its shortcut, except the three deep heading levels, which have none',
    run: async (S) => {
      await S.fresh('seltb-keys', 'Say hello to the world today.\n');
      await S.select('world');
      await waitFor(S, '.sheaf-seltb');
      await S.click({ sel: '.sheaf-seltb-trigger' });
      const keys = await S.eval(() => [...document.querySelectorAll('.sheaf-seltb-menu .sheaf-tb-menu-item')].map((i) => `${i.querySelector('span').textContent}=${i.querySelector('.sheaf-tb-menu-key').textContent}`));
      await S.shot('seltb-keys');
      // Mod-Alt-4 is Task list, so the run of digits stops at Heading 3 and the deep
      // levels are reached by name. A blank column on any other row is the bug.
      const missing = keys.filter((k) => k.endsWith('='));
      const ok = missing.join('|') === 'Heading 4=|Heading 5=|Heading 6=';
      return { ok, detail: j(keys) };
    },
  },
  {
    id: 'menus.selection-toolbar.e11',
    feature: 'menus.selection-toolbar',
    name: 'Edit Markdown leads the selection toolbar, shows the block it was run on, and the bar puts itself away',
    run: async (S) => {
      await S.fresh('seltb-source', 'Intro line\n\nSay **hello** to the world today.\n');
      await S.select('world');
      await waitFor(S, '.sheaf-seltb');
      const bar = await S.eval(() => {
        const tb = document.querySelector('.sheaf-seltb');
        const first = tb.querySelector('button');
        // The bar's own controls, not the buttons inside the Turn into menu it carries: those are
        // hidden and stacked, and counting them reads as a bar wrapped onto several rows.
        const controls = [...tb.children].filter((el) => el.tagName === 'BUTTON');
        const rows = controls.map((b) => Math.round(b.getBoundingClientRect().top));
        return {
          firstLabel: first.getAttribute('aria-label'),
          firstTitle: first.getAttribute('title'),
          buttons: rows.length,
          rows: [...new Set(rows)].length,
          width: Math.round(tb.getBoundingClientRect().width),
          pane: Math.round(document.querySelector('.cm-scroller').getBoundingClientRect().width),
          separatorAfterFirst: first.nextElementSibling?.getAttribute('role') === 'separator',
        };
      });
      await S.click({ sel: '.sheaf-seltb button' });
      await S.sleep(600);
      const shown = await S.rendered();
      const gone = await waitFor(S, '.sheaf-seltb', false, 800);
      const d = await S.disk();
      return {
        ok:
          /^Edit Markdown/.test(bar.firstLabel ?? '') &&
          bar.separatorAfterFirst &&
          bar.rows === 1 &&
          shown.includes('**hello**') &&
          gone &&
          d === 'Intro line\n\nSay **hello** to the world today.\n',
        detail: `first ${j(bar.firstLabel)} title ${j(bar.firstTitle)}; ${bar.buttons} buttons on ${bar.rows} row(s), bar ${bar.width}px in a ${bar.pane}px pane; separator after it ${bar.separatorAfterFirst}; on screen ${show(shown)}; bar gone ${gone}`,
      };
    },
  },

  /* ==== menus.link-popover ==== */
  {
    id: 'menus.link-popover.e01',
    feature: 'menus.link-popover',
    name: 'Click into a link, replace the address in the popover with one holding a space, press Enter: only the address changes, in angle brackets',
    run: async (S) => {
      await S.fresh('pop-edit', 'Read the [guide](https://a.io/g) first.\n');
      await S.caret('guide', 2);
      const shown = await waitFor(S, '.sheaf-linkpop');
      const before = await S.eval(() => document.querySelector('.sheaf-linkpop-url')?.value);
      await S.click('.sheaf-linkpop-url');
      await S.press('Meta+a');
      await S.type('my notes.md');
      await S.press('Enter');
      const d = await S.disk();
      return { ok: shown && before === 'https://a.io/g' && d === 'Read the [guide](<my notes.md>) first.\n', detail: `field ${j(before)}; ${show(d)}` };
    },
  },
  {
    id: 'menus.link-popover.e02',
    feature: 'menus.link-popover',
    name: 'Rest the pointer on a link: the popover opens; move the pointer away: it closes',
    run: async (S) => {
      await S.fresh('pop-hover', 'Plain words first.\n\nRead the [guide](https://a.io/g) first.\n');
      await S.hover({ text: 'guide', offset: 2 });
      const opened = await waitFor(S, '.sheaf-linkpop', true, 1500);
      await S.hover({ text: 'Plain words', offset: 2 });
      const closed = await waitFor(S, '.sheaf-linkpop', false, 1500);
      return { ok: opened && closed, detail: `opened ${opened} closed ${closed}` };
    },
  },
  {
    id: 'menus.link-popover.e03',
    feature: 'menus.link-popover',
    name: 'Hover a link, click into its address field, move the pointer away and type: the popover stays and Enter saves',
    run: async (S) => {
      await S.fresh('pop-hover-type', 'Plain words first.\n\nRead the [guide](https://a.io/g) first.\n');
      await S.hover({ text: 'guide', offset: 2 });
      await waitFor(S, '.sheaf-linkpop', true, 1500);
      await S.click('.sheaf-linkpop-url');
      await S.hover({ text: 'Plain words', offset: 2 });
      await S.sleep(700);
      const stayed = await S.exists('.sheaf-linkpop');
      await S.press('Meta+a');
      await S.type('https://b.io');
      await S.press('Enter');
      const d = await S.disk();
      return { ok: stayed && d === 'Plain words first.\n\nRead the [guide](https://b.io) first.\n', detail: `stayed ${stayed}; ${show(d)}` };
    },
  },
  {
    id: 'menus.link-popover.e04',
    feature: 'menus.link-popover',
    name: 'Click into a link and click Remove link in the popover: the text stays',
    run: async (S) => {
      await S.fresh('pop-remove', 'Read the [guide](https://a.io/g) first.\n');
      await S.caret('guide', 2);
      await waitFor(S, '.sheaf-linkpop');
      await S.click('.sheaf-linkpop [data-action="remove"]');
      const d = await S.disk();
      return { ok: d === 'Read the guide first.\n', detail: show(d) };
    },
  },
  {
    id: 'menus.link-popover.e05',
    feature: 'menus.link-popover',
    name: 'Click into a link and click Copy in the popover: the clipboard holds the address',
    run: async (S) => {
      await S.fresh('pop-copy', 'Read the [guide](https://a.io/g) first.\n');
      await S.caret('guide', 2);
      await waitFor(S, '.sheaf-linkpop');
      await S.clipboard.write('SENTINEL-pop');
      await S.click('.sheaf-linkpop [data-action="copy"]');
      const clip = await clipboardAfter(S, 'SENTINEL-pop');
      return { ok: clip === 'https://a.io/g', detail: show(clip) };
    },
  },
  {
    id: 'menus.link-popover.e06',
    feature: 'menus.link-popover',
    name: 'Type a wrong address into the popover and press Escape: the file is unchanged, and the popover shows the real address when the link is clicked again',
    run: async (S) => {
      await S.fresh('pop-escape', 'Plain words first.\n\nRead the [guide](https://a.io/g) first.\n');
      await S.caret('guide', 2);
      await waitFor(S, '.sheaf-linkpop');
      await S.click('.sheaf-linkpop-url');
      await S.press('Meta+a');
      await S.type('typo');
      await S.press('Escape');
      const closed = await waitFor(S, '.sheaf-linkpop', false, 1000);
      const d = await S.disk();
      await S.caret('Plain words', 2);
      await S.caret('guide', 3);
      await waitFor(S, '.sheaf-linkpop');
      const again = await S.eval(() => document.querySelector('.sheaf-linkpop-url')?.value);
      await S.shot('pop-escape-again');
      return { ok: closed && d === 'Plain words first.\n\nRead the [guide](https://a.io/g) first.\n' && again === 'https://a.io/g', detail: `closed ${closed} field again ${j(again)}; ${show(d)}` };
    },
  },
  {
    id: 'menus.link-popover.e07',
    feature: 'menus.link-popover',
    name: 'Click a link on a line at the bottom of the window: the popover is inside the window',
    run: async (S) => {
      const doc = Array.from({ length: 40 }, (_, i) => `Row ${i + 1} has a [link ${i + 1}](https://a.io/${i + 1}) in it`).join('\n\n') + '\n';
      await S.fresh('pop-bottom', doc);
      const line = await lineNearBottom(S, '^Row \\d+ has');
      if (!line) return { ok: false, detail: 'no line near the bottom' };
      const n = /^Row (\d+)/.exec(line)[1];
      await S.caret(`link ${n}`, 2);
      await waitFor(S, '.sheaf-linkpop');
      const pop = await boxOf(S, '.sheaf-linkpop');
      await S.shot('pop-bottom');
      return { ok: !!pop && pop.bottom <= pop.h && pop.top >= 0, detail: `line ${j(line)} popover ${j(pop)}` };
    },
  },
  {
    id: 'menus.link-popover.e08',
    feature: 'menus.link-popover',
    name: 'While typing a new address in the popover, the file gains a line above from outside: the typed address is kept and Enter saves it',
    run: async (S) => {
      const doc = 'Plain words first.\n\nRead the [guide](https://a.io/g) first.\n';
      await S.fresh('pop-outside', doc);
      await S.caret('guide', 2);
      await waitFor(S, '.sheaf-linkpop');
      await S.click('.sheaf-linkpop-url');
      await S.press('Meta+a');
      await S.type('https://new.io');
      await S.writeDisk('Added by an agent.\n\n' + doc);
      const field = await S.eval(() => document.querySelector('.sheaf-linkpop-url')?.value ?? null);
      if (field !== null) {
        await S.click('.sheaf-linkpop-url');
        await S.press('End');
        await S.press('Enter');
      }
      const d = await S.disk();
      return { ok: field === 'https://new.io' && d.includes('[guide](https://new.io)'), detail: `field after outside change ${j(field)}; ${show(d)}` };
    },
  },

  /* ==== menus.slash ==== */
  {
    id: 'menus.slash.e01',
    feature: 'menus.slash',
    name: 'Click an empty line, type /, click Heading 2, type Title: the file has a Heading 2',
    run: async (S) => {
      await S.fresh('slash-h2', 'Top words\n\n');
      await clickLastLine(S);
      await S.type('/');
      const shown = await waitFor(S, '.sheaf-slash-menu');
      const count = await S.eval(() => document.querySelectorAll('.sheaf-slash-menu .sheaf-slash-item').length);
      await S.menu('Heading 2');
      await S.type('Title');
      const d = await S.disk();
      return { ok: shown && count === 15 && d === 'Top words\n\n## Title', detail: `shown ${shown} items ${count}; ${show(d)}` };
    },
  },
  {
    id: 'menus.slash.e02',
    feature: 'menus.slash',
    name: 'Click right after "https:" and type /: no menu, and the slash is in the file',
    run: async (S) => {
      await S.fresh('slash-url', 'see https: now\n');
      await S.caret(' now', 0);
      await S.type('/');
      await S.sleep(300);
      const shown = await S.exists('.sheaf-slash-menu');
      const d = await S.disk();
      return { ok: !shown && d === 'see https:/ now\n', detail: `shown ${shown}; ${show(d)}` };
    },
  },
  {
    id: 'menus.slash.e03',
    feature: 'menus.slash',
    name: 'Click in the middle of a word and type /: no menu',
    run: async (S) => {
      await S.fresh('slash-midword', 'and/or either\n');
      await S.caret('either', 3);
      await S.type('/');
      await S.sleep(300);
      const shown = await S.exists('.sheaf-slash-menu');
      const d = await S.disk();
      return { ok: !shown && d === 'and/or eit/her\n', detail: `shown ${shown}; ${show(d)}` };
    },
  },
  {
    id: 'menus.slash.e04',
    feature: 'menus.slash',
    name: 'Click after a space inside a code block and type /: no menu',
    run: async (S) => {
      await S.fresh('slash-code', 'Intro\n\n```\nlet a = 1;\n```\n');
      await S.caret('= 1;', 0);
      await S.type('/');
      await S.sleep(300);
      const shown = await S.exists('.sheaf-slash-menu');
      const d = await S.disk();
      return { ok: !shown && d === 'Intro\n\n```\nlet a /= 1;\n```\n', detail: `shown ${shown}; ${show(d)}` };
    },
  },
  {
    id: 'menus.slash.e05',
    feature: 'menus.slash',
    name: 'Type /hea and press Escape: the menu closes and /hea stays; a later /zzz opens it saying nothing matches',
    run: async (S) => {
      await S.fresh('slash-escape', 'Top words\n\n');
      await clickLastLine(S);
      await S.type('/hea');
      const shown = await waitFor(S, '.sheaf-slash-menu');
      await S.press('Escape');
      const closed = await waitFor(S, '.sheaf-slash-menu', false, 800);
      // A query that matches nothing keeps the menu open and says so, so one backspace can bring
      // the list back. Escape is what puts it away for good.
      await S.type(' /zzz');
      await S.sleep(400);
      const zzz = await S.eval(() => {
        const menu = document.querySelector('.sheaf-slash-menu');
        if (!menu) return { open: false };
        return {
          open: true,
          empty: !!menu.querySelector('.sheaf-slash-empty'),
          items: menu.querySelectorAll('.sheaf-slash-item').length,
        };
      });
      await S.press('Escape');
      const goneAgain = await waitFor(S, '.sheaf-slash-menu', false, 800);
      const d = await S.disk();
      return {
        ok: shown && closed && zzz.open && zzz.empty && zzz.items === 0 && goneAgain && d === 'Top words\n\n/hea /zzz',
        detail: `shown ${shown} closed ${closed} on /zzz ${j(zzz)} closed again ${goneAgain}; ${show(d)}`,
      };
    },
  },
  {
    id: 'menus.slash.e06',
    feature: 'menus.slash',
    name: 'Click at the start of a paragraph\'s second line, type /h2 and press Enter: only that line becomes a heading',
    run: async (S) => {
      await S.fresh('slash-second-line', 'first line of text\nsecond line of text\n');
      await S.caret('second line', 0);
      await S.type('/h2');
      const shown = await waitFor(S, '.sheaf-slash-menu');
      await S.press('Enter');
      const d = await S.disk();
      return { ok: d === 'first line of text\n## second line of text\n', detail: `shown ${shown}; ${show(d)}` };
    },
  },
  {
    id: 'menus.slash.e07',
    feature: 'menus.slash',
    name: 'Type / after a space on a line at the bottom of the window: the whole menu is inside the window',
    run: async (S) => {
      await S.fresh('slash-bottom', LONG);
      const line = await lineNearBottom(S, '^Line \\d+ holds');
      if (!line) return { ok: false, detail: 'no line near the bottom' };
      await S.caret(line, line.indexOf('some'));
      await S.type('/');
      await waitFor(S, '.sheaf-slash-menu');
      const menu = await boxOf(S, '.sheaf-slash-menu');
      await S.shot('slash-bottom');
      return { ok: !!menu && menu.bottom <= menu.h && menu.top >= 0, detail: `line ${j(line)} menu ${j(menu)}` };
    },
  },
  {
    id: 'menus.slash.e08',
    feature: 'menus.slash',
    name: 'Open the slash menu, then scroll: the menu closes or stays next to the slash',
    run: async (S) => {
      await S.fresh('slash-scroll', LONG);
      await S.caret('Line 5 holds', 'Line 5 holds '.length);
      await S.type('/');
      await waitFor(S, '.sheaf-slash-menu');
      await S.hover({ text: 'Line 3 holds', offset: 2 });
      await S.page.mouse.wheel(0, 300);
      await S.sleep(600);
      const menu = await boxOf(S, '.sheaf-slash-menu');
      const word = await textBox(S, 'Line 5 holds');
      await S.shot('slash-scroll');
      if (!menu) return { ok: true, detail: 'menu closed on scroll' };
      const near = word && Math.abs(menu.top - word.bottom) < 40;
      return { ok: !!near, detail: `menu top ${menu.top}, line bottom now ${word && word.bottom}` };
    },
  },
  {
    id: 'menus.slash.e09',
    feature: 'menus.slash',
    name: 'Type / and then click a word in another paragraph: the menu closes and the slash stays',
    run: async (S) => {
      await S.fresh('slash-click-away', 'Top words here\n\n');
      await clickLastLine(S);
      await S.type('/');
      await waitFor(S, '.sheaf-slash-menu');
      await S.caret('words', 2);
      const closed = await waitFor(S, '.sheaf-slash-menu', false, 800);
      const d = await S.disk();
      return { ok: closed && d === 'Top words here\n\n/', detail: `closed ${closed}; ${show(d)}` };
    },
  },
  {
    id: 'menus.slash.e10',
    feature: 'menus.slash',
    name: 'Mistype /tabel: the menu stays open saying nothing matches, and backspacing to /tab brings the list back',
    run: async (S) => {
      await S.fresh('slash-typo', '');
      await clickLastLine(S);
      await S.type('/tabel');
      await S.sleep(300);
      const read = () =>
        S.eval(() => {
          const menu = document.querySelector('.sheaf-slash-menu');
          if (!menu) return { open: false, empty: null, items: [] };
          const empty = menu.querySelector('.sheaf-slash-empty');
          return {
            open: true,
            empty: empty ? empty.textContent : null,
            items: [...menu.querySelectorAll('.sheaf-slash-item')].map((i) => i.textContent.trim().split('\n')[0]),
            selected: [...menu.querySelectorAll('.sheaf-slash-item')].findIndex((i) => i.className.includes('is-selected')),
          };
        });
      const typo = await read();
      await S.press('Backspace');
      await S.press('Backspace');
      await S.press('Backspace');
      await S.sleep(300);
      const recovered = await read();
      await S.press('Enter');
      const d = await S.disk();
      // `/tab` lists Task list first, so Enter inserts that one: what matters is that the
      // highlighted item went in and the typed query is gone.
      const inserted = !d.includes('/tab') && d.trim().length > 0;
      return {
        ok: typo.open && typo.empty !== null && typo.items.length === 0 && recovered.open && recovered.items.length > 0 && recovered.selected === 0 && inserted,
        detail: `after /tabel ${show(typo)}; after three backspaces ${show(recovered)}; file ${show(d)}`,
      };
    },
  },

  {
    id: 'menus.slash.e11',
    feature: 'menus.slash',
    name: 'Every slash row draws an icon and the Markdown it writes, with the labels in one column',
    run: async (S) => {
      await S.fresh('slash-icons', '');
      await clickLastLine(S);
      await S.type('/');
      await waitFor(S, '.sheaf-slash-menu');
      await S.sleep(300);
      const rows = await S.eval(() =>
        [...document.querySelectorAll('.sheaf-slash-menu .sheaf-slash-item')].map((row) => {
          const icon = row.querySelector('.sheaf-slash-icon');
          const label = row.querySelector('.sheaf-slash-label');
          const hint = row.querySelector('.sheaf-slash-hint');
          const box = (el) => (el ? Math.round(el.getBoundingClientRect().left) : null);
          const cs = (el) => (el ? getComputedStyle(el) : null);
          return {
            label: label ? label.textContent : null,
            hint: hint ? hint.textContent : null,
            // An icon that drew nothing is a blank column, which is worse than no column.
            drew: !!icon && icon.getBoundingClientRect().width > 8 && !!icon.querySelector('svg'),
            hidden: icon ? icon.getAttribute('aria-hidden') === 'true' : false,
            hintHidden: hint ? hint.getAttribute('aria-hidden') === 'true' : true,
            labelLeft: box(label),
            hintRight: hint ? Math.round(hint.getBoundingClientRect().right) : null,
            rowRight: Math.round(row.getBoundingClientRect().right),
            height: Math.round(row.getBoundingClientRect().height),
            hintColour: cs(hint) ? cs(hint).color : null,
            labelColour: cs(label) ? cs(label).color : null,
          };
        })
      );
      await S.press('Escape');
      const lefts = [...new Set(rows.map((r) => r.labelLeft))];
      const hinted = rows.filter((r) => r.hint !== null);
      // The hint sits at the right edge of its row, and never past it.
      const flush = hinted.every((r) => r.rowRight - r.hintRight >= 0 && r.rowRight - r.hintRight <= 12);
      const oneLine = rows.every((r) => r.height <= 32);
      // How many rows the menu offers is e01's question. What this one holds is that
      // whatever the list turns out to be, every row of it is built the same way.
      return {
        ok:
          rows.length > 0 &&
          rows.every((r) => r.drew && r.hidden && r.hintHidden) &&
          lefts.length === 1 &&
          hinted.length > 0 &&
          flush &&
          oneLine &&
          hinted.every((r) => r.hintColour !== r.labelColour),
        detail: `${rows.length} rows; label column at ${j(lefts)}; ${hinted.length} carry Markdown; flush right ${flush}; heights ${j([...new Set(rows.map((r) => r.height))])}; hint colour ${hinted[0] && hinted[0].hintColour} against label ${hinted[0] && hinted[0].labelColour}; ${j(rows.map((r) => [r.label, r.hint]))}`,
      };
    },
  },

  /* ==== menus.find-replace ==== */
  {
    id: 'menus.find-replace.e01',
    feature: 'menus.find-replace',
    name: 'Open find, type kiwi: the count reads 3 matches; click Next: 1 of 3; click Close: the bar goes',
    run: async (S) => {
      await S.fresh('find-count', 'one kiwi\n\ntwo kiwi\n\nthree kiwi\n');
      const note = await openFind(S, 'one');
      await S.click('.sheaf-find-input[name="search"]');
      await S.type('kiwi');
      const c1 = await findCount(S);
      await S.click('.sheaf-find button[name="next"]');
      const c2 = await findCount(S);
      await S.click('.sheaf-find button[name="close"]');
      const gone = await waitFor(S, '.sheaf-find', false, 800);
      return { ok: c1 === '3 matches' && c2 === '1 of 3' && gone, detail: `${note}${j(c1)} ${j(c2)} gone ${gone}` };
    },
  },
  {
    id: 'menus.find-replace.e02',
    feature: 'menus.find-replace',
    name: 'Replace all kiwi with pear, including a table cell, then click Undo: the file is back as it was',
    run: async (S) => {
      const doc = 'one kiwi\n\n| fruit | qty |\n| --- | --- |\n| kiwi | 2 |\n\nlast kiwi\n';
      await S.fresh('find-replace-all', doc);
      const note = await openFind(S, 'one', true);
      await S.click('.sheaf-find-input[name="search"]');
      await S.type('kiwi');
      await S.click('.sheaf-find-input[name="replace"]');
      await S.type('pear');
      await S.click('.sheaf-find button[name="replaceAll"]');
      const replaced = await S.disk();
      await S.toolbar('Undo');
      const undone = await S.disk();
      return { ok: replaced === doc.replace(/kiwi/g, 'pear') && undone === doc, detail: `${note}replaced ${show(replaced)} undone ${show(undone)}` };
    },
  },
  {
    id: 'menus.find-replace.e03',
    feature: 'menus.find-replace',
    name: 'Turn on regular expressions and replace (\\w+)@x\\.io with $1@y.org: every address changes',
    run: async (S) => {
      await S.fresh('find-regex', 'Mail ann@x.io and bob@x.io today.\n');
      const note = await openFind(S, 'Mail', true);
      await S.click('.sheaf-find button[name="regexp"]');
      await S.click('.sheaf-find-input[name="search"]');
      await S.type('(\\w+)@x\\.io');
      await S.click('.sheaf-find-input[name="replace"]');
      await S.type('$1@y.org');
      await S.click('.sheaf-find button[name="replaceAll"]');
      const d = await S.disk();
      return { ok: d === 'Mail ann@y.org and bob@y.org today.\n', detail: `${note}${show(d)}` };
    },
  },
  {
    id: 'menus.find-replace.e04',
    feature: 'menus.find-replace',
    name: 'Search for a word that is not there: No results; an invalid pattern: Invalid pattern; Replace all changes nothing',
    run: async (S) => {
      const doc = 'alpha beta\n';
      await S.fresh('find-none', doc);
      const note = await openFind(S, 'alpha', true);
      await S.click('.sheaf-find-input[name="search"]');
      await S.type('zzz');
      const none = await findCount(S);
      await S.click('.sheaf-find button[name="regexp"]');
      await S.click('.sheaf-find-input[name="search"]');
      await S.press('Meta+a');
      await S.type('(');
      const invalid = await findCount(S);
      await S.click('.sheaf-find-input[name="replace"]');
      await S.type('x');
      await S.click('.sheaf-find button[name="replaceAll"]');
      const d = await S.disk();
      return { ok: none === 'No results' && invalid === 'Invalid pattern' && d === doc, detail: `${note}${j(none)} ${j(invalid)} ${show(d)}` };
    },
  },
  {
    id: 'menus.find-replace.e05',
    feature: 'menus.find-replace',
    name: 'Search for C:\\new in a document that contains it: one match',
    run: async (S) => {
      await S.fresh('find-backslash', 'Saved under C:\\new today.\n');
      const note = await openFind(S, 'Saved');
      await S.click('.sheaf-find-input[name="search"]');
      await S.type('C:\\new');
      const c = await findCount(S);
      const typed = await S.eval(() => document.querySelector('.sheaf-find-input[name="search"]').value);
      return { ok: c === '1 match', detail: `${note}field ${j(typed)} count ${j(c)}` };
    },
  },
  {
    id: 'menus.find-replace.e06',
    feature: 'menus.find-replace',
    name: 'Step to a match inside a table and click Replace: only that cell changes, and the table is a grid again once the match moves on',
    run: async (S) => {
      const doc = 'Intro line\n\n| fruit | qty |\n| --- | --- |\n| kiwi | 2 |\n\nkiwi end\n';
      await S.fresh('find-table', doc);
      const note = await openFind(S, 'Intro', true);
      await S.click('.sheaf-find-input[name="search"]');
      await S.type('kiwi');
      await S.click('.sheaf-find-input[name="replace"]');
      await S.type('pear');
      await S.click('.sheaf-find button[name="next"]');
      const asText = !(await S.exists('.sheaf-table'));
      await S.click('.sheaf-find button[name="replace"]');
      const d = await S.disk();
      await S.sleep(300);
      const grid = await S.exists('.sheaf-table');
      return { ok: d === 'Intro line\n\n| fruit | qty |\n| --- | --- |\n| pear | 2 |\n\nkiwi end\n' && grid, detail: `${note}table as text on match ${asText}, grid after ${grid}; ${show(d)}` };
    },
  },
  {
    id: 'menus.find-replace.e07',
    feature: 'menus.find-replace',
    name: 'Find a word, press Escape: the bar closes, the editor has focus, and typing replaces the found word',
    run: async (S) => {
      await S.fresh('find-escape', 'one kiwi two\n');
      const note = await openFind(S, 'one');
      await S.click('.sheaf-find-input[name="search"]');
      await S.type('kiwi');
      await S.press('Enter');
      await S.press('Escape');
      const gone = await waitFor(S, '.sheaf-find', false, 800);
      const st = await S.state();
      await S.type('Z');
      const d = await S.disk();
      return { ok: gone && st.focused && d === 'one Z two\n', detail: `${note}gone ${gone} focused ${st.focused}; ${show(d)}` };
    },
  },
  {
    id: 'menus.find-replace.e08',
    feature: 'menus.find-replace',
    name: 'Finding text that sits only in a link address counts it, shows that link as written while it is the current match, and draws the link again after',
    run: async (S) => {
      const doc = 'Intro words here.\n\nRead the [project docs](https://quartzline.example/guide) today.\n\nLast line.\n';
      await S.fresh('find-in-address', doc);
      const lineText = () => S.eval(() => [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('Read the'))?.textContent ?? null);
      const drawnBefore = await lineText();
      const note = await openFind(S, 'Intro');
      await S.click('.sheaf-find-input[name="search"]');
      await S.type('quartzline');
      await S.press('Enter');
      await S.sleep(300);
      const count = await findCount(S);
      const whileCurrent = await lineText();
      const sel = await S.eval(() => String(getSelection() ?? ''));
      await S.click('.sheaf-find button[name="close"]');
      await S.caret('Last', 2);
      await S.sleep(300);
      const drawnAfter = await lineText();
      const d = await S.disk();
      const hidden = (t) => t !== null && !t.includes('quartzline') && t.includes('project docs');
      const shown = (t) => t !== null && t.includes('quartzline.example/guide');
      return {
        ok: hidden(drawnBefore) && count === '1 of 1' && shown(whileCurrent) && hidden(drawnAfter) && d === doc,
        detail: `${note}before ${j(drawnBefore)}; count ${j(count)}; while current ${j(whileCurrent)} (selection ${j(sel)}); after ${j(drawnAfter)}${d === doc ? '' : '; file changed'}`,
      };
    },
  },
];
