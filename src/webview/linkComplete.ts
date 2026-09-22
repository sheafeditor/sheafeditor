/*
 * Completion for a link's address: typing the `(` that follows a link's words
 * offers the files in the workspace, and a `#` straight after it offers this
 * document's headings.
 *
 * `(` is an ordinary character, so the list only ever appears beside the text and
 * never writes anything until a row is picked. Typing goes into the document exactly
 * as it would without the list, Escape closes it and leaves every typed character
 * where it is, and a pick is one undo step of its own.
 *
 * The files come from the extension host, which is the only side that can see the
 * workspace. The webview asks once each time a list opens and draws nothing for
 * files until the answer arrives; a host that never answers, as the browser host
 * does with a message it does not know, simply leaves the file list out. Headings
 * are read from this document's own syntax tree, so they never wait on anything.
 */

import { EditorState, Extension, Prec, StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import { headingSlug } from './linkTarget';
import { linkDestination } from './linkPopover';
import { posInFrontMatter } from './frontMatter';
import { FloatingIcon, floatingIcon } from './floatingIcons';
import { placeListAt } from './slashMenu';

export interface LinkCompletionItem {
  /** What the row shows: a path relative to this document, or a heading's text. */
  label: string;
  /** What picking the row writes as the link's destination. */
  insert: string;
  /** A heading's level, 1 to 6; absent on a file. */
  level?: number;
}

/** The most rows a list shows. Past this, typing a few more letters is quicker than scrolling. */
const MAX_ITEMS = 50;

/** How long to wait for the host's file list before giving up on it for this list. */
const FILES_TIMEOUT_MS = 1500;

// ---- The file list, asked of the host --------------------------------------

type Post = (message: unknown) => void;

let post: Post | null = null;
/** The document's path relative to its workspace folder, as the host named it. */
let documentPath = '';
let seq = 0;
const pending = new Map<string, (files: string[] | null) => void>();

/** Where to send a request for the workspace's files. Null leaves file completion out. */
export function setWorkspaceFilesHost(send: Post | null): void {
  post = send;
}

/**
 * The document's workspace-relative path, which every file path is made relative
 * to. A path the host could not make relative (a file outside any workspace folder
 * arrives as an absolute path) has no workspace to list, so files are left out.
 */
export function setLinkCompleteDocument(path: string): void {
  documentPath = path.replace(/\\/g, '/');
}

/** The host's answer to a request, by the id it was asked with. */
export function handleWorkspaceFiles(id: string, files: string[]): void {
  const done = pending.get(id);
  if (!done) return;
  pending.delete(id);
  done(Array.isArray(files) ? files : []);
}

function canListFiles(): boolean {
  return post !== null && documentPath !== '' && !/^(\/|[A-Za-z]:)/.test(documentPath);
}

/** The workspace's files as workspace-relative paths, or null when the host did not answer in time. */
function requestFiles(): Promise<string[] | null> {
  const send = post;
  if (!send || !canListFiles()) return Promise.resolve(null);
  const id = `files-${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, FILES_TIMEOUT_MS);
    pending.set(id, (files) => {
      clearTimeout(timer);
      resolve(files);
    });
    send({ type: 'workspaceFilesRead', id });
  });
}

/** `target` written relative to the folder `fromFile` sits in, in POSIX form. */
export function relativePath(fromFile: string, target: string): string {
  const from = fromFile.split('/').filter(Boolean).slice(0, -1);
  const to = target.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return '../'.repeat(from.length - common) + to.slice(common).join('/');
}

const MARKDOWN_FILE = /\.(md|markdown)$/i;

/**
 * The files matching `query`, best first. A file whose name starts with the query
 * leads, then a path that starts with it, then a name or a path that merely holds
 * it. Among equals a Markdown file comes before anything else, because a link in a
 * Markdown document most often points at another one, and then the shorter path.
 */
export function rankFiles(files: string[], docPath: string, query: string): LinkCompletionItem[] {
  const q = query.toLowerCase().replace(/^\.\//, '');
  const scored: Array<{ rel: string; score: number; md: number }> = [];
  for (const file of files) {
    const path = file.replace(/\\/g, '/');
    if (path === docPath) continue;
    const rel = relativePath(docPath, path);
    const name = (path.split('/').pop() ?? '').toLowerCase();
    const lowerRel = rel.toLowerCase();
    let score: number;
    if (q === '' || name.startsWith(q)) score = 0;
    else if (lowerRel.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (lowerRel.includes(q) || path.toLowerCase().includes(q)) score = 3;
    else continue;
    scored.push({ rel, score, md: MARKDOWN_FILE.test(path) ? 0 : 1 });
  }
  scored.sort((a, b) => a.score - b.score || a.md - b.md || a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return scored.slice(0, MAX_ITEMS).map(({ rel }) => ({ label: rel, insert: linkDestination(rel, false) }));
}

// ---- Headings, read from the document ---------------------------------------

const HEADING = /^(?:ATXHeading([1-6])|SetextHeading([12]))$/;

/**
 * Every heading in the document with the anchor it answers to. A repeated heading
 * gets `-1`, `-2` and so on after the first, which is how GitHub and the other
 * renderers tell them apart.
 */
export function documentHeadings(state: EditorState): Array<{ text: string; slug: string; level: number }> {
  const out: Array<{ text: string; slug: string; level: number }> = [];
  const seen = new Map<string, number>();
  syntaxTree(state).iterate({
    enter: (node) => {
      const m = HEADING.exec(node.name);
      if (!m) return undefined;
      // The heading's own markers are syntax, not part of the name it answers to.
      const text = state
        .sliceDoc(node.from, node.to)
        .split('\n')[0]
        .replace(/^#+\s*/, '')
        .replace(/\s+#+\s*$/, '')
        .trim();
      const base = headingSlug(text);
      if (!base) return false;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      out.push({ text, slug: count === 0 ? base : `${base}-${count}`, level: Number(m[1] ?? m[2]) });
      return false;
    },
  });
  return out;
}

function headingItems(state: EditorState, query: string): LinkCompletionItem[] {
  const q = query.toLowerCase();
  return documentHeadings(state)
    .filter((h) => h.text.toLowerCase().includes(q) || h.slug.startsWith(q))
    .slice(0, MAX_ITEMS)
    .map((h) => ({ label: h.text, insert: `#${h.slug}`, level: h.level }));
}

// ---- Where the list may open ------------------------------------------------

/** Inside these, a `(` is code, markup or table source and opens nothing. */
const LITERAL_BLOCKS = /^(FencedCode|CodeBlock|HTMLBlock|CommentBlock|Table)$/;
const LITERAL_INLINE = /^(InlineCode|HTMLTag|URL|Autolink)$/;

/** True when the character at `index` of `text` is escaped by an odd run of backslashes. */
function escaped(text: string, index: number): boolean {
  let n = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

/**
 * True when a `(` typed at `pos` would start a link's destination: the text before
 * it on the line ends with a `]` that closes a `[`, outside code, front matter and
 * table source. A task marker's `[ ]` is not a link's words.
 */
export function linkDestinationStartsAt(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const close = before.length - 1;
  if (close < 1 || before[close] !== ']' || escaped(before, close)) return false;
  let depth = 0;
  let open = -1;
  for (let i = close - 1; i >= 0; i--) {
    const ch = before[i];
    if ((ch !== '[' && ch !== ']') || escaped(before, i)) continue;
    if (ch === ']') depth++;
    else if (depth === 0) {
      open = i;
      break;
    } else depth--;
  }
  if (open < 0) return false;
  if (/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\]$/.test(before)) return false;
  if (posInFrontMatter(state.doc, pos)) return false;
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      // An unclosed fence runs to the end of the document, so a block contains its end.
      if (LITERAL_BLOCKS.test(node.name) && node.from < pos && pos <= node.to) return false;
      if (LITERAL_INLINE.test(node.name) && node.from < pos && pos < node.to) return false;
    }
  }
  return true;
}

