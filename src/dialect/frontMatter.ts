/*
 * A document's YAML front matter: where it ends, and what its fields say.
 *
 * One definition, in a module that imports nothing of Sheaf's, because several parts of the editor
 * have to agree about it and one of them cannot reach the others. The block model uses the end line
 * to mark the opening block immovable; the link paste uses it to refuse writing Markdown into a
 * file's own metadata; the render path reads it against a plain string. Those sit on opposite sides
 * of the import graph, and a second copy of the rule here would be a second answer waiting to
 * disagree with the first.
 *
 * **Beside the grammar, because front matter is a fact about the bytes.** The dialect is what Sheaf
 * reads: a consumer that wants to parse a document, render rows on a server, or draw a field nobody
 * is typing in should not have to download an editor to do it, and the enforced rule is that nothing
 * reachable from this layer imports `@codemirror/view`. Both exports below are read by the drawing
 * layer and by the render path, and neither carries a view.
 *
 * It is a text question rather than a tree one. The dialect has no node for front matter:
 * `title: x` over a closing `---` parses as a Setext heading, which is why anything asking the tree
 * "is this prose" says yes in here. That is about mechanism rather than placement, and it is a
 * warning to anybody tempted to reach for the syntax tree instead of reading lines.
 *
 * ## The fields parser refuses what it does not understand
 *
 * Front matter is somebody's data, and a misparse of it does not fail where anyone can see: it
 * produces a wrong tag, a wrong author, a wrong field on a card. So `frontMatterFields` reads one
 * narrow subset and reports everything else as not understood, with the line and the reason. It
 * never half-reads a value. A key whose value is a nested map, a multi-line scalar, an anchor or a
 * tag yields no field at all, and so does a key that appears twice, because which of the two wins
 * would be a guess. A list one of whose items is itself a map, an anchor or a reference to another
 * key's value is refused whole rather than coming back as the items around it, because a list short
 * by one member is the wrong tag this parser exists to refuse, and a member read as the characters
 * `*defaults` is a worse one that looks right. **Never silently degrade**, applied to a parser.
 *
 * The subset is what the format asks for: flat keys, scalar values quoted or plain, flow sequences
 * on one line, and the indented `- item` form, which is how the convention writes a field with
 * several values and is therefore not an edge case. By hand rather than with a YAML library, because
 * the whole argument for this layer is that a consumer who only wants to read Markdown downloads
 * nothing, and `check-dialect-imports.mjs` polices editors rather than size, so it would not catch
 * the dependency.
 *
 * Types stay advisory, as they do for table columns. A value comes back as the text that was
 * written, and deciding that `3` is a number is the caller's.
 */

import type { Text } from '@codemirror/state';

/**
 * The least a caller has to be able to do for the rules below to read it: count lines and hand one
 * over. `Text` satisfies this already, and so does a plain string wrapped in four lines, which is
 * what the render path does.
 *
 * It exists because the rule has a second reader now. `src/render/markdown.ts` runs in Node against
 * a string, with no `@codemirror/state` anywhere in its closure and 45 KB of reasons to keep it that
 * way, and front matter is 4,512 lines of the corpus: a second copy of these six lines over there
 * would be the second answer this module's own comment says it exists to prevent.
 */
export interface LineSource {
  readonly lines: number;
  line(n: number): { text: string };
}

/**
 * The line number closing YAML front matter that opens the document, or 0 when
 * there is none.
 *
 * A document has front matter only when `---` is its very first line, so a rule
 * in the body is a divider and never the start of one. The second line must hold
 * something, because `---` with a blank line under it is a heading's underline
 * rather than an opening fence. Either closing spelling is accepted.
 */
export function frontMatterEnd(doc: LineSource): number {
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

/**
 * A field's value, as written.
 *
 * Two shapes rather than one, because a list is one field with several values and flattening it to
 * its source text would make every caller re-split it, differently. Numbers, booleans and dates
 * stay as text: what a value means is the caller's question and the format calls types advisory.
 */
export type FrontMatterValue =
  | { readonly kind: 'scalar'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] };

/** Why a line in the block produced no field. Each one is a construct this parser does not read. */
export type FrontMatterRefusal =
  | 'nested map'
  | 'sequence'
  | 'multi-line scalar'
  | 'quoted key'
  | 'duplicate key'
  | 'anchor or alias'
  | 'tag'
  | 'malformed scalar'
  | 'not a key';

