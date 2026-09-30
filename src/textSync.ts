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
 * Two changes to the same text put together by character span, one span each.
 *
 * This is the finer of the two ways `mergeOutsideChange` tries, and the only one
 * that can put together two changes inside a single line: a cell an agent rewrote
 * and a cell the person is typing in, three columns along the same table row.
 */
function mergeSpans(base: string, mine: string, theirs: string): string | null {
  const ours = minimalEdit(base, mine);
  const other = minimalEdit(base, theirs);
  /*
   * Refused unless the two spans are wholly apart. Strictly apart, not merely
   * non-overlapping: two insertions at the very same offset are each zero
   * characters wide and so overlap nothing, but there is no answer to which of
   * them goes first, and putting one inside the other makes a word neither person
   * typed. `Start` typed into as `StartQ` while something else made it `Started
   * differently` came out as `StartQed differently`, which is the kind of text a
   * person cannot account for afterwards.
   *
   * The cost is that a change immediately after another is refused too, and the
   * person keeps theirs. Refusing a merge loses a change that can be made again;
   * a wrong merge writes a sentence nobody wrote.
   */
  if (ours.start <= other.end && other.start <= ours.end) return null;
  // Ahead of the other change, so its offsets in the other's text are its own.
  if (ours.end <= other.start) return theirs.slice(0, ours.start) + ours.replacement + theirs.slice(ours.end);
  const shift = other.replacement.length - (other.end - other.start);
  return theirs.slice(0, ours.start + shift) + ours.replacement + theirs.slice(ours.end + shift);
}

/** Lines [start, end) of the base became `lines`. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/**
 * How large a region of differing lines is still diffed line by line. The table
 * below is one cell per pair of differing lines, so the cost is the product of the
 * two sides. A region past this is somebody replacing the whole document, where
 * there is nothing to put together anyway.
 */
const DIFF_CELL_LIMIT = 4_000_000;

/**
 * How much of the longer of two lines has to be shared, in tenths, for them to count
 * as one line that changed rather than two different lines.
 */
const SAME_LINE_SHARE = 6;

/** Lines shorter than this are too short to judge by how much they share. */
const SAME_LINE_FLOOR = 8;

/**
 * Whether these are the same line, one of them changed, rather than two unrelated
 * lines.
 *
 * The line diff needs this as well as equality, and a merge that loses work is what
 * happens without it. Something writing the file read it a moment ago, so its copy of
 * the line being typed in is short of the last few letters. To a diff that only knows
 * equality, that line is gone and another has arrived, and so a paragraph deleted
 * right beside it has no unchanged line between the two to anchor on: the deletion and
 * the typed line collapse into one range, the range disagrees with the person's typing,
 * and the deletion is dropped along with it. The agent is left believing it removed
 * something that is still there.
 *
 * Shared prefix and suffix is the measure, because that is the shape of the difference
 * between a line and the same line typed further into. A blank line is never the same
 * line as one with something on it, and a short line is not judged this way at all,
 * where a few shared characters are easy to come by and the cost of being wrong is a
 * line of somebody's prose replaced by another.
 */
function sameLineChanged(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (longest < SAME_LINE_FLOOR) return false;
  if (a.trim() === '' || b.trim() === '') return false;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (
    post < a.length - pre &&
    post < b.length - pre &&
    a[a.length - 1 - post] === b[b.length - 1 - post]
  ) {
    post++;
  }
  return (pre + post) * 10 >= longest * SAME_LINE_SHARE;
}

/**
 * Every place `next` differs from `base`, a line at a time, or null when the region
 * that differs is too large to diff.
 *
 * Common lines at the start and end are trimmed first, which is nearly all of a
 * document, and the shortest edit over what is left is read off an LCS table. The
 * table matches a line against the same line changed as well as against itself, so
 * a changed line anchors the ranges around it instead of reading as one line gone
 * and another arrived. A line matched that way is still a change, and comes back as
 * a range of its own.
 */
