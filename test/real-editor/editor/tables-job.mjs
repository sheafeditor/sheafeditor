/*
 * The whole job the Tables feature promises, driven in a real VS Code window, in the order a person
 * does it: read a document of tables, click a cell and type, set a column's width, sort and align and
 * move rows, see the rows as a board and as a filtered view, and find the file still a Markdown table
 * with only the bytes you touched changed.
 *
 * **What this half can and cannot answer.** A scenario knows the selector for the thing it clicks, so
 * it cannot notice that nobody would ever find the control, that a step needed the command palette, or
 * that the obvious gesture did something else first. Those want a person. What it can do, and what no
 * person will do reliably, is run the job's gestures in sequence on a real document and read the whole
 * file back after each part, on every landing.
 *
 * So each scenario here is one Part of the script, driven in order, and each ends by reading the whole
 * file and naming every line that differs from the one the part started with. That is stricter than
 * the script's own closing diff, which is taken once at the end: a table three sections away whose
 * padding moved is attributed to the part that moved it rather than to the session.
 *
 * **The fixture is a copy of the corpus, never the corpus.** Sheaf auto-saves, so a gesture here
 * writes to the file under it, and an edit to `sample/` shows up in `git status` as somebody else's
 * problem. The source is read out of the repository and written into the run's own workspace.
 *
 *   node test/real-editor/run-editor.mjs tables-job [id]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { show } from '../session.mjs';

const j = (x) => JSON.stringify(x);

/** The corpus document, read from the checkout the run was launched against. */
const sample = (name) => readFileSync(join(import.meta.dirname, '..', '..', '..', 'sample', name), 'utf8');

const cell = (r, c, t = 0) => ({ sel: `.sheaf-table [data-r="${r}"][data-c="${c}"]`, nth: t });

/** Every line that differs, by number, with both sides cut short enough to read. */
const changedLines = (before, after) => {
  const a = before.split('\n');
  const b = after.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push({ line: i + 1, was: (a[i] ?? '(none)').slice(0, 44), now: (b[i] ?? '(gone)').slice(0, 44) });
  }
  return out;
};

/**
 * How many pipe tables and fenced data blocks the source holds, counted from the text rather than
 * from the screen, so "every one of them is a grid" has a denominator that does not come from the
 * thing being measured.
 */
function blocksInSource(text) {
  const lines = text.split('\n');
  let pipes = 0;
  let fences = 0;
  let inFence = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^```(csv|tsv)\b/.exec(lines[i]);
    if (inFence) {
      if (/^```\s*$/.test(lines[i])) inFence = null;
      continue;
    }
    if (fence) {
      fences++;
      inFence = fence[1];
      continue;
    }
    /*
     * A delimiter row is what makes the lines around it a table, so count those rather than guess. The
     * line above it has to look like a header **and the line above that must not be part of a table**,
     * which is the clause the first version was missing: the Alignment table in the corpus holds a row
     * of dashes as data, that row matched, and the table was counted twice. Part 1 then read 13 drawn
     * against 14 expected and the product was right both times.
     */
    const header = (lines[i - 1] ?? '').includes('|');
    const aboveHeader = i >= 2 ? (lines[i - 2] ?? '').includes('|') : false;
    if (/^\s*\|?[\s:-]*-[-\s:|]*\|?\s*$/.test(lines[i]) && lines[i].includes('-') && header && !aboveHeader) pipes++;
  }
  return { pipes, fences, total: pipes + fences };
}

/** Wheel down over the document, recording how much of it is drawn as grids at each rest. */
async function scrollThrough(S, steps = 40) {
  if (!(await overScroller(S))) return [];
  await S.page.mouse.wheel(0, -200000);
  await S.sleep(500);
  const seen = [];
  for (let i = 0; i < steps; i++) {
    const r = await S.eval(() => {
      const sc = document.querySelector('.cm-scroller');
      const grids = document.querySelectorAll('.sheaf-table-grid').length;
      /*
       * A line still showing its pipes while it is on screen is the defect this part is about. Read as
       * a visible `.cm-line` whose text looks like a table row, which is what a person sees: a table
       * drawn as a grid has no such line, because the source is replaced by the widget.
       */
      const frame = sc.getBoundingClientRect();
      const raw = [...document.querySelectorAll('.cm-content > .cm-line')].filter((l) => {
        const t = l.textContent;
        if (!/^\s*\|.*\|\s*$/.test(t)) return false;
        const b = l.getBoundingClientRect();
        return b.bottom > frame.top && b.top < frame.bottom;
      }).length;
      return {
        top: Math.round(sc.scrollTop),
        max: Math.round(sc.scrollHeight - sc.clientHeight),
        grids,
        raw,
        /*
         * Which tables are drawn right now, identified by the id prefix they give their cells, so the
         * sweep can be summed rather than sampled. The accessible name is not an identity: it is built
         * from the headers, two tables in this document share a set, and counting names collapsed them
         * into one and read as a table that never drew.
         */
        names: [...document.querySelectorAll('.sheaf-table-grid')]
          .map((g) => {
            const td = g.querySelector('td[id], th[id]');
            const m = td ? /^(.*)-r\d+-c\d+$/.exec(td.id) : null;
            return m ? m[1] : null;
          })
          .filter(Boolean),
      };
    });
    seen.push(r);
    if (r.top >= r.max) break;
    await S.page.mouse.wheel(0, 300);
    await S.sleep(140);
  }
  return seen;
}

