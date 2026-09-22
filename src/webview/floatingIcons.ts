/*
 * Icons for the selection toolbar, the link popover and the slash menu: single-color
 * SVGs with Lucide geometry, drawn in `currentColor` so they take the button's themed color.
 *
 * The block icons at the bottom are for the slash menu. Where the main toolbar has
 * a button for the same command, the geometry here is that button's, so a command
 * looks the same wherever it is reached from. The rest follow the same Lucide family,
 * because the commands they stand for are only ever reached by name today.
 */

/*
 * Boxed angle brackets: the inline code icon, enclosed so it reads as the block's
 * source rather than a run of characters. Edit Markdown and Code block share it
 * because both are the same idea, a block shown as the text it is written as.
 */
const BOXED_BRACKETS = '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m10 9-3 3 3 3"/><path d="m14 15 3-3-3-3"/>';

const PATHS = {
  bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  source: BOXED_BRACKETS,
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  clear: '<path d="M4 7V4h16v3"/><path d="M5 20h6"/><path d="M13 4 8 20"/><path d="m15 15 5 5"/><path d="m20 15-5 5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  unlink:
    '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/>' +
    '<path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/>' +
    '<line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/>',

  // Block icons. The list icons show three rows, reading as an actual multi-item list.
  paragraph: '<path d="M13 4v16"/><path d="M17 4v16"/><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
  heading1: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/>',
  heading2: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>',
  heading3:
    '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/>' +
    '<path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/>',
  heading4: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17 10v3a1 1 0 0 0 1 1h3"/><path d="M21 10v8"/>',
  heading5:
    '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/>' +
    '<path d="M17 13v-3h4"/><path d="M17 17.7c.4.2.8.3 1.3.3 1.5 0 2.7-1.1 2.7-2.5S19.8 13 18.3 13H17"/>',
  heading6:
    '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/>' +
    '<circle cx="19" cy="16" r="2"/><path d="M20 10c-2 2-3 3.5-3 6"/>',
  bulletList:
    '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/>' +
    '<line x1="8" x2="21" y1="5" y2="5"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="19" y2="19"/>',
  orderedList:
    '<line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/>' +
    '<path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  taskList: '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  quote: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
  codeBlock: BOXED_BRACKETS,
  table: '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  // A grid with a header band and more columns than the pipe table's icon, for the
  // fenced data table, which is the container for the wider sheet.
  dataTable:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>' +
    '<path d="M9 9v12"/><path d="M15 9v12"/>',
  divider: '<path d="M5 12h14"/>',
};

export type FloatingIcon = keyof typeof PATHS;

/** SVG markup for an icon, styled by the toolbar's `.sheaf-tb-icon` rules. */
export function floatingIcon(name: FloatingIcon, extraClass = ''): string {
  return (
    `<svg class="sheaf-tb-icon${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${PATHS[name]}</svg>`
  );
}
