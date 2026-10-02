/*
 * The gates' own loop, separated from the list of gates and from the process.
 *
 * It lives here rather than in `gates.mjs` for one reason: a control. What this loop decides is
 * which gates get reached, and the whole of the fault it was written to fix is that a run that
 * stops early reaches fewer than it reports. Checking that in `gates.mjs` would mean running the
 * real gates, which take ten minutes and cannot be asked to fail at positions 2 and 21 on demand,
 * so the behaviour had no check at all and the only evidence for it would have been reading it.
 *
 * Everything it touches is an argument: the steps, how to run one, and where to write. So the
 * harness suite drives it with steps that fail where it wants them to, and asserts which ones
 * were reached. It returns a verdict and calls no `process.exit`, because a function that exits
 * cannot be asked a second question.
 *
 * **Control log.** `bad()` below returns whether the run should stop, and it is the one line both
 * modes turn on, so it is where the checks were broken to watch them fail. Forced to `true`,
 * always stopping: the `--all` check reports `reached 2, ran 2, failures ["Gate 2"]` and the
 * forgiveness check loses its second failure, 28 of 30. Forced to `false`, never stopping: the
 * terminal-default check reports `reached 23, failures ["Gate 2","Gate 21"]`, 29 of 30. Each mode's
 * check fails for the other mode's bug and neither fails for its own, which is the discrimination
 * worth having: a single check would have passed under one of the two breakages.
 */

import { complaintFor, readVerdict } from './gateOutput.mjs';

/**
 * Run a list of gates.
 *
 * @param {object} o
 * @param {Array<[string, string, string[]]>} o.steps - label, command, arguments.
 * @param {(cmd: string, args: string[]) => Promise<{status: number|null, signal?: string|null, seen: string}>} o.run
 * @param {boolean} [o.all] - run every gate rather than stopping at the first failure.
 * @param {(label: string) => boolean} [o.forgiven] - whether a label's skip is accepted.
 * @param {(s: string) => void} [o.out]
 * @param {(s: string) => void} [o.err]
 * @returns {Promise<{ran: number, total: number, failures: {label: string, why: string}[], skipped: string[], status: number}>}
 */
