// E2E scenarios for the editor chrome's type, driven in real VS Code.
//
// The chrome is the toolbar, the menus, the slash menu, the table and view headers, the heading
// rail, the link popover, the find bar and the shortcut card. It takes four named steps, scaled
// from the host editor's own UI size: `--sheaf-ui-row`, `--sheaf-ui-secondary`, `--sheaf-ui-label`
// and `--sheaf-ui-title`, defined in `media/webview.css`.
//
// This has to be a real window. `--vscode-font-size` exists only inside a VS Code webview, so the
// browser probes used for the document's typography read the fallback and would pass against a
// chrome that follows nothing. The question here is precisely whether the chrome moves when the
// editor's own size does, and a px value cannot be told from a scaled one at the default.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

/*
 * Enough of the chrome on the screen at once to be worth measuring: two headings for the
 * heading rail, a pipe table for its bar, and a CSV block for the format badge. A thinner
 * document is what made the first run read three elements out of seven and pass, which is the
 * shrinking-list failure the count below now catches.
 */
const DOC =
  `# Notes\n\nA paragraph of body text.\n\n## Fruit\n\n| Fruit | Qty |\n| --- | --- |\n| kiwi | 3 |\n\n` +
  '```csv\nname,qty\napple,2\n```\n';

/**
 * Every chrome element on the screen with its computed size, and the four steps it may take.
 *
 * Read as computed pixels rather than as the declaration, because what is being asked is what a
 * person sees. A rule naming the right variable in a place the cascade overrides is exactly the
 * failure a declaration check passes over.
 */
