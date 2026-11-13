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
 *   audit header (kick, unseat), 1024 for a ban body; `empty` has its own;
 * - the kick/ban hint shown before a press says the rule is server-wide; it
 *   is not the server refusal's "this member is protected" notice;
 * - S2-D42 (lane U11b): the four `moveOwnerKey` client refusals get their
 *   own copy the same way, native `handover_target_invalid` reads as "that
 *   device hasn't joined" on the owner op only, and the server settings
 *   page's owner-key strings;
 * - S2 audit LOW-3: the manager's client refusals `recovery_unavailable`,
 *   `publish_in_flight`, `client_outdated`, `invalid_reason` and
 *   `create_predecessor_unknown` get their own copy from the shield's
 *   notice, so callers that pass no failure (the pill) show it too.
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

import type { ClientReasonWithCopy } from "./protectedCopy.ts";
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
  clientReasonCopy,
  errorUiCopy,
  noticeCopy,
  ownerKeyCopy,
  reasonEmptyCopy,
  reasonProblemCopy,
  reasonTooLongCopy,
  removalReasonHintCopy,
  settingsCopy,
}: typeof import("./protectedCopy.ts") = await import(COPY_URL);

const AUTHORITY_NEEDS_V2 =
  "This channel's member list uses an older format, so its signing devices can't be changed yet. Try again later.";
const CATCH_ALL = "Something went wrong verifying this channel.";
const TOO_LONG_HEADER = "Use a shorter reason (up to 512 characters).";
const TOO_LONG_BAN = "Use a shorter reason (up to 1024 characters).";
const EMPTY = "Add a reason to continue.";
const REASON_HINT =
  "This server has protected channels, so removing someone needs a reason.";
const REASON_REQUIRED_NOTICE =
  "This member is protected from removal without a reason. Add a reason to continue.";

/** S2-D42 `moveOwnerKey` client refusals and their copy (lane U11b). */
const MOVE_REFUSALS: Record<string, string> = {
  handover_self_target:
    "Choose another of your devices to move the ownership key to.",
  handover_target_not_own:
    "You can only move the ownership key to another of your own devices.",
  not_signing_device:
    "Only the device that holds this channel's ownership key can move it.",
  authority_held:
    "This channel names its owner devices. Update that list to move ownership instead.",
};
const NOT_JOINED =
  "That device hasn't joined this channel yet. Open the channel on it, then try again.";

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
  // U11b added the four `moveOwnerKey` refusals (spec'd below).
  assert.deepEqual(
    [...CLIENT_REASONS_WITH_COPY],
    ["authority_needs_v2", ...Object.keys(MOVE_REFUSALS)],
  );
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

// ------------------------------------------- S2-D42 move ownership key --

test("move ownership key: each moveOwnerKey refusal has its own owner copy", () => {
  const seen = new Set<string>();
  for (const [reason, want] of Object.entries(MOVE_REFUSALS)) {
    const failure = { source: "client", reason };
    // The shield answers its catch-all; the copy layer names the cause.
    assert.equal(
      protectedNoticeForError(failure, { op: "owner" }).kind,
      "notice",
    );
    const text = ownerCopy(failure);
    assert.equal(text, want, reason);
    assert.notEqual(text, CATCH_ALL, reason);
    assert.equal(clientReasonCopy(reason as ClientReasonWithCopy), want);
    seen.add(want);
    // Only a client failure: the same reason from native or server keeps
    // its own mapping.
    for (const other of [
      { source: "native", reason },
      { source: "server", reason },
    ]) {
      assert.notEqual(ownerCopy(other), want, `${other.source} ${reason}`);
    }
  }
  assert.equal(seen.size, 4, "four distinct texts");
  // The page's line under a served authority is the same refusal copy.
  assert.equal(ownerKeyCopy.authorityHeld(), MOVE_REFUSALS.authority_held);
});

test("move ownership key: native handover_target_invalid reads as 'not joined' for the owner only", () => {
  const failure = {
    source: "native",
    error: { type: "handover_target_invalid", channel_id: "C1" },
  };
  assert.equal(ownerCopy(failure), NOT_JOINED);
  assert.equal(noticeCopy("handover_target_not_joined"), NOT_JOINED);
  // Off the owner op it stays the generic copy.
  for (const op of ["channel", "send", "action"] as const) {
    assert.equal(
      errorUiCopy(protectedNoticeForError(failure, { op }), { failure }),
      CATCH_ALL,
      op,
    );
  }
});

