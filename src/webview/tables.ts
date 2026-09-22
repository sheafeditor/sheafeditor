/*
 * Table rendering + spreadsheet-style editing — GFM pipe tables and ```csv/tsv
 * data blocks.
 *
 * Unlike the inline decorations in livePreview.ts (a ViewPlugin, limited to
 * within-line replacements), a rendered table spans many source lines and must
 * be replaced by a single *block* widget. Block/multi-line replace decorations
 * are only allowed from a StateField, so this lives in its own field, layered
 * alongside livePreview.
 *
 * Editing model:
 *   The grid behaves like a small spreadsheet. Cells, rows, columns, and the
 *   whole table can be *selected* (click a cell, a header to pick a column, the
 *   row gutter to pick a row, the corner to pick everything; drag or Shift-click
 *   for a range; arrow keys to move). A selected cell edits on Enter / F2 /
 *   double-click / typing.
 *
 *   Copy / Cut / Paste use the native clipboard events on a user gesture, so a
 *   selection round-trips as TSV (Excel / Google Sheets paste straight in, and
 *   pasting their data back expands the grid). All of this mutates an in-memory
 *   model, updates the DOM directly, and is written to the document as each
 *   change is made: a committed cell edit, a row or column action, a paste. The
 *   write keeps every untouched row, cell and delimiter byte-identical, padding
 *   included: a changed cell is spliced into its own segment, and only rows or
 *   columns added in the session are generated. A table that was only clicked
 *   through is not written at all. Undo and redo are the document's history.
 *
 *   The grid survives its own writes, undo and outside edits: CodeMirror hands
 *   the live DOM to the rebuilt widget (`updateDOM`), which takes the table's new
 *   text and keeps the selection, focus and a cell still being typed into.
 */

import { StateField, StateEffect, EditorState, EditorSelection, Range, Prec, Extension, Transaction, ChangeDesc } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { undo as undoDocument, redo as redoDocument, undoDepth, redoDepth, isolateHistory, invertedEffects } from '@codemirror/commands';
import type { SearchQuery } from '@codemirror/search';
import { revealField, setReveal } from './livePreview';
import { resolveImageSrc } from './images';
import { openLink } from './linkTarget';
import { CellEditor, createCellEditor } from './cellEditor';
import { ColumnLayout, createColumnLayout, digest } from './columnLayout';
import { ColumnExtent, COLUMN_CAP_FRACTION, COLUMN_FLOOR_CH, allocateColumnWidths } from './columnWidths';
import { TableIcon, tableIcon } from './tableIcons';
import { arrivedLines } from './changeMarks';
import { columnDateOrder, dateValue, leadingNumber, wholeNumber } from './cellNumbers';
import { BoardState, drawBoard as drawBoardLayout, wireBoard } from './board';

export type Align = 'left' | 'center' | 'right' | null;

export interface TableData {
  headers: string[];
  aligns: Align[];
  rows: string[][];
}

// ---- Parsing --------------------------------------------------------------

/** Split one pipe-table row into trimmed cells, honoring `\|` escapes. */
function splitPipeRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  const s = line.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/** Read column alignment from a delimiter cell like `:--`, `:-:`, `--:`. */
function parseAlign(cell: string): Align {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** Parse a GFM pipe table's raw text into header/alignment/rows, or null. */
function parsePipeTable(text: string): TableData | null {
  const lines = text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l.trim() === ''));
  if (lines.length < 2) return null;
  const delim = splitPipeRow(lines[1]);
  if (!delim.length || !delim.every((c) => /^:?-+:?$/.test(c.trim()))) return null;
  const headers = splitPipeRow(lines[0]);
  const aligns = delim.map(parseAlign);
  const rows = lines
    .slice(2)
    .filter((l) => l.trim() !== '')
    .map((l) => splitPipeRow(l));
  return { headers, aligns, rows };
}

/**
 * One line of a delimited block: its cells, its source text, and where it starts.
 * A parse is shared by everyone who asks for the same text (see `parseDelimitedRows`),
 * so nothing may change a row or its arrays; copy the cells before handing them on.
 */
interface DelimitedRow {
  readonly cells: readonly string[];
  /**
   * Where each field's source text sits in the parsed text, quotes and all, as
   * pairs of offsets: field `c` runs from `fields[2c]` to `fields[2c + 1]`. Kept as
   * offsets so a parse costs no string per field; `fieldSources` slices them for
   * the writer, which puts an untouched field back as it was written.
   */
  readonly fields: readonly number[];
  readonly raw: string;
  readonly start: number;
  /** A wholly blank line. It carries no delimiter, so it is not a record. */
  readonly blank: boolean;
}

/** A line holding no delimiter and nothing but whitespace is blank, not an empty record. */
const isBlankRecord = (cells: readonly string[]): boolean => cells.length === 1 && cells[0].trim() === '';

/** Each field's source text in `row`, read from the text it was parsed from. */
const fieldSources = (text: string, row: DelimitedRow): string[] => {
  const out: string[] = [];
  for (let i = 0; i < row.fields.length; i += 2) out.push(text.slice(row.fields[i], row.fields[i + 1]));
  return out;
};

let delimitedParses = 0;
/**
 * How many times delimited text has been read field by field since this module
 * loaded. The tables suite reads it to keep opening a block linear in its size.
 */
export const delimitedParseCount = (): number => delimitedParses;

/*
 * The last few texts parsed, with their rows. Opening a grid reads the same block
 * from several places (drawing it, finding each row's line, marking changed rows),
 * and a large block is worth reading once. A handful of entries is enough: the
 * callers ask for the body with and without its closing fence, and a paste reads
 * the clipboard in between.
 */
const recentParses: { text: string; delim: string; rows: readonly DelimitedRow[] }[] = [];
const RECENT_PARSES = 4;

/**
 * Parse delimited (CSV/TSV) text into rows of cells, each with its source text.
 * The rows are shared with every other caller that parses the same text, so they
 * are read, never changed.
 */
function parseDelimitedRows(text: string, delim: string): readonly DelimitedRow[] {
  for (const p of recentParses) if (p.delim === delim && p.text === text) return p.rows;
  const rows = readDelimitedRows(text, delim);
  recentParses.unshift({ text, delim, rows });
  if (recentParses.length > RECENT_PARSES) recentParses.pop();
  return rows;
}

function readDelimitedRows(text: string, delim: string): DelimitedRow[] {
  delimitedParses++;
  const rows: DelimitedRow[] = [];
  let row: string[] = [];
  let fields: number[] = [];
  let cur = '';
  let inQuotes = false;
  let start = 0;
  let fieldStart = 0;
  // A field's source runs to the delimiter or line end, without a line end's `\r`.
  const endField = (end: number): void => {
    fields.push(fieldStart, end > fieldStart && text.charCodeAt(end - 1) === 13 ? end - 1 : end);
  };
  // True while nothing has been read into the field yet. A quote opens a quoted
  // field only there; later in a field it is literal data, the way a spreadsheet
  // reads it, so `27" monitor` keeps its inch mark and the rows below it stay
  // separate records.
  let fresh = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"' && fresh) {
      inQuotes = true;
      fresh = false;
    } else if (ch === delim) {
      row.push(cur);
      endField(i);
      cur = '';
      fresh = true;
      fieldStart = i + 1;
    } else if (ch === '\n') {
      row.push(cur);
      endField(i);
      rows.push({ cells: row, fields, raw: text.slice(start, i), start, blank: isBlankRecord(row) });
      row = [];
      fields = [];
      cur = '';
      start = i + 1;
      fieldStart = i + 1;
      fresh = true;
    } else if (ch !== '\r') {
      cur += ch;
      fresh = false;
    }
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    endField(text.length);
    rows.push({ cells: row, fields, raw: text.slice(start), start, blank: isBlankRecord(row) });
  }
  return rows;
}

const recentRecords = new WeakMap<readonly DelimitedRow[], readonly DelimitedRow[]>();
/**
 * The records of a delimited block: every line except the wholly blank ones. A
 * record whose fields are all empty (`,`) is still a record, and the grid gives it
 * a row; a blank line is neither, and the writer keeps it where it sits.
 */
function delimitedRecords(text: string, delim: string): readonly DelimitedRow[] {
  const rows = parseDelimitedRows(text, delim);
  let records = recentRecords.get(rows);
  if (!records) recentRecords.set(rows, (records = rows.filter((r) => !r.blank)));
  return records;
}

/** Parse delimited (CSV/TSV) text, honoring `"`-quoted fields with escapes. */
function parseDelimited(text: string, delim: string): string[][] {
  return delimitedRecords(text, delim).map((r) => r.cells.slice());
}

/** Strip the opening/closing fence lines from a fenced code block's raw text. */
function fenceBody(text: string): string {
  const lines = text.split('\n');
  if (lines.length && /^\s*(`{3,}|~{3,})/.test(lines[0])) lines.shift();
  if (lines.length && /^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}

/** The whole info string of a fenced code block, as written. */
function fenceInfoRaw(text: string): string {
  const m = /^\s*(?:`{3,}|~{3,})[ \t]*([^\n`]*)/.exec(text);
  return m ? m[1].trim() : '';
}

/**
 * The language of a fenced code block, lowercased: the first word of its info
 * string, the way every Markdown tool reads it. The rest of the line is for other
 * things, such as the name in ```` ```csv id=tasks ````.
 */
export function fenceLang(text: string): string {
  return fenceInfoRaw(text).split(/[ \t]+/)[0].toLowerCase();
}

/**
 * The name a data block's info string gives it, `tasks` in ```` ```csv id=tasks ````,
 * as written. Null when it has none. A view reads the block by this name
 * (`from: #tasks`), matching it without regard to case.
 */
export function fenceId(text: string): string | null {
  const words = fenceInfoRaw(text).split(/[ \t]+/).slice(1);
  for (const w of words) {
    const m = /^id=([A-Za-z0-9_-]+)$/.exec(w);
    if (m) return m[1];
  }
  return null;
}

/** A ```csv or ```tsv block in a document, named or not. */
export interface DataBlock {
  /** Its name, as written, or null. */
  id: string | null;
  lang: 'csv' | 'tsv';
  /** The whole lines the block covers, container marks included. */
  from: number;
  to: number;
  /** The marks of the list item or blockquote it sits in (see `bareTable`). */
  prefix: string;
  /** True when another block in the document has the same name. */
  duplicate: boolean;
}

/** Every ```csv and ```tsv block in the document, in order, with duplicate names marked. */
export function dataBlocks(state: EditorState): DataBlock[] {
  const out: DataBlock[] = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      const open = doc.sliceString(node.from, doc.lineAt(node.from).to);
      const lang = fenceLang(open);
      if (lang !== 'csv' && lang !== 'tsv') return false;
      const line = doc.lineAt(node.from);
      out.push({
        id: fenceId(open),
        lang,
        from: line.from,
        to: doc.lineAt(Math.max(node.from, node.to - 1)).to,
        prefix: containerPrefix(line.text, node.from - line.from, false),
        duplicate: false,
      });
      return false;
    },
  });
  const counts = new Map<string, number>();
  for (const b of out) if (b.id) counts.set(b.id.toLowerCase(), (counts.get(b.id.toLowerCase()) ?? 0) + 1);
  for (const b of out) b.duplicate = !!b.id && (counts.get(b.id.toLowerCase()) ?? 0) > 1;
  return out;
}

/** The header and rows of a data block, as the grid reads them; null when it reads as none. */
export function readDataBlock(state: EditorState, block: DataBlock): TableData | null {
  const bare = bareTable(state.doc.sliceString(block.from, block.to), block.prefix);
  if (!bare) return null;
  const grid = parseDelimited(fenceBody(bare.text), block.lang === 'tsv' ? '\t' : ',');
  if (!grid.length) return null;
  const [headers, ...rows] = grid;
  return { headers, aligns: headers.map(() => null), rows };
}

/** One change a view makes to the table it reads. */
export type DataChange = { row: number; col: number; value: string } | { append: string[] };

/**
 * A data block's text with one change made, written the way the grid writes it:
 * every line the change does not touch keeps its bytes, and an edited field is the
 * only field of its record that is written anew.
 */
export function writeDataBlock(text: string, lang: 'csv' | 'tsv', prefix: string, change: DataChange): string {
  const bare = bareTable(text, prefix);
  if (!bare) return text;
  const grid = parseDelimited(fenceBody(bare.text), lang === 'tsv' ? '\t' : ',');
  if (!grid.length) return text;
  const [headers, ...body] = grid;
  const orig: TableData = { headers, aligns: headers.map(() => null), rows: body };
  const d = cloneTable(orig);
  const rows: Origin = d.rows.map((_, i) => i);
  if ('append' in change) {
    d.rows.push(headers.map((_, c) => change.append[c] ?? ''));
    rows.push(null);
  } else {
    if (!d.rows[change.row] || change.col < 0 || change.col >= headers.length) return text;
    const row = d.rows[change.row];
    while (row.length <= change.col) row.push('');
    row[change.col] = change.value;
  }
  const cols: Origin = headers.map((_, i) => i);
  return dressTable(bare, writeCsv(bare.text, orig, d, rows, cols, lang), prefix);
}

/**
 * The same, for the text of a .csv or .tsv file rather than a block in a document.
 * The file is framed as a block for the writer and taken out of the frame again,
 * so a file and a block are written by the one writer.
 */
export function writeDataFile(text: string, lang: 'csv' | 'tsv', change: DataChange): string {
  const open = '```' + lang + '\n';
  const close = '\n```';
  const out = writeDataBlock(open + text + close, lang, '', change);
  return out.startsWith(open) && out.endsWith(close) ? out.slice(open.length, out.length - close.length) : text;
}

/** The header and rows of a .csv or .tsv file's text; null when it holds no record. */
export function readDataFile(text: string, lang: 'csv' | 'tsv'): TableData | null {
  const grid = parseDelimited(text, lang === 'tsv' ? '\t' : ',');
  if (!grid.length) return null;
  const [headers, ...rows] = grid;
  return { headers, aligns: headers.map(() => null), rows };
}

// ---- Container marks ------------------------------------------------------
//
// A table inside a list item or a blockquote carries its container's marks at the
// start of every line: the item's indentation, or `> `. They belong to the
// container, not to the table, so the grid reads and writes the table with them
// taken off, and every line written goes back into the container with them put on.
// A generated line that lacked them would end the container there and cut the
// table short.

/** A table's text with the container's marks taken off each line. */
export interface BareTable {
  /** The table's text as it would read outside the container. */
  text: string;
  /** The source lines, marks included. */
  raw: string[];
  /** How many characters were taken off the front of each line. */
  cut: number[];
}

/**
 * Take the container's `prefix` off every line of `src`: the text between the
 * start of the table's first line and the table itself. Indentation is taken off
 * up to its width, the way CommonMark reads the lines of a block in a list item. A
 * quote mark has to be there on every line: a line without it is not in the quote,
 * so the table is not one the grid can write back, and null leaves it as text. A
 * line holding only the marks is blank, and keeps whatever space follows them.
 */
export function bareTable(src: string, prefix: string): BareTable | null {
  const raw = src.split('\n');
  if (!prefix) return { text: src, raw, cut: raw.map(() => 0) };
  const spaces = /^[ \t]*$/.test(prefix);
  const mark = prefix.trimEnd();
  const cut: number[] = [];
  const lines: string[] = [];
  for (const line of raw) {
    let n: number;
    if (spaces) n = Math.min(prefix.length, /^[ \t]*/.exec(line)![0].length);
    else if (line.startsWith(prefix) && line.slice(prefix.length).trim() !== '') n = prefix.length;
    else if (line.startsWith(mark) && line.slice(mark.length).trim() === '') n = mark.length;
    else return null;
    cut.push(n);
    lines.push(line.slice(n));
  }
  return { text: lines.join('\n'), raw, cut };
}

/**
 * Put the container's marks back on the lines of `text`, written from `bare`. A
 * line that was already in the source gets its own marks back byte for byte, and
 * a new one gets the table's `prefix`, or just its quote mark when it is blank.
 */
export function dressTable(bare: BareTable, text: string, prefix: string): string {
  if (!prefix) return text;
  const lines = bare.text.split('\n');
  const kept = new Map<string, string[]>();
  lines.forEach((line, i) => {
    const at = kept.get(line);
    if (at) at.push(bare.raw[i]);
    else kept.set(line, [bare.raw[i]]);
  });
  return text
    .split('\n')
    .map((line) => kept.get(line)?.shift() ?? (line.trim() === '' ? prefix.trimEnd() + line : prefix + line))
    .join('\n');
}

/**
 * Offsets into the bare text as offsets into the source. The start of a line is
 * the start of its source line, marks and all, so a span of whole lines names the
 * whole lines in the file. The lines are walked once, so one table can have many
 * offsets converted, each by a binary search.
 */
function sourceOffsets(bare: BareTable): (offset: number) => number {
  const lines = bare.text.split('\n');
  const starts: number[] = [];
  const ends: number[] = [];
  const shifts: number[] = [];
  let at = 0;
  let shift = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(at);
    ends.push(at + lines[i].length);
    shifts.push(shift);
    at += lines[i].length + 1;
    shift += bare.cut[i];
  }
  return (offset) => {
    // The first line that `offset` does not run past, or the last line.
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offset <= ends[mid]) hi = mid;
      else lo = mid + 1;
    }
    return offset + shifts[lo] + (offset > starts[lo] ? bare.cut[lo] : 0);
  };
}

/** An offset into the source as an offset into the bare text; inside the marks is the start of the line. */
function bareOffset(bare: BareTable, offset: number): number {
  let at = 0;
  let out = 0;
  for (let i = 0; i < bare.raw.length; i++) {
    const len = bare.raw[i].length;
    if (offset <= at + len || i === bare.raw.length - 1) return out + Math.max(0, offset - at - bare.cut[i]);
    at += len + 1;
    out += len - bare.cut[i] + 1;
  }
  return out;
}

/**
 * The marks a table inside a container carries, read from its first line: the
 * text from the start of that line to where the table begins. A pipe table
 * already reads and writes its own indentation (see `splitRawRow`), so for one of
 * those only a quote mark counts. Anything else before the table, such as a list
 * bullet on the same line, is not taken off, and the table reads as it always has.
 */
export function containerPrefix(lineText: string, width: number, pipe: boolean): string {
  const prefix = lineText.slice(0, Math.max(0, width));
  if (!/^[ \t>]*$/.test(prefix)) return '';
  return pipe && !prefix.includes('>') ? '' : prefix;
}

/**
 * Parse clipboard text into a grid. A spreadsheet range arrives as lines of
 * tab-separated cells; any other text is a value per line, kept as written, so a
 * sentence with a comma or quotes lands in one cell and an empty line stays an
 * empty cell.
 */
/**
 * A copied range, as rows of cells. The clipboard's plain text for a range is
 * tab-separated, and a spreadsheet quotes a cell that holds a line break or a tab,
 * so the quotes are read when they wrap one (and when `fits` accepts that reading).
 * Anywhere else a quote is part of the value and stays.
 */
function parseClipboardGrid(raw: string, fits: (rows: string[][]) => boolean = () => true): string[][] {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
  // Every line is a row, an empty one included, as it is when the text is split.
  const quoted = parseDelimitedRows(text, '\t').map((r) => r.cells.slice());
  if (quoted.some((row) => row.some((cell) => /[\n\t]/.test(cell))) && fits(quoted)) return quoted;
  return text.split('\n').map((l) => l.split('\t'));
}

// ---- Inline markdown (cell display) ---------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape text for use in element content and in a double-quoted attribute. */
function escapeText(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

let entityProbe: HTMLTextAreaElement | null = null;

/** The character a named or numeric character reference stands for, or null when it names nothing. */
function decodeReference(ref: string): string | null {
  const num = /^&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));$/.exec(ref);
  if (num) {
    const code = num[1] !== undefined ? parseInt(num[1], 10) : parseInt(num[2], 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code);
  }
  // The browser knows every named reference; `ref` is only letters and digits
  // between & and ;, so nothing but the reference is parsed.
  entityProbe ??= document.createElement('textarea');
  entityProbe.innerHTML = ref;
  const text = entityProbe.value;
  return text === ref ? null : text;
}

/** `![alt](src "title")` at the start of what is left of a cell's source. */
const CELL_IMAGE = /^!\[([^\]]*)\]\(\s*([^()\s]*)(?:\s+"([^"]*)")?\s*\)/;

/**
 * The picture an image in a cell shows, drawn the way prose draws one inside a
 * line: the same elements and classes, so it is styled and marked broken by the
 * same rules. An address the webview may not load has no picture to show, so
 * the Markdown stays on screen, which is what prose leaves behind too.
 */
function imageHtml(source: string, alt: string, src: string, title?: string): string {
  const resolved = resolveImageSrc(src);
  if (!resolved) return escapeText(source);
  return (
    '<span class="md-img-wrap md-img-inline"><span class="md-img-fig">' +
    `<img class="md-img" src="${escapeText(resolved)}" alt="${escapeText(alt)}"` +
    (title ? ` title="${escapeText(title)}"` : '') +
    '></span></span>'
  );
}

/** The end of the run of backticks that starts at `at`. */
function backtickRun(src: string, at: number): number {
  let end = at;
  while (src[end] === '`') end++;
  return end;
}

/**
 * Where the next run of exactly `length` backticks at or after `from` starts, or
 * -1 when there is none. A longer or shorter run is skipped whole.
 */
function backtickRunOf(src: string, from: number, length: number): number {
  for (let i = src.indexOf('`', from); i >= 0; i = src.indexOf('`', i)) {
    const end = backtickRun(src, i);
    if (end - i === length) return i;
    i = end;
  }
  return -1;
}

/**
 * Render a cell's inline Markdown to HTML for display (bold/italic/strike/code/
 * links/images). Cells hold raw Markdown in the model and while editing; only
 * the rendered grid runs this. Code spans, backslash escapes, character
 * references and images are set aside first, so formatting never reads inside
 * them.
 */
function renderInline(src: string): string {
  // A pipe escaped for the table source is just a pipe on screen.
  src = src.replace(/\\\|/g, '|');
  // Pieces set aside from formatting: their display HTML, and their plain text for a link destination.
  const held: { html: string; text: string }[] = [];
  const hold = (html: string, text: string): string => `\u0000${held.push({ html, text }) - 1}\u0000`;
  let s = '';
  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && /[!-/:-@[-`{-~]/.test(src[i + 1])) {
      s += hold(escapeText(src[i + 1]), src[i + 1]);
      i += 2;
    } else if (ch === '!' && src[i + 1] === '[' && CELL_IMAGE.test(src.slice(i))) {
      // The picture stands for its alt text where the cell's source is read as
      // plain text, as it does in the destination of a link drawn around it.
      const [whole, alt, url, title] = CELL_IMAGE.exec(src.slice(i)) as RegExpExecArray;
      s += hold(imageHtml(whole, alt, url, title), alt);
      i += whole.length;
    } else if (ch === '`') {
      // A run of backticks opens a code span that the next run of exactly the same
      // length closes, as CommonMark reads it. With no such run it is plain text.
      const open = backtickRun(src, i);
      const close = backtickRunOf(src, open, open - i);
      if (close < 0) {
        s += src.slice(i, open);
        i = open;
        continue;
      }
      let code = src.slice(open, close);
      // One space comes off each end when both ends have one and it is not all
      // spaces, so a span can begin or end with a backtick: `` `x` `` is `x`.
      if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1);
      s += hold(`<code class="tok-inline-code">${escapeHtml(code)}</code>`, code);
      i = close + (open - i);
    } else if (ch === '&') {
      const ref = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(src.slice(i, i + 40));
      const text = ref ? decodeReference(ref[0]) : null;
      if (ref && text !== null) {
        s += hold(escapeText(text), text);
        i += ref[0].length;
      } else {
        s += ch;
        i++;
      }
    } else {
      s += ch;
      i++;
    }
  }
  const plain = (t: string): string => t.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => escapeText(held[Number(n)].text));
  s = escapeHtml(s);
  // GFM tables spell a line break inside a cell as <br>.
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, t: string, url: string) => `<span class="tok-link" data-href="${plain(url).replace(/"/g, '&quot;')}">${t}</span>`
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
  // Put the set-aside pieces back.
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => held[Number(n)].html);
  return s;
}

/** The link under a Cmd/Ctrl-click, if that is what the click was. */
function linkClicked(e: MouseEvent): HTMLElement | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  return ((e.target as Element | null)?.closest?.('[data-href]') as HTMLElement | null) ?? null;
}

// ---- Write-back (model -> source) ----------------------------------------
//
// A table is written as each change is made, and the write changes only what
// the change touched. Untouched rows and cells keep their source bytes,
// padding and all, so one edited cell is a one-line diff and two people editing
// different rows of a table merge cleanly (CLAUDE.md, "diff size is a
// correctness concern"). Realigning a table is never a side effect of editing.

/** Where each current row or column came from in the parsed table; null if added this session. */
type Origin = (number | null)[];

/**
 * The parsed column a column's cells come from. A column made by Duplicate column
 * is recorded as -(source + 1), so it writes its source column's segments.
 */
const columnSource = (o: number | null): number | null => (o === null ? null : o < 0 ? -o - 1 : o);

const isIdentity = (o: Origin, n: number): boolean =>
  o.length === n && o.every((v, i) => v === i);

/** Compare cell lists as a reader sees them: a missing trailing cell equals an empty one. */
function sameCells(a: readonly (string | null)[] = [], b: readonly (string | null)[] = []): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? '') !== (b[i] ?? '')) return false;
  }
  return true;
}

function sameTable(a: TableData, b: TableData): boolean {
  return (
    sameCells(a.headers, b.headers) &&
    sameCells(a.aligns, b.aligns) &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, i) => sameCells(row, b.rows[i]))
  );
}

function cloneTable(d: TableData): TableData {
  return { headers: [...d.headers], aligns: [...d.aligns], rows: d.rows.map((r) => [...r]) };
}

/** Sanitize a cell for pipe-table source: pipes escaped exactly once, no newlines. */
function pipeCell(s: string): string {
  return s
    .replace(/\\\||\|/g, (m) => (m === '|' ? '\\|' : m))
    .replace(/\n/g, ' ')
    .trim();
}

/** A pipe-table source line split into raw cell segments, whitespace intact. */
interface RawRow {
  prefix: string; // the line's indentation, and anything before a leading pipe
  lead: boolean;
  cells: string[];
  trail: boolean;
  suffix: string; // anything after a trailing pipe
}

/** Split a source line into the same cells `splitPipeRow` finds, keeping every byte. */
function splitRawRow(line: string): RawRow {
  // The indentation is the line's, never the first cell's. A table inside a list
  // item is indented, and where it also has no outer pipe there is no pipe to take
  // that indentation off the front of the first cell. It ended up inside the cell,
  // so a row generated in this row's style started at column zero and fell out of
  // the list item it belonged to.
  const indent = /^[ \t]*/.exec(line)![0];
  const parts: string[] = [];
  let cur = '';
  for (let i = indent.length; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += ch + line[i + 1];
      i++;
    } else if (ch === '|') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  const lead = parts.length > 0 && parts[0].trim() === '';
  const prefix = indent + (lead ? parts.shift()! : '');
  const trail = parts.length > 0 && parts[parts.length - 1].trim() === '';
  const suffix = trail ? parts.pop()! : '';
  return { prefix, lead, cells: parts, trail, suffix };
}

function joinRawRow(style: RawRow, cells: string[]): string {
  // A row written without an outer pipe still needs one beside a blank first or
  // last cell: GFM reads a pipe followed only by spaces as the row's optional
  // outer pipe, and the blank cell would drop out of the row.
  const lead = style.lead || (cells.length > 0 && cells[0].trim() === '');
  // Joining cells writes a pipe only from the second cell on, so a row cut down to
  // one cell with no outer pipe on either side would leave the line bare. A table
  // whose lines hold no pipe is a setext heading and a paragraph to every Markdown
  // reader, so the table would be gone from the file. One pipe keeps it a table row.
  const trail =
    style.trail ||
    (cells.length > 0 && cells[cells.length - 1].trim() === '') ||
    (cells.length < 2 && !lead);
  return style.prefix + (lead ? '|' : '') + cells.join('|') + (trail ? '|' : '') + style.suffix;
}

/**
 * Put a new value into a raw cell segment. Keeps the segment's leading space and
 * its total width when the value fits, so the column stays aligned; a value too
 * long to fit widens this segment alone and leaves every other row untouched.
 */
function spliceCell(seg: string, value: string): string {
  const v = pipeCell(value);
  const blank = seg.trim() === '';
  const lead = blank ? seg.slice(0, 1) : /^\s*/.exec(seg)![0];
  // A value ending in an unpaired backslash would escape the pipe written after it
  // and merge the next cell into this one, so it keeps a space before that pipe.
  const escapesPipe = /(^|[^\\])(\\\\)*\\$/.test(v);
  const minTrail = Math.max(escapesPipe ? 1 : 0, blank ? (seg.length ? 1 : 0) : /\s$/.test(seg) ? 1 : 0);
  // Widths are display columns, as in a monospace editor, so CJK text lines up.
  const body = lead + v;
  const room = displayWidth(seg);
  const used = displayWidth(body);
  return used + minTrail <= room ? body + ' '.repeat(room - used) : body + ' '.repeat(minTrail);
}

/**
 * A whole new table's source, padded so its columns line up in a plain text
 * editor. Only used where Sheaf writes a table that has no earlier formatting to
 * keep, such as one pasted from a spreadsheet. Columns whose body cells are all
 * numbers are right-aligned.
 */
// A mark drawn on the character before it takes no column of its own.
const COMBINING_MARK = /^[\p{Mn}\p{Me}]$/u;
// An emoji drawn as a picture by default, wherever in Unicode it lives. The block
// ranges in `displayWidth` cover the pictographs; this covers the check marks,
// stars and other symbols scattered through the Dingbats and Miscellaneous Symbols
// blocks, which are drawn two columns wide just the same.
const EMOJI_PICTURE = /^\p{Emoji_Presentation}$/u;
// What makes a run of code points one emoji picture: a zero width joiner (a family,
// a technologist), the selector that asks for a picture, a skin tone, or the
// regional letters a flag is spelled with.
const EMOJI_JOIN = /[‍️\u{1f3fb}-\u{1f3ff}\p{Regional_Indicator}]/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * How many columns a string takes in a monospace editor: East Asian wide and
 * fullwidth characters, and emoji, take two, and a combining mark takes none.
 * Each character a person sees is measured once, so an emoji built from several
 * code points is two columns like any other.
 */
