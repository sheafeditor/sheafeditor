/*
 * The element a construct the render path does not draw comes back in, read off a mounted surface.
 *
 * `sheaf-unrendered` and `data-construct` are a consumer's hook: `src/lib/README.md` names them and
 * gives the one rule that makes refused source read as source. Nothing in either stylesheet or in
 * the editor refers to the class, so before this file a rename made for tidiness would have passed
 * every check and silently taken back the promise that refused source is visible and named.
 *
 * **The strings are written out here, on purpose.** A case that took the class name from the
 * module that emits it would agree with that module through any rename, which is the one change it
 * exists to catch.
 *
 * Three readings, because the two elements are not interchangeable and the third is the one where
 * a failure is an injection rather than a cosmetic fault:
 *
 *   - a block the profile does not carry is a `<div>`, which is valid where a block goes;
 *   - an inline construct inside a paragraph is a `<span>`, because a `<div>` inside a `<p>` is
 *     not valid HTML and the parser would close the paragraph around it;
 *   - source containing `</div>` stays text inside its wrapper, and no element it spells is made.
 */

import { Scenario } from '../harness';
import { mount } from '../../src/lib/index';

function rendered(value: string, profile: 'field' | 'notes'): { html: string; root: HTMLElement; scope: string[]; done: () => void } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = mount(parent, { value, profile });
  return {
    html: surface.element.innerHTML,
    root: surface.element,
    scope: surface.outOfScope().map((o) => `${o.construct}/${o.reason}`),
    done: () => {
      surface.destroy();
      parent.remove();
    },
  };
}

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n';

export const scenarios: Scenario[] = [
  {
    name: 'unrendered: a table in a notes surface comes back as <div class="sheaf-unrendered" data-construct="Table">',
    run: () => {
      const r = rendered(`Before.\n\n${TABLE}`, 'notes');
      try {
        const el = r.root.querySelector('div.sheaf-unrendered[data-construct="Table"]');
        const wanted = '<div class="sheaf-unrendered" data-construct="Table">| a | b |\n| - | - |\n| 1 | 2 |</div>';
        return {
          ok: !!el && r.html.includes(wanted) && r.scope.includes('Table/profile'),
          detail: `markup ${JSON.stringify(r.html)}; outOfScope ${JSON.stringify(r.scope)}`,
        };
      } finally {
        r.done();
      }
    },
  },
  {
    name: 'unrendered: an inline construct inside a paragraph comes back as a <span> inside the <p>',
    run: () => {
      const r = rendered('Square it: $x^2$ now.', 'notes');
      try {
        const span = r.root.querySelector('p > span.sheaf-unrendered[data-construct="InlineMath"]');
        const divs = r.root.querySelectorAll('div.sheaf-unrendered').length;
        return {
          ok: !!span && divs === 0 && span.textContent === '$x^2$',
          detail: `markup ${JSON.stringify(r.html)}; ${divs} div wrapper(s)`,
        };
      } finally {
        r.done();
      }
    },
  },
  {
    name: 'unrendered: source containing </div> stays text inside its wrapper and makes no element',
    run: () => {
      const r = rendered('| a | b |\n| - | - |\n| </div><b id="x">bold</b> | 2 |\n', 'notes');
      try {
        const wrappers = r.root.querySelectorAll('div.sheaf-unrendered[data-construct="Table"]');
        const made = r.root.querySelectorAll('b, #x').length;
        const text = wrappers[0]?.textContent ?? '';
        return {
          ok: wrappers.length === 1 && made === 0 && text.includes('</div><b id="x">bold</b>') && r.html.includes('&lt;/div&gt;'),
          detail: `${wrappers.length} wrapper(s), ${made} element(s) made from the source; wrapper text ${JSON.stringify(text)}; markup ${JSON.stringify(r.html)}`,
        };
      } finally {
        r.done();
      }
    },
  },
  {
    name: 'unrendered: a block typed into a field comes back as a <span>, since a field is one paragraph',
    run: () => {
      const r = rendered('# Not a heading here', 'field');
      try {
        const span = r.root.querySelector('span.sheaf-unrendered[data-construct="ATXHeading1"]');
        const divs = r.root.querySelectorAll('div.sheaf-unrendered').length;
        return {
          ok: !!span && divs === 0 && span.textContent === '# Not a heading here',
          detail: `markup ${JSON.stringify(r.html)}; outOfScope ${JSON.stringify(r.scope)}`,
        };
      } finally {
        r.done();
      }
    },
  },
];
