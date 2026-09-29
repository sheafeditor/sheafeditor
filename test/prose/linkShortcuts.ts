/*
 * The three link shortcuts: Cmd+K edits, Cmd+Shift+K removes, Cmd+Enter opens.
 *
 * Cmd+K editing rather than removing is the change these were written for, and the
 * other two are what that costs: removal lost its only shortcut when Cmd+K stopped
 * being a toggle, and opening never had one.
 */

import { Scenario, mountProse, Prose } from '../harness';
import { setLinkHost } from '../../src/webview/linkTarget';

const G: any = globalThis;

const popover = (p: Prose): HTMLElement | null => p.view.dom.querySelector<HTMLElement>('.sheaf-linkpop');
const toolbar = (p: Prose): HTMLElement | null => p.view.dom.querySelector<HTMLElement>('.sheaf-seltb');
const field = (p: Prose, which: 'text' | 'url'): HTMLInputElement | null =>
  popover(p)?.querySelector<HTMLInputElement>(`.sheaf-linkpop-${which}`) ?? null;

/** Set a popover field the way typing does. */
const set = (input: HTMLInputElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new G.Event('input', { bubbles: true }));
};
const enter = (input: HTMLInputElement): void =>
  void input.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
const escape = (p: Prose): void =>
  void popover(p)!.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

/** Which element has the caret, named the way a failure message can use. */
const focusedField = (p: Prose): string => {
  const pop = popover(p);
  if (!pop) return 'no popover';
  const active = document.activeElement as HTMLInputElement | null;
  if (!active || !pop.contains(active)) return 'nothing in the popover';
  return active.classList.contains('sheaf-linkpop-url') ? 'url' : 'text';
};

