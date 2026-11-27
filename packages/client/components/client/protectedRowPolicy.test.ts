// Spec for `protectedRowPolicy.ts` (S4-W4 lane L1p): the row policy of a
// protected or pinned channel (design 9.5, S4-D16, S4-PA-1), the native
// input it is fed, the divider position and the ULID time rule.
//
// The policy has no options bag of its own; the production caller builds
// its `native` input with `nativeHistoryInput(view.native, { seatListError:
// view.seatListError })`, so the end-to-end cases below go through exactly
// that call.
//
// Run from packages/client:
//   node --conditions=browser --test components/client/protectedRowPolicy.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { ulidTimeMs as sdkUlidTimeMs } from "../../../stoat.js/src/lib/protectedHistory.ts";

import {
  type RowPolicyInput,
  type RowPolicyResult,
  dividerAfter,
  nativeHistoryInput,
  rowPolicy,
  ulidTimeMs,
} from "./protectedRowPolicy.ts";
import type { TextChannelState } from "./protectedTextTypes.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID carrying `ms`, with a fixed tail so ids of one time sort by it. */
function ulid(ms: number, tail = "0000000000000000"): string {
  let time = "";
  let rest = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  return time + tail;
}

// One channel: protected at T0 + 3000 ms, the last earlier message being B.
const T0 = 1_700_000_000_000;
const BELOW = ulid(T0 + 1000);
const MID = ulid(T0 + 2000);
const B = ulid(T0 + 3000);
const ABOVE = ulid(T0 + 4000);
const OTHER_B = ulid(T0 + 3500);
/** The earliest verified list was issued in B's own millisecond. */
const LIMIT = T0 + 3000;

type Native = NonNullable<RowPolicyInput["native"]>;

const native = (over: Partial<Native> = {}): Native => ({
  verified: true,
  boundary: B,
  preHistory: "kept",
  timeLimit: LIMIT,
  ...over,
});

/** A plaintext row below the boundary with everything arm 3 asks for. */
const row = (over: Partial<RowPolicyInput> = {}): RowPolicyInput => ({
  hasEncrypted: false,
  id: BELOW,
  pin: { boundary: B, wiped: false },
  native: native(),
  ...over,
});

const PLAIN: RowPolicyResult = { kind: "plain" };
const RED: RowPolicyResult = { kind: "red" };
const CHECKING: RowPolicyResult = { kind: "checking" };

