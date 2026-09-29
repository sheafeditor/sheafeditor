/*
 * The link popover: a small panel under a Markdown link with its address in an
 * editable field and buttons to open the link, copy the address and remove the
 * link. It opens when the caret rests inside an inline link or the pointer rests on
 * a rendered one, and it yields to the selection toolbar.
 *
 * Hover is tracked here: CodeMirror's hoverTooltip closes as soon as the pointer
 * leaves, even while someone is typing in the field.
 */

import { ChangeDesc, ChangeSpec, EditorSelection, MapMode, StateEffect } from '@codemirror/state';
import { EditorView, TooltipView, ViewPlugin } from '@codemirror/view';
import {
  floatingField,
  inlineLinkAt,
  pendingLink,
  popoverLink,
  setDismissed,
  setEditLink,
  setHoverLink,
  setNewLink,
  InlineLink,
  PendingLink,
} from './floatingState';
import { writeClipboardText } from './hostClipboard';
import { floatingIcon, FloatingIcon } from './floatingIcons';
import { openLink } from './linkTarget';

const HOVER_OPEN_MS = 350;
const HOVER_CLOSE_MS = 250;

/**
 * `url` written as a link destination. A bare destination cannot hold spaces or
 * unbalanced parentheses, so those take the `<...>` form. An empty address stays
 * empty unless a title follows, which needs `<>` in front of it.
 */
export function linkDestination(url: string, hasTitle: boolean): string {
  if (url === '') return hasTitle ? '<>' : '';
  let depth = 0;
  let balanced = true;
  for (const ch of url) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) balanced = false;
  }
  if (balanced && depth === 0 && !/\s/.test(url) && !url.startsWith('<')) return url;
  return '<' + url.replace(/</g, '%3C').replace(/>/g, '%3E') + '>';
}

/** Replace a link's destination with `url`. Nothing else in the line changes. */
export function setLinkUrl(view: EditorView, link: InlineLink, url: string): boolean {
  const { state } = view;
  const hasTitle = state.sliceDoc(link.urlTo, link.to - 1).trim() !== '';
  const insert = linkDestination(url.replace(/[\r\n]+/g, '').trim(), hasTitle);
  if (insert === state.sliceDoc(link.urlFrom, link.urlTo)) return false;
  view.dispatch({ changes: { from: link.urlFrom, to: link.urlTo, insert } });
  return true;
}

/**
 * Replace a link's words with `text`. Nothing else in the line changes.
 *
 * The brackets around the words are not touched, so this is the same shape as `setLinkUrl` and
 * for the same reason: a link is four spans of a line, and editing one of them has no business
 * rewriting the other three.
 *
 * Newlines are dropped rather than escaped. A link's text cannot hold one — the construct ends at
 * the line — so a pasted paragraph would otherwise break the link into ordinary text. The
 * closing `]` is the other character that would end it, and it is escaped rather than dropped
 * because a person typing `[note]` into the text of a link means those characters.
 */
export function setLinkText(view: EditorView, link: InlineLink, text: string): boolean {
  const insert = text.replace(/[\r\n]+/g, ' ').replace(/([[\]])/g, '\\$1');
  if (insert === view.state.sliceDoc(link.textFrom, link.textTo)) return false;
  view.dispatch({ changes: { from: link.textFrom, to: link.textTo, insert } });
  return true;
}

/**
 * Set a link's words and its address together, as one change.
 *
 * One dispatch rather than two, so the pair is one undo step: a person who changed both and
 * pressed Cmd+Z once would otherwise be left with a link half edited, which is a state they never
 * asked for and cannot see the reason for.
 *
 * The two spans do not overlap and the text comes first, which is the order CodeMirror wants.
 */
export function setLinkParts(view: EditorView, link: InlineLink, text: string, url: string): boolean {
  const { state } = view;
  const hasTitle = state.sliceDoc(link.urlTo, link.to - 1).trim() !== '';
  const nextText = text.replace(/[\r\n]+/g, ' ').replace(/([[\]])/g, '\\$1');
  const nextUrl = linkDestination(url.replace(/[\r\n]+/g, '').trim(), hasTitle);
  const changes = [];
  if (nextText !== state.sliceDoc(link.textFrom, link.textTo)) {
    changes.push({ from: link.textFrom, to: link.textTo, insert: nextText });
  }
  if (nextUrl !== state.sliceDoc(link.urlFrom, link.urlTo)) {
    changes.push({ from: link.urlFrom, to: link.urlTo, insert: nextUrl });
  }
  if (!changes.length) return false;
  view.dispatch({ changes });
  return true;
}

