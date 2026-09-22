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

/** Anything the editor posts out. Only the cases below are acted on. */
interface OutboundMessage {
  type: string;
  [key: string]: unknown;
}

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

/** Give the editor a message, exactly as the extension host would. */
function toEditor(message: unknown): void {
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
    config: unknown;
    fileName: string;
    resourceBaseUri: string;
    capabilities?: { terminal?: boolean };
  };
  sent = doc.text;
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
    ...(doc.capabilities ? { capabilities: doc.capabilities } : {}),
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

/** One event off the stream. A document arrives as one `data:` line per line of it. */
function receive(block: string): void {
  if (!block.startsWith('event: setContent')) return;
  const text = block
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .join('\n');
  sent = text;
  toEditor({ type: 'setContent', text });
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
  if (!/\.(md|markdown)$/i.test(target)) {
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
 * The toolbar's table-of-contents button.
 *
 * In VS Code this is a settings change, and every open editor hears about it. A
 * browser tab has no settings to write: the folder's `.vscode/settings.json`
 * belongs to the project rather than to this session, and a button press is a
 * poor reason to edit a file somebody has checked in. So the change is kept to
 * this tab and echoed back as `configChanged`, which is the message the editor
 * already acts on.
 */
let config: Record<string, unknown> = {};

function setTableOfContents(on: boolean): void {
  config = { ...config, tableOfContents: on };
  toEditor({ type: 'configChanged', config });
}

/* --- The API the editor sees ------------------------------------------------ */

window.acquireVsCodeApi = function acquireVsCodeApi(): VsCodeApi {
  return {
    postMessage(raw: unknown): void {
      const message = raw as OutboundMessage;
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

        case 'clipboardWrite':
          void navigator.clipboard?.writeText(message.text as string).catch(() => undefined);
          break;

        case 'clipboardRead':
          void (navigator.clipboard?.readText() ?? Promise.resolve(''))
            .catch(() => '')
            .then((text) => toEditor({ type: 'clipboardText', id: message.id, text }));
          break;

        case 'saveImage':
          void saveImage(message.id as string, message.name as string, message.data as string);
          break;

        case 'setTableOfContents':
          setTableOfContents(message.on as boolean);
          break;
      }
    },
    getState: () => null,
    setState: () => undefined,
  };
};

// `init` carries the settings, and the toolbar's own toggle works from a copy of
// them, so the first one that arrives is kept.
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; config?: Record<string, unknown> } | null;
  if (data?.type === 'init' && data.config) config = data.config;
});

// A module rather than a script, so the `Window` declaration above is a global
// augmentation. Nothing is exported: the bundle's whole effect is the global it
// defines, and the editor bundle that loads after it is the only reader.
export {};
