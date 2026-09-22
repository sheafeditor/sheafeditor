/*
 * Where a document's YAML front matter ends.
 *
 * One definition, in a module that imports nothing of Sheaf's, because several
 * parts of the editor have to agree about it and one of them cannot reach the
 * others. The block model uses it to mark the opening block immovable; the link
 * paste uses it to refuse writing Markdown into a file's own metadata. Those two
 * sit on opposite sides of the import graph, and a second copy of the rule here
 * would be a second answer waiting to disagree with the first.
 *
 * It is a text question rather than a tree one. The dialect has no node for front
 * matter: `title: x` over a closing `---` parses as a Setext heading, which is
 * why anything asking the tree "is this prose" says yes in here.
 */

import type { Text } from '@codemirror/state';

/**
 * The line number closing YAML front matter that opens the document, or 0 when
 * there is none.
 *
 * A document has front matter only when `---` is its very first line, so a rule
 * in the body is a divider and never the start of one. The second line must hold
 * something, because `---` with a blank line under it is a heading's underline
 * rather than an opening fence. Either closing spelling is accepted.
 */
export function frontMatterEnd(doc: Text): number {
  if (doc.lines < 3 || doc.line(1).text.trimEnd() !== '---' || doc.line(2).text.trim() === '') return 0;
  for (let n = 2; n <= doc.lines; n++) {
    const t = doc.line(n).text.trimEnd();
    if (t === '---' || t === '...') return n;
  }
  return 0;
}

/** Whether `pos` lies inside a document's front matter, fences included. */
export function posInFrontMatter(doc: Text, pos: number): boolean {
  const end = frontMatterEnd(doc);
  return end > 0 && pos <= doc.line(end).to;
}
