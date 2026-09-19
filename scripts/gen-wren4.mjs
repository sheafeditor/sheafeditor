#!/usr/bin/env node
/**
 * Generates sample/wren-4/: the repository of Wren-4, a fictional deep-space
 * navigation beacon. It is a themed corpus for demos and screenshots, built
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

The working repository for Wren-4, a fictional two-crew navigation beacon at the trailing Lagrange point of the gas giant Vesna c. Ships crossing the Oriel Belt steer by its pulse. Everything the station records lives here as Markdown: the log, the space weather, the eclipse schedule, the traffic, the signals and the noodles.

> [!IMPORTANT]
> **A note from Bray, for whoever reads this next.**
>
> Every 26 days since 2230, something out in the trailing cluster has sent this station a signal. Nobody knows what it is. Quill calls it instrument noise and has asked me to stop talking about it, so I am writing it down instead.
>
> If you want to find out, start with the *Unexplained narrowband* row on the [signals page](signals.md#detections). There is more hidden around this station than the documents table admits.

![Solar wind speed through November](charts/solar-wind-november.svg)

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

| Name | Role | Aboard since | Notes |
| :--- | :--- | :---: | :--- |
| Ada Quill | Station chief | 2231 | Writes the log. Owns the good multimeter. |
| Tomas Bray | Systems technician | 2242 | Recalibrates the antenna more than it needs. |
| MOTH-3 | Maintenance drone | 2238 | Six legs, one opinion, several spare parts. |
| [Fresnel](crew/fresnel.md) | Cat | 2240 | Not on the manifest. Has never missed a watch. |

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

- [x] Log countersigned by the inspector on ${DATE(12)}
- [x] Incident report filed for ${DATE(STORM)}
- [ ] Order a spare sensor-mast pane before the next storm
- [ ] Ask the tender for more oranges

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

## Last frames before the silence

The transmitter monitor keeps the last ten frames it sent. The fields are those of the [pulse format](../beacon.md#pulse-format): sync word, station ID, epoch, sub-second, hazard flags, CRC.

\`\`\`text
${frames.join('\n')}
\`\`\`

During a storm with a blackout forecast the hazard byte should read \`06\`. Bray has pointed out, more than once, that it does not. Quill puts it down to radiation damage in the capture buffer. Every CRC checks.

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

## Regulars

| Ship | Class | From | To | Remarks |
| :--- | :--- | :--- | :--- | :--- |
${regulars.map((x) => `| ${x.join(' | ')} |`).join('\n')}
`);

const months = monthly.map((x) => x.m);
const heat = (v, max) => (v === 0 ? '·' : ' ░▒▓█'[Math.min(4, 1 + Math.floor((v / max) * 4))]);
put('signals.md', `
# Signals

Between pulses the beacon's dish listens. The receiver logs every detection above five sigma, sorted into bands. Most of it is molecules in the belt's gas and the planet's aurora. Some of it is the station hearing itself. One band we cannot explain.

![Signal detections as a heat map](charts/signals-heatmap.svg)

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

## Steps

1. Check the amplifier is powered. The bay fans are audible from the hatch.
2. If it is silent, check the bus panel:
   - Bus above 110 V: reset breaker **P7**.
   - Bus below 110 V: shed the hydroponics lights, then check again.
3. Watch for the controller heartbeat LED. If it is dark for more than 5 seconds, power-cycle the controller.
4. If phase lock will not go green, switch to the backup chain:
   \`\`\`sh
   beaconctl chain --select backup --confirm
   beaconctl status --watch
   \`\`\`
5. If the backup will not key either, key the beacon by hand from the manual panel and keep time from the reference clock. Wake the other crew member.
6. Write what you did in the [log](../log/2244-11.md).

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
// the ordinary kind of page most people keep in a repo, with the mystery left
// as one line in the parking lot.
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
| 1 | Put the backup cryocooler in warm standby | Bray | 2244-11-18 | Done |
| 2 | Add the full-power backup test to the weekly checklist | Quill | 2244-11-20 | Open |
| 3 | Order hardened controller boards | Quill | 2244-11-21 | Open |
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

- The waveguide access port is always warm, even in eclipse. I never found out why.
- If you find a moth, it did not come on the tender.
- The receiver logs a narrowband signal from the trailing cluster every 26.3 days. Section 3 explains it, as far as I can.

## 3. The reserved bits

In June 2229 I was alone for eclipse season, and I did something the specification forbids. The hazard byte has five reserved bits that every receiver ignores. I put letters in them: five bits a letter, A is 1, one letter a second, the same ten letters round and round.

| Letter | ${[...OUTBOUND].join(' | ')} |
| :--- | ${code.map(() => ':---:').join(' | ')} |
| Value | ${code.join(' | ')} |
| Hazard byte in a storm | ${[...OUTBOUND].map((ch) => hex(hazardByte(ch), 2)).join(' | ')} |

Nobody noticed, because nobody reads reserved bits. On 2230-08-02 at 02:14 station time, something answered.

| | |
| :--- | :--- |
| Frequency | 1,420.4058 MHz, just above the hydrogen line |
| Bandwidth | Under 1 Hz. Nothing natural is that narrow. |
| Duration | 70 seconds |
| Repeats | Every 26.3 days |
| Direction | The trailing cluster |

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

Wynn
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

for (const [name, text] of Object.entries(files)) {
  const p = join(OUT, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  console.log(`sample/wren-4/${name.padEnd(28)} ${String(text.split("\n").length).padStart(4)} lines`);
}
