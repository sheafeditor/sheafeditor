/*
 * The editing surface, as the package entry a mounted surface fetches on first focus.
 *
 * **This file is why `mount` is not an editor.** `src/lib/index.ts` draws a surface with
 * `renderMarkdown`, which is a parser and a string walk; the editor is CodeMirror, the live-preview
 * decorations and the keymap, and all of that arrives here. `index.ts` reaches it by
 * `import('sheafeditor/editor')`, a bare specifier that goes through the package's own `exports`
 * map, so the file a consumer's bundler fetches for it is a file the map names rather than a chunk
 * the bundler invented. That is the only reason the import is written as a self-reference rather
 * than as `./editor`.
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
import { EditorState, Extension, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { markdownDialect } from '../dialect/markdown';
import { sheafMarkdown } from '../webview/markdownDialect';
import { livePreview } from '../webview/livePreview';
import { revealField } from '../webview/revealState';
import { inlineOnlyEditor } from '../webview/inlineOnly';
import { pendingMarks } from '../webview/pendingMarks';
import { notionTheme } from '../webview/theme';

/** Which constructs a surface carries. `document` is the extension's own editor and is not here. */
export type SurfaceProfile = 'field' | 'notes';

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
 * A line break arriving in a `field` becomes a space.
 *
 * Taken from the table cell, where the same rule holds for the same reason: the surface is one
 * line, so Enter belongs to the consumer and text pasted with a newline in it has to go somewhere.
 * A space is what the table's own writer makes of it.
 */
const oneLine = EditorState.transactionFilter.of((tr) => {
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
    EditorView.lineWrapping,
    EditorView.editable.of(!spec.readOnly),
    EditorState.readOnly.of(spec.readOnly),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) spec.onChange(update.state.doc.toString());
    }),
  ];
  if (spec.profile === 'field') extensions.push(inlineOnlyEditor.of(true), oneLine);

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
         * The consumer's write is not the person's edit, so their Undo does not take it back.
         *
         * `addToHistory.of(false)` is what says that. This line was `effects: []` with this same
         * sentence beside it, which does nothing at all: an empty effects array is the default, so
         * the write went into the history like any keystroke and Undo reverted somebody else's data
         * into the editor. A stated reason beside a line that does not do it is worse than the line
         * being absent, because the next reader has no cause to check.
         */
        annotations: Transaction.addToHistory.of(false),
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
    destroy: () => {
      gone = true;
      view.destroy();
    },
  };
}
