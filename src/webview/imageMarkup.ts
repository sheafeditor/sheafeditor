/*
 * Reading and writing image markup: the forms, the props behind them, and how an address resolves.
 *
 * Two source forms are recognised:
 *   - Markdown:  ![alt](url "title")
 *   - HTML:      <img src alt width height align>, optionally wrapped in
 *                <p align="center">…</p> for centering,
 *                <figure><img …><figcaption>…</figcaption></figure> for captions,
 *                and <div align="center"> around the figure when it is both.
 *
 * Plain images (no width / align / caption) round-trip as clean Markdown; the moment you resize,
 * align or caption one it upgrades to a single-line HTML snippet — the "HTML for full control"
 * contract. Everything emitted stays on one line so the live-preview ViewPlugin can replace it with
 * a single widget.
 *
 * **Nothing here draws anything, and that is the whole point of the file.** It was one module with
 * three jobs: this half, the ingestion in `imageIngest.ts`, and the widget in `images.ts`. Four
 * modules only ever wanted this half — `linkTarget.ts` for a parser, `tables.ts` for an address,
 * `toolbar.ts` through the picker, and `main.ts` for the base URI — and every one of them was
 * downloading the widget, the resize handles and the caption machinery to get it.
 *
 * The only CodeMirror this needs is a type: `imageNodeAt` reads a syntax tree to find the source
 * range behind a drawn image, which is a question about the document rather than about the screen.
 */

import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

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

/*
 * `https:` and not `http:`, because the two hosts' own policies allow only those two and
 * an address this lets through that they then refuse is the worst of both: the picture is
 * drawn as an element, the policy blocks the fetch, and the reader gets a broken image
 * where the promise is that an address the page cannot load falls back to its Markdown.
 * Refusing it here is what keeps that promise.
 */
const ABSOLUTE_OK = /^(https:|data:)/i;
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
export function mdDestination(src: string): string {
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

export interface SourceNode {
  from: number;
  to: number;
}

/** Find the image node (Markdown Image or HTML block/tag) covering `pos`. */
export function imageNodeAt(state: EditorState, pos: number): SourceNode | null {
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
