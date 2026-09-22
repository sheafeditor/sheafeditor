// Multi-click gestures driven the way a person makes them: separate presses with a real gap between
// them, repeated at several gaps, and read again once everything has settled. A single synthetic click
// carrying a click count proves the handler and hides every race around it.
//   node test/real-editor/run-editor.mjs gesture-races [id]
const j = (x) => JSON.stringify(x);
const GAPS = [60, 120, 200];

const selected = (S) =>
  S.eval(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view;
    const r = v.state.selection.main;
    return v.state.sliceDoc(r.from, r.to);
  });

/** Click `n` times at one point, as separate presses `gap` ms apart. */
async function realClicks(S, p, n, gap) {
  await S.page.mouse.move(p.x, p.y);
  for (let i = 0; i < n; i++) {
    await S.page.mouse.down({ clickCount: i + 1 });
    await S.page.mouse.up({ clickCount: i + 1 });
    if (i < n - 1) await S.sleep(gap);
  }
  await S.sleep(500);
}

async function open(S, name, text) {
  await S.page.keyboard.press('Escape');
  await S.fresh(name, text);
  await S.sleep(400);
}

/**
 * Repeat one gesture at every gap and report each result, so an intermittent loss shows up as one
 * bad gap rather than a pass. `read` returns what a person would judge it by.
 */
function races(id, name, { doc, at, clicks, read = selected, want }) {
  return {
    id: `prose.gesture-races.${id}`,
    feature: 'prose.gesture-races',
    name,
    run: async (S) => {
      const tries = [];
      for (const gap of GAPS) {
        await open(S, `race-${id}-${gap}`, doc);
        const p = await S.click(at);
        await S.sleep(300);
        await realClicks(S, p, clicks, gap);
        tries.push({ gap, got: await read(S) });
      }
      const bad = tries.filter((t) => t.got !== want);
      return { ok: bad.length === 0, detail: `${tries.map((t) => `${t.gap}ms: ${j(t.got)}`).join('; ')}${bad.length ? ` | want ${j(want)}` : ''}` };
    },
  };
}

const PARA = 'Before.\n\nSay hello to the whole wide world.\n\nNext para.\n';
const MARKS = 'Before.\n\nA **bold word** and a [link text](https://example.com) here.\n\nAfter.\n';
const LIST = 'Before.\n\n- one item here\n- two item\n\nAfter.\n';
const HEAD = '# A heading here\n\nBody text.\n';
const QUOTE = 'Before.\n\n> A quoted line here.\n\nAfter.\n';
const TABLE = 'Intro.\n\n| Fruit | Qty |\n| ----- | --- |\n| apple | 3   |\n| kiwi  | 12  |\n\nAfter line\n';

