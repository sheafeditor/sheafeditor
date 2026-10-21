/*
 * What a mounted surface does with a construct its profile does not carry.
 *
 * The specification gives tables, images, callouts, maths and diagrams to the `document` profile
 * alone, and the two mounted profiles drew nearly all of them: `notes` drew six of seven inputs and
 * `field` four of seven, with only a table refused. The cause was that a profile was half a thing.
 * `field` and `notes` remove constructs from the *parse*, which is the half with a node to remove,
 * and nothing removed anything from the *drawing*, so the drawing layer went on drawing whatever
 * the modules it imports can draw.
 *
 * **The population comes from the profile table rather than from a list beside these cases**, which
 * is the property that makes the check survive a decision. A construct moved into `notes` later, or
 * a construct placed in `document` for the first time, changes which scenarios run here, and the
 * two guards at the top of the list fail by name if the table and the examples below have come
 * apart. Writing the seven inputs out as a fixed list would have made this a check on the seven
 * inputs somebody happened to measure.
 *
 * **Both states are asserted, against each other.** A mounted surface is rendered HTML until it is
 * focused and an editor afterwards, so a construct refused by one half and drawn by the other is a
 * surface that changes under the person's hands the moment they click it. That is a worse failure
 * than either half alone, it is the state this branch found (the render path was already right), and
 * it is invisible to a check that looks at one half.
 *
 * **Each case carries its own precondition**, as a `document` surface built from the same source in
 * the same environment: it must draw the thing. Without that, "no picture was drawn" reads
 * identically whether the profile refused it or jsdom could not have drawn it anyway, and that
 * reading has been got backwards here before.
 *
 * What jsdom cannot see: the size, position and appearance of anything drawn. These ask whether an
 * element exists and what text is on the lines, which is the half the defect was in.
 */

import { Scenario, ScenarioResult, mountProse } from '../harness';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { editorExtensions } from '../../src/webview/editorExtensions';
import { mount } from '../../src/lib/index';
import { carries, PROFILE_TABLE } from '../../src/dialect/profileConstructs';
import type { SurfaceProfile } from '../../src/dialect/profileConstructs';
import { setMermaidLoader } from '../../src/webview/mermaid';
import type { MermaidApi } from '../../src/webview/mermaid';
import { provideMaths, setMathsLoader } from '../../src/webview/maths';
import katex from 'katex';

const PROFILES: SurfaceProfile[] = ['field', 'notes'];

/**
 * One example per construct, with what the person must still be able to read and what must not be
 * drawn over it.
 *
 * `shows` is the construct's own characters rather than the whole source, because a surface that
 * carries quotes still hides a `>`: a callout refused in `notes` is an ordinary quote whose first
 * line reads `[!NOTE]`, and that is the decided answer rather than a shortfall. `drawn` is the
 * element a profile that carries the construct puts there, and it is what each case's precondition
 * asserts is reachable at all.
 */
interface Example {
  /** The construct's name in the profile table. */
  construct: string;
  /**
   * The other rows of the table this example exercises.
   *
   * A construct's own marker is a row of its own because the specification lists it as one, and it
   * is drawn as part of the construct that holds it rather than on its own, the same way a link's
   * marks are. So the example that covers the construct covers its marker, and saying so here is
   * the mapping from rows to examples rather than a second opinion about what a profile carries.
   */
  covers?: string[];
  /** What to call this spelling, where a construct has more than one. */
  spelling: string;
  md: string;
  /**
   * The characters that must still be readable.
   *
   * The construct's own, rather than the whole source, because a profile that carries the block
   * *around* the construct still draws that block. A callout refused in `notes` is an ordinary
   * quote, so its `>` is hidden and `[!NOTE]` is what is left; a Mermaid fence refused in `notes` is
   * an ordinary fence, so the delimiter lines are replaced and the diagram's own source is what is
   * left. Both of those are the decided answer rather than a shortfall, and the render path gives
   * the same bytes the same treatment.
   */
  shows: string;
  drawn: string;
}

