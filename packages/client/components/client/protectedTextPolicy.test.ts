// Unit spec for the Protected channels text-plane policy (W4 lane A3) — run
// with Node's built-in runner:
//   node --test --conditions=browser components/client/protectedTextPolicy.test.ts
// Focus (plan 7 "policy"): the publish loop (429 header ms, body unit by
// error type, backoff, no attempt cap), an unresolved publish blocks
// signing, the protect read-back matrix, `classifySubmit` on every D20
// branch (incl. a refusal that raced a winning own insert, NotSeated on a
// resubmit, 409 Resecuring is not a Lost), `classifySendAnswer` with the
// unknown-outcome rule, M5, and the envelope classifier for every text tag.
// The plan 7 named mutation controls in this module each have a test below
// marked "control:". W4d (lane L-MGR): the own-send binding (X#4, control
// C-X4) and `not_member` on a send and a commit (X#5, C-X5a / C-X5b). S7 C9
// (the tests named "C9 protector ..."): the protector back-off reducers and
// the `protector` envelope verdict (EL-F7, AND-F13). S2-W4 lane L1p (the
// tests named "S2 ..."): `holdsCurrentGroup` (OR-8), the `_commit_won`
// removal labels (OR-5), `catch_up_leaf_unresolvable` (S2-D31) and
// `joinRefusal` (OR-4, OR-11).
import assert from "node:assert/strict";
import { test } from "node:test";

import { SHIELD_LOUD_GROUP_ERRORS } from "./protectedShield.ts";
import {
  type CapacityReason,
  type PublishAnswer,
  type PublishStep,
  type SendContext,
  type SendTrigger,
  type SubmitContext,
  type TextEnvelopeVerdict,
  ADMIT_REFUSED_CAP,
  admitRefusalKey,
  admitRefusedByNative,
  classifySendAnswer,
  classifySubmit,
  classifyTextEnvelopeError,
  coalescedRefreshReason,
  COMMIT_CAP_REFUSALS,
  CONFIRM_WINDOW_MS,
  confirmAfterId,
  errorTypeOf,
  holdsCurrentGroup,
  isCatchUpDesync,
  isProtectorError,
  JOIN_EVENT_RESET_GAP_MS,
  JOIN_REBROADCAST,
  JOIN_RETRIES,
  JOIN_RETRY_MS,
  joinEventResetAllowed,
  joinRebroadcastDelayMs,
  joinRefusal,
  LEAF_STAGGER_MS,
  leafMissingApplies,
  leafMissingSigner,
  leafMissingSpent,
  leafStaggerMs,
  MAX_TEXT_LEAVES,
  ownAddedEntry,
  ownSendRowBinds,
  parkedReplay,
  PROTECTOR_BACKOFF,
  PROTECTOR_GATE_OPEN,
  protectorBackoffMs,
  protectorGateAfter,
  protectorGateStep,
  PUBLISH_BACKOFF,
  publishBackoffMs,
  publishResolved,
  publishStep,
  REFRESH_INTERVAL_MS,
  resolveProtectReadBack,
  RETRY_AFTER_MAX_MS,
  retryAfterMs,
  ROSTER_MISMATCH_GRACE_MS,
  signAllowed,
  SIGNER_LEAF_MISSING_BUDGET,
  STORED_ADMIT_REASONS,
  storedJoinRequests,
  WELCOME_FETCH_AFTER_MS,
  WELCOME_FETCH_RETRY_BUDGET,
  welcomeDue,
  welcomeFetchStep,
  welcomeParkedFor,
  welcomePending,
} from "./protectedTextPolicy.ts";
import {
  type ProtectedChannelView,
  type SignedSeatList,
  type TextApiResponse,
  type TextChannelState,
  type TextGroupState,
  type TextLeftReason,
  type TextVerdict,
  TEXT_NATIVE_ERROR_TAGS,
} from "./protectedTextTypes.ts";

const res = (
  status: number,
  body: unknown = null,
  resetAfterMs: number | null = null,
): TextApiResponse => ({ status, body, resetAfterMs });

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

test("budgets are the plan's values", () => {
  assert.equal(JOIN_RETRIES, 3);
  assert.equal(JOIN_RETRY_MS, 10_000);
  assert.equal(SIGNER_LEAF_MISSING_BUDGET, 3);
  assert.equal(ROSTER_MISMATCH_GRACE_MS, 60_000);
  assert.equal(REFRESH_INTERVAL_MS, 60_000);
  assert.deepEqual(PUBLISH_BACKOFF, { startMs: 250, capMs: 30_000 });
  assert.equal(LEAF_STAGGER_MS, 2_000);
  assert.equal(CONFIRM_WINDOW_MS, 300_000);
});

test("errorTypeOf reads the serde tag only", () => {
  assert.equal(errorTypeOf({ type: "NotSeated" }), "NotSeated");
  assert.equal(errorTypeOf({ type: 3 }), null);
  assert.equal(errorTypeOf([{ type: "NotSeated" }]), null);
  assert.equal(errorTypeOf("NotSeated"), null);
  assert.equal(errorTypeOf(null), null);
});

// ---------------------------------------------------------------------------
// 429 hint + backoff
// ---------------------------------------------------------------------------

test("retryAfterMs: the X-RateLimit-Reset-After header is milliseconds", () => {
  assert.equal(retryAfterMs(res(429, null, 1500)), 1500);
  assert.equal(retryAfterMs(res(429, {}, 0)), 0);
});

test("control: 429 body retry_after is read in the unit of its error type", () => {
  // The rate limiter's own (untagged) body: milliseconds.
  assert.equal(retryAfterMs(res(429, { retry_after: 800 })), 800);
  // Route-level InSlowmode: seconds.
  assert.equal(
    retryAfterMs(res(429, { type: "InSlowmode", retry_after: 3 })),
    3000,
  );
  // A tagged body whose unit is unknown names no delay (backoff applies).
  assert.equal(
    retryAfterMs(res(429, { type: "TooManyCrossposts", retry_after: 5 })),
    null,
  );
});

test("retryAfterMs: header and body together", () => {
  // Rate-limiter 429: both are left_until_reset, equal.
  assert.equal(retryAfterMs(res(429, { retry_after: 900 }, 900)), 900);
  // InSlowmode: the header is the request bucket, the slowmode is longer.
  assert.equal(
    retryAfterMs(res(429, { type: "InSlowmode", retry_after: 4 }, 300)),
    4000,
  );
});

test("retryAfterMs: null for non-429 and for unusable hints; clamped", () => {
  assert.equal(retryAfterMs(res(200, { retry_after: 5 }, 900)), null);
  assert.equal(retryAfterMs(res(503, null, 900)), null);
  assert.equal(retryAfterMs(res(429)), null);
  assert.equal(retryAfterMs(res(429, { retry_after: -1 })), null);
  assert.equal(retryAfterMs(res(429, { retry_after: "800" })), null);
  assert.equal(retryAfterMs(res(429, { retry_after: Number.NaN })), null);
  assert.equal(retryAfterMs(res(429, null, -5)), null);
  assert.equal(retryAfterMs(res(429, null, 1e12)), RETRY_AFTER_MAX_MS);
  assert.ok(RETRY_AFTER_MAX_MS < 2 ** 31);
});

test("publishBackoffMs: 250 ms doubling to a 30 s cap, no attempt cap", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 50, 10_000].map(publishBackoffMs),
    [250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000],
  );
  assert.equal(publishBackoffMs(-3), 250);
  assert.equal(publishBackoffMs(Number.NaN), 250);
  assert.equal(publishBackoffMs(Number.POSITIVE_INFINITY), 250);
});

// ---------------------------------------------------------------------------
// Publish loop (D7)
// ---------------------------------------------------------------------------

const answer = (r: TextApiResponse): PublishAnswer => ({
  kind: "response",
  response: r,
});

test("publishStep: 2xx resolves ok for both publishes", () => {
  for (const op of ["protect", "seats"] as const) {
    for (const status of [200, 201, 204]) {
      const step = publishStep(answer(res(status)), { op, failures: 3 });
      assert.deepEqual(step, { kind: "resolved_ok" });
      assert.equal(publishResolved(step), true);
    }
  }
});

test("control: 429 is retryable, never a resolving 4xx", () => {
  for (const op of ["protect", "seats"] as const) {
    const withHint = publishStep(answer(res(429, null, 1200)), {
      op,
      failures: 0,
    });
    assert.deepEqual(withHint, {
      kind: "resend",
      delayMs: 1200,
      cause: "rate_limited",
    });
    assert.equal(publishResolved(withHint), false);
    const bare = publishStep(answer(res(429)), { op, failures: 2 });
    assert.deepEqual(bare, {
      kind: "resend",
      delayMs: 1000,
      cause: "rate_limited",
    });
    const slow = publishStep(
      answer(res(429, { type: "InSlowmode", retry_after: 2 })),
      { op, failures: 0 },
    );
    assert.deepEqual(slow, {
      kind: "resend",
      delayMs: 2000,
      cause: "rate_limited",
    });
  }
});

test("publishStep: 5xx, transport and odd statuses resend with backoff", () => {
  for (const op of ["protect", "seats"] as const) {
    for (const status of [500, 502, 503, 504, 0, 302]) {
      const step = publishStep(answer(res(status, { type: "DatabaseError" })), {
        op,
        failures: 1,
      });
      assert.deepEqual(step, {
        kind: "resend",
        delayMs: 500,
        cause: "server_error",
      });
    }
    const t = publishStep({ kind: "transport_error" }, { op, failures: 9 });
    assert.deepEqual(t, { kind: "resend", delayMs: 30000, cause: "transport" });
    assert.equal(publishResolved(t), false);
  }
});

test("publishStep: a seat PUT's non-429 4xx is a refusal", () => {
  const step = publishStep(answer(res(400, { type: "FailedValidation" })), {
    op: "seats",
    failures: 0,
  });
  assert.deepEqual(step, {
    kind: "resolved_refused",
    status: 400,
    type: "FailedValidation",
  });
  assert.equal(publishResolved(step), true);
});

test("control: a protect's non-429 4xx is never taken at face value", () => {
  for (const [status, type] of [
    [400, "InvalidOperation"],
    [401, "NotAuthenticated"],
    [403, "NotOwner"],
    [404, "NotFound"],
  ] as const) {
    const step = publishStep(answer(res(status, { type })), {
      op: "protect",
      failures: 4,
    });
    assert.deepEqual(step, { kind: "read_back", status, type });
    assert.equal(publishResolved(step), false);
  }
});

test("control: signing is refused while a publish is unresolved", () => {
  assert.equal(
    signAllowed({ publishInFlight: true, storedPublish: null }),
    false,
  );
  assert.equal(
    signAllowed({ publishInFlight: false, storedPublish: "{...}" }),
    false,
  );
  assert.equal(
    signAllowed({ publishInFlight: true, storedPublish: "x" }),
    false,
  );
  assert.equal(
    signAllowed({ publishInFlight: false, storedPublish: null }),
    true,
  );
});

