#!/usr/bin/env node
/**
 * Generates the bulky half of the sample corpus: documents that are too large
 * to hand-write and too repetitive to be worth reading in a diff.
 *
 * Output is deterministic — the same seed always produces byte-identical files —
 * so regenerating never churns the working tree. Nothing here depends on the
 * extension; it is plain Node with no imports beyond `node:fs`/`node:path`.
 *
 *   node scripts/gen-corpus.mjs          # write sample/stress/, sample/assets/ and sample/edge/bytes/
 *   node scripts/gen-corpus.mjs --check  # fail if the committed files are stale
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'sample', 'stress');
const ASSETS = join(ROOT, 'sample', 'assets');
const CHECK = process.argv.includes('--check');

/* ---------------------------------------------------------------- random -- */

/** Mulberry32 — small, fast, and identical across Node versions. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const make = (seed) => {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const chance = (p) => r() < p;
  const some = (xs, n) => {
    const copy = xs.slice();
    const out = [];
    for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(r() * copy.length), 1)[0]);
    return out;
  };
  return { r, pick, int, chance, some };
};

/* ----------------------------------------------------------------- words -- */

const NOUNS = [
  'pipeline', 'scheduler', 'index', 'cache', 'gateway', 'ledger', 'manifest', 'shard',
  'queue', 'snapshot', 'transcript', 'checkpoint', 'partition', 'registry', 'buffer',
  'digest', 'replica', 'lease', 'quota', 'namespace', 'batch', 'cursor', 'envelope',
];
const ADJS = [
  'durable', 'idle', 'partial', 'stale', 'nested', 'inbound', 'derived', 'ephemeral',
  'canonical', 'contended', 'warm', 'sparse', 'delayed', 'immutable', 'orphaned',
];
const VERBS = [
  'retries', 'compacts', 'flushes', 'resolves', 'drains', 'rebalances', 'validates',
  'expires', 'promotes', 'coalesces', 'replays', 'truncates', 'fans out', 'defers',
];
const CONNECTORS = [
  'which means that', 'so in practice', 'and as a result', 'though in the common case',
  'except when', 'because', 'until', 'unless the operator has asked otherwise, and then',
];

const sentence = (g) => {
  const parts = [
    `The ${g.pick(ADJS)} ${g.pick(NOUNS)} ${g.pick(VERBS)} whenever the ${g.pick(NOUNS)} falls behind`,
    `${g.pick(CONNECTORS)} a ${g.pick(ADJS)} ${g.pick(NOUNS)} can be observed by two readers at once`,
  ];
  let s = parts[0];
  if (g.chance(0.55)) s += `, ${parts[1]}`;
  if (g.chance(0.25)) s += `, and the ${g.pick(ADJS)} ${g.pick(NOUNS)} ${g.pick(VERBS)} in the background`;
  return s + '.';
};

const paragraph = (g, min = 3, max = 7) => {
  const n = g.int(min, max);
  const out = [];
  for (let i = 0; i < n; i++) {
    let s = sentence(g);
    if (i > 0 && g.chance(0.2)) s = s.replace(/^The /, 'A ' + g.pick(ADJS) + ' ');
    out.push(s);
  }
  let text = out.join(' ');
  // Sprinkle inline formatting so the renderer has something to do mid-paragraph.
  if (g.chance(0.5)) text = text.replace(/\b(cache|index|queue|ledger)\b/, '**$1**');
  if (g.chance(0.4)) text = text.replace(/\b(snapshot|manifest|replica)\b/, '`$1`');
  if (g.chance(0.3)) text = text.replace(/\b(gateway|registry)\b/, '[$1](https://example.com/docs/$1)');
  if (g.chance(0.2)) text = text.replace(/\b(stale|partial)\b/, '*$1*');
  return text;
};

const title = (g) =>
  `${g.pick(ADJS)} ${g.pick(NOUNS)} ${g.pick(['behaviour', 'limits', 'lifecycle', 'ordering', 'recovery', 'tuning', 'internals'])}`
    .replace(/\b\w/g, (c) => c.toUpperCase());

