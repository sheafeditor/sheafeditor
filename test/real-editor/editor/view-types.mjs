// What happens when Sheaf is asked to open a file whose extension it does not claim.
//
// Sheaf contributes three view types with lower-case globs: `sheaf.wysiwyg` for `*.md` and
// `*.markdown`, `sheaf.text` for `*.txt`, `sheaf.csv` for `*.csv` and `*.tsv`. Five other places
// decide that the case of an extension must not matter, three `when` clauses with `/i` and two
// `toLowerCase()` calls, and a `filenamePattern` glob has no way to say it. Whether that gap costs
// anything depends on a question about VS Code rather than about Sheaf: does `vscode.openWith` with
// an explicit view type open a file that view type's selector does not match?
//
// It cannot be asked with an upper-case extension on a case-insensitive filesystem, because the
// glob matches there anyway. A file type nothing claims asks the same question on any machine, so
// the fixture is a `.foo`.
//
// There is a second thing in reach of the same gesture. `sheaf.openWithWysiwyg`'s Explorer path
// filters the selection through `isMarkdownFile`, and its active-editor path does not: with no
// Explorer selection it takes `vscode.window.activeTextEditor` and calls `openWith` on whatever is
// there. So this gesture is reachable for any file at all, which is why it is worth knowing what it
// does.
//
//   node test/real-editor/run-editor.mjs view-types [id]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);
const DOC = '# A heading\n\nA paragraph, so there is something to draw.\n';

export const scenarios = [
  {
    id: 'host.view-types.e01',
    feature: 'host.view-types',
    name: 'Asking Sheaf to open a file type it does not claim either opens it or says why, and never silently does nothing',
    run: async (S) => {
      /*
       * The assertion is the rule that applies rather than a guess about which answer is right.
       * `CLAUDE.md` says never silently degrade: "An action unavailable in Strict mode must be
       * visibly disabled and say why. A feature that quietly does nothing reads as a bug." The same
       * sentence covers this. So either outcome passes and the third fails:
       *
       *   Sheaf opens the .foo        an explicit view type overrides its own selector, so the
       *                               lower-case globs are not the only way in and the
       *                               case-sensitivity gap is narrower than it looks
       *   Sheaf says why it cannot    the selector is authoritative and the person is told
       *   nothing happens, silently   the command ran, did nothing, and said nothing
       *
       * The detector and the plain open are written out rather than taken from `S.open`, which
       * asks for Sheaf itself through Reopen Editor With when no Sheaf frame appears. That
       * fallback is a different gesture from the one under test and would answer a different
       * question.
       */
      const foo = join(S.ws, 'e2e', 'question.foo');
      writeFileSync(foo, DOC);
      writeFileSync(join(S.ws, 'e2e', 'control-claimed-doc.md'), DOC);
      await S.sleep(400);

      /* Sheaf is showing when a frame carries a `#toolbar` and a `.cm-editor` and has a real box. */
      const sheafShowing = async () => {
        for (const f of S.page.frames()) {
          const ok = await f
            .evaluate(() => !!document.getElementById('toolbar') && !!document.querySelector('.cm-editor'))
            .catch(() => false);
          if (!ok) continue;
          const el = await f.frameElement().catch(() => null);
          const box = el && (await el.boundingBox().catch(() => null));
          if (box && box.width > 50 && box.height > 50) return true;
        }
        return false;
      };
      const showing = async () => {
        const sheaf = await sheafShowing();
        const host = await S.page.evaluate(() => {
          const vis = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 50 && r.height > 50;
          };
          const lines = [...document.querySelectorAll('.monaco-editor .view-lines')].find(vis);
          const tab = document.querySelector('.tabs-container .tab.active');
          const notices = [...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].map((e) =>
            e.textContent.trim()
          );
          return {
            lines: !!lines,
            tab: tab ? (tab.getAttribute('aria-label') || tab.textContent || '').trim() : null,
            notices,
          };
        });
        return {
          kind: sheaf && !host.lines ? 'Sheaf' : host.lines && !sheaf ? 'the text editor' : sheaf ? 'both' : 'neither',
          tab: host.tab,
          notices: host.notices.filter((t) => t.startsWith('Sheaf')),
        };
      };

      /* Quick Open and Enter, and nothing after it. */
      const plainOpen = async (rel) => {
        const active = S.page.locator('.editor-group-container.active .tabs-container .tab.active').first();
        if (await active.isVisible().catch(() => false)) await active.click().catch(() => {});
        await S.page.keyboard.press('Meta+p');
        await S.page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 8000 });
        await S.page.keyboard.type(rel, { delay: 5 });
        const wanted = rel.split('/').pop();
        const listed = async () => {
          const rows = await S.page
            .$$eval('.quick-input-list .monaco-list-row', (els) => els.map((e) => e.getAttribute('aria-label') || e.textContent || ''))
            .catch(() => []);
          return rows.length > 0 && rows[0].includes(wanted);
        };
        for (let i = 0; i < 20 && !(await listed()); i++) await S.sleep(150);
        await S.sleep(200);
        await S.page.keyboard.press('Enter');
        await S.sleep(1500);
        return showing();
      };

      // The .foo, opened the way a double-click opens one. Nothing claims the type, so this is the
      // text editor, and if it were not then the rest of the scenario would be about the wrong thing.
      const openedPlainly = await plainOpen('e2e/question.foo');
      // Then the command, which on this path takes the active text editor and calls
      // `vscode.openWith` on it with Sheaf's own view type.
      await S.command('Sheaf: Open in Sheaf');
      await S.sleep(2000);
      const afterAsking = await showing();

      /*
       * The control, and it is load-bearing twice over: it shows the detector can see Sheaf at all,
       * without which every reading above is "the text editor" for a reason that has nothing to do
       * with view types, and it shows a claimed type still opens by itself.
       */
      const control = await plainOpen('e2e/control-claimed-doc.md');

      const detectorWorks = control.kind === 'Sheaf';
      const startedInTheTextEditor = openedPlainly.kind === 'the text editor';
      const opened = afterAsking.kind === 'Sheaf';
      const said = afterAsking.notices.length > 0;
      return {
        ok: detectorWorks && startedInTheTextEditor && (opened || said),
        detail:
          `the .foo opened plainly in ${openedPlainly.kind} (tab ${j(openedPlainly.tab)})` +
          `${startedInTheTextEditor ? '' : ', WHICH IS NOT THE TEXT EDITOR, so nothing below is about view types'}; ` +
          `after Sheaf: Open in Sheaf it is ${afterAsking.kind} (tab ${j(afterAsking.tab)}), notices ${j(afterAsking.notices)}` +
          `${opened ? ' <- an explicit view type opens a file its selector does not match' : said ? ' <- refused, and said why' : ' <- NOTHING HAPPENED AND NOTHING WAS SAID'}; ` +
          `control, a .md opened plainly: ${control.kind}` +
          `${detectorWorks ? '' : ', SO THIS SCENARIO CANNOT SEE SHEAF AND ITS OTHER READINGS MEAN NOTHING'}`,
      };
    },
  },
];
