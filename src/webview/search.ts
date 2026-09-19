/*
 * Find and replace in the document.
 *
 * Built on @codemirror/search, which searches the raw Markdown: every match is a
 * range of the file, so replacing rewrites exactly the matched bytes and nothing
 * else. The panel is Sheaf's own (a find row, and a replace row shown on demand)
 * so it can carry a match count and read like the rest of the editor's chrome.
 *
 * Two kinds of match sit where the document's own text is not what is drawn:
 *   - Inside a table drawn as a grid. The cells already show the matched text, so
 *     the table stays a grid and the match is read where it sits. What a grid
 *     cannot draw is the selection over it, so such a match is found, counted and
 *     stepped through without being outlined.
 *   - Inside syntax the live preview hides (a link's URL, a heading's `#`). Moving
 *     to such a match reveals the raw Markdown of its lines, the same reveal Edit
 *     Markdown gives, which collapses once the caret leaves them.
 *
 * Mod-d (select next occurrence) and Mod-Shift-l (select all occurrences) from the
 * package's default keymap are left out on purpose: those keys belong to block
 * editing.
 */

import { Extension, StateEffect } from '@codemirror/state';
import { EditorView, KeyBinding, Panel, ViewUpdate, keymap, runScopeHandlers } from '@codemirror/view';
import {
  SearchQuery,
  search,
  getSearchQuery,
  setSearchQuery,
  openSearchPanel,
  closeSearchPanel,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from '@codemirror/search';
import { setReveal } from './livePreview';
import { tableGridCovers } from './tables';
import { hint, registerShortcutGroup } from './shortcuts';

/* ---- Commands ------------------------------------------------------------ */

/**
 * After a command moves the selection onto a match, reveal the match's lines when
 * any part of it sits under a replaced (hidden) range, so the selection is seen.
 *
 * A table drawn as a grid is the exception: its cells already show the matched
 * text, so there is nothing to uncover, and revealing it would turn the table
 * into raw pipes at the moment someone found the value they were looking for and
 * leave it that way after Escape, since the match stays selected.
 *
 * The question is asked of each hidden range, not of the match as a whole. A
 * match can begin in the paragraph above a table and end inside it, or start in
 * its last row and run past it; asking whether one grid held the whole match
 * would answer no to both and open the pipes. Asking per range lets a grid count
 * for nothing while any other hidden syntax the match reaches still reveals.
 */
function revealMatch(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  if (from === to) return;
  let hidden = false;
  for (const source of view.state.facet(EditorView.atomicRanges)) {
    source(view).between(from, to, (a, b) => {
      if (b > from && a < to && !tableGridCovers(view.state, a, b)) hidden = true;
      return hidden ? false : undefined;
    });
    if (hidden) break;
  }
  if (!hidden) return;
  const { doc } = view.state;
  view.dispatch({ effects: setReveal.of({ from: doc.lineAt(from).from, to: doc.lineAt(to).to }) });
}

const thenReveal =
  (command: (view: EditorView) => boolean) =>
  (view: EditorView): boolean => {
    const ran = command(view);
    if (ran) revealMatch(view);
    return ran;
  };

export const findNextMatch = thenReveal(findNext);
export const findPreviousMatch = thenReveal(findPrevious);
const replaceMatch = thenReveal(replaceNext);

const panels = new WeakMap<EditorView, FindPanel>();

/** Open find, seeded with the selected text, and focus the find field. */
export function openFind(view: EditorView): boolean {
  openSearchPanel(view);
  return true;
}

/** Open find with the replace row shown and its field focused. */
export function openReplace(view: EditorView): boolean {
  if (view.state.readOnly) return openFind(view);
  openSearchPanel(view);
  panels.get(view)?.showReplace(true, true);
  return true;
}

const searchKeys: KeyBinding[] = [
  { key: 'Mod-f', run: openFind, scope: 'editor search-panel', preventDefault: true },
  { key: 'Mod-Alt-f', run: openReplace, scope: 'editor search-panel', preventDefault: true },
  { key: 'F3', run: findNextMatch, shift: findPreviousMatch, scope: 'editor search-panel', preventDefault: true },
  { key: 'Mod-g', run: findNextMatch, shift: findPreviousMatch, scope: 'editor search-panel', preventDefault: true },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
];

registerShortcutGroup({
  title: 'Find',
  items: [
    { key: 'Mod-f', label: 'Find' },
    { key: 'Mod-Alt-f', label: 'Find and replace' },
    { key: 'Mod-g', label: 'Next match' },
    { key: 'Mod-Shift-g', label: 'Previous match' },
  ],
});

/* ---- Panel --------------------------------------------------------------- */

const ICON = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function iconButton(name: string, label: string, icon: keyof typeof ICON, onClick: () => void): HTMLButtonElement {
  const btn = el('button', { type: 'button', name, class: 'sheaf-find-btn sheaf-find-icon', title: label, 'aria-label': label });
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    `stroke-linejoin="round" aria-hidden="true">${ICON[icon]}</svg>`;
  btn.addEventListener('click', onClick);
  return btn;
}

/** At most this many matches are counted; past it the count reads "1000+". */
const COUNT_LIMIT = 1000;

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private query: SearchQuery;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly replaceRow: HTMLElement;
  private readonly expand: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly toggles: { caseSensitive: HTMLButtonElement; wholeWord: HTMLButtonElement; regexp: HTMLButtonElement };

  constructor(private readonly view: EditorView) {
    panels.set(view, this);
    this.query = getSearchQuery(view.state);
    const commit = (): void => this.commit();

    this.searchField = el('input', {
      type: 'text',
      name: 'search',
      class: 'sheaf-find-input',
      placeholder: 'Find',
      'aria-label': 'Find',
      'main-field': 'true',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    this.searchField.value = this.query.search;
    this.searchField.addEventListener('input', commit);

    this.replaceField = el('input', {
      type: 'text',
      name: 'replace',
      class: 'sheaf-find-input',
      placeholder: 'Replace with',
      'aria-label': 'Replace with',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    this.replaceField.value = this.query.replace;
    this.replaceField.addEventListener('input', commit);

    const toggle = (name: string, text: string, label: string, on: boolean): HTMLButtonElement => {
      const btn = el('button', { type: 'button', name, class: 'sheaf-find-btn sheaf-find-toggle', title: label, 'aria-label': label }, text);
      btn.setAttribute('aria-pressed', String(on));
      btn.addEventListener('click', () => {
        btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
        commit();
      });
      return btn;
    };
    this.toggles = {
      caseSensitive: toggle('case', 'Aa', 'Match case', this.query.caseSensitive),
      wholeWord: toggle('word', 'ab', 'Match whole word', this.query.wholeWord),
      regexp: toggle('regexp', '.*', 'Use regular expression', this.query.regexp),
    };

    this.count = el('span', { class: 'sheaf-find-count', 'aria-live': 'polite' });

    this.expand = iconButton('toggleReplace', 'Show replace', 'chevron', () => this.showReplace(this.replaceRow.hidden, false));
    this.expand.classList.add('sheaf-find-expand');
    this.expand.setAttribute('aria-expanded', 'false');

    const textButton = (name: string, text: string, label: string, onClick: () => void): HTMLButtonElement => {
      const btn = el('button', { type: 'button', name, class: 'sheaf-find-btn sheaf-find-text', title: label }, text);
      btn.addEventListener('click', onClick);
      return btn;
    };

    const findRow = el(
      'div',
      { class: 'sheaf-find-row' },
      el('span', { class: 'sheaf-find-field' }, this.searchField, this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regexp),
      this.count,
      iconButton('prev', `Previous match (${hint('Shift-Enter')})`, 'up', () => findPreviousMatch(view)),
      iconButton('next', `Next match (${hint('Enter')})`, 'down', () => findNextMatch(view)),
      iconButton('close', `Close (${hint('Escape')})`, 'close', () => closeSearchPanel(view))
    );
    this.replaceRow = el(
      'div',
      { class: 'sheaf-find-row sheaf-find-replace' },
      el('span', { class: 'sheaf-find-field' }, this.replaceField),
      textButton('replace', 'Replace', `Replace this match (${hint('Enter')})`, () => replaceMatch(view)),
      textButton('replaceAll', 'Replace all', `Replace every match (${hint('Mod-Enter')})`, () => replaceAll(view))
    );
    this.replaceRow.hidden = true;

    const rows = el('div', { class: 'sheaf-find-rows' }, findRow, this.replaceRow);
    this.dom = el('div', { class: 'sheaf-find', role: 'search', 'aria-label': 'Find and replace' });
    if (!view.state.readOnly) this.dom.append(this.expand);
    this.dom.append(rows);
    this.dom.addEventListener('keydown', (e) => this.keydown(e));
    this.updateCount();
  }

  mount(): void {
    this.searchField.focus();
    this.searchField.select();
  }

  /** Show or hide the replace row; `focus` moves the caret into the replace field. */
  showReplace(show: boolean, focus: boolean): void {
    if (this.view.state.readOnly) return;
    this.replaceRow.hidden = !show;
    this.dom.classList.toggle('is-replacing', show);
    this.expand.setAttribute('aria-expanded', String(show));
    const label = show ? 'Hide replace' : 'Show replace';
    this.expand.title = label;
    this.expand.setAttribute('aria-label', label);
    if (show && focus) {
      this.replaceField.focus();
      this.replaceField.select();
    } else if (!show && this.dom.contains(document.activeElement)) {
      this.searchField.focus();
    }
  }

  private commit(): void {
    const regexp = this.toggles.regexp.getAttribute('aria-pressed') === 'true';
    const query = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.toggles.caseSensitive.getAttribute('aria-pressed') === 'true',
      wholeWord: this.toggles.wholeWord.getAttribute('aria-pressed') === 'true',
      regexp,
      // Without a regular expression, both fields mean exactly what was typed:
      // `C:\new` is a path, not "C:" and a line break. A regular expression keeps
      // `\n`, `\t` and `\\` as escapes, in the pattern and in the replacement.
      literal: !regexp,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private keydown(e: KeyboardEvent): void {
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault();
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.target === this.searchField) {
      e.preventDefault();
      (e.shiftKey ? findPreviousMatch : findNextMatch)(this.view);
    } else if (e.target === this.replaceField) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) replaceAll(this.view);
      else replaceMatch(this.view);
    }
  }

  update(update: ViewUpdate): void {
    let queryChanged = false;
    for (const tr of update.transactions) {
      for (const effect of tr.effects as readonly StateEffect<unknown>[]) {
        if (effect.is(setSearchQuery)) {
          queryChanged = true;
          if (!effect.value.eq(this.query)) this.setQuery(effect.value);
        }
      }
    }
    if (queryChanged || update.docChanged || update.selectionSet) this.updateCount();
  }

  private setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.toggles.caseSensitive.setAttribute('aria-pressed', String(query.caseSensitive));
    this.toggles.wholeWord.setAttribute('aria-pressed', String(query.wholeWord));
    this.toggles.regexp.setAttribute('aria-pressed', String(query.regexp));
  }

  /** "3 of 12", "No results", or nothing while the field is empty. */
  private updateCount(): void {
    const { query } = this;
    this.dom.classList.remove('is-empty-result', 'is-invalid');
    if (!query.search) {
      this.count.textContent = '';
      return;
    }
    if (!query.valid) {
      this.count.textContent = 'Invalid pattern';
      this.dom.classList.add('is-invalid');
      return;
    }
    const sel = this.view.state.selection.main;
    let total = 0;
    let current = 0;
    const cursor = query.getCursor(this.view.state);
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      total++;
      if (step.value.from === sel.from && step.value.to === sel.to) current = total;
      if (total >= COUNT_LIMIT) break;
    }
    if (!total) {
      this.count.textContent = 'No results';
      this.dom.classList.add('is-empty-result');
      return;
    }
    const of = total >= COUNT_LIMIT ? `${COUNT_LIMIT}+` : String(total);
    this.count.textContent = current ? `${current} of ${of}` : `${of} ${total === 1 ? 'match' : 'matches'}`;
  }
}

/** Find and replace: the search state, its panel at the top, and its keys. */
export const searchSupport: Extension = [
  // `literal` makes the query seeded from a selection match that text as written.
  search({ top: true, literal: true, createPanel: (view) => new FindPanel(view) }),
  keymap.of(searchKeys),
];
