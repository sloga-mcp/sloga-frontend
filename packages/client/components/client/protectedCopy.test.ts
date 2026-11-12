/**
 * Run with:
 *
 *     node --conditions=browser --test components/client/protectedCopy.test.ts
 *
 * Covers the copy decisions `protectedCopy.ts` makes in code (S2 W4-3 F2):
 *
 * - a client failure `authority_needs_v2` (`signOwnerDevices` with no v2
 *   seat list held and `formats_v2` off) gets its own copy through
 *   `errorUiCopy`, where the shield answers its catch-all; only a client
 *   failure, only a notice;
 * - the removal reason copy names the cap the policy checks: 512 for the
 *   audit header (kick, unseat), 1024 for a ban body; `empty` has its own.
 *
 * `@lingui/core/macro` only runs inside the build, so a module hook swaps it
 * for a stand-in `t` that fills in the values. The asserted text is the
 * source text with its values (the msgid once placeholders are named), not a
 * catalog lookup: a msgid missing from the catalog is the L9 lingui gate's.
 * The inputs are the real ones: `protectedNoticeForError` maps the failure
 * with `{ op: "owner" }` as the owner UI does, and the reason verdicts come
 * from `validReason` / `reasonRefusal`.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type {
  RemovalReasonCarrier,
  RemovalReasonProblem,
} from "./protectedRemovalReasonPolicy.ts";
import {
  AUDIT_LOG_REASON_MAX_CHARS,
  BAN_REASON_MAX_CHARS,
  reasonRefusal,
  validReason,
} from "./protectedRemovalReasonPolicy.ts";
import type { ProtectedErrorUi } from "./protectedShield.ts";
import { protectedNoticeForError } from "./protectedShield.ts";

const COPY_URL = new URL("./protectedCopy.ts", import.meta.url).href;
const MACRO_STUB = "protectedcopy-test:lingui-macro";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@lingui/core/macro" && context.parentURL === COPY_URL) {
      return { url: MACRO_STUB, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === MACRO_STUB) {
      return {
        format: "module",
        shortCircuit: true,
        // Tagged template: the parts with the values filled in. Descriptor
        // (`t({ message, comment })`): the message.
        source: `export function t(first, ...values) {
  if (Array.isArray(first) && "raw" in first) {
    return first.reduce(
      (out, part, i) => out + part + (i < values.length ? String(values[i]) : ""),
      "",
    );
  }
  if (first !== null && typeof first === "object" && typeof first.message === "string") {
    return first.message;
  }
  throw new Error("unexpected t() call");
}`,
      };
    }
    return nextLoad(url, context);
  },
});

const {
  CLIENT_REASONS_WITH_COPY,
  errorUiCopy,
  noticeCopy,
  reasonEmptyCopy,
  reasonProblemCopy,
  reasonTooLongCopy,
}: typeof import("./protectedCopy.ts") = await import(COPY_URL);

const AUTHORITY_NEEDS_V2 =
  "This channel's member list uses an older format, so its signing devices can't be changed yet. Try again later.";
const CATCH_ALL = "Something went wrong verifying this channel.";
const TOO_LONG_HEADER = "Use a shorter reason (up to 512 characters).";
const TOO_LONG_BAN = "Use a shorter reason (up to 1024 characters).";
const EMPTY = "Add a reason to continue.";

/** As `protectedTextOwner.ts` throws it (`clientFailure`). */
const authorityFailure = { source: "client", reason: "authority_needs_v2" };

/** The owner UI's composition (seat picker, channel settings). */
function ownerCopy(failure: unknown): string | null {
  return errorUiCopy(protectedNoticeForError(failure, { op: "owner" }), {
    failure,
  });
}

// --------------------------------------------------- authority_needs_v2 --

test("authority_needs_v2: the owner UI shows its own copy, not the catch-all", () => {
  assert.deepEqual([...CLIENT_REASONS_WITH_COPY], ["authority_needs_v2"]);
  const text = ownerCopy(authorityFailure);
  assert.equal(text, AUTHORITY_NEEDS_V2);
  assert.notEqual(text, CATCH_ALL);
});

