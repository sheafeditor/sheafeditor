/*
 * Which build of Sheaf this is.
 *
 * Every development build carries the same `package.json` version, so a person
 * running a locally built copy had no way to tell today's work from last week's.
 * One installed copy was 63 commits behind and nothing in the product said so.
 * The cost falls on whoever asked for a change, was told it landed, and then
 * could not confirm they were looking at it: a round trip, every time.
 *
 * So the build stamps itself. `esbuild.mjs` replaces `__SHEAF_BUILD__` with a
 * JSON string at build time, from git, or from the `SHEAF_BUILD_*` environment
 * when there is no git to ask — which is the case that matters, because both
 * `package:clean` and the release workflow build from a `git archive` export
 * with no `.git` in it, and those are the builds a person actually installs.
 *
 * This module is for the extension host and the local server. The webview must
 * not import it: the editor bundle is the same bytes in every host, and a commit
 * hash baked into it would make that false for no reason.
 */

/** Replaced at build time. `typeof` rather than a bare read, so a bundle built without the define still runs. */
declare const __SHEAF_BUILD__: string | undefined;

export interface BuildStamp {
  /** The version in `package.json` when this was built. */
  version: string;
  /** Short commit, or `unknown` where the build could not be asked. */
  commit: string;
  /** Branch name, or `unknown`. Absent from an archive export, which has no branch. */
  branch: string;
  /** Whether the tree had uncommitted changes. A build from one describes nothing on its own. */
  dirty: boolean;
  /** When it was built, ISO 8601. */
  builtAt: string;
}

const UNKNOWN: BuildStamp = { version: '0.0.0', commit: 'unknown', branch: 'unknown', dirty: false, builtAt: '' };

function read(): BuildStamp {
  if (typeof __SHEAF_BUILD__ === 'undefined' || !__SHEAF_BUILD__) return UNKNOWN;
  try {
    const held = JSON.parse(__SHEAF_BUILD__) as Partial<BuildStamp>;
    return {
      version: typeof held.version === 'string' ? held.version : UNKNOWN.version,
      commit: typeof held.commit === 'string' ? held.commit : UNKNOWN.commit,
      branch: typeof held.branch === 'string' ? held.branch : UNKNOWN.branch,
      dirty: held.dirty === true,
      builtAt: typeof held.builtAt === 'string' ? held.builtAt : '',
    };
  } catch {
    // A stamp that will not parse is a build fault, and it must not stop the editor opening.
    return UNKNOWN;
  }
}

export const buildStamp: BuildStamp = read();

/**
 * The stamp as one line a person can paste into a bug report.
 *
 * `host` is where Sheaf is running, because the same build serves a VS Code
 * window and a browser tab and the answer to "what were you using" differs.
 */
export function buildLine(host: string, stamp: BuildStamp = buildStamp): string {
  const parts = [`Sheaf ${stamp.version}`, stamp.commit === 'unknown' ? 'commit unknown' : stamp.commit];
  if (stamp.dirty) parts.push('built from a modified tree');
  if (stamp.branch !== 'unknown' && stamp.branch !== 'HEAD') parts.push(`on ${stamp.branch}`);
  if (stamp.builtAt) parts.push(`built ${stamp.builtAt}`);
  parts.push(host);
  return parts.join(' · ');
}

/**
 * Whether `installed` is a different build from the one running.
 *
 * VS Code refreshes its extension registry when something is installed, while the
 * code already loaded keeps running, so the version the registry reports and the
 * version compiled in here disagree exactly when a newer build is on disk waiting
 * for the window to reload. That is the whole signal; no version arithmetic, since
 * an older build installed on purpose is just as much a reason to say something.
 */
export function differsFromRunning(installed: string | undefined, stamp: BuildStamp = buildStamp): boolean {
  if (!installed || typeof installed !== 'string') return false;
  if (stamp.version === UNKNOWN.version) return false;
  return installed !== stamp.version;
}
