import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { languages } from '@codemirror/language-data';
import { forceParsing } from '@codemirror/language';
import { sheafMarkdown } from '../src/webview/markdownDialect';
import { sheafMarkdownLanguage } from '../src/webview/markdownLanguage';
import { livePreview } from '../src/webview/livePreview';
import { revealField, setLivePreviewConfig } from '../src/webview/revealState';
import { notionTheme } from '../src/webview/theme';

/**
 * Build a live-preview editor and report what decorations rendered. Exercises the whole
 * engine end-to-end: parser + ViewPlugin + atomicRanges + theme.
 *
 * `reveal` says whether `revealSyntaxOnLine` is on for this run, and it is stated rather
 * than inherited. The setting lives in a module-level variable that whoever ran last may
 * have left either way, and its initial value does not match the manifest default, so a
 * check that reads the caret's own line was reading whichever value happened to be there.
 * The one case here that is about reveal-on-line asks for it; every other case keeps the
 * caret off the line under test and so does not care.
 */
export function run(text: string, { reveal = false }: { reveal?: boolean } = {}) {
  setLivePreviewConfig({ revealSyntaxOnLine: reveal });
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        sheafMarkdown({ base: sheafMarkdownLanguage, codeLanguages: languages }),
        livePreview,
        notionTheme,
        EditorView.lineWrapping,
      ],
    }),
    parent,
  });

  const q = (sel: string) => view.dom.querySelectorAll(sel).length;
  const counts = {
    h1: q('.tok-h1'),
    strong: q('.tok-strong'),
    em: q('.tok-em'),
    strike: q('.tok-strike'),
    inlineCode: q('.tok-inline-code'),
    link: q('.tok-link'),
    quote: q('.tok-quote'),
    bullet: q('.tok-bullet'),
    task: q('.md-task'),
    hr: q('.md-hr'),
    img: q('.md-img'),
    codeBlock: q('.tok-code-block'),
  };

  // Move the selection into the heading and confirm the `#` marker reveals.
  view.dispatch({ selection: { anchor: 2 } });
  const revealedMarksOnActiveLine = view.dom.querySelectorAll('.tok-mark').length;

  view.destroy();
  parent.remove();
  return { counts, revealedMarksOnActiveLine };
}

/**
 * Which lines show their Markdown when the caret is on each line in turn.
 *
 * The reveal rule is the heart of the product and it exists as code and as the comments around it.
 * This derives it: for every line of `text`, put the caret there and record what each line is
 * showing. The answer is the granularity the specification's Part 2 has to state, and deriving it is
 * the alternative to reading it out of the modules, which is how Part 1 came to be wrong three times.
 *
 * **A line is showing its Markdown when the text drawn on it equals the text in the file.** That is
 * the reading, and it is construct-independent on purpose. The first version asked whether the line
 * held a `.tok-mark`, which is the class the live preview leaves on a marker it has not hidden, and
 * that was blind to every construct whose marker carries a different class: a quote, a table and a
 * fence all reported showing nothing with the caret inside them, which reads exactly like a reveal
 * rule that skips them. Comparing drawn text against source text cannot be blind to a class nobody
 * thought of.
 *
 * Three states rather than two, because a block widget replaces its lines rather than drawing them,
 * and "no line element" is not the same answer as "drawn without its markers". `widget` is reported
 * for every line when the element count and the line count disagree, which is the only honest answer
 * available: once a widget has eaten some lines, nothing pairs the rest back up by index.
 */
import { toggleBlockReveal } from '../src/webview/revealBlock';
import { setResourceBaseUri } from '../src/webview/imageMarkup';

export type LineShows = 'source' | 'drawn' | 'widget';

