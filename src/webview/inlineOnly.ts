/*
 * Whether a surface holds one line of inline content, which is the one fact in this file.
 *
 * It lives on its own rather than beside the cell editor that sets it, and the reason is
 * dependency direction. `toolbar.ts` reads this to decide whether its block commands apply, and
 * while the facet sat in `cellEditor.ts` the toolbar had to import the cell editor to ask. That one
 * import closed a cycle: `livePreview.ts` reaches `blockModel.ts` reaches `toolbar.ts` reached
 * `cellEditor.ts`, and `cellEditor.ts` imports `livePreview.ts` back, so every module in that set
 * was reachable from every other. Measured, it made the `notes` size floor byte-identical to the
 * `field` one, 138 KB gzipped each over the same 32 modules, when `notes` deliberately excludes the
 * cell editor, both toolbars, the link popover and the shortcut registry.
 *
 * A `Facet` is the right shape for the answer and needs `@codemirror/state` and nothing else, so
 * the fact can sit below everything that cares about it: the surface declares it, the chrome reads
 * it, and neither has to know the other exists.
 */

import { Facet } from '@codemirror/state';

/**
 * True on an editor whose whole document is one cell's inline content.
 *
 * A cell holds one line and its parser is built without the block constructs, so a heading, a
 * list, a quote, a fence or a divider has no meaning in it: running one writes the marker into
 * the cell's text, where `- ` is two characters of a value rather than a bullet. Chrome that
 * offers those reads this and draws them unavailable instead, which is the rule that a control
 * unable to reach the selection says so rather than doing something else.
 *
 * A fact about the editor rather than a list held by the chrome, so the next surface that offers
 * a block command asks the same question and cannot disagree with the toolbar about the answer.
 */
export const inlineOnlyEditor = Facet.define<boolean, boolean>({
  combine: (values) => values.length > 0 && values[0],
});
