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
// marked "control:".
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PublishAnswer,
  type PublishStep,
  type SendContext,
  type SendTrigger,
  type SubmitContext,
  type TextEnvelopeVerdict,
  classifySendAnswer,
  classifySubmit,
  classifyTextEnvelopeError,
  CONFIRM_WINDOW_MS,
  confirmAfterId,
  errorTypeOf,
  isCatchUpDesync,
  JOIN_RETRIES,
  JOIN_RETRY_MS,
  LEAF_STAGGER_MS,
  leafStaggerMs,
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
} from "./protectedTextPolicy.ts";
import {
  type SignedSeatList,
  type TextApiResponse,
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

test("D20: 2xx is won with our own bytes and no rejoin intents", () => {
  assert.deepEqual(
    classifySubmit(
      { kind: "submit", response: res(200, { result: "Won" }) },
      sctx(),
    ),
    { kind: "won", storedCommitB64: "T1dO", rejoinIntents: [] },
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
    { kind: "won", storedCommitB64: "U1RPUkVE", rejoinIntents: [] },
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
    [null, 400, "DeviceCapReached", "refresh"],
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

const dctx = (over: Partial<SendContext> = {}): SendContext => ({
  selfUserId: SELF.user_id,
  cid: CID,
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

const msg = (id: string, author: string, nonce: string) => ({
  _id: id,
  channel: "01CHAN00000000000000000000",
  author,
  nonce,
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
// Envelope errors (design 8.4 / 9.2)
// ---------------------------------------------------------------------------

const EXPECTED: Record<
  (typeof TEXT_NATIVE_ERROR_TAGS)[number],
  [
    ack: boolean,
    action: TextEnvelopeVerdict["action"],
    recordsGroupError: boolean,
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
    const [ack, action, records] = EXPECTED[tag];
    const expected: TextEnvelopeVerdict = records
      ? { ack, action, groupError: tag }
      : { ack, action };
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
// Admission stagger (D19)
// ---------------------------------------------------------------------------

test("leafStaggerMs: own leaf index x 2 s", () => {
  assert.deepEqual([0, 1, 2, 5].map(leafStaggerMs), [0, 2000, 4000, 10000]);
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(leafStaggerMs(bad), 0);
  }
});