/** The arm number of a result kind (design 9.5). */
function arm(kind: RowPolicyResult["kind"]): 1 | 2 | 3 | 4 {
  switch (kind) {
    case "decrypt":
      return 1;
    case "checking":
      return 2;
    case "plain":
      return 3;
    case "red":
      return 4;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled kind ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The fixtures themselves
// ---------------------------------------------------------------------------

test("fixtures: the ids carry their times and sort by them", () => {
  assert.equal(ulidTimeMs(BELOW), T0 + 1000);
  assert.equal(ulidTimeMs(B), T0 + 3000);
  assert.ok(BELOW < MID && MID < B && B < OTHER_B && OTHER_B < ABOVE);
  for (const id of [BELOW, MID, B, ABOVE, OTHER_B]) {
    assert.equal(id.length, 26);
  }
});

// ---------------------------------------------------------------------------
// Arm 1: an encrypted row
// ---------------------------------------------------------------------------

test("arm 1: an encrypted row is decrypt whatever else holds", () => {
  // every state that sends a plaintext row to arm 2, 3 or 4
  const others: Partial<RowPolicyInput>[] = [
    { native: null },
    { native: native({ verified: false }) },
    {},
    { id: ABOVE },
    { native: native({ preHistory: "wiped" }) },
    { pin: { boundary: B, wiped: true } },
    { pin: { boundary: OTHER_B, wiped: false } },
    { native: native({ boundary: null }) },
    { native: native({ timeLimit: null }) },
    { id: "not-a-ulid" },
  ];
  for (const over of others) {
    const plaintext = rowPolicy(row(over));
    const encrypted = rowPolicy(row({ ...over, hasEncrypted: true }));
    assert.notEqual(plaintext.kind, "decrypt", JSON.stringify(over));
    assert.equal(encrypted.kind, "decrypt", JSON.stringify(over));
    assert.equal(arm(encrypted.kind), 1);
  }
});

test("arm 1: belowBoundary at and below the boundary, not above", () => {
  const at = (id: string) => rowPolicy(row({ hasEncrypted: true, id }));
  assert.deepEqual(at(BELOW), { kind: "decrypt", belowBoundary: true });
  assert.deepEqual(at(B), { kind: "decrypt", belowBoundary: true });
  assert.deepEqual(at(ABOVE), { kind: "decrypt", belowBoundary: false });
  // the note does not depend on pre_history, the pin or the time limit
  assert.deepEqual(
    rowPolicy(
      row({
        hasEncrypted: true,
        pin: null,
        native: native({ preHistory: "wiped", timeLimit: null }),
      }),
    ),
    { kind: "decrypt", belowBoundary: true },
  );
});

test("arm 1: belowBoundary needs a verified boundary", () => {
  const off: RowPolicyResult = { kind: "decrypt", belowBoundary: false };
  const enc = (n: RowPolicyInput["native"], id = BELOW) =>
    rowPolicy(row({ hasEncrypted: true, id, native: n }));

  // a boundary on hand, but from a state that is not verified
  assert.deepEqual(enc(native({ verified: false })), off);
  // not loaded, no boundary, a malformed boundary, a malformed id
  assert.deepEqual(enc(null), off);
  assert.deepEqual(enc(native({ boundary: null })), off);
  assert.deepEqual(enc(native({ boundary: "ZZZZ" })), off);
  assert.deepEqual(enc(native({ boundary: B.toLowerCase() })), off);
  assert.deepEqual(enc(native(), ""), off);
  assert.deepEqual(enc(native(), BELOW.toLowerCase()), off);
});

// ---------------------------------------------------------------------------
// Arm 2: plaintext, nothing verified yet
// ---------------------------------------------------------------------------

test("arm 2: plaintext with no native state is checking", () => {
  assert.deepEqual(rowPolicy(row({ native: null })), CHECKING);
  // also for the rows arm 4 would refuse once the state is there
  assert.deepEqual(rowPolicy(row({ native: null, id: ABOVE })), CHECKING);
  assert.deepEqual(rowPolicy(row({ native: null, id: "x" })), CHECKING);
  assert.deepEqual(
    rowPolicy(row({ native: null, pin: { boundary: B, wiped: true } })),
    CHECKING,
  );
});

test("arm 2: plaintext with unverified state is checking", () => {
  const unverified = native({ verified: false });
  // every arm 3 clause holds, yet the row is not an ordinary message
  assert.deepEqual(rowPolicy(row({ native: unverified })), CHECKING);
  assert.deepEqual(rowPolicy(row({ native: unverified, pin: null })), CHECKING);
  // and what would be red is not red yet
  assert.deepEqual(rowPolicy(row({ native: unverified, id: ABOVE })), CHECKING);
  assert.deepEqual(
    rowPolicy(
      row({ native: native({ verified: false, preHistory: "wiped" }) }),
    ),
    CHECKING,
  );
  assert.equal(arm(rowPolicy(row({ native: unverified })).kind), 2);
});

test("arm 2: only the literal true counts as verified", () => {
  for (const verified of [undefined, null, 1, "true", {}]) {
    const n = native({ verified: verified as unknown as boolean });
    assert.deepEqual(rowPolicy(row({ native: n })), CHECKING);
    assert.deepEqual(rowPolicy(row({ native: n, hasEncrypted: true })), {
      kind: "decrypt",
      belowBoundary: false,
    });
  }
});

// ---------------------------------------------------------------------------
// Arm 3: an ordinary message
// ---------------------------------------------------------------------------

test("arm 3: a kept row below the boundary is plain", () => {
  assert.deepEqual(rowPolicy(row()), PLAIN);
  assert.deepEqual(rowPolicy(row({ id: MID })), PLAIN);
  // a pin without a history record does not stand in the way
  assert.deepEqual(rowPolicy(row({ pin: null })), PLAIN);
  assert.equal(arm(rowPolicy(row()).kind), 3);
});

test("arm 3: id === boundary is plain", () => {
  assert.deepEqual(rowPolicy(row({ id: B })), PLAIN);
});

test("arm 3: a row timed exactly at the limit is plain", () => {
  // B carries the limit's own millisecond
  assert.equal(ulidTimeMs(B), LIMIT);
  assert.deepEqual(rowPolicy(row({ id: B })), PLAIN);
  const tight = native({ timeLimit: T0 + 2000 });
  assert.deepEqual(rowPolicy(row({ id: MID, native: tight })), PLAIN);
});

// ---------------------------------------------------------------------------
// Arm 4: red
// ---------------------------------------------------------------------------

test("arm 4: an id above the boundary is red", () => {
  assert.deepEqual(rowPolicy(row({ id: ABOVE })), RED);
  // the next id after B, in B's own millisecond
  const next = ulid(T0 + 3000, "0000000000000001");
  assert.ok(next > B);
  assert.deepEqual(rowPolicy(row({ id: next })), RED);
  assert.equal(arm(rowPolicy(row({ id: ABOVE })).kind), 4);
});

test("arm 4: 1 ms after the limit is red with id <= boundary", () => {
  const tight = native({ timeLimit: T0 + 1999 });
  assert.ok(MID <= B);
  assert.equal(ulidTimeMs(MID), T0 + 1999 + 1);
  assert.deepEqual(rowPolicy(row({ id: MID, native: tight })), RED);
  // the boundary row itself is no exception
  assert.deepEqual(rowPolicy(row({ id: B, native: tight })), RED);
  // a row before the limit in the same channel still shows
  assert.deepEqual(rowPolicy(row({ id: BELOW, native: tight })), PLAIN);
});

test("arm 4: no time limit or an unusable one is red", () => {
  for (const timeLimit of [null, NaN, Infinity, -1, 2 ** 53, LIMIT + 0.5]) {
    assert.deepEqual(
      rowPolicy(row({ native: native({ timeLimit }) })),
      RED,
      String(timeLimit),
    );
  }
  const text = native({ timeLimit: String(LIMIT) as unknown as number });
  assert.deepEqual(rowPolicy(row({ native: text })), RED);
});

test("arm 4: pin wiped beats native kept", () => {
  const wiped = { boundary: B, wiped: true };
  assert.equal(native().preHistory, "kept");
  assert.deepEqual(rowPolicy(row({ pin: wiped })), RED);
  assert.deepEqual(rowPolicy(row({ pin: wiped, id: B })), RED);
});

test("arm 4: a pin flag that is not the literal false is red", () => {
  for (const flag of [undefined, null, 0, "false"]) {
    const pin = { boundary: B, wiped: flag as unknown as boolean };
    assert.deepEqual(rowPolicy(row({ pin })), RED, String(flag));
  }
});

test("arm 4: a pin boundary mismatch is red", () => {
  // above and below the native one, and for every row
  for (const boundary of [OTHER_B, ABOVE, MID, ""]) {
    const pin = { boundary, wiped: false };
    assert.deepEqual(rowPolicy(row({ pin })), RED, boundary);
    assert.deepEqual(rowPolicy(row({ pin, id: B })), RED, boundary);
  }
});

test("arm 4: natively wiped or unset pre_history is red", () => {
  assert.deepEqual(
    rowPolicy(row({ native: native({ preHistory: "wiped" }) })),
    RED,
  );
  assert.deepEqual(
    rowPolicy(row({ native: native({ preHistory: null }) })),
    RED,
  );
  const odd = native({ preHistory: "KEPT" as unknown as "kept" });
  assert.deepEqual(rowPolicy(row({ native: odd })), RED);
});

test("arm 4: no boundary or a malformed one is red", () => {
  const bad = [null, "", "ZZZZ", B.toLowerCase(), B + "0", "~".repeat(26)];
  for (const boundary of bad) {
    // the pin agreeing with a malformed boundary changes nothing
    const pin = boundary === null ? null : { boundary, wiped: false };
    assert.deepEqual(
      rowPolicy(row({ pin, native: native({ boundary }) })),
      RED,
      String(boundary),
    );
  }
});

test("arm 4: a malformed id is red", () => {
  const bad = ["", "0", BELOW.toLowerCase(), BELOW.slice(1), BELOW + "0"];
  // 26 characters that sort below B but are no ULID
  bad.push(" ".repeat(26), "8" + BELOW.slice(1), BELOW.slice(0, 25) + "U");
  for (const id of bad) {
    assert.deepEqual(rowPolicy(row({ id })), RED, JSON.stringify(id));
  }
});

// ---------------------------------------------------------------------------
// The whole matrix against a decision table
// ---------------------------------------------------------------------------

test("matrix: every input combination matches the decision table", () => {
  // The table knows the fixture times itself, so it shares no code with
  // the module.
  const ids: [string, number | null][] = [
    [BELOW, T0 + 1000],
    [MID, T0 + 2000],
    [B, T0 + 3000],
    [ABOVE, T0 + 4000],
    ["not-a-ulid", null],
  ];
  const pins: RowPolicyInput["pin"][] = [
    null,
    { boundary: B, wiped: false },
    { boundary: B, wiped: true },
    { boundary: OTHER_B, wiped: false },
    { boundary: OTHER_B, wiped: true },
  ];
  const natives: RowPolicyInput["native"][] = [null];
  for (const verified of [true, false]) {
    for (const boundary of [B, null, "malformed"]) {
      for (const preHistory of ["kept", "wiped", null] as const) {
        // at B, before MID, after ABOVE (so only the boundary refuses ABOVE)
        for (const timeLimit of [LIMIT, T0 + 1999, T0 + 5000, null]) {
          natives.push({ verified, boundary, preHistory, timeLimit });
        }
      }
    }
  }

  const seen = { decrypt: 0, checking: 0, plain: 0, red: 0 };
  let notes = 0;
  for (const hasEncrypted of [true, false]) {
    for (const [id, time] of ids) {
      for (const pin of pins) {
        for (const n of natives) {
          const atOrBelowB = time !== null && time <= T0 + 3000;
          let want: RowPolicyResult;
          if (hasEncrypted) {
            const belowBoundary =
              n !== null && n.verified && n.boundary === B && atOrBelowB;
            want = { kind: "decrypt", belowBoundary };
            if (belowBoundary) notes++;
          } else if (n === null || !n.verified) {
            want = { kind: "checking" };
          } else if (
            atOrBelowB &&
            n.boundary === B &&
            n.preHistory === "kept" &&
            (pin === null || (!pin.wiped && pin.boundary === B)) &&
            n.timeLimit !== null &&
            time <= n.timeLimit
          ) {
            want = { kind: "plain" };
          } else {
            want = { kind: "red" };
          }

          const input = { hasEncrypted, id, pin, native: n };
          assert.deepEqual(rowPolicy(input), want, JSON.stringify(input));
          seen[want.kind]++;
        }
      }
    }
  }

  // 2 x 5 ids x 5 pins x 73 native states, every arm reached
  assert.equal(natives.length, 73);
  assert.deepEqual(seen, { decrypt: 1825, checking: 925, plain: 14, red: 886 });
  assert.equal(notes, 3 * 5 * 12);
});

test("RowPolicyResult kinds are exhaustive", () => {
  const kinds = ["decrypt", "checking", "plain", "red"] as const;
  assert.deepEqual(kinds.map(arm), [1, 2, 3, 4]);
  assert.throws(() => arm("other" as never), /unhandled kind other/);
});

// ---------------------------------------------------------------------------
// nativeHistoryInput
// ---------------------------------------------------------------------------

/** A loaded state holding a verified list and the three history values. */
function state(over: Partial<TextChannelState> = {}): TextChannelState {
  return {
    channel_id: "C1",
    group_id: "G1",
    generation: 0,
    epoch: 7,
    state: "active",
    members: [],
    seat_list: {
      version: 3,
      signer_user_id: "U1",
      signer_device_id: "D1",
      seats: ["U1", "U2"],
      device_cap: 4,
      issued_at: LIMIT,
    },
    owner_pin: {
      channel_id: "C1",
      status: "pinned",
      owner_user_id: "U1",
      owner_device_id: "D1",
      owner_verified: true,
      source: "protect",
      pending_signer: null,
    },
    self_seated: true,
    roster_matches_list: true,
    update_due: false,
    update_required: false,
    verdict: "ok",
    history_boundary: B,
    pre_history: "kept",
    history_time_limit: LIMIT,
    ...over,
  };
}

const CLEAN = { seatListError: null };

test("nativeHistoryInput: null while the state is not loaded", () => {
  assert.equal(nativeHistoryInput(null, CLEAN), null);
  assert.equal(nativeHistoryInput(null, { seatListError: "unknown" }), null);
  const missing = undefined as unknown as null;
  assert.equal(nativeHistoryInput(missing, CLEAN), null);
});

test("nativeHistoryInput: a loaded, listed, clean state is verified", () => {
  assert.deepEqual(nativeHistoryInput(state(), CLEAN), {
    verified: true,
    boundary: B,
    preHistory: "kept",
    timeLimit: LIMIT,
  });
  // every verdict but owner_changed keeps the held list
  const keeps = ["ok", "no_group", "joining", "not_seated"] as const;
  for (const verdict of [...keeps, "roster_mismatch", "poisoned"] as const) {
    const got = nativeHistoryInput(state({ verdict }), CLEAN);
    assert.equal(got?.verified, true, verdict);
  }
});

test("nativeHistoryInput: without a list it is not verified", () => {
  const got = nativeHistoryInput(state({ seat_list: null }), CLEAN);
  assert.equal(got?.verified, false);
  const absent = state();
  delete (absent as Partial<TextChannelState>).seat_list;
  assert.equal(nativeHistoryInput(absent, CLEAN)?.verified, false);
});

test("nativeHistoryInput: owner_changed is not verified", () => {
  const got = nativeHistoryInput(state({ verdict: "owner_changed" }), CLEAN);
  assert.equal(got?.verified, false);
});

test("nativeHistoryInput: an unknown verdict is not verified", () => {
  for (const verdict of ["brand_new", "toString", "", undefined]) {
    const s = state({ verdict: verdict as unknown as "ok" });
    assert.equal(nativeHistoryInput(s, CLEAN)?.verified, false, verdict);
  }
});

test("nativeHistoryInput: a seat list error is not verified", () => {
  for (const seatListError of ["seat_list_invalid", "unknown", ""]) {
    const got = nativeHistoryInput(state(), { seatListError });
    assert.equal(got?.verified, false, seatListError);
  }
  const missing = { seatListError: undefined as unknown as null };
  assert.equal(nativeHistoryInput(state(), missing)?.verified, false);
});

test("nativeHistoryInput: absent or odd history values are null", () => {
  const bare = state();
  delete bare.history_boundary;
  delete bare.pre_history;
  delete bare.history_time_limit;
  assert.deepEqual(nativeHistoryInput(bare, CLEAN), {
    verified: true,
    boundary: null,
    preHistory: null,
    timeLimit: null,
  });

  const odd = state({
    history_boundary: 5 as unknown as string,
    pre_history: "gone" as unknown as "kept",
    history_time_limit: "5" as unknown as number,
  });
  assert.deepEqual(nativeHistoryInput(odd, CLEAN), {
    verified: true,
    boundary: null,
    preHistory: null,
    timeLimit: null,
  });

  const wiped = nativeHistoryInput(state({ pre_history: "wiped" }), CLEAN);
  assert.equal(wiped?.preHistory, "wiped");
});

test("nativeHistoryInput feeds rowPolicy: the production call chain", () => {
  // what the caller does per row: view.native + view.seatListError in,
  // the stoat.js pin record beside it
  const decide = (
    n: TextChannelState | null,
    seatListError: string | null,
    over: Partial<RowPolicyInput> = {},
  ) =>
    rowPolicy({
      hasEncrypted: false,
      id: BELOW,
      pin: { boundary: B, wiped: false },
      native: nativeHistoryInput(n, { seatListError }),
      ...over,
    });

  assert.deepEqual(decide(state(), null), PLAIN);
  assert.deepEqual(decide(state(), null, { id: ABOVE }), RED);
  assert.deepEqual(decide(null, null), CHECKING);
  assert.deepEqual(decide(state({ seat_list: null }), null), CHECKING);
  assert.deepEqual(decide(state({ verdict: "owner_changed" }), null), CHECKING);
  assert.deepEqual(decide(state(), "seat_list_rollback"), CHECKING);
  assert.deepEqual(decide(state({ pre_history: "wiped" }), null), RED);

  // a channel protected before S4 holds no history values: all red
  const s1 = state();
  delete s1.history_boundary;
  delete s1.pre_history;
  delete s1.history_time_limit;
  assert.deepEqual(decide(s1, null, { pin: null }), RED);

  assert.deepEqual(decide(state(), "unknown", { hasEncrypted: true }), {
    kind: "decrypt",
    belowBoundary: false,
  });
  assert.deepEqual(decide(state(), null, { hasEncrypted: true }), {
    kind: "decrypt",
    belowBoundary: true,
  });
});

// ---------------------------------------------------------------------------
// dividerAfter
// ---------------------------------------------------------------------------

test("dividerAfter: rows on both sides give the newest one below", () => {
  assert.equal(dividerAfter([BELOW, MID, ABOVE], B), MID);
  assert.equal(dividerAfter([BELOW, MID, OTHER_B, ABOVE], B), MID);
  assert.equal(dividerAfter([BELOW, ABOVE], B), BELOW);
});

test("dividerAfter: the boundary row itself is the one", () => {
  assert.equal(dividerAfter([BELOW, MID, B, ABOVE], B), B);
  assert.equal(dividerAfter([B], B), B);
});

test("dividerAfter: no row at or below the boundary is null", () => {
  assert.equal(dividerAfter([OTHER_B, ABOVE], B), null);
  assert.equal(dividerAfter([], B), null);
});

test("dividerAfter: no row above the boundary gives the newest row", () => {
  assert.equal(dividerAfter([BELOW, MID], B), MID);
  assert.equal(dividerAfter([BELOW], B), BELOW);
});

test("dividerAfter: malformed ids and boundaries never place it", () => {
  // strings that would sort below B as plain text
  const junk = ["", "0", " ".repeat(26), BELOW.toLowerCase()];
  assert.equal(dividerAfter(junk, B), null);
  assert.equal(dividerAfter([BELOW, ...junk, ABOVE], B), BELOW);
  for (const boundary of ["", "ZZZZ", B.toLowerCase(), "~".repeat(26)]) {
    assert.equal(dividerAfter([BELOW, MID], boundary), null, boundary);
  }
  // the answer does not lean on the order it was given
  assert.equal(dividerAfter([ABOVE, MID, BELOW], B), MID);
});

// ---------------------------------------------------------------------------
// ulidTimeMs
// ---------------------------------------------------------------------------

const ULID_CASES: [string, number | null][] = [
  ["00000000000000000000000000", 0],
  ["0000000001ZZZZZZZZZZZZZZZZ", 1],
  ["01ARZ3NDEKTSV4RRFFQ69G5FAV", 1469922850259],
  ["7ZZZZZZZZZZZZZZZZZZZZZZZZZ", 2 ** 48 - 1],
  // a time above 48 bits
  ["80000000000000000000000000", null],
  ["ZZZZZZZZZZZZZZZZZZZZZZZZZZ", null],
  // letters Crockford leaves out, lower case, other lengths
  ["01ARZ3NDEKTSV4RRFFQ69G5FAI", null],
  ["01ARZ3NDEKTSV4RRFFQ69G5FAL", null],
  ["01ARZ3NDEKTSV4RRFFQ69G5FAO", null],
  ["01ARZ3NDEKTSV4RRFFQ69G5FAU", null],
  ["01arz3ndektsv4rrffq69g5fav", null],
  ["01ARZ3NDEKTSV4RRFFQ69G5FA", null],
  ["01ARZ3NDEKTSV4RRFFQ69G5FAVV", null],
  ["", null],
];

test("ulidTimeMs: the time of a ULID, null for anything else", () => {
  for (const [id, want] of ULID_CASES) {
    assert.equal(ulidTimeMs(id), want, JSON.stringify(id));
  }
  for (const odd of [null, undefined, 5, {}, ["0".repeat(26)]]) {
    assert.equal(ulidTimeMs(odd as unknown as string), null);
  }
  assert.equal(ulidTimeMs(ulid(T0 + 1)), T0 + 1);
});

test("ulidTimeMs: the same answers as stoat.js", () => {
  const ids = ULID_CASES.map(([id]) => id);
  ids.push(BELOW, MID, B, ABOVE, OTHER_B, B.toLowerCase(), B + "0");
  for (const id of ids) {
    assert.equal(ulidTimeMs(id), sdkUlidTimeMs(id), JSON.stringify(id));
  }
});