/* ------------------------------------------------------------- fragments -- */

const CODE = {
  ts: (g) => `export interface ${g.pick(['Lease', 'Envelope', 'Cursor', 'Digest'])}Options {
  /** Milliseconds before the ${g.pick(NOUNS)} is considered ${g.pick(ADJS)}. */
  timeoutMs: number;
  retries?: number;
}

export async function acquire(opts: ${g.pick(['Lease', 'Envelope', 'Cursor', 'Digest'])}Options) {
  for (let i = 0; i <= (opts.retries ?? ${g.int(1, 5)}); i++) {
    const held = await tryAcquire(opts.timeoutMs);
    if (held) return held;
  }
  throw new Error('could not acquire within ' + opts.timeoutMs + 'ms');
}`,
  py: (g) => `from dataclasses import dataclass

@dataclass(frozen=True)
class ${g.pick(['Shard', 'Partition', 'Batch'])}:
    id: str
    size: int = ${g.int(16, 4096)}

    def split(self, n: int) -> list["${g.pick(['Shard', 'Partition', 'Batch'])}"]:
        step = max(1, self.size // n)
        return [type(self)(f"{self.id}.{i}", step) for i in range(n)]`,
  sh: (g) => `#!/usr/bin/env bash
set -euo pipefail

for shard in $(seq 0 ${g.int(3, 15)}); do
  curl -fsS "https://example.invalid/api/v1/${g.pick(NOUNS)}/$shard" \\
    | jq -r '.items[] | [.id, .state] | @tsv'
done`,
  sql: (g) => `SELECT
  ${g.pick(NOUNS)}_id,
  count(*) AS events,
  max(observed_at) AS last_seen
FROM ${g.pick(NOUNS)}_events
WHERE observed_at >= now() - interval '${g.int(1, 30)} days'
GROUP BY 1
HAVING count(*) > ${g.int(10, 500)}
ORDER BY events DESC;`,
  json: (g) => `{
  "version": ${g.int(1, 4)},
  "${g.pick(NOUNS)}": {
    "enabled": ${g.chance(0.5)},
    "timeoutMs": ${g.int(100, 30000)},
    "tags": [${g.some(ADJS, 3).map((a) => `"${a}"`).join(', ')}]
  }
}`,
  rs: (g) => `pub struct ${g.pick(['Ledger', 'Registry', 'Buffer'])} {
    entries: Vec<(u64, String)>,
}

impl ${g.pick(['Ledger', 'Registry', 'Buffer'])} {
    pub fn append(&mut self, key: u64, value: impl Into<String>) -> usize {
        self.entries.push((key, value.into()));
        self.entries.len()
    }
}`,
  diff: () => `@@ -12,7 +12,7 @@ function commit(batch) {
-  await store.write(batch, { fsync: false });
+  await store.write(batch, { fsync: true });
   metrics.increment('commit.count');`,
};

const codeBlock = (g) => {
  const lang = g.pick(Object.keys(CODE));
  return '```' + lang + '\n' + CODE[lang](g) + '\n```';
};

const list = (g, ordered = false, depth = 0) => {
  const lines = [];
  const n = g.int(3, 6);
  for (let i = 0; i < n; i++) {
    const pad = '  '.repeat(depth);
    const mark = ordered ? `${i + 1}.` : '-';
    lines.push(`${pad}${mark} ${sentence(g).replace(/\.$/, '')}`);
    if (depth < 2 && g.chance(0.3)) lines.push(list(g, g.chance(0.4), depth + 1));
  }
  return lines.join('\n');
};

const taskList = (g) => {
  const lines = [];
  for (let i = 0; i < g.int(3, 7); i++) {
    lines.push(`- [${g.chance(0.45) ? 'x' : ' '}] ${sentence(g).replace(/\.$/, '')}`);
  }
  return lines.join('\n');
};

