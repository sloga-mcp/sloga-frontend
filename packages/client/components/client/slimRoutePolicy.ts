// Route policy for Slim view: which app paths and channels Slim view may
// show, and where a blocked one goes. Pure, with no imports, so the route
// gate, the channel page and the notification tap handler all get the same
// answer and `node --test` can load it (slimRoutePolicy.test.ts).
//
// Allow by default. Only the first path segment is looked at, and only the
// segments listed in BLOCKED_SEGMENTS are blocked. The root, /settings and
// /friends stay reachable because they are not listed; the spec pins that,
// so Slim view can always be turned off again.

/** Where Slim view sends a path it does not show. */
export const SLIM_ROOT = "/";

/**
 * First segments of the routes in src/index.tsx that Slim view does not
 * show. A new route that opens a server surface has to be added here, or
 * Slim view lets it through.
 */
const BLOCKED_SEGMENTS: readonly string[] = [
  // /server/:server/* (server home, server channels, events)
  "server",
  // /discover, /discover/servers, /discover/server/:id
  "discover",
  // /streamers
  "streamers",
  // /invite/:code
  "invite",
  // /bot/:code
  "bot",
  // /dev
  "dev",
];

/**
 * First segment of an app path the way the router reads it, or "" for the
 * root. The query string and hash are dropped. Empty segments are skipped, so
 * a leading, trailing or doubled slash changes nothing. The segment is
 * lower-cased because @solidjs/router lower-cases both sides before it
 * compares a static segment (createMatcher in its dist/utils.js), so
 * /Server/x opens the same page as /server/x. The router does not
 * percent-decode, and neither does this.
 */
function firstSegment(path: string): string {
  const end = path.search(/[?#]/);
  const pathname = end === -1 ? path : path.slice(0, end);

  for (const segment of pathname.split("/")) {
    if (segment) return segment.toLowerCase();
  }

  return "";
}

/**
 * Where Slim view redirects an app path, or `null` when it may show it.
 *
 * The only redirect target is `SLIM_ROOT`, and `SLIM_ROOT` itself is never
 * redirected, so a caller that follows the answer cannot loop.
 *
 * A server channel opened through /channel/:id is not decided here, since
 * the path alone does not say whose channel it is: see `slimAllowsChannel`.
 *
 * @param path App path, not a full URL; a trailing slash, query string and hash are fine
 * @returns `SLIM_ROOT` for a blocked path, otherwise `null`
 */
export function slimRedirectFor(path: string): string | null {
  return BLOCKED_SEGMENTS.includes(firstSegment(path)) ? SLIM_ROOT : null;
}

/**
 * Whether Slim view may show a channel: true for a DM, a group or Saved
 * Notes (no server), false for a channel that belongs to a server.
 *
 * A channel that is not loaded yet (`undefined`) is allowed. The caller must
 * not redirect before it knows the channel, and asks again once it does.
 *
 * @param ch Channel, or `undefined` while it is still loading
 * @returns Whether the channel may be shown
 */
export function slimAllowsChannel(
  ch: { serverId?: string | null } | undefined,
): boolean {
  if (!ch) return true;
  return !(typeof ch.serverId === "string" && ch.serverId.length > 0);
}

/**
 * Whether an app path is a server invite link (/invite/:code). The route
 * gate uses this to show the "hidden in Slim view" notice for a blocked
 * invite.
 *
 * @param path App path, read the same way as in `slimRedirectFor`
 * @returns Whether the first segment is `invite`
 */
export function slimIsInviteLike(path: string): boolean {
  return firstSegment(path) === "invite";
}

/**
 * Whether an app path shows the Slim view root screen: the root itself, or
 * /app, which is where login lands and where the sidebar wordmark links.
 * Both render the same placeholder, so on a phone the drawer rests on the
 * chat list for either.
 *
 * @param path App path, read the same way as in `slimRedirectFor`
 * @returns Whether the first segment is empty or `app`
 */
export function slimIsRoot(path: string): boolean {
  const segment = firstSegment(path);
  return segment === "" || segment === "app";
}
