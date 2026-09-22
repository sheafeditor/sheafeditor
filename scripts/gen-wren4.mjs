#!/usr/bin/env node
/**
 * Generates sample/wren-4/: everything a fictional deep-space navigation beacon
 * knows, kept as the files its crew write and read. It is a themed corpus for demos and screenshots, built
 * from one dataset so every table, chart and prose figure agrees with the rest.
 *
 * It covers the ways charts turn up in Markdown: SVG images (which render
 * everywhere), Mermaid, Vega-Lite and note-app chart blocks (which render only
 * where a tool supports them), text-drawn charts in code fences, and sparklines.
 *
 * Output is deterministic: the same seed always produces the same bytes.
 *
 * SPOILERS BELOW. The corpus hides a story: the station has been in contact
 * with something in the trailing cluster since 2230, and nobody aboard knows.
 * Each clue sits in a different layer of a document, so finding them all
 * means using every way an editor shows or hides content.
 *
 *   0. README.md opens with Bray's note, which says there is a mystery and
 *      points at signals.md. signals.md hands over the cipher and the first
 *      four letters, so the first step takes a minute.
 *   1. signals.md, table data. The "Unexplained narrowband" monthly counts are
 *      letters, A = 1: 6 15 12 12 15 23 20 8 5 3 1 20 = FOLLOWTHECAT.
 *   2. README.md, a visible link. Fresnel's name opens crew/fresnel.md. She
 *      arrived at 02:14 with no ship docked, in the waveguide access port,
 *      chipped with the station's ID. The chip is in a collapsed <details>.
 *   3. log/incident-2244-11-17.md, a hex dump. The reserved hazard bits
 *      (3 to 7) of the last ten frames spell ANYONEHOME, and every CRC is
 *      valid, so it is not radiation damage. The receiver logged the signal
 *      at 02:19 while the beacon was dark, so it is not an echo.
 *      log/2244-11.md has Bray's hint in an HTML comment.
 *   4. runbooks/beacon-silent.md, an HTML comment. The previous chief points
 *      to archive/2231/handover.md, which nothing links to.
 *   5. archive/2231/handover.md, the hidden room. Wynn Achterberg started the
 *      ANYONEHOME message in 2229, got the first reply in 2230, and says they
 *      write on whatever they send.
 *   6. crew/fresnel.svg, fine detail. Zoom into the lens mark on the cat's
 *      chest for the message. The empty row at the end of the handover's
 *      message queue is for the reader's answer.
 *
 * Each stop on that arc also carries one of the content types Sheaf is for, so
 * following the story is a tour of the product rather than a separate demo:
 *
 *   0. README.md            a callout, a table, an image, a document index
 *   1. signals.md           a wide table, and the same counts as a Vega-Lite chart
 *   2. crew/fresnel.md      a collapsed <details>, an image with a caption
 *   3. log/incident-…       a csv sheet, a syntax-highlighted decoder, a hex dump,
 *                           a Mermaid timeline and state diagram
 *   3b. log/2244-11.md      front matter, a task list, an HTML comment
 *   4. runbooks/…           an ordered procedure, a Mermaid flowchart
 *   5. archive/…/handover   front matter, display maths, a task list
 *   6. crew/fresnel.svg     an image that rewards zooming
 *
 * Pictures live in tour/ and are placed in whichever document already talks
 * about that module, never collected on a page of their own. Their sizes,
 * alignments and captions follow from the document: a panorama runs full width,
 * a mast is tall and narrow beside its text, a locker is a small aside pushed
 * to the edge, status lights sit inside table cells. Between them the documents
 * cover every image form Sheaf reads and writes. Two forms are deliberately
 * absent, a data: URL and the collapsed `![name][]` reference, because neither
 * had a document it belonged in and coverage is not worth a nonsense sentence.
 *
 * The rule when adding to the corpus: a content type earns its place by being
 * what a clue is hidden in, or what a person on that station would have written
 * anyway. Nothing is here only to be a sample of itself.
 *
 *   node scripts/gen-wren4.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample', 'wren-4');
const ASSETS = join(OUT, 'charts');
mkdirSync(ASSETS, { recursive: true });

/** Mulberry32, as in gen-corpus.mjs. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(20441117);
const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pad2 = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------------------ data -- */

const DAYS = 30;
const STORM = 17;
const CLASSES = ['Ore hauler', 'Tanker', 'Liner', 'Courier', 'Survey', 'Unidentified'];

const days = [];
for (let d = 1; d <= DAYS; d++) {
  const cme = Math.max(0, 1 - Math.abs(d - STORM) / 3);
  const sw = Math.round(360 + r() * 120 + cme * 560);
  const range = round(Math.max(0.4, 38 - cme * 37 - r() * 9), 1);
  const blackout = range < 5 ? int(4, 11) : range < 12 ? int(1, 4) : 0;
  const eclipse = Math.round(36 + (d / DAYS) * 16);
  const dose = Math.round(11 + r() * 5 + cme * 150);
  const quiet = cme > 0.3;
  const ships = Object.fromEntries(CLASSES.map((c) => [c, quiet ? (c === 'Tanker' ? int(0, 1) : 0) : {
    'Ore hauler': int(2, 9), Tanker: int(1, 4), Liner: d % 7 === 0 ? 0 : 2, Courier: int(0, 2), Survey: r() < 0.15 ? 1 : 0, Unidentified: r() < 0.1 ? 1 : 0,
  }[c]]));
  days.push({ d, sw, range, blackout, eclipse, dose, ships });
}
const NOTES = {
  1: 'New month. Fresnel caught a moth in hydroponics. We do not know how a moth got here.',
  3: 'Supply tender docked: xenon, scrubber cartridges, a crate of real oranges.',
  6: 'Survey drones mapped four new rocks in the trailing cluster.',
  9: 'Antenna feed recalibrated. Bray says gain is up 0.2 dB. It is not.',
  12: 'Inspector Mbeki docked. Signed the log, admired the waveguide brazing.',
  14: 'Flare alert from the forecast office. Storm shelter stocked.',
  16: 'CME arrival forecast for 01:30 tomorrow. Tender cancelled.',
  17: 'Beacon dark 02:14 to 02:41. See incident report.',
  18: 'Solar wind easing. Sensor mast pane crazed by a pebble, sealed.',
  21: 'Replacement mast pane fitted on a spacewalk. Fresnel watched from the cupola.',
  24: 'Survey ship *Tern* parked in our shadow overnight to cool its detectors.',
  27: 'Eclipse season deepens. Heaters on the battery racks for the first time.',
  30: 'Month closed. Noodle night.',
};

const monthly = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => {
  const cycle = Math.cos(((i - 0.5) / 12) * 2 * Math.PI);
  return {
    m,
    sw: Math.round(430 + cycle * 70 + (r() - 0.5) * 30),
    flares: Math.round(14 + cycle * 7 + (r() - 0.5) * 6),
    cmeDays: Math.max(0, Math.round(3 + cycle * 3 + (r() - 0.5) * 2)),
    blackoutDays: Math.max(1, Math.round(5 + cycle * 3 + (r() - 0.5) * 3)),
  };
});
monthly[10].cmeDays = days.filter((x) => x.sw >= 800).length;

// The station orbits the gas giant Vesna c every 11.8 hours; eclipses lengthen through the month.
const PERIOD = 11.8;
const eclipses = [];
for (let k = 0; ; k++) {
  const t = 3.4 + k * PERIOD;
  const d = 1 + Math.floor(t / 24);
  if (d > DAYS) break;
  const h = t % 24;
  const len = days[d - 1].eclipse;
  const endT = h + len / 60;
  eclipses.push({ n: 6100 + k, d, start: `${pad2(Math.floor(h))}:${pad2(Math.floor((h % 1) * 60))}`, end: `${pad2(Math.floor(endT % 24))}:${pad2(Math.floor((endT % 1) * 60))}`, len, soc: 0 });
}
// Battery state of charge every 15 minutes, 14th to 20th. The storm day drains it while the heaters run.
const socHours = [];
const STEP = 0.25;
let soc = 92;
for (let t = 13 * 24; t < 20 * 24; t += STEP) {
  const d = 1 + Math.floor(t / 24);
  const phase = ((t - 3.4) % PERIOD + PERIOD) % PERIOD;
  const dark = phase < days[d - 1].eclipse / 60;
  const load = d === STORM ? 4.6 : 2.2;
  soc = Math.min(98, Math.max(0, soc + STEP * (dark ? -load * 9 : 3.1 - load * 0.6)));
  socHours.push(round(soc, 1));
}
// Charge at eclipse exit: read from the simulation inside its window, estimated outside it.
for (const e of eclipses) {
  const [hh, mm] = e.end.split(':').map(Number);
  const exitT = (e.d - 1) * 24 + hh + mm / 60 + (e.end < e.start ? 24 : 0);
  const i = Math.round((exitT - 13 * 24) / STEP);
  e.soc = i >= 0 && i < socHours.length ? Math.round(socHours[i]) : Math.round(96 - e.len / 3 - r() * 3);
}
const socMin = Math.round(Math.min(...socHours));

const BANDS = [
  ['Hydrogen line, 1420 MHz', 60, 7], ['Hydroxyl, 1612 MHz', 40, 5], ['Hydroxyl, 1667 MHz', 30, 5], ['Methanol, 6.7 GHz', 80, 5],
  ['Water maser, 22 GHz', 120, 6], ['Station harmonics', 45, 0], ['Tender telemetry', 12, 0], ['Ammonia, 23.7 GHz', 35, 6],
  ['Pulsar PSR V-17', 22, 0], ['Jovian-type decametric', 30, 11], ['Moon Vesna c-II beacon', 14, 12], ['Belt radar returns', 18, 11],
  ['Carbon monoxide, 115 GHz', 70, 7], ['Unexplained narrowband', 25, 8], ['Fresnel near a receiver', 6, 8], ['Aurora of Vesna c', 9, 1],
];
const signals = BANDS.map(([name, peak, month]) => ({
  name,
  counts: Array.from({ length: 12 }, (_, i) => {
    if (month === 0) return Math.round(peak * (0.7 + r() * 0.5));
    const dist = Math.min(Math.abs(i + 1 - month), 12 - Math.abs(i + 1 - month));
    const v = peak * Math.exp(-(dist ** 2) / 4.5) * (0.8 + r() * 0.4);
    return v < 1 ? 0 : Math.round(v);
  }),
}));
signals[13].counts = [...'FOLLOWTHECAT'].map((c) => c.charCodeAt(0) - 64);

/* ------------------------------------------------------------------- svg -- */

