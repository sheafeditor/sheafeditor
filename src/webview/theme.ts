/*
 * CodeMirror 6 theme + syntax highlight style.
 *
 * The heavy visual lifting (typography, spacing, block styling) lives in
 * media/webview.css, keyed on the token classes our decoration engine emits.
 * Here we only:
 *   - make the CM6 shell transparent so the CSS surface shows through, and
 *   - provide a HighlightStyle so fenced-code (and any leftover inline tokens)
 *     pick up theme-friendly colors via Lezer highlight tags.
 */

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { Extension } from '@codemirror/state';

/*
 * Transparent, Notion-flavored CM6 shell. Layout-critical rules live HERE, not
 * in webview.css: CodeMirror injects its own baseTheme StyleModule after our
 * <link>, so equal-specificity rules there (`.cm-scroller{font-family:monospace}`,
 * `.cm-content{margin:0}`) would override the stylesheet — clobbering our font
 * and killing the centered column. Theme rules are injected after baseTheme, so
 * they win. Token/element styling (headings, inline code, …) stays in the CSS.
 */
const baseTheme = EditorView.theme({
  // Font/size/line-height read through vars so source-mode (webview.css) can
  // override them via the cascade despite this theme's higher precedence.
  '&': {
    color: 'var(--md-text)',
    backgroundColor: 'transparent',
    fontSize: 'var(--sheaf-font-size, 16px)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--sheaf-font, var(--md-font))',
    lineHeight: 'var(--sheaf-line-height, 1.5)',
    // The space above the first line, shared with webview.css, where the sticky
    // header of a table has to undo it.
    padding: 'var(--sheaf-page-top, 56px) 0 40vh',
  },
  // Notion's centered writing column: 708px text measure inside side gutters.
  '.cm-content': {
    fontFamily: 'var(--sheaf-font, var(--md-font))',
    maxWidth: 'calc(var(--md-content-width) + 2 * var(--md-gutter))',
    margin: '0 auto',
    padding: '0 var(--md-gutter)',
    caretColor: 'var(--md-text)',
    /*
     * A space at a soft wrap hangs at the end of the line it belongs to rather
     * than starting the next one. CodeMirror asks for `break-spaces`, which
     * never hangs a preserved space, so a break falling just after a hidden
     * inline marker (the closing `~~` of a strikethrough, the `_` of an italic)
     * pushed that space onto the next line and indented it by a character.
     * `pre-wrap` hangs it, and is in CodeMirror's own list of wrapping modes, so
     * line wrapping is still measured the way it expects. Checked in Chromium
     * against a document holding a ten-space run and a two-space hard break:
     * neither overflows the column.
     */
    whiteSpace: 'pre-wrap',
    // A flex item's default minimum is its widest child's min-content width, so
    // one wide thing inside the document widens the whole column past the pane
    // and the page scrolls sideways. On a phone that was a table's touch-sized
    // command bar, which then never folded, because the room it measures is the
    // column it had just widened. The column is what the pane says it is; a
    // child too wide for it scrolls inside its own frame.
    minWidth: '0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--md-text)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    {
      backgroundColor: 'var(--md-selection)',
      color: 'var(--md-selection-text)',
    },
  // drawSelection()'s own boxes run from the content's edges, out into the page
  // gutters; selectionHighlight.ts draws the selection over the text instead.
  '.cm-selectionLayer': {
    display: 'none',
  },
  // How deep that replacement sits. CodeMirror gives a below-layer its z-index
  // from the order the layers were registered in, which is no basis for another
  // rule to aim at, so it is pinned here: one step under the content, and one
  // step above the fenced-code background (z-index -2, webview.css), which is
  // what makes a selection inside a code block visible. `!important` is what
  // beats the inline style the layer writes on itself.
  '.sheaf-selectionLayer': {
    zIndex: '-1 !important',
  },
  // No tint on the line holding the caret. This can only reach the line's own
  // background, which is why a fenced code block paints its tint from a
  // pseudo-element instead. This rule is a theme rule and so stronger than the
  // stylesheet, and it used to strip the background from one line of the block.
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'transparent',
    color: 'inherit',
  },
  // Line-number gutter (toggled from the toolbar). Transparent, borderless, and
  // muted so it reads as a quiet margin rather than a code-editor rail. Lives
  // here — not webview.css — because CM's baseTheme styles .cm-gutters after the
  // stylesheet and would otherwise win.
  //
  // The gutter is given a fixed width that a matching negative margin-right
  // cancels out, so it contributes ZERO horizontal space to CodeMirror's flex
  // layout. That keeps the centered writing column in exactly the same place
  // whether numbers are on or off — the numbers overlay the existing left page
  // margin instead of pushing the text over. (Both lengths are `em` on this same
  // element, so they always resolve to the identical pixel width.) The width
  // holds a four-digit number, right-aligned, with a few pixels to spare on its
  // left, so no number touches the edge of the pane.
  '.cm-gutters': {
    width: '3.5em',
    marginRight: '-3.5em',
    // The column of numbers is only as wide as its widest number; pushed to the right
    // end, the room left over sits between the numbers and the pane's edge.
    justifyContent: 'flex-end',
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--md-faint)',
    fontFamily: 'var(--md-mono)',
    fontSize: '0.75em',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 0',
    minWidth: '0',
    // Flex-center the number vertically within the (often tall) line box and
    // right-align it against the text, rather than CM's default top-left.
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--md-muted)',
  },
  /*
   * The space above a heading, which is what separates one section from the next.
   *
   * Here rather than in the stylesheet, and this is the whole reason: the rules
   * there aimed at `.tok-h1` and lost to CodeMirror's own `.ͼ1 .cm-line`, which
   * carries two classes to their one, so every heading in every document has
   * been drawn with no padding at all. A theme rule is prefixed with that same
   * editor class, so it matches the base theme's weight and is injected after
   * it. Font size, weight and colour stay in webview.css, where they work.
   *
   * Asymmetric on purpose: a pad above, none below, so a heading belongs to what
   * follows it rather than floating between two blocks.
   *
   * Flat at every level, and this is the second thing the rule gets right. It
   * used to be an em of the heading's own size, which put 32px above an h1 and
   * 21px above an h6: air that shrinks as the heading gets smaller, when a deeper
   * heading is the harder one to spot. GitHub's own stylesheet for rendered
   * Markdown uses one figure at all six levels, and so does this.
   *
   * The figure is 12px rather than GitHub's 24, because the blank line above the
   * heading is already a full line of text and carries most of the separation.
   * A heading under one blank line sits 36px below the block above it, half again
   * the 24px between two paragraphs, which is GitHub's ratio reached by different
   * arithmetic. Under two blank lines it is 60px, because two blank lines in the
   * file mean twice the gap on the screen.
   *
   * Padding, never margin. CodeMirror's height map reads each line's
   * offsetHeight, which counts padding and not margin, and a height map that
   * disagrees with the page sends clicks to the wrong line.
   *
   * Top and bottom only, never the `padding` shorthand. A heading is a
   * `.cm-line` like any other, and the shorthand also set the left and right to
   * zero, dropping the 6px CodeMirror indents every line by. Every heading in
   * every document therefore started 6px left of the paragraphs under it, which
   * is visible the moment a heading sits above body text.
   */
  /*
   * The horizontal indent, for every line that sits inside a list or a quote.
   *
   * Here for exactly the reason the heading padding above is here, and it was proved the
   * same way. `.tok-quote { padding-left: 0.9em }` sat in webview.css and never reached the
   * screen: CodeMirror's own `.ͼ1 .cm-line` carries two classes to that one and is injected
   * after the stylesheet, so it won, and a quote's words started at CodeMirror's 6px instead
   * of the 14.4px asked for. Measured at 13.19px from the line's left edge, which is that 6px
   * plus one stray space, with the requested padding nowhere in it.
   *
   * One declaration reading both depths, rather than one rule per axis. Two rules each
   * setting `padding-left` cannot add up, so a list inside a quote would take one indent and
   * silently lose the other. A line outside both carries neither class and keeps the editor's
   * own base, which is what makes a plain paragraph the control for all of this.
   *
   * Padding, never margin, for the same reason as the headings: CodeMirror's height map reads
   * each line's offsetHeight, and a height map that disagrees with the page sends clicks to
   * the wrong line.
   */
  '.tok-rhythm': {
    paddingLeft:
      'calc(var(--md-line-base, 6px)' +
      ' + var(--md-list-depth, 0) * var(--md-indent-step, 32px)' +
      ' + var(--md-quote-depth, 0) * var(--md-quote-step, 20px))',
  },
  /*
   * The hang, on the one line a list item opens with.
   *
   * A negative text-indent pulls that line's first box, the marker, back out of the padding
   * by exactly one step, which is the box's own width plus its gap. Every wrapped row of the
   * same line is unaffected by text-indent and so begins at the padding, which is the content
   * edge: the wrap hangs, and the marker stops reading as part of the sentence.
   */
  '.tok-hang': { textIndent: 'calc(-1 * var(--md-indent-step, 32px))' },
  /*
   * The air above a list item, so a list reads as a list rather than as a paragraph with
   * markers in it.
   *
   * On the line an item opens on, which is the whole trick: a wrapped item is one `.cm-line`
   * however many rows it draws on, so the gap lands once per item and never inside one. A
   * three-line item takes 4px at its top and nothing between its rows. `livePreview.ts` decides
   * which items carry the class; everything here is the length.
   *
   * Top only. An item's own gap belongs above it, so the last item of a list adds nothing below
   * and a list does not stand off from what follows it.
   *
   * Here rather than in the stylesheet, and padding rather than margin, for the two reasons the
   * heading space above is here: CodeMirror's own `.ͼ1 .cm-line` beats a single class in the
   * stylesheet, and its height map counts padding and not margin. GitHub's own figure for this
   * is a margin, which is why it has to be translated rather than copied.
   */
  '.tok-item-gap': { paddingTop: 'var(--md-item-gap, 4px)' },
  /*
   * One rule for all six levels, because `.tok-heading` goes on the line beside
   * `.tok-h1`..`.tok-h6`. Six identical rules would say the same thing and leave
   * six places for one of them to drift.
   */
  '.tok-heading': { paddingTop: 'var(--md-heading-space, 12px)', paddingBottom: '0' },
});

