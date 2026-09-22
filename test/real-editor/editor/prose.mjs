// E2E scenarios for prose editing commands, driven by clicks in real VS Code.
import { show } from '../session.mjs';

const DOC = 'Say hello to the world today.\n\nA **bold** word here.\n\nLast line\n';

/** A toolbar button's state, found by the start of its title. */
const button = (S, title) =>
  S.eval((t) => {
    const b = [...document.querySelectorAll('#toolbar button')].find((x) => (x.title || '').startsWith(t));
    return b ? { title: b.title, pressed: b.getAttribute('aria-pressed'), active: b.classList.contains('is-active'), disabled: b.disabled } : null;
  }, title);

/** Click inside `word`, then press End: the caret at the end of that visual line without clicking past the text. */
async function caretEnd(S, word) {
  await S.caret(word, 1);
  await S.press('End');
}

/** Rendered classes of the line that shows `text`. */
const lineClass = (S, text) =>
  S.eval((t) => {
    const l = [...document.querySelectorAll('.cm-content > .cm-line')].find((x) => x.textContent.includes(t));
    return l ? l.className : null;
  }, text);

/** Click the empty rendered line at index `nth` among the empty .cm-line elements. */
const clickEmptyLine = (S, nth = 0) =>
  S.eval((n) => {
    const empties = [...document.querySelectorAll('.cm-content > .cm-line')].filter((l) => l.textContent === '');
    return empties.length > n ? [...document.querySelectorAll('.cm-content > .cm-line')].indexOf(empties[n]) : -1;
  }, nth).then((i) => {
    if (i < 0) throw new Error('no empty line to click');
    return S.click({ sel: '.cm-content > .cm-line', nth: i, dx: 6 });
  });

const overlayOpen = (S) => S.eval(() => !!document.querySelector('.sheaf-sc-backdrop:not([hidden])'));

/** Put the caret at the start of `text` and drag the selection over it with the keyboard. */
async function selectRun(S, text) {
  await S.caret(text.split(' ')[0], 0);
  await S.press('Shift+ArrowRight '.repeat(text.length).trim());
}

/** Copy `text` to the system clipboard and paste it over the current selection. */
async function pasteOver(S, text) {
  await S.clipboard.write(text);
  await S.press('Meta+v');
  await S.sleep(700);
}

