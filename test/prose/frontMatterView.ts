/*
 * How much of a document's YAML front matter is drawn: every line, one strip, or
 * nothing.
 *
 * jsdom has no layout, so nothing here can check that hidden front matter takes no
 * height; what it can check is what is in the DOM and, every time, that the document
 * still reads exactly as it did. That last part is the point of the feature: the lines
 * are metadata a person is choosing not to look at, not text anybody is removing.
 */

import { Scenario, mountProse } from '../harness';
import { mountContextMenu } from '../../src/webview/contextmenu';
import { handleFrontMatterState, setFrontMatterHost, setFrontMatterMode } from '../../src/webview/frontMatterView';

type P = ReturnType<typeof mountProse>;

const DOC = '---\ntitle: The quarterly plan\nslug: plan\ntags: [a, b]\n---\n\n# Heading\n\nA paragraph.';
const NONE = '# Heading\n\nA paragraph.';

/** The strip a collapsed block is drawn as, if one is there. */
/** The collapsed block's own strip: the one-line stand-in with the block's name on it. */
const strip = (p: P): HTMLElement | null => p.view.contentDOM.querySelector('.sheaf-frontmatter-strip .sheaf-frontmatter-fold');

/** The chevron on an open block, which folds it. Same control, same place, pointing down. */
const openFold = (p: P): HTMLElement | null => p.view.contentDOM.querySelector('.sheaf-frontmatter-fold.is-open');

/** The text of every line the editor draws. */
const lines = (p: P): string[] =>
  Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')).map((l) => l.textContent ?? '');

/**
 * A fresh editor with the mode set and nothing carried over from the check before it:
 * the mode, the host and a document's own state are all module state, and these run in
 * one page.
 */
function mount(doc: string, mode: 'shown' | 'collapsed' | 'hidden'): P {
  setFrontMatterMode(mode);
  setFrontMatterHost(null);
  handleFrontMatterState('reset', null);
  const p = mountProse(doc);
  // The caret starts at 0, which is inside the front matter and opens it on purpose.
  // Every check here is about a document being read, so move it into the prose first.
  p.select(doc.indexOf('A paragraph.'));
  return p;
}

