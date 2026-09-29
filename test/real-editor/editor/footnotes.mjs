// Footnotes in real VS Code: a reference drawn as a raised number, its note drawn where it is
// written, and Cmd-click from one to the other and back, which only a real pointer with a real
// modifier held across the click can show.
//   node test/real-editor/run-editor.mjs footnotes [id]
const j = (x) => JSON.stringify(x);

const DOC =
  'The beacon runs at 1420 MHz[^band] and has since 2229.\n\n' +
  'Filler paragraph one, to put some distance between the reference and its note.\n\n' +
  'Filler paragraph two, for the same reason.\n\n' +
  '[^band]: The hydrogen line, chosen because every receiver already looks there.\n';

/** The line the caret is on, as text. */
const caretLine = (S) =>
  S.eval(() => {
    const content = document.querySelector('.cm-content');
    const tile = content && (content.cmTile || content.cmView);
    const view = tile && ((tile.root && tile.root.view) || tile.view);
    if (!view) return null;
    return view.state.doc.lineAt(view.state.selection.main.head).text;
  });

export const scenarios = [
  {
    id: 'render.footnotes.e01',
    feature: 'render.footnotes',
    name: 'A footnote reference is a raised number whose tooltip is the note, and its note shows the same number',
    run: async (S) => {
      await S.fresh('footnotes-draw', DOC);
      await S.sleep(900);
      const m = await S.eval(() => {
        const ref = document.querySelector('.md-footnote-ref');
        const num = document.querySelector('.md-footnote-num');
        const text = document.querySelector('.cm-content')?.textContent ?? '';
        return {
          ref: ref ? { n: ref.textContent, title: ref.title, align: getComputedStyle(ref).verticalAlign } : null,
          num: num?.textContent ?? null,
          defLines: document.querySelectorAll('.cm-line.md-footnote-def').length,
          sourceShowing: text.includes('[^band]'),
        };
      });
      const d = await S.disk();
      return {
        ok:
          m.ref?.n === '1' &&
          m.ref.title.startsWith('The hydrogen line') &&
          m.ref.align === 'super' &&
          m.num === '1' &&
          m.defLines === 1 &&
          !m.sourceShowing &&
          d === DOC,
        detail: `${j(m)}${d === DOC ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.footnotes.e02',
    feature: 'render.footnotes',
    name: 'Cmd-click on a footnote number goes to its note, and Cmd-click on the note\'s number comes back',
    run: async (S) => {
      await S.fresh('footnotes-jump', DOC);
      await S.sleep(900);
      await S.caret('Filler paragraph two', 0);
      await S.click({ sel: '.md-footnote-ref' }, { modifiers: ['Meta'] });
      await S.sleep(400);
      const there = await caretLine(S);
      await S.click({ sel: '.md-footnote-num' }, { modifiers: ['Meta'] });
      await S.sleep(400);
      const back = await caretLine(S);
      const d = await S.disk();
      return {
        ok: !!there?.startsWith('[^band]:') && !!back?.startsWith('The beacon runs') && d === DOC,
        detail: `after the first click the caret is on ${j(there)}, after the second on ${j(back)}${d === DOC ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.footnotes.e03',
    feature: 'render.footnotes',
    name: 'A reference whose label nothing defines stays as written, brackets and all',
    run: async (S) => {
      // Someone writing as they go has the reference before the note, and github.com leaves it as
      // written until the note exists. A raised number pointing at nothing would be worse.
      const doc = 'A claim[^nope] with no note for it.\n\nAnother paragraph.\n';
      await S.fresh('footnotes-undefined', doc);
      await S.sleep(900);
      const m = await S.eval(() => ({
        refs: document.querySelectorAll('.md-footnote-ref').length,
        text: document.querySelector('.cm-content')?.textContent ?? '',
      }));
      const d = await S.disk();
      return { ok: m.refs === 0 && m.text.includes('[^nope]') && d === doc, detail: `${j(m.refs)} raised numbers; ${j(m.text.slice(0, 60))}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.footnotes.e04',
    feature: 'render.footnotes',
    name: 'A label with a space in it, and an empty one, are ordinary text even when something defines them',
    run: async (S) => {
      const doc = 'One[^ spaced] and two[^] here.\n\n[^ spaced]: A note.\n\n[^]: Another note.\n';
      await S.fresh('footnotes-bad-labels', doc);
      await S.sleep(900);
      const m = await S.eval(() => ({
        refs: document.querySelectorAll('.md-footnote-ref').length,
        nums: document.querySelectorAll('.md-footnote-num').length,
        text: document.querySelector('.cm-content')?.textContent ?? '',
      }));
      const d = await S.disk();
      const ok = m.refs === 0 && m.nums === 0 && m.text.includes('[^ spaced]') && m.text.includes('[^]') && d === doc;
      return { ok, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.footnotes.e05',
    feature: 'render.footnotes',
    name: 'Numbers follow the order the references appear in, not the order the notes are written',
    run: async (S) => {
      // GitHub numbers by first reference. Here the notes are written the other way round, so a
      // numbering taken from the notes would read 2, 1 in the text.
      const doc = 'First a[^alpha], then b[^beta].\n\n[^beta]: The note for beta.\n\n[^alpha]: The note for alpha.\n';
      await S.fresh('footnotes-order', doc);
      await S.sleep(900);
      const m = await S.eval(() => ({
        refs: [...document.querySelectorAll('.md-footnote-ref')].map((e) => ({ n: e.textContent, title: (e.title || '').slice(0, 20) })),
        nums: [...document.querySelectorAll('.md-footnote-num')].map((e) => e.textContent),
      }));
      const d = await S.disk();
      const ok =
        m.refs.length === 2 &&
        m.refs[0].n === '1' &&
        m.refs[0].title.startsWith('The note for alpha') &&
        m.refs[1].n === '2' &&
        m.refs[1].title.startsWith('The note for beta') &&
        j(m.nums) === j(['2', '1']) &&
        d === doc;
      return { ok, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.footnotes.e06',
    feature: 'render.footnotes',
    name: 'The same note referenced twice is the same number both times',
    run: async (S) => {
      const doc = 'Here[^band] and again here[^band].\n\n[^band]: The hydrogen line.\n';
      await S.fresh('footnotes-twice', doc);
      await S.sleep(900);
      const m = await S.eval(() => ({
        refs: [...document.querySelectorAll('.md-footnote-ref')].map((e) => e.textContent),
        nums: [...document.querySelectorAll('.md-footnote-num')].map((e) => e.textContent),
      }));
      const d = await S.disk();
      return { ok: j(m.refs) === j(['1', '1']) && j(m.nums) === j(['1']) && d === doc, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.footnotes.e07',
    feature: 'render.footnotes',
    name: 'A label written in another case still finds its note',
    run: async (S) => {
      const doc = 'The beacon[^Band] runs.\n\n[^band]: The hydrogen line.\n';
      await S.fresh('footnotes-case', doc);
      await S.sleep(900);
      const m = await S.eval(() => {
        const ref = document.querySelector('.md-footnote-ref');
        return { n: ref?.textContent ?? null, title: (ref?.title ?? '').slice(0, 20), nums: document.querySelectorAll('.md-footnote-num').length };
      });
      const d = await S.disk();
      return { ok: m.n === '1' && m.title.startsWith('The hydrogen') && m.nums === 1 && d === doc, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.footnotes.e08',
    feature: 'render.footnotes',
    name: 'Where a label is defined twice, the first note is the one the number points at',
    run: async (S) => {
      const doc = 'The beacon[^band] runs.\n\n[^band]: The first note.\n\n[^band]: The second note.\n';
      await S.fresh('footnotes-redefined', doc);
      await S.sleep(900);
      const m = await S.eval(() => {
        const ref = document.querySelector('.md-footnote-ref');
        return { title: (ref?.title ?? '').slice(0, 30), nums: document.querySelectorAll('.md-footnote-num').length };
      });
      const d = await S.disk();
      return { ok: m.title.startsWith('The first note') && d === doc, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.footnotes.e09',
    feature: 'render.footnotes',
    name: 'A reference written inside code is code, in a sentence and in a fenced block',
    run: async (S) => {
      const doc =
        'Write `[^band]` to make one, and a real one[^band] here.\n\n' +
        '```\n[^band] in a block\n```\n\n' +
        '[^band]: The hydrogen line.\n';
      await S.fresh('footnotes-in-code', doc);
      await S.sleep(900);
      const m = await S.eval(() => ({
        refs: document.querySelectorAll('.md-footnote-ref').length,
        text: document.querySelector('.cm-content')?.textContent ?? '',
      }));
      const d = await S.disk();
      const ok = m.refs === 1 && m.text.includes('[^band] in a block') && d === doc;
      return { ok, detail: `${m.refs} raised numbers, one expected${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.footnotes.e10',
    feature: 'render.footnotes',
    name: 'A note that runs to a second paragraph keeps both in the note, and the paragraph after it is ordinary text',
    run: async (S) => {
      // Four spaces of indent carry a note on, blank line and all. The line after that is not the
      // note, and drawing it as one would quietly restyle whatever follows every footnote.
      const doc =
        'The beacon[^band] runs.\n\n' +
        '[^band]: The hydrogen line.\n\n' +
        '    Chosen because every receiver already looks there.\n\n' +
        'An ordinary paragraph after the note.\n';
      await S.fresh('footnotes-multiline', doc);
      await S.sleep(900);
      const m = await S.eval(() => ({
        def: [...document.querySelectorAll('.cm-line.md-footnote-def')].map((l) => l.textContent.slice(0, 30)),
        after: [...document.querySelectorAll('.cm-line')].some(
          (l) => l.textContent.startsWith('An ordinary paragraph') && l.classList.contains('md-footnote-def')
        ),
      }));
      const d = await S.disk();
      const ok = m.def.length >= 1 && !m.after && d === doc;
      return { ok, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
];
