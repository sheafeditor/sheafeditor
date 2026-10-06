/*
 * What is showing its raw Markdown: the explicit reveal, whole-document source mode, and the lines
 * that follow from the two.
 *
 * This is state rather than drawing. `livePreview.ts` reads it to decide what to hide, and so does
 * everything else that has to agree with the document about where the syntax is visible: the comment
 * gutter, the invisible-marker edges, the line-start commands, the table grid, the search.
 *
 * It lived in `livePreview.ts`, beside the decorations that read it, and that is what made the
 * module two things. Ten modules imported it and only two of them wanted a decoration layer, so the
 * other eight downloaded 16 KB of drawing, and behind it the 6 KB image widget, to ask whether a
 * line is showing its source. `toolbar.ts` and `shortcuts.ts` paid the same, twice over, through
 * `lineStart.ts` and `invisibleEdges.ts`, which is why the formatting toolbar carried the picture
 * drawing code.
 *
 * Same shape and same cure as `inlineOnly.ts` and `fenceLines.ts`: the fact in its own module,
 * below everybody who asks for it. The drawing layer may depend on the state; the state may not
 * depend on the drawing layer.
 */

import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { blockRangeAt } from './blockModel';
import { coveredEnd } from './selectionExtent';
import { floatingField, setSourceMode as setSourceModeEffect } from './floatingState';

export interface LivePreviewConfig {
  revealSyntaxOnLine: boolean;
}

/*
 * The value before a host has sent one, which must be the manifest's default.
 *
 * A host sends the config at `init`, so in the product this is overwritten before anybody
 * sees a document and the value here never shows. Nothing sends one in a test, so it is the
 * value every scenario inherits, and it used to be `true` while `sheaf.revealSyntaxOnLine`
 * defaults to `false`. A scenario that said nothing was therefore written for a state a
 * person has to turn on deliberately. `test/host.test.mjs` now pins the two together,
 * because nothing compared them and that is how they came apart.
 */
let currentConfig: LivePreviewConfig = { revealSyntaxOnLine: false };

/**
 * Bumped whenever the config changes. The view plugin and the three block-widget fields compare it
 * on every update, so the next transaction after a settings change (even an empty one) redraws with
 * the new config instead of waiting for the caret to move.
 *
 * Read through a function rather than exported as the variable, so the counter stays writable only
 * by `setLivePreviewConfig`. An exported `let` is a live binding, so reading it would work; it would
 * also let any importer assign it, and a redraw counter that anyone can set is a redraw counter that
 * stops meaning "the config changed".
 */
let configVersion = 0;

export function revealConfigVersion(): number {
  return configVersion;
}

export function setLivePreviewConfig(cfg: LivePreviewConfig): void {
  if (cfg.revealSyntaxOnLine !== currentConfig.revealSyntaxOnLine) configVersion++;
  currentConfig = cfg;
}

// ---- Explicit reveal state ------------------------------------------------
//
// Reveal (showing a block's raw Markdown for editing) is an EXPLICIT state, set
// by the Edit Markdown command and the two menus that run it, by the opt-in
// double-click, and by the search. It is deliberately NOT derived from the
// selection, so an ordinary drag-select never exposes syntax markers. The
// revealed range is mapped across edits, closes on a line break typed into it,
// and collapses once the cursor leaves it.

/** Set (or clear, with null) the block range whose raw Markdown is revealed. */
export const setReveal = StateEffect.define<{ from: number; to: number } | null>();

// ---- Whole-document source mode -------------------------------------------
//
// Source mode is the same idea as Edit Markdown, at the size of the document, so
// it runs through the same state: the reveal covers every byte, every marker
// shows, and a table falls back to the pipe rows it is written as. What sets it
// apart is that it is sticky. A block's reveal closes when the caret leaves it
// or a line break is typed into it, which is right for one block someone is
// editing and wrong for a document someone asked to read as source. So while
// source mode is on, the rules below that close a reveal do not run.
//
// Whether it is on lives in the floating state, which already carries it for the
// selection toolbar, so there is one answer rather than two that can disagree.
//
// The command is the only way out. Escape and Edit Markdown both clear a reveal,
// and while source mode is on they leave the document showing its source: only
// the command also puts the monospace font away, so anything else that closed
// the reveal would leave that font over rendered text.

/** Whether the whole document is showing its raw Markdown. */
export function sourceModeOn(state: EditorState): boolean {
  return state.field(floatingField, false)?.sourceMode ?? false;
}

/** Whether source mode is on once `tr` has applied, its own effect included. */
function sourceModeAfter(tr: Transaction): boolean {
  let on = tr.startState.field(floatingField, false)?.sourceMode ?? false;
  for (const e of tr.effects) if (e.is(setSourceModeEffect)) on = e.value;
  return on;
}

