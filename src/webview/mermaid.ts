/*
 * Mermaid: a ```` ```mermaid ```` block drawn as its diagram.
 *
 * A README with a diagram in it reads as a diagram on github.com, and it should
 * read as one here. Mermaid does the drawing. It ships inside the extension, so
 * nothing is fetched over the network and a document draws the same with no
 * connection, but it is not part of `webview.js`: it is several megabytes, and a
 * document with no diagram in it should not pay for one. It sits in
 * `media/mermaid/` as a module and its chunks, and the first diagram on a page
 * imports it from beside the script that is running, which is the same place in
 * every host: the extension's own media folder in VS Code, `/media/` from the
 * local server, and the demo's folder on the site. Mermaid splits itself by
 * diagram type, so a pie chart loads the pie chart's code and not the gantt's.
 *
 * Nothing here writes to the document. A diagram is a decoration over the bytes
 * already there, and Edit Markdown shows the fence as written, the way it shows
 * every other rendered block.
 *
 * ## Height
 *
 * Mermaid draws asynchronously, so the widget exists before its size is known.
 * The first time a diagram is drawn on a page it takes its height when it
 * arrives, and whatever is below it moves once. After that the drawing and its
 * height are kept against the diagram's source and the theme, so a diagram
 * scrolled out of view and back, or redrawn because a line above it changed,
 * comes back at its size at once and nothing below it moves.
 *
 * Drawing is done one diagram at a time. Mermaid measures text in a hidden element
 * on the page while it lays a diagram out, and two layouts sharing that element
 * is not something it promises to survive.
 *
 * ## What cannot be drawn
 *
 * A diagram that does not parse is the normal state while someone is writing one,
 * so it is never an empty box and never an exception: the block shows its source
 * with Mermaid's message under it.
 *
 * `securityLevel: 'strict'` is Mermaid's default and it stays. A document can come
 * from anyone, and strict is what keeps a diagram's labels from carrying markup or
 * a click handler into the page.
 */

import { StateEffect } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';

/** The part of Mermaid's module this file uses. */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/** What a diagram came to: its drawing, or why there is none. */
type Drawn = { svg: string } | { error: string };

/**
 * Where the editor's files are, read from the stylesheet every host loads beside
 * the bundle.
 *
 * This used to read `document.currentScript`, which was right while the editor was
 * one plain script and became `null` the moment it was split into modules: inside a
 * module there is no current script, and inside an async chunk there is none again.
 * Every diagram in every host then drew "the editor does not know where its files
 * are", and nothing 404'd and no policy refused anything, so the failure showed up
 * nowhere except on the screen.
 *
 * `media/webview.css` is the anchor instead. Every host links it beside the bundle,
 * and unlike the bundle it is a plain stylesheet, so its address does not move with
 * how the code is split. Mermaid's folder sits beside it.
 *
 * That makes the link load-bearing, which is the cost of this and worth knowing
 * before changing a host's page. A host that inlined its stylesheet, or renamed it,
 * or stopped putting it beside the bundle, would break every diagram and nothing
 * here would say why: the file loads, no request fails, no policy refuses anything.
 * `scripts/check-diagrams.mjs` catches it for the folder server and the site's own
 * demo check catches it there, so the one host with no automated cover is VS Code.
 *
 * Read when a diagram is first drawn rather than while this module is evaluated, so
 * it does not depend on what the document happens to hold at import time.
 */
function mediaFolder(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href*="webview.css"]')?.href ?? '';
}

/** Loads Mermaid's module. Tests replace it, since jsdom has no layout to draw with. */
let load: () => Promise<MermaidApi> = async () => {
  const base = mediaFolder();
  if (!base) throw new Error('Diagrams cannot be drawn here: the editor does not know where its files are.');
  const url = new URL('mermaid/mermaid.esm.min.mjs', base).href;
  const mod = (await import(/* @vite-ignore */ url)) as { default: MermaidApi };
  return mod.default;
};

let api: Promise<MermaidApi> | null = null;

/** Replace the loader. For tests; clears everything drawn so far. */
export function setMermaidLoader(loader: () => Promise<MermaidApi>): void {
  load = loader;
  api = null;
  drawn.clear();
  heights.clear();
  initializedFor = '';
}

// ---- Theme ------------------------------------------------------------------

/**
 * Light or dark, read from what is on screen rather than from any one host's
 * signal. VS Code marks the body with a class, the browser page with an attribute
 * or the operating system's setting, and the site's demo with its own attribute;
 * every one of them ends as a background colour behind the text.
 */
/** The page's own background, as an `rgb()` string, or '' when it has none to read. */
function pageBackground(): string {
  if (typeof document === 'undefined' || !document.body) return '';
  const colour = getComputedStyle(document.body).backgroundColor;
  const rgb = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(colour);
  if (!rgb) return '';
  // A transparent body has no colour of its own.
  if (rgb[4] !== undefined && Number(rgb[4]) === 0) return '';
  return `rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]})`;
}

