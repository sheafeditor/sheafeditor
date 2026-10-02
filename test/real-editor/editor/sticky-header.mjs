// Whether a tall table's header holds one place while the document scrolls past it, in real VS Code.
//
// The browser check (`scripts/check-sticky-header.mjs`) sweeps the same ground in a tab and sees
// nothing: the header there comes on once and holds one position. That is not evidence the bug is
// absent, it is evidence the tab is the wrong room. A tab has no formatting toolbar over the top
// of the scroller, and the sticky `top` is negative precisely to undo the space that toolbar
// needs, so the one number the whole mechanism turns on is different in the two hosts.
//
// Scrolled with the wheel rather than by setting `scrollTop`. A programmatic scroll jumps between
// resting positions and skips the frames a flicker lives in; the issue asks for real scrolling by
// name for that reason.
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

const rows = (n, cols) => Array.from({ length: n }, (_, r) => `| ${cols.map((_, i) => `r${r + 1}c${i + 1}`).join(' | ')} |`).join('\n');
const table = (cols, n) => `| ${cols.join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |\n${rows(n, cols)}`;
const LEAD = 'Intro.\n\nA second paragraph.\n\nA third.\n\n';
const TAIL = '\n\nAfter the table.\n\nAnd more text below it.\n';

const NARROW = LEAD + table(['St', 'Role', 'Note'], 90) + TAIL;
const WIDE = LEAD + table(Array.from({ length: 12 }, (_, i) => `Column heading ${i + 1}`), 90) + TAIL;
const SHORT = LEAD + table(['St', 'Role', 'Note'], 3) + TAIL;
// Two tall tables with a stretch of prose between them, so there is a scroll position where the
// first has gone and the second has not arrived, and one where both are on screen at once.
const TWO =
  LEAD +
  table(['St', 'Role', 'Note'], 60) +
  '\n\nBetween the two tables.\n\n' +
  table(['Code', 'Owner', 'Comment'], 60) +
  TAIL;
// A table with nothing after it: there is no text below to scroll into, so the header may hold to
// the end of the document, and "it goes once" is not the right thing to ask of it.
const ATEND = LEAD + table(['St', 'Role', 'Note'], 90) + '\n';
/*
 * A short table in a document long enough to scroll it clear off the top of the pane. `SHORT` cannot
 * do that: its whole document scrolls 50px while the table's top sits 158px below the frame's top,
 * so the condition `stickHeader` holds on is never reached there.
 */
