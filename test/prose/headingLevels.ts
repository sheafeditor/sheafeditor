/*
 * Heading levels 1 to 6, across the model the Turn into surfaces read.
 *
 * Markdown allows six levels and Sheaf reads all six, so what a line already is
 * and what it can be set to have to be the same list. These scenarios hold both
 * halves: the level a block reports, and the source that setting a level writes.
 */

import { EditorState } from '@codemirror/state';
import { Prose, Scenario, mountProse } from '../harness';
import { BlockKind, TurnIntoKind, blockRangeAt, convertText, currentTurnInto } from '../../src/webview/blockModel';
import { blockMenuItems } from '../../src/webview/blockHandle';
import { ContextMenuDeps, mountContextMenu } from '../../src/webview/contextmenu';
import { SLASH_ITEMS } from '../../src/webview/slashMenu';
import { BlockKind as LineKind, mountToolbar, refreshToolbar, turnInto } from '../../src/webview/toolbar';

const G: any = globalThis;

const LEVELS = [1, 2, 3, 4, 5, 6] as const;

const atx = (level: number, text = 'Configuration'): string => '#'.repeat(level) + ' ' + text;

/** The source `text` (a `kind` block) becomes when it is turned into `into`; unchanged when the pick is a no-op. */
const setTo = (text: string, kind: BlockKind | null, into: TurnIntoKind): string => convertText(text, kind, into, 0)?.text ?? text;

const lineStart = (doc: string, n: number): number => EditorState.create({ doc }).doc.line(n).from;

/** Type text at the caret one character at a time, as keyboard input arrives. */
function type(p: Prose, text: string): void {
  for (const ch of text) {
    const head = p.view.state.selection.main.head;
    p.view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: 'input.type' });
  }
}

/** Put the caret at `at`, run the toolbar's Turn into for `kind`, and return the document. */
function turnAt(doc: string, at: number, kind: LineKind): string {
  const p = mountProse(doc);
  p.select(at);
  turnInto(p.view, kind);
  const out = p.doc();
  p.destroy();
  return out;
}

/** The formatting toolbar over `p`, reflecting the caret it has now. */
function mountBar(p: Prose): { menu: HTMLElement; label: string; remove: () => void } {
  const bar = document.createElement('div');
  bar.className = 'sheaf-toolbar';
  document.body.appendChild(bar);
  mountToolbar(bar, () => p.view, () => {}, () => {}, () => false, false, () => {}, false);
  refreshToolbar(p.view);
  const trigger = bar.querySelector<HTMLElement>('[data-command="heading"]')!;
  return {
    menu: trigger.parentElement!.querySelector<HTMLElement>('.sheaf-tb-menu')!,
    label: trigger.querySelector('.sheaf-tb-dd-label')!.textContent ?? '',
    remove: () => bar.remove(),
  };
}

/** The right-click menu's Turn into submenu, opened over the caret in `p`. */
function turnIntoSubmenu(p: Prose, extra: Partial<ContextMenuDeps> = {}): { items: HTMLButtonElement[]; close: () => void } {
  document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
  mountContextMenu(p.view.dom, { getView: () => p.view, getFileName: () => 'doc.md', copyToClipboard: () => {}, ...extra });
  p.view.contentDOM.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }));
  const all = (): HTMLButtonElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu')).flatMap((m) => Array.from(m.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-item')));
  all().find((b) => b.querySelector('span')!.textContent === 'Turn into')!.click();
  return {
    items: Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-submenu')).flatMap((m) => Array.from(m.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-item'))),
    close: () => document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove()),
  };
}

/** The label of the one checked item in `items`, or how many were checked when it is not exactly one. */
function checkedLabel(items: Element[]): string {
  const on = items.filter((el) => el.getAttribute('aria-checked') === 'true');
  return on.length === 1 ? (on[0].querySelector('span')!.textContent ?? '') : `${on.length} checked`;
}

