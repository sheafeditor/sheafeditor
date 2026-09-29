/*
 * Drawing a document's YAML front matter: in full, as one line, or not at all.
 *
 * Front matter is the document's metadata rather than its text, and how much of it a
 * person wants to see depends on what they are doing. Twelve lines of it at the top of
 * a file pushes the first heading off the screen of somebody who opened the file to
 * read it, and the same twelve lines are the whole point for somebody who opened it to
 * change the slug.
 *
 * Three states, then. Shown draws every line, which is what it always did. Collapsed
 * draws one strip that names itself and shows the title, so a person can see the
 * metadata is there and what document it belongs to without reading it. Hidden draws
 * nothing and takes no height, so the text starts where it would in a file with no
 * front matter at all.
 *
 * None of this touches the file. The lines are still in the document, still saved,
 * still there for the next tool to read, and a find or a select-all still reaches them.
 */

import type { FromWebview } from '../protocol';
import { EditorState, Extension, Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { frontMatterEnd } from './frontMatter';

/** How much of the front matter is drawn. */
export type FrontMatterMode = 'shown' | 'collapsed' | 'hidden';

let mode: FrontMatterMode = 'collapsed';
/** This document's own state, when it has one, which wins over the setting. */
let ownState: FrontMatterMode | null = null;
let host: ((message: FromWebview) => void) | null = null;
let seq = 0;

/** What the host's setting says, the default for a document with no state of its own. */
export function setFrontMatterMode(next: FrontMatterMode): void {
  mode = next;
}

export function frontMatterMode(): FrontMatterMode {
  return ownState ?? mode;
}

/**
 * Where a document's own state is kept, and asking for it.
 *
 * Setting a host asks straight away, as the comment folds do, so a document that was
 * left open is drawn the way it was left rather than flickering through the default
 * first.
 */
export function setFrontMatterHost(send: ((message: FromWebview) => void) | null): void {
  host = send;
  send?.({ type: 'frontMatterStateRead', id: `frontmatter-${++seq}` });
}

/** The host's answer: this document's state, or null to follow the setting. */
export function handleFrontMatterState(_id: string, state: unknown): void {
  ownState = state === 'shown' || state === 'collapsed' || state === 'hidden' ? state : null;
}

/** Remember this document's state, or forget it and follow the setting again. */
function keep(state: FrontMatterMode | null): void {
  ownState = state;
  host?.({ type: 'frontMatterStateWrite', state });
}

/**
 * Set what this document does, from a control outside the strip: the right-click menu,
 * which is the only way back once the block is hidden and there is nothing to press.
 * Null means follow the setting again.
 */
export function setFrontMatterForDocument(view: EditorView, state: FrontMatterMode | null): void {
  keep(state);
  view.dispatch({ effects: redraw.of(null) });
}

/**
 * Make what this document is doing the setting, and stop this document overriding it.
 *
 * Both halves matter. Writing the setting alone would leave the document's own state on
 * top of it, so the one document the person set it from would be the one document not
 * following it, and the next document would look like the change had not worked.
 */
export function frontMatterEverywhere(view: EditorView): void {
  const state = frontMatterMode();
  host?.({ type: 'setFrontMatter', state });
  setFrontMatterForDocument(view, null);
}

/** Drop this document's own state, so it follows the setting again. */
export function resetFrontMatter(view: EditorView): void {
  setFrontMatterForDocument(view, null);
}

/** Whether this document has a state of its own, which is what there is to reset. */
export function frontMatterIsOwn(): boolean {
  return ownState !== null;
}

/**
 * A redraw, for a state the editor keeps outside its own document state.
 *
 * The chevron changes what this document does, which the host keeps, so there is
 * nothing in the editor state to change: this effect exists only to give the
 * decorations a transaction to be rebuilt on.
 */
const redraw = StateEffect.define<null>();

/** The `title:` value, for a strip that says which document this is. */
function titleOf(state: EditorState, endLine: number): string {
  for (let n = 2; n < endLine; n++) {
    const match = /^title\s*:\s*(.+)$/i.exec(state.doc.line(n).text);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

/** The one line a collapsed block is drawn as, with the chevron that opens it. */
class StripWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly lines: number
  ) {
    super();
  }

  eq(other: StripWidget): boolean {
    return other.title === this.title && other.lines === this.lines;
  }

  toDOM(view: EditorView): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'sheaf-frontmatter-strip';
    const button = document.createElement('button');
    button.className = 'sheaf-frontmatter-fold';
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.title = 'Show the front matter';
    // The label says what it is; the title says which document, when there is one.
    button.textContent = this.title ? `Front matter: ${this.title}` : `Front matter, ${this.lines} lines`;
    button.addEventListener('mousedown', (event) => {
      // The press, not the click: a press that reached the document would put the caret
      // inside the block and reveal it that way instead, which is a different thing.
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      // This document, from now on, which is what the person just asked for. The
      // setting is still the default for every other document.
      keep('shown');
      view.dispatch({ effects: redraw.of(null) });
    });
    strip.appendChild(button);
    return strip;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** Nothing at all, taking no height. */
const gone = Decoration.replace({ block: true });

/**
 * The chevron on an open block, which folds it.
 *
 * Collapsed front matter drew as a strip with a chevron on it; open, there was nothing to
 * press. The block was five lines of YAML and the only way back was the right-click menu or
 * the command palette, which nobody looks in for a control they just used.
 *
 * Inline at the very start of line 1, so it sits where the collapsed strip's chevron sits and
 * costs no height: the `---` line is already drawn in this state, and a block widget above it
 * would push the whole document down a line for a control.
 *
 * Visible rather than shown on hover. A control that exists only while the pointer is over it
 * cannot be found by somebody looking for it.
 */
class FoldWidget extends WidgetType {
  eq(): boolean {
    // Every one of these is the same control; there is nothing in it to differ.
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button');
    button.className = 'sheaf-frontmatter-fold is-open';
    button.type = 'button';
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-label', 'Front matter');
    button.title = 'Collapse the front matter';
    // The press, not the click, for the reason the strip's own button gives: a press reaching
    // the document would put the caret in the block, which is a different thing.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      keep('collapsed');
      view.dispatch({ effects: redraw.of(null), ...caretOutOfBlock(view.state) });
    });
    return button;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Where the caret goes when the block it is in is folded away: the start of the document's
 * body, past the front matter and the blank lines under it.
 *
 * Nothing when the caret is elsewhere, so folding from outside the block leaves the selection
 * exactly where it was. A caret left inside something that is not drawn is the state this
 * avoids: the next keystroke would edit metadata nobody can see.
 */
function caretOutOfBlock(state: EditorState): { selection?: { anchor: number } } {
  const endLine = frontMatterEnd(state.doc);
  if (!endLine) return {};
  if (!state.selection.ranges.some((r) => r.from <= state.doc.line(endLine).to)) return {};
  let line = endLine;
  while (line < state.doc.lines && state.doc.line(line + 1).text.trim() === '') line++;
  return { selection: { anchor: line < state.doc.lines ? state.doc.line(line + 1).from : state.doc.length } };
}

function decorations(state: EditorState): DecorationSet {
  const endLine = frontMatterEnd(state.doc);
  if (endLine === 0) return Decoration.none;
  // Shown by the setting, opened by hand, or asked for by a caret inside it: a person
  // editing the metadata needs to see it, whatever the default says.
  const caretInside = state.selection.ranges.some((r) => r.from <= state.doc.line(endLine).to);
  const showing = frontMatterMode();
  if (showing === 'shown' || caretInside) {
    // Hidden reserves no space by design, so it carries no control either: one would be the
    // space back. The commands, the toolbar and the setting are the way out of it.
    if (showing === 'hidden') return Decoration.none;
    return Decoration.set([Decoration.widget({ widget: new FoldWidget(), side: -1 }).range(state.doc.line(1).from)]);
  }
  const from = state.doc.line(1).from;
  /*
   * Hidden takes the blank lines under the block with it. They are there to hold the
   * metadata apart from the text, so with the metadata gone they separate nothing, and
   * leaving them behind leaves the gap the person asked to reclaim: measured, the first
   * heading sat eight pixels lower than it does in a file that never had front matter,
   * which is exactly the height a blank line is drawn as.
   *
   * Collapsed keeps them, because the strip is something on the page and wants the same
   * air around it as the block did.
   */
  let last = endLine;
  if (showing === 'hidden') {
    while (last < state.doc.lines && state.doc.line(last + 1).text.trim() === '') last++;
  }
  const to = state.doc.line(last).to;
  const ranges: Range<Decoration>[] = [
    showing === 'hidden'
      ? gone.range(from, to)
      : Decoration.replace({
          widget: new StripWidget(titleOf(state, endLine), endLine),
          block: true,
        }).range(from, to),
  ];
  return Decoration.set(ranges);
}

const field = StateField.define<DecorationSet>({
  create: decorations,
  update(_set, tr) {
    // Rebuilt on any change, because the mode is not in the state: the host sends it
    // and the page dispatches an empty transaction to take it up.
    return decorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const frontMatterView: Extension = [field];
