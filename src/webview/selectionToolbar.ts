/*
 * The formatting toolbar that floats over a text selection, and the wiring it
 * shares with the link popover (linkPopover.ts).
 *
 * Both are CodeMirror tooltips, so the editor places them: the toolbar sits above
 * the selection and flips below it when there is no room, both are kept inside the
 * visible pane, and both drop out of sight when their text scrolls away. Whether
 * each one shows is decided from editor state (floatingState.ts); the plugin here
 * feeds that state the facts only the DOM knows: pointer, focus and source mode.
 *
 * The toolbar leads with Edit Markdown, the same command the block handle menu and
 * the right-click menu run, so the raw Markdown behind a selection is one click away
 * from the surface a selection opens.
 */

import { EditorState, Extension } from '@codemirror/state';
import { EditorView, KeyBinding, Rect, TooltipView, ViewPlugin, keymap, showTooltip, tooltips } from '@codemirror/view';
import { formatStateAt, FormatState } from './formatState';
import {
  toggleWrap,
  clearFormatting,
  insertLink,
  turnInto,
  blockKindOf,
  BlockKind,
} from './toolbar';
import { hint, registerShortcutGroup } from './shortcuts';
import { floatingIcon, FloatingIcon } from './floatingIcons';
import { blockRangeAt } from './blockModel';
import { revealRange } from './revealBlock';
import {
  floatingField,
  inlineLinkAt,
  popoverLink,
  setDismissed,
  setPointerDown,
  setSourceMode,
  toolbarEligible,
  toolbarShown,
} from './floatingState';
import { createLinkPopover, linkHover } from './linkPopover';

registerShortcutGroup({
  title: 'Selection toolbar',
  items: [
    { key: 'Alt-F10', label: 'Move focus to the selection toolbar or link popover' },
    { key: 'Escape', label: 'Close the selection toolbar or link popover' },
  ],
});

const titled = (label: string, key?: string): string => (key ? `${label} (${hint(key)})` : label);

/* ---- Turn into ------------------------------------------------------------ */

/*
 * Every kind the menu can set, in the order it lists them. Heading 4 to 6 carry no
 * shortcut, since Mod-Alt-4 is Task list and the run of digits cannot continue; a
 * rule above Heading 4 keeps the three levels in daily use together.
 */
const BLOCKS: { kind: BlockKind; label: string; key?: string; separator?: boolean }[] = [
  { kind: 'text', label: 'Text', key: 'Mod-Alt-0' },
  { kind: 'h1', label: 'Heading 1', key: 'Mod-Alt-1' },
  { kind: 'h2', label: 'Heading 2', key: 'Mod-Alt-2' },
  { kind: 'h3', label: 'Heading 3', key: 'Mod-Alt-3' },
  { kind: 'h4', label: 'Heading 4', separator: true },
  { kind: 'h5', label: 'Heading 5' },
  { kind: 'h6', label: 'Heading 6' },
  { kind: 'bullet', label: 'Bullet list', key: 'Mod-Shift-8' },
  { kind: 'ordered', label: 'Numbered list', key: 'Mod-Shift-7' },
  { kind: 'task', label: 'Task list', key: 'Mod-Alt-4' },
  { kind: 'quote', label: 'Quote', key: 'Mod-Shift-9' },
  { kind: 'code', label: 'Code block', key: 'Mod-Alt-8' },
];

/* ---- Edit Markdown -------------------------------------------------------- */

const REVEAL_LABEL = 'Edit Markdown';
const REVEAL_KEY = 'Mod-Alt-e';

/**
 * Whether Edit Markdown has something to open for the current selection: a block
 * around where the selection starts, which is neither the front matter nor a table.
 * Front matter is metadata rather than prose, and a table grid carries its own
 * control for the pipes behind it.
 */
function revealableBlock(state: EditorState): { from: number; to: number } | null {
  const block = blockRangeAt(state, state.selection.main.from);
  if (!block || block.kind === 'frontmatter' || block.kind === 'table') return null;
  return block;
}

/**
 * Open the raw Markdown of the block the selection sits in, the way the right-click
 * menu's item does, and put the toolbar away so it is not floating over what was
 * just revealed. The caret stays in the selection, which is inside the revealed
 * span; it only moves when the selection ran past the block's end.
 */
