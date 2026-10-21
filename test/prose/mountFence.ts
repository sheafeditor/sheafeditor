/*
 * A fenced code block in a `notes` surface is drawn as a block in both states.
 *
 * `notes` carries fenced code because a description in a developer's tracker holds code more often
 * than anything else after prose, and a fence left as five lines of backticks and source is not a
 * description field anybody would ship. The two states draw it differently, which `src/lib/README.md`
 * describes: a `pre` with a `code` inside before the first focus, and lines on a panel with the
 * fence lines hidden after it. Both are asserted here, and a `field` is the control: it carries no
 * blocks, so the same bytes in one are drawn as their source.
 */

import { Scenario, ScenarioResult } from '../harness';
import { EditorView } from '@codemirror/view';
import { mount } from '../../src/lib/index';

const FENCE = 'Before.\n\n```js\nconst a = 1;\n```\n\nAfter.\n';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function read(profile: 'notes' | 'field'): Promise<{ rendered: string; lines: string[]; code: number } | string> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = mount(parent, { value: FENCE, profile });
  try {
    const rendered = surface.element.innerHTML;
    surface.focus();
    await settle();
    if (!surface.editing()) return 'no editor was built, so nothing here was tested';
    const view = EditorView.findFromDOM(surface.element);
    if (!view) return 'the editor was built but no view could be found in it';
    const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line')).map((l) => l.textContent ?? '');
    const code = view.contentDOM.querySelectorAll('.cm-line.tok-code-block').length;
    return { rendered, lines, code };
  } finally {
    surface.destroy();
    parent.remove();
  }
}

export const scenarios: Scenario[] = [
  {
    name: 'notes: a fence renders as pre and code before focus, and as code-block lines after it',
    run: async (): Promise<ScenarioResult> => {
      const r = await read('notes');
      if (typeof r === 'string') return { ok: false, detail: r };
      const pre = r.rendered.includes('<pre><code class="language-js">const a = 1;');
      const markers = r.lines.filter((l) => l.includes('```')).length;
      return {
        ok: pre && r.code > 0 && r.lines.includes('const a = 1;') && markers === 0,
        detail: `rendered pre ${pre}; ${r.code} code-block line(s); ${markers} line(s) showing a fence marker; editor lines ${JSON.stringify(r.lines)}`,
      };
    },
  },
  {
    name: 'field: the same fence is drawn as its source rather than as a block, which is the control for the notes case',
    run: async (): Promise<ScenarioResult> => {
      const r = await read('field');
      if (typeof r === 'string') return { ok: false, detail: r };
      return {
        ok: !r.rendered.includes('<pre') && r.code === 0,
        detail: `rendered ${JSON.stringify(r.rendered.slice(0, 120))}; ${r.code} code-block line(s); editor lines ${JSON.stringify(r.lines)}`,
      };
    },
  },
];