test("publish loop: sign stays refused until a resolving answer", () => {
  const answers: PublishAnswer[] = [
    { kind: "transport_error" },
    answer(res(503)),
    answer(res(429, { retry_after: 700 })),
    answer(res(502)),
    answer(res(200)),
  ];
  let inFlight = true;
  const delays: number[] = [];
  const signable: boolean[] = [];
  answers.forEach((a, failures) => {
    const step: PublishStep = publishStep(a, { op: "seats", failures });
    if (step.kind === "resend") delays.push(step.delayMs);
    inFlight = !publishResolved(step);
    signable.push(
      signAllowed({ publishInFlight: inFlight, storedPublish: null }),
    );
  });
  assert.deepEqual(delays, [250, 500, 700, 2000]);
  assert.deepEqual(signable, [false, false, false, false, true]);
});

// ---------------------------------------------------------------------------
// Protect read-back (D7b)
// ---------------------------------------------------------------------------

const GENESIS: SignedSeatList = {
  version: 1,
  body: "sloga-seat-list-v1\nv:1\nversion:1\n",
  signature: "c2lnbmF0dXJl",
  signer_user_id: "01OWNER0000000000000000000",
  signer_device_id: "a".repeat(32),
};

const serverList = (over: Record<string, unknown> = {}) => ({
  version: 1,
  body: GENESIS.body,
  signature: GENESIS.signature,
  signer_user_id: GENESIS.signer_user_id,
  signer_device_id: GENESIS.signer_device_id,
  handovers: [],
  ...over,
});

const seatsBody = (list: unknown) => ({
  list,
  as_of_epoch: null,
  as_of_group_id: null,
  entitlement_device_cap: 5,
  slot_cap: 10,
  device_cap: 5,
  seats_used: 1,
  seats: [],
  cooling: [],
});

const readBack = (
  channel: TextApiResponse | null,
  seats: TextApiResponse | null,
) => resolveProtectReadBack({ channel, seats, genesis: GENESIS });

test("read-back: landed only for our byte-identical v1 genesis", () => {
  const out = readBack(
    res(200, { _id: "c", protected: true }),
    res(200, seatsBody(serverList())),
  );
  assert.deepEqual(out, {
    kind: "landed",
    list: {
      body: GENESIS.body,
      signature: GENESIS.signature,
      signer_user_id: GENESIS.signer_user_id,
      signer_device_id: GENESIS.signer_device_id,
    },
    handovers: [],
    asOfEpoch: null,
    asOfGroupId: null,
  });
});

test("read-back: refused matrix", () => {
  const ok = res(200, seatsBody(serverList()));
  const cases: [TextApiResponse, TextApiResponse, string][] = [
    [res(200, { protected: false }), ok, "not_protected"],
    [res(200, {}), ok, "not_protected"],
    [res(200, { protected: "true" }), ok, "not_protected"],
    [res(200, { protected: true }), res(200, seatsBody(null)), "no_list"],
    [
      res(200, { protected: true }),
      res(200, seatsBody(serverList({ version: 2 }))),
      "past_genesis",
    ],
    [
      res(200, { protected: true }),
      res(200, seatsBody(serverList({ body: GENESIS.body + " " }))),
      "different_list",
    ],
    [
      res(200, { protected: true }),
      res(200, seatsBody(serverList({ signature: "b3RoZXI=" }))),
      "different_list",
    ],
    [
      res(200, { protected: true }),
      res(200, seatsBody(serverList({ signer_device_id: "b".repeat(32) }))),
      "different_list",
    ],
    [
      res(200, { protected: true }),
      res(200, seatsBody(serverList({ version: "1" }))),
      "different_list",
    ],
    [res(404, { type: "NotFound" }), ok, "unreadable"],
    [
      res(200, { protected: true }),
      res(403, { type: "MissingPermission" }),
      "unreadable",
    ],
  ];
  for (const [channel, seats, reason] of cases) {
    assert.deepEqual(readBack(channel, seats), { kind: "refused", reason });
  }
});

test("read-back: a failed read is retried, never guessed", () => {
  const ok = res(200, seatsBody(serverList()));
  const prot = res(200, { protected: true });
  for (const [c, s] of [
    [null, ok],
    [prot, null],
    [res(503), ok],
    [prot, res(500)],
    [res(429), ok],
    [prot, res(200, "<html>")],
    [res(200, null), ok],
  ] as [TextApiResponse | null, TextApiResponse | null][]) {
    assert.deepEqual(readBack(c, s), { kind: "retry" });
  }
});

// ---------------------------------------------------------------------------
// Commit outcome (D20)
// ---------------------------------------------------------------------------

const SELF = {
  user_id: "01SELF00000000000000000000",
  device_id: "d".repeat(32),
};
const OTHER = {
  user_id: "01OTHER0000000000000000000",
  device_id: "e".repeat(32),
};
const GROUP = "f".repeat(64);

const sctx = (over: Partial<SubmitContext> = {}): SubmitContext => ({
  groupId: GROUP,
  epoch: 7,
  selfUserId: SELF.user_id,
  selfDeviceId: SELF.device_id,
  ownCommitB64: "T1dO",
  resubmit: false,
  failures: 0,
  ownRemoved: null,
  ...over,
});

const row = (
  committer: { user_id: string; device_id: string },
  over: Record<string, unknown> = {},
) => ({
  group_id: GROUP,
  epoch: 7,
  committer,
  commit: "U1RPUkVE",
  added: [],
  removed: [],
  ...over,
});

const commits = (...rows: unknown[]) => ({ commits: rows, current_epoch: 9 });

const INTENT = {
  group_id: GROUP,
  channel_id: "01CHAN00000000000000000000",
  user_id: OTHER.user_id,
  device_id: OTHER.device_id,
  key_package_ref: "kp",
  signature: "sig",
};

const UNKNOWN = { kind: "unknown_outcome" } as const;

// S2 OR-5: this was "2xx is won" for any body; a plain 2xx is now `won` only
// when the submitted body removed nothing (see the OR-5 tests below).
test("D20: 2xx with nothing removed is won with our own bytes, no rejoin intents, no labels", () => {
  assert.deepEqual(
    classifySubmit(
      { kind: "submit", response: res(200, { result: "Won" }) },
      sctx({ ownRemoved: [] }),
    ),
    {
      kind: "won",
      storedCommitB64: "T1dO",
      rejoinIntents: [],
      removedReasons: [],
    },
  );
});

test("D20: 409 Lost to another committer is lost, winner processed", () => {
  const winning = row(OTHER);
  assert.deepEqual(
    classifySubmit(
      { kind: "submit", response: res(409, { result: "Lost", winning }) },
      sctx(),
    ),
    { kind: "lost", winner: winning, then: "process_winner" },
  );
});

test("D20: 409 Lost naming this device confirms by refetch, then won with the STORED string", () => {
  const first = classifySubmit(
    {
      kind: "submit",
      response: res(409, { result: "Lost", winning: row(SELF) }),
    },
    sctx(),
  );
  assert.deepEqual(first, {
    kind: "refetch",
    purpose: { kind: "lost_self" },
    delayMs: 0,
  });
  const second = classifySubmit(
    {
      kind: "refetch",
      purpose: { kind: "lost_self" },
      response: res(200, commits(row(SELF, { rejoin_intents: [INTENT] }))),
    },
    sctx(),
  );
  assert.deepEqual(second, {
    kind: "won",
    storedCommitB64: "U1RPUkVE",
    rejoinIntents: [INTENT],
    removedReasons: [],
  });
});

test("D20: a Lost whose winner is malformed or for another epoch is an unknown outcome", () => {
  for (const winning of [
    null,
    { group_id: GROUP, epoch: 7 },
    row(OTHER, { epoch: 6 }),
    row(OTHER, { group_id: "0".repeat(64) }),
  ]) {
    assert.deepEqual(
      classifySubmit(
        { kind: "submit", response: res(409, { result: "Lost", winning }) },
        sctx(),
      ),
      { kind: "refetch", purpose: UNKNOWN, delayMs: 0 },
    );
  }
});

test("control: 409 ProtectedChannelResecuring is not a Lost", () => {
  for (const reason of ["stale_seat_list", "pending_removal"]) {
    const out = classifySubmit(
      {
        kind: "submit",
        response: res(409, { type: "ProtectedChannelResecuring", reason }),
      },
      sctx(),
    );
    assert.notEqual(out.kind, "lost");
    assert.deepEqual(out, {
      kind: "refetch",
      purpose: {
        kind: "after_refusal",
        status: 409,
        type: "ProtectedChannelResecuring",
        reason,
      },
      delayMs: 0,
    });
  }
});

test("D20: a refusal that raced a winning own insert is won", () => {
  const purpose = {
    kind: "after_refusal",
    status: 409,
    type: "ProtectedChannelResecuring",
    reason: "stale_seat_list",
  } as const;
  assert.deepEqual(
    classifySubmit(
      { kind: "refetch", purpose, response: res(200, commits(row(SELF))) },
      sctx(),
    ),
    {
      kind: "won",
      storedCommitB64: "U1RPUkVE",
      rejoinIntents: [],
      removedReasons: [],
    },
  );
  // Raced another committer's insert: lost to that winner.
  assert.deepEqual(
    classifySubmit(
      { kind: "refetch", purpose, response: res(200, commits(row(OTHER))) },
      sctx(),
    ),
    { kind: "lost", winner: row(OTHER), then: "process_winner" },
  );
});

test("D20: a refusal with no row is commit_lost, then the reason's follow-up", () => {
  const absent = res(200, commits());
  const cases: [string | null, number, string | null, string][] = [
    ["stale_seat_list", 409, "ProtectedChannelResecuring", "reverify_restage"],
    ["pending_removal", 409, "ProtectedChannelResecuring", "await_removal"],
    [null, 400, "FailedValidation", "refresh"],
    // W4d (was "refresh"): W2c made the commit transaction's cap answers
    // typed; they are `refused` so the caller gets the typed refusal for
    // its cap notice (still `_commit_lost`, still never retried).
    [null, 400, "DeviceCapReached", "refused"],
    [null, 400, "MlsCallFull", "refused"],
  ];
  for (const [reason, status, type, then] of cases) {
    const first = classifySubmit(
      { kind: "submit", response: res(status, { type, reason }) },
      sctx(),
    );
    assert.equal(first.kind, "refetch");
    if (first.kind !== "refetch") continue;
    assert.deepEqual(
      classifySubmit(
        { kind: "refetch", purpose: first.purpose, response: absent },
        sctx(),
      ),
      { kind: "lost", winner: null, then },
    );
  }
});

test("control: a transport error or 5xx fetches {group}:{epoch} before any resubmit", () => {
  assert.deepEqual(classifySubmit({ kind: "submit_transport_error" }, sctx()), {
    kind: "refetch",
    purpose: UNKNOWN,
    delayMs: 0,
  });
  for (const status of [500, 502, 503, 504]) {
    assert.deepEqual(
      classifySubmit(
        { kind: "submit", response: res(status, { type: "DatabaseError" }) },
        sctx({ resubmit: true, failures: 3 }),
      ),
      { kind: "refetch", purpose: UNKNOWN, delayMs: 0 },
    );
  }
});

test("D20: unknown outcome, row absent: resubmit identical bytes as a resubmit", () => {
  assert.deepEqual(
    classifySubmit(
      { kind: "refetch", purpose: UNKNOWN, response: res(200, commits()) },
      sctx(),
    ),
    { kind: "resubmit", delayMs: 0, asResubmit: true },
  );
});