/** Delete a link's syntax and keep its text. */
export function removeLink(view: EditorView, link: InlineLink): boolean {
  return removeLinks(view, [link]);
}

/**
 * Delete the syntax of several links and keep their text, as one change.
 *
 * One dispatch, so unlinking a selection holding three links is one undo step rather
 * than three. The links arrive in document order, which is the order a changeset wants.
 */
export function removeLinks(view: EditorView, links: InlineLink[]): boolean {
  if (!links.length) return false;
  view.dispatch({
    changes: links.flatMap((link) => [
      { from: link.from, to: link.textFrom },
      { from: link.textTo, to: link.to },
    ]),
    userEvent: 'delete',
  });
  return true;
}

/**
 * The words `text` written as a link's label.
 *
 * A pair of square brackets inside the words is a valid label as it stands, and an escaped
 * bracket already stands for itself, so words like those are written exactly as they were
 * selected. Brackets that do not pair up would end the label early, or never let it end, and
 * leave `](url)` showing as text, so those are escaped.
 */
export function linkLabel(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '[') depth++;
    else if (c === ']' && --depth < 0) break;
  }
  if (depth === 0) return text;
  // Escape the brackets that are not escaped already, leaving `\[` and `\]` as they are.
  return text.replace(/(\\.)|[[\]]/g, (m, escaped) => escaped ?? `\\${m}`);
}

/**
 * Write a link over each pending span, as one change.
 *
 * Nothing is written without an address, which is the whole point of the pending state: a
 * `[text](url)` placeholder left in the file by somebody who changed their mind was the thing
 * this replaced.
 *
 * One span takes its words from the field, because that is the link the person is looking at.
 * Several spans keep their own words and share the address, so a selection over three
 * paragraphs becomes three links to one place. A span whose words need no escaping keeps its
 * bytes: only the markup is added around them, so marks inside the words survive and the diff
 * is the two ends rather than the whole line.
 */
export function writeNewLinks(view: EditorView, spans: PendingLink['spans'], text: string, url: string): boolean {
  const address = url.replace(/[\r\n]+/g, '').trim();
  if (!address || !spans.length) return false;
  const dest = linkDestination(address, false);
  const changes: ChangeSpec[] = [];
  for (const span of spans) {
    const selected = view.state.sliceDoc(span.from, span.to);
    // With no words to carry it — a bare caret, or a text field left empty — the address is
    // the words, which is what a link with empty brackets ends up showing anyway.
    const words = spans.length === 1 ? text.replace(/[\r\n]+/g, ' ') || address : selected;
    const label = linkLabel(words);
    if (label === selected) changes.push({ from: span.from, insert: '[' }, { from: span.to, insert: `](${dest})` });
    else changes.push({ from: span.from, to: span.to, insert: `[${label}](${dest})` });
  }
  // The caret lands after the last link written, which is where a paste that makes a link
  // leaves it and where somebody who just finished a sentence's link carries on typing.
  const set = view.state.changes(changes);
  const after = set.mapPos(spans[spans.length - 1].to, 1);
  view.dispatch({ changes: set, selection: EditorSelection.cursor(after), userEvent: 'input' });
  return true;
}

/**
 * Show the popover on `link` and put the caret in one of its fields.
 *
 * This is what Cmd+K and the toolbar's Link button do when the selection is already in
 * a link. They used to remove it, which made the one shortcut people reach for to
 * change a link the shortcut that destroys it.
 *
 * The tooltip's DOM is built while the transaction is applied, so the field is there to
 * focus by the time `dispatch` returns.
 */
export function editLinkInPopover(view: EditorView, link: InlineLink, field: 'text' | 'url'): boolean {
  return focusPopover(view, setEditLink.of(link.from), field);
}

/**
 * Show the popover over words that are not a link yet, with the caret in one of its fields.
 * The document is untouched until the address is entered.
 */
export function openNewLinkPopover(view: EditorView, spans: PendingLink['spans'], field: 'text' | 'url'): boolean {
  return focusPopover(view, setNewLink.of({ spans }), field);
}

