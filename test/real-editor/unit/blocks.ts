// Unit scenarios for block editing: the grip menu, dragging, the + button, block
// selection from the keyboard and Alt+arrow moves. Each asserts what should be
// true; a failing scenario is a bug candidate, named in features/blocks.md.
//
// These go past test/prose/blocks.ts: nested items with children, front matter
// next to the moved block, tight blocks with no blank line, ordered numbers, CRLF,
// undo after each operation, and the only block in a document.
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { mountProse } from '../../harness';
import {
  blockRangeAt,
  blockSelectionOf,
  blockDropTargets,
  moveBlockTo,
  nearestDropIndex,
  blockMenuItems,
  BlockMenuItem,
  insertParagraphBelow,
  slashMenuOf,
  setBlockRefHost,
  selectBlockAt,
} from '../../../src/webview/blocks';
import { navigateBlocks } from '../../../src/webview/blockModel';
import { planEdit } from '../../../src/textSync';

type Result = boolean | { ok: boolean; detail?: string };
interface Scenario {
  id: string;
  feature: string;
  name: string;
  run: () => Result | Promise<Result>;
}
type Prose = ReturnType<typeof mountProse>;

const show = (s: unknown): string => JSON.stringify(s);
const same = (got: string, want: string): Result => ({ ok: got === want, detail: got === want ? '' : `got ${show(got)}, want ${show(want)}` });
const all = (checks: Record<string, boolean>, detail: unknown): Result => {
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { ok: failed.length === 0, detail: failed.length ? `failed: ${failed.join(', ')}; ${show(detail)}` : '' };
};

const TABLE = '| a \\| x | b |\n| :-- | --: |\n| 1   |   2 |';

/** Type text at the caret one character at a time, as keyboard input arrives. */
function type(p: Prose, text: string): void {
  for (const ch of text) {
    const head = p.view.state.selection.main.head;
    p.view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: 'input.type' });
  }
}

/** Mount `doc`, put the caret at `at`, run `fn`, return the document; the editor is destroyed after. */
function after(doc: string, at: number, fn: (p: Prose) => void): string {
  const p = mountProse(doc);
  p.select(at);
  fn(p);
  const out = p.doc();
  p.destroy();
  return out;
}

const lineFrom = (doc: string, n: number): number => EditorState.create({ doc }).doc.line(n).from;

function item(items: BlockMenuItem[], label: string): BlockMenuItem {
  const found = items.find((i) => i.label === label);
  if (!found) throw new Error(`no menu item ${label} in ${items.map((i) => i.label).join('|')}`);
  return found;
}

/** Run the grip menu item `path` (e.g. ['Turn into', 'Heading 2']) for the block at `pos`. */
function menu(view: EditorView, pos: number, path: string[]): void {
  let items = blockMenuItems(view, blockRangeAt(view.state, pos)!);
  for (let k = 0; k < path.length - 1; k++) items = item(items, path[k]).children!;
  item(items, path[path.length - 1]).run!();
}

/** Undo until the history is empty, counting the steps; the document it ends on. */
function undoAll(p: Prose): { steps: number; doc: string } {
  let steps = 0;
  while (undo(p.view) && steps < 20) steps++;
  return { steps, doc: p.doc() };
}

/** Lines that start a new top-level or list-item block, for "did anything merge" checks. */
function blockStarts(doc: string): number[] {
  const p = mountProse(doc);
  const starts = new Set<number>();
  for (let n = 1; n <= p.view.state.doc.lines; n++) {
    const r = blockRangeAt(p.view.state, p.view.state.doc.line(n).from);
    if (r) starts.add(r.startLine);
  }
  p.destroy();
  return [...starts];
}