export function revealMap(
  text: string,
  { reveal = true, how = 'caret' }: { reveal?: boolean; how?: 'caret' | 'selection' | 'command' } = {}
): { resting: LineShows[]; rows: { line: number; changed: number[]; shows: LineShows[] }[] } {
  setLivePreviewConfig({ revealSyntaxOnLine: reveal });
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      /*
       * `revealField` is here and not in `run`'s list above, which is the correction to what I wrote
       * when I left the command route unmeasured: `revealMap` builds its own view, so installing the
       * field the Edit Markdown command reads costs the fourteen checks that use `run` nothing. The
       * obstacle I described did not exist.
       */
      extensions: [sheafMarkdown({ base: sheafMarkdownLanguage, codeLanguages: languages }), livePreview, revealField, notionTheme, EditorView.lineWrapping],
    }),
    parent,
  });
  /*
   * The line elements, taken in document order, paired with the document's lines by index.
   *
   * `domAtPos` was the second attempt and it resolves to nothing under jsdom, so every line read as
   * replaced by a widget, which is as wrong as the first attempt and in the opposite direction. The
   * `.cm-line` elements are there; reaching them through the view's own position mapping is what is
   * not.
   *
   * Pairing by index is only sound while the counts agree, and a block widget replacing lines is
   * exactly when they do not. So the count is checked and a mismatch is reported rather than paired
   * over, which is the difference between a reading and a guess.
   */
  const readAll = (): LineShows[] => {
    const els = [...view.dom.querySelectorAll('.cm-content > .cm-line')];
    const count = view.state.doc.lines;
    if (els.length !== count) return Array.from({ length: count }, () => 'widget' as LineShows);
    return els.map((el, i) => ((el.textContent ?? '') === view.state.doc.line(i + 1).text ? 'source' : 'drawn'));
  };
  /*
   * What the caret changes, rather than what each line is showing.
   *
   * "The drawn text equals the source" is true of any line with no markup to hide, so an absolute
   * reading called every blank line and every plain sentence a reveal. The third attempt reported
   * eleven of twenty-one lines revealing wherever the caret went, which is a false positive from a
   * comparison that is true for the wrong reason.
   *
   * So each line's resting state is read first, with the caret parked on a line that reveals nothing,
   * and a reveal is a line whose state differs from resting. That is immune to a line with nothing to
   * hide, because such a line reads the same either way.
   */
  /*
   * Rest on a blank line, because the resting position must itself reveal nothing. Parking it on the
   * last line put the caret inside a construct, so that construct was revealed at rest and every
   * other position reported it as changed: it appeared in all twenty-one rows, which reads like a
   * line that reveals from anywhere.
   */
  let restingAt = 0;
  for (let n = 1; n <= view.state.doc.lines; n++) {
    if (view.state.doc.line(n).text.trim() === '') {
      restingAt = n;
      break;
    }
  }
  if (!restingAt) throw new Error('revealMap needs a blank line to rest the caret on, and this text has none.');
  view.dispatch({ selection: { anchor: view.state.doc.line(restingAt).from } });
  const resting = readAll();

  /*
   * The caret is one route and `render.reveal-on-line` R3 names another: "every block a selection
   * touches". The selection has to **cross a block boundary** to ask that, which the first version
   * missed: it selected one line, which touches the block the caret would have been in anyway, and
   * produced a table identical to the caret's for a structural reason. A table that duplicates
   * another invites the reader to conclude the two routes agree, when the interesting case was never
   * asked.
   *
   * So a selection runs from this line to the end of the line three below it, which crosses at least
   * one boundary in a document laid out with blank lines between its blocks. What it should reveal is
   * every block the range touches, rather than one of them.
   */
  const rows: { line: number; changed: number[]; shows: LineShows[] }[] = [];
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n);
    const spanTo = view.state.doc.line(Math.min(n + 3, view.state.doc.lines)).to;
    view.dispatch({ selection: how === 'selection' ? { anchor: line.from, head: spanTo } : { anchor: line.from } });
    /*
     * The third route: Edit Markdown, the one command behind Cmd+Alt+E, the block handle's menu item
     * and the right-click menu. Called rather than driven by a key, because the key is the workbench's
     * question and this one is about what the command does to a block.
     *
     * It toggles, so the caret is moved to a line that reveals nothing first and the command run twice
     * there, to leave no block open from the previous iteration. Without that, every row after the
     * first reads as the previous row's block still showing.
     */
    if (how === 'command') toggleBlockReveal(view);
    const shows = readAll();
    if (how === 'command') {
      view.dispatch({ selection: { anchor: view.state.doc.line(restingAt).from } });
      toggleBlockReveal(view);
      toggleBlockReveal(view);
    }
    rows.push({ line: n, changed: shows.map((v, i) => (v === resting[i] ? 0 : i + 1)).filter(Boolean), shows });
  }
  view.destroy();
  parent.remove();
  /*
   * The resting state is returned beside the rows, because without it "this line never changed" is
   * two different answers wearing one face: a line that is never revealed, and a line that is always
   * showing its source and so has nothing to reveal. Every disambiguation this instrument needed came
   * down to telling those apart.
   */
  return { resting, rows };
}

