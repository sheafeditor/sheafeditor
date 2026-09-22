// Can a find match inside a table cell be seen while the table is drawn as a grid?
// Typing in the find field highlights every match without selecting one, so the grid stays drawn at that moment;
// pressing Enter selects the match. Together they show whether a match in a cell is marked where a person can see it.
//   node test/real-editor/run-editor.mjs tables-find [id]
const j = (x) => JSON.stringify(x);
const TABLE = '| Fruit | Qty |\n| ----- | --- |\n| apple | 3   |\n| kiwi  | 12  |';
const DOC = `Intro paragraph about kiwi fruit.\n\n${TABLE}\n\nAfter line mentions apple once.\n`;

const look = (S) =>
  S.eval(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view;
    const r = v.state.selection.main;
    const marks = [...document.querySelectorAll('.cm-searchMatch, .cm-searchMatch-selected')];
    const grid = document.querySelector('.sheaf-table');
    const inGrid = grid ? marks.filter((m) => grid.contains(m)).length : 0;
    const cellText = grid ? [...grid.querySelectorAll('[data-r][data-c]')].map((c) => c.textContent) : [];
    return {
      grids: document.querySelectorAll('.sheaf-table').length,
      rawPipeLines: [...document.querySelectorAll('.cm-line')].filter((l) => /^\s*\|.*\|\s*$/.test(l.textContent)).length,
      searchMarks: marks.length,
      searchMarksInsideGrid: inGrid,
      selection: { from: r.from, to: r.to, text: v.state.sliceDoc(r.from, r.to) },
      cellsShowingTheWord: cellText.filter((t) => /kiwi/i.test(t)),
    };
  });

async function find(S, word, { enter = false } = {}) {
  await S.page.keyboard.press('Meta+f');
  await S.sleep(500);
  await S.page.keyboard.type(word);
  await S.sleep(600);
  if (enter) {
    await S.page.keyboard.press('Enter');
    await S.sleep(600);
  }
}

// Where the grid's active cell is, what it says, and whether it is seen: inside the
// editor's frame and not under a header row stuck to its top.
const active = (S) =>
  S.eval(() => {
    const cell = document.querySelector('.sheaf-table .is-focus');
    if (!cell) return null;
    const frame = document.querySelector('.cm-scroller').getBoundingClientRect();
    const box = cell.getBoundingClientRect();
    const head = cell.closest('table')?.tHead?.rows[0]?.getBoundingClientRect();
    const floor = head && head.top <= frame.top + 1 ? Math.max(frame.top, head.bottom) : frame.top;
    return {
      text: cell.textContent,
      current: cell.classList.contains('cm-searchMatch-selected'),
      seen: box.top >= floor - 1 && box.bottom <= frame.bottom + 1,
    };
  });

const LONG_ROWS = Array.from({ length: 80 }, (_, i) => `| row ${i + 1} | ${i === 64 ? 'kiwi' : 'plum'} |`).join('\n');
const LONG_DOC = `Intro paragraph.\n\n| Name | Fruit |\n| ---- | ----- |\n${LONG_ROWS}\n\nAfter the table.\n`;

