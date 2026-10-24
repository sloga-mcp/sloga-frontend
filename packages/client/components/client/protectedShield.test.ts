// Unit spec for the Protected channel shield (W4 lane A2) — run with Node's
// built-in runner:
//   node --test --conditions=browser components/client/protectedShield.test.ts
// Focus: design 9.1 precedence (every step incl. 6c/6d/6e and the 3b
// fail-closed catch-all), "green only from verdict ok", never green with an
// off-list or locally removed leaf, the D3 capable variants, the D14
// presentation, the D17 notice mapping (every tag + catch-all) and D11.
// The step 3 / 6e tag lists are pinned ALWAYS against the in-repo fixture
// `__fixtures__/protected/design-9-1-shield-lists.json`; an extra test checks
// that fixture against the design copy in `/home/mcp/w4-notes/w4_design.md`
// (override with `W4_NOTES_DIR`) and skips, loudly, when the copy is absent.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  type ProtectedAction,
  type ProtectedErrorOp,
  type ProtectedErrorUi,
  type ProtectedMarkerKind,
  type ProtectedShieldState,
  type ShieldInputs,
  computeShieldState,
  explainShield,
  PROTECTED_CLIENT_REASONS,
  PROTECTED_HIDDEN_ACTIONS,
  PROTECTED_KEPT_ACTIONS,
  PROTECTED_NOTICE_KINDS,
  PROTECTED_SERVER_ERROR_TYPES,
  PROTECTED_SHIELD_STATES,
  protectedActionsBlocked,
  protectedNoticeForError,
  SHIELD_BENIGN_GROUP_ERRORS,
  SHIELD_BENIGN_SEAT_LIST_ERRORS,
  SHIELD_FALL_THROUGH_GROUP_ERRORS,
  SHIELD_LOUD_GROUP_ERRORS,
  SHIELD_LOUD_SEAT_LIST_ERRORS,
  shieldInputsFromView,
  shieldPresentation,
} from "./protectedShield.ts";
import type {
  ProtectedChannelView,
  ProtectedTextGroupResponse,
  TextChannelState,
  TextMember,
  TextVerdict,
} from "./protectedTextTypes.ts";
import {
  NATIVE_ERROR_TAGS,
  TEXT_NATIVE_ERROR_TAGS,
} from "./protectedTextTypes.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOTES = process.env.W4_NOTES_DIR ?? "/home/mcp/w4-notes";
const DESIGN = join(NOTES, "w4_design.md");
const designSkip = (): string | false =>
  existsSync(DESIGN) ? false : `design copy not found at ${DESIGN}`;

