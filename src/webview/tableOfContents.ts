/*
 * The document's headings, listed beside the text.
 *
 * A long document in Sheaf has no outline: VS Code's own Outline view and its
 * breadcrumbs both read a text editor's symbols, and a custom editor has none to
 * give them. So Sheaf lists its own headings, in a rail down the right-hand margin
 * that `sheaf.tableOfContents` turns on.
 *
 * The list is read from the syntax tree the live preview has already parsed, so a
 * keystroke costs a walk of the tree rather than a second parse of the file, and the
 * rail is rebuilt on the next frame rather than on the keystroke itself.
 *
 * Nothing here writes to the document. Clicking an entry moves the caret and scrolls,
 * which is a selection, not an edit: the file is untouched, it is not made dirty, and
 * undo still takes back whatever the person typed last.
 *
 * Layout is the one thing this file is careful about. The rail is positioned out of
 * flow, over the page margin CodeMirror's centred column already leaves empty, so
 * turning it on never moves the text. When the pane is too narrow to have a margin
 * that wide, the rail becomes a panel that slides in over the right-hand edge.
 */

import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import { referenceDestination } from './linkTarget';

/** A heading, as the rail lists it. */
export interface TocHeading {
  /** 1, 2 or 3. Deeper headings are not listed. */
  level: number;
  /** The heading as it reads on the page: no `#`, no `**`, no link brackets. */
  text: string;
  /** The start of the heading's own line, which is what an entry scrolls to. */
  from: number;
  /** The first character of the heading's text, which is where the caret lands. */
  textFrom: number;
}

/** How deep the rail goes. H4 and below are left out; a later setting can add depth. */
const DEEPEST = 3;

/** Blocks that hold no heading, whatever their text looks like. */
const NOT_PROSE = /^(FencedCode|CodeBlock|HTMLBlock|Table|LinkReference|CommentBlock|ProcessingInstructionBlock)$/;

/** Inline nodes that are spelling rather than words, and so read as nothing. The
 * heading's own `HeaderMark` is handled on its own, because whether the tree gave one
 * is the difference between a resolved heading and one read past the parsed region. */
const SPELLING = /^(EmphasisMark|StrikethroughMark|HighlightMark|CodeMark)$/;

/**
 * The line that closes the YAML front matter opening the document, or 0 when the
 * document has none.
 *
 * Front matter is YAML, and the Markdown parser reads its closing `---` as the
 * underline of a setext heading whose text is the last metadata line. Left alone,
 * `tags: [spec, draft]` would be the first thing the rail listed. The rule is the
 * block model's, kept here in its textual form so listing headings costs no parse of
 * its own.
 */
function frontMatterEnd(state: EditorState): number {
  const doc = state.doc;
  if (doc.lines < 3 || doc.line(1).text.trimEnd() !== '---' || doc.line(2).text.trim() === '') return 0;
  for (let n = 2; n <= doc.lines; n++) {
    const text = doc.line(n).text.trimEnd();
    if (text === '---' || text === '...') return n;
  }
  return 0;
}

/**
 * True when a `[...]` is a link on the page rather than the brackets as typed. The
 * parser marks every bracketed run as a `Link`, and `[1]` in a heading is a footnote
 * marker somebody wants to read, so its brackets stay.
 */
function rendersAsLink(state: EditorState, link: SyntaxNode | null): boolean {
  if (!link || link.name !== 'Link') return false;
  if (link.getChild('URL')) return true;
  const label = link.getChild('LinkLabel');
  if (label && label.to - label.from > 2) {
    return referenceDestination(state, state.sliceDoc(label.from + 1, label.to - 1)) !== null;
  }
  const marks = link.getChildren('LinkMark');
  const open = marks[0];
  const close = marks.find((mark) => state.sliceDoc(mark.from, mark.to) === ']');
  if (!open || !close || close.from <= open.to) return false;
  return referenceDestination(state, state.sliceDoc(open.to, close.from)) !== null;
}

/** Merge `ranges` into the fewest non-overlapping ones, in order. */
function merged(ranges: { from: number; to: number }[]): { from: number; to: number }[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else out.push({ ...range });
  }
  return out;
}

/** The `#` opening an ATX heading, and the run of them some documents close it with. */
const ATX_OPENER = /^#{1,6}(?:[ \t]+|$)/;
const ATX_CLOSER = /[ \t]+#+[ \t]*$/;

/**
 * A heading as it reads on the page: `## **Pricing** and [plans](x)` is "Pricing and
 * plans". Everything the live preview hides is dropped, an image contributes nothing,
 * and the runs of whitespace that are left collapse to single spaces.
 *
 * Only the heading's first line is read, so a setext heading's underline never reaches
 * the rail.
 *
 * `tree` is the caller's tree rather than the editor's, and it has to be the very tree
 * the heading node came out of. Read against a different one — the editor parses lazily,
 * and the list asks for more of the document than the editor has got to — a heading past
 * the parsed region has no `HeaderMark` for this to find, nothing is hidden, and the
 * entry reads `### Drones` with the hashes still on it.
 */
