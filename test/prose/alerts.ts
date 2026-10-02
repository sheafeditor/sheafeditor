/*
 * Alerts: a blockquote that opens with `> [!NOTE]` and reads as a callout.
 *
 * What the reader sees is read back from the editor DOM, so every check moves
 * the caret out of the quote first: with "Reveal Syntax On Line" on, which is
 * the default these tests run under, a caret inside a block shows that block's
 * raw Markdown, and that is exactly what the reveal scenario below relies on.
 *
 * jsdom has no layout and no theme, so nothing here can see the colour a
 * callout is drawn in, the icon's shape, or where the label sits on the line.
 * These scenarios check which type each quote is recognised as, which text is
 * hidden and which is left alone, and that the document never changes; the
 * appearance is a real-window check.
 */

import { setLivePreviewConfig } from '../../src/webview/livePreview';
import { Scenario, mountProse } from '../harness';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { setDocumentSourceMode } from '../../src/webview/livePreview';
import { breakOnAlertMarker } from '../../src/webview/typedIntoChrome';
import { insertHardBreak } from '../../src/webview/toolbar';
import { toggleBullet, toggleOrdered, toggleTask, toggleQuote, turnInto } from '../../src/webview/toolbar';

type P = ReturnType<typeof mountProse>;

/** Type `text` one character at a time, through the input handlers, the way a person does. */
function type(p: P, text: string): void {
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

const lines = (p: P): HTMLElement[] => Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'));

/** Rendered text of line `i` (0-based), with the space left by the hidden `>` trimmed off. */
const line = (p: P, i: number): string => (lines(p)[i]?.textContent ?? '').trim();

/** Whether line `i` (0-based) carries class `cls`. */
const hasClass = (p: P, i: number, cls: string): boolean => lines(p)[i]?.classList.contains(cls) ?? false;

const count = (p: P, selector: string): number => p.view.contentDOM.querySelectorAll(selector).length;

/** The labels drawn in place of marker lines, in document order. */
const labels = (p: P): string[] =>
  Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.md-alert-name')).map((e) => e.textContent ?? '');

/**
 * Focus the editor and parse the whole document, before any key is pressed.
 *
 * **Focus is the one that matters and it fails silently.** Every deletion handler begins
 * `if (!view.hasFocus) return false`, because a menu that answers its own keys must not have
 * the editor answer them too. An unfocused editor therefore declines all of them, and what a
 * scenario sees is not a handler that is missing but CodeMirror's own default running instead:
 * `[!OTE]`, `[!NTE]`, one character gone from the marker at every position, and the word-sized
 * keys reading as unbound because nothing at all answered them. Every assertion below failed
 * that way while the same presses were correct in a probe that had focused first.
 *
 * Parsing is the lesser half: a handler that walks the syntax tree gets one parsed only as far
 * as the editor has drawn, and a freshly mounted editor in jsdom has drawn very little.
 */
function ready(p: P): P {
  p.view.focus();
  ensureSyntaxTree(p.view.state, p.view.state.doc.length, 5000);
  return p;
}

export const scenarios: Scenario[] = [
  {
    name: 'each of the five markers renders as its callout, with its own type on every line of the quote',
    run: () => {
      const doc =
        'Intro.\n\n> [!NOTE]\n> Body.\n\n> [!TIP]\n> Body.\n\n> [!IMPORTANT]\n> Body.\n\n> [!WARNING]\n> Body.\n\n> [!CAUTION]\n> Body.';
      const p = mountProse(doc);
      p.select(2);
      const kinds = ['note', 'tip', 'important', 'warning', 'caution'];
      const ok =
        labels(p).join(',') === 'Note,Tip,Important,Warning,Caution' &&
        count(p, '.md-alert-icon') === 5 &&
        // The marker line reads as the label alone: no `[!NOTE]` is left on it.
        kinds.every((_kind, i) => line(p, 2 + i * 3) === ['Note', 'Tip', 'Important', 'Warning', 'Caution'][i]) &&
        // Marker line and body both carry the quote rule and the type's colour.
        kinds.every(
          (kind, i) =>
            hasClass(p, 2 + i * 3, 'tok-quote') &&
            hasClass(p, 2 + i * 3, 'tok-alert') &&
            hasClass(p, 2 + i * 3, `tok-alert-${kind}`) &&
            hasClass(p, 3 + i * 3, 'tok-quote') &&
            hasClass(p, 3 + i * 3, 'tok-alert') &&
            hasClass(p, 3 + i * 3, `tok-alert-${kind}`)
        ) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a lower-case marker is the same alert as an upper-case one',
    run: () => {
      const doc = 'Intro.\n\n> [!note]\n> Body.\n\n> [!Caution]\n> Body.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        labels(p).join(',') === 'Note,Caution' &&
        hasClass(p, 2, 'tok-alert-note') &&
        hasClass(p, 5, 'tok-alert-caution') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a title after the marker is the callout’s label, and the marker line reads as that title',
    run: () => {
      const doc =
        'Intro.\n\n> [!NOTE] Before you start\n> Body.\n\n> [!warning]   Mind the gap  \n> Body.\n\n> [!tip] See **this** and [docs](x)\n> Body.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        // A title is shown as written, Markdown and all, and the syntax inside it
        // does not break into the label.
        labels(p).join('|') === 'Before you start|Mind the gap|See **this** and [docs](x)' &&
        line(p, 8) === 'See **this** and [docs](x)' &&
        count(p, '.md-alert-icon') === 3 &&
        line(p, 2) === 'Before you start' &&
        line(p, 5) === 'Mind the gap' &&
        hasClass(p, 2, 'tok-alert-note') &&
        hasClass(p, 3, 'tok-alert-note') &&
        hasClass(p, 5, 'tok-alert-warning') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a fold marker after the type is hidden with the rest of the marker, and the callout is drawn open',
    run: () => {
      const doc = 'Intro.\n\n> [!TIP]-\n> Folded body.\n\n> [!WARNING]+ Open with a title\n> Body.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        labels(p).join(',') === 'Tip,Open with a title' &&
        line(p, 2) === 'Tip' &&
        line(p, 5) === 'Open with a title' &&
        hasClass(p, 2, 'tok-alert-tip') &&
        hasClass(p, 5, 'tok-alert-warning') &&
        // Drawn expanded: the body of a folded callout is still on screen.
        line(p, 3) === 'Folded body.' &&
        !/[+-]/.test(labels(p)[0]) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a type outside the five takes the nearest of their styles and is labelled with its own name',
    run: () => {
      const doc =
        'Intro.\n\n> [!question]\n> B.\n\n> [!example]\n> B.\n\n> [!quote]\n> B.\n\n> [!Danger]\n> B.\n\n> [!attention]\n> B.\n\n> [!success]\n> B.\n\n> [!my-type2]\n> B.';
      const p = mountProse(doc);
      p.select(2);
      const styles = ['tip', 'note', 'note', 'caution', 'warning', 'tip', 'note'];
      const ok =
        labels(p).join(',') === 'Question,Example,Quote,Danger,Attention,Success,My-type2' &&
        styles.every((kind, i) => hasClass(p, 2 + i * 3, `tok-alert-${kind}`) && hasClass(p, 3 + i * 3, `tok-alert-${kind}`)) &&
        count(p, '.md-alert-icon') === 7 &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a quote that merely opens with a bracketed word stays an ordinary quote, spelled as written',
    run: () => {
      const doc =
        'Intro.\n\n> [draft] notes\n> Body.\n\n> [ ] x\n> Body.\n\n> [!]\n> Body.\n\n> [!NOTE]title\n> Body.\n\n> See [!NOTE] later.\n> Body.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        count(p, '.md-alert-label') === 0 &&
        count(p, '.tok-alert') === 0 &&
        line(p, 2) === '[draft] notes' &&
        line(p, 5) === '[ ] x' &&
        line(p, 8) === '[!]' &&
        line(p, 11) === '[!NOTE]title' &&
        line(p, 14) === 'See [!NOTE] later.' &&
        [2, 5, 8, 11, 14].every((i) => hasClass(p, i, 'tok-quote')) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the caret on a titled or folded marker line shows it as source, byte for byte',
    run: () => {
      // The caret on the line is what this reads, so it needs reveal-on-line rather than
      // inheriting whatever ran before it. The runner resets the setting for each scenario.
      setLivePreviewConfig({ revealSyntaxOnLine: true });
      const doc = 'Intro.\n\n> [!question]- Why this way?\n> Body text.';
      const p = mountProse(doc);
      p.select(2);
      const rendered = labels(p).join(',') === 'Why this way?' && line(p, 2) === 'Why this way?';
      p.select(doc.indexOf('question') + 2);
      const revealed =
        count(p, '.md-alert-label') === 0 &&
        line(p, 2) === '> [!question]- Why this way?' &&
        hasClass(p, 2, 'tok-alert-tip');
      p.select(2);
      const again = labels(p).join(',') === 'Why this way?';
      const ok = rendered && revealed && again && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'bracket text anywhere but the quote’s first line is left exactly as written',
    run: () => {
      const doc =
        'Intro.\n\n> [!NOTE]\n> See [1] and [!something] below.\n\n> A plain quote.\n> [!NOTE] here is just text.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        labels(p).join(',') === 'Note' &&
        line(p, 3) === 'See [1] and [!something] below.' &&
        // The second quote never opens with a marker, so nothing in it changes.
        !hasClass(p, 5, 'tok-alert') &&
        !hasClass(p, 6, 'tok-alert') &&
        line(p, 6) === '[!NOTE] here is just text.' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the caret in an alert shows the marker line as source, and leaving it draws the callout again',
    run: () => {
      // The caret on the line is what this reads, so it needs reveal-on-line rather than
      // inheriting whatever ran before it. The runner resets the setting for each scenario.
      setLivePreviewConfig({ revealSyntaxOnLine: true });
      const doc = 'Intro.\n\n> [!WARNING]\n> Body text.';
      const p = mountProse(doc);
      p.select(2);
      const rendered = labels(p).join(',') === 'Warning' && line(p, 2) === 'Warning';
      // The caret goes into the body; the whole quote shows its Markdown.
      p.select(doc.indexOf('Body text.') + 2);
      const revealed =
        count(p, '.md-alert-label') === 0 &&
        line(p, 2) === '> [!WARNING]' &&
        // The colour stays on while the source shows, so the block does not jump.
        hasClass(p, 2, 'tok-alert-warning');
      // Back out to the paragraph.
      p.select(2);
      const again = labels(p).join(',') === 'Warning' && line(p, 2) === 'Warning';
      const ok = rendered && revealed && again && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an alert renders the Markdown in its body, and a lazy continuation line belongs to it',
    run: () => {
      const doc = 'Intro.\n\n> [!IMPORTANT]\n> **Bold** and *italic*.\nLazy continuation.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        labels(p).join(',') === 'Important' &&
        count(p, '.tok-strong') === 1 &&
        count(p, '.tok-em') === 1 &&
        line(p, 3) === 'Bold and italic.' &&
        hasClass(p, 4, 'tok-alert-important') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an alert inside a list item renders, and a marker inside a nested quote stays text',
    run: () => {
      const doc =
        'Intro.\n\n- An item:\n\n  > [!TIP]\n  > Nested in a list.\n\n> [!NOTE]\n> Outer.\n>\n> > [!CAUTION]\n> > Inner.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        labels(p).join(',') === 'Tip,Note' &&
        hasClass(p, 4, 'tok-alert-tip') &&
        hasClass(p, 7, 'tok-alert-note') &&
        // A marker in a nested quote is ordinary text on GitHub, and it is here too:
        // the line keeps the outer alert's type and shows what is written.
        !hasClass(p, 10, 'tok-alert-caution') &&
        hasClass(p, 10, 'tok-alert-note') &&
        line(p, 4) === 'Tip' &&
        line(p, 10) === '[!CAUTION]' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'typing in an alert changes only what was typed, and the callout comes back',
    run: () => {
      const doc = 'Intro.\n\n> [!NOTE]\n> Body.';
      const p = mountProse(doc);
      const at = doc.indexOf('Body.') + 5;
      p.select(at);
      p.view.dispatch({ changes: { from: at, insert: ' More.' }, selection: { anchor: at + 6 }, userEvent: 'input.type' });
      const typed = p.doc() === 'Intro.\n\n> [!NOTE]\n> Body. More.';
      p.select(2);
      const ok = typed && labels(p).join(',') === 'Note' && line(p, 3) === 'Body. More.';
      p.destroy();
      return ok;
    },
  },
  {
    /*
     * Every block command on a callout's marker line, in one scenario, because this bug has
     * been found three times and each time only one path had it.
     *
     * The marker line is chrome: there is no text of its own on screen, only a label drawn in
     * place of `[!NOTE]`. So a block command takes that line with the quote instead of leaving
     * the marker behind as literal characters. `blockModel.ts` was taught this first and moved
     * nothing, because the commands go through `turnInto`; `turnInto` was taught next and left
     * four behind, because Bullet list, Numbered list, Task list and Quote are toggles that mark
     * lines themselves. All five ask one predicate now, and this drives all five so that a sixth
     * path arriving without it fails here rather than being discovered later.
     *
     * The file is what is read, not the screen. A label that simply stopped being drawn would
     * satisfy "no `[!NOTE]` visible" while having written it into the document.
     */
    name: 'no block command leaves a callout\u2019s marker behind as text',
    run: () => {
      const doc = 'Intro.\n\n> [!NOTE]\n> Body.\n';
      const commands: [string, (v: EditorView) => boolean][] = [
        ['Bullet list', toggleBullet],
        ['Numbered list', toggleOrdered],
        ['Task list', toggleTask],
        ['Quote', toggleQuote],
        ['Plain text', (v) => turnInto(v, 'text')],
        ['Heading 1', (v) => turnInto(v, 'h1')],
      ];
      const leaked: string[] = [];
      for (const [name, run] of commands) {
        const p = mountProse(doc);
        // The caret on the marker line, which is where a person clicking a callout puts it.
        p.select(doc.indexOf('[!NOTE]') + 2);
        run(p.view);
        const after = p.doc();
        p.destroy();
        // In the file, and on the screen: either alone passes for the wrong reason.
        if (/\[!NOTE\]/i.test(after)) leaked.push(`${name} wrote ${JSON.stringify(after)}`);
      }
      return { ok: leaked.length === 0, detail: leaked.length ? leaked.join('; ') : 'six commands, none left the marker behind' };
    },
  },
  {
    /*
     * The control for the one above, and the reason it is a separate scenario: a command that
     * removed the whole line would satisfy "no marker in the file" perfectly while taking the
     * person's words with it. A titled callout is where that shows, because its title is the one
     * part of that line anybody typed.
     */
    name: 'a titled callout keeps its title when a block command takes its marker',
    run: () => {
      const doc = 'Intro.\n\n> [!TIP] Worth knowing\n> Body.\n';
      const kept: string[] = [];
      for (const [name, run] of [
        ['Bullet list', toggleBullet],
        ['Quote', toggleQuote],
        ['Plain text', (v: EditorView) => turnInto(v, 'text')],
      ] as [string, (v: EditorView) => boolean][]) {
        const p = mountProse(doc);
        p.select(doc.indexOf('[!TIP]') + 2);
        run(p.view);
        const after = p.doc();
        p.destroy();
        if (!after.includes('Worth knowing')) kept.push(`${name} lost the title: ${JSON.stringify(after)}`);
        if (!after.includes('Body.')) kept.push(`${name} lost the body: ${JSON.stringify(after)}`);
      }
      return { ok: kept.length === 0, detail: kept.length ? kept.join('; ') : 'the title and the body survive all three' };
    },
  },
  {
    /*
     * A character typed on the marker line writes in the callout rather than inside `[!NOTE]`.
     *
     * The label is drawn in place of the marker, so the caret has as many positions along it as
     * the marker has characters and every one of them looks like the same place. Typing at any
     * of them used to give `[X!NOTE]`, which is not a marker, so the label vanished and the
     * brackets came back as text: one keystroke and the construct the person was typing in was
     * gone from the page.
     *
     * Three positions are driven, not one, because they are what makes the line ambiguous: the
     * far left, the middle of the marker, and the end of the line. A fix keyed on the line's
     * start would pass at one of them and fail at the other two.
     */
    name: 'a character typed anywhere on a callout\u2019s marker line goes into its body',
    run: () => {
      const doc = 'Intro.\n\n> [!NOTE]\n> Body.\n';
      const marker = doc.indexOf('[!NOTE]');
      const wrong: string[] = [];
      for (const [where, at] of [['the left edge', marker], ['inside the marker', marker + 3], ['the line end', marker + 7]] as [string, number][]) {
        const p = mountProse(doc);
        p.select(at);
        type(p, 'X');
        const after = p.doc();
        p.destroy();
        if (after !== 'Intro.\n\n> [!NOTE]\n> XBody.\n') wrong.push(`${where} gave ${JSON.stringify(after)}`);
      }
      return { ok: wrong.length === 0, detail: wrong.length ? wrong.join('; ') : 'all three positions wrote into the body' };
    },
  },
  {
    /*
     * The control, and the case the handler must not reach: a line whose Markdown is showing.
     *
     * `> [!question]- Why this way?` is how a person changes a callout's type or its title, and
     * where the marker is on the screen it is the text being edited rather than chrome drawn
     * over it. A handler that redirected there would make the type uneditable, which is a worse
     * bug than the one it fixes and would not show up in any count of leaked markers.
     *
     * Source mode is the condition, not `revealSyntaxOnLine`. Measured: reveal-on-line does not
     * open a callout's marker line at all, titled or folded or neither, so a control written
     * against it would have passed while proving nothing. `showingSource` is what the handler
     * asks, and source mode and Edit Markdown are what it answers to.
     */
    name: 'with its Markdown showing, a callout\u2019s marker line is typed into as written',
    run: () => {
      const doc = 'Intro.\n\n> [!NOTE]\n> Body.\n';
      const p = mountProse(doc);
      setDocumentSourceMode(p.view, p.view.dom.parentElement as HTMLElement, true);
      const at = doc.indexOf('[!NOTE]') + 2;
      p.select(at);
      type(p, 'X');
      const after = p.doc();
      setDocumentSourceMode(p.view, p.view.dom.parentElement as HTMLElement, false);
      p.destroy();
      const want = 'Intro.\n\n> [!XNOTE]\n> Body.\n';
      return { ok: after === want, detail: after === want ? 'typed where the caret was' : `gave ${JSON.stringify(after)} rather than ${JSON.stringify(want)}` };
    },
  },
  {
    /*
     * Enter and Shift+Enter on the marker line, which are the same question as typing and need
     * answering separately only because a break arrives as a key rather than as input.
     *
     * Left alone, Enter cuts `> [!NOTE]` in half and Shift+Enter writes a backslash into it, and
     * either way the marker stops being one and the brackets come back as text. Both are driven,
     * because they reach the editor by different routes — a keymap entry and `insertHardBreak` —
     * and one predicate is asked from both. Two paths is how this rule has been missed three
     * times already in this feature.
     */
    name: 'Enter and Shift+Enter on a callout\u2019s marker line open a line in its body',
    run: () => {
      const doc = 'Intro.\n\n> [!NOTE]\n> Body.\n';
      const at = doc.indexOf('[!NOTE]') + 3;
      const wrong: string[] = [];
      for (const [key, run] of [['Enter', breakOnAlertMarker], ['Shift+Enter', insertHardBreak]] as [string, (v: EditorView) => boolean][]) {
        const p = mountProse(doc);
        p.select(at);
        const answered = run(p.view);
        const after = p.doc();
        p.destroy();
        if (!answered) wrong.push(`${key} was not answered at all`);
        // The marker survives byte for byte, and a line arrived in the body.
        else if (!after.startsWith('Intro.\n\n> [!NOTE]\n>')) wrong.push(`${key} gave ${JSON.stringify(after)}`);
        else if (after === doc) wrong.push(`${key} changed nothing`);
      }
      return { ok: wrong.length === 0, detail: wrong.length ? wrong.join('; ') : 'both keys left the marker alone and opened a line' };
    },
  },
  {
    /*
     * All six delete keys, at three positions each, and the answer is the same eighteen times:
     * the callout's formatting goes and its words stay.
     *
     * There is nothing on the marker line a person put there, so no position has a
     * character-sized answer that means anything: each looks like the same place and each left a
     * different broken marker. `[!NOTE` and `[NOTE]` are not markers, so the label came back as
     * brackets and one keystroke left the wreckage of a construct on the screen. Delete at the
     * end is the same rather than symmetric: joining the body up would give `> [!NOTE]Body`,
     * which is not a callout in any renderer.
     *
     * The word-sized keys are here because they *are* drivable through `runScopeHandlers`, which
     * an earlier reading of this said they were not. That was true while the binding sat in the
     * editing keymap; it is in the high-precedence one now, ahead of `markdownKeymap`, and all
     * six arrive. Worth keeping all six: they reach the construct by two different code paths
     * and this rule has been missed by a second path three times in one feature.
     */
    name: 'every delete key on a callout\u2019s marker line takes the callout, not half a marker',
    run: () => {
      const doc = 'Intro.\n\n> [!NOTE]\n> Body.\n';
      const marker = doc.indexOf('[!NOTE]');
      const want = 'Intro.\n\n> Body.\n';
      const wrong: string[] = [];
      for (const key of ['Backspace', 'Delete', 'Mod-Backspace', 'Alt-Backspace', 'Mod-Delete', 'Alt-Delete']) {
        for (const [where, at] of [['the left edge', marker], ['the middle', marker + 3], ['the line end', marker + 7]] as [string, number][]) {
          const p = ready(mountProse(doc));
          p.select(at);
          const answered = p.press(key);
          const after = p.doc();
          p.destroy();
          if (!answered) wrong.push(`${key} at ${where} was not answered`);
          else if (after !== want) wrong.push(`${key} at ${where} gave ${JSON.stringify(after)}`);
        }
      }
      return { ok: wrong.length === 0, detail: wrong.length ? wrong.join('; ') : 'eighteen presses, all left the quote and its body' };
    },
  },
  {
    /*
     * The control, and the one thing a delete on that line must not take: a title.
     *
     * It is the only part of the marker line anybody typed, so the rule that drops the line has
     * to keep it, exactly as the block commands do. A fix that simply removed the line would
     * satisfy every assertion above and silently eat the person's words.
     */
    name: 'a delete on a titled callout\u2019s marker line keeps the title',
    run: () => {
      const doc = 'Intro.\n\n> [!TIP] Worth knowing\n> Body.\n';
      const want = 'Intro.\n\n> Worth knowing\n> Body.\n';
      const wrong: string[] = [];
      for (const key of ['Backspace', 'Delete', 'Alt-Backspace']) {
        const p = ready(mountProse(doc));
        p.select(doc.indexOf('[!TIP]') + 3);
        p.press(key);
        const after = p.doc();
        p.destroy();
        if (after !== want) wrong.push(`${key} gave ${JSON.stringify(after)}`);
      }
      return { ok: wrong.length === 0, detail: wrong.length ? wrong.join('; ') : 'all three kept the title and the body' };
    },
  },
];
