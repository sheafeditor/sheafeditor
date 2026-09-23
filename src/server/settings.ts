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

/** What the webview is given at `init`, and again whenever it changes. */
export interface EditorConfig {
  contentWidth: string;
  revealSyntaxOnLine: boolean;
  doubleClickToEditSource: boolean;
  tableOfContents: boolean;
  comments: 'show' | 'hidden';
}

export const DEFAULT_CONFIG: EditorConfig = {
  contentWidth: '708px',
  revealSyntaxOnLine: false,
  doubleClickToEditSource: true,
  tableOfContents: false,
  comments: 'show',
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

function pick<T>(raw: Record<string, unknown>, key: string, fallback: T, kind: 'string' | 'boolean'): T {
  const nested = raw['sheaf'];
  const value =
    raw[`sheaf.${key}`] ??
    (nested && typeof nested === 'object' ? (nested as Record<string, unknown>)[key] : undefined);
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
    revealSyntaxOnLine: pick(raw, 'revealSyntaxOnLine', DEFAULT_CONFIG.revealSyntaxOnLine, 'boolean'),
    doubleClickToEditSource: pick(raw, 'doubleClickToEditSource', DEFAULT_CONFIG.doubleClickToEditSource, 'boolean'),
    tableOfContents: pick(raw, 'tableOfContents', DEFAULT_CONFIG.tableOfContents, 'boolean'),
    // Only the two names the setting offers. Anything else leaves comments showing,
    // because a comment drawn as nothing is a comment a reader cannot find.
    comments: pick(raw, 'comments', DEFAULT_CONFIG.comments, 'string') === 'hidden' ? 'hidden' : 'show',
  };
}
