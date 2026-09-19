/*
 * Live-preview decoration engine.
 *
 * The raw Markdown text is always the document. This ViewPlugin walks the Lezer
 * syntax tree over the visible range and layers decorations on top so the text
 * *reads* as rendered output while remaining fully editable:
 *
 *   - mark decorations    → style spans (bold, italic, headings, code…)
 *   - line decorations    → style whole blocks (heading size, quote rule…)
 *   - replace decorations → hide raw syntax markers, or swap them for widgets
 *                           (bullets, checkboxes, horizontal rules, images)
 *
 * A marker is only hidden on lines that are *not* "active", which is how a block's
 * raw Markdown is shown for editing. A line is active when an explicit reveal
 * covers it (Edit Markdown, and find uncovering a match), and, where the opt-in
 * `revealSyntaxOnLine` is on, when a selection touches it. Tables decide
 * separately and by the caret rather than the selection, in tables.ts.
 *
 * Two CodeMirror 6 constraints shape what follows:
 *   - A ViewPlugin's replace decorations may not cross a line break, so every
 *     one of them here stays within a single line. Block widgets must come from
 *     a StateField instead, which is where the HTML image markup written over
 *     several lines is drawn, at the bottom of this file.
 *   - Only the replace and widget ranges are fed to `EditorView.atomicRanges`,
 *     never the mark decorations, or backspace would delete a whole styled span
 *     as one atomic unit.
 */

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { EditorState, Extension, Range, RangeSet, StateEffect, StateField, Text, Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { SyntaxNode, Tree } from '@lezer/common';
import { editableProps, imageWidgetFor, matchHtmlImage } from './images';
import { BlockRange, blockRangeAt } from './blockModel';

export interface LivePreviewConfig {
  revealSyntaxOnLine: boolean;
}

let currentConfig: LivePreviewConfig = { revealSyntaxOnLine: true };

/**
 * Bumped whenever the config changes. The view plugin compares it on every
 * update, so the next transaction after a settings change (even an empty one)
 * redraws with the new config instead of waiting for the caret to move.
 */
let configVersion = 0;

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

// ---- Widgets --------------------------------------------------------------

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'tok-bullet';
    span.textContent = '• ';
    return span;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'md-task';
    box.checked = this.checked;
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const from = this.pos;
      view.dispatch({ changes: { from, to: from + 1, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** An HTML entity such as `&copy;` drawn as the character it stands for. */
class EntityWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: EntityWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = this.text;
    return span;
  }
  ignoreEvent(): boolean {
    // Let clicks place the caret, as they would on the character itself.
    return false;
  }
}

const entityCache = new Map<string, string>();

/**
 * The text an entity reference stands for, decoded by the browser's own HTML
 * parser so every named and numeric form matches what a renderer shows. The
 * input is only ever a single `&...;` token from the syntax tree, parsed into a
 * detached textarea, whose content is text and never markup. An unknown name
 * decodes to itself.
 */
function decodeEntity(raw: string): string {
  let text = entityCache.get(raw);
  if (text === undefined) {
    const area = document.createElement('textarea');
    area.innerHTML = raw;
    text = area.value;
    entityCache.set(raw, text);
  }
  return text;
}

class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  get estimatedHeight(): number {
    return 22;
  }
  toDOM(): HTMLElement {
    const hr = document.createElement('hr');
    hr.className = 'md-hr';
    return hr;
  }
}

// ---- Reusable decorations -------------------------------------------------

const strongMark = Decoration.mark({ class: 'tok-strong' });
const emMark = Decoration.mark({ class: 'tok-em' });
const strikeMark = Decoration.mark({ class: 'tok-strike' });
const inlineCodeMark = Decoration.mark({ class: 'tok-inline-code' });
const highlightMark = Decoration.mark({ class: 'tok-highlight' });
const linkTextMark = Decoration.mark({ class: 'tok-link' });
const dimMark = Decoration.mark({ class: 'tok-mark' });
const bulletDim = Decoration.mark({ class: 'tok-bullet' });
const fenceMark = Decoration.mark({ class: 'tok-code-fence' });
const hide = Decoration.replace({});

const headingLine = (level: number) => Decoration.line({ class: `tok-heading tok-h${level}` });
const quoteLine = Decoration.line({ class: 'tok-quote' });
const codeLine = Decoration.line({ class: 'tok-code-block' });
const frontMatterLine = Decoration.line({ class: 'tok-frontmatter' });

// ---- Front matter ---------------------------------------------------------

const frontMatterCache = new WeakMap<Text, BlockRange | null>();

/**
 * The YAML front matter block that opens the document, fences included, or
 * null when there is none. The block model decides what counts as front
 * matter; its answer depends only on the text, so it is cached per document.
 */
function frontMatterRange(state: EditorState): BlockRange | null {
  const doc = state.doc;
  let range = frontMatterCache.get(doc);
  if (range === undefined) {
    const block = doc.line(1).text.trimEnd() === '---' ? blockRangeAt(state, 0) : null;
    range = block?.kind === 'frontmatter' ? block : null;
    frontMatterCache.set(doc, range);
  }
  return range;
}

// ---- Active-line computation ---------------------------------------------

function activeLineSet(state: EditorState): Set<number> {
  const lines = new Set<number>();
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
      addRange(range.from, range.to);
      for (const pos of range.empty ? [range.head] : [range.from, range.to]) {
        const block = blockRangeAt(state, pos);
        if (block && block.kind !== 'frontmatter') addRange(block.from, block.to);
      }
    }
  }

  return lines;
}

