/*
 * esbuild plugins both bundlers in this repository use.
 *
 * Shared because there are two: `esbuild.mjs` builds what ships, and `scripts/run-tests.mjs` bundles
 * each suite before running it. A plugin that changed what the product is made of and applied to only
 * one of them would make the suites test something nobody can install, which is the kind of
 * difference nothing else here would notice.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where `@codemirror/lang-markdown` reaches `@codemirror/lang-html`, and what it is given instead. */
const MARKDOWN = join('@codemirror', 'lang-markdown');
const STUB = join(REPO, 'src', 'webview', 'noEmbeddedHtml.ts');

/*
 * What the dependency has to look like for the redirect to mean what the comment says.
 *
 * One line in `@codemirror/lang-markdown`, and if it ever imports something else from
 * `@codemirror/lang-html` the stub will be missing that export and the failure will be a property
 * that is quietly `undefined` at run time rather than a build error. So the shape is asserted here,
 * where an upgrade that changes it stops the build and says so.
 */
const EXPECTED_IMPORT = "import { html, htmlCompletionSource } from '@codemirror/lang-html';";

/**
 * Give upstream's `markdown()` an HTML language that costs nothing, and only it.
 *
 * The whole reasoning is in `src/webview/noEmbeddedHtml.ts`, including why this is a resolve-time
 * redirect rather than a change to any call. In one line: a Markdown language that offers to parse
 * embedded HTML pulls three other languages into what every reader downloads before a document is
 * drawn, and Sheaf stopped calling that function.
 */
export const embeddedHtmlPlugin = {
  name: 'embedded-html',
  setup(build) {
    const upstream = join(REPO, 'node_modules', '@codemirror', 'lang-markdown', 'dist', 'index.js');
    if (existsSync(upstream)) {
      const src = readFileSync(upstream, 'utf8');
      if (!src.includes(EXPECTED_IMPORT)) {
        throw new Error(
          `@codemirror/lang-markdown no longer holds ${JSON.stringify(EXPECTED_IMPORT)}. ` +
            'Read what it imports from @codemirror/lang-html now and update src/webview/noEmbeddedHtml.ts to match, ' +
            'or drop this plugin and take the 139 KB back.'
        );
      }
    }
    build.onResolve({ filter: /^@codemirror\/lang-html$/ }, (args) => {
      if (!args.importer.includes(MARKDOWN)) return null;
      return { path: STUB };
    });
  },
};
