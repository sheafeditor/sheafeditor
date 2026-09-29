// Mermaid diagrams in real VS Code: whether Mermaid's module loads from the extension under the
// webview's content policy, what a diagram that does not parse shows, which theme a diagram is
// drawn in, and what a narrow pane does to a wide one.
//   node test/real-editor/run-editor.mjs diagrams [id]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

const FLOW = 'Intro.\n\n```mermaid\nflowchart LR\n  A[Beacon silent] --> B{Backup keys?}\n  B -- yes --> C[Keyed]\n  B -- no --> D[Manual panel]\n```\n\nAfter line\n';
const BROKEN = 'Intro.\n\n```mermaid\nflowchart LR\n  A[Beacon silent] -->\n```\n\nAfter line\n';
// Wide enough that a split pane cannot hold it at its own size.
const WIDE =
  'Intro.\n\n```mermaid\nflowchart LR\n' +
  Array.from({ length: 12 }, (_, i) => `  N${i}[Station ${i} relay] --> N${i + 1}[Station ${i + 1} relay]`).join('\n') +
  '\n```\n\nAfter line\n';

/** Put a theme on through the profile, which VS Code watches. */
async function theme(S, name) {
  const path = join(S.run, 'user', 'User', 'settings.json');
  const cur = JSON.parse(readFileSync(path, 'utf8'));
  cur['workbench.colorTheme'] = name;
  writeFileSync(path, JSON.stringify(cur, null, 2));
  await S.sleep(2000);
}

/** Wait until every diagram on screen has finished drawing, or give up after a while. */
async function drawn(S, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const m = await S.eval(() => {
      const blocks = [...document.querySelectorAll('.md-mermaid')];
      return {
        blocks: blocks.length,
        drawing: blocks.filter((b) => b.classList.contains('is-drawing')).length,
        svgs: blocks.filter((b) => b.querySelector('svg')).length,
        errors: blocks.filter((b) => b.classList.contains('md-mermaid-error')).map((b) => b.querySelector('.md-mermaid-message')?.textContent ?? ''),
      };
    });
    if ((m.blocks > 0 && m.drawing === 0) || Date.now() > end) return m;
    await S.sleep(250);
  }
}