/**
 * Scroll until the grid whose accessible name holds `word` is drawn, centre it, and give back its
 * id prefix, which is what addresses its cells and does not move while the grid is drawn.
 *
 * It has to scroll rather than query, because a table is one block widget and CodeMirror draws the
 * viewport plus a margin: a table further down the document is not in the DOM to be found. The first
 * draft queried from the top of the document and reported that the Wide table did not exist.
 */
/**
 * Put the pointer over the scroller, so `mouse.wheel` reaches the document.
 *
 * By selector rather than by text. Two drafts failed here. The first did not position the pointer at
 * all and worked only because an earlier sweep had left it in the right place, so called first in a
 * scenario it found nothing: the wheel went wherever the pointer was and the document never moved,
 * which reads as a table that is not in the file. The second clicked a known heading, and threw once
 * the sweep had scrolled that heading off screen, which is most of the time this is called.
 */
async function overScroller(S) {
  await S.hover({ sel: '.cm-scroller' });
  return true;
}

async function findGrid(S, word) {
  /** The id prefix the grid gives its cells, which is stable while the grid is drawn. */
  const prefixOf = () =>
    S.eval((w) => {
      const g = [...document.querySelectorAll('.sheaf-table-grid')].find((x) => (x.getAttribute('aria-label') ?? '').includes(w));
      const td = g?.querySelector('td[id], th[id]');
      const m = td ? /^(.*)-r\d+-c\d+$/.exec(td.id) : null;
      return m ? m[1] : null;
    }, word);
  await overScroller(S);
  await S.page.mouse.wheel(0, -200000);
  await S.sleep(500);
  for (let k = 0; k < 60; k++) {
    if (await prefixOf()) {
      await S.eval(
        (w) => [...document.querySelectorAll('.sheaf-table-grid')].find((x) => (x.getAttribute('aria-label') ?? '').includes(w))?.scrollIntoView({ block: 'center' }),
        word
      );
      await S.sleep(450);
      return prefixOf();
    }
    const before = await S.eval(() => Math.round(document.querySelector('.cm-scroller').scrollTop));
    await S.page.mouse.wheel(0, 400);
    await S.sleep(160);
    if ((await S.eval(() => Math.round(document.querySelector('.cm-scroller').scrollTop))) === before) break;
  }
  return null;
}

/**
 * The geometry of the grid whose accessible name holds `word`, scoped to that grid rather than to the
 * first one on screen. This document has thirteen tables, so a reader that takes
 * `querySelector('.sheaf-table-grid')` answers about whichever one the viewport happens to start with.
 */
const geometryOf = (S, word) =>
  S.eval((w) => {
    const grid = [...document.querySelectorAll('.sheaf-table-grid')].find((g) => (g.getAttribute('aria-label') ?? '').includes(w));
    const table = grid?.querySelector('table');
    if (!grid || !table) return null;
    const scroller = document.querySelector('.cm-scroller');
    const last = [...table.querySelectorAll('thead th')].slice(-1)[0];
    const box = table.getBoundingClientRect();
    return {
      heads: [...table.querySelectorAll('thead th')].map((th) => Math.round(th.getBoundingClientRect().width)),
      tableWidth: Math.round(box.width),
      frameWidth: Math.round(grid.getBoundingClientRect().width),
      // Whether the table's own frame scrolls sideways, and whether the page does. The second must
      // never be true: a wide table takes the room inside its frame and the document does not move.
      frameScrolls: grid.scrollWidth > grid.clientWidth + 2,
      paneScrollsX: scroller.scrollWidth > scroller.clientWidth + 2,
      frameScrollLeft: Math.round(grid.scrollLeft),
      frameScrollMax: Math.round(grid.scrollWidth - grid.clientWidth),
      /*
       * The space after the last column once the frame is scrolled to its end, which is the
       * affordance step 11 is about: it is what tells a person they have reached the end of the
       * table rather than that it carries on past the edge.
       */
      gapAfterLast: last ? Math.round(grid.getBoundingClientRect().right - last.getBoundingClientRect().right) : null,
    };
  }, word);

