#!/usr/bin/env node
/**
 * Writes `src/webview/emojiTable.ts`: every shortcode name github.com draws and
 * the character it stands for.
 *
 * The names come from `gemoji`, the same data GitHub publishes, so a file with
 * `:warning:` in it reads the same in Sheaf as it does there. It is a dev
 * dependency and a build-time input: nothing at runtime imports it, the
 * generated table is what ships, and this script is how the table is refreshed
 * after `gemoji` is upgraded.
 *
 * Output is deterministic — names sorted, one pair per line — so regenerating an
 * unchanged table leaves the working tree alone and an upgrade shows exactly
 * which names moved.
 *
 *   node scripts/gen-emoji.mjs          # write src/webview/emojiTable.ts
 *   node scripts/gen-emoji.mjs --check  # fail if the committed table is stale
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nameToEmoji } from 'gemoji';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'webview', 'emojiTable.ts');
const CHECK = process.argv.includes('--check');

const version = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'gemoji', 'package.json'), 'utf8')).version;

// A name or a character carrying whitespace, a backtick or a `${` would break
// out of the template literal the table is written as, and a name outside the
// parser's own character class could never be matched anyway. Neither has ever
// been true of gemoji; this says so rather than trusting it.
const names = Object.keys(nameToEmoji).sort();
for (const name of names) {
  if (!/^[a-zA-Z0-9_+-]+$/.test(name)) throw new Error(`shortcode name outside the parser's character class: ${JSON.stringify(name)}`);
  if (/[\s`]|\$\{/.test(nameToEmoji[name])) throw new Error(`character for :${name}: cannot be written as text: ${JSON.stringify(nameToEmoji[name])}`);
}

const pairs = names.map((name) => `${name} ${nameToEmoji[name]}`).join('\n');

const next = `/*
 * GENERATED FILE — do not edit. Run \`npm run gen:emoji\` to rewrite it.
 *
 * Every emoji shortcode name github.com draws, and the character it stands for.
 * Generated from gemoji ${version}, which is Copyright (c) 2014 Titus Wormer and
 * published under the MIT licence; see node_modules/gemoji/license for its text.
 *
 * The pairs are one string rather than an object literal because the bundle
 * carries every byte of this file: a name and a space and a character, with no
 * quotes, colons or commas between ${names.length} entries, is about a third smaller.
 * \`emojiFor\` in ./emoji builds the lookup from it once, on first use.
 */

/** \`name character\` per line, names sorted. ${names.length} shortcodes. */
export const EMOJI_PAIRS = \`
${pairs}
\`;
`;

if (CHECK) {
  const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  if (prev !== next) {
    console.error('stale: src/webview/emojiTable.ts — run: npm run gen:emoji');
    process.exit(1);
  }
  console.log(`emoji table is up to date (${names.length} shortcodes, gemoji ${version})`);
} else {
  writeFileSync(OUT, next);
  console.log(`src/webview/emojiTable.ts  ${names.length} shortcodes  ${(next.length / 1024).toFixed(0)} KB  from gemoji ${version}`);
}
