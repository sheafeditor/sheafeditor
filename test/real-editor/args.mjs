/*
 * The editor runner's command line, in a module so it can be checked without launching anything.
 *
 * It is four lines and it has already been wrong twice, both times in the direction that makes a
 * run report success over nothing. `[area, only]` taken off a raw argv reads `--times` as the id
 * filter, so `<area> --times 300` selected no scenario and printed `0/0 passed` with exit 0. And
 * dropping `flagAt + 1` from the positionals without checking that the flag is there drops index
 * 0, which is the area itself.
 *
 * Both are the same shape: a parse that fails by selecting an empty set, which every runner then
 * reports as a clean run. That is why this is a module with checks on it rather than four lines
 * at the top of a script nothing can import.
 */

/**
 * `argv` is `process.argv.slice(2)`.
 *
 * Returns `{ area, only, times, ok, why }`. `ok` is false with a reason when the command cannot be
 * acted on, which the caller turns into a usage message: a parser that returns a usable-looking
 * shape for a command it could not read is how the empty selection got through.
 */
export function parseArgs(argv) {
  const flagAt = argv.indexOf('--times');
  const times = flagAt === -1 ? 1 : Number(argv[flagAt + 1]);
  // Only a value to skip when the flag is actually present: with no `--times`, `flagAt` is -1
  // and `flagAt + 1` is 0, which is the area.
  const valueAt = flagAt === -1 ? -1 : flagAt + 1;
  const positional = argv.filter((a, i) => !a.startsWith('--') && i !== valueAt);
  const [area, only] = positional;
  if (!area) return { area: null, only: null, times, ok: false, why: 'no area named' };
  if (!Number.isInteger(times) || times < 1) {
    return { area, only: only ?? null, times, ok: false, why: `--times wants a whole number of at least 1, not ${JSON.stringify(argv[flagAt + 1])}` };
  }
  return { area, only: only ?? null, times, ok: true, why: '' };
}