/** Design 9.1 step 3 / 6e rows, copied in-repo (always present). */
const SHIELD_LISTS = JSON.parse(
  readFileSync(
    new URL(
      "./__fixtures__/protected/design-9-1-shield-lists.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  step3_seat_list_errors: string[];
  step3_group_errors: string[];
  step6e_group_errors: string[];
};

const GROUP = "G0";

function member(over: Partial<TextMember> = {}): TextMember {
  return {
    user_id: "U1",
    device_id: "D1",
    user_verified: true,
    on_signed_list: true,
    removed_locally: false,
    ...over,
  };
}

/** A native state whose verdict is `ok` and self-consistent. */
function nativeOk(over: Partial<TextChannelState> = {}): TextChannelState {
  return {
    channel_id: "C1",
    group_id: GROUP,
    generation: 0,
    epoch: 7,
    state: "active",
    members: [member(), member({ user_id: "U2", device_id: "D2" })],
    seat_list: {
      version: 3,
      signer_user_id: "U1",
      signer_device_id: "D1",
      seats: ["U1", "U2"],
      device_cap: 4,
      issued_at: 1,
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
    ...over,
  };
}

function serverGroup(
  over: Partial<ProtectedTextGroupResponse> = {},
): ProtectedTextGroupResponse {
  return {
    group_id: GROUP,
    channel_id: "C1",
    generation: 0,
    current_epoch: 7,
    members: [],
    pending_removals: [],
    member_added: [],
    ...over,
  };
}

/** Inputs that yield `protected` (step 8). */
function green(over: Partial<ShieldInputs> = {}): ShieldInputs {
  return {
    serverProtected: true,
    locallyPinned: true,
    capable: true,
    seatListError: null,
    groupError: null,
    native: nativeOk(),
    serverGroup: serverGroup(),
    rosterMismatchAgeMs: 0,
    signerLeafMissingRetries: 0,
    welcomeRetriesExhausted: false,
    ...over,
  };
}

const withVerdict = (
  v: TextVerdict | string,
  over: Partial<ShieldInputs> = {},
) => green({ native: nativeOk({ verdict: v as TextVerdict }), ...over });

const VERDICTS: TextVerdict[] = [
  "ok",
  "no_group",
  "joining",
  "not_seated",
  "no_seat_list",
  "roster_mismatch",
  "owner_changed",
  "poisoned",
];

function expectShield(
  i: ShieldInputs,
  state: ProtectedShieldState,
  step: string,
  msg?: string,
) {
  const got = explainShield(i);
  assert.ok(got, msg ?? "expected a shield");
  assert.equal(got.state, state, msg);
  assert.equal(got.step, step, msg);
}

// ---------------------------------------------------------------------------
// Design 9.1 precedence
// ---------------------------------------------------------------------------

test("baseline: verdict ok + consistent native + capable is protected (step 8)", () => {
  expectShield(green(), "protected", "8");
  expectShield(green({ locallyPinned: false }), "protected", "8");
  expectShield(green({ serverGroup: null }), "protected", "8");
});

test("no shield for a channel that is neither server-protected nor pinned", () => {
  assert.equal(
    explainShield(green({ serverProtected: false, locallyPinned: false })),
    null,
  );
  assert.equal(
    computeShieldState(green({ serverProtected: false, locallyPinned: false })),
    null,
  );
});

test("step 1: pinned but not server-protected is unverified, before everything", () => {
  expectShield(green({ serverProtected: false }), "unverified", "1");
  // beats step 2 (not capable) and step 3 / 4 / 8
  expectShield(
    green({ serverProtected: false, capable: false }),
    "unverified",
    "1",
  );
  expectShield(
    green({ serverProtected: false, native: null }),
    "unverified",
    "1",
  );
  assert.equal(
    explainShield(green({ serverProtected: false }))?.notice,
    "flag_stripped",
  );
});

test("step 2 + D3 capable variants: anything but capable === true is not_available", () => {
  for (const capable of [false, undefined, null, 1, "true"]) {
    expectShield(
      green({ capable: capable as unknown as boolean }),
      "not_available",
      "2",
      `capable=${String(capable)}`,
    );
  }
  // beats step 3 (loud errors) and step 4 (loading)
  expectShield(
    green({ capable: false, seatListError: "bad_sig" }),
    "not_available",
    "2",
  );
  expectShield(green({ capable: false, native: null }), "not_available", "2");
  // a server-protected channel on web/Electron/Android/iOS (not pinned)
  expectShield(
    green({ capable: false, locallyPinned: false }),
    "not_available",
    "2",
  );
  // notice: a Tauri device with E2EE merely off gets enable_e2ee (D3)
  assert.equal(
    explainShield(green({ capable: false }))?.notice,
    "not_available",
  );
  assert.equal(
    explainShield(green({ capable: false, tauriE2eeOff: true }))?.notice,
    "enable_e2ee",
  );
  // the hint never changes the state of a capable device
  expectShield(green({ tauriE2eeOff: true }), "protected", "8");
});

test("step 3: every loud seat-list error is unverified, even over verdict ok / loading", () => {
  for (const tag of SHIELD_LOUD_SEAT_LIST_ERRORS) {
    expectShield(green({ seatListError: tag }), "unverified", "3", tag);
    expectShield(
      green({ seatListError: tag, native: null }),
      "unverified",
      "3",
      `${tag} loading`,
    );
  }
});

test("step 3: every loud group error is unverified, even over verdict ok / loading", () => {
  for (const tag of SHIELD_LOUD_GROUP_ERRORS) {
    expectShield(green({ groupError: tag }), "unverified", "3", tag);
    expectShield(
      green({ groupError: tag, native: null }),
      "unverified",
      "3",
      `${tag} loading`,
    );
  }
});

test("step 3: native verdict owner_changed is unverified, before step 5-7", () => {
  expectShield(withVerdict("owner_changed"), "unverified", "3");
  expectShield(
    withVerdict("owner_changed", {
      serverGroup: serverGroup({
        pending_removals: [{ user_id: "U9", created_at: "x" }],
      }),
    }),
    "unverified",
    "3",
  );
});

test("step 3 notices name the cause", () => {
  const n = (i: ShieldInputs) => explainShield(i)?.notice;
  assert.equal(
    n(green({ seatListError: "seat_list_rollback" })),
    "seat_list_failed",
  );
  assert.equal(
    n(green({ groupError: "seat_list_invalid" })),
    "seat_list_failed",
  );
  assert.equal(
    n(green({ groupError: "channel_mismatch" })),
    "security_check_failed",
  );
  assert.equal(
    n(green({ groupError: "wrong_group_kind" })),
    "security_check_failed",
  );
  assert.equal(
    n(green({ groupError: "replayed_rejoin_intent" })),
    "replayed_change",
  );
  assert.equal(n(green({ groupError: "duplicate_leaf" })), "invalid_change");
  const pending = (same_user: boolean) =>
    nativeOk({
      verdict: "owner_changed",
      owner_pin: {
        ...nativeOk().owner_pin,
        status: "changed",
        pending_signer: {
          user_id: "U1",
          device_id: "D7",
          same_user,
          verified: false,
        },
      },
    });
  assert.equal(n(green({ native: pending(true) })), "owner_changed_review");
  assert.equal(n(green({ native: pending(false) })), "owner_changed_locked");
  assert.equal(
    n(green({ seatListError: "owner_changed", ownerChangePending: true })),
    "owner_changed_review",
  );
  // owner change with nothing telling which kind: generic, never "locked"
  assert.equal(n(green({ seatListError: "owner_changed" })), "unverified");
});

test("step 3b: any other error tag (incl. untyped 'unknown') fails closed", () => {
  for (const tag of [
    "unknown",
    "busy",
    "storage",
    "crypto_failure",
    "identity_pin_required",
  ] as const) {
    expectShield(green({ groupError: tag }), "unverified", "3b", tag);
  }
  // D24: ChannelMismatch from `_seat_list_verify` is unverified
  expectShield(
    green({ seatListError: "channel_mismatch" }),
    "unverified",
    "3b",
  );
  expectShield(green({ seatListError: "unknown" }), "unverified", "3b");
});

test("every native tag as groupError / seatListError lands in exactly one class", () => {
  for (const tag of NATIVE_ERROR_TAGS) {
    const g = explainShield(green({ groupError: tag }));
    assert.ok(g);
    if ((SHIELD_LOUD_GROUP_ERRORS as readonly string[]).includes(tag)) {
      assert.deepEqual([g.state, g.step], ["unverified", "3"], tag);
    } else if (
      (SHIELD_BENIGN_GROUP_ERRORS as readonly string[]).includes(tag)
    ) {
      // native verdict ok stays authoritative
      assert.deepEqual([g.state, g.step], ["protected", "8"], tag);
    } else {
      assert.deepEqual([g.state, g.step], ["unverified", "3b"], tag);
    }
    const s = explainShield(green({ seatListError: tag }));
    assert.ok(s);
    if ((SHIELD_LOUD_SEAT_LIST_ERRORS as readonly string[]).includes(tag)) {
      assert.deepEqual([s.state, s.step], ["unverified", "3"], tag);
    } else if (
      (SHIELD_BENIGN_SEAT_LIST_ERRORS as readonly string[]).includes(tag)
    ) {
      assert.deepEqual([s.state, s.step], ["protected", "8"], tag);
    } else {
      assert.deepEqual([s.state, s.step], ["unverified", "3b"], tag);
    }
  }
  for (const tag of SHIELD_LOUD_GROUP_ERRORS) {
    assert.ok(
      !(SHIELD_BENIGN_GROUP_ERRORS as readonly string[]).includes(tag),
      tag,
    );
  }
});

test("step 4: native null (loading) is resecuring", () => {
  expectShield(green({ native: null }), "resecuring", "4");
  expectShield(
    green({ native: undefined as unknown as null }),
    "resecuring",
    "4",
  );
});

test("step 5: verdict not_seated wins over 6, 6c, 6d and 7", () => {
  expectShield(withVerdict("not_seated"), "not_seated", "5");
  expectShield(
    withVerdict("not_seated", {
      signerLeafMissingRetries: 9,
      welcomeRetriesExhausted: true,
      serverGroup: serverGroup({
        pending_removals: [{ user_id: "U9", created_at: "x" }],
      }),
    }),
    "not_seated",
    "5",
  );
  // RC NEW-7: a never-seated viewer with no local group, after D26's verify
  expectShield(
    green({
      native: nativeOk({
        verdict: "not_seated",
        group_id: null,
        epoch: null,
        state: "none",
        members: [],
      }),
      serverGroup: null,
    }),
    "not_seated",
    "5",
  );
});

test("step 6: roster_mismatch is resecuring under 60 s, unverified from 60 s", () => {
  expectShield(withVerdict("roster_mismatch"), "resecuring", "6");
  expectShield(
    withVerdict("roster_mismatch", { rosterMismatchAgeMs: 59_999 }),
    "resecuring",
    "6",
  );
  expectShield(
    withVerdict("roster_mismatch", { rosterMismatchAgeMs: 60_000 }),
    "unverified",
    "6",
  );
  expectShield(
    withVerdict("roster_mismatch", { rosterMismatchAgeMs: Number.NaN }),
    "unverified",
    "6",
  );
  expectShield(
    withVerdict("roster_mismatch", { rosterMismatchAgeMs: -5 }),
    "resecuring",
    "6",
  );
  assert.equal(
    explainShield(
      withVerdict("roster_mismatch", { rosterMismatchAgeMs: 60_000 }),
    )?.notice,
    "off_list_member",
  );
  // step 6 precedes 6c
  expectShield(
    withVerdict("roster_mismatch", { signerLeafMissingRetries: 3 }),
    "resecuring",
    "6",
  );
});

test("step 6c: SignerLeafMissing budget exhausted is unverified, before step 7", () => {
  expectShield(
    withVerdict("joining", { signerLeafMissingRetries: 3 }),
    "unverified",
    "6c",
  );
  expectShield(
    withVerdict("joining", { signerLeafMissingRetries: 4 }),
    "unverified",
    "6c",
  );
  expectShield(
    withVerdict("joining", { signerLeafMissingRetries: Number.NaN }),
    "unverified",
    "6c",
  );
  // fewer retries fall through to step 7
  expectShield(
    withVerdict("joining", { signerLeafMissingRetries: 2 }),
    "resecuring",
    "7",
  );
  expectShield(
    withVerdict("joining", {
      signerLeafMissingRetries: 2,
      groupError: "signer_leaf_missing",
    }),
    "resecuring",
    "7",
  );
});

test("step 6d: welcome retries exhausted is unverified, before step 7", () => {
  expectShield(
    withVerdict("joining", { welcomeRetriesExhausted: true }),
    "unverified",
    "6d",
  );
  expectShield(
    withVerdict("no_group", { welcomeRetriesExhausted: true }),
    "unverified",
    "6d",
  );
  assert.equal(
    explainShield(withVerdict("joining", { welcomeRetriesExhausted: true }))
      ?.notice,
    "join_stalled",
  );
});

test("step 6e: own_commit_mismatch / already_member / unexpected_mls_content never unverified by themselves", () => {
  for (const tag of SHIELD_FALL_THROUGH_GROUP_ERRORS) {
    // own desync -> left -> verdict no_group -> resecuring
    expectShield(
      withVerdict("no_group", { groupError: tag }),
      "resecuring",
      "7",
      tag,
    );
    expectShield(
      withVerdict("joining", { groupError: tag }),
      "resecuring",
      "7",
      tag,
    );
    expectShield(green({ groupError: tag }), "protected", "8", tag);
    expectShield(
      green({ groupError: tag, native: null }),
      "resecuring",
      "4",
      tag,
    );
  }
});

test("step 7: each resecuring verdict and each server term", () => {
  for (const v of [
    "no_group",
    "joining",
    "poisoned",
    "no_seat_list",
  ] as const) {
    expectShield(withVerdict(v), "resecuring", "7", v);
  }
  const pending = serverGroup({
    pending_removals: [{ user_id: "U2", created_at: "t" }],
  });
  expectShield(green({ serverGroup: pending }), "resecuring", "7");
  expectShield(
    green({ serverGroup: serverGroup({ current_epoch: 8 }) }),
    "resecuring",
    "7",
  );
  expectShield(
    green({ serverGroup: serverGroup({ group_id: "G1" }) }),
    "resecuring",
    "7",
  );
  expectShield(
    green({ serverGroup: serverGroup({ current_epoch: Number.NaN }) }),
    "resecuring",
    "7",
  );
  expectShield(
    green({
      serverGroup: {
        ...serverGroup(),
        pending_removals: undefined as unknown as [],
      },
    }),
    "resecuring",
    "7",
  );
  // native ahead of a stale server snapshot is fine
  expectShield(
    green({ serverGroup: serverGroup({ current_epoch: 6 }) }),
    "protected",
    "8",
  );
});

test("step 9: an unknown verdict fails closed", () => {
  expectShield(withVerdict("seat_list_behind"), "unverified", "9");
  expectShield(withVerdict(""), "unverified", "9");
});

test("never green with an off-list or locally removed leaf, even if native says ok", () => {
  const bad: Partial<TextChannelState>[] = [
    { members: [member(), member({ user_id: "U3", on_signed_list: false })] },
    { members: [member(), member({ user_id: "U2", removed_locally: true })] },
    { roster_matches_list: false },
    { self_seated: false },
    { state: "joining" },
    { owner_pin: { ...nativeOk().owner_pin, status: "changed" } },
    { members: undefined as unknown as TextMember[] },
  ];
  for (const over of bad) {
    const s = explainShield(green({ native: nativeOk(over) }));
    assert.ok(s);
    assert.notEqual(s.state, "protected", JSON.stringify(over));
    assert.deepEqual(
      [s.state, s.step],
      ["unverified", "9"],
      JSON.stringify(over),
    );
  }
  // the honest native shape for an off-list leaf is verdict roster_mismatch
  const offList = nativeOk({
    verdict: "roster_mismatch",
    roster_matches_list: false,
    members: [member(), member({ user_id: "U3", on_signed_list: false })],
  });
  for (const age of [0, 59_999, 60_000, 10 ** 9]) {
    assert.notEqual(
      computeShieldState(green({ native: offList, rosterMismatchAgeMs: age })),
      "protected",
    );
  }
});

test("green only from verdict ok: exhaustive sweep", () => {
  const errs = [
    null,
    "unknown",
    "already_member",
    "bad_sig",
    "mls_epoch_gap",
    "own_commit_mismatch",
  ] as const;
  const groups = [null, serverGroup(), serverGroup({ current_epoch: 9 })];
  let greens = 0;
  let total = 0;
  for (const verdict of [...VERDICTS, "bogus"]) {
    for (const sp of [false, true]) {
      for (const lp of [false, true]) {
        for (const capable of [false, true]) {
          for (const ge of errs) {
            for (const se of errs) {
              for (const g of groups) {
                for (const age of [0, 60_000]) {
                  for (const retries of [0, 3]) {
                    for (const exhausted of [false, true]) {
                      const i = green({
                        serverProtected: sp,
                        locallyPinned: lp,
                        capable,
                        groupError: ge,
                        seatListError: se,
                        serverGroup: g,
                        rosterMismatchAgeMs: age,
                        signerLeafMissingRetries: retries,
                        welcomeRetriesExhausted: exhausted,
                        native: nativeOk({ verdict: verdict as TextVerdict }),
                      });
                      const e = explainShield(i);
                      total++;
                      if (e?.state === "protected") {
                        greens++;
                        assert.equal(e.step, "8");
                        assert.equal(verdict, "ok");
                        assert.equal(sp, true);
                        assert.equal(capable, true);
                        assert.equal(retries, 0);
                        assert.equal(exhausted, false);
                      }
                      // never produced in S1
                      assert.ok(e?.state !== "grace" && e?.state !== "frozen");
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(greens > 0 && greens < total, `${greens}/${total}`);
});

test("step 3 and 6e tag lists match the pinned design rows (9.1)", () => {
  const sortedCopy = (xs: readonly string[]) => [...xs].sort();
  assert.deepEqual(
    sortedCopy(SHIELD_LOUD_SEAT_LIST_ERRORS),
    sortedCopy(SHIELD_LISTS.step3_seat_list_errors),
  );
  assert.deepEqual(
    sortedCopy(SHIELD_LOUD_GROUP_ERRORS),
    sortedCopy(SHIELD_LISTS.step3_group_errors),
  );
  assert.deepEqual(
    sortedCopy(SHIELD_FALL_THROUGH_GROUP_ERRORS),
    sortedCopy(SHIELD_LISTS.step6e_group_errors),
  );
});

test(
  "the shield-list fixture matches the design copy (9.1)",
  { skip: designSkip() },
  () => {
    const d = readFileSync(DESIGN, "utf8");
    const sec = d.slice(
      d.indexOf("### 9.1 Shield state"),
      d.indexOf("### 9.2"),
    );
    const names = (s: string) =>
      [...s.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    const step3 = sec.slice(sec.indexOf("\n3. "), sec.indexOf("\n4. "));
    const seat = /`seatListError` in \{([^}]*)\}/.exec(step3);
    const group = /`groupError` in \{([^}]*)\}/.exec(step3);
    assert.ok(seat && group, "step 3 lists not found");
    assert.deepEqual(names(seat[1]), SHIELD_LISTS.step3_seat_list_errors);
    assert.deepEqual(names(group[1]), SHIELD_LISTS.step3_group_errors);
    const s6e = sec.slice(sec.indexOf("\n6e. "), sec.indexOf("\n7. "));
    const fall = /`groupError` in \{([^}]*)\}/.exec(s6e);
    assert.ok(fall, "6e list not found");
    assert.deepEqual(names(fall[1]), SHIELD_LISTS.step6e_group_errors);
  },
);

test("shieldInputsFromView: loading view, roster age, backwards clock", () => {
  const flags = { serverProtected: true, locallyPinned: false, capable: true };
  assert.equal(
    computeShieldState(shieldInputsFromView(null, flags, 1000)),
    "resecuring",
  );
  const view: ProtectedChannelView = {
    channelId: "C1",
    seatListError: null,
    groupError: null,
    native: nativeOk({ verdict: "roster_mismatch" }),
    serverGroup: serverGroup(),
    seats: null,
    rosterMismatchSinceMs: 1_000,
    signerLeafMissingRetries: 0,
    welcomeRetriesExhausted: false,
    ownerChangePending: false,
    recreateAvailable: false,
    publishInFlight: false,
    maybeUnsent: false,
  };
  assert.equal(
    shieldInputsFromView(view, flags, 61_000).rosterMismatchAgeMs,
    60_000,
  );
  assert.equal(
    computeShieldState(shieldInputsFromView(view, flags, 61_000)),
    "unverified",
  );
  assert.equal(
    computeShieldState(shieldInputsFromView(view, flags, 60_999)),
    "resecuring",
  );
  assert.equal(shieldInputsFromView(view, flags, 0).rosterMismatchAgeMs, 0);
  assert.equal(
    computeShieldState(
      shieldInputsFromView({ ...view, native: nativeOk() }, flags, 5),
    ),
    "protected",
  );
  assert.equal(
    explainShield(
      shieldInputsFromView(
        null,
        { ...flags, capable: false, tauriE2eeOff: true },
        0,
      ),
    )?.notice,
    "enable_e2ee",
  );
});

// ---------------------------------------------------------------------------
// Presentation (D14)
// ---------------------------------------------------------------------------

test("shieldPresentation: D14 glyphs, hues, tint, composer per state", () => {
  const want: Record<ProtectedShieldState, [string, string, boolean, string]> =
    {
      protected: ["verified_user", "--sloga-protected-ok", true, "enabled"],
      resecuring: ["shield", "--sloga-protected-resecuring", false, "disabled"],
      not_seated: ["shield", "--sloga-protected-unavailable", false, "hidden"],
      not_available: [
        "remove_moderator",
        "--sloga-protected-unavailable",
        true,
        "hidden",
      ],
      unverified: ["gpp_bad", "--sloga-protected-alert", true, "hidden"],
      grace: ["verified_user", "--sloga-protected-grace", false, "hidden"],
      frozen: ["shield", "--sloga-protected-frozen", false, "hidden"],
    };
  assert.deepEqual(
    Object.keys(want).sort(),
    [...PROTECTED_SHIELD_STATES].sort(),
  );
  for (const s of PROTECTED_SHIELD_STATES) {
    const p = shieldPresentation(s);
    assert.deepEqual([p.glyph, p.hueVar, p.tintName, p.composer], want[s], s);
    assert.equal(p.notice === null, s === "protected", s);
    if (p.notice !== null)
      assert.ok(PROTECTED_NOTICE_KINDS.includes(p.notice), s);
  }
  assert.equal(
    shieldPresentation("not_available", { tauriE2eeOff: true }).notice,
    "enable_e2ee",
  );
  assert.equal(
    shieldPresentation("unverified", { tauriE2eeOff: true }).notice,
    "unverified",
  );
  assert.throws(() => shieldPresentation("bogus" as ProtectedShieldState));
});

test("every explainShield notice is a declared notice kind and matches its state", () => {
  const samples: ShieldInputs[] = [
    green(),
    green({ serverProtected: false }),
    green({ capable: false }),
    green({ seatListError: "bad_sig" }),
    green({ groupError: "unknown" }),
    green({ native: null }),
    withVerdict("not_seated"),
    withVerdict("roster_mismatch", { rosterMismatchAgeMs: 60_000 }),
    withVerdict("joining", { signerLeafMissingRetries: 3 }),
    withVerdict("joining", { welcomeRetriesExhausted: true }),
    withVerdict("poisoned"),
    withVerdict("bogus"),
  ];
  for (const i of samples) {
    const e = explainShield(i);
    assert.ok(e);
    assert.equal(e.notice === null, e.state === "protected");
    if (e.notice !== null) assert.ok(PROTECTED_NOTICE_KINDS.includes(e.notice));
  }
});

test("exhaustiveness scan: shieldPresentation ends in `const _x: never = state`", () => {
  const src = readFileSync(
    new URL("./protectedShield.ts", import.meta.url),
    "utf8",
  );
  const fn = src.slice(src.indexOf("export function shieldPresentation("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /default: \{\s*const _x: never = state;/);
});

// ---------------------------------------------------------------------------
// D17 notice mapping
// ---------------------------------------------------------------------------

const OPS: ProtectedErrorOp[] = [
  "message",
  "channel",
  "send",
  "owner",
  "action",
  "transfer",
];
const MARKERS: ProtectedMarkerKind[] = [
  "sent_before_join",
  "unknown_key",
  "decrypt_failed",
  "unverified_sender",
  "removed_sender",
  "replay",
  "malformed",
  "unencrypted_row",
  "error",
];

function wellFormed(ui: ProtectedErrorUi, label: string) {
  assert.ok(typeof ui.tag === "string" && ui.tag.length > 0, `${label}: tag`);
  switch (ui.kind) {
    case "notice":
      assert.ok(
        PROTECTED_NOTICE_KINDS.includes(ui.notice),
        `${label}: ${ui.notice}`,
      );
      assert.ok(ui.max === null || Number.isSafeInteger(ui.max), label);
      break;
    case "marker":
      assert.ok(MARKERS.includes(ui.marker), `${label}: ${ui.marker}`);
      break;
    case "toast":
      assert.equal(ui.toast, "unsolicited_welcome", label);
      break;
    case "none":
      break;
    default: {
      const _x: never = ui;
      assert.fail(`${label}: ${JSON.stringify(_x)}`);
    }
  }
}

const native = (type: string, f: Record<string, unknown> = {}) => ({
  type,
  ...f,
});
const ui = (err: unknown, op: ProtectedErrorOp, catchUpDone?: boolean) =>
  protectedNoticeForError(err, { op, catchUpDone });
const brief = (u: ProtectedErrorUi) =>
  u.kind === "notice"
    ? u.notice
    : u.kind === "marker"
      ? `marker:${u.marker}`
      : u.kind === "toast"
        ? `toast:${u.toast}`
        : "none";

test("every text-plane native tag maps (each op), never via the catch-all", () => {
  for (const tag of TEXT_NATIVE_ERROR_TAGS) {
    for (const op of OPS) {
      const a = ui(native(tag), op);
      wellFormed(a, `${tag}/${op}`);
      assert.equal(a.tag, tag, `${tag}/${op}: matched by its own rule`);
      const b = ui({ source: "native", error: native(tag) }, op);
      assert.deepEqual(b, a, `${tag}/${op}: TextFlowFailure wrapper`);
    }
  }
});

test("D17 channel-level table (9.2)", () => {
  const want: Record<string, string> = {
    unknown_epoch: "resecuring",
    unknown_sender: "unverified",
    bad_sig: "seat_list_failed",
    not_seated: "not_seated",
    roster_mismatch: "invalid_change",
    signer_leaf_missing: "resecuring",
    commit_declaration_mismatch: "invalid_change",
    not_owner: "invalid_change",
    seat_list_rollback: "seat_list_failed",
    seat_list_equivocation: "seat_list_failed",
    seat_list_behind: "seat_list_behind",
    seat_list_invalid: "seat_list_failed",
    removed_sender: "unverified",
    replay: "unverified",
    channel_mismatch: "security_check_failed",
    already_member: "none",
    own_commit_mismatch: "resecuring",
    duplicate_leaf: "invalid_change",
    replayed_rejoin_intent: "replayed_change",
    unexpected_mls_content: "none",
    update_required: "none",
    text_group_full: "channel_full",
    malformed_text_payload: "unverified",
    wrong_group_kind: "security_check_failed",
    identity_pin_required: "unverified",
    handover_target_invalid: "unverified",
    mls_group_not_found: "resecuring",
    mls_unsolicited_welcome: "toast:unsolicited_welcome",
    mls_leaf_rejected: "invalid_change",
    mls_epoch_gap: "resecuring",
    mls_poisoned_epoch: "resecuring",
    declined: "none",
  };
  for (const tag of TEXT_NATIVE_ERROR_TAGS) {
    if (tag === "owner_changed") continue;
    assert.ok(tag in want, `table misses ${tag}`);
    assert.equal(brief(ui(native(tag), "channel")), want[tag], tag);
  }
  assert.equal(
    brief(ui(native("owner_changed", { same_user: true }), "channel")),
    "owner_changed_review",
  );
  assert.equal(
    brief(ui(native("owner_changed", { same_user: false }), "channel")),
    "owner_changed_locked",
  );
  assert.equal(brief(ui(native("owner_changed"), "channel")), "unverified");
});

test("D17 op-dependent rows", () => {
  assert.equal(brief(ui(native("roster_mismatch"), "send")), "resecuring");
  assert.equal(brief(ui(native("not_owner"), "owner")), "not_owner");
  assert.equal(brief(ui(native("update_required"), "send")), "resecuring");
  assert.equal(
    brief(
      ui(native("malformed_text_payload", { reason: "too_large" }), "send"),
    ),
    "send_refused",
  );
  const full = ui(native("text_group_full", { max: 100 }), "channel");
  assert.deepEqual(full, {
    kind: "notice",
    notice: "channel_full",
    max: 100,
    tag: "text_group_full",
  });
  for (const bad of [-1, 1.5, "100", null, Number.NaN]) {
    const u = ui(native("text_group_full", { max: bad }), "owner");
    assert.equal(u.kind === "notice" && u.max, null, String(bad));
  }
});

test("D17 message rows -> markers (9.2 / 9.3)", () => {
  const m = (err: unknown, catchUpDone?: boolean) =>
    brief(ui(err, "message", catchUpDone));
  const ue = (epoch: number, oldest_held: number | null, current: number) =>
    native("unknown_epoch", { group_id: GROUP, epoch, oldest_held, current });
  assert.equal(m(ue(2, 5, 9)), "marker:sent_before_join");
  assert.equal(m(ue(12, 5, 9)), "none"); // catch up and retry once
  assert.equal(m(ue(12, 5, 9), true), "marker:decrypt_failed");
  assert.equal(m(ue(7, 5, 9)), "marker:decrypt_failed");
  assert.equal(m(ue(7, null, 9)), "marker:decrypt_failed");
  assert.equal(
    m(native("unknown_epoch", { epoch: "2", oldest_held: 5, current: 9 })),
    "marker:decrypt_failed",
  );
  assert.equal(m(native("unknown_sender")), "marker:unverified_sender");
  assert.equal(m(native("bad_sig")), "marker:unverified_sender");
  assert.equal(m(native("removed_sender")), "marker:removed_sender");
  assert.equal(m(native("replay")), "marker:replay");
  assert.equal(m(native("malformed_text_payload")), "marker:malformed");
  assert.equal(m(native("mls_group_not_found")), "marker:unknown_key");
  for (const tag of TEXT_NATIVE_ERROR_TAGS) {
    const u = ui(native(tag), "message");
    if (tag === "unknown_epoch") continue;
    assert.equal(u.kind, "marker", tag);
  }
  // a server error or transport failure on a message row is the red marker
  assert.equal(m({ type: "NotSeated" }), "marker:error");
  assert.equal(m({ source: "transport" }), "marker:error");
});

test("D17 server types (7.6 + extras)", () => {
  const s = (
    type: string,
    body: Record<string, unknown> = {},
    op: ProtectedErrorOp = "send",
  ) => ui({ source: "server", status: 400, type, body: { type, ...body } }, op);
  assert.equal(
    brief(s("ProtectedChannelResecuring", { reason: "pending_removal" })),
    "resecuring",
  );
  assert.equal(brief(s("NotSeated")), "not_seated");
  assert.deepEqual(s("SeatCapReached", { max: 25 }, "owner"), {
    kind: "notice",
    notice: "seat_cap_reached",
    max: 25,
    tag: "SeatCapReached",
  });
  assert.equal(brief(s("ChannelProtected", {}, "action")), "channel_protected");
  assert.equal(
    brief(s("ChannelProtected", {}, "transfer")),
    "ownership_transfer_blocked",
  );
  assert.equal(
    brief(s("ProtectedFieldRefused", { field: "embeds" })),
    "send_refused",
  );
  const dev = s("DeviceCapReached", { max: 4 }, "owner");
  assert.equal(dev.kind === "notice" && dev.max, 4);
  assert.equal(brief(s("DuplicateNonce")), "maybe_unsent");
  assert.equal(
    brief(s("FeatureDisabled", { feature: "e2ee" })),
    "encryption_unavailable",
  );
  assert.equal(
    brief(s("FeatureDisabled", { feature: "protected_channels" }, "owner")),
    "protected_channels_unavailable",
  );
  assert.equal(brief(s("FeatureDisabled", { feature: "voice" })), "unverified");
  const full = s("MlsCallFull", { max: 100 }, "channel");
  assert.equal(
    full.kind === "notice" && `${full.notice}/${full.max}`,
    "channel_full/100",
  );
  for (const type of PROTECTED_SERVER_ERROR_TYPES) {
    for (const op of OPS) {
      const u = s(type, { feature: "e2ee", max: 1 }, op);
      wellFormed(u, `${type}/${op}`);
      assert.equal(u.tag, type, `${type}/${op}`);
    }
  }
  // bare body and a type only on the failure
  assert.equal(brief(ui({ type: "NotSeated" }, "send")), "not_seated");
  assert.equal(
    brief(
      ui(
        { source: "server", status: 403, type: "NotSeated", body: null },
        "send",
      ),
    ),
    "not_seated",
  );
  assert.equal(
    brief(
      ui(
        {
          source: "server",
          status: 403,
          type: null,
          body: { type: "NotSeated" },
        },
        "send",
      ),
    ),
    "not_seated",
  );
});

test("D17 catch-all: everything unmapped fails closed", () => {
  const unmapped: unknown[] = [
    undefined,
    null,
    "busy",
    42,
    [],
    new Error("boom"),
    {},
    { type: 7 },
    { type: "MissingPermission" },
    { type: "InvalidOperation" },
    { type: "__proto__" },
    { type: "toString" },
    { source: "native" },
    { source: "native", error: "busy" },
    { source: "native", error: { type: "Busy" } },
    { source: "server", status: 500, type: "InternalError", body: {} },
    { source: "client", reason: "whatever" },
    { source: "client", reason: "unverified" },
    { source: "martian" },
  ];
  // every native tag outside the text plane (busy, storage, mls_call_full, ...)
  for (const tag of NATIVE_ERROR_TAGS) {
    if (!(TEXT_NATIVE_ERROR_TAGS as readonly string[]).includes(tag))
      unmapped.push(native(tag));
  }
  assert.ok(unmapped.length > 19 + 30);
  for (const err of unmapped) {
    for (const op of OPS) {
      const u = ui(err, op);
      const label = `${JSON.stringify(err) ?? String(err)}/${op}`;
      wellFormed(u, label);
      if (op === "message")
        assert.deepEqual(
          u,
          { kind: "marker", marker: "error", tag: "unknown" },
          label,
        );
      else
        assert.deepEqual(
          u,
          { kind: "notice", notice: "unverified", max: null, tag: "unknown" },
          label,
        );
    }
  }
});

test("D17 transport and client failures", () => {
  assert.deepEqual(ui({ source: "transport" }, "send"), {
    kind: "notice",
    notice: "network_error",
    max: null,
    tag: "transport",
  });
  for (const reason of PROTECTED_CLIENT_REASONS) {
    assert.equal(brief(ui({ source: "client", reason }, "owner")), reason);
    assert.equal(
      brief(ui({ source: "client", reason }, "message")),
      "marker:error",
    );
  }
});

// ---------------------------------------------------------------------------
// D11
// ---------------------------------------------------------------------------

test("protectedActionsBlocked: D11 hide/keep lists", () => {
  for (const a of PROTECTED_HIDDEN_ACTIONS) {
    assert.equal(protectedActionsBlocked(true, a), true, a);
    assert.equal(protectedActionsBlocked(false, a), false, a);
  }
  for (const a of PROTECTED_KEPT_ACTIONS) {
    assert.equal(protectedActionsBlocked(true, a), false, a);
    assert.equal(protectedActionsBlocked(false, a), false, a);
  }
  for (const a of [
    "edit",
    "forward",
    "report",
    "attachments",
    "slash_commands",
    "timelock",
  ]) {
    assert.ok((PROTECTED_HIDDEN_ACTIONS as readonly string[]).includes(a), a);
  }
  // an untyped caller's unknown action is hidden on a protected channel
  assert.equal(
    protectedActionsBlocked(true, "launch_rocket" as ProtectedAction),
    true,
  );
  const both = PROTECTED_HIDDEN_ACTIONS.filter((a) =>
    (PROTECTED_KEPT_ACTIONS as readonly string[]).includes(a),
  );
  assert.deepEqual(both, []);
});
