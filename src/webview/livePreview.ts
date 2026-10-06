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
 * covers it (Edit Markdown, and find uncovering a match), when whole-document
 * source mode is on, and, where the opt-in `revealSyntaxOnLine` is on, when a
 * selection touches it. Tables decide separately and by the caret rather than
 * the selection, in tables.ts.
 *
 * What is revealed, and which lines follow from it, is `revealState.ts`. This file reads that and
 * draws; it holds none of it. Six modules used to import this one for those two predicates, and
 * downloaded 16 KB of the decorations below and the image widget behind them to get at them.
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
import { EditorState, Extension, Range, RangeSet, StateField, Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { SyntaxNode, Tree } from '@lezer/common';
import { alertLabel, alertLine, alertMarkerAt } from './alerts';
import { emojiFor, emojiLoaded, emojiReady, loadEmoji, requestEmoji } from './emoji';
import { editableProps, matchHtmlImage } from './imageMarkup';
import { imageSelection, imageWidgetFor } from './images';
import { inlineHtmlPairAt } from './inlineHtml';
import { BlockRange, blockRangeAt } from './blockModel';
import {
  blockMath,
  blockMathError,
  blockMathRanges,
  inlineMath,
  inlineMathError,
  loadMaths,
  mathError,
  mathsLoaded,
  mathsReady,
  requestMaths,
} from './maths';
import { MermaidRange, mermaidDiagram, mermaidThemeChanged, mermaidThemeWatch, openingFenceLang } from './mermaid';
import { ONLY_MARKERS_BEFORE } from './fenceLines';
import { footnoteClicks, footnoteDefDecoration, footnoteDefLine, footnoteIndex, footnoteKey, footnoteRefDecoration } from './footnotes';
import { activeLines, revealConfigVersion, revealField, setReveal, sourceModeOn } from './revealState';

// ---- Widgets --------------------------------------------------------------

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    // Boxed, so the words after it start at the same stop as every other list item's. The
    // box supplies the gap after the marker, so the bullet no longer carries a space of its
    // own: it wrote `"• "` and the source space after the `-` was drawn as well, which put
    // two spaces on every bullet line.
    span.className = 'tok-bullet tok-marker-box';
    /*
     * Hidden from assistive technology, because the glyph is decoration: it stands for a `-`
     * in the file and says nothing the words do not. Without this a reader is offered
     * `•dash item` as one unbroken run, since the marker takes its space with it now and
     * nothing separates the two. Same treatment as the decorative icons in `alerts.ts`,
     * `blockHandle.ts` and `comments.ts`.
     *
     * Only the bullet. The other two markers in a box must not carry this:
     *
     * - An ordered item's number is content rather than decoration. Sheaf exposes no list
     *   semantics at all, so the digits are the only thing that carries the ordinal, and
     *   hiding them would read `seven` where the line says `1. seven`.
     * - A task item's box holds a real `<input type="checkbox">`. `aria-hidden` on an ancestor
     *   takes the whole subtree out of the accessibility tree, focusable content included, so
     *   putting it there would remove the checkbox itself rather than a glyph.
     *
     * Which is why this is an attribute on one widget and not a rule on `.tok-marker-box`.
     */
    span.setAttribute('aria-hidden', 'true');
    span.textContent = '•';
    return span;
  }
}

/**
 * An ordered item's number as the finished document has it, which is not always the file's digits.
 *
 * CommonMark numbers a list from its *first* item's own number and counts from there, ignoring what
 * the later markers say. So `1.` three times is a list of 1, 2, 3, and that is what GitHub, pandoc
 * and every other reader shows. It is also the most common way people hand-write a list, which is
 * what makes the difference matter: a document typed that way read `1. 1. 1.` here and `1. 2. 3.`
 * everywhere it was published, and the editor was the only place it looked wrong.
 *
 * The file is untouched. This is a view-only decoration over the marker, the same mechanism that
 * draws a bullet for `-`, so the digits on disk stay exactly as they were typed.
 */
class OrderedWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: OrderedWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    // The same box as the bullet and the checkbox, so `9.` and `10.` end on the same period and
    // leave their words on one stop.
    span.className = 'tok-bullet tok-marker-box';
    // Not `aria-hidden`, unlike the bullet. Sheaf exposes no list semantics, so these digits are
    // the only thing carrying the ordinal, and hiding them would read `seven` for `1. seven`.
    span.textContent = this.label;
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
    // In the same box as a bullet or a number, so a task item's words start where every
    // other list item's do. Drawn bare, the checkbox was a third marker width and put task
    // text 26px right of everything around it.
    const outer = document.createElement('span');
    outer.className = 'tok-marker-box';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'md-task';
    box.checked = this.checked;
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const from = this.pos;
      view.dispatch({ changes: { from, to: from + 1, insert: this.checked ? ' ' : 'x' } });
    });
    outer.appendChild(box);
    return outer;
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

/**
 * The character a `:shortcode:` draws as.
 *
 * Its own class rather than `EntityWidget`'s so that a drawn shortcode can be
 * told apart from the same character written literally, by a theme that wants to
 * and by the checks that do, and so two widgets carrying the same character for
 * different reasons never compare equal. The character needs no styling of its
 * own, so the stylesheet says nothing about `tok-emoji`.
 */
