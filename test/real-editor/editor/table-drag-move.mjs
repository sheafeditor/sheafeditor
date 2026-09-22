// Moving rows and columns by dragging their row number or header, now that a drag on an unselected
// one selects instead. What happens when the selection covers more than one.
//   node test/real-editor/run-editor.mjs table-drag-move [id]
import { show } from '../session.mjs';

const TABLE = '| Fruit | Qty | Note |\n| ----- | --- | ---- |\n| apple | 3   | red  |\n| kiwi  | 12  | fuzz |\n| lime  | 7   | sour |\n| plum  | 4   | dark |';
const DOC = `Intro paragraph here.\n\n${TABLE}\n\nAfter line\n`;
const j = (x) => JSON.stringify(x);

const cell = (r, c) => ({ sel: `.sheaf-table [data-r="${r}"][data-c="${c}"]` });
const gutter = (r) => ({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: r });

/** The body rows of the table on disk, as their first cell. */
const rowsOnDisk = (text) =>
  text
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|[\s:-]+\|/.test(l))
    .slice(1)
    .map((l) => l.split('|')[1].trim());

const selection = (S) =>
  S.eval(() => {
    const t = document.querySelector('.sheaf-table');
    return [...t.querySelectorAll('.is-sel')].map((el) => `${el.dataset.r},${el.dataset.c}`);
  });

export const scenarios = [
  {
    id: 'tables.drag-move.two-selected-rows-move-together',
    feature: 'tables.drag-move',
    name: 'With two rows selected, dragging one of their row numbers moves both, keeping their order',
    run: async (S) => {
      await S.fresh('drag-two-rows', DOC);
      await S.sleep(500);
      await S.click(gutter(0));
      await S.click(gutter(1), { modifiers: ['Shift'] });
      await S.sleep(200);
      await S.drag(gutter(0), gutter(3));
      const d = await S.disk();
      const rows = rowsOnDisk(d);
      const want = ['lime', 'plum', 'apple', 'kiwi'];
      return { ok: j(rows) === j(want), detail: `rows now ${j(rows)}, want ${j(want)}` };
    },
  },
  {
    id: 'tables.drag-move.moved-row-stays-selected',
    feature: 'tables.drag-move',
    name: 'A row dragged to a new place is still the selected row when it lands',
    run: async (S) => {
      await S.fresh('drag-keeps-sel', DOC);
      await S.sleep(500);
      await S.click(gutter(0));
      await S.sleep(200);
      await S.drag(gutter(0), gutter(2));
      await S.sleep(300);
      const sel = await selection(S);
      const d = await S.disk();
      const moved = rowsOnDisk(d);
      const want = ['kiwi', 'lime', 'apple', 'plum'];
      const onRow2 = sel.length === 3 && sel.every((s) => s.startsWith('2,'));
      return { ok: j(moved) === j(want) && onRow2, detail: `rows ${j(moved)}; selected ${j(sel)}` };
    },
  },
  {
    id: 'tables.drag-move.two-selected-columns-move-together',
    feature: 'tables.drag-move',
    name: 'With two columns selected, dragging one of their headers moves both',
    run: async (S) => {
      await S.fresh('drag-two-cols', DOC);
      await S.sleep(500);
      await S.click(cell(-1, 0));
      await S.click(cell(-1, 1), { modifiers: ['Shift'] });
      await S.sleep(200);
      await S.drag(cell(-1, 0), cell(-1, 2));
      const d = await S.disk();
      const header = d.split('\n').find((l) => l.includes('Note'));
      const want = '| Note | Fruit | Qty |';
      const got = (header ?? '').replace(/\s+\|/g, ' |').replace(/\|\s+/g, '| ').trim();
      return { ok: got === want, detail: `header now ${j(got)}, want ${j(want)}` };
    },
  },
  {
    id: 'tables.drag-move.selecting-then-moving-in-one-go',
    feature: 'tables.drag-move',
    name: 'Selecting rows by dragging the row numbers, letting go, then dragging them again moves them',
    run: async (S) => {
      await S.fresh('drag-select-then-move', DOC);
      await S.sleep(500);
      await S.drag(gutter(0), gutter(1));
      const afterSelect = await S.disk();
      await S.sleep(200);
      await S.drag(gutter(1), gutter(3));
      const d = await S.disk();
      const rows = rowsOnDisk(d);
      const want = ['lime', 'plum', 'apple', 'kiwi'];
      return {
        ok: afterSelect === DOC && j(rows) === j(want),
        detail: `file after the selecting drag ${afterSelect === DOC ? 'unchanged' : show(afterSelect)}; rows after the moving drag ${j(rows)}, want ${j(want)}`,
      };
    },
  },
];