const EXAMPLES: Example[] = [
  { construct: 'Table', spelling: 'pipes', md: '| a | b |\n|:--|--:|\n| 1 | 2 |\n', shows: '| a | b |', drawn: '.sheaf-table-grid' },
  { construct: 'Image', spelling: 'markdown', md: '![dot](dot.png)', shows: '![dot](dot.png)', drawn: '.md-img' },
  { construct: 'Image', spelling: 'html', md: '<img src="dot.png" alt="dot">', shows: '<img src="dot.png" alt="dot">', drawn: '.md-img' },
  { construct: 'Callout', spelling: 'note', md: '> [!NOTE]\n> Body text.\n', shows: '[!NOTE]', drawn: '.md-alert-label' },
  {
    construct: 'InlineMath',
    covers: ['InlineMathMark'],
    spelling: 'inline',
    md: 'before $x^2$ after',
    shows: '$x^2$',
    drawn: '.md-math-inline',
  },
  { construct: 'BlockMath', spelling: 'three lines', md: '$$\nx^2\n$$\n', shows: '$$', drawn: '.md-math-block' },
  { construct: 'BlockMath', spelling: 'one line', md: '$$x^2$$\n', shows: '$$x^2$$', drawn: '.md-math-block' },
  { construct: 'Diagram', spelling: 'mermaid fence', md: '```mermaid\ngraph TD\nA-->B\n```\n', shows: 'graph TD', drawn: '.md-mermaid' },
];

/** The constructs the table gives to `document` and to nothing else. */
function documentOnly(): string[] {
  return Object.keys(PROFILE_TABLE).filter((c) => carries(c, 'document') && !carries(c, 'notes') && !carries(c, 'field'));
}

/**
 * Everything a drawing would have put on the screen, as the markup of each element found.
 *
 * The markup rather than a count, because the first version of this asked for `img` and reported
 * twenty of them in a surface that had drawn no picture at all: CodeMirror puts an
 * `<img class="cm-widgetBuffer">` beside every widget it draws, including the ones that *hide* a
 * marker, so a quote with its `>` hidden matched. Twenty lines of its own internal markup is what
 * said so, and a count of twenty would have read as the defect still standing.
 */
const DRAWINGS = ['.md-img', '.katex', '.md-math', '.tok-alert', '.md-alert-label', '.md-alert-icon', '.md-mermaid', '.sheaf-table-grid'];

function matched(root: Element, selectors: string[]): string[] {
  return selectors.flatMap((s) => Array.from(root.querySelectorAll(s)).map((el) => `${s} -> ${el.outerHTML.slice(0, 160)}`));
}

/** A stand-in for Mermaid that draws a small SVG, and the sources it was asked to draw. */
function mermaidStub(): string[] {
  const asked: string[] = [];
  const api: MermaidApi = {
    initialize: () => undefined,
    render: async (_id, source) => {
      asked.push(source);
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>drawn</text></svg>' };
    },
  };
  setMermaidLoader(async () => api);
  return asked;
}

/** Let the editor's dynamic import, and any load it started, settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** What a `profile` surface holding `md` draws and reads, once it has been focused. */
async function focused(
  md: string,
  profile: SurfaceProfile
): Promise<{ text: string; built: boolean; has: (sel: string) => boolean; drew: (sels: string[]) => string[]; close: () => void }> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = mount(parent, { value: md, profile });
  surface.focus();
  await settle();
  const view = EditorView.findFromDOM(surface.element);
  const content = view ? view.contentDOM : surface.element;
  const lines = Array.from(content.querySelectorAll<HTMLElement>('.cm-line')).map((l) => l.textContent ?? '');
  return {
    text: lines.join('\n'),
    /*
     * Whether the editor was built at all, carried alongside the rest.
     *
     * Without it "nothing was drawn" has a second cause that prints the same: the dynamic import
     * did not resolve, so there is no editor and no decoration to look for. That reads exactly like
     * a profile refusing the construct, and it is the reading these cases exist to make impossible.
     */
    built: view !== null,
    has: (sel) => content.querySelector(sel) !== null,
    drew: (sels) => matched(content, sels),
    close: () => {
      surface.destroy();
      parent.remove();
    },
  };
}

/** The HTML a `profile` surface shows before anybody focuses it, which is the render path's answer. */
function unfocused(md: string, profile: SurfaceProfile): { html: string; close: () => void } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = mount(parent, { value: md, profile });
  const html = surface.element.innerHTML;
  return {
    html,
    close: () => {
      surface.destroy();
      parent.remove();
    },
  };
}

