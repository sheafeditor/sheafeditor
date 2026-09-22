/*
 * A view block: a fenced block with the language `view`, drawn as the grid its
 * query describes.
 *
 *     ```view
 *     from: #tasks
 *     where: status != Done
 *     sort: estimate desc
 *     ```
 *
 * The query is read by `viewQuery.ts`. What it reads from is either a named CSV
 * block in the same document (`from: #tasks`, see `dataBlocks` in tables.ts) or a
 * .csv or .tsv file beside the document (`from: data/tasks.csv`), which only the
 * host can read, so the file arrives by message and is kept here by its path.
 *
 * Nothing in the document changes by drawing a view. Off Sheaf the block is a
 * plain code block showing the query, which is the whole of what it holds.
 *
 * A cell edited in a view is written to the table the view reads, by the grid's
 * own writer, so it changes that one field and nothing else. A row added in a
 * filtered view starts with the values its `=` conditions ask for. A row that stops
 * matching after an edit stays where it was, marked, until the view is drawn again,
 * so an edit never makes the row being worked on vanish. Sorting a view orders what
 * it shows and never the table.
 *
 * `layout: board` with `group: <column>` draws the same rows as cards, in one
 * column per value of the grouping column. Moving a card to another column is an
 * edit of that one cell, written the same way.
 */

import { StateField, StateEffect, EditorState, Range, Extension, Prec, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { revealField } from './livePreview';
import {
  BareTable,
  bareTable,
  containerPrefix,
  dataBlocks,
  DataChange,
  dressTable,
  fenceLang,
  readDataBlock,
  readDataFile,
  TableData,
  viewReferences,
  writeDataBlock,
  writeDataFile,
} from './tables';
import { isolateHistory, undo as undoDocument, redo as redoDocument } from '@codemirror/commands';
import { BoardState, drawBoard as drawBoardLayout, wireBoard } from './board';
import {
  applyView,
  formatWhere,
  hideViewColumn,
  Operator,
  parseView,
  prefillFor,
  rowMatches,
  setSortKey,
  setViewKey,
  setWhereCondition,
  ViewError,
  ViewQuery,
} from './viewQuery';
import { minimalEdit, toWebviewText } from '../textSync';

// ---- Data files, through the host -------------------------------------------

/** What the page knows of one data file a view names, by the path as the view writes it. */
type FileState =
  | { status: 'waiting' }
  | { status: 'ready'; text: string; notice?: string }
  | { status: 'error'; message: string; missing?: boolean };

const files = new Map<string, FileState>();

/**
 * How long a file is waited for before the view says nothing came. A host that
 * cannot read files, such as a browser tab served from a folder, never answers,
 * and a view that said "Reading…" for ever would read as a hang.
 */
const DATA_FILE_WAIT_MS = 4000;

let post: ((message: unknown) => void) | null = null;
let asked = 0;
let waitMs = DATA_FILE_WAIT_MS;

/**
 * Where requests for data files go. Main wires this to the host. `wait` is how
 * long an answer is waited for, which only a test has reason to shorten.
 */
export function setDataFileHost(send: ((message: unknown) => void) | null, wait = DATA_FILE_WAIT_MS): void {
  post = send;
  waitMs = wait;
  files.clear();
  creating.clear();
  fileUndo.length = 0;
  fileRedo.length = 0;
  fileEditedLast = false;
}

/** The editors showing views, told when a file arrives. */
const editors = new Set<EditorView>();

/** A data file arrived, or changed, or could not be read. */
const filesChanged = StateEffect.define<null>();

function redraw(): void {
  // Deferred, because a request can be made while an editor is mid-update.
  queueMicrotask(() => {
    for (const view of editors) view.dispatch({ effects: filesChanged.of(null) });
  });
}

/** Ask the host for a data file, once. */
function requestFile(path: string): void {
  if (files.has(path)) return;
  if (!post) {
    files.set(path, { status: 'error', message: noHost(path) });
    redraw();
    return;
  }
  files.set(path, { status: 'waiting' });
  post({ type: 'dataFileRead', id: `data-${++asked}`, path });
  setTimeout(() => {
    if (files.get(path)?.status !== 'waiting') return;
    files.set(path, { status: 'error', message: noHost(path) });
    redraw();
  }, waitMs);
}

function noHost(path: string): string {
  return `This view reads ${path}, and nothing came back from the host for it. Only Sheaf in VS Code can read a data file for a view; here, name a CSV block in this document instead, as in "from: #tasks".`;
}

/** A file's text as the page keeps it: the webview's line endings, no byte-order mark. */
function pageText(text: string): string {
  const lf = toWebviewText(text);
  return lf.charCodeAt(0) === 0xfeff ? lf.slice(1) : lf;
}

/**
 * A data file from the host: in answer to a request, or because the file changed
 * on disk or in another editor. `text` is the file, or `error` says why there is
 * none, naming the path. `notice` is something to tell the reader alongside it,
 * such as an edit that could not be written.
 */
export function handleDataFile(message: { path?: unknown; text?: unknown; error?: unknown; notice?: unknown; missing?: unknown }): void {
  if (typeof message.path !== 'string') return;
  // A note comes with an edit, an undo or a redo the host refused. The steps kept for
  // that file were made against text it no longer holds, so they go.
  if (typeof message.notice === 'string') dropFileSteps(message.path);
  if (typeof message.text === 'string') {
    files.set(message.path, {
      status: 'ready',
      text: pageText(message.text),
      ...(typeof message.notice === 'string' ? { notice: message.notice } : {}),
    });
  } else {
    files.set(message.path, {
      status: 'error',
      message: typeof message.error === 'string' ? message.error : `${message.path} could not be read.`,
      ...(message.missing === true ? { missing: true } : {}),
    });
  }
  redraw();
}

// ---- Writing a new data file, through the host ------------------------------

/** What the host said about a file it was asked to write: the path it wrote, or why it wrote none. */
type Created = { path: string } | { error: string };

/** Requests to write a file that have not been answered yet, by id. */
const creating = new Map<string, (result: Created) => void>();
let createdSeq = 0;

/**
 * Ask the host to write a new file holding `text`, relative to the document. The
 * host never writes over a file: with `nextFree` it takes the next free name, and
 * without it the request is refused. Resolves with the path written or a reason.
 */
function createFile(path: string, text: string, nextFree: boolean): Promise<Created> {
  return new Promise((resolve) => {
    if (!post) {
      resolve({ error: 'Only Sheaf in VS Code can write a data file beside the document.' });
      return;
    }
    const id = `create-${++createdSeq}`;
    creating.set(id, resolve);
    post({ type: 'dataFileCreate', id, path, text, ...(nextFree ? { nextFree: true } : {}) });
    setTimeout(() => {
      if (!creating.delete(id)) return;
      resolve({ error: `Nothing came back from the host about ${path} in time. Check whether the file was written before trying again.` });
    }, waitMs);
  });
}

/** The host's answer to a request to write a file. */
export function handleDataFileCreated(message: { id?: unknown; path?: unknown; error?: unknown }): void {
  if (typeof message.id !== 'string') return;
  const done = creating.get(message.id);
  if (!done) return;
  creating.delete(message.id);
  done(
    typeof message.path === 'string'
      ? { path: message.path }
      : { error: typeof message.error === 'string' ? message.error : 'The file could not be written.' }
  );
}

/** How long a note about something just done stays on the page. An error stays until dismissed. */
const NOTE_MS = 8000;

/**
 * A short note at the foot of the editor about something a command just did, such
 * as the name a file was written under. One at a time; a newer note replaces it.
 */
function sayOnPage(view: EditorView, text: string, kind: 'note' | 'error' = 'note'): void {
  view.dom.querySelector('.sheaf-page-note')?.remove();
  const note = document.createElement('div');
  note.className = kind === 'error' ? 'sheaf-page-note is-error' : 'sheaf-page-note';
  note.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const words = document.createElement('span');
  words.textContent = text;
  note.append(words, button('sheaf-page-note-close', 'Dismiss', 'Dismiss this note', () => note.remove()));
  view.dom.appendChild(note);
  if (kind === 'note') setTimeout(() => note.remove(), NOTE_MS);
}

/** A fenced block's lines as they read outside its container, taken apart. */
interface FencedParts {
  bare: BareTable;
  /** The indentation before the opening fence, inside the container. */
  indent: string;
  /** The fence's run of backticks or tildes. */
  fence: string;
  /** The closing fence line as written, or null for a block left open to the end of the document. */
  close: string | null;
  /** The lines between the fences, each ending in a line break; empty when there are none. */
  body: string;
}

function fencedParts(text: string, prefix: string): FencedParts | null {
  const bare = bareTable(text, prefix);
  if (!bare) return null;
  const lines = bare.text.split('\n');
  const open = /^([ \t]*)(`{3,}|~{3,})/.exec(lines[0] ?? '');
  if (!open) return null;
  const last = lines.length - 1;
  const closed = last > 0 && /^\s*(`{3,}|~{3,})\s*$/.test(lines[last]);
  const inside = lines.slice(1, closed ? last : lines.length);
  return {
    bare,
    indent: open[1],
    fence: open[2],
    close: closed ? lines[last] : null,
    body: inside.length ? inside.join('\n') + '\n' : '',
  };
}

/** A fenced block with `lines` for its body, in the fence and container `parts` came from. */
function refenced(parts: FencedParts, prefix: string, info: string, lines: string[]): string {
  const { indent, fence } = parts;
  const bare = [indent + fence + info, ...lines.map((l) => (l ? indent + l : l)), parts.close ?? indent + fence].join('\n');
  return dressTable(parts.bare, bare, prefix);
}

/** A span of the document and what goes there. */
interface Replacement {
  from: number;
  to: number;
  insert: string;
}

/** Make `replacements` as one undo step, each changing only the characters that differ. */
function replaceAsOneStep(view: EditorView, replacements: Replacement[]): void {
  const changes = replacements
    .map(({ from, to, insert }) => {
      const edit = minimalEdit(view.state.sliceDoc(from, to), insert);
      return { from: from + edit.start, to: from + edit.end, insert: edit.replacement };
    })
    .sort((a, b) => a.from - b.from);
  view.dispatch({ changes, annotations: isolateHistory.of('full'), userEvent: 'input' });
}

/**
 * Move a CSV or TSV block's rows out to a file beside the document, and leave a
 * view of that file in the block's place, so the document reads as it did.
 *
 * The file holds the block's body byte for byte, named from the block's id
 * (`tasks.csv`), or `data.csv` for a block with none, and the host takes the next
 * free name rather than write over a file. The document is changed only once the
 * file is written, as one undo step. Undo brings the block back and leaves the
 * file where it is.
 */
export function moveBlockToFile(view: EditorView, from: number): void {
  if (view.state.readOnly) return;
  const block = dataBlocks(view.state).find((b) => b.from === from);
  if (!block) return;
  const text = view.state.sliceDoc(block.from, block.to);
  const parts = fencedParts(text, block.prefix);
  if (!parts) {
    sayOnPage(view, 'This block was not moved, because its lines are not all inside the list item or quote it starts in.', 'error');
    return;
  }
  const wanted = `${block.id ?? 'data'}.${block.lang}`;
  void createFile(wanted, parts.body, true).then((result) => {
    if ('error' in result) {
      sayOnPage(view, `The block was not moved. ${result.error}`, 'error');
      return;
    }
    const path = result.path;
    // Found again where it now is. A block that changed while the file was being
    // written is left alone, since the file no longer holds what it holds.
    const same = dataBlocks(view.state)
      .filter((b) => view.state.sliceDoc(b.from, b.to) === text)
      .sort((a, b) => Math.abs(a.from - from) - Math.abs(b.from - from))[0];
    if (!same || view.state.readOnly) {
      sayOnPage(view, `${path} was written, and the block was left in the document because it changed in the meantime.`, 'error');
      return;
    }
    // The view drawn in the block's place has its rows at once, and asks the host
    // for the file too, so it follows the file from now on.
    files.set(path, { status: 'ready', text: pageText(parts.body) });
    // Views that read the block by its name go on reading the same rows, from the
    // file now. Where two blocks share the name those views read neither, and are left.
    const readers = block.id && !block.duplicate ? viewReferences(view.state, block.id) : [];
    replaceAsOneStep(view, [
      { from: same.from, to: same.to, insert: refenced(parts, block.prefix, 'view', [`from: ${path}`]) },
      ...readers.map((r) => ({ from: r.from, to: r.to, insert: path })),
    ]);
    post?.({ type: 'dataFileRead', id: `data-${++asked}`, path });
    sayOnPage(
      view,
      path === wanted
        ? `Moved the rows to ${path}. The block is now a view of that file.`
        : `${wanted} already exists, so the rows went to ${path}. The block is now a view of that file.`
    );
  });
}

/** `wanted`, or `wanted-2`, `wanted-3` and so on, whichever no block in the document is named yet. */
function freeBlockName(state: EditorState, wanted: string): string {
  const taken = new Set(dataBlocks(state).flatMap((b) => (b.id ? [b.id.toLowerCase()] : [])));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; ; n++) if (!taken.has(`${wanted}-${n}`.toLowerCase())) return `${wanted}-${n}`;
}