export const scenarios: Scenario[] = [
  {
    name: 'collapsed front matter is one strip naming the document, and the file is untouched',
    run: () => {
      const p = mount(DOC, 'collapsed');
      const folded = strip(p);
      const ok =
        !!folded &&
        folded.textContent === 'Front matter: The quarterly plan' &&
        folded.getAttribute('aria-expanded') === 'false' &&
        // None of the four lines is drawn, and the heading still is.
        !lines(p).some((l) => l.includes('slug: plan')) &&
        lines(p).some((l) => l.includes('Heading')) &&
        p.doc() === DOC;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a block with no title says how many lines it is, so the strip is never blank',
    run: () => {
      const doc = '---\nslug: plan\ntags: [a]\n---\n\n# Heading\n\nA paragraph.';
      setFrontMatterMode('collapsed');
      setFrontMatterHost(null);
      handleFrontMatterState('reset', null);
      const p = mountProse(doc);
      p.select(doc.indexOf('A paragraph.'));
      const folded = strip(p);
      const ok = !!folded && folded.textContent === 'Front matter, 4 lines' && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'hidden front matter draws nothing at all, and the file is untouched',
    run: () => {
      const p = mount(DOC, 'hidden');
      const ok =
        strip(p) === null &&
        !lines(p).some((l) => l.includes('slug: plan')) &&
        !lines(p).some((l) => l.includes('title:')) &&
        lines(p).some((l) => l.includes('Heading')) &&
        p.doc() === DOC;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'shown front matter draws every line it has',
    run: () => {
      const p = mount(DOC, 'shown');
      const drawn = lines(p);
      const ok =
        strip(p) === null &&
        // Open, the block carries the chevron that folds it: the strip's control in the same
        // place, pointing down. Without it the only way back was the right-click menu.
        openFold(p)?.getAttribute('aria-expanded') === 'true' &&
        drawn.some((l) => l.includes('title: The quarterly plan')) &&
        drawn.some((l) => l.includes('slug: plan')) &&
        drawn.some((l) => l.includes('tags: [a, b]')) &&
        p.doc() === DOC;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the strip’s chevron opens the block and hands that state to the host to keep',
    run: () => {
      const sent: any[] = [];
      const p = mount(DOC, 'collapsed');
      setFrontMatterHost((m) => sent.push(m));
      const asked = sent.some((m) => m.type === 'frontMatterStateRead');
      strip(p)?.dispatchEvent(new (globalThis as any).MouseEvent('click', { bubbles: true, cancelable: true }));
      const opened = lines(p).some((l) => l.includes('slug: plan')) && strip(p) === null && openFold(p) !== null;
      // And it stays open through a keystroke elsewhere, which rebuilds every decoration.
      p.view.dispatch({ changes: { from: p.doc().length, insert: ' more' }, userEvent: 'input.type' });
      const stillOpen = lines(p).some((l) => l.includes('slug: plan'));
      // The state is the host's to keep, so it is told rather than remembered here.
      const told = sent.filter((m) => m.type === 'frontMatterStateWrite').pop();
      const ok = asked && opened && stillOpen && told?.state === 'shown' && p.doc() === `${DOC} more`;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the caret inside the block opens it whatever the setting says',
    run: () => {
      // Somebody editing the metadata has to see it, and hidden is the state where
      // getting it back matters most.
      const p = mount(DOC, 'hidden');
      const away = strip(p) === null && !lines(p).some((l) => l.includes('slug: plan'));
      p.select(DOC.indexOf('slug: plan') + 2);
      const back = lines(p).some((l) => l.includes('slug: plan'));
      const ok = away && back && p.doc() === DOC;
      p.destroy();
      return ok;
    },
  },
  {
    /*
     * How far a choice reaches is the part of this that has nowhere to show itself, so it
     * is the part worth pinning. Everywhere writes the setting AND drops this document's
     * own state, because a document that kept its own would be the one document not
     * following the setting the person just set from it.
     */
    name: 'Use this everywhere writes the setting and stops this document overriding it, and Reset gives it back',
    run: () => {
      const p = mount(DOC, 'collapsed');
      const sent: unknown[] = [];
      setFrontMatterHost((m) => void sent.push(m));
      const pick = (label: string): void => {
        document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
        p.select(DOC.indexOf('slug: plan') + 2);
        mountContextMenu(p.view.dom, { getView: () => p.view, getFileName: () => 'doc.md', copyToClipboard: () => {} });
        p.view.contentDOM.dispatchEvent(
          new (globalThis as any).MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 })
        );
        Array.from(document.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-menu .sheaf-ctx-item'))
          .find((b) => b.querySelector('span')?.textContent === label)!
          .click();
      };
      pick('Hide front matter');
      const own = sent.filter((m) => (m as { type: string }).type === 'frontMatterStateWrite');
      pick('Use this everywhere');
      const after = sent.slice(own.length + 1);
      pick('Reset to default');
      const last = sent[sent.length - 1];
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
      setFrontMatterHost(null);
      const ok =
        // Hiding it was this document: a state written under the document's own key.
        JSON.stringify(own[own.length - 1]) === JSON.stringify({ type: 'frontMatterStateWrite', state: 'hidden' }) &&
        // Everywhere is the setting, then the document handed back to it.
        JSON.stringify(after) ===
          JSON.stringify([
            { type: 'setFrontMatter', state: 'hidden' },
            { type: 'frontMatterStateWrite', state: null },
          ]) &&
        JSON.stringify(last) === JSON.stringify({ type: 'frontMatterStateWrite', state: null }) &&
        p.doc() === DOC;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the right-click menu on the block offers all three states, with the one it is in unavailable',
    run: () => {
      // The only way back once it is hidden, since a control on the page would be the
      // space the person asked to reclaim.
      const p = mount(DOC, 'collapsed');
      const items = (pos: number): { label: string; off: boolean }[] => {
        document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
        p.select(pos);
        mountContextMenu(p.view.dom, { getView: () => p.view, getFileName: () => 'doc.md', copyToClipboard: () => {} });
        p.view.contentDOM.dispatchEvent(
          new (globalThis as any).MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 })
        );
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-menu .sheaf-ctx-item'))
          .map((b) => ({ label: b.querySelector('span')?.textContent ?? '', off: b.disabled }))
          .filter((i) => /front matter$|^Use this everywhere$|^Reset to default$/i.test(i.label));
      };
      const onBlock = items(DOC.indexOf('slug: plan') + 2);
      // And nothing about front matter where the click is in the prose.
      const inProse = items(DOC.indexOf('A paragraph.'));
      // Reading the menu is not the feature. Pressing Hide has to hide it, with the
      // caret back in the prose so the block is not being opened by the caret instead.
      items(DOC.indexOf('slug: plan') + 2);
      const hide = Array.from(document.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-menu .sheaf-ctx-item')).find(
        (b) => b.querySelector('span')?.textContent === 'Hide front matter'
      );
      hide?.click();
      p.select(DOC.indexOf('A paragraph.'));
      const hidden = strip(p) === null && !lines(p).some((l) => l.includes('slug: plan'));
      // Hidden, there is no block to right-click, so the items have to be offered in the
      // prose instead. Otherwise the only control that can take the block away is also
      // the only one that can bring it back.
      const wayBack = items(DOC.indexOf('A paragraph.'));
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
      const labels = 'Show front matter, Collapse front matter, Hide front matter, Use this everywhere, Reset to default';
      const ok =
        onBlock.map((i) => i.label).join(', ') === labels &&
        onBlock.find((i) => i.label === 'Collapse front matter')?.off === true &&
        onBlock.find((i) => i.label === 'Hide front matter')?.off === false &&
        // Nothing to reset on a document that is only following the setting.
        onBlock.find((i) => i.label === 'Reset to default')?.off === true &&
        inProse.length === 0 &&
        !!hide &&
        hidden &&
        wayBack.map((i) => i.label).join(', ') === labels &&
        wayBack.find((i) => i.label === 'Hide front matter')?.off === true &&
        // Hide gave the document a state of its own, so now there is something to reset.
        wayBack.find((i) => i.label === 'Reset to default')?.off === false &&
        p.doc() === DOC;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a document with no front matter is drawn as it always was, in every state, with no chevron anywhere',
    run: () => {
      let ok = true;
      for (const mode of ['shown', 'collapsed', 'hidden'] as const) {
        const p = mount(NONE, mode);
        ok = ok && strip(p) === null && openFold(p) === null && lines(p).some((l) => l.includes('Heading')) && p.doc() === NONE;
        p.destroy();
      }
      return ok;
    },
  },
  {
    /*
     * The chevron on an open block folds it, which is the whole of what was missing: open, the
     * block was five lines of YAML with nothing to press, and the way back was the right-click
     * menu or the command palette.
     *
     * Three readings. It folds. It hands the state to the host, as the strip's own chevron
     * does, so the next document is unaffected. And with the caret inside the block it moves
     * the caret to the start of the body first, so nobody is left typing into metadata that is
     * no longer drawn.
     */
    name: 'the chevron on an open block folds it, and takes the caret out of what it folded',
    run: () => {
      const sent: any[] = [];
      const p = mount(DOC, 'shown');
      setFrontMatterHost((m) => sent.push(m));
      openFold(p)?.dispatchEvent(new (globalThis as any).MouseEvent('click', { bubbles: true, cancelable: true }));
      const folded = strip(p) !== null && openFold(p) === null && !lines(p).some((l) => l.includes('slug: plan'));
      const told = sent.filter((m) => m.type === 'frontMatterStateWrite').pop();
      p.destroy();

      // Again with the caret in the metadata, which is where it must not be left.
      const q = mount(DOC, 'shown');
      q.select(DOC.indexOf('slug: plan') + 2);
      const insideBefore = q.view.state.selection.main.head < DOC.indexOf('# Heading');
      openFold(q)?.dispatchEvent(new (globalThis as any).MouseEvent('click', { bubbles: true, cancelable: true }));
      const head = q.view.state.selection.main.head;
      // The line, not the offset: the caret is asked for the start of the heading's line and
      // the editor's own rule about carets at hidden markers then moves it past the `# `.
      const landedOn = q.view.state.doc.lineAt(head).number;
      const movedOut = landedOn === q.view.state.doc.lineAt(DOC.indexOf('# Heading')).number;
      const same = q.doc() === DOC;
      q.destroy();

      return {
        ok: folded && told?.state === 'collapsed' && insideBefore && movedOut && same,
        detail:
          `folding gave ${folded ? 'the strip' : 'no strip'}, told the host ${JSON.stringify(told?.state)}; ` +
          `with the caret in the metadata it went to ${head}, on line ${landedOn}; the body starts at ${DOC.indexOf('# Heading')}; ` +
          `the file is ${same ? 'unchanged' : 'changed'}`,
      };
    },
  },
];