/*
 * The two guards that make the population a measurement rather than a list.
 *
 * They point in opposite directions on purpose. One catches a construct placed in `document` with
 * no example here, which would leave it unchecked while the count below went on reading as
 * complete. The other catches an example for a construct a profile now carries, which would leave a
 * case asserting that something is refused after a decision said it should be drawn.
 */
const guards: Scenario[] = [
  {
    name: 'profiles: every construct the table gives to document alone has an example here',
    run: () => {
      const covered = new Set(EXAMPLES.flatMap((e) => [e.construct, ...(e.covers ?? [])]));
      const missing = documentOnly().filter((c) => !covered.has(c));
      return { ok: missing.length === 0, detail: missing.length ? `no example for ${missing.join(', ')}` : `${covered.size} constructs covered` };
    },
  },
  {
    name: 'profiles: every example here is a construct neither mounted profile carries',
    run: () => {
      const wrong = EXAMPLES.filter((e) => carries(e.construct, 'field') || carries(e.construct, 'notes'));
      return {
        ok: wrong.length === 0,
        detail: wrong.length ? `${wrong.map((e) => e.construct).join(', ')} is carried by a mounted profile now` : `${EXAMPLES.length} examples`,
      };
    },
  },
];

/*
 * The precondition for every case below, in one scenario rather than repeated in each.
 *
 * A `document` surface built from the same source in this same jsdom must draw each of these. Until
 * it does, every "nothing was drawn" below is unreadable: a profile that refuses the construct and
 * an environment that could not have drawn it give the same answer, and the conclusion drawn from
 * that measurement has been the opposite of the truth here before.
 */
const precondition: Scenario = {
  name: 'CONTROL: a document surface in this same jsdom draws every one of these constructs',
  run: async () => {
    mermaidStub();
    const absent: string[] = [];
    for (const e of EXAMPLES) {
      const p = mountProse(e.md);
      p.select(e.md.length);
      await settle();
      if (!p.view.contentDOM.querySelector(e.drawn)) absent.push(`${e.construct}/${e.spelling} (${e.drawn})`);
      p.destroy();
    }
    return {
      ok: absent.length === 0,
      detail: absent.length ? `document drew nothing for ${absent.join(', ')}` : `document draws all ${EXAMPLES.length}`,
    };
  },
};

/** One case per example per profile: the characters are readable and nothing is drawn over them. */
const refusals: Scenario[] = EXAMPLES.flatMap((e) =>
  PROFILES.map((profile) => ({
    name: `profiles: a ${profile} shows a ${e.construct} (${e.spelling}) as its own characters and draws nothing`,
    run: async (): Promise<ScenarioResult> => {
      mermaidStub();
      const f = await focused(e.md, profile);
      try {
        const readable = f.text.includes(e.shows);
        // The families, so a construct drawn by some other module's element is caught as well.
        const stray = f.drew([...new Set([e.drawn, ...DRAWINGS])]);
        return {
          ok: f.built && readable && stray.length === 0,
          detail:
            `editor ${f.built ? 'built' : 'NOT BUILT'}; text ${JSON.stringify(f.text)}; ` +
            `wanted ${JSON.stringify(e.shows)} ${readable ? 'present' : 'MISSING'}` +
            (stray.length ? `; drew ${stray.join(' | ')}` : '; drew nothing'),
        };
      } finally {
        f.close();
      }
    },
  }))
);

/*
 * The same source through the render path, which is the other half of what a consumer sees.
 *
 * A construct refused by one half and drawn by the other is a surface that changes the moment the
 * person clicks it, and asserting each half against a list of its own cannot see that: both lists
 * can be satisfied by two different answers. So this compares the two states of the same surface.
 */
