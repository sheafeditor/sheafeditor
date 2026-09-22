/*
 * Whole-document source mode: the command that shows the file as it is written,
 * markers and pipe rows and all, and shows it again as a rendered document when
 * it is turned off.
 *
 * The checks read the editor's rendered lines back and compare them with the
 * document's own lines, because "shows the source" means exactly that: line for
 * line, the text on screen is the text in the file. A rendered table is a block
 * widget rather than a line, so comparing the two lists catches a grid that is
 * still drawn as well as a marker that is still hidden.
 */

import { Scenario, mountProse, Prose } from '../harness';
import { Transaction } from '@codemirror/state';
import { setDocumentSourceMode, setLivePreviewConfig, sourceModeOn } from '../../src/webview/livePreview';

const DOC = [
  '# Title',
  '',
  'A **bold** word and a [link](https://example.com) here.',
  '',
  '## Heading two',
  '',
  '- First item',
  '- Second item',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n');

/** Every rendered line of the editor, as its text. */
const renderedLines = (p: Prose): string[] =>
  Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')).map((el) => el.textContent ?? '');

/** The whole editor as it reads on screen, lines joined back up. */
const rendered = (p: Prose): string => renderedLines(p).join('\n');

/** Whether the editor shows the document line for line, as written. */
const showsSource = (p: Prose): boolean => {
  const source = p.view.state.doc.toString().split('\n');
  const shown = renderedLines(p);
  return shown.length === source.length && shown.every((text, i) => text === source[i]);
};

/** Turn source mode on or off the way the command does, class and state together. */
const sourceMode = (p: Prose, on: boolean): void =>
  setDocumentSourceMode(p.view, p.view.dom.parentElement as HTMLElement, on);

/** How many nodes match `selector` in the editor DOM. */
const count = (p: Prose, selector: string): number => p.view.contentDOM.querySelectorAll(selector).length;

/**
 * Mount with "Reveal Syntax On Line" off and put it back on afterwards, which is
 * the value the other scenarios in this suite expect. That setting shows the
 * caret's own line as Markdown, which would make a rendered line read as source
 * for reasons that have nothing to do with source mode.
 */
const withProse = (doc: string, fn: (p: Prose) => boolean): boolean => {
  setLivePreviewConfig({ revealSyntaxOnLine: false });
  const p = mountProse(doc);
  try {
    return fn(p);
  } finally {
    p.destroy();
    setLivePreviewConfig({ revealSyntaxOnLine: true });
  }
};

/**
 * An edit arriving from outside the editor, as a change to the file on disk does:
 * the host's minimal edit, marked remote and kept out of this editor's history.
 */
const outsideChange = (p: Prose, from: number, to: number, insert: string): void => {
  p.view.dispatch({
    changes: { from, to, insert },
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    scrollIntoView: false,
  });
};

export const scenarios: Scenario[] = [
  {
    name: 'source mode shows every line of the document as it is written',
    run: () =>
      withProse(DOC, (p) => {
        p.select(0);
        // Rendered first: the markers are hidden, so the screen and the file differ.
        const renderedHidesMarkers = !rendered(p).includes('**') && !showsSource(p);
        sourceMode(p, true);
        const onIsSource = sourceModeOn(p.view.state) && showsSource(p);
        const shown = rendered(p);
        const linesAsWritten =
          shown.includes('A **bold** word and a [link](https://example.com) here.') &&
          shown.includes('## Heading two') &&
          shown.includes('- First item');
        return renderedHidesMarkers && onIsSource && linesAsWritten;
      }),
  },
  {
    name: 'source mode turns a table back into its pipe rows',
    run: () =>
      withProse(DOC, (p) => {
        p.select(0);
        const gridDrawn = count(p, '.sheaf-table') === 1;
        sourceMode(p, true);
        const gridGone = count(p, '.sheaf-table') === 0;
        const pipeRows = renderedLines(p);
        const rowsShown =
          pipeRows.includes('| a | b |') && pipeRows.includes('| --- | --- |') && pipeRows.includes('| 1 | 2 |');
        return gridDrawn && gridGone && rowsShown;
      }),
  },
  {
    name: 'leaving source mode renders the document again and leaves the caret where it was',
    run: () =>
      withProse(DOC, (p) => {
        const caret = DOC.indexOf('word');
        p.select(caret);
        const before = rendered(p);
        sourceMode(p, true);
        const wentToSource = showsSource(p);
        sourceMode(p, false);
        const caretKept = p.view.state.selection.main.head === caret && p.view.state.selection.main.empty;
        return wentToSource && !sourceModeOn(p.view.state) && rendered(p) === before && caretKept;
      }),
  },
  {
    name: 'a change from outside the editor still shows as source',
    run: () =>
      withProse(DOC, (p) => {
        p.select(0);
        sourceMode(p, true);
        const onBefore = showsSource(p);
        // The file grew a paragraph below the heading, the way a change on disk arrives.
        const at = DOC.indexOf('## Heading two') + '## Heading two'.length;
        outsideChange(p, at, at, '\n\nAn *outside* line.');
        const stillOn = sourceModeOn(p.view.state);
        const stillSource = showsSource(p);
        const newLineAsWritten = rendered(p).includes('An *outside* line.');
        return onBefore && stillOn && stillSource && newLineAsWritten;
      }),
  },
  {
    name: 'a line break typed in source mode does not put the source away',
    run: () =>
      withProse(DOC, (p) => {
        sourceMode(p, true);
        const at = DOC.indexOf('here.') + 'here.'.length;
        p.select(at);
        p.view.dispatch({ changes: { from: at, insert: '\n' }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
        return sourceModeOn(p.view.state) && showsSource(p);
      }),
  },
  {
    name: 'Escape and Edit Markdown leave source mode on, since the command is what ends it',
    run: () =>
      withProse(DOC, (p) => {
        p.select(DOC.indexOf('word'));
        sourceMode(p, true);
        p.press('Escape');
        const afterEscape = sourceModeOn(p.view.state) && showsSource(p);
        p.press('Mod-Alt-e');
        const afterEditMarkdown = sourceModeOn(p.view.state) && showsSource(p);
        sourceMode(p, false);
        return afterEscape && afterEditMarkdown && !sourceModeOn(p.view.state) && !showsSource(p);
      }),
  },
  {
    name: 'toggling source mode on and off leaves the document byte-identical',
    run: () =>
      withProse(DOC, (p) => {
        p.select(DOC.indexOf('| 1 | 2 |'));
        sourceMode(p, true);
        const onSame = p.doc() === DOC;
        sourceMode(p, false);
        return onSame && p.doc() === DOC;
      }),
  },
];
