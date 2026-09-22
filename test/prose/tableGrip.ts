/*
 * The block grip beside rendered tables. jsdom has no layout, so these hover by
 * dispatching mousemove on the element under the pointer (a cell, a header, the
 * margin beside the grid) and read what the handle then offers: whether it is
 * shown, what its block menu holds, and what its menu and drag do to the text.
 * Heights come from CodeMirror's estimates, which is enough to find the block a
 * margin hover or a drag lands on.
 */

import { Scenario, Prose, mountProse } from '../harness';

const G: any = globalThis;

const TABLE = '| Name | Role |\n| --- | --- |\n| Ada | Eng |';
const DOC = `Move me please.\n\n${TABLE}\n\nEnd line.`;
const CSV = '```csv\nname,role\nAda,Eng\n```';
const CSV_DOC = `Move me please.\n\n${CSV}\n\nEnd line.`;

/** Let the handle's measure pass (requestAnimationFrame is a timeout here) run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const handleOf = (p: Prose): HTMLElement => p.view.scrollDOM.querySelector('.sheaf-block-handle') as HTMLElement;
const gripOf = (p: Prose): HTMLElement => p.view.scrollDOM.querySelector('.sheaf-block-grip') as HTMLElement;
const tableOf = (p: Prose): HTMLElement | null => p.view.contentDOM.querySelector('.sheaf-table');

function mouse(el: Element, type: string, init: Record<string, unknown> = {}): MouseEvent {
  const event = new G.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
}

/** A viewport y inside the block that starts at `pos`, from the editor's height map. */
function yAt(p: Prose, pos: number): number {
  const block = p.view.lineBlockAt(pos);
  return p.view.documentTop + block.top + Math.min(4, block.height / 2);
}

async function hover(p: Prose, el: Element, clientY: number): Promise<boolean> {
  await settle();
  mouse(el, 'mousemove', { clientX: 10, clientY });
  await settle();
  return !handleOf(p).hidden;
}

/** Click the grip (a press without movement) and return the open block menu's labels. */
function openMenu(p: Prose): string[] {
  const grip = gripOf(p);
  mouse(grip, 'pointerdown', { clientY: 5 });
  mouse(grip, 'pointerup', { clientY: 5 });
  const menu = document.querySelector('.sheaf-block-menu');
  return menu ? Array.from(menu.querySelectorAll('.sheaf-block-menu-item')).map((b) => b.textContent?.replace(/[›⌥⌃⇧⌘].*$|Alt.*$/, '').trim() ?? '') : [];
}

function clickItem(label: string): boolean {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.sheaf-block-menu-item')).find((b) =>
    b.textContent?.startsWith(label)
  );
  btn?.click();
  return !!btn;
}

function closeMenus(): void {
  for (const m of Array.from(document.querySelectorAll('.sheaf-block-menu'))) m.remove();
}