function displayWidth(s: string): number {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(s)) {
    const first = String.fromCodePoint(segment.codePointAt(0) ?? 0);
    // A mark with nothing before it to sit on takes no column.
    if (COMBINING_MARK.test(first)) continue;
    if (segment.length > first.length && EMOJI_JOIN.test(segment)) {
      width += 2;
      continue;
    }
    width += charWidth(first);
  }
  return width;
}

/** The width of one character standing on its own: two when wide, else one. */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  const wide =
    EMOJI_PICTURE.test(ch) ||
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd);
  return wide ? 2 : 1;
}

function formatPipeTable(rows: string[][], aligns?: Align[], columns?: number): string {
  // How many columns the table has. It defaults to the widest row, which is what a
  // range pasted from a spreadsheet wants, and a caller that knows the header's
  // width passes it, so cells past the last column stay on their line.
  const cols = columns ?? Math.max(...rows.map((r) => r.length));
  const cell = (row: string[], c: number): string => pipeCell(row[c] ?? '');
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.map((row) => displayWidth(cell(row, c)))));
  const numeric = (c: number): boolean => {
    const body = rows.slice(1).map((row) => cell(row, c)).filter(Boolean);
    return body.length > 0 && body.every((v) => wholeNumber(v) !== null);
  };
  const pad = (v: string, w: number): string => v + ' '.repeat(Math.max(0, w - displayWidth(v)));
  const line = (row: string[]): string => {
    const padded = '| ' + widths.map((w, c) => pad(cell(row, c), w)).join(' | ') + ' |';
    // Cells past the last column are not columns, and a reader drops them. They keep
    // their place at the end of the line, so lining the table up never turns a note
    // left on a row into a new column and changes what the table says.
    const rest = row.slice(cols).map((v) => pipeCell(v));
    return rest.length ? padded + ' ' + rest.join(' | ') + ' |' : padded;
  };
  // Given alignments are kept as they are; a pasted table gets right-aligned number columns.
  const delimiter =
    '| ' + widths.map((w, c) => (aligns ? delimCell(w, aligns[c] ?? null) : numeric(c) ? '-'.repeat(w - 1) + ':' : '-'.repeat(w))).join(' | ') + ' |';
  return [line(rows[0]), delimiter, ...rows.slice(1).map(line)].join('\n');
}

/** A delimiter cell for a generated column. */
function delimCell(w: number, a: Align): string {
  if (a === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
  if (a === 'left') return ':' + '-'.repeat(Math.max(1, w - 1));
  if (a === 'right') return '-'.repeat(Math.max(1, w - 1)) + ':';
  return '-'.repeat(Math.max(1, w));
}

/**
 * One field of delimited text. It is quoted only when it could not be read back
 * as written: it holds the delimiter or a line break, or it opens with a quote,
 * which a reader takes as the start of a quoted field. A quote anywhere else is
 * literal data, so it is written as typed rather than quoting and doubling the
 * whole field.
 */
function delimitedCell(s: string, delim: string): string {
  return s.startsWith('"') || s.includes(delim) || /[\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Cells picked out of a pipe table, as lines to quote: one line per picked row,
 * padded so the columns line up. The delimiter line is drawn only when the header
 * row is among them, because that is the one place a table carries one. Its three
 * dashes are also the only reason a column would be padded past its widest cell,
 * so without it the columns are only as wide as what they hold.
 */
function quotePipeRows(rows: string[][], aligns: Align[], header: boolean): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const cell = (row: string[], c: number): string => pipeCell(row[c] ?? '');
  const floor = header ? 3 : 1;
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(floor, ...rows.map((row) => displayWidth(cell(row, c))))
  );
  const pad = (v: string, w: number): string => v + ' '.repeat(Math.max(0, w - displayWidth(v)));
  const line = (row: string[]): string => '| ' + widths.map((w, c) => pad(cell(row, c), w)).join(' | ') + ' |';
  const out = rows.map(line);
  if (header) out.splice(1, 0, '| ' + widths.map((w, c) => delimCell(w, aligns[c] ?? null)).join(' | ') + ' |');
  return out.join('\n');
}

/** Cells picked out of a CSV or TSV block, as lines to quote in that block's dialect. */
function quoteDelimitedRows(rows: string[][], delim: string): string {
  return rows.map((row) => row.map((v) => delimitedCell(v, delim)).join(delim)).join('\n');
}

/**
 * The cell being typed into, as its source segment was when typing began: row
 * `k` of the parsed table (-1 for the header), parsed column `o`, and that
 * segment, or null when the cell had no segment of its own and is generated.
 */
interface TypingCell {
  k: number;
  o: number;
  seg: string | null;
}

/**
 * Write a pipe table back over its source, changing only what the session changed.
 * A cell being typed into is spliced into its segment from before the typing, so
 * what is written for each keystroke is what one commit of that value would write.
 */
function writePipe(
  src: string,
  orig: TableData,
  d: TableData,
  rows: Origin,
  cols: Origin,
  dupes: Origin = [],
  typing: TypingCell | null = null
): string {
  const lines = src.split('\n');
  const body = lines.slice(2).filter((l) => l.trim() !== '');
  const head = splitRawRow(lines[0]);
  const sameCols = isIdentity(cols, orig.headers.length);

  // Width for generated cells, in display columns: the existing column's header
  // segment, less one space each side, or the header text for a column added this session.
  const width = (c: number): number => {
    const o = columnSource(cols[c]);
    const seg = o === null ? undefined : head.cells[o];
    if (seg === undefined) return Math.max(3, displayWidth(pipeCell(d.headers[c] ?? '')));
    return Math.max(1, displayWidth(seg) - (seg.startsWith(' ') ? 1 : 0) - (seg.endsWith(' ') ? 1 : 0));
  };
  const fresh = (v: string, c: number): string => {
    const text = pipeCell(v);
    return ' ' + text + ' '.repeat(Math.max(0, width(c) - displayWidth(text))) + ' ';
  };

  // Rebuild one line from its raw source, or generate it in the header's style.
  const rebuild = (raw: string | undefined, before: string[] | undefined, after: string[], k: number | null): string => {
    const style = splitRawRow(raw ?? lines[0]);
    const cells = d.headers.map((_, c) => {
      const o = columnSource(cols[c]);
      const seg = raw !== undefined && o !== null ? style.cells[o] : undefined;
      if (seg === undefined || o === null) return fresh(after[c] ?? '', c);
      if ((after[c] ?? '') === (before?.[o] ?? '')) return seg;
      if (typing && typing.k === k && typing.o === o) {
        return typing.seg === null ? fresh(after[c] ?? '', c) : spliceCell(typing.seg, after[c] ?? '');
      }
      return spliceCell(seg, after[c] ?? '');
    });
    // Cells past the header are not part of the table, and a reader drops them. What
    // marks them is the width the source line already had, so they are kept whenever
    // the row is rebuilt from that line, including when a column moved, so that
    // reordering columns does not delete text sitting at the end of a row.
    if (raw !== undefined) cells.push(...style.cells.slice(orig.headers.length));
    return joinRawRow(style, cells);
  };

  const delimiter = (): string => {
    const style = splitRawRow(lines[1]);
    const cells = d.headers.map((_, c) => {
      const o = columnSource(cols[c]);
      const seg = o === null ? undefined : style.cells[o];
      if (seg !== undefined && o !== null && d.aligns[c] === orig.aligns[o]) return seg;
      if (seg !== undefined && o !== null && seg.trim() !== '') {
        // A realigned column keeps its delimiter cell's spacing and width, so only
        // the colons change (a two-character cell grows by one for center).
        const inner = seg.trim();
        const at = seg.indexOf(inner);
        return seg.slice(0, at) + delimCell(inner.length, d.aligns[c]) + seg.slice(at + inner.length);
      }
      return ' ' + delimCell(width(c), d.aligns[c]) + ' ';
    });
    return joinRawRow(style, cells);
  };

  return [
    sameCols && sameCells(orig.headers, d.headers) ? lines[0] : rebuild(lines[0], orig.headers, d.headers, -1),
    sameCols && sameCells(orig.aligns, d.aligns) ? lines[1] : delimiter(),
    ...d.rows.map((row, r) => {
      // A duplicated row is written from its source row's text.
      const k = rows[r] ?? dupes[r] ?? null;
      const raw = k === null ? undefined : body[k];
      if (raw === undefined || k === null) return rebuild(undefined, undefined, row, null);
      return sameCols && sameCells(orig.rows[k], row) ? raw : rebuild(raw, orig.rows[k], row, rows[r] ?? null);
    }),
  ].join('\n');
}

/**
 * Write a ```csv or ```tsv block back over its source. Fence lines and untouched
 * rows keep their bytes, quoting included; a changed row is written out whole,
 * since delimited text has no padding to preserve.
 */
function writeCsv(
  src: string,
  orig: TableData,
  d: TableData,
  rows: Origin,
  cols: Origin,
  lang: string,
  dupes: Origin = []
): string {
  const delim = lang === 'tsv' ? '\t' : ',';
  const esc = (s: string): string => delimitedCell(s, delim);
  const sameCols = isIdentity(cols, orig.headers.length);
  // A record may carry more fields than the header. The grid has no column for them
  // and never shows them, so they are data sitting on a line the person did not
  // edit: the row is written at its own width to keep them, the way a pipe table
  // keeps cells past its header's width. Changing the columns gives up that claim.
  // A field whose value did not change is written as its own source text, so an edit
  // to one field rewrites that field and no other: a quoted field stays quoted and a
  // doubled quote stays doubled, whatever form a freshly written value would take.
  const line = (cells: string[], before?: string[], source?: readonly string[]): string => {
    const n = Math.max(d.headers.length, sameCols ? cells.length : 0);
    return Array.from({ length: n }, (_, c) => {
      const v = cells[c] ?? '';
      const kept = sameCols && before !== undefined && source?.[c] !== undefined && (before[c] ?? '') === v;
      return kept ? source![c] : esc(v);
    }).join(delim);
  };

  const lines = src.split('\n');
  const open = lines.shift() ?? '```' + lang;
  const close =
    lines.length && /^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1]) ? lines.pop()! : null;
  const body = lines.join('\n');
  const entries = parseDelimitedRows(body, delim);
  const records = entries.filter((e) => !e.blank);
  const raw = records.map((e) => e.raw);
  // A blank line is not a record, so no row writes it back. Each one is filed under
  // the record it follows (-1 before the header, 0 after the header, k + 1 after
  // grid row k) and written out there again, so a line nobody edited keeps its place.
  const blanks = new Map<number, string[]>();
  let after = -1;
  for (const e of entries) {
    if (!e.blank) {
      after++;
      continue;
    }
    const at = blanks.get(after);
    if (at) at.push(e.raw);
    else blanks.set(after, [e.raw]);
  }
  // Blank lines past the last record end the block rather than following any row.
  const last = entries[entries.length - 1];
  const tail = last ? body.slice(last.start + last.raw.length).split('\n').slice(1) : [];

  const out = [open, ...(blanks.get(-1) ?? [])];
  out.push(
    sameCols && raw[0] !== undefined && sameCells(orig.headers, d.headers)
      ? raw[0]
      : line(d.headers, orig.headers, records[0] && fieldSources(body, records[0]))
  );
  out.push(...(blanks.get(0) ?? []));
  d.rows.forEach((row, r) => {
    const k = rows[r] ?? dupes[r] ?? null;
    const kept = k === null ? undefined : raw[k + 1];
    if (kept !== undefined && k !== null && sameCols && sameCells(orig.rows[k], row)) out.push(kept);
    // A duplicate is a new row, written fresh; only the row itself keeps its source fields.
    else if (k !== null && rows[r] === k) out.push(line(row, orig.rows[k], records[k + 1] && fieldSources(body, records[k + 1])));
    else out.push(line(row));
    // Only the row a blank line actually followed carries it, so a duplicate of that
    // row does not copy the blank line with it.
    const own = rows[r];
    if (own !== null && own !== undefined) out.push(...(blanks.get(own + 1) ?? []));
  });
  out.push(...tail);
  if (close !== null) out.push(close);
  return out.join('\n');
}

// ---- Clipboard plumbing ---------------------------------------------------

interface GridClipboardApi {
  contains: (n: Node | null) => boolean;
  copy: (e: ClipboardEvent) => void;
  cut: (e: ClipboardEvent) => void;
  paste: (e: ClipboardEvent) => void;
}

/** The grid that currently owns keyboard focus (for clipboard routing). */
let activeGrid: GridClipboardApi | null = null;
let clipboardInstalled = false;

/**
 * Route native clipboard events to the focused grid. Installed once. Skipped
 * while an open cell holds the keyboard, so ordinary in-cell copy and paste stay
 * the field's or the cell editor's own (see `contains` in each grid's `clip`).
 */
function installClipboard(): void {
  if (clipboardInstalled) return;
  clipboardInstalled = true;
  const handle = (kind: 'copy' | 'cut' | 'paste') => (e: Event): void => {
    if (!activeGrid) return;
    const ae = document.activeElement;
    if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return;
    if (!activeGrid.contains(ae)) return;
    activeGrid[kind](e as ClipboardEvent);
  };
  document.addEventListener('copy', handle('copy'), true);
  document.addEventListener('cut', handle('cut'), true);
  document.addEventListener('paste', handle('paste'), true);
}

// ---- Row refs -------------------------------------------------------------

/** Each rendered table's source range and a way to hand it keyboard focus from the editor. */
/**
 * The cell a menu event refers to: the cell under it, the first cell of the row
 * under it, or, for a menu opened from the keyboard on the grid itself, the
 * grid's active cell.
 */
function activeCellFor(el: Element): HTMLElement | null {
  const cell = el.closest('[data-r]') ?? el.closest('tr')?.querySelector('[data-r]');
  if (cell) return cell as HTMLElement;
  return el.matches?.('.sheaf-table-grid') ? (el.querySelector('.is-focus') as HTMLElement | null) : null;
}

/** A row or column action for a menu, bound to the cell the menu was reached from. */
export interface TableAction {
  label: string;
  run: () => void;
  /** Draw a separator before this action, to start a new group. */
  separator?: boolean;
  /** Which registry command this is, for the surfaces that draw icons. */
  id?: string;
  icon?: TableIcon;
  /**
   * Offered here but unable to run: the table's own menus keep it in place and
   * dim it. The right-click menu never sees one, because it asks for the
   * commands that can run.
   */
  disabled?: boolean;
  /** The key that runs this from the grid right now, as a key spec, when there is one. */
  keyHint?: string;
}

/**
 * The grid's keys for inserting and deleting whole rows and columns, as key specs
 * for the menus. They act only while the selection is whole rows or whole columns.
 */
const AXIS_KEYS: Partial<Record<string, string>> = {
  'row.insertBelow': 'Mod-Alt-=',
  'row.delete': 'Mod-Alt--',
  'col.insertRight': 'Mod-Alt-=',
  'col.delete': 'Mod-Alt--',
};

// ---- command registry -----------------------------------------------------

/**
 * What a table command is being offered against: the rows and columns it would
 * act on, and enough of the table's shape to say whether it can run at all. One
 * of these is built per gesture, from the cell the gesture reached, and handed
 * to every surface, so the bar, the chevron menus and the right-click menu never
 * disagree about what a command applies to.
 */
export interface TableCommandTarget {
  kind: 'pipe' | 'csv';
  /** The rows covered, both ends included. -1 is the header row. */
  rowLo: number;
  rowHi: number;
  /** The columns covered, both ends included. */
  colLo: number;
  colHi: number;
  /** The last body row, or -1 when the table has no body rows. */
  lastRow: number;
  /** How many body rows and how many columns the table has. */
  rows: number;
  cols: number;
  /** Whether the column an alignment command would act on already carries one. */
  aligned: boolean;
  /** Whether the columns' content has been measured, which fitting them to it needs. */
  measured: boolean;
  /** Whether any column's width was set by hand. */
  pinned: boolean;
  /** Whether this is a fenced data block in a Markdown document, which can move out to a file of its own. */
  fenced: boolean;
  /** Whether a move to a file can be made from here: a host that writes files, and a document that can change. */
  movable: boolean;
}

interface TableCommandSpec {
  readonly id: string;
  /** Plural when the target covers more than one row or column. */
  readonly label: (t: TableCommandTarget) => string;
  readonly icon: TableIcon;
  readonly scope: 'row' | 'column' | 'table';
  /** The first command of a group: the menus draw a separator above it. */
  readonly startsGroup?: boolean;
  readonly enabled: (t: TableCommandTarget) => boolean;
  /**
   * Whether the command belongs on this kind of table's menus at all. One that
   * could never run on it is left off rather than dimmed. Absent means always.
   */
  readonly offered?: (t: TableCommandTarget) => boolean;
}

const rowWord = (t: TableCommandTarget): string => (t.rowHi > t.rowLo ? 'rows' : 'row');
const colWord = (t: TableCommandTarget): string => (t.colHi > t.colLo ? 'columns' : 'column');
/** The header row is not a row that can be copied, moved or deleted, only typed in. */
const onBody = (t: TableCommandTarget): boolean => t.rowLo >= 0;

/**
 * One entry of the registry below. It is written through this rather than as a
 * plain object so the id keeps its own literal type, which is what makes the
 * widget's table of what each command does exhaustive: leave one out and the
 * build says which.
 */
const cmd = <I extends string>(spec: TableCommandSpec & { id: I }): TableCommandSpec & { id: I } => spec;

/**
 * Every command a table offers, in the order the menus list them. Each one is
 * described once here and reached from four places: the floating bar, its
 * overflow menu, the chevron menu on a column header or a row number, and the
 * right-click menu. What a command does lives in the widget, keyed by these ids,
 * because only the widget holds the table being edited.
 */
export const TABLE_COMMANDS = [
  cmd({ id: 'row.insertAbove', label: () => 'Insert row above', icon: 'rowAbove', scope: 'row', enabled: onBody }),
  cmd({ id: 'row.insertBelow', label: () => 'Insert row below', icon: 'rowBelow', scope: 'row', enabled: () => true }),
  cmd({ id: 'row.duplicate', label: (t) => `Duplicate ${rowWord(t)}`, icon: 'rowDuplicate', scope: 'row', enabled: onBody }),
  cmd({ id: 'row.moveUp', label: (t) => `Move ${rowWord(t)} up`, icon: 'rowMoveUp', scope: 'row', enabled: (t) => t.rowLo > 0 }),
  cmd({
    id: 'row.moveDown',
    label: (t) => `Move ${rowWord(t)} down`,
    icon: 'rowMoveDown',
    scope: 'row',
    enabled: (t) => t.rowLo >= 0 && t.rowHi < t.lastRow,
  }),
  cmd({ id: 'row.delete', label: (t) => `Delete ${rowWord(t)}`, icon: 'rowDelete', scope: 'row', enabled: onBody }),

  cmd({ id: 'col.insertLeft', label: () => 'Insert column left', icon: 'colLeft', scope: 'column', startsGroup: true, enabled: () => true }),
  cmd({ id: 'col.insertRight', label: () => 'Insert column right', icon: 'colRight', scope: 'column', enabled: () => true }),
  cmd({ id: 'col.duplicate', label: (t) => `Duplicate ${colWord(t)}`, icon: 'colDuplicate', scope: 'column', enabled: () => true }),
  cmd({ id: 'col.moveLeft', label: (t) => `Move ${colWord(t)} left`, icon: 'colMoveLeft', scope: 'column', enabled: (t) => t.colLo > 0 }),
  cmd({
    id: 'col.moveRight',
    label: (t) => `Move ${colWord(t)} right`,
    icon: 'colMoveRight',
    scope: 'column',
    enabled: (t) => t.colHi < t.cols - 1,
  }),
  cmd({
    id: 'col.delete',
    label: (t) => `Delete ${colWord(t)}`,
    icon: 'colDelete',
    scope: 'column',
    // A table with no columns left is not a table, so the last one stays.
    enabled: (t) => t.cols > t.colHi - t.colLo + 1,
  }),

  // Sorting needs something to put in order, so one body row rules it out.
  cmd({ id: 'col.sortAsc', label: () => 'Sort column A to Z', icon: 'sortAsc', scope: 'column', startsGroup: true, enabled: (t) => t.rows > 1 }),
  cmd({ id: 'col.sortDesc', label: () => 'Sort column Z to A', icon: 'sortDesc', scope: 'column', enabled: (t) => t.rows > 1 }),

  // A pipe table keeps alignment in its delimiter row. A data block has nowhere
  // to keep it, and nothing to pad, so those commands are offered and dimmed.
  cmd({
    id: 'col.alignLeft',
    label: () => 'Align column left',
    icon: 'alignLeft',
    scope: 'column',
    startsGroup: true,
    enabled: (t) => t.kind === 'pipe',
  }),
  cmd({ id: 'col.alignCenter', label: () => 'Align column center', icon: 'alignCenter', scope: 'column', enabled: (t) => t.kind === 'pipe' }),
  cmd({ id: 'col.alignRight', label: () => 'Align column right', icon: 'alignRight', scope: 'column', enabled: (t) => t.kind === 'pipe' }),
  cmd({
    id: 'col.alignClear',
    label: () => 'Clear column alignment',
    icon: 'alignClear',
    scope: 'column',
    enabled: (t) => t.kind === 'pipe' && !!t.aligned,
  }),

  cmd({ id: 'table.pad', label: () => 'Pad columns to line up', icon: 'pad', scope: 'table', startsGroup: true, enabled: (t) => t.kind === 'pipe' }),

  // How wide the columns are drawn. Neither writes anything into the file. Reset
  // is dimmed until a width has been set, so whether the widths were set by hand
  // can be read off the menu.
  cmd({
    id: 'table.fitColumns',
    label: () => 'Fit columns to content',
    icon: 'fitColumns',
    scope: 'table',
    startsGroup: true,
    enabled: (t) => t.measured,
  }),
  cmd({ id: 'table.resetWidths', label: () => 'Reset column widths', icon: 'resetWidths', scope: 'table', enabled: (t) => t.pinned }),

  // The rows as cards, grouped by a column the person picks next. Like the widths,
  // it changes how the table is drawn and writes nothing into the file. A data
  // block reaches the same board through a view of it, so only a pipe table has it.
  cmd({
    id: 'table.showAsBoard',
    label: () => 'Show as board',
    icon: 'colDuplicate',
    scope: 'table',
    startsGroup: true,
    enabled: (t) => t.cols > 0,
    offered: (t) => t.kind === 'pipe',
  }),

  // A CSV or TSV block's rows moved out to a file beside the document, and a view
  // of that file left in the block's place. Only a fenced block has a body to move.
  cmd({
    id: 'table.moveToFile',
    label: () => 'Move to file',
    icon: 'moveToFile',
    scope: 'table',
    startsGroup: true,
    enabled: (t) => t.movable,
    offered: (t) => t.fenced,
  }),
];

/**
 * What moves a data block out to a file: `moveBlockToFile` in viewBlock.ts, which
 * holds the host's file writing, given the view and the start of the block's first
 * line. Set by the page for a Markdown document; null for a data file's own grid,
 * where there is nothing to move, and the command is then not offered.
 */
let moveToFile: ((view: EditorView, from: number) => void) | null = null;

export function setMoveToFile(move: ((view: EditorView, from: number) => void) | null): void {
  moveToFile = move;
}

export type TableCommand = (typeof TABLE_COMMANDS)[number];
export type TableCommandId = TableCommand['id'];

const gridEntries = new WeakMap<
  Element,
  {
    from: number;
    to: number;
    enter: (fromAbove: boolean) => void;
    focusCell: (r: number, c: number) => void;
    actions: (r: number, c: number) => TableAction[];
    selectedRows: () => { r1: number; r2: number } | null;
    /** What Copy ref says for a right-click on cell `r`,`c`, or for the selection it is inside. */
    cellRef: (r: number, c: number) => TableRef;
    /** Make the cell holding document offset `at` active, for find; false when no cell holds it. */
    showMatch: (at: number) => boolean;
    /** The menu's actions while the table is shown as a board, which has no cells to act on; null while it is a grid. */
    boardActions: () => TableAction[] | null;
  }
>();

/**
 * What Copy ref names in a table: the file lines, the source or cells it quotes,
 * and, when the ref is narrower than the whole table, which cells those are in the
 * grid's own terms, such as `Time, row 4` or `Beacon column`.
 */
export interface TableRef {
  start: number;
  end: number;
  text: string;
  label?: string;
}

/**
 * A column's header as a person reads it, for naming the column in a ref: the
 * emphasis, code and strikethrough marks around its words taken off and a link
 * reduced to its text. Marks inside a word, as in `snake_case`, are left alone.
 */
function headerName(raw: string): string {
  return raw
    .replace(/\\\|/g, '|')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .trim()
    .replace(/^([*_])(.+)\1$/, '$2')
    .trim();
}

/**
 * The row and column actions for the table cell under `target`, bound to that
 * cell's row and column. Null when `target` is not inside a rendered table.
 */
export function tableActionsAt(target: EventTarget | null): TableAction[] | null {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return null;
  const wrap = el.closest('.sheaf-table');
  const entry = wrap && gridEntries.get(wrap);
  if (!entry) return null;
  const board = entry.boardActions();
  if (board) return board;
  const cell = activeCellFor(el);
  return cell ? entry.actions(Number(cell.dataset.r), Number(cell.dataset.c)) : [];
}

/** Each rendered table's lookup from a grid row (-1 for the header) to its source range. */
const rowSources = new WeakMap<Element, (r: number) => { from: number; to: number }>();
/** Each grid's rows r1..r2 as this visit would save them: their file lines and source. */
const pendingRows = new WeakMap<Element, (r1: number, r2: number) => { start: number; end: number; text: string }>();

/**
 * The source range behind the table row under `target`: that row's line (or
 * lines, for a quoted multi-line CSV field), the header line for the header, and
 * the whole table for a row added this session and not yet written or for
 * anywhere else in the table. Null when `target` is not inside a rendered table.
 */
export function tableRowSourceAt(target: EventTarget | null): { from: number; to: number } | null {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return null;
  const wrap = el.closest('.sheaf-table');
  const lookup = wrap && rowSources.get(wrap);
  if (!lookup) return null;
  const cell = activeCellFor(el);
  const r = cell ? Number(cell.dataset.r) : NaN;
  // A right-click inside a selection that spans rows refers to all of them.
  const sel = gridEntries.get(wrap)?.selectedRows();
  if (sel && sel.r1 !== sel.r2 && r >= sel.r1 && r <= sel.r2) {
    const whole = lookup(NaN);
    const spans = [];
    for (let i = sel.r1; i <= sel.r2; i++) spans.push(lookup(i));
    // A row not yet written has no lines of its own, so the ref falls back to the table.
    if (spans.some((x) => x.from === whole.from && x.to === whole.to)) return whole;
    return { from: spans[0].from, to: spans[spans.length - 1].to };
  }
  return lookup(r);
}

/**
 * What Copy ref names for a right-clicked table cell, or for the selection it is
 * inside, as the table will read once it is saved. A row moved or added in the
 * grid is named where the save puts it.
 *
 * The lines are the ones the selection touches, which is what a line range is for.
 * The label says which cells those are, by column name and row number, since a line
 * number alone cannot say which of twelve cells was meant. The quote is what was
 * picked: one cell's text, the picked cells in the shape they were picked, or the
 * file's own lines when whole rows were picked, so a ref cannot carry values the
 * person deliberately did not choose.
 */
export function tableRowRefAt(target: EventTarget | null): TableRef | null {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return null;
  const wrap = el.closest('.sheaf-table');
  const pending = wrap && pendingRows.get(wrap);
  if (!pending) return null;
  const cell = activeCellFor(el);
  const entry = gridEntries.get(wrap);
  // Outside any cell, the ref covers the whole table.
  if (!cell || !entry) return pending(1, 0);
  return entry.cellRef(Number(cell.dataset.r), Number(cell.dataset.c));
}

/** Numbers each rendered grid, so its cells can carry document-unique ids for aria-activedescendant. */
let gridSeq = 0;

/** Each live grid's way to take over from a rebuilt decoration for the same table. */
const liveGrids = new WeakMap<HTMLElement, (next: TableWidget) => boolean>();

/** Each live grid's column measuring, so it can be shut down when the grid goes. */
const liveLayouts = new WeakMap<HTMLElement, ColumnLayout>();

/**
 * Each live grid's controls bar: the observer watching it for a resize, the
 * document-wide press handler that closes its menu, and the menu itself, which
 * hangs off the body rather than the table and would outlive it otherwise.
 */
const liveControls = new WeakMap<HTMLElement, () => void>();

/**
 * Each live grid's way to mark the rows an outside write left marked (see
 * `arrivedRows`). Given the changes of a transaction the grid has not adopted yet,
 * it reads the table where those changes put it.
 */
const liveArrived = new WeakMap<Element, (changes?: ChangeDesc) => void>();

// ---- Column widths set by hand ---------------------------------------------
//
// A width someone dragged a column to is a view preference, and it never goes
// into the file. It is kept by the host outside the document (in VS Code, the
// workspace's own storage), keyed by the document and by the table's header row,
// and asked for once when the page loads. A host that does not answer, such as a
// browser tab, leaves the widths to last as long as the page does.
//
// The key is the header row and nothing else, so a table keeps its widths while
// its rows are edited, and a table whose headers changed while it was closed is
// simply laid out the ordinary way again: there is nothing to reconcile.

/** The widths set by hand in this document, by table key, each by column index. */
const pinnedWidths = new Map<string, Map<number, number>>();

/** Every live grid's way to lay its columns out again when the stored widths arrive. */
const pinListeners = new Set<() => void>();

let widthsHost: ((message: unknown) => void) | null = null;
let widthsSeq = 0;

/** What a table's hand-set widths are kept under: its column count and its header row. */
export function tableWidthKey(headers: readonly string[]): string {
  return digest(`${headers.length}${headers.map((h) => h.trim()).join('')}`);
}

/**
 * Where the stored widths come from and go to. Setting a host asks it for this
 * document's widths straight away, which is before the document itself arrives
 * when the page asks first, so a table is usually drawn at its own widths from
 * the start.
 */
export function setTableWidthsHost(send: ((message: unknown) => void) | null): void {
  widthsHost = send;
  send?.({ type: 'tableWidthsRead', id: `widths-${++widthsSeq}` });
}

