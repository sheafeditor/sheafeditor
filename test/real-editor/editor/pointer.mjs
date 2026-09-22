// Click scenarios for selecting with the mouse and for tables that stay grids, in real VS Code with default settings:
//   prose.mouse-selection  double-click selects the word; triple-click selects the paragraph's text, up to its last
//                          character and not the line break after it, and the highlight covers only that text
//   tables.stays-grid      a table is only ever edited as a grid: entering edit mode near it never shows its raw Markdown
//   node test/real-editor/run-editor.mjs pointer [id]
const j = (x) => JSON.stringify(x);

const selected = (S) =>
  S.eval(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view;
    const r = v.state.selection.main;
    return v.state.sliceDoc(r.from, r.to);
  });

async function open(S, name, text) {
  const sb = await S.page.locator('.statusbar').boundingBox().catch(() => null);
  if (sb) await S.page.mouse.click(sb.x + 10, sb.y + sb.height / 2);
  await S.page.keyboard.press('Escape');
  const path = await S.fresh(name, text);
  await S.sleep(400);
  return path;
}

/** Double-click `text` at `offset`, then report the selected text; optionally type over it. */
function wordCase(id, name, doc, text, offset, want) {
  return {
    id: `prose.mouse-selection.${id}`,
    feature: 'prose.mouse-selection',
    name,
    run: async (S) => {
      await open(S, `ms-${id}`, doc);
      await S.dblclick({ text, offset });
      await S.sleep(300);
      const sel = await selected(S);
      return { ok: sel === want, detail: `selected ${j(sel)}, want ${j(want)}` };
    },
  };
}

/** Triple-click `text` at `offset` and report the selection, which must end at the paragraph's last character. */
function paraCase(id, name, doc, text, offset, want) {
  return {
    id: `prose.mouse-selection.${id}`,
    feature: 'prose.mouse-selection',
    name,
    run: async (S) => {
      await open(S, `ms-${id}`, doc);
      await S.click({ text, offset }, { count: 3 });
      await S.sleep(300);
      const sel = await selected(S);
      return { ok: sel === want, detail: `selected ${j(sel)}, want ${j(want)}` };
    },
  };
}

const TABLE = '| Fruit | Qty |\n| ----- | --- |\n| apple | 3   |\n| kiwi  | 12  |';
const DOC = `Intro paragraph here.\n\n${TABLE}\n\nAfter line\n`;

const tableState = (S) =>
  S.eval(() => ({
    grids: document.querySelectorAll('.sheaf-table').length,
    rawPipeLines: [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).filter((t) => /^\s*\|.*\|\s*$/.test(t)).length,
  }));
const stillGrid = (s) => s.grids === 1 && s.rawPipeLines === 0;

/** Open `doc`, confirm the table starts as a grid, run `act`, then check the table is still a grid and the file unchanged unless `typed`. */
function gridCase(id, name, act, { doc = DOC, fileCheck = (d) => d === doc } = {}) {
  return {
    id: `tables.stays-grid.${id}`,
    feature: 'tables.stays-grid',
    name,
    run: async (S) => {
      await open(S, `sg-${id}`, doc);
      const before = await tableState(S);
      const note = (await act(S)) || '';
      await S.sleep(500);
      const after = await tableState(S);
      const d = await S.disk();
      await S.shot(`tables.stays-grid.${id}`);
      return { ok: stillGrid(before) && stillGrid(after) && fileCheck(d), detail: `before ${j(before)}; after ${j(after)} ${note}; file ${j(d)}` };
    },
  };
}

/** Window coordinates of a point given in the Sheaf frame, using a located element as the reference. */
async function frameToWindow(S, frameRectOf) {
  const ref = await S.locate({ sel: '.sheaf-table [data-r="0"][data-c="0"]' });
  const rects = await S.eval(frameRectOf);
  return { dx: ref.x - (rects.ref.left + rects.ref.width / 2), dy: ref.y - (rects.ref.top + rects.ref.height / 2), rects };
}

