// Hard line breaks on screen: does a break read right in a real window, and do the look-alikes stay literal?
// sample/edge/hard-breaks.md lays out breaks written both ways and look-alikes that are not breaks. Sheaf draws every
// source line as its own row, so whether lines join cannot be seen either way. What a window settles is whether the
// marker is hidden where a break is, still shown where it is literal, and whether emphasis carries across the break.
//   node test/real-editor/run-editor.mjs hard-breaks [id]
import { readFileSync } from 'node:fs';

const j = (x) => JSON.stringify(x);
const SAMPLE = 'edge/hard-breaks.md';

/** Every rendered row: its text and its top, in document order. */
const rows = (S) =>
  S.eval(() =>
    [...document.querySelectorAll('.cm-line')].map((l) => ({ text: l.textContent, top: Math.round(l.getBoundingClientRect().top) }))
  );

/**
 * Every row of the whole document, scrolling to reach them: CodeMirror only draws rows near the viewport, so the
 * look-alike section below the fold is absent from a single read. Keeps the first sighting of each row's text.
 */
async function allRows(S) {
  const seen = new Map();
  const sc = await S.locate({ sel: '.cm-scroller' });
  await S.page.mouse.move(sc.x, sc.y, { steps: 3 });
  for (let i = 0; i < 25; i++) {
    for (const r of await rows(S)) if (!seen.has(r.text)) seen.set(r.text, r);
    const atEnd = await S.eval(() => {
      const el = document.querySelector('.cm-scroller');
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    });
    if (atEnd) break;
    await S.page.mouse.wheel(0, 400);
    await S.sleep(250);
  }
  return [...seen.values()];
}

const startingWith = (all, prefix) => all.find((r) => r.text.trim().startsWith(prefix));
const endsWithBackslash = (r) => !!r && /\\\s*$/.test(r.text);

async function openSample(S) {
  const sb = await S.page.locator('.statusbar').boundingBox().catch(() => null);
  if (sb) await S.page.mouse.click(sb.x + 10, sb.y + sb.height / 2);
  await S.page.keyboard.press('Escape');
  const path = await S.open(SAMPLE);
  await S.sleep(800);
  return path;
}

export const scenarios = [
  {
    id: 'prose.hard-break.screen-break-markers-hidden',
    feature: 'prose.hard-break',
    name: 'Every line that ends a hard break shows no backslash on screen, in a paragraph, emphasis, a quote and a list item',
    run: async (S) => {
      await openSample(S);
      const all = await rows(S);
      const cases = {
        'First line': startingWith(all, 'First line'),
        '**When:** line': startingWith(all, 'When:') || startingWith(all, '**When:**'),
        'emphasis line': startingWith(all, 'Inside emphasis:'),
        'quote line': all.find((r) => r.text.includes('In a quote, first line')),
        'list item line': all.find((r) => r.text.includes('In a list item, first line')),
      };
      const missing = Object.entries(cases).filter(([, r]) => !r).map(([k]) => k);
      const showingMarker = Object.entries(cases).filter(([, r]) => endsWithBackslash(r)).map(([k]) => k);
      await S.shot('hard-breaks');
      return {
        ok: missing.length === 0 && showingMarker.length === 0,
        detail: `rows found ${j(Object.fromEntries(Object.entries(cases).map(([k, r]) => [k, r ? r.text : null])))}; missing ${j(missing)}; still showing a backslash ${j(showingMarker)}`,
      };
    },
  },
  {
    id: 'prose.hard-break.screen-look-alikes-stay-literal',
    feature: 'prose.hard-break',
    name: 'A paragraph-final backslash, a heading, a code span and a fenced line all still show their backslash',
    run: async (S) => {
      await openSample(S);
      const all = await allRows(S);
      const cases = {
        'paragraph-final backslash': all.find((r) => r.text.includes('is a literal backslash')),
        heading: all.find((r) => r.text.includes('stays one line')),
        'code span': all.find((r) => r.text.includes('code with a trailing backslash')),
        'inside a fence': all.find((r) => r.text.includes('a backslash is just a character')),
      };
      const missing = Object.entries(cases).filter(([, r]) => !r).map(([k]) => k);
      const lostMarker = Object.entries(cases).filter(([, r]) => r && !endsWithBackslash(r)).map(([k]) => k);
      return {
        ok: missing.length === 0 && lostMarker.length === 0,
        detail: `rows ${j(Object.fromEntries(Object.entries(cases).map(([k, r]) => [k, r ? r.text : null])))}; missing ${j(missing)}; backslash no longer shown ${j(lostMarker)}`,
      };
    },
  },
  {
    id: 'prose.hard-break.screen-emphasis-carries-across-the-break',
    feature: 'prose.hard-break',
    name: 'The line after a break inside emphasis is still drawn italic',
    run: async (S) => {
      await openSample(S);
      const style = await S.eval(() => {
        const want = 'second line, still italic';
        const els = [...document.querySelectorAll('.cm-line *')].filter((e) => e.textContent.includes(want) && !e.querySelector('*'));
        const el = els[0] || [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(want));
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { tag: el.tagName, className: el.className, fontStyle: cs.fontStyle, text: el.textContent.slice(0, 40) };
      });
      return { ok: !!style && style.fontStyle === 'italic', detail: j(style) };
    },
  },
  {
    id: 'prose.hard-break.screen-rows-are-separate-and-ordered',
    feature: 'prose.hard-break',
    name: 'The three lines of the backslash case are drawn as three rows, top to bottom',
    run: async (S) => {
      await openSample(S);
      const all = await rows(S);
      const first = startingWith(all, 'First line');
      const second = startingWith(all, 'Second line');
      const third = startingWith(all, 'Third line');
      const ok = first && second && third && first.top < second.top && second.top < third.top;
      return { ok: !!ok, detail: `tops ${j({ first: first?.top, second: second?.top, third: third?.top })}` };
    },
  },
  {
    id: 'prose.hard-break.screen-file-untouched',
    feature: 'prose.hard-break',
    name: 'Opening the sample, clicking in it and waiting past auto-save leaves every byte as it was, trailing spaces included',
    run: async (S) => {
      const path = await openSample(S);
      const before = readFileSync(path, 'utf8');
      await S.caret('Third line', 2);
      await S.sleep(2000);
      const after = readFileSync(path, 'utf8');
      const twoSpaceLines = (after.match(/ {2,}\n/g) || []).length;
      const backslashLines = (after.match(/\\\n/g) || []).length;
      return {
        ok: before === after && twoSpaceLines > 0 && backslashLines > 0,
        detail: `bytes identical ${before === after}; lines ending in two or more spaces ${twoSpaceLines}; lines ending in a backslash ${backslashLines}`,
      };
    },
  },
];
