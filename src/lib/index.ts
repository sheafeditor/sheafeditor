/*
 * The package's main entry: one function that puts a Sheaf surface in an element.
 *
 * **A mounted surface is not an editor until it is focused**, and that is the whole shape of this
 * file. `mount` draws the Markdown with `renderMarkdown` — a parser and a string walk, no
 * CodeMirror — and makes the element focusable. The editor is built on the first focus, from
 * `./editor`, which the bundler puts in its own file. So the cost of a list of fifty mounted fields
 * is fifty rendered strings, and the editor arrives for the one somebody clicks into.
 *
 * The consequence a consumer has to know is that a surface they have mounted and nobody has touched
 * has no `EditorView` behind it, so `value()` answers from the string this module holds rather than
 * from a document. `scripts/check-package.mjs` reads the build's metafile and fails if
 * `@codemirror/view` reaches this entry's eager closure, which is the only way to tell "it rendered"
 * from "it mounted an editor that happens to look rendered".
 *
 * **Nothing here runs at import.** No global is read, no element is found, nothing is appended to
 * `document`. A consumer who imports this module and renders nothing has an unchanged page.
 */
import { renderMarkdown } from '../render/markdown';
import { moduleDirectory, setAssetBase, setAssetBaseDefault } from '../webview/assetBase';
import { planEdit, toWebviewText } from '../textSync';
import { inkBefore, sideOf } from './inkOffset';
import type { Side } from './inkOffset';
import type { OutOfScope, Profile } from '../render/markdown';
import type { KeptKind, KeptState, HostSetting, SheafHost } from '../hostContract';

export { renderMarkdown } from '../render/markdown';
export type { Profile, OutOfScope, RenderResult } from '../render/markdown';
export type {
  SheafHost,
  SheafEditor,
  HostSetting,
  KeptKind,
  KeptState,
  CommentFolds,
  TableBoards,
  TableWidths,
  FrontMatterSetting,
  OutlineSetting,
} from '../hostContract';

/**
 * What a consumer may implement of the host contract for a mounted surface.
 *
 * **Three of the contract's sixteen methods, and the other thirteen are not a consumer's to supply
 * here.** `value` and `applyEdit` are the two that are never optional, and a mount already has
 * them: the text comes from `options.value` and a change goes out through `options.onChange`, so
 * handing them over as well would be two sources for one fact. The rest of `SheafHost` serves
 * duties a `field` or a `notes` surface does not have — files beside the document, image saving,
 * link resolution, a terminal.
 *
 * What is left is the storage: the arrangement of this surface, and the settings that outlive it.
 */
export type MountHost = Pick<SheafHost, 'kept' | 'keep' | 'setting'>;

export interface MountOptions {
  /** The Markdown this surface holds. */
  value: string;
  /** `field` is one line of inline Markdown; `notes` adds the block constructs. Default `notes`. */
  profile?: Profile;
  /**
   * Where this surface's arrangement and the person's settings are kept.
   *
   * Absent means the default below, which keeps them in memory for as long as the mount lives. What
   * that costs is under "Storage, or the default" in `README.md` and is worth knowing before taking
   * it: nothing persists.
   */
  host?: MountHost;
  /**
   * Called with the whole text after every change a person makes, once per change, so a consumer
   * can save on each call, debounce it, or save on blur. A value the consumer sets with `setValue`
   * is theirs already and is not reported back.
   */
  onChange?(value: string): void;
  /** Draw everything the profile carries, and take no edits. */
  readOnly?: boolean;
  /** Put on the element this mount creates, so a consumer can style one surface among many. */
  className?: string;
  /**
   * The directory this package's files are served from, for the ones no bundler can see.
   *
   * Almost nothing needs this. The editor and its chunks are reached by relative module specifier,
   * so your bundler emits them and the browser resolves them against each other wherever they land;
   * the stylesheets and the fonts `webview.css` names are resolved by your CSS pipeline the same
   * way. What is left is a file this package copies in whole rather than bundling, which is the
   * diagram library, and neither profile `mount` offers draws a diagram. So the honest answer today
   * is that you can leave this out, and "What you have to serve" in `README.md` says what that
   * means.
   *
   * Set it when the files do not sit beside the code: another origin, a CDN, a path your pipeline
   * chose. Absent, the default is the directory this module was served from, which is where your
   * bundler puts `chunks/`.
   *
   * **It is a property of your deployment rather than of one surface.** Two mounts on one page share
   * it, and an explicit value is never overwritten by another mount's default. Pass the same value
   * or pass it once.
   */
  assets?: string;
}