function lineHunks(base: string[], next: string[]): Hunk[] | null {
  let pre = 0;
  while (pre < base.length && pre < next.length && base[pre] === next[pre]) pre++;
  let post = 0;
  while (
    post < base.length - pre &&
    post < next.length - pre &&
    base[base.length - 1 - post] === next[next.length - 1 - post]
  ) {
    post++;
  }
  const a = base.slice(pre, base.length - post);
  const b = next.slice(pre, next.length - post);
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return [{ start: pre, end: pre, lines: b }];
  if (b.length === 0) return [{ start: pre, end: pre + a.length, lines: [] }];
  if (a.length * b.length > DIFF_CELL_LIMIT) return null;
  const width = b.length + 1;
  const common = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = sameLineChanged(a[i], b[j])
        ? common[(i + 1) * width + j + 1] + 1
        : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let open: Hunk | undefined;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && sameLineChanged(a[i], b[j])) {
      // A line both sides have closes whatever was open, and is a range of its own
      // when it is that line changed rather than that line kept.
      if (a[i] !== b[j]) hunks.push({ start: pre + i, end: pre + i + 1, lines: [b[j]] });
      open = undefined;
      i++;
      j++;
      continue;
    }
    if (!open) {
      open = { start: pre + i, end: pre + i, lines: [] };
      hunks.push(open);
    }
    // Which side to step is the table's answer, so the hunks are as few as the
    // shortest edit allows. A line dropped and a line added at one place land in
    // one hunk, which is what a rewritten line is.
    if (j >= b.length || (i < a.length && common[(i + 1) * width + j] >= common[i * width + j + 1])) {
      open.end = pre + ++i;
    } else {
      open.lines.push(b[j++]);
    }
  }
  return hunks;
}

/** `lines` with `hunks` applied, where the hunks' line numbers start at `offset`. */
function applyHunks(lines: string[], hunks: Hunk[], offset: number): string[] {
  const out: string[] = [];
  let at = 0;
  for (const hunk of hunks) {
    out.push(...lines.slice(at, hunk.start - offset), ...hunk.lines);
    at = hunk.end - offset;
  }
  out.push(...lines.slice(at));
  return out;
}

/** What putting two changes together came to. */
export interface Merged {
  /** The text they make together. Always something: at worst it is the person's own. */
  text: string;
  /** True when part of the other change could not be kept and is not in `text`. */
  dropped: boolean;
}

/**
 * The person's change and somebody else's, both made to the same text, put together.
 *
 * This is what stops an agent's write being lost. Something else writes the file
 * while a person is typing in it, and both changes are real: the person's letters
 * and, say, a cell an agent rewrote three paragraphs away. Planning the person's
 * text straight onto the file, which is what used to happen, silently takes the
 * other change back out, because the text the person's editor holds was read
 * before that change existed.
 *
 * The two are compared a line at a time, because a line is the unit git stores and
 * the unit an agent writes. Each side becomes a list of changed line ranges, and a
 * range only ever has to agree with the ranges it actually overlaps. Everywhere else
 * both are applied to the base. This is what lets an agent that rewrote two tables
 * in one write keep both of them: a single span from the first table to the second
 * would cover the person's typing in between and be refused outright.
 *
 * Ranges that do overlap are settled between themselves, and settling one costs
 * nothing anywhere else. That is the difference that matters in practice, because an
 * agent writing a file it read a moment ago is stale on the line being typed and
 * current everywhere else: all-or-nothing threw away the whole write for the sake of
 * the one line, which is the case this is really for. Inside an overlap the finer
 * character merge is tried first, so two edits to different cells of one row still
 * come together. When even that has no answer the person at the keyboard keeps
 * theirs, those lines of the other change are dropped, and `dropped` says so.
 *
 * Every text here is in one set of line endings. The caller converts first.
 */
/**
 * How many times each line appears in a text.
 *
 * Counted rather than compared as a set, because how many copies of a line there are is
 * the thing at issue: a table with two identical rows is a table a person may well have
 * written, and a table with one row that the merge turned into two is not.
 */
