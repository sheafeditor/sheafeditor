import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const REPO = dirname(fileURLToPath(import.meta.url));

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
});

/** Webview bundle — runs in the browser sandbox of the custom editor webview. */
const webviewCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'media/webview.js',
  format: 'iife',
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
