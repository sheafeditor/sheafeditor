import { EditorState } from '@codemirror/state';
import { undo } from '@codemirror/commands';
import { Scenario, Prose, mountProse } from '../harness';
import {
  blockRangeAt,
  blockSelectionOf,
  moveBlock,
  duplicateBlock,
  deleteBlock,
  blockDropTargets,
  moveBlockTo,
  nearestDropIndex,
  blockMenuItems,
  BlockMenuItem,
  insertParagraphBelow,
  slashMenuOf,
  setBlockRefHost,
} from '../../src/webview/blocks';

/** Type text at the caret one character at a time, as keyboard input arrives. */
function type(p: Prose, text: string): void {
  for (const ch of text) {
    const head = p.view.state.selection.main.head;
    p.view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: 'input.type' });
  }
}

/** Run `fn` on a fresh editor holding `doc` with the caret at `at`, and return the document afterwards. */
function after(doc: string, at: number, fn: (p: Prose) => void): string {
  const p = mountProse(doc);
  p.select(at);
  fn(p);
  const out = p.doc();
  p.destroy();
  return out;
}

const lineStart = (doc: string, n: number): number => EditorState.create({ doc }).doc.line(n).from;

const SAMPLE = [
  '---', // 1
  'title: x', // 2
  '---', // 3
  '', // 4
  '# Heading', // 5
  '', // 6
  'para one', // 7
  'line two', // 8
  '', // 9
  '- a', // 10
  '  - b', // 11
  '  - c', // 12
  '- d', // 13
  '', // 14
  '```js', // 15
  'code', // 16
  '```', // 17
  '', // 18
  '| a | b |', // 19
  '|---|---|', // 20
  '| 1 | 2 |', // 21
  '', // 22
  '> q', // 23
  '> r', // 24
  '', // 25
  '```csv', // 26
  'x,y', // 27
  '```', // 28
].join('\n');

const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |';

function menuItem(items: BlockMenuItem[], label: string): BlockMenuItem {
  const found = items.find((i) => i.label === label);
  if (!found) throw new Error(`no menu item ${label}`);
  return found;
}

