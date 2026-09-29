/*
 * Every feature a person can read about has something in the corpus to open.
 *
 *   node scripts/check-samples.mjs
 *
 * `docs/features/` is the documentation a reader gets, and `sample/` is where they, or a
 * contributor, or a session reproducing a bug, goes to see the thing working. Those two
 * drifted apart silently: views, boards, data files and `.txt` all shipped with a page and
 * nothing in the corpus, so each was documented for somebody who then had nothing to look at.
 * Nothing noticed, because nothing was comparing them.
 *
 * What this is not: a guess at which sample belongs to which page. Matching prose to
 * documents by keyword produces a check nobody trusts and everybody works around. The
 * mapping is written out below instead, and the check's real job is to fail when a page
 * appears that is in neither list, so a new feature has to be classified rather than
 * quietly becoming a gap.
 *
 * Three things make it fail:
 *
 *   - a feature page in neither list, so somebody has to say which it is
 *   - a sample named here that does not exist
 *   - a sample named here that `sample/README.md` does not link, since the index is what a
 *     person actually reads to find it
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The feature pages that describe something you can see in a document, and the corpus files
 * that show it. A page may name more than one.
 */
const SHOWN_IN = {
  'blocks.md': ['blocks.md'],
  'boards.md': ['views.md'],
  'callouts.md': ['edge/dialects.md'],
  'comments.md': ['docs/meeting-notes.md', 'edge/html-embedded.md'],
  'data-files.md': ['data/releases.csv', 'views.md'],
  'datatables.md': ['tables.md'],
  'diagrams.md': ['edge/dialects.md'],
  'footnotes.md': ['docs/rfc-0148-scheduling.md'],
  'formatting.md': ['text-formatting.md'],
  'front-matter.md': ['edge/front-matter.md'],
  'images.md': ['edge/images.md'],
  'links.md': ['text-formatting.md'],
  'maths.md': ['edge/dialects.md'],
  'table-of-contents.md': ['docs/rfc-0148-scheduling.md'],
  'tables.md': ['tables.md'],
  'views.md': ['views.md', 'edge/views.md'],
};

/**
 * The feature pages with nothing to put in the corpus, and why. These are interactions:
 * what happens when you press, drag, type or search, which a document cannot hold. A
 * scenario in `test/real-editor/` is where each of these is actually held to account.
 *
 * The reason is written out rather than implied, because "no sample" and "nobody got round
 * to a sample" look identical in a list of names.
 */
const NOT_A_DOCUMENT = {
  'files-and-saving.md': 'saving, reloading and what an outside write does: events over time, not marks in a file',
  'find-and-replace.md': 'the find bar and what stepping through matches does',
  'in-a-browser.md': 'serving a folder to a browser tab, which is a command rather than a construct',
  'menus.md': 'the right-click menu and the toolbar, and what their items do',
  'sharing.md': 'copying a reference to a block and sending it to a terminal',
  'slash-menu.md': 'what typing a slash offers and what choosing an item writes',
  'table-commands.md': 'the commands on a table: insert, delete, move, align, sort',
  'table-selection.md': 'picking cells, rows and columns with the pointer and the keyboard',
  'toolbar.md': 'the formatting toolbar over a selection',
  'typing-markdown.md': 'what Markdown typed into the editor turns into as you type',
};

const pages = readdirSync(join(REPO, 'docs', 'features')).filter((f) => f.endsWith('.md')).sort();
const index = readFileSync(join(REPO, 'sample', 'README.md'), 'utf8');
const problems = [];

for (const page of pages) {
  const shown = SHOWN_IN[page];
  const excused = NOT_A_DOCUMENT[page];
  if (!shown && !excused) {
    problems.push(
      `docs/features/${page} is in neither list in this check. Add the corpus file that shows it to SHOWN_IN, ` +
        `or, if it describes an interaction rather than something a document can hold, add it to NOT_A_DOCUMENT with the reason.`
    );
    continue;
  }
  if (shown && excused) {
    problems.push(`docs/features/${page} is in both lists in this check. It is one or the other.`);
    continue;
  }
  for (const file of shown ?? []) {
    if (!existsSync(join(REPO, 'sample', file))) {
      problems.push(`docs/features/${page} names sample/${file}, which does not exist.`);
      continue;
    }
    // The index is the thing a person reads to find a document, so a corpus file nothing
    // links to is only half there.
    if (!index.includes(`(${file})`)) {
      problems.push(`sample/${file} shows docs/features/${page} and sample/README.md does not link it.`);
    }
  }
}

// A sample named for a page that has since been deleted is a reference to nothing.
for (const page of Object.keys({ ...SHOWN_IN, ...NOT_A_DOCUMENT })) {
  if (!pages.includes(page)) {
    problems.push(`This check names docs/features/${page}, which no longer exists. Remove its entry.`);
  }
}

if (problems.length) {
  for (const p of problems) process.stderr.write(`${p}\n`);
  process.stderr.write(`\n${problems.length} problem(s) between docs/features/ and sample/\n`);
  process.exit(1);
}

const shownCount = Object.keys(SHOWN_IN).length;
const excusedCount = Object.keys(NOT_A_DOCUMENT).length;
process.stdout.write(
  `${pages.length} feature pages: ${shownCount} with a corpus document, ${excusedCount} interactions with none. Every named file exists and is in the index.\n`
);
