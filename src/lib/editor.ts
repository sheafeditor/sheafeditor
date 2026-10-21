/*
 * The editing surface, as the package entry a mounted surface fetches on first focus.
 *
 * **This file is why `mount` is not an editor.** `src/lib/index.ts` draws a surface with
 * `renderMarkdown`, which is a parser and a string walk; the editor is CodeMirror, the live-preview
 * decorations and the keymap, and all of that arrives here. `index.ts` reaches it by
 * `import('./editor.js')`, and this file is an entry point of the same build, so the import
 * resolves to the output the `exports` map names as `sheafeditor/editor` rather than to a chunk the
 * bundler invented.
 *
 * **No selection toolbar and no link popover, stated rather than omitted.** A table cell installs
 * both, and they are chrome that reaches the clipboard, link resolution and the file list — host
 * duties a `mount` consumer has not been asked for. `src/lib/README.md` says what a consumer gets
 * instead, which is the keymap. They are also the one import in this file's reach whose type
 * declarations do not emit: `linkHover` is `ViewPlugin.fromClass(class { private … })`, which
 * declaration emit cannot name, so pulling them in here would mean annotating a module another
 * session owns to publish this one.
 *
 * **No `editorExtensions.ts`.** That module is the document profile's extension set and imports
 * `@codemirror/language-data` at the top, which is the registry of every fenced-code grammar. A
 * `field` has no fences and a `notes` surface draws them as blocks without colouring them, so the
 * extensions here are assembled by hand and `fencedCode(...)` is not among them. The cost is stated
 * for a consumer under "A mounted surface renders first" in `README.md` rather than hidden: code in
 * a fence is monospaced and not coloured.
 *
 * **Which constructs each profile parses.** `field` removes the block constructs, as a table cell
 * does, so a `#` is a `#`. `notes` keeps them and removes `Table`, which belongs to the `document`
 * profile because the grid is the largest module in the editor and needs storage a consumer has to
 * provide.
 */
import { Annotation, EditorState, Extension, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { markdownDialect } from '../dialect/markdown';
import { sheafMarkdown } from '../webview/markdownDialect';
import { livePreview } from '../webview/livePreview';
import { revealField } from '../webview/revealState';
import { inlineOnlyEditor } from '../webview/inlineOnly';
import { drawnConstructs } from '../webview/drawnConstructs';
import { carriedBy } from '../dialect/profileConstructs';
import type { SurfaceProfile } from '../dialect/profileConstructs';
import { pendingMarks } from '../webview/pendingMarks';
import { notionTheme } from '../webview/theme';
import { inkPoint } from './inkOffset';
import type { Side } from './inkOffset';

/** Which constructs a surface carries. `document` is the extension's own editor and is not here. */
export type { SurfaceProfile } from '../dialect/profileConstructs';

/**
 * The block constructs a `field` does not carry.
 *
 * The same list `src/webview/cellEditor.ts` removes for a table cell, because a cell is the field
 * profile in everything but name and two lists would be two answers to one question.
 */
const FIELD_BLOCKS = [
  'ATXHeading',
  'SetextHeading',
  'FencedCode',
  'IndentedCode',
  'Blockquote',
  'HorizontalRule',
  'BulletList',
  'OrderedList',
  'TaskList',
  'HTMLBlock',
  'LinkReference',
  'Table',
];

/** The one construct a `notes` surface does not carry. */
const NOTES_BLOCKS = ['Table'];

/**
 * This change is the consumer setting a value, rather than anything a person did.
 *
 * The one fact the filter below cannot work out for itself. A transaction filter sees a change set
 * and a document, and "a line break arrived here" is the same shape whoever caused it, so the
 * actor has to be carried on the transaction. `setValue` is the only thing that marks one.
 */
const consumerWrite = Annotation.define<boolean>();

/**
 * A line break a **person** puts in a `field` becomes a space.
 *
 * Taken from the table cell, where the same rule holds for the same reason: the surface is one
 * line, so Enter belongs to the consumer and text pasted with a newline in it has to go somewhere.
 * A space is what the table's own writer makes of it.
 *
 * **It used to be every line break, and that was three behaviours wearing one coat.** A filter
 * catches every transaction carrying a multi-line insert, and three unrelated things produced one:
 * a paste, which is the case above and the case this was written for; `setValue`, which is the
 * consumer handing back state they already hold; and Enter, which is a key this surface does not
 * support. The first wants a space, the second wants its bytes back, and the third wants nothing
 * written at all. So the rule is by actor: a consumer's write is annotated and passes through
 * untouched, Enter is declined by the binding below and never reaches here, and what is left is a
 * person putting text into the surface, which is what the paragraph above describes.
 */
const oneLine = EditorState.transactionFilter.of((tr) => {
  if (tr.annotation(consumerWrite)) return tr;
  if (!tr.docChanged) return tr;
  let broken = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.lines > 1) broken = true;
  });
  if (!broken) return tr;
  const changes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({ from: fromA, to: toA, insert: inserted.toString().replace(/\r\n?|\n/g, ' ') });
  });
  const set = tr.startState.changes(changes);
  return {
    changes: set,
    selection: { anchor: set.mapPos(tr.startState.selection.main.to, 1) },
    scrollIntoView: tr.scrollIntoView,
  };
});

