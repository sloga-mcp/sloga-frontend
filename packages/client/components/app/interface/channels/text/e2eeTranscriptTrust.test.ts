// Unit spec for the encrypted-transcript trust helpers, run with Node's
// built-in runner from packages/client:
//   node --conditions=browser --test components/app/interface/channels/text/e2eeTranscriptTrust.test.ts
//
// In an encrypted DM or group only rows this device decrypted (the trusted
// set) may render. `conversationTrust` maps the conversation's send mode to a
// trust level, `splitUntrusted` drops untrusted rows and counts the ones that
// deserve a "message hidden" marker, and `restorableForTrust` decides whether
// a MessageCache entry may be restored without a refetch. An "unknown" mode
// refuses an entry holding untrusted rows but never counts a marker for it.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ConversationTrust,
  type TrustChannel,
  type TrustE2EE,
  channelTrust,
  conversationTrust,
  restorableForTrust,
  serverActionsBlocked,
  splitUntrusted,
} from "./e2eeTranscriptTrust.ts";

/** A row reduced to what the helpers read plus one unrelated field, so
 * identity is checked on real objects, not copies. */
type Row = { id: string; systemMessage?: unknown; body: string };

/** The shape MessageCache stores, reduced the same way. */
type Entry = { messages: Row[]; atEnd: boolean };

const TRUSTED = ["01TRUST001", "01TRUST002", "01TRUST003"];
const FORGED = "01FORGED01";
const FORGED_SYSTEM = "01FORGEDSY";

function row(id: string, system = false): Row {
  return system
    ? { id, systemMessage: { type: "text" }, body: "" }
    : { id, body: "" };
}

function entryOf(rows: Row[]): Entry {
  return { messages: rows, atEnd: true };
}

const isTrusted = (id: string) => TRUSTED.includes(id);

// conversationTrust

const base = {
  hasE2EE: true,
  isConversation: true,
  conversationId: "01PEER0001",
} as const;

test("conversationTrust: no E2EE on this device is not_e2ee, whatever the mode", () => {
  assert.equal(
    conversationTrust({ ...base, hasE2EE: false, mode: "encrypt" }),
    "not_e2ee",
  );
});

test("conversationTrust: a non-conversation channel is not_e2ee, whatever the mode", () => {
  assert.equal(
    conversationTrust({ ...base, isConversation: false, mode: "encrypt" }),
    "not_e2ee",
  );
});

test("conversationTrust: an undefined conversation id is unknown, even with a mode", () => {
  assert.equal(
    conversationTrust({ ...base, conversationId: undefined, mode: "encrypt" }),
    "unknown",
  );
});

test("conversationTrust: an empty conversation id is unknown, even with a mode", () => {
  assert.equal(
    conversationTrust({ ...base, conversationId: "", mode: "encrypt" }),
    "unknown",
  );
});

test("conversationTrust: no recorded mode is unknown", () => {
  assert.equal(conversationTrust({ ...base, mode: undefined }), "unknown");
});

test("conversationTrust: plaintext mode is plaintext", () => {
  assert.equal(conversationTrust({ ...base, mode: "plaintext" }), "plaintext");
});

test("conversationTrust: encrypt, blocked and peer_downgraded are all encrypted", () => {
  assert.equal(conversationTrust({ ...base, mode: "encrypt" }), "encrypted");
  assert.equal(conversationTrust({ ...base, mode: "blocked" }), "encrypted");
  assert.equal(
    conversationTrust({ ...base, mode: "peer_downgraded" }),
    "encrypted",
  );
});

// splitUntrusted

test("splitUntrusted: keeps trusted rows in order and counts untrusted non-system rows", () => {
  const rows = [
    row(TRUSTED[0]),
    row(FORGED),
    row(TRUSTED[1]),
    row("01FORGED02"),
    row(TRUSTED[2]),
  ];
  const result = splitUntrusted(rows, isTrusted);

  assert.deepEqual(
    result.trusted.map((r) => r.id),
    TRUSTED,
  );
  assert.strictEqual(result.trusted[0], rows[0]);
  assert.strictEqual(result.trusted[1], rows[2]);
  assert.strictEqual(result.trusted[2], rows[4]);
  assert.equal(result.hiddenVisible, 2);
});

test("splitUntrusted: untrusted system rows are dropped without being counted", () => {
  const rows = [row(TRUSTED[0]), row(FORGED_SYSTEM, true), row(FORGED)];
  const result = splitUntrusted(rows, isTrusted);

  assert.deepEqual(
    result.trusted.map((r) => r.id),
    [TRUSTED[0]],
  );
  assert.equal(result.hiddenVisible, 1);
});

