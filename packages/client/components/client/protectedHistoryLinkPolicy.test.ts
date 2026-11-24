// Unit spec for the S4 history link write policy (W4 lane L1k) - run with
// Node's built-in runner from packages/client:
//   node --test --conditions=browser components/client/protectedHistoryLinkPolicy.test.ts
// Focus: every PUT answer class from the error bodies the backend at
// 2efca34c really sends; the backoff table and its cap; `exists` and
// `disabled` never retry; the PUT path; what a build result turns into
// (and that an unreadable one sends nothing); the member duty truth table;
// the catch-up batch, its order and its cap.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type DutyInput,
  type LinkPutAnswer,
  DUTY_BATCH_MAX,
  LINK_PUT_MAX_ATTEMPTS,
  buildAnswer,
  catchUpDuty,
  classifyLinkPut,
  linkPutPath,
  memberDuty,
} from "./protectedHistoryLinkPolicy.ts";
import { leafStaggerMs } from "./protectedTextPolicy.ts";
import type {
  HistoryLinkBuilt,
  HistoryLinkWire,
} from "./protectedTextTypes.ts";

const G1 = "b4989a8d9b082e1668a726aa3303d3eb8b52688d340ca4dc1e0184f61fc67000";
const G0 = "4a4ba4afc6e6ea1c9f4a271f7eded44ea860fdb814e4e1377121e02635a715b5";
const WRITER_U = "01WRITERUSER000000000000000";
const WRITER_D = "writer-device";
const OTHER_U = "01OTHERUSER0000000000000000";
const OTHER_D = "other-device";

// Error bodies as the backend at 2efca34c serialises them
// (crates/core/result: `{"type": ...}` plus the variant's own fields, never
// a `location`), with the status its responder maps each to.
const RECORDED = {
  exists: { status: 409, body: { type: "HistoryLinkExists" } },
  disabled: {
    status: 400,
    body: { type: "FeatureDisabled", feature: "protected_history" },
  },
  outdated: { status: 400, body: { type: "ProtectedClientOutdated", min: 2 } },
  invalidOperation: { status: 400, body: { type: "InvalidOperation" } },
  notFound: { status: 404, body: { type: "NotFound" } },
  missingPermission: {
    status: 403,
    body: { type: "MissingPermission", permission: "ViewChannel" },
  },
  // the base kill switch (R-W4-24)
  baseSwitch: {
    status: 400,
    body: { type: "FeatureDisabled", feature: "protected_channels" },
  },
  otherFeature: {
    status: 400,
    body: { type: "FeatureDisabled", feature: "e2ee" },
  },
  internal: { status: 500, body: { type: "InternalError" } },
  database: {
    status: 500,
    body: { type: "DatabaseError", operation: "insert_one", collection: "x" },
  },
  // the rate limiter answers outside the typed error enum
  rateLimited: { status: 429, body: { retry_after: 1500 } },
  // a proxy in front of the server answers with no JSON at all
  badGateway: { status: 502, body: null },
} as const;

type Recorded = {
  status: number;
  body: Record<string, unknown> | null;
};

/** The three things the caller reads off an answer. */
function res(r: Recorded) {
  const type = r.body?.type;
  const feature = r.body?.feature;
  return {
    status: r.status,
    errorType: typeof type === "string" ? type : null,
    feature: typeof feature === "string" ? feature : null,
  };
}

const OK = { status: 204, errorType: null, feature: null };

function link(over: Partial<HistoryLinkWire> = {}): HistoryLinkWire {
  return {
    group_id: G1,
    epoch: 7,
    prev_group_id: G1,
    prev_epoch: 6,
    nonce: "bm9uY2U",
    ciphertext: "Y2lwaGVydGV4dA",
    writer_user_id: WRITER_U,
    writer_device_id: WRITER_D,
    signature: "c2lnbmF0dXJl",
    ...over,
  };
}

function built(over: Partial<HistoryLinkBuilt> = {}): HistoryLinkBuilt {
  return {
    link: link(),
    contest: false,
    mismatched_writers: [],
    refused: null,
    ...over,
  };
}

/** A build result as an older or broken shell might hand it over. */
function odd(value: unknown): HistoryLinkBuilt {
  return value as HistoryLinkBuilt;
}

function duty(over: Partial<DutyInput> = {}): DutyInput {
  return {
    outcomeKind: "commit_applied",
    historySetting: true,
    sessionDisabled: false,
    groupId: G1,
    epoch: 7,
    ownLeaf: 3,
    ...over,
  };
}

