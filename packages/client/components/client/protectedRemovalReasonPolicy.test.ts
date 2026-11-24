// Unit spec for the Protected channels removal reason policy (S2-D40, W4
// lane L1rr), run with Node's built-in runner from packages/client:
//   node --test --conditions=browser components/client/protectedRemovalReasonPolicy.test.ts
// Focus: the client asks for a reason exactly when the server will, and
// counts it the way the server does. The server (backend 74390c37) strips
// control and invisible-format chars, trims, then caps in Unicode code
// points: 512 for the `X-Audit-Log-Reason` header (kick, seat PUT), 1024 for
// a ban's body reason. Its over-long refusal maps to the local "too_long".
// The rules are pinned here; an extra test checks them against the backend
// source when it is present (`SLOGA_BACKEND_DIR`, then the W4 gate's S2
// copy; it skips, loudly, when absent). Non-ASCII test text is built from
// code points, never escapes.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Channel, HydratedChannel } from "stoat.js";

import {
  type RemovalReasonChannel,
  AUDIT_LOG_REASON_MAX_CHARS,
  BAN_REASON_MAX_CHARS,
  reasonRefusal,
  removalReasonRequired,
  validReason,
} from "./protectedRemovalReasonPolicy.ts";

// Compile-time: the hydrated channel carries the flag; the `Channel` class
// does not, so callers map `isProtected` into the one field read.
export const _hydratedFits: RemovalReasonChannel =
  null as unknown as HydratedChannel;
// @ts-expect-error the Channel class has no `protected` field
export const _classDoesNot: RemovalReasonChannel = null as unknown as Channel;
export const _fromSdk = (c: Channel): RemovalReasonChannel => ({
  protected: c.isProtected,
});

const cp = (...points: number[]) => String.fromCodePoint(...points);
const a = (n: number) => "a".repeat(n);
const CHECK = cp(0x2713); // 3 UTF-8 bytes, 1 UTF-16 unit
const E_ACUTE = cp(0xe9); // 2 UTF-8 bytes, 1 UTF-16 unit
const GRIN = cp(0x1f600); // 4 UTF-8 bytes, 2 UTF-16 units
const FFFD = cp(0xfffd);