test("splitUntrusted: trusted system rows are kept", () => {
  const rows = [row(TRUSTED[0], true), row(TRUSTED[1])];
  const result = splitUntrusted(rows, isTrusted);

  assert.deepEqual(result.trusted, rows);
  assert.equal(result.hiddenVisible, 0);
});

test("splitUntrusted: an all-trusted list returns a new array with every row", () => {
  const rows = TRUSTED.map((id) => row(id));
  const result = splitUntrusted(rows, isTrusted);

  assert.notStrictEqual(result.trusted, rows);
  assert.deepEqual(result.trusted, rows);
  assert.equal(result.hiddenVisible, 0);
});

test("splitUntrusted: empty input gives an empty list and zero", () => {
  const result = splitUntrusted([] as Row[], isTrusted);

  assert.deepEqual(result.trusted, []);
  assert.equal(result.hiddenVisible, 0);
});

// restorableForTrust: 4 trust values x 4 entry shapes

type Shape = "all trusted" | "untrusted non-system" | "untrusted system";

function entryForShape(shape: Shape): Entry {
  switch (shape) {
    case "all trusted":
      return entryOf(TRUSTED.map((id) => row(id)));
    case "untrusted non-system":
      return entryOf([row(TRUSTED[0]), row(FORGED), row(TRUSTED[1])]);
    case "untrusted system":
      return entryOf([row(TRUSTED[0]), row(FORGED_SYSTEM, true)]);
  }
}

/** Expected outcome per trust value and shape: whether the same entry
 * object comes back, and the marker count. */
const EXPECTED: Record<
  ConversationTrust,
  Record<Shape, { restored: boolean; hiddenVisible: number }>
> = {
  not_e2ee: {
    "all trusted": { restored: true, hiddenVisible: 0 },
    "untrusted non-system": { restored: true, hiddenVisible: 0 },
    "untrusted system": { restored: true, hiddenVisible: 0 },
  },
  plaintext: {
    "all trusted": { restored: true, hiddenVisible: 0 },
    "untrusted non-system": { restored: true, hiddenVisible: 0 },
    "untrusted system": { restored: true, hiddenVisible: 0 },
  },
  encrypted: {
    "all trusted": { restored: true, hiddenVisible: 0 },
    "untrusted non-system": { restored: false, hiddenVisible: 1 },
    "untrusted system": { restored: false, hiddenVisible: 0 },
  },
  unknown: {
    "all trusted": { restored: true, hiddenVisible: 0 },
    "untrusted non-system": { restored: false, hiddenVisible: 0 },
    "untrusted system": { restored: false, hiddenVisible: 0 },
  },
};

const TRUSTS: ConversationTrust[] = [
  "not_e2ee",
  "plaintext",
  "encrypted",
  "unknown",
];
const SHAPES: Shape[] = [
  "all trusted",
  "untrusted non-system",
  "untrusted system",
];

for (const trust of TRUSTS) {
  for (const shape of SHAPES) {
    const want = EXPECTED[trust][shape];
    test(`restorableForTrust: ${trust} + ${shape} -> ${
      want.restored ? "same entry" : "refused"
    }, hiddenVisible ${want.hiddenVisible}`, () => {
      const entry = entryForShape(shape);
      const result = restorableForTrust(entry, trust, isTrusted);

      if (want.restored) {
        assert.strictEqual(result.entry, entry);
      } else {
        assert.strictEqual(result.entry, undefined);
      }
      assert.equal(result.hiddenVisible, want.hiddenVisible);
    });
  }

  test(`restorableForTrust: ${trust} + undefined entry -> undefined, 0, isTrusted not consulted`, () => {
    const calls: string[] = [];
    const result = restorableForTrust<Entry>(undefined, trust, (id) => {
      calls.push(id);
      return isTrusted(id);
    });

    assert.strictEqual(result.entry, undefined);
    assert.equal(result.hiddenVisible, 0);
    assert.deepEqual(calls, []);
  });
}

test("restorableForTrust: encrypted counts every untrusted non-system row and skips system ones", () => {
  const entry = entryOf([
    row(FORGED),
    row(TRUSTED[0]),
    row("01FORGED02"),
    row(FORGED_SYSTEM, true),
  ]);
  const result = restorableForTrust(entry, "encrypted", isTrusted);

  assert.strictEqual(result.entry, undefined);
  assert.equal(result.hiddenVisible, 2);
});