const ATTEMPTS = [1, 2, 3, 4, 5, 6, 7, 100];

// ---------------------------------------------------------------------------
// classifyLinkPut
// ---------------------------------------------------------------------------

test("constants: six attempts, a batch of 200", () => {
  assert.equal(LINK_PUT_MAX_ATTEMPTS, 6);
  assert.equal(DUTY_BATCH_MAX, 200);
});

test("classifyLinkPut: 204 is done on any attempt", () => {
  for (const attempt of ATTEMPTS) {
    assert.deepEqual(classifyLinkPut(OK, attempt), { kind: "done" });
  }
});

test("classifyLinkPut: HistoryLinkExists is exists and never a retry", () => {
  for (const attempt of ATTEMPTS) {
    assert.deepEqual(classifyLinkPut(res(RECORDED.exists), attempt), {
      kind: "exists",
    });
  }
});

test("classifyLinkPut: FeatureDisabled protected_history is disabled and never a retry", () => {
  for (const attempt of ATTEMPTS) {
    assert.deepEqual(classifyLinkPut(res(RECORDED.disabled), attempt), {
      kind: "disabled",
    });
  }
});

test("classifyLinkPut: FeatureDisabled protected_channels is disabled and never a retry", () => {
  for (const attempt of ATTEMPTS) {
    assert.deepEqual(classifyLinkPut(res(RECORDED.baseSwitch), attempt), {
      kind: "disabled",
    });
  }
});

test("classifyLinkPut: ProtectedClientOutdated is outdated and never a retry", () => {
  for (const attempt of ATTEMPTS) {
    assert.deepEqual(classifyLinkPut(res(RECORDED.outdated), attempt), {
      kind: "outdated",
    });
  }
});

test("classifyLinkPut: any other 4xx is refused, never a retry", () => {
  const cases: Recorded[] = [
    RECORDED.invalidOperation,
    RECORDED.notFound,
    RECORDED.missingPermission,
    // FeatureDisabled for any other feature is neither switch
    RECORDED.otherFeature,
    { status: 400, body: { type: "FeatureDisabled", feature: "voice" } },
    { status: 400, body: { type: "FeatureDisabled", feature: "" } },
    {
      status: 400,
      body: { type: "FeatureDisabled", feature: "Protected_Channels" },
    },
    // the switch names mean nothing under another error
    {
      status: 400,
      body: { type: "InvalidOperation", feature: "protected_channels" },
    },
    { status: 400, body: { type: "FeatureDisabled" } },
    { status: 400, body: null },
    { status: 401, body: { type: "InvalidSession" } },
    { status: 409, body: { type: "ProtectHistoryMoved" } },
    { status: 413, body: null },
  ];
  for (const c of cases) {
    for (const attempt of ATTEMPTS) {
      assert.deepEqual(
        classifyLinkPut(res(c), attempt),
        { kind: "refused" },
        `${c.status} ${JSON.stringify(c.body)} attempt ${attempt}`,
      );
    }
  }
});

test("classifyLinkPut: 5xx, 429 and transport retry on the first attempt", () => {
  const want: LinkPutAnswer = { kind: "retry", afterMs: 2000 };
  assert.deepEqual(classifyLinkPut(res(RECORDED.internal), 1), want);
  assert.deepEqual(classifyLinkPut(res(RECORDED.database), 1), want);
  assert.deepEqual(classifyLinkPut(res(RECORDED.badGateway), 1), want);
  assert.deepEqual(classifyLinkPut(res(RECORDED.rateLimited), 1), want);
  assert.deepEqual(classifyLinkPut("transport", 1), want);
  for (const status of [500, 503, 504, 599]) {
    assert.deepEqual(
      classifyLinkPut({ status, errorType: null, feature: null }, 1),
      want,
    );
  }
});

test("classifyLinkPut: backoff is 2 s, 4 s, 8 s, 16 s, 32 s", () => {
  const table = [2000, 4000, 8000, 16000, 32000];
  const retryable = [
    res(RECORDED.internal),
    res(RECORDED.rateLimited),
    "transport" as const,
  ];
  for (const r of retryable) {
    table.forEach((afterMs, n) => {
      assert.deepEqual(classifyLinkPut(r, n + 1), { kind: "retry", afterMs });
    });
  }
});

