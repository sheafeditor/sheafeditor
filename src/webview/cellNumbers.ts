/*
 * How a table cell is read as a number or a date. The grid's column sort and a
 * view block's filter and sort both read cells this way, so a view orders and
 * compares values exactly as sorting the table itself would.
 *
 * Pure functions: no DOM, no CodeMirror.
 */

/**
 * How a number is read out of a cell: sign, currency symbol, thousands separators,
 * decimals. Either part of the decimal may be missing, so `.5` reads as a half,
 * but a match with neither is not a number at all.
 */
const NUMBER_AT_START = /^([-+−]?)[$€£¥]?(\d{1,3}(?:,\d{3})+|\d*)(\.\d+)?/;

/**
 * A cell's leading number, allowing a sign, a currency symbol, thousands separators
 * and a decimal part, so -12 sorts below -5 and $1,200 above $30. Null when the cell
 * starts with text.
 */
export function leadingNumber(cell: string): number | null {
  const m = NUMBER_AT_START.exec(cell);
  // The pattern matches an empty string, which a sign or a currency symbol on its
  // own leaves behind. A number needs digits on one side of the point or the other.
  if (!m || (!m[2] && !m[3])) return null;
  return Number((m[1] && m[1] !== '+' ? '-' : '') + m[2].replace(/,/g, '') + (m[3] ?? ''));
}

/**
 * A cell that is a number and nothing else, give or take a trailing percent sign,
 * read by the same pattern. A column of these is a column of numbers, which is what
 * decides whether a pasted table right-aligns it, so an amounts column lines up for
 * the same reason $4.50 sorts as 4.5.
 */
export function wholeNumber(cell: string): number | null {
  const m = NUMBER_AT_START.exec(cell);
  if (!m || !/^%?$/.test(cell.slice(m[0].length))) return null;
  return leadingNumber(cell);
}

/**
 * The three numbers of a cell written as a whole slashed date, in the order they
 * are written, or null for anything else. The whole cell has to be the date:
 * `1/2 cup` is a quantity, and a cell that merely starts with a date is text.
 * ISO dates need nothing here, since they already sort correctly as text.
 */
export function slashedDate(cell: string): [number, number, number] | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(cell.trim());
  if (!m) return null;
  // A two-digit year is read the way a spreadsheet reads it.
  const short = Number(m[3]);
  return [Number(m[1]), Number(m[2]), m[3].length === 2 ? short + (short < 70 ? 2000 : 1900) : short];
}

/** Which field of a slashed date holds the day, for one column of them. */
export type DateOrder = 'day-first' | 'month-first';

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
export function columnDateOrder(cells: readonly string[]): DateOrder | null {
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
export function dateValue(cell: string, order: DateOrder): number | null {
  const parts = slashedDate(cell);
  if (!parts) return null;
  const [first, second, year] = parts;
  const [day, month] = order === 'day-first' ? [first, second] : [second, first];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year * 10000 + month * 100 + day;
}
