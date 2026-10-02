/*
 * What a consumer implements to put this editor somewhere new.
 *
 * **This is not the wire, and the wire is not wrong.** `protocol.ts` declares 27 messages and should
 * keep declaring 27 messages: a message is a message, and the editor's own hosts switch over them.
 * What a consumer implements is this, and a thin adapter turns these methods into those messages. The
 * two are kept in step by `CONTRACT` below rather than by anybody remembering.
 *
 * **Twelve duties, not the seven the design doc used to claim.** That claim was measured and was
 * wrong: the seven it listed cover 5 of the 27 messages, and the three largest omissions are the ones
 * that decide whether a consumer gets a usable editor rather than a usable demo. Presentation state,
 * without which nothing persists; files beside the document, without which a view over a `.csv` does
 * not work; and settings, without which nothing the person changes is remembered.
 *
 * **Ten methods rather than twelve, because the ten presentation-state messages are one pair keyed by
 * kind.** That is the one grouping decision here and it was made deliberately: the read-and-write
 * split is a getter-and-setter distinction rather than a kind distinction, so ten named methods would
 * encode one axis twice. The condition that makes the pair better rather than merely smaller is that
 * the value type comes from the kind, which `KeptState` does.
 *
 * **Every method is optional except `value` and `applyEdit`.** A host that cannot do a thing says so
 * by not implementing it, and the editor already treats most of these as absent-able: the capability
 * list, and `editor-explains` in the browser host's decision record, are both that idea. The two that
 * are not optional are the two without which there is no editor: the text, and a way to change it.
 */
import { ANSWERS } from './protocol';
import type {
  CommentFolds,
  Duty,
  EditorConfig,
  KeptKind,
  KeptState,
  SelectionRange,
  TableBoards,
  TableWidths,
  ToWebviewType,
} from './protocol';
// The two setting values come from where they are declared rather than through the protocol, which
// imports them for the same reason and does not re-export them.
import type { FrontMatterSetting, OutlineSetting } from './settingValues';

export type { KeptKind, KeptState, CommentFolds, TableBoards, TableWidths, FrontMatterSetting, OutlineSetting };

/** A setting the person changed in the editor, which outlives the document. */
export type HostSetting =
  | { name: 'lineNumbers'; value: boolean }
  | { name: 'tableOfContents'; value: boolean | OutlineSetting }
  | { name: 'frontMatter'; value: FrontMatterSetting };

/** What a data file read came back with: its text, or why not. */
export interface FileAnswer {
  text?: string;
  error?: string;
}

/** Where a saved picture went, or why it did not. */
export interface SavedImage {
  path?: string;
  error?: string;
}

/** What a path resolved to, for the link a paste writes. */
export interface ResolvedPath {
  address?: string;
  title?: string;
}

/*
 * What the editor hands the host, so the host can say things it was not asked.
 *
 * **Writing one adapter is what found this, and the contract was wrong without it.** The first version
 * of `SheafHost` was methods only, on the assumption that a host answers and never speaks first. It
 * does: the browser host pushes `init`, `setContent`, `undoOutsideChange`, `configChanged` and
 * `toggleSourceMode`, and only the last of those is a reply to anything. Seven of its eight pushes are
 * answers that a promise-returning method expresses; these are not.
 *
 * So a consumer implementing the methods alone **could not tell the editor that the file had changed
 * on disk**, in a product whose argument is that git is the store and other programs write your files.
 * That is the load-bearing one. The rest follow the same shape.
 */
export interface SheafEditor {
  /**
   * The document arrived. Sent once, with everything the editor needs to draw it.
   *
   * `lacks` is what this host cannot do, and absent means it can do everything, which is VS Code. A
   * host states only what it lacks so that forgetting to state anything gives the editor its whole
   * surface rather than quietly taking a command away.
   */
  opened(doc: {
    text: string;
    /** The folder's settings. Without these the editor opens with none, which is how this was missed. */
    config: EditorConfig;
    fileName: string;
    resourceBaseUri: string;
    fragment?: string;
    /** Set when the file is a data file shown as one grid rather than a Markdown document. */
    mode?: 'csv';
    /** Shown in place of the editor, for a file this editor will not open. */
    notice?: string;
    /**
     * What this host cannot do. Absent means it can do everything, which is VS Code: a host states
     * only what it lacks, so one that forgets to state anything gives the editor its whole surface
     * rather than quietly taking a command away.
     *
     * Spelled as a list of what is missing where the wire spells it as a record of what is present.
     * That is a deliberate difference and the adapter's job to bridge: `{ terminal: false }` reads as
     * a capability that is there and switched off, and the thing being said is that it is not there.
     */
    lacks?: readonly string[];
  }): void;

  /**
   * The text changed somewhere other than in this editor: another program, a branch switch, a tool.
   *
   * `tookTypedText` says the arriving text does not contain something the person had just typed, which
   * is what lets the editor say so and offer it back rather than losing it silently. Carrying it is the
   * difference between a warning worth believing and one that cries wolf.
   */
  changedOutside(text: string, took?: { tookTypedText?: boolean; ownUndo?: boolean }): void;

  /** The person took back an outside change, so the editor puts its own history straight. */
  outsideChangeUndone(): void;

