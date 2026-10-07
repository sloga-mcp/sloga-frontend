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
  conversationTrust,
  restorableForTrust,
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
