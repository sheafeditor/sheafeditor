/*
 * Icons for a table's floating bar, its overflow menu and the chevron menus on
 * the column headers and row numbers: single-color SVGs with Lucide geometry,
 * drawn in `currentColor` so they take the button's themed color.
 *
 * They are their own file because they stand for table commands and nothing
 * else. The weight, the 24-unit box and the `currentColor` stroke are the main
 * toolbar's, so a table button sits at the same size and darkness as a toolbar
 * button beside it.
 *
 * The row and column families share one idea: a rounded band is the row or the
 * column the command names, and the mark beside it says what happens to it. A
 * band lying flat is a row, a band standing up is a column, so the two families
 * never read as each other at sixteen pixels.
 */

import { PATHS as FLOATING_PATHS } from './floatingIcons';

/*
 * Boxed angle brackets, the same geometry the main toolbar draws for showing a
 * block as its source. A table's `</>` button is that command, so it is that icon.
 */
const BOXED_BRACKETS = '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m10 9-3 3 3 3"/><path d="m14 15 3-3-3-3"/>';

/*
 * A heading, with its level as a numeral beside the H.
 *
 * Six hand-drawn variants differing only in the height of a bar do not read at the size a
 * menu row draws them, which is 13px here. Every editor that shows heading levels in a menu
 * settles this the same way, and so does this: one shape, one digit.
 *
 * The numeral is a `<text>` rather than a path, so it takes the interface font and stays
 * crisp at any size. It has to turn the stroke off and the fill on, because the surrounding
 * `<svg>` sets `stroke="currentColor" fill="none"` for the line art and a glyph drawn that
 * way comes out as an outline.
 */
const heading = (level: number): string =>
  '<path d="M4 5v14"/><path d="M12 5v14"/><path d="M4 12h8"/>' +
  `<text x="15" y="19" font-size="11" font-weight="700" fill="currentColor" stroke="none">${level}</text>`;

/*
 * One set of glyphs, not two.
 *
 * The main toolbar's icons and the table's were separate maps that already held the same
 * `source` and `chevron` geometry twice, and the right-click menu is what made the split
 * untenable: it draws table commands and prose commands in one column, so a row could only
 * carry a glyph if its name happened to be in whichever map the renderer imported. The two
 * render functions were identical apart from the class they put on the `<svg>`, which is the
 * part that genuinely differs, so that is the part that stays separate.
 *
 * The toolbar's names come first, so a name defined in both resolves to the table's. Today
 * that is only `source` and `chevron`, and they are the same geometry either way.
 */
