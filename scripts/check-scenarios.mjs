/*
 * Checks that every scenario id is used once.
 *
 *   node scripts/check-scenarios.mjs
 *
 * A scenario is named `<feature>.<id>`, and the id is how a person asks for one:
 * `npm run test:editor front-matter render.front-matter.e05`. The runner loads one
 * area at a time, so two areas can hold the same id and nothing complains. What
 * happens then is that a request runs whichever area was named, a result is
 * recorded against the wrong scenario, and the quality notes for the feature list
 * one id twice without either row being wrong on its own.
 *
 * The editor areas are imported rather than read. Importing one opens no window: an area
 * file only defines scenario objects, and `session()` is called by the runner. Reading the
 * text instead misses every id that is not written as a literal `id:` property, and about a
 * tenth of them are not: `menuCase('tables.align.e07', ...)`, `undoCase(...)`, `fileCase(...)`
 * and the loop-built ones in `pointer.mjs`, `host.mjs` and `table-style.mjs`. A text scan reads
 * 1,488 ids where an import reads 1,614, so 126 of them can clash with anything and pass.
 *
 * The unit areas are TypeScript, so they are read rather than imported; none of their ids is
 * built, and a built one there is reported instead of being passed over.
 *
 * ## Ids a draft outside this repository has already claimed
 *
 * Scenarios are also written outside this checkout, and an id chosen here that one of
 * them already uses is a clash this repository cannot see: both files are valid, both
 * runs pass, and the damage lands later, when a result recorded against that id could
 * have come from either. Point `SHEAF_SCENARIO_STAGING` at such a directory, laid out
 * as this repository's `test/real-editor/`, and its ids are read too.
 *
 * Those ids are **warnings and never a failure**, which is the whole shape of it. At the
 * moment this runs, a draft is a draft: it is not in this repository, it may never be,
 * and failing here would stop a landing on somebody else's unfinished file. A warning
 * costs the person choosing the next id nothing and tells them what they need.
 *
 * A comparison on the id alone would be noise, because most ids exist in both places as
 * one scenario in two copies. So id and name are compared together: the same name is the
 * same scenario and says nothing, and a different name under one id is the collision.
 *
 * The path stays out of this file because this file ships publicly, which is the same
 * reason `check-docs.mjs` reads its private terms through an environment variable. With
 * the variable unset, or naming a directory that is not there, nothing is said and
 * nothing fails: a draft tree that is absent is not a fault in this repository.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const EDITOR = join(REPO, 'test', 'real-editor', 'editor');
const UNIT = join(REPO, 'test', 'real-editor', 'unit');

const seen = new Map();
const named = new Map();
const note = (id, where, name) => {
  if (!seen.has(id)) seen.set(id, []);
  seen.get(id).push(where);
  if (name && !named.has(id)) named.set(id, name);
};

/** The scenarios an editor area defines, by importing it, or a reason it could not be read. */
async function areaScenarios(file) {
  try {
    const { scenarios } = await import(file);
    return Array.isArray(scenarios) ? { scenarios } : { why: 'exports no scenarios array' };
  } catch (e) {
    return { why: `could not be imported: ${e.message}` };
  }
}

/**
 * The `id:` and `name:` of every scenario in a TypeScript unit area, read as text.
 * `name` sits two lines below `id` in every one of them, so a short look ahead finds
 * it; a scenario whose name this cannot read is reported with its id alone rather
 * than being passed over.
 */
