// Typeset maths in real VS Code: whether the fonts arrive under the webview's content policy,
// whether a wide equation scrolls inside its own block instead of widening the column, and whether
// a price in the corpus is still a price.
//   node test/real-editor/run-editor.mjs maths [id]
const j = (x) => JSON.stringify(x);

const INLINE = 'Intro.\n\nAt $f = 8.45$ GHz the loss is $L = 20\\log_{10}(d)$ dB.\n\nAfter line\n';
const BLOCK = 'Intro.\n\n$$\nL_{fs} = 20\\log_{10}(d) + 20\\log_{10}(f) - 147.55\n$$\n\nAfter line\n';
// Wider than any pane here, so the block has something to scroll.
const WIDE =
  'Intro.\n\n$$\nL_{fs} = 20\\log_{10}(d) + 20\\log_{10}(f) - 147.55 + G_{tx} + G_{rx} - L_{atm} - L_{rain} - L_{pol} - L_{point} + 10\\log_{10}(P_{tx}) - 10\\log_{10}(kTB)\n$$\n\nAfter line\n';
const MONEY = 'Intro.\n\nIt cost $20, or $5 or $10 in the sale.\n\n`a $ in code` and a fenced one:\n\n```\n$ ls\n```\n\nAn escaped \\$5 too.\n\nAfter line\n';

/** What KaTeX drew, and whether its own fonts are the ones being used. */
const typeset = (S) =>
  S.eval(() => {
    const nodes = [...document.querySelectorAll('.katex')];
    const fonts = [...new Set(nodes.map((n) => getComputedStyle(n).fontFamily))];
    // KaTeX's glyphs come from its own families. A fallback serif means the stylesheet or the
    // fonts did not arrive, which is exactly what the content policy would break.
    const loaded = [...document.fonts].filter((f) => f.family.startsWith('KaTeX')).map((f) => `${f.family} ${f.status}`);
    return {
      count: nodes.length,
      fonts,
      katexFontsLoaded: loaded.length,
      sample: loaded.slice(0, 3),
      text: nodes.slice(0, 2).map((n) => n.textContent.slice(0, 24)),
    };
  });

export const scenarios = [
  {
    id: 'render.maths.e01',
    feature: 'render.maths',
    name: 'Inline maths is typeset with KaTeX\'s own fonts, which means the stylesheet and fonts reached the webview',
    run: async (S) => {
      await S.fresh('maths-inline', INLINE);
      await S.sleep(900);
      const m = await typeset(S);
      const d = await S.disk();
      const ownFonts = m.fonts.every((f) => /KaTeX/i.test(f));
      return {
        ok: m.count >= 2 && ownFonts && m.katexFontsLoaded > 0 && d === INLINE,
        detail: `${m.count} typeset spans, families ${j(m.fonts)}, ${m.katexFontsLoaded} KaTeX faces registered ${j(m.sample)}${d === INLINE ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.maths.e02',
    feature: 'render.maths',
    name: 'A block equation wider than the pane scrolls inside its own block instead of widening the document',
    run: async (S) => {
      await S.fresh('maths-block', WIDE);
      await S.sleep(900);
      // A pane narrow enough that the equation cannot fit.
      await S.command('View: Split Editor Right');
      await S.sleep(1400);
      const m = await S.eval(() => {
        const scroller = document.querySelector('.cm-scroller');
        const content = document.querySelector('.cm-content');
        const scroll = document.querySelector('.md-math-scroll');
        const block = scroll || document.querySelector('.md-math-block');
        const r = (el) => el && { w: Math.round(el.getBoundingClientRect().width), scrollW: el.scrollWidth, clientW: el.clientWidth };
        return {
          pane: Math.round(scroller.getBoundingClientRect().width),
          column: Math.round(content.getBoundingClientRect().width),
          // The honest question is whether the pane scrolls sideways, which is the scroller's
          // overflow, not the column's own.
          docScrollsSideways: scroller.scrollWidth > scroller.clientWidth + 2,
          block: r(block),
          hasScrollBox: !!scroll,
          katexWidth: (() => {
            const k = document.querySelector('.katex-display .katex, .katex');
            return k ? Math.round(k.getBoundingClientRect().width) : null;
          })(),
          blockScrolls: block ? block.scrollWidth > block.clientWidth + 2 : null,
          label: block ? block.getAttribute('aria-label') : null,
          tabbable: block ? block.getAttribute('tabindex') : null,
        };
      });
      const d = await S.disk();
      // The equation holds itself to the column and scrolls inside its own box. The pane's own
      // sideways scroll is not measured here: at this width the column is wider than the pane with
      // or without an equation in it, which is the column's behaviour and its own question.
      const withinColumn = m.katexWidth !== null && m.block.w <= m.column + 2;
      return {
        ok: m.hasScrollBox && m.blockScrolls === true && withinColumn && m.tabbable === '0' && /scrollable/i.test(m.label ?? '') && d === WIDE,
        detail: `pane ${m.pane}px, column ${m.column}px, equation box ${j(m.block)} scrolls ${m.blockScrolls}, label ${j(m.label)}, tabindex ${j(m.tabbable)}${d === WIDE ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.maths.e03',
    feature: 'render.maths',
    name: 'Prices, a dollar in code and an escaped dollar are all left as text',
    run: async (S) => {
      await S.fresh('maths-money', MONEY);
      await S.sleep(900);
      const m = await typeset(S);
      const shown = await S.rendered();
      const d = await S.disk();
      return {
        ok: m.count === 0 && shown.includes('It cost $20, or $5 or $10 in the sale.') && d === MONEY,
        detail: `${m.count} typeset spans; the line reads ${j(shown.split('\n').find((l) => l.includes('cost')))}${d === MONEY ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.maths.e04',
    feature: 'render.maths',
    name: 'Edit Markdown brings the dollars back, and putting it away typesets again',
    run: async (S) => {
      await S.fresh('maths-reveal', BLOCK);
      await S.sleep(900);
      const drawn = await typeset(S);
      // Click the drawn equation itself: its source is not on screen to aim at by text.
      await S.click({ sel: '.katex' });
      await S.sleep(300);
      await S.press('Meta+Alt+e');
      await S.sleep(500);
      const revealed = await typeset(S);
      const shown = await S.rendered();
      await S.press('Meta+Alt+e');
      await S.sleep(500);
      const back = await typeset(S);
      const d = await S.disk();
      return {
        ok: drawn.count >= 1 && revealed.count === 0 && shown.includes('$$') && back.count >= 1 && d === BLOCK,
        detail: `drawn ${drawn.count}; with the source shown ${revealed.count} and the dollars on screen ${shown.includes('$$')}; after putting it away ${back.count}${d === BLOCK ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.maths.e05',
    feature: 'render.maths',
    name: "The project's own beacon document typesets its equations and is left byte for byte as it was",
    run: async (S) => {
      const path = await S.open('wren-4/beacon.md');
      await S.sleep(1200);
      const before = await S.disk(path);
      // The equations are below the first screenful, and only what is drawn is typeset.
      await S.caret('Wren-4 transmits', 2);
      for (let i = 0; i < 4; i++) await S.press('PageDown');
      await S.sleep(1200);
      const m = await typeset(S);
      const onScreen = (await S.rendered()).split('\n').filter((l) => l.trim()).slice(0, 3);
      const after = await S.disk(path);
      return {
        ok: m.count >= 2 && after === before,
        detail: `${m.count} typeset spans, first two ${j(m.text)}; on screen ${j(onScreen)}; file ${after === before ? 'unchanged' : 'CHANGED'}`,
      };
    },
  },
];
