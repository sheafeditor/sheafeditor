// The three link shortcuts in a real VS Code window: Cmd+K edits, Cmd+Shift+K removes,
// Cmd+Enter opens. Driven by real keys, because that is the whole question here — the
// window forwards every key it sees to the workbench whether or not the page handled it,
// and Cmd+Shift+K is Delete Line out there. jsdom has no workbench to lose the keyboard to.
//   node test/real-editor/run-editor.mjs link-keys [id]
import { show } from '../session.mjs';

const j = (x) => JSON.stringify(x);

async function waitFor(S, sel, want = true, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await S.exists(sel)) === want) return true;
    await S.sleep(100);
  }
  return (await S.exists(sel)) === want;
}

/** What the popover holds and which of its fields has the caret. */
const popover = (S) =>
  S.eval(() => {
    const pop = document.querySelector('.sheaf-linkpop');
    if (!pop) return { open: false };
    const text = pop.querySelector('.sheaf-linkpop-text');
    const url = pop.querySelector('.sheaf-linkpop-url');
    const active = document.activeElement;
    return {
      open: true,
      text: text?.value,
      url: url?.value,
      focused: active === url ? 'url' : active === text ? 'text' : (active?.className ?? 'elsewhere'),
    };
  });

/** The workbench facts a key that escaped to VS Code would move: the side bar and which view it shows. */
const workbench = (S) =>
  S.page.evaluate(() => {
    const sidebar = document.querySelector('.part.sidebar');
    const shown = !!sidebar && !sidebar.classList.contains('hidden') && sidebar.getBoundingClientRect().width > 10;
    const title = document.querySelector('.part.sidebar .composite.title h2, .part.sidebar .title-label')?.textContent ?? '';
    const tabs = [...document.querySelectorAll('.tabs-container .tab')].map((t) => t.getAttribute('aria-label') ?? '');
    return { sidebar: shown, view: title.trim(), tabs };
  });

