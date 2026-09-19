import * as vscode from 'vscode';

/**
 * Keeps `workbench.editorAssociations` in sync with the
 * `sheaf.useAsDefaultMarkdownEditor` setting.
 *
 * Sheaf contributes its custom editor with `priority: "default"`, which is static
 * package.json metadata — it cannot be changed at runtime. The only lever VS Code
 * gives an extension is the `workbench.editorAssociations` setting, which wins over
 * a contributed default. So "don't open Markdown in Sheaf" is expressed by writing
 * `"*.md": "default"` (VS Code's plain text editor), and "do open it in Sheaf" by
 * removing that entry again.
 *
 * Associations the user pointed at some *other* editor are never touched — that is a
 * deliberate choice Sheaf has no business overriding.
 */

/** File patterns Sheaf's custom editor is contributed for, as the manifest spells them. */
export const PATTERNS = ['*.md', '*.markdown'] as const;

/** VS Code's built-in plain text editor. */
const TEXT_EDITOR = 'default';

/** The view type Sheaf's custom editor is registered under today. */
const VIEW_TYPE = 'sheaf.wysiwyg';

/**
 * View types Sheaf registered under before the extension was renamed. Nothing
 * provides these any more, so an association still naming one sends Markdown to an
 * editor that does not exist — and since `workbench.editorAssociations` outranks a
 * contributed default, Sheaf never gets a look in. Clearing them is the fix.
 */
const RETIRED_VIEW_TYPES = ['diffless.wysiwyg', 'md-editor.wysiwyg', 'nib.wysiwyg'];

/**
 * Associations that are Sheaf's to rewrite. Anything else the user pointed `*.md`
 * at is a deliberate choice Sheaf has no business overriding.
 */
const OWNED_VIEW_TYPES = [VIEW_TYPE, ...RETIRED_VIEW_TYPES];

const ASSOCIATIONS_KEY = 'workbench.editorAssociations';
const SETTING_KEY = 'sheaf.useAsDefaultMarkdownEditor';

type Associations = Record<string, string>;

/** The scopes an opt-out can be sitting in, narrowest first. */
const SCOPES = [
  vscode.ConfigurationTarget.Workspace,
  vscode.ConfigurationTarget.Global,
] as const;

/**
 * Write a new opt-out into the same scope the user set the Sheaf setting in, so a
 * workspace-level opt-out doesn't silently rewrite the user's global settings.
 */
function targetScope(): vscode.ConfigurationTarget {
  const inspected = vscode.workspace.getConfiguration().inspect<boolean>(SETTING_KEY);
  return inspected?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function readAssociations(target: vscode.ConfigurationTarget): Associations {
  const inspected = vscode.workspace.getConfiguration().inspect<Associations>(ASSOCIATIONS_KEY);
  const value =
    target === vscode.ConfigurationTarget.Workspace
      ? inspected?.workspaceValue
      : inspected?.globalValue;
  return { ...(value ?? {}) };
}

async function writeAssociations(
  target: vscode.ConfigurationTarget,
  associations: Associations
): Promise<void> {
  try {
    await vscode.workspace.getConfiguration().update(ASSOCIATIONS_KEY, associations, target);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `Sheaf could not update "${ASSOCIATIONS_KEY}" (${detail}). ` +
        'Markdown files will keep opening in whichever editor that setting names.'
    );
  }
}

/**
 * Drop Sheaf's own opt-out, and any association left over from a previous name, from
 * one scope so Sheaf's contributed default applies again. A scope with nothing of
 * ours in it is never written to — which is also what keeps this from writing
 * workspace settings when there is no workspace.
 */
async function clearOptOut(target: vscode.ConfigurationTarget): Promise<void> {
  const associations = readAssociations(target);
  let changed = false;

  for (const pattern of PATTERNS) {
    const current = associations[pattern];
    if (current === TEXT_EDITOR || (current !== undefined && RETIRED_VIEW_TYPES.includes(current))) {
      delete associations[pattern];
      changed = true;
    }
  }

  if (changed) {
    await writeAssociations(target, associations);
  }
}

/** Point Markdown at the plain text editor in one scope. */
async function writeOptOut(target: vscode.ConfigurationTarget): Promise<void> {
  const associations = readAssociations(target);
  let changed = false;

  for (const pattern of PATTERNS) {
    const current = associations[pattern];
    if (current === undefined || OWNED_VIEW_TYPES.includes(current)) {
      associations[pattern] = TEXT_EDITOR;
      changed = true;
    }
  }

  if (changed) {
    await writeAssociations(target, associations);
  }
}

/**
 * Apply the setting to `workbench.editorAssociations`, writing only when something
 * actually needs to change (this also stops the configuration-change listener that
 * calls us from looping).
 */
export async function syncDefaultEditorAssociation(): Promise<void> {
  const useSheaf = vscode.workspace
    .getConfiguration('sheaf')
    .get<boolean>('useAsDefaultMarkdownEditor', true);

  if (!useSheaf) {
    await writeOptOut(targetScope());
    return;
  }

  // Sheaf is on for this window, so no opt-out of ours may be left in force in any
  // scope: an association outranks Sheaf's contributed default wherever it was
  // written, and that is not always the scope the setting was last changed in. Turn
  // Sheaf off for a workspace and then reset that setting, and the opt-out stays
  // behind in the workspace while the setting reads on; turn it off in user settings
  // and on for one workspace, and the opt-out stays behind in user settings.
  for (const scope of SCOPES) {
    await clearOptOut(scope);
  }
}

/**
 * Sync now, and again whenever the setting changes. Already-open editors keep the
 * editor they were opened with; the change applies to files opened afterwards.
 */
export function registerDefaultEditorSync(): vscode.Disposable {
  void syncDefaultEditorAssociation();

  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SETTING_KEY)) {
      void syncDefaultEditorAssociation();
    }
  });
}