/**
 * Why a view cannot be brought inline, or null when it can. Bringing a file in
 * copies every row of it, so a view that shows fewer rows, other columns or another
 * order would change what the page shows, and is left for its query to be taken out
 * first.
 */
function whyNotInline(q: ViewQuery, source: Source | null, readOnly: boolean): string | null {
  if (readOnly) return 'This document is read-only.';
  if (source?.kind !== 'file') return 'Only a view of a .csv or .tsv file that has been read can be brought inline.';
  const shaping = [q.where.length ? 'where' : '', q.sort.length ? 'sort' : '', q.show ? 'show' : '', q.layout === 'board' ? 'layout: board' : ''].filter(Boolean);
  if (shaping.length) {
    return `Bring inline copies the whole file as a table, so it is offered on a view with no ${shaping.join(', ')}. Take ${shaping.length === 1 ? 'that line' : 'those lines'} out of the query first.`;
  }
  return null;
}

/**
 * Replace a view of a file with a CSV or TSV block holding the file's rows, named
 * from the file (`tasks` for `data/tasks.csv`), or the next free name when a block
 * already has that one. The file is read as the page holds it, in the document's
 * line endings and without a byte-order mark. Nothing is deleted: the file stays
 * where it is. One undo step.
 */
function bringInline(view: EditorView, spec: ViewSpec): void {
  const source = spec.source;
  if (whyNotInline(spec.query, source, view.state.readOnly) || source?.kind !== 'file') return;
  const file = files.get(source.path);
  if (file?.status !== 'ready') return;
  const parts = fencedParts(view.state.sliceDoc(spec.from, spec.to), spec.prefix);
  if (!parts) return;
  const base = (source.path.split('/').pop() ?? '').replace(DATA_EXTENSION, '');
  const wanted = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'data';
  const id = freeBlockName(view.state, wanted);
  const rows = file.text.replace(/\n$/, '').split('\n');
  // A row that would read as the closing fence is kept inside by a longer fence.
  const mark = parts.fence[0];
  const longest = Math.max(0, ...rows.map((r) => (new RegExp(`^\\s*(\\${mark}{3,})\\s*$`).exec(r)?.[1].length ?? 0)));
  const fence = longest >= parts.fence.length ? mark.repeat(longest + 1) : parts.fence;
  const framed = fence === parts.fence ? parts : { ...parts, fence, close: null };
  replaceAsOneStep(view, [{ from: spec.from, to: spec.to, insert: refenced(framed, spec.prefix, `${langOf(source.path)} id=${id}`, rows) }]);
  if (id !== wanted) sayOnPage(view, `A block is already named ${wanted}, so this one is named ${id}.`);
}

