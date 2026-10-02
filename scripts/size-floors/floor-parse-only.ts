// No CodeMirror at all: the Markdown parser on its own, which is what a render-only path needs.
import { parser } from '@lezer/markdown';
export const floor = { parser };
