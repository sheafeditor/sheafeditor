/**
 * Serving the open folder to a browser, from inside VS Code.
 *
 * Sheaf's editor runs in a browser already: `media/webview.js` is the same
 * bundle in both places, and `src/server/` is the host that puts a folder on
 * disk behind it. This is the way in from the editor, so that opening a document
 * in something other than VS Code is a command rather than a path somebody has
 * to know how to type.
 *
 * One server per window. Running the command again shows the address rather than
 * starting a second one, because two servers on one folder is never what was
 * meant and the second would answer on a different port.
 *
 * It listens on loopback and stops when the window closes. The address goes into
 * a message with a button rather than into the output channel: the whole reason
 * to run this is to hand the address to something else, so it has to be
 * somewhere it can be copied.
 */

import * as vscode from 'vscode';
import { Server } from 'node:http';
import { createSheafServer } from './server/server';

/** Where to start looking for a free port, matching the command line's default. */
const FIRST_PORT = 7432;

/** How many ports past the first to try before giving up. */
const PORT_ATTEMPTS = 20;

let running: { server: Server; url: string; root: string } | undefined;

/** Listen on loopback, moving up a port while the one asked for is taken. */
function listen(server: Server, from: number): Promise<number> {
  return new Promise((accept, reject) => {
    let port = from;
    let attempts = 0;
    const tryPort = (): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempts++ < PORT_ATTEMPTS) {
          port++;
          tryPort();
          return;
        }
        reject(err);
      });
      server.listen(port, '127.0.0.1', () => accept(port));
    };
    tryPort();
  });
}

/**
 * Which folder to serve.
 *
 * The folder holding the document being looked at, when there is one, because
 * that is the project the person is in. Otherwise the only workspace folder, and
 * otherwise a choice, since serving the wrong one of several is worse than
 * asking.
 */
async function chooseFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage('Sheaf: open a folder first, and Sheaf can serve it to a browser.');
    return undefined;
  }
  if (folders.length === 1) return folders[0];

  const active = vscode.window.activeTextEditor?.document.uri;
  const current = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
  if (current) return current;

  return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which folder should Sheaf serve?' });
}

/** Show the address, with the two things a person does with it. */
async function offer(url: string, root: string): Promise<void> {
  const open = 'Open in Browser';
  const copy = 'Copy Address';
  const picked = await vscode.window.showInformationMessage(`Sheaf is serving ${root} at ${url}`, open, copy);
  if (picked === open) await vscode.env.openExternal(vscode.Uri.parse(url));
  if (picked === copy) await vscode.env.clipboard.writeText(url);
}

export function registerBrowserSession(context: vscode.ExtensionContext): vscode.Disposable[] {
  const start = vscode.commands.registerCommand('sheaf.openInBrowser', async () => {
    if (running) {
      await offer(running.url, running.root);
      return;
    }
    const folder = await chooseFolder();
    if (!folder) return;
    if (folder.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage(
        'Sheaf can serve a folder on this machine. This one is somewhere else.'
      );
      return;
    }

    const root = folder.uri.fsPath;
    const server = createSheafServer({ root, assetRoot: context.extensionUri.fsPath });
    let port: number;
    try {
      port = await listen(server, FIRST_PORT);
    } catch (err) {
      void vscode.window.showErrorMessage(`Sheaf could not start the local editor: ${(err as Error).message}`);
      return;
    }
    running = { server, url: `http://localhost:${port}/`, root };
    await offer(running.url, root);
  });

  const stop = vscode.commands.registerCommand('sheaf.stopBrowser', () => {
    if (!running) {
      void vscode.window.showInformationMessage('Sheaf is not serving anything.');
      return;
    }
    const was = running.url;
    stopServing();
    void vscode.window.showInformationMessage(`Sheaf stopped serving at ${was}.`);
  });

  // The window closing has to take the server with it. Nothing else does: a
  // listening socket outlives the extension host's last command by itself.
  // A plain object rather than `new vscode.Disposable`, because everything that
  // takes a disposable asks only for this shape, and constructing one ties the
  // module to the class for no gain.
  return [start, stop, { dispose: stopServing }];
}

/** Stop the server, if one is running. Exported for the host checks. */
export function stopServing(): void {
  if (!running) return;
  const { server } = running;
  running = undefined;
  server.closeAllConnections?.();
  server.close();
}

/** The address being served, or undefined. Exported for the host checks. */
export function servingAt(): string | undefined {
  return running?.url;
}
