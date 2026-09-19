/*
 * Where a link in the document points, for opening it: the address under a
 * position (resolving reference links through their definitions) and the href
 * an address opens as.
 */

import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { parseHtmlImage } from './images';

type TreeNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

/** Blocks that hold inline content; a reference definition never sits inside one. */
const NO_DEFINITIONS = /^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|FencedCode|CodeBlock|HTMLBlock|Table)$/;

/** An address as written, without the angle brackets a destination with spaces is wrapped in. */
function unwrap(address: string): string {
  const url = address.trim();
  return url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1) : url;
}

/**
 * The characters a destination's backslash escapes stand for. Markdown lets a
 * destination hold a bracket by escaping it, so `a_\(b\)` names the address
 * `a_(b)` and the backslashes are syntax. A backslash before anything but ASCII
 * punctuation is an ordinary character and stays, which keeps a Windows path whole.
 */
function unescape(url: string): string {
  return url.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * The href an address opens as. Backslash escapes resolve to the characters they
 * name. A bare email address gets `mailto:` and a `www.` address gets `https://`,
 * as GitHub links them; anything with a scheme, and any relative path, is left as written.
 */
/**
 * The address a link names, with Markdown's own spelling resolved: the angle
 * brackets a destination holding a space is wrapped in, and the backslashes an
 * escaped bracket is written with. No scheme is added, so this is the address as
 * the document means it rather than the href it opens as. It is what Copy link
 * address puts on the clipboard.
 */
export function linkAddress(address: string): string {
  return unescape(unwrap(address));
}

/**
 * True when an address begins with a URL scheme.
 *
 * A dot is legal in a scheme and some application schemes are spelled with one, but
 * a file name followed by a line number looks exactly the same. `signals.md:28` is
 * what Copy ref puts on the clipboard, and reading it as the scheme `signals.md:`
 * left Sheaf unable to open a reference it had written itself. A path is by far the
 * commoner thing to find in a document, so a dot before the colon means a file. A
 * drive letter carries no dot, so a Windows path is still a scheme and still goes to
 * the browser, exactly as it did.
 */
function hasScheme(url: string): boolean {
  return /^[a-z][a-z0-9+-]*:/i.test(url);
}

export function linkHref(address: string): string {
  const url = linkAddress(address);
  if (hasScheme(url)) return url;
  if (EMAIL.test(url)) return `mailto:${url}`;
  if (/^www\./i.test(url)) return `https://${url}`;
  return url;
}

/** Schemes that must never be handed to a browser, whatever a document asks for. */
const DANGEROUS = /^\s*(javascript|data|vbscript):/i;

/** What opening an address means. */
export type LinkOpen =
  | { kind: 'external'; href: string }
  | { kind: 'document'; address: string }
  | { kind: 'fragment'; id: string }
  | { kind: 'blocked' }
  | { kind: 'none' };

/**
 * How an address opens, decided in one place so the three openers cannot disagree.
 *
 * An address that resolves to a scheme is the browser's to handle, which is what VS
 * Code intercepts. Everything left over is relative, and relative to the *document*,
 * which the webview knows nothing about: its own origin is `vscode-webview://`, so
 * resolving there reaches nothing. Those go to the host, which knows where the file
 * is. An address that is only a fragment names a place in this document and never
 * leaves the webview.
 */
export function linkOpenPlan(address: string): LinkOpen {
  const url = linkAddress(address);
  if (!url) return { kind: 'none' };
  if (url.startsWith('#')) return { kind: 'fragment', id: url.slice(1) };
  const href = linkHref(address);
  // The scheme is checked after resolving, so an address wrapped in `<>` or written
  // with escapes cannot smuggle one past this guard.
  if (DANGEROUS.test(href)) return { kind: 'blocked' };
  if (hasScheme(href)) return { kind: 'external', href };
  return { kind: 'document', address: url };
}

/**
 * The anchor a heading answers to, lowercased with punctuation dropped and spaces
 * turned into hyphens. This is the rule GitHub and the other Markdown renderers
 * use, so it is the one every `#fragment` already written in a repository means:
 * `## Hazard flags` is what `#hazard-flags` points at.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/** Heading nodes, whichever way the document writes them. */
const HEADING = /^(ATXHeading[1-6]|SetextHeading[12])$/;

/**
 * Where a fragment points in this document: the start of the first heading whose
 * anchor matches, or null when no heading answers to it. The first wins, which is
 * what a renderer does with a repeated heading.
 */
export function headingPosition(state: EditorState, id: string): number | null {
  const wanted = headingSlug(id);
  if (!wanted) return null;
  let found = null as number | null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (found !== null) return false;
      if (!HEADING.test(node.name)) return undefined;
      // The heading's own markers are syntax, not part of the name it answers to.
      const text = state
        .sliceDoc(node.from, node.to)
        .split('\n')[0]
        .replace(/^#+\s*/, '')
        .replace(/\s+#+\s*$/, '');
      if (headingSlug(text) === wanted) found = node.from;
      return false;
    },
  });
  return found;
}

