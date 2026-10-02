/**
 * What the person changed in the last few seconds, and what a document arriving from
 * outside took back of it.
 *
 * Typing is the usual way it gets there, and the one the race is named for, but any
 * edit the webview posts counts: an inserted row and a sorted column are the person's
 * work too, and a write from outside takes them back the same way.
 *
 * Sheaf's editor is meant to be open on a file something else is also writing, so the
 * losing race is ordinary: somebody types, auto-save puts it on disk a second later,
 * and a tool writes the whole file from text it read before that. The outside write
 * wins, which is what any editor does with a file that changed underneath it. What is
 * missing without this is any sign that it cost the person something.
 *
 * Both halves of the comparison are already in the host's hands at that moment: the
 * text the webview holds, and the text that has just arrived. This keeps the third
 * piece, which is which parts of the webview's text the person put there themselves
 * and how long ago, so a write that lands nowhere near their caret stays silent.
 */

import { minimalEdit } from './textSync';

/**
 * How long a keystroke goes on counting as something the person just typed.
 *
 * A starting value, chosen to cover the gap the race lives in: an edit reaches the
 * document at once, auto-save writes it about a second later, and a tool that read
 * the file before that writes it back some seconds after. Long enough to catch that,
 * short enough that a paragraph written a minute ago and then edited by a teammate
 * says nothing.
 */
export const RECENT_TYPING_MS = 10_000;

/** A run of characters the person's own recent edits put into the text. */
export interface TypedRun {
  /** Where the run starts, in the text the webview holds. */
  start: number;
  /** The characters themselves. */
  text: string;
}

/** The state `RecentTyping` keeps: the webview's text before each edit in the window. */
interface Keystroke {
  at: number;
  /** What the webview held before that edit, which is the baseline to compare against. */
  was: string;
}

/**
 * One region of the current text that one of the person's edits put there.
 *
 * Held in the coordinates of the text as it stands after the most recent recorded edit, and moved
 * along by each later edit, because that is the text an incoming write is compared against.
 */
interface OwnRun {
  at: number;
  start: number;
  end: number;
}

/**
 * The same runs, in the coordinates of `now` instead of `was`.
 *
 * Everything before the change keeps its offsets and everything after it moves by the change's own
 * difference in length. A run the change lands inside is split, keeping the parts outside it: those
 * characters are still the person's and still there.
 *
 * **No run is added for the change itself**, and that is the whole point of the function. It is used
 * for changes that are not the person's: a save participant trimming another line, or a write from
 * outside that reached the webview. Their text is not theirs to lose, and the old code's mistake was
 * exactly to count it.
 */
function carried(runs: readonly OwnRun[], was: string, now: string): OwnRun[] {
  if (was === now) return [...runs];
  const { start, end, replacement } = minimalEdit(was, now);
  const delta = replacement.length - (end - start);
  const out: OwnRun[] = [];
  for (const r of runs) {
    if (r.end <= start) out.push(r);
    else if (r.start >= end) out.push({ at: r.at, start: r.start + delta, end: r.end + delta });
    else {
      if (r.start < start) out.push({ at: r.at, start: r.start, end: start });
      if (r.end > end) out.push({ at: r.at, start: end + delta, end: r.end + delta });
    }
  }
  return out;
}

/**
 * The webview's recent edits, and what an incoming document takes back of them.
 *
 * Every edit is recorded as the text that came before it, so the oldest one still
 * inside the window is the baseline: everything between it and what the webview holds
 * now was typed by the person, within the window. Nothing else counts as theirs.
 */
export class RecentTyping {
  private readonly keystrokes: Keystroke[] = [];
  /**
   * The regions of the current text the person's own edits put there.
   *
   * Kept alongside `keystrokes` rather than derived from them, because the two answer different
   * questions and only one of them can be answered by a diff. `restored` asks what the window
   * removed, which a baseline comparison gives correctly. `dropped` asks which characters are the
   * person's, and no comparison of two texts can say who changed them: see `typed`.
   */
  private runs: OwnRun[] = [];
  /**
   * The text as it stood after the most recent recorded edit.
   *
   * `runs` are offsets into this, so a caller asking about a different text is asking about one
   * whose edits were not all recorded, and the offsets do not describe it.
   */
  private lastText: string | undefined;