test("classifyLinkPut: the sixth attempt is the last", () => {
  const retryable = [
    res(RECORDED.internal),
    res(RECORDED.rateLimited),
    "transport" as const,
  ];
  for (const r of retryable) {
    assert.equal(classifyLinkPut(r, LINK_PUT_MAX_ATTEMPTS - 1).kind, "retry");
    for (const attempt of [LINK_PUT_MAX_ATTEMPTS, 7, 100]) {
      assert.deepEqual(classifyLinkPut(r, attempt), { kind: "refused" });
    }
  }
});

test("classifyLinkPut: an attempt that is not a count gets no retry", () => {
  for (const attempt of [0, -1, 1.5, NaN, Infinity, 2 ** 53]) {
    assert.deepEqual(classifyLinkPut("transport", attempt), {
      kind: "refused",
    });
    assert.deepEqual(classifyLinkPut(res(RECORDED.internal), attempt), {
      kind: "refused",
    });
  }
});

test("classifyLinkPut: a status nobody defined is refused", () => {
  for (const status of [0, 100, 200, 201, 301, 304, 600, -1, NaN, 204.5]) {
    assert.deepEqual(
      classifyLinkPut({ status, errorType: null, feature: null }, 1),
      { kind: "refused" },
      String(status),
    );
  }
  // a known error name on the wrong side of the status table means nothing
  assert.deepEqual(
    classifyLinkPut(
      { status: 200, errorType: "HistoryLinkExists", feature: null },
      1,
    ),
    { kind: "refused" },
  );
  assert.deepEqual(
    classifyLinkPut(
      { status: 500, errorType: "HistoryLinkExists", feature: null },
      LINK_PUT_MAX_ATTEMPTS,
    ),
    { kind: "refused" },
  );
  for (const bad of [null, undefined, "timeout", 204]) {
    assert.deepEqual(
      classifyLinkPut(bad as unknown as "transport", 1),
      { kind: "refused" },
      String(bad),
    );
  }
});

// ---------------------------------------------------------------------------
// linkPutPath
// ---------------------------------------------------------------------------

test("linkPutPath: no query without a contest", () => {
  assert.equal(linkPutPath(link(), false), `/mls/groups/${G1}/history_links/7`);
  assert.equal(
    linkPutPath(link({ group_id: G0, epoch: 0 }), false),
    `/mls/groups/${G0}/history_links/0`,
  );
});

test("linkPutPath: contest=true only with a contest", () => {
  assert.equal(
    linkPutPath(link(), true),
    `/mls/groups/${G1}/history_links/7?contest=true`,
  );
  // anything but the boolean is no contest
  for (const loose of [1, "true", {}, null, undefined]) {
    assert.equal(
      linkPutPath(link(), loose as unknown as boolean),
      `/mls/groups/${G1}/history_links/7`,
    );
  }
});

test("linkPutPath: the holder comes from the link, and stays one segment", () => {
  // the path names the HOLDER (group_id, epoch), never the carried epoch
  const bridge = link({
    group_id: G1,
    epoch: 0,
    prev_group_id: G0,
    prev_epoch: 41,
  });
  assert.equal(linkPutPath(bridge, false), `/mls/groups/${G1}/history_links/0`);
  assert.equal(
    linkPutPath(link({ group_id: "a/b?c#d" }), false),
    "/mls/groups/a%2Fb%3Fc%23d/history_links/7",
  );
});

// ---------------------------------------------------------------------------
// buildAnswer
// ---------------------------------------------------------------------------

test("buildAnswer: a link with no contest is a plain PUT", () => {
  const b = built();
  const a = buildAnswer(b);
  assert.deepEqual(a, {
    put: { link: link(), contest: false },
    ownerNotice: false,
    log: "none",
  });
  // the very object native returned, not a copy
  assert.equal(a.put?.link, b.link);
});

test("buildAnswer: a contest is a PUT with contest and a contest log", () => {
  const b = built({ contest: true });
  const a = buildAnswer(b);
  assert.deepEqual(a, {
    put: { link: link(), contest: true },
    ownerNotice: false,
    log: "contest",
  });
  assert.equal(a.put?.link, b.link);
});