/** Elements with no text, which therefore cannot be judged by whether their text is in the source. */
const VOID_DRAWN = new Set(['INPUT', 'IMG', 'HR', 'SVG', 'CANVAS', 'BR']);

/**
 * CodeMirror's own furniture, which is not the product drawing anything.
 *
 * Two of these read exactly like a finding and are not. `cm-widgetBuffer` is a zero-width `<img>` the
 * library puts beside *every* replace decoration to keep the caret's affinity right, so it appeared on
 * sixteen of the twenty-seven lines and tracked the hidden markers precisely enough to look like the
 * answer. A bare `<br>` is the filler in an empty line, so it appeared on every blank one. Reported,
 * they would put a widget against lines that have none and bury the three that matter.
 */
const cmsOwn = (e: Element) =>
  e.classList.contains('cm-widgetBuffer') || (e.tagName === 'BR' && !e.classList.length);

/**
 * What a reader reads on the line, with the controls taken out.
 *
 * A picture carries its own toolbar, so the line's `textContent` is `SMLFullAltCaption` and the table
 * said a picture is drawn as that. Read from a clone, because removing a node from the live view would
 * leave the editor without the toolbar it just built.
 */
function drawnText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const bar of [...copy.querySelectorAll('.md-img-toolbar')]) bar.remove();
  return copy.textContent ?? '';
}

/**
 * What is drawn in place of what, at rest, line by line.
 *
 * The other half of the rendering contract. `revealMap` answers when a construct shows its source;
 * this answers what a reader sees when it does not: the bytes in the file, the text drawn over them,
 * and whether anything was replaced rather than restyled.
 *
 * At rest means the caret parked on a blank line, for the reason `revealMap` found the hard way: a
 * caret inside a construct reveals it, and a table of "what is drawn" read with the caret in the
 * first construct describes every construct except that one.
 *
 * `widgets` is the distinguishing class names found inside the line, which is how a replacement is
 * told from a hidden marker: a hidden marker leaves text with fewer characters, a widget leaves an
 * element that was never in the file.
 */
