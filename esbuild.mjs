import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log('[esbuild] watching…');
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  console.log('[esbuild] build complete');
}
