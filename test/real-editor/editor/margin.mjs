// The page's left margin in real VS Code: where the block handle sits beside blocks of
// different heights, and the line numbers against the pane's edge. Both are layout, which
// jsdom cannot measure.
//   node test/real-editor/run-editor.mjs margin [id]
const j = (x) => JSON.stringify(x);

const LONG = 'This paragraph runs long enough to wrap onto several lines in any pane a person would write in, '.repeat(5).trim();
const DOC = `# A heading at the top\n\nOne short line.\n\n${LONG}\n\n## A second heading\n\nLast line.\n`;

/** Where the handle's middle sits against the middle of the first visual line of the block under the pointer. */
const handleAgainstFirstLine = (S, starts) =>
  S.eval((starts) => {
    const handle = document.querySelector('.sheaf-block-handle');
    const line = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) => l.textContent.startsWith(starts));
    if (!handle || handle.hidden || !line) return null;
    const range = document.createRange();
    const text = line.firstChild && line.firstChild.nodeType === 3 ? line.firstChild : line.querySelector('*')?.firstChild ?? line;
    range.setStart(text, 0);
    range.setEnd(text, Math.min(1, text.textContent.length));
    const first = range.getBoundingClientRect();
    const h = handle.getBoundingClientRect();
    return { offset: Math.round(h.top + h.height / 2 - (first.top + first.height / 2)), lineHeight: Math.round(line.getBoundingClientRect().height) };
  }, starts);

