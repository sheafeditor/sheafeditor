# Real-editor scenarios

Checks that Sheaf does what a person expects, run the way a person uses it. The click scenarios drive a real VS Code window with Sheaf loaded from this checkout: every click, drag and hover is a mouse event at a point on screen, and a click on something another element covers fails, as it would fail a person. The unit scenarios check the same features under jsdom, from the person's side: what they did and what they should see or find in the file.

These sit beside the suites under `test/`, not in place of them. The suites prove the code does what it was built to do. These ask whether a person gets what they wanted, including the cases nobody designed for.

## Running

Click scenarios, one area at a time:

```
node test/real-editor/run-editor.mjs tables
node test/real-editor/run-editor.mjs tables stays-grid     # only scenarios whose id contains "stays-grid"
```

Unit scenarios, all areas or a few:

```
node test/real-editor/run-unit.mjs
node test/real-editor/run-unit.mjs prose tables
```

Each run prints a PASS or FAIL line per scenario, with what was seen when it fails, and writes `results.json` to its run folder. A failing click scenario also saves a screenshot there.

Build the extension first (`npm run build`), since the click scenarios load it the way VS Code does.

## Requirements

- VS Code, installed where the platform usually puts it, or pointed to with `VSCODE_BIN`.
- `playwright-core`, which drives the window. It is not a dependency of the extension; install it in this checkout or point `PLAYWRIGHT_CORE` at a copy.
- The checkout's own dependencies (`npm install`), which provide esbuild and jsdom for the unit scenarios.

Click scenarios open real windows and take the mouse, so run them on a machine you are not using at the same time.

| Variable | Default | What it sets |
| --- | --- | --- |
| `VSCODE_BIN` | the platform's usual VS Code executable | the VS Code to launch |
| `PLAYWRIGHT_CORE` | `playwright-core` from this checkout | the Playwright package to drive it with |
| `SHEAF_EDITOR_RUNS` | `sheaf-real-editor` in the OS temp folder | where run folders go |
| `SHEAF_RUN_NAME` | the area name | the run folder and profile name, so two runs of one area can go side by side |
| `SHEAF_CHECKOUT` | the checkout holding these files | another checkout to test, such as a build of another branch; it needs its own `npm install` and `npm run build` |

## Layout

- `session.mjs`: the driver. It launches VS Code with its own profile, a copy of `sample/` as the workspace and Sheaf from this checkout, and gives each scenario `S`: `fresh(name, text)` to write and open a file, `caret`, `click`, `dblclick`, `drag`, `select`, `hover`, `type`, `press`, `toolbar`, `menu`, `command`, `state()` for the editor's selection and document, `disk()` for the file once auto-save settles, `rendered()` for the text a person reads, and `clipboard` for the system clipboard.
- `run-editor.mjs` and `run-unit.mjs`: the runners.
- `editor/<area>.mjs`: click scenarios, one file per area of the product.
- `unit/<area>.ts`: unit scenarios, one file per area.

An area file may also export `settings`, which the runner applies to the profile before the window opens. That is how behaviour behind a setting gets its own area: `editor/reveal-source.mjs` turns `sheaf.doubleClickToEditSource` on and runs the reveal scenarios `editor/render.mjs` exports for it, so the default area stays a description of what a person gets out of the box.

## Writing a scenario

A scenario is `{ id, feature, name, run }`. The name says what a person does and what they should get, in their words. `run` returns `true`, or `{ ok, detail }` where `detail` says what was actually seen, so a failure reads as a bug report:

```js
{
  id: 'prose.inline-marks.e01',
  feature: 'prose.inline-marks',
  name: 'Clicking Bold twice on a word leaves it plain',
  run: async (S) => {
    await S.fresh('bold-twice', 'Hello world\n');
    await S.select('world');
    await S.toolbar('Bold');
    await S.toolbar('Bold');
    const d = await S.disk();
    return { ok: d === 'Hello world\n', detail: JSON.stringify(d) };
  },
}
```

Name keys as on macOS (`Meta+z`); the driver sends Control elsewhere. Judge a result by the whole file on disk or by what is on screen, never by an internal value alone.

## Traps these scenarios already avoid

- **The test window inherits the environment of whoever launched it, and a terminal in it runs a shell.** On a machine where a shell attaches itself to a tmux session when it sees an SSH connection, the test window's terminal became that person's live session, and every scenario that typed into a terminal typed at their prompt. An Escape meant for the test reached whatever was running there. The harness now strips the tmux and SSH variables from the window's environment, and gives the profile a terminal of its own that runs `zsh -f`, which reads no startup files, with the prompt `sheaf-test%`. A scenario that types into a terminal must first confirm that prompt is on screen and refuse otherwise, so the next regression here fails instead of typing into someone's session.
- A click aimed just past the end of a word can land at the start of the next line, because text nodes are joined across lines. The driver aims at the previous character's right edge instead.
- With several editors open, a hidden webview can be read by mistake. The driver only reads the webview whose frame is on top, and `fresh` confirms the editor holds the file it just wrote, accepting any Sheaf frame that holds it so a split window is not torn down.
- A background tab's webview reports itself visible. VS Code hides it by styling the outer `iframe.webview` element, while Sheaf's editor runs in a frame nested inside that one, which knows nothing about it. Asking that inner frame is how a hidden editor was counted as the one on screen; walk out to the page and require every frame in the chain to be visible.
- A modifier sent with a click as a key press is released before the click lands. The driver holds it down around the click.
- The operating system's own save prompt is invisible to the driver. The profile turns on VS Code's drawn dialogs, so a scenario can read and answer a save prompt.
- Scrolling has three traps, and one scenario hit all three at once. The scroller is `.cm-scroller`: `.sheaf-root` reports a `scrollTop` of 0 however far the document has moved. A wheel event from the driver never reaches the webview, so twelve 400px wheels move nothing while twelve Page Downs move thousands of pixels. And `elementFromPoint` lands on an empty line often enough to read as nothing, so take the first line with text at or below the sampling point instead.
- A run drives the built webview, not the source. Change `src/webview/` and the window keeps showing the last build until `npm run build` or `npm run gates` has run, so a scenario can fail against a fix that is already correct. If a real-window result disagrees with the same check in a suite, build first and run it again.
- The terminal draws to a canvas, so there is nothing in the page to read. An area that needs to see what was typed at a prompt turns the DOM renderer on with `terminal.integrated.gpuAcceleration: 'off'` in its `settings`. Without it a scenario reports an empty terminal, which says nothing about whether the feature worked.
- An editor nested inside a widget reads as covered by that widget, so the click helper refuses it. `S.click(target, { force: true })` goes ahead anyway, which is how a cell's own editor is clicked.
- A word to click has to come from what is rendered, not from the file. The click helper searches the drawn viewport, so a word taken from the source of a long document can sit below the fold where no click will ever find it.
- A test that loads files at run time must load them from the checkout under test. `run-unit.mjs` sets `SHEAF_REPO` for that, and nothing here points outside the checkout.
