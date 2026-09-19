/*
 * The slash menu: typing `/` at the start of a line or after a space opens a
 * filterable list of blocks to turn the current line into or insert at it.
 *
 * `/` is an ordinary Markdown character, so the menu never gets in the way of a
 * slash typed on purpose. It opens only at a line start or right after whitespace
 * (a URL, a path or a fraction mid-word never opens it), Escape closes it and
 * leaves the typed text alone, and a filter that matches nothing closes it too.
 */

import { EditorSelection, EditorState, Extension, Prec, StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { insertCsvTable, insertPipeTable } from './tables';
import { insertDivider } from './toolbar';
import { TurnIntoKind, replaceAndConvert } from './blockModel';

export interface SlashItem {
  id: TurnIntoKind | 'table' | 'csv' | 'divider';
  label: string;
  keywords: string;
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', label: 'Text', keywords: 'paragraph plain' },
  { id: 'h1', label: 'Heading 1', keywords: 'h1 # title' },
  { id: 'h2', label: 'Heading 2', keywords: 'h2 ## subheading' },
  { id: 'h3', label: 'Heading 3', keywords: 'h3 ###' },
  { id: 'bullet', label: 'Bullet list', keywords: 'unordered ul -' },
  { id: 'ordered', label: 'Numbered list', keywords: 'ordered ol 1.' },
  { id: 'task', label: 'Task list', keywords: 'todo checkbox checklist [ ]' },
  { id: 'quote', label: 'Quote', keywords: 'blockquote >' },
  { id: 'code', label: 'Code block', keywords: 'fenced pre ```' },
  { id: 'table', label: 'Table', keywords: 'pipe grid' },
  { id: 'csv', label: 'CSV data table', keywords: 'tsv spreadsheet data grid' },
  { id: 'divider', label: 'Divider', keywords: 'hr rule horizontal line ---' },
];

/** The items whose label or keywords have a word starting with each word of `query`. */
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
    if (!validQuery(query) || filterSlashItems(query).length === 0) return null;
    let selected = query === value.query ? value.selected : 0;
    for (const e of tr.effects) if (e.is(moveSlash)) selected = e.value;
    const n = filterSlashItems(query).length;
    selected = ((selected % n) + n) % n;
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

const slashKeymap = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: whenOpen((v, m) => v.dispatch({ effects: moveSlash.of(m.selected + 1) })) },
    { key: 'ArrowUp', run: whenOpen((v, m) => v.dispatch({ effects: moveSlash.of(m.selected - 1) })) },
    { key: 'Enter', run: whenOpen((v, m) => pickSlashItem(v, m.items[m.selected])) },
    { key: 'Tab', run: whenOpen((v, m) => pickSlashItem(v, m.items[m.selected])) },
    { key: 'Escape', run: whenOpen((v) => v.dispatch({ effects: closeSlash.of(null) })) },
  ])
);

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
      menu.items.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'sheaf-slash-item' + (index === menu.selected ? ' is-selected' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === menu.selected));
        row.textContent = item.label;
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
          if (!coords || !this.dom) return;
          const height = this.dom.offsetHeight;
          const below = coords.bottom + 4;
          const top = below + height > window.innerHeight && coords.top - height - 4 > 0 ? coords.top - height - 4 : below;
          this.dom.style.left = `${Math.max(4, Math.min(coords.left, window.innerWidth - this.dom.offsetWidth - 4))}px`;
          this.dom.style.top = `${Math.max(4, top)}px`;
          this.dom.querySelector('.is-selected')?.scrollIntoView?.({ block: 'nearest' });
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
