// A table is edited only as a grid: a selection that reaches a table, from a double-click beside it, a drag, Select All
// or a find match, should leave the grid drawn, and a click back into the text should always restore it.
//   node test/real-editor/run-editor.mjs tables-selection [id]
const j = (x) => JSON.stringify(x);
const TABLE = '| Fruit | Qty |\n| ----- | --- |\n| apple | 3   |\n| kiwi  | 12  |';
const DOC = `Intro paragraph here.\n\n${TABLE}\n\nAfter line\n`;

const look = (S) =>
  S.eval(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view;
    const r = v.state.selection.main;
    const doc = v.state.doc.toString();
    const tableFrom = doc.indexOf('| Fruit');
    const tableTo = doc.indexOf('| kiwi  | 12  |') + '| kiwi  | 12  |'.length;
    return {
      grids: document.querySelectorAll('.sheaf-table').length,
      rawPipeLines: [...document.querySelectorAll('.cm-line')].filter((l) => /^\s*\|.*\|\s*$/.test(l.textContent)).length,
      selection: { from: r.from, to: r.to, text: v.state.sliceDoc(r.from, r.to) },
      table: { from: tableFrom, to: tableTo },
      selectionTouchesTable: r.to > tableFrom && r.from < tableTo,
      settingDoubleClickReveals: !!(window.__sheafConfig && window.__sheafConfig.doubleClickToEditSource),
    };
  });

/** Window coordinates for a point described in the Sheaf frame, using a located cell as the reference. */
async function frameToWindow(S, rectsOf) {
  const ref = await S.locate({ sel: '.sheaf-table [data-r="0"][data-c="0"]' });
  const rects = await S.eval(rectsOf);
  return { dx: ref.x - (rects.ref.left + rects.ref.width / 2), dy: ref.y - (rects.ref.top + rects.ref.height / 2), rects };
}

function marginCase(id, name, xOf) {
  return {
    id: `tables.stays-grid.${id}`,
    feature: 'tables.stays-grid',
    name,
    run: async (S) => {
      await S.fresh(`stays-grid-${id}`, DOC);
      await S.sleep(500);
      const before = await look(S);
      const { dx, dy, rects } = await frameToWindow(S, () => {
        const r = (el) => el.getBoundingClientRect().toJSON();
        return {
          ref: r(document.querySelector('.sheaf-table [data-r="0"][data-c="0"]')),
          row: r(document.querySelector('.sheaf-table [data-r="1"][data-c="0"]')),
          grid: r(document.querySelector('.sheaf-table-grid')),
          content: r(document.querySelector('.cm-content')),
        };
      });
      const x = xOf(rects) + dx;
      const y = rects.row.top + rects.row.height / 2 + dy;
      await S.page.mouse.click(x, y, { clickCount: 2 });
      await S.sleep(600);
      const after = await look(S);
      const d = await S.disk();
      await S.shot(`tables.stays-grid.${id}`);
      return {
        ok: after.grids === 1 && after.rawPipeLines === 0 && d === DOC,
        detail: `clicked ${Math.round(x)},${Math.round(y)}; before ${j(before)}; after ${j(after)}; file unchanged ${d === DOC}`,
      };
    },
  };
}

