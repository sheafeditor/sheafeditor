/*
 * What is left behind after a consumer takes a mount down.
 *
 * `pkg.mount` R5: after `destroy()` nothing the mount registered still fires and nothing it added
 * remains in the element. A field in a single-page application is mounted and unmounted as views
 * change, so a mount with no teardown leaks on every navigation, and the leak is an `EditorView`
 * holding a detached element rather than anything the person sees.
 *
 * All three clauses were implemented and none was asserted: every scenario in the suites calls
 * `destroy()` in cleanup and then asserts nothing after it, which is the shape that leaves working
 * code with no check behind it.
 *
 * **Two defences stand behind a focus arriving after `destroy()`, and only one of them is
 * observable from here. Measured, not reasoned about.** The listener is removed, and the build
 * carries `if (destroyed) return null`. Deleting the guard fails the second and third scenarios
 * below. **Deleting the listener removal changes nothing: 689 of 689 still pass**, because the
 * guard catches that path too and the outcome a scenario can read is identical.
 *
 * So the listener removal is load-bearing for the thing R5 actually asks and these cases cannot
 * see: *nothing it registered still fires*. With it gone, a `focusin` on a detached element still
 * runs the handler, still starts a dynamic import, and still holds the whole mount's closure
 * reachable from a listener nobody can reach. "Fires and then declines" is not "does not fire",
 * and the leak is the difference. Nothing below distinguishes them, and this comment is here so
 * that the next reader does not take the passing row as evidence that it does.
 *
 * jsdom is enough: the claims are a child count, an element query and whether a view exists.
 */

import { Scenario, ScenarioResult } from '../harness';
import { mount } from '../../src/lib/index';

/** Let the dynamic import of the editor, and any measure it queued, settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

const G = globalThis as unknown as { Event: typeof Event };

/** A `focusin` as the platform sends it, which is what the mount listens for. */
const focusin = (el: HTMLElement): void => {
  el.dispatchEvent(new G.Event('focusin', { bubbles: true }));
};

const VALUE = '# A heading\n\nSome prose, and a second line.\n';

/** Every `.cm-editor` anywhere, including inside an element already detached from the document. */
const editorsIn = (el: HTMLElement): number => el.querySelectorAll('.cm-editor').length;

export const scenarios: Scenario[] = [
  {
    name: 'mount: destroy leaves the element the consumer gave holding nothing',
    run: async (): Promise<ScenarioResult> => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const surface = mount(parent, { value: VALUE, profile: 'notes' });
      surface.focus();
      await settle();
      /*
       * The precondition, asserted rather than assumed: before the teardown there has to be
       * something to tear down, or an empty element afterwards is no evidence at all.
       */
      if (!surface.editing()) return { ok: false, detail: 'no editor was built, so this tested nothing' };
      const before = { children: parent.childElementCount, editors: editorsIn(parent) };
      surface.destroy();
      const after = { children: parent.childElementCount, editors: editorsIn(parent) };
      parent.remove();
      return {
        ok: before.children === 1 && before.editors === 1 && after.children === 0 && after.editors === 0,
        detail: `the consumer's element held ${before.children} child and ${before.editors} editor before destroy, ${after.children} and ${after.editors} after; wanted 1 and 1, then 0 and 0`,
      };
    },
  },
  {
    name: 'mount: a focus arriving after destroy builds no editor',
    run: async (): Promise<ScenarioResult> => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const surface = mount(parent, { value: VALUE, profile: 'notes' });
      const element = surface.element;
      surface.destroy();
      /*
       * Both ways a focus can arrive: the raw event a person's Tab or click sends, and
       * `surface.focus()`, which calls `build()` itself and so never goes near the listener.
       * Taking both is why this is one case. What refuses them is the `destroyed` guard in either
       * path, per the header, so this does not measure the listener removal.
       */
      focusin(element);
      surface.focus();
      await settle();
      const built = surface.editing();
      const views = editorsIn(element);
      parent.remove();
      return {
        ok: !built && views === 0,
        detail: `after destroy, a focusin and a surface.focus() left editing()=${built} and ${views} editor(s) in the detached element, wanted false and 0`,
      };
    },
  },
  {
    name: 'mount: destroy while the editor is still being imported leaves no view behind',
    run: async (): Promise<ScenarioResult> => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const surface = mount(parent, { value: VALUE, profile: 'notes' });
      const element = surface.element;
      /*
       * The ordinary case in a single-page application: a view navigates away between the focus
       * that starts the build and the import resolving. `focus()` starts it and nothing is awaited
       * before the teardown, which is the whole point, so the build resolves into a mount that has
       * already gone.
       */
      surface.focus();
      surface.destroy();
      await settle();
      const built = surface.editing();
      const views = editorsIn(element);
      const attached = element.isConnected;
      parent.remove();
      return {
        ok: !built && views === 0 && !attached,
        detail: `the build resolved after destroy: editing()=${built}, ${views} editor(s) in the element, still in the document=${attached}; wanted false, 0 and false`,
      };
    },
  },
];
