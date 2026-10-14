// Unit spec for the group send gate — run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeGroupSendGate.test.ts
// (pure functions, so the browser condition is not load-bearing here — it is
// kept so one invocation can cover the reactive suites beside it.)
// Focus: no verdict reaches "plaintext" without the native layer saying so or
// a "proven" proof for an UNCONFIRMED group; an unestablished group always
// asks; anything malformed is "invalid"; the proof plan fails closed (self
// device filtered, others-only advertised hint, TTL boundary, the listing cap
// and the window budget with no partial fetch).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type GroupSendDecision,
  type PlaintextProof,
  type ProofCache,
  type ProofCacheEntry,
  MAX_UNCACHED_LISTINGS,
  PROBE_WINDOW_CAP,
  PROOF_TTL_MS,
  groupSendDecision,
  historySource,
  listingHasDevices,
  planProof,
} from "./e2eeGroupSendGate.ts";

const SELF = "01J9QCRE7M0000000000000001";
const SELF_DEVICE = "01J9QCRE7MDEV0000000000001";
const OTHER_DEVICE = "01J9QCRE7MDEV0000000000002";
const A = "01J9QCRE7M0000000000000002";
const B = "01J9QCRE7M0000000000000003";
const C = "01J9QCRE7M0000000000000004";
const NOW = 1_800_000_000_000;

const PROOFS: (PlaintextProof | null)[] = [null, "not_proven", "proven"];

/** The native verdict shapes (preamble), as `#invoke` hands them over. */
const VERDICTS = {
  encrypt: { mode: "encrypt" },
  blocked: { mode: "blocked", device_ids: [OTHER_DEVICE] },
  plaintext: { mode: "plaintext" },
  peer_downgraded: { mode: "peer_downgraded", user_id: A },
  group_unconfirmed: { mode: "group_unconfirmed" },
  group_unestablished: { mode: "group_unestablished" },
} as const;

type Mode = keyof typeof VERDICTS;

/** Expected decision per verdict, per proof (null, not_proven, proven). */
const TABLE: Record<
  Mode,
  [GroupSendDecision, GroupSendDecision, GroupSendDecision]
> = {
  encrypt: ["encrypt", "encrypt", "encrypt"],
  blocked: ["blocked", "blocked", "blocked"],
  plaintext: ["plaintext", "plaintext", "plaintext"],
  peer_downgraded: ["peer_downgraded", "peer_downgraded", "peer_downgraded"],
  group_unconfirmed: [
    "confirm_unconfirmed",
    "confirm_unconfirmed",
    "plaintext",
  ],
  group_unestablished: [
    "confirm_unestablished",
    "confirm_unestablished",
    "confirm_unestablished",
  ],
};

/** Verdicts that are not a native answer; every one must be "invalid". */
function malformedVerdicts(): [string, unknown][] {
  const inherited = Object.create({ mode: "plaintext" }) as object;
  const throwing = {
    get mode(): string {
      throw new Error("getter");
    },
  };
  return [
    ["null", null],
    ["undefined", undefined],
    ["number", 0],
    ["NaN", NaN],
    ["boolean", true],
    ["bare string", "plaintext"],
    ["empty object", {}],
    ["mode missing", { device_ids: [] }],
    ["mode null", { mode: null }],
    ["mode undefined", { mode: undefined }],
    ["mode number", { mode: 1 }],
    ["mode array", { mode: ["plaintext"] }],
    ["mode object", { mode: { mode: "plaintext" } }],
    ["unknown mode", { mode: "group_unknown" }],
    ["empty mode", { mode: "" }],
    ["case variant", { mode: "Plaintext" }],
    ["padded", { mode: " plaintext" }],
    ["composer value", { mode: "unconfirmed" }],
    ["ack value", { mode: "unestablished" }],
    ["empty array", []],
    ["array of mode", ["plaintext"]],
    ["array with mode prop", Object.assign([], { mode: "plaintext" })],
    ["inherited mode", inherited],
    ["throwing getter", throwing],
  ];
}

// ---- groupSendDecision ------------------------------------------------------

test("groupSendDecision: every verdict x proof cell", () => {
  let cells = 0;
  for (const mode of Object.keys(TABLE) as Mode[]) {
    PROOFS.forEach((proof, i) => {
      assert.equal(
        groupSendDecision(VERDICTS[mode], proof),
        TABLE[mode][i],
        `${mode} with proof ${String(proof)}`,
      );
      cells++;
    });
  }
  assert.equal(cells, 18);
});

