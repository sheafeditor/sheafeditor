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
];
