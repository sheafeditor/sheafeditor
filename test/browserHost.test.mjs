/*
 * The browser host: what a tab does with the messages the editor posts out.
 *
 *   node test/browserHost.test.mjs
 *
 * The project's rule is that the editor bundle is the same bytes in every host, and a
 * host is only what supplies `acquireVsCodeApi()` and `window.postMessage`. That makes
 * `src/server/host.ts` the whole of what the browser host is, and until this suite it
 * was the one file with no check on it at all: the server suite drives the server over
 * HTTP and never loads the page's own module, and the webview suites mount the editor
 * with a stand-in `acquireVsCodeApi`, which replaces exactly the thing this file is.
 *
 * What that cost: a `setFrontMatter` case was missing, so a menu item that worked in VS
 * Code silently did nothing in a tab, and the case beside it carried a cast calling a
 * three-valued setting a boolean. Neither failed anything.
 *
 * The module is driven rather than read. Each check posts a message the way the editor
 * does and reads two things back: what reached the editor through `window.postMessage`,
 * and what reached the server through `fetch`.
 */

import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const cases = [];
const check = (name, run) => cases.push({ name, run });
const j = (x) => JSON.stringify(x);
const settle = () => new Promise((r) => setTimeout(r, 0));

/** What the server answers, by the path the host asks for. Each check sets what it needs. */
const DOC = {
  text: '# Notes\n\nA line.\n',
  config: { tableOfContents: 'hidden', frontMatter: 'collapsed' },
  fileName: 'notes.md',
  resourceBaseUri: '/file/',
  capabilities: { terminal: false },
};

/**
 * A fresh tab: a jsdom window with the boot element the host reads, a `fetch` that
 * records every request and answers from `replies`, and the module loaded into it.
 *
 * Loaded once per check rather than once per suite, because the host keeps state — the
 * text it believes the server holds, and the config the toolbar works from — and a check
 * that inherited the last one's would be reading somebody else's answer.
 */
function tab({ replies = {}, boot = { file: 'notes.md' } } = {}) {
  /*
   * The elements this module reads by id, which is a second spelling of the markup `editorPage`
   * builds in `src/server/page.ts`. An element renamed there and not here leaves every check
   * passing over a page where the module finds nothing, so the ids are the thing to keep in step:
   * `editor`, `sheaf-boot` and `notice`.
   */
  const markup =
    `<div id="editor"></div>` +
    `<div id="notice" hidden></div>` +
    `<script id="sheaf-boot" type="application/json">${JSON.stringify(boot)}</script>`;
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
    url: 'https://localhost/edit/notes.md',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const requests = [];
  const toEditor = [];
  window.addEventListener('message', (e) => toEditor.push(e.data));

  // jsdom has no clipboard, and the host reaches for it with `navigator.clipboard?.`, so
  // without this a copy is silently a no-op here and a check on it could never fail.
  const clipboard = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    value: {
      writeText: async (text) => {
        clipboard.push(text);
      },
    },
    configurable: true,
  });

  window.fetch = async (path, init = {}) => {
    requests.push({ path: String(path), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = replies[String(path).split('?')[0]] ?? { ok: true, json: {} };
    return {
      ok: reply.ok !== false,
      status: reply.ok === false ? 500 : 200,
      json: async () => reply.json ?? {},
      /*
       * The event stream is read as a body. A reader that ends at once is a stream that closed,
       * which the host retries rather than treats as an error, and that is the default.
       *
       * A reply carrying `frames` delivers them first, each as the bytes of one event-stream
       * frame, and then ends. Encoded with Node's `TextEncoder`, because jsdom provides neither
       * it nor `TextDecoder`: reaching for `window.TextEncoder` threw inside the reader, and
       * `listen`'s own try/catch swallowed it and retried, so the frame silently never arrived
       * and the check read as the host dropping the flag. That is what lets a check drive the push channel rather than only
       * the request/response half: the flag saying an outside write took the person's typing
       * rides on an event *name*, so nothing that reads a JSON reply can see it.
       */
      body: {
        getReader: () => {
          const frames = [...(reply.frames ?? [])];
          return {
            read: async () => {
              const next = frames.shift();
              return next === undefined
                ? { done: true }
                : { done: false, value: new TextEncoder().encode(next) };
            },
            cancel() {},
          };
        },
      },
    };
  };

  for (const key of ['document', 'window', 'fetch', 'Event', 'MessageEvent', 'CustomEvent', 'TextDecoder']) {
    if (window[key] !== undefined) globalThis[key] = window[key];
  }
  globalThis.window = window;
  globalThis.document = window.document;
  // Node defines `navigator` as a getter, so it is replaced rather than assigned. The
  // clipboard cases read it, and jsdom's has none, so one is put on for them.
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });

  /*
   * Navigation is what `openLink` does to another document, and jsdom will not do it: its
   * `window.location` cannot be redefined either. The host writes a bare `location.href`,
   * which a browser build leaves as a free name resolved from the global scope, so a stub
   * there is what it reaches. Recording the address is all a check wants anyway.
   */
  const navigated = [];
  globalThis.location = {
    hash: '',
    get href() {
      return 'https://localhost/edit/notes.md';
    },
    set href(v) {
      navigated.push(v);
    },
  };

  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve('./browserHost.bundle.cjs')];
  require('./browserHost.bundle.cjs');
  const api = window.acquireVsCodeApi();
  return {
    api,
    post: (m) => api.postMessage(m),
    requests,
    toEditor,
    navigated,
    /** Messages of one type that reached the editor. */
    got: (type) => toEditor.filter((m) => m && m.type === type),
    /** Requests to one path, whatever its query. */
    asked: (path) => requests.filter((r) => r.path.split('?')[0] === path),
    /** What the page has put on the clipboard, in order. */
    clipboard,
    /**
     * The tab's own window, for a check about chrome the page draws rather than a message it
     * sends. Most checks here read `toEditor` and `requests` and want nothing else; the notice is
     * the first thing this host puts on the screen itself, and a check on it has to look at the
     * screen.
     */
    window: dom.window,
    close: () => dom.window.close(),
  };
}

