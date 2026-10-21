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
import { DocumentSync, SyncHost, mergeOutsideChange, planEdit, toWebviewText } from '../textSync';
import { RecentTyping, noticeAboutLostText, noticeAboutRestoredText } from '../recentTyping';

/** A byte-order mark, which VS Code keeps out of a document's text and back in its file. */
const BOM = '﻿';

/** How long to wait for a file to stop changing before reading it. */
const WATCH_SETTLE_MS = 40;

/** A tab listening to one document. */
export interface Subscriber {
  /**
   * A whole document, in the webview's line endings.
   *
   * `tookTypedText` is true when it drops something the person typed a moment ago, which is what
   * makes the change one their own Undo takes back.
   *
   * Required rather than optional, which makes a *caller* that omits it an error. It does not
   * make an implementation that ignores it one: TypeScript lets a method declare fewer
   * parameters than its signature, so a subscriber can drop the flag and still compile. That is
   * the shape of the defect this whole parameter exists to fix — a quiet `false` nobody chose —
   * so the flag reaching a tab is held by a check in the server suite rather than by the type.
   */
  setContent(text: string, tookTypedText: boolean): void;
  /**
   * Something to tell the person, with an offer to undo it.
   *
   * A browser tab has no notification surface of its own, so the page draws one. The words are
   * built here rather than there, from the same two functions the extension host uses, because
   * two hosts writing their own sentences about one event is how they come to disagree about
   * what happened.
   */
  notice(message: string): void;
}

export class OpenDocument implements SyncHost {
  /** The file's text as it was last read or written, without its byte-order mark. */
  private text: string;
  private bom: boolean;
  private crlfEol: boolean;
  private readonly sync: DocumentSync;
  /*
   * What the tab has typed lately, and what a write landing from disk takes back of it.
   *
   * `recentTyping.ts` imports nothing but `textSync.ts` — no `vscode`, no Node builtin — so what
   * this host was missing was the call rather than the means. Without it every outside write
   * reached the editor marked as somebody else's ordinary edit, so the person's own Undo did not
   * offer their text back and nothing said anything had gone.
   */
  private readonly typing = new RecentTyping();
  /**
   * The text the tab holds, which is not the file's while a keystroke is on its way to disk.
   *
   * That gap is exactly where the race lives, so the comparison has to be against this rather
   * than against `this.text`: by the time a write arrives, `this.text` may already be what the
   * tab sent, and a comparison of a thing with itself finds nothing lost.
   */
  private webview: string;
  private readonly subscribers = new Set<Subscriber>();
  private watcher: FSWatcher | undefined;
  private settle: ReturnType<typeof setTimeout> | undefined;
  /**
   * How many changes of this document's own are in progress: a write between starting to put text
   * in the file and knowing what it holds, and a keystroke from the tab between arriving and being
   * worked into the file. Reading the file says nothing during either. A write leaves it part
   * written, and a keystroke is planned against a text that a read of the file would move under it.
   *
   * A count rather than a flag because there can be several at once: the tab's keystroke, the write
   * it makes, and the merge `reload` applies. Whichever finishes first must not declare the file
   * settled while the others are still under way.
   *
   * This is state, not time. It used to be a flag cleared on a timer some 80ms after the write,
   * and everything the watcher reported inside that period was thrown away, an agent's genuine
   * write included. What tells this host's own write from somebody else's is what the file holds
   * once nothing of ours is in it: `reload` compares that against `this.text`, so a read-back of
   * what was just written finds nothing new however soon it comes, and anything else is news.
   */
  private writing = 0;
  /** Counts the starts and ends of those changes, so a read can tell whether one overlapped it. */
  private writeEpoch = 0;
  /** True when the watcher settled while a change of ours was in progress, so the file is read once they are done. */
  private changedWhileWriting = false;

