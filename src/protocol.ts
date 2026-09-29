/**
 * The messages the editor posts out to whatever host it is running in.
 *
 * One declaration, imported by every host, because the alternative is what was here
 * before: the extension host described these messages in its own file and the browser
 * host declared `{ type: string; [key: string]: unknown }`, which accepts anything. The
 * two sides of one boundary each holding their own idea of it, with nothing comparing
 * them, is how `setLineNumbers` came to have no case in the browser host at all. The
 * line-numbers button turned them on and then did nothing for ever, and the check meant
 * to catch exactly that compared against a list somebody had typed by hand.
 *
 * So a host that reads these switches on this type, and a message added here with no
 * decision made about that host is a compile error rather than a green suite.
 *
 * Almost nothing here has a runtime part. The settings types are imported for their shapes
 * alone and erased, which is what lets the browser's own bundle read this file without
 * pulling the extension host in behind it. The one value, `ANSWERS`, is a plain object of
 * message names and imports nothing, so it erases to a few bytes in every bundle and
 * reaches neither `vscode` nor a Node builtin, which is what a host check requires of this
 * file.
 */

import type { CommentsSetting, FrontMatterSetting, OutlineSetting } from './settingValues';

/** The lines one of the webview's selected ranges covers, counted from one. */
export interface SelectionRange {
  start: number;
  end: number;
}

/**
 * Column widths set by hand in one document's tables: by table key (the webview's
 * digest of a table's header row), then by column index, in pixels.
 */
export type TableWidths = Record<string, Record<string, number>>;

/**
 * The pipe tables in one document shown as boards: by table key (the same digest
 * of the header row the widths use), the header text of the column each is
 * grouped by.
 */
export type TableBoards = Record<string, { group: string }>;

/**
 * The comments collapsed in one document: by comment key (the webview's digest of
 * the comment's own text), and nothing else, because collapsed is all there is to
 * say. A comment that is open is simply absent.
 */
export type CommentFolds = Record<string, true>;

/**
 * The settings the editor reads, as a host hands them over.
 *
 * This was declared three times: once by the extension host, once by the browser host in
 * `src/server/settings.ts`, and once by the editor in `src/webview/main.ts`. Three
 * statements of one wire type with nothing comparing them, which is the reason a host
 * could grow a setting the editor drew a button for and no check could see the gap.
 *
 * Two of the three are gone. The editor's copy in `src/webview/main.ts` is the one left,
 * and it is tracked with the rest of the union it sits in rather than on its own.
 */
export interface EditorConfig {
  contentWidth: string;
  /**
   * Whether the line-number gutter is drawn. A setting rather than something kept per
   * document, because it is a habit of the person: VS Code settles its own the same way.
   */
  lineNumbers: boolean;
  revealSyntaxOnLine: boolean;
  doubleClickToEditSource: boolean;
  tableOfContents: OutlineSetting;
  comments: CommentsSetting;
  frontMatter: FrontMatterSetting;
}

/** Messages sent host -> webview. */
export type ToWebview =
  | {
      type: 'init';
      text: string;
      config: EditorConfig;
      fileName: string;
      resourceBaseUri: string;
      fragment?: string;
      /** Set when the file is a data file shown as one grid, rather than a Markdown document. */
      mode?: 'csv';
      /** Shown in place of the editor, for a file this editor will not open. */
      notice?: string;
      /**
       * What the host behind this editor cannot do. Absent means it can do everything,
       * which is VS Code: a host states only what it lacks, so a host that forgets to
       * state anything gives the editor its whole surface rather than silently taking a
       * command away.
       *
       * It was missing from this declaration while both hosts already used it, the
       * browser one sending it and the editor reading it. Object spread carries a
       * property no declaration mentions, so the send compiled, and a misspelling on
       * either side would have put **Send to terminal** back in a browser tab's menu
       * pointing at a terminal that is not there.
       */
      capabilities?: { terminal?: boolean };
    }
  | { type: 'setContent'; text: string; tookTypedText?: boolean; ownUndo?: boolean }
  | { type: 'revealFragment'; id: string }
  | { type: 'undoOutsideChange' }
  | { type: 'configChanged'; config: EditorConfig }
  | { type: 'imageSaved'; id: string; path?: string; error?: string }
  | { type: 'workspaceFiles'; id: string; files: string[] }
  /**
   * The answer to `docTitleRead`: the pasted path as an address relative to this document,
   * and the target's own title. Both are left out when the path names nothing the editor
   * should link — a file outside the workspace, one that is not Markdown, one that is not
   * there — and the paste stays a plain paste.
   */
  | { type: 'docTitle'; id: string; address?: string; title?: string }
  | { type: 'tableWidths'; id: string; widths: TableWidths }
  | { type: 'tableBoards'; id: string; boards: TableBoards }
  | { type: 'commentFolds'; id: string; folds: CommentFolds }
  | { type: 'frontMatterState'; id: string; state: FrontMatterSetting | null }
  | { type: 'outlineState'; id: string; state: OutlineSetting | null }
  /**
   * A data file a view block reads, by the path the view wrote. Sent in answer to
   * `dataFileRead` with its `id`, and again without one whenever the file changes.
   */
  | {
      type: 'dataFile';
      id?: string;
      path: string;
      text?: string;
      error?: string;
      notice?: string;
      /** Set with `error` when the path is one Sheaf may read and there is simply no file there yet. */
      missing?: boolean;
    }
  /**
   * The answer to `dataFileCreate`: the path the file was written at, as the
   * document should name it, or why nothing was written.
   */
  | { type: 'dataFileCreated'; id: string; path?: string; error?: string }
  | { type: 'getSelection'; id: string }
  | { type: 'toggleSourceMode' };