// ---- The list's state -------------------------------------------------------

interface CompleteState {
  /** Start of the destination: just after the `(`. */
  from: number;
  /** What has been typed after the `(`. */
  query: string;
  selected: number;
  /** The workspace's files once the host has answered; null until then, or for good. */
  files: string[] | null;
  /** Which opening this is, so an answer that arrives late for an earlier one is dropped. */
  session: number;
}

const closeComplete = StateEffect.define<null>();
const moveComplete = StateEffect.define<number>();
const filesArrived = StateEffect.define<{ session: number; files: string[] }>();

let sessions = 0;

function itemsFor(state: EditorState, value: CompleteState): LinkCompletionItem[] {
  if (value.query.startsWith('#')) return headingItems(state, value.query.slice(1));
  return value.files ? rankFiles(value.files, documentPath, value.query) : [];
}

function validQuery(query: string): boolean {
  return !/^\s/.test(query) && !/\s\s/.test(query) && !/[\n)]/.test(query) && query.length <= 200;
}

const completeField = StateField.define<CompleteState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(closeComplete)) return null;
    const { state } = tr;
    if (!value) {
      // Open on a single typed `(` that starts a link's destination.
      if (!tr.docChanged || !tr.isUserEvent('input.type')) return null;
      let inserted: { at: number; text: string } | null = null;
      let count = 0;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
        count++;
        if (fromA === toA) inserted = { at: fromA, text: text.toString() };
      });
      const ins = inserted as { at: number; text: string } | null;
      if (count !== 1 || !ins || ins.text !== '(') return null;
      if (state.selection.ranges.length !== 1 || !state.selection.main.empty || state.selection.main.head !== ins.at + 1) return null;
      if (!linkDestinationStartsAt(tr.startState, ins.at)) return null;
      return { from: ins.at + 1, query: '', selected: 0, files: null, session: ++sessions };
    }
    if (tr.docChanged) value = { ...value, from: tr.changes.mapPos(value.from, -1) };
    const sel = state.selection;
    const head = sel.main.head;
    if (sel.ranges.length !== 1 || !sel.main.empty || head < value.from) return null;
    if (state.doc.sliceString(value.from - 1, value.from) !== '(') return null;
    if (state.doc.lineAt(head).number !== state.doc.lineAt(value.from).number) return null;
    const query = state.doc.sliceString(value.from, head);
    if (!validQuery(query)) return null;
    let files = value.files;
    let selected = query === value.query ? value.selected : 0;
    for (const e of tr.effects) {
      if (e.is(moveComplete)) selected = e.value;
      if (e.is(filesArrived) && e.value.session === value.session) files = e.value.files;
    }
    const next = { ...value, query, files, selected };
    const n = itemsFor(state, next).length;
    next.selected = n === 0 ? 0 : ((selected % n) + n) % n;
    return next;
  },
});