test("D20 committer rule: an own row with DIFFERENT bytes still goes to _commit_won with the stored string", () => {
  const out = classifySubmit(
    {
      kind: "refetch",
      purpose: UNKNOWN,
      response: res(200, commits(row(SELF, { commit: "RElGRkVSRU5U" }))),
    },
    sctx(),
  );
  assert.deepEqual(out, {
    kind: "won",
    storedCommitB64: "RElGRkVSRU5U",
    rejoinIntents: [],
    removedReasons: [],
  });
});

test("D20 committer rule: same user, other device is another committer", () => {
  const sibling = { user_id: SELF.user_id, device_id: "c".repeat(32) };
  const out = classifySubmit(
    {
      kind: "refetch",
      purpose: UNKNOWN,
      response: res(200, commits(row(sibling))),
    },
    sctx(),
  );
  assert.equal(out.kind, "lost");
});

test("control: an access refusal on a resubmit is a desync (mark_left not_member)", () => {
  for (const [status, type] of [
    [403, "NotSeated"],
    [403, "MissingPermission"],
  ] as const) {
    const out = classifySubmit(
      { kind: "submit", response: res(status, { type }) },
      sctx({ resubmit: true }),
    );
    assert.deepEqual(out, { kind: "mark_left", reason: "not_member" });
  }
});

test("D20: NotSeated on a FIRST submit is a definitive refusal (refetch once)", () => {
  const out = classifySubmit(
    { kind: "submit", response: res(403, { type: "NotSeated" }) },
    sctx(),
  );
  assert.deepEqual(out, {
    kind: "refetch",
    purpose: {
      kind: "after_refusal",
      status: 403,
      type: "NotSeated",
      reason: null,
    },
    delayMs: 0,
  });
});

test("D20: 404 on a resubmit or a refetch is mark_left not_found", () => {
  assert.deepEqual(
    classifySubmit(
      { kind: "submit", response: res(404, { type: "NotFound" }) },
      sctx({ resubmit: true }),
    ),
    { kind: "mark_left", reason: "not_found" },
  );
  for (const purpose of [
    UNKNOWN,
    { kind: "lost_self" } as const,
    {
      kind: "after_refusal",
      status: 404,
      type: "NotFound",
      reason: null,
    } as const,
  ]) {
    assert.deepEqual(
      classifySubmit(
        { kind: "refetch", purpose, response: res(404, { type: "NotFound" }) },
        sctx({ resubmit: true }),
      ),
      { kind: "mark_left", reason: "not_found" },
    );
  }
});

test("control: a 404 after a FIRST submit never wipes local state", () => {
  // First submit 404 -> refetch once -> 404: drop the stage, refresh.
  const first = classifySubmit(
    { kind: "submit", response: res(404, { type: "NotFound" }) },
    sctx(),
  );
  assert.equal(first.kind, "refetch");
  for (const purpose of [
    UNKNOWN,
    { kind: "lost_self" } as const,
    {
      kind: "after_refusal",
      status: 404,
      type: "NotFound",
      reason: null,
    } as const,
  ]) {
    const out = classifySubmit(
      { kind: "refetch", purpose, response: res(404, { type: "NotFound" }) },
      sctx(),
    );
    assert.notEqual(out.kind, "mark_left");
    assert.deepEqual(out, { kind: "lost", winner: null, then: "refresh" });
  }
});

test("D20: a 403 on the refetch is mark_left only on a resubmit", () => {
  const purpose = UNKNOWN;
  const r403 = res(403, { type: "NotSeated" });
  assert.deepEqual(
    classifySubmit(
      { kind: "refetch", purpose, response: r403 },
      sctx({ resubmit: true }),
    ),
    { kind: "mark_left", reason: "not_member" },
  );
  // First submit: retried with backoff, never a wipe.
  assert.deepEqual(
    classifySubmit(
      { kind: "refetch", purpose, response: r403 },
      sctx({ failures: 2 }),
    ),
    { kind: "refetch", purpose, delayMs: 1000 },
  );
});

test("D20: a failed refetch is retried with backoff, never guessed", () => {
  const purpose = { kind: "lost_self" } as const;
  for (const r of [
    res(500),
    res(502),
    res(401, { type: "NotAuthenticated" }),
    res(200, "<html>"),
    res(200, { commits: [{ epoch: 7 }] }),
  ]) {
    assert.deepEqual(
      classifySubmit(
        { kind: "refetch", purpose, response: r },
        sctx({ failures: 2 }),
      ),
      { kind: "refetch", purpose, delayMs: 1000 },
    );
  }
  assert.deepEqual(
    classifySubmit(
      { kind: "refetch_transport_error", purpose },
      sctx({ failures: 1 }),
    ),
    { kind: "refetch", purpose, delayMs: 500 },
  );
  assert.deepEqual(
    classifySubmit(
      { kind: "refetch", purpose, response: res(429, null, 4000) },
      sctx(),
    ),
    { kind: "refetch", purpose, delayMs: 4000 },
  );
});

test("D20: lost_self with no row resubmits (backed off)", () => {
  assert.deepEqual(
    classifySubmit(
      {
        kind: "refetch",
        purpose: { kind: "lost_self" },
        response: res(200, commits()),
      },
      sctx({ failures: 1 }),
    ),
    { kind: "resubmit", delayMs: 500, asResubmit: true },
  );
});

test("D20/M5: a refetch that does not start at the epoch is catch_up_failed", () => {
  for (const rows of [
    [row(OTHER, { epoch: 8 })],
    [row(SELF, { epoch: 6 })],
    [row(SELF), row(OTHER, { epoch: 9 })],
    [row(SELF, { group_id: "0".repeat(64) })],
  ]) {
    assert.deepEqual(
      classifySubmit(
        {
          kind: "refetch",
          purpose: UNKNOWN,
          response: res(200, commits(...rows)),
        },
        sctx(),
      ),
      { kind: "mark_left", reason: "catch_up_failed" },
    );
  }
});

test("D20: a 429 on submit re-sends the same bytes after the stated wait", () => {
  assert.deepEqual(
    classifySubmit(
      { kind: "submit", response: res(429, { retry_after: 1200 }) },
      sctx(),
    ),
    { kind: "resubmit", delayMs: 1200, asResubmit: false },
  );
  assert.deepEqual(
    classifySubmit(
      { kind: "submit", response: res(429) },
      sctx({ resubmit: true, failures: 1 }),
    ),
    { kind: "resubmit", delayMs: 500, asResubmit: true },
  );
});

test("M5 isCatchUpDesync", () => {
  assert.equal(isCatchUpDesync(5, []), false);
  assert.equal(
    isCatchUpDesync(5, [{ epoch: 5 }, { epoch: 6 }, { epoch: 7 }]),
    false,
  );
  assert.equal(isCatchUpDesync(5, [{ epoch: 6 }]), true);
  assert.equal(isCatchUpDesync(5, [{ epoch: 4 }]), true);
  assert.equal(isCatchUpDesync(5, [{ epoch: 5 }, { epoch: 7 }]), true);
  assert.equal(isCatchUpDesync(5, [{ epoch: 5 }, { epoch: 5 }]), true);
});

// ---------------------------------------------------------------------------
// S2 OR-5: `_commit_won` removal labels
// ---------------------------------------------------------------------------

const LABELS = { kind: "labels" } as const;
const LABEL = {
  user_id: OTHER.user_id,
  device_id: OTHER.device_id,
  reason: "off_list",
};
/** An unknown reason passes verbatim (native maps it to `Unknown`). */
const FUTURE_LABEL = {
  user_id: OTHER.user_id,
  device_id: "c".repeat(32),
  reason: "from_the_future",
};
const WON_2XX = res(200, { result: "Won" });

test("S2 OR-5 control: a plain 2xx whose body removed devices reads the stored row for its labels, never won", () => {
  for (const over of [
    { ownRemoved: [OTHER] },
    { ownRemoved: [OTHER], resubmit: true, failures: 3 },
    // Unknown removals are never read as none.
    {},
    { ownRemoved: null },
  ] as Partial<SubmitContext>[]) {
    for (const status of [200, 201, 204]) {
      const out = classifySubmit(
        { kind: "submit", response: res(status, { result: "Won" }) },
        sctx(over),
      );
      assert.deepEqual(
        out,
        { kind: "refetch", purpose: LABELS, delayMs: 0 },
        JSON.stringify(over),
      );
    }
  }
  // Known-empty removals: won with no labels, on a resubmit too.
  assert.deepEqual(
    classifySubmit(
      { kind: "submit", response: WON_2XX },
      sctx({ ownRemoved: [], resubmit: true }),
    ),
    {
      kind: "won",
      storedCommitB64: "T1dO",
      rejoinIntents: [],
      removedReasons: [],
    },
  );
});

test("S2 OR-5: the labels refetch is won with the stored row's labels, verbatim, wire keys only", () => {
  const stored = row(SELF, {
    removed: [OTHER, { user_id: OTHER.user_id, device_id: "c".repeat(32) }],
    removed_reasons: [LABEL, { ...FUTURE_LABEL, extra: "dropped" }],
    rejoin_intents: [INTENT],
  });
  assert.deepEqual(
    classifySubmit(
      { kind: "refetch", purpose: LABELS, response: res(200, commits(stored)) },
      sctx({ ownRemoved: [OTHER] }),
    ),
    {
      kind: "won",
      storedCommitB64: "U1RPUkVE",
      rejoinIntents: [INTENT],
      removedReasons: [LABEL, FUTURE_LABEL],
    },
  );
  // The DS stored none (it omits an empty vector), or null: the row says [].
  for (const labels of [undefined, null, []]) {
    const r = row(SELF, { removed: [OTHER], removed_reasons: labels });
    const out = classifySubmit(
      { kind: "refetch", purpose: LABELS, response: res(200, commits(r)) },
      sctx({ ownRemoved: [OTHER] }),
    );
    assert.deepEqual(
      out,
      {
        kind: "won",
        storedCommitB64: "U1RPUkVE",
        rejoinIntents: [],
        removedReasons: [],
      },
      String(labels),
    );
  }
});

test("S2 OR-5: a labels refetch never resubmits or drops the stage; a failed read is read again", () => {
  for (const r of [
    res(200, commits()),
    res(500),
    res(503, { type: "DatabaseError" }),
    res(200, "<html>"),
    res(200, { commits: [{ epoch: 7 }] }),
  ]) {
    assert.deepEqual(
      classifySubmit(
        { kind: "refetch", purpose: LABELS, response: r },
        sctx({ ownRemoved: [OTHER], failures: 2 }),
      ),
      { kind: "refetch", purpose: LABELS, delayMs: 1000 },
      JSON.stringify(r.body),
    );
  }
  assert.deepEqual(
    classifySubmit(
      { kind: "refetch_transport_error", purpose: LABELS },
      sctx({ failures: 1 }),
    ),
    { kind: "refetch", purpose: LABELS, delayMs: 500 },
  );
  // A refused read after a won commit: never `lost` (no `_commit_lost` of
  // the won stage) and never `mark_left`, on a first submit or a resubmit.
  for (const r of [
    res(404, { type: "NotFound" }),
    res(403, { type: "NotSeated" }),
    res(403, { type: "MissingPermission" }),
  ]) {
    for (const resubmit of [false, true]) {
      assert.deepEqual(
        classifySubmit(
          { kind: "refetch", purpose: LABELS, response: r },
          sctx({ ownRemoved: [OTHER], resubmit, failures: 2 }),
        ),
        { kind: "refetch", purpose: LABELS, delayMs: 1000 },
        `${r.status} resubmit=${resubmit}`,
      );
    }
  }
  // The committer rule still applies to the stored row.
  assert.deepEqual(
    classifySubmit(
      {
        kind: "refetch",
        purpose: LABELS,
        response: res(200, commits(row(OTHER))),
      },
      sctx(),
    ),
    { kind: "lost", winner: row(OTHER), then: "process_winner" },
  );
});

