/**
 * The browser stand-in for the VS Code webview host.
 *
 * `media/webview.js` is built for a browser and reaches VS Code through exactly
 * two things: the `acquireVsCodeApi()` global it calls at module scope, and
 * `window.postMessage`. Defining that global before the bundle loads is the
 * whole port, which is why this file is small and the editor is unmodified.
 *
 * The site demo does the same job against a fixed set of files held in memory.
 * This one has a folder on disk behind it, so the messages that were no-ops
 * there are HTTP requests here: text is read and written through the server, an
 * image is saved into the project, and a link to another document navigates.
 *
 * Two details are worth knowing before changing anything here.
 *
 * Edits are coalesced rather than queued. The editor posts its whole text on
 * every keystroke, and a request per keystroke would arrive out of order under
 * any latency at all. One request is in flight at a time and the newest text
 * replaces whatever is waiting, which is the same rule `DocumentSync` follows on
 * the other side: the whole text is posted every time, so nothing is lost by
 * dropping an older copy of it.
 *
 * The event stream is how an outside change arrives. The server pushes the
 * document when something else writes the file, and the editor takes it as
 * `setContent`, the same message VS Code sends when the file changes on disk.
 */

import type { EditorConfig, FromWebview, FromWebviewType, ToWebview, ToWebviewType } from '../protocol';
import { readOutline } from '../settingValues';
import { documentTitle } from '../docLink';
import { NOTICE, SET_CONTENT, SET_CONTENT_TOOK_TYPED } from './events';

