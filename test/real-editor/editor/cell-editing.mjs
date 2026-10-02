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

/** Wait for a selector to appear, since opening a cell builds its editor a moment later. */
async function waitFor(S, sel, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await S.exists(sel)) return true;
    await S.sleep(100);
  }
  return S.exists(sel);
}

export const scenarios = [
  {
    /*
     * R12, driven by the key it is written in terms of. What covered it before was a scenario
     * pressing the cell toolbar's button, and the two are not the same claim: the button and the key
     * share `toggleWholeReveal`, so the button cannot tell whether the key reaches the cell's keymap
     * at all. In a real window that is the open question, because the workbench takes keys the page
     * did not handle and Cmd+Alt+E is a command out there too.
     *
     * Three readings and a control. The open cell before, revealed, and put back; and the cell beside
     * it, which must stay drawn throughout, because "reveal that one cell" is half the requirement
     * and a reveal that spread to the table would pass on the first two readings alone.
     *
     * `sheaf.revealSyntaxOnLine` is off by default, which is what makes the before reading mean
     * something: with it on, the caret's own line shows its markers and the reveal would be
     * indistinguishable from the state it starts in.
     */
    id: 'tables.cell-edit.reveal-one-cells-markdown-by-key',
    feature: 'tables.cell-edit',
    name: 'Cmd+Alt+E shows the open cell’s own raw Markdown and the same keys put it back, leaving every other cell drawn',
    run: async (S) => {
      const doc = 'Intro.\n\n| Note | Other |\n| ---- | ----- |\n| **start**. hello world | *keeps* its marks hidden |\n\nAfter line\n';
      const path = await S.fresh('cell-reveal-key', doc);
      await S.sleep(600);
      await S.dblclick({ sel: '.sheaf-table [data-r="0"][data-c="0"]' });
      const open = await waitFor(S, '.sheaf-table .sheaf-table-input.is-markdown .cm-content');
      await S.sleep(300);
      const read = () =>
        S.eval(() => {
          const ed = document.querySelector('.sheaf-table .sheaf-table-input.is-markdown .cm-content');
          const other = document.querySelector('.sheaf-table [data-r="0"][data-c="1"]');
          return {
            cell: ed ? ed.textContent : null,
            other: other ? other.textContent : null,
            otherEm: other ? !!other.querySelector('em, i, .cm-emphasis') : null,
          };
        });
      const before = await read();
      await S.press('Meta+Alt+e');
      await S.sleep(600);
      const revealed = await read();
      await S.press('Meta+Alt+e');
      await S.sleep(600);
      const back = await read();
      const d = await S.disk(path);
      const ok =
        open &&
        before.cell !== null &&
        !before.cell.includes('**') &&
        (revealed.cell ?? '').includes('**start**') &&
        back.cell === before.cell &&
        !(revealed.other ?? '').includes('*') &&
        revealed.other === before.other &&
        d === doc;
      return {
        ok,
        detail:
          `${open ? 'the cell is open for editing' : 'THE CELL DID NOT OPEN, so none of this is about an open cell'}; ` +
          `the cell reads ${j(before.cell)} drawn, ${j(revealed.cell)} revealed, ${j(back.cell)} after the second press; ` +
          `the cell beside it reads ${j(revealed.other)} throughout${revealed.other === before.other ? '' : ', WHICH MOVED'}; ` +
          `the file ${d === doc ? 'is unchanged' : `changed to ${j(d)}`}`,
      };
    },
  },
  {
    /*
     * R13, the principle the rest of this feature's cell-editor requirements are instances of: a
     * Markdown cell open for editing is the same editor as the prose around it for everything that
     * fits on one line, and what is left out is what a row has no room for.
     *
     * A principle is not checked by asserting it. It is checked by asking the same question of both
     * places and putting the two answers beside each other, which is the only shape that can catch a
     * cell editor that drifted: an assertion written from the cell's side would be rewritten along
     * with the drift and go on passing. So every chord is driven twice in the same document, once over
     * a word in a paragraph and once over the same word in a cell, and the scenario compares the
     * markup each produced rather than predicting either.
     *
     * The paragraph is the control in both directions. A chord that the workbench took before the page
     * saw it writes nothing in either place, and that reads as parity; printing both halves is what
     * tells it apart from parity, and the pass requires the paragraph to have changed.
     *
     * The chords are the five from `INLINE_CHORDS` that write text. `Mod-k` is in that set and is left
     * out on purpose: it opens the link popover rather than wrapping anything, so there is no markup to
     * compare, and `tables.cell-link` R4 is the part of R13 that covers links.
     *
     * The last case is the exclusion rather than the rule: a block chord has to do nothing in a cell,
     * and the same chord in the paragraph has to work, or "nothing happened" is a dead keystroke.
     */
    id: 'tables.cell-edit.a-cell-is-the-prose-editor-for-one-line-things',
    feature: 'tables.cell-edit',
    name: 'Every inline chord writes the same markup in a cell as in a paragraph, and a block chord writes none',
    run: async (S) => {
      const fixture = [
        'Intro.',
        '',
        'A second paragraph, to push the table clear of the toolbar.',
        '',
        'A third one with the target word in it.',
        '',
        '| Note | Other |',
        '| ---- | ----- |',
        '| target | plain |',
        '',
        'After line',
        '',
      ].join('\n');
      /** What sits either side of `target` on the line that holds it, which is the markup the chord wrote. */
      const wrapOn = (line) => {
        const m = /(\S*)target(\S*)/.exec(line ?? '');
        return m ? `${m[1]}|${m[2]}` : null;
      };
      /*
       * The paragraph is found by its line number, not by what it starts with. Looking for a line
       * starting `A third one` worked for every inline chord and not for the block one, because a
       * heading chord puts `# ` in front of it: the lookup returned nothing, the reading printed
       * `paragraph null`, and a reader would take that for a chord that did nothing when in fact it
       * had worked. The pass was right and its evidence read as the opposite.
       */
      const PARA = 4;
      const paraLine = (d) => d.split('\n')[PARA];
      const rowLine = (d) => d.split('\n').find((l) => l.startsWith('|') && l.includes('plain'));
      const WAS_PARA = fixture.split('\n')[PARA];
      const chords = [
        { key: 'Meta+b', what: 'Bold' },
        { key: 'Meta+i', what: 'Italic' },
        { key: 'Meta+Shift+X', what: 'Strikethrough' },
        { key: 'Meta+Shift+H', what: 'Highlight' },
        { key: 'Meta+e', what: 'Inline code' },
        { key: 'Meta+Alt+1', what: 'Heading 1, which a row has no room for' },
      ];
      const seen = [];
      for (const c of chords) {
        // A fresh document per chord, so one chord's markup cannot decide the next one's reading.
        await S.fresh(`cell-chord-${c.key.replace(/\W+/g, '-').toLowerCase()}`, fixture);
        await S.sleep(700);
        await S.dblclick({ text: 'target', occurrence: 0 });
        await S.sleep(300);
        await S.press(c.key);
        await S.sleep(700);
        const afterPara = await S.disk();
        await S.dblclick(cell(0, 0));
        await S.sleep(500);
        await S.dblclick({ text: 'target', within: '.sheaf-table-input', offset: 2 });
        await S.sleep(300);
        const picked = await S.eval(() => {
          const content = document.querySelector('.sheaf-table-input .cm-content');
          const tile = content && (content.cmTile || content.cmView);
          const view = tile?.root?.view ?? tile?.view;
          if (!view) return null;
          const s = view.state.selection.main;
          return view.state.sliceDoc(s.from, s.to);
        });
        await S.press(c.key);
        await S.sleep(500);
        await S.caret('After line', 2);
        await S.sleep(800);
        const after = await S.disk();
        seen.push({
          what: c.what,
          picked,
          paragraph: wrapOn(paraLine(afterPara)),
          cell: wrapOn(rowLine(after)),
          paragraphLine: paraLine(afterPara),
          cellLine: rowLine(after),
          // The line itself rather than the markup around the word, so a chord that prefixes the
          // line counts as having worked. The inline chords change both; a block chord changes only
          // this, which is the whole reason the two readings are kept apart.
          paragraphChanged: paraLine(afterPara) !== WAS_PARA,
        });
      }
      const inline = seen.slice(0, 5);
      const block = seen[5];
      const mismatched = inline.filter((r) => r.paragraph !== r.cell);
      const deadKeys = inline.filter((r) => !r.paragraphChanged);
      const unpicked = seen.filter((r) => r.picked !== 'target');
      const ok =
        mismatched.length === 0 &&
        deadKeys.length === 0 &&
        unpicked.length === 0 &&
        block.paragraphChanged &&
        block.cell === '|';
      return {
        ok,
        detail:
          inline.map((r) => `${r.what}: paragraph ${j(r.paragraph)} cell ${j(r.cell)}${r.paragraph === r.cell ? '' : ' MISMATCH'}`).join('; ') +
          `; ${block.what}: the paragraph became ${j(block.paragraphLine)}` +
          `${block.paragraphChanged ? '' : ' WHICH IS WHAT IT WAS, so the cell reading says nothing'}, ` +
          `and the row is ${j(block.cellLine)}${block.cell === '|' ? ' (nothing written, as a row has no room for one)' : ' WHICH WROTE A BLOCK INTO A ROW'}` +
          (deadKeys.length ? `; chords the paragraph never took: ${j(deadKeys.map((r) => r.what))}` : '') +
          (unpicked.length ? `; cases where the cell had ${j(unpicked.map((r) => r.picked))} selected rather than "target"` : ''),
      };
    },
  },
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
  {
    id: 'tables.cell-edit.top-toolbar-acts-on-the-cell',
    feature: 'tables.cell-edit',
    name: 'Bold on the top toolbar bolds the word selected in the open cell, and changes nothing else',
    run: async (S) => {
      /*
       * Reported 2026-09-27: the top toolbar is available while you are in a table cell, and Bold
       * has no effect. Measured in a browser it is worse than no effect: the toolbar is mounted with
       * `() => view`, the outer document's editor, so it acts at the outer selection. A Markdown cell
       * is a separate `EditorView` and the toolbar cannot see it.
       *
       * This is the window reading, because the window is where it was reported and because a
       * toolbar click is a pointer gesture through the real chrome. The setup is the realistic one
       * rather than the convenient one: a word is selected in the last paragraph first, so the outer
       * selection is somewhere a person had been working, which is what makes the edit land out of
       * sight instead of at position 0.
       *
       * Judged on the whole file, and on which lines moved, because "the cell did not change" and
       * "something else changed" are two different findings and only naming the line separates them.
       */
      /*
       * Its own fixture, with three paragraphs of air above the table. The shared `DOC` puts the
       * table two lines from the top, where it sits under the toolbar, and the harness refused the
       * click on it: `td#sheaf-grid-1-r2-c0 is covered by button.sheaf-tb-btn`. That refusal is
       * correct and is why the fixture changed rather than the click being forced.
       */
      const PADDED = [
        'Intro.',
        '',
        'A second paragraph, to push the table clear of the toolbar.',
        '',
        'A third one, for the same reason.',
        '',
        TABLE,
        '',
        'After line',
        '',
      ].join('\n');
      await S.fresh('cell-top-toolbar', PADDED);
      await S.sleep(700);
      const start = await S.disk();

      /*
       * Leave the outer selection in a paragraph above the table, the way someone who was writing
       * there would. Above rather than below on purpose: selecting a word in the last paragraph
       * scrolled the view and put the table under the toolbar, and the harness then refused the click
       * on the cell. Which side the outer selection is on makes no difference to what is being asked,
       * because the point is that the toolbar acts wherever the outer selection is rather than in the
       * cell.
       */
      await S.dblclick({ text: 'A third one', offset: 3 });
      await S.sleep(400);

      await S.dblclick(cell(1, 0));
      await S.sleep(500);
      await S.dblclick({ text: 'drone', within: '.sheaf-table-input', offset: 2 });
      await S.sleep(400);
      const selected = await S.eval(() => {
        const content = document.querySelector('.sheaf-table-input .cm-content');
        const tile = content && (content.cmTile || content.cmView);
        const view = tile?.root?.view ?? tile?.view;
        if (!view) return null;
        const s = view.state.selection.main;
        return view.state.sliceDoc(s.from, s.to);
      });

      await S.click({ sel: '[data-command="bold"]' });
      await S.sleep(800);
      const after = await S.disk();

      const lines = (d) => (d ?? '').split('\n');
      const moved = lines(start)
        .map((l, i) => (l === lines(after)[i] ? null : { line: i, was: l.slice(0, 48), now: (lines(after)[i] ?? '(gone)').slice(0, 48) }))
        .filter(Boolean);
      /*
       * The row is found by the part of it the edit cannot touch. Looking for a line starting
       * `| Maintenance drone` was the whole of this scenario's failure: bolding the word turns that
       * line into `| Maintenance **drone** | 3 | short |`, which does not start with it, so the
       * lookup returned null and `rowGotBold` was false *because the operation had worked*. The scenario
       * failed exactly when the product was right, and a marker saying the failure was expected
       * explained it away, so every run since reported it as known rather than as fixed.
       */
      const rowAt = lines(start).findIndex((l) => l.startsWith('| Maintenance'));
      const rowGotBold = (lines(after)[rowAt] ?? '').includes('**drone**');
      const onlyTheRow = moved.length === 1 && moved[0].line === rowAt;
      return {
        // The selection reading is the control: without a word selected in the cell there is nothing
        // for Bold to have done, and a pass would mean nothing.
        ok: selected === 'drone' && rowGotBold && onlyTheRow,
        detail:
          `the cell had ${j(selected)} selected; ` +
          `${rowGotBold ? 'the row gained **drone**' : 'the row did NOT gain **drone**'}; ` +
          `lines that changed ${j(moved)}` +
          `${moved.length === 0 ? ' — nothing at all changed' : ''}` +
          `${selected === 'drone' ? '' : '; AND NOTHING WAS SELECTED IN THE CELL, so this reading proves nothing either way'}`,
      };
    },
  },
  {
    /*
     * The same question as the scenario above, one cell kind along: a data field in a `csv` block
     * rather than a Markdown cell. The scenario above is the Markdown half and is the regression check
     * for the defect where the top toolbar acted at the outer selection while a cell was open.
     *
     * A data cell is a plain text box rather than a nested editor, so `toolbarTarget()` has nothing to
     * hand the toolbar and the whole bar is meant to be drawn unavailable. Twelve of the fourteen
     * buttons are. This reads all fourteen by name, so the two that are not are named rather than
     * counted, and then presses the one that writes.
     *
     * Judged on the whole file, because the fault this is about is a write the person cannot see: the
     * link does not go in the cell, it goes at the outer caret, which on a freshly opened document is
     * the first character of the document.
     */
    id: 'tables.cell-edit.top-toolbar-and-a-data-cell',
    feature: 'tables.cell-edit',
    name: 'With a data cell focused, no toolbar button writes anywhere, and the ones that cannot act say so',
    run: async (S) => {
      const DATA = [
        'Intro paragraph.',
        '',
        'A second paragraph, to push the block clear of the toolbar.',
        '',
        'A third one, for the same reason.',
        '',
        '```csv',
        'Role,Note',
        'technician,needs review here',
        '```',
        '',
        'After paragraph.',
        '',
      ].join('\n');
      const path = await S.fresh('toolbar-data-cell', DATA);
      await S.sleep(900);
      const start = await S.disk(path);
      // A single click, which focuses a data field. A double-click is the Markdown-cell gesture and
      // would be measuring the scenario above instead.
      await S.click({ sel: '.sheaf-table [data-r="0"][data-c="1"]' });
      await S.sleep(500);
      /*
       * What a single click on a data cell actually focuses, read rather than assumed. The first draft
       * asserted a text box and the reading said `div.sheaf-table-grid`: the click picks the cell and
       * the **grid** keeps focus, so there is no field with a caret in it. That is the state the
       * toolbar has nothing to act on, and it is not the state the first draft described.
       */
      const state = await S.eval(() => {
        const a = document.activeElement;
        return {
          activeElement: a ? `${a.tagName.toLowerCase()}.${(a.className || '').split(' ')[0]}` : null,
          inGrid: !!a && a.classList.contains('sheaf-table-grid'),
          cellPicked: document.querySelectorAll('.sheaf-table .is-sel, .sheaf-table .is-focus').length,
          nestedEditor: !!document.querySelector('.sheaf-table-input .cm-content'),
          // Whether a cell editor host exists at all, which is what decides whether the toolbar is
          // handed a view or nothing: a data field is a text box inside the same host.
          cellHost: !!document.querySelector('.sheaf-table-input'),
          // Where the outer document's own caret is, since that is what a button acting on the outer
          // view would act at. Read from the editor the page holds rather than inferred.
          outerSelection: (() => {
            const content = document.querySelector('.cm-editor .cm-content');
            const tile = content && (content.cmTile || content.cmView);
            const v = tile?.root?.view ?? tile?.view;
            if (!v) return null;
            const s = v.state.selection.main;
            return { from: s.from, to: s.to, around: JSON.stringify(v.state.sliceDoc(Math.max(0, s.from - 12), s.from + 12)) };
          })(),
          buttons: [...document.querySelectorAll('#toolbar .sheaf-tb-btn[data-command]')].map(
            (b) => `${b.dataset.command}:${b.disabled ? 'off' : 'ON'}`
          ),
        };
      });
      const offered = state.buttons.filter((b) => b.endsWith(':ON')).map((b) => b.split(':')[0]);
      // Press the one that writes, and answer its popover the way a person does.
      const link = '#toolbar .sheaf-tb-btn[data-command="link"]';
      const pressed = await S.eval((sel) => {
        const b = document.querySelector(sel);
        if (!b) return 'no link button';
        if (b.disabled) return 'disabled';
        b.click();
        return 'clicked';
      }, link);
      /*
       * Whether the popover opened, read before anything is typed. Without this, "the file is
       * unchanged" is also what a run reports when the button opened nothing and the address was typed
       * into the void, which is a reading about the gesture rather than about the product.
       */
      await S.sleep(600);
      const popover = await S.eval(() => {
        const pop = document.querySelector('.sheaf-linkpop');
        if (!pop) return { open: false };
        const url = pop.querySelector('.sheaf-linkpop-url');
        return { open: true, focused: document.activeElement === url ? 'url' : (document.activeElement?.className ?? 'elsewhere') };
      });
      if (pressed === 'clicked' && popover.open) {
        await S.type('https://example.com');
        await S.press('Enter');
        await S.sleep(900);
      }
      await S.caret('After paragraph', 2);
      await S.sleep(800);
      const after = await S.disk(path);
      /*
       * CONTROL, and it is the specific thing this fix could have broken rather than a formality.
       * Drawing a button unavailable is only half a rule: a button that goes dead the first time
       * somebody clicks a table cell and never comes back is a worse bug than the one being fixed, and
       * it is exactly what happens to a button that has no way of being brought back up to date. So
       * the caret goes back into prose and the same button has to be live there and write where it is.
       */
      const backInProse = await S.eval(
        (sel) => {
          const b = document.querySelector(sel);
          return { live: !!b && !b.disabled, offered: [...document.querySelectorAll('#toolbar .sheaf-tb-btn[data-command]')].filter((x) => !x.disabled).length };
        },
        link
      );
      await S.select('After');
      await S.sleep(300);
      await S.eval((sel) => document.querySelector(sel)?.click(), link);
      await S.sleep(600);
      const popAgain = await S.eval(() => !!document.querySelector('.sheaf-linkpop'));
      if (popAgain) {
        await S.press('Escape');
        await S.sleep(400);
      }
      const ended = await S.disk(path);
      const lines = (t) => t.split('\n');
      const moved = lines(start)
        .map((l, i) => (l === lines(after)[i] ? null : { line: i, was: l.slice(0, 40), now: (lines(after)[i] ?? '(gone)').slice(0, 40) }))
        .filter(Boolean);
      return {
        ok:
          state.inGrid &&
          state.cellPicked > 0 &&
          !state.nestedEditor &&
          after === start &&
          offered.length === 0 &&
          backInProse.live &&
          popAgain &&
          ended === start,
        detail:
          `${state.inGrid && state.cellPicked > 0 ? `the grid holds focus with ${state.cellPicked} cell(s) picked, ${state.activeElement}` : `THE GRID DOES NOT HOLD FOCUS (${state.activeElement}, ${state.cellPicked} picked), so nothing below is about a data cell`}; ` +
          `a nested editor ${state.nestedEditor ? 'OPENED, so this is a Markdown cell' : 'did not open, which is what a data field is'}; ` +
          `a cell editor host ${state.cellHost ? 'exists' : 'does not exist, so it is the grid holding focus rather than a field'}; ` +
          `the outer caret ${j(state.outerSelection)}, which is where a button acting on the outer view would write; ` +
          `buttons ${j(state.buttons)}; ` +
          `${offered.length === 0 ? 'none offered' : `OFFERED ${j(offered)}`}; ` +
          `the Link button was ${pressed} and its popover ${popover.open ? `opened, caret in ${j(popover.focused)}` : 'did not open, so no address was typed anywhere'}; ` +
          `${after === start ? 'the file is unchanged' : `THE FILE CHANGED, lines ${j(moved)}`}; ` +
          `CONTROL, caret back in prose: Link ${backInProse.live ? 'is live again' : 'IS STILL DEAD, so the fix left it permanently unavailable'} ` +
          `with ${backInProse.offered} button(s) offered, and pressing it ${popAgain ? 'opens its popover' : 'OPENS NOTHING'}; ` +
          `${ended === start ? 'and Escape left the file as it was' : `and the file ended ${j(ended)}`}`,
      };
    },
  },
];