/**
 * Light or dark, read from what is on screen rather than from any one host's
 * signal. VS Code marks the body with a class, the browser page with an attribute
 * or the operating system's setting, and the site's demo with its own attribute;
 * every one of them ends as a background colour behind the text.
 */
export function mermaidTheme(): 'dark' | 'default' {
  const rgb = /rgb\((\d+), (\d+), (\d+)\)/.exec(pageBackground());
  if (!rgb) return 'default';
  const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark' : 'default';
}

let initializedFor = '';

function configure(mermaid: MermaidApi, theme: string): void {
  /*
   * The label on an arrow sits on the page's own background rather than on a colour of
   * Mermaid's choosing.
   *
   * Mermaid gives `edgeLabelBackground` a value per theme, and neither value is the colour the
   * diagram is actually drawn on: in a dark editor the label came out on `#585858` against a
   * `#1f1f1f` page, so every labelled arrow carried a grey patch behind its words. Two themes
   * cannot cover this, because Sheaf borrows whatever theme the person is using and there are
   * more than two of those; a high-contrast theme is a third case and a custom one is a
   * hundredth. Reading the background is the only answer that is right in all of them.
   *
   * Empty when the body is transparent, which is a page that has told us nothing, and then
   * Mermaid's own value stands rather than a colour invented here.
   */
  const background = pageBackground();
  const key = `${theme}\n${background}`;
  if (initializedFor === key) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    ...(background ? { themeVariables: { edgeLabelBackground: background } } : {}),
    // Throw on a diagram that does not parse, rather than drawing Mermaid's own
    // error picture in its place: the block shows its source and the message.
    suppressErrorRendering: true,
    fontFamily: 'var(--sheaf-font, var(--md-font))',
  });
  initializedFor = key;
}

// ---- Drawing ----------------------------------------------------------------

/** Drawings by theme and source. Bounded: a long editing session makes many. */
const drawn = new Map<string, Drawn>();
/** The height each drawing took on the page, by the same key. */
const heights = new Map<string, number>();

/**
 * Ask the view to read every visible line's height again on its next measure.
 *
 * **Why a block widget that grows after it is drawn needs this.** CodeMirror re-reads line
 * heights when the content was redrawn, when the theme changed, or when the content DOM's own
 * box changed size since the last reading. A diagram drawn asynchronously is none of those by
 * the time the drawing lands: the content box grew with it, and whatever measure cycle ran in
 * between has already recorded the grown height, so the trigger is spent. `requestMeasure`
 * runs a read and a write and does not set that flag.
 *
 * Measured, with the diagram drawn 180px tall: the height map held 70px for it, the document
 * mapped 110px shorter than it is drawn, and a click below the diagram resolved past the end
 * of the document and put the caret there. A one-pixel window resize fixed it, which is
 * nothing but a forced re-read — this asks for that re-read directly.
 *
 * `mustMeasureContent` is `@internal` in `@codemirror/view` and reached through a cast. There
 * is no public way to say "a widget changed size": `requestMeasure` reads, a state effect only
 * helps if it redraws, and rebuilding the widget with its height in its identity was tried and
 * did not reach the map either. If a future version renames this, the cast fails silently and
 * the symptom is the one above, so `scripts/check-diagrams.mjs` measures the click.
 */
function remeasureHeights(view: EditorView): void {
  const state = (view as unknown as { viewState?: { mustMeasureContent?: boolean | string } }).viewState;
  if (state) state.mustMeasureContent = true;
  view.requestMeasure();
}
const KEEP = 60;

/** The narrowest a diagram is drawn before its block scrolls instead, in CSS pixels. */
const MIN_WIDTH = 420;

const keyOf = (theme: string, source: string): string => `${theme}\n${source}`;

let queue: Promise<unknown> = Promise.resolve();
let ids = 0;

