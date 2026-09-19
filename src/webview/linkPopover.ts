/*
 * The link popover: a small panel under a Markdown link with its address in an
 * editable field and buttons to open the link, copy the address and remove the
 * link. It opens when the caret rests inside an inline link or the pointer rests on
 * a rendered one, and it yields to the selection toolbar.
 *
 * Hover is tracked here: CodeMirror's hoverTooltip closes as soon as the pointer
 * leaves, even while someone is typing in the field.
 */

import { ChangeDesc, MapMode } from '@codemirror/state';
import { EditorView, TooltipView, ViewPlugin } from '@codemirror/view';
import { floatingField, inlineLinkAt, popoverLink, setDismissed, setHoverLink, InlineLink } from './floatingState';
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

/** Delete a link's syntax and keep its text. */
export function removeLink(view: EditorView, link: InlineLink): boolean {
  view.dispatch({
    changes: [
      { from: link.from, to: link.textFrom },
      { from: link.textTo, to: link.to },
    ],
  });
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

/** The popover's DOM, created by the tooltip system when a link first needs it. */
export function createLinkPopover(view: EditorView): TooltipView {
  const dom = document.createElement('div');
  dom.className = 'sheaf-linkpop';
  dom.setAttribute('role', 'dialog');
  dom.setAttribute('aria-label', 'Link');

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
  dom.append(input, open, copy, remove);

  let link = popoverLink(view.state);
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

  const sync = (next: InlineLink | null): void => {
    if (!next) return;
    const moved = !link || next.from !== link.from || next.url !== link.url;
    link = next;
    if (moved) edited = false;
    if (!edited) input.value = next.url;
  };
  sync(link);

  const close = (): void => {
    edited = false;
    view.dispatch({ effects: setDismissed.of({ popover: true }) });
    view.focus();
  };

  input.addEventListener('input', () => {
    edited = true;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const current = popoverLink(view.state);
      if (current) setLinkUrl(view, current, input.value);
      close();
    }
  });
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
