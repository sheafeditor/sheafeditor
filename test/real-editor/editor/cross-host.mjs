/*
 * One gesture, driven through a real VS Code window and a real browser tab, with the two resulting
 * files compared.
 *
 *   npm run test:editor cross-host
 *
 * ## What this is for, and why nothing else does it
 *
 * `CLAUDE.md` promises the editor bundle is the same bytes in every host, and a host-suite check
 * enforces it. The promise is real and narrower than it reads: it covers the bundle, and the code
 * *around* the editor is neither shared nor compared. That is the provider on one side and
 * `src/server/` on the other, and almost all of it is about reaching the file.
 *
 * Two defects of that shape were found in one evening and both reach the user's file. Neither was
 * visible to anything: the window suite only drives the window, a browser probe only drives the tab,
 * and the bundle check is satisfied in both. What finds them is asking one gesture of both hosts and
 * comparing, which is a kind of check this repository had none of.
 *
 * ## The comparison needs no opinion about which host is right
 *
 * A difference is a finding. Which host to change is a separate question, answered per case on the
 * issue. That is what makes this cheap enough to grow: adding a gesture is writing it twice and
 * asserting nothing beyond "the two files agree".
 *
 * ## Two of these are expected to differ, on purpose
 *
 * `e01` and `e02` are the two known defects, and they are first so that the check's first run has
 * something to catch. A first run reporting two differences is the check working; a first run
 * reporting none is the check not looking, and that control is only available once.
 *
 * They are written as **expected** differences rather than as failures, naming the issue each one
 * waits on, so the area is green while they are open and goes red the day a fix lands without this
 * being updated. A scenario that simply failed would be a standing red line nobody reads, which is
 * what the printed-not-asserted notice in `table-ops` was for most of its life.
 *
 * ## The precondition that would make all of this meaningless
 *
 * The server holds a document only once something subscribes to `/api/events`. A tab holding no
 * document differs from a window on every gesture, which reads exactly like finding a dozen bugs.
 * `tabHost.mjs` asserts the subscription, and every scenario here checks it before comparing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { compareFiles, openTab, tabHostAvailable } from '../tabHost.mjs';

const j = (x) => JSON.stringify(x);

/**
 * The file as it settles, sampled rather than read once.
 *
 * A single reading after a fixed wait is a prediction about timing, and the first run of this check
 * made exactly that mistake: it read the window's file 1500ms after the write, found no letter, and
 * reported that the two hosts agreed. They do not. A window takes the write, then merges, then
 * saves, so the letter leaves the file and comes back, and which of those a single sample catches is
 * decided by where the sample lands.
 *
 * So the trail is the measurement and the last value is the answer. The trail is printed either way,
 * because a host that ends in the right place by passing through the wrong one is worth seeing.
 */
async function settle(read, sleep, { every = 200, forMs = 4000 } = {}) {
  const seen = [];
  for (let waited = 0; waited <= forMs; waited += every) {
    const now = await read();
    if (seen[seen.length - 1] !== now) seen.push(now);
    await sleep(every);
  }
  return { trail: seen, settled: seen[seen.length - 1] ?? null };
}

const THREE_LINES = 'Top line.\n\nMiddle line here.\n\nBottom line.\n';
/** The same file as something else would write it back: the top line changed, the typing absent. */
const CHANGED_THE_TOP = 'Top line changed by an agent.\n\nMiddle line here.\n\nBottom line.\n';

/**
 * Run one gesture in both hosts and compare the files.
 *
 * @param {object} S the real-editor session, which is the window
 * @param {(h: {disk: () => string, sleep: (ms: number) => Promise<void>}) => Promise<void>} gesture
 */