test("groupSendDecision: group_unconfirmed is plaintext ONLY with proven", () => {
  const v = { mode: "group_unconfirmed" };
  assert.equal(groupSendDecision(v, "proven"), "plaintext");
  assert.equal(groupSendDecision(v, "not_proven"), "confirm_unconfirmed");
  assert.equal(groupSendDecision(v, null), "confirm_unconfirmed");
  // A proof value outside the union (a caller bug) never proves anything.
  for (const bogus of ["Proven", "", "yes", true, 1, undefined]) {
    assert.equal(
      groupSendDecision(v, bogus as unknown as PlaintextProof),
      "confirm_unconfirmed",
      String(bogus),
    );
  }
});

test("groupSendDecision: group_unestablished ignores the proof", () => {
  for (const proof of PROOFS) {
    assert.equal(
      groupSendDecision({ mode: "group_unestablished" }, proof),
      "confirm_unestablished",
    );
  }
});

test("groupSendDecision: the decision rides on mode alone", () => {
  // Extra native fields (and their absence) do not change the decision.
  assert.equal(groupSendDecision({ mode: "blocked" }, null), "blocked");
  assert.equal(
    groupSendDecision({ mode: "peer_downgraded" }, "proven"),
    "peer_downgraded",
  );
  assert.equal(
    groupSendDecision(JSON.parse('{"mode":"group_unconfirmed"}'), "proven"),
    "plaintext",
  );
});

test("groupSendDecision: malformed or unknown verdicts are invalid", () => {
  for (const [name, verdict] of malformedVerdicts()) {
    for (const proof of PROOFS) {
      assert.equal(
        groupSendDecision(verdict, proof),
        "invalid",
        `${name} with proof ${String(proof)}`,
      );
    }
  }
});

// ---- historySource ----------------------------------------------------------

test("historySource: server for plaintext and both rowless verdicts", () => {
  assert.equal(historySource(VERDICTS.plaintext), "server");
  assert.equal(historySource(VERDICTS.group_unconfirmed), "server");
  assert.equal(historySource(VERDICTS.group_unestablished), "server");
});

test("historySource: local for encrypted states and anything unknown", () => {
  assert.equal(historySource(VERDICTS.encrypt), "local");
  assert.equal(historySource(VERDICTS.blocked), "local");
  assert.equal(historySource(VERDICTS.peer_downgraded), "local");
  for (const [name, verdict] of malformedVerdicts()) {
    assert.equal(historySource(verdict), "local", name);
  }
});

// ---- listingHasDevices ------------------------------------------------------

test("listingHasDevices: own listing filters this device out", () => {
  const self = [{ device_id: SELF_DEVICE }];
  assert.equal(listingHasDevices(SELF, SELF, SELF_DEVICE, []), false);
  assert.equal(listingHasDevices(SELF, SELF, SELF_DEVICE, self), false);
  assert.equal(
    listingHasDevices(SELF, SELF, SELF_DEVICE, [
      { device_id: SELF_DEVICE },
      { device_id: OTHER_DEVICE },
    ]),
    true,
  );
  assert.equal(
    listingHasDevices(SELF, SELF, SELF_DEVICE, [{ device_id: OTHER_DEVICE }]),
    true,
  );
});

test("listingHasDevices: own listing with no known device id counts all", () => {
  assert.equal(listingHasDevices(SELF, SELF, null, []), false);
  assert.equal(
    listingHasDevices(SELF, SELF, null, [{ device_id: SELF_DEVICE }]),
    true,
  );
});

test("listingHasDevices: another user has devices iff non-empty", () => {
  assert.equal(listingHasDevices(A, SELF, SELF_DEVICE, []), false);
  assert.equal(
    listingHasDevices(A, SELF, SELF_DEVICE, [{ device_id: OTHER_DEVICE }]),
    true,
  );
  // Our device id in someone else's listing is still their device.
  assert.equal(
    listingHasDevices(A, SELF, SELF_DEVICE, [{ device_id: SELF_DEVICE }]),
    true,
  );
  assert.equal(listingHasDevices(A, SELF, null, []), false);
});