test("S2 OR-5: every refetch path's won carries the stored row's labels", () => {
  for (const purpose of [
    UNKNOWN,
    { kind: "lost_self" } as const,
    {
      kind: "after_refusal",
      status: 409,
      type: "ProtectedChannelResecuring",
      reason: "stale_seat_list",
    } as const,
    LABELS,
  ]) {
    const stored = row(SELF, {
      removed: [OTHER],
      removed_reasons: [LABEL, FUTURE_LABEL],
    });
    assert.deepEqual(
      classifySubmit(
        { kind: "refetch", purpose, response: res(200, commits(stored)) },
        sctx(),
      ),
      {
        kind: "won",
        storedCommitB64: "U1RPUkVE",
        rejoinIntents: [],
        removedReasons: [LABEL, FUTURE_LABEL],
      },
      purpose.kind,
    );
  }
});

test("S2 OR-5 control: a malformed removed_reasons makes the stored row malformed", () => {
  const bad: unknown[] = [
    "off_list",
    3,
    {},
    { ...LABEL },
    [null],
    ["off_list"],
    [[LABEL]],
    [LABEL, null],
    [{ user_id: OTHER.user_id, device_id: OTHER.device_id }],
    [{ ...LABEL, reason: 3 }],
    [{ ...LABEL, reason: null }],
    [{ ...LABEL, user_id: null }],
    [{ ...LABEL, device_id: 7 }],
  ];
  for (const labels of bad) {
    const tag = JSON.stringify(labels);
    // A 409 Lost whose winner carries them: the outcome is unknown.
    assert.deepEqual(
      classifySubmit(
        {
          kind: "submit",
          response: res(409, {
            result: "Lost",
            winning: row(OTHER, { removed_reasons: labels }),
          }),
        },
        sctx(),
      ),
      { kind: "refetch", purpose: UNKNOWN, delayMs: 0 },
      tag,
    );
    // A refetched row carrying them: read again, never won or lost.
    for (const purpose of [UNKNOWN, LABELS]) {
      assert.deepEqual(
        classifySubmit(
          {
            kind: "refetch",
            purpose,
            response: res(200, commits(row(SELF, { removed_reasons: labels }))),
          },
          sctx({ failures: 1 }),
        ),
        { kind: "refetch", purpose, delayMs: 500 },
        tag,
      );
    }
  }
  // Well-formed labels keep the winner (copied with wire keys only).
  assert.deepEqual(
    classifySubmit(
      {
        kind: "submit",
        response: res(409, {
          result: "Lost",
          winning: row(OTHER, {
            removed_reasons: [{ ...FUTURE_LABEL, extra: 1 }],
          }),
        }),
      },
      sctx(),
    ),
    {
      kind: "lost",
      winner: row(OTHER, { removed_reasons: [FUTURE_LABEL] }),
      then: "process_winner",
    },
  );
});

// ---------------------------------------------------------------------------
// Protected send (D10)
// ---------------------------------------------------------------------------

