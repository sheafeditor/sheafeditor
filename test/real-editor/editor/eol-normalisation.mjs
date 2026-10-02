// Does VS Code normalise a file's line endings when it opens the document, or only over the range
// an edit replaces?
//
// This is the measurement the VS Code half of the mixed-endings defect waits on, and the two
// answers are different defects with different fixes. `planEdit` is fixed: it takes the endings
// for a replacement from the span being replaced, and a probe driving it directly reports every
// shape holding. A real
// window still moves the endings, because `markdownEditorProvider.ts:464` hands the replacement to
// `vscode.WorkspaceEdit.replace` and a `TextDocument` carries one EOL for the whole file.
//
// What nobody has established is **when** that one EOL is imposed:
//
//   on apply   only the replaced range is written in the document's EOL, so a narrow edit far from
//              an odd ending leaves it alone and the fix is about what reaches WorkspaceEdit
//   on open    the model already holds uniform text before anything is typed, so the first save
//              rewrites the whole file whatever the edit was, and the span is beside the point
//
// The gesture that separates them is a **one-character** edit, deliberately far from the odd
// ending and carrying no newline of its own. Under "on apply" it cannot touch any ending at all.
// Under "on open" it rewrites every one of them.
//
// A replace-all cannot answer this, which is why `menus.find-replace.e10` does not: its span is
// wide enough to cover the endings either way, so both answers look the same.
//   node test/real-editor/run-editor.mjs eol-normalisation [id]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

/** Every line break in order, by what it is made of. */
const endings = (t) => [...t.matchAll(/\r\n|\r|\n/g)].map((m) => (m[0] === '\r\n' ? 'crlf' : m[0] === '\r' ? 'cr' : 'lf'));

/*
 * First ending LF, the rest CRLF, which is the shape both hosts read as an LF file because the
 * style is taken from the first line ending. The word to change is on the last line, as far from
 * that odd ending as the fixture allows.
 */
const MIXED = 'one kiwi\n' + ['beta line', 'gamma line', 'delta line', 'last word here'].join('\r\n') + '\r\n';
const UNIFORM = 'one kiwi\r\n' + ['beta line', 'gamma line', 'delta line', 'last word here'].join('\r\n') + '\r\n';
/*
 * The same mixed shape with a table in it, for the one case that needs something of the person's to
 * be unsaved when a write from outside lands. A table is written when focus leaves it, so typing in
 * an open cell is unsaved for as long as the cell is open; prose auto-saves too quickly to arrange.
 */
const MIXED_TABLE = 'one kiwi\n' + ['', '| n | v |', '| - | - |', '| a | 1 |', '| b | 2 |', '', 'tail line'].join('\r\n') + '\r\n';

