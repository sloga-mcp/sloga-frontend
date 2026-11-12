// Unit spec for the Protected channel shield (W4 lane A2) — run with Node's
// built-in runner:
//   node --test --conditions=browser components/client/protectedShield.test.ts
// Focus: design 9.1 precedence (every step incl. 6c/6d/6e and the 3b
// fail-closed catch-all), "green only from verdict ok", never green with an
// off-list or locally removed leaf, the D3 capable variants (and, S7 D9,
// Electron / Android capable and `not_available` rows built from lane C4's
// real `structuralState` / `storeOwnerAllows`), the D14 presentation, the
// D17 notice mapping (every tag + catch-all) and D11.
// S2 (W4 lane L1s): step 3c client outdated, step 5b `capacity`, step 6d
// as `resecuring`, `seat_list_rollback` loud as a groupError, the grey
// `unsupported_version` marker and the S2 server types.
// S2 OR-10 (W4-3-0 lane F1): `ownerChangeUnlisted` swaps a same-user
// `owner_changed_review` for `owner_changed_unlisted`, withholds Review
// (`reviewOffered`) and never changes the state.
// The step 3 / 6e tag lists are pinned ALWAYS against the in-repo fixture
// `__fixtures__/protected/design-9-1-shield-lists.json` (plus the S2 additions
// below); an extra test checks that fixture against the design copy in
// `/home/mcp/w4-notes/w4_design.md` (override with `W4_NOTES_DIR`) and skips,
// loudly, when the copy is absent.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  type AndroidProbe,
  type FlagState,
  type StoreOwnerCheck,
  type StructuralInput,
  storeOwnerAllows,
  structuralState,
  TEXT_PROTOCOL,
} from "./protectedPlatform.ts";
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
  REMOVED_USERS_MAX,
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

/**
 * S2 additions to the design 9.1 step 3 `groupError` list. The S1 list in
 * 9.1 itself is unchanged at 74390c37; the S2 shield bullet (design :5067)
 * adds `seat_list_rollback` (the commit-AD pre-check, 3.12.3 "S2").
 */
const S2_STEP3_GROUP_ADDS = ["seat_list_rollback"];

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
    capacity: null,
    clientOutdated: null,
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

// ---------------------------------------------------------------------------
// S7 D9: Electron / Android rows. `capable` is built from lane C4's REAL
// `structuralState` / `storeOwnerAllows`, ANDed like `protectedTextCapable()`
// (protectedSeam.scan S5 pins those terms in e2ee.ts; the wiring scan W1
// runs them). The shield itself only ever sees the boolean.
// ---------------------------------------------------------------------------

const PROBE_OK: AndroidProbe = {
  state: "ok",
  value: { protocol: TEXT_PROTOCOL, listenerBridge: true },
};

/** A window's platform facts; the Tauri main window unless overridden. */
function shell(over: Partial<StructuralInput> = {}): StructuralInput {
  return {
    transport: "tauri",
    platform: "",
    electronProtocol: undefined,
    androidProbe: null,
    popout: false,
    overlay: false,
    flag: "unknown",
    ...over,
  };
}

const electron = (
  flag: FlagState = "on",
  over: Partial<StructuralInput> = {},
) =>
  shell({
    transport: "electron",
    electronProtocol: TEXT_PROTOCOL,
    flag,
    ...over,
  });

const android = (
  probe: AndroidProbe | null = PROBE_OK,
  flag: FlagState = "on",
  over: Partial<StructuralInput> = {},
) =>
  shell({
    transport: "capacitor",
    platform: "android",
    androidProbe: probe,
    flag,
    ...over,
  });

/** The bridge's live status terms of `protectedTextCapable()`. */
interface DeviceFacts {
  enabled: boolean;
  published: boolean;
  deviceId: string | null;
  userId: string | null;
  owner: StoreOwnerCheck;
  storeOwnedElsewhere: boolean;
  deviceOwnedElsewhere: boolean;
}

const DEVICE: DeviceFacts = {
  enabled: true,
  published: true,
  deviceId: "D1",
  userId: "U1",
  owner: { state: "known", owner: "U1" },
  storeOwnedElsewhere: false,
  deviceOwnedElsewhere: false,
};

/** D3 + S7 D9: `protectedTextCapable()` over C4's real functions. */
function capableOn(p: StructuralInput, d: Partial<DeviceFacts> = {}): boolean {
  const x = { ...DEVICE, ...d };
  const s = structuralState(p);
  return (
    s.structural &&
    !s.hold &&
    x.enabled &&
    !!x.deviceId &&
    !x.storeOwnedElsewhere &&
    !x.deviceOwnedElsewhere &&
    !!x.userId &&
    storeOwnerAllows(p.transport, x.owner, x.userId)
  );
}

/**
 * The S7 D9 notice split (the hook's `tauriE2eeOff`, its shell term now
 * `structuralShell()`, lane C5): a structural shell whose E2EE is merely
 * off or unpublished is told to turn it on.
 */
function e2eeOffOn(p: StructuralInput, d: Partial<DeviceFacts> = {}): boolean {
  const x = { ...DEVICE, ...d };
  return (
    structuralState(p).structural &&
    !capableOn(p, d) &&
    (!x.enabled || !x.published)
  );
}

function shieldOn(
  p: StructuralInput,
  d: Partial<DeviceFacts> = {},
  over: Partial<ShieldInputs> = {},
): ShieldInputs {
  return green({
    capable: capableOn(p, d),
    tauriE2eeOff: e2eeOffOn(p, d),
    ...over,
  });
}

