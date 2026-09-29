/*
 * Typing an address into a link that was just made.
 *
 * The Link command writes `[text](url)` and leaves the address selected, so the
 * next thing typed replaces it. That is the one place in a document where a
 * person deliberately types into a construct's hidden half, and it is the case a
 * rule about hidden halves is most likely to break.
 *
 * One did. A guard meant for the single position between `]` and `(` was written
 * as "anywhere past the `]`", which is the whole address, so every character of a
 * typed address was redirected to the end of the label: clicking Link and typing
 * `https://x.io` gave `[docsttps://x.io](h)`.
 *
 * Neither the prose suite nor the editing matrix caught it. The matrix cannot:
 * the address is hidden, so its arrow walk never stops inside one, and a person
 * only gets there by running the command. It was caught by the real-window run,
 * two areas after the change landed, which is the argument for that run existing.
 */

import { Scenario, mountProse, Prose } from '../harness';
import { EditorView } from '@codemirror/view';

/** Type `text` one character at a time, the way a person does. */
function type(p: Prose, text: string): void {
  for (const ch of text) {
    const { state } = p.view;
    const { from, to } = state.selection.main;
    let handled = false;
    for (const handler of state.facet(EditorView.inputHandler)) {
      if (handler(p.view, from, to, ch, () => state.update({ changes: { from, to, insert: ch } }))) {
        handled = true;
        break;
      }
    }
    if (!handled) {
      p.view.dispatch(state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: 'input.type' }));
    }
  }
}

/** Select `target` in `doc`, type `typed`, and return the file. */
function typeOver(doc: string, target: string, typed: string): string {
  const p = mountProse(doc);
  try {
    const from = doc.indexOf(target);
    p.select(from, from + target.length);
    type(p, typed);
    return p.doc();
  } finally {
    p.destroy();
  }
}

export const scenarios: Scenario[] = [
  {
    name: "typing an address over a new link's placeholder replaces the address and nothing else",
    run: () => {
      const whole = typeOver('Read the [docs](url) today\n', 'url', 'https://x.io');
      // One character at a time is the case that broke: the first landed in the
      // address and every one after it was sent to the label.
      const one = typeOver('Read the [docs](url) today\n', 'url', 'h');
      const wantWhole = 'Read the [docs](https://x.io) today\n';
      const wantOne = 'Read the [docs](h) today\n';
      return {
        ok: whole === wantWhole && one === wantOne,
        detail:
          `an address typed in full gave ${JSON.stringify(whole)}${whole === wantWhole ? '' : ` rather than ${JSON.stringify(wantWhole)}`}; ` +
          `one character gave ${JSON.stringify(one)}${one === wantOne ? '' : ` rather than ${JSON.stringify(wantOne)}`}`,
      };
    },
  },
  {
    /*
     * The control, and the reason the guard exists at all: a character typed at
     * the join between `]` and `(` must not go there, because `] (` is not a link
     * and the address would come back onto the screen as text.
     */
    name: 'a character typed between a link\'s text and its address joins the text instead',
    run: () => {
      const doc = 'Before [text](http://x.y) after\n';
      const p = mountProse(doc);
      p.select(doc.indexOf('](') + 1);
      type(p, 'X');
      const got = p.doc();
      p.destroy();
      const want = 'Before [textX](http://x.y) after\n';
      return { ok: got === want, detail: got === want ? 'joined the text' : `gave ${JSON.stringify(got)} rather than ${JSON.stringify(want)}` };
    },
  },
  {
    /*
     * The other side of that guard, and it was firing where there was nothing to guard.
     *
     * `[again]` with no address is a shortcut reference link: still a `Link` node, still
     * two `LinkMark`s, so the position past its `]` looked exactly like the `](` join. It
     * is not. It is the end of the link, and the next thing a person types there is `(`,
     * because that is how an address gets started.
     *
     * So every character typed after the `]` was redirected inside the label: `[again](#`
     * came out as `[again(#]`. The text never became `](`, so link completion had nothing
     * to fire on and the heading list never opened, which is how this was found. Three of
     * three scenarios in that area failed at once, and a feature whose every scenario fails
     * together is usually one gate that stopped opening rather than three bugs.
     *
     * Typed one character at a time on purpose. Inserting the string in one edit never
     * reaches the guard, which is keyed on where a single character is going.
     */
    name: 'a link typed by hand, one character at a time, comes out as a link',
    run: () => {
      const doc = 'Write here .\n';
      const p = mountProse(doc);
      p.select(doc.indexOf(' .') + 1);
      type(p, '[again](#');
      const got = p.doc();
      p.destroy();
      const want = 'Write here [again](#.\n';
      return { ok: got === want, detail: got === want ? 'typed as written' : `gave ${JSON.stringify(got)} rather than ${JSON.stringify(want)}` };
    },
  },
];