export const scenarios = [
  {
    id: 'render.diagrams.e01',
    feature: 'render.diagrams',
    name: 'A mermaid flowchart is drawn in place of its fence, which means Mermaid loaded from the extension under the webview policy',
    run: async (S) => {
      await S.fresh('diagram-flow', FLOW);
      await S.sleep(900);
      const m = await drawn(S);
      const shape = await S.eval(() => {
        const svg = document.querySelector('.md-mermaid svg');
        const text = document.querySelector('.cm-content')?.textContent ?? '';
        return {
          role: svg?.getAttribute('aria-roledescription') ?? null,
          nodes: svg ? svg.querySelectorAll('.node').length : 0,
          fenceShowing: text.includes('```') || text.includes('flowchart LR'),
          height: Math.round(document.querySelector('.md-mermaid')?.getBoundingClientRect().height ?? 0),
        };
      });
      const d = await S.disk();
      return {
        ok: m.svgs === 1 && m.errors.length === 0 && shape.nodes === 4 && !shape.fenceShowing && shape.height > 60 && d === FLOW,
        detail: `${j(m)} ${j(shape)}${d === FLOW ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.diagrams.e02',
    feature: 'render.diagrams',
    name: 'A diagram that does not parse shows its source with Mermaid\'s message, and nothing reaches the console',
    run: async (S) => {
      await S.fresh('diagram-broken', BROKEN);
      await S.sleep(900);
      const m = await drawn(S);
      const shown = await S.eval(() => document.querySelector('.md-mermaid-source')?.textContent ?? '');
      const d = await S.disk();
      return {
        ok: m.svgs === 0 && m.errors.length === 1 && m.errors[0].length > 0 && shown.includes('A[Beacon silent] -->') && d === BROKEN,
        detail: `${j(m)} source ${j(shown)}${d === BROKEN ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.diagrams.e03',
    feature: 'render.diagrams',
    name: 'In a dark theme the diagram is drawn dark, and switching back to light draws it light again',
    run: async (S) => {
      const fill = () =>
        S.eval(() => {
          const shape = document.querySelector('.md-mermaid svg .node rect, .md-mermaid svg .node polygon');
          const n = (shape ? getComputedStyle(shape).fill : '').match(/[\d.]+/g)?.map(Number) ?? [];
          return n.length >= 3 ? Math.round(0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]) : null;
        });
      await theme(S, 'Default Dark Modern');
      await S.fresh('diagram-dark', FLOW);
      await S.sleep(900);
      await drawn(S);
      const dark = await fill();
      await theme(S, 'Default Light Modern');
      await S.sleep(600);
      await drawn(S);
      const light = await fill();
      const d = await S.disk();
      return {
        ok: dark !== null && light !== null && dark < 110 && light > 150 && d === FLOW,
        detail: `node fill luminance dark ${dark}, light ${light}${d === FLOW ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.diagrams.e04',
    feature: 'render.diagrams',
    name: 'In a narrow pane a wide diagram shrinks to its floor and then scrolls inside its own block, never widening the document',
    run: async (S) => {
      await theme(S, 'Default Light Modern');
      await S.fresh('diagram-wide', WIDE);
      await S.sleep(900);
      const measure = () =>
        S.eval(() => {
          const scroller = document.querySelector('.cm-scroller');
          const region = document.querySelector('.md-mermaid-scroll');
          const svg = region?.querySelector('svg');
          return {
            pane: region ? Math.round(region.clientWidth) : null,
            pageScrollsSideways: scroller ? scroller.scrollWidth > scroller.clientWidth + 1 : null,
            regionScrolls: region ? region.scrollWidth > region.clientWidth + 1 : null,
            svgWidth: svg ? Math.round(svg.getBoundingClientRect().width) : null,
            natural: svg ? parseFloat(svg.style.maxWidth) : null,
            focusable: region?.tabIndex === 0,
          };
        });
      // One split: narrower than the diagram, wider than the floor. It shrinks to fit.
      await S.command('View: Split Editor Right');
      await S.sleep(1400);
      await drawn(S);
      const half = await measure();
      // A second split takes the pane under the floor. It stops shrinking and scrolls.
      await S.command('View: Split Editor Right');
      await S.sleep(1400);
      await drawn(S);
      const third = await measure();
      const d = await S.disk();
      const shrank = half.svgWidth !== null && half.natural !== null && half.svgWidth < half.natural && !half.regionScrolls && half.svgWidth <= (half.pane ?? 0) + 1;
      const scrolls = third.pane !== null && third.pane < 420 && third.regionScrolls === true && third.svgWidth !== null && third.svgWidth >= 419;
      return {
        ok: shrank && scrolls && !half.pageScrollsSideways && !third.pageScrollsSideways && third.focusable && d === WIDE,
        detail: `half ${j(half)}; third ${j(third)}${d === WIDE ? '' : '; the file changed'}`,
      };
    },
  },
  {
    /*
     * A click below a diagram lands on the line it was aimed at.
     *
     * A diagram is drawn after the editor has measured the block it sits in, so unless the
     * editor is asked to read the heights again the map keeps the small number it took before
     * the drawing, everything below is mapped short, and a click resolves past the end of the
     * document. It landed on the last line, not one line off.
     *
     * The paragraph beside it is the control: the same click in a document with no diagram has
     * to land, or this measures the clicking rather than the diagram.
     */
    id: 'render.diagrams.e05',
    feature: 'render.diagrams',
    name: 'A click on the paragraph under a diagram puts the caret on that paragraph, and typing goes there',
    run: async (S) => {
      const doc = 'Above here.\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\nTarget line.\n\nTail one.\n';
      const plain = 'Above here.\n\nA paragraph in between, no widget at all.\n\nTarget line.\n\nTail one.\n';
      const landOn = async (name, text) => {
        await S.fresh(name, text);
        await S.sleep(2500);
        await S.caret('Target line.', 6);
        await S.sleep(300);
        const where = await S.eval(() => {
          const content = document.querySelector('.cm-content');
          const tile = content && (content.cmTile || content.cmView);
          const view = tile && ((tile.root && tile.root.view) || tile.view);
          if (!view) return null;
          const head = view.state.selection.main.head;
          return { line: view.state.doc.lineAt(head).text, height: Math.round(view.lineBlockAt(view.state.doc.toString().indexOf('graph TD')).height) };
        });
        return where;
      };
      const underDiagram = await landOn('diagram-click', doc);
      // And typing goes where the caret went, which is the whole of what a person notices.
      await S.type('X');
      await S.sleep(400);
      const typed = await S.disk();
      const control = await landOn('diagram-click-plain', plain);
      const wantTyped = doc.replace('Target', 'TargetX');
      return {
        ok: underDiagram?.line === 'Target line.' && control?.line === 'Target line.' && typed === wantTyped,
        detail:
          `under a diagram the caret landed on ${j(underDiagram?.line)} with the diagram's block ${underDiagram?.height}px; ` +
          `typing gave ${j(typed)}${typed === wantTyped ? '' : ` rather than ${j(wantTyped)}`}; ` +
          `the control with no diagram landed on ${j(control?.line)}`,
      };
    },
  },
];