test("S7 D9: a capable Electron / Android shell runs the full 9.1 ladder and can be green", () => {
  for (const [label, p] of [
    ["electron protocol 2, flag on", electron("on")],
    ["android probe ok, listener bridge, flag on", android(PROBE_OK, "on")],
  ] as const) {
    for (const owner of [
      { state: "known", owner: "U1" },
      { state: "known", owner: null }, // a fresh store
    ] as StoreOwnerCheck[]) {
      const why = `${label}, owner ${JSON.stringify(owner)}`;
      assert.equal(capableOn(p, { owner }), true, why);
      expectShield(shieldOn(p, { owner }), "protected", "8", why);
      // capable is only step 2: steps 3-9 still decide, as on Tauri
      expectShield(
        shieldOn(p, { owner }, { seatListError: "bad_sig" }),
        "unverified",
        "3",
        why,
      );
      expectShield(
        shieldOn(p, { owner }, { native: null }),
        "resecuring",
        "4",
        why,
      );
      expectShield(
        shieldOn(p, { owner }, { native: nativeOk({ verdict: "not_seated" }) }),
        "not_seated",
        "5",
        why,
      );
      assert.equal(explainShield(shieldOn(p, { owner }))?.notice, null);
    }
  }
  // Tauri keeps W4: the flag is not consulted, an unknown owner is capable.
  for (const flag of ["on", "off", "unknown"] as FlagState[]) {
    const t = shell({ flag });
    assert.equal(capableOn(t, { owner: { state: "unknown" } }), true, flag);
    expectShield(
      shieldOn(t, { owner: { state: "unknown" } }),
      "protected",
      "8",
    );
  }
});

test("S7 D9: every closed, held or foreign Electron / Android / iOS / web window is not_available", () => {
  const rows: [string, StructuralInput, Partial<DeviceFacts>?][] = [
    ["electron, no protocol", electron("on", { electronProtocol: undefined })],
    [
      "electron, protocol 1 (an S1 shell)",
      electron("on", { electronProtocol: 1 }),
    ],
    ["electron, protocol 0", electron("on", { electronProtocol: 0 })],
    ["electron, flag off", electron("off")],
    ["electron, flag unknown (hold)", electron("unknown")],
    [
      "electron, owner unknown (A8)",
      electron(),
      { owner: { state: "unknown" } },
    ],
    [
      "electron, foreign owner",
      electron(),
      { owner: { state: "known", owner: "U2" } },
    ],
    ["electron, no user", electron(), { userId: null }],
    ["electron, no device id", electron(), { deviceId: null }],
    ["electron, store latch", electron(), { storeOwnedElsewhere: true }],
    ["electron, device latch", electron(), { deviceOwnedElsewhere: true }],
    ["electron popout", electron("on", { popout: true })],
    ["electron overlay", electron("on", { overlay: true })],
    [
      "android, legacy bridge",
      android({
        state: "ok",
        value: { protocol: TEXT_PROTOCOL, listenerBridge: false },
      }),
    ],
    [
      "android, protocol 1 (an S1 shell)",
      android({ state: "ok", value: { protocol: 1, listenerBridge: true } }),
    ],
    ["android, probe pending (hold)", android({ state: "pending" })],
    ["android, probe failed", android({ state: "failed" })],
    ["android, no probe", android(null)],
    ["android, flag off", android(PROBE_OK, "off")],
    ["android, flag unknown (hold)", android(PROBE_OK, "unknown")],
    ["android, owner unknown (A8)", android(), { owner: { state: "unknown" } }],
    [
      "android, foreign owner",
      android(),
      { owner: { state: "known", owner: "U2" } },
    ],
    ["android, no user", android(), { userId: null }],
    ["android popout", android(PROBE_OK, "on", { popout: true })],
    ["android overlay", android(PROBE_OK, "on", { overlay: true })],
    ["ios", android(PROBE_OK, "on", { platform: "ios" })],
    ["web", shell({ transport: "web", flag: "on" })],
    ["tauri popout", shell({ popout: true })],
    [
      "tauri, foreign owner (W4 latch)",
      shell(),
      { owner: { state: "known", owner: "U2" } },
    ],
  ];
  for (const [label, p, d] of rows) {
    assert.equal(capableOn(p, d), false, label);
    expectShield(shieldOn(p, d), "not_available", "2", label);
    // E2EE is on in every row: the notice never says "turn it on".
    assert.equal(explainShield(shieldOn(p, d))?.notice, "not_available", label);
    // not_available beats loud errors and loading, as on Tauri
    expectShield(
      shieldOn(p, d, { seatListError: "bad_sig", native: null }),
      "not_available",
      "2",
      label,
    );
  }
});

test("S7 D9 notice split: a structural Electron / Android shell with E2EE off gets enable_e2ee", () => {
  const off = { enabled: false };
  for (const [label, p] of [
    ["electron", electron("on")],
    ["electron, flag unknown", electron("unknown")],
    ["android", android(PROBE_OK, "on")],
    ["android, probe pending", android({ state: "pending" })],
    ["tauri", shell()],
  ] as const) {
    expectShield(shieldOn(p, off), "not_available", "2", label);
    assert.equal(explainShield(shieldOn(p, off))?.notice, "enable_e2ee", label);
    assert.equal(
      shieldPresentation("not_available", {
        tauriE2eeOff: e2eeOffOn(p, off),
      }).notice,
      "enable_e2ee",
      label,
    );
  }
  // Enabled but not yet published is still capable (W4: `published` is a
  // notice term only), so it is never told to turn E2EE on.
  for (const p of [electron("on"), android(PROBE_OK, "on")]) {
    expectShield(shieldOn(p, { published: false }), "protected", "8");
  }
  // Not a text-plane shell: turning E2EE on would not help, so no such hint.
  for (const [label, p] of [
    ["electron, no protocol", electron("on", { electronProtocol: undefined })],
    ["electron, flag off", electron("off")],
    [
      "android, legacy bridge",
      android({
        state: "ok",
        value: { protocol: TEXT_PROTOCOL, listenerBridge: false },
      }),
    ],
    ["android, probe failed", android({ state: "failed" })],
    ["android, flag off", android(PROBE_OK, "off")],
    ["ios", android(PROBE_OK, "on", { platform: "ios" })],
    ["web", shell({ transport: "web", flag: "on" })],
    ["electron popout", electron("on", { popout: true })],
    ["android overlay", android(PROBE_OK, "on", { overlay: true })],
    ["tauri popout", shell({ popout: true })],
  ] as const) {
    expectShield(shieldOn(p, off), "not_available", "2", label);
    assert.equal(
      explainShield(shieldOn(p, off))?.notice,
      "not_available",
      label,
    );
  }
});

