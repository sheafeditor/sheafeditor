// Unit scenarios for prose editing commands. Each asserts what should be true;
// a failing scenario describes what a person would see go wrong.
import { EditorSelection, Prec } from '@codemirror/state';
import { keymap, lineNumbers } from '@codemirror/view';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { mountProse } from '../../harness';
import {
  toggleWrap,
  toggleHeading,
  toggleBullet,
  toggleOrdered,
  toggleQuote,
  toggleCodeBlock,
  insertDivider,
  insertCodeBlock,
  clearFormatting,
  insertLink,
  insertHardBreak,
  turnInto,
  mountToolbar,
  refreshToolbar,
} from '../../../src/webview/toolbar';
import { formatStateAt } from '../../../src/webview/formatState';
import { createShortcutsOverlay, buildEditingKeymap } from '../../../src/webview/shortcuts';

type Result = boolean | { ok: boolean; detail?: string };
interface Scenario {
  id: string;
  feature: string;
  name: string;
  run: () => Result | Promise<Result>;
}
type Prose = ReturnType<typeof mountProse>;

const G: any = globalThis;
const same = (got: string, want: string): Result => ({ ok: got === want, detail: got === want ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}` });
const oneOf = (got: string, wants: string[]): Result => ({ ok: wants.includes(got), detail: `got ${JSON.stringify(got)}, want one of ${JSON.stringify(wants)}` });

/** Mount `doc`, select [anchor, head], run `fn`, return the document. */
function edit(doc: string, anchor: number, head: number | undefined, fn: (p: Prose) => void): string {
  const p = mountProse(doc);
  p.select(anchor, head);
  fn(p);
  const out = p.doc();
  p.destroy();
  return out;
}

/** Mount `doc` with several ranges selected, run `fn`, return the document. */
function editRanges(doc: string, ranges: [number, number][], fn: (p: Prose) => void): string {
  const p = mountProse(doc);
  p.view.dispatch({ selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h))) });
  fn(p);
  const out = p.doc();
  p.destroy();
  return out;
}

/** The syntax nodes of a document, as a person's Markdown reader would parse it. */
function nodesOf(doc: string): { name: string; text: string }[] {
  const p = mountProse(doc);
  const tree = ensureSyntaxTree(p.view.state, doc.length, 5000) ?? syntaxTree(p.view.state);
  const out: { name: string; text: string }[] = [];
  tree.iterate({ enter: (n) => void out.push({ name: n.name, text: doc.slice(n.from, n.to) }) });
  p.destroy();
  return out;
}
const has = (doc: string, name: string): boolean => nodesOf(doc).some((n) => n.name === name);
const count = (doc: string, name: string): number => nodesOf(doc).filter((n) => n.name === name).length;

/** Position just after the first occurrence of `needle` (plus `delta`). */
const at = (doc: string, needle: string, delta = 0): number => doc.indexOf(needle) + delta;

/** Type text at the selection the way input does. */
const typeText = (p: Prose, text: string): void => p.view.dispatch(p.view.state.replaceSelection(text), { userEvent: 'input.type' } as any);

/* ---- Toolbar in jsdom ---- */

interface Bar {
  el: HTMLElement;
  click: (cmd: string) => void;
  button: (cmd: string) => HTMLButtonElement;
  menuItem: (dropdown: string, label: string) => HTMLButtonElement;
  refresh: () => void;
  remove: () => void;
}
function mountBar(p: Prose, toggleLines: () => boolean = () => false, lineNumbersOn = false, onShortcuts: () => void = () => {}): Bar {
  const el = document.createElement('div');
  document.body.appendChild(el);
  mountToolbar(el, () => p.view, onShortcuts, () => {}, toggleLines, lineNumbersOn);
  const button = (cmd: string): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`[data-command="${cmd}"]`)!;
  return {
    el,
    button,
    click: (cmd) => button(cmd).click(),
    menuItem: (dropdown, label) =>
      Array.from(button(dropdown).parentElement!.querySelectorAll<HTMLButtonElement>('.sheaf-tb-menu-item')).find((b) => b.querySelector('span')!.textContent === label)!,
    refresh: () => refreshToolbar(p.view),
    remove: () => el.remove(),
  };
}
/** Run `fn` with a toolbar mounted over `doc` selected at [anchor, head]; return the document. */
function withBar(doc: string, anchor: number, head: number | undefined, fn: (b: Bar, p: Prose) => void): string {
  const p = mountProse(doc);
  p.select(anchor, head);
  const b = mountBar(p);
  b.refresh();
  fn(b, p);
  const out = p.doc();
  b.remove();
  p.destroy();
  return out;
}
const pressedOn = (b: Bar, cmd: string): boolean => b.button(cmd).classList.contains('is-active') && b.button(cmd).getAttribute('aria-pressed') === 'true';

const CODE = '```\nlet x = 1\n```';
const IN_CODE = 6;

export const scenarios: Scenario[] = [
  /* ---- prose.inline-marks ---- */
  {
    id: 'prose.inline-marks.u01',
    feature: 'prose.inline-marks',
    name: 'Bold on a selected word wraps it in **',
    run: () => same(edit('say hello now', 4, 9, (p) => toggleWrap(p.view, '**')), 'say **hello** now'),
  },
  {
    id: 'prose.inline-marks.u02',
    feature: 'prose.inline-marks',
    name: 'Bold twice on the same selection gives the original text back',
    run: () => same(edit('say hello now', 4, 9, (p) => (toggleWrap(p.view, '**'), toggleWrap(p.view, '**'))), 'say hello now'),
  },
  {
    id: 'prose.inline-marks.u03',
    feature: 'prose.inline-marks',
    name: 'Bold twice with a bare caret leaves the text as it was',
    run: () => same(edit('say hello now', 13, undefined, (p) => (toggleWrap(p.view, '**'), toggleWrap(p.view, '**'))), 'say hello now'),
  },
  {
    id: 'prose.inline-marks.u04',
    feature: 'prose.inline-marks',
    name: 'Bold with a bare caret inside bold text removes that bold',
    run: () => same(edit('say **hello** now', 8, undefined, (p) => toggleWrap(p.view, '**')), 'say hello now'),
  },
  {
    id: 'prose.inline-marks.u05',
    feature: 'prose.inline-marks',
    name: 'Bold on a selection that includes the ** markers removes them',
    run: () => same(edit('say **hello** now', 4, 13, (p) => toggleWrap(p.view, '**')), 'say hello now'),
  },
  {
    id: 'prose.inline-marks.u06',
    feature: 'prose.inline-marks',
    name: 'Bold on part of a bold word removes bold from that part only',
    run: () => same(edit('**helloworld**', 7, 12, (p) => toggleWrap(p.view, '**')), '**hello**world'),
  },
  {
    id: 'prose.inline-marks.u07',
    feature: 'prose.inline-marks',
    name: 'Bold on a selection with spaces at its edges keeps the spaces outside the markers',
    run: () => same(edit('say hello now', 3, 10, (p) => toggleWrap(p.view, '**')), 'say **hello** now'),
  },
  {
    id: 'prose.inline-marks.u08',
    feature: 'prose.inline-marks',
    name: 'Bold across two paragraphs wraps each paragraph on its own',
    run: () => same(edit('one\n\ntwo', 0, 8, (p) => toggleWrap(p.view, '**')), '**one**\n\n**two**'),
  },
  {
    id: 'prose.inline-marks.u09',
    feature: 'prose.inline-marks',
    name: 'Italic inside bold adds italic and a second Italic takes it off again',
    run: () => {
      const once = edit('**hello**', 2, 7, (p) => toggleWrap(p.view, '*'));
      const twice = edit('**hello**', 2, 7, (p) => (toggleWrap(p.view, '*'), toggleWrap(p.view, '*')));
      return { ok: formatItalicBold(once) && twice === '**hello**', detail: `once ${JSON.stringify(once)}, twice ${JSON.stringify(twice)}` };
    },
  },
  {
    id: 'prose.inline-marks.u10',
    feature: 'prose.inline-marks',
    name: 'Mod-b does what the Bold button does',
    run: () => same(edit('say hello now', 4, 9, (p) => p.press('Mod-b')), 'say **hello** now'),
  },
  {
    id: 'prose.inline-marks.u11',
    feature: 'prose.inline-marks',
    name: 'Inline code, strikethrough and highlight each toggle off on the second press',
    run: () => {
      const outs = ['`', '~~', '=='].map((m) => edit('say hello now', 4, 9, (p) => (toggleWrap(p.view, m), toggleWrap(p.view, m))));
      return { ok: outs.every((o) => o === 'say hello now'), detail: JSON.stringify(outs) };
    },
  },
  {
    id: 'prose.inline-marks.u12',
    feature: 'prose.inline-marks',
    name: 'Bold then undo restores the text in one step',
    run: () => same(edit('say hello now', 4, 9, (p) => (toggleWrap(p.view, '**'), p.press('Mod-z'))), 'say hello now'),
  },
  {
    id: 'prose.inline-marks.u13',
    feature: 'prose.inline-marks',
    name: 'The format state reports bold for a caret inside bold text',
    run: () => {
      const p = mountProse('say **hello** now');
      const fs = formatStateAt(p.view.state, 8);
      p.destroy();
      return { ok: fs.bold === true, detail: JSON.stringify(fs) };
    },
  },
  {
    id: 'prose.inline-marks.u14',
    feature: 'prose.inline-marks',
    name: 'The Italic, Strikethrough, Highlight and Inline code buttons each wrap a selected word in their marker',
    run: () => {
      const outs = ['italic', 'strike', 'highlight', 'code'].map((cmd) => withBar('say hello now', 4, 9, (b) => b.click(cmd)));
      const want = ['say *hello* now', 'say ~~hello~~ now', 'say ==hello== now', 'say `hello` now'];
      return { ok: outs.join('|') === want.join('|'), detail: JSON.stringify(outs) };
    },
  },
  {
    id: 'prose.inline-marks.u15',
    feature: 'prose.inline-marks',
    name: 'Mod-i, Mod-Shift-x, Mod-Shift-h and Mod-e do what their buttons do',
    run: () => {
      const outs = ['Mod-i', 'Mod-Shift-x', 'Mod-Shift-h', 'Mod-e'].map((k) => edit('say hello now', 4, 9, (p) => p.press(k)));
      const want = ['say *hello* now', 'say ~~hello~~ now', 'say ==hello== now', 'say `hello` now'];
      return { ok: outs.join('|') === want.join('|'), detail: JSON.stringify(outs) };
    },
  },
  {
    id: 'prose.inline-marks.u16',
    feature: 'prose.inline-marks',
    name: 'Bold with two words selected at once (multiple cursors) bolds both',
    run: () => same(editRanges('one two three', [[0, 3], [8, 13]], (p) => toggleWrap(p.view, '**')), '**one** two **three**'),
  },
  {
    id: 'prose.inline-marks.u17',
    feature: 'prose.inline-marks',
    name: 'Bold, Italic and Highlight buttons with a word selected inside a code block leave the code unchanged',
    run: () => {
      const outs = ['bold', 'italic', 'highlight'].map((cmd) => withBar(CODE, 8, 9, (b) => b.click(cmd)));
      return { ok: outs.every((o) => o === CODE), detail: JSON.stringify(outs) };
    },
  },
  {
    id: 'prose.inline-marks.u18',
    feature: 'prose.inline-marks',
    name: 'Inline code on text that contains a backtick makes one code span that shows the backtick',
    run: () => {
      const out = edit('run a`b now', 4, 7, (p) => toggleWrap(p.view, '`'));
      const spans = nodesOf(out).filter((n) => n.name === 'InlineCode');
      const ok = spans.length === 1 && spans[0].text.replace(/^`+ ?| ?`+$/g, '') === 'a`b';
      return { ok, detail: `${JSON.stringify(out)} spans ${JSON.stringify(spans.map((s) => s.text))}` };
    },
  },
  {
    id: 'prose.inline-marks.u19',
    feature: 'prose.inline-marks',
    name: 'Italic on a word directly after a bold word makes it italic and keeps the bold',
    run: () => {
      const out = edit('**one**two', 7, 10, (p) => toggleWrap(p.view, '*'));
      const p = mountProse(out);
      const fsOne = formatStateAt(p.view.state, out.indexOf('one') + 1);
      const fsTwo = formatStateAt(p.view.state, out.indexOf('two') + 1);
      p.destroy();
      return { ok: fsOne.bold && !fsOne.italic && fsTwo.italic && !fsTwo.bold, detail: `${JSON.stringify(out)} one ${JSON.stringify(fsOne)} two ${JSON.stringify(fsTwo)}` };
    },
  },
  {
    id: 'prose.inline-marks.u20',
    feature: 'prose.inline-marks',
    name: 'Bold on part of a CJK word and on an emoji makes them bold',
    run: () => {
      const cjk = edit('日本語です', 0, 2, (p) => toggleWrap(p.view, '**'));
      const emoji = edit('hi 👋 there', 3, 5, (p) => toggleWrap(p.view, '**'));
      const p = mountProse(cjk);
      const q = mountProse(emoji);
      const ok = cjk === '**日本**語です' && formatStateAt(p.view.state, 3).bold && emoji === 'hi **👋** there' && formatStateAt(q.view.state, 6).bold;
      p.destroy();
      q.destroy();
      return { ok, detail: JSON.stringify([cjk, emoji]) };
    },
  },
  {
    id: 'prose.inline-marks.u21',
    feature: 'prose.inline-marks',
    name: 'Italic, undo, then redo puts the italic back',
    // The unit harness runs CodeMirror's non-Mac, non-Linux keymap, where redo is Mod-y; macOS Cmd+Shift+Z is covered in e2e.
    run: () => same(edit('say hello now', 4, 9, (p) => (p.press('Mod-i'), p.press('Mod-z'), p.press('Mod-y'))), 'say *hello* now'),
  },
  {
    id: 'prose.inline-marks.u22',
    feature: 'prose.inline-marks',
    name: 'Bold on a word in a heading, a list item and a quote keeps the line prefix',
    run: () => {
      const outs = ['# say hello', '- say hello', '> say hello'].map((d) => edit(d, d.length - 5, d.length, (p) => toggleWrap(p.view, '**')));
      return { ok: outs.join('|') === '# say **hello**|- say **hello**|> say **hello**', detail: JSON.stringify(outs) };
    },
  },

  /* ---- prose.text-style ---- */
  {
    id: 'prose.text-style.u01',
    feature: 'prose.text-style',
    // The heading keys set a level, the way picking it from the Text style menu does,
    // rather than toggling it: pressed again they leave the heading alone, and Mod-Alt-0,
    // the row under them in the shortcuts overlay, is how a heading goes back to text.
    name: 'Mod-Alt-2 makes a paragraph a Heading 2, pressing it again keeps it, and Mod-Alt-0 makes it text',
    run: () => {
      const once = edit('Title', 2, undefined, (p) => p.press('Mod-Alt-2'));
      const twice = edit('Title', 2, undefined, (p) => (p.press('Mod-Alt-2'), p.press('Mod-Alt-2')));
      const back = edit('Title', 2, undefined, (p) => (p.press('Mod-Alt-2'), p.press('Mod-Alt-0')));
      return {
        ok: once === '## Title' && twice === '## Title' && back === 'Title',
        detail: JSON.stringify([once, twice, back]),
      };
    },
  },
  {
    id: 'prose.text-style.u02',
    feature: 'prose.text-style',
    name: 'Text style menu: Heading 2 on a Heading 2 leaves it, and Text turns it back into text',
    run: () => {
      const keep = withBar('## Title', 5, undefined, (b) => b.menuItem('heading', 'Heading 2').click());
      const text = withBar('## Title', 5, undefined, (b) => b.menuItem('heading', 'Text').click());
      return { ok: keep === '## Title' && text === 'Title', detail: JSON.stringify([keep, text]) };
    },
  },
  {
    id: 'prose.text-style.u03',
    feature: 'prose.text-style',
    name: 'Mod-Alt-1 on a Heading 3 makes it a Heading 1',
    run: () => same(edit('### Title', 6, undefined, (p) => p.press('Mod-Alt-1')), '# Title'),
  },
  {
    id: 'prose.text-style.u04',
    feature: 'prose.text-style',
    name: 'Mod-Alt-0 turns a heading into text and leaves a paragraph alone',
    run: () => {
      const h = edit('## Title', 5, undefined, (p) => p.press('Mod-Alt-0'));
      const t = edit('Title', 2, undefined, (p) => p.press('Mod-Alt-0'));
      return { ok: h === 'Title' && t === 'Title', detail: JSON.stringify([h, t]) };
    },
  },
  {
    id: 'prose.text-style.u05',
    feature: 'prose.text-style',
    name: 'Mod-Alt-2 on a bullet item makes a heading of the item text, the same as Text style > Heading 2',
    run: () => {
      const key = edit('- item', 4, undefined, (p) => p.press('Mod-Alt-2'));
      const menu = withBar('- item', 4, undefined, (b) => b.menuItem('heading', 'Heading 2').click());
      return { ok: key === menu && key === '## item', detail: `shortcut ${JSON.stringify(key)}, menu ${JSON.stringify(menu)}` };
    },
  },
  {
    id: 'prose.text-style.u06',
    feature: 'prose.text-style',
    name: 'Mod-Alt-2 on a quoted line gives a heading whose text is the quote, with no > showing',
    run: () => {
      const out = edit('> quote', 4, undefined, (p) => p.press('Mod-Alt-2'));
      const heading = nodesOf(out).find((n) => n.name === 'ATXHeading2');
      return { ok: ['## quote', '> ## quote'].includes(out) && !!heading, detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.text-style.u07',
    feature: 'prose.text-style',
    name: 'Mod-Alt-1 across two paragraphs makes two headings and leaves the blank line between them blank',
    run: () => same(edit('one\n\ntwo', 0, 8, (p) => p.press('Mod-Alt-1')), '# one\n\n# two'),
  },
  {
    id: 'prose.text-style.u08',
    feature: 'prose.text-style',
    name: 'Text style > Heading 2 on a setext heading gives a Heading 2 with no underline left behind as text',
    run: () => {
      const out = withBar('Title\n=====\n\nnext', 2, undefined, (b) => b.menuItem('heading', 'Heading 2').click());
      return { ok: out === '## Title\n\nnext', detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.text-style.u09',
    feature: 'prose.text-style',
    name: 'Text style > Heading 1 with the caret in a code block removes the fences and heads the line',
    run: () => same(withBar(CODE, IN_CODE, undefined, (b) => b.menuItem('heading', 'Heading 1').click()), '# let x = 1'),
  },
  {
    id: 'prose.text-style.u10',
    feature: 'prose.text-style',
    name: 'Mod-Alt-3 with carets on two lines heads both, and one undo takes both back',
    run: () => {
      const p = mountProse('one\ntwo');
      p.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(5)]) });
      p.press('Mod-Alt-3');
      const both = p.doc();
      p.press('Mod-z');
      const back = p.doc();
      p.destroy();
      return { ok: both === '### one\n### two' && back === 'one\ntwo', detail: JSON.stringify([both, back]) };
    },
  },
  {
    id: 'prose.text-style.u11',
    feature: 'prose.text-style',
    name: 'The Text style trigger opens from the keyboard with ArrowDown, arrows move, Escape closes and refocuses it',
    run: () => {
      const p = mountProse('x');
      const b = mountBar(p);
      const trigger = b.button('heading');
      const menu = trigger.parentElement!.querySelector<HTMLElement>('.sheaf-tb-menu')!;
      trigger.focus();
      trigger.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const opened = !menu.hidden && document.activeElement === b.menuItem('heading', 'Text');
      menu.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const moved = document.activeElement === b.menuItem('heading', 'Heading 1');
      menu.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const closed = menu.hidden && document.activeElement === trigger;
      b.remove();
      p.destroy();
      return { ok: opened && moved && closed, detail: JSON.stringify({ opened, moved, closed }) };
    },
  },

  /* ---- prose.lists ---- */
  {
    id: 'prose.lists.u01',
    feature: 'prose.lists',
    name: 'Bullet list on two lines bullets both, and again removes both',
    run: () => {
      const once = withBar('one\ntwo', 0, 7, (b) => b.click('bullet'));
      const twice = withBar('- one\n- two', 0, 11, (b) => b.click('bullet'));
      return { ok: once === '- one\n- two' && twice === 'one\ntwo', detail: JSON.stringify([once, twice]) };
    },
  },
  {
    id: 'prose.lists.u02',
    feature: 'prose.lists',
    name: 'Numbered list numbers three lines 1 to 3, and again removes the numbers',
    run: () => {
      const once = withBar('a\nb\nc', 0, 5, (b) => b.click('ordered'));
      const twice = withBar('1. a\n2. b\n3. c', 0, 14, (b) => b.click('ordered'));
      return { ok: once === '1. a\n2. b\n3. c' && twice === 'a\nb\nc', detail: JSON.stringify([once, twice]) };
    },
  },
  {
    id: 'prose.lists.u03',
    feature: 'prose.lists',
    name: 'Numbered list on a bullet list converts it, and Bullet list on a numbered list converts back',
    run: () => {
      const toNum = withBar('- a\n- b', 0, 7, (b) => b.click('ordered'));
      const toBul = withBar('1. a\n2. b', 0, 9, (b) => b.click('bullet'));
      return { ok: toNum === '1. a\n2. b' && toBul === '- a\n- b', detail: JSON.stringify([toNum, toBul]) };
    },
  },
  {
    id: 'prose.lists.u04',
    feature: 'prose.lists',
    name: 'Bullet list on a task item makes it a plain bullet without a stray [ ]',
    run: () => oneOf(withBar('- [ ] buy milk', 8, undefined, (b) => b.click('bullet')), ['- buy milk', 'buy milk']),
  },
  {
    id: 'prose.lists.u05',
    feature: 'prose.lists',
    name: 'Bullet list over two paragraphs bullets each and leaves the blank line between them without a bullet',
    run: () => same(withBar('one\n\ntwo', 0, 8, (b) => b.click('bullet')), '- one\n\n- two'),
  },
  {
    id: 'prose.lists.u06',
    feature: 'prose.lists',
    name: 'Bullet list over a list whose items are separated by a blank line removes the bullets',
    run: () => same(withBar('- one\n\n- two', 0, 12, (b) => b.click('bullet')), 'one\n\ntwo'),
  },
  {
    id: 'prose.lists.u07',
    feature: 'prose.lists',
    name: 'Numbered list on a nested bullet keeps it nested under its parent',
    run: () => same(withBar('- parent\n    - child', 16, undefined, (b) => b.click('ordered')), '- parent\n    1. child'),
  },
  {
    id: 'prose.lists.u08',
    feature: 'prose.lists',
    name: 'Bullet list off on a nested bullet keeps the text on its own line under the parent',
    run: () => {
      const out = withBar('- parent\n    - child', 16, undefined, (b) => b.click('bullet'));
      return { ok: out === '- parent\n    child' || out === '- parent\n\n    child', detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.lists.u09',
    feature: 'prose.lists',
    name: 'Bullet list on two quoted lines makes a list inside the quote',
    run: () => same(withBar('> one\n> two', 0, 11, (b) => b.click('bullet')), '> - one\n> - two'),
  },
  {
    id: 'prose.lists.u10',
    feature: 'prose.lists',
    name: 'Mod-Shift-8, Mod-Shift-7 and Mod-Alt-4 do what the Bullet, Numbered and Task buttons do',
    run: () => {
      const outs = ['Mod-Shift-8', 'Mod-Shift-7', 'Mod-Alt-4'].map((k) => edit('a\nb', 0, 3, (p) => p.press(k)));
      return { ok: outs.join('|') === '- a\n- b|1. a\n2. b|- [ ] a\n- [ ] b', detail: JSON.stringify(outs) };
    },
  },
  {
    id: 'prose.lists.u11',
    feature: 'prose.lists',
    name: 'Bullet, Numbered and Task buttons with the caret inside a code block leave the code unchanged',
    run: () => {
      const outs = ['bullet', 'ordered', 'task'].map((cmd) => withBar(CODE, IN_CODE, undefined, (b) => b.click(cmd)));
      return { ok: outs.every((o) => o === CODE), detail: JSON.stringify(outs) };
    },
  },
  {
    id: 'prose.lists.u12',
    feature: 'prose.lists',
    name: 'Numbered list then one undo gives the lines back',
    run: () => same(withBar('a\nb', 0, 3, (b, p) => (b.click('ordered'), p.press('Mod-z'))), 'a\nb'),
  },

  /* ---- prose.quote ---- */
  {
    id: 'prose.quote.u01',
    feature: 'prose.quote',
    name: 'Quote on a paragraph quotes it, and again unquotes it',
    run: () => {
      const once = withBar('say it', 2, undefined, (b) => b.click('quote'));
      const twice = withBar('say it', 2, undefined, (b) => (b.click('quote'), b.click('quote')));
      return { ok: once === '> say it' && twice === 'say it', detail: JSON.stringify([once, twice]) };
    },
  },
  {
    id: 'prose.quote.u02',
    feature: 'prose.quote',
    name: 'Quote on a quote of two paragraphs joined by a bare > line removes the quote',
    run: () => same(withBar('> one\n>\n> two', 0, 13, (b) => b.click('quote')), 'one\n\ntwo'),
  },
  {
    id: 'prose.quote.u03',
    feature: 'prose.quote',
    name: 'Quote on a quote written without a space after > removes the quote',
    run: () => same(withBar('>tight', 3, undefined, (b) => b.click('quote')), 'tight'),
  },
  {
    id: 'prose.quote.u04',
    feature: 'prose.quote',
    name: 'Quote in a nested quote removes one level',
    run: () => same(withBar('> > deep', 6, undefined, (b) => b.click('quote')), '> deep'),
  },
  {
    id: 'prose.quote.u05',
    feature: 'prose.quote',
    name: 'Quote on a bullet item quotes the list item',
    run: () => same(withBar('- item', 4, undefined, (b) => b.click('quote')), '> - item'),
  },
  {
    id: 'prose.quote.u06',
    feature: 'prose.quote',
    name: 'Mod-Shift-9 does what the Quote button does, and one undo takes it back',
    run: () => {
      const once = edit('a\nb', 0, 3, (p) => p.press('Mod-Shift-9'));
      const back = edit('a\nb', 0, 3, (p) => (p.press('Mod-Shift-9'), p.press('Mod-z')));
      return { ok: once === '> a\n> b' && back === 'a\nb', detail: JSON.stringify([once, back]) };
    },
  },
  {
    id: 'prose.quote.u07',
    feature: 'prose.quote',
    name: 'Quote with the caret inside a code block leaves the code unchanged',
    run: () => same(withBar(CODE, IN_CODE, undefined, (b) => b.click('quote')), CODE),
  },

  /* ---- prose.code-block ---- */
  {
    id: 'prose.code-block.u01',
    feature: 'prose.code-block',
    name: 'Code block on an empty line makes an empty block with the caret inside',
    run: () => {
      const p = mountProse('above\n\n\nbelow');
      p.select(6);
      toggleCodeBlock(p.view);
      const doc = p.doc();
      const line = p.view.state.doc.lineAt(p.view.state.selection.main.head).number;
      const inside = formatStateAt(p.view.state).codeBlock;
      p.destroy();
      return { ok: doc === 'above\n```\n\n```\n\nbelow' && line === 3 && inside, detail: JSON.stringify({ doc, line, inside }) };
    },
  },
  {
    id: 'prose.code-block.u02',
    feature: 'prose.code-block',
    name: 'Code block with the caret in a fenced block that names a language removes both fences and keeps the code',
    run: () => same(withBar('```js\nlet a\n```', 7, undefined, (b) => b.click('codeBlock')), 'let a'),
  },
  {
    id: 'prose.code-block.u03',
    feature: 'prose.code-block',
    name: 'Code block over two paragraphs puts both and the blank line into one block',
    run: () => same(withBar('one\n\ntwo', 0, 8, (b) => b.click('codeBlock')), '```\none\n\ntwo\n```'),
  },
  {
    id: 'prose.code-block.u04',
    feature: 'prose.code-block',
    name: 'Code block inside a tilde fence, and inside a fence with no closing line, removes the fences',
    run: () => {
      const tilde = withBar('~~~\nx\n~~~', 5, undefined, (b) => b.click('codeBlock'));
      const open = withBar('```\nx', 5, undefined, (b) => b.click('codeBlock'));
      return { ok: tilde === 'x' && open === 'x', detail: JSON.stringify([tilde, open]) };
    },
  },
  {
    id: 'prose.code-block.u05',
    feature: 'prose.code-block',
    name: 'Code block inside a fenced block in a list item removes the fences and keeps the item indentation',
    run: () => same(withBar('- item\n\n  ```\n  x\n  ```', 15, undefined, (b) => b.click('codeBlock')), '- item\n\n  x'),
  },
  {
    id: 'prose.code-block.u06',
    feature: 'prose.code-block',
    name: 'Mod-Alt-8 does what the Code block button does, and one undo takes it back',
    run: () => {
      const once = edit('a', 1, undefined, (p) => p.press('Mod-Alt-8'));
      const back = edit('a', 1, undefined, (p) => (p.press('Mod-Alt-8'), p.press('Mod-z')));
      return { ok: once === '```\na\n```' && back === 'a', detail: JSON.stringify([once, back]) };
    },
  },
  {
    id: 'prose.code-block.u07',
    feature: 'prose.code-block',
    name: 'Code block on code that contains a ``` run uses a longer fence so the block stays whole',
    run: () => {
      const out = withBar('see ```x``` here', 2, undefined, (b) => b.click('codeBlock'));
      return { ok: out === '````\nsee ```x``` here\n````' && count(out, 'FencedCode') === 1, detail: JSON.stringify(out) };
    },
  },

  /* ---- prose.insert-menu ---- */
  {
    id: 'prose.insert-menu.u01',
    feature: 'prose.insert-menu',
    name: 'Insert > Code block on a text line adds an empty block below it with the caret inside',
    run: () => {
      const p = mountProse('text');
      p.select(2);
      const b = mountBar(p);
      b.menuItem('insert', 'Code block').click();
      const doc = p.doc();
      const inside = formatStateAt(p.view.state).codeBlock && p.view.state.doc.lineAt(p.view.state.selection.main.head).number === 4;
      b.remove();
      p.destroy();
      return { ok: doc === 'text\n\n```\n\n```' && inside, detail: JSON.stringify({ doc, inside }) };
    },
  },
  {
    id: 'prose.insert-menu.u02',
    feature: 'prose.insert-menu',
    name: 'Insert > Code block with the caret inside a code block adds the new block below that block',
    run: () => same(withBar(CODE, IN_CODE, undefined, (b) => b.menuItem('insert', 'Code block').click()), CODE + '\n\n```\n\n```'),
  },
  {
    id: 'prose.insert-menu.u03',
    feature: 'prose.insert-menu',
    name: 'Insert > Code block with a word selected wraps the line in a block',
    run: () => same(withBar('say hi', 4, 6, (b) => b.menuItem('insert', 'Code block').click()), '```\nsay hi\n```'),
  },
  {
    id: 'prose.insert-menu.u04',
    feature: 'prose.insert-menu',
    name: 'Insert > Markdown table with the caret mid-paragraph puts the table after the paragraph, not inside it',
    run: () => {
      const out = withBar('one two\nthree\n\nnext', 3, undefined, (b) => b.menuItem('insert', 'Markdown table').click());
      return { ok: out.startsWith('one two\nthree\n\n|') && out.endsWith('\n\nnext') && count(out, 'Table') === 1, detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.insert-menu.u05',
    feature: 'prose.insert-menu',
    name: 'Insert > CSV data table puts a csv fenced block after the paragraph',
    run: () => {
      const out = withBar('para', 2, undefined, (b) => b.menuItem('insert', 'CSV data table').click());
      return { ok: /^para\n\n```csv\n[\s\S]*\n```\n?$/.test(out), detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.insert-menu.u06',
    feature: 'prose.insert-menu',
    name: 'Insert > Image opens a file picker that accepts images, and cancelling it changes nothing',
    run: () => {
      const clicked: HTMLInputElement[] = [];
      const orig = G.HTMLInputElement.prototype.click;
      G.HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
        if (this.type === 'file') clicked.push(this);
        else orig.call(this);
      };
      try {
        const out = withBar('para', 4, undefined, (b) => {
          b.menuItem('insert', 'Image').click();
          clicked[0]?.dispatchEvent(new G.Event('cancel'));
        });
        const ok = clicked.length === 1 && clicked[0].accept === 'image/*' && out === 'para' && !document.body.contains(clicked[0]);
        return { ok, detail: JSON.stringify({ n: clicked.length, accept: clicked[0]?.accept, out }) };
      } finally {
        G.HTMLInputElement.prototype.click = orig;
      }
    },
  },
  {
    id: 'prose.insert-menu.u07',
    feature: 'prose.insert-menu',
    name: 'The Insert menu closes when the mouse goes down outside it',
    run: () => {
      const p = mountProse('x');
      const b = mountBar(p);
      const trigger = b.button('insert');
      const menu = trigger.parentElement!.querySelector<HTMLElement>('.sheaf-tb-menu')!;
      trigger.dispatchEvent(new G.MouseEvent('click', { bubbles: true, detail: 1 }));
      const opened = !menu.hidden;
      document.body.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true }));
      const closed = menu.hidden;
      b.remove();
      p.destroy();
      return { ok: opened && closed, detail: JSON.stringify({ opened, closed }) };
    },
  },

  /* ---- prose.divider ---- */
  {
    id: 'prose.divider.u01',
    feature: 'prose.divider',
    name: 'Divider with the caret mid-line goes below the line, not through it, and the caret lands after it',
    run: () => {
      const p = mountProse('hello world');
      p.select(5);
      insertDivider(p.view);
      const ok = p.doc() === 'hello world\n\n---\n' && p.view.state.selection.main.head === p.doc().length;
      const d = p.doc();
      p.destroy();
      return { ok, detail: JSON.stringify(d) };
    },
  },
  {
    id: 'prose.divider.u02',
    feature: 'prose.divider',
    name: 'Divider in an empty document writes one rule',
    run: () => same(edit('', 0, undefined, (p) => insertDivider(p.view)), '---\n'),
  },
  {
    id: 'prose.divider.u03',
    feature: 'prose.divider',
    name: 'Divider on the first of two paragraphs leaves one blank line on each side',
    run: () => same(edit('one\n\ntwo', 1, undefined, (p) => insertDivider(p.view)), 'one\n\n---\n\ntwo'),
  },
  {
    id: 'prose.divider.u04',
    feature: 'prose.divider',
    name: 'Insert > Divider with the caret in a code block puts the rule below the block, not into the code',
    run: () => {
      const out = withBar(CODE, IN_CODE, undefined, (b) => b.menuItem('insert', 'Divider').click());
      return { ok: out.startsWith(CODE) && count(out, 'HorizontalRule') === 1, detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.divider.u05',
    feature: 'prose.divider',
    name: 'Divider on the blank line right under text does not turn the text into a heading',
    run: () => {
      const out = edit('text\n', 5, undefined, (p) => insertDivider(p.view));
      return { ok: out === 'text\n\n---\n' && !has(out, 'SetextHeading2'), detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.divider.u06',
    feature: 'prose.divider',
    name: 'Divider then one undo gives the text back',
    run: () => same(edit('one', 3, undefined, (p) => (insertDivider(p.view), p.press('Mod-z'))), 'one'),
  },

  /* ---- prose.clear-formatting ---- */
  {
    id: 'prose.clear-formatting.u01',
    feature: 'prose.clear-formatting',
    name: 'Clear formatting with the caret inside a bold word unbolds it; with the caret in plain text it changes nothing',
    run: () => {
      const inside = withBar('a **bold** b', 5, undefined, (b) => b.click('clearFormatting'));
      const outside = withBar('a **bold** b', 11, undefined, (b) => b.click('clearFormatting'));
      return { ok: inside === 'a bold b' && outside === 'a **bold** b', detail: JSON.stringify([inside, outside]) };
    },
  },
  {
    id: 'prose.clear-formatting.u02',
    feature: 'prose.clear-formatting',
    name: 'Clear formatting on bold italic text written ***x*** and __y__ _z_ removes all markers',
    run: () => {
      const a = edit('***x***', 3, undefined, (p) => clearFormatting(p.view));
      const b = edit('__y__ _z_', 0, 9, (p) => clearFormatting(p.view));
      return { ok: a === 'x' && b === 'y z', detail: JSON.stringify([a, b]) };
    },
  },
  {
    id: 'prose.clear-formatting.u03',
    feature: 'prose.clear-formatting',
    name: 'Clear formatting on a selection covering part of a bold word unbolds the whole word',
    run: () => same(edit('**hello** world', 3, 5, (p) => clearFormatting(p.view)), 'hello world'),
  },
  {
    id: 'prose.clear-formatting.u04',
    feature: 'prose.clear-formatting',
    name: 'Clear formatting on a reference link keeps its text and leaves the definition',
    run: () => same(edit('[text][r]\n\n[r]: https://x.io', 2, undefined, (p) => clearFormatting(p.view)), 'text\n\n[r]: https://x.io'),
  },
  {
    id: 'prose.clear-formatting.u05',
    feature: 'prose.clear-formatting',
    name: 'Clear formatting keeps heading, list and quote markers',
    run: () => {
      const doc = '# **T**\n- *i*\n> `c`';
      return same(edit(doc, 0, doc.length, (p) => clearFormatting(p.view)), '# T\n- i\n> c');
    },
  },
  {
    id: 'prose.clear-formatting.u06',
    feature: 'prose.clear-formatting',
    name: 'Clear formatting over a code block leaves marker-like text in the code alone',
    run: () => {
      const doc = '```\n**x** _y_\n```';
      return same(edit(doc, 0, doc.length, (p) => clearFormatting(p.view)), doc);
    },
  },
  {
    id: 'prose.clear-formatting.u07',
    feature: 'prose.clear-formatting',
    name: 'Clear formatting with carets in two formatted words clears both, and one undo restores both',
    run: () => {
      const p = mountProse('**a** and ~~b~~');
      p.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(12)]) });
      clearFormatting(p.view);
      const cleared = p.doc();
      p.press('Mod-z');
      const back = p.doc();
      p.destroy();
      return { ok: cleared === 'a and b' && back === '**a** and ~~b~~', detail: JSON.stringify([cleared, back]) };
    },
  },

  /* ---- prose.link-insert ---- */
  {
    id: 'prose.link-insert.u01',
    feature: 'prose.link-insert',
    name: 'Mod-k on a selected word links it with url selected, and typing replaces url',
    run: () => {
      const p = mountProse('see docs now');
      p.select(4, 8);
      p.press('Mod-k');
      const s = p.view.state.selection.main;
      const selected = p.view.state.sliceDoc(s.from, s.to);
      typeText(p, 'https://x.io');
      const out = p.doc();
      p.destroy();
      return { ok: selected === 'url' && out === 'see [docs](https://x.io) now', detail: JSON.stringify({ selected, out }) };
    },
  },
  {
    id: 'prose.link-insert.u02',
    feature: 'prose.link-insert',
    name: 'The Link button with a bare caret writes [text](url) with url selected',
    run: () => {
      const p = mountProse('go ');
      p.select(3);
      const b = mountBar(p);
      b.click('link');
      const s = p.view.state.selection.main;
      const ok = p.doc() === 'go [text](url)' && p.view.state.sliceDoc(s.from, s.to) === 'url';
      const d = p.doc();
      b.remove();
      p.destroy();
      return { ok, detail: JSON.stringify(d) };
    },
  },
  {
    id: 'prose.link-insert.u03',
    feature: 'prose.link-insert',
    name: 'The Link button and Mod-k with the caret inside a link never put a second link inside it',
    run: () => {
      const doc = 'go [the site](https://x.io) now';
      const button = withBar(doc, 7, undefined, (b) => b.click('link'));
      const key = edit(doc, 7, undefined, (p) => p.press('Mod-k'));
      return { ok: count(button, 'Link') <= 1 && count(key, 'Link') <= 1 && !/\[[^\]]*\[/.test(button) && !/\[[^\]]*\[/.test(key), detail: JSON.stringify([button, key]) };
    },
  },
  {
    id: 'prose.link-insert.u04',
    feature: 'prose.link-insert',
    name: 'Link over a selection across two paragraphs never writes a link split by a blank line',
    run: () => {
      const out = edit('one\n\ntwo', 0, 8, (p) => insertLink(p.view));
      return { ok: !/\[[^\]]*\n\n[^\]]*\]\(/.test(out), detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.link-insert.u05',
    feature: 'prose.link-insert',
    name: 'Link on a selection containing brackets writes a link that still parses as one link',
    run: () => {
      const out = edit('a [b] c', 0, 7, (p) => insertLink(p.view));
      return { ok: out === '[a [b] c](url)' && count(out, 'Link') === 1, detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.link-insert.u06',
    feature: 'prose.link-insert',
    name: 'The Link button with a word selected in a code block leaves the code unchanged',
    run: () => same(withBar(CODE, 8, 9, (b) => b.click('link')), CODE),
  },
  {
    id: 'prose.link-insert.u07',
    feature: 'prose.link-insert',
    name: 'Link then one undo gives the word back',
    run: () => same(edit('see docs', 4, 8, (p) => (p.press('Mod-k'), p.press('Mod-z'))), 'see docs'),
  },

  /* ---- prose.hard-break ---- */
  {
    id: 'prose.hard-break.u01',
    feature: 'prose.hard-break',
    name: 'Shift-Enter in a numbered item and a task item indents the new line to the item text',
    run: () => {
      const a = edit('1. item', 7, undefined, (p) => p.press('Shift-Enter'));
      const b = edit('- [ ] task', 10, undefined, (p) => p.press('Shift-Enter'));
      return { ok: a === '1. item\\\n   ' && b === '- [ ] task\\\n      ', detail: JSON.stringify([a, b]) };
    },
  },
  {
    id: 'prose.hard-break.u02',
    feature: 'prose.hard-break',
    name: 'Shift-Enter in a nested bullet and in a nested quote keeps the new line in that item or quote',
    run: () => {
      const a = edit('- p\n    - c', 11, undefined, (p) => p.press('Shift-Enter'));
      const b = edit('> > q', 5, undefined, (p) => p.press('Shift-Enter'));
      return { ok: a === '- p\n    - c\\\n      ' && b === '> > q\\\n> > ', detail: JSON.stringify([a, b]) };
    },
  },
  {
    id: 'prose.hard-break.u03',
    feature: 'prose.hard-break',
    name: 'Shift-Enter mid-paragraph breaks the line there and puts the caret at the start of the new line',
    run: () => {
      const p = mountProse('one two');
      p.select(3);
      p.press('Shift-Enter');
      const ok = p.doc() === 'one\\\n two' && p.view.state.selection.main.head === 5;
      const d = p.doc();
      p.destroy();
      return { ok, detail: JSON.stringify(d) };
    },
  },
  {
    id: 'prose.hard-break.u04',
    feature: 'prose.hard-break',
    name: 'Shift-Enter at the end of a heading leaves no backslash showing in the heading',
    run: () => {
      const out = edit('# Title', 7, undefined, (p) => p.press('Shift-Enter'));
      const heading = nodesOf(out).find((n) => n.name === 'ATXHeading1');
      return { ok: !!heading && !heading.text.endsWith('\\'), detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.hard-break.u05',
    feature: 'prose.hard-break',
    name: 'Shift-Enter with a word selected replaces the word, and with two carets breaks both lines',
    run: () => {
      const a = edit('one two three', 4, 7, (p) => p.press('Shift-Enter'));
      const b = editRanges('ab\ncd', [[1, 1], [4, 4]], (p) => p.press('Shift-Enter'));
      return { ok: a === 'one \\\n three' && b === 'a\\\nb\nc\\\nd', detail: JSON.stringify([a, b]) };
    },
  },
  {
    id: 'prose.hard-break.u06',
    feature: 'prose.hard-break',
    name: 'Shift-Enter then one undo gives the line back',
    run: () => same(edit('- item', 6, undefined, (p) => (p.press('Shift-Enter'), p.press('Mod-z'))), '- item'),
  },

  /* ---- prose.indent ---- */
  {
    id: 'prose.indent.u01',
    feature: 'prose.indent',
    name: 'Tab on the second bullet nests it under the first, and Shift-Tab brings it back',
    run: () => {
      const p = mountProse('- a\n- b');
      p.select(6);
      const handled = p.press('Tab');
      const nested = p.doc();
      p.press('Shift-Tab');
      const back = p.doc();
      p.destroy();
      return { ok: handled && nested === '- a\n    - b' && back === '- a\n- b', detail: JSON.stringify([nested, back]) };
    },
  },
  {
    id: 'prose.indent.u02',
    feature: 'prose.indent',
    name: 'Tab with three items selected nests each by one level',
    run: () => same(edit('- a\n- b\n- c', 4, 11, (p) => p.press('Tab')), '- a\n    - b\n    - c'),
  },
  {
    id: 'prose.indent.u03',
    feature: 'prose.indent',
    name: 'Tab on a paragraph does not turn it into a code block',
    run: () => {
      const out = edit('intro\n\nhello there', 10, undefined, (p) => p.press('Tab'));
      return { ok: !has(out, 'CodeBlock'), detail: JSON.stringify(out) };
    },
  },
  {
    id: 'prose.indent.u04',
    feature: 'prose.indent',
    name: 'Tab on the first item of a list, or on a heading, does not turn it into a code block',
    run: () => {
      const item = edit('- a\n- b', 2, undefined, (p) => p.press('Tab'));
      const heading = edit('# Title', 3, undefined, (p) => p.press('Tab'));
      return { ok: !has(item, 'CodeBlock') && !has(heading, 'CodeBlock'), detail: JSON.stringify([item, heading]) };
    },
  },
  {
    id: 'prose.indent.u05',
    feature: 'prose.indent',
    name: 'Tab inside a fenced code block indents that code line by four spaces',
    run: () => same(edit(CODE, IN_CODE, undefined, (p) => p.press('Tab')), '```\n    let x = 1\n```'),
  },
  {
    id: 'prose.indent.u06',
    feature: 'prose.indent',
    name: 'Shift-Tab on a line with no indent changes nothing and still keeps the key in the editor',
    run: () => {
      const p = mountProse('- a');
      p.select(2);
      const handled = p.press('Shift-Tab');
      const out = p.doc();
      p.destroy();
      return { ok: handled && out === '- a', detail: JSON.stringify({ handled, out }) };
    },
  },
  {
    id: 'prose.indent.u07',
    feature: 'prose.indent',
    name: 'Tab on a task item and on a numbered item nests them, and one undo takes it back',
    run: () => {
      const task = edit('- [ ] a\n- [ ] b', 12, undefined, (p) => p.press('Tab'));
      const num = edit('1. a\n2. b', 7, undefined, (p) => p.press('Tab'));
      const back = edit('1. a\n2. b', 7, undefined, (p) => (p.press('Tab'), p.press('Mod-z')));
      return { ok: task === '- [ ] a\n    - [ ] b' && num === '1. a\n    2. b' && back === '1. a\n2. b', detail: JSON.stringify([task, num, back]) };
    },
  },

  /* ---- prose.list-continuation ---- */
  {
    id: 'prose.list-continuation.u01',
    feature: 'prose.list-continuation',
    name: 'Enter at the end of a bullet, numbered and task item starts the next item of the same kind',
    run: () => {
      const outs = ['- a', '1. a', '- [x] a'].map((d) => edit(d, d.length, undefined, (p) => p.press('Enter')));
      return { ok: outs.join('|') === '- a\n- |1. a\n2. |- [x] a\n- [ ] ', detail: JSON.stringify(outs) };
    },
  },
  {
    id: 'prose.list-continuation.u02',
    feature: 'prose.list-continuation',
    name: 'Enter on an empty bullet item ends the list',
    run: () => {
      const p = mountProse('- a\n- ');
      p.select(6);
      p.press('Enter');
      const out = p.doc();
      const line = p.view.state.doc.lineAt(p.view.state.selection.main.head).text;
      p.destroy();
      return { ok: !/(^|\n)- ?$/.test(out.replace(/\n+$/, '')) && out.startsWith('- a\n') && !/^\s*[-*+]/.test(line), detail: JSON.stringify({ out, line }) };
    },
  },
  {
    id: 'prose.list-continuation.u03',
    feature: 'prose.list-continuation',
    name: 'Enter on an empty third bullet ends the list on the first press, with the caret clear of it',
    run: () => {
      // The blank line is what makes the list end. Markdown reads a line straight after
      // a list item as more of that item, so without it the next thing typed would be
      // glued onto `b` rather than start a paragraph of its own.
      const p = mountProse('- a\n- b\n- ');
      p.select(10);
      p.press('Enter');
      const out = p.doc();
      const line = p.view.state.doc.lineAt(p.view.state.selection.main.head).text;
      p.destroy();
      return { ok: out === '- a\n- b\n\n' && line === '', detail: JSON.stringify({ out, line }) };
    },
  },
  {
    id: 'prose.list-continuation.u09',
    feature: 'prose.list-continuation',
    name: 'Enter after the first of two numbered items inserts item 2 and renumbers the next one to 3',
    run: () => same(edit('1. a\n2. b', 4, undefined, (p) => p.press('Enter')), '1. a\n2. \n3. b'),
  },
  {
    id: 'prose.list-continuation.u04',
    feature: 'prose.list-continuation',
    name: 'Enter in a quote continues the quote, and Enter on an empty quote line ends it',
    run: () => {
      const cont = edit('> a', 3, undefined, (p) => p.press('Enter'));
      const p = mountProse('> a\n> ');
      p.select(6);
      p.press('Enter');
      const end = p.doc();
      const line = p.view.state.doc.lineAt(p.view.state.selection.main.head).text;
      p.destroy();
      return { ok: cont === '> a\n> ' && !line.startsWith('>'), detail: JSON.stringify({ cont, end, line }) };
    },
  },
  {
    id: 'prose.list-continuation.u05',
    feature: 'prose.list-continuation',
    name: 'Enter at the end of a nested item continues at the nested level, and mid-item splits the item',
    run: () => {
      const nested = edit('- a\n    - b', 11, undefined, (p) => p.press('Enter'));
      const split = edit('- ab', 3, undefined, (p) => p.press('Enter'));
      return { ok: nested === '- a\n    - b\n    - ' && split === '- a\n- b', detail: JSON.stringify([nested, split]) };
    },
  },
  {
    id: 'prose.list-continuation.u06',
    feature: 'prose.list-continuation',
    name: 'Backspace right after a new item marker removes the marker, and Enter in a paragraph adds no marker',
    run: () => {
      const bs = edit('- a\n- ', 6, undefined, (p) => p.press('Backspace'));
      const para = edit('abc', 3, undefined, (p) => p.press('Enter'));
      return { ok: !/\n- $/.test(bs) && bs.startsWith('- a') && para === 'abc\n', detail: JSON.stringify([bs, para]) };
    },
  },
  {
    id: 'prose.list-continuation.u07',
    feature: 'prose.list-continuation',
    name: 'Enter in a code block inside a list is a plain new line with the code indentation, no list marker',
    run: () => {
      const doc = '- item\n\n  ```\n  x\n  ```';
      const out = edit(doc, doc.indexOf('  x') + 3, undefined, (p) => p.press('Enter'));
      return { ok: !out.includes('- \n') && !/\n\s*- $/m.test(out.split('\n')[4] ?? '') && count(out, 'FencedCode') === 1, detail: JSON.stringify(out) };
    },
  },

  /* ---- prose.undo-redo ---- */
  {
    id: 'prose.undo-redo.u01',
    feature: 'prose.undo-redo',
    name: 'Undoing every change disables Undo again and leaves the document as it started',
    run: () => {
      const p = mountProse('word');
      const b = mountBar(p);
      p.select(0, 4);
      b.click('bold');
      b.refresh();
      p.select(0);
      b.click('bullet');
      b.refresh();
      const enabled = !b.button('undo').disabled;
      b.click('undo');
      b.refresh();
      b.click('undo');
      b.refresh();
      const ok = enabled && b.button('undo').disabled && !b.button('redo').disabled && p.doc() === 'word';
      const d = p.doc();
      b.remove();
      p.destroy();
      return { ok, detail: JSON.stringify(d) };
    },
  },
  {
    id: 'prose.undo-redo.u02',
    feature: 'prose.undo-redo',
    name: 'Two undos then two redos (Mod-y, this platform) replay both changes in order',
    run: () => {
      const out = edit('word', 0, 4, (p) => {
        p.press('Mod-b');
        p.select(0);
        p.press('Mod-Shift-8');
        p.press('Mod-z');
        p.press('Mod-z');
        const mid = p.doc();
        p.press('Mod-y');
        if (p.doc() !== '**word**' || mid !== 'word') throw new Error(`mid ${JSON.stringify(mid)}, after one redo ${JSON.stringify(p.doc())}`);
        p.press('Mod-y');
      });
      return same(out, '- **word**');
    },
  },
  {
    id: 'prose.undo-redo.u03',
    feature: 'prose.undo-redo',
    name: 'A new edit after undo empties redo, and the Redo button shows disabled',
    run: () => {
      const p = mountProse('ab');
      const b = mountBar(p);
      p.select(2);
      typeText(p, 'c');
      p.press('Mod-z');
      b.refresh();
      const could = !b.button('redo').disabled;
      typeText(p, 'd');
      b.refresh();
      const disabled = b.button('redo').disabled;
      p.press('Mod-y');
      const d = p.doc();
      b.remove();
      p.destroy();
      return { ok: could && disabled && d === 'abd', detail: JSON.stringify({ could, disabled, d }) };
    },
  },
  {
    id: 'prose.undo-redo.u06',
    feature: 'prose.undo-redo',
    name: 'The key named in the Redo tooltip redoes on this platform (non-Mac keymap)',
    run: () => {
      const p = mountProse('ab');
      const b = mountBar(p);
      const title = b.button('redo').title;
      p.select(2);
      typeText(p, 'c');
      p.press('Mod-z');
      // The tooltip names Ctrl+Shift+Z outside macOS; press exactly that.
      const spec = /Ctrl\+Shift\+Z/.test(title) ? 'Mod-Shift-z' : /Ctrl\+Y/.test(title) ? 'Mod-y' : '';
      if (spec) p.press(spec);
      const d = p.doc();
      b.remove();
      p.destroy();
      return { ok: d === 'abc', detail: `tooltip ${JSON.stringify(title)}, after pressing it the text is ${JSON.stringify(d)}` };
    },
  },
  {
    id: 'prose.undo-redo.u04',
    feature: 'prose.undo-redo',
    name: 'Undo of a Bold puts the selection back on the word',
    run: () => {
      const p = mountProse('say hello now');
      p.select(4, 9);
      p.press('Mod-b');
      p.press('Mod-z');
      const s = p.view.state.selection.main;
      p.destroy();
      return { ok: s.from === 4 && s.to === 9, detail: JSON.stringify({ from: s.from, to: s.to }) };
    },
  },
  {
    id: 'prose.undo-redo.u05',
    feature: 'prose.undo-redo',
    name: 'Undo button click after typing removes the typed text',
    run: () => {
      const p = mountProse('ab');
      const b = mountBar(p);
      p.select(2);
      typeText(p, 'xyz');
      b.refresh();
      b.click('undo');
      const d = p.doc();
      b.remove();
      p.destroy();
      return same(d, 'ab');
    },
  },

  /* ---- prose.toolbar-state ---- */
  {
    id: 'prose.toolbar-state.u01',
    feature: 'prose.toolbar-state',
    name: 'Bold shows on just inside the opening ** and off just after the closing **',
    run: () => {
      const doc = 'a **bold** b';
      const p = mountProse(doc);
      const b = mountBar(p);
      p.select(4);
      b.refresh();
      const inside = pressedOn(b, 'bold');
      p.select(10);
      b.refresh();
      const after = pressedOn(b, 'bold');
      b.remove();
      p.destroy();
      return { ok: inside && !after, detail: JSON.stringify({ inside, after }) };
    },
  },
  {
    id: 'prose.toolbar-state.u02',
    feature: 'prose.toolbar-state',
    name: 'Italic, Strikethrough and Inline code show on inside their marks',
    run: () => {
      const doc = '*i* ~~s~~ `c`';
      const p = mountProse(doc);
      const b = mountBar(p);
      const res = ([['italic', 1], ['strike', 6], ['code', 11]] as [string, number][]).map(([cmd, pos]) => {
        p.select(pos);
        b.refresh();
        return pressedOn(b, cmd);
      });
      b.remove();
      p.destroy();
      return { ok: res.every(Boolean), detail: JSON.stringify(res) };
    },
  },
  {
    id: 'prose.toolbar-state.u03',
    feature: 'prose.toolbar-state',
    name: 'After clicking Bold on a selected word, Bold shows on',
    run: () => {
      const p = mountProse('say hello now');
      const b = mountBar(p);
      p.select(4, 9);
      b.click('bold');
      b.refresh();
      const on = pressedOn(b, 'bold');
      b.remove();
      p.destroy();
      return on;
    },
  },
  {
    id: 'prose.toolbar-state.u04',
    feature: 'prose.toolbar-state',
    name: 'Text style reads H4 on a Heading 4 and checks Heading 4 in the menu',
    run: () => {
      const p = mountProse('#### four');
      const b = mountBar(p);
      p.select(6);
      b.refresh();
      const label = b.button('heading').textContent ?? '';
      const checked = Array.from(b.button('heading').parentElement!.querySelectorAll('.is-checked')).map((el) => el.querySelector('span')?.textContent);
      b.remove();
      p.destroy();
      return { ok: label.includes('H4') && checked.join('|') === 'Heading 4', detail: JSON.stringify({ label, checked }) };
    },
  },
  {
    id: 'prose.toolbar-state.u05',
    feature: 'prose.toolbar-state',
    name: 'Text style reads H1 on a setext heading written with an === underline',
    run: () => {
      const p = mountProse('Title\n=====\n');
      const b = mountBar(p);
      p.select(2);
      b.refresh();
      const label = b.button('heading').textContent ?? '';
      b.remove();
      p.destroy();
      return { ok: label.includes('H1'), detail: JSON.stringify(label) };
    },
  },
  {
    id: 'prose.toolbar-state.u06',
    feature: 'prose.toolbar-state',
    name: 'Text style reads H2 on a heading inside a quote, and Quote shows on',
    run: () => {
      const p = mountProse('> ## Inside');
      const b = mountBar(p);
      p.select(7);
      b.refresh();
      const label = b.button('heading').textContent ?? '';
      const quote = pressedOn(b, 'quote');
      b.remove();
      p.destroy();
      return { ok: label.includes('H2') && quote, detail: JSON.stringify({ label, quote }) };
    },
  },
  {
    id: 'prose.toolbar-state.u07',
    feature: 'prose.toolbar-state',
    name: 'Bullet list and Quote both show on for a bullet inside a quote, and Numbered shows on for 1)',
    run: () => {
      const p = mountProse('> - item\n\n1) one');
      const b = mountBar(p);
      p.select(6);
      b.refresh();
      const both = pressedOn(b, 'bullet') && pressedOn(b, 'quote');
      p.select(14);
      b.refresh();
      const paren = pressedOn(b, 'ordered');
      b.remove();
      p.destroy();
      return { ok: both && paren, detail: JSON.stringify({ both, paren }) };
    },
  },
  {
    id: 'prose.toolbar-state.u08',
    feature: 'prose.toolbar-state',
    name: 'Inside a code block, Bold stays off over text that looks like **bold**',
    run: () => {
      const p = mountProse('```\n**x**\n```');
      const b = mountBar(p);
      p.select(7);
      b.refresh();
      const ok = !pressedOn(b, 'bold') && pressedOn(b, 'codeBlock');
      b.remove();
      p.destroy();
      return ok;
    },
  },

  /* ---- prose.shortcuts-overlay ---- */
  {
    id: 'prose.shortcuts-overlay.u01',
    feature: 'prose.shortcuts-overlay',
    name: 'The overlay opens on toggle, stays open on a click inside the panel, and closes on Escape, the backdrop and the close button',
    run: () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const o = createShortcutsOverlay(host);
      const backdrop = host.querySelector<HTMLElement>('.sheaf-sc-backdrop')!;
      const panel = host.querySelector<HTMLElement>('.sheaf-sc-panel')!;
      o.toggle();
      const opened = o.isOpen();
      panel.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true }));
      const stays = o.isOpen();
      document.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const esc = !o.isOpen();
      o.toggle();
      backdrop.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true }));
      const back = !o.isOpen();
      o.toggle();
      host.querySelector<HTMLButtonElement>('.sheaf-sc-close')!.click();
      const x = !o.isOpen();
      host.remove();
      return { ok: opened && stays && esc && back && x, detail: JSON.stringify({ opened, stays, esc, back, x }) };
    },
  },
  {
    id: 'prose.shortcuts-overlay.u02',
    feature: 'prose.shortcuts-overlay',
    name: 'Mod-/ in the editor opens the overlay and the toolbar keyboard button does too',
    run: () => {
      let n = 0;
      const p = mountProse('x', [Prec.highest(keymap.of(buildEditingKeymap(() => void n++)))]);
      const handled = p.press('Mod-/');
      const b = mountBar(p, () => false, false, () => void n++);
      b.el.querySelector<HTMLButtonElement>('.sheaf-tb-help')!.click();
      b.remove();
      p.destroy();
      return { ok: handled && n === 2, detail: JSON.stringify({ handled, n }) };
    },
  },
  {
    id: 'prose.shortcuts-overlay.u03',
    feature: 'prose.shortcuts-overlay',
    name: 'Every shortcut shown in a toolbar tooltip is listed in the overlay',
    run: () => {
      const p = mountProse('x');
      const b = mountBar(p);
      const titles = Array.from(b.el.querySelectorAll<HTMLElement>('[title]')).map((e) => e.title);
      const hints = Array.from(b.el.querySelectorAll('.sheaf-tb-menu-key')).map((e) => e.textContent ?? '');
      const fromTitles = titles.map((t) => /\(([^)]+)\)$/.exec(t)?.[1]).filter((h): h is string => !!h);
      const host = document.createElement('div');
      document.body.appendChild(host);
      createShortcutsOverlay(host);
      const listed = Array.from(host.querySelectorAll('.sheaf-sc-keys')).map((e) => e.textContent);
      const missing = [...fromTitles, ...hints.filter(Boolean)].filter((h) => !listed.includes(h));
      host.remove();
      b.remove();
      p.destroy();
      return { ok: missing.length === 0, detail: `missing from overlay: ${JSON.stringify(missing)}` };
    },
  },
  {
    id: 'prose.shortcuts-overlay.u04',
    feature: 'prose.shortcuts-overlay',
    name: 'Every Formatting and Blocks row in the overlay does what its label says when its keys are pressed',
    run: () => {
      const rows: [string, string, string, number, number | undefined, string][] = [
        ['Bold', 'Mod-b', 'ab', 0, 2, '**ab**'],
        ['Italic', 'Mod-i', 'ab', 0, 2, '*ab*'],
        ['Strikethrough', 'Mod-Shift-x', 'ab', 0, 2, '~~ab~~'],
        ['Highlight', 'Mod-Shift-h', 'ab', 0, 2, '==ab=='],
        ['Inline code', 'Mod-e', 'ab', 0, 2, '`ab`'],
        ['Insert link', 'Mod-k', 'ab', 0, 2, '[ab](url)'],
        ['Heading 1', 'Mod-Alt-1', 'ab', 1, undefined, '# ab'],
        ['Heading 2', 'Mod-Alt-2', 'ab', 1, undefined, '## ab'],
        ['Heading 3', 'Mod-Alt-3', 'ab', 1, undefined, '### ab'],
        // Renamed from "Paragraph (clear heading)", to match the Text style menu.
        ['Text', 'Mod-Alt-0', '## ab', 4, undefined, 'ab'],
        ['Bullet list', 'Mod-Shift-8', 'ab', 1, undefined, '- ab'],
        ['Numbered list', 'Mod-Shift-7', 'ab', 1, undefined, '1. ab'],
        ['Blockquote', 'Mod-Shift-9', 'ab', 1, undefined, '> ab'],
        ['Task list', 'Mod-Alt-4', 'ab', 1, undefined, '- [ ] ab'],
        ['Code block', 'Mod-Alt-8', 'ab', 1, undefined, '```\nab\n```'],
      ];
      const host = document.createElement('div');
      document.body.appendChild(host);
      createShortcutsOverlay(host);
      const labels = Array.from(host.querySelectorAll('.sheaf-sc-label')).map((e) => e.textContent);
      host.remove();
      const bad = rows.filter(([label, key, doc, a, h, want]) => !labels.includes(label) || edit(doc, a, h, (p) => p.press(key)) !== want).map((r) => r[0]);
      return { ok: bad.length === 0, detail: `rows that do not match: ${JSON.stringify(bad)}` };
    },
  },
  {
    id: 'prose.shortcuts-overlay.u05',
    feature: 'prose.shortcuts-overlay',
    name: 'Escape with the overlay open closes it without selecting the block behind it',
    run: () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const o = createShortcutsOverlay(host);
      const p = mountProse('para one');
      p.select(3);
      o.toggle();
      const handledByEditor = p.press('Escape');
      document.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const s = p.view.state.selection.main;
      const ok = !handledByEditor && !o.isOpen() && s.empty && s.head === 3;
      p.destroy();
      host.remove();
      return { ok, detail: JSON.stringify({ handledByEditor, open: o.isOpen(), from: s.from, to: s.to }) };
    },
  },

  /* ---- prose.line-numbers ---- */
  {
    id: 'prose.line-numbers.u01',
    feature: 'prose.line-numbers',
    name: 'The line numbers button shows pressed when on and not pressed when off',
    run: () => {
      let on = false;
      const p = mountProse('x');
      const b = mountBar(p, () => (on = !on), false);
      const btn = b.el.querySelector<HTMLButtonElement>('[title="Toggle line numbers"]')!;
      const start = btn.getAttribute('aria-pressed');
      btn.click();
      const afterOn = btn.getAttribute('aria-pressed') === 'true' && btn.classList.contains('is-active');
      btn.click();
      const afterOff = btn.getAttribute('aria-pressed') === 'false' && !btn.classList.contains('is-active');
      b.remove();
      p.destroy();
      return { ok: start === 'false' && afterOn && afterOff, detail: JSON.stringify({ start, afterOn, afterOff }) };
    },
  },
  {
    id: 'prose.line-numbers.u02',
    feature: 'prose.line-numbers',
    name: 'With a table and a code block above, the gutter number beside a paragraph is its line in the file',
    run: () => {
      const doc = 'top\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode\n```\n\ntarget';
      const p = mountProse(doc, [lineNumbers()]);
      p.view.requestMeasure();
      const nums = Array.from(p.view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).map((e) => e.textContent).filter(Boolean);
      p.destroy();
      const want = String(doc.split('\n').indexOf('target') + 1);
      return { ok: nums.includes(want) && nums.at(-1) === want, detail: `gutter ${JSON.stringify(nums)}, target is line ${want}` };
    },
  },
];

/** True when the text is bold and italic over the same word, in any CommonMark spelling. */
function formatItalicBold(text: string): boolean {
  return ['***hello***', '***hello***', '**_hello_**', '_**hello**_', '*__hello__*'].includes(text);
}

// Referenced so tree-shaking keeps imports used only in some scenarios.
void [toggleHeading, toggleBullet, toggleOrdered, toggleQuote, insertCodeBlock, insertHardBreak, turnInto, at];
