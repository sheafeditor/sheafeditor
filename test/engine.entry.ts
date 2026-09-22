import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { sheafMarkdownLanguage } from '../src/webview/markdownDialect';
import { livePreview } from '../src/webview/livePreview';
import { notionTheme } from '../src/webview/theme';

// Build a live-preview editor and report what decorations rendered. Exercises
// the whole engine end-to-end: parser + ViewPlugin + atomicRanges + theme.
export function run(text: string) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        markdown({ base: sheafMarkdownLanguage, codeLanguages: languages }),
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