type Post = (message: unknown) => void;

let post: Post | null = null;
let revealFragment: ((id: string) => void) | null = null;

/**
 * How to show a place in the document this webview is already displaying. A
 * fragment names a heading here, so nothing needs to be opened and the host is
 * never involved.
 */
export function setFragmentHost(reveal: (id: string) => void): void {
  revealFragment = reveal;
}

/**
 * Where to send an address the host has to resolve. Without one, as on the site's
 * demo, a link to another document has nowhere to go and opening it does nothing.
 */
export function setLinkHost(send: Post): void {
  post = send;
}

/**
 * Open a link's address: the one path every opener goes through, so Cmd-click, the
 * right-click Open link, the popover's open button and a link in a table cell all
 * behave the same way.
 */
export function openLink(address: string): void {
  const plan = linkOpenPlan(address);
  if (plan.kind === 'external') {
    // An anchor click is allowed by the content security policy, and VS Code
    // intercepts the navigation and routes it to the browser.
    const a = document.createElement('a');
    a.href = plan.href;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.click();
    return;
  }
  if (plan.kind === 'document') {
    post?.({ type: 'openLink', address: plan.address });
    return;
  }
  if (plan.kind === 'fragment') {
    revealFragment?.(plan.id);
  }
}

/** CommonMark matches reference labels ignoring case and runs of whitespace. */
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The destination of the first `[label]: destination` definition for `label`, or null. */
export function referenceDestination(state: EditorState, label: string): string | null {
  const key = normalizeLabel(label);
  if (!key || key.startsWith('^')) return null;
  let found = null as string | null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (found !== null || NO_DEFINITIONS.test(node.name)) return false;
      if (node.name !== 'LinkReference') return undefined;
      const labelNode = node.node.getChild('LinkLabel');
      const url = node.node.getChild('URL');
      if (labelNode && url && normalizeLabel(state.sliceDoc(labelNode.from + 1, labelNode.to - 1)) === key) {
        found = unwrap(state.sliceDoc(url.from, url.to));
      }
      return false;
    },
  });
  return found;
}

/** The label a full `[text][label]`, collapsed `[text][]` or shortcut `[text]` reference goes through; null for an inline link. */
function referenceLabel(state: EditorState, link: TreeNode): string | null {
  const marks = link.getChildren('LinkMark');
  if (marks.some((m) => state.sliceDoc(m.from, m.to) === '(')) return null;
  const open = marks[0];
  const close = marks.find((m) => state.sliceDoc(m.from, m.to) === ']');
  if (!open || !close) return null;
  const labelNode = link.getChild('LinkLabel');
  return labelNode && labelNode.to - labelNode.from > 2
    ? state.sliceDoc(labelNode.from + 1, labelNode.to - 1)
    : state.sliceDoc(open.to, close.from);
}

/**
 * The address a Cmd/Ctrl-click at `pos` opens: a link's destination (through
 * its reference definition when it has none of its own), an autolink or bare
 * URL, or an image's source. Null when nothing there points anywhere.
 */
export function linkAddressAt(state: EditorState, pos: number): string | null {
  let url = null as string | null;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter: (node) => {
      if (url !== null) return;
      if (node.name === 'Link' || node.name === 'Image') {
        const own = node.node.getChild('URL');
        if (own) url = unwrap(state.sliceDoc(own.from, own.to));
        else {
          const label = referenceLabel(state, node.node);
          if (label) url = referenceDestination(state, label);
        }
        return;
      }
      if (node.name === 'URL') {
        url = unwrap(state.sliceDoc(node.from, node.to));
        return;
      }
      // HTML images: <img>, <p align><img></p>, <figure><img>…</figure>.
      if (node.name === 'HTMLBlock' || node.name === 'HTMLTag') {
        const raw = state.sliceDoc(node.from, node.to);
        if (/<img\b/i.test(raw)) {
          const props = parseHtmlImage(raw);
          if (props) url = props.src;
        }
      }
    },
  });
  return url;
}