  constructor(
    private readonly windowMs: number = RECENT_TYPING_MS,
    private readonly clock: () => number = Date.now
  ) {}

  /**
   * An edit the webview posted: `was` the text it held before, `now` the text it holds after.
   *
   * `now` is needed because the span of an edit can only be known when it happens. It used to
   * take `was` alone and work the span out later by comparing the oldest baseline against the
   * current text, which cannot tell the person's edits from anybody else's: see `typed`.
   */
  public record(was: string, now: string): void {
    const at = this.clock();
    this.keystrokes.push({ at, was });
    /*
     * Two steps, because two different things can have happened since the last recorded edit.
     *
     * First the text may have moved without anybody recording it: a save participant trimming
     * another line, or a change from outside that reached the webview. Those are not the person's,
     * so their runs are carried through and no run is added for them.
     *
     * Then this edit, which is the person's, so its span becomes a run.
     */
    const base = this.lastText === undefined ? this.runs : carried(this.runs, this.lastText, was);
    const next = carried(base, was, now);
    const { start, replacement } = minimalEdit(was, now);
    // An edit that only removes text adds no run: there is nothing of the person's in the result
    // to lose. `restored` is what reports a deletion being undone from outside.
    if (replacement.length > 0) next.push({ at, start, end: start + replacement.length });
    this.runs = next.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
    this.lastText = now;
    this.prune();
  }

  /**
   * Forget everything recorded.
   *
   * Called once a document from outside has reached the webview: whatever was typed
   * is either in that document or gone, and either way it is no longer something a
   * later write can take away.
   */
  /**
   * The text as it stood before the person's oldest edit still inside the window.
   *
   * The base a three-way merge needs, and the one thing here that is about putting work back rather
   * than reporting it gone. A write from outside is measured against what the person started from,
   * not against what the file last held: told the latter, `mergeOutsideChange` sees `mine === base`,
   * concludes they have nothing pending, and takes the write whole. That is how a letter already
   * saved to disk is removed by a write that never touched its line.
   */
  public baseline(): string | undefined {
    this.prune();
    return this.keystrokes[0]?.was;
  }

  public forget(): void {
    this.keystrokes.length = 0;
    this.runs = [];
    this.lastText = undefined;
  }

