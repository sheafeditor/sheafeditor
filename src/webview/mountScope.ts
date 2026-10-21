/*
 * Which mounted editor a piece of state belongs to.
 *
 * Much of what this directory keeps is already safe for more than one editor on a page, because it
 * is keyed by something that tells one editor from another: a `WeakMap` on the `EditorView`, on the
 * element a widget drew, on a syntax `Tree`, or a `Map` on a file's path. **Five** collections go
 * further and hold a registry of *every* mounted editor on purpose, broadcasting to all of them:
 * `comments.ts`'s `redrawers`, `viewBlock.ts`'s `editors`, `tables.ts`'s `pinListeners` and
 * `boardListeners`, and `columnLayout.ts`'s `live`. A sweep that makes module-level collections
 * per-mount must leave every one of them alone.
 *
 * What was left over is the state a module kept in one module-level variable because there was only
 * ever one editor: the host it posts to, and the arrangement of the one document it was showing.
 * This module is the key those get instead. A mount opens a scope, the modules keep their own state
 * against it, and a read finds the scope from whatever the call already has in hand: a CodeMirror
 * state or view, or an element inside the mount's root.
 *
 * **The scope is an identity and nothing more.** It holds no module's state and names no module's
 * concern, so adding a per-mount slot to one module does not touch this file and no module has to
 * import another's shape. Each module declares its own slot with `mountSlot`.
 */

import { Facet } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * One mounted editor, as far as anything keeping state about it is concerned.
 *
 * `root` is the element the mount draws into, which is what a lookup from an element walks up to.
 */
export interface MountScope {
  readonly root: HTMLElement;
}

/** Every mount open on this page, in the order they were opened. */
const mounts = new Set<MountScope>();

/**
 * The scope for a page that has never opened a mount.
 *
 * The suites are that page: they build an editor directly from `editorExtensions` and wire a host by
 * hand, with no mount around it. So is any consumer that drives a module without one. One editor and
 * no mount is the case this serves, and it is correct for it, because there is nothing else for the
 * state to be confused with.
 */
let page: MountScope | null = null;

function pageScope(): MountScope {
  if (!page) {
    page = {
      root: (typeof document !== 'undefined' ? document.documentElement : null) as HTMLElement,
    };
  }
  return page;
}

/**
 * How many reads could not tell which of several mounts they belonged to, and took the page's scope.
 *
 * **Counted rather than only warned about, so a check can assert it did not move.** A fallback is
 * the defect this module exists to remove, arrived at quietly, and "I saw no warning" is the same
 * observation whether nothing fell back or the once-only warning had already been spent on something
 * else. The count is what tells those two apart.
 */
let fellBack = 0;

/** Said once, where a read could not tell which of several mounts it belongs to. */
let warned = false;

/**
 * How many reads have fallen back with more than one mount open.
 *
 * A suite's own page can move this without the product being wrong: `comments.ts` broadcasts a
 * redraw to every editor there is, and a check that builds an editor with no mount around it puts
 * one on the page that no mount owns. In the editor's own hosts every editor comes from a mount and
 * carries it in its configuration, so there this must not move at all.
 */
export function fallbackCount(): number {
  return fellBack;
}

/**
 * The scope for a read that brought nothing to resolve from.
 *
 * One mount is the one answer there can be. No mount is the page above. **More than one is a fault**
 * and it is counted and said out loud, because the alternative is the second mount's state answering
 * for the first, quietly.
 */
function resolve(): MountScope {
  if (mounts.size === 1) {
    for (const mount of mounts) return mount;
  }
  if (mounts.size > 1) {
    fellBack++;
  }
  if (mounts.size > 1 && !warned) {
    warned = true;
    console.warn(
      'Sheaf read per-mount state with no mount to resolve it against, and this page has more than one. ' +
        'An editor built without a mount around it is the usual cause, and the redraw every mounted editor ' +
        'is told about reaches it. `fallbackCount()` says how many such reads there have been.'
    );
  }
  return pageScope();
}