function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/**
 * True when the merged text holds a line more often than both changes together asked for.
 *
 * Each side's change is a delta on the base, so applying both should leave a line appearing
 * `mine + theirs - base` times: what was there, plus what each side added, minus what each
 * side took away. More than that is a copy neither side wrote, and it is a copy of something
 * already in the document, which is the shape a line merge produces when one side moves a
 * line and the other edits near it. The mover's line is inserted in its new place while the
 * edit keeps it in its old one, and the file ends with the row twice.
 *
 * Only lines that were in the base are counted, and that limit is the whole of what makes
 * this safe rather than a second bug. The character merge exists to build a line that is in
 * neither side: `| Login | Open | Sammy |` and `| Login | Done | Sam |` come together as
 * `| Login | Done | Sammy |`, which appears nowhere else and would look like an invention to
 * any rule that did not ask where it came from. What is never right is another copy of a
 * line the document already had.
 *
 * Blank lines are left out. A duplicated blank is not the harm here, and the spacing around
 * a block is exactly where both sides legitimately add one.
 *
 * Counting is the check rather than understanding the move, because a line-based merge has
 * no notion of a move, and teaching it one is a much larger change than refusing the answers
 * that are visibly wrong.
 */
function multipliesALine(together: string, base: string, mine: string, theirs: string): boolean {
  const was = lineCounts(base);
  const got = lineCounts(together);
  const ours = lineCounts(mine);
  const other = lineCounts(theirs);
  for (const [line, n] of got) {
    if (!line.trim()) continue;
    const before = was.get(line) ?? 0;
    if (before === 0) continue;
    const asked = (ours.get(line) ?? 0) + (other.get(line) ?? 0) - before;
    if (n > Math.max(asked, 0)) return true;
  }
  return false;
}

export function mergeOutsideChange(base: string, mine: string, theirs: string): Merged {
  const settled = mergeLines(base, mine, theirs);
  /*
   * A merge that invents a line is refused outright, and the person keeps theirs.
   *
   * This is the rule `mergeSpans` states for characters, applied to the whole answer:
   * refusing a merge loses a change that can be made again, while a wrong merge writes
   * something nobody wrote. A duplicated line is the worst version of that, because the
   * file is the store and a row that appears twice is content with no author. Reported as
   * dropped, so it is said out loud rather than left to be noticed in a diff.
   */
  if (multipliesALine(settled.text, base, mine, theirs)) {
    return { text: mine, dropped: true };
  }
  return settled;
}

