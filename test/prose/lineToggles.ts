import { EditorView } from '@codemirror/view';
import { Scenario, mountProse } from '../harness';
import {
  toggleBullet,
  toggleOrdered,
  toggleTask,
  toggleHeading,
  clearHeading,
  toggleQuote,
  insertLink,
  insertDivider,
  turnInto,
  mountToolbar,
  refreshToolbar,
} from '../../src/webview/toolbar';
import { convertText } from '../../src/webview/blockModel';

type Command = (view: EditorView) => boolean;

/** Select `anchor`..`head` (the whole document by default) in `doc`, run `cmd`, and return the resulting text. */
const apply = (doc: string, cmd: Command, anchor = 0, head = doc.length): string => {
  const p = mountProse(doc);
  p.select(anchor, head);
  cmd(p.view);
  const out = p.doc();
  p.destroy();
  return out;
};

/** Select the whole of `doc`, press `key` through the editor's keymaps, and return the resulting text. */
const pressAll = (doc: string, key: string): string => {
  const p = mountProse(doc);
  p.select(0, doc.length);
  p.press(key);
  const out = p.doc();
  p.destroy();
  return out;
};

export const scenarios: Scenario[] = [
  {
    name: 'Bullet, Numbered and Task list over separate paragraphs keep the blank line between them',
    run: () =>
      apply('Apples\n\nPears', toggleBullet) === '- Apples\n\n- Pears' &&
      apply('Apples\n\nPears', toggleOrdered) === '1. Apples\n\n2. Pears' &&
      apply('Apples\n\nPears', toggleTask) === '- [ ] Apples\n\n- [ ] Pears' &&
      apply('- one\n\ntwo', toggleBullet) === '- one\n\n- two',
  },
  {
    name: 'Bullet, Numbered and Task list on a spaced-out list remove the markers and keep the blank line',
    run: () =>
      apply('- one\n\n- two', toggleBullet) === 'one\n\ntwo' &&
      apply('1. one\n\n2. two', toggleOrdered) === 'one\n\ntwo' &&
      apply('- [ ] one\n\n- [ ] two', toggleTask) === 'one\n\ntwo' &&
      pressAll('- one\n\n- two', 'Mod-Shift-8') === 'one\n\ntwo',
  },
  {
    name: 'Heading shortcuts over separate paragraphs keep the blank line between them and toggle back',
    run: () =>
      apply('one\n\ntwo', (v) => toggleHeading(v, 1)) === '# one\n\n# two' &&
      apply('# one\n\n# two', (v) => toggleHeading(v, 1)) === 'one\n\ntwo' &&
      pressAll('one\n\ntwo', 'Mod-Alt-1') === '# one\n\n# two',
  },
  {
    name: 'List, quote and heading buttons leave the code inside a code block unchanged',
    run: () => {
      const doc = 'intro\n\n```js\nconst total = 1\n```\n\nend';
      const caret = doc.indexOf('total');
      const word = { from: caret, to: caret + 'total'.length };
      const commands: Command[] = [toggleBullet, toggleOrdered, toggleTask, toggleQuote, (v) => toggleHeading(v, 1)];
      const atCaret = commands.every((cmd) => apply(doc, cmd, caret, caret) === doc);
      const overWord = commands.every((cmd) => apply(doc, cmd, word.from, word.to) === doc);
      const indented = apply('intro\n\n    const total = 1\n\nend', toggleBullet, 12, 12) === 'intro\n\n    const total = 1\n\nend';
      return atCaret && overWord && indented;
    },
  },
  {
    name: 'Link does nothing inside a code block',
    run: () => {
      const doc = '```js\nconst total = 1\n```';
      const from = doc.indexOf('total');
      return apply(doc, insertLink, from, from + 'total'.length) === doc && apply(doc, insertLink, from, from) === doc;
    },
  },
  {
    name: 'Insert Divider inside a code block puts the rule below the block',
    run: () => {
      const doc = 'intro\n\n```js\nconst total = 1\n```\n\nend';
      const caret = doc.indexOf('total');
      const between = apply(doc, insertDivider, caret, caret) === 'intro\n\n```js\nconst total = 1\n```\n\n---\n\nend';
      const last = '```js\nconst total = 1\n```';
      const atEnd = apply(last, insertDivider, 8, 8) === '```js\nconst total = 1\n```\n\n---\n';
      // The blank line already below a paragraph is reused rather than doubled.
      const paragraph = apply('text\n\nnext', insertDivider, 2, 2) === 'text\n\n---\n\nnext';
      return between && atEnd && paragraph;
    },
  },
  {
    name: 'Insert Divider in a code block with no closing fence puts the rule above the block',
    run: () => {
      const doc = 'Intro\n\n```\nconst x = 1';
      const above = apply(doc, insertDivider, doc.indexOf('const') + 2, doc.indexOf('const') + 2) === 'Intro\n\n---\n\n```\nconst x = 1';
      // With text directly above the fence the rule still gets a blank line on each side.
      const tight = apply('Intro\n```\nconst x = 1', insertDivider, 12, 12) === 'Intro\n\n---\n\n```\nconst x = 1';
      // A block whose only line is its opening fence has no closing one either.
      const bare = apply('```', insertDivider, 3, 3) === '---\n\n```';
      // A closed block is unchanged: the rule still goes below it.
      const closed = apply('```\nconst x = 1\n```', insertDivider, 8, 8) === '```\nconst x = 1\n```\n\n---\n';
      return above && tight && bare && closed;
    },
  },
  {
    name: 'Text style reads H1 and H2 on underlined headings and H2 on a quoted heading',
    run: () => {
      const doc = 'Setext title\n============\n\nSub title\n---------\n\n> ## Quoted heading';
      const p = mountProse(doc);
      const bar = document.createElement('div');
      document.body.appendChild(bar);
      mountToolbar(bar, () => p.view, () => {}, () => {}, () => false, false);
      const at = (pos: number): { label: string; quote: boolean } => {
        p.select(pos);
        refreshToolbar(p.view);
        const quoteBtn = bar.querySelector('[data-command="quote"]');
        return {
          label: bar.querySelector('[data-command="heading"] .sheaf-tb-dd-label')?.textContent ?? '',
          quote: !!quoteBtn && quoteBtn.getAttribute('aria-pressed') === 'true',
        };
      };
      const h1 = at(3).label === 'H1' && at(doc.indexOf('====') + 2).label === 'H1';
      const h2 = at(doc.indexOf('Sub') + 2).label === 'H2';
      const quoted = at(doc.indexOf('Quoted') + 2);
      const plain = at(doc.indexOf('\n\nSub') + 1).label === 'Text';
      p.destroy();
      bar.remove();
      return h1 && h2 && quoted.label === 'H2' && quoted.quote && plain;
    },
  },
  {
    name: 'Choosing a heading on an underlined heading removes the underline line',
    run: () => {
      const doc = 'Title\n=====\n\nnext';
      const caret = (cmd: Command): string => apply(doc, cmd, 2, 2);
      const textStyle = caret((v) => turnInto(v, 'h2')) === '## Title\n\nnext';
      const wholeHeading = apply(doc, (v) => turnInto(v, 'h2'), 0, 11) === '## Title\n\nnext';
      const same = caret((v) => turnInto(v, 'h1')) === doc;
      const text = caret((v) => turnInto(v, 'text')) === 'Title\n\nnext';
      const bullet = caret((v) => turnInto(v, 'bullet')) === '- Title\n\nnext';
      const shortcut = caret((v) => toggleHeading(v, 2)) === '## Title\n\nnext';
      const toggleOff = caret((v) => toggleHeading(v, 1)) === 'Title\n\nnext';
      const cleared = caret(clearHeading) === 'Title\n\nnext';
      const onUnderline = apply(doc, (v) => turnInto(v, 'h3'), 8, 8) === '### Title\n\nnext';
      const quotedSame = apply('> ## Quoted heading', (v) => turnInto(v, 'h2'), 6, 6) === '> ## Quoted heading';
      return textStyle && wholeHeading && same && text && bullet && shortcut && toggleOff && cleared && onUnderline && quotedSame;
    },
  },
  {
    name: 'Bullet list on a task item turns it into a plain bullet',
    run: () => {
      const caret = apply('- [ ] buy milk', toggleBullet, 8, 8) === '- buy milk';
      const shortcut = (() => {
        const p = mountProse('- [ ] buy milk');
        p.select(8);
        p.press('Mod-Shift-8');
        const out = p.doc();
        p.destroy();
        return out === '- buy milk';
      })();
      const both = apply('- [ ] one\n- [x] two', toggleBullet) === '- one\n- two';
      const keepsBullet = apply('* [x] done', toggleBullet, 7, 7) === '* done';
      return caret && shortcut && both && keepsBullet;
    },
  },
  {
    name: 'List buttons on a nested item change only its marker and keep it nested',
    run: () => {
      const doc = '- Parent item\n    - Child item';
      const child = doc.indexOf('Child') + 2;
      const numbered = apply(doc, toggleOrdered, child, child) === '- Parent item\n    1. Child item';
      const unbulleted = apply(doc, toggleBullet, child, child) === '- Parent item\n    Child item';
      const task = apply(doc, toggleTask, child, child) === '- Parent item\n    - [ ] Child item';
      const back = apply('- Parent item\n    1. Child item', toggleBullet, 20, 20) === '- Parent item\n    - Child item';
      const shallow = '- a\n  - b';
      const turned = apply(shallow, (v) => turnInto(v, 'ordered'), 8, 8) === '- a\n  1. b';
      const toggled = apply(shallow, toggleOrdered, 8, 8) === '- a\n  1. b';
      return numbered && unbulleted && task && back && turned && toggled;
    },
  },
  {
    name: 'List buttons on quoted lines put the marker inside the quote',
    run: () => {
      const doc = '> Alpha\n> Beta';
      const bullets = apply(doc, toggleBullet) === '> - Alpha\n> - Beta';
      const off = apply('> - Alpha\n> - Beta', toggleBullet) === doc;
      const numbered = apply(doc, toggleOrdered) === '> 1. Alpha\n> 2. Beta';
      const tasks = apply(doc, toggleTask) === '> - [ ] Alpha\n> - [ ] Beta';
      const tight = apply('>Alpha', toggleBullet, 3, 3) === '>- Alpha';
      return bullets && off && numbered && tasks && tight;
    },
  },
  {
    name: 'Block handle Turn into on an indented list item puts the new marker after the indent',
    run: () => {
      const ordered = convertText('  - b', 'item', 'ordered', 4)?.text === '  1. b';
      const bullet = convertText('  1. b', 'item', 'bullet', 5)?.text === '  - b';
      const task = convertText('  - b', 'item', 'task', 4)?.text === '  - [ ] b';
      return ordered && bullet && task;
    },
  },
  {
    name: 'Quote on a quote of several paragraphs, or on >tight, removes the quote',
    run: () => {
      const doc = '> First para\n>\n> Second para';
      const removed = apply(doc, toggleQuote) === 'First para\n\nSecond para';
      const tight = apply('>tight', toggleQuote, 3, 3) === 'tight';
      const shortcut = pressAll(doc, 'Mod-Shift-9') === 'First para\n\nSecond para';
      const p = mountProse(doc);
      const bar = document.createElement('div');
      document.body.appendChild(bar);
      mountToolbar(bar, () => p.view, () => {}, () => {}, () => false, false);
      p.select(0, doc.length);
      refreshToolbar(p.view);
      const button = bar.querySelector<HTMLButtonElement>('[data-command="quote"]')!;
      const shownPressed = button.getAttribute('aria-pressed') === 'true';
      button.click();
      const clicked = p.doc() === 'First para\n\nSecond para';
      p.destroy();
      bar.remove();
      const oneLevel = apply('> > deep', toggleQuote, 5, 5) === '> deep';
      return removed && tight && shortcut && shownPressed && clicked && oneLevel;
    },
  },
  {
    name: 'Quote on a quote holding a fenced code block unquotes the fence and code lines too',
    run: () => {
      const doc = 'Before\n\n> intro line\n> ```\n> let x = 1\n> ```\n> outro line\n\nAfter';
      const from = doc.indexOf('intro line');
      const to = doc.indexOf('outro line') + 'outro line'.length;
      const whole = apply(doc, toggleQuote, from, to) === 'Before\n\nintro line\n```\nlet x = 1\n```\noutro line\n\nAfter';
      const caret = apply(doc, toggleQuote, from, from) === 'Before\n\nintro line\n> ```\n> let x = 1\n> ```\n> outro line\n\nAfter';
      // Adding a quote still leaves a code block alone, whether or not the quote reaches it.
      const added = apply('alpha\n\n```\nx\n```\n\nbeta', toggleQuote) === '> alpha\n\n```\nx\n```\n\n> beta';
      const outside = apply('> alpha\n\n```\nx\n```', toggleQuote) === 'alpha\n\n```\nx\n```';
      return whole && caret && added && outside;
    },
  },
  {
    name: 'Quote over separate paragraphs makes one quote that Quote removes again',
    run: () => {
      const quoted = apply('First para\n\nSecond para', toggleQuote);
      const back = apply(quoted, toggleQuote);
      return quoted === '> First para\n>\n> Second para' && back === 'First para\n\nSecond para';
    },
  },
];
