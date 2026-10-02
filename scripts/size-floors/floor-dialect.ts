// And Sheaf's own dialect, which is what the issue behind this means by "plus the dialect".
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { sheafMarkdownLanguage } from '../../src/webview/markdownDialect';
export const floor = { EditorState, EditorView, keymap, syntaxTree, lang: sheafMarkdownLanguage };