/*
 * An edit to a data file is refused out loud rather than dropped.
 *
 * This is the whole of what moved `dataFileEdit` off `known-gap`. The host cannot write a file
 * beside the document it was opened on, which is unchanged; what changed is that it says so, so the
 * editor can tell the person instead of leaving the grid quietly disagreeing with the file.
 */
check('an edit to a data file is answered with a reason, under the id it was sent with', async () => {
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'dataFileEdit', id: 'edit-1', path: 'data/tasks.csv', base: 'a\n', text: 'b\n' });
  await settle();
  const answer = t.got('dataFileEdited')[0];
  const wrote = t.asked('/api/data') ?? [];
  t.close();
  return {
    ok: !!answer && answer.id === 'edit-1' && typeof answer.error === 'string' && answer.error.includes('data/tasks.csv'),
    detail: answer
      ? `answered ${j(answer.id)} with ${j(answer.error)}; wrote ${wrote.length} file(s)`
      : 'NOTHING WAS ANSWERED, so the editor is left waiting and a dropped edit is invisible again',
  };
});

/*
 * The presentation state a tab keeps, which is what the ten entries above being `handled`
 * means. Three readings, and the third is the one that matters: a browser that refuses
 * `localStorage` has to behave as a document opened for the first time rather than fail, and
 * refusing is what a private window and blocked site data both do.
 */
check('a width set in a tab is kept and read back, and one cleared reads empty again', async () => {
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'tableWidthsRead', id: 'a' });
  await settle();
  const before = t.got('tableWidths').slice(-1)[0];
  t.post({ type: 'tableWidthsWrite', widths: { 'k|v': { 0: 120 } } });
  await settle();
  t.post({ type: 'tableWidthsRead', id: 'b' });
  await settle();
  const kept = t.got('tableWidths').slice(-1)[0];
  t.post({ type: 'tableWidthsWrite', widths: {} });
  await settle();
  t.post({ type: 'tableWidthsRead', id: 'c' });
  await settle();
  const cleared = t.got('tableWidths').slice(-1)[0];
  t.close();
  return {
    ok: j(before?.widths) === '{}' && j(kept?.widths) === '{"k|v":{"0":120}}' && j(cleared?.widths) === '{}' && kept?.id === 'b',
    detail:
      `a document with nothing kept reads ${j(before?.widths)}; after a write it reads ${j(kept?.widths)} under the id it asked with (${j(kept?.id)}); ` +
      `after a write of nothing it reads ${j(cleared?.widths)}, so the entry is forgotten rather than left empty`,
  };
});

/*
 * The case a browser puts a host in rather than the one a person does: `localStorage` throws
 * instead of returning nothing in a private window and wherever site data is blocked.
 *
 * It is the reading that decides whether these ten entries are honestly `handled`. A host that
 * fell over here would be worse than one that never answered, because the document would not
 * open at all, and the arrangement is the only thing at stake.
 */
