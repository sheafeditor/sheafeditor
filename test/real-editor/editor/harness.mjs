// The harness checking itself. Nothing here is a promise Sheaf makes to anybody; these are
// promises the instrument makes to whoever reads its failures, and they break the same way
// product code does. A run of this area is expected to be green and silent.
//   node test/real-editor/run-editor.mjs harness [id]

/*
 * A click target is named by the text on screen, so typing into that same text destroys the name.
 * Both scenarios here click twice on one line, so each clicks at an offset past the words it
 * searches for: `caret('MARK', 30)` puts the caret thirty characters into the line and leaves
 * "MARK" intact for the next search. Writing it the obvious way instead cost an hour: the second
 * click failed with `text not found on screen` while the text was plainly on screen, because the
 * first click had typed an X into the middle of the words being searched for.
 */
const LINE = 'MARK and then a good deal of ordinary words to aim at.';
const AIM = 30; // Inside "ordinary", well clear of MARK.

/*
 * The clicks that are meant to succeed poll, because the first click after a document opens can
 * land before the frame is ready to be measured. The clicks that are meant to be refused are never
 * wrapped in this, since a retry would swallow the refusal they exist to check.
 */
const clickWhenReady = async (S, text, offset) => {
  let last = null;
  let seen = null;
  for (let i = 0; i < 25; i++) {
    try {
      await S.caret(text, offset);
      return;
    } catch (error) {
      last = error.message;
      // Read the frame the other way round, so a failure says whether the text is absent or whether
      // the locator and `S.eval` are looking at two different frames.
      seen = await S.rendered().catch((e) => `unreadable: ${e.message}`);
      await S.sleep(200);
    }
  }
  throw new Error(
    `could not click ${JSON.stringify(text)} in five seconds: ${last}; S.rendered() meanwhile says ${JSON.stringify(
      (seen ?? '').slice(0, 200)
    )}`
  );
};

/** The one line of the document holding MARK, as it reads now. */
const markLine = async (S) =>
  (await S.rendered()).split('\n').find((l) => l.includes('MARK')) ?? '(no MARK line on screen)';