class EmojiWidget extends WidgetType {
  constructor(readonly char: string) {
    super();
  }
  eq(other: EmojiWidget): boolean {
    return other.char === this.char;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'tok-emoji';
    span.textContent = this.char;
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

/*
 * A fenced block's language used to be drawn as a chip in place of its opening
 * fence, floated to the right of the panel. It is gone, and what replaced it is
 * nothing: an opening fence is hidden exactly as an unlabelled one always was.
 *
 * Removing it was the whole of the fix for a different complaint, that a code
 * block's own options sat at its top right where every other block's sit in the
 * left margin. The chip was not merely beside them: `blockHandle.ts` takes the
 * handle's position from the first position in the block, which is inside the
 * fence line, and a floated chip put that coordinate at the right-hand end. So
 * the `+`, the grip and the label were one fault with one cause, and an
 * unlabelled fence already demonstrated the fix, its handle sitting at -53px
 * with every other block's while a labelled one sat at 611px.
 *
 * What it costs is real and was weighed: a reader can no longer see at a glance
 * what a block's code is. The language is still in the file, and Edit Markdown
 * on the block shows the fence and its word, which is also how it is changed.
 */

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
  ignoreEvent(): boolean {
    // The press is the editor's: blocks.ts turns a click on a rule into the rule
    // selected as a block. Ignored here, the press went to the browser, which put a
    // caret of its own in front of the hidden dashes without the editor's selection
    // moving at all, so Edit Markdown opened whatever block the caret had been in
    // before, and the next letter typed turned the rule into text.
    return false;
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
/**
 * A marker drawn as itself on the caret's line, in the box its hidden form occupies.
 *
 * The box is the reason an item does not move when the caret lands on it: it gives the drawn
 * marker the same advance as the widget it replaces, so the words stay on their stop instead
 * of following the width of whatever the file happens to say.
 */
const dimMarkBox = Decoration.mark({ class: 'tok-mark tok-marker-box' });
/**
 * An ordered list's number, kept as the document's own text and boxed like the bullet
 * widget, so that the digits cannot move the words after them. Drawn bare, `1.` and `2.`
 * are 2.4px apart and `1.` and `10.` 9.5px apart, because digits have different advance
 * widths in a proportional font, so every item in a long numbered list started at a
 * slightly different place.
 */
const orderedMark = Decoration.mark({ class: 'tok-bullet tok-marker-box' });

/**
 * The end of a marker, including the single space that belongs to it.
 *
 * Every marker in Markdown is followed by a space that is part of the syntax rather than
 * part of the sentence, and the parser's node covers only the marker character. Hiding the
 * node alone therefore leaves that space on the screen: a bullet line drew `•  words`
 * with two spaces, and a nested quote left one per level.
 */
function markerEnd(doc: Text, to: number): number {
  return doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
}

/**
 * What an ordered item's marker should read, counted the way a Markdown reader counts it.
 *
 * From the list's first marker, plus the item's place in it. Returns null when the shape is not the
 * one this is about — a mark outside an `OrderedList`, or a first marker that is not a number — so
 * the caller falls back to drawing the file's own characters rather than inventing a number.
 *
 * The delimiter stays the file's own, `.` or `)`, which this feature requires and which a browser's
 * `<ol>` does not do: it draws `1.` for a list written `1)`, as GitHub and pandoc also do. So the
 * render path and the editor differ on six items in the corpus, deliberately, and that is a separate
 * question from this one rather than something to settle in passing.
 *
 * The delimiter is taken from the first item, not each item's. A list written `1.` then `2)` is one
 * list with one delimiter to every reader, and reading it per item would draw a punctuation change
 * the finished document does not have.
 */
function orderedLabel(doc: Text, mark: SyntaxNode): string | null {
  const item = mark.parent;
  const list = item?.parent;
  if (!item || item.name !== 'ListItem' || !list || list.name !== 'OrderedList') return null;
  let first: SyntaxNode | null = list.firstChild;
  while (first && first.name !== 'ListItem') first = first.nextSibling;
  const firstMark = first?.firstChild;
  if (!first || !firstMark || firstMark.name !== 'ListMark') return null;
  const m = /^(\d+)([.)])$/.exec(doc.sliceString(firstMark.from, firstMark.to).trim());
  if (!m) return null;
  let n = Number(m[1]);
  // Compared by position rather than by identity: a cursor hands back a fresh object each time, so
  // `c !== item` is true even of the item itself and the count would run to the end of the list.
  for (let c: SyntaxNode | null = first; c && c.from !== item.from; c = c.nextSibling) {
    if (c.name === 'ListItem') n++;
  }
  return `${n}${m[2]}`;
}
const fenceMark = Decoration.mark({ class: 'tok-code-fence' });
const hide = Decoration.replace({});

const inlineHtmlMarks = new Map<string, Decoration>();

/**
 * The mark for the content of an inline HTML formatting pair. An abbreviation's
 * title becomes the span's own title, so hovering it shows what it stands for,
 * as a browser shows it for `<abbr>`.
 */
function inlineHtmlMark(cls: string, title: string | undefined): Decoration {
  if (title) return Decoration.mark({ class: cls, attributes: { title: decodeEntity(title) } });
  let deco = inlineHtmlMarks.get(cls);
  if (!deco) {
    deco = Decoration.mark({ class: cls });
    inlineHtmlMarks.set(cls, deco);
  }
  return deco;
}

const headingLine = (level: number) => Decoration.line({ class: `tok-heading tok-h${level}` });
const codeLine = Decoration.line({ class: 'tok-code-block' });
/** The opening and closing fence lines, drawn as the block's own top and bottom edge. */
const codeFenceLine = Decoration.line({ class: 'tok-code-block sheaf-code-fence-line' });
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

// ---- Builder --------------------------------------------------------------

/**
 * Collects two range sets in one pass: every decoration (for rendering), and
 * only the replace/widget ranges (for atomic cursor motion).
 */
// ---- Rhythm: how far in each line sits -------------------------------------

/**
 * One line's position, in levels rather than in pixels.
 *
 * `hang` marks the line a list item starts on, which is the only line that has a marker to
 * hang in the indent. A wrapped row of that same line, and a line further down the same
 * item, come back to the content edge instead.
 *
 * `gap` is the one vertical thing here, and it rides on the same pass because it is the same
 * question asked downward: does this line open a list item that needs separating from the item
 * above it. A tight list has no blank lines in its source by definition, so nothing else can
 * give it any air, and six task items read as a solid block of text with boxes in it.
 *
 * It is set on the line an item opens on and nowhere else, which is what makes the gap land
 * once per item rather than once per drawn row. A wrapped item is one `.cm-line` however many
 * rows it takes, so a three-line item takes one gap at its top and nothing inside it.
 *
 * False on the first item of an outermost list, because the blank line above the list already
 * separates it from the block before. True on the first item of a *nested* list, which has no
 * blank line above it and would otherwise sit tighter against its parent than its own siblings
 * sit against each other.
 */
interface LineRhythm {
  list: number;
  quote: number;
  hang: boolean;
  gap: boolean;
}

/** The step lengths live in the stylesheet; nothing here knows a pixel. */
const rhythmLines = new Map<string, Decoration>();

/**
 * The line decoration for one measured rhythm, cached so that scrolling a long document
 * does not build a new decoration per line per frame.
 *
 * Both depths ride on one decoration and one class, and that is deliberate. Two rules each
 * setting `padding-left`, one for lists and one for quotes, cannot add up: the second wins
 * outright, so a list inside a quote would take one indent and lose the other. One property
 * per axis and a single `calc` that reads both keeps them additive.
 */
function rhythmLine(r: LineRhythm): Decoration {
  const key = `${r.list}:${r.quote}:${r.hang ? 'h' : ''}${r.gap ? 'g' : ''}`;
  let deco = rhythmLines.get(key);
  if (!deco) {
    const cls = ['tok-rhythm'];
    if (r.quote) cls.push('tok-quote');
    if (r.hang) cls.push('tok-hang');
    if (r.gap) cls.push('tok-item-gap');
    const style = [`--md-list-depth:${r.list}`, `--md-quote-depth:${r.quote}`].join(';');
    deco = Decoration.line({ class: cls.join(' '), attributes: { style } });
    rhythmLines.set(key, deco);
  }
  return deco;
}

/**
 * Whether a list item takes the gap that separates it from the item above it.
 *
 * Every item does except the one that opens an outermost list, and both halves of that are
 * about what is already above the item.
 *
 * The first item of a top-level list has a blank line above it, or the top of the document, or
 * a heading with its own space: something separates the list from what precedes it, and a gap
 * on top of that would make the list stand off from the prose by more than its own items stand
 * apart from each other.
 *
 * The first item of a *nested* list has none of that. It sits directly under the text of its
 * parent item, with no blank line anywhere, so without a gap it reads tighter against its
 * parent than its own siblings read against it, which is the thing this is for at one level up.
 *
 * `parent.from === node.from` is what identifies a first item: a list and its first item begin
 * at the same character, since the list is nothing but its items.
 */
function takesItemGap(node: SyntaxNode): boolean {
  const list = node.parent;
  if (!list || list.from !== node.from) return true;
  // Nested if any ListItem is above this list in the tree. A quote in between does not make
  // the list top-level again: `> - a` is still a list opening a quoted block.
  for (let up = list.parent; up; up = up.parent) {
    if (up.name === 'ListItem') return true;
  }
  return false;
}

/**
 * How deep in lists and quotes every line of `ranges` sits.
 *
 * One pass for both axes, and one decoration per line emitted after it, because the
 * obvious alternative does not work. The tree walk meets an outer `Blockquote` before the
 * nested one inside it, so applying a class as each is met puts the same class on the same
 * line twice, and the same class twice is no class at all. That is why `> > >` has been
 * drawn exactly like `>`.
 *
 * Depth comes from the tree and never from the leading whitespace in the file. Two spaces,
 * four spaces and a tab are three different widths in a proportional font and none of them
 * is a designed step; and an ordered item's content starts three columns in rather than
 * two, so counting spaces puts a numbered level three at depth four.
 *
 * The deepest container covering a line wins, which falls out of taking the maximum: an
 * outer block records its own depth across all of its lines and an inner one raises the
 * lines it covers.
 */
function lineRhythms(state: EditorState, ranges: readonly { from: number; to: number }[]): Map<number, LineRhythm> {
  const doc = state.doc;
  const out = new Map<number, LineRhythm>();
  const at = (n: number): LineRhythm => {
    let r = out.get(n);
    if (!r) {
      r = { list: 0, quote: 0, hang: false, gap: false };
      out.set(n, r);
    }
    return r;
  };

  for (const { from, to } of ranges) {
    let list = 0;
    let quote = 0;
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const quoted = node.name === 'Blockquote';
        const item = node.name === 'ListItem';
        if (!quoted && !item) return;
        if (quoted) quote++;
        else list++;
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(Math.min(node.to, doc.length)).number;
        for (let n = first; n <= last; n++) {
          const r = at(n);
          if (quoted) r.quote = Math.max(r.quote, quote);
          else r.list = Math.max(r.list, list);
        }
        // Only the line the item opens on carries a marker to hang.
        if (item) {
          at(first).hang = true;
          at(first).gap = takesItemGap(node.node);
        }
      },
      leave: (node) => {
        if (node.name === 'Blockquote') quote--;
        else if (node.name === 'ListItem') list--;
      },
    });
  }
  return out;
}

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
  /**
   * A replacement the caret may sit inside, for a line whose whole content is
   * hidden. An atomic one would be stepped over, and a line that cannot be
   * reached is a line that can never be shown again to edit.
   */
  softReplace(deco: Decoration, from: number, to: number): void {
    if (from < to) this.all.push(deco.range(from, to));
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

/** A fence line of a fenced block: which line it is, where its backticks start, and the info string after them. */
interface FenceLine {
  number: number;
  at: number;
  lang: string;
}

// `ONLY_MARKERS_BEFORE` and `isFenceLine` are in `./fenceLines`, imported above. They moved because
// `shortcuts.ts` needs the second one, and that single import put this whole file into everything
// that reads the shortcut registry — the toolbar and the grid among them. See that file for the
// measurement.

/**
 * The opening and closing fence lines of a fenced block.
 *
 * Only the backtick run that opens its line counts: inside the code, a run of
 * backticks is part of the example, and the parser hands those back as the same
 * kind of node. A block whose fence is never closed has one line here, not two.
 */
function fenceLinesOf(doc: Text, node: SyntaxNode, first: number, last: number): FenceLine[] {
  const out: FenceLine[] = [];
  for (const mark of node.getChildren('CodeMark')) {
    const line = doc.lineAt(mark.from);
    if (line.number !== first && line.number !== last) continue;
    if (out.some((f) => f.number === line.number)) continue;
    if (!ONLY_MARKERS_BEFORE.test(line.text.slice(0, mark.from - line.from))) continue;
    out.push({
      number: line.number,
      at: mark.from,
      // The whole info string, so a `js title="x"` says all of what it says.
      lang: line.number === first ? doc.sliceString(mark.to, line.to).trim() : '',
    });
  }
  return out;
}

function buildDecorations(view: EditorView): BuiltDecorations {
  const b = new DecoBuilder();
  const { state } = view;
  const allActive = sourceModeOn(state);
  const active = activeLines(state);
  const doc = state.doc;
  const lineActive = (pos: number): boolean => allActive || active.has(doc.lineAt(pos).number);
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

  /*
   * How far in each line sits, measured once and emitted once, before anything inside the
   * lines is looked at.
   *
   * The same depth whether or not the caret is on the line, and that is the whole point: an
   * item must not move when you click it. An earlier version dropped the list indent on the
   * caret's line, on the reasoning that the marker and the leading whitespace are drawn as
   * themselves there and a computed indent on top of drawn whitespace counts it twice. That is
   * true and it was still wrong, because the two do not cancel: source whitespace is about
   * 4.2px a space in the body font against a 32px step, so a fourth-level item jumped 66px
   * left as the caret arrived and back as it left. Measured, not estimated.
   *
   * What makes holding the indent work is that the drawn prefix is given the same advance as
   * the hidden one instead of its own: the leading whitespace comes off the screen on every
   * line, and the revealed marker sits in a box one step wide, so the words land on the stop
   * either way. See the `ListMark` branch.
   */
  const rhythm = lineRhythms(state, view.visibleRanges);
  for (const [n, r] of rhythm) {
    const line = doc.line(n);
    if (front && line.from < front.to) continue;
    if (r.list || r.quote) b.line(rhythmLine(r), line.from);
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

        // --- Inline maths -------------------------------------------------
        if (name === 'InlineMath') {
          const source = doc.sliceString(node.from + 1, node.to - 1);
          // KaTeX arrives on demand, so until it does there is no answer about this source and
          // the raw `$…$` stays, which is what a person sees while typing one anyway. Asking
          // `mathError` here would be a contract breach rather than a question with a third
          // answer: see `mathsReady` for why that distinction keeps its cache honest.
          if (!mathsReady()) {
            requestMaths();
            return;
          }
          const failed = mathError(source, false);
          if (failed) {
            // Half-typed maths is the normal state while someone is writing it,
            // so what does not typeset keeps its source, exactly where it is,
            // with KaTeX's message on it.
            b.mark(inlineMathError(failed), node.from, node.to);
          } else if (!lineActive(node.from)) {
            b.replace(inlineMath(source), node.from, node.to);
          }
          return;
        }
        if (name === 'InlineMathMark') {
          // Off the caret's line the whole span is replaced above; on it the
          // dollars stay visible and dim, as every other marker does.
          if (lineActive(node.from)) b.mark(dimMark, node.from, node.to);
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

        // --- Emoji shortcodes ---------------------------------------------
        // `:warning:` draws as its character off the caret's line, the way
        // github.com renders it. A name the table does not hold stays as typed,
        // which is what github.com does with it too, so `10:30:45` and a word
        // between colons that is nobody's shortcode are left alone.
        if (name === 'Emoji') {
          if (!lineActive(node.from)) {
            // The table is fetched on first sight of a shortcode, so say the document holds one and
            // leave this span as typed until it lands. `emojiFor` would throw here, and must: its
            // `undefined` means "github.com does not draw that name either", which is permanent.
            if (!emojiReady()) {
              requestEmoji();
              return;
            }
            const char = emojiFor(doc.sliceString(node.from + 1, node.to - 1));
            if (char) b.replace(Decoration.replace({ widget: new EmojiWidget(char) }), node.from, node.to);
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

        // --- Footnotes ----------------------------------------------------
        // A reference draws as its number and a definition's `[^label]:` as the
        // same number, off the lines showing their source. A reference with no
        // definition, and a definition nothing refers to, stay as written.
        if (name === 'FootnoteReference') {
          const notes = footnoteIndex(state);
          const label = node.node.getChild('FootnoteLabel');
          const key = label ? footnoteKey(doc.sliceString(label.from, label.to)) : '';
          const n = notes.numbers.get(key);
          if (n === undefined) return;
          if (lineActive(node.from)) {
            for (const mark of node.node.getChildren('FootnoteMark')) b.mark(dimMark, mark.from, mark.to);
          } else {
            b.replace(footnoteRefDecoration(n, notes.defs.get(key)!.text), node.from, node.to);
          }
          return;
        }
        if (name === 'FootnoteDefinition') {
          for (let n = doc.lineAt(node.from).number; n <= doc.lineAt(node.to).number; n++) b.line(footnoteDefLine, doc.line(n).from);
          const notes = footnoteIndex(state);
          const label = node.node.getChild('FootnoteLabel');
          const key = label ? footnoteKey(doc.sliceString(label.from, label.to)) : '';
          const def = notes.defs.get(key);
          const n = notes.numbers.get(key);
          if (label && def?.from === node.from && n !== undefined && !lineActive(node.from)) {
            b.replace(footnoteDefDecoration(n), node.from, def.markTo);
          } else {
            for (const mark of node.node.getChildren('FootnoteMark')) b.mark(dimMark, mark.from, mark.to);
          }
          // The note inside is ordinary Markdown and is drawn as such.
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
              /*
               * Nothing inside a range that has been replaced wholesale, and skipping the
               * children is how that is said. Left to descend, the `![`, the `]`, the
               * `(`, the address and the `)` each added their own hide inside the picture's
               * own range, and a nested replace whose `from` equals the outer one's sorts
               * ahead of it. CodeMirror drew the right thing from a fresh set and, on an
               * image that had just been typed, kept the empty element the inner hide made
               * while the markup was still half written: the picture never appeared, the
               * line showed nothing at all, and closing and reopening the file fixed it.
               */
              return false;
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
            return;
          }
          // A formatting pair such as `<kbd>F5</kbd>`: the content takes the
          // formatting and the tags are markers, hidden off the caret's line
          // and dim on it, as `**` and `==` are. The closing tag is found from
          // its opening one, so it needs no branch of its own.
          const pair = name === 'HTMLTag' ? inlineHtmlPairAt(node.node, doc) : null;
          if (pair) {
            b.mark(inlineHtmlMark(pair.cls, pair.title), pair.openTo, pair.closeFrom);
            const active = lineActive(pair.openFrom);
            hideOrDim(b, pair.openFrom, pair.openTo, active);
            hideOrDim(b, pair.closeFrom, pair.closeTo, active);
          }
          return;
        }
        if (name === 'Link') {
          // Brackets that are not a link (`[1]`, `[!NOTE]`, `[~]`) render as
          // written. The one exception is a quote's opening `[!NOTE]`, which
          // the Blockquote branch below draws as an alert's label instead.
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
          // A quote whose first line opens with `[!type]`, with an optional
          // fold marker and title, is an alert: it keeps the quote's rule and
          // takes the type's colour, and the whole marker line, title
          // included, is drawn as an icon and a label. The label goes on only
          // where the line is not showing its source, so the caret coming in
          // brings the line back exactly as every other marker returns.
          //
          // Only a quote at the top level. A marker inside a nested quote is
          // ordinary text on GitHub, and drawing it as a callout here would put
          // two types on the same lines, leaving the rule's colour to whichever
          // the stylesheet happens to declare last.
          let quoted = node.node.parent;
          while (quoted && quoted.name !== 'Blockquote') quoted = quoted.parent;
          const alert = quoted ? null : alertMarkerAt(doc, node.from);
          // The quote's own line class and its depth come from the rhythm pass above, which
          // is the only place that can count the depth: this branch is entered once per
          // nesting level and would apply the same class to the same line each time.
          for (let n = doc.lineAt(node.from).number; n <= doc.lineAt(node.to).number; n++) {
            if (alert) b.line(alertLine(alert.kind), doc.line(n).from);
          }
          if (alert && !lineActive(alert.from)) b.replace(alertLabel(alert), alert.from, alert.to);
          return;
        }
        if (name === 'QuoteMark') {
          /*
           * Hidden on every line, the caret's included, and that last part is the one exception
           * to how every other marker in Sheaf behaves.
           *
           * It used to stay visible-but-dim on the caret's line, and the comment here said it
           * was "so the quote rule persists", which was true when the rule was a `border-left`
           * drawn on a line that had a `>` on it. The rule is a repeating gradient on the line
           * itself now, one band per level, so it survives whether the marker is drawn or not:
           * the reason for the exception expired and the exception outlived it.
           *
           * What it cost was a quote's words moving 14px right as the caret arrived and back as
           * it left, because the drawn `> ` sat in front of words that already had the computed
           * indent. A list item does not move when the caret lands on it, which was settled for
           * the same reason, and this is that question with a smaller number.
           *
           * The line still reveals its other syntax. `**bold**` in a quote shows its asterisks
           * on the caret's line exactly as it does anywhere else; it is only the `>` that stays
           * away, because it is the only marker whose width the indent has already accounted for.
           *
           * The space after the marker goes with it. Hidden alone, the `>` left its space on the
           * screen, one per level, so a three-level quote carried three stray spaces and each
           * level landed about 4px off its stop instead of on it.
           *
           * The marker is hidden atomically and the space is not, which is a distinction that
           * matters and cost a leak to find. `atomicRanges` is what the caret and a group delete
           * step over, so widening the atomic range widens what `Alt-Backspace` takes: with the
           * space inside it, deleting a word at the start of a quoted line removed the whole `> `
           * and joined the line to the one above, which turned `> [!NOTE]` into an ordinary line
           * and put `[!NOTE]` and a stray `>` on the screen. Hiding the space softly draws the
           * same thing and leaves deletion where it was. `no-leak/alert/DeleteWordBackAlt` is the
           * class that says so, and it is at zero.
           */
          /*
           * One exception to the exception: an alert's own marker line.
           *
           * There the whole line is syntax. `> [!question]- Why this way?` has no prose on it
           * whose position could shift, and it is the line a person edits to change a callout's
           * type or its fold marker, so it shows byte for byte including the `>`. Hiding the
           * marker there would leave somebody retyping a callout unable to see part of what they
           * were retyping.
           *
           * Only the marker that opens the line, so a nested quote holding something that looks
           * like a marker is not treated as one: an alert is top-level only, and `alertMarkerAt`
           * reads from whatever position it is given.
           */
          const line = doc.lineAt(node.from);
          if (lineActive(node.from) && node.from === line.from && alertMarkerAt(doc, node.from)) {
            b.mark(dimMark, node.from, node.to);
            return;
          }
          b.replace(hide, node.from, node.to);
          b.softReplace(hide, node.to, markerEnd(doc, node.to));
          return;
        }

        // --- Lists & tasks ------------------------------------------------
        if (name === 'ListMark') {
          const bulletChar = doc.sliceString(node.from, node.to).trim();
          const ordered = /\d/.test(bulletChar);
          /*
           * The whitespace this item is indented by, taken off the screen on every line,
           * whether or not the caret is on it.
           *
           * The indent is a computed padding now, so drawn spaces would add their own width on
           * top of it. Hiding them only when the line is rendered is what made an item jump as
           * the caret arrived: the computed step is 32px and four drawn spaces are about 17px,
           * so the two never cancelled and a fourth-level item moved 66px. Hidden on both, the
           * line holds still, and the indent a reader sees is the designed one either way.
           */
          const line = doc.lineAt(node.from);
          if (node.from > line.from) b.replace(hide, line.from, node.from);
          /*
           * On the caret's line the marker is drawn as itself, as every marker in Sheaf is, but
           * in the same box the hidden form occupies. The box is what holds the words still:
           * one step of advance whatever is in it, so `- `, `10. ` and `[x] ` all leave the
           * text on the stop. Content wider than the box spills into the indent rather than
           * pushing the words along, which is what `overflow: visible` on it is for.
           */
          if (lineActive(node.from)) {
            b.mark(dimMarkBox, node.from, markerEnd(doc, node.to));
            return;
          }
          // A task item's marker is its checkbox. The bullet was drawn as well, so the line
          // carried two markers and its words started one marker box further in than every
          // other item's.
          //
          // Read from the text rather than from the tree. `TaskMarker` is not this node's
          // sibling: the task extension wraps the item's content in a node of its own and the
          // marker sits inside that, so a sibling test finds nothing and quietly draws both
          // markers. The text is the same question asked where the answer does not depend on
          // which shape the parser chose.
          const after = markerEnd(doc, node.to);
          if (/^\[[ xX]\]/.test(doc.sliceString(after, after + 3))) {
            b.replace(hide, node.from, after);
          } else if (!ordered) {
            b.replace(Decoration.replace({ widget: new BulletWidget() }), node.from, markerEnd(doc, node.to));
          } else {
            /*
             * The number a reader of the finished document sees, boxed so that `9.` and `10.` end
             * on the same period and start their words at the same place.
             *
             * It used to be the document's own text, marked rather than replaced. That drew `1.`
             * three times for the list everybody writes as `1. 1. 1.`, where every Markdown reader
             * counts 1, 2, 3 — so the one place the document looked wrong was the editor it was
             * written in. `orderedLabel` returns null for any shape this is not about, and then the
             * file's characters are drawn as before.
             */
            const label = orderedLabel(doc, node.node);
            if (label === null) b.mark(orderedMark, node.from, node.to);
            else b.replace(Decoration.replace({ widget: new OrderedWidget(label) }), node.from, node.to);
            b.replace(hide, node.to, markerEnd(doc, node.to));
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
              // With the space after it, as every other marker now takes its own.
              markerEnd(doc, node.to)
            );
          }
          return;
        }

        // --- Code blocks ---------------------------------------------------
        // A block indented four spaces (CodeBlock) is code just as a fenced one is.
        if (name === 'FencedCode' || name === 'CodeBlock') {
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          // The fence lines, when this is a fenced block and the caret is elsewhere:
          // the backticks and the language word come off the line, which draws as the
          // block's top or bottom edge instead. The language goes back as a chip, so
          // nothing the document said is lost. A block with no closing fence has only
          // the one to hide, and an indented block has neither.
          const fences = name === 'FencedCode' ? fenceLinesOf(doc, node.node, first, last) : [];
          for (let n = first; n <= last; n++) {
            const line = doc.line(n);
            const fence = fences.find((f) => f.number === n);
            if (fence && !lineActive(line.from)) {
              b.line(codeFenceLine, line.from);
              // From the backticks, not from the start of the line: a fence inside a
              // quote or a list item sits behind that block's own marker, and hiding
              // the marker with it would take the line out of the block it is in.
              // Every fence line the same, labelled or not: see the note above CodeLangWidget's
              // removal for why the language is no longer drawn here.
              b.softReplace(hide, fence.at, line.to);
            } else {
              b.line(codeLine, line.from);
            }
          }
          return;
        }
        if (name === 'CodeMark') {
          // Off the caret's line, inline code backticks are hidden with their
          // InlineCode node above; on it they stay dimmed as before. A block fence
          // is hidden with its whole line above, so dimming it here would paint
          // under a replacement and show through where the line grows back.
          if (lineActive(node.from)) b.mark(fenceMark, node.from, node.to);
          return;
        }

        // --- Horizontal rule ---------------------------------------------
        if (name === 'HorizontalRule') {
          if (!lineActive(node.from)) {
            b.replace(Decoration.replace({ widget: new HrWidget() }), node.from, node.to);
          }
          return;
        }
        // Anything else is walked into, which is what `undefined` says here. Only the
        // image branch returns false, because it has replaced a whole range and nothing
        // inside it may add a decoration of its own.
        return undefined;
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
 * normalized label. Footnote labels (`[^1]`) are left out: a footnote is not a
 * link, and footnotes.ts reads them as their own blocks.
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
  // In source mode the markup is what the reader asked to see, so no figure is
  // drawn over it, the same as on any other line showing its Markdown.
  if (sourceModeOn(state)) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  const active = activeLines(state);

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
  create: (state) => ({ configVersion: revealConfigVersion(), decorations: buildHtmlImageDecorations(state) }),
  update(value, tr) {
    // A long document is parsed in stages, so a block further down can enter
    // the syntax tree in a transaction that changes nothing else.
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setReveal)) ||
      value.configVersion !== revealConfigVersion() ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return { configVersion: revealConfigVersion(), decorations: buildHtmlImageDecorations(tr.state) };
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

// ---- Block maths ----------------------------------------------------------
//
// `$$…$$` is written over several lines, which a ViewPlugin's replace
// decorations may not cross, so display maths gets its own field for the same
// reason the multi-line image markup above has one.

/** Block replace decorations for the document's `$$…$$` equations. */
function buildBlockMathDecorations(state: EditorState): DecorationSet {
  // In source mode the delimiters are what the reader asked to see.
  if (sourceModeOn(state)) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  const active = activeLines(state);

  for (const math of blockMathRanges(state)) {
    const first = doc.lineAt(math.from).number;
    const last = doc.lineAt(math.to).number;
    let shown = false;
    for (let n = first; n <= last; n++) if (active.has(n)) shown = true;
    if (shown) continue;
    // As inline: nothing is drawn until KaTeX is here, and the `$$` block stays as its source.
    if (!mathsReady()) {
      requestMaths();
      continue;
    }
    const failed = mathError(math.source, true);
    if (failed) {
      // As with inline maths: the source stays, with the message on it.
      for (let n = first; n <= last; n++) decos.push(blockMathError(failed).range(doc.line(n).from));
    } else {
      decos.push(blockMath(math.source).range(math.from, math.to));
    }
  }

  return Decoration.set(decos, true);
}

interface BlockMathDecorations {
  configVersion: number;
  decorations: DecorationSet;
}

const blockMathField = StateField.define<BlockMathDecorations>({
  create: (state) => ({ configVersion: revealConfigVersion(), decorations: buildBlockMathDecorations(state) }),
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setReveal) || e.is(mathsLoaded)) ||
      value.configVersion !== revealConfigVersion() ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return { configVersion: revealConfigVersion(), decorations: buildBlockMathDecorations(tr.state) };
    }
    return { configVersion: value.configVersion, decorations: value.decorations.map(tr.changes) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    // Cursor motion glides over a drawn equation as one unit. The line
    // decorations a failed equation gets are not replacements, so they are no
    // part of this and its source stays as editable as any other text.
    EditorView.atomicRanges.of((view) =>
      view.state.field(f).decorations.update({ filter: (_from, _to, deco) => deco.spec.block === true })
    ),
  ],
});

