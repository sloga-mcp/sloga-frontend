// Unit spec for the add-friend-to-group decision — run with Node's built-in
// runner:
//   node --conditions=browser --test components/modal/modals/addFriendToGroupPolicy.test.ts
// Focus: the add goes ahead only on a ready device, a fresh "plaintext"
// verdict, and an empty device listing for EVERY other member. A listing that
// failed, is missing, or has an unexpected shape refuses; so does any member
// with devices. The fetch fan-out stays at four in flight and stops early,
// and a group with more than 20 other members refuses without fetching.
// An encrypted group is offered as "include" only on a ready device, and
// waitForMember polls every 100 ms, gives up on timeout or abort, and never
// throws.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type GroupVerdict,
  type MemberListing,
  type RowState,
  classifyListing,
  collectListings,
  decideAdd,
  INCLUDE_MEMBER_WAIT_MS,
  MAX_VERIFIED_OTHER_MEMBERS,
  otherMemberIds,
  rowStateFor,
  tooManyToVerify,
  waitForMember,
} from "./addFriendToGroupPolicy.ts";

const empty: MemberListing = { kind: "fetched", body: [] };
const devices: MemberListing = {
  kind: "fetched",
  body: [{ device_id: "D1" }],
};
const failed: MemberListing = { kind: "error", error: 429 };

function input(
  listings: [string, MemberListing][],
  memberIds: string[] | null = listings.map(([id]) => id),
) {
  return {
    selfReady: true,
    verdict: "plaintext" as const,
    memberIds,
    listings: new Map(listings),
  };
}

test("all other members empty: add", () => {
  assert.deepEqual(
    decideAdd(
      input([
        ["A", empty],
        ["B", empty],
      ]),
    ),
    { kind: "add" },
  );
});

test("no other members: add (nobody else could have enabled encryption)", () => {
  assert.deepEqual(decideAdd(input([], [])), { kind: "add" });
});

test("one member errors: refuse as unverified", () => {
  assert.deepEqual(
    decideAdd(
      input([
        ["A", empty],
        ["B", failed],
        ["C", empty],
      ]),
    ),
    { kind: "refuse", reason: "unverified" },
  );
});

test("one member non-empty: refuse as encrypted", () => {
  assert.deepEqual(
    decideAdd(
      input([
        ["A", empty],
        ["B", devices],
      ]),
    ),
    { kind: "refuse", reason: "encrypted" },
  );
});

test("one errors and one non-empty: refused either way", () => {
  assert.equal(
    decideAdd(
      input([
        ["A", failed],
        ["B", devices],
      ]),
    ).kind,
    "refuse",
  );
});

test("a member with no listing at all refuses (never fetched, or joined since)", () => {
  assert.deepEqual(decideAdd(input([["A", empty]], ["A", "B"])), {
    kind: "refuse",
    reason: "unverified",
  });
});

test("unexpected listing shapes refuse", () => {
  for (const body of [null, undefined, {}, "[]", 0, { devices: [] }]) {
    assert.deepEqual(
      decideAdd(input([["A", { kind: "fetched", body }]])),
      { kind: "refuse", reason: "unverified" },
      `body ${JSON.stringify(body)}`,
    );
  }
});

test("device not ready refuses even with empty listings", () => {
  assert.deepEqual(decideAdd({ ...input([["A", empty]]), selfReady: false }), {
    kind: "refuse",
    reason: "unverified",
  });
});

test("only a plaintext verdict can add", () => {
  for (const verdict of [
    null,
    undefined,
    "blocked",
    "peer_downgraded",
    "unconfirmed",
  ] as const) {
    assert.deepEqual(
      decideAdd({ ...input([["A", empty]]), verdict }),
      { kind: "refuse", reason: "unverified" },
      `verdict ${verdict}`,
    );
  }
  assert.deepEqual(
    decideAdd({ ...input([["A", empty]]), verdict: "encrypt" }),
    {
      kind: "refuse",
      reason: "encrypted",
    },
  );
});

test("unknown self (null member list) refuses", () => {
  assert.deepEqual(decideAdd(input([], null)), {
    kind: "refuse",
    reason: "unverified",
  });
});

test("classifyListing", () => {
  assert.equal(classifyListing(empty), "empty");
  assert.equal(classifyListing(devices), "devices");
  assert.equal(classifyListing(failed), "error");
  assert.equal(classifyListing(undefined), "error");
  assert.equal(classifyListing({ kind: "fetched", body: {} }), "error");
});

test("otherMemberIds drops self and duplicates; unknown self is null", () => {
  assert.deepEqual(otherMemberIds(["me", "A", "B", "A"], "me"), ["A", "B"]);
  assert.deepEqual(otherMemberIds(["me"], "me"), []);
  assert.equal(otherMemberIds(["me", "A"], undefined), null);
});