/** One thing in the block that was left alone, with enough to tell a reader where and why. */
export interface FrontMatterNotUnderstood {
  /** The line it was written on, counting from 1 as the document does. */
  readonly line: number;
  /** The key it was the value of, or null when the line carries no readable key. */
  readonly key: string | null;
  readonly reason: FrontMatterRefusal;
}

/**
 * What a document's front matter says.
 *
 * `notUnderstood` empty means every line in the block was read. A caller that gets entries in it
 * knows exactly what was left alone and can say so, which is the same bargain `outOfScope` makes in
 * the render path.
 */
export interface FrontMatterFields {
  /** The closing line of the block, or 0 when the document has no front matter. */
  readonly end: number;
  /** The keys that were understood, in the order they were written. */
  readonly fields: ReadonlyMap<string, FrontMatterValue>;
  readonly notUnderstood: readonly FrontMatterNotUnderstood[];
}

/** A key Sheaf will read: letters, digits, `_`, `.`, `-`, and single spaces between those. */
const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?: [A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

/** The escapes a double-quoted scalar may carry. Anything else is refused rather than guessed at. */
const ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', '/': '/', n: '\n', r: '\r', t: '\t' };

/**
 * The fields of a document's front matter, and everything in it this parser would not read.
 *
 * A document with no front matter, and one whose opening `---` is never closed, both give the empty
 * answer: no fields and nothing not understood, because there was no block to read. That is a
 * different answer from a block that was there and held something unreadable, and the two must not
 * collapse into each other.
 */
export function frontMatterFields(doc: LineSource): FrontMatterFields {
  const end = frontMatterEnd(doc);
  const notUnderstood: FrontMatterNotUnderstood[] = [];
  if (end === 0) return { end: 0, fields: new Map(), notUnderstood };

  /*
   * Group first, classify second.
   *
   * A line indented under a key belongs to that key, and what it is depends on the lines rather than
   * on the key: `tags:` with `- a` under it is a list and `author:` with `name: x` under it is a map.
   * So nothing can be classified until its followers are in hand, which is why this is two passes
   * rather than one walk with a flag.
   *
   * A follower keeps its indent, because the depth is what separates a list of scalars from a list
   * of maps. `- a` and `- b` at one depth are two values; `- name: x` with `role: y` under it is one
   * map wearing the same `- `.
   */
  const entries: { line: number; text: string; followers: Follower[] }[] = [];
  for (let n = 2; n < end; n++) {
    const text = doc.line(n).text.replace(/\s+$/, '');
    if (text === '') continue;
    if (/^\s*#/.test(text)) continue;
    if (/^[ \t]/.test(text)) {
      const owner = entries[entries.length - 1];
      if (owner) owner.followers.push({ indent: text.length - text.trimStart().length, text: text.trimStart() });
      else notUnderstood.push({ line: n, key: null, reason: 'not a key' });
      continue;
    }
    entries.push({ line: n, text, followers: [] });
  }

  /** Every occurrence of every key, so a duplicate can be refused on both its lines at once. */
  const seen = new Map<string, { line: number; value: FrontMatterValue | null }[]>();

  for (const entry of entries) {
    const { line, text, followers } = entry;

    if (text === '-' || text.startsWith('- ')) {
      notUnderstood.push({ line, key: null, reason: 'sequence' });
      continue;
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      notUnderstood.push({ line, key: null, reason: 'quoted key' });
      continue;
    }

    const split = keyEnd(text);
    if (split < 0) {
      notUnderstood.push({ line, key: null, reason: 'not a key' });
      continue;
    }
    const key = text.slice(0, split).trim();
    if (!KEY.test(key)) {
      notUnderstood.push({ line, key: null, reason: 'not a key' });
      continue;
    }

    const read = valueOf(text.slice(split + 1), followers);
    const value = typeof read === 'string' ? null : read;
    if (typeof read === 'string') notUnderstood.push({ line, key, reason: read });

    const at = seen.get(key);
    if (at) at.push({ line, value });
    else seen.set(key, [{ line, value }]);
  }

  const fields = new Map<string, FrontMatterValue>();
  for (const [key, occurrences] of seen) {
    if (occurrences.length > 1) {
      for (const one of occurrences) {
        /*
         * A duplicate replaces whatever the first occurrence was refused for. Both lines are
         * reported, because a caller that wants to tell somebody what is wrong with their file
         * needs to know the key is written twice, and which refusal the second copy would have
         * drawn on its own is noise.
         */
        const already = notUnderstood.findIndex((n) => n.line === one.line && n.key === key);
        if (already >= 0) notUnderstood.splice(already, 1);
        notUnderstood.push({ line: one.line, key, reason: 'duplicate key' });
      }
      continue;
    }
    const only = occurrences[0];
    if (only.value !== null) fields.set(key, only.value);
  }

  notUnderstood.sort((a, b) => a.line - b.line);
  return { end, fields, notUnderstood };
}

/**
 * Where the key ends on a `key: value` line, or -1 when there is no key.
 *
 * YAML's own rule: a colon separates a key from a value when a space follows it or the line ends
 * there. So `url: https://example.com/a` is one key and one value, and the colon inside the address
 * is part of it.
 */
function keyEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ':') continue;
    if (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t') return i;
  }
  return -1;
}