  /** The folder's settings changed. */
  settingsChanged(config: EditorConfig): void;

  /** Show the whole document's Markdown, which is what a host with no second editor offers instead. */
  showSource(): void;

  /** Scroll to a fragment, which is how a link into a heading arrives. */
  reveal(fragment: string): void;

  /**
   * What is selected, asked for rather than volunteered.
   *
   * **This is the direction I had backwards.** The first version put `selectionChanged` on the host, as
   * though the editor announced its selection. It does not: the host sends `getSelection` and the editor
   * answers, which is how a palette command outside the editor gets a reference to what is selected. A
   * host that never asks needs nothing here, which is why a browser tab, having no palette, does not.
   */
  selection(): Promise<{ ranges: SelectionRange[]; ref: string }>;
}

export interface SheafHost {
  /**
   * Given the editor, once, before anything else.
   *
   * Optional only because a host that answers and never speaks first is a coherent thing to be. Every
   * host that exists today implements it, and one that serves a document from a changing folder has to.
   */
  connect?(editor: SheafEditor): void;

  /** The document's text. Not optional: there is no editor without it. */
  value(): string | Promise<string>;

  /** Replace the document's text. Not optional, for the same reason. */
  applyEdit(text: string): void | Promise<void>;

  /**
   * This document's arrangement, by kind, and the one family that is a store rather than an action.
   *
   * Nothing here says where it is kept or for how long, deliberately: a VS Code window keeps it in
   * `workspaceState`, and whether a browser tab keeps it past a reload is an open product question.
   * These two names survive either answer where `persist`, `save` or `session` would not.
   */
  kept?<K extends KeptKind>(kind: K): Promise<KeptState[K] | null>;
  keep?<K extends KeptKind>(kind: K, value: KeptState[K]): void;

  /** A `.csv` or `.tsv` the document names. `writeFile` resolves when the file has it, or says why not. */
  file?(path: string): Promise<FileAnswer>;
  writeFile?(path: string, base: string, text: string): Promise<{ error?: string }>;
  createFile?(path: string, text: string, nextFree?: boolean): Promise<SavedImage>;

  /** A setting the person changed. One method, because the three differ only in what they carry. */
  setting?(change: HostSetting): void;

  /** A path to a title, and a folder to the files in it, which is what link completion offers. */
  resolve?(path: string): Promise<ResolvedPath>;
  files?(): Promise<string[]>;

  /** A pasted or dropped picture, saved, with its path handed back. */
  saveImage?(name: string, data: string): Promise<SavedImage>;

  /** An address the person followed. */
  openLink?(address: string): void;

  /** The system clipboard. Reading it is the host's job where the page cannot. */
  writeClipboard?(text: string): void;

  /**
   * Things only a particular host can do, which the editor already treats as optional.
   *
   * A host without these is not a host missing something, which is why they are last and why the
   * editor drops the controls that would reach them rather than offering one that does nothing.
   */
  openAsText?(): void;
  runCommand?(command: string): void;
  blurred?(): void;
}

/*
 * Which method serves each duty, so a duty with no home is a compile error.
 *
 * `satisfies Record<Duty, ...>` is the mechanism, and it is the fourth place in this codebase to use
 * it for exactly this: the two decision records, `DUTIES`, and now this. A duty added to the wire's
 * `Duty` union with no entry here does not compile, which is what keeps the contract from falling
 * behind the protocol silently.
 *
 * `null` is how a duty is named as deliberately outside the contract, and nothing uses it today. It
 * exists because the alternative when that day comes is leaving the duty out, which is indistinguishable
 * from forgetting it.
 */
export const CONTRACT = {
  value: ['value'],
  edit: ['applyEdit'],
  kept: ['kept', 'keep'],
  file: ['file', 'writeFile', 'createFile'],
  setting: ['setting'],
  resolve: ['resolve', 'files'],
  image: ['saveImage'],
  link: ['openLink'],
  clipboard: ['writeClipboard'],
  // `selection` is in this duty and has no method here on purpose: the editor answers it rather than
  // the host sending it, so what serves it is `SheafEditor.selection` on the other side.
  'host-action': ['openAsText', 'runCommand', 'blurred'],
} as const satisfies Record<Duty, readonly (keyof SheafHost)[] | null>;

/*
 * Which editor method serves each thing a host says unprompted, so one with no method is a compile
 * error.
 *
 * The set is derived rather than listed: `ToWebview` has 18 messages, 11 of them answers named in
 * `ANSWERS`, and `Exclude` leaves the seven a host says first. Listing them instead would have caught
 * only the ones somebody remembered, and two of the seven are ones I did not: `revealFragment`, which
 * had no method, and `getSelection`, which showed the selection travels the other way from how the
 * first version of this file had it.
 */
export const EDITOR_CONTRACT = {
  init: 'opened',
  setContent: 'changedOutside',
  undoOutsideChange: 'outsideChangeUndone',
  configChanged: 'settingsChanged',
  toggleSourceMode: 'showSource',
  revealFragment: 'reveal',
  getSelection: 'selection',
} as const satisfies Record<Exclude<ToWebviewType, keyof typeof ANSWERS>, keyof SheafEditor>;
