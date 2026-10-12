/**
 * Founding Streamers directory — the data layer behind the anonymous
 * `GET /discover/streamers` route.
 *
 * Why plain `fetch` and not `client.api`:
 *  - the typed API surface is generated from the pinned `stoat-api` schema,
 *    whose path union has no `/discover/*` member, so a typed call is a tsc
 *    error; and
 *  - at runtime the typed client drops the body for a path it does not know
 *    (it arrives as `{}` and Rocket 422s) — the same gotcha
 *    `streamConnections.ts` documents for the connection routes.
 *
 * No auth header is sent: the route is anonymous by design. Production sits
 * behind Cloudflare with `trust_cloudflare = true`, so the route's rate-limit
 * bucket keys on the real client IP rather than collapsing every visitor into
 * one global bucket.
 *
 * `baseURL` is a parameter rather than a global. `streamConnections.ts`
 * reaches for `CONFIGURATION.DEFAULT_API_URL` directly; taking the origin
 * from the caller instead keeps this module free of a build-time constant and
 * trivially testable, and matches how `e2ee.ts:1294` and
 * `NotificationsController.ts:237` read theirs. Call sites pass
 * `client().options.baseURL`.
 *
 * To be clear about what that does NOT buy today: in this codebase the two
 * values are always the same string. `Controller.ts:160` and `:538` construct
 * the client with `baseURL: CONFIGURATION.DEFAULT_API_URL`, and `options` is
 * `readonly` (stoat.js/src/Client.ts:483), so there is no per-session origin
 * to diverge from the compiled one. This is a decoupling, not multi-node
 * support — do not plan multi-node work on the strength of this parameter.
 */

import { allowedChannelUrl } from "./channelUrlAllowlist";
import { type UserConnection, connectionUrl } from "./streamConnections";

/**
 * Avatar file exactly as the route serializes it (the Autumn `File` shape).
 *
 * Declared here rather than imported from `stoat-api`: that package is a
 * transitive dependency of `stoat.js`, not a dependency of this package, so
 * importing it would be a phantom dependency that pnpm's strict layout can
 * break at any install.
 */
export type FoundingStreamerAvatar = {
  _id: string;
  tag: string;
  filename: string;
  metadata: Record<string, unknown>;
  content_type: string;
  size: number;
};

/**
 * A linked channel as THIS route serializes it.
 *
 * Deliberately not `UserConnection` verbatim. That type
 * (streamConnections.ts:16-23) declares `display_name: string` as required,
 * and the server does always send the key — `v0::UserConnection.display_name`
 * carries no `skip_serializing_if`. But a platform can relay an EMPTY string,
 * so the renderer must keep its `connection.display_name || connection.handle`
 * fallback. The field is widened to optional here so tsc cannot be talked out
 * of that fallback: typed as required, the fallback looks like dead code to a
 * cleanup pass, and deleting it starts printing an empty channel title.
 *
 * Everything else does match, so the rest of the shape is reused rather than
 * retyped — only the one field that genuinely differs is overridden.
 */
export type FoundingStreamerConnection = Omit<
  UserConnection,
  "display_name"
> & {
  display_name?: string;
};

/**
 * One card in the directory.
 *
 * `display_name` means two different things at the two nesting levels: here
 * it is the *user's* display name, while on a connection it is the
 * *channel's* name. Both are omitted by the server when null, as is `avatar`
 * — hence the optionals. `connections` is always present (`[]` when the user
 * has linked nothing).
 */
export type FoundingStreamer = {
  _id: string;
  username: string;
  discriminator: string;
  display_name?: string;
  avatar?: FoundingStreamerAvatar;
  connections: FoundingStreamerConnection[];
};

/**
 * Body of `GET /discover/streamers`. `streamers` is optional here because a
 * malformed or truncated response must not be assumed to carry the key.
 */
type FoundingStreamersResponse = {
  streamers?: FoundingStreamer[];
};

/**
 * How long a directory request may run before it is aborted. The directory is
 * one uncached read of at most 50 rows, so anything near this is a hung
 * endpoint rather than a slow one.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fetch the Founding Streamers directory.
 *
 * The server caps the list at 50 and sends no `total`, so there is nothing to
 * paginate — one call is the whole directory.
 *
 * Error convention follows `src/interface/Discover.tsx`: a non-2xx response
 * throws the parsed JSON error body, so callers can branch on the API's own
 * `type` field.
 *
 * The request is bounded by `REQUEST_TIMEOUT_MS`. Without it a hung endpoint
 * leaves the resource in `loading` forever, and the page's poller then stacks
 * one abandoned request per minute for as long as the tab is open. A timeout
 * aborts the fetch, which surfaces here as a rejection (an `AbortError`, not
 * an API error body) — the page renders it the same way it renders any other
 * rejection, as its error state.
 */