/**
 * The columns a missing file is created with: the view's `show` columns, or with
 * no `show`, the columns its `where` and then its `sort` name, each once, in order.
 */
function columnsFor(q: ViewQuery): string[] {
  const names = q.show ?? [...q.where.map((w) => w.column), ...q.sort.map((s) => s.column)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const n = name.trim();
    if (n && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.push(n);
    }
  }
  return out;
}

/** A header row of `columns`, quoted where CSV needs it. */
function headerRow(columns: readonly string[], lang: 'csv' | 'tsv'): string {
  if (lang === 'tsv') return columns.join('\t');
  return columns.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');
}

/** Why the file a view names cannot be created from here, or null when it can. */
function whyNotCreate(q: ViewQuery, readOnly: boolean): string | null {
  if (readOnly) return 'This document is read-only.';
  if (!columnsFor(q).length) {
    return 'There are no columns to start the file with. Add a "show" line naming them, as in "show: feature, status", and create it then.';
  }
  return null;
}

/**
 * Create the file a view names and does not find, holding a header row of the
 * columns the view names. The host never writes over a file, so one that appeared
 * in the meantime is left as it is and the view shows it.
 */
function createMissing(view: EditorView, q: ViewQuery, path: string): void {
  if (whyNotCreate(q, view.state.readOnly)) return;
  const columns = columnsFor(q);
  const text = headerRow(columns, langOf(path)) + '\n';
  void createFile(path, text, false).then((result) => {
    if ('error' in result) {
      sayOnPage(view, `${path} was not created. ${result.error}`, 'error');
      return;
    }
    // The view draws the new file at once; the host also sends it, being told it now exists.
    files.set(path, { status: 'ready', text });
    redraw();
    sayOnPage(view, `Created ${path} with the columns ${columns.join(', ')}.`);
  });
}

// ---- Resolving a view's source ----------------------------------------------

/** Where a view's rows come from, as far as the page can tell right now. */
type Source =
  | { kind: 'block'; label: string; name: string; table: TableData }
  | { kind: 'file'; label: string; path: string; table: TableData; notice?: string }
  | { kind: 'waiting'; label: string; path: string }
  /** `missing` is the path of a file that is not there yet and may be created. */
  | { kind: 'none'; label: string; message: string; missing?: string };

const DATA_EXTENSION = /\.(csv|tsv)$/i;
const langOf = (path: string): 'csv' | 'tsv' => (/\.tsv$/i.test(path) ? 'tsv' : 'csv');

/** The blocks named `name`, compared without regard to case. */
function blocksNamed(blocks: ReturnType<typeof dataBlocks>, name: string): ReturnType<typeof dataBlocks> {
  const want = name.toLowerCase();
  return blocks.filter((b) => b.id && b.id.toLowerCase() === want);
}

function resolveSource(q: ViewQuery, state: EditorState, blocks: () => ReturnType<typeof dataBlocks>): Source | null {
  const from = q.from;
  if (!from) return null;
  if (from.startsWith('#')) {
    const name = from.slice(1).trim();
    const matches = blocksNamed(blocks(), name);
    if (!matches.length) {
      return {
        kind: 'none',
        label: from,
        message: `No CSV block in this document is named "${name}". Name one by writing id=${name || 'tasks'} after csv on its opening line, as in \`\`\`csv id=${name || 'tasks'}.`,
      };
    }
    if (matches.length > 1) {
      return {
        kind: 'none',
        label: from,
        message: `${matches.length} blocks in this document are named "${name}", so this view cannot tell which to read. Rename all but one.`,
      };
    }
    const table = readDataBlock(state, matches[0]);
    if (!table) return { kind: 'none', label: from, message: `The block named "${name}" has no header row to read.` };
    return { kind: 'block', label: from, name, table };
  }
  if (!DATA_EXTENSION.test(from)) {
    return {
      kind: 'none',
      label: from,
      message: `A view reads a CSV block in this document, as in "from: #tasks", or a .csv or .tsv file, as in "from: data/tasks.csv". "${from}" is neither.`,
    };
  }
  const file = files.get(from);
  if (!file || file.status === 'waiting') return { kind: 'waiting', label: from, path: from };
  if (file.status === 'error') {
    return { kind: 'none', label: from, message: file.message, ...(file.missing ? { missing: from } : {}) };
  }
  const table = readDataFile(file.text, langOf(from));
  if (!table) return { kind: 'none', label: from, message: `${from} is empty, so there is no header row to read.` };
  return { kind: 'file', label: from, path: from, table, ...(file.notice ? { notice: file.notice } : {}) };
}

// ---- Writing through a view -------------------------------------------------

/**
 * Write one change to the table a view reads. A block is changed in the document,
 * as the one range that differs, so it is one step of the document's undo history
 * and reaches the file the way typing does. A file goes to the host with the text
 * it was read as, and the page shows the edit at once. False when there is nothing
 * to write to, or the change writes nothing.
 */
function writeThrough(view: EditorView, source: Source, change: DataChange): boolean {
  if (view.state.readOnly) return false;
  if (source.kind === 'block') {
    const matches = blocksNamed(dataBlocks(view.state), source.name);
    if (matches.length !== 1) return false;
    const block = matches[0];
    const text = view.state.sliceDoc(block.from, block.to);
    const next = writeDataBlock(text, block.lang, block.prefix, change);
    if (next === text) return false;
    const edit = minimalEdit(text, next);
    view.dispatch({
      changes: { from: block.from + edit.start, to: block.from + edit.end, insert: edit.replacement },
      userEvent: 'input',
    });
    return true;
  }
  if (source.kind === 'file') {
    const file = files.get(source.path);
    if (file?.status !== 'ready' || !post) return false;
    const next = writeDataFile(file.text, langOf(source.path), change);
    if (next === file.text) return false;
    post({ type: 'dataFileEdit', path: source.path, base: file.text, text: next });
    fileUndo.push({ path: source.path, before: file.text, after: next });
    fileRedo.length = 0;
    fileEditedLast = true;
    files.set(source.path, { status: 'ready', text: next });
    // This editor is drawn now, so the view the person is typing in keeps up; any
    // other editor showing the file hears when the host sends it back.
    view.dispatch({ effects: filesChanged.of(null) });
    return true;
  }
  return false;
}

// ---- Undo and redo of edits to files ----------------------------------------

/*
 * An edit through a view of a block is a step of the document's own history, so
 * Cmd+Z takes it back like typing. An edit through a view of a file never touches
 * the document: it lands in the file's own history, in an editor the person is not
 * looking at. So the page keeps the file edits made during this visit, and Cmd+Z
 * takes the latest back while a view has the keyboard or a file edit was the last
 * thing done, then carries on into the document's history once there are none left.
 *
 * An undo is the edit's inverse, sent the way the edit was: the text before the edit
 * as the text, the text after it as the base. The host writes it only while the file
 * still holds that base, so an undo never writes over a change made since. A step
 * whose file changed since is dropped, with a note on the view saying so.
 */

