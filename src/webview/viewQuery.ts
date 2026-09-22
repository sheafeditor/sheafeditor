/*
 * The query behind a view block: a fenced code block with the language `view`
 * whose body says which table to show and how.
 *
 *     from: tasks.csv
 *     where: status != Done; owner = Sam
 *     sort: estimate desc
 *     show: feature, status, estimate
 *     layout: table
 *
 * This module reads that body, applies it to a table's header and rows, and
 * rewrites single lines of it when the view's header changes a setting. It holds
 * no DOM and no CodeMirror, so everything here is a pure function of its inputs.
 *
 * Cells are compared the way the grid's own Sort compares them (see
 * `cellNumbers.ts`), so a view never orders a column differently from sorting the
 * table itself.
 */

import { columnDateOrder, dateValue, leadingNumber, wholeNumber, DateOrder } from './cellNumbers';

export type Operator = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'is empty' | 'is not empty';

/** One `where` condition. `line` is the body line it was written on, for errors. */
export interface Condition {
  column: string;
  op: Operator;
  /** The value to compare with, unquoted. Empty for `is empty` and `is not empty`. */
  value: string;
  line: number;
}

/** One `sort` key. `line` is the body line it was written on, for errors. */
export interface SortKey {
  column: string;
  descending: boolean;
  line: number;
}

/**
 * Something the reader should see on the block. `line` is 0-based within the body,
 * or null when the problem belongs to the block as a whole (a missing `from`).
 * `key` is the key of the line at fault, or null for a line that has none.
 */
export interface ViewError {
  line: number | null;
  key: string | null;
  message: string;
}

export interface ViewQuery {
  from: string | null;
  where: Condition[];
  sort: SortKey[];
  /** Column names in display order, or null for every column in file order. */
  show: string[] | null;
  layout: 'table' | 'board';
  group: string | null;
  /** The body line each key was read from, for errors found once a table is known. */
  lines: Partial<Record<ViewKey, number>>;
  errors: ViewError[];
}

export type ViewKey = 'from' | 'where' | 'sort' | 'show' | 'layout' | 'group';
const KEYS: readonly ViewKey[] = ['from', 'where', 'sort', 'show', 'layout', 'group'];

export interface ViewResult {
  /** Source column indices, in display order. */
  columns: number[];
  /** Source row indices, in display order: filtered, then stably sorted. */
  rows: number[];
  /** The source column a board groups by, or null. */
  group: number | null;
  /** Names the view uses that the table does not have. The body's own errors stay on the query. */
  errors: ViewError[];
}

export interface CellReading {
  /**
   * The text a cell is compared by. The grid sorts on what a cell shows rather
   * than its Markdown, so a caller with a renderer passes one here to match it.
   * The default is the cell trimmed.
   */
  display?: (cell: string) => string;
}

const trimmed = (cell: string): string => cell.trim();

/** One collator for every text comparison, the same one the grid's Sort uses. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A list written the way a person would say it: "a, b and c". */
function spoken(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const OPERATOR_LIST = '=, !=, <, <=, >, >=, contains, is empty and is not empty';

/** Splits `text` on `sep` wherever it is outside double quotes. */
function splitOutsideQuotes(text: string, sep: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === sep && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A value as written, with one pair of surrounding double quotes removed and `""` read as `"`. */
function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/""/g, '"');
  return v;
}

