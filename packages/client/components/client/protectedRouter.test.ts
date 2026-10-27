// Unit spec for the Protected channels MLS routing seam (W4 lane A5) — run
// with Node's built-in runner:
//   node --test --conditions=browser components/client/protectedRouter.test.ts
// Focus: `routeMls` is the whole plan D4 policy. A text envelope that reaches
// the call session is retried and poison-acked (F3); an envelope for another
// device must never reach the text manager (PA#4); a join request has no
// recipient and is never held (RC NEW-1, PA#11a); a Tauri device whose e2ee
// is off must drop indexed envelopes, not hand them to the call path
// (RC NEW-3a); a non-indexed envelope after the index is ready is call
// traffic (RC NEW-3b). `textSinkEnvelope` / `textEnvelopeFromCommitInfo` must
// keep all four commit declarations (D5, F4).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type MlsRoute,
  type RouteMlsInput,
  type TextSinkSource,
  TEXT_SYNTH_ID_PREFIX,
  isSynthTextEnvelopeId,
  routeMls,
  textEnvelopeFromCommitInfo,
  textSinkEnvelope,
  toWireEnvelope,
} from "./protectedRouter.ts";
import { TextIdIndex, textGroupId } from "./protectedTextIds.ts";

const OWN = "DEV_OWN";
const OTHER = "DEV_OTHER";

/** A fully "text" envelope input; each case overrides what it tests. */
function input(over: Partial<RouteMlsInput> = {}): RouteMlsInput {
  return {
    structural: true,
    indexReady: true,
    inIndex: true,
    managerReady: true,
    kind: "envelope",
    recipientDeviceId: OWN,
    ownDeviceId: OWN,
    ...over,
  };
}

/** Every combination of the inputs (own device: known, null, empty). */
function* everyInput(): Generator<RouteMlsInput> {
  const bools = [true, false];
  for (const structural of bools)
    for (const indexReady of bools)
      for (const inIndex of bools)
        for (const managerReady of bools)
          for (const kind of ["envelope", "join_request"] as const)
            for (const ownDeviceId of [OWN, null, ""])
              for (const recipientDeviceId of kind === "join_request"
                ? [null]
                : [OWN, OTHER])
                yield {
                  structural,
                  indexReady,
                  inIndex,
                  managerReady,
                  kind,
                  ownDeviceId,
                  recipientDeviceId,
                };
}

// ---------------------------------------------------------------------------
// routeMls: the D4 steps, one by one
// ---------------------------------------------------------------------------

test("step 7: indexed envelope for this device with the manager up -> text", () => {
  assert.equal(routeMls(input()), "text");
});

test("step 1: non-Tauri / pop-out / overlay is a passthrough -> call, always", () => {
  for (const i of everyInput()) {
    if (i.structural) continue;
    assert.equal(routeMls(i), "call", JSON.stringify(i));
  }
});

test("step 2: envelope before the index is ready -> pre_index_hold", () => {
  for (const inIndex of [true, false])
    for (const managerReady of [true, false])
      for (const ownDeviceId of [OWN, null])
        assert.equal(
          routeMls(
            input({ indexReady: false, inIndex, managerReady, ownDeviceId }),
          ),
          "pre_index_hold",
        );
});

test("[control: join request held pre-index] join request before the index is ready -> drop_unacked", () => {
  for (const inIndex of [true, false])
    for (const managerReady of [true, false])
      for (const ownDeviceId of [OWN, null]) {
        const route = routeMls(
          input({
            indexReady: false,
            inIndex,
            managerReady,
            ownDeviceId,
            kind: "join_request",
            recipientDeviceId: null,
          }),
        );
        assert.equal(route, "drop_unacked");
        assert.notEqual(route, "pre_index_hold");
      }
});

test("[control RC NEW-3b] non-indexed envelope after the index is ready -> call, never held", () => {
  for (const managerReady of [true, false])
    for (const ownDeviceId of [OWN, null, ""])
      for (const recipientDeviceId of [OWN, OTHER])
        assert.equal(
          routeMls(
            input({
              inIndex: false,
              managerReady,
              ownDeviceId,
              recipientDeviceId,
            }),
          ),
          "call",
        );
  assert.equal(
    routeMls(
      input({ inIndex: false, kind: "join_request", recipientDeviceId: null }),
    ),
    "call",
  );
});

