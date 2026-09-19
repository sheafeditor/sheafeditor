import { Scenario, mountProse, Prose } from '../harness';
import { setClipboardHost } from '../../src/webview/hostClipboard';

const G: any = globalThis;

const toolbar = (p: Prose): HTMLElement | null => p.view.dom.querySelector<HTMLElement>('.sheaf-seltb');
const popover = (p: Prose): HTMLElement | null => p.view.dom.querySelector<HTMLElement>('.sheaf-linkpop');
const button = (p: Prose, cmd: string): HTMLButtonElement => toolbar(p)!.querySelector<HTMLButtonElement>(`[data-cmd="${cmd}"]`)!;
const pressed = (p: Prose, cmd: string): boolean => button(p, cmd).getAttribute('aria-pressed') === 'true';
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const mouse = (target: EventTarget, type: string): MouseEvent => {
  const event = new G.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  target.dispatchEvent(event);
  return event;
};
const key = (target: EventTarget, name: string): KeyboardEvent => {
  const event = new G.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

export const scenarios: Scenario[] = [
  {
    name: 'selection toolbar stays hidden while blocks are selected with Escape',
    run: () => {
      const p = mountProse('# A\n\npara text\n\n# B');
      p.select(7);
      const handled = p.press('Escape');
      const selected = !p.view.state.selection.main.empty;
      const shown = toolbar(p);
      p.destroy();
      return handled && selected && shown === null;
    },
  },
  {
    name: 'selection toolbar shows over a prose selection and hides when it collapses',
    run: () => {
      const p = mountProse('hello world');
      const before = toolbar(p);
      p.select(0, 5);
      const shown = toolbar(p);
      const role = shown?.getAttribute('role');
      p.select(3);
      const after = toolbar(p);
      p.destroy();
      return before === null && shown !== null && role === 'toolbar' && after === null;
    },
  },
  {
    name: 'selection toolbar waits for mouseup while a selection is dragged',
    run: () => {
      const p = mountProse('hello world');
      mouse(p.view.contentDOM, 'mousedown');
      p.select(0, 5);
      const dragging = toolbar(p);
      mouse(document, 'mouseup');
      const released = toolbar(p);
      p.destroy();
      return dragging === null && released !== null;
    },
  },
  {
    name: 'selection toolbar stays hidden in a table, in a code block and in source mode',
    run: async () => {
      const t = mountProse('| a | b |\n| - | - |\n| one | two |\n\ntext');
      const row = t.view.state.doc.line(3);
      t.select(row.from + 2, row.from + 5);
      const inTable = toolbar(t);
      t.destroy();

      const c = mountProse('```\ncode here\n```\n\ntext');
      c.select(4, 8);
      const inCode = toolbar(c);
      c.select(19, 23);
      const inText = toolbar(c);
      c.destroy();

      const s = mountProse('hello world');
      s.view.dom.parentElement!.classList.add('source-mode');
      s.view.dispatch({});
      await tick();
      s.select(0, 5);
      const inSource = toolbar(s);
      s.destroy();
      return inTable === null && inCode === null && inText !== null && inSource === null;
    },
  },
  {
    name: 'a toolbar button applies its command and keeps the selection',
    run: () => {
      const p = mountProse('hello world');
      p.select(0, 5);
      const down = mouse(button(p, 'bold'), 'mousedown');
      button(p, 'bold').click();
      const sel = p.view.state.selection.main;
      const ok =
        down.defaultPrevented &&
        p.doc() === '**hello** world' &&
        p.view.state.sliceDoc(sel.from, sel.to) === 'hello' &&
        toolbar(p) !== null &&
        pressed(p, 'bold');
      p.destroy();
      return ok;
    },
  },
  {
    name: 'toolbar buttons show the formatting at the selection',
    run: () => {
      const p = mountProse('**bold** and ==hi==\n## Title');
      p.select(2, 6);
      const onBold = pressed(p, 'bold') && !pressed(p, 'highlight');
      p.select(15, 17);
      const onHighlight = pressed(p, 'highlight') && !pressed(p, 'bold');
      const textLabel = button(p, 'turn-into').textContent;
      const title = p.view.state.doc.line(2);
      p.select(title.from + 3, title.to);
      const headingLabel = button(p, 'turn-into').textContent;
      const titled = button(p, 'bold').title;
      p.destroy();
      return onBold && onHighlight && textLabel === 'Text' && headingLabel === 'Heading 2' && /^Bold \(.+\)$/.test(titled);
    },
  },
  {
    name: 'Turn into converts the selected lines between block kinds',
    run: () => {
      const p = mountProse('one\ntwo');
      const turn = (kind: string): string => {
        p.select(0, p.doc().length);
        toolbar(p)!.querySelector<HTMLButtonElement>(`[data-block="${kind}"]`)!.click();
        return p.doc();
      };
      const steps = [turn('bullet'), turn('h2'), turn('task'), turn('quote'), turn('ordered'), turn('text'), turn('code')];
      p.destroy();
      const want = ['- one\n- two', '## one\n## two', '- [ ] one\n- [ ] two', '> one\n> two', '1. one\n2. two', 'one\ntwo', '```\none\ntwo\n```'];
      return steps.every((got, i) => got === want[i]);
    },
  },
  {
    name: 'Escape hides the toolbar; Alt-F10 focuses it, arrows move and Escape returns',
    run: () => {
      const p = mountProse('hello world');
      p.select(0, 5);
      const escaped = p.press('Escape') && toolbar(p) === null;
      p.select(6, 11);
      const focused = p.press('Alt-F10') && document.activeElement === button(p, 'bold');
      key(document.activeElement!, 'ArrowRight');
      const moved = document.activeElement === button(p, 'italic');
      key(document.activeElement!, 'ArrowLeft');
      key(document.activeElement!, 'ArrowLeft');
      const wrapped = document.activeElement === toolbar(p)!.querySelector('[data-cmd="turn-into"]');
      key(document.activeElement!, 'Escape');
      const sel = p.view.state.selection.main;
      const closed = toolbar(p) === null && sel.from === 6 && sel.to === 11;
      p.destroy();
      return escaped && focused && moved && wrapped && closed;
    },
  },
  {
    name: 'the Turn into menu opens, moves and closes from the keyboard',
    run: () => {
      const p = mountProse('one two');
      p.select(0, 3);
      p.press('Alt-F10');
      key(document.activeElement!, 'End');
      const trigger = button(p, 'turn-into');
      const onTrigger = document.activeElement === trigger;
      key(trigger, 'ArrowDown');
      const menu = toolbar(p)!.querySelector<HTMLElement>('[role="menu"]')!;
      const opened = !menu.hidden && trigger.getAttribute('aria-expanded') === 'true' && document.activeElement === menu.querySelector('[data-block="text"]');
      key(document.activeElement!, 'ArrowDown');
      const moved = document.activeElement === menu.querySelector('[data-block="h1"]');
      key(document.activeElement!, 'Escape');
      const closed = menu.hidden && document.activeElement === trigger && toolbar(p) !== null;
      p.destroy();
      return onTrigger && opened && moved && closed;
    },
  },
  {
    name: 'the Link button links a selection, and unlinks one inside a link',
    run: () => {
      const p = mountProse('[see](https://a.io) x');
      p.select(1, 4);
      const label = button(p, 'link').getAttribute('aria-label');
      button(p, 'link').click();
      const unlinked = p.doc();
      p.select(0, 3);
      button(p, 'link').click();
      const linked = p.doc();
      p.destroy();
      return label === 'Remove link' && unlinked === 'see x' && linked === '[see](url) x';
    },
  },
  {
    name: 'the toolbar hides when focus leaves the editor, not when it enters the toolbar',
    run: async () => {
      const p = mountProse('hello world');
      p.select(0, 5);
      p.press('Alt-F10');
      p.view.contentDOM.dispatchEvent(new G.Event('focusout', { bubbles: true }));
      await tick();
      const kept = toolbar(p) !== null;
      const outside = document.createElement('input');
      document.body.appendChild(outside);
      outside.focus();
      toolbar(p)!.dispatchEvent(new G.Event('focusout', { bubbles: true }));
      await tick();
      const gone = toolbar(p) === null;
      outside.remove();
      p.destroy();
      return kept && gone;
    },
  },
  {
    name: 'a caret inside a link shows the link popover with its URL, and a selection shows the toolbar',
    run: () => {
      const p = mountProse('[see](https://a.io) more');
      p.select(2);
      const pop = popover(p);
      const url = pop?.querySelector<HTMLInputElement>('.sheaf-linkpop-url')?.value;
      p.select(1, 4);
      const yielded = popover(p) === null && toolbar(p) !== null;
      p.select(22);
      const outside = popover(p) === null;
      p.destroy();
      return pop !== null && url === 'https://a.io' && yielded && outside;
    },
  },
  {
    name: 'Enter in the link popover rewrites only the URL range',
    run: () => {
      const cases: [string, number, string, string][] = [
        ['a [see](https://a.io "T") z', 4, 'https://b.org/x', 'a [see](https://b.org/x "T") z'],
        ['[a]() z', 1, 'https://c.io', '[a](https://c.io) z'],
        ['[a](u) z', 1, 'my file.md', '[a](<my file.md>) z'],
      ];
      return cases.every(([doc, at, url, want]) => {
        const p = mountProse(doc);
        p.select(at);
        const input = popover(p)!.querySelector<HTMLInputElement>('.sheaf-linkpop-url')!;
        input.value = url;
        input.dispatchEvent(new G.Event('input', { bubbles: true }));
        key(input, 'Enter');
        const got = p.doc();
        const closed = popover(p) === null;
        p.destroy();
        return got === want && closed;
      });
    },
  },
  {
    name: 'Remove link keeps the link text and Copy sends the address to the host',
    run: () => {
      const posted: unknown[] = [];
      setClipboardHost((message) => posted.push(message));
      const p = mountProse('go [see **it**](https://a.io "T") now');
      p.select(6);
      popover(p)!.querySelector<HTMLButtonElement>('[data-action="copy"]')!.click();
      popover(p)!.querySelector<HTMLButtonElement>('[data-action="remove"]')!.click();
      const got = p.doc();
      p.destroy();
      setClipboardHost(null as unknown as (message: unknown) => void);
      const copied = posted.length === 1 && JSON.stringify(posted[0]) === JSON.stringify({ type: 'clipboardWrite', text: 'https://a.io' });
      return got === 'go see **it** now' && copied;
    },
  },
  {
    name: 'Escape closes the link popover from the text and from its field',
    run: () => {
      const p = mountProse('[see](https://a.io) more');
      p.select(2);
      const fromText = p.press('Escape') && popover(p) === null;
      p.select(3);
      const reopened = popover(p) !== null;
      const input = popover(p)!.querySelector<HTMLInputElement>('.sheaf-linkpop-url')!;
      key(input, 'Escape');
      const fromField = popover(p) === null && p.doc() === '[see](https://a.io) more';
      p.destroy();
      return fromText && reopened && fromField;
    },
  },
  {
    name: 'hovering a rendered link opens its popover unless the selection toolbar is showing',
    run: async () => {
      const p = mountProse('x\n\n[see](https://a.io) more and more');
      const link = p.view.contentDOM.querySelector('.tok-link')!;
      mouse(link, 'mousemove');
      const early = popover(p);
      await tick(500);
      const hovered = popover(p);
      const url = hovered?.querySelector<HTMLInputElement>('.sheaf-linkpop-url')?.value;
      p.select(28, 32);
      mouse(p.view.contentDOM.querySelector('.tok-link')!, 'mousemove');
      await tick(500);
      const yielded = popover(p) === null && toolbar(p) !== null;
      p.destroy();
      return early === null && hovered !== null && url === 'https://a.io' && yielded;
    },
  },
];