export interface SheafSurface {
  /** The element this mount created inside the one it was given. */
  readonly element: HTMLElement;
  /**
   * The host this surface answers to: the one the consumer passed, or the in-memory default.
   *
   * Readable rather than private, so a consumer can tell which of the two they got. A mount that
   * silently fell back to the default is the one mistake here that produces no symptom until a
   * reload, and reading this is how it is caught.
   */
  readonly host: MountHost;
  /** The text as it now stands, whether or not an editor was ever built. */
  value(): string;
  /** A new value from the consumer. An open editor keeps its caret. */
  setValue(text: string): void;
  /** Build the editor if it is not built, and put the caret in it. */
  focus(): void;
  /** Whether the editor has been built. False for a surface nobody has focused. */
  editing(): boolean;
  /** What this profile did not understand in the current value, as `renderMarkdown` reports it. */
  outOfScope(): OutOfScope[];
  /** Take the mount down. Nothing it registered fires afterwards and nothing it added remains. */
  destroy(): void;
}

/**
 * The host a consumer gets when they supply none: this surface's own memory, and nothing else.
 *
 * It is a real implementation of the three methods rather than an absence, which is the choice
 * worth naming. A missing `kept` means every control that reads stored arrangement takes its
 * default on every update, so a column dragged wider snaps back mid-gesture; an in-memory one means
 * it holds for the life of the mount and is gone on the next. The second is what a consumer who has
 * not thought about storage expects, and the first is what they would get for free.
 */
function memoryHost(): MountHost {
  const kept = new Map<string, unknown>();
  return {
    kept: <K extends KeptKind>(kind: K) => Promise.resolve((kept.get(kind) as KeptState[K] | undefined) ?? null),
    keep: <K extends KeptKind>(kind: K, value: KeptState[K]) => void kept.set(kind, value),
    setting: (_change: HostSetting) => {},
  };
}

/**
 * Put a Sheaf surface in `el`.
 *
 * One call, and no second one a consumer has to make for the editor to work. Everything it needs
 * comes from its arguments, so the same module works in a page the editor's authors have never
 * seen, and two mounts on one page share nothing this function holds.
 */
/**
 * Whether this document writes its line endings as CRLF, judged by the first one in it.
 *
 * `planEdit` consults this only where a replacement carries a newline and the span it replaces
 * had none to copy, which is a line being added rather than changed. Every other ending comes
 * from the text it replaces, so this answer is the narrow fallback and not the general rule.
 *
 * A document with no ending at all is not CRLF, which matters for a one-line field: the honest
 * answer for a title with no newline in it is the one that adds none.
 */
function crlfDocument(text: string): boolean {
  const first = /\r\n|\n|\r/.exec(text);
  return first !== null && first[0] === '\r\n';
}

/**
 * How many characters of the rendered surface come before the point under `(x, y)`, and which side
 * of them the point is on, or `null`.
 *
 * The browser is asked for the caret position at the point, by the standard query or by the older
 * one Chromium and WebKit kept, and the answer is counted the way `inkOffset.ts` describes. A point
 * over nothing of this surface's, and a browser that offers neither query, both give `null`, and the
 * caller falls back to the coordinates.
 */
function textUnder(element: HTMLElement, x: number, y: number): { count: number; side: Side } | null {
  const doc = element.ownerDocument as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretPositionFromPoint === 'function') {
    const at = doc.caretPositionFromPoint(x, y);
    if (at) ({ offsetNode: node, offset } = at);
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const at = doc.caretRangeFromPoint(x, y);
    if (at) ({ startContainer: node, startOffset: offset } = at);
  }
  if (!node) return null;
  const count = inkBefore(element, node, offset);
  return count === null ? null : { count, side: sideOf(node, offset) };
}