  /**
   * The runs of characters in `mine` that the person's own edits inside the window put there, in
   * order, or an empty list when they added nothing in it.
   *
   * **Several runs, because there are several, and the one that used to be returned was not the
   * person's.** This compared the oldest baseline in the window against `mine` and called the whole
   * difference theirs. Its own comment said the span was wider than what they typed and argued the
   * direction was safe, "because the span is only ever used to narrow what an outside write is said
   * to have taken". Two things read it, and that sentence is true of one of them.
   *
   * It is false of the decision. A wider run overlaps an incoming write more readily, so it reports
   * a loss where there is none: the notice that names text still sitting in the document.
   *
   * It is false of the quote. The slice handed to the notice comes out of the same span, so
   * whatever the span wrongly contains is read back to the person as the work they just lost.
   * Measured at 287 characters of somebody else's document, twelve paragraphs of it, in a case where
   * something really had taken their letter and the notice was right to appear.
   *
   * Two edits in different places are enough on their own: type at the top of a document and then
   * at the bottom, and the span between them is the whole document. Worse, a change that arrived
   * from outside and reached the webview is inside that span too, and no comparison of two texts
   * can say who made it. That is why the spans are recorded when each edit happens rather than
   * worked out afterwards.
   *
   * An empty list is also the answer when `mine` is not the text the last recorded edit produced,
   * because then an edit reached the webview without being recorded and these offsets describe a
   * different text. Saying nothing is the only honest answer there: the alternative is naming
   * characters by position in a text they do not belong to, which is the defect above.
   *
   * **Control log.** Putting the baseline comparison back makes four checks in the sync suite fail
   * and leaves the fifth passing, which is the one that is supposed to pass either way: with only
   * the person's own edit in the window both answer exactly what they typed, so the quoting was
   * never the broken part.
   *
   * Three of those four only discriminate because the control said so, and each correction is a
   * trap worth knowing. A write that *takes one of the typed letters* gives the right answer out of
   * the wrong span, because the intersection rescues it. A write that *inserts* into the gap between
   * two edits overlaps nothing whatever the span is, since a pure insertion has `start === end` and
   * removes nothing from the current text. And a window where the outside change arrives *before*
   * the person's only recorded edit leaves the baseline already holding it, so a baseline comparison
   * answers correctly too. Only a replacement, inside the gap, after an earlier recorded edit, tells
   * the two implementations apart.
   */
  public typed(mine: string): TypedRun[] {
    this.prune();
    if (this.lastText === undefined) {
      return [];
    }
    /*
     * Carried into `mine`'s coordinates when it is not the text the last recorded edit produced.
     *
     * Refusing to answer was tried first and it silenced a real notice. A save participant trimming
     * a trailing space on a line the person is not typing on reaches the webview without being
     * recorded, so `mine` differs from the last recorded text by one character, and a write that
     * then really takes their letter has to be reported. The host suite caught it, which is what
     * `tables.outside-merge.e06` and that check are there for: the risk in narrowing this is
     * silencing the conflict that matters.
     */
    const runs = carried(this.runs, this.lastText, mine);
    return runs.map((r) => ({ start: r.start, text: mine.slice(r.start, r.end) })).filter((r) => r.text !== '');
  }

  /**
   * The characters `incoming` takes back of what the person just typed, or undefined
   * when it takes none of them.
   *
   * Both texts are in the webview's line endings. The incoming document is compared
   * against the webview's as one changed region, the same way every other comparison
   * between the two is made, and what overlaps the run the person typed is what they
   * are about to lose. A write that changes a part of the file they never touched
   * overlaps nothing and comes back undefined.
   *
   * Whitespace alone is never reported. Trailing whitespace is trimmed and restored
   * by save participants and by other editors often enough that a notice about it
   * would be noise, and there is a separate path that keeps the line being typed on.
   */
  public dropped(mine: string, incoming: string): string | undefined {
    const runs = this.typed(mine);
    if (runs.length === 0) {
      return undefined;
    }
    const took = minimalEdit(mine, incoming);
    /*
     * Every run the write reaches, and only the parts of them it reaches.
     *
     * Each run is intersected with the changed region separately. Taking the outer bounds of the
     * runs instead and intersecting once would put the gaps between them back into the answer,
     * which is the whole of the defect described on `typed`.
     *
     * The pieces are joined with an ellipsis because they are not adjacent in the document and
     * running them together would read as one phrase the person never wrote. `quoteLost` collapses
     * whitespace and the ellipsis survives it, so the notice shows that something sits between.
     */
    const pieces: string[] = [];
    for (const run of runs) {
      const from = Math.max(run.start, took.start);
      const to = Math.min(run.start + run.text.length, took.end);
      if (to > from) pieces.push(mine.slice(from, to));
    }
    if (pieces.length === 0) {
      return undefined;
    }
    const lost = pieces.join(' … ');
    return lost.replace(/…/g, '').trim() === '' ? undefined : lost;
  }

