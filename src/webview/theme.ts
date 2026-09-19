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
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--md-text)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    {
      backgroundColor: 'var(--md-selection)',
      color: 'var(--md-selection-text)',
    },
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
  // element, so they always resolve to the identical pixel width.)
  '.cm-gutters': {
    width: '3em',
    marginRight: '-3em',
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
