/**
 * The open documents, and how a keystroke in a browser tab reaches the file.
 *
 * In VS Code a Sheaf editor writes through a TextDocument: the webview posts its
 * whole text, `DocumentSync` plans the one replacement that turns the document
 * into it, and VS Code saves. There is no TextDocument here, so this stands in
 * as one, backed by the file itself. `DocumentSync` is the same class the
 * extension uses, which is the point: the burst handling, the replan on a
 * refused edit and the rule about when the webview may be told what the document
 * holds are all behaviour that took a while to get right, and a second copy of
 * it written for the server would drift from the first.
 *
 * Two things the extension gets from VS Code have to be built here.
 *
 * The first is the refusal. VS Code rejects an edit prepared against a document
 * that moved under it, which is what makes a burst of keystrokes land in order.
 * The file is re-read immediately before it is written, and an edit whose
 * starting text is no longer what is on disk is refused the same way, so the
 * text somebody else wrote is never overwritten by a plan made before it
 * arrived. `DocumentSync` then plans again against what is there now.
 *
 * The second is noticing an outside change at all. VS Code watches the file and
 * reloads the document; here `fs.watch` does it, debounced, because an editor
 * saving a file commonly fires the watcher two or three times for one save.
 *
 * One entry per path, shared by every tab open on it. Two tabs on one document
 * are then the same situation as two editor groups on one TextDocument: an edit
 * in either reaches the other, rather than the two overwriting each other in
 * turn.
 */

import { FSWatcher, watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { DocumentSync, SyncHost, toWebviewText } from '../textSync';

/** A byte-order mark, which VS Code keeps out of a document's text and back in its file. */
const BOM = '﻿';

/** How long to wait for a file to stop changing before reading it. */
const WATCH_SETTLE_MS = 40;

/** A tab listening to one document. */
export interface Subscriber {
  setContent(text: string): void;
}

export class OpenDocument implements SyncHost {
  /** The file's text as it was last read or written, without its byte-order mark. */
  private text: string;
  private bom: boolean;
  private crlfEol: boolean;
  private readonly sync: DocumentSync;
  private readonly subscribers = new Set<Subscriber>();
  private watcher: FSWatcher | undefined;
  private settle: ReturnType<typeof setTimeout> | undefined;
  /** Set while this document is writing, so its own write is not read back as news. */
  private writing = false;

  private constructor(
    readonly path: string,
    readonly relative: string,
    raw: string
  ) {
    this.bom = raw.startsWith(BOM);
    this.text = this.bom ? raw.slice(1) : raw;
    this.crlfEol = firstEolIsCrlf(this.text);
    this.sync = new DocumentSync(this);
    this.startWatching();
  }

  static async open(path: string, relative: string): Promise<OpenDocument> {
    return new OpenDocument(path, relative, await readFile(path, 'utf8'));
  }

  /* --- What the webview is given ------------------------------------------ */

  /** The document as the webview holds it: every line ending written as a newline. */
  webviewText(): string {
    return toWebviewText(this.text);
  }

  /* --- SyncHost ------------------------------------------------------------ */

  getText(): string {
    return this.text;
  }

  crlf(): boolean {
    return this.crlfEol;
  }

  /**
   * Replace `[start, end)` in the file.
   *
   * False means the file moved under the plan and the caller should plan again,
   * which is how a write that was prepared before somebody else's arrived is
   * kept from undoing it.
   */
  async applyEdit(start: number, end: number, replacement: string): Promise<boolean> {
    let onDisk: string;
    try {
      onDisk = await readFile(this.path, 'utf8');
    } catch {
      return false; // Gone, or unreadable. Nothing to write into.
    }
    const current = onDisk.startsWith(BOM) ? onDisk.slice(1) : onDisk;
    if (current !== this.text) {
      // Somebody else wrote between the plan and now. Take theirs and refuse.
      this.bom = onDisk.startsWith(BOM);
      this.text = current;
      return false;
    }
    const next = this.text.slice(0, start) + replacement + this.text.slice(end);
    this.writing = true;
    try {
      await writeFile(this.path, this.bom ? BOM + next : next, 'utf8');
    } catch {
      this.writing = false;
      return false;
    }
    this.text = next;
    // The watcher fires after the write lands, so the flag is dropped on a timer
    // rather than immediately; `documentChanged` would drop the echo anyway, and
    // this keeps the file from being read back for nothing on every keystroke.
    setTimeout(() => {
      this.writing = false;
    }, WATCH_SETTLE_MS * 2);
    return true;
  }

  setContent(text: string): void {
    for (const sub of this.subscribers) sub.setContent(text);
  }

  onEdited(): void {
    // Writing is the save. Nothing further to do.
  }

  /* --- Tabs ---------------------------------------------------------------- */

  /** The whole text a tab posted after an edit of its own. */
  edit(text: string): Promise<void> {
    return this.sync.edit(text);
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** True when no tab is listening, so the document can be let go. */
  idle(): boolean {
    return this.subscribers.size === 0;
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.settle) clearTimeout(this.settle);
  }

  /* --- The file changing underneath ---------------------------------------- */

  private startWatching(): void {
    try {
      this.watcher = watch(this.path, () => this.fileChanged());
    } catch {
      // A filesystem that cannot watch still edits; it just will not notice a
      // change made elsewhere. Better than refusing to open the document.
    }
  }

  private fileChanged(): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = undefined;
      if (this.writing) return;
      void this.reload();
    }, WATCH_SETTLE_MS);
  }

  private async reload(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return; // Deleted or replaced mid-write. The next change will bring it back.
    }
    const text = raw.startsWith(BOM) ? raw.slice(1) : raw;
    if (text === this.text) return;
    this.bom = raw.startsWith(BOM);
    this.text = text;
    this.crlfEol = firstEolIsCrlf(text);
    this.sync.documentChanged(text);
  }
}

/**
 * Whether the document's lines end with CRLF, decided by the first line ending in
 * it, which is how VS Code decides a document's own.
 */
function firstEolIsCrlf(text: string): boolean {
  const at = text.indexOf('\n');
  return at > 0 && text.charCodeAt(at - 1) === 13;
}

/** Every document a tab currently has open, one entry per path. */
export class DocumentStore {
  private readonly open = new Map<string, Promise<OpenDocument>>();

  async get(path: string, relative: string): Promise<OpenDocument> {
    const existing = this.open.get(path);
    if (existing) return existing;
    const opening = OpenDocument.open(path, relative).catch((err: unknown) => {
      this.open.delete(path);
      throw err;
    });
    this.open.set(path, opening);
    return opening;
  }

  /** Let go of a document nothing is listening to. */
  release(doc: OpenDocument): void {
    if (!doc.idle()) return;
    this.open.delete(doc.path);
    doc.close();
  }

  closeAll(): void {
    for (const opening of this.open.values()) {
      void opening.then((doc) => doc.close()).catch(() => undefined);
    }
    this.open.clear();
  }
}
