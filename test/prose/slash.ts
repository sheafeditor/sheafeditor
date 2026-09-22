import { EditorState } from '@codemirror/state';
import { Scenario, Prose, mountProse } from '../harness';
import { SLASH_ITEMS, slashMenuOf } from '../../src/webview/blocks';

/** Type text at the caret one character at a time, as keyboard input arrives. */
function type(p: Prose, text: string): void {
  for (const ch of text) {
    const head = p.view.state.selection.main.head;
    p.view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: 'input.type' });
  }
}

const lineStart = (doc: string, n: number): number => EditorState.create({ doc }).doc.line(n).from;

/** Press Backspace `n` times through the editor's own key handling. */
function backspace(p: Prose, n: number): void {
  for (let i = 0; i < n; i++) p.press('Backspace');
}

/** The labels the open menu lists, or null when it is closed. */
function listed(p: Prose): string[] | null {
  const menu = slashMenuOf(p.view.state);
  return menu ? menu.items.map((i) => i.label) : null;
}

/** Type `typed` at the start of line `line` of `doc`, press Enter, and return the document. */
function pickAtLine(doc: string, line: number, typed: string): string {
  const p = mountProse(doc);
  p.select(lineStart(doc, line));
  type(p, typed);
  p.press('Enter');
  const out = p.doc();
  p.destroy();
  return out;
}

/** What a screen reader would announce for a row: its text with every hidden subtree left out. */
function accessibleName(el: Element): string {
  let name = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === node.TEXT_NODE) name += node.textContent ?? '';
    else if (node.nodeType === node.ELEMENT_NODE && (node as Element).getAttribute('aria-hidden') !== 'true') name += accessibleName(node as Element);
  }
  return name.trim();
}

/** Open the menu with a bare `/` and return its rows in listed order. */
function openRows(p: Prose): Element[] {
  type(p, '/');
  return Array.from(document.querySelectorAll('.sheaf-slash-item'));
}

/** Open the menu on an empty document, pick the item called `label`, and return what it wrote. */
function writtenBy(label: string): string {
  const p = mountProse('');
  type(p, '/');
  const index = slashMenuOf(p.view.state)!.items.findIndex((i) => i.label === label);
  for (let i = 0; i < index; i++) p.press('ArrowDown');
  p.press('Enter');
  const out = p.doc();
  p.destroy();
  return out;
}