test("listingHasDevices: a malformed listing counts as has devices", () => {
  type Listing = readonly { device_id: string }[];
  for (const bad of [null, undefined, {}, { length: 0 }, "[]"]) {
    assert.equal(
      listingHasDevices(A, SELF, SELF_DEVICE, bad as unknown as Listing),
      true,
      `other ${JSON.stringify(bad)}`,
    );
    assert.equal(
      listingHasDevices(SELF, SELF, SELF_DEVICE, bad as unknown as Listing),
      true,
      `self ${JSON.stringify(bad)}`,
    );
  }
  // An own entry without a usable device id is not provably this device.
  assert.equal(
    listingHasDevices(SELF, SELF, SELF_DEVICE, [{} as { device_id: string }]),
    true,
  );
});

// ---- planProof --------------------------------------------------------------

function cacheOf(entries: [string, ProofCacheEntry][]): ProofCache {
  return new Map(entries);
}

function plan(over: Partial<Parameters<typeof planProof>[0]> = {}) {
  return planProof({
    selfId: SELF,
    selfDeviceId: SELF_DEVICE,
    otherIds: [A, B],
    advertised: new Set(),
    cache: cacheOf([]),
    now: NOW,
    windowBudget: PROBE_WINDOW_CAP,
    ...over,
  });
}

const fresh = (hasDevices: boolean): ProofCacheEntry => ({
  hasDevices,
  at: NOW - 1,
});

test("planProof: the pinned constants", () => {
  assert.equal(PROOF_TTL_MS, 300_000);
  assert.equal(MAX_UNCACHED_LISTINGS, 40);
  assert.equal(PROBE_WINDOW_CAP, 30);
});

test("planProof: no known own device id is never proven", () => {
  assert.deepEqual(plan({ selfDeviceId: null }), { decided: "not_proven" });
  // ...even with every listing cached empty and fresh.
  const cache = cacheOf([
    [SELF, fresh(false)],
    [A, fresh(false)],
    [B, fresh(false)],
  ]);
  assert.deepEqual(plan({ selfDeviceId: null, cache }), {
    decided: "not_proven",
  });
});

test("planProof: an advertised OTHER member decides not_proven", () => {
  const cache = cacheOf([
    [SELF, fresh(false)],
    [A, fresh(false)],
    [B, fresh(false)],
  ]);
  assert.deepEqual(plan({ advertised: new Set([B]), cache }), {
    decided: "not_proven",
  });
  // No fetch is planned for an advertised member either.
  assert.deepEqual(plan({ advertised: new Set([A]) }), {
    decided: "not_proven",
  });
});

test("planProof: our own advertised flag is ignored", () => {
  assert.deepEqual(plan({ advertised: new Set([SELF]) }), {
    fetch: [SELF, A, B],
  });
  const cache = cacheOf([
    [SELF, fresh(false)],
    [A, fresh(false)],
    [B, fresh(false)],
  ]);
  assert.deepEqual(plan({ advertised: new Set([SELF]), cache }), {
    decided: "proven",
  });
  // An advertised user who is not a member is irrelevant.
  assert.deepEqual(plan({ advertised: new Set([C]), cache }), {
    decided: "proven",
  });
});

test("planProof: self in otherIds and duplicates are deduped", () => {
  assert.deepEqual(plan({ otherIds: [A, SELF, B, A, SELF] }), {
    fetch: [SELF, A, B],
  });
  assert.deepEqual(plan({ otherIds: [] }), { fetch: [SELF] });
  assert.deepEqual(plan({ otherIds: [SELF] }), { fetch: [SELF] });
});

test("planProof: a fresh has-devices entry decides not_proven", () => {
  for (const who of [SELF, A, B]) {
    const cache = cacheOf([[who, fresh(true)]]);
    assert.deepEqual(plan({ cache }), { decided: "not_proven" }, who);
  }
  // ...even when the other listings would be over every budget.
  assert.deepEqual(
    plan({ cache: cacheOf([[B, fresh(true)]]), windowBudget: 0 }),
    { decided: "not_proven" },
  );
});

test("planProof: the TTL boundary — exactly PROOF_TTL_MS old is uncached", () => {
  const at = (age: number): ProofCacheEntry => ({
    hasDevices: false,
    at: NOW - age,
  });
  const allAged = (age: number) =>
    cacheOf([
      [SELF, at(age)],
      [A, at(age)],
      [B, at(age)],
    ]);
  assert.deepEqual(plan({ cache: allAged(PROOF_TTL_MS - 1) }), {
    decided: "proven",
  });
  assert.deepEqual(plan({ cache: allAged(PROOF_TTL_MS) }), {
    fetch: [SELF, A, B],
  });
  assert.deepEqual(plan({ cache: allAged(0) }), { decided: "proven" });

  // A stale has-devices entry no longer decides; it is refetched.
  const staleTrue = cacheOf([
    [SELF, fresh(false)],
    [A, { hasDevices: true, at: NOW - PROOF_TTL_MS }],
    [B, fresh(false)],
  ]);
  assert.deepEqual(plan({ cache: staleTrue }), { fetch: [A] });
});

