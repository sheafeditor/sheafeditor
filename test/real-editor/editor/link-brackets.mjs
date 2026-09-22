// A link whose text holds balanced square brackets, which CommonMark and GitHub read as one link.
//
// The click scenario beside it in `render` only tests brackets that are not links. This asks the
// real window whether a link with brackets in its text is drawn as a link, with a plain link on the
// next line as the control, so a pass means the check could have failed.
//   node test/real-editor/run-editor.mjs link-brackets [id]
const j = (x) => JSON.stringify(x);

const DOC = 'Intro.\n\nA [link [with] brackets](https://example.com) here.\n\nA [plain link](https://example.com) here.\n\nNext.\n';

/** The rendered text of a line, and whether a link is drawn on it. */
const line = (S, starts) =>
  S.eval((starts) => {
    const l = [...document.querySelectorAll('.cm-line')].find((x) => x.textContent.startsWith(starts));
    if (!l) return null;
    return { text: l.textContent, links: [...l.querySelectorAll('.tok-link, a, [data-href]')].map((a) => a.textContent) };
  }, starts);

export const scenarios = [
  {
    id: 'render.links.nested-brackets',
    feature: 'render.links',
    name: 'A link whose text holds balanced brackets is drawn as a link, with the brackets inside its text kept',
    run: async (S) => {
      await S.fresh('link-brackets', DOC);
      await S.caret('Next', 2); // the caret off both lines, so neither reveals its syntax
      await S.sleep(500);
      const nested = await line(S, 'A ');
      const plain = await line(S, 'A plain');
      // The control: a plain link on the next line must render, or the check below means nothing.
      const controlOk = plain && plain.text === 'A plain link here.';
      const ok = controlOk && nested && nested.text === 'A link [with] brackets here.';
      return { ok, detail: `nested ${j(nested)}; control ${j(plain)}` };
    },
  },
];