check('a browser that refuses to keep anything still answers, as a document opened for the first time', async () => {
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  const refuse = () => {
    throw new Error('site data blocked');
  };
  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    get() {
      refuse();
    },
  });
  t.post({ type: 'tableWidthsWrite', widths: { 'k|v': { 0: 120 } } });
  await settle();
  t.post({ type: 'tableWidthsRead', id: 'd' });
  await settle();
  const answered = t.got('tableWidths').slice(-1)[0];
  t.close();
  return {
    ok: !!answered && j(answered.widths) === '{}' && answered.id === 'd',
    detail: answered
      ? `answered ${j(answered.widths)} under ${j(answered.id)}, so the write was dropped and the read was still answered`
      : 'NOTHING WAS ANSWERED, so the editor is left waiting when a browser blocks site data',
  };
});

/**
 * How many messages nobody has decided about yet, and the number it may not exceed.
 *
 * Raising this is a deliberate act with a reason written beside the entry in
 * `src/server/host.ts`. Lowering it is what deciding one looks like.
 */
const UNDECIDED_BASELINE = 0;

/**
 * How many messages this host is knowingly worse at than VS Code, and the number it may not
 * exceed.
 *
 * `undecided` has had a ratchet since it existed and `known-gap` had none, which is the
 * wrong way round: an undecided entry is a question somebody will meet again, and a gap is
 * a thing a person meets now. Two appeared within an hour of the value being invented and
 * one of the two was wrong, so the count moving needs to be somebody's decision rather
 * than a side effect.
 */
const KNOWN_GAP_BASELINE = 0;

/*
 * Back to 0 on 2026-10-02. It was 1 for an hour, for `dataFileEdit`, with the reason
 * beside that entry in `src/server/host.ts`: it carries no id and has no answer in the protocol,
 * so a host that drops the write is indistinguishable from one that made it. That is a gap a
 * person meets and the right value for it is the one that counts.
 *
 * It was 2 for an hour, because `dataFileCreate` was marked the same way on the assumption that
 * neither write was acknowledged. That one does carry an id and is answered, and the editor holds
 * a promise against it with a timeout, so it explains itself. Only the edit is silent.
 *
 * **And the ratchet now covers both records.** It read only the record of what this host *sends*,
 * so a `known-gap` among the messages it *answers* was unratcheted, which is the hole this
 * comment's own argument is about, one record along. Both are counted below.
 */

check('no message is left undecided without somebody raising the count on purpose', async () => {
  /*
   * What replaced the check that used to live here. That one read the switch with a
   * regex and compared it against a list typed into the check itself, so it could only
   * ever catch a message somebody had remembered to list. `setLineNumbers` had no case
   * at all and it passed throughout, so the line-numbers button in a tab turned them on
   * and then did nothing for ever.
   *
   * The shape question is now the type checker's: `BROWSER_HOST` is a `Record` over the
   * protocol's own message names, so a message added with no decision fails
   * `npm run check-types` naming it. Verified by adding one, which reports
   * "Property 'x' is missing in type" and needs no test edited.
   *
   * What is left for a check is the count of the ones marked undecided, which is a
   * declaration rather than a switch. Reading a declaration is something a text search
   * can do reliably; reading a switch for whether a case does anything is not, which is
   * why the handled ones are proved by behaviour below instead.
   */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/server/host.ts', import.meta.url), 'utf8');
  // `\b` because `indexOf('export const BROWSER_HOST')` also finds `BROWSER_HOSTS` or
  // `BROWSER_HOST_OLD`, and then this reads a record that is not the one it names while
  // staying green. Demonstrated on the sibling check below, where a rename control passed
  // until the boundary was added.
  const at = /export const BROWSER_HOST\b/.exec(src);
  if (!at) return { ok: false, detail: 'no BROWSER_HOST found, so this check is reading the wrong thing' };
  const record = src.slice(at.index, src.indexOf('};', at.index));
  const undecided = [...record.matchAll(/(\w+): 'undecided'/g)].map(([, name]) => name);
  return {
    ok: undecided.length <= UNDECIDED_BASELINE,
    detail: `${undecided.length} undecided against a baseline of ${UNDECIDED_BASELINE}: ${undecided.join(', ')}`,
  };
});