// ---- Builder --------------------------------------------------------------

/**
 * Collects two range sets in one pass: every decoration (for rendering), and
 * only the replace/widget ranges (for atomic cursor motion).
 */
class DecoBuilder {
  readonly all: Range<Decoration>[] = [];
  readonly atomic: Range<Decoration>[] = [];

  mark(deco: Decoration, from: number, to: number): void {
    if (from < to) this.all.push(deco.range(from, to));
  }
  line(deco: Decoration, at: number): void {
    this.all.push(deco.range(at));
  }
  replace(deco: Decoration, from: number, to: number): void {
    if (from >= to) return;
    const r = deco.range(from, to);
    this.all.push(r);
    this.atomic.push(r);
  }
}

interface BuiltDecorations {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
}

/**
 * Whether image markup sits inside a line of text rather than standing on its
 * own. An image written mid-sentence is drawn inline so the sentence keeps
 * running through it; one that stands alone keeps its block layout.
 */
function isInlineImage(state: EditorState, from: number, to: number): boolean {
  const line = state.doc.lineAt(from);
  if (state.doc.lineAt(to).number !== line.number) return false;
  if (line.text.slice(to - line.from).trim() !== '') return true;
  // Only a quote or list marker ahead of it still counts as standing alone.
  return !/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])?\s*$/.test(line.text.slice(0, from - line.from));
}

