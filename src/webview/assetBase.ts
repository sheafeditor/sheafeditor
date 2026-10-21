/*
 * Where the editor's own files are, said by whoever is hosting it.
 *
 * The editor is not one file. It is a directory: the split chunks, the emoji table, KaTeX's module,
 * KaTeX's stylesheet and the 20 fonts that stylesheet names, and the diagram library. Everything but
 * the last is found with nothing here having an opinion about it, by two mechanisms that are already
 * independent of how anybody builds. The chunks, the emoji table and KaTeX's module are reached by
 * relative module specifier, which the browser resolves against the address of the module doing the
 * importing. The stylesheet and its fonts are reached by relative `url()` out of CSS, which the
 * browser resolves against the stylesheet. The diagram library is the exception: it is copied in as
 * the module Mermaid publishes rather than bundled, so the build writes no import for it and some
 * code here has to build its address.
 *
 * **That address used to be read off the page**, by finding a `<link>` whose href contained the
 * string `webview.css` and resolving against it. It worked in every host in this repository,
 * because every one of them writes that tag itself. What it could not survive is somebody else's
 * build: a hashed filename (`webview.a3f2c1.css`) does not contain the substring, an inlined
 * stylesheet leaves no `<link>` at all, and a concatenated one leaves a `<link>` carrying the
 * application's own name. In each case the address came out empty and every diagram on the page
 * said the editor did not know where its files were, with nothing in a request log or a console to
 * say why. **It is not that most builds break it.** A cache-busted `webview.css?v=123` still holds
 * the substring and still works. It is that whether it works at all is decided by a consumer's CSS
 * pipeline, which is a thing a library has no business depending on.
 *
 * So the base is declared instead of discovered, and there are two ways to declare it because there
 * are two kinds of caller:
 *
 * - `setAssetBase` is a host or a consumer saying where it put the files. It wins, and it is the
 *   escape hatch for serving them from somewhere other than beside the code: another origin, a CDN,
 *   a path a CSS pipeline chose.
 * - `setAssetBaseDefault` is an entry point offering its own directory, from `import.meta.url`. It
 *   is a fallback and never overwrites the first, which is what keeps one mount's default from
 *   taking away another's explicit answer.
 *
 * **An entry point is the only place `import.meta.url` answers this question**, and that is worth
 * knowing before moving the call. Both builds split, so the module that resolves the diagram
 * library's address lands in a chunk (`media/editor/chunk-*.js` and `lib/chunks/chunk-*.js`), one
 * directory below the files it is looking for. Read there, `import.meta.url` is available and wrong.
 * Read in `src/webview/main.ts` it is `media/webview.js`, so the directory is `media/`, which is
 * where the assets sit; read in `src/lib/index.ts` it is `lib/index.js`, so the directory is `lib/`,
 * which is where that package's chunks sit.
 *
 * The base is module state rather than per-mount state, which is the same shape as every other
 * thing a host tells the editor here (`setResourceBaseUri`, `setClipboardHost`, `setMermaidLoader`).
 * Two surfaces on one page serving their files from two different directories is not supported, and
 * `MountOptions.assets` says so.
 */

/** What a host or a consumer said. Empty until one does. */
let declared = '';
/** What an entry point offered from its own address. Used only when nothing was declared. */
let fallback = '';

/**
 * A directory, with the trailing slash a URL resolution needs.
 *
 * Added rather than required, because leaving it off is the ordinary mistake and the cost of it is
 * silent: `new URL('mermaid/x.mjs', 'https://cdn/sheaf')` drops `sheaf` and asks the wrong origin
 * root for the file. Nothing refuses it and the only symptom is a 404 for a path nobody wrote.
 */
function directory(url: string | undefined): string {
  if (!url) return '';
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Say where the editor's files are served from.
 *
 * Takes the **directory** holding them, not a file inside it. A value with no trailing slash gets
 * one. An empty value clears what was said, which is what a consumer unmounting the last surface
 * would want if they ever needed to.
 */
export function setAssetBase(url: string | undefined): void {
  declared = directory(url);
}

/**
 * Offer a directory for when nothing has been declared. For an entry point, from `import.meta.url`.
 *
 * `undefined` is an ordinary answer rather than a caller's mistake: a build whose output format has
 * no module URL has none to offer, and the suites are exactly that, bundled as CommonJS.
 */
export function setAssetBaseDefault(url: string | undefined): void {
  fallback = directory(url);
}

/** Where the editor's files are, as a directory URL, or '' when nobody has said. */
export function assetBase(): string {
  return declared || fallback;
}

/**
 * The directory holding a module, given that module's own `import.meta.url`.
 *
 * One definition rather than a line at each entry point, because both halves of it are easy to leave
 * out and expensive to leave out.
 *
 * **The conversion is load-bearing, and not for the obvious reason.** `new URL('mermaid/x',
 * '.../media/webview.js')` answers `.../media/mermaid/x` on its own, because URL resolution replaces
 * a base's last segment, so reading this as a tidy-up is easy. What a module URL is actually handed
 * to is `setAssetBaseDefault`, which appends the trailing slash a directory needs, and
 * `.../media/webview.js/` is a directory nothing is served from. The two steps only compose in this
 * order, and doing the conversion here is what puts them in it.
 *
 * The guard is the `undefined`: a CommonJS output has no module URL, the suites are built that way,
 * and `new URL('.', undefined)` does not return an empty answer, it throws `Invalid URL`. Unguarded
 * at an entry point that is the first thing to run, that is the editor failing to boot rather than a
 * diagram failing to draw.
 *
 * Both halves were taken out together and each was caught by a scenario of its own: the conversion by
 * one that reads the directory back, the guard by one that mounts with nothing declared. The second
 * took 63 other scenarios with it, 65 of the prose suite's 674 in all, which is every one that mounts
 * a surface.
 */
export function moduleDirectory(moduleUrl: string | undefined): string {
  if (!moduleUrl) return '';
  try {
    return new URL('.', moduleUrl).href;
  } catch {
    return '';
  }
}

/**
 * The address of one of the editor's own files, or '' when there is no base to resolve it against.
 *
 * `path` is relative to the base and must stay that way: a caller passing an absolute URL would be
 * asking for a file this function has no part in finding.
 */
export function assetUrl(path: string): string {
  const base = assetBase();
  if (!base) return '';
  try {
    return new URL(path, base).href;
  } catch {
    // A base that is a path rather than a URL, `/assets/sheaf/`, which `new URL` cannot take as a
    // base on its own. Joining the two by hand keeps it a path, which is what the page wants back:
    // an absolute path resolves against the page's own origin, and that is where it was served from.
    return base.startsWith('/') ? base + path.replace(/^\.?\//, '') : '';
  }
}
