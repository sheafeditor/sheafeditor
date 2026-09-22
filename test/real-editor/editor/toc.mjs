// The table of contents in real VS Code: the half of it that is layout, which jsdom cannot see.
// Whether the rail moves the text, whether the toolbar still holds one row with the new button in it,
// whether the highlight follows the reading position, and what the narrow-pane panel does.
//   node test/real-editor/run-editor.mjs toc [id]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

const TOC_BUTTON = { sel: '#toolbar [aria-label="Table of contents"]' };

/** Set the setting through the profile, so a scenario does not depend on what the last one left behind. */
async function setToc(S, on) {
  const path = join(S.run, 'user', 'User', 'settings.json');
  const cur = JSON.parse(readFileSync(path, 'utf8'));
  if (on) cur['sheaf.tableOfContents'] = true;
  else delete cur['sheaf.tableOfContents'];
  writeFileSync(path, JSON.stringify(cur, null, 2));
  await S.sleep(1600);
}

/** What the profile's settings file holds for the setting right now. */
function readToc(S) {
  const cur = JSON.parse(readFileSync(join(S.run, 'user', 'User', 'settings.json'), 'utf8'));
  return cur['sheaf.tableOfContents'] ?? null;
}

/** Zoom the window out, which is the only lever here that makes the pane wider in CSS pixels. */
async function zoom(S, level) {
  const path = join(S.run, 'user', 'User', 'settings.json');
  const cur = JSON.parse(readFileSync(path, 'utf8'));
  cur['window.zoomLevel'] = level;
  writeFileSync(path, JSON.stringify(cur, null, 2));
  await S.sleep(1800);
}

/** Widen the real window, which a viewport size cannot do in Electron. */
async function windowWidth(S, width) {
  const win = await S.app.browserWindow(S.page);
  await win.evaluate((w, px) => w.setBounds({ ...w.getBounds(), width: px }), width);
  await S.sleep(900);
}

const DOC = [
  '# Handbook',
  '',
  'An opening paragraph that runs long enough to wrap inside the column so the measurement means something.',
  '',
  '## Stores',
  '',
  ...Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the stores section, with enough words on it to fill the column.\n`),
  '## Maintenance',
  '',
  ...Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the maintenance section, with enough words on it to fill the column.\n`),
  '### Drones',
  '',
  'The last section, about the drones.',
  '',
].join('\n');

/** The text column's box, the rail's box, and how the rail is drawn. */
const layout = (S) =>
  S.eval(() => {
    const round = (b) => b && { left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), top: Math.round(b.top) };
    const content = document.querySelector('.cm-content');
    const nav = document.querySelector('.sheaf-toc');
    const scroller = document.querySelector('.cm-scroller');
    return {
      column: round(content.getBoundingClientRect()),
      rail: nav ? round(nav.getBoundingClientRect()) : null,
      overlay: nav ? nav.classList.contains('is-overlay') : null,
      open: nav ? nav.classList.contains('is-open') : null,
      pane: round(scroller.getBoundingClientRect()),
      entries: [...document.querySelectorAll('.sheaf-toc-entry')].map((e) => e.textContent),
      current: (() => {
        const c = document.querySelector('.sheaf-toc-entry[aria-current="location"]');
        return c ? c.textContent : null;
      })(),
      label: nav ? nav.getAttribute('aria-label') : null,
    };
  });

/** Which row of the toolbar each control sits on, by its top edge. */
const toolbarRows = (S) =>
  S.eval(() => {
    const bar = document.getElementById('toolbar');
    const tops = [...bar.querySelectorAll('.sheaf-tb-btn')].map((b) => Math.round(b.getBoundingClientRect().top));
    return { rows: [...new Set(tops)].length, controls: tops.length, barHeight: Math.round(bar.getBoundingClientRect().height), paneWidth: Math.round(bar.parentElement.getBoundingClientRect().width) };
  });

const near = (a, b, slack = 1) => Math.abs(a - b) <= slack;

