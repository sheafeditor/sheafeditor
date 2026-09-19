import { Scenario, mountProse } from '../harness';
import { turnInto, BlockKind } from '../../src/webview/toolbar';
import { createShortcutsOverlay } from '../../src/webview/shortcuts';

/** Put the caret at `at` in `doc`, run `act`, and return the resulting text. */
const after = (doc: string, at: number, act: (p: ReturnType<typeof mountProse>) => void): string => {
  const p = mountProse(doc);
  p.select(at);
  act(p);
  const out = p.doc();
  p.destroy();
  return out;
};

export const scenarios: Scenario[] = [
  {
    name: 'Mod-Alt-0 to 3 turn a list item or a quote into a heading or text the way the Text style menu does',
    run: () => {
      const cases: [string, number, string, BlockKind, string][] = [
        ['- Groceries\n- Errands', 15, 'Mod-Alt-2', 'h2', '- Groceries\n## Errands'],
        ['> quote', 3, 'Mod-Alt-2', 'h2', '## quote'],
        ['- [ ] task', 8, 'Mod-Alt-1', 'h1', '# task'],
        ['1. step', 5, 'Mod-Alt-3', 'h3', '### step'],
        ['## Title', 5, 'Mod-Alt-2', 'h2', '## Title'],
        ['# Title', 4, 'Mod-Alt-2', 'h2', '## Title'],
        ['plain', 2, 'Mod-Alt-1', 'h1', '# plain'],
        ['- item', 4, 'Mod-Alt-0', 'text', 'item'],
        ['> quote', 3, 'Mod-Alt-0', 'text', 'quote'],
        ['## Title', 5, 'Mod-Alt-0', 'text', 'Title'],
      ];
      return cases.every(([doc, at, key, kind, want]) => {
        const shortcut = after(doc, at, (p) => p.press(key));
        const menu = after(doc, at, (p) => turnInto(p.view, kind));
        return shortcut === want && menu === want;
      });
    },
  },
  {
    name: 'Tab nests a list item under its previous sibling and leaves a paragraph, a heading or a first item as they are, so prose never becomes a code block',
    run: () => {
      const cases: [string, number, string, string][] = [
        // Nothing to nest under: the key is consumed and the file does not change.
        ['Intro\n\nPlain paragraph text', 10, 'Tab', 'Intro\n\nPlain paragraph text'],
        ['# Title', 4, 'Tab', '# Title'],
        ['- a\n- b', 3, 'Tab', '- a\n- b'],
        ['1. a\n2. b', 4, 'Tab', '1. a\n2. b'],
        ['- a\n  more', 9, 'Tab', '- a\n  more'],
        // A later item nests under the one before it, in a quote too.
        ['- a\n- b', 7, 'Tab', '- a\n    - b'],
        ['1. a\n2. b', 9, 'Tab', '1. a\n    2. b'],
        ['> - a\n> - b', 11, 'Tab', '> - a\n>     - b'],
        // Shift-Tab still outdents a nested item.
        ['- a\n    - b', 11, 'Shift-Tab', '- a\n- b'],
        // Inside a fenced code block Tab still indents the line.
        ['```\nx\n```', 4, 'Tab', '```\n    x\n```'],
      ];
      return cases.every(([doc, at, key, want]) => {
        let handled = false;
        const got = after(doc, at, (p) => void (handled = p.press(key)));
        return handled && got === want;
      });
    },
  },
  {
    name: 'Enter on an empty list item or quote line ends the block and leaves a blank line below it',
    run: () => {
      // The caret starts at the end of each document and should end at the end of the result.
      const cases: [string, string][] = [
        // Empty item or quote line: the marker goes, and a blank line separates the block
        // from the caret, so what is typed next is a paragraph of its own.
        ['- Only item\n- ', '- Only item\n\n'],
        ['1. a\n2. ', '1. a\n\n'],
        ['- a\n- b\n- ', '- a\n- b\n\n'],
        ['> a\n> ', '> a\n\n'],
        ['> a\n>', '> a\n\n'],
        // A blank line already above the caret is enough on its own.
        ['Intro\n\n- ', 'Intro\n\n'],
        // A nested empty item still steps out one level.
        ['- a\n    - ', '- a\n- '],
        // A line with text still continues the list or quote.
        ['- a', '- a\n- '],
        ['> a', '> a\n> '],
      ];
      const each = cases.every(([doc, want]) => {
        const p = mountProse(doc);
        p.select(doc.length);
        const handled = p.press('Enter');
        const ok = handled && p.doc() === want && p.view.state.selection.main.head === want.length;
        p.destroy();
        return ok;
      });
      // As reported: End, Enter, Enter, then typing starts a paragraph below the block.
      const endThenType = (doc: string): string => {
        const p = mountProse(doc);
        p.select(doc.length);
        p.press('Enter');
        p.press('Enter');
        const at = p.view.state.selection.main.head;
        p.view.dispatch({ changes: { from: at, insert: 'Zed' }, selection: { anchor: at + 3 }, userEvent: 'input.type' });
        const out = p.doc();
        p.destroy();
        return out;
      };
      const reported =
        endThenType('- Only item') === '- Only item\n\nZed' &&
        endThenType('- first\n- second') === '- first\n- second\n\nZed' &&
        endThenType('> alpha') === '> alpha\n\nZed';
      return each && reported;
    },
  },
  {
    name: 'the Keyboard shortcuts overlay lists Undo and Redo with the keys that run them',
    run: () => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      createShortcutsOverlay(parent);
      const rows = new Map<string, string>();
      for (const row of Array.from(parent.querySelectorAll('.sheaf-sc-row'))) {
        rows.set(row.querySelector('.sheaf-sc-label')?.textContent ?? '', row.querySelector('.sheaf-sc-keys')?.textContent ?? '');
      }
      parent.remove();
      // Outside macOS the hints read Ctrl; the test environment is not a Mac.
      const listed = rows.get('Undo') === 'Ctrl+Z' && rows.get('Redo') === 'Ctrl+Shift+Z';
      const p = mountProse('Say hello');
      p.select(9);
      p.view.dispatch({ changes: { from: 9, insert: '!' }, selection: { anchor: 10 }, userEvent: 'input.type' });
      const undone = p.press('Mod-z') && p.doc() === 'Say hello';
      p.destroy();
      return listed && undone;
    },
  },
  {
    name: 'undo and redo keys step the editor history and stop at the editor, so VS Code does not also undo the file',
    run: () => {
      const original = 'Say hello to the world today.';
      const p = mountProse(original);
      p.select(4);
      for (const ch of 'Zap ') {
        const at = p.view.state.selection.main.head;
        p.view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
      }
      const typed = p.doc();
      // VS Code's webview host listens for keydown on the window and runs its own document undo for Ctrl or Cmd with Z or Y.
      const reachedWindow: string[] = [];
      const onWindow = (e: KeyboardEvent): void => void reachedWindow.push(`${e.shiftKey ? 'Shift-' : ''}${e.key}`);
      window.addEventListener('keydown', onWindow);
      const key = (k: string, shiftKey = false): string => {
        p.view.contentDOM.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', { key: k, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
        return p.doc();
      };
      const steps = [
        key('z') === original,
        key('z', true) === typed,
        key('z') === original,
        key('y') === typed,
        key('z') === original,
        // Nothing left to undo: the key is still consumed and the text stays.
        key('z') === original,
      ];
      window.removeEventListener('keydown', onWindow);
      p.destroy();
      return typed === 'Say Zap hello to the world today.' && steps.every(Boolean) && reachedWindow.length === 0;
    },
  },
];