export const scenarios = [
  {
    id: 'menus.link-popover.e09',
    feature: 'menus.link-popover',
    name: 'Cmd+K with the caret in a link puts the caret in its address field and writes nothing; Esc leaves the file as it was',
    run: async (S) => {
      const doc = 'Intro line.\n\nRead the [guide](https://a.io/g) first.\n';
      await S.fresh('link-keys-edit', doc);
      // Off the link first, so the popover that appears is the one Cmd+K asked for.
      await S.caret('Intro', 2);
      await S.sleep(400);
      const before = await waitFor(S, '.sheaf-linkpop', false, 1000);
      await S.caret('guide', 2);
      await S.sleep(400);
      await S.press('Meta+k');
      await S.sleep(300);
      const pop = await popover(S);
      // The caret really is in the field, not just near it: a letter typed now goes into the
      // field and nowhere near the document.
      await S.type('X');
      const typed = await popover(S);
      const onDisk = await S.disk();
      await S.press('Escape');
      await S.sleep(300);
      const closed = await waitFor(S, '.sheaf-linkpop', false, 1500);
      const after = await S.disk();
      const ok =
        before &&
        pop.open &&
        pop.focused === 'url' &&
        pop.text === 'guide' &&
        pop.url === 'https://a.io/g' &&
        typed.url === 'X' &&
        onDisk === doc &&
        closed &&
        after === doc;
      return {
        ok,
        detail: `no popover before ${before}; after Cmd+K ${j(pop)}; typing X gave address ${j(typed.url)}; file while open ${show(onDisk)}; closed on Esc ${closed}; file after ${show(after)}`,
      };
    },
  },
  {
    id: 'prose.link-insert.e05',
    feature: 'prose.link-insert',
    name: 'Cmd+Shift+K takes the link off, Sheaf keeps the keyboard, the window is left alone, and Cmd+Z puts the link back',
    run: async (S) => {
      const doc = 'Intro line.\n\nRead the [guide](https://a.io/g) first.\n';
      await S.fresh('link-keys-remove', doc);
      await S.caret('guide', 2);
      await S.sleep(400);
      const before = await workbench(S);
      await S.press('Meta+Shift+k');
      await S.sleep(400);
      const removed = await S.disk();
      const after = await workbench(S);
      /*
       * The shape of the failure where a key Sheaf handles also reaches VS Code, which runs
       * its own command and takes the keyboard, so the next letter typed goes nowhere near
       * the file. The side bar and the view were never seen to move for this key, with the
       * fix in or out, so those two comparisons are a guard rather than a measurement; the
       * typed letter is the part that discriminates.
       */
      await S.type('Z');
      await S.sleep(300);
      const typed = await S.disk();
      await S.press('Meta+z Meta+z');
      await S.sleep(400);
      const undone = await S.disk();
      const wantRemoved = 'Intro line.\n\nRead the guide first.\n';
      const ok =
        removed === wantRemoved &&
        after.sidebar === before.sidebar &&
        after.view === before.view &&
        after.tabs.length === before.tabs.length &&
        typed.includes('Z') &&
        undone === doc;
      return {
        ok,
        detail:
          `unlinked to ${show(removed)}` +
          (removed === wantRemoved ? '' : ` rather than ${show(wantRemoved)}`) +
          `; window before ${j(before)} after ${j(after)}; the typed letter ${typed.includes('Z') ? 'reached' : 'did not reach'} the file (${show(typed)}); two undos gave ${show(undone)}`,
      };
    },
  },
  {
    /*
     * The half that only a real window can answer. `Shift-Mod-k` is Delete Line in
     * CodeMirror's default keymap and Delete Line in VS Code, so a press that found no link
     * and declined the key takes the line out of the document. Measured, with the command
     * returning false for a miss: the line goes, and it goes from inside — the side bar, the
     * view and the keyboard were all where they started, so the workbench did not also run
     * its own Delete Line over a custom editor. Every scenario above presses the key on a
     * link, where the command answers and nothing falls through, so none of them sees any of it.
     */
    id: 'prose.link-insert.e06',
    feature: 'prose.link-insert',
    name: 'Cmd+Shift+K away from any link leaves the line alone, rather than letting Delete Line have the key',
    run: async (S) => {
      const doc = 'Intro line.\n\nRead the [guide](https://a.io/g) first.\n\nA third line.\n';
      await S.fresh('link-keys-miss', doc);
      await S.caret('A third', 4);
      await S.sleep(400);
      const before = await workbench(S);
      await S.press('Meta+Shift+k');
      await S.sleep(500);
      const after = await S.disk();
      const win = await workbench(S);
      await S.type('Z');
      await S.sleep(300);
      const typed = await S.disk();
      const ok = after === doc && win.sidebar === before.sidebar && win.view === before.view && typed.includes('Z');
      return {
        ok,
        detail:
          `the file is ${show(after)}` +
          (after === doc ? '' : ` rather than ${show(doc)}`) +
          `; window before ${j(before)} after ${j(win)}; the typed letter ${typed.includes('Z') ? 'reached' : 'did not reach'} the file (${show(typed)})`,
      };
    },
  },
  {
    id: 'prose.link-insert.e07',
    feature: 'prose.link-insert',
    name: 'Select a word and press Cmd+K: the popover asks for the address, and Enter writes the link and draws it',
    run: async (S) => {
      const doc = 'Intro line.\n\nRead the docs today.\n';
      await S.fresh('link-new-word', doc);
      await S.select('docs');
      await S.sleep(400);
      await S.press('Meta+k');
      await S.sleep(300);
      const pop = await popover(S);
      const pending = await S.disk();
      // The caret is in the address field already, so typing goes there and nowhere near the file.
      await S.type('https://x.io');
      await S.press('Enter');
      await S.sleep(500);
      const written = await S.disk();
      const drawn = await S.eval(() =>
        [...document.querySelectorAll('.cm-line')]
          .filter((l) => l.textContent.startsWith('Read the'))
          .map((l) => `${l.textContent}|${[...l.querySelectorAll('.tok-link')].map((a) => a.textContent).join(',')}`)
          .join('')
      );
      const want = 'Intro line.\n\nRead the [docs](https://x.io) today.\n';
      const ok = pop.open && pop.focused === 'url' && pop.text === 'docs' && pending === doc && written === want && drawn === 'Read the docs today.|docs';
      return {
        ok,
        detail: `the popover arrived as ${j(pop)}; the file while asking ${show(pending)}; after Enter ${show(written)}` +
          (written === want ? '' : ` rather than ${show(want)}`) +
          `; the line draws as ${j(drawn)} (text|links)`,
      };
    },
  },
  {
    id: 'prose.link-insert.e08',
    feature: 'prose.link-insert',
    name: 'Esc after typing an address leaves the file byte-for-byte as it was, with no placeholder behind',
    run: async (S) => {
      const doc = 'Intro line.\n\nRead the docs today.\n';
      await S.fresh('link-new-esc', doc);
      await S.select('docs');
      await S.sleep(400);
      await S.press('Meta+k');
      await S.sleep(300);
      await S.type('https://x.io');
      await S.press('Escape');
      await S.sleep(500);
      const after = await S.disk();
      const closed = await waitFor(S, '.sheaf-linkpop', false, 1500);
      // And the editor has the keyboard back, so the next letter goes into the document.
      await S.type('Z');
      await S.sleep(300);
      const typed = await S.disk();
      const ok = after === doc && closed && typed !== doc && typed.includes('Z');
      return { ok, detail: `after Esc ${show(after)}, popover gone ${closed}; the next letter gave ${show(typed)}` };
    },
  },
  {
    id: 'prose.link-insert.e09',
    feature: 'prose.link-insert',
    name: 'Cmd+K on a blank line asks for the words first, and Tab moves to the address',
    run: async (S) => {
      const doc = 'Intro line.\n\n';
      await S.fresh('link-new-caret', doc);
      await S.caret('Intro', 2);
      await S.press('ArrowDown ArrowDown End');
      await S.sleep(300);
      await S.press('Meta+k');
      await S.sleep(300);
      const first = await popover(S);
      await S.type('the plan');
      // Tab between the two fields, which is the popover's own key and not the editor's.
      await S.press('Tab');
      const moved = (await popover(S)).focused;
      await S.type('plan.md');
      await S.press('Enter');
      await S.sleep(500);
      const written = await S.disk();
      const want = 'Intro line.\n\n[the plan](plan.md)';
      const ok = first.focused === 'text' && first.text === '' && moved === 'url' && written === want;
      return {
        ok,
        detail: `the caret landed on ${j(first.focused)} with the words ${j(first.text)}; Tab moved it to ${j(moved)}; the file is ${show(written)}` +
          (written === want ? '' : ` rather than ${show(want)}`),
      };
    },
  },
  {
    /*
     * Pasting a path to another document writes a link carrying that document's title.
     *
     * A real window is the only place this can be checked end to end, and the part only it can
     * see is the middle: the page's own request and reply plumbing lives in `main.ts`, which
     * boots a view the moment it loads and so is not reachable from the suites. Broken on
     * purpose there — the reply never matched to its request — every suite still passed.
     */
    id: 'prose.link-paste.e04',
    feature: 'prose.link-paste',
    name: 'Pasting a path to another document writes a link carrying that document’s title',
    run: async (S) => {
      await S.fresh('link-paste-plan', '# Launch plan\n\nThe target.\n');
      await S.fresh('link-paste-bare', 'No heading in this one.\n');
      const doc = 'Intro line.\n\nSee \n';
      await S.fresh('link-paste-into', doc);
      await S.caret('See ', 4);
      await S.press('End');
      await S.sleep(300);
      await S.clipboard.write('link-paste-plan.md');
      await S.press('Meta+v');
      await S.sleep(700);
      const titled = await S.disk();
      // A file with no heading is its file name, which is the fallback.
      await S.press('Enter');
      await S.clipboard.write('link-paste-bare.md');
      await S.press('Meta+v');
      await S.sleep(700);
      const bare = await S.disk();
      const want = 'Intro line.\n\nSee [Launch plan](link-paste-plan.md)\n';
      const wantBare = `${want}[link-paste-bare](link-paste-bare.md)\n`;
      return {
        ok: titled === want && bare === wantBare,
        detail:
          `the titled one gave ${show(titled)}` +
          (titled === want ? '' : ` rather than ${show(want)}`) +
          `; the one with no heading gave ${show(bare)}` +
          (bare === wantBare ? '' : ` rather than ${show(wantBare)}`),
      };
    },
  },
  {
    id: 'prose.link-paste.e05',
    feature: 'prose.link-paste',
    name: 'A pasted path the workspace does not hold pastes as the text it is',
    run: async (S) => {
      // Outside the workspace the link would resolve here and be broken for everybody who
      // clones the repository, so the host answers nothing and the paste is a plain paste.
      const doc = 'Intro line.\n\nSee \n';
      await S.fresh('link-paste-outside', doc);
      await S.caret('See ', 4);
      await S.press('End');
      await S.sleep(300);
      await S.clipboard.write('/elsewhere/on/disk/plan.md');
      await S.press('Meta+v');
      await S.sleep(900);
      const after = await S.disk();
      const want = 'Intro line.\n\nSee /elsewhere/on/disk/plan.md\n';
      return {
        ok: after === want,
        detail: `the file is ${show(after)}` + (after === want ? '' : ` rather than ${show(want)}`),
      };
    },
  },
  {
    /*
     * A plain click on a link in a closed cell opens it. Only a real window can answer this:
     * it is one gesture made of a press and a release with a layout under them, and the
     * question is which of the two the grid acts on.
     */
    id: 'tables.cell-link.e01',
    feature: 'tables.cell-link',
    name: 'One click on a link in a table cell opens that document, and leaves the table alone',
    run: async (S) => {
      await S.fresh('cell-link-target', '# Launch plan\n\nThe target.\n');
      const doc = 'Intro line.\n\n| Doc | Note |\n| --- | --- |\n| [the plan](cell-link-target.md) | a note |\n';
      await S.fresh('cell-link-table', doc);
      await S.sleep(500);
      await S.click({ sel: '.sheaf-table-grid .tok-link', hasText: 'the plan' });
      await S.sleep(1500);
      const active = await S.page
        .locator('.editor-group-container.active .tabs-container .tab.active')
        .first()
        .getAttribute('aria-label')
        .catch(() => '');
      const after = await S.disk(`${S.ws}/e2e/cell-link-table.md`);
      const ok = /cell-link-target\.md/.test(active ?? '') && after === doc;
      return {
        ok,
        detail: `the active tab is ${j(active)}; the table's file is ${show(after)}`,
      };
    },
  },
  {
    id: 'render.links.e11',
    feature: 'render.links',
    name: 'Cmd+Enter on a link to another document opens that document, and leaves this one as it was',
    run: async (S) => {
      await S.fresh('link-keys-target', '# Launch plan\n\nThe target document.\n');
      const doc = 'Intro line.\n\nRead the [plan](link-keys-target.md) first.\n';
      await S.fresh('link-keys-open', doc);
      await S.caret('plan', 2);
      await S.sleep(400);
      await S.press('Meta+Enter');
      await S.sleep(1500);
      const tabs = await workbench(S);
      const active = await S.page
        .locator('.editor-group-container.active .tabs-container .tab.active')
        .first()
        .getAttribute('aria-label')
        .catch(() => '');
      const after = await S.disk(`${S.ws}/e2e/link-keys-open.md`);
      const ok = /link-keys-target\.md/.test(active ?? '') && after === doc;
      return {
        ok,
        detail: `the active tab is ${j(active)} among ${j(tabs.tabs)}; the document it was pressed in is ${show(after)}`,
      };
    },
  },
  {
    id: 'tables.cell-link.e02',
    feature: 'tables.cell-link',
    name: 'Right-click a link in a cell that is open for editing: the link popover opens with the address focused, and no menu does',
    run: async (S) => {
      /*
       * R5, which had two cases written and no scenario. A real window, because it is a
       * right-click on a layout and the question is which of two handlers answers it.
       *
       * Both handlers are real and the order is the whole point. `contextmenu.ts` returns
       * immediately for a right-click inside a text field, and an open cell is one; the popover
       * comes from a separate listener that `cellEditor.ts` adds on the cell's host in the
       * **capture** phase, so it runs on the way down and gets there first. Reading only the
       * document's handler makes R5 look impossible.
       *
       * The host is `.sheaf-table-input.is-markdown`, which `markdownCell` builds, and a pipe
       * table's cells get it because `spec.markdown` is true for them. The plain `.sheaf-table-input`
       * a data cell gets is a real text field, so the document's handler bails on it and the
       * platform's menu is what appears there: that is `menus.context-cell` R4, not this.
       */
      const doc = 'Intro line.\n\n| Doc | Note |\n| --- | --- |\n| [the plan](cell-link-elsewhere.md) | a note |\n';
      await S.fresh('cell-link-pop', doc);
      await S.sleep(600);

      /*
       * Opened by double-clicking the **cell**, not the link in it. A double-click on the link is
       * taken by the link handler and never reaches the cell, so the first draft of this scenario
       * left the table a grid with the cell merely selected and failed looking for a link inside
       * an editor that was never built. The cell is wider than the words, so the middle of the
       * `td` is past them.
       *
       * The cell has to actually be open, or this measures the closed-cell path and passes for
       * the wrong reason: a right-click on a link in a *closed* cell is R1's business and opens
       * the popover too. So the cell editor is confirmed present before the gesture, and the
       * reading says so either way.
       */
      await S.dblclick('.sheaf-table-grid td[data-r="0"][data-c="0"]');
      const opened = await waitFor(S, '.sheaf-table .sheaf-table-input.is-markdown .cm-content', true, 2000);
      await S.sleep(300);

      await S.click({ sel: '.sheaf-table .sheaf-table-input.is-markdown .tok-link', hasText: 'the plan' }, { button: 'right' });
      await S.sleep(500);
      const pop = await popover(S);
      const menu = await S.eval(() => !!document.querySelector('.sheaf-ctx-menu:not([hidden])'));
      const d = await S.disk();

      return {
        ok: opened && pop.open && pop.focused === 'url' && !menu && d === doc,
        detail:
          `${opened ? 'the cell is open for editing' : 'THE CELL DID NOT OPEN, so this is not a reading about an open cell'}; ` +
          `popover ${pop.open ? `open, url ${j(pop.url)}, caret in ${j(pop.focused)}` : 'did not open'}; ` +
          `${menu ? 'A MENU OPENED TOO' : 'no menu opened'}; ${show(d)}`,
      };
    },
  },
  {
    id: 'tables.cell-link.e04',
    feature: 'tables.cell-link',
    name: 'Double-click a link in a closed cell: either the link opens or the cell does, and not neither',
    run: async (S) => {
      /*
       * Found by getting e02 wrong, and then by getting the diagnosis wrong too, which is why the
       * fixture here is built the way it is.
       *
       * e02's first draft opened the cell by double-clicking the link. The run came back with the
       * table still a grid and the cell merely selected, and the screenshot showed no second tab,
       * which read as a gesture that does neither of the two things it could sensibly do. It is
       * not: that fixture's link pointed at the file holding it, so the link **did** open and
       * opened the document already in front of it. **A fixture whose link points at its own file
       * cannot tell "the link opened" from "nothing happened".**
       *
       * So this one points at a separate document, and the behaviour is that a double-click on a
       * link opens the link and leaves the cell closed. Worth pinning because both halves are
       * promised elsewhere and a person meets it without trying: one click on a link opens it, and
       * a cell opens for editing on a double-click, and a cell whose whole content is a link has
       * no other place to aim at.
       *
       * It asserts the disjunction rather than which one, because which of the two should win is a
       * product question nobody has answered and asserting either would invent the answer here.
       * The detail says which it got, so a change of mind reads as a changed reading.
       */
      await S.fresh('cell-link-dbl-target', '# Launch plan\n\nThe target.\n');
      const doc = 'Intro line.\n\n| Doc | Note |\n| --- | --- |\n| [the plan](cell-link-dbl-target.md) | a note |\n';
      await S.fresh('cell-link-dbl', doc);
      await S.sleep(600);
      await S.dblclick({ sel: '.sheaf-table-grid .tok-link', hasText: 'the plan' });
      await S.sleep(1500);

      const cellOpen = await S.exists('.sheaf-table .sheaf-table-input');
      const tab = await S.page
        .locator('.editor-group-container.active .tabs-container .tab.active')
        .first()
        .getAttribute('aria-label')
        .catch(() => '');
      const linkOpened = /cell-link-dbl-target\.md/.test(tab ?? '');
      const d = await S.disk(`${S.ws}/e2e/cell-link-dbl.md`);
      return {
        ok: (cellOpen || linkOpened) && d === doc,
        detail:
          `the cell ${cellOpen ? 'opened for editing' : 'did not open'}; the link ${linkOpened ? 'opened its document' : 'did not open'}; ` +
          `${cellOpen || linkOpened ? '' : 'NEITHER HAPPENED, so the gesture does nothing a person can see. '}` +
          `the active tab is ${j(tab)}; the table's file is ${show(d)}`,
      };
    },
  },
  {
    id: 'tables.cell-link.e03',
    feature: 'tables.cell-link',
    name: 'Control for the above: right-click a cell with no link in it and the popover stays shut',
    run: async (S) => {
      /*
       * Without this, e02 passes for a popover that opens on any right-click in an open cell, or
       * on opening a cell at all, and R5's claim is specifically about the link.
       *
       * It asserts only the discriminating half, that no popover appears. Which menu *does* come
       * up is `menus.context-cell`'s question and the answer depends on whether a cell is a
       * Markdown editor or a plain text box, so this one reports what it saw and asserts nothing
       * about it rather than guessing.
       */
      const doc = 'Intro line.\n\n| Doc | Note |\n| --- | --- |\n| [the plan](cell-link-elsewhere.md) | a note |\n';
      await S.fresh('cell-link-nopop', doc);
      await S.sleep(600);
      await S.dblclick({ sel: '.sheaf-table-grid td', hasText: 'a note' });
      const opened = await waitFor(S, '.sheaf-table .sheaf-table-input.is-markdown .cm-content', true, 2000);
      await S.sleep(300);
      await S.click({ sel: '.sheaf-table .sheaf-table-input.is-markdown .cm-content', hasText: 'a note' }, { button: 'right' });
      await S.sleep(500);
      const pop = await popover(S);
      const menu = await S.eval(() => !!document.querySelector('.sheaf-ctx-menu:not([hidden])'));
      const d = await S.disk();
      return {
        ok: opened && !pop.open && d === doc,
        detail:
          `${opened ? 'the cell is open for editing' : 'THE CELL DID NOT OPEN, so this control says nothing'}; ` +
          `${pop.open ? `THE POPOVER OPENED over a cell with no link, url ${j(pop.url)}, so e02 is not about the link` : 'the popover stayed shut'}; ` +
          `Sheaf's own menu ${menu ? 'opened' : 'did not open, so the platform menu is what a person gets here'}; ${show(d)}`,
      };
    },
  },
  {
    id: 'tables.cell-link.e05',
    feature: 'tables.cell-link',
    name: 'A drag that begins on a link marks cells and opens nothing, released two cells away or on a second link',
    run: async (S) => {
      /*
       * R3, which had two cases and no scenario. Only a real window can answer it: the whole
       * question is whether the grid acts on the press or on the release, and the press here is the
       * start of a selection rather than a click.
       *
       * The third reading is the control and it has to come last, because it opens a tab. Without
       * it, both refusals pass for a link that was never live: a drag opening nothing and a dead
       * link opening nothing read exactly the same from outside.
       */
      await S.fresh('drag-link-a', '# The plan\n\nFirst target.\n');
      await S.fresh('drag-link-b', '# The note\n\nSecond target.\n');
      const doc =
        'Intro line.\n\n| Doc | Other |\n| --- | --- |\n| [the plan](drag-link-a.md) | [the note](drag-link-b.md) |\n| plain | text |\n';
      const path = await S.fresh('cell-link-drag', doc);
      await S.sleep(600);
      /*
       * Which tab is **active**, not which tabs exist. The first draft asked whether a tab for either
       * target was open at all and failed on its own setup: making the two targets with `S.fresh`
       * opens them, so both were already there before the first gesture and every reading said a
       * document had opened. Following a link brings its tab to the front, which is the thing to read.
       */
      const active = () =>
        S.page
          .locator('.editor-group-container.active .tabs-container .tab.active')
          .first()
          .getAttribute('aria-label')
          .catch(() => '');
      const openedAny = async () => /drag-link-[ab]\.md/.test((await active()) ?? '');
      const picked = () => S.eval(() => document.querySelectorAll('.sheaf-table .is-sel').length);
      const link = (text) => ({ sel: '.sheaf-table-grid .tok-link', hasText: text });

      await S.drag(link('the plan'), { sel: '.sheaf-table-grid td[data-r="1"][data-c="1"]' });
      await S.sleep(600);
      const away = { picked: await picked(), opened: await openedAny(), on: await active() };

      await S.drag(link('the plan'), link('the note'));
      await S.sleep(600);
      const onLink = { picked: await picked(), opened: await openedAny(), on: await active() };

      // CONTROL: the same link, clicked rather than dragged, does open its document.
      await S.click(link('the plan'));
      await S.sleep(1500);
      const control = await openedAny();
      const d = await S.disk(path);

      return {
        ok: away.picked > 1 && !away.opened && !onLink.opened && control && d === doc,
        detail:
          `released two cells away: ${away.picked} cells marked, ${away.opened ? 'A DOCUMENT OPENED' : `still on ${j(away.on)}`}; ` +
          `released on the second link: ${onLink.picked} cells marked, ${onLink.opened ? 'A DOCUMENT OPENED' : `still on ${j(onLink.on)}`}; ` +
          `CONTROL, the same link clicked: ${control ? 'opened, so the link was live throughout' : 'OPENED NOTHING, so the two refusals above say nothing'}; ` +
          `the table's file is ${show(d)}`,
      };
    },
  },
  {
    id: 'tables.cell-link.e06',
    feature: 'tables.cell-link',
    name: 'A plain click on a link inside a cell that is open for editing opens it, as it does in prose',
    run: async (S) => {
      /*
       * R4, the instance of `tables.cell-edit` R13 that this feature owns: a Markdown cell open for
       * editing is the prose editor, so a link in it behaves as a link in a paragraph does.
       *
       * The cell is opened by double-clicking the `td` past the words rather than the link itself,
       * which e02 found the hard way: a double-click on the link is taken by the link handler and
       * the cell never opens. The reading says whether the cell was open either way, because a
       * click on a link in a *closed* cell opens it under R1 and would pass this for R1's reason.
       */
      await S.fresh('open-cell-link-target', '# The plan\n\nThe target.\n');
      const doc = 'Intro line.\n\n| Doc | Note |\n| --- | --- |\n| [the plan](open-cell-link-target.md) | a note |\n';
      const path = await S.fresh('cell-link-open-cell', doc);
      await S.sleep(600);
      await S.dblclick('.sheaf-table-grid td[data-r="0"][data-c="0"]');
      const opened = await waitFor(S, '.sheaf-table .sheaf-table-input.is-markdown .cm-content', true, 2000);
      await S.sleep(300);
      await S.click({ sel: '.sheaf-table .sheaf-table-input.is-markdown .tok-link', hasText: 'the plan' });
      await S.sleep(1500);
      const active = await S.page
        .locator('.editor-group-container.active .tabs-container .tab.active')
        .first()
        .getAttribute('aria-label')
        .catch(() => '');
      const d = await S.disk(path);
      return {
        ok: opened && /open-cell-link-target\.md/.test(active ?? '') && d === doc,
        detail:
          `${opened ? 'the cell is open for editing' : 'THE CELL DID NOT OPEN, so this is R1 in an open cell’s clothing'}; ` +
          `the active tab is ${j(active)}; the table's file is ${show(d)}`,
      };
    },
  },
];