/**
 * Turn whole-document source mode on or off.
 *
 * Both halves move in the one call because neither is the feature on its own:
 * the class is what the stylesheet reads for the monospace font, and the state
 * is what stops the markers being hidden. Setting only the class is what left
 * source mode looking like a font change.
 *
 * The reveal travels as an ordinary `setReveal` alongside it. The field would
 * work it out from the source-mode flag regardless; sending the effect is what
 * tells the two fields that draw from a distance — tables, and the block widget
 * for multi-line image markup — that there is something to redraw.
 */
export function setDocumentSourceMode(view: EditorView, root: HTMLElement, on: boolean): void {
  root.classList.toggle('source-mode', on);
  view.dispatch({
    effects: [
      setSourceModeEffect.of(on),
      setReveal.of(on ? { from: 0, to: view.state.doc.length } : null),
    ],
    scrollIntoView: false,
  });
}

/**
 * Whether `tr` writes a line break the person typed into `range`.
 *
 * A line break ends the line someone was working on: they have finished with that
 * block and moved on, so its Markdown goes away and it renders again. Without this
 * the break is treated as text added at the end of the block, the reveal grows to
 * cover the new line, and the caret never leaves it.
 *
 * The test is on what the edit inserts rather than on the key, because the break
 * arrives from several commands — Markdown's list and quote continuation, Sheaf's
 * Enter for an empty item or quote line, and the hard break behind Shift+Enter —
 * and not all of them mark the transaction as typing.
 *
 * A paste is not Enter. Text arriving with line breaks in it is still text being
 * put into the block, so a multi-line paste leaves the Markdown shown.
 */
function typedLineBreak(tr: Transaction, range: { from: number; to: number }): boolean {
  if (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop')) return false;
  let found = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.lines > 1 && toA >= range.from && fromA <= range.to) found = true;
  });
  return found;
}

export const revealField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    // Source mode reveals the whole document and keeps it revealed. It is read
    // first because none of the rules below, each of which closes a block's
    // reveal, applies to it: the caret cannot leave the document, and a line
    // break typed anywhere would otherwise put the source away.
    if (sourceModeAfter(tr)) return { from: 0, to: tr.newDoc.length };
    // A reveal asked for in this transaction is what the range is, edits and all:
    // the table's Edit raw source rewrites the pipes and opens them in one go.
    let asked = false;
    for (const e of tr.effects) {
      if (e.is(setReveal)) {
        value = e.value;
        asked = true;
      }
    }
    if (!value) return null;
    if (tr.docChanged) {
      if (!asked && typedLineBreak(tr, value)) return null;
      // Text typed at either edge of the block joins it, so adding to the end
      // of a revealed line (the most common edit) keeps its Markdown shown.
      const from = tr.changes.mapPos(value.from, -1);
      const to = tr.changes.mapPos(value.to, 1);
      if (from >= to) return null;
      value = { from, to };
    }
    // Collapse the reveal once the caret leaves the block.
    const sel = tr.selection ?? (tr.docChanged ? tr.startState.selection.map(tr.changes) : tr.startState.selection);
    const head = sel.main.head;
    if (head < value.from || head > value.to) return null;
    return value;
  },
});

// ---- Active-line computation ---------------------------------------------

/**
 * The lines showing their raw Markdown, by line number.
 *
 * Empty in source mode, where every line shows it: the callers ask
 * `sourceModeOn` first rather than making this fill a set with every line number
 * in the document on every redraw.
 *
 * Named `activeLines` because the drawing layer and the block widgets drawn from
 * their own fields all read it, so what shows its source is decided in one place
 * for every construct.
 */
export function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  if (sourceModeOn(state)) return lines;
  const doc = state.doc;
  const addRange = (from: number, to: number): void => {
    const start = doc.lineAt(from).number;
    const end = doc.lineAt(to).number;
    for (let n = start; n <= end; n++) lines.add(n);
  };

  // Explicit double-click reveal — always shows the block's raw Markdown.
  const reveal = state.field(revealField, false);
  if (reveal) addRange(reveal.from, reveal.to);

  // Obsidian-style live preview (opt-in): also reveal whatever the selection
  // touches, including the bare cursor line, widened to the whole block at each
  // end: every line of a quote or paragraph, or a list item with its
  // continuation and nested lines. Off by default, so plain selections never
  // expose syntax.
  if (currentConfig.revealSyntaxOnLine) {
    for (const range of state.selection.ranges) {
      // A selection ending at the start of a line (a triple-clicked line) covers
      // nothing of that line, so neither it nor its block is revealed.
      const end = coveredEnd(doc, range);
      addRange(range.from, end);
      for (const pos of range.empty ? [range.head] : [range.from, end]) {
        const block = blockRangeAt(state, pos);
        if (block && block.kind !== 'frontmatter') addRange(block.from, block.to);
      }
    }
  }

  return lines;
}
