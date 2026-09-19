import { EditorState } from '@codemirror/state';
import { Scenario, Prose, mountProse } from '../harness';
import { slashMenuOf } from '../../src/webview/blocks';

/** Type text at the caret one character at a time, as keyboard input arrives. */
function type(p: Prose, text: string): void {
  for (const ch of text) {
    const head = p.view.state.selection.main.head;
    p.view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: 'input.type' });
  }
}

const lineStart = (doc: string, n: number): number => EditorState.create({ doc }).doc.line(n).from;

/** Type `typed` at the start of line `line` of `doc`, press Enter, and return the document. */
function pickAtLine(doc: string, line: number, typed: string): string {
  const p = mountProse(doc);
  p.select(lineStart(doc, line));
  type(p, typed);
  p.press('Enter');
  const out = p.doc();
  p.destroy();
  return out;
}

export const scenarios: Scenario[] = [
  {
    name: "a slash heading on a paragraph's middle line converts only that line",
    run: () => {
      const doc = 'first line of text\nsecond line of text';
      const p = mountProse(doc);
      p.select(lineStart(doc, 2));
      type(p, '/h2');
      const menu = slashMenuOf(p.view.state);
      const highlighted = menu?.items[menu.selected].label === 'Heading 2';
      p.press('Enter');
      const reported = p.doc() === 'first line of text\n## second line of text';
      p.destroy();
      return (
        highlighted &&
        reported &&
        pickAtLine('one  \ntwo\nthree', 2, '/h2') === 'one  \n## two\nthree' &&
        pickAtLine('one\ntwo\nthree', 3, '/h1') === 'one\ntwo\n# three' &&
        pickAtLine('one\ntwo', 1, '/h3') === '### one\ntwo'
      );
    },
  },
  {
    name: "slash list, quote, code and text picks on a paragraph's middle line convert only that line",
    run: () => {
      const doc = 'one  \ntwo\nthree';
      return (
        pickAtLine(doc, 2, '/bul') === 'one  \n- two\nthree' &&
        pickAtLine(doc, 2, '/numbered') === 'one  \n1. two\nthree' &&
        pickAtLine(doc, 2, '/task') === 'one  \n- [ ] two\nthree' &&
        pickAtLine(doc, 2, '/quote') === 'one  \n> two\nthree' &&
        pickAtLine(doc, 2, '/code') === 'one  \n```\ntwo\n```\nthree' &&
        pickAtLine(doc, 2, '/text') === doc &&
        pickAtLine(doc, 2, '/divider') === 'one  \ntwo\n\n---\n\nthree'
      );
    },
  },
];
