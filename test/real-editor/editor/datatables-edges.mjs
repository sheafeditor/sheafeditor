// View blocks at the edges the public page promises and the first scenarios do not reach:
// numbers sorted as numbers, names compared without case, a `from` that finds nothing, a
// misspelt column, a started row left empty, sorting beside an edit, a comma typed through a
// view, the board's column for blank values, and an absolute path.
//   node test/real-editor/run-editor.mjs datatables-edges [id]
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

const TASKS = '```csv id=tasks\nfeature,status,estimate\nSearch,Open,5\nExport,Done,10\nImport,Open,2\nBilling,,8\n```';

/** What every view on the page shows: its rows as comma-joined cells, and its messages. */
const views = () =>
  [...document.querySelectorAll('.sheaf-view')].map((v) => ({
    rows: [...v.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td:not(.sheaf-view-mark)')].map((td) => td.textContent).join(',')
    ),
    said: [...v.querySelectorAll('.sheaf-view-notes p')].map((p) => p.textContent),
    tables: v.querySelectorAll('table').length,
  }));

/** Each board column as `name:title,title`. */
const board = () =>
  [...document.querySelectorAll('.sheaf-board-col')].map(
    (col) =>
      `${col.querySelector('.sheaf-board-col-name')?.textContent}:${[...col.querySelectorAll('.sheaf-board-title')]
        .map((t) => t.textContent)
        .join(',')}`
  );

/** The error each named block's grid shows, when one is drawn. */
const blockErrors = () =>
  [...document.querySelectorAll('.sheaf-table')].map((t) => {
    const e = t.querySelector('.sheaf-table-error');
    return e && e.getBoundingClientRect().height > 0 ? e.textContent : null;
  });

const PIPE = 'Board plan.\n\n| Item | Phase | Owner |\n| --- | --- | --- |\n| Alpha | Todo | ana |\n| Beta | Doing | bo |\n| Gamma | Todo | cy |\n\nAfter.\n';

/** Show the first pipe table as a board grouped by column `c`, putting a board left by an earlier run back first. */
async function toBoard(S, c) {
  await toTable(S);
  await S.click({ sel: '.sheaf-table-grid td[data-r="0"][data-c="0"]' });
  await S.click({ sel: '.sheaf-table-ctrl[data-cmd="overflow"]' });
  await S.click({ sel: '.sheaf-table-menu-item[data-cmd="table.showAsBoard"]' });
  await S.sleep(300);
  await S.click({ sel: `.sheaf-table-menu-item[data-cmd="table.groupBy.${c}"]` });
  await S.sleep(500);
}

/** Put a pipe table shown as a board back to its grid; the choice outlives a run, so each run cleans up. */
async function toTable(S) {
  if (await S.eval(() => !!document.querySelector('.sheaf-table.is-board'))) {
    await S.click({ sel: '.sheaf-table-ctrl[data-cmd="table.showAsTable"]' });
    await S.sleep(400);
  }
}

