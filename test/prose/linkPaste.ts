/*
 * Pasting a web address over selected words: when it writes a link around them,
 * when it stays the plain paste it has always been, and what the Markdown it
 * writes looks like when the words or the address hold characters Markdown reads.
 */

import { Scenario, mountProse } from '../harness';
import { handleLinkPaste, markdownLink, pastedUrl } from '../../src/webview/linkPaste';
import { setupImageIngestion } from '../../src/webview/images';

interface Pasted {
  /** Whether the paste was answered as a link rather than left to the editor. */
  handled: boolean;
  doc: string;
  head: number;
}

/** Select `needle` in `doc` and paste `text` over it. */
const pasteOver = (doc: string, needle: string, text: string): Pasted => {
  const p = mountProse(doc);
  const from = doc.indexOf(needle);
  p.select(from, from + needle.length);
  const handled = handleLinkPaste(p.view, text);
  const out = { handled, doc: p.doc(), head: p.view.state.selection.main.head };
  p.destroy();
  return out;
};

/** Paste `text` with nothing selected, the caret one character into `needle`. */
const pasteAt = (doc: string, needle: string, text: string): Pasted => {
  const p = mountProse(doc);
  p.select(doc.indexOf(needle) + 1);
  const handled = handleLinkPaste(p.view, text);
  const out = { handled, doc: p.doc(), head: p.view.state.selection.main.head };
  p.destroy();
  return out;
};

/** A paste left alone: the editor's own handling runs and nothing was linked. */
const plain = (r: Pasted, doc: string): boolean => !r.handled && r.doc === doc;

const G = globalThis as unknown as { Event: typeof Event };

/**
 * Dispatch a paste carrying `text` at `el`, the way the platform does. Returns
 * false when something called preventDefault, which is how the editor says it
 * answered the paste itself.
 */
const firePaste = (el: Element, text: string): boolean => {
  const event = new G.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text/plain' ? text : '') },
  });
  return el.dispatchEvent(event);
};

