// Front matter drawn in full, as one line, or not at all.
//
// jsdom can say what is in the DOM; only a real window can say how tall it is, which is
// the whole point of collapsing something. So the readings here are heights and
// positions: one line for a collapsed block, no height at all for a hidden one, and the
// first heading sitting where it would in a file that never had front matter.
//   node test/real-editor/run-editor.mjs front-matter [id]
const j = (x) => JSON.stringify(x);

const WITH = '---\ntitle: The quarterly plan\nslug: plan\ntags: [a, b]\nstatus: draft\n---\n\n# Heading\n\nA paragraph.\n';
const WITHOUT = '# Heading\n\nA paragraph.\n';

/** Where the first heading sits, and what the front matter is drawn as. */
const measure = (S) =>
  S.eval(() => {
    const heading = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) => l.textContent.includes('Heading'));
    // The collapsed block's own strip, not the chevron an open block also carries: both are
    // `.sheaf-frontmatter-fold`, and reading the loose selector made "opened" report a strip.
    const strip = document.querySelector('.sheaf-frontmatter-strip .sheaf-frontmatter-fold');
    const lines = [...document.querySelectorAll('.cm-content > .cm-line')].map((l) => l.textContent);
    return {
      headingTop: heading ? Math.round(heading.getBoundingClientRect().top) : null,
      strip: strip ? strip.textContent : null,
      stripHeight: strip ? Math.round(strip.getBoundingClientRect().height) : null,
      lineHeight: heading ? Math.round(heading.getBoundingClientRect().height) : null,
      showsYaml: lines.some((l) => l.includes('slug: plan')),
    };
  });

