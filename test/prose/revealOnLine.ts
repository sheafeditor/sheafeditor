/*
 * Which constructs `revealSyntaxOnLine` actually puts on the screen.
 *
 * Every repair this editor makes to a construct is guarded by "is the person looking at the
 * markers", because all of those repairs exist for somebody who cannot see what they are typing
 * next to. The guards ask `showingSource`, and the decorations ask `lineActive`, and the two are
 * not the same question: `showingSource` answers source mode and an explicit reveal, and
 * `lineActive` answers those plus reveal-on-line.
 *
 * Whether that difference matters depends on a thing nobody had written down: **for which
 * constructs does reveal-on-line reveal anything at all.** Reading the call sites gives one answer
 * and a comment in `alerts.ts` gives the opposite for a callout, so this reads the screen instead.
 *
 * It is a reading rather than an assertion. Every row prints what is on the line with the caret on
 * it and the setting on, and the scenario fails only if the measurement did not happen: no rows, or
 * a construct that is not drawn as a construct in the first place. A row changing is a change in
 * the product and should be read, not failed, because which constructs open on the caret's line is
 * a design question and not a promise.
 */

import { Scenario, mountProse } from '../harness';
import { setLivePreviewConfig } from '../../src/webview/livePreview';

/** A document, the text whose line is put under the caret, and the raw marker to look for. */
const CASES: { what: string; doc: string; on: string; marker: string }[] = [
  { what: 'emphasis', doc: 'Intro.\n\nA **bold** word here.\n', on: 'bold', marker: '**' },
  { what: 'inline code', doc: 'Intro.\n\nA `code` span here.\n', on: 'code', marker: '`' },
  { what: 'a link', doc: 'Intro.\n\nA [label](page.md) here.\n', on: 'label', marker: '](' },
  { what: 'a heading marker', doc: 'Intro.\n\n## A heading here\n', on: 'heading', marker: '#' },
  { what: 'a hard break', doc: 'Intro.\n\nFirst line\\\nsecond line.\n', on: 'First line', marker: '\\' },
  { what: 'a horizontal rule', doc: 'Intro.\n\n---\n\nAfter.\n', on: '---', marker: '---' },
  { what: "a callout's marker line", doc: 'Intro.\n\n> [!NOTE]\n> Body.\n', on: '[!NOTE]', marker: '[!NOTE]' },
  { what: 'a code fence', doc: 'Intro.\n\n```js\nlet x = 1;\n```\n', on: '```js', marker: '```' },
];

export const scenarios: Scenario[] = [
  {
    name: 'reading: which constructs reveal-on-line puts on the screen, with the caret on their line',
    run: () => {
      setLivePreviewConfig({ revealSyntaxOnLine: true });
      const rows: string[] = [];
      const broken: string[] = [];
      try {
        for (const c of CASES) {
          const at = c.doc.indexOf(c.on);
          if (at < 0) {
            broken.push(`${c.what}: the fixture does not contain ${JSON.stringify(c.on)}`);
            continue;
          }
          const p = mountProse(c.doc);

          // With the caret elsewhere first, so "the marker is drawn" is not simply this editor
          // never hiding it. A construct that shows its markers either way tells us nothing about
          // the setting, and that is the shape this reading would otherwise report as a finding.
          p.select(0);
          const away = (p.view.contentDOM.textContent ?? '').includes(c.marker);

          p.select(at);
          const near = (p.view.contentDOM.textContent ?? '').includes(c.marker);
          p.destroy();

          if (away) {
            broken.push(`${c.what}: ${JSON.stringify(c.marker)} is on the screen with the caret away too, so this fixture cannot see the setting`);
            continue;
          }
          rows.push(`${c.what}: ${near ? 'REVEALED' : 'still hidden'}`);
        }
      } finally {
        setLivePreviewConfig({ revealSyntaxOnLine: true });
      }
      // Printed as well as returned, because a reading is only useful if somebody sees it and the
      // runner shows `detail` for a failure alone. A row changing is the signal here.
      for (const r of rows) console.log(`  reveal-on-line: ${r}`);
      return {
        ok: broken.length === 0 && rows.length === CASES.length,
        detail: broken.length ? `${broken.join('; ')}` : rows.join('; '),
      };
    },
  },
];
