import { languages } from '@codemirror/language-data';
import { Scenario, mountProse } from '../harness';
import { codeLanguageFor } from '../../src/webview/editorExtensions';

type Prose = ReturnType<typeof mountProse>;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Spans the highlighter coloured on a document line (1-based), found by the text they hold. */
const colouredSpans = (p: Prose, lineNumber: number): string[] => {
  const line = p.view.state.doc.line(lineNumber);
  const { node } = p.view.domAtPos(line.from + 1);
  const el = (node.nodeType === 1 ? node : node.parentElement) as HTMLElement;
  const lineEl = el.closest('.cm-line');
  if (!lineEl) return [];
  return Array.from(lineEl.querySelectorAll('span[class]')).map((s) => s.textContent ?? '');
};

/**
 * Mount a document holding the same code twice, fenced once with the language's full
 * name and once with its short name, wait for the language to load and the editor to
 * reparse, and report whether both blocks carry the same highlight spans.
 */
async function sameColours(full: string, short: string, languageName: string, code: string, token: string): Promise<boolean> {
  const p = mountProse(`.\n\n\`\`\`${full}\n${code}\n\`\`\`\n\n\`\`\`${short}\n${code}\n\`\`\`\n`);
  try {
    await languages.find((l) => l.name === languageName)!.load();
    // Line 4 is the full-name block's code, line 8 the short-name block's.
    for (let i = 0; i < 100 && !colouredSpans(p, 4).includes(token); i++) await wait(20);
    for (let i = 0; i < 20 && !colouredSpans(p, 8).includes(token); i++) await wait(20);
    const fullSpans = colouredSpans(p, 4);
    const shortSpans = colouredSpans(p, 8);
    return fullSpans.includes(token) && fullSpans.join('|') === shortSpans.join('|') && p.doc().includes(`\`\`\`${short}\n`);
  } finally {
    p.destroy();
  }
}

export const scenarios: Scenario[] = [
  {
    name: 'short fence names pick the same language as their full names, and unknown names still fall back',
    run: () => {
      const pairs: [string, string][] = [
        ['py', 'python'], ['PY', 'python'], ['py3', 'python'], ['rs', 'rust'], ['md', 'markdown'], ['mkd', 'markdown'],
        ['mjs', 'javascript'], ['cjs', 'javascript'], ['mts', 'typescript'], ['cts', 'typescript'],
        ['kt', 'kotlin'], ['kts', 'kotlin'], ['golang', 'go'], ['ps1', 'powershell'], ['pwsh', 'powershell'],
        ['pl', 'perl'], ['hs', 'haskell'], ['erl', 'erlang'], ['clj', 'clojure'], ['htm', 'html'],
        ['cc', 'cpp'], ['cxx', 'cpp'], ['hpp', 'cpp'], ['jl', 'julia'], ['ml', 'ocaml'], ['fs', 'fsharp'],
        ['proto', 'protobuf'], ['patch', 'diff'], ['svg', 'xml'],
        // Names the list already knew keep their match.
        ['ts', 'typescript'], ['sh', 'bash'], ['yml', 'yaml'], ['js', 'javascript'],
      ];
      const mismatched = pairs.filter(([short, full]) => {
        const a = codeLanguageFor(short);
        return !a || a !== codeLanguageFor(full);
      });
      const fallback = codeLanguageFor('python3')?.name === 'Python' && codeLanguageFor('nosuchlanguage') === null;
      return mismatched.length === 0 && fallback;
    },
  },
  {
    name: 'code fenced as py is highlighted like python',
    run: () => sameColours('python', 'py', 'Python', 'class Foo: pass', 'class'),
  },
  {
    name: 'code fenced as rs is highlighted like rust',
    run: () => sameColours('rust', 'rs', 'Rust', 'fn main() { let x = 1; }', 'fn'),
  },
  {
    name: 'code fenced as kt is highlighted like kotlin',
    run: () => sameColours('kotlin', 'kt', 'Kotlin', 'fun main() { val x = 1 }', 'fun'),
  },
];
