/*
 * What the mouse does to a link, in one place, for every editor that holds one.
 *
 * A plain click opens the link. A right-click opens its popover, with the words and the
 * address both editable. Cmd or Ctrl and a click still opens, because fingers already know
 * it. A drag that begins on a link selects instead, because a click is a press and a release
 * with nothing moving between them.
 *
 * ## Why a press and a release rather than a click
 *
 * A press on a link that then moves is somebody selecting a range that happens to start on a
 * link, and taking the press would make dragging through a link impossible. So the press
 * starts a selection as it always did and is only remembered, and the release opens the link
 * only if the pointer did not move and came up on the same link. Released elsewhere, or after
 * a drag, the link is left alone and what happened is a selection.
 *
 * The closed-cell version of this reasoning is in `tables.ts` (`pressOnLink`), which got here
 * first, for a grid that has no caret to place. This is the same shape for an editor that
 * does: prose, and the small editor an open table cell is.
 *
 * ## What this gives up, deliberately
 *
 * There is no mouse gesture that selects exactly a link's words and nothing else. Extending a
 * selection through a link works, and so does selecting a paragraph that contains one, because
 * both move the pointer. Picking out the anchor text alone does not, and the answer is the
 * popover's text field rather than a second gesture nobody would find.
 */

import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { inlineLinkAt } from './floatingState';
import { editLinkInPopover } from './linkPopover';
import { linkAddressAt, openLink } from './linkTarget';

/** A link a press landed on, waiting for the release that decides whether it opens. */
export interface HeldLink {
  address: string;
  x: number;
  y: number;
}

/**
 * How far the pointer may travel between press and release and still be a click.
 *
 * Not zero: a press and release by hand moves a pixel or two, and requiring exactness would
 * make the gesture fail for some people and not others. Small enough that a deliberate drag,
 * which is what this has to be told apart from, always exceeds it.
 */
const CLICK_SLOP = 4;

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/**
 * Whether `pos` is inside a picture rather than a link.
 *
 * `linkAddressAt` answers for an image too, which is right for the Cmd-click that has always
 * opened one and wrong for a plain click: a picture is a thing in the document, and clicking
 * it took the person to VS Code's image preview and away from what they were reading. Found by
 * a real-window scenario that selects across an image and instead ended up with the `.png`
 * open in a second tab.
 */
function imageAt(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'Image') return true;
    if (node.name === 'HTMLBlock' || node.name === 'HTMLTag') {
      if (/<img\b/i.test(state.sliceDoc(node.from, node.to))) return true;
    }
  }
  return false;
}

/** The address of the link under a pointer, or null where there is none or no layout to ask. */
export function linkAtPointer(view: EditorView, e: { clientX: number; clientY: number }): string | null {
  let pos: number | null = null;
  try {
    pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  } catch {
    return null; // no layout to hit-test against
  }
  return pos == null ? null : linkAddressAt(view.state, pos);
}

/** The same, for the gestures a picture must not answer: everything but the modifier. */
function followableAtPointer(view: EditorView, e: { clientX: number; clientY: number }): string | null {
  let pos: number | null = null;
  try {
    pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  } catch {
    return null;
  }
  if (pos == null || imageAt(view.state, pos)) return null;
  return linkAddressAt(view.state, pos);
}

/**
 * What a press means for the link under it.
 *
 * `opened` is true only for the modifier, which acts on the press as it always has. A plain
 * press returns a `hold` and does nothing else, so the editor places the caret and begins a
 * selection exactly as it would anywhere.
 */
export function pressOnLinkIn(view: EditorView, e: MouseEvent): { opened: boolean; hold: HeldLink | null } {
  if (e.button !== 0) return { opened: false, hold: null };
  // The modifier keeps opening a picture, which is what it has always done. A plain click must
  // not: clicking a picture in the document should not take you out of the document.
  if (e.metaKey || e.ctrlKey) {
    const address = linkAtPointer(view, e);
    if (!address) return { opened: false, hold: null };
    e.preventDefault();
    openLink(address);
    return { opened: true, hold: null };
  }
  const address = followableAtPointer(view, e);
  if (!address) return { opened: false, hold: null };
  return { opened: false, hold: { address, x: e.clientX, y: e.clientY } };
}

/** Open the held link, if this release is a click on it. True when it opened. */
export function releaseOnLinkIn(view: EditorView, e: MouseEvent, held: HeldLink | null): boolean {
  if (!held) return false;
  if (Math.abs(e.clientX - held.x) > CLICK_SLOP || Math.abs(e.clientY - held.y) > CLICK_SLOP) return false;
  if (followableAtPointer(view, e) !== held.address) return false;
  openLink(held.address);
  return true;
}

/**
 * A right-click on a link opens its popover instead of the context menu. True when it did.
 *
 * A link is then the one place in a document where a right-click gives something other than
 * the menu, which is the cost of the gesture being worth having: editing a link is the one
 * link action the menu never offered, and the menu's other link items (the address, removing
 * it) are all in the popover as well.
 *
 * The caret is moved to the link first. The popover is drawn from editor state, keyed on the
 * link's own start, so it has to be a link the state agrees the selection is in.
 */
export function contextMenuOnLink(view: EditorView, e: MouseEvent): boolean {
  let pos: number | null = null;
  try {
    pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  } catch {
    return false;
  }
  if (pos == null) return false;
  const link = inlineLinkAt(view.state, pos);
  if (!link) return false;
  e.preventDefault();
  e.stopPropagation();
  view.dispatch({ selection: { anchor: link.from, head: link.to } });
  // The address, not the words: a right-click on a link is nearly always about where it goes.
  return editLinkInPopover(view, link, 'url');
}
