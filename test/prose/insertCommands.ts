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

const G: any = globalThis;

/** Set a popover field the way typing does. */
const set = (input: HTMLInputElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new G.Event('input', { bubbles: true }));
};

/** Fill the popover the last command opened and press Enter in the address field. */
const enterAddress = (p: Prose, url: string, text?: string): void => {
  const pop = p.view.dom.querySelector('.sheaf-linkpop');
  if (!pop) throw new Error('no link popover is open');
  const field = (which: string): HTMLInputElement => pop.querySelector<HTMLInputElement>(`.sheaf-linkpop-${which}`)!;
  if (text !== undefined) set(field('text'), text);
  set(field('url'), url);
  field('url').dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
};

/** Which of the link popover's fields has the caret, and what it holds. */
const focusedField = (p: Prose): string => {
  const pop = p.view.dom.querySelector('.sheaf-linkpop');
  if (!pop) return 'no popover';
  const active = document.activeElement as HTMLInputElement | null;
  if (!active || !pop.contains(active)) return 'no field focused';
  return `${active.classList.contains('sheaf-linkpop-url') ? 'url' : 'text'}=${active.value}`;
};

export const scenarios: Scenario[] = [
  {
    /*
     * Cmd+K and the Link button open the popover on the link the caret is in.
     *
     * They used to remove it, which made the one shortcut people reach for to change a
     * link the shortcut that destroys it. Nesting a second link is still not on the
     * table: Markdown has no link inside a link.
     */
    name: 'Link and Mod-k with the caret inside a link open the popover on its address, leaving the document alone',
    run: () => {
      const doc = 'Go to [the site](https://x.io) now';
      const caret = doc.indexOf('site') + 2;

      const a = mountProse(doc);
      const bar = mountBar(a);
      a.select(caret);
      click(bar, 'link');
      const button = `${a.doc()} | ${focusedField(a)}`;
      a.destroy();
      bar.remove();

      const b = mountProse(doc);
      b.select(caret);
      const handled = b.press('Mod-k');
      const key = `${b.doc()} | ${focusedField(b)}`;
      b.destroy();

      const want = `${doc} | url=https://x.io`;
      return {
        ok: button === want && handled && key === want,
        detail: `the button gave ${JSON.stringify(button)}, Mod-k gave ${JSON.stringify(key)}, wanted ${JSON.stringify(want)}`,
      };
    },
  },
  {
    /*
     * A link cannot cross a block, so a selection over two paragraphs becomes two links, each
     * keeping its own words, both to the one address the popover was given. The address arrives
     * once and fills them all, which is what selecting every `url` used to be for.
     */
    name: 'Link over a selection spanning two paragraphs writes one link per paragraph, both to the one address',
    run: () => {
      const doc = 'First words\n\nSecond words';
      const end = doc.indexOf('Second words') + 'Second word'.length;

      const a = mountProse(doc);
      const bar = mountBar(a);
      a.select(0, end);
      click(bar, 'link');
      // Nothing is written while the address is being asked for.
      const pending = a.doc();
      enterAddress(a, 'https://x.io');
      const split = a.doc();
      a.destroy();
      bar.remove();

      const b = mountProse('- one\n- two');
      b.select(0, b.doc().length);
      b.press('Mod-k');
      enterAddress(b, 'u');
      const list = b.doc();
      b.destroy();

      const wantSplit = '[First words](https://x.io)\n\n[Second word](https://x.io)s';
      return {
        ok: pending === doc && split === wantSplit && list === '- [one](u)\n- [two](u)',
        detail:
          `before the address the file was ${JSON.stringify(pending)}; two paragraphs gave ${JSON.stringify(split)}` +
          (split === wantSplit ? '' : ` rather than ${JSON.stringify(wantSplit)}`) +
          `; the list gave ${JSON.stringify(list)}`,
      };
    },
  },
  {
    name: 'Mod-k on words holding a lone bracket escapes it, so the link parses; a matched pair is left as written',
    run: () => {
      const cases: [string, string][] = [
        // A lone closer would end the label early and leave "](url)" showing as text.
        ['see step 3]', '[see step 3\\]](url)'],
        ['open [ here', '[open \\[ here](url)'],
        // A matched pair is a valid label as it stands, so nothing in the words changes.
        ['note [1] here', '[note [1] here](url)'],
        // An escaped bracket already stands for itself and needs no second escape.
        ['a \\] b', '[a \\] b](url)'],
      ];
      const bad: string[] = [];
      for (const [words, want] of cases) {
        const p = mountProse(words);
        p.select(0, words.length);
        p.press('Mod-k');
        // The words arrive in the text field as they were selected, backslashes included.
        const field = p.view.dom.querySelector<HTMLInputElement>('.sheaf-linkpop-text')?.value;
        enterAddress(p, 'url');
        const got = p.doc();
        // The caret is past the link, ready to carry on the sentence.
        const sel = p.view.state.selection.main;
        if (got !== want || field !== words || !sel.empty || sel.head !== got.length) {
          bad.push(`${JSON.stringify(words)} -> ${JSON.stringify(got)} (field ${JSON.stringify(field)}, caret ${sel.head} of ${got.length})`);
        }
        p.destroy();
      }
      // Across two paragraphs, each span is escaped on its own.
      const two = mountProse('a ] b\n\nc d');
      two.select(0, two.doc().length);
      two.press('Mod-k');
      enterAddress(two, 'url');
      const both = two.doc();
      two.destroy();
      const wantBoth = '[a \\] b](url)\n\n[c d](url)';
      return {
        ok: bad.length === 0 && both === wantBoth,
        detail: `cases that do not match: ${JSON.stringify(bad)}; two paragraphs gave ${JSON.stringify(both)}`,
      };
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