test("S7 D9: across the platform grid, green only on a decided, owned, main-window text shell", () => {
  const probes: (AndroidProbe | null)[] = [
    null,
    { state: "pending" },
    { state: "failed" },
    PROBE_OK,
    { state: "ok", value: { protocol: TEXT_PROTOCOL, listenerBridge: false } },
    { state: "ok", value: { protocol: 1, listenerBridge: true } },
  ];
  const owners: StoreOwnerCheck[] = [
    { state: "unknown" },
    { state: "known", owner: null },
    { state: "known", owner: "U1" },
    { state: "known", owner: "U2" },
  ];
  const greens = { tauri: 0, electron: 0, capacitor: 0, web: 0 };
  let rows = 0;
  for (const transport of ["tauri", "electron", "capacitor", "web"] as const)
    for (const platform of ["", "android", "ios"])
      for (const electronProtocol of [undefined, 1, 2])
        for (const androidProbe of probes)
          for (const flag of ["on", "off", "unknown"] as FlagState[])
            for (const [popout, overlay] of [
              [false, false],
              [true, false],
              [false, true],
            ])
              for (const owner of owners) {
                rows++;
                const p: StructuralInput = {
                  transport,
                  platform,
                  electronProtocol,
                  androidProbe,
                  popout,
                  overlay,
                  flag,
                };
                const s = structuralState(p);
                const got = computeShieldState(shieldOn(p, { owner }));
                if (got !== "protected") {
                  assert.equal(got, "not_available");
                  continue;
                }
                greens[transport]++;
                const why = JSON.stringify({ p, owner });
                assert.ok(!popout && !overlay, `main window only: ${why}`);
                assert.ok(s.structural && !s.hold, `decided: ${why}`);
                assert.notEqual(transport, "web", why);
                assert.notEqual(
                  owner.state === "known" && owner.owner,
                  "U2",
                  why,
                );
                if (transport === "electron") {
                  assert.equal(electronProtocol, TEXT_PROTOCOL, why);
                  assert.equal(flag, "on", why);
                  assert.equal(owner.state, "known", `A8: ${why}`);
                }
                if (transport === "capacitor") {
                  assert.equal(platform, "android", `never iOS: ${why}`);
                  assert.deepEqual(androidProbe, PROBE_OK, why);
                  assert.equal(flag, "on", why);
                  assert.equal(owner.state, "known", `A8: ${why}`);
                }
              }
  assert.equal(rows, 4 * 3 * 3 * probes.length * 3 * 3 * owners.length);
  // Not vacuous, and exactly the green rows C4 + D3 allow (C4 ignores the
  // facts of other shells, e.g. an Electron row's probe):
  // - tauri: main window, owner not foreign: 3 platforms x 3 protocols x
  //   6 probes x 3 flags x 3 owners;
  // - electron: protocol 2, flag on, owner null or self: 3 x 6 x 2;
  // - capacitor: android, probe ok + listener, flag on, owner null or self:
  //   3 protocols x 2.
  assert.deepEqual(greens, {
    tauri: 3 * 3 * 6 * 3 * 3,
    electron: 3 * 6 * 2,
    capacitor: 3 * 2,
    web: 0,
  });
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
  // S2 (design :5067): the commit-AD pre-check's rollback, as a groupError
  assert.equal(
    n(green({ groupError: "seat_list_rollback" })),
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
    } else if (tag === "seat_list_behind") {
      // D24: held state kept, never green
      assert.deepEqual([g.state, g.step], ["resecuring", "7"], tag);
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
    } else if (tag === "seat_list_behind") {
      assert.deepEqual([s.state, s.step], ["resecuring", "7"], tag);
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

test("D24: SeatListBehind keeps the held state at resecuring, never protected", () => {
  for (const key of ["seatListError", "groupError"] as const) {
    // over a native verdict ok
    expectShield(green({ [key]: "seat_list_behind" }), "resecuring", "7", key);
    assert.equal(
      explainShield(green({ [key]: "seat_list_behind" }))?.notice,
      "resecuring",
      key,
    );
    // earlier steps still win
    expectShield(
      withVerdict("not_seated", { [key]: "seat_list_behind" }),
      "not_seated",
      "5",
      key,
    );
    expectShield(
      withVerdict("roster_mismatch", {
        [key]: "seat_list_behind",
        rosterMismatchAgeMs: 60_000,
      }),
      "unverified",
      "6",
      key,
    );
    expectShield(
      green({ [key]: "seat_list_behind", native: null }),
      "resecuring",
      "4",
      key,
    );
  }
  // a loud error alongside still wins (step 3)
  expectShield(
    green({ seatListError: "seat_list_behind", groupError: "bad_sig" }),
    "unverified",
    "3",
  );
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

// S2 replaces S1's 6d red (design :5052-5056): a missing Welcome is
// silence, never a verified failure.
test("S2 step 6d: welcome retries exhausted is resecuring, waiting for a member, never unverified", () => {
  for (const v of [
    "joining",
    "no_group",
    "ok",
    "poisoned",
    "no_seat_list",
  ] as const) {
    expectShield(
      withVerdict(v, { welcomeRetriesExhausted: true }),
      "resecuring",
      "6d",
      v,
    );
    assert.equal(
      explainShield(withVerdict(v, { welcomeRetriesExhausted: true }))?.notice,
      "waiting_for_member",
      v,
    );
  }
  // never green with the budget spent, even over a consistent verdict ok
  assert.notEqual(
    computeShieldState(green({ welcomeRetriesExhausted: true })),
    "protected",
  );
  // a verified failure still wins: step 3, step 6 past 60 s, step 6c
  expectShield(
    green({ welcomeRetriesExhausted: true, groupError: "bad_sig" }),
    "unverified",
    "3",
  );
  expectShield(
    withVerdict("roster_mismatch", {
      welcomeRetriesExhausted: true,
      rosterMismatchAgeMs: 60_000,
    }),
    "unverified",
    "6",
  );
  expectShield(
    withVerdict("joining", {
      welcomeRetriesExhausted: true,
      signerLeafMissingRetries: 3,
    }),
    "unverified",
    "6c",
  );
  // only `true` spends the budget
  expectShield(
    withVerdict("joining", {
      welcomeRetriesExhausted: "true" as unknown as boolean,
    }),
    "resecuring",
    "7",
  );
});

// Planner ruling (W4-1 r2): `clientOutdated` comes only from a server 4xx,
// so it is decided after the step 3 / 3b reds and never masks one.
test("S2 step 3c: client outdated is not_available, after the step 3 and 3b reds, before step 4", () => {
  for (const min of [2, 3, 0, Number.NaN]) {
    expectShield(
      green({ clientOutdated: min }),
      "not_available",
      "3c",
      String(min),
    );
    assert.equal(
      explainShield(green({ clientOutdated: min }))?.notice,
      "client_outdated",
    );
  }
  // steps 1 and 2 still come first
  expectShield(
    green({ clientOutdated: 2, serverProtected: false }),
    "unverified",
    "1",
  );
  expectShield(
    green({ clientOutdated: 2, capable: false }),
    "not_available",
    "2",
  );
  // a verified red stays red: equivocation, owner changed, rollback, ...
  for (const over of [
    { seatListError: "seat_list_equivocation" },
    { groupError: "seat_list_equivocation" },
    { seatListError: "owner_changed" },
    { native: nativeOk({ verdict: "owner_changed" }) },
    { groupError: "seat_list_rollback" },
    { seatListError: "bad_sig" },
  ] as Partial<ShieldInputs>[]) {
    expectShield(
      green({ clientOutdated: 2, ...over }),
      "unverified",
      "3",
      JSON.stringify(over),
    );
  }
  // and so does the 3b fail-closed red
  expectShield(
    green({ clientOutdated: 2, groupError: "unknown" }),
    "unverified",
    "3b",
  );
  // it decides before steps 4-9: loading, not seated, capacity, 6d
  for (const over of [
    { native: null },
    { capacity: { reason: "device_cap" } },
    { welcomeRetriesExhausted: true },
    { native: nativeOk({ verdict: "not_seated" }) },
    { groupError: "mls_epoch_gap" },
  ] as Partial<ShieldInputs>[]) {
    expectShield(
      green({ clientOutdated: 2, ...over }),
      "not_available",
      "3c",
      JSON.stringify(over),
    );
  }
  // null (and a missing field) is not outdated
  expectShield(green({ clientOutdated: null }), "protected", "8");
  expectShield(
    green({ clientOutdated: undefined as unknown as null }),
    "protected",
    "8",
  );
});

test("S2 step 5b: capacity comes after step 5 and before step 6, only from i.capacity", () => {
  const cap = (reason: "device_cap" | "group_full") => ({ reason });
  expectShield(green({ capacity: cap("device_cap") }), "capacity", "5b");
  assert.equal(
    explainShield(green({ capacity: cap("device_cap") }))?.notice,
    "capacity_device_cap",
  );
  expectShield(green({ capacity: cap("group_full") }), "capacity", "5b");
  assert.equal(
    explainShield(green({ capacity: cap("group_full") }))?.notice,
    "capacity_group_full",
  );
  // an unknown reason still holds the state, with the copy true for both
  const odd = { reason: "bogus" } as unknown as ShieldInputs["capacity"];
  expectShield(green({ capacity: odd }), "capacity", "5b");
  assert.equal(
    explainShield(green({ capacity: odd }))?.notice,
    "capacity_device_cap",
  );
  // steps 1-5 win over it
  expectShield(
    green({ capacity: cap("device_cap"), serverProtected: false }),
    "unverified",
    "1",
  );
  expectShield(
    green({ capacity: cap("device_cap"), capable: false }),
    "not_available",
    "2",
  );
  expectShield(
    green({ capacity: cap("device_cap"), groupError: "bad_sig" }),
    "unverified",
    "3",
  );
  expectShield(
    green({ capacity: cap("device_cap"), groupError: "unknown" }),
    "unverified",
    "3b",
  );
  expectShield(
    green({ capacity: cap("group_full"), native: null }),
    "resecuring",
    "4",
  );
  expectShield(
    withVerdict("not_seated", { capacity: cap("device_cap") }),
    "not_seated",
    "5",
  );
  // it wins over steps 6-9
  for (const [label, over] of [
    ["6", withVerdict("roster_mismatch", { rosterMismatchAgeMs: 0 })],
    ["6c", withVerdict("joining", { signerLeafMissingRetries: 3 })],
    ["6d", withVerdict("joining", { welcomeRetriesExhausted: true })],
    ["7", withVerdict("no_group")],
    ["7 server", green({ serverGroup: serverGroup({ current_epoch: 9 }) })],
    ["8", green()],
    ["9", withVerdict("bogus")],
  ] as const) {
    expectShield(
      { ...over, capacity: cap("device_cap") },
      "capacity",
      "5b",
      label,
    );
  }
  // never from anything else: no capacity input, no capacity state
  for (const i of [
    green({ groupError: "text_group_full" }),
    green({ groupError: "mls_epoch_gap" }),
    withVerdict("joining"),
    green({ capacity: undefined as unknown as null }),
  ]) {
    assert.notEqual(computeShieldState(i), "capacity");
  }
});

test("S2: capacity and client outdated are never green, and capacity only with its input", () => {
  const caps = [
    null,
    { reason: "device_cap" },
    { reason: "group_full" },
  ] as ShieldInputs["capacity"][];
  let seen = 0;
  for (const verdict of [...VERDICTS, "bogus"]) {
    for (const capable of [false, true]) {
      for (const ge of [null, "bad_sig", "mls_epoch_gap", "unknown"] as const) {
        for (const capacity of caps) {
          for (const clientOutdated of [null, 2]) {
            for (const exhausted of [false, true]) {
              const e = explainShield(
                green({
                  native: nativeOk({ verdict: verdict as TextVerdict }),
                  capable,
                  groupError: ge,
                  capacity,
                  clientOutdated,
                  welcomeRetriesExhausted: exhausted,
                }),
              );
              assert.ok(e);
              seen++;
              if (e.state === "protected") {
                assert.equal(capacity, null);
                assert.equal(clientOutdated, null);
              }
              if (e.state === "capacity") {
                assert.notEqual(capacity, null);
                assert.equal(e.step, "5b");
              }
              if (e.step === "3c") assert.notEqual(clientOutdated, null);
              // a server-only signal never turns a red into not_available
              if (clientOutdated !== null && ge === "bad_sig") {
                assert.ok(
                  e.state === "unverified" || e.step === "2",
                  `${verdict}/${String(capable)}`,
                );
              }
            }
          }
        }
      }
    }
  }
  assert.equal(seen, 9 * 2 * 4 * 3 * 2 * 2);
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
    "seat_list_behind",
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
                        assert.notEqual(se, "seat_list_behind");
                        assert.notEqual(ge, "seat_list_behind");
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
    sortedCopy([...SHIELD_LISTS.step3_group_errors, ...S2_STEP3_GROUP_ADDS]),
  );
  // the S2 additions are new, not already in the 9.1 rows
  for (const tag of S2_STEP3_GROUP_ADDS) {
    assert.ok(!SHIELD_LISTS.step3_group_errors.includes(tag), tag);
  }
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
    capacity: null,
    clientOutdated: null,
    ownerNotice: null,
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

test("S2 shieldInputsFromView maps capacity and clientOutdated from the view", () => {
  const flags = { serverProtected: true, locallyPinned: true, capable: true };
  const view: ProtectedChannelView = {
    channelId: "C1",
    seatListError: null,
    groupError: null,
    native: nativeOk(),
    serverGroup: serverGroup(),
    seats: null,
    rosterMismatchSinceMs: null,
    signerLeafMissingRetries: 0,
    welcomeRetriesExhausted: false,
    ownerChangePending: false,
    recreateAvailable: false,
    publishInFlight: false,
    maybeUnsent: false,
    capacity: null,
    clientOutdated: null,
    ownerNotice: null,
  };
  const at = (v: ProtectedChannelView | null) =>
    explainShield(shieldInputsFromView(v, flags, 5));
  assert.equal(at(view)?.state, "protected");
  const capped = { ...view, capacity: { reason: "group_full" as const } };
  assert.deepEqual(shieldInputsFromView(capped, flags, 5).capacity, {
    reason: "group_full",
  });
  assert.deepEqual(at(capped), {
    state: "capacity",
    step: "5b",
    notice: "capacity_group_full",
  });
  const old = { ...view, clientOutdated: 3 };
  assert.equal(shieldInputsFromView(old, flags, 5).clientOutdated, 3);
  assert.deepEqual(at(old), {
    state: "not_available",
    step: "3c",
    notice: "client_outdated",
  });
  // a loading view carries neither
  const none = shieldInputsFromView(null, flags, 5);
  assert.equal(none.capacity, null);
  assert.equal(none.clientOutdated, null);
});

// ---------------------------------------------------------------------------
// S2 OR-10 (W4-3-0 F1): a same-user owner change this device confirmed that
// stayed unsettled. Notice and Review offer only; never the state.
// ---------------------------------------------------------------------------

/** Native holding a pending owner signer (`same_user` may be malformed). */
function pendingOwner(
  sameUser: unknown,
  verdict: TextVerdict = "owner_changed",
): TextChannelState {
  return nativeOk({
    verdict,
    owner_pin: {
      ...nativeOk().owner_pin,
      status: "changed",
      pending_signer: {
        user_id: "U1",
        device_id: "D7",
        same_user: sameUser as boolean,
        verified: true,
      },
    },
  });
}

/** Every way the shield reaches a same-user `owner_changed_review`. */
const SAME_USER_CHANGES: [string, Partial<ShieldInputs>][] = [
  ["native verdict", { native: pendingOwner(true) }],
  ["parked", { native: pendingOwner(true), ownerChangePending: true }],
  [
    "seat list error",
    {
      native: pendingOwner(true, "ok"),
      seatListError: "owner_changed",
      ownerChangePending: true,
    },
  ],
  [
    "group error",
    { native: pendingOwner(true, "ok"), groupError: "owner_changed" },
  ],
];

test("S2 OR-10: an unlisted same-user owner change shows owner_changed_unlisted and offers no Review", () => {
  for (const [label, over] of SAME_USER_CHANGES) {
    assert.deepEqual(
      explainShield(green({ ...over, ownerChangeUnlisted: true })),
      {
        state: "unverified",
        step: "3",
        notice: "owner_changed_unlisted",
        reviewOffered: false,
      },
      label,
    );
  }
});

test("S2 OR-10: without the flag (absent or false) a same-user owner change shows owner_changed_review and offers Review", () => {
  for (const [label, over] of SAME_USER_CHANGES) {
    for (const flag of [undefined, false]) {
      const i = green(over);
      if (flag !== undefined) i.ownerChangeUnlisted = flag;
      assert.ok(!(flag === undefined && "ownerChangeUnlisted" in i));
      assert.deepEqual(
        explainShield(i),
        {
          state: "unverified",
          step: "3",
          notice: "owner_changed_review",
          reviewOffered: true,
        },
        `${label} flag=${String(flag)}`,
      );
    }
  }
  // parked with no signer named: the S1 notice, Review offered as before
  assert.equal(
    explainShield(
      green({ seatListError: "owner_changed", ownerChangePending: true }),
    )?.reviewOffered,
    true,
  );
  // an owner change of unknown kind: generic notice, no Review
  assert.deepEqual(explainShield(green({ seatListError: "owner_changed" })), {
    state: "unverified",
    step: "3",
    notice: "unverified",
    reviewOffered: false,
  });
  // outside a step 3 owner change the field is absent (read as not offered)
  for (const over of [
    {},
    { seatListError: "bad_sig" },
    { serverProtected: false, native: pendingOwner(true) },
    { capable: false, native: pendingOwner(true) },
    { native: pendingOwner(true, "ok") },
  ] as Partial<ShieldInputs>[]) {
    const e = explainShield(green(over));
    assert.ok(e);
    assert.equal("reviewOffered" in e, false, JSON.stringify(e));
  }
});

test("S2 OR-10: the unlisted flag never changes the state or step and never masks a stronger red", () => {
  const cases: [string, Partial<ShieldInputs>][] = [
    ["green", {}],
    ["step 1", { serverProtected: false, native: pendingOwner(true) }],
    ["step 2", { capable: false, native: pendingOwner(true) }],
    ["step 3 same user", { native: pendingOwner(true) }],
    [
      "step 3 same user + bad_sig",
      { native: pendingOwner(true), seatListError: "bad_sig" },
    ],
    [
      "step 3 same user + equivocation",
      { native: pendingOwner(true), groupError: "seat_list_equivocation" },
    ],
    [
      "step 3 same user + outdated + capacity",
      {
        native: pendingOwner(true),
        clientOutdated: 2,
        capacity: { reason: "device_cap" },
      },
    ],
    ["step 3 different user", { native: pendingOwner(false) }],
    ["step 3 bad_sig", { seatListError: "bad_sig" }],
    ["step 3 rollback", { groupError: "seat_list_rollback" }],
    ["step 3b", { groupError: "unknown" }],
    ["step 3c", { clientOutdated: 2 }],
    ["step 4", { native: null }],
    ["step 5b", { capacity: { reason: "group_full" } }],
    [
      "step 6 red",
      {
        native: nativeOk({ verdict: "roster_mismatch" }),
        rosterMismatchAgeMs: 60_000,
      },
    ],
    ["step 6c", { signerLeafMissingRetries: 3 }],
    ["step 7", { native: nativeOk({ verdict: "poisoned" }) }],
    [
      "step 9 off-list",
      { native: nativeOk({ members: [member({ on_signed_list: false })] }) },
    ],
    ["step 9 pin changed", { native: pendingOwner(true, "ok") }],
  ];
  for (const [label, over] of cases) {
    const off = explainShield(green(over));
    const on = explainShield(green({ ...over, ownerChangeUnlisted: true }));
    assert.ok(off && on, label);
    assert.equal(on.state, off.state, label);
    assert.equal(on.step, off.step, label);
    assert.deepEqual(
      on,
      off.notice === "owner_changed_review"
        ? { ...off, notice: "owner_changed_unlisted", reviewOffered: false }
        : off,
      label,
    );
  }
  expectShield(green({ ownerChangeUnlisted: true }), "protected", "8");
});

test("S2 OR-10: a different-user or unknown-signer owner change is unaffected by the unlisted flag", () => {
  const cases: [string, Partial<ShieldInputs>][] = [
    ["different user", { native: pendingOwner(false) }],
    [
      "different user, parked",
      { native: pendingOwner(false), ownerChangePending: true },
    ],
    [
      "different user, seat list",
      { native: pendingOwner(false, "ok"), seatListError: "owner_changed" },
    ],
    [
      "no signer, parked",
      { seatListError: "owner_changed", ownerChangePending: true },
    ],
    [
      "malformed same_user, parked",
      { native: pendingOwner("yes"), ownerChangePending: true },
    ],
  ];
  for (const [label, over] of cases) {
    assert.deepEqual(
      explainShield(green({ ...over, ownerChangeUnlisted: true })),
      explainShield(green(over)),
      label,
    );
  }
  assert.deepEqual(
    explainShield(
      green({ native: pendingOwner(false), ownerChangeUnlisted: true }),
    ),
    {
      state: "unverified",
      step: "3",
      notice: "owner_changed_locked",
      reviewOffered: false,
    },
  );
});

test("S2 OR-10: shieldInputsFromView reads ownerChangeUnlisted from the view; absent or malformed is false", () => {
  const flags = { serverProtected: true, locallyPinned: true, capable: true };
  const view: ProtectedChannelView = {
    channelId: "C1",
    seatListError: "owner_changed",
    groupError: null,
    native: pendingOwner(true),
    serverGroup: serverGroup(),
    seats: null,
    rosterMismatchSinceMs: null,
    signerLeafMissingRetries: 0,
    welcomeRetriesExhausted: false,
    ownerChangePending: true,
    recreateAvailable: false,
    publishInFlight: false,
    maybeUnsent: false,
    capacity: null,
    clientOutdated: null,
    ownerNotice: null,
    ownerChangeUnlisted: true,
  };
  const at = (v: ProtectedChannelView | null) =>
    explainShield(shieldInputsFromView(v, flags, 5));
  assert.equal(shieldInputsFromView(view, flags, 5).ownerChangeUnlisted, true);
  assert.deepEqual(at(view), {
    state: "unverified",
    step: "3",
    notice: "owner_changed_unlisted",
    reviewOffered: false,
  });
  const absent: ProtectedChannelView = { ...view };
  delete absent.ownerChangeUnlisted;
  for (const v of [
    { ...view, ownerChangeUnlisted: false },
    absent,
    { ...view, ownerChangeUnlisted: "true" as unknown as boolean },
  ]) {
    assert.equal(shieldInputsFromView(v, flags, 5).ownerChangeUnlisted, false);
    assert.deepEqual(at(v), {
      state: "unverified",
      step: "3",
      notice: "owner_changed_review",
      reviewOffered: true,
    });
  }
  assert.equal(shieldInputsFromView(null, flags, 5).ownerChangeUnlisted, false);
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
      // S2 D35: neutral, read-only, never tints
      capacity: ["shield", "--sloga-protected-unavailable", false, "hidden"],
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
  // capacity is never the alarm hue or glyph
  const cap = shieldPresentation("capacity");
  assert.notEqual(cap.hueVar, "--sloga-protected-alert");
  assert.notEqual(cap.glyph, "gpp_bad");
  assert.equal(cap.notice, "capacity_device_cap");
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
    green({ clientOutdated: 2 }),
    green({ capacity: { reason: "device_cap" } }),
    green({ capacity: { reason: "group_full" } }),
  ];
  for (const i of samples) {
    const e = explainShield(i);
    assert.ok(e);
    assert.equal(e.notice === null, e.state === "protected");
    if (e.notice !== null) assert.ok(PROTECTED_NOTICE_KINDS.includes(e.notice));
  }
});

test("S2 notice kinds are declared once each", () => {
  for (const k of [
    "capacity_device_cap",
    "capacity_group_full",
    "client_outdated",
    "waiting_for_member",
    "owner_device_lost",
    "owner_account_unavailable",
    "owner_device_dropped",
    "owner_changed_unlisted",
    "removal_reason_required",
    "resecured_too_often",
    "revoked_owner_devices",
  ]) {
    assert.equal(PROTECTED_NOTICE_KINDS.filter((x) => x === k).length, 1, k);
  }
  assert.equal(
    new Set(PROTECTED_NOTICE_KINDS).size,
    PROTECTED_NOTICE_KINDS.length,
  );
  // S1's stalled-join notice still exists for step 6c
  assert.ok(PROTECTED_NOTICE_KINDS.includes("join_stalled"));
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
  "unsupported_version",
  "unencrypted_row",
  "error",
];

/** Design 9.2 red markers (the grey ones: sent_before_join, unknown_key, unsupported_version). */
const RED_MARKERS: ProtectedMarkerKind[] = [
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
      assert.ok(
        ui.users === undefined ||
          (ui.notice === "seat_list_names_removed_users" &&
            ui.users.every((u) => typeof u === "string" && u.length > 0)),
        `${label}: users`,
      );
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
    // S2: left + rejoin (9.2); a decrypt-only tag fails closed off a row
    catch_up_leaf_unresolvable: "resecuring",
    unsupported_envelope_version: "unverified",
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
  assert.equal(
    m(native("unsupported_envelope_version", { v: 3 })),
    "marker:unsupported_version",
  );
  for (const tag of TEXT_NATIVE_ERROR_TAGS) {
    const u = ui(native(tag), "message");
    if (tag === "unknown_epoch") continue;
    assert.equal(u.kind, "marker", tag);
  }
  // a server error or transport failure on a message row is the red marker
  assert.equal(m({ type: "NotSeated" }), "marker:error");
  assert.equal(m({ source: "transport" }), "marker:error");
});

test("S3-N0: a newer envelope version on a row is the grey unsupported_version marker, never red", () => {
  for (const f of [{ v: 3 }, { v: 255 }, {}, { v: "x" }]) {
    for (const err of [
      native("unsupported_envelope_version", f),
      { source: "native", error: native("unsupported_envelope_version", f) },
    ]) {
      const u = ui(err, "message");
      assert.deepEqual(
        u,
        {
          kind: "marker",
          marker: "unsupported_version",
          tag: "unsupported_envelope_version",
        },
        JSON.stringify(err),
      );
      assert.ok(
        u.kind === "marker" && !RED_MARKERS.includes(u.marker),
        "grey, never a red marker",
      );
    }
  }
  // off a row it is unexpected: fails closed, and never the marker
  for (const op of OPS) {
    if (op === "message") continue;
    assert.equal(
      brief(ui(native("unsupported_envelope_version", { v: 3 }), op)),
      "unverified",
      op,
    );
  }
  // as a shield input it is outside every benign list: 3b, never green
  expectShield(
    green({ groupError: "unsupported_envelope_version" }),
    "unverified",
    "3b",
  );
});

test("S2: catch_up_leaf_unresolvable is resecuring and a benign groupError, never sticky red", () => {
  for (const op of OPS) {
    if (op === "message") continue;
    assert.equal(
      brief(ui(native("catch_up_leaf_unresolvable", { epoch: 4 }), op)),
      "resecuring",
      op,
    );
  }
  assert.ok(
    (SHIELD_BENIGN_GROUP_ERRORS as readonly string[]).includes(
      "catch_up_leaf_unresolvable",
    ),
  );
  // the native verdict decides: left + rejoin reads as resecuring
  expectShield(
    withVerdict("no_group", { groupError: "catch_up_leaf_unresolvable" }),
    "resecuring",
    "7",
  );
  expectShield(
    green({ groupError: "catch_up_leaf_unresolvable", native: null }),
    "resecuring",
    "4",
  );
});

test("S2 seat_list_rollback as a groupError is loud at step 3, never green", () => {
  assert.ok(
    (SHIELD_LOUD_GROUP_ERRORS as readonly string[]).includes(
      "seat_list_rollback",
    ),
  );
  assert.ok(
    !(SHIELD_BENIGN_GROUP_ERRORS as readonly string[]).includes(
      "seat_list_rollback",
    ),
  );
  for (const v of [...VERDICTS, "bogus"]) {
    expectShield(
      withVerdict(v, { groupError: "seat_list_rollback" }),
      "unverified",
      "3",
      v,
    );
  }
  expectShield(
    green({ groupError: "seat_list_rollback", native: null }),
    "unverified",
    "3",
  );
  // capacity never hides it
  expectShield(
    green({
      groupError: "seat_list_rollback",
      capacity: { reason: "device_cap" },
    }),
    "unverified",
    "3",
  );
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
      // OR-21: InSlowmode is protected only on the owner path (below)
      const generic =
        type === "InSlowmode" && op !== "owner" && op !== "message";
      assert.equal(u.tag, generic ? "unknown" : type, `${type}/${op}`);
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

test("S2 server types: RemovalReasonRequired, ProtectedClientOutdated, InSlowmode, owner_device_lost", () => {
  const s = (
    type: string,
    body: Record<string, unknown>,
    op: ProtectedErrorOp,
  ) => ui({ source: "server", status: 400, type, body: { type, ...body } }, op);
  for (const op of ["owner", "action", "send", "channel"] as const) {
    assert.deepEqual(s("RemovalReasonRequired", {}, op), {
      kind: "notice",
      notice: "removal_reason_required",
      max: null,
      tag: "RemovalReasonRequired",
    });
  }
  // OR-4: never the catch-all `unverified`; `min` never read or shown
  for (const op of ["channel", "owner", "send"] as const) {
    for (const body of [{ min: 2 }, { min: "x" }, {}]) {
      assert.deepEqual(
        s("ProtectedClientOutdated", body, op),
        {
          kind: "notice",
          notice: "client_outdated",
          max: null,
          tag: "ProtectedClientOutdated",
        },
        `${op} ${JSON.stringify(body)}`,
      );
    }
  }
  assert.equal(
    brief(ui({ type: "ProtectedClientOutdated", min: 2 }, "channel")),
    "client_outdated",
  );
  // OR-21: protected copy on the owner's successor create only
  assert.deepEqual(s("InSlowmode", { retry_after: 3600 }, "owner"), {
    kind: "notice",
    notice: "resecured_too_often",
    max: null,
    tag: "InSlowmode",
  });
  for (const op of ["send", "channel", "action", "transfer"] as const) {
    assert.deepEqual(
      s("InSlowmode", { retry_after: 5 }, op),
      { kind: "notice", notice: "unverified", max: null, tag: "unknown" },
      op,
    );
  }
  // ProtectedChannelResecuring: only the S2 reason changes the copy
  assert.equal(
    brief(
      s("ProtectedChannelResecuring", { reason: "owner_device_lost" }, "send"),
    ),
    "owner_device_lost",
  );
  for (const reason of [
    "pending_removal",
    "stale_seat_list",
    "OWNER_DEVICE_LOST",
    7,
    undefined,
  ]) {
    assert.equal(
      brief(s("ProtectedChannelResecuring", { reason }, "send")),
      "resecuring",
      String(reason),
    );
  }
  // a message row never reads any of them
  for (const type of [
    "RemovalReasonRequired",
    "ProtectedClientOutdated",
    "InSlowmode",
  ]) {
    assert.equal(brief(s(type, {}, "message")), "marker:error", type);
  }
});

// W2 C1 (cross-session note 10-25): `PUT /channels/:id/seats` answers 400
// `{type: "SeatListNamesRemovedUsers", users}` when the list still names
// users the server force-released. Control C-ERR1: the SERVER_RULES entry
// removed (or protectedShield.ts at c3381567) turns this red.
const removedA = "01USERREMOVEDA000000000000";
const removedB = "01USERREMOVEDB000000000000";
const removedErr = (users: unknown) => ({
  source: "server",
  status: 400,
  type: "SeatListNamesRemovedUsers",
  body: { type: "SeatListNamesRemovedUsers", users },
});

test("W2 C1: SeatListNamesRemovedUsers is its own owner notice carrying the ids", () => {
  assert.ok(PROTECTED_NOTICE_KINDS.includes("seat_list_names_removed_users"));
  assert.ok(
    (PROTECTED_SERVER_ERROR_TYPES as readonly string[]).includes(
      "SeatListNamesRemovedUsers",
    ),
  );
  assert.deepEqual(ui(removedErr([removedA, removedB]), "owner"), {
    kind: "notice",
    notice: "seat_list_names_removed_users",
    max: null,
    tag: "SeatListNamesRemovedUsers",
    users: [removedA, removedB],
  });
  // a bare server body maps the same way
  const bare = ui(
    { type: "SeatListNamesRemovedUsers", users: [removedB] },
    "owner",
  );
  assert.equal(brief(bare), "seat_list_names_removed_users");
  assert.deepEqual(bare.kind === "notice" && bare.users, [removedB]);
  // a message row never reads it: the red marker, no ids
  assert.deepEqual(ui(removedErr([removedA]), "message"), {
    kind: "marker",
    marker: "error",
    tag: "SeatListNamesRemovedUsers",
  });
  // never the catch-all for any other op either (total mapping)
  for (const op of OPS) {
    const u = ui(removedErr([removedA]), op);
    wellFormed(u, `removed/${op}`);
    if (op !== "message") {
      assert.equal(brief(u), "seat_list_names_removed_users", op);
    }
  }
});

test("W2 C1: malformed SeatListNamesRemovedUsers.users is dropped, deduplicated and capped", () => {
  const usersOf = (users: unknown) => {
    const u = ui(removedErr(users), "owner");
    assert.equal(brief(u), "seat_list_names_removed_users");
    return u.kind === "notice" ? u.users : "not a notice";
  };
  assert.deepEqual(
    usersOf([removedA, removedA, "", 7, null, { id: removedB }, removedB]),
    [removedA, removedB],
  );
  for (const bad of [undefined, null, "01USER", 3, { 0: removedA }]) {
    assert.deepEqual(usersOf(bad), [], String(bad));
  }
  const many = Array.from(
    { length: REMOVED_USERS_MAX + 50 },
    (_, i) => `U${i}`,
  );
  const capped = usersOf(many);
  assert.ok(Array.isArray(capped));
  assert.equal(capped.length, REMOVED_USERS_MAX);
  assert.equal(capped[0], "U0");
});

test("W2 C1: a removed-users refusal is a server type, never a shield input", () => {
  // Owner UI only: not a native (view) error tag, so no shield step reads it.
  assert.ok(
    !(NATIVE_ERROR_TAGS as readonly string[]).includes(
      "SeatListNamesRemovedUsers",
    ),
  );
  assert.ok(
    !(NATIVE_ERROR_TAGS as readonly string[]).includes(
      "seat_list_names_removed_users",
    ),
  );
});

test("W2c: commit-transaction DeviceCapReached / MlsCallFull map like the seat ones", () => {
  // The commit context is channel-level (`op: "channel"`); same copy kinds
  // and caps as the seat context (`op: "owner"`).
  const s = (type: string, max: unknown, op: ProtectedErrorOp) =>
    ui({ source: "server", status: 400, type, body: { type, max } }, op);
  for (const op of ["channel", "owner"] as const) {
    assert.deepEqual(s("DeviceCapReached", 2, op), {
      kind: "notice",
      notice: "device_cap_reached",
      max: 2,
      tag: "DeviceCapReached",
    });
    assert.deepEqual(s("MlsCallFull", 100, op), {
      kind: "notice",
      notice: "channel_full",
      max: 100,
      tag: "MlsCallFull",
    });
    const bad = s("DeviceCapReached", "2", op);
    assert.equal(bad.kind === "notice" && bad.max, null);
  }
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
