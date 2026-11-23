// Unit spec for the dialogs' Encrypted-only decisions. Run with Node's
// built-in runner:
//   node --conditions=browser --test components/modal/modals/encryptedOnlyModals.test.ts
// Focus: no dialog offers a way out of encryption under the latch or where
// an unencrypted send is refused; a dialog refuses every decision but the
// two that let a write through; the group rules (who marks a group, the cap
// of 24 with the creator, encryption for everyone, no bots, no
// Encrypted-only person in an unmarked group) match the server's.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Decision,
  type PlainWriteInput,
  E2EE_GROUP_MAX,
  decidePlainWrite,
} from "../../client/encryptedOnlyPolicy.ts";

import {
  type Candidate,
  addRefusal,
  blocksWrite,
  checkNewGroup,
  groupIsMarked,
  newGroupMarked,
  offersPlaintextExit,
  refusalSide,
  roomLeft,
  writeRefusal,
} from "./encryptedOnlyModals.ts";

const ALL: Decision[] = [
  "send-encrypted",
  "block-setup",
  "block-open-app",
  "block-peer",
  "block-group",
  "confirm-peer-changed",
  "allow-plain",
];

const facts = (over: Partial<PlainWriteInput> = {}): PlainWriteInput => ({
  latched: false,
  channel: "dm",
  peerFlag: "absent",
  peerRemembered: false,
  groupMarked: false,
  groupRemembered: false,
  device: "ready",
  encrypted: false,
  advert: "enforced",
  ...over,
});

const person = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  encrypted: true,
  encryptedOnly: false,
  bot: false,
  ...over,
});

const people = (count: number, over: Partial<Candidate> = {}) =>
  Array.from({ length: count }, (_, i) => person(`u${i}`, over));

test("the cap is 24", () => {
  assert.equal(E2EE_GROUP_MAX, 24);
});

test("no way out of encryption under the latch, whatever the decision", () => {
  for (const decision of [...ALL, null]) {
    assert.equal(offersPlaintextExit(true, decision), false, String(decision));
  }
});

test("without the latch the way out follows the policy", () => {
  assert.equal(offersPlaintextExit(false, null), true);
  assert.equal(offersPlaintextExit(false, "allow-plain"), true);
  assert.equal(offersPlaintextExit(false, "confirm-peer-changed"), true);
  for (const decision of [
    "block-setup",
    "block-open-app",
    "block-peer",
    "block-group",
    "send-encrypted",
  ] as const) {
    assert.equal(offersPlaintextExit(false, decision), false, decision);
  }
});

test("a peer with the flag or a marked group gets no way out", () => {
  const peer = facts({ peerFlag: "on" });
  assert.equal(offersPlaintextExit(false, decidePlainWrite(peer)), false);
  const group = facts({ channel: "group", groupMarked: true });
  assert.equal(offersPlaintextExit(false, decidePlainWrite(group)), false);
  const remembered = facts({ channel: "group", groupRemembered: true });
  assert.equal(offersPlaintextExit(false, decidePlainWrite(remembered)), false);
  assert.equal(offersPlaintextExit(false, decidePlainWrite(facts())), true);
});

test("a dialog lets through only an allowed or encrypted write", () => {
  for (const decision of ALL) {
    assert.equal(
      blocksWrite(decision),
      decision !== "allow-plain" && decision !== "send-encrypted",
      decision,
    );
  }
  assert.equal(blocksWrite("confirm-peer-changed"), true);
});

test("forward, schedule and poll are refused with the policy's reason", () => {
  for (const kind of ["forward", "schedule", "poll"] as const) {
    assert.equal(writeRefusal(kind, facts()), null, kind);
    assert.equal(
      writeRefusal(kind, facts({ channel: "server", latched: true })),
      null,
    );
    assert.equal(
      writeRefusal(kind, facts({ channel: "saved", latched: true })),
      null,
    );
    assert.equal(writeRefusal(kind, facts({ latched: true })), "sender", kind);
    // An encrypted chat does not let a plain write through under the latch
    assert.equal(
      writeRefusal(kind, facts({ latched: true, encrypted: true })),
      "sender",
      kind,
    );
    assert.equal(
      writeRefusal(kind, facts({ latched: true, device: "web" })),
      "open-app",
    );
    assert.equal(
      writeRefusal(kind, facts({ latched: true, device: "not-set-up" })),
      "setup",
    );
    assert.equal(writeRefusal(kind, facts({ peerFlag: "on" })), "recipient");
    assert.equal(
      writeRefusal(kind, facts({ peerRemembered: true })),
      "peer-changed",
    );
    assert.equal(
      writeRefusal(kind, facts({ channel: "group", groupMarked: true })),
      "group",
    );
    assert.equal(
      writeRefusal(kind, facts({ channel: "group", latched: true })),
      "sender",
    );
  }
});