function runReveal(view: EditorView): void {
  const block = revealableBlock(view.state);
  if (!block) return;
  revealRange(view, block);
  view.dispatch({ effects: setDismissed.of({ toolbar: true }) });
  view.focus();
}

/* ---- Toolbar -------------------------------------------------------------- */

interface MarkButton {
  cmd: string;
  label: string;
  key?: string;
  icon: FloatingIcon;
  active?: (s: FormatState) => boolean;
  run: (view: EditorView) => unknown;
}

const MARKS: MarkButton[] = [
  { cmd: 'bold', label: 'Bold', key: 'Mod-b', icon: 'bold', active: (s) => s.bold, run: (v) => toggleWrap(v, '**') },
  { cmd: 'italic', label: 'Italic', key: 'Mod-i', icon: 'italic', active: (s) => s.italic, run: (v) => toggleWrap(v, '*') },
  { cmd: 'strike', label: 'Strikethrough', key: 'Mod-Shift-x', icon: 'strike', active: (s) => s.strike, run: (v) => toggleWrap(v, '~~') },
  { cmd: 'highlight', label: 'Highlight', key: 'Mod-Shift-h', icon: 'highlight', active: (s) => s.highlight, run: (v) => toggleWrap(v, '==') },
  { cmd: 'code', label: 'Inline code', key: 'Mod-e', icon: 'code', active: (s) => s.code, run: (v) => toggleWrap(v, '`') },
  // Links the selection, or unlinks it when it starts inside an inline link.
  { cmd: 'link', label: 'Link', key: 'Mod-k', icon: 'link', run: insertLink },
  { cmd: 'clear', label: 'Clear formatting', icon: 'clear', run: clearFormatting },
];

function toolbarButton(icon: FloatingIcon, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sheaf-tb-btn';
  btn.tabIndex = -1;
  btn.innerHTML = floatingIcon(icon);
  btn.title = label;
  btn.setAttribute('aria-label', label);
  return btn;
}

function separator(): HTMLElement {
  const sep = document.createElement('span');
  sep.className = 'sheaf-tb-sep';
  sep.setAttribute('role', 'separator');
  return sep;
}

