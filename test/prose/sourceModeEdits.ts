/*
 * Every repair the editor makes to a construct stands down on a line showing its
 * Markdown.
 *
 * Sheaf now answers several keystrokes by moving them: a space typed at the inner
 * edge of `**bold**` goes to the outside, Enter inside it closes and reopens the
 * run, and typing above a `---` keeps a blank line between them. Each exists for
 * the same reason, which is that the person cannot see the characters they are
 * typing next to.
 *
 * On a line showing its source they can see all of them. There the `**` is the
 * thing being edited, and moving a typed space past it, or rearranging delimiters
 * around a line break, is the editor overruling somebody who is looking straight
 * at the markup. Whole-document source mode and Edit Markdown on one line are
 * both asked for precisely to get at those characters.
 *
 * Every scenario here is a pair: the same gesture in source mode and in the
 * normal view. The source-mode half is the rule; the normal half is the control,
 * and without it a guard that switched the behaviour off everywhere would pass
 * this file completely.
 */

import { Scenario, mountProse, Prose } from '../harness';
import { EditorView } from '@codemirror/view';
import { setDocumentSourceMode, setLivePreviewConfig } from '../../src/webview/livePreview';

/** Type `text` the way CodeMirror's own input path does, input handlers included. */
function type(p: Prose, text: string): void {
  const { state } = p.view;
  const { from, to } = state.selection.main;
  for (const handler of state.facet(EditorView.inputHandler)) {
    if (handler(p.view, from, to, text, () => state.update({ changes: { from, to, insert: text } }))) return;
  }
  p.view.dispatch(state.update({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' }));
}

/**
 * Run `act` at `at` and return the file afterwards, in one of the three states a line can be
 * in: drawn, whole-document source mode, or reveal-on-line.
 *
 * The third is the one that was missing, and its absence is why a guard that could not see
 * reveal-on-line went unnoticed for as long as it did. With the setting on, the caret's block
 * shows its markers, so the person is looking at exactly what source mode shows them and every
 * repair here should stand down for the same reason.
 */
function after(doc: string, at: number, how: 'drawn' | 'source' | 'reveal', act: (p: Prose) => void): string {
  if (how === 'reveal') setLivePreviewConfig({ revealSyntaxOnLine: true });
  const p = mountProse(doc);
  try {
    if (how === 'source') setDocumentSourceMode(p.view, p.view.dom, true);
    p.select(at);
    act(p);
    return p.doc();
  } finally {
    p.destroy();
    if (how === 'reveal') setLivePreviewConfig({ revealSyntaxOnLine: false });
  }
}

/**
 * One gesture, asked twice. `sourceWants` is what the file must hold with the
 * markers on screen, and `drawnWants` is what it must hold without them, which is
 * the control: the two must differ, or the scenario is proving nothing.
 */
interface Pair {
  name: string;
  doc: string;
  at: number;
  act: (p: Prose) => void;
  sourceWants: string;
  drawnWants: string;
}

const PAIRS: Pair[] = [
  {
    name: 'a space at the inner edge of bold',
    doc: 'Before **bold** after\n',
    at: 9,
    act: (p) => type(p, ' '),
    sourceWants: 'Before ** bold** after\n',
    drawnWants: 'Before  **bold** after\n',
  },
  {
    name: 'Enter inside bold',
    doc: 'Before **bold** after\n',
    at: 11,
    act: (p) => p.press('Enter'),
    sourceWants: 'Before **bo\nld** after\n',
    drawnWants: 'Before **bo**\n**ld** after\n',
  },
  {
    name: 'typing on the line above a divider',
    doc: 'Body above.\n\n---\n',
    at: 12,
    act: (p) => type(p, 'X'),
    sourceWants: 'Body above.\nX\n---\n',
    drawnWants: 'Body above.\nX\n\n---\n',
  },
  {
    name: 'typing on a code fence',
    doc: 'Lead in.\n\n```js\nconst a = 1;\n```\n',
    at: 11,
    act: (p) => type(p, 'X'),
    sourceWants: 'Lead in.\n\n`X``js\nconst a = 1;\n```\n',
    drawnWants: 'Lead in.\n\nX\n```js\nconst a = 1;\n```\n',
  },
];

export const scenarios: Scenario[] = PAIRS.map((pair) => ({
  name: `${pair.name} is left alone on a line showing its Markdown`,
  run: () => {
    const inSource = after(pair.doc, pair.at, 'source', pair.act);
    const inDrawn = after(pair.doc, pair.at, 'drawn', pair.act);
    /*
     * Reveal-on-line wants the same answer as source mode, because the person is looking at
     * the same characters. It is asked separately because the guards used to ask a predicate
     * that could not see this setting, so all eleven of them repaired a construct whose
     * markers were on the screen. Without this third reading the fix for that is unprovable:
     * every suite in the repository was green both before it and after it.
     */
    const inReveal = after(pair.doc, pair.at, 'reveal', pair.act);
    const sourceOk = inSource === pair.sourceWants;
    const drawnOk = inDrawn === pair.drawnWants;
    const revealOk = inReveal === pair.sourceWants;
    return {
      // The drawn answer differing from the other two is part of the check: if a guard
      // switched the repair off everywhere, all three would agree and only this would notice.
      ok: sourceOk && drawnOk && revealOk && pair.sourceWants !== pair.drawnWants,
      detail:
        `showing source ${sourceOk ? 'left it alone' : `gave ${JSON.stringify(inSource)} rather than ${JSON.stringify(pair.sourceWants)}`}; ` +
        `reveal-on-line ${revealOk ? 'left it alone' : `gave ${JSON.stringify(inReveal)} rather than ${JSON.stringify(pair.sourceWants)}`}; ` +
        `drawn ${drawnOk ? 'repaired it' : `gave ${JSON.stringify(inDrawn)} rather than ${JSON.stringify(pair.drawnWants)}`}`,
    };
  },
}));
