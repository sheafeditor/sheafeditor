/*
 * Two editors on one page, and the state each of them must not share with the other.
 *
 * Every scenario here needs **two** mounts, which is the point: the faults they cover are invisible
 * from one editor. A page with a single editor behaves identically whether a module keeps its host
 * in a module-level variable or against the mount, so a check that mounts once passes either way and
 * says nothing.
 *
 * **Which mount is being read is asserted rather than assumed.** In every case below the second
 * mount is the one that works, because it registered last; the fault is entirely in the first. So a
 * scenario that read the second editor's toolbar, or the second host's messages, would pass against
 * the defect. Each one names the mount it is reading and checks its precondition first, so a
 * scenario that could not have reached the state it is about fails rather than passing empty.
 */

import { Scenario, mountProse } from '../harness';
import { closeMount, fallbackCount, mountExtension, openMount } from '../../src/webview/mountScope';
import type { MountScope } from '../../src/webview/mountScope';
import { commentBlocks, handleCommentFolds, setCommentFoldsHost, setCommentsMode } from '../../src/webview/comments';
import { mountToolbar, reflectTableOfContents, refreshToolbar, tocButtonState } from '../../src/webview/toolbar';
import { blockRefHost, setBlockRefHost } from '../../src/webview/refs';
import { setLivePreviewConfig } from '../../src/webview/revealState';
import type { FromWebview } from '../../src/protocol';

type P = ReturnType<typeof mountProse>;

interface Mounted {
  scope: MountScope;
  prose: P;
  /** Everything this mount's host was sent, in order. */
  sent: FromWebview[];
  /** The element the mount was opened on, which really contains this editor. */
  root: HTMLElement;
}

/** A document with one comment in it, so there is a box to collapse. */
const WITH_COMMENT = (word: string): string => `Intro ${word}.\n\n<!-- A note about ${word}. -->\n\nAfter.`;

/**
 * One mount: its own scope, its own editor configured with that scope, and its own host.
 *
 * The scope goes into the editor's extensions, which is how anything reading the editor's state
 * finds the mount it belongs to. The host is registered against the same scope.
 *
 * **The scope's root really contains the editor, and the first version of this got that wrong.** It
 * opened the mount on a detached `<div>`, which every state-field read survives, because those find
 * the mount through the facet in the editor's own configuration. The reads that walk up from an
 * element do not: they reached `document.body`, matched no registered root, and fell back. With one
 * mount that answer is right by construction, so nothing failed; with two it is the defect these
 * scenarios exist to catch, arrived at through the harness. `noFallback` below is what found it and
 * what keeps it found.
 */
function mount(doc: string): Mounted {
  const sent: FromWebview[] = [];
  const root = document.createElement('div');
  document.body.appendChild(root);
  const scope = openMount(root);
  const prose = mountProse(doc, [mountExtension(scope)]);
  // `mountProse` makes its own parent under the body; this puts it inside the mount's root, so a
  // read that walks up from an element inside the editor finds this mount and not the other one.
  const parent = prose.view.dom.parentElement;
  if (parent && parent !== root) root.appendChild(parent);
  setCommentFoldsHost((message) => void sent.push(message), scope);
  return { scope, prose, sent, root };
}

/**
 * Run `fn` and say how many reads inside it could not tell which mount they belonged to.
 *
 * **This is the guard under the fallback.** A read that resolves nothing takes the page's scope,
 * which is the right answer on a page with one editor and the defect on a page with two. Written
 * down that would be a caveat; measured it is a check, and it has already caught this file handing
 * its mounts a root that contained no editor.
 *
 * The count rather than the warning, because the warning is said once per page: by the time a
 * scenario looked for it, something earlier could have spent it, and then "no warning" would mean
 * nothing. Counting makes the reading local to `fn`.
 */
function fallbacksDuring<T>(fn: () => T): { value: T; fellBack: number } {
  const before = fallbackCount();
  const value = fn();
  return { value, fellBack: fallbackCount() - before };
}

function unmount(m: Mounted): void {
  setCommentFoldsHost(null, m.scope);
  m.prose.destroy();
  m.root.remove();
  closeMount(m.scope);
}

const boxes = (p: P): HTMLElement[] => Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.md-comment'));

/** Press a box's chevron the way a person does: the press, then the click. */
function collapse(p: P, i = 0): void {
  const button = boxes(p)[i]?.querySelector<HTMLElement>('.md-comment-fold');
  const G = globalThis as any;
  button?.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  button?.dispatchEvent(new G.MouseEvent('click', { bubbles: true, cancelable: true }));
}

const folds = (message: FromWebview | undefined): Record<string, true> =>
  (message as { folds?: Record<string, true> } | undefined)?.folds ?? {};