// ---- Mermaid --------------------------------------------------------------
//
// A ```mermaid fence drawn as its diagram. A fence is several lines, so like
// display maths it is a block decoration from a field. The drawing is in
// mermaid.ts; this finds the fences and decides which are showing their source.

/**
 * The document's ```mermaid fences that are closed and hold something. A fence
 * with no closer yet is someone typing one, and it stays as written rather than
 * swallowing the rest of the document into a diagram. A fence inside a quote or
 * a list stays as written too, as display maths does.
 */
export function mermaidRanges(state: EditorState): MermaidRange[] {
  const doc = state.doc;
  const found: MermaidRange[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      const open = doc.lineAt(node.from);
      if (open.from !== node.from || openingFenceLang(open.text) !== 'mermaid') return false;
      if (node.node.getChildren('CodeMark').length < 2) return false;
      const close = doc.lineAt(Math.max(node.from, node.to - 1));
      if (close.number <= open.number) return false;
      const source = close.number - open.number > 1 ? doc.sliceString(doc.line(open.number + 1).from, doc.line(close.number - 1).to) : '';
      if (source.trim() !== '') found.push({ from: open.from, to: close.to, source });
      return false;
    },
  });
  return found;
}

/** Block replace decorations for the document's ```mermaid diagrams. */
function buildMermaidDecorations(state: EditorState): DecorationSet {
  // In source mode the fences are what the reader asked to see.
  if (sourceModeOn(state)) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  const active = activeLines(state);
  for (const block of mermaidRanges(state)) {
    const first = doc.lineAt(block.from).number;
    const last = doc.lineAt(block.to).number;
    let shown = false;
    for (let n = first; n <= last; n++) if (active.has(n)) shown = true;
    if (!shown) decos.push(mermaidDiagram(block.source).range(block.from, block.to));
  }
  return Decoration.set(decos, true);
}