export const scenarios: Scenario[] = [
  {
    name: 'every slash row draws an icon before its label, and a screen reader reads the row as the label alone',
    run: () => {
      const p = mountProse('');
      const rows = openRows(p);
      const listed = rows.length === SLASH_ITEMS.length;
      const drawn = rows.every((row) => {
        const slot = row.querySelector('.sheaf-slash-icon');
        const svg = slot?.firstElementChild;
        return (
          // The icon leads the row, so every label starts in the same column.
          row.firstElementChild === slot &&
          slot?.getAttribute('aria-hidden') === 'true' &&
          svg?.tagName.toLowerCase() === 'svg' &&
          svg.getAttribute('class') === 'sheaf-tb-icon' &&
          svg.getAttribute('aria-hidden') === 'true' &&
          // A geometry that never arrived would leave the shape empty or literally undefined.
          svg.childElementCount > 0 &&
          !svg.innerHTML.includes('undefined')
        );
      });
      const named = rows.every((row, i) => accessibleName(row) === SLASH_ITEMS[i].label);
      // Two commands that are different things do not share one shape.
      const shapes = new Set(rows.map((row) => row.querySelector('.sheaf-slash-icon')!.innerHTML));
      const distinct = shapes.size === new Set(SLASH_ITEMS.map((i) => i.icon)).size;
      p.destroy();
      return listed && drawn && named && distinct;
    },
  },
  {
    name: 'each slash row shows the Markdown its pick writes, and rows with no single spelling show none',
    run: () => {
      // On an empty document a pick writes its marker and nothing else, so the first
      // line left behind is the hint itself. A table is the one exception: its skeleton
      // comes with cells, and the hint is the pipe that fences every one of them.
      const truthful = SLASH_ITEMS.filter((item) => item.hint).every((item) => {
        const first = writtenBy(item.label).replace(/^\n+/, '').split('\n')[0];
        return item.id === 'table' ? first.startsWith(item.hint!) && first.endsWith(item.hint!) : first.trimEnd() === item.hint;
      });
      // Text writes no markup at all and the data table writes a fence with a language
      // on it, so neither carries a hint, and neither row grows an element for one.
      const bare = SLASH_ITEMS.filter((item) => !item.hint).map((item) => item.label).join('|') === 'Text|CSV data table';
      const p = mountProse('');
      const rows = openRows(p);
      const shown = rows.every((row, i) => {
        const item = SLASH_ITEMS[i];
        const hint = row.querySelector('.sheaf-slash-hint');
        // With no hint the row is icon and label alone, so its label still starts
        // in the same column as every other.
        if (!item.hint) return hint === null && row.children.length === 2;
        return hint !== null && hint.textContent === item.hint && hint.getAttribute('aria-hidden') === 'true' && row.lastElementChild === hint;
      });
      // The hint is decoration as much as the icon is.
      const named = rows.every((row, i) => accessibleName(row) === SLASH_ITEMS[i].label);
      p.destroy();

      // A hint is read, never matched. No label or keyword holds a pipe, so a pipe
      // typed after the slash matches nothing rather than pulling up the table rows.
      const q = mountProse('');
      type(q, '/|');
      const unmatched = listed(q)?.length === 0;
      q.destroy();
      return truthful && bare && shown && named && unmatched;
    },
  },
  {
    name: "a slash heading on a paragraph's middle line converts only that line",
    run: () => {
      const doc = 'first line of text\nsecond line of text';
      const p = mountProse(doc);
      p.select(lineStart(doc, 2));
      type(p, '/h2');
      const menu = slashMenuOf(p.view.state);
      const highlighted = menu?.items[menu.selected].label === 'Heading 2';
      p.press('Enter');
      const reported = p.doc() === 'first line of text\n## second line of text';
      p.destroy();
      return (
        highlighted &&
        reported &&
        pickAtLine('one  \ntwo\nthree', 2, '/h2') === 'one  \n## two\nthree' &&
        pickAtLine('one\ntwo\nthree', 3, '/h1') === 'one\ntwo\n# three' &&
        pickAtLine('one\ntwo', 1, '/h3') === '### one\ntwo'
      );
    },
  },
  {
    name: "slash list, quote, code and text picks on a paragraph's middle line convert only that line",
    run: () => {
      const doc = 'one  \ntwo\nthree';
      return (
        pickAtLine(doc, 2, '/bul') === 'one  \n- two\nthree' &&
        pickAtLine(doc, 2, '/numbered') === 'one  \n1. two\nthree' &&
        pickAtLine(doc, 2, '/task') === 'one  \n- [ ] two\nthree' &&
        pickAtLine(doc, 2, '/quote') === 'one  \n> two\nthree' &&
        pickAtLine(doc, 2, '/code') === 'one  \n```\ntwo\n```\nthree' &&
        pickAtLine(doc, 2, '/text') === doc &&
        pickAtLine(doc, 2, '/divider') === 'one  \ntwo\n\n---\n\nthree'
      );
    },
  },
  {
    name: 'a typo keeps the slash menu open and backspacing brings the list back',
    run: () => {
      // The menu stays through every letter of the typo, and comes back at the
      // first backspace that leaves a query the list matches again.
      const p = mountProse('');
      type(p, '/tabel');
      const typo = listed(p)?.length === 0 && p.doc() === '/tabel';
      backspace(p, 1);
      const stillNothing = listed(p)?.length === 0 && p.doc() === '/tabe';
      backspace(p, 1);
      // Both table items carry the word, and the first of them is the one Enter takes.
      const back = listed(p)?.join('|') === 'Table|CSV data table' && slashMenuOf(p.view.state)!.selected === 0 && p.doc() === '/tab';
      p.press('Enter');
      const picked = !p.doc().includes('/tab') && /\| Column 1 \| Column 2 \| Column 3 \|/.test(p.doc());
      p.destroy();

      // One keystroke in, one keystroke out.
      const q = mountProse('');
      type(q, '/tablee');
      backspace(q, 1);
      const oneBack = listed(q)?.join('|') === 'Table|CSV data table' && q.doc() === '/table';
      q.destroy();

      // A typo three letters deep still recovers, and the item Enter takes is the first one.
      const r = mountProse('');
      type(r, '/headnig');
      const far = listed(r)?.length === 0;
      backspace(r, 3);
      const headings = listed(r)?.join('|') === 'Heading 1|Heading 2|Heading 3|Heading 4|Heading 5|Heading 6' && r.doc() === '/head';
      r.press('Enter');
      const heading = r.doc() === '# ';
      r.destroy();
      return typo && stillNothing && back && picked && oneBack && far && headings && heading;
    },
  },
  {
    name: 'a slash query that matches nothing says so, and Tab and the arrow keys insert nothing',
    run: () => {
      const p = mountProse('');
      type(p, '/zzz');
      const menu = document.querySelector('.sheaf-slash-menu');
      const says = menu?.textContent === 'No matching blocks' && menu?.querySelector('.sheaf-slash-item') === null;
      const tab = p.press('Tab');
      const arrows = p.press('ArrowDown') && p.press('ArrowUp');
      const quiet = p.doc() === '/zzz' && listed(p)?.length === 0;
      // Enter is left to the document, so it breaks the line and the menu closes with it.
      p.press('Enter');
      const entered = p.doc() === '/zzz\n' && slashMenuOf(p.view.state) === null;
      p.destroy();
      return says && tab && arrows && quiet && entered;
    },
  },
  {
    name: 'a space, an over-long query and Escape still close the slash menu for good',
    run: () => {
      const closesForGood = (typed: string, keys: number): boolean => {
        const p = mountProse('');
        type(p, typed);
        const closed = slashMenuOf(p.view.state) === null;
        backspace(p, keys);
        const stayed = slashMenuOf(p.view.state) === null;
        p.destroy();
        return closed && stayed;
      };
      const p = mountProse('');
      type(p, '/hea');
      const escaped = p.press('Escape') && slashMenuOf(p.view.state) === null;
      backspace(p, 1);
      const stayedClosed = slashMenuOf(p.view.state) === null;
      p.destroy();
      return (
        // A space straight after the slash, a second space in the query, and a query past 40 characters.
        closesForGood('/ ', 1) &&
        closesForGood('/a  ', 2) &&
        closesForGood(`/${'x'.repeat(41)}`, 2) &&
        escaped &&
        stayedClosed
      );
    },
  },
];