export const scenarios: Scenario[] = [
  {
    name: 'hovering a paragraph shows the block grip',
    run: async () => {
      const p = mountProse(DOC);
      const shown = await hover(p, p.view.contentDOM.querySelector('.cm-line')!, yAt(p, 0));
      p.destroy();
      return shown;
    },
  },
  {
    name: 'hovering a table cell shows the block grip',
    run: async () => {
      const p = mountProse(DOC);
      const cell = tableOf(p)?.querySelector('tbody td:not(.sheaf-table-gutter)');
      const shown = !!cell && (await hover(p, cell, yAt(p, DOC.indexOf('|'))));
      p.destroy();
      return shown;
    },
  },
  {
    name: 'hovering a table header row shows the block grip',
    run: async () => {
      const p = mountProse(DOC);
      const th = tableOf(p)?.querySelector('thead th');
      const shown = !!th && (await hover(p, th, yAt(p, DOC.indexOf('|'))));
      p.destroy();
      return shown;
    },
  },
  {
    name: 'hovering the margin beside a table shows the block grip',
    run: async () => {
      const p = mountProse(DOC);
      const rendered = !!tableOf(p);
      const shown = await hover(p, p.view.scrollDOM, yAt(p, DOC.indexOf('|')));
      p.destroy();
      return rendered && shown;
    },
  },
  {
    name: 'the grip beside a table offers the block menu and moves, duplicates and deletes the whole table',
    run: async () => {
      const act = async (label: string): Promise<{ labels: string[]; doc: string }> => {
        const p = mountProse(DOC);
        const cell = tableOf(p)?.querySelector('tbody td:not(.sheaf-table-gutter)');
        if (!cell || !(await hover(p, cell, yAt(p, DOC.indexOf('|'))))) {
          p.destroy();
          return { labels: [], doc: '' };
        }
        const labels = openMenu(p);
        clickItem(label);
        const doc = p.doc();
        closeMenus();
        p.destroy();
        return { labels, doc };
      };
      const up = await act('Move up');
      const down = await act('Move down');
      const dup = await act('Duplicate');
      const del = await act('Delete');
      const offers = ['Duplicate', 'Move up', 'Move down', 'Delete'].every((l) => up.labels.includes(l)) && !up.labels.includes('Turn into');
      return (
        offers &&
        up.doc === `${TABLE}\n\nMove me please.\n\nEnd line.` &&
        down.doc === `Move me please.\n\nEnd line.\n\n${TABLE}` &&
        dup.doc === `Move me please.\n\n${TABLE}\n\n${TABLE}\n\nEnd line.` &&
        del.doc === 'Move me please.\n\nEnd line.'
      );
    },
  },
  {
    name: 'dragging the grip beside a table carries every table line intact',
    run: async () => {
      const p = mountProse(DOC);
      const cell = tableOf(p)?.querySelector('tbody td:not(.sheaf-table-gutter)');
      const shown = !!cell && (await hover(p, cell, yAt(p, DOC.indexOf('|'))));
      const grip = gripOf(p);
      const start = yAt(p, DOC.indexOf('|'));
      const end = p.view.documentTop + p.view.lineBlockAt(p.view.state.doc.length).bottom + 20;
      mouse(grip, 'pointerdown', { clientY: start });
      mouse(grip, 'pointermove', { clientY: start + 10, buttons: 1 });
      mouse(grip, 'pointermove', { clientY: end, buttons: 1 });
      mouse(grip, 'pointerup', { clientY: end });
      const doc = p.doc();
      p.destroy();
      return shown && doc === `Move me please.\n\nEnd line.\n\n${TABLE}`;
    },
  },
  {
    name: 'a csv data block gets the block grip and its menu moves the whole fenced block',
    run: async () => {
      const p = mountProse(CSV_DOC);
      const cell = tableOf(p)?.querySelector('tbody td:not(.sheaf-table-gutter)');
      const shown = !!cell && (await hover(p, cell, yAt(p, CSV_DOC.indexOf('```'))));
      const labels = shown ? openMenu(p) : [];
      const moved = labels.includes('Move up') && clickItem('Move up');
      const doc = p.doc();
      closeMenus();
      p.destroy();
      return shown && moved && doc === `${CSV}\n\nMove me please.\n\nEnd line.`;
    },
  },
  {
    name: 'hovering inside a table leaves cell selection and editing to the grid',
    run: async () => {
      const p = mountProse(DOC);
      const table = tableOf(p);
      const cells = table ? Array.from(table.querySelectorAll('tbody td:not(.sheaf-table-gutter)')) : [];
      if (cells.length < 2) {
        p.destroy();
        return false;
      }
      const y = yAt(p, DOC.indexOf('|'));
      mouse(cells[0], 'mousedown', { clientY: y });
      mouse(document.body, 'mouseup', { clientY: y });
      const selected = cells[0].classList.contains('is-focus') || cells[0].classList.contains('is-sel');
      const move = mouse(cells[1], 'mousemove', { clientX: 10, clientY: y });
      await settle();
      const shown = !handleOf(p).hidden;
      const stillSelected = cells[0].classList.contains('is-focus') || cells[0].classList.contains('is-sel');
      const sameTable = tableOf(p) === table;
      mouse(cells[1], 'dblclick', { clientY: y });
      const editing = !!cells[1].querySelector('.sheaf-table-input');
      const untouched = p.doc() === DOC;
      p.destroy();
      return selected && shown && !move.defaultPrevented && stillSelected && sameTable && editing && untouched;
    },
  },
];