export async function fetchFoundingStreamers(
  baseURL: string,
): Promise<FoundingStreamer[]> {
  const response = await fetch(`${baseURL}/discover/streamers`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await response.json();

  const json = (await response.json()) as FoundingStreamersResponse | null;
  const streamers = json?.streamers;

  // A well-formed body always carries `streamers`. The guards keep a
  // malformed one from reaching the renderer as junk.
  //
  // The array guard is for `<For>`, which needs an iterable. The element
  // filter is narrower than it looks, and the measured behaviour is worth
  // recording because it is not what you would guess:
  //  - a `null` element genuinely throws — `isLive` reads `.connections` off
  //    it inside the sort comparator, where nothing catches it;
  //  - an `undefined` element does NOT, because `Array.prototype.sort` moves
  //    `undefined` to the end without ever calling the comparator; and
  //  - a string, a number, `{}` or `[]` all survive and render as a blank
  //    card, since `sortName` falls through to `?? ""`.
  // So this drops one crash (`null`) and a handful of blank cards. It does
  // not catch everything: `{}` and `[]` are objects and still get through.
  if (!Array.isArray(streamers)) return [];
  return streamers.filter(
    (streamer) => streamer && typeof streamer === "object",
  );
}

/**
 * Safe external channel URL for a connection, or `undefined` when there is
 * not one. Callers MUST render no link on `undefined` rather than falling
 * back to the raw value.
 *
 * Why this exists instead of calling `connectionUrl` directly: `handle` is
 * arbitrary attacker-chosen UTF-8 relayed from Twitch / YouTube / Kick, and
 * `connectionUrl` (streamConnections.ts:26-40) interpolates it into a URL
 * string unescaped. Today the scheme and host in those templates are
 * hard-coded, so a handle lands in the path and cannot move the origin — this
 * gate is therefore defense in depth rather than a patch for a live exploit.
 * It is still load-bearing, because it turns an assumption about a shared
 * helper into a checked postcondition:
 *  - if `connectionUrl` ever gains a platform whose URL comes from data (a
 *    self-hosted or user-supplied domain), off-origin values start being
 *    produced and are rejected here instead of reaching an `href`;
 *  - a non-string `handle` (wire data is only as well-typed as the server's
 *    validation) makes `connectionUrl` throw or produce junk, and that is
 *    caught rather than crashing the card; and
 *  - every returned string is guaranteed `https:` on a known host, so no
 *    `javascript:` / `data:` / `blob:` value can reach a link.
 *
 * The parse-and-allowlist half lives in `./channelUrlAllowlist`, which has
 * zero imports so it can carry a committed spec; see that file for why the
 * scheme is checked separately from the origin (`blob:` inherits its inner
 * URL's origin). Only the `connectionUrl` call stays here, because it is the
 * part that needs a `UserConnection`.
 *
 * This helper does NOT sanitize `display_name` or `live_title` — those are
 * text, still attacker-controlled, and the rendering lane must treat them as
 * untrusted strings (plain text nodes, no markdown/HTML, clamped length).
 */
export function streamerChannelUrl(
  connection: FoundingStreamerConnection,
): string | undefined {
  let candidate: string;

  try {
    // `connectionUrl` reads only `platform` and `handle`, but its parameter
    // type requires `display_name`, which this route omits. The field is
    // filled in rather than cast away, so the call stays type-checked.
    //
    // This also needs its own try: `connectionUrl` calls `handle.startsWith`,
    // which throws on a non-string handle. `allowedChannelUrl` never throws.
    candidate = connectionUrl({
      ...connection,
      display_name: connection.display_name ?? "",
    });
  } catch {
    return undefined;
  }

  return allowedChannelUrl(candidate);
}

/**
 * Is any linked channel live right now?
 *
 * THE single definition of that predicate — import it rather than re-deriving
 * it. It is one `.some()` and looks trivial enough to inline, which is the
 * trap: the wire omits `live` entirely when it is false, so the test has to be
 * `=== true` against a possibly-absent key, and a copy written from the type
 * alone (`live?: boolean`) reads as if `false` were present. A re-derivation
 * that drifts here shows the wrong badge on a live streamer's card.
 */
export function isLive(streamer: FoundingStreamer): boolean {
  // `live` is omitted by the server when false, so this is an explicit
  // `=== true` rather than a truthiness test on a possibly-absent key.
  return (
    Array.isArray(streamer.connections) &&
    streamer.connections.some((connection) => connection.live === true)
  );
}

/** The name a card sorts under — the same one it renders under. */
function sortName(streamer: FoundingStreamer): string {
  return (streamer.display_name ?? streamer.username ?? "").toLowerCase();
}

/**
 * Directory order: everyone live first, then by display name
 * (`display_name ?? username`), case-insensitive.
 *
 * Pure — it sorts a copy, so the caller's array (typically a signal's value)
 * is never mutated. Names are compared with `<` on the lowercased string
 * rather than `localeCompare`, so the order does not shift with the viewer's
 * locale; ties keep input order because `Array.prototype.sort` is specified
 * stable.
 */
export function sortStreamers(list: FoundingStreamer[]): FoundingStreamer[] {
  return [...list].sort((a, b) => {
    const liveA = isLive(a);
    const liveB = isLive(b);
    if (liveA !== liveB) return liveA ? -1 : 1;

    const nameA = sortName(a);
    const nameB = sortName(b);
    if (nameA === nameB) return 0;
    return nameA < nameB ? -1 : 1;
  });
}
