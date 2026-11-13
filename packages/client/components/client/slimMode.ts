/**
 * Slim view: the pure decision of whether it is active on this device.
 *
 * Slim view is a layout (chats and calls, no servers), stored per device and
 * offered in the Android and iOS apps only. This module holds the rules and
 * nothing else: it imports nothing and reads no app, browser or build state
 * (every fact is passed in), so `node --test` loads it directly
 * (`slimMode.test.ts`). The reactive accessor that feeds it lives in
 * `useSlimMode.ts`.
 */

/** The facts that decide whether Slim view is active. */
export type SlimInput = {
  /** The stored local setting `appearance:slim_view`. */
  setting: boolean;
  /** Whether this is the Android or iOS app. */
  nativeShell: boolean;
  /** Whether this build ships with Slim view locked on. */
  locked: boolean;
  /** Whether the signed-in account is a staff account. */
  staff: boolean;
  /** The development override, see `slimDevOverrideFrom`. */
  devOverride: boolean;
};

/**
 * Where the development override is latched in `sessionStorage`. The URL
 * query parameter that sets it has the same name.
 */
export const SLIM_DEV_STORAGE_KEY = "slim_dev";

/**
 * Whether Slim view is active.
 *
 * A staff account never gets Slim view, even in a locked build or with the
 * stored setting on: it must not hide moderation surfaces. Otherwise a locked
 * build is always Slim, and elsewhere the setting only counts in the native
 * apps (or under the development override).
 * @param input The facts
 * @returns Whether Slim view is active
 */
export function resolveSlim(input: SlimInput): boolean {
  if (input.staff) return false;
  if (input.locked) return true;

  return (input.nativeShell || input.devOverride) && input.setting;
}

/**
 * Whether the development override is on. It lets a development build in a
 * desktop browser stand in for the native apps; it never turns Slim view on
 * by itself (the setting still has to be on).
 *
 * Always false outside a development build. In one, the URL decides when it
 * says anything: `slim_dev=1` is on, `slim_dev=0` is off, and off wins over
 * both the stored latch and a repeated `slim_dev=1`. With neither in the URL
 * the stored latch decides, and only the exact value "1" counts.
 * @param dev Whether this is a development build
 * @param search The query string, as `location.search` gives it
 * @param stored The latched value from storage, if any
 * @returns Whether the override is on
 */
export function slimDevOverrideFrom(
  dev: boolean,
  search: string,
  stored: string | null,
): boolean {
  if (!dev) return false;

  const values = new URLSearchParams(search).getAll(SLIM_DEV_STORAGE_KEY);
  if (values.includes("0")) return false;
  if (values.includes("1")) return true;

  return stored === "1";
}
