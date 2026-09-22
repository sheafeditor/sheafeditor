/*
 * How heavy a rendered table is against the prose around it.
 *
 * A table used to tint every second body row and fill its row-number gutter
 * dark enough to read as a column of data, which made eleven rows of Markdown
 * look like a spreadsheet dropped into the page. The rows are now separated by
 * the cell borders alone, and the gutter is a margin: a fainter fill and digits
 * that fade toward the page behind them.
 *
 * jsdom has no layout and the prose bundle is built for the browser, so nothing
 * here can measure a colour; what a person sees is checked in a real window, in
 * a light, a dark and a high-contrast theme. These scenarios hold what the
 * stylesheet says: that no rule tints a row by its position, that the gutter is
 * the weaker of the two surfaces, and that everything which draws over a cell
 * survived, since those are what a person now reads a table by.
 *
 * The stylesheet arrives as a global because the runner reads it; see
 * test/prose.test.mjs.
 */

import { Scenario } from '../harness';

/** The whole of media/webview.css, as the runner read it off disk. */
function stylesheet(): string {
  const text = (globalThis as { sheafWebviewCss?: string }).sheafWebviewCss;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('media/webview.css was not handed to the prose bundle');
  }
  return text;
}

/** Just the rendered-table rules: the section header down to the next one. */
function tableSection(): string {
  const css = stylesheet();
  const start = css.indexOf('/* ---- Rendered tables');
  if (start < 0) throw new Error('the rendered-table section is no longer marked in media/webview.css');
  const next = css.indexOf('/* ---- ', start + 1);
  return css.slice(start, next < 0 ? css.length : next);
}

/** The same section with its comments removed, so prose about a colour is not read as one. */
function tableRules(): string {
  return tableSection().replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of the first rule whose selector list matches, comments stripped. */
function ruleBody(selector: RegExp): string {
  const found = new RegExp(selector.source + '[^{}]*\\{([^}]*)\\}', selector.flags).exec(tableRules());
  return found ? found[1] : '';
}

/** The percentage a `color-mix` takes of `variable` in `declaration`, or NaN. */
function mixPercent(declaration: string, variable: string): number {
  const found = new RegExp(`color-mix\\(in srgb,\\s*var\\(${variable}\\)\\s*(\\d+(?:\\.\\d+)?)%`).exec(declaration);
  return found ? Number(found[1]) : NaN;
}

const GUTTER = /\.sheaf-table \.sheaf-table-gutter/;

export const scenarios: Scenario[] = [
  {
    name: 'no body row of a table is tinted by where it falls, so a dozen rows read as one block',
    run: () => {
      const rules = tableRules();
      // A stripe is a background chosen by a row's position. Nothing in the table
      // rules may select one that way, whether or not `:where()` hides its weight.
      const positional = /(?:nth-child|nth-of-type|nth-last-child|nth-last-of-type)/.test(rules);
      // `tr` still carries drag, drop-target and just-changed marks, which are
      // classes rather than positions, so the row selector itself stays in use.
      const stillUsesRows = /\.sheaf-table tr\./.test(rules);
      return !positional && stillUsesRows;
    },
  },
  {
    name: 'the row-number gutter is fainter than the header row beside it, so it frames the grid rather than joining it',
    run: () => {
      const gutter = ruleBody(GUTTER);
      const header = ruleBody(/\.sheaf-table th(?=\s*\{)/);
      const gutterFill = mixPercent(gutter, '--md-text');
      const headerFill = mixPercent(header, '--md-text');
      // The value the gutter is pinned to, and the one thing it must stay under.
      return gutterFill === 4 && headerFill === 5 && gutterFill < headerFill;
    },
  },
  {
    name: 'the row numbers are drawn quieter than muted text, fading toward the page behind them',
    run: () => {
      const gutter = ruleBody(GUTTER);
      const colour = /color:\s*([^;]+);/.exec(gutter)?.[1] ?? '';
      // Two thirds of the muted foreground, mixed toward the editor background:
      // the surface the gutter's translucent fill is laid over.
      const weight = mixPercent(colour, '--md-muted');
      return (
        weight > 50 &&
        weight < 80 &&
        colour.includes('var(--vscode-editor-background)') &&
        !colour.includes('transparent')
      );
    },
  },
  {
    name: 'the gutter fill stays translucent, because the row stripe it used to cover is gone',
    run: () => {
      const gutter = ruleBody(GUTTER);
      return /background:\s*color-mix\(in srgb, var\(--md-text\) 4%, transparent\)/.test(gutter);
    },
  },
  {
    name: 'everything a person picks a cell out by still paints over it',
    run: () => {
      const rules = tableRules();
      // Each of these replaces a cell's background or draws an edge on it, and each
      // is what tells somebody where the pointer, the selection or a dragged row is.
      const paints: RegExp[] = [
        /\.sheaf-table td:hover\s*\{[^}]*background:/,                       // pointer
        /\.sheaf-table td\.is-sel[,\s][^{]*\{[^}]*background:/,              // selected cells
        // The row number and header of what is selected: coloured text, and no fill,
        // so one selected cell does not light up two more pieces of chrome.
        /\.sheaf-table td\.sheaf-table-gutter\.is-sel-axis[^{]*\{[^}]*color:/, // selected row, in the gutter
        /\.sheaf-table th\.is-sel-axis[^{]*\{[^}]*color:/,              // selected column, in the header
        /\.sheaf-table \.sheaf-table-gutter:hover[^{]*\{[^}]*background:/,   // pointer on a row number
        /\.sheaf-table td\.is-focus[^{]*\{[^}]*outline:/,                    // the cell with the keyboard
        /\.sheaf-table tr\.is-row-dragging td\s*\{[^}]*opacity:/,            // the row being dragged
        /\.sheaf-table \.is-col-dragging\s*\{[^}]*opacity:/,                 // the column being dragged
        /\.sheaf-table tr\.is-drop-(?:before|after) td\s*\{[^}]*box-shadow:/, // where a row lands
        /\.sheaf-table \.is-col-drop-(?:before|after)\s*\{[^}]*box-shadow:/,  // where a column lands
      ];
      const axisFilled = /\.sheaf-table (?:td\.sheaf-table-gutter|th)\.is-sel-axis[^{]*\{[^}]*background/.test(rules);
      return paints.every((r) => r.test(rules)) && !axisFilled;
    },
  },
  {
    name: 'every colour a table is drawn in comes from the theme, so it follows whichever one is running',
    run: () => {
      const rules = tableRules();
      const literal = /#[0-9a-f]{3,8}\b/i.test(rules) || /\b(?:rgba?|hsla?)\(/i.test(rules);
      // Both ends of the two rules this section turns on: a theme variable, never a value.
      const themed =
        /var\(--md-text\)/.test(ruleBody(GUTTER)) && /var\(--md-muted\)/.test(ruleBody(GUTTER));
      return !literal && themed;
    },
  },
];
