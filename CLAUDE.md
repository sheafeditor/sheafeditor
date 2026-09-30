# Sheaf — project steering

> **This file ships in the public repository.** It is engineering steering and nothing else. Issue-tracker references, commercial thinking, and anything about the people or tooling behind the work stay out of it. A pre-commit hook scans this file for that material and stops the commit, which is a reminder rather than a wall: if it fires on something legitimate, move the text or widen the hook deliberately.

## What this is

Sheaf is a WYSIWYG editor for the Markdown documents and tables already in your repo, with the feel of a modern block editor, built over CodeMirror 6.

It runs in more than one place. In VS Code it is a `CustomTextEditorProvider`, and the same extension installs unchanged in editors built on Code OSS. It also serves a folder from your own machine to a browser tab, so a document opens in applications that have no way to load an extension. Those are hosts for one editor rather than separate products: see **One editor, several hosts** below, which is the rule that keeps them from becoming separate products.

**This project is public.** It lives at [github.com/sheafeditor/sheafeditor](https://github.com/sheafeditor/sheafeditor) and is published to the VS Code Marketplace and Open VSX under the `sheafeditor` publisher for other people to install and use. It is not a personal or internal tool, and it should never read like one.

Treat that as the governing constraint on every change:

- **Assume an outside audience.** Code, comments, docs, commit messages, and issue replies are read by strangers. No internal shorthand, no unexplained references.
- **Never commit anything private** — no local paths, credentials, tokens, API keys, internal URLs, or personal data. Check before adding files.
- **Secrets are what must never land here**, and gitleaks enforces it in a machine-wide pre-commit and pre-push hook. Fix a finding at its source, or record a false positive in `.gitleaksignore` with a note. Never bypass the hook.
- **User-facing text is product copy.** Command titles, setting descriptions, error messages, and README prose are the product. Write them for a first-time user who has no context.
- **Breaking changes matter from first publish.** Once the extension is on the Marketplace, changing a setting name, a command ID, or the `sheaf.wysiwyg` view type breaks real installs. Rename only with a deprecation path, and say so in the changelog. (Renames done *before* first publish are free — that is why the `nib` → `md-editor` → `sheaf` history costs nothing, and why the legacy view-type list in `src/defaultEditor.ts` can eventually be dropped.)

## What Sheaf is for

**Documents and datatables, edited in place, inside the code editor.** When a design argument is close, settle it against the bar below.

The bar: a developer who keeps their docs in the repo should get a writing surface as good as the best modern block editors and a table surface as good as a spreadsheet's, without leaving the editor and without importing anything into a vault. Two halves, both first-class:

- **Documents.** Prose that looks like the finished document while you write it — the typography, block interactions and formatting of a modern document app, with no preview pane anywhere.
- **Datatables.** Tables you edit like a spreadsheet and read like a database: cell selection, Tab navigation, add and reorder rows and columns, then column widths, types, sort and filter. This is a headline feature, not a late-phase checkbox.

### Never name a competitor in anything a user reads

That covers the README and Marketplace listing, the site, command titles, setting descriptions, error messages, the changelog, and issue replies. Name the category instead:

- **"a modern block editor"**, **"block-based editors"** — the class, when the point is architecture or feel.
- **"a modern document app"** — when the point is polish.
- Best of all, just say the thing: "a centred reading column", "renders as you type", "type straight into the document".

Code comments are different: they say where a token or behaviour came from. That is engineering rationale and it should stay accurate. The rule governs how Sheaf describes *itself* to the people using it.

## No database. Git is the store.

**Everything Sheaf knows lives in files in the user's repository — the `.md` documents, the tables inside them, and any sidecar presentation state. There is no server, no account, no index, no cloud copy.** A user with Sheaf installed and a user with `git clone` and vim have exactly the same data.

This is not an implementation detail deferred until later; it is a boundary on the product. Nothing gets a backend, ever.

What it buys is most of a product for free. Git already provides history, blame, branching, review, offline editing, backup, access control and conflict resolution — all of it better than a small project would build, and all of it already running in the user's workflow. It also removes the failure modes that come with the alternative: no sync bugs, no migrations, no outage, no breach, no subscription, and no company whose death takes the documents with it.

### Where that boundary lies

Because git is the store, some things are permanently out of scope. Answer these requests with the boundary, not with a plan:

- **Cross-document queries and aggregation** ("every task across my docs"). That wants an index. An index is a cache — it may never become authoritative, and it is not on the roadmap.
- **Real-time collaborative editing.** Git's unit is a commit, not a keystroke.
- **Enforced schemas.** Column types are advisory hints for editing and display. Any other tool can write anything into a cell, and that must not corrupt the document.
- **Very large tables** are handled by referenced data files, not by a database — see below. What stays out of scope is what a database would add on top: indexes, joins and query planning.

Sheaf makes the tables that already exist in repository documents pleasant to edit.

### The consequence: diff size is a correctness concern

If git is the store, then **the shape of the diff is a feature, not a cosmetic detail.** Two people editing different rows of the same table should merge cleanly. That only happens if an edit rewrites the lines it changed and leaves the rest byte-identical.

So a serializer that reformats a whole block on any edit — realigning padding, renormalizing delimiters — is not a harmless tidy-up. It turns every concurrent edit into a merge conflict, on exactly the feature this project exists for. Prefer a minimal diff over pretty output. If normalizing a table's alignment is worth doing, it belongs in an explicit "format this table" command the user invokes, not as a side effect of typing in a cell.

## Non-negotiable design invariant

**Raw Markdown is the source of truth and Sheaf must never reserialize the document.**

Rendering is done with view-only CodeMirror decorations that hide syntax markers and draw widgets. The bytes on disk only change where the user actually typed.

This is an engineering constraint, not a marketing message. It is what makes the editing experience *safe to adopt on a repo you care about*, which is why it is absolute in the code and understated in the copy. Every ProseMirror/Milkdown-based alternative parses your file into a tree and serializes it back, quietly reflowing lists and normalizing tables until a one-word edit is a fifty-line diff. A change that introduces a parse-and-serialize round-trip defeats the point of the project, no matter how convenient it is.

### What the invariant actually constrains

It governs **how the `.md` file changes** — not **what Sheaf is allowed to do**. Replicating Markdown's feature set is the floor, not the ceiling. Markdown is a poor container for a lot of what a good editor should offer (column widths, table metadata, folding state, per-document view settings), and refusing to offer those things is not fidelity, it is just a smaller product. Sheaf may build on top of Markdown in three sanctioned ways:

1. **Local markup upgrade.** Write the markup the user asked for, into the range they acted on. Resizing, aligning or captioning an image upgrades that one image to an inline HTML snippet (`src/webview/images.ts`) because Markdown cannot express those things. Untouched bytes elsewhere stay untouched — that is the actual rule.
2. **Sidecar state.** Presentation and view state that has no home in Markdown lives in a companion file, leaving the `.md` byte-identical. Column widths, table sort/filter/type metadata, fold state and per-document settings belong here. This is the mechanism that makes datatable-grade features possible without a schema in the prose.
3. **Fenced-block data.** A fenced block is Markdown's own escape hatch: other tools render it as a code block, losing nothing. Sheaf already renders ```csv / ```tsv as an editable grid, and that is the right shape for structured data that genuinely belongs *in* the document.

### Two modes: Strict and Extended

The three mechanisms above are not equally portable, and users do not all want the same trade. So the choice is explicit, not a judgement call made per feature:

| | **Strict Markdown** | **Extended** (default) |
|---|---|---|
| Local markup upgrade (inline HTML) | ✗ | ✓ |
| Presentation sidecar | ✗ | ✓ |
| Referenced data file (large tables) | ✗ | ✓ |
| Fenced-block data (```csv, ```tsv) | ✓ | ✓ |
| Pipe-table editing | ✓ | ✓ |

Two rules define **Strict**, and both are about what lands on disk:

- **The byte rule.** Everything Sheaf writes into the `.md` is CommonMark + GFM. No raw HTML, ever — so no image resizing, alignment or captions, because those have no Markdown spelling.
- **The file rule.** The `.md` is the *only* file Sheaf writes. No sidecar, so nothing to add to `.gitignore`, nothing to explain to a teammate, nothing to leave behind.

Strict is for repositories with a policy: Markdown linted in CI, files run through pandoc or a static-site generator, or a team that simply does not want a second file appearing next to their docs. **Extended** is for everyone else, and it is where the datatable features live.

Note what Strict does *not* cost. A fenced block is core CommonMark and a pipe table is GFM, so grid editing, CSV/TSV blocks, Tab navigation, row and column operations and every prose feature work identically in both modes. Strict is not a crippled mode; it is the same editor writing a narrower set of bytes.

**Presentation state in Strict is session-only.** Column widths and view sort still work while the document is open — they simply live in memory and are gone when it closes, because their only home would have been the sidecar. That is better than disabling them, and it loses nothing on disk.

Two implementation rules follow:

1. **Never silently degrade.** An action unavailable in Strict must be visibly disabled and say why ("Resizing writes inline HTML, which Strict Markdown mode does not allow"). A feature that quietly does nothing reads as a bug.
2. **The mode is a property of the project, not the person.** It is a workspace-scoped setting so a repository can commit its choice in `.vscode/settings.json` and every contributor inherits it.

The default is **Extended**: datatables are the headline feature and shipping them switched off means most users never see them, while the degradation test below already guarantees the file stays correct everywhere. Pre-1.0 is the time to revisit that if it proves wrong.

### Two kinds of companion file

"Sidecar" has been doing two jobs, and they need opposite rules. Keep them distinct:

**1. The presentation sidecar.** Automatic, invisible, keyed to the document, and safe to delete. Holds column widths, view sort, filters, fold state — how the document *looks*. It may never hold content and may never be needed to interpret the `.md`. Delete it and you lose only the arrangement. Extended only.

**2. The data file.** A real file the user asked for, referenced by path from the document, and committed like any other source. This is how large tables work: the rows live in `data/sites.csv`, and the document carries a fenced block naming it.

The second one holds content, which the presentation sidecar may never do. That is not a contradiction, because it is not hidden state — it is a **dependency, exactly like an image**. `![](chart.png)` does not render the chart's pixels as text on GitHub either, and nobody calls that a broken document. A referenced data file is honest, visible, in the repo, and diffable. A presentation sidecar that quietly held rows would be none of those things.

Hard rules for data files:

- **Never automatic.** A pipe table becomes a data file only when the user explicitly converts it. Silently moving someone's rows into another file would be the single most alarming thing this editor could do.
- **Referenced, never implied.** The document names the file. Nothing is loaded by convention, filename guessing or directory scanning.
- **A missing file is an error the reader can see**, rendered in place, naming the path. Never a silent empty table.
- **The row format must diff well**, because git is the store. One row per line, always.

Which container to use is a size question, and the editor should say so when it offers the conversion:

| Rows | Container | Why |
|---|---|---|
| Tens | Pipe table in the `.md` | Reads well as prose. Works in Strict. |
| Hundreds | Fenced ```csv / ```tsv block | Still one file, still core CommonMark. Works in Strict. |
| Thousands+ | Referenced data file | Keeps the prose readable and the diffs sane. Extended only. |

### The degradation test

Both modes must pass this, Extended included: **open the file in GitHub, Obsidian, or vim with no Sheaf, no sidecar. It must still be a correct, complete, readable document.** Sheaf may make a file nicer; it may never make it wrong or unreadable elsewhere.

That gives the **presentation sidecar** its hard rules. It is additive and optional — delete it and the document still opens, still reads correctly, and loses only arrangement. It may never hold content, and it may never be required to interpret the `.md`. If losing it would lose the user's words, the design is wrong and the data belongs in the document.

A **data file** is judged differently, the way an image is: the test is not "is the document complete without it" but "is the reference visible, honest, and resolvable from the repository". A fenced block naming `data/sites.csv` passes — a reader sees exactly where the rows live and can open them in anything. A binary blob, an opaque key, or a path outside the repo does not.

## One editor, several hosts

The editor is a bundle that runs in a browser. VS Code is one place to put it, behind a custom editor provider; a local server that hands a folder to a browser tab is another. More will follow. What makes any of that safe to claim is a single rule:

**The editor bundle is the same bytes in every host.** `media/webview.js` built for the extension is the file the browser loads. There is no second editor, no port of one, and therefore nothing that can drift. The bundle reaches its host through exactly two things: the `acquireVsCodeApi()` global it calls at module scope, and `window.postMessage`. Supplying those is the whole of what a host does.

Two directories follow from that, and which one a thing belongs in is decided by one question: should it exist in VS Code?

- **Exists in every host, the same** — `src/webview/`. This is nearly everything.
- **Exists in every host, but differs** — still `src/webview/`, gated by a capability the host declares. See below.
- **Exists around the editor rather than inside it** — `src/server/`. A file tree beside the document is the example: VS Code has an Explorer, so a second one inside the webview would be a worse copy sitting next to the real one. The page builds it, and the bundle never learns it exists.

A check in the host suite enforces the split by bundling the editor and reading what esbuild actually pulled in, so a module reached through three others is caught the same as a direct import.

### Capabilities, and why there should be few

A host that cannot do something says so in `init`, and the editor leaves that thing out. The first is the terminal: there is none behind a browser tab, so the right-click menu drops **Send to terminal** rather than offering an item that does nothing when pressed. Never silently degrade applies here as it does in Strict mode.

Two rules keep this from becoming a hole in the guarantee above.

**Absence means everything.** A host that sends no capabilities has them all, which is VS Code. If the editor's own host ever started sending a list of its own, every ability would depend on somebody remembering to add it there, and forgetting would quietly take a command away with nothing failing. A check pins that silence.

**The host decides, not the page.** A capability is a fact about the process behind the editor, so the process states it. The browser's shim carries the answer and has no opinion of its own: policy in a transport is how a decision ends up somewhere no test can see it.

**Keep the list short.** One capability is a fact about a host. Twenty would be a second product built out of conditionals, and identical bytes doing different things is drift with extra steps. If a third arrives, that is the moment to stop and ask whether the difference belongs in the editor at all.

## Release checklist

Releases are built and published by `.github/workflows/release.yml`, which fires on a version tag. Publishing from a laptop is no longer the path: the workflow attests the `.vsix` it builds, and a hand-uploaded build carries no attestation to verify.

**`npm run release` is the whole of it**, and the maintainer runs it. It proves the release will pass, then cuts it, asking for the release key's passphrase once and for nothing else. `npm run release:check` is the same proof with the cut left off: it changes nothing, needs no credentials, and anybody can run it as often as they like.

What the check half does, in order, stopping at the first failure and before anything is pushed:

1. The checkout is `main`, has no uncommitted changes, and is level with `origin/main`.
2. `CHANGELOG.md` has a **dated** section for the tag, and `changelog-notes.mjs` can build the release notes out of it. The accumulator under `## [Unreleased]` gets its version heading at release time and not before: `npm version` stamps it through the `version` lifecycle script, and `npm run stamp-changelog <version>` does the same by hand. A dated heading written ahead of its tag tells a reader a version shipped when it did not, and splits the accumulator so the next release looks smaller than it is.
3. Where the tag currently points on `oss`, so moving one is said out loud rather than discovered.
4. **CI, here, on the tree the tag will name**: clone `main`, `npm ci` from the lockfile, `npm run gates`, `npm run package`. A clone rather than a `git archive` export, because the gates include a host check that reads the repository's own top-level paths out of git and an export has no `.git` to read.

Step 4 is the one that exists because of a specific failure. v0.2.0 was tagged, its workflow failed the gates, nothing published, and the tag had to be moved. The gates had passed on `main`; what nobody had run was the gates **after** `npm version` stamped the changelog, which is the last thing to change before a tag. A release should not be a thing that is tried.

What the check cannot answer, and says so rather than leaving it unsaid: the build attestation, the GitHub Release, and the two registry publishes all need credentials no developer machine holds.

The cut half rebuilds the `release` tree from `origin/main`, refuses unless the staged tree is `origin/main`'s exactly, commits, and pushes the branch and the tag inside one `ssh-agent` that it starts and that dies with it, so the passphrase is asked for once and nothing is left unlocked. **Nobody else creates or pushes a tag.**

The Marketplace publish signs in with Microsoft Entra ID and stores no secret. The release job runs in the `release` environment, and an Entra identity with a federated credential for that environment exchanges the workflow's OIDC token for a sign-in (`azure/login`, then `vsce publish --azure-credential`). The identity must be a Contributor on the `sheafeditor` publisher. Its client and tenant IDs go in the `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` repository variables, and until both are set the Marketplace publish is skipped. A dry run from **Run workflow** signs in, prints the identity's Marketplace ID, and says whether it can publish yet. Open VSX still uses a token, the `OVSX_PAT` secret, and its publish is skipped until that exists. The `VSCE_PAT` secret is a fallback used only while the Entra variables are unset, and it stops working on 2026-12-01 when Azure DevOps retires global personal access tokens; remove the secret and its two workflow steps after that. Both registries receive the same attested file, which is why the workflow passes `--packagePath` to each rather than letting either tool repackage. `npm run publish` and `npm run publish:ovsx` still work for an emergency, but a release published that way has no provenance behind it, and `npm run publish` needs a token that also ends on 2026-12-01 (after that, `vsce publish --azure-credential` from a checkout signed in with `az login`).

Open VSX is how Sheaf reaches editors built on Code OSS. Kiro, Cursor, Windsurf and VSCodium cannot install from the Marketplace, and open-vsx.org is the registry they query instead. It needs one setup step nobody can automate: an Eclipse Foundation account has to sign the Publisher Agreement and claim the `sheafeditor` namespace (`npx ovsx create-namespace sheafeditor`) before any token can publish. That account is publicly linked to the namespace.

While pre-1.0, `priority: "default"` on the custom editor means installing Sheaf takes over every `.md` file. Keep the escape hatch working and documented in the README: the **Open raw Markdown** button at the right end of the formatting toolbar, and the **Open as Raw Markdown (Text)** command in the palette. Sheaf contributes nothing to the editor title bar; that space belongs to VS Code.

## Conventions

- TypeScript, bundled with esbuild. Extension host code in `src/`, webview code in `src/webview/`.
- Tests are plain Node scripts under `test/`; `npm test` runs them. Most of them mount the webview in jsdom, and two do not: the sync suite is pure functions, and the server suite drives the local server over HTTP.

## Dev process

Sheaf is a VS Code extension, so there is no dev server, port or database to run. Code changes land on `main`.

- **The gates, in one command:** `npm run gates` runs the documentation check, the type check, every suite, the jsdom half of the real-editor scenarios (`test:editor:unit`, every area, about half a minute) and the production build, in that order, stopping at the first failure. Prefer it to running the three yourself, and never chain them with `&&`: a single command is one thing to approve and one thing to read, and the three must not overlap anyway, for the esbuild reason under **Build** below.
- **Type check:** `npm run check-types`.
- **Tests:** `npm test` runs eight suites (engine, tables, sync, host, prose, server, browser-host, harness), bundling each with this checkout's own esbuild before it runs. Three mount the webview in jsdom. The sync suite is pure functions. The host suite is `test/host.test.mjs`, which drives extension-host code against a stand-in `vscode` module, so it covers commands, menu contributions and settings scopes the webview suites cannot reach. The server suite drives the local server over HTTP. The browser-host suite drives `src/server/host.ts` under jsdom, which is the other half of that: the server suite never loads the page's own module, and the webview suites replace it with a stand-in `acquireVsCodeApi`, so without this the one file that *is* the browser host had no check on it. The harness suite is the test harness checking itself, and it needs no bundle because what it drives is plain Node. Prose scenarios live in `test/prose/*.ts` and are registered in `test/prose.entry.ts`; table scenarios live in `test/tables.entry.ts`.
- **One suite while you work:** `npm run test:prose`, and the same for `test:engine`, `test:tables`, `test:sync`, `test:host`, `test:server`, `test:browser-host` and `test:harness`. Each bundles only what it runs, so it costs a second rather than the whole set. `node scripts/run-tests.mjs tables host` takes several at once. Run the full `npm test` before landing.
- **Real editor checks:** `npm run test:editor <area>` drives a real VS Code window through the scenarios in `test/real-editor/editor/`, and `npm run test:editor:unit <area>` runs the jsdom half. Areas are the file names there: `tables-select`, `pointer`, `cell-editing`, `media` and the rest. Add a scenario id to run one, as in `npm run test:editor pointer mouse-selection.e13`. `playwright-core` is a pinned dependency of this repository, so `npm ci` is all either needs. Pinned rather than floating because a minor bump changes which browser build it asks for, and that build then has to be downloaded. `PLAYWRIGHT_CORE` still overrides where it is resolved from, for a checkout with no install, and `SHEAF_EDITOR_RUNS` says where run folders go; set both in the environment rather than on the command line, so the command reads the same everywhere.

  It used to be resolved *only* through that variable, pointing into an unrelated project's `node_modules`. An `npm ci` over there would have taken out the whole browser tier of this repository, and taken it out **silently**: each of those checks prints `skipped` and exits 0, so the gates would have gone on reporting success over the half of the bar that jsdom cannot stand in for.
- **A real-window run builds nothing, so a source change nobody built is invisible to it.** The run launches VS Code with `--extensionDevelopmentPath` at this checkout, and VS Code loads whatever `dist/` last held. Nothing warns you. The consequence is that every control run in a real window has to rebuild, or it proves nothing: disabling auto-save in `src/markdownEditorProvider.ts` and running a scenario that depends on it passes, because the edit never reached `dist/`, and the same edit with `npm run build` in between fails. A control that passes when it should fail is worse than no control, because it is read as evidence the behaviour is safe. `npm run gates` builds, so a landing is covered; it is the loop of edit, run, edit, run that is not.
- **One window at a time, and runs queue for it.** A real-editor run drives the one screen, so it takes a lock and waits for whoever has it, printing what it is waiting for. A lock left behind by a run that was killed is taken over and said out loud. `--no-wait` fails instead of queueing, and `SHEAF_ALLOW_CONCURRENT=1` skips the lock for a run meant to share. The jsdom half needs none of this, since it drives no window.
- **The lock is one file per account, at `~/.local/state/agent-screen.lock`.** Its name carries no project, because the screen belongs to the machine rather than to this repository: anything else here that drives a pointer should take the same file, and a lock named for one project makes two projects invisible to each other. It used to sit under whatever directory a run kept its output in, so two runs configured differently looked in two places and queued on the process list instead, losing the line that says who holds the screen and what they are running. `SHEAF_SCREEN_LOCK` moves it, which is how the harness checks take and break locks without touching a live one.
- **A run that cannot find `dist/extension.js` is an empty `node_modules`, not a regression.** Every real-editor scenario throws `no visible Sheaf editor`, the console says `Cannot find module …/dist/extension.js`, and the build wrote nothing. Fifty failures at once that read like something catastrophic, and the cause is that the install is not there — an interrupted `npm ci` leaves the directory emptied, because it deletes before it installs. Run `ls node_modules` before believing any of it. Note also that `npm ci` in a directory whose `node_modules` is a *symlink* deletes through the link and empties whatever it points at, so a checkout that shares its install with another one should use `npm install`, which replaces the link instead.
- **Everything the build needs is in this repository.** `npm ci` installs it, and the scripts call the binaries in `node_modules`. Never reach for `npx`, a global install, or a helper script written to a temporary directory: if a step is worth running twice it belongs in `scripts/` with an entry in `package.json`, where the next person and CI both get it.
- **Edit files with the file tools, not with a shell one-liner.** A `python3 - <<EOF` or a `sed -i` that rewrites a source file is unreviewable, easy to get wrong on a file someone else is editing, and needs approval every time it runs. Use the editor's own read and edit tools for source changes, and a script in `scripts/` for anything mechanical enough to repeat.
- **Build:** `npm run build` writes `dist/extension.js` and `media/webview.js`. Run the gates one at a time: `npm test` and `npm run build` both drive esbuild over this checkout, and overlapping them makes the test run print no counts and the build end in a stack trace, with nothing actually wrong.
- **A `.vsix` to install and try:** `npm run package:clean`, which exports a commit with `git archive`, installs into that export and packages there, leaving this checkout alone. It takes `--ref <commit>` (default `HEAD`) and `--out <dir>` (default `.claude/scratch/build`, which is gitignored). `npm run package` packages the working tree instead, which is what CI uses and what the release checklist means; prefer the clean one by hand, since it packages exactly a commit and nothing uncommitted.
- **Secrets:** gitleaks runs in a machine-wide pre-commit and pre-push hook. Fix a finding at its source; never bypass the hook.
- **A change to behaviour searches `docs/` for what it just made false, in the same commit.** The pages in `docs/` are what a person reads, and they spell things out: the order of a menu's items, the keys a shortcut uses, what a setting's values are called. None of that is checked against the code and none of it can be. `check-docs.mjs` reports that nothing private leaks and every link resolves, which is a different question, and it passes cheerfully over a page describing a menu that was reordered underneath it. A reordered menu shipped that way once, and the page was wrong in the public repository and on the website, both of which build from `docs/`, until somebody read it.
- **Landing:** changes land on `main`, and the whole of `npm run gates` runs again before an issue is closed. A handed-over result is not a landing gate: the gates are re-run where the change is landing, not read off the branch's own report.

- **A feature arrives with a surface ledger and a control log, and lands with neither missing.** These two are the landing gate, and they exist because of what a day of green gates missed: six defects in one afternoon, every one of them passing every check, none of them logic anybody got wrong. They were one shape, the same fact declared on both sides of a boundary with nothing comparing the two, and more tests of the kind already there would have caught none of them.

  The **surface ledger** names every surface the feature could touch and marks each one reached, or not applicable with a reason. A row left blank is the defect: all four settings bugs were a surface nobody had thought about, and the list is what makes not thinking about one visible.

  The **control log** says, for every check protecting the feature, what was broken to make it fail, what it said when it failed, and that it was put back. A check nobody has seen fail is a claim, not a check. The failure this catches most often is a check that cannot discriminate: a guard that can only pass or be inconclusive, a probe that reads a rule rather than the drawing, a control whose edit never applied.

- **One feature lands at a time, and one waits for review at a time. Building is not limited.** The first is mechanical: a second branch landing while the first is in review means the branch that was reviewed is not the branch that lands, so the bar binds to nothing. The second is about the reviewers rather than the integrator, because five branches arriving together turn a high bar into a rushed one, and a bar that gets skipped under load is worse than none, since it still gets claimed afterwards.

  Nothing here limits work in progress. Parallel building is what produced most of a day's landings against two real costs, and one of those two was an assignment failure rather than a concurrency one: two sessions fixed the same bug unaware of each other, which would have been just as wasteful in series and only slower to find. **Claim the issue before starting.** It costs nothing and it is the thing that actually prevents the duplication.

- **Neither review pass is run by the session that wrote the feature.** Every one of those six defects was found by a session other than its author, and self-review found none of them.

- **The real-window suite is not optional for a change a person can see, and it is the affected areas rather than all of them.** The whole suite is 950 scenarios across 43 areas, about two hours, so requiring it per landing would mean it never runs. The distribution is what makes the rule affordable: eight areas hold 617 scenarios and the other 35 hold 333 between them, 24 of those under eight scenarios each and under a minute.

  Only four areas are genuinely expensive, `render`, `host`, `prose` and `blocks`, and a change reaching all of them runs them in that order inside its budget and names the rest as waiting for the nightly. Everything else is one to three areas and usually under two minutes, which is cheap enough that not having time is not an argument.

- **Count an area's scenarios by importing it, never by grepping `id:`.** A tenth of them are built rather than written as a literal property, and whole areas import or re-export their scenarios from elsewhere. Grepping gives 824 against 950 real: `table-ops` reads 64 against 124, `tables-select` 7 against 32, `pointer` 4 against 22, and `reveal-source` 0 against 9, because it re-exports from `render.mjs`. An area that appears to hold no scenarios at all is the tell. `scripts/check-scenarios.mjs` imports each area for this reason and says so.
- **A commit that resolves an issue names it, in the body, on its own line.** The subject stays a sentence about what changed. A commit that resolves no issue names none, and that is a real answer rather than an omission.

  Without it the queue cannot be swept. Sweeping means grepping the history for issue identifiers and comparing against what is still open, and work that landed without naming its issue is invisible to that in both directions: the issue sits in the queue until somebody remembers it, and a second session sometimes redoes it. Two commits landed in one hour naming nothing, one of them fixing half of an open High, and both were mine.

- **Issues:** a fixed issue gets a comment naming its commit before it is closed, and that comment answers the issue's own verification list item by item, naming the items that were **not** met.

  Not "this is fixed", but "these three are met, this fourth is not, and here is why". A close that cannot say what it did not verify has not read the list. Two issues have been closed from a commit subject rather than from their own verification list, and both were reopened: one had done two real things out of seven, and the other named an issue that stayed broken. The commit message is the wrong place to catch that, because it asks the author to predict how complete their own work is, which is the judgement that was already wrong.

  Where a fix covers part of an issue, the issue stays open and the comment says which part landed. Where a check can only be run in a real window and was not, the comment says so rather than leaving the reader to assume the whole list was answered.
- **Real editor checks:** jsdom has no layout, pointer capture, input methods or VS Code key forwarding, so behaviour that depends on them is confirmed in a real VS Code window before it is trusted. Three things about driving one with Playwright's Electron support, each of which cost several attempts before it was understood. A driven window keeps an inactive editor's webview alive, so select the frame by its content rather than taking the first match. A modifier has to be *held across* the click with `keyboard.down` rather than passed as a click option or sent as a key press; done that way Cmd-click drives correctly. And native UI is invisible to the driver unless `window.dialogStyle` is set to `custom`, which renders dialogs as DOM: a menu that never appears or a tab that will not close usually means something native is waiting offscreen rather than that the gesture did nothing. Earlier notes here claimed modifiers and chords could not be driven at all. They can, and a false impossibility is worse than silence, because it stops the next person trying.
- **A capture-phase listener is not a boundary detector.** `pointerleave`, `mouseleave` and `pointerenter` do not bubble, but a listener registered with `capture: true` on `document` still receives them for *every* element inside it, because capturing runs on the way down to the target. So `document.addEventListener('pointerleave', fn, true)` fires when the pointer crosses from one line of the document to the next, not when it leaves the page. Reading that as "the pointer has left" and ending a drag on it cancelled twelve drag scenarios at the first boundary crossed, while the scenario the change was written for passed throughout. To mean the page, listen on `document.documentElement` without capturing, and check what actually arrives before building on it: a webview embedded in another application receives no leave event at all when the pointer moves out over that application's own chrome, and none when a button is released out there either.
- **Publishing** happens only when the maintainer says so. **Never create or push a tag:** a `v*` tag fires the release workflow, which builds and can publish to the Marketplace and Open VSX, and that reaches real machines.