/** A file edit made through a view: the file's text before and after, as the page holds it. */
interface FileStep {
  path: string;
  before: string;
  after: string;
}

const fileUndo: FileStep[] = [];
const fileRedo: FileStep[] = [];

/** True while a file edit, or the undo or redo of one, is the last thing the person did. */
let fileEditedLast = false;

/** Forget every step for `path`: the file holds something other than they were made against. */
function dropFileSteps(path: string): void {
  for (const stack of [fileUndo, fileRedo]) {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].path === path) stack.splice(i, 1);
  }
}

/**
 * Take back the latest file edit, or with `again` put back the latest one taken
 * back. False when there is none to take.
 */
function stepFile(view: EditorView, again: boolean): boolean {
  const step = (again ? fileRedo : fileUndo).pop();
  if (!step) return false;
  const [from, to] = again ? [step.before, step.after] : [step.after, step.before];
  const file = files.get(step.path);
  if (!post || file?.status !== 'ready' || file.text !== from) {
    // The file changed since the edit, so the host would refuse this. Say so here.
    dropFileSteps(step.path);
    if (file?.status === 'ready') {
      files.set(step.path, {
        status: 'ready',
        text: file.text,
        notice: `${again ? 'Redo' : 'Undo'} did not change ${step.path}, because it changed after your edit. The view shows the file as it is.`,
      });
    }
    view.dispatch({ effects: filesChanged.of(null) });
    return true;
  }
  post({ type: 'dataFileEdit', path: step.path, base: from, text: to, step: again ? 'redo' : 'undo' });
  (again ? fileUndo : fileRedo).push(step);
  fileEditedLast = true;
  files.set(step.path, { status: 'ready', text: to });
  view.dispatch({ effects: filesChanged.of(null) });
  return true;
}

/** Cmd+Z or Ctrl+Z is undo; with Shift, or Ctrl+Y off a Mac, it is redo. Null for any other key. */
function historyKey(e: KeyboardEvent): 'undo' | 'redo' | null {
  if (e.altKey) return null;
  if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) return e.shiftKey ? 'redo' : 'undo';
  if ((e.key === 'y' || e.key === 'Y') && e.ctrlKey && !e.metaKey && !e.shiftKey) return 'redo';
  return null;
}

/**
 * Cmd+Z or Cmd+Shift+Z pressed while a view has the keyboard: a file edit first,
 * then the document's history, as the tables' own undo carries on into it.
 */
function historyInView(view: EditorView, e: KeyboardEvent): void {
  const which = historyKey(e);
  if (!which) return;
  // The webview host passes keys that reach the window on to VS Code, which would
  // run its own undo as well; this one stops here.
  e.preventDefault();
  e.stopPropagation();
  const again = which === 'redo';
  if (stepFile(view, again)) return;
  if (again) redoDocument(view);
  else undoDocument(view);
}

