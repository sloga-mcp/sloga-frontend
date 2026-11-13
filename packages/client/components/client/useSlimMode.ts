import { createMemo } from "solid-js";

import { Capacitor } from "@capacitor/core";

import { useState } from "@revolt/state";

import { useClient, useClientLifecycle } from ".";
import {
  type SlimInput,
  resolveSlim,
  SLIM_DEV_STORAGE_KEY,
  slimDevOverrideFrom,
} from "./slimMode.ts";

/**
 * DEV only: read the `slim_dev` override for this page load and latch what
 * the URL says into `sessionStorage`, so the override survives reloads and
 * in-app redirects that drop the query. `?slim_dev=1` sets the latch and
 * `?slim_dev=0` clears it.
 *
 * What the URL says is worked out with the same pure rule that gives the
 * answer: only an explicit "on" reads true with nothing stored, and only an
 * explicit "off" reads false with the latch set.
 * @returns Whether the override is on
 */
function readSlimDevOverride(): boolean {
  const search = location.search;

  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(SLIM_DEV_STORAGE_KEY);

    if (slimDevOverrideFrom(true, search, null)) {
      sessionStorage.setItem(SLIM_DEV_STORAGE_KEY, "1");
    } else if (!slimDevOverrideFrom(true, search, "1")) {
      sessionStorage.removeItem(SLIM_DEV_STORAGE_KEY);
    }
  } catch {
    // Storage is blocked: the URL still decides for this page load
  }

  return slimDevOverrideFrom(import.meta.env.DEV, search, stored);
}

// Read once per page load, behind the folded constant, so production bundles
// carry neither the read nor the latch and `?slim_dev=1` does nothing there.
const SLIM_DEV_OVERRIDE = import.meta.env.DEV ? readSlimDevOverride() : false;

/**
 * Whether Slim view is active on this device, as a reactive accessor. Call it
 * in component scope, under the client and state providers.
 *
 * Slim view is the local setting `appearance:slim_view`, honored only in the
 * Android and iOS apps and never for a staff account (the same
 * `user.privileged` fact that shows the Moderation card on Home). The rules
 * themselves are `resolveSlim` in `slimMode.ts`.
 *
 * Staff is only known once the signed-in user has loaded. Until then the
 * account reads as not staff, so this can be true for a moment on a device
 * whose stored setting is on; it turns false as soon as the user arrives.
 * @returns Accessor that is true while Slim view is active
 */
export function useSlimMode(): () => boolean {
  const state = useState();
  const facts = useSlimFacts();

  const slim = createMemo(() =>
    resolveSlim({
      ...facts(),
      setting: state.settings.getValue("appearance:slim_view") === true,
    }),
  );

  return slim;
}

/**
 * Whether this device and account may use Slim view at all, as a reactive
 * accessor. Call it in component scope, under the client provider.
 *
 * It is `useSlimMode` with the stored setting taken as on: true in the
 * Android and iOS apps (or under the development override) and never for a
 * staff account. The settings row uses it to decide whether to offer the
 * choice; it says nothing about whether Slim view is active.
 *
 * Like `useSlimMode`, it reads an account as not staff until the signed-in
 * user has loaded.
 * @returns Accessor that is true while Slim view can be turned on here
 */
export function useSlimOffered(): () => boolean {
  const facts = useSlimFacts();

  const offered = createMemo(() => resolveSlim({ ...facts(), setting: true }));

  return offered;
}

/**
 * Every fact `resolveSlim` needs apart from the stored setting, gathered in
 * one place so `useSlimMode` and `useSlimOffered` cannot disagree about the
 * device or the account. Call it in component scope; read the result inside
 * a memo or an effect.
 * @returns Reactive read of the facts
 */
function useSlimFacts(): () => Omit<SlimInput, "setting"> {
  const client = useClient();
  const { lifecycle } = useClientLifecycle();

  return () => {
    // Neither the current client nor its `user` is a signal: sign-out swaps
    // in a new client, and the user is assigned when the socket reports
    // ready. Both are followed by a lifecycle state change and the client's
    // own `ready` signal, so reading those re-runs the caller when either
    // moves.
    lifecycle.state();
    client()?.ready();

    return {
      nativeShell: Capacitor.isNativePlatform(),
      // Always false in M1; a later locked build (the Slim app) feeds this
      locked: false,
      staff: !!client()?.user?.privileged,
      devOverride: SLIM_DEV_OVERRIDE,
    };
  };
}
