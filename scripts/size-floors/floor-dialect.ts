// CodeMirror's state, view and language, **plus** Sheaf's own dialect, as an editor loads it.
//
// The name has misled a reader already: this is not the cost of the dialect, it is the cost of the
// dialect inside an editor, and `view-only` at 63 KB is most of it. The dialect on its own is
// `floor-dialect-alone`, which is 20 KB and has no CodeMirror in it.
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { sheafMarkdownLanguage } from '../../src/webview/markdownLanguage';
export const floor = { EditorState, EditorView, keymap, syntaxTree, lang: sheafMarkdownLanguage };