export const scenarios = [
  {
    id: 'tables.find.match-cell-tinted-and-made-active',
    feature: 'tables.find',
    name: 'A word in the text and in a cell, typed into find, tints the cell while the grid stays drawn; Enter moves from the match in the text to the cell and makes it the active cell; Escape leaves a grid and the file unchanged',
    run: async (S) => {
      await S.fresh('find-cell-active', DOC);
      await S.sleep(500);
      await S.caret('Intro paragraph', 3);
      await find(S, 'kiwi');
      const typing = await look(S);
      // The first Enter selects the "kiwi" in the intro line; the second moves into the table.
      await S.page.keyboard.press('Enter');
      await S.sleep(400);
      await S.page.keyboard.press('Enter');
      await S.sleep(700);
      const selected = await look(S);
      const cell = await active(S);
      await S.shot('find-match-cell-active');
      await S.page.keyboard.press('Escape');
      await S.sleep(400);
      const afterEscape = await look(S);
      const d = await S.disk();
      return {
        ok:
          typing.grids === 1 &&
          typing.searchMarksInsideGrid >= 1 &&
          selected.grids === 1 &&
          /kiwi/.test(cell?.text ?? '') &&
          cell?.current === true &&
          afterEscape.grids === 1 &&
          afterEscape.searchMarksInsideGrid === 0 &&
          d === DOC,
        detail: `while typing ${j(typing)}; after Enter ${j(selected)} active ${j(cell)}; after Escape ${j(afterEscape)}; file unchanged ${d === DOC}`,
      };
    },
  },
  {
    id: 'tables.find.match-far-down-a-long-table-is-scrolled-into-view',
    feature: 'tables.find',
    name: 'Enter on a match 65 rows down a long table makes its cell active and brings it into view, below the stuck header row',
    run: async (S) => {
      await S.fresh('find-long', LONG_DOC);
      await S.sleep(500);
      await S.caret('Intro paragraph', 3);
      await find(S, 'kiwi', { enter: true });
      const cell = await active(S);
      await S.shot('find-match-far-down');
      await S.page.keyboard.press('Escape');
      const d = await S.disk();
      return {
        ok: /kiwi/.test(cell?.text ?? '') && cell?.seen === true && d === LONG_DOC,
        detail: `active ${j(cell)}; file unchanged ${d === LONG_DOC}`,
      };
    },
  },
  {
    id: 'tables.stays-grid.find-match-in-prose-while-typing (control)',
    feature: 'tables.stays-grid',
    name: 'Control: typing a word of the prose into the find field highlights it, so a missing highlight elsewhere means something',
    run: async (S) => {
      await S.fresh('find-prose', DOC);
      await S.sleep(500);
      await S.caret('Intro paragraph', 3);
      await find(S, 'paragraph');
      const after = await look(S);
      await S.page.keyboard.press('Escape');
      return { ok: after.searchMarks > 0, detail: `while typing in the find field ${j(after)}` };
    },
  },
  {
    id: 'tables.stays-grid.find-match-inside-a-cell-while-the-grid-is-drawn',
    feature: 'tables.stays-grid',
    name: 'A word that sits only in a table cell, typed into the find field: is the match visible while the grid is still drawn?',
    run: async (S) => {
      await S.fresh('find-cell', DOC);
      await S.sleep(500);
      await S.caret('Intro paragraph', 3);
      await find(S, 'kiwi');
      const typing = await look(S);
      await S.shot('find-match-while-grid-drawn');
      await S.page.keyboard.press('Enter');
      await S.sleep(700);
      const selected = await look(S);
      await S.page.keyboard.press('Escape');
      await S.sleep(400);
      const afterEscape = await look(S);
      return {
        ok: typing.grids === 1 && typing.searchMarksInsideGrid > 0,
        detail: `while typing, grid still drawn ${typing.grids === 1}: ${j(typing)}; after Enter ${j(selected)}; after Escape ${j(afterEscape)}`,
      };
    },
  },
  {
    id: 'tables.stays-grid.find-next-match-moves-into-the-table',
    feature: 'tables.stays-grid',
    name: 'Enter twice on a word that appears in the prose and in a cell: where does the second match land, and what is drawn',
    run: async (S) => {
      await S.fresh('find-two', DOC);
      await S.sleep(500);
      await S.caret('Intro paragraph', 3);
      await find(S, 'kiwi', { enter: true });
      const first = await look(S);
      await S.page.keyboard.press('Enter');
      await S.sleep(700);
      const second = await look(S);
      await S.page.keyboard.press('Escape');
      const d = await S.disk();
      return { ok: second.grids === 1 && d === DOC, detail: `first match ${j(first)}; second ${j(second)}; file unchanged ${d === DOC}` };
    },
  },
];