function renderedText(state: EditorState, tree: Tree, heading: SyntaxNode): string {
  const from = heading.from;
  const to = Math.min(heading.to, state.doc.lineAt(from).to);
  const hidden: { from: number; to: number }[] = [];
  const hide = (start: number, end: number): void => {
    if (end > from && start < to) hidden.push({ from: Math.max(start, from), to: Math.min(end, to) });
  };
  /** Whether the tree accounted for the heading's own `#` markers. */
  let markersFound = false;
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.from >= to) return false;
      if (node.name === 'HeaderMark') {
        markersFound = true;
        hide(node.from, node.to);
        return false;
      }
      if (node.name === 'Image') {
        // An image is a picture in the heading, not words, so it reads as nothing.
        hide(node.from, node.to);
        return false;
      }
      if (SPELLING.test(node.name)) {
        hide(node.from, node.to);
        return false;
      }
      if (node.name === 'Escape') {
        // `\*` is one character in the heading, written with a backslash in the file.
        hide(node.from, node.from + 1);
        return false;
      }
      if (node.name === 'LinkMark' || node.name === 'URL' || node.name === 'LinkTitle' || node.name === 'LinkLabel') {
        if (rendersAsLink(state, node.node.parent)) hide(node.from, node.to);
        return false;
      }
      return undefined;
    },
  });
  let text = '';
  let at = from;
  for (const range of merged(hidden)) {
    text += state.doc.sliceString(at, Math.max(at, range.from));
    at = Math.max(at, range.to);
  }
  text += state.doc.sliceString(at, to);
  text = text.replace(/\s+/g, ' ').trim();
  if (markersFound || !heading.name.startsWith('ATX')) return text;
  // The floor: a heading whose markers no tree accounted for is stripped by the line's
  // own spelling instead. A `#` in front of an entry reads as Sheaf being broken rather
  // than as the document saying something, so no parse has to have finished for it to go.
  // Only reached when the tree let the heading through without them, so a heading that
  // really is the single character `#` keeps it.
  return text.replace(ATX_OPENER, '').replace(ATX_CLOSER, '').trim();
}

/**
 * Where the caret goes when an entry is picked: the first character of the heading's
 * text, so typing carries on in the title rather than in front of its `#`.
 *
 * A setext heading carries its marker on the line below, so its text starts where the
 * heading does. An ATX heading whose marker the tree did not resolve is measured off the
 * line instead, for the same reason the text is.
 */
function textStart(state: EditorState, heading: SyntaxNode): number {
  const line = state.doc.lineAt(heading.from);
  let at = heading.from;
  if (heading.name.startsWith('ATX')) {
    const marks = heading.node.getChildren('HeaderMark');
    if (marks.length) at = marks[0].to;
    else at += (ATX_OPENER.exec(line.text.slice(heading.from - line.from)) ?? [''])[0].length;
  }
  while (at < line.to && /[ \t]/.test(state.doc.sliceString(at, at + 1))) at++;
  return at;
}

/**
 * Every H1, H2 and H3 in the document, in the order they appear.
 *
 * Headings written either way count. A `#` line inside a fenced block, an HTML block or
 * the front matter is not a heading and is not listed, because the tree does not call it
 * one (and, for front matter, because the rule above says so).
 *
 * The tree is the one the editor already has. `ensureSyntaxTree` finishes any tail of a
 * long document that has not been parsed yet, within a budget, so the rail lists the
 * whole file rather than the part that happens to have been looked at; if the budget runs
 * out, what has been parsed is listed and the next rebuild picks up the rest.
 *
 * That tree is then read once and passed down. Asking for it again lower down would get
 * the editor's own, which is parsed only as far as the editor has needed it, and reading
 * a heading found in one tree against the other is what put `### Drones` in the rail with
 * its hashes still attached.
 */
export function documentHeadings(state: EditorState): TocHeading[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const front = frontMatterEnd(state);
  const headings: TocHeading[] = [];
  tree.iterate({
    enter: (node) => {
      if (NOT_PROSE.test(node.name)) return false;
      const match = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
      if (!match) return undefined;
      const level = Number(match[1]);
      if (level <= DEEPEST && state.doc.lineAt(node.from).number > front) {
        const text = renderedText(state, tree, node.node);
        headings.push({ level, text, from: state.doc.lineAt(node.from).from, textFrom: textStart(state, node.node) });
      }
      return false;
    },
  });
  return headings;
}

/* ---- The rail ------------------------------------------------------------ */