check('linking to another document is answered with the folder’s files, rather than waited for', async () => {
  /*
   * The editor waits 1.5 seconds for this and then offers only the current document's
   * headings. Nothing answered it here, so linking in a tab cost a pause and then offered
   * nothing, while the walk that knows every file ran in the same process for the index
   * page. The record called it undecided, which was honest and was also where it hid.
   *
   * The reply's `id` is the half worth asserting: the editor matches answers to requests
   * by it, so a reply with the wrong one is a reply that never arrives.
   */
  const t = tab({ replies: { '/api/doc': { json: DOC }, '/api/files': { json: { files: ['notes.md', 'guide/start.md'] } } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'workspaceFilesRead', id: 'files-1' });
  await settle();
  await settle();
  const answer = t.got('workspaceFiles')[0];
  t.close();
  return {
    ok: answer?.id === 'files-1' && Array.isArray(answer.files) && answer.files.includes('guide/start.md'),
    detail: `workspaceFiles ${j(answer)}`,
  };
});

check('a write that took the tab\u2019s typing reaches the editor marked as having taken it', async () => {
  /*
   * The third hop of a flag that has three: the watcher computes it, the stream names the frame
   * with it, and this module hands it to the editor. Each hop was broken on purpose and the
   * server suite names the first two; only this one can see the last, because it is the only
   * place the page's own script runs.
   *
   * What it buys is that the editor annotates the change as the person's own, so one press of
   * their own Undo brings their text back. Before it, an outside write that landed on unsaved
   * typing reached the editor as somebody else's ordinary edit: nothing said, nothing to undo.
   *
   * Both names are driven, and the pair is the check. A shim that passed `true` always would
   * satisfy the first half and tell the person their work had gone every time anything touched
   * the file.
   */
  const frame = (event, text) => `event: ${event}\n${text.split('\n').map((l) => `data: ${l}`).join('\n')}\n\n`;
  const drive = async (event) => {
    const t = tab({
      replies: {
        '/api/doc': { json: DOC },
        '/api/events': { frames: [frame(event, 'Replaced from disk.\n')] },
      },
    });
    t.post({ type: 'ready' });
    for (let i = 0; i < 8; i++) await settle();
    const pushed = t.got('setContent').at(-1);
    t.close();
    return pushed;
  };
  const took = await drive('contentTookTypedText');
  const ordinary = await drive('setContent');
  return {
    ok:
      took?.text === 'Replaced from disk.\n' &&
      took.tookTypedText === true &&
      ordinary?.text === 'Replaced from disk.\n' &&
      ordinary.tookTypedText === false,
    detail: `took ${j(took)}; ordinary ${j(ordinary)}`,
  };
});

check('every element this host looks up by id is one the page actually builds', async () => {
  /*
   * Two declarations of one fact with nothing comparing them, which is the shape of every defect
   * this host's boundary has produced. `host.ts` reaches for elements by id and `page.ts` writes
   * the markup that has them, in different files and different runtimes.
   *
   * What it would cost is silence. `getElementById` returns null for a name nobody builds, every
   * function here guards on that and returns, and the page loses a feature with nothing failing:
   * no error, no empty element, just a notice that never appears or an editor that never mounts.
   * That is the same failure as the line-numbers button that only ever turned them on.
   *
   * The fixture in this file is a third spelling of the same ids, so it is compared too. A check
   * that only compared the module against the page would pass while every check here ran against
   * a DOM the real page does not have.
   */
  const { readFileSync } = await import('node:fs');
  const at = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const wanted = [...new Set([...at('../src/server/host.ts').matchAll(/getElementById\('([^']+)'\)/g)].map(([, id]) => id))].sort();
  const built = new Set([...at('../src/server/page.ts').matchAll(/id="([^"]+)"/g)].map(([, id]) => id));
  const inFixture = new Set([...at('./browserHost.test.mjs').matchAll(/id="([^"]+)"/g)].map(([, id]) => id));
  const missingFromPage = wanted.filter((id) => !built.has(id));
  const missingFromFixture = wanted.filter((id) => !inFixture.has(id));
  return {
    ok: wanted.length >= 3 && missingFromPage.length === 0 && missingFromFixture.length === 0,
    detail:
      `looks up ${j(wanted)}` +
      (missingFromPage.length ? `; the page builds no ${j(missingFromPage)}` : '') +
      (missingFromFixture.length ? `; this suite's fixture has no ${j(missingFromFixture)}` : ''),
  };
});

check('the page draws the notice about a write that took the tab’s typing, and its Undo is the editor’s', async () => {
  /*
   * A browser tab has no notification surface, so the page draws one. This is the only suite that
   * can see it: the server suite stops at the stream, and the webview suites replace this module
   * with a stand-in.
   *
   * Three things, and the third is the one that matters. The bar appears with the server's words
   * in it; it is hidden until there is something to say, so a page that showed an empty bar on
   * every load would fail; and its Undo posts `undoOutsideChange` to the editor rather than
   * writing anything itself. That last is what makes the offer safe: the editor has already made
   * the arriving document one undo step, so the button is a shortcut to a key the person already
   * has rather than a second mechanism that could disagree with it.
   */
  const message = 'Sheaf: this file changed outside the editor, and your last change is gone: "a phrase". Undo brings it back.';
  const frame = `event: notice\ndata: ${message}\n\n`;
  const t = tab({ replies: { '/api/doc': { json: DOC }, '/api/events': { frames: [frame] } } });
  const bar = () => t.window.document.getElementById('notice');
  const hiddenAtFirst = bar()?.hidden === true;
  t.post({ type: 'ready' });
  for (let i = 0; i < 8; i++) await settle();
  const shown = bar()?.hidden === false;
  const said = bar()?.textContent?.includes('a phrase') === true;
  const button = [...(bar()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Undo');
  button?.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  await settle();
  const posted = t.got('undoOutsideChange').length;
  const hiddenAfter = bar()?.hidden === true;
  t.close();
  return {
    ok: hiddenAtFirst && shown && said && posted === 1 && hiddenAfter,
    detail: `hidden first ${hiddenAtFirst}, shown ${shown}, said it ${said}, posted ${posted}, hidden after ${hiddenAfter}`,
  };
});

check('a folder the server cannot list is answered with nothing, rather than left to time out', async () => {
  // The editor's only other outcome is a 1.5 second wait, so an empty answer is better
  // than silence even when the walk fails: it falls back to this document's headings at
  // once instead of pausing first.
  const t = tab({ replies: { '/api/doc': { json: DOC }, '/api/files': { ok: false } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'workspaceFilesRead', id: 'files-2' });
  await settle();
  await settle();
  const answer = t.got('workspaceFiles')[0];
  t.close();
  return { ok: answer?.id === 'files-2' && Array.isArray(answer.files) && answer.files.length === 0, detail: `workspaceFiles ${j(answer)}` };
});

check('a pasted path relative to the document is answered with that document’s own title', async () => {
  /*
   * Pasting a path writes a link carrying the target's title, and only a host can say what
   * that is. Out here the answer comes from the same `/api/doc` the tab opened this document
   * with, so what this check proves is the three-part wiring: the request asks for the
   * resolved target, the address comes back as the path that was pasted, and the title is
   * read out of the text the server returned rather than invented from the file name.
   */
  const t = tab({ replies: { '/api/doc': { json: DOC } }, boot: { file: 'guide/notes.md' } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'docTitleRead', id: 'title-1', path: '../plan.md' });
  await settle();
  await settle();
  const answer = t.got('docTitle')[0];
  // The document's folder is `guide/`, so `../plan.md` is `plan.md` from the folder root.
  const asked = t.requests.some((r) => r.path === `/api/doc?path=${encodeURIComponent('plan.md')}`);
  t.close();
  return {
    ok: answer?.id === 'title-1' && answer.address === '../plan.md' && answer.title === 'Notes' && asked,
    detail: `docTitle ${j(answer)}; asked the server for the target ${asked}; requests ${j(t.requests.map((r) => r.path))}`,
  };
});

check('a pasted path this host cannot reach, and one the server will not serve, are answered with nothing', async () => {
  /*
   * Narrower than VS Code, which has a workspace to resolve an absolute path against. A tab
   * can see only the folder the server was started on, so a path from a file manager names
   * nothing it can reach. Answered rather than ignored: the editor pastes the path as text
   * the moment it hears nothing, instead of waiting out its timeout first.
   */
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  const cases = ['/Users/someone/plan.md', 'file:///Users/someone/plan.md', 'plan.txt', 'https://example.com/plan.md'];
  for (const [i, path] of cases.entries()) t.post({ type: 'docTitleRead', id: `unreachable-${i}`, path });
  await settle();
  await settle();
  const unreachable = t.got('docTitle').filter((m) => m.id.startsWith('unreachable-'));
  const askedForNone = t.requests.filter((r) => r.path.includes('plan')).length === 0;

  // And a target the server refuses is the same answer, with the request made.
  const refused = tab({ replies: { '/api/doc': { ok: false } }, boot: { file: 'notes.md' } });
  refused.post({ type: 'docTitleRead', id: 'refused-1', path: 'gone.md' });
  await settle();
  await settle();
  const gone = refused.got('docTitle')[0];
  refused.close();
  t.close();
  return {
    ok:
      unreachable.length === 4 &&
      unreachable.every((m) => m.address === undefined && m.title === undefined) &&
      askedForNone &&
      gone?.id === 'refused-1' &&
      gone.address === undefined,
    detail: `unreachable answers ${j(unreachable)}; nothing was fetched for them ${askedForNone}; a refused target gave ${j(gone)}`,
  };
});

check('what this host sends the editor and what it says it sends are the same set', async () => {
  /*
   * The other record's check reads a declaration. This one reads a declaration against
   * the code beside it, which is the comparison that was missing entirely: nothing looked
   * at the messages this host *starts*, only at the ones it answers, and `BROWSER_HOST`
   * is keyed on the editor's message names so it could not have.
   *
   * Both directions of the agreement matter and they catch different mistakes. A name
   * marked handled with no send behind it is a claim, which is how a control that does
   * nothing survives a green suite. A send with no entry is a host quietly growing a
   * behaviour the other host may not have, which is the drift the one-bundle rule exists
   * to prevent.
   *
   * Reading the sends with a search is reliable here for the reason the sibling check
   * gives: `toEditor` takes a literal object with a literal `type` at every one of its
   * call sites, and it is typed as `ToWebview`, so a name that is not on the wire does
   * not compile. What a search cannot tell is whether a send runs, and that is what the
   * behaviour checks below are for.
   */
  const { readFileSync } = await import('node:fs');
  const at = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const src = at('../src/server/host.ts');
  /*
   * The declaration's name has to end where the name ends. `indexOf('export const ANSWERS')`
   * also matches `export const ANSWERS_RENAMED`, so the control for "the parse found
   * nothing" passed while the parse was reading a record that was no longer the one it
   * names. The control is the only reason that was ever seen: the check was green before
   * and after the rename.
   */
  const entriesOf = (text, name) => {
    const at = new RegExp(`export const ${name}\\b`).exec(text);
    if (!at) return undefined;
    const from = at.index;
    const record = text.slice(from, text.indexOf('};', from));
    return new Map([...record.matchAll(/(\w+): '([\w-]+)'/g)].map(([, key, value]) => [key, value]));
  };
  const sends = entriesOf(src, 'BROWSER_SENDS');
  const reads = entriesOf(src, 'BROWSER_HOST');
  const answers = entriesOf(at('../src/protocol.ts'), 'ANSWERS');
  // A parse that found nothing would agree with anything, so each one has to say so.
  for (const [what, parsed] of [
    ['BROWSER_SENDS', sends],
    ['BROWSER_HOST', reads],
    ['ANSWERS', answers],
  ]) {
    if (!parsed?.size) return { ok: false, detail: `no ${what} found, so this check is reading the wrong thing` };
  }

  /*
   * What this host should be sending, derived rather than listed. `handled` says so
   * directly. `answers` defers to the entry for the message it answers, which is why
   * `ANSWERS` exists: `workspaceFiles` went from unsent to sent because its request moved
   * to `handled`, and a record restating that by hand would have kept saying unsent.
   */
  const expected = [];
  const unpaired = [];
  for (const [name, decision] of sends) {
    if (decision === 'handled') expected.push(name);
    else if (decision === 'answers') {
      const request = answers.get(name);
      if (!request) unpaired.push(name);
      // A refused request is answered too: the answer carries the reason. The derivation counted
      // only `handled`, so a host that refused out loud read as sending something it did not owe.
      else if (reads.get(request) === 'handled' || reads.get(request) === 'refused') expected.push(name);
    }
  }
  const body = src.slice(src.indexOf('};', src.indexOf('export const BROWSER_SENDS')));
  const sent = [...new Set([...body.matchAll(/toEditor\(\{\s*type: '(\w+)'/g)].map(([, name]) => name))].sort();
  const missing = expected.filter((name) => !sent.includes(name)).sort();
  const extra = sent.filter((name) => !expected.includes(name)).sort();
  // Both records, because a gap among the messages this host answers is as much a gap as one
  // among the messages it sends, and only the second was counted.
  const gaps = [...reads, ...sends].filter(([, d]) => d === 'known-gap').map(([name]) => name);
  return {
    ok: missing.length === 0 && extra.length === 0 && unpaired.length === 0 && gaps.length <= KNOWN_GAP_BASELINE,
    detail:
      `sends ${j(sent)}; owes ${j(expected.sort())}` +
      `; known gaps ${j(gaps)} against a baseline of ${KNOWN_GAP_BASELINE}` +
      (unpaired.length ? `; marked answers with nothing in ANSWERS to answer ${j(unpaired)}` : '') +
      (missing.length ? `; owed and never sent ${j(missing)}` : '') +
      (extra.length ? `; sent and not owed ${j(extra)}` : ''),
  };
});

check('the toolbar turning the outline on sends one of the three names, not the boolean it pressed', async () => {
  /*
   * The sibling check above sends `'collapsed'` and only ever sent a string, so the
   * boolean half of `setTableOfContents` had never been driven in a tab. It stored the
   * `true` as given, into the field the editor reads as one of `shown`, `collapsed` or
   * `hidden`, and sent it back that way. The extension host reconciles the two; this host
   * did not, and nothing could see it, because the value was held as `unknown` from the
   * message to the editor.
   *
   * Both ends of the boolean are driven, because `false` is the half that reads as
   * plausible: a falsy value in a field whose absent case is `hidden` behaves correctly
   * by accident, so a check that only pressed `true` would pass over half the fix.
   */
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'setTableOfContents', on: true });
  await settle();
  t.post({ type: 'setTableOfContents', on: false });
  await settle();
  const seen = t.got('configChanged').map((m) => m.config.tableOfContents);
  t.close();
  return {
    ok: seen.length === 2 && seen[0] === 'shown' && seen[1] === 'hidden',
    detail: `tableOfContents reached the editor as ${j(seen)}`,
  };
});

check('copying reaches the clipboard, which was the one handled message nothing watched', async () => {
  /*
   * Every other message `BROWSER_HOST` calls handled already had a check behind it; this
   * one did not, so "handled" was a claim for one entry out of nine. A regex reading the
   * switch would have counted its case and told us nothing about whether it does
   * anything, which is the case most worth catching.
   */
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'clipboardWrite', text: 'picked up from the document' });
  await settle();
  const written = t.clipboard;
  t.close();
  return { ok: written.length === 1 && written[0] === 'picked up from the document', detail: `clipboard ${j(written)}` };
});

check('ready opens the document and hands the editor an init with the text the server gave', async () => {
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  const init = t.got('init')[0];
  const asked = t.asked('/api/doc')[0];
  t.close();
  return {
    ok: !!init && init.text === DOC.text && init.fileName === 'notes.md' && init.resourceBaseUri === '/file/' && !!asked && asked.path.includes('notes.md'),
    detail: `asked ${j(asked && asked.path)}; init ${j(init && { text: init.text, fileName: init.fileName, base: init.resourceBaseUri })}`,
  };
});

check('an edit is written to the server, and a second while one is in flight replaces it rather than queueing', async () => {
  // The rule the file's own header states: the editor posts its whole text on every
  // keystroke, so an older copy of it is worth nothing and a request per keystroke would
  // arrive out of order. Three edits in a row must not be three writes of stale text.
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'edit', text: 'one' });
  t.post({ type: 'edit', text: 'two' });
  t.post({ type: 'edit', text: 'three' });
  for (let i = 0; i < 8; i++) await settle();
  const writes = t.requests.filter((r) => r.method === 'POST' && r.path === '/api/doc').map((r) => r.body.text);
  t.close();
  // The last text always reaches the server; the ones overtaken in the queue do not.
  return { ok: writes[writes.length - 1] === 'three' && writes.length < 3 && !writes.includes('two'), detail: `wrote ${j(writes)}` };
});

check('the text the server already holds is not written again', async () => {
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'edit', text: DOC.text });
  for (let i = 0; i < 6; i++) await settle();
  const writes = t.requests.filter((r) => r.method === 'POST' && r.path === '/api/doc');
  t.close();
  return { ok: writes.length === 0, detail: `wrote ${writes.length} time(s)` };
});

check('Open raw Markdown shows the whole document as source, since a tab has no second editor to open', async () => {
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'openAsText' });
  await settle();
  const said = t.got('toggleSourceMode');
  t.close();
  return { ok: said.length === 1, detail: `${said.length} toggleSourceMode` };
});

check('the table of contents and front matter settings reach the editor as the three-valued strings they are', async () => {
  /*
   * The bug that started this. A tab has no settings file to write, so the change is kept
   * in the tab and echoed back as `configChanged`, and what matters is that the value
   * arrives as given. `setTableOfContents` carried a cast calling it a boolean long after
   * it became one of three strings, and nothing failed because the value was passed
   * straight through. The next cast might not be so lucky.
   */
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'setTableOfContents', on: 'collapsed' });
  await settle();
  t.post({ type: 'setFrontMatter', state: 'hidden' });
  await settle();
  const seen = t.got('configChanged').map((m) => m.config);
  t.close();
  const last = seen[seen.length - 1] ?? {};
  return {
    ok: seen.length === 2 && seen[0].tableOfContents === 'collapsed' && last.frontMatter === 'hidden' && last.tableOfContents === 'collapsed',
    detail: `configChanged ${j(seen)}`,
  };
});