/** The toolbar's DOM, created by the tooltip system when a selection first needs it and reused while it stays open. */
function createSelectionToolbar(view: EditorView): TooltipView {
  const doc = view.dom.ownerDocument;
  const dom = doc.createElement('div');
  dom.className = 'sheaf-seltb';
  dom.setAttribute('role', 'toolbar');
  dom.setAttribute('aria-label', 'Formatting');
  // Pressing anything in the toolbar keeps focus and the selection in the text.
  dom.addEventListener('mousedown', (e) => e.preventDefault());

  const buttons: HTMLButtonElement[] = [];

  /*
   * A table cell edits in an editor of its own, and two of this bar's controls mean
   * nothing there. A cell holds one line of inline Markdown: it has no block to show
   * the source of, and turning it into a heading would write `# ` into the cell,
   * which no reader of the table renders as a heading. Both are left out rather than
   * hidden, so the arrow keys do not stop on a button that is not there.
   */
  const inCell = !!view.dom.closest('.sheaf-table-input');

  // Edit Markdown leads the bar: reaching the raw Markdown of what you just
  // selected is the move this editor is built around, and a selection is the
  // moment people want it.
  const reveal = toolbarButton('source', titled(REVEAL_LABEL, REVEAL_KEY));
  reveal.dataset.cmd = 'reveal';
  reveal.addEventListener('click', () => {
    if (!reveal.disabled) runReveal(view);
  });
  if (!inCell) {
    buttons.push(reveal);
    dom.append(reveal, separator());
  }

  const markButtons = new Map<MarkButton, HTMLButtonElement>();
  for (const def of MARKS) {
    if (def.cmd === 'clear') dom.appendChild(separator());
    const btn = toolbarButton(def.icon, titled(def.label, def.key));
    btn.dataset.cmd = def.cmd;
    if (def.active) btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => def.run(view));
    markButtons.set(def, btn);
    buttons.push(btn);
    dom.appendChild(btn);
  }
  dom.appendChild(separator());

  const wrap = doc.createElement('div');
  wrap.className = 'sheaf-tb-dropdown sheaf-seltb-turn';
  const trigger = doc.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sheaf-tb-btn sheaf-seltb-trigger';
  trigger.tabIndex = -1;
  trigger.dataset.cmd = 'turn-into';
  trigger.title = 'Turn into';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const triggerLabel = doc.createElement('span');
  triggerLabel.className = 'sheaf-seltb-trigger-label';
  trigger.appendChild(triggerLabel);
  trigger.insertAdjacentHTML('beforeend', floatingIcon('chevron', 'sheaf-tb-caret'));
  if (!inCell) buttons.push(trigger);

  const menu = doc.createElement('div');
  menu.className = 'sheaf-tb-menu sheaf-seltb-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Turn into');
  menu.hidden = true;
  const items = BLOCKS.map((block) => {
    if (block.separator) {
      const rule = doc.createElement('div');
      rule.className = 'sheaf-tb-menu-sep';
      rule.setAttribute('role', 'separator');
      menu.appendChild(rule);
    }
    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'sheaf-tb-menu-item';
    item.tabIndex = -1;
    item.dataset.block = block.kind;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', 'false');
    const label = doc.createElement('span');
    label.textContent = block.label;
    const keys = doc.createElement('span');
    keys.className = 'sheaf-tb-menu-key';
    keys.textContent = block.key ? hint(block.key) : '';
    item.append(label, keys);
    item.addEventListener('click', () => {
      closeMenu(false);
      turnInto(view, block.kind);
    });
    menu.appendChild(item);
    return item;
  });
  wrap.append(trigger, menu);
  if (!inCell) dom.appendChild(wrap);

  const onDocDown = (e: MouseEvent): void => {
    if (!wrap.contains(e.target as Node)) closeMenu(false);
  };
  function openMenu(focusItem: boolean): void {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    // Open upward or toward the start when the window has no room below or to the right.
    menu.classList.remove('is-up', 'is-end');
    const win = doc.defaultView ?? window;
    const box = menu.getBoundingClientRect();
    if (box.bottom > win.innerHeight - 4 && trigger.getBoundingClientRect().top - box.height - 8 >= 0) menu.classList.add('is-up');
    if (box.right > win.innerWidth - 4) menu.classList.add('is-end');
    if (focusItem) (items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0]).focus();
    doc.addEventListener('mousedown', onDocDown, true);
  }
  function closeMenu(focusTrigger: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    doc.removeEventListener('mousedown', onDocDown, true);
    if (focusTrigger) trigger.focus();
  }
  // A click with no pointer detail came from the keyboard, which should land in the menu.
  trigger.addEventListener('click', (e) => (menu.hidden ? openMenu(e.detail === 0) : closeMenu(false)));

  /** Roving focus: the focused button is the one Tab reaches. A disabled button is stepped over. */
  const focusButton = (index: number, step: 1 | -1 = 1): void => {
    const n = buttons.length;
    let at = ((index % n) + n) % n;
    for (let tries = 0; tries < n && buttons[at].disabled; tries++) at = (at + step + n) % n;
    if (buttons[at].disabled) return;
    buttons.forEach((b, i) => (b.tabIndex = i === at ? 0 : -1));
    buttons[at].focus();
  };
  buttons[0].tabIndex = 0;

  /** Keep the one tabbable button a button that can take focus. */
  const syncRoving = (): void => {
    const at = buttons.findIndex((b) => b.tabIndex === 0);
    if (at >= 0 && !buttons[at].disabled) return;
    const next = buttons.findIndex((b) => !b.disabled);
    buttons.forEach((b, i) => (b.tabIndex = i === next ? 0 : -1));
  };

  dom.addEventListener('keydown', (e) => {
    const claim = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    const active = doc.activeElement as HTMLButtonElement | null;
    if (menu.contains(e.target as Node)) {
      const i = items.indexOf(active as HTMLButtonElement);
      const n = items.length;
      if (e.key === 'ArrowDown') claim(), items[(i + 1) % n].focus();
      else if (e.key === 'ArrowUp') claim(), items[i <= 0 ? n - 1 : i - 1].focus();
      else if (e.key === 'Home') claim(), items[0].focus();
      else if (e.key === 'End') claim(), items[n - 1].focus();
      else if (e.key === 'Escape') claim(), closeMenu(true);
      else if (e.key === 'Tab') closeMenu(false);
      return;
    }
    const i = buttons.indexOf(active as HTMLButtonElement);
    if (e.key === 'ArrowRight') claim(), focusButton(i < 0 ? 0 : i + 1, 1);
    else if (e.key === 'ArrowLeft') claim(), focusButton(i < 0 ? 0 : i - 1, -1);
    else if (e.key === 'Home') claim(), focusButton(0, 1);
    else if (e.key === 'End') claim(), focusButton(buttons.length - 1, -1);
    else if (e.key === 'ArrowDown' && active === trigger) claim(), openMenu(true);
    else if (e.key === 'Escape') {
      claim();
      view.dispatch({ effects: setDismissed.of({ toolbar: true }) });
      view.focus();
    }
  });

  const refresh = (state: EditorState): void => {
    const s = formatStateAt(state);
    reveal.disabled = revealableBlock(state) === null;
    syncRoving();
    for (const [def, btn] of markButtons) {
      if (def.active) {
        const on = def.active(s);
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', String(on));
      }
    }
    const link = markButtons.get(MARKS.find((m) => m.cmd === 'link')!)!;
    const sel = state.selection.main;
    const linked = inlineLinkAt(state, Math.min(sel.from + 1, sel.to)) !== null;
    const linkLabel = linked ? 'Remove link' : titled('Link', 'Mod-k');
    link.classList.toggle('is-active', linked);
    link.title = linkLabel;
    link.setAttribute('aria-label', linkLabel);

    const kind = blockKindOf(s);
    const label = BLOCKS.find((b) => b.kind === kind)!.label;
    triggerLabel.textContent = label;
    trigger.setAttribute('aria-label', `Turn into: ${label}`);
    items.forEach((item, i) => item.setAttribute('aria-checked', String(BLOCKS[i].kind === kind)));
  };
  refresh(view.state);

  return {
    dom,
    offset: { x: 0, y: 6 },
    // A toolbar squeezed to fit would hide its buttons, so it keeps its size and flips sides when short of room.
    resize: false,
    // Anchor above the selection's start, or its end when the start has scrolled out of view.
    getCoords: (pos) => {
      const start = view.coordsAtPos(pos);
      if (start && start.top >= visibleSpace(view).top) return start;
      return (view.coordsAtPos(view.state.selection.main.to, -1) ?? start) as Rect;
    },
    update: (update) => {
      if (update.docChanged || update.selectionSet) refresh(update.state);
    },
    destroy: () => doc.removeEventListener('mousedown', onDocDown, true),
  };
}