/** Read one table's stored widths, keeping only what can be a width. */
function readPins(value: unknown): Map<number, number> | null {
  if (!value || typeof value !== 'object') return null;
  const pins = new Map<number, number>();
  for (const [k, w] of Object.entries(value as Record<string, unknown>)) {
    const c = Number(k);
    if (Number.isInteger(c) && c >= 0 && typeof w === 'number' && Number.isFinite(w) && w > 0) pins.set(c, Math.round(w));
  }
  return pins.size ? pins : null;
}

/**
 * The host's answer: this document's stored widths, by table key. A key given as
 * null or holding nothing usable is dropped. Every table on the page is laid out
 * again, which costs arithmetic only.
 */
export function handleTableWidths(_id: string, widths: unknown): void {
  if (widths && typeof widths === 'object') {
    for (const [key, value] of Object.entries(widths as Record<string, unknown>)) {
      const pins = readPins(value);
      if (pins) pinnedWidths.set(key, pins);
      else pinnedWidths.delete(key);
    }
  }
  for (const relayout of pinListeners) relayout();
}

/** Hand the host every width set by hand in this document, for it to keep. */
function saveWidths(): void {
  if (!widthsHost) return;
  const out: Record<string, Record<string, number>> = {};
  for (const [key, pins] of pinnedWidths) {
    if (!pins.size) continue;
    out[key] = Object.fromEntries(Array.from(pins, ([c, w]) => [String(c), w]));
  }
  widthsHost({ type: 'tableWidthsWrite', widths: out });
}

// ---- Tables shown as boards -------------------------------------------------
//
// A pipe table can be drawn as a board: a card per row, in one column per value
// of a column the person picks. Which tables are boards, and what each is grouped
// by, is how the document looks and never goes into the file. It is kept the way
// hand-set widths are: by the host, outside the document, keyed by the document
// and by the table's header row, asked for once when the page loads. A host that
// does not answer leaves a board to last as long as the page does.
//
// A table whose header row changed while it was closed no longer matches its key,
// and is simply drawn as a grid again.

/** The tables shown as boards in this document: by table key, the header text of the column each is grouped by. */
const boardTables = new Map<string, string>();

/** Every live grid's way to look again at whether it is a board when the stored boards arrive. */
const boardListeners = new Set<() => void>();

let boardsHost: ((message: unknown) => void) | null = null;
let boardsSeq = 0;

/**
 * Where the stored boards come from and go to. Setting a host asks it for this
 * document's boards straight away, ahead of the document, as widths are asked for.
 */
export function setTableBoardsHost(send: ((message: unknown) => void) | null): void {
  boardsHost = send;
  send?.({ type: 'tableBoardsRead', id: `boards-${++boardsSeq}` });
}

/** One stored board's grouping column, or null for anything that cannot be one. */
function readBoard(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const group = (value as { group?: unknown }).group;
  return typeof group === 'string' ? group.trim() : null;
}

/**
 * The host's answer: this document's boards, by table key. A key given as null or
 * holding nothing usable is dropped. Every table on the page looks again.
 */
export function handleTableBoards(_id: string, boards: unknown): void {
  if (boards && typeof boards === 'object') {
    for (const [key, value] of Object.entries(boards as Record<string, unknown>)) {
      const group = readBoard(value);
      if (group !== null) boardTables.set(key, group);
      else boardTables.delete(key);
    }
  }
  for (const look of boardListeners) look();
}

/** Hand the host every board in this document, for it to keep. */
function saveBoards(): void {
  boardsHost?.({
    type: 'tableBoardsWrite',
    boards: Object.fromEntries(Array.from(boardTables, ([key, group]) => [key, { group }])),
  });
}

// ---- How tall a table is before it is drawn -------------------------------
//
// CodeMirror places a block widget it has not drawn yet at the height the widget
// estimates, and corrects the document below once it is drawn. An estimate that
// assumes every row is one line puts a table of wrapped notes hundreds of pixels
// short, and everything under it jumps when it scrolls into view. So a table is
// estimated from its text and the widths its columns were last laid out at, and a
// table that has been drawn is remembered at the height it was drawn.
//
// After a reload nothing is remembered, so the columns are divided the way the
// layout divides them: the same allocator, handed each column's widest line and
// longest word worked out from the text, over the text column the window gives.

/**
 * The stylesheet's measures for a grid, in pixels, at the default font size.
 * Checked against a table drawn in VS Code: every row is its lines at 22.08px
 * plus 13px, and the table is the sum of its rows and a 1px edge.
 */
const EST = {
  /** One line of cell text: 0.92em at 16px, at a line height of 1.5. */
  line: 22.08,
  /** A row's padding, 6px above and below, and its 1px rule. */
  row: 13,
  /** The rule under the last row. */
  edge: 1,
  /** The controls bar above the grid, 26px and 3px under it. */
  bar: 29,
  /** The frame's 0.5em above and below. */
  frame: 16,
  /** An average character of cell text. */
  ch: 7.4,
  /** A cell's padding either side. */
  pad: 24,
  /** A digit of the table's font, which is what `ch` and the column floor are measured in. */
  digit: 8.1,
  /** The row-number column around its digits: 8px padding either side and a rule. */
  gutterPad: 17,
  /** The row numbers' size against the table's own. */
  gutterScale: 0.8,
  /** The text column the table sits in, when neither a layout nor the window says. */
  pane: 708,
};

/** How many lines of a cell are drawn before the rest is cut off (see the stylesheet). */
const CLAMP_LINES = 4;

/** What a cell shows of its Markdown, near enough: a link shows its text, and markers show nothing. */
const shownText = (part: string): string => part.replace(/\]\([^)]*\)/g, ']').replace(/[*_`~[\]\\]/g, '');

/** A cell's drawn lines, split where a `<br>` or a line break puts a new one. */
const cellParts = (value: string): string[] => value.split(/<br\s*\/?>|\n/i).map(shownText);

/**
 * The widths the layout would give a table's columns in a text column `pane`
 * pixels wide, from its text: each column's widest line and longest word, at an
 * average character, handed to the allocator the layout itself uses.
 */
export function estimateColumnWidths(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  pane: number,
  pinned: ReadonlyMap<number, number> | null
): number[] {
  const n = Math.max(1, headers.length);
  const gutter = EST.gutterPad + String(Math.max(1, rows.length)).length * EST.digit * EST.gutterScale;
  const extents: ColumnExtent[] = [];
  for (let c = 0; c < n; c++) {
    let widest = 0;
    let longest = 0;
    for (const cells of [headers, ...rows]) {
      const value = cells[c] ?? '';
      if (!value) continue;
      for (const part of cellParts(value)) {
        widest = Math.max(widest, displayWidth(part));
        for (const word of part.split(/\s+/)) longest = Math.max(longest, displayWidth(word));
      }
    }
    extents.push({ min: longest * EST.ch + EST.pad, max: widest * EST.ch + EST.pad });
  }
  const alloc = allocateColumnWidths(pane - gutter, extents, {
    floor: COLUMN_FLOOR_CH * EST.digit + EST.pad,
    cap: COLUMN_CAP_FRACTION * pane,
    pinned,
  });
  return alloc?.widths ?? extents.map(() => (pane - gutter) / n);
}

/**
 * An estimate of a table's drawn height from its cells and its column widths.
 * When the widths are not known they are worked out the way the layout would lay
 * them out in a text column `pane` pixels wide, holding any `pinned` column at the
 * width it was set to.
 */
export function estimateTableHeight(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  widths: readonly number[] | null,
  { pane = EST.pane, pinned = null }: { pane?: number; pinned?: ReadonlyMap<number, number> | null } = {}
): number {
  const n = Math.max(1, headers.length);
  const laid = widths ?? estimateColumnWidths(headers, rows, pane, pinned);
  const lines = (value: string, c: number): number => {
    if (!value) return 1;
    const room = Math.max(EST.ch, (laid[c] ?? pane / n) - EST.pad);
    let count = 0;
    for (const shown of cellParts(value)) {
      // A pixel of slack: a column sized to its own text is rounded to a whole pixel,
      // and without it the estimate wraps that text onto a second line nobody draws.
      count += Math.max(1, Math.ceil((displayWidth(shown) * EST.ch - 1) / room));
      if (count >= CLAMP_LINES) return CLAMP_LINES;
    }
    return Math.max(1, count);
  };
  const row = (cells: readonly string[]): number => {
    let most = 1;
    for (let c = 0; c < n && most < CLAMP_LINES; c++) most = Math.max(most, lines(cells[c] ?? '', c));
    return most * EST.line + EST.row;
  };
  let height = EST.bar + EST.frame + EST.edge + row(headers);
  for (const r of rows) height += row(r);
  return Math.round(height);
}

/** The text column a table was last laid out in, so the next table estimated after it is divided the same way. */
let laidPane: number | null = null;

/**
 * The text column a table will be drawn in: the one the last table was laid out
 * in, or what the stylesheet makes of the window, which is the content width
 * setting inside a side margin of 8% of the window, never under 24px or over 96px.
 */
function textColumn(): number {
  if (laidPane) return laidPane;
  if (typeof window === 'undefined' || !(window.innerWidth > 0)) return EST.pane;
  let setting = EST.pane;
  try {
    const host = document.getElementById('editor') ?? document.documentElement;
    const raw = getComputedStyle(host).getPropertyValue('--md-content-width').trim();
    const px = /^(\d+(?:\.\d+)?)px$/.exec(raw);
    if (px) setting = Number(px[1]);
  } catch {
    // No stylesheet to read, so the default column.
  }
  const margin = Math.min(96, Math.max(24, window.innerWidth * 0.08));
  return Math.max(EST.pane / 4, Math.min(setting, window.innerWidth - 2 * margin));
}

/** The height each table was last drawn at, by its text, so an undrawn copy of it is estimated exactly. */
const drawnHeights = new Map<string, number>();

/** The widths each table's columns were last laid out at, by its header row. */
const laidWidths = new Map<string, readonly number[]>();

/** Keep `value` under `key`, forgetting the oldest entry past a few hundred tables. */
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 256) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

// ---- Widget ---------------------------------------------------------------

interface Cell {
  r: number; // -1 = header row, 0.. = body row
  c: number;
}

/** A block of cells, rows `r1`..`r2` by columns `c1`..`c2`, both ends included. */
interface CellRect {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
}

const inRect = (q: CellRect, r: number, c: number): boolean => r >= q.r1 && r <= q.r2 && c >= q.c1 && c <= q.c2;

/**
 * What is left of a block once one cell is cut out of it: the rows above, the
 * rows below, and what is left of the cell's own row on either side. Cmd-clicking
 * a selected cell drops it this way, so the rest of the block stays picked and
 * the selection is still a list of blocks.
 */
function rectWithout(q: CellRect, r: number, c: number): CellRect[] {
  if (!inRect(q, r, c)) return [q];
  const out: CellRect[] = [];
  if (q.r1 < r) out.push({ ...q, r2: r - 1 });
  if (r < q.r2) out.push({ ...q, r1: r + 1 });
  if (q.c1 < c) out.push({ r1: r, r2: r, c1: q.c1, c2: c - 1 });
  if (c < q.c2) out.push({ r1: r, r2: r, c1: c + 1, c2: q.c2 });
  return out;
}

/** A data block's name, and whether another block in the document has it too. */
interface TableName {
  id: string;
  duplicate: boolean;
}

/**
 * Each drawn caption's way to rename its block: given the name typed, it renames
 * the block and the views that read it, or says why it did not.
 */
const captionRenames = new WeakMap<HTMLElement, (to: string) => string | null>();

/**
 * Put a text field over a block's name. Enter renames, and a name that cannot be
 * used keeps the field open with the reason beside it. Escape, or leaving the
 * field with a name that cannot be used, puts the name back as it was.
 */
function openRename(caption: HTMLElement, name: TableName, rename: (to: string) => string | null): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sheaf-table-rename';
  input.value = name.id;
  input.spellcheck = false;
  input.setAttribute('aria-label', `Rename table ${name.id}`);
  const reason = document.createElement('span');
  reason.className = 'sheaf-table-error';
  reason.setAttribute('role', 'alert');
  reason.hidden = true;
  let done = false;
  const close = (focusName: boolean): void => {
    if (done) return;
    done = true;
    input.remove();
    reason.remove();
    paintTableName(caption, name);
    if (focusName) caption.querySelector<HTMLElement>('.sheaf-table-id')?.focus({ preventScroll: true });
  };
  const commit = (): boolean => {
    // Settled before the rename is written, since writing it draws the table again.
    done = true;
    const why = rename(input.value);
    if (why) {
      done = false;
      reason.textContent = why;
      reason.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      return false;
    }
    // Renamed, or left as it was: the caption shows the name the document now holds.
    if (input.isConnected) {
      input.remove();
      reason.remove();
      paintTableName(caption, { ...name, id: input.value.trim() || name.id });
    }
    caption.querySelector<HTMLElement>('.sheaf-table-id')?.focus({ preventScroll: true });
    return true;
  };
  input.addEventListener('keydown', (e) => {
    // The grid's keys stay out of a name being typed.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    }
  });
  for (const type of ['mousedown', 'click', 'copy', 'cut', 'paste', 'keyup', 'input'] as const) {
    input.addEventListener(type, (e) => e.stopPropagation());
  }
  input.addEventListener('blur', () => {
    if (done) return;
    if (input.value.trim() === name.id || !commit()) close(false);
  });
  caption.replaceChildren(input, reason);
  caption.hidden = false;
  input.focus();
  input.select();
}

/**
 * Where the views in the document name the block called `name`: the `#name` of
 * each `from: #name` line, matched without regard to case the way a view reads
 * it, with `nameFrom` where the name itself starts. A view inside a list item or
 * a quote is found as well as one at the margin.
 */
export function viewReferences(state: EditorState, name: string): { from: number; to: number; nameFrom: number }[] {
  const want = name.toLowerCase();
  const doc = state.doc;
  const out: { from: number; to: number; nameFrom: number }[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      const open = doc.lineAt(node.from);
      if (fenceLang(doc.sliceString(node.from, open.to)) !== 'view') return false;
      const last = doc.lineAt(Math.max(node.from, node.to - 1));
      for (let n = open.number + 1; n <= last.number; n++) {
        const line = doc.line(n);
        const m = /^([ \t>]*from[ \t]*:[ \t]*)(#[ \t]*)(\S+?)[ \t]*$/i.exec(line.text);
        if (m && m[3].toLowerCase() === want) {
          const at = line.from + m[1].length;
          out.push({ from: at, to: at + m[2].length + m[3].length, nameFrom: at + m[2].length });
        }
      }
      return false;
    },
  });
  return out;
}

/** A name a block may have: letters, digits, hyphens and underscores. */
const BLOCK_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Rename the data block whose first line starts at `blockFrom` to `to`, and every
 * view that reads it by its old name, as one edit and one undo step. Returns why
 * the name was refused, or null when it was taken or is the name already.
 */
export function renameDataBlock(view: EditorView, blockFrom: number, to: string): string | null {
  const next = to.trim();
  const blocks = dataBlocks(view.state);
  const block = blocks.find((b) => b.from === blockFrom);
  if (!block?.id) return 'This block has no name to change.';
  if (next === block.id) return null;
  if (!next) return 'A table needs a name, so views can read it. Press Escape to keep the one it has.';
  if (!BLOCK_NAME.test(next)) return `"${next}" cannot be a name. Use letters, digits, hyphens and underscores, with no spaces.`;
  if (blocks.some((b) => b !== block && b.id && b.id.toLowerCase() === next.toLowerCase())) {
    return `Another block in this document is already named "${next}". Pick a name no other block has.`;
  }
  if (view.state.readOnly) return 'This document is read-only.';
  const line = view.state.doc.lineAt(block.from);
  const m = /(^|[ \t])id=([A-Za-z0-9_-]+)(?=[ \t]|$)/.exec(line.text);
  if (!m || m[2] !== block.id) return 'The name could not be found on the block’s first line.';
  const at = line.from + m.index + m[1].length + 'id='.length;
  // Views reading a name two blocks share read neither, so they are left as written.
  const readers = block.duplicate ? [] : viewReferences(view.state, block.id);
  view.dispatch({
    changes: [{ from: at, to: at + block.id.length, insert: next }, ...readers.map((r) => ({ from: r.nameFrom, to: r.to, insert: next }))],
    annotations: isolateHistory.of('full'),
    userEvent: 'input',
  });
  return null;
}

/**
 * The line above a named data block's grid: its name, which a view's `from: #name`
 * reads it by, and, when another block has the same name, an error saying so.
 * Always shown, where the controls bar shows only on hover, because a reader
 * following a view back to its table looks for the name without pointing at it.
 */
function paintTableName(caption: HTMLElement, name: TableName | null): void {
  // A name being typed is left alone while the table around it is drawn again.
  if (name && caption.querySelector('.sheaf-table-rename') && caption.dataset.id === name.id) return;
  caption.hidden = !name;
  caption.replaceChildren();
  if (!name) return;
  caption.dataset.id = name.id;
  const id = document.createElement('span');
  id.className = 'sheaf-table-id';
  id.textContent = `#${name.id}`;
  const rename = captionRenames.get(caption);
  if (rename) {
    // The name is a control: a click, or Enter while it has focus, opens it for typing.
    id.tabIndex = 0;
    id.setAttribute('role', 'button');
    id.setAttribute('aria-label', `Table name ${name.id}. Press Enter to rename it.`);
    id.title = `Views read this table as "from: #${name.id}". Click to rename it; views that read it follow.`;
    const open = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      openRename(caption, name, rename);
    };
    id.addEventListener('mousedown', (e) => e.stopPropagation());
    id.addEventListener('click', open);
    id.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'F2' || e.key === ' ') open(e);
    });
  } else {
    id.title = `Views read this table as "from: #${name.id}"`;
  }
  caption.appendChild(id);
  caption.classList.toggle('is-duplicate', name.duplicate);
  if (name.duplicate) {
    const error = document.createElement('span');
    error.className = 'sheaf-table-error';
    error.setAttribute('role', 'alert');
    error.textContent = `Another block in this document is also named "${name.id}". Rename one, so a view knows which to read.`;
    caption.appendChild(error);
  }
}

class TableWidget extends WidgetType {
  constructor(
    readonly kind: 'pipe' | 'csv',
    readonly from: number,
    readonly to: number,
    readonly data: TableData,
    readonly sig: string,
    readonly lang: string,
    /** The marks of the list item or blockquote the table sits in, on every line (see `bareTable`). */
    readonly prefix: string = '',
    /** The name a data block's info string gives it, which views read it by. */
    readonly name: TableName | null = null
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    // The end matters as much as the start: a table re-padded without changing its
    // cells keeps both, and a grid kept on eq would go on writing over its old range.
    return other.kind === this.kind && other.from === this.from && other.to === this.to && other.sig === this.sig;
  }

  // Called with the grid of a table decoration being redrawn. An outside change
  // that moved or rewrote this table rebuilds its decoration; handing the existing
  // grid to the new widget keeps unsaved edits, the selection, focus and a cell
  // being typed into, where a fresh grid would silently drop them.
  updateDOM(dom: HTMLElement): boolean {
    return liveGrids.get(dom)?.(this) ?? false;
  }

  // Called when this grid's DOM leaves the document for good. A grid handed on to
  // a rebuilt widget (see updateDOM) is not destroyed, so the observer watching
  // the frame for a resize is disconnected here and nowhere else.
  destroy(dom: HTMLElement): void {
    liveLayouts.get(dom)?.destroy();
    liveLayouts.delete(dom);
    liveControls.get(dom)?.();
    liveControls.delete(dom);
  }

  private estimate: number | undefined;

  // A table drawn before is the height it was drawn at. Otherwise it is estimated
  // from its cells, at the widths its columns had last time if it has had any, and
  // at the widths the layout would give them in the text column if not.
  get estimatedHeight(): number {
    const drawn = drawnHeights.get(this.sig);
    if (drawn) return drawn;
    const key = tableWidthKey(this.data.headers);
    this.estimate ??= estimateTableHeight(this.data.headers, this.data.rows, laidWidths.get(key) ?? null, {
      pane: textColumn(),
      pinned: pinnedWidths.get(key) ?? null,
    });
    return this.estimate;
  }