interface BootData {
  file: string;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

/**
 * What this host does about each message the editor can post.
 *
 * Exhaustive over the protocol by construction: a message added to `FromWebview` with no
 * entry here is a type error. That is the whole point of it. What stood in for this before
 * was a check comparing the switch below against a list typed by hand, so it could only
 * catch a message somebody had remembered to add to the list, and it did not catch
 * `setLineNumbers` having no case at all: the line-numbers button turned them on and then
 * did nothing for ever.
 *
 * `undecided` is not a polite no. It is reported by the browser-host check and held to a
 * count, because a message nobody has looked at is the exact shape of the defect this
 * replaced, which is a control the editor draws that quietly does nothing. The entries
 * that say it belong to features other people own, and a reason invented here would be
 * worth less than leaving the question where it can be seen.
 */
type Decision =
  /** This host reads it, or sends it, and a check proves that does something observable. */
  | 'handled'
  /** Deliberately unanswered: the editor tells the reader what it cannot do here. */
  | 'editor-explains'
  /** A VS Code concept with nothing to degrade out here. */
  | 'nothing-to-do'
  /**
   * Sent only in answer to a message the editor sends, so what governs it is that
   * message's own entry above rather than a second decision here. Restating one would
   * put the same fact in two places with nothing comparing them, which is the shape
   * this whole file exists to stop.
   */
  | 'answers'
  /**
   * Looked at, and this host is worse here than VS Code is. What closes it is work
   * rather than a decision, and the entry says what the work is. Distinct from
   * `undecided`, which is nobody having looked: a gap counted as undecided reads as a
   * question still open, and gets asked again instead of being done.
   */
  | 'known-gap'
  /**
   * The editor never sends it to this host, because a capability it declared in `init` removed
   * the only control that would.
   *
   * Distinct from `nothing-to-do`, which is a message that arrives and needs no work, and from
   * `known-gap`, which is a thing a person meets. Here the person meets nothing at all: the
   * item is not in the menu, which is `CLAUDE.md`'s rule that a host without something says so
   * and the editor leaves it out rather than offering a control that does nothing.
   *
   * It is worth its own value because the three read alike in a record and want different work.
   * A `nothing-to-do` entry is finished. A `known-gap` is a ticket. This one is finished too,
   * and it stops being true the moment somebody gives this host the capability, so it names what
   * would have to change.
   */
  | 'capability-off'
  /**
   * Answered, and the answer is a reason it cannot be done.
   *
   * Distinct from `editor-explains`, where the host says nothing and the editor invents the
   * sentence from a timeout, and from `known-gap`, where nobody says anything at all. Here the host
   * is the one that knows why, so it is the one that says it, and the person gets a sentence about
   * their own host rather than a sentence about silence.
   *
   * A refused request still owes its paired answer, which is why the derivation that checks what
   * this host sends counts it alongside `handled`.
   */
  | 'refused'
  /** Nobody has looked yet. */
  | 'undecided';

export const BROWSER_HOST: Record<FromWebviewType, Decision> = {
  ready: 'handled',
  edit: 'handled',
  openAsText: 'handled',
  clipboardWrite: 'handled',
  openLink: 'handled',
  saveImage: 'handled',
  setLineNumbers: 'handled',
  setTableOfContents: 'handled',
  setFrontMatter: 'handled',

  // The editor already expects no answer to this one and says so to the reader:
  // `requestFile` in `src/webview/viewBlock.ts` marks the file waiting, sets a timer, and
  // on no reply draws an error naming the path and telling them to name a CSV block in
  // the document instead. Answering it would need the server to read arbitrary files
  // beside the document, which is a larger question than this record.
  dataFileRead: 'editor-explains',

  // Nothing to flush. `postEdit` sends at once and `drain` loops until nothing is
  // pending, with no debounce and no timer, so unlike the extension host there is no
  // save in flight when focus leaves.
  blur: 'nothing-to-do',

  workspaceFilesRead: 'handled',

  /*
   * Answered, and narrower out here than in VS Code, which is the honest limit rather than
   * a gap. VS Code resolves a pasted path against a workspace, so an absolute path or a
   * `file:` URL from a file manager has a folder to be made relative to. A tab can see only
   * the folder the server was started on, so those name nothing this host can reach and it
   * answers with nothing, which the editor already handles by pasting the path as text.
   * A path relative to the document, which is what copying from the file tree gives, works.
   */
  docTitleRead: 'handled',

  /*
   * The presentation state, all of it answered from `localStorage`.
   *
   * These were ten `undecided` entries, which is the honest value for a question nobody had
   * asked rather than a gap. Asking it: VS Code keeps all of this in `context.workspaceState`,
   * its own key-value store, so none of it is in the document and losing it loses only the
   * arrangement. That is what `localStorage` is, and the equivalence is the reason rather than
   * a convenience, which is why these are `handled` and not a narrower value.
   *
   * What is narrower out here is the scope, and it is the honest limit of the analogue:
   * `workspaceState` follows a person to another window on the same machine, and
   * `localStorage` is per origin and per browser, so the same folder served on another port
   * keeps its own arrangement. Nothing in the editor depends on the scope.
   */
  tableWidthsRead: 'handled',
  tableWidthsWrite: 'handled',
  tableBoardsRead: 'handled',
  tableBoardsWrite: 'handled',
  commentFoldsRead: 'handled',
  commentFoldsWrite: 'handled',
  frontMatterStateRead: 'handled',
  frontMatterStateWrite: 'handled',
  outlineStateRead: 'handled',
  outlineStateWrite: 'handled',
  /*
   * Editing a data file: the same question `dataFileRead` above answers, plus a write. Refused,
   * and the refusal is the whole of the change: this was `known-gap` while the message carried no
   * id and had no answer, so a host that dropped the write was indistinguishable from one that
   * made it and a person saw their edit on screen and nothing on disk. It is answered now, so the
   * editor says so, in this host's own words rather than out of a timeout.
   *
   * Still not written. What a tab is allowed to write beside the document it was opened on is the
   * larger question the read defers, and nothing here answers it. The difference is that a person
   * is told rather than left to find out.
   */
  dataFileEdit: 'refused',

  /*
   * And creating one **does** explain itself, which is the correction to the entry above: it was
   * `known-gap` beside the edit for an hour, on the assumption that neither write was
   * acknowledged, and the two are not alike.
   *
   * `dataFileCreate` carries an id and is answered with `dataFileCreated`, and `createFile` in
   * `src/webview/viewBlock.ts` holds a promise against it with a timeout, so a host that never
   * answers resolves with "Nothing came back from the host about <path> in time. Check whether the
   * file was written before trying again." The editor even carries a message for a host that
   * cannot post at all. The person is told; what they are told is a timeout rather than a refusal,
   * which is a worse sentence than it could be and not a silent loss.
   */
  dataFileCreate: 'editor-explains',

  /*
   * The editor reports its selection after every change, unprompted. Out here nothing consumes
   * it: the extension host keeps it to serve Copy ref and Send to terminal, which it runs
   * itself, and this host runs no commands of the editor's. The `getSelection` entry in the
   * record below is `nothing-to-do` for the same reason, from the other direction.
   */
  selection: 'nothing-to-do',

  /*
   * Never sent here. The only message of this type the editor posts is Send to terminal, and
   * `main.ts` removes that menu item outright when a host declares `capabilities.terminal` false,
   * which this host always does. So there is no control to press and no message to answer.
   */
  runCommand: 'capability-off',
};

/**
 * What this host sends the editor, message by message.
 *
 * The record above covers what a host must answer. It is keyed on `FromWebviewType`, so
 * by construction it says nothing about the messages a host *starts*, and that is where
 * a gap sat unseen: of the three messages no editor message asks for, one of them, the
 * offer to take back text a write had dropped, existed in VS Code and nowhere else, with
 * no entry anywhere saying so. The two records together are the whole boundary.
 *
 * Exhaustive over `ToWebview` for the same reason the other one is exhaustive over
 * `FromWebview`: a message added to the wire with no decision about this host is a
 * compile error, not a feature that silently exists in one host.
 */
export const BROWSER_SENDS: Record<ToWebviewType, Decision> = {
  init: 'handled',
  setContent: 'handled',
  configChanged: 'handled',
  toggleSourceMode: 'handled',

  // The editor reveals a same-document fragment itself and asks no host to do it:
  // `linkOpenPlan` in `src/webview/linkTarget.ts` classifies `#section` as a fragment and
  // calls its own reveal, and only a link naming another document is posted out as
  // `openLink`. So this message is for a fragment arriving from outside the editor, and
  // out here that is the address bar, which `start` reads into `init`. VS Code needs the
  // separate message because an editor already showing the document is brought forward
  // without resolving again and sends no further `init`; a tab has no such state to be in.
  //
  // Two wrong readings of this entry are worth the space, because both were confident. The
  // first gave the right value for a reason that only covers a link to another document.
  // The second called it a gap, from tracing `openLink`'s URL resolution and finding that
  // `#section` resolves to the document's own folder: true of that function, and that
  // function is never reached with a fragment, because the editor has already handled it.
  // Measured afterwards in a real tab at three depths: the heading is revealed, the tab
  // does not move. A trace through a function that the input cannot reach reads exactly
  // like a trace through one it can.
  revealFragment: 'nothing-to-do',

  // A host asks for the selection to serve a command it is running itself: Copy ref and
  // Send to terminal are both handled in the extension host. This host runs no commands
  // of the editor's, which is the `runCommand` entry above, so there is nothing to ask
  // for. Answering `runCommand` here is what would make this worth sending.
  getSelection: 'nothing-to-do',

  /*
   * Closed, and it took the two pieces the entry here used to name as the work.
   *
   * VS Code notices that a write landing from disk took text the person had just typed, says so,
   * and offers it back. This host did none of it: `OpenDocument.reload` passed `false` to
   * `documentChanged`, so the flag that marks such a change was never set, and every outside
   * write reached the editor as somebody else's ordinary edit.
   *
   * The first piece was a `RecentTyping` in `OpenDocument`, which needed no part of VS Code —
   * `recentTyping.ts` imports nothing but `textSync.ts`, so what was missing was the call rather
   * than the means. That alone made the change one the person's own Undo takes back, which is the
   * half that recovers the text.
   *
   * The second was somewhere to put the offer, since a browser tab has no notification surface.
   * **The page draws it, not the editor.** A notification surface is a fact about what is around
   * the editor rather than part of it, which is what this directory is for and why the file tree
   * lives here; drawing it in the bundle would mean the editor knowing that one host needs a
   * notice, and the bundle is the same bytes in every host. The words are built on the server
   * from the same two functions the extension host uses, so the two cannot come to describe one
   * event differently.
   *
   * `showNotice` below is that surface, and its Undo posts this message.
   */
  undoOutsideChange: 'handled',

  // Every one of these is `ANSWERS`-paired, so the entry above for the message it answers
  // is the decision, and whether this host sends it follows from that rather than being
  // stated again here. `workspaceFiles` is the case that proves it is worth deriving: its
  // request moved from `undecided` to `handled` under a rebase, this host started sending
  // it, and a hand-kept second record would have gone on saying it did not.
  imageSaved: 'answers',
  workspaceFiles: 'answers',
  docTitle: 'answers',
  tableWidths: 'answers',
  tableBoards: 'answers',
  commentFolds: 'answers',
  frontMatterState: 'answers',
  outlineState: 'answers',
  dataFile: 'answers',
  dataFileCreated: 'answers',
  dataFileEdited: 'answers',
};

const bootEl = document.getElementById('sheaf-boot');
const boot: BootData = bootEl?.textContent ? (JSON.parse(bootEl.textContent) as BootData) : { file: '' };
const file = boot.file;

/** The text the server is known to hold, so an echo is not posted back to it. */
let sent: string | undefined;
/** The newest text the editor posted and the server has not taken yet. */
let pending: string | undefined;
let sending = false;

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: { 'x-sheaf-local': '1', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
}

/**
 * Give the editor a message, exactly as the extension host would.
 *
 * Typed, where it took `unknown` before. `unknown` is what `window.postMessage` accepts,
 * and taking the transport's type here meant the one file that declares this wire had no
 * say over the direction it declares: a message misspelled, missing a field the editor
 * reads, or never declared at all went out and the editor ignored it, with nothing to
 * read but a control that did nothing. The other direction has been checked message by
 * message for a while. This is the same boundary from the other end.
 */
/* --- Presentation state this viewer keeps ---------------------------------- */

/**
 * The widths, boards, folds and panel states a person sets, kept per document.
 *
 * VS Code keeps these in `context.workspaceState`, which is its own key-value store rather
 * than a file: none of it touches the `.md`, and deleting it loses only the arrangement. A
 * tab's equivalent is `localStorage`, and the equivalence is close enough to be the reason
 * rather than a convenience. Both are per-installation, invisible, outside the document, and
 * safe to lose. Keying on the document's path is what VS Code does with `tableWidthsKey`.
 *
 * Reached as `window.localStorage` rather than as a bare name, which is how this file already
 * reaches `window.postMessage` and the clipboard. The bare name was the first spelling and it
 * resolved to nothing in the bundle's own scope under the suite, so every write was swallowed
 * by the guard below and every read answered with the fallback. The product would have worked
 * in a browser and no check could have seen it, and the case written for a browser that blocks
 * site data passed for that reason rather than its own.
 *
 * Every read and write is wrapped, because `localStorage` throws rather than returning
 * nothing when a browser is in a private window or has site data blocked. A tab that cannot
 * keep the arrangement behaves as a document opened for the first time, which is a state the
 * editor already draws correctly; it is not a state worth refusing to open over.
 */
const KEPT = 'sheaf:kept:';

function readKept<T>(kind: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`${KEPT}${kind}:${file}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Keep `value`, or forget it when there is nothing left to keep, as VS Code does. */
function writeKept(kind: string, value: unknown): void {
  const key = `${KEPT}${kind}:${file}`;
  const empty = value === null || value === undefined || (typeof value === 'object' && Object.keys(value as object).length === 0);
  try {
    if (empty) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do and nothing to say: the arrangement is not kept and the document is fine.
  }
}

function toEditor(message: ToWebview): void {
  window.postMessage(message, '*');
}

/* --- Opening the document ------------------------------------------------- */

async function start(): Promise<void> {
  const res = await api(`/api/doc?path=${encodeURIComponent(file)}`);
  if (!res.ok) {
    failed(`Sheaf could not open ${file}.`);
    return;
  }
  const doc = (await res.json()) as {
    text: string;
    config: EditorConfig;
    fileName: string;
    resourceBaseUri: string;
    capabilities?: { terminal?: boolean };
  };
  sent = doc.text;
  // Kept here, where it is already in hand. The toolbar's own toggles amend this copy and
  // send the whole of it back, so it has to be the settings the server read rather than
  // the overrides alone: the editor merges what arrives over the manifest's defaults, so
  // a partial one would quietly undo whatever the folder had set.
  config = doc.config;
  const fragment = location.hash ? decodeURIComponent(location.hash.slice(1)) : undefined;
  toEditor({
    type: 'init',
    text: doc.text,
    config: doc.config,
    fileName: doc.fileName,
    resourceBaseUri: doc.resourceBaseUri,
    ...(fragment ? { fragment } : {}),
    // Carried from the server rather than decided here. It is the server that
    // would have to own a terminal, so it is the server that says there is
    // none, and this passes the answer on without having an opinion of its own.
    //
    // Written as a field rather than a conditional spread, which is what it was. A spread
    // carries whatever the object holds, so its property names are not checked against the
    // message's declaration even when the declaration has them: the name could be
    // misspelled here and the editor would read no capabilities and give a browser tab
    // Send to terminal, pointing at a terminal that is not there. Misspelled as a field it
    // is a compile error naming it. Undefined and absent mean the same thing to the
    // editor, which reads `capabilities?.terminal === false`, so always sending the key
    // costs nothing and `absence means everything` still holds for the host that sends no
    // capabilities at all.
    capabilities: doc.capabilities,
  });
  void listen();
}

/**
 * The server's push channel: an outside write, and nothing else so far.
 *
 * Read with `fetch` rather than `EventSource`, which cannot be given a header.
 * Every request to this server carries `x-sheaf-local`, and that rule is what
 * keeps a page somewhere else from talking to it through the browser, so an
 * endpoint exempt from it would be the one hole in the fence. The format on the
 * wire is still server-sent events; only the reader is different.
 *
 * `EventSource` also reconnects by itself, so that is done here too: a stream
 * that ends is opened again after a moment, which covers a server restarted
 * while a tab was left open.
 */
async function listen(): Promise<void> {
  for (;;) {
    try {
      const res = await api(`/api/events?path=${encodeURIComponent(file)}`);
      if (!res.ok || !res.body) throw new Error('no stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) receive(block);
      }
    } catch {
      // The server went away, or the connection dropped. Try again shortly.
    }
    await new Promise((again) => setTimeout(again, 1000));
  }
}

/**
 * One event off the stream. A document arrives as one `data:` line per line of it.
 *
 * The event's own name says whether the write took something the person had just typed, because
 * every `data:` line of the frame is their text and a flag there would be a line they could have
 * written. Matched exactly rather than by prefix: read with `startsWith` the flagless name
 * matches both frames, and the flag would be lost on the one that carries it.
 */
function receive(block: string): void {
  const name = block.split('\n', 1)[0];
  const body = block
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .join('\n');
  if (name === `event: ${NOTICE}`) {
    showNotice(body);
    return;
  }
  const tookTypedText = name === `event: ${SET_CONTENT_TOOK_TYPED}`;
  if (!tookTypedText && name !== `event: ${SET_CONTENT}`) return;
  sent = body;
  toEditor({ type: 'setContent', text: body, tookTypedText });
}

/**
 * Say what an outside write took, with an offer to put it back.
 *
 * VS Code has a notification surface and this host has none, so the page draws one. That is the
 * decision rather than a shortcut: a notification surface is a fact about what is around the
 * editor, which is what `src/server/` is for and why the file tree lives here too. Drawing it
 * inside the editor instead would mean the bundle knowing that one host needs a notice, and the
 * bundle is the same bytes in every host.
 *
 * The words come from the server, built by the same two functions the extension host uses, so
 * the two hosts cannot come to describe one event differently.
 *
 * **Undo posts a message and writes nothing.** The editor has already made the arriving document
 * one undo step, so this offer and the person's own Undo key do the same thing, and neither puts
 * back anything they did not type. That is what makes the offer safe: it is a shortcut to a key
 * they already have, not a second mechanism that could disagree with it.
 *
 * One notice at a time, replaced rather than stacked. A burst of writes would otherwise leave a
 * column of them, each offering to undo a document that is no longer the one on screen, and the
 * newest is the only one whose offer still means anything.
 */
function showNotice(message: string): void {
  const bar = document.getElementById('notice');
  if (!bar) return;
  bar.textContent = '';

  const text = document.createElement('span');
  text.className = 'sheaf-notice-text';
  text.textContent = message;
  bar.appendChild(text);

  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = 'Undo';
  undo.addEventListener('click', () => {
    toEditor({ type: 'undoOutsideChange' });
    hideNotice();
  });
  bar.appendChild(undo);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sheaf-notice-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', hideNotice);
  bar.appendChild(close);

  bar.hidden = false;
}

function hideNotice(): void {
  const bar = document.getElementById('notice');
  if (!bar) return;
  bar.hidden = true;
  bar.textContent = '';
}

function failed(message: string): void {
  const root = document.getElementById('editor');
  if (root) root.textContent = message;
}

/* --- Writing -------------------------------------------------------------- */

function postEdit(text: string): void {
  pending = text;
  if (!sending) void drain();
}

async function drain(): Promise<void> {
  sending = true;
  try {
    while (pending !== undefined) {
      const text = pending;
      pending = undefined;
      if (text === sent) continue;
      const res = await api('/api/doc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: file, text }),
      });
      if (res.ok) sent = text;
    }
  } catch {
    // Offline, or the server stopped. The text stays in the editor, and the next
    // keystroke tries again.
  } finally {
    sending = false;
  }
}

/**
 * The folder's documents, for completing a link's address.
 *
 * The editor waits 1.5 seconds for this and then offers only the current document's
 * headings, so an unanswered request is not a feature quietly missing: it is a pause the
 * person pays for and then nothing, which reads as the editor being slow.
 *
 * An empty list on failure rather than silence, for the same reason. The editor treats no
 * answer and an answer of nothing differently only in how long it waits, and waiting
 * again on the next keystroke is the worse of the two.
 */
async function sendWorkspaceFiles(id: string): Promise<void> {
  let files: string[] = [];
  try {
    const res = await api('/api/files');
    if (res.ok) {
      const body = (await res.json()) as { files?: unknown };
      if (Array.isArray(body.files)) files = body.files.filter((f): f is string => typeof f === 'string');
    }
  } catch {
    // Offline, or the server stopped. An empty list is the honest answer and the editor
    // falls back to this document's headings without waiting for the timeout.
  }
  toEditor({ type: 'workspaceFiles', id, files });
}

/**
 * What a pasted path names, for a tab: the address to write and the target's own title.
 *
 * A path relative to the document is the one shape a tab can resolve, and it is the shape
 * copying from the file tree gives. An absolute path or a `file:` URL names a place on the
 * machine, and the folder the server was started on is all this host can see, so those get
 * nothing back and the editor pastes the path as text.
 *
 * The server decides whether it will serve the target, exactly as it does for a link being
 * opened, so a path pointing outside the folder is refused there rather than checked here.
 */
async function docTitleFor(pasted: string): Promise<{ address?: string; title?: string }> {
  const raw = pasted.trim();
  if (!/\.(md|markdown)$/i.test(raw)) return {};
  // A scheme is a web address or a drive letter, and a leading slash is the web's root
  // rather than the folder's: none of the three is a path relative to this document.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) return {};
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  let url: URL;
  try {
    url = new URL(raw.replace(/\\/g, '/'), `file:///${dir}`);
  } catch {
    return {};
  }
  const target = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!target) return {};
  try {
    const res = await api(`/api/doc?path=${encodeURIComponent(target)}`);
    if (!res.ok) return {};
    const body = (await res.json()) as { text?: unknown };
    if (typeof body.text !== 'string') return {};
    // The pasted path is already relative to this document, so it is the address.
    return { address: raw, title: documentTitle(body.text, target) };
  } catch {
    return {};
  }
}

