// E2E scenarios for rendering, driven by mouse and keyboard in real VS Code.
// Results are read the way a person reads them: the rendered lines, the file on
// disk, computed styles for size and colour, and screenshots.
import { readFileSync, writeFileSync } from 'node:fs';
import { readPng, apart, show as showColour } from '../pixels.mjs';
import { join } from 'node:path';
import { show, REPO } from '../session.mjs';

const sample = (rel) => readFileSync(join(REPO, 'sample', rel), 'utf8');
const line = async (S, n) => (await S.rendered()).split('\n')[n - 1];

/**
 * Write a new file and open it in Sheaf, then confirm the editor on screen holds that file.
 * Works around the harness: S.fresh opens through Quick Open 300 ms after writing, and a file
 * not yet indexed makes Quick Open pick an older, similarly named one (seen: task-untick.md
 * opened tasks.md). Retries with a longer wait, and throws a harness error if it never opens.
 */
async function fresh(S, name, text) {
  for (let i = 0; i < 4; i++) {
    const path = await S.fresh(name, text);
    await S.sleep(300);
    const st = await S.state().catch(() => null);
    if (st && st.doc === text.replace(/\r\n/g, '\n')) return path;
    await S.cleanup();
    await S.sleep(1500 * (i + 1));
  }
  throw new Error(`harness: Quick Open never opened e2e/${name}.md`);
}

/** Change user settings the way the Settings editor does: VS Code watches the file. */
async function setSettings(S, patch) {
  const path = join(S.run, 'user', 'User', 'settings.json');
  const cur = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...cur, ...patch }, null, 2));
  await S.sleep(2500);
}

/** Record the address a link click would hand to VS Code, instead of launching a browser. */
const captureOpens = (S) =>
  S.eval(() => {
    window.__opened = [];
    HTMLAnchorElement.prototype.click = function () {
      window.__opened.push(this.getAttribute('href'));
    };
  });
const opened = (S) => S.eval(() => window.__opened || []);

/** Computed style of the first rendered line whose text includes `needle`. */
const styleOf = (S, needle) =>
  S.eval((needle) => {
    const l = [...document.querySelectorAll('.cm-content > .cm-line')].find((x) => x.textContent.includes(needle));
    if (!l) return null;
    const cs = getComputedStyle(l);
    return { cls: l.className, fontSize: parseFloat(cs.fontSize), fontFamily: cs.fontFamily, color: cs.color, borderLeft: parseFloat(cs.borderLeftWidth), fontWeight: cs.fontWeight };
  }, needle);

const hrCount = (S) => S.eval(() => document.querySelectorAll('hr.md-hr').length);

/** Scroll with the mouse wheel over the editor until `needle` is rendered on screen. */
async function wheelTo(S, needle, { dy = 700, max = 80 } = {}) {
  const f = await S.frame();
  const box = await (await f.frameElement()).boundingBox();
  await S.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < max; i++) {
    const seen = await S.eval((needle) => {
      const l = [...document.querySelectorAll('.cm-content > .cm-line')].find((x) => x.textContent.includes(needle));
      if (!l) return false;
      const r = l.getBoundingClientRect();
      return r.top > 40 && r.bottom < window.innerHeight - 40;
    }, needle);
    if (seen) return true;
    await S.page.mouse.wheel(0, dy);
    await S.sleep(120);
  }
  return false;
}

/** Open a workspace file and time Enter to the first rendered text containing `marker`. */
async function openTimed(S, rel, marker) {
  const { page } = S;
  await page.keyboard.press('Meta+p');
  await page.waitForSelector('.quick-input-widget input', { state: 'visible' });
  await page.keyboard.type(rel, { delay: 5 });
  await S.sleep(700);
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  while (Date.now() - t0 < 30000) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      const ok = await f.evaluate((m) => [...document.querySelectorAll('.cm-content > .cm-line')].some((l) => l.textContent.includes(m)), marker).catch(() => false);
      if (ok) {
        const ms = Date.now() - t0;
        await S.frame();
        await S.sleep(600);
        return ms;
      }
    }
    await S.sleep(20);
  }
  return Infinity;
}

/** In the Sheaf frame, time each keydown to the next DOM change plus a frame, as a person sees a letter appear. */
const watchLatency = (S) =>
  S.eval(() => {
    window.__lat = [];
    let kd = 0;
    document.addEventListener('keydown', () => (kd = performance.now()), true);
    new MutationObserver(() => {
      if (!kd) return;
      const k = kd;
      kd = 0;
      requestAnimationFrame(() => window.__lat.push(Math.round(performance.now() - k)));
    }).observe(document.querySelector('.cm-content'), { subtree: true, childList: true, characterData: true });
  });

const MARKS = 'Plain **bold** and *it* and ~~gone~~ and ==hi== here.\n\nSecond paragraph.\n';

