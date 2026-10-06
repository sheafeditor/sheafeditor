/*
 * Prose editing tests (bundled for the jsdom runner in prose.test.mjs). Each file
 * under prose/ exports its scenarios; `runAll()` returns one result per scenario.
 */

import { Scenario, mountProse } from './harness';
import { findClusterBreak } from '@codemirror/state';
import { setLivePreviewConfig } from '../src/webview/revealState';
import { scenarios as highlight } from './prose/highlight';
import { scenarios as commands } from './prose/commands';
import { scenarios as format } from './prose/format';
import { scenarios as find } from './prose/find';
import { scenarios as selection } from './prose/selection';
import { scenarios as blocks } from './prose/blocks';
import { scenarios as contextmenu } from './prose/contextmenu';
import { scenarios as contextmenu2 } from './prose/contextmenu2';
import { scenarios as marks } from './prose/marks';
import { scenarios as turnInto } from './prose/turnInto';
import { scenarios as headingLevels } from './prose/headingLevels';
import { scenarios as slash } from './prose/slash';
import { scenarios as slashInBlocks } from './prose/slashInBlocks';
import { scenarios as linkPopoverMoves } from './prose/linkPopoverMoves';
import { scenarios as linkShortcuts } from './prose/linkShortcuts';
import { scenarios as linkClick } from './prose/linkClick';
import { scenarios as altArrow } from './prose/altArrow';
import { scenarios as blockModelFixes } from './prose/blockModelFixes';
import { scenarios as keys } from './prose/keys';
import { scenarios as renderInline } from './prose/renderInline';
import { scenarios as inlineHtml } from './prose/inlineHtml';
import { scenarios as lineToggles } from './prose/lineToggles';
import { scenarios as codeLanguages } from './prose/codeLanguages';
import { scenarios as tableGrip } from './prose/tableGrip';
import { scenarios as tableStyling } from './prose/tableStyling';
import { scenarios as renderBlocks } from './prose/renderBlocks';
import { scenarios as insertCommands } from './prose/insertCommands';
import { scenarios as blockDrag } from './prose/blockDrag';
import { scenarios as linkOpen } from './prose/linkOpen';
import { scenarios as linkPaste } from './prose/linkPaste';
import { scenarios as shortcutsOverlay } from './prose/shortcutsOverlay';
import { scenarios as images } from './prose/images';
import { scenarios as hardBreaks } from './prose/hardBreaks';
import { scenarios as revealBlock } from './prose/revealBlock';
import { scenarios as tripleClick } from './prose/tripleClick';
import { scenarios as selectionExtent } from './prose/selectionExtent';
import { scenarios as sourceMode } from './prose/sourceMode';
import { scenarios as strikethrough } from './prose/strikethrough';
import { scenarios as codeBlockSelection } from './prose/codeBlockSelection';
import { scenarios as toolbarControls } from './prose/toolbarControls';
import { scenarios as contentWidth } from './prose/contentWidth';
import { scenarios as alerts } from './prose/alerts';
import { scenarios as comments } from './prose/comments';
import { scenarios as frontMatterView } from './prose/frontMatterView';
import { scenarios as tableOfContents } from './prose/tableOfContents';
import { scenarios as maths } from './prose/maths';
import { scenarios as mermaid } from './prose/mermaid';
import { scenarios as changeMarks } from './prose/changeMarks';
import { scenarios as linkComplete } from './prose/linkComplete';
import { scenarios as footnotes } from './prose/footnotes';
import { scenarios as sourceModeEdits } from './prose/sourceModeEdits';
import { scenarios as literalMarks } from './prose/literalMarks';
import { scenarios as revealOnLine } from './prose/revealOnLine';
import { scenarios as linkTyping } from './prose/linkTyping';

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runAll(): Promise<Result[]> {
  const results: Result[] = [];
  for (const s of [
    ...highlight,
    ...commands,
    ...format,
    ...find,
    ...selection,
    ...blocks,
    ...contextmenu,
    ...contextmenu2,
    ...marks,
    ...turnInto,
    ...headingLevels,
    ...slash,
    ...slashInBlocks,
    ...linkPopoverMoves,
    ...linkShortcuts,
  ...linkClick,
    ...altArrow,
    ...blockModelFixes,
    ...keys,
    ...renderInline,
    ...inlineHtml,
    ...lineToggles,
    ...codeLanguages,
    ...tableGrip,
    ...tableStyling,
    ...renderBlocks,
    ...insertCommands,
    ...blockDrag,
    ...linkOpen,
    ...linkPaste,
    ...shortcutsOverlay,
    ...images,
    ...hardBreaks,
    ...revealOnLine,
    ...revealBlock,
    ...tripleClick,
    ...selectionExtent,
    ...sourceMode,
    ...strikethrough,
    ...codeBlockSelection,
    ...toolbarControls,
    ...contentWidth,
    ...alerts,
    ...comments,
    ...frontMatterView,
    ...tableOfContents,
    ...maths,
    ...mermaid,
    ...changeMarks,
    ...linkComplete,
    ...footnotes,
    ...sourceModeEdits,
    ...literalMarks,
    ...linkTyping,
  ] as Scenario[]) {
    /*
     * The live-preview config is a module-level variable, so a scenario that changes it and
     * does not change it back decides what every scenario after it runs in. Half the files
     * here restored it to `true`, which is not the product default, so the state a scenario
     * ran in depended on what ran before it rather than on anything it said.
     *
     * Reset before each one, so a scenario that says nothing gets what a person has and the
     * whole class of leak stops being possible rather than being discouraged. A scenario that
     * wants reveal-on-line still asks for it, and no longer has to put it back.
     */
    setLivePreviewConfig({ revealSyntaxOnLine: false });
    try {
      /*
       * A scenario returns a boolean, or `{ ok, detail }` when it has something to say about
       * how it failed. Both are read here, because reading only the boolean made an object
       * truthy: a check written in the second shape passed whatever it found, and one was.
       * The host runner had the same hole and was fixed the same way.
       */
      const result = await s.run();
      const ok = result && typeof result === 'object' ? (result as { ok: boolean }).ok === true : result === true;
      const said = result && typeof result === 'object' ? (result as { detail?: string }).detail : '';
      results.push({ name: s.name, ok, detail: ok ? '' : said || 'assertion failed' });
    } catch (e) {
      results.push({ name: s.name, ok: false, detail: 'threw: ' + (e as Error).message });
    }
  }
  return results;
}