export const scenarios: Scenario[] = [
  {
    name: 'blockRangeAt covers each construct and flags front matter as immovable',
    run: () => {
      const p = mountProse(SAMPLE);
      const at = (line: number) => blockRangeAt(p.view.state, lineStart(SAMPLE, line) + 1);
      const span = (line: number) => {
        const r = at(line);
        return r ? `${r.startLine}-${r.endLine}:${r.kind}:${r.movable}` : 'null';
      };
      const got = [2, 5, 7, 8, 10, 11, 13, 16, 20, 24, 27].map(span);
      const blank = blockRangeAt(p.view.state, lineStart(SAMPLE, 4));
      p.destroy();
      const want = [
        '1-3:frontmatter:false',
        '5-5:heading:true',
        '7-8:paragraph:true',
        '7-8:paragraph:true',
        '10-12:item:true',
        '11-11:item:true',
        '13-13:item:true',
        '15-17:code:true',
        '19-21:table:true',
        '23-24:quote:true',
        '26-28:table:true',
      ];
      return blank === null && got.join('|') === want.join('|');
    },
  },
  {
    name: 'blockRangeAt keeps a setext heading and its underline together',
    run: () => {
      const doc = 'Title\n===\n\ntext';
      const p = mountProse(doc);
      const r = blockRangeAt(p.view.state, lineStart(doc, 2) + 1);
      p.destroy();
      return !!r && r.startLine === 1 && r.endLine === 2 && r.kind === 'heading';
    },
  },
  {
    name: 'moveBlock swaps whole blocks and keeps the blank lines where they were',
    run: () => {
      const doc = '# A\n\npara\n\n# B';
      const down = after(doc, 6, (p) => moveBlock(p.view, 1));
      const up = after(doc, 6, (p) => moveBlock(p.view, -1));
      const p = mountProse(doc);
      p.select(7);
      moveBlock(p.view, 1);
      const caret = p.view.state.selection.main.head === p.doc().indexOf('para') + 2;
      p.destroy();
      return down === '# A\n\n# B\n\npara' && up === 'para\n\n# A\n\n# B' && caret;
    },
  },
  {
    name: 'moveBlock does nothing at the document edges',
    run: () => {
      const doc = '# A\n\npara';
      return after(doc, 1, (p) => moveBlock(p.view, -1)) === doc && after(doc, 7, (p) => moveBlock(p.view, 1)) === doc;
    },
  },
  {
    name: 'moveBlock carries a table intact past text and text past a table',
    run: () => {
      const doc = `text\n\n${TABLE}\n\nend`;
      const textDown = after(doc, 1, (p) => moveBlock(p.view, 1));
      const endUp = after(doc, doc.length - 1, (p) => moveBlock(p.view, -1));
      const csv = 'intro\n\n```csv\na,b\n1,2\n```';
      const csvUp = after(csv, csv.length - 2, (p) => moveBlock(p.view, -1));
      return (
        textDown === `${TABLE}\n\ntext\n\nend` &&
        endUp === `text\n\nend\n\n${TABLE}` &&
        csvUp === '```csv\na,b\n1,2\n```\n\nintro'
      );
    },
  },
  {
    name: 'moveBlock never moves front matter or a block above it',
    run: () => {
      const doc = '---\nt: 1\n---\n\npara\n\n# H';
      const paraUp = after(doc, doc.indexOf('para') + 1, (p) => moveBlock(p.view, -1));
      const fmDown = after(doc, 5, (p) => moveBlock(p.view, 1));
      const hUp = after(doc, doc.length - 1, (p) => moveBlock(p.view, -1));
      return paraUp === doc && fmDown === doc && hUp === '---\nt: 1\n---\n\n# H\n\npara';
    },
  },
  {
    name: 'moveBlock swaps list items with their siblings at the same level',
    run: () => {
      const doc = '- a\n  - b\n  - c\n- d';
      const cUp = after(doc, doc.indexOf('c'), (p) => moveBlock(p.view, -1));
      const aDown = after(doc, 2, (p) => moveBlock(p.view, 1));
      const bUp = after(doc, doc.indexOf('b'), (p) => moveBlock(p.view, -1));
      const ordered = after('1. one\n2. two\n3. three', 10, (p) => moveBlock(p.view, -1));
      return (
        cUp === '- a\n  - c\n  - b\n- d' &&
        aDown === '- d\n- a\n  - b\n  - c' &&
        bUp === doc &&
        ordered === '1. two\n2. one\n3. three'
      );
    },
  },
  {
    name: 'moveBlock keeps a moved paragraph from merging into the text below it',
    run: () => {
      const doc = 'para\n\n# H\nnext';
      return after(doc, 1, (p) => moveBlock(p.view, 1)) === '# H\n\npara\n\nnext';
    },
  },
  {
    name: 'a block move is one undo step',
    run: () => {
      const doc = '# A\n\npara\n\n# B';
      const p = mountProse(doc);
      p.select(6);
      moveBlock(p.view, 1);
      const moved = p.doc() !== doc;
      undo(p.view);
      const ok = moved && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'duplicateBlock places a byte-identical copy after the block with the same separation',
    run: () => {
      const para = after('# A\n\npara\n\n# B', 6, (p) => duplicateBlock(p.view));
      const item = after('- a\n- b', 1, (p) => duplicateBlock(p.view));
      const last = after('a\n\nb', 4, (p) => duplicateBlock(p.view));
      const table = after(TABLE, TABLE.length, (p) => duplicateBlock(p.view));
      const tight = after('# H\npara', 1, (p) => duplicateBlock(p.view));
      return (
        para === '# A\n\npara\n\npara\n\n# B' &&
        item === '- a\n- a\n- b' &&
        last === 'a\n\nb\n\nb' &&
        table === `${TABLE}\n\n${TABLE}` &&
        tight === '# H\n# H\npara'
      );
    },
  },
  {
    name: 'deleteBlock removes the block and one separator without merging neighbours',
    run: () => {
      const doc = '# A\n\npara\n\n# B';
      const mid = after(doc, 6, (p) => deleteBlock(p.view));
      const last = after(doc, doc.length, (p) => deleteBlock(p.view));
      const first = after(doc, 0, (p) => deleteBlock(p.view));
      const nested = after('- a\n  - b\n- c', 8, (p) => deleteBlock(p.view));
      const guarded = after('para\n# H\nnext', 6, (p) => deleteBlock(p.view));
      return (
        mid === '# A\n\n# B' &&
        last === '# A\n\npara' &&
        first === 'para\n\n# B' &&
        nested === '- a\n- c' &&
        guarded === 'para\n\nnext'
      );
    },
  },
  {
    name: 'Escape selects the enclosing block and arrows move the block selection',
    run: () => {
      const doc = '# A\n\npara\n\n# B';
      const p = mountProse(doc);
      p.select(7);
      const esc = p.press('Escape');
      const s1 = p.view.state.selection.main;
      const first = esc && s1.from === 5 && s1.to === 9 && blockSelectionOf(p.view.state) !== null;
      p.press('ArrowDown');
      const s2 = p.view.state.selection.main;
      const second = s2.from === 11 && s2.to === 14;
      p.press('ArrowUp');
      p.press('ArrowUp');
      const s3 = p.view.state.selection.main;
      const third = s3.from === 0 && s3.to === 3;
      p.press('Shift-ArrowDown');
      const s4 = p.view.state.selection.main;
      const extended = s4.from === 0 && s4.to === 9;
      p.press('Mod-Shift-ArrowDown');
      const moved = p.doc() === '# B\n\n# A\n\npara';
      const s5 = p.view.state.selection.main;
      const follows = s5.from === 5 && s5.to === p.doc().length && blockSelectionOf(p.view.state) !== null;
      p.press('Enter');
      const caret = p.view.state.selection.main.empty && blockSelectionOf(p.view.state) === null && p.doc() === '# B\n\n# A\n\npara';
      p.destroy();
      return first && second && third && extended && moved && follows && caret;
    },
  },
  {
    name: 'Shift-arrows extend over sibling items and then take in the parent item',
    run: () => {
      const doc = '- a\n  - b\n  - c\n- d';
      const p = mountProse(doc);
      p.select(doc.indexOf('b'));
      p.press('Escape');
      p.press('Shift-ArrowDown');
      const s1 = p.view.state.selection.main;
      const siblings = s1.from === doc.indexOf('  - b') && s1.to === doc.indexOf('\n- d');
      p.press('Shift-ArrowDown');
      const s2 = p.view.state.selection.main;
      const parent = s2.from === 0 && s2.to === doc.indexOf('\n- d');
      p.press('Alt-ArrowDown');
      const moved = p.doc() === '- d\n- a\n  - b\n  - c';
      p.destroy();
      return siblings && parent && moved;
    },
  },
  {
    name: 'block selection duplicates with Mod-d and deletes with Backspace',
    run: () => {
      const doc = '# A\n\npara\n\n# B';
      const p = mountProse(doc);
      p.select(7);
      p.press('Escape');
      p.press('Mod-d');
      const dup = p.doc() === '# A\n\npara\n\npara\n\n# B';
      const s = p.view.state.selection.main;
      const onCopy = s.from === 11 && s.to === 15;
      p.press('Backspace');
      const del = p.doc() === doc;
      p.destroy();
      return dup && onCopy && del;
    },
  },
  {
    name: 'block keys leave ordinary caret editing alone',
    run: () => {
      const doc = '# A\n\npara\n\n# B';
      const p = mountProse(doc);
      p.select(7);
      p.press('Mod-d');
      const noDup = p.doc() === doc;
      p.press('Mod-Shift-ArrowDown');
      const noMove = p.doc() === doc;
      p.select(4);
      const blank = p.press('Escape');
      p.select(0, 3);
      p.press('Escape');
      const textSel = blockSelectionOf(p.view.state) !== null;
      p.destroy();
      return noDup && noMove && !blank && !textSel;
    },
  },
  {
    name: 'Alt-ArrowDown moves a multi-line block and still moves lines inside code',
    run: () => {
      const para = after('line one\nline two\n\n# B', 2, (p) => p.press('Alt-ArrowDown'));
      const code = after('```\na\nb\n```', 4, (p) => p.press('Alt-ArrowDown'));
      return para === '# B\n\nline one\nline two' && code === '```\nb\na\n```';
    },
  },
  {
    name: 'the slash menu opens at a line start or after a space, never mid-word or in a URL',
    run: () => {
      const opens = (doc: string): boolean => {
        const p = mountProse(doc);
        p.select(doc.length);
        type(p, '/');
        const open = slashMenuOf(p.view.state) !== null;
        p.destroy();
        return open;
      };
      const code = mountProse('```\n\n```');
      code.select(4);
      type(code, '/');
      const inCode = slashMenuOf(code.view.state) !== null;
      code.destroy();
      return opens('') && opens('text ') && opens('- ') && !opens('word') && !opens('see https:') && !opens('1') && !inCode;
    },
  },
  {
    name: 'the slash menu filters as you type and lists every item when empty',
    run: () => {
      const p = mountProse('');
      type(p, '/');
      const all = slashMenuOf(p.view.state)!.items.map((i) => i.label);
      type(p, 'head');
      const headings = slashMenuOf(p.view.state)!.items.map((i) => i.label);
      p.destroy();
      return (
        all.join('|') ===
          'Text|Heading 1|Heading 2|Heading 3|Bullet list|Numbered list|Task list|Quote|Code block|Table|CSV data table|Divider' &&
        headings.join('|') === 'Heading 1|Heading 2|Heading 3'
      );
    },
  },
  {
    name: 'Escape dismisses the slash menu and keeps the typed text, and no match dismisses it',
    run: () => {
      const p = mountProse('');
      type(p, '/hea');
      const handled = p.press('Escape');
      const escaped = handled && slashMenuOf(p.view.state) === null && p.doc() === '/hea';
      p.destroy();
      const q = mountProse('');
      type(q, '/zzz');
      const none = slashMenuOf(q.view.state) === null && q.doc() === '/zzz';
      type(q, 'a');
      const staysClosed = slashMenuOf(q.view.state) === null;
      q.destroy();
      return escaped && none && staysClosed;
    },
  },
  {
    name: 'picking a slash item removes the query and converts the block',
    run: () => {
      const pick = (doc: string, typed: string, keys: string[] = ['Enter']): string =>
        after(doc, doc.length, (p) => {
          type(p, typed);
          for (const k of keys) p.press(k);
        });
      const h2 = pick('', '/h2');
      const quote = pick('Hello ', '/quote');
      const bullet = pick('', '/bul');
      const second = pick('', '/head', ['ArrowDown', 'Enter']);
      const table = pick('', '/table');
      const code = mountProse('');
      type(code, '/code');
      code.press('Enter');
      const fenced = code.doc() === '```\n\n```' && code.view.state.selection.main.head === 4;
      code.destroy();
      return (
        h2 === '## ' &&
        quote === '> Hello ' &&
        bullet === '- ' &&
        second === '## ' &&
        table === '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |' &&
        fenced
      );
    },
  },
  {
    name: 'the handle menu turns a block into another kind in place',
    run: () => {
      const doc = 'para one\nline two';
      const turn = (source: string, label: string): string =>
        after(source, 1, (p) => {
          const range = blockRangeAt(p.view.state, 1)!;
          const into = menuItem(blockMenuItems(p.view, range), 'Turn into');
          menuItem(into.children!, label).run!();
        });
      return (
        turn(doc, 'Heading 2') === '## para one line two' &&
        turn(doc, 'Bullet list') === '- para one\nline two' &&
        turn(doc, 'Quote') === '> para one\n> line two' &&
        turn(doc, 'Code block') === '```\npara one\nline two\n```' &&
        turn('- [ ] task', 'Text') === 'task' &&
        turn('> q', 'Heading 1') === '# q' &&
        turn('## h', 'Numbered list') === '1. h' &&
        turn('- a', 'Bullet list') === '- a'
      );
    },
  },
  {
    name: 'the handle menu duplicates, moves and deletes the hovered block',
    run: () => {
      const doc = '# A\n\npara\n\n# B';
      const act = (label: string): string =>
        after(doc, 0, (p) => {
          const range = blockRangeAt(p.view.state, 6)!;
          menuItem(blockMenuItems(p.view, range), label).run!();
        });
      const p = mountProse('---\nt: 1\n---\n\npara');
      const fm = blockMenuItems(p.view, blockRangeAt(p.view.state, 5)!);
      p.destroy();
      return (
        act('Duplicate') === '# A\n\npara\n\npara\n\n# B' &&
        act('Move up') === 'para\n\n# A\n\n# B' &&
        act('Move down') === '# A\n\n# B\n\npara' &&
        act('Delete') === '# A\n\n# B' &&
        fm.length === 0
      );
    },
  },
  {
    name: 'Copy ref puts the block path and line range on the clipboard',
    run: () => {
      let copied = '';
      const p = mountProse('# A\n\npara one\nline two');
      const without = blockMenuItems(p.view, blockRangeAt(p.view.state, 0)!).some((i) => i.label === 'Copy ref');
      setBlockRefHost({ getFileName: () => 'docs/guide.md', copyToClipboard: (t) => (copied = t) });
      menuItem(blockMenuItems(p.view, blockRangeAt(p.view.state, 6)!), 'Copy ref').run!();
      const multi = copied;
      menuItem(blockMenuItems(p.view, blockRangeAt(p.view.state, 0)!), 'Copy ref').run!();
      const single = copied;
      setBlockRefHost(null);
      p.destroy();
      return !without && multi === 'docs/guide.md:3-4\n\n```\npara one\nline two\n```\n' && single === 'docs/guide.md:1\n';
    },
  },
  {
    name: 'a drag reorders by drop index and refuses the front matter slot',
    run: () => {
      const doc = '---\nt: 1\n---\n\n# A\n\npara\n\n# B';
      const p = mountProse(doc);
      const para = blockRangeAt(p.view.state, doc.indexOf('para'))!;
      const targets = blockDropTargets(p.view.state, para)!;
      const spec = moveBlockTo(p.view.state, para, 4)!;
      p.view.dispatch(spec);
      const toEnd = p.doc() === '---\nt: 1\n---\n\n# A\n\n# B\n\npara';
      undo(p.view);
      const noop = [0, 2, 3].every((i) => moveBlockTo(p.view.state, para, i) === null);
      const toTop = moveBlockTo(p.view.state, para, 1)!;
      p.view.dispatch(toTop);
      const top = p.doc() === '---\nt: 1\n---\n\npara\n\n# A\n\n# B';
      p.destroy();
      const nearest = nearestDropIndex([{ index: 1, y: 10 }, { index: 3, y: 50 }, { index: 4, y: 90 }], 62) === 3;
      return targets.indices.join(',') === '1,2,3,4' && targets.home.join(',') === '2,3' && toEnd && noop && top && nearest;
    },
  },
  {
    name: 'the plus button adds an empty paragraph below and opens the slash menu there',
    run: () => {
      const doc = '# A\n\n# B';
      const p = mountProse(doc);
      insertParagraphBelow(p.view, blockRangeAt(p.view.state, 0)!);
      const added = p.doc() === '# A\n\n\n\n# B' && p.view.state.selection.main.head === 5;
      const open = slashMenuOf(p.view.state)?.items.length === 12;
      type(p, 'h1');
      p.press('Enter');
      const converted = p.doc() === '# A\n\n# \n\n# B';
      p.destroy();
      return added && open && converted;
    },
  },
];
