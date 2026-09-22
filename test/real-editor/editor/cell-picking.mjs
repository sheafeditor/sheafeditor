// Picking cells one at a time with Cmd-click, in real VS Code: what is picked, what the keys and the
// clipboard then act on, and what the screen shows.
//   node test/real-editor/run-editor.mjs cell-picking [id]
import { show } from '../session.mjs';
import { readPng, apart, show as colour } from '../pixels.mjs';

const TABLE = '| Fruit | Qty | Note |\n| ----- | --- | ---- |\n| apple | 3   | red  |\n| kiwi  | 12  | fuzz |\n| lime  | 7   | sour |\n| plum  | 4   | dark |';
const DOC = `Intro paragraph here.\n\n${TABLE}\n\nAfter line\n`;
const LINKED = `Intro paragraph here.\n\n| Fruit | Where |\n| ----- | ----- |\n| apple | [orchard](https://example.com/orchard) |\n| kiwi  | shed |\n\nAfter line\n`;
const j = (x) => JSON.stringify(x);

const cell = (r, c) => ({ sel: `.sheaf-table [data-r="${r}"][data-c="${c}"]` });
const gutter = (r) => ({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: r });

/** Which cells are picked, and which one is active. */
const picked = (S) =>
  S.eval(() => {
    const t = document.querySelector('.sheaf-table');
    const at = (el) => `${el.dataset.r},${el.dataset.c}`;
    return {
      sel: [...t.querySelectorAll('.is-sel')].map(at).sort(),
      active: t.querySelector('.is-focus') ? at(t.querySelector('.is-focus')) : null,
      editing: !!t.querySelector('input, textarea, .sheaf-table-input'),
    };
  });

const same = (a, b) => j([...a].sort()) === j([...b].sort());

async function fresh(S, name, doc = DOC) {
  await S.fresh(`pick-${name}`, doc);
  await S.sleep(500);
}

/** Cmd-click a run of cells, starting from a plain click on the first. */
async function pick(S, first, rest) {
  await S.click(cell(...first));
  for (const p of rest) await S.click(cell(...p), { modifiers: ['Meta'] });
  await S.sleep(250);
}