function mergeLines(base: string, mine: string, theirs: string): Merged {
  if (theirs === base) return { text: mine, dropped: false };
  if (mine === base) return { text: theirs, dropped: false };
  if (mine === theirs) return { text: mine, dropped: false };
  const baseLines = base.split('\n');
  const ours = lineHunks(baseLines, mine.split('\n'));
  const other = lineHunks(baseLines, theirs.split('\n'));
  if (!ours || !other) {
    // Too much of it differs to compare line by line, so the whole texts are all
    // there is to go on.
    const spans = mergeSpans(base, mine, theirs);
    return spans === null ? { text: mine, dropped: true } : { text: spans, dropped: false };
  }
  /*
   * Every changed range from both sides in order, so a run of them that overlaps can
   * be taken together. An insertion goes ahead of a rewrite that starts at the same
   * line: the new lines land before the rewritten ones, which is an order rather
   * than a guess, and it is the only thing to decide between two changes that share
   * a line without either covering any of the other's.
   */
  const ranges = [
    ...ours.map((hunk) => ({ hunk, mine: true })),
    ...other.map((hunk) => ({ hunk, mine: false })),
  ].sort((a, b) => a.hunk.start - b.hunk.start || a.hunk.end - b.hunk.end);
  const together: string[] = [];
  let at = 0;
  let dropped = false;
  for (let i = 0; i < ranges.length; ) {
    // As far as this run of overlapping ranges reaches. Two ranges from one side
    // never overlap, so a run of more than one always holds both sides.
    let end = ranges[i].hunk.end;
    let next = i + 1;
    while (next < ranges.length && ranges[next].hunk.start < end) {
      end = Math.max(end, ranges[next].hunk.end);
      next++;
    }
    const run = ranges.slice(i, next);
    const start = run[0].hunk.start;
    together.push(...baseLines.slice(at, start));
    if (run.length === 1) {
      together.push(...run[0].hunk.lines);
    } else {
      const region = baseLines.slice(start, end);
      const side = (isMine: boolean) =>
        applyHunks(region, run.filter((r) => r.mine === isMine).map((r) => r.hunk), start).join('\n');
      const settled = mergeSpans(region.join('\n'), side(true), side(false));
      if (settled === null) {
        together.push(...side(true).split('\n'));
        dropped = true;
      } else {
        together.push(...settled.split('\n'));
      }
    }
    at = end;
    i = next;
  }
  together.push(...baseLines.slice(at));
  return { text: together.join('\n'), dropped };
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
  // `\r?\n`, not `\n`: a replacement that already carries a carriage return would otherwise
  // come out as `\r\r\n`, one doubled return per line, and the conversion has to be safe to
  // run over text that is already in the document's endings.
  const replacement = crlf ? edit.replacement.replace(/\r?\n/g, '\r\n') : edit.replacement;
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
  /**
   * Give the webview a whole document, in the webview's line endings, replacing what
   * it holds. `tookTypedText` is true when that document drops something the person
   * typed a moment ago, which is what makes the change one their own Undo takes back.
   */
  setContent(text: string, tookTypedText?: boolean): void;
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

  /**
   * The document changed. Pushes it to the webview unless the webview is ahead, and
   * says whether it pushed, so the caller knows whether the webview has seen this
   * document yet.
   *
   * `tookTypedText` has no default on purpose, so a host that has not decided what to
   * say is a compile error rather than a quiet `false`. It had one, and the host behind
   * a browser tab took it: that host calls this with the text alone, so a write landing
   * from disk was never marked as taking anything, and the editor annotated the change
   * as somebody else's ordinary edit. The protection on the other side of that default
   * is `RecentTyping`, which imports nothing but this file and would run in either host
   * unchanged, so what the second host was missing was the call rather than the means.
   */
  public documentChanged(text: string, tookTypedText: boolean): boolean {
    if (this.draining) {
      // Mid-burst: this is either the echo of an edit of our own or an outside
      // write the burst is about to be planned against. `drain` posts whatever
      // the document ends up holding, so nothing older than that goes out now.
      return false;
    }
    if (text === this.syncedText) {
      return false;
    }
    this.syncedText = text;
    this.host.setContent(toWebviewText(text), tookTypedText);
    return true;
  }

  private async drain(): Promise<void> {
    let replans = 0;
    let abandoned = false;
    // True once somebody else's change has been put together with the person's. The
    // webview sent the text it was holding and never saw that change, so it has to
    // be given the result even though the document now holds exactly what was asked
    // for: otherwise the file is right and the page is a version behind.
    let merged = false;
    while (this.pendingText !== undefined) {
      const text = this.pendingText;
      this.pendingText = undefined;
      /*
       * What the webview sent was written against the document as it stood when it
       * read it. If the document has moved since, from an agent, a formatter or a
       * pull, planning the webview's text straight onto it takes that change back
       * out: the webview never saw it, so its text does not carry it.
       *
       * So the two are put together first, and what is planned is the person's own
       * change made to the document as it now reads. Where they changed the same
       * characters there is nothing to put together and the person at the keyboard
       * keeps theirs, which is what used to happen to every outside change. Nothing
       * says so yet; that notice is still to be written, and so is the VS Code half
       * of this, where the document never learns the file moved at all.
       *
       * `syncedText` is the last text the two sides agreed on, which is exactly the
       * base such a merge needs. It is set every time an edit lands and every time a
       * document is posted, so it tracks the agreement rather than the document.
       */
      const shownNow = toWebviewText(this.host.getText());
      const shownBase = toWebviewText(this.syncedText);
      let want = text;
      if (shownNow !== shownBase) {
        // The webview is behind either way: it is holding text that predates the
        // other change, whether all of that change was kept or only the part of it
        // clear of what the person was typing.
        merged = true;
        want = mergeOutsideChange(shownBase, text, shownNow).text;
      }
      const plan = planEdit(this.host.getText(), want, this.host.crlf());
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
        // Planned again against whatever the document moved to, and the top of this
        // loop is where that move is put together with what the person sent.
        this.pendingText = text;
      } else {
        abandoned = true;
      }
    }
    const text = this.host.getText();
    if (abandoned || merged || text !== this.syncedText) {
      this.syncedText = text;
      this.host.setContent(toWebviewText(text));
    }
  }
}