export const scenarios = [
  {
    id: 'blocks.handle.e20',
    feature: 'blocks.handle',
    name: 'The block handle sits on the first line of a one-line paragraph, a paragraph of several lines and a heading alike',
    run: async (S) => {
      await S.fresh('margin-handle', DOC);
      await S.caret('Last line', 2);
      const read = {};
      for (const [name, starts] of [['short', 'One short line'], ['long', 'This paragraph'], ['h1', 'A heading at'], ['h2', 'A second heading']]) {
        await S.hover({ text: starts, offset: 2 });
        await S.sleep(400);
        read[name] = await handleAgainstFirstLine(S, starts);
      }
      const d = await S.disk();
      const onFirst = Object.values(read).every((r) => r && Math.abs(r.offset) <= 3);
      const longIsLong = (read.long?.lineHeight ?? 0) > 60;
      return { ok: onFirst && longIsLong && d === DOC, detail: j(read) };
    },
  },
  {
    id: 'render.line-numbers.e01',
    feature: 'render.line-numbers',
    name: 'Line numbers clear the pane edge, and turning them on leaves the writing column where it was',
    run: async (S) => {
      const lines = Array.from({ length: 1200 }, (_, i) => `Line ${i + 1}.`).join('\n\n') + '\n';
      await S.fresh('margin-numbers', lines);
      await S.caret('Line 1.', 2);
      const textLeft = () =>
        S.eval(() => {
          const l = document.querySelector('.cm-content > .cm-line');
          const r = document.createRange();
          r.selectNodeContents(l);
          return Math.round(r.getBoundingClientRect().left);
        });
      const before = await textLeft();
      await S.click({ sel: 'button[aria-label="Toggle line numbers"], [title="Toggle line numbers"]' });
      await S.sleep(500);
      const after = await textLeft();
      // Down to the four-digit numbers.
      await S.press('Meta+ArrowDown');
      await S.sleep(600);
      const edge = await S.eval(() => {
        const pane = document.querySelector('.cm-scroller').getBoundingClientRect().left;
        const nums = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter((e) => /\d/.test(e.textContent));
        const lefts = nums.map((e) => {
          const r = document.createRange();
          r.selectNodeContents(e);
          return r.getBoundingClientRect().left - pane;
        });
        return { widest: nums.reduce((m, e) => Math.max(m, e.textContent.trim().length), 0), minInset: Math.round(Math.min(...lefts)) };
      });
      await S.shot('margin-numbers');
      await S.click({ sel: 'button[aria-label="Toggle line numbers"], [title="Toggle line numbers"]' });
      const d = await S.disk();
      return { ok: before === after && edge.widest === 4 && edge.minInset >= 3 && d === lines, detail: j({ before, after, edge }) };
    },
  },
  {
    /*
     * The other tenant of the left margin, which the block handle's own fix did not measure.
     *
     * A wide table's frame spans the pane, so its cells slide into that margin when the table is
     * scrolled sideways, and the margin is where both the block handle and the line-number gutter
     * live. The handle's fix moved the grip vertically onto the strip above the header row; the
     * numbers cannot move, because `theme.ts` gives `.cm-gutters` a width cancelled by an equal
     * negative margin on purpose, so they are drawn over the page margin and take no horizontal
     * space. That leaves the question this asks: with the numbers on, does a scrolled table's
     * content end up underneath them.
     *
     * Read as an overlap of rectangles rather than as what a click reaches. The gutter paints
     * above the table, so a press on a number reaches the number whether or not a cell is behind
     * it, and a cell behind a number is exactly what a person sees as a fault.
     */
    id: 'render.line-numbers.e02',
    feature: 'render.line-numbers',
    name: 'A table has no line number beside it, so no cell of a scrolled one can be drawn under one',
    run: async (S) => {
      const many = 40;
      const head = Array.from({ length: many }, (_, i) => `W${i + 1}`);
      const body = Array.from({ length: many }, (_, i) => `value ${i + 1}`);
      const doc = `Intro paragraph.\n\n| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n| ${body.join(' | ')} |\n\nAfter line\n`;
      await S.fresh('margin-numbers-table', doc);
      await S.sleep(1200);
      await S.click({ sel: 'button[aria-label="Toggle line numbers"], [title="Toggle line numbers"]' });
      await S.sleep(700);
      /*
       * `scrollLeft` rather than a gesture: this is a question about geometry at a scroll
       * position, not about how the position was reached, and set past the end so the browser
       * clamps it and the reading does not depend on knowing the maximum.
       */
      const read = async (scroll) =>
        S.eval(
          (far) => {
            const grid = document.querySelector('.sheaf-table-grid');
            if (!grid) return null;
            if (far) grid.scrollLeft = 1e6;
            else grid.scrollLeft = 0;
            const nums = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
              .filter((e) => /\d/.test(e.textContent ?? ''))
              .map((e) => e.getBoundingClientRect())
              .filter((r) => r.width > 0);
            const cells = [...document.querySelectorAll('.sheaf-table th, .sheaf-table td')]
              .map((c) => ({ c, b: c.getBoundingClientRect() }))
              .filter(({ b }) => b.width > 0);
            const over = [];
            for (const n of nums) {
              for (const { c, b } of cells) {
                if (b.right > n.left + 1 && b.left < n.right - 1 && b.bottom > n.top + 1 && b.top < n.bottom - 1) {
                  over.push(`${(c.textContent ?? '').trim().slice(0, 10) || '(empty)'} under a number at ${Math.round(n.left)}`);
                  break;
                }
              }
            }
            const box = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
            return {
              scrollLeft: Math.round(grid.scrollLeft),
              numbers: nums.length,
              over,
              firstCellLeft: Math.round(cells[0]?.b.left ?? 0),
              numbersRight: nums.length ? Math.round(Math.max(...nums.map((r) => r.right))) : 0,
              /*
               * The two bands, printed, because the pass is only worth anything if the rectangles
               * could have met. At rest the table's own gutter column starts a pixel from the pane's
               * edge, inside the numbers' horizontal band, so a reading of "over no cell" has to be
               * explained by the vertical bands missing rather than taken at face value.
               */
              numberBoxes: nums.map(box),
              /*
               * How many numbers are drawn in the table's own vertical band. Zero today, and the
               * reason the overlap check above cannot fail: a block widget's source lines get no
               * gutter element, so there is no number beside a table.
               */
              numbersBesideTable: cells.length
                ? (() => {
                    const top = Math.min(...cells.map((c) => c.b.top));
                    const bottom = Math.max(...cells.map((c) => c.b.bottom));
                    return nums.filter((r) => r.bottom > top + 1 && r.top < bottom - 1).length;
                  })()
                : -1,
              /*
               * CONTROL for the count above. The same band intersection, asked of an ordinary
               * paragraph, where it has to find a number. A zero here means the intersection itself
               * is broken and the zero beside the table says nothing about the product.
               */
              numbersBesideProse: (() => {
                const line = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) =>
                  (l.textContent ?? '').includes('Intro paragraph')
                );
                if (!line) return -1;
                const b = line.getBoundingClientRect();
                return nums.filter((r) => r.bottom > b.top + 1 && r.top < b.bottom - 1).length;
              })(),
              cellBand: cells.length
                ? `${Math.round(Math.min(...cells.map((c) => c.b.top)))}..${Math.round(Math.max(...cells.map((c) => c.b.bottom)))}`
                : 'none',
              firstCell: cells[0] ? box(cells[0].b) : 'none',
            };
          },
          scroll
        );
      const rest = await read(false);
      await S.sleep(400);
      const scrolled = await read(true);
      await S.sleep(400);
      await S.click({ sel: 'button[aria-label="Toggle line numbers"], [title="Toggle line numbers"]' });
      const d = await S.disk();
      if (!rest || !scrolled) return { ok: false, detail: 'no grid or no line numbers on screen' };
      /*
       * **What this can actually catch, which is not what it was first written to catch.**
       *
       * It was written to assert that a scrolled table's cells are never under a line number, and
       * measuring it showed that assertion cannot fail. Two separate reasons, both read off the
       * numbers printed below: the numbers are drawn at x 27..42 while the table's frame runs from
       * x 1, so they are in different columns; and CodeMirror draws no gutter element at all in the
       * table's own vertical band, because the three source lines are replaced by one block widget.
       * There is no number beside a table to be under. An overlap check there passes on every
       * build, including one that put every cell in the gutter.
       *
       * So the two conditions that make the collision impossible are what is asserted, and either
       * one failing is the signal to ask the original question again:
       *
       * - `numbersBesideTable === 0`: no number is drawn in the table's vertical band. If a future
       *   version numbers a block widget's lines, this fails and the overlap question is live.
       * - `clearOfCells`: every number's column is clear of every cell, at rest and scrolled. If the
       *   frame grows further left or the gutter moves right, this fails.
       *
       * `numbers > 0` and `scrollLeft > 100` are the preconditions: with the toggle missed there are
       * no numbers at all, and with no scroll the content never enters the margin, and either one
       * would make the rest pass for the wrong reason.
       */
      const besideTable = (r) => r.numbersBesideTable;
      return {
        ok:
          rest.numbers > 0 &&
          scrolled.numbers > 0 &&
          scrolled.scrollLeft > 100 &&
          besideTable(rest) === 0 &&
          besideTable(scrolled) === 0 &&
          // The control: the same intersection must find a number beside a paragraph.
          rest.numbersBesideProse > 0 &&
          rest.over.length === 0 &&
          scrolled.over.length === 0 &&
          d === doc,
        detail:
          `at rest: ${rest.numbers} numbers ending at ${rest.numbersRight}, first cell at ${rest.firstCellLeft}, ` +
          `over ${rest.over.length ? j(rest.over) : 'no cell'}; ` +
          `scrolled ${scrolled.scrollLeft}px: ${scrolled.numbers} numbers ending at ${scrolled.numbersRight}, ` +
          `first cell at ${scrolled.firstCellLeft}, over ${scrolled.over.length ? j(scrolled.over) : 'no cell'}; ` +
          `number boxes ${j(rest.numberBoxes)}; cells span y ${rest.cellBand}, first cell ${rest.firstCell}; ` +
          `numbers drawn beside the table ${rest.numbersBesideTable} at rest and ${scrolled.numbersBesideTable} scrolled, ` +
          `against ${rest.numbersBesideProse} beside the intro paragraph as the control; ` +
          `file unchanged ${d === doc}`,
      };
    },
  },
];
