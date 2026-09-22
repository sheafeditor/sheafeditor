/*
 * What the sync suite is run against: the host's own sync code, plus a stand-in
 * for the webview's document built on the CodeMirror state the webview really
 * uses. `src/webview/main.ts` cannot be imported here — it boots a view against
 * the DOM as soon as it loads — so `setContent` below mirrors its, down to the
 * line endings it converts the text to, the prefix/suffix diff and the dispatch of
 * the replacement as a string. That dispatch is where the line endings in the text
 * matter: CodeMirror splits an inserted string into lines on `\r\n`, a lone `\r`,
 * or `\n` alike. The checks that need `main.ts` itself boot it in a page of its
 * own, through `test/webview.mjs`.
 */

import { EditorState, Transaction } from '@codemirror/state';
import { minimalEdit, toWebviewText } from '../src/textSync';

export { minimalEdit, planEdit, toWebviewText, DocumentSync } from '../src/textSync';
export { RecentTyping, RECENT_TYPING_MS, noticeAboutLostText, quoteLost } from '../src/recentTyping';
export {
  parseView,
  applyView,
  rowMatches,
  prefillFor,
  setViewKey,
  formatWhere,
  formatSort,
  formatShow,
  setWhereCondition,
  setSortKey,
  hideViewColumn,
  viewKeyValue,
} from '../src/webview/viewQuery';
export { leadingNumber, wholeNumber } from '../src/webview/cellNumbers';

/** The single changed region between two strings, as `main.ts` computes it. */
function diff(oldText: string, newText: string): { from: number; to: number; insert: string } {
  const { start, end, replacement } = minimalEdit(oldText, newText);
  return { from: start, to: end, insert: replacement };
}

/** Where `main.ts` puts the caret when a document from the host inserts text on it. */
function caretAfterRemoteText(
  state: EditorState,
  change: { from: number; to: number; insert: string }
): { anchor: number } | undefined {
  const { main, ranges } = state.selection;
  if (ranges.length !== 1 || !main.empty) return undefined;
  if (change.from !== change.to || change.from !== main.head) return undefined;
  if (/[\n\r]/.test(change.insert)) return undefined;
  return { anchor: main.head + change.insert.length };
}

export interface Webview {
  /** The text the webview holds, which is what it posts to the host. */
  doc(): string;
  /** Where the caret is. A change from the host moves it, the way CodeMirror maps it. */
  caret(): number;
  /** Host to webview: replace the document with `text`. */
  setContent(text: string): void;
  /** The region the last document from the host replaced. */
  lastChange(): { from: number; to: number; insert: string };
  /** Put the caret somewhere, as clicking does. */
  click(at: number): void;
  /** A character typed at the caret. Returns the whole text the webview posts to the host. */
  type(insert: string): string;
  /** An edit at a given place. Returns the whole text the webview posts to the host. */
  replaceRange(from: number, to: number, insert: string): string;
}

export function mountWebview(text: string): Webview {
  let state = EditorState.create({ doc: text, selection: { anchor: 0 } });
  let change = { from: 0, to: 0, insert: '' };
  return {
    doc: () => state.doc.toString(),
    caret: () => state.selection.main.head,
    lastChange: () => change,
    setContent(incoming: string): void {
      const next = toWebviewText(incoming);
      if (state.doc.toString() === next) return;
      change = diff(state.doc.toString(), next);
      // Text landing on the caret goes in front of it; otherwise no selection is given,
      // so CodeMirror maps the caret through the change, which is what moves it when a
      // document arrives from the host mid-typing.
      state = state.update({
        changes: change,
        selection: caretAfterRemoteText(state, change),
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
      }).state;
    },
    click(at: number): void {
      state = state.update({ selection: { anchor: at } }).state;
    },
    type(insert: string): string {
      const at = state.selection.main.head;
      state = state.update({
        changes: { from: at, to: at, insert },
        selection: { anchor: at + insert.length },
      }).state;
      return state.doc.toString();
    },
    replaceRange(from: number, to: number, insert: string): string {
      state = state.update({ changes: { from, to, insert } }).state;
      return state.doc.toString();
    },
  };
}
