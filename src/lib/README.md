# Putting a Sheaf surface in your own application

Integration instructions. They assume you have decided to use Sheaf and want a field on screen, and they stop once the round trip is proven. They do not argue for it.

## What the package gives you

Six entries, and nothing else is importable. Three of them are code:

| Import | What it is |
| --- | --- |
| `sheafeditor` | `mount(el, options)`, and the types around it |
| `sheafeditor/render` | `renderMarkdown(markdown, profile)`: Markdown to an HTML string, with no editor anywhere in it |
| `sheafeditor/editor` | The editor itself. `mount` fetches this for you; you do not import it |

The other three are `sheafeditor/webview.css` and `sheafeditor/browser-theme.css`, covered below, and `sheafeditor/chunks/*`, which is the package's own split output and is listed so the map is a complete account of what the package can serve rather than an invitation. Anything else you can reach is private, whatever your bundler lets you resolve.

## Link the checkout beside you

There is no npm package. Point your application at a checkout of Sheaf sitting beside your own, and build it first:

```
cd ../sheaf-dev
npm install
npm run build
```

`npm run build` writes `lib/`, which is what the `exports` map points at. A fresh clone has no `lib/`, so an import before a build fails with a module that cannot be found.

Then add it to the application that will hold the field. With pnpm:

```
pnpm add link:../../sheaf-dev --filter <your-package>
```

With npm, `npm install ../sheaf-dev` does the same thing. Either way your `package.json` ends up with `"sheafeditor": "link:../../sheaf-dev"` or a `file:` spelling of it, and `node_modules/sheafeditor` is a symlink to the checkout.

**What was actually run** was the second half of that by hand, because the application it was proved in is somebody else's repository and the point was to leave no trace: the `"sheafeditor": "link:…"` line added to its `package.json`, and `ln -s <checkout> node_modules/sheafeditor`. A bundler and a type checker both resolved the package from that, so what they need is the symlink and the dependency line rather than anything the package manager writes beside them. The `pnpm add` above is the ordinary path and rewrites your lockfile, which is what you want in your own project.

Your type checker needs nothing extra. The `exports` map carries a `types` condition per entry, which `moduleResolution: "bundler"`, `"node16"` and `"nodenext"` all read. `moduleResolution: "node"`, the old one, does not read `exports` at all and will not resolve any of this.

## Load both stylesheets

```ts
import 'sheafeditor/browser-theme.css';
import 'sheafeditor/webview.css';
```

**`browser-theme.css` is not optional outside VS Code.** `webview.css` styles the editor against 54 distinct `--vscode-*` custom properties, which VS Code supplies to its own webviews and which no other page has. `browser-theme.css` is the shim that supplies them.

**The order of the two imports does not matter**, and it is worth saying so because it looks as though it should: a custom property is resolved where it is used rather than where it is declared, so the shim reaches `webview.css` either way. Measured both ways in a consumer's build, with identical computed colours. Order only decides which file wins where both set the same ordinary declaration.

What you lose without the shim, measured rather than guessed:

| | With it | Without it |
| --- | --- | --- |
| Page background | white | transparent, so the editor sits on whatever is behind it |
| Text | `#3b3b3b` | pure black |
| Links | `#005fb8` | `#2f81f7`, the dark-theme blue, on a light page |
| A fenced code block's fill | the grey panel | nothing; the code is unboxed |

Layout, type scale, weights and fonts are identical with and without. **So the failure is an editor that looks almost right and is drawn in the wrong palette, rather than one with no colours at all**, and almost right is how a mistake like this reaches a consumer's users.

The shim defines 47 custom properties, of which 42 are among the 54 `webview.css` reads. The remaining 12 are read with a CSS fallback value, so they are not blank, but they are not themed either: they take whatever the fallback in `webview.css` says rather than anything the shim or your page chose. The link colour above is one of them. `npm run check-package` prints those three numbers every time it runs, which the gates do after each build, so you can see whether they have moved.

To match the shim to your own theme, redefine any of the `--vscode-*` properties after loading it. They are ordinary custom properties on `:root`.

### Two things `webview.css` does to your page

It was written for a page that is nothing but the editor, and two of its rules reach past the surface:

```css
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; background: ...; color: ...; }
```

If your application sets its own box model, page margins or background, load `webview.css` before your own stylesheet so yours wins, or scope it with a CSS layer. There is no build flag for this today.