  /**
   * What `incoming` puts back of text the person just removed, or undefined when it
   * puts nothing back.
   *
   * The other half of `dropped`. A write made from a copy read before a delete brings
   * the deleted text back, and to the person that is their edit undone as surely as
   * losing their typing is: a row they took out of a table is simply there again. Only
   * a window of pure deletion counts, one where the person took text out and put
   * nothing in its place, because a mix of both is already reported as typing. What is
   * returned is what the write put at the point of the delete, which is what the person
   * will see come back.
   */
  public restored(mine: string, incoming: string): string | undefined {
    this.prune();
    const baseline = this.keystrokes[0]?.was;
    if (baseline === undefined) {
      return undefined;
    }
    const removal = minimalEdit(baseline, mine);
    if (removal.replacement !== '' || removal.end === removal.start) {
      return undefined;
    }
    const removed = baseline.slice(removal.start, removal.end).trim();
    if (removed === '') {
      return undefined;
    }
    // Counted rather than located: where two texts differ is ambiguous when the text
    // around the delete repeats, and a count is not. The write brings the deleted text
    // back when it holds more of it than the person's text now does.
    const count = (text: string): number => text.split(removed).length - 1;
    return count(incoming) > count(mine) ? removed : undefined;
  }

  /** Drop everything that has fallen out of the window. */
  private prune(): void {
    const cutoff = this.clock() - this.windowMs;
    while (this.keystrokes.length > 0 && this.keystrokes[0].at < cutoff) {
      this.keystrokes.shift();
    }
    // The runs as well, and forgetting this is what the window check caught: text typed a minute
    // ago is not something a write can take back, and a run that outlives its own keystroke says
    // it is. `filter` rather than `shift`, because runs are held in document order and the oldest
    // one is not necessarily first.
    if (this.runs.some((r) => r.at < cutoff)) {
      this.runs = this.runs.filter((r) => r.at >= cutoff);
    }
  }
}

/** How much of the lost text a notice quotes before it stops. */
const QUOTE_LIMIT = 60;

/**
 * The lost text as a notice can show it: one line, and short enough to read at a
 * glance. A whole paragraph in a notification is unreadable, and the point of the
 * quote is recognition rather than the text itself, which Undo brings back.
 */
export function quoteLost(lost: string): string {
  const oneLine = lost.replace(/\s+/g, ' ').trim();
  return oneLine.length > QUOTE_LIMIT ? `${oneLine.slice(0, QUOTE_LIMIT)}…` : oneLine;
}

/**
 * What Sheaf says to someone whose work has just been overwritten.
 *
 * They have lost work and do not yet know it, so the first thing said is what
 * happened, then what was taken, then the one key that brings it back.
 *
 * "Your last change" rather than "what you just typed", because typing is not the
 * only way text gets into a document. Inserting a row and sorting a column are edits
 * a write from outside takes back just as easily, and a person who has just sorted a
 * table is not helped by being told their typing is gone.
 */
export function noticeAboutLostText(lost: string): string {
  /*
   * A quote is worth showing only when there is something in it to recognise.
   *
   * A change that is not typing has no words of its own: inserting a row loses
   * `"  |   |\n| "`, which is two spaces, three pipes and a newline, and reading that back
   * to somebody tells them nothing about what went. Sorting a column and deleting a row are
   * the same. So a loss with no letter or digit in it is reported as a change rather than
   * quoted, and the sentence still carries the two things that matter: something is gone,
   * and Undo brings it back.
   */
  const quoted = quoteLost(lost);
  if (!/[\p{L}\p{N}]/u.test(quoted)) {
    return 'Sheaf: this file changed outside the editor, and your last change is gone. Undo brings it back.';
  }
  return `Sheaf: this file changed outside the editor, and your last change is gone: "${quoted}". Undo brings it back.`;
}

/**
 * What Sheaf says when a change written to the file cannot be kept.
 *
 * The other side of the race. Here it is the outside change that loses: somebody
 * else wrote the file at the same characters the person was typing in, and there is
 * no answer to what the two together would say, so the person at the keyboard keeps
 * theirs. They are about to save over that change without knowing it exists, and the
 * file's own history is where it still is, so that is what they are pointed at.
 */
export function noticeAboutOutsideChangeLost(): string {
  return 'Sheaf: something wrote to this file where you were typing, and your text was kept. The change that was written is in your file history, not in the document.';
}

/** What Sheaf says when a write from outside puts back text the person had just removed. */
export function noticeAboutRestoredText(back: string): string {
  return `Sheaf: this file changed outside the editor, and put back what you just removed: "${quoteLost(back)}". Undo removes it again.`;
}
