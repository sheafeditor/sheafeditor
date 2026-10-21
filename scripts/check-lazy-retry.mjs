/*
 * A lazily fetched resource that fails once is fetched again, and one that will never arrive says so.
 *
 *   node scripts/check-lazy-retry.mjs
 *
 * Two modules fetch something after the editor is already running: `emoji.ts` pulls a 47 KB
 * shortcode table on first sight of a `:name:`, and `maths.ts` pulls KaTeX on first sight of an
 * equation. Both were written with the same shape, and the shape had the same defect in both: the
 * rejection handler was `() => undefined` and `pending` was left holding a settled promise, which
 * the guard reads as a fetch in flight. **One transient failure and that editor never drew an emoji
 * or an equation again, for the life of the session, with nothing logged.**
 *
 * ## Why this is a script rather than a scenario
 *
 * What is being checked is a state machine across several ticks, driven by a loader that fails on
 * purpose. The suites mount through `test/harness.ts`, which calls `provideEmoji` and `provideMaths`
 * so that a check which mounts and asserts in one breath has the table already — exactly the
 * opposite of what is needed here. And `setEmojiLoader` and `setMathsLoader` exist for this and were
 * driven by nothing before this file: two seams written "for a check" with no check.
 *
 * ## The control, and why the obvious one cannot fail
 *
 * **"Block the fetch, assert nothing draws" passes against the defect.** A blocked fetch drawing
 * nothing is correct in both versions. The bug is that an unblocked fetch *after* a blocked one also
 * draws nothing, so every case below that matters has **a second attempt that succeeds**, and the
 * assertion is on the second one.
 *
 * The loader counts its own calls, because "the table arrived" and "the loader was asked twice" are
 * different claims and only the second one distinguishes a retry from a first attempt that was slow.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

/** Load one module, bundled from source, with no DOM: neither reaches one on the paths driven here. */
async function load(file) {
  const { outputFiles } = await build({
    entryPoints: [join(REPO, 'src', 'webview', file)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    logLevel: 'error',
    absWorkingDir: REPO,
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const emoji = await load('emoji.ts');
const maths = await load('maths.ts');

/*
 * The two resources, behind one description, because the fault was identical in both and a check
 * that drove only one would leave the other's copy of it in the tree.
 *
 * `value` is what a successful load resolves to. The emoji table is a packed string; KaTeX is an
 * object with the one method `typeset` reaches, and neither is called here.
 */
const RESOURCES = [
  {
    name: 'emoji',
    m: emoji,
    setLoader: (l) => emoji.setEmojiLoader(l),
    provide: (v) => emoji.provideEmoji(v),
    request: () => emoji.requestEmoji(),
    attempt: (view) => emoji.loadEmoji(view),
    ready: () => emoji.emojiReady(),
    lost: () => emoji.emojiLost(),
    value: 'grinning 1F600',
    /*
     * Only this resource can answer "did a supplied value replace the built-in one or merge with
     * it", because only it has a lookup to ask. `:tada:` is in the generated table and is not in
     * the one supplied above, so a merge shows up as `tada` resolving.
     */
    replacement: {
      // The table a fetch brings, holding both names, and the one a consumer supplies, holding one.
      fetched: 'grinning 1F600\ntada 1F389',
      supplied: 'grinning 1F600',
      inBoth: 'grinning',
      fetchedOnly: 'tada',
      lookUp: (n) => emoji.emojiFor(n),
    },
  },
  {
    name: 'maths',
    m: maths,
    setLoader: (l) => maths.setMathsLoader(l),
    provide: (v) => maths.provideMaths(v),
    request: () => maths.requestMaths(),
    attempt: (view) => maths.loadMaths(view),
    ready: () => maths.mathsReady(),
    lost: () => maths.mathsLost(),
    value: { renderToString: () => '' },
  },
];

/** A stand-in for the view: `load*` uses it for one dispatch and nothing else. */
const viewStub = () => {
  const effects = [];
  return { effects, dispatch: (spec) => effects.push(spec) };
};

/** Let every queued microtask run, which is what a settled fetch needs to reach its handler. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const problems = [];
const say = [];

for (const r of RESOURCES) {
  /*
   * 1. One failure, then success. The case the defect survives.
   */
  {
    let calls = 0;
    r.setLoader(async () => {
      calls++;
      if (calls === 1) throw new Error('blocked');
      return r.value;
    });
    r.request();
    const view = viewStub();
    r.attempt(view);
    await settle();
    const afterFirst = { calls, ready: r.ready(), lost: r.lost() };
    r.attempt(view);
    await settle();
    const afterSecond = { calls, ready: r.ready(), lost: r.lost() };

    say.push(
      `  ${r.name}: after a failed attempt, loader called ${afterFirst.calls}x, ready ${afterFirst.ready}, lost ${afterFirst.lost}` +
        `; after the next attempt, loader called ${afterSecond.calls}x, ready ${afterSecond.ready}, lost ${afterSecond.lost}`
    );
    if (afterFirst.calls !== 1) problems.push(`${r.name}: the first attempt called the loader ${afterFirst.calls} times, expected 1`);
    if (afterFirst.ready) problems.push(`${r.name}: reported ready after a load that rejected`);
    if (afterFirst.lost) problems.push(`${r.name}: reported lost after one failure, with attempts left`);
    if (afterSecond.calls !== 2) {
      problems.push(
        `${r.name}: the attempt after a failure called the loader ${afterSecond.calls} times, expected 2.\n` +
          '    A rejection that leaves `pending` set reads as a fetch in flight, so nothing is tried again.'
      );
    }
    if (!afterSecond.ready) {
      problems.push(
        `${r.name}: not ready after an attempt that succeeded, so one failure is permanent.\n` +
          '    This is the whole of the defect: a blocked fetch drawing nothing is correct, and an\n' +
          '    unblocked fetch after it drawing nothing is not.'
      );
    }
    if (afterSecond.ready && view.effects.length !== 1) {
      problems.push(`${r.name}: the successful load dispatched ${view.effects.length} effect(s), expected 1, so nothing would redraw`);
    }
  }

  /*
   * 2. Always failing: bounded, and said out loud at the end.
   *
   * The cap is what keeps a page whose policy blocks the chunk from making one request per
   * keystroke, which is the reason the first version gave for never retrying at all. So the
   * assertion is on both halves: it stops, and it stops having told somebody.
   */
  {
    let calls = 0;
    r.setLoader(async () => {
      calls++;
      throw new Error('blocked');
    });
    r.request();
    const view = viewStub();
    // Ten passes, which is more than any sane cap: a view plugin's `update` runs on every keystroke.
    for (let i = 0; i < 10; i++) {
      r.attempt(view);
      await settle();
    }
    say.push(`  ${r.name}: a loader that always fails was called ${calls}x over 10 passes, ready ${r.ready()}, lost ${r.lost()}`);
    if (calls >= 10) {
      problems.push(
        `${r.name}: the loader was called ${calls} times over 10 passes, so a blocked fetch is retried per pass.\n` +
          '    That is one request per keystroke on a page whose policy blocks the chunk.'
      );
    }
    if (calls < 2) problems.push(`${r.name}: the loader was called ${calls} time(s), so nothing is retried at all`);
    if (r.ready()) problems.push(`${r.name}: reported ready with a loader that never resolved`);
    if (!r.lost()) {
      problems.push(
        `${r.name}: never reported lost, so a caller cannot tell "will not arrive" from "still coming".\n` +
          '    Those two want different answers on screen and this is the only place that knows.'
      );
    }
  }

  /*
   * 4. A value handed over directly, which is the seam a consumer uses when its page will not allow
   *    the fetch at all. Nothing should be fetched, and `provide` must **replace** the built-in
   *    value rather than merge with it.
   *
   * The merge half is the one worth having. A check that supplies a table and then asserts the
   * supplied name resolves passes either way, because the supplied name is present in both the
   * replaced and the merged table. What distinguishes them is a name that is in the built-in table
   * and **not** in the supplied one: under a replacement it is absent, under a merge it resolves.
   */
  {
    let calls = 0;
    r.setLoader(async () => {
      calls++;
      return r.value;
    });
    r.request();
    const view = viewStub();
    r.provide(r.value);
    r.attempt(view);
    await settle();
    say.push(`  ${r.name}: a value handed over directly gives ready ${r.ready()}, lost ${r.lost()}, loader called ${calls}x`);
    if (!r.ready()) problems.push(`${r.name}: not ready after the value was handed over directly`);
    if (r.lost()) problems.push(`${r.name}: reported lost after the value was handed over directly`);
    if (calls !== 0) problems.push(`${r.name}: fetched ${calls} time(s) with the value already supplied, which is the fetch a consumer supplied it to avoid`);

    if (r.replacement) {
      const { fetched, supplied, inBoth, fetchedOnly, lookUp } = r.replacement;
      /*
       * **A table has to be fetched and looked up *first*, and that is the precondition rather than
       * a flourish.** The first version of this case supplied a one-entry table into a module that
       * had never built a lookup, so the stale-lookup path was never reached: it reported a clean
       * replacement, and deleting the invalidation from `emoji.ts` left it still reporting one. The
       * assertion could not fail, which the control is what showed.
       *
       * So: fetch a two-name table, resolve a name to force the lookup to be built, then supply a
       * one-name table over the top. Now a module that forgets to invalidate answers from the old
       * lookup and `fetchedOnly` resolves.
       */
      r.setLoader(async () => fetched);
      const fetchView = viewStub();
      r.attempt(fetchView);
      await settle();
      const before = lookUp(fetchedOnly);

      r.provide(supplied);
      const after = { inBoth: lookUp(inBoth), fetchedOnly: lookUp(fetchedOnly) };

      say.push(
        `  ${r.name}: \`${fetchedOnly}\` resolved to ${JSON.stringify(before)} from the fetched table; after a one-name table was supplied, ` +
          `\`${inBoth}\` is ${JSON.stringify(after.inBoth)} and \`${fetchedOnly}\` is ${JSON.stringify(after.fetchedOnly)}`
      );

      if (before === undefined) {
        problems.push(
          `${r.name}: \`${fetchedOnly}\` did not resolve from the fetched table, so no lookup was built and\n` +
            '    the replacement assertion below cannot fail. This is the precondition, not a result.'
        );
      }
      if (after.inBoth === undefined) problems.push(`${r.name}: a supplied table's own entry \`${inBoth}\` did not resolve, so nothing was supplied`);
      if (after.fetchedOnly !== undefined) {
        problems.push(
          `${r.name}: \`${fetchedOnly}\` still resolved to ${JSON.stringify(after.fetchedOnly)} after a table without it was supplied,\n` +
            '    so a supplied value is merged with what came before rather than replacing it. A consumer supplying\n' +
            '    ten names would get ten plus every name it was trying to avoid shipping.'
        );
      }
    }
  }

  /*
   * 3. Mid-flight: neither ready nor lost, which is the third state.
   *
   * Held open deliberately rather than by timing. A check that asserted "not ready" alone would
   * pass against a version with no third state at all, because nothing is ready while a fetch is out.
   */
  {
    let release;
    r.setLoader(() => new Promise((resolve) => (release = () => resolve(r.value))));
    r.request();
    const view = viewStub();
    r.attempt(view);
    await settle();
    const inFlight = { ready: r.ready(), lost: r.lost() };
    release();
    await settle();
    const landed = { ready: r.ready(), lost: r.lost() };

    say.push(
      `  ${r.name}: while in flight, ready ${inFlight.ready} and lost ${inFlight.lost}; once landed, ready ${landed.ready} and lost ${landed.lost}`
    );
    if (inFlight.ready) problems.push(`${r.name}: reported ready while the fetch was still out`);
    if (inFlight.lost) problems.push(`${r.name}: reported lost while the fetch was still out, which is a fetch declared dead in flight`);
    if (!landed.ready) problems.push(`${r.name}: not ready after the fetch resolved`);
    if (landed.lost) problems.push(`${r.name}: reported lost after the fetch resolved`);
  }
}

/*
 * The empty case. Every assertion above is conditional on a resource being in `RESOURCES`, so an
 * empty list, or a bundle that failed to expose the seams, would print nothing and exit 0.
 */
const WANTED = RESOURCES.length * 4 + RESOURCES.filter((r) => r.replacement).length;
if (RESOURCES.length === 0 || say.length !== WANTED) {
  console.error(`check-lazy-retry: expected ${WANTED} readings and took ${say.length}, so some case did not run and proved nothing.`);
  process.exit(1);
}

for (const line of say) console.log(line);

if (problems.length) {
  console.error(`\n${problems.length} problem(s) with a lazily fetched resource:\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(
  `\n${RESOURCES.length} lazily fetched resource(s): a failure is tried again, a hopeless one stops and says so, in flight is neither,` +
    ' and a value handed over directly replaces the built-in one without fetching.'
);
