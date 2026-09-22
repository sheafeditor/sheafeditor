/*
 * The width the text column is given, read from `sheaf.contentWidth`.
 *
 * The setting takes any string, and `--md-content-width` is a custom property, which
 * takes any string too. A mistyped value therefore reaches the `calc()` that sizes the
 * column, breaks it, and takes the column's bound away entirely: the text spreads over
 * the whole editor pane. These hold that a value that is not a CSS length is refused
 * before it gets there, that the column falls back to the default width, and that the
 * refusal is said out loud rather than shown as a layout nobody asked for.
 */

import { Scenario } from '../harness';
import { contentWidth, DEFAULT_CONTENT_WIDTH } from '../../src/webview/theme';

/** Run `fn` with `console.warn` captured, and return what it said. */
function warnings(fn: () => void): string[] {
  const said: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void said.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return said;
}

/** True when every one of these widths is refused for the default, warning as it goes. */
function allFallBack(values: string[]): boolean {
  let ok = true;
  warnings(() => {
    for (const v of values) ok = ok && contentWidth(v) === DEFAULT_CONTENT_WIDTH;
  });
  return ok;
}

export const scenarios: Scenario[] = [
  {
    name: 'a CSS length is the width the column gets',
    run: () =>
      ['708px', '90ch', '60%', '40em', '52rem', '0.5in', '80vw'].every((v) => contentWidth(v) === v),
  },
  {
    name: 'a width with space around it is read as the length it names',
    run: () => contentWidth('  820px \n') === '820px',
  },
  {
    name: 'a mistyped unit falls back to the default width rather than losing the column',
    run: () => allFallBack(['700pxx', '708 px', '708px;']),
  },
  {
    name: 'a word, a bare number and an empty setting all fall back to the default width',
    run: () => allFallBack(['wide', 'none', 'auto', 'min-content', '700', '', 'calc(100% - 4rem)']),
  },
  {
    name: 'a width of zero or less falls back, since either one loses the column too',
    run: () => allFallBack(['0px', '0', '-4px', '-2%']),
  },
  {
    name: 'a refused width is named in a warning, with what the setting takes',
    run: () => {
      const said = warnings(() => contentWidth('700pxxx'));
      return (
        said.length === 1 &&
        said[0].includes('700pxxx') &&
        said[0].includes(DEFAULT_CONTENT_WIDTH) &&
        said[0].includes('sheaf.contentWidth')
      );
    },
  },
  {
    name: 'the same refused width is reported once, not on every configuration change',
    run: () => {
      const first = warnings(() => contentWidth('12 furlongs'));
      const again = warnings(() => contentWidth('12 furlongs'));
      return first.length === 1 && again.length === 0;
    },
  },
  {
    name: 'a width the column accepts says nothing',
    run: () => warnings(() => contentWidth('708px')).length === 0,
  },
];