test("restorableForTrust: an empty entry is restored under every trust value", () => {
  for (const trust of TRUSTS) {
    const entry = entryOf([]);
    const result = restorableForTrust(entry, trust, isTrusted);

    assert.strictEqual(result.entry, entry);
    assert.equal(result.hiddenVisible, 0);
  }
});

// channelTrust and serverActionsBlocked: the per-conversation gate for Edit,
// React, poll votes and reservations

const SELF = "01SELF0001";
const PEER = "01PEER0001";
const GROUP = "01GROUP001";

type Mode = "encrypt" | "blocked" | "plaintext" | "peer_downgraded";
type Status = { enabled: boolean; published: boolean };

const ENABLED: Status = { enabled: true, published: true };

/** A fake controller backed by plain Maps. "not loaded" makes the status
 * read return undefined, as it does before the first native status call.
 * It is a token rather than `undefined`, which would select the default. */
function fakeE2EE(
  modes: Record<string, Mode>,
  status: Status | "not loaded" = ENABLED,
): TrustE2EE {
  const sendModes = new Map(Object.entries(modes));
  const state = status === "not loaded" ? undefined : status;
  return {
    sendModes: { get: (id) => sendModes.get(id) },
    status: { get: () => state },
  };
}

/** A DM whose recipient list puts self FIRST, so a derivation that does not
 * exclude self keys the conversation on the wrong id. */
function dm(peerE2EEEnabled = true, recipients = [SELF, PEER]): TrustChannel {
  return {
    id: "01DMCHAN01",
    type: "DirectMessage",
    recipientIds: new Set(recipients),
    recipient: { e2eeEnabled: peerE2EEEnabled },
  };
}

function group(): TrustChannel {
  return {
    id: GROUP,
    type: "Group",
    recipientIds: new Set([SELF, PEER]),
    recipient: undefined,
  };
}

function serverChannel(): TrustChannel {
  return {
    id: "01TEXTCH01",
    type: "TextChannel",
    recipientIds: new Set(),
  };
}

test("channelTrust: a DM is keyed on the peer, never on self", () => {
  assert.equal(
    channelTrust(fakeE2EE({ [PEER]: "encrypt" }), dm(), SELF),
    "encrypted",
  );
  // A mode recorded under self's id must not be picked up.
  assert.equal(
    channelTrust(fakeE2EE({ [SELF]: "encrypt" }), dm(), SELF),
    "unknown",
  );
});

test("channelTrust: a group is keyed on the channel id", () => {
  assert.equal(
    channelTrust(fakeE2EE({ [GROUP]: "encrypt" }), group(), SELF),
    "encrypted",
  );
  assert.equal(
    channelTrust(fakeE2EE({ [PEER]: "encrypt" }), group(), SELF),
    "unknown",
  );
});

test("channelTrust: a server channel is not_e2ee, whatever is recorded", () => {
  const channel = serverChannel();
  assert.equal(
    channelTrust(fakeE2EE({ [channel.id]: "encrypt" }), channel, SELF),
    "not_e2ee",
  );
});

test("channelTrust: no E2EE on this device is not_e2ee, with or without a channel", () => {
  assert.equal(channelTrust(undefined, dm(), SELF), "not_e2ee");
  assert.equal(channelTrust(undefined, undefined, SELF), "not_e2ee");
});

test("channelTrust: E2EE present but no channel is unknown", () => {
  assert.equal(
    channelTrust(fakeE2EE({ [PEER]: "plaintext" }), undefined, SELF),
    "unknown",
  );
});

test("channelTrust: a DM with no other recipient is unknown", () => {
  const e2ee = fakeE2EE({ [SELF]: "plaintext" });
  assert.equal(channelTrust(e2ee, dm(true, [SELF]), SELF), "unknown");
  assert.equal(channelTrust(e2ee, dm(true, []), SELF), "unknown");
});

test("channelTrust: every send mode maps as conversationTrust does", () => {
  const cases: [Mode | undefined, ConversationTrust][] = [
    ["encrypt", "encrypted"],
    ["blocked", "encrypted"],
    ["peer_downgraded", "encrypted"],
    ["plaintext", "plaintext"],
    [undefined, "unknown"],
  ];
  for (const [mode, want] of cases) {
    const modes: Record<string, Mode> = mode
      ? { [PEER]: mode, [GROUP]: mode }
      : {};
    assert.equal(channelTrust(fakeE2EE(modes), dm(), SELF), want, `DM ${mode}`);
    assert.equal(
      channelTrust(fakeE2EE(modes), group(), SELF),
      want,
      `group ${mode}`,
    );
  }
});

