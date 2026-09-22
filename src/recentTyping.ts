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
 * The webview's recent edits, and what an incoming document takes back of them.
 *
 * Every edit is recorded as the text that came before it, so the oldest one still
 * inside the window is the baseline: everything between it and what the webview holds
 * now was typed by the person, within the window. Nothing else counts as theirs.
 */
export class RecentTyping {
  private readonly keystrokes: Keystroke[] = [];

  constructor(
    private readonly windowMs: number = RECENT_TYPING_MS,
    private readonly clock: () => number = Date.now
  ) {}

  /** An edit the webview posted, with `was` the text it held before that edit. */
  public record(was: string): void {
    this.keystrokes.push({ at: this.clock(), was });
    this.prune();
  }

  /**
   * Forget everything recorded.
   *
   * Called once a document from outside has reached the webview: whatever was typed
   * is either in that document or gone, and either way it is no longer something a
   * later write can take away.
   */
  public forget(): void {
    this.keystrokes.length = 0;
  }

  /**
   * The one run of characters in `mine` that the person's own edits inside the window
   * put there, or undefined when they added nothing in it.
   *
   * It is one run because `minimalEdit` reports one: two edits in different places
   * come back as the single span that covers both, which is wider than what they
   * typed. That is the direction to be wrong in, because the span is only ever used
   * to narrow what an outside write is said to have taken.
   */
  public typed(mine: string): TypedRun | undefined {
    this.prune();
    const baseline = this.keystrokes[0]?.was;
    if (baseline === undefined) {
      return undefined;
    }
    const { start, replacement } = minimalEdit(baseline, mine);
    return replacement ? { start, text: replacement } : undefined;
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
    const run = this.typed(mine);
    if (!run) {
      return undefined;
    }
    const took = minimalEdit(mine, incoming);
    const from = Math.max(run.start, took.start);
    const to = Math.min(run.start + run.text.length, took.end);
    if (to <= from) {
      return undefined;
    }
    const lost = mine.slice(from, to);
    return lost.trim() === '' ? undefined : lost;
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
  return `Sheaf: this file changed outside the editor, and your last change is gone: "${quoteLost(lost)}". Undo brings it back.`;
}

/** What Sheaf says when a write from outside puts back text the person had just removed. */
export function noticeAboutRestoredText(back: string): string {
  return `Sheaf: this file changed outside the editor, and put back what you just removed: "${quoteLost(back)}". Undo removes it again.`;
}
