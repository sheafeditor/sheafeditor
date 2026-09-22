// E2E scenarios for block editing, driven by real mouse moves in VS Code: the grip
// menu, dragging a block, the + button, block selection from the keyboard and
// Alt+arrow moves. Results are read from the file on disk and the rendered lines.
import { readFileSync } from 'node:fs';
import { show } from '../session.mjs';

const DOC = '# Alpha\n\nFirst paragraph here.\n\n# Beta\n\nSecond paragraph here.\n';
const FM = '---\ntitle: x\n---\n\nIntro text here.\n\n## Next\n';
const LIST = '- Apple\n  - Apple child\n- Banana\n- Cherry\n';
const TABLE_DOC = 'Move me please.\n\n| Name | Role |\n| --- | --- |\n| Ada | Eng |\n\nEnd line.\n';

/** Hover a block's text and return the grip's window position once the handle shows. */
async function grip(S, text, occurrence = 0) {
  await S.hover({ text, offset: 1, occurrence });
  for (let i = 0; i < 15; i++) {
    if (await S.exists('.sheaf-block-grip')) return S.locate('.sheaf-block-grip');
    await S.sleep(100);
  }
  throw new Error(`no grip appeared while hovering ${JSON.stringify(text)}`);
}

async function openMenu(S, text, occurrence = 0) {
  await grip(S, text, occurrence);
  await S.click('.sheaf-block-grip');
  await S.sleep(200);
  if (!(await S.exists('.sheaf-block-menu-item'))) throw new Error('block menu did not open');
}

/** Press keys only while the editor has keyboard focus, so a lost focus is not read as a block bug. */
async function keys(S, spec) {
  const st = await S.state();
  if (!st.focused) throw new Error(`editor lost keyboard focus before ${spec} (active: ${st.active})`);
  await S.press(spec);
}

/** Window y just above a rendered text's line (to drop before its block) or just below it. */
async function yAbove(S, text, occurrence = 0) {
  return (await S.locate({ text, offset: 1, occurrence })).y - 16;
}
async function yBelow(S, text, occurrence = 0) {
  return (await S.locate({ text, offset: 1, occurrence })).y + 16;
}

/** Press the grip, move in steps to `toY` (and `toX` if given), optionally do something mid-drag, then release. */
async function dragGrip(S, text, toY, { occurrence = 0, toX, steps = 16, during } = {}) {
  const g = await grip(S, text, occurrence);
  await S.page.mouse.move(g.x, g.y, { steps: 3 });
  await S.page.mouse.down();
  await S.page.mouse.move(g.x, g.y + 8, { steps: 3 });
  await S.page.mouse.move(toX ?? g.x, toY, { steps });
  await S.sleep(250);
  let mid = null;
  if (during) mid = await during(g);
  await S.page.mouse.up();
  await S.sleep(500);
  return mid;
}

/** Scroll the editor with the mouse wheel until `text` sits in the lower part of the window. */
async function scrollUntilVisible(S, text) {
  const height = await S.page.evaluate(() => window.innerHeight);
  const sc = await S.locate({ sel: '.cm-scroller' });
  await S.page.mouse.move(sc.x, sc.y, { steps: 2 });
  for (let i = 0; i < 40; i++) {
    try {
      const p = await S.locate({ text, offset: 1 });
      if (p.y > 0 && p.y < height - 60) return p;
    } catch {}
    await S.page.mouse.wheel(0, 200);
    await S.sleep(250);
  }
  throw new Error(`could not scroll ${JSON.stringify(text)} into view`);
}

const selectedLines = (S) => S.eval(() => [...document.querySelectorAll('.cm-line.sheaf-block-selected')].map((l) => l.textContent));
const menuLabels = (S) => S.eval(() => [...document.querySelectorAll('.sheaf-block-menu:not(.sheaf-block-submenu) .sheaf-block-menu-item')].map((b) => `${b.firstChild.textContent}${b.disabled ? '(disabled)' : ''}`));
const clipboard = (S) => S.app.evaluate(({ clipboard: c }) => c.readText());