const agreement: Scenario[] = EXAMPLES.flatMap((e) =>
  PROFILES.map((profile) => ({
    name: `profiles: a ${profile} draws a ${e.construct} (${e.spelling}) neither before nor after it is focused`,
    run: async (): Promise<ScenarioResult> => {
      mermaidStub();
      const before = unfocused(e.md, profile);
      // The rendered half is a string rather than a tree, so the markers are the class names the
      // drawings above would carry, plus the `<img>` an image would emit.
      const strayBefore = ['<img', 'katex', 'md-math', 'tok-alert', 'md-alert', 'md-mermaid'].filter((s) => before.html.includes(s));
      before.close();
      const f = await focused(e.md, profile);
      const strayAfter = f.drew(DRAWINGS);
      f.close();
      return {
        ok: f.built && strayBefore.length === 0 && strayAfter.length === 0,
        detail:
          `editor ${f.built ? 'built' : 'NOT BUILT'}; unfocused ${JSON.stringify(before.html)}` +
          (strayBefore.length ? `; unfocused drew ${strayBefore.join(', ')}` : '') +
          (strayAfter.length ? `; focused drew ${strayAfter.join(' | ')}` : ''),
      };
    },
  }))
);

/*
 * The network half, which is the part of "refuse to draw it" a consumer can measure from outside.
 *
 * A `field` holding `$x^2$` fetched a KaTeX chunk, over a construct it was never going to draw, on
 * a page whose content policy may have something to say about where a script comes from. The loader
 * is the instrument: `setMathsLoader` forgets whatever is already loaded, so a surface that wants
 * KaTeX has to ask for it and the ask is observable.
 *
 * It carries its own precondition for the same reason as the drawing cases: a loader nobody calls
 * reads identically whether the profile refused the construct or the document never reached the
 * code that asks.
 */
const requests: Scenario[] = [
  {
    name: 'CONTROL: a document surface holding an equation does ask for KaTeX',
    run: async () => {
      /*
       * Built here rather than through `mountProse`, and that is the whole reason this scenario is
       * eight lines instead of three. `mountProse` hands KaTeX over with `provideMaths` so that a
       * synchronous scenario can assert on a drawn equation, which makes the resource ready and
       * means nothing ever asks the loader. Measured: through `mountProse` this control reports
       * nought asks and passes for the wrong reason, which would have left the four cases under it
       * proving only that a loader nobody calls is not called.
       */
      let asked = 0;
      setMathsLoader(async () => {
        asked++;
        return katex;
      });
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const view = new EditorView({
        state: EditorState.create({ doc: 'before $x^2$ after', extensions: [editorExtensions(() => {})] }),
        parent,
      });
      await settle();
      view.destroy();
      parent.remove();
      provideMaths(katex);
      return { ok: asked > 0, detail: `the loader was asked ${asked} time(s)` };
    },
  },
  ...PROFILES.flatMap((profile) =>
    [
      { spelling: 'inline', md: 'before $x^2$ after' },
      { spelling: 'block', md: '$$\nx^2\n$$\n' },
    ].map((m) => ({
      name: `profiles: a ${profile} holding ${m.spelling} maths makes no request for KaTeX`,
      run: async (): Promise<ScenarioResult> => {
        let asked = 0;
        setMathsLoader(async () => {
          asked++;
          return katex;
        });
        const f = await focused(m.md, profile);
        const text = f.text;
        f.close();
        provideMaths(katex);
        return { ok: asked === 0, detail: `the loader was asked ${asked} time(s); text ${JSON.stringify(text)}` };
      },
    }))
  ),
  {
    name: 'CONTROL: a document surface holding a diagram does ask Mermaid to draw it',
    run: async () => {
      const asked = mermaidStub();
      const p = mountProse('```mermaid\ngraph TD\nA-->B\n```\n');
      p.select(0);
      await settle();
      p.destroy();
      return { ok: asked.length > 0, detail: `Mermaid was asked for ${asked.length} drawing(s)` };
    },
  },
  ...PROFILES.map((profile) => ({
    name: `profiles: a ${profile} holding a diagram asks Mermaid for nothing`,
    run: async (): Promise<ScenarioResult> => {
      const asked = mermaidStub();
      const f = await focused('```mermaid\ngraph TD\nA-->B\n```\n', profile);
      const text = f.text;
      f.close();
      return { ok: asked.length === 0, detail: `Mermaid was asked for ${asked.length} drawing(s); text ${JSON.stringify(text)}` };
    },
  })),
];

export const scenarios: Scenario[] = [...guards, precondition, ...refusals, ...agreement, ...requests];
