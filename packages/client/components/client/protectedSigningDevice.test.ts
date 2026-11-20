// Spec for `protectedSigningDevice.ts` (lane FXU): which device may read the
// poisoned-group notice's "Re-securing with a new group..." line (FXT2's
// `noticeCopy` ctx). Only the device that runs the manager's D21 successor
// itself; any other device reads that the owner has to re-create the group.
//
//  S1  `signingDeviceOf` is true for the D21 successor device and false as
//      soon as any part of that condition fails or is unknown;
//  S2  `protectedSelfIds` reads the same ids as the header pill;
//  S3  the rule agrees with the D36 escalation's own signer rule
//      (`resecureCause`: poisoned_owner vs poisoned_member);
//  S4  drift tripwire: the manager's D21 block still reads the condition
//      this rule mirrors (a change there must be mirrored here).
//
// Run: node --conditions=browser --test \
//   components/client/protectedSigningDevice.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resecureCause } from "./protectedResecurePolicy.ts";
import { protectedSelfIds, signingDeviceOf } from "./protectedSigningDevice.ts";

type Shield = Parameters<typeof signingDeviceOf>[0];
type Self = Parameters<typeof signingDeviceOf>[1];

const SELF: Self = { userId: "U1", deviceId: "D1" };

/** The D21 successor device's shield: every part of the condition holds. */
function signerShield(
  native: Record<string, unknown> = {},
  view: Record<string, unknown> = {},
): Shield {
  return {
    serverProtected: true,
    view: {
      clientOutdated: null,
      native: {
        group_id: "G1",
        epoch: 4,
        state: "poisoned",
        verdict: "poisoned",
        seat_list: { signer_user_id: "U1", signer_device_id: "D1" },
        ...native,
      },
      serverGroup: {
        group_id: "G1",
        current_epoch: 4,
        pending_removals: [],
      },
      ...view,
    },
  } as unknown as Shield;
}

test("FXU signingDeviceOf: true on the device that runs the D21 successor (poisoned, the server's open group, this device signed the list)", () => {
  assert.equal(signingDeviceOf(signerShield(), SELF), true);
  // Only the comparison inputs matter: a different epoch or verdict on the
  // server's open group still runs the successor.
  assert.equal(
    signingDeviceOf(signerShield({ epoch: 9, verdict: "ok" }), SELF),
    true,
  );
});

test("FXU signingDeviceOf: any other device of the owner, or another user, is not the signing device", () => {
  for (const self of [
    { userId: "U1", deviceId: "D2" },
    { userId: "U2", deviceId: "D1" },
    { userId: "U2", deviceId: "D2" },
  ]) {
    assert.equal(signingDeviceOf(signerShield(), self), false, self.deviceId);
  }
  for (const seat_list of [
    null,
    undefined,
    { signer_user_id: "U1", signer_device_id: "D2" },
    { signer_user_id: "U2", signer_device_id: "D1" },
    { signer_user_id: "U1" },
    { signer_device_id: "D1" },
  ]) {
    assert.equal(
      signingDeviceOf(signerShield({ seat_list }), SELF),
      false,
      JSON.stringify(seat_list),
    );
  }
});