function buildDecorations(view: EditorView): BuiltDecorations {
  const b = new DecoBuilder();
  const { state } = view;
  const active = activeLineSet(state);
  const doc = state.doc;
  const lineActive = (pos: number): boolean => active.has(doc.lineAt(pos).number);
  // The parser marks every `[...]` as a Link; only some of them are links.
  const definitions = referenceDefinitions(state);
  const linkVerdicts = new Map<number, boolean>();
  const rendersAsLink = (link: SyntaxNode): boolean => {
    let verdict = linkVerdicts.get(link.from);
    if (verdict === undefined) {
      verdict = isRealLink(link, state, definitions);
      linkVerdicts.set(link.from, verdict);
    }
    return verdict;
  };

  // Front matter is YAML, not Markdown: the parser reads its fences as rules
  // or heading underlines and its lists as bullets. Draw it as metadata and
  // give nothing inside it a Markdown decoration.
  const front = frontMatterRange(state);
  if (front) {
    for (let n = front.startLine; n <= front.endLine; n++) b.line(frontMatterLine, doc.line(n).from);
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        if (front && node.from < front.to && name !== 'Document') {
          // No decoration for a node that starts inside. Its children are
          // still walked, and each is judged the same way, so a paragraph that
          // runs past the closing fence (no blank line after `...`) still
          // renders the inline Markdown after the fence.
          return;
        }

        // --- Headings -----------------------------------------------------
        const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) {
          b.line(headingLine(Number(heading[1])), doc.lineAt(node.from).from);
          return;
        }
        if (name === 'HeaderMark') {
          if (lineActive(node.from)) {
            b.mark(dimMark, node.from, node.to);
          } else {
            // Hide the `#`(s) and the following space.
            let end = node.to;
            if (doc.sliceString(end, end + 1) === ' ') end += 1;
            b.replace(hide, node.from, end);
          }
          return;
        }

        // --- Emphasis / strong / strike ----------------------------------
        if (name === 'StrongEmphasis') return void b.mark(strongMark, node.from, node.to);
        if (name === 'Emphasis') return void b.mark(emMark, node.from, node.to);
        if (name === 'Strikethrough') return void b.mark(strikeMark, node.from, node.to);
        if (name === 'Highlight') return void b.mark(highlightMark, node.from, node.to);
        if (name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'HighlightMark') {
          hideOrDim(b, node.from, node.to, lineActive(node.from));
          return;
        }

        // --- Inline code --------------------------------------------------
        if (name === 'InlineCode') {
          const marks = node.node.getChildren('CodeMark');
          const open = marks[0];
          const close = marks.length > 1 ? marks[marks.length - 1] : null;
          if (lineActive(node.from) || !open || !close) {
            // The caret's line shows the span as written, backticks inside the chip.
            b.mark(inlineCodeMark, node.from, node.to);
            return;
          }
          // Hide the backtick fences and, as CommonMark strips it, one space of
          // padding on each side when both sides have one and the code is not
          // all spaces. The chip covers only the code that is left.
          let from = open.to;
          let to = close.from;
          const code = doc.sliceString(from, to);
          if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
            from += 1;
            to -= 1;
          }
          b.replace(hide, open.from, from);
          b.replace(hide, to, close.to);
          b.mark(inlineCodeMark, from, to);
          return;
        }

        // --- Escapes & entities ------------------------------------------
        // The parser never produces these inside code, so code stays as written.
        if (name === 'Escape') {
          // `\*` reads as `*`: hide the backslash off the caret's line.
          if (!lineActive(node.from)) b.replace(hide, node.from, node.from + 1);
          return;
        }
        if (name === 'Entity') {
          if (!lineActive(node.from)) {
            const raw = doc.sliceString(node.from, node.to);
            const text = decodeEntity(raw);
            if (text !== raw) b.replace(Decoration.replace({ widget: new EntityWidget(text) }), node.from, node.to);
          }
          return;
        }

        // --- Hard line breaks ---------------------------------------------
        // A line ends inside a paragraph either with a trailing backslash,
        // which is what Shift+Enter writes, or with two or more trailing
        // spaces. Both are syntax, so both are hidden and the line below
        // stands on its own, as CommonMark defines the break. The parser
        // decides what is a break, which is what keeps the look-alikes
        // literal: a backslash that ends a paragraph or a heading, a single
        // trailing space, and anything inside code are all left as written.
        //
        // The node runs past the marker to the end of the newline it belongs
        // to, and a replace decoration may not cross that, so only the marker
        // on this line is hidden.
        if (name === 'HardBreak') {
          if (!lineActive(node.from)) b.replace(hide, node.from, doc.lineAt(node.from).to);
          return;
        }

        // --- Links & images ----------------------------------------------
        if (name === 'Image') {
          if (!lineActive(node.from)) {
            // The same parse a toolbar action makes. Where it succeeds the
            // image can be rewritten where it stands; where it does not, the
            // address lives on a definition line elsewhere, so the image is
            // drawn without the controls that could not act on it.
            const written = editableProps(doc.sliceString(node.from, node.to));
            const props = written ?? referenceImageProps(node.node, state, definitions);
            const widget =
              props && imageWidgetFor(props, isInlineImage(state, node.from, node.to), written !== null);
            if (widget) {
              b.replace(Decoration.replace({ widget }), node.from, node.to);
            }
          }
          return;
        }
        // HTML images: <img>, <p align><img></p>, <figure><img><figcaption>.
        // Both block-level (HTMLBlock) and inline (HTMLTag) forms are handled.
        if (name === 'HTMLBlock' || name === 'HTMLTag') {
          const raw = doc.sliceString(node.from, node.to);
          const mm = /<img\b/i.test(raw) ? matchHtmlImage(raw) : null;
          if (mm) {
            const from = node.from + mm.start;
            const to = node.from + mm.end;
            // Only replace when the markup sits on a single line (ViewPlugin
            // replace decorations may not span line breaks) and isn't revealed.
            if (doc.lineAt(from).number === doc.lineAt(to).number && !lineActive(from)) {
              const widget = imageWidgetFor(mm.props, isInlineImage(state, from, to));
              if (widget) b.replace(Decoration.replace({ widget }), from, to);
            }
          }
          return;
        }
        if (name === 'Link') {
          // Brackets that are not a link (`[1]`, `[!NOTE]`, `[~]`) render as written.
          if (rendersAsLink(node.node)) b.mark(linkTextMark, node.from, node.to);
          return;
        }
        if (name === 'URL') {
          const parent = node.node.parent?.name;
          if (parent === 'Link' && !lineActive(node.from) && linkTextIsEmpty(node.node.parent!)) {
            // `[](url)` has no text to click, so its address stands in as the
            // link text, without the angle brackets of a `<...>` destination.
            const raw = doc.sliceString(node.from, node.to);
            if (raw.length >= 2 && raw.startsWith('<') && raw.endsWith('>')) {
              b.replace(hide, node.from, node.from + 1);
              b.replace(hide, node.to - 1, node.to);
            }
          } else if (parent === 'Link' || parent === 'Image') {
            // The destination of `[text](url)`: the text stands in for it.
            if (!lineActive(node.from)) b.replace(hide, node.from, node.to);
          } else {
            // A bare URL (GFM autolink), the address inside `<...>`, or the
            // address of a `[label]: url` definition: nothing else on the line
            // stands in for it, so it stays visible and reads as a link.
            b.mark(linkTextMark, node.from, node.to);
          }
          return;
        }
        if (name === 'LinkTitle') {
          // A definition line renders as written, title included.
          if (node.node.parent?.name === 'LinkReference') return;
          if (!lineActive(node.from)) {
            // Hide the spaces before the title with it, or they are left
            // inside the link as an underlined gap after its text.
            const lineStart = doc.lineAt(node.from).from;
            let start = node.from;
            while (start > lineStart && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
            b.replace(hide, start, node.to);
          }
          return;
        }
        if (name === 'LinkLabel') {
          // The `[label]` or `[]` after a reference link's text is syntax, like
          // its brackets. A definition's own label renders as written.
          const parent = node.node.parent;
          if (parent?.name === 'Link' && rendersAsLink(parent)) hideOrDim(b, node.from, node.to, lineActive(node.from));
          return;
        }
        if (name === 'LinkMark') {
          const parent = node.node.parent;
          if (parent?.name === 'Link' && !rendersAsLink(parent)) return;
          // The `:` of a `[label]: url` definition renders as written.
          if (parent?.name === 'LinkReference') return;
          hideOrDim(b, node.from, node.to, lineActive(node.from));
          return;
        }

        // --- Blockquote ---------------------------------------------------
        if (name === 'Blockquote') {
          for (let n = doc.lineAt(node.from).number; n <= doc.lineAt(node.to).number; n++) {
            b.line(quoteLine, doc.line(n).from);
          }
          return;
        }
        if (name === 'QuoteMark') {
          // Keep the `>` visible-but-dim on active lines so the quote rule persists.
          if (lineActive(node.from)) b.mark(dimMark, node.from, node.to);
          else b.replace(hide, node.from, node.to);
          return;
        }

        // --- Lists & tasks ------------------------------------------------
        if (name === 'ListMark') {
          const bulletChar = doc.sliceString(node.from, node.to).trim();
          const ordered = /\d/.test(bulletChar);
          if (lineActive(node.from)) {
            b.mark(dimMark, node.from, node.to);
          } else if (!ordered) {
            b.replace(Decoration.replace({ widget: new BulletWidget() }), node.from, node.to);
          } else {
            b.mark(bulletDim, node.from, node.to);
          }
          return;
        }
        if (name === 'TaskMarker') {
          if (!lineActive(node.from)) {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            const statePos = node.from + 1; // the state char inside "[ ]"
            b.replace(
              Decoration.replace({ widget: new CheckboxWidget(checked, statePos) }),
              node.from,
              node.to
            );
          }
          return;
        }

        // --- Code blocks ---------------------------------------------------
        // A block indented four spaces (CodeBlock) is code just as a fenced one is.
        if (name === 'FencedCode' || name === 'CodeBlock') {
          for (let n = doc.lineAt(node.from).number; n <= doc.lineAt(node.to).number; n++) {
            b.line(codeLine, doc.line(n).from);
          }
          return;
        }
        if (name === 'CodeMark') {
          // Off the caret's line, inline code backticks are hidden with their
          // InlineCode node above; on it they stay dimmed as before.
          const inInlineCode = node.node.parent?.name === 'InlineCode';
          if (!inInlineCode || lineActive(node.from)) b.mark(fenceMark, node.from, node.to);
          return;
        }

        // --- Horizontal rule ---------------------------------------------
        if (name === 'HorizontalRule') {
          if (!lineActive(node.from)) {
            b.replace(Decoration.replace({ widget: new HrWidget() }), node.from, node.to);
          }
          return;
        }
      },
    });
  }

  return {
    decorations: Decoration.set(b.all, true),
    atomicRanges: RangeSet.of(b.atomic, true),
  };
}