/**
 * How wide the rail is, in pixels. The stylesheet sets the same number on
 * `--sheaf-toc-width`; this copy is what decides whether the pane has a margin wide
 * enough to hold it, and the two have to agree.
 */
const RAIL_WIDTH = 220;

/** The gap the rail keeps between itself and the text before it gives up on the margin. */
const RAIL_GAP = 8;

/** How far down the viewport a heading has to reach before it is the one being read. */
const READING_LINE = 0.25;

export interface TableOfContents {
  /** The rail itself, for the tests and for anyone who needs to look at it. */
  readonly el: HTMLElement;
  /** Show or hide the rail, as `sheaf.tableOfContents` says. */
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /**
   * The toolbar button was pressed. True when that only brought a panel back that had
   * been closed, which leaves the setting alone; false when the setting should flip.
   */
  reopened(): boolean;
  /** The editor exists now: watch it scroll. */
  attach(view: EditorView): void;
  /** The document changed; rebuild on the next frame. */
  documentChanged(): void;
  /** Rebuild the list and the highlight now. */
  refresh(): void;
  destroy(): void;
}

/**
 * Build the rail and put it in `parent`, ahead of the editor so that Tab reaches it
 * straight from the toolbar. It starts hidden; `setEnabled` is what shows it.
 */
