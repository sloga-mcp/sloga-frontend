// Specs for the audit log entry descriptors. Run with Node's built-in runner:
//   node --conditions=browser --test components/app/interface/settings/server/auditLog/auditEntryModel.test.ts
//
// Pure: no DOM, no client. The target kinds follow the pinned action table
// in the moderation plan; an action this build does not know must still
// describe, never throw.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AuditLogAction, AuditLogEntryData } from "stoat.js";

import {
  type AuditTargetKind,
  KNOWN_AUDIT_ACTIONS,
  auditValueText,
  describeAuditEntry,
} from "./auditEntryModel.ts";

/** The pinned action table, written out independently of the module */
const TABLE: [AuditLogAction, AuditTargetKind][] = [
  ["member_kick", "user"],
  ["member_ban_add", "user"],
  ["member_ban_remove", "user"],
  ["member_timeout", "user"],
  ["member_timeout_remove", "user"],
  ["member_role_update", "user"],
  ["member_update", "user"],
  ["member_voice_update", "user"],
  ["member_move", "user"],
  ["member_disconnect", "user"],
  ["message_delete", "user"],
  ["message_bulk_delete", "none"],
  ["channel_create", "channel"],
  ["channel_update", "channel"],
  ["channel_delete", "channel"],
  ["channel_overwrite_update", "permission_target"],
  ["server_permissions_update", "permission_target"],
  ["role_create", "role"],
  ["role_update", "role"],
  ["role_delete", "role"],
  ["role_ranks_update", "none"],
  ["server_update", "none"],
  ["server_owner_transfer", "user"],
];

/** An entry with only the required fields */
function entry(overrides: Partial<AuditLogEntryData> = {}): AuditLogEntryData {
  return {
    _id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
    server: "01JSERVER00000000000000000",
    action: "member_kick",
    ...overrides,
  };
}

test("the known actions are the 23 in the table, in contract order", () => {
  assert.deepEqual(
    [...KNOWN_AUDIT_ACTIONS],
    TABLE.map(([action]) => action),
  );
  assert.equal(KNOWN_AUDIT_ACTIONS.length, 23);
  assert.equal(new Set(KNOWN_AUDIT_ACTIONS).size, 23);
});

for (const [action, targetKind] of TABLE) {
  test(`${action} targets ${targetKind}`, () => {
    const described = describeAuditEntry(entry({ action }));
    assert.equal(described.kind, action);
    assert.equal(described.targetKind, targetKind);
    assert.equal(described.unknown, false);
  });
}

for (const action of [
  "unknown",
  "something_new",
  "",
  "MEMBER_KICK",
  "constructor",
  "__proto__",
  "toString",
]) {
  test(`${JSON.stringify(action)} is an unknown action that targets nothing`, () => {
    const described = describeAuditEntry(entry({ action }));
    assert.equal(described.kind, "unknown");
    assert.equal(described.unknown, true);
    assert.equal(described.targetKind, "none");
    assert.deepEqual(described.changes, []);
  });
}

test("an unknown action keeps its changes and count", () => {
  const changes = [
    { key: "thing", new: { type: "Bool" as const, value: true } },
  ];
  const described = describeAuditEntry(
    entry({ action: "something_new", changes, count: 3 }),
  );
  assert.equal(described.changes, changes);
  assert.equal(described.count, 3);
});

test("absent changes default to an empty list", () => {
  assert.deepEqual(describeAuditEntry(entry()).changes, []);
});

test("changes pass through unchanged", () => {
  const changes = [
    {
      key: "roles_added",
      new: { type: "StringList" as const, value: ["01JROLE"] },
    },
    { key: "nickname", old: { type: "String" as const, value: "old" } },
  ];
  const described = describeAuditEntry(
    entry({ action: "member_role_update", changes }),
  );
  assert.equal(described.changes, changes);
});

test("count passes through, including zero", () => {
  assert.equal(
    describeAuditEntry(entry({ action: "message_bulk_delete", count: 42 }))
      .count,
    42,
  );
  assert.equal(
    describeAuditEntry(entry({ action: "message_bulk_delete", count: 0 }))
      .count,
    0,
  );
});

test("an absent count stays absent", () => {
  const described = describeAuditEntry(entry());
  assert.equal(described.count, undefined);
  assert.equal("count" in described, false);
});

test("a String value renders as-is", () => {
  assert.equal(auditValueText({ type: "String", value: "general" }), "general");
  assert.equal(auditValueText({ type: "String", value: "" }), "");
});

test("an Int value renders in decimal", () => {
  assert.equal(auditValueText({ type: "Int", value: 0 }), "0");
  assert.equal(auditValueText({ type: "Int", value: -86400 }), "-86400");
  assert.equal(
    auditValueText({ type: "Int", value: 2 ** 40 }),
    "1099511627776",
  );
  assert.equal(
    auditValueText({ type: "Int", value: 1e21 }),
    "1000000000000000000000",
  );
});

test("a Bool value renders as true or false", () => {
  assert.equal(auditValueText({ type: "Bool", value: true }), "true");
  assert.equal(auditValueText({ type: "Bool", value: false }), "false");
});

test("a StringList value renders comma-joined", () => {
  assert.equal(
    auditValueText({ type: "StringList", value: ["a", "b", "c"] }),
    "a, b, c",
  );
  assert.equal(auditValueText({ type: "StringList", value: ["only"] }), "only");
  assert.equal(auditValueText({ type: "StringList", value: [] }), "");
});

test("an absent value renders as empty", () => {
  assert.equal(auditValueText(undefined), "");
});

test("a value type this build does not know renders as empty", () => {
  assert.equal(auditValueText({ type: "Float", value: 1.5 } as never), "");
});