test("rowStateFor: addable only for plaintext on a ready device", () => {
  assert.equal(rowStateFor("plaintext", true), "addable");
  assert.equal(rowStateFor("plaintext", false), "unverified");
  assert.equal(rowStateFor("encrypt", true), "include");
  assert.equal(rowStateFor("encrypt", false), "encrypted");
  assert.equal(rowStateFor(undefined, true), "unverified");
  assert.equal(rowStateFor("blocked", true), "unverified");
  assert.equal(rowStateFor("peer_downgraded", true), "unverified");
});

test("rowStateFor: every verdict on a ready and an unready device", () => {
  const cases: [GroupVerdict, boolean, RowState][] = [
    ["encrypt", true, "include"],
    ["encrypt", false, "encrypted"],
    ["plaintext", true, "addable"],
    ["plaintext", false, "unverified"],
    ["blocked", true, "unverified"],
    ["blocked", false, "unverified"],
    ["peer_downgraded", true, "unverified"],
    ["peer_downgraded", false, "unverified"],
    ["unconfirmed", true, "unverified"],
    ["unconfirmed", false, "unverified"],
    [null, true, "unverified"],
    [null, false, "unverified"],
    [undefined, true, "unverified"],
    [undefined, false, "unverified"],
  ];
  for (const [verdict, ready, expected] of cases) {
    assert.equal(
      rowStateFor(verdict, ready),
      expected,
      `verdict ${verdict} ready ${ready}`,
    );
  }
});

test("an include row never makes the plaintext add go ahead", () => {
  assert.equal(rowStateFor("encrypt", true), "include");
  assert.deepEqual(
    decideAdd({ ...input([["A", empty]]), verdict: "encrypt" }),
    { kind: "refuse", reason: "encrypted" },
  );
});

test("the include wait is 5 seconds", () => {
  assert.equal(INCLUDE_MEMBER_WAIT_MS, 5000);
});

/** A sleep that records each request and resolves at once */
function recordingSleep() {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

test("waitForMember: already present returns true without sleeping", async () => {
  const { calls, sleep } = recordingSleep();
  let checks = 0;
  const has = () => {
    checks++;
    return true;
  };
  assert.equal(await waitForMember(has, { timeoutMs: 5000, sleep }), true);
  assert.equal(checks, 1);
  assert.deepEqual(calls, []);
});

test("waitForMember: appears later, true after polling every 100 ms", async () => {
  const { calls, sleep } = recordingSleep();
  let checks = 0;
  const has = () => ++checks === 3;
  assert.equal(await waitForMember(has, { timeoutMs: 5000, sleep }), true);
  assert.equal(checks, 3);
  assert.deepEqual(calls, [100, 100]);
});

test("waitForMember: never appears, false at the timeout", async () => {
  const { calls, sleep } = recordingSleep();
  let checks = 0;
  const has = () => {
    checks++;
    return false;
  };
  assert.equal(
    await waitForMember(has, { timeoutMs: INCLUDE_MEMBER_WAIT_MS, sleep }),
    false,
  );
  assert.equal(calls.length, 50);
  assert.ok(
    calls.every((ms) => ms === 100),
    `sleeps ${calls}`,
  );
  // once before the first sleep, then once after each
  assert.equal(checks, 51);
});

test("waitForMember: the last sleep is cut to the time left", async () => {
  const { calls, sleep } = recordingSleep();
  assert.equal(
    await waitForMember(() => false, { timeoutMs: 250, sleep }),
    false,
  );
  assert.deepEqual(calls, [100, 100, 50]);
});

test("waitForMember: a member found on the very last check still counts", async () => {
  const { calls, sleep } = recordingSleep();
  let checks = 0;
  const has = () => ++checks === 51;
  assert.equal(await waitForMember(has, { timeoutMs: 5000, sleep }), true);
  assert.equal(calls.length, 50);
});

test("waitForMember: abort during the wait returns false", async () => {
  const controller = new AbortController();
  let sleeps = 0;
  let checks = 0;
  const sleep = async () => {
    if (++sleeps === 2) controller.abort();
  };
  // would turn up on the check after the abort
  const has = () => ++checks === 3;
  assert.equal(
    await waitForMember(has, {
      timeoutMs: 5000,
      signal: controller.signal,
      sleep,
    }),
    false,
  );
  assert.equal(sleeps, 2);
  assert.equal(checks, 2);
});

test("waitForMember: an already aborted signal returns false at once", async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls, sleep } = recordingSleep();
  assert.equal(
    await waitForMember(() => true, {
      timeoutMs: 5000,
      signal: controller.signal,
      sleep,
    }),
    false,
  );
  assert.deepEqual(calls, []);
});

test(
  "waitForMember: abort ends a sleep that never finishes",
  { timeout: 2000 },
  async () => {
    const controller = new AbortController();
    const result = waitForMember(() => false, {
      timeoutMs: 5000,
      signal: controller.signal,
      sleep: () => new Promise<void>(() => {}),
    });
    setTimeout(() => controller.abort(), 5);
    assert.equal(await result, false);
  },
);

