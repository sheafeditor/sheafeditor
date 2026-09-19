import { Scenario, mountProse } from '../harness';
import { turnInto, BlockKind } from '../../src/webview/toolbar';

/** Select the whole of `doc`, run Turn into with `kind`, and return the resulting text. */
const turnAll = (doc: string, kind: BlockKind): string => {
  const p = mountProse(doc);
  p.select(0, doc.length);
  turnInto(p.view, kind);
  const out = p.doc();
  p.destroy();
  return out;
};

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |';

export const scenarios: Scenario[] = [
  {
    name: 'Turn into over a selection that spans a table leaves the table rows alone',
    run: () => {
      const doc = `intro\n\n${TABLE}\n\nend`;
      const heading = turnAll(doc, 'h1') === `# intro\n\n${TABLE}\n\n# end`;
      const kinds: BlockKind[] = ['h2', 'bullet', 'ordered', 'task', 'quote', 'text'];
      const rowsKept = kinds.every((kind) => turnAll(doc, kind).includes(`\n\n${TABLE}\n\n`));
      return heading && rowsKept;
    },
  },
  {
    name: 'Turn into over a selection that crosses a code block leaves the code lines alone',
    run: () => {
      const fenced = turnAll('intro\n\n```\ncode\n```\n\nend', 'h1') === '# intro\n\n```\ncode\n```\n\n# end';
      const indented = turnAll('intro\n\n    code\n\nend', 'quote') === '> intro\n\n    code\n\n> end';
      return fenced && indented;
    },
  },
  {
    name: 'Turn into still converts list, task and quote lines around a table',
    run: () => turnAll(`- one\n\n${TABLE}\n\n> two\n\n- [ ] three`, 'h2') === `## one\n\n${TABLE}\n\n## two\n\n## three`,
  },
  {
    name: 'Turn into Numbered list numbers paragraphs in order across blank lines',
    run: () => {
      const unit = turnAll('one\n\ntwo', 'ordered') === '1. one\n\n2. two';
      const reported = turnAll('first one\n\nsecond two', 'ordered') === '1. first one\n\n2. second two';
      const acrossTable = turnAll(`intro\n\n${TABLE}\n\nend`, 'ordered') === `1. intro\n\n${TABLE}\n\n2. end`;
      return unit && reported && acrossTable;
    },
  },
  {
    name: 'Turn into over a selection that crosses a divider or an HTML block leaves those lines alone',
    run: () => {
      const divider = turnAll('intro\n\n---\n\nend', 'h1') === '# intro\n\n---\n\n# end';
      const html = turnAll('intro\n\n<div>\nbox\n</div>\n\nend', 'bullet') === '- intro\n\n<div>\nbox\n</div>\n\n- end';
      return divider && html;
    },
  },
];
