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

import { StateField, StateEffect, EditorState, EditorSelection, Range, Prec, Extension, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { undo as undoDocument, redo as redoDocument, undoDepth, isolateHistory, invertedEffects } from '@codemirror/commands';
import { revealField, setReveal } from './livePreview';
import { openLink } from './linkTarget';

type Align = 'left' | 'center' | 'right' | null;

interface TableData {
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

/** One line of a delimited block: its cells, its source text, and where it starts. */
interface DelimitedRow {
  cells: string[];
  raw: string;
  start: number;
  /** A wholly blank line. It carries no delimiter, so it is not a record. */
  blank: boolean;
}

/** A line holding no delimiter and nothing but whitespace is blank, not an empty record. */
const isBlankRecord = (cells: string[]): boolean => cells.length === 1 && cells[0].trim() === '';

/** Parse delimited (CSV/TSV) text into rows of cells, each with its source text. */
function parseDelimitedRows(text: string, delim: string): DelimitedRow[] {
  const rows: DelimitedRow[] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  let start = 0;
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
      cur = '';
      fresh = true;
    } else if (ch === '\n') {
      row.push(cur);
      rows.push({ cells: row, raw: text.slice(start, i), start, blank: isBlankRecord(row) });
      row = [];
      cur = '';
      start = i + 1;
      fresh = true;
    } else if (ch !== '\r') {
      cur += ch;
      fresh = false;
    }
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push({ cells: row, raw: text.slice(start), start, blank: isBlankRecord(row) });
  }
  return rows;
}

/**
 * The records of a delimited block: every line except the wholly blank ones. A
 * record whose fields are all empty (`,`) is still a record, and the grid gives it
 * a row; a blank line is neither, and the writer keeps it where it sits.
 */
function delimitedRecords(text: string, delim: string): DelimitedRow[] {
  return parseDelimitedRows(text, delim).filter((r) => !r.blank);
}

/** Parse delimited (CSV/TSV) text, honoring `"`-quoted fields with escapes. */
function parseDelimited(text: string, delim: string): string[][] {
  return delimitedRecords(text, delim).map((r) => r.cells);
}

