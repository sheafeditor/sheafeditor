/*
 * Mermaid: a ```mermaid fence drawn as its diagram.
 *
 * jsdom has no layout, so Mermaid cannot draw anything in it: laying out a
 * diagram measures text on the page. These checks put a stand-in behind the
 * loader that answers with a small drawing, or fails the way Mermaid fails, and
 * check what the editor does with each: which fences are drawn and which stay
 * as written, what Edit Markdown brings back, what a diagram that does not parse
 * shows, that a drawing is made once and kept, that drawings are made one at a
 * time, and that the document is never written to. What a diagram looks like,
 * at what size, in which theme, is a real-window check.
 */

import { Scenario, mountProse } from '../harness';
import { setLivePreviewConfig } from '../../src/webview/livePreview';
import { MermaidApi, setMermaidLoader } from '../../src/webview/mermaid';

type P = ReturnType<typeof mountProse>;

const count = (p: P, selector: string): number => p.view.contentDOM.querySelectorAll(selector).length;
const first = (p: P, selector: string): HTMLElement | null => p.view.contentDOM.querySelector<HTMLElement>(selector);
const text = (p: P): string => p.view.contentDOM.textContent ?? '';

/** Let the loader and the drawing queue run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** What the stand-in was asked to do. */
interface Calls {
  renders: string[];
  configs: Record<string, unknown>[];
  /** The most drawings in progress at once. */
  overlap: number;
}

/**
 * A stand-in for Mermaid. A source whose first line is `broken` fails as a parse
 * error does; anything else is drawn as an SVG naming its first line.
 */
function stub(): Calls {
  const calls: Calls = { renders: [], configs: [], overlap: 0 };
  let running = 0;
  const api: MermaidApi = {
    initialize: (config) => {
      calls.configs.push(config);
    },
    render: async (_id, source) => {
      calls.renders.push(source);
      running++;
      calls.overlap = Math.max(calls.overlap, running);
      await new Promise((r) => setTimeout(r, 0));
      running--;
      const head = source.trim().split('\n')[0];
      if (head === 'broken') throw new Error("Parse error on line 2:\n...ph TD A-->\n----------^\nExpecting 'NODE_STRING', got 'EOF'");
      return { svg: `<svg xmlns="http://www.w3.org/2000/svg" style="max-width: 800px" aria-roledescription="${head}"><text>${head}</text></svg>` };
    },
  };
  setMermaidLoader(async () => api);
  return calls;
}

/**
 * Run `fn` with "Reveal Syntax On Line" off, restoring the test default (on)
 * afterwards, so a caret elsewhere in the document leaves a diagram drawn.
 */
const withoutRevealOnLine = async (fn: () => Promise<boolean>): Promise<boolean> => {
  setLivePreviewConfig({ revealSyntaxOnLine: false });
  try {
    return await fn();
  } finally {
    setLivePreviewConfig({ revealSyntaxOnLine: true });
  }
};

const PIE = '```mermaid\npie title Ships\n    "Tanker" : 66\n    "Liner" : 42\n```';

