/**
 * Protected channels: the removal reason (S2-D40, design 6.3 and 4.3 step
 * 4d). A kick or a new ban in a server with a protected channel, and a seat
 * list that releases anyone, need a non-empty reason, or the server answers
 * `RemovalReasonRequired` (400, no fields) and writes nothing.
 *
 * The server's rules this module mirrors (backend 74390c37):
 *
 * - Which servers: `refuse_removal_without_reason`
 *   (`delta/src/routes/servers/member_remove.rs:101-140`) refuses when ANY
 *   channel of the server has its `protected` flag (`Channel::is_protected`,
 *   `database/src/models/channels/model.rs:1039`). It is never keyed on the
 *   target or on entitlement/contribution data. Kick (`member_remove.rs:54`)
 *   and a new ban (`servers/ban_create.rs:126`, not an "already banned"
 *   retry) call it; the seat PUT checks its own released set instead
 *   (`check_removal_reason`, `models/protected_channels/model.rs:2330`).
 * - The reason text (`database/src/util/audit_reason.rs`): control
 *   characters (`char::is_control`, Unicode Cc) and the invisible
 *   bidi/format set (`is_invisible_format` :79-91) are stripped, then the
 *   result is trimmed (`str::trim`, Unicode White_Space) :62-73; blank is
 *   none. The cap is counted in `char`s, i.e. Unicode code points, AFTER
 *   that (:44), never UTF-16 units or UTF-8 bytes.
 * - The cap depends on how the reason travels:
 *   - `X-Audit-Log-Reason` header (kick `member_remove.rs:28`, seat PUT
 *     `channels/seats_put.rs:61`): 512 chars (`audit_reason.rs:10`), over it
 *     `FailedValidation { error: "AuditLogReasonTooLong" }` (:45-47).
 *   - ban: the JSON body `reason`, no header (`ban_create.rs:105-121`),
 *     capped by the body validator at 1024 (`v0/server_bans.rs:20`;
 *     validator 0.16.1 `HasLen for String` counts `chars()` too), measured
 *     on the RAW body before sanitizing. Sending the sanitized `reason` this
 *     module returns makes the raw and sanitized counts the same.
 *
 * Callers send the `reason` returned by `validReason` as is, never the raw
 * input: it is already what the server records (sanitizing it again is a
 * no-op), and it is well formed (`encodeURIComponent`, which stoat.js and
 * `textApi` apply to the header, throws on a lone surrogate).
 *
 * Pure: no Solid / SDK runtime imports, loadable by `node --test`.
 */

/** Cap of a reason sent in `X-Audit-Log-Reason` (`audit_reason.rs:10`). */
export const AUDIT_LOG_REASON_MAX_CHARS = 512;

/** Cap of a ban's body `reason` (`v0/server_bans.rs:20`). */
export const BAN_REASON_MAX_CHARS = 1024;

/**
 * How the reason reaches the server: the audit header (kick, seat PUT) or a
 * ban's JSON body.
 */
export type RemovalReasonCarrier = "header" | "ban_body";

const MAX_CHARS: Readonly<Record<RemovalReasonCarrier, number>> = {
  header: AUDIT_LOG_REASON_MAX_CHARS,
  ban_body: BAN_REASON_MAX_CHARS,
};

/**
 * The one channel field the requirement reads. Feed it the server's flag,
 * e.g. `server.channels.map((c) => ({ protected: c.isProtected }))`; the
 * stoat.js `Channel` class itself has no `protected` field.
 */
export interface RemovalReasonChannel {
  readonly protected?: boolean;
}

/** Outcome of the local reason check. */
export type RemovalReasonCheck =
  | { ok: true; reason: string }
  | { ok: false; why: RemovalReasonProblem };

/** Why a reason cannot be sent; the server refusal maps to the same names. */
export type RemovalReasonProblem = "empty" | "too_long";

/**
 * Whether a kick or ban in this server needs a reason: at least one channel
 * whose `protected` is literally `true` (a truthy string or 1 is not).
 *
 * Advisory only: the client cache may lack channels the moderator cannot
 * view, which the server still counts, so a `RemovalReasonRequired`
 * refusal must be handled even when this answers false.
 */
export function removalReasonRequired(
  serverChannels: readonly RemovalReasonChannel[],
): boolean {
  return serverChannels.some(
    (channel) =>
      typeof channel === "object" &&
      channel !== null &&
      channel.protected === true,
  );
}

/** Rust `char::is_control`: general category Cc. */
function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

/** `is_invisible_format`, `audit_reason.rs:79-91`, in source order. */
const INVISIBLE_FORMAT: readonly (readonly [number, number])[] = [
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x2028],
  [0x2029, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isInvisibleFormat(cp: number): boolean {
  return INVISIBLE_FORMAT.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Unicode White_Space, what Rust's `str::trim` removes. */
function isWhiteSpace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

const REPLACEMENT = String.fromCodePoint(0xfffd);

/**
 * `sanitize_reason_text` as code points: strip, then trim. A lone surrogate
 * cannot be sent at all, so it becomes U+FFFD (one char, like the server's
 * lossy decode of a bad sequence) before anything else.
 */
function sanitizedCodePoints(raw: string): string[] {
  const kept: string[] = [];
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      kept.push(REPLACEMENT);
    } else if (!isControl(cp) && !isInvisibleFormat(cp)) {
      kept.push(ch);
    }
  }
  const space = (i: number) => isWhiteSpace(kept[i].codePointAt(0) ?? 0);
  let start = 0;
  let end = kept.length;
  while (start < end && space(start)) start++;
  while (end > start && space(end - 1)) end--;
  return kept.slice(start, end);
}

/**
 * Check a removal reason the way the server will: sanitized and trimmed,
 * then 1 to 512 chars (1024 for a ban body), counted in code points.
 * `reason` is the text to send.
 */
export function validReason(
  s: string,
  carrier: RemovalReasonCarrier = "header",
): RemovalReasonCheck {
  const chars = typeof s === "string" ? sanitizedCodePoints(s) : [];
  if (chars.length === 0) {
    return { ok: false, why: "empty" };
  }
  if (chars.length > MAX_CHARS[carrier]) {
    return { ok: false, why: "too_long" };
  }
  return { ok: true, reason: chars.join("") };
}

/**
 * The server's over-long reason refusal,
 * `{"type":"FailedValidation","error":"AuditLogReasonTooLong"}` (400), as the
 * local check's `"too_long"`, so the UI shows one message for both; anything
 * else is null. Takes the parsed body (`textApi`) or the raw body text
 * stoat.js throws for a failed request. `RemovalReasonRequired` is not
 * mapped here.
 */
export function reasonRefusal(error: unknown): "too_long" | null {
  let body = error;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const { type, error: detail } = body as { type?: unknown; error?: unknown };
  return type === "FailedValidation" && detail === "AuditLogReasonTooLong"
    ? "too_long"
    : null;
}
