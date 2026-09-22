// Marks on the lines something outside the editor just wrote, in real VS Code.
//
// jsdom has no layout, so it can say which lines carry the mark and nothing about where the bar
// is drawn. This writes the open file from outside, the way an agent does, and reads back which
// lines are marked, where the bar sits against the text, and that the file is exactly what was
// written.
//   node test/real-editor/run-editor.mjs change-marks [id]
const j = (x) => JSON.stringify(x);

const BEFORE = 'Intro line.\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nLast line.\n';
const AFTER = 'Intro line.\n\nFirst paragraph, rewritten.\n\nSecond paragraph.\n\nThird paragraph, rewritten.\n\nLast line.\n';

/** Which lines are marked, and where the first mark's bar is drawn against its text. */
const marks = (S) =>
  S.eval(() => {
    const lines = [...document.querySelectorAll('.cm-content > .cm-line')];
    const marked = lines.filter((l) => l.classList.contains('sheaf-arrived')).map((l) => l.textContent);
    const first = lines.find((l) => l.classList.contains('sheaf-arrived'));
    if (!first) return { marked, bar: null };
    const after = getComputedStyle(first, '::after');
    const box = first.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(first);
    const text = range.getBoundingClientRect();
    return {
      marked,
      bar: {
        width: after.width,
        left: box.left + parseFloat(after.left),
        textLeft: text.left,
        colour: after.backgroundColor,
      },
    };
  });

const TABLE_BEFORE = 'Intro line.\n\n| Part | Qty |\n| --- | --- |\n| bolt | 4 |\n| nut | 8 |\n| gear | 1 |\n\n> | Quoted | Table |\n> | --- | --- |\n> | a | 1 |\n\nLast line.\n';
const TABLE_AFTER = TABLE_BEFORE.replace('| nut | 8 |', '| nut | 12 |');

export const scenarios = [
  {
    id: 'host.change-marks.e03',
    feature: 'host.change-marks',
    name: 'A write from outside that changes one table row marks that row and no other, and a quoted table keeps its bar',
    run: async (S) => {
      await S.fresh('change-marks-table', TABLE_BEFORE);
      await S.caret('Intro', 2);
      await S.writeDisk(TABLE_AFTER);
      await S.sleep(1200);
      const m = await S.eval(() => {
        const rows = [...document.querySelectorAll('.sheaf-table tr.sheaf-arrived')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim());
        const quoted = document.querySelector('.sheaf-table.is-quoted');
        return { rows, quotedBar: quoted ? getComputedStyle(quoted).borderLeftWidth : null };
      });
      await S.shot('change-marks-table');
      const d = await S.disk();
      const ok = m.rows.length === 1 && /nut/.test(m.rows[0]) && /12/.test(m.rows[0]) && m.quotedBar === '3px' && d === TABLE_AFTER;
      return { ok, detail: `${j(m)}${d === TABLE_AFTER ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'host.change-marks.e01',
    feature: 'host.change-marks',
    name: 'A write from outside marks the two lines it rewrote, with a bar in the margin clear of the text, and leaves the file as written',
    run: async (S) => {
      await S.fresh('change-marks', BEFORE);
      await S.caret('Intro', 2);
      await S.writeDisk(AFTER);
      await S.sleep(1200);
      const m = await marks(S);
      await S.shot('change-marks');
      const d = await S.disk();
      const right = j(m.marked) === j(['First paragraph, rewritten.', 'Third paragraph, rewritten.']);
      const clear = !!m.bar && m.bar.width === '2px' && m.bar.left + 2 <= m.bar.textLeft;
      return { ok: right && clear && d === AFTER, detail: `${j(m)}${d === AFTER ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'host.change-marks.e02',
    feature: 'host.change-marks',
    name: 'Typing on a marked line clears its mark and leaves the other one',
    run: async (S) => {
      await S.fresh('change-marks-two', BEFORE);
      await S.caret('Intro', 2);
      await S.writeDisk(AFTER);
      await S.sleep(1200);
      await S.caret('First', 3);
      await S.type('Z');
      await S.sleep(400);
      const m = await marks(S);
      return { ok: j(m.marked) === j(['Third paragraph, rewritten.']), detail: j(m.marked) };
    },
  },
];