async function bothHosts(S, name, { fixture, inWindow, inTab }) {
  const why = tabHostAvailable();
  if (why) {
    // A failure rather than a skip. These scenarios exist because the two hosts are not compared
    // anywhere else, so a run that quietly compared one of them has measured nothing.
    throw new Error(`no browser host to compare against: ${why}`);
  }
  const path = await S.fresh(name, fixture);
  await S.sleep(600);
  await inWindow(S, path);
  // `readFileSync`, never `S.disk`. See the note in `settle` and in the control below: `S.disk`
  // waits for the file to stop changing, so sampling with it waits out the settling being sampled.
  const w = await settle(() => readFileSync(path, 'utf8'), (ms) => S.sleep(ms));

  const tab = await openTab(fixture);
  try {
    if (!tab.opened()) {
      throw new Error(
        `the tab never subscribed to /api/events, so it is holding no document and any comparison would ` +
          `differ for that reason. Statuses seen: ${j(tab.subscriptions)}`
      );
    }
    await inTab(tab);
    const t = await settle(() => tab.disk(), (ms) => tab.sleep(ms));
    return {
      windowFile: w.settled,
      tabFile: t.settled,
      windowTrail: w.trail,
      tabTrail: t.trail,
      ...compareFiles(w.settled, t.settled),
      subscriptions: tab.subscriptions,
    };
  } finally {
    await tab.close();
  }
}

/** A result line that prints both files whatever the verdict, because the bytes are the evidence. */
const report = (r) =>
  `the window settled at ${j(r.windowFile)} through ${r.windowTrail.length} value(s) ${j(r.windowTrail)}; ` +
  `the tab settled at ${j(r.tabFile)} through ${r.tabTrail.length} value(s) ${j(r.tabTrail)}; ` +
  `${r.same ? 'they agree' : `they differ on ${r.differing.length} line(s): ${j(r.differing)}`}`;

/**
 * Paste a one-pixel PNG under a given filename, in whichever host `run` evaluates in.
 *
 * A real `ClipboardEvent` carrying a real `File`, because the paste path reads the clipboard's files
 * and nothing shorter reaches it: the insertion lives inside a non-exported `ingest` that takes
 * `File` objects, so there is no unit route to it at all and this is the only way to drive it.
 */
const PASTE = (name) => {
  const content = document.querySelector('.cm-content');
  if (!content) return false;
  const bytes = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0)
  );
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type: 'image/png' }));
  content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return true;
};

/**
 * Whether *this* picture is on screen, found by its own address rather than by being the first image.
 *
 * `document.querySelector('.cm-content img')` is wrong here and was wrong in a probe that reported
 * this behaviour broken: the page holds several images with an empty `src`, so the first one is a
 * placeholder, and it answers `complete: true` with `naturalWidth: 0` — which reads exactly like a
 * picture that failed to load. Measured at three waits, all `src: null`.
 *
 * So the image is selected by having an address at all, and `found` is reported, so a run that found
 * none says so rather than reporting a load failure for something it never looked at. Measured after
 * the paste: three images on the page, the real one second, `naturalWidth: 1`.
 */
const DESTINATION = () => {
  // By having an address at all, which is host-agnostic: a tab serves `/file/assets/...` and a window
  // a webview resource URI, and the placeholders have no `src` attribute in either.
  const imgs = [...document.querySelectorAll('.cm-content img')].filter((i) => !!i.getAttribute('src'));
  const img = imgs[0];
  return {
    found: imgs.length,
    src: img ? img.getAttribute('src') : null,
    loaded: !!img && img.complete && img.naturalWidth > 0,
  };
};

/**
 * Whether an image line's destination is one Markdown reads back whole.
 *
 * A space ends a destination in CommonMark unless the whole thing is in angle brackets, so those are
 * the two well-formed shapes. Read off the file rather than predicted from the filename, because what
 * matters is what was written.
 */
function destinationIsFollowable(file) {
  const line = file.split('\n').find((l) => l.includes(']('));
  if (!line) return { line: null, ok: false, why: 'no image line in the file' };
  const bracketed = /\]\(<[^>]*>\)/.test(line);
  const spaceFree = /\]\([^\s)]*\)/.test(line);
  return {
    line,
    ok: bracketed || spaceFree,
    why: bracketed ? 'wrapped in angle brackets' : spaceFree ? 'no space to end it early' : 'a bare destination with a space in it, which ends at the space',
  };
}