/** One line indented under a key, with the depth that says what it is. */
interface Follower {
  readonly indent: number;
  /** The line with its indent taken off, so a rule about its shape reads as one. */
  readonly text: string;
}

/**
 * What a key's value is, or the reason it was left alone.
 *
 * A refusal comes back as a `FrontMatterRefusal`, which is a string, and a value as an object, so
 * one call answers both and no caller can read a value that was refused.
 */
function valueOf(raw: string, followers: readonly Follower[]): FrontMatterValue | FrontMatterRefusal {
  const rest = raw.trim();

  if (followers.length > 0) {
    /*
     * Something is written under the key. An anchor on the key names whatever is under it for
     * another key to reference, so it is asked about before the shape is, or a block sequence
     * carrying one would be refused as a folded scalar and the reason would name the wrong
     * construct. With any other inline value it is a plain scalar folded over several lines, which
     * this parser does not read; with none, it is a list or a map and the first follower says which.
     */
    if (rest.startsWith('&') || rest.startsWith('*')) return 'anchor or alias';
    if (rest !== '') return 'multi-line scalar';
    return block(followers);
  }

  if (rest.startsWith('|') || rest.startsWith('>')) return 'multi-line scalar';
  if (rest.startsWith('&') || rest.startsWith('*')) return 'anchor or alias';
  if (rest.startsWith('!')) return 'tag';
  if (rest.startsWith('{')) return 'nested map';

  if (rest.startsWith('[')) {
    const items = flow(rest);
    return typeof items === 'string' ? items : { kind: 'list', items };
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const read = quoted(rest, 0);
    if (read === null || !onlyComment(rest.slice(read.next))) return 'malformed scalar';
    return { kind: 'scalar', text: read.text };
  }
  return { kind: 'scalar', text: plain(rest) };
}

/**
 * The indented `- item` form, which is how the convention writes a field with several values.
 *
 * Every follower has to be an item at one depth. A follower deeper than the first, or one that is a
 * `key: value` rather than an item, means the thing under this key is a map or a list of maps, and
 * the whole key is refused: returning the scalar items and dropping the rest would be a list short
 * by one member, read by a board as a card that has lost a tag.
 */