test("buildAnswer: each refused value sends nothing and is the log", () => {
  for (const refused of ["hidden", "not_derived", "too_large"] as const) {
    assert.deepEqual(
      buildAnswer(built({ link: null, refused })),
      { put: null, ownerNotice: false, log: refused },
      refused,
    );
  }
  // the fourth value, null: a link was built
  assert.equal(buildAnswer(built({ refused: null })).log, "none");
  assert.notEqual(buildAnswer(built({ refused: null })).put, null);
});

test("buildAnswer: a reason wins over a link", () => {
  for (const refused of ["hidden", "not_derived", "too_large"] as const) {
    for (const contest of [false, true]) {
      assert.deepEqual(buildAnswer(built({ refused, contest })), {
        put: null,
        ownerNotice: false,
        log: refused,
      });
    }
  }
});

test("buildAnswer: an unknown refused value never produces a PUT", () => {
  for (const refused of ["expired", "", "HIDDEN", 0, 1, true, false, {}, []]) {
    for (const contest of [false, true]) {
      assert.deepEqual(
        buildAnswer(odd({ ...built({ contest }), refused })),
        { put: null, ownerNotice: false, log: "not_derived" },
        JSON.stringify(refused),
      );
    }
  }
});

test("buildAnswer: an unreadable result never produces a PUT", () => {
  const nothing = { put: null, ownerNotice: false, log: "not_derived" };
  const cases: unknown[] = [
    null,
    undefined,
    "link",
    7,
    // no link and no reason
    built({ link: null }),
    { contest: false, mismatched_writers: [], refused: null },
    {},
    // contest is not a boolean
    { ...built(), contest: "true" },
    { ...built(), contest: 1 },
    { ...built(), contest: null },
    { link: link(), mismatched_writers: [], refused: null },
    // a link that cannot name its own PUT
    { ...built(), link: "link" },
    { ...built(), link: link({ group_id: "" }) },
    { ...built(), link: { ...link(), group_id: 5 } },
    { ...built(), link: { ...link(), epoch: "7" } },
    { ...built(), link: link({ epoch: -1 }) },
    { ...built(), link: link({ epoch: 1.5 }) },
    { ...built(), link: link({ epoch: NaN }) },
    { ...built(), link: link({ epoch: 2 ** 53 }) },
    // the writer list is not a list
    { ...built(), mismatched_writers: null },
    { ...built(), mismatched_writers: "x" },
    { ...built(), mismatched_writers: { length: 1 } },
  ];
  for (const c of cases) {
    assert.deepEqual(buildAnswer(odd(c)), nothing, JSON.stringify(c));
  }
});

test("buildAnswer: mismatched writers present raise the owner notice", () => {
  const writers = [
    { user_id: OTHER_U, device_id: OTHER_D },
    { user_id: WRITER_U, device_id: WRITER_D },
  ];
  // with a PUT, with a contest, and with no link at all
  assert.deepEqual(buildAnswer(built({ mismatched_writers: writers })), {
    put: { link: link(), contest: false },
    ownerNotice: true,
    log: "none",
  });
  assert.deepEqual(
    buildAnswer(built({ mismatched_writers: writers, contest: true })),
    { put: { link: link(), contest: true }, ownerNotice: true, log: "contest" },
  );
  for (const refused of ["hidden", "not_derived", "too_large"] as const) {
    assert.deepEqual(
      buildAnswer(built({ link: null, refused, mismatched_writers: writers })),
      { put: null, ownerNotice: true, log: refused },
    );
  }
  assert.equal(
    buildAnswer(built({ mismatched_writers: [writers[0]] })).ownerNotice,
    true,
  );
});

test("buildAnswer: mismatched writers absent raise nothing", () => {
  assert.equal(
    buildAnswer(built({ mismatched_writers: [] })).ownerNotice,
    false,
  );
  assert.equal(
    buildAnswer(built({ mismatched_writers: [], contest: true })).ownerNotice,
    false,
  );
  assert.equal(
    buildAnswer(built({ link: null, refused: "hidden" })).ownerNotice,
    false,
  );
});

test("buildAnswer: a missing mismatched_writers field reads as empty", () => {
  const { mismatched_writers: _dropped, ...older } = built();
  assert.deepEqual(buildAnswer(odd(older)), {
    put: { link: link(), contest: false },
    ownerNotice: false,
    log: "none",
  });
  assert.deepEqual(
    buildAnswer(odd({ ...older, mismatched_writers: undefined })),
    {
      put: { link: link(), contest: false },
      ownerNotice: false,
      log: "none",
    },
  );
  const { mismatched_writers: _dropped2, ...olderRefused } = built({
    link: null,
    refused: "too_large",
  });
  assert.deepEqual(buildAnswer(odd(olderRefused)), {
    put: null,
    ownerNotice: false,
    log: "too_large",
  });
});

