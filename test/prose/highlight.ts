import { syntaxTree } from '@codemirror/language';
import { Scenario, mountProse } from '../harness';
import { formatStateAt } from '../../src/webview/formatState';

const hasNode = (p: ReturnType<typeof mountProse>, name: string): boolean => {
  let found = false;
  syntaxTree(p.view.state).iterate({ enter: (n) => void (n.name === name && (found = true)) });
  return found;
};

export const scenarios: Scenario[] = [
  {
    name: '==text== renders as a highlight with its markers hidden',
    run: () => {
      const p = mountProse('.\n\na ==marked== b');
      const marks = p.view.dom.querySelectorAll('.tok-highlight');
      const shown = marks[0]?.textContent ?? '';
      const ok = hasNode(p, 'Highlight') && marks.length === 1 && shown.includes('marked') && !p.view.contentDOM.textContent!.includes('==');
      p.destroy();
      return ok;
    },
  },
  {
    name: 'equals signs with spaces around them are not a highlight',
    run: () => {
      const p = mountProse('.\n\na == b == c');
      const ok = !hasNode(p, 'Highlight');
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Mod-Shift-h wraps the selection in == and unwraps it again',
    run: () => {
      const p = mountProse('word');
      p.select(0, 4);
      const handled = p.press('Mod-Shift-h');
      const wrapped = p.doc();
      p.press('Mod-Shift-h');
      const ok = handled && wrapped === '==word==' && p.doc() === 'word';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'formatStateAt reports marks and the block kind at a position',
    run: () => {
      const p = mountProse('**==x==** and `c`\n## Title\n- [ ] task\n1. one\n> quote');
      const s = p.view.state;
      const inMarks = formatStateAt(s, 4);
      const outside = formatStateAt(s, 12);
      const code = formatStateAt(s, 16);
      const heading = formatStateAt(s, s.doc.line(2).from + 4);
      const task = formatStateAt(s, s.doc.line(3).from + 7);
      const ordered = formatStateAt(s, s.doc.line(4).from + 4);
      const quote = formatStateAt(s, s.doc.line(5).from + 4);
      const ok =
        inMarks.bold && inMarks.highlight && !inMarks.italic &&
        !outside.bold && !outside.highlight &&
        code.code &&
        heading.heading === 2 &&
        task.list === 'task' &&
        ordered.list === 'ordered' &&
        quote.quote;
      p.destroy();
      return ok;
    },
  },
];