/**
 * The keys a `field` declines: they insert nothing and stay available to the consumer.
 *
 * `src/lib/README.md` tells a consumer "Enter is yours to handle", and a key this surface cannot
 * serve has to write nothing at all. Enter used to reach `insertNewlineAndIndent`, whose line
 * break the filter above then turned into a space, so a keystroke that should have done nothing
 * put a space in the person's value at the caret, fired `onChange` with it, and left them with the
 * least visible edit there is in data they were about to submit.
 *
 * **Returning `true` is the whole command.** It answers the key and writes no transaction, so
 * there is no change for the filter to see and nothing for `onChange` to report. CodeMirror calls
 * `preventDefault` on a key a binding took and does not stop the event, so it still reaches a
 * listener on the element around the editor and a consumer's own handler fires in either phase.
 *
 * `Prec.highest`, because the default keymap binds Enter with `shift` beside it and is installed
 * above: facet inputs are ordered by precedence and not by position, so without this the default
 * binding answers first and writes the break. Measured, by taking it off.
 */
const declinedKeys = Prec.highest(keymap.of([{ key: 'Enter', run: () => true, shift: () => true }]));

/**
 * A mounted surface's text takes its type from the page it is mounted in.
 *
 * The editor's own theme sets 16px, a system sans stack and a 1.5 line height, which is right in a
 * page that is nothing but the editor and wrong in a form: a title field in a 14px Georgia page
 * rendered at 14px Georgia, then jumped to 16px `-apple-system` on the first click. The rendered
 * state already followed the page, because it is ordinary HTML in it, so the editor was the half
 * that disagreed with its own surface and with everything around it.
 *
 * **Family, size and line height, and nothing else.** Those three are what make a line of text
 * look like the text beside it. Colour is not here: it belongs to a set the stylesheet designs
 * together, the text, its muted and faint forms and the selection, and inheriting one of the set
 * would split it. Headings, code and the other constructs keep their own sizes, which are written
 * in `em` and so scale from whatever this resolves to.
 *
 * **It is in this file because only a mounted surface should do it.** The extension's own editor
 * and the browser tab are pages Sheaf owns, where the theme's values are the design, and neither of
 * them builds an editor through here, so they are unchanged by construction rather than by a value
 * somebody remembered to pin. `Prec.highest`, because a theme rule matches the theme it overrides
 * class for class and the module mounted last wins, and precedence is what decides that order.
 */
const pageType = Prec.highest(
  EditorView.theme({
    '&': { fontSize: 'inherit' },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
    '.cm-content': { fontFamily: 'inherit' },
  })
);

