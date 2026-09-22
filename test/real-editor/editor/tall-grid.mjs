// Opening a cell in a grid taller than the pane, which is where the page can move between the two
// clicks of a double-click and open a different row than the one under the pointer.
//
// The changelog says the page stays still there; these check it.
//   node test/real-editor/run-editor.mjs tall-grid [id]
const j = (x) => JSON.stringify(x);

const records = Array.from({ length: 300 }, (_, i) => `r${i + 1},value ${i + 1},note ${i + 1}`).join('\n');
const DOC = `A paragraph above the block, so the grid does not start at the top of the pane.\n\n\`\`\`csv\nid,value,note\n${records}\n\`\`\`\n\nAfter the block.\n`;

const cell = (r, c) => ({ sel: `.sheaf-table [data-r="${r}"][data-c="${c}"]` });

/** Which cell holds the open editor, and where the document is scrolled to. */
const state = (S) =>
  S.eval(() => {
    const ed = document.querySelector('.sheaf-table input, .sheaf-table textarea');
    const host = ed && ed.closest('[data-r]');
    return {
      openCell: host ? `${host.dataset.r},${host.dataset.c}` : null,
      openValue: ed ? ed.value : null,
      scrollTop: Math.round(document.querySelector('.cm-scroller').scrollTop),
    };
  });

export const scenarios = [
  {
    id: 'data.large-blocks.e04',
    feature: 'data.large-blocks',
    name: 'Double-clicking a cell in the first record of a 300-record grid opens that cell, and the page does not jump between the clicks',
    run: async (S) => {
      await S.fresh('tall-grid', DOC);
      await S.sleep(1200);
      const before = await state(S);
      await S.dblclick(cell(0, 1));
      await S.sleep(500);
      const opened = await state(S);
      await S.type('Z');
      await S.press('Enter');
      await S.sleep(600);
      const d = await S.disk();
      const firstRecord = d.split('\n').find((l) => l.startsWith('r1,'));
      const landedInRecordOne = firstRecord === 'r1,Z,note 1';
      const stayedPut = Math.abs(opened.scrollTop - before.scrollTop) <= 4;
      return {
        ok: opened.openCell === '0,1' && landedInRecordOne && stayedPut,
        detail: `opened ${j(opened.openCell)} holding ${j(opened.openValue)}; scroll ${before.scrollTop} -> ${opened.scrollTop}; first record now ${j(firstRecord)}`,
      };
    },
  },
  {
    id: 'data.large-blocks.e05',
    feature: 'data.large-blocks',
    name: 'Typing into a record far down a 300-record grid changes only that record on disk',
    run: async (S) => {
      const doc = DOC;
      await S.fresh('tall-grid-deep', doc);
      await S.sleep(1200);
      // Reach record 40 with the keyboard, which moves the page without the pointer.
      await S.click(cell(0, 1));
      for (let i = 0; i < 39; i++) await S.page.keyboard.press('ArrowDown');
      await S.sleep(400);
      await S.press('Enter');
      await S.type('deep');
      await S.press('Enter');
      await S.sleep(800);
      const d = await S.disk();
      const want = doc.replace('r40,value 40,note 40', 'r40,deep,note 40');
      const changed = d.split('\n').filter((l, i) => l !== doc.split('\n')[i]);
      return { ok: d === want, detail: d === want ? '' : `lines that changed: ${j(changed.slice(0, 4))}` };
    },
  },
];
