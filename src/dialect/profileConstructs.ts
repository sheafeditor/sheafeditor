/*
 * Which constructs each profile carries, which is the one fact in this file and has no imports.
 *
 * Three layers read it and none of them may load the others. The render path asks what a profile
 * owes before it renders a node. The drawing layer asks before it draws one, through the facet in
 * `src/webview/drawnConstructs.ts`. The library's editor entry declares that facet for the profile
 * it was mounted as. The render path may not load an editor and the drawing layer may not load the
 * render path, so the fact has to sit below all three.
 *
 * **Beside the grammar, because the keys are the grammar's.** A profile is a set of constructs, and
 * a construct is what the dialect says it is, so this is a fact about the bytes rather than about
 * anything that draws them. It is the same layering `maths.ts` beside it states: a module that says
 * what a construct is may not import from `@codemirror/view`. This one imports nothing at all. It is
 * a leaf rather than part of `markdown.ts` because it adds no parser extension, and nothing in
 * `markdown.ts` imports it, so the dialect's own closure is unchanged.
 *
 * **It was in `src/render/markdown.ts` and moved out when the drawing layer needed it.** Leaving it
 * there and writing a second list beside the editor is the arrangement this file exists to refuse: a
 * surface that renders a table as refused source before it is focused and draws a grid after it is
 * the most visible way a library of this kind loses trust, and two answers to "does this profile
 * carry a table" is how that state becomes reachable. `markdown.ts` re-exports it, so a reader who
 * goes looking there still finds it.
 *
 * Keys are the dialect's node names, with the exceptions that are not nodes: `Callout`, which the
 * editor recognises in its drawing layer, `BlockMath`, which is found by reading lines, and
 * `InlineMathMark`, listed because the specification's table lists it.
 *
 * **A construct absent from this table is carried by no profile.** That is the default direction the
 * specification takes for anything undecided: adding to a profile later breaks no consumer, and
 * removing from one breaks them silently. Diagrams are the construct that is in that state today,
 * and both layers agree that a surface shows one as its own characters because of this line rather
 * than because either of them decided it.
 */

/** The two profiles a mounted surface can be. */
export type SurfaceProfile = 'field' | 'notes';

/** Every profile Sheaf serves. `document` is the one the editor extension runs. */
export type ConstructProfile = SurfaceProfile | 'document';

/**
 * Every profile, in the order they widen.
 *
 * Exported because the checks over the render path need a population rather than a literal, and a
 * list copied into each of them is a list that goes stale one profile at a time. `field` was absent
 * from both render checks for exactly that reason: each carried its own `['notes', 'document']`,
 * and neither mentioned the omission, so the profile whose rendering changed for 62 of 65 corpus
 * documents was the one nothing read. Adding a profile here reaches them on the next run.
 */
export const PROFILES: readonly ConstructProfile[] = ['field', 'notes', 'document'];

const ALL: readonly ConstructProfile[] = PROFILES;
const NOTES_UP: readonly ConstructProfile[] = ['notes', 'document'];
const DOCUMENT: readonly ConstructProfile[] = ['document'];
const NEVER: readonly ConstructProfile[] = [];

/**
 * Which profiles carry each construct, transcribed from the specification's "What each profile
 * carries" table.
 *
 * It is not derived from what either consumer can draw, because those say what each one *can* do and
 * the question here is what it *owes*. Reading one off the other made an omission look like a
 * decision: a construct with no drawing read as outside every profile, so a gap and a choice were
 * the same answer.
 *
 * Exported mutable so a check can add or remove a row and watch the result move, which is the only
 * way to show the property that matters here: a change to this table is the whole change.
 */
export const PROFILE_TABLE: Record<string, readonly ConstructProfile[]> = {
  Paragraph: ALL,
  Emphasis: ALL,
  StrongEmphasis: ALL,
  EmphasisMark: ALL,
  Strikethrough: ALL,
  StrikethroughMark: ALL,
  Highlight: ALL,
  HighlightMark: ALL,
  InlineCode: ALL,
  CodeMark: ALL,
  Link: ALL,
  LinkMark: ALL,
  URL: ALL,
  Autolink: ALL,
  Entity: ALL,
  Emoji: ALL,
  Escape: ALL,

  HardBreak: NOTES_UP,
  SetextHeading1: NOTES_UP,
  SetextHeading2: NOTES_UP,
  LinkLabel: NOTES_UP,
  LinkReference: NOTES_UP,
  LinkTitle: NOTES_UP,
  HTMLTag: NOTES_UP,
  BulletList: NOTES_UP,
  OrderedList: NOTES_UP,
  ListItem: NOTES_UP,
  ListMark: NOTES_UP,
  Task: NOTES_UP,
  TaskMarker: NOTES_UP,
  Blockquote: NOTES_UP,
  QuoteMark: NOTES_UP,
  ATXHeading1: NOTES_UP,
  ATXHeading2: NOTES_UP,
  ATXHeading3: NOTES_UP,
  ATXHeading4: NOTES_UP,
  ATXHeading5: NOTES_UP,
  ATXHeading6: NOTES_UP,
  HeaderMark: NOTES_UP,
  FencedCode: NOTES_UP,
  CodeBlock: NOTES_UP,
  FootnoteReference: NOTES_UP,
  FootnoteDefinition: NOTES_UP,
  HorizontalRule: NOTES_UP,

  Table: DOCUMENT,
  Image: DOCUMENT,
  Callout: DOCUMENT,
  InlineMath: DOCUMENT,
  InlineMathMark: DOCUMENT,
  /*
   * Display maths, which the specification lists in the `InlineMath` row as "`$$` blocks" and which
   * is a row of its own here because it is a separate construct to everything that reads this table:
   * it is found by reading lines rather than from the tree, it is drawn by a different decoration,
   * and a consumer told that a `$$` block was refused needs a name that is not the inline form's.
   */
  BlockMath: DOCUMENT,

  // Drawn as written in every profile, which is the specification's answer for raw HTML blocks.
  HTMLBlock: NEVER,
};

/** Whether `profile` carries `construct`. A construct with no row is carried by none. */
export function carries(construct: string, profile: ConstructProfile): boolean {
  return PROFILE_TABLE[construct]?.includes(profile) ?? false;
}

/**
 * Every construct `profile` carries, as the set the drawing layer is handed.
 *
 * Built from the table on each call rather than cached, because the table is exported mutable for
 * the checks that add and remove a row, and a cache would make those read as having no effect.
 */
export function carriedBy(profile: ConstructProfile): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [construct, profiles] of Object.entries(PROFILE_TABLE)) {
    if (profiles.includes(profile)) out.add(construct);
  }
  return out;
}