function focusPopover(view: EditorView, effect: StateEffect<unknown>, field: 'text' | 'url'): boolean {
  view.dispatch({ effects: effect });
  const input = view.dom.querySelector<HTMLInputElement>(field === 'url' ? '.sheaf-linkpop-url' : '.sheaf-linkpop-text');
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

function popoverButton(action: string, icon: FloatingIcon, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sheaf-tb-btn';
  btn.dataset.action = action;
  btn.innerHTML = floatingIcon(icon);
  btn.title = label;
  btn.setAttribute('aria-label', label);
  // Keep the caret in the text when a button is pressed with the mouse.
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  return btn;
}

/** The popover's DOM for a link that exists, created by the tooltip system when one first needs it. */
export function createLinkPopover(view: EditorView): TooltipView {
  return buildPopover(view, false);
}

/**
 * The popover's DOM for a link that is not written yet.
 *
 * A separate entry point rather than a flag on the one above, because CodeMirror matches a
 * tooltip to an existing view by its `create` function: one function for both would hand the
 * popover built for a pending link to the next link someone edits, with its closure intact.
 */
export function createNewLinkPopover(view: EditorView): TooltipView {
  return buildPopover(view, true);
}

function buildPopover(view: EditorView, isNew: boolean): TooltipView {
  const dom = document.createElement('div');
  dom.className = 'sheaf-linkpop';
  dom.setAttribute('role', 'dialog');
  dom.setAttribute('aria-label', isNew ? 'New link' : 'Link');

  /*
   * The words first, then the address, which is the order they are read in and the order Tab
   * moves through them. Changing what a link *says* used to mean editing around brackets that are
   * not on the screen, in an editor whose whole point is that they are not on the screen.
   */
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.className = 'sheaf-linkpop-text';
  textInput.placeholder = 'Link text';
  textInput.title = 'Link text: Enter saves, Esc closes';
  textInput.setAttribute('aria-label', 'Link text');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sheaf-linkpop-url';
  input.spellcheck = false;
  input.placeholder = 'Paste or type a link';
  input.title = 'Link address: Enter saves, Esc closes';
  input.setAttribute('aria-label', 'Link address');

  const open = popoverButton('open', 'open', 'Open link');
  const copy = popoverButton('copy', 'copy', 'Copy link address');
  const remove = popoverButton('remove', 'unlink', 'Remove link');
  // The two fields stack in a column of their own; the popover wraps, so the buttons fall under
  // them rather than shrinking the address field to share a row with it.
  const fields = document.createElement('div');
  fields.className = 'sheaf-linkpop-fields';
  fields.append(textInput, input);
  // A link that does not exist yet cannot be opened, copied or removed, and a row of three
  // buttons that do nothing reads as a bug rather than as a state.
  dom.append(fields, ...(isNew ? [] : [open, copy, remove]));

  let link = isNew ? null : popoverLink(view.state);
  let edited = false;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Follow the link through `changes`, so text added or removed elsewhere in the
   * file does not make it look like a different link. Deleting its opening `[` or
   * closing `)` ends it.
   */
  const follow = (changes: ChangeDesc): void => {
    if (!link || changes.empty) return;
    const from = changes.mapPos(link.from, 1, MapMode.TrackAfter);
    const to = changes.mapPos(link.to, -1, MapMode.TrackBefore);
    link = from === null || to === null ? null : { ...link, from, to };
  };

  /** The words between a link's brackets, as a person would type them. */
  const textOf = (l: InlineLink): string => view.state.sliceDoc(l.textFrom, l.textTo).replace(/\\([[\]])/g, '$1');

  const sync = (next: InlineLink | null): void => {
    if (!next) return;
    const moved = !link || next.from !== link.from || next.url !== link.url;
    link = next;
    if (moved) edited = false;
    if (!edited) {
      input.value = next.url;
      textInput.value = textOf(next);
    }
  };
  if (isNew) {
    const spans = pendingLink(view.state)?.spans ?? [];
    // One span's words go in the field to be edited; several keep their own, so the field would
    // have nothing true to show and the address is the only thing being asked for.
    textInput.value = spans.length === 1 ? view.state.sliceDoc(spans[0].from, spans[0].to) : '';
  } else {
    sync(link);
  }

  const close = (): void => {
    edited = false;
    view.dispatch({ effects: setDismissed.of({ popover: true }) });
    view.focus();
  };

  /*
   * Enter in either field saves both, because a person who changed both and pressed Enter in one
   * of them has said what they want twice over. Saving only the field they were in would drop the
   * other edit silently, which is the worst of the three possible answers.
   *
   * A new link with no address yet is not saved and not closed either: Enter on an empty address
   * has asked for nothing, and closing on it would throw away the words in the field along with
   * the state that says where they go.
   */
  const save = (): void => {
    if (isNew) {
      const spans = pendingLink(view.state)?.spans;
      if (!spans || !writeNewLinks(view, spans, textInput.value, input.value)) return;
      close();
      return;
    }
    const current = popoverLink(view.state);
    if (current) setLinkParts(view, current, textInput.value, input.value);
    close();
  };

  for (const field of [textInput, input]) {
    field.addEventListener('input', () => {
      edited = true;
    });
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      save();
    });
  }
  dom.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  open.addEventListener('click', () => {
    if (link) openLink(link.url);
  });
  copy.addEventListener('click', () => {
    if (!link) return;
    writeClipboardText(link.url);
    copy.classList.add('is-active');
    copy.setAttribute('aria-label', 'Link address copied');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copy.classList.remove('is-active');
      copy.setAttribute('aria-label', 'Copy link address');
    }, 1200);
  });
  remove.addEventListener('click', () => {
    const current = popoverLink(view.state);
    if (!current) return;
    removeLink(view, current);
    view.focus();
  });

  return {
    dom,
    offset: { x: 0, y: 4 },
    update: (update) => {
      // A pending link has nothing in the document to follow, and the fields hold what the
      // person is typing; where its words are lives in the state field, which maps itself.
      if (isNew) return;
      follow(update.changes);
      sync(popoverLink(update.state));
    },
    destroy: () => clearTimeout(copiedTimer),
  };
}

