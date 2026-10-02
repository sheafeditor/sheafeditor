// Reported on 0.2.0: hovering shows the grip's "..." on the wrong block and clicks are offset,
// after a comment block, in a bullet list.
//
// Both symptoms are one arithmetic. `blockHandle.ts` finds the block under the pointer with
// `view.lineBlockAtHeight(event.clientY - view.documentTop)`, which is right so long as
// CodeMirror's height map is, and a block drawn at a height CodeMirror does not believe shifts
// every block after it for the grip and for a click alike.
//
// A browser tab does not reproduce it at the release commit, in three mechanisms: on first draw,
// after the stored fold state arrives and collapses the box, and after jumping to the end of a long
// document past comment boxes that were never drawn. CodeMirror keeps a measured height once it has
// drawn a block, so a short estimate shows as the page jumping rather than as a lasting offset, and
// the estimate is short, by up to 71px.
//
// This is the same question asked of a real VS Code window, which is where the report comes from.
// Two defects found on 2026-09-30 exist only because the hosts differ outside the shared bundle, so
// a window is the honest place to check a window's report.
//   node test/real-editor/run-editor.mjs comment-offset [id]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

/**
 * Set the window's zoom, which is the one lever that changes the ratio between a CSS pixel and the
 * device pixel the mouse is driven in.
 *
 * Worth varying because the grip's hover converts a pointer coordinate into a document height, and
 * every coordinate on that path is a CSS pixel until the driver's own, so a zoom is where a
 * conversion could be missed. A person who has pressed Cmd+= once is running zoomed and would not
 * think to mention it.
 */
async function zoom(S, level) {
  const path = join(S.run, 'user', 'User', 'settings.json');
  const cur = JSON.parse(readFileSync(path, 'utf8'));
  if (level === null) delete cur['window.zoomLevel'];
  else cur['window.zoomLevel'] = level;
  writeFileSync(path, JSON.stringify(cur, null, 2));
  await S.sleep(1800);
}

const LONG =
  'A comment line written long enough that it certainly wraps more than once inside the writing ' +
  'column, so its drawn height is several line heights where its estimate counts one.';

/** A comment block, then a bullet list, which is the shape reported. */
const DOC = `# Offset

A paragraph before the comment, which is the control: the grip must be right here too.

<!--
${LONG}
-->

- First bullet in the list
- Second bullet in the list
- Third bullet in the list
- Fourth bullet in the list

A paragraph after the list.
`;

/**
 * Which drawn line the grip's own middle falls inside, read in the frame's coordinates.
 *
 * Asked of the grip's box rather than of anything the plugin keeps, because what a person sees is
 * where the "..." came up, and the grip is positioned for the block the plugin chose.
 */
const gripOn = (S) =>
  S.eval(() => {
    const grip = document.querySelector('.sheaf-block-grip');
    const lines = [...document.querySelectorAll('.cm-content > .cm-line')].map((el) => ({
      text: (el.textContent ?? '').slice(0, 36),
      rect: el.getBoundingClientRect(),
    }));
    if (!grip) return { found: false, lines: lines.map((l) => l.text) };
    const r = grip.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { found: false, hidden: true, lines: lines.map((l) => l.text) };
    const mid = r.top + r.height / 2;
    let on = null;
    for (const l of lines) if (mid >= l.rect.top - 2 && mid <= l.rect.bottom + 2) on = l.text;
    return { found: true, on, mid: Math.round(mid) };
  });

