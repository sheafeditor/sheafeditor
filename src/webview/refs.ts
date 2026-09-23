/*
 * A Copy ref: the text it puts on the clipboard, and the host that delivers it.
 *
 * A reference is `path:line` (or `path:start-end`) followed by the text it names
 * in a fenced block, so a paste into a chat says what is there as well as where
 * it is. Every surface that offers one builds it here — the selection toolbar,
 * the block handle's menu, the right-click menu, and the commands the window's
 * sharing keys run — because two builders would drift into saying two different
 * things about one selection.
 *
 * Naming the document and writing the clipboard are the host's to do: a webview
 * cannot read a workspace path and its `navigator.clipboard` is restricted. The
 * page is given both once, at startup. Until then there is no way to build or
 * deliver a ref, and each surface leaves its Copy ref out rather than offering
 * one that would do nothing.
 */

import { EditorView } from '@codemirror/view';
import { coveredEnd } from './selectionExtent';

/* ---- Building ------------------------------------------------------------- */

/**
 * Wrap `text` in a Markdown fenced code block. The fence is grown longer than
 * the longest backtick run inside the text so content containing ``` stays
 * intact, and a trailing newline is trimmed so the closing fence sits flush.
 */
export function fence(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const bars = '`'.repeat(Math.max(3, longest + 1));
  return `${bars}\n${text.replace(/\n$/, '')}\n${bars}`;
}

/** `location`, then `text` in a fenced block below it, or the location alone when there is nothing to quote. */
function quotedRef(location: string, text: string): string {
  return text === '' ? `${location}\n` : `${location}\n\n${fence(text)}\n`;
}

/**
 * The reference for what is selected: the lines it covers, and the text itself.
 * With only a caret it names the line the caret sits on and quotes that line. An
 * empty line has nothing to quote and gets the location alone.
 */
export function buildRef(view: EditorView, fileName: string): string {
  const { doc } = view.state;
  const sel = view.state.selection.main;
  const startLine = doc.lineAt(sel.from).number;
  // A selection that ends at the start of a line (a triple-clicked line) covers
  // no character of that line, so the range stops at the line before it.
  const endLine = doc.lineAt(coveredEnd(doc, sel)).number;
  const range = !sel.empty && endLine !== startLine ? `${startLine}-${endLine}` : `${startLine}`;
  const text = sel.empty ? doc.line(startLine).text : doc.sliceString(sel.from, sel.to);
  return quotedRef(`${fileName}:${range}`, text);
}

/**
 * A reference to cells of a table: the lines, then which cells those are in the
 * grid's terms when the grid said, as in `doc.md:24 (Time, row 4)`.
 */
export function tableRowRef(fileName: string, ref: { start: number; end: number; text: string; label?: string }): string {
  // The ref carries the text the grid handed back: whole lines, the cells that
  // were picked inside them, or one cell's text.
  const range = ref.start === ref.end ? `${ref.start}` : `${ref.start}-${ref.end}`;
  return quotedRef(`${fileName}:${range}${ref.label ? ` (${ref.label})` : ''}`, ref.text);
}

/* ---- The host ------------------------------------------------------------- */

export interface BlockRefHost {
  /** Workspace-relative path of the document. */
  getFileName: () => string;
  /** Put text on the clipboard through the host. */
  copyToClipboard: (text: string) => void;
  /**
   * Whether the window around this page binds the sharing keys. Only an editor
   * window does; in a browser tab the chord does nothing, and a surface that
   * printed it would be promising a key that is not there.
   */
  hasEditorKeys?: () => boolean;
}

let host: BlockRefHost | null = null;

/** Give the page a way to name the document and write the clipboard; Copy ref is hidden until then. */
export function setBlockRefHost(next: BlockRefHost | null): void {
  host = next;
}

/** The host, or null where the page has none. */
export function blockRefHost(): BlockRefHost | null {
  return host;
}

/** Whether a Copy ref may print its key: true only where the window binds the sharing keys. */
export function hasRefKey(): boolean {
  return host?.hasEditorKeys?.() ?? false;
}