  toDOM(view: EditorView): HTMLElement {
    const { kind, lang, prefix } = this;
    // What a cell draws. A pipe-table cell is Markdown. A CSV or TSV field is data,
    // shown as its exact text, the way it edits: `**x**` there is five characters.
    const cellHtml = (value: string): string => (kind === 'pipe' ? renderInline(value) : escapeHtml(value));
    // The table's current range and parsed text. CodeMirror hands this DOM to a
    // rebuilt widget for the same table (see updateDOM), which moves them here.
    const pos = { from: this.from, to: this.to };
    let sig = this.sig;
    // The widget's own data stays as parsed. This session edits a copy and
    // records where each row and column came from, so the write can keep the
    // untouched source verbatim.
    let orig = this.data;
    const data = cloneTable(orig);
    const rowOrigin: Origin = data.rows.map((_, i) => i);
    const colOrigin: Origin = data.headers.map((_, i) => i);
    // Rows appended by Tab or Enter past the end. One still empty at write time
    // was only somewhere the cursor passed through, so it is not written.
    const autoRows = new WeakSet<string[]>();
    // Rows made by Duplicate row, mapped to the source row whose text they copy.
    const dupSource = new WeakMap<string[], number>();
    const keptRows = (): boolean[] => data.rows.map((row) => !(autoRows.has(row) && row.every((c) => c === '')));
    const write = (src: string): string => {
      const keep = keptRows();
      const d: TableData = { ...data, rows: data.rows.filter((_, i) => keep[i]) };
      const rows = rowOrigin.filter((_, i) => keep[i]);
      const untouched =
        isIdentity(rows, orig.rows.length) &&
        isIdentity(colOrigin, orig.headers.length) &&
        sameTable(orig, d);
      if (untouched) return src;
      const dupes = d.rows.map((row) => dupSource.get(row) ?? null);
      // The writers see the table as it reads outside its container, and every line
      // they write goes back into the container.
      const bare = bareTable(src, prefix);
      if (!bare) return src;
      const text =
        kind === 'pipe'
          ? writePipe(bare.text, orig, d, rows, colOrigin, dupes, typingCell())
          : writeCsv(bare.text, orig, d, rows, colOrigin, lang, dupes);
      return dressTable(bare, text, prefix);
    };

    const wrap = document.createElement('div');
    wrap.className = 'sheaf-table' + (kind === 'csv' ? ' is-csv' : '');
    // The grid stands in for the quote's lines, `>` and all, so it draws the quote's bar itself.
    if (prefix.includes('>')) wrap.classList.add('is-quoted');
    gridEntries.set(wrap, {
      get from() {
        return pos.from;
      },
      get to() {
        return pos.to;
      },
      enter: (fromAbove) => {
        select(fromAbove || lastRow() < 0 ? -1 : lastRow(), 0);
        wrap.scrollIntoView?.({ block: 'nearest' });
      },
      focusCell: (r, c) => select(clampRow(r), clampCol(c)),
      // Every row the selection reaches, blocks picked one at a time included, so a
      // ref names the lines the selection touches however the cells were gathered.
      selectedRows: () => (hasSel ? { r1: selBounds().r1, r2: selBounds().r2 } : null),
      cellRef: (r, c) => cellRef(r, c),
      showMatch: (at) => showMatch(at),
      // The right-click menu has always left out what cannot run where it was
      // opened, so it filters the registry rather than dimming it. The surfaces
      // added since show the same commands in the same order, disabled.
      actions: (r, c) => menuActions(r, c, false),
      boardActions: () => (boardState ? boardActions() : null),
    });
    // Step out of the grid onto the line above or below, the way the caret came in.
    const leave = (below: boolean): boolean => {
      const { doc } = view.state;
      clearSel();
      view.focus();
      if (below ? pos.to >= doc.length : pos.from === 0) {
        // Nothing on that side of the table: add the line the caret needs. Below,
        // typing on it is kept out of the table; above, a blank line keeps what is
        // typed apart from the header row.
        view.dispatch({
          changes: below ? { from: pos.to, insert: '\n' } : { from: 0, insert: '\n\n' },
          selection: { anchor: below ? pos.to + 1 : 0 },
          scrollIntoView: true,
          // Above, the lines are taken out again if nothing is typed on them (leadLines).
          ...(below ? {} : { effects: setLeadLines.of(0), annotations: Transaction.addToHistory.of(false) }),
        });
        return true;
      }
      view.dispatch({ selection: { anchor: below ? pos.to + 1 : pos.from - 1 }, scrollIntoView: true });
      return true;
    };
    // Where each row (-1 for the header) of a table's text sits, as offsets into it:
    // the whole of its line, container marks included. The grid asks for its rows one
    // at a time, every one of them as it draws, so the text is read once for all of
    // them and the answer kept until the text changes.
    type Span = { from: number; to: number };
    let spansOf: { src: string; spans: Map<number, Span> } | null = null;
    const rowSpans = (src: string): Map<number, Span> => {
      if (spansOf?.src === src) return spansOf.spans;
      const spans = new Map<number, Span>();
      const bare = bareTable(src, prefix);
      if (bare) {
        const toSource = sourceOffsets(bare);
        bareRowSpans(bare.text).forEach((s, k) => spans.set(k, { from: toSource(s.from), to: toSource(s.to) }));
      }
      spansOf = { src, spans };
      return spans;
    };
    const rowSpan = (src: string, k: number): Span | null => rowSpans(src).get(k) ?? null;
    // The same, in a table's text with the container marks taken off.
    const bareRowSpans = (src: string): Map<number, Span> => {
      const spans = new Map<number, Span>();
      if (kind === 'pipe') {
        const lines = src.split('\n');
        spans.set(-1, { from: 0, to: lines[0].length });
        let at = lines[0].length + 1;
        for (let i = 1, seen = -1; i < lines.length; i++) {
          if (i >= 2 && lines[i].trim() !== '') spans.set(++seen, { from: at, to: at + lines[i].length });
          at += lines[i].length + 1;
        }
        return spans;
      }
      const body = src.indexOf('\n') + 1;
      if (!body) return spans;
      delimitedRecords(src.slice(body), lang === 'tsv' ? '\t' : ',').forEach((row, i) =>
        spans.set(i - 1, { from: body + row.start, to: body + row.start + row.raw.length })
      );
      return spans;
    };
    const bareRowSpan = (src: string, k: number): Span | null => bareRowSpans(src).get(k) ?? null;
    // The grid cell at `offset` of a table's text (the header for the header and
    // delimiter lines). A change that starts by adding or removing a line break
    // shows on the line after it.
    const cellAt = (text: string, at: number): Cell => {
      const bare = bareTable(text, prefix);
      return bare ? bareCellAt(bare.text, bareOffset(bare, at)) : { r: -1, c: 0 };
    };
    const bareCellAt = (src: string, offset: number): Cell => {
      if (src[offset] === '\n') offset++;
      const lines = src.slice(0, offset).split('\n');
      const li = lines.length - 1;
      if (kind === 'pipe') {
        const r = li < 2 ? -1 : lines.slice(2, li).filter((l) => l.trim() !== '').length;
        let pipes = 0;
        for (let i = 0; i < lines[li].length; i++) {
          if (lines[li][i] === '\\') i++;
          else if (lines[li][i] === '|') pipes++;
        }
        const lead = splitRawRow(src.split('\n')[li] ?? '').lead;
        return { r, c: Math.max(0, pipes - (lead ? 1 : 0)) };
      }
      const delim = lang === 'tsv' ? '\t' : ',';
      const body = src.indexOf('\n') + 1;
      if (!body || offset < body) return { r: -1, c: 0 };
      const rows = delimitedRecords(src.slice(body), delim);
      const at = offset - body;
      let i = 0;
      while (i + 1 < rows.length && rows[i + 1].start <= at) i++;
      // The field `offset` is in: the last one of its record that starts at or before it.
      let cells = 0;
      const fields = rows[i]?.fields ?? [];
      for (let f = 0; f < fields.length && fields[f] <= at; f += 2) cells++;
      return { r: i - 1, c: Math.max(0, cells - 1) };
    };
    // Keyed on the document itself, which is never changed in place, so asking for
    // every row of an unchanged table reads its text once rather than once a row.
    let sourceSpans: { doc: unknown; from: number; to: number; spans: Map<number, Span> } | null = null;
    rowSources.set(wrap, (r) => {
      const whole = { from: pos.from, to: pos.to };
      const k = r === -1 ? -1 : rowOrigin[r];
      if (Number.isNaN(r) || k === null || k === undefined) return whole;
      const { doc } = view.state;
      if (!sourceSpans || sourceSpans.doc !== doc || sourceSpans.from !== pos.from || sourceSpans.to !== pos.to) {
        sourceSpans = { doc, from: pos.from, to: pos.to, spans: rowSpans(view.state.sliceDoc(pos.from, pos.to)) };
      }
      const span = sourceSpans.spans.get(k);
      return span ? { from: pos.from + span.from, to: pos.from + span.to } : whole;
    });
    // The same rows in the text this visit would write. Rows keep their grid order
    // there, and a row left empty past the end is not written, so it has no lines.
    pendingRows.set(wrap, (r1, r2) => {
      const out = write(view.state.sliceDoc(pos.from, pos.to));
      const kept = keptRows();
      const spans: { from: number; to: number }[] = [];
      for (let r = r1; r <= r2; r++) {
        if (r !== -1 && !kept[r]) continue;
        const span = rowSpan(out, r === -1 ? -1 : kept.slice(0, r).filter(Boolean).length);
        if (span) spans.push(span);
      }
      const range = spans.length ? { from: spans[0].from, to: spans[spans.length - 1].to } : { from: 0, to: out.length };
      const first = view.state.doc.lineAt(pos.from).number;
      const lineAt = (offset: number): number => first + (out.slice(0, offset).match(/\n/g)?.length ?? 0);
      return { start: lineAt(range.from), end: lineAt(range.to), text: out.slice(range.from, range.to) };
    });
    const caption = document.createElement('div');
    caption.className = 'sheaf-table-caption';
    captionRenames.set(caption, (to) => renameDataBlock(view, pos.from, to));
    paintTableName(caption, this.name);
    const controls = document.createElement('div');
    controls.className = 'sheaf-table-controls';
    const gridHost = document.createElement('div');
    gridHost.className = 'sheaf-table-grid';
    gridHost.tabIndex = 0;
    // Focusing an element lets the browser scroll it into view, and a grid taller
    // than the pane is never wholly in view, so a plain focus() moved the page under
    // the pointer between the two clicks of a double-click. What stays on screen is
    // paint's job: it scrolls just the active cell into view as the keys move it.
    // A table shown as a board has its grid hidden, and the focus goes to its picked card instead.
    const focusGrid = (): void => (gridHost.hidden ? focusBoard() : gridHost.focus({ preventScroll: true }));
    // The ARIA grid pattern: the focused container is the grid, and
    // aria-activedescendant names the active cell as the arrows move it.
    const gridId = `sheaf-grid-${++gridSeq}`;
    gridHost.setAttribute('role', 'grid');
    gridHost.setAttribute('aria-multiselectable', 'true');
    const cellId = (r: number, c: number): string => `${gridId}-r${r + 1}-c${c}`;
    // A changed-row tint is spent once its fade ends, so a re-attached row cannot replay it.
    gridHost.addEventListener('animationend', (e) => (e.target as Element).closest?.('tr')?.classList.remove('is-changed'));
    // How wide each column is drawn. It measures the cells against this theme's
    // own font and writes a colgroup, so a column that holds a word keeps the
    // width of a word and a column that holds sentences is the one that gives.
    // The widths set by hand for this table, kept under its header row. A header
    // renamed in the grid is the same table, so its widths move to the new name;
    // a change to how many columns there are is not, and the table goes back to
    // widths of its own.
    let pinKey = tableWidthKey(data.headers);
    let pinCols = data.headers.length;
    const pins = (): Map<number, number> | null => {
      const key = tableWidthKey(data.headers);
      if (key !== pinKey) {
        const held = pinnedWidths.get(pinKey);
        if (held && pinCols === data.headers.length && !pinnedWidths.has(key)) {
          pinnedWidths.delete(pinKey);
          pinnedWidths.set(key, held);
          saveWidths();
        }
        pinKey = key;
        pinCols = data.headers.length;
      }
      return pinnedWidths.get(key) ?? null;
    };
    const setPins = (next: Map<number, number> | null, save: boolean): void => {
      pins();
      if (next && next.size) pinnedWidths.set(pinKey, next);
      else pinnedWidths.delete(pinKey);
      if (save) saveWidths();
      columns.refresh();
      syncControls();
    };
    const columns = createColumnLayout(view, wrap, gridHost, {
      table: () => gridHost.querySelector(':scope > table'),
      shape: () => data,
      signature: () => sig,
      render: cellHtml,
      rank: displayWidth,
      pinned: pins,
      onLayout: () => columnsLaid(),
    });
    liveLayouts.set(wrap, columns);
    const relayoutPins = (): void => {
      columns.refresh();
      syncControls();
    };
    pinListeners.add(relayoutPins);

    // ---- model access ----
    const colCount = (): number => data.headers.length;
    const rowCount = (): number => data.rows.length;
    const lastRow = (): number => (rowCount() > 0 ? rowCount() - 1 : -1);
    const getCell = (r: number, c: number): string =>
      r === -1 ? data.headers[c] ?? '' : data.rows[r]?.[c] ?? '';
    const setCell = (r: number, c: number, v: string): void => {
      if (r === -1) data.headers[c] = v;
      else (data.rows[r] ??= [])[c] = v;
    };
    // The drawn table's rows in order, kept by `render`: the header row, then one per
    // body row. Each starts with the corner or the row number, then its cells. A cell
    // is found there by position, which costs the same in a table of ten rows or ten
    // thousand, and checked against its own coordinates before it is trusted.
    let rowEls: HTMLTableRowElement[] = [];
    const rowEl = (r: number): HTMLTableRowElement | null => rowEls[r + 1] ?? null;
    const cellEl = (r: number, c: number): HTMLElement | null => {
      const el = rowEl(r)?.cells[c + 1] as HTMLElement | undefined;
      if (el && el.dataset.r === String(r) && el.dataset.c === String(c)) return el;
      return gridHost.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    };
    /** Row `r`'s row number. */
    const gutterEl = (r: number): HTMLElement | null => {
      const el = rowEl(r)?.cells[0] as HTMLElement | undefined;
      return el?.classList.contains('sheaf-table-gutter') ? el : null;
    };
    /**
     * The axis chevron and the width grip a header carries, taken out before the
     * cell's content is replaced so they can be put back after. A header cell is
     * redrawn whenever it is edited, and both belong to the header rather than to
     * anything the header says.
     */
    const axisMark = (el: HTMLElement): Element[] =>
      Array.from(el.querySelectorAll(':scope > .sheaf-table-chevron, :scope > .sheaf-table-resize'));
    /** Draw a cell's Markdown, and watch any picture in it the way prose does. */
    const drawCell = (el: HTMLElement, value: string): void => {
      el.classList.remove('is-editing');
      const mark = axisMark(el);
      // The text goes in an element of its own, which is what a tall cell is clamped
      // on (see `measureClamps`). Clamping the cell itself would make it a box that
      // cuts off its own border and the chevron and grip it carries.
      if (value === '') el.textContent = '';
      else el.innerHTML = `<div class="sheaf-table-text">${cellHtml(value)}</div>`;
      // A header's name is its own text, set before the chevron goes back in. A cell
      // otherwise takes its name from everything inside it, and the chevron is a
      // labelled button, so a screen reader announced "Fruit Column Fruit commands"
      // on every move across columns. The button keeps its own label and stays
      // reachable; it just stops being part of the header's name.
      if (el.getAttribute('role') === 'columnheader') {
        el.setAttribute('aria-label', el.textContent?.trim() || `Column ${Number(el.dataset.c) + 1}`);
      }
      el.append(...mark);
      el.querySelectorAll('img.md-img').forEach((img) => {
        // A picture says so when it cannot be loaded, and a loaded one changes
        // the row's height, which is the editor's to measure, and its column's
        // width, which was measured while the picture was still nothing.
        img.addEventListener('error', () => img.closest('.md-img-wrap')?.classList.add('is-broken'));
        img.addEventListener('load', () => {
          view.requestMeasure();
          columns.remeasure();
        });
      });
      // What the cell holds changed, so whether it is too tall to draw whole may have too.
      measureClamps();
      if (el.classList.contains('is-tall')) clampCell(el);
    };

    // ---- tall cells ----
    /*
     * A cell whose text runs past four lines is drawn at four, so one long note
     * does not stand its whole row a screen tall. Which cells those are is read off
     * the layout: a cell is `is-tall` when its text is taller than four of its lines.
     * It is drawn clamped (`is-clamped`) except while it is the active cell or open
     * for typing, where the clamp would cut off the caret and what is being read,
     * and while clamped its whole text is its tooltip.
     *
     * The clamp is on the text's own element, and the height it is judged by is
     * that element's scroll height, which is the whole text's height whether it is
     * clamped or not, so clamping a cell never changes the answer for it.
     */
    const clampKey = {};
    const clampCell = (el: HTMLElement): void => {
      const on = el.classList.contains('is-tall') && !el.classList.contains('is-focus') && !el.classList.contains('is-editing');
      el.classList.toggle('is-clamped', on);
      if (on) el.title = el.querySelector(':scope > .sheaf-table-text')?.textContent ?? '';
      else el.removeAttribute('title');
    };
    const applyClamps = (): void => {
      gridHost.querySelectorAll<HTMLElement>('.is-tall, .is-clamped').forEach(clampCell);
    };
    function measureClamps(): void {
      view.requestMeasure<{ tall: Set<Element>; height: number } | null>({
        key: clampKey,
        read: () => {
          if (!wrap.isConnected) return null;
          const texts = Array.from(gridHost.querySelectorAll<HTMLElement>('.sheaf-table-text'));
          const tall = new Set<Element>();
          if (texts.length) {
            const cs = getComputedStyle(texts[0]);
            let line = parseFloat(cs.lineHeight);
            if (!(line > 0)) line = (parseFloat(cs.fontSize) || 16) * 1.5;
            const limit = line * CLAMP_LINES + 1;
            for (const t of texts) if (t.scrollHeight > limit && t.parentElement) tall.add(t.parentElement);
          }
          return { tall, height: wrap.offsetHeight };
        },
        write: (m) => {
          if (!m) return;
          gridHost.querySelectorAll('.is-tall').forEach((el) => {
            if (!m.tall.has(el)) el.classList.remove('is-tall');
          });
          m.tall.forEach((el) => el.classList.add('is-tall'));
          applyClamps();
        },
      });
    }

    // ---- numeric columns ----
    /**
     * A column whose every filled body cell is a number, by the rule sorting and
     * pasting already use, draws its digits at one width so its figures line up.
     * `only` limits the pass to one column, for after one of its cells changed.
     */
    const markNumeric = (only?: number): void => {
      const from = only ?? 0;
      const to = only ?? colCount() - 1;
      for (let c = from; c <= to; c++) {
        let any = false;
        let numeric = true;
        for (const row of data.rows) {
          const v = (row[c] ?? '').trim();
          if (!v) continue;
          if (wholeNumber(v) === null) {
            numeric = false;
            break;
          }
          any = true;
        }
        const on = numeric && any;
        gridHost.querySelectorAll(`tbody td[data-c="${c}"]`).forEach((el) => el.classList.toggle('is-numeric', on));
      }
    };

    // ---- height ----
    // A table that grows or shrinks after it is drawn, as a cell is committed, a
    // picture loads or a column is resized, tells the editor, which otherwise goes
    // on placing everything below at the old height until something else measures.
    let seenHeight = -1;
    const heightObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            const h = wrap.offsetHeight;
            if (!h || h === seenHeight) return;
            seenHeight = h;
            remember(drawnHeights, sig, h);
            view.requestMeasure();
          });
    heightObserver?.observe(wrap);

    // ---- the header row while scrolling ----
    /*
     * The header row stays at the top of the editor while its table is scrolled
     * past, so a long table's columns keep their names.
     *
     * The stylesheet does this with `position: sticky` for a table that fits its
     * frame. A table wider than the pane cannot use it: its frame scrolls sideways,
     * and an element that scrolls on one axis is a scroll container on both, so a
     * sticky row inside it sticks to the frame, which never scrolls up or down. For
     * that table the row is lifted here instead, by the distance the editor has
     * scrolled past the table's top, and never past its last row.
     */
    const stickHeader = (): void => {
      const table = gridTable;
      const head = table?.tHead?.rows[0] as HTMLElement | undefined;
      if (!table || !head) return;
      let lift = 0;
      if (wrap.isConnected && wrap.classList.contains('is-scroll-x')) {
        const frameTop = view.scrollDOM.getBoundingClientRect().top;
        const box = table.getBoundingClientRect();
        lift = Math.max(0, Math.min(frameTop - box.top, box.height - head.offsetHeight));
      }
      const want = lift > 0 ? `translateY(${Math.round(lift)}px)` : '';
      if (head.style.transform !== want) head.style.transform = want;
      head.classList.toggle('is-stuck', lift > 0);
    };
    view.scrollDOM.addEventListener('scroll', stickHeader, { passive: true });

    /**
     * Where a body cell starts to be seen, given the top of the editor's frame: under
     * the header row while that row is stuck to the top of the editor, and the frame's
     * own top otherwise. The row is stuck once the table's top has gone above the
     * frame's, by the stylesheet or by `stickHeader` alike, and it never leaves the
     * table, so near the table's end it covers only what is left of it. This reads the
     * table's box and the row's height rather than where the row is drawn, because a
     * lifted row is moved on the next scroll event, after anything that reads it here.
     */
    const headerFloor = (frameTop: number): number => {
      const table = gridTable;
      const head = table?.tHead?.rows[0] as HTMLElement | undefined;
      if (!table || !head) return frameTop;
      const box = table.getBoundingClientRect();
      if (box.top >= frameTop) return frameTop;
      return Math.max(frameTop, Math.min(frameTop + head.offsetHeight, box.bottom));
    };

    /** New column widths have been written into the table. */
    function columnsLaid(): void {
      wrap.classList.add('has-widths');
      const widths = columns.widths();
      if (widths) remember(laidWidths, tableWidthKey(data.headers), widths);
      // A table that fits fills the text column exactly, row numbers and all, so its
      // widths say how wide that column is without reading the layout again. A quoted
      // table sits inside the quote's indent, so it says nothing about the column.
      const gutterCol = gridTable?.querySelector<HTMLElement>(':scope > colgroup > col');
      const gutter = gutterCol ? parseFloat(gutterCol.style.width) : NaN;
      if (widths && gutter > 0 && !wrap.classList.contains('is-scroll-x') && !wrap.classList.contains('is-quoted')) {
        laidPane = gutter + widths.reduce((a, b) => a + b, 0);
      }
      syncControls();
      measureClamps();
      stickHeader();
    }

    // ---- selection state ----
    // The live block: its corners, and whether it counts. `anchor` is the corner the
    // block started from and `far` the one a drag, Shift-click or Shift+arrow moves.
    // `focus` is the active cell, the one typing replaces. As in a spreadsheet it
    // stays on the anchor while the far end moves, so a drag or Shift+arrow grows
    // the block without moving where typing lands. A whole row or column picked by
    // its number or header puts it on the far end instead, and there it travels
    // with that end, which is how growing such a selection has always worked.
    let anchor: Cell = { r: -1, c: 0 };
    let far: Cell = { r: -1, c: 0 };
    let focus: Cell = { r: -1, c: 0 };
    // Whether the last move grew the block, so the far end is what to keep in view.
    let revealFar = false;
    let hasSel = false;
    // Blocks picked earlier with Cmd-click. They never hold the active cell and
    // never overlap the live block, so the selection is their cells plus its.
    let extra: CellRect[] = [];
    let activeInput: CellEditor | null = null;
    // The editor's value right after opening, or null when typing started the edit.
    let openedWith: string | null = null;
    // True between compositionstart and compositionend in the open cell editor.
    let composing = false;
    // What the open cell editor has written to the document so far, from its first
    // keystroke until it commits or cancels.
    let typing: {
      // The cell's value and its row's auto status before the first keystroke.
      value: string;
      auto: boolean;
      // The cell's source segment then, or null when it had none (see TypingCell).
      seg: string | null;
      // The undo depth before the first keystroke, and the table text last written.
      depth: number;
      text: string;
      // Set when anything but this editor's own keystrokes changed the table since.
      outside: boolean;
    } | null = null;
    let dragging = false;
    // Whether the pointer has moved across the grid since the press. A press that
    // never moved is a click, and a click settles on the cell it was made in.
    let dragMoved = false;
    // A press that landed in an open cell editor's text. It is the text field's own
    // selection drag until it leaves the cell, and a cell range from there on.
    let inputDrag: Cell | null = null;
    // Rows being dragged by a row number: the run of selected rows `lo`..`hi` that
    // the grabbed number `at` belongs to, and the row they would land on. Grabbing
    // one row number of a multi-row selection carries the whole run, as Alt+arrow does.
    let rowDrag: { at: number; lo: number; hi: number; over: number | null; startY: number } | null = null;
    // Columns being dragged by a header, the same way.
    let colDrag: { at: number; lo: number; hi: number; over: number | null; startX: number } | null = null;
    // A run of rows or columns being picked by dragging across their row numbers or
    // headers. Which of the two a press starts is settled by whether the row or
    // column under it is already selected: a selected one moves, as it does in a
    // spreadsheet, and an unselected one selects the run the pointer crosses.
    let axisDrag: { axis: 'row' | 'col'; from: number } | null = null;
    let committed = false; // one-shot: serialize to the doc at most once
    // Rows an outside edit just changed, marked on this DOM's first render only.
    let firstRender = true;
    let justChanged = new Set(view.state.field(changedRows, false) ?? []);

    // A right-click inside the current selection keeps it, so the menu acts on it.
    const keepForMenu = (e: MouseEvent, r: number, c: number): boolean =>
      e.button === 2 && isSelected(r, c);
    const selRect = (): CellRect => ({
      r1: Math.min(anchor.r, far.r),
      r2: Math.max(anchor.r, far.r),
      c1: Math.min(anchor.c, far.c),
      c2: Math.max(anchor.c, far.c),
    });
    /** Every block the selection is made of: the ones picked earlier, then the live one. */
    const selRects = (): CellRect[] => (hasSel ? [...extra, selRect()] : []);
    const isSelected = (r: number, c: number): boolean => selRects().some((q) => inRect(q, r, c));
    /** The smallest block holding every selected cell, for Copy and Paste. */
    const selBounds = (): CellRect => {
      const rects = selRects();
      if (!rects.length) return selRect();
      return rects.reduce((a, q) => ({
        r1: Math.min(a.r1, q.r1),
        r2: Math.max(a.r2, q.r2),
        c1: Math.min(a.c1, q.c1),
        c2: Math.max(a.c2, q.c2),
      }));
    };
    /** Every selected cell, in reading order within each block. */
    const selCells = (): Cell[] => {
      const out: Cell[] = [];
      for (const q of selRects())
        for (let r = q.r1; r <= q.r2; r++) for (let c = q.c1; c <= q.c2; c++) out.push({ r, c });
      return out;
    };
    // A row or column the selection reaches at all. Its row number or header is
    // marked, so a block of cells says which rows and columns it spans. Rows are
    // read straight off the blocks, since a long table has too many to ask about.
    const colCovered = (c: number): boolean => selRects().some((q) => c >= q.c1 && c <= q.c2);
    // A row or column the selection covers end to end. Dragging its row number or
    // header moves it, and only there does the cursor say so.
    // The run of whole rows or columns a row number or header belongs to, which is
    // what a drag on it moves. Null when it is not covered end to end at all. A
    // selection reaching the header row starts its run at the first body row,
    // since the header is not a row that can be reordered.
    const rowRun = (r: number): { lo: number; hi: number } | null => {
      const q = selRects().find((x) => r >= x.r1 && r <= x.r2 && x.c1 === 0 && x.c2 === colCount() - 1);
      return q ? { lo: Math.max(q.r1, 0), hi: q.r2 } : null;
    };
    const colRun = (c: number): { lo: number; hi: number } | null => {
      const q = selRects().find((x) => c >= x.c1 && c <= x.c2 && x.r1 === -1 && x.r2 === lastRow());
      return q ? { lo: q.c1, hi: q.c2 } : null;
    };
    const rowWhole = (r: number): boolean => rowRun(r) !== null;
    const colWhole = (c: number): boolean => colRun(c) !== null;

    // Set once the controls bar has been built. Painting starts before that, and
    // the first render happens while the bar is still nothing, so it does nothing.
    let syncControls: () => void = () => {};

    /*
     * The elements the last paint marked. A paint takes its marks off these and puts
     * them on the new selection, so moving the active cell touches the cells whose
     * state changed and never walks the rest of a long table looking for marks.
     * After a redraw these are elements no longer in the grid, and the new ones
     * carry no marks until the paint that follows.
     */
    let painted = new Set<HTMLElement>();
    const paint = (): void => {
      const before = painted;
      painted = new Set();
      for (const el of before) {
        el.classList.remove('is-sel', 'is-focus', 'is-sel-axis', 'is-sel-whole');
        if (el.getAttribute('aria-selected') === 'true') el.setAttribute('aria-selected', 'false');
      }
      // Without a selection there is no active cell ring, so the grid outlines itself while focused.
      gridHost.classList.toggle('has-selection', hasSel);
      // The bar names what it would act on, which the selection just changed.
      syncControls();
      // The active cell is drawn whole, and the one it moved off is clamped again.
      // Only a cell that was or is now marked can have changed.
      const reclamp = (): void => {
        for (const el of [...before, ...painted]) if (el.matches('.is-tall, .is-clamped')) clampCell(el);
      };
      if (!hasSel) {
        gridHost.removeAttribute('aria-activedescendant');
        reclamp();
        return;
      }
      const mark = (el: HTMLElement | null, ...classes: string[]): void => {
        if (!el) return;
        el.classList.add(...classes);
        painted.add(el);
      };
      for (const { r, c } of selCells()) {
        const el = cellEl(r, c);
        mark(el, 'is-sel');
        el?.setAttribute('aria-selected', 'true');
      }
      // Only the rows a block reaches can have a marked row number.
      const rows = new Set<number>();
      for (const q of selRects()) for (let r = Math.max(0, q.r1); r <= q.r2; r++) rows.add(r);
      for (const r of rows) {
        const el = gutterEl(r);
        mark(el, 'is-sel-axis');
        if (rowWhole(r)) mark(el, 'is-sel-whole');
      }
      for (let c = 0; c < colCount(); c++) {
        const th = cellEl(-1, c);
        if (colCovered(c)) mark(th, 'is-sel-axis');
        if (colWhole(c)) mark(th, 'is-sel-whole');
      }
      const focused = cellEl(focus.r, focus.c);
      mark(focused, 'is-focus');
      if (focused) gridHost.setAttribute('aria-activedescendant', focused.id);
      reclamp();
      // Keep the active cell on screen as the arrows or Tab carry it past an edge,
      // or the far end, when that is what just moved.
      const lead = revealFar ? far : focus;
      const leadEl = cellEl(lead.r, lead.c);
      leadEl?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      // A header row stuck to the top of the editor covers the top of the frame, which
      // scrollIntoView counts as on screen, so a body cell that went under it is
      // brought down to just below it. Only while the grid has the keyboard: a
      // repaint for a write from elsewhere does not move the page.
      if (leadEl && lead.r >= 0 && wrap.contains(document.activeElement)) {
        const under = headerFloor(view.scrollDOM.getBoundingClientRect().top) - leadEl.getBoundingClientRect().top;
        if (under > 0) view.scrollDOM.scrollTop -= under;
      }
      // The row numbers sit left of the first column, so reaching it scrolls all the way left.
      if (leadEl && lead.c === 0) gridHost.scrollLeft = 0;
    };

    /**
     * Bring the active cell into view on the editor's next layout pass, with a few
     * pixels to spare, for the keys that jump far across a tall grid: Cmd+arrow,
     * Cmd+Home and End, Page Up and Down.
     *
     * Paint already scrolls the cell into view the moment the selection moves, which
     * is enough for a step to the next cell. A jump of hundreds of rows moves the
     * scroller far enough that CodeMirror draws a new stretch of the document, and it
     * corrects the scroll position for lines whose drawn height differs from its
     * estimate. Measured in Chromium on an 800-row table, that correction moved the
     * last row 15 pixels down after the reveal, leaving it flush against the frame's
     * bottom edge. So the cell is checked again from inside CodeMirror's layout pass,
     * and once more in the frame after it, rather than trusted from before either.
     */
    const revealKey = {};
    const revealFocus = (again = true): void => {
      const MARGIN = 8;
      view.requestMeasure({
        key: revealKey,
        read: () => {
          const lead = revealFar ? far : focus;
          const el = cellEl(lead.r, lead.c);
          if (!el || !el.isConnected) return 0;
          const frame = view.scrollDOM;
          const top = frame.getBoundingClientRect().top;
          const bottom = top + frame.clientHeight;
          const box = el.getBoundingClientRect();
          // A body cell is seen from under the header row when that row is stuck.
          const floor = lead.r >= 0 ? headerFloor(top) : top;
          // Taller than what is left of the frame: show its top, which is where its text starts.
          if (box.bottom - box.top > bottom - floor - 2 * MARGIN) return box.top - floor - MARGIN;
          if (box.bottom > bottom - MARGIN) return box.bottom - (bottom - MARGIN);
          if (box.top < floor + MARGIN) return box.top - (floor + MARGIN);
          return 0;
        },
        write: (delta) => {
          if (delta) view.scrollDOM.scrollTop += delta;
          // CodeMirror's correction for redrawn lines runs after this, in the same
          // pass, and can carry the cell back to the edge; one more look in the next
          // frame sees where it really ended up.
          if (again && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => revealFocus(false));
        },
      });
    };

    // Growing the live block keeps the blocks picked earlier; starting a new one
    // drops them, the way a plain click in a spreadsheet drops everything.
    // Growing moves the far end; the active cell stays put unless it rides on that
    // end, as it does after a whole row or column was picked.
    const select = (r: number, c: number, extend = false): void => {
      commitCell();
      if (extend) {
        const rides = focus.r === far.r && focus.c === far.c && (focus.r !== anchor.r || focus.c !== anchor.c);
        far = { r, c };
        if (rides) focus = { r, c };
      } else {
        anchor = { r, c };
        far = { r, c };
        focus = { r, c };
        extra = [];
      }
      revealFar = extend;
      hasSel = true;
      paint();
      focusGrid();
    };
    /** Where Shift+arrow and its kin grow the block from: its far end. */
    const growFrom = (extend: boolean): Cell => (extend ? far : focus);
    /** Select the block `a`..`f`, with the active cell on `f` unless `active` names another. */
    const selectRange = (a: Cell, f: Cell, active: Cell = f): void => {
      commitCell();
      extra = [];
      anchor = a;
      far = f;
      focus = active;
      revealFar = false;
      hasSel = true;
      paint();
      focusGrid();
    };
    const clearSel = (): void => {
      commitCell();
      extra = [];
      hasSel = false;
      paint();
    };
    /** The first cell of a list of blocks, reading left to right and top to bottom. */
    const firstOf = (rects: CellRect[]): Cell | null =>
      rects.reduce<Cell | null>(
        (best, q) => (!best || q.r1 < best.r || (q.r1 === best.r && q.c1 < best.c) ? { r: q.r1, c: q.c1 } : best),
        null
      );
    /**
     * Cmd-click: add the cell to the selection, or take it back out when it is
     * already in, so cells that are not next to each other can be picked together.
     *
     * Typing replaces the active cell only, so there has to be exactly one whenever
     * anything is selected. Adding makes the clicked cell active: it is the one just
     * pointed at, and the next keystroke lands where the eye is. Taking the active
     * cell back out moves it to the first cell still picked, which reads as the start
     * of what is left, rather than leaving it on a cell the click just dropped.
     */
    const toggleCell = (r: number, c: number): void => {
      commitCell();
      const rects = selRects();
      const drop = rects.some((q) => inRect(q, r, c));
      const rest = drop ? rects.flatMap((q) => rectWithout(q, r, c)) : rects;
      const active = drop ? (rest.some((q) => inRect(q, focus.r, focus.c)) ? focus : firstOf(rest)) : { r, c };
      extra = active ? rest.flatMap((q) => rectWithout(q, active.r, active.c)) : [];
      hasSel = active !== null;
      if (active) {
        anchor = { ...active };
        far = { ...active };
        focus = { ...active };
      }
      revealFar = false;
      paint();
      focusGrid();
    };

    // ---- find ----
    /**
     * The grid cells holding each of `offsets`, offsets into the table's text taken
     * in ascending order, or null for one that is in no cell: the delimiter row, a
     * fence line, a pipe outside the first or last cell. The text is read once and
     * walked once, so a table with a match on every row costs one pass over it.
     */
    const cellsAtOffsets = (src: string, offsets: readonly number[]): (Cell | null)[] => {
      const out: (Cell | null)[] = offsets.map(() => null);
      const bare = bareTable(src, prefix);
      if (!bare || !offsets.length) return out;
      // Source rows and columns as the grid draws them.
      const rowOf = new Map<number, number>();
      rowOrigin.forEach((k, r) => {
        if (k !== null && !rowOf.has(k)) rowOf.set(k, r);
      });
      const colOf = new Map<number, number>();
      colOrigin.forEach((o, c) => {
        if (o !== null && o >= 0 && !colOf.has(o)) colOf.set(o, c);
      });
      const toGrid = (k: number, o: number): Cell | null => {
        const r = k === -1 ? -1 : rowOf.get(k);
        const c = colOf.get(o);
        return r === undefined || c === undefined ? null : { r, c };
      };
      const { raw, cut } = bare;
      // Where the walk is: the source line, where it starts, and where it starts in the bare text.
      let li = 0;
      let srcStart = 0;
      let bareStart = 0;
      const advance = (at: number): void => {
        while (li < raw.length - 1 && at > srcStart + raw[li].length) {
          srcStart += raw[li].length + 1;
          bareStart += raw[li].length - cut[li] + 1;
          li++;
        }
      };
      if (kind === 'pipe') {
        // Each line's body row (-1 for the header, null for the delimiter row and blank lines).
        const rowAt: (number | null)[] = [];
        for (let i = 0, seen = -1; i < raw.length; i++) {
          rowAt.push(i === 0 ? -1 : i === 1 || raw[i].slice(cut[i]).trim() === '' ? null : ++seen);
        }
        const leads = new Map<number, boolean>();
        offsets.forEach((at, n) => {
          advance(at);
          const k = rowAt[li];
          if (k === null || k === undefined) return;
          const line = raw[li].slice(cut[li]);
          const x = Math.max(0, at - srcStart - cut[li]);
          let pipes = 0;
          for (let i = 0; i < x && i < line.length; i++) {
            if (line[i] === '\\') i++;
            else if (line[i] === '|') pipes++;
          }
          if (!leads.has(li)) leads.set(li, splitRawRow(line).lead);
          const o = pipes - (leads.get(li) ? 1 : 0);
          if (o >= 0) out[n] = toGrid(k, o);
        });
        return out;
      }
      const body = bare.text.indexOf('\n') + 1;
      if (!body) return out;
      const records = delimitedRecords(bare.text.slice(body), lang === 'tsv' ? '\t' : ',');
      let i = 0;
      offsets.forEach((at, n) => {
        advance(at);
        const b = bareStart + Math.max(0, at - srcStart - cut[li]) - body;
        if (b < 0 || !records.length) return;
        while (i + 1 < records.length && records[i + 1].start <= b) i++;
        const fields = records[i].fields;
        let cells = 0;
        for (let f = 0; f < fields.length && fields[f] <= b; f += 2) cells++;
        if (cells > 0) out[n] = toGrid(i - 1, cells - 1);
      });
      return out;
    };

    // The matches last found in this grid, as offsets into its text with the cells
    // they run through, and the query and text they were found for.
    let found: { query: SearchQuery; src: string; hits: { from: number; to: number; cells: Cell[] }[] } | null = null;
    // The cells find has marked, and whether each is the current match's.
    let searchMarked = new Map<HTMLElement, boolean>();
    // Whether the active cell was put there by find rather than by the person, so it
    // goes again once the selection leaves the table.
    let searchShown = false;
    const findHits = (query: SearchQuery, src: string): { from: number; to: number; cells: Cell[] }[] => {
      searchPasses++;
      const ranges: { from: number; to: number }[] = [];
      const cursor = query.getCursor(view.state, pos.from, pos.to);
      for (let step = cursor.next(); !step.done; step = cursor.next()) {
        ranges.push({ from: step.value.from - pos.from, to: step.value.to - pos.from });
      }
      const starts = cellsAtOffsets(src, ranges.map((m) => m.from));
      const ends = cellsAtOffsets(src, ranges.map((m) => Math.max(m.from, m.to - 1)));
      return ranges.map((m, n) => {
        const a = starts[n];
        const b = ends[n];
        const cells: Cell[] = [];
        if (a && b && a.r === b.r) {
          for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) cells.push({ r: a.r, c });
        } else {
          if (a) cells.push(a);
          if (b) cells.push(b);
        }
        return { ...m, cells };
      });
    };
    /** Mark find's matches on the cells holding them, the current match's most strongly. */
    const paintSearch = (): void => {
      const sel = view.state.selection.main;
      const inTable = sel.from >= pos.from && sel.to <= pos.to && sel.from < sel.to;
      if (searchShown && !inTable) {
        searchShown = false;
        if (hasSel && !wrap.contains(document.activeElement)) clearSel();
      }
      const query = gridSearches.get(view) ?? null;
      const want = new Map<HTMLElement, boolean>();
      if (query) {
        const src = view.state.sliceDoc(pos.from, pos.to);
        if (!found || found.src !== src || !found.query.eq(query)) found = { query, src, hits: findHits(query, src) };
        for (const hit of found.hits) {
          const current = inTable && hit.from === sel.from - pos.from && hit.to === sel.to - pos.from;
          for (const { r, c } of hit.cells) {
            const el = cellEl(r, c);
            if (el) want.set(el, current || want.get(el) === true);
          }
        }
      } else found = null;
      for (const [el, current] of searchMarked) {
        if (!want.has(el)) el.classList.remove('cm-searchMatch', 'cm-searchMatch-selected');
        else if (current && !want.get(el)) el.classList.remove('cm-searchMatch-selected');
      }
      for (const [el, current] of want) {
        if (searchMarked.get(el) === current && el.classList.contains('cm-searchMatch')) continue;
        el.classList.add('cm-searchMatch');
        el.classList.toggle('cm-searchMatch-selected', current);
      }
      searchMarked = want;
    };
    liveSearch.set(wrap, paintSearch);
    /** Make the cell holding document offset `at` the active one, and bring it into view. */
    const showMatch = (at: number): boolean => {
      const [cell] = cellsAtOffsets(view.state.sliceDoc(pos.from, pos.to), [at - pos.from]);
      if (!cell) return false;
      commitCell();
      extra = [];
      anchor = { ...cell };
      far = { ...cell };
      focus = { ...cell };
      revealFar = false;
      hasSel = true;
      searchShown = true;
      paint();
      revealFocus();
      return true;
    };

    // ---- writing and history ----
    // Every change reaches the document as it is made: a committed cell edit, and
    // every row, column and table action. A save, a closed tab and the editor's
    // unsaved-changes marker all see what the grid shows. Undo and redo are the
    // document's own history, so Cmd+Z takes back the most recent change wherever
    // in the document it was made.
    let dirty = false;
    /** Call before a change to the model, so the change is written. */
    const record = (): void => {
      dirty = true;
    };
    // The table text this grid is dispatching, so adopting its own write keeps the grid as it is.
    let writing: string | null = null;
    function flush(userEvent = 'input.table', isolate = false): void {
      // Every change to the model passes through here, so the grid's accessible
      // name follows a renamed header at once.
      labelGrid();
      if (!dirty || committed) return;
      dirty = false;
      if (write(view.state.sliceDoc(pos.from, pos.to)) === view.state.sliceDoc(pos.from, pos.to)) return;
      // Undo puts the caret back where it was before a change. Parked at the table,
      // undoing a cell edit keeps the table in view instead of scrolling to the text.
      // Moving the caret can take out lines added above the table, which moves it, so
      // its text is read after.
      const sel = view.state.selection;
      if (sel.ranges.length > 1 || sel.main.anchor !== pos.from || sel.main.head !== pos.from) {
        view.dispatch({ selection: { anchor: pos.from } });
      }
      const src = view.state.sliceDoc(pos.from, pos.to);
      const text = write(src);
      // Only the lines that differ are replaced, so the change is exactly the edit.
      let start = 0;
      while (start < src.length && start < text.length && src[start] === text[start]) start++;
      let end = 0;
      while (end < src.length - start && end < text.length - start && src[src.length - 1 - end] === text[text.length - 1 - end]) end++;
      writing = text;
      try {
        view.dispatch({
          changes: { from: pos.from + start, to: pos.to - end, insert: text.slice(start, text.length - end) },
          effects: tableStep.of({ at: pos.from, undo: cellAt(src, start), redo: cellAt(text, start) }),
          userEvent,
          ...(isolate ? { annotations: isolateHistory.of('before') } : {}),
        });
      } finally {
        writing = null;
      }
    }
    // Step the document's history, then keep focus on the same cell of the table.
    const stepDocument = (step: (target: EditorView) => boolean): void => {
      commitCell();
      const cell = { ...focus };
      if (!step(view)) return;
      if (wrap.isConnected) return void focusGrid();
      // The step rebuilt this table's grid, or removed the table (undoing a paste or
      // an insert), in which case focus goes back to the text rather than another table.
      const landed = view.state.field(stepCell, false);
      for (const el of Array.from(view.dom.querySelectorAll('.sheaf-table'))) {
        const entry = gridEntries.get(el);
        if (entry && entry.from <= pos.from && pos.from <= entry.to) {
          const target = landed && entry.from <= landed.at && landed.at <= entry.to ? landed.cell : cell;
          return entry.focusCell(target.r, target.c);
        }
      }
      view.focus();
    };
    const undo = (): void => stepDocument(undoDocument);
    const redo = (): void => stepDocument(redoDocument);

    // ---- cell editing ----
    // The cell being typed into, for writePipe, while an editor has written to the document.
    function typingCell(): TypingCell | null {
      if (!typing || !activeInput) return null;
      const k = focus.r === -1 ? -1 : rowOrigin[focus.r];
      const o = columnSource(colOrigin[focus.c] ?? null);
      return k === null || k === undefined || o === null ? null : { k, o, seg: typing.seg };
    }

    // What is typed into a cell reaches the document with each keystroke, as typing
    // in the text does, so the unsaved marker, a save and closing the tab all see it.
    // Consecutive keystrokes in one cell join into one undo step, as typing does.
    // Text an input method is still composing waits until composition ends.
    const writeTyped = (): void => {
      const input = activeInput;
      if (!input || composing || committed) return;
      if (input.value === getCell(focus.r, focus.c)) return;
      const first = !typing;
      if (!typing) {
        const src = view.state.sliceDoc(pos.from, pos.to);
        const k = focus.r === -1 ? -1 : rowOrigin[focus.r];
        const o = columnSource(colOrigin[focus.c] ?? null);
        const bare = kind === 'pipe' ? bareTable(src, prefix) : null;
        const span = bare && k !== null && k !== undefined ? bareRowSpan(bare.text, k) : null;
        const seg = bare && span && o !== null ? splitRawRow(bare.text.slice(span.from, span.to)).cells[o] ?? null : null;
        typing = {
          value: getCell(focus.r, focus.c),
          auto: focus.r >= 0 && autoRows.has(data.rows[focus.r]),
          seg,
          depth: undoDepth(view.state),
          text: src,
          outside: false,
        };
      }
      record();
      setCell(focus.r, focus.c, input.value);
      flush('input.type', first);
      typing.text = view.state.sliceDoc(pos.from, pos.to);
    };

    // Ends a typing session. A row that was appended past the end and now holds a
    // value is an ordinary row from here on, as a committed edit makes it.
    const endTyping = (): void => {
      typing = null;
      composing = false;
      const row = focus.r >= 0 ? data.rows[focus.r] : undefined;
      if (row && row.some((v) => v !== '')) autoRows.delete(row);
    };

    const commitCell = (): void => {
      const editor = activeInput;
      if (!editor) return;
      // A cell opened and left as it was keeps the model's value exactly, even
      // where the editor normalized it on the way in (a textarea turns \r\n into \n).
      if (editor.value !== openedWith) {
        if (editor.value !== getCell(focus.r, focus.c)) record();
        setCell(focus.r, focus.c, editor.value);
      }
      // Typed text is already written, so this writes only a value set without a
      // keystroke. The editor is still the active one while it runs, because the
      // write reads the segment the cell was being typed into (see `typingCell`).
      flush();
      activeInput = null;
      editor.destroy();
      endTyping();
      const el = cellEl(focus.r, focus.c);
      if (el) drawCell(el, getCell(focus.r, focus.c));
      markNumeric(focus.c);
    };

    // Escape backs out of an edit: the cell and the document go back to what they
    // held before the typing. When the typing is still the latest thing in the undo
    // history, it is undone and then dropped from the redo history, so it leaves no
    // step behind on either side; otherwise, as after an outside change to the
    // table, the earlier value is written back over it.
    const cancelCell = (): void => {
      const editor = activeInput;
      if (!editor) return;
      const session = typing;
      if (session) {
        const r = focus.r;
        const c = focus.c;
        const steps = undoDepth(view.state) - session.depth;
        const clean =
          !session.outside && steps > 0 && view.state.sliceDoc(pos.from, pos.to) === session.text;
        activeInput = null;
        if (clean) {
          for (let i = 0; i < steps; i++) undoDocument(view);
          forgetRedo(view);
          // Undoing takes out the line typing gave a row appended past the end, and
          // the grid rebuilt from the file loses the row; it is still there, empty.
          if (session.auto && r >= rowCount()) {
            while (rowCount() <= r) addRowAt(lastRow(), true);
            anchor = { r, c };
            far = { r, c };
            focus = { r, c };
          }
        }
        if (getCell(r, c) !== session.value) {
          // Not undone: write the earlier value back, into the segment as it was.
          activeInput = editor;
          record();
          setCell(r, c, session.value);
          flush();
          activeInput = null;
        }
        const row = r >= 0 ? data.rows[r] : undefined;
        if (row && session.auto && row.every((v) => v === '')) autoRows.add(row);
      }
      activeInput = null;
      editor.destroy();
      typing = null;
      composing = false;
      const el = cellEl(focus.r, focus.c);
      if (el) drawCell(el, getCell(focus.r, focus.c));
      markNumeric(focus.c);
    };

    const edit = (initial?: string): void => {
      const el = cellEl(focus.r, focus.c);
      if (!el) return;
      if (activeInput) {
        activeInput.destroy();
        activeInput = null;
      }
      const value = initial ?? getCell(focus.r, focus.c);
      // The value's own box, which is what the table measures. The editor lies over
      // the cell and is out of the flow, so the column keeps the width its text asks
      // for rather than the twenty-odd characters a form control asks for.
      const sizer = document.createElement('span');
      sizer.className = 'sheaf-table-sizer';
      const column = data.headers[focus.c]?.trim() || `Column ${focus.c + 1}`;
      const label = focus.r === -1 ? `Header of ${column}` : `${column}, row ${focus.r + 1}`;
      // Nothing is added to the text the column is measured from, so opening a cell
      // asks for exactly the width its value already asked for. A pipe-table cell
      // goes on being drawn while it is typed into, so it is measured against what
      // it draws rather than against its Markdown; a data field is its own text. A
      // value with no line to sit on, an empty one or one ending in a line break,
      // gets a zero-width space: enough for the line the editor draws, and no wider.
      let rendered = kind === 'pipe';
      const measure = (v: string): void => {
        if (rendered && v !== '') sizer.innerHTML = renderInline(v);
        else sizer.textContent = v === '' || v.endsWith('\n') ? v + '\u200b' : v;
      };
      measure(value);
      const editor: CellEditor = createCellEditor({
        // A CSV or TSV field holds data, and drawing it as Markdown would be wrong.
        markdown: kind === 'pipe',
        value,
        selectAll: initial === undefined,
        label,
        onMeasure: measure,
        onInput: () => {
          if (activeInput === editor) writeTyped();
        },
        onComposing: (on) => {
          if (activeInput !== editor) return;
          composing = on;
          if (!on) writeTyped();
        },
        onEnter: (back) => {
          commitCell();
          enterMove(back ? -1 : 1);
        },
        onTab: (back) => {
          commitCell();
          tabMove(back ? -1 : 1);
        },
        onEscape: () => {
          cancelCell();
          select(focus.r, focus.c);
        },
        onPointerDown: () => {
          inputDrag = { r: focus.r, c: focus.c };
        },
        // Undo or redo past the cell's own history steps the document, as the same
        // key does on the grid. The cell closes first without writing what it holds:
        // it has nothing of its own to take back, so what it shows is either the
        // file's value already or text a write from outside took, which the step on
        // top of the history is there to give back. With no step to take, the cell
        // stays open and keeps its text.
        onHistoryEnd: (again) => {
          if (activeInput !== editor || composing) return;
          if ((again ? redoDepth(view.state) : undoDepth(view.state)) === 0) return;
          activeInput = null;
          editor.destroy();
          endTyping();
          const el = cellEl(focus.r, focus.c);
          if (el) drawCell(el, getCell(focus.r, focus.c));
          if (again) redo();
          else undo();
        },
      });
      // A cell that could not be built as a rendered surface opens as the plain
      // box instead, and is measured against its text rather than its drawing.
      if (rendered !== editor.rendered) {
        rendered = editor.rendered;
        measure(editor.value);
      }
      // A cell opened and left as it was keeps the model's value exactly, even
      // where the editor normalized it on the way in (a textarea turns \r\n into \n).
      openedWith = initial === undefined ? editor.value : null;
      const mark = axisMark(el);
      el.textContent = '';
      el.classList.add('is-editing');
      // An open cell is never clamped: the caret has to be able to reach every line.
      clampCell(el);
      el.append(sizer, editor.host);
      // The chevron is the header's, not the text's. It is hidden while the cell is
      // open (see the stylesheet) and is there again the moment the editor closes.
      // The width grip stays usable: widening a column while typing in it is fine.
      el.append(...mark);
      activeInput = editor;
      composing = false;
      // Only as far as the cell itself needs to come into view: a cell opened from
      // the keyboard may have been scrolled away, and a double-clicked one is under
      // the pointer, where this does nothing.
      editor.focus();
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };

    // ---- navigation ----
    const clampCol = (c: number): number => Math.max(0, Math.min(colCount() - 1, c));
    const clampRow = (r: number): number => Math.max(-1, Math.min(lastRow(), r));

    const arrow = (dr: number, dc: number, extend: boolean): void => {
      const from = growFrom(extend);
      select(clampRow(from.r + dr), clampCol(from.c + dc), extend);
    };
    const linear = (r: number, c: number): number => (r + 1) * colCount() + c;
    const unlinear = (i: number): Cell => {
      const cols = colCount();
      return { r: Math.floor(i / cols) - 1, c: i % cols };
    };
    const tabMove = (dir: number): void => {
      const total = (rowCount() + 1) * colCount();
      let i = linear(focus.r, focus.c) + dir;
      if (i < 0) i = 0;
      if (i >= total) addRowAt(lastRow(), true); // append and fall through
      const cell = unlinear(Math.min(i, (rowCount() + 1) * colCount() - 1));
      select(cell.r, cell.c);
    };
    const enterMove = (dir: number): void => {
      let r = focus.r + dir;
      if (r > lastRow()) {
        addRowAt(lastRow(), true);
        r = lastRow();
      }
      select(clampRow(r), focus.c);
    };

    // ---- structural edits (model + DOM, no doc write) ----
    function addRowAt(afterR: number, auto = false): void {
      commitCell();
      record();
      const row: string[] = new Array(colCount()).fill('');
      if (auto) autoRows.add(row);
      data.rows.splice(afterR + 1, 0, row);
      rowOrigin.splice(afterR + 1, 0, null);
      render();
    }
    // Duplicates rows r..last, placing the copies after the last of them.
    function dupRowAt(r: number, last = r): void {
      commitCell();
      if (r < 0 || last >= rowCount()) return;
      record();
      const copies = data.rows.slice(r, last + 1).map((row, i) => {
        const copy = [...row];
        const source = rowOrigin[r + i] ?? dupSource.get(row);
        if (source !== undefined && source !== null) dupSource.set(copy, source);
        return copy;
      });
      data.rows.splice(last + 1, 0, ...copies);
      rowOrigin.splice(last + 1, 0, ...copies.map(() => null));
      render();
    }
    // Reordering moves whole rows or cell segments; the write emits each moved line
    // or segment from its own source, so the diff is a permutation and nothing else.
    // A block of selected rows or columns moves by carrying its neighbour on that
    // side across to the other side, and the selection moves with it. A selection
    // spanning the whole axis (a whole row, for a column move) moves only the row or
    // column of the clicked cell `at`, and nothing from the keyboard, where there is none.
    function moveSpan(
      vertical: boolean,
      a: Cell,
      f: Cell,
      at: Cell | null
    ): { lo: number; hi: number; a: Cell; f: Cell } | null {
      const lo = vertical ? Math.min(a.r, f.r) : Math.min(a.c, f.c);
      const hi = vertical ? Math.max(a.r, f.r) : Math.max(a.c, f.c);
      const whole = hi > lo && (vertical ? lo === -1 && hi === lastRow() : lo === 0 && hi === colCount() - 1);
      if (!whole) return { lo, hi, a, f };
      if (!at) return null;
      const line = vertical ? at.r : at.c;
      return { lo: line, hi: line, a: at, f: at };
    }
    function moveBlock(dir: 'up' | 'down' | 'left' | 'right', from: Cell, to: Cell, at: Cell | null = null): void {
      const span = moveSpan(dir === 'up' || dir === 'down', from, to, at);
      if (!span) return;
      const { lo, hi, a, f } = span;
      // The active cell moves with the block when it is in it, and keeps its place there.
      const block = { r1: Math.min(a.r, f.r), r2: Math.max(a.r, f.r), c1: Math.min(a.c, f.c), c2: Math.max(a.c, f.c) };
      const act = inRect(block, focus.r, focus.c) ? focus : f;
      const shift = (dr: number, dc: number): void =>
        selectRange({ r: a.r + dr, c: a.c + dc }, { r: f.r + dr, c: f.c + dc }, { r: act.r + dr, c: act.c + dc });
      if (dir === 'up' && lo > 0) {
        moveRowTo(lo - 1, hi);
        shift(-1, 0);
      } else if (dir === 'down' && lo >= 0 && hi < lastRow()) {
        moveRowTo(hi + 1, lo);
        shift(1, 0);
      } else if (dir === 'left' && lo > 0) {
        moveColTo(lo - 1, hi);
        shift(0, -1);
      } else if (dir === 'right' && hi < colCount() - 1) {
        moveColTo(hi + 1, lo);
        shift(0, 1);
      }
    }
    // A one-shot sort that reorders the rows themselves, numbers compared as
    // numbers and empty cells kept at the bottom in either direction.
    function sortRows(c: number, descending: boolean): void {
      commitCell();
      if (rowCount() < 2) return;
      record();
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      // Compare what the cell shows, not how it is written: a bold cell is drawn
      // without its asterisks and a link without its address, so each sorts under
      // the word a reader sees. Only the key changes; the file keeps its Markdown,
      // and sorting still moves whole lines and nothing else. A CSV field shows its
      // own text, so that is its key.
      const shown = (cell: string): string => {
        if (kind !== 'pipe') return cell.trim();
        const box = document.createElement('div');
        box.innerHTML = renderInline(cell);
        return (box.textContent ?? '').trim();
      };
      const order = data.rows.map((row, i) => ({ row, origin: rowOrigin[i], key: shown(row[c] ?? '') }));
      // Read once, from the whole column, so every cell in it is compared the same way.
      const dateOrder = columnDateOrder(order.map((o) => o.key));
      order.sort((a, b) => {
        const x = a.key;
        const y = b.key;
        if (x === y) return 0;
        if (!x) return 1;
        if (!y) return -1;
        // A date is compared as a date before anything else. The number reader stops
        // at the first slash, so 12/31/2023 would be ordered by its month alone, which
        // puts a 2024 date above a 2023 one. A column whose date order cannot be read
        // has no date comparison at all, and falls through to the text below.
        const [dx, dy] = dateOrder ? [dateValue(x, dateOrder), dateValue(y, dateOrder)] : [null, null];
        const byDate = dx !== null && dy !== null && dx !== dy ? Math.sign(dx - dy) : 0;
        const [nx, ny] = [leadingNumber(x), leadingNumber(y)];
        const byValue = nx !== null && ny !== null && nx !== ny ? Math.sign(nx - ny) : 0;
        return (byDate || byValue || collator.compare(x, y)) * (descending ? -1 : 1);
      });
      data.rows.splice(0, data.rows.length, ...order.map((o) => o.row));
      rowOrigin.splice(0, rowOrigin.length, ...order.map((o) => o.origin));
      render();
    }
    // Alignment lives in the delimiter row, so only that column's delimiter cell changes.
    function alignCol(c: number, align: Align): void {
      commitCell();
      if (data.aligns[c] === align) return;
      record();
      data.aligns[c] = align;
      render();
    }
    // A duplicated column copies each cell and records its source, so the write
    // reuses the source column's segments and the copy is byte-identical.
    function dupColAt(c: number, last = c): void {
      commitCell();
      if (c < 0 || last >= colCount()) return;
      record();
      const width = last - c + 1;
      const sources = colOrigin.slice(c, last + 1).map((origin) => {
        const source = columnSource(origin);
        return source === null ? null : -(source + 1);
      });
      data.headers.splice(last + 1, 0, ...data.headers.slice(c, last + 1));
      data.aligns.splice(last + 1, 0, ...data.aligns.slice(c, last + 1));
      colOrigin.splice(last + 1, 0, ...sources);
      for (const row of data.rows) row.splice(last + 1, 0, ...Array.from({ length: width }, (_, i) => row[c + i] ?? ''));
      render();
    }
    // The one table action that rewrites every line, and only when asked: pad the
    // table so its columns line up in a plain text editor, keeping each column's
    // alignment. Unsaved edits are written first so the padding is its own undo step.
    function padColumns(r: number, c: number): void {
      commitCell();
      const src = view.state.sliceDoc(pos.from, pos.to);
      const pending = write(src);
      if (pending !== src) {
        committed = true; // the write replaces this grid
        view.dispatch({ changes: { from: pos.from, to: pos.to, insert: pending } });
      }
      let range: { from: number; to: number } | null = null;
      view.state.field(tableField).between(pos.from, pos.from, (from, to) => {
        if (from === pos.from) range = { from, to };
      });
      const found = range as { from: number; to: number } | null;
      if (!found) return;
      const text = view.state.sliceDoc(found.from, found.to);
      // A table in a blockquote is padded as it reads inside the quote, and every
      // line goes back into the quote.
      const bare = bareTable(text, prefix);
      const parsed = bare && parsePipeTable(bare.text);
      if (!bare || !parsed) return;
      // An indented table, such as one inside a list item, keeps its indentation on
      // every line, or padding would move it out of the block it belongs to.
      const line = view.state.doc.lineAt(found.from);
      const indent = /^[ \t]*/.exec(prefix ? bare.text : line.text)![0];
      const firstIndent = prefix ? indent : indent.slice(Math.min(indent.length, found.from - line.from));
      // The header says how many columns the table has, so a row carrying more cells
      // than the header lines up without widening the table.
      const padded = formatPipeTable([parsed.headers, ...parsed.rows], parsed.aligns, parsed.headers.length)
        .split('\n')
        .map((l, i) => (i === 0 ? firstIndent : indent) + l)
        .join('\n');
      const tidy = dressTable(bare, padded, prefix);
      if (tidy !== text) {
        let first = 0;
        while (first < text.length && first < tidy.length && text[first] === tidy[first]) first++;
        view.dispatch({
          changes: { from: found.from, to: found.to, insert: tidy },
          effects: tableStep.of({ at: found.from, undo: cellAt(text, first), redo: cellAt(tidy, first) }),
          // Its own undo step on both sides, however quickly the next edit follows.
          annotations: isolateHistory.of('full'),
          userEvent: 'input.table.pad',
        });
      }
      for (const el of Array.from(view.dom.querySelectorAll('.sheaf-table'))) {
        const entry = gridEntries.get(el);
        if (entry && entry.from === found.from) return entry.focusCell(r, c);
      }
    }
    function addColAt(afterC: number): void {
      commitCell();
      record();
      data.headers.splice(afterC + 1, 0, '');
      colOrigin.splice(afterC + 1, 0, null);
      data.aligns.splice(afterC + 1, 0, null);
      for (const row of data.rows) row.splice(afterC + 1, 0, '');
      render();
    }
    function delRowAt(r: number, last = r): void {
      commitCell();
      if (r >= 0 && rowCount() > 0) {
        record();
        data.rows.splice(r, last - r + 1);
        rowOrigin.splice(r, last - r + 1);
      }
      render();
    }
    function delColAt(c: number, last = c): void {
      commitCell();
      const width = last - c + 1;
      if (colCount() > width) {
        record();
        data.headers.splice(c, width);
        colOrigin.splice(c, width);
        data.aligns.splice(c, width);
        for (const row of data.rows) row.splice(c, width);
      }
      render();
    }
    // ---- commands ----
    /**
     * What a command reached from cell `r`,`c` acts on: the selection when that
     * cell is inside it, else the cell on its own. This is the one place the rule
     * is written, and the bar, the chevron menus and the right-click menu all come
     * through here, so no surface can drift into acting on something else.
     */
    const commandSpan = (
      r: number,
      c: number
    ): { at: Cell; a: Cell; f: Cell; row: { lo: number; hi: number; a: Cell; f: Cell }; col: { lo: number; hi: number; a: Cell; f: Cell } } => {
      const s = selRect();
      const inSel = hasSel && r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;
      const at: Cell = { r, c };
      const [a, f] = inSel ? [{ ...anchor }, { ...far }] : [at, at];
      return { at, a, f, row: moveSpan(true, a, f, at)!, col: moveSpan(false, a, f, at)! };
    };
    /** The same span, as the registry reads it. */
    const commandTarget = (r: number, c: number): TableCommandTarget => {
      const { row, col } = commandSpan(r, c);
      return {
        kind,
        rowLo: row.lo,
        rowHi: row.hi,
        colLo: col.lo,
        colHi: col.hi,
        lastRow: lastRow(),
        rows: rowCount(),
        cols: colCount(),
        aligned: !!data.aligns[c],
        measured: !!columns.measured(),
        pinned: !!pins()?.size,
        fenced: kind === 'csv' && !!moveToFile,
        movable: kind === 'csv' && !!moveToFile && !view.state.readOnly,
      };
    };
    /**
     * What each command does, bound to that span. Every one of them goes through
     * the same row and column functions the menu has always called, so reaching a
     * command from a new surface cannot write anything the old one would not have.
     */
    const commandRunner = (r: number, c: number): Record<TableCommandId, () => void> => {
      const { at, a, f, row, col } = commandSpan(r, c);
      const rowsShifted = (n: number): void => selectRange({ r: row.a.r + n, c: row.a.c }, { r: row.f.r + n, c: row.f.c });
      const colsShifted = (n: number): void => selectRange({ r: col.a.r, c: col.a.c + n }, { r: col.f.r, c: col.f.c + n });
      return {
        'row.insertAbove': () => (addRowAt(row.lo - 1), select(row.lo, c)),
        'row.insertBelow': () => (addRowAt(row.hi), select(row.hi + 1, c)),
        'row.duplicate': () => (dupRowAt(row.lo, row.hi), rowsShifted(row.hi - row.lo + 1)),
        'row.moveUp': () => moveBlock('up', a, f, at),
        'row.moveDown': () => moveBlock('down', a, f, at),
        'row.delete': () => (delRowAt(row.lo, row.hi), select(clampRow(row.lo), c)),
        'col.insertLeft': () => (addColAt(col.lo - 1), select(r, col.lo)),
        'col.insertRight': () => (addColAt(col.hi), select(r, col.hi + 1)),
        'col.duplicate': () => (dupColAt(col.lo, col.hi), colsShifted(col.hi - col.lo + 1)),
        'col.moveLeft': () => moveBlock('left', a, f, at),
        'col.moveRight': () => moveBlock('right', a, f, at),
        'col.delete': () => (delColAt(col.lo, col.hi), select(r, clampCol(col.lo))),
        'col.sortAsc': () => (sortRows(c, false), select(r, c)),
        'col.sortDesc': () => (sortRows(c, true), select(r, c)),
        'col.alignLeft': () => (alignCol(c, 'left'), select(r, c)),
        'col.alignCenter': () => (alignCol(c, 'center'), select(r, c)),
        'col.alignRight': () => (alignCol(c, 'right'), select(r, c)),
        'col.alignClear': () => (alignCol(c, null), select(r, c)),
        'table.pad': () => padColumns(r, c),
        'table.fitColumns': () => fitColumns(),
        'table.resetWidths': () => setPins(null, true),
        'table.showAsBoard': () => chooseGroup(cellEl(r, c)),
        'table.moveToFile': () => {
          // Whatever the grid holds reaches the document first, so the file gets it too.
          commitCell();
          flush();
          moveToFile?.(view, pos.from);
        },
      };
    };
    /**
     * Pin every column at the width its content asks for, so nothing in it wraps.
     * A table that comes out wider than the pane scrolls in its frame, as any
     * table too wide for it does.
     */
    const fitColumns = (): void => {
      const m = columns.measured();
      if (!m) return;
      const next = new Map<number, number>();
      m.columns.forEach((col, c) => next.set(c, Math.max(1, Math.ceil(Math.max(col.max, col.min)))));
      setPins(next, true);
    };
    /**
     * The registry as a list of menu items for the cell `r`,`c`, in registry order
     * and grouped the way the registry groups it. `keepDisabled` is what separates
     * the surfaces: the right-click menu drops what cannot run, and everything else
     * keeps it in place and dims it. A group whose commands were all dropped leaves
     * its separator to the next command that is offered, so no menu opens on a rule.
     */
    const menuActions = (r: number, c: number, keepDisabled: boolean, only?: 'row' | 'column'): TableAction[] => {
      const target = commandTarget(r, c);
      const run = commandRunner(r, c);
      // The insert and delete keys name the command only when pressing them now would
      // run it: the selection is whole rows or whole columns, and this cell is in it.
      const s = selRect();
      const keyed = hasSel && r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2 ? keyAxis() : null;
      const items: TableAction[] = [];
      let separator = false;
      for (const cmd of TABLE_COMMANDS) {
        if (only && cmd.scope !== only) continue;
        if ('offered' in cmd && cmd.offered && !cmd.offered(target)) continue;
        if (cmd.startsGroup) separator = items.length > 0;
        const disabled = !cmd.enabled(target);
        if (disabled && !keepDisabled) continue;
        const keyHint = keyed === cmd.scope ? AXIS_KEYS[cmd.id] : undefined;
        items.push({ id: cmd.id, label: cmd.label(target), icon: cmd.icon, run: run[cmd.id], separator, disabled, ...(keyHint ? { keyHint } : {}) });
        separator = false;
      }
      return items;
    };
    /**
     * Whether the selection is whole rows or whole columns, which is when the insert
     * and delete keys act. Columns win when it is both, as the whole table is: a
     * selection running from the header to the last row is what a header click makes.
     * Cells picked one at a time, or a block short of either, are neither.
     */
    function keyAxis(): 'row' | 'column' | null {
      if (!hasSel || extra.length) return null;
      const s = selRect();
      if (s.r1 === -1 && s.r2 === lastRow()) return 'column';
      if (s.c1 === 0 && s.c2 === colCount() - 1) return 'row';
      return null;
    }
    /**
     * Cmd+Alt+= and Cmd+Alt+- (Ctrl+Alt off the Mac) on whole rows or columns: insert
     * one after the selection, or delete the selection, through the same commands the
     * menu runs and under the same rules, so a case the menu dims does nothing here.
     * The new row or column, or the one that takes the deleted ones' place, is then
     * selected whole, so pressing the key again goes on doing the same thing. Returns
     * false when the selection is only cells, so the key is left to whatever else takes it.
     */
    const axisKey = (insert: boolean): boolean => {
      const axis = keyAxis();
      if (!axis) return false;
      const r = focus.r;
      const c = focus.c;
      const id: TableCommandId = axis === 'row' ? (insert ? 'row.insertBelow' : 'row.delete') : insert ? 'col.insertRight' : 'col.delete';
      const spec = TABLE_COMMANDS.find((x) => x.id === id)!;
      if (!spec.enabled(commandTarget(r, c))) return true;
      const { row, col } = commandSpan(r, c);
      commandRunner(r, c)[id]();
      if (axis === 'row') {
        const at = insert ? row.hi + 1 : clampRow(row.lo);
        if (at >= 0 && at <= lastRow()) selectRange({ r: at, c: colCount() - 1 }, { r: at, c: 0 });
      } else {
        const at = insert ? col.hi + 1 : clampCol(col.lo);
        selectRange({ r: lastRow(), c: at }, { r: -1, c: at });
      }
      return true;
    };

    const clearSelected = (): void => {
      const cells = selCells();
      if (cells.some(({ r, c }) => getCell(r, c) !== '')) record();
      for (const { r, c } of cells) {
        setCell(r, c, '');
        const el = cellEl(r, c);
        if (!el) continue;
        const mark = axisMark(el);
        el.textContent = '';
        el.append(...mark);
        el.classList.remove('is-tall');
        clampCell(el);
      }
      markNumeric();
      flush();
    };

    // ---- clipboard ----
    const rectToGrid = (): string[][] => {
      const { r1, r2, c1, c2 } = selBounds();
      const out: string[][] = [];
      for (let r = r1; r <= r2; r++) {
        const line: string[] = [];
        for (let c = c1; c <= c2; c++) {
          // Cells picked one at a time leave gaps between them. Those come out empty,
          // so the block pastes back in the shape it was picked and carries nothing
          // the person did not select.
          const v = isSelected(r, c) ? getCell(r, c) : '';
          // A spreadsheet wants the value, not the pipe table's escape for it; a
          // paste back into a pipe table escapes the pipe again.
          line.push(kind === 'pipe' ? v.replace(/\\\|/g, '|') : v);
        }
        out.push(line);
      }
      return out;
    };
    // A selection reaching every column of every row it touches is whole lines, and
    // a ref quotes the file's own text for those, as it does for a prose selection.
    const wholeLines = (): boolean => {
      const { r1, r2 } = selBounds();
      for (let r = r1; r <= r2; r++) for (let c = 0; c < colCount(); c++) if (!isSelected(r, c)) return false;
      return true;
    };
    /**
     * What Copy ref quotes for the current selection, or null when the selection is
     * whole lines and the file's own text says it better. Anything narrower is the
     * picked cells in the shape they were picked, from the same builder the
     * clipboard copy uses, so a ref and a copy cannot say different things.
     */
    const selectionQuote = (): string | null => {
      if (wholeLines()) return null;
      const g = rectToGrid();
      const { r1, c1, c2 } = selBounds();
      return kind === 'pipe'
        ? quotePipeRows(g, data.aligns.slice(c1, c2 + 1), r1 === -1)
        : quoteDelimitedRows(g, lang === 'tsv' ? '\t' : ',');
    };
    // Rows and columns as the grid shows them, for a ref's label: the gutter's own
    // numbers rather than file lines, and a column by the header a person reads.
    const rowsLabel = (r1: number, r2: number): string => {
      if (r1 === r2) return r1 === -1 ? 'header row' : `row ${r1 + 1}`;
      return r1 === -1 ? `header to row ${r2 + 1}` : `rows ${r1 + 1} to ${r2 + 1}`;
    };
    const colName = (c: number): string => headerName(data.headers[c] ?? '') || `column ${c + 1}`;
    const colsLabel = (c1: number, c2: number): string => (c1 === c2 ? colName(c1) : `${colName(c1)} to ${colName(c2)}`);
    /**
     * What Copy ref says for a right-click on cell `r`,`c`: the selection when the
     * cell is in it, and that one cell when it is not. Whole rows quote their lines,
     * whole columns and anything narrower quote what was picked, and the whole
     * table is named by its lines alone, as it always was.
     */
    const cellRef = (r: number, c: number): TableRef => {
      const lines = pendingRows.get(wrap)!;
      const picked = hasSel && isSelected(r, c);
      const b = picked ? selBounds() : { r1: r, r2: r, c1: c, c2: c };
      const on = (rr: number, cc: number): boolean => (picked ? isSelected(rr, cc) : rr === r && cc === c);
      const covers = (r1: number, r2: number, c1: number, c2: number): boolean => {
        for (let rr = r1; rr <= r2; rr++) for (let cc = c1; cc <= c2; cc++) if (!on(rr, cc)) return false;
        return true;
      };
      const wholeRows = covers(b.r1, b.r2, 0, colCount() - 1);
      const wholeCols = b.r1 === -1 && b.r2 === lastRow() && covers(-1, lastRow(), b.c1, b.c2);
      if (wholeRows && wholeCols) return lines(1, 0);
      if (wholeRows) return { ...lines(b.r1, b.r2), label: rowsLabel(b.r1, b.r2) };
      if (wholeCols) {
        const named = headerName(data.headers[b.c1] ?? '');
        const label = b.c1 !== b.c2 ? `${colsLabel(b.c1, b.c2)} columns` : named ? `${named} column` : `column ${b.c1 + 1}`;
        return { ...lines(-1, lastRow()), text: selectionQuote() ?? '', label };
      }
      const label = `${colsLabel(b.c1, b.c2)}, ${rowsLabel(b.r1, b.r2)}`;
      // One cell quotes its text as a person reads it, with a pipe table's escape taken off.
      const text =
        b.r1 === b.r2 && b.c1 === b.c2
          ? kind === 'pipe'
            ? getCell(b.r1, b.c1).replace(/\\\|/g, '|')
            : getCell(b.r1, b.c1)
          : (selectionQuote() ?? '');
      return { ...lines(b.r1, b.r2), text, label };
    };
    const gridToTSV = (g: string[][]): string => g.map((r) => r.join('\t')).join('\n');
    const gridToHTML = (g: string[][]): string =>
      '<table>' +
      g
        .map(
          (r) =>
            '<tr>' +
            r.map((c) => `<td>${c.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`).join('') +
            '</tr>'
        )
        .join('') +
      '</table>';

    const pasteGrid = (g: string[][], r0: number, c0: number): void => {
      record();
      const wide = c0 + Math.max(...g.map((row) => row.length));
      while (colCount() < wide) addColSilent();
      for (let i = 0; i < g.length; i++) {
        const r = r0 + i;
        if (r >= 0) {
          while (rowCount() <= r) {
            data.rows.push(new Array(colCount()).fill(''));
            rowOrigin.push(null);
          }
        }
        for (let j = 0; j < g[i].length; j++) setCell(r, c0 + j, g[i][j]);
      }
      render();
      extra = [];
      anchor = { r: r0, c: c0 };
      far = { r: r0 + g.length - 1, c: wide - 1 };
      focus = { ...far };
      revealFar = false;
      hasSel = true;
      paint();
      focusGrid();
    };
    const addColSilent = (): void => {
      data.headers.push('');
      colOrigin.push(null);
      data.aligns.push(null);
      for (const row of data.rows) row.push('');
    };

    const clip: GridClipboardApi = {
      // An open cell keeps its own copy and paste, so a word cut out of a cell's
      // text is that word and not the whole cell. Blocks of cells are the grid's
      // own, and the grid only has the keyboard while no cell is open: that is
      // the test, rather than where focus is reported, because a cell editor is
      // a CodeMirror view and the focused element inside one is its content.
      contains: (n) => !activeInput && wrap.contains(n),
      copy: (e) => {
        if (!hasSel || !e.clipboardData) return;
        e.preventDefault();
        const g = rectToGrid();
        e.clipboardData.setData('text/plain', gridToTSV(g));
        e.clipboardData.setData('text/html', gridToHTML(g));
      },
      cut: (e) => {
        clip.copy(e);
        clearSelected();
      },
      paste: (e) => {
        const text = e.clipboardData?.getData('text/plain');
        if (!text) return;
        e.preventDefault();
        // A pipe-table cell is one line, and its writer puts a space where a line
        // break was; the grid holds the value that way too, so it shows what is
        // written. A CSV or TSV field keeps its line break.
        const read = parseClipboardGrid(text);
        const g = kind === 'pipe' ? read.map((row) => row.map((v) => v.replace(/\n/g, ' '))) : read;
        const { r1, r2, c1, c2 } = selBounds();
        if (hasSel && g.length === 1 && g[0].length === 1 && (r1 !== r2 || c1 !== c2)) {
          // One value over a selection fills every selected cell, as a spreadsheet does.
          // A column picked by its header fills its body: the header names the column
          // and is not one of its values. A header cell picked on its own still takes it.
          record();
          const wholeCol = (c: number): boolean => lastRow() >= 0 && colWhole(c);
          for (const { r, c } of selCells()) if (r >= 0 || !wholeCol(c)) setCell(r, c, g[0][0]);
          render();
          return;
        }
        // A block starts at the selection's top-left, wherever the active cell is.
        pasteGrid(g, hasSel ? r1 : focus.r, hasSel ? c1 : focus.c);
      },
    };
    installClipboard();
    gridHost.addEventListener('focus', () => {
      activeGrid = clip;
    });
    gridHost.addEventListener('blur', () => {
      if (activeGrid === clip) activeGrid = null;
    });

    // ---- keyboard (select mode) ----
    gridHost.addEventListener('keydown', (e) => {
      if (activeInput) return;
      // A chevron inside the grid keeps its own keys. These are the cells' keys, and
      // moving the selection while the keyboard is on a chevron would say nothing.
      if ((e.target as Element | null)?.closest?.('.sheaf-table-chevron')) return;
      const k = e.key;
      // The first key of an input method (Japanese, Chinese, Korean) arrives as
      // Process, as keyCode 229, or already composing. Open the selected cell with
      // an empty editor and leave the key alone, so the composition goes on in it.
      if (e.isComposing || e.keyCode === 229 || k === 'Process') {
        if (hasSel) edit('');
        return;
      }
      const jump = e.metaKey || e.ctrlKey;
      if (k === 'F10' && e.altKey && !e.shiftKey) {
        // The same key that reaches the selection toolbar and the link popover, so
        // a table's chrome is reached the way the rest of Sheaf's floating chrome is.
        // It is stopped here as well as prevented, because the editor binds it too.
        e.stopPropagation();
        stepChrome(null);
      } else if (jump && e.altKey && (e.code === 'Equal' || e.code === 'Minus' || k === '=' || k === '-')) {
        // Read by the key's place as well as its character: Alt on a Mac turns = and - into other characters.
        if (!axisKey(e.code === 'Equal' || k === '=')) return;
        // Taken here, it goes no further: off the Mac VS Code binds Ctrl+Alt+- itself.
        e.stopPropagation();
      } else if (e.altKey && !jump && !e.shiftKey && k.startsWith('Arrow')) {
        // Alt+arrow moves the selected rows or columns as a block, as Alt+Up and
        // Alt+Down move lines in the text editor. The header row does not move, and never leaves.
        const dirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const;
        if (k in dirs) moveBlock(dirs[k as keyof typeof dirs], anchor, far);
      } else if (k === 'ArrowUp' && !e.shiftKey && !jump && focus.r === -1 && leave(false)) {
        // left the table upward
      } else if (k === 'ArrowDown' && !e.shiftKey && !jump && focus.r === lastRow() && leave(true)) {
        // left the table downward
      } else if (jump && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(k)) {
        // Jump to the table's edge in that direction; Cmd+Home and Cmd+End go to its corners.
        const from = growFrom(e.shiftKey);
        const r = k === 'ArrowUp' || k === 'Home' ? -1 : k === 'ArrowDown' || k === 'End' ? lastRow() : from.r;
        const c = k === 'ArrowLeft' || k === 'Home' ? 0 : k === 'ArrowRight' || k === 'End' ? colCount() - 1 : from.c;
        select(r, c, e.shiftKey);
        revealFocus();
      } else if (k === 'Home' || k === 'End') {
        select(growFrom(e.shiftKey).r, k === 'Home' ? 0 : colCount() - 1, e.shiftKey);
      } else if (k === 'PageDown' || k === 'PageUp') {
        const page = Math.max(1, Math.floor((view.scrollDOM.clientHeight || window.innerHeight) / 34) - 1);
        const from = growFrom(e.shiftKey);
        select(clampRow(from.r + (k === 'PageDown' ? page : -page)), from.c, e.shiftKey);
        revealFocus();
      } else if (k === ' ' && e.shiftKey && !jump && !e.altKey) {
        // Shift+Space selects the row and Ctrl+Space the column, as in a spreadsheet.
        selectRange({ r: focus.r, c: colCount() - 1 }, { r: focus.r, c: 0 });
      } else if (k === ' ' && e.ctrlKey && !e.metaKey && !e.altKey) {
        selectRange({ r: lastRow(), c: focus.c }, { r: -1, c: focus.c });
      } else if (k === 'ArrowRight') arrow(0, 1, e.shiftKey);
      else if (k === 'ArrowLeft') arrow(0, -1, e.shiftKey);
      else if (k === 'ArrowUp') arrow(-1, 0, e.shiftKey);
      else if (k === 'ArrowDown') arrow(1, 0, e.shiftKey);
      else if (k === 'Tab') tabMove(e.shiftKey ? -1 : 1);
      else if (k === 'Enter' || k === 'F2') {
        if (hasSel) edit();
      } else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
        // Open the table menu on the active cell, as a right-click on it would.
        if (!hasSel) select(focus.r, focus.c);
        const el = cellEl(focus.r, focus.c);
        const rect = el?.getBoundingClientRect();
        el?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: (rect?.left ?? 0) + 4, clientY: rect?.bottom ?? 0 })
        );
      } else if (k === 'Escape') {
        // The first Escape clears the selection; the next hands the caret back to the text.
        if (hasSel) clearSel();
        else if (!leave(true)) leave(false);
      }
      else if (k === 'Backspace' || k === 'Delete') {
        if (hasSel) clearSelected();
      } else if ((k === 'z' || k === 'Z') && (e.metaKey || e.ctrlKey)) {
        // The webview host forwards keys that reach the window to VS Code, which
        // runs its own undo on the file; the grid's undo must stop here.
        e.stopPropagation();
        if (e.shiftKey) redo();
        else undo();
      } else if ((k === 'y' || k === 'Y') && e.ctrlKey && !e.metaKey) {
        e.stopPropagation();
        redo();
      } else if ((k === 'a' || k === 'A') && (e.metaKey || e.ctrlKey)) {
        // The first Cmd+A takes the whole table. With the whole table already
        // taken there is nothing wider left inside the grid, so the next one
        // widens to the whole document, as a second Cmd+A does in the text.
        const s = selRect();
        const everything =
          hasSel && !extra.length && s.r1 === -1 && s.r2 === lastRow() && s.c1 === 0 && s.c2 === colCount() - 1;
        if (everything) {
          clearSel();
          view.focus();
          view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        } else selectRange({ r: lastRow(), c: colCount() - 1 }, { r: -1, c: 0 });
      } else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // The key that opens the editor is its first keystroke, so it is written too.
        if (hasSel) {
          edit(k);
          writeTyped();
        }
      } else {
        return; // let copy/cut/paste and other keys through
      }
      e.preventDefault();
    });

    // ---- render ----
    // `press` runs before the ordinary cell press and takes it over by returning
    // true. A column header needs that: it reads the selection as it stands to tell
    // a move from a select, so nothing may collapse the selection ahead of it.
    const dataCell = (tag: 'th' | 'td', r: number, c: number, press?: (e: MouseEvent) => boolean): HTMLElement => {
      const el = document.createElement(tag);
      el.dataset.r = String(r);
      el.dataset.c = String(c);
      el.id = cellId(r, c);
      el.setAttribute('role', r === -1 ? 'columnheader' : 'gridcell');
      el.setAttribute('aria-selected', 'false');
      drawCell(el, getCell(r, c));
      const a = data.aligns[c];
      if (a) el.style.textAlign = a;
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Cmd/Ctrl-click on a link opens it, as in prose, instead of selecting.
        const link = activeInput ? null : linkClicked(e);
        if (link) return openLink(link.dataset.href ?? '');
        if (keepForMenu(e, r, c)) return;
        if (press?.(e)) return;
        // Cmd/Ctrl-click picks cells one at a time, so cells nowhere near each other
        // can be selected together.
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.button === 0) return toggleCell(r, c);
        select(r, c, e.shiftKey);
        dragging = true;
        dragMoved = false;
      });
      el.addEventListener('dblclick', (e) => {
        // A double-click inside the open editor belongs to it: the browser has
        // already picked the word under it, and opening the cell again would put
        // the whole value in its place.
        if (activeInput?.contains(e.target as Node)) return;
        e.preventDefault();
        select(r, c);
        edit();
      });
      return el;
    };

    // The file line a grid row comes from, for tooltips that tie rows to refs and diffs.
    const lineOf = (r: number): number | null => {
      const lookup = rowSources.get(wrap);
      if (!lookup) return null;
      const range = lookup(r);
      const whole = lookup(NaN);
      if (r !== -1 && range.from === whole.from && range.to === whole.to) return null;
      return view.state.doc.lineAt(range.from).number;
    };

    // The file lines named in the row and corner tooltips, read from the document as
    // it stands. They are written here rather than where those elements are built,
    // because a change anywhere above the table moves every one of its lines while
    // the grid keeps the DOM it already has.
    const labelLines = (): void => {
      const corner = gridHost.querySelector('.sheaf-table-corner') as HTMLElement | null;
      if (corner) {
        const headerLine = lineOf(-1);
        corner.title = headerLine ? `Select whole table (header on line ${headerLine})` : 'Select whole table';
      }
      gridHost.querySelectorAll('tbody .sheaf-table-gutter').forEach((el, r) => {
        const line = lineOf(r);
        (el as HTMLElement).title = line ? `Select row (line ${line})` : 'Select row (not saved yet)';
      });
    };

    // The table element `render` drew last, whose rows the marks below go on.
    let gridTable: HTMLTableElement | null = null;
    /*
     * Mark the rows an outside write inserted or rewrote, the way the lines around
     * the table are marked (see changeMarks.ts). Those marks are line decorations,
     * and this grid stands in for its table's lines, so they never show here; the
     * grid reads the same field and puts them on the rows those lines hold. A row
     * is marked whole: a write rewrites a line, and a row is a line. A row the grid
     * added and has not written yet comes from no line, so it is never marked.
     *
     * The marks are drawn and nothing else: this reads the document and never
     * writes it. With no mark on the table's lines, the only work is taking marks
     * off rows that had them; otherwise it is one pass over the table's text and a
     * set lookup per row.
     */
    const paintArrived = (changes?: ChangeDesc): void => {
      const table = gridTable;
      if (!table) return;
      const { doc } = view.state;
      const from = Math.min(changes ? changes.mapPos(pos.from, 1) : pos.from, doc.length);
      const to = Math.min(changes ? changes.mapPos(pos.to, -1) : pos.to, doc.length);
      const marks = view.state.field(arrivedLines, false) ?? [];
      // The marks on the table's lines, each as its line's index within the table.
      const changed = new Set<number>();
      const above = new Set<number>();
      const below = new Set<number>();
      const first = doc.lineAt(from).number;
      let lo = 0;
      let hi = marks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (marks[mid].pos < from) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < marks.length && marks[i].pos <= to; i++) {
        const at = doc.lineAt(marks[i].pos).number - first;
        (marks[i].kind === 'changed' ? changed : marks[i].kind === 'deletedAbove' ? above : below).add(at);
      }
      const trs = table.rows;
      if (!changed.size && !above.size && !below.size) {
        table.querySelectorAll('tr.sheaf-arrived, tr.sheaf-arrived-deleted').forEach((tr) => {
          tr.classList.remove('sheaf-arrived', 'sheaf-arrived-deleted', 'sheaf-arrived-deleted-below');
        });
        return;
      }
      // The lines each source row takes up within the table, the header as row -1.
      const bare = bareTable(doc.sliceString(from, to), prefix);
      if (!bare) return;
      const lines = bare.text.split('\n');
      const spans = new Map<number, { first: number; last: number }>();
      if (kind === 'pipe') {
        spans.set(-1, { first: 0, last: 0 });
        for (let i = 2, k = 0; i < lines.length; i++) {
          if (lines[i].trim() !== '') spans.set(k++, { first: i, last: i });
        }
      } else {
        const body = bare.text.indexOf('\n') + 1;
        if (body) {
          const text = bare.text.slice(body);
          const records = delimitedRecords(text, lang === 'tsv' ? '\t' : ',');
          let line = 1;
          let seen = 0;
          records.forEach((record, i) => {
            for (let c = seen; c < record.start; c++) if (text.charCodeAt(c) === 10) line++;
            seen = record.start;
            let breaks = 0;
            for (let c = 0; c < record.raw.length; c++) if (record.raw.charCodeAt(c) === 10) breaks++;
            spans.set(i - 1, { first: line, last: line + breaks });
          });
        }
      }
      // Lines taken away from the end of the table: under the last row. A CSV block
      // ends on its closing fence, so a gap before the fence is one too.
      const end = lines.length - 1;
      const tail = below.has(end) || (kind === 'csv' && above.has(end));
      const spanOf = (i: number): { first: number; last: number } | undefined => {
        const k = i === 0 ? -1 : rowOrigin[i - 1];
        return k === null || k === undefined ? undefined : spans.get(k);
      };
      // The tick goes under the last row that is on a line, past any row added and not yet written.
      let lastSourced = trs.length - 1;
      while (tail && lastSourced > 0 && !spanOf(lastSourced)) lastSourced--;
      for (let i = 0; i < trs.length; i++) {
        const span = spanOf(i);
        let isChanged = false;
        if (span) for (let l = span.first; l <= span.last && !isChanged; l++) isChanged = changed.has(l);
        const last = tail && i === lastSourced;
        const tr = trs[i];
        tr.classList.toggle('sheaf-arrived', isChanged);
        tr.classList.toggle('sheaf-arrived-deleted', last || (!!span && above.has(span.first)));
        tr.classList.toggle('sheaf-arrived-deleted-below', last);
      }
    };
    liveArrived.set(wrap, paintArrived);

    // The grid's accessible name and size, from the current headers and rows.
    function labelGrid(): void {
      gridHost.setAttribute('aria-rowcount', String(rowCount() + 1));
      gridHost.setAttribute('aria-colcount', String(colCount()));
      const names = data.headers.map((h) => h.trim()).filter(Boolean);
      gridHost.setAttribute('aria-label', names.length ? `Table: ${names.slice(0, 6).join(', ')}` : 'Table');
    }

    /**
     * The mark a column header carries, which opens that column's own menu. It is a
     * button inside the header and a hit area of its own: a press on it stops there,
     * so the header's handler, which is what starts a column move or a run of
     * selections, never sees it and no drag begins.
     *
     * It never reaches the middle of its header (see the stylesheet), so a click
     * aimed at the header still lands on the header however narrow the column is.
     * A row number gets no such mark: measured in a window, the gutter is 23 to 25
     * pixels, and a button inside it either covers the point a click on the row
     * number lands on or shrinks to nothing. The row commands are on the bar and in
     * its overflow instead, and the row number keeps its click and its drag whole.
     *
     * It is laid out out of flow, so it adds nothing to what a column measures as.
     * The widths are read off a throwaway copy of the table that holds cell text and
     * nothing else, and the grid is laid out `fixed` against them, so what a cell
     * holds cannot move a column either way.
     */
    const axisChevron = (c: number): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sheaf-table-chevron';
      b.tabIndex = -1;
      b.innerHTML = tableIcon('chevron');
      b.setAttribute('aria-haspopup', 'menu');
      const named = data.headers[c]?.trim();
      b.setAttribute('aria-label', `Column ${named || c + 1} commands`);
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menuOwner === b) return closeMenu(true);
        // The menu has to say what it acts on, so opening it settles that. A column
        // the selection already covers end to end is left alone, because narrowing it
        // to this one is the thing nobody asked for.
        if (!colWhole(c)) selectRange({ r: lastRow(), c }, { r: -1, c });
        openMenu(menuActions(-1, c, true, 'column'), b.getBoundingClientRect(), b);
      });
      return b;
    };

    /**
     * The grip on a column header's right border. Dragging it sets that column's
     * width by hand: the column is held at it, and the others divide what is left
     * by the same rules as before. The width is a view preference and is kept
     * outside the file (see `saveWidths`), so nothing here writes to the document.
     *
     * A column is never made narrower than the floor every column has. The border
     * stops there and the grip says so while the pointer is still held past it,
     * rather than the width being put back after the drag ends.
     *
     * Like the chevron, it is a hit area of its own: a press on it never reaches
     * the header, so it starts no column move, no selection and no cell editor.
     */
    const resizeGrip = (c: number): HTMLElement => {
      const g = document.createElement('span');
      g.className = 'sheaf-table-resize';
      g.setAttribute('aria-hidden', 'true');
      g.title = 'Drag to set this column’s width';
      let drag: { startX: number; startW: number; floor: number } | null = null;
      const stop = (e: Event): void => {
        e.preventDefault();
        e.stopPropagation();
      };
      g.addEventListener('mousedown', stop);
      g.addEventListener('dblclick', stop);
      g.addEventListener('click', (e) => e.stopPropagation());
      const follow = (x: number): void => {
        if (!drag) return;
        const want = Math.round(drag.startW + x - drag.startX);
        g.classList.toggle('is-at-floor', want < drag.floor);
        const next = new Map(pins() ?? []);
        next.set(c, Math.max(drag.floor, want));
        setPins(next, false);
      };
      g.addEventListener('pointerdown', (e) => {
        stop(e);
        if (e.button !== 0) return;
        // A table that has not been laid out has no width to start from.
        const widths = columns.widths();
        const m = columns.measured();
        if (!widths || !m || widths[c] === undefined) return;
        drag = { startX: e.clientX, startW: widths[c], floor: Math.round(m.floor) };
        try {
          g.setPointerCapture?.(e.pointerId);
        } catch {
          // No pointer to capture, as when the event was not made by one.
        }
        g.classList.add('is-dragging');
        wrap.classList.add('is-resizing');
      });
      g.addEventListener('pointermove', (e) => {
        if (drag) stop(e);
        follow(e.clientX);
      });
      const end = (e: PointerEvent, cancelled: boolean): void => {
        if (!drag) return;
        if (!cancelled) follow(e.clientX);
        drag = null;
        g.classList.remove('is-dragging', 'is-at-floor');
        wrap.classList.remove('is-resizing');
        try {
          g.releasePointerCapture?.(e.pointerId);
        } catch {
          // Already released.
        }
        saveWidths();
        syncControls();
      };
      g.addEventListener('pointerup', (e) => end(e, false));
      g.addEventListener('pointercancel', (e) => end(e, true));
      return g;
    };

    const render = (): void => {
      flush();
      const table = document.createElement('table');
      table.setAttribute('role', 'presentation');
      const thead = document.createElement('thead');
      thead.setAttribute('role', 'rowgroup');
      const htr = document.createElement('tr');
      htr.setAttribute('role', 'row');
      const corner = document.createElement('th');
      corner.className = 'sheaf-table-corner';
      corner.setAttribute('aria-hidden', 'true');
      labelGrid();
      corner.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectRange({ r: lastRow(), c: colCount() - 1 }, { r: -1, c: 0 });
      });
      htr.appendChild(corner);
      if (firstRender && justChanged.has(rowSources.get(wrap)?.(-1).from ?? -1)) htr.classList.add('is-changed');
      for (let c = 0; c < colCount(); c++) {
        // Header single-click selects the column (double-click still edits).
        const th = dataCell('th', -1, c, (e) => {
          // Read before the press changes the selection: a header already selected
          // is dragged to move its column, an unselected one to select a run.
          const drag = e.button === 0 && !e.shiftKey;
          const run = drag ? colRun(c) : null;
          if (run) colDrag = { at: c, lo: run.lo, hi: run.hi, over: null, startX: e.clientX };
          else if (drag) axisDrag = { axis: 'col', from: c };
          // A press that starts a move leaves the selection alone, so the whole run
          // stays picked while it is dragged. The release narrows it to this one
          // column if the pointer never went anywhere.
          if (run) return true;
          // The header cell holds focus, so typing edits the header rather than
          // the bottom cell of the column, as in a spreadsheet.
          // Shift takes every column from the one the selection started in to this
          // one, each end to end, the way Shift on a row number takes whole rows.
          if (!e.shiftKey) selectRange({ r: lastRow(), c }, { r: -1, c });
          else selectRange({ r: lastRow(), c: hasSel ? anchor.c : c }, { r: -1, c });
          return true;
        });
        th.append(axisChevron(c), resizeGrip(c));
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      const drawnRows = [htr];
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      tbody.setAttribute('role', 'rowgroup');
      for (let r = 0; r < rowCount(); r++) {
        const tr = document.createElement('tr');
        tr.setAttribute('role', 'row');
        if (firstRender && justChanged.size && justChanged.has(rowSources.get(wrap)?.(r).from ?? -1)) tr.classList.add('is-changed');
        const gut = document.createElement('td');
        gut.className = 'sheaf-table-gutter';
        gut.setAttribute('aria-hidden', 'true');
        gut.textContent = String(r + 1);
        gut.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (keepForMenu(e, r, 0)) return;
          // Read before the press changes the selection: a row number already
          // selected is dragged to move its row, an unselected one to select a run.
          const drag = e.button === 0 && !e.shiftKey;
          const run = drag ? rowRun(r) : null;
          if (run) rowDrag = { at: r, lo: run.lo, hi: run.hi, over: null, startY: e.clientY };
          else if (drag) axisDrag = { axis: 'row', from: r };
          // A press that starts a move leaves the selection alone, so the whole run
          // stays picked while it is dragged. The release narrows it to this one row
          // if the pointer never went anywhere.
          if (run) return;
          // Shift extends a row selection from the row it started on.
          selectRange({ r: e.shiftKey && hasSel ? anchor.r : r, c: colCount() - 1 }, { r, c: 0 });
        });
        tr.appendChild(gut);
        for (let c = 0; c < colCount(); c++) tr.appendChild(dataCell('td', r, c));
        tbody.appendChild(tr);
        drawnRows.push(tr);
      }
      table.appendChild(tbody);
      gridHost.replaceChildren(table);
      gridTable = table;
      rowEls = drawnRows;
      markNumeric();
      stickHeader();
      labelLines();
      paintArrived();
      firstRender = false;
      paint();
      // The cells are new, so find's marks go on them again.
      paintSearch();
      // The table element is new, so it carries no colgroup: the widths are
      // measured again, or read straight out of the cache when nothing about
      // this table's text has changed.
      columns.refresh();
    };

    /*
     * The marks a row or column drag last drew, one class per element. A pointer move
     * during the drag changes where the drop line is and nothing else, so the next
     * paint takes a mark off only an element that loses it and puts one on only an
     * element that lacks it: the dimmed block is left alone, and the rest of a long
     * table is never walked. An element a redraw took out of the grid loses nothing
     * that matters, and the drawn one that replaced it lacks its mark, so gets it.
     */
    type DragMarks = Map<HTMLElement, string>;
    const remark = (before: DragMarks, after: DragMarks): DragMarks => {
      for (const [el, cls] of before) if (after.get(el) !== cls) el.classList.remove(cls);
      for (const [el, cls] of after) if (!el.classList.contains(cls)) el.classList.add(cls);
      return after;
    };
    let rowDropMarks: DragMarks = new Map();
    let colDropMarks: DragMarks = new Map();
    // Mark the dragged row and the row it would land on; the drop goes after that row
    // when moving down and before it when moving up.
    const paintDrop = (): void => {
      const next: DragMarks = new Map();
      if (rowDrag && rowDrag.over !== null) {
        const { lo, hi, over } = rowDrag;
        for (let r = lo; r <= hi; r++) {
          const tr = rowEl(r);
          if (tr) next.set(tr, 'is-row-dragging');
        }
        const tr = over < lo || over > hi ? rowEl(over) : null;
        if (tr) next.set(tr, over > hi ? 'is-drop-after' : 'is-drop-before');
      }
      rowDropMarks = remark(rowDropMarks, next);
    };
    // A column's marks run its full height, header included: every drawn row's cell in it.
    const paintColDrop = (): void => {
      const next: DragMarks = new Map();
      if (colDrag && colDrag.over !== null) {
        const { lo, hi, over } = colDrag;
        const side = over > hi ? 'is-col-drop-after' : 'is-col-drop-before';
        const lined = over < lo || over > hi;
        for (let r = -1; r < rowEls.length - 1; r++) {
          for (let c = lo; c <= hi; c++) {
            const el = cellEl(r, c);
            if (el) next.set(el, 'is-col-dragging');
          }
          const el = lined ? cellEl(r, over) : null;
          if (el) next.set(el, side);
        }
      }
      colDropMarks = remark(colDropMarks, next);
    };
    // Where a run of `count` lines lands when it is dropped on line `to`: on the way
    // down the run ends at `to`, on the way up it starts there, so the line it was
    // dropped on stays on the side the run came past it.
    const landing = (lo: number, count: number, to: number): number =>
      to > lo ? to - count + 1 : to;
    function moveColsTo(lo: number, hi: number, to: number): void {
      commitCell();
      if (lo < 0 || hi >= colCount() || hi < lo || to < 0 || to >= colCount()) return;
      if (to >= lo && to <= hi) return;
      record();
      const count = hi - lo + 1;
      const at = landing(lo, count, to);
      const move = <T>(list: T[]): void => {
        list.splice(at, 0, ...list.splice(lo, count));
      };
      move(data.headers);
      move(data.aligns);
      move(colOrigin);
      for (const row of data.rows) {
        while (row.length < colCount()) row.push('');
        move(row);
      }
      render();
      selectRange({ r: lastRow(), c: at }, { r: -1, c: at + count - 1 });
    }
    function moveColTo(from: number, to: number): void {
      moveColsTo(from, from, to);
    }
    function moveRowsTo(lo: number, hi: number, to: number): void {
      commitCell();
      if (lo < 0 || hi >= rowCount() || hi < lo || to < 0 || to >= rowCount()) return;
      if (to >= lo && to <= hi) return;
      record();
      const count = hi - lo + 1;
      const at = landing(lo, count, to);
      data.rows.splice(at, 0, ...data.rows.splice(lo, count));
      rowOrigin.splice(at, 0, ...rowOrigin.splice(lo, count));
      render();
      selectRange({ r: at + count - 1, c: colCount() - 1 }, { r: at, c: 0 });
    }
    function moveRowTo(from: number, to: number): void {
      moveRowsTo(from, from, to);
    }

    // The cell under the pointer, hit-tested where the pointer actually is rather
    // than read off the event's target. A drag that opens with an editor over the
    // cell it started in ends in a table laid out differently from the one the drag
    // began in, and a target picked up before that names the cell that used to be
    // there. Falling back to the target covers a stand-in DOM with no layout to
    // test, where the target is all there is.
    const cellUnder = (e: MouseEvent): HTMLElement | null => {
      const owned = (el: Element | null | undefined): HTMLElement | null => {
        const cell = el?.closest?.('[data-r]') as HTMLElement | null;
        return cell && gridHost.contains(cell) ? cell : null;
      };
      return owned(document.elementFromPoint?.(e.clientX, e.clientY)) ?? owned(e.target as Element | null);
    };
    // Grow the drag's range out to a cell, if the pointer is over one at all.
    const reachTo = (el: HTMLElement | null): void => {
      if (!el) return;
      const r = Number(el.dataset.r);
      const c = Number(el.dataset.c);
      // The drag moves the far end; the active cell stays where the drag started.
      if (r !== far.r || c !== far.c) {
        far = { r, c };
        revealFar = true;
        hasSel = true;
        paint();
      }
    };

    // Drag to extend a selection across cells, or to move a row grabbed by its number.
    gridHost.addEventListener('mousemove', (e) => {
      if (inputDrag) {
        // The button was let go somewhere the grid never saw; nothing is being dragged.
        if (e.buttons === 0) inputDrag = null;
        const el = inputDrag && cellUnder(e);
        if (!el || !inputDrag) return;
        const r = Number(el.dataset.r);
        const c = Number(el.dataset.c);
        // Still over the open cell: the text field goes on selecting its own text.
        if (r === inputDrag.r && c === inputDrag.c) return;
        // Past it: the drag is a cell range from the open cell to here, and the
        // cell closes on what it holds, as clicking another cell would.
        const from = inputDrag;
        inputDrag = null;
        commitCell();
        extra = [];
        anchor = { ...from };
        focus = { ...from };
        far = { r, c };
        revealFar = true;
        hasSel = true;
        dragging = true;
        dragMoved = true;
        paint();
        focusGrid();
        return;
      }
      if (colDrag) {
        if (colDrag.over === null && Math.abs(e.clientX - colDrag.startX) < 4) return;
        const cell = (e.target as HTMLElement).closest('[data-c]') as HTMLElement | null;
        const over = cell ? Number(cell.dataset.c) : NaN;
        if (over >= 0 && over !== colDrag.over) {
          colDrag.over = over;
          dragging = false; // a header drag moves the column instead of extending a selection
          paintColDrop();
        }
        return;
      }
      if (rowDrag) {
        // A few pixels of wobble is still a click on the row number.
        if (rowDrag.over === null && Math.abs(e.clientY - rowDrag.startY) < 4) return;
        const cell = (e.target as HTMLElement).closest('tr')?.querySelector('[data-r]') as HTMLElement | null;
        const over = cell ? Number(cell.dataset.r) : NaN;
        if (over >= 0 && over !== rowDrag.over) {
          rowDrag.over = over;
          paintDrop();
        }
        return;
      }
      if (axisDrag) {
        // Grow the run to whatever row or column the pointer is over, whether it is
        // over the row numbers and headers themselves or the cells beside them.
        if (axisDrag.axis === 'col') {
          const cell = (e.target as HTMLElement).closest('[data-c]') as HTMLElement | null;
          const c = cell ? Number(cell.dataset.c) : NaN;
          if (!(c >= 0)) return;
          anchor = { r: lastRow(), c: axisDrag.from };
          far = { r: -1, c };
          focus = { ...far };
        } else {
          const cell = (e.target as HTMLElement).closest('tr')?.querySelector('[data-r]') as HTMLElement | null;
          const r = cell ? Number(cell.dataset.r) : NaN;
          if (!(r >= 0)) return;
          anchor = { r: axisDrag.from, c: colCount() - 1 };
          far = { r, c: 0 };
          focus = { ...far };
        }
        hasSel = true;
        paint();
        return;
      }
      if (!dragging) return;
      dragMoved = true;
      reachTo(cellUnder(e));
    });
    document.addEventListener('mouseup', (e) => {
      // The release settles the range, hit-tested again: the last move may have been
      // read while the table was laid out for an open cell editor.
      if (dragging && dragMoved) reachTo(cellUnder(e));
      dragging = false;
      dragMoved = false;
      axisDrag = null;
      inputDrag = null;
      if (colDrag) {
        const { at, lo, hi, over } = colDrag;
        colDrag = null;
        paintColDrop();
        // A press that never moved is a click, and a click on a header narrows the
        // selection to that one column, as it does on an unselected header.
        if (over === null) selectRange({ r: lastRow(), c: at }, { r: -1, c: at });
        else moveColsTo(lo, hi, over);
      }
      if (!rowDrag) return;
      const { at, lo, hi, over } = rowDrag;
      rowDrag = null;
      paintDrop();
      if (over === null) selectRange({ r: at, c: colCount() - 1 }, { r: at, c: 0 });
      else moveRowsTo(lo, hi, over);
    });

    // ---- shown as a board ----
    /*
     * A pipe table can be drawn as a board instead of a grid: a card per row, in one
     * column per value of the column it is grouped by (see "Tables shown as boards"
     * above for where that choice is kept). The grid stays built and hidden under the
     * board, so switching back is immediate and everything the grid knows stays true.
     * Moving a card writes its row's grouping cell through the grid's own writer: the
     * same minimal write typing into that cell makes, and one step of the history.
     */
    const boardHost = document.createElement('div');
    boardHost.className = 'sheaf-table-board';
    boardHost.tabIndex = -1;
    boardHost.hidden = true;
    const boardNote = document.createElement('p');
    boardNote.className = 'sheaf-table-board-note';
    boardNote.setAttribute('role', 'status');
    boardNote.hidden = true;
    /** The header text of the column the board is grouped by, while the table is shown as one. */
    let boardGroup: string | null = null;
    /** The table key the board is kept under, which follows the header row. */
    let boardKey = tableWidthKey(data.headers);
    /** The board as drawn, or null while the grid shows. */
    let boardState: BoardState | null = null;
    /** Board columns kept while the board's own moves are shown, so a column a card just left stays to put it back in. */
    let boardKeep: string[] = [];
    const groupAt = (name: string): number => data.headers.findIndex((h) => h.trim() === name);
    const columnName = (c: number): string => headerName(data.headers[c] ?? '') || `Column ${c + 1}`;
    /** Say `text` above the table, with a way to dismiss it, or take what was said away. */
    const say = (text: string | null): void => {
      boardNote.hidden = !text;
      if (!text) return void boardNote.replaceChildren();
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'sheaf-table-board-note-dismiss';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('mousedown', (e) => e.preventDefault());
      dismiss.addEventListener('click', () => say(null));
      boardNote.replaceChildren(text + ' ', dismiss);
    };
    const cards = wireBoard(boardHost, {
      current: () => boardState,
      editable: () => !view.state.readOnly,
      move: (row, value) => moveCard(row, value),
    });
    /** Give the focus to the picked card, or the first, or the board itself when it has none. */
    function focusBoard(): void {
      const picked = cards.picked();
      const el =
        (picked !== null && boardHost.querySelector<HTMLElement>(`.sheaf-board-card[data-row="${picked}"]`)) ||
        boardHost.querySelector<HTMLElement>('.sheaf-board-card');
      if (el) cards.pickCard(Number(el.dataset.row));
      else boardHost.focus({ preventScroll: true });
    }
    /** Write `value` into row `row`'s grouping cell, which moves its card to that value's column. */
    const moveCard = (row: number, value: string): void => {
      const board = boardState;
      if (!board || row < 0 || row >= rowCount() || view.state.readOnly) return;
      if (getCell(row, board.group).trim() === value) return;
      commitCell();
      boardKeep = board.values;
      record();
      setCell(row, board.group, value);
      const el = cellEl(row, board.group);
      if (el) drawCell(el, value);
      markNumeric(board.group);
      // A step of its own, so one Undo takes back one move.
      flush('input.table', true);
      showBoard();
    };
    /** Draw the board, or put the grid back, as `boardGroup` says. */
    const showBoard = (): void => {
      const group = boardGroup === null ? -1 : groupAt(boardGroup);
      const on = group >= 0;
      const hadFocus = boardHost.contains(document.activeElement);
      cards.endDrag();
      wrap.classList.toggle('is-board', on);
      gridHost.hidden = on;
      boardHost.hidden = !on;
      collapsible.hidden = on;
      // Only a board carries the button back, so a grid's bar is what it always was.
      if (on && !tableButton.isConnected) controls.insertBefore(tableButton, collapsibleSep);
      else if (!on) tableButton.remove();
      if (!on) {
        boardState = null;
        boardKeep = [];
        boardHost.replaceChildren();
        return;
      }
      const kept = keptRows();
      const drawn = drawBoardLayout({
        headers: data.headers.map((_, c) => columnName(c)),
        rows: data.rows,
        columns: data.headers.map((_, c) => c),
        group,
        // A row added past the end and still empty is not in the file, so it has no card.
        order: data.rows.map((_, r) => r).filter((r) => kept[r]),
        keep: boardState?.group === group ? boardKeep : [],
        picked: cards.picked(),
        render: renderInline,
        empty: 'The table has no rows yet.',
      });
      boardState = drawn.state;
      boardHost.replaceChildren(drawn.el);
      if (hadFocus) focusBoard();
    };
    /** The grid goes back, with a note saying why, because the column the board was grouped by is gone. */
    const lostGroup = (name: string): void => {
      boardGroup = null;
      say(`Shown as a table: the board was grouped by ${headerName(name) || name}, and this table has no column of that name now.`);
    };
    /**
     * Look again at whether the table is a board: when it is drawn, after its text
     * changes, and when the stored boards arrive.
     */
    const syncBoard = (): void => {
      const key = tableWidthKey(data.headers);
      if (key !== boardKey && boardGroup !== null) {
        // A header changed under a board on this page. It is the same table, so the
        // board moves to its new key, unless the column it is grouped by is gone.
        boardTables.delete(boardKey);
        if (groupAt(boardGroup) >= 0) boardTables.set(key, boardGroup);
        else lostGroup(boardGroup);
        saveBoards();
      }
      boardKey = key;
      const stored = boardTables.get(key);
      if (stored === undefined) boardGroup = null;
      else if (groupAt(stored) >= 0) boardGroup = stored;
      else {
        boardTables.delete(key);
        saveBoards();
        lostGroup(stored);
      }
      showBoard();
    };
    boardListeners.add(syncBoard);
    const showAsBoard = (c: number): void => {
      // Anything the grid still holds reaches the file first.
      commitCell();
      flush();
      const name = (data.headers[c] ?? '').trim();
      boardKey = tableWidthKey(data.headers);
      boardTables.set(boardKey, name);
      saveBoards();
      say(null);
      boardGroup = name;
      boardState = null;
      showBoard();
      focusBoard();
    };
    const showAsTable = (): void => {
      boardTables.delete(tableWidthKey(data.headers));
      saveBoards();
      boardGroup = null;
      showBoard();
      columns.refresh();
      focusGrid();
    };
    /**
     * Ask which column to group by, in a menu under the button whose menu asked, or
     * under `near` when the right-click menu did. It opens once the menu the question
     * came from has closed and handed the focus back.
     */
    const chooseGroup = (near: HTMLElement | null): void => {
      const owner = menuInvoker ?? overflow;
      const at = (menuInvoker ?? near ?? wrap).getBoundingClientRect();
      const choices: TableAction[] = data.headers.map((_, c) => ({
        id: `table.groupBy.${c}`,
        label: columnName(c),
        run: () => showAsBoard(c),
      }));
      queueMicrotask(() => {
        if (wrap.isConnected) openMenu(choices, at, owner, 'Group the board by');
      });
    };
    /** A board's menu: the rows have no cells to act on here, so it offers the grid back and another grouping. */
    const boardActions = (): TableAction[] => [
      { id: 'table.showAsTable', label: 'Show as table', icon: 'rowDuplicate', run: () => showAsTable() },
      ...(colCount() > 1
        ? [{ id: 'table.groupBy', label: 'Group by another column', icon: 'colDuplicate' as TableIcon, run: () => chooseGroup(boardHost) }]
        : []),
    ];

    // ---- menus ----
    /**
     * The menu the overflow button opens, drawn here rather than handed to the
     * right-click menu because these two differ: this one keeps a command that
     * cannot run in its place and dims it, and it carries each command's icon.
     * It wears the right-click menu's classes so it looks the same and so the
     * check that writes the table when focus leaves already knows what it is.
     */
    let menuEl: HTMLElement | null = null;
    // The button the open menu belongs to, so pressing that button again closes it
    // rather than closing and opening it in the same gesture.
    let menuOwner: HTMLElement | null = null;
    /** The button whose menu is running the action being run now, if a menu of this table's is. */
    let menuInvoker: HTMLElement | null = null;
    const closeMenu = (restore: boolean): void => {
      menuEl?.remove();
      menuEl = null;
      menuOwner = null;
      if (restore) focusGrid();
    };
    /** The menu's items, in order, so the arrow keys can walk them. */
    const menuItems = (): HTMLButtonElement[] =>
      menuEl ? (Array.from(menuEl.querySelectorAll('.sheaf-table-menu-item')) as HTMLButtonElement[]) : [];
    const stepMenu = (from: HTMLElement, by: number): void => {
      const items = menuItems();
      const i = items.indexOf(from as HTMLButtonElement);
      items[(i + by + items.length) % items.length]?.focus();
    };
    /**
     * Open a menu of `actions` under `at`. A disabled item keeps its place and
     * stays reachable, so someone walking the menu hears every command the table
     * has and which of them cannot run here.
     */
    const openMenu = (actions: TableAction[], at: DOMRect, owner: HTMLElement, title?: string): void => {
      // At most one of these anywhere, whichever table opened it. The sweep also
      // clears one left behind by a table that has since been taken off the page.
      document.querySelectorAll('.sheaf-table-menu').forEach((el) => el.remove());
      menuEl = null;
      const el = document.createElement('div');
      // Classes of its own rather than the right-click menu's, though it is drawn to
      // match. Two menus that answer to one selector cannot be told apart by anything
      // reading the page, and one of them standing open reads as the other being
      // wrong. It looks the same and it is a different thing.
      el.className = 'sheaf-table-menu';
      el.setAttribute('role', 'menu');
      // A menu that asks a question says what it is asking, above its answers.
      if (title) {
        el.setAttribute('aria-label', title);
        const head = document.createElement('div');
        head.className = 'sheaf-table-menu-title';
        head.setAttribute('aria-hidden', 'true');
        head.textContent = title;
        el.appendChild(head);
      }
      for (const action of actions) {
        if (action.separator && el.querySelector('.sheaf-table-menu-item')) {
          const sep = document.createElement('div');
          sep.className = 'sheaf-table-menu-sep';
          sep.setAttribute('role', 'separator');
          el.appendChild(sep);
        }
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sheaf-table-menu-item';
        item.setAttribute('role', 'menuitem');
        if (action.id) item.dataset.cmd = action.id;
        item.tabIndex = -1;
        if (action.icon) item.insertAdjacentHTML('afterbegin', tableIcon(action.icon));
        const label = document.createElement('span');
        label.textContent = action.label;
        item.appendChild(label);
        if (action.disabled) {
          item.classList.add('is-disabled');
          item.setAttribute('aria-disabled', 'true');
        }
        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', () => {
          if (action.disabled) return;
          // An action that opens a menu of its own opens it under the same button.
          const from = menuOwner;
          closeMenu(true);
          menuInvoker = from;
          try {
            action.run();
          } finally {
            menuInvoker = null;
          }
        });
        el.appendChild(item);
      }
      el.addEventListener('keydown', (e) => {
        const on = e.target as HTMLElement;
        if (e.key === 'ArrowDown') stepMenu(on, 1);
        else if (e.key === 'ArrowUp') stepMenu(on, -1);
        else if (e.key === 'Home') menuItems()[0]?.focus();
        else if (e.key === 'End') menuItems().slice(-1)[0]?.focus();
        else if (e.key === 'Escape' || e.key === 'Tab') closeMenu(true);
        else return;
        e.preventDefault();
        e.stopPropagation();
      });
      document.body.appendChild(el);
      // Placed after it is in the document, because until then it has no size to
      // fit: below its button, pulled back inside the window when it would not fit.
      const w = el.offsetWidth || 200;
      const h = el.offsetHeight || 0;
      const room = { w: window.innerWidth || 1024, h: window.innerHeight || 768 };
      el.style.left = `${Math.max(4, Math.min(at.left, room.w - w - 4))}px`;
      el.style.top = `${at.bottom + h + 4 > room.h ? Math.max(4, at.top - h - 4) : at.bottom + 4}px`;
      menuEl = el;
      menuOwner = owner;
      menuItems()[0]?.focus();
    };
    // A press anywhere else closes the menu. It is on the document because the
    // press that closes it is usually nowhere near the table.
    const closeOnPress = (e: MouseEvent): void => {
      // A grid taken off the page without its destroy hook running would leave this
      // behind, so it lets itself go the first time it notices.
      if (!wrap.isConnected) return document.removeEventListener('mousedown', closeOnPress, true);
      if (!menuEl) return;
      const on = e.target as Element | null;
      // A press inside the menu, or on a button that opens one, is that element's
      // own business: closing here would undo the toggle before it happened.
      if (on?.closest?.('.sheaf-table-menu, .sheaf-table-ctrl, .sheaf-table-chevron')) return;
      closeMenu(false);
    };
    document.addEventListener('mousedown', closeOnPress, true);

    // ---- controls bar ----
    const commandById = (id: TableCommandId): TableCommand => TABLE_COMMANDS.find((c) => c.id === id)!;
    /** Every bar button that stands for a registry command, so their state can be refreshed together. */
    const barButtons: { id: TableCommandId; el: HTMLButtonElement }[] = [];
    const ctrlButton = (icon: TableIcon, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sheaf-table-ctrl';
      b.innerHTML = tableIcon(icon);
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', onClick);
      return b;
    };
    /**
     * A bar button for one registry command. The bar is icons because the rest of
     * Sheaf's chrome is, and the command's own label moves into the tooltip and
     * the accessible name, where it can say which row or column it means.
     */
    const barCommand = (id: TableCommandId): HTMLButtonElement => {
      const spec = commandById(id);
      const b = ctrlButton(spec.icon, spec.label(commandTarget(focus.r, focus.c)), () => {
        if (!spec.enabled(commandTarget(focus.r, focus.c))) return;
        commandRunner(focus.r, focus.c)[id]();
      });
      b.dataset.cmd = id;
      barButtons.push({ id, el: b });
      return b;
    };
    const barGroup = (): HTMLElement => {
      const sep = document.createElement('span');
      sep.className = 'sheaf-table-ctrl-sep';
      sep.setAttribute('aria-hidden', 'true');
      return sep;
    };
    if (kind === 'csv') {
      const badge = document.createElement('span');
      badge.className = 'sheaf-table-badge';
      badge.textContent = lang.toUpperCase();
      controls.appendChild(badge);
    }
    // The commands worth a button of their own: adding and removing a row, then
    // the same for a column. Everything else is behind the overflow beside them.
    const collapsible = document.createElement('span');
    collapsible.className = 'sheaf-table-ctrl-fit';
    collapsible.append(
      barCommand('row.insertAbove'),
      barCommand('row.insertBelow'),
      barCommand('row.delete'),
      barGroup(),
      barCommand('col.insertLeft'),
      barCommand('col.insertRight'),
      barCommand('col.delete')
    );
    controls.appendChild(collapsible);
    const collapsibleSep = barGroup();
    const overflow = ctrlButton('overflow', 'More table commands', () => {
      if (menuEl) return closeMenu(true);
      openMenu(boardState ? boardActions() : menuActions(focus.r, focus.c, true), overflow.getBoundingClientRect(), overflow);
    });
    overflow.dataset.cmd = 'overflow';
    overflow.setAttribute('aria-haspopup', 'menu');
    // On a board, the way back to the grid has a button of its own, where the row
    // and column buttons were: they have no cells to act on there.
    const tableButton = ctrlButton('rowDuplicate', 'Show as table', () => showAsTable());
    tableButton.dataset.cmd = 'table.showAsTable';
    controls.append(collapsibleSep, overflow);
    const source = ctrlButton('source', 'Edit raw source', () => {
      commitCell();
      committed = true;
      const src = view.state.sliceDoc(pos.from, pos.to);
      const text = write(src);
      view.dispatch({
        changes: text === src ? undefined : { from: pos.from, to: pos.to, insert: text },
        selection: { anchor: pos.from },
        effects: setReveal.of({ from: pos.from, to: pos.from + text.length }),
      });
      view.focus();
    });
    source.dataset.cmd = 'source';
    controls.appendChild(source);

    /**
     * How wide the bar needs to be with every button on it. Measured while it is
     * whole, because once the buttons are collapsed the bar no longer says what it
     * wanted, and comparing the two would flap between the states forever.
     */
    let barWidth = 0;
    const fitControls = (): void => {
      const room = controls.clientWidth;
      if (!room) return;
      if (!controls.classList.contains('is-collapsed')) barWidth = Math.max(barWidth, controls.scrollWidth);
      if (barWidth) controls.classList.toggle('is-collapsed', barWidth > room);
    };
    /** The bar says what it would do to what is selected now, and dims what it cannot do. */
    syncControls = (): void => {
      const target = commandTarget(focus.r, focus.c);
      for (const { id, el } of barButtons) {
        const spec = commandById(id);
        const label = spec.label(target);
        el.title = label;
        el.setAttribute('aria-label', label);
        const off = !spec.enabled(target);
        el.classList.toggle('is-disabled', off);
        el.setAttribute('aria-disabled', String(off));
      }
      fitControls();
    };
    syncControls();
    // ---- the keyboard's way round the chrome ----
    /**
     * The bar is one tab stop with the arrows moving inside it, which is the toolbar
     * pattern the rest of Sheaf's chrome uses. A button collapsed into the overflow
     * is not a stop, because it is not on screen to be moved to.
     */
    const barStops = (): HTMLButtonElement[] => {
      const all = (Array.from(controls.querySelectorAll('.sheaf-table-ctrl')) as HTMLButtonElement[]).filter((b) => !b.closest('[hidden]'));
      return controls.classList.contains('is-collapsed') ? all.filter((b) => !b.closest('.sheaf-table-ctrl-fit')) : all;
    };
    /** Keep one stop tabbable, the one the arrows last left focus on. */
    const rove = (to: HTMLButtonElement): void => {
      for (const b of barStops()) b.tabIndex = b === to ? 0 : -1;
      to.focus();
    };
    /**
     * Where Alt+F10 goes, in order: the bar, then the chevron on the active cell's
     * column, then back into the grid. The chevron sits in the grid rather than on
     * the bar, so the keyboard reaches it by name rather than by walking the bar off
     * its end. The row commands are on the bar and in its overflow, so the ring
     * reaches every one of them without a stop of their own.
     */
    const chromeRing = (): HTMLElement[] => {
      const ring: HTMLElement[] = [];
      const first = barStops().find((b) => b.tabIndex === 0) ?? barStops()[0];
      if (first) ring.push(first);
      const col = gridHost.querySelector(`thead th[data-c="${focus.c}"] > .sheaf-table-chevron`);
      if (col) ring.push(col as HTMLElement);
      return ring;
    };
    const stepChrome = (from: HTMLElement | null): void => {
      const ring = chromeRing();
      const at = !from ? -1 : controls.contains(from) ? 0 : ring.indexOf(from);
      const next = ring[at + 1];
      if (next) next.focus();
      else focusGrid();
    };
    /**
     * The two keys that work the same wherever the chrome has the keyboard: Escape
     * hands it back to the cell that had it, and Alt+F10 goes on to the next stop.
     */
    const chromeKeys = (e: KeyboardEvent): boolean => {
      if (e.key === 'Escape') {
        focusGrid();
        return true;
      }
      if (e.key === 'F10' && e.altKey && !e.shiftKey) {
        stepChrome(e.target as HTMLElement);
        return true;
      }
      return false;
    };
    controls.setAttribute('role', 'toolbar');
    controls.setAttribute('aria-label', 'Table commands');
    for (const [i, b] of barStops().entries()) b.tabIndex = i === 0 ? 0 : -1;
    controls.addEventListener('keydown', (e) => {
      const stops = barStops();
      const i = stops.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      const k = e.key;
      if (chromeKeys(e)) {
        // Escape and Alt+F10 have already taken the keyboard somewhere else.
      } else if (k === 'ArrowRight' || k === 'ArrowLeft') {
        rove(stops[(i + (k === 'ArrowRight' ? 1 : -1) + stops.length) % stops.length]);
      } else if (k === 'Home') rove(stops[0]);
      else if (k === 'End') rove(stops[stops.length - 1]);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    // The chevrons are one button each, so the arrows have nowhere to go in them.
    // Escape and Alt+F10 work there as they do on the bar.
    gridHost.addEventListener('keydown', (e) => {
      if (!(e.target as Element | null)?.closest?.('.sheaf-table-chevron')) return;
      if (!chromeKeys(e)) return;
      e.preventDefault();
      e.stopPropagation();
    });

    let barObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      barObserver = new ResizeObserver(() => fitControls());
      barObserver.observe(controls);
    }
    liveControls.set(wrap, () => {
      barObserver?.disconnect();
      document.removeEventListener('mousedown', closeOnPress, true);
      closeMenu(false);
      pinListeners.delete(relayoutPins);
      boardListeners.delete(syncBoard);
      cards.endDrag();
      heightObserver?.disconnect();
      view.scrollDOM.removeEventListener('scroll', stickHeader);
    });

    // Write the model to the document once focus leaves the table for good. Focus
    // moving into the right-click menu is not leaving: the menu acts on this grid
    // and hands focus back, so the check waits until focus lands somewhere else.
    let waiting = false;
    const recheck = (): void => void setTimeout(writeIfLeft, 0);
    const stopWaiting = (): void => {
      if (!waiting) return;
      waiting = false;
      document.removeEventListener('focusin', recheck, true);
      document.removeEventListener('focusout', recheck, true);
    };
    const startWaiting = (): void => {
      if (waiting) return;
      waiting = true;
      document.addEventListener('focusin', recheck, true);
      document.addEventListener('focusout', recheck, true);
    };
    function writeIfLeft(): void {
      if (committed || !wrap.isConnected) return stopWaiting();
      const active = document.activeElement;
      if (wrap.contains(active)) return stopWaiting();
      if (active?.closest?.('.sheaf-ctx-menu, .sheaf-table-menu')) return startWaiting();
      stopWaiting();
      commitCell();
      // The keyboard is elsewhere now, so the table stops showing a selection and an active cell.
      extra = [];
      hasSel = false;
      paint();
      const src = view.state.sliceDoc(pos.from, pos.to);
      const text = write(src);
      // Only a real write retires this DOM, because the dispatch rebuilds the
      // widget. With nothing to write, CodeMirror keeps this same DOM, so it
      // has to go on accepting edits.
      if (text !== src) {
        committed = true;
        view.dispatch({ changes: { from: pos.from, to: pos.to, insert: text } });
      }
    }
    wrap.addEventListener('focusout', recheck);

    // Take over from a rebuilt decoration for this table. When only its position
    // moved, adopting the new range is all it takes. When the table's text changed,
    // the change is this grid's own write, an undo or redo, or an outside edit (an
    // agent, a pull, another editor). The grid writes every change as it is made, so
    // the file's text is the whole table: the grid takes it, and keeps the selection,
    // focus and a cell still being typed into. Empty rows appended past the end are
    // not written until they hold something, so the grid's own write keeps them.
    const adopt = (next: TableWidget): boolean => {
      if (committed || next.kind !== kind || next.prefix !== prefix) return false;
      pos.from = next.from;
      pos.to = next.to;
      // A name is drawn above the grid, not in it, so a new one is painted in place.
      paintTableName(caption, next.name);
      // The table only moved. The grid's DOM stands as it is, but every row of it is
      // on a new line, so the lines the tooltips name are read again.
      if (next.sig === sig) {
        labelLines();
        return true;
      }
      const n = next.data;
      const own = writing !== null && view.state.sliceDoc(next.from, next.to) === writing;
      if (!own && typing) typing.outside = true;
      const kept = own ? keptRows() : [];
      // A row appended past the end and being typed into stays appended until the
      // edit ends, so typing into it and deleting the text again writes no row.
      const typedAuto = own && typing?.auto && focus.r >= 0 ? focus.r : -1;
      const rows: string[][] = [];
      const origins: Origin = [];
      if (own && kept.filter(Boolean).length === n.rows.length) {
        let k = 0;
        for (const keep of kept) {
          if (keep) {
            const row = [...n.rows[k]];
            if (rows.length === typedAuto) autoRows.add(row);
            rows.push(row);
            origins.push(k++);
          } else {
            const row: string[] = new Array(n.headers.length).fill('');
            autoRows.add(row);
            rows.push(row);
            origins.push(null);
          }
        }
      } else {
        n.rows.forEach((row, i) => {
          rows.push([...row]);
          origins.push(i);
        });
      }
      orig = n;
      sig = next.sig;
      data.headers.splice(0, data.headers.length, ...n.headers);
      data.aligns.splice(0, data.aligns.length, ...n.aligns);
      data.rows.splice(0, data.rows.length, ...rows);
      rowOrigin.splice(0, rowOrigin.length, ...origins);
      colOrigin.splice(0, colOrigin.length, ...n.headers.map((_, i) => i));
      // The grid already shows what it wrote, though the write can have moved its rows.
      if (own) {
        labelLines();
        // A committed cell can be much longer or much shorter than the one it
        // replaced, so its column is measured again. The grid is not redrawn,
        // so this is the only place that asks: without it a column would keep
        // whatever width it had when the table was first drawn.
        columns.refresh();
        // A board is drawn from the rows, so it is drawn again from what was written.
        syncBoard();
        return true;
      }
      // Someone else's change: a board column a card just left is not kept past it.
      boardKeep = [];
      const was = { ...focus };
      // The table's rows and columns have changed under the selection, so the blocks
      // picked one at a time no longer name the cells they were picked from.
      extra = [];
      anchor = { r: clampRow(anchor.r), c: clampCol(anchor.c) };
      far = { r: clampRow(far.r), c: clampCol(far.c) };
      focus = { r: clampRow(focus.r), c: clampCol(focus.c) };
      // An undo or redo of a grid write puts the active cell on the cell it changed.
      const step = view.state.field(stepCell, false);
      if (step && step.at >= next.from && step.at <= next.to) {
        focus = { r: clampRow(step.cell.r), c: clampCol(step.cell.c) };
        anchor = { ...focus };
        far = { ...focus };
        if (wrap.contains(document.activeElement)) hasSel = true;
      }
      let editing = activeInput ? { value: activeInput.value, opened: openedWith } : null;
      // An undo or redo takes the typing out of an open cell editor too. The typing
      // session ends, and the editor reopens on what the file now holds for its cell,
      // so the next key carries on from there; if the step put the active cell
      // somewhere else, the editor closes.
      if (editing && view.state.field(historyStepped, false)) {
        typing = null;
        composing = false;
        const value = getCell(focus.r, focus.c);
        editing = focus.r === was.r && focus.c === was.c ? { value, opened: value } : null;
        if (!editing) hasSel = true;
      }
      const hadFocus = wrap.contains(document.activeElement);
      // The render below replaces the grid's DOM, so an open editor goes with it.
      activeInput?.destroy();
      activeInput = null;
      firstRender = true;
      justChanged = new Set(view.state.field(changedRows, false) ?? []);
      render();
      // A header can have changed, which can end the board (see syncBoard).
      syncBoard();
      if (editing) {
        edit(editing.value);
        openedWith = editing.opened;
      } else if (hadFocus) focusGrid();
      return true;
    };
    // Whichever way the grid takes the rebuilt decoration, moved, rewritten by its
    // own write or by someone else's, its rows can now be on other lines, so the
    // marks are read again.
    liveGrids.set(wrap, (next) => {
      const adopted = adopt(next);
      if (adopted) paintArrived();
      return adopted;
    });

    render();
    // A table kept as a board is drawn as one from the start.
    syncBoard();
    wrap.append(caption, controls, boardNote, gridHost, boardHost);
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ---- Field ----------------------------------------------------------------

function buildTableDecorations(state: EditorState, prev: DecorationSet | null): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  const reveal = state.field(revealField, false);

  /** Whether this table was showing its source in the state `prev` was built from. */
  const wasSource = (from: number, to: number): boolean => {
    if (!prev) return false;
    let drawn = false;
    prev.between(from, to, (a, b) => {
      if (a === from && b === to) drawn = true;
      return drawn ? false : undefined;
    });
    return !drawn;
  };

  /*
   * Whether to show a table's Markdown in place of its grid.
   *
   * Two things ask for the raw pipes. An explicit reveal — Edit Markdown, or the
   * grid's own Edit raw source — is one. A caret moved inside the table is the
   * other: someone went into its text to edit it by hand.
   *
   * What a selection covers is not a third. A selection can land on a table
   * nobody was aiming at, and every way it does turned the whole grid into pipes
   * and dashes: a double-click in the margin level with a row, a
   * double-click just right of the table, a drag from the paragraph above that
   * overshoots it, Select All, which is what people press before copying a
   * document, and a find match inside a cell, which turned the table raw at the
   * moment someone found the value they were looking for.
   *
   * So a selection never opens a table that is closed. It only keeps open one
   * that already was, which is what lets someone who moved a caret in and began
   * selecting the pipes carry on selecting them. That is the `wasSource` test,
   * and it is the one piece of this that reads the previous state rather than
   * this one: where the caret sits cannot tell a find match apart from a
   * Shift+Right grown inside the table, since both end up wholly inside it, so
   * what separates them is whether the table was open before the selection
   * arrived.
   *
   * The caret test alone still settles the gestures above, and not by luck. A
   * double-click's word selection is undirectional, and an undirectional range's
   * head is its `to`, so beside a table the head comes to rest on the closing
   * boundary rather than inside it. A drag or a Select All leaves the head past
   * the last line. And a drag released *inside* a drawn table cannot leave the
   * head there at all, because the grid is an atomic range and CodeMirror snaps a
   * directional range's ends out of one.
   */
  const isActive = (from: number, to: number): boolean => {
    if (reveal && reveal.from <= to && reveal.to >= from) return true;
    for (const r of state.selection.ranges) {
      if (r.head > from && r.head < to && (r.empty || wasSource(from, to))) return true;
    }
    return false;
  };

  const push = (
    from: number,
    to: number,
    kind: 'pipe' | 'csv',
    data: TableData,
    lang: string,
    prefix: string,
    name: TableName | null = null
  ): void => {
    const sig = JSON.stringify({ data, lang, prefix, name });
    decos.push(
      Decoration.replace({
        widget: new TableWidget(kind, from, to, data, sig, lang, prefix, name),
        block: true,
      }).range(from, to)
    );
  };

  // A block's name is checked against every other block's, drawn or not, so a
  // duplicate is flagged on both even while one of them shows its source.
  const names = new Map<number, TableName>();
  for (const b of dataBlocks(state)) if (b.id) names.set(b.from, { id: b.id, duplicate: b.duplicate });

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        const line = doc.lineAt(node.from);
        const from = line.from;
        const to = doc.lineAt(Math.max(node.from, node.to - 1)).to;
        if (isActive(from, to)) return;
        const prefix = containerPrefix(line.text, node.from - from, true);
        const bare = bareTable(doc.sliceString(from, to), prefix);
        const data = bare && parsePipeTable(bare.text);
        if (data && data.headers.length) push(from, to, 'pipe', data, '', prefix);
      } else if (node.name === 'FencedCode') {
        const raw = doc.sliceString(node.from, node.to);
        const info = fenceLang(raw);
        if (info !== 'csv' && info !== 'tsv') return;
        const line = doc.lineAt(node.from);
        const from = line.from;
        const to = doc.lineAt(Math.max(node.from, node.to - 1)).to;
        if (isActive(from, to)) return;
        const prefix = containerPrefix(line.text, node.from - from, false);
        const bare = bareTable(doc.sliceString(from, to), prefix);
        if (!bare) return;
        const grid = parseDelimited(fenceBody(bare.text), info === 'tsv' ? '\t' : ',');
        if (grid.length) {
          const [headers, ...rows] = grid;
          push(from, to, 'csv', { headers, aligns: headers.map(() => null), rows }, info, prefix, names.get(from) ?? null);
        }
      }
    },
  });

  return Decoration.set(decos, true);
}

