/*
 * Comments: a `<!-- … -->` that takes its own lines, drawn as a callout box.
 *
 * What a person sees is read back from the editor DOM. jsdom has no layout and
 * no theme, so nothing here can check the colour of the rule down the box's
 * side, the chevron's shape, or where the label sits. These scenarios check
 * which comments become a box, what the box says when it is open and when it is
 * collapsed, that the collapse survives a redraw, that a comment inside a fence
 * stays code, and that hiding puts a marker in place of every box. Every one of
 * them ends by reading the document back, because the bytes must never move.
 */

import { Scenario, mountProse } from '../harness';
import { commentKeyFor, handleCommentFolds, setCommentFoldsHost, setCommentsMode } from '../../src/webview/comments';

type P = ReturnType<typeof mountProse>;

const boxes = (p: P): HTMLElement[] =>
  Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.md-comment'));

const markers = (p: P): HTMLElement[] =>
  Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.md-comment-marker'));

/** The label each box carries, in document order. */
const labels = (p: P): string[] =>
  boxes(p).map((b) => b.querySelector('.md-alert-name')?.textContent ?? '');

/** The comment text each box shows, in document order, lines joined with `|`. */
const bodies = (p: P): string[] =>
  boxes(p).map((b) =>
    Array.from(b.querySelectorAll<HTMLElement>('.md-comment-line'))
      .map((l) => l.textContent ?? '')
      .join('|')
  );

/** What a collapsed box shows beside its label. */
const peeks = (p: P): string[] =>
  boxes(p).map((b) => b.querySelector('.md-comment-peek')?.textContent ?? '');

const collapsedFlags = (p: P): boolean[] => boxes(p).map((b) => b.classList.contains('is-collapsed'));

/**
 * Press the chevron of box `i`, as a person does: the press and then the click.
 * Both, because the box around the chevron opens the comment on a press, and a
 * press that reached it would take the button away before its click arrived. A
 * click on its own cannot see that, and once did not.
 */
const chevron = (p: P, i = 0): void => {
  const button = boxes(p)[i]?.querySelector<HTMLElement>('.md-comment-fold');
  press(button);
  button?.dispatchEvent(new (globalThis as any).MouseEvent('click', { bubbles: true, cancelable: true }));
};

/** A left-button press on an element, bubbling as a real one does. */
const press = (el: HTMLElement | null | undefined, init: Record<string, unknown> = {}): void => {
  el?.dispatchEvent(new (globalThis as any).MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }));
};

/**
 * A fresh editor with nothing carried over from the scenario before it: the
 * page's collapses and its host are module state, and these run in one page.
 */
function mount(doc: string): P {
  setCommentsMode('show');
  setCommentFoldsHost(null);
  handleCommentFolds('reset', {});
  return mountProse(doc);
}

const ONE = 'Intro.\n\n<!-- A note to the writer.\nSecond line. -->\n\nAfter.';

