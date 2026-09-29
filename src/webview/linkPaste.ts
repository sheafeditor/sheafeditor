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

/** A path that names a Markdown document. */
const MARKDOWN_PATH = /\.(md|markdown)$/i;

/**
 * The path to another document the clipboard holds, or null when it holds something else.
 *
 * Copying a file in a file manager or an editor's own file tree puts its path on the
 * clipboard, and pasting that into a document is how a person links to it. What arrives is
 * a path rather than an address, so it has to be told apart from prose that happens to end
 * the same way, and the rule is the file extension plus one of three shapes.
 *
 * A `file:` URL is what a desktop hands over. A drive letter is a path and not a scheme,
 * whatever it looks like. Any other scheme is a web address, and `https://x.io/a.md` is not
 * a file in this workspace. A path holding a space is ordinary on a desktop, but so is a
 * sentence ending in `.md`, so a spaced one has to say it is a path by starting at the root
 * or with a `./`.
 */
export function pastedDocPath(text: string): string | null {
  const raw = text.trim();
  if (!raw || /[\r\n]/.test(raw) || !MARKDOWN_PATH.test(raw)) return null;
  if (/^file:/i.test(raw)) return raw;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  if (/\s/.test(raw)) return /^(\/|\.\.?\/)/.test(raw) ? raw : null;
  return raw;
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
 * Whether a caret at `pos` is somewhere a link written from a paste means something.
 *
 * The same question `linkableRange` asks for a selection, with nothing selected: the caret
 * has to sit in ordinary prose. `NOT_INLINE` covers code, an HTML block, a table's source
 * and a link already there, and front matter is asked separately because this dialect has no
 * node for it.
 */
function plainProseAt(state: EditorState, pos: number): boolean {
  if (posInFrontMatter(state.doc, pos)) return false;
  let inline = true;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter: (node) => {
      if (NOT_INLINE.test(node.name)) inline = false;
      return inline;
    },
  });
  return inline;
}

/** What the host says a pasted path names, or null when it names nothing to link. */
type AskTitle = (path: string) => Promise<{ address: string; title: string } | null>;

let askTitle: AskTitle | null = null;

/**
 * How to ask the host what a pasted path names. Without one — on the site's demo, and in
 * every test that does not set it — a pasted path stays a plain paste, which is what it was
 * before this existed.
 */
export function setDocTitleHost(ask: AskTitle | null): void {
  askTitle = ask;
}

/**
 * Write a link to another document at the caret, the way pasting its path means.
 *
 * Only the host can answer this: the webview has no way to read another file, and no way to
 * work out what a path is relative to. So nothing is written when the paste happens, and the
 * link goes in when the answer arrives. The caret's position is taken now and used then,
 * which is how a pasted image is handled and for the same reason: the answer comes back in
 * milliseconds with nobody typing, and carrying the position through a state field to cover
 * the case where somebody did would be a lot of machinery for it.
 *
 * A path the host will not answer for pastes as text, at the same place, so a paste never
 * silently does nothing.
 */
export function handleDocPathPaste(view: EditorView, text: string): boolean {
  const ask = askTitle;
  if (!ask) return false;
  const path = pastedDocPath(text);
  if (!path) return false;
  const { state } = view;
  const sel = state.selection.main;
  if (state.selection.ranges.length !== 1 || !sel.empty) return false;
  if (!plainProseAt(state, sel.head)) return false;
  const at = sel.head;
  const write = (insert: string): void => {
    const pos = Math.min(at, view.state.doc.length);
    view.dispatch({
      changes: { from: pos, to: pos, insert },
      selection: { anchor: pos + insert.length },
      userEvent: 'input.paste',
      scrollIntoView: true,
    });
  };
  void ask(path).then(
    (answer) => write(answer ? markdownLink(answer.title, answer.address) : text),
    () => write(text)
  );
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
      // Over a selection, the address links the words. With nothing selected, a path to
      // another document brings that document's title with it as the words.
      if (!handleLinkPaste(view, text) && !handleDocPathPaste(view, text)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
}