test("serverActionsBlocked: no E2EE on this device is never blocked", () => {
  assert.equal(serverActionsBlocked(undefined, dm(), SELF), false);
  assert.equal(serverActionsBlocked(undefined, group(), SELF), false);
  assert.equal(serverActionsBlocked(undefined, undefined, SELF), false);
});

test("serverActionsBlocked: not_e2ee is allowed", () => {
  assert.equal(
    serverActionsBlocked(fakeE2EE({}), serverChannel(), SELF),
    false,
  );
});

test("serverActionsBlocked: encrypted is blocked for every encrypted mode", () => {
  for (const mode of ["encrypt", "blocked", "peer_downgraded"] as const) {
    assert.equal(
      serverActionsBlocked(fakeE2EE({ [PEER]: mode }), dm(), SELF),
      true,
      `DM ${mode}`,
    );
    assert.equal(
      serverActionsBlocked(fakeE2EE({ [GROUP]: mode }), group(), SELF),
      true,
      `group ${mode}`,
    );
  }
});

test("serverActionsBlocked: unknown is blocked while E2EE is enabled, published or not", () => {
  for (const status of [ENABLED, { enabled: true, published: false }]) {
    const e2ee = fakeE2EE({}, status);
    assert.equal(serverActionsBlocked(e2ee, dm(), SELF), true);
    assert.equal(serverActionsBlocked(e2ee, group(), SELF), true);
    assert.equal(serverActionsBlocked(e2ee, undefined, SELF), true);
  }
});

test("serverActionsBlocked: unknown is blocked while the status has not loaded", () => {
  const e2ee = fakeE2EE({}, "not loaded");
  assert.equal(e2ee.status.get("state"), undefined);
  assert.equal(serverActionsBlocked(e2ee, dm(), SELF), true);
  assert.equal(serverActionsBlocked(e2ee, group(), SELF), true);
  assert.equal(serverActionsBlocked(e2ee, undefined, SELF), true);
});

test("serverActionsBlocked: unknown is allowed when E2EE is off on this device", () => {
  // With E2EE off the controller never records a mode, so unknown never
  // clears; blocking it would take Edit and React away from every DM.
  const e2ee = fakeE2EE({}, { enabled: false, published: false });
  assert.equal(serverActionsBlocked(e2ee, dm(), SELF), false);
  assert.equal(serverActionsBlocked(e2ee, group(), SELF), false);
  assert.equal(serverActionsBlocked(e2ee, undefined, SELF), false);
});

test("serverActionsBlocked: a plaintext DM in the composer's pending state is blocked", () => {
  const e2ee = fakeE2EE({ [PEER]: "plaintext" }, ENABLED);
  assert.equal(serverActionsBlocked(e2ee, dm(true), SELF), true);
});

test("serverActionsBlocked: a plaintext DM whose peer has not opted in is allowed", () => {
  const e2ee = fakeE2EE({ [PEER]: "plaintext" }, ENABLED);
  assert.equal(serverActionsBlocked(e2ee, dm(false), SELF), false);
  const noRecipient = { ...dm(), recipient: undefined };
  assert.equal(serverActionsBlocked(e2ee, noRecipient, SELF), false);
});

test("serverActionsBlocked: a plaintext DM is allowed when self is not enabled and published", () => {
  const statuses: (Status | "not loaded")[] = [
    { enabled: false, published: false },
    { enabled: false, published: true },
    { enabled: true, published: false },
    "not loaded",
  ];
  for (const status of statuses) {
    const e2ee = fakeE2EE({ [PEER]: "plaintext" }, status);
    assert.equal(
      serverActionsBlocked(e2ee, dm(true), SELF),
      false,
      JSON.stringify(status),
    );
  }
});

test("serverActionsBlocked: a plaintext group is allowed, since groups never show pending", () => {
  const e2ee = fakeE2EE({ [GROUP]: "plaintext" }, ENABLED);
  const optedIn = { ...group(), recipient: { e2eeEnabled: true } };
  assert.equal(serverActionsBlocked(e2ee, group(), SELF), false);
  assert.equal(serverActionsBlocked(e2ee, optedIn, SELF), false);
});
