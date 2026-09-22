// GitHub alerts in real VS Code: a quote that opens with a bracketed type is drawn as a callout,
// a near miss stays a quote, and the marker comes back when the caret is in it.
//   node test/real-editor/run-editor.mjs alerts [id]
const j = (x) => JSON.stringify(x);

const FIVE = [
  ['NOTE', 'Note', 'The nightly export runs at 02:00.'],
  ['TIP', 'Tip', 'Pass --dry-run first.'],
  ['IMPORTANT', 'Important', 'Rotate the signing key.'],
  ['WARNING', 'Warning', 'Older replicas cannot read this.'],
  ['CAUTION', 'Caution', 'This deletes every checkpoint.'],
];
const ALL = `Intro paragraph.\n\n${FIVE.map(([m, , body]) => `> [!${m}]\n> ${body}`).join('\n\n')}\n\nAfter line\n`;

/** Every callout on screen: its type, the label a person reads, and the colour that label is drawn in. */
const callouts = (S) =>
  S.eval(() => {
    const type = (el) => (el.className.match(/tok-alert-(\w+)/) || [, null])[1];
    const lines = [...document.querySelectorAll('.cm-line')];
    return lines
      .filter((l) => l.querySelector('.md-alert-label'))
      .map((l) => {
        const label = l.querySelector('.md-alert-label');
        const name = label.querySelector('.md-alert-name');
        return {
          type: type(l),
          label: name ? name.textContent : label.textContent,
          icon: !!label.querySelector('.md-alert-icon'),
          colour: getComputedStyle(name || label).color,
          text: l.textContent,
        };
      });
  });

/** The text of every line drawn as a quote, callouts included. */
const quoteLines = (S) =>
  S.eval(() =>
    [...document.querySelectorAll('.cm-line')]
      .filter((l) => /tok-quote|tok-alert/.test(l.className))
      .map((l) => l.textContent)
  );