test("authority_needs_v2: only a client failure; the same text from native or server keeps its mapping", () => {
  for (const failure of [
    { source: "server", reason: "authority_needs_v2" },
    { source: "native", reason: "authority_needs_v2" },
    { reason: "authority_needs_v2" },
    "authority_needs_v2",
  ]) {
    const ui = protectedNoticeForError(failure, { op: "owner" });
    assert.equal(
      errorUiCopy(ui, { failure }),
      errorUiCopy(ui),
      JSON.stringify(failure),
    );
    assert.notEqual(errorUiCopy(ui, { failure }), AUTHORITY_NEEDS_V2);
  }
});

test("authority_needs_v2: other client reasons and callers without the failure are unchanged", () => {
  // A listed client reason keeps its notice; an unlisted one the catch-all.
  assert.equal(
    ownerCopy({ source: "client", reason: "protect_failed" }),
    noticeCopy("protect_failed"),
  );
  assert.equal(
    ownerCopy({ source: "client", reason: "publish_refused" }),
    CATCH_ALL,
  );
  // Today's callers pass no failure: the notice's own text.
  const ui: ProtectedErrorUi = {
    kind: "notice",
    notice: "unverified",
    max: null,
    tag: "unknown",
  };
  assert.equal(errorUiCopy(ui), CATCH_ALL);
  assert.equal(errorUiCopy(ui, {}), CATCH_ALL);
});

test("authority_needs_v2: a marker, toast or none is never replaced", () => {
  const failure = authorityFailure;
  assert.equal(errorUiCopy({ kind: "none", tag: "client" }, { failure }), null);
  assert.equal(
    errorUiCopy({ kind: "marker", marker: "error", tag: "x" }, { failure }),
    "Something went wrong verifying this message.",
  );
  assert.equal(
    errorUiCopy(
      { kind: "toast", toast: "unsolicited_welcome", tag: "x" },
      { failure },
    ),
    "Blocked an unexpected invitation to a protected channel.",
  );
});

// ------------------------------------------------------- removal reason --

test("too_long: the audit header cap (kick, unseat) is 512 and the copy names it", () => {
  assert.equal(AUDIT_LOG_REASON_MAX_CHARS, 512);
  assert.equal(reasonTooLongCopy(AUDIT_LOG_REASON_MAX_CHARS), TOO_LONG_HEADER);
});

test("too_long: the ban body cap is 1024 and the copy names it", () => {
  assert.equal(BAN_REASON_MAX_CHARS, 1024);
  assert.equal(reasonTooLongCopy(BAN_REASON_MAX_CHARS), TOO_LONG_BAN);
});

test("reason verdicts: validReason and reasonRefusal map to their copy with the carrier's cap", () => {
  const header = AUDIT_LOG_REASON_MAX_CHARS;
  const ban = BAN_REASON_MAX_CHARS;
  const verdict = (
    s: string,
    carrier: RemovalReasonCarrier,
  ): RemovalReasonProblem => {
    const r = validReason(s, carrier);
    if (r.ok) assert.fail(`${carrier} ${s.length}: accepted`);
    return r.why;
  };
  assert.equal(
    reasonProblemCopy(verdict("x".repeat(513), "header"), header),
    TOO_LONG_HEADER,
  );
  assert.equal(
    reasonProblemCopy(verdict("x".repeat(1025), "ban_body"), ban),
    TOO_LONG_BAN,
  );
  // Blank once the zero-width space is stripped and the rest trimmed.
  const blank = " " + String.fromCodePoint(0x200b) + "\n";
  assert.equal(reasonProblemCopy(verdict(blank, "header"), header), EMPTY);
  assert.equal(reasonProblemCopy(verdict("", "ban_body"), ban), EMPTY);
  assert.equal(reasonEmptyCopy(), EMPTY);
  // The server's over-long refusal reads as the local check does.
  const refused = reasonRefusal({
    type: "FailedValidation",
    error: "AuditLogReasonTooLong",
  });
  assert.equal(refused, "too_long");
  assert.equal(reasonProblemCopy(refused ?? "empty", header), TOO_LONG_HEADER);
});