/**
 * The mount an editor belongs to, carried in its own configuration.
 *
 * A facet rather than a `WeakMap` on the view, because the reads that most need it are in state
 * fields, which are handed an `EditorState` and never a view. `comments.ts` draws every comment from
 * one, and which comments are collapsed is per-mount.
 */
export const mountFacet = Facet.define<MountScope, MountScope | null>({
  combine: (values) => values[0] ?? null,
});

/** Put in an editor's extensions so everything reading its state can find the mount. */
export function mountExtension(scope: MountScope): Extension {
  return mountFacet.of(scope);
}

/** Open a scope for a mount drawing into `root`. */
export function openMount(root: HTMLElement): MountScope {
  const scope: MountScope = { root };
  mounts.add(scope);
  return scope;
}

/** Take a mount's scope out of the registry. Its slots go with it, since nothing holds them. */
export function closeMount(scope: MountScope): void {
  mounts.delete(scope);
}

/** How many mounts are open. For a check that wants to assert the shape rather than a behaviour. */
export function openMounts(): number {
  return mounts.size;
}

function isView(where: EditorState | EditorView): where is EditorView {
  return (where as EditorView).state !== undefined;
}

/** The mount whose editor this state or view belongs to. */
export function scopeOf(where: EditorState | EditorView | null | undefined): MountScope {
  if (!where) return resolve();
  const state = isView(where) ? where.state : where;
  return state.facet(mountFacet) ?? resolve();
}

/** The mount whose root contains `node`. */
export function scopeIn(node: Node | EventTarget | null | undefined): MountScope {
  let at = node as Node | null;
  while (at) {
    for (const mount of mounts) if (mount.root === at) return mount;
    at = at.parentNode ?? (at as unknown as { host?: Node }).host ?? null;
  }
  return resolve();
}

/**
 * The mount whatever a caller happens to be holding belongs to: an editor, its state, or an element
 * inside it.
 *
 * For the functions that are called from several places with different things in hand. `openLink` is
 * the one: six callers, five of them with a view and one with the element the pointer was over.
 */
export function scopeNear(where: EditorView | EditorState | Node | null | undefined): MountScope {
  if (!where) return resolve();
  const view = where as EditorView;
  if (view.state !== undefined && view.dom !== undefined) return scopeOf(view);
  const state = where as EditorState;
  if (typeof state.facet === 'function') return scopeOf(state);
  return scopeIn(where as Node);
}

/** One module's own per-mount state. */
export interface MountSlot<T> {
  /** This mount's copy, made on first use. */
  of(scope: MountScope): T;
  /** The copy belonging to the mount this state or view is part of. */
  at(where: EditorState | EditorView | null | undefined): T;
  /** The copy belonging to the mount whose root contains this node. */
  in(node: Node | EventTarget | null | undefined): T;
  /** Whether this mount has a copy yet, without making one. */
  has(scope: MountScope): boolean;
  /**
   * Every copy that exists, for the rare thing that is genuinely about all of them.
   *
   * It makes none, so a mount that has never touched the module is not in the list. The caller for
   * it is the one that already exists elsewhere in this directory: something outside every editor
   * changed, and each editor's own record of it has to be told. A file on disk changing is that.
   */
  all(): T[];
}

/**
 * Declare a per-mount slot. The module calling this owns what is in it and nothing else reads it.
 *
 * `make` runs once per mount, on the first read, so a mount that never touches a module costs
 * nothing. A `WeakMap` keyed by the scope, which is the pattern the rest of this directory already
 * uses on views and elements.
 */
export function mountSlot<T>(make: (scope: MountScope) => T): MountSlot<T> {
  const store = new WeakMap<MountScope, T>();
  const of = (scope: MountScope): T => {
    let held = store.get(scope);
    if (held === undefined) {
      held = make(scope);
      store.set(scope, held);
    }
    return held;
  };
  return {
    of,
    at: (where) => of(scopeOf(where)),
    in: (node) => of(scopeIn(node)),
    has: (scope) => store.has(scope),
    all: () => {
      const out: T[] = [];
      for (const scope of [...(page ? [page] : []), ...mounts]) {
        const held = store.get(scope);
        if (held !== undefined) out.push(held);
      }
      return out;
    },
  };
}