const PAL = ['#3b7dd8', '#e0803a', '#3aa37a', '#c0508a', '#8a6fd1', '#b8a13a'];
const INK = '#8a8f98';
const svg = (w, h, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="system-ui, sans-serif" font-size="12">\n<title>${title}</title>\n${body}\n</svg>\n`;

function axes({ w, h, m, xs, yMax, yTicks, xLabel, yLabel }) {
  const out = [];
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  for (let i = 0; i <= yTicks; i++) {
    const v = (yMax / yTicks) * i, y = m.t + ph - (v / yMax) * ph;
    out.push(`<line x1="${m.l}" x2="${w - m.r}" y1="${y}" y2="${y}" stroke="${INK}" stroke-opacity="0.25"/>`);
    out.push(`<text x="${m.l - 6}" y="${y + 4}" text-anchor="end" fill="${INK}">${round(v, 1)}</text>`);
  }
  xs.forEach(([x, label]) => out.push(`<text x="${x}" y="${h - m.b + 16}" text-anchor="middle" fill="${INK}">${label}</text>`));
  if (xLabel) out.push(`<text x="${m.l + pw / 2}" y="${h - 4}" text-anchor="middle" fill="${INK}">${xLabel}</text>`);
  if (yLabel) out.push(`<text x="14" y="${m.t + ph / 2}" text-anchor="middle" fill="${INK}" transform="rotate(-90 14 ${m.t + ph / 2})">${yLabel}</text>`);
  return out.join('\n');
}

function lineChart({ title, series, labels, yMax, yTicks = 5, yLabel, xLabel, w = 640, h = 280, every = 1, markers = [] }) {
  const m = { l: 48, r: 16, t: 52, b: 44 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const X = (i) => m.l + (i / (labels.length - 1)) * pw;
  const Y = (v) => m.t + ph - (v / yMax) * ph;
  const xs = labels.map((l, i) => (i % every === 0 ? [X(i), l] : null)).filter(Boolean);
  const body = [axes({ w, h, m, xs, yMax, yTicks, xLabel, yLabel })];
  markers.forEach(({ i, label }) => {
    body.push(`<line x1="${X(i)}" x2="${X(i)}" y1="${m.t}" y2="${m.t + ph}" stroke="${PAL[3]}" stroke-dasharray="4 3"/>`);
    body.push(`<text x="${X(i) + 4}" y="${m.t + 12}" fill="${PAL[3]}">${label}</text>`);
  });
  series.forEach((s, k) => {
    const pts = s.values.map((v, i) => `${round(X(i), 1)},${round(Y(v), 1)}`).join(' ');
    body.push(`<polyline points="${pts}" fill="none" stroke="${PAL[k]}" stroke-width="2.2" stroke-linejoin="round"/>`);
  });
  body.push(`<text x="${m.l}" y="20" font-size="14" font-weight="600" fill="${INK}">${title}</text>`);
  series.forEach((s, k) => body.push(`<rect x="${m.l + k * 130}" y="28" width="10" height="10" fill="${PAL[k]}"/><text x="${m.l + 16 + k * 130}" y="37" fill="${INK}">${s.name}</text>`));
  return svg(w, h, body.join('\n'), title);
}

function barChart({ title, labels, groups, yMax, yTicks = 5, yLabel, w = 640, h = 280, stacked = false }) {
  const m = { l: 48, r: 16, t: 52, b: 44 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const slot = pw / labels.length, Y = (v) => (v / yMax) * ph;
  const xs = labels.map((l, i) => [m.l + slot * (i + 0.5), l]);
  const body = [axes({ w, h, m, xs, yMax, yTicks, yLabel })];
  labels.forEach((_, i) => {
    let base = 0;
    groups.forEach((g, k) => {
      const v = g.values[i];
      const bw = stacked ? slot * 0.64 : (slot * 0.72) / groups.length;
      const x = stacked ? m.l + slot * i + slot * 0.18 : m.l + slot * i + slot * 0.14 + bw * k;
      const y = m.t + ph - Y(base + v);
      body.push(`<rect x="${round(x, 1)}" y="${round(y, 1)}" width="${round(bw - 1, 1)}" height="${round(Y(v), 1)}" fill="${PAL[k]}"/>`);
      if (stacked) base += v;
    });
  });
  body.push(`<text x="${m.l}" y="20" font-size="14" font-weight="600" fill="${INK}">${title}</text>`);
  groups.forEach((g, k) => body.push(`<rect x="${m.l + k * 110}" y="28" width="10" height="10" fill="${PAL[k]}"/><text x="${m.l + 16 + k * 110}" y="37" fill="${INK}">${g.name}</text>`));
  return svg(w, h, body.join('\n'), title);
}

function heatmap({ title, rows, cols, values, w = 640 }) {
  const m = { l: 170, t: 36, cell: 26 };
  const h = m.t + rows.length * 20 + 30;
  const cw = (w - m.l - 10) / cols.length;
  const max = Math.max(...values.flat());
  const body = [`<text x="10" y="20" font-size="14" font-weight="600" fill="${INK}">${title}</text>`];
  cols.forEach((c, j) => body.push(`<text x="${m.l + cw * (j + 0.5)}" y="${h - 10}" text-anchor="middle" fill="${INK}">${c}</text>`));
  rows.forEach((name, i) => {
    body.push(`<text x="${m.l - 8}" y="${m.t + i * 20 + 14}" text-anchor="end" fill="${INK}">${name}</text>`);
    values[i].forEach((v, j) => body.push(`<rect x="${round(m.l + cw * j, 1)}" y="${m.t + i * 20}" width="${round(cw - 2, 1)}" height="18" rx="2" fill="${PAL[0]}" fill-opacity="${round(0.06 + 0.94 * Math.sqrt(v / max), 2)}"><title>${name}, ${cols[j]}: ${v}</title></rect>`));
  });
  return svg(w, h, body.join('\n'), title);
}

function scatter({ title, points, xMax, yMax, xLabel, yLabel, w = 480, h = 320 }) {
  const m = { l: 48, r: 16, t: 34, b: 44 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const xs = [0, 0.25, 0.5, 0.75, 1].map((f) => [m.l + f * pw, round(f * xMax, 0)]);
  const body = [axes({ w, h, m, xs, yMax, yTicks: 4, xLabel, yLabel })];
  points.forEach((p) => body.push(`<circle cx="${round(m.l + (p.x / xMax) * pw, 1)}" cy="${round(m.t + ph - (p.y / yMax) * ph, 1)}" r="${p.big ? 6 : 4}" fill="${p.big ? PAL[3] : PAL[0]}" fill-opacity="0.75"><title>Day ${p.d}</title></circle>`));
  body.push(`<text x="${m.l}" y="20" font-size="14" font-weight="600" fill="${INK}">${title}</text>`);
  return svg(w, h, body.join('\n'), title);
}

function pie({ title, parts, w = 420, h = 280 }) {
  const cx = 140, cy = 150, rad = 100, total = sum(parts.map((p) => p.v));
  let a = -Math.PI / 2;
  const body = [`<text x="10" y="20" font-size="14" font-weight="600" fill="${INK}">${title}</text>`];
  parts.forEach((p, k) => {
    const b = a + (p.v / total) * 2 * Math.PI;
    const large = b - a > Math.PI ? 1 : 0;
    const P = (t) => `${round(cx + rad * Math.cos(t), 1)},${round(cy + rad * Math.sin(t), 1)}`;
    body.push(`<path d="M${cx},${cy} L${P(a)} A${rad},${rad} 0 ${large} 1 ${P(b)} Z" fill="${PAL[k % PAL.length]}" stroke="#fff" stroke-width="1"/>`);
    body.push(`<rect x="270" y="${60 + k * 20}" width="10" height="10" fill="${PAL[k % PAL.length]}"/><text x="286" y="${69 + k * 20}" fill="${INK}">${p.name} (${p.v})</text>`);
    a = b;
  });
  return svg(w, h, body.join('\n'), title);
}

/* ------------------------------------------------------------- documents -- */

const files = {};
const put = (name, text) => (files[name] = text.replace(/^\n/, ''));
const DATE = (d) => `2244-11-${pad2(d)}`;
const shipTotal = (x) => sum(Object.values(x.ships));
const classTotals = CLASSES.map((c) => ({ name: c, v: sum(days.map((x) => x.ships[c])) }));
const spark = (xs) => { const b = '▁▂▃▄▅▆▇█', lo = Math.min(...xs), hi = Math.max(...xs); return xs.map((x) => b[Math.round(((x - lo) / (hi - lo || 1)) * 7)]).join(''); };
const peak = days[STORM - 1];
const blackoutTotal = sum(days.map((x) => x.blackout));
const uptime = round(100 - (27 / (DAYS * 24 * 60)) * 100, 3);
const weeks = [[1, 7], [8, 14], [15, 21], [22, 30]];

// charts
writeFileSync(join(ASSETS, 'solar-wind-november.svg'), lineChart({ title: 'Solar wind speed, November 2244', series: [{ name: 'Speed (km/s)', values: days.map((x) => x.sw) }], labels: days.map((x) => String(x.d)), yMax: 1000, yTicks: 5, yLabel: 'km/s', xLabel: 'day of month', every: 3, markers: [{ i: STORM - 1, label: 'beacon dark' }] }));
writeFileSync(join(ASSETS, 'traffic-by-day.svg'), barChart({ title: 'Ships logged per day, four main classes', labels: days.map((x) => (x.d % 3 === 1 ? String(x.d) : '')), groups: CLASSES.slice(0, 4).map((c) => ({ name: c, values: days.map((x) => x.ships[c]) })), yMax: 20, yTicks: 4, stacked: true, yLabel: 'ships' }));
writeFileSync(join(ASSETS, 'space-weather-year.svg'), barChart({ title: 'Flares and CME days by month, 2244', labels: monthly.map((x) => x.m), groups: [{ name: 'Flares', values: monthly.map((x) => x.flares) }, { name: 'CME days', values: monthly.map((x) => x.cmeDays) }], yMax: 25, yTicks: 5 }));
writeFileSync(join(ASSETS, 'solar-wind-year.svg'), lineChart({ title: 'Mean solar wind speed, 2244', series: [{ name: 'Mean km/s', values: monthly.map((x) => x.sw) }], labels: monthly.map((x) => x.m), yMax: 600, yTicks: 6, yLabel: 'km/s' }));
writeFileSync(join(ASSETS, 'battery-storm-week.svg'), lineChart({ title: 'Battery charge, 14 to 20 November', series: [{ name: 'Charge (%)', values: socHours }], labels: socHours.map((_, i) => (i % 96 === 0 ? `${14 + i / 96}th` : '')), yMax: 100, yTicks: 5, yLabel: 'percent', w: 700, markers: [{ i: (STORM - 14) * 96 + 6, label: 'CME' }] }));
writeFileSync(join(ASSETS, 'signals-heatmap.svg'), heatmap({ title: 'Signal detections by band and month, 2244', rows: signals.map((s) => s.name), cols: monthly.map((x) => x.m[0]), values: signals.map((s) => s.counts), w: 700 }));
writeFileSync(join(ASSETS, 'wind-vs-range.svg'), scatter({ title: 'Solar wind against nav-lock range', points: days.map((x) => ({ x: x.sw, y: x.range, d: x.d, big: Math.abs(x.d - STORM) <= 1 })), xMax: 1000, yMax: 40, xLabel: 'solar wind (km/s)', yLabel: 'range (Mm)' }));
writeFileSync(join(ASSETS, 'ship-classes.svg'), pie({ title: 'Ships by class, November', parts: classTotals.filter((p) => p.v > 0) }));

put('README.md', `
# Wren-4 Beacon Station

Wren-4 is a two-crew navigation beacon at the trailing Lagrange point of the gas giant Vesna c. Ships crossing the Oriel Belt steer by its pulse. This is everything the station knows, written down where the next crew can find it: the log, the space weather, the eclipse schedule, the traffic, the signals and the noodles.

![Wren-4 from the approach lane, Vesna c behind it](tour/panorama.svg)

> **A note from Bray, for whoever reads this next.**
>
> Every 26 days since 2230, something out in the trailing cluster has sent this station a signal. Nobody knows what it is. Quill calls it instrument noise and has asked me to stop talking about it, so I am writing it down instead.
>
> If you want to find out, start with the *Unexplained narrowband* row on the [signals page](signals.md#detections). There is more hidden around this station than the documents table admits.

## At a glance

| | November 2244 |
| :--- | ---: |
| Beacon uptime | ${uptime}% |
| Minutes dark (unplanned) | 27 |
| Radio blackout hours | ${blackoutTotal} |
| Ships logged | ${sum(days.map(shipTotal))} |
| Peak solar wind | ${Math.max(...days.map((x) => x.sw))} km/s, ${DATE(STORM)} |
| Crew dose this month | ${sum(days.map((x) => x.dose))} µSv |
| Cats aboard | 1 |
| Cats on the manifest | 0 |
| Unexplained signals logged this year | ${sum(signals[13].counts)} |

Solar wind this month: ${spark(days.map((x) => x.sw))}

![Solar wind speed through November](charts/solar-wind-november.svg)

## The station

<img src="tour/hab.svg" alt="The hab ring, fourteen windows and four spokes" width="640">

Fourteen windows, four spokes, one hub. Three of the windows have been shuttered since 2238. The hub does not turn, which is where you sleep and where the good chair is not.

## Standing orders

1. Two people for anything outside. No exceptions, and none have ever been asked for.
2. The beacon comes first. If you are choosing between the beacon and the hydroponics, shed the hydroponics.
3. Log the watch before you sleep, not after you wake. Quill will know.
4. If the beacon goes quiet, open the [runbook](runbooks/beacon-silent.md) before you open the panel.

The one command worth memorising, because it answers most of the questions the panel does:

\`\`\`sh
beaconctl status --watch
\`\`\`

## Documents

| Document | What is in it |
| :--- | :--- |
| [Station log, November](log/2244-11.md) | One row per day, the daily notes, the month's charts |
| [Crew meeting, 18 November](log/crew-meeting-2244-11-18.md) | The morning after the outage: decisions, stores, action items |
| [Incident: the beacon went dark](log/incident-2244-11-17.md) | Twenty-seven minutes of silence during a coronal mass ejection |
| [Beacon specification](beacon.md) | Pulse format, frequency plan, and the link budget with its maths |
| [Space weather](space-weather.md) | The year's table, the same data in four chart formats, the storm hour by hour |
| [Eclipses and power](eclipses.md) | Every eclipse this month as a \`csv\` block, and the battery through the storm |
| [Traffic](traffic.md) | Ships by class and day, where they were bound, the regulars |
| [Signals](signals.md) | Sixteen radio bands across twelve months, as a wide table and a heat map |
| [Maintenance](maintenance.md) | Stores, the work plan as a Gantt chart, the calibration schedule |
| [Beacon runbook](runbooks/beacon-silent.md) | What to do when the beacon will not transmit |
| [Noodles](noodles.md) | The only recipe aboard, scaled for 1 to 6 crew |

## Crew

<img src="tour/badge.svg" alt="The station badge" width="28"> Commissioned 2229, crewed continuously since.

| Name | Role | Aboard since | Notes |
| :--- | :--- | :---: | :--- |
| Ada Quill | Station chief | 2231 | Writes the log. Owns the good multimeter. |
| Tomas Bray | Systems technician | 2242 | Recalibrates the antenna more than it needs. |
| MOTH-3 | Maintenance drone | 2238 | Six legs, one opinion, several spare parts. |
| [Fresnel](crew/fresnel.md) | Cat | 2240 | Not on the manifest. Has never missed a watch. |

## How these files are kept

You will add to this, so here is what the conventions are. All of it is still text, and none of it needs a program this station does not already have.

> [!NOTE]
> A block written like this is a callout, and the runbook uses them for the steps that will bite you. It is the one piece of formatting worth reaching for when something is genuinely dangerous.

- Numbers you might want to sort, plot or hand to something else go in a \`csv\` block rather than a table. [Every eclipse this month](eclipses.md#every-eclipse-this-month) is kept that way, and so is the receiver log for the night of the 17th.
- Diagrams are written as Mermaid, so they still read as text when nothing is there to draw them. The [work plan](maintenance.md#work-plan) is a Gantt chart written in about twelve lines.
- Where the working matters more than the answer, write the working. The [link budget](beacon.md#link-budget) keeps the free-space term as $20\\log_{10}(4\\pi d / \\lambda)$ rather than a number, because the number is wrong the moment the geometry moves.
- ==Highlight the one line that matters== instead of bolding half a paragraph. The incident report does it once, on the sentence the whole case rests on.
- A chart that needs its numbers beside it is Vega-Lite, which is what the [signals](signals.md) page uses.

Before you hand over to the crew after you:

- [ ] Read the runbook front to back, not the summary
- [ ] Walk the ring once with the outgoing chief
- [ ] Find out what the narrowband is

<!-- The documents table does not list every room. -->
`);

const logRows = days.map((x) => `| ${DATE(x.d)} | ${x.sw} | ${x.range} | ${x.dose} | ${x.eclipse} | ${x.blackout || ''} | ${shipTotal(x)} | ${NOTES[x.d] ?? ''} |`).join('\n');
put('log/2244-11.md', `
---
station: Wren-4
month: 2244-11
chief: Ada Quill
---

# Station log, November 2244

[Back to the station](../README.md) · [October](2244-10.md) · December (not yet written)

Solar wind is km/s at the forward sensor. Range is the distance in megametres at which a ship can hold lock on the beacon. Dose is crew dose in microsieverts. Eclipse is minutes per orbit in the planet's shadow. Blackout is hours with no radio.

| Date | Solar wind | Range | Dose | Eclipse | Blackout | Ships | Notes |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
${logRows}
| **Total** | | | **${sum(days.map((x) => x.dose))}** | | **${blackoutTotal}** | **${sum(days.map(shipTotal))}** | |

## Charts

![Solar wind with the incident marked](../charts/solar-wind-november.svg)

![Ships logged per day, stacked by class](../charts/traffic-by-day.svg)

The pane that cracked on the 17th is the third bay up on ![Mast 1][mast], which is also where the dish mount is, so both jobs wait on the same EVA.

<div align="center">
  <figure>
    <img src="../tour/mast.svg" alt="Mast 1, third bay up" width="200">
    <figcaption>Mast 1 from the cupola, the morning after.</figcaption>
  </figure>
</div>

Quill's photograph of the same mast, taken before the storm, is ![mast] for comparison; nothing in it looks different.

Eclipses lengthen as the station's orbit tilts toward the planet's shadow:

\`\`\`mermaid
xychart-beta
    title "Eclipse minutes per orbit"
    x-axis [${days.map((x) => x.d).join(', ')}]
    y-axis "minutes" 30 --> 55
    line [${days.map((x) => x.eclipse).join(', ')}]
\`\`\`

Blackout hours, as the relief crew prefers to read them:

\`\`\`text
${days.filter((x) => x.blackout).map((x) => `${DATE(x.d)}  ${'█'.repeat(x.blackout).padEnd(11)} ${x.blackout} h`).join('\n')}
\`\`\`

## Remarks

- [x] Log countersigned by the inspector on ${DATE(12)} :heavy_check_mark:
- [ ] Return the inspector's coffee cup :coffee: (Bray says it is ours now)
- [x] Incident report filed for ${DATE(STORM)}
- [ ] Order a spare sensor-mast pane before the next storm
- [x] ~~Ask the tender for more oranges~~ The tender brought them unasked, which has never happened before

[mast]: ../tour/mast.svg "Mast 1, sensor bay three"

<!-- Bray: Quill, if you ever read this file raw, the reserved bits are not radiation. They say the same thing every ten seconds. -->
`);

const stormMinutes = [
  ['01:52', 'Solar wind 910 km/s. Proton flux climbing. Beacon normal.', 'Normal'],
  ['02:06', 'Phase lock wanders. Bray reports the master oscillator drifting 40 Hz.', 'Degraded'],
  ['02:14', 'Beacon silent. Single-event upset latched the amplifier controller. Backup transmitter will not key: its cryocooler was in standby.', 'Dark'],
  ['02:17', 'Quill to the transmitter bay. Bray to the storm shelter console.', 'Dark'],
  ['02:19', 'Receiver logs the unexplained narrowband signal for 70 seconds, from the trailing cluster. The beacon was silent, so it was not an echo.', 'Dark'],
  ['02:23', 'Omnidirectional distress tone started by hand so ships have something.', 'Dark'],
  ['02:31', 'Controller power-cycled. First restart fails: the watchdog trips again.', 'Dark'],
  ['02:41', 'Beacon keyed from the manual panel. Pulse timing kept by hand from the reference clock until 03:30.', 'Manual'],
  ['03:30', 'Controller firmware reloaded from the shielded store. Automatic timing restored.', 'Normal'],
  ['06:10', 'Sensor mast pane found crazed. Sealed from inside.', 'Normal'],
];
const crc16 = (bytes) => {
  let c = 0xffff;
  for (const b of bytes) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
};
const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
const hexBytes = (h) => h.match(/../g).map((x) => parseInt(x, 16));
const OUTBOUND = 'ANYONEHOME';
const hazardByte = (ch) => ((ch.charCodeAt(0) - 64) << 3) | 0x06;
const frames = [...OUTBOUND].map((ch, i) => {
  const epoch = hex((Date.UTC(2244, 10, 17, 2, 13, 50 + i) - Date.UTC(2200, 0, 1)) / 1000, 12);
  const subsec = hex(0x00068db8 + i * 0x13, 8);
  const hz = hazardByte(ch);
  const crc = crc16([0x57, 0x04, ...hexBytes(epoch), ...hexBytes(subsec), hz]);
  return `02:13:${50 + i}  1ACFFC1D 5704 ${epoch} ${subsec} ${hex(hz, 2)} ${hex(crc, 4)}`;
});

put('log/incident-2244-11-17.md', `
# Incident: the beacon went dark

| | |
| :--- | :--- |
| **When** | ${DATE(STORM)}, 02:14 to 02:41 station time |
| **Dark for** | 27 minutes |
| **Solar wind** | ${peak.sw} km/s at the peak |
| **Ships at risk** | One: the tanker *Ormond Drift*, which held station 6 Mm off the belt edge |
| **Written by** | Ada Quill |

## What happened

At 02:14 the beacon fell silent for the first time in eleven years. A coronal mass ejection had been hitting the station since midnight, and a single-event upset latched the amplifier controller. The backup transmitter should have taken over and did not, because its cryocooler had been left in standby after the October service.

We keyed the beacon from the manual panel at 02:41 and kept pulse timing by hand for fifty minutes. Nobody was hurt. The *Ormond Drift* called at 02:20 to ask whether we were still there, which is a question no beacon crew wants to hear.

## Timeline

| Time | Event | Beacon |
| :---: | :--- | :--- |
${stormMinutes.map(([t, e, s]) => `| ${t} | ${e} | ${s} |`).join('\n')}

\`\`\`mermaid
timeline
    title Night of 16 to 17 November
    01:52 : Beacon normal
    02:06 : Phase lock wanders
    02:14 : Beacon silent
          : Backup will not key
    02:19 : Narrowband signal logged
    02:23 : Distress tone by hand
    02:41 : Beacon keyed manually
          : Hand-timed pulses
    03:30 : Automatic timing restored
\`\`\`

\`\`\`mermaid
stateDiagram-v2
    [*] --> Normal
    Normal --> Degraded: oscillator drift
    Degraded --> Dark: controller latch-up
    Dark --> Manual: keyed from panel
    Manual --> Normal: firmware reloaded
    Dark --> Dark: backup cryocooler cold
\`\`\`

## What the receiver heard while the beacon was dark

The dish listens between pulses and keeps its own log. These are the detections either side of the silence. ==The station transmitted nothing between 02:14 and 02:41==, so nothing in this window is the station hearing itself.

\`\`\`csv
time,band,freq_mhz,snr_db,seconds,note
01:48,Hydrogen line,1420.4057,7.2,12,routine
02:02,Decametric burst,22.5,9.1,40,Vesna c
02:06,Hydrogen line,1420.4057,6.8,9,routine
02:19,Unexplained narrowband,1420.4058,57.1,70,"beacon dark, nothing transmitting"
02:33,Decametric burst,22.5,8.4,26,Vesna c
02:58,Hydrogen line,1420.4057,7.0,11,routine
03:41,Water maser,22.2350,12.6,18,routine
\`\`\`

The 02:19 row is the one to look at. Fifty-seven decibels over the noise floor, on the bearing of the trailing cluster, seventy seconds long, five minutes into a silence nobody outside this station knew about yet.

## Last frames before the silence

The transmitter monitor keeps the last ten frames it sent. The fields are those of the [pulse format](../beacon.md#pulse-format): sync word, station ID, epoch, sub-second, hazard flags, CRC.

\`\`\`text
${frames.join('\n')}
\`\`\`

During a storm with a blackout forecast the hazard byte should read \`06\`. Bray has pointed out, more than once, that it does not. Quill puts it down to radiation damage in the capture buffer. Every CRC checks.

Bray wrote this and left it in the log. He has not said what it prints.

\`\`\`python
# Hazard byte, last ten frames before the silence. In a storm every one of
# these should read 0x06. Bits 3 to 7 carry something else.
FRAMES = [${[...OUTBOUND].map((ch) => '0x' + hex(hazardByte(ch), 2)).join(', ')}]

def letter(hazard_byte):
    """Bits 3 to 7, as a letter. A = 1."""
    return chr((hazard_byte >> 3) + ord("@"))

assert all(b & 0x07 == 0x06 for b in FRAMES), "storm flags intact"
print("".join(letter(b) for b in FRAMES))
\`\`\`

<figure><img src="../tour/cryo.svg" alt="The backup transmitter cryocooler, reading 18 K and warm" width="420"><figcaption>The cryocooler at 02:20, reading 18 K. It needs 4 K, and forty minutes to get there.</figcaption></figure>

## Why the backup failed

1. The backup transmitter's cryocooler takes 40 minutes to reach operating temperature.
2. It was left in standby after the October service.
   1. The service checklist says to return it to warm standby.
   2. The checklist was signed. The step was not done. See [maintenance](../maintenance.md#work-plan).
3. Nobody checked the backup after the service, because the weekly test only checks that it powers on.

## Actions

| # | Action | Owner | Due | Done |
| ---: | :--- | :--- | :--- | :---: |
| 1 | Hold the backup cryocooler in warm standby at all times | Bray | 2244-11-18 | ✅ |
| 2 | Weekly test must key the backup at full power for 60 s | Quill | 2244-11-20 | ✅ |
| 3 | Radiation-harden the amplifier controller | Yard engineers | 2244-12-05 | ⬜ |
| 4 | Fit a watchdog that fails over instead of retrying | Yard engineers | 2245-02 | ⬜ |
| 5 | Replace the crazed sensor-mast pane | Bray | 2244-11-21 | ✅ |

> [!NOTE]
> The *Ormond Drift* sent a bottle of something amber with the next tender. It has been logged as a gift. Stores never saw it.
`);

put('beacon.md', `
# Beacon specification

Wren-4 transmits a timing pulse that ships use for position and a slow data channel that carries the belt's hazard bulletin.

<div align="left"><figure><img src="tour/mast.svg" alt="Mast 1, twelve lattice bays and the beacon on top" width="200"><figcaption>Mast 1. Twelve bays, two guy runs, and the only structure aboard nobody touches alone.</figcaption></figure></div>

## Pulse format

| Field | Bits | Value | Meaning |
| :--- | ---: | :--- | :--- |
| Sync word | 32 | \`0x1ACFFC1D\` | Start of frame |
| Station ID | 16 | \`0x5704\` | Wren-4 |
| Epoch | 48 | seconds since 2200-01-01 | Coarse time |
| Sub-second | 32 | 2⁻³² s units | Fine time |
| Hazard flags | 8 | bitfield | See [hazard flags](#hazard-flags) |
| CRC | 16 | CRC-16/CCITT-FALSE | Over every byte after the sync word |

\`\`\`c
struct wren_pulse {
    uint32_t sync;        /* 0x1ACFFC1D */
    uint16_t station_id;  /* 0x5704 */
    uint64_t epoch : 48;
    uint32_t subsec;
    uint8_t  hazards;     /* bit 0 debris, bit 1 CME, bit 2 blackout */
    uint16_t crc;
} __attribute__((packed));
\`\`\`

## Hazard flags

| Bit | Mask | Meaning |
| :---: | :---: | :--- |
| 0 | \`0x01\` | Debris reported within 5 Mm |
| 1 | \`0x02\` | Coronal mass ejection in progress |
| 2 | \`0x04\` | Radio blackout expected |
| 3 to 7 | \`0xF8\` | Reserved. Transmit as zero. |

## Frequency plan

| Channel | Centre | Bandwidth | Power | Use |
| :--- | ---: | ---: | ---: | :--- |
| Timing | 8.450 GHz | 2 MHz | 200 W | Pulse, every 1.000 s |
| Bulletin | 8.455 GHz | 250 kHz | 50 W | Hazard bulletin, 1 kbit/s |
| Backup | 2.290 GHz | 2 MHz | 40 W | Timing only, when the main chain fails |
| Distress | 406.0 MHz | 3 kHz | 5 W | Omnidirectional tone |

<img src="tour/dish.svg" alt="The receiver dish, aimed at the trailing cluster" width="320" align="right">

Between pulses the same aperture listens, which is why the budget below is written for the transmit path and read for both.

## Link budget

A ship can hold lock when the received power clears the receiver's sensitivity with margin. Received power follows the Friis transmission equation:

$$
P_r = P_t \\, G_t \\, G_r \\left( \\frac{\\lambda}{4 \\pi d} \\right)^2
$$

In decibels, which is how anyone actually does it:

$$
P_r\\,[\\mathrm{dBW}] = P_t + G_t + G_r - 20\\log_{10}\\!\\left(\\frac{4\\pi d}{\\lambda}\\right) - L_\\text{misc}
$$

At $f = 8.45$ GHz, $\\lambda \\approx 3.55$ cm. The free-space loss at distance $d$ is $L_{fs} = 20\\log_{10}(d) + 20\\log_{10}(f) - 147.55$ dB with $d$ in metres and $f$ in hertz.

| Term | Quiet sun | During the CME |
| :--- | ---: | ---: |
| Transmit power, 200 W | +23.0 dBW | +23.0 dBW |
| Beacon sector horn gain | +18.0 dBi | +18.0 dBi |
| Ship antenna gain | +10.0 dBi | +10.0 dBi |
| Free-space loss at 38 Mm | −202.6 dB | −202.6 dB |
| Plasma scintillation | −1.0 dB | −14.0 dB |
| Pointing and polarisation | −2.0 dB | −2.0 dB |
| **Received power** | **−154.6 dBW** | **−167.6 dBW** |
| Receiver sensitivity | −160.0 dBW | −160.0 dBW |
| **Margin** | **+5.4 dB** | **−7.6 dB** |

A 7.6 dB shortfall is a factor of about 5.8 in power. Lock range scales with the square root of that, which is why range fell from 38 Mm to under 16 Mm before the controller failed and to zero after it.

\`\`\`python
from math import log10, pi

def margin_db(p_tx_w, g_tx, g_rx, d_m, f_hz, losses_db, sensitivity_dbw=-160.0):
    fspl = 20 * log10(d_m) + 20 * log10(f_hz) - 147.55
    p_rx = 10 * log10(p_tx_w) + g_tx + g_rx - fspl - losses_db
    return p_rx - sensitivity_dbw

print(round(margin_db(200, 18, 10, 38e6, 8.45e9, 3), 1))   # 5.4
print(round(margin_db(200, 18, 10, 38e6, 8.45e9, 16), 1))  # -7.6
\`\`\`
`);

const stormHours = [];
for (let h = 0; h < 48; h++) {
  const t = h - 26;
  const speed = Math.round(400 + 540 * Math.exp(-(t ** 2) / 60) + (r() - 0.5) * 40);
  const bz = round(-2 - 28 * Math.exp(-((t + 1) ** 2) / 30) + (r() - 0.5) * 3, 1);
  const flux = Math.round(10 ** (0.6 + 3.2 * Math.exp(-((t - 1) ** 2) / 50)));
  const index = Math.min(9, Math.max(0, Math.round(1 + 8 * Math.exp(-(t ** 2) / 40))));
  stormHours.push(`${h < 24 ? DATE(16) : DATE(17)}T${pad2(h % 24)}:00,${speed},${bz},${flux},${index}`);
}
put('space-weather.md', `
# Space weather

Wren-4 sits in the open, with nothing between it and the star but 2.1 AU of plasma. This page keeps the station's space-weather records for 2244 and the detail of the November storm.

## The year

| Month | Solar wind (km/s) | Flares | CME days | Blackout days |
| :--- | ---: | ---: | ---: | ---: |
${monthly.map((x) => `| ${x.m} | ${x.sw} | ${x.flares} | ${x.cmeDays} | ${x.blackoutDays} |`).join('\n')}
| **Year** | **${Math.round(sum(monthly.map((x) => x.sw)) / 12)}** | **${sum(monthly.map((x) => x.flares))}** | **${sum(monthly.map((x) => x.cmeDays))}** | **${sum(monthly.map((x) => x.blackoutDays))}** |

The same year drawn four ways, because the relief crew cannot agree on a tool.

**As an image**, which renders anywhere:

![Mean solar wind speed by month](charts/solar-wind-year.svg)

![Flares and CME days by month](charts/space-weather-year.svg)

**As Mermaid:**

\`\`\`mermaid
xychart-beta
    title "Flares per month and mean solar wind (km/s / 20)"
    x-axis [${monthly.map((x) => x.m).join(', ')}]
    y-axis "value" 0 --> 30
    bar [${monthly.map((x) => x.flares).join(', ')}]
    line [${monthly.map((x) => Math.round(x.sw / 20)).join(', ')}]
\`\`\`

**As Vega-Lite:**

\`\`\`vega-lite
{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "description": "CME days by month at Wren-4, 2244",
  "data": {
    "values": [
${monthly.map((x) => `      {"month": "${x.m}", "cme_days": ${x.cmeDays}, "blackout_days": ${x.blackoutDays}}`).join(',\n')}
    ]
  },
  "mark": "bar",
  "encoding": {
    "x": {"field": "month", "type": "ordinal", "sort": null},
    "y": {"field": "cme_days", "type": "quantitative", "title": "CME days"}
  }
}
\`\`\`

**As a note-app chart block:**

\`\`\`chart
type: line
labels: [${monthly.map((x) => x.m).join(', ')}]
series:
  - title: Blackout days
    data: [${monthly.map((x) => x.blackoutDays).join(', ')}]
  - title: CME days
    data: [${monthly.map((x) => x.cmeDays).join(', ')}]
tension: 0.2
width: 80%
beginAtZero: true
\`\`\`

## Does fast wind shorten the beacon's reach?

Yes. Each dot is one November day. The pink dots are the storm.

![Solar wind against nav-lock range, one dot per day](charts/wind-vs-range.svg)

\`\`\`mermaid
quadrantChart
    title Days by solar wind and lock range
    x-axis Slow wind --> Fast wind
    y-axis Short range --> Long range
    quadrant-1 Fast but clear
    quadrant-2 Good beacon weather
    quadrant-3 Scintillation
    quadrant-4 Storm
${days.filter((x) => x.d % 3 === 2 || Math.abs(x.d - STORM) <= 1).map((x) => `    Nov ${x.d}: [${round(x.sw / 1000, 2)}, ${round(x.range / 40, 2)}]`).join('\n')}
\`\`\`

## The November storm, hour by hour

Readings from the forward sensor, ${DATE(16)} 00:00 to ${DATE(17)} 23:00. Speed in km/s, the magnetic field's north-south component Bz in nanotesla, proton flux in particles per cm² per second per steradian, and the station's own 0 to 9 storm index.

\`\`\`csv
time,speed_km_s,bz_nT,proton_flux,storm_index
${stormHours.join('\n')}
\`\`\`

Storm index, as the console strip chart drew it:

\`\`\`text
9 ┤                    ▄█▄
7 ┤                  ▄█████▄
5 ┤               ▂▅█████████▅▂
3 ┤          ▂▃▅▇█████████████▇▅▃▂
1 ┤▁▁▁▁▁▁▂▃▅███████████████████████▅▃▂▁▁▁
  └────────────────────────────────────────
   16th 00:00         17th 02:14        17th 23:00
\`\`\`
`);

const eclipseCsv = eclipses.map((e) => `${e.n},${DATE(e.d)},${e.start},${e.end},${e.len},${e.soc}`).join('\n');
put('eclipses.md', `
# Eclipses and power

Wren-4 orbits Vesna c once every ${PERIOD} hours. Once per orbit the station passes through the planet's shadow and runs on batteries. November is the start of eclipse season, so the shadow passes get longer every day.

Minimum battery charge at the end of an eclipse is 40%. Below that, the beacon sheds the bulletin channel to protect the timing pulse.

![Battery charge through the storm week](charts/battery-storm-week.svg)

## Every eclipse this month

\`\`\`csv
orbit,date,enter,exit,minutes,charge_at_exit_pct
${eclipseCsv}
\`\`\`

## Summary by week

| Week | Eclipses | Longest (min) | Lowest charge (%) |
| :--- | ---: | ---: | ---: |
${weeks.map(([a, b]) => {
  const w = eclipses.filter((e) => e.d >= a && e.d <= b);
  return `| ${a} to ${b} Nov | ${w.length} | ${Math.max(...w.map((e) => e.len))} | ${Math.min(...w.map((e) => e.soc))} |`;
}).join('\n')}

> [!WARNING]
> On ${DATE(STORM)} the storm-shelter heaters and the eclipse overlapped. Charge fell to ${socMin}%, and it took three days of sunlit orbits to climb back above 60%. Do not run the shelter heaters during an eclipse unless someone is in the shelter.

<div align="center"><figure><img src="tour/power.svg" alt="Six cells on bus A, cell five at 39 percent" width="560"><figcaption>Bus A on the morning of the 18th. Cell five has not come back.</figcaption></figure></div>

## Power budget

| Load | Sunlight (W) | Eclipse (W) | Storm (W) |
| :--- | ---: | ---: | ---: |
| Beacon, timing | 610 | 610 | 610 |
| Beacon, bulletin | 160 | 160 | 0 |
| Life support | 1,250 | 1,250 | 1,250 |
| Cryocoolers | 340 | 340 | 340 |
| Shelter heaters | 0 | 0 | 2,400 |
| Hydroponics lights | 900 | 0 | 0 |
| Fresnel's heated bed | 15 | 15 | 15 |
| **Total** | **3,275** | **2,375** | **4,615** |
`);

const regulars = [
  ['*Morrow Line 4*', 'Liner', 'Oriel Ring', 'Vesna c-II', 'Twice daily except on rest days'],
  ['*Ormond Drift*', 'Tanker', 'Harrow Yard', 'Farside Depot', 'Called us during the storm'],
  ['*Pick of the Belt*', 'Ore hauler', 'Rock 2231-QK', 'Oriel Ring', 'Leaves at shift change, back by next'],
  ['*Tern*', 'Survey', 'Farside Depot', 'Trailing cluster', 'Counts rocks. Brought biscuits.'],
  ['*鹮*', 'Liner', 'Wan-Ho Ring', 'Vesna c-II', 'Named for a bird nobody aboard has seen'],
  ['*한빛*', 'Tender', 'Sejong Station', 'Oriel Ring', 'Brings the oranges ⭐'],
  ['*نسيم*', 'Survey', 'Qasr Depot', 'Trailing cluster', 'Works the cluster edge and reports nothing'],
  ['*נחשון*', 'Ore hauler', 'Beit Marr', 'Oriel Ring', 'First through the lane after a storm, always'],
  ['*Zéphyr*', 'Liner', 'Harrow Yard', 'Farside Depot', 'Odd days only, and never late'],
  ['*Rene\u0301e*', 'Survey', 'Harrow Yard', 'Rock 2231-QK', "Quill's first posting was aboard her"],
  ['*Unregistered, no transponder*', 'Unidentified', '?', '?', 'Twice this month, no lights, no reply'],
];
put('traffic.md', `
# Traffic

Every ship that locks the beacon is logged with its class and, when it answers a hail, where it is bound. November was quiet either side of the storm and busy after.

![Ships by class](charts/ship-classes.svg)

| Class | Ships | Share | Busiest day |
| :--- | ---: | ---: | :--- |
${classTotals.map((c) => {
  const best = days.reduce((a, b) => (b.ships[c.name] > a.ships[c.name] ? b : a));
  return `| ${c.name} | ${c.v} | ${round((c.v / sum(classTotals.map((x) => x.v))) * 100, 1)}% | ${best.ships[c.name] ? DATE(best.d) : ''} |`;
}).join('\n')}

\`\`\`mermaid
pie showData
    title Ships by class, November
${classTotals.filter((c) => c.v).map((c) => `    "${c.name}" : ${c.v}`).join('\n')}
\`\`\`

<img src="tour/panorama.svg" alt="The approach lane, Wren-4 at station keeping" width="1200">

This is the view from the lane, which is what a ship sees for about forty minutes on its way past.

## Where they were bound

\`\`\`mermaid
sankey-beta
Belt rocks,Oriel Ring,${classTotals[0].v - 20}
Oriel Ring,Vesna c-II,${classTotals[2].v}
Harrow Yard,Farside Depot,${Math.ceil(classTotals[1].v / 2)}
Farside Depot,Harrow Yard,${Math.floor(classTotals[1].v / 2)}
Belt rocks,Harrow Yard,20
Farside Depot,Trailing cluster,${classTotals[4].v}
\`\`\`

## Daily counts

| Day | ${CLASSES.join(' | ')} | Total |
| ---: | ${CLASSES.map(() => '---:').join(' | ')} | ---: |
${days.map((x) => `| ${x.d} | ${CLASSES.map((c) => x.ships[c] || '·').join(' | ')} | ${shipTotal(x)} |`).join('\n')}

<div align="center"><figure><img src="tour/cupola.svg" alt="The cupola, with the nav lock readout" width="420"><figcaption>The cupola. Every ship below is a number that appeared on that readout first.</figcaption></figure></div>

## Regulars

| Ship | Class | From | To | Remarks |
| :--- | :--- | :--- | :--- | :--- |
${regulars.map((x) => `| ${x.join(' | ')} |`).join('\n')}

Names are kept as the registering port writes them, so the first column runs in five scripts and two directions. The yard's manifest software cannot line them up either.
`);

const months = monthly.map((x) => x.m);
const heat = (v, max) => (v === 0 ? '·' : ' ░▒▓█'[Math.min(4, 1 + Math.floor((v / max) * 4))]);
put('signals.md', `
# Signals

Between pulses the beacon's dish listens. The receiver logs every detection above five sigma, sorted into bands. Most of it is molecules in the belt's gas and the planet's aurora. Some of it is the station hearing itself. One band we cannot explain.

![Signal detections as a heat map](charts/signals-heatmap.svg)

<div align="right"><figure><img src="tour/dish.svg" alt="The receiver dish" width="240"><figcaption>Aimed at the trailing cluster since before either of us arrived. Nobody aboard aimed it.</figcaption></figure></div>

## Detections

> [!TIP]
> Bray's note, taped to the console: *read each month's count on the Unexplained narrowband row as a letter, A = 1. January is 6, so F. February is 15, so O. Twelve months, twelve letters. I had F, O, L, L when Quill walked in.* The counts are also listed on one line [below](#the-unexplained-narrowband-signal), for anyone the table is too wide for.

| Band | ${months.join(' | ')} | Peak |
| :--- | ${months.map(() => '---:').join(' | ')} | :--- |
${signals.map((s) => `| ${s.name === 'Fresnel near a receiver' ? `[${s.name}](crew/fresnel.md)` : s.name} | ${s.counts.join(' | ')} | ${months[s.counts.indexOf(Math.max(...s.counts))]} |`).join('\n')}

## The same, at a glance

\`\`\`text
${''.padEnd(28)}${months.map((m) => m[0]).join(' ')}
${signals.map((s) => `${s.name.padEnd(28)}${s.counts.map((v) => heat(v, Math.max(...s.counts))).join(' ')}`).join('\n')}
\`\`\`

## The count, month by month

The unexplained band on its own, which is the drawing Bray made to show Quill the counts were not random. She said a jagged line is exactly what random looks like.

\`\`\`vega-lite
{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "description": "Unexplained narrowband detections by month, Wren-4, 2244",
  "data": {
    "values": [
      ${months.map((m, i) => `{"month": "${m}", "detections": ${signals[13].counts[i]}}`).join(',\n      ')}
    ]
  },
  "mark": {"type": "bar", "tooltip": true},
  "encoding": {
    "x": {"field": "month", "type": "ordinal", "sort": null, "title": "Month"},
    "y": {"field": "detections", "type": "quantitative", "title": "Detections"}
  }
}
\`\`\`

## The signal year

\`\`\`mermaid
timeline
    title Detections through 2244
    section Early
        March : Methanol masers brighten
        April : Hydroxyl lines strengthen
    section Middle
        June : Water masers peak
             : Unexplained narrowband peaks
        July : Hydrogen line peaks
             : Carbon monoxide peaks
        August : Methanol masers fade
    section Late
        November : Decametric bursts from Vesna c
        December : c-II moon beacon season
\`\`\`

## The unexplained narrowband signal

| Property | Value |
| :--- | :--- |
| Frequency | 1,420.4058 MHz, 0.9 kHz above the hydrogen line |
| Bandwidth | under 1 Hz |
| Direction | Fixed on the sky, toward the trailing cluster |
| Repeats | Every 26.3 days, for about 70 seconds |
| Detections per month, January to December | ${signals[13].counts.join(' ')} |
| Detections in 2244 | ${sum(signals[13].counts)} |
| First logged | 2230-08-02, 02:14 station time, before either of the current crew arrived |
| Explanation | None. Bray thinks the monthly counts are letters. Quill has asked him to stop. |
| Bray's decode so far | F O L L ... |

Trends for the three bands we watch most closely:

| Band | 2242 | 2243 | 2244 | Trend |
| :--- | ---: | ---: | ---: | :---: |
| Hydrogen line | 61 | 52 | ${Math.max(...signals[0].counts)} | ${spark([61, 52, Math.max(...signals[0].counts)])} |
| Water maser | 180 | 150 | ${Math.max(...signals[4].counts)} | ${spark([180, 150, Math.max(...signals[4].counts)])} |
| Unexplained narrowband | 18 | 22 | ${Math.max(...signals[13].counts)} | ${spark([18, 22, Math.max(...signals[13].counts)])} |
`);

const stores = [
  ['Xenon (thruster)', 'kg', 180, 41, 60, 'Tender, 2244-12-05'],
  ['Amplifier controller boards', 'each', 6, 1, 2, 'One latched up in the storm'],
  ['CO₂ scrubber cartridges', 'each', 40, 16, 10, ''],
  ['Waveguide gaskets', 'each', 24, 4, 6, 'Now kept in the shielded store'],
  ['Sensor-mast panes', 'each', 2, 1, 1, 'One used 2244-11-21. **Order another.**'],
  ['Oranges, real', 'each', 60, 38, 12, 'Morale item'],
  ['Coffee', 'kg', 20, 6, 8, 'Below reorder level'],
  ['Cat food', 'tins', 90, 22, 30, 'Below reorder level'],
];
put('maintenance.md', `
# Maintenance

## Stores

| Item | Unit | Capacity | On hand | Reorder at | Notes |
| :--- | :--- | ---: | ---: | ---: | :--- |
${stores.map(([a, u, c, h, ro, n]) => `| ${a} | ${u} | ${c} | ${h < ro ? `**${h}**` : h} | ${ro} | ${n} |`).join('\n')}

Xenon used for station-keeping, per week:

\`\`\`mermaid
xychart-beta
    title "Xenon burned per week (kg)"
    x-axis ["1 to 7", "8 to 14", "15 to 21", "22 to 30"]
    y-axis "kg" 0 --> 20
    bar [${weeks.map(([a, b]) => round(sum(days.filter((x) => x.d >= a && x.d <= b).map((x) => x.sw)) / 900, 1)).join(', ')}]
\`\`\`

<img src="tour/stores.svg" alt="The stores locker, bin \\[8\\] empty" width="240" align="right">

Bin 8 has been empty since the 17th. The yard acknowledged the request and has not scheduled it.

## Work plan

\`\`\`mermaid
gantt
    title Work plan, November 2244 to February 2245
    dateFormat YYYY-MM-DD
    axisFormat %d %b
    section Beacon
        Replace sensor-mast pane      :done,    pane,   2244-11-18, 3d
        Fail-over watchdog            :         wd,     2245-02-01, 10d
    section Hardening
        Harden amplifier controller   :active,  harden, 2244-11-25, 2244-12-05
        Tender with new boards        :milestone, 2244-12-05, 0d
    section Hull
        Reseal micrometeoroid pits    :         pits,   after harden, 12d
        Inspect radiator panels       :crit,    rad,    2245-01-10, 2d
    section Antenna
        Calibrate feed                :done,    c1,     2244-11-09, 1d
        Calibrate feed                :         c2,     2244-12-07, 1d
        Calibrate feed                :         c3,     2245-01-04, 1d
\`\`\`

<figure><img src="tour/bench.svg" alt="Bench 2, with the good multimeter" width="640"><figcaption>Bench 2. The good multimeter is the one that reads to four places, and it does not leave this bench.</figcaption></figure>

<img src="tour/moth.svg" alt="MOTH-3" height="90">

MOTH-3 does the outside half of this schedule. Six legs, one opinion, and a service interval nobody has ever met.

## Calibration schedule

The feed is calibrated every four weeks, and Bray calibrates it in between whenever he thinks nobody is looking.

| Task | Every | Last done | Next due | By |
| :--- | :--- | :--- | :--- | :--- |
| Calibrate antenna feed | 4 weeks | 2244-11-09 | 2244-12-07 | Bray |
| Discipline the reference clock | 1 week | 2244-11-20 | 2244-11-27 | Quill |
| Key the backup at full power | 1 week | 2244-11-20 | 2244-11-27 | Quill |
| Swap a scrubber cartridge | 3 days | 2244-11-29 | 2244-12-02 | MOTH-3 |
| Brush Fresnel off the console | 1 hour | always | always | whoever is awake |
`);

put('runbooks/beacon-silent.md', `
# Beacon runbook: the beacon will not transmit

The beacon must pulse once a second, every second. If the forward monitor shows a gap longer than three seconds, work down this page.

\`\`\`mermaid
flowchart TD
    A[No pulse on the monitor] --> B{Amplifier powered?}
    B -- no --> C{Bus voltage above 110 V?}
    C -- no --> D[Shed hydroponics lights] --> B
    C -- yes --> E[Reset breaker P7] --> B
    B -- yes --> F{Controller heartbeat?}
    F -- no --> G[Power-cycle the controller] --> F
    F -- yes --> H{Phase lock green?}
    H -- no --> I[Switch to the backup chain]
    H -- yes --> J[Beacon is fine. Check the monitor.]
    I --> K[Log it]
    J --> K
\`\`\`

<img src="../tour/airlock.svg" alt="EVA 1" width="180" align="left">

Step 6 is the only one that takes you outside. Nobody does it alone, and nobody does it during a blackout forecast.

## Steps

1. Check the amplifier is powered. The bay fans are audible from the hatch.
2. If it is silent, check the bus panel:
   - Bus above 110 V: reset breaker **P7**.
   - Bus below 110 V: shed the hydroponics lights, then check again.
3. Watch for the controller heartbeat LED. ~Wait a full minute before power-cycling.~ Superseded 2244-11-18: if it is dark for more than 5 seconds, power-cycle the controller.
4. If phase lock will not go green, switch to the backup chain:
   \`\`\`sh
   beaconctl chain --select backup --confirm
   beaconctl status --watch
   \`\`\`
5. If the backup will not key either, key the beacon by hand from the manual panel and keep time from the reference clock. Wake the other crew member.
6. Write what you did in the [log](../log/2244-11.md).

## Keying by hand

Step 5 in full. Do not start this without the other crew member awake and in the cupola.

### Before you key

#### At the panel

Set the mode switch to MANUAL and confirm the interlock lamp is out. If it is lit the chain is still live and keying by hand will back-feed the amplifier.

The interlock will not clear from the console. Hold <kbd>Alt</kbd> + <kbd>Break</kbd> on the panel keypad for three seconds, which is the only thing on this station that still needs a key combination.

#### At the reference clock

Take the time from the caesium reference, not from the console. The console clock is disciplined by the beacon, so during an outage it drifts with whatever you are about to send.

### Keying

Ten seconds on, fifty off, on the minute. Count with the reference, not in your head.

#### If you lose count

Stop. A gap is recoverable and a wrong pulse is not, because a ship that locks onto a wrong pulse steers on it for the next four hours.

##### Recovering the count

Wait for the next whole minute on the reference and start again from there. Note the gap in the log with the minute it started.

###### What the yard needs from you afterwards

The start minute, the gap length in whole seconds, and the reference serial. Nothing else. They will ask for the console log and it is the one thing that is worthless here.

## If none of that works

Call the yard, which is Harrow Yard Refit &amp; Overhaul on the paperwork and never on the radio. The duty desk is <duty@oriel-yard.example> and answers inside four hours on a working day, longer during a storm. The escalation form is at https://oriel-yard.example/forms/beacon-outage and wants the fault code from the table below. It will accept the code in the address instead, as \`?code=E12&station=WREN4\`, which saves a page. The pulse format it asks you to confirm is published at <https://oriel-yard.example/std/BCN-4.pdf>.

### The line to put in your shell profile

Fenced with tildes because the line itself is full of backticks, and a backtick fence would end halfway through it.

~~~sh
alias bstat='echo "\$(beaconctl status --once)" && echo "ref \`refclk --serial\`"'
~~~

## Fault codes

| Code | Meaning | What to do |
| :---: | :--- | :--- |
| \`B1\` | Bus undervoltage | Step 2 |
| \`B2\` | Amplifier over temperature | Let it cool 20 minutes, then step 1 |
| \`B3\` | Controller latch-up | Step 3. Suspect radiation if there is a storm. |
| \`B4\` | Backup cryocooler cold | Wait 40 minutes, or key by hand (step 5) |
| \`B5\` | Cat in the waveguide access port | Remove cat. Step 1. |

<!-- W.A., 2231: if anything ever comes out of the waveguide access port, read archive/2231/handover.md before you report it. -->

> [!CAUTION]
> Never key the beacon by hand for more than an hour alone. Timing drifts when you are tired, and ships steer by it.
`);

const noodles = [
  ['Dried noodles', 90, 'g'], ['Hydroponic greens', 1, 'handful'], ['Mushroom broth concentrate', 1, 'cube'], ['Soy sauce', 1, 'tbsp'],
  ['Water', 400, 'ml'], ['Chilli oil', 0.5, 'tsp'], ['Spring onion', 1, 'stalk'], ['Real egg, if the tender brought any', 1, ''],
];
put('noodles.md', `
# Station noodles

Served on the last night of every month, and on any night the tender is cancelled. They are better the next day, but there never are any left.

| Crew | ${[1, 2, 3, 4, 6].join(' | ')} |
| :--- | ${[1, 2, 3, 4, 6].map(() => '---:').join(' | ')} |
${noodles.map(([n, q, u]) => `| ${n} | ${[1, 2, 3, 4, 6].map((k) => `${round(q * k, 1)} ${u}`.trim()).join(' | ')} |`).join('\n')}

<p align="center"><img src="tour/galley.svg" alt="The galley, with the noodle stores" width="420"></p>

Everything below happens at that counter, in the pot on the left.

![Three seats, two crew, one cat](<tour/mess deck.svg> "Quill's seat is the one facing the hatch")

It is eaten at that table, which seats three and has never needed to.

## Method

1. Bring the water to the boil. At station pressure that is 94 °C, so add a minute to everything.
2. Dissolve the broth cube and the soy sauce.
3. Add the noodles, 4 minutes. Add the greens for the last minute.
4. Crack in the egg, if there is one, and stir once.
5. Chilli oil, spring onion, bowls with lids. Always lids. Remember what happened in 2239.

Time spent, by step:

\`\`\`mermaid
pie title Where the 12 minutes go
    "Waiting for the boil" : 5
    "Cooking" : 4
    "Finding the chilli oil" : 2
    "Arguing about the egg" : 1
\`\`\`

> Fresnel gets the broth left in the bowls. This is not negotiable.
`);

/* --------------------------------------------------------------- meeting -- */

// The morning after the outage. The site demo opens on this document, so it is
// the ordinary kind of page anyone would keep alongside their work, with the
// mystery left as one line in the parking lot.
{
  const byName = Object.fromEntries(stores.map(([item, unit, cap, onHand, reorder]) => [item, { unit, onHand, reorder }]));
  const storeRows = [
    ['Amplifier controller boards', 2, 'Order 2 with the hardened firmware'],
    ['Sensor-mast panes', 2, 'Order 1'],
    ['Coffee', 8, 'Order 12 kg. Not negotiable.'],
    ['Cat food', 30, 'Order 60 tins'],
  ].map(([item, before, action]) => {
    const s = byName[item];
    return `| ${item} | ${before} ${s.unit} | ${s.onHand} ${s.unit} | ${s.reorder} ${s.unit} | ${action} |`;
  });
  put('log/crew-meeting-2244-11-18.md', `
# Crew meeting, 18 November 2244

- **When:** 09:00 station time, in the galley
- **Attendees:** Ada Quill (chair), Tomas Bray, MOTH-3 (minutes)
- **Absent:** Fresnel, asleep on the console

## Agenda

1. The outage on the 17th
2. Stores after the storm
3. Tender schedule
4. Any other business

## 1. The outage on the 17th

Quill walked through the [incident report](incident-2244-11-17.md). The beacon was dark for 27 minutes. No ship came to harm, and the tanker *Ormond Drift* held station until we were back.

- Root cause agreed: a single-event upset latched the amplifier controller at the height of the storm.
- The backup chain should have covered it and did not, because its cryocooler had been left cold since the October service.
- Bray asked whether the controller could be hardened aboard. Quill: no, it needs boards from the yard.

> **Decision:** the backup cryocooler stays in warm standby from today, and the weekly test keys the backup at full power for 60 seconds.

## 2. Stores after the storm

| Item | Before the storm | Now | Reorder at | Action |
| :--- | ---: | ---: | ---: | :--- |
${storeRows.join('\n')}

Xenon and waveguide gaskets are also below their reorder levels and are already on the next tender. The full list is in [maintenance](../maintenance.md#stores).

![](../tour/stores.svg)

Bray put this on the screen rather than reading the list out.

## 3. Tender schedule

| Tender | Date | Carrying |
| :--- | :--- | :--- |
| Cancelled | 2244-11-16 | Nothing. Storm. |
| Next | 2244-12-05 | Controller boards, xenon, gaskets, the pane, coffee, cat food |
| After that | 2244-12-19 | Yard engineers for the fail-over watchdog |

## Decisions

1. Backup cryocooler in warm standby at all times.
2. Weekly test keys the backup at full power.
3. The station goes on storm routine whenever the forecast shows a CME within 48 hours.

## Action items

| # | Action | Owner | Due | Status |
| ---: | :--- | :--- | :--- | :--- |
| 1 | Put the backup cryocooler in warm standby | Bray | 2244-11-18 | ![done](../tour/pip-green.svg) Done |
| 2 | Add the full-power backup test to the weekly checklist | Quill | 2244-11-20 | ![open](../tour/pip-amber.svg) Open |
| 3 | Order hardened controller boards | Quill | 2244-11-21 | ![blocked](../tour/pip-red.svg) Blocked on the yard |
| 4 | Fit the replacement sensor-mast pane | Bray | 2244-11-21 | Open |
| 5 | Send the storm write-up to the forecast office | MOTH-3 | 2244-11-22 | Open |

- [x] Minutes circulated
- [ ] Incident report countersigned by the yard
- [ ] Next meeting booked

## Parking lot

- Bray raised the unexplained narrowband signal again. The receiver logged it at 02:19, while the beacon was dark. Quill said it is not on the agenda. Bray asked for it to be minuted anyway. Minuted. See [signals](../signals.md).

**Next meeting:** 2244-11-25, 09:00, galley.
`);
}

/* ----------------------------------------------------------------- rooms -- */

put('crew/fresnel.md', `
# Fresnel

![Fresnel in the cupola, with Vesna c behind her](fresnel.svg)

| | |
| :--- | :--- |
| Species | Cat, probably |
| Colour | Grey, with a white mark on her chest shaped like a Fresnel lens, hence the name |
| Weight | 3.9 kg |
| Arrived | 2240-03-14, 02:14 station time |
| Arrived how | Unknown. No ship docked between 2240-02-20 and 2240-04-02. |
| Found | Asleep in the waveguide access port, warm |
| On the manifest | No |

<figure><img src="../tour/waveguide.svg" alt="WG-2 access port, hatch open" width="420"><figcaption>WG-2. She came out of this at 02:14 with no ship docked.</figcaption></figure>

## Favourite places

| Place | How often | Notes |
| :--- | :--- | :--- |
| The cupola | Daily | Watches the trailing cluster. Only the trailing cluster. |
| Hydroponics | When there are moths | There should never be moths |
| The console | Always | See the [calibration schedule](../maintenance.md#calibration-schedule) |
| The waveguide access port | Every 26 days or so, for about a minute | Bray has timed it. See fault \`B5\` in the [runbook](../runbooks/beacon-silent.md#fault-codes). |

<details>
<summary>Vet notes, from the tender's medic, 2240-04-02</summary>

- Healthy adult female, about two years old.
- Microchipped. The chip reads \`0x5704\`, which is this station's ID. Nobody aboard chipped her.
- Lifetime radiation dose: zero. Anything that crossed the belt in the open would carry more than the crew does.
- Refused the medic's treats. Accepted Bray's.

</details>

The two she actually uses, in order:

<img src="../tour/bunk.svg" alt="The hub bunk" width="300" height="169"> <img src="../tour/airlock.svg" alt="The EVA hatch, with a suit beside it" width="300">

The bunk because it does not turn, and the hatch because the suit is warm.

[![The lens mark on her chest, close enough to read](<../tour/lens (detail).svg>)](fresnel.svg)

The mark on her chest is a lens, etched not printed. Nobody at the yard chips a cat with a lens.

## Rules

1. Do not feed her from the console.
2. Do not let her into the transmitter bay.
3. If she sits by the waveguide access port, let her. It is over in about a minute.
`);

const code = [...OUTBOUND].map((ch) => ch.charCodeAt(0) - 64);
put('archive/2231/handover.md', `
---
from: Wynn Achterberg, station chief 2219 to 2231
to: the next chief
date: 2231-05-02
sealed: true
opened: never
---

# Handover

Welcome to Wren-4. The station is in good order and most of what you need is in the runbooks. This note covers what is not.

## 1. State of the station

| System | State | Notes |
| :--- | :--- | :--- |
| Beacon, main chain | Good | Amplifier replaced 2229 |
| Beacon, backup chain | Good | Keep the cryocooler warm. Nobody ever does. |
| Life support | Good | Scrubber 3 whistles. It is fine. |
| Hydroponics | Fair | Tomatoes sulk after eclipse season |
| Hull | Good | 14 micrometeoroid pits resealed this year |

## 2. Quirks

* The waveguide access port is always warm, even in eclipse. I never found out why.
* If you find a moth, it did not come on the tender.
* The receiver logs a narrowband signal from the trailing cluster every 26.3 days. Section 3 explains it, as far as I can.

The three that will cost you time if nobody tells you, written out properly because the runbooks do not cover them:

+ _Scrubber 3._ It whistles above 60% load and the whistle is not the fault. The fault is the mount, which resonates. Shim it and you will lose a week finding out the whistle is still there.

+ _The hydroponics timer._ It is set to station time, which the beacon disciplines. During an outage it drifts with the beacon, so after any long silence the lights come on late and the tomatoes notice before you do.

+ _The tender's manifest._ It arrives as a printout and the printout is authoritative, whatever the file says. I lost an argument about this in 2224 and the yard has never revisited it.

___

Two things I was told on my own first day, which I pass on:

1) Never trust a reading you have not taken twice, and never take the second one the same way.
2) The station will outlast you. Write for whoever is here in forty years, ***not*** for the yard's next audit.

> The chief before me put it better:
>
> > You are not keeping a beacon lit. You are keeping a promise somebody made to people you will never meet.
>
> She was right, and I have never improved on it.

## 3. The reserved bits

In June 2229 I was alone for eclipse season, and I did something the specification forbids. The hazard byte has five reserved bits that every receiver ignores. I put letters in them: five bits a letter, A is 1, one letter a second, the same ten letters round and round.

| Letter | ${[...OUTBOUND].join(' | ')} |
| :--- | ${code.map(() => ':---:').join(' | ')} |
| Value | ${code.join(' | ')} |
| Hazard byte in a storm | ${[...OUTBOUND].map((ch) => hex(hazardByte(ch), 2)).join(' | ')} |

Nobody noticed, because nobody reads reserved bits. If you want to see it for yourself, the monitor will dump the byte on its own:

    beaconctl monitor --field hazard --raw

On 2230-08-02 at 02:14 station time, something answered. I had been running it for fourteen months by then and had stopped expecting anything, which is the only reason I can tell you exactly what I was doing when it came in, because it was nothing at all, and I have gone over that hour so many times since that it has worn smooth in the way a memory does when you handle it too often, and I can no longer swear to the parts that matter most.

| | |
| :--- | :--- |
| Frequency | 1,420.4058 MHz, just above the hydrogen line |
| Bandwidth | Under 1 Hz. Nothing natural is that narrow. |
| Duration | 70 seconds |
| Repeats | Every 26.3 days |
| Direction | The trailing cluster |

What settles it is the arithmetic, and the arithmetic has not moved in fifteen years. Against this receiver, in a one-hertz channel:

$$
N = k\\,T_\\text{sys}\\,B = -214.1\\ \\mathrm{dBW}
\\qquad (T_\\text{sys} = 28\\,\\mathrm{K}, B = 1\\,\\mathrm{Hz})
$$

$$
\\mathrm{SNR} = P_r - N = -157.0 - (-214.1) = 57.1\\ \\mathrm{dB}
$$

Noise does not arrive at fifty-seven decibels above the floor, on one bearing, every 26.3 days, for fifteen years.

I reported it once. The yard sent a psychologist and a month of leave, and I stopped reporting it.

I never learned to read them. They answer in counts, a number of pulses per burst. I tried the counts as letters and got nonsense, but I was never patient enough to add them up month by month. You may be.

In January 2230 a moth came out of the waveguide access port. I think it was practice.

If anything bigger ever comes out of that port, it is from them. Look after it. And look at it closely: I think they write on whatever they send.

The bits are still set. I could not bring myself to clear them. If you want to answer, change the word. They are listening.

## 4. Message queue

| Since | Bits 3 to 7 carry | Status |
| :--- | :--- | :--- |
| 2229-06-01 | \`${OUTBOUND}\` | Transmitting |
| | | |

- [x] Set the reserved bits
- [ ] Tell the next chief in person
- [ ] Find out what they want

Wynn Achterberg  
Station chief, 2229 to 2231\\
Forwarding address: the tender knows
`);

// Fresnel's portrait. The lens mark on her chest carries a message in type too
// small to read at normal size.
{
  const s = rng(2240314);
  const stars = Array.from({ length: 70 }, () => `<circle cx="${round(10 + s() * 300, 1)}" cy="${round(20 + s() * 300, 1)}" r="${round(0.4 + s() * 1.1, 2)}" fill="#e8ecf4" fill-opacity="${round(0.3 + s() * 0.7, 2)}"/>`).join('\n');
  const lines = ['WE HEARD YOU.', 'WE CANNOT CROSS', 'THE BELT. SHE CAN.', 'LOOK AFTER HER', 'AND SHE WILL', 'LOOK AFTER YOU.', 'ANSWER IN THE BITS.'];
  const message = lines.map((l, i) => `<text x="160" y="${round(214.5 + i * 3.4, 1)}" text-anchor="middle" font-size="2.3" letter-spacing="0.1" fill="#b9c0cb">${l}</text>`).join('\n');
  const portrait = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 340" width="320" height="340" font-family="ui-monospace, monospace">
<title>Fresnel</title>
<defs><clipPath id="port"><circle cx="160" cy="170" r="150"/></clipPath></defs>
<circle cx="160" cy="170" r="158" fill="#5b6270"/>
<circle cx="160" cy="170" r="150" fill="#12162a"/>
<g clip-path="url(#port)">
${stars}
<circle cx="40" cy="330" r="150" fill="#b98a5e"/>
<path d="M-110 300 Q40 250 190 300" stroke="#d9b184" stroke-width="12" fill="none"/>
<path d="M-110 335 Q40 285 190 335" stroke="#8f6644" stroke-width="9" fill="none"/>
<path d="M-110 365 Q40 315 190 365" stroke="#d9b184" stroke-width="7" fill="none"/>
<path d="M205 300 C 262 302, 276 248, 246 226" stroke="#7d8594" stroke-width="14" fill="none" stroke-linecap="round"/>
<path d="M108 330 C 98 250, 118 192, 160 186 C 202 192, 222 250, 212 330 Z" fill="#7d8594"/>
<ellipse cx="160" cy="226" rx="25" ry="31" fill="#f1f3f6"/>
<ellipse cx="160" cy="226" rx="20" ry="25" fill="none" stroke="#dde1e7" stroke-width="0.8"/>
<ellipse cx="160" cy="226" rx="14" ry="18" fill="none" stroke="#dde1e7" stroke-width="0.8"/>
<ellipse cx="160" cy="226" rx="8" ry="11" fill="none" stroke="#dde1e7" stroke-width="0.8"/>
${message}
<path d="M121 128 L115 80 L152 108 Z" fill="#7d8594"/>
<path d="M199 128 L205 80 L168 108 Z" fill="#7d8594"/>
<path d="M124 118 L121 92 L142 108 Z" fill="#c9959c"/>
<path d="M196 118 L199 92 L178 108 Z" fill="#c9959c"/>
<circle cx="160" cy="150" r="47" fill="#7d8594"/>
<ellipse cx="142" cy="146" rx="10" ry="12" fill="#c8d65a"/>
<ellipse cx="178" cy="146" rx="10" ry="12" fill="#c8d65a"/>
<ellipse cx="142" cy="146" rx="2.4" ry="10" fill="#12162a"/>
<ellipse cx="178" cy="146" rx="2.4" ry="10" fill="#12162a"/>
<circle cx="145" cy="141" r="1.8" fill="#fff"/>
<circle cx="181" cy="141" r="1.8" fill="#fff"/>
<path d="M155 164 L165 164 L160 170 Z" fill="#c9959c"/>
<path d="M160 170 Q154 177 148 174 M160 170 Q166 177 172 174" stroke="#4b515c" stroke-width="1.6" fill="none"/>
<path d="M146 168 L110 162 M146 171 L110 174 M174 168 L210 162 M174 171 L210 174" stroke="#dde1e7" stroke-width="1"/>
</g>
</svg>
`;
  mkdirSync(join(OUT, 'crew'), { recursive: true });
  writeFileSync(join(OUT, 'crew', 'fresnel.svg'), portrait);
}

// ---- Station tour: the pictures -------------------------------------------
//
// One illustration per module, drawn at a spread of shapes so the tour page can
// put the same picture machinery through every size and alignment: a panorama
// wider than any column, a mast taller than the window, a square galley, and
// pips small enough to sit inside a line of text. Two are filed under names
// that Markdown cannot write plainly, a space in one and parentheses in the
// other, because an address is part of the picture too.
{
  const TOUR = join(OUT, 'tour');
  mkdirSync(TOUR, { recursive: true });
  const s = rng(22441118);
  const stars = (w, h, n) =>
    Array.from(
      { length: n },
      () =>
        `<circle cx="${round(s() * w, 1)}" cy="${round(s() * h, 1)}" r="${round(0.4 + s() * 1.2, 2)}" fill="#e8ecf4" fill-opacity="${round(0.25 + s() * 0.65, 2)}"/>`
    ).join('\n');
  const pic = (w, h, title, body, stamp = true) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="ui-monospace, monospace">
<title>${title}</title>
<rect width="${w}" height="${h}" fill="#12162a"/>
${stars(w, h, Math.max(18, Math.round((w * h) / 3200)))}
${body}
${stamp ? `<text x="${round(w - w / 40, 1)}" y="${round(h - h / 26, 1)}" text-anchor="end" font-size="${round(Math.min(w, h) / 26, 1)}" fill="#5b6270">${w} x ${h}</text>` : ''}
</svg>
`;

  // Vesna c's limb, placed by the caller. The bands are clipped to the disc, and
  // the offsets are given as fractions of the radius so a picture that shows
  // only the top cap of the planet can put its banding where the cap is.
  const vesna = (id, cx, cy, r, offs = [0.34, 0.12, -0.12]) => `
<defs><clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="#b98a5e"/>
<g clip-path="url(#${id})">
${offs
  .map((o, i) => {
    const y = round(cy - r * o, 1);
    return `<path d="M${round(cx - r * 1.1, 1)} ${y} Q${cx} ${round(y - r * 0.1, 1)} ${round(cx + r * 1.1, 1)} ${y}" stroke="${i % 2 ? '#8f6644' : '#d9b184'}" stroke-width="${round(r / (18 + i * 7), 1)}" fill="none"/>`;
  })
  .join('\n')}
</g>`;

  // A solar wing: a framed panel ruled into cells.
  const wing = (x, y, w, h, cols) => {
    const cw = w / cols;
    const rules = Array.from(
      { length: cols - 1 },
      (_, i) => `<path d="M${round(x + cw * (i + 1), 1)} ${y} L${round(x + cw * (i + 1), 1)} ${y + h}" stroke="#5b6270" stroke-width="1"/>`
    ).join('');
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#243056" stroke="#7d8594" stroke-width="2"/>${rules}<path d="M${x} ${round(y + h / 2, 1)} L${x + w} ${round(y + h / 2, 1)}" stroke="#5b6270" stroke-width="1"/>`;
  };

  // 1600 x 360. The whole station on the approach lane. Wider than any column
  // the editor can give it, which is the point of having it.
  writeFileSync(
    join(TOUR, 'panorama.svg'),
    pic(
      1600,
      360,
      'Wren-4 from the approach lane',
      `${vesna('vesna-pano', 250, 600, 390, [0.9, 0.81, 0.72, 0.63])}
<g stroke-linecap="round">
${wing(560, 110, 170, 74, 6)}
${wing(560, 212, 170, 74, 6)}
<path d="M730 152 L790 190 M730 244 L790 206" stroke="#7d8594" stroke-width="4" fill="none"/>
<path d="M790 182 L1040 182 M790 214 L1040 214" stroke="#7d8594" stroke-width="5"/>
<path d="M790 182 L822 214 L854 182 L886 214 L918 182 L950 214 L982 182 L1014 214 L1040 196" stroke="#5b6270" stroke-width="3" fill="none"/>
<ellipse cx="900" cy="198" rx="96" ry="34" fill="none" stroke="#7d8594" stroke-width="11"/>
<ellipse cx="900" cy="198" rx="96" ry="34" fill="none" stroke="#9aa2b0" stroke-width="2"/>
<circle cx="832" cy="186" r="4" fill="#c8d65a"/><circle cx="868" cy="178" r="4" fill="#c8d65a"/><circle cx="932" cy="178" r="4" fill="#c8d65a"/><circle cx="968" cy="186" r="4" fill="#f0c56a"/>
<rect x="1040" y="168" width="120" height="56" rx="8" fill="#2b3350" stroke="#7d8594" stroke-width="3"/>
<path d="M1160 196 L1300 196" stroke="#7d8594" stroke-width="6"/>
<path d="M1160 196 L1196 176 L1232 216 L1268 176 L1300 196" stroke="#5b6270" stroke-width="2.5" fill="none"/>
<circle cx="1312" cy="196" r="13" fill="#c8d65a"/>
<circle cx="1312" cy="196" r="24" fill="none" stroke="#c8d65a" stroke-width="2" stroke-opacity="0.55"/>
<circle cx="1312" cy="196" r="38" fill="none" stroke="#c8d65a" stroke-width="1.5" stroke-opacity="0.28"/>
<path d="M1352 196 L1560 196" stroke="#c8d65a" stroke-width="1.5" stroke-opacity="0.35" stroke-dasharray="14 10"/>
</g>`
    )
  );

  // 800 x 600. The cupola from inside: the window is the picture.
  writeFileSync(
    join(TOUR, 'cupola.svg'),
    pic(
      800,
      600,
      'The cupola',
      `<defs><clipPath id="cup"><circle cx="400" cy="290" r="232"/></clipPath></defs>
<g clip-path="url(#cup)">
${stars(800, 600, 90)}
${vesna('vesna-cup', 210, 560, 300, [0.5, 0.34, 0.18, 0.02])}
<circle cx="640" cy="120" r="6" fill="#e8ecf4"/>
</g>
<circle cx="400" cy="290" r="246" fill="none" stroke="#5b6270" stroke-width="28"/>
<circle cx="400" cy="290" r="246" fill="none" stroke="#9aa2b0" stroke-width="3"/>
<circle cx="400" cy="290" r="232" fill="none" stroke="#7d8594" stroke-width="5"/>
<g stroke="#7d8594" stroke-width="7">
<path d="M400 58 L400 522"/><path d="M168 290 L632 290"/>
</g>
<circle cx="400" cy="290" r="118" fill="none" stroke="#7d8594" stroke-width="5"/>
<rect x="132" y="512" width="536" height="64" rx="10" fill="#1b2138" stroke="#5b6270" stroke-width="3"/>
<circle cx="184" cy="544" r="9" fill="#c8d65a"/><circle cx="220" cy="544" r="9" fill="#c8d65a"/><circle cx="256" cy="544" r="9" fill="#f0c56a"/>
<rect x="300" y="532" width="340" height="24" rx="5" fill="#12162a" stroke="#5b6270" stroke-width="2"/>
<text x="470" y="549" text-anchor="middle" font-size="14" fill="#9aa2b0">NAV LOCK 31.4 Mm</text>`
    )
  );

  // 280 x 760. The antenna mast, taller than the window it is read in.
  writeFileSync(
    join(TOUR, 'mast.svg'),
    pic(
      280,
      760,
      'The antenna mast',
      `<g stroke="#7d8594" stroke-width="5" fill="none" stroke-linecap="round">
<path d="M104 690 L104 150"/><path d="M176 690 L176 150"/>
</g>
<g stroke="#5b6270" stroke-width="3" fill="none">
${Array.from({ length: 12 }, (_, i) => {
  const y = 150 + i * 45;
  return `<path d="M104 ${y} L176 ${y + 45} M176 ${y} L104 ${y + 45} M104 ${y} L176 ${y}"/>`;
}).join('\n')}
</g>
<g stroke="#5b6270" stroke-width="2" stroke-dasharray="6 5">
<path d="M104 300 L30 700"/><path d="M176 300 L250 700"/>
</g>
<path d="M140 150 L140 96" stroke="#7d8594" stroke-width="7"/>
<circle cx="140" cy="80" r="17" fill="#c8d65a"/>
<circle cx="140" cy="80" r="31" fill="none" stroke="#c8d65a" stroke-width="2.5" stroke-opacity="0.5"/>
<circle cx="140" cy="80" r="48" fill="none" stroke="#c8d65a" stroke-width="2" stroke-opacity="0.25"/>
<path d="M96 210 A 60 60 0 0 1 184 210" fill="none" stroke="#9aa2b0" stroke-width="4"/>
<rect x="44" y="690" width="192" height="30" rx="6" fill="#2b3350" stroke="#7d8594" stroke-width="3"/>
<text x="140" y="742" text-anchor="middle" font-size="17" fill="#9aa2b0">MAST 1</text>`
    )
  );

  // 560 x 560. Square, and the one warm room aboard.
  writeFileSync(
    join(TOUR, 'galley.svg'),
    pic(
      560,
      560,
      'The galley',
      `<rect x="40" y="40" width="480" height="480" rx="14" fill="#1b2138" stroke="#5b6270" stroke-width="3"/>
<g stroke="#5b6270" stroke-width="3" fill="none">
<path d="M70 168 L490 168"/><path d="M70 252 L490 252"/>
</g>
<g fill="#7d8594">
<rect x="92" y="122" width="34" height="42" rx="4"/><rect x="140" y="132" width="26" height="32" rx="4"/>
<rect x="182" y="116" width="40" height="48" rx="4"/><rect x="240" y="136" width="24" height="28" rx="4"/>
<rect x="96" y="212" width="30" height="38" rx="4"/><rect x="142" y="206" width="36" height="44" rx="4"/>
</g>
<rect x="300" y="196" width="190" height="56" rx="6" fill="#243056" stroke="#7d8594" stroke-width="2"/>
<text x="395" y="231" text-anchor="middle" font-size="20" fill="#c8d65a">NOODLES</text>
<rect x="70" y="330" width="420" height="20" rx="4" fill="#9aa2b0"/>
<rect x="70" y="350" width="420" height="132" fill="#243056" stroke="#5b6270" stroke-width="2"/>
<circle cx="160" cy="416" r="34" fill="none" stroke="#7d8594" stroke-width="5"/>
<circle cx="160" cy="416" r="20" fill="#2b3350"/>
<path d="M300 330 L300 300 Q300 288 314 288 L366 288 Q380 288 380 300 L380 330 Z" fill="#7d8594"/>
<path d="M332 286 Q326 268 340 256 M356 286 Q350 268 364 256" stroke="#9aa2b0" stroke-width="3" fill="none" stroke-linecap="round"/>
<rect x="404" y="286" width="46" height="44" rx="5" fill="#c9959c"/>
<path d="M450 296 Q470 308 450 320" stroke="#c9959c" stroke-width="6" fill="none"/>`
    )
  );

  // 900 x 480. The hab ring, seen from the truss.
  writeFileSync(
    join(TOUR, 'hab.svg'),
    pic(
      900,
      480,
      'The hab ring',
      `<ellipse cx="450" cy="250" rx="330" ry="150" fill="none" stroke="#5b6270" stroke-width="56"/>
<ellipse cx="450" cy="250" rx="330" ry="150" fill="none" stroke="#7d8594" stroke-width="44"/>
<ellipse cx="450" cy="250" rx="330" ry="150" fill="none" stroke="#9aa2b0" stroke-width="2"/>
<g fill="#c8d65a">
${Array.from({ length: 14 }, (_, i) => {
  const a = (i / 14) * Math.PI * 2;
  const x = round(450 + Math.cos(a) * 330, 1);
  const y = round(250 + Math.sin(a) * 150, 1);
  return `<rect x="${round(x - 9, 1)}" y="${round(y - 7, 1)}" width="18" height="14" rx="3" fill="${i % 5 === 3 ? '#2b3350' : '#c8d65a'}"/>`;
}).join('\n')}
</g>
<g stroke="#7d8594" stroke-width="7">
<path d="M450 250 L450 100"/><path d="M450 250 L780 250"/><path d="M450 250 L120 250"/><path d="M450 250 L450 400"/>
</g>
<circle cx="450" cy="250" r="54" fill="#2b3350" stroke="#9aa2b0" stroke-width="4"/>
<circle cx="450" cy="250" r="26" fill="#12162a" stroke="#5b6270" stroke-width="3"/>
<text x="450" y="257" text-anchor="middle" font-size="16" fill="#9aa2b0">HUB</text>`
    )
  );

  // 520 x 380. The port a cat came out of in 2230.
  writeFileSync(
    join(TOUR, 'waveguide.svg'),
    pic(
      520,
      380,
      'Waveguide access port',
      `<rect x="30" y="30" width="460" height="320" rx="10" fill="#1b2138" stroke="#5b6270" stroke-width="3"/>
<g stroke="#5b6270" stroke-width="2" fill="none">
<path d="M30 110 L490 110"/><path d="M30 270 L490 270"/>
</g>
<circle cx="260" cy="190" r="112" fill="#2b3350" stroke="#7d8594" stroke-width="12"/>
<circle cx="260" cy="190" r="112" fill="none" stroke="#9aa2b0" stroke-width="2"/>
<circle cx="260" cy="190" r="86" fill="#12162a"/>
<g fill="#9aa2b0">
${Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2 + 0.39;
  return `<circle cx="${round(260 + Math.cos(a) * 100, 1)}" cy="${round(190 + Math.sin(a) * 100, 1)}" r="6"/>`;
}).join('')}
</g>
<path d="M260 190 m-86 0 a86 86 0 0 1 172 0" fill="none" stroke="#5b6270" stroke-width="3"/>
<path d="M382 190 L446 148 L446 232 Z" fill="#7d8594"/>
<circle cx="244" cy="206" r="2.6" fill="#c8d65a"/><circle cx="276" cy="206" r="2.6" fill="#c8d65a"/>
<text x="260" y="332" text-anchor="middle" font-size="18" fill="#9aa2b0">WG-2 ACCESS</text>`
    )
  );

  // 420 x 440. MOTH-3, six legs and one opinion.
  writeFileSync(
    join(TOUR, 'moth.svg'),
    pic(
      420,
      440,
      'MOTH-3',
      `<g stroke="#7d8594" stroke-width="9" fill="none" stroke-linecap="round">
<path d="M150 230 L84 268 L60 344"/><path d="M150 262 L74 310 L86 380"/><path d="M158 292 L96 350 L126 404"/>
<path d="M270 230 L336 268 L360 344"/><path d="M270 262 L346 310 L334 380"/><path d="M262 292 L324 350 L294 404"/>
</g>
<ellipse cx="210" cy="248" rx="86" ry="72" fill="#5b6270" stroke="#9aa2b0" stroke-width="3"/>
<ellipse cx="210" cy="232" rx="62" ry="46" fill="#2b3350"/>
<circle cx="210" cy="228" r="30" fill="#12162a" stroke="#9aa2b0" stroke-width="3"/>
<circle cx="210" cy="228" r="17" fill="#c8d65a"/>
<circle cx="203" cy="221" r="6" fill="#e8ecf4" fill-opacity="0.85"/>
<path d="M164 160 Q150 108 180 78" stroke="#7d8594" stroke-width="6" fill="none" stroke-linecap="round"/>
<path d="M256 160 Q270 108 240 78" stroke="#7d8594" stroke-width="6" fill="none" stroke-linecap="round"/>
<circle cx="180" cy="74" r="7" fill="#c9959c"/><circle cx="240" cy="74" r="7" fill="#c9959c"/>
<rect x="176" y="296" width="68" height="20" rx="5" fill="#12162a" stroke="#7d8594" stroke-width="2"/>
<text x="210" y="311" text-anchor="middle" font-size="13" fill="#c8d65a">MOTH-3</text>`
    )
  );

  // 640 x 300. The battery bay, the thing that kept the beacon lit.
  writeFileSync(
    join(TOUR, 'power.svg'),
    pic(
      640,
      300,
      'Battery bay',
      `<rect x="26" y="34" width="588" height="232" rx="10" fill="#1b2138" stroke="#5b6270" stroke-width="3"/>
${Array.from({ length: 6 }, (_, i) => {
  const x = 52 + i * 94;
  const fill = [88, 94, 71, 96, 39, 92][i];
  const h = round((fill / 100) * 140, 1);
  const col = fill < 50 ? '#f0c56a' : '#c8d65a';
  return `<rect x="${x}" y="${68}" width="66" height="140" rx="5" fill="#12162a" stroke="#7d8594" stroke-width="2.5"/>
<rect x="${x + 4}" y="${round(68 + 140 - h + 4, 1)}" width="58" height="${round(h - 8, 1)}" rx="3" fill="${col}" fill-opacity="0.8"/>
<rect x="${x + 24}" y="60" width="18" height="10" rx="2" fill="#9aa2b0"/>
<text x="${x + 33}" y="${232}" text-anchor="middle" font-size="15" fill="#9aa2b0">${fill}%</text>`;
}).join('\n')}
<text x="320" y="258" text-anchor="middle" font-size="15" fill="#5b6270">BUS A, SIX CELLS</text>`
    )
  );

  // 600 x 400, filed under a name with a space in it, so the tour has a reason
  // to write an address in the angle brackets CommonMark keeps for the purpose.
  writeFileSync(
    join(TOUR, 'mess deck.svg'),
    pic(
      600,
      400,
      'The mess deck',
      `<rect x="30" y="30" width="540" height="340" rx="12" fill="#1b2138" stroke="#5b6270" stroke-width="3"/>
<ellipse cx="300" cy="238" rx="180" ry="62" fill="#5b6270" stroke="#9aa2b0" stroke-width="3"/>
<ellipse cx="300" cy="230" rx="180" ry="62" fill="#7d8594"/>
<path d="M300 292 L300 336" stroke="#5b6270" stroke-width="16"/>
<ellipse cx="300" cy="340" rx="66" ry="18" fill="#5b6270"/>
<g fill="#2b3350" stroke="#9aa2b0" stroke-width="2.5">
<ellipse cx="96" cy="212" rx="34" ry="24"/><ellipse cx="504" cy="212" rx="34" ry="24"/>
<ellipse cx="300" cy="158" rx="34" ry="22"/>
</g>
<circle cx="238" cy="222" r="22" fill="#12162a" stroke="#9aa2b0" stroke-width="2.5"/>
<circle cx="238" cy="222" r="13" fill="#c9959c"/>
<rect x="318" y="206" width="44" height="30" rx="4" fill="#243056" stroke="#9aa2b0" stroke-width="2"/>
<path d="M362 214 Q378 221 362 228" stroke="#9aa2b0" stroke-width="4" fill="none"/>
<text x="300" y="376" text-anchor="middle" font-size="16" fill="#5b6270">THREE SEATS, TWO CREW, ONE CAT</text>`
    )
  );

  // 400 x 400, filed under a name with parentheses, which Markdown reads as one
  // address only when they balance. The lens mark, close.
  writeFileSync(
    join(TOUR, 'lens (detail).svg'),
    pic(
      400,
      400,
      'The lens mark, close',
      `<circle cx="200" cy="196" r="150" fill="#7d8594"/>
<ellipse cx="200" cy="196" rx="112" ry="132" fill="#f1f3f6"/>
<ellipse cx="200" cy="196" rx="90" ry="108" fill="none" stroke="#dde1e7" stroke-width="3"/>
<ellipse cx="200" cy="196" rx="64" ry="78" fill="none" stroke="#dde1e7" stroke-width="3"/>
<ellipse cx="200" cy="196" rx="38" ry="48" fill="none" stroke="#dde1e7" stroke-width="3"/>
<ellipse cx="200" cy="196" rx="14" ry="19" fill="none" stroke="#dde1e7" stroke-width="3"/>
<g fill="#8b929e" font-size="9" text-anchor="middle" letter-spacing="0.4">
<text x="200" y="152">WE HEARD YOU.</text>
<text x="200" y="168">WE CANNOT CROSS</text>
<text x="200" y="184">THE BELT. SHE CAN.</text>
<text x="200" y="200">LOOK AFTER HER</text>
<text x="200" y="216">AND SHE WILL</text>
<text x="200" y="232">LOOK AFTER YOU.</text>
<text x="200" y="248">ANSWER IN THE BITS.</text>
</g>
<text x="200" y="378" text-anchor="middle" font-size="15" fill="#5b6270">400 x 400</text>`,
      false
    )
  );

  // 640 x 360. The one part of the ring that does not turn.
  writeFileSync(
    join(TOUR, 'bunk.svg'),
    pic(
      640,
      360,
      'The hub bunk',
      `<rect x="28" y="28" width="584" height="304" rx="14" fill="#1b2138" stroke="#5b6270" stroke-width="3"/>
<path d="M58 300 Q58 120 200 110 L440 110 Q582 120 582 300 Z" fill="#243056" stroke="#7d8594" stroke-width="3"/>
<rect x="92" y="196" width="456" height="104" rx="18" fill="#5b6270"/>
<rect x="104" y="186" width="432" height="96" rx="16" fill="#7d8594"/>
<path d="M132 210 L508 210 M132 238 L508 238 M132 266 L508 266" stroke="#5b6270" stroke-width="2"/>
<rect x="140" y="168" width="120" height="30" rx="8" fill="#c9959c"/>
<circle cx="520" cy="140" r="16" fill="#f0c56a"/>
<path d="M520 156 L520 186" stroke="#7d8594" stroke-width="4"/>
<rect x="86" y="118" width="86" height="54" rx="5" fill="#12162a" stroke="#9aa2b0" stroke-width="2"/>
<circle cx="129" cy="145" r="15" fill="#b98a5e"/>
<text x="320" y="330" text-anchor="middle" font-size="15" fill="#5b6270">HUB BUNK, NO SPIN</text>`
    )
  );

  // 560 x 560. Aimed at the trailing cluster since before anyone aboard arrived.
  writeFileSync(
    join(TOUR, 'dish.svg'),
    pic(
      560,
      560,
      'The receiver dish',
      `<g transform="translate(280,300)">
<ellipse cx="0" cy="0" rx="200" ry="92" fill="#5b6270" stroke="#9aa2b0" stroke-width="3"/>
<ellipse cx="0" cy="-14" rx="200" ry="92" fill="#7d8594"/>
<ellipse cx="0" cy="-14" rx="150" ry="68" fill="none" stroke="#5b6270" stroke-width="2"/>
<ellipse cx="0" cy="-14" rx="96" ry="44" fill="none" stroke="#5b6270" stroke-width="2"/>
<ellipse cx="0" cy="-14" rx="44" ry="20" fill="none" stroke="#5b6270" stroke-width="2"/>
<path d="M-70 -46 L0 -150 L70 -46" stroke="#9aa2b0" stroke-width="5" fill="none"/>
<rect x="-22" y="-176" width="44" height="30" rx="6" fill="#2b3350" stroke="#c8d65a" stroke-width="3"/>
<path d="M0 60 L0 150" stroke="#7d8594" stroke-width="14"/>
<rect x="-70" y="150" width="140" height="26" rx="6" fill="#5b6270"/>
</g>
<g stroke="#c8d65a" stroke-width="1.6" stroke-opacity="0.4" stroke-dasharray="12 9">
<path d="M280 124 L280 40"/><path d="M240 132 L196 52"/><path d="M320 132 L364 52"/>
</g>
<g fill="#e8ecf4">
<circle cx="392" cy="70" r="3.4"/><circle cx="416" cy="52" r="2.6"/><circle cx="436" cy="78" r="3"/>
<circle cx="410" cy="92" r="2.2"/><circle cx="432" cy="46" r="2"/>
</g>
<text x="432" y="118" text-anchor="middle" font-size="14" fill="#5b6270">TRAILING CLUSTER</text>`
    )
  );

  // 420 x 560. The hatch nobody uses alone.
  writeFileSync(
    join(TOUR, 'airlock.svg'),
    pic(
      420,
      560,
      'The EVA hatch',
      `<rect x="26" y="26" width="368" height="504" rx="12" fill="#1b2138" stroke="#5b6270" stroke-width="3"/>
<path d="M60 490 L60 190 Q60 88 170 88 Q280 88 280 190 L280 490 Z" fill="#2b3350" stroke="#7d8594" stroke-width="10"/>
<path d="M60 490 L60 190 Q60 88 170 88 Q280 88 280 190 L280 490 Z" fill="none" stroke="#9aa2b0" stroke-width="2"/>
<circle cx="170" cy="300" r="56" fill="none" stroke="#9aa2b0" stroke-width="9"/>
<g stroke="#9aa2b0" stroke-width="9" stroke-linecap="round">
<path d="M170 244 L170 356"/><path d="M114 300 L226 300"/>
<path d="M130 260 L210 340"/><path d="M210 260 L130 340"/>
</g>
<circle cx="170" cy="300" r="17" fill="#5b6270" stroke="#dde1e7" stroke-width="3"/>
<g fill="#9aa2b0">
<circle cx="86" cy="150" r="6"/><circle cx="254" cy="150" r="6"/>
<circle cx="80" cy="330" r="6"/><circle cx="260" cy="330" r="6"/>
<circle cx="86" cy="466" r="6"/><circle cx="254" cy="466" r="6"/>
</g>
<path d="M330 180 Q356 176 356 210 L356 330 Q356 350 340 350 L320 350 Q304 350 304 330 L304 210 Q304 176 330 180 Z" fill="#dde1e7"/>
<circle cx="330" cy="158" r="26" fill="#f1f3f6" stroke="#9aa2b0" stroke-width="3"/>
<path d="M314 152 A18 18 0 0 1 348 152 L348 164 L314 164 Z" fill="#2b3350"/>
<rect x="312" y="350" width="36" height="86" rx="8" fill="#c9d0da"/>
<text x="210" y="524" text-anchor="middle" font-size="16" fill="#5b6270">EVA 1, TWO CREW RULE</text>`
    )
  );

  // 700 x 400. Where the good multimeter lives.
  writeFileSync(
    join(TOUR, 'bench.svg'),
    pic(
      700,
      400,
      'The workbench',
      `<rect x="30" y="30" width="640" height="340" rx="12" fill="#1b2138" stroke="#5b6270" stroke-width="3"/>
<rect x="60" y="250" width="580" height="22" fill="#9aa2b0"/>
<rect x="60" y="272" width="580" height="80" fill="#243056" stroke="#5b6270" stroke-width="2"/>
<path d="M60 96 L640 96 M60 170 L640 170" stroke="#5b6270" stroke-width="3"/>
<g fill="#7d8594">
<rect x="86" y="56" width="16" height="40" rx="3"/><rect x="112" y="64" width="12" height="32" rx="3"/>
<rect x="136" y="50" width="20" height="46" rx="3"/><rect x="168" y="68" width="10" height="28" rx="3"/>
<rect x="192" y="60" width="14" height="36" rx="3"/>
<rect x="90" y="132" width="26" height="38" rx="3"/><rect x="128" y="140" width="18" height="30" rx="3"/>
</g>
<rect x="420" y="112" width="180" height="58" rx="6" fill="#2b3350" stroke="#c8d65a" stroke-width="3"/>
<rect x="436" y="124" width="148" height="26" rx="3" fill="#12162a"/>
<text x="510" y="144" text-anchor="middle" font-size="17" fill="#c8d65a">1.4204</text>
<text x="510" y="164" text-anchor="middle" font-size="11" fill="#9aa2b0">THE GOOD ONE</text>
<rect x="250" y="196" width="130" height="54" rx="6" fill="#5b6270" stroke="#9aa2b0" stroke-width="2"/>
<rect x="276" y="176" width="78" height="26" rx="4" fill="#7d8594"/>
<path d="M250 224 L200 224 M380 224 L430 224" stroke="#9aa2b0" stroke-width="6"/>
<circle cx="180" cy="224" r="16" fill="none" stroke="#c9959c" stroke-width="5"/>
<text x="350" y="336" text-anchor="middle" font-size="15" fill="#5b6270">BENCH 2, PORT SIDE</text>`
    )
  );

  // 480 x 420. The locker the yard has not restocked.
  writeFileSync(
    join(TOUR, 'stores.svg'),
    pic(
      480,
      420,
      'The stores locker',
      `<rect x="30" y="30" width="420" height="360" rx="12" fill="#1b2138" stroke="#5b6270" stroke-width="3"/>
${[0, 1, 2].map((row) =>
  [0, 1, 2].map((col) => {
    const x = 64 + col * 122;
    const y = 66 + row * 106;
    const empty = row === 2 && col === 1;
    return `<rect x="${x}" y="${y}" width="104" height="82" rx="7" fill="${empty ? '#12162a' : '#2b3350'}" stroke="${empty ? '#c9959c' : '#7d8594'}" stroke-width="${empty ? 3 : 2.5}"/>
<rect x="${x + 22}" y="${y + 60}" width="60" height="12" rx="3" fill="${empty ? '#c9959c' : '#9aa2b0'}"/>
${empty ? '' : `<rect x="${x + 16}" y="${y + 16}" width="72" height="34" rx="4" fill="#5b6270"/>`}`;
  }).join('\n')
).join('\n')}
<text x="240" y="376" text-anchor="middle" font-size="15" fill="#5b6270">BIN 8 EMPTY SINCE THE 17TH</text>`
    )
  );

  // 520 x 420. Forty minutes from standby to cold, which is the whole story.
  writeFileSync(
    join(TOUR, 'cryo.svg'),
    pic(
      520,
      420,
      'The backup cryocooler',
      `<rect x="28" y="28" width="464" height="364" rx="12" fill="#1b2138" stroke="#5b6270" stroke-width="3"/>
<rect x="150" y="96" width="140" height="210" rx="16" fill="#5b6270" stroke="#9aa2b0" stroke-width="3"/>
<rect x="150" y="96" width="140" height="210" rx="16" fill="none" stroke="#7d8594" stroke-width="10"/>
${Array.from({ length: 7 }, (_, i) => `<rect x="${134}" y="${118 + i * 26}" width="172" height="9" rx="4" fill="#7d8594"/>`).join('\n')}
<ellipse cx="220" cy="96" rx="70" ry="16" fill="#9aa2b0"/>
<path d="M220 306 L220 346" stroke="#7d8594" stroke-width="12"/>
<rect x="160" y="346" width="120" height="22" rx="5" fill="#5b6270"/>
<circle cx="388" cy="176" r="52" fill="#12162a" stroke="#9aa2b0" stroke-width="4"/>
<path d="M388 176 L360 142" stroke="#c9959c" stroke-width="5" stroke-linecap="round"/>
<circle cx="388" cy="176" r="5" fill="#dde1e7"/>
<text x="388" y="214" text-anchor="middle" font-size="13" fill="#c9959c">+18 K</text>
<text x="388" y="240" text-anchor="middle" font-size="11" fill="#5b6270">WARM</text>
<g stroke="#dde1e7" stroke-opacity="0.55" stroke-width="2" stroke-linecap="round">
<path d="M126 132 L110 122 M126 184 L108 180 M126 236 L110 244"/>
</g>
<text x="260" y="396" text-anchor="middle" font-size="15" fill="#5b6270">40 MINUTES TO COLD</text>`
    )
  );

  // 96 x 96. The station badge, small enough to read inside a line of text.
  writeFileSync(
    join(TOUR, 'badge.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" font-family="ui-monospace, monospace">
<title>Wren-4</title>
<path d="M48 4 L86 26 L86 70 L48 92 L10 70 L10 26 Z" fill="#12162a" stroke="#c8d65a" stroke-width="5"/>
<path d="M48 16 L76 32 L76 64 L48 80 L20 64 L20 32 Z" fill="none" stroke="#5b6270" stroke-width="2"/>
<circle cx="48" cy="48" r="11" fill="#c8d65a"/>
<circle cx="48" cy="48" r="20" fill="none" stroke="#c8d65a" stroke-width="2" stroke-opacity="0.5"/>
<circle cx="48" cy="48" r="29" fill="none" stroke="#c8d65a" stroke-width="1.5" stroke-opacity="0.25"/>
</svg>
`
  );

  // 28 x 28 each. Status pips, for reading inside a sentence or a table cell.
  for (const [name, colour] of [
    ['pip-green', '#c8d65a'],
    ['pip-amber', '#f0c56a'],
    ['pip-red', '#c9959c'],
  ]) {
    writeFileSync(
      join(TOUR, `${name}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
<title>${name}</title>
<circle cx="14" cy="14" r="12" fill="#12162a" stroke="#5b6270" stroke-width="2"/>
<circle cx="14" cy="14" r="7" fill="${colour}"/>
</svg>
`
    );
  }
}

for (const [name, text] of Object.entries(files)) {
  const p = join(OUT, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  console.log(`sample/wren-4/${name.padEnd(28)} ${String(text.split("\n").length).padStart(4)} lines`);
}
