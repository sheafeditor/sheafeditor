// Handing what you picked to something else, in real VS Code: the Copy ref key, the Send to
// terminal key, and the menu items beside them. The commands run in the extension host, so this is
// the only place the whole path can be driven: a key in the webview, a command in the host, and a
// clipboard or a terminal at the end of it.
//   node test/real-editor/run-editor.mjs sharing [id]
const j = (x) => JSON.stringify(x);

// The terminal draws to a canvas by default, which leaves nothing to read. The DOM renderer puts
// its rows in the page, which is the only way to see what was typed at the prompt.
export const settings = { 'terminal.integrated.gpuAcceleration': 'off' };

const DOC = 'Intro line.\n\nFirst line.\n\nSecond line.\n\nThird line.\n\nAfter line.\n';
const TABLE = 'Intro line.\n\n| Part | Qty |\n| ---- | --- |\n| bolt | 12 |\n| nut  | 30 |\n\nAfter line.\n';

/** What the terminal was given, read from the panel rather than from the command. */
const terminalText = (S) =>
  S.page
    .locator('.terminal-wrapper .xterm-rows')
    .first()
    .innerText()
    .catch(() => '');

/**
 * Prove the terminal on screen is the test window's own before anything is typed into it.
 *
 * The harness gives the test profile a shell that reads no startup files and shows the
 * prompt `sheaf-test%`, which no other shell on the machine has. If that prompt is not
 * there, the terminal is somebody else's: on a machine whose startup files attach a
 * shell to tmux when there is an SSH connection, it has been a person's live session,
 * and keys sent to it landed at their prompt. So this refuses, loudly, and the scenario
 * fails without having typed a thing.
 */
async function terminalIsOurs(S) {
  // The word alone, not the whole prompt: the terminal draws its trailing `% ` in a
  // way that does not always survive being read back as text, and the first version of
  // this refused a terminal that was plainly the right one for that reason. No other
  // shell on the machine prints this word, so it is enough.
  for (let i = 0; i < 40; i++) {
    const text = await terminalText(S);
    if (text.includes('sheaf-test')) return;
    await S.sleep(150);
  }
  const seen = (await terminalText(S)).replace(/\s+/g, ' ').trim().slice(-120);
  throw new Error(
    `refusing to type into a terminal that is not the test profile's own: no "sheaf-test" prompt on screen, saw ${JSON.stringify(seen)}`
  );
}

export const scenarios = [
  {
    id: 'sharing.copy-ref.e01',
    feature: 'sharing.copy-ref',
    name: 'The Copy ref key puts the same reference on the clipboard as the menu item does',
    run: async (S) => {
      await S.fresh('share-key', DOC);
      await S.sleep(600);
      await S.select('Second line.');
      await S.clipboard.write('SENTINEL-key');
      await S.press('Meta+Shift+Alt+r');
      await S.sleep(900);
      const byKey = await S.clipboard.read();
      // The same selection through the menu, which is the reference this has to match.
      await S.clipboard.write('SENTINEL-menu');
      await S.rightClick({ text: 'Second line', offset: 3 });
      await S.menu('Copy ref');
      await S.sleep(700);
      const byMenu = await S.clipboard.read();
      const d = await S.disk();
      return {
        ok: byKey === byMenu && byKey.includes('share-key.md:5') && byKey.includes('Second line.') && d === DOC,
        detail: `key ${j(byKey)}; menu ${j(byMenu)}${d === DOC ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'sharing.copy-ref.e02',
    feature: 'sharing.copy-ref',
    name: 'The key works on a table row too, naming the row line and quoting it',
    run: async (S) => {
      await S.fresh('share-row', TABLE);
      await S.sleep(700);
      await S.click({ sel: '.sheaf-table [data-r="1"][data-c="0"]' });
      await S.clipboard.write('SENTINEL-row');
      await S.press('Meta+Shift+Alt+r');
      await S.sleep(900);
      const ref = await S.clipboard.read();
      const d = await S.disk();
      return {
        ok: ref.includes('share-row.md:6 (Part, row 2)') && ref.includes('\nnut\n') && d === TABLE,
        detail: `${j(ref)}${d === TABLE ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'sharing.terminal.e01',
    feature: 'sharing.terminal',
    name: 'Send to terminal types the reference at the prompt without submitting it',
    run: async (S) => {
      await S.fresh('share-term', DOC);
      await S.sleep(600);
      await S.command('Terminal: Create New Terminal');
      await S.sleep(2500);
      await terminalIsOurs(S);
      await S.click({ text: 'Second line', offset: 3 });
      await S.select('Second line.');
      await S.press('Meta+Shift+Alt+t');
      await S.sleep(1800);
      const shown = await terminalText(S);
      const panel = await S.page.evaluate(() => ({
        terminals: document.querySelectorAll('.terminal-wrapper').length,
        xterm: document.querySelectorAll('.xterm-rows').length,
        text: [...document.querySelectorAll('.xterm-rows')].map((r) => r.textContent.replace(/\s+/g, ' ').trim().slice(-80)),
      }));
      const d = await S.disk();
      // The reference is typed at the prompt: on screen, and with no new prompt line under it,
      // which is what submitting it would leave.
      const text = shown || panel.text.join(' ');
      return {
        ok: /share-term\.md#L5/.test(text) && d === DOC,
        detail: `terminal ${j(panel)}; innerText ${j(shown.slice(-80))}${d === DOC ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'sharing.terminal.e02',
    feature: 'sharing.terminal',
    name: 'The right-click menu offers Send to terminal beside Copy ref',
    run: async (S) => {
      await S.fresh('share-menu', DOC);
      await S.sleep(600);
      await S.rightClick({ text: 'Second line', offset: 3 });
      await S.sleep(400);
      const labels = await S.eval(() =>
        [...document.querySelectorAll('.sheaf-ctx-menu:not([hidden]) .sheaf-ctx-item')].map((b) => b.querySelector('span')?.textContent ?? '')
      );
      await S.press('Escape');
      const beside = labels.indexOf('Send to terminal') === labels.indexOf('Copy ref') + 1;
      return { ok: beside, detail: `menu ${j(labels)}` };
    },
  },
];
