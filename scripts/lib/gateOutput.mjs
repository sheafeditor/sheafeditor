/*
 * What a gate step's output says about whether it actually measured anything.
 *
 * One failure has appeared four times in four different files this week, and every time it
 * was fixed where it was found rather than as a class:
 *
 *   - the gates printed "All gates passed" with five browser steps skipped
 *   - a scheduled window-suite run stopped on its first command and was recorded as succeeded
 *   - a browser check served a bundle five minutes older than the sources it was checking
 *   - two of three browser checks in the site repository printed a skip and exited 0
 *
 * Each one is a check reporting what a clean check reports when it could not run at all. That
 * is worse than a red run, because a red run is read and a green one is not, and it is worse
 * than a missing check, because somebody believes it.
 *
 * So the rule, stated once: **a step that could not make its measurement has failed.** Not
 * skipped, not inconclusive. Exit status is not enough to enforce it, because the shapes below
 * all exit 0.
 *
 * This lives apart from `gates.mjs` so the harness suite can control it without running the
 * gates, which take ten minutes and cannot be made to fail on demand.
 */

/**
 * Reads a step's combined output and reports the three ways it can be green while having
 * measured nothing. Everything here is a fact about the text; the caller decides what to do.
 */
export function readVerdict(output) {
  const text = String(output ?? '');
  const lines = text.split('\n');

  /*
   * The word the scripts print when they decline to run. A skip exits 0, which is why this is
   * read from the output rather than from the status.
   */
  const skipped = lines
    .filter((l) => l.startsWith('skipped:'))
    .map((l) => l.slice('skipped:'.length).trim());

  /*
   * A count whose denominator is zero. "0/0 host checks passed" is what a suite prints when
   * its bundle built nothing or its entry registered no scenarios, and it exits 0, and it
   * reads exactly like a suite with nothing wrong. The numerator is not looked at: a run that
   * measured nothing is the defect whatever it claims about what it measured.
   */
  const emptyCounts = [];
  for (const line of lines) {
    const count = /(\d+)\s*\/\s*(\d+)\s+(.+?)\s+passed/.exec(line);
    if (count && Number(count[2]) === 0) emptyCounts.push(line.trim());
    /*
     * And the same shape written as prose, which three of the checks here use: "17523 cells,
     * 55698 checks" and "9 caret positions measured". A leading zero there is the same defect.
     */
    const measured = /^\s*0\s+(cells|checks|scenarios|positions|classes|cases|files|pages)\b/.exec(line);
    if (measured) emptyCounts.push(line.trim());
  }

  /*
   * A step that printed nothing is **not** reported, and the reason is worth keeping because I
   * wrote the opposite here first. "Every step in this repository prints something, so this has
   * no false positives today" was a claim, not a measurement, and reading a real green log
   * found one immediately: `tsc --noEmit` prints nothing when it passes, and it is a core step.
   *
   * There is no honest way to tell that from a step reduced to a bare `process.exit(0)`. An
   * exemption for the type check would be the first entry in a list that eventually excuses
   * everything, which is the shape this file exists to argue against. So the rule is narrower
   * than I wanted and means what it says.
   */
  return { skipped, emptyCounts };
}

/**
 * The sentence to print when a step was green and measured nothing, or null when it was fine.
 * Kept here rather than in the runner so the wording is controlled with the reading.
 */
export function complaintFor(label, verdict) {
  if (verdict.emptyCounts.length) {
    return (
      `${label} measured nothing and exited 0: ${JSON.stringify(verdict.emptyCounts)}.\n` +
      'A count of zero is not a pass. Something it needed was absent rather than correct.'
    );
  }
  return null;
}
