/*
 * Rendering of whole blocks: front matter, code, and how much of a block its
 * raw Markdown reveal covers. What the reader sees is read back from the editor
 * DOM, so every check moves the caret off the lines it reads unless the reveal
 * itself is under test.
 */

import { setFrontMatterMode } from '../../src/webview/frontMatterView';
import { Scenario, mountProse } from '../harness';
import { setLivePreviewConfig, setReveal } from '../../src/webview/revealState';

type P = ReturnType<typeof mountProse>;

const lines = (p: P): HTMLElement[] => Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'));

/** Rendered text of line `i` (0-based). */
const line = (p: P, i: number): string => lines(p)[i]?.textContent ?? '';

/** Whether line `i` (0-based) carries class `cls`. */
const hasClass = (p: P, i: number, cls: string): boolean => lines(p)[i]?.classList.contains(cls) ?? false;

const count = (p: P, selector: string): number => p.view.contentDOM.querySelectorAll(selector).length;

/** Type `text` at the caret, as a keystroke would. */
const type = (p: P, text: string): void => {
  const at = p.view.state.selection.main.head;
  p.view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' });
};

/** Run `fn` with "Reveal Syntax On Line" set to `on`, restoring the test default (on) afterwards. */
const withRevealOnLine = (on: boolean, fn: () => boolean): boolean => {
  setLivePreviewConfig({ revealSyntaxOnLine: on });
  try {
    return fn();
  } finally {
    setLivePreviewConfig({ revealSyntaxOnLine: true });
  }
};

