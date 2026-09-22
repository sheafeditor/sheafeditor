import * as vscode from 'vscode';
import {
  DocumentSelection,
  MarkdownEditorProvider,
  setTableOfContents,
  tableOfContentsOn,
} from './markdownEditorProvider';
import { registerDefaultEditorSync } from './defaultEditor';
import { registerBrowserSession } from './browserSession';

export function activate(context: vscode.ExtensionContext): void {
  // Register the WYSIWYG custom editor for Markdown files.
  context.subscriptions.push(MarkdownEditorProvider.register(context));
  // And the one offered for .csv and .tsv files, which shows the whole file as a grid.
  context.subscriptions.push(MarkdownEditorProvider.register(context, 'grid'));

  // Honour "sheaf.useAsDefaultMarkdownEditor" by keeping workbench.editorAssociations
  // in step with it.
  context.subscriptions.push(registerDefaultEditorSync());

  // Open Markdown files with the WYSIWYG editor: the Explorer's selection, or the
  // file the person is looking at.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'sheaf.openWithWysiwyg',
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        // The Explorer hands a command the file that was right-clicked, and then the
        // whole selection. Opening all of it is what its other open commands do.
        const chosen = uris?.length ? uris : uri ? [uri] : [];
        if (chosen.length > 0) {
          for (const target of chosen.filter(isMarkdownFile)) {
            // Several files each need a tab of their own: a preview tab would be
            // taken back by the next file in the selection.
            await vscode.commands.executeCommand(
              'vscode.openWith',
              target,
              MarkdownEditorProvider.viewType,
              chosen.length > 1 ? { preview: false } : undefined
            );
          }
          return;
        }

        if (focusedSheafEditor()) {
          // Run from a Sheaf editor: the file is already open in Sheaf, so there is
          // nothing to open and nothing to report.
          return;
        }
        const active = vscode.window.activeTextEditor?.document.uri;
        if (!active) {
          void vscode.window.showInformationMessage('Sheaf: no Markdown file to open.');
          return;
        }
        await vscode.commands.executeCommand(
          'vscode.openWith',
          active,
          MarkdownEditorProvider.viewType
        );
      }
    )
  );

  // Reopen the current document in the plain text editor.
  context.subscriptions.push(
    vscode.commands.registerCommand('sheaf.openAsText', async (uri?: vscode.Uri, column?: vscode.ViewColumn) => {
      const target = uri ?? (focusedSheafEditor() ? MarkdownEditorProvider.activeUri : undefined);
      if (!target) {
        // Run from a plain text editor, or with nothing open at all: what the
        // person is looking at is raw Markdown already.
        return;
      }
      // A column is given when a Sheaf editor's own toolbar asked, so the text opens in
      // that editor's group. From the Command Palette it is the active group either way.
      await vscode.commands.executeCommand('vscode.openWith', target, 'default', column);
    })
  );

  // Toggle whole-document raw source mode inside the active WYSIWYG editor.
  context.subscriptions.push(
    vscode.commands.registerCommand('sheaf.toggleSourceMode', () => {
      // Only the Sheaf editor with focus toggles. A Sheaf editor sitting in another
      // tab is not the document the person is working in.
      focusedSheafEditor()?.postMessage({ type: 'toggleSourceMode' });
    })
  );

  // Show or hide the list of the document's headings. This is a setting rather than a
  // property of one editor, so it needs no editor to have focus and it takes in all of
  // them at once; each hears about the write through its own configuration listener.
  context.subscriptions.push(
    vscode.commands.registerCommand('sheaf.toggleTableOfContents', () =>
      setTableOfContents(!tableOfContentsOn())
    )
  );

  // Put a reference to the selection on the clipboard, as the right-click menu does.
  context.subscriptions.push(vscode.commands.registerCommand('sheaf.copyRef', copySelectionRef));

  // Hand the lines the person has selected to whatever is running in the terminal.
  context.subscriptions.push(
    vscode.commands.registerCommand('sheaf.sendRefToTerminal', sendSelectionToTerminal)
  );

  // Serve the open folder to a browser, so a document can be opened in something
  // that has no way to load an extension.
  context.subscriptions.push(...registerBrowserSession(context));

  // Say why a file VS Code will not read as text cannot be shown, and where to go next.
  context.subscriptions.push(explainTabsThatCannotOpen());
}

/**
 * Put a reference to the selection on the clipboard: where it is, and what is written
 * there. The same thing Copy ref in the right-click menu puts there, because the
 * webview builds both with the one builder; this reaches it from a key and from the
 * Command Palette, which the menu cannot.
 */
async function copySelectionRef(): Promise<void> {
  const selected = await focusedSheafEditor()?.freshSelection();
  if (!selected) {
    // Run with no Sheaf editor in front of the person. There is no selection here to
    // copy, and the editor they are in has its own way of naming one.
    return;
  }
  void vscode.env.clipboard.writeText(selected.ref);
}