test("FXU signingDeviceOf: false whenever the manager would not re-create (not poisoned, another or no server group, outdated, flag stripped)", () => {
  // FXP F-L6: `joining`, `left` and `none` (no group held) are no longer
  // false but the no_group role (see the FXP test below); every other
  // state the D21 block does not re-create from stays false.
  for (const state of ["active", "", undefined]) {
    assert.equal(
      signingDeviceOf(signerShield({ state }), SELF),
      false,
      `state ${String(state)}`,
    );
  }
  // A poisoned verdict alone is not native's poisoned state (the D21 block
  // reads `state`).
  assert.equal(
    signingDeviceOf(
      signerShield({ state: "active", verdict: "poisoned" }),
      SELF,
    ),
    false,
  );
  // The server no longer names the poisoned group as open.
  for (const serverGroup of [
    null,
    undefined,
    { group_id: "G2", current_epoch: 0, pending_removals: [] },
  ]) {
    assert.equal(
      signingDeviceOf(signerShield({}, { serverGroup }), SELF),
      false,
      JSON.stringify(serverGroup),
    );
  }
  assert.equal(signingDeviceOf(signerShield({ group_id: null }), SELF), false);
  assert.equal(signingDeviceOf(signerShield({ group_id: "G2" }), SELF), false);
  // S4 floor: an outdated client creates nothing; unknown is not "not
  // outdated".
  for (const clientOutdated of [3, 0, undefined]) {
    assert.equal(
      signingDeviceOf(signerShield({}, { clientOutdated }), SELF),
      false,
      `clientOutdated ${String(clientOutdated)}`,
    );
  }
  // A stripped (or unknown) server flag runs no maintenance.
  for (const serverProtected of [false, undefined, null, "true", 1]) {
    const shield = { ...signerShield(), serverProtected } as unknown as Shield;
    assert.equal(
      signingDeviceOf(shield, SELF),
      false,
      `serverProtected ${String(serverProtected)}`,
    );
  }
  // No native state yet.
  assert.equal(
    signingDeviceOf(signerShield({}, { native: null }), SELF),
    false,
  );
});

test("FXU signingDeviceOf: no shield, no view or unknown own ids is never the signing device", () => {
  assert.equal(signingDeviceOf(null, SELF), false);
  assert.equal(signingDeviceOf(undefined, SELF), false);
  assert.equal(
    signingDeviceOf({ serverProtected: true, view: null }, SELF),
    false,
  );
  assert.equal(signingDeviceOf({ serverProtected: true }, SELF), false);
  for (const self of [
    { userId: null, deviceId: "D1" },
    { userId: "U1", deviceId: null },
    { userId: undefined, deviceId: undefined },
    { userId: "", deviceId: "" },
  ]) {
    assert.equal(signingDeviceOf(signerShield(), self), false);
  }
  // An empty id never matches an empty signer field.
  assert.equal(
    signingDeviceOf(
      signerShield({ seat_list: { signer_user_id: "", signer_device_id: "" } }),
      { userId: "", deviceId: "" },
    ),
    false,
  );
});

test("FXU protectedSelfIds: the pill's reads (user id, the bridge status device_id), null when missing", () => {
  const client = (user: unknown, status: unknown) => ({
    user,
    e2ee: status === undefined ? undefined : { status },
  });
  const statusOf = (state: unknown) => ({
    get(key: string) {
      return key === "state" ? state : undefined;
    },
  });
  assert.deepEqual(
    protectedSelfIds(client({ id: "U1" }, statusOf({ device_id: "D1" }))),
    { userId: "U1", deviceId: "D1" },
  );
  assert.deepEqual(protectedSelfIds(client({ id: "U1" }, undefined)), {
    userId: "U1",
    deviceId: null,
  });
  assert.deepEqual(
    protectedSelfIds(client(null, statusOf({ device_id: "D1" }))),
    { userId: null, deviceId: "D1" },
  );
  for (const state of [null, undefined, {}, { device_id: 7 }, "D1"]) {
    assert.equal(
      protectedSelfIds(client({ id: "U1" }, statusOf(state))).deviceId,
      null,
      JSON.stringify(state),
    );
  }
  assert.equal(
    protectedSelfIds(client({ id: 1 }, statusOf({ device_id: "D1" }))).userId,
    null,
  );
  for (const c of [null, undefined, "client", {}, { e2ee: { status: {} } }]) {
    assert.deepEqual(protectedSelfIds(c), { userId: null, deviceId: null });
  }
});

