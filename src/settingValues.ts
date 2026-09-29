/*
 * The settings that name a mode, and how a value found in settings becomes one.
 *
 * Three hosts read the same settings: VS Code through `workspace.getConfiguration`,
 * the local server straight out of `.vscode/settings.json`, and the webview from
 * whatever a host sends at `init`. Each setting is read in one place here so the
 * three cannot disagree. A host that reads `tableOfContents` as a boolean, for
 * instance, turns two of the three words it offers into the default without saying
 * so, and the same folder then opens differently in a browser tab than in VS Code.
 */

/** Whether a comment is drawn in full or shrunk to a marker. */
export type CommentsSetting = 'show' | 'hidden';

/**
 * How much of the heading list is drawn.
 *
 * `true` and `false` are the two values this setting had when it was a boolean, and
 * they still mean what they meant: a person who wrote one into their settings before
 * the other two existed does not have to know anything changed.
 */
export type OutlineSetting = 'shown' | 'collapsed' | 'hidden';

/** How much of a document's front matter is drawn. */
export type FrontMatterSetting = 'shown' | 'collapsed' | 'hidden';

/**
 * The setting's value, or `show` for anything that is not one of the two names.
 * A setting nobody can read must not end in comments being drawn as nothing:
 * a person has to be able to see that a comment is there.
 */
export function readComments(value: unknown): CommentsSetting {
  return value === 'hidden' ? 'hidden' : 'show';
}

/** The setting's value, or `hidden`, which is what a folder with no setting gets. */
export function readOutline(value: unknown): OutlineSetting {
  if (value === true) return 'shown';
  if (value === 'shown' || value === 'collapsed') return value;
  return 'hidden';
}

/**
 * The setting's value, or `collapsed` for anything that is not one of the three
 * names, which is also the default: the common case is wanting to know the front
 * matter is there without reading it. An unreadable setting lands on the same value
 * rather than on `hidden`, because a person has to be able to see that it exists.
 */
export function readFrontMatter(value: unknown): FrontMatterSetting {
  return value === 'shown' || value === 'hidden' ? value : 'collapsed';
}