/**
 * A `field` is one line tall whatever its value holds, and a value too long for it scrolls sideways.
 *
 * It used to wrap, and the surface grew a line at a time: a 40-character title in a 280px box was
 * two lines tall once somebody clicked it, and everything under it in the form moved down. A one-line
 * control that does not fit its value is what `<input>` already answers, and a reader expects a title
 * box to behave like one: the text runs on past the right edge, the caret is kept in view while
 * somebody types there, and the box stays the height it was.
 *
 * So the field's editor has no line wrapping, which is the half CodeMirror measures by, and its
 * content is `pre`, which is the half the browser draws by. The editor's theme sets `pre-wrap` on
 * every surface for a reason that is about wrapped prose, and leaving it on here would have the
 * browser wrapping lines CodeMirror believes are one line long, which puts the caret in the wrong
 * place rather than merely the text. `maxWidth: none` because the measure the theme gives the
 * content would stop it at the box's edge and leave the overflow nowhere to scroll to.
 *
 * The scrollbar is hidden, because a one-line box with a bar under it is a different control and
 * the bar would make the field taller, which is the thing this exists to stop. It still scrolls:
 * with the keyboard as the caret moves, with a trackpad, and by dragging a selection past the edge.
 *
 * A line break a consumer put in the value is still a second line, since their bytes are kept, and
 * that is the one way a `field` is ever two lines tall.
 */
const oneLineScroll = Prec.highest(
  EditorView.theme({
    '.cm-content': { whiteSpace: 'pre', maxWidth: 'none' },
    '.cm-scroller': { overflowX: 'auto', scrollbarWidth: 'none' },
    '.cm-scroller::-webkit-scrollbar': { display: 'none' },
  })
);

/**
 * What the editor draws that the render path does not, and so is left out when the editor is asked
 * where a count of characters falls. A widget is drawn in place of source, or beside it, and is
 * marked as nothing a person types into; the render path has no such element.
 */
const notText = (el: Element): boolean => el.getAttribute('contenteditable') === 'false' || el.classList.contains('cm-widgetBuffer');

export interface SurfaceEditorSpec {
  /** The element the editor is built inside. Emptied first. */
  parent: HTMLElement;
  value: string;
  profile: SurfaceProfile;
  readOnly: boolean;
  /** Called with the whole text whenever it changes. The caller decides what a commit point is. */
  onChange(text: string): void;
}

export interface SurfaceEditor {
  readonly view: EditorView;
  value(): string;
  /** A new value from the consumer, which must not move the caret further than the edit forces. */
  setValue(text: string): void;
  focus(): void;
  /**
   * Focus, and put the caret under a point in client coordinates rather than at the start.
   *
   * This exists for the gesture that builds the editor: a person clicks a rendered surface, the
   * editor is created and focused in the same turn, and without this the caret is at 0 whatever
   * they pointed at. `focus()` is still the right call when nobody pointed at anything, as a
   * consumer's `surface.focus()` or a Tab into the element.
   */
  focusAt(coords: { x: number; y: number }): void;
  /**
   * Focus, and put the caret where `count` visible characters of what the editor draws name, on
   * `side` of them, as `inkPoint` in `inkOffset.ts` describes.
   *
   * The count and side come from the rendered state, so the caret goes to the text the person
   * pointed at rather than to whatever the editor drew at the same coordinates. Returns false,
   * having done nothing, when the editor cannot say where the count falls, and the caller then uses
   * `focusAt` with the coordinates instead.
   */
  focusAtText(count: number, side: Side): boolean;
  destroy(): void;
}

/**
 * Build the editor for a surface that has just been focused.
 *
 * It takes the text rather than a host: the mount owns the value and `onChange` is how it hears
 * about a change, which keeps this module free of the host contract entirely.
 */
