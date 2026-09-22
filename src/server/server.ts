/**
 * The local editor's HTTP server.
 *
 * It binds to the loopback address and serves one folder. That is a small
 * surface, and all of it writes to somebody's project, so the checks are worth
 * stating plainly rather than leaving to be inferred from the code.
 *
 * Every path that arrives in a URL goes through `resolveInside`, so a request
 * can only name a file in the folder being served. That is the boundary; the
 * rest is about who is allowed to ask.
 *
 * A page on the internet can reach a loopback server from the visitor's own
 * browser, so binding to 127.0.0.1 is not on its own a fence. Two things close
 * that. The `Host` header has to name loopback, which stops a domain that
 * resolves to 127.0.0.1 from being used to dress a request up as same-origin.
 * And every `/api/` request has to carry `x-sheaf-local`, which a form post
 * cannot set and a cross-origin fetch may only send after a preflight this
 * server refuses. An `Origin` from anywhere but here is refused outright.
 *
 * Nothing is stored and nothing is remembered between runs. The server holds the
 * documents that are open and lets go of them when the last tab does.
 */

import { createReadStream, realpathSync, Stats } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { basename, extname, join } from 'node:path';
import { DocumentStore, OpenDocument } from './documents';
import { editorPage, indexPage } from './page';
import { folderOf, joinRelative, relativePosix, resolveInside } from './paths';
import { EditorConfig, readConfig } from './settings';

/** Where images pasted into a document are written, as in the extension. */
const IMAGE_FOLDER = 'assets';

/** The largest body any request may carry, which bounds a pasted image. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Folders the listing never walks into. */
const SKIP_FOLDERS = new Set(['node_modules', 'dist', 'out', 'build', 'target', 'vendor']);

/** How many documents the listing shows before it stops walking. */
const MAX_LISTED = 2000;

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
};

export interface ServeOptions {
  /** The folder to serve. Absolute and already resolved through its real path. */
  root: string;
  /** The extension's own directory, holding `media/` and the built host bundle. */
  assetRoot: string;
}