test("FXU the rule agrees with the D36 escalation's signer rule: the signing device is poisoned_owner, another device poisoned_member", () => {
  const inputs = (shield: Shield, self: Self) => {
    const v = (shield as unknown as { view: Record<string, unknown> }).view;
    return {
      groupError: "mls_leaf_rejected",
      native: v.native,
      serverGroup: v.serverGroup,
      welcomeRetriesExhausted: false,
      resecuringSinceMs: 0,
      selfUserId: self.userId ?? "",
      selfDeviceId: self.deviceId ?? "",
    } as unknown as Parameters<typeof resecureCause>[0];
  };
  const other = { userId: "U1", deviceId: "D2" };
  assert.equal(signingDeviceOf(signerShield(), SELF), true);
  assert.equal(
    resecureCause(inputs(signerShield(), SELF), 0).cause,
    "poisoned_owner",
  );
  assert.equal(signingDeviceOf(signerShield(), other), false);
  assert.equal(
    resecureCause(inputs(signerShield(), other), 0).cause,
    "poisoned_member",
  );
});

test("FXU drift tripwire: the manager's D21 successor block still reads the condition signingDeviceOf mirrors", () => {
  const src = readFileSync(
    process.env.PROTECTED_TEXT_TS ||
      new URL("./protectedText.ts", import.meta.url),
    "utf8",
  );
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const at = src.indexOf(
    "  #afterRefresh(rec: ChannelRec, reason: TextRefreshReason): void {",
  );
  assert.ok(at >= 0, "#afterRefresh missing");
  const body = flat(src.slice(at, src.indexOf("\n  }\n", at)));
  for (const piece of [
    "if (this.#disposed || rec.stripped) return;",
    "const n = rec.native; const g = rec.serverGroup; if (!n) return;",
    "const outdated = rec.clientOutdated !== null;",
    'if ( !outdated && n.state === "poisoned" && g && g.group_id === n.group_id && this.#isSigner(rec) ) { this.#background(this.#createSuccessor(rec)); }',
  ]) {
    assert.ok(body.includes(piece), `D21 block changed: ${piece}`);
  }
  const signer = src.indexOf("  #isSigner(rec: ChannelRec): boolean {");
  assert.ok(signer >= 0, "#isSigner missing");
  assert.equal(
    flat(src.slice(signer, src.indexOf("\n  }\n", signer) + 4)),
    flat(`#isSigner(rec: ChannelRec): boolean {
    const l = rec.native?.seat_list ?? null;
    return (
      l !== null &&
      l.signer_user_id === this.#port.selfUserId &&
      l.signer_device_id === this.#port.selfDeviceId
    );
  }`),
  );
});

test("FXP F-L6 signingDeviceOf: a device whose native holds no group (joining, left, none) has the no_group role whoever signed the list, even outdated; holding the group (active) keeps false, the D21 device true; a stripped flag or no view stays false", () => {
  for (const state of ["joining", "left", "none"]) {
    for (const self of [
      SELF,
      { userId: "U1", deviceId: "D2" },
      { userId: "U9", deviceId: "D9" },
      { userId: null, deviceId: null },
    ]) {
      assert.equal(
        signingDeviceOf(signerShield({ state, group_id: null }), self),
        "no_group",
        `${state} ${String(self.deviceId)}`,
      );
    }
    assert.equal(
      signingDeviceOf(signerShield({ state }, { serverGroup: null }), SELF),
      "no_group",
      `${state}, no server group`,
    );
    assert.equal(
      signingDeviceOf(signerShield({ state }, { clientOutdated: 3 }), SELF),
      "no_group",
      `${state}, outdated: still no group`,
    );
    const stripped = {
      ...signerShield({ state }),
      serverProtected: false,
    } as unknown as Shield;
    assert.equal(signingDeviceOf(stripped, SELF), false, `${state}, stripped`);
  }
  assert.equal(signingDeviceOf(signerShield({ state: "active" }), SELF), false);
  assert.equal(signingDeviceOf(signerShield(), SELF), true);
  assert.equal(
    signingDeviceOf(signerShield({}, { native: null }), SELF),
    false,
    "no native state",
  );
});