/**
 * Drag the right border of header `c` of the grid whose cells carry `prefix`, by `dx`.
 *
 * Scoped by the prefix rather than by `.sheaf-table-grid thead th[...]`, which matches the first grid
 * in the DOM. In a document of thirteen tables that is whichever one comes first, and the harness
 * refused the drag with "has nothing painted at its point" because that grip was off screen. The
 * refusal was right and is what sent me back to the selector.
 */
async function dragBorder(S, prefix, c, dx) {
  const grip = { sel: `#${prefix}-r0-c${c} > .sheaf-table-resize` };
  const at = await S.hover(grip);
  await S.drag(grip, { x: at.x + dx, y: at.y });
  await S.sleep(600);
}

export const scenarios = [
  {
    /*
     * Parts 1 and 2 of the script, and the byte check that claim 6 is about, taken over the gestures
     * those parts make rather than once at the end of the session.
     *
     * Part 1 is "scroll from the top to the bottom without clicking anything, and every pipe table and
     * every data block is a grid by the time you reach it". The denominator comes from the source text,
     * counted by its delimiter rows and fences, so it cannot be satisfied by the screen agreeing with
     * itself. What is read at each rest is how many grids are drawn **and** how many lines are still
     * showing raw pipes inside the visible frame, because the second is what a person notices and the
     * first can be true while a table above or below is still source.
     *
     * Part 2 is the five gestures of clicking and typing, in order, each judged on what the next one
     * finds rather than on a screenshot: a cell shows it is picked, a word replaces the value, clicking
     * away commits it, a double-click opens the third cell with its value selected rather than empty,
     * and Escape leaves that value as it was.
     */
    id: 'tables.grid.job-read-and-type',
    /*
     * The feature is the one the part drives rather than a `tables.job` of its own. A feature id with
     * no section in the quality record grows a gap the moment it lands, and the job is a route through
     * several features rather than a feature: Part 1 is `tables.grid` and Part 2's gestures are
     * `tables.cell-edit`'s, covered there too. What holds the job together is this area's name, which
     * is how `menus.mjs` already carries `prose.link-paste`.
     */
    feature: 'tables.grid',
    name: 'Parts 1 and 2: every table is a grid on the way down, and clicking and typing behaves as the job describes',
    run: async (S) => {
      const source = sample('tables.md');
      const path = await S.fresh('job-tables', source);
      await S.sleep(1400);
      const want = blocksInSource(source);

      // --- Part 1
      const sweep = await scrollThrough(S);
      const reachedEnd = sweep.length > 0 && sweep[sweep.length - 1].top >= sweep[sweep.length - 1].max;
      const rawSeen = sweep.filter((s) => s.raw > 0);
      const mostGrids = sweep.length ? Math.max(...sweep.map((s) => s.grids)) : 0;
      /*
       * The tables seen as grids over the whole sweep, not the most drawn at one moment. The first
       * version compared the second against the number in the source and failed at 6 against 14, which
       * is not a defect: a table is one block widget and CodeMirror draws the viewport plus a margin,
       * so all fourteen are never in the DOM together. The two numbers are different kinds of thing,
       * and comparing them made a correct product read as a broken one.
       */
      const namesSeen = new Set(sweep.flatMap((s) => s.names));
      const afterScroll = await S.disk(path);

      /*
       * Part 2, in the Wide table, which is the one the script names.
       *
       * Its cells are addressed by the grid's **own id prefix** rather than by its index among the
       * drawn grids, because that index moves: a click scrolls the view, CodeMirror draws a different
       * set of blocks, and the index read before the first click pointed at another table by the third.
       * The run said so plainly, by opening a cell holding `"9"` from the Tall table's squares.
       */
      const prefix = await findGrid(S, 'Name');
      if (!prefix) return { ok: false, detail: `the Wide table never came into view, so Part 2 never started; Part 1 saw ${j(sweep.slice(0, 3))}` };
      const at = (r, c) => ({ sel: `#${prefix}-r${r + 1}-c${c}` });

      // 3: click a cell, and it shows that it is picked.
      await S.click(at(0, 1));
      await S.sleep(300);
      const picked = await S.eval(() => {
        const f = document.querySelector('.sheaf-table .is-focus, .sheaf-table .is-sel');
        return f ? { text: f.textContent, marked: f.className.includes('is-sel') || f.className.includes('is-focus') } : null;
      });
      // 4: type a word, and it replaces the value.
      await S.type('Edith');
      await S.sleep(300);
      const typing = await S.eval(() => {
        const el = document.querySelector('.sheaf-table-input');
        if (!el) return null;
        if ('value' in el) return el.value;
        const c = el.querySelector('.cm-content');
        const tile = c && (c.cmTile || c.cmView);
        return (tile?.root?.view ?? tile?.view)?.state.doc.toString() ?? null;
      });
      // 5: click a different cell, and the first commits.
      await S.click(at(1, 1));
      await S.sleep(700);
      const committed = await S.disk(path);
      // 6: double-click a third cell, and it opens with the value selected rather than empty.
      await S.dblclick(at(2, 1));
      await S.sleep(500);
      const opened = await S.eval(() => {
        const el = document.querySelector('.sheaf-table-input');
        if (!el) return null;
        if ('value' in el) return { value: el.value, selected: el.value.slice(el.selectionStart, el.selectionEnd) };
        const c = el.querySelector('.cm-content');
        const tile = c && (c.cmTile || c.cmView);
        const v = tile?.root?.view ?? tile?.view;
        if (!v) return null;
        const s = v.state.selection.main;
        return { value: v.state.doc.toString(), selected: v.state.sliceDoc(s.from, s.to) };
      });
      // 7: Escape, and the value is as it was.
      await S.press('Escape');
      await S.sleep(600);
      /*
       * Leave the grid by clicking the heading above this table rather than the one at the top of the
       * document. Part 2 scrolled to the Wide table, so `Pipe tables` is off screen and the harness
       * refused the click: "has nothing painted at its point, which usually means it is outside the
       * viewport". That refusal is correct and is why the target changed rather than the click being
       * forced.
       */
      await S.caret('many columns', 2);
      await S.sleep(700);
      const ended = await S.disk(path);

      const moved = changedLines(source, ended);
      const onlyEdith = moved.length === 1 && moved[0].now.includes('Edith') && !moved[0].now.includes('Ada');
      const ok =
        want.total > 0 &&
        reachedEnd &&
        rawSeen.length === 0 &&
        namesSeen.size >= want.total &&
        !!picked?.marked &&
        typing === 'Edith' &&
        committed.includes('Edith') &&
        opened?.value === 'Linus' &&
        opened?.selected === 'Linus' &&
        onlyEdith;
      return {
        ok,
        detail:
          `Part 1: the source holds ${want.pipes} pipe tables and ${want.fences} data blocks, ${want.total} in all; ` +
          `${sweep.length} rests, ${namesSeen.size} distinct tables seen as grids over the sweep and at most ${mostGrids} drawn at once; ` +
          `${reachedEnd ? 'the sweep reached the end of the document' : 'THE SWEEP NEVER REACHED THE END, so nothing below the last rest was looked at'}; ` +
          `${rawSeen.length === 0 ? 'no line showed raw pipes on screen' : `RAW PIPES ON SCREEN at ${j(rawSeen.slice(0, 3))}`}; ` +
          `scrolling alone ${afterScroll === source ? 'wrote nothing' : 'CHANGED THE FILE'}. ` +
          `Part 2: the clicked cell ${picked ? `shows as picked holding ${j(picked.text)}` : 'IS NOT MARKED AS PICKED'}; ` +
          `typing left the open cell ${j(typing)}; clicking away ${committed.includes('Edith') ? 'committed it' : 'LOST IT'}; ` +
          `a double-click opened the third cell holding ${j(opened?.value)} with ${j(opened?.selected)} selected; ` +
          `after Escape the file differs from the corpus on ${j(moved)}` +
          `${onlyEdith ? ', which is the one cell that was typed in' : ', WHICH IS MORE THAN THE ONE EDIT'}`,
      };
    },
  },
  {
    /*
     * Part 3 of the script, the six steps about a column's width, and step 14, the one that makes the
     * sidecar worth having. Driven in the Wide table, which the script names.
     *
     * These steps exist together for a reason the script states and no other scenario here can: three
     * of them are separate landed issues, and this is the only place a person checks them in sequence.
     * A column narrowed, then widened past the writing column, then the table taking the room inside
     * its own frame while the page stays put, then the gap after the last column still being there
     * after a further drag, then a second column widening without the first giving any of it back.
     *
     * Every reading is scoped to this table rather than to the first grid on screen, because the
     * document holds thirteen and a widths reader that takes the first one answers about whichever the
     * viewport started on.
     */
    id: 'render.table-widths.job-set-a-width',
    feature: 'render.table-widths',
    name: 'Part 3: a column narrowed, widened past the pane, the table scrolling and not the page, and the widths still there after reopening',
    run: async (S) => {
      const source = sample('tables.md');
      const path = await S.fresh('job-widths', source);
      await S.sleep(1400);
      const prefix = await findGrid(S, 'Name');
      if (!prefix) return { ok: false, detail: 'the Wide table never came into view, so Part 3 never started' };
      const start = await geometryOf(S, 'Name');
      if (!start) return { ok: false, detail: 'no geometry for the Wide table' };

      // 8: narrower.
      await dragBorder(S, prefix, 1, -60);
      const narrow = await geometryOf(S, 'Name');
      // 9: wider, past the point where the table outgrows the writing column.
      await dragBorder(S, prefix, 1, 320);
      const wide = await geometryOf(S, 'Name');
      /*
       * 11: scroll the frame to its end, then read the space after the last column.
       *
       * Re-scrolled before **every** reading of it, which the first version did not do. Widening a
       * column makes the content wider and leaves `scrollLeft` where it was, so the frame is no longer
       * at its end and the last column's right edge sits beyond the frame's. That reads as a negative
       * gap: 88px at the end, then -32px and -152px after two more drags, which looks exactly like the
       * affordance disappearing and is a reading taken at the wrong scroll position.
       */
      const toEnd = async () => {
        await S.eval(
          (w) => {
            const g = [...document.querySelectorAll('.sheaf-table-grid')].find((x) => (x.getAttribute('aria-label') ?? '').includes(w));
            if (g) g.scrollLeft = g.scrollWidth;
          },
          'Name'
        );
        await S.sleep(400);
        return geometryOf(S, 'Name');
      };
      const atEnd = await toEnd();
      // 12: drag the same border further right, twice, and read the space each time.
      await dragBorder(S, prefix, 1, 120);
      const again1 = await toEnd();
      await dragBorder(S, prefix, 1, 120);
      const again2 = await toEnd();
      // 13: a second column wider, and the first must not give any of it back.
      const beforeSecond = await geometryOf(S, 'Name');
      await dragBorder(S, prefix, 2, 80);
      const second = await geometryOf(S, 'Name');
      // 14: close and reopen.
      const onDisk = await S.disk(path);
      await S.cleanup();
      await S.open('e2e/job-widths.md');
      await S.sleep(1700);
      await findGrid(S, 'Name');
      const reopened = await geometryOf(S, 'Name');
      const after = await S.disk(path);

      const near = (a, b, t = 4) => a !== null && b !== null && Math.abs(a - b) <= t;
      // `heads[0]` is the row-number corner, so the first data column is `heads[1]` and Name is [2].
      const name = (g) => g?.heads[2] ?? null;
      const roomTaken = !!wide?.frameScrolls && !wide?.paneScrollsX;
      const gapKept = [atEnd, again1, again2].every((g) => (g?.gapAfterLast ?? 0) > 0);
      const firstHeld = near(name(second), name(beforeSecond));
      const widthsSurvived = near(name(reopened), name(second));
      const moved = changedLines(source, after);
      return {
        ok:
          name(narrow) !== null &&
          name(narrow) < name(start) &&
          name(wide) > name(narrow) &&
          roomTaken &&
          gapKept &&
          firstHeld &&
          widthsSurvived &&
          moved.length === 0,
        detail:
          `the Name column ${name(start)} narrowed to ${name(narrow)} then widened to ${name(wide)}; ` +
          `${roomTaken ? 'the table scrolls inside its own frame and the page does not' : `THE ROOM IS WRONG: frame scrolls ${wide?.frameScrolls}, page scrolls sideways ${wide?.paneScrollsX}`}; ` +
          `space after the last column at the end ${atEnd?.gapAfterLast}px, after two more drags ${again1?.gapAfterLast}px and ${again2?.gapAfterLast}px` +
          `${gapKept ? '' : ', WHICH IS NOT ALWAYS THERE'}; ` +
          `widening a second column left Name at ${name(second)} against ${name(beforeSecond)}` +
          `${firstHeld ? ', so it gave nothing back' : ', SO IT SHRANK'}; ` +
          `after closing and reopening Name is ${name(reopened)}` +
          `${widthsSurvived ? ', as it was left' : ', WHICH IS NOT WHERE IT WAS LEFT'}; ` +
          `the file ${moved.length === 0 ? 'is byte for byte the corpus throughout, which is what a width being presentation means' : `CHANGED on ${j(moved)}`}` +
          `${onDisk === source ? '' : ' (and had already changed before the reopen)'}`,
      };
    },
  },
];
