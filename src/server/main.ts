/**
 * `sheaf`: the command that puts the editor on a local address.
 *
 *   sheaf [folder] [--port N] [--no-open]
 *   node dist/serve.js [folder] [--port N] [--no-open]
 *
 * The folder defaults to the working directory. The address is printed once and
 * opened in the browser, because the reason to run this is usually to hand the
 * address to something else: a chat window, a second browser, an app with no
 * extension API of its own.
 *
 * It listens on 127.0.0.1 and nowhere else. Passing a host is not offered: a
 * folder of somebody's files on a network address is a different product with
 * different questions to answer, and leaving the option out is the clearest way
 * to say that this is not it.
 */

import { realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { Server } from 'node:http';
import { createSheafServer } from './server';

/** Where to start looking for a free port. */
const DEFAULT_PORT = 7432;

/** How many ports past the first to try before giving up. */
const PORT_ATTEMPTS = 20;

interface Args {
  folder: string;
  port: number;
  open: boolean;
}

export function parseArgs(argv: string[]): Args | { error: string } {
  let folder: string | undefined;
  let port = DEFAULT_PORT;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-open') {
      open = false;
    } else if (arg === '--open') {
      open = true;
    } else if (arg === '--port' || arg === '-p') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        return { error: `--port wants a number from 0 to 65535, not "${argv[i] ?? ''}".` };
      }
      port = value;
    } else if (arg.startsWith('--port=')) {
      const value = Number(arg.slice('--port='.length));
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        return { error: `--port wants a number from 0 to 65535, not "${arg.slice('--port='.length)}".` };
      }
      port = value;
    } else if (arg.startsWith('-')) {
      return { error: `Sheaf does not know the option "${arg}".` };
    } else if (folder === undefined) {
      folder = arg;
    } else {
      return { error: 'Sheaf serves one folder at a time.' };
    }
  }
  return { folder: resolve(folder ?? process.cwd()), port, open };
}

/**
 * Listen, moving up a port at a time while the one asked for is taken.
 *
 * A port that is busy is the ordinary case when a second folder is served, and
 * making somebody read an error and pick another number for it would be a poor
 * trade. An explicit `--port 0` asks the operating system for a free one, which
 * never collides, so that is left alone.
 */
function listen(server: Server, from: number): Promise<number> {
  return new Promise((accept, reject) => {
    let port = from;
    let attempts = 0;
    const tryPort = (): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && from !== 0 && attempts++ < PORT_ATTEMPTS) {
          port++;
          tryPort();
          return;
        }
        reject(err);
      });
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        accept(typeof address === 'object' && address ? address.port : port);
      });
    };
    tryPort();
  });
}

/** Hand the address to whatever the operating system opens a link with. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Nothing to open it with. The address is printed either way.
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if ('error' in args) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }

  let root: string;
  try {
    root = await realpath(args.folder);
  } catch {
    process.stderr.write(`Sheaf cannot find the folder ${args.folder}.\n`);
    return 1;
  }

  // `dist/serve.js` sits beside `media/` in the extension, so the assets are one
  // directory up from the bundle wherever it was installed.
  const assetRoot = dirname(dirname(__filename));
  const server = createSheafServer({ root, assetRoot });

  let port: number;
  try {
    port = await listen(server, args.port);
  } catch (err) {
    process.stderr.write(`Sheaf could not listen on port ${args.port}: ${(err as Error).message}\n`);
    return 1;
  }

  const url = `http://localhost:${port}/`;
  process.stdout.write(`Sheaf is serving ${root}\n  ${url}\nPress Control-C to stop.\n`);
  if (args.open) openInBrowser(url);

  await new Promise<void>((done) => {
    const stop = (): void => {
      server.close(() => done());
      // A browser tab holds an event stream open, and a stream is a connection
      // that never ends by itself, so the sockets are cut rather than waited on.
      server.closeAllConnections?.();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