/**
 * What this editor's first comment is kept under.
 *
 * Read off the editor rather than built from the comment's words: the key is a digest of the raw
 * comment including its angle brackets, and a key guessed from the text inside them is a key no
 * document uses. Guessed once here, and the scenario's precondition caught it.
 */
const keyIn = (p: P): string => commentBlocks(p.view.state)[0]?.key ?? '';

/** Whether this editor's first comment box is drawn collapsed. */
const shut = (p: P): boolean => boxes(p)[0]?.classList.contains('is-collapsed') === true;

function fresh(): void {
  setCommentsMode('show');
  setLivePreviewConfig({ revealSyntaxOnLine: false });
}

/* ---- Toolbars ------------------------------------------------------------- */

interface Barred extends Mounted {
  bar: HTMLElement;
}

/** One mount with a toolbar of its own over an editor of its own. */
function mountWithBar(doc: string): Barred {
  const m = mount(doc);
  const bar = document.createElement('div');
  bar.className = 'sheaf-toolbar';
  document.body.appendChild(bar);
  mountToolbar(bar, () => m.prose.view, () => {}, () => {}, () => false, false, () => {}, false, m.scope);
  return { ...m, bar };
}

function unmountBar(m: Barred): void {
  m.bar.remove();
  unmount(m);
}

/** A control in this toolbar, by the command it runs. */
const button = (m: Barred, command: string): HTMLElement | null =>
  m.bar.querySelector<HTMLElement>(`[data-command="${command}"]`);

const active = (el: HTMLElement | null): boolean => el?.classList.contains('is-active') === true;

