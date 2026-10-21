import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddedHtmlPlugin } from './scripts/esbuild-plugins.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const REPO = dirname(fileURLToPath(import.meta.url));

/*
 * The stamp that says which build this is, injected into the Node-side bundles
 * and read by src/buildStamp.ts.
 *
 * The environment comes first, and that is not a convenience: `package:clean`
 * and the release workflow both build from a `git archive` export, which has no
 * `.git` to ask, and those are precisely the builds somebody installs and then
 * wonders about. Whoever made the export knows the commit, so they pass it.
 *
 * A build that can answer neither says `unknown` rather than guessing. A build
 * from a tree with uncommitted changes says so, because its commit alone does
 * not describe what is running.
 */
function buildStamp() {
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
  const env = process.env;
  const commit = env.SHEAF_BUILD_COMMIT || git('rev-parse', '--short', 'HEAD') || 'unknown';
  const branch = env.SHEAF_BUILD_BRANCH || git('rev-parse', '--abbrev-ref', 'HEAD') || 'unknown';
  const dirty =
    env.SHEAF_BUILD_DIRTY !== undefined
      ? env.SHEAF_BUILD_DIRTY === '1'
      : commit !== 'unknown' && git('status', '--porcelain', '--untracked-files=no') !== '';
  return JSON.stringify({ version, commit, branch, dirty, builtAt: new Date().toISOString() });
}

const stamp = buildStamp();

/*
 * KaTeX's stylesheet and fonts, copied next to the webview so they load from
 * the extension itself.
 *
 * They cannot be part of the JavaScript bundle. A webview's content security
 * policy allows fonts from the extension and nowhere else, which rules out the
 * `data:` URIs an inlined stylesheet would need, and nothing may be fetched
 * from the network: a document has to typeset the same with no connection.
 * `media/webview.css` imports the stylesheet written here, and the paths in it
 * are rewritten so KaTeX's fonts sit in a directory with KaTeX's name on it.
 *
 * Only the WOFF2 fonts are copied. Every browser this extension runs in reads
 * WOFF2, and it is the first format each rule names, so the TrueType and WOFF
 * copies beside them would ship a megabyte nothing ever asks for.
 *
 * The stylesheet's references to those two formats are taken out with them. A
 * browser never follows them, because it takes the first format it reads, but a
 * library consumer's bundler resolves every `url()` in a stylesheet it imports,
 * and 40 references to files that are not there is 40 warnings on the first
 * build of the package. The build stops if a reference survives to a file that
 * was not copied, so a KaTeX upgrade that renames a font fails here rather than
 * in somebody else's build log.
 *
 * KaTeX is MIT licensed, which asks that its notice travel with it, so the
 * licence is copied next to the stylesheet and ships in the package.
 */
function copyKatexAssets() {
  const from = join(REPO, 'node_modules', 'katex');
  const fonts = join(REPO, 'media', 'katex-fonts');
  mkdirSync(fonts, { recursive: true });
  const css = readFileSync(join(from, 'dist', 'katex.min.css'), 'utf8')
    .replaceAll('url(fonts/', 'url(katex-fonts/')
    .replace(/,url\(katex-fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, '');
  const unshipped = [...css.matchAll(/url\(katex-fonts\/([^)]+)\)/g)].map((m) => m[1]).filter((f) => !f.endsWith('.woff2'));
  if (unshipped.length) {
    console.error(`[esbuild] katex.css still names ${unshipped.length} font(s) that are not copied: ${unshipped.slice(0, 3).join(', ')}`);
    process.exit(1);
  }
  writeFileSync(join(REPO, 'media', 'katex.css'), css);
  for (const file of readdirSync(join(from, 'dist', 'fonts'))) {
    if (file.endsWith('.woff2')) copyFileSync(join(from, 'dist', 'fonts', file), join(fonts, file));
  }
  copyFileSync(join(from, 'LICENSE'), join(REPO, 'media', 'katex-LICENSE.txt'));
}

copyKatexAssets();

/*
 * Mermaid, copied next to the webview as the module Mermaid publishes and the
 * chunks it imports, so a document with a diagram draws it with no connection.
 *
 * It is copied rather than bundled into `webview.js`. It is several megabytes, and
 * `src/webview/mermaid.ts` imports it only when a document holds a diagram, so a
 * document without one never parses a byte of it. The published build is already
 * split by diagram type and imports its chunks by relative path, so a pie chart
 * loads the pie chart's code and nothing else. Source maps stay behind.
 *
 * The folder is emptied first: chunk names carry a hash, and an upgrade would
 * otherwise leave the old version's chunks in the package beside the new ones.
 *
 * Mermaid is MIT licensed, so its notice travels with it, as KaTeX's does.
 */