const CROCK = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** An independent ULID-time encoder for the fixtures. */
function ulidAt(ms: number, rand = "7".repeat(16)): string {
  let s = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    s = CROCK[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return s + rand;
}
const CID_MS = 1_760_000_000_000;
const CID = ulidAt(CID_MS);
const AFTER = ulidAt(CID_MS - 300_000, "0".repeat(16));

const CHAN = "01CHAN00000000000000000000";
/** The `encrypted` payload the send POSTed (W4d X#4 binding). */
const ENC = {
  v: 1,
  group_id: GROUP,
  epoch: 7,
  sender_device_id: SELF.device_id,
  nonce: "QUVBRA",
  ciphertext: "Q1Q",
  sig: "U0lH",
};

const dctx = (over: Partial<SendContext> = {}): SendContext => ({
  selfUserId: SELF.user_id,
  channelId: CHAN,
  cid: CID,
  encrypted: ENC,
  priorUnknown: false,
  resecureRetried: false,
  failures: 0,
  ...over,
});

const send = (r: TextApiResponse, over: Partial<SendContext> = {}) =>
  classifySendAnswer({ kind: "response", response: r }, dctx(over));

const RESECURING = res(409, {
  type: "ProtectedChannelResecuring",
  reason: "stale_epoch",
});
const DUPLICATE = res(409, { type: "DuplicateNonce" });

const msg = (
  id: string,
  author: string,
  nonce: string,
  over: Record<string, unknown> = {},
) => ({
  _id: id,
  channel: CHAN,
  author,
  nonce,
  encrypted: ENC,
  ...over,
});

const confirm = (
  trigger: SendTrigger,
  r: TextApiResponse,
  over: Partial<SendContext> = {},
  pageLimit = 100,
) =>
  classifySendAnswer(
    { kind: "confirm", trigger, response: r, pageLimit },
    dctx(over),
  );

test("confirmAfterId: the cid's time minus 5 minutes, random part zero", () => {
  assert.equal(confirmAfterId(CID), AFTER);
  assert.equal(confirmAfterId(CID.toLowerCase()), AFTER);
  assert.equal(confirmAfterId(ulidAt(1000)), "0".repeat(26));
  assert.equal(confirmAfterId("not-a-ulid"), null);
  assert.equal(confirmAfterId(CID.slice(1)), null);
  assert.equal(confirmAfterId("8" + CID.slice(1)), null);
  assert.equal(confirmAfterId(CID.slice(0, 25) + "U"), null);
});

test("D10: 2xx is delivered; transport and 5xx are unknown (same bytes later)", () => {
  const body = msg("01ROW", SELF.user_id, CID);
  assert.deepEqual(send(res(200, body)), {
    kind: "delivered",
    raw: body,
    confirmed: false,
  });
  assert.deepEqual(
    classifySendAnswer({ kind: "transport_error" }, dctx({ failures: 2 })),
    { kind: "unknown", delayMs: 1000 },
  );
  for (const status of [500, 502, 503]) {
    assert.deepEqual(send(res(status), { priorUnknown: true }), {
      kind: "unknown",
      delayMs: 250,
    });
  }
});

test("D10: Resecuring with the attempt known failed: ONE re-encrypt retry", () => {
  assert.deepEqual(send(RESECURING), {
    kind: "resecure_retry",
    reason: "stale_epoch",
  });
  assert.deepEqual(send(RESECURING, { resecureRetried: true }), {
    kind: "refused",
    status: 409,
    type: "ProtectedChannelResecuring",
    clientDefect: false,
  });
});

test("control: a refusal after an unknown outcome confirms by refetch before any re-encrypt", () => {
  const first = send(RESECURING, { priorUnknown: true });
  assert.equal(first.kind, "confirm");
  if (first.kind !== "confirm") return;
  assert.equal(first.after, AFTER);
  assert.equal(first.before, null);
  // Found: delivered, no re-encrypt.
  const found = msg("01ROW", SELF.user_id, CID);
  assert.deepEqual(confirm(first.trigger, res(200, [found])), {
    kind: "delivered",
    raw: found,
    confirmed: true,
  });
  // Absent: only now the one re-encrypt retry.
  assert.deepEqual(confirm(first.trigger, res(200, [])), {
    kind: "resecure_retry",
    reason: "stale_epoch",
  });
  // Every other 4xx and a 429 after an unknown outcome confirm first too.
  for (const r of [
    res(400, { type: "FailedValidation" }),
    res(403, { type: "NotSeated" }),
    res(429, null, 900),
    DUPLICATE,
  ]) {
    assert.equal(send(r, { priorUnknown: true }).kind, "confirm");
  }
});

test("D10: after the confirm finds nothing, the triggering answer is acted on", () => {
  const prior = { priorUnknown: true };
  const t429 = send(res(429, null, 900), prior);
  assert.equal(t429.kind, "confirm");
  if (t429.kind === "confirm") {
    assert.deepEqual(confirm(t429.trigger, res(200, [])), {
      kind: "retry_same",
      delayMs: 900,
    });
  }
  const t400 = send(res(400, { type: "FailedValidation" }), prior);
  if (t400.kind === "confirm") {
    assert.deepEqual(confirm(t400.trigger, res(200, [])), {
      kind: "refused",
      status: 400,
      type: "FailedValidation",
      clientDefect: false,
    });
  } else assert.fail("expected confirm");
});

test("control: DuplicateNonce never re-encrypts: confirm, then delivered or maybe_unsent", () => {
  const first = send(DUPLICATE);
  assert.equal(first.kind, "confirm");
  if (first.kind !== "confirm") return;
  const found = msg("01ROW", SELF.user_id, CID);
  assert.deepEqual(
    confirm(first.trigger, res(200, { messages: [found], users: [] })),
    {
      kind: "delivered",
      raw: found,
      confirmed: true,
    },
  );
  assert.deepEqual(confirm(first.trigger, res(200, [])), {
    kind: "maybe_unsent",
  });
  // Even with the Resecuring retry unspent, DuplicateNonce never re-encrypts.
  for (const over of [{}, { priorUnknown: true }]) {
    const a = send(DUPLICATE, over);
    assert.notEqual(a.kind, "resecure_retry");
    if (a.kind === "confirm") {
      assert.notEqual(confirm(a.trigger, res(200, [])).kind, "resecure_retry");
    }
  }
});

test("D10: a failed confirm fetch is 'unknown, retry later', never 'absent'", () => {
  const first = send(RESECURING, { priorUnknown: true });
  if (first.kind !== "confirm") return assert.fail("expected confirm");
  for (const r of [
    res(403, { type: "MissingPermission" }),
    res(404, { type: "NotFound" }),
    res(500),
    res(429, null, 1000),
    res(200, "<html>"),
    res(200, [{ author: SELF.user_id }]),
  ]) {
    assert.deepEqual(confirm(first.trigger, r, { failures: 1 }), {
      kind: "confirm_later",
      trigger: first.trigger,
      delayMs: 500,
    });
  }
  assert.deepEqual(
    classifySendAnswer(
      { kind: "confirm_transport_error", trigger: first.trigger },
      dctx(),
    ),
    { kind: "confirm_later", trigger: first.trigger, delayMs: 250 },
  );
});

test("D10: confirm pages until older; only an own row with nonce === cid counts", () => {
  const first = send(RESECURING, { priorUnknown: true });
  if (first.kind !== "confirm") return assert.fail("expected confirm");
  const ids = [
    ulidAt(CID_MS + 3000),
    ulidAt(CID_MS + 2000),
    ulidAt(CID_MS + 1000),
  ];
  const page = [
    msg(ids[0], OTHER.user_id, CID), // someone else's row with our nonce
    msg(ids[1], SELF.user_id, "01OTHERNONCE00000000000000"),
    msg(ids[2], SELF.user_id, "01OTHERNONCE00000000000001"),
  ];
  assert.deepEqual(confirm(first.trigger, res(200, page), {}, 3), {
    kind: "confirm",
    trigger: first.trigger,
    after: AFTER,
    before: ids[2],
  });
  // A short page is the end: absent.
  assert.deepEqual(confirm(first.trigger, res(200, page), {}, 4), {
    kind: "resecure_retry",
    reason: "stale_epoch",
  });
  // A full page that already reaches the window start stops paging.
  const old = [msg(AFTER, OTHER.user_id, "x")];
  assert.equal(
    confirm(first.trigger, res(200, old), {}, 1).kind,
    "resecure_retry",
  );
});

test("D10: definitive refusals; ProtectedFieldRefused is a client defect", () => {
  const cases: [TextApiResponse, boolean][] = [
    [res(400, { type: "ProtectedFieldRefused", field: "content" }), true],
    [res(400, { type: "FeatureDisabled", feature: "e2ee" }), false],
    [res(403, { type: "NotSeated" }), false],
    [res(401, { type: "NotAuthenticated" }), false],
    [res(409, { type: "SomethingNew" }), false],
  ];
  for (const [r, clientDefect] of cases) {
    assert.deepEqual(send(r), {
      kind: "refused",
      status: r.status,
      type: errorTypeOf(r.body),
      clientDefect,
    });
  }
});

test("D10: a 429 with the attempt known failed re-sends the same bytes", () => {
  assert.deepEqual(send(res(429, { type: "InSlowmode", retry_after: 5 })), {
    kind: "retry_same",
    delayMs: 5000,
  });
  assert.deepEqual(send(res(429), { failures: 3 }), {
    kind: "retry_same",
    delayMs: 2000,
  });
});

test("D10: an unparseable cid cannot be confirmed: maybe_unsent, never re-encrypt", () => {
  assert.deepEqual(send(DUPLICATE, { cid: "garbage" }), {
    kind: "maybe_unsent",
  });
  assert.deepEqual(send(RESECURING, { cid: "garbage", priorUnknown: true }), {
    kind: "maybe_unsent",
  });
});

// ---------------------------------------------------------------------------
// W4d fix round (lane L-MGR): X#4 own-send binding, X#5 not_member
// ---------------------------------------------------------------------------

test("W4d X#4 (C-X4): a 2xx or confirm row is this send only when channel, author, nonce AND encrypted bind", () => {
  const good = msg("01ROW", SELF.user_id, CID);
  assert.equal(ownSendRowBinds(good, dctx()), true);
  // serde skips `franking: None`: null and absent are the same payload.
  assert.equal(
    ownSendRowBinds(msg("01ROW", SELF.user_id, CID), {
      ...dctx(),
      encrypted: { ...ENC, franking: null },
    }),
    true,
  );
  const unbound = [
    msg("01ROW", SELF.user_id, CID, { channel: "01CHANOTHER000000000000000" }),
    msg("01ROW", OTHER.user_id, CID),
    msg("01ROW", SELF.user_id, ulidAt(CID_MS + 1)),
    msg("01ROW", SELF.user_id, CID, { encrypted: { ...ENC, ciphertext: "X" } }),
    msg("01ROW", SELF.user_id, CID, { encrypted: { ...ENC, epoch: 8 } }),
    msg("01ROW", SELF.user_id, CID, { encrypted: { ...ENC, extra: "x" } }),
    msg("01ROW", SELF.user_id, CID, { encrypted: undefined }),
    msg("01ROW", SELF.user_id, CID, { _id: "" }),
    { ...good, _id: undefined },
  ];
  for (const raw of unbound) {
    assert.equal(ownSendRowBinds(raw, dctx()), false, JSON.stringify(raw));
    // A 2xx naming another message is never delivered: unknown, same bytes.
    assert.deepEqual(send(res(200, raw)), { kind: "unknown", delayMs: 250 });
    // The confirm never adopts it either: absent → acted on the trigger (a
    // row without a string `_id` makes the whole page malformed: later).
    const first = send(DUPLICATE);
    if (first.kind !== "confirm") return assert.fail("expected confirm");
    assert.equal(
      confirm(first.trigger, res(200, [raw])).kind,
      typeof raw._id === "string" ? "maybe_unsent" : "confirm_later",
    );
  }
  assert.equal(ownSendRowBinds(good, dctx({ encrypted: null })), false);
  // The bound row among unbound ones is the one adopted.
  const first = send(DUPLICATE);
  if (first.kind !== "confirm") return assert.fail("expected confirm");
  const page = [...unbound.filter((r) => typeof r._id === "string"), good];
  assert.deepEqual(confirm(first.trigger, res(200, page)), {
    kind: "delivered",
    raw: good,
    confirmed: true,
  });
});

const NOT_MEMBER = res(409, {
  type: "ProtectedChannelResecuring",
  reason: "not_member",
});

test("W4d X#5 (C-X5b): a send refused not_member is refused at once, never re-encrypted", () => {
  assert.deepEqual(send(NOT_MEMBER), {
    kind: "refused",
    status: 409,
    type: "ProtectedChannelResecuring",
    clientDefect: false,
  });
  // After an unknown outcome: confirm first; absent → refused, no retry.
  const first = send(NOT_MEMBER, { priorUnknown: true });
  if (first.kind !== "confirm") return assert.fail("expected confirm");
  assert.equal(confirm(first.trigger, res(200, [])).kind, "refused");
  // Every other Resecuring reason keeps its one re-encrypt retry.
  assert.equal(send(RESECURING).kind, "resecure_retry");
});

test("W4d X#5 (C-X5a): a commit refused not_member → refetch → absent → mark_left(not_member); own row → won", () => {
  const first = classifySubmit(
    { kind: "submit", response: NOT_MEMBER },
    sctx(),
  );
  const purpose = {
    kind: "after_refusal",
    status: 409,
    type: "ProtectedChannelResecuring",
    reason: "not_member",
  } as const;
  assert.deepEqual(first, { kind: "refetch", purpose, delayMs: 0 });
  assert.deepEqual(
    classifySubmit(
      { kind: "refetch", purpose, response: res(200, commits()) },
      sctx(),
    ),
    { kind: "mark_left", reason: "not_member" },
  );
  assert.equal(
    classifySubmit(
      { kind: "refetch", purpose, response: res(200, commits(row(SELF))) },
      sctx(),
    ).kind,
    "won",
  );
  // Other refusal reasons still drop the stage and refresh.
  assert.deepEqual(
    classifySubmit(
      {
        kind: "refetch",
        purpose: { ...purpose, reason: "stale_epoch" },
        response: res(200, commits()),
      },
      sctx(),
    ),
    { kind: "lost", winner: null, then: "refresh" },
  );
});

// ---------------------------------------------------------------------------
// Envelope errors (design 8.4 / 9.2)
// ---------------------------------------------------------------------------

const EXPECTED: Record<
  (typeof TEXT_NATIVE_ERROR_TAGS)[number],
  [
    ack: boolean,
    action: TextEnvelopeVerdict["action"],
    recordsGroupError: boolean,
    markLeft?: TextLeftReason,
  ]
> = {
  unknown_epoch: [false, "hold", true],
  unknown_sender: [false, "hold", true],
  bad_sig: [true, "await_successor", true],
  not_seated: [false, "hold", true],
  roster_mismatch: [true, "await_successor", true],
  owner_changed: [false, "park_owner_change", true],
  signer_leaf_missing: [true, "signer_leaf_missing_retry", true],
  commit_declaration_mismatch: [true, "await_successor", true],
  not_owner: [true, "await_successor", true],
  seat_list_rollback: [true, "await_successor", true],
  seat_list_equivocation: [true, "await_successor", true],
  seat_list_behind: [false, "hold", true],
  seat_list_invalid: [true, "await_successor", true],
  removed_sender: [false, "hold", true],
  replay: [false, "hold", true],
  channel_mismatch: [true, "drop", true],
  already_member: [true, "drop", true],
  own_commit_mismatch: [true, "rejoin", true],
  duplicate_leaf: [true, "await_successor", true],
  replayed_rejoin_intent: [true, "await_successor", true],
  unexpected_mls_content: [true, "drop_unexpected_content", true],
  update_required: [false, "hold", true],
  text_group_full: [true, "await_successor", true],
  malformed_text_payload: [false, "hold", true],
  wrong_group_kind: [false, "refuse_wrong_kind", true],
  identity_pin_required: [false, "pin_identities_retry", false],
  handover_target_invalid: [false, "hold", true],
  // S2-D31 (L1p): replaces the W4-0 placeholder row [false, "hold", true].
  catch_up_leaf_unresolvable: [true, "rejoin", true, "catch_up_failed"],
  // Decrypt-only (native `text_decrypt`); unexpected from `_process`: held.
  unsupported_envelope_version: [false, "hold", true],
  mls_group_not_found: [true, "join", true],
  mls_unsolicited_welcome: [true, "drop_unsolicited_welcome", false],
  mls_leaf_rejected: [true, "await_successor", true],
  mls_epoch_gap: [false, "catch_up", false],
  mls_poisoned_epoch: [true, "await_successor", true],
  declined: [false, "hold", false],
};

test("envelope classifier: every text tag, as pinned", () => {
  assert.deepEqual(
    Object.keys(EXPECTED).sort(),
    [...TEXT_NATIVE_ERROR_TAGS].sort(),
  );
  for (const tag of TEXT_NATIVE_ERROR_TAGS) {
    const [ack, action, records, markLeft] = EXPECTED[tag];
    const expected: TextEnvelopeVerdict = records
      ? { ack, action, groupError: tag }
      : { ack, action };
    if (markLeft !== undefined) expected.markLeft = markLeft;
    assert.deepEqual(classifyTextEnvelopeError({ type: tag }), expected, tag);
    // Unwrapped from a TextFlowFailure the same way.
    assert.deepEqual(
      classifyTextEnvelopeError({ source: "native", error: { type: tag } }),
      expected,
      tag,
    );
  }
});

test("envelope classifier: anything else fails closed (held, never acked)", () => {
  const hold = { ack: false, action: "hold", groupError: "unknown" };
  for (const err of [
    { type: "storage", code: "x" },
    { type: "mls_call_full", max: 100 },
    { type: "some_future_variant" },
    { type: 7 },
    "mls_epoch_gap",
    new Error("boom"),
    null,
    undefined,
    { source: "transport" },
    { source: "server", status: 500, type: null, body: null },
  ]) {
    assert.deepEqual(classifyTextEnvelopeError(err), hold);
  }
});

test("S2-D31 control: catch_up_leaf_unresolvable marks the group left (catch_up_failed) and rejoins; never held, never loud", () => {
  for (const err of [
    { type: "catch_up_leaf_unresolvable", group_id: GROUP, epoch: 3 },
    {
      source: "native",
      error: { type: "catch_up_leaf_unresolvable", group_id: GROUP, epoch: 3 },
    },
  ]) {
    const v = classifyTextEnvelopeError(err);
    assert.deepEqual(v, {
      ack: true,
      action: "rejoin",
      groupError: "catch_up_leaf_unresolvable",
      markLeft: "catch_up_failed",
    });
    // Not the placeholder hold, and not the poisoned path.
    assert.notEqual(v.action, "hold");
    assert.notEqual(v.action, "await_successor");
  }
  // The recorded tag is never a loud (hence never a sticky) one.
  assert.equal(
    (SHIELD_LOUD_GROUP_ERRORS as readonly string[]).includes(
      "catch_up_leaf_unresolvable",
    ),
    false,
  );
  // No other tag asks for a mark_left.
  for (const tag of TEXT_NATIVE_ERROR_TAGS) {
    if (tag === "catch_up_leaf_unresolvable") continue;
    assert.equal(
      "markLeft" in classifyTextEnvelopeError({ type: tag }),
      false,
      tag,
    );
  }
});

test("S2: unsupported_envelope_version on a channel op is held and recorded, never acked or dropped", () => {
  for (const err of [
    { type: "unsupported_envelope_version", v: 3 },
    { source: "native", error: { type: "unsupported_envelope_version", v: 2 } },
  ]) {
    assert.deepEqual(classifyTextEnvelopeError(err), {
      ack: false,
      action: "hold",
      groupError: "unsupported_envelope_version",
    });
  }
});

test("control: busy holds for a retry and leaves groupError unchanged", () => {
  for (const err of [
    { type: "busy" },
    { source: "native", error: { type: "busy" } },
  ]) {
    const v = classifyTextEnvelopeError(err);
    assert.deepEqual(v, { ack: false, action: "hold" });
    assert.equal("groupError" in v, false);
  }
});

// ---------------------------------------------------------------------------
// Protector back-off (S7 C9: EL-F7 Linux keyring, AND-F13 Android Keystore)
// ---------------------------------------------------------------------------

const PROTECTOR_REFUSALS: unknown[] = [
  { type: "protector" },
  { source: "native", error: { type: "protector" } },
  { type: "protector_locked" },
  { source: "native", error: { type: "protector_locked" } },
];

test("C9 protector: an envelope is held, never acked, never a groupError, never a leave or rejoin", () => {
  for (const err of PROTECTOR_REFUSALS) {
    const v = classifyTextEnvelopeError(err);
    assert.deepEqual(v, { ack: false, action: "hold" });
    assert.equal("groupError" in v, false);
  }
});

test("C9 protector: isProtectorError matches a native refusal only", () => {
  for (const err of PROTECTOR_REFUSALS) {
    assert.equal(isProtectorError(err), true);
  }
  for (const err of [
    { type: "busy" },
    { type: "declined" },
    { type: "storage", code: "x" },
    { type: "store_corrupt" },
    { source: "native", error: { type: "busy" } },
    { source: "server", status: 500, type: "protector", body: null },
    { source: "client", reason: "protector" },
    { source: "transport" },
    "protector",
    new Error("protector"),
    null,
    undefined,
  ]) {
    assert.equal(isProtectorError(err), false, JSON.stringify(err));
  }
});

test("C9 protector: back-off is 2 s doubling, capped at 60 s", () => {
  assert.deepEqual(PROTECTOR_BACKOFF, { startMs: 2_000, capMs: 60_000 });
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 50].map(protectorBackoffMs),
    [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000],
  );
  for (const odd of [0, -3, 1.5, Number.NaN]) {
    assert.equal(protectorBackoffMs(odd), 2_000, String(odd));
  }
  assert.equal(protectorBackoffMs(Number.POSITIVE_INFINITY), 60_000);
});