export function createSurfaceEditor(spec: SurfaceEditorSpec): SurfaceEditor {
  const language = sheafMarkdown({
    base: commonmarkLanguage,
    extensions: [markdownDialect, { remove: spec.profile === 'field' ? FIELD_BLOCKS : NOTES_BLOCKS }],
  });
  const extensions: Extension[] = [
    language,
    pageType,
    /*
     * The theme, and it is not optional.
     *
     * `media/webview.css` says so in its own CodeMirror section and this is the surface that found
     * out: font family, base line height and the writing column are set in `src/webview/theme.ts`
     * through `EditorView.theme`, because CodeMirror injects its base theme *after* the stylesheet
     * and wins every equal-specificity rule in it. Built without this, every line of prose in Nib's
     * description came out in CodeMirror's default monospace with both stylesheets correctly loaded,
     * which reads as a theming bug in the consumer's page and is not one.
     */
    notionTheme,
    history(),
    keymap.of([...historyKeymap, ...defaultKeymap]),
    revealField,
    livePreview,
    pendingMarks,
    spec.profile === 'field' ? oneLineScroll : EditorView.lineWrapping,
    EditorView.editable.of(!spec.readOnly),
    EditorState.readOnly.of(spec.readOnly),
    /*
     * Every change a person makes, and none the consumer made.
     *
     * A `setValue` is the consumer handing over a value they already hold, so telling them about it
     * is an echo: a consumer saving from `onChange` would write their own server's value straight
     * back to it. It also made the callback depend on something they cannot see, because before the
     * first focus there is no editor and a `setValue` reported nothing, and after it the same call
     * reported a change. So a transaction carrying the consumer's annotation is not reported,
     * whichever state the surface is in.
     */
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (update.transactions.every((tr) => !tr.docChanged || tr.annotation(consumerWrite))) return;
      spec.onChange(update.state.doc.toString());
    }),
  ];
  /*
   * What this surface draws, which is the second half of what a profile is.
   *
   * `remove` on the dialect above takes a construct out of the *parse*, and that is only the half
   * that has a node to take out. Nothing removed a construct from the *drawing*, so a `notes`
   * surface typeset equations, drew pictures, drew Mermaid diagrams and turned `> [!NOTE]` into a
   * titled panel, and a `field` drew pictures and equations, all of which the specification gives to
   * `document` alone. The drawing layer had no profile in it at all: it draws what the modules it
   * imports can draw, and the editor's own extension set is what decided which those were.
   *
   * Declared here rather than read from here, so that `livePreview.ts` does not import the module
   * that composes it. The set comes off the specification's table, so a construct the table moves
   * moves with it and this file holds no list of its own.
   */
  extensions.push(drawnConstructs.of(carriedBy(spec.profile)));
  if (spec.profile === 'field') extensions.push(inlineOnlyEditor.of(true), oneLine, declinedKeys);

  const view = new EditorView({
    state: EditorState.create({ doc: spec.value, extensions }),
    parent: spec.parent,
  });

  /*
   * Whether this editor has been taken down, kept here because `focusAt` can finish a frame later
   * than it started and the view's own `destroyed` is private.
   */
  let gone = false;

  return {
    view,
    value: () => view.state.doc.toString(),
    /*
     * The smallest change that turns one text into the other, rather than a whole-document replace.
     *
     * A replace is one line of code and moves the caret to the end of whatever was inserted, which
     * is the behaviour `pkg.mount` R6 exists to refuse: the consumer owns the value and their server
     * can hand a new one to an editor somebody is typing in. A common prefix and suffix is enough
     * to leave a caret outside the changed span exactly where it was, because CodeMirror maps
     * positions through a change set.
     */
    setValue: (text: string) => {
      const old = view.state.doc.toString();
      if (text === old) return;
      let head = 0;
      while (head < old.length && head < text.length && old[head] === text[head]) head++;
      let tail = 0;
      while (tail < old.length - head && tail < text.length - head && old[old.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
      view.dispatch({
        changes: { from: head, to: old.length - tail, insert: text.slice(head, text.length - tail) },
        /*
         * The consumer's write is not the person's edit, and both annotations say so.
         *
         * `addToHistory.of(false)` keeps it out of the person's Undo. This line was `effects: []`
         * with that same sentence beside it, which does nothing at all: an empty effects array is
         * the default, so the write went into the history like any keystroke and Undo reverted
         * somebody else's data into the editor. A stated reason beside a line that does not do it
         * is worse than the line being absent, because the next reader has no cause to check.
         *
         * `consumerWrite` keeps it out of the `field`'s one-line rule, which exists for text a
         * person puts into the surface. A consumer setting a value they already hold gets it back
         * byte for byte, which is the round trip the package is sold on, and the surface draws
         * whatever that value is.
         */
        annotations: [Transaction.addToHistory.of(false), consumerWrite.of(true)],
      });
    },
    focus: () => view.focus(),
    /*
     * The caret goes where the pointer was, and the two calls below are both needed.
     *
     * `posAtCoords(coords)` is the precise one and answers `null` for two unrelated reasons: the
     * point is outside the drawn content, or the view has not been measured yet. A view built and
     * focused in the same turn is the second case, and it is the whole reason this is not one line:
     * `posAtCoords` reads line geometry, and before a measure there is none, so the nearest-position
     * form returns 0 and the result is indistinguishable from the bug this replaces.
     *
     * So an unanswered precise call goes through `requestMeasure`, whose `read` runs after the view
     * has measured. Inside it the precise form is tried again, and only then does
     * `posAtCoords(coords, false)` stand in: that one never returns `null`, which is what a click
     * below the last line of a short document needs, since the nearest position to a point in the
     * empty space under the text is the end of the document rather than the start.
     *
     * Measured in Chromium: the precise call answers on the first try for a click over text, so
     * the deferred path is the rare one. It is also the one that was silently broken, which is why
     * the dispatch below leaves the measure cycle before it runs. A `write` callback runs with the
     * view mid-update, a `dispatch` from there throws "Calls to EditorView.update are not allowed
     * while an update is in progress", and `measure` hands that to `logException`, which swallows
     * it. So the caret stayed at 0 and nothing anywhere said why. Dispatching from a microtask
     * after the cycle is what makes the deferred path reach the selection at all.
     */
    focusAt: (coords: { x: number; y: number }) => {
      view.focus();
      const put = (pos: number): void => view.dispatch({ selection: { anchor: pos } });
      const at = view.posAtCoords(coords);
      if (at !== null) {
        put(at);
        return;
      }
      view.requestMeasure({
        read: () => view.posAtCoords(coords) ?? view.posAtCoords(coords, false),
        write: (pos) =>
          void Promise.resolve().then(() => {
            if (!gone) put(pos);
          }),
      });
    },
    /*
     * Asked before the editor is focused, because focusing it can show markers on the line the
     * caret is on and a marker that appears is a character the rendered state never had.
     *
     * Two ways the answer is not known, and both decline rather than guess. The editor draws only
     * the lines near its viewport, so a count is found only if the drawing starts at the top of the
     * document; and a count past the end of what is drawn is the end of the text only if the
     * drawing reaches the end of the document.
     */
    focusAtText: (count: number, side: Side) => {
      const { from, to } = view.viewport;
      if (from > 0) return false;
      const point = inkPoint(view.contentDOM, count, notText, side);
      let pos: number;
      if (point) {
        try {
          pos = view.posAtDOM(point.node, point.offset);
        } catch {
          return false;
        }
      } else if (to >= view.state.doc.length) {
        pos = view.state.doc.length;
      } else {
        return false;
      }
      view.focus();
      view.dispatch({ selection: { anchor: pos } });
      return true;
    },
    destroy: () => {
      gone = true;
      view.destroy();
    },
  };
}
