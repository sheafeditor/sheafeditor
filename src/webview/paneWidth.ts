/*
 * How far the pane reaches past the writing column, published as a custom property for the
 * rules that need it.
 *
 * The writing column is `.cm-content`: `max-width: calc(var(--md-content-width) + 2 *
 * var(--md-gutter))`, `margin: 0 auto`, with the gutters as its own padding. On a window
 * wider than that the auto margin leaves room on both sides, outside the element, and
 * nothing inside it can name that room — which is why a table wanting the pane's edge
 * cannot ask for it in CSS alone. A negative margin of one gutter reaches the padding edge
 * and stops.
 *
 * `100vw` is not the answer. It is right in VS Code, where the webview is the pane, and
 * wrong in a browser tab, where the page has a file tree beside it.
 *
 * So the one number is measured and written onto the editor's root, where everything inside
 * inherits it. One observer per editor rather than one per table: the number is a fact about
 * the pane, and a second copy of it would be a second answer to one question.
 */

import { EditorView, ViewPlugin, PluginValue } from '@codemirror/view';

/**
 * The room on one side between the writing column's outer edge and the pane's, in pixels.
 *
 * Zero when the pane is no wider than the column, which is a narrow window, a split editor,
 * or a phone — and the case where every rule reading this has to come out where it is today.
 */
export function paneOverhang(scrollerWidth: number, contentWidth: number): number {
  const room = scrollerWidth - contentWidth;
  /*
   * Rounded down, never up, and the direction is the whole of it. A frame built from this
   * is the column plus twice the number, so half a pixel rounded up makes it a pixel wider
   * than the pane, the editor itself gains a horizontal scrollbar, and the document scrolls
   * sideways — which is the one thing this may never do. Measured: an odd pane width gave
   * `scrollWidth` 1201 against a pane of 1200. Rounded down the frame stops at most a pixel
   * short of the edge, which nobody can see.
   */
  return room > 0 ? Math.floor(room / 2) : 0;
}

/** Keeps `--md-pane-overhang` on the editor's root in step with the pane. */
export const paneWidth = ViewPlugin.fromClass(
  class implements PluginValue {
    private observer: ResizeObserver | null = null;
    private written = -1;

    constructor(readonly view: EditorView) {
      this.measure();
      if (typeof ResizeObserver === 'undefined') return;
      this.observer = new ResizeObserver(() => this.measure());
      this.observer.observe(view.scrollDOM);
    }

    update(): void {
      // The content's width follows the width setting as well as the pane's, and that
      // arrives as a reconfiguration rather than as a resize of the scroller.
      this.measure();
    }

    destroy(): void {
      this.observer?.disconnect();
      this.observer = null;
    }

    private measure(): void {
      /*
       * The content's width fractionally, from its box, rather than `offsetWidth`, which is
       * rounded. A writing column of 708.5 reported as 708 makes the overhang a quarter of a
       * pixel too big on each side, the frame half a pixel wider than the pane, and the
       * editor scrolls sideways. Measured on the corpus: `scrollWidth` 1201 against a pane
       * of 1200, from exactly that half pixel.
       *
       * The scroller's `clientWidth` and not its box, because that is the one that leaves
       * out the vertical scrollbar, which is room the table does not have.
       */
      const next = paneOverhang(this.view.scrollDOM.clientWidth, this.view.contentDOM.getBoundingClientRect().width);
      // Written only when it moves: this runs on every update, and a property set to the
      // value it already holds still invalidates style for the whole subtree.
      if (next === this.written) return;
      this.written = next;
      this.view.dom.style.setProperty('--md-pane-overhang', `${next}px`);
    }
  }
);
