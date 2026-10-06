/*
 * Drawing a picture where its markup is: the widget, the resize handles, the alignment and caption
 * controls, and the selection that makes an image behave like a character.
 *
 * This is one of three files that were one. `imageMarkup.ts` reads and writes the markup and knows
 * nothing about the screen; `imageIngest.ts` gets bytes into the document through a drop, a paste or
 * the picker. **This half is the expensive one**, and until the split every module that wanted a
 * parser or a picker downloaded it: `linkTarget.ts`, `tables.ts`, `toolbar.ts` and `main.ts` all
 * took one or two functions and got the widget with them. `livePreview.ts` is now the only module
 * that reaches this file, which is correct, because drawing is what it does.
 *
 * The dependency direction is a chain. This reaches `imageMarkup.ts` for the forms and the props,
 * and `imageIngest.ts` for `saveImageFile`, which the Replace action needs. Neither reaches back.
 */

import { EditorView, WidgetType } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { saveImageFile } from './imageIngest';
import { editableProps, ImageAlign, ImageProps, imageNodeAt, resolveImageSrc, serializeImage, SourceNode } from './imageMarkup';

// ---- Selection over a picture ---------------------------------------------
//
// The editor paints a selection behind the content, and an opaque picture
// covers it, so a selected image looked exactly like an unselected one. An
// image whose whole source a selection covers has its wrapper marked instead,
// and the stylesheet draws a ring on top of it. The mark is set on the live
// DOM after each update rather than carried on the widget, so a selection
// change never rebuilds a picture, and a widget whose DOM the editor reused or
// redrew is marked again on the same update.

/** Views that marked an image on their last pass, so an idle caret costs nothing. */
const markedImages = new WeakSet<EditorView>();

function markSelectedImages(view: EditorView): void {
  const { state } = view;
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length && !markedImages.has(view)) return;
  let any = false;
  for (const wrap of Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.md-img-wrap'))) {
    // A cell editor nested inside this one marks its own images.
    if (wrap.closest('.cm-content') !== view.contentDOM) continue;
    let selected = false;
    if (ranges.length) {
      let node: SourceNode | null = null;
      try {
        node = imageNodeAt(state, view.posAtDOM(wrap));
      } catch {
        node = null;
      }
      selected = !!node && ranges.some((r) => r.from <= node!.from && r.to >= node!.to);
    }
    wrap.classList.toggle('is-selected', selected);
    any ||= selected;
  }
  if (any) markedImages.add(view);
  else markedImages.delete(view);
}

/** Marks every image the selection covers; the ring is drawn by media/webview.css. */
export const imageSelection: Extension = EditorView.updateListener.of((update) => {
  if (update.selectionSet || update.docChanged || update.viewportChanged || markedImages.has(update.view)) {
    markSelectedImages(update.view);
  }
});

// ---- Editing widget -------------------------------------------------------

const WIDTH_PRESETS: { label: string; width?: number }[] = [
  { label: 'S', width: 240 },
  { label: 'M', width: 420 },
  { label: 'L', width: 640 },
  { label: 'Full', width: undefined },
];

/**
 * Set an image's width, keeping any height it carries in proportion to the
 * width it was written with. Sheaf draws an image from its width alone, so a
 * height left at its old value looks right here and squashes the picture in
 * every renderer that honours both attributes. Clearing the width clears the
 * height with it, rather than leaving one with nothing to be in proportion to.
 */
function withWidth(p: ImageProps, width?: number): ImageProps {
  const next: ImageProps = { ...p, width };
  if (p.height) next.height = width && p.width ? Math.round((width * p.height) / p.width) : undefined;
  return next;
}

/** Rewrite the source image at `dom`'s position by mutating its parsed props. */
function rewriteImage(view: EditorView, dom: HTMLElement, mutate: (p: ImageProps) => ImageProps): void {
  const pos = view.posAtDOM(dom);
  const node = imageNodeAt(view.state, pos);
  if (!node) return;
  const raw = view.state.sliceDoc(node.from, node.to);
  const current = editableProps(raw);
  if (!current) return;
  const next = mutate({ ...current });
  const insert = serializeImage(next);
  if (insert === raw) return;
  view.dispatch({ changes: { from: node.from, to: node.to, insert } });
  view.focus();
}

/** Pick a new image file and swap it into the image at `dom`, keeping its size/align/caption. */
function replaceImage(view: EditorView, dom: HTMLElement): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    void saveImageFile(file)
      .then((rel) => rewriteImage(view, dom, (p) => ({ ...p, src: rel })))
      .catch(() => {});
  });
  input.click();
}

