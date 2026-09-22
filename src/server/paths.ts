/**
 * Which files the local server is allowed to touch.
 *
 * The server hands a folder on someone's disk to a browser, so every path that
 * arrives in a URL is hostile until it has been through here. Three things go
 * wrong if it is not: `..` climbs out of the folder, a leading `/` names the
 * whole filesystem, and a symlink inside the folder points anywhere at all.
 *
 * The answer to all three is to resolve first and compare afterwards. A path is
 * joined to the root, resolved, and kept only when the result is still inside
 * the root; when it exists, its real path is resolved again and checked the same
 * way, so a link that leaves the folder is refused even though the name that
 * reached us looked innocent.
 *
 * Dot directories are refused outright rather than only `.git`. The folder being
 * served is somebody's project, and `.git`, `.env`, `.ssh` and whatever else
 * arrives next are all things a document has no business reaching through a
 * link, so the whole class goes rather than a list that has to be kept current.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** True when `child` is `root` itself or something inside it. */
function inside(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** True when any segment of a relative path begins with a dot. */
function hasDotSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => seg.startsWith('.') && seg !== '');
}

/**
 * The absolute path `rel` names inside `root`, or null when it names anything
 * else. `root` must already be absolute and real.
 *
 * Existence is not required: an image that is about to be written has no real
 * path yet, so a path that does not exist is checked on its resolved form alone
 * and its parent is checked for links.
 */
export function resolveInside(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel === '') return null;
  if (rel.includes('\0')) return null;
  if (isAbsolute(rel)) return null;
  if (hasDotSegment(rel)) return null;

  const target = resolve(root, rel);
  if (!inside(root, target)) return null;

  // A link is followed and the result checked again. What is resolved is the
  // deepest part of the path that exists: the file itself when it is there, and
  // otherwise the nearest ancestor that is, since a path about to be created may
  // be several folders deep and none of them made yet. The part that does not
  // exist cannot be a link, so nothing is skipped by stopping there.
  let existing = target;
  for (;;) {
    try {
      return inside(root, realpathSync(existing)) ? target : null;
    } catch {
      const up = resolve(existing, '..');
      if (up === existing) return null; // Reached the top without finding anything.
      existing = up;
    }
  }
}

/** The path of `absolute` relative to `root`, written with forward slashes. */
export function relativePosix(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * The document a link address points at, as a path relative to the root.
 *
 * Addresses are written relative to the file they appear in, exactly as they are
 * on disk, so they resolve against that file's folder. The fragment is carried
 * separately because it names a heading in the target rather than part of its
 * name.
 */
export function resolveAddress(
  fromRelative: string,
  address: string
): { path: string; fragment: string } | null {
  if (!address) return null;
  const dir = fromRelative.includes('/') ? fromRelative.slice(0, fromRelative.lastIndexOf('/') + 1) : '';
  let url: URL;
  try {
    url = new URL(address, `file:///${dir}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  const path = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!path) return null;
  return { path, fragment: url.hash ? decodeURIComponent(url.hash.slice(1)) : '' };
}

/** The folder part of a relative path, with its trailing slash. */
export function folderOf(rel: string): string {
  const cut = rel.lastIndexOf('/');
  return cut === -1 ? '' : rel.slice(0, cut + 1);
}

/** Join two relative paths in URL form. */
export function joinRelative(dir: string, name: string): string {
  return join(dir, name).split(sep).join('/');
}