export const scenarios = [
  {
    id: 'tables.cell-picking.add-and-drop',
    feature: 'tables.cell-picking',
    name: 'Cmd-clicking a cell adds it to the picked cells, and Cmd-clicking it again takes it back out',
    run: async (S) => {
      await fresh(S, 'add-drop');
      await pick(S, [0, 0], [[2, 2]]);
      const added = await picked(S);
      await S.click(cell(2, 2), { modifiers: ['Meta'] });
      await S.sleep(250);
      const dropped = await picked(S);
      const d = await S.disk();
      return {
        ok: same(added.sel, ['0,0', '2,2']) && added.active === '2,2' && same(dropped.sel, ['0,0']) && dropped.active === '0,0' && d === DOC,
        detail: `after adding ${j(added)}; after dropping it ${j(dropped)}${d === DOC ? '' : `; file now ${show(d)}`}`,
      };
    },
  },
  {
    id: 'tables.cell-picking.dropping-the-active-cell',
    feature: 'tables.cell-picking',
    name: 'Dropping the cell that was active leaves the first of the rest active, so the next keystroke has a target',
    run: async (S) => {
      await fresh(S, 'drop-active');
      await pick(S, [1, 1], [[0, 0], [2, 2]]);
      const before = await picked(S);
      await S.click(cell(2, 2), { modifiers: ['Meta'] });
      await S.sleep(250);
      const after = await picked(S);
      return {
        ok: after.active === '0,0' && same(after.sel, ['0,0', '1,1']),
        detail: `before ${j(before)}; after dropping the active cell ${j(after)}`,
      };
    },
  },
  {
    id: 'tables.cell-picking.typing-hits-the-active-cell-only',
    feature: 'tables.cell-picking',
    name: 'Typing with several cells picked replaces the active cell and leaves the others alone',
    run: async (S) => {
      await fresh(S, 'typing');
      await pick(S, [0, 0], [[2, 2]]);
      await S.type('Z');
      await S.press('Enter');
      await S.sleep(400);
      const d = await S.disk();
      const want = DOC.replace('| lime  | 7   | sour |', '| lime  | 7   | Z    |');
      return { ok: d === want, detail: d === want ? '' : `file now ${show(d)}` };
    },
  },
  {
    id: 'tables.cell-picking.delete-clears-only-picked',
    feature: 'tables.cell-picking',
    name: 'Delete clears exactly the picked cells and nothing between them',
    run: async (S) => {
      await fresh(S, 'delete');
      await pick(S, [0, 0], [[2, 2]]);
      await S.press('Delete');
      await S.sleep(400);
      const d = await S.disk();
      const rows = d.split('\n').filter((l) => l.startsWith('|'));
      const ok = /\|\s*\|\s*3\s*\|\s*red\s*\|/.test(d) && /\|\s*lime\s*\|\s*7\s*\|\s*\|/.test(d) && /\|\s*kiwi\s*\|\s*12\s*\|\s*fuzz\s*\|/.test(d);
      return { ok, detail: ok ? '' : `rows now ${j(rows)}` };
    },
  },
  {
    id: 'tables.cell-picking.undo-restores-every-cleared-cell',
    feature: 'tables.cell-picking',
    name: 'Undo after clearing picked cells puts every one of them back in one step',
    run: async (S) => {
      await fresh(S, 'undo');
      await pick(S, [0, 0], [[2, 2]]);
      await S.press('Delete');
      await S.sleep(400);
      await S.press('Meta+z');
      await S.sleep(600);
      const d = await S.disk();
      return { ok: d === DOC, detail: d === DOC ? '' : `file now ${show(d)}` };
    },
  },
  {
    id: 'tables.cell-picking.copy-keeps-the-shape',
    feature: 'tables.cell-picking',
    name: 'Copying picked cells puts them on the clipboard in the shape they were picked, with the cells nobody picked empty',
    run: async (S) => {
      await fresh(S, 'copy');
      await S.clipboard.write('before');
      await pick(S, [0, 0], [[2, 2]]);
      await S.press('Meta+c');
      await S.sleep(400);
      const got = await S.clipboard.read();
      const want = 'apple\t\t\n\t\t\n\t\tsour';
      return { ok: got === want, detail: `clipboard ${j(got)}, want ${j(want)}` };
    },
  },
  {
    id: 'tables.cell-picking.fill-one-value',
    feature: 'tables.cell-picking',
    name: 'Pasting one value over picked cells fills each of them and nothing between',
    run: async (S) => {
      await fresh(S, 'fill');
      await S.clipboard.write('TBD');
      await pick(S, [0, 1], [[2, 1]]);
      await S.press('Meta+v');
      await S.sleep(600);
      const d = await S.disk();
      const ok = /\|\s*apple\s*\|\s*TBD\s*\|/.test(d) && /\|\s*lime\s*\|\s*TBD\s*\|/.test(d) && /\|\s*kiwi\s*\|\s*12\s*\|/.test(d);
      return { ok, detail: ok ? '' : `file now ${show(d)}` };
    },
  },
  {
    id: 'tables.cell-picking.escape-clears-every-block',
    feature: 'tables.cell-picking',
    name: 'Escape clears every picked cell, not only the last one',
    run: async (S) => {
      await fresh(S, 'escape');
      await pick(S, [0, 0], [[1, 1], [2, 2]]);
      await S.press('Escape');
      await S.sleep(300);
      const p = await picked(S);
      return { ok: p.sel.length === 0, detail: j(p) };
    },
  },
  {
    id: 'tables.cell-picking.select-all-after-picking',
    feature: 'tables.cell-picking',
    name: 'Cmd+A after picking cells takes the whole table',
    run: async (S) => {
      await fresh(S, 'select-all');
      await pick(S, [0, 0], [[2, 2]]);
      await S.press('Meta+a');
      await S.sleep(300);
      const p = await picked(S);
      return { ok: p.sel.length === 15, detail: `${p.sel.length} cells picked; ${j(p.sel.slice(0, 4))}` };
    },
  },
  {
    id: 'tables.cell-picking.row-number-after-picking',
    feature: 'tables.cell-picking',
    name: 'Clicking a row number after picking cells selects that row alone',
    run: async (S) => {
      await fresh(S, 'row-after');
      await pick(S, [0, 0], [[2, 2]]);
      await S.click(gutter(1));
      await S.sleep(300);
      const p = await picked(S);
      return { ok: same(p.sel, ['1,0', '1,1', '1,2']), detail: j(p) };
    },
  },
  {
    id: 'tables.cell-picking.cmd-click-still-opens-a-link',
    feature: 'tables.cell-picking',
    name: 'Cmd-clicking a link inside a cell still opens the link instead of picking the cell',
    run: async (S) => {
      await fresh(S, 'link', LINKED);
      await S.eval(() => {
        window.__opened = [];
        const orig = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          window.__opened.push(this.href || this.dataset.href || '');
        };
        window.__origClick = orig;
      });
      await S.click(cell(0, 0));
      await S.click({ sel: '.sheaf-table [data-r="0"][data-c="1"] [data-href], .sheaf-table [data-r="0"][data-c="1"] a' }, { modifiers: ['Meta'] });
      await S.sleep(400);
      const p = await picked(S);
      const d = await S.disk();
      return {
        ok: same(p.sel, ['0,0']) && d === LINKED,
        detail: `picked ${j(p.sel)} (the link's cell must not be picked); file ${d === LINKED ? 'unchanged' : show(d)}`,
      };
    },
  },
  {
    id: 'tables.cell-picking.picked-cells-are-painted',
    feature: 'tables.cell-picking',
    name: 'Every picked cell is painted as picked, and the cells between them are not',
    run: async (S) => {
      await fresh(S, 'painted');
      const anchor = await S.click(cell(0, 0));
      await S.click(cell(2, 2), { modifiers: ['Meta'] });
      await S.sleep(400);
      const mids = await S.eval(() => {
        const mid = (r, c) => {
          const b = document.querySelector(`.sheaf-table [data-r="${r}"][data-c="${c}"]`).getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        };
        return { first: mid(0, 0), picked: [mid(0, 0), mid(2, 2)], between: [mid(1, 1), mid(0, 2), mid(2, 0)] };
      });
      const dx = anchor.x - mids.first.x;
      const dy = anchor.y - mids.first.y;
      const img = readPng(await S.shot('picked', { clipToEditor: false }));
      const at = (p) => img.atCss(p.x + dx, p.y + dy);
      const on = mids.picked.map(at);
      const off = mids.between.map(at);
      const allPicked = on.every((c) => off.every((u) => apart(c, u) > 8));
      const nonePickedBetween = off.every((u) => on.every((c) => apart(c, u) > 8));
      return {
        ok: allPicked && nonePickedBetween,
        detail: `picked cells ${on.map(colour).join(' ')}; cells between ${off.map(colour).join(' ')}`,
      };
    },
  },
];