/** Messages sent webview -> host. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'openAsText' }
  | { type: 'clipboardWrite'; text: string }
  /** The workspace's files, for completing a link's address. */
  | { type: 'workspaceFilesRead'; id: string }
  /**
   * What a pasted path names, for writing a link to another document with the document's
   * own title as its words. `path` is the text that was pasted: a path relative to this
   * document, an absolute one, or a `file:` URL. Answered with `docTitle`.
   */
  | { type: 'docTitleRead'; id: string; path: string }
  /** The column widths set by hand in this document's tables, and keeping them. */
  | { type: 'tableWidthsRead'; id: string }
  | { type: 'tableWidthsWrite'; widths: TableWidths }
  /** The pipe tables in this document shown as boards, and keeping them. */
  | { type: 'tableBoardsRead'; id: string }
  | { type: 'tableBoardsWrite'; boards: TableBoards }
  /** The comments collapsed in this document, and keeping them. */
  | { type: 'commentFoldsRead'; id: string }
  | { type: 'commentFoldsWrite'; folds: CommentFolds }
  | { type: 'frontMatterStateRead'; id: string }
  | { type: 'frontMatterStateWrite'; state: FrontMatterSetting | null }
  | { type: 'outlineStateRead'; id: string }
  | { type: 'outlineStateWrite'; state: OutlineSetting | null }
  /** A .csv or .tsv file a view block names, relative to the document. */
  | { type: 'dataFileRead'; id: string; path: string }
  /**
   * An edit made through a view of a data file: the whole of the file's new text,
   * and `base`, the text the edit was made against, both in the webview's line
   * endings and without a byte-order mark. Written as the one changed range.
   * `step` marks the undo or redo of an earlier such edit, sent as its inverse,
   * which only changes what a refusal says.
   */
  | { type: 'dataFileEdit'; path: string; base: string; text: string; step?: 'undo' | 'redo' }
  /**
   * A new .csv or .tsv file, relative to the document, holding `text` in the
   * webview's line endings. Never written over an existing file: with `nextFree`
   * the next free name is taken instead (`tasks-2.csv`), and without it the
   * request is refused. Answered with `dataFileCreated`.
   */
  | { type: 'dataFileCreate'; id: string; path: string; text: string; nextFree?: boolean }
  | { type: 'saveImage'; id: string; name: string; data: string }
  | { type: 'openLink'; address: string }
  | { type: 'setLineNumbers'; on: boolean }
  | { type: 'setTableOfContents'; on: boolean | OutlineSetting }
  /** Make what this document is doing the setting, so every other document follows it. */
  | { type: 'setFrontMatter'; state: FrontMatterSetting }
  | { type: 'selection'; ranges: SelectionRange[]; ref: string; id?: string }
  | { type: 'runCommand'; command: string }
  /** Keyboard focus has left the page, to the tab bar or anywhere else in the window. */
  | { type: 'blur' };

/** The name of one of those messages. */
export type FromWebviewType = FromWebview['type'];

/** The name of one of the messages a host sends the editor. */
export type ToWebviewType = ToWebview['type'];

/**
 * For each message a host sends only in answer to one of the editor's, the message it
 * answers.
 *
 * A host's decision about one of these is the decision it already made about the request.
 * A host that answers `workspaceFilesRead` sends `workspaceFiles`; one that does not, sends
 * nothing and the editor says so to the reader. Declaring the pairing here lets a check
 * derive the second from the first, rather than a second record restating it: the same fact
 * written down twice with nothing comparing the two is what every defect this file was
 * written for had in common.
 *
 * Only the one-for-one pairs. `configChanged` answers three different settings messages and
 * `setContent` is pushed whenever the file moves, so neither belongs here.
 */
export const ANSWERS = {
  imageSaved: 'saveImage',
  workspaceFiles: 'workspaceFilesRead',
  docTitle: 'docTitleRead',
  tableWidths: 'tableWidthsRead',
  tableBoards: 'tableBoardsRead',
  commentFolds: 'commentFoldsRead',
  frontMatterState: 'frontMatterStateRead',
  outlineState: 'outlineStateRead',
  dataFile: 'dataFileRead',
  dataFileCreated: 'dataFileCreate',
} as const satisfies Partial<Record<ToWebviewType, FromWebviewType>>;
