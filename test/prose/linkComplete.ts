import { Scenario, Prose, mountProse } from '../harness';
import { handleWorkspaceFiles, linkCompletionOf, setLinkCompleteDocument, setWorkspaceFilesHost } from '../../src/webview/linkComplete';

/** Type text at the caret one character at a time, as keyboard input arrives. */
function type(p: Prose, text: string): void {
  for (const ch of text) {
    const head = p.view.state.selection.main.head;
    p.view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: 'input.type' });
  }
}

/** Let the host's answer arrive: requests go out a turn after the list opens. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The workspace the stand-in host answers with, as workspace-relative paths. */
const WORKSPACE = ['docs/guide.md', 'docs/intro.md', 'notes/plan.md', 'notes/my notes.md', 'img/plan.png', 'README.md'];

/** A host that answers every file-list request with `files`; returns the requests it saw. */
function answeringHost(files: string[] = WORKSPACE): unknown[] {
  const asked: unknown[] = [];
  setWorkspaceFilesHost((message) => {
    asked.push(message);
    const { id } = message as { id: string };
    setTimeout(() => handleWorkspaceFiles(id, files), 0);
  });
  setLinkCompleteDocument('docs/guide.md');
  return asked;
}

/** A host that takes the request and never answers, as the browser host does with a message it does not know. */
function silentHost(): unknown[] {
  const asked: unknown[] = [];
  setWorkspaceFilesHost((message) => asked.push(message));
  setLinkCompleteDocument('docs/guide.md');
  return asked;
}

function noHost(): void {
  setWorkspaceFilesHost(null);
  setLinkCompleteDocument('');
}

/** What the open completion lists, as the text each row writes, or null when nothing is shown. */
function listed(p: Prose): string[] | null {
  const c = linkCompletionOf(p.view.state);
  return c && c.items.length ? c.items.map((i) => i.insert) : null;
}

/** The rows drawn on the page, as their visible labels. */
function drawnRows(): string[] {
  return Array.from(document.querySelectorAll('.sheaf-link-complete .sheaf-slash-item')).map((row) => row.querySelector('.sheaf-slash-label')?.textContent ?? '');
}

/** Mount `doc` with the caret at its end and a host in place, run `body`, and clean up. */
async function withEditor(doc: string, host: () => unknown, body: (p: Prose) => Promise<boolean> | boolean): Promise<boolean> {
  host();
  const p = mountProse(doc);
  p.select(doc.length);
  try {
    return await body(p);
  } finally {
    p.destroy();
    noHost();
  }
}

