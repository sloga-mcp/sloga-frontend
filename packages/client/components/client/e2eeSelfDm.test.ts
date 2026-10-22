// Unit spec for the note-to-self guard on the E2EE DM lookup - run with
// Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeSelfDm.test.ts
// Focus: native files own-account device rows under note-to-self, whose
// conversation id is our own id. Every DM and group contains us, so a
// recipient match on our own id must never resolve to a channel (it used to
// return the first cached DM, and the rows were injected there). A peer id
// resolves to the DM with that peer only, never to a group they are in. The
// last tests pin the wiring in `e2ee.ts` (`#dmChannel`, `#syncRecent`,
// `#syncRecentConversation`) and in `E2EEVerify.tsx`'s turn-off path;
// `E2EE_SELFDM_TS` / `E2EE_VERIFY_TSX` point them at other copies for
// controls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type DmCandidate,
  isNoteToSelfConversation,
  resolveDmConversation,
} from "./e2eeSelfDm.ts";

const SELF = "01KYSELF000000000000000000";
const ALICE = "01KYALICE00000000000000000";
const BOB = "01KYBOB0000000000000000000";
const CAROL = "01KYCAROL00000000000000000";
const GROUP = "01KYGROUP00000000000000000";

type Fake = DmCandidate & { id: string };

const dm = (id: string, peer: string): Fake => ({
  id,
  type: "DirectMessage",
  recipientIds: new Set([SELF, peer]),
});
const group = (id: string, members: string[]): Fake => ({
  id,
  type: "Group",
  recipientIds: new Set([SELF, ...members]),
});

/** Cache order matters: the first DM is the one the old lookup returned. */
const CHANNELS: Fake[] = [
  group(GROUP, [ALICE, BOB, CAROL]),
  dm("dm-alice", ALICE),
  dm("dm-bob", BOB),
];

test("(1) our own id resolves to no channel, though every channel has us", () => {
  assert.ok(CHANNELS.every((c) => c.recipientIds.has(SELF)));
  assert.deepEqual(resolveDmConversation(SELF, SELF, CHANNELS), {
    kind: "none",
  });
  assert.equal(isNoteToSelfConversation(SELF, SELF), true);
});

test("(2) our own id never falls through to opening a DM", () => {
  assert.deepEqual(resolveDmConversation(SELF, SELF, []), { kind: "none" });
});

test("(3) a peer resolves to the DM with that peer, not the first DM", () => {
  const r = resolveDmConversation(BOB, SELF, CHANNELS);
  assert.equal(r.kind, "existing");
  assert.equal(r.kind === "existing" && r.channel.id, "dm-bob");
  const a = resolveDmConversation(ALICE, SELF, CHANNELS);
  assert.equal(a.kind === "existing" && a.channel.id, "dm-alice");
  assert.equal(isNoteToSelfConversation(BOB, SELF), false);
});

test("(4) a peer in a group but with no cached DM opens one, never the group", () => {
  assert.deepEqual(resolveDmConversation(CAROL, SELF, CHANNELS), {
    kind: "open",
  });
});

test("(5) a group conversation is not note-to-self and never maps to a DM", () => {
  assert.equal(isNoteToSelfConversation(GROUP, SELF), false);
  const r = resolveDmConversation(GROUP, SELF, CHANNELS);
  assert.notEqual(r.kind, "none");
  assert.notEqual(r.kind, "existing");
});

test("(6) an unknown local user or an empty id resolves to nothing (fail closed)", () => {
  assert.deepEqual(resolveDmConversation(BOB, undefined, CHANNELS), {
    kind: "none",
  });
  assert.deepEqual(resolveDmConversation("", SELF, CHANNELS), {
    kind: "none",
  });
  assert.equal(isNoteToSelfConversation(BOB, undefined), true);
  assert.equal(isNoteToSelfConversation("", SELF), true);
  assert.equal(isNoteToSelfConversation(BOB, ""), true);
});

