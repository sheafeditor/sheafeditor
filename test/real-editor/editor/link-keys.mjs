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
];