const SHORT_IN_LONG =
  LEAD +
  table(['St', 'Role', 'Note'], 3) +
  '\n\n' +
  Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} after the little table.`).join('\n\n') +
  '\n';

/** One reading of where the header is and how it is being held. */
const sample = (S) =>
  S.eval(() => {
    const wrap = document.querySelector('.sheaf-table');
    const head = document.querySelector('.sheaf-table thead tr');
    const scroller = document.querySelector('.cm-scroller');
    if (!scroller) return { drawn: false };
    const frame = scroller.getBoundingClientRect();
    if (!wrap || !head) return { drawn: false, frameTop: Math.round(frame.top) };
    const r = head.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    /*
     * Whether this is the same node as last time. A table is one block widget and CodeMirror
     * virtualises blocks, so one that leaves the drawn range is destroyed and rebuilt with none
     * of the state script put on it. A rebuild and a reposition look identical on screen and
     * want different fixes, so they are told apart here rather than guessed at afterwards.
     */
    const fresh = !head.dataset.stickyProbe;
    head.dataset.stickyProbe = '1';
    return {
      drawn: true,
      fresh,
      scrollTop: Math.round(scroller.scrollTop),
      frameTop: Math.round(frame.top),
      stuck: head.classList.contains('is-stuck'),
      scrollX: wrap.classList.contains('is-scroll-x'),
      // Where it is drawn against the top of the pane, which is what a person sees.
      offset: Math.round(r.top - frame.top),
      // And whether any of it is on the screen at all: a header held above the visible top is
      // the shape a flicker takes, since a pixel of scroll either way brings it back.
      visible: r.bottom > frame.top + 1 && r.top < frame.bottom - 1,
      tableTop: Math.round(box.top - frame.top),
      tableBottom: Math.round(box.bottom - frame.top),
    };
  });

/**
 * Put the pointer over the middle of the scroller, so `mouse.wheel` reaches the document.
 *
 * The arithmetic is the same as the two recorders below do for themselves: the frame's own numbers
 * are the webview's, so one real click gives the offset between the two coordinate spaces. Extracted
 * for the scenarios that wheel without recording frames, and deliberately not threaded through the
 * recorders, whose readings every scenario here is built on.
 */
async function overScroller(S) {
  const anchor = await S.click({ text: 'Intro', offset: 0 });
  const at = await S.eval(() => {
    const r = document.querySelector('.cm-scroller')?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  const start = await S.eval(() => {
    const el = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('Intro'));
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + 10, y: r.top + r.height / 2 } : null;
  });
  if (!at || !start) return false;
  await S.page.mouse.move(at.x + (anchor.x - start.x), at.y + (anchor.y - start.y));
  return true;
}

/**
 * Wheel down through the document, recording every animation frame.
 *
 * **Sampling between wheel notches cannot see this bug.** A reading every 70ms is about 14 a
 * second against a screen drawing 60, so a header that blinks for one or two frames is invisible
 * to it: the first version of this scenario sampled that way and passed on a defect somebody had
 * watched happen. A recorder inside the page runs on `requestAnimationFrame`, so it reads what is
 * drawn, on the frames it is drawn, and the whole log is harvested at the end.
 */
async function wheelThrough(S, notches, per = 120, gap = 70) {
  // Window coordinates, from one real click, as the frame's own numbers are the webview's.
  const anchor = await S.click({ text: 'Intro', offset: 0 });
  const at = await S.eval(() => {
    const r = document.querySelector('.cm-scroller')?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  const start = await S.eval(() => {
    const el = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('Intro'));
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + 10, y: r.top + r.height / 2 } : null;
  });
  if (!at || !start) return [];
  await S.page.mouse.move(at.x + (anchor.x - start.x), at.y + (anchor.y - start.y));

  await S.eval(() => {
    const log = [];
    window.__stickyLog = log;
    let last = null;
    const read = () => {
      const wrap = document.querySelector('.sheaf-table');
      const head = document.querySelector('.sheaf-table thead tr');
      const scroller = document.querySelector('.cm-scroller');
      let row;
      if (!scroller) row = { drawn: false };
      else if (!wrap || !head) row = { drawn: false, frameTop: Math.round(scroller.getBoundingClientRect().top) };
      else {
        const frame = scroller.getBoundingClientRect();
        const r = head.getBoundingClientRect();
        const box = wrap.getBoundingClientRect();
        const fresh = !head.dataset.stickyProbe;
        head.dataset.stickyProbe = '1';
        row = {
          drawn: true,
          fresh,
          scrollTop: Math.round(scroller.scrollTop),
          frameTop: Math.round(frame.top),
          stuck: head.classList.contains('is-stuck'),
          scrollX: wrap.classList.contains('is-scroll-x'),
          offset: Math.round(r.top - frame.top),
          visible: r.bottom > frame.top + 1 && r.top < frame.bottom - 1,
          tableTop: Math.round(box.top - frame.top),
          tableBottom: Math.round(box.bottom - frame.top),
        };
      }
      /*
       * Only the frames where something changed, so a long scroll does not return thousands of
       * identical rows. What is being asked about is the sequence of states, and a state that
       * repeats for forty frames is one entry in that sequence.
       */
      const key = `${row.drawn}|${row.stuck}|${row.visible}|${row.offset}|${row.fresh}`;
      if (key !== last) {
        last = key;
        log.push(row);
      }
      window.__stickyRaf = requestAnimationFrame(read);
    };
    read();
  });

  for (let i = 0; i < notches; i++) {
    await S.page.mouse.wheel(0, per);
    if (gap) await S.sleep(gap);
  }
  await S.sleep(400);
  const seen = await S.eval(() => {
    cancelAnimationFrame(window.__stickyRaf);
    const log = window.__stickyLog ?? [];
    delete window.__stickyLog;
    return log;
  });
  return seen;
}

/**
 * The same gesture and the same `requestAnimationFrame` recorder, reading **every** table rather
 * than the first.
 *
 * Separate from `wheelThrough` rather than a flag on it. That one reads
 * `document.querySelector('.sheaf-table')`, so it is a one-table instrument by construction, and
 * widening it would change the readings every existing scenario here is built on. This records
 * only what the two-table question needs, which is each table's held state at each frame.
 */
async function wheelThroughTables(S, notches, per = 22, gap = 0) {
  const anchor = await S.click({ text: 'Intro', offset: 0 });
  const at = await S.eval(() => {
    const r = document.querySelector('.cm-scroller')?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  const start = await S.eval(() => {
    const el = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('Intro'));
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + 10, y: r.top + r.height / 2 } : null;
  });
  if (!at || !start) return [];
  await S.page.mouse.move(at.x + (anchor.x - start.x), at.y + (anchor.y - start.y));

  await S.eval(() => {
    const log = [];
    window.__stickyLog = log;
    let last = null;
    const read = () => {
      const scroller = document.querySelector('.cm-scroller');
      if (!scroller) {
        window.__stickyRaf = requestAnimationFrame(read);
        return;
      }
      const frame = scroller.getBoundingClientRect();
      /*
       * Identified by the first column heading rather than by position in the list, because a table
       * that leaves the drawn range is removed from the DOM and the one after it becomes the first.
       * Counting by index would read the second table's hold as the first table's.
       */
      const tables = [...document.querySelectorAll('.sheaf-table')].map((wrap) => {
        const head = wrap.querySelector('thead tr');
        if (!head) return null;
        const r = head.getBoundingClientRect();
        return {
          who: (wrap.querySelector('thead th:nth-child(2)')?.textContent ?? '?').trim().slice(0, 6),
          stuck: head.classList.contains('is-stuck'),
          visible: r.bottom > frame.top + 1 && r.top < frame.bottom - 1,
          offset: Math.round(r.top - frame.top),
        };
      });
      const held = tables.filter((t) => t && t.stuck && t.visible);
      const row = {
        scrollTop: Math.round(scroller.scrollTop),
        drawn: tables.length,
        held: held.map((t) => `${t.who}@${t.offset}`),
      };
      const key = `${row.drawn}|${row.held.join(',')}`;
      if (key !== last) {
        last = key;
        log.push(row);
      }
      window.__stickyRaf = requestAnimationFrame(read);
    };
    read();
  });

  for (let i = 0; i < notches; i++) {
    await S.page.mouse.wheel(0, per);
    if (gap) await S.sleep(gap);
  }
  await S.sleep(400);
  return S.eval(() => {
    cancelAnimationFrame(window.__stickyRaf);
    const log = window.__stickyLog ?? [];
    delete window.__stickyLog;
    return log;
  });
}

/** The runs of held and not-held through a sweep, which is what a flicker shows up in. */
function runs(seen) {
  const out = [];
  for (const row of seen) {
    const held = !!row.drawn && !!row.stuck && !!row.visible;
    if (out.length && out[out.length - 1].held === held) out[out.length - 1].n++;
    else out.push({ held, from: row.scrollTop ?? -1, n: 1 });
  }
  return out;
}

/*
 * The default gesture is many small deltas with no pause, which is a trackpad rather than a
 * mouse wheel, and it is the default because of what a control showed. With a blink injected on
 * purpose, a coarse sweep of 34 notches at 120px passed on both tall tables and only the fine one
 * caught it: 47 separate held stretches where there should be one. A scenario that cannot see the
 * defect it is named for is worse than none, because it is read as evidence afterwards.
 */
const FLING = { notches: 220, per: 22, gap: 0 };
const WHEEL = { notches: 34, per: 120, gap: 70 };

const sweepScenario = (id, name, doc, file, gesture = FLING) => ({
  id,
  feature: 'render.sticky-header',
  name,
  run: async (S) => {
    await S.fresh(file, doc);
    await S.sleep(900);
    const seen = await wheelThrough(S, gesture.notches, gesture.per, gesture.gap);
    await S.shot(file);
    const drawn = seen.filter((r) => r.drawn);
    if (drawn.length < 3) return { ok: false, detail: `only ${drawn.length} of ${seen.length} recorded frames saw a table at all` };
    const spells = runs(seen).filter((s) => s.held);
    const offsets = [...new Set(drawn.filter((r) => r.stuck && r.visible).map((r) => r.offset))].sort((a, b) => a - b);
    const rebuilds = drawn.filter((r) => r.fresh).length;
    const held = drawn.filter((r) => r.stuck);
    const hidden = held.filter((r) => !r.visible).length;
    const detail =
      `${seen.length} changes of state across the scroll, held at ${held.length}, of which ${hidden} were off the top of the pane; ` +
      `${spells.length} visible stretch(es); offsets ${j(offsets)}; rebuilt ${rebuilds} time(s); ` +
      `held by ${drawn[0].scrollX ? 'a script transform' : 'the stylesheet'}`;
    if (!held.length) return { ok: false, detail: `${detail}. Its header never held, so a long table loses its column names.` };
    if (spells.length > 1) {
      return { ok: false, detail: `${detail}. It came on, went, and came back: every stretch after the first is a blink.` };
    }
    if (hidden) {
      return { ok: false, detail: `${detail}. It counted itself held while drawn above the visible top, which is a header nobody can see.` };
    }
    // One place, within a pixel or two of subpixel layout, for the whole time it is held.
    const spread = offsets.length ? offsets[offsets.length - 1] - offsets[0] : 0;
    return spread <= 2 ? { ok: true, detail } : { ok: false, detail: `${detail}. While held it moved ${spread}px, and it should hold one place.` };
  },
});

export const scenarios = [
  sweepScenario(
    'render.sticky-header.e01',
    'Scrolling past a tall table that fits the column, its header comes on once, holds one place, and goes once',
    NARROW,
    'sticky-narrow'
  ),
  sweepScenario(
    'render.sticky-header.e02',
    'Scrolling past a tall table wider than the pane, its header comes on once, holds one place, and goes once',
    WIDE,
    'sticky-wide'
  ),
  /*
   * And the same ground with a mouse wheel, which is a different input: one large notch at a time
   * with a pause between. Kept even though the control showed it cannot see a blink on its own,
   * because it is the gesture most people scroll a document with and it costs seconds.
   */
  sweepScenario(
    'render.sticky-header.e04',
    'A mouse wheel, which delivers one large notch at a time rather than a stream of small ones',
    WIDE,
    'sticky-wheel',
    WHEEL
  ),
  {
    id: 'render.sticky-header.e03',
    feature: 'render.sticky-header',
    name: 'CONTROL: a table shorter than the pane never holds its header at all, and this sweep can see one that does',
    run: async (S) => {
      await S.fresh('sticky-short', SHORT);
      await S.sleep(900);
      const seen = await wheelThrough(S, 40, 22, 0);
      const drawn = seen.filter((r) => r.drawn);
      const held = drawn.filter((r) => r.stuck).length;
      /*
       * Why the geometry is printed, and why this scenario now runs twice.
       *
       * This is the control the other scenarios here lean on: without it, a change that simply
       * stopped holding headers would pass all of them. So **this** one has to be able to fail, and
       * its own pass is not evidence of that.
       *
       * `stickHeader` has no pane-height term. It holds the row when the table's top has gone above
       * the frame's top and its last row has not, which is a window of `height - headerHeight`
       * pixels of scrolling, whatever the pane's height. A three-row table is about 110px of window,
       * which a 22px step samples five times. So "shorter than the pane" is not what makes this pass
       * and the numbers below say what does: a short document cannot scroll its table's top above
       * the frame's top at all, so the condition is never reached. `topAgainstFrame` is the reading
       * that settles it, and it is printed rather than asserted because it describes the fixture.
       */
      const geometry = await S.eval(() => {
        const sc = document.querySelector('.cm-scroller');
        const table = document.querySelector('.sheaf-table table');
        const head = table?.tHead?.rows[0];
        if (!sc || !table || !head) return null;
        const box = table.getBoundingClientRect();
        const frameTop = sc.getBoundingClientRect().top;
        return {
          scrollTop: Math.round(sc.scrollTop),
          maxScroll: Math.round(sc.scrollHeight - sc.clientHeight),
          // Negative means the table's top is above the frame's, which is the first half of the
          // condition `stickHeader` holds on.
          topAgainstFrame: Math.round(box.top - frameTop),
          window: Math.round(box.height - head.offsetHeight),
        };
      });
      /*
       * And the control for the control: the class pinned on each frame, so the recorder has a held
       * state to find. If this pass reports none, the sweep cannot see a held header and the zero
       * above means nothing about the product. Pinned rather than toggled once, because
       * `stickHeader` runs on every scroll event and would take it straight back off.
       */
      await S.eval(() => {
        const loop = () => {
          document.querySelector('.sheaf-table thead tr')?.classList.add('is-stuck');
          window.__pin = requestAnimationFrame(loop);
        };
        loop();
      });
      const pinned = await wheelThrough(S, 20, 22, 0);
      await S.eval(() => {
        cancelAnimationFrame(window.__pin);
        delete window.__pin;
        document.querySelector('.sheaf-table thead tr')?.classList.remove('is-stuck');
      });
      const pinnedHeld = pinned.filter((r) => r.drawn && r.stuck).length;
      const detail =
        `${drawn.length} recorded states, held at ${held}; geometry ${j(geometry)}; ` +
        `with the class pinned on, held at ${pinnedHeld} of ${pinned.filter((r) => r.drawn).length}`;
      if (held !== 0) return { ok: false, detail: `a table shorter than the pane held its header at ${held} states. ${detail}` };
      if (pinnedHeld === 0)
        return { ok: false, detail: `the sweep did not see a held header even with the class pinned on, so its zero says nothing. ${detail}` };
      return { ok: drawn.length >= 1, detail };
    },
  },
  {
    /*
     * Two tall tables in one document. Untried until now, and not by oversight: the recorder the
     * scenarios above share reads `querySelector('.sheaf-table')`, so it has only ever seen the
     * first table in a document and could not have answered this.
     *
     * Two things to separate. Each table holding its own header once is the same claim as e01 made
     * twice. **Both holding at the same moment is a different fault**, and it is the one a person
     * notices: two header rows stacked at the top of the pane, one of them belonging to a table
     * that is no longer on screen.
     */
    id: 'render.sticky-header.e05',
    feature: 'render.sticky-header',
    name: 'Two tall tables in one document: each holds its own header, and never both at once',
    run: async (S) => {
      await S.fresh('sticky-two', TWO);
      await S.sleep(1200);
      const seen = await wheelThroughTables(S, 300, 22, 0);
      if (!seen.length) return { ok: false, detail: 'nothing recorded, so the gesture did not reach the document' };
      const both = seen.filter((r) => r.held.length > 1);
      // The stretches each table held for, by its own heading, so a table holding twice is visible.
      const stretches = new Map();
      let last = '';
      for (const r of seen) {
        const now = r.held.map((h) => h.split('@')[0]).sort().join(',');
        if (now !== last) {
          last = now;
          for (const who of r.held.map((h) => h.split('@')[0])) stretches.set(who, (stretches.get(who) ?? 0) + 1);
        }
      }
      const twice = [...stretches].filter(([, n]) => n > 1);
      /*
       * `stretches.size === 2` is the precondition. A sweep that never held either header, or that
       * only ever reached the first table, satisfies "never both at once" and "neither held twice"
       * without telling anyone anything.
       */
      return {
        ok: stretches.size === 2 && both.length === 0 && twice.length === 0,
        detail:
          `${seen.length} recorded states over ${seen[seen.length - 1].scrollTop}px; ` +
          `held stretches per table ${j([...stretches])}; ` +
          `both held at once in ${both.length} states${both.length ? ` ${j(both.slice(0, 3))}` : ''}`,
      };
    },
  },
  {
    /*
     * A table with nothing after it, which the sweep scenarios cannot cover: they assert the header
     * goes once, and here there is nothing below to scroll into, so holding to the very end is
     * correct. What is asked instead is that it holds **one** stretch at **one** place, which is the
     * flicker question without the departure.
     */
    id: 'render.sticky-header.e06',
    feature: 'render.sticky-header',
    name: 'A table at the end of a document holds its header to the end, in one place, without blinking',
    run: async (S) => {
      await S.fresh('sticky-at-end', ATEND);
      await S.sleep(1200);
      const seen = await wheelThrough(S, 260, 22, 0);
      if (!seen.length) return { ok: false, detail: 'nothing recorded, so the gesture did not reach the document' };
      const r = runs(seen);
      const heldRuns = r.filter((x) => x.held);
      const offsets = seen.filter((x) => x.drawn && x.stuck && x.visible).map((x) => x.offset);
      const spread = offsets.length ? Math.max(...offsets) - Math.min(...offsets) : -1;
      const rebuilt = seen.filter((x) => x.fresh).length;
      return {
        ok: heldRuns.length === 1 && offsets.length > 0 && spread <= 2,
        detail:
          `${seen.length} recorded states, held over ${heldRuns.length} stretch(es) ` +
          `${j(heldRuns.map((x) => x.from))}, offsets ${j([...new Set(offsets)])} spread ${spread}px, ` +
          `rebuilt ${rebuilt} time(s)`,
      };
    },
  },
  {
    /*
     * Sideways, then down. A held header is positioned against the vertical scroller while its cells
     * are positioned by the frame's own horizontal scroll, so this is the one gesture where the two
     * can disagree, and neither sweep above moves horizontally at all.
     *
     * The alignment is read as the header cells' left edges against the body cells' under them,
     * which is what a person sees as a fault. Asserting the frame's `scrollLeft` matched would pass
     * on a header that was aligned to the wrong row.
     */
    id: 'render.sticky-header.e07',
    feature: 'render.sticky-header',
    name: 'Scrolled sideways while its header is held, a table keeps the header put and its columns lined up',
    run: async (S) => {
      await S.fresh('sticky-sideways', WIDE);
      await S.sleep(1200);
      // Down far enough that the header is held, by the same gesture the other scenarios use.
      await wheelThrough(S, 60, 22, 0);
      const look = () =>
        S.eval(() => {
          const wrap = document.querySelector('.sheaf-table');
          const grid = wrap?.querySelector('.sheaf-table-grid');
          const head = wrap?.querySelector('thead tr');
          const scroller = document.querySelector('.cm-scroller');
          if (!wrap || !grid || !head || !scroller) return null;
          const frame = scroller.getBoundingClientRect();
          const hs = [...head.querySelectorAll('th')].map((c) => Math.round(c.getBoundingClientRect().left));
          const firstBody = wrap.querySelector('tbody tr');
          const bs = firstBody ? [...firstBody.querySelectorAll('td, th')].map((c) => Math.round(c.getBoundingClientRect().left)) : [];
          const n = Math.min(hs.length, bs.length);
          let worst = 0;
          for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(hs[i] - bs[i]));
          return {
            stuck: head.classList.contains('is-stuck'),
            offset: Math.round(head.getBoundingClientRect().top - frame.top),
            scrollLeft: Math.round(grid.scrollLeft),
            // Whether there is anything to scroll sideways at all: a table that fits cannot answer
            // this question, and would otherwise look like a gesture that failed.
            canScroll: grid.scrollWidth > grid.clientWidth + 1,
            columns: n,
            worstMisalignment: worst,
          };
        });
      const before = await look();
      if (!before || !before.stuck) return { ok: false, detail: `the header was not held before scrolling sideways: ${j(before)}` };
      /*
       * `deltaX` directly, not Shift with a vertical wheel. Shift-to-horizontal is something the
       * operating system does to a real wheel before the page sees it, and a synthetic wheel event
       * does not get it: the first version of this held Shift and the frame's `scrollLeft` stayed at
       * 0, which the precondition below caught rather than passing on a table that never moved.
       */
      for (let i = 0; i < 24; i++) await S.page.mouse.wheel(60, 0);
      await S.sleep(500);
      const sideways = await look();
      // Then down again, which is where a header positioned against the wrong axis comes apart.
      for (let i = 0; i < 10; i++) await S.page.mouse.wheel(0, 22);
      await S.sleep(500);
      const after = await look();
      const d = await S.disk();
      if (!sideways || !after) return { ok: false, detail: 'the table left the screen partway through' };
      /*
       * `sideways.scrollLeft > 50` is the precondition, and it is the one that matters: if Shift and
       * the wheel did not move the frame, every other reading is of a table that never scrolled and
       * the scenario passes having tested nothing.
       */
      return {
        ok:
          before.canScroll &&
          sideways.scrollLeft > 50 &&
          sideways.stuck &&
          after.stuck &&
          Math.abs(sideways.offset - before.offset) <= 2 &&
          sideways.worstMisalignment <= 2 &&
          after.worstMisalignment <= 2 &&
          sideways.columns > 2 &&
          d === WIDE,
        detail:
          `before: offset ${before.offset}, scrollLeft ${before.scrollLeft}, scrollable ${before.canScroll}, ` +
          `worst misalignment ${before.worstMisalignment} over ${before.columns} columns; ` +
          `scrolled sideways to ${sideways.scrollLeft}: held ${sideways.stuck}, offset ${sideways.offset}, worst ${sideways.worstMisalignment}; ` +
          `then down: held ${after.stuck}, offset ${after.offset}, scrollLeft ${after.scrollLeft}, worst ${after.worstMisalignment}; ` +
          `file unchanged ${d === WIDE}`,
      };
    },
  },
  {
    /*
     * A reading, because it decides what a requirement should say rather than checking one.
     *
     * The section's control, `e03`, is a three-row table in a short document, and it is read as
     * saying a table shorter than the pane never holds its header. Its geometry says otherwise: that
     * document scrolls 50px in total while the table's top sits 158px below the frame's top, so the
     * condition is never reached and the pass describes the fixture rather than the product.
     *
     * `stickHeader` has no pane-height term. It holds the row while the table's top is above the
     * frame's top and its last row is not, which is a window of `height - headerHeight` pixels
     * whatever the table's height: about 110px for three rows. So the prediction is that a short
     * table in a long document **does** hold its header, briefly, and that there is no short-table
     * exemption to find.
     *
     * Both halves are recorded. The second is the one that can serve as the section's control, and it
     * is height-independent: before the table's top reaches the top of the pane, the header is not
     * held. A build that held every header always fails that, and a short table cannot make it
     * vacuous.
     */
    id: 'render.sticky-header.e08',
    feature: 'render.sticky-header',
    name: 'A short table in a long document holds its header for its own height, and holds nothing before you reach it',
    run: async (S) => {
      await S.fresh('sticky-short-long', SHORT_IN_LONG);
      await S.sleep(1200);
      const seen = await wheelThrough(S, 220, 22, 0);
      if (!seen.length) return { ok: false, detail: 'nothing recorded, so the gesture did not reach the document' };
      const drawn = seen.filter((r) => r.drawn);
      const r = runs(seen);
      const heldRuns = r.filter((x) => x.held);
      // Every state where the table's top had not yet reached the frame's top. The header must not be
      // held in any of them, and this is the part that is independent of the table's height.
      const beforeArriving = drawn.filter((x) => x.tableTop > 1);
      const heldEarly = beforeArriving.filter((x) => x.stuck && x.visible);
      const window = drawn.length ? Math.max(...drawn.map((x) => x.tableBottom - x.tableTop)) : -1;
      return {
        ok:
          // The precondition: the sweep has to have reached past the table, or neither half means anything.
          beforeArriving.length > 0 &&
          drawn.some((x) => x.tableTop <= 1) &&
          heldEarly.length === 0,
        detail:
          `${drawn.length} recorded states; held over ${heldRuns.length} stretch(es) ${j(heldRuns.map((x) => x.from))}; ` +
          `${beforeArriving.length} states before the table's top reached the pane, held in ${heldEarly.length} of them; ` +
          `the table measured ${window}px tall, so the predicted hold window is about ${window - 37}px`,
      };
    },
  },
  {
    /*
     * R4: a held row never leaves its own table, so near the end it covers only what is left.
     *
     * Not a question about blinking, so it is read at resting positions rather than on every frame.
     * What it needs instead is a number the frame recorder does not keep: how far the held row's
     * bottom hangs past the bottom of its own table. Everything else here is a reading of where the
     * row sits against the pane, which stays the same whether the table is still under it or not.
     *
     * The precondition is the whole risk, and the first run of this failed on it rather than on the
     * product. With `NARROW`, whose table is followed by two short paragraphs, the document cannot
     * scroll far enough to bring the table's last row up to the top of the pane at all: the sweep
     * reported the row held in every one of 120 readings and the table's bottom still 278px below it,
     * which is a fixture that never reaches the condition and reads exactly like a rule that holds.
     * Hence the long tail of prose below the table here. The reading says either way whether the end
     * was reached.
     */
    id: 'render.sticky-header.e09',
    feature: 'render.sticky-header',
    name: 'Near the end of a long table the held header stops at the last row instead of carrying on up the document',
    run: async (S) => {
      const LONG_TAIL = '\n\n' + Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} below the table.`).join('\n\n') + '\n';
      await S.fresh('sticky-end-of-table', LEAD + table(['St', 'Role', 'Note'], 90) + LONG_TAIL);
      await S.sleep(1000);
      await overScroller(S);
      const read = () =>
        S.eval(() => {
          const sc = document.querySelector('.cm-scroller');
          const wrap = document.querySelector('.sheaf-table');
          const head = document.querySelector('.sheaf-table thead tr');
          if (!sc || !wrap || !head) return null;
          const frame = sc.getBoundingClientRect();
          const r = head.getBoundingClientRect();
          const box = wrap.getBoundingClientRect();
          return {
            scrollTop: Math.round(sc.scrollTop),
            stuck: head.classList.contains('is-stuck'),
            headTop: Math.round(r.top - frame.top),
            tableBottom: Math.round(box.bottom - frame.top),
            // The one number this scenario exists for: how far the held row hangs past its own table.
            past: Math.round(r.bottom - box.bottom),
          };
        });
      /*
       * Coarse to the end of the table, then fine through it. A single 400px step walked straight over
       * the stretch this scenario is about: ten readings, the table's bottom 348px below the held row
       * in the last of them and off the top of the pane in the next, so the zone where the row has to
       * give way was never sampled at all. The reading reported that rather than passing, which is the
       * only reason it was not read as a rule that holds.
       */
      const seen = [];
      for (let i = 0; i < 400; i++) {
        const r0 = seen[seen.length - 1];
        await S.page.mouse.wheel(0, !r0 || r0.tableBottom > 700 ? 400 : 40);
        await S.sleep(50);
        const r = await read();
        if (r) seen.push(r);
        if (r && r.tableBottom < -120) break;
      }
      const held = seen.filter((r) => r.stuck);
      const overhang = held.filter((r) => r.past > 2);
      const reachedEnd = held.some((r) => r.tableBottom < 200);
      const worst = held.length ? Math.max(...held.map((r) => r.past)) : null;
      return {
        ok: held.length > 0 && reachedEnd && overhang.length === 0,
        detail:
          `${seen.length} readings, held in ${held.length}; ` +
          `${reachedEnd ? 'the end of the table was reached while the row was held' : 'THE SWEEP NEVER REACHED THE END OF THE TABLE while the row was held, so a zero below says nothing'}; ` +
          `the row hung past its table in ${overhang.length} of them, worst ${worst}px` +
          `${overhang.length ? `, at ${j(overhang.slice(0, 3))}` : ''}`,
      };
    },
  },
  {
    /*
     * R6: an empty header row is never held, by either mechanism. A pipe table must be written with a
     * header, so a two-column summary of values has a blank one, and holding it would cover the rows
     * it rides over with nothing.
     *
     * Two sweeps, and the second is the control rather than a nicety. "Never held" is the same reading
     * as a fixture that never reached the condition, which is the mistake e03 exists to document, so
     * the filled-header table is driven through the same gesture in the same run and has to be seen to
     * hold. One of the two passing is not a result.
     */
    id: 'render.sticky-header.e10',
    feature: 'render.sticky-header',
    name: 'A table whose header row is empty never holds it, and a filled one in the same run does',
    run: async (S) => {
      const blankHead = (n) => `|  |  |  |\n| --- | --- | --- |\n${rows(n, ['a', 'b', 'c'])}`;
      await S.fresh('sticky-blank-header', LEAD + blankHead(90) + TAIL);
      await S.sleep(1000);
      const blank = await wheelThrough(S, 220, 22, 0);
      const blankDrawn = blank.filter((r) => r.drawn);
      const blankHeld = blankDrawn.filter((r) => r.stuck && r.visible);
      // The same gesture over a table that differs only in having words in its header row.
      await S.fresh('sticky-filled-header', NARROW);
      await S.sleep(1000);
      const filled = await wheelThrough(S, 220, 22, 0);
      const filledDrawn = filled.filter((r) => r.drawn);
      const filledHeld = filledDrawn.filter((r) => r.stuck && r.visible);
      const pastTheTop = blankDrawn.some((r) => r.tableTop <= 1);
      return {
        ok: blankHeld.length === 0 && pastTheTop && filledHeld.length > 0,
        detail:
          `empty header: ${blankDrawn.length} states, held in ${blankHeld.length}; ` +
          `${pastTheTop ? "its table's top did pass the top of the pane" : 'ITS TABLE NEVER SCROLLED PAST THE TOP OF THE PANE, so the zero says nothing'}; ` +
          `CONTROL, a filled header over the same gesture: ${filledDrawn.length} states, held in ${filledHeld.length}` +
          `${filledHeld.length ? '' : ', SO THIS RUN COULD NOT SEE A HELD HEADER AT ALL'}`,
      };
    },
  },
  {
    /*
     * R8's webview half: the same three readings a browser probe already takes, taken here.
     *
     * R8 promises three hosts and only one of them had an instrument. The two it is worth saying out
     * loud about: the browser tab is where the header does not hold at all, which is its own open
     * issue and is not this scenario's business; and the site demo still has none, so R8 is covered by
     * two of three rooms after this rather than three. Writing it down beats a row that reads as
     * covered.
     *
     * Why the readings are the ones they are. A row sitting above the ones passing under it is a paint
     * question, so what is drawn at a point inside the header answers it and a `z-index` does not. A
     * background colour computes as set whether or not anything paints it, so both the row and its
     * first cell are read and the alpha is checked rather than the property's presence.
     *
     * And the control is the unscrolled reading in the same run: `position: sticky` is set the whole
     * time, so reading the property calls an unscrolled header held. What separates the two states is
     * the row having detached from the top of its own table, and the before-and-after `top` is printed
     * so a build that pinned the row throughout fails here rather than passing.
     */
    id: 'render.sticky-header.e11',
    feature: 'render.sticky-header',
    name: 'In the VS Code webview a held header is opaque, draws an edge, and is what is drawn at its own point',
    run: async (S) => {
      await S.fresh('sticky-opaque-webview', NARROW);
      await S.sleep(1000);
      const read = () =>
        S.eval(() => {
          const table = document.querySelector('.sheaf-table');
          const head = table?.querySelector('thead tr');
          if (!head) return { error: 'no header row' };
          const cs = getComputedStyle(head);
          const cell = head.querySelector('th, td');
          const cellCs = cell ? getComputedStyle(cell) : null;
          const opaque = (c) => {
            if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return false;
            const m = /rgba?\([^)]*?(?:,\s*([\d.]+))?\)$/.exec(c);
            return !m || m[1] === undefined || Number(m[1]) === 1;
          };
          const painted = (c) => !!c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)';
          const r = head.getBoundingClientRect();
          // The inner table rather than the wrapper, whose top sits above the header by the frame's
          // own padding and read as 9px of detachment on a table nobody had scrolled.
          const inner = table.querySelector('table') ?? table;
          const tableTop = inner.getBoundingClientRect().top;
          const at = document.elementFromPoint(Math.round(r.left + 12), Math.round(r.top + r.height / 2));
          return {
            held: r.top - tableTop > 2,
            detachedBy: Math.round(r.top - tableTop),
            position: cs.position,
            backgroundPainted: painted(cs.backgroundColor) || painted(cellCs?.backgroundColor),
            backgroundOpaque: opaque(cs.backgroundColor) || opaque(cellCs?.backgroundColor),
            edgeBelow: [cs.borderBottomWidth, cs.boxShadow === 'none' ? '' : 'shadow', cellCs?.borderBottomWidth].filter(Boolean).join(' '),
            topmostAtItsOwnPoint: !!at && (at === head || head.contains(at)),
            top: Math.round(r.top),
          };
        });
      const before = await read();
      await overScroller(S);
      let during = null;
      for (let i = 0; i < 60; i++) {
        await S.page.mouse.wheel(0, 300);
        await S.sleep(60);
        const r = await read();
        if (r && r.held) {
          during = r;
          break;
        }
      }
      if (!during) return { ok: false, detail: `the header never came away from its table, so there was nothing to read: unscrolled ${j(before)}` };
      const edge = during.edgeBelow !== '' && during.edgeBelow !== '0px';
      return {
        ok: during.backgroundPainted && during.backgroundOpaque && during.topmostAtItsOwnPoint && edge && during.top !== before.top,
        detail:
          `held, ${during.detachedBy}px clear of its table's top, position ${j(during.position)}; ` +
          `background ${during.backgroundPainted ? 'painted' : 'NOT PAINTED'} and ${during.backgroundOpaque ? 'fully opaque' : 'TRANSLUCENT'}; ` +
          `edge beneath ${j(during.edgeBelow)}${edge ? '' : ' WHICH IS NONE'}; ` +
          `${during.topmostAtItsOwnPoint ? 'the header is what is drawn at its own point' : 'SOMETHING ELSE IS DRAWN AT ITS OWN POINT, so rows do not pass under it'}; ` +
          `CONTROL: unscrolled it sat at top ${before.top} against ${during.top} held` +
          `${during.top === before.top ? ', WHICH IS THE SAME PLACE, so this reading cannot tell held from unheld' : ''}`,
      };
    },
  },
];
