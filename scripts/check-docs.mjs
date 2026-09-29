/*
 * Checks the documentation in docs/ before it ships.
 *
 *   node scripts/check-docs.mjs
 *
 * These pages go out in the public repository and are rendered on the website,
 * so they are read by strangers. Words from somewhere else, such as an issue
 * number or another product's name, end up in a sentence nobody meant to publish.
 * Grepping for that by hand works until the day somebody forgets.
 *
 * Terms that are private in themselves cannot be listed here, because this file
 * ships too. Point SHEAF_DOCS_PRIVATE_TERMS at a file kept outside the repository
 * and they are checked as well: one rule per line, a pattern, a tab, and what to
 * do instead. Blank lines and lines starting with # are skipped. Without it the
 * check says so rather than passing as though it had looked.
 *
 * It also checks the structure the site depends on: frontmatter it reads to
 * build the nav, and relative links between pages. Those fail the site build
 * rather than this one, so catching them here keeps the break in the repository
 * that caused it.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS = join(REPO, 'docs');

/* Each rule is a pattern and what to do instead, because a failure that only
 * says "line 12 matched" sends the reader back here to find out why. */
const FORBIDDEN = [
  [/real-editor/g, 'the test harness. Say what a person gets instead.'],
  [/src\/[\w/]*\.ts\b|media\/webview|src\/webview\/\w/g,
    'a source path. The reader is not looking at the source.'],
  [/github\.com\/sheafeditor/g,
    'the repository. Link to another page of the docs instead; the site adds repository links itself.'],
];

const privateTerms = process.env.SHEAF_DOCS_PRIVATE_TERMS;
if (privateTerms) {
  if (!existsSync(privateTerms)) {
    console.error(`SHEAF_DOCS_PRIVATE_TERMS names ${privateTerms}, which does not exist.`);
    process.exit(1);
  }
  for (const line of readFileSync(privateTerms, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [pattern, why = 'a private term.'] = line.split('\t');
    FORBIDDEN.push([new RegExp(pattern, 'gi'), why]);
  }
}

const REQUIRED_FRONTMATTER = ['title', 'summary', 'order'];

function walk(dir, base = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? posix.join(base, e.name) : e.name;
    if (e.isDirectory()) return walk(join(dir, e.name), rel);
    return e.name.endsWith('.md') ? [rel] : [];
  });
}

if (!existsSync(DOCS)) {
  console.error('docs/ is missing.');
  process.exit(1);
}

const pages = walk(DOCS);
const problems = [];

/* ---- The page template (CONTRIBUTING.md, "Writing a documentation page") ----
 *
 * A reader opens a page in the middle of a task, so every feature page has the
 * same shape: a summary that says what they can do, an opening paragraph to
 * them, and sections named for what they want to do. These are the checks that
 * hold a page to it. */

/** Pages with a shape of their own: the index, the first-day guide and the reference. */
const EXEMPT_FROM_SECTIONS = new Set(['README.md', 'getting-started.md', 'settings.md']);

/** Section headings that are not tasks. `Good to know` is always the last section. */
const REFERENCE_HEADINGS = new Set(['Keys', 'Good to know']);

/*
 * The verbs a summary or a task heading may start with. A heading that starts
 * with a noun names a part of the product; one that starts with a verb names
 * what the reader wants to do. A new page that needs a verb not here adds it,
 * which is the moment to check the heading really is a task.
 */
const VERBS = new Set(`
  add align answer apply bring break build change check choose clear close collapse
  come complete convert copy create cut delete drag draw drop duplicate edit end
  enter fill filter find fix fold follow get give go group hand hide insert jump
  keep know let link make mark move name nest number open paste pick pin put read
  redo reference reorder replace resize reveal run see select send serve set share
  show sort split start stop switch take tell turn type undo unfold use view write
  zoom caption frame format highlight keep leave look pause preview quote rename
  resume save scroll search size spot stack stay step tab tick toggle trace update
  work
`.split(/\s+/).filter(Boolean));

const SUMMARY_MAX_WORDS = 25;
const OPENING_MAX_WORDS = 60;
const PAGE_MAX_WORDS = 1800;