/** Opens the popover when the pointer rests on a rendered link, and closes it when the pointer moves away. */
export const linkHover = ViewPlugin.fromClass(
  class {
    private openTimer: ReturnType<typeof setTimeout> | undefined;
    private closeTimer: ReturnType<typeof setTimeout> | undefined;
    private pending: number | null = null;
    private destroyed = false;

    constructor(readonly view: EditorView) {
      view.dom.addEventListener('mousemove', this.onMove);
      view.dom.addEventListener('mouseleave', this.onLeave);
    }

    destroy(): void {
      this.destroyed = true;
      this.view.dom.removeEventListener('mousemove', this.onMove);
      this.view.dom.removeEventListener('mouseleave', this.onLeave);
      this.cancelOpen();
      this.cancelClose();
    }

    private readonly onMove = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('.sheaf-linkpop')) {
        this.cancelOpen();
        this.cancelClose();
        return;
      }
      const el = !e.buttons && this.view.contentDOM.contains(target) ? target.closest('.tok-link') : null;
      const from = el ? this.linkStart(el) : null;
      const hovered = this.view.state.field(floatingField).hoverLink;
      if (from == null) {
        this.cancelOpen();
        if (hovered != null) this.scheduleClose();
        return;
      }
      this.cancelClose();
      if (from === hovered || from === this.pending) return;
      this.cancelOpen();
      this.pending = from;
      this.openTimer = setTimeout(() => {
        this.openTimer = undefined;
        this.pending = null;
        if (!this.destroyed) this.view.dispatch({ effects: setHoverLink.of(from) });
      }, HOVER_OPEN_MS);
    };

    private readonly onLeave = (): void => {
      this.cancelOpen();
      if (this.view.state.field(floatingField).hoverLink != null) this.scheduleClose();
    };

    private scheduleClose(): void {
      if (this.closeTimer !== undefined) return;
      this.closeTimer = setTimeout(() => {
        this.closeTimer = undefined;
        if (this.destroyed) return;
        // Someone typing in the field keeps the popover open wherever the pointer goes.
        const pop = this.view.dom.querySelector('.sheaf-linkpop');
        if (pop && pop.contains(pop.ownerDocument.activeElement)) return;
        if (this.view.state.field(floatingField).hoverLink != null) this.view.dispatch({ effects: setHoverLink.of(null) });
      }, HOVER_CLOSE_MS);
    }

    private cancelOpen(): void {
      clearTimeout(this.openTimer);
      this.openTimer = undefined;
      this.pending = null;
    }

    private cancelClose(): void {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }

    /** The start of the link a rendered `.tok-link` element belongs to. */
    private linkStart(el: Element): number | null {
      let pos: number;
      try {
        pos = this.view.posAtDOM(el, 0);
      } catch {
        return null;
      }
      const link = inlineLinkAt(this.view.state, pos) ?? inlineLinkAt(this.view.state, pos + 1);
      return link ? link.from : null;
    }
  }
);
