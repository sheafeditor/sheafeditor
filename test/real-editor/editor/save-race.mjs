// A write from outside landing near Sheaf's own auto-save, and what the person is told about it.
//
// The merge checks in `merge-edges` read the file once at the end, which says what was lost and
// not where it went. These read the file on a trail, because three different orderings leave the
// same final bytes and only one of them is the merge failing:
//
//   the write lands inside the 700ms debounce   the save has not run; the merge keeps both
//   the write lands while the save is running   VS Code refuses it; the hand-written save merges
//   the write lands after the save               the file held the letter and something replaced it
//
// The third is not a merge at all. Nothing is unsaved, so there is nothing to put together: VS Code
// reloads the document and the letter goes with it. What Sheaf owes the person there is a notice
// and an Undo that reaches it, and that is what these check.
//
// The auto-save debounce is 700ms and `S.type` returns about 215ms after the keystroke, so a
// scenario that types and sleeps 500 lands within a few milliseconds of the save. That coincidence
// is why two scenarios written to one shape report different symptoms, and why the trail is here.
//   node test/real-editor/run-editor.mjs save-race [id]
import { readFileSync, writeFileSync } from 'node:fs';

const j = (x) => JSON.stringify(x);

const THREE_LINES = 'Top line.\n\nMiddle line here.\n\nBottom line.\n';
const AGENT_CHANGED_THE_TOP = 'Top line changed by an agent.\n\nMiddle line here.\n\nBottom line.\n';

/** The third line of the file, which is the one being typed in, or `gone` when there is none. */
const middleOf = (path) => readFileSync(path, 'utf8').split('\n')[2] ?? 'gone';

/**
 * Every toast VS Code is showing, read from the workbench page.
 *
 * `S.page`, not `S.eval`. A notification is workbench chrome and lives in the window's own DOM;
 * `S.eval` runs inside the webview's frame, where `.notifications-toasts` does not exist and cannot
 * come to exist. Read the other way this returns an empty list whatever is on screen, which is a
 * probe that cannot fail, and the reason r01 below asserts a notice is present rather than absent.
 */
const toasts = (S) =>
  S.page.$$eval('.notifications-toasts .notification-list-item-message', (els) => els.map((e) => e.textContent.trim()));

/**
 * The file's middle line every `step` ms for `count` steps, as a trail with the time on each
 * reading. A trail rather than a total, because the question is the order things happened in.
 */
async function trail(S, path, { step = 100, count = 25, from = 0 } = {}) {
  const seen = [];
  for (let i = 0; i < count; i++) {
    const line = middleOf(path);
    if (seen.length === 0 || seen[seen.length - 1].line !== line) seen.push({ at: from + i * step, line });
    await S.sleep(step);
  }
  return seen.map((s) => `${s.at}ms ${j(s.line)}`).join(' -> ');
}

