import { Scenario, mountProse } from '../harness';
import { lineTextStart, markerLength } from '../../src/webview/lineStart';
import { setDocumentSourceMode } from '../../src/webview/revealState';
import { revealRange } from '../../src/webview/revealBlock';
import { blockRangeAt } from '../../src/webview/blockModel';
import { turnInto, BlockKind } from '../../src/webview/toolbar';
import { createShortcutsOverlay, hint, hintParts } from '../../src/webview/shortcuts';

/** Put the caret at `at` in `doc`, run `act`, and return the resulting text. */
const after = (doc: string, at: number, act: (p: ReturnType<typeof mountProse>) => void): string => {
  const p = mountProse(doc);
  p.select(at);
  act(p);
  const out = p.doc();
  p.destroy();
  return out;
};

export const scenarios: Scenario[] = [
  {
    /*
     * A key hint names keys the way a person does, not the way the browser does.
     *
     * The block menu read `⌥ArrowUp` for Move up while every other hint read like `⌘⇧X`, because
     * `hintParts` mapped the modifiers and passed anything longer than one character through
     * unchanged. `ArrowUp` is the browser's name for that key and nobody else's.
     *
     * The controls are the words that are already right, and they matter more than the arrows: a
     * fix that symbolised every multi-character name would turn `Enter` into `↩` and `Backspace`
     * into `⌫`, which is a different and unasked-for change. `Escape` is the precedent, spelled
     * `Esc` rather than `⎋` because a symbol nobody recognises is worse than a word.
     */
    name: 'an arrow key is drawn as an arrow, and the keys people have words for keep them',
    run: () => {
      const wrong: string[] = [];
      const arrows: [string, string][] = [
        ['ArrowUp', '↑'],
        ['ArrowDown', '↓'],
        ['ArrowLeft', '←'],
        ['ArrowRight', '→'],
      ];
      for (const [name, symbol] of arrows) {
        const got = hintParts(name);
        if (got.length !== 1 || got[0] !== symbol) wrong.push(`${name} -> ${JSON.stringify(got)}`);
      }
      // The words that are already right and must not become symbols.
      for (const name of ['Enter', 'Tab', 'Backspace', 'Delete', 'Home']) {
        const got = hintParts(name);
        if (got.length !== 1 || got[0] !== name) wrong.push(`${name} -> ${JSON.stringify(got)} (should be unchanged)`);
      }
      if (hintParts('Escape')[0] !== 'Esc') wrong.push('Escape is no longer Esc');
      // And the whole hint the block menu shows, which is what the report was about.
      const moveUp = hint('Alt-ArrowUp');
      if (!moveUp.endsWith('↑') || moveUp.includes('Arrow')) wrong.push(`Alt-ArrowUp -> ${JSON.stringify(moveUp)}`);
      /*
       * A single letter still upper-cases, so the ordinary hint is untouched. Asserted on the
       * letter alone rather than on the whole string: jsdom reports a platform that is not a Mac,
       * so the modifiers spell out as `Ctrl+Shift+`, and my first version of this check asked
       * whether the whole hint was upper-case and failed on `Ctrl`.
       */
      const plain = hint('Mod-Shift-x');
      if (!plain.endsWith('X') || plain.includes('Arrow')) wrong.push(`Mod-Shift-x -> ${JSON.stringify(plain)}`);
      return wrong.length ? { ok: false, detail: wrong.join('; ') } : true;
    },
  },
  {
    /*
     * Where the start of a line is when the line opens with a marker.
     *
     * Home itself is CodeMirror's and needs a layout to have an opinion, so a real window is
     * what checks the key. The rule it now asks is a function of the text and the block, and
     * that is what is checked here: the traps are a `#` inside code, a wrapped item's
     * indented continuation, and a line that is nothing but its marker.
     */
    name: 'the start of a line is the start of its text, past a heading, quote, bullet or task marker',
    run: () => {
      const cases: [string, number, string][] = [
        ['# A heading here', 2, 'the hashes and the space'],
        ['###### Deep', 7, 'six hashes'],
        ['> A quoted line', 2, 'the mark and its space, not the gap between them'],
        ['>> Nested', 3, 'both levels'],
        ['> - An item in a quote', 4, 'the quote and the bullet'],
        ['- A bullet item', 2, 'the bullet'],
        ['* Star bullet', 2, 'a star bullet'],
        ['12. Numbered', 4, 'a number and its dot'],
        ['3) Paren numbered', 3, 'a number and its bracket'],
        ['- [ ] A task item', 6, 'the bullet and the box'],
        ['- [x] Done', 6, 'a ticked box'],
        ['Plain paragraph', 0, 'nothing to skip'],
        // Indentation alone is not a marker: a wrapped item's continuation already starts
        // where its text does, and treating the spaces as a marker would be the same answer
        // by accident and the wrong rule.
        ['    continuation text', 0, 'indentation is not a marker'],
        // A line that is only its marker: the caret goes where the person would type.
        ['- ', 2, 'an empty item'],
        ['> ', 2, 'an empty quote line'],
      ];
      const wrong = cases.filter(([text, want]) => markerLength(text) !== want);
      // In a fenced block a `#` is a comment in somebody's shell script, and the line is
      // read as code, so nothing is skipped. This one goes through the block model, which is
      // the part markerLength alone cannot know.
      const doc = 'Intro.\n\n```sh\n# not a heading\n```\n\n# A real heading\n';
      const p = mountProse(doc);
      const inCode = lineTextStart(p.view.state, doc.indexOf('# not a heading') + 3);
      const inProse = lineTextStart(p.view.state, doc.indexOf('# A real heading') + 3);
      p.destroy();
      const codeOk = inCode === doc.indexOf('# not a heading');
      const proseOk = inProse === doc.indexOf('# A real heading') + 2;
      return {
        ok: wrong.length === 0 && codeOk && proseOk,
        detail:
          `${wrong.map(([t, want, why]) => `${JSON.stringify(t)} wanted ${want} (${why}) got ${markerLength(t)}`).join('; ') || 'every line as wanted'}` +
          `; in a fenced block ${codeOk ? 'nothing is skipped' : `skipped to ${inCode}`}; the heading after it ${proseOk ? 'skips its hashes' : `went to ${inProse}`}`,
      };
    },
  },
  {
    /*
     * A line showing its Markdown keeps the marker in reach.
     *
     * The rule above is right where the marker is decoration standing in front of the text.
     * Edit Markdown, and whole-document source mode, are asked for precisely to get at the
     * marker, so there it is the content: skipping it puts the caret past the thing the
     * person opened the line to change, and typing a third `#` wrote `## #Heading`.
     */
    name: 'on a line showing its Markdown, the start of the line is the start of the line',
    run: () => {
      const doc = '## Heading two\n\nBody text.\n';
      const p = mountProse(doc);
      const drawn = lineTextStart(p.view.state, 4);
      // Edit Markdown on that block, which is what the menu and Mod-Alt-e run.
      revealRange(p.view, blockRangeAt(p.view.state, 4)!);
      const revealed = lineTextStart(p.view.state, 4);
      // Whole-document source mode is the same question at the size of the file.
      setDocumentSourceMode(p.view, document.createElement('div'), true);
      const inSource = lineTextStart(p.view.state, 4);
      const unchanged = p.doc() === doc;
      p.destroy();
      return {
        // `## ` is three characters, which is the point: drawn, the caret clears the whole
        // marker; revealed, it goes in front of it, where the person can type the third `#`.
        ok: drawn === 3 && revealed === 0 && inSource === 0 && unchanged,
        detail: `drawn ${drawn} (wanted 3); revealed ${revealed} (wanted 0); in source mode ${inSource} (wanted 0); file unchanged ${unchanged}`,
      };
    },
  },
  {
    name: 'Mod-Alt-0 to 3 turn a list item or a quote into a heading or text the way the Text style menu does',
    run: () => {
      const cases: [string, number, string, BlockKind, string][] = [
        ['- Groceries\n- Errands', 15, 'Mod-Alt-2', 'h2', '- Groceries\n## Errands'],
        ['> quote', 3, 'Mod-Alt-2', 'h2', '## quote'],
        ['- [ ] task', 8, 'Mod-Alt-1', 'h1', '# task'],
        ['1. step', 5, 'Mod-Alt-3', 'h3', '### step'],
        ['## Title', 5, 'Mod-Alt-2', 'h2', '## Title'],
        ['# Title', 4, 'Mod-Alt-2', 'h2', '## Title'],
        ['plain', 2, 'Mod-Alt-1', 'h1', '# plain'],
        ['- item', 4, 'Mod-Alt-0', 'text', 'item'],
        ['> quote', 3, 'Mod-Alt-0', 'text', 'quote'],
        ['## Title', 5, 'Mod-Alt-0', 'text', 'Title'],
      ];
      return cases.every(([doc, at, key, kind, want]) => {
        const shortcut = after(doc, at, (p) => p.press(key));
        const menu = after(doc, at, (p) => turnInto(p.view, kind));
        return shortcut === want && menu === want;
      });
    },
  },
  {
    name: 'Tab nests a list item under its previous sibling and leaves a paragraph, a heading or a first item as they are, so prose never becomes a code block',
    run: () => {
      const cases: [string, number, string, string][] = [
        // Nothing to nest under: the key is consumed and the file does not change.
        ['Intro\n\nPlain paragraph text', 10, 'Tab', 'Intro\n\nPlain paragraph text'],
        ['# Title', 4, 'Tab', '# Title'],
        ['- a\n- b', 3, 'Tab', '- a\n- b'],
        ['1. a\n2. b', 4, 'Tab', '1. a\n2. b'],
        ['- a\n  more', 9, 'Tab', '- a\n  more'],
        // A later item nests under the one before it, in a quote too.
        ['- a\n- b', 7, 'Tab', '- a\n    - b'],
        // The nested item starts its own numbering, so it is 1 rather than the 2 it carried
        // at the outer level.
        ['1. a\n2. b', 9, 'Tab', '1. a\n    1. b'],
        ['> - a\n> - b', 11, 'Tab', '> - a\n>     - b'],
        // Shift-Tab still outdents a nested item.
        ['- a\n    - b', 11, 'Shift-Tab', '- a\n- b'],
        // Inside a fenced code block Tab still indents the line.
        ['```\nx\n```', 4, 'Tab', '```\n    x\n```'],
      ];
      return cases.every(([doc, at, key, want]) => {
        let handled = false;
        const got = after(doc, at, (p) => void (handled = p.press(key)));
        return handled && got === want;
      });
    },
  },
  {
    name: 'a numbered sub-list counts on its own, and the item after it carries on from the outer level',
    run: () => {
      // The caret is put on `on`, so no offset here has to be counted by hand.
      const cases: [string, string, string, string][] = [
        // The reported gesture. Nesting the middle item starts the sub-list at 1 and hands the
        // item below it the outer number the sub-list is no longer using.
        ['1. First\n2. Second\n3. Third', 'Second', 'Tab', '1. First\n    1. Second\n2. Third'],
        // And back out again, which is the other half of the reported sequence: the item
        // rejoins the outer list and takes the next number there.
        ['1. First\n    1. Second\n2. Third', 'Second', 'Shift-Tab', '1. First\n2. Second\n3. Third'],
        // A list may open at a number the author chose, and the outermost level keeps it.
        ['5. five\n6. six', 'six', 'Tab', '5. five\n    1. six'],
        // A third level counts for itself too.
        ['1. a\n    1. b\n    2. c', 'c', 'Tab', '1. a\n    1. b\n        1. c'],
      ];
      return cases.every(([doc, on, key, want]) => {
        const got = after(doc, doc.indexOf(on), (p) => void p.press(key));
        return got === want;
      });
    },
  },
  {
    name: 'a bullet list is left alone by the renumbering, and so is a numbered list nothing nested in',
    run: () => {
      // The guard against renumbering being reached where it has no business: a bullet list has
      // no numbers to put right, and Tab on a first item is refused, so neither writes a digit.
      const cases: [string, number, string, string][] = [
        ['- a\n- b\n- c', 7, 'Tab', '- a\n    - b\n- c'],
        ['1. a\n2. b', 4, 'Tab', '1. a\n2. b'],
      ];
      return cases.every(([doc, at, key, want]) => after(doc, at, (p) => void p.press(key)) === want);
    },
  },
  {
    name: 'Enter on an empty list item or quote line ends the block and leaves a blank line below it',
    run: () => {
      // The caret starts at the end of each document and should end at the end of the result.
      const cases: [string, string][] = [
        // Empty item or quote line: the marker goes, and a blank line separates the block
        // from the caret, so what is typed next is a paragraph of its own.
        ['- Only item\n- ', '- Only item\n\n'],
        ['1. a\n2. ', '1. a\n\n'],
        ['- a\n- b\n- ', '- a\n- b\n\n'],
        ['> a\n> ', '> a\n\n'],
        ['> a\n>', '> a\n\n'],
        // A blank line already above the caret is enough on its own.
        ['Intro\n\n- ', 'Intro\n\n'],
        // A nested empty item still steps out one level.
        ['- a\n    - ', '- a\n- '],
        // A line with text still continues the list or quote.
        ['- a', '- a\n- '],
        ['> a', '> a\n> '],
      ];
      const each = cases.every(([doc, want]) => {
        const p = mountProse(doc);
        p.select(doc.length);
        const handled = p.press('Enter');
        const ok = handled && p.doc() === want && p.view.state.selection.main.head === want.length;
        p.destroy();
        return ok;
      });
      // As reported: End, Enter, Enter, then typing starts a paragraph below the block.
      const endThenType = (doc: string): string => {
        const p = mountProse(doc);
        p.select(doc.length);
        p.press('Enter');
        p.press('Enter');
        const at = p.view.state.selection.main.head;
        p.view.dispatch({ changes: { from: at, insert: 'Zed' }, selection: { anchor: at + 3 }, userEvent: 'input.type' });
        const out = p.doc();
        p.destroy();
        return out;
      };
      const reported =
        endThenType('- Only item') === '- Only item\n\nZed' &&
        endThenType('- first\n- second') === '- first\n- second\n\nZed' &&
        endThenType('> alpha') === '> alpha\n\nZed';
      return each && reported;
    },
  },
  {
    name: 'the Keyboard shortcuts overlay lists Undo and Redo with the keys that run them',
    run: () => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      createShortcutsOverlay(parent);
      const rows = new Map<string, string>();
      for (const row of Array.from(parent.querySelectorAll('.sheaf-sc-row'))) {
        rows.set(row.querySelector('.sheaf-sc-label')?.textContent ?? '', row.querySelector('.sheaf-sc-keys')?.textContent ?? '');
      }
      parent.remove();
      // Outside macOS the hints read Ctrl; the test environment is not a Mac.
      const listed = rows.get('Undo') === 'Ctrl+Z' && rows.get('Redo') === 'Ctrl+Shift+Z';
      const p = mountProse('Say hello');
      p.select(9);
      p.view.dispatch({ changes: { from: 9, insert: '!' }, selection: { anchor: 10 }, userEvent: 'input.type' });
      const undone = p.press('Mod-z') && p.doc() === 'Say hello';
      p.destroy();
      return listed && undone;
    },
  },
  {
    name: 'undo and redo keys step the editor history and stop at the editor, so VS Code does not also undo the file',
    run: () => {
      const original = 'Say hello to the world today.';
      const p = mountProse(original);
      p.select(4);
      for (const ch of 'Zap ') {
        const at = p.view.state.selection.main.head;
        p.view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
      }
      const typed = p.doc();
      // VS Code's webview host listens for keydown on the window and runs its own document undo for Ctrl or Cmd with Z or Y.
      const reachedWindow: string[] = [];
      const onWindow = (e: KeyboardEvent): void => void reachedWindow.push(`${e.shiftKey ? 'Shift-' : ''}${e.key}`);
      window.addEventListener('keydown', onWindow);
      const key = (k: string, shiftKey = false): string => {
        p.view.contentDOM.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', { key: k, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
        return p.doc();
      };
      const steps = [
        key('z') === original,
        key('z', true) === typed,
        key('z') === original,
        key('y') === typed,
        key('z') === original,
        // Nothing left to undo: the key is still consumed and the text stays.
        key('z') === original,
      ];
      window.removeEventListener('keydown', onWindow);
      p.destroy();
      return typed === 'Say Zap hello to the world today.' && steps.every(Boolean) && reachedWindow.length === 0;
    },
  },
];
