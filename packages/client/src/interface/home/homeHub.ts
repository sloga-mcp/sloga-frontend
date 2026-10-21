/**
 * Pure decisions behind the Home page: which cards show, when a dismissed
 * card comes back, and which streamer data is safe to render. Kept free of
 * Solid, lingui and the client so `node --test` can load it.
 */
import type { SaleStatus } from "../../../components/app/interface/settings/user/cipherCheckout";

/** How long the X on the Cipher banner hides it */
export const CIPHER_BANNER_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

/** localStorage key: epoch ms when the Cipher banner was last dismissed */
export const CIPHER_BANNER_KEY = "sloga.home.cipherBannerHiddenAt";

/** localStorage key: release ("0.69") whose What's New card was dismissed */
export const WHATS_NEW_KEY = "sloga.home.whatsNewDismissed";

/** Most streamer tiles the Home row shows; "See all" has the rest */
export const HOME_STREAMER_LIMIT = 8;

/**
 * A stored timestamp, or undefined when it is missing or not a positive
 * whole number of milliseconds
 */
export function parseStoredTime(
  raw: string | null | undefined,
): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Whether the Cipher banner shows.
 *
 * Fails closed: it needs a build that may link to payments, a sale the public
 * counter reports as open (unknown, closed and sold out all hide it), a
 * viewer without a Cipher badge, and no dismissal within the snooze window.
 * A dismissal stamped in the future (a clock change) counts as just now.
 */
export function showCipherBanner(input: {
  allowsLinks: boolean;
  sale: SaleStatus | undefined;
  hasCipher: boolean;
  hiddenAt: number | undefined;
  now: number;
}): boolean {
  if (!input.allowsLinks || input.sale !== "open" || input.hasCipher) {
    return false;
  }
  if (input.hiddenAt === undefined) return true;
  return (
    input.now - Math.min(input.hiddenAt, input.now) >= CIPHER_BANNER_SNOOZE_MS
  );
}

/**
 * The release a version belongs to: "0.69.2" and "0.69.0-rc.1" are both
 * "0.69". Undefined when the string is not a version.
 */
export function releaseOf(version: string | undefined): string | undefined {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/.exec(version ?? "");
  return match ? `${Number(match[1])}.${Number(match[2])}` : undefined;
}

/**
 * Whether the What's New card shows: only in the release its highlights were
 * written for (so a later release that forgot to update them shows nothing
 * rather than old news), and only until it is dismissed for that release.
 */
export function showWhatsNew(input: {
  appVersion: string;
  highlightsRelease: string;
  dismissed: string | null | undefined;
}): boolean {
  const release = releaseOf(input.appVersion);
  return (
    release !== undefined &&
    release === input.highlightsRelease &&
    input.dismissed !== release
  );
}

/** Whether the welcome tiles show: someone with no servers or no friends yet */
export function isNewUser(serverCount: number, friendCount: number): boolean {
  return serverCount === 0 || friendCount === 0;
}

/** A linked channel as far as the Home tile reads it */
export type TileConnection = {
  platform: string;
  live?: boolean;
  live_title?: string;
  /**
   * Not sent by any server yet. Phase 2 adds a stream thumbnail; until then
   * the tile never offers its back face.
   */
  live_thumbnail?: unknown;
};

/**
 * The channel a tile is about: the first live one, otherwise the first one.
 * Undefined when the streamer has linked nothing.
 */
export function primaryConnection<T extends TileConnection>(
  connections: readonly T[] | undefined,
): T | undefined {
  if (!Array.isArray(connections) || connections.length === 0) return undefined;
  return connections.find((c) => c?.live === true) ?? connections[0];
}

/** Hosts a stream thumbnail may be loaded from */
export const THUMBNAIL_HOSTS: readonly string[] = [
  "static-cdn.jtvnw.net",
  "i.ytimg.com",
];

/**
 * A live channel's thumbnail URL when it is safe to put in an `<img>`:
 * `https:` on a known platform CDN, no credentials, and only while the
 * channel is live. Anything else (absent today) is undefined, which hides
 * the flip button.
 */
export function streamThumbnail(
  connection: TileConnection | undefined,
): string | undefined {
  if (!connection || connection.live !== true) return undefined;
  const raw = connection.live_thumbnail;
  if (typeof raw !== "string" || raw.length > 2048) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    return undefined;
  }
  if (url.port !== "" || !THUMBNAIL_HOSTS.includes(url.hostname)) {
    return undefined;
  }
  return url.href;
}
