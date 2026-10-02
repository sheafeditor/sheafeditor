// CodeMirror's state, view and language packages, and nothing of Sheaf's.
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxTree, LanguageSupport } from '@codemirror/language';
export const floor = { EditorState, EditorView, keymap, syntaxTree, LanguageSupport };
