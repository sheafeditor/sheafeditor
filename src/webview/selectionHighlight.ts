/*
 * The drawn selection highlight, confined to the selected text.
 *
 * CodeMirror's own selection layer paints a multi-line selection as a box from the
 * first character to the right edge of the content, full-width boxes for every
 * screen line in between, and a box from the content's left edge to the last
 * character. Its edges are the content element's, and in Sheaf that element
 * carries the page gutters around the centred text column, so the highlight ran
 * out into both margins. A selected line break drew a box on the line below too.
 *
 * This layer measures the text itself instead. For each rendered line the
 * selection crosses it takes the client rectangles of the selected DOM, the same
 * boxes the browser would paint its own selection over, and merges them into one
 * box per screen line, running from the first selected character on that line to
 * the last. Whatever sits between two screen lines of one line, the leading, is
 * split between them so a wrapped paragraph reads as one band. Where the
 * selection ends at the start of a line, it stops at the end of the line above
 * (see selectionExtent.ts), so the line below gets no box.
 *
 * The boxes keep CodeMirror's `cm-selectionBackground` class, so every rule that
 * styles or hides the selection (theme.ts, webview.css, block mode) applies to
 * them unchanged. drawSelection() still supplies the cursor and hides the native
 * selection; theme.ts hides its selection layer, which this one replaces.
 */

import { EditorView, layer, RectangleMarker, BlockType, Direction, LayerMarker, ViewUpdate } from '@codemirror/view';
import { coveredEnd } from './selectionExtent';

/** A rectangle in client coordinates. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Merge the client rectangles of one rendered line's selected content into one box
 * per screen line, top to bottom. Rectangles overlap freely (a styled span and the
 * text inside it both report one), so a rectangle joins the screen line whose band
 * holds its vertical middle, or whose middle it holds. Empty rectangles, such as a
 * collapsed range at a line break, draw nothing and are dropped.
 */
export function screenLineBoxes(rects: readonly Box[]): Box[] {
  const rows: Box[] = [];
  const sorted = rects.filter((r) => r.right - r.left > 0.5 && r.bottom > r.top).sort((a, b) => a.top - b.top || a.left - b.left);
  for (const r of sorted) {
    const mid = (r.top + r.bottom) / 2;
    const row = rows.find((w) => {
      const rowMid = (w.top + w.bottom) / 2;
      return (mid >= w.top && mid <= w.bottom) || (rowMid >= r.top && rowMid <= r.bottom);
    });
    if (row) {
      row.left = Math.min(row.left, r.left);
      row.right = Math.max(row.right, r.right);
      row.top = Math.min(row.top, r.top);
      row.bottom = Math.max(row.bottom, r.bottom);
    } else {
      rows.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  return rows.sort((a, b) => a.top - b.top);
}

/**
 * Grow each screen line's box to its line height, as a native selection is drawn,
 * and close the gaps between the screen lines of one rendered line so they meet
 * halfway. A box already taller than the line height (an inline image) keeps its
 * height.
 */
export function fillLineHeight(rows: Box[], lineHeight: number): Box[] {
  const out = rows.map((r) => {
    const pad = Number.isFinite(lineHeight) ? Math.max(0, (lineHeight - (r.bottom - r.top)) / 2) : 0;
    return { left: r.left, right: r.right, top: r.top - pad, bottom: r.bottom + pad };
  });
  for (let i = 1; i < out.length; i++) {
    const above = out[i - 1];
    const below = out[i];
    if (above.bottom !== below.top) above.bottom = below.top = (above.bottom + below.top) / 2;
  }
  return out;
}

/** Where the layer's coordinates start, as CodeMirror's own layers compute it. */
function layerBase(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  const left = view.textDirection === Direction.LTR ? rect.left : rect.right - view.scrollDOM.clientWidth * view.scaleX;
  return { left: left - view.scrollDOM.scrollLeft * view.scaleX, top: rect.top - view.scrollDOM.scrollTop * view.scaleY };
}

/** The client rectangles of the DOM between two document positions, or none. */
function clientRects(view: EditorView, from: number, to: number): Box[] {
  const start = view.domAtPos(from);
  const end = view.domAtPos(to);
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return [];
  }
  return Array.from(range.getClientRects());
}

/** The rendered line element holding `pos`, for its line height. */
function lineElementAt(view: EditorView, pos: number): Element | null {
  const { node } = view.domAtPos(pos);
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return el?.closest('.cm-line') ?? null;
}

/** The selection's boxes, one per screen line it covers text on. */
function selectionBoxes(view: EditorView): Box[] {
  const boxes: Box[] = [];
  const { doc } = view.state;
  const content = view.contentDOM.getBoundingClientRect();
  const style = getComputedStyle(view.contentDOM);
  const columnLeft = content.left + (parseFloat(style.paddingLeft) || 0);
  const columnRight = content.right - (parseFloat(style.paddingRight) || 0);
  for (const range of view.state.selection.ranges) {
    if (range.empty) continue;
    const from = Math.max(range.from, view.viewport.from);
    const to = Math.min(coveredEnd(doc, range), view.viewport.to);
    if (from >= to) continue;
    // A line holding a block widget reports its parts as an array; each is measured alone.
    const blocks = view.viewportLineBlocks.flatMap((line) => (Array.isArray(line.type) ? line.type : [line]));
    for (const block of blocks) {
      if (block.to < from || block.from > to) continue;
      if (block.type !== BlockType.Text) {
        // A block widget (a rendered table, say) has no text to measure: the
        // selection covers the widget, across the text column.
        if (block.to > from && block.from < to) {
          boxes.push({ left: columnLeft, right: columnRight, top: view.documentTop + block.top, bottom: view.documentTop + block.bottom });
        }
        continue;
      }
      const a = Math.max(from, block.from);
      const b = Math.min(to, block.to);
      if (a >= b) continue;
      const rows = screenLineBoxes(clientRects(view, a, b));
      if (!rows.length) continue;
      const line = lineElementAt(view, a);
      const lineHeight = line ? parseFloat(getComputedStyle(line).lineHeight) : NaN;
      boxes.push(...fillLineHeight(rows, lineHeight));
    }
  }
  return boxes;
}

/** Draws the selection over the selected text only, in place of drawSelection()'s layer. */
export const textSelectionLayer = layer({
  above: false,
  class: 'sheaf-selectionLayer',
  markers(view): readonly LayerMarker[] {
    const base = layerBase(view);
    return selectionBoxes(view).map(
      (b) => new RectangleMarker('cm-selectionBackground', b.left - base.left, b.top - base.top, Math.max(0, b.right - b.left), b.bottom - b.top),
    );
  },
  update(update: ViewUpdate): boolean {
    return update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged;
  },
});
