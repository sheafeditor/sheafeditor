import { Scenario, mountProse, Prose } from '../harness';
import { mountContextMenu, ContextMenuDeps } from '../../src/webview/contextmenu';
import { setLinkHost } from '../../src/webview/linkTarget';

const G: any = globalThis;

interface Menu {
  shown: () => boolean;
  labels: () => string[];
  item: (label: string) => HTMLButtonElement | undefined;
  /** The label of the focused item, or how the focused element reads when it is not one. */
  focused: () => string;
  close: () => void;
}

/** Send a keydown the way the menu's own document listener receives it. */
const key = (name: string): void => {
  document.activeElement!.dispatchEvent(new G.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
};

/** Open the prose menu at the caret the way the keyboard does, and read what it offers. */
function openMenu(p: Prose, extra: Partial<ContextMenuDeps> = {}, copied: string[] = []): Menu {
  document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
  mountContextMenu(p.view.dom, {
    getView: () => p.view,
    getFileName: () => 'doc.md',
    copyToClipboard: (t) => copied.push(t),
    ...extra,
  });
  p.view.contentDOM.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }));
  const menus = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu'));
  const all = (): HTMLButtonElement[] => menus().flatMap((m) => Array.from(m.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-item')));
  const shownItems = (): HTMLButtonElement[] =>
    menus()
      .filter((m) => !m.hidden)
      .flatMap((m) => Array.from(m.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-item')));
  return {
    shown: () => menus().some((m) => !m.hidden),
    labels: () => shownItems().map((b) => b.querySelector('span')!.textContent ?? ''),
    item: (label) => all().find((b) => b.querySelector('span')!.textContent === label),
    focused: () =>
      document.activeElement?.classList.contains('sheaf-ctx-item')
        ? (document.activeElement.querySelector('span')?.textContent ?? '')
        : `<${(document.activeElement as HTMLElement | null)?.tagName ?? 'none'}>`,
    close: () => document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove()),
  };
}

/** Choose Copy ref with `from` to `to` selected and return what reached the clipboard. */
function copyRef(doc: string, from: number, to: number): string {
  const copied: string[] = [];
  const p = mountProse(doc);
  p.select(from, to);
  const m = openMenu(p, {}, copied);
  m.item('Copy ref')!.click();
  m.close();
  p.destroy();
  return copied[0] ?? '';
}

export const scenarios: Scenario[] = [
  {
    name: 'a right-click on a paragraph opens on Turn into, with Edit Markdown under it and nothing the keyboard already binds',
    run: () => {
      const p = mountProse('# Title\n\nA paragraph of text.');
      p.select(14);
      const m = openMenu(p);
      // The whole menu, in order: cut, copy, paste, bold, italic and strikethrough
      // are gone, and the two items worth opening a menu for come first.
      const shown = m.labels();
      m.close();
      p.destroy();
      return JSON.stringify(shown) === JSON.stringify(['Turn into', 'Edit Markdown', 'Highlight', 'Inline code', 'Link', 'Clear formatting', 'Copy ref']);
    },
  },
  {
    name: 'Turn into checks the kind of the block that was clicked, and inside a code block offers only Text and Code block',
    run: () => {
      const h = mountProse('## Section\n\nbody');
      h.select(5);
      const hm = openMenu(h);
      hm.item('Turn into')!.click();
      const headingChecked =
        hm.item('Heading 2')!.getAttribute('aria-checked') === 'true' &&
        ['Text', 'Heading 1', 'Heading 3', 'Bullet list'].every((l) => hm.item(l)!.getAttribute('aria-checked') === 'false');
      hm.close();
      h.destroy();

      const c = mountProse('```js\nlet a = 1;\n```');
      c.select(8);
      const cm = openMenu(c);
      cm.item('Turn into')!.click();
      // The ones that cannot apply are shown disabled rather than dropped.
      const kinds = ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Bullet list', 'Numbered list', 'Task list', 'Quote', 'Code block'];
      const allThere = kinds.every((l) => !!cm.item(l));
      const enabled = kinds.filter((l) => cm.item(l)!.disabled === false);
      cm.close();
      c.destroy();
      return headingChecked && allThere && JSON.stringify(enabled) === JSON.stringify(['Text', 'Code block']);
    },
  },
  {
    name: 'the menu opens from the keyboard onto Turn into, the arrows walk the new order, and Escape gives the caret back',
    run: () => {
      const p = mountProse('A paragraph of text.');
      p.select(3);
      p.view.contentDOM.focus();
      const before = document.activeElement;
      const m = openMenu(p);
      const seen = [m.focused()];
      for (let i = 0; i < 3; i++) {
        key('ArrowDown');
        seen.push(m.focused());
      }
      key('Escape');
      const closed = !m.shown();
      const returned = document.activeElement === before;
      m.close();
      p.destroy();
      return seen.join('|') === 'Turn into|Edit Markdown|Highlight|Inline code' && closed && returned;
    },
  },
  {
    name: 'Copy link address copies the address a link names, not its Markdown spelling',
    run: () => {
      // A bracket inside a destination is written escaped, and the backslashes
      // are Markdown's syntax rather than part of the address.
      const copied: string[] = [];
      const escapedDoc = 'See [the spec](https://example.com/a_\\(b\\)) here.';
      const escaped = mountProse(escapedDoc);
      escaped.select(escapedDoc.indexOf('spec') + 2);
      const em = openMenu(escaped, {}, copied);
      em.item('Copy link address')!.click();
      em.close();
      escaped.destroy();

      // A bare email address is copied as the address itself. The mailto: it
      // opens with is the opener's business, not the clipboard's.
      const mailCopied: string[] = [];
      const mailDoc = 'Mail [me](someone@example.com) now.';
      const mail = mountProse(mailDoc);
      mail.select(mailDoc.indexOf('me]') + 1);
      const mm = openMenu(mail, {}, mailCopied);
      mm.item('Copy link address')!.click();
      mm.close();
      mail.destroy();

      return copied[0] === 'https://example.com/a_(b)' && mailCopied[0] === 'someone@example.com';
    },
  },
  {
    name: 'Copy ref names only the lines a selection covers when it ends at the start of a line',
    run: () => {
      // A triple-clicked line: the selection runs to the start of the next line.
      const tripleClicked = copyRef('one\n\ntwo words\n\nthree', 5, 15) === 'doc.md:3\n\n```\ntwo words\n```\n';
      const lineToLine = copyRef('a\nb\nc', 2, 4) === 'doc.md:2\n\n```\nb\n```\n';
      // Ending one character into the next line still names that line.
      const intoNext = copyRef('a\nb\nc', 2, 5) === 'doc.md:2-3\n\n```\nb\nc\n```\n';
      return tripleClicked && lineToLine && intoNext;
    },
  },
  {
    name: 'Copy ref with only a caret quotes that line as the file holds it, hashes and all',
    run: () => {
      // Nothing selected: the ref still carries the line it names, so a paste says
      // what is there as well as where it is.
      const paragraph = copyRef('one\n\ntwo words\n\nthree', 8, 8) === 'doc.md:3\n\n```\ntwo words\n```\n';
      // The source, not the rendered heading, so the quote matches the file.
      const heading = copyRef('## Heading\n\nbody', 5, 5) === 'doc.md:1\n\n```\n## Heading\n```\n';
      return paragraph && heading;
    },
  },
  {
    name: 'a caret ref on a line carrying a run of backticks is wrapped in a longer fence',
    run: () => {
      const doc = 'text\n\n```js\nlet a = 1;\n```';
      // The opening fence line itself: the wrapper has to outrun the three backticks in it.
      return copyRef(doc, doc.indexOf('```js') + 2, doc.indexOf('```js') + 2) === 'doc.md:3\n\n````\n```js\n````\n';
    },
  },
  {
    name: 'a caret on an empty line copies the location alone, with no empty fence',
    run: () => copyRef('one\n\nthree', 4, 4) === 'doc.md:2\n',
  },
  {
    name: 'the prose menu closes when the document changes, so Remove link and Mark done act on the document as it is now',
    run: () => {
      const p = mountProse('Go to the [site](https://a.io) now.');
      p.select(13);
      const m = openMenu(p);
      const staleRemove = m.item('Remove link')!;
      const openBefore = m.shown();
      // Typing while the menu is open.
      p.view.dispatch({ changes: { from: 13, insert: 'Z' }, selection: { anchor: 14 }, userEvent: 'input.type' });
      const closedOnType = !m.shown();
      staleRemove.click();
      const staleIgnored = p.doc() === 'Go to the [siZte](https://a.io) now.';
      const m2 = openMenu(p);
      m2.item('Remove link')!.click();
      const removed = p.doc() === 'Go to the siZte now.';
      m2.close();
      p.destroy();

      const q = mountProse('intro\n- [ ] write');
      q.select(q.doc().length - 2);
      const t = openMenu(q);
      const staleDone = t.item('Mark done')!;
      // An edit that did not come from this menu, such as one arriving from disk.
      q.view.dispatch({ changes: { from: 0, insert: 'ZZ' } });
      const closedOnEdit = !t.shown();
      staleDone.click();
      const staleDoneIgnored = q.doc() === 'ZZintro\n- [ ] write';
      const t2 = openMenu(q);
      t2.item('Mark done')!.click();
      const done = q.doc() === 'ZZintro\n- [x] write';
      t2.close();
      q.destroy();
      return openBefore && closedOnType && staleIgnored && removed && closedOnEdit && staleDoneIgnored && done;
    },
  },
  {
    name: 'the prose menu shows Turn into and inline formatting disabled on YAML front matter',
    run: () => {
      const doc = '---\ntitle: Notes\n---\n\nBody text';
      const formatting = ['Highlight', 'Inline code', 'Link', 'Clear formatting', 'Turn into'];
      const p = mountProse(doc);
      p.select(doc.indexOf('Notes') + 2);
      const m = openMenu(p);
      const offDisabled = formatting.every((l) => m.item(l)?.disabled === true);
      const refStillOn = m.item('Copy ref')?.disabled === false;
      m.item('Turn into')!.click();
      const noHeading = !m.item('Heading 1');
      m.item('Highlight')!.click();
      const untouched = p.doc() === doc;
      m.close();

      // A selection that reaches from the body into the front matter would write there too.
      p.select(doc.indexOf('Body') + 2, doc.indexOf('Notes'));
      const across = openMenu(p);
      const acrossDisabled = formatting.every((l) => across.item(l)?.disabled === true);
      across.close();

      // Selected, so Clear formatting has something to clear.
      p.select(doc.indexOf('Body'), doc.indexOf('Body') + 4);
      const body = openMenu(p);
      const bodyOn = formatting.every((l) => body.item(l)?.disabled === false);
      body.close();
      p.destroy();
      return offDisabled && refStillOn && noHeading && untouched && acrossDisabled && bodyOn;
    },
  },
  {
    name: 'the selection toolbar stays hidden over YAML front matter',
    run: () => {
      const doc = '---\ntitle: Notes\n---\n\nBody text';
      const toolbar = (p: Prose): Element | null => p.view.dom.querySelector('.sheaf-seltb');
      const p = mountProse(doc);
      const notes = doc.indexOf('Notes');
      p.select(notes, notes + 4);
      const inFrontMatter = toolbar(p);
      p.select(doc.indexOf('Body'), notes + 4);
      const reachingIn = toolbar(p);
      p.select(doc.indexOf('Body'), doc.length);
      const inBody = toolbar(p);
      p.destroy();
      return inFrontMatter === null && reachingIn === null && inBody !== null;
    },
  },
  {
    name: 'Copy link address and Open link use the address inside angle brackets, as the link popover does',
    run: () => {
      const copied: string[] = [];
      const opened: string[] = [];
      const doc = 'See [the notes](<my notes.md>) here.';
      const p = mountProse(doc);
      p.select(doc.indexOf('notes') + 2);
      const m = openMenu(p, { openLink: (u) => opened.push(u) }, copied);
      m.item('Copy link address')!.click();
      const m2 = openMenu(p, { openLink: (u) => opened.push(u) }, copied);
      m2.item('Open link')!.click();
      m2.close();
      p.destroy();
      return copied[0] === 'my notes.md' && opened[0] === 'my notes.md';
    },
  },
  {
    name: 'Open link with nothing injected takes the one opener, host routing and guard included',
    run: () => {
      // Every other check of this menu item hands it an `openLink` of its own, which
      // proves the item calls something without proving it calls the opener that
      // carries the routing and the guard. This one injects nothing.
      const win = document.defaultView as any;
      const opened: string[] = [];
      const posted: unknown[] = [];
      const original = win.HTMLAnchorElement.prototype.click;
      win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
        opened.push(this.getAttribute('href') ?? '');
      };
      setLinkHost((message) => posted.push(message));
      const choose = (doc: string, needle: string): void => {
        const p = mountProse(doc);
        p.select(doc.indexOf(needle) + 1);
        const m = openMenu(p);
        m.item('Open link')!.click();
        m.close();
        p.destroy();
      };
      try {
        choose('See [the log](log/2244-11.md) here.', 'the log');
        choose('See [the site](https://example.com/a) here.', 'the site');
        choose('See [bad](javascript:alert(1)) here.', 'bad]');
        return (
          // Relative: meaningless inside the webview, so it goes to the host.
          JSON.stringify(posted) === JSON.stringify([{ type: 'openLink', address: 'log/2244-11.md' }]) &&
          // A scheme: still the browser's, opening as exactly what it opened as before.
          JSON.stringify(opened) === JSON.stringify(['https://example.com/a'])
          // The script address reached neither, which is what the two lengths above
          // pin: the menu item had no guard of its own until the openers became one.
        );
      } finally {
        win.HTMLAnchorElement.prototype.click = original;
        setLinkHost(() => {});
      }
    },
  },
  {
    name: 'a scroll caused by the click that opened the menu does not dismiss it, and a later one does',
    run: async () => {
      // A right-click selects what it landed on before the menu opens, and a grid
      // scrolls the cell it has just selected into view. That scroll is dispatched
      // after the handler returns, so it arrived a moment after the menu appeared
      // and closed it, which read as a right-click that did nothing at all.
      const p = mountProse('Say hello to the world today.');
      p.select(7);
      const m = openMenu(p);
      const opened = m.shown();
      const scroller = document.createElement('div');
      document.body.appendChild(scroller);
      const scroll = (): void => scroller.dispatchEvent(new G.Event('scroll', { bubbles: false }));
      scroll();
      const survivedItsOwn = m.shown();
      // Past the grace, a scroll is the person moving the page out from under it.
      await new Promise((r) => setTimeout(r, 60));
      scroll();
      const closedByALaterOne = !m.shown();
      m.close();
      scroller.remove();
      p.destroy();
      return opened && survivedItsOwn && closedByALaterOne;
    },
  },
];