/**
 * This module's own address, which is what the default asset base is derived from.
 *
 * `import.meta.url` answers it *here* rather than wherever a file is actually fetched: this is an
 * entry point, so the output is `lib/index.js` and `lib/chunks/` is beside it, while a module deeper
 * in lands in `lib/chunks/chunk-*.js` and would name that directory instead. `moduleDirectory`
 * carries the conversion and the guard for the build that has no module URL.
 *
 * **The suppression is about the type check rather than about the code.** `tsconfig.json` sets
 * `module: Node16`, and this package declares no `"type": "module"`, so TypeScript reads every `.ts`
 * here as building into CommonJS and refuses `import.meta` outright (TS1470). esbuild builds this
 * entry as an ES module where it is correct, which is measurable rather than asserted:
 * `media/webview.js` and `lib/index.js` both carry `import.meta.url` verbatim after a build.
 * `module: Preserve` with `moduleResolution: Bundler` is the setting that would make the directive
 * unnecessary, and that is a change to the type check's own configuration rather than to this file.
 *
 * It cannot outlive that change quietly: an `@ts-expect-error` with no error under it fails the type
 * check as an unused directive, so whoever fixes the configuration is told to delete both of these.
 */
function hereUrl(): string | undefined {
  // @ts-expect-error TS1470, which `module: Node16` raises and the ES module esbuild emits does not.
  return import.meta.url as string | undefined;
}