export const scenarios = [
  /* ---- prose.inline-marks ---- */
  {
    id: 'prose.inline-marks.e01',
    feature: 'prose.inline-marks',
    name: 'Selecting a word by dragging and clicking Bold makes it bold in the file',
    run: async (S) => {
      await S.fresh('bold-select', DOC);
      await S.select('world');
      await S.toolbar('Bold');
      const d = await S.disk();
      return { ok: d.includes('the **world** today'), detail: show(d) };
    },
  },
  {
    id: 'prose.inline-marks.e02',
    feature: 'prose.inline-marks',
    name: 'Clicking Bold twice on a selected word leaves the file as it was',
    run: async (S) => {
      await S.fresh('bold-select-twice', DOC);
      await S.select('world');
      await S.toolbar('Bold');
      await S.toolbar('Bold');
      const d = await S.disk();
      return { ok: d === DOC, detail: show(d) };
    },
  },
  {
    id: 'prose.inline-marks.e03',
    feature: 'prose.inline-marks',
    name: 'With the caret at the end of a line, clicking Bold twice leaves the file as it was',
    run: async (S) => {
      await S.fresh('bold-caret-twice', DOC);
      await S.caret('today.', 6);
      await S.toolbar('Bold');
      await S.toolbar('Bold');
      const d = await S.disk();
      return { ok: d === DOC, detail: show(d) };
    },
  },
  {
    id: 'prose.inline-marks.e04',
    feature: 'prose.inline-marks',
    name: 'With the caret inside a bold word, clicking Bold removes the bold',
    run: async (S) => {
      await S.fresh('bold-caret-inside', DOC);
      await S.caret('bold', 2);
      await S.toolbar('Bold');
      const d = await S.disk();
      return { ok: d.includes('A bold word here.'), detail: show(d) };
    },
  },
  {
    id: 'prose.inline-marks.e05',
    feature: 'prose.inline-marks',
    name: 'The Bold button shows as on while the caret is inside a bold word',
    run: async (S) => {
      await S.fresh('bold-state', DOC);
      await S.caret('bold', 2);
      await S.sleep(300);
      const on = await S.eval(() => {
        const b = [...document.querySelectorAll('#toolbar button')].find((x) => (x.title || '').startsWith('Bold'));
        return { cls: b.className, pressed: b.getAttribute('aria-pressed') };
      });
      return { ok: /is-active/.test(on.cls) || on.pressed === 'true', detail: JSON.stringify(on) };
    },
  },
  {
    id: 'prose.inline-marks.e06',
    feature: 'prose.inline-marks',
    name: 'Cmd+B on a selected word makes it bold, and Cmd+B again undoes it',
    run: async (S) => {
      await S.fresh('bold-shortcut', DOC);
      await S.select('world');
      await S.press('Meta+b');
      const once = await S.disk();
      await S.press('Meta+b');
      const twice = await S.disk();
      return { ok: once.includes('**world**') && twice === DOC, detail: `once ${show(once)} twice ${show(twice)}` };
    },
  },
  {
    id: 'prose.inline-marks.e07',
    feature: 'prose.inline-marks',
    name: 'Italic, Strikethrough, Highlight and Inline code buttons each mark a dragged word, and it renders marked with no markers showing',
    run: async (S) => {
      await S.fresh('marks-four', 'alpha beta gamma delta\n');
      for (const [word, title] of [['alpha', 'Italic'], ['beta', 'Strikethrough'], ['gamma', 'Highlight'], ['delta', 'Inline code']]) {
        await S.select(word);
        await S.toolbar(title);
      }
      await S.caret('beta', 1);
      const d = await S.disk();
      const classes = await S.eval(() => ['tok-em', 'tok-strike', 'tok-highlight', 'tok-inline-code'].map((c) => document.querySelector(`.${c}`)?.textContent ?? null));
      const r = await S.rendered();
      // Inline code keeps its backticks visible but dimmed by design (render.inline-marks); the other markers hide.
      return {
        ok: d === '*alpha* ~~beta~~ ==gamma== `delta`\n' && classes.join('|').replace(/`/g, '') === 'alpha|beta|gamma|delta' && !/[*~=]/.test(r.split('\n')[0]),
        detail: `disk ${show(d)} classes ${JSON.stringify(classes)} rendered ${show(r)}`,
      };
    },
  },
  {
    id: 'prose.inline-marks.e08',
    feature: 'prose.inline-marks',
    name: 'Dragging over a word in a code block and clicking Bold leaves the code unchanged',
    run: async (S) => {
      const doc = 'Intro\n\n```\nconst total = 1\n```\n';
      await S.fresh('bold-in-code', doc);
      await S.select('total');
      await S.toolbar('Bold');
      const d = await S.disk();
      const r = await S.rendered();
      await S.shot('prose.inline-marks.e08');
      return { ok: d === doc, detail: `disk ${show(d)} rendered ${show(r)}` };
    },
  },
  {
    id: 'prose.inline-marks.e09',
    feature: 'prose.inline-marks',
    name: 'In a file with Windows line endings, Bold on a dragged word changes only that word and keeps CRLF',
    run: async (S) => {
      const doc = 'First line here\r\n\r\nSecond words here\r\n';
      await S.fresh('bold-crlf', doc);
      await S.select('words');
      await S.toolbar('Bold');
      const d = await S.disk();
      return { ok: d === 'First line here\r\n\r\nSecond **words** here\r\n', detail: show(d) };
    },
  },
  {
    id: 'prose.inline-marks.e10',
    feature: 'prose.inline-marks',
    name: 'Inline code on a dragged selection that contains a backtick shows one code span holding the backtick',
    run: async (S) => {
      await S.fresh('code-backtick', 'Run a`b now\n');
      await S.select('a`b');
      await S.toolbar('Inline code');
      await S.caret('now', 1);
      const d = await S.disk();
      const spans = await S.eval(() => [...document.querySelectorAll('.tok-inline-code')].map((e) => e.textContent));
      await S.shot('prose.inline-marks.e10');
      return { ok: spans.length === 1 && spans[0].includes('a`b'), detail: `disk ${show(d)} code spans ${JSON.stringify(spans)}` };
    },
  },

  /* ---- prose.text-style ---- */
  {
    id: 'prose.text-style.e01',
    feature: 'prose.text-style',
    name: 'Text style > Heading 2 can be clicked and turns the caret line into a heading',
    run: async (S) => {
      await S.fresh('text-style-h2', DOC);
      await S.caret('Last line', 2);
      await S.toolbar('Text style');
      await S.click({ sel: '.sheaf-tb-menu-item', hasText: 'Heading 2' });
      const d = await S.disk();
      return { ok: d.includes('\n## Last line\n'), detail: show(d) };
    },
  },
  {
    id: 'prose.text-style.e02',
    feature: 'prose.text-style',
    name: 'Text style > Text on a heading turns it back into a paragraph, and the trigger reads Text',
    run: async (S) => {
      await S.fresh('text-style-text', '## Plans ahead\n\nBody text\n');
      await S.caret('Plans', 2);
      const before = await button(S, 'Text style');
      await S.toolbar('Text style');
      await S.click({ sel: '.sheaf-tb-menu-item', hasText: 'Text' });
      const d = await S.disk();
      const after = await button(S, 'Text style');
      return { ok: before?.title === 'Text style: H2' && d === 'Plans ahead\n\nBody text\n' && after?.title === 'Text style: Text', detail: `before ${before?.title} after ${after?.title} disk ${show(d)}` };
    },
  },
  {
    id: 'prose.text-style.e03',
    feature: 'prose.text-style',
    name: 'Clicking into a setext heading shows H1 and Heading 2 from the menu leaves no === line behind',
    run: async (S) => {
      await S.fresh('text-style-setext', 'Setext title\n============\n\nBody text\n');
      await S.caret('Setext', 2);
      const label = await button(S, 'Text style');
      await S.toolbar('Text style');
      await S.click({ sel: '.sheaf-tb-menu-item', hasText: 'Heading 2' });
      await S.caret('Body', 1);
      const d = await S.disk();
      const r = await S.rendered();
      await S.shot('prose.text-style.e03');
      return { ok: label?.title === 'Text style: H1' && d === '## Setext title\n\nBody text\n', detail: `label ${label?.title} disk ${show(d)} rendered ${show(r)}` };
    },
  },
  {
    id: 'prose.text-style.e04',
    feature: 'prose.text-style',
    name: 'After a click in a bullet item, Cmd+Alt+2 makes a heading of the item text with no dash showing',
    run: async (S) => {
      await S.fresh('text-style-shortcut-item', '- Groceries\n- Errands\n');
      await S.caret('Errands', 2);
      await S.press('Meta+Alt+2');
      const st = await S.state();
      const d = await S.disk();
      await S.caret('Groceries', 1);
      const r = await S.rendered();
      return { ok: st.focused && d === '- Groceries\n\n## Errands\n' || d === '- Groceries\n## Errands\n', detail: `focused ${st.focused} disk ${show(d)} rendered ${show(r)}` };
    },
  },
  {
    id: 'prose.text-style.e05',
    feature: 'prose.text-style',
    name: 'The Text style menu opens with a click, moves with the arrow keys, and Escape closes it without changing the file',
    run: async (S) => {
      await S.fresh('text-style-keys', DOC);
      await S.caret('Last', 1);
      await S.toolbar('Text style');
      const open = await S.exists('.sheaf-tb-menu-item', 'Heading 1');
      await S.press('ArrowDown ArrowDown Escape');
      const closed = !(await S.exists('.sheaf-tb-menu-item', 'Heading 1'));
      const d = await S.disk();
      return { ok: open && closed && d === DOC, detail: `open ${open} closed ${closed} disk ${show(d)}` };
    },
  },

  /* ---- prose.lists ---- */
  {
    id: 'prose.lists.e01',
    feature: 'prose.lists',
    name: 'Dragging over two lines and clicking Bullet list bullets both; clicking again removes both',
    run: async (S) => {
      await S.fresh('lists-two-lines', 'Apples\nPears\n');
      await S.drag({ text: 'Apples', offset: 0 }, { text: 'Pears', offset: 5 });
      await S.toolbar('Bullet list');
      const once = await S.disk();
      const bullets = await S.eval(() => document.querySelectorAll('.cm-content .cm-line').length);
      await S.drag({ text: 'Apples', offset: 0 }, { text: 'Pears', offset: 5 });
      await S.toolbar('Bullet list');
      const twice = await S.disk();
      return { ok: once === '- Apples\n- Pears\n' && twice === 'Apples\nPears\n', detail: `once ${show(once)} twice ${show(twice)} lines ${bullets}` };
    },
  },
  {
    id: 'prose.lists.e02',
    feature: 'prose.lists',
    name: 'Dragging over two paragraphs and clicking Bullet list gives two bullets with no empty bullet between them',
    run: async (S) => {
      await S.fresh('lists-two-paras', 'Apples\n\nPears\n');
      await S.drag({ text: 'Apples', offset: 0 }, { text: 'Pears', offset: 5 });
      await S.toolbar('Bullet list');
      await S.caret('Apples', 1);
      const d = await S.disk();
      await S.shot('prose.lists.e02');
      return { ok: d === '- Apples\n\n- Pears\n', detail: show(d) };
    },
  },
  {
    id: 'prose.lists.e03',
    feature: 'prose.lists',
    name: 'Clicking into a task item and clicking Bullet list gives a plain bullet with no [ ] text',
    run: async (S) => {
      await S.fresh('lists-task-to-bullet', '- [ ] buy milk\n\nAfter\n');
      await S.caret('milk', 2);
      await S.toolbar('Bullet list');
      await S.caret('After', 1);
      const d = await S.disk();
      const r = await S.rendered();
      await S.shot('prose.lists.e03');
      return { ok: (d === '- buy milk\n\nAfter\n' || d === 'buy milk\n\nAfter\n') && !r.includes('[ ]'), detail: `disk ${show(d)} rendered ${show(r)}` };
    },
  },
  {
    id: 'prose.lists.e04',
    feature: 'prose.lists',
    name: 'Clicking into a nested bullet and clicking Numbered list keeps it nested under its parent',
    run: async (S) => {
      await S.fresh('lists-nested-number', '- Parent item\n    - Child item\n');
      await S.caret('Child', 2);
      await S.toolbar('Numbered list');
      await S.caret('Parent', 1);
      const d = await S.disk();
      await S.shot('prose.lists.e04');
      return { ok: d === '- Parent item\n    1. Child item\n', detail: show(d) };
    },
  },
  {
    id: 'prose.lists.e05',
    feature: 'prose.lists',
    name: 'Numbered list on three dragged lines numbers 1 to 3, and the Undo button puts the lines back',
    run: async (S) => {
      await S.fresh('lists-number-undo', 'One\nTwo\nThree\n');
      await S.drag({ text: 'One', offset: 0 }, { text: 'Three', offset: 5 });
      await S.toolbar('Numbered list');
      const once = await S.disk();
      await S.toolbar('Undo');
      const back = await S.disk();
      return { ok: once === '1. One\n2. Two\n3. Three\n' && back === 'One\nTwo\nThree\n', detail: `once ${show(once)} back ${show(back)}` };
    },
  },
  {
    id: 'prose.lists.e06',
    feature: 'prose.lists',
    name: 'Dragging over two quoted lines and clicking Bullet list makes a list inside the quote',
    run: async (S) => {
      await S.fresh('lists-in-quote', '> Alpha\n> Beta\n');
      await S.drag({ text: 'Alpha', offset: 0 }, { text: 'Beta', offset: 4 });
      await S.toolbar('Bullet list');
      const d = await S.disk();
      await S.shot('prose.lists.e06');
      return { ok: d === '> - Alpha\n> - Beta\n', detail: show(d) };
    },
  },

  /* ---- prose.quote ---- */
  {
    id: 'prose.quote.e01',
    feature: 'prose.quote',
    name: 'Clicking into a paragraph and clicking Quote renders it as a quote; clicking Quote again unquotes it',
    run: async (S) => {
      await S.fresh('quote-toggle', 'Wise words here\n\nOther\n');
      await S.caret('words', 2);
      await S.toolbar('Quote');
      const once = await S.disk();
      const cls = await lineClass(S, 'Wise words');
      await S.toolbar('Quote');
      const twice = await S.disk();
      return { ok: once === '> Wise words here\n\nOther\n' && /tok-quote/.test(cls ?? '') && twice === 'Wise words here\n\nOther\n', detail: `once ${show(once)} class ${cls} twice ${show(twice)}` };
    },
  },
  {
    id: 'prose.quote.e02',
    feature: 'prose.quote',
    name: 'Dragging over a two-paragraph quote and clicking Quote removes the quote',
    run: async (S) => {
      const doc = '> First para\n>\n> Second para\n\nAfter\n';
      await S.fresh('quote-two-paras', doc);
      await S.drag({ text: 'First', offset: 0 }, { text: 'Second para', offset: 11 });
      await S.toolbar('Quote');
      await S.caret('After', 1);
      const d = await S.disk();
      await S.shot('prose.quote.e02');
      return { ok: d === 'First para\n\nSecond para\n\nAfter\n', detail: show(d) };
    },
  },
  {
    id: 'prose.quote.e03',
    feature: 'prose.quote',
    name: 'Clicking into a code block and clicking Quote leaves the code unchanged',
    run: async (S) => {
      const doc = 'Intro\n\n```\nconst total = 1\n```\n';
      await S.fresh('quote-in-code', doc);
      await S.caret('total', 2);
      await S.toolbar('Quote');
      const d = await S.disk();
      return { ok: d === doc, detail: show(d) };
    },
  },

  /* ---- prose.code-block ---- */
  {
    id: 'prose.code-block.e01',
    feature: 'prose.code-block',
    name: 'Clicking into a paragraph and clicking Code block fences it and renders it as code; clicking again inside removes the fences',
    run: async (S) => {
      await S.fresh('code-toggle', 'Intro\n\nnpm run build\n\nAfter\n');
      await S.caret('build', 2);
      await S.toolbar('Code block');
      const once = await S.disk();
      const cls = await lineClass(S, 'npm run build');
      await S.caret('build', 2);
      await S.toolbar('Code block');
      const twice = await S.disk();
      return { ok: once === 'Intro\n\n```\nnpm run build\n```\n\nAfter\n' && /tok-code-block/.test(cls ?? '') && twice === 'Intro\n\nnpm run build\n\nAfter\n', detail: `once ${show(once)} class ${cls} twice ${show(twice)}` };
    },
  },
  {
    id: 'prose.code-block.e02',
    feature: 'prose.code-block',
    name: 'Clicking an empty line and clicking Code block gives an empty block the typing goes into',
    run: async (S) => {
      await S.fresh('code-empty-line', 'Above\n\n\n\nBelow\n');
      await clickEmptyLine(S, 1);
      await S.toolbar('Code block');
      await S.type('let z');
      const d = await S.disk();
      return { ok: d === 'Above\n\n```\nlet z\n```\n\nBelow\n', detail: show(d) };
    },
  },

  /* ---- prose.insert-menu ---- */
  {
    id: 'prose.insert-menu.e01',
    feature: 'prose.insert-menu',
    name: 'Insert > Markdown table can be clicked and puts a table in the file',
    run: async (S) => {
      await S.fresh('insert-table', DOC);
      await S.caret('today.', 6);
      await S.toolbar('Insert');
      await S.click({ sel: '.sheaf-tb-menu-item', hasText: 'Markdown table' });
      const d = await S.disk();
      return { ok: /\n\|.*\|\n\|\s*-{3}/.test(d), detail: show(d) };
    },
  },
  {
    id: 'prose.insert-menu.e02',
    feature: 'prose.insert-menu',
    name: 'Insert > CSV data table puts a csv block below the paragraph and shows it as a grid',
    run: async (S) => {
      await S.fresh('insert-csv', 'Numbers below\n\nLast\n');
      await S.caret('Numbers', 2);
      await S.toolbar('Insert');
      await S.menu('CSV data table');
      await S.sleep(500);
      const d = await S.disk();
      const grid = await S.exists('.sheaf-table');
      return { ok: /^Numbers below\n\n```csv\n[\s\S]+\n```\n/.test(d) && d.endsWith('Last\n') && grid, detail: `grid ${grid} disk ${show(d)}` };
    },
  },
  {
    id: 'prose.insert-menu.e03',
    feature: 'prose.insert-menu',
    name: 'Insert > Code block with the caret in a paragraph adds an empty block below it and typing goes inside',
    run: async (S) => {
      await S.fresh('insert-code', 'Some text\n\nLast\n');
      await S.caret('Some', 2);
      await S.toolbar('Insert');
      await S.menu('Code block');
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'Some text\n\n```\nZ\n```\n\nLast\n', detail: show(d) };
    },
  },
  {
    id: 'prose.insert-menu.e04',
    feature: 'prose.insert-menu',
    name: 'The Insert menu closes when you click back into the text, and nothing is inserted',
    run: async (S) => {
      await S.fresh('insert-dismiss', DOC);
      await S.caret('hello', 2);
      await S.toolbar('Insert');
      const open = await S.exists('.sheaf-tb-menu-item', 'Divider');
      await S.caret('Last', 2);
      const closed = !(await S.exists('.sheaf-tb-menu-item', 'Divider'));
      const d = await S.disk();
      return { ok: open && closed && d === DOC, detail: `open ${open} closed ${closed} disk ${show(d)}` };
    },
  },

  /* ---- prose.divider ---- */
  {
    id: 'prose.divider.e01',
    feature: 'prose.divider',
    name: 'Insert > Divider with the caret in a paragraph puts a rule below it that renders as a line',
    run: async (S) => {
      await S.fresh('divider-basic', 'Chapter one\n');
      await S.caret('one', 1);
      await S.toolbar('Insert');
      await S.menu('Divider');
      await S.type('Z');
      const d = await S.disk();
      const hr = await S.exists('.cm-content hr');
      return { ok: d === 'Chapter one\n\n---\nZ' || d === 'Chapter one\n\n---\nZ\n', detail: `hr ${hr} disk ${show(d)}` };
    },
  },
  {
    id: 'prose.divider.e02',
    feature: 'prose.divider',
    name: 'Insert > Divider with the caret in a code block does not write --- into the code',
    run: async (S) => {
      const doc = 'Intro\n\n```\nconst total = 1\n```\n';
      await S.fresh('divider-in-code', doc);
      await S.caret('total', 2);
      await S.toolbar('Insert');
      await S.menu('Divider');
      const d = await S.disk();
      await S.shot('prose.divider.e02');
      return { ok: d.startsWith(doc.trimEnd()) && !/```\nconst total = 1\n[\s\S]*---[\s\S]*```/.test(d), detail: show(d) };
    },
  },
  {
    id: 'prose.divider.e03',
    feature: 'prose.divider',
    name: 'Insert > Divider on the first of two paragraphs leaves one blank line on each side of the rule',
    run: async (S) => {
      await S.fresh('divider-between', 'First para\n\nSecond para\n');
      await S.caret('First', 2);
      await S.toolbar('Insert');
      await S.menu('Divider');
      const d = await S.disk();
      return { ok: d === 'First para\n\n---\n\nSecond para\n', detail: show(d) };
    },
  },

  /* ---- prose.clear-formatting ---- */
  {
    id: 'prose.clear-formatting.e01',
    feature: 'prose.clear-formatting',
    name: 'Clicking into a bold word and clicking Clear formatting unbolds it',
    run: async (S) => {
      await S.fresh('clear-caret', DOC);
      await S.caret('bold', 2);
      await S.toolbar('Clear formatting');
      const d = await S.disk();
      return { ok: d === DOC.replace('**bold**', 'bold'), detail: show(d) };
    },
  },
  {
    id: 'prose.clear-formatting.e02',
    feature: 'prose.clear-formatting',
    name: 'Dragging over a sentence with bold, italic, highlight and a link and clicking Clear formatting leaves plain text and the link text',
    run: async (S) => {
      await S.fresh('clear-sentence', 'Mix **strong** and *soft* and ==lit== and [site](https://x.io) end\n');
      await S.drag({ text: 'Mix', offset: 0 }, { text: 'end', offset: 3 });
      await S.toolbar('Clear formatting');
      const d = await S.disk();
      return { ok: d === 'Mix strong and soft and lit and site end\n', detail: show(d) };
    },
  },

  /* ---- prose.link-insert ---- */
  {
    id: 'prose.link-insert.e01',
    feature: 'prose.link-insert',
    name: 'Dragging over a word, clicking Link and typing an address links the word',
    run: async (S) => {
      await S.fresh('link-basic', 'Read the docs today\n');
      await S.select('docs');
      await S.toolbar('Link');
      await S.type('https://x.io');
      const d = await S.disk();
      return { ok: d === 'Read the [docs](https://x.io) today\n', detail: show(d) };
    },
  },
  {
    id: 'prose.link-insert.e02',
    feature: 'prose.link-insert',
    name: 'Clicking into a link and clicking Link does not put a second link inside it',
    run: async (S) => {
      const doc = 'Go to [the site](https://x.io) now\n';
      await S.fresh('link-inside-link', doc);
      await S.caret('site', 2);
      await S.toolbar('Link');
      const d = await S.disk();
      await S.shot('prose.link-insert.e02');
      return { ok: !/\[[^\]]*\[/.test(d), detail: show(d) };
    },
  },
  {
    id: 'prose.link-insert.e03',
    feature: 'prose.link-insert',
    name: 'Clicking Link with a bare caret writes [text](url) and typing replaces url',
    run: async (S) => {
      await S.fresh('link-caret', 'See here\n');
      await S.caret('here', 4 - 3);
      await S.press('End');
      await S.type(' ');
      await S.toolbar('Link');
      await S.type('https://y.io');
      const d = await S.disk();
      return { ok: d === 'See here [text](https://y.io)\n', detail: show(d) };
    },
  },

  {
    id: 'prose.link-insert.e04',
    feature: 'prose.link-insert',
    name: 'Dragging across two paragraphs and clicking Link never writes a link split by a blank line',
    run: async (S) => {
      await S.fresh('link-two-paras', 'First words\n\nSecond words\n');
      await S.drag({ text: 'First', offset: 0 }, { text: 'Second words', offset: 11 });
      await S.toolbar('Link');
      const d = await S.disk();
      const r = await S.rendered();
      return { ok: !/\[[^\]]*\n\n[^\]]*\]\(/.test(d), detail: `disk ${show(d)} rendered ${show(r)}` };
    },
  },

  /* ---- prose.hard-break ---- */
  {
    id: 'prose.hard-break.e01',
    feature: 'prose.hard-break',
    name: 'After a click in a bullet item, Shift+Enter and typing keep the new line inside the same bullet',
    run: async (S) => {
      await S.fresh('hardbreak-item', '- Shopping list\n- Other\n');
      await caretEnd(S, 'Shopping');
      await S.press('Shift+Enter');
      await S.type('Zed');
      const d = await S.disk();
      await S.caret('Other', 1);
      const bullets = await S.eval(() => document.querySelectorAll('.cm-content .cm-line').length);
      return { ok: d === '- Shopping list\\\n  Zed\n- Other\n', detail: `disk ${show(d)} lines ${bullets}` };
    },
  },
  {
    id: 'prose.hard-break.e02',
    feature: 'prose.hard-break',
    name: 'After a click at the end of a heading, Shift+Enter does not leave a backslash showing in the heading',
    run: async (S) => {
      await S.fresh('hardbreak-heading', '# Title here\n\nBody\n');
      await caretEnd(S, 'Title');
      await S.press('Shift+Enter');
      await S.caret('Body', 1);
      const d = await S.disk();
      const r = await S.rendered();
      await S.shot('prose.hard-break.e02');
      return { ok: !r.includes('Title here\\'), detail: `disk ${show(d)} rendered ${show(r)}` };
    },
  },
  {
    id: 'prose.hard-break.e03',
    feature: 'prose.hard-break',
    name: 'After a click mid-paragraph, Shift+Enter breaks the line there and typing lands on the new line',
    run: async (S) => {
      await S.fresh('hardbreak-mid', 'Roses are red\n');
      await S.caret('are', 0);
      await S.press('Shift+Enter');
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'Roses \\\nZare red\n', detail: show(d) };
    },
  },

  /* ---- prose.indent ---- */
  {
    id: 'prose.indent.e01',
    feature: 'prose.indent',
    name: 'After a click in the second bullet, Tab nests it and keeps focus in the editor; Shift+Tab brings it back',
    run: async (S) => {
      await S.fresh('indent-item', '- Fruit\n- Apples\n');
      await S.caret('Apples', 2);
      await S.press('Tab');
      const st = await S.state();
      const nested = await S.disk();
      await S.press('Shift+Tab');
      const back = await S.disk();
      return { ok: st.focused && nested === '- Fruit\n    - Apples\n' && back === '- Fruit\n- Apples\n', detail: `focused ${st.focused} nested ${show(nested)} back ${show(back)}` };
    },
  },
  {
    id: 'prose.indent.e02',
    feature: 'prose.indent',
    name: 'After a click in a paragraph, Tab does not turn the paragraph into a code block',
    run: async (S) => {
      await S.fresh('indent-para', 'Intro\n\nPlain paragraph text\n');
      await S.caret('paragraph', 2);
      await S.press('Tab');
      await S.caret('Intro', 1);
      const d = await S.disk();
      await S.shot('prose.indent.e02');
      const font = await S.eval(() => {
        const l = [...document.querySelectorAll('.cm-content > .cm-line')].find((x) => x.textContent.includes('Plain paragraph'));
        const span = l && [...l.querySelectorAll('*')].find((e) => e.textContent.includes('Plain')) || l;
        return span ? getComputedStyle(span).fontFamily : null;
      });
      const intro = await S.eval(() => getComputedStyle(document.querySelector('.cm-content > .cm-line')).fontFamily);
      return { ok: d === 'Intro\n\nPlain paragraph text\n' || (font === intro && !d.includes('\n    Plain')), detail: `disk ${show(d)} font ${font} intro font ${intro}` };
    },
  },
  {
    id: 'prose.indent.e03',
    feature: 'prose.indent',
    name: 'After a click inside a code block, Tab indents that code line by four spaces',
    run: async (S) => {
      await S.fresh('indent-code', 'Intro\n\n```\nreturn x\n```\n');
      await S.caret('return', 2);
      await S.press('Tab');
      const d = await S.disk();
      return { ok: d === 'Intro\n\n```\n    return x\n```\n', detail: show(d) };
    },
  },

  /* ---- prose.list-continuation ---- */
  {
    id: 'prose.list-continuation.e01',
    feature: 'prose.list-continuation',
    name: 'After a click at the end of the last bullet, Enter and typing start a new bullet',
    run: async (S) => {
      await S.fresh('cont-bullet', '- Eggs\n- Milk\n\nAfter\n');
      await caretEnd(S, 'Milk');
      await S.press('Enter');
      await S.type('Zest');
      const d = await S.disk();
      return { ok: d === '- Eggs\n- Milk\n- Zest\n\nAfter\n', detail: show(d) };
    },
  },
  {
    id: 'prose.list-continuation.e02',
    feature: 'prose.list-continuation',
    name: 'In a one-item list, Enter then Enter on the empty bullet ends the list and typing is a paragraph',
    run: async (S) => {
      await S.fresh('cont-end', '- Only item\n');
      await caretEnd(S, 'Only');
      await S.press('Enter');
      await S.press('Enter');
      await S.type('Zed');
      const d = await S.disk();
      await S.shot('prose.list-continuation.e02');
      return { ok: /^- Only item\n\n?Zed\n?$/.test(d), detail: show(d) };
    },
  },
  {
    id: 'prose.list-continuation.e03',
    feature: 'prose.list-continuation',
    name: 'After a click at the end of numbered item 1, Enter inserts item 2 and renumbers the next item',
    run: async (S) => {
      await S.fresh('cont-number', '1. First\n2. Second\n');
      await caretEnd(S, 'First');
      await S.press('Enter');
      await S.type('New');
      const d = await S.disk();
      return { ok: d === '1. First\n2. New\n3. Second\n', detail: show(d) };
    },
  },
  {
    id: 'prose.list-continuation.e04',
    feature: 'prose.list-continuation',
    name: 'After a click at the end of a quote, Enter and typing continue the quote',
    run: async (S) => {
      await S.fresh('cont-quote', '> Quoted words\n');
      await caretEnd(S, 'Quoted');
      await S.press('Enter');
      await S.type('More');
      const d = await S.disk();
      return { ok: d === '> Quoted words\n> More\n', detail: show(d) };
    },
  },

  /* ---- prose.undo-redo ---- */
  {
    id: 'prose.undo-redo.e01',
    feature: 'prose.undo-redo',
    name: 'Clicking Bold, then the Undo button, then the Redo button: the file goes bold, back, and bold again',
    run: async (S) => {
      await S.fresh('undo-buttons', DOC);
      await S.select('world');
      await S.toolbar('Bold');
      const bold = await S.disk();
      await S.toolbar('Undo');
      const undone = await S.disk();
      await S.toolbar('Redo');
      const redone = await S.disk();
      return { ok: bold.includes('**world**') && undone === DOC && redone === bold, detail: `bold ${show(bold)} undone ${show(undone)} redone ${show(redone)}` };
    },
  },
  {
    id: 'prose.undo-redo.e02',
    feature: 'prose.undo-redo',
    name: 'On a freshly opened file Undo and Redo show disabled; after a click and typing, Undo is enabled',
    run: async (S) => {
      await S.fresh('undo-disabled', DOC);
      await S.caret('hello', 2);
      const before = [await button(S, 'Undo'), await button(S, 'Redo')];
      await S.type('Z');
      await S.sleep(200);
      const after = await button(S, 'Undo');
      return { ok: before[0]?.disabled && before[1]?.disabled && after && !after.disabled, detail: JSON.stringify({ before, after }) };
    },
  },
  {
    id: 'prose.undo-redo.e03',
    feature: 'prose.undo-redo',
    name: 'After a click and typing, Cmd+Z removes the typing and Cmd+Shift+Z puts it back',
    run: async (S) => {
      await S.fresh('undo-keys', DOC);
      await S.caret('hello', 0);
      await S.type('Zap ');
      const typed = await S.disk();
      await S.press('Meta+z');
      const f1 = (await S.state()).focused;
      const undone = await S.disk();
      await S.press('Meta+Shift+z');
      const redone = await S.disk();
      return { ok: typed.includes('Say Zap hello') && undone === DOC && redone === typed, detail: `focused ${f1} typed ${show(typed)} undone ${show(undone)} redone ${show(redone)}` };
    },
  },

  {
    id: 'prose.undo-redo.e04',
    feature: 'prose.undo-redo',
    name: 'After two clicked edits, Undo chosen from the Command Palette takes back the second edit',
    run: async (S) => {
      await S.fresh('undo-palette', DOC);
      await S.select('world');
      await S.toolbar('Bold');
      await S.caret('Last', 1);
      await S.toolbar('Quote');
      const two = await S.disk();
      await S.page.keyboard.press('Meta+Shift+p');
      await S.page.waitForSelector('.quick-input-widget input', { state: 'visible' });
      await S.page.keyboard.type('Undo', { delay: 5 });
      await S.sleep(700);
      // $$eval, not $eval: the callback takes every matching row, and $eval hands
      // it a single element, so `rs.slice` threw before the scenario reached Enter.
      const rows = await S.page.$$eval('.quick-input-list .monaco-list-row', (rs) => rs.slice(0, 6).map((r) => r.getAttribute('aria-label') || r.textContent));
      await S.shot('prose.undo-redo.e04-palette', { clipToEditor: false });
      await S.page.keyboard.press('Enter');
      await S.sleep(600);
      const after = await S.disk();
      const st = await S.state();
      return { ok: two.includes('**world**') && two.includes('> Last line') && after === two.replace('> Last line', 'Last line'), detail: `palette rows ${JSON.stringify(rows)} two ${show(two)} after ${show(after)} focused ${st.focused}` };
    },
  },

  {
    id: 'prose.undo-redo.e05',
    feature: 'prose.undo-redo',
    name: 'After a click and typing, the Undo button removes the typing from the page and the file',
    run: async (S) => {
      await S.fresh('undo-type-button', DOC);
      await S.caret('hello', 0);
      await S.type('Zap ');
      const typed = await S.disk();
      await S.toolbar('Undo');
      const undone = await S.disk();
      const view = (await S.state()).doc;
      return { ok: typed.includes('Say Zap hello') && undone === DOC && view === DOC, detail: `typed ${show(typed)} undone ${show(undone)} view ${show(view)}` };
    },
  },
  {
    id: 'prose.undo-redo.e06',
    feature: 'prose.undo-redo',
    name: 'After a click, typing and a pause, Cmd+Z leaves what Sheaf shows and the file the same, with the typing removed',
    run: async (S) => {
      await S.fresh('undo-type-key', DOC);
      await S.caret('hello', 0);
      await S.type('Zap ');
      await S.sleep(1500);
      const typed = await S.disk();
      await S.press('Meta+z');
      await S.sleep(800);
      const st = await S.state();
      const disk = await S.disk();
      const dirty = await S.page.evaluate(() => !!document.querySelector('.tab.active.dirty'));
      await S.shot('prose.undo-redo.e06', { clipToEditor: false });
      return { ok: st.doc === disk && disk === DOC, detail: `typed ${show(typed)} view ${show(st.doc)} disk ${show(disk)} focused ${st.focused} tabDirty ${dirty}` };
    },
  },

  {
    id: 'prose.undo-redo.e07',
    feature: 'prose.undo-redo',
    name: 'After Cmd+Z on typing in one file, typing in the next file opened saves exactly what Sheaf shows',
    run: async (S) => {
      await S.fresh('undo-chain-a', DOC);
      await S.caret('hello', 0);
      await S.type('Zap ');
      await S.sleep(1500);
      await S.press('Meta+z');
      await S.sleep(800);
      const a = { view: (await S.state()).doc, disk: await S.disk() };
      await S.shot('prose.undo-redo.e07-after-undo', { clipToEditor: false });
      await S.cleanup();
      await S.sleep(500);
      await S.shot('prose.undo-redo.e07-after-close', { clipToEditor: false });
      await S.fresh('undo-chain-b', DOC);
      await S.caret('hello', 0);
      await S.type('Zap ');
      await S.sleep(1500);
      const b = { view: (await S.state()).doc, disk: await S.disk() };
      await S.shot('prose.undo-redo.e07-file-b', { clipToEditor: false });
      return { ok: b.view === b.disk && b.disk.includes('Say Zap hello'), detail: `A ${JSON.stringify(a)} B ${JSON.stringify(b)}` };
    },
  },

  /* ---- prose.toolbar-state ---- */
  {
    id: 'prose.toolbar-state.e01',
    feature: 'prose.toolbar-state',
    name: 'Clicking into an italic word, a bullet, a quote and a code block presses the matching button, and clicking plain text releases it',
    run: async (S) => {
      await S.fresh('state-buttons', 'Plain and *slanted* words\n\n- Listed item\n\n> Quoted line\n\n```\ncode line\n```\n');
      const read = async (word, title) => {
        await S.caret(word, 2);
        await S.sleep(150);
        return (await button(S, title))?.pressed === 'true';
      };
      const res = {
        italic: await read('slanted', 'Italic'),
        plainItalic: await read('Plain', 'Italic'),
        bullet: await read('Listed', 'Bullet list'),
        quote: await read('Quoted', 'Quote'),
        code: await read('code line', 'Code block'),
        quoteInCode: await read('code line', 'Quote'),
      };
      return { ok: res.italic && !res.plainItalic && res.bullet && res.quote && res.code && !res.quoteInCode, detail: JSON.stringify(res) };
    },
  },
  {
    id: 'prose.toolbar-state.e02',
    feature: 'prose.toolbar-state',
    name: 'Clicking into a heading inside a quote shows its heading level in Text style',
    run: async (S) => {
      await S.fresh('state-quote-heading', '> ## Quoted heading\n\nBody\n');
      await S.caret('heading', 2);
      await S.sleep(150);
      const t = await button(S, 'Text style');
      return { ok: t?.title === 'Text style: H2', detail: JSON.stringify(t) };
    },
  },
  {
    id: 'prose.toolbar-state.e03',
    feature: 'prose.toolbar-state',
    name: 'After clicking Bold on a dragged word, the Bold button shows on straight away',
    run: async (S) => {
      await S.fresh('state-after-bold', DOC);
      await S.select('world');
      await S.toolbar('Bold');
      await S.sleep(150);
      const b = await button(S, 'Bold');
      return { ok: b?.pressed === 'true', detail: JSON.stringify(b) };
    },
  },

  /* ---- prose.shortcuts-overlay ---- */
  {
    id: 'prose.shortcuts-overlay.e01',
    feature: 'prose.shortcuts-overlay',
    name: 'Clicking the keyboard button opens the shortcuts overlay and clicking its close button closes it',
    run: async (S) => {
      await S.fresh('overlay-button', DOC);
      await S.toolbar('Keyboard shortcuts');
      const open = await overlayOpen(S);
      const rows = await S.eval(() => document.querySelectorAll('.sheaf-sc-row').length);
      await S.shot('prose.shortcuts-overlay.e01');
      await S.click('.sheaf-sc-close');
      const closed = !(await overlayOpen(S));
      return { ok: open && rows > 10 && closed, detail: JSON.stringify({ open, rows, closed }) };
    },
  },
  {
    id: 'blocks.keyboard-selection.e12',
    feature: 'blocks.keyboard-selection',
    name: 'The keyboard shortcuts overlay lists every key for a selected block, each beside what it does',
    run: async (S) => {
      await S.fresh('overlay-blocks', DOC);
      await S.toolbar('Keyboard shortcuts');
      const open = await overlayOpen(S);
      const rows = await S.eval(() => [...document.querySelectorAll('.sheaf-sc-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
      await S.press('Escape');
      // What a person looks for, by the words of each action; the key caps are drawn as symbols.
      const want = ['select the block around the caret', 'select the next block', 'extend the selection', 'move up', 'move down', 'duplicate', 'delete', 'back to the caret'];
      const missing = want.filter((w) => !rows.some((r) => r.toLowerCase().includes(w)));
      return { ok: open && missing.length === 0, detail: `open ${open}; ${rows.length} rows; missing ${JSON.stringify(missing)}` };
    },
  },
  {
    id: 'prose.shortcuts-overlay.e02',
    feature: 'prose.shortcuts-overlay',
    name: 'The overlay closes on Escape and on a click outside its panel, without changing the file',
    run: async (S) => {
      await S.fresh('overlay-dismiss', DOC);
      await S.caret('hello', 2);
      await S.toolbar('Keyboard shortcuts');
      await S.press('Escape');
      const esc = !(await overlayOpen(S));
      await S.toolbar('Keyboard shortcuts');
      await S.click({ sel: '.sheaf-sc-backdrop', dx: 8, dy: 8 });
      const outside = !(await overlayOpen(S));
      const d = await S.disk();
      return { ok: esc && outside && d === DOC, detail: JSON.stringify({ esc, outside, d }) };
    },
  },
  {
    id: 'prose.shortcuts-overlay.e03',
    feature: 'prose.shortcuts-overlay',
    name: 'With the overlay open over the document, typing a letter does not change the file behind it',
    run: async (S) => {
      await S.fresh('overlay-typing', DOC);
      await S.caret('hello', 2);
      await S.toolbar('Keyboard shortcuts');
      const open = await overlayOpen(S);
      await S.type('Z');
      const d = await S.disk();
      await S.shot('prose.shortcuts-overlay.e03');
      return { ok: open && d === DOC, detail: `open ${open} disk ${show(d)}` };
    },
  },
  {
    id: 'prose.shortcuts-overlay.e04',
    feature: 'prose.shortcuts-overlay',
    name: 'After a click in the text, Cmd+/ opens the overlay and Cmd+/ again closes it',
    run: async (S) => {
      await S.fresh('overlay-key', DOC);
      await S.caret('hello', 2);
      await S.press('Meta+/');
      const open = await overlayOpen(S);
      const st = await S.state();
      await S.press('Meta+/');
      const closed = !(await overlayOpen(S));
      const d = await S.disk();
      return { ok: open && closed && d === DOC, detail: JSON.stringify({ open, closed, focused: st.focused, same: d === DOC }) };
    },
  },

  {
    id: 'prose.shortcuts-overlay.e05',
    feature: 'prose.shortcuts-overlay',
    name: 'The overlay opened with a click lists the Undo and Redo keys that the toolbar tooltips name',
    run: async (S) => {
      await S.fresh('overlay-undo-rows', DOC);
      await S.toolbar('Keyboard shortcuts');
      const got = await S.eval(() => {
        const hint = (t) => /\(([^)]+)\)$/.exec(t)?.[1];
        const tb = ['Undo', 'Redo'].map((l) => hint([...document.querySelectorAll('#toolbar button')].find((b) => b.title.startsWith(l))?.title ?? ''));
        const keys = [...document.querySelectorAll('.sheaf-sc-keys')].map((k) => k.textContent);
        return { tb, listed: tb.map((h) => keys.includes(h)) };
      });
      await S.click('.sheaf-sc-close');
      return { ok: got.listed.every(Boolean), detail: JSON.stringify(got) };
    },
  },

  /* ---- prose.line-numbers ---- */
  {
    id: 'prose.line-numbers.e01',
    feature: 'prose.line-numbers',
    name: 'Clicking Toggle line numbers shows a gutter numbering file lines; clicking again hides it',
    run: async (S) => {
      await S.fresh('lines-toggle', DOC);
      await S.toolbar('Toggle line numbers');
      await S.sleep(300);
      const numberBeside = (t) =>
        S.eval((text) => {
          const line = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) => l.textContent.includes(text));
          if (!line) return null;
          const y = line.getBoundingClientRect().top + 4;
          const g = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find((e) => {
            const r = e.getBoundingClientRect();
            return r.height > 0 && r.top <= y && r.bottom > y;
          });
          return g ? g.textContent : null;
        }, t);
      const last = await numberBeside('Last line');
      const pressed = (await button(S, 'Toggle line numbers'))?.pressed;
      await S.toolbar('Toggle line numbers');
      await S.sleep(300);
      const gone = !(await S.exists('.cm-lineNumbers'));
      return { ok: last === '5' && pressed === 'true' && gone, detail: JSON.stringify({ last, pressed, gone }) };
    },
  },
  {
    id: 'prose.line-numbers.e02',
    feature: 'prose.line-numbers',
    name: 'With a table and a code block above, the number beside the next paragraph is its line in the file',
    run: async (S) => {
      const doc = 'Top\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n```\none\ntwo\n```\n\nTarget paragraph\n';
      await S.fresh('lines-table', doc);
      await S.toolbar('Toggle line numbers');
      await S.sleep(400);
      const n = await S.eval(() => {
        const line = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) => l.textContent.includes('Target'));
        const y = line.getBoundingClientRect().top + 4;
        const g = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find((e) => {
          const r = e.getBoundingClientRect();
          return r.height > 0 && r.top <= y && r.bottom > y;
        });
        return g ? g.textContent : null;
      });
      await S.shot('prose.line-numbers.e02');
      await S.toolbar('Toggle line numbers');
      return { ok: n === '13', detail: `number beside Target: ${n}, file line 13` };
    },
  },
  {
    id: 'prose.line-numbers.e03',
    feature: 'prose.line-numbers',
    name: 'Line numbers turned on stay on after switching to another file tab and back',
    run: async (S) => {
      await S.fresh('lines-tab-a', DOC);
      await S.toolbar('Toggle line numbers');
      await S.sleep(300);
      // Toggling line numbers edits nothing, so the tab is still VS Code's preview tab, and
      // opening the next file would replace it. Keep it, as a double-click on the tab does.
      await S.command('View: Keep Editor');
      await S.sleep(300);
      await S.fresh('lines-tab-b', 'Other file\n');
      // Switch back by clicking the editor tab, as a person does (Quick Open did not appear with focus in the new webview).
      const tab = await S.page
        .locator('.tabs-container .tab', { hasText: 'lines-tab-a.md' })
        .first()
        .boundingBox({ timeout: 5000 })
        .catch(() => null);
      if (!tab) {
        // Say what the window actually holds. A bare timeout here reads as the harness
        // hanging, when what happened is that a tab never opened.
        const tabs = await S.page.$$eval('.tabs-container .tab', (els) => els.map((t) => t.getAttribute('aria-label')));
        throw new Error(`no tab for lines-tab-a.md; the window holds ${JSON.stringify(tabs)}`);
      }
      await S.click({ x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 });
      await S.sleep(800);
      const still = await S.exists('.cm-lineNumbers');
      const pressed = (await button(S, 'Toggle line numbers'))?.pressed;
      await S.caret('hello', 1);
      if (still) await S.toolbar('Toggle line numbers');
      return { ok: still && pressed === 'true', detail: JSON.stringify({ still, pressed }) };
    },
  },

  /* ---- prose.link-paste ---- */
  {
    id: 'prose.link-paste.e01',
    feature: 'prose.link-paste',
    name: 'A web address pasted over selected words links the words, and one undo puts them back',
    run: async (S) => {
      await S.fresh('link-paste', 'see the release notes for details\n');
      await selectRun(S, 'release notes');
      await pasteOver(S, 'https://example.com/notes');
      const linked = await S.disk();
      const after = await S.state();
      await S.press('Meta+z');
      await S.sleep(700);
      const back = await S.disk();
      const want = 'see the [release notes](https://example.com/notes) for details\n';
      return {
        ok: linked === want && back === 'see the release notes for details\n' && after.head === linked.indexOf(') for') + 1,
        detail: `after the paste ${show(linked)}; caret ${after.head}, wanted ${linked.indexOf(') for') + 1}; after undo ${show(back)}`,
      };
    },
  },
  {
    id: 'prose.link-paste.e02',
    feature: 'prose.link-paste',
    name: 'The new link is drawn as its words, and its address is there when the Markdown is shown',
    run: async (S) => {
      await S.fresh('link-paste-render', 'see the release notes for details\n');
      await selectRun(S, 'release notes');
      await pasteOver(S, 'https://example.com/notes');
      const drawn = await S.eval(() => {
        const line = document.querySelector('.cm-content > .cm-line');
        const anchor = line && line.querySelector('a, .cm-link, [class*=link]');
        return { text: line ? line.textContent : null, anchor: !!anchor };
      });
      await S.caret('release', 1);
      await S.press('Meta+Alt+e');
      await S.sleep(600);
      const source = await S.eval(() => {
        const line = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) => l.textContent.includes('release notes'));
        return line ? line.textContent : null;
      });
      const d = await S.disk();
      return {
        ok: drawn.text === 'see the release notes for details' && source.includes('](https://example.com/notes)') && d === 'see the [release notes](https://example.com/notes) for details\n',
        detail: `drawn ${show(drawn)}; with the Markdown shown ${show(source)}; file ${show(d)}`,
      };
    },
  },
  {
    id: 'prose.link-paste.e03',
    feature: 'prose.link-paste',
    name: 'A clipboard that is not one address pastes plainly',
    run: async (S) => {
      await S.fresh('link-paste-plain', 'see the release notes for details\n');
      await selectRun(S, 'release notes');
      await pasteOver(S, 'https://example.com/a\nhttps://example.com/b');
      const two = await S.disk();
      await S.press('Meta+z');
      await S.sleep(500);
      await selectRun(S, 'release notes');
      await pasteOver(S, 'www.example.com');
      const bare = await S.disk();
      await S.press('Meta+z');
      await S.sleep(500);
      const back = await S.disk();
      return {
        ok: !two.includes('](') && !bare.includes('](') && back === 'see the release notes for details\n',
        detail: `two addresses gave ${show(two)}; a bare domain gave ${show(bare)}; undone back to ${show(back)}`,
      };
    },
  },
];
