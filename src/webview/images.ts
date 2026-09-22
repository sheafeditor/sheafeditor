/*
 * Image rendering, editing and ingestion.
 *
 * Two source forms are recognised and rendered as one editable widget:
 *   - Markdown:  ![alt](url "title")
 *   - HTML:      <img src alt width height align>, optionally wrapped in
 *                <p align="center">…</p> for centering,
 *                <figure><img …><figcaption>…</figcaption></figure> for captions,
 *                and <div align="center"> around the figure when it is both.
 *
 * Plain images (no width / align / caption) round-trip as clean Markdown; the
 * moment you resize, align or caption one it upgrades to a single-line HTML
 * snippet — the "HTML for full control" contract. Everything we emit stays on a
 * single line so the live-preview ViewPlugin can replace it with one widget.
 *
 * Drag-and-drop and paste ship raw bytes to the extension host, which saves them
 * into an `assets/` folder beside the document and returns a relative path we
 * insert as Markdown.
 */

import { EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { installLinkPaste } from './linkPaste';

export type ImageAlign = 'left' | 'center' | 'right';

export interface ImageProps {
  src: string;
  alt: string;
  title?: string;
  width?: number;
  height?: number;
  align?: ImageAlign;
  caption?: string;
}

// ---- Resource resolution --------------------------------------------------
//
// The host converts the document's directory to a base it sends at init.
// Relative image paths resolve against it; absolute http(s)/data URLs pass
// through; anything else is refused (won't load under the webview CSP anyway).
//
// The VS Code host sends an absolute webview URI, but a base written as a path
// from the site root, such as `/demo/`, is just as reasonable a thing for a
// host to send. `new URL` throws on a base with no scheme, so that form is
// joined by hand. A base that is neither is a host mistake we cannot guess our
// way out of, and it is said once rather than leaving every relative image
// undrawn with nothing logged.

let resourceBaseUri = '';

export function setResourceBaseUri(uri: string): void {
  resourceBaseUri = uri.endsWith('/') ? uri : uri + '/';
}

const ABSOLUTE_OK = /^(https?:|data:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A stand-in origin for joining a relative path onto a base that is a path.
 * `new URL` needs an absolute base, so the origin goes on for the join and
 * comes straight back off; it never reaches the page.
 */
const PATH_JOIN_ORIGIN = 'https://sheaf.invalid';

/** The base already reported, so one host mistake is reported once. */
let reportedBase: string | null = null;

function reportUnusableBase(base: string): void {
  if (reportedBase === base) return;
  reportedBase = base;
  console.warn(
    `Sheaf cannot resolve image paths against the base "${base}", so images written with a ` +
      'relative path are not shown. A base must be an absolute URL or a path starting with "/".'
  );
}

/** Resolve an image src to a URL the webview can load, or null if disallowed. */
export function resolveImageSrc(src: string): string | null {
  if (!src) return null;
  // An address that names a host but no scheme, `//cdn.example.com/logo.png`,
  // is read as https before anything else looks at it. Neither test below
  // recognises one: it is not absolute, and it carries no scheme, so a base
  // that is a path would join it as though it were a path on that base's own
  // origin, drop the host and leave the address naming a different file. An
  // https base already resolves one to exactly this, so reading it here is what
  // keeps every base in agreement.
  const address = src.startsWith('//') ? 'https:' + src : src;
  if (ABSOLUTE_OK.test(address)) return address;
  if (HAS_SCHEME.test(address)) return null; // file:, vscode:, javascript: … — refuse
  const base = resourceBaseUri;
  // No base yet: the init message has not arrived, which is a moment, not a
  // mistake, and the next update draws the image.
  if (!base) return null;
  if (HAS_SCHEME.test(base) || base.startsWith('//')) {
    try {
      return new URL(address, base).toString();
    } catch {
      reportUnusableBase(base);
      return null;
    }
  }
  if (base.startsWith('/')) {
    try {
      const joined = new URL(address, PATH_JOIN_ORIGIN + base);
      return joined.pathname + joined.search + joined.hash;
    } catch {
      reportUnusableBase(base);
      return null;
    }
  }
  reportUnusableBase(base);
  return null;
}

// ---- (De)serialization ----------------------------------------------------

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unesc(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** True when the extra HTML-only attributes force an HTML (non-Markdown) emit. */
function needsHtml(p: ImageProps): boolean {
  return !!(p.width || p.height || p.align || p.caption);
}

/** Escape what would otherwise close the alt text early. */
function escAlt(s: string): string {
  return s.replace(/([\\[\]])/g, '\\$1');
}

/** Undo the backslash escapes CommonMark allows, so the text reads as written. */
function unescMd(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** Whether every parenthesis in an address closes, ignoring escaped ones. */
function parensBalanced(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * An address written the way Markdown reads it back. A space ends the address
 * early, and so does a parenthesis that never closes, so both forms are wrapped
 * in the angle brackets CommonMark provides for exactly this.
 */
function mdDestination(src: string): string {
  return /\s/.test(src) || !parensBalanced(src) ? `<${src}>` : src;
}

/** Serialize props back to a single line of Markdown or HTML. */
export function serializeImage(p: ImageProps): string {
  if (!needsHtml(p)) {
    const title = p.title ? ` "${p.title.replace(/"/g, '\\"')}"` : '';
    return `![${escAlt(p.alt ?? '')}](${mdDestination(p.src)}${title})`;
  }
  const attrs = [`src="${escAttr(p.src)}"`];
  if (p.alt) attrs.push(`alt="${escAttr(p.alt)}"`);
  if (p.title) attrs.push(`title="${escAttr(p.title)}"`);
  if (p.width) attrs.push(`width="${Math.round(p.width)}"`);
  if (p.height) attrs.push(`height="${Math.round(p.height)}"`);
  const img = `<img ${attrs.join(' ')}>`;

  if (p.caption) {
    const figure = `<figure><img ${attrs.join(' ')}><figcaption>${escAttr(p.caption)}</figcaption></figure>`;
    // The alignment rides on a wrapping `<div align>` rather than on the figure
    // itself. `align` on a `<figure>` survives GitHub's sanitiser but draws
    // nothing: HTML's rendering rules map the attribute to `text-align` for
    // `div`, `p` and the headings only, so no browser gives a figure a hint it
    // has no rule for. A `<p align>` is not an option either, because `<figure>`
    // is block-level and closes an open paragraph, so the figure would fall out
    // of the wrapper as the page was parsed. A `<div align>` is what is left,
    // and it is on GitHub's allowlist, so the alignment survives there and the
    // `text-align` it sets is inherited by the picture and the caption both.
    return p.align ? `<div align="${p.align}">${figure}</div>` : figure;
  }
  if (p.align === 'left' || p.align === 'right') {
    return `<img ${attrs.join(' ')} align="${p.align}">`;
  }
  if (p.align === 'center') {
    return `<p align="center">${img}</p>`;
  }
  return img; // width / height only
}

/**
 * Read the destination of a `(…)` address starting at `i`, the character just
 * past the opening paren. CommonMark allows either a `<…>` form or a run of
 * non-space characters whose parentheses balance, so `chart(1).png` is one
 * address rather than one that stops at its first `)`. Returns the address and
 * the offset just past it.
 */
function scanDestination(text: string, i: number): { src: string; end: number } | null {
  if (text[i] === '<') {
    const close = text.indexOf('>', i + 1);
    return close < 0 ? null : { src: text.slice(i + 1, close), end: close + 1 };
  }
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < text.length) {
      j++; // An escaped character is part of the address, whatever it is.
      continue;
    }
    if (/\s/.test(ch)) break;
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break; // The paren that closes the address.
      depth--;
    }
  }
  return j === i || depth !== 0 ? null : { src: text.slice(i, j), end: j };
}

/** Parse a Markdown image `![alt](url "title")`. */
export function parseMarkdownImage(text: string): ImageProps | null {
  const trimmed = text.trim();
  // Alt text runs to its closing bracket, with `\[` and `\]` written through.
  const open = /^!\[((?:\\.|[^\\\]])*)\]\(\s*/.exec(trimmed);
  if (!open) return null;
  const dest = scanDestination(trimmed, open[0].length);
  if (!dest) return null;
  const close = /^(?:\s+"([^"]*)")?\s*\)/.exec(trimmed.slice(dest.end));
  if (!close) return null;
  return { src: dest.src, alt: unescMd(open[1] ?? ''), title: close[1] };
}

function attrOf(tag: string, name: string): string | undefined {
  const dq = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  if (dq) return dq[1];
  const sq = new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag);
  if (sq) return sq[1];
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag);
  return bare ? bare[1] : undefined;
}

