/**
 * Turning the webview's text into an edit on the VS Code document.
 *
 * The two hold the same document with different line endings. CodeMirror breaks lines
 * on CRLF, a lone CR and LF alike and joins them back with LF, so whatever the file
 * uses, the webview's text ends its lines with LF. Both sides are therefore compared
 * in the webview's line endings and the offsets of the result are mapped back to the
 * document, which is the only place they may differ. Only the replacement is written
 * in the document's own line ending, so an ending the person did not type through is
 * left exactly as the file has it.
 *
 * Text is compared by UTF-16 code unit, so a boundary can land between the two halves
 * of a surrogate pair: 😀 and 😃 share their first half and differ only in the second.
 * Half a pair is not a character and cannot be encoded, so an edit that replaced one
 * would write U+FFFD into the file. Both boundaries are widened off the inside of a
 * pair before the edit is returned.
 */

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when `index` falls between the high and low halves of a surrogate pair. */
function splitsPair(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  );
}

/** The single contiguous replacement that turns `oldText` into `newText`. */
export function minimalEdit(
  oldText: string,
  newText: string
): { start: number; end: number; replacement: string } {
  const oldLen = oldText.length;
  const newLen = newText.length;
  let start = 0;
  const maxStart = Math.min(oldLen, newLen);
  while (start < maxStart && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }
  // One step back clears a split pair: the unit now before `start` is the one that
  // preceded the high half, which cannot itself be a high half of the same pair. The
  // suffix scan runs afterwards so it stops at the corrected boundary and the edit
  // stays as short as a whole-character edit can be.
  if (splitsPair(oldText, start) || splitsPair(newText, start)) {
    start--;
  }
  let oldEnd = oldLen;
  let newEnd = newLen;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  // The common suffix is the same length on both sides, so the two ends move together
  // and neither runs past its text. One step forward clears a split pair here too.
  if (splitsPair(oldText, oldEnd) || splitsPair(newText, newEnd)) {
    oldEnd++;
    newEnd++;
  }
  return { start, end: oldEnd, replacement: newText.slice(start, newEnd) };
}

/**
 * The document as the webview holds it: every line ending written as the newline
 * CodeMirror turns it into. This is what the host must send, at `init` and at every
 * `setContent`. Sent anything else, the webview is left diffing the newlines it holds
 * against the carriage returns it was given, and the difference between them lands in
 * the document as text.
 */
export function toWebviewText(documentText: string): string {
  return documentText.replace(/\r\n?/g, '\n');
}

/**
 * The document offset `count` webview characters past `from`. A CRLF is one character
 * to the webview and two to the document; a lone CR is one to each.
 */
function advance(documentText: string, from: number, count: number): number {
  let at = from;
  for (let i = 0; i < count; i++) {
    at += documentText.charCodeAt(at) === 13 && documentText.charCodeAt(at + 1) === 10 ? 2 : 1;
  }
  return at;
}

/**
 * The edit that brings the document's text to the webview's, with `text` the
 * document's full text afterwards, or null when the two already match.
 */
export function planEdit(
  documentText: string,
  webviewText: string,
  crlf: boolean
): { start: number; end: number; replacement: string; text: string } | null {
  // A document with no carriage return in it already reads the way the webview holds
  // it, so its offsets need no mapping and the common case costs nothing.
  const carriageReturns = documentText.includes('\r');
  const shown = carriageReturns ? toWebviewText(documentText) : documentText;
  if (shown === webviewText) return null;
  const edit = minimalEdit(shown, webviewText);
  const start = carriageReturns ? advance(documentText, 0, edit.start) : edit.start;
  const end = carriageReturns ? advance(documentText, start, edit.end - edit.start) : edit.end;
  const replacement = crlf ? edit.replacement.replace(/\n/g, '\r\n') : edit.replacement;
  return {
    start,
    end,
    replacement,
    text: documentText.slice(0, start) + replacement + documentText.slice(end),
  };
}

