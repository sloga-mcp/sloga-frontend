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
// keep all five commit declarations (D5, F4, S2 `removed_reasons`). S2: a v2
// rejoin intent keeps its signed `generation` / `issued_at` (dropping them
// makes native verify it over the S1 payload); one present but malformed
// makes the envelope malformed, never the S1 shape (OR-6); an S1 intent
// passes byte for byte.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import {
  type MlsRoute,
  type RouteMlsInput,
  type TextSinkSource,
  TEXT_SYNTH_ID_PREFIX,
  isSynthTextEnvelopeId,
  removedReason,
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
    removed_reasons: [],
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
    "removed_reasons",
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
        removed_reasons: missing,
      }),
      "mls_commit",
    );
    assert.ok(env);
    assert.deepEqual(env.added, []);
    assert.deepEqual(env.removed, []);
    assert.deepEqual(env.rejoin_intents, []);
    assert.deepEqual(env.removed_reasons, []);
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
    { removed_reasons: "own_user" as unknown as [] },
    { removed_reasons: [null] as unknown as [] },
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
    removed_reasons: [],
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
  assert.deepEqual(env?.removed_reasons, []);
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

// ---------------------------------------------------------------------------
// S2 (L1r): v2 intent fields (OR-6) and removed_reasons
// ---------------------------------------------------------------------------

const ISSUED = 1_762_905_600_000;
const V2_INTENT = { ...INTENT, generation: 3, issued_at: ISSUED };
const REASON_OFF = {
  user_id: "U_CAROL",
  device_id: "D_CAROL",
  reason: "off_list",
};
const REASON_FUTURE = {
  user_id: "U_ERIN",
  device_id: "D_ERIN",
  reason: "from_the_future",
};
/** Present but not a safe non-negative integer (e2ee.ts uses the same set). */
const MALFORMED_INTS: unknown[] = [
  1.5,
  -1,
  "3",
  null,
  NaN,
  Infinity,
  2 ** 53,
  {},
  true,
];

/** A stored commit row (409 `Lost.winning`, gap refetch). */
function commitRow(over: Record<string, unknown> = {}) {
  return {
    group_id: "G1",
    epoch: 9,
    committer: ALICE,
    commit: "COMMIT_B64",
    added: [BOB],
    removed: [CAROL],
    ...over,
  } as Parameters<typeof textEnvelopeFromCommitInfo>[0];
}

/** Both builders, so each S2 rule holds on the live and the stored path. */
function bothBuilders(over: Record<string, unknown>) {
  return [
    textSinkEnvelope(
      commitEvent(over as Partial<TextSinkSource>),
      "mls_commit",
    ),
    textEnvelopeFromCommitInfo(commitRow(over)),
  ];
}