test("planProof: an entry dated in the future is refetched", () => {
  const cache = cacheOf([
    [SELF, fresh(false)],
    [A, { hasDevices: false, at: NOW + 1 }],
    [B, { hasDevices: false, at: NaN }],
  ]);
  assert.deepEqual(plan({ cache }), { fetch: [A, B] });
});

test("planProof: every listing fresh and empty is proven", () => {
  const cache = cacheOf([
    [SELF, fresh(false)],
    [A, fresh(false)],
    [B, fresh(false)],
  ]);
  assert.deepEqual(plan({ cache }), { decided: "proven" });
  // The budget is not consulted when nothing needs fetching.
  assert.deepEqual(plan({ cache, windowBudget: 0 }), { decided: "proven" });
});

test("planProof: more than MAX_UNCACHED_LISTINGS uncached is not_proven", () => {
  const many = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `01J9QCRE7M${String(i).padStart(15, "0")}X`,
    );
  // SELF + 39 others = 40 uncached: allowed with the budget to match.
  const at40 = plan({ otherIds: many(39), windowBudget: 1_000 });
  assert.ok("fetch" in at40);
  assert.equal(at40.fetch.length, MAX_UNCACHED_LISTINGS);
  // SELF + 40 others = 41 uncached: refused whatever the budget.
  assert.deepEqual(plan({ otherIds: many(40), windowBudget: 1_000 }), {
    decided: "not_proven",
  });
  assert.deepEqual(plan({ otherIds: many(40), windowBudget: Infinity }), {
    decided: "not_proven",
  });
});

test("planProof: more uncached than the window budget is not_proven", () => {
  // Three uncached listings (SELF, A, B).
  assert.deepEqual(plan({ windowBudget: 3 }), { fetch: [SELF, A, B] });
  assert.deepEqual(plan({ windowBudget: 2 }), { decided: "not_proven" });
  assert.deepEqual(plan({ windowBudget: 0 }), { decided: "not_proven" });
  assert.deepEqual(plan({ windowBudget: -1 }), { decided: "not_proven" });
  assert.deepEqual(plan({ windowBudget: NaN }), { decided: "not_proven" });
  // No partial fetch: a cached entry shrinks the list, never the budget.
  const cache = cacheOf([[SELF, fresh(false)]]);
  assert.deepEqual(plan({ cache, windowBudget: 2 }), { fetch: [A, B] });
  assert.deepEqual(plan({ cache, windowBudget: 1 }), { decided: "not_proven" });
});

test("planProof: the fetch list is exactly [self, ...others] in order", () => {
  assert.deepEqual(plan({ otherIds: [C, A, B] }), { fetch: [SELF, C, A, B] });
  // Fresh empty entries are skipped, the order of the rest is kept.
  const cache = cacheOf([[A, fresh(false)]]);
  assert.deepEqual(plan({ otherIds: [C, A, B], cache }), {
    fetch: [SELF, C, B],
  });
  // Self fresh and empty: only the others are fetched.
  const selfCached = cacheOf([[SELF, fresh(false)]]);
  assert.deepEqual(plan({ otherIds: [B, A], cache: selfCached }), {
    fetch: [B, A],
  });
});

test("planProof: never writes the cache (errors are never cached)", () => {
  // A failed listing leaves no entry, so the next plan fetches it again.
  const cache = new Map([[SELF, fresh(false)]]);
  const frozen = new Proxy(cache, {
    get(target, key) {
      if (key === "set" || key === "delete" || key === "clear") {
        throw new Error(`cache.${String(key)} called`);
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  assert.deepEqual(plan({ cache: frozen }), { fetch: [A, B] });
  assert.deepEqual(plan({ cache: frozen }), { fetch: [A, B] });
  assert.equal(cache.size, 1);
});

test("planProof: the result is a fresh array, never the input", () => {
  const otherIds = [A, B];
  const result = plan({ otherIds });
  assert.ok("fetch" in result);
  assert.notEqual(result.fetch, otherIds);
  assert.deepEqual(otherIds, [A, B]);
});