## Mount a field

```ts
import { mount } from 'sheafeditor';

const surface = mount(document.getElementById('description')!, {
  value: '## Notes\n\nSome **bold** text.\n',
  profile: 'notes',
  onChange: (text) => save(text),
});
```

`mount` returns a `SheafSurface`:

```ts
surface.element;       // the element mount created inside the one you gave it
surface.host;          // the host you passed, or the in-memory default
surface.value();       // the text as it now stands
surface.setValue(s);   // a new value from you; an open editor keeps its caret
surface.focus();       // build the editor if it is not built, and put the caret in it
surface.editing();     // whether the editor has been built
surface.outOfScope();  // what this profile did not understand in the current value
surface.destroy();     // take it down; nothing it registered fires afterwards
```

`profile` is `'field'` or `'notes'`, and leaving it out gives you `notes`. Profiles, below, says what each one carries.

`focus()` returns nothing, and `editing()` is still `false` on the line after you call it, because the editor arrives over the network. There is no event and no promise to wait on, so to know when the editor is up, poll `editing()`. Give the poll a limit: if the fetch fails, `editing()` stays `false` and the surface stays rendered until the next focus tries again.

In React, call it from an effect and return `destroy`:

```tsx
const el = useRef<HTMLDivElement>(null);
useEffect(() => {
  const surface = mount(el.current!, { value, profile: 'notes', onChange: setValue });
  return () => surface.destroy();
}, []);
return <div ref={el} />;
```

