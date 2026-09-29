/*
 * What a link to another document needs: the address to write, and the words to write it as.
 *
 * Pasting a path writes `[Title](notes/plan.md)` rather than the path twice over, and
 * completing one after `(` writes the same address. Three places answer those two questions —
 * the extension host, the browser host and the editor's own completion — and they have to
 * answer them the same way, so both readings are here rather than once each.
 *
 * Pure string work, no file system and no `node:path`: the hosts read the file, this reads
 * the text. That is what lets the browser host and the editor use it, since both run in a
 * page, and what keeps the extension host's bundle free of a module a browser has no answer
 * for.
 */

/**
 * `target` written as an address relative to the folder `fromFile` sits in, both POSIX.
 *
 * `docs/notes.md` and `docs/plan.md` give `plan.md`; `docs/notes.md` and `plan.md` give
 * `../plan.md`. No `./` in front of a sibling, because Markdown needs none and every tool
 * that writes these by hand leaves it off.
 */
export function relativeLink(fromFile: string, target: string): string {
  const from = fromFile.split('/').filter(Boolean).slice(0, -1);
  const to = target.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return '../'.repeat(from.length - common) + to.slice(common).join('/');
}

/** A YAML front-matter fence: the only thing allowed above a document's first heading here. */
const FENCE = /^---[ \t]*$/;

/** An ATX heading, at any level, with the trailing `###` a closed one may carry. */
const HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * The title `text` gives itself: its first heading, or the file name when it has none.
 *
 * The first heading of any level, not only `#`. A document that opens at `##` is a document
 * somebody wrote that way, usually because its `#` lives in a template or a site's own
 * chrome, and the first thing it says is still its title.
 *
 * Front matter is skipped, because the fence's `---` is not a heading and neither is
 * anything between the fences. A `title:` in there is not read: front matter is a different
 * question with its own conventions per generator, and guessing at them would put a key
 * nobody meant as a title into somebody's prose.
 *
 * The fallback is the file name with its extension off and nothing else done to it, so
 * `release-notes.md` links as `release-notes`. Turning the hyphens into spaces and
 * capitalising would be inventing a title the document does not have.
 */
export function documentTitle(text: string, path: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  let from = 0;
  if (lines.length && FENCE.test(lines[0])) {
    const close = lines.findIndex((line, i) => i > 0 && FENCE.test(line));
    // An unclosed fence is not front matter, so the document is read from the top.
    if (close > 0) from = close + 1;
  }
  let fenced: string | null = null;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    // A `#` inside a fenced block is a comment in somebody's code, not a heading.
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenced === null) fenced = fence[1][0].repeat(fence[1].length);
      else if (line.trimStart().startsWith(fenced)) fenced = null;
      continue;
    }
    if (fenced !== null) continue;
    const heading = HEADING.exec(line);
    if (heading && heading[2].trim()) return heading[2].trim();
  }
  return fileTitle(path);
}

/** A path's file name with its extension off, which is the title a document with no heading has. */
export function fileTitle(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
  return name.replace(/\.[^.]+$/, '') || name;
}