/** Draw `source`, after whatever is already drawing. */
function draw(source: string, theme: string): Promise<Drawn> {
  const key = keyOf(theme, source);
  const done = drawn.get(key);
  if (done) return Promise.resolve(done);
  const next = queue.then(async (): Promise<Drawn> => {
    const again = drawn.get(key);
    if (again) return again;
    let result: Drawn;
    try {
      api ??= load();
      const mermaid = await api;
      configure(mermaid, theme);
      const { svg } = await mermaid.render(`sheaf-mermaid-${++ids}`, source);
      result = { svg };
    } catch (err) {
      // A module that would not load is kept from being retried on every block.
      result = { error: messageOf(err) };
    }
    drawn.set(key, result);
    if (drawn.size > KEEP) {
      const oldest = drawn.keys().next().value as string;
      drawn.delete(oldest);
      heights.delete(oldest);
    }
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // Mermaid's parse errors start with a line that only says so.
  return text.replace(/^Parse error on line \d+:\n/, '').trim() || 'This diagram could not be drawn.';
}

function fill(region: HTMLElement, result: Drawn, source: string): void {
  region.replaceChildren();
  region.parentElement?.classList.remove('is-drawing');
  if ('svg' in result) {
    region.parentElement?.classList.remove('md-mermaid-error');
    region.innerHTML = result.svg;
    const svg = region.querySelector('svg');
    if (svg) {
      svg.removeAttribute('height');
      // Mermaid gives the drawing its natural width as a maximum and lets it
      // shrink from there. It shrinks with the pane down to this floor, and past
      // it the block scrolls instead, since text scaled much further is unreadable.
      const natural = parseFloat(svg.style.maxWidth);
      svg.style.width = '100%';
      if (natural > 0) svg.style.minWidth = `${Math.min(natural, MIN_WIDTH)}px`;
      svg.setAttribute('aria-roledescription', svg.getAttribute('aria-roledescription') ?? 'diagram');
    }
    return;
  }
  region.parentElement?.classList.add('md-mermaid-error');
  const code = document.createElement('pre');
  code.className = 'md-mermaid-source';
  code.textContent = source;
  const message = document.createElement('p');
  message.className = 'md-mermaid-message';
  message.setAttribute('role', 'status');
  message.textContent = result.error;
  region.append(code, message);
}

class MermaidWidget extends WidgetType {
  constructor(readonly source: string, readonly theme: string) {
    super();
  }
  eq(other: MermaidWidget): boolean {
    return other.source === this.source && other.theme === this.theme;
  }
  get estimatedHeight(): number {
    return heights.get(keyOf(this.theme, this.source)) ?? -1;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'md-mermaid';
    // A diagram is often wider than an editor pane. It scales down to the pane,
    // to a floor the stylesheet sets, and past that it scrolls inside its own
    // block. The region is focusable so the scrolling is reachable without a
    // pointer, and named so a screen reader says what it is and that it moves.
    const region = document.createElement('div');
    region.className = 'md-mermaid-scroll';
    region.tabIndex = 0;
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Diagram, scrollable');
    wrap.appendChild(region);

    const key = keyOf(this.theme, this.source);
    const known = drawn.get(key);
    const height = heights.get(key);
    if (known) {
      fill(region, known, this.source);
      return wrap;
    }
    wrap.classList.add('is-drawing');
    if (height) wrap.style.minHeight = `${height}px`;
    void draw(this.source, this.theme).then((result) => {
      if (!wrap.isConnected && !document.body.contains(wrap)) {
        // Gone before it was drawn: the drawing is kept for when it comes back.
        return;
      }
      fill(region, result, this.source);
      wrap.style.minHeight = '';
      view.requestMeasure({
        read: () => wrap.getBoundingClientRect().height,
        write: (h) => {
          if (h > 0) heights.set(key, h);
        },
      });
      // From here, outside any measure cycle. Asked for from inside one — from the write
      // above — the request is folded into the round already running, which has read the
      // flag and set it back, and nothing re-reads. Measured: the map keeps its old number.
      remeasureHeights(view);
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    // Let a click place the caret, which is what Edit Markdown then works on.
    return false;
  }
}

/** The decoration that draws a ```mermaid block as its diagram. */
export function mermaidDiagram(source: string): Decoration {
  return Decoration.replace({ widget: new MermaidWidget(source, mermaidTheme()), block: true });
}

// ---- Finding the blocks -----------------------------------------------------

/** A ```mermaid fence: the whole lines it covers, and the diagram between its fences. */
export interface MermaidRange {
  from: number;
  to: number;
  source: string;
}

/** The language a fence's opening line names, lower-cased: `mermaid` in ```` ```mermaid ````. */
export function openingFenceLang(line: string): string {
  const m = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/.exec(line);
  return m ? m[2].toLowerCase() : '';
}

/** A theme change: every drawn diagram is drawn again in the new one. */
export const mermaidThemeChanged = StateEffect.define<null>();

/**
 * Watches the page's background, and tells the editor when light and dark swap.
 * VS Code changes a class on the body when the colour theme changes, the browser
 * page an attribute on the root, and a page following the operating system
 * changes with no mutation at all, so all three are listened for.
 */
export const mermaidThemeWatch = ViewPlugin.fromClass(
  class {
    theme = mermaidTheme();
    observer: MutationObserver | null = null;
    media: MediaQueryList | null = null;
    constructor(readonly view: EditorView) {
      const check = (): void => {
        const now = mermaidTheme();
        if (now === this.theme) return;
        this.theme = now;
        view.dispatch({ effects: mermaidThemeChanged.of(null) });
      };
      this.check = check;
      if (typeof MutationObserver !== 'undefined') {
        this.observer = new MutationObserver(check);
        this.observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
        this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
      }
      if (typeof matchMedia !== 'undefined') {
        this.media = matchMedia('(prefers-color-scheme: dark)');
        this.media.addEventListener?.('change', check);
      }
    }
    check: () => void = () => undefined;
    destroy(): void {
      this.observer?.disconnect();
      this.media?.removeEventListener?.('change', this.check);
    }
  }
);