/* ---- Wiring --------------------------------------------------------------- */

/**
 * The part of the window where the document is visible: the editor's nearest
 * scrolling ancestor, clipped to the window. Tooltips flip and clamp inside it, so
 * the toolbar never covers the fixed formatting bar above the editor.
 */
function visibleSpace(view: EditorView): Rect {
  const doc = view.dom.ownerDocument;
  const win = doc.defaultView ?? window;
  const space = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
  // A table cell's editor sits inside the document's editor, in a grid that scrolls
  // sideways (and so computes as scrolling both ways). Measured from there, the
  // space would be the table's own frame, with no room above the first row. The
  // cell's toolbar is placed in the document's visible space instead, like any other.
  let outer = view.dom;
  for (let up = outer.parentElement?.closest('.cm-editor'); up; up = up.parentElement?.closest('.cm-editor')) outer = up as HTMLElement;
  for (let el = outer.parentElement; el && el !== doc.body; el = el.parentElement) {
    const overflow = win.getComputedStyle(el).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return {
        left: Math.max(space.left, r.left),
        top: Math.max(space.top, r.top),
        right: Math.min(space.right, r.right),
        bottom: Math.min(space.bottom, r.bottom),
      };
    }
    break;
  }
  return space;
}

/** Reports the pointer, focus and source mode to the floating state. */
const floatingPlugin = ViewPlugin.fromClass(
  class {
    private destroyed = false;
    private sourceModeQueued = false;

    constructor(readonly view: EditorView) {
      // Capture, so the pointer counts as down before CodeMirror moves the selection.
      view.dom.addEventListener('mousedown', this.onPointerDown, true);
      view.dom.ownerDocument.addEventListener('mouseup', this.onPointerUp, true);
      view.dom.addEventListener('focusout', this.onFocusOut);
      this.syncSourceMode();
    }

    update(): void {
      this.syncSourceMode();
    }

    destroy(): void {
      this.destroyed = true;
      this.view.dom.removeEventListener('mousedown', this.onPointerDown, true);
      this.view.dom.ownerDocument.removeEventListener('mouseup', this.onPointerUp, true);
      this.view.dom.removeEventListener('focusout', this.onFocusOut);
    }

    private get state() {
      return this.view.state.field(floatingField);
    }

    private readonly onPointerDown = (e: MouseEvent): void => {
      if (e.button !== 0 || !this.view.contentDOM.contains(e.target as Node)) return;
      if (!this.state.pointerDown) this.view.dispatch({ effects: setPointerDown.of(true) });
    };

    private readonly onPointerUp = (): void => {
      if (!this.destroyed && this.state.pointerDown) this.view.dispatch({ effects: setPointerDown.of(false) });
    };

    // Focus settles after focusout fires, so look once it has.
    private readonly onFocusOut = (): void => {
      setTimeout(() => this.checkFocus(), 0);
    };

    private checkFocus(): void {
      if (this.destroyed) return;
      const active = this.view.dom.ownerDocument.activeElement;
      if (active === this.view.contentDOM) return;
      if (active && this.view.dom.contains(active) && active.closest('.sheaf-seltb, .sheaf-linkpop')) return;
      const { state } = this.view;
      if (toolbarShown(state) || popoverLink(state)) {
        this.view.dispatch({ effects: setDismissed.of({ toolbar: true, popover: true }) });
      }
    }

    /** Source mode is a class on an ancestor; state learns of a change on the next microtask, since an update cannot dispatch. */
    private syncSourceMode(): void {
      if (this.sourceModeQueued) return;
      const on = (): boolean => this.view.dom.closest('.source-mode') !== null;
      if (on() === this.state.sourceMode) return;
      this.sourceModeQueued = true;
      void Promise.resolve().then(() => {
        this.sourceModeQueued = false;
        if (!this.destroyed && on() !== this.state.sourceMode) this.view.dispatch({ effects: setSourceMode.of(on()) });
      });
    }
  }
);

