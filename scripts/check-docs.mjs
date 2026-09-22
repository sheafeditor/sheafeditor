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
    }
  }
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