function copyMermaidAssets() {
  const from = join(REPO, 'node_modules', 'mermaid', 'dist');
  const to = join(REPO, 'media', 'mermaid');
  rmSync(to, { recursive: true, force: true });
  mkdirSync(join(to, 'chunks', 'mermaid.esm.min'), { recursive: true });
  copyFileSync(join(from, 'mermaid.esm.min.mjs'), join(to, 'mermaid.esm.min.mjs'));
  for (const file of readdirSync(join(from, 'chunks', 'mermaid.esm.min'))) {
    if (file.endsWith('.mjs')) {
      copyFileSync(join(from, 'chunks', 'mermaid.esm.min', file), join(to, 'chunks', 'mermaid.esm.min', file));
    }
  }
  copyFileSync(join(REPO, 'node_modules', 'mermaid', 'LICENSE'), join(to, 'LICENSE.txt'));
}

copyMermaidAssets();

/** Shared options */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

/** Extension host bundle — runs in Node inside VS Code's extension host. */
const extensionCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  define: { __SHEAF_BUILD__: JSON.stringify(stamp) },
});

/*
 * The editor, split so that opening a document parses only what it needs.
 *
 * Built as modules with code splitting rather than as one script. The reason is
 * `@codemirror/language-data`, the registry that gives a fenced code block its
 * highlighting: every entry in it loads its own grammar with a dynamic import, and
 * a single-file build inlines all of them, so a document with no code in it still
 * parsed Angular, Vue, WAST, PHP and thirty more on every open. Split, the entry is
 * about a third of what it was and a grammar arrives when a fence asks for it.
 *
 * The chunks sit in `media/editor/` and are fetched the way mermaid's already are:
 * a module imported by a script carrying the nonce is fetched with that nonce, and
 * so are its own imports, which is what makes this work under the webview's policy
 * without widening it.
 *
 * The entry keeps the name `media/webview.js`, because that path is what the
 * extension's page, the local server's page and the website's demo all load, and
 * "the same bytes in every host" is easier to keep true when the name does not move.
 *
 * The folder is emptied first, for the reason the mermaid copy is: chunk names carry
 * a hash, so yesterday's chunks would otherwise pile up beside today's and ship.
 *
 * No build stamp here on purpose. The editor bundle is the same bytes in every
 * host, and a commit hash compiled into it would make that false while answering
 * a question the host it is embedded in can already answer.
 */
rmSync(join(REPO, 'media', 'editor'), { recursive: true, force: true });

/**
 * Where the webview's metafile goes: gitignored, and `.claude/**` is excluded from the package.
 *
 * Written from a plugin rather than from the build's result, because a watch build never returns one
 * and a check reading a metafile from the last one-shot build would be measuring an older tree while
 * saying nothing about it.
 */
const METAFILE = join(REPO, '.claude', 'scratch', 'webview-metafile.json');

/**
 * Write a build's metafile where a check can read it.
 *
 * One factory rather than a plugin per context: four builds now write one, because
 * `scripts/check-gate-tiers.mjs` reads each artefact's closure to audit the gate tiering, and four
 * copies of this would be four places for the directory to stop being created.
 */
const writeMetafile = (name, to) => ({
  name: `write-metafile-${name}`,
  setup(build) {
    build.onEnd((result) => {
      if (!result.metafile) return;
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, JSON.stringify(result.metafile));
    });
  },
});

const writeMetafilePlugin = writeMetafile('webview', METAFILE);

const webviewCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/webview/main.ts'],
  outdir: 'media',
  entryNames: 'webview',
  chunkNames: 'editor/[name]-[hash]',
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  /*
   * Which input went into which output, with byte counts, for `check-bundle-size.mjs`.
   *
   * Written by the build that ships rather than by a second build the check runs itself, which is
   * the point: a second build is a different build unless every option matches, and nothing would
   * say when they stopped matching. This way the check reads the bundle a consumer gets.
   *
   * The alternative that does not work is searching the output for a library's name. The entry holds
   * the string `mermaid` three times, in a dynamic import and two class names, with none of the
   * library in it; it holds `katex` three times, and all of KaTeX. A name tells you a library was
   * mentioned, and the question is whose bytes are in there.
   */
  metafile: true,
  plugins: [writeMetafilePlugin, embeddedHtmlPlugin],
});

