/*
 * The slash menu: typing `/` at the start of a line or after a space opens a
 * filterable list of blocks to turn the current line into or insert at it.
 *
 * `/` is an ordinary Markdown character, so the menu never gets in the way of a
 * slash typed on purpose. It opens only at a line start or right after whitespace
 * (a URL, a path or a fraction mid-word never opens it), and Escape closes it and
 * leaves the typed text alone.
 *
 * A filter that matches nothing keeps the menu open and says so, because the usual
 * reason for it is a typo: closing on the mistyped letter would make the person
 * delete the whole command and start again, while staying open means one backspace
 * brings the list back. What does close it for good is a sign the person has gone
 * back to writing prose: a leading space, a second space, a newline, or a query
 * long enough that it is no longer a command.
 */

import { EditorSelection, EditorState, Extension, Prec, StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { insertCsvTable, insertPipeTable } from './tables';
import { insertDivider } from './toolbar';
import { TurnIntoKind, replaceAndConvert } from './blockModel';
import { FloatingIcon, floatingIcon } from './floatingIcons';

export interface SlashItem {
  id: TurnIntoKind | 'table' | 'csv' | 'divider';
  label: string;
  keywords: string;
  /** The icon the toolbar gives this command, so both surfaces read as one system. */
  icon: FloatingIcon;
  /**
   * The Markdown a pick writes, shown at the right of the row so that reaching for
   * the menu teaches the syntax rather than hiding it. It is the marker the command
   * actually inserts; a command whose markup has no single spelling carries no hint,
   * because an approximate one would teach the wrong thing.
   */
  hint?: string;
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', label: 'Text', keywords: 'paragraph plain', icon: 'paragraph' },
  { id: 'h1', label: 'Heading 1', keywords: 'h1 # title', icon: 'heading1', hint: '#' },
  { id: 'h2', label: 'Heading 2', keywords: 'h2 ## subheading', icon: 'heading2', hint: '##' },
  { id: 'h3', label: 'Heading 3', keywords: 'h3 ###', icon: 'heading3', hint: '###' },
  // The deep levels have no shortcut, so typing the command is how they are reached
  // from the keyboard. A person who types /h4 and gets nothing has met the same
  // refusal as a menu that stops at three.
  { id: 'h4', label: 'Heading 4', keywords: 'h4 ####', icon: 'heading4', hint: '####' },
  { id: 'h5', label: 'Heading 5', keywords: 'h5 #####', icon: 'heading5', hint: '#####' },
  { id: 'h6', label: 'Heading 6', keywords: 'h6 ######', icon: 'heading6', hint: '######' },
  { id: 'bullet', label: 'Bullet list', keywords: 'unordered ul -', icon: 'bulletList', hint: '-' },
  { id: 'ordered', label: 'Numbered list', keywords: 'ordered ol 1.', icon: 'orderedList', hint: '1.' },
  { id: 'task', label: 'Task list', keywords: 'todo checkbox checklist [ ]', icon: 'taskList', hint: '- [ ]' },
  { id: 'quote', label: 'Quote', keywords: 'blockquote >', icon: 'quote', hint: '>' },
  { id: 'code', label: 'Code block', keywords: 'fenced pre ```', icon: 'codeBlock', hint: '```' },
  { id: 'table', label: 'Table', keywords: 'pipe grid', icon: 'table', hint: '|' },
  // The data table is a fenced block with a language on it, so what a pick writes is
  // the fence and `csv` together. Neither half alone is the syntax, so the row is bare.
  { id: 'csv', label: 'CSV data table', keywords: 'tsv spreadsheet data grid', icon: 'dataTable' },
  { id: 'divider', label: 'Divider', keywords: 'hr rule horizontal line ---', icon: 'divider', hint: '---' },
];

/*
 * The items whose label or keywords have a word starting with each word of `query`.
 * The Markdown hint is there to be read, never to be matched: a person typing `|`
 * after the slash is not asking for a table, and searching the hints would pull up
 * rows with nothing on them to explain the match.
 */
export function filterSlashItems(query: string): SlashItem[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return SLASH_ITEMS.filter((item) => {
    const words = `${item.label} ${item.keywords}`.toLowerCase().split(/\s+/);
    return tokens.every((t) => words.some((w) => w.startsWith(t)));
  });
}

interface SlashState {
  /** Start of the text a pick replaces: the `/`, or the caret when opened from the `+` button. */
  from: number;
  /** Start of the filter text. */
  queryFrom: number;
  query: string;
  selected: number;
}

const openSlash = StateEffect.define<{ from: number; queryFrom: number }>();
const closeSlash = StateEffect.define<null>();
const moveSlash = StateEffect.define<number>();

/** Inside these, a `/` is code, markup or table source and never opens the menu. */
const LITERAL_BLOCKS = /^(FencedCode|CodeBlock|HTMLBlock|CommentBlock|Table)$/;
const LITERAL_INLINE = /^(InlineCode|HTMLTag|URL|Autolink)$/;

/** True when line `lineNo` is inside YAML front matter at the top of the document. */
function inFrontMatter(state: EditorState, lineNo: number): boolean {
  const doc = state.doc;
  if (doc.lines < 3 || doc.line(1).text.trimEnd() !== '---' || doc.line(2).text.trim() === '') return false;
  for (let n = 2; n <= doc.lines; n++) {
    const t = doc.line(n).text.trimEnd();
    if (t === '---' || t === '...') return lineNo <= n;
  }
  return false;
}

function slashAllowedAt(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  if (before !== '' && !/\s$/.test(before)) return false;
  if (inFrontMatter(state, line.number)) return false;
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      // An unclosed fence runs to the end of the document, so a block contains its end.
      if (LITERAL_BLOCKS.test(node.name) && node.from < pos && pos <= node.to) return false;
      if (LITERAL_INLINE.test(node.name) && node.from < pos && pos < node.to) return false;
    }
  }
  return true;
}