check('line numbers turn off again, because the value the button reads from is the one the host moves', async () => {
  /*
   * The toolbar's line-numbers button computes the next value from `config.lineNumbers`
   * and leaves the answer to the host. With no case here the value never moved, so every
   * press computed `!false` and turned them on again: a drawn button that did nothing
   * after the first press, and no way back short of reloading the tab.
   *
   * So what this asks is that the value comes back changed, both ways. Checking only the
   * first press would have passed throughout the defect.
   */
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'setLineNumbers', on: true });
  await settle();
  t.post({ type: 'setLineNumbers', on: false });
  await settle();
  const seen = t.got('configChanged').map((m) => m.config);
  t.close();
  return {
    ok: seen.length === 2 && seen[0].lineNumbers === true && seen[1].lineNumbers === false,
    detail: `configChanged ${j(seen)}`,
  };
});

check('a setting changed in the tab is kept, so the next document opens the way the last one was left', async () => {
  // "Everywhere" in a tab means every document opened in it, since there is no settings
  // file to write. That only holds if the config the host echoes carries what init gave
  // it as well as what has been changed since.
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'setFrontMatter', state: 'shown' });
  await settle();
  const config = t.got('configChanged')[0].config;
  t.close();
  return {
    ok: config.frontMatter === 'shown' && config.tableOfContents === 'hidden',
    detail: `config ${j(config)}, which must still carry what init gave it`,
  };
});

