/*
 * What an emoji shortcode draws as: the lookup, and the fetch that brings it.
 *
 * The parser rule that finds `:name:` is in `../dialect/emoji` and reads none of this. The split is
 * about weight: `emojiTable.ts` is 47 KB of generated data, and while it sat beside the grammar
 * every profile that parses Markdown carried it, including a render path that draws no emoji and a
 * one-line field whose feature list has none.
 *
 * **Readiness is asked separately rather than folded into `emojiFor`'s answer**, for the same
 * reason as `mathsReady`. `undefined` from `emojiFor` already means something precise and
 * permanent: github.com does not draw that name either, so the text stays as typed. A second
 * meaning of "ask again later" in the same return value is a fact about the clock wearing the
 * costume of a fact about the name, and the caller cannot tell them apart. The visible result would
 * be a shortcode that renders as plain text for the rest of the session with the fetch having
 * worked perfectly.
 */

import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

type Pairs = string;

let pairs: Pairs | null = null;
let table: Map<string, string> | null = null;
let pending: Promise<void> | null = null;
let wanted = false;
let attempts = 0;
let load: () => Promise<Pairs> = async () => (await import('./emojiTable.js')).EMOJI_PAIRS;

/**
 * How many times a failed fetch is started again before the table is called lost.
 *
 * **Three rather than one, and three rather than unbounded, and both halves of that have a
 * reason.** It used to be one: the rejection was discarded and `pending` left set, so the guard in
 * `loadEmoji` read a settled promise as one in flight and returned early for the life of the
 * editor. A single transient failure of the chunk load meant that editor never drew an emoji
 * again, in a browser tab and in VS Code alike, with no console error because the handler was
 * `() => undefined`.
 *
 * Unbounded is the other failure and it is the one the first version was avoiding. `loadEmoji` is
 * called from the view plugin's `update`, which runs on every transaction, so clearing `pending`
 * with no cap turns a page whose policy blocks the chunk into one request per keystroke.
 *
 * A small cap gets both: a flake recovers on the next update, and a blocked chunk is asked for
 * three times and then left alone with `emojiLost()` true.
 */
const ATTEMPTS = 3;

/**
 * Hand the table over directly, for a check that mounts and asserts in the same breath and so
 * cannot wait for a fetch. The shipping path never calls this.
 */
export function provideEmoji(given: Pairs): void {
  pairs = given;
  table = null;
  pending = null;
  attempts = 0;
}

/** Replace the fetch, for a check that wants to drive it. Deliberately leaves `wanted` alone. */
export function setEmojiLoader(loader: () => Promise<Pairs>): void {
  load = loader;
  pairs = null;
  table = null;
  pending = null;
  // Including the attempt count, or a check that drove the loader to exhaustion would leave the
  // next one unable to fetch at all, and it would read as the new loader never being called.
  attempts = 0;
}

/** Whether a shortcode can be looked up yet. Callers ask this before `emojiFor`. */
export function emojiReady(): boolean {
  return pairs !== null;
}

/**
 * Whether the table is not coming: every attempt was made and every one failed.
 *
 * **Three states rather than two, because a caller that can only ask `emojiReady()` cannot tell a
 * shortcode that is still loading from one that will never draw**, and those want different
 * answers on screen. `emojiReady()` false and this false together mean in flight, or not yet asked
 * for. This exists so that distinction is available at all; what to *draw* in the lost case is not
 * decided here.
 */
export function emojiLost(): boolean {
  return pairs === null && pending === null && attempts >= ATTEMPTS;
}

/** Dispatched once the table has arrived, so the decorations that draw emoji rebuild. */
export const emojiLoaded = StateEffect.define<null>();

/** Record that a document holds a shortcode, from a builder that has no view to dispatch with. */
export function requestEmoji(): void {
  wanted = true;
}

/**
 * Start fetching the table, and redraw when it lands.
 *
 * Safe to call on every pass, which it is: one fetch is in flight at a time, a call with the table
 * already here does nothing, and a call after `ATTEMPTS` failures does nothing.
 *
 * **What this used to say was "the fetch happens once and later calls fall straight through", and
 * that sentence was true of success and was the defect in the failure case.** Falling straight
 * through after a rejection is exactly what must not happen, and it was written here as the
 * reassurance, so a reader checking the comment against the guard found them agreeing and moved on.
 */
export function loadEmoji(view: EditorView): void {
  if (!wanted || pairs || pending || attempts >= ATTEMPTS) return;
  attempts++;
  pending = load().then(
    (loaded) => {
      pairs = loaded;
      pending = null;
      view.dispatch({ effects: emojiLoaded.of(null) });
    },
    // Cleared rather than discarded: a settled promise is still a promise, so leaving it here is
    // what made one failure permanent. The error itself is not carried, because no caller has
    // anything to do with it and `emojiLost()` is the fact they act on.
    () => {
      pending = null;
    }
  );
}

/**
 * The character `:name:` stands for, or `undefined` for a name github.com does not draw either.
 *
 * `name` is the text between the colons; a caller holding the whole `:name:` span strips them first.
 * Ask `emojiReady()` first: this throws when the table is absent, rather than answering
 * `undefined`, because `undefined` is a permanent answer about the name and would be remembered as
 * one.
 */
export function emojiFor(name: string): string | undefined {
  if (!pairs) {
    throw new Error('emoji: the table is not loaded. Ask emojiReady() before emojiFor().');
  }
  if (!table) {
    table = new Map();
    for (const pair of pairs.split('\n')) {
      const space = pair.indexOf(' ');
      if (space > 0) table.set(pair.slice(0, space), pair.slice(space + 1));
    }
  }
  return table.get(name);
}