Mount once, with an empty dependency list, and drive the surface through `setValue`. Remounting on every value change throws the editor away mid-keystroke. A `field` turns a line break you pass to `setValue` into a space once its editor is built: [The round trip](#the-round-trip) has the detail.

### Give a `notes` element a height

```css
#description { height: 320px; }
```

A `notes` surface does not size itself to its content. Measured: a `<div>` left at `height: auto` holding 400 pixels of document came out 816 pixels tall, because the editor's stylesheet sizes itself against a page rather than against a box. With a height on the element, the editor fills it and scrolls inside, which is what you want for a description that can grow.

A `field` needs none of that. It sizes itself to its one line, before and after focus: measured in a 900px page, 18px rendered and 24px once the editor is built, the same at a 1000px window and at a 1400px one.

### Take the side inset off a `field` if you want its text at its edge

A `field` inherits the side gutters and the 708px measure of the column a `document` is written in, so its text starts some way in from its own left edge: 96px in a page-wide field, 72px in a 280px one. Two custom properties take that off, set on the surface inside your element.

```css
#title .sheaf-surface-field { --md-gutter: 0px; --md-content-width: 100%; }
```

Measured with both set on a 900px field, the text starts at the field's own left edge. Pad your own element if you want a gap there.

### A fence is a `pre` until the surface is an editor

On a surface nobody has focused, which includes a list of read-only descriptions, a fenced code block is a `<pre><code>` element, with a `language-` class on the `code` when the fence names a language. The fence lines themselves are left out. Nothing in either stylesheet styles that `pre`, so it takes your page's own `pre` look.

Once the editor is built it draws the fence itself: monospace at 14px against the 16px prose around it, on a grey panel, with the markers hidden. Each line of the fence is a `.cm-line.tok-code-block` and the panel is a `::before` on it. There is no `pre` or `code` element in that state, so a test that looks for one finds a code block before the first focus and none after it, and reading `background-color` off the line is the way to find the panel.

### A construct the render path does not draw comes back named

Some constructs are not drawn by the render path. Each comes back as its own source inside `<div class="sheaf-unrendered" data-construct="Callout">`, as a `<span>` when it sits inside a paragraph, a heading or a table cell and always in a `field`. `outOfScope()` lists it, and each entry carries a `reason`:

- `profile`: the profile does not carry the construct. A block typed into a `field` is one. A richer profile may draw it.
- `unimplemented`: the profile carries the construct and the render path has no drawing for it yet. A richer profile would not help, and it is worth reporting.

Nothing in either stylesheet styles that class. One rule makes the source read as source:

```css
.sheaf-unrendered { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
```

`outOfScope()` goes on listing a construct after the editor is built, because it reports what the render path draws and says nothing about what the editor draws.

## A mounted surface renders first, and becomes an editor on first focus

This is the one thing to know before you go looking for a bug.

`mount` draws your Markdown with `renderMarkdown` and makes the element focusable. That is a rendered surface: ordinary HTML in your page, not an editor. There is no CodeMirror behind it and `surface.editing()` is `false`.

The editor is built the first time the surface receives focus, from a file the bundler fetches then. After that `surface.editing()` is `true` and typing works.

The surface changes in four ways at that moment, covered in the bullets below: the type size, where the text starts, whether runs of spaces collapse, and how a fenced code block is drawn.

So:

- A list of fifty mounted fields costs fifty rendered strings, not fifty editors. That is the point of the arrangement.
- A surface nobody has touched does not respond to a synthetic `keydown`. Focus it first.
- **A click into the rendered surface puts the caret under the pointer, and a focus with no pointer behind it starts at the beginning of the value.** `surface.focus()` and a Tab into the element are the second kind, and the start is the right answer for both. The position comes from the pointer event before the focus, because a focus event carries no coordinates.
- **The caret lands under the pointer in the *editor's* layout, which is not the same text as the point in the rendered one.** The editor has its own type scale and its own padding, so the two states put a given line of your value in different places, and the caret goes where the point is once the editor exists. Measured on a three-paragraph value in a 420 by 320 box: a click 90 pixels down had the second paragraph under it in the rendered state and landed in the first paragraph in the editor. Styling the rendered state to match the editor, as above, is what narrows that; nothing exposes the editor's own type scale as tokens today.
- **The rendered surface takes its typography from your page and the editor takes its own**, so the text changes size on first focus. Measured in a consumer's page whose base was 14px `system-ui`: the rendered paragraph was 14px `system-ui` with a 28px heading, and the same text in the editor was 16px `-apple-system` with a 32px heading. Nothing exposes those as tokens today. If the jump matters, set the rendered state to match by styling `.sheaf-surface-notes` and `.sheaf-surface-field`.
- **The text moves sideways, and spaces stop collapsing.** The editor's lines sit inside a side gutter that the rendered surface does not have, so the text steps to the right: its lines start 72px in from the left edge of a 700px element and 96px in from a 900px one, where the rendered text starts at the edge. The rendered surface is ordinary HTML, which folds a run of spaces into one, and the editor keeps every space, so a doubled space appears at the same moment. Measured, two spaces between words put them 3.8px apart rendered and 8.4px apart in the editor. For a `field`, [the side inset section](#take-the-side-inset-off-a-field-if-you-want-its-text-at-its-edge) takes the gutter off.
- The two states are drawn by two implementations, so what they carry differs as well. The clearest case is a fenced code block: the editor draws it as lines on a grey panel with no markers, and the renderer draws it as a `pre` with a `code` inside. `surface.outOfScope()` tells you which parts of a value the render path did not draw at all, and [A fence is a `pre` until the surface is an editor](#a-fence-is-a-pre-until-the-surface-is-an-editor) has what each state looks like for a fence.
- The editor arrives over the network, so your page's policy has to allow a module fetch from wherever your bundler put `sheafeditor/chunks/*`. If the fetch fails, the rendered surface stays put and the next focus tries again.

## Profiles

`field` is one line of inline Markdown: emphasis, strong, strikethrough, inline code, highlight and links. Headings, lists, quotes, fences, rules, reference definitions and tables are not constructs there, so a `#` is a `#`. A line break typed or pasted into one becomes a space, and so does one written with `setValue` once the editor is built.

Enter is yours to handle, and until you handle it, it inserts a single space at the caret: it adds no line, and it fires `onChange` with the space in the value. If you bind Enter to submit, stop the keydown before the editor sees it, or the space goes into your data as well:

```ts
surface.element.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); submit(); }
}, true);
```

The `true` matters. The editor handles the key on its own content, so a listener on a parent in the bubbling phase runs after the space is written.

`notes` adds the block constructs, fenced code among them, and is what a description or a comment box wants. Tables are not in it: the grid is the largest module in the editor and needs file storage you would have to provide.

`document`, the profile the VS Code extension runs, is not reachable through `mount`.

Neither profile installs the selection toolbar or the link popover. Those reach the clipboard, link resolution and the workspace's file list, which are host duties this package does not ask you for. You get the formatting keymap instead: the usual chords write the usual bytes.

Code in a fence is monospaced and not syntax coloured. Colouring it needs the grammar registry, which carries a parser per language and pulls HTML, CSS and JavaScript before any fence asks for one, and a field is not the place to pay for that. Nothing in the library's build reaches it: `lib/editor.js` loads `@codemirror/view`, `state`, `commands`, `language`, `lang-markdown` and the lezer packages, and no grammar package at all, eagerly or lazily. `npm run check-package` asserts the absence.

## Storage, or the default

The editor keeps two kinds of state outside the document, and `mount` takes a `host` for them. Three methods, out of the sixteen in the full host contract:

```ts
mount(el, {
  value,
  host: {
    kept: async (kind) => JSON.parse(localStorage.getItem(`sheaf:${kind}`) ?? 'null'),
    keep: (kind, value) => localStorage.setItem(`sheaf:${kind}`, JSON.stringify(value)),
    setting: ({ name, value }) => localStorage.setItem(`sheaf:setting:${name}`, JSON.stringify(value)),
  },
});
```

`kept` and `keep` are this surface's arrangement, keyed by kind: column widths, which comments are folded, which panels are open. `setting` is a choice the person made in the editor that is meant to outlive the document, such as whether line numbers are drawn.

**Treat a kept value as opaque.** Read it, write it back, and do not parse, validate or inspect it. Its shape is the editor's and will change.

You do not have to supply any of this. **Leaving `host` out gives you an in-memory default**, which keeps both kinds of state for as long as the mount lives. What that costs you:

- Nothing survives a remount. Unmount and remount the surface, or reload the page, and the arrangement is back to its defaults.
- A setting the person changes in one surface does not reach the next one, including the next mount of the same field.
- Nothing is ever written to your store, so there is nothing of Sheaf's in your data and nothing to migrate.

**And today it costs you nothing at all, which is the part to know before you spend an afternoon on it.** The five kinds a host is asked about are table widths, kanban boards, comment folds, front matter and the outline panel, and `field` and `notes` draw none of them. Measured with a counting host on a `field` surface that was mounted, focused and typed into: none of the three methods was called. Supply one when a document you are putting in a `notes` surface holds something that uses it, or when a later version of these profiles draws one; until then the default and a real store behave identically.

`surface.host` tells you which of the two you got, which is worth reading once: a mount that fell back to the default is the mistake here that shows no symptom until somebody reloads.

## The round trip

The claim the package is sold on is that a value you put in comes back as the same bytes. Irregular spacing included: Sheaf edits the file rather than reserialising a document model, so nothing is normalised on the way through.

```ts
const value = '#  Heading   with  gaps\n\n-   a\n-     b\n\n|  a |  b  |\n| -- | --- |\n';
const surface = mount(el, { value, profile: 'notes' });
surface.value() === value;  // true, before and after focus, with nothing typed
```

**The one exception is a line break in a `field`.** A `field` is one line, so its editor writes a space wherever a line break would go. `surface.setValue('one\ntwo')` on a `field` whose editor is built leaves `value()` at `'one two'`, and `onChange` receives the same text. A value you pass to `mount` keeps its line breaks byte for byte, and so does one you pass to `setValue` before the editor is built. A `notes` surface keeps them in every case. If you drive a `field` through `setValue` and the text can hold a line break, read `value()` back instead of assuming it matches what you passed.

Outside that exception, if the comparison above is ever false for a value you have not edited, it is a bug in Sheaf rather than something to work around.

## Checking your integration

Two things are worth asserting in your own build, because both fail quietly:

**Nothing outside the `exports` map.** Every file your bundler takes from this package should resolve from `sheafeditor`, `sheafeditor/editor`, `sheafeditor/render`, `sheafeditor/chunks/*` or one of the two stylesheets.

A deep import such as `sheafeditor/lib/editor.js` or `sheafeditor/src/webview/tables` is refused rather than discouraged: the map is a closed list, and a bundler that reads `exports` fails the build on a path that is not in it. Measured by taking one entry out of the map, after which the consumer's build stopped with `"./browser-theme.css" is not exported under the conditions ["module", "browser", "production", "import"]`. So the thing to assert in your own build is the other direction, which no refusal can tell you: list the modules your bundle took from the package and check that every one came through a named entry.

**The types resolve under your own type checker**, not only inside this repository. Run your `tsc` over a file that imports `mount` and uses it. A declaration that resolves here and nowhere else is the usual way a package of this kind is broken.