/*
 * What Enter writes, at every caret position in a fixture, as bytes rather than as intent.
 *
 * Part 3 of the specification owes a table per command, and Enter is the one whose behaviour is
 * settled enough to state: four handlers run in a defined order and none of them waits on work that
 * is still being decided. "Enter splits a line keeping its runs" is a sentence; what it writes, with
 * the caret inside a bold span, is the thing another implementation can be held to.
 *
 * It reports rather than asserts, for the reason Part 2's tables did: a rule nobody has written down
 * cannot be checked against, and the point of this is to write it down. Once the table is in the
 * document, the comparison is one step from here.
 *
 * Mounted through `mountProse` so the full editing keymap is installed. A view built with the live
 * preview alone takes no keys at all, and a derivation against it would report that Enter does
 * nothing, everywhere, which reads like a finding.
 */
export function keyMap(
  text: string,
  key = 'Enter'
): { pos: number; line: number; col: number; before: string; after: string; handled: boolean }[] {
  const out: { pos: number; line: number; col: number; before: string; after: string; handled: boolean }[] = [];
  const probe = mountProse(text);
  const lines = probe.view.state.doc.lines;
  probe.destroy();
  for (let n = 1; n <= lines; n++) {
    // A fresh editor per position, because Enter changes the document and the next position would
    // then be measured against a document this derivation made rather than the fixture.
    const first = mountProse(text);
    const line = first.view.state.doc.line(n);
    /*
     * The middle position has to land on a character boundary, and the first version did not make it.
     *
     * `(from + to) / 2` is a UTF-16 offset, so on a line holding an emoji it can fall between the two
     * halves of a surrogate pair. Pressing a key from there produced an unpaired surrogate in the
     * result, and I read that as the editor writing invalid content into the document. It was this
     * line: the caret was never at a place a caret can be. A derivation that puts the caret where a
     * person cannot reports faults the product does not have, and it reports them in the most
     * alarming form available.
     */
    let off = 0;
    const want = Math.floor((line.to - line.from) / 2);
    while (off < want) {
      const next = findClusterBreak(line.text, off, true);
      if (next <= off) break;
      off = next;
    }
    const ends = [...new Set([line.from, line.from + Math.min(off, line.text.length), line.to])];
    first.destroy();
    for (const pos of ends) {
      const p = mountProse(text);
      const l = p.view.state.doc.lineAt(pos);
      p.select(pos);
      p.view.focus();
      /*
       * Whether a binding took the key, carried alongside the bytes.
       *
       * Without it "the document did not change" has two causes that print the same: a handler ran
       * and decided to write nothing, and no handler wanted the key at all. The first is a rule and
       * the second is a gap, and a table that cannot tell them apart invites a reader to assume
       * whichever suits them. `press` already returns it from `runScopeHandlers`; the first version
       * of this threw it away.
       */
      const handled = p.press(key);
      out.push({
        pos,
        line: l.number,
        col: pos - l.from,
        before: l.text,
        after: p.doc(),
        handled,
      });
      p.destroy();
    }
  }
  return out;
}

/** `keyMap` with Enter, which is the table Part 3 states today. */
export function enterMap(text: string) {
  return keyMap(text, 'Enter');
}