const PATHS = {
  ...FLOATING_PATHS,

  // Heading levels, for Turn into.
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),

  /*
   * Turn into, on the row that opens the submenu. One block becoming another, which is a
   * different idea from any of the kinds inside it, so it is its own shape rather than a
   * borrowed one. Leaving the row bare was the alternative and it is worse: a gap in a
   * column of glyphs reads as a missing one.
   *
   * Two full-width arrows, not two small blocks with an arrow between them. That was the
   * first drawing and it fails at the size this is used: a menu row draws it at 13px, so a
   * 3px arrow inside the 24-unit box lands under two pixels and disappears, leaving what
   * reads on screen as two little boxes and nothing joining them. Anything smaller than
   * about a quarter of the box is not there at this size.
   */
  turnInto: '<path d="m16 3 4 4-4 4"/><path d="M20 7H5"/><path d="m8 21-4-4 4-4"/><path d="M4 17h15"/>',

  // Front matter: shown, collapsed, hidden, and how far the choice reaches.
  show: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  hide:
    '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>' +
    '<path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>' +
    '<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m2 2 20 20"/>',
  collapse: '<path d="M12 22v-6"/><path d="M12 8V2"/><path d="m9 19 3 3 3-3"/><path d="m9 5 3-3 3 3"/><path d="M4 12h16"/>',
  everywhere: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',

  // Row commands. The arrow points at the side the new row lands on.
  rowAbove: '<rect x="3" y="13" width="18" height="8" rx="1.5"/><path d="M12 10V3"/><path d="m8.5 6.5 3.5-3.5 3.5 3.5"/>',
  rowBelow: '<rect x="3" y="3" width="18" height="8" rx="1.5"/><path d="M12 14v7"/><path d="m8.5 17.5 3.5 3.5 3.5-3.5"/>',
  // A row struck through, which is what deleting it leaves behind for an instant.
  rowDelete: '<rect x="3" y="8" width="18" height="8" rx="1.5"/><path d="m6 9 12 6"/>',
  // Two bands of the same shape: the row, and the copy of it.
  rowDuplicate: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/>',
  rowMoveUp: '<path d="M12 20V5"/><path d="m5 12 7-7 7 7"/>',
  rowMoveDown: '<path d="M12 4v15"/><path d="m5 12 7 7 7-7"/>',

  // Column commands: the same marks turned a quarter turn.
  colLeft: '<rect x="13" y="3" width="8" height="18" rx="1.5"/><path d="M10 12H3"/><path d="m6.5 8.5-3.5 3.5 3.5 3.5"/>',
  colRight: '<rect x="3" y="3" width="8" height="18" rx="1.5"/><path d="M14 12h7"/><path d="m17.5 8.5 3.5 3.5-3.5 3.5"/>',
  colDelete: '<rect x="8" y="3" width="8" height="18" rx="1.5"/><path d="m9 6 6 12"/>',
  colDuplicate: '<rect x="4" y="3" width="6" height="18" rx="1.5"/><rect x="14" y="3" width="6" height="18" rx="1.5"/>',
  colMoveLeft: '<path d="M20 12H5"/><path d="m12 19-7-7 7-7"/>',
  colMoveRight: '<path d="M4 12h15"/><path d="m12 5 7 7-7 7"/>',

  // Sorting: rows of growing and shrinking length under one arrow, so which way
  // the column is about to be put in order reads without the label.
  sortAsc: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h4"/><path d="M11 8h7"/><path d="M11 12h10"/>',
  sortDesc: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/>',

  alignLeft: '<path d="M3 6h18"/><path d="M3 12h12"/><path d="M3 18h14"/>',
  alignCenter: '<path d="M3 6h18"/><path d="M6 12h12"/><path d="M5 18h14"/>',
  alignRight: '<path d="M3 6h18"/><path d="M9 12h12"/><path d="M7 18h14"/>',
  // The same bars with a cross beside them: the column keeps its text and loses
  // the alignment that was set on it.
  alignClear: '<path d="M3 6h14"/><path d="M3 12h8"/><path d="M3 18h10"/><path d="m16 14 5 5"/><path d="m21 14-5 5"/>',
  // Text held between two margins, which is what padding a pipe table's source does.
  pad: '<path d="M4 3v18"/><path d="M20 3v18"/><path d="M8 8h8"/><path d="M8 12h5"/><path d="M8 16h8"/>',
  // A column border with an arrow pushing out from each side of it: every column
  // taken to the width of what it holds.
  fitColumns: '<path d="M12 3v18"/><path d="M8 12H3"/><path d="m5.5 9.5-2.5 2.5 2.5 2.5"/><path d="M16 12h5"/><path d="m18.5 9.5 2.5 2.5-2.5 2.5"/>',
  // A turning arrow: back to the widths the table would have on its own.
  resetWidths: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  // A page with a folded corner and an arrow going into it: the rows leave the
  // document for a file of their own.
  moveToFile: '<path d="M14 3H7a2 2 0 0 0-2 2v4"/><path d="M14 3v5h5"/><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-2"/><path d="M3 13h9"/><path d="m9 10 3 3-3 3"/>',

  // A view: the table it reads, and a smaller shape beside it holding some of the
  // same rows. The funnel says which part, in the same two-shape idea the row and
  // column families use.
  createView: '<rect x="3" y="4" width="8" height="16" rx="1.5"/><path d="M14 6h7l-3 4v5l-1.5-1v-4z"/>',
  source: BOXED_BRACKETS,
  // The rest of the commands, behind one button.
  /*
   * Copy ref and Send to terminal, the two rows of the right-click menu that had no glyph.
   *
   * A menu where most rows carry an icon and two do not is worse than one where none does: the
   * eye reads the gap as meaning something. These exist so the menu has no holes in it.
   *
   * `copyRef` is two sheets with a corner turned, which is the clipboard idea every product
   * draws that way. `terminal` is a prompt and a caret, which is what a terminal looks like at
   * 24 pixels and reads as nothing else.
   */
  copyRef: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>',
  overflow: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  // The mark on a column header and a row number that opens that axis's menu.
  chevron: '<path d="m6 9 6 6 6-6"/>',
};

export type TableIcon = keyof typeof PATHS;

/** SVG markup for an icon, styled by the table's `.sheaf-table-icon` rules. */
export function tableIcon(name: TableIcon, extraClass = ''): string {
  return (
    `<svg class="sheaf-table-icon${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${PATHS[name]}</svg>`
  );
}
