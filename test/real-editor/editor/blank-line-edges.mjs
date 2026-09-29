// A blank line between blocks draws 8px tall, and grows back to a full line while a selection
// touches it. These ask what that costs a person who drags a selection across blank lines, and
// what a long document does while its undrawn blank lines are still estimated at full height.
//   node test/real-editor/run-editor.mjs blank-line-edges [id]
const j = (x) => JSON.stringify(x);

const THREE = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n';

/** A long document of headings and paragraphs, which is mostly blank lines. */
const LONG = (n) =>
  Array.from({ length: n }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} of this document holds a sentence.`).join('\n\n') + '\n';

/** The window point of a character in the rendered text, as the harness places a click. */
const pointOf = (S, text, offset) =>
  S.eval(
    ({ text, offset }) => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith(text));
      if (!line) return null;
      const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const node = walk.nextNode();
      if (!node) return null;
      const r = document.createRange();
      r.setStart(node, Math.min(offset, node.data.length - 1));
      r.setEnd(node, Math.min(offset + 1, node.data.length));
      const b = r.getBoundingClientRect();
      return { x: b.left + 1, y: b.top + b.height / 2 };
    },
    { text, offset }
  );

/** The top of the line starting with `text`, in the frame's own coordinates. */
const topOf = (S, text) =>
  S.eval((text) => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith(text));
    return line ? Math.round(line.getBoundingClientRect().top * 100) / 100 : null;
  }, text);

export const scenarios = [
  {
    id: 'render.blank-lines.edges.e01',
    feature: 'render.blank-lines',
    name: 'A selection dragged from the first paragraph to a word in the third ends at that word, and the text under the pointer does not move while the drag is on',
    run: async (S) => {
      await S.fresh('blank-drag-select', THREE);
      await S.sleep(600);
      // The harness clicks in window coordinates and the boxes above are the frame's, so one
      // real click gives the offset between them.
      const startWindow = await S.click({ text: 'First', offset: 0 });
      const startFrame = await pointOf(S, 'First', 0);
      const targetFrame = await pointOf(S, 'Third', 6);
      const thirdBefore = await topOf(S, 'Third');
      if (!startFrame || !targetFrame) return { ok: false, detail: 'could not find the lines to drag between' };
      const dx = startWindow.x - startFrame.x;
      const dy = startWindow.y - startFrame.y;
      const start = { x: startWindow.x, y: startWindow.y };
      const target = { x: targetFrame.x + dx, y: targetFrame.y + dy };
      await S.page.mouse.move(start.x, start.y);
      await S.page.mouse.down();
      // Move in steps, as a hand does, so every blank line crossed is crossed while the button is down.
      for (let i = 1; i <= 8; i++) {
        await S.page.mouse.move(start.x + ((target.x - start.x) * i) / 8, start.y + ((target.y - start.y) * i) / 8);
        await S.sleep(60);
      }
      const thirdDuring = await topOf(S, 'Third');
      const underPointer = await S.eval(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const line = el && el.closest ? el.closest('.cm-line') : null;
        return line ? line.textContent.slice(0, 20) : null;
      }, targetFrame);
      await S.page.mouse.up();
      await S.sleep(300);
      const picked = await S.eval(() => String(getSelection() ?? ''));
      const moved = thirdBefore !== null && thirdDuring !== null ? Math.round((thirdDuring - thirdBefore) * 100) / 100 : null;
      // A person releasing over "paragraph" in the third line expects the selection to end there.
      // Released over "paragraph" in the third line, the selection reaches into that line and
      // stops before the word; the third line must not have moved under the pointer meanwhile.
      const ok = picked.startsWith('First paragraph here.') && /Third\s*$/.test(picked) && moved === 0;
      return {
        ok,
        detail: `third line moved ${moved}px while dragging; the pointer ended over ${j(underPointer)}; selected ${j(picked)}`,
      };
    },
  },
  {
    id: 'render.blank-lines.edges.e02',
    feature: 'render.blank-lines',
    name: 'Jumping to the end of a long document leaves the last paragraph where it landed, with nothing moving under the reader afterwards',
    run: async (S) => {
      await S.fresh('blank-long-jump', LONG(150));
      await S.sleep(1200);
      await S.click({ text: 'Paragraph 1 of', offset: 2 });
      await S.press('Meta+ArrowDown');
      await S.sleep(400);
      const atOnce = await topOf(S, 'Paragraph 150 of');
      await S.sleep(2000);
      const later = await topOf(S, 'Paragraph 150 of');
      const drift = atOnce !== null && later !== null ? Math.round(Math.abs(later - atOnce) * 100) / 100 : null;
      return {
        ok: atOnce !== null && later !== null && drift <= 8,
        detail: `the last paragraph sat at ${atOnce}px, and at ${later}px two seconds later: moved ${drift}px`,
      };
    },
  },
  {
    id: 'render.blank-lines.edges.e03',
    feature: 'render.blank-lines',
    name: 'Paging down a long document and back up again returns the first paragraph to where it started',
    run: async (S) => {
      await S.fresh('blank-long-paging', LONG(150));
      await S.sleep(1200);
      await S.click({ text: 'Paragraph 1 of', offset: 2 });
      await S.sleep(300);
      const before = await topOf(S, 'Paragraph 1 of');
      for (let i = 0; i < 12; i++) await S.press('PageDown');
      await S.sleep(800);
      for (let i = 0; i < 12; i++) await S.press('PageUp');
      await S.sleep(1200);
      const after = await topOf(S, 'Paragraph 1 of');
      const drift = before !== null && after !== null ? Math.round(Math.abs(after - before) * 100) / 100 : null;
      return {
        // Half a blank line: less than that is the harness's own rounding, as the build before
        // the blank-line change shows at 3px.
        ok: before !== null && after !== null && drift <= 8,
        detail: `the first paragraph sat at ${before}px, and at ${after}px after paging down and back: moved ${drift}px`,
      };
    },
  },
];