export const scenarios: Scenario[] = [
  {
    name: 'link completion: typing [spec]( lists workspace files relative to this document, Markdown first, not the document itself',
    run: () =>
      withEditor('See ', answeringHost, async (p) => {
        type(p, '[spec](');
        await settle();
        await settle();
        const items = listed(p) ?? [];
        const md = items.filter((i) => /\.md>?$/.test(i));
        const firstOther = items.findIndex((i) => !/\.md>?$/.test(i));
        return (
          items.includes('intro.md') &&
          items.includes('../notes/plan.md') &&
          items.includes('../README.md') &&
          items.includes('../img/plan.png') &&
          !items.includes('guide.md') &&
          firstOther === md.length &&
          drawnRows().length === items.length
        );
      }),
  },
  {
    name: 'link completion: typing after ]( narrows the files, a file name starting with it first',
    run: () =>
      withEditor('', answeringHost, async (p) => {
        type(p, '[spec](');
        await settle();
        await settle();
        type(p, 'pla');
        const items = listed(p) ?? [];
        return items.length === 2 && items[0] === '../notes/plan.md' && items[1] === '../img/plan.png';
      }),
  },
  {
    name: 'link completion: Enter writes the path relative to the document and closes the link',
    run: () =>
      withEditor('', answeringHost, async (p) => {
        type(p, '[spec](');
        await settle();
        await settle();
        type(p, 'plan');
        const handled = p.press('Enter');
        return handled && p.doc() === '[spec](../notes/plan.md)' && p.view.state.selection.main.head === p.doc().length && linkCompletionOf(p.view.state) === null;
      }),
  },
  {
    name: 'link completion: a path holding a space is written inside angle brackets',
    run: () =>
      withEditor('', answeringHost, async (p) => {
        type(p, '[mine](');
        await settle();
        await settle();
        type(p, 'my');
        const handled = p.press('Tab');
        return handled && p.doc() === '[mine](<../notes/my notes.md>)';
      }),
  },
  {
    name: 'link completion: [intro](# lists this document’s headings and writes the slug, a repeated heading with -1',
    run: () =>
      withEditor('# Intro\n\n## Hazard flags: now!\n\n## Intro\n\nSee ', noHost, async (p) => {
        type(p, '[intro](#');
        const c = linkCompletionOf(p.view.state);
        const labels = c?.items.map((i) => i.label) ?? [];
        const inserts = c?.items.map((i) => i.insert) ?? [];
        const listedRight =
          JSON.stringify(labels) === JSON.stringify(['Intro', 'Hazard flags: now!', 'Intro']) &&
          JSON.stringify(inserts) === JSON.stringify(['#intro', '#hazard-flags-now', '#intro-1']) &&
          JSON.stringify(c?.items.map((i) => i.level)) === JSON.stringify([1, 2, 2]);
        p.press('ArrowDown');
        p.press('ArrowDown');
        p.press('Enter');
        return listedRight && p.doc().endsWith('See [intro](#intro-1)');
      }),
  },
  {
    name: 'link completion: typing after ](# narrows the headings',
    run: () =>
      withEditor('# Intro\n\n## Hazard flags\n\nSee ', noHost, async (p) => {
        type(p, '[x](#haz');
        return JSON.stringify(listed(p)) === JSON.stringify(['#hazard-flags']);
      }),
  },
  {
    name: 'link completion: nothing opens inside a fenced block, inline code or front matter',
    run: async () => {
      // Each document with the caret where the link would be typed: in a fence's
      // code, between an inline span's backticks, and in a front matter value.
      const cases: Array<[string, number]> = [
        ['# Intro\n\n```\ncode \n```\n', 18],
        ['# Intro\n\na `code x` b\n', 17],
        ['---\ntitle: \n---\n\n# Intro\n', 11],
      ];
      let ok = true;
      for (const [doc, at] of cases) {
        const opened = await withEditor(doc, answeringHost, async (p) => {
          p.select(at);
          type(p, '[a](');
          await settle();
          await settle();
          type(p, '#');
          return linkCompletionOf(p.view.state) !== null || document.querySelector('.sheaf-link-complete') !== null;
        });
        if (opened) ok = false;
      }
      return ok;
    },
  },
  {
    name: 'link completion: a parenthesis not closing a link text opens nothing',
    run: () =>
      withEditor('# Intro\n\n', answeringHost, async (p) => {
        type(p, 'see (');
        await settle();
        type(p, '#');
        const a = linkCompletionOf(p.view.state) === null;
        type(p, '\n- [ ](#');
        return a && linkCompletionOf(p.view.state) === null;
      }),
  },
  {
    name: 'link completion: Escape leaves ]( as typed, and one Cmd+Z undoes the typing',
    run: () =>
      withEditor('', answeringHost, async (p) => {
        type(p, '[spec](');
        await settle();
        await settle();
        const open = listed(p) !== null;
        const escaped = p.press('Escape');
        const kept = p.doc() === '[spec](' && linkCompletionOf(p.view.state) === null && document.querySelector('.sheaf-link-complete') === null;
        p.press('Mod-z');
        return open && escaped && kept && p.doc() === '';
      }),
  },
  {
    name: 'link completion: accepting is one undo step that puts back what was typed',
    run: () =>
      withEditor('', answeringHost, async (p) => {
        type(p, '[spec](');
        await settle();
        await settle();
        p.press('Enter');
        // With nothing typed after the parenthesis, the shortest Markdown path leads.
        const accepted = p.doc() === '[spec](intro.md)';
        p.press('Mod-z');
        return accepted && p.doc() === '[spec](';
      }),
  },
  {
    name: 'link completion: Backspace past the ( closes the list',
    run: () =>
      withEditor('', answeringHost, async (p) => {
        type(p, '[spec](');
        await settle();
        await settle();
        type(p, 'p');
        p.press('Backspace');
        const stillOpen = listed(p) !== null;
        p.press('Backspace');
        return stillOpen && p.doc() === '[spec]' && linkCompletionOf(p.view.state) === null;
      }),
  },
  {
    name: 'link completion: with a host that never answers there is no file list, and headings still complete',
    run: () =>
      withEditor('# Intro\n\n', silentHost, async (p) => {
        type(p, '[a](');
        await settle();
        await settle();
        const noFiles = listed(p) === null && document.querySelector('.sheaf-link-complete') === null;
        type(p, '#');
        return noFiles && JSON.stringify(listed(p)) === JSON.stringify(['#intro']);
      }),
  },
  {
    name: 'link completion: the file list is asked for once per ](, and only when there is a document',
    run: async () => {
      const asked = answeringHost();
      const p = mountProse('');
      type(p, '[a](');
      await settle();
      type(p, 'x');
      await settle();
      const once = asked.length === 1 && (asked[0] as { type: string }).type === 'workspaceFilesRead';
      p.destroy();
      noHost();
      return once;
    },
  },
  {
    name: 'link completion: the document changes only on accept, never while the list is open',
    run: () =>
      withEditor('Intro text ', answeringHost, async (p) => {
        type(p, '[spec](');
        await settle();
        await settle();
        const before = p.doc();
        p.press('ArrowDown');
        p.press('ArrowDown');
        p.press('ArrowUp');
        const unchanged = p.doc() === before && before === 'Intro text [spec](';
        return unchanged && listed(p) !== null && drawnRows().length > 0;
      }),
  },
];
