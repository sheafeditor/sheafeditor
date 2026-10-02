// What colour a callout is actually painted, in three themes, against the colour it claims to take.
//
// `render.alert` R4: "Take every colour from the editor's theme, so a callout is legible in light,
// dark and high-contrast themes." One case covers it today, which checks that five labels differ
// from the body text and names no theme.
//
// `docs/features/callouts.md` promises more than R4 does, and the stronger clause is the one worth
// checking: callouts "stay legible when you switch between light, dark and high-contrast themes,
// **and they match the colours the rest of your editor uses for information, warnings and
// errors**". Not merely legible: the Note colour is the host's *information* colour.
//
// That second clause cannot be covered by a sample, and it does not need to be, because the
// stylesheet declares the mapping and the host declares the value. So this derives both and
// compares, which is the only technique that can settle a claim about matching rather than a
// claim about working: a sample can show a callout drawn, and only a derivation can show it
// drawn in the colour its stylesheet asked the host for.
//
//   --md-alert for Note       var(--vscode-editorInfo-foreground, var(--vscode-charts-blue, var(--md-link)))
//   Tip                       var(--vscode-charts-green, ...)
//   Important                 var(--vscode-charts-purple, ...)
//   Warning                   var(--vscode-editorWarning-foreground, ...)
//   Caution                   var(--vscode-editorError-foreground, ...)
//
// **The fallback chain is what makes the existing case weak.** A theme that does not define
// `--vscode-editorInfo-foreground` silently gives Note `--md-link` instead, which is a different
// blue. It still differs from the body text, so the case passes, and the page's promise is false:
// the callout is no longer the editor's information colour. Reading the variable the stylesheet
// names is the only way to tell those two apart.
//   node test/real-editor/run-editor.mjs callout-themes [id]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

const THEMES = [
  ['Default Light Modern', 'light'],
  ['Default Dark Modern', 'dark'],
  ['Default High Contrast', 'high contrast'],
];

/*
 * Each callout, the class it carries, and the host variable the stylesheet says its colour comes
 * from, first in the chain. Copied from `media/webview.css` so the check reads what the product
 * declares rather than what somebody remembered.
 */
const CALLOUTS = [
  ['NOTE', 'tok-alert-note', '--vscode-editorInfo-foreground'],
  ['TIP', 'tok-alert-tip', '--vscode-charts-green'],
  ['IMPORTANT', 'tok-alert-important', '--vscode-charts-purple'],
  ['WARNING', 'tok-alert-warning', '--vscode-editorWarning-foreground'],
  ['CAUTION', 'tok-alert-caution', '--vscode-editorError-foreground'],
];

const DOC = `# Callouts

${CALLOUTS.map(([kind]) => `> [!${kind}]\n> A ${kind.toLowerCase()} callout, with a sentence in it.\n`).join('\n')}
A paragraph after them.
`;

/** Put a theme on through the profile, which VS Code watches. */
async function theme(S, name) {
  const path = join(S.run, 'user', 'User', 'settings.json');
  const cur = JSON.parse(readFileSync(path, 'utf8'));
  cur['workbench.colorTheme'] = name;
  writeFileSync(path, JSON.stringify(cur, null, 2));
  await S.sleep(2200);
}

/**
 * For each callout: the colour it is painted, the host variable it claims, that variable's own
 * value, and the luminance of its text against its background.
 *
 * Colours come back either as `rgb(59, 59, 59)` or, once a `color-mix` is involved, as
 * `color(srgb 0.5 0.5 0.5 / 0.8)` with components from 0 to 1. Reading the second form as 0-to-255
 * makes every mixed colour look black, which is how a check like this passes for the wrong reason;
 * the trap is already written down in `table-style.mjs` and is repeated here because it is the one
 * thing in this file that would silently invert the answer.
 */
