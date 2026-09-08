/**
 * What a Sentry breadcrumb may carry off the device — PURE so it is
 * unit-testable without the browser SDK.
 *
 * WHY THIS EXISTS. `Sentry.init` runs with the default integration set, and
 * `breadcrumbsIntegration` records every `console.*` call, every `fetch`/`xhr`
 * and every history navigation. Breadcrumbs ride along with any event the SDK
 * later sends, so whatever they captured leaves the device. Three families of
 * content reach them here, and none of them should:
 *
 *  1. The rtc diagnostics. `[mls]`, `[rtc]` and `[e2ee]` log lines are the
 *     call-encryption trace, and they name people: member device identities
 *     (`<userId>:<deviceId>`, plus the `:screen` leg suffix), whole witness
 *     rosters, and `<identity>@<keyIndex>` pairs. `[mls] removing stale leaf
 *     for rejoin: <identity>` names a member outright. No key material is
 *     reachable from any of them — a key index is `epoch mod 16`, a public
 *     value — so this is call-roster metadata, not key exposure. It still
 *     contradicts the product's published no-IP-logs posture to ship a call
 *     roster to a third-party error reporter.
 *
 *  2. Single-use credentials in URLs. The auth flows take their secret from
 *     the path (`/login/reset/:token`, `/login/verify/:token`,
 *     `/login/delete/:token`) and `FlowOAuthCallback` reads the provider's
 *     authorization `code` out of `window.location.search`. A `navigation`
 *     breadcrumb records the URL whole, so an un-scrubbed breadcrumb hands
 *     Sentry a live password-reset token or OAuth code.
 *
 *  3. Identifiers. Every API call and every route change names a channel,
 *     server, user or message by ULID, and query strings additionally carry
 *     user-typed text (the Jellyfin browser's `SearchTerm`, for one).
 *
 * The rule is fail-closed: an rtc diagnostic is DROPPED whole rather than
 * scrubbed, because its payload is structured objects (`data.arguments` keeps
 * the raw console arguments alongside the joined `message`) that no string
 * pass could reliably clean. URLs are kept in redacted form, because the route
 * shape is what makes a breadcrumb trail worth reading and the shape is not
 * the secret.
 *
 * Nothing here touches what the developer console shows. The filter runs
 * inside the Sentry SDK on its way to the wire; `console.*` has already
 * printed by then, so the lines the live-testing rig tails over CDP are
 * unaffected.
 */

/**
 * Log-line prefixes for the rtc diagnostic families. These are the prefixes
 * used at the head of the format string by every call site under
 * `components/rtc` and `components/client/e2ee*` — verified by sweep, not
 * assumed: no other bracket prefix in those trees carries identities.
 */
export const RTC_DIAGNOSTIC_PREFIXES = ["[mls]", "[rtc]", "[e2ee]"] as const;

/** Stand-in for a redacted identifier — kept distinct so a trail stays readable. */
export const REDACTED_ID = "<id>";

/** Stand-in for a redacted secret (a token, a code, a query string). */
export const REDACTED = "<redacted>";

/**
 * A path segment whose SUCCESSOR is a single-use credential rather than an
 * identifier: the auth-flow tokens and the invite/bot codes.
 */
const CREDENTIAL_PARENTS = new Set([
  "reset",
  "verify",
  "delete",
  "create",
  "invite",
  "bot",
]);

/**
 * A ULID path segment. Matches `components/routing/index.tsx`'s own
 * `[A-Z0-9]{26}` rather than the tighter Crockford alphabet on purpose: over-
 * matching costs a redacted segment, under-matching leaks an identifier.
 */
const ID_SEGMENT = /^[0-9A-Z]{26}$/;

/**
 * The parts of a Sentry `Breadcrumb` this module reads. Declared structurally
 * so the module imports nothing and runs under `node --test`.
 */
export type ScrubbableBreadcrumb = {
  category?: string;
  type?: string;
  message?: string;
  data?: { [key: string]: unknown };
};

/** Whether a value is a string opening with an rtc diagnostic prefix. */
function opensWithDiagnosticPrefix(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const head = value.trimStart();
  return RTC_DIAGNOSTIC_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * Whether a console breadcrumb is one of the rtc diagnostics.
 *
 * Both the joined `message` and the first raw console argument are checked.
 * `message` alone would do today — the SDK builds it by joining the arguments,
 * so a prefixed first argument always lands at the head — but this filter is
 * the only thing standing between a call roster and the wire, so it does not
 * rest on that one SDK detail holding.
 */
export function isRtcDiagnosticBreadcrumb(
  breadcrumb: ScrubbableBreadcrumb,
): boolean {
  if (breadcrumb.category !== "console") return false;
  if (opensWithDiagnosticPrefix(breadcrumb.message)) return true;
  const args = breadcrumb.data?.arguments;
  return Array.isArray(args) && opensWithDiagnosticPrefix(args[0]);
}

/**
 * A URL with its identifiers and secrets removed and its route shape kept.
 *
 * The query string and fragment go whole: they are where the OAuth `code`
 * lands and where user-typed search text lands, and neither is worth a rule
 * per parameter. A marker is left behind so a reader can tell a scrubbed URL
 * from one that never had a query.
 */
export function scrubUrl(url: string): string {
  if (typeof url !== "string" || url === "") return url;

  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const suffix = cut === -1 ? "" : url[cut] + REDACTED;

  const segments = path.split("/");
  const scrubbed = segments.map((segment, index) => {
    const parent = index > 0 ? segments[index - 1].toLowerCase() : "";
    if (CREDENTIAL_PARENTS.has(parent)) return REDACTED;
    if (ID_SEGMENT.test(segment)) return REDACTED_ID;
    return segment;
  });

  return scrubbed.join("/") + suffix;
}

/** Rewrite `key` on `data` through `scrubUrl` when it holds a string. */
function scrubUrlField(data: { [key: string]: unknown }, key: string): void {
  const value = data[key];
  if (typeof value === "string") data[key] = scrubUrl(value);
}

/**
 * The `beforeBreadcrumb` hook: `null` drops the breadcrumb, anything else is
 * what gets recorded. Never mutates the SDK's object.
 */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(
  breadcrumb: T,
): T | null {
  if (isRtcDiagnosticBreadcrumb(breadcrumb)) return null;

  const { data } = breadcrumb;
  if (!data) return breadcrumb;

  // `fetch`/`xhr` put the request URL on `data.url`; a history navigation puts
  // the departed and arrived URLs on `data.from` / `data.to`.
  const carriesUrl =
    typeof data.url === "string" ||
    typeof data.from === "string" ||
    typeof data.to === "string";
  if (!carriesUrl) return breadcrumb;

  const scrubbed = { ...data };
  scrubUrlField(scrubbed, "url");
  scrubUrlField(scrubbed, "from");
  scrubUrlField(scrubbed, "to");

  return { ...breadcrumb, data: scrubbed };
}
