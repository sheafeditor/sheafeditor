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
    padding: '56px 0 40vh',
  },
  // Notion's centered writing column: 708px text measure inside side gutters.
  '.cm-content': {
    fontFamily: 'var(--sheaf-font, var(--md-font))',
    maxWidth: 'calc(var(--md-content-width) + 2 * var(--md-gutter))',
    margin: '0 auto',
    padding: '0 var(--md-gutter)',
    caretColor: 'var(--md-text)',
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
   * Asymmetric on purpose: a large pad above, almost none below, so a heading
   * belongs to what follows it rather than floating between two blocks. The
   * numbers are smaller than the ones the stylesheet asked for, because the
   * blank line above a heading is no longer a full line of text: it draws as an
   * 8px gap (blankLines.ts), and that 8px is part of what a reader sees. Each
   * level is tuned to land about 24 to 32px below the block above it.
   *
   * Padding, never margin. CodeMirror's height map reads each line's
   * offsetHeight, which counts padding and not margin, and a height map that
   * disagrees with the page sends clicks to the wrong line.
   */
  '.tok-h1': { padding: '0.8em 0 0.1em' },
  '.tok-h2': { padding: '0.7em 0 0.1em' },
  '.tok-h3': { padding: '0.8em 0 0.1em' },
  '.tok-h4': { padding: '0.9em 0 0.1em' },
  '.tok-h5': { padding: '0.9em 0 0.1em' },
  '.tok-h6': { padding: '0.9em 0 0.1em' },
});

/**
 * Highlight style for code inside fenced blocks (parsed via nested languages)
 * and any tokens not otherwise handled. Colors reference VS Code token theme
 * variables so they blend with the active color theme.
 */
const codeHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--vscode-symbolIcon-keywordForeground, #c586c0)' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: 'inherit' },
  {
    tag: [t.propertyName],
    color: 'var(--vscode-symbolIcon-propertyForeground, #9cdcfe)',
  },
  {
    tag: [t.function(t.variableName), t.labelName],
    color: 'var(--vscode-symbolIcon-functionForeground, #dcdcaa)',
  },
  {
    tag: [t.string, t.inserted],
    color: 'var(--vscode-debugTokenExpression-string, #ce9178)',
  },
  {
    tag: [t.number, t.bool, t.null],
    color: 'var(--vscode-debugTokenExpression-number, #b5cea8)',
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--vscode-descriptionForeground, #6a9955)',
    fontStyle: 'italic',
  },
  {
    tag: [t.typeName, t.className, t.tagName],
    color: 'var(--vscode-symbolIcon-classForeground, #4ec9b0)',
  },
  { tag: [t.operator, t.punctuation], color: 'inherit' },
  { tag: t.invalid, color: 'var(--vscode-errorForeground, #f14c4c)' },
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