/* --- Links ----------------------------------------------------------------- */

/**
 * A link the editor asks the host to open.
 *
 * A web address opens in a new tab. Anything else is a path relative to the
 * document it was written in, so it becomes a URL on this server and the tab
 * navigates, which is as close as a browser gets to VS Code opening a second
 * editor. The server decides whether the path is one it will serve; a link that
 * points outside the folder lands on its refusal rather than being followed.
 */
function openLink(address: string): void {
  if (/^[a-z][a-z0-9+.-]*:/i.test(address)) {
    if (/^https?:/i.test(address)) window.open(address, '_blank', 'noopener');
    return;
  }
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  let url: URL;
  try {
    url = new URL(address, `file:///${dir}`);
  } catch {
    return;
  }
  const target = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!target) return;
  if (!/\.(md|markdown|txt)$/i.test(target)) {
    location.href = `/file/${encodeURI(target)}`;
    return;
  }
  location.href = `/edit/${encodeURI(target)}${url.hash}`;
}

/* --- Images ---------------------------------------------------------------- */

async function saveImage(id: string, name: string, data: string): Promise<void> {
  try {
    const res = await api('/api/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file, name, data }),
    });
    const body = (await res.json()) as { path?: string; error?: string };
    toEditor({ type: 'imageSaved', id, path: body.path, error: body.error });
  } catch {
    toEditor({ type: 'imageSaved', id, error: 'Sheaf could not reach the local editor to save the image.' });
  }
}