test("[control: indexed-without-manager -> call] indexed, manager not ready -> drop_unacked (envelope and join request)", () => {
  for (const ownDeviceId of [OWN, null])
    for (const recipientDeviceId of [OWN, OTHER])
      assert.equal(
        routeMls(
          input({ managerReady: false, ownDeviceId, recipientDeviceId }),
        ),
        "drop_unacked",
      );
  assert.equal(
    routeMls(
      input({
        managerReady: false,
        kind: "join_request",
        recipientDeviceId: null,
      }),
    ),
    "drop_unacked",
  );
});

test("[control RC NEW-3a] status-incapable Tauri device: indexed traffic never reaches the call path", () => {
  // structural is a transport fact only; e2ee off / unprovisioned / wiped /
  // owned elsewhere is managerReady=false, which must not short-circuit to
  // call at step 1 (or anywhere).
  assert.equal(routeMls(input({ managerReady: false })), "drop_unacked");
  assert.equal(
    routeMls(input({ managerReady: false, indexReady: false })),
    "pre_index_hold",
  );
  assert.equal(
    routeMls(
      input({
        managerReady: false,
        indexReady: false,
        kind: "join_request",
        recipientDeviceId: null,
      }),
    ),
    "drop_unacked",
  );
});

test("[control RC NEW-1] indexed join request -> text, whatever the device ids", () => {
  for (const ownDeviceId of [OWN, null, ""])
    assert.equal(
      routeMls(
        input({ kind: "join_request", recipientDeviceId: null, ownDeviceId }),
      ),
      "text",
    );
});

test("step 6: indexed envelope while the own device id is unknown -> pre_index_hold", () => {
  for (const ownDeviceId of [null, ""])
    for (const recipientDeviceId of [OWN, OTHER])
      assert.equal(
        routeMls(input({ ownDeviceId, recipientDeviceId })),
        "pre_index_hold",
      );
});

test("[control: router recipient filter removed] indexed envelope for another device -> drop_unacked", () => {
  assert.equal(routeMls(input({ recipientDeviceId: OTHER })), "drop_unacked");
  // A missing recipient on an envelope is not this device either.
  assert.equal(routeMls(input({ recipientDeviceId: null })), "drop_unacked");
  assert.equal(routeMls(input({ recipientDeviceId: "" })), "drop_unacked");
});

// ---------------------------------------------------------------------------
// routeMls: invariants over the whole input space
// ---------------------------------------------------------------------------

test("matrix invariants over every input combination", () => {
  const seen = new Set<MlsRoute>();
  let n = 0;
  for (const i of everyInput()) {
    n++;
    const r = routeMls(i);
    seen.add(r);
    const label = JSON.stringify(i);
    // A join request is never held.
    if (i.kind === "join_request") {
      assert.notEqual(r, "pre_index_hold", label);
    }
    // Indexed traffic on a structural device never takes the call path.
    if (i.structural && i.indexReady && i.inIndex) {
      assert.notEqual(r, "call", label);
    }
    // `text` only for indexed traffic with the manager up, addressed to us.
    if (r === "text") {
      assert.ok(i.structural && i.indexReady && i.inIndex, label);
      assert.ok(i.managerReady, label);
      if (i.kind === "envelope") {
        assert.ok(!!i.ownDeviceId, label);
        assert.equal(i.recipientDeviceId, i.ownDeviceId, label);
      }
    }
    // Once the index is ready, only an indexed envelope with an unknown own
    // device id is held.
    if (r === "pre_index_hold" && i.indexReady) {
      assert.ok(i.inIndex && i.managerReady && !i.ownDeviceId, label);
    }
    // `call` only off-Tauri or for a group id outside a ready index.
    if (r === "call") {
      assert.ok(!i.structural || (i.indexReady && !i.inIndex), label);
    }
  }
  assert.equal(n, 2 * 2 * 2 * 2 * (3 * 2 + 3));
  assert.deepEqual([...seen].sort(), [
    "call",
    "drop_unacked",
    "pre_index_hold",
    "text",
  ]);
});

// ---------------------------------------------------------------------------
// routeMls over a real TextIdIndex (A4)
// ---------------------------------------------------------------------------

const CHANNEL = "01J9Z3K4M5N6P7Q8R9S0T1V2W3";
const OTHER_CHANNEL = "01HZXCCCCCCCCCCCCCCCCCCCCC";

