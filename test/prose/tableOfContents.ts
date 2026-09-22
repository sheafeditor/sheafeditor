/*
 * The list of the document's headings, and the rail that shows it.
 *
 * Two things are held here. The first is what counts as a heading and how it reads: a
 * `#` line inside a fenced block or an HTML block is code, the `---` closing YAML front
 * matter is not the underline of a heading called `tags: [spec]`, and a heading written
 * with bold and a link reads as its words rather than its spelling.
 *
 * The second is what the rail does with that list: it appears only when the setting says
 * so, it says when a document has no headings rather than standing there empty, an entry
 * moves the caret without touching the file, and it can be worked from the keyboard.
 *
 * What is NOT here is everything that needs a layout engine, because jsdom has none:
 * where the rail sits, whether the text column moved, the panel that slides in over a
 * narrow pane, which heading the scroll position marks, and smooth scrolling. Those are
 * checked in a real window.
 */

import { Scenario, mountProse } from '../harness';
import { EditorSelection } from '@codemirror/state';
import { undoDepth } from '@codemirror/commands';
import { createTableOfContents, documentHeadings, TableOfContents } from '../../src/webview/tableOfContents';
import { mountToolbar } from '../../src/webview/toolbar';

/** A document in a page with the rail beside it, turned on unless `on` says otherwise. */
function mountToc(doc: string, on = true): {
  view: ReturnType<typeof mountProse>;
  toc: TableOfContents;
  nav: HTMLElement;
  entries: () => HTMLAnchorElement[];
  texts: () => string[];
  remove: () => void;
} {
  const view = mountProse(doc);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const toc = createTableOfContents(host, () => view.view);
  toc.attach(view.view);
  toc.setEnabled(on);
  const entries = (): HTMLAnchorElement[] => Array.from(toc.el.querySelectorAll<HTMLAnchorElement>('.sheaf-toc-entry'));
  return {
    view,
    toc,
    nav: toc.el,
    entries,
    texts: () => entries().map((e) => e.textContent ?? ''),
    remove: () => {
      toc.destroy();
      host.remove();
      view.destroy();
    },
  };
}

/** Let a frame pass, which is when the rail rebuilds after an edit. */
const frame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The level of each entry, read back off the tree items. */
const levels = (entries: HTMLAnchorElement[]): string[] => entries.map((e) => e.getAttribute('aria-level') ?? '');

const SPEC = [
  '---',
  'title: Wren 4',
  'tags: [spec, draft]',
  '---',
  '',
  '# Wren 4',
  '',
  'An opening paragraph.',
  '',
  '## Scope',
  '',
  '```sh',
  '# not a heading, a shell comment',
  '```',
  '',
  '## Interfaces',
  '',
  '### Hazard flags',
  '',
  'Closing words.',
  '',
].join('\n');

/**
 * A document long enough that the editor's own parse stops short of the end of it.
 *
 * CodeMirror parses lazily, and the list of headings asks for the rest of the document
 * so that the last heading in a long file is still listed. That leaves two trees in
 * play, the one the editor has and the one the list asked for, and a heading read from
 * one of them against the other is a heading whose markers nothing accounts for.
 */
const LONG = ['# Handbook', '', 'An opening paragraph.', '', '## Stores', '']
  .concat(Array.from({ length: 4000 }, (_, i) => `Line ${i} of the stores section, with enough words on it to be worth parsing.\n`))
  .concat(['', '## Maintenance', ''])
  .concat(Array.from({ length: 4000 }, (_, i) => `Line ${i} of the maintenance section, with enough words to be worth parsing.\n`))
  .concat(['', '### Drones', '', 'One line about drones.', ''])
  .join('\n');