export async function runGates({ steps, run, all = false, forgiven = () => false, out = () => {}, err = () => {} }) {
  const skipped = [];
  /** One entry per gate that did not pass, in the order they were reached. */
  const failures = [];
  /** How many gates were reached at all, which is the number a red run never used to report. */
  let ran = 0;
  let status = 0;

  /*
   * The tally, on every path including the happy one.
   *
   * "9 of 23 gates ran, 1 failed" is the line that would have made a week of dark gates visible.
   * "Tests failed" is the line that did not, because it is equally true of a run that checked
   * nine things and a run that checked all of them.
   */
  const tally = () => {
    err(`\n${ran} of ${steps.length} gates ran, ${failures.length} failed\n`);
    for (const f of failures) err(`  - ${f.label}: ${f.why}\n`);
    if (ran < steps.length) {
      const dark = steps.slice(ran).map(([l]) => l);
      err(
        `\n${dark.length} gate${dark.length === 1 ? '' : 's'} never ran, so ${dark.length === 1 ? 'it has' : 'they have'} reported nothing about this change:\n` +
          `  ${dark.join(', ')}\n` +
          'Run with --all to reach them anyway, which is what CI does.\n'
      );
    }
  };

  /** Record a gate that did not pass, and say whether the run should stop here. */
  const bad = (label, why, code) => {
    failures.push({ label, why });
    if (failures.length === 1) status = code;
    return !all;
  };

  for (const [label, cmd, args] of steps) {
    out(`\n=== ${label} ===\n`);
    const r = await run(cmd, args);
    ran += 1;
    if (r.status !== 0) {
      /*
       * Name the signal when there is one. A step killed for memory exits without printing, and
       * a bare "failed" then reads as a regression in whatever was being worked on: an hour of
       * reading a diff with nothing wrong in it. `SIGKILL` or `SIGABRT` here is recognisable in
       * seconds.
       */
      const how = r.signal ? ` (killed by ${r.signal})` : r.status === 134 ? ' (aborted: out of heap, most likely)' : '';
      err(`\n${label} failed${how}\n`);
      if (r.signal || r.status === 134) {
        err(
          'A step that was killed has not reported anything about your change. Run it on its\n' +
            "own before reading the diff, and use the repository's own command rather than a\n" +
            'hand-assembled node invocation, which is how a stale heap flag gets carried in.\n'
        );
      }
      if (bad(label, `failed${how}`, r.status ?? 1)) {
        tally();
        return { ran, total: steps.length, failures, skipped, status };
      }
      continue;
    }
    /*
     * A step can be green and have measured nothing, and the exit status cannot tell you.
     * `readVerdict` names the three shapes that takes: a skip, which is collected, and a silent
     * step or a count of zero, which fail. A step that printed nothing or counted to zero has
     * reported nothing about the change being landed.
     */
    const verdict = readVerdict(r.seen);
    for (const why of verdict.skipped) skipped.push(`${label}: ${why}`);
    /*
     * A skip ends the run where it happens, the way a failure does.
     *
     * It used to be collected and reported at the end, so a step that skipped in the first ten
     * seconds was announced twenty minutes later, after every other step had run for nothing. A
     * release was cut that way: the command ran the whole of the gates and then refused, and the
     * person waiting was never asked for the passphrase it was building up to.
     *
     * Nothing is lost by stopping. A skip is not a result to be weighed against the others; it is
     * the run saying it cannot answer, and the answer does not improve by carrying on.
     * `SHEAF_ALLOW_SKIPPED_GATES=1` still accepts the gap, and then the run continues and the
     * list at the end is what it always was.
     *
     * Under `--all` it does not stop, for the same reason nothing else does: the point of that
     * mode is that one gate's verdict never decides whether another is asked.
     */
    if (verdict.skipped.length && !forgiven(label)) {
      err(`\n${label} did not run:\n`);
      for (const why of verdict.skipped) err(`  - ${why}\n`);
      err(
        '\nStopped here rather than running the rest, because a step that did not run has not\n' +
          'passed and nothing after it changes that. Fix what it is missing, or set\n' +
          `SHEAF_ALLOW_SKIPPED_GATES=${JSON.stringify(label)} to accept this one, or =1 for all of them,\n` +
          'and say so wherever you report the result.\n'
      );
      if (bad(label, `did not run: ${verdict.skipped.join('; ')}`, 1)) {
        tally();
        return { ran, total: steps.length, failures, skipped, status };
      }
      continue;
    }
    const complaint = complaintFor(label, verdict);
    if (complaint) {
      err(`\n${complaint}\n`);
      if (bad(label, complaint.split('\n')[0], 1)) {
        tally();
        return { ran, total: steps.length, failures, skipped, status };
      }
      continue;
    }
  }

  if (failures.length) {
    tally();
    err(
      `\nEvery gate ran. ${failures.length === 1 ? 'The one above is' : 'The ones above are'} what failed, ` +
        'and a gate that serves the built files fails too when Build does, so fix Build first if it is in the list.\n'
    );
    return { ran, total: steps.length, failures, skipped, status };
  }

  if (skipped.length) {
    err(`\n${skipped.length} step${skipped.length > 1 ? 's' : ''} did not run:\n`);
    for (const s of skipped) err(`  - ${s}\n`);
    err(
      '\nA step that did not run has not passed, and these are the checks jsdom cannot\n' +
        'stand in for. Fix what they are missing, or set SHEAF_ALLOW_SKIPPED_GATES=1 to\n' +
        'accept the gap for this run and say so wherever you report the result.\n'
    );
    if (!skipped.every((s) => forgiven(s.split(':')[0]))) {
      tally();
      return { ran, total: steps.length, failures, skipped, status: 1 };
    }
    out(`\nAll ${ran} gates passed, with the skipped steps above allowed\n`);
    return { ran, total: steps.length, failures, skipped, status: 0 };
  }

  // The count, on the green path as well. A run that says "all gates passed" without saying how
  // many is the same sentence whether it ran twenty-three or nine, which is how a shrinking
  // number goes unnoticed.
  out(`\nAll ${ran} of ${steps.length} gates passed\n`);
  return { ran, total: steps.length, failures, skipped, status: 0 };
}
