#!/usr/bin/env node
/*
 * Regenerates every Sheaf brand asset from the geometry in this file.
 *
 *   npm run gen:icons          write the SVGs, then rasterise the PNGs
 *   npm run gen:icons -- --check   fail if the committed SVGs have drifted
 *
 * Two marks come out of one layout. The full mark carries a drop cap and five
 * lines of body text and is the extension icon, where it is never drawn below
 * about 48px. The small mark keeps the sheets and the initial and drops the
 * body lines, for the site header, the footer and the favicon, where the lines
 * would close into a solid block.
 *
 * The PNGs are rasterised with headless Chrome; set SHEAF_CHROME to override
 * the binary. Rendering the social card also needs network, because it pulls
 * Young Serif and Inter from Google Fonts. Without Chrome the SVGs are still
 * written and the PNG step is skipped with a warning.
 */
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The site lives in its own checkout beside this one. Its icon, touch icon and
// social card are written there when that checkout exists, found through
// SHEAF_SITE_DIR or as ../sheaf-site, and skipped when it does not, so a clone
// of this repository on its own still regenerates the extension's icons.
const SITE = [process.env.SHEAF_SITE_DIR, join(ROOT, '..', 'sheaf-site')].find(
  (dir) => dir && existsSync(join(dir, 'public')),
);
const check = process.argv.includes('--check');

const NAVY = '#2E3757';
const PAPER = '#F4F1E8';
const TILE_RADIUS = 56;

/*
 * Capital S of Young Serif Regular, outlined from
 * https://github.com/google/fonts/raw/main/ofl/youngserif/YoungSerif-Regular.ttf
 * so that no font has to be installed to open the SVG. Coordinates are font
 * units and BOUNDS is [xMin, yMin, xMax, yMax]. Both come from
 * scripts/extract-glyph.py; rerun it if the display face ever changes.
 */
const GLYPH = 'M619 523Q616 522 613 520Q610 519 607 519Q599 519 590 531Q526 611 464 646Q402 681 336 681Q296 681 268 660Q239 639 239 594Q239 557 262 533Q285 509 322 494Q358 478 396 467Q453 451 508 431Q564 411 609 384Q654 356 681 316Q708 277 708 221Q708 153 674 100Q639 47 574 17Q509 -13 417 -13Q372 -13 332 -2Q293 10 256 28Q248 32 241 32Q232 32 232 22Q232 19 234 11Q237 4 237 -1Q237 -12 220 -12H170Q152 -12 145 2L24 229Q20 237 20 241Q20 252 31 258L75 283Q78 285 81 286Q84 287 87 287Q97 287 104 275Q172 172 254 122Q337 72 423 72Q488 72 523 102Q558 131 558 176Q558 220 536 245Q514 270 468 287Q422 304 350 325Q301 339 253 359Q205 379 166 408Q127 436 104 476Q80 515 80 569Q80 635 114 678Q147 721 204 742Q261 762 333 762Q389 762 428 748Q467 734 488 722Q505 712 511 712Q516 712 516 718Q516 723 514 732Q511 741 511 751Q511 766 529 766H565Q583 766 590 749L660 570Q662 566 663 562Q664 559 664 556Q664 547 653 541Z';
const BOUNDS = [20, -13, 708, 766];

/*
 * Each sheet is the same rectangle in US Letter proportion, moved and turned.
 * The offsets are deliberately large: they push each sheet's corners clear of
 * the ones in front so the stack shows up in the outer silhouette, which is all
 * that survives at favicon size or in a blurred thumbnail. Order is back to
 * front, and the front sheet sits nearly square so the mark has a stable base.
 */
const SHEET = { x: 84, y: 71, w: 88, h: 114, r: 3 };
const SHEETS = [
  { angle: -24, dx: -14, dy: -14 },
  { angle: 10, dx: 22, dy: 16 },
  { angle: -4, dx: -6, dy: 6 },
];
const FRONT = SHEETS[SHEETS.length - 1];
/* Half of this is the visible gap between sheets. Stroking before filling keeps
 * it off the outer contour, so only the sheets behind get cut into. */
