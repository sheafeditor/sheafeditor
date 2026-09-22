#!/usr/bin/env node
/*
 * Prints one version's section of CHANGELOG.md, for use as GitHub Release notes.
 *
 *   node scripts/changelog-notes.mjs 0.1.0 > notes.md
 *
 * The section is everything between the "## [0.1.0]" heading and the next "## "
 * heading, with the heading itself dropped because the release already has a
 * title. Exits non-zero when the version has no section or the section is
 * empty, so a release cannot go out without notes.
 */
import { readFileSync } from 'node:fs';

const version = process.argv[2]?.replace(/^v/, '');
if (!version) {
  console.error('Usage: node scripts/changelog-notes.mjs <version>');
  process.exit(2);
}

const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section.`);
  process.exit(1);
}

let end = lines.findIndex((line, i) => i > start && /^## |^\[[^\]]+\]: /.test(line));
if (end === -1) end = lines.length;

const notes = lines.slice(start + 1, end).join('\n').trim();
if (!notes) {
  console.error(`The "## [${version}]" section of CHANGELOG.md is empty.`);
  process.exit(1);
}

process.stdout.write(notes + '\n');
