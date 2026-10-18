/**
 * Query-string deep links that have to survive the login redirect.
 *
 * Pure: no DOM, no client, no Solid, so `node --test` can load it
 * (see deepLinks.test.ts).
 */

/** Cipher tiers a `/settings?cipher_tier=` link may preselect. */
export const CIPHER_TIERS = ["T99", "T149", "T299"] as const;

export type CipherTier = (typeof CIPHER_TIERS)[number];

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
