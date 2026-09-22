/*
 * Triple-click selects the paragraph under the pointer.
 *
 * CodeMirror's own triple-click selects the clicked source line and the line break
 * after it. In a rendered document that is the wrong unit three ways over: a
 * paragraph written over two source lines loses its other line, a list item's `- `
 * marker is selected along with its text, and the trailing line break takes the
 * blank line with it, so typing over the selection joins the paragraph to the next.
 *
 * The unit here is the text a person sees as one block, found in the syntax tree:
 *
 * - a paragraph: every source line it spans, first character to last, with no line
 *   break after it. Inside a list item or a quote this is the item's or the quoted
 *   paragraph's text, so the list marker and the first line's `> ` stay put;
 * - a heading: its text, without the `#`s (or a setext heading's underline);
 * - a task item: its text, without the `[ ]` or `[x]`;
 * - a line of code in a code block: that line, without its line break.
 *
 * Anywhere else (a blank line, a table, a rule) nothing is claimed, and the click is
 * left to whatever handles it now.
 */

import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { SyntaxNode } from '@lezer/common';

const HEADING = /^(ATXHeading[1-6]|SetextHeading[12])$/;

/** `[from, to)` pulled in past spaces and tabs at either end. */
function trimmed(state: EditorState, from: number, to: number): { from: number; to: number } {
  const text = state.sliceDoc(from, to);
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  return lead + trail >= text.length ? { from, to: from } : { from: from + lead, to: to - trail };
}

/** A heading's text: after an ATX heading's opening `#`s and before any closing ones, or above a setext underline. */
function headingText(state: EditorState, node: SyntaxNode): { from: number; to: number } {
  let from = node.from;
  let to = node.to;
  for (let mark = node.getChild('HeaderMark'); mark; mark = mark.nextSibling) {
    if (mark.name !== 'HeaderMark') continue;
    if (mark.from === node.from) from = mark.to;
    else to = Math.min(to, mark.from);
  }
  if (node.name.startsWith('Setext')) to = Math.min(to, state.doc.lineAt(to).from);
  return trimmed(state, from, to);
}

/** A task item's text, after its `[ ]` or `[x]`. */
function taskText(state: EditorState, node: SyntaxNode): { from: number; to: number } {
  const marker = node.getChild('TaskMarker');
  return trimmed(state, marker ? marker.to : node.from, node.to);
}

/**
 * The range a triple-click at `pos` selects, or null when there is no block of text
 * there. `pos` is the document position the click lands on.
 */
export function paragraphRangeAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const tree = syntaxTree(state);
  // A click past the end of a line lands on its end, where the node to the left is
  // the one the person clicked on.
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'Paragraph') return trimmed(state, node.from, node.to);
      if (node.name === 'Task') return taskText(state, node);
      if (HEADING.test(node.name)) return headingText(state, node);
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        const line = state.doc.lineAt(pos);
        // The fences themselves are not code. Clicking one is left alone.
        const inside = node.getChildren('CodeText').some((code) => code.from <= line.to && code.to >= line.from);
        return inside ? { from: line.from, to: line.to } : null;
      }
      if (node.name === 'Table' || node.name === 'HTMLBlock') return null;
    }
  }
  return null;
}

/** Select the paragraph at `pos`, as a triple-click there does. False when there is none. */
export function selectParagraphAt(view: EditorView, pos: number): boolean {
  const range = paragraphRangeAt(view.state, pos);
  if (!range) return false;
  view.dispatch({ selection: { anchor: range.from, head: range.to }, userEvent: 'select.pointer' });
  return true;
}

/**
 * Hand the third click to CodeMirror as a selection gesture of its own, rather
 * than claiming the `mousedown` and dispatching a selection from outside.
 *
 * Claiming it looked equivalent and was not. `preventDefault` stops the browser
 * making a selection for that click, so the contenteditable keeps the caret the
 * second click left behind, and CodeMirror's DOM observer reads that stale
 * selection back on its next measure, a few milliseconds after the dispatch. The
 * paragraph highlighted and then unselected itself on roughly two attempts in
 * three, with no speed that reliably avoided it. Going through this facet puts
 * the selection inside the gesture CodeMirror is already running, so it writes
 * the DOM selection itself and has nothing to read back.
 *
 * Returning null leaves the click to CodeMirror, which is what happens on a blank
 * line, in a table, and for any click that is not a plain third one.
 */
export const paragraphTripleClick = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.detail !== 3 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return null;
  const range = paragraphRangeAt(view.state, pos);
  if (!range) return null;
  const selection = EditorSelection.single(range.from, range.to);
  return {
    // The same paragraph however the pointer moves afterwards: a drag that begins
    // with a triple-click is still that paragraph, not a growing range.
    get: () => selection,
    update: () => false,
  };
});