export const scenarios: Scenario[] = [
  {
    name: 'a pasted address over selected words links the words and leaves the caret after it',
    run: () => {
      const before = 'see the release notes for details';
      const r = pasteOver(before, 'release notes', 'https://example.com/notes');
      return (
        r.handled &&
        r.doc === 'see the [release notes](https://example.com/notes) for details' &&
        r.head === r.doc.indexOf(') for') + 1
      );
    },
  },
  {
    name: 'a pasted address links words in a heading, a quote and a list item',
    run: () => {
      const heading = pasteOver('## the release notes', 'release notes', 'https://example.com/n');
      const quote = pasteOver('> read the release notes', 'release notes', 'https://example.com/n');
      const item = pasteOver('- the release notes\n- more', 'release notes', 'https://example.com/n');
      return (
        heading.doc === '## the [release notes](https://example.com/n)' &&
        quote.doc === '> read the [release notes](https://example.com/n)' &&
        item.doc === '- the [release notes](https://example.com/n)\n- more'
      );
    },
  },
  {
    name: 'words already carrying a mark keep the mark and the words when an address is pasted over them',
    run: () => {
      const bold = pasteOver('see the **bold** notes here', '**bold** notes', 'https://example.com/n');
      const mixed = pasteOver('see the *first* and ==second== bits', '*first* and ==second==', 'https://example.com/n');
      return (
        bold.doc === 'see the [**bold** notes](https://example.com/n) here' &&
        mixed.doc === 'see the [*first* and ==second==](https://example.com/n) bits'
      );
    },
  },
  {
    name: 'a pasted address with nothing selected is the plain paste it always was',
    run: () => {
      const before = 'see the release notes for details';
      return plain(pasteAt(before, 'release', 'https://example.com/notes'), before);
    },
  },
  {
    name: 'a clipboard holding more than one line, or an address with words beside it, pastes plainly',
    run: () => {
      const before = 'see the release notes for details';
      return (
        plain(pasteOver(before, 'release notes', 'https://example.com/a\nhttps://example.com/b'), before) &&
        plain(pasteOver(before, 'release notes', 'the notes: https://example.com/a'), before) &&
        plain(pasteOver(before, 'release notes', '   '), before)
      );
    },
  },
  {
    name: 'a bare domain with no scheme, a file path and a fragment of prose paste plainly',
    run: () => {
      const before = 'see the release notes for details';
      return (
        plain(pasteOver(before, 'release notes', 'example.com/notes'), before) &&
        plain(pasteOver(before, 'release notes', 'www.example.com'), before) &&
        plain(pasteOver(before, 'release notes', '/Users/someone/notes.md'), before) &&
        plain(pasteOver(before, 'release notes', 'notes.md'), before)
      );
    },
  },
  {
    name: 'an address in a scheme the document must not run pastes plainly',
    run: () => {
      const before = 'see the release notes for details';
      return (
        plain(pasteOver(before, 'release notes', 'javascript:alert(1)'), before) &&
        plain(pasteOver(before, 'release notes', 'data:text/html,<b>x</b>'), before) &&
        plain(pasteOver(before, 'release notes', 'vbscript:msgbox'), before)
      );
    },
  },
  {
    name: 'words selected inside a fenced or indented code block paste plainly',
    run: () => {
      const fenced = 'Intro here.\n\n```\nsee the release notes\n```\n';
      const indented = 'Intro here.\n\n    see the release notes\n';
      return (
        plain(pasteOver(fenced, 'release notes', 'https://example.com/n'), fenced) &&
        plain(pasteOver(indented, 'release notes', 'https://example.com/n'), indented)
      );
    },
  },
  {
    name: 'words selected inside an inline code span paste plainly',
    run: () => {
      const before = 'run the `release notes` script now';
      return plain(pasteOver(before, 'release notes', 'https://example.com/n'), before);
    },
  },
  {
    name: 'a selection holding a link, or sitting inside one, pastes plainly',
    run: () => {
      const inside = 'see the [release notes](https://old.example.com) for details';
      const around = 'see the [release notes](https://old.example.com) today';
      const address = 'see the [notes](https://old.example.com) for details';
      const autolink = 'see https://old.example.com for details';
      return (
        plain(pasteOver(inside, 'release notes', 'https://example.com/n'), inside) &&
        plain(pasteOver(around, '[release notes](https://old.example.com)', 'https://example.com/n'), around) &&
        plain(pasteOver(address, 'old.example.com', 'https://example.com/n'), address) &&
        plain(pasteOver(autolink, 'old.example.com', 'https://example.com/n'), autolink)
      );
    },
  },
  {
    name: 'brackets in the selected words are escaped so the result is a link and not markup',
    run: () => {
      const r = pasteOver('read a] b[ c today', 'a] b[ c', 'https://example.com/n');
      return (
        r.handled &&
        r.doc === 'read [a\\] b\\[ c](https://example.com/n) today' &&
        markdownLink('[release] notes', 'https://example.com/n') ===
          '[\\[release\\] notes](https://example.com/n)' &&
        markdownLink('a \\ b', 'https://example.com/n') === '[a \\\\ b](https://example.com/n)'
      );
    },
  },
  {
    name: 'an address holding a parenthesis or a space is written in angle brackets',
    run: () => {
      const r = pasteOver('read about ferns today', 'ferns', 'https://example.com/Fern_(plant)');
      return (
        r.handled &&
        r.doc === 'read about [ferns](<https://example.com/Fern_(plant)>) today' &&
        markdownLink('notes', 'https://example.com/my notes') === '[notes](<https://example.com/my notes>)' &&
        markdownLink('notes', 'https://example.com/a\x01b') === '[notes](<https://example.com/a\x01b>)' &&
        // A space inside the address never reaches here from a clipboard: two
        // tokens are prose, and prose pastes plainly.
        pastedUrl('https://example.com/my notes') === null
      );
    },
  },
  {
    name: 'an ordinary address is written bare, whatever punctuation a path happens to carry',
    run: () => {
      // The angle brackets are for an address a bare destination cannot hold. Reach
      // for them one character too widely and every address with a hyphen in it comes
      // out wrapped, which is most of them, and the document fills with noise nobody
      // asked for.
      const plainly = [
        'https://example.com/my-page',
        'https://example.com/a_b',
        'https://example.com/a.b~c',
        'https://example.com/q?a=1&b=2#frag',
        'https://example.com/%20encoded',
        "https://example.com/it's",
        'mailto:first.last+tag@example.com',
      ];
      return plainly.every((url) => markdownLink('notes', url) === `[notes](${url})`);
    },
  },
  {
    name: 'a word inside YAML front matter pastes plainly, and the same word below it still links',
    run: () => {
      // The tree cannot answer this one: the dialect has no node for front matter,
      // so `title: x` over `---` parses as a heading and reads as ordinary prose.
      const doc = '---\ntitle: release notes\ndraft: true\n---\n\nSee the release notes below.\n';
      const inside = mountProse(doc);
      inside.select(11, 11 + 'release notes'.length);
      const handledInside = handleLinkPaste(inside.view, 'https://example.com/n');
      const afterInside = inside.doc();
      inside.destroy();

      const below = mountProse(doc);
      const at = doc.lastIndexOf('release notes');
      below.select(at, at + 'release notes'.length);
      const handledBelow = handleLinkPaste(below.view, 'https://example.com/n');
      const afterBelow = below.doc();
      below.destroy();

      // A rule in the body is a divider, not the start of front matter, and a file
      // whose first line is `---` with nothing closing it is not front matter either.
      const divider = 'Intro here.\n\n---\n\nSee the release notes below.\n';
      const d = mountProse(divider);
      const dAt = divider.indexOf('release notes');
      d.select(dAt, dAt + 'release notes'.length);
      const handledDivider = handleLinkPaste(d.view, 'https://example.com/n');
      d.destroy();

      // A `---` with nothing closing it is a rule and the rest is prose, so this one
      // links. Front matter is a fenced region, and half a fence is not one.
      const unclosed = '---\ntitle: release notes\n';
      const u = mountProse(unclosed);
      u.select(11, 11 + 'release notes'.length);
      const handledUnclosed = handleLinkPaste(u.view, 'https://example.com/n');
      u.destroy();

      return (
        !handledInside &&
        afterInside === doc &&
        handledBelow &&
        afterBelow === '---\ntitle: release notes\ndraft: true\n---\n\nSee the [release notes](https://example.com/n) below.\n' &&
        handledDivider &&
        handledUnclosed
      );
    },
  },
  {
    name: 'a pasted mailto: address links the selected words the same way',
    run: () => {
      const r = pasteOver('write to the team about it', 'the team', 'mailto:hello@example.com');
      return r.handled && r.doc === 'write to [the team](mailto:hello@example.com) about it';
    },
  },
  {
    name: 'linking a pasted address is one undo step, and the words come back as they were',
    run: () => {
      const before = 'see the release notes for details';
      const p = mountProse(before);
      const from = before.indexOf('release notes');
      p.select(from, from + 'release notes'.length);
      handleLinkPaste(p.view, 'https://example.com/notes');
      const linked = p.doc();
      p.press('Mod-z');
      const back = p.doc();
      const sel = p.view.state.selection.main;
      p.destroy();
      return (
        linked === 'see the [release notes](https://example.com/notes) for details' &&
        back === before &&
        sel.from === from &&
        sel.to === from + 'release notes'.length
      );
    },
  },
  {
    name: 'a real paste event is answered before the editor replaces the selection',
    run: () => {
      const before = 'see the release notes for details';
      const p = mountProse(before);
      setupImageIngestion(p.view, () => {});
      const from = before.indexOf('release notes');
      p.select(from, from + 'release notes'.length);
      const wentOn = firePaste(p.view.contentDOM, 'https://example.com/notes');
      const out = p.doc();
      p.destroy();
      return !wentOn && out === 'see the [release notes](https://example.com/notes) for details';
    },
  },
  {
    name: 'a real paste of something that is not one address writes no link at all',
    run: () => {
      const before = 'see the release notes for details';
      const p = mountProse(before);
      setupImageIngestion(p.view, () => {});
      const from = before.indexOf('release notes');
      const linked: boolean[] = [];
      for (const text of ['https://example.com/a\nhttps://example.com/b', 'www.example.com', 'javascript:alert(1)']) {
        p.select(from, from + 'release notes'.length);
        firePaste(p.view.contentDOM, text);
        linked.push(p.doc().includes(']('));
        p.view.dispatch({ changes: { from: 0, to: p.view.state.doc.length, insert: before } });
      }
      p.destroy();
      return linked.every((wrote) => !wrote);
    },
  },
  {
    name: 'a paste inside a table cell’s own editor is left to that cell',
    run: () => {
      const before = 'see the release notes for details';
      const p = mountProse(before);
      setupImageIngestion(p.view, () => {});
      const from = before.indexOf('release notes');
      p.select(from, from + 'release notes'.length);
      // A cell opens either a Markdown editor of its own or a plain field, and
      // both of them sit inside the document's own content.
      const nested = document.createElement('div');
      nested.className = 'cm-editor';
      const inner = document.createElement('div');
      nested.appendChild(inner);
      const field = document.createElement('textarea');
      field.className = 'sheaf-table-input';
      p.view.contentDOM.appendChild(nested);
      p.view.contentDOM.appendChild(field);
      firePaste(inner, 'https://example.com/notes');
      firePaste(field, 'https://example.com/notes');
      // The document's selection is untouched: whatever the cell does with the
      // address, no link was written around the words behind it. A real cell
      // answers the paste itself, which is why nothing here stands in for one.
      const out = p.doc();
      p.destroy();
      return !out.includes('](');
    },
  },
];
