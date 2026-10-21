/*
 * Where the editor's own files are, and the one construct that has to build an address for itself.
 *
 * Nearly every file the editor fetches after it is running is reached by a relative module
 * specifier, so the browser resolves it against the address of the module doing the importing and
 * no code here has an opinion about it: the split chunks, the emoji table, KaTeX's module. The
 * fonts come off `katex.css`, which the browser resolves against the stylesheet. The diagram
 * library is the exception, because it is copied in whole rather than bundled, so nothing writes an
 * import for it and `src/webview/mermaid.ts` has to build the URL.
 *
 * It used to build it by finding a `<link>` on the page whose href held the string `webview.css`.
 * These scenarios are about the page no longer deciding it.
 *
 * ## What is asserted and why it is the address rather than the drawing
 *
 * jsdom cannot draw a diagram: laying one out measures text and there is no layout here. So a
 * scenario that asked "did an SVG appear" could not run at all, and `scripts/check-diagrams.mjs`
 * is the check that drives a real browser for that. What *can* be asserted here, and could not be
 * asserted anywhere before, is the address the loader asks for, which is the part that was broken
 * and the part no suite ever ran: every other mermaid scenario replaces the loader outright.
 *
 * Every one of the first four puts a stylesheet on the page, and none of them leaves the page with
 * none, which is deliberate. A page with no stylesheet fails the old locator with an empty answer,
 * and an empty answer is also what a missing base gives, so the two causes arrive as one symptom
 * and neither scenario can say which it met. A stylesheet that is present and is not where the
 * files are fails it with a *specific wrong address* instead, which nothing else produces: measured
 * against the old locator, two of these four printed one.
 */

import { Scenario, mountProse } from '../harness';
import { setLivePreviewConfig } from '../../src/webview/revealState';
import { assetBase, assetUrl, moduleDirectory, setAssetBase, setAssetBaseDefault } from '../../src/webview/assetBase';
import { MermaidApi, mermaidModuleUrl, setMermaidLoader } from '../../src/webview/mermaid';
import { mount } from '../../src/lib/index';

type P = ReturnType<typeof mountProse>;

const MERMAID = 'mermaid/mermaid.esm.min.mjs';
const PIE = '```mermaid\npie title Ships\n    "Tanker" : 66\n    "Liner" : 42\n```';

/** Let the loader and the drawing queue run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * Put the base back the way a suite found it.
 *
 * The base is module state, as every other thing a host tells the editor is, so a scenario that
 * left one behind would decide the next one's answer. Both halves are cleared, since a declared
 * value and a default are separate slots and only clearing one leaves the other standing.
 */
function clearBase(): void {
  setAssetBase('');
  setAssetBaseDefault('');
}

/** A stylesheet link on the page, returned so a scenario can take it off again. */
function linkStylesheet(href: string): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
  return link;
}

/**
 * Run `fn` with a page carrying `href` as its only stylesheet and `base` as the declared base,
 * and put the page and the base back afterwards.
 */
async function withPage<T>(opts: { base?: string; stylesheet?: string }, fn: () => Promise<T> | T): Promise<T> {
  const link = opts.stylesheet === undefined ? null : linkStylesheet(opts.stylesheet);
  clearBase();
  if (opts.base !== undefined) setAssetBase(opts.base);
  try {
    return await fn();
  } finally {
    link?.remove();
    clearBase();
  }
}

/** What the real loader was asked for, by driving a document that holds a diagram. */
interface Asked {
  /** Every address the loader resolved, in order. Empty means the loader was never reached. */
  urls: string[];
  /** What the loader threw, when the address came out empty. */
  errors: string[];
}

/**
 * Drive a real document holding a diagram and record the address the loader builds.
 *
 * The loader is replaced, which looks like it defeats the purpose and does not: the replacement
 * calls `mermaidModuleUrl()`, which is the function the shipping loader calls and the whole of what
 * is under test here. What cannot be replaced is the fetch, because jsdom has no diagram library to
 * fetch and `import()` of an https URL from a CommonJS bundle throws for reasons that have nothing
 * to do with the address.
 *
 * The point of driving a document rather than calling `mermaidModuleUrl()` on its own is the
 * precondition: a page with no diagram in it never reaches the loader, and a scenario asserting an
 * address it worked out itself would pass on such a page. `urls` being non-empty is that
 * precondition, and every scenario below asserts it.
 */
async function askedFor(doc: string): Promise<{ asked: Asked; drew: number }> {
  const asked: Asked = { urls: [], errors: [] };
  const api: MermaidApi = {
    initialize: () => {},
    render: async (_id, source) => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg" style="max-width: 400px"><text>${source.split('\n')[0]}</text></svg>` }),
  };
  setMermaidLoader(async () => {
    const url = mermaidModuleUrl();
    asked.urls.push(url);
    if (!url) {
      const message = 'Diagrams cannot be drawn here: the editor does not know where its files are.';
      asked.errors.push(message);
      throw new Error(message);
    }
    return api;
  });
  setLivePreviewConfig({ revealSyntaxOnLine: false });
  let p: P | null = null;
  try {
    p = mountProse(doc);
    p.select(0);
    await settle();
    const drew = p.view.contentDOM.querySelectorAll('.md-mermaid svg').length;
    return { asked, drew };
  } finally {
    p?.destroy();
    setLivePreviewConfig({ revealSyntaxOnLine: true });
  }
}

