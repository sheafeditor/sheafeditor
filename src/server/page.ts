/**
 * The two pages the local server serves.
 *
 * The editor page is the shell `getHtml()` builds for the VS Code webview, with
 * the same element ids and the same stylesheet, because the bundle that boots
 * into it is the same bundle. Anything that drifts between the two is a
 * difference between Sheaf in the editor and Sheaf in a tab, so the shell is
 * kept as close to a copy as the two hosts allow.
 *
 * What differs is where the scripts come from and what stands behind them. VS
 * Code addresses its own files through `asWebviewUri` and locks the page down
 * with a nonce; here everything is served from this origin, so the policy names
 * `'self'` instead, and `connect-src` is added because the host talks to the
 * server over fetch and an event stream rather than over `postMessage`.
 *
 * The boot data is a JSON script element rather than an inline script. Under
 * this policy an inline script would not run, and a JSON block cannot be one:
 * it is read with `textContent`, so a document whose name contains something
 * that looks like markup is inert on the page.
 */

/** Text that is safe between tags and inside a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * JSON that is safe inside a `<script type="application/json">`.
 *
 * Only `<` has to go: the parser ends the element at `</script`, and nothing
 * else in JSON can close it. Escaping it as `<` keeps the value identical
 * once parsed.
 */
function embeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const CSP = [
  `default-src 'none'`,
  `img-src 'self' https: data:`,
  `style-src 'self' 'unsafe-inline'`,
  `font-src 'self'`,
  `script-src 'self'`,
  `connect-src 'self'`,
].join('; ');

/** The editor, opened on one document. */
export function editorPage(file: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${CSP}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <!-- The theme first: webview.css resolves every colour through a variable
       this defines, and a variable with nothing behind it leaves the element
       transparent rather than falling back to anything. -->
  <link href="/media/browser-theme.css" rel="stylesheet" />
  <link href="/media/webview.css" rel="stylesheet" />
  <title>${escapeHtml(file)} · Sheaf</title>
</head>
<body>
  <div class="sheaf-app">
    <div id="toolbar" class="sheaf-toolbar" role="toolbar" aria-label="Formatting"></div>
    <div id="editor" class="sheaf-root"></div>
  </div>
  <script type="application/json" id="sheaf-boot">${embeddedJson({ file })}</script>
  <script src="/serve-host.js"></script>
  <script src="/media/webview.js"></script>
</body>
</html>`;
}

/**
 * The folder, as a list of its Markdown files.
 *
 * Deliberately plain. It is a way in to a document rather than a place to spend
 * any time, and it has to read the same whichever theme the browser is in, so it
 * carries its own few rules instead of the editor's stylesheet.
 */
export function indexPage(folder: string, files: string[]): string {
  const items = files
    .map((f) => `      <li><a href="/edit/${encodeURI(f)}">${escapeHtml(f)}</a></li>`)
    .join('\n');
  const body = files.length
    ? `    <ul>\n${items}\n    </ul>`
    : `    <p class="empty">No Markdown files in this folder.</p>`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${CSP}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <title>Sheaf</title>
  <style>
    :root { color-scheme: light dark; --ink: #1f2328; --dim: #656d76; --line: #d8dee4; --bg: #ffffff; }
    @media (prefers-color-scheme: dark) {
      :root { --ink: #e6edf3; --dim: #8b949e; --line: #30363d; --bg: #0d1117; }
    }
    body {
      margin: 0; padding: 48px 24px; background: var(--bg); color: var(--ink);
      font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    main { max-width: 708px; margin: 0 auto; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .folder { color: var(--dim); font-size: 13px; margin: 0 0 32px; word-break: break-all; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { border-top: 1px solid var(--line); }
    li:last-child { border-bottom: 1px solid var(--line); }
    a { display: block; padding: 10px 4px; color: inherit; text-decoration: none; }
    a:hover, a:focus-visible { background: color-mix(in srgb, var(--ink) 6%, transparent); }
    .empty { color: var(--dim); }
  </style>
</head>
<body>
  <main>
    <h1>Sheaf</h1>
    <p class="folder">${escapeHtml(folder)}</p>
${body}
  </main>
</body>
</html>`;
}