/** `is_invisible_format` at backend 74390c37 (`audit_reason.rs:79-91`). */
const RUST_INVISIBLE_74390c37: [number, number][] = [
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x2028],
  [0x2029, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

const inRustInvisible = (point: number) =>
  RUST_INVISIBLE_74390c37.some(([lo, hi]) => point >= lo && point <= hi);

/** The verdict for a reason that passes. */
const ok = (reason: string) => ({ ok: true, reason });
const EMPTY = { ok: false, why: "empty" };
const TOO_LONG = { ok: false, why: "too_long" };

/**
 * A value as printable ASCII (keys sorted, every other code point as
 * `<U+hex>`), so a failure never writes raw control bytes into the TAP log
 * (grep then reads the log as binary and misses the `not ok` line).
 */
function ascii(value: unknown): string {
  const keys =
    typeof value === "object" && value !== null
      ? Object.keys(value).sort()
      : undefined;
  let out = "";
  for (const ch of JSON.stringify(value, keys) ?? String(value)) {
    const point = ch.codePointAt(0) ?? 0;
    out += point >= 0x20 && point <= 0x7e ? ch : `<U+${point.toString(16)}>`;
  }
  return out;
}

/** `deepEqual` for flat verdicts, compared and reported as ASCII. */
const same = (actual: unknown, expected: unknown, label?: string) =>
  assert.equal(ascii(actual), ascii(expected), label);

// ---- removalReasonRequired ----

test("required: true iff at least one channel has protected === true", () => {
  assert.equal(removalReasonRequired([]), false);
  assert.equal(removalReasonRequired([{}]), false);
  assert.equal(removalReasonRequired([{ protected: false }]), false);
  assert.equal(removalReasonRequired([{ protected: true }]), true);
  assert.equal(
    removalReasonRequired([{}, { protected: false }, { protected: true }]),
    true,
  );
  assert.equal(
    removalReasonRequired([{ protected: false }, {}, { protected: false }]),
    false,
  );
});

test("required: strict, a truthy non-boolean protected never counts", () => {
  for (const truthy of ["true", 1, {}, [true], "yes", Number.NaN, -1]) {
    assert.equal(
      removalReasonRequired([{ protected: truthy as unknown as boolean }]),
      false,
      String(truthy),
    );
  }
  // A Boolean object is truthy and not `true`
  assert.equal(
    removalReasonRequired([
      { protected: new Boolean(true) as unknown as boolean },
    ]),
    false,
  );
});

test("required: reads only the protected field (other fields and holes are ignored)", () => {
  const noise = [
    { protected: false, entitled: true, contribution: 50, pinned: true },
    { isProtected: true, protectedOrPinned: true },
    null,
    undefined,
    "protected",
  ] as unknown as RemovalReasonChannel[];
  assert.equal(removalReasonRequired(noise), false);
  assert.equal(removalReasonRequired([...noise, { protected: true }]), true);
});

// ---- validReason ----

test("reason: 0 / 1 / 512 / 513 chars after trim (header cap)", () => {
  assert.equal(AUDIT_LOG_REASON_MAX_CHARS, 512);
  same(validReason(""), EMPTY);
  same(validReason("a"), ok("a"));
  same(validReason(a(512)), ok(a(512)));
  same(validReason(a(513)), TOO_LONG);
  // The same boundaries with padding the server trims
  same(validReason("   "), EMPTY);
  same(validReason(" \t a \n "), ok("a"));
  same(validReason(`  ${a(512)}  `), ok(a(512)));
  same(validReason(`\n${a(513)}\t`), TOO_LONG);
  // "header" is the default carrier
  same(validReason(a(513), "header"), TOO_LONG);
});

test("reason: surrounding whitespace is trimmed before counting and in the returned text", () => {
  const ideographic = cp(0x3000);
  const nbsp = cp(0xa0);
  same(
    validReason(`${ideographic}${nbsp} spam ${nbsp}${ideographic}`),
    ok("spam"),
  );
  // Inner whitespace is text and counts
  same(validReason(" rule 1: no spam "), ok("rule 1: no spam"));
  same(validReason(`${a(255)} ${a(256)}`), ok(`${a(255)} ${a(256)}`));
  same(validReason(`${a(256)} ${a(256)}`), TOO_LONG);
});

test("reason: control-only or invisible-format-only input is empty", () => {
  same(validReason(cp(0, 7, 0x0a, 0x09, 0x7f, 0x85, 0x9f)), EMPTY);
  same(validReason(cp(0x202e, 0x200b)), EMPTY);
  same(validReason(` ${cp(0xfeff)} ${cp(0x2066, 0x2069)} `), EMPTY);
  same(validReason(cp(0x061c, 0x2028, 0x2029)), EMPTY);
  same(validReason(` ${cp(0xfeff)}\n${cp(0x2066, 0x2069, 0x2029)} `), EMPTY);
});

test("reason: control and invisible-format chars are stripped before counting", () => {
  same(validReason("line1\nline2\ttab"), ok("line1line2tab"));
  same(validReason(`ban${cp(0x202e)}reason${cp(0x200b)}x`), ok("banreasonx"));
  // Stripped chars do not count towards the cap
  same(validReason(`${a(256)}\n${a(256)}`), ok(a(512)));
  same(validReason(`${a(512)}${cp(0x200b, 0, 0x202e)}`), ok(a(512)));
  // Stripping exposes whitespace that is then trimmed
  same(validReason(`${cp(0x202e)} x ${cp(0xfeff)}`), ok("x"));
});

test("reason: every code point is stripped, trimmed or kept exactly as the 74390c37 backend does", () => {
  // Oracles independent of the module: Cc via the engine's Unicode tables,
  // the pinned backend set, and the engine's \s for the trim (equal to
  // Rust's White_Space once Cc and the invisible set are stripped).
  const mismatches: string[] = [];
  for (let point = 0; point <= 0x10ffff && mismatches.length < 10; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    const ch = cp(point);
    const stripped = /\p{Cc}/u.test(ch) || inRustInvisible(point);
    const inner = validReason(`a${ch}b`);
    const innerWant = stripped ? "ab" : `a${ch}b`;
    if (!inner.ok || inner.reason !== innerWant) {
      mismatches.push(`inner U+${point.toString(16)}`);
    }
    const edge = validReason(`${ch}a`);
    const edgeWant = stripped || /\s/u.test(ch) ? "a" : `${ch}a`;
    if (!edge.ok || edge.reason !== edgeWant) {
      mismatches.push(`edge U+${point.toString(16)}`);
    }
  }
  same(mismatches, []);
  // Neighbours named by the backend's own tests survive inside the text
  for (const point of [
    0x200a, 0x2010, 0x2070, 0xfefe, 0xe9, 0x061b, 0x061d, 0x2027, 0x202f,
    0x180e,
  ]) {
    same(validReason(`a${cp(point)}b`), ok(`a${cp(point)}b`));
  }
});

test("reason: the cap counts code points, not UTF-16 units (astral chars at the cap)", () => {
  assert.equal(GRIN.repeat(512).length, 1024);
  same(validReason(GRIN.repeat(512)), ok(GRIN.repeat(512)));
  same(validReason(GRIN.repeat(513)), TOO_LONG);
  same(validReason(`${a(511)}${GRIN}`), ok(`${a(511)}${GRIN}`));
  same(validReason(`${a(512)}${GRIN}`), TOO_LONG);
  // A surrogate pair is never split
  same(validReason(` ${GRIN} `), ok(GRIN));
});

test("reason: the cap counts code points, not UTF-8 bytes (BMP multi-byte chars at the cap)", () => {
  assert.equal(new TextEncoder().encode(CHECK.repeat(512)).length, 1536);
  same(validReason(CHECK.repeat(512)), ok(CHECK.repeat(512)));
  same(validReason(CHECK.repeat(513)), TOO_LONG);
  same(validReason(E_ACUTE.repeat(512)), ok(E_ACUTE.repeat(512)));
  same(validReason(E_ACUTE.repeat(513)), TOO_LONG);
  same(validReason(`caf${E_ACUTE} ${CHECK}`), ok(`caf${E_ACUTE} ${CHECK}`));
});

test("reason: a lone surrogate becomes U+FFFD, counts as one char and can be percent-encoded", () => {
  const lone = String.fromCharCode(0xd800);
  const loneLow = String.fromCharCode(0xdc00);
  assert.throws(() => encodeURIComponent(lone));
  same(validReason(lone), ok(FFFD));
  same(validReason(`a${loneLow}b`), ok(`a${FFFD}b`));
  const atCap = validReason(`${a(511)}${lone}`);
  same(atCap, ok(`${a(511)}${FFFD}`));
  assert.ok(atCap.ok);
  assert.equal(encodeURIComponent(atCap.reason), `${a(511)}%EF%BF%BD`);
  same(validReason(`${a(512)}${loneLow}`), TOO_LONG);
});

test("reason: the returned text is a fixed point (checking it again changes nothing)", () => {
  for (const raw of [
    "  trimmed  ",
    `spam${cp(0x202e)}evil${cp(0x200b)}`,
    `${cp(0x3000)} x\ty ${cp(0x2029)}`,
    `${a(500)}${GRIN.repeat(12)}`,
    `${String.fromCharCode(0xd83d)} x`,
  ]) {
    const first = validReason(raw);
    assert.ok(first.ok, ascii(raw));
    same(validReason(first.reason), first, ascii(raw));
  }
});

test("reason: a ban body allows 1..=1024 chars, the header carrier 512", () => {
  assert.equal(BAN_REASON_MAX_CHARS, 1024);
  same(validReason("", "ban_body"), EMPTY);
  same(validReason(cp(0x200b), "ban_body"), EMPTY);
  same(validReason(a(600), "ban_body"), ok(a(600)));
  same(validReason(a(600), "header"), TOO_LONG);
  same(validReason(a(1024), "ban_body"), ok(a(1024)));
  same(validReason(a(1025), "ban_body"), TOO_LONG);
  same(validReason(` ${a(1024)}\n`, "ban_body"), ok(a(1024)));
  same(validReason(GRIN.repeat(1024), "ban_body"), ok(GRIN.repeat(1024)));
  same(validReason(GRIN.repeat(1025), "ban_body"), TOO_LONG);
});

test("reason: a non-string input is empty", () => {
  for (const value of [undefined, null, 5, {}, ["reason"]]) {
    same(validReason(value as unknown as string), EMPTY);
  }
});

// ---- reasonRefusal ----

const TOO_LONG_BODY = {
  type: "FailedValidation",
  error: "AuditLogReasonTooLong",
};

test("refusal: AuditLogReasonTooLong maps to too_long, the local check's own name", () => {
  assert.equal(reasonRefusal(TOO_LONG_BODY), "too_long");
  const local = validReason(a(513));
  assert.ok(!local.ok);
  assert.equal(reasonRefusal(TOO_LONG_BODY), local.why);
});

test("refusal: the raw body text stoat.js throws maps the same way", () => {
  assert.equal(reasonRefusal(JSON.stringify(TOO_LONG_BODY)), "too_long");
  assert.equal(
    reasonRefusal(
      '{"type":"FailedValidation","error":"AuditLogReasonTooLong"}',
    ),
    "too_long",
  );
});

test("refusal: any other error, RemovalReasonRequired included, is not mapped", () => {
  for (const other of [
    { type: "RemovalReasonRequired" },
    '{"type":"RemovalReasonRequired"}',
    { type: "FailedValidation", error: "reason: Validation error: length" },
    { type: "FailedValidation", error: "AuditLogReasonTooLong " },
    { type: "FailedValidation" },
    { type: "AuditLogReasonTooLong" },
    { error: "AuditLogReasonTooLong" },
    [TOO_LONG_BODY],
    "AuditLogReasonTooLong",
    "not json",
    "",
    null,
    undefined,
    400,
  ]) {
    assert.equal(reasonRefusal(other), null, JSON.stringify(other));
  }
});

// ---- backend source ----

const GATE_COPY = "/home/mcp/pc-logs/s2/w4/be-74390c37";
const BACKEND =
  process.env.SLOGA_BACKEND_DIR ?? (existsSync(GATE_COPY) ? GATE_COPY : "");
const SOURCE = {
  reason: "crates/core/database/src/util/audit_reason.rs",
  kick: "crates/delta/src/routes/servers/member_remove.rs",
  ban: "crates/delta/src/routes/servers/ban_create.rs",
  seats: "crates/delta/src/routes/channels/seats_put.rs",
  banBody: "crates/core/models/src/v0/server_bans.rs",
  result: "crates/core/result/src/lib.rs",
};
const backendPresent =
  BACKEND !== "" && existsSync(join(BACKEND, SOURCE.reason));
if (!backendPresent) {
  console.warn(
    "[protectedRemovalReasonPolicy.test] backend source absent: the source check SKIPS",
  );
}

/** Parse the `matches!` arms of `is_invisible_format`. */
function parseInvisible(source: string): [number, number][] {
  const start = source.indexOf("fn is_invisible_format(c: char) -> bool {");
  assert.ok(start >= 0, "is_invisible_format not found");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const out: [number, number][] = [];
  const arm = /'\\u\{([0-9A-Fa-f]+)\}'(?:\s*\.\.=\s*'\\u\{([0-9A-Fa-f]+)\}')?/g;
  for (const m of body.matchAll(arm)) {
    const lo = parseInt(m[1], 16);
    out.push([lo, m[2] === undefined ? lo : parseInt(m[2], 16)]);
  }
  return out;
}

test(
  "backend source: the reason rules, caps, routes and refusal body still match",
  { skip: backendPresent ? false : "backend source absent" },
  () => {
    const read = (rel: string) => readFileSync(join(BACKEND, rel), "utf8");
    const reason = read(SOURCE.reason);
    const cap = /pub const AUDIT_LOG_REASON_MAX_CHARS: usize = (\d+);/.exec(
      reason,
    );
    assert.ok(cap);
    assert.equal(Number(cap[1]), AUDIT_LOG_REASON_MAX_CHARS);
    // Sanitize (strip, then trim) BEFORE the cap, counted in chars
    const validated = reason.slice(reason.indexOf("pub fn validated(self)"));
    const sanitizeAt = validated.indexOf("sanitize_reason_text(&raw)");
    const countAt = validated.indexOf(
      "if reason.chars().count() > AUDIT_LOG_REASON_MAX_CHARS {",
    );
    assert.ok(sanitizeAt >= 0 && countAt > sanitizeAt);
    assert.ok(
      reason.includes(
        ".filter(|c| !c.is_control() && !is_invisible_format(*c))",
      ),
    );
    assert.ok(reason.includes("let trimmed = stripped.trim();"));
    assert.ok(
      reason.includes(
        'FailedValidation {\n                error: "AuditLogReasonTooLong".to_string(),',
      ),
    );
    assert.deepEqual(parseInvisible(reason), RUST_INVISIBLE_74390c37);

    // Kick: header reason validated first, then the requirement
    const kick = read(SOURCE.kick);
    assert.ok(
      kick.includes(
        "    reason: AuditLogReason,\n) -> Result<EmptyResponse> {",
      ),
    );
    assert.ok(kick.includes("let reason = reason.validated()?;"));
    assert.ok(
      kick.includes(
        "refuse_removal_without_reason(db, &server.id, reason.as_deref()).await?;",
      ),
    );
    assert.ok(kick.includes("Ok(channel) if channel.is_protected() => {"));

    // Ban: the sanitized BODY reason, no header; body cap 1024
    const ban = read(SOURCE.ban);
    assert.ok(
      ban.includes(
        "let audit_reason = data.reason.as_deref().and_then(sanitize_reason_text);",
      ),
    );
    assert.ok(
      ban.includes(
        "refuse_removal_without_reason(db, &server.id, audit_reason.as_deref()).await?;",
      ),
    );
    const banCap =
      /validate\(length\(min = 0, max = (\d+)\)\)\)\]\n\s*pub reason: Option<String>,/.exec(
        read(SOURCE.banBody),
      );
    assert.ok(banCap);
    assert.equal(Number(banCap[1]), BAN_REASON_MAX_CHARS);

    // Seat PUT: header reason, validated (same 512 cap)
    const seats = read(SOURCE.seats);
    assert.ok(
      seats.includes("    reason: AuditLogReason,\n    target: Reference<'_>,"),
    );
    assert.ok(seats.includes("let reason = reason.validated()?;"));

    // The refusal body: `type` + `error`, location never serialized
    const result = read(SOURCE.result);
    assert.ok(result.includes('serde(tag = "type")'));
    assert.ok(
      result.includes("    FailedValidation {\n        error: String,\n    },"),
    );
    assert.ok(
      result.includes(
        "serde(skip_serializing, default))]\n    pub location: String,",
      ),
    );
    assert.ok(result.includes("    RemovalReasonRequired,\n"));
  },
);