const label = (o: Record<string, unknown>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${typeof v}:${String(v)}`)
    .join(",");

test("S2: an S1 intent passes byte for byte; an S1 envelope only gains an empty removed_reasons", () => {
  for (const env of bothBuilders({ rejoin_intents: [INTENT] })) {
    assert.ok(env);
    const intent = env.rejoin_intents?.[0];
    assert.ok(intent);
    assert.equal(JSON.stringify(intent), JSON.stringify(INTENT));
    assert.equal("generation" in intent, false);
    assert.equal("issued_at" in intent, false);
    assert.deepEqual(env.removed_reasons, []);
  }
  // The whole live envelope: the pre-S2 bytes, key order included, plus
  // the empty removed_reasons (native reads it as absent).
  const env = textSinkEnvelope(commitEvent(), "mls_commit");
  assert.ok(env);
  const { removed_reasons, ...s1 } = env;
  assert.deepEqual(removed_reasons, []);
  assert.equal(
    JSON.stringify(s1),
    JSON.stringify({
      id: "ENV1",
      content_type: "mls_commit",
      group_id: "G1",
      epoch: 4,
      ciphertext: "CT",
      added: [BOB],
      removed: [CAROL],
      rejoin_intents: [INTENT],
      committer: ALICE,
      recipientDeviceId: OWN,
    }),
  );
});

test("S2: a v2 intent keeps its signed generation and issued_at (live event and stored row)", () => {
  for (const intent of [
    V2_INTENT,
    { ...INTENT, generation: 0, issued_at: 0 },
    { ...INTENT, generation: 7 },
    { ...INTENT, issued_at: Number.MAX_SAFE_INTEGER },
  ]) {
    for (const env of bothBuilders({ rejoin_intents: [INTENT, intent] })) {
      assert.ok(env, JSON.stringify(intent));
      assert.deepEqual(env.rejoin_intents, [INTENT, intent]);
      assert.equal(
        JSON.stringify(env.rejoin_intents?.[1]),
        JSON.stringify(intent),
      );
    }
  }
  // Keys outside the wire shape are still dropped.
  const env = textSinkEnvelope(
    commitEvent({
      rejoin_intents: [{ ...V2_INTENT, rejoin: true } as typeof V2_INTENT],
    }),
    "mls_commit",
  );
  assert.deepEqual(env?.rejoin_intents, [V2_INTENT]);
});

test("S2 OR-6: a present but malformed generation or issued_at makes the envelope null, never the S1 shape", () => {
  const cases: Record<string, unknown>[] = [
    { issued_at: 1.5 },
    { generation: 1.5 },
    { generation: -1 },
    { generation: "3" },
    { generation: null },
  ];
  for (const bad of MALFORMED_INTS) {
    cases.push(
      { generation: bad },
      { issued_at: bad },
      // One malformed field spoils a valid other one: never half an intent.
      { generation: bad, issued_at: ISSUED },
      { generation: 3, issued_at: bad },
    );
  }
  for (const fields of cases) {
    const intent = { ...INTENT, ...fields };
    for (const env of bothBuilders({ rejoin_intents: [V2_INTENT, intent] })) {
      assert.equal(env, null, label(fields));
    }
  }
});

/** `joinIntentSignedFields` as written in e2ee.ts (which Node cannot load). */
function liftJoinIntentSignedFields(): (
  e: Record<string, unknown>,
) => Record<string, unknown> | null {
  const src = readFileSync(new URL("./e2ee.ts", import.meta.url), "utf8");
  const head = "\nexport function joinIntentSignedFields(";
  const at = src.indexOf(head);
  assert.ok(at >= 0, "joinIntentSignedFields not found in e2ee.ts");
  assert.equal(src.indexOf(head, at + 1), -1, "declared once");
  const end = src.indexOf("\n}\n", at);
  assert.ok(end > at, "no closing brace");
  const decl = src.slice(at + "\nexport ".length, end + 2);
  return new Function(
    `${stripTypeScriptTypes(decl)}\nreturn joinIntentSignedFields;`,
  )();
}

test("S2 OR-6: the router's intent rule agrees with e2ee.ts joinIntentSignedFields", () => {
  const signed = liftJoinIntentSignedFields();
  const values: unknown[] = [
    undefined,
    0,
    1,
    3,
    2 ** 32,
    ISSUED,
    Number.MAX_SAFE_INTEGER,
    ...MALFORMED_INTS,
  ];
  let accepted = 0;
  let refused = 0;
  for (const generation of values) {
    for (const issued_at of values) {
      const fields: Record<string, unknown> = {};
      if (generation !== undefined) fields.generation = generation;
      if (issued_at !== undefined) fields.issued_at = issued_at;
      const want = signed(fields);
      for (const env of bothBuilders({
        rejoin_intents: [{ ...INTENT, ...fields }],
      })) {
        if (want === null) {
          assert.equal(env, null, label(fields));
        } else {
          assert.ok(env, label(fields));
          assert.deepEqual(env.rejoin_intents, [{ ...INTENT, ...want }]);
        }
      }
      if (want === null) refused++;
      else accepted++;
    }
  }
  // Both verdicts are exercised (16 x 16 inputs: 7 x 7 accepted).
  assert.equal(accepted, 49);
  assert.equal(refused, 16 * 16 - 49);
});

test("S2: removed_reasons pass verbatim, an unknown reason (from_the_future) included", () => {
  const reasons = [
    REASON_OFF,
    REASON_FUTURE,
    { user_id: "U_FRANK", device_id: "D_FRANK", reason: "" },
  ];
  for (const env of bothBuilders({ removed_reasons: reasons })) {
    assert.ok(env);
    assert.deepEqual(env.removed_reasons, reasons);
  }
  assert.deepEqual(removedReason(REASON_FUTURE), REASON_FUTURE);
  // Keys outside the wire shape are dropped.
  assert.deepEqual(
    textEnvelopeFromCommitInfo(
      commitRow({ removed_reasons: [{ ...REASON_FUTURE, note: "x" }] }),
    )?.removed_reasons,
    [REASON_FUTURE],
  );
  // And they reach native: toWireEnvelope keeps them.
  const live = textSinkEnvelope(
    commitEvent({ removed_reasons: [REASON_FUTURE] }),
    "mls_commit",
  );
  assert.ok(live);
  assert.deepEqual(toWireEnvelope(live).removed_reasons, [REASON_FUTURE]);
});

test("S2: an absent or null removed_reasons is []", () => {
  for (const missing of [undefined, null]) {
    for (const env of bothBuilders({ removed_reasons: missing })) {
      assert.ok(env);
      assert.deepEqual(env.removed_reasons, []);
    }
  }
  // The key absent altogether (an S1 row and an S1 event).
  const row = commitRow();
  assert.equal("removed_reasons" in row, false);
  assert.deepEqual(textEnvelopeFromCommitInfo(row)?.removed_reasons, []);
  assert.deepEqual(
    textSinkEnvelope(commitEvent(), "mls_commit")?.removed_reasons,
    [],
  );
});

test("S2: a removed reason with a non-string field makes the envelope null", () => {
  const bad: unknown[] = [
    { ...REASON_OFF, user_id: 7 },
    { ...REASON_OFF, device_id: null },
    { ...REASON_OFF, reason: 3 },
    { ...REASON_OFF, reason: null },
    { user_id: "U_CAROL", reason: "off_list" },
    "off_list",
    null,
    [REASON_OFF],
  ];
  for (const b of bad) {
    assert.equal(removedReason(b), null, JSON.stringify(b));
    for (const env of bothBuilders({ removed_reasons: [REASON_OFF, b] })) {
      assert.equal(env, null, JSON.stringify(b));
    }
  }
  for (const env of bothBuilders({ removed_reasons: { 0: REASON_OFF } })) {
    assert.equal(env, null, "not an array");
  }
});

test("S2: all five declarations survive a stored row and a live event", () => {
  const decl = {
    committer: ALICE,
    added: [BOB],
    removed: [CAROL],
    rejoin_intents: [V2_INTENT],
    removed_reasons: [REASON_OFF, REASON_FUTURE],
  };
  assert.deepEqual(textEnvelopeFromCommitInfo(commitRow(decl)), {
    id: `${TEXT_SYNTH_ID_PREFIX}G1:9`,
    content_type: "mls_commit",
    group_id: "G1",
    epoch: 9,
    ciphertext: "COMMIT_B64",
    ...decl,
  });
  assert.deepEqual(textSinkEnvelope(commitEvent(decl), "mls_commit"), {
    id: "ENV1",
    content_type: "mls_commit",
    group_id: "G1",
    epoch: 4,
    ciphertext: "CT",
    ...decl,
    recipientDeviceId: OWN,
  });
});
