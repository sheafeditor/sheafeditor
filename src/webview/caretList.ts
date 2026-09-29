/**
 * The rules shared by every list that opens at the caret: the slash menu, and the
 * addresses and headings offered while a link is typed.
 *
 * Such a list is drawn in the page rather than in the document, at coordinates read
 * from the editor once. That leaves it with no idea that the text it was placed
 * beside can move. Scrolling is how it moves, and a scroll is not an edit or a
 * selection change, so nothing a view plugin watches by default says it happened.
 *
 * Both lists had the same two faults because both had the same one line. This is
 * where the answer lives now, so that the third list is written with it rather than
 * without it.
 */

import { EditorView } from '@codemirror/view';

/**
 * Put a list that opened at the caret just below the line at `coords`, or above it
 * when there is no room below, kept inside the window, with its highlighted row in view.
 */
export function placeListAt(dom: HTMLElement, coords: { left: number; top: number; bottom: number }): void {
  const height = dom.offsetHeight;
  const below = coords.bottom + 4;
  const top = below + height > window.innerHeight && coords.top - height - 4 > 0 ? coords.top - height - 4 : below;
  dom.style.left = `${Math.max(4, Math.min(coords.left, window.innerWidth - dom.offsetWidth - 4))}px`;
  dom.style.top = `${Math.max(4, top)}px`;
  dom.querySelector('.is-selected')?.scrollIntoView?.({ block: 'nearest' });
}

/** True when the line the list belongs to is no longer inside the editor. */
function outOfSight(view: EditorView, coords: { top: number; bottom: number }): boolean {
  const box = view.scrollDOM.getBoundingClientRect();
  return coords.bottom < box.top || coords.top > box.bottom;
}

/**
 * Draw the list beside its line, or say that it should close because that line has
 * gone. Returns true when it was drawn, which is what the caller remembers as
 * `placedBefore` next time.
 *
 * `coords` is null when the editor cannot measure the position, which happens once it
 * has scrolled out of what the editor draws at all. That only means the line has gone
 * if the list was ever placed: before that, a list still being opened has simply not
 * been measured yet, and closing it then would mean it never appeared.
 *
 * The close is handed back rather than done here, and callers defer it, because this
 * runs inside a measure, where dispatching would be a change made while the view is
 * reading its own layout.
 */
export function placeOrClose(
  view: EditorView,
  dom: HTMLElement,
  coords: { left: number; top: number; bottom: number } | null,
  placedBefore: boolean,
  close: () => void
): boolean {
  if (placedBefore && (!coords || outOfSight(view, coords))) {
    close();
    return false;
  }
  if (!coords) return false;
  placeListAt(dom, coords);
  return true;
}

/**
 * Watch for the document scrolling under a list, and draw it again where its line has
 * moved to.
 *
 * Scroll events do not bubble, so this listens while capturing, which sees the
 * editor's scroller and the page's alike. A scroll inside the list itself is the
 * person looking down a long list and must leave it where it is.
 */
export function whileScrolling(dom: () => HTMLElement | null, redraw: () => void): { stop: () => void } {
  const onScroll = (event: Event): void => {
    const list = dom();
    const target = event.target as Node | null;
    if (list && !(target && list.contains(target))) redraw();
  };
  document.addEventListener('scroll', onScroll, true);
  return { stop: () => document.removeEventListener('scroll', onScroll, true) };
}
