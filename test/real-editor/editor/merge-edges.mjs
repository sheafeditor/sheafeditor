// A write landing while somebody types, in the shapes the first checks do not reach: a file with
// Windows line endings, a deletion rather than a change, and typing inside a table cell, which
// reaches the document by a different path from typing in prose.
//
// Each one reads the file at the end, because the question is always what the person is left with
// on disk, not only what the editor is showing.
//   node test/real-editor/run-editor.mjs merge-edges [id]
import { readFileSync, writeFileSync } from 'node:fs';

const j = (x) => JSON.stringify(x);

/**
 * Every toast VS Code is showing, so a notice can be told from silence.
 *
 * `S.page`, the way every other area reads them, and not `S.eval`. A notification is
 * workbench chrome and lives in the window's own DOM. `S.eval` runs inside the
 * webview's frame, where `.notifications-toasts` does not exist and cannot come to
 * exist, so read that way this returned an empty list whatever was on screen. Three
 * scenarios here reported "notices none" for a month on that reading, and the notice
 * was being shown every time.
 */
const toasts = (S) =>
  S.page.$$eval('.notifications-toasts .notification-list-item-message', (els) => els.map((e) => e.textContent.trim()));

export const scenarios = [
  {
    id: 'host.outside-change.edges.e01',
    feature: 'host.outside-change',
    name: 'In a file with Windows line endings, a write landing while somebody types keeps both, and every line still ends CRLF',
    run: async (S) => {
      const path = await S.fresh('merge-crlf', 'Top line.\r\n\r\nMiddle line.\r\n\r\nBottom line.\r\n');
      await S.caret('Middle', 2);
      await S.type('ZZ');
      writeFileSync(path, 'Top line changed by an agent.\r\n\r\nMiddle line.\r\n\r\nBottom line.\r\n');
      await S.type('YY');
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const lines = disk.split('\n');
      const crlf = lines.slice(0, -1).every((l) => l.endsWith('\r'));
      const ok = disk.includes('Top line changed by an agent.') && disk.includes('MiZZYYddle') && crlf && !disk.includes('\n\n\n');
      return { ok, detail: `file ${j(disk)}; every line ends CRLF ${crlf}` };
    },
  },
  {
    id: 'host.outside-change.edges.e02',
    feature: 'host.outside-change',
    name: 'A paragraph deleted on disk while somebody types stays deleted, and the typing stays too',
    run: async (S) => {
      const path = await S.fresh('merge-delete', 'Top line.\n\nMiddle line.\n\nBottom line.\n');
      await S.caret('Bottom', 2);
      await S.type('ZZ');
      // The agent takes a whole paragraph out, one the person is not typing in.
      writeFileSync(path, 'Top line.\n\nBottom line.\n');
      await S.type('YY');
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const shown = (await S.state()).doc;
      const said = (await toasts(S)).filter((t) => t.startsWith('Sheaf:'));
      const ok = !disk.includes('Middle line.') && disk.includes('BoZZYYttom') && !shown.includes('Middle line.');
      return {
        ok,
        detail: `file ${j(disk)}; the editor shows the deleted paragraph ${shown.includes('Middle line.')}; notices ${j(said)}`,
      };
    },
  },
  {
    id: 'host.outside-change.edges.e03',
    feature: 'host.outside-change',
    name: 'A write landing while somebody types in a table cell keeps both the write and the cell',
    run: async (S) => {
      const doc = 'Intro.\n\n| item | note |\n| --- | --- |\n| bolt | spare |\n| nut | fitted |\n\nAfter.\n';
      const path = await S.fresh('merge-in-cell', doc);
      await S.sleep(600);
      await S.dblclick({ sel: '.sheaf-table [data-r="0"][data-c="1"]' });
      await S.sleep(300);
      await S.type('spare ZZ');
      // The agent changes the paragraph above, which the person is nowhere near.
      writeFileSync(path, doc.replace('Intro.', 'Intro changed by an agent.'));
      await S.sleep(400);
      await S.press('Enter');
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const said = await toasts(S);
      const ok = disk.includes('Intro changed by an agent.') && disk.includes('spare ZZ') && disk.includes('| nut | fitted |');
      return { ok, detail: `file ${j(disk)}; notices ${j(said.filter((t) => t.startsWith('Sheaf:')))}` };
    },
  },
  {
    id: 'host.outside-change.edges.e04',
    feature: 'host.outside-change',
    name: 'Two writes landing in quick succession while somebody types leave both of them and the typing in the file',
    run: async (S) => {
      const path = await S.fresh('merge-two-writes', 'Top line.\n\nMiddle line.\n\nBottom line.\n');
      await S.caret('Middle', 2);
      await S.type('ZZ');
      writeFileSync(path, 'Top line changed by an agent.\n\nMiddle line.\n\nBottom line.\n');
      await S.sleep(150);
      writeFileSync(path, 'Top line changed by an agent.\n\nMiddle line.\n\nBottom line changed too.\n');
      await S.type('YY');
      await S.sleep(2800);
      const disk = readFileSync(path, 'utf8');
      const ok = disk.includes('Top line changed by an agent.') && disk.includes('Bottom line changed too.') && disk.includes('MiZZYYddle');
      return { ok, detail: `file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e05',
    feature: 'host.outside-change',
    name: 'The first paragraph deleted on disk while somebody types in the last one stays deleted',
    run: async (S) => {
      const path = await S.fresh('merge-delete-first', 'Top line.\n\nMiddle line.\n\nBottom line.\n');
      await S.caret('Bottom', 2);
      await S.type('ZZ');
      writeFileSync(path, 'Middle line.\n\nBottom line.\n');
      await S.type('YY');
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const ok = !disk.includes('Top line.') && disk.includes('BoZZYYttom');
      return { ok, detail: `file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e06',
    feature: 'host.outside-change',
    name: 'A paragraph deleted on disk with nobody typing is gone from the editor and the file',
    run: async (S) => {
      // The control for the two above: the same deletion, with no unsaved typing in the way.
      const path = await S.fresh('merge-delete-idle', 'Top line.\n\nMiddle line.\n\nBottom line.\n');
      await S.sleep(400);
      writeFileSync(path, 'Top line.\n\nBottom line.\n');
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const shown = (await S.state()).doc;
      const ok = !disk.includes('Middle line.') && !shown.includes('Middle line.');
      return { ok, detail: `file ${j(disk)}; the editor shows it ${shown.includes('Middle line.')}` };
    },
  },
  {
    id: 'host.outside-change.edges.e07',
    feature: 'host.outside-change',
    name: 'The paragraph directly above the one being typed in, deleted on disk, stays deleted',
    run: async (S) => {
      const path = await S.fresh('merge-delete-above', 'Top line.\n\nMiddle line.\n\nBottom line.\n');
      await S.caret('Middle', 2);
      await S.type('ZZ');
      writeFileSync(path, 'Middle line.\n\nBottom line.\n');
      await S.type('YY');
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const ok = !disk.includes('Top line.') && disk.includes('MiZZYYddle');
      return { ok, detail: `file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e08',
    feature: 'host.outside-change',
    name: 'The paragraph directly below the one being typed in, deleted on disk, stays deleted',
    run: async (S) => {
      const path = await S.fresh('merge-delete-below', 'Top line.\n\nMiddle line.\n\nBottom line.\n');
      await S.caret('Top', 2);
      await S.type('ZZ');
      writeFileSync(path, 'Top line.\n\nBottom line.\n');
      await S.type('YY');
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const ok = !disk.includes('Middle line.') && disk.includes('ToZZYYp');
      return { ok, detail: `file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e09',
    feature: 'host.outside-change',
    name: 'A write landing while a passage is selected leaves the selection over the same words, so typing replaces those and no others',
    run: async (S) => {
      // The dangerous half of a merge is not the text on screen, it is where the selection
      // ends up. Whatever a merge does to the document, the next keystroke must replace the
      // words the person highlighted and nothing else.
      const path = await S.fresh('merge-selected', 'Top line.\n\nMiddle line here.\n\nBottom line.\n');
      await S.caret('Middle', 0);
      await S.type('Z');
      await S.sleep(200);
      await S.select('line here');
      await S.sleep(300);
      const before = await S.eval(() => String(getSelection() ?? ''));
      const docBefore = (await S.state()).doc;
      writeFileSync(path, 'Top line changed by an agent.\n\nMiddle line here.\n\nBottom line.\n');
      await S.sleep(1800);
      const after = await S.eval(() => String(getSelection() ?? ''));
      const docAfter = (await S.state()).doc;
      await S.type('WORD');
      await S.sleep(2400);
      const disk = readFileSync(path, 'utf8');
      const said = (await toasts(S)).filter((t) => t.startsWith('Sheaf:'));
      const ok =
        before === 'line here' && after === 'line here' &&
        disk.includes('ZMiddle WORD.') && disk.includes('Top line changed by an agent.') && disk.includes('Bottom line.');
      return {
        ok,
        detail: `selected ${j(before)} then ${j(after)}; the typed Z survived the write ${docAfter.includes('ZMiddle')}; document before ${j(docBefore.split('\n')[2])} after ${j(docAfter.split('\n')[2])}; file ${j(disk)}; notices ${j(said)}`,
      };
    },
  },
  {
    id: 'host.outside-change.edges.e10',
    feature: 'host.outside-change',
    name: 'A write landing with nothing unsaved leaves a selected passage selected, and typing still replaces it',
    run: async (S) => {
      // The same question with a clean document, which VS Code reloads rather than merges.
      const path = await S.fresh('merge-selected-clean', 'Top line.\n\nMiddle line here.\n\nBottom line.\n');
      await S.sleep(500);
      await S.select('line here');
      await S.sleep(300);
      const before = await S.eval(() => String(getSelection() ?? ''));
      writeFileSync(path, 'Top line changed by an agent.\n\nMiddle line here.\n\nBottom line.\n');
      await S.sleep(1800);
      const after = await S.eval(() => String(getSelection() ?? ''));
      await S.type('WORD');
      await S.sleep(2400);
      const disk = readFileSync(path, 'utf8');
      const ok =
        before === 'line here' && after === 'line here' &&
        disk.includes('Middle WORD.') && disk.includes('Top line changed by an agent.') && disk.includes('Bottom line.');
      return { ok, detail: `selected ${j(before)} before the write and ${j(after)} after; file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e11',
    feature: 'host.outside-change',
    name: 'One letter typed, then a write landing a moment later on another line, and the letter is still there',
    /*
     * This marker was cleared once too early and put back. The first clearing rested on a fix
     * that kept the typed letter on the screen and not in the file: this scenario reads the
     * document, so it passed, while the promise was broken where it counts, because the file is
     * what the next save writes. It is cleared now on two whole-area runs of the landed tree,
     * both reading the file, and the letter is still there six seconds later.
     */
    run: async (S) => {
      // e09 without the selection, to say whether the selection matters or the timing does.
      const path = await S.fresh('merge-one-letter', 'Top line.\n\nMiddle line here.\n\nBottom line.\n');
      await S.caret('Middle', 0);
      await S.type('Z');
      await S.sleep(500);
      writeFileSync(path, 'Top line changed by an agent.\n\nMiddle line here.\n\nBottom line.\n');
      await S.sleep(2400);
      const doc = (await S.state()).doc;
      const disk = readFileSync(path, 'utf8');
      // Does it ever arrive on its own, and does the next keystroke bring it?
      await S.sleep(6000);
      const later = readFileSync(path, 'utf8');
      await S.type('Q');
      await S.sleep(2600);
      const afterMore = readFileSync(path, 'utf8');
      const said = (await toasts(S)).filter((t) => t.startsWith('Sheaf:'));
      const ok = doc.includes('ZMiddle') && disk.includes('ZMiddle') && disk.includes('Top line changed by an agent.');
      return {
        ok,
        detail: `the document line reads ${j(doc.split('\n')[2])}; file ${j(disk)}; six seconds later ${j(later.split('\n')[2])}; after one more keystroke ${j(afterMore.split('\n')[2])}; notices ${j(said)}`,
      };
    },
  },
  {
    id: 'host.outside-change.edges.e12',
    feature: 'host.outside-change',
    name: 'A write landing while a block is being dragged leaves the block where the drop line showed, and keeps the write',
    run: async (S) => {
      // A drag holds no unsaved text, so nothing here is about the merge keeping letters. It is
      // about positions: the drop is worked out from what the document held when the drag began,
      // and a write landing mid-drag moves every line under it.
      const doc = '# Alpha\n\nFirst paragraph here.\n\n# Beta\n\nSecond paragraph here.\n';
      const path = await S.fresh('merge-mid-drag', doc);
      await S.sleep(700);
      const grip = await S.eval(() => {
        const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('First paragraph'));
        const b = line.getBoundingClientRect();
        return { y: Math.round(b.top + b.height / 2) };
      });
      const target = await S.locate({ text: 'Second paragraph', offset: 2 });
      const start = await S.locate({ text: 'First paragraph', offset: 2 });
      // Take the grip in the margin beside the paragraph, as blocks.mjs does.
      await S.hover({ text: 'First paragraph', offset: 2 });
      await S.sleep(300);
      const g = await S.locate({ sel: '.sheaf-block-grip' }).catch(() => null);
      if (!g) return { ok: false, detail: 'no grip appeared beside the paragraph' };
      await S.page.mouse.move(g.x, g.y, { steps: 3 });
      await S.page.mouse.down();
      await S.page.mouse.move(g.x, g.y + 8, { steps: 3 });
      await S.page.mouse.move(g.x, target.y + 12, { steps: 16 });
      await S.sleep(250);
      // The agent changes a heading above the drop, with the button still down.
      // What the drag looks like on screen the moment before the write, and the moment after it.
      const dragState = () =>
        S.eval(() => ({
          indicator: !!document.querySelector('.sheaf-block-drop:not([hidden])'),
          dimmed: document.querySelectorAll('.sheaf-block-dragging').length,
          dragging: !!document.querySelector('.sheaf-block-drag-active'),
        }));
      const before = await dragState();
      writeFileSync(path, doc.replace('# Alpha', '# Alpha changed by an agent'));
      await S.sleep(600);
      const after = await dragState();
      await S.page.mouse.up();
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const order = disk.split('\n').filter((l) => l.trim()).map((l) => l.slice(0, 16));
      // What the page shows, so a report can say whether the block appeared to move and the file
      // disagreed, or whether the drop was dropped on screen too.
      const shown = (await S.state()).doc.split('\n').filter((l) => l.trim()).map((l) => l.slice(0, 16));
      const ok =
        disk.includes('# Alpha changed by an agent') &&
        disk.includes('First paragraph here.') &&
        disk.indexOf('First paragraph here.') > disk.indexOf('Second paragraph here.');
      return {
        ok,
        detail: `the drag before the write ${j(before)}, after it ${j(after)}; file in order ${j(order)}; on screen ${j(shown)}`,
      };
    },
  },
  {
    id: 'host.outside-change.edges.e13',
    feature: 'host.outside-change',
    name: 'The same drag with nothing else touching the file moves the paragraph below the second heading',
    run: async (S) => {
      // e12's control. Without it, a drag that never worked and a drag broken by the write read
      // the same on screen and in the file.
      const doc = '# Alpha\n\nFirst paragraph here.\n\n# Beta\n\nSecond paragraph here.\n';
      const path = await S.fresh('merge-mid-drag-control', doc);
      await S.sleep(700);
      const target = await S.locate({ text: 'Second paragraph', offset: 2 });
      await S.hover({ text: 'First paragraph', offset: 2 });
      await S.sleep(300);
      const g = await S.locate({ sel: '.sheaf-block-grip' }).catch(() => null);
      if (!g) return { ok: false, detail: 'no grip appeared beside the paragraph' };
      await S.page.mouse.move(g.x, g.y, { steps: 3 });
      await S.page.mouse.down();
      await S.page.mouse.move(g.x, g.y + 8, { steps: 3 });
      await S.page.mouse.move(g.x, target.y + 12, { steps: 16 });
      await S.sleep(250);
      await S.page.mouse.up();
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const order = disk.split('\n').filter((l) => l.trim()).map((l) => l.slice(0, 16));
      const ok = disk.indexOf('First paragraph here.') > disk.indexOf('Second paragraph here.');
      return { ok, detail: `file in order ${j(order)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e14',
    feature: 'host.outside-change',
    name: 'The same drag again, held still for the same time the write takes, still moves the paragraph',
    run: async (S) => {
      // e12's second control. e12 waits 600 ms longer than e13 before releasing, because the write
      // has to arrive, so a drag that simply gives up after a pause would read as the write's doing.
      const doc = '# Alpha\n\nFirst paragraph here.\n\n# Beta\n\nSecond paragraph here.\n';
      const path = await S.fresh('merge-mid-drag-pause', doc);
      await S.sleep(700);
      const target = await S.locate({ text: 'Second paragraph', offset: 2 });
      await S.hover({ text: 'First paragraph', offset: 2 });
      await S.sleep(300);
      const g = await S.locate({ sel: '.sheaf-block-grip' }).catch(() => null);
      if (!g) return { ok: false, detail: 'no grip appeared beside the paragraph' };
      await S.page.mouse.move(g.x, g.y, { steps: 3 });
      await S.page.mouse.down();
      await S.page.mouse.move(g.x, g.y + 8, { steps: 3 });
      await S.page.mouse.move(g.x, target.y + 12, { steps: 16 });
      await S.sleep(250);
      await S.sleep(600);
      await S.page.mouse.up();
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const order = disk.split('\n').filter((l) => l.trim()).map((l) => l.slice(0, 16));
      const ok = disk.indexOf('First paragraph here.') > disk.indexOf('Second paragraph here.');
      return { ok, detail: `file in order ${j(order)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e15',
    feature: 'host.outside-change',
    name: 'A write that inserts a whole block mid-drag does not make the drop carry away a block the person never picked up',
    run: async (S) => {
      // e12 shows the drop doing nothing when the write only lengthens a heading. This asks the
      // worse question: with the lines shifted by a whole block, does the release move the block
      // that now sits where the picked-up one was?
      const doc = '# Alpha\n\nFirst paragraph here.\n\n# Beta\n\nSecond paragraph here.\n';
      const path = await S.fresh('merge-mid-drag-shift', doc);
      await S.sleep(700);
      const target = await S.locate({ text: 'Second paragraph', offset: 2 });
      await S.hover({ text: 'First paragraph', offset: 2 });
      await S.sleep(300);
      const g = await S.locate({ sel: '.sheaf-block-grip' }).catch(() => null);
      if (!g) return { ok: false, detail: 'no grip appeared beside the paragraph' };
      await S.page.mouse.move(g.x, g.y, { steps: 3 });
      await S.page.mouse.down();
      await S.page.mouse.move(g.x, g.y + 8, { steps: 3 });
      await S.page.mouse.move(g.x, target.y + 12, { steps: 16 });
      await S.sleep(250);
      // A whole paragraph added at the top, so every line below moves down by two.
      writeFileSync(path, 'A line an agent added.\n\n' + doc);
      await S.sleep(600);
      await S.page.mouse.up();
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const order = disk.split('\n').filter((l) => l.trim()).map((l) => l.slice(0, 22));
      // Every block still exactly once, and nothing but the picked-up paragraph moved.
      const once = ['A line an agent added.', '# Alpha', 'First paragraph here.', '# Beta', 'Second paragraph here.'].every(
        (t) => disk.split(t).length === 2
      );
      const untouched = order.join('|') === 'A line an agent added.|# Alpha|First paragraph here.|# Beta|Second paragraph here.';
      const moved = order.join('|') === 'A line an agent added.|# Alpha|# Beta|Second paragraph here.|First paragraph here.';
      return { ok: once && (untouched || moved), detail: `file in order ${j(order)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e16',
    feature: 'host.outside-change',
    name: 'A write landing while a column is being resized keeps the new width',
    run: async (S) => {
      // A block drag is thrown away by a write landing in the middle of it. This asks the same of
      // the other long gesture in the product, held just as long with a whole document under it.
      const doc = 'Intro paragraph.\n\n| St | Role | Note |\n| -- | ---- | ---- |\n| ok | Keeper | A note long enough to wrap inside its column |\n| no | Drone | Short. |\n\nAfter line\n';
      const path = await S.fresh('merge-col-resize', doc);
      await S.sleep(900);
      const grip = { sel: '.sheaf-table-grid thead th[data-c="1"] > .sheaf-table-resize' };
      const at = await S.hover(grip).catch(() => null);
      if (!at) return { ok: false, detail: 'no resize grip on the Role column' };
      const width = () => S.eval(() => Math.round(document.querySelector('.sheaf-table-grid thead th[data-c="1"]').getBoundingClientRect().width));
      const before = await width();
      await S.page.mouse.move(at.x, at.y);
      await S.page.mouse.down();
      await S.page.mouse.move(at.x - 25, at.y, { steps: 12 });
      await S.sleep(250);
      writeFileSync(path, doc.replace('Intro paragraph.', 'Intro paragraph changed by an agent.'));
      await S.sleep(600);
      await S.page.mouse.up();
      await S.sleep(1200);
      const after = await width();
      const disk = readFileSync(path, 'utf8');
      const moved = before !== null && after !== null ? before - after : null;
      const ok = moved !== null && moved >= 18 && disk.includes('changed by an agent');
      return { ok, detail: `the column went from ${before}px to ${after}px, so it narrowed by ${moved}px of the 25 asked for; the write ${disk.includes('changed by an agent') ? 'landed' : 'did not land'}` };
    },
  },
  {
    id: 'host.outside-change.edges.e17',
    feature: 'host.outside-change',
    name: 'The same resize with nothing else touching the file narrows the column',
    run: async (S) => {
      // e16's control.
      const doc = 'Intro paragraph.\n\n| St | Role | Note |\n| -- | ---- | ---- |\n| ok | Keeper | A note long enough to wrap inside its column |\n| no | Drone | Short. |\n\nAfter line\n';
      await S.fresh('merge-col-resize-control', doc);
      await S.sleep(900);
      const grip = { sel: '.sheaf-table-grid thead th[data-c="1"] > .sheaf-table-resize' };
      const at = await S.hover(grip).catch(() => null);
      if (!at) return { ok: false, detail: 'no resize grip on the Role column' };
      const width = () => S.eval(() => Math.round(document.querySelector('.sheaf-table-grid thead th[data-c="1"]').getBoundingClientRect().width));
      const before = await width();
      await S.page.mouse.move(at.x, at.y);
      await S.page.mouse.down();
      await S.page.mouse.move(at.x - 25, at.y, { steps: 12 });
      await S.sleep(850);
      await S.page.mouse.up();
      await S.sleep(1200);
      const after = await width();
      const moved = before !== null && after !== null ? before - after : null;
      return { ok: moved !== null && moved >= 18, detail: `the column went from ${before}px to ${after}px, so it narrowed by ${moved}px of the 25 asked for` };
    },
  },
  {
    id: 'host.outside-change.edges.e18',
    feature: 'host.outside-change',
    name: 'A write landing while a table row is being dragged leaves the row where the drop showed',
    run: async (S) => {
      const doc = 'Intro paragraph.\n\n| name | qty |\n| --- | --- |\n| apple | 3 |\n| kiwi | 12 |\n| lime | 7 |\n\nAfter line\n';
      const path = await S.fresh('merge-row-drag', doc);
      await S.sleep(900);
      const from = await S.locate({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: 0 }).catch(() => null);
      const to = await S.locate({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: 2 }).catch(() => null);
      if (!from || !to) return { ok: false, detail: 'no row gutters to drag between' };
      // Click the row number first: a drag straight from an unselected gutter selects rows, and
      // only a drag that starts on a row already picked moves it.
      await S.click({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: 0 });
      await S.sleep(300);
      await S.page.mouse.move(from.x, from.y);
      await S.page.mouse.down();
      await S.page.mouse.move(to.x, to.y, { steps: 14 });
      await S.sleep(250);
      writeFileSync(path, doc.replace('Intro paragraph.', 'Intro paragraph changed by an agent.'));
      await S.sleep(600);
      await S.page.mouse.up();
      await S.sleep(2400);
      const disk = readFileSync(path, 'utf8');
      const order = disk.split('\n').filter((l) => l.startsWith('| ') && !l.includes('---') && !l.includes('name')).map((l) => l.split('|')[1].trim());
      const ok = j(order) === j(['kiwi', 'lime', 'apple']) && disk.includes('changed by an agent');
      return { ok, detail: `rows in order ${j(order)}; the write ${disk.includes('changed by an agent') ? 'landed' : 'did not land'}` };
    },
  },
  {
    id: 'host.outside-change.edges.e19',
    feature: 'host.outside-change',
    name: 'The same row drag with nothing else touching the file moves the row',
    run: async (S) => {
      // e18's control.
      const doc = 'Intro paragraph.\n\n| name | qty |\n| --- | --- |\n| apple | 3 |\n| kiwi | 12 |\n| lime | 7 |\n\nAfter line\n';
      const path = await S.fresh('merge-row-drag-control', doc);
      await S.sleep(900);
      const from = await S.locate({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: 0 }).catch(() => null);
      const to = await S.locate({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: 2 }).catch(() => null);
      if (!from || !to) return { ok: false, detail: 'no row gutters to drag between' };
      await S.click({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: 0 });
      await S.sleep(300);
      await S.page.mouse.move(from.x, from.y);
      await S.page.mouse.down();
      await S.page.mouse.move(to.x, to.y, { steps: 14 });
      await S.sleep(850);
      await S.page.mouse.up();
      await S.sleep(2400);
      const disk = readFileSync(path, 'utf8');
      const order = disk.split('\n').filter((l) => l.startsWith('| ') && !l.includes('---') && !l.includes('name')).map((l) => l.split('|')[1].trim());
      return { ok: j(order) === j(['kiwi', 'lime', 'apple']), detail: `rows in order ${j(order)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e20',
    feature: 'host.outside-change',
    name: 'A write landing while the slash menu is open leaves the menu choosing for the line it was opened on',
    run: async (S) => {
      // The menu is open for as long as it takes to read it, and it inserts at a place it worked
      // out when it opened. A write above that place moves every line under it.
      const doc = 'Top line.\n\nMiddle line.\n\nBottom line.\n';
      const path = await S.fresh('merge-slash-open', doc);
      await S.sleep(800);
      await S.caret('Bottom line', 11);
      await S.press('End');
      await S.press('Enter');
      await S.type('/');
      await S.sleep(600);
      const open = await S.eval(() => !!document.querySelector('.sheaf-slash-menu'));
      if (!open) return { ok: false, detail: 'the slash menu did not open' };
      writeFileSync(path, doc.replace('Top line.', 'Top line changed by an agent, and rather longer than it was.'));
      await S.sleep(800);
      const stillOpen = await S.eval(() => !!document.querySelector('.sheaf-slash-menu'));
      await S.type('quote');
      await S.sleep(400);
      await S.press('Enter');
      await S.sleep(1800);
      await S.type('a quoted line');
      await S.sleep(2400);
      const disk = readFileSync(path, 'utf8');
      const ok = disk.includes('changed by an agent') && /\n> a quoted line/.test(disk) && !/Top line changed[^\n]*>/.test(disk);
      return { ok, detail: `the menu was ${stillOpen ? 'still open' : 'closed'} after the write; file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e21',
    feature: 'host.outside-change',
    name: 'The same slash menu with nothing else touching the file writes the quote where it was opened',
    run: async (S) => {
      // e20's control.
      const doc = 'Top line.\n\nMiddle line.\n\nBottom line.\n';
      const path = await S.fresh('merge-slash-control', doc);
      await S.sleep(800);
      await S.caret('Bottom line', 11);
      await S.press('End');
      await S.press('Enter');
      await S.type('/');
      await S.sleep(600);
      const open = await S.eval(() => !!document.querySelector('.sheaf-slash-menu'));
      if (!open) return { ok: false, detail: 'the slash menu did not open' };
      await S.sleep(800);
      await S.type('quote');
      await S.sleep(400);
      await S.press('Enter');
      await S.sleep(1800);
      await S.type('a quoted line');
      await S.sleep(2400);
      const disk = readFileSync(path, 'utf8');
      return { ok: /\n> a quoted line/.test(disk), detail: `file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e22',
    feature: 'host.outside-change',
    name: 'A write that keeps the line the slash menu is anchored to still leaves the menu acting on that line',
    run: async (S) => {
      // e20 leaves two things to tell apart: the write took away the unsaved `/` line, which is
      // the lost-typing case, and the menu then acted on a line the person did not choose. Here
      // the write carries the `/` line with it and only moves it down the page, so the `/`
      // survives and the menu is the only thing being asked about.
      const doc = 'Top line.\n\nMiddle line.\n\nBottom line.\n';
      const path = await S.fresh('merge-slash-kept', doc);
      await S.sleep(800);
      await S.caret('Bottom line', 11);
      await S.press('End');
      await S.press('Enter');
      await S.type('/');
      await S.sleep(800);
      const open = await S.eval(() => !!document.querySelector('.sheaf-slash-menu'));
      if (!open) return { ok: false, detail: 'the slash menu did not open' };
      // What the agent writes: the document as it now stands on screen, with a longer first line.
      writeFileSync(path, 'Top line changed by an agent, and rather longer than it was.\n\nMiddle line.\n\nBottom line.\n/\n');
      await S.sleep(900);
      const stillOpen = await S.eval(() => !!document.querySelector('.sheaf-slash-menu'));
      await S.type('quote');
      await S.sleep(400);
      await S.press('Enter');
      await S.sleep(1800);
      await S.type('a quoted line');
      await S.sleep(2400);
      const disk = readFileSync(path, 'utf8');
      const ok = /Bottom line\.\n\n?> a quoted line/.test(disk) && !/> Bottom line/.test(disk);
      return { ok, detail: `the menu was ${stillOpen ? 'still open' : 'closed'} after the write; file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e23',
    feature: 'host.outside-change',
    name: 'A write landing while a link address is being edited in the popover writes the new address to that link',
    run: async (S) => {
      // The popover holds an address the person is part way through typing, and it knows which
      // link it belongs to by a position worked out when it opened. A write above it moves that
      // link down the page while the field is still in hand.
      const doc = 'Top line.\n\nRead the [guide](https://a.io/g) first.\n\nBottom line.\n';
      const path = await S.fresh('merge-linkpop', doc);
      await S.sleep(800);
      await S.caret('guide', 2);
      await S.sleep(600);
      const open = await S.eval(() => !!document.querySelector('.sheaf-linkpop'));
      if (!open) return { ok: false, detail: 'the link popover did not open' };
      await S.click('.sheaf-linkpop-url');
      await S.press('Meta+a');
      await S.type('https://b.io/n');
      writeFileSync(path, doc.replace('Top line.', 'Top line changed by an agent, and rather longer than it was.'));
      await S.sleep(900);
      const stillOpen = await S.eval(() => !!document.querySelector('.sheaf-linkpop'));
      await S.press('Enter');
      await S.sleep(2400);
      const disk = readFileSync(path, 'utf8');
      const ok = disk.includes('[guide](https://b.io/n)') && disk.includes('changed by an agent');
      return { ok, detail: `the popover was ${stillOpen ? 'still open' : 'closed'} after the write; file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e24',
    feature: 'host.outside-change',
    name: 'The same popover edit with nothing else touching the file writes the new address',
    run: async (S) => {
      // e23's control.
      const doc = 'Top line.\n\nRead the [guide](https://a.io/g) first.\n\nBottom line.\n';
      const path = await S.fresh('merge-linkpop-control', doc);
      await S.sleep(800);
      await S.caret('guide', 2);
      await S.sleep(600);
      const open = await S.eval(() => !!document.querySelector('.sheaf-linkpop'));
      if (!open) return { ok: false, detail: 'the link popover did not open' };
      await S.click('.sheaf-linkpop-url');
      await S.press('Meta+a');
      await S.type('https://b.io/n');
      await S.sleep(900);
      await S.press('Enter');
      await S.sleep(2400);
      const disk = readFileSync(path, 'utf8');
      return { ok: disk.includes('[guide](https://b.io/n)'), detail: `file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e25',
    feature: 'host.outside-change',
    name: 'A write landing while an image is being resized keeps the size the drag gave it, on that image',
    run: async (S) => {
      // The handle writes a width into the document when it is let go, which makes this the one
      // gesture here that both reads a position and writes bytes at the end of it.
      const doc = 'Top line.\n\n![Dawn](../assets/terminal-dawn.png)\n\nBottom line.\n';
      const path = await S.fresh('merge-img-resize', doc);
      await S.sleep(1600);
      const img = await S.locate({ sel: '.md-img' }).catch(() => null);
      if (!img) return { ok: false, detail: 'the picture was not drawn' };
      await S.click({ sel: '.md-img' });
      await S.sleep(500);
      const handle = await S.locate({ sel: '.md-img-handle' }).catch(() => null);
      if (!handle) return { ok: false, detail: 'no resize handle on the selected picture' };
      await S.page.mouse.move(handle.x, handle.y);
      await S.page.mouse.down();
      await S.page.mouse.move(handle.x - 80, handle.y, { steps: 14 });
      await S.sleep(250);
      writeFileSync(path, doc.replace('Top line.', 'Top line changed by an agent, and rather longer than it was.'));
      await S.sleep(700);
      await S.page.mouse.up();
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const width = /<img src="\.\.\/assets\/terminal-dawn\.png" alt="Dawn" width="(\d+)">/.exec(disk);
      const ok = !!width && disk.includes('changed by an agent') && !/Bottom line[^\n]*img/.test(disk);
      return { ok, detail: `width written ${width ? width[1] : 'none'}; file ${j(disk)}` };
    },
  },
  {
    id: 'host.outside-change.edges.e26',
    feature: 'host.outside-change',
    name: 'The same image resize with nothing else touching the file writes a width',
    run: async (S) => {
      // e25's control.
      const doc = 'Top line.\n\n![Dawn](../assets/terminal-dawn.png)\n\nBottom line.\n';
      const path = await S.fresh('merge-img-resize-control', doc);
      await S.sleep(1600);
      const img = await S.locate({ sel: '.md-img' }).catch(() => null);
      if (!img) return { ok: false, detail: 'the picture was not drawn' };
      await S.click({ sel: '.md-img' });
      await S.sleep(500);
      const handle = await S.locate({ sel: '.md-img-handle' }).catch(() => null);
      if (!handle) return { ok: false, detail: 'no resize handle on the selected picture' };
      await S.page.mouse.move(handle.x, handle.y);
      await S.page.mouse.down();
      await S.page.mouse.move(handle.x - 80, handle.y, { steps: 14 });
      await S.sleep(950);
      await S.page.mouse.up();
      await S.sleep(2600);
      const disk = readFileSync(path, 'utf8');
      const width = /<img src="\.\.\/assets\/terminal-dawn\.png" alt="Dawn" width="(\d+)">/.exec(disk);
      return { ok: !!width, detail: `width written ${width ? width[1] : 'none'}; file ${j(disk)}` };
    },
  },
];