/** Cmd+Z in the text takes back a file edit first while that was the last thing done. */
const historyInText = Prec.highest(
  EditorView.domEventHandlers({
    keydown: (e, view) => {
      const which = historyKey(e);
      if (!which || !fileEditedLast || !stepFile(view, which === 'redo')) return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
  })
);

/**
 * A change the person made to the document makes it the last thing edited, and one
 * that is not an undo or a redo leaves nothing of the files' to redo.
 */
function documentEdited(transactions: readonly Transaction[]): void {
  for (const tr of transactions) {
    if (!tr.docChanged || tr.annotation(Transaction.remote) || tr.annotation(Transaction.addToHistory) === false) continue;
    fileEditedLast = false;
    if (!tr.isUserEvent('undo') && !tr.isUserEvent('redo')) fileRedo.length = 0;
  }
}

// ---- Drawing ----------------------------------------------------------------

/** A view block's lines and query, as the decoration field found them. */
interface ViewSpec {
  from: number;
  to: number;
  /** The document line the body starts on, counted from one, for errors. */
  firstLine: number;
  /** Where the body's text is in the document, for the header's controls to rewrite a line of it. */
  body: { from: number; to: number } | null;
  /** The marks of the list item or quote the view sits in, on every line; empty at the margin. */
  prefix: string;
  query: ViewQuery;
  source: Source | null;
}

/** An error as a person reads it: the document line it is on, then what is wrong. */
function errorText(e: ViewError, firstLine: number): string {
  return e.line === null ? e.message : `Line ${firstLine + e.line}: ${e.message}`;
}

/** What a view shows is the query and the source; where each key sat is not part of it. */
const queryKey = (q: ViewQuery): string => JSON.stringify({ ...q, lines: undefined });

/**
 * The rows to show: the view's own, with each pinned row back where it was last
 * shown, or at the end for a row that was never shown (one just added).
 */
function withPinned(shown: number[], pinned: ReadonlySet<number>, last: readonly number[], total: number): number[] {
  const out = shown.filter((k) => !pinned.has(k));
  const pins = [...pinned]
    .filter((k) => k < total)
    .map((k) => ({ k, at: last.indexOf(k) }))
    .sort((a, b) => (a.at < 0 ? Infinity : a.at) - (b.at < 0 ? Infinity : b.at));
  for (const { k, at } of pins) {
    if (at < 0) out.push(k);
    else out.splice(Math.min(at, out.length), 0, k);
  }
  return out;
}

/** The row number a row started in the view and not yet written goes by. */
const NEW = -1;

const UNMATCHED_TITLE = 'This row no longer matches the view. It stays here until the view is drawn again.';

class ViewWidget extends WidgetType {
  readonly sig: string;
  constructor(readonly spec: ViewSpec) {
    super();
    this.sig = JSON.stringify({ line: spec.firstLine, query: queryKey(spec.query), source: spec.source, prefix: spec.prefix });
  }

  eq(other: ViewWidget): boolean {
    return other.sig === this.sig && other.spec.from === this.spec.from && other.spec.to === this.spec.to;
  }

  updateDOM(dom: HTMLElement): boolean {
    const repaint = live.get(dom);
    if (!repaint) return false;
    repaint(this.spec);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'sheaf-view';
    // The view stands in for the quote's lines, `>` and all, so it draws the quote's bar itself.
    if (this.spec.prefix.includes('>')) wrap.classList.add('is-quoted');
    let spec = this.spec;

    // ---- what this drawing of the view remembers ----
    /** Source rows edited or added here, kept in sight whether or not they still match. */
    const pinned = new Set<number>();
    /** The source rows in the order last shown. */
    let lastOrder: number[] = [];
    /** The source's rows when last drawn, to tell a change of someone else's from one of ours. */
    let lastRows: string | null = null;
    /** What the view was showing, by query and source; a different one starts afresh. */
    let lastKey = '';
    /** True while this view's own write is being drawn. */
    let writing = false;
    /** The cell picked, by source row and column. */
    let picked: { row: number; col: number } | null = null;
    /** A row started with + New row and not yet written: its cells, by source column. */
    let draft: string[] | null = null;
    /** The open cell, while one is being typed into. */
    let field: { input: HTMLTextAreaElement; row: number; col: number; before: string; done: boolean } | null = null;

    const head = document.createElement('div');
    head.className = 'sheaf-view-head';
    const badge = document.createElement('span');
    badge.className = 'sheaf-table-badge';
    badge.textContent = 'VIEW';
    const from = document.createElement('span');
    from.className = 'sheaf-view-from';
    const count = document.createElement('span');
    count.className = 'sheaf-view-count';
    const editQuery = button('sheaf-view-edit', 'Edit query', 'Show the view’s query as text, to change what it shows', () => {
      // The caret on the query's first line shows the block as text, the way a
      // table opens as its pipes.
      const line = view.state.doc.lineAt(spec.from);
      const body = line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1) : line;
      view.dispatch({ selection: { anchor: body.to }, scrollIntoView: true });
      view.focus();
    });
    // Offered on a view of a file: the file's rows, copied into the document as a block.
    const inline = button('sheaf-view-inline', 'Bring inline', '', () => {
      if (inline.getAttribute('aria-disabled') !== 'true') bringInline(view, spec);
    });
    inline.hidden = true;
    head.append(badge, from, count, inline, editQuery);

    const notes = document.createElement('div');
    notes.className = 'sheaf-view-notes';
    const frame = document.createElement('div');
    frame.className = 'sheaf-view-grid';
    const add = button('sheaf-view-add', '+ New row', 'Add a row to the table this view reads', () => addRow());
    add.hidden = true;

    const editable = (): boolean => !!spec.source && (spec.source.kind === 'block' || spec.source.kind === 'file') && !view.state.readOnly;

    /** Write one change, keeping `row` in sight whatever the view makes of it. */
    const write = (change: DataChange, row: number): boolean => {
      const source = spec.source;
      if (!source) return false;
      pinned.add(row);
      writing = true;
      try {
        if (writeThrough(view, source, change)) return true;
      } finally {
        writing = false;
      }
      return false;
    };

    /**
     * Start a new row: drawn under the last one with the values the view's `=`
     * conditions ask for, and open on the first column shown that they left empty.
     * Nothing is written until something is typed into it, so a row started and
     * left is not a blank record in the table.
     */
    const addRow = (): void => {
      const source = spec.source;
      if (!editable() || !source || (source.kind !== 'block' && source.kind !== 'file')) return;
      draft ??= prefillFor(spec.query, source.table.headers);
      paint(spec);
      const cols = shownColumns();
      const col = cols.find((c) => !draft![c]) ?? cols[0];
      if (col === undefined) return;
      pick(NEW, col);
      open();
    };

    /** Write the new row, with `value` typed into column `col`. Returns its row in the table. */
    const commitDraft = (col: number, value: string): number | null => {
      const source = spec.source;
      if (!draft || !source || (source.kind !== 'block' && source.kind !== 'file')) return null;
      const cells = [...draft];
      cells[col] = value;
      const row = source.table.rows.length;
      draft = null;
      return write({ append: cells }, row) ? row : null;
    };

    // A table's cell, or on a board the field of a card that shows that column.
    const cellAt = (row: number, col: number): HTMLElement | null =>
      frame.querySelector<HTMLElement>(`[data-row="${row}"] [data-c="${col}"]`);

    const pick = (row: number, col: number): void => {
      frame.querySelectorAll('.is-focus').forEach((el) => el.classList.remove('is-focus'));
      picked = { row, col };
      cellAt(row, col)?.classList.add('is-focus');
    };

    /** Open the picked cell for typing, holding what it holds now. */
    const open = (): void => {
      const source = spec.source;
      if (!picked || !editable() || !source || (source.kind !== 'block' && source.kind !== 'file')) return;
      const td = cellAt(picked.row, picked.col);
      if (!td) return;
      const { row, col } = picked;
      const before = (row === NEW ? draft?.[col] : source.table.rows[row]?.[col]) ?? '';
      const input = document.createElement('textarea');
      input.className = 'sheaf-view-input';
      input.value = before;
      input.rows = 1;
      input.setAttribute('aria-label', `${source.table.headers[col] ?? ''}, ${row === NEW ? 'new row' : `row ${row + 1}`}`);
      td.replaceChildren(input);
      const cell = { input, row, col, before, done: false };
      field = cell;
      const finish = (keep: boolean, next?: { row: number; col: number }): void => {
        if (cell.done) return;
        cell.done = true;
        field = null;
        const value = input.value;
        if (row === NEW) {
          if (keep && value !== before) {
            // Once written the new row is a row of the table, and moving on stays in it.
            const written = commitDraft(col, value);
            if (next && written !== null) next = { row: written, col: next.col };
          } else if (!(next && next.row === NEW)) {
            // Left without anything typed: the row was never written, so it goes.
            draft = null;
            paint(spec);
          } else {
            td.textContent = before;
          }
        } else if (keep && value !== before) {
          write({ row, col, value }, row);
        } else {
          td.textContent = before;
        }
        if (next) {
          pick(next.row, next.col);
          open();
        } else if (board) {
          // Back on the card, which the write may have drawn afresh.
          pickCard(row);
        } else {
          pick(row, col);
          table()?.focus({ preventScroll: true });
        }
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const cols = shownColumns();
          const at = cols.indexOf(col) + (e.shiftKey ? -1 : 1);
          finish(true, at >= 0 && at < cols.length ? { row, col: cols[at] } : undefined);
        }
      });
      input.addEventListener('blur', () => finish(true));
      input.focus();
      input.select?.();
    };

    const table = (): HTMLElement | null => frame.querySelector<HTMLElement>('table');
    // On a board, the fields of a card in the order it shows them, title first.
    const shownColumns = (): number[] =>
      board ? board.fields : Array.from(frame.querySelectorAll<HTMLElement>('thead th')).map((th) => Number(th.dataset.c));
    const shownRows = (): number[] =>
      Array.from(frame.querySelectorAll<HTMLElement>('tbody tr')).map((tr) => Number(tr.dataset.row));

    frame.addEventListener('mousedown', (e) => {
      const td = (e.target as HTMLElement).closest?.('td[data-c]') as HTMLElement | null;
      if (!td || (field && td.contains(field.input))) return;
      const tr = td.parentElement as HTMLElement;
      pick(Number(tr.dataset.row), Number(td.dataset.c));
    });
    frame.addEventListener('dblclick', (e) => {
      const td = (e.target as HTMLElement).closest?.('td[data-c]') as HTMLElement | null;
      if (!td || (field && td.contains(field.input))) return;
      const tr = td.parentElement as HTMLElement;
      pick(Number(tr.dataset.row), Number(td.dataset.c));
      open();
    });
    frame.addEventListener('keydown', (e) => {
      // The header's buttons take their own keys; Enter on one of them is a press.
      if (field || !picked || board || (e.target as HTMLElement).closest?.('thead')) return;
      const rows = shownRows();
      const cols = shownColumns();
      const r = rows.indexOf(picked.row);
      const c = cols.indexOf(picked.col);
      const move = (dr: number, dc: number): void => {
        const nr = rows[Math.max(0, Math.min(rows.length - 1, r + dr))];
        const nc = cols[Math.max(0, Math.min(cols.length - 1, c + dc))];
        if (nr !== undefined && nc !== undefined) pick(nr, nc);
      };
      const keys: Record<string, () => void> = {
        ArrowUp: () => move(-1, 0),
        ArrowDown: () => move(1, 0),
        ArrowLeft: () => move(0, -1),
        ArrowRight: () => move(0, 1),
        Enter: open,
        F2: open,
      };
      const run = keys[e.key];
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    });

    // ---- the header's controls ----
    /*
     * A table view's column headers carry its sort, and a menu for the column's
     * filter and for hiding it. Each control rewrites one part of one line of the
     * query, through `setSortKey`, `setWhereCondition` or `hideViewColumn`, which
     * leave every other part and every other line as the person wrote them. The
     * rewrite is one edit and one undo step, and the view is drawn again from the
     * query that then holds, so the query and what is shown never disagree.
     */
    /** The header menu open now: its element, and the button that opened it. */
    let headMenu: { el: HTMLElement; owner: HTMLButtonElement; close: (restore: boolean) => void } | null = null;

    /**
     * Rewrite the query's body with `change`, as one undo step, then hand the
     * keyboard to whatever `refocus` finds in the view drawn afresh, if the view had
     * it. False when there is nothing to rewrite or the change changes nothing.
     */
    const rewriteQuery = (change: (body: string) => string, refocus: () => HTMLElement | null): boolean => {
      const span = spec.body;
      if (!span || view.state.readOnly) return false;
      const body = view.state.sliceDoc(span.from, span.to);
      // In a list item or a quote the query is rewritten as it reads without the
      // container's marks, and every line goes back with them: its own marks for a
      // line that was there, the container's for a line the rewrite added.
      const bare = bareTable(body, spec.prefix);
      if (!bare) return false;
      const next = dressTable(bare, change(bare.text), spec.prefix);
      if (next === body) return false;
      const had = wrap.contains(document.activeElement);
      const edit = minimalEdit(body, next);
      view.dispatch({
        changes: { from: span.from + edit.start, to: span.from + edit.end, insert: edit.replacement },
        annotations: isolateHistory.of('full'),
        userEvent: 'input',
      });
      if (had) (refocus() ?? table())?.focus({ preventScroll: true });
      return true;
    };

    const headButton = (c: number, kind: 'sort' | 'filter'): HTMLButtonElement | null =>
      frame.querySelector<HTMLButtonElement>(`thead th[data-c="${c}"] .sheaf-view-${kind}`);

    /** A column's name as the query spells it: its header, trimmed. */
    const columnName = (c: number): string => (spec.source && 'table' in spec.source ? spec.source.table.headers[c] ?? '' : '').trim();
    /** A column as a person hears it named, for one with an empty header too. */
    const spoken = (c: number): string => columnName(c) || `Column ${c + 1}`;
    const named = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

    /**
     * A click on a header sorts by that column alone: A to Z, then Z to A, then not
     * at all. A Shift-click does the same to that one key where it stands in the
     * sort, or adds the column as the next key, and leaves the other keys alone.
     */
    const sortBy = (c: number, add: boolean): void => {
      const name = columnName(c);
      const keys = spec.query.sort;
      const key = keys.find((k) => named(k.column, name)) ?? null;
      const now = key ? (key.descending ? 'desc' : 'asc') : null;
      // A plain click on a column that is one key of several starts it afresh.
      const from = add || keys.length === 1 ? now : null;
      const next = from === null ? 'asc' : from === 'asc' ? 'desc' : null;
      rewriteQuery((body) => setSortKey(body, name, next, add), () => headButton(c, 'sort'));
    };

    /** The operators the menu offers. A condition written with another keeps it, added to the list. */
    const MENU_OPERATORS: readonly Operator[] = ['=', '!=', 'contains', 'is empty', 'is not empty'];
    const OPERATOR_NAMES: Partial<Record<Operator, string>> = {
      '=': 'is',
      '!=': 'is not',
      contains: 'contains',
      'is empty': 'is empty',
      'is not empty': 'is not empty',
    };

    const closeHeadMenu = (restore: boolean): void => headMenu?.close(restore);

    /** Open the menu for column `c`: its filter, and hiding it. */
    const openHeadMenu = (c: number, owner: HTMLButtonElement): void => {
      closeHeadMenu(false);
      const name = columnName(c);
      const label = spoken(c);
      const q = spec.query;
      const condition = q.where.find((w) => named(w.column, name)) ?? null;

      const el = document.createElement('div');
      el.className = 'sheaf-view-menu';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', `Filter ${label}`);
      const title = document.createElement('p');
      title.className = 'sheaf-view-menu-title';
      title.textContent = `Show rows where ${label}`;
      const op = document.createElement('select');
      op.className = 'sheaf-view-menu-op';
      op.setAttribute('aria-label', `Condition on ${label}`);
      const ops = condition && !MENU_OPERATORS.includes(condition.op) ? [...MENU_OPERATORS, condition.op] : MENU_OPERATORS;
      for (const o of ops) {
        const option = document.createElement('option');
        option.value = o;
        option.textContent = OPERATOR_NAMES[o] ?? o;
        op.appendChild(option);
      }
      op.value = condition?.op ?? '=';
      const value = document.createElement('input');
      value.type = 'text';
      value.className = 'sheaf-view-menu-value';
      value.setAttribute('aria-label', `Value for ${label}`);
      value.value = condition?.value ?? '';
      const needsValue = (): boolean => op.value !== 'is empty' && op.value !== 'is not empty';
      const syncValue = (): void => {
        value.hidden = !needsValue();
      };
      op.addEventListener('change', syncValue);
      syncValue();

      const menuButton = (cls: string, text: string, run: () => void, disabled = false, why = ''): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = text;
        if (disabled) {
          b.setAttribute('aria-disabled', 'true');
          b.classList.add('is-disabled');
          if (why) b.title = why;
        }
        b.addEventListener('click', () => {
          if (!disabled) run();
        });
        return b;
      };
      const apply = (): void => {
        const o = op.value as Operator;
        // An empty box with an operator that compares against it means no filter.
        const next = !needsValue() ? { op: o, value: '' } : value.value.trim() ? { op: o, value: value.value } : null;
        if (!rewriteQuery((body) => setWhereCondition(body, name, next), () => headButton(c, 'filter'))) close(true);
      };
      const shown = shownColumns();
      const actions = document.createElement('div');
      actions.className = 'sheaf-view-menu-actions';
      actions.append(menuButton('sheaf-view-menu-apply', 'Apply', apply));
      if (condition) {
        actions.append(
          menuButton('sheaf-view-menu-clear', 'Remove filter', () => {
            if (!rewriteQuery((body) => setWhereCondition(body, name, null), () => headButton(c, 'filter'))) close(true);
          })
        );
      }
      const columns = document.createElement('div');
      columns.className = 'sheaf-view-menu-actions';
      columns.append(
        menuButton(
          'sheaf-view-menu-hide',
          'Hide column',
          () => {
            const i = shown.indexOf(c);
            const neighbour = shown[i + 1] ?? shown[i - 1];
            const names = shown.map((k) => columnName(k));
            rewriteQuery((body) => hideViewColumn(body, name, names), () => (neighbour === undefined ? null : headButton(neighbour, 'sort')));
          },
          shown.length < 2,
          'A view shows at least one column.'
        )
      );
      if (q.show) {
        columns.append(
          menuButton('sheaf-view-menu-showall', 'Show all columns', () => {
            rewriteQuery((body) => setViewKey(body, 'show', null), () => headButton(c, 'sort'));
          })
        );
      }
      el.append(title, op, value, actions, columns);

      const onPress = (e: MouseEvent): void => {
        if (!el.isConnected) return document.removeEventListener('mousedown', onPress, true);
        const on = e.target as Node | null;
        if (on && (el.contains(on) || owner.contains(on))) return;
        close(false);
      };
      const close = (restore: boolean): void => {
        if (headMenu?.el !== el) return;
        headMenu = null;
        el.remove();
        document.removeEventListener('mousedown', onPress, true);
        owner.setAttribute('aria-expanded', 'false');
        if (restore && owner.isConnected) owner.focus({ preventScroll: true });
      };
      el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          close(true);
        } else if (e.key === 'Enter' && e.target === value) {
          e.preventDefault();
          apply();
        }
      });
      document.addEventListener('mousedown', onPress, true);
      headMenu = { el, owner, close };
      owner.setAttribute('aria-expanded', 'true');
      wrap.appendChild(el);
      // Under its header, measured against the view, which is where it is drawn.
      const at = owner.closest('th')?.getBoundingClientRect();
      const base = wrap.getBoundingClientRect();
      if (at) {
        el.style.left = `${Math.max(0, at.left - base.left)}px`;
        el.style.top = `${at.bottom - base.top + 2}px`;
      }
      op.focus({ preventScroll: true });
    };

    /** Give each header of a table view its sort button and its menu button. */
    const dressHeaders = (): void => {
      const q = spec.query;
      const locked = view.state.readOnly;
      for (const th of Array.from(frame.querySelectorAll<HTMLElement>('thead th'))) {
        const c = Number(th.dataset.c);
        const name = columnName(c);
        const label = spoken(c);
        const at = q.sort.findIndex((k) => named(k.column, name));
        const key = at >= 0 ? q.sort[at] : null;
        const condition = q.where.find((w) => named(w.column, name)) ?? null;
        const several = q.sort.length > 1;
        th.replaceChildren();
        th.setAttribute('aria-sort', key ? (key.descending ? 'descending' : 'ascending') : 'none');

        const sort = document.createElement('button');
        sort.type = 'button';
        sort.className = 'sheaf-view-sort';
        const text = document.createElement('span');
        text.className = 'sheaf-view-head-name';
        text.textContent = th.dataset.name ?? '';
        const mark = document.createElement('span');
        mark.className = 'sheaf-view-sort-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = key ? `${key.descending ? '↓' : '↑'}${several ? at + 1 : ''}` : '';
        sort.append(text, mark);
        const state = key
          ? `sorted ${key.descending ? 'Z to A' : 'A to Z'}${several ? `, sort key ${at + 1} of ${q.sort.length}` : ''}`
          : 'not sorted';
        sort.setAttribute('aria-label', `${label}, ${state}`);
        sort.title = `Sort by ${label}. Shift-click to sort by it as well as the columns already sorted.`;
        if (locked) sort.setAttribute('aria-disabled', 'true');
        sort.addEventListener('click', (e) => sortBy(c, e.shiftKey));

        const filter = document.createElement('button');
        filter.type = 'button';
        filter.className = condition ? 'sheaf-view-filter is-active' : 'sheaf-view-filter';
        filter.setAttribute('aria-haspopup', 'dialog');
        filter.setAttribute('aria-expanded', 'false');
        filter.setAttribute(
          'aria-label',
          `Filter or hide ${label}${condition ? `, filtered: ${formatWhere([condition])}` : ''}`
        );
        filter.title = condition ? `Filtered: ${formatWhere([condition])}` : `Filter or hide ${label}`;
        filter.textContent = '▾';
        if (locked) filter.setAttribute('aria-disabled', 'true');
        filter.addEventListener('click', () => {
          if (view.state.readOnly) return;
          if (headMenu?.owner === filter) return closeHeadMenu(true);
          openHeadMenu(c, filter);
        });
        th.append(sort, filter);
      }
    };

    // ---- the board layout ----
    /*
     * `layout: board` with `group: status` draws each row as a card in the column for
     * its status. Moving a card to another column writes that one cell of the row, by
     * the same writer as typing into it, so the table changes in one field and the
     * board is drawn again from what the table then holds.
     */
    /** The board drawn now: its grouping column, each board column's value, and a card's fields, title first. */
    let board: BoardState | null = null;

    // The cards' keys and dragging are the board module's, shared with a pipe table
    // shown as a board. A card's field open for typing has the keys to itself.
    const cards = wireBoard(frame, {
      current: () => (field ? null : board),
      editable,
      move: (row, value) => {
        const source = spec.source;
        if (!board || !source || (source.kind !== 'block' && source.kind !== 'file')) return;
        if ((source.table.rows[row]?.[board.group] ?? '').trim() === value) return;
        write({ row, col: board.group, value }, row);
      },
      open: (row, col) => {
        pick(row, col);
        open();
      },
    });
    /** Pick the card for `row` and give it the focus. */
    const pickCard = (row: number): void => cards.pickCard(row);
    const endCardDrag = (): void => cards.endDrag();

    /**
     * The board, in the view's order. While this view's own moves are being shown, a
     * column a card just left stays, so the next move can put it back.
     */
    const drawBoard = (
      headers: readonly string[],
      rows: readonly (readonly string[])[],
      columns: number[],
      group: number,
      order: number[],
      unmatched: ReadonlySet<number>
    ): HTMLElement => {
      const drawn = drawBoardLayout({
        headers,
        rows,
        columns,
        group,
        order,
        unmatched,
        unmatchedTitle: UNMATCHED_TITLE,
        keep: pinned.size && board?.group === group ? board.values : [],
        picked: cards.picked(),
      });
      board = drawn.state;
      return drawn.el;
    };

    const paint = (next: ViewSpec): void => {
      spec = next;
      const { query, source } = spec;
      from.textContent = source ? source.label : '';
      inline.hidden = source?.kind !== 'file';
      const notInline = whyNotInline(query, source, view.state.readOnly);
      inline.setAttribute('aria-disabled', String(!!notInline));
      inline.classList.toggle('is-disabled', !!notInline);
      inline.title =
        notInline ?? `Replace this view with a CSV block holding the rows of ${source?.label ?? 'its file'}. The file stays where it is.`;
      const key = JSON.stringify({ q: queryKey(query), label: source?.label ?? null });
      if (key !== lastKey) {
        pinned.clear();
        lastOrder = [];
        lastRows = null;
        draft = null;
      }
      lastKey = key;
      const messages: { text: string; kind: 'error' | 'note'; redraw?: boolean; create?: string }[] = [];
      for (const e of query.errors) messages.push({ text: errorText(e, spec.firstLine), kind: 'error' });
      if (source?.kind === 'none') messages.push({ text: source.message, kind: 'error', ...(source.missing ? { create: source.missing } : {}) });
      if (source?.kind === 'waiting') messages.push({ text: `Reading ${source.path}…`, kind: 'note' });
      if (source?.kind === 'file' && source.notice) messages.push({ text: source.notice, kind: 'error' });
      // A cell open while the table changed under it is about to be replaced. What was
      // typed is written once this redraw is over: this runs inside an editor update,
      // where the document cannot be changed.
      if (field && !field.done) {
        const typed = field;
        typed.done = true;
        field = null;
        if (typed.input.value !== typed.before) {
          const value = typed.input.value;
          queueMicrotask(() =>
            typed.row === NEW ? commitDraft(typed.col, value) : write({ row: typed.row, col: typed.col, value }, typed.row)
          );
        }
      }
      // A card being dragged is about to be drawn afresh, so its drag ends here, and
      // a header menu goes with the header it hangs from.
      endCardDrag();
      closeHeadMenu(false);
      frame.replaceChildren();
      count.textContent = '';
      add.hidden = true;
      if (source && (source.kind === 'block' || source.kind === 'file')) {
        const { headers, rows } = source.table;
        // A table that changed other than by this view's own write may have moved its
        // rows, so the rows kept in sight are let go.
        const rowsNow = JSON.stringify(rows);
        if (!writing && lastRows !== null && rowsNow !== lastRows) pinned.clear();
        lastRows = rowsNow;
        const result = applyView(query, headers, rows);
        for (const e of result.errors) messages.push({ text: errorText(e, spec.firstLine), kind: 'error' });
        const order = withPinned(result.rows, pinned, lastOrder, rows.length);
        lastOrder = order;
        const unmatched = new Set(
          order.filter((k) => pinned.has(k) && !rowMatches(query, headers, rows[k], { table: rows }))
        );
        if (unmatched.size) {
          const n = unmatched.size;
          messages.push({
            text: `${n === 1 ? 'A row you edited no longer matches' : `${n} rows you edited no longer match`} this view. ${n === 1 ? 'It stays' : 'They stay'} until the view is drawn again.`,
            kind: 'note',
            redraw: true,
          });
        }
        const matching = order.length - unmatched.size;
        count.textContent =
          matching === rows.length && !unmatched.size
            ? `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`
            : `${matching} of ${rows.length} rows`;
        // A board needs its grouping column. When the query names one the table does
        // not have, the error above says so and the rows are shown as a table.
        const group = query.layout === 'board' ? result.group : null;
        if (group !== null) {
          const drawn = drawBoard(headers, rows, result.columns, group, order, unmatched);
          frame.appendChild(drawn);
          // A board adds no rows of its own: a new row starts in the table layout.
          add.hidden = true;
        } else {
          board = null;
          frame.appendChild(drawTable(headers, rows, result.columns, order, unmatched, draft));
          dressHeaders();
          add.hidden = !editable();
          if (picked) cellAt(picked.row, picked.col)?.classList.add('is-focus');
        }
      } else {
        board = null;
      }
      notes.replaceChildren(
        ...messages.map((m) => {
          const p = document.createElement('p');
          p.className = m.kind === 'error' ? 'sheaf-view-error' : 'sheaf-view-note';
          if (m.kind === 'error') p.setAttribute('role', 'alert');
          p.textContent = m.text;
          if (m.redraw) {
            p.append(
              ' ',
              button('sheaf-view-redraw', 'Draw again', 'Show only the rows this view keeps', () => {
                pinned.clear();
                paint(spec);
              })
            );
          }
          if (m.create) {
            const path = m.create;
            const why = whyNotCreate(spec.query, view.state.readOnly);
            const columns = columnsFor(spec.query);
            const create = button(
              'sheaf-view-create',
              `Create ${path}`,
              why ?? `Write a new ${path} whose header row is ${columns.join(', ')}. No file is written over.`,
              () => {
                if (create.getAttribute('aria-disabled') !== 'true') createMissing(view, spec.query, path);
              }
            );
            create.setAttribute('aria-disabled', String(!!why));
            create.classList.toggle('is-disabled', !!why);
            p.append(' ', create);
          }
          return p;
        })
      );
      notes.hidden = messages.length === 0;
    };
    // Undo and redo from anywhere in the view but an open cell, whose box keeps its own.
    wrap.addEventListener('keydown', (e) => historyInView(view, e));

    paint(spec);
    live.set(wrap, paint);
    wrap.append(head, notes, frame, add);
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Each drawn view's repaint, so a rebuilt decoration redraws the grid already there. */
const live = new WeakMap<HTMLElement, (spec: ViewSpec) => void>();