export const scenarios: Scenario[] = [
  {
    name: 'a heading past the end of the parsed region is listed without its hashes',
    run: () => {
      const p = mountProse(LONG);
      const listed = documentHeadings(p.view.state);
      p.destroy();
      return (
        listed.length === 4 &&
        listed.map((h) => h.text).join('|') === 'Handbook|Stores|Maintenance|Drones' &&
        !listed.some((h) => h.text.startsWith('#'))
      );
    },
  },
  {
    name: 'the caret for a heading past the parsed region still lands on its text, not its hashes',
    run: () => {
      const p = mountProse(LONG);
      const last = documentHeadings(p.view.state)[3];
      const ok = p.doc().slice(last.textFrom, last.textFrom + 6) === 'Drones';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a heading the parser did resolve keeps a hash that is its own text',
    run: () => {
      // The floor that strips an unaccounted-for marker must not reach a heading whose
      // words happen to be a hash: `# # C` is a heading reading "# C".
      const t = mountToc('# # C\n\n## #hashtag\n');
      const ok = t.texts().join('|') === '# C|#hashtag';
      t.remove();
      return ok;
    },
  },
  {
    name: 'front matter and a fenced # line are not headings',
    run: () => {
      const t = mountToc(SPEC);
      const ok = t.texts().join('|') === 'Wren 4|Scope|Interfaces|Hazard flags' && levels(t.entries()).join('') === '1223';
      t.remove();
      return ok;
    },
  },
  {
    name: 'a hash line inside an HTML block is part of the HTML, not a heading',
    run: () => {
      const t = mountToc('# Real\n\n<div>\n# not a heading, a CSS id\n</div>\n\n## Also real\n');
      const ok = t.texts().join('|') === 'Real|Also real';
      t.remove();
      return ok;
    },
  },
  {
    name: 'headings written with underlines are listed at their own levels',
    run: () => {
      const t = mountToc('Title\n=====\n\nSection\n-------\n\nWords.\n');
      const ok = t.texts().join('|') === 'Title|Section' && levels(t.entries()).join('') === '12';
      t.remove();
      return ok;
    },
  },
  {
    name: 'an entry reads the heading as it is rendered, not as it is written',
    run: () => {
      const t = mountToc('## **Pricing** and [plans](x)\n\n## `code` and ~~gone~~ and ==lit==\n\n## Closed heading ###\n');
      const ok = t.texts().join('|') === 'Pricing and plans|code and gone and lit|Closed heading';
      t.remove();
      return ok;
    },
  },
  {
    name: 'brackets that are not a link stay in the entry as they read on the page',
    run: () => {
      const t = mountToc('## Footnote [1] and [a link][ref]\n\n[ref]: https://example.com\n');
      const ok = t.texts().join('|') === 'Footnote [1] and a link';
      t.remove();
      return ok;
    },
  },
  {
    name: 'the full heading is in the tooltip, so one cut short on its line is still readable',
    run: () => {
      const long = 'A heading long enough that it will not fit on one line of a 220px rail, by some margin';
      const t = mountToc(`## ${long}\n`);
      const ok = t.entries()[0].title === long && t.entries()[0].textContent === long;
      t.remove();
      return ok;
    },
  },
  {
    name: 'H4 and below are left out',
    run: () => {
      const t = mountToc('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n');
      const ok = t.texts().join('|') === 'One|Two|Three';
      t.remove();
      return ok;
    },
  },
  {
    name: 'with the setting off there is no rail at all',
    run: () => {
      const t = mountToc(SPEC, false);
      const ok = t.nav.hidden && t.entries().length === 0;
      t.remove();
      return ok;
    },
  },
  {
    name: 'turning the setting on shows the rail with the document in it',
    run: () => {
      const t = mountToc(SPEC, false);
      const before = t.nav.hidden;
      t.toc.setEnabled(true);
      const ok = before && !t.nav.hidden && t.entries().length === 4;
      t.remove();
      return ok;
    },
  },
  {
    name: 'a document with no headings says so rather than showing an empty rail',
    run: () => {
      const t = mountToc('Just some words.\n\nAnd some more.\n');
      const empty = t.nav.querySelector('.sheaf-toc-empty') as HTMLElement;
      const ok = !t.nav.hidden && t.entries().length === 0 && !empty.hidden && empty.textContent === 'No headings yet';
      t.remove();
      return ok;
    },
  },
  {
    name: 'the message goes as soon as the document has a heading',
    run: async () => {
      const t = mountToc('Just some words.\n');
      const empty = t.nav.querySelector('.sheaf-toc-empty') as HTMLElement;
      t.view.view.dispatch({ changes: { from: 0, insert: '## First\n\n' } });
      t.toc.documentChanged();
      await frame();
      const ok = empty.hidden && t.texts().join('|') === 'First';
      t.remove();
      return ok;
    },
  },
  {
    name: 'typing a new heading adds an entry on the next frame',
    run: async () => {
      const t = mountToc('# One\n\nWords.\n');
      const before = t.entries().length;
      t.view.view.dispatch({ changes: { from: t.view.doc().length, insert: '\n## Two\n' } });
      t.toc.documentChanged();
      const duringTheSameTick = t.entries().length;
      await frame();
      const ok = before === 1 && duringTheSameTick === 1 && t.texts().join('|') === 'One|Two';
      t.remove();
      return ok;
    },
  },
  {
    name: 'deleting a heading removes its entry',
    run: async () => {
      const t = mountToc('# One\n\n## Two\n\n## Three\n');
      const at = t.view.doc().indexOf('## Two');
      t.view.view.dispatch({ changes: { from: at, to: at + '## Two\n\n'.length } });
      t.toc.documentChanged();
      await frame();
      const ok = t.texts().join('|') === 'One|Three';
      t.remove();
      return ok;
    },
  },
  {
    name: 'picking an entry puts the caret at the start of that heading’s text',
    run: () => {
      const t = mountToc(SPEC);
      t.view.select(0);
      t.entries()[3].click();
      const caret = t.view.view.state.selection.main.head;
      const ok = t.view.doc().slice(caret, caret + 12) === 'Hazard flags';
      t.remove();
      return ok;
    },
  },
  {
    name: 'picking an entry writes nothing and leaves undo where it was',
    run: () => {
      const t = mountToc('# One\n\n## Two\n');
      // One real edit first, so there is something in the history to take back.
      t.view.view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
      const text = t.view.doc();
      const depth = undoDepth(t.view.view.state);
      t.entries()[1].click();
      const ok = t.view.doc() === text && undoDepth(t.view.view.state) === depth && depth > 0;
      t.remove();
      return ok;
    },
  },
  {
    name: 'the rail is a navigation landmark holding a tree of headings',
    run: () => {
      const t = mountToc(SPEC);
      const ok =
        t.nav.tagName === 'NAV' &&
        t.nav.getAttribute('aria-label') === 'Table of contents' &&
        (t.nav.querySelector('.sheaf-toc-list') as HTMLElement).getAttribute('role') === 'tree' &&
        t.entries().every((e) => e.getAttribute('role') === 'treeitem');
      t.remove();
      return ok;
    },
  },
  {
    name: 'the rail is one tab stop, and the arrows move between its entries',
    run: () => {
      const t = mountToc(SPEC);
      const stops = () => t.entries().filter((e) => e.tabIndex === 0).length;
      const one = stops() === 1;
      t.entries()[0].focus();
      t.entries()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      const moved = document.activeElement === t.entries()[1];
      t.entries()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      const back = document.activeElement === t.entries()[0];
      const ok = one && moved && back && stops() === 1;
      t.remove();
      return ok;
    },
  },
  {
    name: 'Enter on an entry goes to its heading, and Escape puts focus back in the text',
    run: () => {
      const t = mountToc(SPEC);
      t.view.select(0);
      t.entries()[1].focus();
      t.entries()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const caret = t.view.view.state.selection.main.head;
      const jumped = t.view.doc().slice(caret, caret + 5) === 'Scope';
      t.entries()[1].focus();
      t.entries()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const returned = t.view.view.hasFocus || document.activeElement === t.view.view.contentDOM;
      t.remove();
      return jumped && returned;
    },
  },
  {
    name: 'the heading list is the same whether or not a rail is showing it',
    run: () => {
      const p = mountProse(SPEC);
      const listed = documentHeadings(p.view.state).map((h) => `${h.level}:${h.text}`);
      p.destroy();
      return listed.join('|') === '1:Wren 4|2:Scope|2:Interfaces|3:Hazard flags';
    },
  },
  {
    name: 'a heading entry is where the caret goes, and its line is what the view scrolls to',
    run: () => {
      const p = mountProse('# One\n\n## Two words\n');
      const second = documentHeadings(p.view.state)[1];
      const ok =
        p.doc().slice(second.from, second.from + 3) === '## ' && p.doc().slice(second.textFrom, second.textFrom + 3) === 'Two';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the toolbar offers a table-of-contents toggle, unpressed until the setting is on',
    run: () => {
      const p = mountProse('# One\n');
      const bar = document.createElement('div');
      document.body.appendChild(bar);
      let pressed = 0;
      mountToolbar(bar, () => p.view, () => {}, () => {}, () => false, false, () => pressed++, false);
      const btn = bar.querySelector<HTMLButtonElement>('[aria-label="Table of contents"]')!;
      const off = btn.getAttribute('aria-pressed') === 'false' && !btn.classList.contains('is-active');
      btn.click();
      const ok = off && pressed === 1;
      bar.remove();
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the toolbar draws the toggle as pressed when the setting is on',
    run: () => {
      const p = mountProse('# One\n');
      const bar = document.createElement('div');
      document.body.appendChild(bar);
      mountToolbar(bar, () => p.view, () => {}, () => {}, () => false, false, () => {}, true);
      const btn = bar.querySelector<HTMLButtonElement>('[aria-label="Table of contents"]')!;
      const ok = btn.getAttribute('aria-pressed') === 'true' && btn.classList.contains('is-active');
      bar.remove();
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a selection somewhere else is replaced by the caret at the heading, not extended to it',
    run: () => {
      const t = mountToc('# One\n\nSome words here.\n\n## Two\n');
      t.view.view.dispatch({ selection: EditorSelection.single(8, 16) });
      t.entries()[1].click();
      const sel = t.view.view.state.selection.main;
      const ok = sel.empty && t.view.doc().slice(sel.head, sel.head + 3) === 'Two';
      t.remove();
      return ok;
    },
  },
];