function block(followers: readonly Follower[]): FrontMatterValue | FrontMatterRefusal {
  const base = followers[0].indent;
  const items: string[] = [];
  for (const follower of followers) {
    if (follower.indent !== base) return 'nested map';
    if (follower.text === '-' || !follower.text.startsWith('- ')) {
      /*
       * Either a key under this one, which makes it a map, or a `-` with the item itself on the
       * lines below, which makes it a list of something this parser does not read. A bare `-` is
       * refused rather than read as an empty value, because nothing here can tell the two apart.
       */
      return keyEnd(follower.text) >= 0 ? 'nested map' : 'sequence';
    }
    const item = follower.text.slice(2).trim();
    if (item === '' || /^[-[{]/.test(item)) return 'sequence';
    if (keyEnd(item) >= 0) return 'nested map';
    /*
     * An item that is an anchor or an alias, before the plain-scalar reading below can take it as
     * text. `- *defaults` is a reference to a value defined under another key, and reading it as
     * the text it is written with gives a tag with a plausible-looking wrong name rather than a
     * missing one, which is the worse of the two failures. A *quoted* `'*defaults'` is the literal
     * string in YAML and stays one, which is why this sits above the quoted branch and not below.
     */
    if (item.startsWith('&') || item.startsWith('*')) return 'anchor or alias';
    if (item.startsWith('"') || item.startsWith("'")) {
      const read = quoted(item, 0);
      if (read === null || !onlyComment(item.slice(read.next))) return 'malformed scalar';
      items.push(read.text);
      continue;
    }
    items.push(plain(item));
  }
  return { kind: 'list', items };
}

/**
 * A flow sequence's items, or the reason it is not one this parser reads.
 *
 * On one line and closed on it. A sequence spanning lines, or holding a map or another sequence, is
 * refused rather than flattened: `[a, [b, c]]` has a shape no board column can hold and reading it
 * as three items would be the half-read this module exists to avoid.
 *
 * It reports a reason rather than a bare failure because the reasons differ, and one of them is the
 * reason a caller most needs. An item spelled `*defaults` is a reference to a value defined under
 * another key: taking it as the text it is written with produces a field holding a plausible wrong
 * value, which is worse than holding none.
 */
function flow(src: string): string[] | FrontMatterRefusal {
  const items: string[] = [];
  let i = 1;
  for (;;) {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
    if (i >= src.length) return 'sequence';
    if (src[i] === ']') return onlyComment(src.slice(i + 1)) ? items : 'sequence';

    if (src[i] === '"' || src[i] === "'") {
      /* Quoted first, because a quoted `'*a'` is the literal string in YAML and not an alias. */
      const one = quoted(src, i);
      if (one === null) return 'malformed scalar';
      items.push(one.text);
      i = one.next;
    } else {
      const to = indexOfAny(src, i, [',', ']']);
      if (to < 0) return 'sequence';
      const item = src.slice(i, to).trim();
      if (/[[\]{}]/.test(item)) return 'sequence';
      if (item.startsWith('&') || item.startsWith('*')) return 'anchor or alias';
      items.push(item);
      i = to;
    }

    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
    if (i >= src.length) return 'sequence';
    if (src[i] === ']') return onlyComment(src.slice(i + 1)) ? items : 'sequence';
    if (src[i] !== ',') return 'sequence';
    i++;
  }
}

/**
 * A quoted scalar starting at `src[at]`, and where it ends.
 *
 * Single quotes carry no escapes and `''` is one quote. Double quotes carry the six escapes in
 * `ESCAPES` and nothing else, so `é` comes back as null rather than as a guess at what the
 * writer meant.
 */
function quoted(src: string, at: number): { text: string; next: number } | null {
  const q = src[at];
  let out = '';
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i];
    if (q === "'") {
      if (c !== "'") {
        out += c;
        continue;
      }
      if (src[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return { text: out, next: i + 1 };
    }
    if (c === '"') return { text: out, next: i + 1 };
    if (c !== '\\') {
      out += c;
      continue;
    }
    const escape = ESCAPES[src[i + 1] ?? ''];
    if (escape === undefined) return null;
    out += escape;
    i++;
  }
  return null;
}

/**
 * A plain scalar, with a trailing comment taken off.
 *
 * YAML starts a comment at a `#` that follows whitespace, so `title: Ship it # later` is two words
 * and a note. Leaving the note in the value would be a misparse against every other reader of the
 * file, which is worse than the surface this rule adds.
 */
function plain(rest: string): string {
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '#' && (rest[i - 1] === ' ' || rest[i - 1] === '\t')) return rest.slice(0, i).trim();
  }
  return rest.startsWith('#') ? '' : rest;
}

/** Whether what is left of a line after a value is nothing, or a comment. */
function onlyComment(tail: string): boolean {
  const rest = tail.trim();
  return rest === '' || rest.startsWith('#');
}

/** The first of `chars` at or after `from`, or -1. */
function indexOfAny(src: string, from: number, chars: string[]): number {
  for (let i = from; i < src.length; i++) if (chars.includes(src[i])) return i;
  return -1;
}
