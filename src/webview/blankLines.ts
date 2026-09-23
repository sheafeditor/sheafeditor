/*
 * Blank lines drawn as the gap they are.
 *
 * Markdown needs a blank line between most blocks, so nearly every document is
 * half empty lines. Sheaf drew each of them as a full line of body text, which is
 * where its block spacing came from: a paragraph line carries only `.cm-line`'s
 * 1px of padding, and the air above a heading is the heading's own top padding.
 * The result put a heading and the table under it about three lines apart.
 *
 * A blank line that only separates two blocks is not text anyone reads, so it
 * draws as a gap instead: `blankLines` adds a class, `media/webview.css` gives
 * that class its height. Nothing is written to the document, ever. Three rules
 * keep it from getting in the way of editing:
 *
 *   - **The caret's line is full height.** While the caret sits on a blank line,
 *     or a selection touches it, the class comes off, so typing there, clicking
 *     there, and arrowing on and off it meet a line of the usual size. This is
 *     the same shape as the reveal in `livePreview.ts`: what the caret is on is
 *     drawn as it is worked on rather than as it is read.
 *   - **A blank line inside content keeps its height.** In a fenced block, in
 *     YAML front matter, or in a ```csv / ```tsv / ```view block, a blank line is
 *     a line of the content and losing it would change what the reader sees.
 *   - **Only a separator shrinks.** A blank line above everything in the document
 *     or below everything in it is not separating two blocks, and the one at the
 *     end is where a person clicks to write more, so those stay full height.
 *
 * Several blank lines in a row each draw small, so more blank lines still read as
 * more space. Source mode is left alone entirely: it shows the file as the text
 * it is, and a squashed line there would misreport what is on disk.
 */

import { EditorState, Extension, Line, Range, Text } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { posInFrontMatter } from './frontMatter';
import { sourceModeOn } from './livePreview';

/** The class a blank line drawn as a gap carries. `media/webview.css` sets its height. */
export const BLANK_LINE_CLASS = 'sheaf-blank-line';

const blankLineDeco = Decoration.line({ class: BLANK_LINE_CLASS });

/** A line holding nothing a reader sees. Spaces and tabs count as blank, as they do to Markdown. */
const isBlank = (line: Line): boolean => line.text.trim() === '';

/**
 * The first and last lines of the document holding something, by line number, or
 * 0 for a document holding nothing. Cached per document text, because every blank
 * line in the viewport asks the same question of the same text.
 */
const contentBoundsCache = new WeakMap<Text, { first: number; last: number }>();

function contentBounds(doc: Text): { first: number; last: number } {
  let bounds = contentBoundsCache.get(doc);
  if (!bounds) {
    let first = 0;
    let last = 0;
    for (let n = 1; n <= doc.lines; n++) {
      if (doc.line(n).text.trim() !== '') {
        first = n;
        break;
      }
    }
    if (first) {
      for (let n = doc.lines; n >= first; n--) {
        if (doc.line(n).text.trim() !== '') {
          last = n;
          break;
        }
      }
    }
    bounds = { first, last };
    contentBoundsCache.set(doc, bounds);
  }
  return bounds;
}

/**
 * Whether the blank `line` is a line of some block's content rather than a gap
 * between blocks.
 *
 * Front matter is a text question, not a tree one (see `frontMatter.ts`: the
 * dialect has no node for it). Everything else is a code block in the tree, and
 * `FencedCode` covers ```csv, ```tsv and ```view along with every other fence,
 * since what makes a blank line inside one content is the fence and not the
 * language written after it.
 */
function insideContent(state: EditorState, line: Line): boolean {
  if (posInFrontMatter(state.doc, line.from)) return true;
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(line.from, side); node; node = node.parent) {
      const fenced = node.name === 'FencedCode' || node.name === 'CodeBlock';
      if (fenced && node.from < line.from && line.to <= node.to) return true;
    }
  }
  return false;
}

/** Whether any selection range covers `line` or rests on it, the bare caret included. */
function selectionTouches(state: EditorState, line: Line): boolean {
  return state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
}

/**
 * Whether the line numbered `number` is a blank line drawn as a gap. Exported so a
 * check can ask the question without reading it back out of the DOM.
 */
export function isSpacingBlankLine(state: EditorState, number: number): boolean {
  const doc = state.doc;
  if (number < 1 || number > doc.lines) return false;
  // Source mode shows the file as the text it is, where every line is a line of it.
  if (sourceModeOn(state)) return false;
  const line = doc.line(number);
  if (!isBlank(line)) return false;
  const { first, last } = contentBounds(doc);
  // Above everything, below everything, or a document with nothing in it: not a separator.
  if (!first || number < first || number > last) return false;
  if (selectionTouches(state, line)) return false;
  return !insideContent(state, line);
}

function build(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const { state } = view;
  let done = 0;
  for (const { from, to } of view.visibleRanges) {
    let pos = Math.max(from, state.doc.lineAt(from).from);
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      // Two visible ranges can share a line; it is decorated once.
      if (line.number > done) {
        done = line.number;
        if (isSpacingBlankLine(state, line.number)) ranges.push(blankLineDeco.range(line.from));
      }
      if (line.to >= state.doc.length) break;
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges);
}

/**
 * Blank lines that only separate blocks, drawn as a gap. Line decorations only:
 * nothing here replaces text, so caret motion, selection and the document are
 * exactly as they were without it.
 */
export const blankLines: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate): void {
      // The selection matters as much as the text: the caret arriving on a blank
      // line gives it back its height, and leaving takes it away again.
      const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
      if (update.docChanged || update.selectionSet || update.viewportChanged || treeChanged) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
