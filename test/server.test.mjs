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
async function serving(files, body) {
  // Real path, because the checks compare what the server resolves against what
  // they built, and a temporary directory on macOS is reached through a link.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sheaf-serve-')));
  for (const [rel, text] of Object.entries(files)) {
    const target = join(root, rel);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, text, 'utf8');
  }
  const server = createSheafServer({ root, assetRoot: ASSET_ROOT });
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
        return doc.config.contentWidth === '900px' && doc.config.doubleClickToEditSource === true;
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
  ['a save that crosses a keystroke is lost, and what is left is a whole document (recorded, not endorsed)', () =>
    serving({ 'a.md': 'top\nbottom\n' }, async ({ get, post, read, root }) => {
      await get('/api/doc?path=a.md');
      // The write lands inside the watcher's window, so the tab is still
      // holding the text it was given.
      await writeFile(join(root, 'a.md'), 'TOP FROM SOMEWHERE ELSE\nbottom\n', 'utf8');
      await post('/api/doc', { path: 'a.md', text: 'top\nbottom\ntyped\n' });
      const settled = await until(async () => (await read('a.md')) === 'top\nbottom\ntyped\n');
      if (!settled) return false;
      const text = await read('a.md');
      // The tab's text, whole. Not a hybrid, and not the other write.
      const whole = text === 'top\nbottom\ntyped\n';
      const lost = !text.includes('SOMEWHERE ELSE');
      // And the server is not left holding a view that disagrees with the file.
      const reread = await (await get('/api/doc?path=a.md')).json();
      return whole && lost && reread.text === text;
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
   * A blank line between blocks is drawn short by a class the editor adds and the
   * stylesheet sizes, so the two halves have to agree about the class's name, and
   * the size has to be one CodeMirror's height map can read. A vertical margin is
   * space the map cannot see, and a height short by it drifts posAtCoords until
   * clicks land on the wrong line.
   */
  ['the class the editor puts on a short blank line is sized in the stylesheet, without a margin', async () => {
    const root = join(import.meta.dirname, '..');
    const stylesheet = await readFile(join(root, 'media', 'webview.css'), 'utf8');
    const source = await readFile(join(root, 'src', 'webview', 'blankLines.ts'), 'utf8');
    const name = /BLANK_LINE_CLASS\s*=\s*'([\w-]+)'/.exec(source)?.[1];
    if (!name) return false;
    const rule = new RegExp(`\\.cm-line\\.${name}\\s*\\{([^}]*)\\}`).exec(stylesheet)?.[1];
    if (!rule) {
      console.log(`   media/webview.css has no rule sizing .cm-line.${name}`);
      return false;
    }
    if (/(^|[\s;])margin/.test(rule)) {
      console.log(`   .cm-line.${name} sets a margin, which CodeMirror's height map cannot see`);
      return false;
    }
    return /(^|[\s;])height\s*:/.test(rule);
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

  /* The pages. */

  ['the front page lists the folder\'s Markdown and nothing else', () =>
    serving(
      { 'a.md': '#', 'notes/b.markdown': '#', 'c.txt': 'x', '.hidden/d.md': '#', 'node_modules/e.md': '#' },
      async ({ get }) => {
        const html = await (await get('/')).text();
        return (
          html.includes('/edit/a.md') &&
          html.includes('/edit/notes/b.markdown') &&
          !html.includes('c.txt') &&
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

  ['settings nested under a sheaf object are read too', () =>
    serving({ 'a.md': '#', '.vscode/settings.json': '{"sheaf": {"revealSyntaxOnLine": true}}' }, async ({ root }) =>
      readConfig(root).revealSyntaxOnLine === true
    )],

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