export const scenarios = [
  {
    id: 'render.front-matter.e05',
    feature: 'render.front-matter',
    name: 'Collapsed front matter is one line naming the document, and opening it puts every line back',
    run: async (S) => {
      const file = await S.fresh('fm-collapsed', WITH);
      // The caret lands at the top of a new document, which is inside the block and
      // opens it on purpose. Move into the prose first, as a reader would be.
      await S.caret('A paragraph', 2);
      await S.sleep(500);
      const folded = await measure(S);
      await S.click({ sel: '.sheaf-frontmatter-fold' });
      await S.sleep(400);
      const opened = await measure(S);
      const disk = await S.disk(file);
      const ok =
        folded.strip === 'Front matter: The quarterly plan' &&
        !folded.showsYaml &&
        // One line: the strip is no taller than a line of text, give or take a pixel.
        folded.stripHeight !== null &&
        folded.lineHeight !== null &&
        folded.stripHeight <= folded.lineHeight + 2 &&
        opened.strip === null &&
        opened.showsYaml &&
        disk === WITH;
      return { ok, detail: `collapsed ${j(folded)}; opened ${j(opened)}; file unchanged ${disk === WITH}` };
    },
  },
  {
    id: 'render.front-matter.e07',
    feature: 'render.front-matter',
    name: 'The chevron is this document from now on: closing and reopening the file finds it open, and another file follows the setting',
    run: async (S) => {
      // The half the fast suite cannot reach. It can check that the host keeps a state
      // and hands it back; only a window can check that the page asks for it early
      // enough, and that what comes back is what the person left.
      const file = await S.fresh('fm-kept', WITH);
      await S.caret('A paragraph', 2);
      await S.sleep(500);
      await S.click({ sel: '.sheaf-frontmatter-fold' });
      await S.sleep(400);
      const opened = await measure(S);
      // Another document, which should know nothing about this one's state.
      await S.fresh('fm-other', WITH);
      await S.caret('A paragraph', 2);
      await S.sleep(500);
      const other = await measure(S);
      // And back to the first, opened afresh.
      await S.open('e2e/fm-kept.md');
      await S.caret('A paragraph', 2);
      await S.sleep(600);
      const again = await measure(S);
      const disk = await S.disk(file);
      const ok = opened.showsYaml && other.strip !== null && !other.showsYaml && again.showsYaml && disk === WITH;
      return {
        ok,
        detail: `opened ${j(opened)}; a different file ${j(other)}; reopened ${j(again)}; file unchanged ${disk === WITH}`,
      };
    },
  },
  {
    id: 'render.front-matter.e06',
    feature: 'render.front-matter',
    name: 'Hidden front matter takes no height: the first heading sits where it would with no front matter at all',
    run: async (S) => {
      // The reading that matters, and the one jsdom cannot give: a hidden block has to
      // reclaim the space, not draw an empty box where it was.
      await S.fresh('fm-baseline', WITHOUT);
      await S.caret('A paragraph', 2);
      await S.sleep(500);
      const baseline = await measure(S);
      const file = await S.fresh('fm-hidden', WITH);
      await S.command('Sheaf: Hide Front Matter');
      await S.sleep(700);
      await S.caret('A paragraph', 2);
      await S.sleep(400);
      const hidden = await measure(S);
      const disk = await S.disk(file);
      try {
        const ok =
          hidden.strip === null &&
          !hidden.showsYaml &&
          hidden.headingTop !== null &&
          baseline.headingTop !== null &&
          Math.abs(hidden.headingTop - baseline.headingTop) <= 2 &&
          disk === WITH;
        return {
          ok,
          detail: `heading with no front matter at ${baseline.headingTop}, with it hidden at ${hidden.headingTop}; hidden ${j(hidden)}; file unchanged ${disk === WITH}`,
        };
      } finally {
        await S.command('Sheaf: Collapse Front Matter');
        await S.sleep(400);
      }
    },
  },
  {
    /*
     * The chevron on an open block folds it, and folding takes the caret with it.
     *
     * Open, the block was five lines of YAML with nothing to press: the only way back was the
     * right-click menu or the command palette, which nobody looks in for a control they just
     * used. A real window is where the two states can be set beside each other — the chevron
     * in the same place and the block's height going from five lines to one.
     */
    id: 'render.front-matter.e08',
    feature: 'render.front-matter',
    name: 'The chevron on an open block folds it, from the same place the collapsed strip\'s chevron sits',
    run: async (S) => {
      await S.fresh('fm-fold', WITH);
      await S.command('Sheaf: Show Front Matter');
      await S.sleep(800);
      const open = await measure(S);
      const chevron = await S.eval(() => {
        const el = document.querySelector('.sheaf-frontmatter-fold.is-open');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: Math.round(b.left), expanded: el.getAttribute('aria-expanded'), title: el.title };
      });
      // Put the caret in the metadata first: that is the case where folding must not leave it
      // inside something that is no longer drawn.
      await S.caret('slug: plan', 2);
      await S.sleep(300);
      await S.click({ sel: '.sheaf-frontmatter-fold.is-open' });
      await S.sleep(800);
      const folded = await measure(S);
      const after = await S.eval(() => {
        const content = document.querySelector('.cm-content');
        const tile = content && (content.cmTile || content.cmView);
        const view = tile && ((tile.root && tile.root.view) || tile.view);
        const el = document.querySelector('.sheaf-frontmatter-strip .sheaf-frontmatter-fold');
        return {
          caretLine: view ? view.state.doc.lineAt(view.state.selection.main.head).text : null,
          stripLeft: el ? Math.round(el.getBoundingClientRect().left) : null,
        };
      });
      const d = await S.disk();
      // One line where there were five, the caret out on the heading, and the two chevrons in
      // the same place. The file is untouched throughout: this is drawing, not bytes.
      const ok =
        open.showsYaml &&
        chevron?.expanded === 'true' &&
        !folded.showsYaml &&
        folded.strip !== null &&
        after.caretLine === '# Heading' &&
        chevron !== null &&
        after.stripLeft !== null &&
        Math.abs(chevron.left - after.stripLeft) <= 2 &&
        d === WITH;
      return {
        ok,
        detail:
          `open: ${j(open)}, chevron ${j(chevron)}; folded: ${j(folded)}; the caret landed on ${j(after.caretLine)}; ` +
          `the chevron was at ${chevron?.left} and the strip's is at ${after.stripLeft}${d === WITH ? '' : '; the file changed'}`,
      };
    },
  },
];
