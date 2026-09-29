// A .txt opened in Sheaf: the same editor the Markdown files get, and never the one a
// .txt opens in by itself.
//
// The file here carries CRLF line endings, a trailing space and no newline at the end,
// because a .txt is where people keep pasted drafts and scratch notes and those bytes
// are exactly what a person would notice being tidied up.
//   node test/real-editor/run-editor.mjs txt-files [id]
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

const TXT = '# Notes to self\r\n\r\nA line with a trailing space \r\n\r\nLast line, no newline at the end';

export const scenarios = [
  {
    id: 'host.open-txt.e01',
    feature: 'host.open-txt',
    name: 'A .txt asked for in Sheaf is drawn as Markdown, and one letter typed into it writes one letter',
    run: async (S) => {
      const path = join(S.ws, 'e2e', 'notes-plain.txt');
      writeFileSync(path, TXT);
      await S.sleep(300);
      // Quick Open hands a .txt to the text editor, because Sheaf is never the default
      // for one; the harness then asks for Sheaf through Reopen Editor With, which is
      // the path a person takes.
      await S.open('e2e/notes-plain.txt');
      await S.sleep(600);
      const shown = await S.eval(() => ({
        lines: [...document.querySelectorAll('.cm-content > .cm-line')].map((l) => l.textContent),
        headings: document.querySelectorAll('.tok-h1, .tok-heading').length,
      }));
      await S.caret('Last line', 4);
      await S.type('Z');
      const disk = await S.disk(path);
      const want = TXT.replace('Last line', 'LastZ line');
      // Drawn as Markdown: the heading reads as its words with the hash off the screen.
      const rendered = shown.headings > 0 && shown.lines[0] === 'Notes to self';
      // And every byte nobody touched is still there: the endings, the trailing space,
      // and the missing newline at the end.
      const kept = disk === want;
      return {
        ok: rendered && kept,
        detail: `drawn ${j(shown)}; disk ${j(disk)}`,
      };
    },
  },
  {
    id: 'host.open-txt.e02',
    feature: 'host.open-txt',
    name: 'A .txt opened in Sheaf and not typed into is left byte for byte as it was',
    run: async (S) => {
      // The risk of opening a plain-text file in a Markdown editor is that looking at it
      // changes it. Nothing is written unless the person edits, so this reads the file
      // back after the editor has been sitting on it.
      const path = join(S.ws, 'e2e', 'notes-untouched.txt');
      writeFileSync(path, TXT);
      await S.sleep(300);
      await S.open('e2e/notes-untouched.txt');
      await S.sleep(2600); // Longer than the auto-save debounce, twice over.
      const disk = readFileSync(path, 'utf8');
      return { ok: disk === TXT, detail: `disk ${j(disk)}` };
    },
  },
];
