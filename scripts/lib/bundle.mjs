/*
 * Build a CommonJS bundle of this checkout's own sources, for a script that has to call into
 * the editor to answer its question.
 *
 * **It exists because three scripts used to require a bundle somebody else had built**, under
 * `test/`, written by `scripts/run-tests.mjs`. A script that reads a prebuilt artefact measures
 * whatever that artefact holds, which on any machine where a suite has run is some earlier state
 * of `src/`. The failure is quiet and it is the worst shape a check can have: restore a base file,
 * re-run the script, and it prints the *fixed* table, because the bundle is minutes older than the
 * edit. The same source tree gives two opposite answers and the one that decides is a file nobody
 * looked at. A control whose edit never reaches the thing it measures is worse than no control,
 * because its pass gets written down as evidence.
 *
 * So every script in this family builds what it measures, in its own run, from `src/` and `test/`
 * as they are on disk. Measured on this machine, the build is 58 ms for the engine entry and 43 ms
 * for the prose one, against total run times of 0.38 s and 0.60 s. The bundles are around 3 MB
 * either way, because CodeMirror is most of them whatever is asked for, so asking for two exports
 * rather than the whole entry buys a little and the reason to do it is clarity about what is being
 * measured.
 *
 * Two details are not decoration:
 *
 *   - **`embeddedHtmlPlugin`.** Both bundlers that produce something a person runs use it:
 *     `esbuild.mjs` for what ships and `scripts/run-tests.mjs` for each suite. A script bundling
 *     without it measures a Markdown language nobody installs, so it is the default here and a
 *     caller has to ask for a bare build to get one.
 *   - **A temporary directory of this process's own.** Two runs sharing an output path means one
 *     esbuild writing the file while the other requires it, and the quiet half of that is a run
 *     reporting a green matrix about code from another checkout.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedHtmlPlugin } from '../esbuild-plugins.mjs';

/**
 * Build a CommonJS bundle exporting `exports`, a map of local name to the module path it comes
 * from, relative to the repository root. `@codemirror/...` and other package paths are passed
 * through as written. Several names from one module go in one key: `{ 'revealMap, drawMap':
 * 'test/engine.entry' }`.
 *
 * `name` only names the temporary directory, so a run that is being watched is recognisable.
 * `platform` is esbuild's, and defaults to the browser the editor is written for. `plugins`
 * defaults to the redirect both real bundlers apply; pass `[]` for a build that deliberately
 * leaves it out.
 *
 * Returns the path of the built bundle, for `createRequire`.
 */
export async function bundleExports(repo, exports, name, { platform = 'browser', plugins = [embeddedHtmlPlugin] } = {}) {
  const req = createRequire(join(repo, 'package.json'));
  const esbuild = req('esbuild');
  const out = mkdtempSync(join(tmpdir(), `sheaf-${name}-`));
  process.on('exit', () => {
    try {
      rmSync(out, { recursive: true, force: true });
    } catch {
      // A temporary directory that outlives the run costs disk and nothing else.
    }
  });
  const entry = join(out, 'entry.ts');
  const spec = (from) => JSON.stringify(from.startsWith('@') || !from.includes('/') ? from : join(repo, from));
  writeFileSync(
    entry,
    Object.entries(exports)
      .map(([names, from]) => `export { ${names} } from ${spec(from)};`)
      .join('\n') + '\n'
  );
  const bundle = join(out, 'bundle.cjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform,
    outfile: bundle,
    logLevel: 'warning',
    absWorkingDir: repo,
    nodePaths: [join(repo, 'node_modules')],
    plugins,
  });
  return bundle;
}
