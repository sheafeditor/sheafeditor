// Named CSV blocks and view blocks, in real VS Code.
//
// The tables suite drives the view's drawing and its writes under jsdom, and the host suite
// drives the file reading and watching against a stand-in window. This asks the real window
// whether a person sees the rows a view keeps, whether a view of a file follows the file when
// something else writes it, and whether reading a view leaves every file as it was.
//   node test/real-editor/run-editor.mjs datatables [id]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

const TASKS = '```csv id=tasks\nfeature,status,estimate\nSearch,Open,5\nExport,Done,2\nImport,Open,8\n```';

/** What every view on the page shows: its rows as comma-joined cells, and its messages. */
const views = () =>
  [...document.querySelectorAll('.sheaf-view')].map((v) => ({
    rows: [...v.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td:not(.sheaf-view-mark)')].map((td) => td.textContent).join(',')
    ),
    said: [...v.querySelectorAll('.sheaf-view-notes p')].map((p) => p.textContent),
  }));

export const scenarios = [
  {
    id: 'tables.datatables.e01',
    feature: 'tables.datatables',
    name: 'A named CSV block shows its name above the grid, and a view of it shows only the rows its where keeps, sorted',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nwhere: status = Open\nsort: estimate desc\n\`\`\`\n`;
      await S.fresh('view-named', text);
      await S.sleep(500);
      const seen = await S.eval(() => ({
        name: document.querySelector('.sheaf-table .sheaf-table-id')?.textContent ?? null,
        nameVisible: (() => {
          const el = document.querySelector('.sheaf-table .sheaf-table-id');
          return !!el && el.getBoundingClientRect().height > 0;
        })(),
      }));
      const shown = await S.eval(views);
      const disk = await S.disk();
      const ok =
        seen.name === '#tasks' &&
        seen.nameVisible &&
        j(shown) === j([{ rows: ['Import,Open,8', 'Search,Open,5'], said: [] }]) &&
        disk === text;
      return { ok, detail: `name ${j(seen)}; views ${j(shown)}; disk changed: ${disk !== text}` };
    },
  },
  {
    id: 'tables.datatables.e02',
    feature: 'tables.datatables',
    name: 'Two CSV blocks with the same name both say so',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n${TASKS.replace('Search', 'Other')}\n`;
      await S.fresh('view-duplicate', text);
      await S.sleep(500);
      const errors = await S.eval(() =>
        [...document.querySelectorAll('.sheaf-table')].map((t) => {
          const e = t.querySelector('.sheaf-table-error');
          return e && e.getBoundingClientRect().height > 0 ? e.textContent : null;
        })
      );
      return { ok: errors.length === 2 && errors.every((e) => e && e.includes('also named "tasks"')), detail: j(errors) };
    },
  },
  {
    id: 'tables.datatables.e03',
    feature: 'tables.datatables',
    name: 'A view of a .csv file beside the document shows its rows, and redraws when another program rewrites the file',
    run: async (S) => {
      mkdirSync(join(S.ws, 'e2e', 'data'), { recursive: true });
      const csv = join(S.ws, 'e2e', 'data', 'view-tasks.csv');
      writeFileSync(csv, 'feature,status\nSearch,Open\nExport,Done\n');
      const text = 'Plan.\n\n```view\nfrom: data/view-tasks.csv\nwhere: status = Open\n```\n';
      await S.fresh('view-file', text);
      await S.sleep(800);
      const before = await S.eval(views);
      writeFileSync(csv, 'feature,status\nSearch,Open\nExport,Open\n');
      await S.sleep(1500);
      const after = await S.eval(views);
      const disk = await S.disk();
      const ok =
        j(before) === j([{ rows: ['Search,Open'], said: [] }]) &&
        j(after) === j([{ rows: ['Search,Open', 'Export,Open'], said: [] }]) &&
        disk === text;
      return { ok, detail: `before ${j(before)}; after ${j(after)}` };
    },
  },
  {
    id: 'tables.datatables.e04',
    feature: 'tables.datatables',
    name: 'A view naming a file that is not there, or one outside the workspace, says so in place and draws no table',
    run: async (S) => {
      const text = 'Plan.\n\n```view\nfrom: data/missing.csv\n```\n\n```view\nfrom: ../../outside.csv\n```\n';
      await S.fresh('view-missing', text);
      await S.sleep(800);
      const shown = await S.eval(views);
      const ok =
        shown.length === 2 &&
        shown[0].rows.length === 0 &&
        shown[0].said.some((s) => s.includes('data/missing.csv was not found')) &&
        shown[1].said.some((s) => s.includes('outside this workspace') || s.includes("outside this document's folder"));
      return { ok, detail: j(shown) };
    },
  },
  {
    id: 'tables.datatables.e05',
    feature: 'tables.datatables',
    name: 'Double-clicking a cell in a view and typing writes that one field in the named block, and the row that no longer matches stays, set apart',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nwhere: status = Open\n\`\`\`\n`;
      await S.fresh('view-edit-block', text);
      await S.sleep(500);
      // Search is source row 0; its status is column 1.
      await S.dblclick({ sel: '.sheaf-view tr[data-row="0"] td[data-c="1"]' });
      await S.sleep(200);
      // The cell opens with its text selected, so typing replaces it.
      await S.type('Done');
      await S.press('Enter');
      await S.sleep(300);
      const seen = await S.eval(() => ({
        rows: [...document.querySelectorAll('.sheaf-view tbody tr')].map((tr) => ({
          cells: [...tr.querySelectorAll('td')].map((td) => td.textContent).join(','),
          unmatched: tr.classList.contains('is-unmatched'),
        })),
        note: document.querySelector('.sheaf-view .sheaf-view-note')?.textContent ?? '',
        // The block's own grid shows the new value too.
        grid: [...document.querySelectorAll('.sheaf-table tbody tr')].map((tr) =>
          [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()).filter(Boolean).join(',')
        ),
      }));
      const disk = await S.disk();
      const want = text.replace('Search,Open,5', 'Search,Done,5');
      const ok =
        disk === want &&
        seen.rows.length === 2 &&
        seen.rows[0].cells === 'Search,Done,5' &&
        seen.rows[0].unmatched &&
        !seen.rows[1].unmatched &&
        seen.note.includes('no longer matches');
      return { ok, detail: `seen ${j(seen)}; disk ${j(disk)}` };
    },
  },
  {
    id: 'tables.datatables.e06',
    feature: 'tables.datatables',
    name: 'Cmd+Z after an edit through a view puts the block back as it was',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\n\`\`\`\n`;
      await S.fresh('view-edit-undo', text);
      await S.sleep(500);
      await S.dblclick({ sel: '.sheaf-view tr[data-row="1"] td[data-c="2"]' });
      await S.sleep(200);
      // The cell opens with its text selected, so typing replaces it.
      await S.type('7');
      await S.press('Enter');
      await S.sleep(300);
      const edited = await S.disk();
      // Undo belongs to the document, so the caret goes back into it first.
      await S.click({ sel: '.cm-line' });
      await S.press('Meta+z');
      const undone = await S.disk();
      const ok = edited === text.replace('Export,Done,2', 'Export,Done,7') && undone === text;
      return { ok, detail: `edited ${j(edited)}; undone ${j(undone)}` };
    },
  },
  {
    id: 'tables.datatables.e07',
    feature: 'tables.datatables',
    name: '+ New row in a filtered view starts with the filtered value, and typing a name adds it under the last row of the block',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nwhere: status = Open\n\`\`\`\n`;
      await S.fresh('view-add-row', text);
      await S.sleep(500);
      await S.click({ sel: '.sheaf-view-add' });
      await S.sleep(200);
      const before = await S.disk();
      await S.type('Billing');
      await S.press('Enter');
      await S.sleep(300);
      const disk = await S.disk();
      const want = text.replace('Import,Open,8\n', 'Import,Open,8\nBilling,Open,\n');
      return { ok: before === text && disk === want, detail: `before ${j(before)}; after ${j(disk)}` };
    },
  },
  {
    id: 'tables.datatables.e08',
    feature: 'tables.datatables',
    name: 'An edit through a view of a .csv file changes the one record in the file, with its line endings kept',
    run: async (S) => {
      mkdirSync(join(S.ws, 'e2e', 'data'), { recursive: true });
      const csv = join(S.ws, 'e2e', 'data', 'view-edit.csv');
      const original = 'feature,status\r\n"Search, fast",Open\r\nExport,Done\r\n';
      writeFileSync(csv, original);
      const text = 'Plan.\n\n```view\nfrom: data/view-edit.csv\nsort: status desc\n```\n';
      await S.fresh('view-edit-file', text);
      await S.sleep(800);
      await S.dblclick({ sel: '.sheaf-view tr[data-row="1"] td[data-c="1"]' });
      await S.sleep(200);
      // The cell opens with its text selected, so typing replaces it.
      await S.type('Open');
      await S.press('Enter');
      await S.sleep(1500);
      const file = await S.disk(csv);
      const doc = await S.disk();
      const ok = file === 'feature,status\r\n"Search, fast",Open\r\nExport,Open\r\n' && doc === text;
      return { ok, detail: `file ${j(file)}; document changed: ${doc !== text}` };
    },
  },
  {
    id: 'tables.datatables.e09',
    feature: 'tables.datatables',
    name: 'Dragging a card on a board to another column with the mouse writes that one status in the block, and the card lands there',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nlayout: board\ngroup: status\n\`\`\`\n`;
      await S.fresh('view-board-drag', text);
      await S.sleep(500);
      const before = await S.eval(board);
      // Search (source row 0) from Open to Done.
      await S.drag({ sel: '.sheaf-board-card[data-row="0"]' }, { sel: '.sheaf-board-col[data-value="Done"] .sheaf-board-col-head' });
      await S.sleep(400);
      const after = await S.eval(board);
      const disk = await S.disk();
      const ok =
        j(before) === j(['Open:Search,Import', 'Done:Export']) &&
        j(after) === j(['Open:Import', 'Done:Search,Export']) &&
        disk === text.replace('Search,Open,5', 'Search,Done,5');
      return { ok, detail: `before ${j(before)}; after ${j(after)}; disk ${j(disk)}` };
    },
  },
  {
    id: 'tables.datatables.e10',
    feature: 'tables.datatables',
    name: 'On a board, Alt+Right moves the focused card to the next column and Alt+Left brings it back, each written to the block',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nlayout: board\ngroup: status\n\`\`\`\n`;
      await S.fresh('view-board-keys', text);
      await S.sleep(500);
      // Import (source row 2) is the second card in Open.
      await S.click({ sel: '.sheaf-board-card[data-row="2"]' });
      await S.sleep(200);
      await S.press('Alt+ArrowRight');
      await S.sleep(400);
      const moved = await S.disk();
      const shown = await S.eval(board);
      const focused = await S.eval(() => document.activeElement?.getAttribute('aria-label') ?? null);
      await S.press('Alt+ArrowLeft');
      await S.sleep(400);
      const back = await S.disk();
      const ok =
        moved === text.replace('Import,Open,8', 'Import,Done,8') &&
        j(shown) === j(['Open:Search', 'Done:Export,Import']) &&
        focused === 'Import' &&
        back === text;
      return { ok, detail: `moved ${j(moved)}; shown ${j(shown)}; focused ${j(focused)}; back ${j(back)}` };
    },
  },
  {
    id: 'tables.datatables.e11',
    feature: 'tables.datatables',
    name: 'Clicking a view header sorts by it, clicking again turns it round, Shift-click adds a second column, and each is one line of the query and one Cmd+Z',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nwhere:  status != Blocked\n\`\`\`\n`;
      await S.fresh('view-header-sort', text);
      await S.sleep(500);
      const order = () =>
        [...document.querySelectorAll('.sheaf-view tbody tr')].map((tr) => tr.querySelector('td')?.textContent).join('/');
      await S.click({ sel: '.sheaf-view th[data-c="2"] .sheaf-view-sort' });
      await S.sleep(300);
      const asc = { disk: await S.disk(), order: await S.eval(order) };
      await S.click({ sel: '.sheaf-view th[data-c="2"] .sheaf-view-sort' });
      await S.sleep(300);
      const desc = { disk: await S.disk(), order: await S.eval(order) };
      await S.click({ sel: '.sheaf-view th[data-c="1"] .sheaf-view-sort' }, { modifiers: ['Shift'] });
      await S.sleep(300);
      const two = await S.disk();
      const sorted = await S.eval(() =>
        [...document.querySelectorAll('.sheaf-view th')].map((th) => th.getAttribute('aria-sort')).join(',')
      );
      // Undo belongs to the document, so the caret goes back into it first.
      await S.click({ sel: '.cm-line' });
      await S.press('Meta+z');
      const undone = await S.disk();
      const body = (sort) => text.replace('where:  status != Blocked\n', `where:  status != Blocked\n${sort}\n`);
      const ok =
        asc.disk === body('sort: estimate') &&
        asc.order === 'Export/Search/Import' &&
        desc.disk === body('sort: estimate desc') &&
        desc.order === 'Import/Search/Export' &&
        two === body('sort: estimate desc, status') &&
        sorted === 'none,ascending,descending' &&
        undone === desc.disk;
      return { ok, detail: `asc ${j(asc)}; desc ${j(desc)}; two ${j(two)}; aria ${sorted}; undone ${j(undone)}` };
    },
  },
  {
    id: 'tables.datatables.e12',
    feature: 'tables.datatables',
    name: 'A view header menu filters the column: typing a value and pressing Enter writes that one condition beside the others, and Escape closes it back to its button',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nwhere: estimate > 2\n\`\`\`\n`;
      await S.fresh('view-header-filter', text);
      await S.sleep(500);
      await S.hover({ sel: '.sheaf-view th[data-c="1"]' });
      await S.click({ sel: '.sheaf-view th[data-c="1"] .sheaf-view-filter' });
      await S.sleep(200);
      const opened = await S.eval(() => {
        const menu = document.querySelector('.sheaf-view-menu');
        const r = menu?.getBoundingClientRect();
        return { open: !!menu && !!r && r.height > 0, focusIn: !!menu?.contains(document.activeElement) };
      });
      await S.press('Escape');
      await S.sleep(100);
      const closed = await S.eval(() => ({
        gone: !document.querySelector('.sheaf-view-menu'),
        back: document.activeElement?.classList.contains('sheaf-view-filter') ?? false,
      }));
      await S.press('Enter');
      await S.sleep(200);
      await S.click({ sel: '.sheaf-view-menu-value' });
      await S.type('Open');
      await S.press('Enter');
      await S.sleep(300);
      const disk = await S.disk();
      const rows = await S.eval(() =>
        [...document.querySelectorAll('.sheaf-view tbody tr')].map((tr) => tr.querySelector('td')?.textContent).join('/')
      );
      const ok =
        opened.open &&
        opened.focusIn &&
        closed.gone &&
        closed.back &&
        disk === text.replace('where: estimate > 2', 'where: estimate > 2; status = Open') &&
        rows === 'Search/Import';
      return { ok, detail: `opened ${j(opened)}; closed ${j(closed)}; disk ${j(disk)}; rows ${rows}` };
    },
  },
  {
    id: 'tables.datatables.e13',
    feature: 'tables.datatables',
    name: 'Move to file on a CSV block’s right-click menu writes its rows to a file beside the document, the page shows the same rows, and Cmd+Z brings the block back while the file stays',
    run: async (S) => {
      const dir = join(S.ws, 'e2e');
      const csv = join(dir, 'move-rows.csv');
      rmSync(csv, { force: true });
      const block = '```csv id=move-rows\nfeature,status\n"Search, fast",Open\nExport,Done\n```';
      const text = `Plan.\n\n${block}\n\n\`\`\`view\nfrom: #move-rows\nwhere: status = Open\n\`\`\`\n`;
      await S.fresh('view-move-to-file', text);
      await S.sleep(500);
      const before = await S.eval(views);
      await S.rightClick({ sel: '.sheaf-table [data-r="0"][data-c="0"]' });
      await S.sleep(200);
      await S.menu('Move to file');
      await S.sleep(1200);
      const moved = await S.disk();
      const file = existsSync(csv) ? readFileSync(csv, 'utf8') : null;
      const after = await S.eval(views);
      const note = await S.eval(() => document.querySelector('.sheaf-page-note span')?.textContent ?? null);
      // Undo belongs to the document, so the caret goes back into it first.
      await S.click({ sel: '.cm-line' });
      await S.press('Meta+z');
      const undone = await S.disk();
      const stays = existsSync(csv);
      const ok =
        file === 'feature,status\n"Search, fast",Open\nExport,Done\n' &&
        moved === `Plan.\n\n\`\`\`view\nfrom: move-rows.csv\n\`\`\`\n\n\`\`\`view\nfrom: move-rows.csv\nwhere: status = Open\n\`\`\`\n` &&
        j(after) === j([{ rows: ['Search, fast,Open', 'Export,Done'], said: [] }, before[0]]) &&
        note === 'Moved the rows to move-rows.csv. The block is now a view of that file.' &&
        undone === text &&
        stays;
      rmSync(csv, { force: true });
      return { ok, detail: `file ${j(file)}; moved ${j(moved)}; before ${j(before)}; after ${j(after)}; note ${j(note)}; undone ${j(undone)}; stays ${stays}` };
    },
  },
  {
    id: 'tables.datatables.e14',
    feature: 'tables.datatables',
    name: 'Bring inline on a view of a CRLF .csv file puts its rows into the document as a named block, and the file stays as it was',
    run: async (S) => {
      mkdirSync(join(S.ws, 'e2e', 'data'), { recursive: true });
      const csv = join(S.ws, 'e2e', 'data', 'inline-rows.csv');
      const original = 'feature,status\r\n"Search, fast",Open\r\nExport,Done\r\n';
      writeFileSync(csv, original);
      const text = 'Plan.\n\n```view\nfrom: data/inline-rows.csv\n```\n\nAfter.\n';
      await S.fresh('view-bring-inline', text);
      await S.sleep(800);
      await S.hover({ sel: '.sheaf-view' });
      await S.click({ sel: '.sheaf-view-inline' });
      await S.sleep(300);
      const disk = await S.disk();
      const name = await S.eval(() => document.querySelector('.sheaf-table .sheaf-table-id')?.textContent ?? null);
      const file = readFileSync(csv, 'utf8');
      const ok =
        disk === 'Plan.\n\n```csv id=inline-rows\nfeature,status\n"Search, fast",Open\nExport,Done\n```\n\nAfter.\n' &&
        name === '#inline-rows' &&
        file === original;
      return { ok, detail: `disk ${j(disk)}; name ${j(name)}; file changed: ${file !== original}` };
    },
  },
  {
    id: 'tables.datatables.e15',
    feature: 'tables.datatables',
    name: 'Clicking a block’s #name and typing a new one renames the block and the view that reads it, a taken name is refused with a reason, and one Cmd+Z undoes the rename',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n\`\`\`csv id=other\na\n1\n\`\`\`\n\n\`\`\`view\nfrom: #Tasks\nwhere: status = Open\n\`\`\`\n`;
      await S.fresh('view-rename', text);
      await S.sleep(500);
      await S.click({ sel: '.sheaf-table .sheaf-table-id' });
      await S.sleep(150);
      await S.press('Meta+a');
      await S.type('other');
      await S.press('Enter');
      await S.sleep(200);
      const refused = await S.eval(() => ({
        open: !!document.querySelector('.sheaf-table-rename'),
        reason: document.querySelector('.sheaf-table-caption .sheaf-table-error')?.textContent ?? null,
      }));
      await S.press('Meta+a');
      await S.type('work');
      await S.press('Enter');
      await S.sleep(300);
      const renamed = await S.disk();
      const shown = await S.eval(views);
      // Undo belongs to the document, so the caret goes back into it first.
      await S.click({ sel: '.cm-line' });
      await S.press('Meta+z');
      const undone = await S.disk();
      const ok =
        refused.open &&
        (refused.reason ?? '').includes('already named "other"') &&
        renamed === text.replace('csv id=tasks', 'csv id=work').replace('from: #Tasks', 'from: #work') &&
        j(shown) === j([{ rows: ['Search,Open,5', 'Import,Open,8'], said: [] }]) &&
        undone === text;
      return { ok, detail: `refused ${j(refused)}; renamed ${j(renamed)}; shown ${j(shown)}; undone ${j(undone)}` };
    },
  },
  {
    id: 'tables.datatables.e16',
    feature: 'tables.datatables',
    name: 'A view whose file is missing shows the error with a Create button, and pressing it writes a file headed by the view’s columns into a new folder, which the view then draws',
    run: async (S) => {
      const dir = join(S.ws, 'e2e', 'made');
      rmSync(dir, { recursive: true, force: true });
      const csv = join(dir, 'new-rows.csv');
      const text = 'Plan.\n\n```view\nfrom: made/new-rows.csv\nwhere: status = Open\nsort: estimate desc\n```\n';
      await S.fresh('view-create-missing', text);
      await S.sleep(800);
      const before = await S.eval(views);
      await S.click({ sel: '.sheaf-view-create' });
      await S.sleep(1200);
      const file = existsSync(csv) ? readFileSync(csv, 'utf8') : null;
      const head = await S.eval(() =>
        [...document.querySelectorAll('.sheaf-view thead th .sheaf-view-head-name')].map((el) => el.textContent)
      );
      const after = await S.eval(views);
      const disk = await S.disk();
      const ok =
        before.length === 1 &&
        before[0].said.some((s) => s.includes('made/new-rows.csv was not found') && s.includes('Create made/new-rows.csv')) &&
        file === 'status,estimate\n' &&
        j(head) === j(['status', 'estimate']) &&
        j(after) === j([{ rows: [], said: [] }]) &&
        disk === text;
      rmSync(dir, { recursive: true, force: true });
      return { ok, detail: `before ${j(before)}; file ${j(file)}; head ${j(head)}; after ${j(after)}; document changed: ${disk !== text}` };
    },
  },
  {
    id: 'tables.datatables.e17',
    feature: 'tables.datatables',
    name: 'A view inside a quote is drawn with the quote’s bar, and sorting it from its header writes the sort line inside the quote',
    run: async (S) => {
      const text = `Plan.\n\n${TASKS}\n\n> Open work:\n>\n> \`\`\`view\n> from: #tasks\n> where: status = Open\n> \`\`\`\n\nAfter.\n`;
      await S.fresh('view-in-quote', text);
      await S.sleep(500);
      const drawn = await S.eval(() => {
        const v = document.querySelector('.sheaf-view');
        return { quoted: !!v?.classList.contains('is-quoted'), bar: v ? getComputedStyle(v).borderLeftWidth : null };
      });
      const before = await S.eval(views);
      await S.click({ sel: '.sheaf-view th[data-c="2"] .sheaf-view-sort' });
      await S.sleep(300);
      const disk = await S.disk();
      const after = await S.eval(views);
      const ok =
        drawn.quoted &&
        drawn.bar === '3px' &&
        j(before) === j([{ rows: ['Search,Open,5', 'Import,Open,8'], said: [] }]) &&
        disk === text.replace('> where: status = Open\n', '> where: status = Open\n> sort: estimate\n') &&
        j(after) === j([{ rows: ['Search,Open,5', 'Import,Open,8'], said: [] }]);
      return { ok, detail: `drawn ${j(drawn)}; before ${j(before)}; disk ${j(disk)}; after ${j(after)}` };
    },
  },
  {
    id: 'tables.datatables.e18',
    feature: 'tables.datatables',
    name: 'Cmd+Z after editing a cell through a view of a .csv file puts the file back byte for byte, and leaves the document alone',
    run: async (S) => {
      mkdirSync(join(S.ws, 'e2e', 'data'), { recursive: true });
      const csv = join(S.ws, 'e2e', 'data', 'undo-rows.csv');
      // CRLF and a quoted field, so a whole-file rewrite would show.
      const original = 'feature,status\r\n"Search, fast",Open\r\nExport,Done\r\n';
      writeFileSync(csv, original);
      const text = 'Plan.\n\n```view\nfrom: data/undo-rows.csv\n```\n';
      await S.fresh('view-file-undo', text);
      await S.sleep(800);
      // Export is source row 1; its status is column 1.
      await S.dblclick({ sel: '.sheaf-view tr[data-row="1"] td[data-c="1"]' });
      await S.sleep(200);
      // The cell opens with its text selected, so typing replaces it.
      await S.type('Open');
      await S.press('Enter');
      await S.sleep(800);
      const edited = readFileSync(csv, 'utf8');
      // Enter hands the keyboard back to the view's grid, which is where Cmd+Z is pressed.
      await S.press('Meta+z');
      await S.sleep(800);
      const undone = readFileSync(csv, 'utf8');
      const shown = await S.eval(views);
      const disk = await S.disk();
      const ok =
        edited === original.replace('Export,Done', 'Export,Open') &&
        undone === original &&
        j(shown) === j([{ rows: ['Search, fast,Open', 'Export,Done'], said: [] }]) &&
        disk === text;
      return { ok, detail: `edited ${j(edited)}; undone ${j(undone)}; shown ${j(shown)}; document changed: ${disk !== text}` };
    },
  },
  {
    id: 'tables.datatables.e19',
    feature: 'tables.datatables',
    name: 'A pipe table shown as a board from its menu draws cards by the column picked, dragging a card rewrites that one cell, and after Developer: Reload Window it is still a board',
    run: async (S) => {
      const text = 'Board plan.\n\n| Item | Phase | Owner |\n| --- | --- | --- |\n| Alpha | Todo | ana |\n| Beta | Doing | bo |\n| Gamma | Todo | cy |\n\nAfter.\n';
      await S.fresh('pipe-board', text);
      await S.sleep(800);
      // Which table is a board is kept in VS Code's storage, so a run that stopped halfway
      // leaves this one a board from the start. Put the grid back before beginning.
      if (await S.eval(() => !!document.querySelector('.sheaf-table.is-board'))) {
        await S.click({ sel: '.sheaf-table-ctrl[data-cmd="table.showAsTable"]' });
        await S.sleep(400);
      }
      await S.click({ sel: '.sheaf-table-grid td[data-r="0"][data-c="0"]' });
      await S.click({ sel: '.sheaf-table-ctrl[data-cmd="overflow"]' });
      await S.click({ sel: '.sheaf-table-menu-item[data-cmd="table.showAsBoard"]' });
      await S.sleep(300);
      const asked = await S.eval(() => ({
        title: document.querySelector('.sheaf-table-menu-title')?.textContent ?? null,
        choices: [...document.querySelectorAll('.sheaf-table-menu .sheaf-table-menu-item')].map((b) => b.textContent),
      }));
      await S.click({ sel: '.sheaf-table-menu-item[data-cmd="table.groupBy.1"]' });
      await S.sleep(500);
      const drawn = await S.eval(() => ({
        boardHeight: Math.round(document.querySelector('.sheaf-table-board')?.getBoundingClientRect().height ?? 0),
        gridHeight: Math.round(document.querySelector('.sheaf-table-grid')?.getBoundingClientRect().height ?? 0),
      }));
      const before = await S.eval(board);
      const unchanged = await S.disk();
      await S.drag({ sel: '.sheaf-board-card[data-row="2"]' }, { sel: '.sheaf-board-col[data-value="Doing"] .sheaf-board-col-head' });
      await S.sleep(500);
      const dragged = await S.disk();
      const moved = await S.eval(board);
      // A reload throws the webview and the extension host away; only VS Code's own storage
      // can carry the board across, which is what this asks about.
      await S.command('Developer: Reload Window');
      await S.sleep(6000);
      await S.open('e2e/pipe-board.md');
      await S.sleep(1500);
      const reloaded = await S.eval(board);
      const reloadedDisk = await S.disk();
      // Back to the grid, so the next run of this scenario starts where this one did.
      await S.click({ sel: '.sheaf-table-ctrl[data-cmd="table.showAsTable"]' });
      await S.sleep(400);
      const grid = await S.eval(() => !document.querySelector('.sheaf-table.is-board') && !!document.querySelector('.sheaf-table-grid table'));
      const want = text.replace('| Gamma | Todo | cy |', '| Gamma | Doing | cy |');
      const ok =
        asked.title === 'Group the board by' &&
        j(asked.choices) === j(['Item', 'Phase', 'Owner']) &&
        drawn.boardHeight > 0 &&
        drawn.gridHeight === 0 &&
        j(before) === j(['Todo:Alpha,Gamma', 'Doing:Beta']) &&
        unchanged === text &&
        dragged === want &&
        j(moved) === j(['Todo:Alpha', 'Doing:Beta,Gamma']) &&
        j(reloaded) === j(['Todo:Alpha', 'Doing:Beta,Gamma']) &&
        reloadedDisk === want &&
        grid;
      return {
        ok,
        detail: `asked ${j(asked)}; drawn ${j(drawn)}; before ${j(before)}; file after showing unchanged ${unchanged === text}; dragged ${j(dragged)}; moved ${j(moved)}; after reload ${j(reloaded)}; grid back ${grid}`,
      };
    },
  },
];

/** A board's columns as "value:title,title", in the order drawn. */
function board() {
  return [...document.querySelectorAll('.sheaf-board-col')].map(
    (col) =>
      `${col.querySelector('.sheaf-board-col-name')?.textContent}:${[...col.querySelectorAll('.sheaf-board-title')]
        .map((t) => t.textContent)
        .join(',')}`
  );
}