export const scenarios: Scenario[] = [
  {
    name: 'a mermaid fence is drawn as its diagram in place of the lines it is written on',
    run: () =>
      withoutRevealOnLine(async () => {
        const calls = stub();
        const doc = `Before.\n\n${PIE}\n\nAfter.`;
        const p = mountProse(doc);
        p.select(0);
        await settle();
        const block = first(p, '.md-mermaid');
        const ok =
          count(p, '.md-mermaid') === 1 &&
          !!block?.querySelector('svg') &&
          !block.classList.contains('is-drawing') &&
          // The fence and its source are gone from the text around it.
          !text(p).includes('```') &&
          !text(p).includes('"Tanker"') &&
          text(p).includes('Before.') &&
          text(p).includes('After.') &&
          calls.renders.length === 1 &&
          calls.renders[0] === 'pie title Ships\n    "Tanker" : 66\n    "Liner" : 42' &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'Mermaid is asked for strict security and to throw rather than draw its own error picture',
    run: () =>
      withoutRevealOnLine(async () => {
        const calls = stub();
        const p = mountProse(`${PIE}\n\nAfter.`);
        p.select(p.doc().length);
        await settle();
        const config = calls.configs[0] ?? {};
        const ok = config.securityLevel === 'strict' && config.suppressErrorRendering === true && config.startOnLoad === false;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'Edit Markdown brings a diagram back as the fence it is written as, and it is drawn again after',
    run: () =>
      withoutRevealOnLine(async () => {
        stub();
        const doc = `Before.\n\n${PIE}\n\nAfter.`;
        const p = mountProse(doc);
        p.select(0);
        await settle();
        const drawn = count(p, '.md-mermaid') === 1;
        p.select(doc.indexOf('```mermaid'));
        p.press('Mod-Alt-e');
        const revealed = count(p, '.md-mermaid') === 0 && text(p).includes('```mermaid') && text(p).includes('"Tanker" : 66');
        p.select(doc.indexOf('After.'));
        await settle();
        const back = count(p, '.md-mermaid') === 1;
        const ok = drawn && revealed && back && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a fence with no closer yet, an empty one, and other languages stay as written',
    run: () =>
      withoutRevealOnLine(async () => {
        const calls = stub();
        const cases = [
          // Someone halfway through typing one: it must not swallow the paragraph after it.
          'Before.\n\n```mermaid\ngraph TD\n  A --> B\n\nAfter.',
          'Before.\n\n```mermaid\n```\n\nAfter.',
          'Before.\n\n```mermaid\n   \n```\n\nAfter.',
          'Before.\n\n```js\nconst a = 1;\n```\n\nAfter.',
          'Before.\n\n```\ngraph TD\n```\n\nAfter.',
        ];
        let ok = true;
        for (const doc of cases) {
          const p = mountProse(doc);
          p.select(0);
          await settle();
          if (count(p, '.md-mermaid') !== 0 || p.doc() !== doc) ok = false;
          p.destroy();
        }
        return ok && calls.renders.length === 0;
      }),
  },
  {
    name: 'a fence spelled with tildes, in capitals, or with more after the language is still a diagram',
    run: () =>
      withoutRevealOnLine(async () => {
        stub();
        const cases = ['~~~mermaid\npie\n~~~', '```Mermaid\npie\n```', '```mermaid title="ships"\npie\n```', '````mermaid\npie\n````'];
        let ok = true;
        for (const fence of cases) {
          const doc = `Before.\n\n${fence}\n\nAfter.`;
          const p = mountProse(doc);
          p.select(0);
          await settle();
          if (count(p, '.md-mermaid') !== 1 || p.doc() !== doc) ok = false;
          p.destroy();
        }
        return ok;
      }),
  },
  {
    name: 'a fence inside a quote or a list stays as written',
    run: () =>
      withoutRevealOnLine(async () => {
        stub();
        const cases = ['Before.\n\n> ```mermaid\n> pie\n> ```\n\nAfter.', 'Before.\n\n- item\n\n  ```mermaid\n  pie\n  ```\n\nAfter.'];
        let ok = true;
        for (const doc of cases) {
          const p = mountProse(doc);
          p.select(0);
          await settle();
          if (count(p, '.md-mermaid') !== 0 || p.doc() !== doc) ok = false;
          p.destroy();
        }
        return ok;
      }),
  },
  {
    name: 'a diagram that does not parse shows its source and the message, and throws nothing',
    run: () =>
      withoutRevealOnLine(async () => {
        stub();
        const doc = 'Before.\n\n```mermaid\nbroken\ngraph TD A-->\n```\n\nAfter.';
        const errors: unknown[] = [];
        const onError = (e: unknown): void => {
          errors.push(e);
        };
        process.on('unhandledRejection', onError);
        const p = mountProse(doc);
        p.select(0);
        await settle();
        process.off('unhandledRejection', onError);
        const block = first(p, '.md-mermaid');
        const source = block?.querySelector('.md-mermaid-source')?.textContent ?? '';
        const message = block?.querySelector('.md-mermaid-message')?.textContent ?? '';
        const ok =
          !!block &&
          block.classList.contains('md-mermaid-error') &&
          !block.querySelector('svg') &&
          source === 'broken\ngraph TD A-->' &&
          // Mermaid's own heading line is dropped; what went wrong is kept.
          !message.startsWith('Parse error') &&
          message.includes("Expecting 'NODE_STRING'") &&
          errors.length === 0 &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'when Mermaid cannot be loaded the block says so over its source, and the document is untouched',
    run: () =>
      withoutRevealOnLine(async () => {
        setMermaidLoader(async () => {
          throw new Error('Failed to fetch dynamically imported module');
        });
        const doc = `Before.\n\n${PIE}\n\nAfter.`;
        const p = mountProse(doc);
        p.select(0);
        await settle();
        const block = first(p, '.md-mermaid');
        const ok =
          !!block?.classList.contains('md-mermaid-error') &&
          (block.querySelector('.md-mermaid-source')?.textContent ?? '').includes('"Tanker" : 66') &&
          (block.querySelector('.md-mermaid-message')?.textContent ?? '').includes('Failed to fetch') &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a diagram is drawn once: redrawn blocks and a document opened again reuse the drawing',
    run: () =>
      withoutRevealOnLine(async () => {
        const calls = stub();
        const doc = `Before.\n\n${PIE}\n\nAfter.`;
        const p = mountProse(doc);
        p.select(0);
        await settle();
        // Typing elsewhere redraws the decorations; the diagram's source is unchanged.
        p.select(doc.indexOf('After.'));
        p.view.dispatch({ changes: { from: doc.indexOf('After.'), insert: 'Still ' } });
        await settle();
        const again = mountProse(doc);
        again.select(0);
        await settle();
        const ok =
          calls.renders.length === 1 &&
          count(p, '.md-mermaid svg') === 1 &&
          count(again, '.md-mermaid svg') === 1 &&
          p.doc() === doc.replace('After.', 'Still After.');
        p.destroy();
        again.destroy();
        return ok;
      }),
  },
  {
    name: 'several diagrams are drawn one at a time, each with its own source',
    run: () =>
      withoutRevealOnLine(async () => {
        const calls = stub();
        const doc = 'One.\n\n```mermaid\npie title A\n```\n\nTwo.\n\n```mermaid\ngantt\n```\n\nThree.\n\n```mermaid\nflowchart LR\n```\n';
        const p = mountProse(doc);
        p.select(0);
        await settle();
        await settle();
        const heads = Array.from(p.view.contentDOM.querySelectorAll('.md-mermaid svg')).map((s) => s.getAttribute('aria-roledescription'));
        const ok = calls.overlap === 1 && calls.renders.length === 3 && heads.join(',') === 'pie title A,gantt,flowchart LR' && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a drawn diagram shrinks with the pane to a floor, and scrolls past it from the keyboard',
    run: () =>
      withoutRevealOnLine(async () => {
        stub();
        const p = mountProse(`Before.\n\n${PIE}\n\nAfter.`);
        p.select(0);
        await settle();
        const region = first(p, '.md-mermaid-scroll');
        const svg = region?.querySelector('svg');
        const ok =
          !!region &&
          region.tabIndex === 0 &&
          region.getAttribute('role') === 'region' &&
          (region.getAttribute('aria-label') ?? '').includes('Diagram') &&
          svg?.style.width === '100%' &&
          // The stand-in's drawing is 800px wide at most, so the floor is the smaller of it and 420px.
          svg?.style.minWidth === '420px';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'whole-document source mode shows every diagram as its fence',
    run: () =>
      withoutRevealOnLine(async () => {
        stub();
        const doc = `Before.\n\n${PIE}\n\nAfter.`;
        const p = mountProse(doc);
        p.select(0);
        await settle();
        const drawn = count(p, '.md-mermaid') === 1;
        const { setDocumentSourceMode } = await import('../../src/webview/livePreview.js');
        setDocumentSourceMode(p.view, document.createElement('div'), true);
        const source = count(p, '.md-mermaid') === 0 && text(p).includes('```mermaid');
        setDocumentSourceMode(p.view, document.createElement('div'), false);
        const ok = drawn && source && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'turning the page dark draws the diagrams again in Mermaid’s dark theme',
    run: () =>
      withoutRevealOnLine(async () => {
        const calls = stub();
        const p = mountProse(`Before.\n\n${PIE}\n\nAfter.`);
        p.select(0);
        await settle();
        const before = calls.configs.map((c) => c.theme).join(',');
        document.body.style.backgroundColor = 'rgb(30, 30, 30)';
        await settle();
        await settle();
        const after = calls.configs.map((c) => c.theme).join(',');
        document.body.style.backgroundColor = '';
        await settle();
        const ok = before === 'default' && after === 'default,dark' && calls.renders.length === 2 && count(p, '.md-mermaid svg') === 1;
        p.destroy();
        return ok;
      }),
  },
];