export const scenarios: Scenario[] = [
  {
    name: 'a comment on its own lines is drawn as a callout box labelled Comment, and the file is untouched',
    run: () => {
      const p = mount(ONE);
      p.select(2);
      const ok =
        boxes(p).length === 1 &&
        labels(p).join(',') === 'Comment' &&
        bodies(p).join(',') === 'A note to the writer.|Second line.' &&
        // The angle brackets are the syntax the box stands in for.
        !p.view.contentDOM.textContent?.includes('<!--') &&
        boxes(p)[0].querySelector('.md-comment-fold') !== null &&
        p.doc() === ONE;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a comment inside a paragraph keeps its inline styling rather than becoming a box',
    run: () => {
      // The caret goes to the first paragraph, so the second is not showing its
      // source: what is drawn there is what a reader sees.
      const doc = 'Intro.\n\nA line with <!-- an aside --> in the middle of it.';
      const p = mount(doc);
      p.select(2);
      const ok = boxes(p).length === 0 && p.view.contentDOM.textContent?.includes('<!-- an aside -->') === true && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a comment inside a fenced code block is code and is left exactly as written',
    run: () => {
      const doc = 'Intro.\n\n```html\n<!-- in code -->\n```\n\nAfter.';
      const p = mount(doc);
      p.select(2);
      const text = p.view.contentDOM.textContent ?? '';
      const ok = boxes(p).length === 0 && text.includes('<!-- in code -->') && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the chevron collapses a comment to its label and first line, and opens it again',
    run: () => {
      const p = mount(ONE);
      p.select(2);
      const open = collapsedFlags(p)[0] === false && bodies(p)[0] === 'A note to the writer.|Second line.';
      chevron(p);
      const shut =
        collapsedFlags(p)[0] === true &&
        peeks(p)[0].startsWith('A note to the writer.') &&
        // Only the first line is left; the second is put away.
        !peeks(p)[0].includes('Second line.') &&
        bodies(p)[0] === '';
      chevron(p);
      const again = collapsedFlags(p)[0] === false && bodies(p)[0] === 'A note to the writer.|Second line.';
      const ok = open && shut && again && p.doc() === ONE;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a collapsed comment is still collapsed after the document is redrawn',
    run: () => {
      const p = mount(ONE);
      p.select(2);
      chevron(p);
      const shut = collapsedFlags(p)[0] === true;
      // Typing in the paragraph above rebuilds every decoration in the document.
      p.view.dispatch({ changes: { from: 5, insert: ' more' }, userEvent: 'input.type' });
      p.select(2);
      const ok = shut && collapsedFlags(p)[0] === true && p.doc() === 'Intro more.\n\n<!-- A note to the writer.\nSecond line. -->\n\nAfter.';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a collapse is handed to the host under the comment’s own key, and an answer from the host collapses it',
    run: () => {
      const sent: any[] = [];
      const p = mount(ONE);
      setCommentFoldsHost((m) => sent.push(m));
      p.select(2);
      chevron(p);
      const key = commentKeyFor('<!-- A note to the writer.\nSecond line. -->');
      const write = sent.filter((m) => m.type === 'commentFoldsWrite').pop();
      const asked = sent.some((m) => m.type === 'commentFoldsRead');
      const told = !!write && write.folds[key] === true;
      // What a reload looks like: nothing remembered in the page, and the host answering.
      chevron(p);
      const reopened = collapsedFlags(p)[0] === false;
      handleCommentFolds('comments-1', { [key]: true });
      const ok = asked && told && reopened && collapsedFlags(p)[0] === true && p.doc() === ONE;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'with comments hidden every box becomes a marker, and clicking one brings its box back',
    run: () => {
      const doc = 'Intro.\n\n<!-- First note. -->\n\nMiddle.\n\n<!-- Second note. -->\n\nAfter.';
      const p = mount(doc);
      p.select(2);
      const shown = boxes(p).length === 2 && markers(p).length === 0;
      setCommentsMode('hidden');
      p.view.dispatch({});
      const hidden = boxes(p).length === 0 && markers(p).length === 2;
      markers(p)[1].dispatchEvent(new (globalThis as any).MouseEvent('click', { bubbles: true, cancelable: true }));
      const back = boxes(p).length === 1 && markers(p).length === 1 && bodies(p).join(',') === 'Second note.';
      const ok = shown && hidden && back && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the caret in a comment shows the raw angle brackets, and leaving it draws the box again',
    run: () => {
      const p = mount(ONE);
      p.select(2);
      const drawn = boxes(p).length === 1;
      p.select(ONE.indexOf('A note'));
      const revealed = boxes(p).length === 0 && (p.view.contentDOM.textContent ?? '').includes('<!-- A note to the writer.');
      p.select(2);
      const ok = drawn && revealed && boxes(p).length === 1 && p.doc() === ONE;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'typing in a revealed comment changes only that comment’s lines',
    run: () => {
      const p = mount(ONE);
      const at = ONE.indexOf('Second line.') + 'Second line.'.length;
      p.select(at);
      p.view.dispatch({ changes: { from: at, insert: ' More.' }, selection: { anchor: at + 6 }, userEvent: 'input.type' });
      const typed = p.doc() === 'Intro.\n\n<!-- A note to the writer.\nSecond line. More. -->\n\nAfter.';
      p.select(2);
      const ok = typed && bodies(p).join(',') === 'A note to the writer.|Second line. More.';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a comment sharing its line with other text is left as written, and an unclosed one draws nothing',
    run: () => {
      const doc = 'Intro.\n\n<!-- trailing --> and more text\n\n<!-- never closed\n\nAfter.';
      const p = mount(doc);
      p.select(2);
      const text = p.view.contentDOM.textContent ?? '';
      const ok = boxes(p).length === 0 && text.includes('<!-- trailing --> and more text') && text.includes('<!-- never closed') && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a press on the second line of a comment leaves the caret on that line, not at the top of the comment',
    run: () => {
      const p = mount(ONE);
      const line = boxes(p)[0].querySelectorAll<HTMLElement>('.md-comment-line')[1];
      press(line);
      // The comment is open for editing, and the caret is in the line that was pressed:
      // the end of it here, since jsdom cannot say which character was under the pointer.
      const at = p.view.state.selection.main.head;
      const want = p.view.state.doc.line(4).from + 'Second line.'.length;
      const raw = (p.view.contentDOM.textContent ?? '').includes('<!-- A note to the writer.');
      const ok = at === want && raw && p.doc() === ONE;
      p.destroy();
      return ok;
    },
  },
];