/** Parse an HTML image snippet (bare <img>, <p align>, or <figure>). */
export function parseHtmlImage(text: string): ImageProps | null {
  const imgM = /<img\b[^>]*>/i.exec(text);
  if (!imgM) return null;
  const tag = imgM[0];
  const src = attrOf(tag, 'src');
  if (!src) return null;

  const props: ImageProps = { src: unesc(src), alt: unesc(attrOf(tag, 'alt') ?? '') };

  const title = attrOf(tag, 'title');
  if (title) props.title = unesc(title);

  const w = attrOf(tag, 'width');
  if (w && /^\d+/.test(w)) props.width = parseInt(w, 10);
  const h = attrOf(tag, 'height');
  if (h && /^\d+/.test(h)) props.height = parseInt(h, 10);

  let align = attrOf(tag, 'align');
  // A lone image is centred by the `<p align>` wrapper READMEs use; a captioned
  // one by a `<div align>`, because a paragraph cannot hold a `<figure>`.
  const wrapAlign = /<(?:p|div)\b[^>]*\balign\s*=\s*["']?(left|center|right)/i.exec(text);
  if (wrapAlign) align = wrapAlign[1];
  if (align && /^(left|center|right)$/i.test(align)) props.align = align.toLowerCase() as ImageAlign;

  const cap = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(text);
  if (cap) props.caption = unesc(cap[1].trim());

  return props;
}

/**
 * Locate the image markup inside a chunk of HTML (an HTMLBlock may also contain
 * trailing text when the author omitted a blank line). Returns the span offsets
 * plus parsed props so only the markup is replaced.
 */
export function matchHtmlImage(text: string): { start: number; end: number; props: ImageProps } | null {
  // Widest first: a wrapper left behind would sit in the document as loose HTML
  // beside the widget, and the next rewrite would replace only what it matched.
  let m =
    /<(p|div)\b[^>]*>\s*<figure\b[^>]*>[\s\S]*?<\/figure>\s*<\/\1>/i.exec(text) ||
    /<figure\b[^>]*>[\s\S]*?<\/figure>/i.exec(text) ||
    /<(p|div)\b[^>]*>\s*<img\b[^>]*>\s*<\/\1>/i.exec(text) ||
    /<img\b[^>]*>/i.exec(text);
  if (!m) return null;
  const props = parseHtmlImage(m[0]);
  if (!props) return null;
  return { start: m.index, end: m.index + m[0].length, props };
}

// ---- Source-range lookup for a live widget --------------------------------

interface SourceNode {
  from: number;
  to: number;
}

/** Find the image node (Markdown Image or HTML block/tag) covering `pos`. */
function imageNodeAt(state: EditorState, pos: number): SourceNode | null {
  let found: SourceNode | null = null;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter: (node) => {
      if (node.name === 'Image' || node.name === 'HTMLBlock' || node.name === 'HTMLTag') {
        const text = state.sliceDoc(node.from, node.to);
        if (node.name === 'Image' || /<img\b/i.test(text)) {
          // For HTML blocks, narrow to the markup span.
          if (node.name === 'Image') {
            found = { from: node.from, to: node.to };
          } else {
            const mm = matchHtmlImage(text);
            found = mm
              ? { from: node.from + mm.start, to: node.from + mm.end }
              : { from: node.from, to: node.to };
          }
        }
      }
    },
  });
  return found;
}

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