const GAP = 12;

/* Text block on the front sheet, in sheet coordinates. */
const TEXT = { left: 96, right: 160, capHeight: 34, lineHeight: 8 };

const place = (capHeight, left, top) => {
  const [xMin, yMin, xMax, yMax] = BOUNDS;
  const scale = capHeight / (yMax - yMin);
  return {
    scale,
    width: (xMax - xMin) * scale,
    tx: left - scale * xMin,
    ty: top + scale * yMax,
  };
};

const glyph = (p) =>
  `        <path transform="translate(${p.tx.toFixed(3)} ${p.ty.toFixed(3)}) ` +
  `scale(${p.scale.toFixed(6)} -${p.scale.toFixed(6)})" d="${GLYPH}"/>`;

const bar = (x, y, w) =>
  `        <rect x="${x}" y="${y}" width="${w}" height="${TEXT.lineHeight}" rx="${TEXT.lineHeight / 2}"/>`;

/* Each sheet is stroked before it is filled. The stroke cuts the gap into the
 * sheets already drawn, and the fill then restores this sheet to its true edge,
 * so the outer contour of the mark is never eroded. */
const sheets = () =>
  SHEETS.flatMap((s) => {
    const box =
      `x="${SHEET.x}" y="${SHEET.y}" width="${SHEET.w}" height="${SHEET.h}" rx="${SHEET.r}" ` +
      `transform="translate(${s.dx} ${s.dy}) rotate(${s.angle} 128 128)"`;
    return [`        <rect ${box} fill="none"/>`, `        <rect ${box} fill="#fff" stroke="none"/>`];
  }).join('\n');

const svg = (maskId, inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="Sheaf">
  <mask id="${maskId}">
    <rect width="256" height="256" fill="#000"/>
    <g transform="translate(128 128) scale(1.04) translate(-128 -128) translate(1.1 2.1)">
      <g stroke="#000" stroke-width="${GAP}">
${sheets()}
      </g>
      <g transform="translate(${FRONT.dx} ${FRONT.dy}) rotate(${FRONT.angle} 128 128)" fill="#000">
${inner}
      </g>
    </g>
  </mask>
  <rect width="256" height="256" rx="${TILE_RADIUS}" fill="${NAVY}"/>
  <rect width="256" height="256" fill="${PAPER}" mask="url(#${maskId})"/>
</svg>
`;

function fullMark() {
  const cap = place(TEXT.capHeight, TEXT.left, 95);
  /* The wrapped column starts one line-height clear of the initial, so a wider
   * or narrower S rebalances the block instead of colliding with it. */
  const lx = Math.round(TEXT.left + cap.width + 9);
  const lw = TEXT.right - lx;
  const inner = [
    glyph(cap),
    bar(lx, 97, lw),
    bar(lx, 110, lw),
    bar(lx, 123, lw),
    bar(TEXT.left, 139, TEXT.right - TEXT.left),
    bar(TEXT.left, 152, TEXT.right - TEXT.left - 18),
  ].join('\n');
  return svg('sheaf-stack', inner);
}

function smallMark() {
  const capHeight = 54;
  const [xMin, yMin, xMax, yMax] = BOUNDS;
  const width = ((xMax - xMin) * capHeight) / (yMax - yMin);
  const cap = place(capHeight, 128 - width / 2, 128 - capHeight / 2);
  return svg('sheaf-mark', glyph(cap));
}

// Each target is [absolute path, label for messages, contents]. The site's icon
// is included only when its checkout was found, so check mode never reports
// drift on a path that does not exist here.
const TARGETS = [
  [join(ROOT, 'media/icon.svg'), 'media/icon.svg', fullMark()],
  [join(ROOT, 'media/icon-small.svg'), 'media/icon-small.svg', smallMark()],
  ...(SITE ? [[join(SITE, 'public/icon.svg'), 'sheaf-site/public/icon.svg', smallMark()]] : []),
];

if (check) {
  const drifted = TARGETS.filter(
    ([path, , want]) => !existsSync(path) || readFileSync(path, 'utf8') !== want,
  ).map(([, label]) => label);
  if (drifted.length) {
    console.error(`icons out of date: ${drifted.join(', ')}\nrun: npm run gen:icons`);
    process.exit(1);
  }
  console.log('icons: up to date');
  process.exit(0);
}

for (const [path, label, contents] of TARGETS) {
  writeFileSync(path, contents);
  console.log(`wrote ${label}`);
}

/* --- rasterising ------------------------------------------------------- */

const chrome = [
  process.env.SHEAF_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));

if (!chrome) {
  console.warn('\nno Chrome found, skipping PNGs. Set SHEAF_CHROME to its path and rerun.');
  process.exit(0);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const work = mkdtempSync(join(tmpdir(), 'sheaf-icons-'));

// `target` is an absolute path, or empty when the site's checkout is absent, in
// which case the image is skipped rather than rendered into a missing directory.
function shoot(html, target, label, width, height) {
  if (!target) {
    console.log(`skipped ${label}: no sheaf-site checkout beside this one`);
    return;
  }
  const page = join(work, `${label.replace(/\W/g, '_')}.html`);
  writeFileSync(page, html);
  rmSync(target, { force: true });
  const child = spawn(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--disable-crash-reporter',
      `--user-data-dir=${join(work, 'profile')}`,
      '--virtual-time-budget=4000',
      '--default-background-color=00000000',
      '--force-device-scale-factor=1',
      `--screenshot=${target}`,
      `--window-size=${width},${height}`,
      `file://${page}`,
    ],
    { stdio: 'ignore' },
  );
  /* Headless Chrome writes the screenshot well before it exits, and on some
   * machines it does not exit at all, so wait on the file and then kill it. */
  for (let i = 0; i < 40 && !existsSync(target); i++) sleep(500);
  child.kill();
  if (!existsSync(target)) throw new Error(`failed to render ${label}`);
  console.log(`wrote ${label}`);
}