function validQuery(query: string): boolean {
  return !/^\s/.test(query) && !/\s\s/.test(query) && !query.includes('\n') && query.length <= 40;
}

export const slashField = StateField.define<SlashState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(closeSlash)) return null;
      if (e.is(openSlash)) value = { from: e.value.from, queryFrom: e.value.queryFrom, query: '', selected: 0 };
    }
    const { state } = tr;
    if (!value) {
      // Open on a single typed `/` in a place where it may start a command.
      if (!tr.docChanged || !tr.isUserEvent('input.type')) return null;
      let inserted: { at: number; text: string } | null = null;
      let count = 0;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
        count++;
        if (fromA === toA) inserted = { at: fromA, text: text.toString() };
      });
      const ins = inserted as { at: number; text: string } | null;
      if (count !== 1 || !ins || ins.text !== '/') return null;
      if (state.selection.ranges.length !== 1 || state.selection.main.head !== ins.at + 1) return null;
      if (!slashAllowedAt(tr.startState, ins.at)) return null;
      return { from: ins.at, queryFrom: ins.at + 1, query: '', selected: 0 };
    }
    if (tr.docChanged) {
      const slash = value.queryFrom > value.from;
      value = { ...value, from: tr.changes.mapPos(value.from, slash ? 1 : -1), queryFrom: tr.changes.mapPos(value.queryFrom, -1) };
    }
    const sel = state.selection;
    const head = sel.main.head;
    if (sel.ranges.length !== 1 || !sel.main.empty || head < value.queryFrom) return null;
    if (state.doc.lineAt(head).number !== state.doc.lineAt(value.from).number) return null;
    if (value.queryFrom > value.from && state.doc.sliceString(value.from, value.queryFrom) !== '/') return null;
    const query = state.doc.sliceString(value.queryFrom, head);
    if (!validQuery(query)) return null;
    let selected = query === value.query ? value.selected : 0;
    for (const e of tr.effects) if (e.is(moveSlash)) selected = e.value;
    // A changed query starts back at the first item, so a backspace that brings
    // the list back comes back with that item highlighted and ready for Enter.
    const n = filterSlashItems(query).length;
    selected = n === 0 ? 0 : ((selected % n) + n) % n;
    return { ...value, query, selected };
  },
});

/** The open slash menu's filter, matching items and highlighted index, or null when closed. */
export function slashMenuOf(state: EditorState): { from: number; query: string; items: SlashItem[]; selected: number } | null {
  const value = state.field(slashField, false);
  return value ? { from: value.from, query: value.query, items: filterSlashItems(value.query), selected: value.selected } : null;
}

/** Open the menu at the caret with no `/` typed, as the `+` button does. */
export function openSlashMenuAtCaret(view: EditorView): void {
  const head = view.state.selection.main.head;
  view.dispatch({ effects: openSlash.of({ from: head, queryFrom: head }) });
}

/** Run a slash item: remove the typed `/query`, then convert the line or insert at it. */
export function pickSlashItem(view: EditorView, item: SlashItem): void {
  const value = view.state.field(slashField, false);
  if (!value) return;
  const head = view.state.selection.main.head;
  view.dispatch({ effects: closeSlash.of(null) });
  if (item.id === 'table' || item.id === 'csv' || item.id === 'divider') {
    view.dispatch({ changes: { from: value.from, to: head }, selection: EditorSelection.cursor(value.from), userEvent: 'delete.slash' });
    if (item.id === 'table') insertPipeTable(view);
    else if (item.id === 'csv') insertCsvTable(view);
    else insertDivider(view);
    return;
  }
  replaceAndConvert(view, value.from, head, item.id);
  view.focus();
}