export function createSheafServer(options: ServeOptions): Server {
  // Resolved here rather than trusted from the caller. Every path that arrives
  // is checked by comparing its real path against this one, so a root that is
  // itself reached through a link would refuse every file inside it. On macOS
  // that is not an edge case: `/tmp` and `/var` are both links.
  const root = realPathOr(options.root);
  const { assetRoot } = options;
  const documents = new DocumentStore();
  const mediaRoot = join(assetRoot, 'media');
  const distRoot = join(assetRoot, 'dist');

  const server = createServer((req, res) => {
    handle(req, res).catch(() => finish(res, 500, 'text/plain; charset=utf-8', 'Sheaf: something went wrong.'));
  });

  server.on('close', () => documents.closeAll());

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    if (!hostIsLoopback(req)) {
      finish(res, 403, 'text/plain; charset=utf-8', 'Sheaf serves this folder to this machine only.');
      return;
    }
    if (!originIsOurs(req) || !siteIsOurs(req)) {
      finish(res, 403, 'text/plain; charset=utf-8', 'Sheaf refuses a request from another page.');
      return;
    }
    if (path.startsWith('/api/')) {
      if (req.headers['x-sheaf-local'] !== '1') {
        finish(res, 403, 'text/plain; charset=utf-8', 'Sheaf refuses a request from another page.');
        return;
      }
      await api(req, res, path, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      finish(res, 405, 'text/plain; charset=utf-8', 'Sheaf only reads on this address.');
      return;
    }

    if (path === '/') {
      finish(res, 200, 'text/html; charset=utf-8', indexPage(root, await listMarkdown(root)));
      return;
    }
    if (path === '/serve-host.js') {
      await sendFile(res, join(distRoot, 'serve-host.js'));
      return;
    }
    if (path.startsWith('/media/')) {
      const asset = resolveInside(mediaRoot, path.slice('/media/'.length));
      if (!asset) {
        finish(res, 404, 'text/plain; charset=utf-8', 'No such file.');
        return;
      }
      await sendFile(res, asset);
      return;
    }
    if (path.startsWith('/edit/')) {
      const rel = path.slice('/edit/'.length);
      const file = resolveInside(root, rel);
      if (!file) {
        finish(res, 403, 'text/plain; charset=utf-8', 'Sheaf serves only the folder it was started in.');
        return;
      }
      finish(res, 200, 'text/html; charset=utf-8', editorPage(relativePosix(root, file)));
      return;
    }
    if (path.startsWith('/file/')) {
      const rel = path.slice('/file/'.length);
      const file = resolveInside(root, rel);
      if (!file) {
        finish(res, 403, 'text/plain; charset=utf-8', 'Sheaf serves only the folder it was started in.');
        return;
      }
      await sendFile(res, file);
      return;
    }
    finish(res, 404, 'text/plain; charset=utf-8', 'No such page.');
  }

  /* --- The three things a tab asks for ------------------------------------ */

  async function api(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    if (path === '/api/doc' && req.method === 'GET') {
      const doc = await openFrom(url.searchParams.get('path'), res);
      if (!doc) return;
      const base = `http://${req.headers.host ?? 'localhost'}/file/${encodeURI(folderOf(doc.relative))}`;
      const payload: {
        text: string;
        config: EditorConfig;
        fileName: string;
        resourceBaseUri: string;
        capabilities: { terminal: boolean };
      } = {
        text: doc.webviewText(),
        config: readConfig(root),
        fileName: doc.relative,
        resourceBaseUri: base,
        // What this host can do, decided here rather than in the page. The
        // server is the host: it is the process that would have to own a
        // terminal, and it knows it does not. The shim in the page carries this
        // to the editor and invents none of it, so there is one place to change
        // when a host gains an ability and one place a check can look.
        capabilities: { terminal: false },
      };
      finish(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload));
      return;
    }

    if (path === '/api/doc' && req.method === 'POST') {
      const body = await readJson<{ path?: string; text?: string }>(req, res);
      if (!body) return;
      if (typeof body.text !== 'string') {
        finish(res, 400, 'application/json; charset=utf-8', '{"error":"No text."}');
        return;
      }
      const doc = await openFrom(body.path ?? null, res);
      if (!doc) return;
      await doc.edit(body.text);
      finish(res, 200, 'application/json; charset=utf-8', '{"ok":true}');
      return;
    }

    if (path === '/api/events' && req.method === 'GET') {
      const doc = await openFrom(url.searchParams.get('path'), res);
      if (!doc) return;
      stream(req, res, doc);
      return;
    }

    if (path === '/api/image' && req.method === 'POST') {
      await saveImage(req, res);
      return;
    }

    finish(res, 404, 'application/json; charset=utf-8', '{"error":"No such endpoint."}');
  }

  /** Open a document named by a request, answering the request itself on refusal. */
  async function openFrom(rel: string | null, res: ServerResponse): Promise<OpenDocument | undefined> {
    const file = rel ? resolveInside(root, rel) : null;
    if (!file) {
      finish(res, 403, 'application/json; charset=utf-8', '{"error":"Outside the folder Sheaf is serving."}');
      return undefined;
    }
    try {
      return await documents.get(file, relativePosix(root, file));
    } catch {
      finish(res, 404, 'application/json; charset=utf-8', '{"error":"No such document."}');
      return undefined;
    }
  }

  /** The push channel: the document, whenever something outside the tab writes it. */
  function stream(req: IncomingMessage, res: ServerResponse, doc: OpenDocument): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': open\n\n');

    const unsubscribe = doc.subscribe({
      setContent(text: string) {
        // One `data:` line per line of the document, which is how the format
        // carries a newline. The client joins them back.
        const payload = text.split('\n').map((line) => `data: ${line}`).join('\n');
        res.write(`event: setContent\n${payload}\n\n`);
      },
    });
    // Something between the tab and here may drop an idle connection, and a
    // comment is the cheapest thing that keeps it open.
    const beat = setInterval(() => res.write(': beat\n\n'), 25000);

    const done = (): void => {
      clearInterval(beat);
      unsubscribe();
      documents.release(doc);
    };
    req.on('close', done);
    res.on('close', done);
  }

  /** An image pasted or dropped into a document, written beside it as the extension does. */
  async function saveImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<{ path?: string; name?: string; data?: string }>(req, res);
    if (!body) return;
    const doc = body.path ? resolveInside(root, body.path) : null;
    if (!doc || typeof body.name !== 'string' || typeof body.data !== 'string') {
      finish(res, 403, 'application/json; charset=utf-8', '{"error":"Sheaf could not save the image there."}');
      return;
    }
    const safe = body.name.replace(/[\\/]/g, '-').replace(/^\.+/, '') || 'image.png';
    const folder = joinRelative(folderOf(relativePosix(root, doc)), IMAGE_FOLDER);
    const target = resolveInside(root, joinRelative(folder, safe));
    if (!target) {
      finish(res, 403, 'application/json; charset=utf-8', '{"error":"Sheaf could not save the image there."}');
      return;
    }
    const free = await freeName(target);
    try {
      // The folder is made on the first image, as the extension makes it.
      await mkdir(join(free, '..'), { recursive: true });
      await writeFile(free, Buffer.from(body.data, 'base64'));
    } catch {
      finish(
        res,
        200,
        'application/json; charset=utf-8',
        JSON.stringify({ error: `Sheaf could not save the image into ${folder}.` })
      );
      return;
    }
    // The address written into the document is relative to the document, which
    // is what `assets/name.png` is: the folder sits beside the file.
    finish(res, 200, 'application/json; charset=utf-8', JSON.stringify({ path: `${IMAGE_FOLDER}/${basename(free)}` }));
  }

  /* --- Serving a file off disk --------------------------------------------- */

  async function sendFile(res: ServerResponse, file: string): Promise<void> {
    let info: Stats;
    try {
      info = await stat(file);
    } catch {
      finish(res, 404, 'text/plain; charset=utf-8', 'No such file.');
      return;
    }
    if (!info.isFile()) {
      finish(res, 404, 'text/plain; charset=utf-8', 'No such file.');
      return;
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(info.size),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(file).pipe(res);
  }

  /** Every Markdown file in the folder, for the front page. */
  async function listMarkdown(from: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (found.length >= MAX_LISTED) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          if (SKIP_FOLDERS.has(entry.name)) continue;
          await walk(join(dir, entry.name));
        } else if (/\.(md|markdown)$/i.test(entry.name)) {
          found.push(relativePosix(from, join(dir, entry.name)));
        }
        if (found.length >= MAX_LISTED) return;
      }
    };
    await walk(from);
    return found;
  }

  return server;
}