// ---- wiring in e2ee.ts ----

const E2EE_TS =
  process.env.E2EE_SELFDM_TS ?? new URL("./e2ee.ts", import.meta.url);
const source = readFileSync(E2EE_TS, "utf8");

/** A class method's text, from its signature to its closing brace. */
function method(signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found`);
  const end = source.indexOf("\n  }\n", start);
  assert.notEqual(end, -1, `${signature} has no end`);
  return source.slice(start, end);
}

test("(7) #dmChannel resolves through the guard and stops on note-to-self", () => {
  const body = method("async #dmChannel(");
  assert.match(
    body,
    /resolveDmConversation\(\s*peerId,\s*this\.#client\.user\?\.id,/,
  );
  assert.match(body, /if \(resolved\.kind === "none"\) return undefined;/);
  assert.ok(
    body.indexOf('resolved.kind === "none"') < body.indexOf(".openDM("),
    "the note-to-self return must come before the DM open",
  );
});

test("(8) no other recipient-match DM lookup exists in e2ee.ts", () => {
  // The group include's member-list checks are not DM lookups: the method is
  // group-only, refused for anything else before it reads the list.
  const groupInclude = method("async addGroupMemberEncrypted(");
  assert.match(
    groupInclude,
    /if \(channel\.type !== "Group"\) throw new Error\("not a group"\);/,
  );
  const rest = source.replace(groupInclude, "");
  assert.equal(rest.match(/recipientIds\.has\(/g)?.length ?? 0, 0);
});

test("(9) #syncRecent returns before any lookup or history read on note-to-self", () => {
  const body = method("async #syncRecent(");
  const guard = body.search(
    /if \(isNoteToSelfConversation\(peerId, this\.#client\.user\?\.id\)\) \{\s*return \{ rows: \[\] \};\s*\}/,
  );
  assert.notEqual(guard, -1, "guard missing");
  assert.ok(guard < body.indexOf("this.#dmChannel("));
  assert.ok(guard < body.indexOf('"e2ee_history"'));
});

test("(10) #syncRecentConversation returns before the history read on note-to-self", () => {
  const body = method("async #syncRecentConversation(");
  const guard = body.search(
    /if \(isNoteToSelfConversation\(conversationId, this\.#client\.user\?\.id\)\) \{\s*return \[\];\s*\}/,
  );
  assert.notEqual(guard, -1, "guard missing");
  assert.ok(guard < body.indexOf('"e2ee_history"'));
});

// ---- wiring in E2EEVerify.tsx (`E2EE_VERIFY_TSX` for controls) ----

const VERIFY_TSX =
  process.env.E2EE_VERIFY_TSX ??
  new URL("../modal/modals/E2EEVerify.tsx", import.meta.url);
const verify = readFileSync(VERIFY_TSX, "utf8");

test("(11) E2EEVerify turns off only the DM resolveDmConversation finds", () => {
  assert.match(
    verify,
    /^import \{ resolveDmConversation \} from "@revolt\/client\/e2eeSelfDm";$/m,
  );
  assert.equal(verify.match(/recipientIds\.has\(/g)?.length ?? 0, 0);
  const start = verify.indexOf("async function turnOff(");
  assert.notEqual(start, -1, "turnOff not found");
  const body = verify.slice(start, verify.indexOf("\n  }\n", start));
  const resolved = body.search(
    /=\s*resolveDmConversation\(\s*props\.peerUserId,\s*client\(\)\.user\?\.id,/,
  );
  assert.notEqual(resolved, -1, "turnOff does not resolve the DM");
  const stop = body.search(/if \(\w+\.kind !== "existing"\) return;/);
  assert.notEqual(stop, -1, "turnOff does not stop unless a DM resolved");
  const downgrade = body.indexOf("downgradeConversation(");
  assert.ok(resolved < stop && stop < downgrade);
});
