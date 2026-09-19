import { Scenario, mountProse, Prose } from '../harness';

const G: any = globalThis;

const findPanel = (p: Prose): HTMLElement | null => p.view.dom.querySelector('.cm-panels-top .sheaf-find');
const field = (p: Prose, name: string): HTMLInputElement => findPanel(p)!.querySelector(`[name=${name}]`) as HTMLInputElement;
const typeInto = (input: HTMLInputElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new G.Event('input', { bubbles: true }));
};
const clickNamed = (p: Prose, name: string): void => (findPanel(p)!.querySelector(`button[name=${name}]`) as HTMLButtonElement).click();
const count = (p: Prose): string => findPanel(p)?.querySelector('.sheaf-find-count')?.textContent ?? '';

export const scenarios: Scenario[] = [
  {
    name: 'a plain search for text with a backslash finds it as written',
    run: () => {
      const p = mountProse('Saved under C:\\new today.\nTab\\t and \\\\ too.');
      p.press('Mod-f');
      typeInto(field(p, 'search'), 'C:\\new');
      const path = count(p) === '1 match';
      typeInto(field(p, 'search'), 'Tab\\t');
      const tab = count(p) === '1 match';
      typeInto(field(p, 'search'), '\\\\');
      const doubled = count(p) === '1 match';
      p.destroy();
      return path && tab && doubled;
    },
  },
  {
    name: 'a selection with a backslash seeds find with a search that matches it',
    run: () => {
      const doc = 'Saved under C:\\new today.';
      const p = mountProse(doc);
      const from = doc.indexOf('C:');
      p.select(from, from + 'C:\\new'.length);
      p.press('Mod-f');
      const ok = field(p, 'search').value === 'C:\\new' && count(p) === '1 of 1';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a plain replacement with a backslash is written as typed',
    run: () => {
      const p = mountProse('a X b');
      p.press('Mod-f');
      typeInto(field(p, 'search'), 'X');
      typeInto(field(p, 'replace'), 'C:\\notes');
      clickNamed(p, 'replaceAll');
      const ok = p.doc() === 'a C:\\notes b';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'with regular expressions on, \\n in the search and the replacement still means a line break',
    run: () => {
      const p = mountProse('a X b\nc');
      p.press('Mod-f');
      clickNamed(p, 'regexp');
      typeInto(field(p, 'search'), 'b\\nc');
      const found = count(p) === '1 match';
      typeInto(field(p, 'search'), 'X');
      typeInto(field(p, 'replace'), '1\\n2');
      clickNamed(p, 'replaceAll');
      const ok = found && p.doc() === 'a 1\n2 b\nc';
      p.destroy();
      return ok;
    },
  },
];