/* --- Small shared pieces ----------------------------------------------------- */

/** A directory's real path, or the path itself when it cannot be resolved. */
function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A name in the same folder that nothing is using yet, as the extension picks one. */
async function freeName(target: string): Promise<string> {
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  let candidate = target;
  for (let i = 1; await exists(candidate); i++) {
    candidate = `${stem}-${i}${ext}`;
  }
  return candidate;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `Host` header has to name loopback.
 *
 * A name on the internet can be pointed at 127.0.0.1, and a page served from it
 * is then same-origin with whatever is listening there. Checking the header is
 * what keeps this server from answering under a borrowed name.
 */
export function hostIsLoopback(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/** A request carrying somebody else's origin is not one of ours. */
export function originIsOurs(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // A plain navigation sends none.
  try {
    const url = new URL(origin);
    const name = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return (name === 'localhost' || name === '127.0.0.1' || name === '::1') && url.host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * A request the browser itself says came from somewhere else is refused.
 *
 * `Sec-Fetch-Site` is set by the browser rather than by the page, so a page
 * elsewhere cannot spell it differently. It is belt and braces next to the
 * origin check: that one passes when no origin is sent, which is the ordinary
 * case for a navigation, and this says what a navigation was navigated from.
 * Anything that sends no such header at all, such as a terminal, is left alone.
 */
export function siteIsOurs(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site !== 'string') return true;
  return site === 'same-origin' || site === 'none';
}

function finish(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** A JSON body, or undefined with the request already answered. */
async function readJson<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        finish(res, 413, 'application/json; charset=utf-8', '{"error":"Too large."}');
        req.destroy();
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    finish(res, 400, 'application/json; charset=utf-8', '{"error":"Bad request."}');
    return undefined;
  }
}