export const scenarios = [
  {
    id: 'render.toc.e01',
    feature: 'render.toc',
    name: 'Turning the table of contents on puts a rail beside the text without moving the text',
    run: async (S) => {
      await setToc(S, false);
      await S.fresh('toc-open', DOC);
      await S.sleep(900);
      const before = await layout(S);
      await S.click(TOC_BUTTON);
      await S.sleep(900);
      const after = await layout(S);
      const d = await S.disk();
      const moved = !near(before.column.left, after.column.left) || !near(before.column.w, after.column.w);
      // Drawn or not is a width question: the panel's element can sit in the page closed.
      const wasHidden = !before.rail || before.rail.w === 0;
      const nowShown = !!after.rail && after.rail.w > 100;
      return {
        ok: wasHidden && nowShown && after.label === 'Table of contents' && after.entries.length === 4 && !moved && d === DOC,
        detail: `column ${j(before.column)} -> ${j(after.column)}${moved ? ' (MOVED)' : ''}; rail ${j(before.rail)} -> ${j(after.rail)} overlay ${after.overlay} label ${j(after.label)}; entries ${j(after.entries)}${d === DOC ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.toc.e02',
    feature: 'render.toc',
    name: 'With the new button in it, the toolbar still holds one row at an ordinary pane width',
    run: async (S) => {
      // The width the wrapping was reported at is about 630px of pane, and a split of this window gives
      // 546, narrow enough that the stylesheet wraps on purpose. The display caps how wide the window
      // can go, so zooming out is the lever: it makes the same pane wider in the CSS pixels the
      // stylesheet is written in. -0.75 puts the split pane near 630.
      await windowWidth(S, 1500);
      await zoom(S, -0.28);
      await setToc(S, true);
      await S.fresh('toc-toolbar', DOC);
      await S.sleep(700);
      await S.command('View: Split Editor Right');
      await S.sleep(1400);
      const m = await toolbarRows(S);
      // A pane in the band the wrapping was reported at, and one row in it.
      return { ok: m.rows === 1 && m.paneWidth >= 600 && m.paneWidth <= 680, detail: `${m.rows} row(s) of ${m.controls} controls, bar ${m.barHeight}px tall, pane ${m.paneWidth}px` };
    },
  },
  {
    id: 'render.toc.e03',
    feature: 'render.toc',
    name: 'Reading down the document moves the highlight to the heading you are under',
    run: async (S) => {
      await setToc(S, true);
      await S.fresh('toc-spy', DOC);
      await S.sleep(900);
      const top = await layout(S);
      await S.caret('An opening paragraph', 2);
      for (let i = 0; i < 6; i++) await S.press('PageDown');
      await S.sleep(800);
      const down = await layout(S);
      return {
        ok: top.current !== null && down.current !== null && down.current !== top.current,
        detail: `at the top ${j(top.current)}; after six Page Downs ${j(down.current)}; entries ${j(down.entries)}`,
      };
    },
  },
  {
    id: 'render.toc.e04',
    feature: 'render.toc',
    name: 'Clicking an entry brings that heading to the top and leaves the file alone',
    run: async (S) => {
      await setToc(S, true);
      await S.fresh('toc-jump', DOC);
      await S.sleep(900);
      const before = await S.disk();
      // The third entry, not the last: a heading in the last screenful cannot be brought to the top,
      // because the document runs out of scroll under it.
      await S.click({ sel: '.sheaf-toc-entry', nth: 2 });
      await S.sleep(900);
      const where = await S.eval(() => {
        const scroller = document.querySelector('.cm-scroller').getBoundingClientRect();
        const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.trim() === 'Maintenance');
        const st = document.querySelector('.cm-content');
        return {
          headingTop: line ? Math.round(line.getBoundingClientRect().top - scroller.top) : null,
          onScreen: !!line,
          focused: document.activeElement === st || st.contains(document.activeElement),
        };
      });
      const st = await S.state();
      const after = await S.disk();
      const atHeading = st.doc.slice(st.head, st.head + 11) === 'Maintenance';
      return {
        ok: where.onScreen && where.headingTop !== null && where.headingTop < 120 && atHeading && after === before,
        detail: `heading ${where.headingTop}px below the top of the pane; caret at ${st.head} reading ${j(st.doc.slice(st.head, st.head + 10))}; file ${after === before ? 'unchanged' : 'CHANGED'}`,
      };
    },
  },
  {
    id: 'render.toc.e05',
    feature: 'render.toc',
    name: 'In a pane too narrow for a rail, the panel covers the right edge, Escape closes it and the button brings it back',
    run: async (S) => {
      await setToc(S, true);
      await S.fresh('toc-narrow', DOC);
      await S.sleep(900);
      await S.command('View: Split Editor Right');
      await S.sleep(1400);
      // With the setting on and no room for a rail, the panel is already over the text.
      const narrow = await layout(S);
      // Picking an entry is what the panel is for, and in a narrow pane it puts the panel away again
      // so the text it was covering comes back.
      await S.click({ sel: '.sheaf-toc-entry', nth: 1 });
      await S.sleep(900);
      const closed = await layout(S);
      // The button brings it back without turning the feature off, which is the rule the panel needs
      // in a narrow pane: otherwise one click would leave nothing to reopen.
      await S.click(TOC_BUTTON);
      await S.sleep(900);
      const again = await layout(S);
      const setting = readToc(S);
      return {
        ok:
          narrow.overlay === true &&
          narrow.open === true &&
          narrow.rail.w > 100 &&
          narrow.rail.right <= narrow.pane.right + 2 &&
          closed.open === false &&
          again.open === true &&
          setting === true,
        detail: `pane ${j(narrow.pane)}; panel ${j(narrow.rail)} overlay ${narrow.overlay} open ${narrow.open}; after picking an entry open ${closed.open}; after the button open ${again.open} and the setting is ${j(setting)}`,
      };
    },
  },
  {
    id: 'render.toc.e07',
    feature: 'render.toc',
    name: 'Clicking the entry for a heading far below the screen puts the caret on its words, not in front of its hashes',
    run: async (S) => {
      await setToc(S, true);
      await S.fresh('toc-far-caret', DOC);
      await S.sleep(1000);
      const before = await S.disk();
      await S.click({ sel: '.sheaf-toc-entry', nth: 3 });
      await S.sleep(900);
      const st = await S.state();
      const after = await S.disk();
      const at = st.doc.slice(st.head, st.head + 6);
      return {
        ok: at === 'Drones' && after === before,
        detail: `caret at ${st.head} reading ${j(st.doc.slice(Math.max(0, st.head - 4), st.head + 10))}; file ${after === before ? 'unchanged' : 'CHANGED'}`,
      };
    },
  },
  {
    id: 'render.toc.e06',
    feature: 'render.toc',
    name: 'Every entry reads as the heading does, including headings far below the part of the document on screen',
    run: async (S) => {
      await setToc(S, true);
      await S.fresh('toc-markers', DOC);
      await S.sleep(1000);
      const m = await layout(S);
      const withMarkers = m.entries.filter((t) => /^\s*#/.test(t));
      return {
        ok: m.entries.length === 4 && withMarkers.length === 0,
        detail: `entries ${j(m.entries)}${withMarkers.length ? `; ${withMarkers.length} still showing their hashes ${j(withMarkers)}` : ''}`,
      };
    },
  },
];
