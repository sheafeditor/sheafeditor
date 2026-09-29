/*
 * Clipboard writes through the extension host. A VS Code webview cannot reach the
 * system clipboard itself, so the host is asked to do it. Where there is no host
 * (the site's demo), the browser's clipboard API is asked instead.
 *
 * Reading is the browser's job and not this module's: a paste arrives as a paste
 * event carrying its own data, so nothing here ever has to ask what is on the
 * clipboard.
 */

import type { FromWebview } from '../protocol';

type Post = (message: FromWebview) => void;

let post: Post | null = null;

export function setClipboardHost(send: Post): void {
  post = send;
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
