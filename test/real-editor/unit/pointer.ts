// Unit scenarios for selecting with the mouse and for tables that stay grids:
//   prose.mouse-selection  double-click selects the word, triple-click selects the paragraph
//   tables.stays-grid      a table is only ever edited as a grid: entering edit mode near it never shows its raw Markdown
// The click handler itself lives in main.ts, which cannot be imported under jsdom, so these check the model the
// handler must act on: which word and paragraph a click position belongs to, and whether a reveal or selection
// next to a table leaves the grid drawn. The e2e file of the same name does the real clicks.
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { editorExtensions } from '../../../src/webview/editorExtensions';
import { setReveal, setLivePreviewConfig } from '../../../src/webview/livePreview';

type Result = boolean | { ok: boolean; detail?: string };
interface Scenario {
  id: string;
  feature: string;
  name: string;
  run: () => Result | Promise<Result>;
}
const j = (x: unknown) => JSON.stringify(x);

function mount(doc: string) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [editorExtensions(() => {})] }), parent });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  const grids = () => view.dom.querySelectorAll('.sheaf-table').length;
  const destroy = () => {
    view.destroy();
    parent.remove();
  };
  return { view, grids, destroy };
}

const wordAt = (doc: string, needle: string, offset: number): string => {
  const state = EditorState.create({ doc });
  const r = state.wordAt(doc.indexOf(needle) + offset);
  return r ? state.sliceDoc(r.from, r.to) : '';
};

/** The top-level block (the paragraph) that holds `pos`, as a triple-click should select it. */
const paragraphAt = (doc: string, needle: string): string => {
  const m = mount(doc);
  try {
    let node = syntaxTree(m.view.state).resolveInner(doc.indexOf(needle), 1);
    while (node.parent && node.parent.parent) node = node.parent;
    return m.view.state.sliceDoc(node.from, node.to);
  } finally {
    m.destroy();
  }
};

const TABLE = '| Fruit | Qty |\n| ----- | --- |\n| apple | 3   |\n| kiwi  | 12  |';
const DOC = `Intro paragraph here.\n\n${TABLE}\n\nAfter line\n`;

export const scenarios: Scenario[] = [
  {
    id: 'prose.mouse-selection.u01',
    feature: 'prose.mouse-selection',
    name: 'The word a double-click lands in is the plain word, inside bold, a link, code or a heading alike',
    run: () => {
      const got = {
        plain: wordAt('Say hello to the world.', 'hello', 2),
        bold: wordAt('Some **bold** text.', 'bold', 2),
        link: wordAt('Go to [the site](https://x.io) now.', 'site', 2),
        code: wordAt('Run `npm` now.', 'npm', 1),
        heading: wordAt('## Heading two', 'Heading', 3),
      };
      const want = { plain: 'hello', bold: 'bold', link: 'site', code: 'npm', heading: 'Heading' };
      return { ok: j(got) === j(want), detail: j(got) };
    },
  },
  {
    id: 'prose.mouse-selection.u02',
    feature: 'prose.mouse-selection',
    name: 'The paragraph a triple-click lands in covers every source line of that paragraph and nothing past it',
    run: () => {
      const doc = 'Before.\n\nFirst line of para\nsecond line of para\n\nNext para.\n';
      const got = paragraphAt(doc, 'second line');
      return { ok: got === 'First line of para\nsecond line of para', detail: j(got) };
    },
  },
  {
    id: 'tables.stays-grid.u01',
    feature: 'tables.stays-grid',
    name: 'Revealing the paragraph above a table (as a double-click there does) leaves the table a grid',
    run: () => {
      const m = mount(DOC);
      const before = m.grids();
      m.view.dispatch({ effects: setReveal.of({ from: 0, to: 'Intro paragraph here.'.length }), selection: { anchor: 3 } });
      const after = m.grids();
      m.destroy();
      return { ok: before === 1 && after === 1, detail: `grids before ${before}, after ${after}` };
    },
  },
  {
    id: 'tables.stays-grid.u02',
    feature: 'tables.stays-grid',
    name: 'Revealing the blank line directly below a table (the double-click fallback range) leaves the table a grid',
    run: () => {
      const m = mount(DOC);
      const blank = DOC.indexOf(TABLE) + TABLE.length + 1;
      m.view.dispatch({ effects: setReveal.of({ from: blank, to: blank }), selection: { anchor: blank } });
      const after = m.grids();
      m.destroy();
      return { ok: after === 1, detail: `grids after ${after}` };
    },
  },
  {
    id: 'tables.stays-grid.u03',
    feature: 'tables.stays-grid',
    name: 'Selecting the whole line above a table with its line break (as a triple-click does) leaves the table a grid',
    run: () => {
      const doc = `Intro paragraph here.\n${TABLE}\n\nAfter line\n`;
      const m = mount(doc);
      const before = m.grids();
      m.view.dispatch({ selection: EditorSelection.single(0, 'Intro paragraph here.\n'.length) });
      const after = m.grids();
      m.destroy();
      return { ok: after === before && after === 1, detail: `grids before ${before}, after ${after}` };
    },
  },
  {
    id: 'tables.stays-grid.u04',
    feature: 'tables.stays-grid',
    name: 'Typing and pressing Enter at the end of a revealed paragraph above a table leaves the table a grid',
    run: () => {
      const m = mount(DOC);
      const end = 'Intro paragraph here.'.length;
      m.view.dispatch({ effects: setReveal.of({ from: 0, to: end }), selection: { anchor: end } });
      m.view.dispatch({ changes: { from: end, insert: 'X\nY' }, selection: { anchor: end + 3 }, userEvent: 'input.type' });
      const after = m.grids();
      m.destroy();
      return { ok: after === 1, detail: `grids after ${after}` };
    },
  },
  {
    id: 'tables.stays-grid.u05',
    feature: 'tables.stays-grid',
    name: 'With Reveal syntax on line turned on, the caret in the paragraph just above a table leaves the table a grid',
    run: () => {
      const m = mount(DOC);
      setLivePreviewConfig({ revealSyntaxOnLine: true } as any);
      try {
        m.view.dispatch({ selection: { anchor: 'Intro paragraph here.'.length } });
        m.view.dispatch({ effects: [] });
        return { ok: m.grids() === 1, detail: `grids ${m.grids()}` };
      } finally {
        setLivePreviewConfig({ revealSyntaxOnLine: false } as any);
        m.destroy();
      }
    },
  },
];
