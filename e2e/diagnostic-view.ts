import { type Page } from "@playwright/test";

/**
 * Pin a run to the dark machine-space diagnostic.
 *
 * The console renders one diagnostic session two ways and opens in the calm
 * operator-space panel by default. The specs that walk the descent are testing
 * the *other* projection, so they say so here rather than each fishing for a
 * toggle: `addInitScript` runs before any page script on every navigation, so
 * the preference is already in storage the first time the app reads it.
 *
 * The key is written out rather than imported. These specs run against the
 * served artifact and deliberately know nothing of the source tree — the same
 * reason the golden path matches machine space by a string it expects to find
 * in a chunk rather than by a module path.
 */
const KEY = "fleet-console.diagnostic-view";

export async function useMachineView(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // A context with storage disabled falls back to the calm default, and
        // the spec that needed this will fail loudly rather than silently.
      }
    },
    [KEY, "machine"] as const,
  );
}

/**
 * Pin a run to the calm operator-space panel — the default.
 *
 * Only needed in a file whose `beforeEach` has already pinned machine view:
 * init scripts run in the order they were added, so this one lands after and
 * wins. A spec that wants the default and has not pinned anything needs
 * neither call.
 */
export async function useCalmView(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Storage disabled: the app already defaults to calm.
      }
    },
    [KEY, "calm"] as const,
  );
}
