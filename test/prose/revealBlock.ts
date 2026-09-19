/*
 * Showing a block's raw Markdown: the Edit Markdown command, the two menus that
 * run it, and the opt-in double-click. A real click needs layout to turn into a
 * document position, which jsdom has none of, so the double-click checks call it
 * with the position a click on that word would produce.
 */

import { Scenario, mountProse, Prose } from '../harness';
import { closeReveal, revealBlockAt, revealOnDoubleClick, revealRange, toggleBlockReveal } from '../../src/webview/revealBlock';
import { revealField, setLivePreviewConfig } from '../../src/webview/livePreview';
import { blockMenuItems, BlockMenuItem, blockRangeAt, blockSelectionOf } from '../../src/webview/blocks';
import { mountContextMenu } from '../../src/webview/contextmenu';

const G: any = globalThis;

/** The Markdown on show, as its text (empty when the document is all rendered). */
const shown = (p: Prose): string => {
  const range = p.view.state.field(revealField, false);
  return range ? p.view.state.sliceDoc(range.from, range.to) : '';
};

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

/** Paste `text` over the selection, as Cmd+V does. */
const paste = (p: Prose, text: string): void => {
  const sel = p.view.state.selection.main;
  p.view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    userEvent: 'input.paste',
  });
};

/** Rendered text of line `i` (0-based), read back from the editor DOM. */
const line = (p: Prose, i: number): string =>
  Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))[i]?.textContent ?? '';

/** How many nodes match `selector` in the editor DOM. */
const count = (p: Prose, selector: string): number => p.view.contentDOM.querySelectorAll(selector).length;

/**
 * Run `fn` with "Reveal Syntax On Line" off, restoring the test default (on)
 * afterwards. That setting shows the caret's own line as Markdown, so it is the
 * thing in the way when a check reads back the line the caret has just landed on.
 */
const withoutRevealOnLine = (fn: () => boolean): boolean => {
  setLivePreviewConfig({ revealSyntaxOnLine: false });
  try {
    return fn();
  } finally {
    setLivePreviewConfig({ revealSyntaxOnLine: true });
  }
};

const menuItem = (items: BlockMenuItem[], label: string): BlockMenuItem => {
  const found = items.find((i) => i.label === label);
  if (!found) throw new Error(`no menu item ${label}`);
  return found;
};

/** Open the right-click menu at the caret and return a way to pick an item by label. */
const openMenu = (p: Prose): { item: (label: string) => HTMLButtonElement | undefined; close: () => void } => {
  document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
  mountContextMenu(p.view.dom, { getView: () => p.view, getFileName: () => 'doc.md', copyToClipboard: () => {} });
  p.view.contentDOM.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }));
  const buttons = (): HTMLButtonElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu')).flatMap((m) =>
      Array.from(m.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-item'))
    );
  return {
    item: (label) => buttons().find((b) => b.querySelector('span')!.textContent === label),
    close: () => document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove()),
  };
};

const NESTED = '- one\n- two\n  - nested\n- three\n';

