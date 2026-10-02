/*
 * The editor's behaviour, shared by the webview and the test harness: Markdown
 * parsing, live preview, tables, the prose editing modules, theme and keymaps.
 * Host wiring (compartments, listeners, messages) stays in main.ts.
 */

import { EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { commonmarkLanguage, markdownKeymap, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { markdownDialect, sheafMarkdown } from './markdownDialect';
import { formatStateAt } from './formatState';
import { languages } from '@codemirror/language-data';
import { indentUnit, LanguageDescription } from '@codemirror/language';
import { livePreview, revealField } from './livePreview';
import { comments } from './comments';
import { frontMatterView } from './frontMatterView';
import { tables } from './tables';
import { notionTheme } from './theme';
import { buildEditingKeymap, orderedListRenumbering } from './shortcuts';
import { caretPastMarker, openLineAboveMarker, toLineStart, unwrapAtTextStart } from './lineStart';
import { deleteAcrossInvisible, deleteWordAcrossInvisible, spaceOutsideInvisible, splitKeepingRuns } from './invisibleEdges';
import { breakOnAlertMarker, dividerKeepsItsLine, typingBesideARule, typingIntoAFence, typingIntoAnAlert, unwrapAlertAtEdge, unwrapFenceAtEdge } from './typedIntoChrome';
import { leftAcrossMarker, rightAcrossMarker, verticallyByRow } from './caretMotion';
import { paging } from './paging';
import { searchSupport } from './search';
import { selectionToolbar } from './selectionToolbar';
import { paneWidth } from './paneWidth';
import { textSelectionLayer } from './selectionHighlight';
import { blockEditing } from './blocks';
import { pendingMarks } from './pendingMarks';
import { changeMarks } from './changeMarks';
import { linkComplete } from './linkComplete';

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
    // drawSelection() draws the cursor and hides the native selection; its
    // selection boxes are replaced by one confined to the selected text.
    drawSelection(),
    textSelectionLayer,
    dropCursor(),
    highlightActiveLine(),
    EditorState.allowMultipleSelections.of(true),
    // `sheafMarkdown` rather than `markdown()`: it installs no paste handler and no keymap of its
    // own, and it leaves out the HTML parser that drags three other languages into the bundle. Sheaf
    // answers that paste itself, in linkPaste.ts, and two handlers for one gesture is two sets of
    // rules: Markdown's own reads any address-shaped text, so a clipboard holding several lines that
    // happen to start with a scheme is written into a destination that cannot hold them, and it
    // escapes nothing, so a bracket in the chosen words ends the label early.
    sheafMarkdown({ base: commonmarkLanguage, codeLanguages: codeLanguageFor, extensions: markdownDialect }),
    // Markdown's Enter and Backspace, at the high precedence markdown() would give
    // them, with Sheaf's Enter for an empty list item or quote line ahead of them.
    // Enter at the start of a block's text goes ahead of Markdown's own Enter, which
    // would otherwise continue the list before this could be asked. It answers only
    // at that one position and falls through everywhere else. See lineStart.ts.
    Prec.high(
      keymap.of([
        { key: 'Enter', run: endEmptyBlock, stopPropagation: true },
        { key: 'Enter', run: openLineAboveMarker, stopPropagation: true },
        // And inside a formatted run, the run closes before the break and opens again
        // after it, rather than being cut in half with its delimiters showing.
        // And on a callout's marker line, which is chrome, the break opens a line in the
        // callout's body rather than cutting `> [!NOTE]` in half. See typedIntoChrome.ts.
        { key: 'Enter', run: breakOnAlertMarker, stopPropagation: true },
        { key: 'Enter', run: splitKeepingRuns, stopPropagation: true },
        /*
         * And Backspace and Delete on a callout's marker line, which have to be here rather
         * than in the editing keymap below, because what they are competing with is in this
         * array. `markdownKeymap`'s own `deleteMarkupBackward` takes the `>` off a quoted
         * line's first position, and a callout is a quote, so it left `[!NOTE]` standing
         * outside a blockquote as text. Two keymaps at one precedence resolve in the order
         * they were registered, so a binding in the block below is asked second and never
         * reached: measured, the handler was not called at all at that position.
         *
         * Every other position on the line is reached from either block, which is what made
         * this look like it worked: the middle and the end of the marker were right and only
         * the left edge leaked.
         */
        { key: 'Backspace', run: (view) => unwrapAlertAtEdge(view, false) },
        { key: 'Delete', run: (view) => unwrapAlertAtEdge(view, true) },
        ...markdownKeymap,
      ])
    ),
    // Notion-style generous nesting: Tab/Shift-Tab move one 4-space level,
    // which renders as a clear child indent (and is unambiguous for ordered
    // lists, whose `1. ` content offset is 3).
    indentUnit.of('    '),
    revealField,
    livePreview,
    paneWidth,
    comments,
    frontMatterView,
    tables,
    searchSupport,
    selectionToolbar,
    blockEditing,
    linkComplete,
    pendingMarks,
    changeMarks(),
    notionTheme,
    // Our editing shortcuts win first (Tab indent, headings, marks), then
    // Markdown's Enter/Backspace list continuation, then CM defaults.
    keymap.of([...buildEditingKeymap(onShowShortcuts), ...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
    // An indent change moves an item between numbered lists, so the numbers follow it. A
    // filter rather than part of either command, so it covers Tab, Shift-Tab and anything
    // else that indents, and so the renumbering shares the indent's transaction: one undo
    // has to take both, or the first undo leaves the item nested with its old number.
    orderedListRenumbering,
    // Home ahead of the defaults, so the start of a line is the start of its text rather
    // than however much of the marker happens to be drawn. See lineStart.ts.
    //
    // Backspace with it, and ahead of Markdown's own: at the left edge of a heading,
    // a quote or an item, the key takes the block's formatting rather than the last
    // character of a marker the person cannot see.
    Prec.high(
      keymap.of([
        { key: 'Home', run: (view) => toLineStart(view, false), preventDefault: true },
        { key: 'Shift-Home', run: (view) => toLineStart(view, true), preventDefault: true },
        // And Left at the start of a line's words, for the same reason: the position in
        // front of a hidden marker is drawn in the same place and typing there rewrites
        // the block. See caretMotion.ts.
        //
        // These give the arrow keys a destination a person means. The filter below is
        // the safety net under them: it closes the routes no binding covers, and on its
        // own it would make Left at the left edge of a heading appear to do nothing.
        { key: 'ArrowLeft', run: (view) => leftAcrossMarker(view, false) },
        { key: 'Shift-ArrowLeft', run: (view) => leftAcrossMarker(view, true) },
        { key: 'ArrowRight', run: (view) => rightAcrossMarker(view, false) },
        { key: 'Shift-ArrowRight', run: (view) => rightAcrossMarker(view, true) },
        // Up and Down only where CodeMirror stepped over a line too short for it to see.
        { key: 'ArrowUp', run: (view) => verticallyByRow(view, false, false) },
        { key: 'ArrowDown', run: (view) => verticallyByRow(view, true, false) },
        { key: 'Shift-ArrowUp', run: (view) => verticallyByRow(view, false, true) },
        { key: 'Shift-ArrowDown', run: (view) => verticallyByRow(view, true, true) },
        // Backspace at the left edge of a heading, a quote or an item takes the block's
        // formatting rather than the last character of a marker nobody can see.
        { key: 'Backspace', run: unwrapAtTextStart },
        // Then the inline case, behind it: a delimiter drawn as nothing is stepped
        // over rather than deleted, so Backspace takes the character a person can
        // see and the formatting stays. See invisibleEdges.ts.
        { key: 'Backspace', run: (view) => deleteAcrossInvisible(view, false) },
        { key: 'Delete', run: (view) => deleteAcrossInvisible(view, true) },
        // And on a code fence, where taking one backtick leaves a block that fences
        // nothing, both keys take the block's formatting. See typedIntoChrome.ts.
        { key: 'Backspace', run: (view) => unwrapFenceAtEdge(view, false) },
        { key: 'Delete', run: (view) => unwrapFenceAtEdge(view, true) },
        // The word-sized deletions reach further and so break more of the same
        // things. Both spellings of delete-word-back are bound, because macOS
        // sends Alt and the rest of the world sends Ctrl.
        // A callout's marker line first, because every position on it is inside one piece
        // of chrome and reaching further along it reaches nothing different.
        { key: 'Mod-Backspace', run: (view) => unwrapAlertAtEdge(view, false) },
        { key: 'Alt-Backspace', run: (view) => unwrapAlertAtEdge(view, false) },
        { key: 'Mod-Delete', run: (view) => unwrapAlertAtEdge(view, true) },
        { key: 'Alt-Delete', run: (view) => unwrapAlertAtEdge(view, true) },
        { key: 'Mod-Backspace', run: (view) => deleteWordAcrossInvisible(view, false) },
        { key: 'Alt-Backspace', run: (view) => deleteWordAcrossInvisible(view, false) },
        { key: 'Mod-Delete', run: (view) => deleteWordAcrossInvisible(view, true) },
        { key: 'Alt-Delete', run: (view) => deleteWordAcrossInvisible(view, true) },
      ])
    ),
    // And the caret never rests in front of a hidden marker, which is the position
    // that made every one of those keys ambiguous. See lineStart.ts.
    caretPastMarker,
    // And a space typed against one lands on its outside, where Markdown can hold it,
    // rather than inside the run where it ends the formatting. See invisibleEdges.ts.
    spaceOutsideInvisible,
    // And typing on the line above a divider keeps the blank line between them, so
    // the divider is not read as the heading underline it can also be. See setextGuard.ts.
    dividerKeepsItsLine,
    typingBesideARule,
    typingIntoAFence,
    // And a callout's marker line is chrome like a fence is, so typing on it writes in
    // the callout rather than inside `[!NOTE]`. Same file, same reason.
    typingIntoAnAlert,
    // And paging ahead of them too, so a page is a screenful of scroll rather than a
    // caret move that rounds to a line. See paging.ts.
    paging,
    EditorView.lineWrapping,
  ];
}
