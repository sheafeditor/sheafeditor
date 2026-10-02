// Typing a table out by hand, one keystroke at a time, and reading the file after each line.
//
// `tables.stays-grid` R8's third door keeps a header row and a delimiter row as source so the last
// `|` of the delimiter row lands on it. What it does not say is what happens on the Enter after
// that, and a person typing a table does not stop at the delimiter row.
//
// Found while writing the scenario for that door: its file came out as
// "| a | b |\n| - | - |\n\n| 1 | 2 |\n", with a blank line between the delimiter row and the body
// row, which in Markdown is not one table but a two-line table and a stray paragraph.
//   node test/real-editor/run-editor.mjs typed-table [id]

const j = (x) => JSON.stringify(x);

/** The document, and what is drawn, after each step. */
const seen = (S) =>
  S.eval(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view;
    const r = v.state.selection.main;
    return {
      doc: v.state.doc.toString(),
      grids: document.querySelectorAll('.sheaf-table').length,
      caretLine: v.state.doc.lineAt(r.head).number,
      caretInLine: r.head - v.state.doc.lineAt(r.head).from,
    };
  });

export const scenarios = [
  {
    id: 'tables.stays-grid.typed-table-is-one-table',
    feature: 'tables.stays-grid',
    name: 'A table typed out by hand, header then delimiter then a row, is one table in the file with no blank line through it',
    run: async (S) => {
      /*
       * Each line is typed and the file read before the next, so a failure says which keystroke
       * did it rather than only that the end state is wrong.
       *
       * The assertion is the file, because that is where it costs: a blank line between the
       * delimiter row and the first body row ends the table in every Markdown reader, so the row
       * the person typed is a paragraph of pipes and the table has no rows at all.
       */
      await S.fresh('typed-table', 'Intro line.\n');
      await S.sleep(500);
      await S.caret('Intro line', 11);
      await S.press('Enter');
      await S.press('Enter');

      await S.type('| a | b |');
      await S.sleep(500);
      const afterHeader = await seen(S);

      await S.press('Enter');
      await S.sleep(500);
      const afterFirstEnter = await seen(S);

      await S.type('| - | - |');
      await S.sleep(700);
      const afterDelimiter = await seen(S);

      await S.press('Enter');
      await S.sleep(700);
      const afterSecondEnter = await seen(S);

      await S.type('| 1 | 2 |');
      await S.sleep(900);
      const afterRow = await seen(S);

      await S.caret('Intro line', 3);
      await S.sleep(700);
      const settled = await seen(S);
      const d = await S.disk();

      // One table means the three lines are consecutive. A blank line anywhere between them ends it.
      const oneTable = /\| a \| b \|\n\| - \| - \|\n\| 1 \| 2 \|/.test(d);
      const blankInside = /\| - \| - \|\n\s*\n\| 1 \| 2 \|/.test(d);
      return {
        ok: oneTable && settled.grids === 1,
        detail:
          `after the header ${j(afterHeader.doc)}; ` +
          `after Enter ${j(afterFirstEnter.doc)}; ` +
          `after the delimiter row ${j(afterDelimiter.doc)} (${afterDelimiter.grids} grid); ` +
          `after Enter ${j(afterSecondEnter.doc)} (${afterSecondEnter.grids} grid, caret on line ${afterSecondEnter.caretLine} at ${afterSecondEnter.caretInLine}); ` +
          `after the row ${j(afterRow.doc)} (${afterRow.grids} grid); ` +
          `${oneTable ? 'the three lines are consecutive' : 'THE THREE LINES ARE NOT CONSECUTIVE'}` +
          `${blankInside ? ', AND A BLANK LINE SITS BETWEEN THE DELIMITER ROW AND THE BODY ROW, so this is two blocks rather than one table' : ''}; ` +
          `with the caret away ${settled.grids} grid(s); file ${j(d)}`,
      };
    },
  },
  {
    id: 'tables.stays-grid.typed-table-plain-text-after',
    feature: 'tables.stays-grid',
    name: 'Reading: after the same Enter, ordinary words land a line below the caret too, so this is not the table parser taking the line',
    run: async (S) => {
      /*
       * The same gesture with ordinary words instead of pipes, to say which of two things is
       * happening. If plain text also lands a line below, the fault is the caret's position after
       * the grid draws and has nothing to do with tables as such. If only the pipes move, the
       * table parse is reclaiming the line.
       *
       * Either answer is a finding; what this rules out is reporting the wrong one.
       */
      await S.fresh('typed-table-plain', 'Intro line.\n');
      await S.sleep(500);
      await S.caret('Intro line', 11);
      await S.press('Enter');
      await S.press('Enter');
      await S.type('| a | b |');
      await S.press('Enter');
      await S.type('| - | - |');
      await S.sleep(700);
      await S.press('Enter');
      await S.sleep(700);
      const atCaret = await seen(S);
      await S.type('plain words');
      await S.sleep(800);
      const after = await seen(S);
      const d = await S.disk();
      const landedOnTheCaretLine = /\| - \| - \|\nplain words/.test(d);
      /*
       * A reading rather than an assertion, because the behaviour it finds is deliberate. Typing
       * below a finished table opens a fresh line on purpose: the filter that does it was measured
       * with it removed, and without it the typed text joins the table's range and the grid stops
       * being drawn. So "the words landed a line below" is correct here, and what this case is for
       * is saying that the same thing happens to words as to pipes, which is what rules out the
       * table parser reclaiming the line.
       */
      return {
        ok: true,
        detail:
          `caret on line ${atCaret.caretLine} at ${atCaret.caretInLine}, ${atCaret.grids} grid(s), doc ${j(atCaret.doc)}; ` +
          `${landedOnTheCaretLine ? 'the words landed on the caret line' : 'THE WORDS LANDED A LINE BELOW THE CARET, so this is not about pipes'}; ` +
          `after ${j(after.doc)}; file ${j(d)}`,
      };
    },
  },
  {
    id: 'tables.stays-grid.typing-under-an-existing-table',
    feature: 'tables.stays-grid',
    name: 'Reading: typing on the empty line under a finished table opens a fresh line below it, which is the deliberate rule',
    run: async (S) => {
      /*
       * Nothing typed, nothing built, no delimiter row half finished. The table is in the file
       * when it opens, the caret is put on the blank line below it, and one word is typed. If this
       * fails too then the whole of the typing sequence above is a consequence of this one thing,
       * and that is the sentence a bug report needs.
       */
      const doc = 'Intro line.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter line.\n';
      await S.fresh('under-table', doc);
      await S.sleep(600);
      await S.caret('After line', 0);
      await S.press('ArrowUp');
      await S.sleep(400);
      const before = await seen(S);
      await S.type('X');
      await S.sleep(800);
      const after = await seen(S);
      const d = await S.disk();
      const landedOnTheCaretLine = /\| 1 \| 2 \|\nX\n/.test(d);
      // Reported rather than asserted, for the reason above: this is the deliberate behaviour, and
      // the pair of it with the no-table control below is what makes it mean something.
      return {
        ok: true,
        detail:
          `caret on line ${before.caretLine} at ${before.caretInLine}, ${before.grids} grid(s); ` +
          `${landedOnTheCaretLine ? 'the X landed on the caret line' : 'THE X DID NOT LAND ON THE CARET LINE'}; ` +
          `after ${j(after.doc)} with the caret on line ${after.caretLine}; file ${j(d)}`,
      };
    },
  },
  {
    id: 'tables.stays-grid.typing-on-a-blank-line-between-paragraphs',
    feature: 'tables.stays-grid',
    name: 'CONTROL: the same gesture with no table anywhere takes the caret line, so a table is what differs',
    run: async (S) => {
      /*
       * The control the three scenarios above need, and without it none of them means what it
       * looks like. Typing on a blank separator line is a gesture with a real question behind it
       * whatever is above the line: write there and the new text joins the paragraph below, since
       * a single newline is a soft break. So an editor opening a fresh line instead may be a
       * deliberate rule about separator lines rather than anything to do with tables.
       *
       * If this behaves the same way, the readings above are that rule and not a defect. If a
       * plain blank line takes the character and the one under a table does not, the table is what
       * differs and the reports above stand.
       */
      const doc = 'Intro line.\n\nFirst paragraph.\n\nAfter line.\n';
      await S.fresh('under-paragraph', doc);
      await S.sleep(600);
      await S.caret('After line', 0);
      await S.press('ArrowUp');
      await S.sleep(400);
      const before = await seen(S);
      await S.type('X');
      await S.sleep(800);
      const after = await seen(S);
      const d = await S.disk();
      const landedOnTheCaretLine = /First paragraph\.\nX\n/.test(d);
      return {
        ok: true, // A reading, not an assertion: either answer is information.
        detail:
          `caret on line ${before.caretLine} at ${before.caretInLine}; ` +
          `${landedOnTheCaretLine ? 'the X LANDED ON THE CARET LINE here, so a table is what differs' : 'the X did not land on the caret line here either, so this is the rule for a blank separator line and not about tables'}; ` +
          `after ${j(after.doc)} with the caret on line ${after.caretLine}; file ${j(d)}`,
      };
    },
  },
];
