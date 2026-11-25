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
 * - S2 live leg (lane FXC): `SeatListNamesRemovedUsers` is a refused save
 *   through `errorUiCopy` ("wasn't saved", the names only when every user
 *   resolved and at most `REMOVED_NAMES_LISTED_MAX`), and the owner page's
 *   note through `noticeCopy` (they will be left off); neither names a
 *   release cause, since any of the four gets there.
 * - S4 (W4 lane L1c): the history copy. Every marker, history stop, toast,
 *   note, divider, settings, backup and audit key has its own text; a walk
 *   that stopped `hidden` never reads like a loud stop and only `unanchored`
 *   promises another try; a new device "can read this channel's history"
 *   only when the caller says history is visible; a count shows only as a
 *   whole number; the S1 strings are the ones C0 had.
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
import type {
  HistoryStop,
  ProtectedMarkerKind,
  ProtectedToastKind,
  TimelineMarker,
} from "./protectedTextTypes.ts";

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
  REMOVED_NAMES_LISTED_MAX,
  auditActionLabel,
  auditCopy,
  backupNoteCopy,
  backupTextCopy,
  clientReasonCopy,
  dividerCopy,
  errorUiCopy,
  markerCopy,
  messageCopy,
  noticeCopy,
  ownerKeyCopy,
  reasonEmptyCopy,
  reasonProblemCopy,
  reasonTooLongCopy,
  removalReasonHintCopy,
  rowNoteCopy,
  rowStateCopy,
  settingsCopy,
  timelineCopy,
  toastCopy,
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
  // U11b added the four `moveOwnerKey` refusals (spec'd below); S4 added
  // `protect_busy`, the W4 fix round the two "protected, with something
  // left out" reasons and its second round three more (all spec'd with the
  // S4 copy).
  assert.deepEqual(
    [...CLIENT_REASONS_WITH_COPY],
    [
      "authority_needs_v2",
      ...Object.keys(MOVE_REFUSALS),
      "protect_busy",
      "protected_members_pending",
      "wipe_not_done",
      "protected_members_unconfirmed",
      "wipe_not_done_members_pending",
      "wipe_not_done_members_unconfirmed",
    ],
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

// --------------------------------- SeatListNamesRemovedUsers (lane FXC) --

// The live leg's refusal came from a member who lost access to the channel
// (`access_lost`), and the save it refused left nobody off: nothing landed.
const REFUSED =
  "The seat list wasn't saved because it includes members who no longer have a seat.";
const REFUSED_NAMED = (list: string) =>
  `The seat list wasn't saved because it includes members who no longer have a seat: ${list}`;
const LEFT_OFF_NOTE =
  "Some members no longer have a seat. They'll be left off the next seat list you save.";

const REMOVED_A = "01USERREMOVEDA000000000000";
const REMOVED_B = "01USERREMOVEDB000000000000";

/** The seat PUT refusal as the owner flows throw it (protectedShield.test). */
const removedFailure = (users: string[]) => ({
  source: "server",
  status: 400,
  type: "SeatListNamesRemovedUsers",
  body: { type: "SeatListNamesRemovedUsers", users },
});

/**
 * The seat picker / settings page / device-cap composition: the real
 * mapping with `{ op: "owner" }`, the failure and a name resolver.
 */
function refusedCopy(
  users: string[],
  names: (string | null)[] | undefined,
): string | null {
  const failure = removedFailure(users);
  const ui = protectedNoticeForError(failure, { op: "owner" });
  assert.equal(
    ui.kind === "notice" && ui.notice,
    "seat_list_names_removed_users",
  );
  return errorUiCopy(ui, {
    failure,
    ...(names === undefined ? {} : { removedUserNames: () => names }),
  });
}

test("FXC removed users: a refused save says it wasn't saved and names who, when it can", () => {
  assert.equal(
    refusedCopy([REMOVED_A, REMOVED_B], ["Bob", " Carol "]),
    REFUSED_NAMED("Bob, Carol"),
  );
  assert.equal(refusedCopy([REMOVED_A], ["Bob"]), REFUSED_NAMED("Bob"));
  // Exactly the cap still lists them.
  const atCap = Array.from(
    { length: REMOVED_NAMES_LISTED_MAX },
    (_, i) => `U${i}`,
  );
  const atCapNames = atCap.map((_, i) => `Name${i}`);
  assert.equal(
    refusedCopy(atCap, atCapNames),
    REFUSED_NAMED(atCapNames.join(", ")),
  );
});

test("FXC removed users: anything less than every user resolved gets the generic refusal", () => {
  const over = Array.from(
    { length: REMOVED_NAMES_LISTED_MAX + 1 },
    (_, i) => `U${i}`,
  );
  const cases: [string[], (string | null)[] | undefined, string][] = [
    [[REMOVED_A, REMOVED_B], undefined, "no resolver (the pill)"],
    [[REMOVED_A, REMOVED_B], ["Bob", null], "one unresolved"],
    [[REMOVED_A, REMOVED_B], ["Bob", "  "], "one blank"],
    [[REMOVED_A, REMOVED_B], ["Bob", REMOVED_B], "one is its id"],
    [[REMOVED_A, REMOVED_B], ["Bob"], "misaligned"],
    [over, over.map((_, i) => `Name${i}`), "over the cap"],
    [[], [], "no users reported"],
  ];
  for (const [users, names, label] of cases) {
    assert.equal(refusedCopy(users, names), REFUSED, label);
  }
  // A bare server body (no `source`) and the pill's call without opts.
  const bare = protectedNoticeForError(
    { type: "SeatListNamesRemovedUsers", users: [REMOVED_A] },
    { op: "owner" },
  );
  assert.equal(errorUiCopy(bare), REFUSED);
});

test("FXC removed users: the owner page's note is not a refusal and ignores names", () => {
  assert.equal(noticeCopy("seat_list_names_removed_users"), LEFT_OFF_NOTE);
  assert.equal(
    noticeCopy("seat_list_names_removed_users", null, ["Bob"]),
    LEFT_OFF_NOTE,
  );
  assert.notEqual(LEFT_OFF_NOTE, REFUSED);
  assert.doesNotMatch(LEFT_OFF_NOTE, /saved because|wasn't saved/);
});

test("FXC removed users: no copy names a release cause or claims a server removal", () => {
  for (const text of [
    REFUSED,
    REFUSED_NAMED("Bob"),
    LEFT_OFF_NOTE,
    refusedCopy([REMOVED_A], ["Bob"]),
    refusedCopy([REMOVED_A], undefined),
    noticeCopy("seat_list_names_removed_users"),
  ]) {
    assert.ok(text !== null);
    assert.doesNotMatch(
      text,
      /removed from|this server|kicked|banned|lost access|left the/i,
      text,
    );
    assert.doesNotMatch(text, /\b(id|ids)\b|01USER/i, text);
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

// ------------------------------------------------ FXT F-L13 poisoned copy --

const OWNER_HAS_TO_ACT =
  " so this device can't read new messages here. The channel owner has to re-create the protected group from their device; that doesn't happen automatically.";
const RESECURING_TAIL = " Re-securing with a new group…";
const OP_REFUSED =
  "This change was refused because it isn't valid for this channel.";

/** A native refusal as the owner UI receives it (`ownerCopy`). */
const nativeRefusal = (type: string) => ({
  source: "native",
  error: { type, group_id: "G", user_id: "U", device_id: "D" },
});

test("FXT F-L13: a poisoned group on any device but the signer says the owner has to re-create it, and never that it re-secures by itself", () => {
  for (const ctx of [undefined, {}, { signingDevice: false }]) {
    assert.equal(
      noticeCopy("replayed_change", null, null, null, ctx),
      "This channel received a replayed membership change," + OWNER_HAS_TO_ACT,
    );
    assert.equal(
      noticeCopy("invalid_change", null, null, null, ctx),
      "A member made an invalid change to this channel," + OWNER_HAS_TO_ACT,
    );
  }
  for (const kind of ["replayed_change", "invalid_change"] as const) {
    assert.doesNotMatch(noticeCopy(kind), /Re-securing/i);
  }
});

test("FXT F-L13: on the device that signs the member list (it re-creates the group itself) the poisoned notice says it is re-securing, with no wait for the owner", () => {
  const ctx = { signingDevice: true };
  assert.equal(
    noticeCopy("replayed_change", null, null, null, ctx),
    "This channel received a replayed membership change." + RESECURING_TAIL,
  );
  assert.equal(
    noticeCopy("invalid_change", null, null, null, ctx),
    "A member made an invalid change to this channel." + RESECURING_TAIL,
  );
  for (const kind of ["replayed_change", "invalid_change"] as const) {
    assert.doesNotMatch(
      noticeCopy(kind, null, null, null, ctx),
      /owner has to|can't read/,
    );
  }
});

test("FXT F-L13: an operation refusal mapped to these kinds poisons nothing: a neutral refusal, no claim about reading messages", () => {
  for (const type of [
    "duplicate_leaf",
    "commit_declaration_mismatch",
    "mls_leaf_rejected",
    "replayed_rejoin_intent",
  ]) {
    const text = ownerCopy(nativeRefusal(type));
    assert.equal(text, OP_REFUSED, type);
    assert.doesNotMatch(text ?? "", /read new messages|Re-securing|owner has/);
  }
  // A channel-op roster refusal maps to invalid_change too.
  assert.equal(
    errorUiCopy(
      protectedNoticeForError(nativeRefusal("roster_mismatch"), {
        op: "channel",
      }),
    ),
    OP_REFUSED,
  );
});

// ------------------------------------------------ FXP F-L6 no-group copy --

const NO_GROUP_REFUSED =
  "This channel's protected group failed a security check on this device, so this device hasn't joined it and can't read new messages here.";

test("FXP F-L6: a device holding no group (its own join was refused; signer or not) reads that the group failed its security check: never that it is only joining, never a wait for the owner, never a re-secure or a retry promise", () => {
  const ctx = { signingDevice: "no_group" as const };
  for (const kind of ["replayed_change", "invalid_change"] as const) {
    const text = noticeCopy(kind, null, null, null, ctx);
    assert.equal(text, NO_GROUP_REFUSED, kind);
    assert.match(text, /failed a security check/, kind);
    assert.doesNotMatch(
      text,
      /owner|Re-securing|re-create|finish joining|again|automatically/i,
      kind,
    );
  }
  // The two answers for a device holding the poisoned group are unchanged.
  assert.equal(
    noticeCopy("invalid_change", null, null, null, { signingDevice: true }),
    "A member made an invalid change to this channel." + RESECURING_TAIL,
  );
  assert.equal(
    noticeCopy("invalid_change", null, null, null, { signingDevice: false }),
    "A member made an invalid change to this channel," + OWNER_HAS_TO_ACT,
  );
  // Only the poisoned-group kinds read it.
  assert.notEqual(
    noticeCopy("join_stalled", null, null, null, ctx),
    NO_GROUP_REFUSED,
  );
});

// ------------------------------------------------- S4 history copy (L1c) --

const MESSAGE_CATCH_ALL = "Something went wrong verifying this message.";
const SENT_BEFORE_JOIN = "Sent before this device joined.";
const SENDER_NOT_VERIFIED =
  "The sender's device isn't verified on this device yet.";

/**
 * Every marker kind and its text. `Record` over the union: a kind added to
 * `ProtectedMarkerKind` fails tsc here. All but `removed_self` are S1 / S2
 * arms, as they read at C0.
 */
const MARKERS: Record<ProtectedMarkerKind, string> = {
  sent_before_join: SENT_BEFORE_JOIN,
  removed_self: "Sent after you were removed.",
  unknown_key: "Sent with a key this device never had.",
  decrypt_failed: "Couldn't decrypt this message.",
  unverified_sender: "Couldn't verify the sender. This message may be forged.",
  removed_sender: "Sent by someone who was removed from this channel.",
  replay: "Duplicate message (replayed).",
  malformed: "Unreadable message.",
  unsupported_version: "Update Sloga to see this message.",
  unencrypted_row:
    "Unencrypted message in a protected channel. It did not come from a member's protected app.",
  error: MESSAGE_CATCH_ALL,
};

const FLOOR_HIDDEN = "History from before you joined isn't shared here.";
const FLOOR_INVALID = "Earlier history couldn't be verified and wasn't loaded.";
const FLOOR_CONFLICT =
  "Two different versions of this channel's earlier history were offered, so earlier history wasn't loaded.";
const FLOOR_UNANCHORED =
  "Earlier history couldn't be confirmed yet. Sloga will try again later.";

/** Every walk stop and the line at the history floor (design 9.2). */
const FLOORS: Record<HistoryStop, string> = {
  hidden: FLOOR_HIDDEN,
  missing: SENT_BEFORE_JOIN,
  genesis: SENT_BEFORE_JOIN,
  invalid: FLOOR_INVALID,
  anchor_mismatch: FLOOR_INVALID,
  conflict: FLOOR_CONFLICT,
  unanchored: FLOOR_UNANCHORED,
};

/** Every toast kind and its text; the first two as they read at C0. */
const TOASTS: Record<ProtectedToastKind, string> = {
  unsolicited_welcome:
    "Blocked an unexpected invitation to a protected channel.",
  owner_notice:
    "Another of your devices changed a protected channel. Open the channel to see what changed.",
  history_mismatch:
    "History keys shared for a protected channel don't match. New members may not be able to read some earlier messages.",
  history_too_large:
    "Some earlier history in a protected channel can't be shared with new members: too many people joined or left at once.",
};

const ROW_NOTES = {
  sender_unverified: SENDER_NOT_VERIFIED,
  sender_unverified_history: "Sender couldn't be verified (history).",
  timing_unverified: "Timing of this message can't be verified.",
  below_boundary: "Listed among the earlier, unprotected messages.",
} as const;

const DIVIDER_KEPT = "Messages above weren't protected";
const DIVIDER_WIPED = "Earlier messages removed from this channel";

const BACKUP_TEXT = {
  oldest:
    "The oldest history from your protected channels didn't fit in this backup.",
  all: "History from your protected channels didn't fit in this backup.",
  restore_oldest:
    "The oldest history from your protected channels wasn't in the backup, so it couldn't be restored.",
  restore_all:
    "History from your protected channels wasn't in the backup, so it couldn't be restored.",
  skipped_partial:
    "Some history from your protected channels couldn't be restored.",
  skipped_all:
    "None of the history from your protected channels could be restored.",
} as const;

/** The settings page strings C0 had, with the values the page passes. */
const SETTINGS_S1: Record<string, string> = {
  title: "Protected channel",
  description:
    "Messages in a protected channel are end-to-end encrypted. Only members you give a seat can read and send messages, on devices that support Protected channels.",
  protectButton: "Protect this channel",
  protectConfirmTitle: "Protect this channel?",
  protectConfirmBody:
    "This can't be undone. A protected channel can't go back to a normal channel.",
  protecting: "Protecting\u2026",
  ownerOnly: "Only the server owner can manage this protected channel.",
  seatsHeading: "Seats",
  seatsUsed: "Seats used: 2 of 5",
  deviceCap: "Each member can use up to 3 devices.",
  addSeats: "Add seats",
  removeSeat: "Remove seat",
  noSeats: "No one has a seat yet.",
  ownerBadge: "Owner",
  publishInFlight:
    "Saving the member list. You can make more changes when this finishes.",
  seatsSaved: "Seats updated.",
  typeTogglesHidden:
    "Voice and announcement settings aren't available for protected channels.",
};

/** The S4 settings strings; the wipe count 7 is the only number. */
const SETTINGS_S4: Record<string, string> = {
  protectWithHistory:
    "Messages already in #general stay as they are, above a line that says they weren't protected. New messages are end-to-end encrypted.",
  protectOrder:
    "The channel is protected first, with only you in it. The members you pick are added right after.",
  protectClosesOpen:
    "Open polls are closed and scheduled messages are canceled when the channel is protected.",
  membersPending:
    "This channel is now protected, with only you in it. The members you picked weren't added yet. You can add them below.",
  wipeNotDone:
    "This channel is now protected, but the earlier messages were not deleted.",
  membersUnconfirmed:
    "This channel is now protected. Adding the members you picked didn't finish. Check the seats below.",
  wipeNotDoneMembersPending:
    "This channel is now protected, with only you in it. The earlier messages were not deleted, and the members you picked weren't added yet. You can add them below.",
  wipeNotDoneMembersUnconfirmed:
    "This channel is now protected, but the earlier messages were not deleted. Adding the members you picked didn't finish. Check the seats below.",
  deleteEarlierOption: "Also delete the earlier messages",
  wipeDescription:
    "Earlier messages and their files will be deleted from Sloga's servers. This can't be undone. Copies on people's devices, forwards, crossposts and reports may remain.",
  historyToggle: "New members can read earlier messages",
  historyVisibleDescription:
    "People who join later, and new devices of anyone in the channel, can read messages sent from shortly after this is turned on. Anyone in the channel can still share what they read.",
  historyHiddenDescription:
    "New members only see messages sent after they join.",
  historyRemovalNote:
    "Removing someone doesn't take back what they already read. It stays on their devices.",
  wipeButton: "Delete the earlier unprotected messages",
  wipeRequested: "The earlier messages are being deleted from Sloga's servers.",
  wipeDone: "Earlier messages deleted from Sloga's servers: 7",
  historyRetryLater:
    "Earlier history couldn't be loaded right now. Try again later.",
  historyCheckFailed: "Couldn't check this channel's history settings.",
};

const SETTINGS_ERRORS = {
  protect_busy:
    "This channel is too busy to protect right now. Try again in a quiet moment.",
  wipe_refused: "Earlier messages couldn't be deleted right now.",
  clock_behind:
    "The newest message's time is ahead of this device's clock. Check the date and time settings, or try again in a few minutes.",
} as const;

/** Under the toggle while hidden, with the earlier messages kept. */
const HIDDEN_EARLIER_KEPT =
  "New members only see protected messages sent after they join. Messages from before this channel was protected stay readable to everyone in it.";

const WIPE_DONE_NO_COUNT =
  "Earlier messages were deleted from Sloga's servers.";

const AUDIT = {
  protect: "Ann protected the channel general",
  protectWiped:
    "Ann protected the channel general and chose to delete its earlier messages",
  wipeRequest: "Ann started deleting the earlier messages in general",
  wipeDone: "The earlier messages in general were deleted (7)",
} as const;

/** The same four sentences for a channel the caller cannot name. */
const AUDIT_UNNAMED = {
  protect: "Ann protected a channel",
  protectWiped:
    "Ann protected a channel and chose to delete its earlier messages",
  wipeRequest: "Ann started deleting the earlier messages in a channel",
  wipeDone: "The earlier messages in a channel were deleted (7)",
} as const;

/** A history floor marker as the manager records it (`TimelineMarker`). */
const floorMarker = (stop: HistoryStop): TimelineMarker => ({
  kind: "history_floor",
  channelId: "01CHANNEL00000000000000000",
  groupId: "01GROUP0000000000000000000",
  epoch: 3,
  stop,
  atMs: 1,
});

const newDevice: TimelineMarker = {
  kind: "new_device",
  channelId: "01CHANNEL00000000000000000",
  groupId: "01GROUP0000000000000000000",
  epoch: 3,
  userId: "01USER00000000000000000000",
  deviceId: "DEVICEID",
  atMs: 1,
};

/** The settings strings as the page reads them. */
function settingsNow(): Record<string, string> {
  return {
    title: settingsCopy.title(),
    description: settingsCopy.description(),
    protectButton: settingsCopy.protectButton(),
    protectConfirmTitle: settingsCopy.protectConfirmTitle(),
    protectConfirmBody: settingsCopy.protectConfirmBody(),
    protecting: settingsCopy.protecting(),
    ownerOnly: settingsCopy.ownerOnly(),
    seatsHeading: settingsCopy.seatsHeading(),
    seatsUsed: settingsCopy.seatsUsed(2, 5),
    deviceCap: settingsCopy.deviceCap(3),
    addSeats: settingsCopy.addSeats(),
    removeSeat: settingsCopy.removeSeat(),
    noSeats: settingsCopy.noSeats(),
    ownerBadge: settingsCopy.ownerBadge(),
    publishInFlight: settingsCopy.publishInFlight(),
    seatsSaved: settingsCopy.seatsSaved(),
    typeTogglesHidden: settingsCopy.typeTogglesHidden(),
    protectWithHistory: settingsCopy.protectWithHistory("general"),
    protectOrder: settingsCopy.protectOrder(),
    protectClosesOpen: settingsCopy.protectClosesOpen(),
    membersPending: settingsCopy.membersPending(),
    wipeNotDone: settingsCopy.wipeNotDone(),
    membersUnconfirmed: settingsCopy.membersUnconfirmed(),
    wipeNotDoneMembersPending: settingsCopy.wipeNotDoneMembersPending(),
    wipeNotDoneMembersUnconfirmed: settingsCopy.wipeNotDoneMembersUnconfirmed(),
    deleteEarlierOption: settingsCopy.deleteEarlierOption(),
    wipeDescription: settingsCopy.wipeDescription(),
    historyToggle: settingsCopy.historyToggle(),
    historyVisibleDescription: settingsCopy.historyVisibleDescription(),
    historyHiddenDescription: settingsCopy.historyHiddenDescription(false),
    historyRemovalNote: settingsCopy.historyRemovalNote(),
    wipeButton: settingsCopy.wipeButton(),
    wipeRequested: settingsCopy.wipeRequested(),
    wipeDone: settingsCopy.wipeDone(7),
    historyRetryLater: settingsCopy.historyRetryLater(),
    historyCheckFailed: settingsCopy.historyCheckFailed(),
  };
}

test("S4 markers: removed_self reads its own line, not the sent-before-join one", () => {
  assert.equal(markerCopy("removed_self"), "Sent after you were removed.");
  assert.notEqual(markerCopy("removed_self"), SENT_BEFORE_JOIN);
  assert.notEqual(markerCopy("removed_self"), MESSAGE_CATCH_ALL);
});

test("S4 markers: every marker kind has its own text and the S1 arms are unchanged", () => {
  const kinds = Object.keys(MARKERS) as ProtectedMarkerKind[];
  assert.equal(kinds.length, 11);
  for (const kind of kinds) {
    assert.equal(markerCopy(kind), MARKERS[kind], kind);
  }
  assert.equal(new Set(kinds.map((k) => markerCopy(k))).size, kinds.length);
});

test("S4 history floor: every stop has its line and names no one", () => {
  const stops = Object.keys(FLOORS) as HistoryStop[];
  assert.equal(stops.length, 7);
  for (const stop of stops) {
    const text = timelineCopy(floorMarker(stop), "Ann");
    assert.equal(text, FLOORS[stop], stop);
    assert.doesNotMatch(text, /Ann|01CHANNEL|01GROUP|\d/, stop);
    // The history-visible option belongs to a new device only.
    assert.equal(
      timelineCopy(floorMarker(stop), "Ann", { historyVisible: true }),
      FLOORS[stop],
      stop,
    );
  }
});

test("S4 history floor: a hidden stop never reads like a loud one", () => {
  const hidden = timelineCopy(floorMarker("hidden"), "");
  assert.equal(hidden, FLOOR_HIDDEN);
  for (const stop of [
    "invalid",
    "anchor_mismatch",
    "conflict",
    "unanchored",
  ] as const) {
    assert.notEqual(timelineCopy(floorMarker(stop), ""), hidden, stop);
  }
  assert.notEqual(hidden, SENT_BEFORE_JOIN);
  // Four different lines in all, plus the S1 marker's.
  assert.equal(new Set(Object.values(FLOORS)).size, 5);
});

test("S4 history floor: missing and genesis read the S1 sent-before-join line", () => {
  for (const stop of ["missing", "genesis"] as const) {
    assert.equal(
      timelineCopy(floorMarker(stop), ""),
      markerCopy("sent_before_join"),
      stop,
    );
  }
});

test("S4 history floor: only unanchored promises another try", () => {
  const stops = Object.keys(FLOORS) as HistoryStop[];
  for (const stop of stops) {
    const text = timelineCopy(floorMarker(stop), "");
    assert.equal(/try again|later/i.test(text), stop === "unanchored", stop);
  }
  // A mismatched anchor is a refused candidate, as `invalid` is.
  assert.equal(timelineCopy(floorMarker("anchor_mismatch"), ""), FLOOR_INVALID);
  assert.equal(timelineCopy(floorMarker("unanchored"), ""), FLOOR_UNANCHORED);
});

test("S4 history floor: every refused stop says earlier history wasn't loaded", () => {
  for (const stop of ["invalid", "anchor_mismatch", "conflict"] as const) {
    assert.match(timelineCopy(floorMarker(stop), ""), /wasn't loaded/, stop);
  }
  assert.match(timelineCopy(floorMarker("unanchored"), ""), /couldn't be/);
});

test("S4 timeline: a new device can read history only when the caller says history is visible", () => {
  const visible = "Ann added a new device. It can read this channel's history.";
  const s1 = "Ann added a new device.";
  assert.equal(
    timelineCopy(newDevice, "Ann", { historyVisible: true }),
    visible,
  );
  assert.equal(timelineCopy(newDevice, "Ann"), s1);
  assert.equal(timelineCopy(newDevice, "Ann", {}), s1);
  assert.equal(timelineCopy(newDevice, "Ann", { historyVisible: false }), s1);
  // Only a literal true: an older caller's value never widens the claim.
  for (const loose of [undefined, null, 1, "true", "visible"]) {
    assert.equal(
      timelineCopy(newDevice, "Ann", { historyVisible: loose as never }),
      s1,
      String(loose),
    );
  }
  // The S1 forced-removal line is unchanged, with or without the option.
  const removed: TimelineMarker = {
    kind: "forced_removal",
    channelId: "01CHANNEL00000000000000000",
    groupId: "01GROUP0000000000000000000",
    epoch: 3,
    userId: "01USER00000000000000000000",
    atMs: 1,
  };
  const forced =
    "Ann was removed by the server and can't rejoin until the owner re-seats them.";
  assert.equal(timelineCopy(removed, "Ann"), forced);
  assert.equal(timelineCopy(removed, "Ann", { historyVisible: true }), forced);
});

test("S4 toasts: every toast kind has its own text and the S2 ones are unchanged", () => {
  const kinds = Object.keys(TOASTS) as ProtectedToastKind[];
  assert.equal(kinds.length, 4);
  for (const kind of kinds) assert.equal(toastCopy(kind), TOASTS[kind], kind);
  assert.equal(new Set(kinds.map((k) => toastCopy(k))).size, kinds.length);
  for (const kind of ["history_mismatch", "history_too_large"] as const) {
    assert.notEqual(toastCopy(kind), CATCH_ALL, kind);
  }
});

test("S4 row notes: four notes, each its own, the S1 note unchanged", () => {
  const kinds = Object.keys(ROW_NOTES) as (keyof typeof ROW_NOTES)[];
  for (const kind of kinds) assert.equal(rowNoteCopy(kind), ROW_NOTES[kind]);
  assert.equal(new Set(kinds.map((k) => rowNoteCopy(k))).size, 4);
  // The S1 note is the one message rows already show.
  assert.equal(rowNoteCopy("sender_unverified"), SENDER_NOT_VERIFIED);
  assert.equal(messageCopy.senderNotVerified(), SENDER_NOT_VERIFIED);
});

test("S4 row notes: the history sender note is never the S1 text", () => {
  assert.notEqual(
    rowNoteCopy("sender_unverified_history"),
    rowNoteCopy("sender_unverified"),
  );
  assert.match(rowNoteCopy("sender_unverified_history"), /\(history\)/);
  // No note reads as a pass.
  for (const text of Object.values(ROW_NOTES)) {
    assert.doesNotMatch(text, /\bis verified\b|\bwas verified\b/, text);
  }
});

test("S4 row state: checking has its own line", () => {
  // The catalog's existing msgid (R-W4-27), written as "Decrypting" is.
  assert.equal(
    rowStateCopy("checking"),
    "Checking" + String.fromCodePoint(0x2026),
  );
  assert.notEqual(rowStateCopy("checking"), messageCopy.pending());
  assert.notEqual(rowStateCopy("checking"), markerCopy("unencrypted_row"));
});

test("S4 divider: kept says the messages above weren't protected, wiped that they were removed from this channel", () => {
  assert.equal(dividerCopy("kept"), DIVIDER_KEPT);
  assert.equal(dividerCopy("wiped"), DIVIDER_WIPED);
  assert.notEqual(dividerCopy("kept"), dividerCopy("wiped"));
  // R-W4-36: the signed line proves the request, not a finished deletion.
  assert.doesNotMatch(dividerCopy("wiped"), /deleted/i);
});

test("FX3O FF4: both divider labels are short enough for one line, and the wiped one still says removed from this channel", () => {
  // One 11 px line in a row about 290 px wide on a 320 px phone.
  for (const kind of ["kept", "wiped"] as const) {
    assert.ok(dividerCopy(kind).length <= 42, kind);
    assert.doesNotMatch(dividerCopy(kind), /\.$/, kind);
  }
  assert.match(dividerCopy("wiped"), /removed from this channel$/);
});

test("FX3O FO2: the history-on description says sharing starts shortly after it is turned on, never from the moment it is on", () => {
  const text = settingsCopy.historyVisibleDescription();
  assert.match(text, /sent from shortly after this is turned on\./);
  assert.doesNotMatch(text, /while this is on/);
  // The rest of the claim is unchanged: joiners, new devices, sharing.
  assert.match(text, /^People who join later, and new devices of anyone/);
  assert.match(text, /Anyone in the channel can still share what they read\.$/);
});

test("FX3O FO3: the protect form says open polls are closed and scheduled messages are canceled, and nothing else", () => {
  assert.equal(
    settingsCopy.protectClosesOpen(),
    "Open polls are closed and scheduled messages are canceled when the channel is protected.",
  );
  // US spelling, and no claim about the messages themselves.
  assert.doesNotMatch(settingsCopy.protectClosesOpen(), /cancelled|deleted/);
});

test("FX3O FF6: the line after an unanswered check is its own text, neither the checking line nor the retry line", () => {
  const text = settingsCopy.historyCheckFailed();
  assert.equal(text, "Couldn't check this channel's history settings.");
  assert.notEqual(text, rowStateCopy("checking"));
  assert.notEqual(text, settingsCopy.historyRetryLater());
});

test("S4 settings: the S1 strings are unchanged and the page has exactly these keys", () => {
  const now = settingsNow();
  for (const [key, want] of Object.entries(SETTINGS_S1)) {
    assert.equal(now[key], want, key);
  }
  assert.deepEqual(
    Object.keys(settingsCopy).sort(),
    [
      ...Object.keys(SETTINGS_S1),
      ...Object.keys(SETTINGS_S4),
      "historyError",
    ].sort(),
  );
});

test("S4 settings: each history string has its own text", () => {
  const now = settingsNow();
  for (const [key, want] of Object.entries(SETTINGS_S4)) {
    assert.equal(now[key], want, key);
  }
  assert.equal(
    new Set(Object.values(now)).size,
    Object.keys(now).length,
    "no two settings keys share a string",
  );
  // The two toggle descriptions say opposite things.
  assert.notEqual(
    settingsCopy.historyVisibleDescription(),
    settingsCopy.historyHiddenDescription(false),
  );
});

test("FXO B3: hidden history with the earlier messages kept says those stay readable to everyone", () => {
  assert.equal(
    settingsCopy.historyHiddenDescription(true),
    HIDDEN_EARLIER_KEPT,
  );
  assert.equal(
    settingsCopy.historyHiddenDescription(false),
    SETTINGS_S4.historyHiddenDescription,
  );
  // Only a literal true picks the kept line.
  for (const loose of ["true", 1, {}, null, undefined]) {
    assert.equal(
      settingsCopy.historyHiddenDescription(loose as never),
      SETTINGS_S4.historyHiddenDescription,
      String(loose),
    );
  }
  assert.match(HIDDEN_EARLIER_KEPT, /stay readable to everyone/);
  // The plain line would be false there: it promises new members see
  // nothing from before they joined.
  assert.doesNotMatch(HIDDEN_EARLIER_KEPT, /only see messages sent/);
});

test("FXO B12: the clock line blames neither side, and the removal note speaks about members, not the reader", () => {
  const clock = settingsCopy.historyError("clock_behind");
  assert.doesNotMatch(clock, /clock is behind/);
  assert.match(clock, /or try again/);
  assert.doesNotMatch(settingsCopy.historyRemovalNote(), /\byou\b/i);
});

test("FXO B2 B7: protected with the members or the ticked wipe left out reads its own line through the owner UI, never the fail-closed one", () => {
  const pending = { source: "client", reason: "protected_members_pending" };
  const missed = { source: "client", reason: "wipe_not_done" };
  assert.equal(ownerCopy(pending), SETTINGS_S4.membersPending);
  assert.equal(ownerCopy(missed), SETTINGS_S4.wipeNotDone);
  assert.equal(
    clientReasonCopy("protected_members_pending"),
    settingsCopy.membersPending(),
  );
  assert.equal(clientReasonCopy("wipe_not_done"), settingsCopy.wipeNotDone());
  for (const text of [SETTINGS_S4.membersPending, SETTINGS_S4.wipeNotDone]) {
    assert.notEqual(text, CATCH_ALL);
    assert.notEqual(text, noticeCopy("protect_failed"));
    // Both say the channel IS protected; neither reads as a failed protect.
    assert.match(text, /^This channel is now protected/);
    assert.doesNotMatch(text, /couldn't|failed|error/i);
  }
  // What each proves and no more: the wipe line says nothing about members
  // or how to delete later; the members line nothing about deleting.
  assert.match(SETTINGS_S4.wipeNotDone, /were not deleted\.$/);
  assert.doesNotMatch(SETTINGS_S4.wipeNotDone, /member|below/);
  assert.doesNotMatch(SETTINGS_S4.membersPending, /delet/);
  // Only a client failure: the same reason from elsewhere keeps its mapping.
  for (const reason of [
    "protected_members_pending",
    "wipe_not_done",
    "protected_members_unconfirmed",
    "wipe_not_done_members_pending",
    "wipe_not_done_members_unconfirmed",
  ]) {
    for (const other of [
      { source: "native", reason },
      { source: "server", reason },
      { reason },
    ]) {
      assert.equal(ownerCopy(other), CATCH_ALL, JSON.stringify(other));
    }
  }
});

test("FX2O RB2 RB3: a member step that rejected over a seat list that is not the owner alone never says only you, and a missed wipe with a failed member step says both", () => {
  const lines = {
    protected_members_unconfirmed: SETTINGS_S4.membersUnconfirmed,
    wipe_not_done_members_pending: SETTINGS_S4.wipeNotDoneMembersPending,
    wipe_not_done_members_unconfirmed:
      SETTINGS_S4.wipeNotDoneMembersUnconfirmed,
  } as const;
  for (const [reason, text] of Object.entries(lines)) {
    assert.equal(ownerCopy({ source: "client", reason }), text, reason);
    assert.equal(clientReasonCopy(reason as keyof typeof lines), text);
    assert.notEqual(text, CATCH_ALL);
    assert.notEqual(text, noticeCopy("protect_failed"));
    assert.match(text, /^This channel is now protected/);
    assert.doesNotMatch(text, /couldn't|failed|error/i);
  }
  // RB2: with more than the owner seated (or the seats unread) the line
  // claims nothing about who is in the channel, and points at the list.
  for (const text of [
    SETTINGS_S4.membersUnconfirmed,
    SETTINGS_S4.wipeNotDoneMembersUnconfirmed,
  ]) {
    assert.doesNotMatch(text, /only you|weren't added|were added|You can add/);
    assert.match(text, /didn't finish\. Check the seats below\.$/);
  }
  assert.doesNotMatch(SETTINGS_S4.membersUnconfirmed, /delet/);
  // RB3: both things left out are both said.
  for (const text of [
    SETTINGS_S4.wipeNotDoneMembersPending,
    SETTINGS_S4.wipeNotDoneMembersUnconfirmed,
  ]) {
    assert.match(text, /earlier messages were not deleted/);
    assert.match(text, /members you picked/);
  }
  assert.match(SETTINGS_S4.wipeNotDoneMembersPending, /with only you in it/);
  assert.match(SETTINGS_S4.wipeNotDoneMembersPending, /weren't added yet/);
  // The five outcome lines are five different lines.
  assert.equal(
    new Set([
      SETTINGS_S4.membersPending,
      SETTINGS_S4.wipeNotDone,
      ...Object.values(lines),
    ]).size,
    5,
  );
});

test("FXO safety: a client reason this build does not know still reads the fail-closed line", () => {
  for (const reason of [
    "protected_members_pendin",
    "wipe_not_done_",
    "wipe_not_done_members",
    "protected_members",
    "members_unconfirmed",
    "WIPE_NOT_DONE",
    "wipe_done",
    "later_reason",
    "",
  ]) {
    assert.equal(ownerCopy({ source: "client", reason }), CATCH_ALL, reason);
  }
  assert.equal(ownerCopy({ source: "client" }), CATCH_ALL);
  assert.equal(ownerCopy(new Error("x")), CATCH_ALL);
});

test("S4 settings: protect with history names the channel only when it has a name", () => {
  const unnamed =
    "Messages already in this channel stay as they are, above a line that says they weren't protected. New messages are end-to-end encrypted.";
  for (const blank of [null, "", "   "]) {
    assert.equal(settingsCopy.protectWithHistory(blank), unnamed);
  }
  assert.equal(
    settingsCopy.protectWithHistory(" general "),
    SETTINGS_S4.protectWithHistory,
  );
});

test("S4 settings: the wipe result shows only a whole count of 0 or more", () => {
  assert.equal(settingsCopy.wipeDone(7), SETTINGS_S4.wipeDone);
  assert.equal(
    settingsCopy.wipeDone(0),
    "Earlier messages deleted from Sloga's servers: 0",
  );
  for (const bad of [
    null,
    undefined,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
    "7",
    {},
  ]) {
    assert.equal(
      settingsCopy.wipeDone(bad as never),
      WIPE_DONE_NO_COUNT,
      String(bad),
    );
  }
});

test("S4 settings: each inline error has its own text", () => {
  const kinds = Object.keys(
    SETTINGS_ERRORS,
  ) as (keyof typeof SETTINGS_ERRORS)[];
  for (const kind of kinds) {
    assert.equal(settingsCopy.historyError(kind), SETTINGS_ERRORS[kind], kind);
    assert.notEqual(settingsCopy.historyError(kind), CATCH_ALL, kind);
  }
  assert.equal(new Set(kinds.map((k) => settingsCopy.historyError(k))).size, 3);
  // A refused wipe gives no cause.
  assert.doesNotMatch(SETTINGS_ERRORS.wipe_refused, /hold|legal|owner/i);
});

test("S4 protect_busy: the client refusal reads the busy line through the owner UI", () => {
  const busy =
    "This channel is too busy to protect right now. Try again in a quiet moment.";
  const failure = { source: "client", reason: "protect_busy" };
  assert.equal(ownerCopy(failure), busy);
  assert.equal(clientReasonCopy("protect_busy"), busy);
  // One string: the settings page's inline error is the same line.
  assert.equal(settingsCopy.historyError("protect_busy"), busy);
  assert.notEqual(ownerCopy(failure), CATCH_ALL);
  assert.notEqual(ownerCopy(failure), noticeCopy("protect_failed"));
  // Only a client failure: the same reason from native or server keeps its
  // own mapping.
  for (const other of [
    { source: "native", reason: "protect_busy" },
    { source: "server", reason: "protect_busy" },
    { reason: "protect_busy" },
  ]) {
    assert.notEqual(ownerCopy(other), busy, JSON.stringify(other));
  }
});

test("S4 backup: six lines, each its own, and the one general note", () => {
  const kinds = Object.keys(BACKUP_TEXT) as (keyof typeof BACKUP_TEXT)[];
  for (const kind of kinds) {
    assert.equal(backupTextCopy(kind), BACKUP_TEXT[kind], kind);
  }
  assert.equal(new Set(kinds.map((k) => backupTextCopy(k))).size, 6);
  // RB11: the design's "Restoring replaces your old device." is gone; a
  // restore adds a device and nothing rendered the line.
  assert.deepEqual(Object.keys(backupNoteCopy), ["textBudget"]);
  assert.equal(
    backupNoteCopy.textBudget(),
    "History from protected channels uses up to 2 MB of your backup, so fewer direct messages may fit.",
  );
});

test("S4 backup: a partly restored history never reads like a wholly skipped one", () => {
  assert.notEqual(
    backupTextCopy("skipped_partial"),
    backupTextCopy("skipped_all"),
  );
  assert.match(backupTextCopy("skipped_partial"), /^Some /);
  assert.match(backupTextCopy("skipped_all"), /^None /);
  assert.notEqual(backupTextCopy("oldest"), backupTextCopy("all"));
  assert.match(backupTextCopy("oldest"), /^The oldest /);
});

test("FX2O RB7: the two restore lines talk about the restore, never about this backup, and repeat no other backup line", () => {
  const restore = [
    backupTextCopy("restore_oldest"),
    backupTextCopy("restore_all"),
  ];
  for (const text of restore) {
    assert.doesNotMatch(text, /this backup|didn't fit/);
    assert.match(text, /wasn't in the backup, so it couldn't be restored\.$/);
  }
  assert.match(restore[0], /^The oldest history /);
  assert.match(restore[1], /^History /);
  assert.notEqual(restore[0], restore[1]);
  // Shown under a bundle line on the same page: never the same sentence.
  for (const bundle of [backupTextCopy("oldest"), backupTextCopy("all")]) {
    assert.match(bundle, /this backup\.$/);
    assert.ok(!restore.includes(bundle));
  }
});

test("S4 audit: the protect and wipe sentences and the two filter labels", () => {
  const who = { actor: "Ann", channel: "general" };
  assert.equal(auditCopy("channel_protect", who), AUDIT.protect);
  assert.equal(
    auditCopy("channel_protect", { ...who, wiped: false }),
    AUDIT.protect,
  );
  assert.equal(
    auditCopy("channel_protect", { ...who, wiped: true }),
    AUDIT.protectWiped,
  );
  assert.equal(auditCopy("channel_history_wipe", who), AUDIT.wipeRequest);
  assert.equal(
    auditCopy("channel_history_wipe", { ...who, count: null }),
    AUDIT.wipeRequest,
  );
  assert.equal(
    auditCopy("channel_history_wipe", { ...who, count: 7 }),
    AUDIT.wipeDone,
  );
  assert.equal(
    auditCopy("channel_history_wipe", { ...who, count: 0 }),
    "The earlier messages in general were deleted (0)",
  );
  assert.equal(new Set(Object.values(AUDIT)).size, 4);
  // A channel name is passed through as it was given.
  assert.equal(
    auditCopy("channel_protect", { actor: "Ann", channel: " #general " }),
    "Ann protected the channel  #general ",
  );
  assert.equal(auditActionLabel("channel_protect"), "Protect channel");
  assert.equal(
    auditActionLabel("channel_history_wipe"),
    "Delete earlier messages",
  );
});

test("FXO C13: without a channel name the audit sentence keeps the protect or wipe fact and names no channel", () => {
  for (const channel of [null, "", "   ", undefined]) {
    const who = { actor: "Ann", channel: channel as never };
    assert.equal(auditCopy("channel_protect", who), AUDIT_UNNAMED.protect);
    assert.equal(
      auditCopy("channel_protect", { ...who, wiped: true }),
      AUDIT_UNNAMED.protectWiped,
    );
    assert.equal(
      auditCopy("channel_history_wipe", who),
      AUDIT_UNNAMED.wipeRequest,
    );
    assert.equal(
      auditCopy("channel_history_wipe", { ...who, count: 7 }),
      AUDIT_UNNAMED.wipeDone,
    );
    // The same strictness as with a name.
    assert.equal(
      auditCopy("channel_protect", { ...who, wiped: "true" as never }),
      AUDIT_UNNAMED.protect,
    );
    assert.equal(
      auditCopy("channel_history_wipe", { ...who, count: "7" as never }),
      AUDIT_UNNAMED.wipeRequest,
    );
  }
  const named = Object.values(AUDIT) as string[];
  const unnamed = Object.values(AUDIT_UNNAMED) as string[];
  assert.equal(new Set([...named, ...unnamed]).size, 8);
  for (const text of unnamed) {
    // Never the generic sentence, and nothing shaped like an id or a
    // placeholder where the name would be.
    assert.notEqual(text, "Ann performed an action");
    assert.match(text, / a channel\b/);
    assert.doesNotMatch(text, /null|undefined|#|[0-9A-HJKMNP-TV-Z]{26}/);
  }
});

test("S4 audit: only a literal true is a wipe and only a whole count is shown", () => {
  const who = { actor: "Ann", channel: "general" };
  for (const loose of ["false", "true", 1, {}, null]) {
    assert.equal(
      auditCopy("channel_protect", { ...who, wiped: loose as never }),
      AUDIT.protect,
      String(loose),
    );
  }
  for (const bad of ["7", -1, 1.5, Number.NaN, 2 ** 53, {}]) {
    assert.equal(
      auditCopy("channel_history_wipe", { ...who, count: bad as never }),
      AUDIT.wipeRequest,
      String(bad),
    );
  }
  // A count belongs to the wipe entry only, and a wipe flag to the protect.
  assert.equal(
    auditCopy("channel_protect", { ...who, count: 7 }),
    AUDIT.protect,
  );
  assert.equal(
    auditCopy("channel_history_wipe", { ...who, wiped: true }),
    AUDIT.wipeRequest,
  );
});

test("S4 copy: every string is its own, plain ASCII, and carries no placeholder, id or number but the wipe count", () => {
  // key -> [text, the digits it may carry]
  const all: Record<string, [string, string]> = {
    "marker.removed_self": [markerCopy("removed_self"), ""],
    "floor.hidden": [timelineCopy(floorMarker("hidden"), "Ann"), ""],
    "floor.invalid": [timelineCopy(floorMarker("invalid"), "Ann"), ""],
    "floor.conflict": [timelineCopy(floorMarker("conflict"), "Ann"), ""],
    "floor.unanchored": [timelineCopy(floorMarker("unanchored"), "Ann"), ""],
    "timeline.new_device_history": [
      timelineCopy(newDevice, "Ann", { historyVisible: true }),
      "",
    ],
    "toast.history_mismatch": [toastCopy("history_mismatch"), ""],
    "toast.history_too_large": [toastCopy("history_too_large"), ""],
    "note.sender_unverified_history": [
      rowNoteCopy("sender_unverified_history"),
      "",
    ],
    "note.timing_unverified": [rowNoteCopy("timing_unverified"), ""],
    "note.below_boundary": [rowNoteCopy("below_boundary"), ""],
    "divider.kept": [dividerCopy("kept"), ""],
    "divider.wiped": [dividerCopy("wiped"), ""],
    "settings.protectWithHistoryUnnamed": [
      settingsCopy.protectWithHistory(null),
      "",
    ],
    "settings.wipeDoneNoCount": [settingsCopy.wipeDone(null), ""],
    "settings.historyHiddenEarlierKept": [
      settingsCopy.historyHiddenDescription(true),
      "",
    ],
    "backup.textBudget": [backupNoteCopy.textBudget(), "2"],
    "audit.label.protect": [auditActionLabel("channel_protect"), ""],
    "audit.label.wipe": [auditActionLabel("channel_history_wipe"), ""],
    "audit.protect": [AUDIT.protect, ""],
    "audit.protectWiped": [AUDIT.protectWiped, ""],
    "audit.wipeRequest": [AUDIT.wipeRequest, ""],
    "audit.wipeDone": [AUDIT.wipeDone, "7"],
    "audit.unnamed.protect": [AUDIT_UNNAMED.protect, ""],
    "audit.unnamed.protectWiped": [AUDIT_UNNAMED.protectWiped, ""],
    "audit.unnamed.wipeRequest": [AUDIT_UNNAMED.wipeRequest, ""],
    "audit.unnamed.wipeDone": [AUDIT_UNNAMED.wipeDone, "7"],
  };
  const now = settingsNow();
  for (const key of Object.keys(SETTINGS_S4)) {
    all[`settings.${key}`] = [now[key], key === "wipeDone" ? "7" : ""];
  }
  for (const kind of Object.keys(SETTINGS_ERRORS)) {
    all[`settings.error.${kind}`] = [
      settingsCopy.historyError(kind as keyof typeof SETTINGS_ERRORS),
      "",
    ];
  }
  for (const kind of Object.keys(BACKUP_TEXT)) {
    all[`backup.${kind}`] = [
      backupTextCopy(kind as keyof typeof BACKUP_TEXT),
      "",
    ];
  }
  // `rowStateCopy("checking")` is not here: it reuses a msgid the catalog
  // already had, ellipsis character included.
  // 41 from the lanes, 8 from the W4 fix round: three settings lines, the
  // kept variant of the hidden description, four unnamed audit sentences.
  // Its second round: three more settings lines and two restore lines in,
  // "Restoring replaces your old device." out.
  // Final audit round: the polls line of the protect form and the line
  // after an unanswered check.
  assert.equal(Object.keys(all).length, 55);

  const seen = new Map<string, string>();
  // The strings that were there before S4 count too.
  for (const [kind, text] of Object.entries(MARKERS)) {
    if (kind !== "removed_self") seen.set(text, `S1 marker ${kind}`);
  }
  for (const [key, text] of Object.entries(SETTINGS_S1)) {
    seen.set(text, `S1 settings ${key}`);
  }
  for (const text of [
    CATCH_ALL,
    SENDER_NOT_VERIFIED,
    TOASTS.unsolicited_welcome,
    TOASTS.owner_notice,
    timelineCopy(newDevice, "Ann"),
    messageCopy.pending(),
    messageCopy.tsSkew(),
  ]) {
    seen.set(text, "S1");
  }
  for (const [key, [text, digits]] of Object.entries(all)) {
    assert.ok(text.length > 0, key);
    assert.equal(seen.get(text), undefined, `${key} repeats ${seen.get(text)}`);
    seen.set(text, key);
    // Printable ASCII: no dash or ellipsis character, no control character.
    assert.match(text, /^[\x20-\x7e]+$/, key);
    assert.doesNotMatch(text, /[{}$!]|undefined|null|NaN|\[object/, key);
    // Nothing shaped like an id (a ULID is 26 characters of base 32).
    assert.doesNotMatch(text, /[0-9A-HJKMNP-TV-Z]{26}/, key);
    assert.equal(text.replace(/\D/g, ""), digits, key);
    assert.equal(text, text.trim(), key);
  }
});

test("S4 copy: a kind this build does not know reads the fail-closed line", () => {
  assert.equal(
    timelineCopy(floorMarker("later_stop" as never), "Ann"),
    CATCH_ALL,
  );
  assert.equal(markerCopy("later_kind" as never), MESSAGE_CATCH_ALL);
  assert.equal(toastCopy("later_kind" as never), CATCH_ALL);
  assert.equal(rowNoteCopy("later_kind" as never), MESSAGE_CATCH_ALL);
  assert.equal(rowStateCopy("later_kind" as never), MESSAGE_CATCH_ALL);
  assert.equal(dividerCopy("later_kind" as never), CATCH_ALL);
  assert.equal(settingsCopy.historyError("later_kind" as never), CATCH_ALL);
  assert.equal(backupTextCopy("later_kind" as never), CATCH_ALL);
  assert.equal(
    auditCopy("later_action" as never, { actor: "Ann", channel: "general" }),
    "Ann performed an action",
  );
});