test("with a real TextIdIndex: hold before ready, text for an indexed id, call otherwise", async () => {
  const index = new TextIdIndex();
  const g5 = await textGroupId(CHANNEL, 5);
  const foreign = await textGroupId(OTHER_CHANNEL, 0);
  const facts = (groupId: string) =>
    input({ indexReady: index.ready, inIndex: index.has(groupId) });

  assert.equal(routeMls(facts(g5)), "pre_index_hold");
  await index.addChannel(CHANNEL);
  assert.equal(routeMls(facts(g5)), "pre_index_hold");
  index.markReady();
  assert.equal(routeMls(facts(g5)), "text");
  assert.equal(routeMls(facts(foreign)), "call");
});

test("A4 caveat: markReady before an add resolves lets that id route call (B5 must await seeding first)", async () => {
  const index = new TextIdIndex();
  const g0 = await textGroupId(OTHER_CHANNEL, 0);
  const pending = index.addChannel(OTHER_CHANNEL);
  index.markReady();
  assert.equal(
    routeMls(input({ indexReady: index.ready, inIndex: index.has(g0) })),
    "call",
  );
  await pending;
  assert.equal(
    routeMls(input({ indexReady: index.ready, inIndex: index.has(g0) })),
    "text",
  );
});

// ---------------------------------------------------------------------------
// textSinkEnvelope (D5)
// ---------------------------------------------------------------------------

const ALICE = { user_id: "U_ALICE", device_id: "D_ALICE" };
const BOB = { user_id: "U_BOB", device_id: "D_BOB" };
const CAROL = { user_id: "U_CAROL", device_id: "D_CAROL" };
const INTENT = {
  group_id: "G1",
  channel_id: CHANNEL,
  user_id: "U_DAVE",
  device_id: "D_DAVE",
  key_package_ref: "KPR",
  signature: "SIG",
};

/** A live `MlsCommit` event as bonfire sends it (extra keys included). */
function commitEvent(
  over: Partial<TextSinkSource> & Record<string, unknown> = {},
): TextSinkSource {
  return {
    id: "ENV1",
    recipient_device_id: OWN,
    recipient_user_id: "U_SELF",
    sender_user_id: "U_ALICE",
    sender_device_id: "D_ALICE",
    protocol_version: 1,
    sequence: 7,
    type: "MlsCommit",
    content_type: "mls_commit",
    group_id: "G1",
    epoch: 4,
    ciphertext: "CT",
    committer: ALICE,
    added: [BOB],
    removed: [CAROL],
    rejoin_intents: [INTENT],
    ...over,
  } as TextSinkSource;
}

test("[control: textSinkEnvelope drops committer] all four declarations are kept", () => {
  const env = textSinkEnvelope(commitEvent(), "mls_commit");
  assert.deepEqual(env, {
    id: "ENV1",
    content_type: "mls_commit",
    group_id: "G1",
    epoch: 4,
    ciphertext: "CT",
    committer: ALICE,
    added: [BOB],
    removed: [CAROL],
    rejoin_intents: [INTENT],
    recipientDeviceId: OWN,
  });
});

test("textSinkEnvelope: no event-only keys leak into the envelope", () => {
  const env = textSinkEnvelope(commitEvent(), "mls_commit");
  assert.ok(env);
  assert.deepEqual(Object.keys(env).sort(), [
    "added",
    "ciphertext",
    "committer",
    "content_type",
    "epoch",
    "group_id",
    "id",
    "recipientDeviceId",
    "rejoin_intents",
    "removed",
  ]);
});

test("textSinkEnvelope: absent or null vectors are empty; an absent committer stays absent", () => {
  for (const missing of [undefined, null]) {
    const env = textSinkEnvelope(
      commitEvent({
        committer: missing,
        added: missing,
        removed: missing,
        rejoin_intents: missing,
      }),
      "mls_commit",
    );
    assert.ok(env);
    assert.deepEqual(env.added, []);
    assert.deepEqual(env.removed, []);
    assert.deepEqual(env.rejoin_intents, []);
    assert.equal("committer" in env, false);
  }
});

test("textSinkEnvelope: declaration elements keep only their wire keys", () => {
  const env = textSinkEnvelope(
    commitEvent({
      committer: { ...ALICE, extra: 1 } as typeof ALICE,
      added: [{ ...BOB, extra: 2 } as typeof BOB],
      rejoin_intents: [{ ...INTENT, extra: 3 } as typeof INTENT],
    }),
    "mls_commit",
  );
  assert.ok(env);
  assert.deepEqual(env.committer, ALICE);
  assert.deepEqual(env.added, [BOB]);
  assert.deepEqual(env.rejoin_intents, [INTENT]);
});

