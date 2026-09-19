import { Scenario, mountProse, Prose } from '../harness';
import { mountContextMenu, ContextMenuDeps } from '../../src/webview/contextmenu';
import { setLinkHost } from '../../src/webview/linkTarget';

const G: any = globalThis;

interface Menu {
  shown: () => boolean;
  item: (label: string) => HTMLButtonElement | undefined;
  close: () => void;
}

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
  return {
    shown: () => menus().some((m) => !m.hidden),
    item: (label) => all().find((b) => b.querySelector('span')!.textContent === label),
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
      const formatting = ['Bold', 'Italic', 'Strikethrough', 'Highlight', 'Inline code', 'Link', 'Clear formatting', 'Turn into'];
      const p = mountProse(doc);
      p.select(doc.indexOf('Notes') + 2);
      const m = openMenu(p);
      const offDisabled = formatting.every((l) => m.item(l)?.disabled === true);
      const refStillOn = m.item('Copy ref')?.disabled === false;
      m.item('Turn into')!.click();
      const noHeading = !m.item('Heading 1');
      m.item('Bold')!.click();
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
];
