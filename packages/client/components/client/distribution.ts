import { createSignal } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

import { type ProtStoreAdvert, protStoreFacts } from "./protStoreFacts.ts";

/**
 * Which channel this client was distributed through.
 *
 * One web bundle serves the browser, the sloga.gg APK, the Google-free foss
 * APK (sloga.gg now, F-Droid later), the Play Store APK and the App Store
 * build, so anything the stores forbid has to be gated at runtime rather than
 * at build time. The Android native layer reports the flavor it was compiled
 * as — see
 * android/app/src/main/java/com/acutest/app/AppFlavorPlugin.java. iOS has no
 * such plugin: every iOS build ships through the App Store.
 */
export type DistributionChannel =
  | "web"
  | "sideload"
  | "play"
  | "appstore"
  | "foss";

/**
 * Decide the channel from what the runtime can tell us.
 *
 * `reported` is the AppFlavor plugin's answer, or undefined while it is still
 * pending. "sideload" and "foss" (the Google-free build) are the Android
 * flavors handled here; any other value maps to "play", so a flavor added
 * later stays on the fail-closed side until it is handled here explicitly.
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
  if (input.reported === "foss") return "foss";

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
 * purchase. Ko-fi entries stay out of both store builds. The Google-free foss
 * build is neither, so it keeps them.
 */
export const allowsDonationLinks = () =>
  channel() !== "play" && channel() !== "appstore";

/**
 * Play and App Store builds, where digital goods are bought through the
 * store's own billing (S6). Desktop shells resolve to "web".
 */
export function isStoreBuild(channel: DistributionChannel): boolean {
  return channel === "play" || channel === "appstore";
}

/** How this client buys Prot. "none": it cannot, so it may not spend either. */
export type ProtPurchaseChannel = "stripe" | "appstore" | "play" | "none";

/**
 * Pick the Prot purchase channel from the distribution channel and the store
 * facts (protStoreFacts.ts). Outside the stores it is always Stripe. A store
 * build buys only through its own store, and only when all of these hold:
 * - the shell has the ProtStore plugin. An older shell without it can never
 *   buy in app, and 3.1.3(b) lets Prot bought on the web be spent in an
 *   App Store app only when in-app purchase is offered there too;
 * - the server sent a store advert. Without one the server's store state is
 *   unknown, so this fails closed even for a preview account (R26);
 * - that store is open, or this account has store preview access.
 * The other store's open flag never counts.
 */
export function protPurchaseChannel(
  channel: DistributionChannel,
  store: ProtStoreAdvert | null,
  storePreview: boolean,
  pluginAvailable: boolean,
): ProtPurchaseChannel {
  if (!isStoreBuild(channel)) return "stripe";
  if (pluginAvailable !== true) return "none";
  if (!store) return "none";

  const open = channel === "appstore" ? store.apple_open : store.play_open;
  if (open !== true && storePreview !== true) return "none";

  return channel === "appstore" ? "appstore" : "play";
}

/** Pure form of `allowsProtSpending()`, with the store facts passed in. */
export function allowsProtSpendingFor(
  channel: DistributionChannel,
  store: ProtStoreAdvert | null,
  storePreview: boolean,
  pluginAvailable: boolean,
): boolean {
  return (
    !isStoreBuild(channel) ||
    protPurchaseChannel(channel, store, storePreview, pluginAvailable) !==
      "none"
  );
}

/**
 * Contributing Prot to a tank or goal (S5b). A store build may spend only
 * once it can buy Prot through that store (S6, D5); until ProtStoreWorker
 * sets the facts they are NO_PROT_STORE_FACTS, so store builds start off.
 * Reactive: it tracks both the channel and the store facts.
 */
export const allowsProtSpending = () => {
  const f = protStoreFacts();
  return allowsProtSpendingFor(
    channel(),
    f.store,
    f.storePreview,
    f.pluginAvailable,
  );
};

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
 * builds update themselves. The foss build ships no self-updater (ApkUpdater
 * lives only in the sideload flavor), so it lands on false as well.
 */
export const allowsSelfUpdate = () => channel() === "sideload";