function button(className: string, label: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.title = title;
  // Keep focus where it is, so pressing a view's button never moves the caret.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', run);
  return b;
}

function drawTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  columns: number[],
  shown: number[],
  unmatched: ReadonlySet<number>,
  draft: readonly string[] | null
): HTMLElement {
  const table = document.createElement('table');
  table.tabIndex = 0;
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = headers[c] ?? '';
    th.dataset.c = String(c);
    th.dataset.name = headers[c] ?? '';
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  for (const r of shown) {
    const tr = document.createElement('tr');
    tr.dataset.row = String(r);
    if (unmatched.has(r)) {
      tr.classList.add('is-unmatched');
      tr.title = UNMATCHED_TITLE;
    }
    for (const c of columns) {
      const td = document.createElement('td');
      td.textContent = rows[r][c] ?? '';
      td.dataset.c = String(c);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  if (draft) {
    const tr = document.createElement('tr');
    tr.dataset.row = String(NEW);
    tr.className = 'is-draft';
    tr.title = 'A new row. It is added to the table once you type into it.';
    for (const c of columns) {
      const td = document.createElement('td');
      td.textContent = draft[c] ?? '';
      td.dataset.c = String(c);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  if (!shown.length && !draft) {
    const empty = document.createElement('p');
    empty.className = 'sheaf-view-empty';
    empty.textContent = rows.length ? 'No row matches this view.' : 'The table has no rows yet.';
    const box = document.createElement('div');
    box.append(table, empty);
    return box;
  }
  return table;
}

// ---- The field ----------------------------------------------------------------

/** Every view block that is not showing its source, as widgets, and the files they want. */
function buildViews(state: EditorState): { decos: DecorationSet; wanted: string[] } {
  const decos: Range<Decoration>[] = [];
  const wanted: string[] = [];
  const doc = state.doc;
  const reveal = state.field(revealField, false);
  let blocks: ReturnType<typeof dataBlocks> | null = null;
  const allBlocks = (): ReturnType<typeof dataBlocks> => (blocks ??= dataBlocks(state));

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      const open = doc.lineAt(node.from);
      if (fenceLang(doc.sliceString(node.from, open.to)) !== 'view') return false;
      // A view inside a list item or a quote carries the container's marks on every
      // line, and is read with them taken off, as a CSV block there is. Anything else
      // before the fence on its line, such as a list bullet, leaves it as text.
      const prefix = containerPrefix(open.text, node.from - open.from, false);
      if (node.from !== open.from && !prefix) return false;
      const from = open.from;
      const last = doc.lineAt(Math.max(node.from, node.to - 1));
      const to = last.to;
      if (reveal && reveal.from <= to && reveal.to >= from) return false;
      for (const r of state.selection.ranges) if (r.empty && r.head > from && r.head < to) return false;
      // A line that has left the quote is not part of the view, so it stays as text.
      const bare = bareTable(doc.sliceString(from, to), prefix);
      if (!bare) return false;
      const lines = bare.text.split('\n');
      const closed = lines.length > 1 && /^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1]);
      const bodyFrom = open.number + 1;
      const bodyTo = closed ? last.number - 1 : last.number;
      const span = bodyFrom <= bodyTo ? { from: doc.line(bodyFrom).from, to: doc.line(bodyTo).to } : null;
      const body = lines.slice(1, closed ? lines.length - 1 : lines.length).join('\n');
      const query = parseView(body);
      const source = resolveSource(query, state, allBlocks);
      if (source?.kind === 'waiting') wanted.push(source.path);
      decos.push(
        Decoration.replace({
          widget: new ViewWidget({ from, to, firstLine: bodyFrom, body: span, prefix, query, source }),
          block: true,
        }).range(from, to)
      );
      return false;
    },
  });
  return { decos: Decoration.set(decos, true), wanted };
}

const viewField = StateField.define<{ decos: DecorationSet; wanted: string[] }>({
  create: (state) => buildViews(state),
  update(value, tr) {
    const redrawn = tr.effects.some((e) => e.is(filesChanged));
    if (!tr.docChanged && !redrawn && tr.state.field(revealField, false) === tr.startState.field(revealField, false) && !tr.selection) {
      return value;
    }
    return buildViews(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

/** Asks the host for the files the views want, and hears when they arrive. */
const fileRequests = ViewPlugin.define((view) => {
  editors.add(view);
  const ask = (): void => view.state.field(viewField).wanted.forEach(requestFile);
  ask();
  return {
    update: (update) => {
      documentEdited(update.transactions);
      ask();
    },
    destroy: () => {
      editors.delete(view);
    },
  };
});

/** Views drawn as grids. */
export const viewBlocks: Extension = [viewField, fileRequests, historyInText];
