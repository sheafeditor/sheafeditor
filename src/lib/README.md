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

### `mount` or `renderMarkdown`

Use `mount` for a surface somebody may edit: a title, a description, a comment box. It draws the value as HTML and builds an editor the first time the surface is focused.

Use `renderMarkdown` for output nobody edits, such as a list of a hundred read-only rows. It returns an HTML string with no editor behind it and no file fetched for it at any point, so each row costs one call. `mount` with `readOnly: true` is the other choice, for content somebody may want to select with the keyboard: it renders the same way, and builds a read-only editor when the surface is focused.

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

`onChange` is called with the whole text after every change a person makes: once per keystroke while somebody types, and once for a paste. Save on each call, debounce it, or save when the surface loses focus; the callback has no opinion about which. A value you set with `setValue` is not reported back, whether or not the editor has been built, because you already hold it.

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

Mount once, with an empty dependency list, and drive the surface through `setValue`. Remounting on every value change throws the editor away mid-keystroke. A value you set comes back from `value()` as the same bytes whatever is in it, a line break in a one-line `field` included: [The round trip](#the-round-trip) has the detail.

### A surface nobody can type into

`readOnly: true` takes away the ability to edit and leaves everything else alone:

```ts
mount(el, { value: text, profile: 'notes', readOnly: true });
```

The surface still renders the whole value, still builds its editor on first focus, and still draws every construct its profile carries, so a heading is a heading and a list is a list. What changes is that keys and pastes that would alter the document are refused, and the editor's content element reports `contenteditable="false"`, so the browser's own caret and spellcheck behave the way they do in any other read-only region. `value()` answers with the text you gave it, and `setValue` still works, because a value arriving from you is not somebody typing.

It is a property of the mount, so to turn it off you destroy the surface and mount again. There is no setter, and reaching for one usually means the surface wants to be two surfaces: one you show and one you edit.

### Give a `notes` element a height

```css
#description { height: 320px; }
```

**With a height on the element, your element decides and both states use all of it.** The rendered surface covers the whole box rather than only its text, so a click anywhere inside it builds the editor, and a click below the last line puts the caret at the end of the value, the way a text box does. The editor fills the box too and scrolls inside it, which is what you want for a description that can grow.

**Without a height, the content decides, and for a `notes` surface that is usually not what you want.** The rendered state comes out as tall as its text. The editor does not: it sizes itself against a page rather than against a box, so a `<div>` left at `height: auto` holding 400 pixels of document came out 816 pixels tall, and one holding a single line came out 424. Nothing collapses if you leave the height off, so the surface stays usable either way, but the first click will resize it.

A value taller than the box overflows it while the surface is rendered and scrolls inside it once the editor is built.

A `field` needs none of that. It is one line before and after focus, however long its value is, and so is the box you put it in. **A value too long for the box runs on past its right edge**, the way an `<input>` behaves: while the surface is rendered the end of it is cut off at the edge, and once the editor is built the line scrolls sideways as the caret moves, so the caret stays in view while somebody types past the edge. There is no scrollbar, since one would make the field taller. Measured in a 280px box at 22, 40, 60 and 80 characters, on a 14px and an 18px page and at two window widths: one line every time, the same height before and after the first click.

The one case where a `field` is two lines is a value you set with a line break in it. Your bytes are kept, so the editor draws what follows the break on a second line; the rendered state folds the break into a space, because it is ordinary HTML.

The surface takes its line height from your page, in both states, so the height of a field is the height of a line of your own text. In a page with no font set it measured 18px rendered and 18px once the editor was built, and a field in a box styled the way a form field usually is (`border: 1px solid; padding: 6px 10px; box-sizing: border-box`) measured 32px before the first click and 32px after it. **Your own box is the number to watch**, because it is what moves the rest of the form. In a box with no padding and no border the margins around the rendered text collapse out through your box into the layout, so the box itself reads smaller than the space the field takes.

### A `field`'s text starts at its own left edge

A `field` has no side inset of its own and no text measure, so its text starts where your element's content box starts and runs the width you gave it. You own the box; pad it yourself if you want a gap there, and the text follows.

If you want a side inset on the editor's text as well, set it on the surface inside your element:

```css
#title .sheaf-surface-field { --md-gutter: 24px; }
```

Give it a length. It is read inside a `calc()`, and a value that is not one fails quietly rather than loudly: a percentage or a keyword leaves the gutter at the default it was going to have anyway. A unitless `0` is fine, since CSS counts a bare zero as a length. A `field` has no text measure to set, because its one line runs on past the box's edge rather than wrapping inside it.

### A fence is a `pre` until the surface is an editor

On a surface nobody has focused, which includes a list of read-only descriptions, a fenced code block is a `<pre><code>` element, with a `language-` class on the `code` when the fence names a language. The fence lines themselves are left out. Nothing in either stylesheet styles that `pre`, so it takes your page's own `pre` look.

Once the editor is built it draws the fence itself: monospace at seven eighths of the size of the prose around it, so 14px in a 16px page, on a grey panel, with the markers hidden. Each line of the fence is a `.cm-line.tok-code-block` and the panel is a `::before` on it. There is no `pre` or `code` element in that state, so a test that looks for one finds a code block before the first focus and none after it, and reading `background-color` off the line is the way to find the panel.

### A construct the render path does not draw comes back named

Some constructs are not drawn by the render path. Each comes back as its own source inside `<div class="sheaf-unrendered" data-construct="Callout">`, as a `<span>` when it sits inside a paragraph, a heading or a table cell and always in a `field`. `outOfScope()` lists it, and each entry carries a `reason`:

- `profile`: the profile does not carry the construct. A block typed into a `field` is one. A richer profile may draw it.
- `unimplemented`: the profile carries the construct and the render path has no drawing for it yet. A richer profile would not help, and it is worth reporting. Today that is emoji shortcodes in every profile, and maths (`$…$` and `$$` blocks) and callouts in `document`.

The class and the attribute are the hook for styling it, and they are part of what this package promises: a suite asserts the literal markup, so a rename fails a check before it reaches you. Sheaf ships no style for the class, in either stylesheet, so refused source looks like the text around it until you give it one. One rule makes the source read as source:

```css
.sheaf-unrendered { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
```

`outOfScope()` goes on listing a construct after the editor is built, because it reports what the render path draws and says nothing about what the editor draws.

## A mounted surface renders first, and becomes an editor on first focus

This is the one thing to know before you go looking for a bug.

`mount` draws your Markdown with `renderMarkdown` and makes the element focusable. That is a rendered surface: ordinary HTML in your page, not an editor. There is no CodeMirror behind it and `surface.editing()` is `false`.

The editor is built the first time the surface receives focus, from a file the bundler fetches then. After that `surface.editing()` is `true` and typing works.

The surface changes in three ways at that moment, covered in the bullets below: where the text starts (a `notes` surface only), whether runs of spaces collapse, and how a fenced code block is drawn (a `notes` surface only). Its type does not change: both states take their font family, size and line height from your page.

So:

- A list of fifty mounted fields costs fifty rendered strings, not fifty editors. That is the point of the arrangement.
- A surface nobody has touched does not respond to a synthetic `keydown`. Focus it first.
- **A click into the rendered surface puts the caret at the character that was under the pointer, and a focus with no pointer behind it starts at the beginning of the value.** `surface.focus()` and a Tab into the element are the second kind, and the start is the right answer for both. The rendered surface is asked which character is under the pointer when the button goes down, before the editor replaces it, so the caret goes to the text the person was looking at even though the editor draws that text a little further along. Measured in Chromium on 28 clicks into a three-paragraph value, a thirteen-paragraph one and a field, at a 14px Georgia page and a 16px `system-ui` one: every caret at the character clicked. Two kinds of text still move it, as [Limits](#limits-in-this-version) says. A click past the end of a line lands at the end of that line. In a browser that cannot say which character is under a point, the caret goes where the point is in the editor's own layout instead.
- **The text keeps your page's type.** The editor takes its font family, size and line height from the element you mounted it in, as the rendered surface does, so text does not change size or face on the first click. Measured in a 14px Georgia page and an 18px Helvetica one: the same family, size and line height before and after focus. Headings, code and the other constructs keep their own proportions, which are relative to that size. Colour is not inherited: the editor's text, its muted forms and its selection are a set and keep the theme's values.
- **In a `notes` surface the text moves sideways, and in both profiles spaces stop collapsing.** A `notes` editor's lines sit inside a side gutter that the rendered surface does not have, so the text steps to the right: its lines start 72px in from the left edge of a 700px element and 96px in from a 900px one, where the rendered text starts at the edge. A `field` has no gutter in either state, so its text does not move; [A `field`'s text starts at its own left edge](#a-fields-text-starts-at-its-own-left-edge) has the detail. The rendered surface is ordinary HTML, which folds a run of spaces into one, and the editor keeps every space, so a doubled space appears at the same moment in both profiles.
- The two states are drawn by two implementations, so what they carry differs as well. The clearest case is a fenced code block: the editor draws it as lines on a grey panel with no markers, and the renderer draws it as a `pre` with a `code` inside. `surface.outOfScope()` tells you which parts of a value the render path did not draw at all, and [A fence is a `pre` until the surface is an editor](#a-fence-is-a-pre-until-the-surface-is-an-editor) has what each state looks like for a fence.
- The editor arrives over the network, so your page's policy has to allow a module fetch from wherever your bundler put `sheafeditor/chunks/*`. If the fetch fails, the rendered surface stays put and the next focus tries again. [The emoji table](#the-emoji-table-is-fetched-when-a-shortcode-appears) is the one other file that can be fetched, from the same place.

## Profiles

`field` is one line of inline Markdown: emphasis, strong, strikethrough, inline code, highlight and links. Headings, lists, quotes, fences, rules, reference definitions and tables are not constructs there, so a `#` is a `#`. Images, maths, callouts and diagrams are not drawn there either, so `![alt](src)` is `![alt](src)`. A line break a person types or pastes into one becomes a space, the way a table cell treats the same text. A line break in a value you set is kept, and the editor draws what follows it on a second line.

Enter is yours to handle, and it inserts nothing. Your value is untouched whether or not you take the key, and no `onChange` fires. The same goes for Enter with Shift held, which is the other key a reader would expect to write a line break. So binding Enter to submit is one listener and nothing else:

```ts
surface.element.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); submit(); }
});
```

Either phase works. The editor answers the key on its own content element and writes no change, and answering a key prevents its default without stopping the event, so a listener on the element `mount` created sees every Enter whether you capture or not.

**Escape is yours too, with one exception**, in both profiles. From a plain caret the editor does nothing with it: your listener sees the press and `event.defaultPrevented` is `false`. When something is selected, the editor uses that press to collapse the selection to the caret and marks the event handled. Your listener still sees it, with `defaultPrevented` set to `true`. So a field that reverts on Escape checks that flag, and a person who has selected what they typed presses Escape once to drop the selection and again to revert:

```ts
surface.element.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.defaultPrevented) revert();
});
```

Listen in the bubble phase for this one. A listener that captures runs before the editor has answered the key, so the flag is not set yet.

`notes` adds the block constructs, fenced code among them, and is what a description or a comment box wants. Tables are not in it: the grid is the largest module in the editor and needs file storage you would have to provide. Nor are images, callouts, maths or diagrams. A ```` ```mermaid ```` fence is an ordinary fence there, a `> [!NOTE]` quote is an ordinary quote whose first line reads `[!NOTE]`, and an equation stays as its `$` delimiters and the TeX between them.

`document`, the profile the VS Code extension runs, is not reachable through `mount`. It is the profile that draws all five.

### What a profile does with a construct it does not carry

**The editor shows it as its own characters, editable.** The pipes of a table, the `![alt](src)` of an image, the `$$` lines of a display equation. Nothing is dropped, nothing is replaced by a placeholder you cannot style, and the person can edit what is there, which is what an editor is for.

**The render path names it instead**, as [A construct the render path does not draw comes back named](#a-construct-the-render-path-does-not-draw-comes-back-named) describes. The two differ because an editor always has somewhere legitimate to put source and a renderer never does: raw Markdown in rendered output is a rendering that failed without saying so.

So before first focus a table in a `notes` surface is a `<div class="sheaf-unrendered" data-construct="Table">` holding its own pipes, and after first focus it is those same pipes on an editable line. Neither state draws the construct, and neither fetches anything to draw it: a `field` holding `$x^2$` makes no request for the maths library, and a `notes` surface holding a diagram fence makes none for the diagram one.

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

The full host contract has duties beyond storage: saving a pasted image, resolving a link, listing the workspace's files, the clipboard, a terminal. **Neither profile offers a control that needs one**, which is why `MountHost` asks for none of them, and so a mount with no host has nothing to drop. Nothing tests the dropping, because there is nothing yet to drop.

## The round trip

The claim the package is sold on is that a value you put in comes back as the same bytes. Irregular spacing included: Sheaf edits the file rather than reserialising a document model, so nothing is normalised on the way through.

```ts
const value = '#  Heading   with  gaps\n\n-   a\n-     b\n\n|  a |  b  |\n| -- | --- |\n';
const surface = mount(el, { value, profile: 'notes' });
surface.value() === value;  // true, before and after focus, with nothing typed
```

**There is no exception, and a line break in a `field` is the case worth spelling out**, because a `field` is one line and three different things can put a break in one. The rule is about who is acting.

**A value you set is never changed.** `surface.setValue('one\ntwo')` on a `field` leaves `value()` at `'one\ntwo'`, before focus and after its editor is built, and so does the same string passed to `mount`. A `notes` surface is the same on every path. What a `field` does with a break it has been given is draw what follows it on a second line once its editor is built.

**A line break a person types or pastes becomes a space.** Paste two lines into a `field` and you get one line with a space between them, which is what a table cell does with the same paste. **Enter is yours to handle and inserts nothing.**

If the comparison above is ever false for a value you have not edited, it is a bug in Sheaf rather than something to work around.

## What you have to serve

Three things, and the third is the useful one:

1. **The code entries and `chunks/` from one directory.** `sheafeditor`, `sheafeditor/editor` and `sheafeditor/render` import each other and their chunks by relative path, so whatever your bundler emits for them has to stay together. `mount` fetches the editor from there on first focus.
2. **The two stylesheets**, wherever your CSS pipeline puts them, and what `webview.css` names beside itself. It holds `@import url('katex.css')`, and `katex.css` names fonts in a `katex-fonts/` directory beside it, of which 20 are shipped. Your bundler resolves all of that from the package on disk and emits it with your CSS, so importing the stylesheets is all you do. **If you deploy the stylesheets as plain files instead of importing them, copy `katex.css` and `katex-fonts/` along with them**, because no entry in the `exports` map names either and nothing will tell you they are missing except a 404. Expect KaTeX in your build output even though neither profile draws maths: measured with Vite 8.3.4, a production build of a page mounting one `field` and one `notes` surface emits 1,040,629 bytes in 25 files, and 514,975 of them are KaTeX's chunk and 19 of its fonts (the twentieth is inlined into your CSS). A browser never fetches any of it. It is there because `webview.css` imports `katex.css` and the editor chunk names KaTeX's module.
3. **Nothing else, at any point after the build.** Neither profile fetches a file of its own at runtime beyond the editor and its chunks, one of which is the emoji table below. No asset directory has to sit beside the deployed stylesheet.

The third one is worth stating because the opposite would be easy to ship and hard to notice. The editor's own hosts serve a directory of files beside the code, among them the diagram library, which is copied in whole rather than bundled and so has its address built at runtime instead of written by a bundler. A bundler cannot see a resolution like that, so the `exports` map would be the only thing that could serve it, and the map names none of it. Neither profile `mount` offers draws a construct that needs any of it, which is why nothing is fetched.

`npm run check-consumer-assets` holds that line. It builds a tree out of the `exports` map, serves it from a directory that is not the checkout, mounts both profiles over a diagram and an equation, and fails on any request the tree cannot answer. So if a later version of these profiles draws one of those constructs, it owes a map entry for whatever it fetches at runtime, and that check is what will say so.

**Your stylesheet's filename is yours to pick.** Hash it, inline it, concatenate it with your own: nothing in the editor reads it, and no file it fetches is found by looking at your page.

### The emoji table is fetched when a shortcode appears

A `:tada:` shortcode is drawn as its character by the editor, and the table of names it is looked up in is 48 KB that most surfaces never need. So it is a chunk of its own, `chunks/emojiTable-*.js`, fetched as a module the first time an editor holds a shortcode: on first focus when the value already has one, or the moment somebody types one. A surface with no shortcode in it never fetches it.

Your page's policy has to allow it the way it allows the editor: as a script from wherever your bundler put `sheafeditor/chunks/*`. If the fetch fails, the shortcode stays as its own text and a later edit tries again. Before the editor is built, the rendered surface shows a shortcode as its text inside `<span class="sheaf-unrendered" data-construct="Emoji">`, because the render path has no table.

### If you ever do serve that directory

`mount` takes an `assets` option, which is the directory those files are served from:

```ts
mount(el, { value, assets: 'https://cdn.example/sheaf/0.4.0/' });
```

Leave it out and the directory this package's code was served from is used, which is where your bundler puts `chunks/`. Set it when the files live somewhere else: another origin, a CDN, a path your pipeline chose. A value with no trailing slash gets one, because a base without a trailing slash has its last segment replaced, and the 404 that follows names a path you never wrote.

It is a property of your deployment rather than of one surface. Two mounts on one page share it, and a mount that passes nothing never takes away a value another mount gave. Pass it once, or pass the same value every time.

## Limits in this version

**`field` and `notes` are two options of one entry, so a `field` costs what a `notes` surface costs.** There is one editor file, and choosing `field` changes what it parses and draws, not what it downloads. Measured from the build's own metafile:

| | Files | Bytes, uncompressed | Bytes, compressed |
| --- | --- | --- | --- |
| On page load, before anything is focused | 7 | 87,076 | about 31 KB |
| After the first focus, in total | 9 | 440,672 | about 146 KB |

Those are the same for either profile, and the first row has no editor in it: a page of fifty mounted fields that nobody clicks loads the first row once. The editor is fetched once per page, by the first surface focused. This version has no smaller editor for `field`. A `field` is meant to cost at most 60 KB compressed once focused, and the 146 KB above is more than twice that. Separate builds for each profile are what will bring it down. The figures move with every change to the editor; `npm run check-package` prints the uncompressed size of both closures after every build, which is the number to read rather than this table.

**The `document` profile is not reachable through `mount`.** It is the one that draws tables, images, maths, callouts and diagrams, and it is the VS Code extension's own editor.

**The first click can land a little early in two cases.** An HTML entity such as `&mdash;`, or a footnote reference such as `[^1]`, before the point moves the caret one character towards the start for each one. And in a long `notes` value, a click far enough down that the editor has not drawn it yet falls back to the point's place in the editor's own layout, which can be on a different line. Every click after the first is exact.

**Code in a fence is not syntax coloured**, as [Profiles](#profiles) says, and **the emoji table is fetched at runtime**, as [above](#the-emoji-table-is-fetched-when-a-shortcode-appears).

## Checking your integration

Two things are worth asserting in your own build, because both fail quietly:

**Nothing outside the `exports` map.** Every file your bundler takes from this package should resolve from `sheafeditor`, `sheafeditor/editor`, `sheafeditor/render`, `sheafeditor/chunks/*` or one of the two stylesheets.

A deep import such as `sheafeditor/lib/editor.js` or `sheafeditor/src/webview/tables` is refused rather than discouraged: the map is a closed list, and a bundler that reads `exports` fails the build on a path that is not in it. Measured by taking one entry out of the map, after which the consumer's build stopped with `"./browser-theme.css" is not exported under the conditions ["module", "browser", "production", "import"]`. So the thing to assert in your own build is the other direction, which no refusal can tell you: list the modules your bundle took from the package and check that every one came through a named entry.

**The types resolve under your own type checker**, not only inside this repository. Run your `tsc` over a file that imports `mount` and uses it. A declaration that resolves here and nowhere else is the usual way a package of this kind is broken.