function svgIcon(path: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'md-img-icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'currentColor');
  svg.appendChild(p);
  return svg;
}

/** The corner bracket drawn inside the resize handle: a halo stroke, then the grip over it. */
function cornerGrip(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('class', 'md-img-grip');
  svg.setAttribute('aria-hidden', 'true');
  for (const cls of ['md-img-grip-halo', 'md-img-grip-line']) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M15 6V15H6');
    p.setAttribute('class', cls);
    svg.appendChild(p);
  }
  return svg;
}

const ALIGN_ICONS: Record<ImageAlign, string> = {
  left: 'M1 2h14v2H1zM1 6h9v2H1zM1 10h14v2H1zM1 14h9v2H1z',
  center: 'M1 2h14v2H1zM3 6h10v2H3zM1 10h14v2H1zM3 14h10v2H3z',
  right: 'M1 2h14v2H1zM6 6h9v2H6zM1 10h14v2H1zM6 14h9v2H6z',
};

// Two curved swap arrows.
const REPLACE_ICON = 'M4 3h6a3 3 0 0 1 3 3v1h-2V6a1 1 0 0 0-1-1H4v2L1 4l3-3zM12 13H6a3 3 0 0 1-3-3V9h2v1a1 1 0 0 0 1 1h6V9l3 3-3 3z';

class ImageWidget extends WidgetType {
  constructor(
    readonly resolvedSrc: string,
    readonly props: ImageProps,
    readonly inline = false,
    // Not `editable`: WidgetType declares that name as a getter, and shadowing
    // it with a constructor property throws when the widget is built.
    readonly rewritable = true
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return (
      other.resolvedSrc === this.resolvedSrc &&
      other.inline === this.inline &&
      other.rewritable === this.rewritable &&
      JSON.stringify(other.props) === JSON.stringify(this.props)
    );
  }

  get estimatedHeight(): number {
    // An image inside a sentence takes the line's height, which is the
    // editor's to measure, not ours to guess at.
    if (this.inline) return -1;
    return this.props.caption ? 280 : 240;
  }

  ignoreEvent(event: Event): boolean {
    const t = event.target as HTMLElement | null;
    // Let clicks on our chrome (toolbar / resize handle) run our handlers;
    // clicks on the bare image fall through to CodeMirror (cursor / dbl-click).
    return !!t && !!t.closest('.md-img-toolbar, .md-img-handle');
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'md-img-wrap';
    if (this.props.align) wrap.classList.add(`md-img-align-${this.props.align}`);
    // The wrapper is a block by default, which breaks the sentence an icon or
    // badge is written into onto three lines. This class puts it in the line
    // instead; the rule for it is in media/webview.css.
    if (this.inline) wrap.classList.add('md-img-inline');

    const fig = document.createElement('span');
    fig.className = 'md-img-fig';

    // The frame is exactly the picture's box, caption excluded, so the resize
    // grip sits on the picture's corner rather than beside the caption below it.
    const frame = document.createElement('span');
    frame.className = 'md-img-frame';

    const img = document.createElement('img');
    img.className = 'md-img';
    img.src = this.resolvedSrc;
    img.alt = this.props.alt;
    /*
     * The size the author wrote, whichever of the two they wrote.
     *
     * A width alone is the usual case and the one every control here produces. A height alone is
     * what arrives from somewhere else — it is valid HTML, it is what GitHub and every previewer
     * draw from, and it is what a person gets when they paste an `<img>` in. It was parsed, kept
     * on the props and written back out faithfully, and never reached the element, so a picture
     * sized to 90 pixels tall was drawn across the whole column with nothing to say why.
     *
     * The height is applied as written rather than turned into a width from the picture's aspect
     * ratio once it loads. Converting would be inventing a number nobody typed, and the next
     * resize would write that invention into the file; applying what is there keeps the drawing
     * and the document saying the same thing, which is the rule everywhere else here.
     *
     * Both together is still the width's job, because that is what `withWidth` keeps in
     * proportion and what a resize writes. A height beside a width would fight it.
     */
    if (this.props.width) img.style.width = `${this.props.width}px`;
    else if (this.props.height) img.style.height = `${this.props.height}px`;
    img.addEventListener('load', () => view.requestMeasure());
    img.addEventListener('error', () => wrap.classList.add('is-broken'));
    frame.appendChild(img);
    fig.appendChild(frame);

    if (this.props.caption) {
      const cap = document.createElement('span');
      cap.className = 'md-figcaption';
      cap.textContent = this.props.caption;
      fig.appendChild(cap);
    }

    // The resize handle, the width presets, the alignment buttons and the rest
    // are offered only where a toolbar action can actually rewrite the source.
    // A control that does nothing when clicked is the bug; one that is not
    // offered is an honest limit.
    if (this.rewritable) frame.appendChild(this.buildHandle(view, img));
    wrap.appendChild(fig);
    if (this.rewritable) wrap.appendChild(this.buildToolbar(view, wrap));
    return wrap;
  }