export const scenarios = [
  races('double-plain', 'Double-clicking a plain word keeps that word selected', {
    doc: PARA, at: { text: 'whole', offset: 2 }, clicks: 2, want: 'whole',
  }),
  races('double-bold', 'Double-clicking a bold word keeps the word selected, without its asterisks', {
    doc: MARKS, at: { text: 'bold', offset: 2 }, clicks: 2, want: 'bold',
  }),
  races('double-link', 'Double-clicking a word of link text keeps that word selected', {
    doc: MARKS, at: { text: 'link text', offset: 2 }, clicks: 2, want: 'link',
  }),
  races('double-heading', 'Double-clicking a word in a heading keeps that word selected', {
    doc: HEAD, at: { text: 'heading', offset: 3 }, clicks: 2, want: 'heading',
  }),
  races('double-list', 'Double-clicking a word in a bullet item keeps that word selected', {
    doc: LIST, at: { text: 'item', offset: 2, occurrence: 0 }, clicks: 2, want: 'item',
  }),
  races('triple-para', 'Triple-clicking a paragraph keeps the paragraph selected', {
    doc: PARA, at: { text: 'whole', offset: 2 }, clicks: 3, want: 'Say hello to the whole wide world.',
  }),
  races('triple-list', 'Triple-clicking a bullet item keeps the item text selected', {
    doc: LIST, at: { text: 'one item', offset: 2 }, clicks: 3, want: 'one item here',
  }),
  races('triple-heading', 'Triple-clicking a heading keeps the heading text selected', {
    doc: HEAD, at: { text: 'heading', offset: 3 }, clicks: 3, want: 'A heading here',
  }),
  races('triple-quote', 'Triple-clicking a quoted line keeps the quoted text selected', {
    doc: QUOTE, at: { text: 'quoted', offset: 2 }, clicks: 3, want: 'A quoted line here.',
  }),
  races('double-cell', 'Double-clicking a table cell leaves it open for editing with its value selected', {
    doc: TABLE,
    at: { sel: '.sheaf-table [data-r="0"][data-c="0"]' },
    clicks: 2,
    read: (S) => S.eval(() => {
      // A CSV field is a text box; a Markdown cell is a nested editor. Read whichever is open,
      // and report the selection so "with its value selected" is checked, not assumed.
      const box = document.querySelector('.sheaf-table input, .sheaf-table textarea');
      if (box) return `editing ${JSON.stringify(box.value)}${box.selectionStart === 0 && box.selectionEnd === box.value.length ? '' : ' (not all selected)'}`;
      const content = document.querySelector('.sheaf-table .sheaf-table-input .cm-content');
      const tile = content && (content.cmTile || content.cmView);
      const view = tile?.root?.view ?? tile?.view;
      if (!view) return content ? 'editor with no view' : 'no editor';
      const doc = view.state.doc.toString();
      const { from, to } = view.state.selection.main;
      return `editing ${JSON.stringify(doc)}${from === 0 && to === doc.length ? '' : ` (selected ${from}-${to})`}`;
    }),
    want: 'editing "apple"',
  }),
  races('single-cell', 'A single click on a table cell leaves that cell selected and no editor open', {
    doc: TABLE,
    at: { sel: '.sheaf-table [data-r="1"][data-c="1"]' },
    clicks: 1,
    read: (S) => S.eval(() => {
      const t = document.querySelector('.sheaf-table');
      const sel = [...t.querySelectorAll('.is-sel')].map((el) => `${el.dataset.r},${el.dataset.c}`);
      return `${sel.join(' ')}${t.querySelector('input, textarea, .sheaf-table-input') ? ' editing' : ''}`;
    }),
    want: '1,1',
  }),
  {
    id: 'prose.gesture-races.drag-then-wait',
    feature: 'prose.gesture-races',
    name: 'A dragged text selection is still there half a second later',
    run: async (S) => {
      const tries = [];
      for (const gap of GAPS) {
        await open(S, `race-drag-${gap}`, PARA);
        await S.select('hello to the whole');
        await S.sleep(gap);
        const now = await selected(S);
        await S.sleep(600);
        tries.push({ gap, got: `${now}|${await selected(S)}` });
      }
      const want = 'hello to the whole|hello to the whole';
      const bad = tries.filter((t) => t.got !== want);
      return { ok: bad.length === 0, detail: tries.map((t) => `${t.gap}ms: ${j(t.got)}`).join('; ') };
    },
  },
  {
    id: 'prose.gesture-races.double-then-type',
    feature: 'prose.gesture-races',
    name: 'Double-clicking a word and typing replaces that word, not the text around it',
    run: async (S) => {
      const tries = [];
      for (const gap of GAPS) {
        await open(S, `race-dtype-${gap}`, PARA);
        const p = await S.click({ text: 'whole', offset: 2 });
        await S.sleep(300);
        await realClicks(S, p, 2, gap);
        await S.type('Z');
        tries.push({ gap, got: await S.disk() });
      }
      const want = 'Before.\n\nSay hello to the Z wide world.\n\nNext para.\n';
      const bad = tries.filter((t) => t.got !== want);
      return { ok: bad.length === 0, detail: tries.map((t) => `${t.gap}ms: ${j(t.got)}`).join('; ') };
    },
  },
  {
    id: 'prose.gesture-races.triple-then-type',
    feature: 'prose.gesture-races',
    name: 'Triple-clicking a paragraph and typing replaces the paragraph',
    run: async (S) => {
      const tries = [];
      for (const gap of GAPS) {
        await open(S, `race-ttype-${gap}`, PARA);
        const p = await S.click({ text: 'whole', offset: 2 });
        await S.sleep(300);
        await realClicks(S, p, 3, gap);
        await S.type('Z');
        tries.push({ gap, got: await S.disk() });
      }
      const want = 'Before.\n\nZ\n\nNext para.\n';
      const bad = tries.filter((t) => t.got !== want);
      return { ok: bad.length === 0, detail: tries.map((t) => `${t.gap}ms: ${j(t.got)}`).join('; ') };
    },
  },
];