export function createTableOfContents(parent: HTMLElement, getView: () => EditorView | undefined): TableOfContents {
  const nav = document.createElement('nav');
  nav.className = 'sheaf-toc';
  nav.setAttribute('aria-label', 'Table of contents');
  nav.hidden = true;

  const list = document.createElement('div');
  list.className = 'sheaf-toc-list';
  list.setAttribute('role', 'tree');
  nav.appendChild(list);

  const empty = document.createElement('p');
  empty.className = 'sheaf-toc-empty';
  empty.textContent = 'No headings yet';
  empty.hidden = true;
  nav.appendChild(empty);

  parent.insertBefore(nav, parent.firstChild);

  let on = false;
  /** True while the pane is too narrow for a rail, so the list is a panel over the text. */
  let overlay = false;
  /** True when the panel has been closed by hand and is waiting for the button to bring it back. */
  let closed = false;
  let headings: TocHeading[] = [];
  let entries: HTMLAnchorElement[] = [];
  let current = -1;
  /** The entry Tab lands on. Only one entry is a tab stop; the arrows reach the rest. */
  let tabStop = 0;
  let frame: number | null = null;
  let view: EditorView | undefined;
  let observer: ResizeObserver | undefined;

  const focusEditor = (): void => void getView()?.focus();

  /**
   * Whether the pane has a right-hand margin wide enough for the rail to sit in.
   *
   * It is measured against the text itself rather than against a breakpoint, because the
   * column's width is a setting and a breakpoint would be wrong for anyone who changed
   * it. What is measured is the last character, not the edge of CodeMirror's content box:
   * the box carries the page gutter, and the gutter is margin the rail may stand in.
   *
   * With no layout to measure — a document not shown yet, or a test with no layout engine
   * at all — the rail is the answer, so the list is never hidden for want of a number.
   */
  const marginFitsRail = (): boolean => {
    const content = view?.contentDOM ?? nav.parentElement?.querySelector('.cm-content');
    const pane = nav.parentElement;
    if (!content || !pane) return true;
    const paneBox = pane.getBoundingClientRect();
    if (paneBox.width === 0) return true;
    const gutter = parseFloat(getComputedStyle(content).paddingRight) || 0;
    return paneBox.right - (content.getBoundingClientRect().right - gutter) >= RAIL_WIDTH + RAIL_GAP;
  };

  /** Put the rail in the shape the pane has room for, and show or hide it accordingly. */
  const layout = (): void => {
    overlay = on && !marginFitsRail();
    nav.classList.toggle('is-overlay', overlay);
    const showing = on && !(overlay && closed);
    if (!showing) {
      nav.classList.remove('is-open');
      nav.hidden = true;
      return;
    }
    nav.hidden = false;
    // A panel slides in from the edge, and a transition needs the element to have been
    // laid out before the class that moves it arrives. One frame is what that costs.
    if (nav.classList.contains('is-open')) return;
    requestAnimationFrame(() => void (on && nav.classList.add('is-open')));
  };

  /** Move the caret to a heading and bring it to the top of the editor. */
  const goTo = (heading: TocHeading): void => {
    const editor = getView();
    if (!editor) return;
    // Smooth scrolling is a stylesheet rule, so that `prefers-reduced-motion` can turn it
    // off where the person has asked for that; it is on only for the length of this jump,
    // so nothing else in the editor starts gliding.
    editor.scrollDOM.classList.add('sheaf-toc-gliding');
    editor.dispatch({
      selection: { anchor: heading.textFrom },
      effects: EditorView.scrollIntoView(heading.from, { y: 'start', yMargin: 12 }),
      // Moving the caret is not an edit. Nothing is written, nothing is made dirty, and
      // this must never become the thing Cmd+Z takes back.
      annotations: Transaction.addToHistory.of(false),
      scrollIntoView: false,
    });
    editor.focus();
    setTimeout(() => editor.scrollDOM.classList.remove('sheaf-toc-gliding'), 400);
    if (overlay) {
      closed = true;
      layout();
    }
  };

  /** Give one entry the tab stop, so Tab enters the rail where the arrows left it. */
  const setTabStop = (index: number): void => {
    tabStop = Math.max(0, Math.min(index, entries.length - 1));
    entries.forEach((entry, i) => void (entry.tabIndex = i === tabStop ? 0 : -1));
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const index = entries.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      if (overlay) {
        closed = true;
        layout();
      }
      focusEditor();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!entries.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = index < 0 ? (step === 1 ? 0 : entries.length - 1) : (index + step + entries.length) % entries.length;
      setTabStop(next);
      entries[next].focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (index < 0) return;
      event.preventDefault();
      goTo(headings[index]);
    }
  };
  nav.addEventListener('keydown', onKeyDown);

  /** Rebuild the entries from the document. */
  const build = (): void => {
    const editor = getView();
    headings = editor ? documentHeadings(editor.state) : [];
    list.textContent = '';
    entries = headings.map((heading, index) => {
      const entry = document.createElement('a');
      entry.className = `sheaf-toc-entry sheaf-toc-h${heading.level}`;
      entry.setAttribute('role', 'treeitem');
      entry.setAttribute('aria-level', String(heading.level));
      // No href: this goes nowhere the browser understands, and an empty heading would
      // otherwise be a link with nothing to read.
      entry.textContent = heading.text || 'Untitled heading';
      // The whole heading, for the one that had to be cut short to fit on its line.
      entry.title = heading.text || 'Untitled heading';
      entry.tabIndex = index === 0 ? 0 : -1;
      entry.addEventListener('mousedown', (e) => e.preventDefault());
      entry.addEventListener('click', () => goTo(heading));
      list.appendChild(entry);
      return entry;
    });
    // A document with no headings says so. An empty rail reads as the feature being broken.
    empty.hidden = entries.length > 0;
    current = -1;
    setTabStop(tabStop);
  };

  /**
   * Mark the heading being read: the last one whose top has passed the top quarter of
   * the viewport. Positions are taken from the editor's own block layout rather than
   * from the DOM, so a heading scrolled off the top still counts.
   */
  const spy = (): void => {
    const editor = getView();
    let next = -1;
    if (editor && entries.length) {
      const box = editor.scrollDOM.getBoundingClientRect();
      if (box.height > 0) {
        const line = box.top + box.height * READING_LINE;
        for (let i = 0; i < headings.length; i++) {
          if (editor.documentTop + editor.lineBlockAt(headings[i].from).top > line) break;
          next = i;
        }
      }
    }
    if (next === current) return;
    if (current >= 0 && entries[current]) {
      entries[current].classList.remove('is-current');
      entries[current].removeAttribute('aria-current');
    }
    current = next;
    if (current < 0) return;
    const entry = entries[current];
    entry.classList.add('is-current');
    entry.setAttribute('aria-current', 'location');
    // Keep the marked entry inside the rail when the rail is scrolling on its own.
    if (nav.clientHeight > 0 && nav.scrollHeight > nav.clientHeight) {
      if (entry.offsetTop < nav.scrollTop) nav.scrollTop = entry.offsetTop;
      else if (entry.offsetTop + entry.offsetHeight > nav.scrollTop + nav.clientHeight) {
        nav.scrollTop = entry.offsetTop + entry.offsetHeight - nav.clientHeight;
      }
    }
  };

  const refresh = (): void => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (!on) return;
    build();
    layout();
    spy();
  };

  const documentChanged = (): void => {
    if (!on || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      refresh();
    });
  };

  return {
    el: nav,
    enabled: () => on,
    setEnabled(next: boolean): void {
      if (next === on) return;
      on = next;
      // Turning it on always shows it, panel or rail; the person has just asked for it.
      closed = false;
      if (on) refresh();
      else layout();
    },
    reopened(): boolean {
      if (!on || !overlay || !closed) return false;
      closed = false;
      layout();
      entries[tabStop]?.focus();
      return true;
    },
    attach(editor: EditorView): void {
      view = editor;
      editor.scrollDOM.addEventListener('scroll', spy, { passive: true });
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(() => {
          if (on) {
            layout();
            spy();
          }
        });
        observer.observe(editor.scrollDOM);
      }
      refresh();
    },
    documentChanged,
    refresh,
    destroy(): void {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      view?.scrollDOM.removeEventListener('scroll', spy);
      nav.removeEventListener('keydown', onKeyDown);
      nav.remove();
    },
  };
}
