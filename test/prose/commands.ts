import { Scenario, mountProse } from '../harness';
import { toggleTask, toggleCodeBlock, insertDivider, clearFormatting } from '../../src/webview/toolbar';

export const scenarios: Scenario[] = [
  {
    name: 'toggleTask turns bullets, numbers and text into tasks and back to text',
    run: () => {
      const p = mountProse('- a\nb\n1. c');
      p.select(0, p.doc().length);
      toggleTask(p.view);
      const tasks = p.doc();
      p.select(0, p.doc().length);
      toggleTask(p.view);
      const ok = tasks === '- [ ] a\n- [ ] b\n- [ ] c' && p.doc() === 'a\nb\nc';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'toggleCodeBlock fences the selected lines and removes the fences from inside',
    run: () => {
      const p = mountProse('x\ny');
      p.select(0, 3);
      toggleCodeBlock(p.view);
      const fenced = p.doc();
      p.select(5);
      toggleCodeBlock(p.view);
      const unfenced = p.doc();
      p.destroy();
      const q = mountProse('a ``` b');
      q.select(1);
      toggleCodeBlock(q.view);
      const longer = q.doc();
      q.destroy();
      return fenced === '```\nx\ny\n```' && unfenced === 'x\ny' && longer === '````\na ``` b\n````';
    },
  },
  {
    name: 'insertDivider keeps a blank line between the rule and text above',
    run: () => {
      const a = mountProse('text');
      a.select(4);
      insertDivider(a.view);
      const afterText = a.doc();
      const caretAtEnd = a.view.state.selection.main.head === a.doc().length;
      a.destroy();
      const b = mountProse('text\n\nnext');
      b.select(5);
      insertDivider(b.view);
      const onBlank = b.doc();
      b.destroy();
      return afterText === 'text\n\n---\n' && caretAtEnd && onBlank === 'text\n\n---\n\nnext';
    },
  },
  {
    name: 'clearFormatting removes every inline marker in the selection and keeps link text',
    run: () => {
      const p = mountProse('**b** _i_ [l](https://x.io) `c` ==h== ~~s~~');
      p.select(0, p.doc().length);
      clearFormatting(p.view);
      const ok = p.doc() === 'b i l c h s';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Shift-Enter writes a backslash line break that stays in the list item, quote or code',
    run: () => {
      const cases: [string, number, string][] = [
        ['- item', 6, '- item\\\n  '],
        ['> q', 3, '> q\\\n> '],
        ['p', 1, 'p\\\n'],
        ['```\nx\n```', 5, '```\nx\n\n```'],
      ];
      return cases.every(([doc, at, want]) => {
        const p = mountProse(doc);
        p.select(at);
        const handled = p.press('Shift-Enter');
        const got = p.doc();
        p.destroy();
        return handled && got === want;
      });
    },
  },
  {
    name: 'a formatting shortcut Sheaf handles stops at the editor, so VS Code does not also run its own command',
    run: () => {
      const p = mountProse('Say hello to the world today.');
      p.select(17, 22);
      // VS Code's webview host listens for keydown on the window and forwards every key it sees to the workbench.
      const reachedWindow: string[] = [];
      const onWindow = (e: KeyboardEvent): void => void reachedWindow.push(e.key);
      window.addEventListener('keydown', onWindow);
      const key = (k: string, shiftKey = false): void =>
        void p.view.contentDOM.dispatchEvent(
          new (globalThis as any).KeyboardEvent('keydown', { key: k, ctrlKey: true, shiftKey, bubbles: true, cancelable: true })
        );
      key('b');
      key('x', true);
      key('h', true);
      key('p');
      window.removeEventListener('keydown', onWindow);
      const doc = p.doc();
      p.destroy();
      return doc === 'Say hello to the **~~==world==~~** today.' && reachedWindow.join(' ') === 'p';
    },
  },
];
