/*
 * Pasting a web address over chosen words.
 *
 * The gesture is copying an address in a browser, coming back to the document,
 * selecting the words that should carry it and pasting. Handed to the editor as
 * ordinary text the address lands where the words were and the words are gone,
 * which for a moment reads like it worked. When the clipboard holds one address
 * and the selection is prose a link can be made of, the paste writes the link
 * around the words instead.
 *
 * Everything else stays a plain paste, because a plain paste is never wrong: the
 * clipboard has to hold an address and nothing else, the selection has to cover
 * text, and the place it sits has to be somewhere a link means something. Code is
 * read as it is written, and Markdown has no link inside a link.
 */

import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
// The leaf module rather than `floatingState`'s `inFrontMatter`, which asks the
// block model and would close an import cycle back through the toolbar and the
// image handling into this file. Both rest on the same `frontMatterEnd`.
import { posInFrontMatter } from './frontMatter';

/**
 * The schemes a pasted address may carry. Everything a browser hands over is one
 * of these, and the list is what keeps `javascript:` and `data:` out: they parse
 * as addresses, and a document that links one is a document that runs it.
 */
const SCHEMES = /^(https?|mailto):$/;

/**
 * The address the clipboard holds, or null when it holds something else.
 *
 * One token with no whitespace in it, because a clipboard carrying a sentence, a
 * list of addresses, or an address with a note after it is text being pasted as
 * text. Surrounding whitespace goes: a copied address often arrives with the line
 * break that followed it.
 */
export function pastedUrl(text: string): string | null {
  const url = text.trim();
  if (!url || /\s/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // `example.com` with no scheme, a file path, a fragment of prose: all things
    // a person pastes far more often than they paste a link.
    return null;
  }
  return SCHEMES.test(parsed.protocol) ? url : null;
}

/**
 * A run of selected text as a link label. A bracket in the words would close the
 * label early and leave the address showing as text, so brackets are escaped, and
 * so is the backslash that would otherwise turn one of those escapes into a
 * literal backslash followed by a live bracket.
 */
function labelOf(text: string): string {
  return text.replace(/[\\[\]]/g, '\\$&');
}

/*
 * What a bare link destination cannot hold: parentheses, whitespace and the control
 * characters. Written as escapes rather than as the characters themselves, because a
 * literal control character makes git read the whole file as binary, and a file git
 * shows no diff for is a file nobody reviews again.
 */
const NEEDS_BRACKETS = /[()\s\x00-\x1f\x7f]/;

/**
 * An address as a link destination. Markdown reads a bare destination up to the
 * closing parenthesis, so an address carrying a parenthesis of its own, or any
 * character a bare destination cannot hold, goes inside the angle brackets that
 * are the spelling for exactly this.
 */
function destinationOf(url: string): string {
  if (!NEEDS_BRACKETS.test(url)) return url;
  return `<${url.replace(/[<>\\]/g, '\\$&')}>`;
}

/** The Markdown that links `text` to `url`. */
export function markdownLink(text: string, url: string): string {
  return `[${labelOf(text)}](${destinationOf(url)})`;
}

/**
 * Where a link would be markup rather than a link. Code is shown as it is
 * written, an HTML block or tag names its links its own way, a table's source is
 * a row rather than a line of prose, and a link already under the selection has no
 * answer: Markdown cannot nest one, and choosing between the two links for the
 * person would be guessing.
 */
const NOT_INLINE =
  /^(FencedCode|CodeBlock|CodeText|InlineCode|HTMLBlock|CommentBlock|ProcessingInstructionBlock|HTMLTag|Table|Link|Image|Autolink|URL|LinkReference)$/;

/** The selected range a link can be written around, or null when there is none. */
function linkableRange(state: EditorState): { from: number; to: number } | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1) return null;
  const { from, to } = sel.main;
  if (from === to) return null;
  // A label is one run of text inside one block. A selection reaching past the end
  // of a line has left the block it started in, or carries a break no label can
  // hold, and the words it covers are not one label.
  if (state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return null;
  // Front matter is YAML rather than prose, and the tree cannot say so: this
  // dialect has no node for it, and `title: x` over `---` parses as a heading. A
  // link written in there stops the file's own metadata being readable by
  // anything that reads it, which is a static site generator more often than not.
  if (posInFrontMatter(state.doc, from)) return null;
  let inline = true;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (NOT_INLINE.test(node.name)) inline = false;
      return inline;
    },
  });
  return inline ? { from, to } : null;
}

/** The single change a paste of `text` should make, or null for a plain paste. */
export function linkPasteEdit(
  state: EditorState,
  text: string
): { from: number; to: number; insert: string } | null {
  const url = pastedUrl(text);
  if (!url) return null;
  const range = linkableRange(state);
  if (!range) return null;
  return { ...range, insert: markdownLink(state.sliceDoc(range.from, range.to), url) };
}

/**
 * Write the link a paste of `text` over the selection means, and say whether it
 * did. One transaction, so one undo puts the words back as they were.
 */
export function handleLinkPaste(view: EditorView, text: string): boolean {
  const edit = linkPasteEdit(view.state, text);
  if (!edit) return false;
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    // The caret lands after the address rather than over the new link. The words
    // are already written, and leaving them selected would put the next thing
    // typed straight over the link that was just made.
    selection: { anchor: edit.from + edit.insert.length },
    userEvent: 'input.paste',
    scrollIntoView: true,
  });
  return true;
}

/**
 * Whether a paste passing through this editor's element is this editor's to
 * answer. A table cell opens an editor of its own inside the document's content,
 * and a paste into it travels through here on its way down. The cell's text is not
 * the document's selection, so answering that paste here would write a link into
 * a different place entirely.
 */
function ownPaste(view: EditorView, target: EventTarget | null): boolean {
  const node = target as Node | null;
  const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
  if (!el || typeof el.closest !== 'function') return true;
  // A cell's own editor sits inside its `.sheaf-table-input` and answers its own
  // paste; the document behind it does not, and nor does anything for a CSV cell,
  // which is a plain field with no editor of its own.
  const cell = el.closest('.sheaf-table-input');
  return el.closest('.cm-editor') === view.dom && (!cell || cell.contains(view.dom));
}

/** Editors already listening, so wiring one twice does not paste the link twice. */
const listening = new WeakSet<EditorView>();

/**
 * Watch pastes on their way down to the content, ahead of CodeMirror's own paste
 * handler. On the way back up is too late: by then the selection the address was
 * meant to link has already been replaced by the address.
 */
export function installLinkPaste(view: EditorView): void {
  if (listening.has(view)) return;
  listening.add(view);
  view.dom.addEventListener(
    'paste',
    (e) => {
      const event = e as ClipboardEvent;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text || !ownPaste(view, event.target)) return;
      if (!handleLinkPaste(view, text)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
}
