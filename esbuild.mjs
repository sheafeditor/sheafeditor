import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * KaTeX is MIT licensed, which asks that its notice travel with it, so the
 * licence is copied next to the stylesheet and ships in the package.
 */
function copyKatexAssets() {
  const from = join(REPO, 'node_modules', 'katex');
  const fonts = join(REPO, 'media', 'katex-fonts');
  mkdirSync(fonts, { recursive: true });
  const css = readFileSync(join(from, 'dist', 'katex.min.css'), 'utf8').replaceAll('url(fonts/', 'url(katex-fonts/');
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
});

const contexts = [extensionCtx, webviewCtx, serverCtx, serverHostCtx];

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[esbuild] watching…');
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  console.log('[esbuild] build complete');
}