  /**
   * Bottom-right drag handle for freeform width. The element is a transparent
   * hit box with the cursor across all of it; what is drawn inside is a corner
   * bracket in the link colour over a halo in the editor's background colour,
   * so it reads as a grip on a white, a black or a busy picture alike.
   */
  private buildHandle(view: EditorView, img: HTMLImageElement): HTMLElement {
    const handle = document.createElement('span');
    handle.className = 'md-img-handle';
    handle.title = 'Drag to resize';
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', 'Resize image');
    handle.appendChild(cornerGrip());
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = img.getBoundingClientRect().width;
      handle.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent): void => {
        const w = Math.max(48, Math.round(startW + (ev.clientX - startX)));
        img.style.width = `${w}px`;
        view.requestMeasure();
      };
      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        const w = Math.round(img.getBoundingClientRect().width);
        rewriteImage(view, img, (p) => withWidth(p, w));
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
    return handle;
  }

  /** Floating control strip: width presets, alignment, alt, caption. */
  private buildToolbar(view: EditorView, wrap: HTMLElement): HTMLElement {
    const bar = document.createElement('span');
    bar.className = 'md-img-toolbar';

    const btn = (content: string | Node, title: string, onClick: () => void, active = false): HTMLElement => {
      const b = document.createElement('button');
      b.className = 'md-img-btn' + (active ? ' is-active' : '');
      b.title = title;
      b.type = 'button';
      if (typeof content === 'string') b.textContent = content;
      else b.appendChild(content);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    };

    for (const preset of WIDTH_PRESETS) {
      bar.appendChild(
        btn(preset.label, `Width: ${preset.label}`, () =>
          rewriteImage(view, wrap, (p) => withWidth(p, preset.width))
        )
      );
    }

    const sep = (): HTMLElement => {
      const s = document.createElement('span');
      s.className = 'md-img-sep';
      return s;
    };
    bar.appendChild(sep());

    for (const align of ['left', 'center', 'right'] as ImageAlign[]) {
      bar.appendChild(
        btn(
          svgIcon(ALIGN_ICONS[align]),
          `Align ${align}`,
          () =>
            rewriteImage(view, wrap, (p) => ({ ...p, align: p.align === align ? undefined : align })),
          this.props.align === align
        )
      );
    }

    bar.appendChild(sep());
    bar.appendChild(
      btn('Alt', 'Edit alt text', () => this.promptText(view, wrap, bar, 'alt', 'Alt text', this.props.alt))
    );
    bar.appendChild(
      btn(
        this.props.caption ? 'Caption ✓' : 'Caption',
        'Edit caption',
        () => this.promptText(view, wrap, bar, 'caption', 'Caption', this.props.caption ?? '')
      )
    );
    bar.appendChild(sep());
    bar.appendChild(btn(svgIcon(REPLACE_ICON), 'Replace image file', () => replaceImage(view, wrap)));
    return bar;
  }

  /** Inline text editor (webviews can't use window.prompt). */
  private promptText(
    view: EditorView,
    wrap: HTMLElement,
    bar: HTMLElement,
    key: 'alt' | 'caption',
    placeholder: string,
    initial: string
  ): void {
    const prev = bar.style.display;
    bar.style.display = 'none';
    const editor = document.createElement('span');
    editor.className = 'md-img-editing';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'md-img-input';
    input.placeholder = placeholder;
    input.value = initial;
    editor.appendChild(input);
    wrap.appendChild(editor);
    input.focus();
    input.select();

    const close = (): void => {
      editor.remove();
      bar.style.display = prev;
    };
    const commit = (): void => {
      const value = input.value.trim();
      rewriteImage(view, wrap, (p) => ({ ...p, [key]: value || undefined }));
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('blur', close);
  }
}

/**
 * Build the widget for given props, or null if the src can't be rendered.
 * `inline` draws it inside a line of text rather than as its own block, and
 * `rewritable` says whether its source form can be rewritten, which decides
 * whether the editing controls are offered at all.
 */
export function imageWidgetFor(props: ImageProps, inline = false, rewritable = true): ImageWidget | null {
  const resolved = resolveImageSrc(props.src);
  if (!resolved) return null;
  return new ImageWidget(resolved, props, inline, rewritable);
}