export const scenarios = [
  {
    id: 'harness.pointing.e01',
    feature: 'harness.pointing',
    name: 'A click on a target something is drawn over is refused, and the refusal names what is over it',
    run: async (S) => {
      /*
       * The control for the scroll-into-view change in `pointAt`.
       *
       * `locate` reads a target's rectangle and asks what is painted at its middle, and `pointAt`
       * refuses to click when the answer is not the target. That refusal is the whole reason the
       * pair exists: without it a click lands on whatever is on top and the scenario reads the
       * wrong element's state, which is the failure that is impossible to see from a result.
       *
       * This was written as the control for a proposed change that would have had `pointAt` scroll
       * a target below the fold into view before giving up, because a point outside the viewport
       * has nothing painted at it and the throw read "covered by nothing", which sent two people
       * looking for an overlay that was never there. A change that makes clicks succeed is exactly
       * the kind that can quietly stop refusing the ones it should, and a passing area run is the
       * weakest possible evidence about it: no scenario in any product area has a covered target,
       * so nothing in the suite exercises this branch in either direction, and a `pointAt` that
       * always clicked would report every area green.
       *
       * The scroll was held rather than landed, on what `e02` below then measured. The refusal this
       * scenario checks is therefore unchanged behaviour, and the scenario stays because the branch
       * it covers had nothing on it either way.
       *
       * So this draws something over the line on purpose and requires the throw, with a control on
       * each side: the same click works before the cover exists and again after it is removed,
       * which separates a refusal from a click that never worked here at all. The message has to
       * name the cover rather than say "nothing", because the wording is what a person reads when
       * deciding whether to look at the product or at the page.
       */
      await S.fresh('pointing-overlay', `First line.\n\n${LINE}\n\nLast line.\n`);
      await S.sleep(600);

      // Control one: the click lands before anything is over it, and the letter proves where.
      await clickWhenReady(S, 'MARK', AIM);
      await S.type('X');
      await S.sleep(300);
      const before = await markLine(S);

      const covered = await S.eval(() => {
        const line = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) =>
          l.textContent.includes('MARK')
        );
        if (!line) return false;
        const r = line.getBoundingClientRect();
        const cover = document.createElement('div');
        cover.id = 'qa-cover';
        // Fixed, so it stays over the same viewport point `locate` is about to read, and opaque,
        // because `elementFromPoint` ignores anything that does not take a hit.
        Object.assign(cover.style, {
          position: 'fixed',
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${Math.max(r.width, 300)}px`,
          height: `${Math.max(r.height, 16)}px`,
          background: 'rgb(255, 0, 0)',
          zIndex: '99999',
        });
        document.body.appendChild(cover);
        return true;
      });

      let threw = null;
      try {
        await S.caret('MARK', AIM);
      } catch (error) {
        threw = error.message;
      }

      // Control two: with the cover gone the same click works again, so the refusal above was about
      // the cover and not about this line having become unclickable.
      await S.eval(() => document.getElementById('qa-cover')?.remove());
      await S.sleep(300);
      await clickWhenReady(S, 'MARK', AIM);
      await S.type('Y');
      await S.sleep(300);
      const after = await markLine(S);

      const typedFirst = before.includes('X') && before.startsWith('MARK');
      const typedAgain = after.includes('X') && after.includes('Y') && after.startsWith('MARK');
      const refused = threw !== null && /covered by/.test(threw) && !/covered by nothing/.test(threw);
      return {
        ok: covered && typedFirst && refused && typedAgain,
        detail:
          `${covered ? 'drew a cover over the line' : 'COULD NOT DRAW A COVER, so nothing here was tested'}; ` +
          `before it the line read ${JSON.stringify(before)}; ` +
          `with it, ${threw === null ? 'THE CLICK WENT AHEAD, which is the failure this scenario exists for' : JSON.stringify(threw)}; ` +
          `after removing it, ${JSON.stringify(after)}`,
      };
    },
  },
  {
    id: 'harness.pointing.e02',
    feature: 'harness.pointing',
    name: 'A click on a target below the fold either lands on that target or is refused, never lands elsewhere',
    known:
      'a click whose target had to be scrolled to lands one line low and says nothing. The frame-local ' +
      'geometry is right at four offsets and elementFromPoint agrees with the point, so what disagrees ' +
      'is the window coordinate the mouse is driven to, and only once the document has scrolled',
    run: async (S) => {
      /*
       * The other half of the same change, and the one `render.large-docs.e04` was filed against
       * the product for, twice.
       *
       * Measured at the time: the tenth nesting level of `stress/deep-nesting.md` sits at y=860, so
       * it is reachable in a 900px viewport and not at 800 or below, and a real editor area is
       * shorter than its window by the tabs and the status bar. That is why the window suite saw
       * this and a browser at the same width did not, and it is why a browser check cannot stand in
       * for this one.
       *
       * The target is chosen by measuring rather than by counting paragraphs. CodeMirror renders a
       * viewport and a margin and nothing beyond it, so a line far enough down is not in the DOM at
       * all, which is a different limit from this one and would fail the scenario for the wrong
       * reason: at 120 paragraphs the last line was not rendered. So this takes the lowest line
       * that is rendered and starts below the fold, and says so when there is none.
       */
      const body = Array.from({ length: 30 }, (_, i) => LINE.replace('MARK', `MARK${i}`)).join('\n\n');
      await S.fresh('pointing-below-fold', `${body}\n`);
      await S.sleep(900);

      const pick = await S.eval(() => {
        const lines = [...document.querySelectorAll('.cm-content > .cm-line')];
        const below = lines.filter((l) => l.getBoundingClientRect().top > window.innerHeight);
        const chosen = below[below.length - 1];
        return {
          rendered: lines.length,
          belowFold: below.length,
          mark: chosen ? (chosen.textContent.match(/MARK\d+/) ?? [null])[0] : null,
        };
      });

      let threw = null;
      let where = null;
      let caret = null;
      if (pick.mark) {
        try {
          where = await S.locate({ text: pick.mark, offset: AIM }).catch((e) => ({ error: e.message }));
          /*
           * The target is scrolled to here, in the scenario, rather than inside `pointAt`. Four
           * things were ruled out of the failure this reports, each by its own reading, and they
           * are recorded on the issue rather than left as switches in this file: sweeping offsets
           * 0, 2, 10 and 30 resolves every one to the right text node, the right `.cm-line` and the
           * same line top; waiting for three identical readings of the target's top and the
           * scroller's offset changes nothing; scrolling from out here with 1500ms to settle gives
           * the same wrong line; and a short document with no scrolling at all clicks correctly
           * twice. So the frame-local point is right and the window coordinate is not.
           */
          await S.eval((m) => {
            const l = [...document.querySelectorAll('.cm-content > .cm-line')].find((x) => x.textContent.includes(m));
            l?.scrollIntoView({ block: 'center', inline: 'nearest' });
          }, pick.mark);
          await S.sleep(1500);
          await clickWhenReady(S, pick.mark, AIM);
          caret = await S.state().catch((e) => ({ error: String(e) }));
          await S.type('Z');
        } catch (error) {
          threw = error.message;
        }
      }
      await S.sleep(300);
      const line = pick.mark
        ? ((await S.rendered()).split('\n').find((l) => l.includes(pick.mark)) ?? '(gone)')
        : '(no target)';
      const landed = pick.mark !== null && line.includes('Z');
      // Where the letter actually went, when it did not go where it was aimed. A click that is
      // accepted and lands in another line is worse than one that is refused, and the coordinates
      // going stale between the scroll and the press is exactly how that happens.
      const strays = (await S.rendered())
        .split('\n')
        .filter((l) => l.includes('Z'))
        .map((l) => l.slice(0, 40));
      return {
        // No line below the fold is not a product failure and not a harness one, but it does mean
        // this reading proved nothing, so it is called out rather than counted as a pass.
        ok: pick.mark !== null && threw === null && landed,
        detail:
          `${pick.rendered} lines rendered, ${pick.belowFold} of them starting below the fold; ` +
          `${pick.mark === null ? 'NOTHING STARTS BELOW THE FOLD, so this scenario tested nothing: make the document longer' : `aimed at ${pick.mark}`}; ` +
          `${threw === null ? 'the click was accepted' : `it threw ${JSON.stringify(threw)}`}; ` +
          `aimed at ${JSON.stringify(where)}, caret landed on line ${JSON.stringify(caret?.line ?? caret)}; ` +
          `that line now reads ${JSON.stringify(line)}` +
          `${landed ? '' : `; the Z went into ${strays.length === 0 ? 'no line at all' : JSON.stringify(strays)}`}`,
      };
    },
  },
];