copyFileSync(join(ROOT, 'media/icon-small.svg'), join(work, 'icon-small.svg'));
copyFileSync(join(ROOT, 'media/icon.svg'), join(work, 'icon.svg'));

shoot(
  `<style>html,body{margin:0;background:transparent}img{display:block}</style><img src="${join(work, 'icon.svg')}" width="256" height="256">`,
  join(ROOT, 'media/icon.png'),
  'media/icon.png',
  256,
  256,
);

shoot(
  `<style>html,body{margin:0;background:${NAVY}}img{display:block}</style><img src="${join(work, 'icon-small.svg')}" width="180" height="180">`,
  SITE && join(SITE, 'public/apple-touch-icon.png'),
  'sheaf-site/public/apple-touch-icon.png',
  180,
  180,
);

shoot(
  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Young+Serif&display=swap">
<style>
html,body{margin:0}
body{width:1200px;height:630px;background:#faf8f3;display:flex;flex-direction:column;justify-content:center;padding:0 96px;box-sizing:border-box;overflow:hidden}
.top{display:flex;align-items:center;gap:36px}
.name{font-family:'Young Serif',Georgia,serif;font-weight:400;font-size:118px;color:#14161f;letter-spacing:-.02em;line-height:1}
.tag{font-family:Inter,system-ui,sans-serif;font-weight:400;font-size:46px;color:#454a5c;margin-top:46px;line-height:1.32;max-width:1000px}
.foot{font-family:Inter,system-ui,sans-serif;font-weight:500;font-size:30px;color:#7b8095;margin-top:52px}
</style>
<div class="top"><img src="${join(work, 'icon-small.svg')}" width="176" height="176"><span class="name">Sheaf</span></div>
<div class="tag">Think with agents, write it down together. The specs, READMEs and roadmaps in your repo, as documents you type straight into.</div>
<div class="foot">sheafeditor.com</div>`,
  SITE && join(SITE, 'public/og.png'),
  'sheaf-site/public/og.png',
  1200,
  630,
);

/* Chrome can still be releasing its profile directory as we exit, and a failed
 * cleanup of a temp directory is not worth failing the build over. */
try {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* the OS will reap it */
}