/** Indices of `next` lines that a line-level longest common subsequence shares with `prev`. */
function sharedLines(prev: string[], next: string[]): Set<number> {
  const n = prev.length;
  const m = next.length;
  const shared = new Set<number>();
  if (n * m > 160000) {
    // Too large to diff cheaply: compare line by line in place.
    next.forEach((line, i) => {
      if (prev[i] === line) shared.add(i);
    });
    return shared;
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = prev[i] === next[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (prev[i] === next[j]) {
      shared.add(j);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return shared;
}

/**
 * Line starts of table lines that an outside edit just added or changed: the host
 * applying a change made by an agent, a pull, or another editor, which arrives as
 * a remote transaction. The host sends one replacement spanning the first to the
 * last changed character, so the rows inside it are compared line by line and
 * only lines that really differ are kept. Read when the table re-renders, and
 * emptied by the next transaction.
 */
const changedRows = StateField.define<readonly number[]>({
  create: () => [],
  update(value, tr) {
    if (!tr.docChanged || !tr.annotation(Transaction.remote)) return value.length ? [] : value;
    const touched: [number, number][] = [];
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      touched.push([fromB, toB]);
    });
    const back = tr.changes.invert(tr.startState.doc);
    const starts: number[] = [];
    tr.state.field(tableField).between(0, tr.state.doc.length, (from, to) => {
      if (!touched.some(([a, b]) => a <= to && b >= from)) return;
      const next = tr.state.sliceDoc(from, to).split('\n');
      const prev = tr.startState.sliceDoc(back.mapPos(from, -1), back.mapPos(to, 1)).split('\n');
      const shared = sharedLines(prev, next);
      let at = from;
      next.forEach((line, i) => {
        if (!shared.has(i)) starts.push(at);
        at += line.length + 1;
      });
    });
    return starts;
  },
});

/**
 * Where a grid write shows in its table: the table's start, the first cell it
 * changed as the table read before the write, and that cell as it reads after.
 * The history keeps it with the write (see `tables`), so undo and redo can put the
 * active cell back on the change.
 */
const tableStep = StateEffect.define<{ at: number; undo: Cell; redo: Cell }>({
  map: (value, mapping) => ({ ...value, at: mapping.mapPos(value.at, 1) }),
});

/** The table start and cell an undo or redo of a grid write lands on, while that transaction is applied. */
const stepCell = StateField.define<{ at: number; cell: Cell } | null>({
  create: () => null,
  update(value, tr) {
    const undo = tr.isUserEvent('undo');
    const steps = undo || tr.isUserEvent('redo') ? tr.effects.filter((e) => e.is(tableStep)) : [];
    if (!steps.length) return value === null ? value : null;
    // Keystrokes joined into one undo step list the newest first: undo lands where
    // the oldest began and redo where the newest ended.
    const step = (undo ? steps[steps.length - 1] : steps[0]).value as { at: number; undo: Cell; redo: Cell };
    return { at: step.at, cell: undo ? step.undo : step.redo };
  },
});

/** Whether the latest transaction was an undo or a redo. */
const historyStepped = StateField.define<boolean>({
  create: () => false,
  update: (_value, tr) => tr.isUserEvent('undo') || tr.isUserEvent('redo'),
});

/** A history step that carries no text: `dropRedo` going in, `redoDropped` as its inverse. */
const dropRedo = StateEffect.define<null>();
const redoDropped = StateEffect.define<null>();

/**
 * Empty the redo history, leaving the document and the undo history as they are.
 * The history has no call for that, so this uses two things it does: recording a
 * step clears the redo side, and undoing a step whose inverse inverts to nothing
 * puts nothing back. Neither transaction changes any text, so the file is untouched.
 */
function forgetRedo(view: EditorView): void {
  if (!redoDepth(view.state)) return;
  view.dispatch({ effects: dropRedo.of(null), userEvent: 'history.forget' });
  undoDocument(view);
}

/**
 * Leaving a table upward from a document's first line adds two lines above it: one
 * to type on, and a blank line that keeps what is typed out of the header row. They
 * stay only once something is typed there. If the caret moves off that line first,
 * they are taken out again, so arrow keys alone never change the file. Holds the
 * start of the added lines, or null.
 */
const setLeadLines = StateEffect.define<number | null>();
const leadLines = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLeadLines)) return e.value;
    return value === null || !tr.docChanged ? value : tr.changes.mapPos(value, -1);
  },
});