export const scenarios = [
  // ---- blocks.handle-menu ------------------------------------------------------
  {
    id: 'blocks.handle-menu.e01',
    feature: 'blocks.handle-menu',
    name: 'Clicking the grip opens the block menu, and Duplicate puts a copy under the paragraph',
    run: async (S) => {
      await S.fresh('menu-duplicate', DOC);
      await openMenu(S, 'First paragraph');
      const labels = (await menuLabels(S)).join('|');
      await S.menu('Duplicate');
      const d = await S.disk();
      const want = '# Alpha\n\nFirst paragraph here.\n\nFirst paragraph here.\n\n# Beta\n\nSecond paragraph here.\n';
      // Edit Markdown sits second, straight after Turn into: showing a block's source
      // is the move Sheaf is built around, so the menus lead with it.
      return {
        ok: labels.startsWith('Turn into|Edit Markdown|Duplicate|Move up|Move down|Delete') && d === want,
        detail: `menu ${labels}; file ${show(d)}`,
      };
    },
  },
  {
    id: 'blocks.handle-menu.e02',
    feature: 'blocks.handle-menu',
    name: 'Under front matter, Move up is disabled and Move down moves the block without touching the front matter',
    run: async (S) => {
      await S.fresh('menu-fm-move', FM);
      await openMenu(S, 'Intro text');
      const labels = (await menuLabels(S)).join('|');
      await S.menu('Move down');
      const d = await S.disk();
      return { ok: labels.includes('Move up(disabled)') && d === '---\ntitle: x\n---\n\n## Next\n\nIntro text here.\n', detail: `menu ${labels}; file ${show(d)}` };
    },
  },
  {
    id: 'blocks.handle-menu.e03',
    feature: 'blocks.handle-menu',
    name: 'Delete from the menu removes the paragraph, and Cmd+Z brings the file back byte for byte',
    run: async (S) => {
      await S.fresh('menu-delete-undo', DOC);
      await S.caret('Second', 2);
      await openMenu(S, 'First paragraph');
      await S.menu('Delete');
      const del = await S.disk();
      await keys(S, 'Meta+z');
      const back = await S.disk();
      return { ok: del === '# Alpha\n\n# Beta\n\nSecond paragraph here.\n' && back === DOC, detail: `deleted ${show(del)} undone ${show(back)}` };
    },
  },
  {
    id: 'blocks.handle-menu.e04',
    feature: 'blocks.handle-menu',
    name: 'Turn into > Heading 2 from the submenu makes the paragraph a heading',
    run: async (S) => {
      await S.fresh('menu-turn-into', DOC);
      await openMenu(S, 'First paragraph');
      await S.hover({ sel: '.sheaf-block-menu-item', hasText: 'Turn into' });
      await S.sleep(200);
      await S.click({ sel: '.sheaf-block-submenu .sheaf-block-menu-item', hasText: 'Heading 2' });
      const d = await S.disk();
      return { ok: d === '# Alpha\n\n## First paragraph here.\n\n# Beta\n\nSecond paragraph here.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.handle-menu.e05',
    feature: 'blocks.handle-menu',
    name: 'Hovering the front matter shows no grip beside it',
    run: async (S) => {
      await S.fresh('menu-fm-nogrip', FM);
      await S.hover({ text: 'Intro text', offset: 1 });
      const onBody = await S.exists('.sheaf-block-grip');
      const title = await S.hover({ text: 'title', offset: 1 });
      await S.page.mouse.move(title.x + 20, title.y, { steps: 4 });
      await S.sleep(800);
      await S.shot('handle-menu-e05-fm');
      // A grip may linger beside the body block it last belonged to; what must not exist is one beside the front matter.
      let gripY = null;
      if (await S.exists('.sheaf-block-grip')) gripY = (await S.locate('.sheaf-block-grip')).y;
      const besideFm = gripY !== null && Math.abs(gripY - title.y) < 20;
      return { ok: onBody && !besideFm, detail: `grip on body ${onBody}; with the pointer on the front matter (y ${Math.round(title.y)}) the grip is ${gripY === null ? 'hidden' : `at y ${Math.round(gripY)}`}` };
    },
  },
  {
    id: 'blocks.handle-menu.e06',
    feature: 'blocks.handle-menu',
    name: 'Delete on a list item with a nested item removes both lines',
    run: async (S) => {
      await S.fresh('menu-delete-nested', LIST);
      await openMenu(S, 'Apple');
      await S.menu('Delete');
      const d = await S.disk();
      return { ok: d === '- Banana\n- Cherry\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.handle-menu.e07',
    feature: 'blocks.handle-menu',
    name: "Copy ref puts the file's path, the block's line and the line itself on the clipboard",
    run: async (S) => {
      await S.fresh('menu-copy-ref', DOC);
      await S.app.evaluate(({ clipboard: c }) => c.writeText('before'));
      await openMenu(S, 'First paragraph');
      await S.menu('Copy ref');
      await S.sleep(500);
      const clip = await clipboard(S);
      const d = await S.disk();
      // The location alone told whoever received it where to look without saying what
      // was there. A one-line block is quoted now, the same as a selection and a single
      // table row, fenced so what is quoted cannot be mistaken for the message around it.
      const want = 'e2e/menu-copy-ref.md:3\n\n```\nFirst paragraph here.\n```\n';
      return { ok: clip === want && d === DOC, detail: `clipboard ${show(clip)}, want ${show(want)}` };
    },
  },
  {
    id: 'blocks.handle-menu.e08',
    feature: 'blocks.handle-menu',
    name: 'Escape closes the block menu and leaves the file alone',
    run: async (S) => {
      await S.fresh('menu-escape', DOC);
      await S.caret('Second', 2);
      await openMenu(S, 'First paragraph');
      await S.press('Escape');
      await S.sleep(200);
      const open = await S.exists('.sheaf-block-menu-item');
      const d = await S.disk();
      return { ok: !open && d === DOC, detail: `menu still open ${open}; file ${show(d)}` };
    },
  },
  {
    id: 'blocks.handle-menu.e09',
    feature: 'blocks.handle-menu',
    name: 'Hovering a table shows a grip whose menu moves the whole table',
    run: async (S) => {
      await S.fresh('menu-table', TABLE_DOC);
      await S.hover({ text: 'Move me', offset: 1 });
      const onText = await S.exists('.sheaf-block-grip');
      await S.hover({ text: 'Ada', offset: 1 });
      await S.sleep(500);
      const onTable = await S.exists('.sheaf-block-grip');
      await S.shot('handle-menu-e09-table-hover');
      if (!onTable) return { ok: false, detail: `grip on text ${onText}, on table ${onTable}` };
      await S.click('.sheaf-block-grip');
      await S.menu('Move up');
      const d = await S.disk();
      return { ok: d === '| Name | Role |\n| --- | --- |\n| Ada | Eng |\n\nMove me please.\n\nEnd line.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.handle-menu.e10',
    feature: 'blocks.handle-menu',
    name: 'After opening the menu with a click, the arrow keys reach Duplicate and Enter runs it',
    run: async (S) => {
      await S.fresh('menu-keys', DOC);
      await S.caret('First', 2);
      await openMenu(S, 'Second paragraph');
      // Walk down to Duplicate by name rather than by a count of presses. The count
      // was two, and adding Edit Markdown above Duplicate made it three; what this
      // checks is that the keys can reach an item and run it, not where it sits.
      let focused = '';
      for (let i = 0; i < 8 && !focused.startsWith('Duplicate'); i++) {
        await S.press('ArrowDown');
        focused = (await S.eval(() => document.activeElement && document.activeElement.textContent)) ?? '';
      }
      await S.press('Enter');
      const d = await S.disk();
      return { ok: d === DOC + '\nSecond paragraph here.\n', detail: `focused ${show(focused)}; file ${show(d)}` };
    },
  },

  {
    id: 'blocks.handle-menu.e11',
    feature: 'blocks.handle-menu',
    name: 'Turn into > Numbered list on a bullet item with a nested item keeps the nested item under it: selecting the item still takes its child',
    run: async (S) => {
      await S.fresh('menu-turn-numbered-nested', LIST);
      await openMenu(S, 'Apple');
      await S.hover({ sel: '.sheaf-block-menu-item', hasText: 'Turn into' });
      await S.sleep(200);
      await S.click({ sel: '.sheaf-block-submenu .sheaf-block-menu-item', hasText: 'Numbered list' });
      const d = await S.disk();
      await S.sleep(300);
      const apple = await S.locate({ text: 'Apple', offset: 0 });
      const child = await S.locate({ text: 'Apple child', offset: 0 });
      await S.shot('handle-menu-e11-after');
      // What the item now is, as Sheaf itself sees it: Escape on it selects the item and its children.
      await S.caret('Apple', 2);
      await keys(S, 'Escape');
      const sel = await selectedLines(S);
      return { ok: d.startsWith('1. Apple\n') && sel.length === 2, detail: `file ${show(d)}; Apple at x ${Math.round(apple.x)}, Apple child at x ${Math.round(child.x)}; Escape on Apple selects ${show(sel)}` };
    },
  },

  // ---- blocks.drag -------------------------------------------------------------
  {
    id: 'blocks.drag.e01',
    feature: 'blocks.drag',
    name: 'Dragging a paragraph by its grip to below the last paragraph moves it there',
    run: async (S) => {
      await S.fresh('drag-to-end', DOC);
      const y = await yBelow(S, 'Second paragraph');
      await dragGrip(S, 'First paragraph', y);
      const d = await S.disk();
      return { ok: d === '# Alpha\n\n# Beta\n\nSecond paragraph here.\n\nFirst paragraph here.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.drag.e02',
    feature: 'blocks.drag',
    name: 'While dragging, a drop line shows and the carried block is dimmed; both go away on release',
    run: async (S) => {
      await S.fresh('drag-indicator', DOC);
      const y = await yBelow(S, 'Second paragraph');
      const mid = await dragGrip(S, 'First paragraph', y, {
        during: async () => {
          await S.shot('drag-e02-mid');
          return S.eval(() => ({ drop: !!document.querySelector('.sheaf-block-drop:not([hidden])'), dimmed: [...document.querySelectorAll('.cm-line.sheaf-block-dragging')].map((l) => l.textContent) }));
        },
      });
      const afterUp = await S.eval(() => ({ drop: !!document.querySelector('.sheaf-block-drop:not([hidden])'), dimmed: document.querySelectorAll('.cm-line.sheaf-block-dragging').length }));
      return { ok: mid.drop && mid.dimmed.join('|') === 'First paragraph here.' && !afterUp.drop && afterUp.dimmed === 0, detail: `mid ${JSON.stringify(mid)} after ${JSON.stringify(afterUp)}` };
    },
  },
  {
    id: 'blocks.drag.e03',
    feature: 'blocks.drag',
    name: 'Dragging a list item with a nested item to the end of the list carries the nested item',
    run: async (S) => {
      await S.fresh('drag-nested', LIST);
      const y = await yBelow(S, 'Cherry');
      await dragGrip(S, 'Apple', y);
      const d = await S.disk();
      return { ok: d === '- Banana\n- Cherry\n- Apple\n  - Apple child\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.drag.e04',
    feature: 'blocks.drag',
    name: 'A list item dragged far below its list lands at the end of its own list, and the list stays one list',
    run: async (S) => {
      const doc = '- One\n- Two\n\nAfter the list.\n\nLast words here.\n';
      await S.fresh('drag-item-out', doc);
      const y = await yBelow(S, 'Last words');
      await dragGrip(S, 'One', y);
      const d = await S.disk();
      return { ok: d === '- Two\n- One\n\nAfter the list.\n\nLast words here.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.drag.e05',
    feature: 'blocks.drag',
    name: 'Picking a block up and letting go where it started leaves the file alone',
    run: async (S) => {
      await S.fresh('drag-over-itself', DOC);
      const start = await S.locate({ text: 'First paragraph', offset: 1 });
      const g = await grip(S, 'First paragraph');
      await S.page.mouse.move(g.x, g.y, { steps: 3 });
      await S.page.mouse.down();
      await S.page.mouse.move(g.x, g.y + 40, { steps: 8 });
      await S.page.mouse.move(g.x, start.y, { steps: 8 });
      await S.sleep(250);
      await S.shot('drag-e05-before-release');
      await S.page.mouse.up();
      await S.sleep(500);
      const d = await S.disk();
      return { ok: d === DOC, detail: show(d) };
    },
  },
  {
    id: 'blocks.drag.e06',
    feature: 'blocks.drag',
    name: 'Escape in the middle of a drag cancels it: no drop line, and releasing moves nothing',
    run: async (S) => {
      await S.fresh('drag-escape', DOC);
      await S.caret('Second', 2);
      const y = await yBelow(S, 'Second paragraph');
      const mid = await dragGrip(S, 'First paragraph', y, {
        during: async () => {
          await S.page.keyboard.press('Escape');
          await S.sleep(200);
          return S.eval(() => ({ drop: !!document.querySelector('.sheaf-block-drop:not([hidden])'), dimmed: document.querySelectorAll('.cm-line.sheaf-block-dragging').length }));
        },
      });
      const d = await S.disk();
      return { ok: !mid.drop && mid.dimmed === 0 && d === DOC, detail: `after Escape ${JSON.stringify(mid)}; file ${show(d)}` };
    },
  },
  {
    id: 'blocks.drag.e07',
    feature: 'blocks.drag',
    name: 'Cmd+Z after a drag gives back the file byte for byte',
    run: async (S) => {
      await S.fresh('drag-undo', DOC);
      const y = await yBelow(S, 'Second paragraph');
      await dragGrip(S, 'First paragraph', y);
      const moved = await S.disk();
      await keys(S, 'Meta+z');
      const back = await S.disk();
      return { ok: moved !== DOC && back === DOC, detail: `moved ${show(moved)} undone ${show(back)}` };
    },
  },
  {
    id: 'blocks.drag.e08',
    feature: 'blocks.drag',
    name: 'Dragging a paragraph past a table leaves every table line as it was',
    run: async (S) => {
      await S.fresh('drag-past-table', TABLE_DOC);
      const y = await yAbove(S, 'End line');
      await dragGrip(S, 'Move me', y);
      const d = await S.disk();
      return { ok: d === '| Name | Role |\n| --- | --- |\n| Ada | Eng |\n\nMove me please.\n\nEnd line.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.drag.e09',
    feature: 'blocks.drag',
    name: 'Dragging a heading above the front matter puts it first after the front matter, which stays intact',
    run: async (S) => {
      await S.fresh('drag-above-fm', FM);
      const top = await S.locate({ text: 'title', offset: 1 });
      await dragGrip(S, 'Next', top.y - 30);
      const d = await S.disk();
      return { ok: d === '---\ntitle: x\n---\n\n## Next\n\nIntro text here.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.drag.e10',
    feature: 'blocks.drag',
    name: 'Releasing a drag over the VS Code sidebar drops at the shown slot or cancels, and leaves the editor ready: no dimmed block, grip back, clicks move nothing',
    run: async (S) => {
      await S.fresh('drag-release-outside', DOC);
      const y = await yBelow(S, 'Second paragraph');
      await dragGrip(S, 'First paragraph', y, { toX: 20 });
      await S.sleep(400);
      const probe = () => S.eval(() => ({ drop: !!document.querySelector('.sheaf-block-drop:not([hidden])'), dimmed: document.querySelectorAll('.cm-line.sheaf-block-dragging').length, dragging: !!document.querySelector('.cm-editor.sheaf-block-drag-active') }));
      const left = await probe();
      const d1 = await S.disk();
      await S.shot('drag-e10-after-release-outside');
      await S.caret('Second', 2);
      await S.sleep(300);
      const afterClick = await probe();
      const d2 = await S.disk();
      let gripBack = true;
      try {
        await grip(S, 'Second paragraph');
      } catch {
        gripBack = false;
      }
      // Then click the grip beside the last paragraph, as a person reaching for its menu would.
      let menuOpened = false;
      if (gripBack) {
        await S.click('.sheaf-block-grip');
        await S.sleep(400);
        menuOpened = await S.exists('.sheaf-block-menu-item');
        await S.page.keyboard.press('Escape');
      }
      const d3 = await S.disk();
      const moved = '# Alpha\n\n# Beta\n\nSecond paragraph here.\n\nFirst paragraph here.\n';
      const fileOk = (d1 === DOC || d1 === moved) && d2 === d1 && d3 === d1;
      const clean = (s) => !s.drop && s.dimmed === 0 && !s.dragging;
      return { ok: fileOk && clean(left) && clean(afterClick) && gripBack && menuOpened, detail: `after release ${JSON.stringify(left)} file ${show(d1)}; after a click in text ${JSON.stringify(afterClick)} file ${show(d2)}; grip shows on hover ${gripBack}; clicking the grip opened the menu ${menuOpened}, file then ${show(d3)}` };
    },
  },
  {
    id: 'blocks.drag.e11',
    feature: 'blocks.drag',
    name: 'Dragging in a CRLF file moves the block and every line ending stays CRLF',
    run: async (S) => {
      const crlf = DOC.replace(/\n/g, '\r\n');
      const path = await S.fresh('drag-crlf', crlf);
      const y = await yBelow(S, 'Second paragraph');
      await dragGrip(S, 'First paragraph', y);
      await S.disk();
      const d = readFileSync(path, 'utf8');
      return { ok: d === '# Alpha\r\n\r\n# Beta\r\n\r\nSecond paragraph here.\r\n\r\nFirst paragraph here.\r\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.drag.e12',
    feature: 'blocks.drag',
    name: 'Scrolling with the wheel mid-drag: the block lands right above the line the drop marker points at',
    run: async (S) => {
      const paras = Array.from({ length: 60 }, (_, i) => `Paragraph number ${String(i + 1).padStart(2, '0')} of the long file.`);
      const doc = paras.join('\n\n') + '\n';
      await S.fresh('drag-scroll', doc);
      const g = await grip(S, 'Paragraph number 02');
      await S.page.mouse.move(g.x, g.y, { steps: 3 });
      await S.page.mouse.down();
      await S.page.mouse.move(g.x, g.y + 60, { steps: 6 });
      const tx = g.x + 80;
      const ty = g.y + 200;
      await S.page.mouse.move(tx, ty, { steps: 6 });
      await S.page.mouse.wheel(0, 700);
      await S.sleep(500);
      await S.page.mouse.move(tx, ty + 5, { steps: 3 });
      await S.sleep(300);
      const marker = await S.eval(() => {
        const ind = document.querySelector('.sheaf-block-drop:not([hidden])');
        if (!ind) return null;
        const r = ind.getBoundingClientRect();
        const lines = [...document.querySelectorAll('.cm-content > .cm-line')].filter((l) => l.textContent.trim());
        const below = lines.map((l) => ({ t: l.textContent, top: l.getBoundingClientRect().top })).filter((l) => l.top >= r.top - 2).sort((a, b) => a.top - b.top)[0];
        return { top: r.top, below: below && below.t };
      });
      await S.shot('drag-e12-scrolled');
      await S.page.mouse.up();
      await S.sleep(500);
      const d = await S.disk();
      if (!marker || !marker.below) return { ok: false, detail: `no drop marker after scrolling: ${JSON.stringify(marker)} ${box}` };
      const moved = 'Paragraph number 02 of the long file.';
      const i = d.indexOf(moved);
      const nextStart = i + moved.length + 2;
      const lost = paras.some((p) => !d.includes(p)) || d.split('\n\n').length !== 60;
      return { ok: !lost && d.slice(nextStart).startsWith(marker.below) && i > d.indexOf('Paragraph number 03'), detail: `marker above ${show(marker.below)}; after drop the moved paragraph is followed by ${show(d.slice(nextStart, nextStart + 40))}` };
    },
  },
  {
    id: 'blocks.drag.e13',
    feature: 'blocks.drag',
    name: 'In sample/stress/deep-nesting.md, dragging Middle 1 below Middle 3 carries its numbered children and changes only those lines',
    run: async (S) => {
      const path = await S.open('stress/deep-nesting.md');
      const before = readFileSync(path, 'utf8');
      const lines = before.split('\n');
      await scrollUntilVisible(S, 'Outer 2');
      const y = await yAbove(S, 'Outer 2');
      await dragGrip(S, 'Middle 1', y + 6);
      const d = await S.disk();
      const want = [...lines.slice(0, 20), ...lines.slice(24, 28), ...lines.slice(28, 32), ...lines.slice(20, 24), ...lines.slice(32)].join('\n');
      const changed = d.split('\n').map((l, k) => (l !== lines[k] ? k + 1 : 0)).filter(Boolean);
      return { ok: d === want, detail: `changed lines ${changed.join(',')}` };
    },
  },

  {
    id: 'blocks.drag.e14',
    feature: 'blocks.drag',
    name: 'Dragging item 10 above item 9: the list still starts at 9',
    run: async (S) => {
      await S.fresh('drag-nine-ten', 'Intro.\n\n9. Ninth item\n10. Tenth item\n');
      const y = await yAbove(S, 'Ninth item');
      await dragGrip(S, 'Tenth item', y);
      const d = await S.disk();
      await S.shot('drag-e14-after');
      return { ok: d === 'Intro.\n\n9. Tenth item\n10. Ninth item\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.drag.e15',
    feature: 'blocks.drag',
    name: 'Dragging a line to the end of blocks written with no blank lines adds a blank line only where the moved text would merge',
    run: async (S) => {
      await S.fresh('drag-tight', '# Alpha\nFirst line\n# Beta\nmore text\n');
      const y = await yBelow(S, 'more text');
      await dragGrip(S, 'First line', y);
      const d = await S.disk();
      return { ok: d === '# Alpha\n# Beta\nmore text\n\nFirst line\n', detail: show(d) };
    },
  },

  {
    id: 'blocks.drag.e16',
    feature: 'blocks.drag',
    name: 'With two paragraphs selected by Escape and Shift+Down, dragging the grip of one carries both',
    run: async (S) => {
      const doc = 'One para here.\n\nTwo para here.\n\nThree para here.\n';
      await S.fresh('drag-selection', doc);
      await S.caret('One', 1);
      await keys(S, 'Escape');
      await keys(S, 'Shift+ArrowDown');
      const sel = (await selectedLines(S)).join('|');
      const y = await yBelow(S, 'Three para');
      await dragGrip(S, 'Two para', y);
      const d = await S.disk();
      return { ok: d === 'Three para here.\n\nOne para here.\n\nTwo para here.\n', detail: `selected ${show(sel)}; file ${show(d)}` };
    },
  },

  // ---- blocks.plus -------------------------------------------------------------
  {
    id: 'blocks.plus.e01',
    feature: 'blocks.plus',
    name: 'Clicking + opens the insert menu below the paragraph, and Heading 2 then typing makes a new heading there',
    run: async (S) => {
      await S.fresh('plus-heading', DOC);
      await grip(S, 'First paragraph');
      await S.click('.sheaf-block-add');
      await S.sleep(300);
      const open = await S.exists('.sheaf-slash-item');
      if (!open) return { ok: false, detail: 'no insert menu after clicking +' };
      await S.menu('Heading 2');
      await S.type('New part');
      const d = await S.disk();
      return { ok: d === '# Alpha\n\nFirst paragraph here.\n\n## New part\n\n# Beta\n\nSecond paragraph here.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.plus.e02',
    feature: 'blocks.plus',
    name: 'Clicking + on a list item starts a new item under it',
    run: async (S) => {
      await S.fresh('plus-list', '- Apple\n- Banana\n');
      await grip(S, 'Apple');
      await S.click('.sheaf-block-add');
      await keys(S, 'Escape');
      await S.type('Avocado');
      const d = await S.disk();
      return { ok: d === '- Apple\n- Avocado\n- Banana\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.plus.e03',
    feature: 'blocks.plus',
    name: 'Clicking + then Escape then Cmd+Z gives back the file byte for byte',
    run: async (S) => {
      await S.fresh('plus-undo', DOC);
      await grip(S, 'First paragraph');
      await S.click('.sheaf-block-add');
      await keys(S, 'Escape');
      const added = await S.disk();
      await keys(S, 'Meta+z');
      const back = await S.disk();
      return { ok: added !== DOC && back === DOC, detail: `added ${show(added)} undone ${show(back)}` };
    },
  },
  {
    id: 'blocks.plus.e04',
    feature: 'blocks.plus',
    name: 'Clicking + on the last line of a file with no final newline, then typing, adds a new paragraph',
    run: async (S) => {
      await S.fresh('plus-no-eol', 'Only line here');
      await grip(S, 'Only line');
      await S.click('.sheaf-block-add');
      await keys(S, 'Escape');
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'Only line here\n\nZ', detail: show(d) };
    },
  },
  {
    id: 'blocks.plus.e05',
    feature: 'blocks.plus',
    name: 'Clicking + on a heading with text directly under it: what you type is its own paragraph',
    run: async (S) => {
      await S.fresh('plus-tight', '# Title\nBody text here.\n');
      await grip(S, 'Title');
      await S.click('.sheaf-block-add');
      await keys(S, 'Escape');
      await S.type('Middle');
      const d = await S.disk();
      return { ok: d === '# Title\n\nMiddle\n\nBody text here.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.plus.e06',
    feature: 'blocks.plus',
    name: 'Clicking + then Bullet list in the menu starts a bullet under the paragraph',
    run: async (S) => {
      await S.fresh('plus-bullet', DOC);
      await grip(S, 'First paragraph');
      await S.click('.sheaf-block-add');
      await S.sleep(300);
      await S.menu('Bullet list');
      await S.type('x');
      const d = await S.disk();
      return { ok: d === '# Alpha\n\nFirst paragraph here.\n\n- x\n\n# Beta\n\nSecond paragraph here.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.plus.e07',
    feature: 'blocks.plus',
    name: 'Clicking + on a nested numbered item adds the next number at the same depth',
    run: async (S) => {
      await S.fresh('plus-nested-ordered', '1. Step one\n   1. Sub one\n2. Step two\n');
      await grip(S, 'Sub one');
      await S.click('.sheaf-block-add');
      await keys(S, 'Escape');
      await S.type('Sub two');
      const d = await S.disk();
      return { ok: d === '1. Step one\n   1. Sub one\n   2. Sub two\n2. Step two\n', detail: show(d) };
    },
  },

  // ---- blocks.keyboard-selection ----------------------------------------------
  {
    id: 'blocks.keyboard-selection.e01',
    feature: 'blocks.keyboard-selection',
    name: 'Click in a paragraph, Escape selects it, ArrowDown selects the next block, Backspace deletes that one',
    run: async (S) => {
      await S.fresh('ks-select-delete', DOC);
      await S.caret('paragraph', 3);
      await keys(S, 'Escape');
      const first = (await selectedLines(S)).join('|');
      await keys(S, 'ArrowDown');
      const second = (await selectedLines(S)).join('|');
      await keys(S, 'Backspace');
      const d = await S.disk();
      return { ok: first === 'First paragraph here.' && second === 'Beta' && d === '# Alpha\n\nFirst paragraph here.\n\nSecond paragraph here.\n', detail: `selected ${show(first)} then ${show(second)}; file ${show(d)}` };
    },
  },
  {
    id: 'blocks.keyboard-selection.e02',
    feature: 'blocks.keyboard-selection',
    name: 'Escape then Cmd+D duplicates the paragraph',
    run: async (S) => {
      await S.fresh('ks-duplicate', DOC);
      await S.caret('paragraph', 3);
      await keys(S, 'Escape');
      await keys(S, 'Meta+d');
      const d = await S.disk();
      return { ok: d === '# Alpha\n\nFirst paragraph here.\n\nFirst paragraph here.\n\n# Beta\n\nSecond paragraph here.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.keyboard-selection.e03',
    feature: 'blocks.keyboard-selection',
    name: 'Escape then Cmd+Shift+Down moves the paragraph down, and Cmd+Z restores the bytes',
    run: async (S) => {
      await S.fresh('ks-move-undo', DOC);
      await S.caret('paragraph', 3);
      await keys(S, 'Escape');
      await keys(S, 'Meta+Shift+ArrowDown');
      const moved = await S.disk();
      await keys(S, 'Meta+z');
      const back = await S.disk();
      return { ok: moved === '# Alpha\n\n# Beta\n\nFirst paragraph here.\n\nSecond paragraph here.\n' && back === DOC, detail: `moved ${show(moved)} undone ${show(back)}` };
    },
  },
  {
    id: 'blocks.keyboard-selection.e04',
    feature: 'blocks.keyboard-selection',
    name: 'Escape, Shift+Down, Backspace deletes two blocks, and Cmd+Z restores the bytes',
    run: async (S) => {
      await S.fresh('ks-extend-delete', DOC);
      await S.caret('paragraph', 3);
      await keys(S, 'Escape');
      await keys(S, 'Shift+ArrowDown');
      const sel = (await selectedLines(S)).join('|');
      await keys(S, 'Backspace');
      const del = await S.disk();
      await keys(S, 'Meta+z');
      const back = await S.disk();
      return { ok: del === '# Alpha\n\nSecond paragraph here.\n' && back === DOC, detail: `selected ${show(sel)}; deleted ${show(del)} undone ${show(back)}` };
    },
  },
  {
    id: 'blocks.keyboard-selection.e05',
    feature: 'blocks.keyboard-selection',
    name: 'Escape then Enter returns to typing: a Z lands at the end of the paragraph',
    run: async (S) => {
      await S.fresh('ks-enter', DOC);
      await S.caret('paragraph', 3);
      await keys(S, 'Escape');
      await keys(S, 'Enter');
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === '# Alpha\n\nFirst paragraph here.Z\n\n# Beta\n\nSecond paragraph here.\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.keyboard-selection.e06',
    feature: 'blocks.keyboard-selection',
    name: 'Escape twice returns to typing: a Z lands at the end of the paragraph and nothing is replaced',
    run: async (S) => {
      await S.fresh('ks-escape-twice', DOC);
      await S.caret('paragraph', 3);
      await keys(S, 'Escape');
      const once = (await selectedLines(S)).join('|');
      await S.shot('ks-e06-after-one-escape');
      const toolbarAfterOne = await S.exists('.sheaf-seltb');
      await keys(S, 'Escape');
      const twice = (await selectedLines(S)).join('|');
      await S.shot('ks-e06-after-two-escapes');
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === '# Alpha\n\nFirst paragraph here.Z\n\n# Beta\n\nSecond paragraph here.\n', detail: `selected after one Escape ${show(once)} (a floating toolbar visible: ${toolbarAfterOne}), after two ${show(twice)}; file ${show(d)}` };
    },
  },
  {
    id: 'blocks.keyboard-selection.e07',
    feature: 'blocks.keyboard-selection',
    name: 'Escape on a list item selects it with its nested item, and Alt+Down moves both',
    run: async (S) => {
      await S.fresh('ks-nested', LIST);
      await S.caret('Apple', 2);
      await keys(S, 'Escape');
      const sel = (await selectedLines(S)).length;
      await keys(S, 'Alt+ArrowDown');
      const d = await S.disk();
      return { ok: sel === 2 && d === '- Banana\n- Apple\n  - Apple child\n- Cherry\n', detail: `selected lines ${sel}; file ${show(d)}` };
    },
  },
  {
    id: 'blocks.keyboard-selection.e08',
    feature: 'blocks.keyboard-selection',
    name: 'Escape, ArrowUp and Backspace from the first block under front matter never delete the front matter',
    run: async (S) => {
      await S.fresh('ks-fm', FM);
      await S.caret('Intro', 2);
      await keys(S, 'Escape');
      await keys(S, 'ArrowUp');
      const sel = (await selectedLines(S)).join('|');
      await keys(S, 'Backspace');
      const d = await S.disk();
      return { ok: d === FM, detail: `selected ${show(sel)}; file ${show(d)}` };
    },
  },
  {
    id: 'blocks.keyboard-selection.e09',
    feature: 'blocks.keyboard-selection',
    name: 'Deleting the only block empties the file, and typing afterwards works',
    run: async (S) => {
      await S.fresh('ks-only-block', 'Only line here\n');
      await S.caret('line', 2);
      await keys(S, 'Escape');
      await keys(S, 'Backspace');
      const empty = await S.disk();
      await S.type('Z');
      const d = await S.disk();
      return { ok: empty === '' && d === 'Z', detail: `after delete ${show(empty)}, after typing ${show(d)}` };
    },
  },
  {
    id: 'blocks.keyboard-selection.e10',
    feature: 'blocks.keyboard-selection',
    name: 'Escape in a table cell selects no block and changes nothing',
    run: async (S) => {
      await S.fresh('ks-table-escape', TABLE_DOC);
      await S.click({ text: 'Ada', offset: 1 });
      await S.press('Escape');
      await S.sleep(200);
      const sel = await selectedLines(S);
      const d = await S.disk();
      return { ok: sel.length === 0 && d === TABLE_DOC, detail: `selected ${show(sel)}; file ${show(d)}` };
    },
  },
  {
    id: 'blocks.keyboard-selection.e11',
    feature: 'blocks.keyboard-selection',
    name: 'Escape, Cmd+D, Cmd+Shift+Down moves the copy past the next heading',
    run: async (S) => {
      await S.fresh('ks-dup-move', DOC);
      await S.caret('paragraph', 3);
      await keys(S, 'Escape');
      await keys(S, 'Meta+d');
      await keys(S, 'Meta+Shift+ArrowDown');
      const d = await S.disk();
      return { ok: d === '# Alpha\n\nFirst paragraph here.\n\n# Beta\n\nFirst paragraph here.\n\nSecond paragraph here.\n', detail: show(d) };
    },
  },

  // ---- blocks.alt-arrow --------------------------------------------------------
  {
    id: 'blocks.alt-arrow.e01',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Down in a two-line paragraph moves it below the heading, and a Z lands where the caret was',
    run: async (S) => {
      await S.fresh('alt-multiline', 'Line one of para\nline two of para\n\n# Beta\n');
      await S.caret('two', 1);
      await keys(S, 'Alt+ArrowDown');
      const moved = await S.disk();
      await S.type('Z');
      const d = await S.disk();
      return { ok: moved === '# Beta\n\nLine one of para\nline two of para\n' && d === '# Beta\n\nLine one of para\nline tZwo of para\n', detail: `moved ${show(moved)}; typed ${show(d)}` };
    },
  },
  {
    id: 'blocks.alt-arrow.e02',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Up inside a code block moves one code line',
    run: async (S) => {
      await S.fresh('alt-code', 'Intro.\n\n```\nalpha\nbeta\n```\n');
      await S.caret('beta', 2);
      await keys(S, 'Alt+ArrowUp');
      const d = await S.disk();
      return { ok: d === 'Intro.\n\n```\nbeta\nalpha\n```\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.alt-arrow.e03',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Up on a one-line item under an item with a nested item swaps the items, and the nested item stays with its parent',
    run: async (S) => {
      await S.fresh('alt-item-under-parent', '- Apple\n  - Apple child\n- Banana\n');
      await S.caret('Banana', 2);
      await keys(S, 'Alt+ArrowUp');
      const d = await S.disk();
      await S.shot('alt-e03-after');
      return { ok: d === '- Banana\n- Apple\n  - Apple child\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.alt-arrow.e04',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Up twice on a one-line paragraph under front matter leaves the front matter intact',
    run: async (S) => {
      await S.fresh('alt-fm', FM);
      await S.caret('Intro', 2);
      await keys(S, 'Alt+ArrowUp');
      await keys(S, 'Alt+ArrowUp');
      const d = await S.disk();
      await S.shot('alt-e04-after');
      return { ok: d.startsWith('---\ntitle: x\n---\n'), detail: show(d) };
    },
  },
  {
    id: 'blocks.alt-arrow.e05',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Down on a two-line paragraph then Cmd+Z gives back the file byte for byte',
    run: async (S) => {
      const doc = 'Line one of para\nline two of para\n\n# Beta\n';
      await S.fresh('alt-undo', doc);
      await S.caret('one', 1);
      await keys(S, 'Alt+ArrowDown');
      const moved = await S.disk();
      await keys(S, 'Meta+z');
      const back = await S.disk();
      return { ok: moved !== doc && back === doc, detail: `moved ${show(moved)} undone ${show(back)}` };
    },
  },
  {
    id: 'blocks.alt-arrow.e06',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Down on a two-line paragraph in a CRLF file keeps every line ending CRLF',
    run: async (S) => {
      const path = await S.fresh('alt-crlf', 'Line one of para\r\nline two of para\r\n\r\n# Beta\r\n');
      await S.caret('one', 1);
      await keys(S, 'Alt+ArrowDown');
      await S.disk();
      const d = readFileSync(path, 'utf8');
      return { ok: d === '# Beta\r\n\r\nLine one of para\r\nline two of para\r\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.alt-arrow.e07',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Down with the caret in a list item that has a nested item moves both past the next item',
    run: async (S) => {
      await S.fresh('alt-item-children', LIST);
      await S.caret('Apple', 2);
      await keys(S, 'Alt+ArrowDown');
      const d = await S.disk();
      return { ok: d === '- Banana\n- Apple\n  - Apple child\n- Cherry\n', detail: show(d) };
    },
  },
  {
    id: 'blocks.alt-arrow.e08',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Up with the caret in a two-line quote moves the whole quote above the paragraph',
    run: async (S) => {
      await S.fresh('alt-quote', 'Intro.\n\n> quote one\n> quote two\n');
      await S.caret('two', 1);
      await keys(S, 'Alt+ArrowUp');
      const d = await S.disk();
      return { ok: d === '> quote one\n> quote two\n\nIntro.\n', detail: show(d) };
    },
  },
];