const labelsOf = (items: Element[]): string[] => items.map((el) => el.querySelector('span')!.textContent ?? '');

export const scenarios: Scenario[] = [
  {
    name: 'a heading reports the level it is written at, for every level Markdown allows',
    run: () =>
      LEVELS.every((n) => currentTurnInto(atx(n), 'heading') === `h${n}`) &&
      // Seven hashes are not a heading in Markdown, and a bare paragraph is not one either.
      currentTurnInto('####### Configuration', 'paragraph') === 'text' &&
      currentTurnInto('Configuration', 'paragraph') === 'text',
  },
  {
    name: 'a heading underlined with === or --- reports the level the underline gives it',
    run: () =>
      currentTurnInto('Configuration\n=============', 'heading') === 'h1' &&
      currentTurnInto('Configuration\n-------------', 'heading') === 'h2' &&
      // The same two lines outside a heading are a paragraph and a divider, and neither is a heading.
      currentTurnInto('Configuration', 'paragraph') === 'text',
  },
  {
    name: 'a deep heading inside a quote or a list item is still the quote or the item it sits in',
    run: () => currentTurnInto('> #### Deep', 'quote') === 'quote' && currentTurnInto('- #### Deep', 'item') === 'bullet',
  },
  {
    name: 'every heading level can be set from every other level and from body text',
    run: () => {
      const fromHeading = LEVELS.every((from) =>
        LEVELS.every((to) => setTo(atx(from), 'heading', `h${to}` as TurnIntoKind) === atx(to))
      );
      const fromText = LEVELS.every((to) => setTo('Configuration', 'paragraph', `h${to}` as TurnIntoKind) === atx(to));
      const backToText = LEVELS.every((from) => setTo(atx(from), 'heading', 'text') === 'Configuration');
      return fromHeading && fromText && backToText;
    },
  },
  {
    name: 'setting a level on an underlined heading writes the hashes and takes the underline away',
    run: () =>
      setTo('Configuration\n=============', 'heading', 'h4') === atx(4) &&
      setTo('Configuration\n-------------', 'heading', 'h6') === atx(6) &&
      // The level it already is leaves the underline alone, the way the toolbar does.
      setTo('Configuration\n=============', 'heading', 'h1') === 'Configuration\n=============',
  },
  {
    name: 'the toolbar sets every heading level from every other level and from body text',
    run: () => {
      const kinds: LineKind[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
      const fromHeading = LEVELS.every((from) => kinds.every((to) => turnAt(atx(from), 3, to) === atx(Number(to[1]))));
      const fromText = kinds.every((to) => turnAt('Configuration', 3, to) === atx(Number(to[1])));
      const backToText = LEVELS.every((from) => turnAt(atx(from), from + 2, 'text') === 'Configuration');
      return fromHeading && fromText && backToText;
    },
  },
  {
    name: 'the Text style menu offers six levels and checks the one the caret is on',
    run: () => {
      const seen = LEVELS.map((n) => {
        const p = mountProse(atx(n));
        p.select(n + 3);
        const bar = mountBar(p);
        const items = Array.from(bar.menu.querySelectorAll('.sheaf-tb-menu-item'));
        const offered = labelsOf(items).join('|');
        const out = `${bar.label}/${checkedLabel(items)}/${offered}`;
        bar.remove();
        p.destroy();
        return out;
      });
      const offered = 'Text|Heading 1|Heading 2|Heading 3|Heading 4|Heading 5|Heading 6';
      return seen.join(' ') === LEVELS.map((n) => `H${n}/Heading ${n}/${offered}`).join(' ');
    },
  },
  {
    name: 'the selection toolbar names the level it is on and offers the other five',
    run: () => {
      const seen = LEVELS.map((n) => {
        const doc = atx(n);
        const p = mountProse(doc);
        p.select(n + 1, doc.length);
        const bar = p.view.dom.querySelector<HTMLElement>('.sheaf-seltb')!;
        const items = Array.from(bar.querySelectorAll('.sheaf-tb-menu-item'));
        const trigger = bar.querySelector('.sheaf-seltb-trigger-label')!.textContent ?? '';
        const out = `${trigger}/${checkedLabel(items)}/${labelsOf(items).filter((l) => l.startsWith('Heading')).join('|')}`;
        p.destroy();
        return out;
      });
      const offered = 'Heading 1|Heading 2|Heading 3|Heading 4|Heading 5|Heading 6';
      return seen.join(' ') === LEVELS.map((n) => `Heading ${n}/Heading ${n}/${offered}`).join(' ');
    },
  },
  {
    name: 'the right-click menu checks the level the click landed on, and writes the level that is picked',
    run: () => {
      const seen = LEVELS.map((n) => {
        const p = mountProse(atx(n));
        p.select(n + 3);
        const m = turnIntoSubmenu(p);
        const out = `${checkedLabel(m.items)}/${labelsOf(m.items).filter((l) => l.startsWith('Heading')).join('|')}`;
        m.close();
        p.destroy();
        return out;
      });
      const picked = mountProse(atx(2));
      picked.select(5);
      const m = turnIntoSubmenu(picked);
      m.items.find((b) => b.querySelector('span')!.textContent === 'Heading 5')!.click();
      const wrote = picked.doc();
      m.close();
      picked.destroy();
      const offered = 'Heading 1|Heading 2|Heading 3|Heading 4|Heading 5|Heading 6';
      return seen.join(' ') === LEVELS.map((n) => `Heading ${n}/${offered}`).join(' ') && wrote === atx(5);
    },
  },
  {
    name: 'the block handle menu marks the level of the block it grips, with a rule above Heading 4',
    run: () => {
      const seen = LEVELS.map((n) => {
        const p = mountProse(atx(n));
        const items = blockMenuItems(p.view, blockRangeAt(p.view.state, 0)!);
        const turn = items.find((i) => i.label === 'Turn into')!.children!;
        const current = turn.filter((c) => c.current).map((c) => c.label);
        const ruled = turn.filter((c) => c.separator).map((c) => c.label);
        p.destroy();
        return `${current.join('+')}/${ruled.join('+')}/${turn.filter((c) => c.label.startsWith('Heading')).length}`;
      });
      return seen.join(' ') === LEVELS.map((n) => `Heading ${n}/Heading 4/6`).join(' ');
    },
  },
  {
    name: 'the slash menu writes the right number of hashes for every heading level',
    run: () => {
      const pick = (typed: string): string => {
        const p = mountProse('');
        type(p, typed);
        p.press('Enter');
        const out = p.doc();
        p.destroy();
        return out;
      };
      const written = LEVELS.every((n) => pick(`/h${n}`) === '#'.repeat(n) + ' ');
      // The hint on each row is the marker the pick writes, so reading the menu teaches the syntax.
      const hints = LEVELS.map((n) => SLASH_ITEMS.find((i) => i.id === `h${n}`)!.hint).join('|');
      return written && hints === '#|##|###|####|#####|######';
    },
  },
  {
    name: 'a deep heading inside a quote or a list item keeps its container when its level changes',
    run: () => {
      const quoted = turnAt('> #### Deep', 6, 'h6') === '> ###### Deep';
      const item = turnAt('- Item\n\n  #### Deep\n', lineStart('- Item\n\n  #### Deep\n', 3) + 6, 'h6') === '- Item\n\n  ###### Deep\n';
      // The slash menu takes the same line through its own path, which has to write the container's prefix back.
      const doc = '> First line\n> #### Deep\n';
      const p = mountProse(doc);
      p.select(lineStart(doc, 2) + 2);
      type(p, '/h5');
      p.press('Enter');
      const slashed = p.doc() === '> First line\n> ##### Deep\n';
      p.destroy();
      return quoted && item && slashed;
    },
  },
];