test("C9 protector gate: open runs; closed waits out the window, then ONE probe", () => {
  const T = 1_000_000;
  for (const probing of [false, true]) {
    assert.deepEqual(protectorGateStep(PROTECTOR_GATE_OPEN, T, probing), {
      kind: "run",
      probe: false,
    });
  }
  const g = protectorGateAfter(PROTECTOR_GATE_OPEN, "protector", 0, T);
  assert.deepEqual(g, { failures: 1, untilMs: T + 2_000 });
  assert.deepEqual(protectorGateStep(g, T, false), {
    kind: "wait",
    waitMs: 2_000,
  });
  assert.deepEqual(protectorGateStep(g, T + 1_500, false), {
    kind: "wait",
    waitMs: 500,
  });
  assert.deepEqual(protectorGateStep(g, T + 2_000, false), {
    kind: "run",
    probe: true,
  });
  // While the probe is out, everything else waits for its answer.
  assert.deepEqual(protectorGateStep(g, T + 2_000, true), {
    kind: "wait_probe",
  });
  assert.deepEqual(protectorGateStep(g, T + 500, true), { kind: "wait_probe" });
});

test("C9 protector gate: refusals escalate; the first success reopens; a new refusal starts at 2 s", () => {
  let g = PROTECTOR_GATE_OPEN;
  let t = 0;
  const windows: number[] = [];
  for (let i = 0; i < 8; i++) {
    g = protectorGateAfter(g, "protector", g.failures, t);
    windows.push(g.untilMs - t);
    t = g.untilMs;
  }
  assert.deepEqual(
    windows,
    [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000],
  );
  assert.equal(g.failures, 8);
  g = protectorGateAfter(g, "ok", g.failures, t);
  assert.equal(g, PROTECTOR_GATE_OPEN);
  g = protectorGateAfter(g, "protector", 0, t);
  assert.deepEqual(g, { failures: 1, untilMs: t + 2_000 });
});

test("C9 protector gate: refusals in flight together count once; `other` changes nothing", () => {
  const T = 5_000;
  let g = PROTECTOR_GATE_OPEN;
  // Three commands issued while open, refused together.
  for (const dt of [0, 10, 20]) {
    g = protectorGateAfter(g, "protector", 0, T + dt);
  }
  assert.deepEqual(g, { failures: 1, untilMs: T + 20 + 2_000 });
  // busy / a typed error / an untyped rejection: neither reopens nor escalates.
  assert.equal(protectorGateAfter(g, "other", 1, T + 30), g);
  assert.equal(protectorGateAfter(g, "other", 0, T + 5_000), g);
  // A success, even of a command issued before the gate closed, reopens it.
  assert.equal(protectorGateAfter(g, "ok", 0, T + 40), PROTECTOR_GATE_OPEN);
});

test("C9 protector gate: fails closed on a broken state or clock", () => {
  for (const failures of [Number.NaN, -1, 0.5]) {
    assert.notDeepEqual(
      protectorGateStep({ failures, untilMs: 0 }, 10, false),
      { kind: "run", probe: false },
      String(failures),
    );
    assert.deepEqual(protectorGateStep({ failures, untilMs: 0 }, 10, true), {
      kind: "wait_probe",
    });
  }
  // An unreadable clock never lets a command through.
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      protectorGateStep({ failures: 1, untilMs: 100 }, now, false),
      { kind: "wait", waitMs: 60_000 },
    );
  }
  // The clock moved back past the window: one probe restarts it.
  const g = { failures: 3, untilMs: 10_000_000 };
  assert.deepEqual(protectorGateStep(g, 0, false), {
    kind: "run",
    probe: true,
  });
  assert.deepEqual(protectorGateAfter(g, "protector", 3, 0), {
    failures: 4,
    untilMs: 16_000,
  });
});

test("envelope classifier: never acks a parked owner change or a wrong-kind id", () => {
  for (const err of [
    { type: "owner_changed", same_user: true },
    { type: "owner_changed", same_user: false },
    { type: "wrong_group_kind", group_id: GROUP },
  ]) {
    assert.equal(classifyTextEnvelopeError(err).ack, false);
  }
});

// ---------------------------------------------------------------------------
// S2 held group (superseded verdict, OR-8)
// ---------------------------------------------------------------------------

// Every member, checked by tsc (`satisfies` a total record).
const GROUP_STATES = Object.keys({
  none: 1,
  joining: 1,
  active: 1,
  poisoned: 1,
  left: 1,
} satisfies Record<TextGroupState, 1>) as TextGroupState[];
const VERDICTS = Object.keys({
  ok: 1,
  no_group: 1,
  joining: 1,
  not_seated: 1,
  no_seat_list: 1,
  roster_mismatch: 1,
  owner_changed: 1,
  poisoned: 1,
} satisfies Record<TextVerdict, 1>) as TextVerdict[];

const nativeState = (
  state: TextGroupState,
  verdict: TextVerdict,
): TextChannelState => ({
  channel_id: CHAN,
  group_id: GROUP,
  generation: 1,
  epoch: 3,
  state,
  members: [],
  seat_list: null,
  owner_pin: {
    channel_id: CHAN,
    status: "pinned",
    owner_user_id: OTHER.user_id,
    owner_device_id: OTHER.device_id,
    owner_verified: true,
    source: "protect",
    pending_signer: null,
  },
  self_seated: true,
  roster_matches_list: true,
  update_due: false,
  update_required: false,
  verdict,
});

test("S2 OR-8 control: a superseded group (active, verdict no_group) is not the held current group", () => {
  assert.equal(holdsCurrentGroup(nativeState("active", "no_group")), false);
  assert.equal(holdsCurrentGroup(nativeState("active", "ok")), true);
  // Other verdicts of an active group still hold it (the shield decides).
  for (const v of ["joining", "roster_mismatch", "owner_changed"] as const) {
    assert.equal(holdsCurrentGroup(nativeState("active", v)), true, v);
  }
});

