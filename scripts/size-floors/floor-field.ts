// What a `field` costs today: the cell editor, which is the field profile in everything but name.
//
// `docs/14-editor-as-components.md` says so plainly — "`src/webview/cellEditor.ts` is the field" — so
// this measures the thing that exists rather than an entry somebody would have to design first. The
// budget is 60 KB gzipped, and the question this answers is how far away that is and what the
// distance is made of, which decides whether the profile is a boundary to draw or a rewrite.
import { createCellEditor } from '../../src/webview/cellEditor';
export const floor = { createCellEditor };