/** Hide a marker on inactive lines; dim it (keep visible) on active lines. */
function hideOrDim(b: DecoBuilder, from: number, to: number, active: boolean): void {
  if (active) b.mark(dimMark, from, to);
  else b.replace(hide, from, to);
}

/** Whether a Link node's text between `[` and `]` is empty, as in `[](url)`. */
function linkTextIsEmpty(link: SyntaxNode): boolean {
  const marks = link.getChildren('LinkMark');
  return marks.length >= 2 && marks[0].to === marks[1].from;
}

// ---- Reference links ------------------------------------------------------

/** Block nodes that can hold a link reference definition. */
const DEFINITION_CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

/** The address, and any title, that a `[label]: destination "title"` line names. */
interface Definition {
  src: string;
  title?: string;
}

const definitionCache = new WeakMap<Tree, Map<string, Definition>>();

/** CommonMark label matching: case-insensitive, inner whitespace collapsed. */
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The destination and title a `[label]: destination "title"` node names. */
function definitionTarget(ref: SyntaxNode, state: EditorState): Definition {
  const doc = state.doc;
  const urlNode = ref.getChild('URL');
  let src = urlNode ? doc.sliceString(urlNode.from, urlNode.to).trim() : '';
  if (src.length >= 2 && src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1);
  const titleNode = ref.getChild('LinkTitle');
  const raw = titleNode ? doc.sliceString(titleNode.from, titleNode.to).trim() : '';
  // A title is written in quotes or parentheses; the delimiters are syntax.
  const title = raw.length >= 2 && /^["'(]/.test(raw) ? raw.slice(1, -1) : undefined;
  return { src, title };
}

/**
 * Every `[label]: destination "title"` definition in the document, keyed by
 * normalized label. Footnote labels (`[^1]`) are left out: GFM footnotes are
 * not links, and Sheaf shows them as written.
 */
function referenceDefinitions(state: EditorState): Map<string, Definition> {
  const tree = syntaxTree(state);
  const cached = definitionCache.get(tree);
  if (cached) return cached;
  const labels = new Map<string, Definition>();
  tree.iterate({
    enter: (node) => {
      if (node.name === 'LinkReference') {
        const label = node.node.getChild('LinkLabel');
        if (label && label.to - label.from > 2) {
          const text = normalizeLabel(state.doc.sliceString(label.from + 1, label.to - 1));
          // The first definition of a label is the one that counts.
          if (text && !text.startsWith('^') && !labels.has(text)) {
            labels.set(text, definitionTarget(node.node, state));
          }
        }
        return false;
      }
      // Definitions are blocks; never descend into paragraphs, code or tables.
      return DEFINITION_CONTAINERS.has(node.name);
    },
  });
  definitionCache.set(tree, labels);
  return labels;
}

/**
 * Whether a parser `Link` node is a link. An inline link `[text](url)` always
 * is. A full `[text][label]`, collapsed `[text][]` or shortcut `[text]`
 * reference is a link only when a definition for its label exists; otherwise
 * CommonMark renders the brackets as plain text.
 */
function isRealLink(link: SyntaxNode, state: EditorState, definitions: ReadonlyMap<string, Definition>): boolean {
  const doc = state.doc;
  const marks = link.getChildren('LinkMark');
  if (marks.some((m) => doc.sliceString(m.from, m.to) === '(')) return true;
  const open = marks[0];
  const close = marks.find((m) => doc.sliceString(m.from, m.to) === ']');
  if (!open || !close) return false;
  const labelNode = link.getChild('LinkLabel');
  const label =
    labelNode && labelNode.to - labelNode.from > 2
      ? doc.sliceString(labelNode.from + 1, labelNode.to - 1)
      : doc.sliceString(open.to, close.from);
  const key = normalizeLabel(label);
  return key !== '' && definitions.has(key);
}

/**
 * The image a reference-style `![alt][label]`, `![alt][]` or `![alt]` stands
 * for, looked up among the document's definitions. Null when nothing defines
 * the label, which is where CommonMark renders the brackets as plain text.
 */
function referenceImageProps(
  image: SyntaxNode,
  state: EditorState,
  definitions: ReadonlyMap<string, Definition>
): { src: string; alt: string; title?: string } | null {
  const doc = state.doc;
  const marks = image.getChildren('LinkMark');
  const open = marks[0];
  const close = marks.find((m) => doc.sliceString(m.from, m.to) === ']');
  if (!open || !close || close.from < open.to) return null;
  const alt = doc.sliceString(open.to, close.from);
  const labelNode = image.getChild('LinkLabel');
  // A full reference names its label; a collapsed or shortcut one uses its text.
  const label =
    labelNode && labelNode.to - labelNode.from > 2
      ? doc.sliceString(labelNode.from + 1, labelNode.to - 1)
      : alt;
  const found = definitions.get(normalizeLabel(label));
  if (!found || !found.src) return null;
  return { src: found.src, alt, title: found.title };
}

// ---- Multi-line HTML images -----------------------------------------------
//
// A centred logo or a captioned figure is usually written over several lines:
//
//   <p align="center">
//     <img src="logo.png" width="400">
//   </p>
//
// which is how most READMEs centre an image. The ViewPlugin above cannot draw
// it, because a plugin's replace decorations may not cross a line break. Block
// decorations may, and CodeMirror only accepts those from a StateField, so the
// multi-line form gets its own field and draws the same widget as the
// single-line form.

/** Block replace decorations for HTML image markup that spans several lines. */
function buildHtmlImageDecorations(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  const active = activeLineSet(state);

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'HTMLBlock') return;
      const raw = doc.sliceString(node.from, node.to);
      if (!/<img\b/i.test(raw)) return;
      const mm = matchHtmlImage(raw);
      if (!mm) return;

      const from = node.from + mm.start;
      const to = node.from + mm.end;
      const first = doc.lineAt(from);
      const last = doc.lineAt(to);
      // Single-line markup belongs to the ViewPlugin, which keeps it inline.
      if (first.number === last.number) return;
      // A block decoration replaces whole lines, so markup sharing a line with
      // other text stays as source rather than swallowing that text.
      if (from !== first.from || to !== last.to) return;
      for (let n = first.number; n <= last.number; n++) {
        if (active.has(n)) return;
      }

      const widget = imageWidgetFor(mm.props);
      if (widget) decos.push(Decoration.replace({ widget, block: true }).range(from, to));
    },
  });

  return Decoration.set(decos, true);
}

