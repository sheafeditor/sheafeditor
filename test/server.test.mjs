/*
 * The local server: what it serves, what it refuses, and what ends up in the file.
 *
 * Every check runs against a real server listening on loopback, over a folder
 * built in a temporary directory. A stand-in for the HTTP layer would not be
 * worth much here, because most of what this code does is decide whether to
 * answer a request at all, and those decisions read headers and URLs that only
 * exist once something has actually been sent.
 *
 * The write checks are the ones to keep honest. A browser tab posts the whole
 * document after every keystroke, and the thing that must never happen is the
 * file being rewritten from that text: a document with mixed line endings would
 * come back normalised, and every line of it would show up in a diff. So the
 * checks look at the bytes on disk afterwards, including a lone carriage return
 * that nothing on the round trip is allowed to touch.
 */

import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  resolveInside,
  resolveAddress,
  stripJsonc,
  readConfig,
  DEFAULT_CONFIG,
  createSheafServer,
  hostIsLoopback,
  originIsOurs,
  escapeHtml,
  parseArgs,
} = createRequire(import.meta.url)('./server.bundle.cjs');

/** The extension's own directory, which is this checkout. */
const ASSET_ROOT = join(import.meta.dirname, '..');

/* --- A folder and a server for one check ------------------------------------ */

/**
 * Build a folder, serve it, hand it to `body`, then take it all down.
 *
 * `files` is a map of relative path to contents. Anything the check writes
 * afterwards it writes itself, so a check that is about an outside change can
 * make one.
 */
