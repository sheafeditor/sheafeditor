// A .csv file opened in Sheaf as a grid, in real VS Code.
//
// A .csv opens in the text editor by default, since Sheaf is only an option for these files, so
// `S.open` reaches the grid through Reopen Editor With, the way a person does. The host suite covers
// the fence and the byte handling; this asks the real window whether the grid is what appears, and
// whether one edited cell reaches the file as one changed record.
//   node test/real-editor/run-editor.mjs csv-file [id]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);
const cell = (r, c) => ({ sel: `.sheaf-table [data-r="${r}"][data-c="${c}"]` });

// CRLF line endings, a quoted field holding a comma, and no newline at the end: each is a byte the
// grid must leave alone.
const CSV = 'name,qty,note\r\nbolt,12,"a, b"\r\nwasher,3,plain';

export const scenarios = [
  {
    id: 'tables.csv-file.e01',
    feature: 'tables.csv-file',
    name: 'A .csv reopened with Sheaf (Grid) shows the file as a grid, and editing one cell rewrites only that record',
    run: async (S) => {
      const path = join(S.ws, 'e2e', 'grid-file.csv');
      writeFileSync(path, CSV);
      await S.sleep(300);
      await S.open('e2e/grid-file.csv');
      await S.sleep(600);
      const shown = await S.eval(() => {
        const toolbar = document.getElementById('toolbar');
        const rows = [...document.querySelectorAll('.sheaf-table tr')].map((tr) => [...tr.querySelectorAll('th, td')].map((c) => c.textContent.trim()));
        return {
          csvMode: document.body.classList.contains('sheaf-csv-mode'),
          toolbarShown: !!toolbar && toolbar.getBoundingClientRect().height > 0 && getComputedStyle(toolbar).display !== 'none',
          tables: document.querySelectorAll('.sheaf-table').length,
          rows,
          fenceVisible: [...document.querySelectorAll('.cm-content > .cm-line')].some((l) => l.textContent.includes('```')),
        };
      });
      await S.click(cell(1, 1));
      await S.sleep(200);
      await S.type('4');
      await S.press('Enter');
      await S.press('Meta+s');
      const disk = await S.disk(path);
      const want = 'name,qty,note\r\nbolt,12,"a, b"\r\nwasher,4,plain';
      const grid = shown.csvMode && !shown.toolbarShown && shown.tables === 1 && !shown.fenceVisible;
      const ok = grid && disk === want;
      return { ok, detail: `page ${j(shown)}; disk ${j(disk)}` };
    },
  },
  {
    id: 'tables.csv-file.e03',
    feature: 'tables.csv-file',
    name: 'A .tsv with a byte-order mark and a backtick run in a cell shows every row, and an edit keeps the mark and every other line',
    run: async (S) => {
      const path = join(S.ws, 'e2e', 'grid-bom.tsv');
      // A run of four backticks is longer than a three-backtick fence, so a fence that did not
      // grow past it would end the grid at that cell and leave the last row outside it.
      const TSV = '﻿name\tnote\nbolt\t````x````\nnut\tplain\n';
      writeFileSync(path, TSV);
      await S.sleep(300);
      await S.open('e2e/grid-bom.tsv');
      await S.sleep(600);
      const rows = await S.eval(() =>
        [...document.querySelectorAll('.sheaf-table tr')].map((tr) => [...tr.querySelectorAll('th, td')].map((c) => c.textContent.trim()).filter((t) => t !== ''))
      );
      await S.click(cell(1, 1));
      await S.sleep(200);
      await S.type('done');
      await S.press('Enter');
      await S.press('Meta+s');
      const disk = await S.disk(path);
      const want = '﻿name\tnote\nbolt\t````x````\nnut\tdone\n';
      const shown = rows.some((r) => r.includes('````x````')) && rows.some((r) => r.includes('nut'));
      return { ok: shown && disk === want, detail: `rows ${j(rows)}; disk ${j(disk)}` };
    },
  },
  {
    id: 'tables.csv-file.e04',
    feature: 'tables.csv-file',
    name: 'Copy ref on a cell in a .csv grid names the record by its line in the file itself',
    run: async (S) => {
      const path = join(S.ws, 'e2e', 'grid-ref.csv');
      writeFileSync(path, CSV);
      await S.sleep(300);
      await S.open('e2e/grid-ref.csv');
      await S.sleep(600);
      // washer is on line 3 of the file; the fence the grid is drawn in must not shift it.
      await S.click(cell(1, 1));
      await S.clipboard.write('SENTINEL-csv');
      await S.press('Meta+Shift+Alt+r');
      await S.sleep(900);
      const ref = await S.clipboard.read();
      const disk = await S.disk(path);
      return { ok: ref.includes('grid-ref.csv:3 (qty, row 2)') && disk === CSV, detail: `${j(ref)}${disk === CSV ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'tables.csv-file.e02',
    feature: 'tables.csv-file',
    name: 'A .csv of more than 2,000 rows opens with a note giving its row count, and no grid',
    run: async (S) => {
      const path = join(S.ws, 'e2e', 'grid-large.csv');
      const lines = ['id,value'];
      for (let i = 1; i <= 2001; i++) lines.push(`${i},v${i}`);
      writeFileSync(path, lines.join('\n') + '\n');
      await S.sleep(300);
      // The note replaces the editor, so `S.open` never finds a Sheaf frame to settle on and gives
      // up after reopening with Sheaf. Look for the note in every frame instead.
      await S.open('e2e/grid-large.csv').catch(() => {});
      let found = null;
      for (let tries = 0; tries < 20 && !found; tries++) {
        for (const f of S.page.frames()) {
          const got = await f
            .evaluate(() => {
              const n = document.querySelector('.sheaf-notice');
              return n ? { text: n.textContent, tables: document.querySelectorAll('.sheaf-table').length } : null;
            })
            .catch(() => null);
          if (got) found = got;
        }
        if (!found) await S.sleep(500);
      }
      // The count is of records in the file, header included: 2,001 data rows and a header are 2,002.
      const ok = !!found && found.text.includes('2,002 rows') && found.tables === 0;
      return { ok, detail: `notice ${j(found)}` };
    },
  },
];