const allScenarios = [
  // ---------------------------------------------------------------- inline marks
  {
    id: 'render.inline-marks.e01',
    feature: 'render.inline-marks',
    name: 'Bold, italic, strike and highlight show without markers, and clicking inside bold types into the bold word',
    run: async (S) => {
      await fresh(S, 'marks', MARKS);
      const before = await line(S, 1);
      await S.caret('bold', 2);
      await S.type('Z');
      const d = await S.disk();
      const after = await line(S, 1);
      return { ok: before === 'Plain bold and it and gone and hi here.' && d.includes('**boZld**') && after === 'Plain boZld and it and gone and hi here.', detail: `before ${show(before)} after ${show(after)} disk ${show(d)}` };
    },
  },
  {
    id: 'render.inline-marks.e02',
    feature: 'render.inline-marks',
    name: 'Inline code shows as a chip with its backticks hidden',
    run: async (S) => {
      await fresh(S, 'inline-code', 'Run `npm test` before you push.\n\nNext.\n');
      await S.caret('Next', 2);
      const r = await line(S, 1);
      await S.shot('inline-code');
      return { ok: r === 'Run npm test before you push.', detail: show(r) };
    },
  },
  {
    id: 'render.inline-marks.e03',
    feature: 'render.inline-marks',
    name: 'Typing into a bold word then clicking Undo gives the file back with markers still hidden',
    run: async (S) => {
      await fresh(S, 'marks-undo', MARKS);
      await S.caret('bold', 2);
      await S.type('Z');
      await S.disk();
      await S.toolbar('Undo');
      const d = await S.disk();
      const r = await line(S, 1);
      return { ok: d === MARKS && r === 'Plain bold and it and gone and hi here.', detail: `disk ${show(d)} line ${show(r)}` };
    },
  },
  {
    id: 'render.inline-marks.e04',
    feature: 'render.inline-marks',
    name: 'Backslash-escaped asterisks read as asterisks, without the backslashes',
    run: async (S) => {
      await fresh(S, 'escapes', '\\*not italic\\* and plain.\n\nNext.\n');
      await S.caret('plain', 1);
      const r = await line(S, 1);
      return { ok: r === '*not italic* and plain.', detail: show(r) };
    },
  },
  {
    id: 'render.inline-marks.e05',
    feature: 'render.inline-marks',
    name: 'Nested emphasis shows only words, while unmatched and intraword markers stay visible',
    run: async (S) => {
      await fresh(S, 'marks-nested', '***triple*** and *a **b** c*\n\n*this never closes\n\nsnake_case_name\n');
      await S.caret('triple', 2);
      const r = (await S.rendered()).split('\n');
      const ok = r[0] === 'triple and a b c' && r[2] === '*this never closes' && r[4] === 'snake_case_name';
      return { ok, detail: show(r) };
    },
  },
  {
    id: 'render.inline-marks.e06',
    feature: 'render.inline-marks',
    name: 'In a CRLF file, marks render and typing into bold keeps the CRLF line endings',
    run: async (S) => {
      const DOC = 'A **bold** word\r\n\r\nNext *line*\r\n';
      await fresh(S, 'marks-crlf', DOC);
      const r = await S.rendered();
      await S.caret('bold', 2);
      await S.type('Z');
      const d = await S.disk();
      return { ok: r === 'A bold word\n\nNext line\n' && d === 'A **boZld** word\r\n\r\nNext *line*\r\n', detail: `rendered ${show(r)} disk ${show(d)}` };
    },
  },
  {
    id: 'render.inline-marks.e07',
    feature: 'render.inline-marks',
    name: 'Marks at the very start and very end of a one-line file render',
    run: async (S) => {
      await fresh(S, 'marks-edges', '**start** middle *end*');
      await S.caret('middle', 2);
      const r = await S.rendered();
      return { ok: r === 'start middle end', detail: show(r) };
    },
  },

  // ---------------------------------------------------------------- headings
  {
    id: 'render.headings.e01',
    feature: 'render.headings',
    name: 'Headings render larger by level with hashes and underline hidden, and clicking a heading types into it',
    run: async (S) => {
      await fresh(S, 'headings', '# One\n\n## Two\n\n### Three\n\nBody text here.\n\nSetext\n======\n');
      const r = await S.rendered();
      const sizes = [];
      for (const n of ['One', 'Two', 'Three', 'Body text', 'Setext']) sizes.push((await styleOf(S, n))?.fontSize);
      await S.caret('Two', 1);
      await S.type('Z');
      const d = await S.disk();
      const ok = !/[#=]/.test(r) && sizes[0] > sizes[1] && sizes[1] > sizes[2] && sizes[2] > sizes[3] && sizes[4] === sizes[0] && d.includes('\n## TZwo\n');
      return { ok, detail: `rendered ${show(r)} sizes ${show(sizes)} disk ${show(d)}` };
    },
  },
  {
    id: 'render.headings.e02',
    feature: 'render.headings',
    name: 'Clicking before the first letter of a heading types after the hidden hashes',
    run: async (S) => {
      await fresh(S, 'heading-start', '## Two words\n\nBody.\n');
      await S.caret('Two', 0);
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === '## ZTwo words\n\nBody.\n', detail: show(d) };
    },
  },
  {
    id: 'render.headings.e03',
    feature: 'render.headings',
    name: 'A heading with inline code and a link shows only their text',
    run: async (S) => {
      await fresh(S, 'heading-inline', '## Run `make` and [docs](https://example.com)\n\nBody.\n');
      await S.caret('Body', 2);
      const r = await line(S, 1);
      return { ok: r === 'Run make and docs', detail: show(r) };
    },
  },
  {
    id: 'render.headings.e04',
    feature: 'render.headings',
    name: 'Seven hashes and #NoSpace stay body text, a closed ATX and a CJK heading hide their hashes, a last-line heading renders',
    run: async (S) => {
      await fresh(S, 'heading-odd', '####### Seven\n\n#NoSpace\n\n### Closed ATX ###\n\n# 日本語の見出し\n\nBody text.\n\n## Last');
      await S.caret('Body', 2);
      const r = (await S.rendered()).split('\n');
      const body = await styleOf(S, 'Body text');
      const seven = await styleOf(S, 'Seven');
      const closed = await styleOf(S, 'Closed ATX');
      const cjk = await styleOf(S, '日本語');
      const last = await styleOf(S, 'Last');
      const ok = r[0] === '####### Seven' && r[2] === '#NoSpace' && r[4].trim() === 'Closed ATX' && r[6] === '日本語の見出し' && r[10] === 'Last' && seven.fontSize === body.fontSize && closed.fontSize > body.fontSize && cjk.fontSize > closed.fontSize && last.fontSize > body.fontSize;
      return { ok, detail: `rendered ${show(r)} sizes ${show([seven.fontSize, closed.fontSize, cjk.fontSize, last.fontSize, body.fontSize])}` };
    },
  },
  {
    id: 'render.headings.e05',
    feature: 'render.headings',
    name: 'With Edit Markdown showing a heading, typing # at its start makes it one level smaller',
    run: async (S) => {
      // Double-click selects a word; Edit Markdown is what shows a block's markers.
      await fresh(S, 'heading-level', '## Heading two\n\nBody text.\n');
      const before = (await styleOf(S, 'Heading two')).fontSize;
      await S.caret('Heading', 2);
      await S.press('Meta+Alt+e');
      await S.sleep(300);
      await S.press('Home');
      await S.type('#');
      await S.press('Meta+Alt+e');
      await S.sleep(300);
      const d = await S.disk();
      const after = (await styleOf(S, 'Heading two')).fontSize;
      return { ok: d === '### Heading two\n\nBody text.\n' && after < before, detail: `disk ${show(d)} size ${before} -> ${after}` };
    },
  },

  // ---------------------------------------------------------------- lists and tasks
  {
    id: 'render.lists-tasks.e01',
    feature: 'render.lists-tasks',
    name: 'Clicking the second task checkbox ticks that task in the file and on screen',
    run: async (S) => {
      await fresh(S, 'tasks', '- [ ] first\n- [ ] second\n- [ ] third\n\nAfter.\n');
      await S.click({ sel: 'input.md-task', nth: 1 });
      const d = await S.disk();
      const boxes = await S.eval(() => [...document.querySelectorAll('input.md-task')].map((b) => b.checked));
      return { ok: d === '- [ ] first\n- [x] second\n- [ ] third\n\nAfter.\n' && show(boxes) === '[false,true,false]', detail: `disk ${show(d)} boxes ${show(boxes)}` };
    },
  },
  {
    id: 'render.lists-tasks.e02',
    feature: 'render.lists-tasks',
    name: 'Clicking a ticked checkbox unticks it, and Undo ticks it again',
    run: async (S) => {
      const DOC = '- [x] done item\n\nAfter.\n';
      await fresh(S, 'untick-then-undo', DOC);
      await S.click({ sel: 'input.md-task' });
      const once = await S.disk();
      await S.toolbar('Undo');
      const twice = await S.disk();
      return { ok: once === '- [ ] done item\n\nAfter.\n' && twice === DOC, detail: `once ${show(once)} undone ${show(twice)}` };
    },
  },
  {
    id: 'render.lists-tasks.e03',
    feature: 'render.lists-tasks',
    name: 'In the torture sample, scrolling to the task list and clicking the "checked" box changes only that line',
    run: async (S) => {
      const orig = sample('edge/markdown-torture.md');
      const path = await S.open('edge/markdown-torture.md');
      const seen = await wheelTo(S, 'capital X');
      const idx = await S.eval(() => [...document.querySelectorAll('input.md-task')].findIndex((b) => /^\W*checked$/.test(b.closest('.cm-line').textContent.trim())));
      await S.click({ sel: 'input.md-task', nth: idx });
      const d = await S.disk(path);
      const want = orig.replace('- [x] checked\n', '- [ ] checked\n');
      return { ok: seen && d === want, detail: `seen ${seen} idx ${idx} changed lines ${show(d.split('\n').filter((l, i) => l !== orig.split('\n')[i]))}` };
    },
  },
  {
    id: 'render.lists-tasks.e04',
    feature: 'render.lists-tasks',
    name: 'Clicking the deepest nested task ticks only the nested line',
    run: async (S) => {
      await fresh(S, 'nested-tasks', '- [ ] parent\n  - [ ] nested\n    - [ ] deeper\n\nAfter.\n');
      await S.click({ sel: 'input.md-task', nth: 2 });
      const d = await S.disk();
      return { ok: d === '- [ ] parent\n  - [ ] nested\n    - [x] deeper\n\nAfter.\n', detail: show(d) };
    },
  },
  {
    id: 'render.lists-tasks.e05',
    feature: 'render.lists-tasks',
    name: 'Bullets written with -, * and + show a dot, numbers stay, and clicking an item types into its text',
    run: async (S) => {
      const DOC = '- one\n- two\n\n* star\n\n+ plus\n\n7. seven\n8. eight\n\n1) paren\n\nAfter.\n';
      await fresh(S, 'lists', DOC);
      const r = (await S.rendered()).split('\n');
      await S.caret('two', 1);
      await S.type('Z');
      const d = await S.disk();
      const ok = /^•\s+one$/.test(r[0]) && /^•\s+two$/.test(r[1]) && /^•\s+star$/.test(r[3]) && /^•\s+plus$/.test(r[5]) && r[7] === '7. seven' && r[10] === '1) paren' && d === DOC.replace('- two', '- tZwo');
      return { ok, detail: `rendered ${show(r)} disk ${show(d)}` };
    },
  },
  {
    id: 'render.lists-tasks.e06',
    feature: 'render.lists-tasks',
    name: 'An invalid task marker [~] shows its brackets as typed',
    run: async (S) => {
      await fresh(S, 'tilde-task', '- [~] not valid\n\nAfter.\n');
      await S.caret('valid', 1);
      const r = await line(S, 1);
      return { ok: r.includes('[~] not valid'), detail: show(r) };
    },
  },
  {
    id: 'render.lists-tasks.e07',
    feature: 'render.lists-tasks',
    name: 'After typing above a task list, clicking a checkbox still ticks its own line; formatted task text renders',
    run: async (S) => {
      await fresh(S, 'tasks-after-edit', 'Intro line.\n\n- [ ] with **bold** and `code`\n- [ ] plain\n');
      await S.caret('Intro', 2);
      await S.type('yz');
      await S.click({ sel: 'input.md-task', nth: 1 });
      const d = await S.disk();
      const r = (await S.rendered()).split('\n');
      return { ok: d === 'Inyztro line.\n\n- [ ] with **bold** and `code`\n- [x] plain\n' && !r[2].includes('**'), detail: `disk ${show(d)} rendered ${show(r)}` };
    },
  },
  {
    id: 'render.lists-tasks.e08',
    feature: 'render.lists-tasks',
    name: 'A task inside a blockquote shows a checkbox that ticks its own line',
    run: async (S) => {
      await fresh(S, 'quoted-task', '> - [ ] quoted task\n\nAfter.\n');
      await S.click({ sel: 'input.md-task' });
      const d = await S.disk();
      return { ok: d === '> - [x] quoted task\n\nAfter.\n', detail: show(d) };
    },
  },
  {
    id: 'render.lists-tasks.e09',
    feature: 'render.lists-tasks',
    name: 'Clicking a checkbox in a CRLF file ticks the right line and keeps CRLF',
    run: async (S) => {
      await fresh(S, 'tasks-crlf', '- [ ] alpha\r\n- [ ] beta\r\n\r\nAfter.\r\n');
      await S.click({ sel: 'input.md-task', nth: 1 });
      const d = await S.disk();
      return { ok: d === '- [ ] alpha\r\n- [x] beta\r\n\r\nAfter.\r\n', detail: show(d) };
    },
  },

  // ---------------------------------------------------------------- quotes
  {
    id: 'render.quotes.e01',
    feature: 'render.quotes',
    name: 'A quote hides its > and draws a rule, lazy continuation included, and clicking its second line types there',
    run: async (S) => {
      await fresh(S, 'quote', '> quoted **text** here\n> second line\nlazy line\n\nafter\n');
      const r = (await S.rendered()).split('\n');
      const st = await styleOf(S, 'quoted');
      const lazy = await styleOf(S, 'lazy line');
      await S.caret('second', 2);
      await S.type('Z');
      const d = await S.disk();
      const ok = !r[0].includes('>') && !r[1].includes('>') && r[2] === 'lazy line' && st.borderLeft >= 2 && lazy.borderLeft >= 2 && d === '> quoted **text** here\n> seZcond line\nlazy line\n\nafter\n';
      return { ok, detail: `rendered ${show(r)} border ${st.borderLeft}/${lazy.borderLeft} disk ${show(d)}` };
    },
  },
  {
    id: 'render.quotes.e02',
    feature: 'render.quotes',
    name: 'A callout-style quote keeps its label readable: the marker line reads as the callout type',
    run: async (S) => {
      // Since callouts, the marker line is drawn as the type's label, so a person reads
      // "Note" where the file says [!NOTE]. render.alert covers the drawing in full.
      await fresh(S, 'callout', '> [!NOTE]\n> Useful information.\n\nafter\n');
      await S.caret('Useful', 2);
      const r = await line(S, 1);
      await S.shot('callout');
      return { ok: r.trim() === 'Note', detail: show(r) };
    },
  },
  {
    id: 'render.quotes.e03',
    feature: 'render.quotes',
    name: 'Nested quotes and a quote with no space after > hide every marker',
    run: async (S) => {
      await fresh(S, 'quote-nested', '> > > Triple\n> Single.\n\n>No space.\n\nafter\n');
      await S.caret('Single', 2);
      const r = (await S.rendered()).split('\n');
      return { ok: [r[0], r[1], r[3]].every((t) => !t.includes('>')) && r[3].trim() === 'No space.', detail: show(r) };
    },
  },
  {
    id: 'render.quotes.e04',
    feature: 'render.quotes',
    name: 'A list and a fence inside a quote show a bullet and code font, with no > showing',
    run: async (S) => {
      await fresh(S, 'quote-mixed', '> - a list\n>\n> ```sh\n> echo hi\n> ```\n\nafter text\n');
      await S.caret('after', 2);
      const r = (await S.rendered()).split('\n');
      const code = await styleOf(S, 'echo hi');
      const body = await styleOf(S, 'after text');
      return { ok: r.slice(0, 5).every((t) => !t.includes('>')) && r[0].includes('•') && code.fontFamily !== body.fontFamily, detail: `rendered ${show(r)} code font ${show(code.fontFamily)}` };
    },
  },
  {
    id: 'render.quotes.e05',
    feature: 'render.quotes',
    name: 'A Hebrew quote with bold hides its markers',
    run: async (S) => {
      await fresh(S, 'quote-rtl', '> ציטוט עם **הדגשה** וגם.\n\nafter text\n');
      await S.caret('after', 2);
      const r = await line(S, 1);
      return { ok: !r.includes('>') && !r.includes('**') && r.includes('הדגשה'), detail: show(r) };
    },
  },

  // ---------------------------------------------------------------- code blocks
  {
    id: 'render.code-blocks.e01',
    feature: 'render.code-blocks',
    name: 'A fenced JavaScript block is monospace with coloured keywords, and clicking in it types into the code',
    run: async (S) => {
      await fresh(S, 'code-js', 'Intro text.\n\n```js\nconst answer = "yes"; // note\n```\n\nAfter.\n');
      await S.sleep(800);
      const colours = await S.eval(() => {
        const l = [...document.querySelectorAll('.cm-content > .cm-line')].find((x) => x.textContent.startsWith('const answer'));
        const kw = [...l.querySelectorAll('span')].find((s) => s.textContent === 'const');
        const str = [...l.querySelectorAll('span')].find((s) => s.textContent.includes('"yes"'));
        return { line: getComputedStyle(l).color, kw: kw && getComputedStyle(kw).color, str: str && getComputedStyle(str).color, font: getComputedStyle(l).fontFamily };
      });
      const body = await styleOf(S, 'Intro text');
      await S.caret('answer', 2);
      await S.type('Z');
      const d = await S.disk();
      const ok = colours.kw && colours.kw !== colours.line && colours.str && colours.str !== colours.line && colours.font !== body.fontFamily && d.includes('const anZswer = "yes"');
      return { ok, detail: `${show(colours)} body font ${show(body.fontFamily)} disk ${show(d)}` };
    },
  },
  {
    id: 'render.code-blocks.e02',
    feature: 'render.code-blocks',
    name: 'An indented code block shows in the code font, not the body font',
    run: async (S) => {
      await fresh(S, 'code-indented', 'Indented:\n\n    function indented() {\n      return 1;\n    }\n\nAfter.\n');
      await S.caret('After', 2);
      const code = await styleOf(S, 'function indented');
      const body = await styleOf(S, 'After');
      await S.shot('code-indented');
      return { ok: code.fontFamily !== body.fontFamily, detail: `code ${show(code.fontFamily)} body ${show(body.fontFamily)}` };
    },
  },
  {
    id: 'render.code-blocks.e03',
    feature: 'render.code-blocks',
    name: 'Markdown inside a fence shows as typed, typing there keeps it code, and Undo restores it',
    run: async (S) => {
      const DOC = 'Intro.\n\n```\n# not a heading\n- not a list\n**not bold**\n```\n\nAfter.\n';
      await fresh(S, 'code-md', DOC);
      await S.caret('not a list', 4);
      await S.type('Z');
      const r = (await S.rendered()).split('\n');
      const d = await S.disk();
      await S.toolbar('Undo');
      const undone = await S.disk();
      // Offset 4 of "not a list" is the "a", so Z lands before it.
      const ok = r[3] === '# not a heading' && r[4] === '- not Za list' && r[5] === '**not bold**' && d.includes('\n- not Za list\n') && undone === DOC;
      return { ok, detail: `rendered ${show(r)} disk ${show(d)} undone ${show(undone)}` };
    },
  },
  {
    id: 'render.code-blocks.e04',
    feature: 'render.code-blocks',
    name: 'Tilde fences, an unknown language and a four-backtick fence holding a fence all show in the code font',
    run: async (S) => {
      await fresh(S, 'code-fences', 'Intro text.\n\n~~~python\nprint(1)\n~~~\n\n```notalanguage\nstill code\n```\n\n````markdown\n```js\nconst n = 1;\n```\n````\n\nAfter text.\n');
      await S.caret('Intro', 2);
      const body = (await styleOf(S, 'After text')).fontFamily;
      const fonts = [];
      for (const n of ['print(1)', 'still code', 'const n = 1;']) fonts.push((await styleOf(S, n))?.fontFamily);
      return { ok: fonts.every((f) => f && f !== body), detail: `code ${show(fonts)} body ${show(body)}` };
    },
  },
  {
    id: 'render.code-blocks.e05',
    feature: 'render.code-blocks',
    name: 'A fence inside a list item and an unclosed fence at the end of the file show in the code font',
    run: async (S) => {
      await fresh(S, 'code-list-unclosed', 'Body text.\n\n- item:\n\n  ```js\n  const inList = 1;\n  ```\n\n```js\nconst unclosed = true;\nstill code at the end\n');
      await S.caret('Body', 2);
      const body = (await styleOf(S, 'Body text')).fontFamily;
      const fonts = [];
      for (const n of ['const inList', 'const unclosed', 'still code at the end']) fonts.push((await styleOf(S, n))?.fontFamily);
      return { ok: fonts.every((f) => f && f !== body), detail: `code ${show(fonts)} body ${show(body)}` };
    },
  },

  {
    id: 'render.code-blocks.e06',
    feature: 'render.code-blocks',
    name: 'A fence named py gets the same keyword colour as one named python',
    run: async (S) => {
      await fresh(S, 'code-py-short', 'Intro text.\n\n```python\nclass Full: pass\n```\n\n```py\nclass Short: pass\n```\n\nAfter text.\n');
      await S.caret('Intro', 2);
      await S.sleep(1200);
      const c = await S.eval(() => {
        const kw = (start) => {
          const l = [...document.querySelectorAll('.cm-content > .cm-line')].find((x) => x.textContent.startsWith(start));
          const s = l && [...l.querySelectorAll('span')].find((x) => x.textContent === 'class');
          return { line: l && getComputedStyle(l).color, kw: s ? getComputedStyle(s).color : null };
        };
        return { python: kw('class Full'), py: kw('class Short') };
      });
      await S.shot('code-py-short');
      const coloured = (x) => x.kw && x.kw !== x.line;
      return { ok: coloured(c.python) && coloured(c.py), detail: show(c) };
    },
  },

  // ---------------------------------------------------------------- rules
  {
    id: 'render.rules.e01',
    feature: 'render.rules',
    name: 'A rule draws a line with its dashes hidden, and Edit Markdown on it shows the dashes and puts them away again',
    run: async (S) => {
      // Double-click selects; Edit Markdown is what shows a block's Markdown.
      const DOC = 'Above text.\n\n---\n\nBelow text.\n';
      await fresh(S, 'rule', DOC);
      const before = await S.rendered();
      const hr = await S.exists('hr.md-hr');
      await S.click('hr.md-hr');
      await S.press('Meta+Alt+e');
      await S.sleep(300);
      const shown = await S.rendered();
      await S.press('Meta+Alt+e');
      await S.sleep(300);
      const after = await S.rendered();
      const d = await S.disk();
      return {
        ok: hr && !before.includes('---') && shown.includes('---') && !after.includes('---') && d === DOC,
        detail: `hr ${hr}; before ${show(before)}; with Edit Markdown ${show(shown)}; put away ${show(after)}; file ${d === DOC ? 'unchanged' : show(d)}`,
      };
    },
  },
  {
    id: 'render.rules.e02',
    feature: 'render.rules',
    name: 'Clicking text under a rule and typing leaves the rule untouched',
    run: async (S) => {
      await fresh(S, 'rule-below', 'Above text.\n\n---\n\nBelow text.\n');
      await S.caret('Below', 2);
      await S.type('Z');
      const d = await S.disk();
      return { ok: d === 'Above text.\n\n---\n\nBeZlow text.\n' && (await S.exists('hr.md-hr')), detail: show(d) };
    },
  },
  {
    id: 'render.rules.e03',
    feature: 'render.rules',
    name: '***, ___ and * * * each draw a rule',
    run: async (S) => {
      await fresh(S, 'rule-variants', 'Alpha\n\n***\n\nBravo\n\n___\n\nCharlie\n\n* * *\n\nDelta\n');
      await S.caret('Delta', 2);
      const n = await hrCount(S);
      const r = await S.rendered();
      return { ok: n === 3 && !/[*_]/.test(r), detail: `rules ${n} rendered ${show(r)}` };
    },
  },
  {
    id: 'render.rules.e04',
    feature: 'render.rules',
    name: 'Dashes right under a paragraph make a heading, not a rule, and two dashes stay text',
    run: async (S) => {
      await fresh(S, 'rule-setext', 'Text above\n---\n\n--\n\nend text\n');
      await S.caret('end', 1);
      const n = await hrCount(S);
      const r = (await S.rendered()).split('\n');
      const h = await styleOf(S, 'Text above');
      const body = await styleOf(S, 'end text');
      return { ok: n === 0 && r[3] === '--' && h.fontSize > body.fontSize, detail: `rules ${n} rendered ${show(r)} sizes ${h.fontSize}/${body.fontSize}` };
    },
  },
  {
    id: 'render.rules.e05',
    feature: 'render.rules',
    name: 'A rule on the first and on the last line of the file each draw a rule',
    run: async (S) => {
      await fresh(S, 'rule-edges', '***\n\nmiddle text\n\n***');
      await S.caret('middle', 2);
      const n = await hrCount(S);
      return { ok: n === 2, detail: `rules ${n} rendered ${show(await S.rendered())}` };
    },
  },

  // ---------------------------------------------------------------- links
  {
    id: 'render.rules.e06',
    feature: 'render.rules',
    name: 'A clicked divider is marked as selected, typing replaces it, one Cmd+Z brings it back, and a click on the text beside it leaves it alone',
    run: async (S) => {
      const DOC = 'Above text.\n\n---\n\nBelow text.\n';
      await fresh(S, 'rule-select', DOC);
      const lineOfRule = () => S.eval(() => {
        const l = document.querySelector('hr.md-hr')?.closest('.cm-line');
        if (!l) return null;
        const r = l.getBoundingClientRect();
        return { selected: l.classList.contains('sheaf-block-selected'), at: { x: r.left + 6, y: r.top + 3 }, mid: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
      });
      await S.caret('Below', 2);
      const plainLine = await lineOfRule();
      const plain = readPng(await S.shot('rule-unselected', { clipToEditor: false }));
      const hit = await S.click('hr.md-hr');
      await S.sleep(300);
      const picked = await lineOfRule();
      const dx = hit.x - picked.mid.x;
      const dy = hit.y - picked.mid.y;
      const shown = readPng(await S.shot('rule-selected', { clipToEditor: false }));
      const before = plain.atCss(plainLine.at.x + dx, plainLine.at.y + dy);
      const after = shown.atCss(picked.at.x + dx, picked.at.y + dy);
      await S.type('Z');
      await S.sleep(300);
      const typed = await S.disk();
      await S.press('Meta+z');
      await S.sleep(400);
      const undone = await S.disk();
      await S.caret('Above', 3);
      await S.sleep(300);
      const beside = await lineOfRule();
      const marked = picked.selected && apart(before, after) > 12;
      return {
        ok: marked && !typed.includes('Z---') && undone === DOC && beside && !beside.selected,
        detail: `selected ${picked.selected}, pixel ${showColour(before)} -> ${showColour(after)}; after typing Z ${show(typed)}; after Cmd+Z ${undone === DOC ? 'back as it was' : show(undone)}; after clicking Above the divider selected ${beside?.selected}`,
      };
    },
  },
  {
    id: 'render.links.e01',
    feature: 'render.links',
    name: 'Cmd-clicking a rendered link opens its address and leaves the file alone',
    run: async (S) => {
      const DOC = 'See [the site](https://example.com/page) today.\n\nNext.\n';
      await fresh(S, 'link-open', DOC);
      await captureOpens(S);
      await S.click({ text: 'the site', offset: 3 }, { modifiers: ['Meta'] });
      await S.sleep(300);
      const o = await opened(S);
      const d = await S.disk();
      return { ok: o.length === 1 && o[0] === 'https://example.com/page' && d === DOC, detail: `opened ${show(o)} disk ${show(d)}` };
    },
  },
  {
    id: 'render.links.e02',
    feature: 'render.links',
    name: 'A plain click on a link opens nothing and types into its text; a titled link shows no stray space',
    run: async (S) => {
      await fresh(S, 'link-plain', 'See [the site](https://example.com "Title") today.\n\nNext.\n');
      const r = await line(S, 1);
      await captureOpens(S);
      await S.caret('site', 2);
      await S.type('Z');
      const d = await S.disk();
      const o = await opened(S);
      return { ok: o.length === 0 && d.includes('[the siZte](https://example.com "Title")') && r === 'See the site today.', detail: `rendered ${show(r)} opened ${show(o)} disk ${show(d)}` };
    },
  },
  {
    id: 'render.links.e03',
    feature: 'render.links',
    name: 'Cmd-clicking a link whose address has parentheses opens the whole address',
    run: async (S) => {
      await fresh(S, 'link-parens', 'Read [the spec](https://example.com/a_(b)_c) first.\n\nNext.\n');
      const r = await line(S, 1);
      await captureOpens(S);
      await S.click({ text: 'spec', offset: 2 }, { modifiers: ['Meta'] });
      await S.sleep(300);
      const o = await opened(S);
      return { ok: o[0] === 'https://example.com/a_(b)_c' && r === 'Read the spec first.', detail: `rendered ${show(r)} opened ${show(o)}` };
    },
  },
  {
    id: 'render.links.e04',
    feature: 'render.links',
    name: 'A bare URL in a sentence is visible',
    run: async (S) => {
      await fresh(S, 'bare-url', 'The docs are at https://example.com/docs today.\n\nNext.\n');
      await S.caret('docs are', 1);
      const r = await line(S, 1);
      await S.shot('bare-url');
      return { ok: r === 'The docs are at https://example.com/docs today.', detail: show(r) };
    },
  },
  {
    id: 'render.links.e05',
    feature: 'render.links',
    name: 'Autolinks in angle brackets show their address and email',
    run: async (S) => {
      await fresh(S, 'autolink', 'Mail <someone@example.com> or visit <https://example.com/path>.\n\nNext.\n');
      await S.caret('Mail', 1);
      const r = await line(S, 1);
      return { ok: r.includes('someone@example.com') && r.includes('https://example.com/path'), detail: show(r) };
    },
  },
  {
    id: 'render.links.e06',
    feature: 'render.links',
    name: 'A reference link shows only its text, and Cmd-click opens the address from its definition',
    run: async (S) => {
      await fresh(S, 'ref-link', 'Read [the reference][ref] here.\n\n[ref]: https://example.com/reference\n');
      await captureOpens(S);
      const r = (await S.rendered()).split('\n');
      await S.click({ text: 'the reference', offset: 5 }, { modifiers: ['Meta'] });
      await S.sleep(300);
      const o = await opened(S);
      await S.shot('ref-link');
      return { ok: r[0] === 'Read the reference here.' && o[0] === 'https://example.com/reference', detail: `rendered ${show(r)} opened ${show(o)}` };
    },
  },
  {
    id: 'render.links.e07',
    feature: 'render.links',
    name: 'Cmd-clicking a link with an angle-bracket address opens that address',
    run: async (S) => {
      await fresh(S, 'link-angle', 'Open [the file](<https://example.com/a b>) now.\n\nNext.\n');
      const r = await line(S, 1);
      await captureOpens(S);
      await S.click({ text: 'the file', offset: 4 }, { modifiers: ['Meta'] });
      await S.sleep(300);
      const o = await opened(S);
      return { ok: /^https:\/\/example\.com\/a(%20| )b$/.test(o[0] || '') && r === 'Open the file now.', detail: `rendered ${show(r)} opened ${show(o)}` };
    },
  },
  {
    id: 'render.links.e08',
    feature: 'render.links',
    name: 'Brackets that are not links keep their brackets: footnote, citation, bracketed word',
    run: async (S) => {
      await fresh(S, 'brackets', 'A claim.[^1] See [1] and [draft].\n\nNext.\n');
      await S.caret('claim', 2);
      const r = await line(S, 1);
      await S.shot('brackets');
      return { ok: r === 'A claim.[^1] See [1] and [draft].', detail: show(r) };
    },
  },
  {
    id: 'render.links.e09',
    feature: 'render.links',
    name: 'A link with empty text leaves something visible where the link is',
    run: async (S) => {
      await fresh(S, 'empty-link', 'Empty text: [](https://example.com) end.\n\nNext.\n');
      await S.caret('Empty', 2);
      const r = await line(S, 1);
      return { ok: r.replace(/\s+/g, ' ') !== 'Empty text: end.', detail: show(r) };
    },
  },
  {
    id: 'render.links.e10',
    feature: 'render.links',
    name: 'A link inside bold and emphasis inside a link render, and Cmd-click on the italic word opens its link',
    run: async (S) => {
      await fresh(S, 'link-nested', '**[bold link](https://example.com/b)** and [*italic* link](https://example.com/i)\n\nNext.\n');
      const r = await line(S, 1);
      await captureOpens(S);
      await S.click({ text: 'italic', offset: 2 }, { modifiers: ['Meta'] });
      await S.sleep(300);
      const o = await opened(S);
      return { ok: r === 'bold link and italic link' && o[0] === 'https://example.com/i', detail: `rendered ${show(r)} opened ${show(o)}` };
    },
  },

  // ---------------------------------------------------------------- front matter
  {
    id: 'render.front-matter.e01',
    feature: 'render.front-matter',
    name: 'The front matter sample reads as quiet monospaced metadata, with no rule, heading or bullets inside it',
    run: async (S) => {
      // Front matter is drawn as muted monospaced text, smaller than the body, since it is
      // metadata for other tools. It is read at the top, before any scrolling can undraw it.
      const path = await S.open('edge/front-matter.md');
      await S.sleep(400);
      const m = await S.eval(() => {
        const ls = [...document.querySelectorAll('.cm-content > .cm-line')];
        const end = ls.findIndex((l) => l.textContent.includes('unicode:'));
        const fm = ls.slice(0, end + 1).filter((l) => l.textContent.trim() && l.textContent.trim() !== '---');
        const weight = ls.find((l) => l.textContent.startsWith('weight: 42'));
        const cs = weight ? getComputedStyle(weight) : null;
        return {
          seen: fm.length,
          notMarked: fm.filter((l) => !/tok-frontmatter/.test(l.className)).map((l) => l.textContent).slice(0, 3),
          flagged: fm.filter((l) => l.querySelector('hr.md-hr, .tok-bullet') || /tok-heading/.test(l.className)).map((l) => l.textContent),
          weight: cs && { family: cs.fontFamily, size: parseFloat(cs.fontSize) },
        };
      });
      await wheelTo(S, 'The block above');
      const body = await styleOf(S, 'The block above');
      await S.shot('front-matter');
      const d = await S.disk(path);
      const mono = !!m.weight && /mono|menlo|consolas|courier/i.test(m.weight.family);
      const ok = m.seen > 5 && m.notMarked.length === 0 && m.flagged.length === 0 && mono && body && m.weight.size < body.fontSize && d === sample('edge/front-matter.md');
      return { ok, detail: `${m.seen} lines; not drawn as front matter ${show(m.notMarked)}; heading, rule or bullet ${show(m.flagged)}; weight line ${show(m.weight)} against body ${body?.fontSize}px` };
    },
  },
  {
    id: 'render.front-matter.e02',
    feature: 'render.front-matter',
    name: 'Clicking a value in short front matter types into it, and the block is drawn as quiet metadata, not as a rule and heading',
    run: async (S) => {
      await fresh(S, 'fm-small', '---\ntitle: Hello\ndraft: true\n---\n\nBody text.\n');
      await S.caret('Hello', 2);
      await S.type('Z');
      const d = await S.disk();
      const title = await styleOf(S, 'title:');
      const body = await styleOf(S, 'Body text');
      const hr = await hrCount(S);
      const ok = d === '---\ntitle: HeZllo\ndraft: true\n---\n\nBody text.\n' && /tok-frontmatter/.test(title.cls) && title.fontSize < body.fontSize && !/tok-heading/.test(title.cls) && hr === 0;
      return { ok, detail: `disk ${show(d)} title ${show(title)} body size ${body.fontSize} rules ${hr}` };
    },
  },
  {
    id: 'render.front-matter.e03',
    feature: 'render.front-matter',
    name: 'A --- later in the document is a rule, and a front-matter-shaped block not at the top is a rule and a heading',
    run: async (S) => {
      await fresh(S, 'fm-not-top', '# Doc\n\n---\n\n---\ntitle: not front matter\n---\n\nend text\n');
      await S.caret('end', 1);
      const n = await hrCount(S);
      const t = await styleOf(S, 'title: not front matter');
      const body = await styleOf(S, 'end text');
      return { ok: n === 2 && t.fontSize > body.fontSize, detail: `rules ${n} title ${show(t)} body ${body.fontSize}` };
    },
  },
  {
    id: 'render.front-matter.e04',
    feature: 'render.front-matter',
    name: 'Front matter closed with ... draws no rule',
    run: async (S) => {
      await fresh(S, 'fm-dots', '---\ntitle: Dots\n...\n\nbody text\n');
      await S.caret('body', 2);
      const n = await hrCount(S);
      return { ok: n === 0, detail: `rules ${n} rendered ${show(await S.rendered())}` };
    },
  },

  // ---------------------------------------------------------------- html
  {
    id: 'render.html.e01',
    feature: 'render.html',
    name: 'In the HTML sample, inline tags keep their words readable, and typing inside <em> changes only that word',
    run: async (S) => {
      const path = await S.open('edge/html-embedded.md');
      const r = (await S.rendered()).split('\n').find((l) => l.startsWith('Text with'));
      await S.caret('emphasis', 2);
      await S.type('Z');
      const d = await S.disk(path);
      const want = sample('edge/html-embedded.md').replace('<em>emphasis</em>', '<em>emZphasis</em>');
      return { ok: d === want && r.includes('emphasis') && r.includes('strength'), detail: `line ${show(r)} diff lines ${show(d.split('\n').filter((l, i) => l !== want.split('\n')[i]))}` };
    },
  },
  {
    id: 'render.html.e02',
    feature: 'render.html',
    name: 'An HTML comment is hidden or styled apart from body text',
    run: async (S) => {
      await fresh(S, 'html-comment', 'Before text.\n\n<!-- invisible note -->\n\nAfter text.\n');
      await S.caret('Before', 2);
      const r = await S.rendered();
      const st = await S.eval(() => {
        const ls = [...document.querySelectorAll('.cm-content > .cm-line')];
        const l = ls.find((x) => x.textContent.includes('invisible note'));
        const s = l && [...l.querySelectorAll('span')].find((x) => x.textContent.includes('invisible note'));
        const body = ls.find((x) => x.textContent.includes('Before'));
        const cs = s ? getComputedStyle(s) : l ? getComputedStyle(l) : null;
        return cs && { color: cs.color, style: cs.fontStyle, bodyColor: getComputedStyle(body).color };
      });
      await S.shot('html-comment');
      const ok = !r.includes('invisible note') || (st && (st.color !== st.bodyColor || st.style === 'italic'));
      return { ok, detail: `rendered ${show(r)} style ${show(st)}` };
    },
  },
  {
    id: 'render.html.e03',
    feature: 'render.html',
    name: 'Script and style blocks in the HTML sample stay inert text and raise no errors',
    run: async (S) => {
      await S.open('edge/html-embedded.md');
      await S.errors();
      const seen = await wheelTo(S, 'this must not run');
      await S.caret('rebeccapurple', 3);
      const probe = await S.eval(() => {
        const l = [...document.querySelectorAll('.cm-content > .cm-line')].find((x) => x.textContent.includes('If styles were applied'));
        return { scripts: document.querySelectorAll('.cm-content script, .cm-content style').length, color: l && getComputedStyle(l).color };
      });
      const errs = await S.errors();
      const ok = seen && probe.scripts === 0 && probe.color !== 'rgb(102, 51, 153)' && errs.length === 0;
      return { ok, detail: `seen ${seen} ${show(probe)} errors ${show(errs)}` };
    },
  },
  {
    id: 'render.html.e04',
    feature: 'render.html',
    name: 'Character entities read as the characters they name',
    run: async (S) => {
      await fresh(S, 'entities', 'AT&amp;T &copy; 2044 &mdash; done.\n\nNext.\n');
      await S.caret('done', 1);
      const r = await line(S, 1);
      return { ok: r === 'AT&T © 2044 — done.', detail: show(r) };
    },
  },
  {
    id: 'render.html.e05',
    feature: 'render.html',
    name: 'Markdown inside a <details> element renders bold and bullets',
    run: async (S) => {
      await fresh(S, 'html-details', '<details>\n<summary>More</summary>\n\nThis is **inside** it.\n\n- a list item\n\n</details>\n');
      await S.caret('inside', 2);
      const r = (await S.rendered()).split('\n');
      return { ok: r[3] === 'This is inside it.' && /^•\s+a list item$/.test(r[5]), detail: show(r) };
    },
  },

  {
    id: 'render.html.e06',
    feature: 'render.html',
    name: 'Key caps, subscript and superscript draw as formatting off the caret line, without making their lines taller',
    run: async (S) => {
      await S.open('edge/html-embedded.md');
      // A line well away from the three being measured, and at the top, where the file opens.
      await S.caret('escape hatch', 2);
      const r = (await S.rendered()).split('\n');
      const keys = r.find((l) => l.startsWith('Keyboard:'));
      const sci = r.find((l) => l.startsWith('Scientific'));
      const probe = await S.eval(() => {
        const ls = [...document.querySelectorAll('.cm-content > .cm-line')];
        const find = (t) => ls.find((x) => x.textContent.includes(t));
        const kbd = [...document.querySelectorAll('.tok-html-kbd')].map((k) => {
          const cs = getComputedStyle(k);
          return { text: k.textContent, top: cs.borderTopWidth, bottom: cs.borderBottomWidth, border: cs.borderTopStyle };
        });
        const h = (t) => Math.round(find(t)?.getBoundingClientRect().height ?? -1);
        return { kbd, sci: h('Scientific'), keys: h('Keyboard'), plain: h('Text with') };
      });
      await S.shot('html-kbd-sub-sup');
      const capsDrawn =
        probe.kbd.length === 3 && probe.kbd.every((k) => k.border === 'solid' && k.top === '1px' && k.bottom === '2px');
      // A key cap's padding and border may add a pixel or two; sub and sup must not open the line up.
      const heightsHeld = probe.sci <= probe.plain + 1 && probe.keys <= probe.plain + 4;
      const tagsHidden = !keys.includes('<kbd>') && !sci.includes('<sub>') && !sci.includes('<sup>');
      return {
        ok: capsDrawn && heightsHeld && tagsHidden,
        detail: `lines ${show([keys, sci])} probe ${show(probe)}`,
      };
    },
  },

  // ---------------------------------------------------------------- unicode
  {
    id: 'render.unicode.e01',
    feature: 'render.unicode',
    name: 'Clicking after an emoji inside bold types in the right place',
    run: async (S) => {
      const path = await S.open('edge/unicode-and-i18n.md');
      await wheelTo(S, 'Emoji inside');
      await S.caret('🚢 text', 3);
      await S.type('Z');
      const d = await S.disk(path);
      const want = sample('edge/unicode-and-i18n.md').replace('**bold 🚢 text**', '**bold 🚢 Ztext**');
      return { ok: d === want, detail: `diff ${show(d.split('\n').filter((l, i) => l !== want.split('\n')[i]))}` };
    },
  },
  {
    id: 'render.unicode.e02',
    feature: 'render.unicode',
    name: 'A long unbroken word wraps inside the column, with no sideways scroll, and typing into it works',
    run: async (S) => {
      const path = await S.open('edge/unicode-and-i18n.md');
      const seen = await wheelTo(S, 'Pneumono');
      const geo = await S.eval(() => {
        const sc = document.querySelector('.cm-scroller');
        const l = [...document.querySelectorAll('.cm-content > .cm-line')].find((x) => x.textContent.startsWith('Pneumono'));
        const c = document.querySelector('.cm-content').getBoundingClientRect();
        const r = l.getBoundingClientRect();
        return { sw: sc.scrollWidth, cw: sc.clientWidth, lineRight: Math.round(r.right), contentRight: Math.round(c.right), h: Math.round(r.height) };
      });
      await S.shot('long-word');
      await S.caret('Pneumono', 3);
      await S.type('Z');
      const d = await S.disk(path);
      const ok = seen && geo.sw <= geo.cw + 1 && geo.lineRight <= geo.contentRight + 1 && d.includes('PneZumono');
      return { ok, detail: `seen ${seen} ${show(geo)} typed ${d.includes('PneZumono')}` };
    },
  },
  {
    id: 'render.unicode.e03',
    feature: 'render.unicode',
    name: 'The long bare URL in the unicode sample is visible',
    run: async (S) => {
      await S.open('edge/unicode-and-i18n.md');
      await wheelTo(S, 'A long URL that should wrap');
      await S.caret('A long URL', 3);
      const r = (await S.rendered()).split('\n');
      const i = r.findIndex((l) => l.startsWith('A long URL'));
      return { ok: r.slice(i, i + 3).some((l) => l.includes('https://example.com/a/very/long/path')), detail: show(r.slice(i, i + 3)) };
    },
  },
  {
    id: 'render.unicode.e04',
    feature: 'render.unicode',
    name: 'Clicking inside a Vietnamese word with stacked accents types between the right letters',
    run: async (S) => {
      const path = await S.open('edge/unicode-and-i18n.md');
      await wheelTo(S, 'Tiếng Việt');
      await S.caret('Tiếng', 2);
      await S.type('Z');
      const d = await S.disk(path);
      return { ok: d.includes('TiZếng Việt'), detail: show(d.split('\n').find((l) => l.includes('Vietnamese'))) };
    },
  },
  {
    id: 'render.unicode.e05',
    feature: 'render.unicode',
    name: 'ZWJ emoji, flags, keycaps and zero-width characters stay intact, and highlight around CJK renders',
    run: async (S) => {
      const s = 'ZWJ 👨‍👩‍👧‍👦 🏴󠁧󠁢󠁳󠁣󠁴󠁿 1️⃣ a​b ⁠‌﻿ end';
      await fresh(S, 'unicode-intact', `${s}\n\n==重要== と *🚢* here\n`);
      await S.caret('here', 2);
      const r = (await S.rendered()).split('\n');
      return { ok: r[0] === s && r[2] === '重要 と 🚢 here', detail: show(r) };
    },
  },

  // ---------------------------------------------------------------- double-click reveal
  {
    id: 'render.reveal-double-click.e01',
    feature: 'render.reveal-double-click',
    name: 'Double-clicking bold text shows that paragraph as Markdown, and typing replaces the word clicked',
    run: async (S) => {
      await fresh(S, 'dbl-bold', 'Some **bold** text here.\n\nAnother *line* below.\n');
      await S.dblclick({ text: 'bold', offset: 2 });
      const r = (await S.rendered()).split('\n');
      await S.type('Z');
      const d = await S.disk();
      const after = await line(S, 1);
      // The reveal selects the word under the pointer, so the letter typed next replaces it.
      const ok = r[0] === 'Some **bold** text here.' && r[2] === 'Another line below.' && d.includes('**Z**') && after === 'Some **Z** text here.';
      return { ok, detail: `rendered ${show(r)} after typing ${show(after)} disk ${show(d)}` };
    },
  },
  {
    id: 'render.reveal-double-click.e02',
    feature: 'render.reveal-double-click',
    name: 'Clicking another paragraph after a double-click hides the Markdown again',
    run: async (S) => {
      await fresh(S, 'dbl-away', 'Some **bold** text here.\n\nAnother *line* below.\n');
      await S.dblclick({ text: 'bold', offset: 2 });
      const shown = await line(S, 1);
      await S.caret('Another', 2);
      const hidden = await line(S, 1);
      return { ok: shown === 'Some **bold** text here.' && hidden === 'Some bold text here.', detail: `shown ${show(shown)} after ${show(hidden)}` };
    },
  },
  {
    id: 'render.reveal-double-click.e03',
    feature: 'render.reveal-double-click',
    name: 'Double-clicking a heading shows its hashes and selects the word clicked',
    run: async (S) => {
      await fresh(S, 'dbl-heading', '## Heading two\n\nBody text.\n');
      await S.dblclick({ text: 'Heading', offset: 2 });
      const r = await line(S, 1);
      const st = await S.state();
      // With the hashes shown, "Heading" runs from 3 to 10, and the reveal selects it.
      const picked = Math.min(st.anchor, st.head) === 3 && Math.max(st.anchor, st.head) === 10;
      return { ok: r === '## Heading two' && picked && st.focused, detail: `rendered ${show(r)} state ${show({ a: st.anchor, h: st.head, f: st.focused })}` };
    },
  },
  {
    id: 'render.reveal-double-click.e04',
    feature: 'render.reveal-double-click',
    name: 'Double-clicking a task item shows that item as Markdown and leaves the rest of the list drawn',
    run: async (S) => {
      await fresh(S, 'dbl-list', '- [ ] one task\n- [x] two task\n\nAfter.\n');
      await S.dblclick({ text: 'one', offset: 1 });
      const r = (await S.rendered()).split('\n');
      // A list item reveals on its own, with anything nested under it, rather than taking the list with it.
      return { ok: r[0] === '- [ ] one task' && r[1] !== '- [x] two task' && r[1].includes('two task'), detail: show(r) };
    },
  },
  {
    id: 'render.reveal-double-click.e05',
    feature: 'render.reveal-double-click',
    name: 'After a double-click, pressing End and typing keeps the Markdown shown',
    run: async (S) => {
      await fresh(S, 'dbl-end', 'A **bold** word\n\nNext paragraph.\n');
      await S.dblclick({ text: 'word', offset: 2 });
      await S.press('End');
      await S.type('XY');
      const r = await line(S, 1);
      const d = await S.disk();
      await S.shot('dbl-end');
      return { ok: r === 'A **bold** wordXY' && d.startsWith('A **bold** wordXY\n'), detail: `rendered ${show(r)} disk ${show(d)}` };
    },
  },
  {
    id: 'render.reveal-double-click.e06',
    feature: 'render.reveal-double-click',
    name: 'Double-clicking a blank line between paragraphs and typing puts the letter on that blank line',
    run: async (S) => {
      const DOC = 'First para.\n\n\n\nSecond para.\n';
      await fresh(S, 'dbl-blank', DOC);
      const a = await S.locate({ text: 'First', offset: 1 });
      const b = await S.locate({ text: 'Second', offset: 1 });
      await S.dblclick({ x: a.x, y: (a.y + b.y) / 2 });
      await S.type('Z');
      const d = await S.disk();
      const lines = d.split('\n');
      const zAt = lines.findIndex((l) => l.includes('Z'));
      return { ok: d.replace('Z', '') === DOC && lines[zAt] === 'Z' && zAt > 0 && zAt < 4, detail: `disk ${show(d)}` };
    },
  },
  {
    id: 'render.reveal-double-click.e08',
    feature: 'render.reveal-double-click',
    name: 'A change on disk above a double-clicked paragraph keeps that paragraph showing its Markdown',
    run: async (S) => {
      const DOC = 'Intro line.\n\nSome **bold** text here.\n\nAnother *line* below.\n';
      const path = await fresh(S, 'dbl-outside', DOC);
      await S.dblclick({ text: 'bold', offset: 2 });
      const shown = (await S.rendered()).split('\n')[2];
      await S.writeDisk('Added by git.\n\n' + DOC, path);
      await S.sleep(500);
      const r = (await S.rendered()).split('\n');
      return { ok: shown === 'Some **bold** text here.' && r[4] === 'Some **bold** text here.' && r[6] === 'Another line below.', detail: `before ${show(shown)} after ${show(r)}` };
    },
  },
  {
    id: 'render.reveal-double-click.e09',
    feature: 'render.reveal-double-click',
    name: 'Deleting a double-clicked paragraph leaves the next paragraph rendered',
    run: async (S) => {
      await fresh(S, 'dbl-delete', 'Some **bold** text here.\n\nAnother *line* below.\n');
      await S.dblclick({ text: 'bold', offset: 2 });
      await S.select('Some **bold** text here.');
      await S.press('Backspace');
      const d = await S.disk();
      const r = (await S.rendered()).split('\n').find((l) => l.includes('Another'));
      return { ok: d === '\n\nAnother *line* below.\n' && r === 'Another line below.', detail: `disk ${show(d)} line ${show(r)}` };
    },
  },

  // ---------------------------------------------------------------- reveal on line (setting); these change user settings and restore them
  {
    id: 'render.reveal-on-line.e01',
    feature: 'render.reveal-on-line',
    name: 'With the setting on, clicking a line shows its Markdown and clicking another line hides it again',
    run: async (S) => {
      await setSettings(S, { 'sheaf.revealSyntaxOnLine': true });
      try {
        await fresh(S, 'rol', 'A **bold** one here.\n\nB *italic* two here.\n');
        await S.caret('bold', 2);
        const r1 = (await S.rendered()).split('\n');
        await S.caret('italic', 2);
        const r2 = (await S.rendered()).split('\n');
        const ok = r1[0] === 'A **bold** one here.' && r1[2] === 'B italic two here.' && r2[0] === 'A bold one here.' && r2[2] === 'B *italic* two here.';
        return { ok, detail: `first ${show(r1)} then ${show(r2)}` };
      } finally {
        await setSettings(S, { 'sheaf.revealSyntaxOnLine': false });
      }
    },
  },
  {
    id: 'render.reveal-on-line.e02',
    feature: 'render.reveal-on-line',
    name: 'With the setting on, clicking the first line of a two-line quote shows the markers of the whole quote',
    run: async (S) => {
      await setSettings(S, { 'sheaf.revealSyntaxOnLine': true });
      try {
        await fresh(S, 'rol-quote', '> first **line** here\n> second **line** here\n\nafter\n');
        await S.caret('first', 2);
        const r = (await S.rendered()).split('\n');
        return { ok: r[0].startsWith('>') && r[1].startsWith('>'), detail: show(r) };
      } finally {
        await setSettings(S, { 'sheaf.revealSyntaxOnLine': false });
      }
    },
  },
  {
    id: 'render.reveal-on-line.e03',
    feature: 'render.reveal-on-line',
    name: 'Turning the setting off while the caret sits on a revealed line hides its markers without another click',
    run: async (S) => {
      await setSettings(S, { 'sheaf.revealSyntaxOnLine': true });
      try {
        await fresh(S, 'rol-live', 'A **bold** one here.\n\nafter text\n');
        await S.caret('bold', 2);
        const on = await line(S, 1);
        await setSettings(S, { 'sheaf.revealSyntaxOnLine': false });
        const off = await line(S, 1);
        await S.caret('after', 2);
        const moved = await line(S, 1);
        return { ok: on === 'A **bold** one here.' && off === 'A bold one here.', detail: `on ${show(on)} after setting off ${show(off)} after a click elsewhere ${show(moved)}` };
      } finally {
        await setSettings(S, { 'sheaf.revealSyntaxOnLine': false });
      }
    },
  },
  {
    id: 'render.reveal-on-line.e04',
    feature: 'render.reveal-on-line',
    name: 'With the setting on, dragging a selection over two lines shows both lines as Markdown and leaves a third rendered',
    run: async (S) => {
      await setSettings(S, { 'sheaf.revealSyntaxOnLine': true });
      try {
        await fresh(S, 'rol-drag', 'A **alpha** one\nB **beta** two\n\nC **gamma** three\n');
        await S.drag({ text: 'alpha', offset: 1 }, { text: 'beta', offset: 2 });
        const r = (await S.rendered()).split('\n');
        return { ok: r[0].includes('**alpha**') && r[1].includes('**beta**') && r[3] === 'C gamma three', detail: show(r) };
      } finally {
        await setSettings(S, { 'sheaf.revealSyntaxOnLine': false });
      }
    },
  },
  {
    id: 'render.reveal-double-click.e07',
    feature: 'render.reveal-double-click',
    name: 'With double-click-to-edit off, double-clicking selects the word and keeps the Markdown hidden',
    run: async (S) => {
      await setSettings(S, { 'sheaf.doubleClickToEditSource': false });
      try {
        await fresh(S, 'dbl-off', 'Some **bold** text here.\n\nNext.\n');
        await S.dblclick({ text: 'bold', offset: 2 });
        const r = await line(S, 1);
        const st = await S.state();
        const sel = st.doc.slice(Math.min(st.anchor, st.head), Math.max(st.anchor, st.head));
        return { ok: r === 'Some bold text here.' && sel === 'bold', detail: `rendered ${show(r)} selected ${show(sel)}` };
      } finally {
        await setSettings(S, { 'sheaf.doubleClickToEditSource': true });
      }
    },
  },

  // ---------------------------------------------------------------- large documents
  // Thresholds: a 3,000-line file shows its first text within 2,000 ms of Enter; a typed letter
  // appears on screen within 100 ms at the median and 200 ms at worst; and it reaches the file
  // within 1,700 ms (Sheaf's 700 ms auto-save pause plus a second for VS Code to write).
  {
    id: 'render.large-docs.e01',
    feature: 'render.large-docs',
    name: 'The 3,148-line handbook opens within 2 s, and typed letters show within 100 ms and reach the file within 1.7 s',
    run: async (S) => {
      await fresh(S, 'warmup', 'Warm up.\n');
      await S.cleanup();
      const openMs = await openTimed(S, 'stress/long-handbook.md', 'Operations Handbook');
      const path = join(S.ws, 'stress/long-handbook.md');
      await S.caret('long-form', 2);
      await watchLatency(S);
      await S.page.keyboard.type('abcdefghij', { delay: 60 });
      const t0 = Date.now();
      let fileMs = Infinity;
      while (Date.now() - t0 < 6000) {
        if (readFileSync(path, 'utf8').includes('loabcdefghijng-form')) {
          fileMs = Date.now() - t0;
          break;
        }
        await S.sleep(25);
      }
      await S.sleep(200);
      const lat = (await S.eval(() => window.__lat)).slice().sort((a, b) => a - b);
      const median = lat[Math.floor(lat.length / 2)];
      const worst = lat.at(-1);
      const ok = openMs <= 2000 && lat.length >= 10 && median <= 100 && worst <= 200 && fileMs <= 1700;
      return { ok, detail: `open ${openMs} ms, letter-on-screen ms ${show(lat)} (median ${median}, worst ${worst}), last letter to file ${fileMs} ms` };
    },
  },
  {
    id: 'render.large-docs.e02',
    feature: 'render.large-docs',
    name: 'Jumping to the end of the handbook renders the last heading, and clicking it types there',
    run: async (S) => {
      const path = await S.open('stress/long-handbook.md');
      // e01 types into "long-form", so click words nothing else edits ("of the kind people actually keep").
      await S.caret('the kind people', 5);
      await S.press('Meta+ArrowDown');
      await S.sleep(800);
      // Where Cmd+Down left the caret: the handbook has 3,148 lines.
      const atEnd = await S.state();
      // The last heading is about 50 lines above the end, so scroll up to it with the wheel.
      const seen = await wheelTo(S, 'Immutable Buffer Behaviour', { dy: -300 });
      const r = await S.rendered();
      const hd = await styleOf(S, 'Immutable Buffer Behaviour');
      await S.caret('Immutable Buffer', 3);
      await S.type('Z');
      const d = await S.disk(path);
      const ok = atEnd.line > 3100 && seen && r.split('\n').includes('Immutable Buffer Behaviour') && hd && /tok-h2/.test(hd.cls) && d.includes('\n## ImmZutable Buffer Behaviour\n');
      return { ok, detail: `caret line after Cmd+Down ${atEnd.line} of ${atEnd.doc.split('\n').length}, heading seen ${seen} ${show(hd)} typed ${d.includes('ImmZutable')}` };
    },
  },
  {
    id: 'render.large-docs.e03',
    feature: 'render.large-docs',
    name: 'The code-heavy sample opens within 2 s and its last TypeScript block is highlighted after jumping there',
    run: async (S) => {
      const openMs = await openTimed(S, 'stress/code-heavy.md', 'Code-Heavy Document');
      await S.caret('Two hundred', 3);
      await S.press('Meta+ArrowDown');
      await S.sleep(1200);
      // The last ```ts block (line 2726): ```py blocks are covered separately by code-blocks.e06.
      await S.caret('interface DigestOptions', 4);
      const c = await S.eval(() => {
        const ls = [...document.querySelectorAll('.cm-content > .cm-line')].filter((x) => x.textContent.startsWith('export interface DigestOptions'));
        const l = ls.at(-1);
        const kw = l && [...l.querySelectorAll('span')].find((s) => s.textContent === 'export' || s.textContent === 'interface');
        return { line: l && getComputedStyle(l).color, kw: kw && getComputedStyle(kw).color };
      });
      const st = await S.state();
      const ok = openMs <= 2000 && c.kw && c.kw !== c.line && st.line > 2700;
      return { ok, detail: `open ${openMs} ms, colours ${show(c)}, caret line ${st.line}` };
    },
  },
  {
    id: 'render.large-docs.e04',
    feature: 'render.large-docs',
    name: 'The tenth nesting level shows a bullet and clicking its text types there',
    run: async (S) => {
      const path = await S.open('stress/deep-nesting.md');
      const r = (await S.rendered()).split('\n').find((l) => l.includes('Level 10:'));
      await S.caret('Level 10', 3);
      await S.type('Z');
      const d = await S.disk(path);
      return { ok: /^\s*•/.test(r || '') && d.includes('LevZel 10:'), detail: `line ${show(r)} typed ${d.includes('LevZel 10:')}` };
    },
  },
];

// The double-click reveal ships behind `sheaf.doubleClickToEditSource`, which is off by default, so
// its scenarios run in the `reveal-source` area, which turns the setting on. Running them here would
// fail for describing behaviour that is no longer what a double-click does out of the box.
export const revealDoubleClick = allScenarios.filter((s) => s.feature === 'render.reveal-double-click');
export const scenarios = allScenarios.filter((s) => s.feature !== 'render.reveal-double-click');