/*
 * The library a consumer installs and imports, which is a different artifact from the page.
 *
 * Three entry points in one build with splitting on, and every part of that sentence is doing work:
 *
 * **Three entries, because the `exports` map names three.** `lib/index.js` is `mount`,
 * `lib/editor.js` is the editor it fetches on first focus, and `lib/render.js` is Markdown to HTML
 * with no editor in it.
 *
 * **One build, because `index.ts` reaches the editor by `import('./editor')` and `editor.ts` is an
 * entry point of the same build.** esbuild then points that dynamic import at `lib/editor.js`
 * rather than inventing a chunk for it, so the file the consumer's bundler fetches for the editor is
 * the file the map names.
 *
 * **Splitting on, because without it a dynamic import is inlined.** `splitting: false` would put
 * CodeMirror inside `lib/index.js`, and the claim this whole arrangement rests on — a mounted
 * surface is not an editor until it is focused — would be false while every test of it still passed.
 * `scripts/check-package.mjs` reads the metafile below and fails when `@codemirror/view` reaches
 * `lib/index.js`'s eager closure.
 *
 * Chunks go in `lib/chunks/`, and the `exports` map names that directory with a pattern, so the map
 * is a complete list of what the package can serve rather than a list of what it means to promise.
 *
 * `media/webview.css` and `media/browser-theme.css` are the other half of what a consumer loads and
 * are not built here: they are committed files, and the map names them.
 */
rmSync(join(REPO, 'lib'), { recursive: true, force: true });

/*
 * `lib/package.json`, saying the files under it are ES modules, and `lib/types/package.json`
 * saying the declarations are not.
 *
 * The root manifest has no `type`, so Node reads a bare `.js` as CommonJS, which is right for
 * `dist/extension.js` and `dist/serve.js` and wrong for everything here. Node loading `lib/index.js`
 * then fails to parse it as CommonJS, reparses it as a module and warns on every import. The warning
 * says to add `"type": "module"` to the root manifest, and that advice is wrong for this package:
 * VS Code's extension host loads `main` with `require`, and both `dist/` bundles are CommonJS, so the
 * extension would stop loading. A manifest inside `lib/` scopes the declaration to the directory
 * that needs it. It holds no `name` and no `exports`, so it does not become a package of its own,
 * and the `exports` map serves nothing at this path.
 *
 * The declarations need the opposite, and leaving them out would break a consumer's type check.
 * tsc writes their relative imports without extensions, which TypeScript accepts in a CommonJS
 * declaration and refuses in a module one under `moduleResolution: node16` or `nodenext`. Inside a
 * `type: module` directory they would be module declarations, so `lib/types/` keeps the format it
 * had before either file existed. `scripts/check-package.mjs` checks both, and imports the entries
 * in Node to read that the warning is gone.
 */