test("textSinkEnvelope: a malformed declaration makes the envelope malformed", () => {
  const bad: Partial<TextSinkSource>[] = [
    { added: "nope" as unknown as [] },
    { removed: [42] as unknown as [] },
    { rejoin_intents: {} as unknown as [] },
    { committer: [ALICE] as unknown as typeof ALICE },
    { committer: "U_ALICE" as unknown as typeof ALICE },
  ];
  for (const over of bad) {
    assert.equal(
      textSinkEnvelope(commitEvent(over), "mls_commit"),
      null,
      JSON.stringify(over),
    );
  }
});

test("textSinkEnvelope: content_type falls back to the arm's type; missing ids are malformed", () => {
  const welcome = textSinkEnvelope(
    commitEvent({ content_type: undefined, type: "MlsWelcome" }),
    "mls_welcome",
  );
  assert.equal(welcome?.content_type, "mls_welcome");
  // The event's own content_type wins.
  assert.equal(
    textSinkEnvelope(commitEvent(), "mls_welcome")?.content_type,
    "mls_commit",
  );
  assert.equal(
    textSinkEnvelope(commitEvent({ group_id: undefined }), "mls_commit"),
    null,
  );
  assert.equal(
    textSinkEnvelope(commitEvent({ epoch: null }), "mls_commit"),
    null,
  );
  // epoch 0 is a real epoch, not a missing one.
  assert.equal(
    textSinkEnvelope(commitEvent({ epoch: 0 }), "mls_commit")?.epoch,
    0,
  );
});

test("textSinkEnvelope: a ctl needs only group_id and gets epoch 0 (mirrors the call builder)", () => {
  const env = textSinkEnvelope(
    commitEvent({ content_type: "mls_ctl", epoch: undefined }),
    "mls_ctl",
  );
  assert.equal(env?.epoch, 0);
  assert.equal(env?.content_type, "mls_ctl");
});

// ---------------------------------------------------------------------------
// textEnvelopeFromCommitInfo (D5, M8) and toWireEnvelope
// ---------------------------------------------------------------------------

test("textEnvelopeFromCommitInfo: all four declarations, synthetic id, commit as ciphertext", () => {
  const env = textEnvelopeFromCommitInfo({
    group_id: "G1",
    epoch: 9,
    committer: ALICE,
    commit: "COMMIT_B64",
    added: [BOB],
    removed: [CAROL],
    rejoin_intents: [INTENT],
  });
  assert.deepEqual(env, {
    id: `${TEXT_SYNTH_ID_PREFIX}G1:9`,
    content_type: "mls_commit",
    group_id: "G1",
    epoch: 9,
    ciphertext: "COMMIT_B64",
    committer: ALICE,
    added: [BOB],
    removed: [CAROL],
    rejoin_intents: [INTENT],
  });
  assert.ok(env && isSynthTextEnvelopeId(env.id));
  assert.equal(env && "recipientDeviceId" in env, false);
});

test("textEnvelopeFromCommitInfo: absent rejoin_intents is empty; malformed is null", () => {
  const env = textEnvelopeFromCommitInfo({
    group_id: "G1",
    epoch: 2,
    committer: ALICE,
    commit: "C",
    added: [],
    removed: [],
  });
  assert.deepEqual(env?.rejoin_intents, []);
  assert.deepEqual(env?.committer, ALICE);
  assert.equal(
    textEnvelopeFromCommitInfo({
      group_id: "G1",
      epoch: 2,
      committer: ALICE,
      commit: "C",
      added: null as unknown as [],
      removed: "x" as unknown as [],
    }),
    null,
  );
});

test("isSynthTextEnvelopeId: mailbox ids are not synthetic", () => {
  assert.equal(isSynthTextEnvelopeId("01J9Z3K4M5N6P7Q8R9S0T1V2W3"), false);
  assert.equal(isSynthTextEnvelopeId("mls-synth:G1:1"), false);
  assert.equal(isSynthTextEnvelopeId("text-synth:G1:1"), true);
});

test("toWireEnvelope strips only recipientDeviceId and leaves the input intact", () => {
  const env = textSinkEnvelope(commitEvent(), "mls_commit");
  assert.ok(env);
  const wire = toWireEnvelope(env);
  assert.equal("recipientDeviceId" in wire, false);
  assert.equal(env.recipientDeviceId, OWN);
  const { recipientDeviceId: _r, ...rest } = env;
  assert.deepEqual(wire, rest);
});
