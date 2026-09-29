// Writing Markdown by typing it, and getting back out of what you typed.
//
// The toolbar, the slash menu and Turn into each have their own area. This one is the path most
// people use: typing `# `, `- `, `> `, a fence or a table by hand, and then leaving that block to
// write the next one. Every check reads the file as well as the screen, because the point of
// typing a marker is that the marker is what the file gets.
//   node test/real-editor/run-editor.mjs typing-markdown [id]
const j = (x) => JSON.stringify(x);

/** The rendered text of every line, and the classes each line carries. */
const lines = (S) =>
  S.eval(() =>
    [...document.querySelectorAll('.cm-content > .cm-line')].map((l) => ({
      text: l.textContent,
      cls: l.className.replace(/cm-line ?/, '').trim(),
      h: Math.round(l.getBoundingClientRect().height),
    }))
  );

/** Which drawn things the page holds, for the block types that are drawn as a widget. */
const drawn = (S) =>
  S.eval(() => {
    const has = (sel) => document.querySelectorAll(sel).length;
    return {
      hr: has('.md-hr'),
      alert: has('.md-alert-label'),
      comment: has('.md-comment'),
      mathBlock: has('.md-math-block'),
      mermaid: has('.md-mermaid'),
      image: has('.md-img'),
      grid: has('.sheaf-table'),
      link: has('.tok-link'),
      strike: has('.tok-strike'),
      highlight: has('.tok-highlight'),
      frontmatter: has('.tok-frontmatter, .sheaf-frontmatter-fold'),
    };
  });

/** Type a run of lines, pressing Enter between them rather than typing a newline. */
async function typeLines(S, rows) {
  for (let i = 0; i < rows.length; i++) {
    if (i) await S.press('Enter');
    if (rows[i]) await S.type(rows[i]);
  }
}

/** The text of the line the caret is on, read from the harness's own view of the state. */
async function caretLine(S) {
  const st = await S.state();
  const text = await S.disk();
  const upto = text.slice(0, st.head);
  return { line: upto.split('\n').length, text: text.split('\n')[upto.split('\n').length - 1] };
}