/** The added lines, when they are still blank and still directly above a table. */
function leadLinesAt(state: EditorState): { at: number; tableFrom: number } | null {
  const at = state.field(leadLines, false);
  if (at === null || at === undefined || state.doc.sliceString(at, at + 2) !== '\n\n') return null;
  let table = false;
  state.field(tableField).between(at + 2, at + 2, (from) => {
    if (from === at + 2) table = true;
  });
  return table ? { at, tableFrom: at + 2 } : null;
}

/** Take the added lines out, outside the undo history, when the caret leaves them untyped. */
const takeBackLeadLines = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection) return tr;
  const lead = leadLinesAt(tr.startState);
  if (!lead || (tr.newSelection.ranges.length === 1 && tr.newSelection.main.head === lead.at)) return tr;
  return [
    tr,
    {
      changes: { from: lead.at, to: lead.at + 2 },
      effects: setLeadLines.of(null),
      annotations: Transaction.addToHistory.of(false),
      sequential: true,
    },
  ];
});

/**
 * Arrow keys carry the caret into an adjacent table's grid. A table is an atomic
 * block, so without this the caret jumps from the line above a table to the line
 * below it and a keyboard user can never reach a cell.
 */
function enterAdjacentTable(down: boolean) {
  return (view: EditorView): boolean => {
    const { selection, doc } = view.state;
    const sel = selection.main;
    if (!sel.empty || selection.ranges.length > 1) return false;
    // Down from the line added above a table on the first line goes straight back
    // into the table; moving the caret off that line takes the added lines out.
    const lead = down ? leadLinesAt(view.state) : null;
    if (lead && sel.head === lead.at) {
      view.dispatch({ selection: { anchor: lead.tableFrom } });
      for (const wrap of Array.from(view.dom.querySelectorAll('.sheaf-table'))) {
        const entry = gridEntries.get(wrap);
        if (entry && entry.from === lead.at) {
          entry.enter(true);
          return true;
        }
      }
      return true;
    }
    const line = doc.lineAt(sel.head);
    if (down ? line.number >= doc.lines : line.number <= 1) return false;
    // On a wrapped line, the caret moves between its visual rows first.
    try {
      const moved = view.moveVertically(sel, down);
      if (moved.head !== sel.head && moved.head >= line.from && moved.head <= line.to) return false;
    } catch {
      // No layout to measure (tests); treat the line as a single visual row.
    }
    const next = doc.line(line.number + (down ? 1 : -1));
    for (const wrap of Array.from(view.dom.querySelectorAll('.sheaf-table'))) {
      const entry = gridEntries.get(wrap);
      if (entry && (down ? entry.from === next.from : entry.to === next.to)) {
        entry.enter(down);
        return true;
      }
    }
    return false;
  };
}