export const scenarios: Scenario[] = [
  {
    /*
     * CONTROL. Two mounts, each with its own comment-folds host, and a collapse made in the
     * **first**. Before this work the host was one module-level variable, so the second mount's
     * registration replaced the first's and this collapse was reported to the wrong host.
     */
    name: 'two mounts: a collapse in the first editor is reported to the first mount host, not the second',
    run: () => {
      fresh();
      const a = mount(WITH_COMMENT('alpha'));
      const b = mount(WITH_COMMENT('beta'));
      // The precondition, because a page with no comment box has no chevron and the press below
      // would do nothing at all, which reads exactly like a host that was not called.
      const drawn = boxes(a.prose).length;
      const asked = a.sent.length;
      collapse(a.prose);
      const mine = a.sent.slice(asked).filter((m) => m.type === 'commentFoldsWrite');
      const theirs = b.sent.filter((m) => m.type === 'commentFoldsWrite');
      const ok = drawn === 1 && mine.length === 1 && theirs.length === 0;
      const detail = `first editor drew ${drawn} box(es); first host got ${mine.length} write(s), second host got ${theirs.length}`;
      unmount(a);
      unmount(b);
      return { ok, detail };
    },
  },
  {
    /*
     * CONTROL. The collapses themselves, rather than which host hears about them. A second mount's
     * stored folds arriving used to clear the set and fill it from its own document, and the first
     * mount then wrote that back under its own document's key: the wrong content to the right host.
     */
    name: "two mounts: the second mount's stored folds arriving leaves the first mount's collapse alone",
    run: () => {
      fresh();
      const a = mount(WITH_COMMENT('alpha'));
      const b = mount(WITH_COMMENT('beta'));
      const mineKey = keyIn(a.prose);
      const theirsKey = keyIn(b.prose);
      // The first mount has a fold, from its own host, before the second hears anything. The
      // precondition: with no fold drawn here the assertion below is about nothing.
      handleCommentFolds('a', { [mineKey]: true }, a.scope);
      const folded = shut(a.prose);
      // Now the second mount's own answer arrives, naming a key of its own document.
      handleCommentFolds('b', { [theirsKey]: true }, b.scope);
      const stillFolded = shut(a.prose);
      const theirsFolded = shut(b.prose);
      // And the first mount saves, by opening its box again. The write goes to its own host and
      // names its own document's keys, so an empty set here and nothing at all are different
      // answers and are reported as such.
      const asked = a.sent.length;
      collapse(a.prose);
      const write = a.sent.slice(asked).find((m) => m.type === 'commentFoldsWrite');
      const keys = write ? Object.keys(folds(write)) : null;
      const ok = folded && stillFolded && theirsFolded && keys !== null && !keys.includes(theirsKey);
      const detail =
        `first box collapsed by its own host: ${folded}; still collapsed after the second mount answered: ${stillFolded}; ` +
        `second box collapsed by its own host: ${theirsFolded}; the first mount's own write: ${keys === null ? 'none sent' : JSON.stringify(keys)}; ` +
        `the second document's key is ${theirsKey}`;
      unmount(a);
      unmount(b);
      return { ok, detail };
    },
  },
  {
    /*
     * CONTROL for the resolution itself, rather than for one module's state.
     *
     * Most reads find their mount through the facet in the editor's own configuration, which a
     * detached root cannot break. The handful that are handed an element instead walk up the DOM to
     * a registered root, and that walk is the half with somewhere to fall through to: with nothing
     * matched the read takes the page's scope, which is the right answer on a page with one editor
     * and the defect on a page with two.
     *
     * So this asks an element-shaped read directly, and asserts that `mountScope.ts` said nothing
     * while it ran. The warning is the only thing that tells a fallback from a resolution, and it
     * has already earned its place: it caught this file opening its mounts on roots that contained
     * no editor, which every other scenario here survived.
     */
    name: 'two mounts: a read handed an element inside the first editor resolves to the first mount, with nothing falling back',
    run: () => {
      fresh();
      const a = mount(WITH_COMMENT('alpha'));
      const b = mount(WITH_COMMENT('beta'));
      setBlockRefHost({ getFileName: () => 'alpha.md', copyToClipboard: () => {} }, a.scope);
      setBlockRefHost({ getFileName: () => 'beta.md', copyToClipboard: () => {} }, b.scope);
      // The precondition: the element really is inside the mount's root, or the walk below is about
      // a tree the mount does not own and the answer means nothing.
      const inside = a.root.contains(a.prose.view.contentDOM);
      const { value, fellBack } = fallbacksDuring(() => ({
        fromElement: blockRefHost(a.prose.view.contentDOM)?.getFileName() ?? null,
        fromView: blockRefHost(a.prose.view)?.getFileName() ?? null,
        theirs: blockRefHost(b.prose.view.contentDOM)?.getFileName() ?? null,
      }));
      const ok =
        inside &&
        value.fromElement === 'alpha.md' &&
        value.fromView === 'alpha.md' &&
        value.theirs === 'beta.md' &&
        fellBack === 0;
      const detail =
        `the element is inside the first mount's root: ${inside}; from an element ${value.fromElement}, ` +
        `from the view ${value.fromView}, the second editor's ${value.theirs}; ` +
        `${fellBack} read(s) fell back to the page`;
      setBlockRefHost(null, a.scope);
      setBlockRefHost(null, b.scope);
      unmount(a);
      unmount(b);
      return { ok, detail };
    },
  },
  {
    /*
     * CONTROL. Two toolbars, and a button in the **first** one asked to follow its own editor.
     * `reflectors` was a module-level array that `mountToolbar` emptied, so the second toolbar's
     * build took the first's reflectors away and its buttons froze where they were.
     */
    name: "two mounts: a button in the first toolbar follows the first editor's state",
    run: () => {
      fresh();
      const a = mountWithBar('Plain **bold** words.\n');
      const b = mountWithBar('Nothing bold here.\n');
      // The precondition. With the caret outside the bold run the button must read inactive, or
      // the assertion below cannot tell a reflector that ran from one that never had to.
      a.prose.select(1);
      refreshToolbar(a.prose.view, a.scope);
      const before = active(button(a, 'bold'));
      // Inside the bold run, in the first editor, and the first toolbar asked to catch up.
      a.prose.select(9);
      refreshToolbar(a.prose.view, a.scope);
      const after = active(button(a, 'bold'));
      // The second toolbar is the one that works against the defect, so it is read as well: a
      // scenario that looked only at it would pass either way.
      const theirs = active(button(b, 'bold'));
      const ok = before === false && after === true && theirs === false;
      const detail = `first toolbar's Bold: ${before} with the caret outside the run, ${after} inside it; second toolbar's Bold: ${theirs}`;
      unmountBar(a);
      unmountBar(b);
      return { ok, detail };
    },
  },
  {
    /*
     * CONTROL. The two button references, which a second `mountToolbar` took over outright. The
     * heading-list button is drawn from outside the mount, because the setting it follows comes
     * back from the host a round trip later.
     */
    name: 'two mounts: the heading-list button drawn for the first mount is the first toolbar"s',
    run: () => {
      fresh();
      const a = mountWithBar('A document.\n');
      const b = mountWithBar('Another document.\n');
      const before = a.bar.querySelector('.sheaf-tb-toc')?.classList.contains('is-active') === true;
      reflectTableOfContents('shown', a.scope);
      const mine = a.bar.querySelector('.sheaf-tb-toc')?.classList.contains('is-active') === true;
      const theirs = b.bar.querySelector('.sheaf-tb-toc')?.classList.contains('is-active') === true;
      const states = `${tocButtonState(a.scope)}/${tocButtonState(b.scope)}`;
      const ok = before === false && mine === true && theirs === false && states === 'shown/hidden';
      const detail = `first button active: ${before} before, ${mine} after; second button active: ${theirs}; states first/second ${states}`;
      unmountBar(a);
      unmountBar(b);
      return { ok, detail };
    },
  },
];