test("buildAnswer: the answer never carries a writer id", () => {
  const writers = [{ user_id: OTHER_U, device_id: OTHER_D }];
  const shapes = [
    built({ link: null, refused: "hidden", mismatched_writers: writers }),
    built({ link: null, refused: "too_large", mismatched_writers: writers }),
    odd({ ...built({ mismatched_writers: writers }), refused: "expired" }),
    odd({ ...built({ mismatched_writers: writers }), link: null }),
  ];
  for (const b of shapes) {
    const a = buildAnswer(b);
    assert.deepEqual(Object.keys(a).sort(), ["log", "ownerNotice", "put"]);
    const text = JSON.stringify(a);
    assert.equal(text.includes(OTHER_U), false);
    assert.equal(text.includes(OTHER_D), false);
  }
  // with a PUT the only ids are the link's own, inside the link
  const a = buildAnswer(built({ mismatched_writers: writers }));
  assert.deepEqual(Object.keys(a).sort(), ["log", "ownerNotice", "put"]);
  assert.deepEqual(Object.keys(a.put ?? {}).sort(), ["contest", "link"]);
  assert.equal(JSON.stringify(a).includes(OTHER_U), false);
  assert.equal(JSON.stringify(a).includes(OTHER_D), false);
});

// ---------------------------------------------------------------------------
// memberDuty
// ---------------------------------------------------------------------------

test("memberDuty: commit_applied with history on runs after the leaf stagger", () => {
  assert.deepEqual(memberDuty(duty()), {
    run: true,
    delayMs: 6000,
    holder: { groupId: G1, epoch: 7 },
  });
  for (const ownLeaf of [0, 1, 2, 17]) {
    assert.deepEqual(memberDuty(duty({ ownLeaf })), {
      run: true,
      delayMs: leafStaggerMs(ownLeaf),
      holder: { groupId: G1, epoch: 7 },
    });
  }
  assert.deepEqual(memberDuty(duty({ ownLeaf: 0 })), {
    run: true,
    delayMs: 0,
    holder: { groupId: G1, epoch: 7 },
  });
  assert.deepEqual(memberDuty(duty({ groupId: G0, epoch: 1 })), {
    run: true,
    delayMs: 6000,
    holder: { groupId: G0, epoch: 1 },
  });
});

test("memberDuty: never for duplicate", () => {
  assert.deepEqual(memberDuty(duty({ outcomeKind: "duplicate" })), {
    run: false,
  });
});

test("memberDuty: never for welcome_joined, commit_won or any other outcome", () => {
  const kinds = [
    "welcome_joined",
    "commit_won",
    "commit_lost",
    "proposal_stored",
    "ignored",
    "",
    "COMMIT_APPLIED",
    "commit_applied ",
  ];
  for (const outcomeKind of kinds) {
    assert.deepEqual(memberDuty(duty({ outcomeKind })), { run: false });
  }
});

test("memberDuty: never with historySetting off", () => {
  assert.deepEqual(memberDuty(duty({ historySetting: false })), {
    run: false,
  });
});

test("memberDuty: never once the session is disabled", () => {
  assert.deepEqual(memberDuty(duty({ sessionDisabled: true })), {
    run: false,
  });
});

test("memberDuty: truth table over the outcome kinds and the two flags", () => {
  const kinds = ["commit_applied", "welcome_joined", "duplicate", "commit_won"];
  let ran = 0;
  for (const outcomeKind of kinds) {
    for (const historySetting of [true, false]) {
      for (const sessionDisabled of [true, false]) {
        const want =
          outcomeKind === "commit_applied" &&
          historySetting &&
          !sessionDisabled;
        const got = memberDuty(
          duty({ outcomeKind, historySetting, sessionDisabled }),
        );
        assert.equal(
          got.run,
          want,
          `${outcomeKind} history=${historySetting} disabled=${sessionDisabled}`,
        );
        ran += got.run ? 1 : 0;
      }
    }
  }
  assert.equal(ran, 1);
});

test("memberDuty: an unknown own leaf does not run", () => {
  for (const ownLeaf of [null, undefined, -1, 1.5, NaN, "3", 2 ** 53]) {
    assert.deepEqual(
      memberDuty(duty({ ownLeaf: ownLeaf as number | null })),
      { run: false },
      String(ownLeaf),
    );
  }
});