/**
 * Highlight style for code inside fenced blocks (parsed via nested languages)
 * and any tokens not otherwise handled.
 *
 * Every colour is one of Sheaf's own `--md-tok-*` properties, defined in `media/webview.css`
 * for a dark theme and again for a light one. They used to name VS Code variables with a
 * fallback beside each, and that is the shape this replaced: VS Code publishes no editor token
 * colours to a webview at all, so the variables named were ones that exist for other purposes,
 * and a fallback is reached only when a variable is undefined. Five token types were therefore
 * drawn in the grey VS Code uses for the suggest widget's type icons, four units from body
 * prose. The two that looked right did so because their borrowed variable happened to carry the
 * same value as the fallback written beside it.
 */
const codeHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--md-tok-keyword)' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: 'inherit' },
  {
    tag: [t.propertyName],
    color: 'var(--md-tok-property)',
  },
  {
    /*
     * A called method is a function too. Without `function(propertyName)` the `log` of
     * `console.log` falls through to the property colour, which is not what VS Code does with
     * it and not what a reader of the line means by it. Measured: it came out identical to
     * `length` in the same statement, which the colour check reports as a collision.
     */
    tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName],
    color: 'var(--md-tok-function)',
  },
  {
    tag: [t.string, t.inserted],
    color: 'var(--md-tok-string)',
  },
  {
    tag: [t.number, t.bool, t.null],
    color: 'var(--md-tok-number)',
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--md-tok-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [t.typeName, t.className, t.tagName],
    color: 'var(--md-tok-class)',
  },
  { tag: [t.operator, t.punctuation], color: 'inherit' },
  { tag: t.invalid, color: 'var(--md-tok-invalid)' },
]);

