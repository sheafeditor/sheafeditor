/*
 * The private terms, checked across everything that ships rather than in docs/ alone.
 *
 *   node scripts/check-no-tracker-ids.mjs
 *
 * `check-docs.mjs` already refuses a list of private terms, read from the file
 * SHEAF_DOCS_PRIVATE_TERMS names, and it reads `docs/` only. That is the narrower half of the
 * rule: this repository is public, so a tracker id or an internal repository name is a
 * reference a reader cannot follow wherever it appears, and a comment in `src/` is read by
 * exactly the same stranger as a page in `docs/`.
 *
 * Two identifiers had shipped in comments, one explaining a Content-Security-Policy choice
 * and one explaining why the widest table sample lives in its own file. Both were found by
 * reading, both were written by people who knew the rule, and both were outside `docs/`,
 * which is the whole of why they survived. The pattern that would have caught them was
 * already written down.
 *
 * The terms live outside the repository on purpose, because a term that is private in itself
 * cannot be listed in a file that ships. That is also why this is a scope change rather than
 * a new mechanism: a second list would drift from the first, and the first is the one with
 * the reasons written beside each entry.
 *
 * With no list to be found this says so and exits 0, the same way `check-docs.mjs` does,
 * because a contributor has no way to obtain the list and a missing list is not a leak. The
 * gates runner is what decides whether a skip is acceptable, and by default it is not.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/*
 * What ships. Anything not named here is not read, so a new shipping directory has to be
 * added; the count printed at the end is what makes a directory that silently stopped being
 * scanned visible, since a walk over nothing otherwise reports a clean pass.
 */
const ROOTS = ['src', 'test', 'sample', 'media', 'scripts', 'docs', '.github'];
const FILES = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'package.json'];
const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.css', '.html', '.yml', '.yaml', '.txt', '.csv', '.tsv', '.svg']);

/*
 * `dist/` and `test/bundle.cjs` are build output: generated from the sources this already
 * reads, not written by anybody, and full of third-party text. Reading them reports hundreds
 * of matches from other people's grammars and none of them is a leak.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude']);
const SKIP_FILES = new Set(['test/bundle.cjs', 'src/webview/emojiTable.ts']);

/**
 * The rules this applies, which is not all of them.
 *
 * A code comment may legitimately name a competitor, because it says where a token or a
 * behaviour came from, and that is engineering rationale rather than how the product
 * describes itself. The rule in the steering governs what a *user* reads. So the competitor
 * rule stays in `check-docs.mjs`, where the reader is a user, and is not applied here.
 *
 * Everything else in the list is private wherever it appears: a tracker id, an internal
 * repository or process name, the tracker itself, an account name, the maintainer's name.
 */
const NOT_HERE = /competitor/i;

/**
 * A copyright notice names its holder, which is the one place the maintainer's name belongs in
 * a file that ships: an MIT licence without a copyright holder is not an MIT licence. So a line
 * carrying a copyright notice is exempt from the name rules and from nothing else.
 *
 * This is the only exemption, and it is a rule rather than an entry in a list: "a copyright line
 * names its holder" will be as true next year as today, where "this particular line is fine"
 * would be the first entry in a list that eventually excuses everything.
 */
const COPYRIGHT = /©|\(c\)\s|copyright/i;

/*
 * Where the list is, found rather than told.
 *
 * `SHEAF_DOCS_PRIVATE_TERMS` still names it and still wins, and it used to be the only way.
 * That made this step depend on whose shell was running it: the variable was set for one
 * kind of session and not in an ordinary terminal, so the same command checked the terms in
 * one place and skipped in the other, and a skipped step fails a gates run. A release was
 * cut on a green run that had never run this, and refused on the same commit minutes later.
 *
 * So the default is a checkout beside this one, looked for by the file's own name rather
 * than by the directory holding it. Naming that directory here would put a private
 * repository's name in a file that ships, which is the rule this very script enforces, and
 * it caught exactly that on the first run of this change.
 *
 * Both the ordinary case and a worktree, which sits three levels further down.
 */
const LIST = 'docs-private-terms.txt';
const beside = (up) => {
  const dir = join(REPO, up);
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .map((name) => join(dir, name, LIST))
    .find((p) => existsSync(p));
};
const listed = process.env.SHEAF_DOCS_PRIVATE_TERMS ?? beside('..') ?? beside(join('..', '..', '..', '..'));
if (!listed) {
  console.log(
    'skipped: no list of private terms. Set SHEAF_DOCS_PRIVATE_TERMS, or keep the private checkout ' +
      'beside this one. A machine without it, such as a runner, has nothing to leak and nothing to check.'
  );
  process.exit(0);
}
if (!existsSync(listed)) {
  console.error(`SHEAF_DOCS_PRIVATE_TERMS names ${listed}, which does not exist.`);
  process.exit(1);
}

const rules = [];
for (const line of readFileSync(listed, 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [pattern, why = 'a private term.'] = line.split('\t');
  if (NOT_HERE.test(why)) continue;
  rules.push({ re: new RegExp(pattern, 'gi'), why });
}
if (!rules.length) {
  console.error(`${listed} holds no rules this check applies, so it is proving nothing.`);
  process.exit(1);
}

function shipping() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (TEXT.has(extname(name)) && !SKIP_FILES.has(relative(REPO, path))) out.push(path);
    }
  };
  for (const root of ROOTS) {
    try {
      walk(join(REPO, root));
    } catch {
      // Reported by the count below rather than thrown, so a renamed root cannot read as a pass.
    }
  }
  for (const f of FILES) out.push(join(REPO, f));
  return out;
}

const found = [];
let scanned = 0;

for (const path of shipping()) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const isCopyright = COPYRIGHT.test(lines[i]);
    for (const { re, why } of rules) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      if (isCopyright && /\bname\b|maintainer|account/i.test(why)) continue;
      // The file and the line, not a count. Both known instances were inside comments, and a
      // reader given only a number greps for the wrong shape and concludes the check is wrong.
      found.push(`${relative(REPO, path)}:${i + 1}: ${JSON.stringify(m[0])} is ${why}`);
    }
  }
}

if (scanned < 200) {
  console.log(`only ${scanned} shipping files read, which is too few: this is looking at the wrong tree rather than passing.`);
  process.exit(1);
}

if (found.length) {
  console.log(`\n${found.length} private term${found.length === 1 ? '' : 's'} in files that ship:`);
  for (const f of found) console.log(`- ${f}`);
  console.log('\nSay the thing itself. An identifier or an internal name belongs in the commit message and on the issue, which reach the people who have them.');
  process.exit(1);
}
console.log(`${scanned} shipping files read against ${rules.length} private terms, nothing private in any of them.`);