  private constructor(
    readonly path: string,
    readonly relative: string,
    raw: string
  ) {
    this.bom = raw.startsWith(BOM);
    this.text = this.bom ? raw.slice(1) : raw;
    this.crlfEol = firstEolIsCrlf(this.text);
    this.webview = toWebviewText(this.text);
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
   *
   * `planned` is the text the offsets were read off, and it is compared as well as the
   * file. The two answer different questions. The file read answers "did something else
   * write this"; the comparison answers "is this document still what the plan describes",
   * which a write of this host's own moves while leaving the file and `this.text`
   * agreeing, so the read finds nothing wrong and the stale offsets land.
   *
   * The window host had exactly that fault and wrote a sentence into the file twice. This
   * host was driven the same way and did not: with the merge in `reload` pushed to the tab
   * and its write under way, a keystroke sent at six timings across that window, three
   * runs each, left both changes in the file and nothing twice in all eighteen. So this
   * comparison is the rule the two hosts now answer alike rather than a fix for anything
   * measured here, and the file read above is what was already carrying it.
   */
  async applyEdit(start: number, end: number, replacement: string, planned: string): Promise<boolean> {
    if (planned !== this.text) {
      return false; // Moved since the plan, by a write of this host's own.
    }
    let onDisk: string;
    try {
      onDisk = await readFile(this.path, 'utf8');
    } catch {
      return false; // Gone, or unreadable. Nothing to write into.
    }
    if (planned !== this.text) {
      /*
       * The comparison above is repeated because the read took time. `reload` sets `this.text` to
       * what it reads, and a read that finishes while this one is still out would leave the file
       * and `this.text` agreeing on the new text, so the check below finds nothing wrong and the
       * offsets, which name places in the text the plan was made against, land in this one.
       * Measured: an outside write replacing a saved sentence with a shorter one, and a keystroke
       * sent a few milliseconds before the watcher settled, wrote the keystroke into the middle of
       * the next paragraph's last word.
       */
      return false;
    }
    const current = onDisk.startsWith(BOM) ? onDisk.slice(1) : onDisk;
    if (current !== this.text) {
      // Somebody else wrote between the plan and now. Take theirs and refuse, rebased first onto
      // what this host had already written when theirs was made from an older copy.
      this.bom = onDisk.startsWith(BOM);
      const rebased = this.rebaseOntoOwnWrites(current);
      if (rebased === undefined || !(await this.putInFile(rebased))) this.text = current;
      return false;
    }
    return this.putInFile(this.text.slice(0, start) + replacement + this.text.slice(end));
  }

  /**
   * Write `text` to the file and take it as what the file holds, or say it could not be.
   *
   * The count is raised for the length of the write because the file is part-written for a
   * while, and the watcher settling then would read a half of one text or the other. That read is
   * put off, not dropped: see `reload`. Once the write is over and `this.text` is what it
   * wrote, the file is read as usual, and the echo of this write finds nothing new.
   */
  private async putInFile(text: string): Promise<boolean> {
    this.begin();
    try {
      await writeFile(this.path, this.bom ? BOM + text : text, 'utf8');
      this.text = text;
      return true;
    } catch {
      return false;
    } finally {
      this.end();
    }
  }

  /**
   * A write from outside, found on disk as a keystroke is about to be written, put together with
   * what this host had already written there: or undefined when it should be taken as it is.
   *
   * **This is the path `reload` cannot reach.** A keystroke that goes out inside the watcher's
   * settle finds the write here first, before `reload` has read it, and the keystroke queue in
   * `DocumentSync` then merges the person's text against the write using what the file last
   * held as the base. That base already holds the person's saved sentence, so a write made from
   * a copy taken before the sentence reads as somebody deleting it, and the sentence goes from
   * the file with the next keystroke landing on the write's line instead. Measured, before this:
   * a sentence saved, a write carrying the pre-save copy plus a paragraph, and a keystroke sent
   * 0 to 25 ms after it, lost the sentence in eighteen drives out of eighteen.
   *
   * The base used here is `typing.baseline()`, the text before the person's oldest edit still in
   * the window, which is what the write's author can have read. It is still on record at this
   * point because nothing has reached the tab since the person typed: `forget` is only called
   * once a document has been pushed, and here none has been yet.
   *
   * The two sides merged are the file as this host wrote it and the file as it now is, both
   * without the keystroke in flight. That turns the write into what it would have been had its
   * author read the saved file, and the keystroke queue then plans against that as an ordinary
   * outside change, the case it already merges cleanly.
   *
   * The same guard `reload` and the window have: taken only when it genuinely combines the two.
   * A merge that resolves to either side is a write that really conflicts, or one that changed
   * nothing of the person's, and both go the way they went before.
   */
  private rebaseOntoOwnWrites(current: string): string | undefined {
    const base = this.typing.baseline();
    if (base === undefined) return undefined;
    const ours = toWebviewText(this.text);
    const theirs = toWebviewText(current);
    const together = mergeOutsideChange(base, ours, theirs).text;
    if (together === ours || together === theirs) return undefined;
    return planEdit(current, together, firstEolIsCrlf(current))?.text;
  }

  setContent(text: string, tookTypedText: boolean): void {
    // The tab is about to hold this, so it is the baseline the next write is measured against.
    this.webview = text;
    for (const sub of this.subscribers) sub.setContent(text, tookTypedText);
  }

  onEdited(): void {
    // Writing is the save. Nothing further to do.
  }

  /* --- Tabs ---------------------------------------------------------------- */

  /** The whole text a tab posted after an edit of its own. */
  edit(text: string): Promise<void> {
    // Both sides of the edit, because the span of an edit can only be known while it is happening.
    // Working it out later from the oldest baseline cannot tell the person's edits from a change
    // that arrived from outside, and attributing somebody else's paragraphs to the person is what
    // the notice then reads back to them.
    this.typing.record(this.webview, text);
    this.webview = text;
    /*
     * Counted for as long as the keystroke is being worked into the file, so `reload` does not take
     * an outside write in at the same time. Both would put the same write together with the same
     * typing, each against its own idea of what the person started from, and the second would add
     * what the first had already added: a measured drive wrote the keystroke into the file twice.
     * One of them goes first, and `reload` is the one that waits, because the keystroke's own
     * write reads the file before it writes and meets the outside write there.
     */
    this.begin();
    return this.sync.edit(text).finally(() => this.end());
  }

  /** A change of ours begins: until it ends, what the file holds is not news. */
  private begin(): void {
    this.writing++;
    this.writeEpoch++;
  }

  /** A change of ours ends, and a change the watcher reported meanwhile is read now. */
  private end(): void {
    this.writing--;
    this.writeEpoch++;
    if (this.writing === 0 && this.changedWhileWriting) {
      this.changedWhileWriting = false;
      this.fileChanged();
    }
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
      void this.reload();
    }, WATCH_SETTLE_MS);
  }

  private async reload(): Promise<void> {
    const epoch = this.writeEpoch;
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return; // Deleted or replaced mid-write. The next change will bring it back.
    }
    if (this.writing > 0 || epoch !== this.writeEpoch) {
      /*
       * A change of this host's own was under way, began, or ended while the file was being read.
       * A file being written holds a half of one text or the other, and one read just before a
       * write is the file as it was, with `this.text` already past it. Taken for news, the first
       * would be pushed to the tab as it stands and the second would put the tab back a keystroke
       * while the file kept it. Nothing is lost by not looking: the file is read again once the
       * changes are over, and by content.
       */
      if (this.writing > 0) this.changedWhileWriting = true;
      else this.fileChanged();
      return;
    }
    const text = raw.startsWith(BOM) ? raw.slice(1) : raw;
    if (text === this.text) return;
    this.bom = raw.startsWith(BOM);
    this.text = text;
    this.crlfEol = firstEolIsCrlf(text);
    /*
     * What this write takes back of what the person just did, read before the push, because
     * pushing is what replaces the tab's text.
     *
     * Two ways a write undoes their work and both count: it drops what they typed, or it puts
     * back what they deleted. A row taken out of a table that is simply there again is their
     * edit undone as surely as a lost sentence.
     */
    const arriving = toWebviewText(text);
    /*
     * The write is read in and put together with what the person has, which is what a window does in
     * `keepOutsideChange` and what this host had no equivalent of. Without it a write merely behind
     * on the line being typed took that line back, even with the typing already on disk and the write
     * changing a different line. The page promises otherwise in so many words: "when the file has
     * changed underneath an edit you are part-way through, your text is what gets written. This is
     * the same rule your editor follows."
     *
     * Three things, and each one is a guard the window already had:
     *
     * **The base is what the person started from, not what the file last held.** `mergeOutsideChange`
     * returns `theirs` when `mine === base`, so told the saved text it concludes nothing is pending
     * and takes the write whole. Measured: the saved base loses the letter, the pre-typing base keeps
     * the letter and the writer's own change together, and a write into the very line typed in still
     * comes back `dropped`, so the real conflict is still reported.
     *
     * **Applied only when it is a genuine combination of the two**, never when it resolves to one
     * side, which is the window's `if (together === mine || together === theirs) return arriving`.
     * A refusing merge returns the person's text *whole*, so a looser condition takes this branch on
     * every conflict and throws the other program's work away.
     *
     * **Planned against the document and applied through `applyEdit`**, not handed to `sync.edit`.
     * `sync.edit` means the webview made an edit, so it plans and replans against the webview's own
     * state; given a merge it produced a plan against a text that had already moved and left the
     * write's line in the file twice, which is the one outcome `multipliesALine` exists to refuse.
     * `applyEdit` is the document path, and it already counts itself in `writing` across the write
     * and sets `this.text` to what it wrote, so the watcher's read of this host's own write finds
     * nothing new and does not merge against itself.
     */
    const base = this.typing.baseline();
    const together = base === undefined ? null : mergeOutsideChange(base, this.webview, arriving);
    if (together && together.text !== arriving && together.text !== this.webview) {
      const plan = planEdit(this.text, together.text, this.crlfEol);
      if (plan) {
        // Both changes survived, so nothing was taken and nothing is said. `dropped` cannot be true
        // here: a refusing merge returns the person's text whole, which the guard above excludes.
        this.typing.forget();
        // The tab first, so it is holding the result before the file is written and there is no
        // moment where the two disagree in the direction a person would notice.
        this.sync.documentChanged(plan.text, false);
        void this.applyEdit(plan.start, plan.end, plan.replacement, this.text);
        return;
      }
    }
    const lost = this.typing.dropped(this.webview, arriving);
    const back = lost === undefined ? this.typing.restored(this.webview, arriving) : undefined;
    const reached = this.sync.documentChanged(text, lost !== undefined || back !== undefined);
    if (reached) {
      // Whatever was typed is either in this document or gone from it, so nothing on record can
      // be taken by a later write.
      this.typing.forget();
      // And said out loud, after the document has gone, so the offer to undo it refers to
      // something the editor is already holding as an undo step.
      if (lost !== undefined) this.say(noticeAboutLostText(lost));
      else if (back !== undefined) this.say(noticeAboutRestoredText(back));
    }
  }

  private say(message: string): void {
    for (const sub of this.subscribers) sub.notice(message);
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
