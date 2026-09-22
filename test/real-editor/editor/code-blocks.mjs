// Fenced code blocks on screen, in real VS Code: is a selection inside one visible, and does the block
// keep one unbroken background while the caret is in it?
//   node test/real-editor/run-editor.mjs code-blocks [id]
const j = (x) => JSON.stringify(x);

const DOC = 'Intro paragraph.\n\n```\nHello world inside a fence\nsecond line of code\n```\n\n## Stores\n\nAfter text.\n';

/** The code lines, what paints behind them, and the selection rectangles. */
/*
 * What a code block and the selection over it are actually drawing.
 *
 * A code line's tint may be painted by the line itself or by a pseudo-element
 * behind it, so both are read and `bg` reports whichever is painted. Reading only
 * the line would call an unpainted block and a painted one the same thing.
 *
 * Whether a rectangle is hidden is then a question of paint order, not of the
 * tint alone: the tint hides the selection only when it covers the rectangle and
 * sits at a strictly greater depth than the layer drawing the markers. Both
 * depths are read from the live CSSOM rather than assumed, since each is set in
 * a different file. At equal depth the layer wins, because it comes later in
 * tree order; that is the case today and a screenshot confirms the highlight
 * draws over the block.
 */
const look = (S) =>
  S.eval(() => {
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), w: Math.round(b.width) };
    };
    const opaque = (c) => c && c !== 'rgba(0, 0, 0, 0)' && !/,\s*0\)$/.test(c);
    const depth = (v) => (v === 'auto' || v === '' ? 0 : Number(v));
    // The markers are drawn by Sheaf's own layer, not CodeMirror's, so the depth
    // is read from whichever layer actually holds one.
    const firstMark = document.querySelector('.cm-selectionBackground');
    const layer = firstMark ? firstMark.closest('.cm-layer') : document.querySelector('.cm-selectionLayer');
    const layerDepth = layer ? depth(getComputedStyle(layer).zIndex) : 0;
    const layerClass = layer ? layer.className : 'none';
    const codeLines = [...document.querySelectorAll('.cm-line')]
      .filter((l) => l.className.includes('tok-code-block'))
      .map((l) => {
        const own = getComputedStyle(l).backgroundColor;
        const before = getComputedStyle(l, '::before');
        const tint = opaque(own) ? own : before.backgroundColor;
        return {
          text: l.textContent.slice(0, 30),
          bg: tint,
          paintedBy: opaque(own) ? 'line' : opaque(before.backgroundColor) ? 'before' : 'nothing',
          tintDepth: opaque(own) ? depth(getComputedStyle(l).zIndex) : depth(before.zIndex),
          active: l.className.includes('cm-activeLine'),
          ...box(l),
        };
      });
    const marks = [...document.querySelectorAll('.cm-selectionBackground')].map(box).filter((r) => r.w > 0);
    const hidden = marks.filter((m) =>
      codeLines.some((l) => l.top <= m.top + 2 && l.bottom >= m.bottom - 2 && opaque(l.bg) && l.tintDepth > layerDepth)
    );
    // A block that paints no tint at all is a regression of its own, so it is
    // reported rather than passing for want of anything to hide behind.
    const unpainted = codeLines.filter((l) => l.paintedBy === 'nothing').map((l) => l.text);
    return { codeLines, marks, hidden, unpainted, layerDepth, layerClass };
  });

export const scenarios = [
  {
    id: 'render.code-block.selection-visible-inside',
    feature: 'render.code-block',
    name: 'Text selected inside a code block is highlighted, not hidden behind the block',
    run: async (S) => {
      await S.fresh('fence-sel', DOC);
      await S.sleep(600);
      await S.select('world inside a fence');
      await S.sleep(300);
      const m = await look(S);
      return {
        ok: m.marks.length > 0 && m.hidden.length === 0 && m.unpainted.length === 0,
        detail: `${m.marks.length} selection rectangles, ${m.hidden.length} behind a code-block tint (layer depth ${m.layerDepth}); ${m.unpainted.length} lines painting no tint; lines ${j(m.codeLines.map((l) => [l.text, l.bg, l.paintedBy, l.tintDepth, l.active]))}`,
      };
    },
  },
  {
    id: 'render.code-block.one-unbroken-background',
    feature: 'render.code-block',
    name: 'A code block keeps one unbroken background while the caret is inside it',
    run: async (S) => {
      await S.fresh('fence-bg', DOC);
      await S.sleep(600);
      await S.caret('second line', 3);
      await S.sleep(300);
      const m = await look(S);
      const colours = new Set(m.codeLines.map((l) => l.bg));
      const active = m.codeLines.find((l) => l.active);
      const others = m.codeLines.filter((l) => !l.active).map((l) => l.bg);
      const sameAsOthers = active ? others.every((c) => c === active.bg) : true;
      return {
        ok: colours.size === 1 && sameAsOthers,
        detail: `${colours.size} background colours across ${m.codeLines.length} code lines; active line ${active ? j([active.text, active.bg]) : 'none'}; others ${j([...new Set(others)])}`,
      };
    },
  },
  {
    id: 'render.code-block.selection-from-prose-into-a-fence',
    feature: 'render.code-block',
    name: 'A selection running from the text above into a code block is visible all the way through it',
    run: async (S) => {
      await S.fresh('fence-across', DOC);
      await S.sleep(600);
      await S.click({ text: 'Intro paragraph', offset: 2 });
      await S.page.keyboard.down('Shift');
      await S.click({ text: 'second line', offset: 6 });
      await S.page.keyboard.up('Shift');
      await S.sleep(400);
      const m = await look(S);
      return {
        ok: m.hidden.length === 0 && m.marks.length > 0 && m.unpainted.length === 0,
        detail: `${m.hidden.length} of ${m.marks.length} selection rectangles hidden behind a code-block tint (layer depth ${m.layerDepth}); ${m.unpainted.length} lines painting no tint; ${j(m.hidden)}`,
      };
    },
  },
];
