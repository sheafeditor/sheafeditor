/*
 * Something the editor fetches after it is already running, in one place.
 *
 * Two constructs need a dependency only once a document turns out to hold one: a `:shortcode:` needs
 * a 47 KB table of names, and an equation needs KaTeX. Neither is worth putting in front of every
 * reader, so both sit behind `await import(...)` and are pulled when first wanted, which costs 228
 * and 636 eager bytes instead of 47 KB and 76 KB.
 *
 * **Both were written out by hand and the second was copied from the first, so the same defect was
 * in both.** The rejection handler was `() => undefined` and the in-flight marker was left holding a
 * settled promise, which the guard reads as a fetch still out, so one transient failure meant that
 * editor never drew an emoji or an equation again for the life of the session, with nothing logged.
 * Fixing it meant finding it twice. This exists so the next lazy dependency inherits the answer
 * rather than copying whichever of the two files it happens to open.
 *
 * ## The five states, because the obvious two are not enough
 *
 * A caller that can only ask "is it here" cannot tell a shortcode still loading from one that will
 * never draw, and those want different answers on screen. So:
 *
 *   not wanted     no document has asked for it; no fetch has been made
 *   wanted         a document holds one, and the next view pass will start the fetch
 *   in flight      a fetch is out
 *   here           `ready()` is true and `get()` answers
 *   lost           every attempt failed; `lost()` is true and nothing more will be tried
 *
 * `ready()` and `lost()` are both false for the first three, which a caller reads as "not yet".
 *
 * ## Two halves of the request, on opposite sides of CodeMirror's own boundary
 *
 * `request()` records that a document holds the construct, and `load(view)` acts on it. They are
 * separate because a `StateField` is given a state and may not dispatch, while a view plugin is
 * given a view and may: the state side records the need and the view side starts the fetch and
 * dispatches the redraw. Neither has to pretend to be the other.
 *
 * ## Why the attempt cap is a small number rather than one or none
 *
 * `load(view)` is called from a view plugin's `update`, which runs on every transaction. So clearing
 * the marker with no cap is one request per keystroke on a page whose policy blocks the chunk, and
 * `maths.ts` carried a comment choosing permanence for exactly that reason. That reasoning was right
 * about what it weighed and did not weigh the cost of one flake. A cap of three is neither: a flake
 * recovers on the next pass, a blocked chunk is asked three times and then left alone.
 */

import { StateEffect, StateEffectType } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** How many times a failed fetch is started again before the resource is called lost. */
export const ATTEMPTS = 3;

export interface LazyResource<T> {
  /**
   * Dispatched once the value has arrived, so whatever draws with it rebuilds. One per resource, so
   * a field watching for maths is not woken by the emoji table landing.
   */
  readonly arrived: StateEffectType<null>;
  /** Hand the value over directly, already loaded. For a consumer that has it, and for a check that mounts and asserts in one breath. */
  provide(value: T): void;
  /** Replace the fetch. For a consumer with its own way of getting the value, and for a check that wants to drive it. */
  setLoader(loader: () => Promise<T>): void;
  /** Whether the value can be read yet. Callers ask this before `get`. */
  ready(): boolean;
  /** Whether the value is not coming: every attempt was made and every one failed. */
  lost(): boolean;
  /** Say that this document needs it, from a builder that has no view to dispatch with. */
  request(): void;
  /** Start the fetch if it is wanted, not here, not out, and not given up on. Safe on every pass. */
  load(view: EditorView): void;
  /** The value. Throws when it is absent, because every value this could return instead is one a caller would act on. */
  get(): T;
}

/**
 * `name` appears in the error `get` throws and nowhere else, so it reads as the resource a caller
 * actually asked for rather than as a generic failure. `readyName` and `getName` are the exported
 * spellings in that resource's own module, so the message names the function to call rather than
 * this file's private one.
 */
export function lazyResource<T>(spec: {
  name: string;
  readyName: string;
  getName: string;
  load: () => Promise<T>;
  /** Run when a value arrives or is provided, for a resource with a cache keyed on it. */
  onReset?: () => void;
}): LazyResource<T> {
  let value: T | null = null;
  let pending: Promise<void> | null = null;
  let wanted = false;
  let attempts = 0;
  let load = spec.load;
  const arrived = StateEffect.define<null>();

  const reset = (): void => {
    pending = null;
    attempts = 0;
    spec.onReset?.();
  };

  return {
    arrived,
    provide(given) {
      value = given;
      reset();
    },
    setLoader(loader) {
      load = loader;
      value = null;
      // The attempt count goes with it. A check that drove a loader to exhaustion would otherwise
      // leave the next one unable to fetch at all, and it would read as the new loader never being
      // called. `wanted` deliberately stays: it records that this document holds the construct,
      // which replacing the loader does not change.
      reset();
    },
    ready() {
      return value !== null;
    },
    lost() {
      return value === null && pending === null && attempts >= ATTEMPTS;
    },
    request() {
      wanted = true;
    },
    load(view) {
      if (!wanted || value !== null || pending || attempts >= ATTEMPTS) return;
      attempts++;
      pending = load().then(
        (loaded) => {
          value = loaded;
          pending = null;
          view.dispatch({ effects: arrived.of(null) });
        },
        // Cleared rather than discarded: a settled promise is still a promise, so leaving it here is
        // what made one failure permanent. The error itself is not kept, because `lost()` is the
        // fact a caller acts on and no caller has anything to do with the reason.
        () => {
          pending = null;
        }
      );
    },
    get() {
      if (value === null) {
        throw new Error(`${spec.name}: not loaded. Ask ${spec.readyName}() before ${spec.getName}().`);
      }
      return value;
    },
  };
}