export const scenarios = [
  {
    id: 'host.edit-sync.eol-on-open-or-on-apply',
    feature: 'host.edit-sync',
    name: 'One character typed far from a file’s odd line ending: the other endings are untouched, so the document is not normalised on open',
    /*
     * Marked because the behaviour is real, open, and in a layer Sheaf does not own, so this lands
     * reporting it by name and fails the run on the day it starts passing.
     *
     * The same gesture in a browser tab keeps every ending, so the editor and the edit planner are
     * not what does this. A uniformly CRLF file is untouched in both hosts, which is the control.
     */
    known:
      'in the VS Code host one character typed anywhere rewrites every line ending in a file whose endings '
      + 'are not all the same, because the document model carries one ending for the whole file and the first '
      + 'write flushes it; opening the file alone changes nothing, and a browser tab keeps every ending',
    run: async (S) => {
      /*
       * Three readings, in this order, because each is the precondition for the next.
       *
       *   1  the bytes after opening and before any edit, which answers whether merely opening the
       *      file is enough to rewrite it. Sheaf saves on its own, so this is a real question and
       *      not a formality
       *   2  the bytes after one character is typed on the last line
       *   3  the same gesture in a file that is uniformly CRLF, which is the control: it says the
       *      character landed and that this reader can see a file come out as it went in
       */
      await S.fresh('eol-mixed', MIXED);
      await S.sleep(900);
      const onOpen = await S.disk();

      await S.caret('last word here', 14);
      await S.sleep(300);
      await S.type('Z');
      await S.sleep(1200);
      const afterEdit = await S.disk();

      const before = endings(MIXED);
      const opened = endings(onOpen);
      const edited = endings(afterEdit);
      const sameList = (a, b) => a.length === b.length && a.every((e, i) => e === b[i]);

      const openRewrote = !sameList(before, opened);
      const editRewrote = !sameList(opened, edited);
      const landed = /last word hereZ/.test(afterEdit);

      return {
        ok: landed && !openRewrote && !editRewrote,
        detail:
          `endings written ${j(before)}; ` +
          `${openRewrote ? `AFTER OPENING ALONE ${j(opened)}, so opening the document rewrote the file` : 'unchanged by opening'}; ` +
          `${landed ? 'the Z landed on the last line' : 'THE Z DID NOT LAND, so nothing below is a reading'}; ` +
          `${editRewrote ? `AFTER ONE CHARACTER ${j(edited)}, so the model holds one ending for the whole file and the first save imposes it` : 'unchanged by a one-character edit, so only a replaced range is converted'}; ` +
          `file ${j(afterEdit)}`,
      };
    },
  },
  {
    id: 'host.edit-sync.eol-control-uniform-file',
    feature: 'host.edit-sync',
    name: 'CONTROL: the same one character in a file that is uniformly CRLF leaves every ending as it was',
    run: async (S) => {
      /*
       * Without this, "the endings did not change" above is also what a run reports when the
       * character never arrived, when the file was never saved, or when this reader cannot tell
       * one ending from another. Here the ending list must come out identical **and** the Z must
       * be in the file, which is the pair that makes the reading above mean something.
       */
      await S.fresh('eol-uniform', UNIFORM);
      await S.sleep(900);
      await S.caret('last word here', 14);
      await S.sleep(300);
      await S.type('Z');
      await S.sleep(1200);
      const d = await S.disk();
      const before = endings(UNIFORM);
      const after = endings(d);
      const same = before.length === after.length && before.every((e, i) => e === after[i]);
      const landed = /last word hereZ/.test(d);
      return {
        ok: same && landed,
        detail:
          `${landed ? 'the Z landed' : 'THE Z DID NOT LAND'}; ` +
          `endings ${j(before)} -> ${j(after)}${same ? ' same' : ' CHANGED, so a uniform file does not survive either'}; ` +
          `file ${j(d)}`,
      };
    },
  },
  {
    /*
     * What a change arriving **from outside** does to a mixed file's endings, which is the one corner
     * of this question nobody had driven. The public files-and-saving page says the endings survive an
     * outside change; the requirements say nothing about endings at all; the code sends an outside
     * merge through `vscode.WorkspaceEdit.replace`, the same path that cannot keep them. One of those
     * three is wrong and only a reading says which.
     *
     * Two cases, because "an outside change" is two different things to the write path:
     *
     *   nothing unsaved   the arriving text is taken and nothing is written back, so the endings can
     *                     only survive. This is the case the page's sentence is plainly true of
     *   a merge          the person's typing has reached disk and a tool then writes the whole file
     *                     from text it read before that. Sheaf merges and writes the result, and that
     *                     write is the one that goes through the model
     *
     * A reading rather than an assertion about which answer is right, as the plain-editor scenario
     * below is: what the page should say is a product call once the fact is known, and the opposite
     * result is interesting too, because an outside merge that kept the endings would mean that path is
     * not going through the model the way the ledger says.
     *
     * What it does assert is that the measurement happened: the arriving text reached the editor in
     * both cases, and in the merge case the person's own character is still in the file. Without those
     * the ending list says nothing, which is the failure these scenarios keep finding in each other.
     */
    id: 'host.outside-change.eol-after-a-change-from-outside',
    feature: 'host.outside-change',
    name: 'Reading: what a change from outside does to a mixed file’s line endings, with nothing unsaved and across a merge',
    run: async (S) => {
      /** Wait until the editor's own document holds `text`, which is what says the write arrived. */
      const held = async (text) => {
        for (let i = 0; i < 120; i++) {
          const st = await S.state().catch(() => null);
          if (st && typeof st.doc === 'string' && st.doc.includes(text)) return true;
          await S.sleep(50);
        }
        return false;
      };
      const started = endings(MIXED);
      const sameAsStart = (t) => {
        const e = endings(t);
        return e.length === started.length && e.every((x, i) => x === started[i]);
      };

      // Case one: nothing of the person's is unsaved, so there is nothing to merge.
      const path = await S.fresh('eol-outside-plain', MIXED);
      await S.sleep(900);
      const onOpen = await S.disk(path);
      const arriving = MIXED.replace('gamma line', 'gamma CHANGED');
      writeFileSync(path, arriving);
      const arrivedPlain = await held('gamma CHANGED');
      await S.sleep(1200); // Past any auto-save the arrival might provoke.
      const afterPlain = await S.disk(path);

      /*
       * Case two: a real merge, which needs something of the person's to be unsaved when the write
       * lands. A table cell is the way to get one: a table is written when focus leaves it, so typing
       * in an open cell is unsaved for as long as the cell is open, and the write arrives into that.
       *
       * The first draft of this did it in prose instead: type, wait for auto-save, then write stale
       * text. That is not a merge and the reading said so. With the typing already on disk the document
       * is clean, the arriving text is taken whole, and the person's character goes with it, which is
       * the race `staleWrite` in `table-ops.mjs` is about and a different question from this one. The
       * reading would have read as "the merge lost the character" if it had not also asked whether a
       * merge happened.
       */
      const mixedStarted = endings(MIXED_TABLE);
      const sameAsTable = (t) => {
        const e = endings(t);
        return e.length === mixedStarted.length && e.every((x, i) => x === mixedStarted[i]);
      };
      const path2 = await S.fresh('eol-outside-merge', MIXED_TABLE);
      await S.sleep(1000);
      await S.dblclick({ sel: '.sheaf-table [data-r="0"][data-c="1"]' });
      await S.sleep(500);
      const cellOpen = await S.exists('.sheaf-table-input');
      await S.type('9');
      await S.sleep(300);
      const stale = MIXED_TABLE.replace('tail line', 'tail CHANGED');
      writeFileSync(path2, stale);
      const arrivedStale = await held('tail CHANGED');
      await S.sleep(2500); // The merge is worked out and written back.
      const afterMerge = await S.disk(path2);
      /*
       * Both halves read out of the file rather than predicted. The first draft asked for `| a | 1 |`
       * or `| a | 19 |`, on the assumption that typing into an open cell appends; a double-click picks
       * the cell's whole value and the typing replaces it, so the row is `| a | 9 |` and the reading
       * said a merge had not happened when one had.
       */
      const aRow = afterMerge.split(/\r\n|\n/).find((l) => /^\|\s*a\s*\|/.test(l)) ?? '(no row for a)';
      const typedLanded = /^\|\s*a\s*\|\s*9\s*\|/.test(aRow);
      const outsideLanded = afterMerge.includes('tail CHANGED');
      const bothSurvived = typedLanded && outsideLanded;

      return {
        ok: arrivedPlain && cellOpen && arrivedStale && bothSurvived,
        detail:
          `endings written ${j(started)}; on open ${sameAsStart(onOpen) ? 'unchanged' : `ALREADY ${j(endings(onOpen))}`}; ` +
          `${arrivedPlain ? 'the plain outside change reached the editor' : 'THE PLAIN OUTSIDE CHANGE NEVER REACHED THE EDITOR, so its reading says nothing'} ` +
          `and the file is then ${sameAsStart(afterPlain) ? 'unchanged, so the endings survive an outside change nobody merged' : `${j(endings(afterPlain))}, SO THEY DO NOT`}; ` +
          `across a merge: ${cellOpen ? 'the cell was open with the typing unsaved' : 'THE CELL NEVER OPENED, so nothing was unsaved and this is not a merge'}, ` +
          `${arrivedStale ? 'the stale write reached the editor' : 'THE STALE WRITE NEVER REACHED THE EDITOR'}, ` +
          `the row for a reads ${j(aRow)} and the tail ${outsideLanded ? 'carries the outside change' : 'DOES NOT carry the outside change'}, ` +
          `${bothSurvived ? 'so a merge happened' : 'so this is a write that won rather than a merge'} ` +
          `and the endings are ${sameAsTable(afterMerge) ? 'unchanged, so a merge write keeps them and it is not going through the model the way the ledger says' : `${j(endings(afterMerge))}, so the merge write imposes the document's one ending`}; ` +
          `file ${j(afterMerge)}`,
      };
    },
  },

  /*
   * The same file in VS Code's own text editor, which decides whose defect this is.
   *
   * The two scenarios above establish that a window loses a mixed file's odd ending and a tab keeps
   * it. Neither can say whether that is something Sheaf does or something a `TextDocument` does to
   * anybody who holds one, and the answer changes the work completely: a model that normalises for
   * its own editor too is a constraint every custom editor inherits, and the only remaining choice
   * is whether to write bytes directly, as `markdownEditorProvider.ts` already does for a data file.
   *
   * A `.txt` is the route, because Sheaf claims that type only when asked, so Quick Open and Enter
   * reach the plain editor rather than this extension. Nothing about the file's name reaches the
   * document model, so the measurement is about the model and not about Markdown.
   *
   * Sheaf is not in the path at all here, which is the point and also why this scenario saves by
   * hand: there is no auto-save without the extension.
   */
  {
    id: 'host.edit-sync.eol-plain-editor-does-the-same',
    feature: 'host.edit-sync',
    name: "Reading: the same mixed file in VS Code's own text editor, to say whether the model normalises for everybody",
    run: async (S) => {
      const file = join(S.ws, 'e2e', 'eol-plain.txt');
      writeFileSync(file, MIXED);
      await S.sleep(300);

      /* Quick Open and Enter, as a double-click does, with nothing after it. */
      const active = S.page.locator('.editor-group-container.active .tabs-container .tab.active').first();
      if (await active.isVisible().catch(() => false)) await active.click().catch(() => {});
      await S.page.keyboard.press('Meta+p');
      await S.page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 8000 });
      await S.page.keyboard.type('e2e/eol-plain.txt', { delay: 5 });
      await S.sleep(800);
      await S.page.keyboard.press('Enter');
      await S.sleep(1500);

      // Which editor answered, read rather than assumed: a `.txt` Sheaf had been asked to claim
      // would make this a measurement of Sheaf wearing a different file extension.
      const plain = await S.page
        .evaluate(() => !!document.querySelector('.editor-group-container.active .monaco-editor .view-lines'))
        .catch(() => false);
      const sheafFrames = S.page.frames().length;

      const onOpen = readFileSync(file, 'utf8');
      await S.page.keyboard.press('Meta+End');
      await S.sleep(200);
      await S.page.keyboard.type('Z', { delay: 20 });
      await S.sleep(300);
      await S.page.keyboard.press('Meta+s');
      await S.sleep(1200);
      const after = readFileSync(file, 'utf8');

      const started = endings(MIXED);
      const opened = endings(onOpen);
      const ended = endings(after);
      const landed = after.includes('Z');
      const same = started.length === ended.length && started.every((e, i) => e === ended[i]);

      /*
       * A reading, not a verdict, so it passes whichever way the model behaves and reports which.
       * What would make it fail is the measurement not happening: the plain editor not being the one
       * on screen, or the character never reaching the file, because then the ending list says
       * nothing. That is the pair the control above exists to protect and this one carries its own.
       */
      return {
        ok: plain && landed,
        detail:
          `${plain ? "VS Code's own editor answered" : 'THE PLAIN EDITOR WAS NOT ON SCREEN, so nothing below is about it'}` +
          ` (${sheafFrames} frame(s)); ${landed ? 'the Z landed' : 'THE Z DID NOT LAND'}; ` +
          `on disk at open ${j(opened)} ${opened.join() === started.join() ? 'unchanged' : 'ALREADY CHANGED'}; ` +
          `after one character and a save ${j(ended)} ` +
          `${same ? 'UNCHANGED, so the model keeps a mixed file for its own editor and the loss is ours' : 'CHANGED, so the model normalises for everybody and this is inherited'}`,
      };
    },
  },
];