const painted = (S, callouts) =>
  S.eval((list) => {
    /*
     * A colour as three 0-255 components, from any of the four forms this page produces.
     *
     * A custom property's computed value is the token **as written**, so `--md-alert` comes back
     * as `#0063d3` while `color` and `backgroundColor` come back as `rgb(...)`. The first version
     * handled only the `rgb()` and `color()` forms and ran its digit scan over the hex, which made
     * `#0063d3` and `#0063d3` compare unequal and reported thirteen of fifteen callouts as not
     * taking the colour they name. Every one of those was this function.
     */
    const rgb = (v) => {
      const t = String(v).trim();
      if (!t) return null;
      let m = /^#([0-9a-f]{3})$/i.exec(t);
      if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
      m = /^#([0-9a-f]{6})$/i.exec(t);
      if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
      const n = (t.match(/[\d.]+/g) || []).map(Number);
      if (n.length < 3) return null;
      // `color(srgb 0.5 0.5 0.5)` carries 0-to-1 components; `rgb()` carries 0-to-255. Reading the
      // first as the second makes every mixed colour look black.
      const scale = /^color\(/i.test(t) ? 255 : 1;
      return n.slice(0, 3).map((x) => Math.round(x * scale));
    };
    const lum = (v) => {
      const c = rgb(v);
      if (!c) return null;
      const f = c.map((x) => {
        const s = x / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
    };
    const root = getComputedStyle(document.documentElement);
    const out = [];
    for (const [kind, cls, variable] of list) {
      const el = document.querySelector(`.${cls}`) || document.querySelector(`[class*="${cls}"]`);
      if (!el) {
        out.push({ kind, found: false });
        continue;
      }
      const cs = getComputedStyle(el);
      const drawn = cs.getPropertyValue('--md-alert').trim();
      const declared = root.getPropertyValue(variable).trim();
      const label = el.querySelector('.md-alert-name, .md-alert-label');
      const text = label ? getComputedStyle(label).color : cs.color;
      const back = cs.backgroundColor;
      const a = lum(text);
      const b = lum(back);
      out.push({
        kind,
        found: true,
        drawn,
        variable,
        declared,
        // A drawn colour equal to the variable the stylesheet names is the claim the page makes.
        takesIt: !!drawn && !!declared && rgb(drawn) !== null && rgb(declared) !== null && rgb(drawn).join() === rgb(declared).join(),
        declaredEmpty: !declared,
        contrast: a === null || b === null ? null : Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100,
      });
    }
    return out;
  }, callouts);

export const scenarios = [
  {
    id: 'render.alert.themes.e01',
    feature: 'render.alert',
    name: 'A callout takes the host colour its stylesheet names, and stays legible, in a light, a dark and a high-contrast theme',
    /*
     * Marked because the defect is real and open, so this lands reporting it by name rather than
     * failing a gate, and fails the run on the day it starts passing.
     *
     * Only the legibility half is failing. Every callout in all three themes takes the colour its
     * stylesheet names, which is the derived half and the stronger claim, and 15 of 15 readings
     * found a callout, so the pass on that half is not an empty set.
     */
    known:
      "the Important callout's label is at 2.33:1 against its own background in the light theme, "
      + 'below the 3:1 floor for large text; the other fourteen readings across the three themes are 3.73:1 or better',
    run: async (S) => {
      /*
       * Three themes by name rather than "every theme", because the host ships ten and four was
       * once read as every. Three named ones are what `render.table-style` R5 does and it is the
       * model this follows.
       *
       * Two assertions per callout per theme. **Takes the colour it names** is the page's clause and
       * is a derived check: the stylesheet says where the colour comes from and the host says what
       * that is, so nothing is sampled. **Legible** is R4's own word, as a contrast ratio against
       * the callout's background rather than as "differs from the body text", because two colours
       * can differ and neither be readable on the other.
       *
       * A variable the theme does not define is reported separately and is not counted as a
       * failure to take it: the fallback is then the stylesheet working as written, and whether the
       * promise should be made at all for that theme is a product question rather than a defect.
       * That distinction is the whole reason for reading the variable.
       */
      await S.fresh('callout-themes', DOC);
      await S.sleep(1000);

      const readings = [];
      for (const [name, label] of THEMES) {
        await theme(S, name);
        await S.sleep(600);
        readings.push({ theme: label, rows: await painted(S, CALLOUTS) });
      }
      // Back to the profile's own theme, or every scenario after this one in the window inherits it.
      await theme(S, 'Default Dark Modern');

      const missing = readings.flatMap((r) => r.rows.filter((x) => !x.found).map((x) => `${r.theme}/${x.kind}`));
      const undefinedVar = readings.flatMap((r) => r.rows.filter((x) => x.found && x.declaredEmpty).map((x) => `${r.theme}/${x.kind} (${x.variable})`));
      const notTaken = readings.flatMap((r) =>
        r.rows.filter((x) => x.found && !x.declaredEmpty && !x.takesIt).map((x) => `${r.theme}/${x.kind}: drawn ${x.drawn} against ${x.variable} = ${x.declared}`)
      );
      // 3:1 is the floor for large text in WCAG, and a callout's label is large and bold.
      const illegible = readings.flatMap((r) =>
        r.rows.filter((x) => x.found && x.contrast !== null && x.contrast < 3).map((x) => `${r.theme}/${x.kind} at ${x.contrast}:1`)
      );
      // How many readings actually found a callout. Without this, every assertion below is a
      // statement about an empty set and the scenario passes by finding nothing.
      const drawn = readings.reduce((n, r) => n + r.rows.filter((x) => x.found).length, 0);
      const expected = THEMES.length * CALLOUTS.length;
      const ok = drawn === expected && notTaken.length === 0 && illegible.length === 0;
      return {
        ok,
        detail:
          `${readings.length} themes x ${CALLOUTS.length} callouts; ${drawn} of ${expected} readings found a callout. ` +
          `${missing.length ? `NOT DRAWN: ${j(missing)}; ` : ''}` +
          // Neither positive is claimed when nothing was found: "none failed" over an empty set is
          // the vacuous pass this check exists to refuse elsewhere.
          `${notTaken.length ? `DOES NOT TAKE THE COLOUR IT NAMES: ${j(notTaken)}; ` : drawn ? 'every callout is painted the colour its stylesheet names; ' : ''}` +
          `${illegible.length ? `BELOW 3:1 AGAINST ITS OWN BACKGROUND: ${j(illegible)}; ` : drawn ? 'every label is at least 3:1 against its background; ' : ''}` +
          `${undefinedVar.length ? `the theme defines no value for ${j(undefinedVar)}, so the stylesheet's fallback is in use there and that is not counted as a failure; ` : ''}` +
          `contrasts ${j(readings.map((r) => `${r.theme}: ${r.rows.map((x) => x.contrast).join('/')}`))}`,
      };
    },
  },
];
