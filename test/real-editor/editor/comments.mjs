// Comments in real VS Code: the halves jsdom cannot reach. A collapse that has to survive the
// webview and the extension host being thrown away, the Edit Markdown chord VS Code forwards, and
// what a keystroke inside a comment actually writes to the file.
//   node test/real-editor/run-editor.mjs comments [id]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

const DOC =
  'Release notes.\n\n<!-- Ask the platform team before publishing this.\nThe retry budget is still open. -->\n\nThe exporter now runs nightly.\n\n<!-- Second note, left open. -->\n\nAfter line\n';

/** Every comment box on screen: its label, whether it is collapsed, and what it shows. */
const boxes = (S) =>
  S.eval(() =>
    [...document.querySelectorAll('.md-comment')].map((box) => ({
      label: box.querySelector('.md-alert-name')?.textContent ?? '',
      collapsed: box.classList.contains('is-collapsed'),
      peek: box.querySelector('.md-comment-peek')?.textContent ?? '',
      lines: [...box.querySelectorAll('.md-comment-line')].map((l) => l.textContent),
      icon: !!box.querySelector('.md-alert-icon'),
      chevron: !!box.querySelector('.md-comment-fold'),
    }))
  );

/** The markers drawn in place of boxes while comments are hidden. */
const markers = (S) => S.eval(() => document.querySelectorAll('.md-comment-marker').length);

/** The text of every rendered line, for checking what is left showing raw. */
const lines = (S) => S.eval(() => [...document.querySelectorAll('.cm-content > .cm-line')].map((l) => l.textContent));

/** Set `sheaf.comments` through the profile, so a scenario does not depend on what the last one left. */
async function setComments(S, value) {
  const path = join(S.run, 'user', 'User', 'settings.json');
  const cur = JSON.parse(readFileSync(path, 'utf8'));
  if (value) cur['sheaf.comments'] = value;
  else delete cur['sheaf.comments'];
  writeFileSync(path, JSON.stringify(cur, null, 2));
  await S.sleep(1600);
}

/** What the profile's settings file holds for the setting right now. */
function readComments(S) {
  const cur = JSON.parse(readFileSync(join(S.run, 'user', 'User', 'settings.json'), 'utf8'));
  return cur['sheaf.comments'] ?? null;
}