export function drawMap(text: string): { line: number; source: string; drawn: string; widgets: string[] }[] {
  setLivePreviewConfig({ revealSyntaxOnLine: false });
  /*
   * A picture needs a base to resolve its path against, and that arrives in `init`, which nothing
   * sends to a view built here. Without it `resolveImageSrc` returns null, `imageWidgetFor` builds no
   * widget, and the markers are merely hidden: the line reads `drawn as "alt text"` with no widget,
   * which is indistinguishable from an editor that draws a picture's alt text instead of the picture.
   * The first reading of this table said exactly that, and it was a missing precondition rather than
   * anything the product does. Restored afterwards, because the base is module state and this is the
   * only caller that wants one.
   */
  setResourceBaseUri('https://res.test/');
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [sheafMarkdown({ base: sheafMarkdownLanguage, codeLanguages: languages }), livePreview, revealField, notionTheme, EditorView.lineWrapping],
    }),
    parent,
  });
  /*
   * Draw the whole document rather than the first screenful.
   *
   * jsdom lays nothing out, so CodeMirror cannot tell how much is on screen and draws one screen's
   * worth; and the parser works to the viewport and then on idle time a script never gives it. Both
   * leave every line below the first screen with no tree under it, drawn as raw source. A caller
   * reading that sees a product that renders the top of a file and gives up, which is what the first
   * run of `check-render-agrees.mjs` reported over all 85 corpus documents.
   *
   * The same two steps `scripts/check-render.mjs` takes, and for the same reason. The caller supplies
   * the tall viewport, since that is a property of the window rather than of this function; what is
   * here is the parse and the measure pass, which belong to the view this builds.
   */
  forceParsing(view, view.state.doc.length, 10000);
  /*
   * `measure()` rather than `requestMeasure()`: the public one schedules the pass on an animation
   * frame, and a script that never yields one gets a different answer on every run depending on what
   * happened to have been measured already. This is the same call `scripts/check-render.mjs` makes,
   * from JavaScript where no cast is needed.
   */
  const sync = view as unknown as { measure(): void };
  for (let i = 0, last = -1; i < 100; i++) {
    sync.measure();
    const to = view.viewport.to;
    if (to >= view.state.doc.length || to === last) break;
    last = to;
  }

  let rest = 0;
  for (let n = 1; n <= view.state.doc.lines; n++) {
    if (view.state.doc.line(n).text.trim() === '') {
      rest = n;
      break;
    }
  }
  if (!rest) throw new Error('drawMap needs a blank line to rest the caret on, and this text has none.');
  view.dispatch({ selection: { anchor: view.state.doc.line(rest).from } });

  /*
   * Line elements mapped to line numbers by asking the view where each one is, rather than by
   * assuming there is one element per line.
   *
   * The assumption was `els.length === doc.lines ? els[n - 1] : undefined`, which is **all or
   * nothing**: a document holding any block widget has fewer elements than lines, so every line in it
   * reported "(no line element)". That is not a rare shape. `sample/wild/files/mermaid-flowchart-syntax.md`
   * holds 114 diagrams, so all 1,494 of its lines came back unreadable, and four other corpus
   * documents went the same way for an image or a table between them. A caller comparing against this
   * sees 1,379 lines of the renderer disagreeing with the editor, when it is the instrument declining
   * to answer.
   *
   * `posAtDOM` is the view's own answer and rests on nothing. A line the view did not draw has no
   * entry, which is the honest result and is still distinguishable from a line drawn as empty.
   */
  const els = [...view.dom.querySelectorAll('.cm-content > .cm-line')];
  const byLine = new Map<number, Element>();
  for (const el of els) {
    try {
      byLine.set(view.state.doc.lineAt(view.posAtDOM(el)).number, el);
    } catch {
      // An element the view cannot place is one this cannot report on, which the map says by omission.
    }
  }
  const out: { line: number; source: string; drawn: string; widgets: string[] }[] = [];
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const source = view.state.doc.line(n).text;
    const el = byLine.get(n);
    /*
     * Content that was never in the file, which is what distinguishes a replacement from a hidden
     * marker. Found by asking whether an element's own text appears in the source line rather than by
     * matching class names: the first version collected classes beginning `md-` and missed the bullet
     * a list marker is replaced by, because that element's class does not begin `md-`. A name is a
     * guess about where the product put something; absent text is a reading.
     */
    const widgets = el
      ? [...new Set(
          [...el.querySelectorAll('*')]
            .filter((e) => {
              if (cmsOwn(e)) return false;
              // A control the reader acts through is not content drawn in place of anything. The
              // picture's own toolbar is six buttons, and reporting its descendants put `S`, `M`, `L`,
              // `Full`, `Alt` and `Caption` in the widget column of a table about rendering. The
              // toolbar itself is reported, once, so its presence is still visible.
              if (e.closest('.md-img-toolbar') && !e.classList.contains('md-img-toolbar')) return false;
              // An element carrying no text cannot be judged by its text, and three of the constructs
              // that are *replaced* rather than restyled carry none: a task's checkbox, a horizontal
              // rule and a picture. The first version read text alone and reported nothing for all
              // three, which is the half of this contract they were added to exercise.
              if (VOID_DRAWN.has(e.tagName)) return true;
              const t = drawnText(e).trim();
              return t.length > 0 && !source.includes(t);
            })
            .map((e) => {
              const name = [...e.classList][0] ?? e.tagName.toLowerCase();
              const t = drawnText(e).trim();
              if (e.classList.contains('md-img-toolbar')) return name;
              return VOID_DRAWN.has(e.tagName) ? `${e.tagName.toLowerCase()}:${name}` : `${name}=${JSON.stringify(t.slice(0, 12))}`;
            })
        )].sort()
      : [];
    out.push({ line: n, source, drawn: el ? drawnText(el) : '(no line element)', widgets });
  }
  view.destroy();
  parent.remove();
  setResourceBaseUri('');
  return out;
}
