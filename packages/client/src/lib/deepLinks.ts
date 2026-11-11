/**
 * Query-string deep links that have to survive the login redirect.
 *
 * Pure: no DOM, no client, no Solid, so `node --test` can load it
 * (see deepLinks.test.ts). The stoat.js and protWallet imports are types
 * and are erased.
 */
import type { CipherTier } from "stoat.js";

import type { ProtSettingsContext } from "../../components/app/interface/settings/user/protWallet";

export type { CipherTier, ProtSettingsContext };

/**
 * Cipher tiers a `/settings?cipher_tier=` link may preselect: the literals
 * to match, typed by the stoat.js definition (the spec pins the full list).
 */
export const CIPHER_TIERS: readonly CipherTier[] = ["T99", "T149", "T299"];

/**
 * Tier from a `?cipher_tier=` query string. Only the three exact literals
 * count; anything else (other casing, junk, an empty value) is ignored.
 * This only preselects a card in settings: the server owns the price and
 * re-validates the tier at checkout.
 * @param search `location.search`, with or without the leading `?`
 * @returns The tier, or undefined when absent or not one of the literals
 */
export function parseCipherTier(search: string): CipherTier | undefined {
  const value = new URLSearchParams(search).get("cipher_tier");
  return CIPHER_TIERS.find((tier) => tier === value);
}

/** Checkout outcomes Stripe sends web buyers back with (`?cipher=`). */
export const CIPHER_RETURNS = ["success", "cancel"] as const;

export type CipherReturn = (typeof CIPHER_RETURNS)[number];

/**
 * Checkout outcome from a `?cipher=` query string (the Stripe return URL).
 * Only the two exact literals count; anything else is ignored. This only
 * picks what the settings page shows: the membership itself is always read
 * back from the server.
 * @param search `location.search`, with or without the leading `?`
 * @returns The outcome, or undefined when absent or not one of the literals
 */
export function parseCipherReturn(search: string): CipherReturn | undefined {
  const value = new URLSearchParams(search).get("cipher");
  return CIPHER_RETURNS.find((outcome) => outcome === value);
}

/** Checkout outcomes Stripe sends Prot buyers back with (`?prot=`). */
export const PROT_RETURNS = ["success", "cancel"] as const;

export type ProtReturn = (typeof PROT_RETURNS)[number];

/**
 * Checkout outcome from a `?prot=` query string (the Stripe return URL of a
 * Prot purchase). Only the two exact literals count; anything else is
 * ignored. This only picks what the Prot page shows: the balance itself is
 * always read back from the server.
 * @param search `location.search`, with or without the leading `?`
 * @returns The outcome, or undefined when absent or not one of the literals
 */
export function parseProtReturn(search: string): ProtReturn | undefined {
  const value = new URLSearchParams(search).get("prot");
  return PROT_RETURNS.find((outcome) => outcome === value);
}

/**
 * Settings context for a Prot checkout return (`?prot=`).
 * @param search `location.search`
 * @returns The context, or undefined when the param is absent or invalid
 */
export function protSettingsContext(
  search: string,
): ProtSettingsContext | undefined {
  const checkout = parseProtReturn(search);
  return checkout ? { page: "prot", checkout } : undefined;
}

/** Settings modal context for the Cipher page. */
export type CipherSettingsContext = {
  page: "cipher";
  tier?: CipherTier;
  checkout?: CipherReturn;
};

/**
 * Settings context for a Cipher deep link (`?cipher_tier=` and/or
 * `?cipher=`), carrying only the keys that were valid.
 * @param search `location.search`
 * @returns The context, or undefined when neither param is valid
 */
export function cipherSettingsContext(
  search: string,
): CipherSettingsContext | undefined {
  const tier = parseCipherTier(search);
  const checkout = parseCipherReturn(search);
  if (!tier && !checkout) return undefined;

  return {
    page: "cipher",
    ...(tier ? { tier } : {}),
    ...(checkout ? { checkout } : {}),
  };
}

/** Longest `wait` (see {@link cipherLinkAction}) before settings open plain */
export const CHANNEL_WAIT_MS = 3000;

/**
 * What a `/settings` visit does with a Cipher deep link:
 * - `open`: open the Cipher page with the link's context;
 * - `plain`: open settings as usual (no link, or a build that may not link
 *   out to payments);
 * - `wait`: the links are not allowed yet, but the build may still be
 *   learning its distribution channel (an Android build asks its native
 *   layer and reads as "play" until it answers). The caller waits for the
 *   links to be allowed, for a bounded time, and otherwise opens `plain`.
 * @param context From {@link cipherSettingsContext}
 * @param channel Whether payment links are allowed now, and whether the
 *   channel that forbids them could still change
 */
export function cipherLinkAction(
  context: CipherSettingsContext | undefined,
  channel: { allowsLinks: boolean; mayStillResolve: boolean },
): "open" | "plain" | "wait" {
  if (!context) return "plain";
  if (channel.allowsLinks) return "open";
  return channel.mayStillResolve ? "wait" : "plain";
}

/**
 * Paths whose query string is kept across the login redirect. Only settings:
 * the invite parsers in FlowLogin / FlowOAuthCallback match `/invite/:code`
 * against the whole stored path and stop recognizing it once a query string
 * is attached, so every other path keeps the old pathname-only behavior.
 */
const SEARCH_PRESERVING_PATHS = ["/settings", "/settings/"];

// Resolving against a base nobody owns tells us whether a string stays on
// the current origin, the same way the browser will resolve it.
const SENTINEL_ORIGIN = "https://sentinel.invalid";

/** Longest query string kept; anything longer is dropped, not truncated. */
export const MAX_RETURN_SEARCH_LENGTH = 2048;

/**
 * Where to send the user after login: the path they were on, plus its query
 * string for the paths that use one (so `/settings?cipher_tier=T149`
 * survives). Always a same-origin, path-only URL: anything that would
 * resolve to another origin (`//evil.com`, `/\evil.com`, `https://evil.com`,
 * a tab or newline smuggled between the slashes) falls back to `/`.
 * @param pathname `location.pathname`
 * @param search `location.search` (empty, or starting with `?`)
 * @returns The path to store as the post-login destination
 */
export function loginReturnPath(pathname: string, search: string): string {
  if (!pathname.startsWith("/")) return "/";

  let path: URL;
  try {
    path = new URL(pathname, SENTINEL_ORIGIN);
  } catch {
    return "/";
  }
  if (path.origin !== SENTINEL_ORIGIN) return "/";

  if (
    !SEARCH_PRESERVING_PATHS.includes(pathname) ||
    search.length > MAX_RETURN_SEARCH_LENGTH
  ) {
    return pathname;
  }

  // Only the query part the URL parser finds is appended, never the raw
  // string, so whatever `search` holds it cannot add path segments, a
  // fragment or another origin to the result (a validated path followed by
  // a query string always stays on that path).
  return pathname + new URL(pathname + search, SENTINEL_ORIGIN).search;
}
