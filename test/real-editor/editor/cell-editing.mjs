// Opening a cell for editing, in real VS Code: what a person can see and read while they type.
//   node test/real-editor/run-editor.mjs cell-editing [id]
const j = (x) => JSON.stringify(x);

const LONG = 'a long note that wraps across more than one line inside its own column because it keeps going';
const TABLE = `| Role | Qty | Note |\n| ---- | --- | ---- |\n| Systems technician | 2 | ${LONG} |\n| Maintenance drone | 3 | short |`;
const DOC = `Intro.\n\n${TABLE}\n\nAfter line\n`;
const cell = (r, c) => ({ sel: `.sheaf-table [data-r="${r}"][data-c="${c}"]` });

// A table whose delimiter row aligns the second column right and the third centre.
const ALIGNED = '| Item | Cost | State |\n| --- | ---: | :---: |\n| bolt | 12.50 | spare |\n| washer | 3.00 | fitted |';
const ALIGNED_DOC = `Intro.\n\n${ALIGNED}\n\nAfter line\n`;

/**
 * The cell's box, the editor's box inside it, and how much of the value is out of sight.
 *
 * A Markdown cell edits in a nested editor, so the open cell is a div holding `.cm-content`
 * rather than an input with a `.value`; a CSV field is still a text box. Both are read here,
 * and asking only for `input, textarea` is how these scenarios reported an open cell as
 * having no editor at all.
 */
const box = (S, r, c) =>
  S.eval(
    ({ r, c }) => {
      const el = document.querySelector(`.sheaf-table [data-r="${r}"][data-c="${c}"]`);
      const plain = el.querySelector('input, textarea');
      const nested = el.querySelector('.sheaf-table-input .cm-content');
      const ed = plain ?? nested;
      const h = (n) => Math.round(n.getBoundingClientRect().height);
      const value = plain
        ? plain.value
        : (() => {
            const tile = nested && (nested.cmTile || nested.cmView);
            return (tile?.root?.view ?? tile?.view)?.state.doc.toString() ?? null;
          })();
      // Where the text is drawn, which is what a person reads: its box against the cell's.
      const cb = el.getBoundingClientRect();
      const tb = nested ? nested.getBoundingClientRect() : plain ? plain.getBoundingClientRect() : null;
      return {
        textTop: tb ? Math.round(tb.top - cb.top) : null,
        textBottom: tb ? Math.round(tb.bottom - cb.bottom) : null,
        cellHeight: h(el),
        rowHeight: Math.round(el.closest('tr').getBoundingClientRect().height),
        editorHeight: ed ? h(ed) : null,
        tag: plain ? plain.tagName : nested ? 'editor' : null,
        hiddenPx: ed ? Math.max(0, ed.scrollWidth - ed.clientWidth) : null,
        valueLength: value == null ? null : value.length,
      };
    },
    { r, c }
  );