/**
 * Type a reference to the selected lines into the terminal, then put that terminal in
 * front of the person with the reference waiting at the prompt.
 *
 * A coding agent in a plain text editor picks the selection up by itself, from
 * `vscode.window.activeTextEditor`. That is empty while a custom editor has focus,
 * and VS Code offers a custom editor no way to fill it, so what the person is looking
 * at in Sheaf is invisible to everything else in the window. This carries it across
 * by hand: the file and the lines, typed where the next thing they say will go.
 *
 * Nothing is submitted. `sendText` with `false` types the text and stops, so the
 * reference sits in the prompt and the person carries on from it in their own words.
 */
async function sendSelectionToTerminal(): Promise<void> {
  const selected = await focusedSheafEditor()?.freshSelection();
  if (!selected) {
    // Run with no Sheaf editor in front of the person: a plain text editor already
    // reports its own selection, and there is nothing here to add to it.
    return;
  }
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    void vscode.window.showInformationMessage(
      'Sheaf: there is no terminal to send the selection to. Open one and run this again, ' +
        'and the file and the lines you picked are typed at its prompt.'
    );
    return;
  }
  terminal.sendText(lineReference(selected), false);
  terminal.show();
}

/**
 * The reference a terminal receives: `@notes/plan.md#L12-18`, with a trailing space so
 * whatever the person types next does not run into it. A single line is `#L12`.
 */
function lineReference({ path, start, end }: DocumentSelection): string {
  return `@${path}#L${start}${end > start ? `-${end}` : ''} `;
}

/**
 * How long a tab has to resolve an editor before Sheaf goes looking for why it has
 * not. Nothing is decided by this: a tab given too little time only costs one file
 * read that finds nothing wrong and says nothing.
 */
const RESOLVE_GRACE_MS = 300;

/**
 * How many bytes of a file VS Code reads before deciding whether it is binary. A NUL
 * after these is not looked at, and the file opens like any other.
 */
const BINARY_SCAN_BYTES = 512;

/**
 * Explain a Sheaf tab that opens on a file VS Code will not hand over as text.
 *
 * Sheaf's editor is a custom *text* editor, so VS Code reads the file into a document
 * before Sheaf sees any of it. A file holding a NUL byte near its start is read as
 * binary and never becomes a document, so the editor is never resolved and nothing
 * inside it can say what happened. The tab is left showing VS Code's own placeholder,
 * which names no file, no reason, and no way on. The plain text editor has a guard of
 * its own for this with an Open Anyway button, so there is somewhere to send people.
 *
 * The tab opening is the only thing Sheaf hears about, which is why this watches tabs
 * rather than anything in the editor.
 */
function explainTabsThatCannotOpen(): vscode.Disposable {
  return vscode.window.tabGroups.onDidChangeTabs((event) => {
    for (const tab of event.opened) {
      const input: unknown = tab.input;
      if (
        input instanceof vscode.TabInputCustom &&
        input.viewType === MarkdownEditorProvider.viewType
      ) {
        void explainIfItCannotOpen(input.uri);
      }
    }
  });
}

/** Tell the person why this file cannot be shown, unless it opened after all. */
async function explainIfItCannotOpen(uri: vscode.Uri): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, RESOLVE_GRACE_MS));
  if (MarkdownEditorProvider.isShowing(uri)) {
    return;
  }
  const line = await lineHoldingANulByte(uri);
  if (line === undefined) {
    // Something else kept it from opening, and Sheaf has nothing to add to what VS
    // Code has already said. Guessing at a reason would be worse than its placeholder.
    return;
  }
  const where = vscode.workspace.asRelativePath(uri);
  const raw = 'Open as Raw Markdown (Text)';
  const choice = await vscode.window.showWarningMessage(
    `Sheaf: ${where} cannot be shown, because it holds a NUL byte (U+0000) on line ${line}. ` +
      'A file with one in it is read as binary rather than as text.',
    raw
  );
  if (choice === raw) {
    await vscode.commands.executeCommand('sheaf.openAsText', uri);
  }
}

/**
 * The line a NUL byte sits on, counted from one, or undefined when the file has none
 * where it counts. Only the bytes VS Code looks at are looked at here, so this says
 * the file will not open exactly when VS Code has decided it will not.
 */
async function lineHoldingANulByte(uri: vscode.Uri): Promise<number | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined; // Gone, or unreadable, which is its own message from VS Code.
  }
  let line = 1;
  const end = Math.min(bytes.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) {
      return line;
    }
    if (bytes[i] === 10) {
      line++;
    }
  }
  return undefined;
}

export function deactivate(): void {
  /* nothing to clean up beyond disposables */
}

/**
 * The Sheaf editor a Command Palette command should act on, if any.
 *
 * The provider remembers the Sheaf editor focused last, and goes on remembering it
 * once the person moves to a plain text editor. VS Code reports no active text
 * editor while a custom editor holds focus, so a text editor with focus means every
 * Sheaf editor is in the background and a command run from there is about the text
 * editor in front of the person.
 */
function focusedSheafEditor(): MarkdownEditorProvider | undefined {
  return vscode.window.activeTextEditor ? undefined : MarkdownEditorProvider.active;
}

/** The extensions Sheaf's editor is contributed for. */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

/**
 * True when Sheaf's editor is contributed for this file. An Explorer selection can
 * hold anything, and a file carries whatever case it was named with.
 */
function isMarkdownFile(uri: vscode.Uri): boolean {
  const lowercased = uri.path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lowercased.endsWith(extension));
}