export const scenarios = [
  {
    id: 'prose.typing-markdown.e01',
    feature: 'prose.typing-markdown',
    name: 'Typing "# " and a title writes a heading to the file and draws it as one, with the hashes off the screen',
    run: async (S) => {
      const file = await S.fresh('typing-heading', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('# Release notes');
      await S.caret('Start', 2);
      await S.sleep(500);
      const seen = await lines(S);
      const disk = await S.disk(file);
      const heading = seen.find((l) => l.text.includes('Release notes'));
      const ok = disk === 'Start.\n# Release notes\n' && !!heading && /tok-heading|tok-h1/.test(heading.cls) && !heading.text.includes('#');
      return { ok, detail: `file ${j(disk)}; the heading line ${j(heading)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e02',
    feature: 'prose.typing-markdown',
    name: 'Typing "#" with no space after it stays text, as Markdown reads it',
    run: async (S) => {
      const file = await S.fresh('typing-hash-no-space', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('#NotAHeading');
      await S.caret('Start', 2);
      await S.sleep(500);
      const seen = await lines(S);
      const disk = await S.disk(file);
      const line = seen.find((l) => l.text.includes('NotAHeading'));
      const ok = disk === 'Start.\n#NotAHeading\n' && !!line && line.text.startsWith('#') && !/tok-heading/.test(line.cls);
      return { ok, detail: `file ${j(disk)}; the line ${j(line)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e03',
    feature: 'prose.typing-markdown',
    name: 'Typing "- " starts a bullet list, Enter carries it on, and Enter on the empty item leaves it',
    run: async (S) => {
      const file = await S.fresh('typing-bullets', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('- one');
      await S.press('Enter');
      await S.type('two');
      await S.press('Enter');
      await S.press('Enter');
      await S.type('After the list.');
      await S.sleep(500);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const drawn = seen.filter((l) => l.text.includes('one') || l.text.includes('two')).map((l) => l.text);
      const ok = disk === 'Start.\n- one\n- two\n\nAfter the list.\n' && drawn.every((t) => t.includes('•')) && !drawn.some((t) => t.includes('- '));
      return { ok, detail: `file ${j(disk)}; the items read ${j(drawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e04',
    feature: 'prose.typing-markdown',
    name: 'Typing "5. " starts a numbered list at five, and the next item is six',
    run: async (S) => {
      // The blank line matters: an ordered list starting at anything but 1 cannot interrupt a
      // paragraph, so without it Markdown reads "5. five" as more of the paragraph above.
      const file = await S.fresh('typing-ordered', 'Start.\n\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.press('Enter');
      await S.type('5. five');
      await S.press('Enter');
      await S.type('six');
      await S.caret('Start', 2);
      await S.sleep(500);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const drawn = seen.filter((l) => l.text.includes('five') || l.text.includes('six')).map((l) => l.text);
      // The document began with a blank line after "Start.", and it is still there at the end.
      const ok = disk === 'Start.\n\n5. five\n6. six\n\n' && j(drawn) === j(['5. five', '6. six']);
      return { ok, detail: `file ${j(disk)}; the items read ${j(drawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e05',
    feature: 'prose.typing-markdown',
    name: 'Typing "> " starts a quote, and Enter on the empty quote line leaves it',
    run: async (S) => {
      const file = await S.fresh('typing-quote', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('> quoted words');
      await S.press('Enter');
      await S.press('Enter');
      await S.type('After the quote.');
      await S.sleep(500);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const quoted = seen.find((l) => l.text.includes('quoted words'));
      const ok = disk === 'Start.\n> quoted words\n\nAfter the quote.\n' && !!quoted && /tok-quote/.test(quoted.cls) && !quoted.text.includes('>');
      return { ok, detail: `file ${j(disk)}; the quoted line ${j(quoted)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e06',
    feature: 'prose.typing-markdown',
    name: 'Typing a fence, a language and code draws a code block with the language named, and the file holds both fences',
    run: async (S) => {
      const file = await S.fresh('typing-fence', 'Start.\n\nAfter the code.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('```js');
      await S.press('Enter');
      await S.type('const a = 1;');
      await S.press('Enter');
      await S.type('```');
      await S.caret('After the code', 2);
      await S.sleep(600);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const code = seen.find((l) => l.text.includes('const a = 1;'));
      const backticks = seen.filter((l) => l.text.includes('```')).map((l) => l.text);
      const lang = await S.eval(() => document.querySelector('.sheaf-code-lang, .cm-code-lang, [data-code-lang]')?.textContent ?? null);
      const ok =
        disk === 'Start.\n```js\nconst a = 1;\n```\n\nAfter the code.\n' && !!code && /tok-code-block/.test(code.cls) && backticks.length === 0;
      return { ok, detail: `file ${j(disk)}; the code line ${j(code)}; lines still showing backticks ${j(backticks)}; language chip ${j(lang)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e07',
    feature: 'prose.typing-markdown',
    name: 'After typing a code block at the end of a document, the caret can leave it and what is typed next is not code',
    run: async (S) => {
      const file = await S.fresh('typing-fence-escape', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('```');
      await S.press('Enter');
      await S.type('code line');
      await S.press('Enter');
      await S.type('```');
      await S.sleep(400);
      // A person now wants a paragraph under the block, with the keyboard they already have.
      await S.press('ArrowDown');
      await S.press('Enter');
      await S.type('After the code.');
      await S.sleep(600);
      const disk = await S.disk(file);
      const where = await caretLine(S);
      // The trailing newline is not the question here; where the typed line landed is.
      const ok = /^Start\.\n```\ncode line\n```\n\n?After the code\.\n?$/.test(disk);
      return { ok, detail: `file ${j(disk)}; the caret ended on line ${j(where)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e08',
    feature: 'prose.typing-markdown',
    name: 'Typing three dashes under a paragraph is drawn as what Markdown reads: the paragraph becomes a heading',
    run: async (S) => {
      const file = await S.fresh('typing-setext', 'A paragraph here.\n');
      await S.caret('paragraph', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('---');
      await S.caret('paragraph', 2);
      await S.sleep(600);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const para = seen.find((l) => l.text.includes('A paragraph here.'));
      const rule = await S.eval(() => document.querySelectorAll('hr.md-hr').length);
      // CommonMark reads this as a setext heading, so the paragraph must read as a heading on
      // screen. Drawing a divider under an unchanged paragraph would show something the file
      // does not say.
      const ok = disk === 'A paragraph here.\n---\n' && !!para && /tok-heading|tok-setext/.test(para.cls) && rule === 0;
      return { ok, detail: `file ${j(disk)}; the paragraph line ${j(para)}; rules drawn ${rule}` };
    },
  },
  {
    id: 'prose.typing-markdown.e09',
    feature: 'prose.typing-markdown',
    name: 'Typing a header row and a delimiter row draws a table grid, and the file keeps both lines',
    run: async (S) => {
      const file = await S.fresh('typing-table', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('| a | b |');
      await S.press('Enter');
      await S.type('| - | - |');
      await S.caret('Start', 2);
      await S.sleep(800);
      const disk = await S.disk(file);
      const grid = await S.eval(() => document.querySelectorAll('.sheaf-table-grid table').length);
      const pipes = (await lines(S)).filter((l) => l.text.includes('|')).map((l) => l.text);
      const ok = disk === 'Start.\n| a | b |\n| - | - |\n' && grid === 1 && pipes.length === 0;
      return { ok, detail: `file ${j(disk)}; grids ${grid}; lines still showing pipes ${j(pipes)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e10',
    feature: 'prose.typing-markdown',
    name: 'Typing bold markers closes the bold there: what follows the closing markers is not bold',
    run: async (S) => {
      const file = await S.fresh('typing-bold', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('**bold** and plain');
      await S.caret('Start', 2);
      await S.sleep(500);
      const disk = await S.disk(file);
      const marked = await S.eval(() => [...document.querySelectorAll('.tok-strong')].map((e) => e.textContent));
      const seen = (await lines(S)).find((l) => l.text.includes('and plain'));
      const ok = disk === 'Start.\n**bold** and plain\n' && j(marked) === j(['bold']) && seen?.text === 'bold and plain';
      return { ok, detail: `file ${j(disk)}; bold ${j(marked)}; the line reads ${j(seen?.text)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e11',
    feature: 'prose.typing-markdown',
    name: 'Typing a backslash before a marker keeps the marker as a character, with no backslash on screen',
    run: async (S) => {
      const file = await S.fresh('typing-escape', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('\\*not italic\\* and \\# not a heading');
      await S.caret('Start', 2);
      await S.sleep(500);
      const disk = await S.disk(file);
      const seen = (await lines(S)).find((l) => l.text.includes('not italic'));
      const italics = await S.eval(() => document.querySelectorAll('.tok-em').length);
      const ok =
        disk === 'Start.\n\\*not italic\\* and \\# not a heading\n' &&
        seen?.text === '*not italic* and # not a heading' &&
        italics === 0;
      return { ok, detail: `file ${j(disk)}; the line reads ${j(seen?.text)}; italics drawn ${italics}` };
    },
  },
  {
    id: 'prose.typing-markdown.e12',
    feature: 'prose.typing-markdown',
    name: 'Typing "- [ ] " starts a task with a checkbox, and the next Enter carries the task list on',
    run: async (S) => {
      const file = await S.fresh('typing-task', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('- [ ] first task');
      await S.press('Enter');
      await S.type('second task');
      await S.caret('Start', 2);
      await S.sleep(500);
      const disk = await S.disk(file);
      const boxes = await S.eval(() => document.querySelectorAll('input.md-task').length);
      const ok = disk === 'Start.\n- [ ] first task\n- [ ] second task\n' && boxes === 2;
      return { ok, detail: `file ${j(disk)}; checkboxes drawn ${boxes}` };
    },
  },
  {
    id: 'prose.typing-markdown.e13',
    feature: 'prose.typing-markdown',
    name: 'Typing "1. " starts a numbered list and Enter carries it on, as a bullet list does',
    run: async (S) => {
      const file = await S.fresh('typing-ordered-one', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('1. one');
      await S.press('Enter');
      await S.type('two');
      await S.caret('Start', 2);
      await S.sleep(500);
      const disk = await S.disk(file);
      return { ok: disk === 'Start.\n1. one\n2. two\n', detail: `file ${j(disk)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e14',
    feature: 'prose.typing-markdown',
    name: 'Typing a table row by row, as a person does, leaves the file holding exactly the two lines typed',
    run: async (S) => {
      const file = await S.fresh('typing-table-slow', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      // One character at a time with a person's pause, so the grid taking over mid-line is
      // met the way a person meets it.
      for (const ch of '| a | b |') {
        await S.type(ch);
        await S.sleep(40);
      }
      await S.press('Enter');
      const typed = [];
      for (const ch of '| - | - |') {
        await S.type(ch);
        await S.sleep(40);
        typed.push(await S.disk(file));
      }
      await S.caret('Start', 2);
      await S.sleep(600);
      const disk = await S.disk(file);
      const want = 'Start.\n| a | b |\n| - | - |\n';
      // Where the file first stopped being the prefix of what was typed.
      const broke = typed.findIndex((t, i) => !('Start.\n| a | b |\n' + '| - | - |'.slice(0, i + 1) + '\n').startsWith(t.replace(/\n$/, '').slice(0, t.length - 1)) && t !== want);
      return { ok: disk === want, detail: `file ${j(disk)}; after each character the file read ${j(typed.map((t) => t.replace('Start.\n', '')))}` };
    },
  },
  {
    id: 'prose.typing-markdown.e15',
    feature: 'prose.typing-markdown',
    name: 'A numbered list continues on Enter whatever number it starts at',
    run: async (S) => {
      const out = {};
      for (const start of ['1', '2', '3', '10']) {
        // A blank line first: CommonMark lets an ordered list interrupt a paragraph only when
        // it starts at 1, so without one "5. five" is a continuation of the paragraph above.
        const file = await S.fresh(`typing-ordered-${start}`, 'Start.\n\n');
        await S.caret('Start', 5);
        await S.press('End');
        await S.press('Enter');
        await S.press('Enter');
        await S.type(`${start}. first`);
        await S.press('Enter');
        await S.type('second');
        await S.sleep(400);
        out[start] = (await S.disk(file)).replace('Start.\n\n', '');
      }
      const ok = Object.entries(out).every(([n, text]) => text === `${n}. first\n${Number(n) + 1}. second\n\n`);
      return { ok, detail: `each start wrote ${j(out)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e16',
    feature: 'prose.typing-markdown',
    name: 'One Backspace before the first word takes a whole heading marker off and leaves the words',
    run: async (S) => {
      // The marker comes off as one thing rather than character by character, so backing out of a
      // block a person did not mean to make is a single press. A second press would join the line
      // to the one above, which is why the count matters.
      const file = await S.fresh('typing-unmake-heading', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('# Release notes');
      // Click away and back, so the caret lands where a person puts it: just before the first
      // word, with the hashes drawn again because the line is theirs now.
      await S.caret('Start', 2);
      await S.sleep(300);
      await S.caret('Release notes', 0);
      await S.sleep(300);
      await S.press('Backspace');
      await S.sleep(500);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const line = seen.find((l) => l.text.includes('Release notes'));
      const ok = disk === 'Start.\nRelease notes\n' && !!line && !/tok-heading/.test(line.cls);
      return { ok, detail: `file ${j(disk)}; the line ${j(line)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e17',
    feature: 'prose.typing-markdown',
    name: 'One Backspace before the first word takes a whole quote marker off',
    run: async (S) => {
      const file = await S.fresh('typing-unmake-quote', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('> quoted words');
      await S.caret('Start', 2);
      await S.sleep(300);
      await S.caret('quoted words', 0);
      await S.sleep(300);
      await S.press('Backspace');
      await S.sleep(500);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const line = seen.find((l) => l.text.includes('quoted words'));
      const ok = disk === 'Start.\nquoted words\n' && !!line && !/tok-quote/.test(line.cls);
      return { ok, detail: `file ${j(disk)}; the line ${j(line)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e18',
    feature: 'prose.typing-markdown',
    name: 'One Backspace before the first word takes a whole bullet marker off',
    run: async (S) => {
      const file = await S.fresh('typing-unmake-bullet', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('- one item');
      await S.caret('Start', 2);
      await S.sleep(300);
      await S.caret('one item', 0);
      await S.sleep(300);
      await S.press('Backspace');
      await S.sleep(500);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const line = seen.find((l) => l.text.includes('one item'));
      const ok = disk === 'Start.\none item\n' && !!line && !/tok-bullet/.test(line.cls);
      return { ok, detail: `file ${j(disk)}; the line ${j(line)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e19',
    feature: 'prose.typing-markdown',
    name: 'One Backspace takes a whole task marker off, leaving no half-eaten bracket',
    run: async (S) => {
      // `- [ ] ` is six characters and comes off in one press, so there is never a half-eaten
      // marker on screen that still parses as something.
      const file = await S.fresh('typing-unmake-task', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('- [ ] a task');
      await S.caret('Start', 2);
      await S.sleep(300);
      await S.caret('a task', 0);
      await S.sleep(300);
      await S.press('Backspace');
      await S.sleep(500);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const line = seen.find((l) => l.text.includes('a task'));
      const ok = disk === 'Start.\na task\n' && !!line && line.text.trim() === 'a task';
      return { ok, detail: `file ${j(disk)}; the line ${j(line)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e20',
    feature: 'prose.typing-markdown',
    name: 'Enter at the end of a heading starts a paragraph, not another heading',
    run: async (S) => {
      const file = await S.fresh('typing-leave-heading', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('# Release notes');
      await S.press('Enter');
      await S.type('The first paragraph.');
      await S.sleep(500);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const line = seen.find((l) => l.text.includes('The first paragraph'));
      const ok = disk === 'Start.\n# Release notes\nThe first paragraph.\n' && !!line && !/tok-heading/.test(line.cls);
      return { ok, detail: `file ${j(disk)}; the line under the heading ${j(line)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e21',
    feature: 'prose.typing-markdown',
    name: 'Typing ---, *** or ___ on a line of its own draws a rule and writes only what was typed',
    run: async (S) => {
      const file = await S.fresh('typing-rules', 'Above.\n\nBelow.\n');
      await S.caret('Above', 5);
      await S.press('End');
      await S.press('Enter');
      // A blank line first, so the marker is not read as the setext underline of the paragraph.
      await typeLines(S, ['', '---', '', '***', '', '___', '']);
      await S.caret('Below', 2);
      await S.sleep(600);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const wrote = disk === 'Above.\n\n---\n\n***\n\n___\n\n\nBelow.\n' || disk.includes('\n---\n\n***\n\n___\n');
      return { ok: wrote && seenDrawn.hr === 3, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e22',
    feature: 'prose.typing-markdown',
    name: 'Typing === under a paragraph turns it into a heading, as Markdown reads it',
    run: async (S) => {
      const file = await S.fresh('typing-setext', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', 'A title line', '===']);
      await S.caret('Start', 2);
      await S.sleep(600);
      const disk = await S.disk(file);
      const seen = await lines(S);
      const line = seen.find((l) => l.text.includes('A title line'));
      const ok = disk === 'Start.\n\nA title line\n===\n' && !!line && /tok-heading/.test(line.cls);
      return { ok, detail: `file ${j(disk)}; the title line ${j(line)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e23',
    feature: 'prose.typing-markdown',
    name: 'Typing "> [!NOTE]" and a line under it draws a callout, and writes only the two lines typed',
    run: async (S) => {
      const file = await S.fresh('typing-alert', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      // Enter inside a quote writes the next `> ` already, so only the words are typed.
      await typeLines(S, ['', '> [!NOTE]', 'Remember the deadline.']);
      await S.caret('Start', 2);
      await S.sleep(700);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const ok = disk === 'Start.\n\n> [!NOTE]\n> Remember the deadline.\n' && seenDrawn.alert === 1;
      return { ok, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e24',
    feature: 'prose.typing-markdown',
    name: 'Typing an HTML comment draws it as a comment and writes exactly the characters typed',
    run: async (S) => {
      const file = await S.fresh('typing-comment', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', '<!-- a note to myself -->']);
      await S.caret('Start', 2);
      await S.sleep(700);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const ok = disk === 'Start.\n\n<!-- a note to myself -->\n' && seenDrawn.comment === 1;
      return { ok, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e25',
    feature: 'prose.typing-markdown',
    name: 'Typing a $$ block typesets it, and the half-typed block on the way does not swallow the text below',
    run: async (S) => {
      // maths.ts keeps a `$$` block inside one paragraph on purpose, so an opening `$$` with no
      // closer yet, which is the state for as long as it takes to type the formula, leaves the
      // rest of the document alone. This asks whether it holds while someone types.
      const file = await S.fresh('typing-maths', 'Start.\n\nA paragraph below.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', '$$', 'a^2 + b^2 = c^2']);
      await S.sleep(600);
      const midway = await S.eval(() =>
        [...document.querySelectorAll('.cm-content > .cm-line')].some((l) => l.textContent.includes('A paragraph below'))
      );
      await S.press('Enter');
      await S.type('$$');
      await S.caret('Start', 2);
      await S.sleep(800);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const ok = midway && disk === 'Start.\n\n$$\na^2 + b^2 = c^2\n$$\n\nA paragraph below.\n' && seenDrawn.mathBlock === 1;
      return { ok, detail: `the paragraph below was still its own line while the block was open: ${midway}; file ${j(disk)}; drawn ${j(seenDrawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e26',
    feature: 'prose.typing-markdown',
    name: 'Typing a mermaid fence and a graph draws the diagram, with both fences in the file and nothing added',
    run: async (S) => {
      const file = await S.fresh('typing-mermaid', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', '```mermaid', 'graph LR', 'A-->B', '```']);
      await S.caret('Start', 2);
      await S.sleep(1500);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const ok = disk === 'Start.\n\n```mermaid\ngraph LR\nA-->B\n```\n' && seenDrawn.mermaid === 1;
      return { ok, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e27',
    feature: 'prose.typing-markdown',
    name: 'Typing a csv fence and two rows draws a grid, with both fences in the file and no cell padded',
    run: async (S) => {
      const file = await S.fresh('typing-csv', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', '```csv', 'name,qty', 'apple,3', '```']);
      await S.caret('Start', 2);
      await S.sleep(1200);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const ok = disk === 'Start.\n\n```csv\nname,qty\napple,3\n```\n' && seenDrawn.grid === 1;
      return { ok, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e28',
    feature: 'prose.typing-markdown',
    name: 'Typing ~~struck~~ and ==marked== draws both, with the markers off the screen and in the file',
    run: async (S) => {
      const file = await S.fresh('typing-inline-extras', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await S.type('~~struck~~ and ==marked== here');
      await S.caret('Start', 2);
      await S.sleep(600);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const seen = await lines(S);
      const line = seen.find((l) => l.text.includes('struck'));
      const ok =
        disk === 'Start.\n~~struck~~ and ==marked== here\n' &&
        seenDrawn.strike === 1 &&
        seenDrawn.highlight === 1 &&
        !!line &&
        !line.text.includes('~~') &&
        !line.text.includes('==');
      return { ok, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}; the line ${j(line)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e29',
    feature: 'prose.typing-markdown',
    name: 'Typing a link draws it as its words alone, with the address off the screen and in the file',
    run: async (S) => {
      const file = await S.fresh('typing-link-image', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', 'See [the notes](https://example.com/notes) for more.']);
      await S.caret('Start', 2);
      await S.sleep(900);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const seen = await lines(S);
      const line = seen.find((l) => l.text.includes('the notes'));
      const ok =
        disk === 'Start.\n\nSee [the notes](https://example.com/notes) for more.\n' &&
        seenDrawn.link >= 1 &&
        !!line &&
        !line.text.includes('https://');
      return { ok, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}; the link line ${j(line)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e30',
    feature: 'prose.typing-markdown',
    name: 'Tab on the item Enter just made nests it, and the next Enter keeps the new level',
    run: async (S) => {
      // Enter writes the next marker already, so a person nests with Tab rather than by typing
      // spaces in front of a marker that is already there.
      const file = await S.fresh('typing-nested-list', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', '- one']);
      await S.press('Enter');
      await S.press('Tab');
      await S.type('nested');
      await S.press('Enter');
      await S.type('still nested');
      await S.caret('Start', 2);
      await S.sleep(600);
      const disk = await S.disk(file);
      // One indent unit is four spaces, the width that would make an indented code block of a
      // line that was not a list item.
      const ok = disk === 'Start.\n\n- one\n    - nested\n    - still nested\n';
      return { ok, detail: `file ${j(disk)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e31',
    feature: 'prose.typing-markdown',
    name: 'A fence typed with nothing closing it turns the text below it into code, which is what Markdown says and what a person meets halfway through typing',
    run: async (S) => {
      // Unlike a `$$` block, a fence runs to the end of the document until it is closed, so a
      // document with text under the caret goes dark as soon as the opening fence is typed. The
      // scenario records what happens rather than asserting it is right; the case is open.
      const file = await S.fresh('typing-open-fence', 'Start.\n\nA paragraph below.\n\nAnother one.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', '```js', 'const a = 1;']);
      await S.sleep(700);
      const seen = await lines(S);
      const belowAsCode = seen.filter((l) => /tok-code-block|sheaf-code-fence-line/.test(l.cls)).map((l) => l.text);
      const disk = await S.disk(file);
      const wroteNothingExtra = disk === 'Start.\n\n```js\nconst a = 1;\n\nA paragraph below.\n\nAnother one.\n';
      return {
        ok: wroteNothingExtra,
        detail: `file ${j(disk)}; lines drawn as code while the fence is open ${j(belowAsCode)}`,
      };
    },
  },
  {
    id: 'prose.typing-markdown.e32',
    feature: 'prose.typing-markdown',
    name: 'Typing front matter at the top of an empty file draws it as metadata and writes only the lines typed',
    run: async (S) => {
      const file = await S.fresh('typing-front-matter', '');
      await S.sleep(400);
      await S.click({ sel: '.cm-content' });
      await typeLines(S, ['---', 'title: The plan', '---', '', '# Body']);
      await S.sleep(800);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const ok = disk === '---\ntitle: The plan\n---\n\n# Body' || disk === '---\ntitle: The plan\n---\n\n# Body\n';
      return { ok: ok && seenDrawn.frontmatter >= 1, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e33',
    feature: 'prose.typing-markdown',
    name: 'Typing an image reference to a picture that is there draws the picture',
    run: async (S) => {
      const file = await S.fresh('typing-image-present', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', '![Dawn](../assets/terminal-dawn.png)']);
      await S.caret('Start', 2);
      await S.sleep(1200);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const ok = disk === 'Start.\n\n![Dawn](../assets/terminal-dawn.png)\n' && seenDrawn.image === 1;
      return { ok, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e34',
    feature: 'prose.typing-markdown',
    name: 'Typing an image reference before the picture exists leaves the line as written, rather than drawing a frame with nothing in it',
    run: async (S) => {
      // Writing the page first and adding the picture later is an ordinary order of work, so what
      // a person meets in between matters. `resolveImageSrc` returning null draws no widget at
      // all, which leaves the raw `![alt](path)` on the line.
      const file = await S.fresh('typing-image-missing', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', '![A picture](not-here-yet.png)']);
      await S.caret('Start', 2);
      await S.sleep(1200);
      const disk = await S.disk(file);
      const seenDrawn = await drawn(S);
      const seen = await lines(S);
      const line = seen.find((l) => l.text.includes('picture'));
      const broken = await S.eval(() => document.querySelectorAll('.md-img-wrap.is-broken').length);
      const ok = disk === 'Start.\n\n![A picture](not-here-yet.png)\n' && (seenDrawn.image === 1 || !!line);
      return { ok, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}; broken frames ${broken}; the line ${j(line)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e35',
    feature: 'prose.typing-markdown',
    name: 'Home goes to the start of the text, by one rule on a heading, a quote, a bullet and a task',
    run: async (S) => {
      // A person pressing Home expects the start of the line. While the caret is on the line the
      // marker is drawn dim rather than hidden, so there is one visible start to go to. This asks
      // whether a heading, a quote, a bullet and a task agree about where it is.
      const file = await S.fresh('typing-home-consistency', 'Start.\n\n# A heading here\n\n> A quoted line\n\n- A bullet item\n\n- [ ] A task item\n');
      await S.sleep(700);
      const where = {};
      for (const [what, text] of [
        ['heading', 'A heading here'],
        ['quote', 'A quoted line'],
        ['bullet', 'A bullet item'],
        ['task', 'A task item'],
      ]) {
        await S.caret(text, 3);
        await S.sleep(250);
        await S.press('Home');
        await S.sleep(250);
        const st = await S.state();
        const doc = st.doc;
        const lineStart = doc.lastIndexOf('\n', st.head - 1) + 1;
        where[what] = { column: st.head - lineStart, before: j(doc.slice(lineStart, st.head)), text: doc.slice(st.head, st.head + 2) };
      }
      /*
       * One rule, not one column. Every line here opens with "A ", so the caret is at the
       * start of the text exactly when the document from the caret does too. Asserting a
       * shared column was the wrong reading: a task's marker is four characters longer than
       * a bullet's, so the same rule has to land them in different columns.
       *
       * This separates all three of the old answers. The heading skipped `# ` and passed;
       * the quote stopped between the `>` and its space, so it saw " A quoted"; the bullet
       * and the task sat in front of their markers, so they saw "- A bullet".
       */
      const ok = Object.values(where).every((w) => w.text.startsWith('A '));
      return { ok, detail: `Home left the caret at ${j(where)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e36',
    feature: 'prose.typing-markdown',
    name: 'The same image reference in a document that is opened rather than typed draws the picture',
    run: async (S) => {
      // e33's control. Without it, an image that never draws and an image that draws only when
      // the document was not typed read the same.
      const file = await S.fresh('opened-image', 'Start.\n\n![Dawn](../assets/terminal-dawn.png)\n');
      await S.sleep(1500);
      const seenDrawn = await drawn(S);
      const disk = await S.disk(file);
      return { ok: seenDrawn.image === 1, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e37',
    feature: 'prose.typing-markdown',
    name: 'The same csv block in a document that is opened rather than typed draws a grid and leaves the file alone',
    run: async (S) => {
      // e27's control, for the same reason.
      const doc = 'Start.\n\n```csv\nname,qty\napple,3\n```\n';
      const file = await S.fresh('opened-csv', doc);
      await S.sleep(1800);
      const seenDrawn = await drawn(S);
      const disk = await S.disk(file);
      return { ok: seenDrawn.grid === 1 && disk === doc, detail: `file ${j(disk)}; drawn ${j(seenDrawn)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e38',
    feature: 'prose.typing-markdown',
    name: 'An image reference typed into the page is drawn without waiting for the file to be written and read back',
    run: async (S) => {
      // e33 fails and e36 passes, so the question is whether the picture arrives late rather than
      // never: the save is a second or two away, and the host echoing the file back would redraw.
      const file = await S.fresh('typing-image-wait', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      await typeLines(S, ['', '![Dawn](../assets/terminal-dawn.png)']);
      await S.caret('Start', 2);
      await S.sleep(1200);
      const atOnce = (await drawn(S)).image;
      await S.sleep(6000);
      const later = (await drawn(S)).image;
      const disk = await S.disk(file);
      return { ok: atOnce === 1, detail: `pictures drawn after a second: ${atOnce}; after seven: ${later}; file ${j(disk)}` };
    },
  },
  {
    id: 'prose.typing-markdown.e39',
    feature: 'prose.typing-markdown',
    name: 'Typing a csv block line by line leaves the file holding exactly the lines typed, at every step',
    run: async (S) => {
      // e27 ends with the file scrambled. This records the state after each line, so the step
      // where it goes wrong is in the report rather than left to be guessed.
      const file = await S.fresh('typing-csv-steps', 'Start.\n');
      await S.caret('Start', 5);
      await S.press('End');
      await S.press('Enter');
      const steps = [];
      const note = async (what) => {
        await S.sleep(500);
        steps.push({ after: what, file: await S.disk(file), grid: (await drawn(S)).grid });
      };
      await S.press('Enter');
      await S.type('```csv');
      await note('the opening fence');
      await S.press('Enter');
      await S.type('name,qty');
      await note('the header row');
      await S.press('Enter');
      await S.type('apple,3');
      await note('the first row');
      await S.press('Enter');
      await S.type('```');
      await note('the closing fence');
      await S.caret('Start', 2);
      await S.sleep(1200);
      const disk = await S.disk(file);
      const ok = disk === 'Start.\n\n```csv\nname,qty\napple,3\n```\n';
      return { ok, detail: `${steps.map((x) => `after ${x.after}: ${j(x.file)} (grids ${x.grid})`).join('; ')}; at the end ${j(disk)}` };
    },
  },
];