export const scenarios = [
  {
    id: 'tables.cell-edit.wrapped-cell-stays-readable',
    feature: 'tables.cell-edit',
    name: 'Opening a cell whose text wraps keeps the whole value on screen, as the row already shows it',
    run: async (S) => {
      await S.fresh('cell-wrap', DOC);
      await S.sleep(600);
      const before = await box(S, 0, 2);
      await S.dblclick(cell(0, 2));
      await S.sleep(400);
      const editing = await box(S, 0, 2);
      const inside = editing.textTop != null && editing.textTop >= -1 && editing.textBottom <= 1;
      const ok = editing.hiddenPx === 0 && editing.cellHeight >= before.cellHeight - 2 && inside;
      return {
        ok,
        detail: `rendered ${before.cellHeight}px tall; editing ${editing.cellHeight}px with a ${editing.tag} ${editing.editorHeight}px tall and ${editing.hiddenPx}px of the ${editing.valueLength}-character value out of sight; text from ${editing.textTop}px to ${editing.textBottom}px against the cell's top and bottom`,
      };
    },
  },
  {
    id: 'tables.cell-edit.editor-fills-a-tall-cell',
    feature: 'tables.cell-edit',
    name: 'In a row made tall by another column, the open editor fills its cell instead of leaving a band of selection colour',
    run: async (S) => {
      await S.fresh('cell-tall', DOC);
      await S.sleep(600);
      await S.dblclick(cell(0, 0));
      await S.sleep(400);
      const m = await box(S, 0, 0);
      const gap = m.cellHeight - (m.editorHeight ?? 0);
      // Height alone passed while the text was drawn a row lower, so the text must also sit inside the cell.
      const inside = m.textTop != null && m.textTop >= -1 && m.textBottom <= 1;
      return { ok: gap <= 2 && inside, detail: `cell ${m.cellHeight}px, editor ${m.editorHeight}px, ${gap}px of the cell left uncovered; text from ${m.textTop}px to ${m.textBottom}px against the cell's top and bottom; ${j(m)}` };
    },
  },
  {
    id: 'tables.cell-edit.text-stays-in-its-cell',
    feature: 'tables.cell-edit',
    name: 'Opening a cell in an ordinary row draws its value inside that cell, not below it',
    run: async (S) => {
      await S.fresh('cell-short', DOC);
      await S.sleep(600);
      await S.dblclick(cell(1, 0));
      await S.sleep(400);
      const m = await box(S, 1, 0);
      const inside = m.textTop != null && m.textTop >= -1 && m.textBottom <= 1;
      return { ok: inside, detail: `text from ${m.textTop}px to ${m.textBottom}px against the cell's top and bottom (0 and 0 or inside is right); ${j(m)}` };
    },
  },
  {
    id: 'tables.cell-edit.alignment-survives-editing',
    feature: 'tables.cell-edit',
    name: 'Opening a cell in a right-aligned or centred column keeps that alignment and the column width',
    run: async (S) => {
      await S.fresh('cell-aligned', ALIGNED_DOC);
      await S.sleep(600);
      const widths = () =>
        S.eval(() =>
          [...document.querySelectorAll('.sheaf-table thead th[data-c]')].map((th) => Math.round(th.getBoundingClientRect().width))
        );
      const align = (r, c) =>
        S.eval(
          ({ r, c }) => {
            const el = document.querySelector(`.sheaf-table [data-r="${r}"][data-c="${c}"]`);
            // The open editor is a nested editor's content for a Markdown cell, a text box for a
            // data one. Alignment is a question about whichever is there.
            const ed = el.querySelector('input, textarea') ?? el.querySelector('.sheaf-table-input .cm-content');
            return { cell: getComputedStyle(el).textAlign, editor: ed ? getComputedStyle(ed).textAlign : null };
          },
          { r, c }
        );
      const before = await widths();
      const right = await align(0, 1);
      await S.dblclick(cell(0, 1));
      await S.sleep(400);
      const rightOpen = await align(0, 1);
      const duringRight = await widths();
      await S.press('Escape');
      await S.sleep(300);
      await S.dblclick(cell(0, 2));
      await S.sleep(400);
      const centreOpen = await align(0, 2);
      const duringCentre = await widths();
      // The editor should take the column's own alignment, and opening it should
      // not change any column's width.
      const same = (a, b) => a.length === b.length && a.every((w, i) => Math.abs(w - b[i]) <= 1);
      const ok =
        rightOpen.editor === right.cell &&
        centreOpen.editor === centreOpen.cell &&
        same(before, duringRight) &&
        same(before, duringCentre);
      return {
        ok,
        detail: `right column ${j(right.cell)} -> editor ${j(rightOpen.editor)}; centre column ${j(centreOpen.cell)} -> editor ${j(centreOpen.editor)}; widths ${j(before)} -> ${j(duringRight)} (right open) -> ${j(duringCentre)} (centre open)`,
      };
    },
  },
  {
    id: 'tables.cell-edit.toolbar-over-a-cell',
    feature: 'tables.cell-edit',
    name: 'Cmd+A in an open header cell brings the formatting toolbar up whole, over the cell and on screen, and a double-clicked word in an open cell brings it up for that word',
    run: async (S) => {
      await S.fresh('cell-toolbar', DOC);
      await S.sleep(600);
      await S.dblclick(cell(-1, 0));
      await S.sleep(400);
      // Cmd+A in the open cell: the same text the cell opened with, chosen on purpose.
      await S.press('Meta+a');
      await S.sleep(500);
      const m = await S.eval(() => {
        const bar = document.querySelector('.sheaf-seltb');
        const open = document.querySelector('.sheaf-table-input');
        if (!bar || !open) {
          // Say why: whether any tooltip was made, whether it is hidden, and what the cell has selected.
          const tips = [...document.querySelectorAll('.cm-tooltip')].map((t) => ({ cls: t.className, display: getComputedStyle(t).display, top: Math.round(t.getBoundingClientRect().top) }));
          const sel = getSelection();
          return { bar: !!bar, open: !!open, tips, selected: sel ? sel.toString() : null, active: document.activeElement?.className ?? null };
        }
        const b = bar.getBoundingClientRect();
        const c = open.getBoundingClientRect();
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return {
          bar: true,
          open: true,
          above: Math.round(c.top - b.bottom),
          onScreen: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth,
          unclipped: !!top && bar.contains(top),
          buttons: bar.querySelectorAll('button').length,
        };
      });
      await S.shot('cell-toolbar');
      // A double-click on one word inside an open cell picks that word and brings the
      // toolbar up for it, as it does in the text; the cell stays open.
      await S.dblclick(cell(0, 0));
      await S.sleep(400);
      await S.dblclick({ text: 'technician', within: '.sheaf-table-input', offset: 3 });
      await S.sleep(500);
      const w = await S.eval(() => ({
        bar: !!document.querySelector('.sheaf-seltb'),
        open: !!document.querySelector('.sheaf-table [data-r="0"][data-c="0"] .sheaf-table-input'),
        selected: getSelection()?.toString() ?? null,
      }));
      await S.shot('cell-toolbar-word');
      const d = await S.disk();
      // The toolbar's shadow edge may rest a few pixels onto the cell's border; what matters is the text stays clear.
      const ok =
        m.bar && m.above >= -4 && m.onScreen && m.unclipped && m.buttons >= 5 && w.bar && w.open && w.selected === 'technician' && d === DOC;
      return { ok, detail: `${j(m)}; word ${j(w)}${d === DOC ? '' : '; the file changed'}` };
    },
  },
];
