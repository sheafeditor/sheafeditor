#!/usr/bin/env node
/*
 * Turn `## [Unreleased]` into the version being released, and open a fresh one above it.
 *
 *   node scripts/stamp-changelog.mjs            the version in package.json
 *   node scripts/stamp-changelog.mjs 0.2.0      that version
 *
 * `npm version` runs this through the `version` lifecycle script, so the heading is stamped
 * inside the same commit that bumps the manifest and gets the tag. That matters because three
 * things have to agree at tag time and each is checked by something different: the workflow
 * refuses a tag that does not match the manifest, `changelog-notes.mjs` refuses to build release
 * notes with no section for the tag, and a host check refuses a dated heading with no tag.
 * Doing it by hand means getting all three right in the right order, and getting it wrong is
 * only visible after the tag has been pushed, which is the point of no return.
 *
 * **The lifecycle wiring is unverified and can only be verified by cutting a release.** npm runs
 * the `version` script as part of making the version commit, so `--no-git-tag-version`, which is
 * the only way to try `npm version` without creating a tag, skips it: measured, the manifest
 * bumped and the changelog was untouched. So the flag that makes the test safe is the flag that
 * disables the thing being tested. Running it by hand is fully exercised, which is why the two
 * paths are made not to conflict rather than one being trusted.
 *
 * Before this existed the changelog carried a dated `## [0.3.0]` heading that no tag had ever
 * produced, written ahead of the release it described, with forty entries under it that a reader
 * of `[Unreleased]` could not see. Stamping at `npm version` is what makes writing the heading
 * early unnecessary rather than merely discouraged.
 *
 * It refuses rather than guessing: no `[Unreleased]`, nothing under it, or a section already
 * dated for this version each stop it. A release that silently produced empty notes would be
 * worse than one that did not go out.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PATH = join(REPO, 'CHANGELOG.md');

const version = (process.argv[2] ?? JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`"${version}" does not look like a version.`);
  process.exit(2);
}

const lines = readFileSync(PATH, 'utf8').split('\n');
const at = lines.findIndex((l) => l.startsWith('## [Unreleased]'));
if (at === -1) {
  console.error('CHANGELOG.md has no "## [Unreleased]" heading, so there is nothing to stamp. Add one above the newest version.');
  process.exit(1);
}
/*
 * Already stamped is nothing to do rather than an error, and that distinction matters because
 * this runs from two places. `npm version` fires it through the `version` lifecycle script, and
 * somebody may also have run it by hand first. Failing the second call would fail a release that
 * was being done correctly, which is a worse outcome than stamping being idempotent.
 *
 * The genuinely broken states below still fail: no `[Unreleased]` at all, or one with nothing in
 * it, both of which would put out a release with no notes.
 */
if (lines.some((l) => l.startsWith(`## [${version}]`))) {
  console.log(`CHANGELOG.md already has a "## [${version}]" section, so there is nothing to stamp.`);
  process.exit(0);
}

/* Where this section ends, so "is there anything in it" is a real question rather than a guess. */
let end = lines.findIndex((l, i) => i > at && /^## |^\[[^\]]+\]: /.test(l));
if (end === -1) end = lines.length;
const body = lines
  .slice(at + 1, end)
  .join('\n')
  .trim();
if (!body) {
  console.error('The "## [Unreleased]" section is empty, so this release would have no notes. Write what a person gets, then stamp.');
  process.exit(1);
}

// The date a release is cut, in the format every other heading in the file uses.
const today = new Date().toISOString().slice(0, 10);
lines.splice(at, 1, '## [Unreleased]', '', `## [${version}] - ${today}`);
writeFileSync(PATH, lines.join('\n'));

const entries = body.split('\n').filter((l) => l.startsWith('- ')).length;
console.log(`CHANGELOG.md: [Unreleased] is now [${version}] - ${today}, with ${entries} entries, and a fresh [Unreleased] above it.`);
