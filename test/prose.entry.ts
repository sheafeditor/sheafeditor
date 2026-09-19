/*
 * Prose editing tests (bundled for the jsdom runner in prose.test.mjs). Each file
 * under prose/ exports its scenarios; `runAll()` returns one result per scenario.
 */

import { Scenario } from './harness';
import { scenarios as highlight } from './prose/highlight';
import { scenarios as commands } from './prose/commands';
import { scenarios as format } from './prose/format';
import { scenarios as find } from './prose/find';
import { scenarios as selection } from './prose/selection';
import { scenarios as blocks } from './prose/blocks';
import { scenarios as contextmenu } from './prose/contextmenu';
import { scenarios as contextmenu2 } from './prose/contextmenu2';
import { scenarios as marks } from './prose/marks';
import { scenarios as turnInto } from './prose/turnInto';
import { scenarios as slash } from './prose/slash';
import { scenarios as slashInBlocks } from './prose/slashInBlocks';
import { scenarios as linkPopoverMoves } from './prose/linkPopoverMoves';
import { scenarios as altArrow } from './prose/altArrow';
import { scenarios as blockModelFixes } from './prose/blockModelFixes';
import { scenarios as keys } from './prose/keys';
import { scenarios as renderInline } from './prose/renderInline';
import { scenarios as lineToggles } from './prose/lineToggles';
import { scenarios as codeLanguages } from './prose/codeLanguages';
import { scenarios as tableGrip } from './prose/tableGrip';
import { scenarios as renderBlocks } from './prose/renderBlocks';
import { scenarios as insertCommands } from './prose/insertCommands';
import { scenarios as blockDrag } from './prose/blockDrag';
import { scenarios as linkOpen } from './prose/linkOpen';
import { scenarios as shortcutsOverlay } from './prose/shortcutsOverlay';
import { scenarios as images } from './prose/images';
import { scenarios as hardBreaks } from './prose/hardBreaks';
import { scenarios as revealBlock } from './prose/revealBlock';

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runAll(): Promise<Result[]> {
  const results: Result[] = [];
  for (const s of [
    ...highlight,
    ...commands,
    ...format,
    ...find,
    ...selection,
    ...blocks,
    ...contextmenu,
    ...contextmenu2,
    ...marks,
    ...turnInto,
    ...slash,
    ...slashInBlocks,
    ...linkPopoverMoves,
    ...altArrow,
    ...blockModelFixes,
    ...keys,
    ...renderInline,
    ...lineToggles,
    ...codeLanguages,
    ...tableGrip,
    ...renderBlocks,
    ...insertCommands,
    ...blockDrag,
    ...linkOpen,
    ...shortcutsOverlay,
    ...images,
    ...hardBreaks,
    ...revealBlock,
  ] as Scenario[]) {
    try {
      const ok = await s.run();
      results.push({ name: s.name, ok, detail: ok ? '' : 'assertion failed' });
    } catch (e) {
      results.push({ name: s.name, ok: false, detail: 'threw: ' + (e as Error).message });
    }
  }
  return results;
}
