/**
 * The editor's settings, read from the folder being served.
 *
 * In VS Code these come from `workspace.getConfiguration('sheaf')`, which the
 * person sets in their user settings or in the project's `.vscode/settings.json`.
 * There is no VS Code here, so the project's file is read directly and the
 * defaults are the same ones `readConfig()` uses. A folder opened both ways
 * therefore looks the same in a browser tab as it does in the editor.
 *
 * The file is JSON with comments and trailing commas, which VS Code accepts and
 * `JSON.parse` does not, so both are stripped before parsing. A file that cannot
 * be read or parsed leaves the defaults standing rather than failing the server:
 * a stray comma in a settings file is not a reason to refuse to open a document.
 *
 * Keys are read in both spellings. VS Code writes them flat, as
 * `"sheaf.contentWidth"`, and a hand-written file sometimes nests them under a
 * `"sheaf"` object instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readComments, readFrontMatter, readOutline } from '../settingValues';
import type { EditorConfig } from '../protocol';

/**
 * What the webview is given at `init`, and again whenever it changes.
 *
 * Taken from the protocol rather than restated. This host declared its own copy field for
 * field, so the shape it sends and the shape the page reads were two statements of one
 * fact with nothing comparing them: the server types `readConfig`'s answer by its copy,
 * the browser host receives it as the protocol's, and a field added to one and not the
 * other compiled. Re-exported because `server.ts` imports the name from here.
 */
export type { EditorConfig };

/** The value of every setting in a folder that sets none, as `package.json` declares them. */
export const DEFAULT_CONFIG: EditorConfig = {
  contentWidth: '708px',
  lineNumbers: false,
  revealSyntaxOnLine: false,
  doubleClickToEditSource: false,
  tableOfContents: 'hidden',
  comments: 'show',
  frontMatter: 'collapsed',
};

/**
 * Strips `//` and block comments and trailing commas.
 *
 * Runs as a small scanner rather than a regular expression because a `//` inside
 * a string is part of the value: `"contentWidth": "calc(100% // 2)"` is not a
 * comment, and a URL in a setting would otherwise lose half its text.
 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // A comma with nothing but whitespace between it and the closing bracket.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** A setting's value as the file has it, in either spelling, or `undefined` for one it does not set. */
function valueOf(raw: Record<string, unknown>, key: string): unknown {
  const nested = raw['sheaf'];
  return (
    raw[`sheaf.${key}`] ??
    (nested && typeof nested === 'object' ? (nested as Record<string, unknown>)[key] : undefined)
  );
}

function pick<T>(raw: Record<string, unknown>, key: string, fallback: T, kind: 'string' | 'boolean'): T {
  const value = valueOf(raw, key);
  return typeof value === kind ? (value as T) : fallback;
}

/** The settings for `root`, with anything missing or malformed left at its default. */
export function readConfig(root: string): EditorConfig {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stripJsonc(readFileSync(join(root, '.vscode', 'settings.json'), 'utf8')));
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CONFIG };
    raw = parsed as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  return {
    contentWidth: pick(raw, 'contentWidth', DEFAULT_CONFIG.contentWidth, 'string'),
    // What the folder starts a tab with. The toolbar's button then changes it for the tab,
    // the way it changes the table of contents and the front matter: the host keeps the new
    // value and echoes it back, and nothing is written to a file the project has checked in.
    // So this is the opening value rather than the only one, and a tab can turn them off.
    lineNumbers: pick(raw, 'lineNumbers', DEFAULT_CONFIG.lineNumbers, 'boolean'),
    revealSyntaxOnLine: pick(raw, 'revealSyntaxOnLine', DEFAULT_CONFIG.revealSyntaxOnLine, 'boolean'),
    doubleClickToEditSource: pick(raw, 'doubleClickToEditSource', DEFAULT_CONFIG.doubleClickToEditSource, 'boolean'),
    // Read through the same functions VS Code's side uses, because these settings name
    // modes: one that offers three words and a host reading it as a boolean silently
    // agrees with only one of them.
    tableOfContents: readOutline(valueOf(raw, 'tableOfContents')),
    frontMatter: readFrontMatter(valueOf(raw, 'frontMatter')),
    comments: readComments(valueOf(raw, 'comments')),
  };
}