test("S2 OR-8: holdsCurrentGroup is state active AND verdict not no_group, for every pair", () => {
  assert.equal(GROUP_STATES.length, 5);
  assert.equal(VERDICTS.length, 8);
  for (const s of GROUP_STATES) {
    for (const v of VERDICTS) {
      assert.equal(
        holdsCurrentGroup(nativeState(s, v)),
        s === "active" && v !== "no_group",
        `${s}/${v}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// S2 join refusal (D35 capacity, S4 protocol floor; OR-4, OR-11)
// ---------------------------------------------------------------------------

/** `CapacityReason` is exactly the view's `capacity.reason` (tsc). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const capacityReasonIsTheView: Same<
  CapacityReason,
  NonNullable<ProtectedChannelView["capacity"]>["reason"]
> = true;
void capacityReasonIsTheView;

const DEVICE_CAP = { kind: "capacity", reason: "device_cap" } as const;
const GROUP_FULL = { kind: "capacity", reason: "group_full" } as const;

/** The manager's `serverFailure(r)` shape for the same answer. */
const failure = (r: TextApiResponse) => ({
  source: "server" as const,
  status: r.status,
  type: errorTypeOf(r.body),
  body: r.body,
});

test("S2 joinRefusal: DeviceCapReached 400 is device_cap; MlsCallFull 409 is group_full", () => {
  const cap = res(400, { type: "DeviceCapReached", max: 5 });
  const full = res(409, { type: "MlsCallFull", max: 100 });
  assert.deepEqual(joinRefusal(cap), DEVICE_CAP);
  assert.deepEqual(joinRefusal(failure(cap)), DEVICE_CAP);
  assert.deepEqual(joinRefusal(full), GROUP_FULL);
  assert.deepEqual(joinRefusal(failure(full)), GROUP_FULL);
  // The commit transaction's typed refusals are unchanged.
  assert.deepEqual(COMMIT_CAP_REFUSALS, ["DeviceCapReached", "MlsCallFull"]);
});

test("S2 joinRefusal: native text_group_full is device_cap below the 100-leaf ceiling, else group_full", () => {
  assert.equal(MAX_TEXT_LEAVES, 100);
  const cases: [unknown, "device_cap" | "group_full"][] = [
    // `text_admit`: the signed per-user cap (`max` = that cap) ...
    [1, "device_cap"],
    [5, "device_cap"],
    [99, "device_cap"],
    // ... and the leaf ceiling (`max` = 100), or a cap at or above it.
    [100, "group_full"],
    [150, "group_full"],
    // Unreadable: the group_full default.
    [0, "group_full"],
    [-1, "group_full"],
    [2.5, "group_full"],
    ["5", "group_full"],
    [null, "group_full"],
    [undefined, "group_full"],
  ];
  for (const [max, reason] of cases) {
    const err =
      max === undefined
        ? { type: "text_group_full" }
        : { type: "text_group_full", max };
    const want = { kind: "capacity", reason };
    assert.deepEqual(joinRefusal(err), want, String(max));
    assert.deepEqual(
      joinRefusal({ source: "native", error: err }),
      want,
      String(max),
    );
  }
});

test("S2 joinRefusal OR-4: ProtectedClientOutdated 400 is outdated only with a safe integer min of at least 1", () => {
  for (const min of [1, 2, 3, 4_294_967_295, Number.MAX_SAFE_INTEGER]) {
    const r = res(400, { type: "ProtectedClientOutdated", min });
    assert.deepEqual(joinRefusal(r), { kind: "outdated", min }, String(min));
    assert.deepEqual(joinRefusal(failure(r)), { kind: "outdated", min });
  }
  for (const min of [
    0,
    -1,
    1.5,
    "2",
    null,
    true,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
    undefined,
  ]) {
    const body =
      min === undefined
        ? { type: "ProtectedClientOutdated" }
        : { type: "ProtectedClientOutdated", min };
    assert.equal(joinRefusal(res(400, body)), null, String(min));
    assert.equal(joinRefusal(failure(res(400, body))), null, String(min));
  }
  for (const status of [200, 409, 403, 429, 500]) {
    assert.equal(
      joinRefusal(res(status, { type: "ProtectedClientOutdated", min: 2 })),
      null,
      String(status),
    );
  }
});

test("S2 control: capacity comes only from a join answer, never a seats or group read", () => {
  // A seats read that shows the cap reached is not a refusal (OR-11).
  const seatsAtCap = {
    ...seatsBody(serverList()),
    entitlement_device_cap: 1,
    device_cap: 1,
    seats_used: 1,
    slot_cap: 1,
  };
  const answers: unknown[] = [
    res(200, seatsAtCap),
    failure(res(200, seatsAtCap)),
    res(200, { group_id: GROUP, generation: 1, epoch: 3, members: [] }),
    // A cap type at another status is not the route's refusal.
    res(200, { type: "DeviceCapReached", max: 5 }),
    res(409, { type: "DeviceCapReached", max: 5 }),
    res(403, { type: "DeviceCapReached", max: 5 }),
    res(429, { type: "DeviceCapReached", max: 5 }),
    res(500, { type: "DeviceCapReached", max: 5 }),
    res(400, { type: "MlsCallFull", max: 100 }),
    res(200, { type: "MlsCallFull", max: 100 }),
    res(400, { type: "SeatCapReached", max: 10 }),
    // A native tag in a server body, a server type from native.
    res(400, { type: "text_group_full", max: 100 }),
    { source: "native", error: { type: "DeviceCapReached", max: 5 } },
    { source: "native", error: { type: "MlsCallFull", max: 100 } },
    // A bare error body (no status) is not an answer.
    { type: "DeviceCapReached", max: 5 },
    { type: "MlsCallFull", max: 100 },
    // The server failure's body decides, not its `type` field.
    { source: "server", status: 400, type: "DeviceCapReached", body: null },
    { source: "transport" },
    { source: "client", reason: "join_stalled" },
    { type: "roster_mismatch" },
    { source: "native", error: { type: "busy" } },
    "DeviceCapReached",
    new Error("DeviceCapReached"),
    null,
    undefined,
  ];
  for (const a of answers) {
    assert.equal(joinRefusal(a), null, JSON.stringify(a));
  }
  // No other classifier reads a cap answer as capacity.
  assert.deepEqual(
    classifyTextEnvelopeError({ type: "text_group_full", max: 100 }),
    { ack: true, action: "await_successor", groupError: "text_group_full" },
  );
  const first = classifySubmit(
    {
      kind: "submit",
      response: res(400, { type: "DeviceCapReached", max: 5 }),
    },
    sctx(),
  );
  assert.equal(first.kind, "refetch");
});

// ---------------------------------------------------------------------------
// Admission stagger (D19)
// ---------------------------------------------------------------------------

test("leafStaggerMs: own leaf index x 2 s", () => {
  assert.deepEqual([0, 1, 2, 5].map(leafStaggerMs), [0, 2000, 4000, 10000]);
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(leafStaggerMs(bad), 0);
  }
});

// ---------------------------------------------------------------------------
// S2-W4 fix lane FX-J: async Text join (S2-D28 / S2-D29). Tests named
// "FXJ ..." are the targets of /home/mcp/pc-logs/s2/w4/ctl/FXJ.
// ---------------------------------------------------------------------------

const G = "ab".repeat(32);
const G_OTHER = "cd".repeat(32);

test("FXJ joinRebroadcastDelayMs: 10 s doubling, held at 15 min; a broken count fails to the cap", () => {
  assert.equal(JOIN_REBROADCAST.startMs, JOIN_RETRY_MS);
  assert.equal(JOIN_REBROADCAST.capMs, 900_000);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 50, 10_000].map(joinRebroadcastDelayMs),
    [
      10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 900_000,
      900_000, 900_000, 900_000,
    ],
  );
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(joinRebroadcastDelayMs(bad), 900_000, String(bad));
  }
});

test("FXJ welcomeFetchStep: a 404 rejoins; a 2xx is used only for the group asked for with an epoch and bytes; 429/5xx/transport retried within the budget; other answers give up", () => {
  const ctx = (failures = 0) => ({ groupId: G, failures });
  const welcome = { group_id: G, epoch: 4, welcome: "V0VM" };
  assert.equal(WELCOME_FETCH_AFTER_MS, 20_000);
  assert.deepEqual(
    welcomeFetchStep({ kind: "response", response: res(200, welcome) }, ctx()),
    {
      kind: "process",
      welcome,
    },
  );
  // only the three fields reach the caller
  assert.deepEqual(
    welcomeFetchStep(
      { kind: "response", response: res(200, { ...welcome, extra: 1 }) },
      ctx(),
    ),
    { kind: "process", welcome },
  );
  assert.deepEqual(
    welcomeFetchStep(
      { kind: "response", response: res(404, { type: "NotFound" }) },
      ctx(),
    ),
    { kind: "rejoin" },
  );
  assert.deepEqual(
    welcomeFetchStep(
      {
        kind: "response",
        response: res(200, { ...welcome, group_id: G_OTHER }),
      },
      ctx(),
    ),
    { kind: "give_up", why: "wrong_group" },
  );
  for (const bad of [
    null,
    [],
    { ...welcome, epoch: -1 },
    { ...welcome, epoch: 1.5 },
    { ...welcome, epoch: "4" },
    { ...welcome, welcome: "" },
    { ...welcome, welcome: 7 },
    { epoch: 4, welcome: "V0VM" },
  ]) {
    assert.deepEqual(
      welcomeFetchStep({ kind: "response", response: res(200, bad) }, ctx()),
      { kind: "give_up", why: "malformed" },
      JSON.stringify(bad),
    );
  }
  for (const status of [400, 401, 403, 409, 301]) {
    assert.deepEqual(
      welcomeFetchStep(
        { kind: "response", response: res(status, { type: "X" }) },
        ctx(),
      ),
      { kind: "give_up", why: "refused" },
      String(status),
    );
  }
  // unknown outcomes: retried with backoff, never read as "none stored"
  assert.deepEqual(welcomeFetchStep({ kind: "transport_error" }, ctx(0)), {
    kind: "retry",
    delayMs: 250,
  });
  assert.deepEqual(
    welcomeFetchStep({ kind: "response", response: res(503) }, ctx(1)),
    { kind: "retry", delayMs: 500 },
  );
  assert.deepEqual(
    welcomeFetchStep(
      { kind: "response", response: res(429, null, 1_500) },
      ctx(0),
    ),
    { kind: "retry", delayMs: 1_500 },
  );
  for (const answer of [
    { kind: "transport_error" as const },
    { kind: "response" as const, response: res(500) },
    { kind: "response" as const, response: res(429, null, 1_000) },
  ]) {
    assert.deepEqual(
      welcomeFetchStep(answer, ctx(WELCOME_FETCH_RETRY_BUDGET)),
      { kind: "give_up", why: "budget" },
    );
    assert.deepEqual(welcomeFetchStep(answer, ctx(Number.NaN)), {
      kind: "give_up",
      why: "budget",
    });
  }
});

test("FXJ ownAddedEntry / welcomeDue: this device's latest Add keys the observation; a Welcome is due only at/after the epoch of the last intent", () => {
  const g = (member_added: unknown[]) => ({ group_id: G, member_added });
  assert.equal(ownAddedEntry(g([]), "U", "D"), null);
  const added = ownAddedEntry(
    g([
      { user_id: "U", device_id: "D", epoch: 4, at: "" },
      { user_id: "U", device_id: "D", epoch: 6, at: "" },
      { user_id: "U", device_id: "D2", epoch: 9, at: "" },
      { user_id: "V", device_id: "D", epoch: 9, at: "" },
      { user_id: "U", device_id: "D", epoch: 1.5, at: "" },
      null,
    ]),
    "U",
    "D",
  );
  assert.deepEqual(added, { key: `${G}:6`, epoch: 6 });
  assert.equal(welcomeDue(added, 6), true);
  assert.equal(welcomeDue(added, 5), true);
  assert.equal(welcomeDue(added, 7), false, "an Add before our intent");
  assert.equal(welcomeDue(added, null), false, "no intent sent");
  assert.equal(welcomeDue(null, 0), false);
});

test("FXJ storedJoinRequests: the live request shape (S1 strings, OR-6 generation/issued_at, rejoin boolean); a malformed entry is dropped whole; created_at never kept; a repeat keeps the first", () => {
  const CHAN = "01J9Z3K4M5N6P7Q8R9S0T1V2W3";
  const row = (over: Record<string, unknown> = {}) => ({
    user_id: "U",
    device_id: "D",
    key_package_ref: "KPR",
    signature: "SIG",
    created_at: "2026-11-12T00:00:00Z",
    rejoin: false,
    ...over,
  });
  assert.deepEqual(storedJoinRequests(undefined, G, CHAN), {
    requests: [],
    dropped: 0,
  });
  assert.deepEqual(storedJoinRequests({}, G, CHAN), {
    requests: [],
    dropped: 1,
  });
  const out = storedJoinRequests(
    [
      row({ generation: 2, issued_at: 1_700_000_000_000 }),
      row({ device_id: "D-REJOIN", rejoin: true }),
      row({ signature: "SIG-AGAIN" }),
      row({ device_id: "BAD1", issued_at: 1.5, generation: 2 }),
      row({ device_id: "BAD2", generation: null }),
      row({ device_id: "BAD3", generation: -1 }),
      row({ device_id: "BAD4", rejoin: "false" }),
      row({ device_id: "BAD5", rejoin: undefined }),
      row({ device_id: 7 }),
      row({ signature: undefined }),
      "x",
    ],
    G,
    CHAN,
  );
  assert.equal(out.dropped, 8);
  assert.deepEqual(out.requests, [
    {
      request: {
        group_id: G,
        channel_id: CHAN,
        user_id: "U",
        device_id: "D",
        key_package_ref: "KPR",
        signature: "SIG",
        generation: 2,
        issued_at: 1_700_000_000_000,
      },
      rejoin: false,
    },
    {
      request: {
        group_id: G,
        channel_id: CHAN,
        user_id: "U",
        device_id: "D-REJOIN",
        key_package_ref: "KPR",
        signature: "SIG",
      },
      rejoin: true,
    },
  ]);
  // An S1 entry keeps the S1 shape: no generation / issued_at keys.
  const s1 = storedJoinRequests([row()], G, CHAN).requests[0].request;
  assert.equal("generation" in s1, false);
  assert.equal("issued_at" in s1, false);
  assert.equal("created_at" in s1, false);
});

test("FXJ STORED_ADMIT_REASONS: open, the 60 s refresh, start, event and manual; never a commit refresh", () => {
  for (const r of ["open", "interval", "start", "event", "manual"] as const) {
    assert.ok(STORED_ADMIT_REASONS.includes(r), r);
  }
  for (const r of [
    "commit",
    "resecuring",
    "owner_confirmed",
    "send_refused",
  ] as const) {
    assert.equal(STORED_ADMIT_REASONS.includes(r), false, r);
  }
});

// ---------------------------------------------------------------------------
// S2-W4 fix lane FX-J2 (re-review NEW-1, NEW-2, NEW-3, NEW-5). Tests named
// "FXJ2 ..." are the targets of /home/mcp/pc-logs/s2/w4/ctl/FXJ2.
// ---------------------------------------------------------------------------

test("FXJ2 welcomePending: an Add owes ONE Welcome path while due and not done; done, a new Add owes its own", () => {
  const a4 = { key: "G:4", epoch: 4 };
  assert.equal(welcomePending(a4, 3, null), true, "due, never ran");
  assert.equal(welcomePending(a4, 4, "G:2"), true, "another Add ran");
  assert.equal(welcomePending(a4, 3, "G:4"), false, "this Add is done");
  assert.equal(welcomePending(a4, 5, null), false, "before our last intent");
  assert.equal(welcomePending(a4, null, null), false, "no intent sent yet");
  assert.equal(welcomePending(null, 3, null), false, "no Add");
  assert.equal(
    welcomePending({ key: "G:6", epoch: 6 }, 3, "G:4"),
    true,
    "a new Add is a new path",
  );
});

test("FXJ2 joinEventResetAllowed: an event restarts the join backoff at most once per window (the backoff cap); a broken clock refuses", () => {
  assert.equal(JOIN_EVENT_RESET_GAP_MS, JOIN_REBROADCAST.capMs);
  const t = 1_700_000_000_000;
  assert.equal(joinEventResetAllowed(null, t), true, "the first one");
  assert.equal(joinEventResetAllowed(t, t), false);
  assert.equal(
    joinEventResetAllowed(t, t + JOIN_EVENT_RESET_GAP_MS - 1),
    false,
  );
  assert.equal(joinEventResetAllowed(t, t + JOIN_EVENT_RESET_GAP_MS), true);
  assert.equal(joinEventResetAllowed(t, t - 1), false, "clock ran backwards");
  assert.equal(joinEventResetAllowed(Number.NaN, t), false);
  assert.equal(joinEventResetAllowed(t, Number.POSITIVE_INFINITY), false);
});

test("FXJ2 coalescedRefreshReason: a stored-admit reason wins over one that does not admit; open is strongest; a tie keeps the running reason", () => {
  const admits = ["open", "interval", "event", "manual", "start"] as const;
  const plain = [
    "commit",
    "resecuring",
    "owner_confirmed",
    "send_refused",
  ] as const;
  for (const a of admits) {
    for (const p of plain) {
      assert.equal(coalescedRefreshReason(p, a), a, `${p} + ${a}`);
      assert.equal(coalescedRefreshReason(a, p), a, `${a} + ${p}`);
    }
    assert.ok(STORED_ADMIT_REASONS.includes(a), a);
  }
  for (const r of [...admits, ...plain]) {
    assert.equal(coalescedRefreshReason(r, "open"), "open", r);
    assert.equal(coalescedRefreshReason(r, r), r, `${r} tie`);
  }
  assert.equal(coalescedRefreshReason("interval", "event"), "interval");
  assert.equal(coalescedRefreshReason("commit", "send_refused"), "commit");
  // "start" admits but joins only a left group: any other admit beats it.
  assert.equal(coalescedRefreshReason("start", "interval"), "interval");
  assert.equal(coalescedRefreshReason("interval", "start"), "interval");
});

test("FXJ2 admitRefusalKey / admitRefusedByNative: a request is its group, device and KeyPackage ref; only a native refusal that is not transient counts", () => {
  const req = {
    group_id: "G",
    channel_id: "C",
    user_id: "U",
    device_id: "D",
    key_package_ref: "K1",
    signature: "S",
  };
  assert.equal(
    admitRefusalKey(req),
    admitRefusalKey({ ...req, signature: "X" }),
  );
  assert.equal(
    admitRefusalKey(req),
    admitRefusalKey({ ...req, generation: 2 }),
  );
  for (const over of [
    { key_package_ref: "K2" },
    { device_id: "D2" },
    { group_id: "G2" },
  ]) {
    assert.notEqual(admitRefusalKey(req), admitRefusalKey({ ...req, ...over }));
  }
  // No separator collision between fields.
  assert.notEqual(
    admitRefusalKey({ ...req, group_id: "a:b", device_id: "c" }),
    admitRefusalKey({ ...req, group_id: "a", device_id: "b:c" }),
  );
  for (const type of [
    "mls_leaf_rejected",
    "roster_mismatch",
    "replayed_rejoin_intent",
    "duplicate_leaf",
    "text_group_full",
    "channel_mismatch",
    "invalid_argument",
  ]) {
    assert.equal(admitRefusedByNative({ type }), true, type);
    assert.equal(
      admitRefusedByNative({ source: "native", error: { type } }),
      true,
      `wrapped ${type}`,
    );
  }
  for (const type of [
    "busy",
    "storage",
    "protector",
    "protector_locked",
    "identity_pin_required",
  ]) {
    assert.equal(admitRefusedByNative({ type }), false, type);
  }
  for (const err of [
    { source: "server", status: 403, type: "NotSeated", body: null },
    { source: "transport" },
    { source: "client", reason: "disposed" },
    new Error("x"),
    null,
    "busy",
  ]) {
    assert.equal(admitRefusedByNative(err), false, JSON.stringify(err));
  }
  assert.ok(Number.isSafeInteger(ADMIT_REFUSED_CAP) && ADMIT_REFUSED_CAP > 0);
});

// ---------------------------------------------------------------------------
// S2 final audit fix lane FXF (MAJOR 6c budget binding, MINOR parked
// Welcome). Tests named "FXF ..." are the targets of
// /home/mcp/pc-logs/s2/w4/ctl/FXF.
// ---------------------------------------------------------------------------

test("FXF leafMissingApplies / leafMissingSpent: the 6c budget binds to the group and the held list signer it was spent on; a successor group or another signer starts over; a non-finite or unbound spent count fails closed", () => {
  const listed = (signer_device_id: string): TextChannelState => ({
    ...nativeState("none", "no_group"),
    seat_list: {
      version: 1,
      signer_user_id: "UO",
      signer_device_id,
      seats: ["UO"],
      device_cap: 5,
      issued_at: 0,
    },
  });
  const s1 = leafMissingSigner(listed("D1"));
  const s2 = leafMissingSigner(listed("D2"));
  assert.notEqual(s1, null);
  assert.notEqual(s1, s2, "another signer device");
  assert.equal(leafMissingSigner(null), null);
  assert.equal(leafMissingSigner(nativeState("none", "no_group")), null);
  assert.equal(leafMissingSigner(listed("D1")), s1, "stable");
  const on = { groupId: "G0", signer: s1 };
  assert.equal(leafMissingApplies(on, "G0", s1), true);
  assert.equal(leafMissingApplies(on, "G1", s1), false, "successor group");
  assert.equal(leafMissingApplies(on, "G0", s2), false, "another signer");
  assert.equal(leafMissingApplies(null, "G0", s1), false);
  const B = SIGNER_LEAF_MISSING_BUDGET;
  assert.equal(leafMissingSpent(B - 1, on, "G0", s1), false, "below");
  assert.equal(leafMissingSpent(B, on, "G0", s1), true, "6c");
  assert.equal(leafMissingSpent(B + 4, on, "G0", s1), true);
  assert.equal(leafMissingSpent(B, on, "G1", s1), false, "another group");
  assert.equal(leafMissingSpent(B, on, "G0", s2), false, "another signer");
  assert.equal(leafMissingSpent(Number.NaN, on, "G0", s1), true, "NaN");
  assert.equal(leafMissingSpent(B, null, "G0", s1), true, "unbound");
  assert.equal(leafMissingSpent(0, null, "G0", s1), false);
});

test("FXF welcomeParkedFor / parkedReplay: a parked Welcome for the group keeps its Add pending; a confirm replays only the latest one for the current group, drops the others, and keeps every other envelope in order", () => {
  const w = (id: string, group_id: string, epoch: number) => ({
    id,
    content_type: "mls_welcome",
    group_id,
    epoch,
  });
  const c = (id: string, group_id: string, epoch: number) => ({
    id,
    content_type: "mls_commit",
    group_id,
    epoch,
  });
  const parked = [
    c("C0", "G0", 4),
    w("WA", "G0", 4),
    w("WB", "G1", 2),
    c("C1", "G1", 3),
    w("WC", "G1", 5),
    w("WD", "G1", 3),
  ];
  assert.equal(welcomeParkedFor(parked, "G1"), true);
  assert.equal(welcomeParkedFor(parked, "G0"), true);
  assert.equal(welcomeParkedFor([c("C1", "G1", 3)], "G1"), false, "commit");
  assert.equal(welcomeParkedFor(parked, "G2"), false);
  assert.equal(welcomeParkedFor([], "G1"), false);

  const r = parkedReplay(parked, "G1");
  assert.deepEqual(
    r.replay.map((p) => p.id),
    ["C0", "C1", "WC"],
  );
  assert.deepEqual(
    r.dropped.map((p) => p.id),
    ["WA", "WB", "WD"],
  );
  // Equal epochs: the last one parked.
  const tie = parkedReplay([w("W1", "G1", 5), w("W2", "G1", 5)], "G1");
  assert.deepEqual(
    tie.replay.map((p) => p.id),
    ["W2"],
  );
  // No current group: no Welcome is replayed.
  const none = parkedReplay(parked, null);
  assert.deepEqual(
    none.replay.map((p) => p.id),
    ["C0", "C1"],
  );
  assert.equal(none.dropped.length, 4);
  assert.deepEqual(parkedReplay([], "G1"), { replay: [], dropped: [] });
});