/**
 * Block-decoration field that renders tables. Provided as both `decorations`
 * (so the block widgets participate in layout) and `atomicRanges` (so cursor
 * motion glides over a rendered table as one unit, like other widgets).
 */
const tableField = StateField.define<DecorationSet>({
  create: (state) => buildTableDecorations(state, null),
  update(value, tr) {
    // The editor parses a long document in stages, the first stage at load and the
    // rest in the background, so a table further down enters the syntax tree later
    // in a transaction that changes nothing else. Rebuild when the tree grows too.
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setReveal)) ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      // What was drawn a moment ago decides whether a selection may keep a table
      // open; positions are mapped first so an edit does not look like a redraw.
      return buildTableDecorations(tr.state, tr.docChanged ? value.map(tr.changes) : value);
    }
    return value.map(tr.changes);
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f)),
  ],
});

/**
 * True when `from`..`to` sits inside a table drawn as a grid, whose cells already
 * show that text. Find reveals the Markdown under a range the live preview hides,
 * so a match can be seen where it sits; a grid is the case where it can be seen
 * without revealing anything, so find asks this before opening a table's pipes.
 */
/*
 * Find inside a grid. The cells already show the matched text, so a match is
 * marked on the cell that holds it: every such cell tinted as prose matches are,
 * the current match's cell more strongly, and stepping onto a match makes its
 * cell the grid's active one. search.ts says which query is showing and when the
 * search stepped; each grid does the rest against its own text.
 */

