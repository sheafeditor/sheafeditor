// Unit scenarios for rendering: what a person reads once the live-preview
// decorations are laid over the Markdown. Each asserts what should be true; a
// failing scenario is a bug candidate, drafted under bugs/render--<slug>.md.
import { EditorSelection } from '@codemirror/state';
import { mountProse } from '../../harness';
import { setLivePreviewConfig, setReveal, revealField } from '../../../src/webview/livePreview';
import { toggleBlockReveal } from '../../../src/webview/revealBlock';
import { blockSelectionOf } from '../../../src/webview/blockModel';

type Result = boolean | { ok: boolean; detail?: string };
interface Scenario {
  id: string;
  feature: string;
  name: string;
  run: () => Result | Promise<Result>;
}
type P = ReturnType<typeof mountProse>;

const j = (x: unknown): string => JSON.stringify(x);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mount with the shipped default (reveal-on-line off) unless asked otherwise. */
function mount(doc: string, revealSyntaxOnLine = false): P {
  setLivePreviewConfig({ revealSyntaxOnLine });
  const p = mountProse(doc);
  // A caret at the very end, outside any block under test, the way a freshly opened file has none in it.
  return p;
}

/** Run `fn` against a mounted doc and always destroy it. */
function withDoc(doc: string, fn: (p: P) => Result, reveal = false): Result {
  const p = mount(doc, reveal);
  try {
    return fn(p);
  } finally {
    p.destroy();
    setLivePreviewConfig({ revealSyntaxOnLine: false });
  }
}

const lines = (p: P): HTMLElement[] => [...p.view.contentDOM.querySelectorAll(':scope > .cm-line')] as HTMLElement[];
const text = (p: P): string => lines(p).map((l) => l.textContent).join('\n');
/** The rendered text of document line n (1-based), found through CodeMirror's own position map. */
function lineEl(p: P, n: number): HTMLElement | null {
  const pos = p.view.state.doc.line(n).from;
  let node: Node | null = p.view.domAtPos(pos).node;
  while (node && !(node instanceof HTMLElement && node.classList.contains('cm-line'))) node = node.parentNode;
  return node as HTMLElement | null;
}
const lineText = (p: P, n: number): string => lineEl(p, n)?.textContent ?? '<not rendered>';
const lineHas = (p: P, n: number, cls: string): boolean => !!lineEl(p, n)?.classList.contains(cls);
const within = (p: P, sel: string): string[] => [...p.view.contentDOM.querySelectorAll(sel)].map((e) => e.textContent ?? '');
const check = (ok: boolean, detail: unknown): Result => ({ ok, detail: ok ? '' : typeof detail === 'string' ? detail : j(detail) });

/** Load a sample fixture from the checkout under test (the bundle runs in Node, so the fs module is reachable). */
function fixture(rel: string): string {
  const fs = (globalThis as any).process.getBuiltinModule('fs');
  const path = (globalThis as any).process.getBuiltinModule('path');
  return fs.readFileSync(path.join(eval('process').env.SHEAF_REPO, 'sample', rel), 'utf8');
}
declare const __dirname: string;

/** Press the mouse on the nth task checkbox, as a click does. */
function pressCheckbox(p: P, nth: number): boolean {
  const box = p.view.contentDOM.querySelectorAll('input.md-task')[nth] as HTMLInputElement | undefined;
  if (!box) return false;
  box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  return true;
}

/** Type text at the caret the way a keystroke does (a user input transaction). */
function typeAt(p: P, pos: number, s: string): void {
  p.view.dispatch({ changes: { from: pos, insert: s }, selection: { anchor: pos + s.length }, userEvent: 'input.type' });
}