function whenOpen(run: (view: EditorView, menu: NonNullable<ReturnType<typeof slashMenuOf>>) => void) {
  return (view: EditorView): boolean => {
    const menu = slashMenuOf(view.state);
    if (!menu) return false;
    run(view, menu);
    return true;
  };
}

/** Insert the highlighted item. False when there is nothing listed, so the key falls through. */
function pickHighlighted(view: EditorView): boolean {
  const menu = slashMenuOf(view.state);
  if (!menu || menu.items.length === 0) return false;
  pickSlashItem(view, menu.items[menu.selected]);
  return true;
}

const slashKeymap = Prec.highest(
  keymap.of([
    // The arrows and Tab belong to the menu while it is open, whether or not it
    // lists anything: with nothing listed they do nothing rather than move the
    // caret or indent the line out from under it.
    { key: 'ArrowDown', run: whenOpen((v, m) => v.dispatch({ effects: moveSlash.of(m.selected + 1) })) },
    { key: 'ArrowUp', run: whenOpen((v, m) => v.dispatch({ effects: moveSlash.of(m.selected - 1) })) },
    { key: 'Tab', run: (v) => pickHighlighted(v) || slashMenuOf(v.state) !== null },
    // Enter is the exception. With nothing to insert it is left to the document,
    // so it breaks the line as it would anywhere else and the menu closes with it.
    { key: 'Enter', run: pickHighlighted },
    { key: 'Escape', run: whenOpen((v) => v.dispatch({ effects: closeSlash.of(null) })) },
  ])
);

/**
 * Put a list that opened at the caret just below the line at `coords`, or above it
 * when there is no room below, kept inside the window, with its highlighted row in view.
 */
export function placeListAt(dom: HTMLElement, coords: { left: number; top: number; bottom: number }): void {
  const height = dom.offsetHeight;
  const below = coords.bottom + 4;
  const top = below + height > window.innerHeight && coords.top - height - 4 > 0 ? coords.top - height - 4 : below;
  dom.style.left = `${Math.max(4, Math.min(coords.left, window.innerWidth - dom.offsetWidth - 4))}px`;
  dom.style.top = `${Math.max(4, top)}px`;
  dom.querySelector('.is-selected')?.scrollIntoView?.({ block: 'nearest' });
}

/** Draws the open menu next to the caret. */
const slashView = ViewPlugin.fromClass(
  class {
    dom: HTMLElement | null = null;
    constructor(readonly view: EditorView) {
      this.sync();
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.length) || update.geometryChanged) this.sync();
    }
    sync(): void {
      const menu = slashMenuOf(this.view.state);
      if (!menu) {
        this.dom?.remove();
        this.dom = null;
        return;
      }
      if (!this.dom) {
        this.dom = document.createElement('div');
        this.dom.className = 'sheaf-slash-menu';
        this.dom.setAttribute('role', 'listbox');
        this.dom.setAttribute('aria-label', 'Insert block');
        document.body.appendChild(this.dom);
      }
      const dom = this.dom;
      dom.replaceChildren();
      if (menu.items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sheaf-slash-empty';
        empty.setAttribute('role', 'option');
        empty.setAttribute('aria-disabled', 'true');
        empty.setAttribute('aria-selected', 'false');
        empty.textContent = 'No matching blocks';
        dom.appendChild(empty);
      }
      menu.items.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'sheaf-slash-item' + (index === menu.selected ? ' is-selected' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === menu.selected));
        // The icon and the hint are decoration. A screen reader reads the row as its
        // label alone, which is the name the person is looking for in the list.
        const icon = document.createElement('span');
        icon.className = 'sheaf-slash-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = floatingIcon(item.icon);
        const label = document.createElement('span');
        label.className = 'sheaf-slash-label';
        label.textContent = item.label;
        row.append(icon, label);
        if (item.hint) {
          const hint = document.createElement('span');
          hint.className = 'sheaf-slash-hint';
          hint.setAttribute('aria-hidden', 'true');
          hint.textContent = item.hint;
          row.appendChild(hint);
        }
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pickSlashItem(this.view, item);
        });
        dom.appendChild(row);
      });
      this.view.requestMeasure({
        read: (view) => {
          try {
            return view.coordsAtPos(menu.from);
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
      this.dom?.remove();
    }
  },
  {
    eventHandlers: {
      blur(_event, view) {
        if (view.state.field(slashField, false)) setTimeout(() => view.state.field(slashField, false) && view.dispatch({ effects: closeSlash.of(null) }), 0);
      },
    },
  }
);

export const slashMenu: Extension = [slashField, slashKeymap, slashView];