test("a send goes ahead encrypted, and a remembered peer waits for the composer", () => {
  assert.equal(
    writeRefusal("send", facts({ latched: true, encrypted: true })),
    null,
  );
  assert.equal(writeRefusal("send", facts({ latched: true })), "sender");
  assert.equal(
    writeRefusal("send", facts({ peerRemembered: true })),
    "peer-changed",
  );
  assert.equal(writeRefusal("send", facts()), null);
});

test("a group is marked by its mark or by memory, never outside a group", () => {
  assert.equal(groupIsMarked(facts({ channel: "group" })), false);
  assert.equal(
    groupIsMarked(facts({ channel: "group", groupMarked: true })),
    true,
  );
  assert.equal(
    groupIsMarked(facts({ channel: "group", groupRemembered: true })),
    true,
  );
  assert.equal(
    groupIsMarked(facts({ channel: "dm", groupMarked: true })),
    false,
  );
});

test("a new group is marked by its creator or anyone picked", () => {
  assert.equal(newGroupMarked(false, people(3)), false);
  assert.equal(newGroupMarked(true, []), true);
  assert.equal(
    newGroupMarked(false, [person("a"), person("b", { encryptedOnly: true })]),
    true,
  );
});

test("an unmarked new group is never refused here", () => {
  const result = checkNewGroup({
    marked: false,
    device: "web",
    members: people(40, { encrypted: false }),
  });
  assert.deepEqual(result, { refusal: null, withoutEncryption: [] });
});

test("a marked new group takes 23 picked people, not 24", () => {
  const ok = checkNewGroup({
    marked: true,
    device: "ready",
    members: people(E2EE_GROUP_MAX - 1),
  });
  assert.equal(ok.refusal, null);
  const full = checkNewGroup({
    marked: true,
    device: "ready",
    members: people(E2EE_GROUP_MAX),
  });
  assert.equal(full.refusal, "too_many");
});

test("a marked new group lists and refuses people without encryption and bots", () => {
  const result = checkNewGroup({
    marked: true,
    device: "ready",
    members: [
      person("a"),
      person("b", { encrypted: false }),
      person("c", { bot: true }),
    ],
  });
  assert.equal(result.refusal, "no_encryption");
  assert.deepEqual(result.withoutEncryption, ["b", "c"]);
});

test("a marked new group needs this device to encrypt, and still lists", () => {
  const members = [person("a", { encrypted: false })];
  const web = checkNewGroup({ marked: true, device: "web", members });
  assert.equal(web.refusal, "open-app");
  assert.deepEqual(web.withoutEncryption, ["a"]);
  const setup = checkNewGroup({ marked: true, device: "not-set-up", members });
  assert.equal(setup.refusal, "setup");
});

test("room left counts this account and never goes negative", () => {
  assert.equal(roomLeft(false, 99), Number.POSITIVE_INFINITY);
  assert.equal(roomLeft(true, 1), E2EE_GROUP_MAX - 1);
  assert.equal(roomLeft(true, E2EE_GROUP_MAX), 0);
  assert.equal(roomLeft(true, E2EE_GROUP_MAX + 3), 0);
});

test("adding to a marked group: cap, encryption, bots", () => {
  const base = { marked: true, groupSize: E2EE_GROUP_MAX - 1 };
  assert.equal(addRefusal({ ...base, member: person("a") }), null);
  assert.equal(
    addRefusal({ ...base, groupSize: E2EE_GROUP_MAX, member: person("a") }),
    "too_many",
  );
  assert.equal(
    addRefusal({ ...base, member: person("a", { encrypted: false }) }),
    "no_encryption",
  );
  assert.equal(
    addRefusal({ ...base, member: person("a", { bot: true }) }),
    "no_encryption",
  );
  assert.equal(
    addRefusal({ ...base, member: person("a", { encryptedOnly: true }) }),
    null,
  );
});

test("group refusals carry the server's sides", () => {
  assert.equal(refusalSide("too_many"), "member");
  assert.equal(refusalSide("no_encryption"), "member");
  assert.equal(refusalSide("recipient"), "recipient");
  assert.equal(refusalSide("setup"), "setup");
  assert.equal(refusalSide("open-app"), "open-app");
});

test("adding to an unmarked group refuses only an Encrypted-only person", () => {
  const base = { marked: false, groupSize: 80 };
  assert.equal(
    addRefusal({ ...base, member: person("a", { encrypted: false }) }),
    null,
  );
  assert.equal(
    addRefusal({ ...base, member: person("a", { encryptedOnly: true }) }),
    "recipient",
  );
});