test("memberDuty: loose flags and a holder that is not one do not run", () => {
  const loose: Record<string, unknown>[] = [
    { historySetting: 1 },
    { historySetting: "true" },
    { historySetting: undefined },
    { sessionDisabled: undefined },
    { sessionDisabled: null },
    { sessionDisabled: 0 },
    { groupId: "" },
    { groupId: 5 },
    { epoch: -1 },
    { epoch: 1.5 },
    { epoch: NaN },
    { epoch: "7" },
  ];
  for (const over of loose) {
    assert.deepEqual(
      memberDuty({ ...duty(), ...over } as DutyInput),
      { run: false },
      JSON.stringify(over),
    );
  }
  assert.deepEqual(memberDuty(null as unknown as DutyInput), { run: false });
});

// ---------------------------------------------------------------------------
// catchUpDuty
// ---------------------------------------------------------------------------

function range(fromEpoch: number, toEpoch: number) {
  return { groupId: G1, fromEpoch, toEpoch };
}

test("catchUpDuty: a range of 1 is that one holder", () => {
  assert.deepEqual(catchUpDuty(range(9, 9), true), {
    holders: [9],
    skipped: 0,
  });
});

test("catchUpDuty: holders come newest first", () => {
  assert.deepEqual(catchUpDuty(range(5, 9), true), {
    holders: [9, 8, 7, 6, 5],
    skipped: 0,
  });
  assert.deepEqual(catchUpDuty(range(0, 2), true), {
    holders: [2, 1, 0],
    skipped: 0,
  });
});

test("catchUpDuty: a range of 200 is taken whole", () => {
  const got = catchUpDuty(range(11, 210), true);
  assert.equal(got.holders.length, 200);
  assert.equal(got.skipped, 0);
  assert.equal(got.holders[0], 210);
  assert.equal(got.holders[199], 11);
});

test("catchUpDuty: a range of 201 leaves the oldest one out", () => {
  const got = catchUpDuty(range(11, 211), true);
  assert.equal(got.holders.length, 200);
  assert.equal(got.skipped, 1);
  assert.equal(got.holders[0], 211);
  assert.equal(got.holders[199], 12);
});

test("catchUpDuty: a range of 450 is the newest 200, 250 skipped", () => {
  const got = catchUpDuty(range(101, 550), true);
  assert.equal(got.holders.length, 200);
  assert.equal(got.skipped, 250);
  assert.deepEqual(
    got.holders,
    Array.from({ length: 200 }, (_unused, n) => 550 - n),
  );
  assert.equal(got.holders[199], 351);
});

test("catchUpDuty: empty with historySetting off", () => {
  for (const r of [range(9, 9), range(5, 9), range(101, 550)]) {
    assert.deepEqual(catchUpDuty(r, false), { holders: [], skipped: 0 });
    for (const loose of [1, "true", null, undefined]) {
      assert.deepEqual(catchUpDuty(r, loose as unknown as boolean), {
        holders: [],
        skipped: 0,
      });
    }
  }
});

test("catchUpDuty: a range that is not one is empty", () => {
  const none = { holders: [], skipped: 0 };
  const bad: unknown[] = [
    range(9, 8),
    range(-1, 3),
    range(1.5, 3),
    range(1, 3.5),
    range(NaN, 3),
    range(1, NaN),
    range(1, Infinity),
    { groupId: "", fromEpoch: 1, toEpoch: 3 },
    { groupId: 5, fromEpoch: 1, toEpoch: 3 },
    { groupId: G1, fromEpoch: "1", toEpoch: 3 },
    { groupId: G1, toEpoch: 3 },
    null,
    undefined,
  ];
  for (const r of bad) {
    assert.deepEqual(
      catchUpDuty(r as ReturnType<typeof range>, true),
      none,
      JSON.stringify(r),
    );
  }
});

test("catchUpDuty: each call returns its own list", () => {
  const a = catchUpDuty(range(5, 6), true);
  a.holders.push(99);
  assert.deepEqual(catchUpDuty(range(5, 6), true).holders, [6, 5]);
  const off = catchUpDuty(range(5, 6), false);
  off.holders.push(99);
  assert.deepEqual(catchUpDuty(range(5, 6), false).holders, []);
});
