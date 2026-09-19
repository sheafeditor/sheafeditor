import { Scenario, mountProse, Prose } from '../harness';
import { mountToolbar } from '../../src/webview/toolbar';

/** Mount the top formatting toolbar against `p`. */
const mountBar = (p: Prose): HTMLElement => {
  const bar = document.createElement('div');
  document.body.appendChild(bar);
  mountToolbar(bar, () => p.view, () => {}, () => {}, () => false, false);
  return bar;
};

/** Click a toolbar button by its command name. */
const click = (bar: HTMLElement, cmd: string): void => bar.querySelector<HTMLButtonElement>(`[data-command="${cmd}"]`)!.click();

export const scenarios: Scenario[] = [
  {
    name: 'Link and Mod-k with the caret inside a link remove the link instead of nesting a second one',
    run: () => {
      const doc = 'Go to [the site](https://x.io) now';
      const caret = doc.indexOf('site') + 2;

      const a = mountProse(doc);
      const bar = mountBar(a);
      a.select(caret);
      click(bar, 'link');
      const button = a.doc();
      a.destroy();
      bar.remove();

      const b = mountProse(doc);
      b.select(caret);
      const handled = b.press('Mod-k');
      const key = b.doc();
      b.destroy();

      return button === 'Go to the site now' && handled && key === 'Go to the site now';
    },
  },
  {
    name: 'Link over a selection spanning two paragraphs links each paragraph on its own',
    run: () => {
      const doc = 'First words\n\nSecond words';
      const end = doc.indexOf('Second words') + 'Second word'.length;

      const a = mountProse(doc);
      const bar = mountBar(a);
      a.select(0, end);
      click(bar, 'link');
      const split = a.doc() === '[First words](url)\n\n[Second word](url)s';
      // Every address is selected, so typing it once fills in both.
      const ranges = a.view.state.selection.ranges;
      const urlsSelected = ranges.length === 2 && ranges.every((r) => a.view.state.sliceDoc(r.from, r.to) === 'url');
      a.destroy();
      bar.remove();

      const b = mountProse('- one\n- two');
      b.select(0, b.doc().length);
      b.press('Mod-k');
      const list = b.doc() === '- [one](url)\n- [two](url)';
      b.destroy();

      return split && urlsSelected && list;
    },
  },
  {
    name: 'Shift-Enter at the end of a heading starts a new line as Enter does, with no backslash in the heading',
    run: () => {
      const cases: [string, number][] = [
        ['# Title here\n\nBody', '# Title here'.length],
        ['Title here\n==========\n\nBody', 'Title here'.length],
      ];
      return cases.every(([doc, at]) => {
        const withKey = (key: string): { handled: boolean; text: string } => {
          const p = mountProse(doc);
          p.select(at);
          const handled = p.press(key);
          const text = p.doc();
          p.destroy();
          return { handled, text };
        };
        const shift = withKey('Shift-Enter');
        const enter = withKey('Enter');
        return shift.handled && !shift.text.includes('\\') && shift.text === enter.text;
      });
    },
  },
  {
    name: 'Inline code on text holding a backtick writes a longer fence that keeps one code span, and toggles back off',
    run: () => {
      /** Select `target` in `doc`, click Inline code, and return the text with the selected text. */
      const code = (doc: string, target: string): { text: string; selected: string } => {
        const p = mountProse(doc);
        const bar = mountBar(p);
        const from = doc.indexOf(target);
        p.select(from, from + target.length);
        click(bar, 'code');
        const text = p.doc();
        const sel = p.view.state.selection.main;
        const selected = p.view.state.sliceDoc(sel.from, sel.to);
        p.destroy();
        bar.remove();
        return { text, selected };
      };
      const inner = code('Run a`b now', 'a`b');
      // A backtick at an edge needs a space between it and the fence, which CommonMark strips again.
      const edge = code('Run `a now', '`a');
      const off = code('Run ``a`b`` now', 'a`b');
      const padded = code('Run `` `a `` now', '`a');
      return (
        inner.text === 'Run ``a`b`` now' &&
        inner.selected === 'a`b' &&
        edge.text === 'Run `` `a `` now' &&
        edge.selected === '`a' &&
        off.text === 'Run a`b now' &&
        padded.text === 'Run `a now'
      );
    },
  },
  {
    name: 'Insert Divider between two paragraphs leaves one blank line on each side of the rule',
    run: () => {
      const p = mountProse('First para\n\nSecond para');
      const bar = mountBar(p);
      p.select(2);
      const divider = Array.from(bar.querySelectorAll<HTMLButtonElement>('[data-command="insert"] ~ .sheaf-tb-menu .sheaf-tb-menu-item')).find(
        (item) => item.querySelector('span')?.textContent === 'Divider'
      )!;
      divider.click();
      const text = p.doc();
      p.destroy();
      bar.remove();
      return text === 'First para\n\n---\n\nSecond para';
    },
  },
  {
    name: 'a toolbar menu opened with a click takes the arrow keys and Escape, and gives focus back to the editor',
    run: () => {
      const G: any = globalThis;
      const doc = 'one\ntwo\nthree\nfour';
      return ['heading', 'insert'].every((command) => {
        const p = mountProse(doc);
        const bar = mountBar(p);
        p.select(1);
        p.view.focus();
        const trigger = bar.querySelector<HTMLButtonElement>(`[data-command="${command}"]`)!;
        const menu = trigger.parentElement!.querySelector<HTMLElement>('.sheaf-tb-menu')!;
        const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('.sheaf-tb-menu-item'));
        // A pointer click: the trigger keeps focus in the editor on mousedown, and a click carries a detail count.
        trigger.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        trigger.dispatchEvent(new G.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        const opened = !menu.hidden;
        const key = (k: string): void =>
          void (document.activeElement ?? document.body).dispatchEvent(new G.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        key('ArrowDown');
        key('ArrowDown');
        const onSecondItem = document.activeElement === items[1];
        key('Escape');
        const closed = menu.hidden;
        const editorFocused = document.activeElement === p.view.contentDOM;
        const sel = p.view.state.selection.main;
        const untouched = sel.anchor === 1 && sel.head === 1 && p.doc() === doc;
        p.destroy();
        bar.remove();
        return opened && onSecondItem && closed && editorFocused && untouched;
      });
    },
  },
];
