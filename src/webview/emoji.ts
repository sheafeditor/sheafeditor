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

import { EditorView } from '@codemirror/view';
import { lazyResource } from './lazyResource';

type Pairs = string;

/**
 * The lookup built from the packed table, rebuilt whenever a new table arrives.
 *
 * Kept here rather than inside the resource because it is this module's own view of the value: the
 * resource holds 47 KB of `name char` lines and the lookup is what `emojiFor` reads. `onReset`
 * below is what keeps the two from disagreeing.
 */
let table: Map<string, string> | null = null;

const resource = lazyResource<Pairs>({
  name: 'emoji',
  readyName: 'emojiReady',
  getName: 'emojiFor',
  load: async () => (await import('./emojiTable.js')).EMOJI_PAIRS,
  onReset: () => {
    table = null;
  },
});

/**
 * Hand the table over directly, so nothing is fetched.
 *
 * For a consumer that already has the shortcode names, or ships its own, and for a check that mounts
 * and asserts in the same breath and so cannot wait for a fetch. It **replaces** the built-in table
 * rather than merging with it, so a consumer supplying ten names gets ten.
 */
export function provideEmoji(given: Pairs): void {
  resource.provide(given);
}

/**
 * Replace the fetch with one of your own.
 *
 * For a consumer whose page will not allow the built-in dynamic import, and for a check that wants
 * to drive the failure paths. Deliberately leaves the record that this document holds a shortcode
 * alone, since replacing the loader does not change that.
 */
export function setEmojiLoader(loader: () => Promise<Pairs>): void {
  resource.setLoader(loader);
}

/** Whether a shortcode can be looked up yet. Callers ask this before `emojiFor`. */
export function emojiReady(): boolean {
  return resource.ready();
}

/**
 * Whether the table is not coming: every attempt was made and every one failed.
 *
 * **Three states rather than two, because a caller that can only ask `emojiReady()` cannot tell a
 * shortcode that is still loading from one that will never draw**, and those want different
 * answers on screen. Both false together mean in flight, or not yet asked for. This exists so that
 * distinction is available at all; what to *draw* in the lost case is not decided here.
 */
export function emojiLost(): boolean {
  return resource.lost();
}

/** Dispatched once the table has arrived, so the decorations that draw emoji rebuild. */
export const emojiLoaded = resource.arrived;

/** Record that a document holds a shortcode, from a builder that has no view to dispatch with. */
export function requestEmoji(): void {
  resource.request();
}

/**
 * Start fetching the table, and redraw when it lands. Safe to call on every pass; see
 * `lazyResource.ts` for what makes it so, and for why a failure is tried again a bounded number of
 * times rather than never or for ever.
 */
export function loadEmoji(view: EditorView): void {
  resource.load(view);
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
  // Throws when the table is absent, which is the contract `emojiReady()` exists to let a caller
  // satisfy. The lookup is built on first use and forgotten whenever a new table arrives.
  const pairs = resource.get();
  if (!table) {
    table = new Map();
    for (const pair of pairs.split('\n')) {
      const space = pair.indexOf(' ');
      if (space > 0) table.set(pair.slice(0, space), pair.slice(space + 1));
    }
  }
  return table.get(name);
}