export const scenarios: Scenario[] = [
  // ---- blocks.handle-menu ------------------------------------------------------
  {
    id: 'blocks.handle-menu.u01',
    feature: 'blocks.handle-menu',
    name: 'Turn into > Text on a heading removes the # and keeps the words',
    run: () => same(after('# Title\n\npara', 0, (p) => menu(p.view, 0, ['Turn into', 'Text'])), 'Title\n\npara'),
  },
  {
    id: 'blocks.handle-menu.u02',
    feature: 'blocks.handle-menu',
    name: "A table's menu offers Edit Markdown and the block moves, with no Turn into",
    run: () => {
      // Turn into stays out: a table is not a kind of block anything else converts to
      // or from. Edit Markdown is in, because showing a block's source is the move
      // Sheaf is built around and it means something for a table as much as for prose.
      const doc = `intro\n\n${TABLE}`;
      const p = mountProse(doc);
      const items = blockMenuItems(p.view, blockRangeAt(p.view.state, doc.indexOf('| 1'))!);
      p.destroy();
      const labels = items.map((i) => i.label).join('|');
      return all(
        {
          labels: labels === 'Edit Markdown|Duplicate|Move up|Move down|Delete',
          upEnabled: !item(items, 'Move up').disabled,
          downDisabled: !!item(items, 'Move down').disabled,
        },
        labels
      );
    },
  },
  {
    id: 'blocks.handle-menu.u03',
    feature: 'blocks.handle-menu',
    name: 'Move up is disabled on the first block under front matter, and Move down on the last block',
    run: () => {
      const doc = '---\nt: 1\n---\n\npara\n\n# H';
      const p = mountProse(doc);
      const first = blockMenuItems(p.view, blockRangeAt(p.view.state, doc.indexOf('para'))!);
      const last = blockMenuItems(p.view, blockRangeAt(p.view.state, doc.indexOf('# H'))!);
      p.destroy();
      return all({ firstUp: !!item(first, 'Move up').disabled, firstDown: !item(first, 'Move down').disabled, lastDown: !!item(last, 'Move down').disabled, lastUp: !item(last, 'Move up').disabled }, null);
    },
  },
  {
    id: 'blocks.handle-menu.u04',
    feature: 'blocks.handle-menu',
    name: 'Duplicate on a list item copies its nested items too, and one undo restores the bytes',
    run: () => {
      const doc = '- a\n  - b\n- c';
      const p = mountProse(doc);
      menu(p.view, 0, ['Duplicate']);
      const dup = p.doc();
      const u = undoAll(p);
      p.destroy();
      return all({ dup: dup === '- a\n  - b\n- a\n  - b\n- c', oneStep: u.steps === 1, restored: u.doc === doc }, { dup, u });
    },
  },
  {
    id: 'blocks.handle-menu.u05',
    feature: 'blocks.handle-menu',
    name: 'Delete on the only block leaves an empty document, and one undo brings it back',
    run: () => {
      const doc = 'only\n';
      const p = mountProse(doc);
      menu(p.view, 1, ['Delete']);
      const del = p.doc();
      const u = undoAll(p);
      p.destroy();
      return all({ empty: del === '', oneStep: u.steps === 1, restored: u.doc === doc }, { del, u });
    },
  },
  {
    id: 'blocks.handle-menu.u06',
    feature: 'blocks.handle-menu',
    name: 'Delete on a list item removes its nested items with it',
    run: () => same(after('- a\n  - b\n  - c\n- d', 0, (p) => menu(p.view, 0, ['Delete'])), '- d'),
  },
  {
    id: 'blocks.handle-menu.u07',
    feature: 'blocks.handle-menu',
    name: 'Delete on the first block under front matter keeps the front matter and one blank line',
    run: () => {
      const doc = '---\nt: 1\n---\n\npara\n\n# H';
      return same(after(doc, 0, (p) => menu(p.view, doc.indexOf('para'), ['Delete'])), '---\nt: 1\n---\n\n# H');
    },
  },
  {
    id: 'blocks.handle-menu.u08',
    feature: 'blocks.handle-menu',
    name: 'Turn into > Numbered list on a bullet item keeps its nested item nested under it',
    run: () => {
      const out = after('- a\n  - b\n- c', 0, (p) => menu(p.view, 0, ['Turn into', 'Numbered list']));
      const p = mountProse(out);
      const r = blockRangeAt(p.view.state, 0);
      p.destroy();
      return { ok: /^1\. a\n/.test(out) && !!r && r.endLine >= 2, detail: `file ${show(out)}, item a now spans lines ${r?.startLine}-${r?.endLine}` };
    },
  },
  {
    id: 'blocks.handle-menu.u09',
    feature: 'blocks.handle-menu',
    name: 'Turn into > Quote on a two-line paragraph, then one undo, gives back the original bytes',
    run: () => {
      const doc = 'para one\nline two\n\n# B';
      const p = mountProse(doc);
      menu(p.view, 0, ['Turn into', 'Quote']);
      const q = p.doc();
      const u = undoAll(p);
      p.destroy();
      return all({ quoted: q === '> para one\n> line two\n\n# B', oneStep: u.steps === 1, restored: u.doc === doc }, { q, u });
    },
  },
  {
    id: 'blocks.handle-menu.u10',
    feature: 'blocks.handle-menu',
    name: 'Turn into > Heading 1 on a setext heading gives a single # line',
    run: () => same(after('Title\n---\n\npara', 0, (p) => menu(p.view, 0, ['Turn into', 'Heading 1'])), '# Title\n\npara'),
  },
  {
    id: 'blocks.handle-menu.u11',
    feature: 'blocks.handle-menu',
    name: 'Turn into > Text on a fenced code block keeps the code and removes the fences',
    run: () => same(after('```js\nlet a = 1;\n```', 0, (p) => menu(p.view, 0, ['Turn into', 'Text'])), 'let a = 1;'),
  },
  {
    id: 'blocks.handle-menu.u12',
    feature: 'blocks.handle-menu',
    name: 'Copy ref on a list item with children names its first to last line and quotes both lines',
    run: () => {
      let copied = '';
      const doc = '# T\n\n- a\n  - b\n- c';
      const p = mountProse(doc);
      setBlockRefHost({ getFileName: () => 'notes/x.md', copyToClipboard: (t) => (copied = t) });
      try {
        menu(p.view, doc.indexOf('- a'), ['Copy ref']);
      } finally {
        setBlockRefHost(null);
        p.destroy();
      }
      return same(copied, 'notes/x.md:3-4\n\n```\n- a\n  - b\n```\n');
    },
  },
  {
    id: 'blocks.handle-menu.u13',
    feature: 'blocks.handle-menu',
    name: 'Turn into marks Numbered list as current on a numbered item and Quote on a quote',
    run: () => {
      const current = (doc: string): string => {
        const p = mountProse(doc);
        const into = item(blockMenuItems(p.view, blockRangeAt(p.view.state, 0)!), 'Turn into').children!;
        p.destroy();
        return into.filter((i) => i.current).map((i) => i.label).join('|');
      };
      const a = current('1. x');
      const b = current('> q\n> r');
      return { ok: a === 'Numbered list' && b === 'Quote', detail: `${a} / ${b}` };
    },
  },
  {
    id: 'blocks.handle-menu.u14',
    feature: 'blocks.handle-menu',
    name: 'Front matter gets no menu, and Duplicate on the block under it never copies the front matter',
    run: () => {
      const doc = '---\nt: 1\n---\n\npara';
      const p = mountProse(doc);
      const fm = blockMenuItems(p.view, blockRangeAt(p.view.state, 1)!);
      menu(p.view, doc.indexOf('para'), ['Duplicate']);
      const out = p.doc();
      p.destroy();
      return all({ noMenu: fm.length === 0, dup: out === '---\nt: 1\n---\n\npara\n\npara' }, out);
    },
  },

  // ---- blocks.drag -------------------------------------------------------------
  {
    id: 'blocks.drag.u01',
    feature: 'blocks.drag',
    name: 'A nested item can only drop among its own siblings, never out of its list',
    run: () => {
      const doc = '- a\n  - b\n  - c\n- d';
      const p = mountProse(doc);
      const t = blockDropTargets(p.view.state, blockRangeAt(p.view.state, doc.indexOf('b'))!)!;
      const outside = moveBlockTo(p.view.state, blockRangeAt(p.view.state, doc.indexOf('b'))!, 5);
      p.destroy();
      const lines = t.siblings.map((s) => s.startLine).join(',');
      // The gaps above and below b are its own place, offered so a drop over b finds home
      // first; the one gap that moves it is below c, still inside the nested list.
      const moving = t.indices.filter((i) => !t.home.includes(i));
      return all(
        { siblings: lines === '2,3', indices: moving.join(',') === '2', home: t.home.join(',') === '0,1', noOutside: outside === null },
        { lines, indices: t.indices, home: t.home }
      );
    },
  },
  {
    id: 'blocks.drag.u02',
    feature: 'blocks.drag',
    name: 'Dropping a nested item that has children at the end of its list carries the children',
    run: () => {
      const doc = '- a\n  - b\n    - b1\n  - c\n- d';
      const p = mountProse(doc);
      const spec = moveBlockTo(p.view.state, blockRangeAt(p.view.state, doc.indexOf('b'))!, 2);
      if (spec) p.view.dispatch(spec);
      const out = p.doc();
      p.destroy();
      return same(out, '- a\n  - c\n  - b\n    - b1\n- d');
    },
  },
  {
    id: 'blocks.drag.u03',
    feature: 'blocks.drag',
    name: 'A table with alignment, padding and an escaped pipe dropped below text arrives byte-identical, and one undo restores',
    run: () => {
      const doc = `${TABLE}\n\ntext\n\nend`;
      const p = mountProse(doc);
      p.view.dispatch(moveBlockTo(p.view.state, blockRangeAt(p.view.state, 0)!, 2)!);
      const moved = p.doc();
      const u = undoAll(p);
      p.destroy();
      return all({ moved: moved === `text\n\n${TABLE}\n\nend`, oneStep: u.steps === 1, restored: u.doc === doc }, { moved, u });
    },
  },
  {
    id: 'blocks.drag.u04',
    feature: 'blocks.drag',
    name: 'Dropping a paragraph at the end of blocks with no blank lines adds a blank line only at the seam that would merge',
    run: () => {
      const doc = '# A\npara\n# B\nmore';
      const p = mountProse(doc);
      p.view.dispatch(moveBlockTo(p.view.state, blockRangeAt(p.view.state, doc.indexOf('para'))!, 4)!);
      const out = p.doc();
      p.destroy();
      return same(out, '# A\n# B\nmore\n\npara');
    },
  },
  {
    id: 'blocks.drag.u05',
    feature: 'blocks.drag',
    name: 'The first numbered item dropped at the end: the list still reads 1, 2, 3 in the file',
    run: () => {
      const p = mountProse('1. a\n2. b\n3. c');
      p.view.dispatch(moveBlockTo(p.view.state, blockRangeAt(p.view.state, 0)!, 3)!);
      const out = p.doc();
      p.destroy();
      return same(out, '1. b\n2. c\n3. a');
    },
  },
  {
    id: 'blocks.drag.u06',
    feature: 'blocks.drag',
    name: 'Item 10 dropped above item 9: the list still starts at 9',
    run: () => {
      const doc = '9. a\n10. b';
      const p = mountProse(doc);
      p.view.dispatch(moveBlockTo(p.view.state, blockRangeAt(p.view.state, doc.indexOf('b'))!, 0)!);
      const out = p.doc();
      p.destroy();
      return { ok: /^9\. b\n10\. a$/.test(out), detail: `got ${show(out)}, a person sees the list start at ${/^(\d+)/.exec(out)?.[1]}` };
    },
  },
  {
    id: 'blocks.drag.u07',
    feature: 'blocks.drag',
    name: 'With two blocks selected, dragging the second carries both',
    run: () => {
      const doc = 'one\n\ntwo\n\nthree';
      const p = mountProse(doc);
      selectBlockAt(p.view, 0);
      navigateBlocks(p.view, 1, true);
      const spec = moveBlockTo(p.view.state, blockRangeAt(p.view.state, doc.indexOf('two'))!, 3);
      if (spec) p.view.dispatch(spec);
      const out = p.doc();
      p.destroy();
      return same(out, 'three\n\none\n\ntwo');
    },
  },
  {
    id: 'blocks.drag.u08',
    feature: 'blocks.drag',
    name: 'A move in a CRLF file sends VS Code an edit that stays CRLF and starts at the moved lines',
    run: () => {
      const disk = '# A\r\n\r\npara\r\n\r\n# B\r\n';
      const lf = disk.replace(/\r\n/g, '\n');
      const p = mountProse(lf);
      p.view.dispatch(moveBlockTo(p.view.state, blockRangeAt(p.view.state, lf.indexOf('para'))!, 3)!);
      const edit = planEdit(disk, p.doc(), true)!;
      p.destroy();
      const bareLf = /(^|[^\r])\n/.test(edit.text);
      return all({ crlf: !bareLf, text: edit.text === '# A\r\n\r\n# B\r\n\r\npara\r\n', start: edit.start >= '# A\r\n\r\n'.length }, edit);
    },
  },
  {
    id: 'blocks.drag.u09',
    feature: 'blocks.drag',
    name: 'A fenced block holding a blank line and # lines moves as one block',
    run: () => {
      const doc = '```md\n# not a heading\n\ntext\n```\n\npara';
      const p = mountProse(doc);
      p.view.dispatch(moveBlockTo(p.view.state, blockRangeAt(p.view.state, 0)!, 2)!);
      const out = p.doc();
      p.destroy();
      return same(out, 'para\n\n```md\n# not a heading\n\ntext\n```');
    },
  },
  {
    id: 'blocks.drag.u10',
    feature: 'blocks.drag',
    name: 'A paragraph dropped between a heading and the text directly under it stays its own paragraph',
    run: () => {
      const doc = 'first\n\n# H\nnext';
      const p = mountProse(doc);
      p.view.dispatch(moveBlockTo(p.view.state, blockRangeAt(p.view.state, 0)!, 2)!);
      const out = p.doc();
      p.destroy();
      return all({ text: out === '# H\n\nfirst\n\nnext', starts: blockStarts(out).length === 3 }, out);
    },
  },
  {
    id: 'blocks.drag.u11',
    feature: 'blocks.drag',
    name: 'Front matter with a heading directly under it is still front matter after a block drops to the top',
    run: () => {
      const doc = '---\nt: 1\n---\n# H\n\npara';
      const p = mountProse(doc);
      p.view.dispatch(moveBlockTo(p.view.state, blockRangeAt(p.view.state, doc.indexOf('para'))!, 1)!);
      const out = p.doc();
      const fm = blockRangeAt(p.view.state, 0);
      p.destroy();
      return all({ fmKept: out.startsWith('---\nt: 1\n---\n'), fmRange: !!fm && fm.kind === 'frontmatter' && fm.endLine === 3, order: out.indexOf('para') < out.indexOf('# H') }, out);
    },
  },
  {
    id: 'blocks.drag.u12',
    feature: 'blocks.drag',
    name: 'A loose list item dropped at the end keeps the blank lines between items',
    run: () => {
      const p = mountProse('- a\n\n- b\n\n- c');
      p.view.dispatch(moveBlockTo(p.view.state, blockRangeAt(p.view.state, 0)!, 3)!);
      const out = p.doc();
      p.destroy();
      return same(out, '- b\n\n- c\n\n- a');
    },
  },

  {
    id: 'blocks.drag.u13',
    feature: 'blocks.drag',
    name: 'Letting go with the pointer over the dragged block itself leaves the file alone',
    run: () => {
      // The grip's drop rule: slots at the gaps the model allows, and the one nearest the
      // pointer wins. Lay the blocks out 20px tall with 20px gaps, as the view would.
      const doc = 'one\n\ntwo\n\nthree';
      const p = mountProse(doc);
      const range = blockRangeAt(p.view.state, doc.indexOf('two'))!;
      const t = blockDropTargets(p.view.state, range)!;
      const top = (k: number): number => k * 40;
      const ys = t.indices.map((index) => ({ index, y: index === 0 ? top(0) : index >= t.siblings.length ? top(t.siblings.length - 1) + 20 : (top(index - 1) + 20 + top(index)) / 2 }));
      const pointer = top(1) + 10; // the middle of "two"
      const index = nearestDropIndex(ys, pointer);
      const spec = index === null ? null : moveBlockTo(p.view.state, range, index);
      if (spec) p.view.dispatch(spec);
      const out = p.doc();
      p.destroy();
      return { ok: out === doc, detail: `slots ${t.indices.join(',')}, nearest to the block's own middle is ${index}; file ${show(out)}` };
    },
  },

  // ---- blocks.plus -------------------------------------------------------------
  {
    id: 'blocks.plus.u01',
    feature: 'blocks.plus',
    name: 'The + on the last block of a file with no final newline adds an empty line below with the menu open',
    run: () => {
      const p = mountProse('para');
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, 0)!);
      const r = { doc: p.doc(), caret: p.view.state.selection.main.head, open: slashMenuOf(p.view.state) !== null };
      p.destroy();
      return all({ doc: r.doc === 'para\n\n', caret: r.caret === 6, open: r.open }, r);
    },
  },
  {
    id: 'blocks.plus.u02',
    feature: 'blocks.plus',
    name: 'The + on a list item with children adds a sibling item after the children',
    run: () => {
      const p = mountProse('- a\n  - b\n- c');
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, 0)!);
      type(p, 'new');
      const out = p.doc();
      p.destroy();
      return same(out, '- a\n  - b\n- new\n- c');
    },
  },
  {
    id: 'blocks.plus.u03',
    feature: 'blocks.plus',
    name: 'The + on a numbered item starts the next number',
    run: () => {
      const p = mountProse('1. a\n2. b');
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, 0)!);
      const out = p.doc();
      const caret = p.view.state.selection.main.head;
      p.destroy();
      return all({ line: out.split('\n')[1] === '2. ', caret: caret === '1. a\n2. '.length }, { out, caret });
    },
  },
  {
    id: 'blocks.plus.u04',
    feature: 'blocks.plus',
    name: 'The + on a checked task item adds an unchecked task item',
    run: () => {
      const p = mountProse('- [x] done');
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, 0)!);
      const out = p.doc();
      p.destroy();
      return same(out, '- [x] done\n- [ ] ');
    },
  },
  {
    id: 'blocks.plus.u05',
    feature: 'blocks.plus',
    name: 'The + on a heading with text directly under it: typed text becomes its own paragraph',
    run: () => {
      const p = mountProse('# H\npara');
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, 0)!);
      p.press('Escape');
      type(p, 'x');
      const out = p.doc();
      p.destroy();
      return all({ text: out === '# H\n\nx\n\npara', separate: blockStarts(out).length === 3 }, out);
    },
  },
  {
    id: 'blocks.plus.u06',
    feature: 'blocks.plus',
    name: 'The + then one undo gives back the original bytes',
    run: () => {
      const doc = 'a\n\nb';
      const p = mountProse(doc);
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, 0)!);
      const added = p.doc();
      const u = undoAll(p);
      p.destroy();
      return all({ added: added !== doc, oneStep: u.steps === 1, restored: u.doc === doc }, { added, u });
    },
  },
  {
    id: 'blocks.plus.u07',
    feature: 'blocks.plus',
    name: 'The + on a fenced code block adds the line after the closing fence, outside the code',
    run: () => {
      const doc = '```\ncode\n```\n\nnext';
      const p = mountProse(doc);
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, 1)!);
      p.press('Escape');
      type(p, 'x');
      const out = p.doc();
      p.destroy();
      return same(out, '```\ncode\n```\n\nx\n\nnext');
    },
  },
  {
    id: 'blocks.plus.u08',
    feature: 'blocks.plus',
    name: 'The + on a nested numbered item keeps its indent and the next number',
    run: () => {
      const doc = '1. a\n   1. b';
      const p = mountProse(doc);
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, doc.indexOf('b'))!);
      const out = p.doc();
      p.destroy();
      return same(out, '1. a\n   1. b\n   2. ');
    },
  },
  {
    id: 'blocks.plus.u09',
    feature: 'blocks.plus',
    name: 'Picking Table from the menu the + opened puts the table on its own block, apart from the text below',
    run: () => {
      const p = mountProse('# H\npara');
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, 0)!);
      type(p, 'table');
      p.press('Enter');
      const out = p.doc();
      const table = blockRangeAt(p.view.state, out.indexOf('| Column 1'));
      const para = blockRangeAt(p.view.state, out.indexOf('para'));
      p.destroy();
      return all({ heading: out.startsWith('# H\n\n| Column 1'), table: table?.kind === 'table', para: para?.kind === 'paragraph' && out.endsWith('\n\npara') }, out);
    },
  },
  {
    id: 'blocks.plus.u10',
    feature: 'blocks.plus',
    name: 'Escape after the + closes the menu and leaves the empty line ready to type on',
    run: () => {
      const p = mountProse('a\n\nb');
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, 0)!);
      const handled = p.press('Escape');
      const r = { handled, open: slashMenuOf(p.view.state) !== null, block: blockSelectionOf(p.view.state), doc: p.doc() };
      p.destroy();
      return all({ handled, closed: !r.open, noBlockSelection: r.block === null }, r);
    },
  },

  // ---- blocks.keyboard-selection ----------------------------------------------
  {
    id: 'blocks.keyboard-selection.u01',
    feature: 'blocks.keyboard-selection',
    name: 'Escape on a nested item selects it with all its children',
    run: () => {
      const doc = '- a\n  - b\n    - b1\n- c';
      const p = mountProse(doc);
      p.select(doc.indexOf('b'));
      p.press('Escape');
      const s = p.view.state.selection.main;
      p.destroy();
      return all({ from: s.from === doc.indexOf('  - b'), to: s.to === doc.indexOf('\n- c') }, s);
    },
  },
  {
    id: 'blocks.keyboard-selection.u02',
    feature: 'blocks.keyboard-selection',
    name: 'ArrowUp on the first block and ArrowDown on the last keep the selection where it is',
    run: () => {
      const doc = '# A\n\npara';
      const p = mountProse(doc);
      p.select(1);
      p.press('Escape');
      p.press('ArrowUp');
      const top = p.view.state.selection.main;
      p.select(doc.length);
      p.press('Escape');
      p.press('ArrowDown');
      const bottom = p.view.state.selection.main;
      const mode = blockSelectionOf(p.view.state);
      p.destroy();
      return all({ top: top.from === 0 && top.to === 3, bottom: bottom.from === 5 && bottom.to === 9, mode: mode !== null }, { top, bottom });
    },
  },
  {
    id: 'blocks.keyboard-selection.u03',
    feature: 'blocks.keyboard-selection',
    name: 'ArrowUp from the first body block then Backspace and Cmd+D never touch the front matter',
    run: () => {
      const doc = '---\nt: 1\n---\n\npara';
      const p = mountProse(doc);
      p.select(doc.indexOf('para'));
      p.press('Escape');
      p.press('ArrowUp');
      p.press('Backspace');
      p.press('Mod-d');
      p.press('Mod-Shift-ArrowDown');
      const out = p.doc();
      p.destroy();
      return same(out, doc);
    },
  },
  {
    id: 'blocks.keyboard-selection.u04',
    feature: 'blocks.keyboard-selection',
    name: 'Shift+Down then Backspace deletes both blocks, and one undo restores the bytes',
    run: () => {
      const doc = '# A\n\npara\n\n# B\n\nend';
      const p = mountProse(doc);
      p.select(doc.indexOf('para'));
      p.press('Escape');
      p.press('Shift-ArrowDown');
      p.press('Backspace');
      const del = p.doc();
      const u = undoAll(p);
      p.destroy();
      return all({ del: del === '# A\n\nend', oneStep: u.steps === 1, restored: u.doc === doc }, { del, u });
    },
  },
  {
    id: 'blocks.keyboard-selection.u05',
    feature: 'blocks.keyboard-selection',
    name: 'Duplicate then move down: the copy moves past the next block, and two undos restore the bytes',
    run: () => {
      const doc = '# A\n\npara\n\n# B';
      const p = mountProse(doc);
      p.select(doc.indexOf('para'));
      p.press('Escape');
      p.press('Mod-d');
      p.press('Mod-Shift-ArrowDown');
      const out = p.doc();
      const u = undoAll(p);
      p.destroy();
      return all({ out: out === '# A\n\npara\n\n# B\n\npara', twoSteps: u.steps === 2, restored: u.doc === doc }, { out, u });
    },
  },
  {
    id: 'blocks.keyboard-selection.u06',
    feature: 'blocks.keyboard-selection',
    name: 'Backspace on the only block empties the document, with and without a final newline',
    run: () => {
      const del = (doc: string): string => after(doc, 1, (p) => (p.press('Escape'), p.press('Backspace')));
      const a = del('only\n');
      const b = del('only');
      return { ok: a === '' && b === '', detail: `${show(a)} ${show(b)}` };
    },
  },
  {
    id: 'blocks.keyboard-selection.u07',
    feature: 'blocks.keyboard-selection',
    name: 'Enter leaves block selection with the caret at the end of the block, so typed text lands there',
    run: () => {
      const doc = '# A\n\npara one\nline two\n\n# B';
      const out = after(doc, doc.indexOf('para') + 2, (p) => {
        p.press('Escape');
        p.press('Enter');
        type(p, 'Z');
      });
      return same(out, '# A\n\npara one\nline twoZ\n\n# B');
    },
  },
  {
    id: 'blocks.keyboard-selection.u08',
    feature: 'blocks.keyboard-selection',
    name: 'ArrowDown from a selected parent item selects its first child',
    run: () => {
      const doc = '- a\n  - b\n- c';
      const p = mountProse(doc);
      p.select(2);
      p.press('Escape');
      p.press('ArrowDown');
      const s = p.view.state.selection.main;
      p.destroy();
      return all({ from: s.from === doc.indexOf('  - b'), to: s.to === doc.indexOf('\n- c') }, s);
    },
  },
  {
    id: 'blocks.keyboard-selection.u09',
    feature: 'blocks.keyboard-selection',
    name: 'Shift+Up from the first child takes in the parent item',
    run: () => {
      const doc = '- a\n  - b\n  - c\n- d';
      const p = mountProse(doc);
      p.select(doc.indexOf('b'));
      p.press('Escape');
      p.press('Shift-ArrowUp');
      const s = p.view.state.selection.main;
      p.destroy();
      return all({ from: s.from === 0, to: s.to === doc.indexOf('\n- d') }, s);
    },
  },
  {
    id: 'blocks.keyboard-selection.u10',
    feature: 'blocks.keyboard-selection',
    name: 'Two selected items with children moved up with Cmd+Shift+Up keep their children',
    run: () => {
      const doc = '- x\n- a\n  - a1\n- b';
      const out = after(doc, doc.indexOf('a'), (p) => {
        p.press('Escape');
        p.press('Shift-ArrowDown');
        p.press('Mod-Shift-ArrowUp');
      });
      return same(out, '- a\n  - a1\n- b\n- x');
    },
  },
  {
    id: 'blocks.keyboard-selection.u11',
    feature: 'blocks.keyboard-selection',
    name: 'Delete deletes a selected block the way Backspace does',
    run: () => same(after('# A\n\npara\n\n# B', 7, (p) => (p.press('Escape'), p.press('Delete'))), '# A\n\n# B'),
  },
  {
    id: 'blocks.keyboard-selection.u12',
    feature: 'blocks.keyboard-selection',
    name: 'A second Escape returns to a caret and leaves the file alone',
    run: () => {
      const doc = '# A\n\npara';
      const p = mountProse(doc);
      p.select(6);
      p.press('Escape');
      const inMode = blockSelectionOf(p.view.state) !== null;
      p.press('Escape');
      const r = { inMode, after: blockSelectionOf(p.view.state), empty: p.view.state.selection.main.empty, doc: p.doc() };
      p.destroy();
      return all({ inMode, left: r.after === null, caret: r.empty, doc: r.doc === doc }, r);
    },
  },
  {
    id: 'blocks.keyboard-selection.u13',
    feature: 'blocks.keyboard-selection',
    name: 'Escape inside a fenced code block selects the whole block, fences included',
    run: () => {
      const doc = 'x\n\n```\na\nb\n```';
      const p = mountProse(doc);
      p.select(doc.indexOf('b'));
      p.press('Escape');
      const s = p.view.state.selection.main;
      p.destroy();
      return all({ from: s.from === 3, to: s.to === doc.length }, s);
    },
  },
  {
    id: 'blocks.keyboard-selection.u14',
    feature: 'blocks.keyboard-selection',
    name: 'Deleting a selected block in a CRLF file sends VS Code a CRLF edit covering only that block',
    run: () => {
      const disk = '# A\r\n\r\npara\r\n\r\n# B\r\n';
      const lf = disk.replace(/\r\n/g, '\n');
      const p = mountProse(lf);
      p.select(lf.indexOf('para'));
      p.press('Escape');
      p.press('Backspace');
      const edit = planEdit(disk, p.doc(), true)!;
      p.destroy();
      return all({ text: edit.text === '# A\r\n\r\n# B\r\n', small: edit.end - edit.start === 'para\r\n\r\n'.length && edit.replacement === '' }, edit);
    },
  },

  // ---- blocks.alt-arrow --------------------------------------------------------
  {
    id: 'blocks.alt-arrow.u01',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Down in a two-line paragraph moves it and keeps the caret on the same character',
    run: () => {
      const doc = 'one\ntwo\n\n# B';
      const p = mountProse(doc);
      p.select(5);
      const handled = p.press('Alt-ArrowDown');
      const out = p.doc();
      const caret = p.view.state.selection.main.head;
      p.destroy();
      return all({ handled, out: out === '# B\n\none\ntwo', caret: caret === out.indexOf('two') + 1 }, { out, caret });
    },
  },
  {
    id: 'blocks.alt-arrow.u02',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Up on a one-line paragraph moves the paragraph, keeping the blank line that separates it',
    run: () => {
      // Not the line-wise move a text editor makes. `a\nb` is one paragraph with a
      // break in it, so moving this line up by one would merge two paragraphs into
      // one and change what the document says. The blank line is what keeps them
      // apart and it travels with the block.
      return same(after('a\n\nb', 3, (p) => p.press('Alt-ArrowUp')), 'b\n\na');
    },
  },
  {
    id: 'blocks.alt-arrow.u03',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Down on a list item with children moves it past the next item, children included',
    run: () => same(after('- a\n  - a1\n- b', 2, (p) => p.press('Alt-ArrowDown')), '- b\n- a\n  - a1'),
  },
  {
    id: 'blocks.alt-arrow.u04',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Up on a one-line item under an item with children swaps the items and leaves the children with their parent',
    run: () => {
      const doc = '- a\n  - b\n- c';
      return same(after(doc, doc.indexOf('c'), (p) => p.press('Alt-ArrowUp')), '- c\n- a\n  - b');
    },
  },
  {
    id: 'blocks.alt-arrow.u05',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Up on the first multi-line block under front matter leaves the file alone',
    run: () => {
      const doc = '---\nt: 1\n---\n\none\ntwo';
      return same(after(doc, doc.indexOf('one'), (p) => p.press('Alt-ArrowUp')), doc);
    },
  },
  {
    id: 'blocks.alt-arrow.u06',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Down on the last multi-line block leaves the file alone',
    run: () => {
      const doc = 'x\n\none\ntwo';
      return same(after(doc, doc.indexOf('one'), (p) => p.press('Alt-ArrowDown')), doc);
    },
  },
  {
    id: 'blocks.alt-arrow.u07',
    feature: 'blocks.alt-arrow',
    name: "Alt+Down with the caret in a table's source moves the whole table intact",
    run: () => same(after(`${TABLE}\n\nend`, 2, (p) => p.press('Alt-ArrowDown')), `end\n\n${TABLE}`),
  },
  {
    id: 'blocks.alt-arrow.u08',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Up inside a fenced block moves a code line and never the block',
    run: () => {
      const doc = '# H\n\n```\na\nb\n```';
      return same(after(doc, doc.indexOf('b'), (p) => p.press('Alt-ArrowUp')), '# H\n\n```\nb\na\n```');
    },
  },
  {
    id: 'blocks.alt-arrow.u09',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Down on a multi-line block then one undo gives back the bytes',
    run: () => {
      const doc = 'one\ntwo\n\n# B\n';
      const p = mountProse(doc);
      p.select(1);
      p.press('Alt-ArrowDown');
      const moved = p.doc();
      const u = undoAll(p);
      p.destroy();
      return all({ moved: moved === '# B\n\none\ntwo\n', oneStep: u.steps === 1, restored: u.doc === doc }, { moved, u });
    },
  },
  {
    id: 'blocks.alt-arrow.u10',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Up with the caret in a two-line quote moves the whole quote',
    run: () => same(after('para\n\n> q\n> r', 8, (p) => p.press('Alt-ArrowUp')), '> q\n> r\n\npara'),
  },
  {
    id: 'blocks.alt-arrow.u11',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Up twice on a one-line paragraph under front matter never pulls the paragraph into the front matter',
    run: () => {
      const doc = '---\nt: 1\n---\n\npara\n';
      const out = after(doc, doc.indexOf('para'), (p) => (p.press('Alt-ArrowUp'), p.press('Alt-ArrowUp')));
      const p = mountProse(out);
      const fm = blockRangeAt(p.view.state, 0);
      p.destroy();
      return { ok: out.startsWith('---\nt: 1\n---\n') && !!fm && fm.kind === 'frontmatter' && fm.endLine === 3, detail: `file ${show(out)}, front matter lines ${fm?.startLine}-${fm?.endLine}` };
    },
  },
  {
    id: 'blocks.alt-arrow.u12',
    feature: 'blocks.alt-arrow',
    name: 'Alt+Down on a nested multi-line item with children stays inside its list',
    run: () => {
      const doc = '- p\n  - a\n    - a1\n  - b\n- q';
      return same(after(doc, doc.indexOf('a'), (p) => (p.press('Alt-ArrowDown'), p.press('Alt-ArrowDown'))), '- p\n  - b\n  - a\n    - a1\n- q');
    },
  },
];
