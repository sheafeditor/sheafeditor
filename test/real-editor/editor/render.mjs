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
    return {
      cls: l.className,
      fontSize: parseFloat(cs.fontSize),
      fontFamily: cs.fontFamily,
      color: cs.color,
      borderLeft: parseFloat(cs.borderLeftWidth),
      fontWeight: cs.fontWeight,
      // A quote's rule is a repeating gradient rather than a border, one band per level of
      // nesting, so its width is what says how many levels are drawn. `backgroundSize` resolves
      // to pixels here, which is why it is worth reading at all.
      backgroundImage: cs.backgroundImage,
      backgroundSize: cs.backgroundSize,
    };
  }, needle);

const hrCount = (S) => S.eval(() => document.querySelectorAll('hr.md-hr').length);

/**
 * Every rendered line's text and drawn height, in document order, for the checks
 * that a blank line is a line. `cls` is there so a failure can say what was on a
 * line whose height came out wrong.
 */
const lineBoxes = (S) =>
  S.eval(() =>
    [...document.querySelectorAll('.cm-content > .cm-line')].map((l) => ({
      text: l.textContent,
      cls: l.className,
      height: Math.round(l.getBoundingClientRect().height),
    }))
  );

/** How far from the top and bottom edges a line has to be before it counts as on screen. */
const WHEEL_MARGIN = 40;

/**
 * Scroll with the mouse wheel over the editor until `needle` is rendered on screen.
 *
 * **The step has to be smaller than the band it is aiming at, or the target can jump clean over
 * it.** A line counts as arrived when it sits `WHEEL_MARGIN` inside both edges, so the band is
 * the window less twice that; a step wider than the band can take the line from below it to
 * above it in one turn, and then every remaining turn only scrolls further past. What that looks
 * like is not a scroll that stops in the wrong place, it is 80 turns to the bottom of the
 * document and a target that was never drawn, which reads as the element not existing.
 *
 * It was a flat 700px against a band of about 620 in a driven VS Code window, so whether a given
 * line was reachable depended on where in the document it happened to fall. A change that made
 * list items 4px taller moved one line from a step that landed to one that jumped, and the
 * scenario failed with "no visible element". The step is capped here instead, so the arithmetic
 * cannot be wrong: at most three fifths of the band per turn means at least two turns inside it.
 *
 * An explicit `dy` is still honoured for direction and for a deliberately small step, and only
 * its magnitude is capped.
 */