test("move ownership key: the page's copy", () => {
  assert.equal(ownerKeyCopy.moveKey(), "Move ownership key to another device");
  assert.equal(
    ownerKeyCopy.choose(),
    "Choose the device to move this channel's ownership key to.",
  );
  assert.equal(ownerKeyCopy.unnamedDevice(), "Unnamed device");
  assert.equal(ownerKeyCopy.cancel(), "Cancel");
  assert.equal(
    ownerKeyCopy.onOtherDevice(),
    "This channel's ownership key is on another of your devices. Open this page on that device to move it.",
  );
});

// ------------------------------------ S2 client refusals (audit LOW-3) --

/**
 * The manager's own client refusals (protectedText.ts / protectedTextOwner
 * `clientFailure(...)`) and their copy. `client_outdated` is the step 3c
 * notice's text and `publish_in_flight` the settings page's line.
 */
const CLIENT_REFUSALS: Record<string, string> = {
  recovery_unavailable:
    "Ownership can't be recovered on this device right now.",
  publish_in_flight:
    "Saving the member list. You can make more changes when this finishes.",
  client_outdated: "Update Sloga to use this protected channel.",
  invalid_reason: "This reason can't be used. Check it and try again.",
  create_predecessor_unknown:
    "This channel's group couldn't be re-created right now. Try again later.",
};

test("S2 LOW-3: each client refusal has its own copy, with or without the failure passed", () => {
  const seen = new Set<string>();
  for (const [reason, want] of Object.entries(CLIENT_REFUSALS)) {
    const failure = { source: "client", reason };
    // The seat picker / settings / device-cap composition passes the failure.
    assert.equal(ownerCopy(failure), want, reason);
    // The pill (`run`) and the server settings page call errorUiCopy(answer)
    // without it: the shield's notice carries the copy on its own.
    const answer = protectedNoticeForError(failure, { op: "owner" });
    assert.deepEqual(
      answer,
      { kind: "notice", notice: reason, max: null, tag: "client" },
      reason,
    );
    assert.equal(errorUiCopy(answer), want, reason);
    assert.notEqual(errorUiCopy(answer), CATCH_ALL, reason);
    seen.add(want);
    // Every op but `message` names the cause (client_outdated also comes
    // from the send path's ensureJoined); a row never gets a notice.
    for (const op of ["channel", "send", "action", "transfer"] as const) {
      assert.equal(
        errorUiCopy(protectedNoticeForError(failure, { op }), { failure }),
        want,
        `${reason}/${op}`,
      );
    }
    assert.deepEqual(protectedNoticeForError(failure, { op: "message" }), {
      kind: "marker",
      marker: "error",
      tag: "unknown",
    });
    // Only a client failure: the same reason from native or server keeps
    // its own mapping.
    for (const other of [
      { source: "native", reason },
      { source: "server", reason },
    ]) {
      assert.notEqual(ownerCopy(other), want, `${other.source} ${reason}`);
    }
  }
  assert.equal(seen.size, 5, "five distinct texts");
  // Reused wording, not a second msgid.
  assert.equal(CLIENT_REFUSALS.client_outdated, noticeCopy("client_outdated"));
  assert.equal(
    CLIENT_REFUSALS.publish_in_flight,
    settingsCopy.publishInFlight(),
  );
});

test("S2 LOW-3: the copy names no id and blames no one", () => {
  for (const text of Object.values(CLIENT_REFUSALS)) {
    assert.doesNotMatch(text, /\b(id|ids|key|keys)\b|\{|\}/i, text);
    assert.doesNotMatch(text, /\byou(r)? (did|made|broke|failed)\b/i, text);
    assert.ok(text.length <= 80, `short: ${text}`);
  }
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

test("removal reason hint: server-wide copy, not the member-protected refusal notice", () => {
  assert.equal(removalReasonHintCopy(), REASON_HINT);
  // The server refusal keeps the 9.2 notice; the hint never reuses it.
  assert.equal(noticeCopy("removal_reason_required"), REASON_REQUIRED_NOTICE);
  assert.notEqual(removalReasonHintCopy(), REASON_REQUIRED_NOTICE);
});