async function serving(files, body, assetRoot = ASSET_ROOT) {
  // Real path, because the checks compare what the server resolves against what
  // they built, and a temporary directory on macOS is reached through a link.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sheaf-serve-')));
  for (const [rel, text] of Object.entries(files)) {
    const target = join(root, rel);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, text, 'utf8');
  }
  const server = createSheafServer({ root, assetRoot });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    return await body({
      root,
      origin,
      /** A request carrying what a tab of ours carries. */
      get: (path, init) => fetch(origin + path, { headers: { 'x-sheaf-local': '1' }, ...init }),
      /** A JSON POST, as the host shim sends one. */
      post: (path, value) =>
        fetch(origin + path, {
          method: 'POST',
          headers: { 'x-sheaf-local': '1', 'content-type': 'application/json' },
          body: JSON.stringify(value),
        }),
      read: (rel) => readFile(join(root, rel), 'utf8'),
      /**
       * A request built by hand.
       *
       * `fetch` will not set a Host header and normalises `..` out of a path
       * before it sends, so the two things most worth checking cannot be asked
       * for through it. This sends the bytes as given.
       */
      raw: (path, headers = {}) =>
        new Promise((accept, reject) => {
          const req = request(
            { host: '127.0.0.1', port, path, method: 'GET', headers: { 'x-sheaf-local': '1', ...headers } },
            (res) => {
              res.resume();
              res.on('end', () => accept({ status: res.statusCode }));
            }
          );
          req.on('error', reject);
          req.end();
        }),
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
}

/** Wait for something to become true, up to a second. */
async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/**
 * The event *name* and text of one document frame from the stream, or null if none arrives.
 *
 * Separate from `firstSetContent`, which returns the text alone, because the name is where the
 * flag lives: every `data:` line of the frame is a line of the person's document, so there is
 * nowhere in the body to put a flag they could not also have typed.
 */
async function firstDocumentFrame(origin, path, trigger) {
  const control = new AbortController();
  const res = await fetch(`${origin}/api/events?path=${encodeURIComponent(path)}`, {
    headers: { 'x-sheaf-local': '1' },
    signal: control.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = setTimeout(() => control.abort(), 4000);
  await trigger();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const name = block.split('\n', 1)[0];
        if (!name.startsWith('event: ')) continue;
        return {
          event: name.slice('event: '.length),
          text: block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice('data: '.length)).join('\n'),
        };
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
    control.abort();
  }
}

/**
 * Up to `want` frames from the stream, and whatever arrived before the wait ran out.
 *
 * One write can produce two frames — the document, then the words to say about it — so a reader
 * that stops at the first cannot see the pair, and one that waits for both cannot tell "the
 * second never came" from "the second is not supposed to come". Returning what arrived makes
 * both of those an assertion about a count.
 */
async function documentFrames(origin, path, want, trigger) {
  const control = new AbortController();
  const res = await fetch(`${origin}/api/events?path=${encodeURIComponent(path)}`, {
    headers: { 'x-sheaf-local': '1' },
    signal: control.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const found = [];
  let buffer = '';
  // Long enough that a frame which is coming has arrived, short enough that a check asserting
  // one did not come costs a second rather than the whole suite's patience.
  const deadline = setTimeout(() => control.abort(), 1200);
  await trigger();
  try {
    while (found.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const name = block.split('\n', 1)[0];
        if (!name.startsWith('event: ')) continue;
        found.push({
          event: name.slice('event: '.length),
          text: block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice('data: '.length)).join('\n'),
        });
      }
    }
  } catch {
    // The deadline, which is how a check that expects fewer frames than `want` ends.
  } finally {
    clearTimeout(deadline);
    control.abort();
  }
  return found;
}

/** The text of one `setContent` from the event stream, or null if none arrives. */
async function firstSetContent(origin, path, trigger) {
  const control = new AbortController();
  const res = await fetch(`${origin}/api/events?path=${encodeURIComponent(path)}`, {
    headers: { 'x-sheaf-local': '1' },
    signal: control.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = setTimeout(() => control.abort(), 4000);
  await trigger();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (!block.startsWith('event: setContent')) continue;
        return block
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .join('\n');
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
    control.abort();
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* --- The checks -------------------------------------------------------------- */

const cases = [
  /*
   * Which build served the page. A browser tab has no Extensions pane to consult,
   * so the footer is the only place the question can be answered there.
   */

  ['the folder page names the build in its footer, and escapes what it puts there', () =>
    serving({ 'a.md': '# A' }, async ({ get }) => {
      const html = await (await get('/')).text();
      // The stamp run-tests.mjs compiles in, so this reads the real path through
      // buildStamp.ts rather than its fallback.
      const inside = html.match(/<footer>([\s\S]*?)<\/footer>/)?.[1] ?? null;
      const named = inside !== null && inside.includes('Sheaf 0.2.0') && inside.includes('abc1234') && inside.includes('a browser tab');
      // Whatever a stamp holds arrives inside an element, so it goes through the same
      // escaping as a file name rather than being trusted for being ours. Read from
      // the footer's own text: reaching past the closing tag finds the next element's
      // bracket and says nothing, which is how the first draft of this failed.
      return named && !/[<>]/.test(inside);
    })],

  /* The boundary, which is what keeps a link in a document from reaching the disk. */

  ['a path climbing out of the folder is not resolved', () =>
    serving({ 'a.md': '# A' }, async ({ root }) =>
      resolveInside(root, '../secret.md') === null && resolveInside(root, 'notes/../../secret.md') === null
    )],

  ['a path in a dot directory is not resolved', () =>
    serving({ 'a.md': '# A' }, async ({ root }) =>
      resolveInside(root, '.git/config') === null &&
      resolveInside(root, 'docs/.git/HEAD') === null &&
      resolveInside(root, '.env') === null
    )],

  ['an absolute path is not resolved', () =>
    serving({ 'a.md': '# A' }, async ({ root }) => resolveInside(root, '/etc/passwd') === null)],

  ['a path inside the folder is resolved', () =>
    serving({ 'notes/a.md': '# A' }, async ({ root }) => resolveInside(root, 'notes/a.md') === join(root, 'notes/a.md'))],

  ['a document above the folder is refused over HTTP', () =>
    serving({ 'a.md': '# A' }, async ({ get, raw }) => {
      // Written plainly, the dot segments are resolved away while the URL is
      // parsed, so the request lands on a route that does not exist. Written
      // encoded, they survive parsing and reach the path check, which is the
      // one that has to refuse them.
      const plain = await raw('/edit/../../etc/passwd');
      const encoded = await raw('/edit/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
      const file = await raw('/file/..%2f..%2fetc%2fpasswd');
      const api = await get('/api/doc?path=../../etc/passwd');
      return plain.status === 404 && encoded.status === 403 && file.status === 403 && api.status === 403;
    })],

  ['a document under .git is refused over HTTP', () =>
    serving({ 'a.md': '# A', '.git/config': 'secret' }, async ({ get }) => {
      const res = await get('/api/doc?path=.git/config');
      return res.status === 403;
    })],

  /*
   * The spellings.
   *
   * The checks above ask whether the boundary holds. These ask whether it holds
   * when the same request is written a different way, which is where a path
   * check is usually wrong: one spelling is refused by the resolver, another is
   * resolved away by the URL parser before it ever arrives, and a third is a
   * filename that merely looks like an escape. Each lands somewhere different,
   * and a check that only knows the first would pass while the others went
   * untried.
   *
   * `/file/` is the route to ask on, because it serves bytes off disk for the
   * images in a document rather than a document through the editor, so a path
   * that got through would be handed over as-is.
   */

  ['a real file inside the folder is served', () =>
    serving({ 'notes/shot.txt': 'inside' }, async ({ get }) => {
      const res = await get('/file/notes/shot.txt');
      return res.status === 200 && (await res.text()) === 'inside';
    })],

  /*
   * An SVG is the one type served from here that a browser treats as a document
   * able to hold script, and everything under `/file/` came out of somebody's
   * project: a repository cloned from anywhere, a picture a designer sent. This
   * origin also answers `/api/doc`, which writes a file, so an SVG opened as a
   * page rather than drawn into an `<img>` would be script sitting next to the
   * write endpoint. Whether a link in a document can navigate there today is a
   * separate question from whether the bytes should be able to do anything if it
   * can, and this is the answer to the second one.
   *
   * The policy has to forbid script and leave the document no origin of ours.
   * `sandbox` gives it an origin of its own, so a fetch it makes is cross-origin
   * to this server and arrives without the header the API requires.
   */
  /*
   * The page's own policy, which is the boundary in this host the way the webview's is in
   * VS Code. A document can put inline HTML, an image address and table cells drawn as
   * HTML onto this page, and what stops any of it from running as code is this one string
   * in `page.ts`. Nothing asked what it said until now, so widening it was a one-word edit
   * that every gate would have passed.
   *
   * Two directives read differently here than in the extension, for reasons rather than by
   * accident, and the check has to allow exactly that much. `script-src 'self'` rather than
   * a nonce, because the page loads its scripts as files from this server. And `connect-src
   * 'self'` is present, where in VS Code there is none at all: this page has to reach
   * `/api/doc` to read and write the document. `'self'` is the whole of what it may reach,
   * which is what keeps the editor from carrying a document anywhere else.
   */
  ['the editor page allows script only from this server, and connections only to it', () =>
    serving({ 'a.md': '# A' }, async ({ get }) => {
      const html = await (await get('/edit/a.md')).text();
      const tag = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(html)?.[0];
      const csp = tag ? /content="([^"]*)"/.exec(tag)?.[1] : undefined;
      if (!csp) throw new Error(`no Content-Security-Policy in the ${html.length}-character page: this check is proving nothing`);
      const directive = (name) => new RegExp(`(?:^|;)\\s*${name}\\s([^;]*)`).exec(csp)?.[1]?.trim();
      const wrong = [];
      if (directive('default-src') !== `'none'`) wrong.push(`default-src is "${directive('default-src')}" rather than 'none'`);
      if (directive('script-src') !== `'self'`) wrong.push(`script-src is "${directive('script-src')}" rather than 'self' alone`);
      if (directive('connect-src') !== `'self'`) wrong.push(`connect-src is "${directive('connect-src')}", so the page may reach somewhere other than this server`);
      const img = directive('img-src') ?? '';
      for (const bad of ['http:', '*', `'unsafe-inline'`]) if (img.includes(bad)) wrong.push(`img-src allows ${bad}`);
      if (wrong.length) throw new Error(wrong.join('; '));
      return true;
    })],

  ['an SVG is served with a policy that forbids script, since this origin also writes files', () =>
    serving({ 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>' }, async ({ get }) => {
      const res = await get('/file/logo.svg');
      const policy = res.headers.get('content-security-policy') ?? '';
      // A boolean, because this runner takes anything truthy as a pass and an
      // object reporting `ok: false` would sail through saying nothing.
      if (res.status !== 200) throw new Error(`the SVG came back ${res.status}`);
      if (!policy) throw new Error('no content-security-policy on the response, so script inside the SVG runs on this origin');
      if (!/sandbox/.test(policy) || !/default-src 'none'/.test(policy)) {
        throw new Error(`policy is "${policy}", which does not both sandbox the document and forbid its fetches`);
      }
      return true;
    })],

  ['a picture that cannot hold script is left alone, so the policy is not a blanket', () =>
    serving({ 'shot.png': 'not really a png' }, async ({ get }) => {
      const res = await get('/file/shot.png');
      return res.status === 200 && res.headers.get('content-security-policy') === null;
    })],

  ['every spelling of a path climbing out of the folder is refused', () =>
    serving({ 'a.md': '# A', 'notes/b.md': '# B' }, async ({ raw }) => {
      /*
       * Each of these proves a different thing, which is worth knowing before
       * deciding one of them is redundant.
       *
       * The plain spelling proves the router. It never reaches the resolver at
       * all, so it would pass whatever the resolver did, and a suite that had
       * only this one would report the class covered while the check that
       * matters went untried. It is the weakest of the three and it is here for
       * the day URL parsing changes under us.
       *
       * The encoded spelling is the one that proves the resolver, because it
       * survives parsing intact and arrives as a path to be refused.
       *
       * The double-encoded spelling proves neither today. It is here to catch a
       * decode loop if anybody ever adds one: decode twice and it becomes the
       * encoded case, which by then would already be past the router.
       */
      const asked = {
        // Resolved away while the URL is parsed, so it lands on no route.
        '/file/../outside.md': 404,
        '/file/notes/../../outside.md': 404,
        // Survives parsing and reaches the path check, which refuses it.
        '/file/..%2Foutside.md': 403,
        // Decoded once, so what arrives is a filename with percent signs in it
        // rather than an escape. Nothing by that name exists.
        '/file/%252e%252e%252foutside.md': 404,
        // An absolute path wearing the route as a prefix.
        '/file//etc/hosts': 403,
        // A dot directory, refused as a class rather than by name.
        '/file/.git/config': 403,
      };
      const got = {};
      for (const path of Object.keys(asked)) got[path] = (await raw(path)).status;
      const wrong = Object.keys(asked).filter((path) => got[path] !== asked[path]);
      if (wrong.length) console.log(`   ${wrong.map((p) => `${p}: ${got[p]} not ${asked[p]}`).join(', ')}`);
      return wrong.length === 0;
    })],

  ['a symbolic link pointing out of the folder is refused, though its name is innocent', () =>
    serving({ 'a.md': '# A' }, async ({ get, root }) => {
      // The name gives nothing away and the path never leaves the folder. What
      // leaves is the file it resolves to, which is why the check is on the real
      // path rather than on the name.
      await symlink('/etc/hosts', join(root, 'link-out.md'));
      const file = await get('/file/link-out.md');
      const doc = await get('/api/doc?path=link-out.md');
      return file.status === 403 && doc.status === 403;
    })],

  /* Who is allowed to ask. */

  ['the browser\'s own account of where a request came from is believed, and refused when it is elsewhere', () =>
    serving({ 'a.md': '# A' }, async ({ raw }) => {
      // Set by the browser rather than by the page, so a page cannot spell it
      // differently. `same-site` is refused as well as `cross-site`: another
      // port on localhost is the same site and a different origin, and this
      // server answers to one origin.
      const asked = { 'cross-site': 403, 'same-site': 403, 'same-origin': 200, none: 200 };
      const got = {};
      for (const site of Object.keys(asked)) got[site] = (await raw('/', { 'sec-fetch-site': site })).status;
      // Nothing sends it from a terminal, and a request with no such header at
      // all is not a browser making a claim, so it is left alone.
      const bare = await raw('/');
      const wrong = Object.keys(asked).filter((site) => got[site] !== asked[site]);
      if (wrong.length) console.log(`   ${wrong.map((s) => `${s}: ${got[s]} not ${asked[s]}`).join(', ')}`);
      return wrong.length === 0 && bare.status === 200;
    })],

  /*
   * `Referer` is deliberately not one of these, and a check that a foreign one
   * is refused would be wrong rather than missing.
   *
   * A page can set `Referer` to whatever it likes, and can suppress it
   * entirely, so refusing on it would stop nothing and would break an ordinary
   * request that happens to carry one. `Sec-Fetch-Site` is the header for this
   * because the browser writes it and the page cannot reach it. Sending what a
   * browser cannot send is testing a threat that does not exist.
   *
   * The general shape, which is the part worth carrying to the next header:
   * writing a check from what an attacker might send produces a test of the
   * page talking about itself. The question that decides whether a header is
   * worth anything is what the browser sends and the page cannot change.
   */

  ['a request carrying this server\'s own origin is served', () =>
    serving({ 'a.md': '# A' }, async ({ origin }) => {
      const res = await fetch(`${origin}/api/doc?path=a.md`, {
        headers: { 'x-sheaf-local': '1', origin },
      });
      return res.status === 200;
    })],

  ['a Host header naming anything but loopback is refused', () =>
    serving({ 'a.md': '# A' }, async ({ raw }) => {
      // A name on the internet pointed at 127.0.0.1 is how a page elsewhere
      // reaches a local server as though it were its own.
      const res = await raw('/', { host: 'sheaf.example.com' });
      const doc = await raw('/api/doc?path=a.md', { host: 'sheaf.example.com' });
      return res.status === 403 && doc.status === 403;
    })],

  ['loopback names are accepted as the Host', () =>
    hostIsLoopback({ headers: { host: 'localhost:7432' } }) &&
    hostIsLoopback({ headers: { host: '127.0.0.1:7432' } }) &&
    hostIsLoopback({ headers: { host: '[::1]:7432' } }) &&
    !hostIsLoopback({ headers: { host: 'evil.test' } }) &&
    !hostIsLoopback({ headers: {} })],

  ['a request from another origin is refused', () =>
    serving({ 'a.md': '# A' }, async ({ origin }) => {
      const res = await fetch(`${origin}/api/doc?path=a.md`, {
        headers: { 'x-sheaf-local': '1', origin: 'https://evil.test' },
      });
      return res.status === 403;
    })],

  ['an origin check passes for this server and fails for another', () =>
    originIsOurs({ headers: { origin: 'http://localhost:7432', host: 'localhost:7432' } }) &&
    !originIsOurs({ headers: { origin: 'http://localhost:9999', host: 'localhost:7432' } }) &&
    !originIsOurs({ headers: { origin: 'https://evil.test', host: 'localhost:7432' } }) &&
    originIsOurs({ headers: { host: 'localhost:7432' } })],

  ['an API request without the local header is refused', () =>
    serving({ 'a.md': '# A' }, async ({ origin }) => {
      const res = await fetch(`${origin}/api/doc?path=a.md`);
      return res.status === 403;
    })],

  /* Opening a document. */

  ['opening a document returns its text, its name and where its images resolve from', () =>
    serving({ 'notes/a.md': '# A\n\nBody.\n' }, async ({ get }) => {
      const res = await get('/api/doc?path=notes/a.md');
      const doc = await res.json();
      return (
        res.status === 200 &&
        doc.text === '# A\n\nBody.\n' &&
        doc.fileName === 'notes/a.md' &&
        doc.resourceBaseUri.endsWith('/file/notes/')
      );
    })],

  ['the folder’s documents are listed for completing a link, in the form a link is written in', () =>
    serving(
      {
        'a.md': '# A',
        'notes/b.md': '# B',
        'notes/c.txt': 'plain',
        'node_modules/d.md': '# not this',
        '.hidden/e.md': '# nor this',
      },
      async ({ get }) => {
        // The page asks for this when somebody types a link's `(`, and the editor waits
        // 1.5 seconds before offering only the current document's headings, so the route
        // not existing cost a pause and then nothing. Relative POSIX form, because that is
        // what a link is written in and what the editor's own matching expects.
        const res = await get('/api/files');
        const files = (await res.json()).files ?? [];
        return (
          res.status === 200 &&
          files.includes('a.md') &&
          files.includes('notes/b.md') &&
          files.includes('notes/c.txt') &&
          !files.some((f) => f.startsWith('node_modules/')) &&
          !files.some((f) => f.includes('.hidden'))
        );
      }
    )],

  ['opening a document says this host has no terminal, by the value and not merely the field', () =>
    serving({ 'a.md': '# A' }, async ({ get }) => {
      const doc = await (await get('/api/doc?path=a.md')).json();
      // What makes the menu drop Send to terminal is `false`, not the presence
      // of a key, so that is what is pinned. The editor's own host sends no
      // capabilities at all, which the host suite pins from the other side.
      return doc.capabilities?.terminal === false;
    })],

  ['a document is handed over with its line endings written as newlines', () =>
    serving({ 'a.md': 'one\r\ntwo\r\n' }, async ({ get }) => {
      const doc = await (await get('/api/doc?path=a.md')).json();
      return doc.text === 'one\ntwo\n';
    })],

  ['the folder settings reach the editor', () =>
    serving(
      { 'a.md': '# A', '.vscode/settings.json': '{\n  // width\n  "sheaf.contentWidth": "900px",\n}\n' },
      async ({ get }) => {
        const doc = await (await get('/api/doc?path=a.md')).json();
        return doc.config.contentWidth === '900px' && doc.config.doubleClickToEditSource === false;
      }
    )],

  ['a settings file that cannot be parsed leaves the defaults standing', () =>
    serving({ 'a.md': '# A', '.vscode/settings.json': '{ this is not json' }, async ({ get }) => {
      const doc = await (await get('/api/doc?path=a.md')).json();
      return doc.config.contentWidth === '708px';
    })],

  ['nothing a tab does writes the project\'s settings file', () =>
    serving({ 'a.md': '# A\n', '.vscode/settings.json': '{"sheaf.tableOfContents": false}' }, async ({ get, post, read, origin }) => {
      // The toolbar's table-of-contents button is a settings change in VS Code.
      // Here it applies to the tab, because a button press is a poor reason to
      // edit a file somebody has checked in. So there is no endpoint that
      // writes settings, and editing a document must not reach that file
      // either.
      const before = await read('.vscode/settings.json');
      await get('/api/doc?path=a.md');
      await post('/api/doc', { path: 'a.md', text: '# A changed\n' });
      await until(async () => (await read('a.md')) === '# A changed\n');
      const attempts = await Promise.all([
        post('/api/settings', { tableOfContents: true }),
        post('/api/config', { tableOfContents: true }),
        post('/api/doc', { path: '.vscode/settings.json', text: '{"sheaf.tableOfContents": true}' }),
      ]);
      const refused = attempts.every((res) => res.status >= 400);
      return refused && (await read('.vscode/settings.json')) === before;
    })],

  ['a missing document is a 404 rather than a blank editor', () =>
    serving({ 'a.md': '# A' }, async ({ get }) => (await get('/api/doc?path=gone.md')).status === 404)],

  /* Writing. */

  ['an edit reaches the file', () =>
    serving({ 'a.md': '# A\n' }, async ({ post, read }) => {
      await post('/api/doc', { path: 'a.md', text: '# A changed\n' });
      return await until(async () => (await read('a.md')) === '# A changed\n');
    })],

  ['a file with CRLF endings keeps them through an edit', () =>
    serving({ 'a.md': 'one\r\ntwo\r\n' }, async ({ post, read }) => {
      await post('/api/doc', { path: 'a.md', text: 'one\ntwo\nthree\n' });
      return await until(async () => (await read('a.md')) === 'one\r\ntwo\r\nthree\r\n');
    })],

  ['a lone carriage return the editor never saw is left in the file', () =>
    serving({ 'a.md': 'one\r\ntwo\rthree\r\n' }, async ({ get, post, read }) => {
      // The editor is given newlines, so a naive write-back would flatten the
      // lone return into one. Only the edited region may change.
      const doc = await (await get('/api/doc?path=a.md')).json();
      if (doc.text !== 'one\ntwo\nthree\n') return false;
      await post('/api/doc', { path: 'a.md', text: 'one\ntwo\nthree\nfour\n' });
      return await until(async () => (await read('a.md')) === 'one\r\ntwo\rthree\r\nfour\r\n');
    })],

  ['a byte-order mark survives an edit', () =>
    serving({ 'a.md': '﻿# A\n' }, async ({ post, read }) => {
      await post('/api/doc', { path: 'a.md', text: '# A!\n' });
      return await until(async () => (await read('a.md')) === '﻿# A!\n');
    })],

  ['a burst of edits lands in the order it was typed', () =>
    serving({ 'a.md': '' }, async ({ post, read }) => {
      const texts = ['a', 'ab', 'abc', 'abcd', 'abcde'];
      await Promise.all(texts.map((text) => post('/api/doc', { path: 'a.md', text })));
      return await until(async () => (await read('a.md')) === 'abcde');
    })],

  ['an edit that crosses a much shorter write still leaves the tab\'s text, whole', () =>
    serving({ 'a.md': 'AAAA\n' }, async ({ get, post, read, root }) => {
      // The tab opens the document and holds "AAAA".
      await get('/api/doc?path=a.md');
      // Something else replaces the file with something much shorter, and the
      // tab's edit arrives before the watcher has noticed. The offsets in that
      // edit name places inside "AAAA" that do not exist in what is on disk
      // now, so this is the shape where a hybrid would show up if one could.
      await writeFile(join(root, 'a.md'), 'B\n', 'utf8');
      await post('/api/doc', { path: 'a.md', text: 'AAAA extra\n' });
      const landed = await until(async () => (await read('a.md')) === 'AAAA extra\n');
      return landed && (await read('a.md')) === 'AAAA extra\n';
    })],

  /* An outside change. */

  ['a change on disk reaches the tab', () =>
    serving({ 'a.md': '# A\n' }, async ({ origin, root, get }) => {
      await get('/api/doc?path=a.md');
      const text = await firstSetContent(origin, 'a.md', async () => {
        await new Promise((r) => setTimeout(r, 120));
        await writeFile(join(root, 'a.md'), '# A from somewhere else\n', 'utf8');
      });
      return text === '# A from somewhere else\n';
    })],

  /* A write from outside that lands on top of unsaved typing.
   *
   * This is the race the editor is meant to be open in: somebody types, the save follows a
   * moment later, and a tool writes the whole file from text it read before that. The outside
   * write wins, which is what any editor does with a file that changed underneath it. What was
   * missing here was any sign that it cost the person something — the frame reached the tab
   * marked as somebody else's ordinary edit, so their own Undo did not offer their text back.
   *
   * The flag rides on the event's *name*, so that is what is read. The type cannot hold this:
   * TypeScript lets a subscriber declare fewer parameters than its signature, so the flag can be
   * dropped on the floor and still compile, which is the shape of the defect being fixed.
   */
  ['a write made from a copy taken before the typing leaves the typing standing, and says nothing', () =>
    serving({ 'a.md': 'Line one.\n' }, async ({ origin, root, get, post }) => {
      /*
       * Rewritten for the design decided 2026-09-26, whose reverse this asserted: when a write is
       * merely behind on the line you typed, your text stands. The window was changed then and this
       * host was not, and this check described that gap as correct.
       *
       * The write carries the pre-typing version of line one and adds a line of its own, so it never
       * touched the line the person typed on. There is nothing to choose between: both changes
       * survive, and nothing is said because nothing was taken.
       *
       * The file is asserted as well as the frame, because the whole of the defect was that the
       * screen and the file could part company, and a check on the frame alone would pass a host that
       * showed the merge and wrote the write.
       */
      await get('/api/doc?path=a.md');
      // The tab types, which is what puts anything on record to lose.
      await post('/api/doc', { path: 'a.md', text: 'Line one. and a bit typed just now\n' });
      const frame = await firstDocumentFrame(origin, 'a.md', async () => {
        await new Promise((r) => setTimeout(r, 120));
        // A tool writing the file from a copy it read before the typing landed.
        await writeFile(join(root, 'a.md'), 'Line one.\nSomething else entirely.\n', 'utf8');
      });
      const both = 'Line one. and a bit typed just now\nSomething else entirely.\n';
      await new Promise((r) => setTimeout(r, 300));
      const onDisk = await readFile(join(root, 'a.md'), 'utf8');
      return frame?.event === 'setContent' && frame.text === both && onDisk === both;
    })],

  /* And the words to say, quoting what was taken.
   *
   * A second frame rather than a field on the first, because that one's body is the person's own
   * document line for line and there is no room in it for a sentence of ours they could not also
   * have typed. Built on the server from the same two functions the extension host uses, so the
   * two hosts cannot come to describe one event differently.
   *
   * What is asserted is that the taken text is quoted in it, not the wording. A check pinning the
   * sentence would fail on an improvement to it and say nothing about whether the person can tell
   * what they lost.
   */
  ['the notice naming what a write took quotes the text and reaches the tab', () =>
    serving({ 'a.md': 'Line one.\n' }, async ({ origin, root, get, post }) => {
      await get('/api/doc?path=a.md');
      /*
       * The write has to **conflict** rather than merely be behind, and that is the whole of the
       * change here. It used to carry the pre-typing line one and append a line, which the host now
       * merges, so it takes nothing and reaches no notice.
       *
       * This one changes the very line that was typed in, to something else. There is no answer to
       * what the two together would say, the person at the keyboard keeps theirs, and that is the case
       * the notice exists for.
       *
       * It is also the control the merge most needed: keeping the typing must not silence the conflict
       * that matters. A check that only proved the merge works would pass on a host that had stopped
       * reporting anything at all.
       */
      await post('/api/doc', { path: 'a.md', text: 'Line one. and a distinctive phrase\n' });
      const frames = await documentFrames(origin, 'a.md', 2, async () => {
        await new Promise((r) => setTimeout(r, 120));
        await writeFile(join(root, 'a.md'), 'Line one. and something the tool wrote instead\n', 'utf8');
      });
      const notice = frames.find((f) => f.event === 'notice');
      return (
        // Both frames, in that order: the document goes first, so the offer to undo it refers to
        // something the editor is already holding as an undo step.
        frames[0]?.event === 'contentTookTypedText' &&
        notice !== undefined &&
        notice.text.includes('a distinctive phrase') &&
        notice.text.includes('Undo')
      );
    })],

  /* The control: a write that took nothing says nothing. A host that sent a notice on every
   * outside write would pass the check above and tell the person their work had gone every time
   * anything touched the file, which is worse than the silence it replaced. */
  ['a write that took nothing sends no notice', () =>
    serving({ 'a.md': 'Line one.\n' }, async ({ origin, root, get, post }) => {
      await get('/api/doc?path=a.md');
      await post('/api/doc', { path: 'a.md', text: 'Line one. and a distinctive phrase\n' });
      const frames = await documentFrames(origin, 'a.md', 2, async () => {
        await new Promise((r) => setTimeout(r, 120));
        await writeFile(join(root, 'a.md'), 'Line one. and a distinctive phrase\nAppended elsewhere.\n', 'utf8');
      });
      return frames.length === 1 && frames[0].event === 'setContent';
    })],

  /* The control, and it is the half that makes the check above mean anything: a write that
   * leaves the person's work alone must NOT be named as having taken it. Without this, a host
   * that flagged every frame would pass the check above perfectly and tell the person their text
   * had gone every time anything touched the file. */
  ['a write that leaves the tab\u2019s typing alone is named as an ordinary change', () =>
    serving({ 'a.md': 'Line one.\n' }, async ({ origin, root, get, post }) => {
      await get('/api/doc?path=a.md');
      await post('/api/doc', { path: 'a.md', text: 'Line one. and a bit typed just now\n' });
      const frame = await firstDocumentFrame(origin, 'a.md', async () => {
        await new Promise((r) => setTimeout(r, 120));
        // A write that keeps what was typed and adds a line somewhere else.
        await writeFile(join(root, 'a.md'), 'Line one. and a bit typed just now\nAppended elsewhere.\n', 'utf8');
      });
      return frame?.event === 'setContent' && frame.text === 'Line one. and a bit typed just now\nAppended elsewhere.\n';
    })],

  /* And the other control: a document nobody has typed into. There is nothing on record, so
   * whatever a write does to it, it took none of the person's work. A host that flagged on the
   * texts differing rather than on what was typed would fail here. */
  ['a write to a document the tab never typed into is an ordinary change', () =>
    serving({ 'a.md': 'Line one.\n' }, async ({ origin, root, get }) => {
      await get('/api/doc?path=a.md');
      const frame = await firstDocumentFrame(origin, 'a.md', async () => {
        await new Promise((r) => setTimeout(r, 120));
        await writeFile(join(root, 'a.md'), 'Replaced wholesale.\n', 'utf8');
      });
      return frame?.event === 'setContent' && frame.text === 'Replaced wholesale.\n';
    })],

  ['a change on disk reaches the tab with its line endings written as newlines', () =>
    serving({ 'a.md': 'one\r\n' }, async ({ origin, root, get }) => {
      await get('/api/doc?path=a.md');
      const text = await firstSetContent(origin, 'a.md', async () => {
        await new Promise((r) => setTimeout(r, 120));
        await writeFile(join(root, 'a.md'), 'one\r\ntwo\r\n', 'utf8');
      });
      return text === 'one\ntwo\n';
    })],

  /* Two hosts on one file.
   *
   * The VS Code half of this is inferred, not driven. There is no editor
   * window in this suite, and the harness that has one has no browser tab, so
   * neither instrument can stage both hosts at once. What can be staged is the
   * thing that makes the case true: the file is the channel between them. A
   * save from the editor is a write to the file, and a reload in the editor is
   * a read of it, so the checks below write and read where the editor would and
   * assert what the server does on either side of that.
   *
   * Nobody should later read these as the round trip having been driven. If one
   * of them ever turns up something that needs a real window, it needs a real
   * window.
   */

  ['a save from an editor reaches the tab, and the tab\'s next edit wins (the editor half inferred)', () =>
    serving({ 'a.md': 'one\n' }, async ({ origin, root, get, post, read }) => {
      await get('/api/doc?path=a.md');
      // The editor saves. To the server that is a write to the file, and the
      // tab must be told, because otherwise the person is looking at text that
      // is no longer what the file holds.
      const pushed = await firstSetContent(origin, 'a.md', async () => {
        await new Promise((r) => setTimeout(r, 120));
        await writeFile(join(root, 'a.md'), 'one\ntwo from the editor\n', 'utf8');
      });
      if (pushed !== 'one\ntwo from the editor\n') return false;
      // Now the person types in the tab. The rule is the same one the editor
      // follows: the text in front of the person is what gets written.
      await post('/api/doc', { path: 'a.md', text: 'one\ntwo from the editor\nthree from the tab\n' });
      const landed = await until(async () => (await read('a.md')) === 'one\ntwo from the editor\nthree from the tab\n');
      if (!landed) return false;
      // What the editor would read next is a whole document, not a splice of
      // two. Re-opening through the server reads the file exactly as it is.
      const reread = await (await get('/api/doc?path=a.md')).json();
      return reread.text === 'one\ntwo from the editor\nthree from the tab\n';
    })],

  /*
   * The next check records a loss rather than a guarantee, and it is written
   * that way on purpose.
   *
   * A write that lands between the tab's last read and its next keystroke is
   * gone. The tab posts its whole text, that text is what the file becomes, and
   * nothing about the write that crossed it survives. This was claimed as
   * protection at first and it is not: taking the disk check out of `applyEdit`
   * was tried, and the bytes in the file came out identical, so any check that
   * says otherwise is passing for the wrong reason.
   *
   * What the disk check does buy is narrower and worth keeping: the server
   * never writes a file whose current bytes it has not read, which is what
   * stops it writing over a file swapped underneath it by something like a
   * branch change.
   *
   * The window is the watcher's, about the length of its debounce, so in
   * ordinary use an outside write reaches the tab before the next keystroke.
   * Whether a crossing write should be preserved rather than lost is a product
   * question, not a thing to assert here. This check exists so that if the
   * answer changes, it fails and somebody reads this.
   */
  ['a save that crosses somebody else’s write keeps both changes', () =>
    serving({ 'a.md': 'top\nbottom\n' }, async ({ get, post, read, root }) => {
      await get('/api/doc?path=a.md');
      // The write lands inside the watcher's window, so the tab is still
      // holding the text it was given and knows nothing about it.
      await writeFile(join(root, 'a.md'), 'TOP FROM SOMEWHERE ELSE\nbottom\n', 'utf8');
      await post('/api/doc', { path: 'a.md', text: 'top\nbottom\ntyped\n' });
      // Both: the line somebody else rewrote, and the line the person typed. This
      // used to be the tab's text whole, with the other write gone and nothing said.
      const want = 'TOP FROM SOMEWHERE ELSE\nbottom\ntyped\n';
      const settled = await until(async () => (await read('a.md')) === want);
      if (!settled) return false;
      // And the server is not left holding a view that disagrees with the file.
      const reread = await (await get('/api/doc?path=a.md')).json();
      return reread.text === want;
    })],

  ['the server does not write a file whose current bytes it has not read', () =>
    serving({ 'a.md': 'original\n' }, async ({ get, post, read, root }) => {
      await get('/api/doc?path=a.md');
      // Something swaps the file, as a branch change would. The server has to
      // notice before it writes, so that what it produces is built on bytes it
      // has actually seen rather than on a copy it is holding.
      await writeFile(join(root, 'a.md'), 'a different file entirely\n', 'utf8');
      await post('/api/doc', { path: 'a.md', text: 'original edited\n' });
      const settled = await until(async () => (await read('a.md')) === 'original edited\n');
      if (!settled) return false;
      // The proof is that the server's own view now matches the file. Without
      // the read before the write it would still be holding the old text.
      const reread = await (await get('/api/doc?path=a.md')).json();
      return reread.text === 'original edited\n';
    })],

  /* A folder with a lot in it. */

  ['a folder of several hundred documents lists all of them, in order, without taking a noticeable pause', () =>
    serving({ 'a.md': '# A' }, async ({ get, root }) => {
      // Spread across folders rather than piled in one, because the listing
      // walks and a flat folder would not exercise that.
      const made = [];
      for (let group = 0; group < 20; group++) {
        const dir = join(root, `area-${String(group).padStart(2, '0')}`);
        await mkdir(dir, { recursive: true });
        for (let n = 0; n < 20; n++) {
          const name = `doc-${String(n).padStart(2, '0')}.md`;
          await writeFile(join(dir, name), `# ${group}/${n}\n`, 'utf8');
          made.push(`area-${String(group).padStart(2, '0')}/${name}`);
        }
      }
      const started = Date.now();
      const html = await (await get('/')).text();
      const took = Date.now() - started;
      const everyOne = made.every((rel) => html.includes(`/edit/${rel}`));
      // The order is the walk's, and it has to be the same every time or the
      // list moves under somebody between visits.
      const positions = made.map((rel) => html.indexOf(`/edit/${rel}`));
      const inOrder = positions.every((at, i) => i === 0 || at > positions[i - 1]);
      // A generous bound. This is here to catch a listing that becomes
      // quadratic, not to measure the machine.
      return everyOne && inOrder && took < 3000;
    })],

  /* Images. */

  ['a pasted image is written beside the document', () =>
    serving({ 'notes/a.md': '# A\n' }, async ({ post, root }) => {
      const data = Buffer.from('not really a png').toString('base64');
      const res = await post('/api/image', { path: 'notes/a.md', name: 'shot.png', data });
      const body = await res.json();
      const written = await readFile(join(root, 'notes/assets/shot.png'), 'utf8');
      return body.path === 'assets/shot.png' && written === 'not really a png';
    })],

  ['a second image of the same name gets a name of its own', () =>
    serving({ 'a.md': '# A\n' }, async ({ post }) => {
      const data = Buffer.from('x').toString('base64');
      await post('/api/image', { path: 'a.md', name: 'shot.png', data });
      const second = await (await post('/api/image', { path: 'a.md', name: 'shot.png', data })).json();
      return second.path === 'assets/shot-1.png';
    })],

  ['an image cannot be written outside the folder', () =>
    serving({ 'a.md': '# A\n' }, async ({ post }) => {
      const data = Buffer.from('x').toString('base64');
      const res = await post('/api/image', { path: 'a.md', name: '../../escape.png', data });
      const body = await res.json();
      // The name is flattened rather than followed, so it lands in assets/.
      return body.path === 'assets/-..-escape.png' || body.error !== undefined;
    })],

  /* The theme.
   *
   * This is the check that would have caught the menu being drawn as floating
   * text over the document. Every colour in the editor's stylesheet is resolved
   * through a variable VS Code sets on its webview. Nothing sets them in a
   * browser, and a variable with nothing behind it does not fall back to
   * anything: the element is simply transparent. So the browser theme has to
   * define every variable the stylesheet asks for, and the moment somebody uses
   * a new one, this fails rather than a panel quietly going see-through.
   */

  ['the browser theme defines every colour variable the editor asks for', async () => {
    const here = join(import.meta.dirname, '..', 'media');
    const stylesheet = await readFile(join(here, 'webview.css'), 'utf8');
    const theme = await readFile(join(here, 'browser-theme.css'), 'utf8');
    // A use with a fallback after the comma stands on its own, so it is not
    // this file's job to define it.
    const asked = new Set(
      [...stylesheet.matchAll(/var\(\s*(--vscode-[\w-]+)\s*(,)?/g)]
        .filter(([, , fallback]) => !fallback)
        .map(([, name]) => name)
    );
    const defined = new Set([...theme.matchAll(/^\s*(--vscode-[\w-]+)\s*:/gm)].map(([, name]) => name));
    const missing = [...asked].filter((name) => !defined.has(name));
    if (missing.length) console.log(`   missing from browser-theme.css: ${missing.join(', ')}`);
    return asked.size > 0 && missing.length === 0;
  }],


  /*
   * The toolbar marks itself when its controls fold onto a second row, and the
   * stylesheet is what acts on the mark: it stops the spacer pushing the view
   * buttons to the right edge, so the rows read as one run of controls. Two halves,
   * one class name, so a rename in either has to reach the other.
   */
  ['the class the toolbar sets when it wraps is acted on in the stylesheet', async () => {
    const root = join(import.meta.dirname, '..');
    const stylesheet = await readFile(join(root, 'media', 'webview.css'), 'utf8');
    const source = await readFile(join(root, 'src', 'webview', 'toolbar.ts'), 'utf8');
    const name = /classList\.toggle\('([\w-]+)',[^)]*offsetTop/s.exec(source)?.[1];
    if (!name) {
      console.log('   toolbar.ts no longer marks the bar from a measured offset');
      return false;
    }
    const rule = new RegExp(`\\.sheaf-toolbar\\.${name}\\s+\\.sheaf-tb-spacer\\s*\\{([^}]*)\\}`).exec(stylesheet)?.[1];
    if (!rule) {
      console.log(`   media/webview.css has no rule for .sheaf-toolbar.${name} .sheaf-tb-spacer`);
      return false;
    }
    // Whatever the shorthand, the spacer must stop growing; that is the whole point.
    return /flex\s*:\s*0/.test(rule) || /flex-grow\s*:\s*0/.test(rule);
  }],

  /*
   * Open in Sheaf is how somebody gets a document back into the editor after Sheaf
   * has been turned off as the default, or after dropping one file to raw text. A
   * person looking for it right-clicks whatever is in front of them: the file in the
   * Explorer, the editor's tab, or the text itself. It is contributed to all three,
   * and each one has to name a Markdown file, or the item turns up on a PNG.
   */
  ['Open in Sheaf is on every surface a Markdown file is right-clicked from', async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    const { menus, commands } = manifest.contributes;
    if (!commands.some((c) => c.command === 'sheaf.openWithWysiwyg')) return false;
    const surfaces = ['explorer/context', 'editor/title/context', 'editor/context'];
    return surfaces.every((surface) => {
      const item = (menus[surface] ?? []).find((m) => m.command === 'sheaf.openWithWysiwyg');
      if (!item) {
        console.log(`   no Open in Sheaf on ${surface}`);
        return false;
      }
      if (!/\bmd\b/.test(item.when ?? '') || !/markdown/.test(item.when ?? '')) {
        console.log(`   ${surface} does not limit Open in Sheaf to Markdown: ${item.when}`);
        return false;
      }
      return true;
    });
  }],

  ['both themes define the same variables, so neither is half-dressed', async () => {
    const theme = await readFile(join(import.meta.dirname, '..', 'media', 'browser-theme.css'), 'utf8');
    const blocks = [...theme.matchAll(/\{([^{}]*)\}/g)].map(([, body]) =>
      new Set([...body.matchAll(/(--vscode-[\w-]+)\s*:/g)].map(([, name]) => name))
    ).filter((set) => set.size > 0);
    if (blocks.length < 2) return false;
    const first = blocks[0];
    // Every block that defines any of these has to define all of them.
    return blocks.every((set) => set.size === first.size && [...first].every((name) => set.has(name)));
  }],

  ['the editor page loads the theme before the stylesheet that uses it', () =>
    serving({ 'a.md': '# A' }, async ({ get }) => {
      const html = await (await get('/edit/a.md')).text();
      // The links themselves, not the first mention: a comment in the page
      // explains why the order matters and names the file while doing it.
      const theme = html.indexOf('href="/media/browser-theme.css"');
      const editor = html.indexOf('href="/media/webview.css"');
      return theme !== -1 && editor !== -1 && theme < editor;
    })],

  ['the theme is served', () =>
    serving({ 'a.md': '# A' }, async ({ get }) => {
      const res = await get('/media/browser-theme.css');
      const text = await res.text();
      return res.status === 200 && text.includes('--vscode-editorWidget-background');
    })],

  ['the diagram library is served as JavaScript, which a browser requires before it will run a module', async () => {
    // An extension directory of its own, holding a module where the build puts Mermaid's.
    const assets = await realpath(await mkdtemp(join(tmpdir(), 'sheaf-assets-')));
    await mkdir(join(assets, 'media', 'mermaid', 'chunks'), { recursive: true });
    await writeFile(join(assets, 'media', 'mermaid', 'chunks', 'a.mjs'), 'export default 1;', 'utf8');
    return serving(
      { 'a.md': '# A' },
      async ({ get }) => {
        const res = await get('/media/mermaid/chunks/a.mjs');
        return res.status === 200 && /^text\/javascript/.test(res.headers.get('content-type') ?? '');
      },
      assets
    );
  }],

  /* The pages. */

  ['the front page lists the folder\'s documents, .txt among them, and nothing else', () =>
    serving(
      { 'a.md': '#', 'notes/b.markdown': '#', 'c.txt': 'x', 'logo.png': 'x', '.hidden/d.md': '#', 'node_modules/e.md': '#' },
      async ({ get }) => {
        const html = await (await get('/')).text();
        return (
          html.includes('/edit/a.md') &&
          html.includes('/edit/notes/b.markdown') &&
          // A .txt is where plenty of notes live, and here it opens like any other.
          html.includes('/edit/c.txt') &&
          !html.includes('logo.png') &&
          !html.includes('.hidden') &&
          !html.includes('node_modules')
        );
      }
    )],

  ['the editor page names its document and loads the same bundle the extension ships', () =>
    serving({ 'notes/a.md': '# A' }, async ({ get }) => {
      const html = await (await get('/edit/notes/a.md')).text();
      return (
        html.includes('/media/webview.js') &&
        html.includes('/media/webview.css') &&
        html.includes('/serve-host.js') &&
        html.includes('"notes/a.md"')
      );
    })],

  ['a document name that looks like markup cannot escape the boot data', () =>
    escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;'],

  ['the editor page is served for a name holding a space', () =>
    serving({ 'my notes.md': '# A' }, async ({ get }) => {
      const res = await get(`/edit/${encodeURI('my notes.md')}`);
      const doc = await get(`/api/doc?path=${encodeURIComponent('my notes.md')}`);
      return res.status === 200 && doc.status === 200;
    })],

  /* Link addresses, which is how one document reaches another. */

  ['a relative address resolves against the folder its document sits in', () =>
    same(resolveAddress('notes/a.md', '../README.md'), { path: 'README.md', fragment: '' }) &&
    same(resolveAddress('notes/a.md', 'b.md'), { path: 'notes/b.md', fragment: '' }) &&
    same(resolveAddress('a.md', 'b.md#top'), { path: 'b.md', fragment: 'top' })],

  ['an address written with a space is decoded', () =>
    same(resolveAddress('a.md', 'my%20notes.md'), { path: 'my notes.md', fragment: '' })],

  /* Settings parsing. */

  ['comments and trailing commas are stripped from a settings file', () =>
    stripJsonc('{\n  // one\n  "a": 1, /* two */\n  "b": 2,\n}').replace(/\s/g, '') === '{"a":1,"b":2}'],

  ['a double slash inside a string is not a comment', () =>
    stripJsonc('{"a": "http://x/y"}') === '{"a": "http://x/y"}'],

  /* What a file name can do to the pages it appears on. A name comes off someone
     else's disk as often as not, and both pages print one. */

  ['a file name carrying markup is printed as text in the folder listing', () => {
    const name = 'a<img src=x onerror="alert(1)">.md';
    return serving({ [name]: '# A\n' }, async ({ get }) => {
      const html = await (await get('/')).text();
      const escaped = 'a&lt;img src=x onerror=&quot;alert(1)&quot;&gt;.md';
      if (!html.includes(escaped)) {
        console.log(`   the listing does not carry the name as text: ${html.match(/<li>.*<\/li>/)?.[0] ?? 'no entry at all'}`);
        return false;
      }
      // The name's own angle brackets, anywhere in the page, would be markup.
      if (html.includes('<img src=x')) return console.log('   the name reaches the page as a tag') ?? false;
      return true;
    });
  }],

  ['a path carrying markup is printed as text on the editor page', () => {
    // A single name cannot hold a slash, so `</title` looks unreachable. A path of two
    // names is not: a folder called `b<` and a file called `title>...` make one between
    // them, and the title element is RCDATA, which only `</title` ends.
    const name = 'b</title><img src=x onerror="alert(1)">.md';
    return serving({ [name]: '# B\n' }, async ({ get }) => {
      const html = await (await get(`/edit/${encodeURI(name)}`)).text();
      // The boot data names the file too, and `</script` would end that element.
      const boot = html.match(/<script type="application\/json" id="sheaf-boot">(.*?)<\/script>/s);
      if (!boot) return console.log('   there is no boot element on the page') ?? false;
      if (boot[1].includes('<')) return console.log(`   the boot data carries a raw <: ${boot[1]}`) ?? false;
      if (JSON.parse(boot[1]).file !== name) return console.log(`   the boot data names ${JSON.parse(boot[1]).file}`) ?? false;
      // Compared whole, because a lazy match would stop at an injected `</title>` and
      // read back the harmless text in front of it.
      const want = `<title>${escapeHtml(name)} \u00b7 Sheaf</title>`;
      if (!html.includes(want)) {
        console.log(`   the title is not the path as text: ${html.match(/<title>[^]*?<\/title>/)?.[0]}`);
        return false;
      }
      return true;
    });
  }],

  ['settings nested under a sheaf object are read too', () =>
    serving({ 'a.md': '#', '.vscode/settings.json': '{"sheaf": {"revealSyntaxOnLine": true}}' }, async ({ root }) =>
      readConfig(root).revealSyntaxOnLine === true
    )],

  ['a setting that names a mode is honoured word for word, rather than as true or false', () =>
    serving(
      {
        'a.md': '#',
        '.vscode/settings.json':
          '{"sheaf.tableOfContents": "collapsed", "sheaf.frontMatter": "shown", "sheaf.comments": "hidden"}',
      },
      // Over HTTP rather than through `readConfig`, because the value reaching the page is
      // the thing that decides what a person sees.
      async ({ get }) => {
        const { config } = await (await get('/api/doc?path=a.md')).json();
        return (
          config.tableOfContents === 'collapsed' && config.frontMatter === 'shown' && config.comments === 'hidden'
        );
      }
    )],

  ['a setting the toolbar can also toggle still arrives from the folder', () =>
    serving({ 'a.md': '#', '.vscode/settings.json': '{"sheaf.lineNumbers": true}' }, async ({ get }) => {
      const { config } = await (await get('/api/doc?path=a.md')).json();
      return config.lineNumbers === true;
    })],

  ['a folder that still spells tableOfContents as true gets the outline it asked for', () =>
    serving({ 'a.md': '#', '.vscode/settings.json': '{"sheaf.tableOfContents": true}' }, async ({ root }) =>
      readConfig(root).tableOfContents === 'shown'
    )],

  ['a setting nobody set is the default package.json declares, so a browser tab and VS Code agree', async () => {
    const declared = JSON.parse(await readFile(join(ASSET_ROOT, 'package.json'), 'utf8')).contributes.configuration
      .properties;
    const wrong = Object.entries(DEFAULT_CONFIG).filter(
      ([key, value]) => !same(declared[`sheaf.${key}`]?.default, value)
    );
    if (wrong.length) {
      console.log(
        `   ${wrong
          .map(([key, value]) => `sheaf.${key} defaults to ${JSON.stringify(declared[`sheaf.${key}`]?.default)} and the browser uses ${JSON.stringify(value)}`)
          .join('; ')}`
      );
    }
    return wrong.length === 0;
  }],

  ['the folder server sends every setting the editor page reads', async () => {
    const fields = async (path, declaration) => {
      const text = await readFile(join(ASSET_ROOT, path), 'utf8');
      const start = text.indexOf(declaration);
      const body = text.slice(start + declaration.length, text.indexOf('\n}\n', start));
      return new Set([...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]));
    };
    const page = await fields('src/webview/main.ts', 'interface EditorConfig {');
    const sent = new Set(Object.keys(DEFAULT_CONFIG));
    const missing = [...page].filter((key) => !sent.has(key));
    const spare = [...sent].filter((key) => !page.has(key));
    if (missing.length) console.log(`   the page reads ${missing.join(', ')} and the folder server never sends it`);
    if (spare.length) console.log(`   the folder server sends ${spare.join(', ')} and the page reads no such setting`);
    return missing.length === 0 && spare.length === 0;
  }],

  /* The command line. */

  ['the command line defaults to this folder, the usual port and opening a browser', () => {
    const args = parseArgs([]);
    return args.port === 7432 && args.open === true && typeof args.folder === 'string';
  }],

  ['a port and a folder are taken from the command line', () => {
    const a = parseArgs(['docs', '--port', '9000', '--no-open']);
    const b = parseArgs(['--port=9001']);
    return a.port === 9000 && a.open === false && a.folder.endsWith('docs') && b.port === 9001;
  }],

  ['a port that is not a port is refused', () =>
    'error' in parseArgs(['--port', 'eighty']) && 'error' in parseArgs(['--port', '70000'])],

  ['an option nobody knows is refused rather than ignored', () =>
    'error' in parseArgs(['--host', '0.0.0.0'])],

  /*
   * A browser asks for both of these on its own, whether a page links an icon or not, so
   * before they were routed every page load logged a 404 in the console a person reads when
   * something is actually wrong. One of those 404s was read as a missing bundle chunk once.
   */
  ['a browser asking for an icon on its own gets one rather than a 404', () =>
    serving({ 'a.md': '# A' }, async ({ get }) => {
      const answers = [];
      for (const at of ['/favicon.ico', '/apple-touch-icon.png']) {
        const res = await get(at);
        answers.push({ at, status: res.status, type: res.headers.get('content-type') });
      }
      // The type comes from the file sent rather than from the path asked for, so the .ico
      // path answers as a PNG, which every browser accepts. A 200 of the wrong type would
      // be refused by `nosniff` and would look exactly like the 404 this replaces.
      return answers.every((a) => a.status === 200 && a.type === 'image/png');
    })],

  ['both pages link the icon rather than leaving the browser to ask', () =>
    serving({ 'a.md': '# A' }, async ({ get }) => {
      const folder = await (await get('/')).text();
      const doc = await (await get('/edit/a.md')).text();
      const linked = (html) => /<link href="\/media\/icon\.png" rel="icon" \/>/.test(html);
      return linked(folder) && linked(doc);
    })],
];

let passed = 0;
for (const [name, check] of cases) {
  let ok = false;
  try {
    ok = await check();
  } catch (err) {
    console.log(`   ${name}: ${err?.message ?? err}`);
  }
  if (ok) passed++;
  else console.log(`❌ ${name}`);
}
console.log(`${passed}/${cases.length} server checks passed`);
process.exit(passed === cases.length ? 0 : 1);
