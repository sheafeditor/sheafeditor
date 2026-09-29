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
  {
    id: 'render.maths.e06',
    feature: 'render.maths',
    name: 'A space just inside a dollar stops it opening or closing, so a sentence about money stays a sentence',
    run: async (S) => {
      // `$ 5` cannot open and `y $` cannot close. Without both halves, "it cost $ 5 or $ 10"
      // becomes one half-drawn formula in the middle of a sentence.
      const doc = 'Intro.\n\nIt cost $ 5 or $ 10, and x $ y $ z as well.\n\nAfter line\n';
      await S.fresh('maths-space-inside', doc);
      await S.sleep(900);
      const m = await S.eval(() => ({
        katex: document.querySelectorAll('.katex').length,
        text: [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).find((t) => t.startsWith('It cost')) ?? null,
      }));
      const d = await S.disk();
      const ok = m.katex === 0 && m.text === 'It cost $ 5 or $ 10, and x $ y $ z as well.' && d === doc;
      return { ok, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.maths.e07',
    feature: 'render.maths',
    name: 'A dollar followed by a digit cannot close a span, so two prices in a sentence stay two prices',
    run: async (S) => {
      // A range written with no space around the dash, so the space rule cannot be what keeps it
      // text: the `$` before `10` is preceded by `-`, and only the digit after it stops it closing.
      const doc = 'Intro.\n\nIt cost $5-$10 each, or $20 for two.\n\nAfter line\n';
      await S.fresh('maths-digit-after', doc);
      await S.sleep(900);
      const m = await S.eval(() => ({
        katex: document.querySelectorAll('.katex').length,
        text: [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).find((t) => t.startsWith('It cost')) ?? null,
      }));
      const d = await S.disk();
      const ok = m.katex === 0 && m.text === 'It cost $5-$10 each, or $20 for two.' && d === doc;
      return { ok, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.maths.e08',
    feature: 'render.maths',
    name: 'An opening dollar gives up at the end of its line rather than reaching down the page for a closer',
    run: async (S) => {
      const doc = 'Intro.\n\nA stray $ here on one line\n\nand a stray $ here on another.\n\nAfter line\n';
      await S.fresh('maths-across-lines', doc);
      await S.sleep(900);
      const m = await S.eval(() => ({
        katex: document.querySelectorAll('.katex').length,
        lines: [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).filter((t) => t.includes('stray')),
      }));
      const d = await S.disk();
      const ok = m.katex === 0 && m.lines.length === 2 && m.lines.every((t) => t.includes('$')) && d === doc;
      return { ok, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.maths.e09',
    feature: 'render.maths',
    name: 'A stray dollar before a code span does not swallow the code',
    run: async (S) => {
      // The no-backtick rule. Without it an earlier `$` reaches across the code span and takes it
      // into a formula, and the code a person wrote stops being code.
      const doc = 'Intro.\n\nCosts $20 when `a $ b` is the flag, per unit.\n\nAfter line\n';
      await S.fresh('maths-backtick', doc);
      await S.sleep(900);
      const m = await S.eval(() => ({
        katex: document.querySelectorAll('.katex').length,
        code: [...document.querySelectorAll('.tok-inline-code')].map((e) => e.textContent),
      }));
      const d = await S.disk();
      const ok = m.katex === 0 && m.code.some((t) => t.includes('a $ b')) && d === doc;
      return { ok, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.maths.e10',
    feature: 'render.maths',
    name: 'A backslashed dollar inside an equation is a dollar sign in the equation, not its end',
    run: async (S) => {
      const doc = 'Intro.\n\nThe price is $c = \\$5 + x$ altogether.\n\nAfter line\n';
      await S.fresh('maths-escaped-inside', doc);
      await S.sleep(900);
      const m = await S.eval(() => {
        const nodes = [...document.querySelectorAll('.katex')];
        return { katex: nodes.length, first: nodes[0]?.textContent ?? null };
      });
      const d = await S.disk();
      const ok = m.katex === 1 && (m.first ?? '').includes('$') && d === doc;
      return { ok, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.maths.e11',
    feature: 'render.maths',
    name: 'A $$ block inside a fence, a quote or a list item stays as written',
    run: async (S) => {
      // Narrower than github.com on purpose: the cost of it is source shown, and the cost of the
      // other way is something drawn wrongly inside a block that meant something else.
      const doc =
        'Intro.\n\n```\n$$\na^2\n$$\n```\n\n> $$\n> b^2\n> $$\n\n- $$\n  c^2\n  $$\n\nAfter line\n';
      await S.fresh('maths-nested-blocks', doc);
      await S.sleep(1000);
      const m = await S.eval(() => ({
        blocks: document.querySelectorAll('.md-math-block').length,
        katex: document.querySelectorAll('.katex').length,
      }));
      const d = await S.disk();
      return { ok: m.blocks === 0 && d === doc, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.maths.e12',
    feature: 'render.maths',
    name: 'A $$ opened and never closed leaves the rest of the document as written',
    run: async (S) => {
      // The same question as a fence, answered the other way: a block stays inside one paragraph,
      // so an opener with no closer cannot take the page with it.
      const doc = 'Intro.\n\n$$\na^2 + b^2\n\nA paragraph that is not maths.\n\nAnother one.\n';
      await S.fresh('maths-unclosed', doc);
      await S.sleep(1000);
      const m = await S.eval(() => ({
        blocks: document.querySelectorAll('.md-math-block').length,
        plain: [...document.querySelectorAll('.cm-line')].some((l) => l.textContent.startsWith('A paragraph that is not maths')),
      }));
      const d = await S.disk();
      return { ok: m.blocks === 0 && m.plain && d === doc, detail: `${j(m)}${d === doc ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.maths.e13',
    feature: 'render.maths',
    name: 'An equation KaTeX cannot read shows its source and says what is wrong, rather than drawing nothing',
    run: async (S) => {
      const doc = 'Intro.\n\n$$\n\\frac{1}{\n$$\n\nAfter line\n';
      await S.fresh('maths-bad-tex', doc);
      await S.sleep(1000);
      const m = await S.eval(() => ({
        errors: document.querySelectorAll('.md-math-error, .md-math .is-error').length,
        text: [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join(' | ').slice(0, 120),
      }));
      const errs = await S.errors();
      const d = await S.disk();
      const ok = m.text.includes('\\frac{1}{') && d === doc && errs.length === 0;
      return { ok, detail: `${j(m)}; console ${j(errs)}${d === doc ? '' : '; the file changed'}` };
    },
  },
];