const sizes = (S) =>
  S.eval(() => {
    const root = document.querySelector('.sheaf-root') ?? document.body;
    const px = (v) => {
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;font-size:${v}`;
      root.appendChild(probe);
      const n = parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      return Math.round(n * 100) / 100;
    };
    const steps = {
      row: px('var(--sheaf-ui-row)'),
      secondary: px('var(--sheaf-ui-secondary)'),
      label: px('var(--sheaf-ui-label)'),
      title: px('var(--sheaf-ui-title)'),
    };
    /*
     * The chrome that is on the screen with nothing opened. A menu's items are not here because
     * a menu has to be opened first; the scenario below opens one and reads it separately, so
     * that a list of things that happen to be visible does not quietly shrink to nothing.
     */
    const want = [
      '#toolbar button',
      '.sheaf-tb-dd-label',
      '.sheaf-toc',
      '.sheaf-toc-header',
      '.sheaf-table-ctrl',
      '.sheaf-table-caption',
      '.sheaf-table-badge',
    ];
    const seen = [];
    for (const sel of want) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        seen.push({ sel, size: Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100 });
        break;
      }
    }
    const body = document.querySelector('.cm-content .cm-line');
    return {
      steps,
      seen,
      hostSize: getComputedStyle(root).getPropertyValue('--vscode-font-size').trim(),
      // The editor's text size, for the account below of which of the two the host moves.
      hostEditorSize: getComputedStyle(root).getPropertyValue('--vscode-editor-font-size').trim(),
      hostFamily: getComputedStyle(root).getPropertyValue('--vscode-font-family').trim().slice(0, 40),
      // The document's own text, which has its own setting and must not move with the chrome.
      body: body ? Math.round(parseFloat(getComputedStyle(body).fontSize) * 100) / 100 : null,
    };
  });

/** Change the profile's settings while the window is open, and let VS Code pick it up. */
async function setSettings(S, patch) {
  const path = join(S.run, 'user', 'User', 'settings.json');
  const now = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...now, ...patch }, null, 2));
  await S.sleep(2500);
}

export const scenarios = [
  {
    id: 'render.chrome-type.e01',
    feature: 'render.chrome-type',
    name: 'Every chrome element on the screen takes one of the four named steps, and a menu item does too',
    run: async (S) => {
      // The heading rail is hidden by default, and it is chrome this is meant to cover.
      await setSettings(S, { 'sheaf.tableOfContents': 'shown' });
      await S.fresh('chrome-steps', DOC);
      await S.sleep(800);
      const before = await sizes(S);
      // A menu, so the items and their keycaps are measured rather than assumed.
      await S.rightClick({ text: 'paragraph', offset: 2 });
      await S.sleep(300);
      const menu = await S.eval(() => {
        const one = (sel) => {
          const el = document.querySelector(sel);
          return el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100 : null;
        };
        return { item: one('.sheaf-ctx-item span'), key: one('.sheaf-ctx-key') };
      });
      await S.press('Escape');
      await S.shot('chrome-steps');
      const steps = Object.values(before.steps);
      const strays = before.seen.filter((s) => !steps.some((v) => Math.abs(v - s.size) < 0.51));
      /*
       * The list may not shrink quietly. Every one of the seven selectors is on the screen in this
       * document, and a check that measured whatever it happened to find would go on passing as
       * the chrome it covers fell away: the first run of this read three of seven and said nothing.
       */
      if (before.seen.length < 7) {
        const missing = ['#toolbar button', '.sheaf-tb-dd-label', '.sheaf-toc', '.sheaf-toc-header', '.sheaf-table-ctrl', '.sheaf-table-caption', '.sheaf-table-badge'].filter(
          (sel) => !before.seen.some((s) => s.sel === sel)
        );
        return { ok: false, detail: `only ${before.seen.length} of 7 chrome elements were on the screen; missing ${j(missing)}` };
      }
      if (strays.length) return { ok: false, detail: `off the scale: ${j(strays)}; the steps are ${j(before.steps)}` };
      // A menu item is a row and its keycap is a label; both are read from the menu itself.
      const menuOk =
        menu.item !== null && Math.abs(menu.item - before.steps.row) < 0.51 && menu.key !== null && Math.abs(menu.key - before.steps.label) < 0.51;
      return {
        ok: menuOk,
        detail: `steps ${j(before.steps)}; ${before.seen.length} elements on the scale; menu ${j(menu)}; host ${j(before.hostSize)}`,
      };
    },
  },
  {
    id: 'render.chrome-type.e02',
    feature: 'render.chrome-type',
    name: 'One variable moves every chrome element and none of the document, so the chrome is one knob',
    run: async (S) => {
      await S.fresh('chrome-knob', DOC);
      await S.sleep(800);
      const before = await sizes(S);
      /*
       * The variable is overridden from script rather than by changing a setting, and that is
       * worth the explanation because the issue this comes from asked for the setting.
       *
       * `--vscode-font-size` does not move. VS Code hard-codes it to 13px in every webview; what
       * it derives from `editor.fontSize` is `--vscode-editor-font-size`, which is the editor's
       * *text* size and not its UI size. Measured, not assumed: e03 below changes
       * `editor.fontSize` and reads both. So a scenario driving a setting would have reported the
       * chrome as following nothing, against code that is doing the right thing with the right
       * variable, which is the worst kind of failure to leave in a suite.
       *
       * What is real and checkable is the property the four steps exist for: they all derive from
       * one base, so moving that base moves the whole chrome together and reaches nothing else.
       * That is what makes the chrome followable the day a host supplies a size, and it is what a
       * stray px value in one rule would break.
       */
      // On the element the tokens are declared on. A custom property is substituted where it is
      // declared, so `--sheaf-ui-row: var(--sheaf-ui-step)` on `:root` reads `:root`'s value and
      // an override further down the tree changes nothing, which is what the first run reported.
      await S.eval(() => document.documentElement.style.setProperty('--sheaf-ui-step', '20px'));
      await S.sleep(250);
      const after = await sizes(S);
      await S.eval(() => document.documentElement.style.removeProperty('--sheaf-ui-step'));
      await S.shot('chrome-knob');
      const detail =
        `--vscode-font-size ${j(before.hostSize)}; steps ${j(before.steps)} -> ${j(after.steps)}; ` +
        `body ${before.body} -> ${after.body}; elements ${j(before.seen.map((s) => s.size))} -> ${j(after.seen.map((s) => s.size))}`;
      if (!before.seen.length) return { ok: false, detail: 'no chrome element was found to measure' };
      // Every step moved, so none of the four is pinned to a number of its own.
      const stepsMoved = Object.keys(before.steps).filter((k) => after.steps[k] <= before.steps[k] + 0.5);
      if (stepsMoved.length) return { ok: false, detail: `${detail}. These steps did not move: ${j(stepsMoved)}.` };
      // And every element on the screen moved with them, so none of them is off the scale.
      const stuck = before.seen.filter((s, i) => after.seen[i].size <= s.size + 0.01).map((s) => s.sel);
      if (stuck.length) return { ok: false, detail: `${detail}. These elements did not move with the scale: ${j(stuck)}.` };
      /*
       * And the document did not come with it. `sheaf.fontSize` is the document's own setting, so
       * a chrome scale that reached the text would take that setting away from whoever set it.
       * This is the control on the change rather than a second assertion about it.
       */
      const bodyHeld = before.body !== null && after.body !== null && Math.abs(after.body - before.body) < 0.51;
      return { ok: bodyHeld, detail: `${detail}${bodyHeld ? '' : '. The document text moved with the chrome, and it has its own setting.'}` };
    },
  },
  {
    id: 'render.chrome-type.e03',
    feature: 'render.chrome-type',
    name: 'VS Code holds --vscode-font-size fixed and moves --vscode-editor-font-size, so the chrome is right not to follow editor.fontSize',
    run: async (S) => {
      /*
       * A record of the host's behaviour rather than a check on Sheaf, and it is here because
       * the alternative is a comment nobody can verify. If VS Code ever makes `--vscode-font-size`
       * configurable, this fails and whoever reads it learns that the chrome now follows it for
       * free, which is the outcome the scale was built for.
       */
      await S.fresh('chrome-host', DOC);
      await S.sleep(800);
      const before = await sizes(S);
      await setSettings(S, { 'editor.fontSize': 22 });
      const after = await sizes(S);
      await setSettings(S, { 'editor.fontSize': 14 });
      const detail =
        `--vscode-font-size ${j(before.hostSize)} -> ${j(after.hostSize)}; ` +
        `--vscode-editor-font-size ${j(before.hostEditorSize)} -> ${j(after.hostEditorSize)}; row ${before.steps.row} -> ${after.steps.row}`;
      if (before.hostEditorSize === after.hostEditorSize) {
        return { ok: false, detail: `${detail}. The setting did not reach the webview at all, so nothing here was measured.` };
      }
      const uiHeld = before.hostSize === after.hostSize;
      const chromeHeld = Math.abs(after.steps.row - before.steps.row) < 0.51;
      return {
        ok: uiHeld && chromeHeld,
        detail: `${detail}${uiHeld ? '' : '. --vscode-font-size moved, so the chrome now follows the host and this scenario is out of date.'}`,
      };
    },
  },
];
