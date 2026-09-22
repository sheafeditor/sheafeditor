// Headings at levels 4 to 6, which Markdown has and which are easy to leave out of a menu.
//
// Turn into, the Text style menu and the toolbar state each have to name a level-4 or level-5
// heading as what it is. These scenarios ask what a person sees on such a heading: that the menu
// names its level, that changing the level changes only its hashes, that typing elsewhere leaves
// it alone, and that each level is drawn smaller than the one above it.
//   node test/real-editor/run-editor.mjs deep-headings [id]
const j = (x) => JSON.stringify(x);

const DOC = '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\nBody text here.\n';

/** The Text style trigger's label, and which item the menu marks as the block's current kind. */
const menuState = async (S) => {
  const label = await S.eval(() => {
    const t = [...document.querySelectorAll('#toolbar button')].find((b) => (b.title || '').startsWith('Text style') || /Heading|Text/.test(b.textContent));
    return t ? t.textContent.trim() : null;
  });
  await S.toolbar('Text style');
  await S.sleep(300);
  const items = await S.eval(() =>
    [...document.querySelectorAll('.sheaf-tb-menu-item, [role="menuitemradio"], [role="option"]')].map((el) => ({
      text: el.textContent.trim().slice(0, 20),
      checked: el.getAttribute('aria-checked') === 'true' || el.className.includes('is-current') || el.className.includes('is-checked'),
    }))
  );
  await S.press('Escape');
  await S.sleep(200);
  return { label, items, checked: items.filter((i) => i.checked).map((i) => i.text) };
};

export const scenarios = [
  {
    id: 'prose.deep-headings.h4-reads-as-itself',
    feature: 'prose.text-style',
    name: 'With the caret in a Heading 4, the Text style menu says the block is a Heading 4, not body text',
    run: async (S) => {
      await S.fresh('h4-state', DOC);
      await S.sleep(600);
      await S.caret('Four', 2);
      await S.sleep(300);
      const m = await menuState(S);
      // A person reading the menu should be able to tell what the block is. Marking nothing is a
      // weaker failure than marking Text, which says the block is something it is not.
      const saysText = m.checked.some((c) => /^Text/i.test(c));
      return {
        ok: m.checked.length > 0 && !saysText,
        detail: `trigger ${j(m.label)}; menu marks ${j(m.checked)}; items ${j(m.items.map((i) => i.text))}`,
      };
    },
  },
  {
    id: 'prose.deep-headings.h4-to-h3-keeps-the-text',
    feature: 'prose.text-style',
    name: 'Turning a Heading 4 into a Heading 3 changes only its hashes',
    run: async (S) => {
      await S.fresh('h4-to-h3', DOC);
      await S.sleep(600);
      await S.caret('Four', 2);
      await S.toolbar('Text style');
      await S.sleep(300);
      await S.menu('Heading 3');
      await S.sleep(400);
      const d = await S.disk();
      const want = DOC.replace('#### Four', '### Four');
      return { ok: d === want, detail: d === want ? '' : j(d) };
    },
  },
  {
    id: 'prose.deep-headings.h5-survives-an-edit-elsewhere',
    feature: 'prose.text-style',
    name: 'Typing in the body leaves a Heading 5 exactly as it was written',
    run: async (S) => {
      await S.fresh('h5-untouched', DOC);
      await S.sleep(600);
      await S.caret('Body text', 4);
      await S.type('Z');
      const d = await S.disk();
      const want = DOC.replace('Body text here.', 'BodyZ text here.');
      return { ok: d === want, detail: d === want ? '' : j(d) };
    },
  },
  {
    id: 'prose.deep-headings.h4-and-h5-are-drawn-smaller',
    feature: 'render.headings',
    name: 'A Heading 4 and a Heading 5 are drawn as headings, each smaller than the one above it',
    run: async (S) => {
      await S.fresh('h4-h5-size', DOC);
      await S.sleep(700);
      const sizes = await S.eval(() => {
        const of = (text) => {
          const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.trim() === text);
          if (!line) return null;
          const cs = getComputedStyle(line.querySelector('span') || line);
          return { px: Math.round(parseFloat(cs.fontSize)), weight: cs.fontWeight };
        };
        return { h3: of('Three'), h4: of('Four'), h5: of('Five'), body: of('Body text here.') };
      });
      const { h3, h4, h5, body } = sizes;
      const ok = h3 && h4 && h5 && body && h4.px <= h3.px && h5.px <= h4.px && h4.px >= body.px && Number(h4.weight) > Number(body.weight);
      return { ok, detail: j(sizes) };
    },
  },
];
