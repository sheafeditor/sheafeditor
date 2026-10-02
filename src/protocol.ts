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
 * pulling the extension host in behind it. The two values, `DUTIES` and `ANSWERS`, are plain
 * objects of message names and import nothing, so they erase to a few bytes in every bundle and
 * reach neither `vscode` nor a Node builtin, which is what a host check requires of this
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
  /**
   * The answer to `dataFileEdit`: nothing when the file took the edit, a reason when it did not.
   *
   * A host that cannot write files beside the document answers with the reason rather than staying
   * silent, which is what lets the editor say so instead of leaving the grid showing a value the
   * file does not hold.
   */
  | { type: 'dataFileEdited'; id: string; error?: string }
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
  /**
   * An edit to a data file, with the text it was based on so a host can refuse one made
   * against a version it no longer holds. Answered with `dataFileEdited`.
   *
   * The `id` is why this is answered at all. Without it there was nothing for the editor to wait
   * for and nothing for it to report, so a host that dropped the write was indistinguishable from
   * one that made it: a person edited a cell, the grid agreed with them, and the file did not
   * change. `dataFileCreate` beside it has carried an id from the start, which is what made the
   * difference visible.
   */
  | { type: 'dataFileEdit'; id: string; path: string; base: string; text: string; step?: 'undo' | 'redo' }
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
/**
 * The duty each message belongs to, which is what a host actually has to be able to do.
 *
 * It exists because the plan for a host contract named seven duties and they cover 5 of these 27
 * messages. Grouping them turned up three families nobody had listed, and each one is something a
 * consumer embedding the editor cannot do without: keeping a document's arrangement, reading and
 * writing a file the document names, and remembering a setting. An editor implementing the seven as
 * written would render and type and forget everything.
 *
 * `satisfies Record<FromWebviewType, Duty>` is the whole mechanism. A message added to the wire with
 * no duty is a compile error here, which is the same trick the browser host's decision record uses
 * and is better than a check: it fails at the moment somebody writes the message rather than the next
 * time somebody runs something.
 *
 * These are families rather than method names. What a consumer's interface is called, and whether the
 * ten `kept` entries collapse into one pair keyed by kind, is a question about a published API and is
 * deliberately not settled here.
 */
export type Duty =
  /** The document's text, which arrives in `init` and is asked for by `ready`. */
  | 'value'
  /** A change to the document. */
  | 'edit'
  /** This document's arrangement: widths, boards, folds, and which panels are open. */
  | 'kept'
  /** A `.csv` or `.tsv` file the document names, read and written. */
  | 'file'
  /** A setting the person changed, which outlives the document. */
  | 'setting'
  /** A path to a title, or a folder to the files in it. */
  | 'resolve'
  /** A pasted or dropped picture, saved, with its path handed back. */
  | 'image'
  /** An address the person followed. */
  | 'link'
  /** The system clipboard. */
  | 'clipboard'
  /**
   * Something only a particular host can do, and which the editor already treats as optional: show
   * the source another way, run one of the host's own commands, hear about focus leaving, or be told
   * the selection it never asked for. A host without these is not a host missing something.
   */
  | 'host-action';

export const DUTIES = {
  ready: 'value',
  edit: 'edit',

  tableWidthsRead: 'kept',
  tableWidthsWrite: 'kept',
  tableBoardsRead: 'kept',
  tableBoardsWrite: 'kept',
  commentFoldsRead: 'kept',
  commentFoldsWrite: 'kept',
  frontMatterStateRead: 'kept',
  frontMatterStateWrite: 'kept',
  outlineStateRead: 'kept',
  outlineStateWrite: 'kept',

  dataFileRead: 'file',
  dataFileEdit: 'file',
  dataFileCreate: 'file',

  setLineNumbers: 'setting',
  setTableOfContents: 'setting',
  setFrontMatter: 'setting',

  docTitleRead: 'resolve',
  workspaceFilesRead: 'resolve',

  saveImage: 'image',
  openLink: 'link',
  clipboardWrite: 'clipboard',

  openAsText: 'host-action',
  runCommand: 'host-action',
  selection: 'host-action',
  blur: 'host-action',
} as const satisfies Record<FromWebviewType, Duty>;

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
  dataFileEdited: 'dataFileEdit',
} as const satisfies Partial<Record<ToWebviewType, FromWebviewType>>;

