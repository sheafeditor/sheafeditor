/*
 * The render path, as a package entry.
 *
 * Markdown to HTML with no editor anywhere in it, which is what a list of fifty rows wants. The
 * implementation is `src/render/markdown.ts`; this file is the name the `exports` map points at,
 * and it holds nothing but the re-exports, deliberately: a package entry that adds behaviour is a
 * second implementation of the thing it is supposed to be publishing.
 *
 * `scripts/check-dialect-imports.mjs` holds the rule that keeps this honest — nothing this reaches
 * may import `@codemirror/view` — and `scripts/check-package.mjs` asserts that the bundle this
 * builds into carries no editor.
 */
export { renderMarkdown, dialectParser, TAGS } from '../render/markdown';
export type { Profile, OutOfScope, RenderResult } from '../render/markdown';