/** Alt-F10: focus the toolbar (reopening one closed with Escape) or the popover's address field. */
function focusFloating(view: EditorView): boolean {
  const f = view.state.field(floatingField);
  if (!view.dom.querySelector('.sheaf-seltb') && f.toolbarDismissed && toolbarEligible(view.state, f.sourceMode)) {
    view.dispatch({ effects: setDismissed.of({ toolbar: false }) });
  }
  const bar = view.dom.querySelector('.sheaf-seltb');
  if (bar) {
    (bar.querySelector<HTMLButtonElement>('button[tabindex="0"]') ?? bar.querySelector<HTMLButtonElement>('button'))?.focus();
    return true;
  }
  const field = view.dom.querySelector<HTMLInputElement>('.sheaf-linkpop-url');
  if (field) {
    field.focus();
    field.select();
    return true;
  }
  return false;
}

/** Escape in the text closes whichever floating surface is open, and otherwise does nothing. */
function dismissFloating(view: EditorView): boolean {
  if (toolbarShown(view.state)) {
    view.dispatch({ effects: setDismissed.of({ toolbar: true }) });
    return true;
  }
  if (popoverLink(view.state)) {
    view.dispatch({ effects: setDismissed.of({ popover: true }) });
    return true;
  }
  return false;
}

const floatingKeys: KeyBinding[] = [
  { key: 'Alt-F10', run: focusFloating },
  { key: 'Escape', run: dismissFloating },
];

export const selectionToolbar: Extension = [
  floatingField,
  showTooltip.computeN([floatingField, 'selection', 'doc'], (state) => {
    const sel = state.selection.main;
    const bar = toolbarShown(state);
    const link = bar ? null : popoverLink(state);
    return [
      bar ? { pos: sel.from, end: sel.to, above: true, create: createSelectionToolbar } : null,
      link ? { pos: link.from, end: link.to, create: createLinkPopover } : null,
    ];
  }),
  tooltips({ tooltipSpace: visibleSpace }),
  floatingPlugin,
  linkHover,
  keymap.of(floatingKeys),
];