export const scenarios: Scenario[] = [
  {
    /*
     * Asking for a link writes nothing until there is an address.
     *
     * It used to write `[text](url)` with `url` selected, which put raw brackets and a
     * placeholder on the screen in an editor whose whole argument is that they are not there,
     * and left `[text](url)` in the file for anybody who clicked away instead of typing. The
     * three things read here are the three that placeholder got wrong: the document is
     * untouched while the address is asked for, the words are in a field rather than in the
     * text, and Esc leaves the file byte-for-byte as it was.
     */
    name: 'Mod-k over a word asks for the address and writes nothing until it has one',
    run: () => {
      const doc = 'Read the docs today.';
      const p = mountProse(doc);
      p.select(9, 13);
      const barBefore = toolbar(p) !== null;
      p.press('Mod-k');
      const opened = `${popover(p) ? 'popover' : 'no popover'}/${toolbar(p) ? 'toolbar' : 'no toolbar'}`;
      const filled = `${field(p, 'text')?.value}|${field(p, 'url')?.value}|${focusedField(p)}`;
      const pending = p.doc();
      set(field(p, 'url')!, 'https://x.io');
      enter(field(p, 'url')!);
      const written = p.doc();
      const caret = p.view.state.selection.main;
      p.press('Mod-z');
      const undone = p.doc();
      p.destroy();
      const want = 'Read the [docs](https://x.io) today.';
      return {
        ok:
          barBefore &&
          opened === 'popover/no toolbar' &&
          filled === 'docs||url' &&
          pending === doc &&
          written === want &&
          caret.empty &&
          caret.head === written.indexOf(') today') + 1 &&
          undone === doc,
        detail:
          `the toolbar was up for the selection ${barBefore}; after Mod-k ${opened} with ${JSON.stringify(filled)} (text|address|caret); ` +
          `the file while asking ${JSON.stringify(pending)}; after Enter ${JSON.stringify(written)}` +
          (written === want ? '' : ` rather than ${JSON.stringify(want)}`) +
          `; caret at ${caret.head}; one undo gave ${JSON.stringify(undone)}`,
      };
    },
  },
  {
    name: 'Esc while a link is being asked for leaves the file exactly as it was, address typed or not',
    run: () => {
      const doc = 'Read the docs today.';
      const first = mountProse(doc);
      first.select(9, 13);
      first.press('Mod-k');
      escape(first);
      const blank = `${first.doc()}/${popover(first) ? 'popover' : 'gone'}/${toolbar(first) ? 'toolbar' : 'no toolbar'}`;
      first.destroy();

      // The harder half: an address typed and then abandoned must leave nothing behind either.
      const second = mountProse(doc);
      second.select(9, 13);
      second.press('Mod-k');
      set(field(second, 'url')!, 'https://x.io');
      escape(second);
      const typed = second.doc();
      second.destroy();

      return {
        ok: blank === `${doc}/gone/toolbar` && typed === doc,
        detail: `Esc with nothing typed gave ${JSON.stringify(blank)} (file/popover/toolbar); with an address typed the file is ${JSON.stringify(typed)}`,
      };
    },
  },
  {
    /*
     * Clicking away from a link being written closes the popover. The document was never
     * touched, so there is nothing to undo — which is the whole of what the pending state
     * buys, and the reason the focus check has to know about it: it only put a surface away
     * when a toolbar or a link popover was open, and a link that does not exist yet is neither.
     */
    name: 'focus leaving the editor puts away a link that was being asked for',
    run: async () => {
      const doc = 'Read the docs today.';
      const p = mountProse(doc);
      p.select(9, 13);
      p.press('Mod-k');
      const opened = popover(p) !== null;
      const outside = document.createElement('input');
      document.body.appendChild(outside);
      outside.focus();
      p.view.dom.dispatchEvent(new G.Event('focusout', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      const gone = popover(p) === null;
      const unchanged = p.doc() === doc;
      outside.remove();
      p.destroy();
      return {
        ok: opened && gone && unchanged,
        detail: `opened ${opened}, gone once focus left ${gone}, the file is ${unchanged ? 'unchanged' : JSON.stringify(p.doc())}`,
      };
    },
  },
  {
    /*
     * A bare caret has no words yet, so the words are what it asks for first. A text field
     * left empty takes the address as its words, since `[](url)` shows the address anyway and
     * a link with nothing to click is not something anybody asked for.
     */
    name: 'Mod-k with a bare caret asks for the words first, and an empty text field takes the address as the words',
    run: () => {
      const named = mountProse('Intro.\n\n');
      named.select(8);
      named.press('Mod-k');
      const first = focusedField(named);
      set(field(named, 'text')!, 'the plan');
      set(field(named, 'url')!, 'plan.md');
      enter(field(named, 'text')!);
      const withWords = named.doc();
      named.destroy();

      const bare = mountProse('Intro.\n\n');
      bare.select(8);
      bare.press('Mod-k');
      set(field(bare, 'url')!, 'https://x.io');
      enter(field(bare, 'url')!);
      const withoutWords = bare.doc();
      bare.destroy();

      return {
        ok: first === 'text' && withWords === 'Intro.\n\n[the plan](plan.md)' && withoutWords === 'Intro.\n\n[https://x.io](https://x.io)',
        detail: `the caret landed in the ${first} field; words and address gave ${JSON.stringify(withWords)}; the address alone gave ${JSON.stringify(withoutWords)}`,
      };
    },
  },
  {
    /*
     * Enter on an empty address has asked for nothing. Closing on it would throw away the
     * words in the field along with the state saying where they go, and writing `[docs]()`
     * would be a link to nowhere nobody typed.
     */
    name: 'Enter with no address leaves the popover open and the file alone',
    run: () => {
      const doc = 'Read the docs today.';
      const p = mountProse(doc);
      p.select(9, 13);
      p.press('Mod-k');
      enter(field(p, 'url')!);
      const stillOpen = popover(p) !== null;
      const unchanged = p.doc() === doc;
      // And it saves once there is something to save.
      set(field(p, 'url')!, 'u');
      enter(field(p, 'url')!);
      const then = p.doc();
      p.destroy();
      return {
        ok: stillOpen && unchanged && then === 'Read the [docs](u) today.',
        detail: `the popover stayed ${stillOpen}, the file was untouched ${unchanged}, and the next Enter gave ${JSON.stringify(then)}`,
      };
    },
  },
  {
    /*
     * Cmd+K with a *selection* inside a link has to reach the popover too, because the
     * Link button is only on the toolbar and the toolbar only shows for a selection. The
     * popover normally yields to the toolbar, so a link opened on purpose overrides that:
     * somebody who pressed a key to get at the fields should not be handed the button
     * they just pressed.
     */
    name: 'Mod-k with a selection inside a link opens the popover in place of the selection toolbar',
    run: () => {
      const doc = 'Read the [guide](https://a.io/g) first.';
      const p = mountProse(doc);
      const from = doc.indexOf('guide');
      p.select(from, from + 5);
      const before = `${toolbar(p) ? 'toolbar' : 'no toolbar'}/${popover(p) ? 'popover' : 'no popover'}`;
      p.press('Mod-k');
      const after = `${toolbar(p) ? 'toolbar' : 'no toolbar'}/${popover(p) ? 'popover' : 'no popover'}`;
      const filled = `${field(p, 'text')?.value}|${field(p, 'url')?.value}`;
      const unchanged = p.doc() === doc;
      p.destroy();
      return {
        ok: before === 'toolbar/no popover' && after === 'no toolbar/popover' && filled === 'guide|https://a.io/g' && unchanged,
        detail: `a selection in the link showed ${before}; after Mod-k, ${after} with fields ${JSON.stringify(filled)}; the text was ${unchanged ? 'left alone' : 'changed'}`,
      };
    },
  },
  {
    name: 'Escape closes a popover opened with Mod-k, and the toolbar comes back for the selection',
    run: () => {
      const doc = 'Read the [guide](https://a.io/g) first.';
      const p = mountProse(doc);
      const from = doc.indexOf('guide');
      p.select(from, from + 5);
      p.press('Mod-k');
      const opened = popover(p) !== null;
      // Escape in the popover's own DOM, which is where it lands while a field has the caret.
      popover(p)!.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const closed = popover(p) === null;
      const back = toolbar(p) !== null;
      const unchanged = p.doc() === doc;
      p.destroy();
      return {
        ok: opened && closed && back && unchanged,
        detail: `opened ${opened}, closed on Escape ${closed}, toolbar back ${back}, file unchanged ${unchanged}`,
      };
    },
  },
  {
    /*
     * Mod-Shift-k is consumed whether or not it found a link, because the host binds it
     * to Delete Line. A miss that fell through would take the line out of the document,
     * which is the one outcome nobody pressing an unlink shortcut is ready for.
     */
    name: 'Mod-Shift-k takes the link off the word under the caret, and one undo puts it back',
    run: () => {
      const doc = 'Read the [guide](https://a.io/g) first.';
      const p = mountProse(doc);
      p.select(doc.indexOf('guide') + 2);
      const handled = p.press('Mod-Shift-k');
      const after = p.doc();
      p.press('Mod-z');
      const undone = p.doc();
      // Outside a link the key is still consumed, and nothing changes.
      p.select(2);
      const outside = p.press('Mod-Shift-k');
      const still = p.doc();
      p.destroy();
      const want = 'Read the guide first.';
      return {
        ok: handled && after === want && undone === doc && outside && still === doc,
        detail:
          `unlinking gave ${JSON.stringify(after)}` +
          (after === want ? '' : ` rather than ${JSON.stringify(want)}`) +
          `; one undo gave ${JSON.stringify(undone)}; outside a link the key was ${outside ? 'consumed' : 'let through'} and the text is ${JSON.stringify(still)}`,
      };
    },
  },
  {
    /*
     * Removing a link keeps the caret on the character it was on, so somebody who unlinked a
     * word mid-sentence carries on typing where they were. The `[` in front of the words is
     * what moves, and the caret moves with it rather than jumping to an edge.
     */
    name: 'removing a link leaves the caret where the words were',
    run: () => {
      const doc = 'Read the [guide](https://a.io/g) first.';
      const at = doc.indexOf('guide') + 3; // between "gui" and "de"
      const p = mountProse(doc);
      p.select(at);
      p.press('Mod-Shift-k');
      const after = p.doc();
      const caret = p.view.state.selection.main;
      p.destroy();
      const want = 'Read the guide first.';
      const wantAt = want.indexOf('guide') + 3;
      return {
        ok: after === want && caret.empty && caret.head === wantAt,
        detail: `the file is ${JSON.stringify(after)}; the caret is at ${caret.head} (${JSON.stringify(after.slice(0, caret.head))}|${JSON.stringify(after.slice(caret.head))}), wanted ${wantAt}`,
      };
    },
  },
  {
    name: 'Mod-Shift-k over a selection holding two links unlinks both in one undo step',
    run: () => {
      const doc = 'See [one](a.md) and [two](b.md) here.';
      const p = mountProse(doc);
      p.select(doc.indexOf('[one'), doc.indexOf(' here'));
      p.press('Mod-Shift-k');
      const after = p.doc();
      p.press('Mod-z');
      const undone = p.doc();
      // A selection that only reaches the second link leaves the first one alone.
      p.select(doc.indexOf('two'), doc.indexOf('two') + 3);
      p.press('Mod-Shift-k');
      const second = p.doc();
      p.destroy();
      const want = 'See one and two here.';
      return {
        ok: after === want && undone === doc && second === 'See [one](a.md) and two here.',
        detail: `both gave ${JSON.stringify(after)}; one undo gave ${JSON.stringify(undone)}; the second alone gave ${JSON.stringify(second)}`,
      };
    },
  },
  {
    /*
     * Cmd+Enter goes through the same opener as Cmd-click, so the decision about where an
     * address opens is made in one place: a relative path is the host's to resolve, and
     * anything with a scheme is the browser's.
     */
    name: 'Mod-Enter opens the link under the caret, and opens nothing where there is no link',
    run: () => {
      const doc = 'Read [the plan](notes/plan.md) and [the site](https://x.io) now.';
      const posted: unknown[] = [];
      setLinkHost((message) => posted.push(message));
      try {
        const p = mountProse(doc);
        p.select(doc.indexOf('the plan') + 1);
        const handled = p.press('Mod-Enter');
        const afterDocument = posted.length;
        // A scheme goes to the browser rather than to the host.
        p.select(doc.indexOf('the site') + 1);
        p.press('Mod-Enter');
        const afterExternal = posted.length;
        p.select(1);
        p.press('Mod-Enter');
        const afterNothing = posted.length;
        const unchanged = p.doc() === doc;
        p.destroy();
        return {
          ok:
            handled &&
            afterDocument === 1 &&
            afterExternal === 1 &&
            afterNothing === 1 &&
            unchanged &&
            JSON.stringify(posted[0]) === JSON.stringify({ type: 'openLink', address: 'notes/plan.md' }),
          detail: `the host was sent ${JSON.stringify(posted)} after the document link, the external one and ordinary text (counts ${afterDocument}, ${afterExternal}, ${afterNothing}); the file was ${unchanged ? 'left alone' : 'changed'}`,
        };
      } finally {
        setLinkHost(() => {});
      }
    },
  },
];
