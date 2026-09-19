import { EditorState } from '@codemirror/state';
import { Scenario, Prose, mountProse } from '../harness';
import { blockRangeAt, convertText, moveBlock, moveBlockTo, turnRangeInto, TurnIntoKind } from '../../src/webview/blockModel';

/** Run `fn` on a fresh editor holding `doc` with the caret at `at`, and return the document afterwards. */
function after(doc: string, at: number, fn: (p: Prose) => void): string {
  const p = mountProse(doc);
  p.select(at);
  fn(p);
  const out = p.doc();
  p.destroy();
  return out;
}

/** Drop the block starting at `line` of `doc` before sibling `index`, as a drag does, and return the document. */
function drop(doc: string, line: number, index: number): string {
  return after(doc, 0, (p) => {
    const spec = moveBlockTo(p.view.state, blockRangeAt(p.view.state, lineStart(doc, line))!, index);
    if (spec) p.view.dispatch(spec);
  });
}

const lineStart = (doc: string, n: number): number => EditorState.create({ doc }).doc.line(n).from;

/** Turn the block on line `line` of `doc` into `into` and return the document and that block's line span afterwards. */
function turnLine(doc: string, line: number, into: TurnIntoKind): { doc: string; span: string } {
  const p = mountProse(doc);
  const range = blockRangeAt(p.view.state, lineStart(doc, line))!;
  turnRangeInto(p.view, range, into);
  const out = p.doc();
  const after = blockRangeAt(p.view.state, lineStart(out, line));
  p.destroy();
  return { doc: out, span: after ? `${after.startLine}-${after.endLine}` : 'null' };
}

const convert = (text: string, into: TurnIntoKind): string | null => convertText(text, 'item', into, 0)?.text ?? null;

export const scenarios: Scenario[] = [
  {
    name: 'Turn into Numbered list on a bullet item keeps its nested items inside it',
    run: () => {
      const doc = '- Apple\n  - Apple child\n- Banana\n- Cherry';
      const fruit = turnLine(doc, 1, 'ordered');
      const unit = turnLine('- a\n  - b\n- c', 1, 'ordered');
      return (
        fruit.doc === '1. Apple\n   - Apple child\n- Banana\n- Cherry' &&
        fruit.span === '1-2' &&
        unit.doc === '1. a\n   - b\n- c' &&
        unit.span === '1-2'
      );
    },
  },
  {
    name: 'Turn into shifts nested lines by the change in list marker width and leaves the rest alone',
    run: () => {
      const task = turnLine('- a\n  - b\n- c', 1, 'task');
      const back = turnLine('1. a\n   - b\n1. c', 1, 'bullet');
      return (
        back.doc === '- a\n  - b\n1. c' &&
        back.span === '1-2' &&
        // A task's checkbox is item content, so the item's content column does not move.
        task.doc === '- [ ] a\n  - b\n- c' &&
        task.span === '1-2' &&
        convert('1. a\n   - b', 'task') === '- [ ] a\n  - b' &&
        convert('- [ ] a\n  - b', 'ordered') === '1. a\n   - b' &&
        convert('- a\n  - b\n    - c', 'ordered') === '1. a\n   - b\n     - c' &&
        convert('- a\n\n  more', 'ordered') === '1. a\n\n   more' &&
        convert('- a\nlazy', 'ordered') === '1. a\nlazy'
      );
    },
  },
  {
    name: 'moving a block among lines with no blank lines adds a blank line only where the moved text would join a neighbour',
    run: () => {
      const doc = '# Alpha\nFirst line\n# Beta\nmore text';
      const dragged = drop(doc, 2, 4);
      const unit = drop('# A\npara\n# B\nmore', 2, 4);
      const down = after('# A\npara\n# B\nmore', lineStart('# A\npara\n# B\nmore', 2), (p) => moveBlock(p.view, 1));
      const keyed = after('# A\npara\n# B\nmore', lineStart('# A\npara\n# B\nmore', 2), (p) => {
        p.press('Escape');
        p.press('Mod-Shift-ArrowDown');
        p.press('Mod-Shift-ArrowDown');
      });
      return (
        dragged === '# Alpha\n# Beta\nmore text\n\nFirst line' &&
        unit === '# A\n# B\nmore\n\npara' &&
        down === '# A\n# B\npara\n\nmore' &&
        keyed === '# A\n# B\nmore\n\npara' &&
        // A separator that already holds a blank line stays as written.
        after('para\n\n# H\nnext', 1, (p) => moveBlock(p.view, 1)) === '# H\n\npara\n\nnext'
      );
    },
  },
  {
    name: 'moving item 10 above item 9 keeps the numbers in place and the items trade places',
    run: () => {
      const doc = 'Intro.\n\n9. Ninth item\n10. Tenth item';
      const dragged = drop(doc, 4, 0);
      const unit = after('9. a\n10. b', lineStart('9. a\n10. b', 2), (p) => moveBlock(p.view, -1));
      const wide = after('99. a\n100. b', 1, (p) => moveBlock(p.view, 1));
      const nestedDoc = '9. a\n   - x\n10. b\n    - y';
      const p = mountProse(nestedDoc);
      p.select(lineStart(nestedDoc, 3));
      moveBlock(p.view, -1);
      const nested = p.doc();
      const span = (line: number): string => {
        const r = blockRangeAt(p.view.state, lineStart(nested, line));
        return r ? `${r.startLine}-${r.endLine}` : 'null';
      };
      const spans = `${span(1)},${span(3)}`;
      p.destroy();
      return (
        dragged === 'Intro.\n\n9. Tenth item\n10. Ninth item' &&
        unit === '9. b\n10. a' &&
        wide === '99. b\n100. a' &&
        nested === '9. b\n   - y\n10. a\n    - x' &&
        spans === '1-2,3-4'
      );
    },
  },
];