check('saving an image asks the server and hands the answer back under the id the editor asked with', async () => {
  const t = tab({ replies: { '/api/doc': { json: DOC }, '/api/image': { json: { path: 'assets/shot.png' } } } });
  t.post({ type: 'saveImage', id: 'img-7', name: 'shot.png', data: 'data:image/png;base64,AAAA' });
  for (let i = 0; i < 4; i++) await settle();
  const saved = t.got('imageSaved')[0];
  const asked = t.asked('/api/image')[0];
  t.close();
  return {
    ok: !!saved && saved.id === 'img-7' && saved.path === 'assets/shot.png' && !!asked && asked.body.name === 'shot.png',
    detail: `asked ${j(asked && asked.body && asked.body.name)}; answered ${j(saved)}`,
  };
});

check('an image the server refuses is reported rather than left waiting', async () => {
  // The id has to come back either way: the editor is holding a placeholder against it.
  const t = tab({ replies: { '/api/doc': { json: DOC }, '/api/image': { json: { error: 'that folder is read only' } } } });
  t.post({ type: 'saveImage', id: 'img-8', name: 'shot.png', data: 'data:image/png;base64,AAAA' });
  for (let i = 0; i < 4; i++) await settle();
  const saved = t.got('imageSaved')[0];
  t.close();
  return { ok: !!saved && saved.id === 'img-8' && saved.error === 'that folder is read only' && !saved.path, detail: j(saved) };
});

