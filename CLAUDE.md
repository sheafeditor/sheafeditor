# Sheaf — project steering

> **This file ships in the public repository.** It is engineering steering and nothing else. The issue tracker and its ticket numbers, commercial positioning, pricing and revenue thinking, the maintainer's identity, and how the sessions on this machine are organised all belong in the private `brain` repo instead. A pre-commit hook scans this file for that material and stops the commit, which is a reminder rather than a wall: if it fires on something legitimate, move the text or widen the hook deliberately.

## What this is

Sheaf is a WYSIWYG editor for the Markdown documents and tables already in your repo, with the feel of a modern block editor, built for VS Code as a `CustomTextEditorProvider` over CodeMirror 6, and running unchanged in editors built on Code OSS.

**This project is built to be public.** The repo is being opened up at [github.com/sheafeditor/sheafeditor](https://github.com/sheafeditor/sheafeditor), and the extension is headed for the VS Code Marketplace under the `sheafeditor` publisher for other people to install and use. Nothing has shipped yet — version is still `0.0.1` and unpublished — but this is not a personal/internal tool, and it should never read like one.

Treat that as the governing constraint on every change:

- **Assume an outside audience.** Code, comments, docs, commit messages, and issue replies are read by strangers. No internal shorthand, no unexplained references.
- **Never commit anything private** — no local paths, credentials, tokens, API keys, internal URLs, or personal data. Check before adding files.
- **Secrets are what must never land here**, and gitleaks enforces it in a machine-wide pre-commit and pre-push hook. Fix a finding at its source, or record a false positive in `.gitleaksignore` with a note. Never bypass the hook.
- **Two remotes, two rules.** `origin` is the private development repo and takes anything. `oss` is the public one, and a repo-local pre-push hook allows only the `release` branch to reach it. `main` carries unreviewed agent commits and must never be pushed there.
- **User-facing text is product copy.** Command titles, setting descriptions, error messages, and README prose are the product. Write them for a first-time user who has no context.
- **Breaking changes matter from first publish.** Once the extension is on the Marketplace, changing a setting name, a command ID, or the `sheaf.wysiwyg` view type breaks real installs. Rename only with a deprecation path, and say so in the changelog. (Renames done *before* first publish are free — that is why the `nib` → `md-editor` → `sheaf` history costs nothing, and why the legacy view-type list in `src/defaultEditor.ts` can eventually be dropped.)

## What Sheaf is for

**The best documents-and-datatables editing experience in VS Code.** When a roadmap or design argument is close, settle it against that sentence.

The bar: a developer who keeps their docs in the repo should get a writing surface as good as the best modern block editors and a table surface as good as a spreadsheet's, without leaving the editor and without importing anything into a vault. Two halves, both first-class:

- **Documents.** Prose that looks like the finished document while you write it — the typography, block interactions and formatting of a modern document app, with no preview pane anywhere.
- **Datatables.** Tables you edit like a spreadsheet and read like a database: cell selection, Tab navigation, add and reorder rows and columns, then column widths, types, sort and filter. This is a headline feature, not a late-phase checkbox.

### Never name a competitor in anything a user reads

That covers the README and Marketplace listing, the site, command titles, setting descriptions, error messages, the changelog, and issue replies. Name the category instead:

- **"a modern block editor"**, **"block-based editors"** — the class, when the point is architecture or feel.
- **"a modern document app"** — when the point is polish.
- Best of all, just say the thing: "a centred reading column", "renders as you type", "type straight into the document".

Internal writing is different. The design and research docs in the private `brain` repo compare named products, and code comments say where a token or behaviour came from. That is engineering rationale and it should stay accurate. The rule governs how Sheaf describes *itself* to the people using it.

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

Sheaf is not competing with hosted database products. It is making the tables that already exist in repository documents pleasant to edit.

### The consequence: diff size is a correctness concern

If git is the store, then **the shape of the diff is a feature, not a cosmetic detail.** Two people editing different rows of the same table should merge cleanly. That only happens if an edit rewrites the lines it changed and leaves the rest byte-identical.

So a serializer that reformats a whole block on any edit — realigning padding, renormalizing delimiters — is not a harmless tidy-up. It turns every concurrent edit into a merge conflict, on exactly the feature we are selling. Prefer a minimal diff over pretty output. If normalizing a table's alignment is worth doing, it belongs in an explicit "format this table" command the user invokes, not as a side effect of typing in a cell.

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

## Release checklist

Releases are built and published by `.github/workflows/release.yml`, which fires on a version tag. Publishing from a laptop is no longer the path: the workflow attests the `.vsix` it builds, and a hand-uploaded build carries no attestation to verify. Before tagging:

1. `npm run check-types && npm test` pass.
2. `CHANGELOG.md` has an entry for the new version — user-visible changes, written for users, not a commit log.
3. `npm run package` and inspect `unzip -l sheafeditor-*.vsix`: it should contain only `dist/`, `media/`, `package.json`, `readme.md`, `changelog.md`, and `LICENSE.txt`. Anything else means `.vscodeignore` needs updating.
4. The maintainer runs `npm version <major|minor|patch>` to bump and tag, then pushes the tag. Nobody else does: an agent never creates or pushes a tag. The workflow re-runs the gates above, checks the tag against `package.json`, builds, attests, creates the GitHub Release, and publishes to the Marketplace and Open VSX.

Each publish step stays inert until its own repository secret exists (`VSCE_PAT` for the Marketplace, `OVSX_PAT` for Open VSX), so the workflow can be exercised end to end before anything goes public. Both registries receive the same attested file, which is why the workflow passes `--packagePath` to each rather than letting either tool repackage. `npm run publish` and `npm run publish:ovsx` still work for an emergency, but a release published that way has no provenance behind it.

Open VSX is how Sheaf reaches editors built on Code OSS. Kiro, Cursor, Windsurf and VSCodium cannot install from the Marketplace, and open-vsx.org is the registry they query instead. It needs one setup step nobody can automate: an Eclipse Foundation account has to sign the Publisher Agreement and claim the `sheafeditor` namespace (`npx ovsx create-namespace sheafeditor`) before any token can publish. That account is publicly linked to the namespace.

While pre-1.0, `priority: "default"` on the custom editor means installing Sheaf takes over every `.md` file. Keep the escape hatch — **Open as Raw Markdown (Text)** in the editor title bar — working and documented in the README.

## Conventions

- TypeScript, bundled with esbuild. Extension host code in `src/`, webview code in `src/webview/`.
- Tests are plain Node scripts under `test/` driven by jsdom; `npm test` runs them.
- Design and research docs live in the private `brain` repo, not here. They are internal thinking: competitive research, the roadmap, design language and architecture rationale. Update them there when architecture changes.

## Dev process

Sheaf is a VS Code extension, so there is no dev server, port or database to run. One builder session changes code, in this checkout, on `main`.

- **Type check:** `npm run check-types`.
- **Tests:** `npm test` runs five suites (engine, tables, sync, host, prose). Four are jsdom; the host suite is `test/host.test.mjs`, which drives extension-host code against a stand-in `vscode` module, so it covers commands, menu contributions and settings scopes that the webview suites cannot reach. Its `pretest` step rebuilds the test bundles first. Prose scenarios live in `test/prose/*.ts` and are registered in `test/prose.entry.ts`; table scenarios live in `test/tables.entry.ts`.
- **Build:** `npm run build` writes `dist/extension.js` and `media/webview.js`. Run the gates one at a time: `npm test` and `npm run build` both drive esbuild over this checkout, and overlapping them makes the test run print no counts and the build end in a stack trace, with nothing actually wrong.
- **Secrets:** gitleaks runs in a machine-wide pre-commit and pre-push hook. Fix a finding at its source; never bypass the hook.
- **Remotes:** two, with different rules. `origin` is `sheafeditor/sheaf-dev`, private, and takes anything. `oss` is `sheafeditor/sheafeditor`, public at launch, and the pre-push hook allows only `refs/heads/release` to reach it. `main` carries unreviewed agent commits and must never be pushed there.
- **Landing:** fixes are committed straight to `main`. Work done in agent worktrees is cherry-picked onto `main`, and the type check, all five suites and the build run again before the issue is closed.
- **The index is shared, even when the paths are not.** Several sessions commit in this checkout at once. `git add <path>` leaves your file in an index another session may commit a moment later, and `git cherry-pick --continue` commits whatever the index holds rather than the paths you resolved. Both have already carried one session's file into another session's commit, under the wrong author and an unrelated message. Read `git status` immediately before committing, and commit with `git commit --only <paths>`, which builds its own temporary index and never stages through the shared one. **`--only` defends the paths, not the file.** It commits whatever the named path holds at that moment, so another session's edits *inside* a file you name come along with yours: that is how one session's rewrite of this file landed under another session's commit about a test harness. A `git diff --numstat` read a minute earlier proves nothing. Read `git diff <path>` immediately before the commit, and leave a file alone entirely while another session is rewriting it. A commit that already swept up foreign work is not worth rewriting once others have built on it: the content is right and only the attribution is wrong. Resolve a conflict promptly rather than leaving it open: esbuild walks up out of an agent worktree to this checkout's `package.json`, so a conflicted file here fails every agent's test run with a JSON parse error, not just yours.
- **Issues:** bugs are worked in priority order from the maintainer's tracker. A fixed issue gets a comment naming its commit on `main` before it is closed.
- **Real editor checks:** jsdom has no layout, pointer capture, input methods or VS Code key forwarding, so behaviour that depends on them is confirmed in a real VS Code window before it is trusted. Three things about driving one with Playwright's Electron support, each of which cost several attempts before it was understood. A driven window keeps an inactive editor's webview alive, so select the frame by its content rather than taking the first match. A modifier has to be *held across* the click with `keyboard.down` rather than passed as a click option or sent as a key press; done that way Cmd-click drives correctly. And native UI is invisible to the driver unless `window.dialogStyle` is set to `custom`, which renders dialogs as DOM: a menu that never appears or a tab that will not close usually means something native is waiting offscreen rather than that the gesture did nothing. Earlier notes here claimed modifiers and chords could not be driven at all. They can, and a false impossibility is worse than silence, because it stops the next person trying.
- **Publishing** (a version tag, or anything pushed to a public repository) happens only when the maintainer says so. Work lands on `main`; `release` is what gets published. A publish is a squash-merge of `main` into `release` followed by `git push oss release`, so the public repository sees one reviewed commit rather than hundreds of agent commits. `release` has no shared history with `main` by design. **Never create or push a tag:** a `v*` tag fires the release workflow, which builds and can publish to the Marketplace and Open VSX, and that reaches real machines.