export const scenarios = [
  marginCase('margin-left-of-table', 'Double-click the page margin level with a table row: what is selected, and is the table still a grid', (r) => r.content.left + 2),
  marginCase('right-of-table', 'Double-click just right of the table level with a row: what is selected, and is the table still a grid', (r) => Math.min(r.grid.right + 40, r.content.right - 10)),
  {
    id: 'tables.stays-grid.single-click-beside-table',
    feature: 'tables.stays-grid',
    name: 'A single click in the same margin spot leaves the table a grid',
    run: async (S) => {
      await S.fresh('stays-grid-single', DOC);
      await S.sleep(500);
      const { dx, dy, rects } = await frameToWindow(S, () => {
        const r = (el) => el.getBoundingClientRect().toJSON();
        return { ref: r(document.querySelector('.sheaf-table [data-r="0"][data-c="0"]')), row: r(document.querySelector('.sheaf-table [data-r="1"][data-c="0"]')), content: r(document.querySelector('.cm-content')) };
      });
      const x = rects.content.left + 2 + dx;
      const y = rects.row.top + rects.row.height / 2 + dy;
      await S.page.mouse.click(x, y);
      await S.sleep(600);
      const after = await look(S);
      const d = await S.disk();
      return { ok: after.grids === 1 && after.rawPipeLines === 0 && d === DOC, detail: `clicked ${Math.round(x)},${Math.round(y)}; after ${j(after)}; file unchanged ${d === DOC}` };
    },
  },
  {
    id: 'tables.stays-grid.drag-ending-on-the-table-boundary',
    feature: 'tables.stays-grid',
    name: 'Drag from the paragraph above and let go on the table: the table stays a grid',
    run: async (S) => {
      await S.fresh('stays-grid-drag', DOC);
      await S.sleep(500);
      const a = await S.locate({ text: 'Intro paragraph', offset: 0 });
      const { dx, dy, rects } = await frameToWindow(S, () => {
        const r = (el) => el.getBoundingClientRect().toJSON();
        return { ref: r(document.querySelector('.sheaf-table [data-r="0"][data-c="0"]')), grid: r(document.querySelector('.sheaf-table-grid')), row: r(document.querySelector('.sheaf-table [data-r="1"][data-c="0"]')) };
      });
      await S.page.mouse.move(a.x, a.y);
      await S.page.mouse.down();
      await S.page.mouse.move(rects.grid.right - 4 + dx, rects.row.top + rects.row.height / 2 + dy, { steps: 14 });
      await S.page.mouse.up();
      await S.sleep(600);
      const after = await look(S);
      const d = await S.disk();
      return { ok: after.grids === 1 && after.rawPipeLines === 0 && d === DOC, detail: `after the drag ${j(after)}; file unchanged ${d === DOC}` };
    },
  },
  {
    id: 'tables.stays-grid.select-all',
    feature: 'tables.stays-grid',
    name: 'Cmd+A in the text: the table stays a grid',
    run: async (S) => {
      await S.fresh('stays-grid-select-all', DOC);
      await S.sleep(500);
      await S.caret('Intro paragraph', 3);
      await S.page.keyboard.press('Meta+a');
      await S.sleep(600);
      const after = await look(S);
      const d = await S.disk();
      return { ok: after.grids === 1 && after.rawPipeLines === 0 && d === DOC, detail: `after Cmd+A ${j(after)}; file unchanged ${d === DOC}` };
    },
  },
  {
    id: 'tables.stays-grid.search-match-in-a-table',
    feature: 'tables.stays-grid',
    name: 'Find a word that sits in a table: the match is selected and the table stays a grid',
    run: async (S) => {
      await S.fresh('stays-grid-search', DOC);
      await S.sleep(500);
      await S.caret('Intro paragraph', 3);
      await S.page.keyboard.press('Meta+f');
      await S.sleep(500);
      const panel = await S.exists('.cm-search, .cm-panel');
      await S.page.keyboard.type('kiwi');
      await S.sleep(400);
      await S.page.keyboard.press('Enter');
      await S.sleep(600);
      const after = await look(S);
      await S.page.keyboard.press('Escape');
      await S.sleep(300);
      const afterEscape = await look(S);
      const d = await S.disk();
      return {
        ok: panel && after.grids === 1 && after.rawPipeLines === 0 && d === DOC,
        detail: `search panel ${panel}; at the match ${j(after)}; after Escape ${j(afterEscape)}; file unchanged ${d === DOC}`,
      };
    },
  },
  {
    id: 'tables.stays-grid.click-away-keeps-grid',
    feature: 'tables.stays-grid',
    name: 'A double-click beside the table, then a click into the text below: the table is a grid throughout and the file is unchanged',
    run: async (S) => {
      await S.fresh('stays-grid-click-away', DOC);
      await S.sleep(500);
      const { dx, dy, rects } = await frameToWindow(S, () => {
        const r = (el) => el.getBoundingClientRect().toJSON();
        return { ref: r(document.querySelector('.sheaf-table [data-r="0"][data-c="0"]')), row: r(document.querySelector('.sheaf-table [data-r="1"][data-c="0"]')), content: r(document.querySelector('.cm-content')) };
      });
      await S.page.mouse.click(rects.content.left + 2 + dx, rects.row.top + rects.row.height / 2 + dy, { clickCount: 2 });
      await S.sleep(600);
      const after = await look(S);
      await S.caret('After line', 3);
      await S.sleep(600);
      const back = await look(S);
      const d = await S.disk();
      return { ok: after.grids === 1 && after.rawPipeLines === 0 && back.grids === 1 && d === DOC, detail: `after the double-click ${j(after)}; after clicking into the text ${j(back)}; file unchanged ${d === DOC}` };
    },
  },
  {
    id: 'tables.stays-grid.typed-out-by-hand',
    feature: 'tables.stays-grid',
    name: 'Typing a table out by hand: after the delimiter row the two lines stay source, so the next pipe lands on that row and not under a grid',
    run: async (S) => {
      /*
       * R8's third door, which had no scenario at all and whose requirement described it wrongly
       * for a fortnight. It said "a caret moved inside the table", and a caret cannot be put inside
       * a table drawn as a grid: `tables.ts` registers the table field in `EditorView.atomicRanges`,
       * so a click cannot land inside one and an arrow steps over it.
       *
       * The real door is at the other end. A table needs a delimiter row to be a table, so the
       * moment `| - | -` parses the block becomes one, and a person typing it out by hand is left
       * with their caret at its close with the last ` |` still to type. If the grid were drawn
       * there, that ` |` would land after the widget as a line of its own and they would have a
       * delimiter row missing its pipe with a stray ` |` under the table.
       *
       * So this types a table the way a person does and reads the file, which is where the
       * consequence lands. The screen is read too, because R8's own subject is what shows its
       * Markdown and the file alone cannot distinguish "stayed source" from "drew a grid and the
       * keystroke happened to go to the right place".
       */
      const seen = (S) =>
        S.eval(() => {
          const v = document.querySelector('.cm-content').cmTile.root.view;
          return {
            grids: document.querySelectorAll('.sheaf-table').length,
            pipeLines: [...document.querySelectorAll('.cm-line')].filter((l) => /\|/.test(l.textContent)).length,
            doc: v.state.doc.toString(),
          };
        });

      await S.fresh('stays-grid-typed', 'Intro line.\n');
      await S.sleep(500);
      await S.caret('Intro line', 11);
      await S.press('Enter');
      await S.press('Enter');
      await S.type('| a | b |');
      await S.press('Enter');
      // Stops one character short of a finished delimiter row on purpose: this is the state the
      // door exists for, and the next keystroke is what it protects.
      await S.type('| - | -');
      await S.sleep(700);
      const atTheDoor = await seen(S);

      await S.type(' |');
      await S.sleep(700);
      const afterThePipe = await seen(S);

      // And once there is a body row it is an ordinary table, which is the control: without it,
      // "stayed source" could be a table that never draws rather than this one case.
      await S.press('Enter');
      await S.type('| 1 | 2 |');
      await S.sleep(900);
      await S.caret('Intro line', 3);
      await S.sleep(700);
      const withABody = await seen(S);
      const d = await S.disk();

      const delimiterWhole = /\n\| - \| - \|\n/.test(d);
      const noStrayPipe = !/\n ?\|\n/.test(d);
      const ok = atTheDoor.grids === 0 && delimiterWhole && noStrayPipe && withABody.grids === 1;
      return {
        ok,
        detail:
          `at the door ${j(atTheDoor.grids)} grid(s), ${atTheDoor.pipeLines} line(s) showing a pipe; ` +
          `after typing the last pipe ${j(afterThePipe.grids)} grid(s); ` +
          `${delimiterWhole ? 'the delimiter row is whole' : 'THE DELIMITER ROW IS NOT WHOLE'}; ` +
          `${noStrayPipe ? 'no stray pipe line' : 'A STRAY PIPE LINE IS IN THE FILE'}; ` +
          `control: with a body row ${j(withABody.grids)} grid(s) and ${withABody.pipeLines} pipe line(s); ` +
          `file ${j(d)}`,
      };
    },
  },
];
