/*
 * Triple-click selects the paragraph under the pointer: its text on every source
 * line it spans, without a list marker, quote marker, heading marks or the line
 * break after it. A real click needs layout to become a document position, which
 * jsdom has none of, so these call the selection with the position a click on the
 * named word would produce. The mousedown that calls it lives in `main.ts`.
 */

import { Scenario, mountProse, Prose } from '../harness';
import { paragraphRangeAt, selectParagraphAt } from '../../src/webview/paragraphSelect';

/** Text of the current selection. */
const selected = (p: Prose): string => {
  const sel = p.view.state.selection.main;
  return p.view.state.sliceDoc(sel.from, sel.to);
};

/** Replace the selection, as typing a character over it does. */
const type = (p: Prose, text: string): void => {
  const sel = p.view.state.selection.main;
  p.view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    userEvent: 'input.type',
  });
};

/** Triple-click two characters into `word` (its first occurrence), and return what is selected. */
const tripleClick = (doc: string, word: string, offset = 2): { p: Prose; text: string; claimed: boolean } => {
  const p = mountProse(doc);
  const claimed = selectParagraphAt(p.view, doc.indexOf(word) + offset);
  return { p, text: selected(p), claimed };
};

/** A scenario whose triple-click on `word` must select exactly `want`. */
const selects = (name: string, doc: string, word: string, want: string, offset = 2): Scenario => ({
  name,
  run: () => {
    const { p, text, claimed } = tripleClick(doc, word, offset);
    p.destroy();
    const ok = claimed && text === want;
    if (!ok) console.log(`  ${name}: selected ${JSON.stringify(text)}, want ${JSON.stringify(want)}`);
    return ok;
  },
});

export const scenarios: Scenario[] = [
  selects(
    'triple-click selects a one-line paragraph without the line break after it',
    'Before.\n\nSay hello to the whole wide world.\n\nNext para.\n',
    'whole',
    'Say hello to the whole wide world.'
  ),
  {
    name: 'triple-click and typing replaces the paragraph and keeps the blank line before the next one',
    run: () => {
      const { p } = tripleClick('Before.\n\nSay hello to the whole wide world.\n\nNext para.\n', 'whole');
      type(p, 'Z');
      const doc = p.doc();
      p.destroy();
      if (doc !== 'Before.\n\nZ\n\nNext para.\n') console.log(`  typed over: ${JSON.stringify(doc)}`);
      return doc === 'Before.\n\nZ\n\nNext para.\n';
    },
  },
  selects(
    'triple-click on the second source line of a paragraph selects both of its lines',
    'Before.\n\nFirst line of para\nsecond line of para\n\nNext para.\n',
    'second',
    'First line of para\nsecond line of para'
  ),
  selects(
    'triple-click on the first source line of a paragraph selects both of its lines',
    'First line of para\nsecond line of para\n',
    'First',
    'First line of para\nsecond line of para'
  ),
  selects('triple-click in a bullet item selects its text without the marker', '- one item here\n- two item\n\nAfter.\n', 'one', 'one item here', 1),
  selects('triple-click in a numbered item selects its text without the number', '1. first thing\n2. second thing\n', 'second', 'second thing'),
  selects('triple-click in a heading selects its text without the #s', 'Intro.\n\n## Heading two\n\nBody text.\n', 'Heading', 'Heading two'),
  selects('triple-click in a heading with closing #s leaves them out too', '## Closed heading ##\n', 'Closed', 'Closed heading'),
  selects('triple-click in an underlined heading selects its text, not the underline', 'Big title\n=========\n\nBody.\n', 'title', 'Big title'),
  selects('triple-click in a quote selects the quoted paragraph without the first `> `', '> Quoted words here.\n\nAfter.\n', 'words', 'Quoted words here.'),
  {
    name: 'triple-click in a two-line quote selects the one quoted paragraph, and typing leaves one quote line',
    run: () => {
      const { p, text } = tripleClick('> First quoted line\n> second quoted line\n\nAfter.\n', 'second');
      type(p, 'Z');
      const doc = p.doc();
      p.destroy();
      return text === 'First quoted line\n> second quoted line' && doc === '> Z\n\nAfter.\n';
    },
  },
  selects('triple-click in a task item selects its text without the checkbox', '- [ ] buy milk today\n- [x] done thing\n', 'milk', 'buy milk today'),
  selects('triple-click in a checked task item selects its text without the checkbox', '- [ ] buy milk today\n- [x] done thing\n', 'done', 'done thing'),
  selects('triple-click in a code block selects the clicked line without its line break', '```js\nconst a = 1;\nconst b = 2;\n```\n', 'b =', 'const b = 2;', 0),
  {
    name: 'triple-click on a blank line or a code fence claims nothing',
    run: () => {
      const blank = mountProse('One.\n\nTwo.\n');
      const onBlank = paragraphRangeAt(blank.view.state, 5);
      blank.destroy();
      const fence = mountProse('```js\nconst a = 1;\n```\n');
      const onFence = paragraphRangeAt(fence.view.state, 2);
      fence.destroy();
      return onBlank === null && onFence === null;
    },
  },
  selects(
    'triple-click past the end of a paragraph’s last line selects that paragraph',
    'Before.\n\nSay hello.\n\nNext para.\n',
    'hello.',
    'Say hello.',
    6
  ),
];