/** The query each editor's find bar is showing, or null while the bar is closed. */
const gridSearches = new WeakMap<EditorView, SearchQuery | null>();
/** Each drawn grid's way of marking the matches in its cells. */
const liveSearch = new WeakMap<Element, () => void>();

let searchPasses = 0;
/** How many times a grid has looked for find's matches in its text. The tables suite bounds it. */
export const tableSearchPasses = (): number => searchPasses;

/**
 * Mark `query`'s matches in every grid drawn in `view`, or take the marks off when
 * it is null. A grid looks for matches again only when the query or its own text
 * has changed, so calling this as the selection moves costs a repaint of the
 * current match and nothing more.
 */
export function markTableMatches(view: EditorView, query: SearchQuery | null): void {
  gridSearches.set(view, query && query.valid && query.search ? query : null);  for (const el of Array.from(view.dom.querySelectorAll('.sheaf-table'))) liveSearch.get(el)?.();
}

/**
 * After find moved the selection onto a match, make the cell holding it the active
 * cell of its grid and bring it into view. The keyboard stays where it was, in the
 * find field, so the next Enter goes on to the next match. False when the match is
 * not inside a grid.
 */
export function followTableMatch(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  if (from === to) return false;
  for (const el of Array.from(view.dom.querySelectorAll('.sheaf-table'))) {
    const entry = gridEntries.get(el);
    if (entry && entry.from <= from && to <= entry.to) return entry.showMatch(from);
  }
  return false;
}

export function tableGridCovers(state: EditorState, from: number, to: number): boolean {
  let covered = false;
  state.field(tableField, false)?.between(from, to, (a, b) => {
    if (a <= from && b >= to) covered = true;
    return covered ? false : undefined;
  });
  return covered;
}

/**
 * A GFM table runs until a blank line, so text typed or pasted on the empty line
 * directly under a table becomes another table row: the first letter joined the
 * grid and the rest of the typing landed at the start of whatever came next.
 * While the table is shown as a grid, that text starts its own paragraph one line
 * down instead, keeping the blank line that separates it from the table. Edits
 * that are not user input (the host applying a file change) pass through as is.
 */
const keepTypingOutOfTableBelow = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input')) return tr;
  const inserts: { at: number; text: string; replaced: boolean }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    inserts.push({ at: fromA, text: inserted.toString(), replaced: toA !== fromA });
  });
  if (inserts.length !== 1 || inserts[0].replaced) return tr;
  const { at, text } = inserts[0];
  if (!text || text.startsWith('\n')) return tr;
  const { doc } = tr.startState;
  const line = doc.lineAt(at);
  if (line.number === 1 || line.from !== at || line.to !== at) return tr;
  let belowTable = false;
  tr.startState.field(tableField).between(at - 1, at - 1, (_from, to) => {
    if (to === at - 1) belowTable = true;
  });
  if (!belowTable) return tr;
  return {
    changes: { from: at, insert: '\n' + text },
    selection: EditorSelection.cursor(at + 1 + text.length),
    scrollIntoView: true,
    userEvent: tr.annotation(Transaction.userEvent),
  };
});

/**
 * A range copied from a spreadsheet and pasted into prose becomes a table. The
 * clipboard's plain text for a range is tab-separated; two or more rows of two
 * or more columns are inserted as a pipe table on its own block and opened as a
 * grid. Any other paste, and any paste into a grid, code or a table's source, is
 * left to the editor.
 */
const pasteRangeAsTable = EditorView.domEventHandlers({
  paste(event, view) {
    if ((event.target as Element | null)?.closest?.('.sheaf-table')) return false;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text.includes('\t')) return false;
    const plain = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    const isRange = (rows: string[][]): boolean => rows.length >= 2 && rows.every((row) => row.length >= 2);
    // The same reading the grid's own paste uses: quotes count where they wrap a
    // line break or a tab, as a spreadsheet writes them.
    const rows = parseClipboardGrid(plain, isRange);
    if (!isRange(rows)) return false;
    let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(view.state).resolveInner(view.state.selection.main.head, -1);
    for (; node; node = node.parent) {
      if (/^(FencedCode|CodeBlock|Table|HTMLBlock)$/.test(node.name)) return false;
    }
    event.preventDefault();
    insertBlock(view, formatPipeTable(rows), 2);
    return true;
  },
});

/** Tables rendered as editable grids, plus the arrow keys that reach them from the keyboard. */
/**
 * Keeps each grid's marks for an outside write in step with the field they come
 * from (see changeMarks.ts). A grid redrawn or rebuilt reads the field itself; this
 * covers the transactions that leave a grid's DOM alone and still change its
 * marks, such as lines taken away just past the end of a table. It runs before the
 * grids adopt the transaction, so it hands them its changes to find the table by.
 * An editor without the field has no marks, and this does nothing.
 */
const arrivedRows = ViewPlugin.define(() => ({
  update(u) {
    if (u.state.field(arrivedLines, false) === u.startState.field(arrivedLines, false)) return;
    for (const wrap of Array.from(u.view.dom.querySelectorAll('.sheaf-table'))) {
      liveArrived.get(wrap)?.(u.docChanged ? u.changes : undefined);
    }
  },
}));

export const tables: Extension = [
  tableField,
  arrivedRows,
  pasteRangeAsTable,
  changedRows,
  stepCell,
  historyStepped,
  invertedEffects.of((tr) => tr.effects.filter((e) => e.is(tableStep))),
  invertedEffects.of((tr) => (tr.effects.some((e) => e.is(dropRedo)) ? [redoDropped.of(null)] : [])),
  keepTypingOutOfTableBelow,
  leadLines,
  takeBackLeadLines,
  Prec.high(
    keymap.of([
      { key: 'ArrowDown', run: enterAdjacentTable(true) },
      { key: 'ArrowUp', run: enterAdjacentTable(false) },
    ])
  ),
];

// ---- Insertion ------------------------------------------------------------

const PIPE_SKELETON = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |';
const CSV_SKELETON = '```csv\nColumn 1,Column 2,Column 3\nCell,Cell,Cell\n```';

/**
 * Insert a starter table as its own block and open it as a grid with the first
 * header cell selected, so typing replaces the placeholder and Tab moves on.
 * The table goes on the caret's line when that line is blank and after it
 * otherwise, with a blank line kept below it: text directly under a table would
 * be parsed as another row. Selected text is replaced, as it is by any other
 * insert, and the block then goes where what is left of the line puts it.
 */
function insertBlock(view: EditorView, block: string, caretOffset: number): void {
  // Taking the selected text out first is one transaction with the insert below,
  // so a single undo puts the text back and takes the table away together.
  const picked = view.state.selection.main;
  const clearing = picked.empty ? null : view.state.update({ changes: { from: picked.from, to: picked.to } });
  const state = clearing ? clearing.state : view.state;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const blank = line.text.trim() === '';
  // Off a blank line the table goes after the whole block holding the caret, so a
  // paragraph written across several lines is not split in two.
  let last = line;
  if (!blank) {
    const topAt = (side: -1 | 1) => {
      let node = syntaxTree(state).resolveInner(pos, side);
      while (node.parent && node.parent.name !== 'Document') node = node.parent;
      return node;
    };
    let top = topAt(1);
    if (top.name === 'Document') top = topAt(-1);
    if (top.name !== 'Document') last = state.doc.lineAt(Math.max(top.from, top.to - 1));
  }
  const at = blank ? line.from : last.to;
  // On a blank line directly under other text, keep a blank line above the table
  // too: a table written straight under another table's last row would join it.
  const above = blank && line.number > 1 ? state.doc.line(line.number - 1).text.trim() !== '' : false;
  const lead = blank ? (above ? '\n' : '') : '\n\n';
  const next = last.number < state.doc.lines ? state.doc.line(last.number + 1) : null;
  // An empty last line below another one is the line break that ends the file. The
  // block is written over that line, so without this the file would end on the
  // block's last character and every reader would report a missing final line
  // break. A file that is empty altogether has no such break to keep.
  const endsFile = !next && blank && line.text === '' && line.number > 1;
  const tail = (next !== null && next.text.trim() !== '') || endsFile ? '\n' : '';
  const insert = lead + block + tail;
  const tableFrom = at + lead.length;
  const tableEnd = tableFrom + block.length;
  const newLength = state.doc.length - (blank ? line.length : 0) + insert.length;
  const written = state.changes({ from: at, to: blank ? line.to : at, insert });
  view.dispatch({
    changes: clearing ? clearing.changes.compose(written) : written,
    // Park the caret past the table so it renders as a grid rather than as source.
    selection: { anchor: tableEnd < newLength ? tableEnd + 1 : tableEnd },
    scrollIntoView: true,
  });
  for (const el of Array.from(view.dom.querySelectorAll('.sheaf-table'))) {
    const entry = gridEntries.get(el);
    if (entry && entry.from === tableFrom) {
      entry.focusCell(-1, 0);
      return;
    }
  }
  // The grid did not render (the table is shown as source): fall back to the caret.
  view.dispatch({ selection: { anchor: tableFrom + caretOffset } });
  view.focus();
}

/** Insert a GFM pipe-table skeleton, caret in the first header cell. */
export function insertPipeTable(view: EditorView): boolean {
  insertBlock(view, PIPE_SKELETON, 2);
  return true;
}

/** Insert a ```csv data-table skeleton, caret in the first header cell. */
export function insertCsvTable(view: EditorView): boolean {
  insertBlock(view, CSV_SKELETON, '```csv\n'.length);
  return true;
}
