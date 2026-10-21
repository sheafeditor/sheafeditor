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
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { mountSlot, scopeNear } from './mountScope';
import type { MountScope } from './mountScope';

type Post = (message: FromWebview) => void;

/** Which host each editor asks to write the clipboard. Per mount, because each has its own. */
const own = mountSlot<{ post: Post | null }>(() => ({ post: null }));

export function setClipboardHost(send: Post, scope?: MountScope): void {
  (scope ? own.of(scope) : own.at(null)).post = send;
}

/**
 * Put plain text on the clipboard: through the host when there is one, otherwise with the browser's
 * clipboard API.
 *
 * `near` says which editor is asking — the view, or an element inside it.
 */
export function writeClipboardText(text: string, near?: EditorView | EditorState | Node | null): void {
  const post = own.of(scopeNear(near)).post;
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
