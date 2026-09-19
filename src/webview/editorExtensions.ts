/*
 * The editor's behaviour, shared by the webview and the test harness: Markdown
 * parsing, live preview, tables, the prose editing modules, theme and keymaps.
 * Host wiring (compartments, listeners, messages) stays in main.ts.
 */

import { EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage, markdownKeymap, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { formatStateAt } from './formatState';
import { languages } from '@codemirror/language-data';
import { indentUnit, LanguageDescription } from '@codemirror/language';
import { livePreview, revealField } from './livePreview';
import { tables } from './tables';
import { notionTheme } from './theme';
import { buildEditingKeymap } from './shortcuts';
import { Highlight } from './highlight';
import { searchSupport } from './search';
import { selectionToolbar } from './selectionToolbar';
import { blockEditing } from './blocks';
import { pendingMarks } from './toolbar';

/**
 * Short fence names people write for common languages, mapped to a name the
 * language list already knows. The list matches a fence only against each
 * language's name and aliases, so ```py and ```rs would otherwise get no colours
 * while ```python and ```rust do. Ambiguous extensions such as `h` and `m` are left out.
 */
const shortCodeNames: Record<string, string> = {
  py: 'python',
  py3: 'python',
  rs: 'rust',
  md: 'markdown',
  mkd: 'markdown',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  kt: 'kotlin',
  kts: 'kotlin',
  golang: 'go',
  ps1: 'powershell',
  pwsh: 'powershell',
  pl: 'perl',
  hs: 'haskell',
  erl: 'erlang',
  clj: 'clojure',
  htm: 'html',
  cc: 'c++',
  cxx: 'c++',
  hpp: 'c++',
  jl: 'julia',
  ml: 'ocaml',
  fs: 'f#',
  proto: 'protobuf',
  patch: 'diff',
  svg: 'xml',
};

/** The language for a fenced block's info string: a known short name first, then the list's own matching. */
export function codeLanguageFor(info: string): LanguageDescription | null {
  const short = shortCodeNames[info.toLowerCase()];
  if (short) {
    const found = LanguageDescription.matchLanguageName(languages, short, false);
    if (found) return found;
  }
  return LanguageDescription.matchLanguageName(languages, info, true);
}

/** Markdown's Enter, told to remove an empty item's marker even where it would otherwise turn a tight list loose. */
const endEmptyListItem = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/**
 * The blank line that keeps a block the caret has just left apart from what is
 * typed next. Ending a list or quote puts the caret on an empty line directly
 * below the block, and Markdown reads text written there as a continuation of the
 * last item, so the paragraph the person meant to start would be published inside
 * it. Nothing is added where the line above the caret is already blank, or where
 * the caret is still on a marked line, as it is after stepping out of a nested item.
 */
function separateFromBlock(view: EditorView): void {
  const { state } = view;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return;
  const line = state.doc.lineAt(sel.main.head);
  if (line.text.trim() !== '' || line.number === 1) return;
  if (state.doc.line(line.number - 1).text.trim() === '') return;
  view.dispatch({ changes: { from: line.from, insert: '\n' }, selection: { anchor: sel.main.head + 1 }, scrollIntoView: true, userEvent: 'input' });
}

/**
 * Enter on an empty list item or an empty quote line ends that list or quote: the
 * marker goes and the caret drops to a blank line below the block, which is what
 * Markdown's own Enter already does on an empty third item. Upstream treats an
 * empty second item differently on purpose (it adds a blank line, making the list
 * loose) and always continues a quote, so Sheaf runs this first. Every other line
 * returns false and falls through to Markdown's Enter.
 */
function endEmptyBlock(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const pos = sel.main.head;
  const fs = formatStateAt(state, pos);
  if (fs.codeBlock) return false;
  const line = state.doc.lineAt(pos);
  const body = line.text.replace(/^\s*(?:>\s?)*/, '');
  if (fs.list) {
    if (!/^\s*(?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?\s*$/.test(body) || !endEmptyListItem(view)) return false;
    separateFromBlock(view);
    return true;
  }
  const quote = /^(.*?)>\s*$/.exec(line.text);
  if (!fs.quote || !quote || !/^[\s>]*$/.test(line.text)) return false;
  // Remove the innermost `>`, so an empty line in a nested quote steps out one level.
  const from = line.from + quote[1].length;
  if (pos <= from) return false;
  view.dispatch({ changes: { from, to: line.to }, selection: { anchor: from }, scrollIntoView: true, userEvent: 'input' });
  separateFromBlock(view);
  return true;
}

export function editorExtensions(onShowShortcuts: () => void): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    EditorState.allowMultipleSelections.of(true),
    markdown({ base: markdownLanguage, codeLanguages: codeLanguageFor, extensions: [Highlight], addKeymap: false }),
    // Markdown's Enter and Backspace, at the high precedence markdown() would give
    // them, with Sheaf's Enter for an empty list item or quote line ahead of them.
    Prec.high(keymap.of([{ key: 'Enter', run: endEmptyBlock, stopPropagation: true }, ...markdownKeymap])),
    // Notion-style generous nesting: Tab/Shift-Tab move one 4-space level,
    // which renders as a clear child indent (and is unambiguous for ordered
    // lists, whose `1. ` content offset is 3).
    indentUnit.of('    '),
    revealField,
    livePreview,
    tables,
    searchSupport,
    selectionToolbar,
    blockEditing,
    pendingMarks,
    notionTheme,
    // Our editing shortcuts win first (Tab indent, headings, marks), then
    // Markdown's Enter/Backspace list continuation, then CM defaults.
    keymap.of([...buildEditingKeymap(onShowShortcuts), ...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
  ];
}