/*
 * The arrangement a document carries, by kind: the one family of the host contract that is a store
 * rather than an action.
 *
 * **Five kinds times two directions, which is why the contract has a pair here and not ten methods.**
 * The wire spells all ten out, `tableWidthsRead` through `outlineStateWrite`, and it is right to: a
 * message is a message. A consumer implementing the contract sees one getter and one setter, because
 * the read-and-write split is a getter-and-setter distinction rather than a kind distinction, and ten
 * named methods encode one axis twice.
 *
 * **The value type comes from the kind, and that condition is the whole of why the pair is better.**
 * A setter taking `TableWidths | TableBoards | CommentFolds | FrontMatterSetting | null` would let
 * `keep('commentFolds', 'collapsed')` compile, and every implementation would narrow by hand at
 * exactly the boundary the type was there for. Through `KeptState` the pairing is checked, adding a
 * kind is one entry, and a consumer cannot get a pairing wrong.
 *
 * **Nothing here says where an arrangement is kept or for how long, deliberately.** The two hosts
 * disagree about that today: a VS Code window keeps it in `workspaceState`, and whether a browser tab
 * keeps it past a reload is an open product question. `kept` and `keep` survive either answer, which
 * `persist`, `save` or `session` would not. How long it lasts is the host's business and belongs in
 * the host's own documentation.
 */
export type KeptKind = 'tableWidths' | 'tableBoards' | 'commentFolds' | 'frontMatterState' | 'outlineState';

/**
 * What each kind's value is.
 *
 * A kind added to `KeptKind` is a compile error in three places until it is entered here and in
 * `KEPT_WIRE`: the `satisfies` below, and both signatures of `KeptStore`, which index this.
 */
export interface KeptState {
  tableWidths: TableWidths;
  tableBoards: TableBoards;
  commentFolds: CommentFolds;
  frontMatterState: FrontMatterSetting | null;
  outlineState: OutlineSetting | null;
}

/*
 * Each kind's three wire names and the field its value travels in.
 *
 * The field differs per kind, `widths`, `boards`, `folds`, `state`, `state`, so an adapter turning the
 * pair into messages needs this rather than a naming convention. Held exhaustive the way the three
 * records above are held: a kind with no entry, or an entry naming a message that does not exist, is
 * a compile error rather than something a check has to notice.
 */
export const KEPT_WIRE = {
  tableWidths: { read: 'tableWidthsRead', write: 'tableWidthsWrite', answer: 'tableWidths', field: 'widths' },
  tableBoards: { read: 'tableBoardsRead', write: 'tableBoardsWrite', answer: 'tableBoards', field: 'boards' },
  commentFolds: { read: 'commentFoldsRead', write: 'commentFoldsWrite', answer: 'commentFolds', field: 'folds' },
  frontMatterState: { read: 'frontMatterStateRead', write: 'frontMatterStateWrite', answer: 'frontMatterState', field: 'state' },
  outlineState: { read: 'outlineStateRead', write: 'outlineStateWrite', answer: 'outlineState', field: 'state' },
} as const satisfies Record<
  KeptKind,
  { read: FromWebviewType; write: FromWebviewType; answer: ToWebviewType; field: string }
>;

/**
 * The two methods a host implements for that family.
 *
 * `kept` is a promise because all five reads carry an `id` and all five answers carry it back, checked
 * rather than assumed: the correlation is uniform across the five, so the promise shape has no
 * exception in it. The five writes carry no id and nothing answers them, which is why `keep` returns
 * nothing.
 */
export interface KeptStore {
  kept<K extends KeptKind>(kind: K): Promise<KeptState[K] | null>;
  keep<K extends KeptKind>(kind: K, value: KeptState[K]): void;
}