export const scenarios: Scenario[] = [
  {
    name: 'YAML front matter shown draws as plain metadata with no rule, heading or bullets',
    run: () => {
      const doc = '---\n# a YAML comment\ntitle: Hello\ncategories:\n  - reference\n---\n\nBody text.\n\n---\n\n## Real heading';
      // How the block is drawn when it is drawn. Collapsed is the default now, and the
      // states themselves are `prose/frontMatterView.ts`.
      setFrontMatterMode('shown');
      const p = mountProse(doc);
      p.select(doc.indexOf('Body') + 2);
      const front = [0, 1, 2, 3, 4, 5];
      const ok =
        front.every((i) => hasClass(p, i, 'tok-frontmatter') && !hasClass(p, i, 'tok-heading')) &&
        line(p, 0) === '---' &&
        line(p, 1) === '# a YAML comment' &&
        line(p, 2) === 'title: Hello' &&
        line(p, 4) === '  - reference' &&
        line(p, 5) === '---' &&
        count(p, '.tok-bullet') === 0 &&
        // The rule after the body is a real one and still draws.
        count(p, '.md-hr') === 1 &&
        !hasClass(p, 7, 'tok-frontmatter') &&
        hasClass(p, 11, 'tok-h2') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'front matter closed with three dots shows as metadata and the body after it renders',
    run: () => {
      const doc = '---\ntitle: Hello\ndraft: true\n...\n\nBody *text* here.';
      const p = mountProse(doc);
      p.select(0);
      const ok =
        [0, 1, 2, 3].every((i) => hasClass(p, i, 'tok-frontmatter') && !hasClass(p, i, 'tok-heading')) &&
        line(p, 3) === '...' &&
        count(p, '.md-hr') === 0 &&
        !hasClass(p, 5, 'tok-frontmatter') &&
        line(p, 5) === 'Body text here.' &&
        count(p, '.tok-em') === 1 &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a rule that does not open the document is not front matter',
    run: () => {
      const doc = 'Intro.\n\n---\n\ntitle: Hello';
      const p = mountProse(doc);
      p.select(0);
      const ok = count(p, '.tok-frontmatter') === 0 && count(p, '.md-hr') === 1 && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'typing at the end of a double-clicked block keeps its Markdown revealed',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = '.\n\nA **bold** word';
        const p = mountProse(doc);
        const from = doc.indexOf('A');
        p.view.dispatch({ effects: setReveal.of({ from, to: doc.length }), selection: { anchor: doc.indexOf('word') + 1 } });
        const revealed = line(p, 2) === 'A **bold** word';
        p.select(doc.length);
        type(p, 'X');
        const one = line(p, 2);
        type(p, 'Y');
        const two = line(p, 2);
        const ok = revealed && one === 'A **bold** wordX' && two === 'A **bold** wordXY' && p.doc() === doc + 'XY';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'typing at the start of a double-clicked block keeps it revealed, and leaving the block hides it',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = '.\n\nA **bold** word';
        const p = mountProse(doc);
        const from = doc.indexOf('A');
        p.view.dispatch({ effects: setReveal.of({ from, to: doc.length }), selection: { anchor: from } });
        type(p, 'Z');
        const typed = line(p, 2) === 'ZA **bold** word';
        p.select(0);
        const hidden = line(p, 2) === 'ZA bold word';
        const ok = typed && hidden && p.doc() === '.\n\nZA **bold** word';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a fenced block draws no backticks, and a labelled fence line draws nothing at all',
    run: () =>
      // With Reveal Syntax On Line off, which is how Sheaf ships: what a reader sees.
      withRevealOnLine(false, () => {
        const doc = 'Before.\n\n```js\nconst x = 1;\n```\n\nAfter.';
        const p = mountProse(doc);
        p.select(0);
        const ok =
          // The fence lines are still lines, marked as the block's edges.
          hasClass(p, 2, 'sheaf-code-fence-line') &&
          hasClass(p, 4, 'sheaf-code-fence-line') &&
          // Both fence lines draw nothing, the labelled one included: the language is
          // in the file and Edit Markdown shows it, and nothing is drawn in its place.
          line(p, 2) === '' &&
          line(p, 4) === '' &&
          count(p, '.md-code-lang') === 0 &&
          // The code between them is untouched, and so is the file.
          line(p, 3) === 'const x = 1;' &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'the caret alone does not bring a fence back, and Edit Markdown does',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = 'Before.\n\n```js\nconst x = 1;\n```\n\nAfter.';
        const p = mountProse(doc);
        // A fence is a marker like any other: the caret on it changes nothing, because
        // Sheaf does not show syntax under the caret unless it is asked to.
        p.select(doc.indexOf('```js') + 2);
        const stillHidden = line(p, 2) === '' && hasClass(p, 2, 'sheaf-code-fence-line');
        // Edit Markdown over the block is what shows it, as it does for every block.
        const from = doc.indexOf('```js');
        p.view.dispatch({ effects: setReveal.of({ from, to: doc.indexOf('```\n\nAfter') + 3 }) });
        const revealed = line(p, 2) === '```js' && line(p, 4) === '```' && !hasClass(p, 2, 'sheaf-code-fence-line');
        const ok = stillHidden && revealed && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'with reveal syntax on line, the caret on a fence line shows it as written',
    run: () =>
      withRevealOnLine(true, () => {
        const doc = 'Before.\n\n```js\nconst x = 1;\n```\n\nAfter.';
        const p = mountProse(doc);
        p.select(0);
        const hidden = line(p, 2) === '';
        p.select(doc.indexOf('```js') + 2);
        const shown = line(p, 2) === '```js' && !hasClass(p, 2, 'sheaf-code-fence-line');
        p.select(0);
        const away = line(p, 2) === '';
        const ok = hidden && shown && away && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a fence with no language leaves an empty edge, and an unclosed block hides only the fence it has',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = 'Before.\n\n```\nplain\n```\n\n```\nnever closed\n';
        const p = mountProse(doc);
        p.select(0);
        const ok =
          line(p, 2) === '' &&
          line(p, 4) === '' &&
          count(p, '.md-code-lang') === 0 &&
          hasClass(p, 6, 'sheaf-code-fence-line') &&
          line(p, 6) === '' &&
          line(p, 7) === 'never closed' &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'backticks inside a code block are code, not a fence to hide',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = 'Before.\n\n````md\n```js\nnested\n```\n````\n\nAfter.';
        const p = mountProse(doc);
        p.select(0);
        const ok =
          // Only the outer four-backtick pair is a fence, and it draws nothing.
          line(p, 2) === '' &&
          line(p, 6) === '' &&
          // The inner three-backtick lines are part of the example and stay as written.
          line(p, 3) === '```js' &&
          line(p, 5) === '```' &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a fenced block inside a quote keeps the quote marker and loses only its fence',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = 'Before.\n\n> ```js\n> const x = 1;\n> ```\n\nAfter.';
        const p = mountProse(doc);
        p.select(0);
        const ok =
          // The quote's own marker is hidden by the quote, as it always was; what this
          // holds is that hiding the fence did not take the line out of the quote.
          hasClass(p, 2, 'tok-quote') &&
          hasClass(p, 4, 'tok-quote') &&
          // Trimmed: the quote hides its `>` and leaves the space after it, as it always has.
          line(p, 2).trim() === '' &&
          line(p, 4).trim() === '' &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    /*
     * The depth, not the geometry. This suite is jsdom, which has no layout, so what it can
     * hold is that each line was told how deep it is; where that puts anything on a screen is
     * measured in Chromium by scripts/check-indent.mjs.
     *
     * A three-level quote used to be drawn exactly like a one-level quote. One shared line
     * class was applied once per nesting level to the same line, and the same class twice is
     * no class at all, so `> > >` and `>` were indistinguishable.
     */
    name: 'a nested quote reports one depth per level, and a flat quote reports one',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = 'Before.\n\n> One deep.\n\n> > Two deep.\n\n> > > Three deep.\n\n> Flat again.\n\nAfter.';
        const p = mountProse(doc);
        p.select(0);
        const depth = (i: number): string | null => lines(p)[i]?.style.getPropertyValue('--md-list-depth') ?? null;
        const quote = (i: number): string | null => lines(p)[i]?.style.getPropertyValue('--md-quote-depth') ?? null;
        const ok =
          quote(2) === '1' &&
          quote(4) === '2' &&
          quote(6) === '3' &&
          // CONTROL: a flat quote after a deep one reports one level, not the depth of the
          // quote above it. A counter left un-decremented would read 4 here and every case
          // above would still pass.
          quote(8) === '1' &&
          // Every one of them is a quote and none of them is in a list.
          [2, 4, 6, 8].every((i) => hasClass(p, i, 'tok-quote') && depth(i) === '0') &&
          // CONTROL: the lines outside the quotes carry no depth at all, so nothing here
          // indents the whole document.
          !hasClass(p, 0, 'tok-quote') &&
          !hasClass(p, 10, 'tok-quote') &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    /*
     * The other axis, measured the same way and for the same reason. Depth comes from the
     * syntax tree rather than from the leading whitespace in the file: two spaces, four spaces
     * and a tab are three different widths in a proportional font, and an ordered item's
     * content starts three columns in rather than two, so counting spaces put a numbered
     * level three at depth four.
     */
    name: 'a nested list reports one depth per level, counted from the tree and not from the spaces',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = 'Before.\n\n- One.\n  - Two.\n    - Three.\n\nAfter.';
        const p = mountProse(doc);
        p.select(0);
        const depth = (i: number): string | null => lines(p)[i]?.style.getPropertyValue('--md-list-depth') ?? null;
        const ok =
          depth(2) === '1' &&
          depth(3) === '2' &&
          depth(4) === '3' &&
          // The line a list item opens on is the only one with a marker to hang, so it is the
          // only one that hangs.
          [2, 3, 4].every((i) => hasClass(p, i, 'tok-hang')) &&
          // CONTROL: the paragraphs around it are in no list and neither carries the class.
          depth(0) === '' &&
          depth(6) === '' &&
          !hasClass(p, 0, 'tok-hang') &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    /*
     * A numbered item to two digits, and a task item. Both used to put their words somewhere
     * of their own: the digits of `10.` are wider than those of `1.`, and a task line drew a
     * bullet and then a checkbox, so it carried two markers.
     */
    name: 'every list marker is boxed, and a task item draws a checkbox instead of a bullet as well as one',
    run: () =>
      withRevealOnLine(false, () => {
        // Lines: 0 Before, 2 `9.`, 3 `10.`, 5 task done, 6 task open, 8 plain bullet, 10 After.
        const doc = 'Before.\n\n9. Nine.\n10. Ten.\n\n- [x] Done.\n- [ ] Open.\n\n- Plain.\n\nAfter.';
        const p = mountProse(doc);
        p.select(0);
        const boxes = (i: number): number => lines(p)[i]?.querySelectorAll('.tok-marker-box').length ?? -1;
        // Scoped to the marker box on purpose. Every line already holds aria-hidden elements,
        // the block handle's two icons, so asking whether a line has any would pass whatever
        // the markers do.
        const hiddenBox = (i: number): Element | null | undefined =>
          lines(p)[i]?.querySelector('.tok-marker-box[aria-hidden="true"]');
        const ok =
          // One box per marker, and exactly one: two would be the double marker back again.
          [2, 3, 5, 6, 8].every((i) => boxes(i) === 1) &&
          // The task item's one box is the checkbox, and no bullet is drawn beside it.
          lines(p)[5]?.querySelector('.tok-marker-box > input.md-task') !== null &&
          lines(p)[6]?.querySelector('.tok-marker-box > input.md-task') !== null &&
          !line(p, 5).includes('•') &&
          // The number stays the document's own text, boxed rather than replaced.
          line(p, 2).includes('9.') &&
          line(p, 3).includes('10.') &&
          // A bullet is decoration and is hidden from assistive technology, because the
          // marker takes its space with it and nothing else separates the glyph from the word.
          hiddenBox(8) !== null &&
          // CONTROL: the other two boxed markers must not be hidden, for opposite reasons. A
          // number is the only thing carrying the ordinal, since no list semantics are
          // exposed; and hiding a task's box would take its real checkbox out of the
          // accessibility tree along with it, because aria-hidden covers the whole subtree,
          // focusable content included.
          hiddenBox(2) === null &&
          hiddenBox(3) === null &&
          hiddenBox(5) === null &&
          hiddenBox(6) === null &&
          // CONTROL: a paragraph has no marker and so no box.
          boxes(0) === 0 &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    /*
     * An empty task item is a line whose entire drawn content is a widget, and that is the
     * one shape where "the line draws as nothing" and "the reader sees nothing" come apart.
     * The editing matrix's `nothing-hidden` class reads drawn text and so reports this line as
     * drawing as empty, which is true of its text and false of what a person has in front of
     * them. This is the check that says which.
     *
     * What the class is really guarding against is a line a person cannot use: an empty
     * heading is `# ` drawn as nothing, and the next thing typed lands in front of the hash.
     * So the assertions below are about exactly that, and the caret column is the one that
     * matters.
     */
    name: 'an empty task item draws its checkbox, and Enter on a task gives another one you can type into',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = 'Before.\n\n- [x] Done.\n- [ ] \n';
        const p = mountProse(doc);
        p.select(0);
        const empty = lines(p)[3];
        const drawnEmptyButVisible =
          // The checkbox is there, inside its marker box.
          empty?.querySelector('.tok-marker-box > input.md-task') != null &&
          // And the line genuinely carries no drawn text, which is why a text-only judgement
          // of this line is wrong rather than merely incomplete.
          empty?.textContent === '';
        p.destroy();

        // The gesture a person actually makes, driven through the editor's own keymap.
        const after = 'Before.\n\n- [x] Done task\n';
        const q = mountProse(after);
        q.select(after.indexOf('Done task') + 'Done task'.length);
        const handled = q.press('Enter');
        const head = q.view.state.selection.main.head;
        const line4 = q.view.state.doc.lineAt(head);
        const reachable =
          handled &&
          q.doc() === 'Before.\n\n- [x] Done task\n- [ ] \n' &&
          // The caret sits after the marker, not in front of it. At column 0 the next letter
          // would land before the `-` and turn the task into a paragraph, which is the failure
          // the matrix class exists to catch and the reason this asserts a column.
          head - line4.from === 6;
        q.view.dispatch({ changes: { from: head, insert: 'Z' }, selection: { anchor: head + 1 }, userEvent: 'input.type' });
        const typed =
          q.doc() === 'Before.\n\n- [x] Done task\n- [ ] Z\n' &&
          lines(q)[3]?.querySelector('input.md-task') != null &&
          lines(q)[3]?.textContent === 'Z';
        q.destroy();
        return drawnEmptyButVisible && reachable && typed;
      }),
  },
  {
    name: 'an indented code block is styled like fenced code',
    run: () => {
      const doc = 'Before.\n\n    function indented() {\n    }\n\nAfter.\n\n```\nfenced\n```';
      const p = mountProse(doc);
      p.select(0);
      const ok =
        hasClass(p, 2, 'tok-code-block') &&
        hasClass(p, 3, 'tok-code-block') &&
        line(p, 2) === '    function indented() {' &&
        !hasClass(p, 0, 'tok-code-block') &&
        !hasClass(p, 5, 'tok-code-block') &&
        [7, 8, 9].every((i) => hasClass(p, i, 'tok-code-block')) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'with reveal syntax on line, the caret reveals every line of its quote or list item and nothing outside it',
    run: () => {
      // Named in the scenario's own title, so it asks for the setting rather than inheriting
      // whatever ran before it. The runner resets it for each scenario.
      setLivePreviewConfig({ revealSyntaxOnLine: true });
      const doc = '.\n\n> first **line** here\n> second **line** here\n\n- item one\n  continued **here**\n- item two **x**\n\nPara **one**.';
      const p = mountProse(doc);
      p.select(doc.indexOf('first') + 2);
      const quote =
        /*
         * The asterisks come back and the `>` does not, which is the one marker Sheaf keeps hidden
         * on the caret's line. Its width is already in the quote's computed indent, so drawing it
         * moved the words 14px as the caret arrived and back as it left. Everything else on the
         * line still reveals, which is what these two rows now say: bold shows its markers, and
         * the quote's own marker stays away.
         *
         * An alert's marker line is the exception and shows byte for byte, `>` included, because
         * the whole line is syntax there and it is what a person edits to change a callout's type.
         * prose/alerts.ts holds that.
         */
        line(p, 2) === 'first **line** here' &&
        line(p, 3) === 'second **line** here' &&
        // A marker takes its own space with it now, so a rendered bullet line carries neither
        // the source space after the `-` nor one written by the widget.
        line(p, 5) === '•item one' &&
        line(p, 9) === 'Para one.';
      p.select(doc.indexOf('item one') + 2);
      const item =
        line(p, 5) === '- item one' &&
        line(p, 6) === '  continued **here**' &&
        line(p, 7) === '•item two x' &&
        line(p, 2) === 'first line here' &&
        line(p, 3) === 'second line here';
      const ok = quote && item && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'with reveal syntax on line, a list item selected to the start of the next one leaves the next one rendered',
    run: () =>
      withRevealOnLine(true, () => {
        // Triple-clicking an item, or dragging to the end of it, selects its line
        // break too, so the selection ends at the start of the next item.
        const doc = '.\n\n- **Documents.** Prose here.\n- **Datatables.** Grids here.\n\nAfter.';
        const p = mountProse(doc);
        p.select(doc.indexOf('- **Documents'), doc.indexOf('- **Datatables'));
        const lineOnly = line(p, 2) === '- **Documents.** Prose here.' && line(p, 3) === '•Datatables. Grids here.';
        // Dragged the other way, the same span reveals the same lines.
        p.select(doc.indexOf('- **Datatables'), doc.indexOf('- **Documents'));
        const backwards = line(p, 2) === '- **Documents.** Prose here.' && line(p, 3) === '•Datatables. Grids here.';
        // One character into the next item does reach it, so it shows as Markdown.
        p.select(doc.indexOf('- **Documents'), doc.indexOf('- **Datatables') + 1);
        const intoNext = line(p, 3) === '- **Datatables.** Grids here.';
        const ok = lineOnly && backwards && intoNext && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'with reveal syntax on line, a heading selected to the start of the line below leaves that line rendered',
    run: () =>
      withRevealOnLine(true, () => {
        const doc = '.\n\n# Heading **one**\nNext *two*.';
        const p = mountProse(doc);
        p.select(doc.indexOf('# Heading'), doc.indexOf('Next'));
        const ok = line(p, 2) === '# Heading **one**' && line(p, 3) === 'Next two.' && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'with reveal syntax on line off, a caret in a quote reveals nothing',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = '.\n\n> first **line** here\n> second **line** here';
        const p = mountProse(doc);
        p.select(doc.indexOf('first') + 2);
        // The `>` takes its space with it, so neither rendered line begins with one.
        const ok = line(p, 2) === 'first line here' && line(p, 3) === 'second line here' && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'changing reveal syntax on line updates the caret line at once without moving the caret',
    run: () =>
      withRevealOnLine(true, () => {
        const doc = '.\n\nA **bold** one here.';
        const p = mountProse(doc);
        p.select(doc.indexOf('bold') + 1);
        const before = line(p, 2) === 'A **bold** one here.';
        // The webview applies a settings change by updating the config and
        // dispatching an empty transaction; nothing else about the editor changes.
        setLivePreviewConfig({ revealSyntaxOnLine: false });
        p.view.dispatch({});
        const off = line(p, 2) === 'A bold one here.';
        setLivePreviewConfig({ revealSyntaxOnLine: true });
        p.view.dispatch({});
        const on = line(p, 2) === 'A **bold** one here.';
        const ok = before && off && on && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
];
