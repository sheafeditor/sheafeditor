#!/usr/bin/env node
/**
 * Downloads the real-world half of the sample corpus: openly licensed Markdown
 * written by other people, pinned to a commit and checked against a SHA-256.
 *
 * The files land in sample/wild/files/, which is git-ignored. This repository
 * never redistributes them; sample/wild/manifest.json records where each one
 * comes from and the licence it is published under.
 *
 *   node scripts/fetch-wild-corpus.mjs          # download anything missing
 *   node scripts/fetch-wild-corpus.mjs --force  # download everything again
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WILD = join(ROOT, 'sample', 'wild');
const OUT = join(WILD, 'files');
const FORCE = process.argv.includes('--force');

const { files } = JSON.parse(readFileSync(join(WILD, 'manifest.json'), 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(OUT, { recursive: true });

let failed = 0;
for (const entry of files) {
  const path = join(OUT, entry.file);
  if (!FORCE && existsSync(path) && sha256(readFileSync(path)) === entry.sha256) {
    console.log(`have      ${entry.file}`);
    continue;
  }
  try {
    const res = await fetch(entry.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(path, buf);
    if (sha256(buf) === entry.sha256) {
      console.log(`fetched   ${entry.file.padEnd(42)} ${String(buf.length).padStart(8)} bytes  ${entry.license}`);
    } else {
      // Only the unpinned sources (Project Gutenberg) can drift. Keep the file
      // and say so, since a changed upstream is still a usable test document.
      console.warn(`changed   ${entry.file}: checksum differs from the manifest (upstream edited it)`);
    }
  } catch (err) {
    console.error(`failed    ${entry.file}: ${err.message}`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} file(s) could not be downloaded`);
  process.exit(1);
}