function unitScenarios(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const m = /^\s*id:\s*'([^']+)'/.exec(line);
    if (m) {
      const ahead = lines.slice(i + 1, i + 5).join('\n');
      const n = /^\s*name:\s*(['"])((?:\\.|(?!\1).)*)\1/m.exec(ahead);
      out.push({ id: m[1], name: n ? n[2] : null, line: i + 1 });
    } else if (/^\s*id:\s*`/.test(line)) {
      out.push({ built: true, line: i + 1 });
    }
  });
  return out;
}

/*
 * Every window area and how many scenarios it holds, kept so the distribution can be printed
 * rather than typed somewhere and read later.
 *
 * `CLAUDE.md` justifies running only the affected areas per landing on the shape of this
 * distribution, and those numbers have drifted twice from being written by hand: once by about
 * 4% and again by about 6%. This check already imports every area, so it is the one place that
 * knows the answer on every landing.
 */
const perArea = [];

for (const name of readdirSync(EDITOR).sort()) {
  if (!name.endsWith('.mjs')) continue;
  const file = join(EDITOR, name);
  const { scenarios, why } = await areaScenarios(file);
  if (!scenarios) {
    process.stderr.write(`${relative(REPO, file)} ${why}\n`);
    process.exitCode = 1;
    continue;
  }
  perArea.push([name.replace(/\.mjs$/, ''), scenarios.length]);
  scenarios.forEach((sc, i) => note(sc.id, `${relative(REPO, file)}[${i}]`, sc.name));
}

for (const name of readdirSync(UNIT).sort()) {
  if (!name.endsWith('.ts')) continue;
  const file = join(UNIT, name);
  for (const sc of unitScenarios(readFileSync(file, 'utf8'))) {
    if (sc.built) {
      process.stderr.write(`${relative(REPO, file)}:${sc.line} builds its id, which this check cannot read\n`);
      process.exitCode = 1;
      continue;
    }
    note(sc.id, `${relative(REPO, file)}:${sc.line}`, sc.name);
  }
}

await reportStaging();

/**
 * What a draft tree outside this repository already claims. Warnings only: see the top
 * of this file for why a draft may never fail a landing here.
 */
async function reportStaging() {
  const given = process.env.SHEAF_SCENARIO_STAGING;
  if (!given) return;
  // Either the mirror of `test/real-editor/` or the tree holding it.
  const root = [join(given, 'test', 'real-editor'), given].find((p) => existsSync(join(p, 'editor')) || existsSync(join(p, 'unit')));
  if (!root) return;

  const found = [];
  for (const [dir, ext] of [
    [join(root, 'editor'), '.mjs'],
    [join(root, 'unit'), '.ts'],
  ]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(ext)) continue;
      const file = join(dir, name);
      if (ext === '.ts') {
        for (const sc of unitScenarios(readFileSync(file, 'utf8'))) if (!sc.built) found.push({ ...sc, where: `${name}:${sc.line}` });
        continue;
      }
      const { scenarios, why } = await areaScenarios(file);
      // A draft that does not load is the draft's own business, and saying so is the
      // whole of what this does about it.
      if (!scenarios) {
        found.push({ unreadable: `${name} ${why}` });
        continue;
      }
      scenarios.forEach((sc, i) => found.push({ id: sc.id, name: sc.name, where: `${name}[${i}]` }));
    }
  }

  const rival = [];
  const onlyThere = [];
  const unreadable = [];
  // Two scenarios under one id inside the draft tree itself. Cheaper to see than a
  // clash across the trees and it catches the same mistake earlier: an id list read
  // through a `tail` is not an id list, and a draft numbered from a truncated one held
  // two scenarios per id. The runner matched the first and reported it passing, so the
  // row named an id whose scenario had not run.
  const twice = new Map();
  for (const sc of found) if (!sc.unreadable) twice.set(sc.id, [...(twice.get(sc.id) ?? []), sc]);
  const doubled = [...twice].filter(([, list]) => list.length > 1);

  for (const sc of found) {
    if (sc.unreadable) {
      unreadable.push(sc.unreadable);
    } else if (!seen.has(sc.id)) {
      onlyThere.push(`${sc.id} (${sc.where}): ${sc.name ?? 'name not read'}`);
    } else if (sc.name && named.has(sc.id) && sc.name !== named.get(sc.id)) {
      rival.push(`${sc.id}\n    here  ${named.get(sc.id)}\n    there ${sc.name} (${sc.where})`);
    }
  }

  const say = (label, list) => {
    if (!list.length) return;
    process.stdout.write(`\n${list.length} ${label}\n`);
    for (const line of list) process.stdout.write(`  ${line}\n`);
  };
  say(
    'scenario ids used twice inside the draft tree itself, so a run reports whichever matched first and the other never ran:',
    doubled.map(([id, list]) => `${id}\n${list.map((sc) => `    ${sc.where}  ${sc.name ?? 'name not read'}`).join('\n')}`)
  );
  say('scenario ids a draft outside this repository holds under a different name, so a result recorded against one could have come from either:', rival);
  say('scenario ids only a draft outside this repository holds, so choosing one of them here would collide:', onlyThere);
  say('draft files outside this repository this check could not read, whose ids it therefore did not compare:', unreadable);
  if (rival.length || onlyThere.length || unreadable.length || doubled.length) {
    process.stdout.write(`\nWarnings, not failures: a draft is not in this repository and may never be.\n`);
  }
}

const clashes = [...seen].filter(([, where]) => where.length > 1);
if (clashes.length) {
  for (const [id, where] of clashes) {
    process.stderr.write(`${id} is used ${where.length} times:\n`);
    for (const w of where) process.stderr.write(`  ${w}\n`);
  }
  process.stderr.write(`\n${clashes.length} scenario id${clashes.length === 1 ? '' : 's'} used more than once.\n`);
  process.exit(1);
}
process.stdout.write(`${seen.size} scenario ids, each used once\n`);

/*
 * The window suite's distribution, printed because `CLAUDE.md` reasons from it.
 *
 * The per-area sum and the number of distinct ids are the same figure here, and the clash check
 * above is what makes that true: an id used in two areas exits 1, so a re-export like
 * `reveal-source.mjs` cannot add to the total. Both numbers being one number is worth saying,
 * because "how many scenarios are there" and "how many run if you run every area" look like
 * different questions and are not.
 */
if (perArea.length) {
  const ranked = [...perArea].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((n, [, count]) => n + count, 0);
  const top = ranked.slice(0, 8);
  const held = top.reduce((n, [, count]) => n + count, 0);
  process.stdout.write(
    `\nWindow areas: ${total} scenarios across ${ranked.length} areas, and the per-area sum is the ` +
      `distinct count because no id may be used twice.\n` +
      `  the eight largest hold ${held}: ${top.map(([a, n]) => `${a} ${n}`).join(', ')}\n` +
      `  the other ${ranked.length - 8} hold ${total - held}, ${ranked.filter(([, n]) => n < 8).length} of them under eight each\n` +
      `  CLAUDE.md reasons from these; read them here rather than from that paragraph.\n`
  );
}