/** A value written so that `unquote` reads it back unchanged. */
function quote(value: string): string {
  return /[;"]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Reads one condition, or says why it cannot. */
function parseCondition(text: string, line: number): Condition | string {
  const part = text.trim();
  const emptiness = /^(.+?)\s+is\s+(not\s+)?empty$/i.exec(part);
  if (emptiness) return { column: emptiness[1].trim(), op: emptiness[2] ? 'is not empty' : 'is empty', value: '', line };

  // The operator is whichever comes first, so a value may hold the other kind.
  const symbol = /[<>=!]/.exec(part);
  const word = /\s(contains)(\s|$)/i.exec(part);
  let column: string;
  let op: Operator;
  let rest: string;
  if (symbol && (!word || symbol.index < word.index)) {
    const m = /^(<=|>=|!=|=|<|>)/.exec(part.slice(symbol.index));
    if (!m) return unreadable(part);
    column = part.slice(0, symbol.index).trim();
    op = m[1] as Operator;
    rest = part.slice(symbol.index + m[1].length);
  } else if (word) {
    column = part.slice(0, word.index).trim();
    op = 'contains';
    rest = part.slice(word.index + 1 + word[1].length);
  } else {
    return unreadable(part);
  }
  if (!column) return unreadable(part);
  if (!rest.trim()) {
    return `The condition "${part}" needs a value after "${op}". To find blank cells, write "${column} is empty".`;
  }
  return { column, op, value: unquote(rest), line };
}

function unreadable(part: string): string {
  return `Can't read the condition "${part}". Write a column, an operator and a value, like "status != Done". The operators are ${OPERATOR_LIST}.`;
}

/**
 * Reads a view block's body. Never throws: anything it cannot use becomes an
 * error on the query, and everything else is still read.
 */
export function parseView(body: string): ViewQuery {
  const q: ViewQuery = { from: null, where: [], sort: [], show: null, layout: 'table', group: null, lines: {}, errors: [] };
  const lines = body.split(/\r\n|\n|\r/);
  lines.forEach((text, line) => {
    if (!text.trim()) return;
    const colon = text.indexOf(':');
    if (colon < 0) {
      q.errors.push({ line, key: null, message: 'This line has no key. Write each line as a key, a colon and a value, like "sort: estimate desc".' });
      return;
    }
    const name = text.slice(0, colon).trim();
    const key = name.toLowerCase() as ViewKey;
    const value = text.slice(colon + 1).trim();
    if (!KEYS.includes(key)) {
      q.errors.push({ line, key: name, message: `Unknown key "${name}". A view understands ${spoken(KEYS)}.` });
      return;
    }
    if (q.lines[key] !== undefined) {
      q.errors.push({ line, key, message: `"${key}" is already set above. A view uses the first one, so this line is ignored.` });
      return;
    }
    q.lines[key] = line;
    switch (key) {
      case 'from':
        q.from = value || null;
        break;
      case 'where':
        for (const part of splitOutsideQuotes(value, ';')) {
          if (!part.trim()) continue;
          const c = parseCondition(part, line);
          if (typeof c === 'string') q.errors.push({ line, key, message: c });
          else q.where.push(c);
        }
        break;
      case 'sort':
        for (const part of value.split(',')) {
          const m = /^(.*?)(?:\s+(asc|desc))?$/i.exec(part.trim());
          if (!m || !m[1].trim()) continue;
          q.sort.push({ column: m[1].trim(), descending: (m[2] ?? '').toLowerCase() === 'desc', line });
        }
        break;
      case 'show': {
        const names = value.split(',').map((s) => s.trim()).filter(Boolean);
        q.show = names.length ? names : null;
        break;
      }
      case 'layout': {
        const layout = value.toLowerCase();
        if (layout === 'table' || layout === 'board') q.layout = layout;
        else q.errors.push({ line, key, message: `Unknown layout "${value}". A view's layout is table or board.` });
        break;
      }
      case 'group':
        q.group = value || null;
        break;
    }
  });
  if (!q.from) {
    q.errors.push({ line: null, key: 'from', message: 'A view needs a "from" line that names its table, like "from: tasks.csv" or "from: #tasks".' });
  }
  if (q.layout === 'board' && !q.group) {
    q.errors.push({ line: q.lines.layout ?? null, key: 'layout', message: 'A board needs a column to group its cards by. Add a line like "group: status".' });
  }
  return q;
}

/** The column a name refers to: header cells trimmed and matched case-insensitively. -1 when none. */
function columnIndex(header: readonly string[], name: string): number {
  const want = name.trim().toLowerCase();
  return header.findIndex((h) => h.trim().toLowerCase() === want);
}

function missingColumn(header: readonly string[], name: string, line: number | null, key: ViewKey): ViewError {
  const names = header.map((h) => h.trim()).filter(Boolean);
  const list = names.length ? `The columns are ${spoken(names)}.` : 'This table has no named columns.';
  return { line, key, message: `No column is named "${name}". ${list}` };
}

/**
 * Orders two non-empty cells the way the grid's Sort does: as dates when the
 * column's slashed dates can be read, then as numbers when both start with one,
 * then as text ignoring case, with digits inside the text compared as numbers.
 * Two cells that are each a number and nothing else compare by value alone, so
 * `10` equals `10.0` in a filter.
 */
function compareCells(x: string, y: string, dates: DateOrder | null): number {
  if (x === y) return 0;
  if (dates) {
    const [dx, dy] = [dateValue(x, dates), dateValue(y, dates)];
    if (dx !== null && dy !== null && dx !== dy) return Math.sign(dx - dy);
  }
  const [nx, ny] = [leadingNumber(x), leadingNumber(y)];
  if (nx !== null && ny !== null) {
    if (nx !== ny) return Math.sign(nx - ny);
    if (wholeNumber(x) !== null && wholeNumber(y) !== null) return 0;
  }
  return collator.compare(x, y);
}

/** Whether one condition holds for a cell already read for display. */
function holds(c: Condition, cell: string, dates: DateOrder | null): boolean {
  switch (c.op) {
    case 'is empty':
      return cell === '';
    case 'is not empty':
      return cell !== '';
    case 'contains':
      return cell.toLocaleLowerCase().includes(c.value.toLocaleLowerCase());
    case '=':
      return compareCells(cell, c.value, dates) === 0;
    case '!=':
      return compareCells(cell, c.value, dates) !== 0;
  }
  // An ordering never matches a blank cell: "estimate < 5" is not a claim about
  // rows with no estimate. `is empty` finds those.
  if (cell === '') return false;
  const order = compareCells(cell, c.value, dates);
  switch (c.op) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
  }
}

/** The conditions whose columns exist, each with its column index. */
function resolvedConditions(q: ViewQuery, header: readonly string[]): { c: Condition; col: number }[] {
  return q.where.map((c) => ({ c, col: columnIndex(header, c.column) })).filter((r) => r.col >= 0);
}

/** How a column's slashed dates are read, from its cells and any values compared with them. */
function datesFor(rows: readonly (readonly string[])[], col: number, read: (cell: string) => string, extra: readonly string[] = []): DateOrder | null {
  return columnDateOrder([...rows.map((row) => read(row[col] ?? '')), ...extra]);
}

/**
 * Applies a parsed view to a table. Returns which source columns and rows to show,
 * in display order. A name the table does not have becomes an error and only that
 * condition or key is skipped. Never changes `header` or `rows`.
 */
export function applyView(
  q: ViewQuery,
  header: readonly string[],
  rows: readonly (readonly string[])[],
  reading: CellReading = {}
): ViewResult {
  const read = reading.display ?? trimmed;
  const errors: ViewError[] = [];
  const cell = (r: number, c: number): string => read(rows[r][c] ?? '');

  for (const c of q.where) if (columnIndex(header, c.column) < 0) errors.push(missingColumn(header, c.column, c.line, 'where'));
  const conditions = resolvedConditions(q, header).map(({ c, col }) => ({
    c,
    col,
    dates: datesFor(rows, col, read, c.value ? [c.value] : []),
  }));
  const shown = rows.map((_, r) => r).filter((r) => conditions.every(({ c, col, dates }) => holds(c, cell(r, col), dates)));

  const keys: { col: number; descending: boolean; dates: DateOrder | null }[] = [];
  for (const k of q.sort) {
    const col = columnIndex(header, k.column);
    if (col < 0) errors.push(missingColumn(header, k.column, k.line, 'sort'));
    else keys.push({ col, descending: k.descending, dates: datesFor(rows, col, read) });
  }
  if (keys.length) {
    // Array.prototype.sort is stable, so rows equal on every key keep their source order.
    shown.sort((a, b) => {
      for (const { col, descending, dates } of keys) {
        const [x, y] = [cell(a, col), cell(b, col)];
        if (x === y) continue;
        // Empty cells go last whichever way the column is sorted, as in the grid.
        if (!x) return 1;
        if (!y) return -1;
        const order = compareCells(x, y, dates);
        if (order) return descending ? -order : order;
      }
      return 0;
    });
  }

  let columns = header.map((_, c) => c);
  if (q.show) {
    const picked: number[] = [];
    for (const name of q.show) {
      const col = columnIndex(header, name);
      if (col < 0) errors.push(missingColumn(header, name, q.lines.show ?? null, 'show'));
      else if (!picked.includes(col)) picked.push(col);
    }
    // A show line naming nothing that exists shows every column rather than none.
    if (picked.length) columns = picked;
  }

  let group: number | null = null;
  if (q.group !== null) {
    const col = columnIndex(header, q.group);
    if (col < 0) errors.push(missingColumn(header, q.group, q.lines.group ?? null, 'group'));
    else group = col;
  }

  return { columns, rows: shown, group, errors };
}

/**
 * Whether one row meets every condition whose column exists. For a row just
 * edited in a filtered view, which stays visible and is marked when it no longer
 * matches. Pass the whole table as `table` when the column may hold slashed dates,
 * since only the column can say which way round they are written.
 */
export function rowMatches(
  q: ViewQuery,
  header: readonly string[],
  row: readonly string[],
  reading: CellReading & { table?: readonly (readonly string[])[] } = {}
): boolean {
  const read = reading.display ?? trimmed;
  const table = reading.table ?? [row];
  return resolvedConditions(q, header).every(({ c, col }) =>
    holds(c, read(row[col] ?? ''), datesFor(table, col, read, c.value ? [c.value] : []))
  );
}

/**
 * The cells of a row added in a filtered view: each `=` condition's value in its
 * column, so the new row belongs to the view it was added in, and empty elsewhere.
 * The first `=` on a column wins.
 */
export function prefillFor(q: ViewQuery, header: readonly string[]): string[] {
  const cells = header.map(() => '');
  const set = new Set<number>();
  for (const { c, col } of resolvedConditions(q, header)) {
    if (c.op !== '=' || set.has(col)) continue;
    cells[col] = c.value;
    set.add(col);
  }
  return cells;
}

/** A `where` value for the conditions given, quoting any value that needs it. */
export function formatWhere(conditions: readonly Pick<Condition, 'column' | 'op' | 'value'>[]): string {
  return conditions
    .map((c) => (c.op === 'is empty' || c.op === 'is not empty' ? `${c.column} ${c.op}` : `${c.column} ${c.op} ${quote(c.value)}`))
    .join('; ');
}

/** A `sort` value for the keys given. */
export function formatSort(keys: readonly Pick<SortKey, 'column' | 'descending'>[]): string {
  return keys.map((k) => (k.descending ? `${k.column} desc` : k.column)).join(', ');
}

/** A `show` value for the column names given. */
export function formatShow(columns: readonly string[] | null): string {
  return (columns ?? []).join(', ');
}

/** The key a body line sets, lowercased, or null when it has none. */
function lineKey(text: string): string | null {
  const colon = text.indexOf(':');
  return colon < 0 ? null : text.slice(0, colon).trim().toLowerCase();
}

/**
 * The body with one key set to `value`, or removed when `value` is null. Only
 * that key's line changes: every other line keeps its bytes and its line ending.
 * A key already present keeps its spelling and the spacing after its colon. A key
 * that is absent is added after the last non-blank line, in the body's own line
 * ending, and the body keeps whether it ended with a newline.
 */
export function setViewKey(body: string, key: string, value: string | null): string {
  const want = key.trim().toLowerCase();
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  // Each line with its own ending, so untouched lines are copied exactly.
  const lines = body.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
  const split = (l: string): [string, string] => {
    const m = /(\r\n|\n|\r)$/.exec(l);
    return m ? [l.slice(0, m.index), m[1]] : [l, ''];
  };
  const clean = value === null ? null : value.replace(/[\r\n]+/g, ' ').trim();
  const at = lines.findIndex((l) => lineKey(split(l)[0]) === want);

  if (clean === null) {
    if (at < 0) return body;
    const kept = lines.filter((l) => lineKey(split(l)[0]) !== want);
    // Removing a last line that had no ending leaves the new last line's ending
    // behind, so drop it to keep the body without a final newline.
    if (!split(lines[lines.length - 1])[1] && kept.length && lineKey(split(lines[lines.length - 1])[0]) === want) {
      kept[kept.length - 1] = split(kept[kept.length - 1])[0];
    }
    return kept.join('');
  }

  if (at >= 0) {
    const [text, ending] = split(lines[at]);
    const colon = text.indexOf(':');
    const space = /^\s*/.exec(text.slice(colon + 1))![0];
    lines[at] = `${text.slice(0, colon + 1)}${space || ' '}${clean}${ending}`;
    return lines.join('');
  }

  const fresh = `${want}: ${clean}`;
  let last = -1;
  lines.forEach((l, i) => {
    if (split(l)[0].trim()) last = i;
  });
  if (last < 0) return lines.length ? fresh + eol + lines.join('') : fresh;
  const [text, ending] = split(lines[last]);
  lines[last] = ending ? `${lines[last]}${fresh}${ending}` : `${text}${eol}${fresh}`;
  return lines.join('');
}

// ---- What a view's header controls write ------------------------------------
//
// A person typed the query, so a control rewrites the one part of one line it is
// about. Every other condition, sort key or column name on that line keeps the
// spelling and spacing it was written with, and every other line keeps its bytes
// (see `setViewKey`). The part the control writes is spelled by `formatWhere`,
// `formatSort` or `formatShow`, so it reads back as what was chosen.

/** The value a key's line holds as written, without the spacing around it, or null when no line sets the key. */
export function viewKeyValue(body: string, key: string): string | null {
  const want = key.trim().toLowerCase();
  for (const text of body.split(/\r\n|\n|\r/)) {
    if (lineKey(text) !== want) continue;
    return text.slice(text.indexOf(':') + 1).trim();
  }
  return null;
}

/** Whether two column names name the same column, compared the way a query matches a header. */
function sameColumn(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** `written` in the place of `old`, keeping the spaces that were around `old`. */
function inPlaceOf(old: string, written: string): string {
  const lead = /^\s*/.exec(old)![0];
  const trail = /\s*$/.exec(old)![0];
  return `${lead}${written}${trail}`;
}

/**
 * The parts of a line's value, split on `sep`, with the part at `at` replaced by
 * `written`, taken out when `written` is null, or added at the end when `at` is -1.
 * Null when nothing is left, so the caller removes the line.
 */
function spliceParts(parts: string[], at: number, written: string | null, sep: string): string | null {
  const out = [...parts];
  if (at >= 0) {
    if (written === null) out.splice(at, 1);
    else out[at] = inPlaceOf(out[at], written);
  } else if (written !== null) {
    // After the last part written, over a separator left dangling at the end.
    while (out.length && !out[out.length - 1].trim()) out.pop();
    out.push(out.length ? ` ${written}` : written);
  }
  return out.some((p) => p.trim()) ? out.join(sep).trim() : null;
}

/**
 * The body with `column`'s condition in `where` set to `next`, or taken out when
 * `next` is null. The first condition on that column is the one changed, keeping
 * the column's spelling; with none, the new condition goes after the others. Every
 * other condition stays as written, and a `where` left with no condition goes.
 */
export function setWhereCondition(
  body: string,
  column: string,
  next: Pick<Condition, 'op' | 'value'> | null
): string {
  const raw = viewKeyValue(body, 'where');
  const parts = raw === null ? [] : splitOutsideQuotes(raw, ';');
  let at = -1;
  let name = column.trim();
  parts.some((p, i) => {
    const c = parseCondition(p, 0);
    if (typeof c === 'string' || !sameColumn(c.column, column)) return false;
    at = i;
    name = c.column;
    return true;
  });
  if (at < 0 && next === null) return body;
  const written = next === null ? null : formatWhere([{ column: name, op: next.op, value: next.value }]);
  return setViewKey(body, 'where', spliceParts(parts, at, written, ';'));
}

/** The column a sort key names, as written. */
function sortKeyColumn(part: string): string {
  return /^(.*?)(?:\s+(?:asc|desc))?$/i.exec(part.trim())![1].trim();
}

/**
 * The body with `column` sorted `next` ('asc', 'desc', or null for not at all).
 * Alone, it becomes the only sort key, which is what a click on a header means.
 * With `add`, which is a Shift-click, it changes that one key where it stands, or
 * joins the end as the next key, and every other key stays as written.
 */
export function setSortKey(body: string, column: string, next: 'asc' | 'desc' | null, add: boolean): string {
  const raw = viewKeyValue(body, 'sort');
  const parts = raw === null ? [] : raw.split(',');
  const at = parts.findIndex((p) => sameColumn(sortKeyColumn(p), column));
  const name = at >= 0 ? sortKeyColumn(parts[at]) : column.trim();
  const written = next === null ? null : formatSort([{ column: name, descending: next === 'desc' }]);
  if (!add) return setViewKey(body, 'sort', written);
  if (at < 0 && written === null) return body;
  return setViewKey(body, 'sort', spliceParts(parts, at, written, ','));
}

/**
 * The body with one column hidden: taken off `show` where the line names it, and
 * every other name left as written. With no `show` line, or one that does not name
 * the column, `show` becomes the columns now shown without it. `shown` is those
 * columns' names, in display order.
 */
export function hideViewColumn(body: string, column: string, shown: readonly string[]): string {
  const rest = shown.filter((name) => !sameColumn(name, column));
  if (!rest.length) return body;
  const raw = viewKeyValue(body, 'show');
  const parts = raw === null ? [] : raw.split(',');
  if (parts.some((p) => sameColumn(p, column))) {
    const kept = parts.filter((p) => !sameColumn(p, column));
    // The first name keeps no space before it once the one ahead of it is gone.
    return setViewKey(body, 'show', kept.join(',').trim() || null);
  }
  return setViewKey(body, 'show', formatShow(rest));
}
