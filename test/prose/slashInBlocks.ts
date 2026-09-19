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

/** Type `typed` at column `column` of line `line` of `doc`, press Enter, and return the document. */
function pickAt(doc: string, line: number, column: number, typed: string): string {
  const p = mountProse(doc);
  p.select(lineStart(doc, line) + column);
  type(p, typed);
  p.press('Enter');
  const out = p.doc();
  p.destroy();
  return out;
}

const QUOTE = '> alpha line\n> beta line';
const ITEM = '- alpha line\n  beta line';

export const scenarios: Scenario[] = [
  {
    name: "a slash heading on a quote's second line becomes a heading inside the quote",
    run: () => {
      const p = mountProse(QUOTE);
      p.select(lineStart(QUOTE, 2) + 2);
      type(p, '/h2');
      const menu = slashMenuOf(p.view.state);
      const highlighted = menu?.items[menu.selected].label === 'Heading 2';
      p.press('Enter');
      const reported = p.doc() === '> alpha line\n> ## beta line';
      p.destroy();
      return (
        highlighted &&
        reported &&
        pickAt('> alpha\n> beta\n> gamma  ', 2, 2, '/h1') === '> alpha\n> # beta\n> gamma  ' &&
        pickAt('> [!NOTE]\n> alpha\n> beta', 3, 2, '/h3') === '> [!NOTE]\n> alpha\n> ### beta' &&
        pickAt('> alpha\nbeta', 2, 0, '/h2') === '> alpha\n> ## beta'
      );
    },
  },
  {
    name: "a slash heading on a list item's continuation line becomes a heading inside the item",
    run: () =>
      pickAt(ITEM, 2, 2, '/h2') === '- alpha line\n  ## beta line' &&
      pickAt('1. alpha\n   beta\n2. gamma', 2, 3, '/h2') === '1. alpha\n   ## beta\n2. gamma' &&
      pickAt('- a\n  - alpha\n    beta', 3, 4, '/h2') === '- a\n  - alpha\n    ## beta' &&
      pickAt('> - alpha\n>   beta', 2, 4, '/h2') === '> - alpha\n>   ## beta' &&
      pickAt('- a\n  > b\n  > c', 3, 4, '/h2') === '- a\n  > b\n  > ## c',
  },
  {
    name: "slash list, quote, code and text picks on a quote's or item's later line keep the container prefix",
    run: () =>
      pickAt(QUOTE, 2, 2, '/bul') === '> alpha line\n> - beta line' &&
      pickAt(QUOTE, 2, 2, '/numbered') === '> alpha line\n> 1. beta line' &&
      pickAt(QUOTE, 2, 2, '/task') === '> alpha line\n> - [ ] beta line' &&
      pickAt(QUOTE, 2, 2, '/quote') === '> alpha line\n> > beta line' &&
      pickAt(QUOTE, 2, 2, '/code') === '> alpha line\n> ```\n> beta line\n> ```' &&
      pickAt(QUOTE, 2, 2, '/text') === QUOTE &&
      pickAt(ITEM, 2, 2, '/bul') === '- alpha line\n  - beta line' &&
      pickAt(ITEM, 2, 2, '/numbered') === '- alpha line\n  1. beta line' &&
      pickAt(ITEM, 2, 2, '/task') === '- alpha line\n  - [ ] beta line' &&
      pickAt(ITEM, 2, 2, '/quote') === '- alpha line\n  > beta line' &&
      pickAt(ITEM, 2, 2, '/code') === '- alpha line\n  ```\n  beta line\n  ```' &&
      pickAt(ITEM, 2, 2, '/text') === ITEM,
  },
  {
    name: "a slash pick on a quote's first line converts that line and leaves the lines below quoted",
    run: () =>
      pickAt('Intro\n\n> alpha line\n> beta line\n\nEnd', 3, 2, '/h2') === 'Intro\n\n## alpha line\n> beta line\n\nEnd' &&
      pickAt(QUOTE, 1, 2, '/h2') === '## alpha line\n> beta line' &&
      pickAt(QUOTE, 1, 2, '/bul') === '- alpha line\n> beta line' &&
      pickAt(QUOTE, 1, 2, '/text') === 'alpha line\n> beta line' &&
      // A quote of one line has no other line to keep, so it converts whole.
      pickAt('> alpha line', 1, 2, '/h2') === '## alpha line' &&
      // A list item's continuation line carries no marker of its own, so it was never at risk.
      pickAt(ITEM, 1, 2, '/h2') === '## alpha line\n  beta line',
  },
];