async function wheelTo(S, needle, { dy = 700, max = 80 } = {}) {
  const f = await S.frame();
  const box = await (await f.frameElement()).boundingBox();
  await S.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const band = await S.eval((margin) => window.innerHeight - 2 * margin, WHEEL_MARGIN);
  const step = Math.sign(dy) * Math.min(Math.abs(dy), Math.max(120, Math.round(band * 0.6)));
  for (let i = 0; i < max; i++) {
    const seen = await S.eval(
      ([needle, margin]) => {
        const l = [...document.querySelectorAll('.cm-content > .cm-line')].find((x) => x.textContent.includes(needle));
        if (!l) return false;
        const r = l.getBoundingClientRect();
        return r.top > margin && r.bottom < window.innerHeight - margin;
      },
      [needle, WHEEL_MARGIN]
    );
    if (seen) return true;
    await S.page.mouse.wheel(0, step);
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
      /*
       * No space between a marker and its words. A marker takes the source space after it off
       * the screen with it, and the gap a reader sees is drawn by the box the marker sits in
       * rather than typed into the line. The number and its delimiter are still the document's
       * own text, which is what these two rows are for.
       */
      const ok = /^•one$/.test(r[0]) && /^•two$/.test(r[1]) && /^•star$/.test(r[3]) && /^•plus$/.test(r[5]) && r[7] === '7.seven' && r[10] === '1)paren' && d === DOC.replace('- two', '- tZwo');
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
      /*
       * The rule is a repeating gradient now rather than a `border-left`, one band per level of
       * nesting, so `borderLeft` reads 0 on a correctly drawn quote and asserting it would fail
       * for the wrong reason. What is asserted instead is that the gradient is there and that it
       * is one level wide, 20px, on both the quote's own line and its lazy continuation.
       *
       * This says the rule is configured, not that it is painted, and those are different
       * questions: a gradient that resolves and paints nothing would satisfy this. The painted
       * pixel is read in `scripts/check-indent.mjs`, which takes a screenshot and compares 2px
       * into a band against the gap 12px in, on the same line so the control cannot drift.
       */
      const ruled = (s) => s && /gradient/.test(s.backgroundImage) && parseFloat(s.backgroundSize) === 20;
      const ok = !r[0].includes('>') && !r[1].includes('>') && r[2] === 'lazy line' && ruled(st) && ruled(lazy) && d === '> quoted **text** here\n> seZcond line\nlazy line\n\nafter\n';
      return { ok, detail: `rendered ${show(r)} rule ${st.backgroundSize}/${lazy.backgroundSize} gradient ${/gradient/.test(st.backgroundImage)} disk ${show(d)}` };
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
      // The text above, which is where the bar that floats over a selection would sit
      // if a selected divider raised one. It raises none, so the press reaches the text.
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
    name: 'A plain click on a titled link opens it, changes nothing, and the title leaves no stray space',
    run: async (S) => {
      await fresh(S, 'link-plain', 'See [the site](https://example.com "Title") today.\n\nNext.\n');
      /*
       * Rewritten on 2026-09-30 for the design 0.2.0 shipped, in the changelog's own words: "A
       * plain click used to put the caret in a link's words and nothing else, so following one
       * meant knowing to hold Cmd ... Now a click opens it, everywhere a link is drawn". So
       * `o.length === 0` was asking for the old rule, and this failed against a build doing the
       * right thing. `docs/features/links.md` says the same twice: "Click the link. Cmd-click does
       * the same", and its keys table reads "Cmd-click: Follows the link, as a plain click does".
       *
       * An earlier changelog entry says prose keeps the modifier. The entry above supersedes it,
       * and `releaseOnLinkIn` in `linkGesture.ts` is what settles which is current: a plain press
       * returns a hold and the release opens the address.
       *
       * The stray-space half of the old scenario is kept, because it is about something else and
       * still holds: a link carrying a `"Title"` must not draw a space where the title was.
       *
       * **What is asserted is the click's own effect on the file, not the effect of typing after
       * it.** The old version typed a letter to show the caret had landed in the link's words,
       * which was asserting the premise of the design that was replaced. Whether a click that
       * opens a link should also leave the caret ready to type into that link's words is not a
       * question a scenario should decide, and the page leans the other way: "What you cannot do
       * with the mouse is pick out a link's words and nothing else." What is not in question is
       * that opening a link must not change the document.
       *
       * The before-state is read from disk rather than written out a second time, so the two
       * cannot drift apart: a fixture repeated in an assertion is a second copy of the same fact.
       */
      const before = await S.disk();
      const r = await line(S, 1);
      await captureOpens(S);
      await S.click({ text: 'site', offset: 2 });
      await S.sleep(400);
      const d = await S.disk();
      const o = await opened(S);
      return {
        ok: o[0] === 'https://example.com' && r === 'See the site today.' && d === before,
        detail: `rendered ${show(r)} opened ${show(o)} disk ${show(d)}${d === before ? '' : '; the file changed'}`,
      };
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
      // No space after the bullet: the marker takes the source space with it and the box draws
      // the gap. See render.lists-tasks.e05.
      return { ok: r[3] === 'This is inside it.' && /^•a list item$/.test(r[5]), detail: show(r) };
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
    /*
     * This used to require the `>` on both lines, and a quote is the one marker in
     * Sheaf deliberately kept hidden on a revealed line.
     *
     * The `>` used to show, dim, and the reason recorded for it was "so the quote
     * rule persists", which was true while the rule was a `border-left` on a line
     * that had a `>` on it. The rule is a repeating gradient on the line itself now,
     * one band per level, and survives whether the marker is drawn or not: the reason
     * expired and the exception outlived it. What it cost was a quote's words moving
     * 14px right as the caret arrived and back as it left, because the drawn `> ` sat
     * in front of words the computed indent had already made room for.
     *
     * So what this asserts is the pair: the line does reveal, which its own `**`
     * proves, and the `>` is not what it reveals. Without the first half it would
     * pass on a change that stopped revealing anything at all, which is the whole of
     * what a reveal scenario is for.
     */
    name: 'With the setting on, clicking one line of a two-line quote shows both lines\' markers, and neither line\'s `>`',
    run: async (S) => {
      await setSettings(S, { 'sheaf.revealSyntaxOnLine': true });
      try {
        await fresh(S, 'rol-quote', '> first **line** here\n> second **line** here\n\nafter\n');
        await S.caret('first', 2);
        const r = (await S.rendered()).split('\n');
        const revealed = r[0].includes('**line**') && r[1].includes('**line**');
        const noMarker = !r[0].includes('>') && !r[1].includes('>');
        // The control that the setting is doing anything at all: the line below the
        // quote is not part of it and is rendered, so `after` carries no markers.
        return {
          ok: revealed && noMarker && r[3] === 'after',
          detail: `${show(r)}; revealed ${revealed}, quote marker hidden ${noMarker}`,
        };
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
        /*
         * `moved` is compared too. It was read and only reported, so the line could have gone back
         * to showing its markers the moment the caret left it and this still passed. That is the
         * one of the three readings where a stale decoration would show: `off` is measured with the
         * caret still on the line, so it cannot distinguish "the setting took effect" from "the
         * markers are hidden because the caret is here", and moving away is what separates them.
         */
        return {
          ok: on === 'A **bold** one here.' && off === 'A bold one here.' && moved === 'A bold one here.',
          detail: `on ${show(on)} after setting off ${show(off)} after a click elsewhere ${show(moved)}`,
        };
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
      /*
       * Scrolled to first, which this did not do and which is why it threw rather than
       * failed: "has nothing painted at its point". `S.caret` clicks a coordinate, and
       * level 10 is on line 16 of the file but 883px down the page, because the nine
       * items above it are long enough at their indents to wrap several times each. In
       * a window shorter than that it has a perfectly good rectangle with nothing
       * painted in it, and the click lands on the page instead.
       *
       * That reads as the line being unreachable, which is the thing this scenario is
       * for, so it has to be ruled out before the question can be asked at all. The
       * same trap is written up in `scripts/check-indent.mjs`, whose own ten-level case
       * scrolls for the same reason.
       */
      const seen = await wheelTo(S, 'Level 10:');
      if (!seen) return { ok: false, detail: 'the tenth level never came on screen to be clicked' };
      await S.caret('Level 10', 3);
      await S.type('Z');
      const d = await S.disk(path);
      return { ok: /^\s*•/.test(r || '') && d.includes('LevZel 10:'), detail: `line ${show(r)} typed ${d.includes('LevZel 10:')}` };
    },
  },

  /* ---- render.blank-lines ----
   *
   * A blank line is a line, at the height of a line of text, wherever it sits and
   * wherever the caret is. Only a real window can settle these: jsdom has no
   * layout, so it can read a class but not how tall anything is, where a click
   * lands, or what ArrowDown does.
   *
   * These read the opposite way round from the way they used to. A blank line
   * separating two blocks drew a third of a line tall, grew when the caret reached
   * it and shrank when it left, and these five scenarios asserted every part of
   * that. What it cost was that the document moved while a person worked in it, so
   * the shrinking is gone and what is checked now is that nothing moves.
   */
  {
    id: 'render.blank-lines.e01',
    feature: 'render.blank-lines',
    name: 'The blank line between two paragraphs is exactly as tall as a line of text',
    run: async (S) => {
      const DOC = 'First paragraph.\n\nSecond paragraph.\n';
      await fresh(S, 'blank-gap', DOC);
      await S.caret('First', 2);
      const b = await lineBoxes(S);
      const [text, gap, below] = b;
      const ok =
        !!gap &&
        gap.text === '' &&
        // Identical, not merely similar: the same line height, to the pixel.
        gap.height === text.height &&
        gap.height === below.height &&
        // The control. A document of three 0px lines would satisfy equality alone.
        text.height >= 20;
      return { ok, detail: `paragraph ${text?.height}px, blank line ${gap?.height}px, paragraph ${below?.height}px` };
    },
  },
  {
    id: 'render.blank-lines.e02',
    feature: 'render.blank-lines',
    name: 'Clicking the blank line puts the caret on it and moves nothing on the screen',
    run: async (S) => {
      const DOC = 'First paragraph.\n\nSecond paragraph.\n';
      await fresh(S, 'blank-click', DOC);
      await S.caret('First', 2);
      const before = await lineBoxes(S);
      await S.click({ sel: '.cm-content > .cm-line', nth: 1, dx: 8 });
      const st = await S.state();
      const after = await lineBoxes(S);
      // Typed into the line the click chose, so the file says where the caret landed.
      await S.type('X');
      const d = await S.disk();
      const heights = (b) => b.map((l) => l.height).join(',');
      const ok =
        st.line === 2 &&
        // The caret arriving changes no height anywhere, which is the whole point.
        heights(before) === heights(after) &&
        d === 'First paragraph.\nX\nSecond paragraph.\n';
      return { ok, detail: `caret on line ${st.line}; heights ${heights(before)} -> ${heights(after)}; file ${show(d)}` };
    },
  },
  {
    id: 'render.blank-lines.e03',
    feature: 'render.blank-lines',
    name: 'Arrowing down through a blank line lands on it and shifts nothing below it',
    run: async (S) => {
      const DOC = 'First paragraph.\n\nSecond paragraph.\n';
      await fresh(S, 'blank-arrows', DOC);
      await S.caret('First', 2);
      const tops = () => S.eval(() => [...document.querySelectorAll('.cm-content > .cm-line')].map((l) => Math.round(l.getBoundingClientRect().top)));
      const start = await tops();
      await S.press('ArrowDown');
      const onGap = await S.state();
      const onIt = await tops();
      await S.press('ArrowDown');
      const below = await S.state();
      await S.press('ArrowUp');
      const back = await S.state();
      const end = await tops();
      const d = await S.disk();
      const ok =
        onGap.line === 2 &&
        below.line === 3 &&
        back.line === 2 &&
        // Every line's top edge is where it was, at every step. This is what the
        // shrinking could not do: the caret arriving used to push the second
        // paragraph down by two thirds of a line.
        onIt.join() === start.join() &&
        end.join() === start.join() &&
        start.length === 4 &&
        d === DOC;
      return {
        ok,
        detail: `down to line ${onGap.line}, down to ${below.line}, up to ${back.line}; tops ${start.join()} -> ${onIt.join()} -> ${end.join()}; file unchanged ${d === DOC}`,
      };
    },
  },
  {
    id: 'render.blank-lines.e04',
    feature: 'render.blank-lines',
    name: 'Two blank lines between two paragraphs are twice the gap of one, and the file is untouched',
    run: async (S) => {
      // The reading the shrinking could not express. Each blank line drew a third of
      // a line, and the one the caret was nearest drew full, so two of them looked
      // like about one and a half rather than like two.
      const DOC = 'One.\n\nTwo.\n\n\nThree.\n';
      await fresh(S, 'blank-double', DOC);
      await S.caret('One', 2);
      const b = await lineBoxes(S);
      const line = b[0].height;
      const single = b[1].height;
      const double = b[3].height + b[4].height;
      const ok = single === line && double === 2 * line && line >= 20 && (await S.disk()) === DOC;
      return { ok, detail: `line ${line}px, one blank ${single}px, two blanks ${double}px` };
    },
  },
  {
    id: 'render.blank-lines.e05',
    feature: 'render.blank-lines',
    name: 'The block handle still reaches the paragraph under a blank line',
    run: async (S) => {
      const DOC = 'First paragraph.\n\nSecond paragraph.\n';
      await fresh(S, 'blank-grip', DOC);
      await S.caret('First', 2);
      await S.hover({ text: 'Second', offset: 2 });
      const grip = await S.eval(() => {
        const h = document.querySelector('.sheaf-block-handle');
        if (!h || h.hidden) return { shown: false };
        const r = h.getBoundingClientRect();
        const target = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) => l.textContent.includes('Second'));
        const t = target.getBoundingClientRect();
        return { shown: r.width > 4 && r.height > 4, beside: Math.abs(r.top + r.height / 2 - (t.top + t.height / 2)) <= 14 };
      });
      return { ok: grip.shown && grip.beside, detail: `handle shown ${grip.shown}, beside its paragraph ${grip.beside}` };
    },
  },
  {
    id: 'render.code-fence.e01',
    feature: 'render.code-fence',
    /*
     * The language label this used to assert was removed, deliberately: it was
     * `float: right`, and the block handle takes its position from the first
     * coordinate in the block, which is on the fence line, so the label carried the
     * block's + and grip 172px past the right edge of the text column while every
     * other block's sat in the left margin. Removing the label was chosen over
     * moving it. What it costs is that a reader cannot see a block's language at a
     * glance; it is still in the file, still colours the code, and Edit Markdown
     * shows it, which is also how it is changed.
     *
     * So the chip is read and asserted absent rather than simply not looked for. An
     * assertion deleted says nothing if the label ever comes back on a `float`.
     */
    name: 'A code block draws no backticks and no language label, and Edit Markdown shows the fence as written',
    run: async (S) => {
      const DOC = 'Before.\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nAfter.\n';
      await S.fresh('code-fence', DOC);
      await S.sleep(800);
      const shape = () =>
        S.eval(() => {
          const rows = [...document.querySelectorAll('.cm-content > .cm-line')];
          const fences = rows.filter((l) => l.classList.contains('sheaf-code-fence-line'));
          const chip = document.querySelector('.md-code-lang');
          const code = rows.find((l) => l.textContent.includes('const x = 1;'));
          return {
            text: rows.map((l) => l.textContent),
            fences: fences.length,
            heights: fences.map((l) => Math.round(l.getBoundingClientRect().height)),
            // Absent, and its text if it is not, so a failure says what came back.
            chip: chip ? chip.textContent : null,
          };
        });
      const drawn = await shape();
      /*
       * The handle, which is the other half of the label's removal and was asserted
       * nowhere in a real window.
       *
       * `blockHandle.ts` takes the handle's position from the first coordinate in the
       * block, which is on the fence line. The label was `float: right`, so that
       * coordinate came back at the right-hand end and carried the block's + and grip
       * 172px past the right edge of the text column, where every other block's sits in
       * the left margin. A label returning in any form, under any class, moves the
       * handle again, so this is what says the removal arrived whole.
       */
      await S.hover({ text: 'const x = 1;', offset: 2 });
      const handle = await S.eval(() => {
        const h = document.querySelector('.sheaf-block-handle');
        const code = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) => l.textContent.includes('const x = 1;'));
        if (!h || h.hidden || !code) return { shown: false };
        const r = h.getBoundingClientRect();
        if (!(r.width > 4 && r.height > 4)) return { shown: false };
        return { shown: true, fromText: Math.round(r.left - code.getBoundingClientRect().left) };
      });
      // Edit Markdown is how any block shows what it is written as, and a fence is a
      // marker like any other: the caret alone leaves it hidden, as it does everywhere.
      await S.caret('const x = 1;', 2);
      await S.press('Meta+Alt+e');
      await S.sleep(600);
      const onFence = await S.eval(() => {
        const row = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) => l.textContent.includes('```'));
        return {
          text: row ? row.textContent : null,
          height: row ? Math.round(row.getBoundingClientRect().height) : null,
        };
      });
      const d = await S.disk();
      return {
        ok:
          // No backticks anywhere on screen, and the language where the fence was.
          !drawn.text.some((t) => t.includes('`')) &&
          drawn.fences === 2 &&
          drawn.heights.every((h) => h > 0 && h <= 14) &&
          drawn.chip === null &&
          // The handle is drawn at all, and to the left of the words rather than at
          // the far end of the column. Both halves: a handle that never appeared would
          // satisfy a position assertion on its own.
          handle.shown &&
          handle.fromText < 0 &&
          // Under the caret it is a full line of raw text again.
          !!onFence &&
          (onFence.text ?? '').trim() === '```js' &&
          (onFence.height ?? 0) > 14 &&
          d === DOC,
        detail:
          `${JSON.stringify(drawn)}; handle ${JSON.stringify(handle)}; under the caret ${JSON.stringify(onFence)}` +
          `${d === DOC ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.code-fence.e02',
    feature: 'render.code-fence',
    /*
     * What the 10px fence line costs, which is the question a decision about raising it to a
     * full line turns on and which nothing measured.
     *
     * Two things are being separated. A fence line draws the block's panel behind itself, so
     * the 10px is the inset at the top and bottom of a code block rather than a blank line
     * inside it, and a reader counting lines counts the code. That is the case for leaving it
     * as it is. Against that, the line is still a line the caret can reach, and a caret drawn
     * 10px tall beside 24px ones would be the real cost.
     *
     * Both are read here so the decision points at numbers. The heights are asserted loosely,
     * because this is not the check that pins the drawing, and the caret is asserted as
     * reaching the line at all, which is the part that would be a bug.
     */
    name: 'A code fence line draws the block panel behind it, and the caret still reaches it',
    run: async (S) => {
      const DOC = 'Before.\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nAfter.\n';
      await S.fresh('code-fence-inset', DOC);
      await S.sleep(800);

      const panel = await S.eval(() => {
        const rows = [...document.querySelectorAll('.cm-content > .cm-line')];
        const fence = rows.find((l) => l.classList.contains('sheaf-code-fence-line'));
        const body = rows.find((l) => l.textContent.includes('const x = 1;'));
        const plain = rows.find((l) => l.textContent.trim() === 'Before.');
        if (!fence || !body || !plain) return null;
        // The panel is a ::before on each line of the block, so what the fence paints is
        // read from the pseudo-element rather than from the line's own background.
        const paint = (el) => {
          const s = getComputedStyle(el, '::before');
          return { bg: s.backgroundColor, width: Math.round(parseFloat(s.width) || 0) };
        };
        return {
          fence: { h: Math.round(fence.getBoundingClientRect().height), ...paint(fence) },
          body: { h: Math.round(body.getBoundingClientRect().height), ...paint(body) },
          plain: { h: Math.round(plain.getBoundingClientRect().height), ...paint(plain) },
        };
      });

      // Up from the first line of code is the opening fence, which is the only way to put the
      // caret there: the backticks are hidden, so there is no text to aim at.
      await S.caret('const x = 1;', 0);
      await S.press('ArrowUp');
      await S.sleep(300);
      const caret = await S.eval(() => {
        const rows = [...document.querySelectorAll('.cm-content > .cm-line')];
        const fence = rows.find((l) => l.classList.contains('sheaf-code-fence-line'));
        const cur = document.querySelector('.cm-cursor-primary') ?? document.querySelector('.cm-cursor');
        if (!fence || !cur) return { onFence: false };
        const f = fence.getBoundingClientRect();
        const c = cur.getBoundingClientRect();
        /*
         * From the fence's top edge, not from its centre. The caret is taller than the line
         * it is on and hangs below it into the first line of code, so a centre test reads a
         * caret that is correctly placed as a caret on another line. Measured: 17px of caret
         * on a 10px line, starting exactly at the fence's top.
         */
        return {
          onFence: Math.abs(c.top - f.top) <= 2,
          caretHeight: Math.round(c.height),
          fenceHeight: Math.round(f.height),
          belowTheLine: Math.round(c.bottom - f.bottom),
        };
      });

      const d = await S.disk();
      if (!panel) return { ok: false, detail: 'the block drew no fence line, body line or plain line to compare' };
      const painted = panel.fence.bg === panel.body.bg && panel.fence.width > 0;
      return {
        ok:
          painted &&
          panel.fence.bg !== panel.plain.bg &&
          panel.fence.h > 0 &&
          panel.fence.h < panel.body.h &&
          caret.onFence &&
          d === DOC,
        detail:
          `fence ${JSON.stringify(panel.fence)}, body ${JSON.stringify(panel.body)}, outside ${JSON.stringify(panel.plain)}; ` +
          `caret ${JSON.stringify(caret)}${d === DOC ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.spacing.e01',
    feature: 'render.spacing',
    name: 'A heading carries the same space above it at every level, so a section is separated by more than the blank line',
    run: async (S) => {
      const DOC = 'Intro paragraph here.\n\n## Pulse format\n\nThe body under it.\n\n# A title\n\nMore body.\n';
      await S.fresh('heading-rhythm', DOC);
      await S.sleep(800);
      const m = await S.eval(() => {
        const rows = [...document.querySelectorAll('.cm-content > .cm-line')];
        const read = (text) => {
          const el = rows.find((l) => l.textContent.trim() === text);
          if (!el) return null;
          const s = getComputedStyle(el);
          const above = rows[rows.indexOf(el) - 1];
          return {
            top: Math.round(parseFloat(s.paddingTop)),
            bottom: Math.round(parseFloat(s.paddingBottom)),
            // What a reader sees between the block above and the heading's own box.
            gap: Math.round(parseFloat(s.paddingTop)) + (above ? Math.round(above.getBoundingClientRect().height) : 0),
          };
        };
        return { h2: read('Pulse format'), h1: read('A title') };
      });
      const d = await S.disk();
      return {
        ok:
          !!m.h2 &&
          !!m.h1 &&
          // The rule reaches the page at all: this was zero for weeks, because the
          // stylesheet aimed at one class where CodeMirror's own theme uses two.
          m.h2.top > 8 &&
          m.h1.top > 8 &&
          // The same at both levels, which is the fix. It used to be an em of the
          // heading's own size, so an h1 got 32px and an h6 got 21px: air that
          // shrank as the heading did, when the smaller heading is the one that
          // needs finding. All six levels are compared in scripts/check-indent.mjs;
          // these two are the ones this document holds.
          m.h2.top === m.h1.top &&
          // Asymmetric: the space belongs above the heading, not below it. The
          // blank line under a heading is already a full line of separation.
          m.h2.bottom < m.h2.top / 3 &&
          m.h1.bottom < m.h1.top / 3 &&
          // Enough to separate a section, not so much that the document is airy.
          m.h2.gap >= 20 &&
          m.h2.gap <= 40 &&
          m.h1.gap >= 20 &&
          m.h1.gap <= 48 &&
          d === DOC,
        detail: `${JSON.stringify(m)}${d === DOC ? '' : '; the file changed'}`,
      };
    },
  },
  // ---------------------------------------------------------------- emoji shortcodes
  {
    id: 'render.emoji.e01',
    feature: 'render.emoji',
    name: 'Shortcodes draw as painted characters, a name nobody knows stays as typed, and clicking after one types in the right place',
    run: async (S) => {
      const DOC = 'Build passed :white_check_mark: and :+1: from Ops.\n\nDocked 10:30:45, :not_a_shortcode: stays.\n';
      await fresh(S, 'emoji-shortcodes', DOC);
      await S.sleep(800);
      // jsdom reports every box as zero, so this is the half only a real window can
      // answer: that the character was painted rather than replaced by nothing.
      const boxes = await S.eval(() =>
        [...document.querySelectorAll('.cm-content .tok-emoji')].map((e) => ({
          char: e.textContent,
          w: Math.round(e.getBoundingClientRect().width),
          h: Math.round(e.getBoundingClientRect().height),
        }))
      );
      const first = await line(S, 1);
      const second = await line(S, 3);
      // Click in front of the tick, press Right once, and type. The replacement is an
      // atomic range, so one Right has to step over the whole `:white_check_mark:`
      // rather than into it, and the letter lands after its closing colon.
      await S.caret('Build passed ', 13);
      await S.page.keyboard.press('ArrowRight');
      await S.page.keyboard.type('X');
      await S.sleep(1200);
      const disk = await S.disk();
      const ok =
        first === 'Build passed ✅ and 👍 from Ops.' &&
        second === 'Docked 10:30:45, :not_a_shortcode: stays.' &&
        boxes.length === 2 &&
        boxes.every((b) => b.w >= 6 && b.h >= 6) &&
        disk === DOC.replace(':white_check_mark: and', ':white_check_mark:X and');
      return { ok, detail: `line1 ${show(first)} line3 ${show(second)} boxes ${JSON.stringify(boxes)} disk ${show(disk)}` };
    },
  },
  {
    id: 'render.toolbar.e01',
    feature: 'render.toolbar',
    name: 'The formatting bar right-justifies its view buttons on one row, and packs them in once it folds onto two',
    run: async (S) => {
      await S.fresh('toolbar-wrap', 'Some text.\n');
      await S.sleep(700);
      // The bar, as a person sees it: how tall it is, whether it says it folded, and how
      // much room the spacer is taking to push the view buttons to the right edge.
      const measure = () =>
        S.eval(() => {
          const bar = document.querySelector('.sheaf-toolbar');
          const spacer = bar?.querySelector('.sheaf-tb-spacer');
          const buttons = [...(bar?.querySelectorAll('.sheaf-tb-btn') ?? [])];
          if (!bar || !spacer || buttons.length === 0) return { error: 'no toolbar on screen' };
          const first = buttons[0].getBoundingClientRect();
          const last = buttons[buttons.length - 1].getBoundingClientRect();
          return {
            wrapped: bar.classList.contains('is-wrapped'),
            rows: last.top > first.top ? 2 : 1,
            spacer: Math.round(spacer.getBoundingClientRect().width),
            // What is left between the last button and the right edge of the bar.
            trailing: Math.round(bar.getBoundingClientRect().right - last.right),
          };
        });
      const wide = await measure();
      const size = await S.app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const was = win.getBounds();
        win.setBounds({ ...was, width: 620 });
        return was;
      });
      await S.sleep(1200);
      const narrow = await measure();
      // Put the window back, so the scenarios after this one see the window they expect.
      await S.app.evaluate(({ BrowserWindow }, was) => BrowserWindow.getAllWindows()[0].setBounds(was), size);
      await S.sleep(1200);
      const back = await measure();
      return {
        ok:
          !wide.error &&
          !narrow.error &&
          // One row: the spacer is doing its job and the buttons sit at the right edge.
          wide.rows === 1 &&
          !wide.wrapped &&
          wide.spacer > 20 &&
          wide.trailing < 20 &&
          // Two rows: the bar says so and the spacer has stopped growing, so the last row
          // carries on from the first instead of holding four buttons out at the end.
          narrow.rows === 2 &&
          narrow.wrapped &&
          narrow.spacer <= 1 &&
          narrow.trailing > 20 &&
          // And it is one row again once there is room.
          back.rows === 1 &&
          !back.wrapped &&
          back.spacer > 20,
        detail: `wide ${JSON.stringify(wide)}; narrow ${JSON.stringify(narrow)}; back ${JSON.stringify(back)}`,
      };
    },
  },
];

// The double-click reveal ships behind `sheaf.doubleClickToEditSource`, which is off by default, so
// its scenarios run in the `reveal-source` area, which turns the setting on. Running them here would
// fail for describing behaviour that is no longer what a double-click does out of the box.
export const revealDoubleClick = allScenarios.filter((s) => s.feature === 'render.reveal-double-click');
export const scenarios = allScenarios.filter((s) => s.feature !== 'render.reveal-double-click');
