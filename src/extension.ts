import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';
import { registerDefaultEditorSync } from './defaultEditor';

export function activate(context: vscode.ExtensionContext): void {
  // Register the WYSIWYG custom editor for Markdown files.
  context.subscriptions.push(MarkdownEditorProvider.register(context));

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
    vscode.commands.registerCommand('sheaf.openAsText', async (uri?: vscode.Uri) => {
      const target = uri ?? (focusedSheafEditor() ? MarkdownEditorProvider.activeUri : undefined);
      if (!target) {
        // Run from a plain text editor, or with nothing open at all: what the
        // person is looking at is raw Markdown already.
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, 'default');
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
