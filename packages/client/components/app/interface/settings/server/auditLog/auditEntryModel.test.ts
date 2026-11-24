// Specs for the audit log entry descriptors. Run with Node's built-in runner:
//   node --conditions=browser --test components/app/interface/settings/server/auditLog/auditEntryModel.test.ts
//
// Pure: no DOM, no client. The target kinds follow the pinned action table
// in the moderation plan; an action this build does not know must still
// describe, never throw.
//
// The two protected channel actions (`channel_protect`,
// `channel_history_wipe`) are read strictly: an entry that is not exactly a
// shape the server writes has no detail and the page shows the generic
// sentence. The page and the row import Solid and the UI kit, so Node cannot
// load them: the last tests cut their pure helpers out of the source, strip
// the types with Node's own stripper and run them against stub copy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import type { AuditLogAction, AuditLogEntryData } from "stoat.js";

import {
  type AuditProtectedDetail,
  type AuditTargetKind,
  AUDIT_FILTER_ACTIONS,
  KNOWN_AUDIT_ACTIONS,
  auditValueText,
  describeAuditEntry,
  protectedAuditCopyArgs,
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
  ["channel_protect", "none"],
  ["channel_history_wipe", "none"],
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

test("the known actions are the 25 in the table, in contract order", () => {
  assert.deepEqual(
    [...KNOWN_AUDIT_ACTIONS],
    TABLE.map(([action]) => action),
  );
  assert.equal(KNOWN_AUDIT_ACTIONS.length, 25);
  assert.equal(new Set(KNOWN_AUDIT_ACTIONS).size, 25);
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

// ---- Protected channel entries ----------------------------------------------

const CHANNEL = "01JCHANNEL0000000000000000";
const OWNER = "01JOWNER000000000000000000";
const BOUNDARY = "01JBOUNDARYMESSAGE00000000";

const bool = (value: unknown) => ({ type: "Bool", value }) as never;
const int = (value: unknown) => ({ type: "Int", value }) as never;
const str = (value: unknown) => ({ type: "String", value }) as never;

/** A `channel_protect` entry as the server writes it */
function protect(
  wiped: unknown,
  overrides: Partial<AuditLogEntryData> = {},
): AuditLogEntryData {
  return entry({
    action: "channel_protect",
    actor: OWNER,
    channel: CHANNEL,
    changes: [
      { key: "boundary", new: str(BOUNDARY) },
      { key: "wiped", new: wiped as never },
    ],
    ...overrides,
  });
}

/** The owner's `channel_history_wipe` request: an actor and no changes */
function wipeRequest(
  overrides: Partial<AuditLogEntryData> = {},
): AuditLogEntryData {
  return entry({
    action: "channel_history_wipe",
    actor: OWNER,
    channel: CHANNEL,
    ...overrides,
  });
}

/** The job's `channel_history_wipe` entry: no actor, one `count` change */
function wipeDone(
  count: unknown,
  overrides: Partial<AuditLogEntryData> = {},
): AuditLogEntryData {
  return entry({
    action: "channel_history_wipe",
    channel: CHANNEL,
    changes: [{ key: "count", new: count as never }],
    ...overrides,
  });
}

test("U6: protect with the earlier messages kept reads wiped false", () => {
  const described = describeAuditEntry(protect(bool(false)));
  assert.equal(described.kind, "channel_protect");
  assert.equal(described.unknown, false);
  assert.deepEqual(described.protectedDetail, {
    action: "channel_protect",
    channel: CHANNEL,
    wiped: false,
  });
});

test("U6: protect with the earlier messages deleted reads wiped true", () => {
  assert.deepEqual(describeAuditEntry(protect(bool(true))).protectedDetail, {
    action: "channel_protect",
    channel: CHANNEL,
    wiped: true,
  });
});

test("U6: a channel protected empty has a boundary change without a value", () => {
  const described = describeAuditEntry(
    protect(bool(false), {
      changes: [{ key: "boundary" }, { key: "wiped", new: bool(false) }],
    }),
  );
  assert.deepEqual(described.protectedDetail, {
    action: "channel_protect",
    channel: CHANNEL,
    wiped: false,
  });
  // Without the boundary change at all, too
  assert.deepEqual(
    describeAuditEntry(
      protect(bool(true), { changes: [{ key: "wiped", new: bool(true) }] }),
    ).protectedDetail,
    { action: "channel_protect", channel: CHANNEL, wiped: true },
  );
});

test("U6: a protect entry that cannot be read has no detail", () => {
  const unreadable: [string, AuditLogEntryData][] = [
    // `wiped` that is not a literal Bool
    ["wiped String false", protect(str("false"))],
    ["wiped String true", protect(str("true"))],
    ["wiped Bool with a string false", protect(bool("false"))],
    ["wiped Bool with a string true", protect(bool("true"))],
    ["wiped Bool with 1", protect(bool(1))],
    ["wiped Bool with null", protect(bool(null))],
    ["wiped Int 1", protect(int(1))],
    ["wiped a bare true", protect(true)],
    ["wiped without a value", protect(undefined)],
    ["wiped null", protect(null)],
    [
      "wiped as a before/after pair",
      protect(bool(true), {
        changes: [{ key: "wiped", old: bool(false), new: bool(true) }],
      }),
    ],
    [
      "wiped only as an old value",
      protect(bool(true), { changes: [{ key: "wiped", old: bool(true) }] }),
    ],
    // The change list
    ["no changes", protect(bool(true), { changes: undefined })],
    ["empty changes", protect(bool(true), { changes: [] })],
    [
      "only the boundary",
      protect(bool(true), {
        changes: [{ key: "boundary", new: str(BOUNDARY) }],
      }),
    ],
    [
      "wiped twice",
      protect(bool(true), {
        changes: [
          { key: "wiped", new: bool(false) },
          { key: "wiped", new: bool(true) },
        ],
      }),
    ],
    [
      "a change this build does not know",
      protect(bool(true), {
        changes: [
          { key: "wiped", new: bool(true) },
          { key: "something_new", new: bool(true) },
        ],
      }),
    ],
    [
      "a count change",
      protect(bool(true), {
        changes: [
          { key: "wiped", new: bool(true) },
          { key: "count", new: int(3) },
        ],
      }),
    ],
    ["changes not a list", protect(bool(true), { changes: {} as never })],
    ["changes a string", protect(bool(true), { changes: "wiped" as never })],
    ["a null change", protect(bool(true), { changes: [null] as never })],
    [
      "a change without a key",
      protect(bool(true), { changes: [{ new: bool(true) }] as never }),
    ],
    [
      "boundary of the wrong type",
      protect(bool(true), {
        changes: [
          { key: "boundary", new: int(7) },
          { key: "wiped", new: bool(true) },
        ],
      }),
    ],
    [
      "boundary as a before/after pair",
      protect(bool(true), {
        changes: [
          { key: "boundary", old: str("01JOLD"), new: str(BOUNDARY) },
          { key: "wiped", new: bool(true) },
        ],
      }),
    ],
    // The entry around them
    ["no channel", protect(bool(true), { channel: undefined })],
    ["empty channel", protect(bool(true), { channel: "" })],
    ["channel not a string", protect(bool(true), { channel: 7 as never })],
    ["no actor", protect(bool(true), { actor: undefined })],
    ["a target", protect(bool(true), { target: CHANNEL })],
    ["a top-level count", protect(bool(true), { count: 3 })],
  ];
  for (const [name, bad] of unreadable) {
    const described = describeAuditEntry(bad);
    assert.equal(described.kind, "channel_protect", name);
    assert.equal(described.unknown, false, name);
    assert.equal(described.protectedDetail, undefined, name);
    assert.equal("protectedDetail" in described, false, name);
    assert.deepEqual(described.changes, [], name);
  }
});

test("U6: the wipe request has no count", () => {
  const described = describeAuditEntry(wipeRequest());
  assert.equal(described.kind, "channel_history_wipe");
  assert.deepEqual(described.protectedDetail, {
    action: "channel_history_wipe",
    channel: CHANNEL,
    count: null,
  });
  assert.deepEqual(
    describeAuditEntry(wipeRequest({ changes: [] })).protectedDetail,
    { action: "channel_history_wipe", channel: CHANNEL, count: null },
  );
});

test("U6: the finished wipe carries its count", () => {
  for (const count of [0, 12, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(describeAuditEntry(wipeDone(int(count))).protectedDetail, {
      action: "channel_history_wipe",
      channel: CHANNEL,
      count,
    });
  }
});

test("U6: a wipe count that is not a whole number has no detail", () => {
  const unreadable: [string, AuditLogEntryData][] = [
    ["Int holding a string", wipeDone(int("12"))],
    ["String 12", wipeDone(str("12"))],
    ["a bare number", wipeDone(12)],
    ["a fraction", wipeDone(int(1.5))],
    ["negative", wipeDone(int(-1))],
    ["beyond the safe integers", wipeDone(int(2 ** 53))],
    ["NaN", wipeDone(int(NaN))],
    ["Infinity", wipeDone(int(Infinity))],
    ["Int holding null", wipeDone(int(null))],
    ["Int holding true", wipeDone(int(true))],
    ["Bool", wipeDone(bool(true))],
    ["no value", wipeDone(undefined)],
    [
      "a before/after pair",
      wipeDone(int(12), {
        changes: [{ key: "count", old: int(0), new: int(12) }],
      }),
    ],
  ];
  for (const [name, bad] of unreadable) {
    const described = describeAuditEntry(bad);
    assert.equal(described.kind, "channel_history_wipe", name);
    assert.equal(described.protectedDetail, undefined, name);
    assert.deepEqual(described.changes, [], name);
  }
});

test("U6: a wipe entry that cannot be read has no detail", () => {
  const unreadable: [string, AuditLogEntryData][] = [
    ["a request without an actor", wipeRequest({ actor: undefined })],
    ["a request with an empty actor", wipeRequest({ actor: "" })],
    ["no channel", wipeRequest({ channel: undefined })],
    ["a finished wipe without a channel", wipeDone(int(3), { channel: "" })],
    ["a top-level count", wipeRequest({ count: 12 })],
    ["a top-level count beside the change", wipeDone(int(3), { count: 3 })],
    ["a target", wipeDone(int(3), { target: CHANNEL })],
    [
      "count twice",
      wipeDone(int(3), {
        changes: [
          { key: "count", new: int(3) },
          { key: "count", new: int(4) },
        ],
      }),
    ],
    [
      "a wiped change",
      wipeRequest({ changes: [{ key: "wiped", new: bool(true) }] }),
    ],
    [
      "a change this build does not know",
      wipeDone(int(3), {
        changes: [
          { key: "count", new: int(3) },
          { key: "something_new", new: int(1) },
        ],
      }),
    ],
    ["changes not a list", wipeRequest({ changes: { count: 3 } as never })],
    ["a null change", wipeRequest({ changes: [null] as never })],
  ];
  for (const [name, bad] of unreadable) {
    const described = describeAuditEntry(bad);
    assert.equal(described.protectedDetail, undefined, name);
    assert.deepEqual(described.changes, [], name);
    assert.equal("count" in described, false, name);
  }
});

test("U6: the request and the finished wipe stay two entries", () => {
  const request = {
    action: "channel_history_wipe",
    channel: CHANNEL,
    count: null,
  };
  const done = { action: "channel_history_wipe", channel: CHANNEL, count: 12 };
  // In either order, and again afterwards: one entry never borrows from the
  // other, though both name the same channel
  assert.deepEqual(describeAuditEntry(wipeRequest()).protectedDetail, request);
  assert.deepEqual(describeAuditEntry(wipeDone(int(12))).protectedDetail, done);
  assert.deepEqual(describeAuditEntry(wipeRequest()).protectedDetail, request);
  assert.deepEqual(describeAuditEntry(wipeDone(int(12))).protectedDetail, done);
  assert.deepEqual(
    [wipeDone(int(12)), wipeRequest(), wipeDone(int(0)), wipeRequest()].map(
      (each) => describeAuditEntry(each).protectedDetail,
    ),
    [done, request, { ...done, count: 0 }, request],
  );
});

test("U6: no model output contains the boundary", () => {
  const entries = [
    protect(bool(false)),
    protect(bool(true)),
    // Unreadable ones as well: the boundary must not leak through the raw
    // changes either
    protect(str("false")),
    protect(bool(true), {
      changes: [
        { key: "boundary", new: str(BOUNDARY) },
        { key: "wiped", new: bool(true) },
        { key: "something_new", new: str(BOUNDARY) },
      ],
    }),
  ];
  for (const each of entries) {
    const described = describeAuditEntry(each);
    assert.deepEqual(described.changes, []);
    assert.equal(JSON.stringify(described).includes(BOUNDARY), false);
    const args = protectedAuditCopyArgs(described.protectedDetail, {
      actor: "Ann",
      channel: "#general",
    });
    assert.equal(JSON.stringify(args).includes(BOUNDARY), false);
  }
  // The readable ones did produce something to check
  assert.ok(describeAuditEntry(entries[0]).protectedDetail);
});

test("U6: the action filter lists both protected actions after the channel actions", () => {
  assert.deepEqual(
    [...AUDIT_FILTER_ACTIONS],
    [
      "member_kick",
      "member_ban_add",
      "member_ban_remove",
      "member_timeout",
      "member_timeout_remove",
      "member_role_update",
      "member_update",
      "member_voice_update",
      "member_move",
      "member_disconnect",
      "message_delete",
      "message_bulk_delete",
      "channel_create",
      "channel_update",
      "channel_delete",
      "channel_overwrite_update",
      "channel_protect",
      "channel_history_wipe",
      "server_permissions_update",
      "role_create",
      "role_update",
      "role_delete",
      "role_ranks_update",
      "server_update",
      "server_owner_transfer",
    ],
  );
  assert.deepEqual(
    [...AUDIT_FILTER_ACTIONS].sort(),
    [...KNOWN_AUDIT_ACTIONS].sort(),
  );
});

const NAMES = { actor: "Ann", channel: "#general" };

test("U6: copy arguments carry resolved names and only the fields of their action", () => {
  assert.deepEqual(
    protectedAuditCopyArgs(
      { action: "channel_protect", channel: CHANNEL, wiped: false },
      NAMES,
    ),
    {
      action: "channel_protect",
      detail: { actor: "Ann", channel: "#general", wiped: false },
    },
  );
  assert.deepEqual(
    protectedAuditCopyArgs(
      { action: "channel_protect", channel: CHANNEL, wiped: true },
      NAMES,
    ),
    {
      action: "channel_protect",
      detail: { actor: "Ann", channel: "#general", wiped: true },
    },
  );
  assert.deepEqual(
    protectedAuditCopyArgs(
      { action: "channel_history_wipe", channel: CHANNEL, count: null },
      NAMES,
    ),
    {
      action: "channel_history_wipe",
      detail: { actor: "Ann", channel: "#general", count: null },
    },
  );
  assert.deepEqual(
    protectedAuditCopyArgs(
      { action: "channel_history_wipe", channel: CHANNEL, count: 12 },
      NAMES,
    ),
    {
      action: "channel_history_wipe",
      detail: { actor: "Ann", channel: "#general", count: 12 },
    },
  );
  // A detail that says `wiped` loosely is not passed on as true
  assert.equal(
    protectedAuditCopyArgs(
      { action: "channel_protect", channel: CHANNEL, wiped: "false" as never },
      NAMES,
    )?.detail.wiped,
    false,
  );
});

test("U6: an unreadable entry or a missing actor name gets no copy arguments", () => {
  const detail: AuditProtectedDetail = {
    action: "channel_history_wipe",
    channel: CHANNEL,
    count: 12,
  };
  assert.equal(protectedAuditCopyArgs(undefined, NAMES), null);
  assert.equal(
    protectedAuditCopyArgs(
      describeAuditEntry(protect(str("true"))).protectedDetail,
      NAMES,
    ),
    null,
  );
  assert.equal(
    protectedAuditCopyArgs(detail, { actor: "", channel: "#general" }),
    null,
  );
  // Not even to get the no-name sentence
  assert.equal(
    protectedAuditCopyArgs(undefined, { actor: "Ann", channel: undefined }),
    null,
  );
  assert.equal(
    protectedAuditCopyArgs(detail, { actor: "", channel: undefined }),
    null,
  );
});

test("FXO C13: a channel the client cannot name keeps the entry's fact and passes no channel, never the id", () => {
  const details: AuditProtectedDetail[] = [
    { action: "channel_protect", channel: CHANNEL, wiped: false },
    { action: "channel_protect", channel: CHANNEL, wiped: true },
    { action: "channel_history_wipe", channel: CHANNEL, count: null },
    { action: "channel_history_wipe", channel: CHANNEL, count: 12 },
  ];
  // Gone, blank, or the id itself: all read as "no name"
  for (const channel of [undefined, "", "   ", CHANNEL]) {
    for (const detail of details) {
      const args = protectedAuditCopyArgs(detail, { actor: "Ann", channel });
      const label = `${JSON.stringify(detail)} ${String(channel)}`;
      assert.ok(args, label);
      assert.equal(args.action, detail.action, label);
      assert.equal(JSON.stringify(args).includes(CHANNEL), false, label);
      // The fact is the one the entry carries
      assert.deepEqual(
        args.detail,
        detail.action === "channel_protect"
          ? { actor: "Ann", channel: null, wiped: detail.wiped }
          : { actor: "Ann", channel: null, count: detail.count },
        label,
      );
    }
  }
  // A name is still passed on as it is
  assert.equal(
    protectedAuditCopyArgs(details[0], NAMES)?.detail.channel,
    "#general",
  );
});

// ---- The page and the row (source cut out and run) ---------------------------

const PAGE_SRC = readFileSync(
  new URL("./AuditLogPage.tsx", import.meta.url),
  "utf8",
);
const ROW_SRC = readFileSync(
  new URL("./AuditEntryRow.tsx", import.meta.url),
  "utf8",
);
const MODEL_SRC = readFileSync(
  new URL("./auditEntryModel.ts", import.meta.url),
  "utf8",
);

/** Code without comments, so prose never counts */
function code(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** A function nested one level inside a component, up to its closing brace */
function innerFunction(source: string, name: string): string {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const end = source.indexOf("\n  }\n", start);
  assert.ok(end >= 0, `missing end of ${name}`);
  return stripTypeScriptTypes(source.slice(start, end + 4));
}

/** Stub for lingui's `t`: the message with its values filled in */
function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return "t:" + String.raw({ raw: strings }, ...values);
}

test("U6: the filter labels the protected actions through auditActionLabel", () => {
  const page = code(PAGE_SRC);
  assert.match(
    page,
    /import \{ auditActionLabel \} from "@revolt\/client\/protectedCopy";/,
  );
  const actionLabel = new Function(
    "t",
    "auditActionLabel",
    `${innerFunction(page, "actionLabel")}; return actionLabel;`,
  )(t, (action: string) => `copy:${action}`) as (action: string) => string;

  assert.equal(actionLabel("channel_protect"), "copy:channel_protect");
  assert.equal(
    actionLabel("channel_history_wipe"),
    "copy:channel_history_wipe",
  );
  // No known action is listed under its raw name
  for (const action of KNOWN_AUDIT_ACTIONS) {
    const label = actionLabel(action);
    assert.notEqual(label, action);
    const fromCopy =
      action === "channel_protect" || action === "channel_history_wipe";
    assert.equal(label.startsWith(fromCopy ? "copy:" : "t:"), true, action);
    assert.equal(label.includes(action), fromCopy, action);
  }
  // The select lists the filter order and labels every item
  assert.match(
    page,
    /<For each=\{AUDIT_FILTER_ACTIONS\}>\s*\{\(value\) => \(\s*<MenuItem value=\{value\}>\{actionLabel\(value\)\}<\/MenuItem>/,
  );
});

test("U6: the row renders the protected entries through auditCopy or the generic sentence", () => {
  const row = code(ROW_SRC);
  assert.match(
    row,
    /import \{ auditCopy \} from "@revolt\/client\/protectedCopy";/,
  );
  // Both actions go to the one helper and nowhere else
  assert.match(
    row,
    /case "channel_protect":\s*case "channel_history_wipe":\s*return protectedSentence\(actor\);/,
  );
  assert.equal(row.split('"channel_protect"').length, 2);
  assert.equal(row.split('"channel_history_wipe"').length, 2);
  assert.equal(row.split("auditCopy(").length, 2);

  const names = new Map([[CHANNEL, "general"]]);
  const calls: unknown[] = [];
  /** Run the row's helper for one entry */
  function sentence(each: AuditLogEntryData): string {
    const described = describeAuditEntry(each);
    const helper = new Function(
      "descriptor",
      "client",
      "protectedAuditCopyArgs",
      "auditCopy",
      "t",
      `${innerFunction(row, "protectedSentence")}; return protectedSentence;`,
    )(
      () => described,
      () => ({
        channels: {
          get: (id: string) =>
            names.has(id) ? { name: names.get(id) } : undefined,
        },
      }),
      protectedAuditCopyArgs,
      (action: string, detail: unknown) => {
        calls.push([action, detail]);
        return `copy:${action}:${JSON.stringify(detail)}`;
      },
      t,
    ) as (actor: string) => string;
    return helper("Ann");
  }

  const GENERIC = "t:Ann performed an action";
  assert.equal(
    sentence(protect(bool(false))),
    'copy:channel_protect:{"actor":"Ann","channel":"#general","wiped":false}',
  );
  assert.equal(
    sentence(protect(bool(true))),
    'copy:channel_protect:{"actor":"Ann","channel":"#general","wiped":true}',
  );
  assert.equal(
    sentence(wipeRequest()),
    'copy:channel_history_wipe:{"actor":"Ann","channel":"#general","count":null}',
  );
  assert.equal(
    sentence(wipeDone(int(12))),
    'copy:channel_history_wipe:{"actor":"Ann","channel":"#general","count":12}',
  );
  assert.equal(
    sentence(wipeDone(int(0))),
    'copy:channel_history_wipe:{"actor":"Ann","channel":"#general","count":0}',
  );
  assert.equal(calls.length, 5);

  // Unreadable entries: the generic sentence, and the copy is never asked
  for (const bad of [
    protect(str("false")),
    protect(str("true")),
    protect(bool(true), { changes: undefined }),
    protect(bool(true), { channel: undefined }),
    wipeDone(int("12")),
    wipeDone(int(1.5)),
    wipeRequest({ actor: undefined }),
    wipeRequest({ count: 12 }),
  ]) {
    assert.equal(sentence(bad), GENERIC);
  }
  assert.equal(calls.length, 5);
  // A channel the client cannot name (a deleted one): the entry's fact with
  // no channel, never the generic sentence and never the id (C13)
  const elsewhere = "01JGONE0000000000000000000";
  assert.equal(
    sentence(protect(bool(true), { channel: elsewhere })),
    'copy:channel_protect:{"actor":"Ann","channel":null,"wiped":true}',
  );
  assert.equal(
    sentence(protect(bool(false), { channel: elsewhere })),
    'copy:channel_protect:{"actor":"Ann","channel":null,"wiped":false}',
  );
  assert.equal(
    sentence(wipeRequest({ channel: elsewhere })),
    'copy:channel_history_wipe:{"actor":"Ann","channel":null,"count":null}',
  );
  assert.equal(
    sentence(wipeDone(int(3), { channel: elsewhere })),
    'copy:channel_history_wipe:{"actor":"Ann","channel":null,"count":3}',
  );
  names.set(elsewhere, "");
  assert.equal(
    sentence(wipeDone(int(3), { channel: elsewhere })),
    'copy:channel_history_wipe:{"actor":"Ann","channel":null,"count":3}',
  );
  assert.equal(calls.length, 10);
  assert.equal(JSON.stringify(calls).includes(elsewhere), false);
  // An unreadable entry of a deleted channel is still the generic sentence
  assert.equal(sentence(protect(str("true"), { channel: elsewhere })), GENERIC);
  assert.equal(calls.length, 10);
});

test("U6: no W4-0 placeholder is left in the audit log files", () => {
  // Split so this spec is not itself a hit for the marker
  const marker = ["S4-W4-0", "placeholder"].join(" ");
  for (const source of [PAGE_SRC, ROW_SRC, MODEL_SRC]) {
    assert.equal(source.includes(marker), false);
  }
});