const quote = (g) => {
  const body = paragraph(g, 1, 3);
  return g.chance(0.3)
    ? `> ${body}\n>\n> — ${g.pick(['Operations handbook', 'Design review notes', 'Postmortem 2043-11-02', 'RFC 0148'])}`
    : `> ${body}`;
};

const smallTable = (g) => {
  const cols = g.int(3, 6);
  const headers = g.some(NOUNS, cols).map((n) => n[0].toUpperCase() + n.slice(1));
  const aligns = headers.map(() => g.pick([':---', '---:', ':---:', '---']));
  const rows = [];
  for (let i = 0; i < g.int(3, 9); i++) {
    rows.push(headers.map((_, c) => (c === 0 ? `${g.pick(ADJS)}-${g.int(100, 999)}` : String(g.int(0, 9999)))));
  }
  return [
    `| ${headers.join(' | ')} |`,
    `| ${aligns.join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
};

/* ------------------------------------------------------- long-document -- */

function longDocument(seed, { sections, name, blurb }) {
  const g = make(seed);
  const out = [];
  out.push('---');
  out.push(`title: ${name}`);
  out.push('status: sample');
  out.push('tags: [stress, generated]');
  out.push('generator: scripts/gen-corpus.mjs');
  out.push('---');
  out.push('');
  out.push(`# ${name}`);
  out.push('');
  out.push(blurb);
  out.push('');
  out.push('> Generated by `scripts/gen-corpus.mjs`. The prose is nonsense on purpose — what matters is the shape and volume of the constructs, not the meaning.');
  out.push('');

  // Table of contents with anchors, so link rendering gets exercised too.
  // Unique headings keep the anchors in the contents list unambiguous.
  const heads = [];
  const seen = new Set();
  while (heads.length < sections) {
    const h = title(g);
    if (seen.has(h)) continue;
    seen.add(h);
    heads.push(h);
  }
  out.push('## Contents');
  out.push('');
  heads.forEach((h, i) => {
    out.push(`${i + 1}. [${h}](#${h.toLowerCase().replace(/[^a-z0-9]+/g, '-')})`);
  });
  out.push('');
  out.push('---');
  out.push('');

  heads.forEach((h, i) => {
    out.push(`## ${h}`);
    out.push('');
    out.push(paragraph(g, 4, 8));
    out.push('');

    const blocks = g.int(3, 7);
    for (let b = 0; b < blocks; b++) {
      const kind = g.pick([
        'para', 'para', 'para', 'sub', 'list', 'code', 'quote', 'table', 'tasks', 'rule',
      ]);
      switch (kind) {
        case 'para':
          out.push(paragraph(g));
          break;
        case 'sub':
          out.push(`### ${title(g)}`);
          out.push('');
          out.push(paragraph(g));
          if (g.chance(0.4)) {
            out.push('');
            out.push(`#### ${title(g)}`);
            out.push('');
            out.push(paragraph(g, 2, 4));
          }
          break;
        case 'list':
          out.push(list(g, g.chance(0.4)));
          break;
        case 'code':
          out.push(codeBlock(g));
          break;
        case 'quote':
          out.push(quote(g));
          break;
        case 'table':
          out.push(smallTable(g));
          break;
        case 'tasks':
          out.push(taskList(g));
          break;
        case 'rule':
          out.push('---');
          break;
      }
      out.push('');
    }
    if (i < heads.length - 1) {
      out.push('---');
      out.push('');
    }
  });

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/* ----------------------------------------------------------- big tables -- */

const REGIONS = ['North', 'South', 'East', 'West', 'Central', 'Offshore'];
const STATES = ['queued', 'running', 'blocked', 'done', 'failed', 'skipped'];
const OWNERS = ['platform', 'ingest', 'search', 'billing', 'growth', 'infra', 'docs'];

function bigPipeTable(seed, rows) {
  const g = make(seed);
  const headers = ['#', 'Job ID', 'Name', 'Owner', 'Region', 'State', 'Attempts', 'Duration (s)', 'Rows in', 'Rows out', 'Cost', 'Updated'];
  const aligns = ['---:', ':---', ':---', ':---', ':---', ':---', '---:', '---:', '---:', '---:', '---:', ':---'];
  const lines = [`| ${headers.join(' | ')} |`, `| ${aligns.join(' | ')} |`];
  for (let i = 1; i <= rows; i++) {
    const rin = g.int(0, 5_000_000);
    lines.push('| ' + [
      i,
      `job-${String(g.int(0, 999999)).padStart(6, '0')}`,
      `${g.pick(ADJS)}-${g.pick(NOUNS)}-${g.int(1, 40)}`,
      g.pick(OWNERS),
      g.pick(REGIONS),
      g.pick(STATES),
      g.int(1, 9),
      (g.r() * 3600).toFixed(1),
      rin.toLocaleString('en-US'),
      Math.floor(rin * g.r()).toLocaleString('en-US'),
      '$' + (g.r() * 400).toFixed(2),
      `2044-${String(g.int(1, 12)).padStart(2, '0')}-${String(g.int(1, 28)).padStart(2, '0')}`,
    ].join(' | ') + ' |');
  }
  return lines.join('\n');
}

function wideTable(seed, cols, rows) {
  const g = make(seed);
  const headers = ['Metric', ...Array.from({ length: cols - 1 }, (_, i) => `W${String(i + 1).padStart(2, '0')}`)];
  const aligns = headers.map((_, i) => (i === 0 ? ':---' : '---:'));
  const lines = [`| ${headers.join(' | ')} |`, `| ${aligns.join(' | ')} |`];
  for (let r = 0; r < rows; r++) {
    const label = `${g.pick(ADJS)} ${g.pick(NOUNS)}`;
    const cells = Array.from({ length: cols - 1 }, () => (g.r() * 100).toFixed(2));
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function largeTableDoc(seed) {
  const g = make(seed);
  const out = [];
  out.push('# Large Tables');
  out.push('');
  out.push('Table rendering under load. Three shapes that fail in different ways: many rows, many columns, and cells whose content is wider than the column.');
  out.push('');
  out.push('Scrolling should stay smooth, the header row should keep its alignment against the body, and clicking any cell should start editing that cell and no other.');
  out.push('');
  out.push('## Tall — 800 rows × 12 columns');
  out.push('');
  out.push('The common “export from a job runner” shape. Mixed alignment: numeric columns right, identifiers left.');
  out.push('');
  out.push(bigPipeTable(seed + 1, 800));
  out.push('');
  out.push('## Wide — 40 columns');
  out.push('');
  out.push('A weekly metric sheet. Wider than any editor pane, so horizontal scrolling and sticky first columns matter here.');
  out.push('');
  out.push(wideTable(seed + 2, 40, 30));
  out.push('');
  out.push('## Ragged content widths');
  out.push('');
  out.push('Cells that disagree wildly about how much room they need, plus inline markup inside cells.');
  out.push('');
  const head = ['Key', 'Short', 'Long prose', 'Markup', 'Numbers'];
  const rows = [`| ${head.join(' | ')} |`, '| :--- | :---: | :--- | :--- | ---: |'];
  for (let i = 0; i < 40; i++) {
    rows.push('| ' + [
      `k-${i}`,
      g.pick(['ok', 'no', '—', 'n/a', '✓']),
      paragraph(g, 1, i % 7 === 0 ? 4 : 1).replace(/\|/g, '\\|'),
      g.pick(['**bold**', '`code()`', '[link](https://example.com)', '*em* and ~~strike~~', 'a \\| literal pipe']),
      g.int(0, 10 ** (1 + (i % 8))).toLocaleString('en-US'),
    ].join(' | ') + ' |');
  }
  out.push(rows.join('\n'));
  out.push('');
  out.push('## Many small tables in a row');
  out.push('');
  out.push('Twenty tables back to back, to catch per-table setup costs that only show up in aggregate.');
  out.push('');
  for (let i = 0; i < 20; i++) {
    out.push(`### Table ${i + 1}`);
    out.push('');
    out.push(smallTable(g));
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

/* ------------------------------------------------------------ data docs -- */

function csvDoc(seed) {
  const g = make(seed);
  const out = [];
  out.push('# Fenced Data Blocks');
  out.push('');
  out.push('Structured data that genuinely belongs *in* the document, in Markdown\'s own escape hatch. Other tools render these as code blocks; Sheaf renders them as editable grids.');
  out.push('');
  out.push('## A 2,000-row CSV block');
  out.push('');
  out.push('```csv');
  out.push('id,timestamp,region,owner,state,attempts,duration_s,rows_in,rows_out,cost_usd');
  for (let i = 1; i <= 2000; i++) {
    const rin = g.int(0, 2_000_000);
    out.push([
      i,
      `2044-0${g.int(1, 9)}-${String(g.int(1, 28)).padStart(2, '0')}T${String(g.int(0, 23)).padStart(2, '0')}:${String(g.int(0, 59)).padStart(2, '0')}:00Z`,
      g.pick(REGIONS),
      g.pick(OWNERS),
      g.pick(STATES),
      g.int(1, 9),
      (g.r() * 1800).toFixed(2),
      rin,
      Math.floor(rin * g.r()),
      (g.r() * 120).toFixed(4),
    ].join(','));
  }
  out.push('```');
  out.push('');
  out.push('## Quoting edge cases');
  out.push('');
  out.push('Commas inside quotes, escaped quotes, empty fields, and a field holding a newline.');
  out.push('');
  out.push('```csv');
  out.push('name,note,qty');
  out.push('plain,no quoting needed,1');
  out.push('"comma, inside",still one field,2');
  out.push('"quote "" inside",doubled quote escapes it,3');
  out.push('empty next,,4');
  out.push('"multi');
  out.push('line",a field containing a newline,5');
  out.push('trailing spaces ,  leading spaces,6');
  out.push('```');
  out.push('');
  out.push('## A TSV block');
  out.push('');
  out.push('Same grid, tab-delimited — the format you get from pasting out of a spreadsheet.');
  out.push('');
  out.push('```tsv');
  out.push(['sku', 'description', 'warehouse', 'on_hand', 'reserved', 'reorder_at'].join('\t'));
  for (let i = 0; i < 300; i++) {
    out.push([
      `SKU-${String(g.int(1000, 9999))}`,
      `${g.pick(ADJS)} ${g.pick(NOUNS)}`,
      g.pick(REGIONS),
      g.int(0, 5000),
      g.int(0, 400),
      g.int(10, 250),
    ].join('\t'));
  }
  out.push('```');
  out.push('');
  out.push('## A small one, for scale');
  out.push('');
  out.push('```csv');
  out.push('Column 1,Column 2,Column 3');
  out.push('Cell,Cell,Cell');
  out.push('```');
  return out.join('\n').trimEnd() + '\n';
}

function codeHeavyDoc(seed) {
  const g = make(seed);
  const out = [];
  out.push('# Code-Heavy Document');
  out.push('');
  out.push('Two hundred fenced blocks across seven languages, interleaved with prose. Syntax highlighting is lazily loaded per language, so this is where that shows up.');
  out.push('');
  for (let i = 0; i < 200; i++) {
    if (i % 10 === 0) {
      out.push(`## Section ${i / 10 + 1}`);
      out.push('');
    }
    out.push(paragraph(g, 1, 3));
    out.push('');
    out.push(codeBlock(g));
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

function deepNestingDoc(seed) {
  const g = make(seed);
  const out = [];
  out.push('# Deep Nesting');
  out.push('');
  out.push('Structures nested past the point of good taste. Indent guides, quote rules, and list markers all have to stay aligned.');
  out.push('');
  out.push('## Ten levels of bullets');
  out.push('');
  for (let d = 0; d < 10; d++) out.push(`${'  '.repeat(d)}- Level ${d + 1}: ${sentence(g).replace(/\.$/, '')}`);
  out.push('');
  out.push('## Ordered inside unordered inside ordered');
  out.push('');
  for (let a = 1; a <= 3; a++) {
    out.push(`${a}. Outer ${a}`);
    for (let b = 0; b < 3; b++) {
      out.push(`   - Middle ${b + 1}`);
      for (let c = 1; c <= 3; c++) {
        out.push(`     ${c}. Inner ${c} — ${sentence(g).replace(/\.$/, '')}`);
      }
    }
  }
  out.push('');
  out.push('## Six levels of quote');
  out.push('');
  for (let d = 1; d <= 6; d++) out.push(`${'> '.repeat(d)}Depth ${d}.`);
  out.push('');
  out.push('## Blocks nested inside list items');
  out.push('');
  out.push('1. A step that carries a code block:');
  out.push('');
  out.push('   ```sh');
  out.push('   npm run build -- --watch');
  out.push('   ```');
  out.push('');
  out.push('2. A step that carries a table:');
  out.push('');
  out.push('   | Flag | Default | Meaning |');
  out.push('   | :--- | ---: | :--- |');
  out.push('   | `--watch` | off | rebuild on change |');
  out.push('   | `--minify` | on | shrink the bundle |');
  out.push('');
  out.push('3. A step that carries a quote and a nested list:');
  out.push('');
  out.push('   > Do not skip this one.');
  out.push('');
  out.push('   - first');
  out.push('     - second');
  out.push('       - third');
  out.push('');
  out.push('4. A step that carries a paragraph and then continues:');
  out.push('');
  out.push(`   ${paragraph(g, 2, 4)}`);
  out.push('');
  out.push('   And a second paragraph inside the same item.');
  return out.join('\n').trimEnd() + '\n';
}

/* ---------------------------------------------------------------- images -- */

/**
 * Minimal truecolour PNG encoder — enough to produce the placeholder images the
 * corpus links to, without adding a dependency or committing artwork nobody can
 * regenerate. `shade(x, y, w, h)` returns `[r, g, b]`.
 */
function png(width, height, shade) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let i = 0;
  for (let y = 0; y < height; y++) {
    raw[i++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = shade(x, y, width, height);
      raw[i++] = r & 255;
      raw[i++] = g & 255;
      raw[i++] = b & 255;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));

const IMAGES = {
  // A terminal at dawn: gradient sky over a dark waterline, with a hull on it.
  'terminal-dawn.png': () =>
    png(640, 360, (x, y, w, h) => {
      const t = y / h;
      let rgb =
        t < 0.62
          ? [40 + 200 * (1 - t) ** 2, 50 + 110 * (1 - t) ** 1.5, 90 + 90 * t]
          : [18, 26, 40];
      const hull = t > 0.62 && t < 0.74 && x / w > 0.18 && x / w < 0.52;
      const mast = t > 0.5 && t < 0.63 && x / w > 0.3 && x / w < 0.34;
      if (hull || mast) rgb = [12, 16, 24];
      return rgb.map(clamp);
    }),

  // A loaf on a board, for the recipe.
  'rye-loaf.png': () =>
    png(560, 320, (x, y, w, h) => {
      const dx = (x - w * 0.5) / (w * 0.34);
      const dy = (y - h * 0.55) / (h * 0.3);
      const d = dx * dx + dy * dy;
      if (d < 1) {
        const s = 30 * (1 - d);
        return [92 + s, 56 + s / 2, 34 + s / 3].map(clamp);
      }
      return y > h * 0.8 ? [196, 176, 148] : [232, 226, 214];
    }),

  // A stand-in screenshot: dark terminal with rows of "text".
  'watch-view.png': () =>
    png(640, 260, (x, y) => {
      const row = Math.floor(y / 18);
      const inRow = y % 18 > 4 && y % 18 < 13;
      const width = ((row * 67) % 260) + 180;
      if (row >= 1 && row <= 12 && inRow && x > 24 && x < 24 + width) {
        return row === 1 ? [206, 214, 224] : [128, 148, 170];
      }
      return [22, 26, 34];
    }),

  // A stand-in screenshot: light editor pane with one highlighted line.
  'conflict-inline.png': () =>
    png(620, 240, (x, y) => {
      const flagged = y > 118 && y < 132;
      const row = Math.floor(y / 20);
      const width = ((row * 53) % 300) + 140;
      if (flagged && !(x > 40 && x < 40 + width)) return [250, 226, 226];
      if (row >= 1 && row <= 11 && x > 40 && x < 40 + width && y % 20 > 5 && y % 20 < 15) {
        return flagged ? [200, 60, 60] : [110, 120, 132];
      }
      if (flagged) return [250, 226, 226];
      return x < 34 ? [240, 240, 244] : [252, 252, 253];
    }),

  // 16x16, for inline-image and image-in-table cases.
  'dot.png': () =>
    png(16, 16, (x, y) =>
      (x - 8) ** 2 + (y - 8) ** 2 < 49 ? [70, 120, 200] : [245, 245, 245]
    ),

  // Deliberately wider than any editor pane.
  'wide-diagram.png': () =>
    png(1600, 200, (x, y, w, h) => {
      if (y < 6 || y > h - 6) return [238, 238, 240];
      const bands = [
        [64, 96, 160], [72, 128, 168], [80, 152, 152], [96, 168, 120],
        [140, 172, 96], [180, 160, 88], [196, 124, 84], [176, 96, 120],
      ];
      return bands[Math.min(Math.floor((x / w) * 8), 7)];
    }),

  // Taller than the pane, for vertical-overflow handling.
  'tall-chart.png': () =>
    png(320, 900, (x, y, w, h) => {
      const step = Math.floor((y / h) * 18);
      const bar = 30 + ((step * 37) % 240);
      if (x > 20 && x < 20 + bar && y % 50 > 8 && y % 50 < 42) return [96, 132, 196];
      return [248, 248, 250];
    }),
};

/* ------------------------------------------------------------------ run -- */

const FILES = {
  'long-handbook.md': () =>
    longDocument(20440101, {
      sections: 85,
      name: 'Operations Handbook',
      blurb:
        'A long-form document of the kind people actually keep in a repo: eighty-five sections of prose broken up by code, tables, quotes, checklists, and rules. Around three thousand lines. Use it to check scroll performance, decoration recycling, and whether the outline stays usable at length.',
    }),
  'long-narrative.md': () =>
    longDocument(20440202, {
      sections: 18,
      name: 'Migration Log',
      blurb:
        'Fewer sections, denser prose. Where `long-handbook.md` is structural, this one is paragraph after paragraph — the shape that stresses inline decorations rather than block ones.',
    }),
  'large-tables.md': () => largeTableDoc(20440303),
  'data-blocks.md': () => csvDoc(20440404),
  'code-heavy.md': () => codeHeavyDoc(20440505),
  'deep-nesting.md': () => deepNestingDoc(20440606),
};

/* ----------------------------------------------------------------- bytes -- */

// Files whose point is their exact bytes: line endings, BOMs, missing final
// newlines, invalid UTF-8. They are generated so no editor or paste can quietly
// normalise them, and .gitattributes marks sample/edge/bytes/ as binary.

const SMALL_DOC = [
  '# Lease renewal',
  '',
  'Renew a lease before it expires. The *gateway* rejects late renewals.',
  '',
  '- Check the expiry',
  '- Call `renew`',
  '',
  '| Field | Type |',
  '| --- | --- |',
  '| id | string |',
  '| expiry | timestamp |',
  '',
  '```js',
  'await lease.renew();',
  '```',
];

const lf = (lines) => lines.join('\n') + '\n';
const utf8 = (s) => Buffer.from(s, 'utf8');

const BYTES = {
  'empty.md': () => Buffer.alloc(0),
  'newline-only.md': () => utf8('\n'),
  'whitespace-only.md': () => utf8('   \n\t\n  \n'),
  'one-line-no-final-newline.md': () => utf8('# A heading and nothing else'),
  'table-no-final-newline.md': () => utf8(SMALL_DOC.slice(0, 11).join('\n')),
  'crlf.md': () => utf8(SMALL_DOC.join('\r\n') + '\r\n'),
  'mixed-line-endings.md': () =>
    utf8('# Mixed endings\n\nThis line ends LF.\nThis one ends CRLF.\r\nThis one ends with a lone CR.\rAnd back to LF.\n'),
  'bom.md': () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(lf(['---', 'title: BOM before front matter', '---', '', ...SMALL_DOC]))]),
  'control-characters.md': () =>
    utf8(lf(['# Control characters', '', 'A NUL here:   (CommonMark says render it as U+FFFD).', '', 'A form feed: and a DEL: and a vertical tab:.'])),
  'invalid-utf8.md': () =>
    Buffer.concat([utf8('# Invalid UTF-8\n\nA stray continuation byte: '), Buffer.from([0x80]), utf8(', a truncated sequence: '), Buffer.from([0xe2, 0x82]), utf8(', and Latin-1 caf'), Buffer.from([0xe9]), utf8('.\n\nSaving this file must not rewrite the bad bytes as U+FFFD.\n')]),
  'tabs.md': () =>
    utf8(lf(['# Tabs', '', '-\tA list item after a tab', '\t-\tNested with tabs', '', '\tIndented code by one tab', '', '>\tA quote with a tab', '', '| a\t| b\t|', '| ---\t| ---\t|', '| 1\t| 2\t|'])),
  'one-long-line.md': () => {
    const g = make(20440707);
    const words = [];
    while (words.join(' ').length < 200_000) words.push(sentence(g));
    return utf8(lf(['# One long line', '', words.join(' ')]));
  },
};

const BYTES_OUT = join(ROOT, 'sample', 'edge', 'bytes');

mkdirSync(OUT, { recursive: true });
mkdirSync(ASSETS, { recursive: true });
mkdirSync(BYTES_OUT, { recursive: true });

let stale = 0;

for (const [name, build] of Object.entries(IMAGES)) {
  const path = join(ASSETS, name);
  const next = build();
  if (CHECK) {
    const prev = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    if (!prev.equals(next)) {
      console.error(`stale: sample/assets/${name}`);
      stale++;
    }
    continue;
  }
  writeFileSync(path, next);
  console.log(`sample/assets/${name.padEnd(21)} ${String(next.length).padStart(6)} bytes`);
}

for (const [name, build] of Object.entries(FILES)) {
  const path = join(OUT, name);
  const next = build();
  if (CHECK) {
    const prev = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (prev !== next) {
      console.error(`stale: sample/stress/${name}`);
      stale++;
    }
    continue;
  }
  writeFileSync(path, next);
  const lines = next.split('\n').length;
  console.log(`sample/stress/${name.padEnd(20)} ${String(lines).padStart(6)} lines  ${(next.length / 1024).toFixed(0)} KB`);
}

for (const [name, build] of Object.entries(BYTES)) {
  const path = join(BYTES_OUT, name);
  const next = build();
  if (CHECK) {
    const prev = existsSync(path) ? readFileSync(path) : null;
    if (!prev || !prev.equals(next)) {
      console.error(`stale: sample/edge/bytes/${name}`);
      stale++;
    }
    continue;
  }
  writeFileSync(path, next);
  console.log(`sample/edge/bytes/${name.padEnd(29)} ${String(next.length).padStart(6)} bytes`);
}

if (CHECK) {
  if (stale) {
    console.error(`\n${stale} generated file(s) out of date — run: npm run gen:corpus`);
    process.exit(1);
  }
  console.log('generated corpus is up to date');
}