/**
 * The props a toolbar action would rewrite, or null when the source cannot be
 * rewritten in place. A reference-style `![alt][label]` is the case that
 * matters: its address lives on a definition line elsewhere, so there is
 * nothing here to change without rewriting the author's chosen form into a
 * different one. Both the editing path and the widget that offers the controls
 * ask this same question, so neither can offer what the other will not do.
 */
export function editableProps(raw: string): ImageProps | null {
  return parseHtmlImage(raw) ?? parseMarkdownImage(raw);
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
    if (this.props.width) img.style.width = `${this.props.width}px`;
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

// ---- Drag / drop / paste ingestion ----------------------------------------

type VsPost = (message: unknown) => void;

let seq = 0;
const pending = new Map<string, { resolve: (path: string) => void; reject: (err: Error) => void }>();
/** Set once at init so widget actions (e.g. Replace) can reach the host. */
let ingestPost: VsPost | null = null;

/** Ask the host to persist an image; resolves with the workspace-relative path. */
function requestSaveImage(post: VsPost, name: string, data: string): Promise<string> {
  const id = `img-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type: 'saveImage', id, name, data });
  });
}

/** Encode a file and hand it to the host; resolves with the workspace-relative path. */
async function saveImageFile(file: File | Blob): Promise<string> {
  if (!ingestPost) throw new Error('image ingestion not ready');
  const anyFile = file as File;
  const stamp = String(Date.now()).slice(-6);
  const name = anyFile.name || `pasted-image-${stamp}${extFor(file, '')}`;
  const data = await fileToBase64(file);
  return requestSaveImage(ingestPost, name, data);
}

/** Host reply router — called from main.ts's message handler. */
export function handleImageSaved(id: string, path?: string, error?: string): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (error || !path) p.reject(new Error(error ?? 'save failed'));
  else p.resolve(path);
}

async function fileToBase64(file: File | Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** The part of a thrown error worth reading. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
}

function extFor(file: File | Blob, fallbackName: string): string {
  const fromName = /\.[a-z0-9]+$/i.exec(fallbackName)?.[0];
  if (fromName) return fromName;
  const mime = file.type.split('/')[1];
  return mime ? `.${mime.replace('+xml', '')}` : '.png';
}

/** Save dropped/pasted image files and insert Markdown at `at`. */
async function ingest(view: EditorView, files: File[], at: number): Promise<void> {
  let cursor = at;
  for (const file of files) {
    let relPath: string;
    try {
      relPath = await saveImageFile(file);
    } catch (err) {
      // The host says why it could not save, in a notification naming the
      // reason, so nothing is inserted and nothing more is said here. Every
      // reason a save fails is about the document rather than this one file, so
      // the files behind it would fail the same way and stack up the same
      // notification; the run stops instead.
      console.warn(`Sheaf could not save a pasted image: ${reasonOf(err)}`);
      break;
    }
    const line = view.state.doc.lineAt(Math.min(cursor, view.state.doc.length));
    const prefix = cursor === line.from ? '' : '\n';
    // The image needs a line of its own, and the break that starts one can
    // double as the break that ends it: when the caret is at the end of a line
    // the document already continues on the next, so adding a second break
    // would open a blank line the person never typed.
    const suffix = prefix && view.state.doc.sliceString(cursor, cursor + 1) === '\n' ? '' : '\n';
    const alt = baseName(relPath.split('/').pop() ?? relPath);
    const md = `${prefix}![${alt}](${relPath})${suffix}`;
    view.dispatch({
      changes: { from: cursor, to: cursor, insert: md },
      selection: { anchor: cursor + md.length },
    });
    cursor += md.length;
  }
  view.focus();
}

/**
 * Save image files through the host and link them at the caret, the way a pasted
 * image is. Resolves once every file has been saved and inserted (or skipped).
 */
export function insertImageFiles(view: EditorView, files: File[]): Promise<void> {
  return ingest(view, files, view.state.selection.main.head);
}

/** Open the platform file picker for images and insert what the person chooses. */
export function pickImage(view: EditorView): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    input.remove();
    if (files.length) void insertImageFiles(view, files);
  });
  // Dismissing the picker fires `cancel` instead of `change`.
  input.addEventListener('cancel', () => input.remove());
  input.click();
}

function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files && dt.files.length) {
    for (const f of Array.from(dt.files)) if (f.type.startsWith('image/')) out.push(f);
  }
  if (!out.length && dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

/** Attach drop/paste handlers so images become saved files + Markdown. */
export function setupImageIngestion(view: EditorView, post: VsPost): void {
  ingestPost = post;
  const dom = view.dom;

  // A web address pasted over chosen words links them rather than replacing them.
  // It has to be decided further up than the handlers below: CodeMirror answers a
  // paste on the content itself, so by the time one has reached this element the
  // words are already gone.
  installLinkPaste(view);

  dom.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  dom.addEventListener('drop', (e) => {
    const files = imageFilesFrom(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
    void ingest(view, files, pos);
  });

  dom.addEventListener('paste', (e) => {
    // Only hijack when there's an image and no competing plain text (so pasting
    // Markdown / prose still goes through CodeMirror normally).
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text.trim()) return;
    const files = imageFilesFrom(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void ingest(view, files, view.state.selection.main.head);
  });
}
