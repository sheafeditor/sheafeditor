/*
 * Which constructs this surface draws, which is the one fact in this file.
 *
 * It lives on its own rather than beside the editor that sets it, for the reason `inlineOnly.ts`
 * does: the drawing layer reads it, the surface declares it, and a facet lets neither import the
 * other. `livePreview.ts` asking the library's editor entry what profile it is would point the
 * arrow from the thing that draws at the thing that composes it, which is the import that closed a
 * cycle through four modules the last time it was tried and made the `notes` size floor
 * byte-identical to the `field` one.
 *
 * **Absence means everything**, which is the rule the host capabilities already follow and it
 * matters for the same reason. The extension's own editor declares nothing and draws every
 * construct; if it had to list them, every drawing would depend on somebody remembering to add it
 * to that list, and forgetting would quietly take a construct off the screen with nothing failing.
 * A surface that carries less than everything says so, and only the library's `mount` does.
 *
 * **What a surface does with a construct it does not carry is show it as its own characters,
 * editable** — the pipes of a table, the `![alt](src)` of an image. Not a placeholder, which is a
 * thing a person cannot edit in a surface whose whole job is editing, and not nothing, which makes
 * content that vanished indistinguishable from content nobody wrote. An editor always has somewhere
 * legitimate to put source; the render path, which has no caret, names the construct instead.
 *
 * So refusing to draw is the whole of what this does. Nothing here hides, replaces or removes
 * anything: a construct outside the set simply has no decoration applied to it, and the bytes that
 * were always the document stay on the screen.
 *
 * **Why this one is in `src/webview/` when the table it carries values from is in `src/dialect/`.**
 * Which constructs a profile carries is a fact about the bytes and belongs below everything that
 * reads it. Which constructs *this editor* draws is a fact about an editor, declared by the
 * extension set that built it and read by the decorations, and a `Facet` is a CodeMirror type. A
 * grammar that could be asked what a surface draws would be a grammar that knows an editor exists.
 */
/*
 * **`@codemirror/state` and nothing else**, which is the same rule `inlineOnly.ts` keeps and it is
 * measured rather than intended. This imported `carriedBy` from `src/dialect/profileConstructs.ts`
 * so that it could offer the surface's set as well as the facet, and that put the profile table in the
 * extension editor's closure, where nothing reads it: the `document` profile declares no facet. The
 * size ratchet reported the growth. The surface that needs the set imports the table itself, which
 * is one import rather than one module in the wrong closure.
 */
import { EditorState, Facet } from '@codemirror/state';

/**
 * The constructs the surface carries, or nothing at all when it carries them all.
 *
 * `null` rather than a set of every name, so that the default is a fact about the facet rather than
 * a list that can fall behind the table. A surface that declares the facet twice is a mistake with
 * no sensible resolution, so the first value wins and the rest are ignored, as `inlineOnly.ts` does.
 */
export const drawnConstructs = Facet.define<ReadonlySet<string>, ReadonlySet<string> | null>({
  combine: (values) => (values.length > 0 ? values[0] : null),
});

/**
 * Whether this surface draws `construct`.
 *
 * True on a surface that declared nothing, which is every host but the library's `mount`. On one
 * that did, true only where the specification's table puts the construct in its profile, so a
 * construct the table has not placed is absent — the direction the table takes for anything
 * undecided, and the reason diagrams are refused by both layers without either having decided it.
 */
export function draws(state: EditorState, construct: string): boolean {
  const carried = state.facet(drawnConstructs);
  return carried === null || carried.has(construct);
}
