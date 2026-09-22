// The reveal-on-double-click scenarios, run with the setting that turns that behaviour on.
//
// `sheaf.doubleClickToEditSource` ships off: a double-click selects a word, as it does
// everywhere else, and Edit Markdown (Cmd+Alt+E) reveals the source instead. The behaviour these
// scenarios describe is still shipped, behind the setting, so they belong in a profile that has it on
// rather than in the default profile, where they fail for saying what the product no longer does.
//
//   node test/real-editor/run-editor.mjs reveal-source [id]
import { revealDoubleClick } from './render.mjs';

export const settings = { 'sheaf.doubleClickToEditSource': true };

export const scenarios = revealDoubleClick;
