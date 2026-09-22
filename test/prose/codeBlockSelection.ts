/*
 * A fenced code block, its background, and the selection drawn under it.
 *
 * The bug these guard was a painting order: the block's tint was the line
 * element's own background, so it covered the drawn selection (a layer beneath
 * the content) and `.cm-activeLine` stripped it from whichever line held the
 * caret. The tint now comes from a pseudo-element a step further back.
 *
 * jsdom has no layout and does not load media/webview.css, so none of that can
 * be measured here: what a person sees is checked in a real window
 * (test/real-editor/editor/code-blocks.mjs). What these scenarios hold is the
 * structure the stylesheet aims at — the classes it keys on, and the depth the
 * theme pins the selection layer to, since the stylesheet's `z-index: -2` is
 * meaningless if that number moves.
 */

import { Scenario, mountProse } from '../harness';

/** Every CSS rule the editor has injected into the document, as text. */
function injectedRules(): string[] {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = (sheet as CSSStyleSheet).cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) out.push(rule.cssText);
  }
  return out;
}

/** The lines of the mounted document, as their class names. */
function lineClasses(p: ReturnType<typeof mountProse>): string[] {
  return Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')).map((el) => el.className);
}

const FENCED = 'Intro paragraph.\n\n```\nHello world inside a fence\nsecond line of code\n```\n\nAfter text.\n';

export const scenarios: Scenario[] = [
  {
    name: 'the drawn selection is pinned one step under the content, where a code block can paint behind it',
    run: () => {
      const p = mountProse(FENCED);
      const layer = p.view.scrollDOM.querySelector<HTMLElement>('.sheaf-selectionLayer');
      // CodeMirror writes a below-layer's depth as an inline style, from the order
      // the layers were registered in. The theme overrides it so the stylesheet has
      // a fixed number to sit behind.
      const inline = layer ? Number(layer.style.zIndex) : NaN;
      const rules = injectedRules();
      const pinned = rules.some((r) => /\.sheaf-selectionLayer[^{]*\{[^}]*z-index:\s*-1\s*!important/i.test(r));
      const hidesOwn = rules.some((r) => /\.cm-selectionLayer[^{]*\{[^}]*display:\s*none/i.test(r));
      p.destroy();
      return Boolean(layer) && inline < 0 && pinned && hidesOwn;
    },
  },
  {
    name: 'a fenced code block keeps the class its background is keyed to on every line, caret included',
    run: () => {
      const p = mountProse(FENCED);
      // The caret on the second line of code: the line that used to lose the tint.
      p.select(FENCED.indexOf('second line') + 3);
      const classes = lineClasses(p);
      const code = classes.filter((c) => c.includes('tok-code-block'));
      const active = classes.filter((c) => c.includes('cm-activeLine'));
      // Both fences and both code lines carry it, and the active line is one of them.
      const allFour = code.length === 4;
      const activeIsCode = active.length === 1 && active[0].includes('tok-code-block');
      // Nothing paints the tint inline on the line, which is what the pseudo-element
      // replaced; an inline background would be out of the pseudo-element's reach.
      const noInline = Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')).every((el) => !el.style.background && !el.style.backgroundColor);
      p.destroy();
      return allFour && activeIsCode && noInline;
    },
  },
];