/** The anchor GitHub and the site give a heading: lower case, punctuation gone, spaces as hyphens. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

const firstWord = (s) => (s.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
const words = (s) => s.split(/\s+/).filter(Boolean).length;

/** Each page's headings, by anchor, read outside fenced blocks. */
const anchors = new Map(
  pages.map((rel) => {
    const prose = readFileSync(join(DOCS, rel), 'utf8').replace(/^```[\s\S]*?^```/gm, '');
    return [rel, new Set([...prose.matchAll(/^#{1,6} (.+)$/gm)].map(([, h]) => slug(h)))];
  })
);

function checkTemplate(rel, text, fm) {
  const summary = fm?.[1].match(/^summary:\s*(.*)$/m)?.[1] ?? '';
  const title = fm?.[1].match(/^title:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const body = (fm ? text.slice(fm[0].length) : text).replace(/^```[\s\S]*?^```/gm, '```\n```');
  const sectionRules = rel.startsWith('features/');

  if (sectionRules && !VERBS.has(firstWord(summary))) {
    problems.push(`${rel}: the summary starts with "${summary.split(/\s+/)[0]}". Start it with a verb, what the reader can do: "Edit a table as a grid".`);
  }
  if (words(summary) > SUMMARY_MAX_WORDS) {
    problems.push(`${rel}: the summary is ${words(summary)} words. Keep it to ${SUMMARY_MAX_WORDS}.`);
  }

  const h1 = body.match(/^# (.+)$/m)?.[1]?.trim();
  if (h1 !== title) problems.push(`${rel}: the first heading is "${h1 ?? ''}" and the title is "${title}". Make them the same words.`);

  // The opening: the first block after the page heading, before any section.
  const afterH1 = body.slice(body.indexOf(`# ${h1}`) + (h1 ?? '').length + 2).trimStart();
  const opening = afterH1.split(/\n\s*\n/)[0] ?? '';
  if (!opening || /^(#|[-*+] |\d+\. |\||```|>)/.test(opening)) {
    problems.push(`${rel}: the page opens with ${opening ? 'a heading, list, table or example' : 'nothing'}. Open with a paragraph to the reader.`);
  } else if (sectionRules) {
    if (words(opening) > OPENING_MAX_WORDS) {
      problems.push(`${rel}: the opening paragraph is ${words(opening)} words. Keep it to ${OPENING_MAX_WORDS}; the detail goes in the sections.`);
    }
    if (!/\byou(r)?\b/i.test(opening)) {
      problems.push(`${rel}: the opening paragraph never speaks to the reader. Say what "you" can do with this.`);
    }
  }

  const h2s = [...body.matchAll(/^## (.+)$/gm)].map(([, h]) => h.trim());
  for (const [, h] of body.matchAll(/^#{2,6} (.+)$/gm)) {
    if (/[*_`[\]]/.test(h)) problems.push(`${rel}: the heading "${h}" holds formatting or a link. Headings are plain words, so their anchors stay put.`);
  }
  if (sectionRules && !EXEMPT_FROM_SECTIONS.has(rel)) {
    for (const h of h2s) {
      if (REFERENCE_HEADINGS.has(h)) continue;
      if (!VERBS.has(firstWord(h))) {
        problems.push(`${rel}: the section "${h}" names a thing. Head it with what the reader wants to do, starting with a verb, such as "Resize a column".`);
      }
    }
    const last = h2s.lastIndexOf('Good to know');
    if (last !== -1 && last !== h2s.length - 1) {
      problems.push(`${rel}: "Good to know" is not the last section. Move it to the end.`);
    }
  }

  const total = words(body.replace(/^```[\s\S]*?^```/gm, ''));
  if (total > PAGE_MAX_WORDS) {
    problems.push(`${rel}: the page is ${total} words. A page over ${PAGE_MAX_WORDS} covers more than one job; split it.`);
  }
}

for (const rel of pages) {
  const text = readFileSync(join(DOCS, rel), 'utf8');
  const lines = text.split('\n');

  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) {
    problems.push(`${rel}: no frontmatter. The site reads title, summary and order from it.`);
  } else {
    const keys = [...fm[1].matchAll(/^(\w+):/gm)].map(([, k]) => k);
    for (const need of REQUIRED_FRONTMATTER) {
      if (!keys.includes(need)) problems.push(`${rel}: frontmatter has no "${need}".`);
    }
  }

  /* Frontmatter is exempt from the word rules: a summary may legitimately use a
   * word a rule below would catch in prose, and the site never renders it raw. */
  const bodyStart = fm ? fm[0].split('\n').length - 1 : 0;
  lines.forEach((line, i) => {
    if (i < bodyStart) return;
    for (const [pattern, why] of FORBIDDEN) {
      for (const m of line.matchAll(pattern)) {
        problems.push(`${rel}:${i + 1}: "${m[0]}" is ${why}`);
      }
    }
  });

  /* Links are written as relative .md paths so they work on GitHub and in an
   * editor; the site rewrites them. One that points nowhere breaks both.
   *
   * A fenced block is read as an example rather than as a link, because these
   * pages document Markdown and the link that a page is explaining is the one
   * most likely to be shown in a fence. */
  const prose = text.replace(/^```[\s\S]*?^```/gm, '');
  for (const [, raw] of prose.matchAll(/\]\(([^)\s]+)[^)]*\)/g)) {
    if (/^(https?:|mailto:|#)/.test(raw)) continue; // external, or an anchor on this page
    const target = raw.split('#')[0];
    if (!target) continue;
    if (target.startsWith('/')) {
      problems.push(`${rel}: link to "${raw}" is a site path. Use a relative .md path, ` +
        'so the link works on GitHub too; the site rewrites it.');
      continue;
    }
    if (!target.endsWith('.md')) {
      problems.push(`${rel}: link to "${raw}" is not a .md path.`);
      continue;
    }
    const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
    if (!pages.includes(resolved)) {
      problems.push(`${rel}: link to "${raw}" points at no page.`);
      continue;
    }
    const fragment = raw.split('#')[1];
    if (fragment && !anchors.get(resolved).has(fragment)) {
      problems.push(`${rel}: link to "${raw}" points at a heading ${resolved} does not have.`);
    }
  }
  for (const [, frag] of prose.matchAll(/\]\(#([^)\s]+)\)/g)) {
    if (!anchors.get(rel).has(frag)) problems.push(`${rel}: link to "#${frag}" points at a heading this page does not have.`);
  }

  checkTemplate(rel, text, fm);
}

/* The index lists every feature page, so none is published where nobody can find it. */
const index = readFileSync(join(DOCS, 'README.md'), 'utf8');
for (const rel of pages.filter((p) => p.startsWith('features/'))) {
  if (!index.includes(`](${rel})`)) problems.push(`README.md: the index does not link ${rel}.`);
}

if (problems.length > 0) {
  console.error(`${problems.length} problem(s) in docs/:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nThese pages ship in the public repository and render on the website.');
  process.exit(1);
}

console.log(`docs/ clean: ${pages.length} pages, nothing private, every link resolves.`);
if (!privateTerms) {
  console.log('Private terms not checked: SHEAF_DOCS_PRIVATE_TERMS is not set.');
}