/** Strip the opening/closing fence lines from a fenced code block's raw text. */
function fenceBody(text: string): string {
  const lines = text.split('\n');
  if (lines.length && /^\s*(`{3,}|~{3,})/.test(lines[0])) lines.shift();
  if (lines.length && /^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}

/** The info string (language) of a fenced code block, lowercased. */
function fenceInfo(text: string): string {
  const m = /^\s*(?:`{3,}|~{3,})[ \t]*([^\n`]*)/.exec(text);
  return m ? m[1].trim().toLowerCase() : '';
}

/**
 * Parse clipboard text into a grid. A spreadsheet range arrives as lines of
 * tab-separated cells; any other text is a value per line, kept as written, so a
 * sentence with a comma or quotes lands in one cell and an empty line stays an
 * empty cell.
 */
function parseClipboardGrid(raw: string): string[][] {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
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

/**
 * Render a cell's inline Markdown to HTML for display (bold/italic/strike/code/
 * links). Cells hold raw Markdown in the model and while editing; only the
 * rendered grid runs this. Code spans, backslash escapes and character
 * references are set aside first, so formatting never reads inside them.
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
    } else if (ch === '`' && src.indexOf('`', i + 1) > i + 1) {
      const close = src.indexOf('`', i + 1);
      const code = src.slice(i + 1, close);
      s += hold(`<code class="tok-inline-code">${escapeHtml(code)}</code>`, code);
      i = close + 1;
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
  prefix: string; // anything before a leading pipe
  lead: boolean;
  cells: string[];
  trail: boolean;
  suffix: string; // anything after a trailing pipe
}

/** Split a source line into the same cells `splitPipeRow` finds, keeping every byte. */
function splitRawRow(line: string): RawRow {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
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
  const prefix = lead ? parts.shift()! : '';
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
/**
 * How many columns a string takes in a monospace editor: East Asian wide and
 * fullwidth characters, and emoji, take two.
 */
function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
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
    return body.length > 0 && body.every((v) => /^[-+]?[\d.,]+%?$/.test(v));
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
  // A field is quoted only when it could not be read back as written: it holds the
  // delimiter or a line break, or it opens with a quote, which a reader takes as
  // the start of a quoted field. A quote anywhere else is literal data, so it is
  // written as typed rather than quoting and doubling the whole field.
  const needsQuote = (s: string): boolean => s.startsWith('"') || s.includes(delim) || /[\n\r]/.test(s);
  const esc = (s: string): string => (needsQuote(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const sameCols = isIdentity(cols, orig.headers.length);
  // A record may carry more fields than the header. The grid has no column for them
  // and never shows them, so they are data sitting on a line the person did not
  // edit: the row is written at its own width to keep them, the way a pipe table
  // keeps cells past its header's width. Changing the columns gives up that claim.
  const line = (cells: string[]): string => {
    const n = Math.max(d.headers.length, sameCols ? cells.length : 0);
    return Array.from({ length: n }, (_, c) => esc(cells[c] ?? '')).join(delim);
  };

  const lines = src.split('\n');
  const open = lines.shift() ?? '```' + lang;
  const close =
    lines.length && /^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1]) ? lines.pop()! : null;
  const body = lines.join('\n');
  const entries = parseDelimitedRows(body, delim);
  const raw = entries.filter((e) => !e.blank).map((e) => e.raw);
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
  out.push(sameCols && raw[0] !== undefined && sameCells(orig.headers, d.headers) ? raw[0] : line(d.headers));
  out.push(...(blanks.get(0) ?? []));
  d.rows.forEach((row, r) => {
    const k = rows[r] ?? dupes[r] ?? null;
    const kept = k === null ? undefined : raw[k + 1];
    out.push(kept !== undefined && k !== null && sameCols && sameCells(orig.rows[k], row) ? kept : line(row));
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
 * while a cell's <input> is focused, so ordinary in-cell copy/paste stays native.
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

/** A row or column action for the right-click menu, bound to the clicked cell. */
export interface TableAction {
  label: string;
  run: () => void;
  /** Draw a separator before this action, to start a new group. */
  separator?: boolean;
}

const gridEntries = new WeakMap<
  Element,
  {
    from: number;
    to: number;
    enter: (fromAbove: boolean) => void;
    focusCell: (r: number, c: number) => void;
    actions: (r: number, c: number) => TableAction[];
    selectedRows: () => { r1: number; r2: number } | null;
  }
>();

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
  const cell = activeCellFor(el);
  return cell ? entry.actions(Number(cell.dataset.r), Number(cell.dataset.c)) : [];
}

/** Each rendered table's lookup from a grid row (-1 for the header) to its source range. */
/**
 * A cell's leading number, allowing a sign, a currency symbol, thousands separators
 * and a decimal part, so -12 sorts below -5 and $1,200 above $30. Null when the cell
 * starts with text.
 */
function leadingNumber(cell: string): number | null {
  const m = /^([-+\u2212]?)[$€£¥]?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/.exec(cell);
  if (!m) return null;
  return Number((m[1] && m[1] !== '+' ? '-' : '') + m[2].replace(/,/g, '') + (m[3] ?? ''));
}

/**
 * The three numbers of a cell written as a whole slashed date, in the order they
 * are written, or null for anything else. The whole cell has to be the date:
 * `1/2 cup` is a quantity, and a cell that merely starts with a date is text.
 * ISO dates need nothing here, since they already sort correctly as text.
 */
function slashedDate(cell: string): [number, number, number] | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(cell.trim());
  if (!m) return null;
  // A two-digit year is read the way a spreadsheet reads it.
  const short = Number(m[3]);
  return [Number(m[1]), Number(m[2]), m[3].length === 2 ? short + (short < 70 ? 2000 : 1900) : short];
}

/** Which field of a slashed date holds the day, for one column of them. */
type DateOrder = 'day-first' | 'month-first';

/**
 * How to read the slashed dates in a column, taken from the column itself. A first
 * field above 12 can only be a day, and a second field above 12 can only be a day,
 * so one such cell settles the order for every other cell beside it.
 *
 * A column where nothing settles it, or where two cells settle it opposite ways, is
 * not read as dates at all. Those sort as text, which looks unsorted and is honest.
 * A column put in the wrong date order looks sorted and is not, and a person reading
 * the earliest entry off the top of it acts on a wrong answer with nothing to warn
 * them. Assuming one country's convention would give that answer to everyone else.
 */
function columnDateOrder(cells: readonly string[]): DateOrder | null {
  let dayFirst = false;
  let monthFirst = false;
  for (const cell of cells) {
    const parts = slashedDate(cell);
    if (!parts) continue;
    if (parts[0] > 12) dayFirst = true;
    if (parts[1] > 12) monthFirst = true;
  }
  if (dayFirst && monthFirst) return null;
  return dayFirst ? 'day-first' : monthFirst ? 'month-first' : null;
}

/** A cell's date as a number that sorts in date order, read in its column's order. */
function dateValue(cell: string, order: DateOrder): number | null {
  const parts = slashedDate(cell);
  if (!parts) return null;
  const [first, second, year] = parts;
  const [day, month] = order === 'day-first' ? [first, second] : [second, first];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year * 10000 + month * 100 + day;
}

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
 * The file lines and source that Copy ref names for a right-clicked table row, or
 * for the selected rows it is inside, as the table will read once it is saved. A
 * row moved or added in the grid is named where the save puts it.
 */
export function tableRowRefAt(target: EventTarget | null): { start: number; end: number; text: string } | null {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return null;
  const wrap = el.closest('.sheaf-table');
  const pending = wrap && pendingRows.get(wrap);
  if (!pending) return null;
  const cell = activeCellFor(el);
  const r = cell ? Number(cell.dataset.r) : NaN;
  const sel = gridEntries.get(wrap)?.selectedRows();
  if (sel && sel.r1 !== sel.r2 && r >= sel.r1 && r <= sel.r2) return pending(sel.r1, sel.r2);
  // Outside any cell, the ref covers the whole table.
  return Number.isNaN(r) ? pending(1, 0) : pending(r, r);
}

/** Numbers each rendered grid, so its cells can carry document-unique ids for aria-activedescendant. */
let gridSeq = 0;

/** Each live grid's way to take over from a rebuilt decoration for the same table. */
const liveGrids = new WeakMap<HTMLElement, (next: TableWidget) => boolean>();

// ---- Widget ---------------------------------------------------------------

interface Cell {
  r: number; // -1 = header row, 0.. = body row
  c: number;
}

class TableWidget extends WidgetType {
  constructor(
    readonly kind: 'pipe' | 'csv',
    readonly from: number,
    readonly to: number,
    readonly data: TableData,
    readonly sig: string,
    readonly lang: string
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

  get estimatedHeight(): number {
    return (this.data.rows.length + 1) * 33 + 34;
  }

  toDOM(view: EditorView): HTMLElement {
    const { kind, lang } = this;
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
      return kind === 'pipe'
        ? writePipe(src, orig, d, rows, colOrigin, dupes, typingCell())
        : writeCsv(src, orig, d, rows, colOrigin, lang, dupes);
    };

    const wrap = document.createElement('div');
    wrap.className = 'sheaf-table' + (kind === 'csv' ? ' is-csv' : '');
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
      selectedRows: () => (hasSel ? { r1: selRect().r1, r2: selRect().r2 } : null),
      actions: (r, c) => {
        const items: TableAction[] = [];
        let separator = false;
        const add = (label: string, fn: () => void): void => {
          items.push({ label, run: fn, separator });
          separator = false;
        };
        const group = (): void => {
          separator = items.length > 0;
        };
        const lastCol = colCount() - 1;
        // Row and column actions act on the selection when the menu was opened inside
        // it, else on the clicked cell. Inserting adds one row or column beside it.
        const s = selRect();
        const inSel = hasSel && r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;
        const at = { r, c };
        const [a, f] = inSel ? [{ ...anchor }, { ...focus }] : [at, at];
        const rowSpan = moveSpan(true, a, f, at)!;
        const colSpan = moveSpan(false, a, f, at)!;
        const rowWord = rowSpan.hi > rowSpan.lo ? 'rows' : 'row';
        const colWord = colSpan.hi > colSpan.lo ? 'columns' : 'column';
        const rowsShifted = (n: number): void =>
          selectRange({ r: rowSpan.a.r + n, c: rowSpan.a.c }, { r: rowSpan.f.r + n, c: rowSpan.f.c });
        const colsShifted = (n: number): void =>
          selectRange({ r: colSpan.a.r, c: colSpan.a.c + n }, { r: colSpan.f.r, c: colSpan.f.c + n });
        if (rowSpan.lo >= 0) add('Insert row above', () => (addRowAt(rowSpan.lo - 1), select(rowSpan.lo, c)));
        add('Insert row below', () => (addRowAt(rowSpan.hi), select(rowSpan.hi + 1, c)));
        if (rowSpan.lo >= 0)
          add(`Duplicate ${rowWord}`, () => (dupRowAt(rowSpan.lo, rowSpan.hi), rowsShifted(rowSpan.hi - rowSpan.lo + 1)));
        if (rowSpan.lo > 0) add(`Move ${rowWord} up`, () => moveBlock('up', a, f, at));
        if (rowSpan.lo >= 0 && rowSpan.hi < lastRow()) add(`Move ${rowWord} down`, () => moveBlock('down', a, f, at));
        if (rowSpan.lo >= 0)
          add(`Delete ${rowWord}`, () => (delRowAt(rowSpan.lo, rowSpan.hi), select(clampRow(rowSpan.lo), c)));
        group();
        add('Insert column left', () => (addColAt(colSpan.lo - 1), select(r, colSpan.lo)));
        add('Insert column right', () => (addColAt(colSpan.hi), select(r, colSpan.hi + 1)));
        add(`Duplicate ${colWord}`, () => (dupColAt(colSpan.lo, colSpan.hi), colsShifted(colSpan.hi - colSpan.lo + 1)));
        if (colSpan.lo > 0) add(`Move ${colWord} left`, () => moveBlock('left', a, f, at));
        if (colSpan.hi < lastCol) add(`Move ${colWord} right`, () => moveBlock('right', a, f, at));
        if (colCount() > colSpan.hi - colSpan.lo + 1)
          add(`Delete ${colWord}`, () => (delColAt(colSpan.lo, colSpan.hi), select(r, clampCol(colSpan.lo))));
        if (rowCount() > 1) {
          group();
          add('Sort column A to Z', () => (sortRows(c, false), select(r, c)));
          add('Sort column Z to A', () => (sortRows(c, true), select(r, c)));
        }
        // Pipe tables carry alignment in the delimiter row; CSV has nowhere to keep it.
        if (kind === 'pipe') {
          group();
          add('Align column left', () => (alignCol(c, 'left'), select(r, c)));
          add('Align column center', () => (alignCol(c, 'center'), select(r, c)));
          add('Align column right', () => (alignCol(c, 'right'), select(r, c)));
          if (data.aligns[c]) add('Clear column alignment', () => (alignCol(c, null), select(r, c)));
          group();
          add('Pad columns to line up', () => padColumns(r, c));
        }
        return items;
      },
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
    // Where row `k` (-1 for the header) of a table's text sits, as offsets into it.
    const rowSpan = (src: string, k: number): { from: number; to: number } | null => {
      if (kind === 'pipe') {
        const lines = src.split('\n');
        let idx = k === -1 ? 0 : -1;
        for (let i = 2, seen = -1; k !== -1 && i < lines.length; i++) {
          if (lines[i].trim() !== '' && ++seen === k) {
            idx = i;
            break;
          }
        }
        if (idx < 0) return null;
        const at = lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
        return { from: at, to: at + lines[idx].length };
      }
      const body = src.indexOf('\n') + 1;
      const row = body ? delimitedRecords(src.slice(body), lang === 'tsv' ? '\t' : ',')[k + 1] : undefined;
      return row ? { from: body + row.start, to: body + row.start + row.raw.length } : null;
    };
    // The grid cell at `offset` of a table's text (the header for the header and
    // delimiter lines). A change that starts by adding or removing a line break
    // shows on the line after it.
    const cellAt = (src: string, offset: number): Cell => {
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
      let i = 0;
      while (i + 1 < rows.length && rows[i + 1].start <= offset - body) i++;
      const cells = delimitedRecords(src.slice(body + (rows[i]?.start ?? 0), offset), delim)[0]?.cells.length ?? 1;
      return { r: i - 1, c: Math.max(0, cells - 1) };
    };
    rowSources.set(wrap, (r) => {
      const whole = { from: pos.from, to: pos.to };
      const k = r === -1 ? -1 : rowOrigin[r];
      if (Number.isNaN(r) || k === null || k === undefined) return whole;
      const span = rowSpan(view.state.sliceDoc(pos.from, pos.to), k);
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
    const controls = document.createElement('div');
    controls.className = 'sheaf-table-controls';
    const gridHost = document.createElement('div');
    gridHost.className = 'sheaf-table-grid';
    gridHost.tabIndex = 0;
    // The ARIA grid pattern: the focused container is the grid, and
    // aria-activedescendant names the active cell as the arrows move it.
    const gridId = `sheaf-grid-${++gridSeq}`;
    gridHost.setAttribute('role', 'grid');
    gridHost.setAttribute('aria-multiselectable', 'true');
    const cellId = (r: number, c: number): string => `${gridId}-r${r + 1}-c${c}`;
    // A changed-row tint is spent once its fade ends, so a re-attached row cannot replay it.
    gridHost.addEventListener('animationend', (e) => (e.target as Element).closest?.('tr')?.classList.remove('is-changed'));

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
    const cellEl = (r: number, c: number): HTMLElement | null =>
      gridHost.querySelector(`[data-r="${r}"][data-c="${c}"]`);

    // ---- selection state ----
    let anchor: Cell = { r: -1, c: 0 };
    let focus: Cell = { r: -1, c: 0 };
    let hasSel = false;
    let activeInput: HTMLInputElement | HTMLTextAreaElement | null = null;
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
    // A row being dragged by its row number: where it started and the row it would land on.
    let rowDrag: { from: number; over: number | null; startY: number } | null = null;
    // A column being dragged by its header.
    let colDrag: { from: number; over: number | null; startX: number } | null = null;
    let committed = false; // one-shot: serialize to the doc at most once
    // Rows an outside edit just changed, marked on this DOM's first render only.
    let firstRender = true;
    let justChanged = new Set(view.state.field(changedRows, false) ?? []);

    // A right-click inside the current selection keeps it, so the menu acts on it.
    const keepForMenu = (e: MouseEvent, r: number, c: number): boolean => {
      if (e.button !== 2 || !hasSel) return false;
      const { r1, r2, c1, c2 } = selRect();
      return r >= r1 && r <= r2 && c >= c1 && c <= c2;
    };
    const selRect = (): { r1: number; r2: number; c1: number; c2: number } => ({
      r1: Math.min(anchor.r, focus.r),
      r2: Math.max(anchor.r, focus.r),
      c1: Math.min(anchor.c, focus.c),
      c2: Math.max(anchor.c, focus.c),
    });

    const paint = (): void => {
      gridHost
        .querySelectorAll('.is-sel, .is-focus')
        .forEach((el) => el.classList.remove('is-sel', 'is-focus'));
      gridHost.querySelectorAll('[aria-selected="true"]').forEach((el) => el.setAttribute('aria-selected', 'false'));
      // Without a selection there is no active cell ring, so the grid outlines itself while focused.
      gridHost.classList.toggle('has-selection', hasSel);
      if (!hasSel) {
        gridHost.removeAttribute('aria-activedescendant');
        return;
      }
      const { r1, r2, c1, c2 } = selRect();
      for (let r = r1; r <= r2; r++)
        for (let c = c1; c <= c2; c++) {
          const el = cellEl(r, c);
          el?.classList.add('is-sel');
          el?.setAttribute('aria-selected', 'true');
        }
      const focused = cellEl(focus.r, focus.c);
      focused?.classList.add('is-focus');
      if (focused) gridHost.setAttribute('aria-activedescendant', focused.id);
      // Keep the active cell on screen as the arrows or Tab carry it past an edge.
      focused?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      // The row numbers sit left of the first column, so reaching it scrolls all the way left.
      if (focused && focus.c === 0) gridHost.scrollLeft = 0;
    };

    const select = (r: number, c: number, extend = false): void => {
      commitCell();
      focus = { r, c };
      if (!extend) anchor = { r, c };
      hasSel = true;
      paint();
      gridHost.focus();
    };
    const selectRange = (a: Cell, f: Cell): void => {
      commitCell();
      anchor = a;
      focus = f;
      hasSel = true;
      paint();
      gridHost.focus();
    };
    const clearSel = (): void => {
      commitCell();
      hasSel = false;
      paint();
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
      if (wrap.isConnected) return void gridHost.focus();
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
        const span = kind === 'pipe' && k !== null && k !== undefined ? rowSpan(src, k) : null;
        const seg = span && o !== null ? splitRawRow(src.slice(span.from, span.to)).cells[o] ?? null : null;
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
      if (!activeInput) return;
      // A cell opened and left as it was keeps the model's value exactly, even
      // where the editor normalized it on the way in (a textarea turns \r\n into \n).
      if (activeInput.value !== openedWith) {
        if (activeInput.value !== getCell(focus.r, focus.c)) record();
        setCell(focus.r, focus.c, activeInput.value);
      }
      // Typed text is already written, so this writes only a value set without a keystroke.
      flush();
      activeInput = null;
      endTyping();
      const el = cellEl(focus.r, focus.c);
      if (el) el.innerHTML = renderInline(getCell(focus.r, focus.c));
    };

    // Escape backs out of an edit: the cell and the document go back to what they
    // held before the typing. When the typing is still the latest thing in the undo
    // history, it is undone, so no undo step is left behind; otherwise, as after an
    // outside change to the table, the earlier value is written back over it.
    const cancelCell = (): void => {
      if (!activeInput) return;
      const session = typing;
      if (session) {
        const r = focus.r;
        const c = focus.c;
        const steps = undoDepth(view.state) - session.depth;
        const clean =
          !session.outside && steps > 0 && view.state.sliceDoc(pos.from, pos.to) === session.text;
        const input = activeInput;
        activeInput = null;
        if (clean) {
          for (let i = 0; i < steps; i++) undoDocument(view);
          // Undoing takes out the line typing gave a row appended past the end, and
          // the grid rebuilt from the file loses the row; it is still there, empty.
          if (session.auto && r >= rowCount()) {
            while (rowCount() <= r) addRowAt(lastRow(), true);
            anchor = { r, c };
            focus = { r, c };
          }
        }
        if (getCell(r, c) !== session.value) {
          // Not undone: write the earlier value back, into the segment as it was.
          activeInput = input;
          record();
          setCell(r, c, session.value);
          flush();
          activeInput = null;
        }
        const row = r >= 0 ? data.rows[r] : undefined;
        if (row && session.auto && row.every((v) => v === '')) autoRows.add(row);
      }
      activeInput = null;
      typing = null;
      composing = false;
      const el = cellEl(focus.r, focus.c);
      if (el) el.innerHTML = renderInline(getCell(focus.r, focus.c));
    };

    const edit = (initial?: string): void => {
      const el = cellEl(focus.r, focus.c);
      if (!el) return;
      const value = initial ?? getCell(focus.r, focus.c);
      // A CSV field can hold a line break, and a text input silently drops it:
      // opening the cell and pressing Enter would weld the lines together.
      const multiline = kind === 'csv' && value.includes('\n');
      const input = document.createElement(multiline ? 'textarea' : 'input') as HTMLInputElement | HTMLTextAreaElement;
      if (multiline) (input as HTMLTextAreaElement).rows = value.split('\n').length;
      else (input as HTMLInputElement).type = 'text';
      input.className = 'sheaf-table-input' + (multiline ? ' is-multiline' : '');
      const column = data.headers[focus.c]?.trim() || `Column ${focus.c + 1}`;
      input.setAttribute('aria-label', focus.r === -1 ? `Header of ${column}` : `${column}, row ${focus.r + 1}`);
      input.value = value;
      openedWith = initial === undefined ? input.value : null;
      el.textContent = '';
      el.appendChild(input);
      input.focus();
      if (initial === undefined) input.select();
      activeInput = input;
      composing = false;
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => onInputKey(e as KeyboardEvent));
      input.addEventListener('compositionstart', () => {
        if (activeInput === input) composing = true;
      });
      input.addEventListener('compositionend', () => {
        if (activeInput !== input) return;
        composing = false;
        writeTyped();
      });
      input.addEventListener('input', (e) => {
        if (activeInput !== input || (e as InputEvent).isComposing) return;
        writeTyped();
      });
    };

    function onInputKey(e: KeyboardEvent): void {
      // Undo and redo in a cell editor are the text field's own; kept from the
      // window, they do not also run VS Code's undo on the file.
      const key = e.key.toLowerCase();
      if ((key === 'z' && (e.metaKey || e.ctrlKey)) || (key === 'y' && e.ctrlKey && !e.metaKey)) e.stopPropagation();
      // Enter or Tab while an input method is composing belongs to the IME.
      if (e.isComposing || e.keyCode === 229) return;
      const input = activeInput;
      if ((e.key === 'Home' || e.key === 'End') && !e.metaKey && !e.ctrlKey && !e.altKey && input instanceof HTMLInputElement) {
        // Chromium on macOS leaves the caret where it is for Home and End in a text
        // field inside the editor's content, so place it here; Shift extends.
        e.preventDefault();
        const to = e.key === 'Home' ? 0 : input.value.length;
        const from = e.shiftKey ? (input.selectionDirection === 'backward' ? input.selectionEnd : input.selectionStart) ?? to : to;
        input.setSelectionRange(Math.min(from, to), Math.max(from, to), to < from ? 'backward' : 'forward');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        commitCell();
        tabMove(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Enter') {
        // Alt+Enter adds a line break inside a multi-line cell, as in a spreadsheet.
        if (e.altKey && activeInput instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        e.stopPropagation();
        commitCell();
        enterMove(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelCell();
        select(focus.r, focus.c);
      }
    }

    // ---- navigation ----
    const clampCol = (c: number): number => Math.max(0, Math.min(colCount() - 1, c));
    const clampRow = (r: number): number => Math.max(-1, Math.min(lastRow(), r));

    const arrow = (dr: number, dc: number, extend: boolean): void => {
      select(clampRow(focus.r + dr), clampCol(focus.c + dc), extend);
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
      const shift = (dr: number, dc: number): void =>
        selectRange({ r: a.r + dr, c: a.c + dc }, { r: f.r + dr, c: f.c + dc });
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
      const order = data.rows.map((row, i) => ({ row, origin: rowOrigin[i] }));
      // Read once, from the whole column, so every cell in it is compared the same way.
      const dateOrder = columnDateOrder(data.rows.map((row) => row[c] ?? ''));
      order.sort((a, b) => {
        const x = (a.row[c] ?? '').trim();
        const y = (b.row[c] ?? '').trim();
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
      const parsed = parsePipeTable(text);
      if (!parsed) return;
      // An indented table, such as one inside a list item, keeps its indentation on
      // every line, or padding would move it out of the block it belongs to.
      const line = view.state.doc.lineAt(found.from);
      const indent = /^[ \t]*/.exec(line.text)![0];
      const firstIndent = indent.slice(Math.min(indent.length, found.from - line.from));
      // The header says how many columns the table has, so a row carrying more cells
      // than the header lines up without widening the table.
      const tidy = formatPipeTable([parsed.headers, ...parsed.rows], parsed.aligns, parsed.headers.length)
        .split('\n')
        .map((l, i) => (i === 0 ? firstIndent : indent) + l)
        .join('\n');
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
    const clearSelected = (): void => {
      const { r1, r2, c1, c2 } = selRect();
      let any = false;
      for (let r = r1; r <= r2 && !any; r++) for (let c = c1; c <= c2; c++) if (getCell(r, c) !== '') any = true;
      if (any) record();
      for (let r = r1; r <= r2; r++)
        for (let c = c1; c <= c2; c++) {
          setCell(r, c, '');
          const el = cellEl(r, c);
          if (el) el.textContent = '';
        }
      flush();
    };

    // ---- clipboard ----
    const rectToGrid = (): string[][] => {
      const { r1, r2, c1, c2 } = selRect();
      const out: string[][] = [];
      for (let r = r1; r <= r2; r++) {
        const line: string[] = [];
        // A spreadsheet wants the value, not the pipe table's escape for it; a
        // paste back into a pipe table escapes the pipe again.
        for (let c = c1; c <= c2; c++) line.push(kind === 'pipe' ? getCell(r, c).replace(/\\\|/g, '|') : getCell(r, c));
        out.push(line);
      }
      return out;
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
      anchor = { r: r0, c: c0 };
      focus = { r: r0 + g.length - 1, c: wide - 1 };
      hasSel = true;
      paint();
      gridHost.focus();
    };
    const addColSilent = (): void => {
      data.headers.push('');
      colOrigin.push(null);
      data.aligns.push(null);
      for (const row of data.rows) row.push('');
    };

    const clip: GridClipboardApi = {
      contains: (n) => wrap.contains(n),
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
        const g = parseClipboardGrid(text);
        const { r1, r2, c1, c2 } = selRect();
        if (hasSel && g.length === 1 && g[0].length === 1 && (r1 !== r2 || c1 !== c2)) {
          // One value over a selection fills every selected cell, as a spreadsheet does.
          record();
          for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) setCell(r, c, g[0][0]);
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
      const k = e.key;
      // The first key of an input method (Japanese, Chinese, Korean) arrives as
      // Process, as keyCode 229, or already composing. Open the selected cell with
      // an empty editor and leave the key alone, so the composition goes on in it.
      if (e.isComposing || e.keyCode === 229 || k === 'Process') {
        if (hasSel) edit('');
        return;
      }
      const jump = e.metaKey || e.ctrlKey;
      if (e.altKey && !jump && !e.shiftKey && k.startsWith('Arrow')) {
        // Alt+arrow moves the selected rows or columns as a block, as Alt+Up and
        // Alt+Down move lines in the text editor. The header row does not move, and never leaves.
        const dirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const;
        if (k in dirs) moveBlock(dirs[k as keyof typeof dirs], anchor, focus);
      } else if (k === 'ArrowUp' && !e.shiftKey && !jump && focus.r === -1 && leave(false)) {
        // left the table upward
      } else if (k === 'ArrowDown' && !e.shiftKey && !jump && focus.r === lastRow() && leave(true)) {
        // left the table downward
      } else if (jump && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(k)) {
        // Jump to the table's edge in that direction; Cmd+Home and Cmd+End go to its corners.
        const r = k === 'ArrowUp' || k === 'Home' ? -1 : k === 'ArrowDown' || k === 'End' ? lastRow() : focus.r;
        const c = k === 'ArrowLeft' || k === 'Home' ? 0 : k === 'ArrowRight' || k === 'End' ? colCount() - 1 : focus.c;
        select(r, c, e.shiftKey);
      } else if (k === 'Home' || k === 'End') {
        select(focus.r, k === 'Home' ? 0 : colCount() - 1, e.shiftKey);
      } else if (k === 'PageDown' || k === 'PageUp') {
        const page = Math.max(1, Math.floor((view.scrollDOM.clientHeight || window.innerHeight) / 34) - 1);
        select(clampRow(focus.r + (k === 'PageDown' ? page : -page)), focus.c, e.shiftKey);
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
        selectRange({ r: lastRow(), c: colCount() - 1 }, { r: -1, c: 0 });
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
    const dataCell = (tag: 'th' | 'td', r: number, c: number): HTMLElement => {
      const el = document.createElement(tag);
      el.dataset.r = String(r);
      el.dataset.c = String(c);
      el.id = cellId(r, c);
      el.setAttribute('role', r === -1 ? 'columnheader' : 'gridcell');
      el.setAttribute('aria-selected', 'false');
      el.innerHTML = renderInline(getCell(r, c));
      const a = data.aligns[c];
      if (a) el.style.textAlign = a;
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Cmd/Ctrl-click on a link opens it, as in prose, instead of selecting.
        const link = activeInput ? null : linkClicked(e);
        if (link) return openLink(link.dataset.href ?? '');
        if (keepForMenu(e, r, c)) return;
        select(r, c, e.shiftKey);
        dragging = true;
      });
      el.addEventListener('dblclick', (e) => {
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

    // The grid's accessible name and size, from the current headers and rows.
    function labelGrid(): void {
      gridHost.setAttribute('aria-rowcount', String(rowCount() + 1));
      gridHost.setAttribute('aria-colcount', String(colCount()));
      const names = data.headers.map((h) => h.trim()).filter(Boolean);
      gridHost.setAttribute('aria-label', names.length ? `Table: ${names.slice(0, 6).join(', ')}` : 'Table');
    }

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
        const th = dataCell('th', -1, c);
        // Header single-click selects the column (double-click still edits).
        th.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (linkClicked(e) || keepForMenu(e, -1, c)) return;
          if (e.button === 0 && !e.shiftKey) colDrag = { from: c, over: null, startX: e.clientX };
          // The header cell holds focus, so typing edits the header rather than
          // the bottom cell of the column, as in a spreadsheet.
          if (!e.shiftKey) selectRange({ r: lastRow(), c }, { r: -1, c });
          else selectRange(anchor, { r: focus.r, c });
        });
        htr.appendChild(th);
      }
      thead.appendChild(htr);
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
          if (e.button === 0 && !e.shiftKey) rowDrag = { from: r, over: null, startY: e.clientY };
          // Shift extends a row selection from the row it started on.
          selectRange({ r: e.shiftKey && hasSel ? anchor.r : r, c: colCount() - 1 }, { r, c: 0 });
        });
        tr.appendChild(gut);
        for (let c = 0; c < colCount(); c++) tr.appendChild(dataCell('td', r, c));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      gridHost.replaceChildren(table);
      labelLines();
      firstRender = false;
      paint();
    };

    // Mark the dragged row and the row it would land on; the drop goes after that row
    // when moving down and before it when moving up.
    const paintDrop = (): void => {
      gridHost.querySelectorAll('.is-row-dragging, .is-drop-before, .is-drop-after').forEach((el) =>
        el.classList.remove('is-row-dragging', 'is-drop-before', 'is-drop-after')
      );
      if (!rowDrag || rowDrag.over === null) return;
      const rows = gridHost.querySelectorAll('tbody tr');
      rows[rowDrag.from]?.classList.add('is-row-dragging');
      if (rowDrag.over !== rowDrag.from) rows[rowDrag.over]?.classList.add(rowDrag.over > rowDrag.from ? 'is-drop-after' : 'is-drop-before');
    };
    const paintColDrop = (): void => {
      gridHost.querySelectorAll('.is-col-dragging, .is-col-drop-before, .is-col-drop-after').forEach((el) =>
        el.classList.remove('is-col-dragging', 'is-col-drop-before', 'is-col-drop-after')
      );
      if (!colDrag || colDrag.over === null) return;
      const { from, over } = colDrag;
      gridHost.querySelectorAll(`[data-c="${from}"]`).forEach((el) => el.classList.add('is-col-dragging'));
      if (over !== from) {
        const side = over > from ? 'is-col-drop-after' : 'is-col-drop-before';
        gridHost.querySelectorAll(`[data-c="${over}"]`).forEach((el) => el.classList.add(side));
      }
    };
    function moveColTo(from: number, to: number): void {
      commitCell();
      if (from === to || from < 0 || to < 0 || from >= colCount() || to >= colCount()) return;
      record();
      const move = <T>(list: T[]): void => {
        const [item] = list.splice(from, 1);
        list.splice(to, 0, item);
      };
      move(data.headers);
      move(data.aligns);
      move(colOrigin);
      for (const row of data.rows) {
        while (row.length < colCount()) row.push('');
        move(row);
      }
      render();
      selectRange({ r: lastRow(), c: to }, { r: -1, c: to });
    }
    function moveRowTo(from: number, to: number): void {
      commitCell();
      if (from === to || from < 0 || to < 0 || from >= rowCount() || to >= rowCount()) return;
      record();
      const [row] = data.rows.splice(from, 1);
      const [origin] = rowOrigin.splice(from, 1);
      data.rows.splice(to, 0, row);
      rowOrigin.splice(to, 0, origin);
      render();
      selectRange({ r: to, c: colCount() - 1 }, { r: to, c: 0 });
    }

    // Drag to extend a selection across cells, or to move a row grabbed by its number.
    gridHost.addEventListener('mousemove', (e) => {
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
      if (!dragging) return;
      const el = (e.target as HTMLElement).closest('[data-r]') as HTMLElement | null;
      if (!el) return;
      const r = Number(el.dataset.r);
      const c = Number(el.dataset.c);
      if (r !== focus.r || c !== focus.c) {
        focus = { r, c };
        hasSel = true;
        paint();
      }
    });
    document.addEventListener('mouseup', () => {
      dragging = false;
      if (colDrag) {
        const { from, over } = colDrag;
        colDrag = null;
        paintColDrop();
        if (over !== null && over !== from) moveColTo(from, over);
      }
      if (!rowDrag) return;
      const { from, over } = rowDrag;
      rowDrag = null;
      paintDrop();
      if (over !== null && over !== from) moveRowTo(from, over);
    });

    // ---- controls bar ----
    const ctrl = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sheaf-table-ctrl';
      b.textContent = label;
      b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', onClick);
      return b;
    };
    if (kind === 'csv') {
      const badge = document.createElement('span');
      badge.className = 'sheaf-table-badge';
      badge.textContent = lang.toUpperCase();
      controls.appendChild(badge);
    }
    // The controls act on the selected block, as the right-click menu does, falling
    // back to the active cell's row or column when the selection spans a whole axis.
    const span = (vertical: boolean) => moveSpan(vertical, anchor, focus, focus)!;
    controls.appendChild(
      ctrl('+ Row', 'Add row below selection', () => {
        const { hi } = span(true);
        addRowAt(hi);
        select(hi + 1, focus.c);
      })
    );
    controls.appendChild(
      ctrl('+ Col', 'Add column right of selection', () => {
        const { hi } = span(false);
        addColAt(hi);
        select(focus.r, hi + 1);
      })
    );
    controls.appendChild(
      ctrl('− Row', 'Delete selected rows', () => {
        const { lo, hi } = span(true);
        if (hi >= 0) delRowAt(Math.max(lo, 0), hi);
      })
    );
    controls.appendChild(
      ctrl('− Col', 'Delete selected columns', () => {
        const { lo, hi } = span(false);
        delColAt(lo, hi);
      })
    );
    controls.appendChild(
      ctrl('</>', 'Edit raw source', () => {
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
      })
    );

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
      if (active?.closest?.('.sheaf-ctx-menu')) return startWaiting();
      stopWaiting();
      commitCell();
      // The keyboard is elsewhere now, so the table stops showing a selection and an active cell.
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
      if (committed || next.kind !== kind) return false;
      pos.from = next.from;
      pos.to = next.to;
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
        return true;
      }
      anchor = { r: clampRow(anchor.r), c: clampCol(anchor.c) };
      focus = { r: clampRow(focus.r), c: clampCol(focus.c) };
      // An undo or redo of a grid write puts the active cell on the cell it changed.
      const step = view.state.field(stepCell, false);
      if (step && step.at >= next.from && step.at <= next.to) {
        focus = { r: clampRow(step.cell.r), c: clampCol(step.cell.c) };
        anchor = { ...focus };
        if (wrap.contains(document.activeElement)) hasSel = true;
      }
      const editing = activeInput ? { value: activeInput.value, opened: openedWith } : null;
      const hadFocus = wrap.contains(document.activeElement);
      activeInput = null;
      firstRender = true;
      justChanged = new Set(view.state.field(changedRows, false) ?? []);
      render();
      if (editing) {
        edit(editing.value);
        openedWith = editing.opened;
      } else if (hadFocus) gridHost.focus();
      return true;
    };
    liveGrids.set(wrap, adopt);

    render();
    wrap.append(controls, gridHost);
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
    lang: string
  ): void => {
    const sig = JSON.stringify({ data, lang });
    decos.push(
      Decoration.replace({
        widget: new TableWidget(kind, from, to, data, sig, lang),
        block: true,
      }).range(from, to)
    );
  };

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        const from = doc.lineAt(node.from).from;
        const to = doc.lineAt(Math.max(node.from, node.to - 1)).to;
        if (isActive(from, to)) return;
        const data = parsePipeTable(doc.sliceString(from, to));
        if (data && data.headers.length) push(from, to, 'pipe', data, '');
      } else if (node.name === 'FencedCode') {
        const raw = doc.sliceString(node.from, node.to);
        const info = fenceInfo(raw);
        if (info !== 'csv' && info !== 'tsv') return;
        const from = doc.lineAt(node.from).from;
        const to = doc.lineAt(Math.max(node.from, node.to - 1)).to;
        if (isActive(from, to)) return;
        const grid = parseDelimited(fenceBody(raw), info === 'tsv' ? '\t' : ',');
        if (grid.length) {
          const [headers, ...rows] = grid;
          push(from, to, 'csv', { headers, aligns: headers.map(() => null), rows }, info);
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
    const rows = text
      .replace(/\r\n?/g, '\n')
      .replace(/\n+$/, '')
      .split('\n')
      .map((line) => line.split('\t'));
    if (rows.length < 2 || rows.some((row) => row.length < 2)) return false;
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
export const tables: Extension = [
  tableField,
  pasteRangeAsTable,
  changedRows,
  stepCell,
  invertedEffects.of((tr) => tr.effects.filter((e) => e.is(tableStep))),
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
 * be parsed as another row.
 */
function insertBlock(view: EditorView, block: string, caretOffset: number): void {
  const { state } = view;
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
  const tail = next && next.text.trim() !== '' ? '\n' : '';
  const insert = lead + block + tail;
  const tableFrom = at + lead.length;
  const tableEnd = tableFrom + block.length;
  const newLength = state.doc.length - (blank ? line.length : 0) + insert.length;
  view.dispatch({
    changes: { from: at, to: blank ? line.to : at, insert },
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