export const scenarios = [
  {
    id: 'hosts.parity.control.the-window-alone-gives-the-letter-back',
    feature: 'hosts.parity',
    name: 'Control: the window half of the gesture on its own gives the letter back, so a difference found below is about the tab',
    run: async (S) => {
      /*
       * The control for every comparison in this area, and it is here because the first two runs of
       * `e01` needed it.
       *
       * Those runs reported that the two hosts agreed and both lost the letter, which contradicts
       * `host.outside-change.race.r01` passing on the same gesture at the same commit. One of the two
       * readings had to be wrong about something other than the hosts, and a comparison cannot say
       * which: a window that has stopped merging and a tab that never merged agree perfectly.
       *
       * So the window half runs alone, asserting what `r01` asserts, in this area and through this
       * area's own fixture and setup. If this passes and `e01` still reports agreement, the
       * difference is in how `e01` drives the window. If this fails, this area's window is not
       * behaving like `save-race`'s and every comparison here is measuring that instead.
       *
       * It is the same shape as the precondition `tabHost` asserts about `/api/events`: a comparison
       * is only evidence once both sides are known to be doing the thing being compared.
       */
      const path = await S.fresh('xhost-window-control', THREE_LINES);
      await S.caret('Middle', 0);
      await S.type('Z');
      await S.sleep(2000);
      /*
       * `readFileSync` and not `S.disk`, and the difference is why this scenario failed twice.
       *
       * `S.disk` is not a read: it waits for the file to stop changing, 800ms of quiet with a 6s
       * ceiling. Sampling with it does not sample, it waits out exactly the settling the sample is
       * meant to observe, and it takes at least 800ms per call rather than the interval asked for.
       */
      const savedFirst = readFileSync(path, 'utf8');
      writeFileSync(path, CHANGED_THE_TOP);
      const after = await settle(() => readFileSync(path, 'utf8'), (ms) => S.sleep(ms), { every: 100, forMs: 3300 });
      const shown = (await S.state()).doc;
      /*
       * The notices, because they say whether the provider saw the write at all. A merge that keeps
       * the letter says nothing; a provider that decided the letter was taken says so. Silence with
       * the letter gone is a third thing again: the file was reloaded without the provider having an
       * opinion, which is what a document open in some other editor would look like.
       */
      const said = await S.page
        .locator('.notifications-toasts .notification-toast')
        .allTextContents()
        .catch(() => []);
      return {
        ok:
          savedFirst.includes('ZMiddle') &&
          after.settled.includes('ZMiddle') &&
          after.settled.includes('Top line changed') &&
          shown.includes('ZMiddle'),
        detail:
          `on disk before the write ${j(savedFirst)}; the file went through ${after.trail.length} value(s) ` +
          `${j(after.trail)}; the screen holds ${j(shown)}; notices ${j(said.filter((t) => t.includes('Sheaf')))}`,
      };
    },
  },
  {
    id: 'hosts.parity.e01',
    feature: 'hosts.parity',
    name: 'A write made from a copy read before the typing leaves the letter standing in both hosts',
    run: async (S) => {
      /*
       * Gesture 1, and this scenario has now done the job it was written for twice over.
       *
       * The letter is on disk before the write arrives, and the write changes a different line, so it
       * is merely behind rather than meaning the deletion. Both hosts read the file in and merge,
       * keeping the letter and the writer's own change, and saying nothing because nothing was taken.
       *
       * **It was written asserting the opposite**, as an expected difference naming the issue it
       * waited on: the window kept the letter and the tab did not. That is what it reported, which is
       * how the browser host's missing read-in merge became a measured fact rather than a suspicion.
       * Then the fix landed and this went red, which is the second half of the same job — a scenario
       * describing a divergence has to fail the moment the divergence goes, or the notes keep saying
       * the hosts disagree long after they stopped.
       *
       * So the assertion is agreement now, and it is agreement on the *content* rather than on the
       * files being equal: two hosts that both lost the letter would agree perfectly. That is the
       * trap the control above exists for and it applies here too.
       */
      const r = await bothHosts(S, 'xhost-stale-write', {
        fixture: THREE_LINES,
        inWindow: async (s, path) => {
          await s.caret('Middle', 0);
          await s.type('Z');
          // Well past the debounce, so the letter is on disk before the write arrives. Read back
          // rather than assumed, because "the letter was already saved" is the whole premise and a
          // run where the save had not landed would be measuring a different gesture.
          await s.sleep(2000);
          const savedFirst = readFileSync(path, 'utf8');
          if (!savedFirst.includes('ZMiddle')) {
            throw new Error(`the letter was not on disk before the write, so this is not the gesture: ${j(savedFirst)}`);
          }
          writeFileSync(path, CHANGED_THE_TOP);
        },
        inTab: async (tab) => {
          await tab.typeAt('Middle', 'Z');
          await tab.sleep(2000);
          // The same precondition, read the same way. If the tab's own save has not landed either,
          // the two hosts are being asked different questions and a difference means nothing.
          const savedFirst = tab.disk();
          if (!savedFirst.includes('ZMiddle')) {
            throw new Error(`the tab had not saved the letter before the write, so this is not the gesture: ${j(savedFirst)}`);
          }
          tab.writeFromOutside(CHANGED_THE_TOP);
        },
      });
      const windowKept = r.windowFile.includes('ZMiddle');
      const tabKept = r.tabFile.includes('ZMiddle');
      // The writer's own change too, in both, or a host could pass this by discarding the write and
      // keeping the letter, which is the other way to make the two files agree.
      const windowTookTheirs = r.windowFile.includes('Top line changed');
      const tabTookTheirs = r.tabFile.includes('Top line changed');
      return {
        ok: r.same && windowKept && tabKept && windowTookTheirs && tabTookTheirs,
        detail:
          `${report(r)}; the letter stands: window ${windowKept}, tab ${tabKept}; ` +
          `the writer's own change arrived: window ${windowTookTheirs}, tab ${tabTookTheirs}`,
      };
    },
  },
  {
    id: 'hosts.parity.e02',
    feature: 'hosts.parity',
    name: 'A pasted image whose filename has a space is linked so a Markdown reader can follow it, in both hosts',
    run: async (S) => {
      /*
       * Gesture 2, and it is the one gesture here that **cannot** assert the two files agree.
       *
       * The two hosts sanitise a pasted filename differently and always have: one replaces everything
       * outside `[a-zA-Z0-9._-]` with a dash, the other only path separators and leading dots. So the
       * same paste lands as `assets/Screen-Shot-...png` in a window and `assets/Screen Shot ....png`
       * in a tab. That is a difference rather than a defect, and unifying it is a separate decision
       * about what a saved filename should look like.
       *
       * So this asserts `hosts.parity` **R3** rather than R1: Markdown written by either host is valid
       * in the other and outside Sheaf. A predicate rather than a diff, which is normally the weaker
       * shape, and here it is the only honest one — a diff would report a difference that is correct.
       *
       * What made it a defect was the insertion writing the path raw while `mdDestination`, the rule
       * for an address, sat thirty lines above it unused. A space ends a destination in CommonMark, so
       * a tab wrote a broken link: nothing drawn here, and wrong on GitHub and under pandoc too.
       *
       * Both halves are read: the destination's shape in the file, and whether a picture actually
       * drew. The second is what says the first is not merely well-formed.
       */
      const why = tabHostAvailable();
      if (why) throw new Error(`no browser host to compare against: ${why}`);
      const SPACED = 'Screen Shot 2026-09-30 at 7.59.12 PM.png';

      const path = await S.fresh('xhost-paste', 'Intro.\n\nAfter.\n');
      await S.sleep(600);
      await S.caret('Intro', 5);
      if (!(await S.eval(PASTE, SPACED))) throw new Error('no editor content to paste into in the window');
      await S.sleep(2500);
      const windowFile = readFileSync(path, 'utf8');
      const windowDrew = await S.eval(DESTINATION);

      const tab = await openTab('Intro.\n\nAfter.\n');
      try {
        if (!tab.opened()) throw new Error(`the tab is holding no document: ${j(tab.subscriptions)}`);
        await tab.page.evaluate(PASTE, SPACED);
        await tab.sleep(2500);
        const tabFile = tab.disk();
        const tabDrew = await tab.page.evaluate(DESTINATION);
        const w = destinationIsFollowable(windowFile);
        const t = destinationIsFollowable(tabFile);
        return {
          ok: w.ok && t.ok && windowDrew.loaded && tabDrew.loaded,
          detail:
            `the window wrote ${j(w.line)} (${w.why}), picture ${j(windowDrew)}; ` +
            `the tab wrote ${j(t.line)} (${t.why}), picture ${j(tabDrew)}; ` +
            `the filenames differ by design, so this asserts each is followable rather than that they match`,
        };
      } finally {
        await tab.close();
      }
    },
  },
];