export const scenarios = [
  {
    id: 'tables.datatables.edges.e01',
    feature: 'tables.datatables',
    name: 'Sorting a view by a column of numbers puts 2 before 5 before 10, and descending puts 10 first',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nsort: estimate\nshow: feature, estimate\n\`\`\`\n\n\`\`\`view\nfrom: #tasks\nsort: estimate desc\nshow: feature, estimate\n\`\`\`\n`;
      await S.fresh('edges-numeric-sort', text);
      await S.sleep(600);
      const shown = await S.eval(views);
      const asc = shown[0]?.rows ?? [];
      const desc = shown[1]?.rows ?? [];
      const ok = j(asc) === j(['Import,2', 'Search,5', 'Billing,8', 'Export,10']) && j(desc) === j(['Export,10', 'Billing,8', 'Search,5', 'Import,2']);
      return { ok, detail: `ascending ${j(asc)}; descending ${j(desc)}${ok ? '' : ` (a text sort would read ${j(['Export,10', 'Import,2', 'Search,5', 'Billing,8'])})`}` };
    },
  },
  {
    id: 'tables.datatables.edges.e02',
    feature: 'tables.datatables',
    name: 'Two blocks named Tasks and tasks count as the same name, and both say so',
    run: async (S) => {
      const text = 'Plan.\n\n```csv id=Tasks\na,b\n1,2\n```\n\n```csv id=tasks\na,b\n3,4\n```\n';
      await S.fresh('edges-duplicate-case', text);
      await S.sleep(600);
      const seen = await S.eval(blockErrors);
      // Names are compared without case, so each block names the other's spelling or its own.
      const ok = seen.length === 2 && seen.every((e) => e && /also named "tasks"/i.test(e));
      return { ok, detail: j(seen) };
    },
  },
  {
    id: 'tables.datatables.edges.e03',
    feature: 'tables.datatables',
    name: 'A view of a name no block has says which name it looked for, and draws no table',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #taks\n\`\`\`\n`;
      await S.fresh('edges-missing-name', text);
      await S.sleep(600);
      const shown = await S.eval(views);
      const v = shown[0];
      const ok = !!v && v.rows.length === 0 && v.tables === 0 && v.said.some((s) => s.includes('"taks"'));
      return { ok, detail: j(shown) };
    },
  },
  {
    id: 'tables.datatables.edges.e04',
    feature: 'tables.datatables',
    name: 'A misspelt sort column is named on the view, and the where on the next line still keeps only its rows',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nsort: estimat\nwhere: status = Open\n\`\`\`\n`;
      await S.fresh('edges-misspelt-sort', text);
      await S.sleep(600);
      const shown = await S.eval(views);
      const v = shown[0];
      const kept = v ? v.rows.map((r) => r.split(',')[0]).sort() : [];
      const ok = !!v && v.said.some((s) => s.includes('estimat')) && j(kept) === j(['Import', 'Search']);
      return { ok, detail: j(shown) };
    },
  },
  {
    id: 'tables.datatables.edges.e05',
    feature: 'tables.datatables',
    name: 'Starting a new row in a view and leaving it empty writes nothing to the block',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nwhere: status = Open\n\`\`\`\n\nAfter.\n`;
      await S.fresh('edges-empty-new-row', text);
      await S.sleep(600);
      await S.click({ sel: '.sheaf-view-add' });
      await S.sleep(200);
      await S.press('Escape');
      await S.sleep(200);
      await S.click({ sel: '.sheaf-view-add' });
      await S.sleep(200);
      await S.caret('After', 2);
      await S.sleep(500);
      const disk = await S.disk();
      return { ok: disk === text, detail: disk === text ? 'file unchanged after Escape and after clicking away' : `file changed to ${j(disk)}` };
    },
  },
  {
    id: 'tables.datatables.edges.e06',
    feature: 'tables.datatables',
    name: 'Editing a cell in a view sorted descending changes that one field, and the block keeps its own row order',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nsort: estimate desc\n\`\`\`\n`;
      await S.fresh('edges-sorted-edit', text);
      await S.sleep(600);
      // Import is source row 2; its feature cell is column 0.
      await S.dblclick({ sel: '.sheaf-view tr[data-row="2"] td[data-c="0"]' });
      await S.sleep(200);
      await S.type('Imports');
      await S.press('Enter');
      await S.sleep(400);
      const disk = await S.disk();
      const want = text.replace('Import,Open,2', 'Imports,Open,2');
      return { ok: disk === want, detail: disk === want ? 'one field changed, block order kept' : `file ${j(disk)}` };
    },
  },
  {
    id: 'tables.datatables.edges.e07',
    feature: 'tables.datatables',
    name: 'A comma typed into a cell through a view is written quoted, so the record keeps its three fields',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\n\`\`\`\n`;
      await S.fresh('edges-comma-edit', text);
      await S.sleep(600);
      await S.dblclick({ sel: '.sheaf-view tr[data-row="0"] td[data-c="0"]' });
      await S.sleep(200);
      await S.type('Search, fast');
      await S.press('Enter');
      await S.sleep(400);
      const disk = await S.disk();
      const want = text.replace('Search,Open,5', '"Search, fast",Open,5');
      return { ok: disk === want, detail: disk === want ? 'written quoted' : `file ${j(disk)}` };
    },
  },
  {
    id: 'tables.datatables.edges.e08',
    feature: 'tables.datatables',
    name: 'A board puts rows with no status in a last No status column, and moving a card there empties its status',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nlayout: board\ngroup: status\n\`\`\`\n`;
      await S.fresh('edges-board-blank', text);
      await S.sleep(600);
      const before = await S.eval(board);
      await S.drag({ sel: '.sheaf-board-card[data-row="0"]' }, { sel: '.sheaf-board-col[data-value=""] .sheaf-board-col-head' });
      await S.sleep(400);
      const after = await S.eval(board);
      const disk = await S.disk();
      const want = text.replace('Search,Open,5', 'Search,,5');
      const ok =
        j(before) === j(['Open:Search,Import', 'Done:Export', 'No status:Billing']) &&
        j(after) === j(['Open:Import', 'Done:Export', 'No status:Search,Billing']) &&
        disk === want;
      return { ok, detail: `before ${j(before)}; after ${j(after)}; disk ${disk === want ? 'as wanted' : j(disk)}` };
    },
  },
  {
    id: 'tables.datatables.edges.e09',
    feature: 'tables.datatables',
    name: 'A view whose from is an absolute path is refused with a note to name the file relative to the document',
    run: async (S) => {
      const text = 'Plan.\n\n```view\nfrom: /tmp/tasks.csv\n```\n';
      await S.fresh('edges-absolute', text);
      await S.sleep(900);
      const shown = await S.eval(views);
      const v = shown[0];
      const ok = !!v && v.tables === 0 && v.said.some((s) => s.includes('absolute path'));
      return { ok, detail: j(shown) };
    },
  },
  {
    id: 'tables.datatables.edges.e10',
    feature: 'tables.datatables',
    name: 'Move to file when a file of that name is already there writes the next free name and leaves the old file as it was',
    run: async (S) => {
      const dir = join(S.ws, 'e2e');
      mkdirSync(dir, { recursive: true });
      const taken = join(dir, 'move-taken.csv');
      const next = join(dir, 'move-taken-2.csv');
      const old = 'keep,me\n1,2\n';
      rmSync(next, { force: true });
      writeFileSync(taken, old);
      const block = '```csv id=move-taken\nfeature,status\nSearch,Open\n```';
      const text = `Plan.\n\n${block}\n`;
      await S.fresh('edges-move-taken', text);
      await S.sleep(500);
      await S.rightClick({ sel: '.sheaf-table [data-r="0"][data-c="0"]' });
      await S.sleep(200);
      await S.menu('Move to file');
      await S.sleep(1200);
      const disk = await S.disk();
      const oldNow = readFileSync(taken, 'utf8');
      const nextNow = existsSync(next) ? readFileSync(next, 'utf8') : null;
      rmSync(next, { force: true });
      rmSync(taken, { force: true });
      const ok = oldNow === old && nextNow === 'feature,status\nSearch,Open\n' && disk.includes('from: move-taken-2.csv');
      return { ok, detail: `old file ${oldNow === old ? 'unchanged' : j(oldNow)}; new file ${j(nextNow)}; document ${j(disk)}` };
    },
  },
  {
    id: 'tables.datatables.edges.e11',
    feature: 'tables.datatables',
    name: 'A view inside a list item draws, and sorting it from its header writes the sort line with the item\'s indent',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n- Open work:\n\n  \`\`\`view\n  from: #tasks\n  where: status = Open\n  \`\`\`\n\nAfter.\n`;
      await S.fresh('edges-view-in-list', text);
      await S.sleep(600);
      const before = await S.eval(views);
      await S.click({ sel: '.sheaf-view th[data-c="2"] .sheaf-view-sort' });
      await S.sleep(300);
      const disk = await S.disk();
      const want = text.replace('  where: status = Open\n', '  where: status = Open\n  sort: estimate\n');
      const ok = before.length === 1 && before[0].rows.length === 2 && disk === want;
      return { ok, detail: `before ${j(before)}; disk ${disk === want ? 'as wanted' : j(disk)}` };
    },
  },
  {
    id: 'tables.datatables.edges.e12',
    feature: 'tables.datatables',
    name: 'Moving a card on a pipe-table board is undone by one Cmd+Z, and the file is back byte for byte',
    run: async (S) => {
      const text = PIPE;
      await S.fresh('edges-pipe-board-undo', text);
      await S.sleep(800);
      await toBoard(S, 1);
      const before = await S.eval(board);
      await S.drag({ sel: '.sheaf-board-card[data-row="2"]' }, { sel: '.sheaf-board-col[data-value="Doing"] .sheaf-board-col-head' });
      await S.sleep(500);
      const moved = await S.disk();
      await S.press('Meta+z');
      await S.sleep(500);
      const undone = await S.disk();
      const after = await S.eval(board);
      await toTable(S);
      const ok = moved === text.replace('| Gamma | Todo | cy |', '| Gamma | Doing | cy |') && undone === text && j(after) === j(before);
      return { ok, detail: `moved ${moved === text ? 'nothing' : 'one cell'}; after Cmd+Z ${undone === text ? 'back as it was' : j(undone)}; board ${j(before)} -> ${j(after)}` };
    },
  },
  {
    id: 'tables.datatables.edges.e13',
    feature: 'tables.datatables',
    name: 'When the column a pipe-table board is grouped by goes from the file, the table is a grid again with a note saying why',
    run: async (S) => {
      const text = PIPE;
      const path = await S.fresh('edges-pipe-board-gone', text);
      await S.sleep(800);
      await toBoard(S, 1);
      const wasBoard = await S.eval(() => !!document.querySelector('.sheaf-table.is-board'));
      // Another tool rewrites the table without its Phase column.
      writeFileSync(path, 'Board plan.\n\n| Item | Owner |\n| --- | --- |\n| Alpha | ana |\n| Beta | bo |\n| Gamma | cy |\n\nAfter.\n');
      await S.sleep(2500);
      const seen = await S.eval(() => {
        const note = document.querySelector('.sheaf-table-board-note');
        return {
          board: !!document.querySelector('.sheaf-table.is-board'),
          grid: !!document.querySelector('.sheaf-table-grid table'),
          note: note && !note.hidden ? note.textContent : null,
        };
      });
      await toTable(S);
      const ok = wasBoard && !seen.board && seen.grid && !!seen.note && seen.note.includes('Phase');
      return { ok, detail: `a board first ${wasBoard}; after the column went ${j(seen)}` };
    },
  },
];