export const scenarios: Scenario[] = [
  {
    name: 'a double-click is left to CodeMirror unless the setting asks for the Markdown',
    run: () => {
      const doc = 'Say hello to the world.\n\nNext.\n';
      const p = mountProse(doc);
      p.select(0);
      const handled = revealOnDoubleClick(p.view, doc.indexOf('hello') + 2, false);
      const sel = p.view.state.selection.main;
      const open = shown(p);
      p.destroy();
      return !handled && open === '' && sel.empty && sel.head === 0;
    },
  },
  {
    name: 'with the setting on, a double-click shows the block and selects the word, so typing replaces it',
    run: () => {
      const doc = 'Say hello to the world.\n\nNext.\n';
      const p = mountProse(doc);
      const handled = revealOnDoubleClick(p.view, doc.indexOf('hello') + 2, true);
      const open = shown(p);
      const word = selected(p);
      type(p, 'Z');
      const after = p.doc();
      p.destroy();
      return handled && open === 'Say hello to the world.' && word === 'hello' && after === 'Say Z to the world.\n\nNext.\n';
    },
  },
  {
    name: 'the word a double-click selects leaves out bold markers, a link address and a heading hash',
    run: () => {
      const word = (doc: string, find: string): string => {
        const p = mountProse(doc);
        revealOnDoubleClick(p.view, doc.indexOf(find) + 1, true);
        const got = selected(p);
        p.destroy();
        return got;
      };
      return (
        word('a **bold** word\n', 'bold') === 'bold' &&
        word('see [site](http://example.com) here\n', 'site') === 'site' &&
        word('# Heading here\n\ntext\n', 'Heading') === 'Heading' &&
        word('- task one\n', 'task') === 'task'
      );
    },
  },
  {
    name: 'a double-click in a list shows that item alone, with anything nested under it',
    run: () => {
      const p = mountProse(NESTED);
      revealOnDoubleClick(p.view, NESTED.indexOf('two') + 1, true);
      const open = shown(p);
      p.destroy();
      return open === '- two\n  - nested';
    },
  },
  {
    name: 'a double-click on a numbered item, a task item and a paragraph shows the right span of each',
    run: () => {
      const open = (doc: string, find: string): string => {
        const p = mountProse(doc);
        revealOnDoubleClick(p.view, doc.indexOf(find) + 1, true);
        const got = shown(p);
        p.destroy();
        return got;
      };
      return (
        open('1. one\n2. two\n', 'two') === '2. two' &&
        open('- [ ] a here\n- [x] b here\n', 'b here') === '- [x] b here' &&
        open('First line of para\nsecond line of para\n\nNext.\n', 'second') === 'First line of para\nsecond line of para'
      );
    },
  },
  {
    name: 'Cmd+Alt+E shows the caret block as Markdown and again puts it away, caret where it was',
    run: () => {
      const doc = 'Say hello to the world.\n\nNext.\n';
      const p = mountProse(doc);
      const at = doc.indexOf('hello') + 2;
      p.select(at);
      const opened = p.press('Mod-Alt-e');
      const open = shown(p);
      const closed = p.press('Mod-Alt-e');
      const after = shown(p);
      const caret = p.view.state.selection.main;
      p.destroy();
      return opened && open === 'Say hello to the world.' && closed && after === '' && caret.empty && caret.head === at;
    },
  },
  {
    name: 'Cmd+Alt+E on the second item of a list opens that item alone',
    run: () => {
      const p = mountProse(NESTED);
      p.select(NESTED.indexOf('two') + 1);
      p.press('Mod-Alt-e');
      const open = shown(p);
      p.destroy();
      return open === '- two\n  - nested';
    },
  },
  {
    name: 'Escape puts the Markdown away, and a second Escape selects the block',
    run: () => {
      const doc = 'Say hello to the world.\n\nNext.\n';
      const p = mountProse(doc);
      p.select(doc.indexOf('hello') + 2);
      p.press('Mod-Alt-e');
      const first = p.press('Escape');
      const afterFirst = shown(p);
      const selectedAfterFirst = blockSelectionOf(p.view.state);
      const second = p.press('Escape');
      const afterSecond = blockSelectionOf(p.view.state);
      p.destroy();
      return first && afterFirst === '' && !selectedAfterFirst && second && !!afterSecond;
    },
  },
  {
    name: 'moving the caret out of the block puts its Markdown away',
    run: () => {
      const doc = 'Say hello to the world.\n\nNext.\n';
      const p = mountProse(doc);
      revealOnDoubleClick(p.view, doc.indexOf('hello') + 2, true);
      const open = shown(p);
      p.select(doc.indexOf('Next.') + 1);
      const after = shown(p);
      p.destroy();
      return open !== '' && after === '';
    },
  },
  {
    name: 'Cmd+Alt+E puts away Markdown a double-click opened',
    run: () => {
      const doc = 'Say hello to the world.\n\nNext.\n';
      const p = mountProse(doc);
      revealOnDoubleClick(p.view, doc.indexOf('hello') + 2, true);
      const closed = p.press('Mod-Alt-e');
      const after = shown(p);
      p.destroy();
      return closed && after === '';
    },
  },
  {
    name: 'Edit Markdown in the block handle menu opens the same span as the shortcut, taking the caret there',
    run: () => {
      const doc = '# A\n\nFirst line of para\nsecond line of para\n\n# B';
      const p = mountProse(doc);
      p.select(0);
      const range = blockRangeAt(p.view.state, doc.indexOf('second') + 1)!;
      menuItem(blockMenuItems(p.view, range), 'Edit Markdown').run!();
      const open = shown(p);
      const caret = p.view.state.selection.main.head;
      p.destroy();
      return open === 'First line of para\nsecond line of para' && caret === range.from;
    },
  },
  {
    name: 'Edit Markdown in the right-click menu opens the block under the pointer',
    run: () => {
      const doc = '# A\n\nFirst line of para\nsecond line of para\n\n# B';
      const p = mountProse(doc);
      p.select(doc.indexOf('second') + 1);
      const menu = openMenu(p);
      const button = menu.item('Edit Markdown');
      button?.click();
      const open = shown(p);
      menu.close();
      p.destroy();
      return !!button && open === 'First line of para\nsecond line of para';
    },
  },
  {
    name: 'revealBlockAt finds nothing on a blank line, and closing with nothing open does nothing',
    run: () => {
      const doc = 'Say hello.\n\nNext.\n';
      const p = mountProse(doc);
      const blank = revealBlockAt(p.view, doc.indexOf('\n\n') + 1);
      const closedNothing = closeReveal(p.view);
      revealRange(p.view, { from: 0, to: 10 });
      const open = shown(p);
      const closed = closeReveal(p.view);
      p.destroy();
      return !blank && !closedNothing && open === 'Say hello.' && closed && shown(p) === '';
    },
  },
  {
    name: 'Edit Markdown opens a whole table as raw pipes, and the grid comes back once nothing holds it open',
    run: () => {
      const doc = 'Before.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.\n';
      const p = mountProse(doc);
      const grid = (): boolean => !!p.view.contentDOM.querySelector('.sheaf-table');
      const drawn = grid();
      // A caret inside a table already shows its pipes, so what Edit Markdown adds
      // here is the reveal itself; the grid returns only when neither holds it.
      const at = doc.indexOf('| 1') + 2;
      p.select(at);
      const opened = p.press('Mod-Alt-e');
      const open = shown(p);
      const pipes = !grid();
      const closed = p.press('Mod-Alt-e');
      const away = shown(p);
      const caret = p.view.state.selection.main.head;
      p.select(1);
      const redrawn = grid();
      p.destroy();
      return (
        drawn &&
        opened &&
        open === '| a | b |\n| --- | --- |\n| 1 | 2 |' &&
        pipes &&
        closed &&
        away === '' &&
        caret === at &&
        redrawn
      );
    },
  },
  {
    name: 'Edit Markdown on a fenced code block opens it with its fences',
    run: () => {
      const doc = 'Before.\n\n```js\nconst x = 1;\n```\n\nAfter.\n';
      const p = mountProse(doc);
      p.select(doc.indexOf('const') + 2);
      const opened = p.press('Mod-Alt-e');
      const open = shown(p);
      p.destroy();
      return opened && open === '```js\nconst x = 1;\n```';
    },
  },
  {
    name: 'Edit Markdown from the block menu opens a table the caret is nowhere near',
    run: () => {
      const doc = 'Before.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.\n';
      const p = mountProse(doc);
      p.select(1);
      const range = blockRangeAt(p.view.state, doc.indexOf('| a') + 2)!;
      menuItem(blockMenuItems(p.view, range), 'Edit Markdown').run!();
      const open = shown(p);
      const caret = p.view.state.selection.main.head;
      const pipes = !p.view.contentDOM.querySelector('.sheaf-table');
      p.destroy();
      return open === '| a | b |\n| --- | --- |\n| 1 | 2 |' && caret === range.from && pipes;
    },
  },
  {
    name: 'Edit Markdown on a block the caret is already in leaves the caret alone',
    run: () => {
      const doc = 'Say hello to the world.\n\nNext.\n';
      const p = mountProse(doc);
      const at = doc.indexOf('world');
      p.select(at);
      toggleBlockReveal(p.view);
      const caret = p.view.state.selection.main;
      p.destroy();
      return caret.empty && caret.head === at;
    },
  },
  {
    name: 'Enter at the end of a revealed heading renders the heading again, caret on a rendered line below',
    run: () =>
      withoutRevealOnLine(() => {
        const doc = '# Heading\n\nNext.\n';
        const p = mountProse(doc);
        const end = doc.indexOf('\n');
        p.select(end);
        p.press('Mod-Alt-e');
        const open = shown(p);
        const pressed = p.press('Enter');
        const after = shown(p);
        const caret = p.view.state.selection.main;
        const heading = line(p, 0);
        const below = line(p, 1);
        p.destroy();
        return (
          open === '# Heading' &&
          pressed &&
          after === '' &&
          heading === 'Heading' &&
          below === '' &&
          caret.empty &&
          caret.head === end + 1
        );
      }),
  },
  {
    name: 'Enter at the end of a revealed paragraph, and in the middle of one, puts its Markdown away',
    run: () => {
      const doc = 'One two three.\n\nNext.\n';
      const enterAt = (at: number): { open: string; after: string } => {
        const p = mountProse(doc);
        p.select(at);
        p.press('Mod-Alt-e');
        const open = shown(p);
        p.press('Enter');
        const after = shown(p);
        p.destroy();
        return { open, after };
      };
      const end = enterAt(doc.indexOf('\n'));
      const middle = enterAt(doc.indexOf('two'));
      return end.open === 'One two three.' && end.after === '' && middle.open === 'One two three.' && middle.after === '';
    },
  },
  {
    name: 'Enter at the end of a revealed list item renders that item again and draws the new one',
    run: () =>
      withoutRevealOnLine(() => {
        const doc = '- one\n- two\n';
        const p = mountProse(doc);
        p.select(doc.indexOf('- two') + '- two'.length);
        p.press('Mod-Alt-e');
        const open = shown(p);
        p.press('Enter');
        const after = shown(p);
        const bullets = count(p, '.tok-bullet');
        const text = p.doc();
        p.destroy();
        return open === '- two' && after === '' && bullets === 3 && text === '- one\n- two\n- \n';
      }),
  },
  {
    name: 'Shift+Enter in a revealed paragraph puts its Markdown away',
    run: () => {
      const doc = 'One two three.\n\nNext.\n';
      const p = mountProse(doc);
      p.select(doc.indexOf('\n'));
      p.press('Mod-Alt-e');
      const open = shown(p);
      const pressed = p.press('Shift-Enter');
      const after = shown(p);
      const text = p.doc();
      p.destroy();
      return open === 'One two three.' && pressed && after === '' && text === 'One two three.\\\n\n\nNext.\n';
    },
  },
  {
    name: 'typing at the end of a revealed heading still joins the block, so its Markdown stays shown',
    run: () => {
      const doc = '# Heading\n\nNext.\n';
      const p = mountProse(doc);
      p.select(doc.indexOf('\n'));
      p.press('Mod-Alt-e');
      type(p, ' again');
      const after = shown(p);
      const raw = line(p, 0);
      p.destroy();
      return after === '# Heading again' && raw === '# Heading again';
    },
  },
  {
    name: 'pasting several lines into a revealed block leaves its Markdown shown, since a paste is not Enter',
    run: () => {
      const doc = 'One two three.\n\nNext.\n';
      const p = mountProse(doc);
      p.select(doc.indexOf('\n'));
      p.press('Mod-Alt-e');
      const open = shown(p);
      paste(p, ' four\nfive six');
      const after = shown(p);
      p.destroy();
      return open === 'One two three.' && after === 'One two three. four\nfive six';
    },
  },
];