export const scenarios = [
  {
    id: 'render.comment.e01',
    feature: 'render.comment',
    name: 'A comment collapsed with its chevron is still collapsed after Developer: Reload Window, and the file never changed',
    run: async (S) => {
      await S.fresh('comment-collapse', DOC);
      await S.sleep(800);
      const drawn = await boxes(S);
      // The chevron of the first comment. A collapse is view state, so nothing may reach the file.
      await S.click({ sel: '.md-comment .md-comment-fold' });
      await S.sleep(500);
      const shut = await boxes(S);
      const afterCollapse = await S.disk();
      // A reload throws the webview and the extension host away; only VS Code's own storage
      // for this workspace can carry a collapse across it.
      await S.command('Developer: Reload Window');
      await S.sleep(6000);
      const reloaded = await boxes(S);
      const reloadedDisk = await S.disk();
      return {
        ok:
          drawn.length === 2 &&
          drawn.every((b) => b.label === 'Comment' && b.icon && b.chevron && !b.collapsed) &&
          j(drawn[0].lines) === j(['Ask the platform team before publishing this.', 'The retry budget is still open.']) &&
          shut.length === 2 &&
          shut[0].collapsed === true &&
          shut[0].peek.startsWith('Ask the platform team before publishing this.') &&
          shut[1].collapsed === false &&
          afterCollapse === DOC &&
          reloaded.length === 2 &&
          reloaded[0].collapsed === true &&
          reloaded[1].collapsed === false &&
          reloadedDisk === DOC,
        detail: `drawn ${j(drawn)}; after the chevron ${j(shut.map((b) => [b.collapsed, b.peek]))}; after the reload ${j(reloaded.map((b) => [b.collapsed, b.peek]))}${reloadedDisk === DOC ? '' : `; file changed to ${j(reloadedDisk)}`}`,
      };
    },
  },
  {
    id: 'render.comment.e02',
    feature: 'render.comment',
    name: 'Clicking a comment box, and Cmd+Alt+E on it, both show the raw comment as written, and closing it draws the box again',
    run: async (S) => {
      const doc = 'Release notes.\n\n<!-- Ask the platform team first. -->\n\nAfter line\n';
      await S.fresh('comment-reveal', doc);
      await S.sleep(800);
      const drawn = await boxes(S);
      // A press in the box is a person asking to write in the comment.
      await S.click({ text: 'Ask the platform team first.' });
      await S.sleep(500);
      const onClick = await lines(S);
      const whileClicked = await boxes(S);
      // Escape puts the source away, leaving the caret where it is.
      await S.press('Escape');
      await S.sleep(500);
      const backAfterEscape = await boxes(S);
      // Edit Markdown, the chord VS Code forwards to the webview, opens the same source.
      await S.press('Meta+Alt+e');
      await S.sleep(500);
      const onChord = await lines(S);
      const whileChorded = await boxes(S);
      await S.press('Meta+Alt+e');
      await S.sleep(500);
      const back = await boxes(S);
      const d = await S.disk();
      return {
        ok:
          drawn.length === 1 &&
          whileClicked.length === 0 &&
          onClick.some((t) => t.includes('<!-- Ask the platform team first. -->')) &&
          backAfterEscape.length === 1 &&
          whileChorded.length === 0 &&
          onChord.some((t) => t.includes('<!-- Ask the platform team first. -->')) &&
          back.length === 1 &&
          d === doc,
        detail: `drawn ${drawn.length} boxes; after the click ${whileClicked.length} boxes and lines ${j(onClick.filter((t) => t.includes('<!--')))}; after Escape ${backAfterEscape.length} boxes; with Edit Markdown on ${whileChorded.length} boxes and lines ${j(onChord.filter((t) => t.includes('<!--')))}; after putting it away ${back.length} boxes${d === doc ? '' : `; file changed to ${j(d)}`}`,
      };
    },
  },
  {
    id: 'render.comment.e03',
    feature: 'render.comment',
    name: 'Typing into a revealed comment rewrites that comment’s lines and leaves every other byte of the file alone',
    run: async (S) => {
      await S.fresh('comment-typing', DOC);
      await S.sleep(800);
      // The second line of the first comment. The press opens the comment for editing
      // and leaves the caret in the line it landed on, so the words go into that line
      // wherever in it the press was. End is deliberately not pressed: on a revealed
      // comment the end of the line is past the `-->`, which is outside the comment.
      await S.click({ text: 'The retry budget is still open.' });
      await S.sleep(500);
      await S.type(' Owner unassigned.');
      await S.sleep(600);
      const d = await S.disk();
      // Every other byte is untouched: taking the typed words back out gives the file
      // exactly as it started.
      const only = d.split(' Owner unassigned.');
      const at = only[0].length;
      const line = DOC.indexOf('The retry budget is still open.');
      const inside = at >= line && at <= line + 'The retry budget is still open.'.length;
      // Out of the comment, and the box is drawn again with the new words in the line
      // they were typed into, which is how we know it is still a comment.
      await S.caret('The exporter now runs nightly.', 3);
      await S.sleep(600);
      const drawn = await boxes(S);
      return {
        ok:
          only.length === 2 &&
          only.join('') === DOC &&
          inside &&
          drawn.length === 2 &&
          drawn[0].lines.length === 2 &&
          drawn[0].lines[0] === 'Ask the platform team before publishing this.' &&
          drawn[0].lines[1].includes('Owner unassigned.') &&
          j(drawn[1].lines) === j(['Second note, left open.']),
        detail: `file ${only.length === 2 && only.join('') === DOC ? `holds only the typed words, at ${at}${inside ? ' inside the line pressed' : ' OUTSIDE the line pressed'}` : `is ${j(d)}`}; boxes now ${j(drawn.map((b) => b.lines))}`,
      };
    },
  },
  {
    id: 'render.comment.e04',
    feature: 'render.comment',
    name: 'With sheaf.comments hidden every comment is a marker, a marker brings one box back, and Toggle Comments returns them all',
    run: async (S) => {
      await setComments(S, 'hidden');
      await S.fresh('comment-hidden', DOC);
      await S.sleep(900);
      const hiddenBoxes = await boxes(S);
      const hiddenMarkers = await markers(S);
      // Never nothing: a person has to see that a note is there, and pressing it reads it.
      await S.click({ sel: '.md-comment-marker' });
      await S.sleep(500);
      const afterMarker = await boxes(S);
      const markersLeft = await markers(S);
      const hiddenDisk = await S.disk();
      // The command writes the setting, and every open editor hears about it.
      await S.command('Sheaf: Toggle Comments');
      await S.sleep(1500);
      const shownBoxes = await boxes(S);
      const setting = readComments(S);
      const d = await S.disk();
      await setComments(S, null);
      return {
        ok:
          hiddenBoxes.length === 0 &&
          hiddenMarkers === 2 &&
          afterMarker.length === 1 &&
          markersLeft === 1 &&
          hiddenDisk === DOC &&
          shownBoxes.length === 2 &&
          setting === 'show' &&
          d === DOC,
        detail: `hidden: ${hiddenBoxes.length} boxes and ${hiddenMarkers} markers; after pressing a marker ${afterMarker.length} boxes and ${markersLeft} markers; after Toggle Comments ${shownBoxes.length} boxes and the setting is ${j(setting)}${d === DOC ? '' : `; file changed to ${j(d)}`}`,
      };
    },
  },
  {
    id: 'render.comment.e05',
    feature: 'render.comment',
    name: 'A comment inside a fenced block, one inside a sentence and one sharing its line are all left as written',
    run: async (S) => {
      const doc =
        'Intro.\n\n```html\n<!-- in code -->\n```\n\nA line with <!-- an aside --> in the middle of it.\n\n<!-- shares its line --> and more words\n\n<!-- A real note. -->\n\nAfter line\n';
      await S.fresh('comment-scope', doc);
      await S.sleep(900);
      const drawn = await boxes(S);
      const seen = await lines(S);
      const kept = ['<!-- in code -->', '<!-- an aside -->', '<!-- shares its line --> and more words'].filter((t) =>
        seen.some((l) => l.includes(t))
      );
      const d = await S.disk();
      return {
        ok: drawn.length === 1 && j(drawn[0].lines) === j(['A real note.']) && kept.length === 3 && d === doc,
        detail: `${drawn.length} boxes ${j(drawn.map((b) => b.lines))}; left as written: ${j(kept)}${d === doc ? '' : `; file changed to ${j(d)}`}`,
      };
    },
  },
];
