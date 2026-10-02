// The above plus `markdown()` from `@codemirror/lang-markdown`, which is what Sheaf used until it
// assembled its own language. Kept as the control for that: this entry still pulls `lang-html`, and
// `lang-css`, `lang-javascript` and two Lezer grammars behind it, so the gap between this floor and
// `floor-dialect` is what dropping the embedded HTML parser is worth.
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { markdown, commonmarkLanguage } from '@codemirror/lang-markdown';
export const floor = { EditorState, EditorView, keymap, syntaxTree, md: markdown({ base: commonmarkLanguage }) };