check('a link to another document navigates to it rather than opening a file the tab cannot show', async () => {
  const t = tab({ replies: { '/api/doc': { json: DOC } } });
  t.post({ type: 'openLink', address: 'other.md' });
  await settle();
  const went = t.navigated;
  t.close();
  return { ok: went.length === 1 && went[0].includes('other.md'), detail: j(went) };
});

check('every request carries the header the local server checks, so a page on another origin cannot drive it', async () => {
  // The header is what separates this tab from any other page the browser has open. A
  // request that forgot it would be refused by the server, which is the right outcome and
  // a confusing one to debug, so it is pinned here.
  const t = tab({ replies: { '/api/doc': { json: DOC }, '/api/image': { json: {} } } });
  t.post({ type: 'ready' });
  await settle();
  await settle();
  t.post({ type: 'edit', text: 'changed' });
  t.post({ type: 'saveImage', id: 'i', name: 'a.png', data: 'x' });
  for (let i = 0; i < 6; i++) await settle();
  const without = t.requests.filter((r) => !(r.headers && r.headers['x-sheaf-local']));
  t.close();
  return { ok: t.requests.length > 0 && without.length === 0, detail: `${t.requests.length} request(s), ${without.length} missing the header` };
});

let pass = 0;
for (const c of cases) {
  let ok = false;
  let detail = '';
  try {
    const result = await c.run();
    if (result && typeof result === 'object') {
      ok = result.ok === true;
      if (result.detail) detail = ` ${result.detail}`;
    } else {
      ok = result === true;
    }
  } catch (e) {
    detail = ` threw: ${e && e.message ? e.message : String(e)}`;
  }
  if (ok) pass++;
  console.log(`${ok ? '✅' : '❌'} ${c.name}${ok ? '' : detail}`);
}
console.log(`\n${pass}/${cases.length} browser-host checks passed`);
process.exit(pass === cases.length ? 0 : 1);