/** The open completion: what it offers and which row is highlighted, or null when nothing is open. */
export function linkCompletionOf(state: EditorState): { kind: 'file' | 'heading'; from: number; query: string; items: LinkCompletionItem[]; selected: number } | null {
  const value = state.field(completeField, false);
  if (!value) return null;
  return {
    kind: value.query.startsWith('#') ? 'heading' : 'file',
    from: value.from,
    query: value.query,
    items: itemsFor(state, value),
    selected: value.selected,
  };
}

/** The open completion when it has rows to show; the keys belong to it only then. */
function shown(state: EditorState): NonNullable<ReturnType<typeof linkCompletionOf>> | null {
  const c = linkCompletionOf(state);
  return c && c.items.length ? c : null;
}

/**
 * Write a picked row as the destination, replacing what was typed after the `(`,
 * and close the link with `)` unless one is already there. One undo step, kept
 * apart from the typing before it and after it.
 */
function accept(view: EditorView, index: number): boolean {
  const c = shown(view.state);
  const item = c?.items[index];
  if (!c || !item) return false;
  const head = view.state.selection.main.head;
  const closed = view.state.sliceDoc(head, head + 1) === ')';
  const insert = item.insert + (closed ? '' : ')');
  view.dispatch({
    changes: { from: c.from, to: head, insert },
    selection: { anchor: c.from + item.insert.length + 1 },
    effects: closeComplete.of(null),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  return true;
}

const completeKeymap = Prec.highest(
  keymap.of([
    {
      key: 'ArrowDown',
      run: (v) => {
        const c = shown(v.state);
        if (c) v.dispatch({ effects: moveComplete.of(c.selected + 1) });
        return c !== null;
      },
    },
    {
      key: 'ArrowUp',
      run: (v) => {
        const c = shown(v.state);
        if (c) v.dispatch({ effects: moveComplete.of(c.selected - 1) });
        return c !== null;
      },
    },
    { key: 'Enter', run: (v) => accept(v, shown(v.state)?.selected ?? -1) },
    { key: 'Tab', run: (v) => accept(v, shown(v.state)?.selected ?? -1) },
    {
      key: 'Escape',
      run: (v) => {
        if (!v.state.field(completeField, false)) return false;
        const visible = shown(v.state) !== null;
        v.dispatch({ effects: closeComplete.of(null) });
        // With nothing drawn there was nothing for Escape to close, so it carries on
        // to whatever else it means where the caret is.
        return visible;
      },
    },
  ])
);

/** Asks for the files when a list opens, and draws the open list next to the `(`. */
const completeView = ViewPlugin.fromClass(
  class {
    dom: HTMLElement | null = null;
    asked = 0;
    destroyed = false;
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate): void {
      const value = update.state.field(completeField, false);
      if (value && value.session !== this.asked && canListFiles()) {
        this.asked = value.session;
        const session = value.session;
        // Asked a turn later: an answer can arrive at once, and a view cannot be
        // dispatched to while it is still applying this update.
        void Promise.resolve()
          .then(requestFiles)
          .then((files) => {
            if (this.destroyed || !files || this.view.state.field(completeField, false)?.session !== session) return;
            this.view.dispatch({ effects: filesArrived.of({ session, files }) });
          });
      }
      if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.length) || update.geometryChanged) this.sync();
    }
    sync(): void {
      const c = shown(this.view.state);
      if (!c) {
        this.dom?.remove();
        this.dom = null;
        return;
      }
      if (!this.dom) {
        this.dom = document.createElement('div');
        this.dom.className = 'sheaf-slash-menu sheaf-link-complete';
        this.dom.setAttribute('role', 'listbox');
        document.body.appendChild(this.dom);
      }
      const dom = this.dom;
      dom.setAttribute('aria-label', c.kind === 'heading' ? 'Link to a heading' : 'Link to a file');
      dom.replaceChildren();
      c.items.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'sheaf-slash-item' + (index === c.selected ? ' is-selected' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === c.selected));
        const icon = document.createElement('span');
        icon.className = 'sheaf-slash-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = floatingIcon(item.level ? (`heading${item.level}` as FloatingIcon) : 'link');
        const label = document.createElement('span');
        label.className = 'sheaf-slash-label';
        label.textContent = item.label;
        label.title = item.label;
        row.append(icon, label);
        if (item.level) {
          // The anchor the pick writes, so the list teaches how a heading is linked.
          const hint = document.createElement('span');
          hint.className = 'sheaf-slash-hint';
          hint.setAttribute('aria-hidden', 'true');
          hint.textContent = item.insert;
          row.appendChild(hint);
        }
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          accept(this.view, index);
        });
        dom.appendChild(row);
      });
      this.view.requestMeasure({
        read: (view) => {
          try {
            return view.coordsAtPos(c.from);
          } catch {
            return null;
          }
        },
        write: (coords) => {
          if (coords && this.dom) placeListAt(this.dom, coords);
        },
      });
    }
    destroy(): void {
      this.destroyed = true;
      this.dom?.remove();
    }
  },
  {
    eventHandlers: {
      blur(_event, view) {
        if (view.state.field(completeField, false)) setTimeout(() => view.state.field(completeField, false) && view.dispatch({ effects: closeComplete.of(null) }), 0);
      },
    },
  }
);

export const linkComplete: Extension = [completeField, completeKeymap, completeView];