interface HtmlImageDecorations {
  configVersion: number;
  decorations: DecorationSet;
}

const htmlImageField = StateField.define<HtmlImageDecorations>({
  create: (state) => ({ configVersion, decorations: buildHtmlImageDecorations(state) }),
  update(value, tr) {
    // A long document is parsed in stages, so a block further down can enter
    // the syntax tree in a transaction that changes nothing else.
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setReveal)) ||
      value.configVersion !== configVersion ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return { configVersion, decorations: buildHtmlImageDecorations(tr.state) };
    }
    return { configVersion: value.configVersion, decorations: value.decorations.map(tr.changes) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    // Cursor motion glides over a rendered figure as one unit, as it does over
    // every other image widget.
    EditorView.atomicRanges.of((view) => view.state.field(f).decorations),
  ],
});

// ---- Plugin ---------------------------------------------------------------

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomicRanges: DecorationSet;
    configVersion = configVersion;
    constructor(view: EditorView) {
      const built = buildDecorations(view);
      this.decorations = built.decorations;
      this.atomicRanges = built.atomicRanges;
    }
    update(update: ViewUpdate): void {
      const revealChanged =
        update.startState.field(revealField, false) !== update.state.field(revealField, false);
      // A background parse that finishes later can reveal a reference
      // definition, which turns brackets elsewhere into links.
      const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
      const configChanged = this.configVersion !== configVersion;
      if (update.docChanged || update.selectionSet || update.viewportChanged || revealChanged || treeChanged || configChanged) {
        this.configVersion = configVersion;
        const built = buildDecorations(update.view);
        this.decorations = built.decorations;
        this.atomicRanges = built.atomicRanges;
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // Let arrow keys / backspace glide over hidden markers and widgets as one
    // unit — but only over replaced ranges, never over styled (mark) spans.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomicRanges ?? Decoration.none),
  }
);

/**
 * Live preview: inline decorations from the view plugin, plus the block
 * decorations that draw HTML image markup spanning several lines.
 */
export const livePreview: Extension = [livePreviewPlugin, htmlImageField];