export const scenarios = [
  wordCase('e01', 'Double-clicking a plain word selects that word', 'Say hello to the world.\n\nNext.\n', 'hello', 2, 'hello'),
  wordCase('e02', 'Double-clicking a bold word selects the word, without its asterisks', 'Some **bold** text here.\n\nNext.\n', 'bold', 2, 'bold'),
  wordCase('e03', 'Double-clicking a word of link text selects that word', 'Go to [the site](https://x.io) now.\n\nNext.\n', 'site', 2, 'site'),
  wordCase('e04', 'Double-clicking a word in a heading selects that word', '## Heading two\n\nBody text.\n', 'Heading', 3, 'Heading'),
  wordCase('e05', 'Double-clicking a word in a bullet item selects that word', '- one task here\n- two\n\nAfter.\n', 'task', 2, 'task'),
  {
    id: 'prose.mouse-selection.e06',
    feature: 'prose.mouse-selection',
    name: 'Double-clicking a word and typing replaces just that word',
    run: async (S) => {
      const doc = 'Say hello to the world.\n\nNext.\n';
      await open(S, 'ms-e06', doc);
      await S.dblclick({ text: 'hello', offset: 2 });
      await S.sleep(300);
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'Say Z to the world.\n\nNext.\n', detail: j(d) };
    },
  },
  paraCase('e07', 'Triple-clicking a one-line paragraph selects the whole paragraph', 'Before.\n\nSay hello to the whole wide world.\n\nNext para.\n', 'whole', 2, 'Say hello to the whole wide world.'),
  paraCase(
    'e08',
    'Triple-clicking a long paragraph that wraps on screen selects all of it, not one screen line',
    `Before.\n\n${'This sentence repeats to make one long paragraph. '.repeat(8).trim()}\n\nNext para.\n`,
    'long paragraph',
    3,
    'This sentence repeats to make one long paragraph. '.repeat(8).trim()
  ),
  paraCase('e09', 'Triple-clicking a paragraph written over two source lines selects both lines', 'Before.\n\nFirst line of para\nsecond line of para\n\nNext para.\n', 'second', 2, 'First line of para\nsecond line of para'),
  paraCase('e10', 'Triple-clicking a bullet item selects that item text', '- one item here\n- two item\n\nAfter.\n', 'one', 1, 'one item here'),
  {
    id: 'prose.mouse-selection.e13',
    feature: 'prose.mouse-selection',
    name: 'Three separate clicks, as a person makes them, leave the paragraph selected and keep it selected',
    run: async (S) => {
      // One synthetic click carrying clickCount 3 does not reproduce what a person does: it skips the
      // first two clicks, so no word selection is made and nothing is there to overwrite the paragraph.
      const doc = 'Before.\n\nSay hello to the whole wide world.\n\nNext para.\n';
      const want = 'Say hello to the whole wide world.';
      const tries = [];
      for (const gap of [60, 120, 200]) {
        await open(S, `ms-e13-${gap}`, doc);
        const p = await S.click({ text: 'whole', offset: 2 });
        await S.sleep(300);
        await S.page.mouse.move(p.x, p.y);
        for (let i = 0; i < 3; i++) {
          await S.page.mouse.down({ clickCount: i + 1 });
          await S.page.mouse.up({ clickCount: i + 1 });
          if (i < 2) await S.sleep(gap);
        }
        await S.sleep(500);
        tries.push({ gap, sel: await selected(S) });
      }
      const bad = tries.filter((t) => t.sel !== want);
      return { ok: bad.length === 0, detail: tries.map((t) => `${t.gap}ms: ${j(t.sel)}`).join('; ') };
    },
  },
  {
    id: 'prose.mouse-selection.e12',
    feature: 'prose.mouse-selection',
    name: 'The highlight of a triple-clicked paragraph covers only its text: nothing in the margins and nothing on the line below',
    run: async (S) => {
      const para = 'This sentence repeats to make one long paragraph. '.repeat(8).trim();
      await open(S, 'ms-e12', `Before.\n\n${para}\n\nNext para.\n`);
      await S.click({ text: 'long paragraph', offset: 3 }, { count: 3 });
      await S.sleep(400);
      const m = await S.eval((para) => {
        const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent === para);
        const range = document.createRange();
        range.selectNodeContents(line);
        // One box per screen line of the paragraph's text.
        const rows = [];
        for (const r of range.getClientRects()) {
          if (r.width < 1) continue;
          const row = rows.find((x) => Math.abs(x.top - r.top) < 3);
          if (row) { row.left = Math.min(row.left, r.left); row.right = Math.max(row.right, r.right); row.bottom = Math.max(row.bottom, r.bottom); }
          else rows.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        }
        const marks = [...document.querySelectorAll('.cm-selectionBackground')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
        const pad = 3;
        const outside = [];
        for (const r of marks) {
          const midY = r.top + r.height / 2;
          const inRows = rows.filter((x) => x.bottom > r.top + 1 && x.top < r.bottom - 1);
          if (!inRows.length) { outside.push({ where: 'off the text rows', top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }); continue; }
          const left = Math.min(...inRows.map((x) => x.left));
          const right = Math.max(...inRows.map((x) => x.right));
          if (r.left < left - pad) outside.push({ where: 'left margin', by: Math.round(left - r.left), midY: Math.round(midY) });
          if (r.right > right + pad) outside.push({ where: 'right margin', by: Math.round(r.right - right), midY: Math.round(midY) });
        }
        return { rows: rows.length, marks: marks.length, outside };
      }, para);
      return { ok: m.rows > 1 && m.marks > 0 && m.outside.length === 0, detail: `${m.rows} screen lines of text, ${m.marks} highlight boxes; outside the text: ${j(m.outside)}` };
    },
  },
  {
    id: 'prose.mouse-selection.e11',
    feature: 'prose.mouse-selection',
    name: 'Triple-clicking a paragraph and typing replaces the paragraph and leaves its neighbours alone',
    run: async (S) => {
      const doc = 'Before.\n\nSay hello to the whole wide world.\n\nNext para.\n';
      await open(S, 'ms-e11', doc);
      await S.click({ text: 'whole', offset: 2 }, { count: 3 });
      await S.sleep(300);
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'Before.\n\nZ\n\nNext para.\n', detail: j(d) };
    },
  },

  gridCase('e01', 'Double-clicking the paragraph above a table leaves the table a grid', async (S) => {
    await S.dblclick({ text: 'paragraph', offset: 2 });
  }),
  gridCase('e02', 'Double-clicking the paragraph below a table leaves the table a grid', async (S) => {
    await S.dblclick({ text: 'After line', offset: 2 });
  }),
  gridCase('e03', 'Double-clicking the blank line just below a table leaves the table a grid', async (S) => {
    const { dx, dy, rects } = await frameToWindow(S, () => {
      const r = (el) => el.getBoundingClientRect().toJSON();
      const after = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent === 'After line');
      return { ref: r(document.querySelector('.sheaf-table [data-r="0"][data-c="0"]')), table: r(document.querySelector('.sheaf-table')), after: r(after) };
    });
    const x = rects.after.left + 30 + dx;
    const y = (rects.table.bottom + rects.after.top) / 2 + dy;
    await S.page.mouse.click(x, y, { clickCount: 2 });
    return `double-clicked at ${Math.round(x)},${Math.round(y)}`;
  }),
  gridCase('e04', 'Double-clicking the page margin level with a table row leaves the table a grid', async (S) => {
    const { dx, dy, rects } = await frameToWindow(S, () => {
      const r = (el) => el.getBoundingClientRect().toJSON();
      return { ref: r(document.querySelector('.sheaf-table [data-r="0"][data-c="0"]')), row: r(document.querySelector('.sheaf-table [data-r="1"][data-c="0"]')), content: r(document.querySelector('.cm-content')) };
    });
    const x = rects.content.left + 2 + dx;
    const y = rects.row.top + rects.row.height / 2 + dy;
    await S.page.mouse.click(x, y, { clickCount: 2 });
    return `double-clicked at ${Math.round(x)},${Math.round(y)}`;
  }),
  gridCase('e05', 'Double-clicking just right of a table, level with a row, leaves the table a grid', async (S) => {
    const { dx, dy, rects } = await frameToWindow(S, () => {
      const r = (el) => el.getBoundingClientRect().toJSON();
      return { ref: r(document.querySelector('.sheaf-table [data-r="0"][data-c="0"]')), grid: r(document.querySelector('.sheaf-table-grid')), row: r(document.querySelector('.sheaf-table [data-r="1"][data-c="0"]')), content: r(document.querySelector('.cm-content')) };
    });
    const x = Math.min(rects.grid.right + 40, rects.content.right - 10) + dx;
    const y = rects.row.top + rects.row.height / 2 + dy;
    await S.page.mouse.click(x, y, { clickCount: 2 });
    return `double-clicked at ${Math.round(x)},${Math.round(y)}`;
  }),
  gridCase('e06', 'Triple-clicking the paragraph above a table leaves the table a grid', async (S) => {
    await S.click({ text: 'paragraph', offset: 2 }, { count: 3 });
  }),
  gridCase(
    'e07',
    'Double-clicking the paragraph above a table, pressing End, typing and pressing Enter leaves the table a grid',
    async (S) => {
      await S.dblclick({ text: 'paragraph', offset: 2 });
      await S.press('End');
      await S.type('X');
      await S.press('Enter');
      await S.type('Y');
    },
    { fileCheck: (d) => d.startsWith('Intro paragraph here.X\nY') }
  ),
  gridCase('e08', 'Clicking the end of the paragraph above a table and pressing Down onto the blank line leaves the table a grid', async (S) => {
    await S.caret('here.', 5);
    await S.press('ArrowDown');
  }),
  gridCase(
    'e09',
    'With no blank line between a paragraph and its table, double-clicking the paragraph leaves the table a grid',
    async (S) => {
      await S.dblclick({ text: 'paragraph', offset: 2 });
    },
    { doc: `Intro paragraph here.\n${TABLE}\n\nAfter line\n`, fileCheck: (d) => d === `Intro paragraph here.\n${TABLE}\n\nAfter line\n` }
  ),
];
