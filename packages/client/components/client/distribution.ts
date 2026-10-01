import { createSignal } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Which channel this client was distributed through.
 *
 * One web bundle serves the browser, the sloga.gg APK, the Play Store APK and
 * the App Store build, so anything the stores forbid has to be gated at
 * runtime rather than at build time. The Android native layer reports the
 * flavor it was compiled as — see
 * android/app/src/main/java/com/acutest/app/AppFlavorPlugin.java. iOS has no
 * such plugin: every iOS build ships through the App Store.
 */
export type DistributionChannel = "web" | "sideload" | "play" | "appstore";

/**
 * Decide the channel from what the runtime can tell us.
 *
 * `reported` is the AppFlavor plugin's answer, or undefined while it is still
 * pending. Any value other than "sideload" maps to "play", so a flavor added
 * later (an F-Droid build, say) stays on the fail-closed side until it is
 * handled here explicitly.
 */
export function resolveChannel(input: {
  native: boolean;
  platform: string;
  pluginAvailable: boolean;
  reported?: string;
}): DistributionChannel {
  if (!input.native) return "web";

  // Checked before the plugin fallback below: iOS never has AppFlavor, and
  // treating a missing plugin as a sideload build there would put donate
  // links and self-update into the App Store build.
  if (input.platform === "ios") return "appstore";

  // APKs built before the flavor split have no AppFlavor plugin, and all of
  // them are sideload builds — the Play flavor did not exist yet. Without
  // this, every already-installed sideload app would lose its donate link the
  // moment it loaded a newer web bundle.
  if (!input.pluginAvailable) return "sideload";

  if (input.reported === "sideload") return "sideload";

  // Native, plugin present, answer not back yet (or not one we know): assume
  // Play. Guessing wrong in this direction briefly hides a donate link;
  // guessing wrong the other way ships Play-prohibited UI, so this fails
  // closed on purpose.
  return "play";
}

const native = Capacitor.isNativePlatform();
const platform = Capacitor.getPlatform();
const pluginAvailable = native && Capacitor.isPluginAvailable("AppFlavor");

const AppFlavorNative =
  native && platform !== "ios"
    ? registerPlugin<{ get(): Promise<{ channel: string }> }>("AppFlavor")
    : undefined;

function initialChannel(): DistributionChannel {
  return resolveChannel({ native, platform, pluginAvailable });
}

const [channel, setChannel] =
  createSignal<DistributionChannel>(initialChannel());

AppFlavorNative?.get()
  .then(({ channel: reported }) =>
    setChannel(resolveChannel({ native, platform, pluginAvailable, reported })),
  )
  // Leave the fail-closed default in place: on a native build we would rather
  // hide a donate link than risk showing one in a Play build.
  .catch(() => void 0);

/** Channel this client was distributed through. */
export const distributionChannel = channel;

/**
 * Google Play's Payments policy makes linking out to donations a grey area,
 * and Sloga Technologies LLC is not a registered nonprofit, so the charity
 * carve-out does not apply. Apple's guideline 3.1.1 likewise restricts App
 * Store apps from linking out to payment mechanisms other than in-app
 * purchase. Ko-fi entries stay out of both store builds.
 */
export const allowsDonationLinks = () =>
  channel() !== "play" && channel() !== "appstore";

/**
 * Sloga's Ko-fi page, opened straight from the "Support Sloga" buttons. Keep
 * it equal to the server's `[api.kofi] page_url`, which the Supporter page
 * links to. Only ever open it behind `allowsDonationLinks()`.
 */
export const KOFI_PAGE_URL = "https://ko-fi.com/slogatech";

/**
 * Google Play's Device and Network Abuse policy forbids an app distributed on
 * Play from updating itself outside Play, and Apple's guidelines (2.5.2) bar
 * App Store apps from downloading code that changes the app. Only sideload
 * builds update themselves.
 */
export const allowsSelfUpdate = () => channel() === "sideload";