export const notionTheme: Extension = [baseTheme, syntaxHighlighting(codeHighlight)];

/** The width of the text column when the setting does not name a usable one. */
export const DEFAULT_CONTENT_WIDTH = '708px';

/**
 * A positive CSS length: a number and a unit, `708px` or `90ch` or `60%`.
 *
 * The units are CSS's own absolute, font-relative and viewport-relative ones, plus the
 * percentage, which sizes the column against the pane. A bare number is not a length
 * and neither is a keyword, so neither is taken.
 */
const LENGTH =
  /^\s*(\d*\.?\d+)(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|cap|ic|lh|rlh|vw|vh|vi|vb|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|%)\s*$/i;

/** Widths already refused, so one mistake in the setting is reported once. */
const refused = new Set<string>();

/**
 * The width to give the text column: the configured one when it is a CSS length, and
 * the default when it is not.
 *
 * `--md-content-width` is a custom property, and a custom property holds whatever text
 * it is given. A value that is not a length therefore fails nowhere near the setting:
 * it fails inside the `calc()` above that sizes the column, and a `calc()` that does
 * not parse makes the whole `max-width` invalid. The column then has no bound at all
 * and the text runs the full width of the editor pane, which reads as the centred
 * column having been removed rather than as a value having been mistyped. So the value
 * is read here, where a refusal can be said out loud.
 */
export function contentWidth(configured: string): string {
  const match = LENGTH.exec(configured);
  if (match && Number(match[1]) > 0) return match[1] + match[2];
  if (!refused.has(configured)) {
    refused.add(configured);
    console.warn(
      `Sheaf cannot read "${configured}" as a width for the text column, so the column is ` +
        `${DEFAULT_CONTENT_WIDTH} wide instead. sheaf.contentWidth takes one positive CSS ` +
        'length, such as "708px", "90ch" or "60%".'
    );
  }
  return DEFAULT_CONTENT_WIDTH;
}
