/*
 * How far a selection reaches. One rule decides it for Copy ref, Reveal Syntax On
 * Line and the drawn highlight: a selection ending at the start of a line covers
 * nothing of that line. The highlight's geometry needs layout, which jsdom has
 * none of, so only the pure step that merges measured rectangles into screen
 * lines is checked here, with rectangles written out by hand.
 */

import { Text } from '@codemirror/state';
import { Scenario, mountProse } from '../harness';
import { coveredEnd } from '../../src/webview/selectionExtent';
import { fillLineHeight, screenLineBoxes } from '../../src/webview/selectionHighlight';
import { mountContextMenu } from '../../src/webview/contextmenu';
import { setLivePreviewConfig } from '../../src/webview/livePreview';

const G: any = globalThis;

/** Choose Copy ref with `from` to `to` selected, and return the line range it names. */
function refLines(doc: string, from: number, to: number): string {
  const copied: string[] = [];
  const p = mountProse(doc);
  p.select(from, to);
  document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
  mountContextMenu(p.view.dom, { getView: () => p.view, getFileName: () => 'doc.md', copyToClipboard: (t) => copied.push(t) });
  p.view.contentDOM.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }));
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-menu .sheaf-ctx-item')).find(
    (b) => b.querySelector('span')!.textContent === 'Copy ref',
  );
  item!.click();
  document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
  p.destroy();
  return (copied[0] ?? '').split('\n')[0].replace('doc.md:', '');
}

/** The 1-based numbers of the lines showing their raw Markdown, with `from` to `to` selected. */
function revealedLines(doc: string, from: number, to: number): string {
  setLivePreviewConfig({ revealSyntaxOnLine: true });
  const p = mountProse(doc);
  p.select(from, to);
  const shown = Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
    .map((el, i) => (el.textContent === doc.split('\n')[i] ? i + 1 : 0))
    .filter((n) => n > 0);
  p.destroy();
  return shown.length > 1 ? `${shown[0]}-${shown[shown.length - 1]}` : `${shown[0]}`;
}

export const scenarios: Scenario[] = [
  {
    name: 'a selection ending at the start of a line covers only up to the end of the line before it',
    run: () => {
      const doc = Text.of(['one', 'two', 'three']);
      return (
        // Line 2 with its line break: ends at the end of line 2.
        coveredEnd(doc, { from: 4, to: 8 }) === 7 &&
        // One character into line 3 does reach it.
        coveredEnd(doc, { from: 4, to: 9 }) === 9 &&
        // Ending mid-line, or at the end of the document, is unchanged.
        coveredEnd(doc, { from: 0, to: 2 }) === 2 &&
        coveredEnd(doc, { from: 8, to: 13 }) === 13 &&
        // Only the line break selected: it ends where it starts, on line 1.
        coveredEnd(doc, { from: 3, to: 4 }) === 3 &&
        // A caret is where it is, even at the start of a line.
        coveredEnd(doc, { from: 4, to: 4 }) === 4
      );
    },
  },
  {
    name: 'Copy ref and reveal syntax on line agree on the lines a selection covers',
    run: () => {
      // Every line differs from how it renders, so a line reads back as its source only when revealed.
      const doc = '- **a** one\n- **b** two\n- **c** three';
      const second = doc.indexOf('- **b');
      const third = doc.indexOf('- **c');
      const cases: [number, number, string][] = [
        [0, second, '1'],
        [0, third, '1-2'],
        [second, third + 1, '2-3'],
        [third, second, '2'],
      ];
      return cases.every(([from, to, lines]) => refLines(doc, from, to) === lines && revealedLines(doc, from, to) === lines);
    },
  },
  {
    name: 'measured selection rectangles merge into one box per screen line, from the first selected character to the last',
    run: () => {
      // A wrapped line selected from mid-way: two text runs and a bold span on the first
      // screen line (the span also reports its own box), one run on the second.
      const rows = screenLineBoxes([
        { left: 300, top: 100, right: 380, bottom: 118 },
        { left: 380, top: 99, right: 450, bottom: 119 },
        { left: 380, top: 100, right: 450, bottom: 118 },
        { left: 120, top: 124, right: 260, bottom: 142 },
        // A collapsed rectangle at the line break paints nothing.
        { left: 260, top: 124, right: 260, bottom: 142 },
      ]);
      const merged =
        rows.length === 2 &&
        rows[0].left === 300 && rows[0].right === 450 && rows[0].top === 99 && rows[0].bottom === 119 &&
        rows[1].left === 120 && rows[1].right === 260;
      // Grown to a 24px line height, the two screen lines meet halfway and keep their widths.
      const filled = fillLineHeight(rows, 24);
      const tall =
        filled[0].top === 97 && filled[0].bottom === filled[1].top && filled[1].bottom === 145 &&
        filled[0].left === 300 && filled[1].right === 260;
      return merged && tall && screenLineBoxes([]).length === 0;
    },
  },
];
