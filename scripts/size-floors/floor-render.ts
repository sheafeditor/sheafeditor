// Markdown to HTML with no editor: what a consumer downloads to render a list of rows.
//
// The whole argument for this path is that it is small, so the number is here rather than in a
// commit message. Read it beside `dialect-alone`, which is the grammar it is built on: the gap
// between them is what rendering costs over parsing.
import { renderMarkdown } from '../../src/render/markdown';
export const floor = { renderMarkdown };
