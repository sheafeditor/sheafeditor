// Completing a link's address, in real VS Code: the list's place on screen, and the keys that
// drive it, which reach a webview through VS Code's own key handling.
//   node test/real-editor/run-editor.mjs link-complete [id]
const j = (x) => JSON.stringify(x);

const DOC = '# Notes\n\n## Setup\n\nFirst.\n\n## Setup\n\nSecond.\n\nWrite here.\n';

/** The completion list, if one is showing: its rows and where it sits against the caret. */
const list = (S) =>
  S.eval(() => {
    const menu = document.querySelector('.sheaf-link-complete');
    if (!menu || getComputedStyle(menu).display === 'none') return null;
    const rows = [...menu.querySelectorAll('.sheaf-slash-item')].map((r) => r.textContent.trim());
    const box = menu.getBoundingClientRect();
    const caret = document.querySelector('.cm-cursor')?.getBoundingClientRect() ?? null;
    return { rows, top: box.top, bottom: box.bottom, left: box.left, caretTop: caret?.top ?? null, caretBottom: caret?.bottom ?? null, inView: box.bottom <= innerHeight && box.top >= 0 };
  });

export const scenarios = [
  {
    id: 'links.complete.e01',
    feature: 'links.complete',
    name: 'Typing ](# lists the headings beside the caret, and Down then Enter writes the second Setup as #setup-1',
    run: async (S) => {
      await S.fresh('link-complete', DOC);
      await S.caret('Write here', 10);
      await S.type(' [again](#');
      await S.sleep(500);
      const shown = await list(S);
      await S.press('ArrowDown');
      await S.press('ArrowDown');
      await S.press('Enter');
      await S.sleep(900);
      const d = await S.disk();
      // The list sits just under or just over the caret line, and wholly on screen.
      const placed = !!shown && shown.inView && shown.caretTop !== null && (Math.abs(shown.top - shown.caretBottom) < 24 || Math.abs(shown.bottom - shown.caretTop) < 24);
      // The caret was put after "Write here", before its full stop.
      const wrote = d === DOC.replace('Write here.', 'Write here [again](#setup-1).');
      return { ok: placed && (shown?.rows.length ?? 0) >= 3 && wrote, detail: `list ${j(shown)}; disk ${j(d)}` };
    },
  },
  {
    id: 'links.complete.e02',
    feature: 'links.complete',
    name: 'Escape closes the list and leaves what was typed',
    run: async (S) => {
      await S.fresh('link-complete-esc', DOC);
      await S.caret('Write here', 10);
      await S.type(' [x](#se');
      await S.sleep(500);
      const before = await list(S);
      await S.press('Escape');
      await S.sleep(300);
      const after = await list(S);
      await S.sleep(900);
      const d = await S.disk();
      return { ok: !!before && after === null && d === DOC.replace('Write here.', 'Write here [x](#se.'), detail: `before ${j(before)} after ${j(after)} disk ${j(d)}` };
    },
  },
];
