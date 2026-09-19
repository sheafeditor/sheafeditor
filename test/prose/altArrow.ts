/*
 * Alt-ArrowUp and Alt-ArrowDown with a caret: a block of any height moves past whole
 * neighbouring blocks, the way the handle's Move up and Move down do, and nothing
 * crosses the fences of front matter.
 */

import { Scenario, mountProse } from '../harness';

interface Outcome {
  doc: string;
  caret: number;
}

/** Press `keys` in turn on a fresh editor holding `doc` with the caret at `at`. */
function press(doc: string, at: number, ...keys: string[]): Outcome {
  const p = mountProse(doc);
  p.select(at);
  for (const key of keys) p.press(key);
  const out = { doc: p.doc(), caret: p.view.state.selection.main.head };
  p.destroy();
  return out;
}

/** Offset of the first `needle` after the start of line `line` (1-based) in `doc`. */
function at(doc: string, line: number, needle: string): number {
  const lines = doc.split('\n');
  const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  return start + lines[line - 1].indexOf(needle);
}

const FRONT = '---\ntitle: x\n---\n\nIntro text here.\n\n## Next';

export const scenarios: Scenario[] = [
  {
    name: 'Alt-ArrowUp moves a one-line item above a sibling item together with its nested items',
    run: () => {
      const unit = press('- a\n  - b\n- c', 12, 'Alt-ArrowUp');
      const unitOk = unit.doc === '- c\n- a\n  - b' && unit.caret === 2;
      const report = '- Apple\n  - Apple child\n- Banana';
      const fruit = press(report, at(report, 3, 'Banana'), 'Alt-ArrowUp');
      const fruitOk = fruit.doc === '- Banana\n- Apple\n  - Apple child';
      const nestedDoc = '- a\n  - y\n    - z\n  - x';
      const nested = press(nestedDoc, at(nestedDoc, 4, 'x'), 'Alt-ArrowUp');
      const nestedOk = nested.doc === '- a\n  - x\n  - y\n    - z';
      return unitOk && fruitOk && nestedOk;
    },
  },
  {
    name: 'Alt-ArrowDown moves a one-line item below a sibling item together with its nested items',
    run: () => {
      const unit = press('- a\n- b\n  - c', 2, 'Alt-ArrowDown');
      const unitOk = unit.doc === '- b\n  - c\n- a' && unit.caret === at(unit.doc, 3, 'a');
      const report = '- Banana\n- Apple\n  - Apple child';
      const fruit = press(report, at(report, 1, 'Banana'), 'Alt-ArrowDown');
      const fruitOk = fruit.doc === '- Apple\n  - Apple child\n- Banana';
      const nestedDoc = '- a\n  - x\n  - y\n    - z';
      const nested = press(nestedDoc, at(nestedDoc, 2, 'x'), 'Alt-ArrowDown');
      const nestedOk = nested.doc === '- a\n  - y\n    - z\n  - x';
      return unitOk && fruitOk && nestedOk;
    },
  },
  {
    name: 'Alt-ArrowUp never moves a line into front matter',
    run: () => {
      const intro = press(FRONT, at(FRONT, 5, 'Intro'), 'Alt-ArrowUp', 'Alt-ArrowUp');
      const unitDoc = '---\nt: 1\n---\n\npara';
      const unit = press(unitDoc, at(unitDoc, 5, 'para'), 'Alt-ArrowUp', 'Alt-ArrowUp');
      const blank = press(unitDoc, at(unitDoc, 4, ''), 'Alt-ArrowUp');
      const tightDoc = '---\nt: 1\n---\npara';
      const tight = press(tightDoc, at(tightDoc, 4, 'para'), 'Alt-ArrowUp');
      const codeDoc = '---\nt: 1\n---\n```\nx\n```';
      const code = press(codeDoc, at(codeDoc, 4, '```'), 'Alt-ArrowUp');
      // A one-line block still moves up past a whole block, then stops under the front matter.
      const headed = '---\nt: 1\n---\n\n# H\n\npara';
      const past = press(headed, at(headed, 7, 'para'), 'Alt-ArrowUp', 'Alt-ArrowUp');
      return (
        intro.doc === FRONT &&
        unit.doc === unitDoc &&
        blank.doc === unitDoc &&
        tight.doc === tightDoc &&
        code.doc === codeDoc &&
        past.doc === '---\nt: 1\n---\n\npara\n\n# H'
      );
    },
  },
  {
    name: 'Alt-ArrowDown never moves a line across the front matter closing fence',
    run: () => {
      const unitDoc = '---\nt: 1\n---\n\npara';
      const fence = press(unitDoc, at(unitDoc, 3, '---'), 'Alt-ArrowDown');
      const tightDoc = '---\nt: 1\n---\npara';
      const inner = press(tightDoc, at(tightDoc, 2, 't'), 'Alt-ArrowDown');
      // A one-line block under front matter moves down past a whole block; the front matter keeps its bytes.
      const intro = press(FRONT, at(FRONT, 5, 'Intro'), 'Alt-ArrowDown');
      return fence.doc === unitDoc && inner.doc === tightDoc && intro.doc === '---\ntitle: x\n---\n\n## Next\n\nIntro text here.';
    },
  },
  {
    name: 'Alt-arrows still move lines between the fences of front matter',
    run: () => {
      const doc = '---\na: 1\nb: 2\n---\n\npara';
      const down = press(doc, at(doc, 2, 'a'), 'Alt-ArrowDown');
      const up = press(doc, at(doc, 3, 'b'), 'Alt-ArrowUp');
      const swapped = '---\nb: 2\na: 1\n---\n\npara';
      const topUp = press(doc, at(doc, 2, 'a'), 'Alt-ArrowUp');
      const lastDown = press(doc, at(doc, 3, 'b'), 'Alt-ArrowDown');
      return down.doc === swapped && up.doc === swapped && topUp.doc === doc && lastDown.doc === doc;
    },
  },
];