mkdirSync(join(REPO, 'lib', 'types'), { recursive: true });
writeFileSync(join(REPO, 'lib', 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
writeFileSync(join(REPO, 'lib', 'types', 'package.json'), `${JSON.stringify({ type: 'commonjs' })}\n`);

const LIB_METAFILE = join(REPO, '.claude', 'scratch', 'lib-metafile.json');
const writeLibMetafilePlugin = writeMetafile('lib', LIB_METAFILE);
const LIB_ENTRIES = ['src/lib/index.ts', 'src/lib/editor.ts', 'src/lib/render.ts'];

/*
 * Delete any chunk the library build wrote that no entry can reach.
 *
 * esbuild makes every `import()` target a split point while it scans, before tree shaking decides
 * which code survives. `src/webview/toolbar.ts` reaches the table widget through
 * `import('./tables.js')` from its insert-table menu, and the library entries keep part of the
 * toolbar but not that menu, so the importer is shaken out and the chunk it named is written anyway:
 * 131 kB of table widget in `lib/chunks/` that no file in `lib/` imports. The `exports` map serves
 * `./chunks/*`, so a file there is servable whether or not anything loads it.
 *
 * Reachability is read off the metafile's outputs, following static and dynamic imports alike from
 * the three entries, so a chunk reached only by `import()` (KaTeX, the emoji table) is kept. The
 * metafile on disk still lists what esbuild wrote, and the build log names what was removed.
 * `scripts/check-package.mjs` reads the files themselves and fails on a chunk nothing imports.
 */
const pruneUnreachedLibChunks = {
  name: 'prune-unreached-lib-chunks',
  setup(build) {
    build.onEnd((result) => {
      if (!result.metafile) return;
      const outputs = result.metafile.outputs;
      const reached = new Set();
      const queue = Object.keys(outputs).filter((o) => LIB_ENTRIES.includes(outputs[o].entryPoint));
      while (queue.length) {
        const o = queue.pop();
        if (reached.has(o) || !outputs[o]) continue;
        reached.add(o);
        for (const i of outputs[o].imports) if (!i.external) queue.push(i.path);
      }
      for (const o of Object.keys(outputs)) {
        if (reached.has(o) || o.endsWith('.map')) continue;
        // Metafile paths are relative to the build's working directory, as `outdir` is.
        const at = join(build.initialOptions.absWorkingDir ?? process.cwd(), o);
        rmSync(at, { force: true });
        rmSync(`${at}.map`, { force: true });
        console.log(`[esbuild] removed ${o} (${outputs[o].bytes} bytes): no library entry imports it`);
      }
    });
  },
};

const libCtx = await esbuild.context({
  ...common,
  entryPoints: LIB_ENTRIES,
  outdir: 'lib',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  metafile: true,
  plugins: [writeLibMetafilePlugin, pruneUnreachedLibChunks],
});

/**
 * Local server bundle — the `sheaf serve` command, run by Node from a terminal.
 *
 * It ships in the package rather than being a development-only script: the point
 * of it is to open a project's Markdown in a browser on a machine where Sheaf is
 * installed, which is a thing a person does with the extension they installed,
 * not with a checkout of the repository.
 */
const serverCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/serve.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  // The bundle is also the `sheaf` command, so it has to be runnable on its own.
  // The line goes in here rather than at the top of the source, where TypeScript
  // and the bundler each have their own opinion about what to do with it.
  banner: { js: '#!/usr/bin/env node' },
  define: { __SHEAF_BUILD__: JSON.stringify(stamp) },
  /*
   * Which sources this bundle holds, for `scripts/check-gate-tiers.mjs`. Six browser-driven gates
   * load their page from this server, so what it is built from decides whether a change to
   * `src/server/` has to run them, and that set is read from the build rather than listed by hand.
   */
  metafile: true,
  plugins: [writeMetafile('serve', join(REPO, '.claude', 'scratch', 'serve-metafile.json'))],
});

/**
 * The local server's host shim, which runs in the browser tab.
 *
 * Loaded before `media/webview.js` and does one thing: define the
 * `acquireVsCodeApi()` global the editor bundle calls at module scope. It sits
 * in `dist/` with the server it belongs to rather than in `media/`, which is
 * what the webview loads from inside VS Code.
 */
const serverHostCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/server/host.ts'],
  outfile: 'dist/serve-host.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  // The other half of what a browser-driven gate loads, and read for the same reason as above.
  metafile: true,
  plugins: [writeMetafile('serve-host', join(REPO, '.claude', 'scratch', 'serve-host-metafile.json'))],
});

const contexts = [extensionCtx, webviewCtx, libCtx, serverCtx, serverHostCtx];

/*
 * The library's type declarations, which esbuild cannot produce: it strips types without reading
 * them. So the one build that produces the package produces both halves of it, rather than leaving
 * the declarations to a separate script somebody has to remember.
 *
 * It is part of the build rather than part of the gates' type check because an `exports` map whose
 * `types` condition points at a file the build did not write is a package that resolves for its
 * author and for nobody else, which is the one failure `pkg.build` R4 is about.
 *
 * Skipped in watch mode: a declaration run per keystroke costs more than it is worth, and nothing a
 * watch build serves reads them.
 */
function buildDeclarations() {
  const tsc = join(REPO, 'node_modules', '.bin', 'tsc');
  const r = spawnSync(tsc, ['-p', join(REPO, 'tsconfig.lib.json')], { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[esbuild] the library declarations did not compile, so the package has no types');
    process.exit(r.status ?? 1);
  }
}

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[esbuild] watching…');
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  buildDeclarations();
  console.log('[esbuild] build complete');
}