test("waitForMember: a throwing has() counts as not present", async () => {
  const { sleep } = recordingSleep();
  let checks = 0;
  const has = () => {
    if (++checks < 3) throw new Error("no channel yet");
    return true;
  };
  assert.equal(await waitForMember(has, { timeoutMs: 5000, sleep }), true);
  assert.equal(
    await waitForMember(
      () => {
        throw new Error("gone");
      },
      { timeoutMs: 300, sleep },
    ),
    false,
  );
});

test("waitForMember: a sleep that rejects or throws doesn't throw", async () => {
  let checks = 0;
  assert.equal(
    await waitForMember(() => ++checks === 2, {
      timeoutMs: 5000,
      sleep: () => Promise.reject(new Error("timer")),
    }),
    true,
  );
  assert.equal(
    await waitForMember(() => false, {
      timeoutMs: 300,
      sleep: () => {
        throw new Error("timer");
      },
    }),
    false,
  );
});

test("waitForMember: a timeout that isn't positive and finite checks once", async () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { calls, sleep } = recordingSleep();
    let checks = 0;
    const has = () => {
      checks++;
      return false;
    };
    assert.equal(
      await waitForMember(has, { timeoutMs, sleep }),
      false,
      `timeout ${timeoutMs}`,
    );
    assert.equal(checks, 1, `timeout ${timeoutMs}`);
    assert.deepEqual(calls, [], `timeout ${timeoutMs}`);
  }
});

test("waitForMember: the default sleep uses real timers", async () => {
  let checks = 0;
  const started = Date.now();
  assert.equal(
    await waitForMember(() => ++checks === 2, { timeoutMs: 1000 }),
    true,
  );
  assert.ok(Date.now() - started >= 90, `took ${Date.now() - started} ms`);
});

test("collectListings: fetches everyone when all empty, at most 4 in flight", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `U${i}`);
  let inFlight = 0;
  let peak = 0;
  const listings = await collectListings(ids, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight--;
    return empty;
  });
  assert.equal(listings.size, 10);
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.ok(peak > 1, `peak ${peak}`);
  assert.deepEqual(decideAdd(input([...listings], ids)), { kind: "add" });
});

test("collectListings: concurrency above 4 is clamped", async () => {
  let inFlight = 0;
  let peak = 0;
  await collectListings(
    Array.from({ length: 12 }, (_, i) => `U${i}`),
    async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return empty;
    },
    50,
  );
  assert.ok(peak <= 4, `peak ${peak}`);
});

test("collectListings: stops starting fetches after a refusal; the gap refuses", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `U${i}`);
  const called: string[] = [];
  const listings = await collectListings(
    ids,
    async (id) => {
      called.push(id);
      return id === "U0" ? failed : empty;
    },
    1,
  );
  assert.deepEqual(called, ["U0"]);
  assert.deepEqual(decideAdd(input([...listings], ids)), {
    kind: "refuse",
    reason: "unverified",
  });
});

test("collectListings: a fetcher that throws counts as an error", async () => {
  const listings = await collectListings(["A", "B"], async (id) => {
    if (id === "B") throw new Error("network");
    return empty;
  });
  assert.equal(listings.get("B")?.kind, "error");
  assert.deepEqual(decideAdd(input([...listings], ["A", "B"])), {
    kind: "refuse",
    reason: "unverified",
  });
});

test("collectListings: no members means no fetches", async () => {
  let calls = 0;
  const listings = await collectListings([], async () => {
    calls++;
    return empty;
  });
  assert.equal(calls, 0);
  assert.equal(listings.size, 0);
});

test("the verify ceiling is 20 other members", () => {
  assert.equal(MAX_VERIFIED_OTHER_MEMBERS, 20);
  assert.equal(tooManyToVerify(Array.from({ length: 20 }, String)), false);
  assert.equal(tooManyToVerify(Array.from({ length: 21 }, String)), true);
});

test("20 other members: every listing fetched, and all empty adds", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `U${i}`);
  const called: string[] = [];
  const listings = await collectListings(ids, async (id) => {
    called.push(id);
    return empty;
  });
  assert.deepEqual([...called].sort(), [...ids].sort());
  assert.equal(listings.size, 20);
  assert.deepEqual(decideAdd(input([...listings], ids)), { kind: "add" });
});

test("21 other members: zero fetches, refused as unverified", async () => {
  const ids = Array.from({ length: 21 }, (_, i) => `U${i}`);
  let calls = 0;
  const listings = await collectListings(ids, async () => {
    calls++;
    return empty;
  });
  assert.equal(calls, 0);
  assert.equal(listings.size, 0);
  assert.deepEqual(decideAdd(input([...listings], ids)), {
    kind: "refuse",
    reason: "unverified",
  });
});

test("21 other members refuse even with every listing present and empty", () => {
  const ids = Array.from({ length: 21 }, (_, i) => `U${i}`);
  assert.deepEqual(
    decideAdd(input(ids.map((id): [string, MemberListing] => [id, empty]))),
    { kind: "refuse", reason: "unverified" },
  );
});