export const scenarios: Scenario[] = [
  {
    /*
     * The scenario the issue asks for, at the level jsdom can answer. A renamed stylesheet is one of
     * the three shapes a consumer's CSS pipeline produces, and the cheapest to write down; an
     * inlined stylesheet and a concatenated one both arrive at the same place, which is a page with
     * no `<link>` holding the string `webview.css`.
     */
    name: 'a diagram resolves its library from the declared base on a page whose stylesheet has been renamed',
    run: () =>
      withPage({ base: 'https://app.example/assets/sheaf/', stylesheet: 'https://app.example/css/webview.a3f2c1.css' }, async () => {
        const { asked, drew } = await askedFor(`Before.\n\n${PIE}\n\nAfter.`);
        return {
          // The precondition first: a document that never reaches the loader passes either way.
          ok: asked.urls.length === 1 && asked.urls[0] === `https://app.example/assets/sheaf/${MERMAID}` && drew === 1,
          detail: `asked ${JSON.stringify(asked.urls)}, drew ${drew}`,
        };
      }),
  },
  {
    /*
     * The same page with the stylesheet still called `webview.css`, which is every host in this
     * repository. It is here so that a fix which moved the failure rather than removing it is
     * visible: the old locator passes this one and fails the one above, and the two together say
     * the behaviour is the same either way rather than merely different.
     */
    name: 'a diagram resolves the same address on a page whose stylesheet is still called webview.css',
    run: () =>
      withPage({ base: 'https://app.example/assets/sheaf/', stylesheet: 'https://app.example/assets/sheaf/webview.css' }, async () => {
        const { asked, drew } = await askedFor(`Before.\n\n${PIE}\n\nAfter.`);
        return {
          ok: asked.urls.length === 1 && asked.urls[0] === `https://app.example/assets/sheaf/${MERMAID}` && drew === 1,
          detail: `asked ${JSON.stringify(asked.urls)}, drew ${drew}`,
        };
      }),
  },
  {
    /*
     * The sharpest of the three, because it fails the old locator with a *wrong* address rather than
     * an empty one. A page that holds a `webview.css` somewhere other than beside the editor's files
     * is the concatenated case: the stylesheet is real, it loads, and it is not where the files are.
     */
    name: 'a webview.css elsewhere on the page does not decide where the diagram library is fetched from',
    run: () =>
      withPage({ base: 'https://cdn.example/sheaf/0.3.0/', stylesheet: 'https://app.example/static/webview.css' }, async () => {
        const { asked, drew } = await askedFor(PIE);
        return {
          ok: asked.urls.length === 1 && asked.urls[0] === `https://cdn.example/sheaf/0.3.0/${MERMAID}` && drew === 1,
          detail: `asked ${JSON.stringify(asked.urls)}, drew ${drew}`,
        };
      }),
  },
  {
    /*
     * No base, and a page carrying a stylesheet that the old locator would have accepted. This was
     * written expecting it to pass either way, on the reasoning that an empty address is an empty
     * address; measured against the old locator it fails, and the failure is the sharpest of the
     * four. It drew a diagram with nobody having said where the files were, from an address read
     * off a stylesheet, which is the whole of what this change is about. So it is a control rather
     * than the documentation of a message, and the message is the second thing it asserts.
     */
    name: 'with nothing said about where the files are, a diagram says so rather than guessing from the page',
    run: () =>
      withPage({ stylesheet: 'https://app.example/assets/sheaf/webview.css' }, async () => {
        const { asked, drew } = await askedFor(PIE);
        return {
          ok:
            asked.urls.length === 1 &&
            asked.urls[0] === '' &&
            asked.errors.length === 1 &&
            asked.errors[0] === 'Diagrams cannot be drawn here: the editor does not know where its files are.' &&
            drew === 0,
          detail: `asked ${JSON.stringify(asked.urls)}, errors ${asked.errors.length}, drew ${drew}`,
        };
      }),
  },
  {
    name: 'an entry point offering its own directory is a default, and a declared base beats it whichever order they arrive in',
    run: () => {
      clearBase();
      try {
        setAssetBaseDefault('https://app.example/vendor/sheaf/');
        const def = assetBase();
        setAssetBase('https://cdn.example/sheaf/');
        const declaredWins = assetBase();
        // The other order: a second mount's default must not take away the first one's answer.
        setAssetBaseDefault('https://app.example/vendor/sheaf/');
        const stillDeclared = assetBase();
        return {
          ok:
            def === 'https://app.example/vendor/sheaf/' &&
            declaredWins === 'https://cdn.example/sheaf/' &&
            stillDeclared === 'https://cdn.example/sheaf/',
          detail: `default ${def}, declared ${declaredWins}, after a second default ${stillDeclared}`,
        };
      } finally {
        clearBase();
      }
    },
  },
  {
    /*
     * The trailing slash, which is the mistake this is written to absorb rather than report. Without
     * it `new URL` replaces the last segment, so a base of `https://cdn/sheaf` asks `https://cdn/`
     * for the file: a 404 on a path nobody wrote, with the directory the consumer named missing from
     * it.
     */
    name: 'a base is a directory, and one given without a trailing slash keeps its last segment',
    run: () => {
      clearBase();
      try {
        setAssetBase('https://cdn.example/sheaf/0.3.0');
        const added = assetUrl(MERMAID);
        setAssetBase('https://cdn.example/sheaf/0.3.0/');
        const already = assetUrl(MERMAID);
        return {
          ok: added === `https://cdn.example/sheaf/0.3.0/${MERMAID}` && already === added,
          detail: `without a slash ${added}, with one ${already}`,
        };
      } finally {
        clearBase();
      }
    },
  },
  {
    /*
     * A base that is a path rather than a URL, which is what a CSS pipeline hands a consumer and
     * what the local server writes into its own page. `new URL` refuses a path as a base, so this is
     * the branch that joins the two by hand, and the answer has to stay a path: an absolute path
     * resolves against the page's own origin, which is where it was served from.
     */
    name: 'a base that is a path resolves to a path, so it is served from the page own origin',
    run: () => {
      clearBase();
      try {
        setAssetBase('/assets/sheaf/');
        const resolved = assetUrl(MERMAID);
        // Stringified, because the failure this scenario catches is an empty answer and an empty
        // detail reads as the harness having nothing to say rather than as the measurement.
        return { ok: resolved === `/assets/sheaf/${MERMAID}`, detail: JSON.stringify(resolved) };
      } finally {
        clearBase();
      }
    },
  },
  {
    /*
     * The conversion each entry point does, and the guard beside it. The last segment comes off
     * because `import.meta.url` names a file; the `undefined` case is a CommonJS build, which every
     * suite here is, and `new URL('.', undefined)` throws rather than answering empty.
     */
    name: 'a module address becomes the directory holding it, and a build with no module address gives none',
    run: () => {
      const entry = moduleDirectory('https://app.example/vendor/sheaf/index.js');
      const deeper = moduleDirectory('https://app.example/vendor/sheaf/chunks/chunk-ABCD1234.js');
      return {
        ok:
          entry === 'https://app.example/vendor/sheaf/' &&
          deeper === 'https://app.example/vendor/sheaf/chunks/' &&
          moduleDirectory(undefined) === '' &&
          moduleDirectory('') === '' &&
          moduleDirectory('not a url at all') === '',
        detail: `entry ${entry}, deeper ${deeper}`,
      };
    },
  },
  {
    /*
     * The consumer's half. `mount` is where a library consumer says where they put the package's
     * files, and it is worth knowing what it does and does not reach today: neither profile `mount`
     * offers draws a diagram, so nothing a consumer mounts asks for an asset at all. What this
     * asserts is that the option arrives, which is what the option is for and all it can be for
     * until a profile carries a construct that needs a file.
     */
    name: 'mount takes the directory the package files are served from',
    run: () => {
      clearBase();
      const el = document.createElement('div');
      document.body.appendChild(el);
      let surface: ReturnType<typeof mount> | null = null;
      try {
        surface = mount(el, { value: 'A paragraph.', profile: 'notes', assets: 'https://cdn.example/sheaf/0.3.0' });
        const base = assetBase();
        const url = assetUrl(MERMAID);
        return {
          ok: base === 'https://cdn.example/sheaf/0.3.0/' && url === `https://cdn.example/sheaf/0.3.0/${MERMAID}`,
          detail: `base ${base}, url ${url}`,
        };
      } finally {
        surface?.destroy();
        el.remove();
        clearBase();
      }
    },
  },
  {
    /*
     * A mount that says nothing. The default comes from this module's own address, which is
     * `undefined` in a CommonJS bundle, so the honest answer in a suite is that there is no base.
     * Asserting that rather than skipping it is what keeps the empty case from being read as the
     * option working: a scenario that only ever ran with `assets` set would pass with the default
     * path deleted.
     */
    name: 'a mount that says nothing leaves the base to whatever the build could offer, which in a CommonJS suite is nothing',
    run: () => {
      clearBase();
      const el = document.createElement('div');
      document.body.appendChild(el);
      let surface: ReturnType<typeof mount> | null = null;
      try {
        surface = mount(el, { value: 'A paragraph.', profile: 'notes' });
        const base = assetBase();
        return { ok: base === '', detail: `base ${JSON.stringify(base)}` };
      } finally {
        surface?.destroy();
        el.remove();
        clearBase();
      }
    },
  },
];