/** What the sync needs from the document it is writing to. */
export interface SyncHost {
  /** The document's text as it reads right now. */
  getText(): string;
  /** True when the document's lines end with CRLF. */
  crlf(): boolean;
  /** Replace `[start, end)` with `replacement`. False when the editor refused the edit. */
  applyEdit(start: number, end: number, replacement: string): Promise<boolean>;
  /** Give the webview a whole document, in the webview's line endings, replacing what it holds. */
  setContent(text: string): void;
  /** Called after each edit the document accepted. */
  onEdited(): void;
}

/**
 * How many times an edit the editor refuses is planned again before the webview is
 * sent the document instead. A refusal means the document moved under the edit, so
 * the next plan is made against what it moved to and normally lands; the bound is
 * there so a document being written to continuously cannot spin here forever.
 */
const REPLAN_LIMIT = 8;

/**
 * One queue for everything written into the document.
 *
 * VS Code refuses a workspace edit prepared against a document that has changed
 * since — "has changed in the meantime" — so two edits may not be in flight over
 * one document. The second was planned against text the first has already
 * replaced, and it is thrown away. A burst of keystrokes arrives as a burst of
 * messages from the webview, which is exactly that situation, and the refused
 * edits are the letters that go missing.
 *
 * So each edit is planned against the document as it reads at the moment it is
 * written, and a refused one is planned again rather than dropped. The webview
 * posts its whole text every time, so a keystroke arriving while an edit is in
 * flight replaces the one waiting instead of queueing behind it.
 *
 * The webview is told what the document holds only once the queue drains. Until
 * then the document is passing through states older than what the person is
 * looking at, and sending one of those back is what truncates their typing.
 */
export class DocumentSync {
  /** The document text the webview is known to reflect. */
  private syncedText: string;
  /** The newest text the webview has posted and the document has not taken yet. */
  private pendingText: string | undefined;
  /** The run draining `pendingText`, while there is one. */
  private draining: Promise<void> | undefined;

  constructor(private readonly host: SyncHost) {
    this.syncedText = host.getText();
  }

  /** The whole document text, posted by the webview after an edit of its own. */
  public edit(text: string): Promise<void> {
    this.pendingText = text;
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = undefined;
      });
    }
    return this.draining;
  }

  /** The document changed. Pushes it to the webview unless the webview is ahead. */
  public documentChanged(text: string): void {
    if (this.draining) {
      // Mid-burst: this is either the echo of an edit of our own or an outside
      // write the burst is about to be planned against. `drain` posts whatever
      // the document ends up holding, so nothing older than that goes out now.
      return;
    }
    if (text === this.syncedText) {
      return;
    }
    this.syncedText = text;
    this.host.setContent(toWebviewText(text));
  }

  private async drain(): Promise<void> {
    let replans = 0;
    let abandoned = false;
    while (this.pendingText !== undefined) {
      const text = this.pendingText;
      this.pendingText = undefined;
      const plan = planEdit(this.host.getText(), text, this.host.crlf());
      if (!plan) {
        // The document already holds it — an edit of ours that has landed, or an
        // outside write that happened to agree with the webview.
        this.syncedText = this.host.getText();
        replans = 0;
        continue;
      }
      const before = this.syncedText;
      // Claim the result before applying it: the document reports the change while
      // the edit is still in flight, and the claim is what keeps that echo from
      // being posted back to the webview as news.
      this.syncedText = plan.text;
      const applied = await this.host.applyEdit(plan.start, plan.end, plan.replacement);
      if (applied) {
        replans = 0;
        this.host.onEdited();
        continue;
      }
      this.syncedText = before;
      if (this.pendingText !== undefined) {
        continue; // Newer text arrived meanwhile; it supersedes this one.
      }
      if (replans++ < REPLAN_LIMIT) {
        this.pendingText = text;
      } else {
        abandoned = true;
      }
    }
    const text = this.host.getText();
    if (abandoned || text !== this.syncedText) {
      this.syncedText = text;
      this.host.setContent(toWebviewText(text));
    }
  }
}