export const scenarios: Scenario[] = [
  // ---------------------------------------------------------------- inline marks
  {
    id: 'render.inline-marks.u01',
    feature: 'render.inline-marks',
    name: 'Bold, italic, strikethrough and highlight show their words with every marker hidden',
    run: () =>
      withDoc('x\n\nA **bold** and *it* and _un_ and ~~gone~~ and ==hi== end', (p) => {
        const t = lineText(p, 3);
        const ok = t === 'A bold and it and un and gone and hi end' && within(p, '.tok-strong').join() === 'bold' && within(p, '.tok-em').join() === 'it,un' && within(p, '.tok-strike').join() === 'gone' && within(p, '.tok-highlight').join() === 'hi';
        return check(ok, { t, strong: within(p, '.tok-strong'), em: within(p, '.tok-em') });
      }),
  },
  {
    id: 'render.inline-marks.u02',
    feature: 'render.inline-marks',
    name: 'Inline code shows the code in a code chip with its backticks hidden',
    run: () =>
      withDoc('x\n\nRun `npm test` now', (p) => {
        const t = lineText(p, 3);
        return check(t === 'Run npm test now' && within(p, '.tok-inline-code').some((c) => c.includes('npm test')), { t, chips: within(p, '.tok-inline-code') });
      }),
  },
  {
    id: 'render.inline-marks.u03',
    feature: 'render.inline-marks',
    name: 'Nested and triple emphasis show only the words',
    run: () =>
      withDoc('x\n\n***triple*** and *a **b** c* and **a *b* c**', (p) => {
        const t = lineText(p, 3);
        return check(t === 'triple and a b c and a b c', t);
      }),
  },
  {
    id: 'render.inline-marks.u04',
    feature: 'render.inline-marks',
    name: 'Unmatched and intraword markers stay visible as typed',
    run: () =>
      withDoc('x\n\n*this never closes\n\nsnake_case_name\n\nthis closes* here', (p) => {
        const got = [3, 5, 7].map((n) => lineText(p, n));
        return check(got.join('|') === '*this never closes|snake_case_name|this closes* here' && within(p, '.tok-em').length === 0, got);
      }),
  },
  {
    id: 'render.inline-marks.u05',
    feature: 'render.inline-marks',
    name: 'Backslash-escaped markers read as the literal character, without the backslash',
    run: () =>
      withDoc('x\n\n\\*not italic\\* and \\*\\*not bold\\*\\*', (p) => {
        const t = lineText(p, 3);
        return check(t === '*not italic* and **not bold**' && within(p, '.tok-em, .tok-strong').length === 0, t);
      }),
  },
  {
    id: 'render.inline-marks.u06',
    feature: 'render.inline-marks',
    name: 'With reveal-on-line off, putting the caret inside bold keeps its markers hidden',
    run: () =>
      withDoc('x\n\nA **bold** word', (p) => {
        p.select(p.view.state.doc.line(3).from + 5);
        const t = lineText(p, 3);
        return check(t === 'A bold word', t);
      }),
  },
  {
    id: 'render.inline-marks.u07',
    feature: 'render.inline-marks',
    name: 'Editing inside a bold word keeps it bold and hidden, and undo puts the text back',
    run: () =>
      withDoc('x\n\nA **bold** word', (p) => {
        const at = p.view.state.doc.line(3).from + 6; // between "bo" and "ld"
        typeAt(p, at, 'Z');
        const after = lineText(p, 3);
        const doc1 = p.doc();
        p.press('Mod-z');
        const ok = doc1 === 'x\n\nA **boZld** word' && after === 'A boZld word' && p.doc() === 'x\n\nA **bold** word' && lineText(p, 3) === 'A bold word';
        return check(ok, { doc1, after, undone: p.doc(), undoneText: lineText(p, 3) });
      }),
  },
  {
    id: 'render.inline-marks.u08',
    feature: 'render.inline-marks',
    name: 'Emoji, Hebrew and decomposed accents inside marks render whole, markers hidden',
    run: () =>
      withDoc('x\n\n**bold 🚢 text** and *café* and **הדגשה**', (p) => {
        const t = lineText(p, 3);
        return check(t === 'bold 🚢 text and café and הדגשה' && within(p, '.tok-strong').join('|') === 'bold 🚢 text|הדגשה', t);
      }),
  },
  {
    id: 'render.inline-marks.u09',
    feature: 'render.inline-marks',
    name: 'Marks render in a file with CRLF line endings',
    run: () =>
      withDoc('x\r\n\r\nA **bold** word\r\nnext *line*', (p) => {
        const t = text(p);
        return check(t === 'x\n\nA bold word\nnext line', t);
      }),
  },
  {
    id: 'render.inline-marks.u10',
    feature: 'render.inline-marks',
    name: 'A mark at the very start and very end of the document renders',
    run: () =>
      withDoc('**start** middle *end*', (p) => {
        p.select(9);
        const t = text(p);
        return check(t === 'start middle end', t);
      }),
  },

  // ---------------------------------------------------------------- headings
  {
    id: 'render.headings.u01',
    feature: 'render.headings',
    name: 'ATX headings 1 to 6 get their level and hide the hashes',
    run: () =>
      withDoc('x\n\n# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six', (p) => {
        const got = [3, 4, 5, 6, 7, 8].map((n, i) => ({ t: lineText(p, n), lvl: lineHas(p, n, `tok-h${i + 1}`) }));
        const want = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
        return check(got.every((g, i) => g.t === want[i] && g.lvl), got);
      }),
  },
  {
    id: 'render.headings.u02',
    feature: 'render.headings',
    name: 'Seven hashes, or no space after the hash, is ordinary text with the hashes showing',
    run: () =>
      withDoc('x\n\n####### Seven\n\n#NoSpace', (p) => {
        const got = { a: lineText(p, 3), b: lineText(p, 5), ah: lineHas(p, 3, 'tok-heading'), bh: lineHas(p, 5, 'tok-heading') };
        return check(got.a === '####### Seven' && got.b === '#NoSpace' && !got.ah && !got.bh, got);
      }),
  },
  {
    id: 'render.headings.u03',
    feature: 'render.headings',
    name: 'A closed ATX heading hides the closing hashes too',
    run: () =>
      withDoc('x\n\n### Closed ATX ###', (p) => {
        const t = lineText(p, 3);
        return check(t.trim() === 'Closed ATX' && lineHas(p, 3, 'tok-h3'), t);
      }),
  },
  {
    id: 'render.headings.u04',
    feature: 'render.headings',
    name: 'Setext headings take level 1 and 2 and hide the underline',
    run: () =>
      withDoc('x\n\nSetext one\n==========\n\nSetext two\n----------', (p) => {
        const got = { t1: lineText(p, 3), u1: lineText(p, 4), h1: lineHas(p, 3, 'tok-h1'), t2: lineText(p, 6), u2: lineText(p, 7), h2: lineHas(p, 6, 'tok-h2') };
        return check(got.t1 === 'Setext one' && got.u1 === '' && got.h1 && got.t2 === 'Setext two' && got.u2 === '' && got.h2, got);
      }),
  },
  {
    id: 'render.headings.u05',
    feature: 'render.headings',
    name: 'A heading holding code, bold and a link shows only their text',
    run: () =>
      withDoc('x\n\n### Heading with `code`, **bold**, and [a link](https://example.com)', (p) => {
        const t = lineText(p, 3);
        return check(t === 'Heading with code, bold, and a link' && lineHas(p, 3, 'tok-h3'), t);
      }),
  },
  {
    id: 'render.headings.u06',
    feature: 'render.headings',
    name: 'A heading on the last line with no newline, and a bare # line, render as headings',
    run: () =>
      withDoc('x\n\n#\n\n## Last', (p) => {
        const got = { empty: lineText(p, 3), emptyH: lineHas(p, 3, 'tok-h1'), last: lineText(p, 5), lastH: lineHas(p, 5, 'tok-h2') };
        return check(got.empty === '' && got.emptyH && got.last === 'Last' && got.lastH, got);
      }),
  },
  {
    id: 'render.headings.u07',
    feature: 'render.headings',
    name: 'A heading revealed for editing shows its hashes, and typing a hash changes its level',
    run: () =>
      withDoc('x\n\n## Two\n\nafter', (p) => {
        const l = p.view.state.doc.line(3);
        p.view.dispatch({ effects: setReveal.of({ from: l.from, to: l.to }), selection: { anchor: l.from + 1 } });
        const shown = lineText(p, 3);
        typeAt(p, l.from + 1, '#');
        const got = { shown, doc: p.doc(), h3: lineHas(p, 3, 'tok-h3'), after: lineText(p, 3) };
        return check(shown === '## Two' && got.doc === 'x\n\n### Two\n\nafter' && got.h3, got);
      }),
  },
  {
    id: 'render.headings.u08',
    feature: 'render.headings',
    name: 'A CJK heading gets its level and hides the hash',
    run: () =>
      withDoc('x\n\n# 日本語の見出し', (p) => check(lineText(p, 3) === '日本語の見出し' && lineHas(p, 3, 'tok-h1'), lineText(p, 3))),
  },

  // ---------------------------------------------------------------- lists and tasks
  {
    id: 'render.lists-tasks.u01',
    feature: 'render.lists-tasks',
    name: 'Bullets written with -, * and + all show a bullet in place of the marker',
    run: () =>
      withDoc('x\n\n- dash\n\n* star\n\n+ plus', (p) => {
        const got = [3, 5, 7].map((n) => lineText(p, n));
        return check(got.every((t) => /^•\s+(dash|star|plus)$/.test(t)), got);
      }),
  },
  {
    id: 'render.lists-tasks.u02',
    feature: 'render.lists-tasks',
    name: 'Numbered items keep their number, including a list starting at 7 and a ) delimiter',
    run: () =>
      withDoc('x\n\n7. seven\n8. eight\n\n1) paren', (p) => {
        const got = [3, 4, 6].map((n) => lineText(p, n));
        return check(got[0] === '7. seven' && got[1] === '8. eight' && got[2] === '1) paren', got);
      }),
  },
  {
    id: 'render.lists-tasks.u03',
    feature: 'render.lists-tasks',
    name: 'Task items show a checkbox, ticked for [x] and [X], and no brackets',
    run: () =>
      withDoc('x\n\n- [ ] open\n- [x] done\n- [X] caps', (p) => {
        const boxes = [...p.view.contentDOM.querySelectorAll('input.md-task')] as HTMLInputElement[];
        const got = { checked: boxes.map((b) => b.checked), t: [3, 4, 5].map((n) => lineText(p, n)) };
        return check(j(got.checked) === '[false,true,true]' && got.t.every((t) => !t.includes('[')), got);
      }),
  },
  {
    id: 'render.lists-tasks.u04',
    feature: 'render.lists-tasks',
    name: 'Clicking the second checkbox ticks that line and no other',
    run: () =>
      withDoc('x\n\n- [ ] a\n- [ ] b\n- [ ] c', (p) => {
        pressCheckbox(p, 1);
        return check(p.doc() === 'x\n\n- [ ] a\n- [x] b\n- [ ] c', p.doc());
      }),
  },
  {
    id: 'render.lists-tasks.u05',
    feature: 'render.lists-tasks',
    name: 'Clicking a ticked box unticks it, and undo ticks it again',
    run: () =>
      withDoc('x\n\n- [x] done', (p) => {
        pressCheckbox(p, 0);
        const once = p.doc();
        p.press('Mod-z');
        return check(once === 'x\n\n- [ ] done' && p.doc() === 'x\n\n- [x] done', { once, undone: p.doc() });
      }),
  },
  {
    id: 'render.lists-tasks.u06',
    feature: 'render.lists-tasks',
    name: 'After text is typed above a task, its checkbox still edits its own line',
    run: () =>
      withDoc('x\n\n- [ ] a\n- [ ] b', (p) => {
        typeAt(p, 1, 'yz');
        pressCheckbox(p, 1);
        return check(p.doc() === 'xyz\n\n- [ ] a\n- [x] b', p.doc());
      }),
  },
  {
    id: 'render.lists-tasks.u07',
    feature: 'render.lists-tasks',
    name: 'Clicking a nested task ticks the nested line only',
    run: () =>
      withDoc('x\n\n- [ ] parent\n  - [ ] nested\n    - [ ] deeper', (p) => {
        pressCheckbox(p, 2);
        return check(p.doc() === 'x\n\n- [ ] parent\n  - [ ] nested\n    - [x] deeper', p.doc());
      }),
  },
  {
    id: 'render.lists-tasks.u08',
    feature: 'render.lists-tasks',
    name: 'An invalid marker [~] is text, not a checkbox',
    run: () =>
      withDoc('x\n\n- [~] not valid', (p) => {
        const n = p.view.contentDOM.querySelectorAll('input.md-task').length;
        return check(n === 0 && lineText(p, 3).includes('[~] not valid'), { n, t: lineText(p, 3) });
      }),
  },
  {
    id: 'render.lists-tasks.u09',
    feature: 'render.lists-tasks',
    name: 'A task inside a blockquote shows a checkbox that ticks its own line',
    run: () =>
      withDoc('x\n\n> - [ ] quoted task', (p) => {
        const ok = pressCheckbox(p, 0);
        return check(ok && p.doc() === 'x\n\n> - [x] quoted task', { ok, doc: p.doc() });
      }),
  },
  {
    id: 'render.lists-tasks.u10',
    feature: 'render.lists-tasks',
    name: 'A task with bold and code shows the checkbox and the formatted text',
    run: () =>
      withDoc('x\n\n- [ ] with **bold** and `code`', (p) => {
        const t = lineText(p, 3);
        return check(p.view.contentDOM.querySelectorAll('input.md-task').length === 1 && /with bold and `?code`?$/.test(t) && !t.includes('**'), t);
      }),
  },
  {
    id: 'render.lists-tasks.u11',
    feature: 'render.lists-tasks',
    name: 'Clicking a checkbox in a CRLF file ticks the right line',
    run: () =>
      withDoc('x\r\n\r\n- [ ] a\r\n- [ ] b', (p) => {
        pressCheckbox(p, 1);
        return check(p.doc() === 'x\n\n- [ ] a\n- [x] b', p.doc());
      }),
  },

  // ---------------------------------------------------------------- quotes
  {
    id: 'render.quotes.u01',
    feature: 'render.quotes',
    name: 'A blockquote hides its > and draws the quote rule on each line, lazy continuation included',
    run: () =>
      withDoc('x\n\n> Lazy continuation\nwithout the marker', (p) => {
        const got = { a: lineText(p, 3), b: lineText(p, 4), qa: lineHas(p, 3, 'tok-quote'), qb: lineHas(p, 4, 'tok-quote') };
        return check(!got.a.includes('>') && got.a.trim() === 'Lazy continuation' && got.b === 'without the marker' && got.qa && got.qb, got);
      }),
  },
  {
    id: 'render.quotes.u02',
    feature: 'render.quotes',
    name: 'Nested quotes and a quote with no space after > hide every marker',
    run: () =>
      withDoc('x\n\n> > > Triple\n> Single.\n\n>No space.', (p) => {
        const got = [3, 4, 6].map((n) => lineText(p, n));
        return check(got.every((t) => !t.includes('>')) && got.map((t) => t.trim()).join('|') === 'Triple|Single.|No space.', got);
      }),
  },
  {
    id: 'render.quotes.u03',
    feature: 'render.quotes',
    name: 'A list and a fence inside a quote render as bullets and code, with no > showing',
    run: () =>
      withDoc('x\n\n> - a list\n>\n> ```sh\n> echo hi\n> ```', (p) => {
        const got = { t: [3, 4, 5, 6, 7].map((n) => lineText(p, n)), code: lineHas(p, 6, 'tok-code-block') };
        return check(got.t.every((t) => !t.includes('>')) && got.t[0].includes('•') && got.code, got);
      }),
  },
  {
    id: 'render.quotes.u04',
    feature: 'render.quotes',
    name: 'A callout-style quote keeps its [!NOTE] label readable',
    run: () =>
      withDoc('x\n\n> [!NOTE]\n> Useful information.', (p) => {
        const t = lineText(p, 3);
        const asLink = within(p, '.tok-link').length > 0;
        return check((t.includes('[!NOTE]') || /note/i.test(t)) && !asLink, { t, asLink });
      }),
  },
  {
    id: 'render.quotes.u05',
    feature: 'render.quotes',
    name: 'A quote with Hebrew and bold hides the markers and keeps the text in order',
    run: () =>
      withDoc('x\n\n> ציטוט עם **הדגשה** וגם `קוד`.', (p) => {
        const t = lineText(p, 3).trim();
        return check(!t.includes('>') && !t.includes('**') && t.startsWith('ציטוט עם הדגשה'), t);
      }),
  },

  // ---------------------------------------------------------------- code blocks
  {
    id: 'render.code-blocks.u01',
    feature: 'render.code-blocks',
    name: 'Every line of a fenced block, fences included, is styled as code',
    run: () =>
      withDoc('x\n\n```js\nconst a = 1;\n```\n\nafter', (p) => {
        const got = [3, 4, 5].map((n) => lineHas(p, n, 'tok-code-block'));
        return check(got.every(Boolean) && !lineHas(p, 7, 'tok-code-block') && lineText(p, 4) === 'const a = 1;', got);
      }),
  },
  {
    id: 'render.code-blocks.u02',
    feature: 'render.code-blocks',
    name: 'Markdown inside a fence is shown as typed, never rendered',
    run: () =>
      withDoc('x\n\n```\n# not a heading\n- not a list\n**not bold**\n```', (p) => {
        const got = { t: [4, 5, 6].map((n) => lineText(p, n)), h: lineHas(p, 4, 'tok-heading'), strong: within(p, '.tok-strong').length };
        return check(got.t.join('|') === '# not a heading|- not a list|**not bold**' && !got.h && got.strong === 0, got);
      }),
  },
  {
    id: 'render.code-blocks.u03',
    feature: 'render.code-blocks',
    name: 'An indented code block is styled as code',
    run: () =>
      withDoc('x\n\nIndented:\n\n    function indented() {\n      return 1;\n    }\n\nafter', (p) => {
        const got = [5, 6, 7].map((n) => lineHas(p, n, 'tok-code-block'));
        return check(got.every(Boolean), { styled: got, t: lineText(p, 5) });
      }),
  },
  {
    id: 'render.code-blocks.u04',
    feature: 'render.code-blocks',
    name: 'Tilde fences, unknown languages and a four-backtick fence holding a fence are all code',
    run: () =>
      withDoc('x\n\n~~~python\nprint(1)\n~~~\n\n```notalanguage\nstill code\n```\n\n````markdown\n```js\nconst n = 1;\n```\n````', (p) => {
        const want = [4, 8, 12, 13, 14];
        const got = want.map((n) => lineHas(p, n, 'tok-code-block'));
        return check(got.every(Boolean) && lineText(p, 13) === 'const n = 1;', { got, t13: lineText(p, 13) });
      }),
  },
  {
    id: 'render.code-blocks.u05',
    feature: 'render.code-blocks',
    name: 'A fenced JavaScript block gets syntax colours once its language loads',
    run: async () => {
      const p = mount('x\n\n```js\nconst answer = "yes"; // note\n```');
      try {
        let spans = 0;
        for (let i = 0; i < 40 && spans === 0; i++) {
          await sleep(50);
          p.view.dispatch({});
          spans = lineEl(p, 4)?.querySelectorAll('span[class*="ͼ"]').length ?? 0;
        }
        return check(spans > 0, { spans, html: lineEl(p, 4)?.innerHTML });
      } finally {
        p.destroy();
      }
    },
  },
  {
    id: 'render.code-blocks.u06',
    feature: 'render.code-blocks',
    name: 'A fence inside a list item and an unclosed fence at the end of the file are code',
    run: () =>
      withDoc('x\n\n- item:\n\n  ```js\n  const x = 1;\n  ```\n\n```js\nconst unclosed = true;\nstill code', (p) => {
        const got = [6, 10, 11].map((n) => lineHas(p, n, 'tok-code-block'));
        return check(got.every(Boolean), got);
      }),
  },
  {
    id: 'render.code-blocks.u07',
    feature: 'render.code-blocks',
    name: 'Typing a new line inside a fence keeps it code, and undo restores it',
    run: () =>
      withDoc('x\n\n```\nline\n```', (p) => {
        const at = p.view.state.doc.line(4).to;
        typeAt(p, at, '\n**more**');
        const got = { code: lineHas(p, 5, 'tok-code-block'), t: lineText(p, 5) };
        p.press('Mod-z');
        return check(got.code && got.t === '**more**' && p.doc() === 'x\n\n```\nline\n```', { ...got, undone: p.doc() });
      }),
  },

  {
    id: 'render.code-blocks.u08',
    feature: 'render.code-blocks',
    name: 'Fences named with a short language name (py, rs, sh, ts) get syntax colours like their full names',
    run: async () => {
      const code: Record<string, string> = {
        python: 'def f(): return "x"',
        py: 'def f(): return "x"',
        rust: 'fn main() { let s = "x"; }',
        rs: 'fn main() { let s = "x"; }',
        bash: 'if true; then echo "x"; fi',
        sh: 'if true; then echo "x"; fi',
        typescript: 'const s: string = "x";',
        ts: 'const s: string = "x";',
      };
      const spans: Record<string, number> = {};
      for (const name of Object.keys(code)) {
        const p = mount(`x\n\n\`\`\`${name}\n${code[name]}\n\`\`\``);
        try {
          let n = 0;
          for (let i = 0; i < 40 && n === 0; i++) {
            await sleep(50);
            p.view.dispatch({});
            n = lineEl(p, 4)?.querySelectorAll('span[class*="ͼ"]').length ?? 0;
          }
          spans[name] = n;
        } finally {
          p.destroy();
        }
      }
      return check(Object.values(spans).every((n) => n > 0), { colouredSpansOnTheCodeLine: spans });
    },
  },

  // ---------------------------------------------------------------- rules
  {
    id: 'render.rules.u01',
    feature: 'render.rules',
    name: 'Every spelling of a horizontal rule draws a rule and hides the characters',
    run: () =>
      withDoc('x\n\n---\n\n***\n\n___\n\n- - -\n\n* * *\n\n_ _ _\n\n   ---\n\nend', (p) => {
        const rows = [3, 5, 7, 9, 11, 13, 15].map((n) => ({ t: lineText(p, n), hr: !!lineEl(p, n)?.querySelector('hr.md-hr') }));
        return check(rows.every((r) => r.hr && r.t.trim() === ''), rows);
      }),
  },
  {
    id: 'render.rules.u02',
    feature: 'render.rules',
    name: 'Dashes right under a paragraph make a heading, not a rule; two dashes are text',
    run: () =>
      withDoc('x\n\nText\n---\n\n--', (p) => {
        const got = { h: lineHas(p, 3, 'tok-h2'), hr: p.view.contentDOM.querySelectorAll('hr.md-hr').length, two: lineText(p, 6) };
        return check(got.h && got.hr === 0 && got.two === '--', got);
      }),
  },
  {
    id: 'render.rules.u03',
    feature: 'render.rules',
    name: 'A rule revealed for editing shows its dashes and hides again once the caret leaves',
    run: () =>
      withDoc('above\n\n---\n\nbelow', (p) => {
        const l = p.view.state.doc.line(3);
        p.view.dispatch({ effects: setReveal.of({ from: l.from, to: l.to }), selection: { anchor: l.from } });
        const shown = lineText(p, 3);
        p.select(p.doc().length);
        const hidden = !!lineEl(p, 3)?.querySelector('hr.md-hr');
        return check(shown === '---' && hidden, { shown, hidden });
      }),
  },
  {
    id: 'render.rules.u04',
    feature: 'render.rules',
    name: 'A rule as the first and as the last line of the file draws a rule',
    run: () =>
      withDoc('***\n\nmiddle\n\n***', (p) => {
        p.select(3);
        const n = p.view.contentDOM.querySelectorAll('hr.md-hr').length;
        return check(n === 2, { n, t: text(p) });
      }),
  },
  {
    id: 'render.rules.u05',
    feature: 'render.rules',
    name: 'A click on a rule selects it as a block, so Edit Markdown shows its dashes and typing replaces it rather than landing in front of them',
    run: () =>
      withDoc('Above text.\n\n---\n\nBelow text.\n', (p) => {
        // The press goes through CodeMirror's own pointer handling, as a real one does:
        // a rule that let the browser place the caret instead left the editor's
        // selection where it was, and the dashes took the next keystroke.
        p.select(0);
        const click = (): void => {
          const hr = p.view.contentDOM.querySelector('hr.md-hr');
          if (!hr) return;
          const init = { bubbles: true, cancelable: true, button: 0, detail: 1 };
          hr.dispatchEvent(new MouseEvent('mousedown', init));
          hr.dispatchEvent(new MouseEvent('mouseup', init));
        };
        click();
        const sel = p.view.state.selection.main;
        const selected = p.view.state.sliceDoc(sel.from, sel.to);
        const block = blockSelectionOf(p.view.state);
        const asBlock = !!block && block.from === sel.from && block.to === sel.to;
        toggleBlockReveal(p.view);
        const shown = lineText(p, 3);
        toggleBlockReveal(p.view);
        const away = !!lineEl(p, 3)?.querySelector('hr.md-hr');
        click();
        const range = p.view.state.selection.main;
        p.view.dispatch({ changes: { from: range.from, to: range.to, insert: 'Z' }, selection: { anchor: range.from + 1 }, userEvent: 'input.type' });
        const typed = p.doc();
        const got = { selected, asBlock, shown, away, typed };
        return check(selected === '---' && asBlock && shown === '---' && away && typed === 'Above text.\n\nZ\n\nBelow text.\n', got);
      }),
  },

  // ---------------------------------------------------------------- links
  {
    id: 'render.links.u01',
    feature: 'render.links',
    name: 'An inline link shows its text as a link, with the brackets, address and title hidden',
    run: () =>
      withDoc('x\n\nSee [the site](https://example.com "Title here") now', (p) => {
        const t = lineText(p, 3);
        return check(t === 'See the site now' && within(p, '.tok-link').join('') === 'the site', { t, links: within(p, '.tok-link') });
      }),
  },
  {
    id: 'render.links.u02',
    feature: 'render.links',
    name: 'An autolink in angle brackets shows its address',
    run: () =>
      withDoc('x\n\nBare autolink: <https://example.com/path?a=1> and <someone@example.com>', (p) => {
        const t = lineText(p, 3);
        return check(t.includes('https://example.com/path?a=1') && t.includes('someone@example.com'), t);
      }),
  },
  {
    id: 'render.links.u03',
    feature: 'render.links',
    name: 'A bare URL typed in a sentence stays visible',
    run: () =>
      withDoc('x\n\nThe docs are at https://example.com/docs today', (p) => {
        const t = lineText(p, 3);
        return check(t === 'The docs are at https://example.com/docs today', t);
      }),
  },
  {
    id: 'render.links.u04',
    feature: 'render.links',
    name: 'A reference link shows its text, and its definition line does not show a label with the address missing',
    run: () =>
      withDoc('x\n\nRead [the reference][ref] here.\n\n[ref]: https://example.com/reference "Reference title"', (p) => {
        const a = lineText(p, 3);
        const def = lineText(p, 5);
        const defOk = def.trim() === '' || def.includes('https://example.com/reference');
        return check(a === 'Read the reference here.' && defOk, { a, def });
      }),
  },
  {
    id: 'render.links.u05',
    feature: 'render.links',
    name: 'A link with parentheses in its address, or an angle-bracket address, shows just its text',
    run: () =>
      withDoc('x\n\n[paren](https://example.com/a_(b)_c) and [angle](<https://example.com/a b>)', (p) => {
        const t = lineText(p, 3);
        return check(t === 'paren and angle', t);
      }),
  },
  {
    id: 'render.links.u08',
    feature: 'render.links',
    name: 'Square brackets that are not a link keep their brackets: a footnote mark, a citation and a bracketed word',
    run: () =>
      withDoc('x\n\nA claim.[^1] See [1] and [draft].\n\nA [link [with] brackets](https://example.com).', (p) => {
        const got = { a: lineText(p, 3), b: lineText(p, 5), links: within(p, '.tok-link') };
        return check(got.a === 'A claim.[^1] See [1] and [draft].' && got.b === 'A link [with] brackets.', got);
      }),
  },
  {
    id: 'render.links.u06',
    feature: 'render.links',
    name: 'A link with empty text still leaves something visible to click',
    run: () =>
      withDoc('x\n\nEmpty text: [](https://example.com)', (p) => {
        const t = lineText(p, 3);
        return check(t.trim() !== 'Empty text:', t);
      }),
  },
  {
    id: 'render.links.u07',
    feature: 'render.links',
    name: 'A link inside bold and emphasis inside a link both render',
    run: () =>
      withDoc('x\n\n**[bold link](https://example.com)** and [*italic* link](https://example.com)', (p) => {
        const t = lineText(p, 3);
        return check(t === 'bold link and italic link' && within(p, '.tok-link').length === 2, t);
      }),
  },

  // ---------------------------------------------------------------- front matter
  {
    id: 'render.front-matter.u01',
    feature: 'render.front-matter',
    name: 'A short YAML front matter block reads as metadata, not as a rule and a heading',
    run: () =>
      withDoc('---\ntitle: Hello\ndraft: true\n---\n\n# Body\n\ntext', (p) => {
        p.select(p.doc().length);
        const got = {
          l1: lineText(p, 1),
          l2: lineText(p, 2),
          l3: lineText(p, 3),
          heading: [1, 2, 3, 4].filter((n) => lineHas(p, n, 'tok-heading')),
          hr: [1, 4].filter((n) => !!lineEl(p, n)?.querySelector('hr.md-hr')),
          body: lineHas(p, 6, 'tok-h1'),
        };
        return check(got.l2 === 'title: Hello' && got.l3 === 'draft: true' && got.heading.length === 0 && got.hr.length === 0 && got.body, got);
      }),
  },
  {
    id: 'render.front-matter.u02',
    feature: 'render.front-matter',
    name: 'The sample front matter shows no headings, rules or list bullets inside it',
    run: () => {
      // The first 45 lines: jsdom lays out only the top of a long document.
      const src = fixture('edge/front-matter.md').split('\n').slice(0, 45).join('\n');
      return withDoc(src, (p) => {
        const close = src.split('\n').indexOf('---', 1) + 1; // line number of the closing ---
        const bad: string[] = [];
        for (let n = 1; n <= close; n++) {
          const el = lineEl(p, n);
          if (!el) continue;
          if (el.classList.contains('tok-heading')) bad.push(`${n} heading ${j(el.textContent)}`);
          if (el.querySelector('hr.md-hr')) bad.push(`${n} rule`);
          if (el.querySelector('.tok-bullet')) bad.push(`${n} bullet ${j(el.textContent)}`);
        }
        // The body heading below is covered by front-matter.u01; jsdom may not lay out this far down.
        return check(bad.length === 0, { close, bad });
      });
    },
  },
  {
    id: 'render.front-matter.u03',
    feature: 'render.front-matter',
    name: 'A --- later in the document is a rule, and a front-matter-shaped block not at the top is content',
    run: () =>
      withDoc('# Doc\n\n---\n\n---\ntitle: not front matter\n---\n', (p) => {
        const got = { hr3: !!lineEl(p, 3)?.querySelector('hr.md-hr'), hr5: !!lineEl(p, 5)?.querySelector('hr.md-hr'), h6: lineHas(p, 6, 'tok-h2') };
        return check(got.hr3 && got.hr5 && got.h6, got);
      }),
  },
  {
    id: 'render.front-matter.u04',
    feature: 'render.front-matter',
    name: 'Front matter closed with ... reads as metadata, not a paragraph run together',
    run: () =>
      withDoc('---\ntitle: Dots\n...\n\nbody', (p) => {
        p.select(p.doc().length);
        const got = { l1hr: !!lineEl(p, 1)?.querySelector('hr.md-hr'), l2: lineText(p, 2) };
        return check(!got.l1hr && got.l2 === 'title: Dots', got);
      }),
  },

  // ---------------------------------------------------------------- html
  {
    id: 'render.html.u01',
    feature: 'render.html',
    name: 'Inline HTML keeps its words readable and does not break Markdown beside it',
    run: () =>
      withDoc('x\n\nthis is <em>emphasised</em> and **bold** and x<sup>2</sup>', (p) => {
        const t = lineText(p, 3);
        return check(t.includes('emphasised') && !t.includes('**') && t.includes('bold'), t);
      }),
  },
  {
    id: 'render.html.u02',
    feature: 'render.html',
    name: 'An HTML comment is hidden or styled apart from document text',
    run: () =>
      withDoc('x\n\n<!-- invisible: this text must not appear -->\n\nafter', (p) => {
        const el = lineEl(p, 3);
        const t = el?.textContent ?? '';
        // Styled apart: the whole comment sits in a span carrying a highlight class, which body text does not get.
        const styled = [...(el?.querySelectorAll('span[class]') ?? [])].some((s) => (s.textContent ?? '').includes('this text must not appear'));
        const bodyStyled = !!lineEl(p, 5)?.querySelector('span[class]');
        return check(t.trim() === '' || (styled && !bodyStyled), { t, html: el?.innerHTML });
      }),
  },
  {
    id: 'render.html.u03',
    feature: 'render.html',
    name: 'A script block stays inert text: no script element reaches the page',
    run: () =>
      withDoc("x\n\n<script>\n  window.__sheafRan = true;\n</script>\n\n<style>.cm-line{display:none}</style>", (p) => {
        const got = { scripts: p.view.dom.querySelectorAll('script, style').length, ran: (globalThis as any).window?.__sheafRan === true, t: lineText(p, 4) };
        return check(got.scripts === 0 && !got.ran && got.t.includes('window.__sheafRan'), got);
      }),
  },
  {
    id: 'render.html.u04',
    feature: 'render.html',
    name: 'Markdown inside a details element after a blank line renders',
    run: () =>
      withDoc('x\n\n<details>\n<summary>More</summary>\n\nThis is **inside** it.\n\n- a list\n\n</details>', (p) => {
        const got = { t: lineText(p, 6), bullet: lineText(p, 8) };
        return check(got.t === 'This is inside it.' && got.bullet.includes('•'), got);
      }),
  },
  {
    id: 'render.html.u05',
    feature: 'render.html',
    name: 'Character entities read as the characters they name',
    run: () =>
      withDoc('x\n\nAT&amp;T &copy; 2044 &mdash; done', (p) => {
        const t = lineText(p, 3);
        return check(t === 'AT&T © 2044 — done', t);
      }),
  },
  {
    id: 'render.html.u06',
    feature: 'render.html',
    name: 'Two key caps in one sentence each read as a key, with the tags gone',
    run: () =>
      withDoc('x\n\nPress <kbd>Cmd</kbd>+<kbd>K</kbd> now.\n\nafter', (p) => {
        const got = { t: lineText(p, 3), keys: [...(lineEl(p, 3)?.querySelectorAll('.tok-html-kbd') ?? [])].map((e) => e.textContent) };
        return check(got.t === 'Press Cmd+K now.' && j(got.keys) === j(['Cmd', 'K']), got);
      }),
  },
  {
    id: 'render.html.u07',
    feature: 'render.html',
    name: 'Upper-case tags draw the same as lower-case ones',
    run: () =>
      withDoc('x\n\nH<SUB>2</SUB>O and <KBD>Esc</KBD>\n\nafter', (p) => {
        const el = lineEl(p, 3);
        const got = { t: lineText(p, 3), sub: el?.querySelector('.tok-html-sub')?.textContent, kbd: el?.querySelector('.tok-html-kbd')?.textContent };
        return check(got.t === 'H2O and Esc' && got.sub === '2' && got.kbd === 'Esc', got);
      }),
  },
  {
    id: 'render.html.u08',
    feature: 'render.html',
    name: 'A tag carrying an attribute is left as written, so nothing the file does not say is drawn',
    run: () =>
      withDoc('x\n\nA <kbd class="big">Tab</kbd> and <span>plain</span>.\n\nafter', (p) => {
        const t = lineText(p, 3);
        return check(t === 'A <kbd class="big">Tab</kbd> and <span>plain</span>.', t);
      }),
  },
  {
    id: 'render.html.u09',
    feature: 'render.html',
    name: 'An abbreviation shows its title on hover, with an entity in the title read as its character',
    run: () =>
      withDoc('x\n\nThe <abbr title="Tom &amp; Jerry">T&amp;J</abbr> show.\n\nafter', (p) => {
        const el = lineEl(p, 3)?.querySelector('.tok-html-abbr');
        const got = { t: lineText(p, 3), title: el?.getAttribute('title') };
        return check(got.t === 'The T&J show.' && got.title === 'Tom & Jerry', got);
      }),
  },
  {
    id: 'render.html.u10',
    feature: 'render.html',
    name: 'Tags inside backticks stay literal text, as code',
    run: () =>
      withDoc('x\n\nWrite `<kbd>A</kbd>` for a key.\n\nafter', (p) => {
        const got = { t: lineText(p, 3), kbd: lineEl(p, 3)?.querySelectorAll('.tok-html-kbd').length };
        return check(got.t === 'Write <kbd>A</kbd> for a key.' && got.kbd === 0, got);
      }),
  },
  {
    id: 'render.html.u11',
    feature: 'render.html',
    name: 'A pair split across two lines of one paragraph is left as written',
    run: () =>
      withDoc('x\n\nOne <sup>start\nand end</sup> here.\n\nafter', (p) => {
        const got = { a: lineText(p, 3), b: lineText(p, 4) };
        return check(got.a === 'One <sup>start' && got.b === 'and end</sup> here.', got);
      }),
  },
  {
    id: 'render.html.u12',
    feature: 'render.html',
    name: 'The same tag nested in itself keeps its outer tags on screen rather than guessing which close ends it',
    run: () =>
      withDoc('x\n\nSee <b>outer <b>inner</b> rest</b> end.\n\nafter', (p) => {
        // The inner pair is a complete pair and may draw; the outer one is the guess.
        const t = lineText(p, 3);
        return check(t.startsWith('See <b>outer ') && t.endsWith(' rest</b> end.'), t);
      }),
  },

  // ---------------------------------------------------------------- unicode
  {
    id: 'render.unicode.u01',
    feature: 'render.unicode',
    name: 'Emoji inside bold, code and a link render whole with markers hidden',
    run: () =>
      withDoc('x\n\nEmoji inside **bold 🚢 text**, inside `code 🚢 span`, and inside a [link 🚢](https://example.com).', (p) => {
        const t = lineText(p, 3);
        return check(t.includes('bold 🚢 text') && t.includes('link 🚢.') && !t.includes('**') && !t.includes('](') && within(p, '.tok-link').join('') === 'link 🚢', t);
      }),
  },
  {
    id: 'render.unicode.u02',
    feature: 'render.unicode',
    name: 'ZWJ sequences, flags, keycaps and zero-width characters are kept intact in the rendered line',
    run: () => {
      const s = 'ZWJ 👨‍👩‍👧‍👦 🏴󠁧󠁢󠁳󠁣󠁴󠁿 1️⃣ a​b ⁠‌﻿ end';
      return withDoc(`x\n\n${s}`, (p) => check(lineText(p, 3) === s, j([...lineText(p, 3)].map((c) => c.codePointAt(0)!.toString(16)))));
    },
  },
  {
    id: 'render.unicode.u03',
    feature: 'render.unicode',
    name: 'Highlight around CJK text and emphasis around an emoji render',
    run: () =>
      withDoc('x\n\n==重要== と *🚢*', (p) => {
        const t = lineText(p, 3);
        return check(t === '重要 と 🚢' && within(p, '.tok-highlight').join('') === '重要', t);
      }),
  },
  {
    id: 'render.unicode.u04',
    feature: 'render.unicode',
    name: 'Long unbroken strings wrap inside the column instead of widening it',
    run: () =>
      withDoc('x\n\nPneumonoultramicroscopicsilicovolcanoconiosisantidisestablishmentarianismfloccinaucinihilipilification', (p) =>
        check(p.view.contentDOM.classList.contains('cm-lineWrapping'), p.view.contentDOM.className)
      ),
  },
  {
    id: 'render.unicode.u05',
    feature: 'render.unicode',
    name: 'The unicode sample renders bold, code and quote in Hebrew with markers hidden',
    run: () => {
      // The bidirectional section only: jsdom lays out only the top of a long document.
      const all = fixture('edge/unicode-and-i18n.md').split('\n');
      const src = all.slice(all.indexOf('## Bidirectional text'), all.indexOf('## Full-width and CJK in tables')).join('\n');
      return withDoc(src, (p) => {
        const n = src.split('\n').findIndex((l) => l.startsWith('> RTL inside')) + 1;
        const t = lineText(p, n);
        return check(!t.includes('>') && !t.includes('**') && lineHas(p, n, 'tok-quote'), { n, t });
      });
    },
  },

  // ---------------------------------------------------------------- double-click reveal (state)
  {
    id: 'render.reveal-double-click.u01',
    feature: 'render.reveal-double-click',
    name: 'Revealing one paragraph shows its markers and leaves the next paragraph rendered',
    run: () =>
      withDoc('A **bold** one\n\nB *it* two', (p) => {
        const l = p.view.state.doc.line(1);
        p.view.dispatch({ effects: setReveal.of({ from: l.from, to: l.to }), selection: { anchor: 4 } });
        const got = { a: lineText(p, 1), b: lineText(p, 3) };
        return check(got.a === 'A **bold** one' && got.b === 'B it two', got);
      }),
  },
  {
    id: 'render.reveal-double-click.u02',
    feature: 'render.reveal-double-click',
    name: 'Moving the caret out of the revealed block hides its markers again',
    run: () =>
      withDoc('A **bold** one\n\nB *it* two', (p) => {
        const l = p.view.state.doc.line(1);
        p.view.dispatch({ effects: setReveal.of({ from: l.from, to: l.to }), selection: { anchor: 4 } });
        p.select(p.view.state.doc.line(3).from + 1);
        const got = { a: lineText(p, 1), field: p.view.state.field(revealField) };
        return check(got.a === 'A bold one' && got.field === null, got);
      }),
  },
  {
    id: 'render.reveal-double-click.u03',
    feature: 'render.reveal-double-click',
    name: 'Typing in the middle of a revealed block keeps it revealed',
    run: () =>
      withDoc('A **bold** one\n\nnext', (p) => {
        const l = p.view.state.doc.line(1);
        p.view.dispatch({ effects: setReveal.of({ from: l.from, to: l.to }), selection: { anchor: 6 } });
        typeAt(p, 6, 'ZZ');
        return check(lineText(p, 1) === 'A **boZZld** one', lineText(p, 1));
      }),
  },
  {
    id: 'render.reveal-double-click.u04',
    feature: 'render.reveal-double-click',
    name: 'Typing at the end of a revealed block keeps it revealed',
    run: () =>
      withDoc('A **bold** one\n\nnext', (p) => {
        const l = p.view.state.doc.line(1);
        p.view.dispatch({ effects: setReveal.of({ from: l.from, to: l.to }), selection: { anchor: l.to } });
        typeAt(p, l.to, 'X');
        const one = lineText(p, 1);
        typeAt(p, l.to + 1, 'Y');
        const two = lineText(p, 1);
        return check(one === 'A **bold** oneX' && two === 'A **bold** oneXY', { one, two, field: p.view.state.field(revealField) });
      }),
  },
  {
    id: 'render.reveal-double-click.u05',
    feature: 'render.reveal-double-click',
    name: 'Revealing a list shows the markers of every item in it, checkboxes as [ ]',
    run: () =>
      withDoc('- [ ] one\n- [x] two\n\nafter', (p) => {
        p.view.dispatch({ effects: setReveal.of({ from: 0, to: p.view.state.doc.line(2).to }), selection: { anchor: 7 } });
        const got = [1, 2].map((n) => lineText(p, n));
        return check(got.join('|') === '- [ ] one|- [x] two', got);
      }),
  },
  {
    id: 'render.reveal-double-click.u06',
    feature: 'render.reveal-double-click',
    name: 'A change from outside above a revealed block keeps the same block revealed',
    run: () =>
      withDoc('intro\n\nA **bold** one\n\nnext', (p) => {
        const l = p.view.state.doc.line(3);
        p.view.dispatch({ effects: setReveal.of({ from: l.from, to: l.to }), selection: { anchor: l.from + 4 } });
        p.view.dispatch({ changes: { from: 0, insert: 'new line\n\n' } });
        const got = { l5: lineText(p, 5), l1: lineText(p, 1) };
        return check(got.l5 === 'A **bold** one', got);
      }),
  },
  {
    id: 'render.reveal-double-click.u07',
    feature: 'render.reveal-double-click',
    name: 'Deleting the whole revealed block clears the reveal without leaving other text revealed',
    run: () =>
      withDoc('A **bold** one\n\nB *it* two', (p) => {
        const l = p.view.state.doc.line(1);
        p.view.dispatch({ effects: setReveal.of({ from: l.from, to: l.to }), selection: { anchor: 3 } });
        p.view.dispatch({ changes: { from: 0, to: l.to + 2 }, selection: { anchor: 0 } });
        const got = { doc: p.doc(), t: lineText(p, 1), field: p.view.state.field(revealField) };
        return check(got.t === 'B it two' && got.field === null, got);
      }),
  },

  // ---------------------------------------------------------------- reveal on line (setting)
  {
    id: 'render.reveal-on-line.u01',
    feature: 'render.reveal-on-line',
    name: 'With the setting on, the caret line shows its markers and other lines stay rendered',
    run: () =>
      withDoc(
        'A **bold** one\n\nB *it* two',
        (p) => {
          p.select(4);
          const got = { a: lineText(p, 1), b: lineText(p, 3) };
          return check(got.a === 'A **bold** one' && got.b === 'B it two', got);
        },
        true
      ),
  },
  {
    id: 'render.reveal-on-line.u02',
    feature: 'render.reveal-on-line',
    name: 'With the setting on, a selection over two lines reveals both, and a second cursor reveals its line',
    run: () =>
      withDoc(
        'A **a** one\nB **b** two\n\nC **c** three\n\nD **d** four',
        (p) => {
          const c = p.view.state.doc.line(4).from + 3;
          p.view.dispatch({ selection: EditorSelection.create([EditorSelection.range(2, 14), EditorSelection.cursor(c)], 1) });
          const got = [1, 2, 4, 6].map((n) => lineText(p, n));
          return check(got[0].includes('**') && got[1].includes('**') && got[2].includes('**') && !got[3].includes('**'), got);
        },
        true
      ),
  },
  {
    id: 'render.reveal-on-line.u03',
    feature: 'render.reveal-on-line',
    name: 'With the setting on, a caret in a multi-line quote reveals the markers of that whole block',
    run: () =>
      withDoc(
        'x\n\n> first **line**\n> second **line**\n\nafter',
        (p) => {
          p.select(p.view.state.doc.line(3).from + 4);
          const got = [3, 4].map((n) => lineText(p, n));
          return check(got[0].startsWith('>') && got[1].startsWith('>'), got);
        },
        true
      ),
  },
  {
    id: 'render.reveal-on-line.u04',
    feature: 'render.reveal-on-line',
    name: 'Turning the setting on applies to the caret line at once, without moving the caret',
    run: () =>
      withDoc('A **bold** one\n\nafter', (p) => {
        p.select(4);
        const before = lineText(p, 1);
        // What main.ts applyConfig does when the setting changes.
        setLivePreviewConfig({ revealSyntaxOnLine: true });
        p.view.dispatch({});
        const after = lineText(p, 1);
        return check(before === 'A bold one' && after === 'A **bold** one', { before, after });
      }),
  },
  {
    id: 'render.reveal-on-line.u05',
    feature: 'render.reveal-on-line',
    name: 'Turning the setting off hides the caret line markers at once, without moving the caret',
    run: () =>
      withDoc(
        'A **bold** one\n\nafter',
        (p) => {
          p.select(4);
          const before = lineText(p, 1);
          setLivePreviewConfig({ revealSyntaxOnLine: false });
          p.view.dispatch({});
          const after = lineText(p, 1);
          return check(before === 'A **bold** one' && after === 'A bold one', { before, after });
        },
        true
      ),
  },

  // ---------------------------------------------------------------- large documents
  {
    id: 'render.large-docs.u01',
    feature: 'render.large-docs',
    name: 'The 3,148-line handbook mounts in under 1.5 s and a typed letter rebuilds decorations in under 50 ms',
    run: () => {
      const src = fixture('stress/long-handbook.md');
      const t0 = performance.now();
      const p = mount(src);
      const mountMs = performance.now() - t0;
      try {
        const at = p.view.state.doc.line(12).to;
        const t1 = performance.now();
        typeAt(p, at, 'Z');
        const typeMs = performance.now() - t1;
        return check(mountMs < 1500 && typeMs < 50, { lines: p.view.state.doc.lines, mountMs: Math.round(mountMs), typeMs: Math.round(typeMs * 10) / 10 });
      } finally {
        p.destroy();
      }
    },
  },
  {
    id: 'render.large-docs.u02',
    feature: 'render.large-docs',
    name: 'The 2,755-line code-heavy sample mounts in under 1.5 s and a typed letter takes under 50 ms',
    run: () => {
      const src = fixture('stress/code-heavy.md');
      const t0 = performance.now();
      const p = mount(src);
      const mountMs = performance.now() - t0;
      try {
        const at = p.view.state.doc.line(10).to;
        const t1 = performance.now();
        typeAt(p, at, 'Z');
        const typeMs = performance.now() - t1;
        return check(mountMs < 1500 && typeMs < 50, { mountMs: Math.round(mountMs), typeMs: Math.round(typeMs * 10) / 10 });
      } finally {
        p.destroy();
      }
    },
  },
  {
    id: 'render.large-docs.u03',
    feature: 'render.large-docs',
    name: 'Ten levels of nested bullets all show a bullet, and the deepest item shows its text',
    run: () => {
      // The ten-level list only: its lines are long, and jsdom lays out only the first screenful by estimated height.
      const all = fixture('stress/deep-nesting.md').split('\n');
      const start = all.findIndex((l) => l.startsWith('- Level 1:'));
      // Keep each line's indentation and label, drop the long prose after it.
      const src = all.slice(start, start + 10).map((l) => l.replace(/(Level \d+:).*/, '$1 text')).join('\n');
      return withDoc(src, (p) => {
        const n = src.split('\n').findIndex((l) => l.includes('- Level 10:')) + 1;
        const got = { n, t: lineText(p, n) };
        return check(got.t.trim().startsWith('•') && got.t.includes('Level 10:'), got);
      });
    },
  },
];