/* --- Settings -------------------------------------------------------------- */

/**
 * A setting the page asks to change: the table of contents, the front matter, or
 * line numbers.
 *
 * In VS Code these are settings changes, and every open editor hears about them. A
 * browser tab has no settings to write: the folder's `.vscode/settings.json`
 * belongs to the project rather than to this session, and a button press is a
 * poor reason to edit a file somebody has checked in. So the change is kept to
 * this tab and echoed back as `configChanged`, which is the message the editor
 * already acts on. It holds for every document opened in the tab, which is what
 * "everywhere" can honestly mean here, and it is gone when the tab is.
 */
let config: EditorConfig | undefined;

function setSetting<K extends 'tableOfContents' | 'frontMatter' | 'lineNumbers'>(
  key: K,
  value: EditorConfig[K]
): void {
  // Nothing to amend before the document opens, and nothing that could ask: the toggles
  // are the editor's own toolbar, and the editor is what `init` starts. The manifest's
  // defaults are not reachable from here to stand in as a base, because they live beside
  // the code that reads a folder's settings off disk, which a browser cannot bundle.
  if (!config) return;
  config = { ...config, [key]: value };
  toEditor({ type: 'configChanged', config });
}

/* --- The API the editor sees ------------------------------------------------ */

window.acquireVsCodeApi = function acquireVsCodeApi(): VsCodeApi {
  return {
    postMessage(raw: unknown): void {
      const message = raw as FromWebview;
      switch (message.type) {
        case 'ready':
          void start();
          break;

        case 'edit':
          postEdit(message.text as string);
          break;

        case 'openAsText':
          // There is no second editor to reopen the file in, so the button shows
          // the whole document's Markdown instead, which is the same view.
          toEditor({ type: 'toggleSourceMode' });
          break;

        case 'openLink':
          openLink(message.address as string);
          break;


        case 'workspaceFilesRead':
          void sendWorkspaceFiles(message.id);
          break;

        case 'docTitleRead':
          // Always answered, with nothing when the path names nothing this host can reach, so
          // the page never waits out its timeout for a paste it could have made plain at once.
          void docTitleFor(message.path as string).then((answer) =>
            toEditor({ type: 'docTitle', id: message.id as string, ...answer })
          );
          break;

        case 'clipboardWrite':
          void navigator.clipboard?.writeText(message.text as string).catch(() => undefined);
          break;

        case 'saveImage':
          void saveImage(message.id as string, message.name as string, message.data as string);
          break;

        case 'setTableOfContents':
          // The button says on or off and the setting is one of three names, so the two
          // have to be reconciled. The extension host did it and this one did not, and
          // nothing caught that: the value was held as `unknown` all the way to the
          // editor, so a `true` from the toolbar was stored where a name belongs and sent
          // back as one. `readOutline` is the reconciliation, in the file both hosts
          // already share, so there is one of it rather than one per host.
          setSetting('tableOfContents', readOutline(message.on));
          break;

        case 'setFrontMatter':
          setSetting('frontMatter', message.state);
          break;

        case 'setLineNumbers':
          setSetting('lineNumbers', message.on);
          break;

        /*
         * The presentation state, answered from this viewer's own storage.
         *
         * Each read is answered even when nothing is kept, with the empty value, because the
         * editor waits for an answer and a host that stays silent leaves it waiting. That is
         * the same reason the extension host's own comment gives.
         */
        /*
         * Refused rather than dropped. This host serves one document and has no endpoint for
         * writing another file beside it, which is the same larger question `dataFileRead` defers.
         * What changed is that the editor can now be told: the message carries an id and is
         * answered, so a person editing a cell of a file-backed view gets a sentence instead of a
         * grid that quietly disagrees with the file.
         */
        case 'dataFileEdit':
          toEditor({
            type: 'dataFileEdited',
            id: message.id,
            error: `${message.path} was not written: a browser tab can read the document it was opened on and cannot write other files beside it. Open the folder in VS Code to edit this file.`,
          });
          break;

        case 'tableWidthsRead':
          toEditor({ type: 'tableWidths', id: message.id, widths: readKept('widths', {}) });
          break;
        case 'tableWidthsWrite':
          writeKept('widths', message.widths);
          break;

        case 'tableBoardsRead':
          toEditor({ type: 'tableBoards', id: message.id, boards: readKept('boards', {}) });
          break;
        case 'tableBoardsWrite':
          writeKept('boards', message.boards);
          break;

        case 'commentFoldsRead':
          toEditor({ type: 'commentFolds', id: message.id, folds: readKept('folds', {}) });
          break;
        case 'commentFoldsWrite':
          writeKept('folds', message.folds);
          break;

        case 'frontMatterStateRead':
          toEditor({ type: 'frontMatterState', id: message.id, state: readKept('frontMatter', null) });
          break;
        case 'frontMatterStateWrite':
          writeKept('frontMatter', message.state);
          break;

        case 'outlineStateRead':
          toEditor({ type: 'outlineState', id: message.id, state: readKept('outline', null) });
          break;
        case 'outlineStateWrite':
          writeKept('outline', message.state);
          break;
      }
    },
    getState: () => null,
    setState: () => undefined,
  };
};

// A module rather than a script, so the `Window` declaration above is a global
// augmentation. Nothing is exported: the bundle's whole effect is the global it
// defines, and the editor bundle that loads after it is the only reader.
export {};
