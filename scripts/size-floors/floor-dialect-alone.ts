// Sheaf's dialect with no editor at all: the grammar a consumer needs to parse Markdown.
//
// This is the number `src/dialect/markdown.ts` exists to make possible, and it is here so the claim
// is reproducible by running something rather than by trusting a commit message. 20 KB gzipped at
// the split, against 91 KB when the dialect still reached CodeMirror's view layer.
//
// Read it beside `floor-dialect`, which measures the same dialect **inside CodeMirror** and is a
// different question: `view-only` at 63 KB is most of the difference between them.
import { parser } from '@lezer/markdown';
import { markdownDialect } from '../../src/dialect/markdown';
export const floor = { p: parser.configure(markdownDialect) };