export function mount(el: HTMLElement, options: MountOptions): SheafSurface {
  /*
   * Where this package's files are, before anything that could ask for one is built.
   *
   * The default is the directory this module was served from, and this module is an entry point, so
   * `import.meta.url` is `lib/index.js` and `lib/chunks/` is its neighbour. It is a *default* rather
   * than a setting: `setAssetBaseDefault` never overwrites a value a consumer gave, so a second
   * mount that passes nothing cannot take away the first one's `assets`.
   *
   * `import.meta.url` is `undefined` in a CommonJS bundle, which the suites are, so the default is
   * empty there and a scenario that needs one says so itself.
   */
  setAssetBaseDefault(moduleDirectory(hereUrl()));
  if (options.assets !== undefined) setAssetBase(options.assets);

  const profile: Profile = options.profile ?? 'notes';
  const host = options.host ?? memoryHost();
  const readOnly = options.readOnly ?? false;
  let text = options.value;
  let scope: OutOfScope[] = [];
  let destroyed = false;

  /*
   * The consumer's own bytes, brought up to date with what the editor holds.
   *
   * **`text` is the authority and the editor is not.** The editor holds every line ending as a
   * single `\n`, because that is what CodeMirror turns them into, so reading a value straight out
   * of it converts a CRLF or lone-CR document the moment one exists. The two hosts answer this
   * with a pair of functions and this is the third consumer of them: `toWebviewText` on the way
   * in, `planEdit` on the way back. `planEdit` returns null when the editor's text is what the
   * document already says, which is the unedited case and costs a comparison.
   *
   * Each ending in a replacement comes from the span it replaces, so endings the person did not
   * touch survive an edit that moved a line between them, and a document with mixed endings comes
   * out right without anybody deciding what it ought to have.
   */
  const upToDate = (held: string): string => planEdit(text, held, crlfDocument(text))?.text ?? text;

  const element = el.ownerDocument.createElement('div');
  element.className = ['sheaf-surface', `sheaf-surface-${profile}`, options.className ?? ''].filter(Boolean).join(' ');
  /*
   * The rendered surface covers the whole of the box it was mounted into, not just its text.
   *
   * A consumer gives their element a height, which is what `README.md` tells them to do for a
   * `notes` surface. The rendered state was sized to its content, so the rest of that box was not
   * the surface at all: measured in Chromium, a one-line value in a 320px box left 290px that
   * belonged to the consumer's own element, and a click there focused nothing, built no editor and
   * gave the person no caret and no feedback. On a short description that is the most ordinary
   * gesture there is, because the box looks like an input.
   *
   * **`minHeight` rather than `height`, and that is the whole of the care needed here.** The
   * documented default is a surface that sizes itself when the consumer sets no height, and a
   * consumer relying on it must not get a collapsed element. A `minHeight` cannot take that away
   * in either direction: against a box with no height of its own it contributes nothing and the
   * content decides, against a sized one it fills, and a value taller than the box is left alone
   * both times. A `height` would also fill, and it would make the element shorter than its own
   * content whenever a value overflows a box that has a height, which is a state nothing reading
   * `offsetHeight` has had to deal with before. Measured in Chromium, all three cases: 320px in a
   * 320px box, 18px in a box with no height, and 550px for a value taller than its box.
   *
   * The editor's own `height: 100%` is still set in `build` below, for the different reason given
   * there. This one is about which element a point in the box belongs to before that happens.
   */
  element.style.minHeight = '100%';
  /*
   * A rendered `field` is one line however long its value is, and the end of a long one is cut off
   * at the box's edge, which is what an `<input>` nobody has focused shows. The editor that replaces
   * it scrolls the same line sideways instead (`oneLineScroll` in `editor.ts`), so a field is the
   * same height before the first click and after it, whatever it holds. Wrapping here as well would
   * have put a long title on two lines until somebody clicked it and on one line afterwards.
   *
   * Inline styles rather than a rule in the stylesheet, because they are taken off again when the
   * editor is built and the editor's own box needs neither.
   */
  if (profile === 'field') {
    element.style.whiteSpace = 'nowrap';
    element.style.overflow = 'hidden';
  }
  /*
   * Focusable, because the focus is what builds the editor and an element with no `tabindex` never
   * receives one. Taken off again the moment the editor exists: CodeMirror's own content element
   * is then the focus target, and leaving a focusable wrapper around it puts two stops in the tab
   * order for one field.
   */
  element.tabIndex = 0;

  const draw = (): void => {
    const result = renderMarkdown(text, profile);
    scope = result.outOfScope;
    element.innerHTML = result.html;
  };

  /*
   * `./editor.js`, with the extension, because `moduleResolution: Node16` requires one on a
   * relative import in an ES module and the file on disk after the build is `lib/editor.js`.
   * esbuild resolves it to `src/lib/editor.ts`, which is also an entry point of the same build, so
   * the dynamic import points at the output the `exports` map names rather than at a chunk.
   */
  type EditorModule = typeof import('./editor.js');
  type Editor = ReturnType<EditorModule['createSurfaceEditor']>;
  let editor: Editor | null = null;
  let building: Promise<Editor | null> | null = null;

  /*
   * Where the pointer was when the gesture that is about to build the editor began.
   *
   * **The focus event cannot carry this.** `focusin` has no coordinates, and it is the event that
   * builds the editor, so the position of the click has to be taken from the event before it and
   * held. `pointerdown` is that event: the browser focuses a `tabindex` element as the default
   * action of `pointerdown`, so it has already run by the time `onFocus` is called, for a mouse,
   * a finger and a pen alike.
   *
   * Without it the first click into a mounted surface put the caret at index 0 whatever the person
   * pointed at, and every click after it was correct, because by then there was a view to click
   * into. That is once per surface, on the gesture the whole render-then-focus arrangement is built
   * around.
   *
   * It is consumed rather than read, because a focus with no pointer behind it (a consumer's
   * `surface.focus()`, a Tab into the element) must not inherit the position of an earlier click.
   * The editor is built once, so there is no second gesture to serve.
   */
  let pointedAt: { x: number; y: number } | null = null;
  /*
   * The same gesture, read as the text it was over rather than as a point on screen.
   *
   * The coordinates above are what the caret used to be placed by, and they named the wrong text:
   * the editor that replaces the rendered state draws the same value with its own padding and, in a
   * `notes` surface, its own side gutter, so a click on the second paragraph of a rendered value
   * landed in the first paragraph of the editor. The rendered state is still on screen at
   * `pointerdown`, so it is asked here which character was under the pointer, and that is carried
   * across as a count of the characters before it. `inkOffset.ts` says what is counted and why.
   *
   * `null` when the browser cannot say, which is jsdom and any engine with neither caret query,
   * or when the pointer was over something that is not this surface's text. The coordinates are
   * then the fallback, and they are what they always were.
   */
  let pointedText: { count: number; side: Side } | null = null;

  const build = (): Promise<Editor | null> => {
    if (building) return building;
    building = import('./editor.js')
      .then((mod): Editor | null => {
        /*
         * The mount may have been taken down while the editor was in flight, which in a
         * single-page application is an ordinary navigation rather than an edge case. Building
         * into a detached element would leave a live `EditorView` nothing can reach.
         */
        if (destroyed) return null;
        element.innerHTML = '';
        element.removeAttribute('tabindex');
        element.style.whiteSpace = '';
        element.style.overflow = '';
        /*
         * The editor's own box, sized to the element the consumer gave us rather than to the page.
         *
         * `media/webview.css` sets `.cm-editor { height: 100% }`, which is right where it was
         * written: in a VS Code webview the page is the editor and `html, body` are `height: 100%`
         * two hundred lines above it. In a consumer's `<div>` it came out 816 pixels tall for 400
         * pixels of content and overflowed a box explicitly set to 320. Measured in Nib, which is
         * the only place it could have been.
         *
         * `100%` rather than a number, because the consumer owns the box: against one with a height
         * the editor now fills it and scrolls inside, which is what Nib wanted and did not get.
         *
         * **It does not make the surface size to its content**, and that claim was written here and
         * measured false in the same hour: a box left at `height: auto` still comes out 816 pixels
         * for 400 of content. So the instructions tell a consumer to give the element a height, and
         * this line is what makes that instruction work rather than a replacement for it.
         *
         * A `height` rather than the `minHeight` set at mount, and the two are not the same
         * instruction. The rendered state only has to *cover* the box, so that a point inside it
         * belongs to the surface; an editor has to *be* the box, because it scrolls its content
         * and a scroller with no height of its own grows instead of scrolling. `minHeight` here
         * would leave a long value as one tall element again, which is the 816 pixels above.
         */
        element.style.height = '100%';
        const built = mod.createSurfaceEditor({
          parent: element,
          // Converted on the way in, which is what the hosts send at `init` and at every
          // `setContent`. Handed the document's own bytes instead, the editor diffs the newlines
          // it holds against the carriage returns it was given and the difference lands in the
          // value as text.
          value: toWebviewText(text),
          profile: profile === 'field' ? 'field' : 'notes',
          readOnly,
          onChange: (next: string) => {
            // Reconciled before it is handed on, so a consumer storing what it is given stores
            // the document's endings rather than the editor's. Assigning `next` here is what let
            // the first keystroke convert the whole document.
            text = upToDate(next);
            options.onChange?.(text);
          },
        });
        editor = built;
        const point = pointedAt;
        const under = pointedText;
        pointedAt = null;
        pointedText = null;
        // The text under the pointer whenever there is an answer, then the point, then the start.
        const placed = under !== null && built.focusAtText(under.count, under.side);
        if (placed) return built;
        if (point) built.focusAt(point);
        else built.focus();
        return built;
      })
      .catch((err: unknown) => {
        /*
         * A failed fetch leaves the rendered surface in place rather than an empty box, and the
         * next focus tries again. `building` is cleared here for that reason: a rejected promise
         * held in it would make one flake permanent, which is the shape `check-lazy-retry.mjs`
         * exists for on the editor's own lazy resources.
         */
        building = null;
        console.warn('Sheaf could not load its editor, so this surface stays rendered.', err);
        return null;
      });
    return building;
  };

  const onFocus = (): void => void build();
  const onPointerDown = (event: PointerEvent): void => {
    pointedAt = { x: event.clientX, y: event.clientY };
    pointedText = editor ? null : textUnder(element, event.clientX, event.clientY);
  };
  element.addEventListener('focusin', onFocus);
  element.addEventListener('pointerdown', onPointerDown);
  draw();
  el.appendChild(element);

  return {
    element,
    // `upToDate` rather than `text` alone, so a change that reached the editor without going
    // through `onChange` cannot leave this reading behind. It costs one comparison when the two
    // already agree, which is every call where nothing was typed.
    value: () => (editor ? upToDate(editor.value()) : text),
    setValue: (next: string) => {
      text = next;
      if (editor) editor.setValue(toWebviewText(next));
      else draw();
    },
    focus: () => {
      if (editor) editor.focus();
      else {
        element.focus();
        void build();
      }
    },
    editing: () => editor !== null,
    outOfScope: () => (editor ? renderMarkdown(editor.value(), profile).outOfScope : scope),
    destroy: () => {
      destroyed = true;
      element.removeEventListener('focusin', onFocus);
      element.removeEventListener('pointerdown', onPointerDown);
      editor?.destroy();
      editor = null;
      element.style.height = '';
      element.style.minHeight = '';
      element.style.whiteSpace = '';
      element.style.overflow = '';
      element.remove();
    },
    host,
  };
}