export const scenarios = [
  {
    id: 'blocks.comment-offset.e01',
    feature: 'blocks.drag',
    name: 'Hovering a bullet after a comment block puts the grip beside that bullet and not another',
    run: async (S) => {
      /*
       * The control is the paragraph **before** the comment. If the grip is wrong there too then
       * the fault is not about the comment block and this scenario is measuring the hover route.
       * If it is right there and wrong after the box, the box's height is what moved everything.
       *
       * Every bullet is hovered rather than one, because an offset of one line and an offset of
       * three are different faults and a single reading cannot tell them apart.
       */
      await zoom(S, null);
      await S.fresh('comment-offset', DOC);
      await S.sleep(1200);

      const targets = [
        'A paragraph before the comment',
        'First bullet in the list',
        'Second bullet in the list',
        'Third bullet in the list',
        'Fourth bullet in the list',
        'A paragraph after the list.',
      ];
      const seen = [];
      for (const text of targets) {
        await S.hover({ text, offset: 1 });
        // Longer than `scheduleHide`'s 250ms in `blockHandle.ts`, or the grip from the previous
        // hover is still drawn and every reading is one target behind.
        await S.sleep(450);
        const g = await gripOn(S);
        seen.push({ text, grip: g.found ? g.on : g.hidden ? '(present, not drawn)' : '(no grip)' });
      }

      /*
       * Compared by what the line says rather than by how it starts. A bullet's drawn line reads
       * "\u2022First bullet in the list", with the marker the renderer draws prepended, so a prefix
       * match calls four correct readings wrong. The question is whether the grip came up beside
       * the line that was hovered, and a distinctive phrase from that line answers it.
       */
      const agree = (row) => typeof row.grip === 'string' && row.grip.includes(row.text.slice(0, 20));
      const control = seen[0];
      const wrong = seen.filter((r) => !agree(r));
      const ok = agree(control) && wrong.length === 0;
      return {
        ok,
        detail:
          `${seen.map((r) => `${j(r.text.slice(0, 24))} -> ${j(r.grip)}`).join('; ')}` +
          `${agree(control) ? '' : '  <- THE CONTROL IS WRONG, so this is not about the comment block'}` +
          `${wrong.length ? `  <- ${wrong.length} of ${seen.length} hovered blocks got the grip beside another block` : ''}`,
      };
    },
  },
  {
    id: 'blocks.comment-offset.e02',
    feature: 'blocks.drag',
    name: 'The same hover at a zoomed window still puts the grip beside the block under the pointer',
    run: async (S) => {
      /*
       * `e01` at the default zoom and this at a zoom of 1, which is the one lever that changes the
       * ratio between a CSS pixel and the device pixel the mouse is driven in. The grip's hover
       * turns a pointer coordinate into a document height, so a zoom is where a conversion could be
       * missed, and a person who has pressed Cmd+= once would not think to mention it.
       *
       * The zoom is put back at the end whatever happens, because a profile left zoomed would
       * change every scenario that runs after this one in the same window.
       */
      try {
        await zoom(S, 1);
        await S.fresh('comment-offset-zoom', DOC);
        await S.sleep(1400);
        const targets = [
          'A paragraph before the comment',
          'First bullet in the list',
          'Third bullet in the list',
          'A paragraph after the list.',
        ];
        const seen = [];
        for (const text of targets) {
          await S.hover({ text, offset: 1 });
          await S.sleep(450);
          const g = await gripOn(S);
          seen.push({ text, grip: g.found ? g.on : g.hidden ? '(present, not drawn)' : '(no grip)' });
        }
        const agree = (row) => typeof row.grip === 'string' && row.grip.includes(row.text.slice(0, 20));
        const control = seen[0];
        const wrong = seen.filter((r) => !agree(r));
        return {
          ok: agree(control) && wrong.length === 0,
          detail:
            `at window.zoomLevel 1: ${seen.map((r) => `${j(r.text.slice(0, 24))} -> ${j(r.grip)}`).join('; ')}` +
            `${agree(control) ? '' : '  <- THE CONTROL IS WRONG even zoomed, so this is not about the comment block'}` +
            `${wrong.length ? `  <- ${wrong.length} of ${seen.length} got the grip beside another block` : ''}`,
        };
      } finally {
        await zoom(S, null);
      }
    },
  },
];
