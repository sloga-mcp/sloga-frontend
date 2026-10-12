/**
 * Allowlist gate for external streaming-channel links.
 *
 * Deliberately has ZERO imports. Everything it needs is a platform global, so
 * `channelUrlAllowlist.test.ts` beside it loads under
 * `node --test --conditions=browser` with no module mocks and no resolution
 * shim. Its one caller today is `foundingStreamers.ts` — note that
 * `ProfileConnections.tsx` and settings' `Connections.tsx` still render
 * `connectionUrl()` output unallowlisted, which is safe only because that
 * helper hard-codes scheme and host. Callers reach `@revolt/common`
 * transitively, which is
 * a tsconfig path with no node resolution — so keeping the security-relevant
 * half of the logic import-free is what makes it testable at all.
 */

/**
 * The only origins a channel link may point at. `https` only, exact host, no
 * `www.` variants — these are the three origins `connectionUrl`
 * (streamConnections.ts:26-40) builds, and nothing else is a channel link.
 */
const CHANNEL_ORIGINS = new Set([
  "https://twitch.tv",
  "https://youtube.com",
  "https://kick.com",
]);

/**
 * Normalized `href` for `candidate` if it is a real channel link, otherwise
 * `undefined`. Callers MUST render no link on `undefined` rather than falling
 * back to the raw value.
 *
 * The scheme is checked SEPARATELY from the origin, and that is not
 * redundant: `new URL("blob:https://twitch.tv/x").origin` is
 * `"https://twitch.tv"`, because a blob URL inherits the origin of its inner
 * URL. An origin-only gate therefore admits `blob:`, and the same trick works
 * for any scheme whose origin is derived rather than parsed. This was found
 * by a spec, not by reading — `channelUrlAllowlist.test.ts` fails on the
 * `blob:` case the moment the scheme check is removed.
 *
 * Anything unparseable (`"//evil.example/foo"`, `""`, junk) throws in the URL
 * constructor and is rejected the same way.
 */
export function allowedChannelUrl(candidate: string): string | undefined {
  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:") return undefined;

  // Userinfo is rejected in addition to the origin check, because
  // `URL.origin` strips it: the origin of
  // `https://evil.example@twitch.tv/x` is plain `"https://twitch.tv"`, so an
  // origin-only gate hands that string straight back. Navigation does land on
  // twitch.tv, so this is not an origin escape — but it is what a browser
  // shows in the status bar on hover, and it reads as `evil.example`. A real
  // channel link never carries credentials.
  if (url.username !== "" || url.password !== "") return undefined;

  if (!CHANNEL_ORIGINS.has(url.origin)) return undefined;

  // `href`, not the input string: the parser has normalized escaping, so the
  // value handed to an `href` is exactly the value that was validated.
  return url.href;
}