export const scenarios = [
  {
    id: 'host.outside-change.race.r01',
    feature: 'host.outside-change',
    name: 'A write that replaces a letter the auto-save had already written gives the letter back, and says nothing',
    run: async (S) => {
      /*
       * Rewritten on 2026-09-30 to match a design decided on 2026-09-26: when a write is merely
       * behind on the line you typed, your text stands. This asserted the design that decision
       * reversed, and the release run at `81cad61` shows the product doing the decided thing while
       * this scenario called it a failure:
       *
       *   the file held "ZMiddle line here." before the write;
       *   after 0ms "Middle line here." -> 800ms "ZMiddle line here.";
       *   screen "ZMiddle line here."; notices []
       *
       * So the letter goes for a moment as the reload lands and the merge puts it back, and nothing
       * is announced because nothing was lost. Both halves are asserted below: the letter standing
       * at the end, and the silence, which under the old design were opposites and under this one
       * are the same fact.
       *
       * The `after` trail is kept and printed rather than asserted. That the letter is briefly
       * absent at 0ms is how the merge works rather than something a person can see, and pinning a
       * moment inside it would make this a timing scenario instead of a behaviour one.
       *
       * `r02` below stays exactly as it was and is still the control: with nobody having typed, the
       * same write must also say nothing. Together they say the silence here is because nothing was
       * taken, not because notices never appear.
       */
      const path = await S.fresh('race-after-save', THREE_LINES);
      await S.caret('Middle', 0);
      await S.type('Z');
      // Long enough that the save has certainly run, so the file holds the letter and the write
      // that follows is a reload rather than anything the merge can reach.
      await S.sleep(2000);
      const savedFirst = middleOf(path);
      writeFileSync(path, AGENT_CHANGED_THE_TOP);
      const after = await trail(S, path);
      await S.sleep(800);
      const shown = (await S.state()).doc.split('\n')[2];
      const said = (await toasts(S)).filter((t) => t.startsWith('Sheaf:'));
      const ok =
        // The letter did reach the file on its own, which is what makes this the third ordering.
        savedFirst === 'ZMiddle line here.' &&
        // And it is still there afterwards, on the screen and in the file alike.
        middleOf(path) === 'ZMiddle line here.' &&
        shown === 'ZMiddle line here.' &&
        // The write's own change to the top of the file has to have arrived as well, or a merge
        // that simply dropped the write would read as a pass.
        readFileSync(path, 'utf8').includes('Top line changed') &&
        // Nothing was taken, so there is nothing to say.
        said.length === 0;
      return {
        ok,
        detail: `the file held ${j(savedFirst)} before the write; after ${after}; screen ${j(shown)}; notices ${j(said)}`,
      };
    },
  },
  {
    id: 'host.outside-change.race.r02',
    feature: 'host.outside-change',
    name: 'The same write with nobody having typed says nothing, so the notice is about the letter and not about the write',
    run: async (S) => {
      // The control for r01. Without it a notice on every outside write would pass r01 just as
      // well, and the notice would be noise on every agent that ever writes a file.
      const path = await S.fresh('race-nobody-typed', THREE_LINES);
      await S.sleep(2000);
      writeFileSync(path, AGENT_CHANGED_THE_TOP);
      await S.sleep(2000);
      const shown = (await S.state()).doc;
      const said = (await toasts(S)).filter((t) => t.startsWith('Sheaf:'));
      const ok = shown.includes('Top line changed by an agent.') && said.length === 0;
      return { ok, detail: `screen ${j(shown.split('\n')[0])}; notices ${j(said)}` };
    },
  },
  {
    id: 'host.outside-change.race.r03',
    feature: 'host.outside-change',
    name: 'The write landing within milliseconds of the save loses neither side of it without saying so',
    run: async (S) => {
      /*
       * The second ordering, and the one r01 cannot reach. `S.type` returns about 215ms after the
       * keystroke and the debounce is 700ms, so sleeping 500 puts the write within a few
       * milliseconds of the save: near enough that which lands first varies from run to run.
       *
       * So this is attempted three times and fails on the first attempt that diverges, rather than
       * being run once and read as an answer. Measured at `e49aab9`, a single attempt diverged
       * twice in three runs, which is exactly the shape that gets called intermittent and ignored.
       *
       * There are two casualties and which one it is depends on which write landed first, so both
       * are checked:
       *
       *   Sheaf's save lands second   it writes the whole file from a copy predating the write, and
       *                               the agent's line is simply absent. Nothing is said, and an
       *                               agent does not read its own write back, so nobody finds out.
       *   the agent's write lands second  the letter goes. Sometimes announced, sometimes not, and
       *                               when it is not the screen goes on showing the letter.
       *
       * The first is the one worth the most here, because it is the promise the product is built
       * on: a file is safe to leave open while an agent writes it.
       */
      const attempts = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        const path = await S.fresh(`race-inside-the-save-${attempt}`, THREE_LINES);
        await S.caret('Middle', 0);
        await S.type('Z');
        await S.sleep(500);
        writeFileSync(path, AGENT_CHANGED_THE_TOP);
        await S.sleep(2600);
        // The whole document, not the line that was typed in. The race has two casualties
        // and they are on different lines: the letter, on the middle line, and the agent's
        // change, on the top one. A reading that compared only the middle line passed while
        // the top line's change was gone, which is the direction nobody is watching, because
        // an agent does not check its write afterwards and will not retry.
        const screen = (await S.state()).doc;
        const onDisk = readFileSync(path, 'utf8');
        const said = (await toasts(S)).filter((t) => t.startsWith('Sheaf:'));
        const keptTheAgentsChange = onDisk.includes('Top line changed by an agent.');
        const keptTheLetter = onDisk.includes('ZMiddle line here.');
        // Either the file and the screen agree and the agent's change survived, or the
        // person was told what the write cost. Silence with either side missing is the bug.
        const settled = (screen === onDisk && keptTheAgentsChange) || said.length > 0;
        attempts.push(
          `attempt ${attempt} agent's change ${keptTheAgentsChange} letter ${keptTheLetter} ` +
            `screen and file ${screen === onDisk ? 'agree' : `differ (screen ${j(screen.split('\n')[2])} file ${j(onDisk.split('\n')[2])})`} ` +
            `notices ${j(said)}`
        );
        if (!settled) return { ok: false, detail: attempts.join('; ') };
      }
      return { ok: true, detail: attempts.join('; ') };
    },
  },
];