export const scenarios = [
  {
    id: 'render.alert.e01',
    feature: 'render.alert',
    name: 'Each of the five alert types is drawn as a callout with its own label, and no bracketed marker is left on screen',
    run: async (S) => {
      await S.fresh('alert-five', ALL);
      await S.sleep(700);
      const seen = await callouts(S);
      const want = FIVE.map(([m, label]) => [m.toLowerCase(), label]);
      const right = want.every(([type, label], i) => seen[i] && seen[i].type === type && seen[i].label === label && seen[i].icon);
      const brackets = (await quoteLines(S)).filter((t) => t.includes('[!'));
      const d = await S.disk();
      return {
        ok: seen.length === 5 && right && brackets.length === 0 && d === ALL,
        detail: `${seen.length} callouts ${j(seen.map((c) => [c.type, c.label, c.icon]))}; ${brackets.length} lines still showing a marker ${j(brackets)}${d === ALL ? '' : `; file changed to ${j(d)}`}`,
      };
    },
  },
  {
    id: 'render.alert.e02',
    feature: 'render.alert',
    name: 'The five callouts are drawn in five different colours, taken from the theme rather than the body text colour',
    run: async (S) => {
      await S.fresh('alert-colour', ALL);
      await S.sleep(700);
      const seen = await callouts(S);
      const body = await S.eval(() => getComputedStyle(document.querySelector('.cm-content')).color);
      const colours = new Set(seen.map((c) => c.colour));
      const sameAsBody = seen.filter((c) => c.colour === body).map((c) => c.type);
      return {
        ok: colours.size === 5 && sameAsBody.length === 0,
        detail: `${colours.size} distinct label colours ${j(seen.map((c) => [c.type, c.colour]))}; body ${body}; drawn in the body colour: ${j(sameAsBody)}`,
      };
    },
  },
  {
    id: 'render.alert.e03',
    feature: 'render.alert',
    name: 'A lower-case marker, a marker with a title and one of its own type are callouts, and a bracketed word is still a quote',
    run: async (S) => {
      const doc =
        'Intro.\n\n> [!note]\n> Lower case is a callout too.\n\n> [!NOTE] A custom title\n> The title is the label.\n\n> [!UNKNOWN]\n> A type of its own takes the note style and its own name.\n\n> [draft] notes\n> A bracketed word is not a marker.\n\nAfter line\n';
      await S.fresh('alert-near-miss', doc);
      await S.sleep(700);
      const seen = await callouts(S);
      const lines = await quoteLines(S);
      const kept = lines.filter((t) => t.includes('[draft] notes'));
      const d = await S.disk();
      const got = seen.map((c) => [c.type, c.label]);
      const want = [['note', 'Note'], ['note', 'A custom title'], ['note', 'UNKNOWN']];
      return {
        ok: j(got) === j(want) && kept.length === 1 && d === doc,
        detail: `${seen.length} callouts ${j(got)}; bracketed word kept as written: ${j(kept)}${d === doc ? '' : `; file changed to ${j(d)}`}`,
      };
    },
  },
  {
    id: 'render.alert.e04',
    feature: 'render.alert',
    name: 'Writing in a callout keeps it drawn, and Edit Markdown brings its marker back as written',
    run: async (S) => {
      const doc = 'Intro.\n\n> [!WARNING]\n> Older replicas cannot read this.\n\nAfter line\n';
      await S.fresh('alert-reveal', doc);
      await S.sleep(700);
      const drawn = await callouts(S);
      // The body is where a person writes, so the callout stays drawn there, the way a
      // quote keeps its rule while you type in it.
      await S.caret('Older replicas', 3);
      await S.sleep(400);
      const whileInBody = await callouts(S);
      // Edit Markdown is how every construct shows what is written behind it, alerts included.
      await S.press('Meta+Alt+e');
      await S.sleep(400);
      const onMarker = await quoteLines(S);
      const whileOnMarker = await callouts(S);
      await S.press('Meta+Alt+e');
      await S.sleep(400);
      const back = await callouts(S);
      const d = await S.disk();
      return {
        ok:
          drawn.length === 1 &&
          whileInBody.length === 1 &&
          whileOnMarker.length === 0 &&
          onMarker.some((t) => t.includes('[!WARNING]')) &&
          back.length === 1 &&
          d === doc,
        detail: `drawn ${j(drawn.map((c) => c.label))}; caret in the body ${whileInBody.length} callouts; with Edit Markdown on ${whileOnMarker.length} callouts and lines ${j(onMarker)}; after putting it away ${j(back.map((c) => c.label))}${d === doc ? '' : `; file changed to ${j(d)}`}`,
      };
    },
  },
  {
    id: 'render.alert.e06',
    feature: 'render.alert',
    name: 'A marker inside a quote nested in another quote stays text, as it does on GitHub',
    run: async (S) => {
      const doc = 'Intro.\n\n> [!NOTE]\n> Outer.\n>\n> > [!CAUTION]\n> > Inner.\n\nAfter line\n';
      await S.fresh('alert-nested', doc);
      await S.sleep(700);
      const seen = await callouts(S);
      const lines = await quoteLines(S);
      const kept = lines.filter((t) => t.includes('[!CAUTION]'));
      const d = await S.disk();
      return {
        ok: seen.length === 1 && seen[0].type === 'note' && kept.length === 1 && d === doc,
        detail: `${seen.length} callouts ${j(seen.map((c) => [c.type, c.label]))}; the nested marker as written: ${j(kept)}${d === doc ? '' : `; file changed to ${j(d)}`}`,
      };
    },
  },
  {
    id: 'render.alert.e05',
    feature: 'render.alert',
    name: "The project's own dialects document draws its five alerts and is left byte for byte as it was",
    run: async (S) => {
      const path = await S.open('edge/dialects.md');
      await S.sleep(900);
      const before = await S.disk(path);
      const seen = await callouts(S);
      // Six, because the file also has a lower-case marker under the five named types.
      const types = seen.map((c) => c.type);
      await S.caret('nightly export', 3);
      await S.sleep(400);
      await S.caret('Lower-case markers', 3);
      await S.sleep(400);
      const after = await S.disk(path);
      return {
        ok: seen.length >= 5 && ['note', 'tip', 'important', 'warning', 'caution'].every((t) => types.includes(t)) && after === before,
        detail: `${seen.length} callouts ${j(types)}; file ${after === before ? 'unchanged' : 'CHANGED'}`,
      };
    },
  },
  {
    id: 'render.alert.e07',
    feature: 'render.alert',
    name: 'A callout written folded or foldable is drawn open, with its title as the label and no fold marker left on screen',
    run: async (S) => {
      const doc = 'Intro.\n\n> [!TIP]-\n> Folded shut on other sites.\n\n> [!WARNING]+ Read this first\n> Foldable, open by default.\n\nAfter line\n';
      await S.fresh('alert-fold', doc);
      await S.sleep(700);
      const seen = await callouts(S);
      const lines = await quoteLines(S);
      const bodies = lines.filter((t) => t.includes('Folded shut') || t.includes('Foldable, open'));
      const d = await S.disk();
      const got = seen.map((c) => [c.type, c.label]);
      const stray = seen.filter((c) => /^[+-]|\s[+-]\s|[+-]$/.test(c.text.trim()));
      return {
        ok: j(got) === j([['tip', 'Tip'], ['warning', 'Read this first']]) && bodies.length === 2 && stray.length === 0 && d === doc,
        detail: `${seen.length} callouts ${j(got)}; marker lines ${j(seen.map((c) => c.text))}; bodies shown ${bodies.length}${d === doc ? '' : `; file changed to ${j(d)}`}`,
      };
    },
  },
  {
    id: 'render.alert.e08',
    feature: 'render.alert',
    name: 'An empty marker, a task box and a title with no space before it all stay quotes, written as they are',
    run: async (S) => {
      const doc = 'Intro.\n\n> [!]\n> Empty marker.\n\n> [ ] a box\n> Task-like.\n\n> [!NOTE]Title\n> No space.\n\nAfter line\n';
      await S.fresh('alert-near-miss-2', doc);
      await S.sleep(700);
      const seen = await callouts(S);
      const lines = await quoteLines(S);
      const want = ['[!]', '[ ] a box', '[!NOTE]Title'];
      const kept = want.filter((w) => lines.some((t) => t.includes(w)));
      const d = await S.disk();
      return {
        ok: seen.length === 0 && kept.length === want.length && d === doc,
        detail: `${seen.length} callouts ${j(seen.map((c) => [c.type, c.label]))}; kept as written ${j(kept)} of ${j(want)}; quote lines ${j(lines)}${d === doc ? '' : `; file changed to ${j(d)}`}`,
      };
    },
  },
];
