import { EditorView } from '@codemirror/view';
import { Scenario, mountProse, Prose } from '../harness';
import { formatStateAt } from '../../src/webview/formatState';

/** Type `text` at the caret the way the browser's input reaches CodeMirror; false when no handler took it. */
const typeText = (p: Prose, text: string): boolean => {
  const { from, to } = p.view.state.selection.main;
  const fallback = () => p.view.state.update({ changes: { from, to, insert: text } });
  return p.view.state.facet(EditorView.inputHandler).some((h) => h(p.view, from, to, text, fallback));
};

export const scenarios: Scenario[] = [
  {
    name: 'Bold with the caret inside bold text removes that bold',
    run: () => {
      const p = mountProse('A **bold** word here.');
      p.select(6);
      const ok = p.press('Mod-b') && p.doc() === 'A bold word here.' && p.view.state.selection.main.head === 4;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Bold with the caret in a word bolds the word, and a second press gives the text back',
    run: () => {
      const p = mountProse('say hello now');
      p.select(13);
      p.press('Mod-b');
      const bolded = p.doc() === 'say hello **now**' && p.view.state.selection.main.head === 15;
      p.press('Mod-b');
      const back = p.doc() === 'say hello now' && p.view.state.selection.main.head === 13;
      p.destroy();
      return bolded && back;
    },
  },
  {
    name: 'Bold with the caret outside any word writes nothing until you type, then wraps what you type',
    run: () => {
      const p = mountProse('say ');
      p.select(4);
      p.press('Mod-b');
      const untouched = p.doc() === 'say ';
      const typed = typeText(p, 'x') && p.doc() === 'say **x**' && p.view.state.selection.main.head === 7;
      p.destroy();
      const q = mountProse('say ');
      q.select(4);
      q.press('Mod-b');
      q.press('Mod-b');
      const cancelled = !typeText(q, 'x') && q.doc() === 'say ';
      q.destroy();
      return untouched && typed && cancelled;
    },
  },
  {
    name: 'Italic on bold text makes it bold and italic, and a second Italic leaves it bold',
    run: () => {
      const p = mountProse('**hello**');
      p.select(2, 7);
      p.press('Mod-i');
      const fs = formatStateAt(p.view.state, 5);
      const both = fs.bold && fs.italic && p.doc().replace(/[*_]/g, '') === 'hello';
      p.press('Mod-i');
      const back = p.doc() === '**hello**';
      p.destroy();
      return both && back;
    },
  },
  {
    name: 'Bold on a bold word selected with its markers removes the bold',
    run: () => {
      const p = mountProse('say **hello** now');
      p.select(4, 13);
      const ok = p.press('Mod-b') && p.doc() === 'say hello now';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Bold on part of a bold word unbolds only that part',
    run: () => {
      const p = mountProse('**helloworld**');
      p.select(7, 12);
      const ok = p.press('Mod-b') && p.doc() === '**hello**world';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Bold on a selection with spaces at its edges keeps the spaces outside the markers',
    run: () => {
      const p = mountProse('say hello now');
      p.select(3, 10);
      const ok = p.press('Mod-b') && p.doc() === 'say **hello** now';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Bold across paragraphs, list items and headings wraps each block on its own, and toggles back',
    run: () => {
      const p = mountProse('one\n\ntwo');
      p.select(0, 8);
      p.press('Mod-b');
      const wrapped = p.doc() === '**one**\n\n**two**';
      p.select(0, p.doc().length);
      p.press('Mod-b');
      const back = p.doc() === 'one\n\ntwo';
      p.destroy();
      const l = mountProse('- a\n- b\n## T');
      l.select(0, 12);
      l.press('Mod-b');
      const blocks = l.doc() === '- **a**\n- **b**\n## **T**';
      l.destroy();
      return wrapped && back && blocks;
    },
  },
];