const mermaidField = StateField.define<BlockMathDecorations>({
  create: (state) => ({ configVersion: revealConfigVersion(), decorations: buildMermaidDecorations(state) }),
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setReveal) || e.is(mermaidThemeChanged)) ||
      value.configVersion !== revealConfigVersion() ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return { configVersion: revealConfigVersion(), decorations: buildMermaidDecorations(tr.state) };
    }
    return { configVersion: value.configVersion, decorations: value.decorations.map(tr.changes) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    // Cursor motion glides over a drawn diagram as one unit.
    EditorView.atomicRanges.of((view) => view.state.field(f).decorations),
  ],
});

// ---- Plugin ---------------------------------------------------------------

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomicRanges: DecorationSet;
    configVersion = revealConfigVersion();
    constructor(view: EditorView) {
      const built = buildDecorations(view);
      this.decorations = built.decorations;
      this.atomicRanges = built.atomicRanges;
      // Built first, so the builders have had their chance to say the document holds maths or a
      // shortcode. This is the view half of that: a `StateField` may not dispatch, and a load
      // resolving does.
      loadMaths(view);
      loadEmoji(view);
    }
    update(update: ViewUpdate): void {
      const revealChanged =
        update.startState.field(revealField, false) !== update.state.field(revealField, false);
      // KaTeX landed, so every equation now has an answer where a moment ago it had none.
      const mathsArrived = update.transactions.some((tr) => tr.effects.some((e) => e.is(mathsLoaded)));
      // And the same for the emoji table: shortcodes that drew as text now have characters.
      const emojiArrived = update.transactions.some((tr) => tr.effects.some((e) => e.is(emojiLoaded)));
      // A background parse that finishes later can reveal a reference
      // definition, which turns brackets elsewhere into links.
      const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
      const configChanged = this.configVersion !== revealConfigVersion();
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        revealChanged ||
        treeChanged ||
        configChanged ||
        mathsArrived ||
        emojiArrived
      ) {
        this.configVersion = revealConfigVersion();
        const built = buildDecorations(update.view);
        this.decorations = built.decorations;
        this.atomicRanges = built.atomicRanges;
      }
      loadMaths(update.view);
      loadEmoji(update.view);
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
 * decorations that draw HTML image markup spanning several lines, the `$$…$$`
 * equations and the ```mermaid diagrams that do the same.
 */
export const livePreview: Extension = [
  livePreviewPlugin,
  htmlImageField,
  blockMathField,
  mermaidField,
  mermaidThemeWatch,
  imageSelection,
  footnoteClicks,
];
