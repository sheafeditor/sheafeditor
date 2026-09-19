/*
 * Clipboard reads through the extension host. A VS Code webview cannot read the
 * system clipboard itself, so a read is a request the host answers by id. Where no
 * host answers in time (the site's demo), the browser's clipboard API is asked.
 */

type Post = (message: unknown) => void;

let post: Post | null = null;
let seq = 0;
const pending = new Map<string, (text: string) => void>();

export function setClipboardHost(send: Post): void {
  post = send;
}

/** Resolve a pending read with the text the host sent back. */
export function handleClipboardText(id: string, text: string): void {
  const done = pending.get(id);
  if (!done) return;
  pending.delete(id);
  done(text);
}

function browserRead(): Promise<string> {
  try {
    return navigator.clipboard?.readText ? navigator.clipboard.readText().catch(() => '') : Promise.resolve('');
  } catch {
    return Promise.resolve('');
  }
}

/** The clipboard's plain text, or an empty string when it cannot be read. */
export function readClipboardText(): Promise<string> {
  const send = post;
  if (!send) return browserRead();
  const id = `clip-${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      void browserRead().then(resolve);
    }, 400);
    pending.set(id, (text) => {
      clearTimeout(timer);
      resolve(text);
    });
    send({ type: 'clipboardRead', id });
  });
}

/** Put plain text on the clipboard: through the host when there is one, otherwise with the browser's clipboard API. */
export function writeClipboardText(text: string): void {
  if (post) {
    post({ type: 'clipboardWrite', text });
    return;
  }
  try {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  } catch {
    // No clipboard access in this context; there is nothing else to try.
  }
}
