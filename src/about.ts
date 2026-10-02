/*
 * Saying which build of Sheaf this window is running, and noticing when a
 * different one is waiting on disk.
 *
 * Two jobs, one subject. **Sheaf: About** answers the question when it is asked,
 * with a line a person can paste into a bug report. The notice answers it when it
 * has not been asked and the answer matters: a build installed while the window
 * was open is not the build in front of you until the window reloads, and nothing
 * used to say so. That is the round trip this whole thing exists to remove — ask
 * for a change, be told it landed, and have no way to tell whether you are
 * looking at it.
 */

import * as vscode from 'vscode';
import { buildLine, buildStamp, differsFromRunning } from './buildStamp';

/**
 * What this extension is called in the host's registry, which is how it finds itself there.
 *
 * The published build is `sheafeditor.sheafeditor` and that is the default, because a host
 * that hands over no context at all is the test stand-in. A build installed under another
 * name is not hypothetical: a development build carries its own id so that it and the
 * published one are two rows in the Extensions pane rather than a version race, and under a
 * hardcoded name the "a newer build is installed, reload" notice below would look itself up,
 * find nothing, and go quiet. Quietly, which is the part that matters: that notice is the
 * only thing standing between asking for a change and not knowing whether you are looking
 * at it, and it fails by saying nothing.
 */
export let EXTENSION_ID = 'sheafeditor.sheafeditor';

/** Where this is running, for the About line. */
function hostLabel(): string {
  const app = vscode.env.appName || 'an editor';
  const remote = vscode.env.remoteName ? ` over ${vscode.env.remoteName}` : '';
  return `${app} ${vscode.version}${remote}`;
}

/**
 * The version the editor believes is installed, which is not the version running.
 *
 * VS Code refreshes its extension registry when something is installed and leaves
 * the loaded code alone, so this is how a window finds out a newer build is there.
 * Undefined in a host that does not know the extension, which the checks rely on.
 */
function installedVersion(): string | undefined {
  const v = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version;
  return typeof v === 'string' ? v : undefined;
}

/** The About text: what is running, what it was built from, and where. */
export function aboutText(): string {
  return buildLine(hostLabel());
}

/** Show it, with a way to take it away for a bug report. */
async function showAbout(): Promise<void> {
  const line = aboutText();
  const installed = installedVersion();
  const stale = differsFromRunning(installed)
    ? `\n\nSheaf ${installed} is installed. This window is still running ${buildStamp.version}; reload it to pick the newer one up.`
    : '';
  const copy = 'Copy';
  const picked = await vscode.window.showInformationMessage(line + stale, { modal: false }, copy);
  if (picked === copy) await vscode.env.clipboard.writeText(line);
}

/**
 * Tell the window when the build on disk stops being the build it is running.
 *
 * `onDidChange` fires when the extension registry moves, which an install does,
 * and it is checked once on activation as well, for an install that finished
 * while this extension host was starting. Said once per version rather than once
 * per event: the registry can move several times for one install, and a
 * notification that returns every few seconds is worse than none.
 */
function watchForNewerBuild(): vscode.Disposable {
  let said: string | undefined;
  const look = async () => {
    const installed = installedVersion();
    if (!differsFromRunning(installed) || said === installed) return;
    said = installed;
    const reload = 'Reload Window';
    const picked = await vscode.window.showInformationMessage(
      `Sheaf ${installed} is installed. This window is running ${buildStamp.version}.`,
      reload
    );
    if (picked === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  };
  // Not awaited: activation must not wait on a notification nobody may answer.
  void look();
  return vscode.extensions.onDidChange(() => void look());
}

export function registerAbout(context: vscode.ExtensionContext): void {
  // The host knows what it loaded, so take the id from it rather than from the constant above.
  if (typeof context.extension?.id === 'string' && context.extension.id) EXTENSION_ID = context.extension.id;
  context.subscriptions.push(vscode.commands.registerCommand('sheaf.about', showAbout));
  context.subscriptions.push(watchForNewerBuild());
}
