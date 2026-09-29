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
    name: 'CONTROL: a table shorter than the pane never holds its header at all',
    run: async (S) => {
      await S.fresh('sticky-short', SHORT);
      await S.sleep(900);
      const seen = await wheelThrough(S, 40, 22, 0);
      const drawn = seen.filter((r) => r.drawn);
      const held = drawn.filter((r) => r.stuck).length;
      // Without this, a fix that simply stopped holding headers would pass both scenarios above.
      return held === 0
        ? { ok: drawn.length >= 1, detail: `${drawn.length} recorded states, held at none` }
        : { ok: false, detail: `a table shorter than the pane held its header at ${held} of ${drawn.length} recorded states` };
    },
  },
];
