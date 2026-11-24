// Unit spec for the moderator-move client gate (AFK plan, 2026-09-22).
//   node --test --conditions=browser components/rtc/movePolicy.test.ts
//
// Focus: which SESSION acts on a `UserMoveVoiceChannel` event. The backend
// sends it privately to the moved user and `EventV1::private` reaches every
// session that user has, off-call devices included, so half the interesting
// cases are "a device that should stay put was told about a move". The other
// half is the mirror image and is easy to get wrong in the opposite
// direction: the eviction can still reach the client ahead of the event, so
// the real target is no longer CONNECTED when the move lands and a naive gate
// ignores it — silently leaving the member in no call at all. Addressing
// therefore asks which session WAS in `from`, recently, and both halves are
// pinned below.
//
// 🔴 The device the token was minted for is the only unforgeable signal here,
// and it is ABSENT on most seats. An identity is device-qualified only when
// the client asked for one: `create_token` falls back to the bare `user.id`
// otherwise, and `#connectAttempt` asks only when `callEncryptionCapable`
// holds. Web, the Electron/Linux shell and every unenrolled user therefore
// join bare, and the event they receive carries no device at all. So the
// spec below is organized around three populations, not two: verified
// sessions, sessions verified to be someone ELSE's, and sessions that cannot
// be verified either way. The third is the largest and gets its own outcome —
// `fail-loud` / `unverified-session` — because both silent answers available
// to it are wrong: ignoring strands the real target in no call, and moving
// lets an idle seat that was merely force-disconnected by a handoff publish a
// microphone into a room nobody is sitting at.
//
// 🔴 The per-connection NONCE is the fourth dimension, and the addressing
// label for bare seats. The event carries the moved connection's nonce,
// which the server read from the `CONN_NONCE_ATTRIBUTE` token attribute at
// move time. The session holds its own live nonce and the one it snapshotted
// with its drop marker. When both sides of a clause carry one, the nonce
// REPLACES the device test at every step. When either side lacks one, the
// ladder must answer exactly as it did before the nonce existed, and that is
// pinned against a fingerprint of the old ladder's answers, captured at
// commit 66c575a8, not just asserted case by case. Every pre-existing case
// below runs with all three nonce fields `undefined` (see `decide`), so each
// one is also a row of that truth table.
//
// 🔴 S-a adds a fifth dimension: the nonce this session is DIALING
// (`pendingConnNonce`) and the one its CONNECTED rejoin REPLACED
// (`replacedConnNonce`, aged by `replacedLeftAt`). They are read only when
// the gate is active and the nonces differ, and they can only turn a
// `moved-elsewhere` into an addressed answer. That is pinned three ways: a
// fingerprint of the whole nonce sweep captured from the ladder at commit
// 16734940, before S-a, which the new ladder must reproduce with the three
// fields absent; a G1 sweep in which no S-a value moves an inactive-gate
// answer; and a "widening only" sweep over every S-a shape in which every
// changed answer was `moved-elsewhere` and is traced to the field that
// matched.
//
// 🔴 There are TWO windows and the spec pins both edges of each. Inside
// `MOVE_VERIFIED_WINDOW_MS` a marker can still buy a move; between there and
// `MOVE_NOTICE_WINDOW_MS` it buys only a `stale-notice` toast, because the
// token is past relying on but the session's own rejoin loop is still
// dialing the OLD channel back and would reverse the moderator in silence;
// past the outer
// bound the marker means nothing and the session goes quiet like any other
// bystander.
//
// The precedence tests matter more than the branch tests: addressing is
// decided before feasibility, so an idle phone that also cannot resolve the
// destination must stay SILENT rather than raise an error about a call it is
// not in. The time constants are pinned against the token's real TTL — as a
// THREE-term sum, because the window alone is measured from the client's own
// drop clock and not from the mint, and `MOVE_TOKEN_SKEW_ALLOWANCE_MS` is the
// reservation for the difference.
//
// 🔴 FE-2 (the AFK x voice-move merge) changed two answers by ruling and
// added three inputs. Step 4's gate-inactive proof is a token minted for this
// connection (`tokenForThisConnection`) on a device-qualified identity
// (`lastIdentityIsDevice`) instead of a device match (D1, as amended by
// FE2A-2); a URL-less or token-less addressed move is the tokenless `join`
// instead of `no-url` (D2); and a destination gated for this member is
// `gated-destination`, which also replaces the loud arms that would card it.
// The old fingerprints are NOT re-captured. The sweeps feed the new ladder
// the old ladder's inputs (the LEGACY EMBEDDING, see `sweepWorlds`) and must
// reproduce the old fingerprints with `join` read back as `no-url`; every
// other difference is traced, world by world, to exactly one of the rulings.
//
// 🔴 Every assertion calls `moveDecision`. Nothing here re-types the rule it
// is checking — a spec that restates its subject passes a revert.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type MoveDecision,
  type MoveWorld,
  CONN_NONCE_ATTRIBUTE,
  MOVE_NOTICE_WINDOW_MS,
  MOVE_PRECONNECT_BUDGET_MS,
  MOVE_TOKEN_SKEW_ALLOWANCE_MS,
  MOVE_VERIFIED_WINDOW_MS,
  moveDecision,
} from "./movePolicy.ts";

const FROM = "01JFROMCHANNELAAAAAAAAAAAA";
const TO = "01JTOCHANNELAAAAAAAAAAAAAA";
const ELSEWHERE = "01JELSEWHERECHANNELAAAAAAA";
const NODE_URL = "wss://voice-eu.example.invalid";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.move-token.signature";
/** The device the server minted the token for, and one that it did not. */
const DEVICE = "01JDESKTOPDEVICEAAAAAAAAAA";
const OTHER_DEVICE = "01JPHONEDEVICEAAAAAAAAAAAA";
/** A fixed "now", so no assertion below depends on the wall clock. */
const NOW = 1_758_000_000_000;
/**
 * Two connection nonces, shaped like the backend's `nanoid::nanoid!()` mint:
 * the one the event names (the MOVED connection) and a sibling's.
 */
const NONCE = "V1StGXR8_Z5jdHi6B-myT";
const OTHER_NONCE = "Uakgb_J5m9g-0JDMbcJqL";
/** A third connection's nonce: a sibling's own rejoin, say. */
const THIRD_NONCE = "7Qn2kLx9_PbVwZ4rT-sYe";

/** No nonce anywhere: the world as it was before the nonce existed. */
const NO_NONCES = {
  connNonce: undefined,
  sessionConnNonce: undefined,
  lastInvoluntaryConnNonce: undefined,
};

/**
 * S-a's three fields, absent: nothing being dialed, nothing replaced. The
 * world as the ladder saw it at 16734940, before S-a existed.
 */
const NO_SA = {
  pendingConnNonce: undefined,
  replacedConnNonce: undefined,
  replacedLeftAt: undefined,
};

/**
 * A move that is valid in every respect, for the named field to spoil. The
 * default world's two device ids MATCH, so every pre-existing case below is
 * asserting what it always was and not quietly passing on `other-device`.
 *
 * 🔴 The default world carries NO nonce on either side, so the nonce gate is
 * inactive and every pre-existing case keeps asserting exactly the answer it
 * asserted before the nonce existed. Every case written before the nonce is a
 * row of the "gate inactive => the old answer" truth table, with its expected
 * value unchanged. It carries no S-a field either, so every case written
 * before S-a asserts what it asserted at 16734940.
 *
 * FE-2: the default seat is a DEVICE seat holding a token minted for it —
 * identity `{user}:DEVICE`, a token whose `sub` is that identity, and no gate
 * on the destination. That is the world in which the old device match and
 * the new token proof agree, so every pre-existing case keeps its answer
 * unless it spoils one of the new fields on purpose.
 */
const decide = (world: Partial<MoveWorld> = {}) =>
  moveDecision({
    callState: "CONNECTED",
    currentChannelId: FROM,
    from: FROM,
    to: TO,
    url: NODE_URL,
    token: TOKEN,
    tokenForThisConnection: true,
    lastIdentityIsDevice: true,
    destinationKnown: true,
    destinationGated: false,
    lastInvoluntaryChannelId: undefined,
    lastInvoluntaryLeftAt: undefined,
    deviceId: DEVICE,
    sessionDeviceId: DEVICE,
    ...NO_NONCES,
    ...NO_SA,
    now: NOW,
    ...world,
  });

/** The decision the default world produces, spelled out once. */
const MOVED: MoveDecision = {
  action: "move",
  url: NODE_URL,
  token: TOKEN,
  to: TO,
};

/** A session the SFU dropped from `channel` `agoMs` milliseconds ago. */
const droppedFrom = (channel: string, agoMs: number) => ({
  lastInvoluntaryChannelId: channel,
  lastInvoluntaryLeftAt: NOW - agoMs,
});

/**
 * A seat that joined with a BARE LiveKit identity — web, the Electron/Linux
 * shell, an unenrolled user — so the event names no device and this session
 * presented none. The common case, not the exotic one.
 *
 * FE-2: its last identity is the bare `{user}`, and the default token stays
 * "for this connection" — a bare token's `sub` is `{user}` too, which is
 * exactly why FE2A-2 does not let that match address a marker. Every
 * `unverified-session` case below therefore holds BECAUSE the identity is
 * bare, not because the token is missing.
 */
const UNVERIFIED = {
  deviceId: undefined,
  sessionDeviceId: undefined,
  lastIdentityIsDevice: false,
};

/** Not connected to anything, which is what the marker steps require. */
const OFF_CALL = { callState: "DISCONNECTED", currentChannelId: undefined };

/** Halfway between the two windows: too late to act, worth telling. */
const STALE_MS = (MOVE_VERIFIED_WINDOW_MS + MOVE_NOTICE_WINDOW_MS) / 2;

test("step 1 — a token minted for another device is ignored by a session in `from`", () => {
  // Step 3 on its own is not enough. LiveKit identities are `user:device`, so
  // when `forceDisconnect` is false two of one user's sessions can sit in the
  // SAME channel; both then satisfy "I am CONNECTED to `from`" and both would
  // redeem a token minted once for one identity. LiveKit settles that by
  // evicting one on duplicate identity, and the loser may be the session the
  // user is actually sitting in front of.
  assert.deepEqual(
    decide({ deviceId: DEVICE, sessionDeviceId: OTHER_DEVICE }),
    {
      action: "ignore",
      reason: "other-device",
    },
  );
});

test("step 1 — a token minted for another device is ignored by a dropped session", () => {
  // The marker steps are the claimable half: an involuntary drop from `from`
  // is an ordinary event, not a signature. Same world as the "just removed
  // from the source channel MOVES" case below — only the device differs. Note
  // this is `other-device` and NOT `unverified-session`: the device is known,
  // it is simply not ours, so there is nothing unresolved to tell the user
  // about.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      deviceId: DEVICE,
      sessionDeviceId: OTHER_DEVICE,
      ...droppedFrom(FROM, 250),
    }),
    { action: "ignore", reason: "other-device" },
  );
});

test("step 1 — a session with no device of its own cannot claim a named token", () => {
  // The server named a device; this session cannot show it is that one. It
  // must not be allowed to read its own ignorance as a match — that is the
  // `undefined === undefined` hole this case is deliberately separated from.
  // Half-known is `other-device`, not `unverified-session`: the event's own
  // device is known, so SOMEBODY can be verified, and it is not us.
  assert.deepEqual(decide({ deviceId: DEVICE, sessionDeviceId: undefined }), {
    action: "ignore",
    reason: "other-device",
  });
});

test("🔴 step 1 outranks every other rule in the module", () => {
  // PRECEDENCE, not a branch. A device the token was not minted for must stay
  // SILENT whatever else is true of the world: it is entitled neither to an
  // error toast about a call it is not in, nor to the `already-there` no-op
  // that would otherwise read as "this session was addressed", nor to the
  // `unverified-session` or `stale-notice` cards — those outcomes exist for
  // seats that cannot be judged or cannot act, and this one has been judged.
  for (const spoiled of [
    { from: FROM, to: FROM, currentChannelId: FROM },
    { destinationKnown: false },
    { url: undefined },
    { token: undefined },
    { destinationGated: true },
    { destinationKnown: false, url: "   ", from: FROM, to: FROM },
    { ...OFF_CALL, ...droppedFrom(FROM, 250) },
    { ...OFF_CALL, ...droppedFrom(FROM, STALE_MS) },
    { ...OFF_CALL, destinationKnown: false, ...droppedFrom(FROM, 250) },
    { ...OFF_CALL, destinationGated: true, ...droppedFrom(FROM, 250) },
    { ...OFF_CALL, destinationGated: true, ...droppedFrom(FROM, STALE_MS) },
    // A token that IS this connection's cannot outvote step 1 either: in
    // this world the event names a device that is not ours.
    {
      ...OFF_CALL,
      tokenForThisConnection: true,
      lastIdentityIsDevice: true,
      ...droppedFrom(FROM, 250),
    },
  ])
    assert.deepEqual(
      decide({ ...spoiled, deviceId: DEVICE, sessionDeviceId: OTHER_DEVICE }),
      { action: "ignore", reason: "other-device" },
    );
});

test("step 2 — from === to is already-there, even when everything else is valid", () => {
  // Redeeming a token for the room we are already in is a reconnect: it
  // tears down a healthy room and re-races our own identity for nothing.
  assert.deepEqual(decide({ from: FROM, to: FROM, currentChannelId: FROM }), {
    action: "ignore",
    reason: "already-there",
  });
});

test("🔴 step 2 outranks BOTH loud arms, and that is a ruling, not an accident", () => {
  // PRECEDENCE, and it was an open question until it was decided. An earlier
  // cut of this ladder put `already-there` below the loud arms, so a session
  // holding a marker it could not verify — or one past the acceptance window —
  // got a card for a `from === to` event.
  //
  // The ruling: when `from === to` NOTHING WAS MOVED, so every loud arm's copy
  // (you were moved to another voice channel) is a plain false statement made
  // to a session sitting exactly where it already was. What is given up is a
  // Rejoin button pointing at the channel this session was dropped from,
  // which is marginal; honesty about what happened is not. It cannot occur in
  // practice either — the shared backend emitter
  // (`move_user_to_voice_channel_expecting`, behind both the moderator route
  // and the AFK sweep) answers `AlreadyPresent` for `from === to` and emits
  // no event — so this is defensive ordering, and
  // defensive code should fail quiet and true over loud and false.
  const alreadyThere = { from: FROM, to: FROM };
  // Against `unverified-session`: a bare seat with a fresh marker.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...alreadyThere,
      ...droppedFrom(FROM, 250),
    }),
    { action: "ignore", reason: "already-there" },
  );
  // Against `stale-notice`, on both populations it covers.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...alreadyThere,
      ...droppedFrom(FROM, STALE_MS),
    }),
    { action: "ignore", reason: "already-there" },
  );
  assert.deepEqual(
    decide({ ...OFF_CALL, ...alreadyThere, ...droppedFrom(FROM, STALE_MS) }),
    { action: "ignore", reason: "already-there" },
  );
  // And against the feasibility answers, which it has always outranked.
  assert.deepEqual(
    decide({
      ...alreadyThere,
      currentChannelId: FROM,
      destinationKnown: false,
      url: undefined,
    }),
    { action: "ignore", reason: "already-there" },
  );
  // Including for the session that really was removed: redeeming the token
  // would rejoin the room we were just taken out of, which is not what the
  // moderator asked for.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...alreadyThere, ...droppedFrom(FROM, 250) }),
    { action: "ignore", reason: "already-there" },
  );
});

test("step 3 — being CONNECTED to the source is what the first addressed shape tests", () => {
  // The computation, pinned by its two failure modes: the right channel in the
  // wrong state, and the right state in the wrong channel. Neither is step 3,
  // and with no drop marker in play neither is addressed at all.
  assert.deepEqual(decide({ currentChannelId: ELSEWHERE }), {
    action: "ignore",
    reason: "other-channel",
  });
  assert.deepEqual(decide({ callState: "CONNECTING" }), {
    action: "ignore",
    reason: "not-in-call",
  });
  // And the positive: exactly the two together.
  assert.deepEqual(
    decide({ callState: "CONNECTED", currentChannelId: FROM }),
    MOVED,
  );
});

test("step 3 — a session CONNECTED to the source goes on to the feasibility tests", () => {
  // Addressed means "keep going", not "move": the feasibility answers are
  // reachable from the connected shape too, and they are LOUD.
  assert.deepEqual(decide(), MOVED);
  assert.deepEqual(decide({ destinationKnown: false }), {
    action: "fail-loud",
    reason: "unknown-channel",
  });
});

test("the drop marker needs channel, a timestamp and the notice window together", () => {
  // The claim the marker steps rest on. Each of its three inputs falsifies it
  // alone, on an otherwise VERIFIED session, and falsifying it drops the
  // session all the way to step 7 — not to `stale-notice`, which is about a
  // marker that exists and is merely late.
  const worlds = [
    // Wrong channel.
    { ...OFF_CALL, ...droppedFrom(ELSEWHERE, 250) },
    // Past the outer bound: the marker has stopped meaning anything.
    { ...OFF_CALL, ...droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS) },
    // Half a marker is not a marker: an absent `leftAt` must not be read as
    // "just now" via some arithmetic on `undefined`.
    {
      ...OFF_CALL,
      lastInvoluntaryChannelId: FROM,
      lastInvoluntaryLeftAt: undefined,
    },
  ];
  for (const world of worlds)
    assert.deepEqual(decide(world), {
      action: "ignore",
      reason: "not-in-call",
    });
  // All three together and the same session is addressed — so the cases above
  // are about the marker and not about some other spoiled field.
  assert.deepEqual(decide({ ...OFF_CALL, ...droppedFrom(FROM, 250) }), MOVED);
});

test("step 4 — a dropped session holding a token for its own device identity is addressed", () => {
  // The bug this gate was rewritten for. `move_user_to_voice_channel` used to
  // call `voice_client.remove_user(...)` first and publish
  // `UserMoveVoiceChannel` only afterwards, which lost this race every single
  // time; it now publishes the event BEFORE the eviction, and says so at the
  // call site. The race is no longer guaranteed — but it is not gone. The two
  // legs leave delta at nearly the same instant by different routes (Redis ->
  // bonfire -> socket for the event, a LiveKit RPC and a `Leave` down our
  // signaling socket for the eviction), so the `Leave` can still win on
  // jitter. When it does, `PARTICIPANT_REMOVED` is in
  // `NO_REJOIN_DISCONNECT_REASONS` and puts us in DISCONNECTED before the
  // move lands, and a gate that demanded CONNECTED would ignore the REAL
  // target in silence, leaving the member in no call at all.
  assert.deepEqual(decide({ ...OFF_CALL, ...droppedFrom(FROM, 250) }), MOVED);
  // Feasibility is reachable from the marker shape as well: if the widened
  // rule only ever produced `move` and never `fail-loud`, the most common
  // shape of a real move — DISCONNECTED because the SFU removed us — would
  // fail silently.
  assert.deepEqual(
    decide({ ...OFF_CALL, destinationKnown: false, ...droppedFrom(FROM, 250) }),
    { action: "fail-loud", reason: "unknown-channel" },
  );
  // D2: a URL-less addressed move is the tokenless join, not `no-url`.
  assert.deepEqual(
    decide({ ...OFF_CALL, url: "   ", ...droppedFrom(FROM, 250) }),
    { action: "join", to: TO },
  );
});

test("🔴 step 5 — a dropped session that cannot show its device fails LOUD", () => {
  // The heart of the rule. This seat joined bare, so the event names no
  // device and neither does the session: the marker's claim ("the SFU just
  // removed me from `from`") can be neither confirmed nor denied here.
  //
  // It must not be silently honored — an idle seat that was merely
  // force-disconnected by a handoff holds exactly this marker, and honoring
  // it lets that seat redeem the token and publish a microphone into a room
  // nobody is sitting at. It must not be silently dropped either — the seat
  // that really was moved would then land in no call at all, which is the
  // shipped bug this slice exists to repair.
  //
  // So it is LOUD: the destination is carded and Rejoin is one click away.
  // That is a manual move where a device-qualified seat gets an automatic one,
  // and it is accepted deliberately until the addressing label stops being the
  // E2EE device id.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...UNVERIFIED, ...droppedFrom(FROM, 250) }),
    {
      action: "fail-loud",
      reason: "unverified-session",
    },
  );
  // The fail-open rejoin shape reaches it too: `shouldAutoRejoin` is a
  // deny-list, so an absent or unrecognized disconnect reason leaves us
  // RECONNECTING and dialing the OLD channel back.
  assert.deepEqual(
    decide({
      callState: "RECONNECTING",
      currentChannelId: FROM,
      ...UNVERIFIED,
      ...droppedFrom(FROM, 1_000),
    }),
    { action: "fail-loud", reason: "unverified-session" },
  );
});

test("🔴 step 5 never answers `move`, on any spoiling of the rest of the world", () => {
  // The property, separated from the branch: whatever else is true, an
  // unverifiable session holding a fresh marker does not redeem the token. If
  // this ever goes green on a `move` the forgery is back.
  for (const spoiled of [
    {},
    { to: TO },
    { destinationKnown: false },
    { url: undefined },
    { url: ` ${NODE_URL} ` },
    { token: "" },
    { token: undefined, tokenForThisConnection: false },
    { url: undefined, token: undefined, tokenForThisConnection: false },
    { callState: "IDLE" },
    { currentChannelId: ELSEWHERE },
  ]) {
    const decision = decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...droppedFrom(FROM, 250),
      ...spoiled,
    });
    assert.notEqual(decision.action, "move");
    assert.deepEqual(decision, {
      action: "fail-loud",
      reason: "unverified-session",
    });
  }
});

test("🔴 step 6 — a marker past the verified window is a stale-notice, on BOTH populations", () => {
  // ONE arm, TWO causes, and both of them used to be silent on one side of
  // the tree or the other.
  //
  // The verified-but-late session could prove the token named it and was
  // ignored anyway; `state.tsx` grew its own copy of the addressing predicate
  // beside the call to rescue it, which put half the rule where no spec could
  // reach it. The unverifiable-and-late session got nothing at all.
  //
  // Both are wrong for the same reason: their drop fails OPEN in
  // `shouldAutoRejoin` whenever the SDK reports no reason, so they are already
  // dialing `from` back on the 1 s / 2 s / 4 s ladder. Silence hands the user
  // the old channel and tells nobody a moderator's decision was undone.
  //
  // Past the verified window the device distinction buys nothing — no move is
  // going to be attempted either way, because the token can no longer be
  // relied on to outlive the connect — so the two populations get the same
  // answer and the same copy.
  assert.deepEqual(decide({ ...OFF_CALL, ...droppedFrom(FROM, STALE_MS) }), {
    action: "fail-loud",
    reason: "stale-notice",
  });
  assert.deepEqual(
    decide({ ...OFF_CALL, ...UNVERIFIED, ...droppedFrom(FROM, STALE_MS) }),
    { action: "fail-loud", reason: "stale-notice" },
  );
  // The half-known shape the other way round — the event named no device, this
  // session has one — lands in the same arm: there is still nothing to
  // compare, and nothing left to compare it for.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      deviceId: undefined,
      sessionDeviceId: DEVICE,
      ...droppedFrom(FROM, STALE_MS),
    }),
    { action: "fail-loud", reason: "stale-notice" },
  );
  // And the fail-open RECONNECTING shape, which is the one actually dialing
  // the old channel back while this is decided.
  assert.deepEqual(
    decide({
      callState: "RECONNECTING",
      currentChannelId: FROM,
      ...droppedFrom(FROM, STALE_MS),
    }),
    { action: "fail-loud", reason: "stale-notice" },
  );
});

test("🔴 step 6 never answers `move`, and outranks the feasibility answers", () => {
  // The same two duties step 5 carries. A session past the acceptance window
  // must not redeem a dead token, and must not be told `unknown-channel` —
  // that reads as "you were moved and something broke", when what is true is
  // that the notice arrived too late to follow. Nor may it take the tokenless
  // `join`: too late is too late, with or without a token.
  for (const spoiled of [
    {},
    { destinationKnown: false },
    { url: undefined },
    { url: "   " },
    { destinationKnown: false, url: undefined },
    { token: "" },
    { token: undefined, tokenForThisConnection: false },
  ])
    for (const devices of [{}, UNVERIFIED]) {
      const decision = decide({
        ...OFF_CALL,
        ...devices,
        ...droppedFrom(FROM, STALE_MS),
        ...spoiled,
      });
      assert.notEqual(decision.action, "move");
      assert.deepEqual(decision, {
        action: "fail-loud",
        reason: "stale-notice",
      });
    }
});

test("step 7 — anything else is a silent ignore, and it names which kind", () => {
  // 🔴 The whole reason this module exists. A phone in a pocket and a spare
  // browser tab both receive this event. Acting on it would join them to a
  // call they were never in and publish their microphone — and since the
  // token is minted once for one identity, the two redemptions race and
  // LiveKit evicts one of them on duplicate identity. Such a device has no
  // involuntary-drop marker at all, so no step from 3 to 6 can reach it: it is
  // silent, as it must be.
  for (const callState of ["DISCONNECTED", "CONNECTING", "RECONNECTING"]) {
    assert.deepEqual(
      decide({
        callState,
        currentChannelId: undefined,
        lastInvoluntaryChannelId: undefined,
        lastInvoluntaryLeftAt: undefined,
      }),
      { action: "ignore", reason: "not-in-call" },
    );
  }
  // Connected, just not to this one, is the other half of the same step.
  assert.deepEqual(decide({ currentChannelId: ELSEWHERE }), {
    action: "ignore",
    reason: "other-channel",
  });
  // Including when a marker exists but is past the OUTER bound — a drop from
  // hours ago must not card a move the session had no part in, and by then it
  // is an ordinary bystander again on both device populations.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS) }),
    { action: "ignore", reason: "not-in-call" },
  );
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS),
    }),
    { action: "ignore", reason: "not-in-call" },
  );
});

test("🔴 the web-handoff forgery is refused: an unverified idle seat never MOVES", () => {
  // The scenario that made step 5 necessary, concretely, on the seats where
  // the device test is INERT.
  //
  // A user is in `from` on the web. They pick the call up on a second device:
  // `Channel.joinCall` defaults `forceDisconnect = true`, so the server evicts
  // the web seat, which records an involuntary drop from `from` and goes
  // DISCONNECTED — holding exactly the marker step 4 looks for, through no
  // moderator's doing at all.
  //
  // Moments later a move out of `from` lands — a moderator, or the AFK sweep,
  // which is a TIMER, so sooner or later one does land inside the window. Both
  // sessions receive it, because the topic is private to the user. Neither
  // joined with a device-qualified identity, so the event names no device and
  // the old fallback would let BOTH act: the new seat under step 3, the idle
  // web seat under step 4. Both redeem a token minted ONCE for identity
  // `{user}`, LiveKit evicts one on duplicate identity, and the survivor can be
  // the unattended seat — joining the destination and publishing a microphone
  // into a room nobody is sitting at.
  const secondSeat = decide({
    callState: "CONNECTED",
    currentChannelId: FROM,
    ...UNVERIFIED,
  });
  // FE2A-2: the idle web seat's bare token even names its own identity —
  // `{user}` is every bare seat's identity — and that is still not enough.
  const idleWebSeat = decide({
    ...OFF_CALL,
    ...UNVERIFIED,
    tokenForThisConnection: true,
    ...droppedFrom(FROM, 500),
  });
  // The seat actually in `from` moves: with a bare identity step 3 is EXACT,
  // because two sessions cannot hold one bare identity in one room.
  assert.deepEqual(secondSeat, MOVED);
  // The idle one does not move. It is told, loudly, and publishes nothing.
  assert.notEqual(idleWebSeat.action, "move");
  assert.deepEqual(idleWebSeat, {
    action: "fail-loud",
    reason: "unverified-session",
  });
});

test("🔴 a desktop-to-phone handoff cannot forge the addressing rule", () => {
  // The same shape on seats that DO carry a device, where step 1 catches it
  // first and does so silently — the idle desktop is not merely unverifiable,
  // it has been positively excluded, so it gets no card either.
  const phone = decide({
    callState: "CONNECTED",
    currentChannelId: FROM,
    deviceId: OTHER_DEVICE,
    sessionDeviceId: OTHER_DEVICE,
  });
  const idleDesktop = decide({
    ...OFF_CALL,
    deviceId: OTHER_DEVICE,
    sessionDeviceId: DEVICE,
    ...droppedFrom(FROM, 500),
  });
  // Exactly one session acts, and it is the one the token was minted for.
  assert.deepEqual(phone, MOVED);
  assert.deepEqual(idleDesktop, {
    action: "ignore",
    reason: "other-device",
  });
});

test("🔴 an UNVERIFIED session CONNECTED to the source still MOVES", () => {
  // The case that must not regress, and the reason step 5 is scoped to the
  // marker shape alone. Web, the Electron/Linux shell and every unenrolled
  // user join bare; if being unverifiable were disqualifying in itself, a
  // moderator moving any of them would silently do nothing on the client and
  // the whole feature would be dead for most of the install base.
  //
  // Step 3 does not need the device test to be exact HERE: a bare identity is
  // `{user}`, and two sessions of one user cannot both hold it in `from` at
  // once — LiveKit would already have evicted one on duplicate identity. Being
  // in `from` right now is therefore proof enough by itself.
  assert.deepEqual(decide(UNVERIFIED), MOVED);
  // Same for the half-known shape the other way round: the event named no
  // device, this session has one. Nothing to compare, and step 3 holds.
  assert.deepEqual(
    decide({ deviceId: undefined, sessionDeviceId: DEVICE }),
    MOVED,
  );
  // And it reaches the LOUD feasibility answers like any other addressed
  // session — it is addressed, not merely tolerated.
  assert.deepEqual(decide({ ...UNVERIFIED, destinationKnown: false }), {
    action: "fail-loud",
    reason: "unknown-channel",
  });
});

test("🔴 the VERIFIED window's far edge moves; the boundary itself is a stale-notice", () => {
  // The window is now sized by the token's life — minus the budget and minus
  // the unmeasured mint/handshake skew — rather than by a forgery surface, so
  // the far edge is a place a real move can legitimately land. One
  // millisecond inside, the session moves; AT the boundary the token can no
  // longer be relied on to survive the connect and the answer flips to the
  // toast — not to silence, which is the gap this arm closes.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...droppedFrom(FROM, MOVE_VERIFIED_WINDOW_MS - 1) }),
    MOVED,
  );
  // The comparison is strict `<`, so the instant the window elapses the
  // answer flips — and stays flipped for the whole of the notice window.
  for (const ago of [
    MOVE_VERIFIED_WINDOW_MS,
    MOVE_VERIFIED_WINDOW_MS + 1,
    MOVE_NOTICE_WINDOW_MS - 1,
  ])
    assert.deepEqual(decide({ ...OFF_CALL, ...droppedFrom(FROM, ago) }), {
      action: "fail-loud",
      reason: "stale-notice",
    });
  // The unverified seat's card changes copy on exactly the same clock.
  // Compared whole rather than by `.reason`: the action is half the answer,
  // and reaching for the reason alone would not distinguish a card from a
  // move.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...droppedFrom(FROM, MOVE_VERIFIED_WINDOW_MS - 1),
    }),
    { action: "fail-loud", reason: "unverified-session" },
  );
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...droppedFrom(FROM, MOVE_VERIFIED_WINDOW_MS),
    }),
    { action: "fail-loud", reason: "stale-notice" },
  );
});

test("🔴 the NOTICE window's boundary goes silent, on both device populations", () => {
  // The outer bound, and the only thing that ever expires the marker —
  // `state.tsx` clears it on `connect()` and on `connected` and nowhere else,
  // so a session that goes offline and never comes back holds it forever. A
  // laptop woken after eight hours must not card a move that landed on the
  // user's phone while it was asleep.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS - 1) }),
    { action: "fail-loud", reason: "stale-notice" },
  );
  // Strict `<` here too: AT the bound, and past it, silence.
  for (const ago of [
    MOVE_NOTICE_WINDOW_MS,
    MOVE_NOTICE_WINDOW_MS + 1,
    8 * 60 * 60 * 1_000,
  ])
    for (const devices of [{}, UNVERIFIED])
      assert.deepEqual(
        decide({ ...OFF_CALL, ...devices, ...droppedFrom(FROM, ago) }),
        { action: "ignore", reason: "not-in-call" },
      );
});

test("🔴 a verified session rejoining the OLD channel after the drop still MOVES", () => {
  // The fail-open half. `shouldAutoRejoin` is a deny-list, so when the SDK
  // reports the removal with an absent or unrecognized reason we go
  // RECONNECTING and start dialing `from` back. Ignoring the move here
  // would let the rejoin loop silently undo the moderator's decision.
  assert.deepEqual(
    decide({
      callState: "RECONNECTING",
      currentChannelId: FROM,
      ...droppedFrom(FROM, 1_000),
    }),
    MOVED,
  );
});

test("🔴 a session CONNECTED elsewhere is not addressed by a stale marker", () => {
  // Precisely why the marker terms are gated on `callState !== "CONNECTED"`.
  // This device was dropped from `from`, joined another call within the
  // window, and is now happily in it. Without the gate the stale marker would
  // yank it out of the call it is actually in to redeem a move it has already
  // moved past — a moderator's action reaching backwards through a call the
  // user chose afterwards.
  assert.deepEqual(
    decide({
      callState: "CONNECTED",
      currentChannelId: ELSEWHERE,
      ...droppedFrom(FROM, 250),
    }),
    { action: "ignore", reason: "other-channel" },
  );
  // The same on a bare seat: `CONNECTED` retires the marker before step 5 can
  // see it, so this is a silent ignore and not a card.
  assert.deepEqual(
    decide({
      callState: "CONNECTED",
      currentChannelId: ELSEWHERE,
      ...UNVERIFIED,
      ...droppedFrom(FROM, 250),
    }),
    { action: "ignore", reason: "other-channel" },
  );
  // And it retires the marker for step 6 too, at every age inside the notice
  // window — a session in a healthy call somewhere else gets no toast about a
  // channel it left of its own accord.
  for (const ago of [250, STALE_MS, MOVE_NOTICE_WINDOW_MS - 1])
    assert.deepEqual(
      decide({
        callState: "CONNECTED",
        currentChannelId: ELSEWHERE,
        ...droppedFrom(FROM, ago),
      }),
      { action: "ignore", reason: "other-channel" },
    );
});

test("an unrecognized call state is not treated as connected", () => {
  // Step 3 is `=== "CONNECTED"`, not a deny-list: a state string this module
  // has never heard of must not fall through into a join on its own.
  assert.deepEqual(
    decide({
      callState: "IDLE",
      currentChannelId: undefined,
      lastInvoluntaryChannelId: undefined,
      lastInvoluntaryLeftAt: undefined,
    }),
    { action: "ignore", reason: "not-in-call" },
  );
  // And conversely it is not treated as connected on the way OUT either: an
  // unknown state with a fresh drop marker is addressed, because whatever
  // that state is, it is not us sitting in a healthy room somewhere else.
  assert.deepEqual(
    decide({
      callState: "IDLE",
      currentChannelId: undefined,
      ...droppedFrom(FROM, 250),
    }),
    MOVED,
  );
});

test("a connected session with no channel id still ignores", () => {
  assert.deepEqual(decide({ currentChannelId: undefined }), {
    action: "ignore",
    reason: "other-channel",
  });
});

test("🔴 an off-call session that also cannot resolve the move stays SILENT", () => {
  // PRECEDENCE, not a branch. Off-call AND unknown destination AND no URL:
  // all three rules apply and only the first may answer. If `fail-loud` ever
  // wins here, one move raises an error toast on every signed-in device the
  // user owns, each about a call that device is not in.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      destinationKnown: false,
      url: undefined,
    }),
    { action: "ignore", reason: "not-in-call" },
  );
  // Silent for a bare seat too, as long as it holds no marker for `from`:
  // steps 5 and 6 are about an unresolvable or late CLAIM, not about being
  // unverifiable.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      destinationKnown: false,
      url: undefined,
    }),
    { action: "ignore", reason: "not-in-call" },
  );
});

test("🔴 a session in another channel outranks both failure reasons too", () => {
  // The second addressing test has the same precedence duty as the first: a
  // device in an unrelated call is no more entitled to the error than an
  // idle one.
  assert.deepEqual(
    decide({
      currentChannelId: ELSEWHERE,
      destinationKnown: false,
      url: "",
    }),
    { action: "ignore", reason: "other-channel" },
  );
});

test("🔴 step 5 outranks unknown-channel and the tokenless join", () => {
  // PRECEDENCE, and it decides WHICH answer the user gets. A session that
  // cannot prove it was the target must not be told why it failed to carry
  // out a move it was never allowed to carry out: `unknown-channel` reads as
  // "you were moved and something broke", which for an idle seat holding a
  // handoff's marker is a lie. Nor may it take the tokenless `join`, which
  // would be the same forgery by the regular join route. The reason must stay
  // the one that is true — we cannot tell whether this was you.
  for (const spoiled of [
    { destinationKnown: false },
    { url: undefined },
    { url: "   " },
    { destinationKnown: false, url: undefined },
    { token: undefined, tokenForThisConnection: false },
  ])
    assert.deepEqual(
      decide({
        ...OFF_CALL,
        ...UNVERIFIED,
        ...droppedFrom(FROM, 250),
        ...spoiled,
      }),
      { action: "fail-loud", reason: "unverified-session" },
    );
});

test("unknown-channel is reported before the tokenless join", () => {
  // Both spoiled: the more specific answer wins. A client that cannot
  // resolve the channel has nothing to join either, with or without a token.
  for (const spoiled of [
    { url: undefined },
    { token: undefined },
    { url: undefined, token: undefined },
  ])
    assert.deepEqual(decide({ destinationKnown: false, ...spoiled }), {
      action: "fail-loud",
      reason: "unknown-channel",
    });
});

test("D2 — an absent, empty or whitespace-only URL takes the tokenless join, not no-url", () => {
  // Retargeted from `no-url` by FE-2 ruling D2. A blank node URL still must
  // not reach `room.connect()` — it is a malformed endpoint that fails far
  // from here with an SDK error that names nothing — but the server has
  // already moved the user, and the regular join route reaches the
  // destination without the event's URL. The `join` carries `to` and
  // NOTHING else: no URL, and above all no token.
  for (const url of [undefined, "", "   ", "\t\n"]) {
    assert.deepEqual(decide({ url }), { action: "join", to: TO });
  }
});

test("the happy path moves and carries url, token and to through unchanged", () => {
  // The decision does not normalize: whatever `state.tsx` resolved is what
  // `room.connect()` is handed.
  assert.deepEqual(decide(), MOVED);
});

test("a padded but non-empty URL is passed through verbatim, not trimmed", () => {
  // The emptiness test uses `trim()`, which must not leak into the payload:
  // silently rewriting a connect URL would hide a malformed node row.
  const padded = ` ${NODE_URL} `;
  assert.deepEqual(decide({ url: padded }), {
    action: "move",
    url: padded,
    token: TOKEN,
    to: TO,
  });
});

test("D2 — an absent or empty token takes the tokenless join; it is no longer handed to the SFU", () => {
  // Retargeted from "an empty token still moves" by FE-2 ruling D2. The
  // merged backend leaves the token out whenever it cannot tie one to the
  // recorded seat, so an absent token is the server's ordinary answer, not a
  // malformed one: the addressed session joins `to` through the regular join
  // route, which mints its own credential and checks the binding itself. An
  // empty string is the same absence (stoat.js normalizes it to `undefined`,
  // and this module does not rely on that).
  for (const token of [undefined, ""]) {
    assert.deepEqual(decide({ token }), { action: "join", to: TO });
    // Whatever the token-for-this-connection flag claims: it cannot conjure
    // a credential that is not there.
    assert.deepEqual(decide({ token, tokenForThisConnection: true }), {
      action: "join",
      to: TO,
    });
  }
});

// --- The per-connection nonce --------------------------------------------
//
// The event names device DEVICE and connection NONCE: a device-qualified
// mover. The sessions below are the OTHER connections of the same user that
// the private event also reaches.

test('🔴 CONN_NONCE_ATTRIBUTE is the literal "conn" — the backend\'s key', () => {
  // A manual cross-repo contract: the backend mints the nonce into the token
  // under `voice_client::CONN_NONCE_ATTRIBUTE` and reads it back off
  // `list_participants` by the same key. Nothing generated ties the two, and
  // a drift is SILENT: this client reads no nonce, the gate goes inactive on
  // every seat, and moves quietly fall back to the device ladder. Asserted as
  // a LITERAL, not against another constant, because the backend's own tests
  // assert the same literal on their side.
  assert.equal(CONN_NONCE_ATTRIBUTE, "conn");
});

test("🔴 P-1 — a CONNECTED bare sibling of a device-qualified mover is moved-elsewhere, not silent", () => {
  // The hole the nonce was brought in to close. Two connections of one user
  // sit in `from`: the mover as `{user}:DEVICE`, a bare seat as `{user}`.
  // The identities differ, so LiveKit let both in. The event names DEVICE,
  // and under step 1 the bare seat is `other-device`, which is SILENT. But
  // the server evicts it as a sibling of the moved connection, and if that
  // drop fails open in `shouldAutoRejoin` it dials `from` back with
  // `forceDisconnect`, kicking the seat that was just moved. The nonce names
  // the connection, so it REPLACES step 1 here rather than running behind it.
  const sibling = {
    deviceId: DEVICE,
    sessionDeviceId: undefined,
    connNonce: NONCE,
    sessionConnNonce: OTHER_NONCE,
  };
  assert.deepEqual(decide(sibling), {
    action: "fail-loud",
    reason: "moved-elsewhere",
  });
  // The same world with the session's nonce gone is the old answer: the gate
  // needs both sides, and without it step 1 still speaks.
  assert.deepEqual(decide({ ...sibling, sessionConnNonce: undefined }), {
    action: "ignore",
    reason: "other-device",
  });
});

test("🔴 P-1 — a bare sibling holding a FRESH marker is moved-elsewhere, not silent", () => {
  // The marker-shape twin: the sibling has already been dropped, either by
  // the eviction or by an unrelated handoff, and holds a fresh marker for
  // `from` recorded against its OWN connection's nonce. Silence here is the
  // same kick-back as above, because the drop may be RECONNECTING and
  // dialing `from`.
  for (const callState of ["DISCONNECTED", "RECONNECTING"])
    assert.deepEqual(
      decide({
        callState,
        currentChannelId: callState === "RECONNECTING" ? FROM : undefined,
        deviceId: DEVICE,
        sessionDeviceId: undefined,
        connNonce: NONCE,
        lastInvoluntaryConnNonce: OTHER_NONCE,
        ...droppedFrom(FROM, 250),
      }),
      { action: "fail-loud", reason: "moved-elsewhere" },
    );
  // A verified device holding a marker for ANOTHER connection is excluded
  // the same way. Two tabs of one browser share an E2EE device id, and the
  // nonce is the only thing here that tells them apart.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      connNonce: NONCE,
      lastInvoluntaryConnNonce: OTHER_NONCE,
      ...droppedFrom(FROM, 250),
    }),
    { action: "fail-loud", reason: "moved-elsewhere" },
  );
});

test("🔴 a BARE seat with a fresh marker and a MATCHING nonce moves — step 5 is retired for it", () => {
  // The permanent fix step 5's trade was waiting for. Before the nonce this
  // exact seat got `unverified-session` and a manual Rejoin; with both sides
  // carrying the moved connection's nonce it is positively the target and
  // moves automatically like a verified device would.
  const bareTarget = {
    ...OFF_CALL,
    ...UNVERIFIED,
    connNonce: NONCE,
    lastInvoluntaryConnNonce: NONCE,
  };
  assert.deepEqual(decide({ ...bareTarget, ...droppedFrom(FROM, 250) }), MOVED);
  // It is ADDRESSED, not merely allowed through, so feasibility is reachable.
  assert.deepEqual(
    decide({
      ...bareTarget,
      destinationKnown: false,
      ...droppedFrom(FROM, 250),
    }),
    { action: "fail-loud", reason: "unknown-channel" },
  );
  // And the verified window still bounds it. At the boundary the token cannot
  // be relied on, and a MATCHING nonce there is the same too-late notice as
  // before.
  assert.deepEqual(
    decide({ ...bareTarget, ...droppedFrom(FROM, MOVE_VERIFIED_WINDOW_MS) }),
    { action: "fail-loud", reason: "stale-notice" },
  );
});

test("🔴 when the gate is active the nonce REPLACES the device test, in both directions", () => {
  // Matching nonce, mismatched device: addressed. Step 1 would have said
  // `other-device`, but the nonce names the connection, and this is it.
  assert.deepEqual(
    decide({
      deviceId: DEVICE,
      sessionDeviceId: OTHER_DEVICE,
      connNonce: NONCE,
      sessionConnNonce: NONCE,
    }),
    MOVED,
  );
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      deviceId: DEVICE,
      sessionDeviceId: OTHER_DEVICE,
      connNonce: NONCE,
      lastInvoluntaryConnNonce: NONCE,
      ...droppedFrom(FROM, 250),
    }),
    MOVED,
  );
  // Matching device, mismatched nonce: another connection on the same device,
  // which the device test cannot tell apart and the nonce can.
  assert.deepEqual(
    decide({ connNonce: NONCE, sessionConnNonce: OTHER_NONCE }),
    { action: "fail-loud", reason: "moved-elsewhere" },
  );
});

test("🔴 P-16 — a STALE marker with an unequal nonce is moved-elsewhere, not stale-notice", () => {
  // `stale-notice` says the move reached this device too late to follow, which
  // is false for a connection the move never named. On both device
  // populations, and on the fail-open RECONNECTING shape.
  for (const world of [
    { ...OFF_CALL },
    { ...OFF_CALL, ...UNVERIFIED },
    { callState: "RECONNECTING", currentChannelId: FROM },
  ])
    for (const ago of [
      MOVE_VERIFIED_WINDOW_MS,
      STALE_MS,
      MOVE_NOTICE_WINDOW_MS - 1,
    ])
      assert.deepEqual(
        decide({
          ...world,
          connNonce: NONCE,
          lastInvoluntaryConnNonce: OTHER_NONCE,
          ...droppedFrom(FROM, ago),
        }),
        { action: "fail-loud", reason: "moved-elsewhere" },
      );
  // A MATCHING nonce on a stale marker is the true too-late case, unchanged.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      connNonce: NONCE,
      lastInvoluntaryConnNonce: NONCE,
      ...droppedFrom(FROM, STALE_MS),
    }),
    { action: "fail-loud", reason: "stale-notice" },
  );
});

test("🔴 G1 — a nonce on ONE side only leaves the old answer exactly as it was", () => {
  // Server and client read the nonce off the same SFU data, so if the fork
  // does not carry token attributes, both sides lack one together. A one-sided
  // nonce is an absence, not a mismatch. Read as a mismatch, it would call
  // the real target "elsewhere" and strand it. Each row asserts the literal
  // old answer AND that it equals the same world with no nonce at all.
  const rows: [Partial<MoveWorld>, MoveDecision][] = [
    // Event names a connection; this session read none.
    [{ connNonce: NONCE }, MOVED],
    [
      { connNonce: NONCE, deviceId: DEVICE, sessionDeviceId: undefined },
      { action: "ignore", reason: "other-device" },
    ],
    [
      {
        ...OFF_CALL,
        ...UNVERIFIED,
        connNonce: NONCE,
        ...droppedFrom(FROM, 250),
      },
      { action: "fail-loud", reason: "unverified-session" },
    ],
    // The CLAUSE matters: a live-connection nonce must not stand in for the
    // marker's, nor the marker's for the live one.
    [
      {
        ...OFF_CALL,
        ...UNVERIFIED,
        connNonce: NONCE,
        sessionConnNonce: NONCE,
        ...droppedFrom(FROM, 250),
      },
      { action: "fail-loud", reason: "unverified-session" },
    ],
    [{ connNonce: NONCE, lastInvoluntaryConnNonce: OTHER_NONCE }, MOVED],
    // This session holds one; the event names none.
    [{ sessionConnNonce: OTHER_NONCE }, MOVED],
    [
      {
        ...OFF_CALL,
        ...UNVERIFIED,
        lastInvoluntaryConnNonce: OTHER_NONCE,
        ...droppedFrom(FROM, STALE_MS),
      },
      { action: "fail-loud", reason: "stale-notice" },
    ],
    // `""` is absent on either side, never a value to compare.
    [{ connNonce: "", sessionConnNonce: "" }, MOVED],
    [{ connNonce: NONCE, sessionConnNonce: "" }, MOVED],
    [{ connNonce: "", sessionConnNonce: OTHER_NONCE }, MOVED],
  ];
  for (const [world, expected] of rows) {
    assert.deepEqual(decide(world), expected, JSON.stringify(world));
    assert.deepEqual(
      decide(world),
      decide({ ...world, ...NO_NONCES }),
      JSON.stringify(world),
    );
  }
});

test("🔴 moved-elsewhere outranks the feasibility answers and never moves", () => {
  // It sits on the addressing side of the line: a session that was positively
  // NOT the target must not be told `unknown-channel`, which reads as "you
  // were moved and something broke", nor take the tokenless `join`, nor be
  // told the destination is gated (it was never going to go there).
  for (const spoiled of [
    { destinationKnown: false },
    { url: undefined },
    { url: "   " },
    { destinationKnown: false, url: undefined },
    { token: "" },
    { token: undefined, tokenForThisConnection: false },
    { destinationGated: true },
  ])
    for (const shape of [
      { sessionConnNonce: OTHER_NONCE },
      {
        ...OFF_CALL,
        lastInvoluntaryConnNonce: OTHER_NONCE,
        ...droppedFrom(FROM, 250),
      },
    ]) {
      const decision = decide({ connNonce: NONCE, ...shape, ...spoiled });
      assert.notEqual(decision.action, "move");
      assert.deepEqual(decision, {
        action: "fail-loud",
        reason: "moved-elsewhere",
      });
    }
});

test("🔴 already-there outranks moved-elsewhere — nothing moved, nothing is being evicted", () => {
  // Step 2's ruling extends to the new loud arm: `moved-elsewhere` tells the
  // user another connection was moved and this one is being removed, which is
  // false when `from === to`.
  for (const shape of [
    { sessionConnNonce: OTHER_NONCE, currentChannelId: FROM },
    {
      ...OFF_CALL,
      lastInvoluntaryConnNonce: OTHER_NONCE,
      ...droppedFrom(FROM, 250),
    },
  ])
    assert.deepEqual(
      decide({ connNonce: NONCE, ...shape, from: FROM, to: FROM }),
      { action: "ignore", reason: "already-there" },
    );
});

test("🔴 step-7 bystanders stay SILENT whatever the nonces say", () => {
  // The gate only applies to a session in an addressing shape. A seat in
  // another call, one in no call, or one whose marker names another channel
  // or has aged out has no nonce to compare. It must stay silent, because
  // otherwise every device the user owns raises a card on every move.
  const unequal = {
    connNonce: NONCE,
    sessionConnNonce: OTHER_NONCE,
    lastInvoluntaryConnNonce: OTHER_NONCE,
  };
  assert.deepEqual(decide({ ...unequal, currentChannelId: ELSEWHERE }), {
    action: "ignore",
    reason: "other-channel",
  });
  assert.deepEqual(
    decide({
      ...unequal,
      currentChannelId: ELSEWHERE,
      ...droppedFrom(FROM, 250),
    }),
    { action: "ignore", reason: "other-channel" },
  );
  for (const marker of [
    {},
    droppedFrom(ELSEWHERE, 250),
    droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS),
  ])
    assert.deepEqual(
      decide({ ...OFF_CALL, ...UNVERIFIED, ...unequal, ...marker }),
      {
        action: "ignore",
        reason: "not-in-call",
      },
    );
  // A bystander on another device keeps its old `other-device` answer too:
  // with no addressing shape, the gate is inactive and step 1 still speaks.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...unequal, sessionDeviceId: OTHER_DEVICE }),
    { action: "ignore", reason: "other-device" },
  );
});

// --- S-a: the connection named is this session's own, under another nonce --
//
// Window (ii): dropped from `from` as OTHER_NONCE, the rejoin is dialing
// `from` as NONCE, the SFU already lists NONCE, and the event names it.
// Window (v): the rejoin is CONNECTED to `from` as OTHER_NONCE, and a late
// event names the ghost NONCE it replaced. Without S-a both are told
// `moved-elsewhere`, the moved seat stays out of the destination, and the
// moderator is silently undone.

/** Window (ii): a rejoin of `from`, still dialing, whose pending nonce the event names. */
const dialing = (agoMs: number) => ({
  callState: "CONNECTING",
  currentChannelId: FROM,
  connNonce: NONCE,
  lastInvoluntaryConnNonce: OTHER_NONCE,
  pendingConnNonce: NONCE,
  ...droppedFrom(FROM, agoMs),
});

/** Window (v): a CONNECTED rejoin of `from` whose replaced ghost the event names. */
const rejoined = (agoMs: number) => ({
  callState: "CONNECTED",
  currentChannelId: FROM,
  connNonce: NONCE,
  sessionConnNonce: OTHER_NONCE,
  replacedConnNonce: NONCE,
  replacedLeftAt: NOW - agoMs,
});

const MOVED_ELSEWHERE: MoveDecision = {
  action: "fail-loud",
  reason: "moved-elsewhere",
};
const STALE_NOTICE: MoveDecision = {
  action: "fail-loud",
  reason: "stale-notice",
};

test("🔴 S-a (ii) — a rejoin still DIALING `from` moves when the event names its pending nonce", () => {
  // Every marker age inside the notice window, which is exactly where the
  // gate is active for the marker shape. The pending connection is the one
  // the server just listed, so its move token is as fresh as step 3's and
  // the marker's age does not bound it.
  for (const callState of ["CONNECTING", "RECONNECTING"])
    for (const ago of [
      250,
      MOVE_VERIFIED_WINDOW_MS - 1,
      MOVE_VERIFIED_WINDOW_MS,
      STALE_MS,
      MOVE_NOTICE_WINDOW_MS - 1,
    ]) {
      const world = { ...dialing(ago), callState };
      // Without S-a this exact world is `moved-elsewhere`.
      assert.deepEqual(decide({ ...world, pendingConnNonce: undefined }), {
        action: "fail-loud",
        reason: "moved-elsewhere",
      });
      assert.deepEqual(decide(world), MOVED, JSON.stringify(world));
      // The nonce replaces the device test here too, on both populations.
      assert.deepEqual(decide({ ...world, ...UNVERIFIED }), MOVED);
      assert.deepEqual(
        decide({ ...world, sessionDeviceId: OTHER_DEVICE }),
        MOVED,
      );
    }
  // Addressed, so feasibility is reachable, in its usual order.
  assert.deepEqual(decide({ ...dialing(250), destinationKnown: false }), {
    action: "fail-loud",
    reason: "unknown-channel",
  });
  for (const url of [undefined, "", "  "])
    assert.deepEqual(decide({ ...dialing(250), url }), {
      action: "join",
      to: TO,
    });
  assert.deepEqual(decide({ ...dialing(250), token: undefined }), {
    action: "join",
    to: TO,
  });
});

test("🔴 S-a (ii) — adversarial: only THIS session's own dialing connection is addressed", () => {
  // A sibling that is dialing `from` under its OWN rejoin: a different
  // pending nonce, so the move was not its. It must stay loud-and-disarmed.
  assert.deepEqual(
    decide({ ...dialing(250), pendingConnNonce: THIRD_NONCE }),
    MOVED_ELSEWHERE,
  );
  assert.deepEqual(
    decide({ ...dialing(250), pendingConnNonce: OTHER_NONCE }),
    MOVED_ELSEWHERE,
  );
  // The pending nonce matches, but what is being dialed is not `from`, or
  // nothing is. The match must not be taken off the nonce alone.
  for (const currentChannelId of [ELSEWHERE, undefined])
    assert.deepEqual(
      decide({ ...dialing(250), currentChannelId }),
      MOVED_ELSEWHERE,
      String(currentChannelId),
    );
  assert.deepEqual(
    decide({
      ...dialing(250),
      callState: "DISCONNECTED",
      currentChannelId: undefined,
    }),
    MOVED_ELSEWHERE,
  );
  // The pending nonce is read in the MARKER shape only. A CONNECTED session
  // in `from` whose live nonce differs is judged by its live nonce and, for
  // S-a, by what its rejoin replaced — never by a pending value.
  assert.deepEqual(
    decide({
      callState: "CONNECTED",
      currentChannelId: FROM,
      connNonce: NONCE,
      sessionConnNonce: OTHER_NONCE,
      pendingConnNonce: NONCE,
    }),
    MOVED_ELSEWHERE,
  );
  // G1: the gate is not active for the marker shape, so the pending nonce is
  // never read and the answer is the pre-S-a one, literally. On a BARE seat,
  // so that the old answer is not already a move: a matching pending nonce
  // must not rescue step 5's card into an automatic move.
  const bare = { ...dialing(250), ...UNVERIFIED };
  const unverified: MoveDecision = {
    action: "fail-loud",
    reason: "unverified-session",
  };
  const silent: MoveDecision = { action: "ignore", reason: "not-in-call" };
  for (const [world, expected] of [
    // No marker nonce: one-sided.
    [{ ...bare, lastInvoluntaryConnNonce: undefined }, unverified],
    [{ ...bare, lastInvoluntaryConnNonce: "" }, unverified],
    // No event nonce: one-sided, and `""` equals `""` is still no match.
    [{ ...bare, connNonce: undefined }, unverified],
    [{ ...bare, connNonce: "", pendingConnNonce: "" }, unverified],
    // The marker has aged out of the notice window.
    [{ ...bare, ...droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS) }, silent],
    // The marker names another channel.
    [{ ...bare, ...droppedFrom(ELSEWHERE, 250) }, silent],
  ] as [Partial<MoveWorld>, MoveDecision][]) {
    assert.deepEqual(decide(world), expected, JSON.stringify(world));
    assert.deepEqual(
      decide(world),
      decide({ ...world, ...NO_SA }),
      JSON.stringify(world),
    );
  }
});

test("🔴 S-a (v) — a CONNECTED rejoin answers a late event naming the ghost it replaced, by the ORIGINAL drop's age", () => {
  // Inside the verified window: a move, like the marker it was carried from.
  for (const ago of [0, 250, MOVE_VERIFIED_WINDOW_MS - 1]) {
    assert.deepEqual(
      decide({ ...rejoined(ago), replacedConnNonce: undefined }),
      MOVED_ELSEWHERE,
      "without S-a this world is moved-elsewhere",
    );
    assert.deepEqual(decide(rejoined(ago)), MOVED, String(ago));
    assert.deepEqual(decide({ ...rejoined(ago), ...UNVERIFIED }), MOVED);
    assert.deepEqual(
      decide({ ...rejoined(ago), sessionDeviceId: OTHER_DEVICE }),
      MOVED,
    );
  }
  // From the verified window's boundary to inside the notice window: too
  // late to act, not someone else's — the marker's own `stale-notice`.
  for (const ago of [
    MOVE_VERIFIED_WINDOW_MS,
    STALE_MS,
    MOVE_NOTICE_WINDOW_MS - 1,
  ])
    assert.deepEqual(decide(rejoined(ago)), STALE_NOTICE, String(ago));
  // At and past the notice window: unchanged.
  for (const ago of [
    MOVE_NOTICE_WINDOW_MS,
    MOVE_NOTICE_WINDOW_MS + 1,
    3_600_000,
  ])
    assert.deepEqual(decide(rejoined(ago)), MOVED_ELSEWHERE, String(ago));
  // Addressed inside the verified window, so feasibility is reachable…
  assert.deepEqual(decide({ ...rejoined(250), destinationKnown: false }), {
    action: "fail-loud",
    reason: "unknown-channel",
  });
  assert.deepEqual(decide({ ...rejoined(250), url: "  " }), {
    action: "join",
    to: TO,
  });
  // …and the stale arm outranks it, as step 6 does.
  assert.deepEqual(
    decide({
      ...rejoined(STALE_MS),
      destinationKnown: false,
      url: undefined,
    }),
    STALE_NOTICE,
  );
});

test("🔴 S-a (v) — adversarial: a replaced nonce buys nothing outside its own shape", () => {
  // No timestamp for the replaced drop: nothing to age, so nothing changes.
  assert.deepEqual(
    decide({ ...rejoined(250), replacedLeftAt: undefined }),
    MOVED_ELSEWHERE,
  );
  // A replaced nonce that is not the one named — a sibling's ghost.
  for (const replacedConnNonce of [THIRD_NONCE, OTHER_NONCE, "", undefined])
    assert.deepEqual(
      decide({ ...rejoined(250), replacedConnNonce }),
      MOVED_ELSEWHERE,
      String(replacedConnNonce),
    );
  // The replaced nonce matches, but the session is in the MARKER shape: it is
  // judged by its marker nonce and, for S-a, by what it is dialing — never
  // by a replaced value.
  for (const callState of ["DISCONNECTED", "RECONNECTING", "CONNECTING"])
    assert.deepEqual(
      decide({
        callState,
        currentChannelId: callState === "DISCONNECTED" ? undefined : FROM,
        connNonce: NONCE,
        lastInvoluntaryConnNonce: OTHER_NONCE,
        ...droppedFrom(FROM, 250),
        replacedConnNonce: NONCE,
        replacedLeftAt: NOW - 250,
      }),
      MOVED_ELSEWHERE,
      callState,
    );
  // The replaced nonce matches, but the session is CONNECTED elsewhere: a
  // bystander, silent as it always was.
  assert.deepEqual(decide({ ...rejoined(250), currentChannelId: ELSEWHERE }), {
    action: "ignore",
    reason: "other-channel",
  });
  // G1: this session read no live nonce, so the gate is inactive and step 1
  // speaks exactly as before, however well the replaced nonce matches.
  const deviceRows: [Partial<MoveWorld>, MoveDecision][] = [
    [
      { sessionDeviceId: OTHER_DEVICE },
      { action: "ignore", reason: "other-device" },
    ],
    [{}, MOVED],
  ];
  for (const sessionConnNonce of [undefined, ""])
    for (const [devices, expected] of deviceRows) {
      const world: Partial<MoveWorld> = {
        ...rejoined(250),
        sessionConnNonce,
        ...devices,
      };
      assert.deepEqual(decide(world), expected, JSON.stringify(world));
      assert.deepEqual(decide(world), decide({ ...world, ...NO_SA }));
    }
});

test("🔴 S-a never outranks already-there, and never touches an EQUAL-nonce answer", () => {
  // Nothing moved, so nothing — S-a included — may claim it did.
  for (const world of [dialing(250), rejoined(250)])
    assert.deepEqual(decide({ ...world, from: FROM, to: FROM }), {
      action: "ignore",
      reason: "already-there",
    });
  // Equal nonces never reach the S-a arms. A matching live nonce moves as
  // before, and a matching STALE marker is the step-6 `stale-notice` even
  // when a pending nonce also matches.
  assert.deepEqual(
    decide({ ...rejoined(STALE_MS), sessionConnNonce: NONCE }),
    MOVED,
  );
  assert.deepEqual(
    decide({ ...dialing(STALE_MS), lastInvoluntaryConnNonce: NONCE }),
    STALE_NOTICE,
  );
});

// --- FE-2: the token proof, the tokenless arm and the gated destination -----
//
// `seat(identity, tokenSub)` models what `state.tsx` resolves for a seat: the
// identity this connection last joined as (`{user}` or `{user}:{device}`),
// and the `sub` claim of the token the event carries (`undefined` when it
// carries none). The event names a device exactly when the token is a device
// token (the server derives both from the same recorded seat). This is a
// fixture for the INPUTS, not a restatement of the rule under test.

const USER = "01JUSERAAAAAAAAAAAAAAAAAAA";
const DEVICE_ID = `${USER}:${DEVICE}`;
const OTHER_DEVICE_ID = `${USER}:${OTHER_DEVICE}`;

const seat = (identity: string, tokenSub: string | undefined) => ({
  sessionDeviceId: identity.includes(":") ? identity.split(":")[1] : undefined,
  deviceId: tokenSub?.includes(":") ? tokenSub.split(":")[1] : undefined,
  token: tokenSub === undefined ? undefined : TOKEN,
  tokenForThisConnection: tokenSub !== undefined && tokenSub === identity,
  lastIdentityIsDevice: identity.includes(":"),
});

const UNVERIFIED_SESSION: MoveDecision = {
  action: "fail-loud",
  reason: "unverified-session",
};
const JOINED: MoveDecision = { action: "join", to: TO };
const GATED: MoveDecision = {
  action: "fail-loud",
  reason: "gated-destination",
};

test("🔴 FE2A-2 — a fresh marker on a BARE identity with a matching bare token and no nonce is unverified-session", () => {
  // The amended D1, and the reason it was amended. The merged backend sends
  // no `conn_nonce` and no `device_id` with a bare mint, so the nonce gate is
  // off on every bare seat, and a bare token's `sub` is `{user}` — the
  // identity EVERY bare seat of this user shares. A bare seat kicked by a
  // handoff a moment before the move holds a fresh marker and a token whose
  // `sub` equals its own last identity. Letting that address it would follow
  // the move with a live microphone: the F1-class double redemption.
  for (const callState of ["DISCONNECTED", "RECONNECTING", "CONNECTING"])
    for (const ago of [0, 250, MOVE_VERIFIED_WINDOW_MS - 1]) {
      const world = {
        callState,
        currentChannelId: callState === "DISCONNECTED" ? undefined : FROM,
        ...seat(USER, USER),
        ...droppedFrom(FROM, ago),
      };
      // The fixture really is the "matching bare token" shape.
      assert.equal(world.tokenForThisConnection, true);
      assert.equal(world.lastIdentityIsDevice, false);
      assert.deepEqual(
        decide(world),
        UNVERIFIED_SESSION,
        `${callState} ${ago}`,
      );
    }
});

test("🔴 FE2A-2 — a fresh marker with a device token for `U:D` on identity `U:D` and no nonce MOVES", () => {
  // The device seat the rule is for: the token names exactly the identity
  // this connection joined as, and that identity names a device. This is
  // the old device match plus a credential this session can redeem.
  for (const callState of ["DISCONNECTED", "RECONNECTING"])
    assert.deepEqual(
      decide({
        callState,
        currentChannelId: callState === "DISCONNECTED" ? undefined : FROM,
        ...seat(DEVICE_ID, DEVICE_ID),
        ...droppedFrom(FROM, 250),
      }),
      MOVED,
      callState,
    );
});

test("🔴 FE2A-10 — a fresh marker with a BARE token on identity `U:D`, no nonce and no device, is unverified-session", () => {
  // The token names `{user}`; this connection joined as `{user}:{device}`.
  // It is not this connection's credential, and redeeming it would present
  // an identity this session did not join as. Loud, and no microphone.
  const world = {
    ...OFF_CALL,
    ...seat(DEVICE_ID, USER),
    ...droppedFrom(FROM, 250),
  };
  assert.equal(world.deviceId, undefined);
  assert.equal(world.tokenForThisConnection, false);
  assert.deepEqual(decide(world), UNVERIFIED_SESSION);
});

test("🔴 FE2A-10 / FE2WA-9 — CONNECTED to `from` with a BARE token on a device identity is the tokenless `join`", () => {
  // Step 3 is exact on its own, so the connected seat is addressed whatever
  // the token says. But the token is NOT this connection's credential: it
  // names `{user}`, this connection joined as `{user}:{device}`. Ruling
  // FE2WA-9 (fail-closed): such a token is never passed through, so the seat
  // follows through the regular join route as the identity it holds.
  // (`state.tsx`'s M3 check would drop it too; this module no longer
  // depends on that.) Rewritten from the FE2A-10 expectation of `move`.
  assert.deepEqual(decide({ ...seat(DEVICE_ID, USER) }), JOINED);
  // Every addressed shape, not just step 3: a foreign token on the Na and
  // Nb (verified) arms joins too, and never reaches the SFU.
  for (const world of [dialing(250), rejoined(250)])
    assert.deepEqual(
      decide({ ...world, tokenForThisConnection: false }),
      JOINED,
      JSON.stringify(world),
    );
  // And its own token, with a URL, is still the token arm.
  assert.deepEqual(decide({ ...seat(DEVICE_ID, DEVICE_ID) }), MOVED);
});

test("🔴 FE2WA-2 — the step-4 proof needs an ACTUAL token: a 'for this connection' flag with no token is unverified-session", () => {
  // Fresh marker, device-qualified identity, the flag claiming the token is
  // this connection's — and no token at all, or an empty one. There is no
  // credential to have been minted for anyone, so nothing proves the marker:
  // loud, no microphone, and in particular NOT the tokenless join that a
  // proof-less marker would otherwise buy.
  for (const token of [undefined, ""])
    for (const callState of ["DISCONNECTED", "RECONNECTING"])
      for (const ago of [0, 250, MOVE_VERIFIED_WINDOW_MS - 1]) {
        const decision = decide({
          callState,
          currentChannelId: callState === "DISCONNECTED" ? undefined : FROM,
          token,
          tokenForThisConnection: true,
          lastIdentityIsDevice: true,
          ...NO_NONCES,
          ...droppedFrom(FROM, ago),
        });
        const where = `${JSON.stringify(token)} ${callState} ${ago}`;
        assert.notEqual(decision.action, "join", where);
        assert.deepEqual(decision, UNVERIFIED_SESSION, where);
      }
  // The nonce still addresses a tokenless marker: THAT is the tokenless
  // join off a marker, and it is proved by the connection, not the flag.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      token: undefined,
      tokenForThisConnection: true,
      connNonce: NONCE,
      lastInvoluntaryConnNonce: NONCE,
      ...droppedFrom(FROM, 250),
    }),
    JOINED,
  );
});

test("🔴 FE2WA-3 — a marker or replaced drop stamped in the FUTURE is not fresh: stale-notice, never a move", () => {
  // The wall clock stepped back after the drop, so `now - leftAt` is
  // negative and the drop's real age is unknown. Ported from voice-move's
  // "a removal stamped in the future does not obey": it must not buy an
  // automatic move on a token of unknown age. It is still a marker for
  // `from` under the notice bound, so it is told (`stale-notice`) rather
  // than silenced — fail closed, not quiet.
  for (const ago of [-1, -250, -MOVE_VERIFIED_WINDOW_MS, -3_600_000]) {
    // The marker, on both populations and on the nonce-proved shape.
    for (const shape of [
      { ...OFF_CALL },
      { ...OFF_CALL, ...UNVERIFIED },
      { callState: "RECONNECTING", currentChannelId: FROM },
      {
        ...OFF_CALL,
        ...UNVERIFIED,
        connNonce: NONCE,
        lastInvoluntaryConnNonce: NONCE,
      },
    ])
      assert.deepEqual(
        decide({ ...shape, ...droppedFrom(FROM, ago) }),
        STALE_NOTICE,
        `${ago} ${JSON.stringify(shape)}`,
      );
    // The Nb replaced drop, on the marker's own terms.
    assert.deepEqual(decide(rejoined(ago)), STALE_NOTICE, String(ago));
  }
  // Age zero is fresh; the boundary is `>= 0`, not `> 0`.
  assert.deepEqual(decide({ ...OFF_CALL, ...droppedFrom(FROM, 0) }), MOVED);
  assert.deepEqual(decide(rejoined(0)), MOVED);
});

test("🔴 FE2WA-4 — an empty `from` never acts, even against an empty channel or marker", () => {
  // Ported from voice-move's "an empty `from` never obeys, even against an
  // empty live channel". An empty `from` names no channel, so no session was
  // in it; it answers step 7's silent ignore, whatever else would match.
  const empty = { from: "" };
  for (const [shape, reason] of [
    [{ callState: "CONNECTED", currentChannelId: "" }, "other-channel"],
    [{ callState: "CONNECTED", currentChannelId: FROM }, "other-channel"],
    [{ ...OFF_CALL, ...droppedFrom("", 250) }, "not-in-call"],
    [
      {
        callState: "RECONNECTING",
        currentChannelId: "",
        ...droppedFrom("", 0),
      },
      "not-in-call",
    ],
    // Every nonce and S-a label matching, which would otherwise address it.
    [
      {
        ...OFF_CALL,
        ...droppedFrom("", 250),
        connNonce: NONCE,
        lastInvoluntaryConnNonce: NONCE,
      },
      "not-in-call",
    ],
    [{ ...rejoined(250), currentChannelId: "" }, "other-channel"],
    // Nothing else can speak first, `already-there` and `other-device`
    // included.
    [{ callState: "CONNECTED", currentChannelId: "", to: "" }, "other-channel"],
    [{ ...OFF_CALL, sessionDeviceId: OTHER_DEVICE }, "not-in-call"],
  ] as [Partial<MoveWorld>, string][])
    assert.deepEqual(
      decide({ ...shape, ...empty }),
      { action: "ignore", reason },
      JSON.stringify(shape),
    );
});

test("🔴 voice-move's PARTICIPANT_REMOVED-only filter is retired: the nonce gate tells the moved connection from a kicked sibling", () => {
  // voice-move obeyed a dropped session only when the SDK's disconnect
  // reason was `PARTICIPANT_REMOVED`. `state.tsx` records the involuntary
  // drop marker for EVERY reason instead (a removal can arrive with no
  // reason and fail open into a rejoin of the old channel), so this module
  // is handed no reason at all. What separates a sibling kicked by the
  // user's own other session from the moved connection is the nonce — and,
  // with no nonce, the token proof (the F1 tests above).
  const dropped = { ...OFF_CALL, ...droppedFrom(FROM, 250), connNonce: NONCE };
  assert.deepEqual(
    decide({ ...dropped, lastInvoluntaryConnNonce: OTHER_NONCE }),
    MOVED_ELSEWHERE,
  );
  assert.deepEqual(
    decide({ ...dropped, lastInvoluntaryConnNonce: NONCE }),
    MOVED,
  );
  // And there is no reason input to consult: no `MoveWorld` field names a
  // reason, and the module's code (comments stripped) never mentions the
  // SDK's disconnect reasons.
  const source = stripComments(
    readFileSync(new URL("./movePolicy.ts", import.meta.url), "utf8"),
  );
  const world =
    /export interface MoveWorld \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  assert.ok(world.includes("tokenForThisConnection:"), "MoveWorld not found");
  assert.doesNotMatch(world, /reason/i);
  assert.doesNotMatch(source, /PARTICIPANT_REMOVED|DisconnectReason/);
});

test("🔴 a marker needs the TOKEN proof when no nonce applies: marker + no token is unverified-session", () => {
  // A device seat the server minted nothing for: a device match with
  // nothing to redeem. On the marker path the only way on would be a
  // tokenless join off an unproven marker, which is the handoff forgery.
  // The event still names this device (after `seat`, which would clear it).
  const world = {
    ...OFF_CALL,
    ...seat(DEVICE_ID, undefined),
    deviceId: DEVICE,
    ...droppedFrom(FROM, 250),
  };
  // Under the pre-FE-2 ladder this device match MOVED; that is the change.
  assert.equal(world.deviceId, world.sessionDeviceId);
  assert.deepEqual(decide(world), UNVERIFIED_SESSION);
});

test("🔴 a bare seat with a matching bare token moves off a marker ONLY under a matching nonce", () => {
  // §2's "marker + bare matching token -> move", as FE2A-2 leaves it: the
  // token alone is refused (above); the nonce gate is what addresses a bare
  // seat off a marker, and it replaces the token proof when it is active.
  const bare = {
    ...OFF_CALL,
    ...seat(USER, USER),
    ...droppedFrom(FROM, 250),
  };
  assert.deepEqual(decide(bare), UNVERIFIED_SESSION);
  assert.deepEqual(
    decide({ ...bare, connNonce: NONCE, lastInvoluntaryConnNonce: NONCE }),
    MOVED,
  );
  assert.deepEqual(
    decide({
      ...bare,
      connNonce: NONCE,
      lastInvoluntaryConnNonce: OTHER_NONCE,
    }),
    { action: "fail-loud", reason: "moved-elsewhere" },
  );
});

test("🔴 the tokenless `join` in every addressed shape", () => {
  // CONNECTED to `from`, device and bare: the in-call seat follows with or
  // without a credential.
  for (const identity of [DEVICE_ID, USER]) {
    assert.deepEqual(decide({ ...seat(identity, undefined) }), JOINED);
    assert.deepEqual(decide({ ...seat(identity, identity), url: "" }), JOINED);
  }
  // Marker + matching nonce, on a bare seat the server minted no token for.
  const markerNonce = {
    ...OFF_CALL,
    ...seat(USER, undefined),
    connNonce: NONCE,
    lastInvoluntaryConnNonce: NONCE,
    ...droppedFrom(FROM, 250),
  };
  assert.deepEqual(decide(markerNonce), JOINED);
  // Marker + token proof, with no URL to dial the token at.
  const markerToken = {
    ...OFF_CALL,
    ...seat(DEVICE_ID, DEVICE_ID),
    ...droppedFrom(FROM, 250),
  };
  assert.deepEqual(decide(markerToken), MOVED);
  for (const url of [undefined, "", "  "])
    assert.deepEqual(decide({ ...markerToken, url }), JOINED);
  // …but a marker with NO token and no nonce is not addressed at all.
  assert.deepEqual(
    decide({ ...markerToken, ...seat(DEVICE_ID, undefined) }),
    UNVERIFIED_SESSION,
  );
});

test("🔴 F1 (voice-move) — a device kicked by the user's own other session does not follow that session's move", () => {
  // `join_call` with `force_disconnect` from the user's other session removes
  // this one, which then holds a fresh marker for `from` through nobody's
  // move. A move for the OTHER session carries a token for THAT session's
  // identity, never this one's. Following it would rejoin with the mic live
  // and kick the session the user is actually in. Every shape of "this seat"
  // x "the other seat's token", at every fresh age, on both the dropped and
  // the fail-open rejoin shape: never a move, never a tokenless join.
  const cases: [string, string | undefined, MoveDecision][] = [
    // Another device's token: step 1 excludes it, silently.
    [DEVICE_ID, OTHER_DEVICE_ID, { action: "ignore", reason: "other-device" }],
    [USER, OTHER_DEVICE_ID, { action: "ignore", reason: "other-device" }],
    // A bare token on a device seat: not this connection's credential.
    [DEVICE_ID, USER, UNVERIFIED_SESSION],
    // A bare token on a bare seat: the shared `{user}` (FE2A-2).
    [USER, USER, UNVERIFIED_SESSION],
    // No token at all: nothing proves the marker.
    [DEVICE_ID, undefined, UNVERIFIED_SESSION],
    [USER, undefined, UNVERIFIED_SESSION],
  ];
  for (const [identity, tokenSub, expected] of cases)
    for (const callState of ["DISCONNECTED", "RECONNECTING"])
      for (const ago of [0, 250, MOVE_VERIFIED_WINDOW_MS - 1]) {
        const decision = decide({
          callState,
          currentChannelId: callState === "DISCONNECTED" ? undefined : FROM,
          ...seat(identity, tokenSub),
          ...droppedFrom(FROM, ago),
        });
        const where = `${identity} ${tokenSub} ${callState} ${ago}`;
        assert.notEqual(decision.action, "move", where);
        assert.notEqual(decision.action, "join", where);
        assert.deepEqual(decision, expected, where);
      }
});

test("🔴 F1 (voice-move) — RECONNECTING into the source follows only with a token for this connection", () => {
  // The fail-open rejoin shape. With the proof it follows; without it, it is
  // loud and publishes nothing — including the device match that USED to
  // move here with no usable token.
  const reconnecting = {
    callState: "RECONNECTING",
    currentChannelId: FROM,
    ...droppedFrom(FROM, 1_000),
  };
  assert.deepEqual(
    decide({ ...reconnecting, ...seat(DEVICE_ID, DEVICE_ID) }),
    MOVED,
  );
  // The event still names this device, so the old device match holds; the
  // token is absent or bare, so the new proof does not.
  for (const tokenSub of [undefined, USER]) {
    const world = {
      ...reconnecting,
      ...seat(DEVICE_ID, tokenSub),
      deviceId: DEVICE,
    };
    assert.equal(world.deviceId, world.sessionDeviceId);
    assert.deepEqual(decide(world), UNVERIFIED_SESSION, String(tokenSub));
  }
});

test("🔴 F1 (voice-move) — by state and token: CONNECTED always follows, a marker only with the proof", () => {
  // A fresh marker for `from` and `currentChannelId === from` in every state.
  // CONNECTED retires the marker and is step 3 (addressed, token or not —
  // but a token that is not this connection's is never passed through, so
  // it follows by the tokenless join, FE2WA-9); every other state is the
  // marker shape, addressed only with the proof.
  for (const callState of [
    "READY",
    "DISCONNECTED",
    "CONNECTING",
    "CONNECTED",
    "RECONNECTING",
  ])
    for (const tokenForThisConnection of [false, true]) {
      const decision = decide({
        callState,
        currentChannelId: FROM,
        tokenForThisConnection,
        ...droppedFrom(FROM, 250),
      });
      assert.deepEqual(
        decision,
        tokenForThisConnection
          ? MOVED
          : callState === "CONNECTED"
            ? JOINED
            : UNVERIFIED_SESSION,
        `${callState} token=${tokenForThisConnection}`,
      );
    }
});

test("🔴 gated-destination — the full precedence table", () => {
  // The gate answers every addressed shape after `unknown-channel`, AND it
  // replaces the three loud arms that would card the destination (step 5,
  // step 6, the Nb stale arm): a card's Rejoin joins straight past the gate.
  // It never outranks an ignore, `already-there`, `moved-elsewhere` or
  // `unknown-channel`, and it is never read for an unknown destination.
  // Each row: [shape, answer ungated, answer gated].
  const stale = {
    ...OFF_CALL,
    ...droppedFrom(FROM, STALE_MS),
  };
  const rows: [string, Partial<MoveWorld>, MoveDecision, MoveDecision][] = [
    // Addressed: the feasibility tail.
    ["step 3, token arm", {}, MOVED, GATED],
    ["step 3, tokenless", { token: undefined }, JOINED, GATED],
    ["step 3, no URL", { url: undefined }, JOINED, GATED],
    [
      "step 4, token proof",
      { ...OFF_CALL, ...droppedFrom(FROM, 250) },
      MOVED,
      GATED,
    ],
    [
      "step 4, matching nonce",
      {
        ...OFF_CALL,
        ...UNVERIFIED,
        connNonce: NONCE,
        lastInvoluntaryConnNonce: NONCE,
        ...droppedFrom(FROM, 250),
      },
      MOVED,
      GATED,
    ],
    ["Na, dialing", dialing(250), MOVED, GATED],
    ["Nb, verified", rejoined(250), MOVED, GATED],
    // The carding loud arms.
    [
      "step 5",
      { ...OFF_CALL, ...UNVERIFIED, ...droppedFrom(FROM, 250) },
      UNVERIFIED_SESSION,
      GATED,
    ],
    ["step 6, device seat", stale, STALE_NOTICE, GATED],
    ["step 6, bare seat", { ...stale, ...UNVERIFIED }, STALE_NOTICE, GATED],
    [
      "step 6, matching nonce",
      { ...stale, connNonce: NONCE, lastInvoluntaryConnNonce: NONCE },
      STALE_NOTICE,
      GATED,
    ],
    ["Nb, stale", rejoined(STALE_MS), STALE_NOTICE, GATED],
    // Never outranked: an unknown destination has nothing to gate.
    [
      "unknown-channel",
      { destinationKnown: false },
      { action: "fail-loud", reason: "unknown-channel" },
      { action: "fail-loud", reason: "unknown-channel" },
    ],
    [
      "step 5, destination unknown",
      {
        ...OFF_CALL,
        ...UNVERIFIED,
        destinationKnown: false,
        ...droppedFrom(FROM, 250),
      },
      UNVERIFIED_SESSION,
      UNVERIFIED_SESSION,
    ],
    [
      "step 6, destination unknown",
      { ...stale, destinationKnown: false },
      STALE_NOTICE,
      STALE_NOTICE,
    ],
    // Never outranked: the arms that do not name the destination.
    [
      "moved-elsewhere, connected",
      { connNonce: NONCE, sessionConnNonce: OTHER_NONCE },
      MOVED_ELSEWHERE,
      MOVED_ELSEWHERE,
    ],
    [
      "moved-elsewhere, stale marker",
      { ...stale, connNonce: NONCE, lastInvoluntaryConnNonce: OTHER_NONCE },
      MOVED_ELSEWHERE,
      MOVED_ELSEWHERE,
    ],
    [
      "moved-elsewhere, Nb past the notice window",
      rejoined(MOVE_NOTICE_WINDOW_MS),
      MOVED_ELSEWHERE,
      MOVED_ELSEWHERE,
    ],
    [
      "already-there",
      { from: FROM, to: FROM },
      { action: "ignore", reason: "already-there" },
      { action: "ignore", reason: "already-there" },
    ],
    [
      "already-there, fresh marker",
      { ...OFF_CALL, ...droppedFrom(FROM, 250), to: FROM },
      { action: "ignore", reason: "already-there" },
      { action: "ignore", reason: "already-there" },
    ],
    [
      "other-device",
      { sessionDeviceId: OTHER_DEVICE },
      { action: "ignore", reason: "other-device" },
      { action: "ignore", reason: "other-device" },
    ],
    [
      "other-channel",
      { currentChannelId: ELSEWHERE },
      { action: "ignore", reason: "other-channel" },
      { action: "ignore", reason: "other-channel" },
    ],
    [
      "not-in-call",
      OFF_CALL,
      { action: "ignore", reason: "not-in-call" },
      { action: "ignore", reason: "not-in-call" },
    ],
    [
      "not-in-call, marker past the notice window",
      { ...OFF_CALL, ...droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS) },
      { action: "ignore", reason: "not-in-call" },
      { action: "ignore", reason: "not-in-call" },
    ],
  ];
  for (const [name, shape, ungated, gated] of rows) {
    assert.deepEqual(
      decide({ ...shape, destinationGated: false }),
      ungated,
      `${name}, ungated`,
    );
    assert.deepEqual(
      decide({ ...shape, destinationGated: true }),
      gated,
      `${name}, gated`,
    );
  }
});

// --- The sweep ------------------------------------------------------------

/** A world without its three nonce fields, which the sweeps add per shape. */
type BaseWorld = Omit<
  MoveWorld,
  "connNonce" | "sessionConnNonce" | "lastInvoluntaryConnNonce"
>;

/**
 * Cartesian sweep over every world shape the ladder distinguishes, without
 * the nonce fields. Its enumeration order is part of the fingerprints below,
 * so a change here is a change to the pinned truth tables and must be
 * re-captured against the OLD ladders, not the current one.
 *
 * S-a's three fields are yielded ABSENT (`NO_SA`), so every sweep that does
 * not add them walks exactly the worlds it walked at 16734940. The S-a
 * sweeps overlay `SA_SHAPES` on top.
 *
 * 🔴 FE-2's three new inputs are yielded as the LEGACY EMBEDDING: the values
 * under which the new ladder is fed exactly what the old one read. The token
 * is always present and always minted for this connection, so the token arm
 * passes it through as the old ladder did (FE2WA-9's check is true and drops
 * out); the identity is device-qualified exactly when the device matched, so
 * step 4's proof (`token && tokenForThisConnection && lastIdentityIsDevice`)
 * is the old device match; and no gate. The only tokenless answers the
 * embedding can produce come from a blank URL, which the old ladder answered
 * `no-url`. `legacyKey` reads that back. The new dimensions are swept
 * separately, on top of this embedding, by the traced FE-2 test below.
 *
 * The embedding was `tokenForThisConnection = deviceMatches`,
 * `lastIdentityIsDevice = true` until FE2WA-9 made the token arm read
 * `tokenForThisConnection` too: under that mapping a device-mismatched
 * CONNECTED seat would now `join` where the old ladder moved, so the mapping
 * moved to the other conjunct. The inputs changed; the fingerprints did not.
 */
function* sweepWorlds(): Generator<BaseWorld> {
  const markers = [
    { lastInvoluntaryChannelId: undefined, lastInvoluntaryLeftAt: undefined },
    { lastInvoluntaryChannelId: FROM, lastInvoluntaryLeftAt: undefined },
    droppedFrom(FROM, 250),
    droppedFrom(FROM, MOVE_VERIFIED_WINDOW_MS - 1),
    droppedFrom(FROM, MOVE_VERIFIED_WINDOW_MS),
    droppedFrom(FROM, STALE_MS),
    droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS - 1),
    droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS),
    droppedFrom(ELSEWHERE, 250),
  ];
  // Every shape of device knowledge, including the two half-known ones.
  const devices = [
    { deviceId: DEVICE, sessionDeviceId: DEVICE },
    { deviceId: DEVICE, sessionDeviceId: OTHER_DEVICE },
    { deviceId: undefined, sessionDeviceId: DEVICE },
    { deviceId: DEVICE, sessionDeviceId: undefined },
    { deviceId: undefined, sessionDeviceId: undefined },
  ];
  for (const callState of [
    "CONNECTED",
    "DISCONNECTED",
    "RECONNECTING",
    "CONNECTING",
    "IDLE",
  ])
    for (const currentChannelId of [FROM, ELSEWHERE, undefined])
      for (const to of [TO, FROM])
        for (const url of [NODE_URL, undefined, "  ", ""])
          for (const destinationKnown of [true, false])
            for (const marker of markers)
              for (const device of devices)
                yield {
                  callState,
                  currentChannelId,
                  from: FROM,
                  to,
                  url,
                  token: TOKEN,
                  destinationKnown,
                  now: NOW,
                  ...device,
                  ...marker,
                  ...NO_SA,
                  // The legacy embedding (see above).
                  tokenForThisConnection: true,
                  lastIdentityIsDevice:
                    device.deviceId !== undefined &&
                    device.deviceId === device.sessionDeviceId,
                  destinationGated: false,
                };
}

/** One decision as a canonical string, independent of key order. */
const answerKey = (d: MoveDecision) =>
  d.action === "move"
    ? `move|${d.url}|${d.token}|${d.to}`
    : d.action === "join"
      ? `join|${d.to}`
      : `${d.action}|${d.reason}`;

/**
 * An answer as the pre-FE-2 ladders spelled it. Under the legacy embedding
 * the one answer they did not have, the tokenless `join`, comes only from a
 * blank URL, and that is exactly what they answered `no-url` (ruling D2).
 */
const legacyKey = (d: MoveDecision) =>
  d.action === "join" ? "fail-loud|no-url" : answerKey(d);

/** Nonce shapes under which the gate is INACTIVE on every clause. */
const INACTIVE_NONCES = [
  NO_NONCES,
  // The event names a connection, this session holds none.
  { ...NO_NONCES, connNonce: NONCE },
  // This session holds both of its nonces, the event names none.
  { ...NO_NONCES, sessionConnNonce: NONCE, lastInvoluntaryConnNonce: NONCE },
  {
    ...NO_NONCES,
    sessionConnNonce: OTHER_NONCE,
    lastInvoluntaryConnNonce: OTHER_NONCE,
  },
  // `""` is absent, on either side.
  { connNonce: "", sessionConnNonce: "", lastInvoluntaryConnNonce: "" },
  { connNonce: NONCE, sessionConnNonce: "", lastInvoluntaryConnNonce: "" },
  {
    connNonce: "",
    sessionConnNonce: NONCE,
    lastInvoluntaryConnNonce: OTHER_NONCE,
  },
];

const EQUAL_NONCES = {
  connNonce: NONCE,
  sessionConnNonce: NONCE,
  lastInvoluntaryConnNonce: NONCE,
};
const UNEQUAL_NONCES = {
  connNonce: NONCE,
  sessionConnNonce: OTHER_NONCE,
  lastInvoluntaryConnNonce: OTHER_NONCE,
};
/** Nonce shapes under which the gate is ACTIVE on at least one clause. */
const ACTIVE_NONCES = [
  EQUAL_NONCES,
  UNEQUAL_NONCES,
  // Mixed: the live connection matches, the snapshotted marker does not…
  {
    connNonce: NONCE,
    sessionConnNonce: NONCE,
    lastInvoluntaryConnNonce: OTHER_NONCE,
  },
  // …and the other way round.
  {
    connNonce: NONCE,
    sessionConnNonce: OTHER_NONCE,
    lastInvoluntaryConnNonce: NONCE,
  },
  // One clause active, the other absent.
  {
    connNonce: NONCE,
    sessionConnNonce: OTHER_NONCE,
    lastInvoluntaryConnNonce: undefined,
  },
  {
    connNonce: NONCE,
    sessionConnNonce: undefined,
    lastInvoluntaryConnNonce: OTHER_NONCE,
  },
];

/**
 * Every S-a shape the sweeps overlay: the pending and replaced nonces each
 * absent, empty, the event's (a match), or another connection's, and the
 * replaced drop's age absent or at every edge of both windows. 4 x 4 x 8.
 * Only the event's nonce can match (the sweeps' `connNonce` is `NONCE`, `""`
 * or absent), so OTHER_NONCE stands for every non-matching value.
 */
const SA_SHAPES: {
  pendingConnNonce: string | undefined;
  replacedConnNonce: string | undefined;
  replacedLeftAt: number | undefined;
}[] = [];
for (const pendingConnNonce of [undefined, "", NONCE, OTHER_NONCE])
  for (const replacedConnNonce of [undefined, "", NONCE, OTHER_NONCE])
    for (const ago of [
      undefined,
      0,
      MOVE_VERIFIED_WINDOW_MS - 1,
      MOVE_VERIFIED_WINDOW_MS,
      STALE_MS,
      MOVE_NOTICE_WINDOW_MS - 1,
      MOVE_NOTICE_WINDOW_MS,
      MOVE_NOTICE_WINDOW_MS + 1,
    ])
      SA_SHAPES.push({
        pendingConnNonce,
        replacedConnNonce,
        replacedLeftAt: ago === undefined ? undefined : NOW - ago,
      });

/** Every nonce shape the sweeps walk, inactive and active. */
const ALL_NONCES = [...INACTIVE_NONCES, ...ACTIVE_NONCES];

/**
 * The sweep's answers with NO nonce, from the ladder as it stood at commit
 * 66c575a8, before the nonce existed. sha256 over `answerKey` of every world,
 * in `sweepWorlds` order, joined by "\n". Captured by running this exact
 * sweep against `git show 66c575a8:packages/client/components/rtc/
 * movePolicy.ts`. It is NOT to be re-captured against the current ladder:
 * the whole point is that it came from the old one.
 */
const OLD_LADDER_FINGERPRINT =
  "62558b41a823260f34ba9a5123e2115ab2d4723cd65f3f88d8fe3b86553409c1";
/** The same capture's answer histogram, for a readable failure. */
const OLD_LADDER_HISTOGRAM = {
  "fail-loud|no-url": 153,
  "fail-loud|stale-notice": 864,
  "fail-loud|unknown-channel": 204,
  "fail-loud|unverified-session": 384,
  "ignore|already-there": 3240,
  "ignore|not-in-call": 1152,
  "ignore|other-channel": 432,
  "ignore|other-device": 4320,
  [`move|${NODE_URL}|${TOKEN}|${TO}`]: 51,
};

/**
 * D2's one rename, applied to a pre-FE-2 histogram: every `no-url` becomes
 * the tokenless `join` to `TO` (the only destination an addressed sweep world
 * has, since `to: FROM` is `already-there`), count for count. Nothing else in
 * a legacy-embedding histogram may differ; see `legacyKey`.
 */
function renamedByD2(histogram: Record<string, number>) {
  const renamed: Record<string, number> = {};
  for (const [key, count] of Object.entries(histogram))
    renamed[key === "fail-loud|no-url" ? `join|${TO}` : key] = count;
  return renamed;
}

/**
 * The 66c575a8 histogram as the FE-2 ladder spells it under the legacy
 * embedding. REGENERATED FOR FE-2, and traced rather than re-captured: the
 * test "FE-2 regenerated histograms" asserts it is exactly
 * `renamedByD2(OLD_LADDER_HISTOGRAM)`, and the fingerprint test asserts the
 * sweep produces it while reproducing the 66c575a8 fingerprint.
 */
const OLD_LADDER_HISTOGRAM_FE2 = {
  "fail-loud|stale-notice": 864,
  "fail-loud|unknown-channel": 204,
  "fail-loud|unverified-session": 384,
  "ignore|already-there": 3240,
  "ignore|not-in-call": 1152,
  "ignore|other-channel": 432,
  "ignore|other-device": 4320,
  [`join|${TO}`]: 153,
  [`move|${NODE_URL}|${TOKEN}|${TO}`]: 51,
};

/**
 * FE-2's three new inputs, and the token, at every value that matters,
 * overlaid on the legacy embedding: token proof x identity kind x token
 * present/absent/empty x gate. 2 x 2 x 3 x 2.
 */
const FE2_SHAPES: {
  tokenForThisConnection: boolean;
  lastIdentityIsDevice: boolean;
  token: string | undefined;
  destinationGated: boolean;
}[] = [];
for (const tokenForThisConnection of [false, true])
  for (const lastIdentityIsDevice of [false, true])
    for (const token of [TOKEN, undefined, ""])
      for (const destinationGated of [false, true])
        FE2_SHAPES.push({
          tokenForThisConnection,
          lastIdentityIsDevice,
          token,
          destinationGated,
        });

/**
 * The S-a shapes the FE-2 sweeps overlay: none, Na's pending match, and Nb's
 * replaced match inside the verified window and inside the notice window.
 * The full `SA_SHAPES` product is not needed to reach every arm the new
 * inputs touch, and would multiply the FE-2 sweep past 400M decisions.
 */
const FE2_SA_SHAPES = [
  NO_SA,
  { ...NO_SA, pendingConnNonce: NONCE },
  { ...NO_SA, replacedConnNonce: NONCE, replacedLeftAt: NOW - 250 },
  { ...NO_SA, replacedConnNonce: NONCE, replacedLeftAt: NOW - STALE_MS },
];

test("the decision is exhaustive — every world answers with one of four actions", () => {
  // Cartesian sweep, WITH the nonce dimension — S-a's pending and replaced
  // nonces and the replaced drop's age included: no combination falls off
  // the end or returns undefined. One world object per nonce shape, with the
  // S-a fields overwritten in place, because this is 15.7M decisions. Then
  // FE-2's new inputs, over every nonce shape.
  const actions = new Set<MoveDecision["action"]>();
  const reasons = new Set<string>();
  const record = (decision: MoveDecision) => {
    if (!["ignore", "fail-loud", "move", "join"].includes(decision.action))
      assert.fail(`unexpected action ${decision.action}`);
    actions.add(decision.action);
    if (decision.action === "ignore" || decision.action === "fail-loud")
      reasons.add(decision.reason);
  };
  let worlds = 0;
  for (const base of sweepWorlds())
    for (const nonces of ALL_NONCES) {
      const world: MoveWorld = { ...base, ...nonces };
      for (const sa of SA_SHAPES) {
        world.pendingConnNonce = sa.pendingConnNonce;
        world.replacedConnNonce = sa.replacedConnNonce;
        world.replacedLeftAt = sa.replacedLeftAt;
        record(moveDecision(world));
        worlds++;
      }
    }
  // FE-2's inputs over every nonce shape, S-a absent (the traced FE-2 test
  // below walks the S-a subset as well).
  let fe2Worlds = 0;
  for (const base of sweepWorlds())
    for (const nonces of ALL_NONCES) {
      const world: MoveWorld = { ...base, ...nonces };
      for (const fe2 of FE2_SHAPES) {
        world.tokenForThisConnection = fe2.tokenForThisConnection;
        world.lastIdentityIsDevice = fe2.lastIdentityIsDevice;
        world.token = fe2.token;
        world.destinationGated = fe2.destinationGated;
        record(moveDecision(world));
        fe2Worlds++;
      }
    }
  // Not vacuous: the sweeps actually walked the space they claim to.
  assert.equal(SA_SHAPES.length, 4 * 4 * 8);
  assert.equal(
    worlds,
    10_800 * (INACTIVE_NONCES.length + ACTIVE_NONCES.length) * SA_SHAPES.length,
  );
  assert.equal(FE2_SHAPES.length, 2 * 2 * 3 * 2);
  assert.equal(fe2Worlds, 10_800 * ALL_NONCES.length * FE2_SHAPES.length);
  // All four are reachable, so the sweep is not vacuously passing on one.
  assert.deepEqual([...actions].sort(), [
    "fail-loud",
    "ignore",
    "join",
    "move",
  ]);
  // And every named reason is reachable — a reason no world can produce is
  // either dead code or a branch that was quietly rewired. All NINE: the
  // four `ignore` kinds and the five `fail-loud` ones (`no-url` retired by
  // D2, `gated-destination` added). A branch pointed at a reason nothing can
  // reach fails HERE and nowhere else.
  assert.deepEqual([...reasons].sort(), [
    "already-there",
    "gated-destination",
    "moved-elsewhere",
    "not-in-call",
    "other-channel",
    "other-device",
    "stale-notice",
    "unknown-channel",
    "unverified-session",
  ]);
  assert.equal(reasons.size, 9);
});

test("🔴 gate INACTIVE => exactly the old ladder's answer, in every world of the sweep", () => {
  // The truth table the nonce must not disturb. First, with no nonce at all,
  // the whole sweep reproduces the OLD ladder's answers, pinned as a
  // fingerprint captured from commit 66c575a8 rather than restated here. The
  // sweep runs under FE-2's legacy embedding, and the fingerprint is taken
  // over `legacyKey`, which reads D2's `join` back as the `no-url` the old
  // ladder answered; the histogram is taken over the FE-2 spelling.
  const keys: string[] = [];
  const histogram: Record<string, number> = {};
  for (const base of sweepWorlds()) {
    const decision = moveDecision({ ...base, ...NO_NONCES });
    const key = answerKey(decision);
    keys.push(legacyKey(decision));
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  assert.equal(keys.length, 10_800);
  assert.equal(
    createHash("sha256").update(keys.join("\n")).digest("hex"),
    OLD_LADDER_FINGERPRINT,
    `with no nonce, the sweep no longer answers as the 66c575a8 ladder did — histogram now ${JSON.stringify(histogram)}, was ${JSON.stringify(OLD_LADDER_HISTOGRAM_FE2)}`,
  );
  assert.deepEqual(histogram, OLD_LADDER_HISTOGRAM_FE2);
  // Second, every nonce shape that leaves the gate inactive answers exactly
  // as no nonce does, world by world. A one-sided or empty nonce is an
  // absence, never a mismatch.
  let i = 0;
  for (const base of sweepWorlds()) {
    for (const nonces of INACTIVE_NONCES) {
      const key = legacyKey(moveDecision({ ...base, ...nonces }));
      if (key !== keys[i])
        assert.fail(
          `an INACTIVE nonce shape changed the answer: ${JSON.stringify({ ...base, ...nonces })} answered ${key}, the old ladder ${keys[i]}`,
        );
    }
    i++;
  }
});

test("🔴 gate ACTIVE — the properties that hold across the whole sweep", () => {
  // Unequal on every clause: this session is never the moved connection, so
  // it never moves, never gets the bare-seat card (step 5 is retired where
  // the gate is active), and never gets `stale-notice` (P-16).
  // Equal on every clause: it is never `moved-elsewhere` and never
  // `unverified-session`. And whatever the nonces, a world that answered
  // `already-there`, `other-channel` or `not-in-call` with no nonce answers
  // exactly that still: nothing moved, or a bystander, stays as it was.
  const invariant = new Set([
    "ignore|already-there",
    "ignore|other-channel",
    "ignore|not-in-call",
  ]);
  const seenUnequal = new Set<string>();
  for (const base of sweepWorlds()) {
    const unequal = answerKey(moveDecision({ ...base, ...UNEQUAL_NONCES }));
    const equal = answerKey(moveDecision({ ...base, ...EQUAL_NONCES }));
    seenUnequal.add(unequal);
    assert.ok(
      !unequal.startsWith("move|") &&
        unequal !== "fail-loud|unverified-session" &&
        unequal !== "fail-loud|stale-notice",
      `unequal nonces answered ${unequal} for ${JSON.stringify(base)}`,
    );
    assert.ok(
      equal !== "fail-loud|moved-elsewhere" &&
        equal !== "fail-loud|unverified-session",
      `equal nonces answered ${equal} for ${JSON.stringify(base)}`,
    );
    const old = answerKey(moveDecision({ ...base, ...NO_NONCES }));
    if (invariant.has(old))
      for (const nonces of ACTIVE_NONCES) {
        const now = answerKey(moveDecision({ ...base, ...nonces }));
        if (now !== old)
          assert.fail(
            `a nonce changed a ${old} answer to ${now}: ${JSON.stringify({ ...base, ...nonces })}`,
          );
      }
  }
  // Not vacuous: the unequal sweep did reach the new arm.
  assert.ok(seenUnequal.has("fail-loud|moved-elsewhere"));
});

/**
 * The whole nonce sweep's answers — `sweepWorlds` x `ALL_NONCES`, S-a fields
 * absent — from the ladder as it stood at commit 16734940, before S-a. sha256
 * over `answerKey` of every world in that order, joined by "\n". Captured by
 * running THIS spec with `./movePolicy.ts` replaced by `git show
 * 16734940:packages/client/components/rtc/movePolicy.ts`, which ignores the
 * S-a fields entirely. Like the fingerprint above it, it is NOT to be
 * re-captured against the current ladder.
 */
const PRE_SA_LADDER_FINGERPRINT =
  "1c3065324fb9cd8b4b9a0783e4d14cd9315f0262cfc8a5d9b0f75cf975465f71";
/** The same capture's answer histogram, for a readable failure. */
const PRE_SA_LADDER_HISTOGRAM = {
  "fail-loud|moved-elsewhere": 8280,
  "fail-loud|no-url": 2214,
  "fail-loud|stale-notice": 9792,
  "fail-loud|unknown-channel": 2952,
  "fail-loud|unverified-session": 3072,
  "ignore|already-there": 47640,
  "ignore|not-in-call": 14976,
  "ignore|other-channel": 5616,
  "ignore|other-device": 45120,
  [`move|${NODE_URL}|${TOKEN}|${TO}`]: 738,
};

/**
 * The 16734940 histogram as the FE-2 ladder spells it under the legacy
 * embedding. REGENERATED FOR FE-2, traced exactly like
 * `OLD_LADDER_HISTOGRAM_FE2`: it must equal
 * `renamedByD2(PRE_SA_LADDER_HISTOGRAM)`.
 */
const PRE_SA_LADDER_HISTOGRAM_FE2 = {
  "fail-loud|moved-elsewhere": 8280,
  "fail-loud|stale-notice": 9792,
  "fail-loud|unknown-channel": 2952,
  "fail-loud|unverified-session": 3072,
  "ignore|already-there": 47640,
  "ignore|not-in-call": 14976,
  "ignore|other-channel": 5616,
  "ignore|other-device": 45120,
  [`join|${TO}`]: 2214,
  [`move|${NODE_URL}|${TOKEN}|${TO}`]: 738,
};

test("🔴 S-a fields absent => exactly the 16734940 ladder's answer, over the whole nonce sweep", () => {
  // Stronger than the 66c575a8 pin above, which only covers the no-nonce
  // world: this one covers every nonce shape, active gates included, so the
  // refactor that S-a needed (one shared feasibility tail) is pinned to have
  // changed no answer that S-a does not own. Under FE-2's legacy embedding,
  // fingerprinted over `legacyKey` like the pin above.
  const keys: string[] = [];
  const histogram: Record<string, number> = {};
  for (const base of sweepWorlds())
    for (const nonces of ALL_NONCES) {
      const decision = moveDecision({ ...base, ...nonces, ...NO_SA });
      const key = answerKey(decision);
      keys.push(legacyKey(decision));
      histogram[key] = (histogram[key] ?? 0) + 1;
    }
  assert.equal(keys.length, 10_800 * ALL_NONCES.length);
  assert.equal(
    createHash("sha256").update(keys.join("\n")).digest("hex"),
    PRE_SA_LADDER_FINGERPRINT,
    `with the S-a fields absent, the nonce sweep no longer answers as the 16734940 ladder did — histogram now ${JSON.stringify(histogram)}, was ${JSON.stringify(PRE_SA_LADDER_HISTOGRAM_FE2)}`,
  );
  assert.deepEqual(histogram, PRE_SA_LADDER_HISTOGRAM_FE2);
});

test("FE-2 regenerated histograms — each is the old one with D2's rename, and nothing else", () => {
  // What changed and why, for the two regenerated literals: `no-url` is
  // retired (ruling D2) and its worlds take the tokenless `join`, count for
  // count. Every other bucket is carried over unchanged, because under the
  // legacy embedding the step-4 proof reads exactly the old device match
  // (D1/FE2A-2 change nothing there), the token is always present and this
  // connection's (FE2WA-2 and FE2WA-9 change nothing there either), and no
  // destination is gated. FE2WA-9 did change the embedding's INPUTS (see
  // `sweepWorlds`) but not these numbers: they are still exactly the rename.
  // The fingerprint tests then show the sweep really produces these.
  assert.deepEqual(OLD_LADDER_HISTOGRAM_FE2, renamedByD2(OLD_LADDER_HISTOGRAM));
  assert.deepEqual(
    PRE_SA_LADDER_HISTOGRAM_FE2,
    renamedByD2(PRE_SA_LADDER_HISTOGRAM),
  );
  // Not vacuous: the rename had something to rename, and removed the old
  // key rather than adding beside it.
  for (const [old, renamed] of [
    [OLD_LADDER_HISTOGRAM, OLD_LADDER_HISTOGRAM_FE2],
    [PRE_SA_LADDER_HISTOGRAM, PRE_SA_LADDER_HISTOGRAM_FE2],
  ] as Record<string, number>[][]) {
    assert.ok(old["fail-loud|no-url"] > 0);
    assert.equal(renamed[`join|${TO}`], old["fail-loud|no-url"]);
    assert.equal("fail-loud|no-url" in renamed, false);
    assert.equal(
      Object.values(renamed).reduce((a, b) => a + b, 0),
      Object.values(old).reduce((a, b) => a + b, 0),
    );
  }
});

test("🔴 G1 under S-a — no pending, replaced or age value moves an answer while the gate is inactive", () => {
  // The two new fields are read only inside the gate-active test. Every
  // inactive nonce shape, under every S-a shape (matching nonces included),
  // must answer exactly as the old ladder did with no nonce and no S-a at all.
  const old: string[] = [];
  for (const base of sweepWorlds())
    old.push(answerKey(moveDecision({ ...base, ...NO_NONCES, ...NO_SA })));
  let i = 0;
  let worlds = 0;
  for (const base of sweepWorlds()) {
    for (const nonces of INACTIVE_NONCES) {
      const world: MoveWorld = { ...base, ...nonces };
      for (const sa of SA_SHAPES) {
        world.pendingConnNonce = sa.pendingConnNonce;
        world.replacedConnNonce = sa.replacedConnNonce;
        world.replacedLeftAt = sa.replacedLeftAt;
        const key = answerKey(moveDecision(world));
        if (key !== old[i])
          assert.fail(
            `an S-a field changed an INACTIVE-gate answer: ${JSON.stringify(world)} answered ${key}, the old ladder ${old[i]}`,
          );
        worlds++;
      }
    }
    i++;
  }
  assert.equal(worlds, 10_800 * INACTIVE_NONCES.length * SA_SHAPES.length);
});

test("🔴 S-a widens ONLY — every changed answer was moved-elsewhere, and is traced to the field that matched", () => {
  // `old` is the same world with the S-a fields absent, which the fingerprint
  // above pins to the 16734940 ladder world by world. The property: wherever
  // S-a changes an answer, the old answer was `moved-elsewhere`, the new one
  // is an addressed answer (a move, a feasibility failure, or the stale
  // notice), and exactly one of the two new nonces carried it — removing
  // that one restores the old answer — in the shape that nonce belongs to.
  // FE-2: the tokenless `join` stands where `no-url` stood (D2).
  const addressed = new Set([
    `move|${NODE_URL}|${TOKEN}|${TO}`,
    "fail-loud|unknown-channel",
    `join|${TO}`,
    "fail-loud|stale-notice",
  ]);
  const byPending: Record<string, number> = {};
  const byReplaced: Record<string, number> = {};
  let worlds = 0;
  let changed = 0;
  for (const base of sweepWorlds())
    for (const nonces of ALL_NONCES) {
      const world: MoveWorld = { ...base, ...nonces, ...NO_SA };
      const old = answerKey(moveDecision(world));
      for (const sa of SA_SHAPES) {
        world.pendingConnNonce = sa.pendingConnNonce;
        world.replacedConnNonce = sa.replacedConnNonce;
        world.replacedLeftAt = sa.replacedLeftAt;
        worlds++;
        const now = answerKey(moveDecision(world));
        if (now === old) continue;
        changed++;
        const where = JSON.stringify(world);
        if (old !== "fail-loud|moved-elsewhere")
          assert.fail(`S-a changed a ${old} answer to ${now}: ${where}`);
        if (!addressed.has(now))
          assert.fail(`S-a turned moved-elsewhere into ${now}: ${where}`);
        const withoutPending = answerKey(
          moveDecision({ ...world, pendingConnNonce: undefined }),
        );
        const withoutReplaced = answerKey(
          moveDecision({ ...world, replacedConnNonce: undefined }),
        );
        const pendingCarried = withoutPending === old;
        const replacedCarried = withoutReplaced === old;
        if (pendingCarried === replacedCarried)
          assert.fail(
            `the change is not traced to exactly one S-a nonce (pending ${pendingCarried}, replaced ${replacedCarried}): ${where}`,
          );
        if (pendingCarried) {
          // Na: the marker shape, dialing `from`, the pending nonce named.
          if (
            world.callState === "CONNECTED" ||
            world.currentChannelId !== world.from ||
            world.lastInvoluntaryChannelId !== world.from ||
            world.connNonce !== world.pendingConnNonce ||
            now === "fail-loud|stale-notice"
          )
            assert.fail(
              `a pending-nonce change outside its shape: ${now} ${where}`,
            );
          byPending[now] = (byPending[now] ?? 0) + 1;
        } else {
          // Nb: CONNECTED to `from`, the replaced nonce named, its drop
          // dated and inside the notice window.
          if (
            world.callState !== "CONNECTED" ||
            world.currentChannelId !== world.from ||
            world.connNonce !== world.replacedConnNonce ||
            world.replacedLeftAt === undefined ||
            world.now - world.replacedLeftAt >= MOVE_NOTICE_WINDOW_MS
          )
            assert.fail(
              `a replaced-nonce change outside its shape: ${now} ${where}`,
            );
          byReplaced[now] = (byReplaced[now] ?? 0) + 1;
        }
      }
    }
  assert.equal(worlds, 10_800 * ALL_NONCES.length * SA_SHAPES.length);
  // Not vacuous: both arms fired, the replaced arm reached both of its
  // answers, and the feasibility tail is reachable through each arm.
  assert.ok(changed > 0, "S-a changed no answer anywhere in the sweep");
  const move = `move|${NODE_URL}|${TOKEN}|${TO}`;
  for (const [arm, seen, expected] of [
    ["pending", byPending, [move, "fail-loud|unknown-channel", `join|${TO}`]],
    [
      "replaced",
      byReplaced,
      [
        move,
        "fail-loud|unknown-channel",
        `join|${TO}`,
        "fail-loud|stale-notice",
      ],
    ],
  ] as const)
    assert.deepEqual(
      Object.keys(seen).sort(),
      [...expected].sort(),
      `the ${arm} arm reached ${JSON.stringify(seen)}`,
    );
});

test("🔴 FE-2 — every answer that differs from the legacy embedding is traced to exactly one ruling", () => {
  // The new inputs, swept over every base world, every nonce shape and the
  // FE-2 S-a subset. `old` is the same world under the legacy embedding,
  // which the fingerprints above pin to the old ladders world by world. Each
  // difference is peeled off in a fixed order and must be explained, in its
  // own shape, by exactly one ruling:
  //
  //   G       the destination is gated (and known): an addressed answer
  //           (`move`, `join`) or a carding loud arm (`unverified-session`,
  //           `stale-notice`) becomes `gated-destination`, and NOTHING else
  //           changes. Checked both ways: a gated world whose ungated answer
  //           is one of those four MUST be `gated-destination`.
  //   FE2WA-2 the token is absent or empty IN THE PROOF SHAPE (fresh marker,
  //           no marker nonce gate): an answer the token proof addressed
  //           becomes `unverified-session`. A missing token is never a
  //           `join` there.
  //   D2      the token is absent or empty ANYWHERE ELSE: a `move` becomes
  //           the tokenless `join`, and nothing else changes.
  //   FE2WA-9 the token is not this connection's, outside the proof shape: a
  //           `move` becomes the tokenless `join`.
  //   D1      (as amended by FE2A-2) the step-4 proof is the token proof, not
  //           the device match: only in the proof shape, and only in the two
  //           directions the swap allows. A device match without the proof
  //           goes from addressed to `unverified-session` (A); the proof
  //           without a named device goes from `unverified-session` to
  //           addressed (B).
  //
  // And, over every world: a `move` always carries a token minted for this
  // connection (FE2WA-9 is a property, not only a trace).
  const move = `move|${NODE_URL}|${TOKEN}|${TO}`;
  const join = `join|${TO}`;
  const gated = "fail-loud|gated-destination";
  const unverified = "fail-loud|unverified-session";
  const cardedOrAddressed = new Set([
    move,
    join,
    unverified,
    "fail-loud|stale-notice",
  ]);
  const addressed = new Set([move, join, "fail-loud|unknown-channel"]);
  const traced: Record<string, number> = {};
  const trace = (why: string) => (traced[why] = (traced[why] ?? 0) + 1);
  let worlds = 0;
  for (const base of sweepWorlds())
    for (const nonces of ALL_NONCES)
      for (const sa of FE2_SA_SHAPES) {
        const legacy: MoveWorld = { ...base, ...nonces, ...sa };
        const old = answerKey(moveDecision(legacy));
        const world: MoveWorld = { ...legacy };
        // The proof shape: a fresh marker for `from`, no nonce gate on the
        // marker clause, and something actually moved. Only here does step 4
        // read the token proof.
        const markerAge =
          world.lastInvoluntaryLeftAt === undefined
            ? undefined
            : world.now - world.lastInvoluntaryLeftAt;
        const proofShape =
          world.callState !== "CONNECTED" &&
          world.lastInvoluntaryChannelId === world.from &&
          markerAge !== undefined &&
          markerAge >= 0 &&
          markerAge < MOVE_VERIFIED_WINDOW_MS &&
          !(world.connNonce && world.lastInvoluntaryConnNonce) &&
          world.from !== world.to;
        for (const fe2 of FE2_SHAPES) {
          world.tokenForThisConnection = fe2.tokenForThisConnection;
          world.lastIdentityIsDevice = fe2.lastIdentityIsDevice;
          world.token = fe2.token;
          world.destinationGated = fe2.destinationGated;
          worlds++;
          const now = answerKey(moveDecision(world));
          const where = () => `${JSON.stringify(world)} (old ${old})`;
          if (now === move && !world.tokenForThisConnection)
            assert.fail(`a foreign token was passed through: ${where()}`);
          // G — peel the gate off first. (Each peel re-decides only when its
          // field is actually set; otherwise it IS the answer above.)
          let ungated = now;
          if (fe2.destinationGated) {
            world.destinationGated = false;
            ungated = answerKey(moveDecision(world));
            world.destinationGated = true;
          }
          if (
            world.destinationGated &&
            world.destinationKnown &&
            cardedOrAddressed.has(ungated)
          ) {
            if (now !== gated)
              assert.fail(`the gate let a ${ungated} through: ${where()}`);
            trace(`G ${ungated}`);
          } else if (now !== ungated)
            assert.fail(`the gate turned ${ungated} into ${now}: ${where()}`);
          // FE2WA-2 / D2 — then the missing token.
          let tokened = ungated;
          if (!fe2.token) {
            world.destinationGated = false;
            world.token = TOKEN;
            tokened = answerKey(moveDecision(world));
            world.token = fe2.token;
            world.destinationGated = fe2.destinationGated;
          }
          const proof =
            world.tokenForThisConnection && world.lastIdentityIsDevice;
          if (!world.token && proofShape && addressed.has(tokened) && proof) {
            if (ungated !== unverified)
              assert.fail(
                `a token-less marker was addressed (${ungated}): ${where()}`,
              );
            trace("FE2WA-2 token-less marker->unverified");
          } else if (!world.token && tokened === move) {
            if (proofShape)
              assert.fail(`D2 claimed the proof shape: ${where()}`);
            if (ungated !== join)
              assert.fail(`a missing token did not join: ${where()}`);
            trace("D2 move->join");
          } else if (ungated !== tokened)
            assert.fail(
              `a missing token turned ${tokened} into ${ungated}: ${where()}`,
            );
          // FE2WA-9 and D1/FE2A-2 — what is left against the embedding.
          if (tokened === old) continue;
          if (!proofShape) {
            if (
              old === move &&
              tokened === join &&
              !world.tokenForThisConnection
            )
              trace("FE2WA-9 foreign token move->join");
            else
              assert.fail(
                `${old} became ${tokened} outside the proof shape by no ruling: ${where()}`,
              );
            continue;
          }
          const deviceMatches =
            world.deviceId !== undefined &&
            world.deviceId === world.sessionDeviceId;
          if (
            addressed.has(old) &&
            tokened === unverified &&
            deviceMatches &&
            !proof
          )
            trace("D1 A addressed->unverified");
          else if (
            old === unverified &&
            addressed.has(tokened) &&
            world.deviceId === undefined &&
            proof
          )
            trace("D1 B unverified->addressed");
          else assert.fail(`${old} became ${tokened} by no ruling: ${where()}`);
        }
      }
  assert.equal(
    worlds,
    10_800 * ALL_NONCES.length * FE2_SA_SHAPES.length * FE2_SHAPES.length,
  );
  // Not vacuous, and nothing else: every ruling fired, the gate hit each of
  // the four answers it replaces, and no other trace exists.
  assert.deepEqual(
    Object.keys(traced).sort(),
    [
      "D1 A addressed->unverified",
      "D1 B unverified->addressed",
      "D2 move->join",
      "FE2WA-2 token-less marker->unverified",
      "FE2WA-9 foreign token move->join",
      `G ${unverified}`,
      "G fail-loud|stale-notice",
      `G ${join}`,
      `G ${move}`,
    ].sort(),
    JSON.stringify(traced),
  );
});

test("🔴 the pre-connect budget stays well inside the token's 10 s TTL", () => {
  // 10_000 is the token TTL: `.with_ttl(Duration::from_secs(10))` in
  // `crates/core/database/src/voice/voice_client.rs`. The move path is handed
  // a token that is already ticking, so a budget at or past the TTL cannot
  // buy patience — it only moves the failure later and disguises an expired
  // token as a network fault. Raising it past this bound must fail here.
  assert.ok(
    MOVE_PRECONNECT_BUDGET_MS < 10_000,
    `budget ${MOVE_PRECONNECT_BUDGET_MS}ms is not inside the 10_000ms token TTL`,
  );
  // And it must leave room for the connect handshake itself, not just squeak
  // under the TTL.
  assert.ok(MOVE_PRECONNECT_BUDGET_MS <= 5_000);
  assert.ok(MOVE_PRECONNECT_BUDGET_MS > 0);
});

test("🔴 the verified window, the budget and the skew allowance fit inside the token TTL", () => {
  // THE invariant, and it is deliberately NOT the one this test used to
  // assert. The old form pinned `window + budget <= 10_000` alongside
  // `window === 7_000` — that is `TTL - budget`, and it is measured from the
  // wrong epoch at BOTH ends, which is why the number is smaller now:
  //
  //   - The window is counted from `#lastInvoluntaryLeftAt`, the instant the
  //     SFU's `Leave` landed on THIS client. That is strictly later than the
  //     mint. `move_user_to_voice_channel_expecting`
  //     (`crates/core/database/src/voice/mod.rs`) mints the token, THEN
  //     releases any remote-control grant, THEN publishes the private event,
  //     and only THEN evicts each listed connection through
  //     `remove_identity_if_present` — the `RemoveParticipant` whose `Leave`
  //     starts our clock. All of that is already spent at marker age zero, so
  //     a marker age of N ms is a token age of N + (mint -> Leave) ms — the
  //     first of the two spans the allowance reserves. The marker can never
  //     run early.
  //   - `MOVE_PRECONNECT_BUDGET_MS` bounds only the work BEFORE
  //     `room.connect()`, but the SFU validates the JWT at the END of the
  //     handshake: the signaling round trip, ICE and DTLS all sit outside the
  //     budget. Reaching `connect()` in time is not being ACCEPTED in time.
  //
  // So headroom under `TTL - budget` is NEGATIVE by the sum of the two, and
  // the old 7_000 could be spent: a marker accepted at ~6.5 s whose budget
  // went on a stalled `Room.getLocalDevices` reached the SFU past
  // T_mint + 10 s and was refused — a doomed connect and an error modal, where
  // a `stale-notice` would have carded the same destination with the same
  // Rejoin button, sooner. `MOVE_TOKEN_SKEW_ALLOWANCE_MS` reserves both spans.
  //
  // 🔴 Do not re-derive 7_000 from `TTL - budget`. That derivation is the
  // defect; it is pinned as a three-term sum here so no single term can be
  // raised without another being lowered.
  const spent =
    MOVE_VERIFIED_WINDOW_MS +
    MOVE_PRECONNECT_BUDGET_MS +
    MOVE_TOKEN_SKEW_ALLOWANCE_MS;
  assert.ok(
    spent <= 10_000,
    `window + budget + skew is ${spent}ms, past the 10_000ms token TTL`,
  );
  // And the window IS the remainder, not merely something that fits under it:
  // written any other way, a term that moves leaves slack or overdraft that
  // nobody re-derived.
  assert.equal(
    MOVE_VERIFIED_WINDOW_MS,
    10_000 - MOVE_PRECONNECT_BUDGET_MS - MOVE_TOKEN_SKEW_ALLOWANCE_MS,
    `the verified window is no longer TTL - budget - skew: ${MOVE_VERIFIED_WINDOW_MS}ms against ${10_000 - MOVE_PRECONNECT_BUDGET_MS - MOVE_TOKEN_SKEW_ALLOWANCE_MS}ms`,
  );
  assert.ok(MOVE_VERIFIED_WINDOW_MS > 0);
});

test("🔴 the skew allowance is NON-ZERO — a zero allowance IS the bug it repairs", () => {
  // Zero is not a conservative default here. It restores `window =
  // TTL - budget` under a new name, and with it the two false claims that
  // arithmetic rests on: that the marker clock starts at the mint, and that
  // the budget ends at the SFU's verdict. Neither holds, so a zero allowance
  // re-ships the defect while leaving the sum above green.
  //
  // The floor is what the guess is worth, and it IS a guess — the event
  // carries `url`, `token`, `device_id`, `conn_nonce`, `from` and `to` and no
  // timestamp of any kind, so neither span is measurable from this client and
  // nobody here has instrumented them. Roughly a second of backend legs (a
  // Redis grant probe, a publish, and on the remote-control path a LiveKit RPC
  // and a database write) plus roughly a second of connect handshake, which is a
  // couple of hundred ms direct and several times that behind TURN or on a
  // cold ICE gather. Below 1_000 the allowance no longer covers even the
  // handshake half it is named for.
  assert.ok(
    MOVE_TOKEN_SKEW_ALLOWANCE_MS > 0,
    "the token-skew allowance is zero — the verified window is back to TTL - budget, measured from the client's drop clock rather than the mint",
  );
  assert.ok(
    MOVE_TOKEN_SKEW_ALLOWANCE_MS >= 1_000,
    `the token-skew allowance is ${MOVE_TOKEN_SKEW_ALLOWANCE_MS}ms, which does not cover the connect handshake it is half named for`,
  );
  // It is an ALLOWANCE, not the whole credential: one that ate what the budget
  // leaves would drive the window to zero and make every move a stale-notice.
  assert.ok(
    MOVE_TOKEN_SKEW_ALLOWANCE_MS < 10_000 - MOVE_PRECONNECT_BUDGET_MS,
    `the token-skew allowance is ${MOVE_TOKEN_SKEW_ALLOWANCE_MS}ms, which leaves no verified window at all`,
  );
});

test("🔴 the three terms currently spend the TTL as 3_000 + 2_000 + 5_000", () => {
  // The VALUES, pinned apart from the relationship above so that the two
  // failures read differently: the sum test fires when the terms stop adding
  // up, this one fires when someone re-sizes a term that adds up fine. Every
  // number here is argued in the constants' own docs — the budget against the
  // 45 s MLS deadline it has to beat, the allowance as an openly stated guess
  // about two unmeasured spans — and re-sizing any of them is a decision that
  // should have to touch this spec rather than slip through as a literal.
  assert.equal(MOVE_PRECONNECT_BUDGET_MS, 3_000);
  assert.equal(MOVE_TOKEN_SKEW_ALLOWANCE_MS, 2_000);
  assert.equal(MOVE_VERIFIED_WINDOW_MS, 5_000);
});

test("🔴 the notice window is the OUTER bound and clears the token TTL", () => {
  // The ordering is the property: a notice window at or below the verified one
  // would make `stale-notice` unreachable and quietly restore the silence this
  // arm exists to end, while a verified window above the notice one would let
  // a session act on a marker it is not even allowed to be told about.
  assert.ok(
    MOVE_VERIFIED_WINDOW_MS < MOVE_NOTICE_WINDOW_MS,
    `verified window ${MOVE_VERIFIED_WINDOW_MS}ms is not inside the notice window ${MOVE_NOTICE_WINDOW_MS}ms — stale-notice is unreachable`,
  );
  // It must clear the token's own 10 s life comfortably: cutting the notice
  // off below that would silence notices that were still redeemable, and it
  // must clear one bad socket cycle too (`Controller.ts` caps its backoff at
  // 15 s, quoted in `voiceRejoinPolicy.ts`).
  assert.ok(MOVE_NOTICE_WINDOW_MS > 10_000);
  assert.ok(MOVE_NOTICE_WINDOW_MS > 15_000);
  assert.equal(MOVE_NOTICE_WINDOW_MS, 60_000);
  // And it is a BOUND, not a synonym for "forever": the marker has no other
  // expiry, so an unbounded one would let a drop from hours ago card a move.
  assert.ok(MOVE_NOTICE_WINDOW_MS <= 5 * 60_000);
});

// --- Textual contract against state.tsx -----------------------------------
//
// `state.tsx` cannot be imported under `node --test` (Solid, livekit,
// `@revolt/client`), so the WIRING of the rule above is unreachable by every
// gate this repo has. That is not a theory: two known-bad mutations of the
// move handler — dropping the auto-rejoin disarm, and hard-coding the world
// so every session moves — were run against this tree, and `tsc`, the full
// suite, `vite build` and `prettier --check` all stayed green on each. These
// scans are the cheapest honest substitute, and they pin property VALUES
// rather than identifiers because a one-token revert has already shipped
// green past an identifier scan once on this slice.
const STATE = readFileSync(new URL("./state.tsx", import.meta.url), "utf8");

/**
 * Crude comment stripper, the same shape the sibling AFK spec uses: every
 * scan below reads code, not prose, and `state.tsx` is entitled to quote the
 * rules it obeys when it explains why it obeys them.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const STATE_CODE = stripComments(STATE);

/**
 * The move handler, from its header to its own two-space-indented `}`. The
 * header is pinned whole, parameter type included: `VoiceMoveRequest` is the
 * SDK's type for the event, so tsc checks every field the handler reads
 * against what stoat.js actually emits. An inline type compiles against the
 * emitter's catch-all `string` overload whatever the event really carries,
 * which is how a listener for an event nobody sends type-checked (FE1-1).
 */
const MOVE_HANDLER =
  /async #handleVoiceMove\(move: VoiceMoveRequest\): Promise<void> \{[\s\S]*?\n {2}\}\n/.exec(
    STATE_CODE,
  )?.[0] ?? "";

test("state.tsx has a #handleVoiceMove body the scans below can read", () => {
  // Without this every scan that follows passes vacuously on an empty string.
  assert.ok(
    MOVE_HANDLER.length > 0,
    "no #handleVoiceMove body found in state.tsx — every scan below would pass vacuously",
  );
  assert.ok(MOVE_HANDLER.includes("moveDecision({"));
});

test("state.tsx calls moveDecision instead of restating it", () => {
  const calls = STATE_CODE.match(/moveDecision\(\{/g) ?? [];
  assert.equal(
    calls.length,
    1,
    `expected 1 moveDecision call site, saw ${calls.length}`,
  );
});

/** The text of the object `#handleVoiceMove` hands `moveDecision`, or `""`. */
const MOVE_WORLD_SOURCE =
  /moveDecision\(\{([\s\S]*?)\n {4}\}\);/.exec(MOVE_HANDLER)?.[1] ?? "";

const MOVE_WORLD = Object.fromEntries(
  [...MOVE_WORLD_SOURCE.matchAll(/^\s*(\w+):\s*(.+?),\s*$/gm)].map((m) => [
    m[1],
    m[2].trim(),
  ]),
);

test("🔴 the move world is READ, never asserted as a constant", () => {
  // The MED-1 lesson, in the one place it would do the most damage.
  // `callState: "CONNECTED"` plus `currentChannelId: move.from` is two
  // tokens, passes tsc, the whole suite and the build, and turns the gate
  // into an unconditional move: every idle device the user owns dials into
  // the new room and publishes its microphone, then races a single-mint
  // token and gets evicted on duplicate identity.
  //
  // The drop marker carries the same danger in a newer shape. The marker
  // steps of the addressing rule are what let a session that is NOT connected
  // accept a move, so they are only safe while their two inputs are read from
  // the session itself. `lastInvoluntaryChannelId: move.from` is one token and
  // would make every signed-in device claim the SFU had just removed it from
  // exactly the channel named in the event — the idle-phone bug again, this
  // time through the branch that was widened to fix the real target. `now`
  // must likewise be the clock, not the drop time: pinning them to each other
  // would make the window always zero-length or always open.
  //
  // The device pair is the newest member of the same family and the most
  // tempting to "simplify". `sessionDeviceId: move.deviceId` is one token,
  // passes tsc and every other gate here, and makes the device test compare a
  // value to itself — tautologically true on every session the event reaches,
  // which is precisely the unconditional-move bug above wearing the one
  // defense that was added to prevent it. `deviceId` must come off the WIRE
  // and `sessionDeviceId` out of THIS session; neither may be derived from
  // the other, and an exact map is what makes that checkable. Do not relax
  // this to a subset — a subset check cannot see a key that was dropped.
  //
  // The three nonces are the same family again. `sessionConnNonce:
  // move.connNonce` or `lastInvoluntaryConnNonce: move.connNonce` is one token
  // and makes the nonce gate compare the event to itself, which is equal on
  // every session it reaches, so every idle device moves. Dropping a key does
  // the opposite: the gate goes permanently inactive and the P-1 hole reopens
  // silently. The event's nonce comes off the WIRE, the other two out of THIS
  // session.
  //
  // S-a's three are the same family once more, and never filled from an
  // event. `pendingConnNonce: move.connNonce` or `replacedConnNonce:
  // move.connNonce` is one token, and it turns every session in the marker or
  // CONNECTED-to-`from` shape into the target: a sibling that the server is
  // evicting would redeem the single-mint token. `replacedLeftAt` must be the
  // replaced drop's own time, not the clock, or the window never closes.
  //
  // The three verdicts the handler computes itself are the newest members.
  // `tokenForThisConnection: true` is one token and gives every device seat
  // with a fresh marker step 4's proof without the token ever being checked.
  // `lastIdentityIsDevice: true` is one token and lets a BARE seat with a
  // fresh marker and no nonce follow (FE2A-2): the same-session sibling that
  // rule exists to refuse, joining with a live mic.
  // `destinationGated: false` is one token and walks every move, a
  // moderator's or the AFK sweep's, straight past an age, password or
  // spoiler check. Each must be the handler's own local, and the next test
  // pins what those locals are computed from.
  //
  // One `key: value,` per line and no shorthand: this scan reads nothing
  // else, so a shorthand key would simply vanish from the map. The line
  // check below says so directly instead of leaving it to the map diff.
  const unread = MOVE_WORLD_SOURCE.split("\n").filter(
    (line) => line.trim() !== "" && !/^\s*(\w+):\s*(.+?),\s*$/.test(line),
  );
  assert.deepEqual(
    unread,
    [],
    `the moveDecision world has lines that are not one \`key: value,\` each (shorthand, or a value split over lines), so this scan cannot read them: ${JSON.stringify(unread)}`,
  );
  assert.deepEqual(MOVE_WORLD, {
    callState: "this.state()",
    currentChannelId: "this.channel()?.id",
    from: "move.from",
    to: "move.to",
    url: "move.url",
    token: "move.token",
    tokenForThisConnection: "forThisConnection",
    lastIdentityIsDevice: "identityIsDevice",
    destinationKnown: "destination !== undefined",
    destinationGated: "gated",
    lastInvoluntaryChannelId: "this.#lastInvoluntaryChannelId",
    lastInvoluntaryLeftAt: "this.#lastInvoluntaryLeftAt",
    deviceId: "move.deviceId",
    sessionDeviceId: "this.#sessionDeviceId",
    connNonce: "move.connNonce",
    sessionConnNonce: "this.#connNonce",
    lastInvoluntaryConnNonce: "this.#lastInvoluntaryConnNonce",
    pendingConnNonce: "this.#dialingConnNonce()",
    replacedConnNonce: "this.#replacedConnNonce",
    replacedLeftAt: "this.#replacedLeftAt",
    now: "Date.now()",
  });
});

test("🔴 the move world's locals are computed from this session and the event, once each", () => {
  // The map above pins WHICH local each key reads. This pins what the local
  // holds: `const gated = false;` or `const forThisConnection = true;` keeps
  // the map green and is the same one-token bypass, one line up. Each local
  // is declared exactly once, off exactly these inputs, and never assigned
  // again: the gate off THIS member's own check state for the resolved
  // destination, the token verdict off the identity THIS connection last
  // joined as (never off the event, which would make it a tautology), and
  // the device test off that same identity.
  assert.ok(MOVE_HANDLER.length > 0, "no #handleVoiceMove body to scan");
  const code = MOVE_HANDLER.replace(/\s+/g, " ");
  for (const [name, declaration] of [
    [
      "destination",
      "const destination = this.getClient()?.channels.get(move.to);",
    ],
    [
      "gated",
      "const gated = destination !== undefined && this.#memberGate(destination);",
    ],
    [
      "forThisConnection",
      'const forThisConnection = moveTokenUsable({ token: move.token, expectedIdentity: this.#lastLocalIdentity ?? "", to: move.to, });',
    ],
    [
      "identityIsDevice",
      'const identityIsDevice = (this.#lastLocalIdentity ?? "").includes(":");',
    ],
  ]) {
    assert.equal(
      code.split(declaration).length - 1,
      1,
      `#handleVoiceMove no longer declares \`${declaration}\` exactly once`,
    );
    const writes =
      MOVE_HANDLER.match(new RegExp(`(?<![\\w.#])${name} =(?!=)`, "g")) ?? [];
    assert.equal(
      writes.length,
      1,
      `\`${name}\` is assigned ${writes.length} times in #handleVoiceMove — only its declaration may set it`,
    );
  }
});

test("🔴 the move path disarms the auto-rejoin loop before connecting", () => {
  // `shouldAutoRejoin` is a deny-list that fails OPEN on an absent reason,
  // and the old room's `disconnected` listener closes over the OLD channel.
  // Losing any of these three lets a rejoin win the race and silently undo a
  // moderator's decision.
  for (const stmt of [
    "this.#rejoinSeq++;",
    "this.#cancelRejoinWait?.();",
    "this.room()?.removeAllListeners();",
  ]) {
    assert.ok(
      MOVE_HANDLER.includes(stmt),
      `#handleVoiceMove no longer runs \`${stmt}\` — the rejoin loop can win the race and re-join the OLD channel`,
    );
  }
});

test("#rejoinSeq is bumped in exactly the two places that may cancel the loop", () => {
  // `disconnect()` and the move. `#autoRejoin`'s own `++this.#rejoinSeq` is a
  // prefix bump and deliberately not counted here.
  const bumps = STATE_CODE.match(/this\.#rejoinSeq\+\+/g) ?? [];
  assert.equal(
    bumps.length,
    2,
    `expected 2 #rejoinSeq bumps (disconnect + move), saw ${bumps.length}`,
  );
});

/**
 * Every `this.connect(…)` call in `#handleVoiceMove`: the index it starts at
 * and its argument list, whitespace-squashed, with no padding inside the
 * parentheses and no trailing commas, so line wrapping cannot change it.
 */
function moveConnectCalls(): { at: number; call: string }[] {
  return [...MOVE_HANDLER.matchAll(/this\.connect\(/g)].map((m) => ({
    at: m.index,
    call: balancedGroup(MOVE_HANDLER, m.index + m[0].length - 1)
      .replace(/\s+/g, " ")
      .replace(/,\s*\}/g, " }")
      .replace(/,\s*\)/g, ")")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")"),
  }));
}

/** The token arm's exact arguments: the event's credentials, the budget, S1. */
const MOVE_TOKEN_ARM_CALL =
  "(destination, { url: decision.url, token: decision.token }, { movePreConnectBudgetMs: MOVE_PRECONNECT_BUDGET_MS, moveLatchBypass: true })";

test("🔴 the move never releases a join-refusal latch; only the token arm steps past one (D4)", () => {
  // An earlier cut RELEASED the destination's latch before connecting. That
  // is a permanent side effect of an event, and a tokenless follow (an
  // ordinary join) would then dial a channel the server has already refused
  // this member, with nothing to show for it but the refusal again. The
  // merged rule is voice-move's S1: the latch stays, and only an attempt
  // carrying the server's own move token may step past it, for the reasons
  // `moveBypassesRefusalLatch` allows. `#releaseJoinRefusal` keeps its other
  // callers; the move is not one of them.
  assert.ok(MOVE_HANDLER.length > 0, "no #handleVoiceMove body to scan");
  assert.ok(
    !MOVE_HANDLER.includes("#releaseJoinRefusal("),
    "#handleVoiceMove calls #releaseJoinRefusal — a move clears a refusal the server gave, and the tokenless arm then re-dials it (D4)",
  );
  // The bypass flag: exactly one in the store's code, and it is inside the
  // token arm's call. On a tokenless call (the join arm, the D5 retry, the
  // rejoin loop) `connect()` ignores it today, because it reads
  // `opts?.moveLatchBypass` only alongside `auth`. That makes a second one
  // dead weight until someone relaxes that guard, and from then on a way
  // for an attempt with no move token past a refusal the server gave.
  const bypasses = STATE_CODE.match(/moveLatchBypass:/g) ?? [];
  assert.equal(
    bypasses.length,
    1,
    `expected exactly 1 \`moveLatchBypass:\` in state.tsx (the move's token arm), saw ${bypasses.length}`,
  );
  const calls = moveConnectCalls();
  const withBypass = calls.filter(({ call }) =>
    call.includes("moveLatchBypass: true"),
  );
  assert.equal(
    withBypass.length,
    1,
    `expected exactly 1 connect() call in #handleVoiceMove passing \`moveLatchBypass: true\`, saw ${withBypass.length}: ${JSON.stringify(calls.map(({ call }) => call))}`,
  );
  assert.equal(
    withBypass[0].call,
    MOVE_TOKEN_ARM_CALL,
    "the only connect() that passes `moveLatchBypass: true` is not the token arm's",
  );
  // And every other connect() in the handler is the bare tokenless join:
  // no credentials, no budget, no bypass, not a rejoin.
  for (const { call } of calls.filter((c) => c !== withBypass[0]))
    assert.equal(
      call,
      "(destination)",
      `#handleVoiceMove has a connect() that is neither the token arm nor the bare tokenless join: \`this.connect${call}\``,
    );
});

test("the move's token arm connects with the event's own credentials and a bounded budget, only on `move`", () => {
  // One call, pinned whole. The credentials are the DECISION's (so a url-less
  // or token-less event never reaches this arm, D2), the budget is what keeps
  // a 10 s token alive past the 45 s MLS deadline, and the bypass is S1.
  const calls = moveConnectCalls().filter(
    ({ call }) => call === MOVE_TOKEN_ARM_CALL,
  );
  assert.equal(
    calls.length,
    1,
    `expected exactly 1 \`this.connect${MOVE_TOKEN_ARM_CALL}\` in #handleVoiceMove, saw ${calls.length}: ${JSON.stringify(moveConnectCalls().map(({ call }) => call))}`,
  );
  // Inside the `move` branch, never on the tokenless `join`.
  const inMoveBranch = [
    ...MOVE_HANDLER.matchAll(/if \(decision\.action === "move"\) \{/g),
  ].some((branch) => {
    const blockAt = branch.index + branch[0].length - 1;
    const block = balancedGroup(MOVE_HANDLER, blockAt);
    return calls[0].at > blockAt && calls[0].at < blockAt + block.length;
  });
  assert.ok(
    inMoveBranch,
    'the token arm\'s connect() is not inside an `if (decision.action === "move") { … }` block',
  );
});

test("the pre-connect budget actually reaches both unbounded pre-connect awaits", () => {
  // Passing the option and then not reading it is the silent half of the
  // failure: device enumeration and the MLS registration are the two
  // unbounded awaits between `#connectAttempt`'s entry and `room.connect()`.
  //
  // Three reads since the key-status wait was added. That wait has a bound
  // of its own (`KEY_STATUS_WAIT_MS`), but 5 s is half a move token's life,
  // so on a move it is clamped to what is left of the budget like the other
  // two. The count went from 2 to 3 for that read and nothing else.
  const uses = STATE_CODE.match(/preConnectBudgetLeft\(\)/g) ?? [];
  assert.equal(
    uses.length,
    3,
    `expected 3 budget reads (device enumeration + key-status wait + MLS deadline), saw ${uses.length}`,
  );
  assert.ok(
    /this\.#waitForKeyStatus\(\s*bridge,\s*gen,\s*preConnectBudgetLeft\(\),?\s*\)/.test(
      STATE_CODE,
    ),
    "the key-status wait is no longer handed what is left of the move budget",
  );
  assert.ok(
    /Math\.min\(\s*KEY_STATUS_WAIT_MS,\s*budgetLeftMs\s*\)/.test(STATE_CODE),
    "the key-status wait is no longer clamped to the move budget",
  );
  assert.ok(
    /Math\.min\(\s*MLS_REQUEST_DEADLINE_MS,\s*moveBudgetLeftMs\s*\)/.test(
      STATE_CODE,
    ),
    "the MLS registration deadline is no longer clamped to the move budget",
  );
});

test("🔴 M3 lifts the move budget together with a dropped token, and only there", () => {
  // The budget exists because a pre-minted token is ticking. When M3 drops
  // that token (`join`), the attempt mints its own after setup like any other
  // join, and a budget left standing clamps the MLS key listener to what is
  // left of 3 s for no reason: an E2EE call held loud on every move whose
  // token M3 dropped. So the deadline is a `let`, it is assigned exactly
  // once after its declaration, to `undefined`, in M3's `join` case beside
  // the token drop, and that case sits between the budget reads: after
  // device enumeration and the key-status wait (which both run before M3,
  // while the token is still ticking, and have to stay bounded) and before
  // the MLS clamp (which must see the lifted budget).
  const declarations =
    STATE_CODE.match(/\blet preConnectDeadlineAt =(?!=)/g) ?? [];
  assert.equal(
    declarations.length,
    1,
    `expected exactly 1 \`let preConnectDeadlineAt =\` in state.tsx, saw ${declarations.length}`,
  );
  const assignments = [
    ...STATE_CODE.matchAll(/(?<!let )\bpreConnectDeadlineAt = ([^;]+);/g),
  ];
  assert.deepEqual(
    assignments.map((m) => m[1].trim()),
    ["undefined"],
    "the move budget's deadline is reassigned somewhere other than M3's single clear to `undefined`",
  );
  const switches = [...STATE_CODE.matchAll(/switch \(authDecision\) \{/g)];
  assert.equal(
    switches.length,
    1,
    `expected exactly 1 \`switch (authDecision)\` (M3) in state.tsx, saw ${switches.length}`,
  );
  const switchAt = switches[0].index + switches[0][0].length - 1;
  const m3 = balancedGroup(STATE_CODE, switchAt);
  const join = /case "join":([\s\S]*?)\bbreak;/.exec(m3);
  assert.ok(join, 'M3\'s switch has no `case "join": … break;`');
  for (const stmt of ["auth = undefined;", "preConnectDeadlineAt = undefined;"])
    assert.ok(
      join[1].includes(stmt),
      `M3's \`join\` case does not run \`${stmt}\``,
    );
  const clearAt = switchAt + m3.indexOf("preConnectDeadlineAt = undefined;");
  assert.equal(
    assignments[0].index,
    clearAt,
    "the budget's one clear is not the one in M3's `join` case",
  );
  const reads = [...STATE_CODE.matchAll(/preConnectBudgetLeft\(\)/g)].map(
    (m) => m.index,
  );
  // Three reads since the key-status wait was added (see the test above):
  // the first two are before M3, the last is the MLS clamp after its clear.
  assert.ok(
    reads.length === 3 &&
      reads[0] < reads[1] &&
      reads[1] < switchAt &&
      clearAt < reads[2],
    "M3's budget clear is not between the two reads before it (device enumeration, key-status wait) and the MLS clamp read",
  );
  // `isMove` answers "did this attempt START as a move" (chime suppression),
  // so it is fixed off the deadline BEFORE M3 can lift it.
  const isMoveAt = STATE_CODE.indexOf(
    "const isMove = preConnectDeadlineAt !== undefined;",
  );
  assert.ok(
    isMoveAt >= 0 && isMoveAt < switchAt,
    "`const isMove = preConnectDeadlineAt !== undefined;` is gone or now reads the deadline after M3 has lifted it",
  );
});

const DISCONNECT_LISTENER =
  /room\.addListener\("disconnected", \(reason\) => \{[\s\S]*?\n {4}\}\);/.exec(
    STATE_CODE,
  )?.[0] ?? "";

test("state.tsx has a `disconnected` listener body the marker scans can read", () => {
  // Without this the two scans below pass vacuously on an empty string.
  assert.ok(
    DISCONNECT_LISTENER.length > 0,
    "no `disconnected` listener found in state.tsx — the marker scans would pass vacuously",
  );
  assert.ok(DISCONNECT_LISTENER.includes("shouldAutoRejoin("));
});

/**
 * The room's `connected` listener: a SYNCHRONOUS arrow (an `async` one does
 * not match), so everything inside it runs in one block with the `CONNECTED`
 * state write.
 */
const CONNECTED_LISTENER =
  /room\.addListener\("connected", \(\) => \{[\s\S]*?\n {4}\}\);/.exec(
    STATE_CODE,
  )?.[0] ?? "";

test("state.tsx has a synchronous `connected` listener body the nonce scans can read", () => {
  // Without this the session-nonce scans below pass vacuously on an empty
  // string.
  assert.ok(
    CONNECTED_LISTENER.length > 0,
    "no synchronous `connected` listener found in state.tsx — the session-nonce scans would pass vacuously",
  );
  assert.ok(CONNECTED_LISTENER.includes('this.#setState("CONNECTED");'));
});

test("🔴 the involuntary-drop marker is recorded, ABOVE the rejoin branch", () => {
  // The marker steps of the addressing rule — the half that makes a real move
  // work at all — read a marker this listener is the only writer of. Deleting
  // the two writes is a two-line revert that leaves tsc, the whole suite,
  // `vite build` and `prettier --check` green while making every marker step
  // permanently false, i.e. it silently restores "a moderator moves you and
  // you land nowhere". That was measured, not guessed.
  const writeChannel = "this.#lastInvoluntaryChannelId = channel.id;";
  const writeAt = "this.#lastInvoluntaryLeftAt = Date.now();";
  assert.ok(
    DISCONNECT_LISTENER.includes(writeChannel),
    "the drop marker records no channel — no marker step can ever match and every late move is ignored",
  );
  assert.ok(
    DISCONNECT_LISTENER.includes(writeAt),
    "the drop marker records no timestamp — no marker step can ever match and every late move is ignored",
  );
  // Order matters as much as presence. Below the branch, only one of the two
  // arms would record, and the arm that misses out is the fail-open
  // `RECONNECTING` one — where `#autoRejoin` is meanwhile re-joining the OLD
  // channel, so the moderator's decision is not merely dropped but reversed.
  const branchAt = DISCONNECT_LISTENER.indexOf("shouldAutoRejoin(");
  assert.ok(
    DISCONNECT_LISTENER.indexOf(writeChannel) < branchAt &&
      DISCONNECT_LISTENER.indexOf(writeAt) < branchAt,
    "the drop marker is written after the auto-rejoin branch — one of the two arms misses it, and the fail-open one is the worse half",
  );
  // The third field, the dropped connection's nonce, rides with the other
  // two at the same site for the same reason. Missing, the marker gate goes
  // inactive on every drop and a bare sibling's fresh marker falls back to
  // step 1, which is silent (P-1). Below the branch, the fail-open arm
  // snapshots nothing.
  const writeNonce =
    /this\.#lastInvoluntaryConnNonce = (?!undefined;)[^;]+;/.exec(
      DISCONNECT_LISTENER,
    );
  assert.ok(
    writeNonce,
    "the drop marker records no connection nonce — the marker clauses' nonce gate can never be active and a bare sibling's fresh marker is silenced by step 1",
  );
  assert.ok(
    writeNonce.index < branchAt,
    "the drop marker's nonce is written after the auto-rejoin branch — one of the two arms misses it",
  );
});

test("🔴 the drop marker is RECORDED on the drop path and nowhere else", () => {
  // The forgery surface is a write that SETS the marker, because that is the
  // write that asserts "the SFU just removed us from X" — which is exactly
  // what the marker steps trust. Exactly one such write may exist, on the
  // `disconnected` path, and its value must come from the room's own channel.
  //
  // Writes that CLEAR the marker are unbounded on purpose. A clear can only
  // ever narrow those steps, never widen them, so pinning their COUNT pins an
  // implementation detail rather than a property: `connect()` and `connected`
  // both clear today, and a third safe clear site is a change this scan must
  // not be the thing that blocks. Classifying by value instead of counting
  // heads is strictly stronger than the head-count this replaces — that one
  // could not have told a new clear apart from a new forgery at all.
  const writes = [
    ...STATE_CODE.matchAll(/this\.#lastInvoluntaryChannelId = ([^;]+);/g),
  ].map((m) => m[1].trim());
  const records = writes.filter((rhs) => rhs !== "undefined");
  assert.deepEqual(
    records,
    ["channel.id"],
    `exactly one path may RECORD the involuntary-drop marker, off the dropped room's own channel; saw ${JSON.stringify(records)}`,
  );
  assert.ok(
    writes.length > records.length,
    "nothing clears the involuntary-drop marker any more — a stale marker outlives its meaning",
  );
  // The timestamp half is the same story: one setter, and it is the clock.
  const stamps = [
    ...STATE_CODE.matchAll(/this\.#lastInvoluntaryLeftAt = ([^;]+);/g),
  ].map((m) => m[1].trim());
  assert.deepEqual(
    stamps.filter((rhs) => rhs !== "undefined"),
    ["Date.now()"],
    "the drop timestamp is set from something other than the clock, or on more than one path",
  );
  assert.equal(
    writes.length,
    stamps.length,
    `the marker's two fields are written on different sets of paths (${writes.length} channel writes vs ${stamps.length} timestamp writes) — half a marker is not a marker`,
  );
  // The nonce is the marker's THIRD field: recorded on the one drop path,
  // cleared wherever the other two are, and on the same count of paths. A
  // nonce that outlives its marker's clear is harmless on its own (the marker
  // terms are what gate it), but a nonce CLEARED without the marker leaves a
  // fresh marker with no nonce, so the gate drops back to step 1 for exactly
  // the seat it was meant to judge.
  const nonces = [
    ...STATE_CODE.matchAll(/this\.#lastInvoluntaryConnNonce = ([^;]+);/g),
  ].map((m) => m[1].trim());
  const nonceRecords = nonces.filter((rhs) => rhs !== "undefined");
  assert.equal(
    nonceRecords.length,
    1,
    `exactly one path may RECORD the marker's connection nonce; saw ${JSON.stringify(nonceRecords)}`,
  );
  // P-14: off THIS attempt's own captured nonce, never off `#connNonce`. A
  // superseded room's late `disconnected` lands after the next connection has
  // written `#connNonce`, and snapshotting it would file the NEWER
  // connection's nonce under the OLD drop, so a move of the new seat would
  // read as addressed to the dead one.
  assert.notEqual(
    nonceRecords[0],
    "this.#connNonce",
    "the drop marker snapshots `#connNonce` — a superseded room's late drop records the NEWER connection's nonce (P-14)",
  );
  assert.ok(
    /^\w+$/.test(nonceRecords[0] ?? "") &&
      new RegExp(`\\blet ${nonceRecords[0]}\\b`).test(STATE_CODE),
    `the drop marker's nonce is recorded from \`${nonceRecords[0]}\`, not from a per-attempt \`let\` local (P-14)`,
  );
  assert.ok(
    new RegExp(
      `\\b${nonceRecords[0]}\\s*=\\s*[^;]*attributes\\?\\.\\[CONN_NONCE_ATTRIBUTE\\]`,
    ).test(CONNECTED_LISTENER),
    `the per-attempt local \`${nonceRecords[0]}\` the drop marker records is not assigned from the attribute in the \`connected\` listener`,
  );
  assert.equal(
    nonces.length,
    writes.length,
    `the marker's nonce is written on a different set of paths than its channel (${nonces.length} nonce writes vs ${writes.length} channel writes) — half a marker is not a marker`,
  );
});

test("🔴 #sessionDeviceId has exactly two writes, each guarded by which side minted the identity", () => {
  // The device half of the addressing rule is only unforgeable while this
  // field holds the device THIS session actually presented. It has two
  // writers and they are mutually exclusive by construction:
  //
  //   - the BRIDGE write, guarded by `!preMintedAuth`, for an ordinary join
  //     where we choose the identity;
  //   - the MOVE write, guarded by `preMintedAuth`, after `room.connect()`,
  //     read back off the identity the SFU actually issued.
  //
  // Reverting the second to the bridge's `e2eeDeviceId` — or dropping the
  // `.split(":")[1]` that recovers the device half of `{user}:{device}` — is
  // invisible to every other gate this repo has: `tsc`, the full suite and
  // `vite build` were all measured green on exactly that revert. It is not
  // invisible in effect. The move token is minted by the server for the
  // connection it picks from the OLD room's SFU participant list
  // (`select_move_connection`; the `voice_identity` mapping is only a
  // preference), so after a bridge re-provision the two answers
  // part company, this session records a device the server never named, and
  // the NEXT move's device test compares the wrong pair — which either
  // silences a real move or re-opens the hole the test was added to close.
  //
  // Both guards are pinned, because an UNGUARDED write is the same defect
  // wearing fewer tokens: it would let the bridge's answer overwrite the SFU's
  // on the move path.
  const writes = [
    ...STATE_CODE.matchAll(
      /if \(([^)]*)\)\s*this\.#sessionDeviceId =\s*([\s\S]*?);/g,
    ),
  ].map((m) => [
    m[1].replace(/\s+/g, " ").trim(),
    m[2].replace(/\s+/g, " ").trim(),
  ]);
  // Every write is guarded: the guarded count must account for ALL of them.
  const allWrites = STATE_CODE.match(/this\.#sessionDeviceId =(?!=)/g) ?? [];
  assert.equal(
    writes.length,
    allWrites.length,
    `${allWrites.length} writes to #sessionDeviceId but only ${writes.length} are guarded by an \`if\` — an unguarded write lets the bridge's device overwrite the SFU's on the move path`,
  );
  assert.equal(
    writes.length,
    2,
    `expected exactly 2 #sessionDeviceId writes (the bridge join and the move), saw ${writes.length}: ${JSON.stringify(writes)}`,
  );

  const bridge = writes.filter(([, rhs]) => rhs.includes("e2eeDeviceId"));
  assert.equal(
    bridge.length,
    1,
    `expected exactly 1 #sessionDeviceId write off the bridge's e2eeDeviceId, saw ${bridge.length}`,
  );
  assert.ok(
    bridge[0][0].includes("!preMintedAuth"),
    `the bridge write is no longer withheld on the move path — its guard is \`${bridge[0][0]}\`, which does not mention !preMintedAuth, so the bridge's device id overwrites the identity the server minted the token for`,
  );

  const fromIdentity = writes.filter(([, rhs]) =>
    rhs.includes("localParticipant.identity"),
  );
  assert.equal(
    fromIdentity.length,
    1,
    `expected exactly 1 #sessionDeviceId write off the SFU's own identity, saw ${fromIdentity.length}`,
  );
  assert.ok(
    /(^|[^!\w])preMintedAuth/.test(fromIdentity[0][0]),
    `the identity write is not gated on the move path — its guard is \`${fromIdentity[0][0]}\``,
  );
  assert.ok(
    fromIdentity[0][1].includes('.split(":")[1]'),
    `the identity write no longer recovers the DEVICE half of \`{user}:{device}\` — its value is \`${fromIdentity[0][1]}\`, so #sessionDeviceId records the whole identity and the next move's device test can never match`,
  );

  // And the flag the two guards turn on is still derived from the pre-minted
  // token rather than from anything the client chose.
  assert.ok(
    STATE_CODE.includes("const preMintedAuth = auth !== undefined;"),
    "`preMintedAuth` is no longer derived from the presence of a handed-over token — both #sessionDeviceId guards turn on it",
  );
});

test("🔴 #connNonce is RECORDED once, unguarded, off the SFU's attribute, in the `connected` block", () => {
  // The session half of the CONNECTED clause's nonce gate. It is only honest
  // while it holds the nonce of the connection that is CONNECTED right now:
  //
  //   - ONE record, in the same synchronous `connected` block as the only
  //     `#setState("CONNECTED")`. Step 3 reads `sessionConnNonce` only while
  //     CONNECTED, so a record anywhere else can be stale for exactly the
  //     window it is read in;
  //   - UNGUARDED, so a connection whose token carried no nonce writes
  //     `undefined` over the previous one's instead of inheriting it. An
  //     inherited nonce is a wrong answer, which is worse than no answer;
  //   - off the SFU's own `CONN_NONCE_ATTRIBUTE` attribute. Taken from the
  //     event (`move.connNonce`) instead, the gate compares a value to itself
  //     and every session moves. That is the `sessionDeviceId: move.deviceId`
  //     tautology again, one token away.
  //
  // Clears are unbounded for the same reason as the marker's: an absent
  // session nonce only turns the gate off, which is the old ladder.
  assert.match(
    STATE_CODE,
    /^\s*#connNonce: string \| undefined;/m,
    "no `#connNonce: string | undefined` field in state.tsx",
  );
  assert.match(
    STATE_CODE,
    /^\s*#lastInvoluntaryConnNonce: string \| undefined;/m,
    "no `#lastInvoluntaryConnNonce: string | undefined` field in state.tsx",
  );
  const writes = [...STATE_CODE.matchAll(/this\.#connNonce = ([^;]+);/g)].map(
    (m) => m[1].replace(/\s+/g, " ").trim(),
  );
  const records = writes.filter((rhs) => rhs !== "undefined");
  assert.equal(
    records.length,
    1,
    `expected exactly 1 #connNonce record, saw ${JSON.stringify(records)}`,
  );
  assert.ok(
    writes.length > records.length,
    "nothing clears #connNonce — a torn-down connection's nonce survives into the next join",
  );
  assert.ok(
    CONNECTED_LISTENER.includes(`this.#connNonce = ${records[0]};`),
    "the #connNonce record is not in the `connected` listener beside the CONNECTED state write",
  );
  assert.equal(
    (STATE_CODE.match(/this\.#setState\("CONNECTED"\)/g) ?? []).length,
    1,
    "there is more than one CONNECTED write site — each one must record #connNonce, or step 3 reads a stale nonce there",
  );
  assert.doesNotMatch(
    STATE_CODE,
    /if\s*\([^)]*\)\s*\{?\s*this\.#connNonce = (?!undefined;)/,
    "the #connNonce record is guarded — a connection with no nonce inherits the previous one's",
  );
  // Provenance: the attribute read itself, or a local assigned from it
  // inside the same listener.
  const fromAttribute = /attributes\?\.\[CONN_NONCE_ATTRIBUTE\]/;
  assert.ok(
    fromAttribute.test(records[0] ?? "") ||
      (/^\w+$/.test(records[0] ?? "") &&
        new RegExp(
          `\\b${records[0]}\\s*=\\s*[^;]*attributes\\?\\.\\[CONN_NONCE_ATTRIBUTE\\]`,
        ).test(CONNECTED_LISTENER)),
    `#connNonce is recorded from \`${records[0]}\`, which is not the SFU's CONN_NONCE_ATTRIBUTE read in the \`connected\` listener`,
  );
});

test("🔴 S-a — #replacedConnNonce is RECORDED once, off the marker's nonce, in `connected` BEFORE the marker clear", () => {
  // The replaced nonce is the drop marker's nonce carried across a rejoin, so
  // it can only be read off the marker while the marker still holds it. After
  // the `connected` listener's marker clear it is `undefined`, and a record
  // placed there records nothing: S-a (v) goes silently dead and the late
  // event on a just-rejoined seat is `moved-elsewhere` again. Recorded from
  // anything else — `this.#connNonce`, the per-attempt local, the event — it
  // names the wrong connection, and the last of those is the one-token
  // tautology the MOVE_WORLD scan also guards.
  const records = [
    ...STATE_CODE.matchAll(/this\.#replacedConnNonce = ([^;]+);/g),
  ]
    .map((m) => m[1].replace(/\s+/g, " ").trim())
    .filter((rhs) => rhs !== "undefined");
  assert.deepEqual(
    records,
    ["this.#lastInvoluntaryConnNonce"],
    `expected exactly one #replacedConnNonce record, off \`this.#lastInvoluntaryConnNonce\`; saw ${JSON.stringify(records)}`,
  );
  const record = "this.#replacedConnNonce = this.#lastInvoluntaryConnNonce;";
  const recordAt = CONNECTED_LISTENER.indexOf(record);
  assert.ok(
    recordAt >= 0,
    "the #replacedConnNonce record is not in the `connected` listener — the rejoin's CONNECTED moment is the only one at which the marker still names the connection it replaced",
  );
  const clearAt = CONNECTED_LISTENER.indexOf(
    "this.#lastInvoluntaryConnNonce = undefined;",
  );
  assert.ok(
    clearAt >= 0,
    "the `connected` listener no longer clears the marker's nonce — the order scan has nothing to compare against",
  );
  assert.ok(
    recordAt < clearAt,
    "#replacedConnNonce is recorded AFTER the `connected` listener clears the marker's nonce — it records `undefined` and S-a (v) is dead",
  );
  // Its age, carried the same way: the ORIGINAL drop's time, off the marker,
  // before the marker's timestamp is cleared. Off the clock instead, a late
  // event is always inside the verified window.
  const stamps = [...STATE_CODE.matchAll(/this\.#replacedLeftAt = ([^;]+);/g)]
    .map((m) => m[1].replace(/\s+/g, " ").trim())
    .filter((rhs) => rhs !== "undefined");
  assert.deepEqual(
    stamps,
    ["this.#lastInvoluntaryLeftAt"],
    `expected exactly one #replacedLeftAt record, off \`this.#lastInvoluntaryLeftAt\`; saw ${JSON.stringify(stamps)}`,
  );
  const stampAt = CONNECTED_LISTENER.indexOf(
    "this.#replacedLeftAt = this.#lastInvoluntaryLeftAt;",
  );
  const stampClearAt = CONNECTED_LISTENER.indexOf(
    "this.#lastInvoluntaryLeftAt = undefined;",
  );
  assert.ok(
    stampAt >= 0 && stampClearAt >= 0 && stampAt < stampClearAt,
    "#replacedLeftAt is not recorded in the `connected` listener ahead of the marker's timestamp clear",
  );
});

test("🔴 S-a — connect() clears #replacedConnNonce beside `this.#connNonce = undefined;`", () => {
  // The replaced nonce belongs to the CURRENT connection, like `#connNonce`:
  // once a new join starts, that connection is being torn down, whichever
  // join this is (rejoin attempts included). Left standing, it carries a
  // ghost's nonce into the next connection, which then answers a move that
  // names that ghost as its own.
  const at = STATE_CODE.search(/^ {2}async connect\(/m);
  assert.ok(at >= 0, "no `async connect(` method found in state.tsx");
  const end = STATE_CODE.indexOf("this.#connectAttempt(", at);
  assert.ok(end > at, "connect() no longer calls this.#connectAttempt(");
  const body = STATE_CODE.slice(at, end);
  // Adjacent: only other `this.#x = undefined;` clears may sit between them,
  // in either order. That keeps it out of the `!opts?.rejoinAttempt` block
  // the marker clears live in, because `#connNonce`'s clear is not there.
  const clears = "(?:\\s*this\\.#\\w+ = undefined;)*?\\s*";
  assert.match(
    body,
    new RegExp(
      `this\\.#connNonce = undefined;${clears}this\\.#replacedConnNonce = undefined;|this\\.#replacedConnNonce = undefined;${clears}this\\.#connNonce = undefined;`,
    ),
    "connect() does not clear #replacedConnNonce next to `this.#connNonce = undefined;`",
  );
});

test("🔴 S-a — the #replacedConnNonce record is guarded to the rejoin loop reconnecting the MARKER'S channel", () => {
  // Only the auto-rejoin loop's attempt, dialing back into the very channel
  // the marker names, replaces a connection of this seat's. Any other join
  // replaced nothing, and a record there hands the new connection a dead
  // one's nonce: a later move naming that ghost would read as addressed to a
  // seat in a DIFFERENT call. `opts?.rejoinAttempt` alone is enough only for
  // as long as the rejoin loop never dials anything but the marker's
  // channel. That is an assumption about another code path, and the channel
  // test turns it into a property of this one. Both halves are pinned, as a
  // conjunction, so `||` or dropping either half fails here.
  const record = "this.#replacedConnNonce = this.#lastInvoluntaryConnNonce;";
  const recordAt = CONNECTED_LISTENER.indexOf(record);
  assert.ok(
    recordAt >= 0,
    "no #replacedConnNonce record in the `connected` listener — the guard scan would pass vacuously",
  );
  // Every `if (…) { … }` in the listener whose block holds the record.
  const guards: string[] = [];
  for (const m of CONNECTED_LISTENER.matchAll(/\bif \(/g)) {
    const condAt = m.index + m[0].length - 1;
    const cond = balancedGroup(CONNECTED_LISTENER, condAt);
    if (cond.length === 0) continue;
    const after = CONNECTED_LISTENER.slice(condAt + cond.length);
    const open = /^\s*\{/.exec(after);
    if (!open) continue;
    const blockAt = condAt + cond.length + open[0].length - 1;
    const block = balancedGroup(CONNECTED_LISTENER, blockAt);
    if (recordAt > blockAt && recordAt < blockAt + block.length)
      guards.push(cond.slice(1, -1).replace(/\s+/g, " ").trim());
  }
  assert.ok(
    guards.length > 0,
    "the #replacedConnNonce record is not inside an `if (…) { … }` in the `connected` listener — every join, not just the rejoin of the marker's channel, records a replaced nonce",
  );
  const conjuncts = guards.flatMap((g) => g.split("&&").map((c) => c.trim()));
  for (const term of [
    "opts?.rejoinAttempt",
    "channel.id === this.#lastInvoluntaryChannelId",
  ])
    assert.ok(
      conjuncts.includes(term),
      `the #replacedConnNonce record's guard does not require \`${term}\` as a conjunct — saw ${JSON.stringify(guards)}`,
    );
});

test("🔴 S-a — the moved-elsewhere arm retires #replacedConnNonce and #replacedLeftAt before it returns", () => {
  // The S-a record goes with the marker. A `moved-elsewhere` answer means the
  // move it could have matched has been answered, and this seat is being
  // disconnected. Left standing, a repeat of the event, or a later move naming
  // the same ghost, finds the replaced nonce still set.
  const moved = MOVE_HANDLER.indexOf('decision.reason === "moved-elsewhere"');
  const unknown = MOVE_HANDLER.indexOf('decision.reason === "unknown-channel"');
  assert.ok(
    moved >= 0 && unknown > moved,
    "no moved-elsewhere arm found ahead of the unknown-channel test — the clear scan would read the wrong span",
  );
  const arm = MOVE_HANDLER.slice(moved, unknown);
  const returnAt = arm.indexOf("return;");
  assert.ok(returnAt >= 0, "the moved-elsewhere arm does not return");
  for (const clear of [
    "this.#replacedConnNonce = undefined;",
    "this.#replacedLeftAt = undefined;",
  ]) {
    const at = arm.indexOf(clear);
    assert.ok(
      at >= 0 && at < returnAt,
      `the moved-elsewhere arm does not run \`${clear}\` before its \`return;\``,
    );
  }
});

test("🔴 B13 — no move notice blames a moderator; the copy is neutral", () => {
  // The AFK sweep moves members with nobody having acted, so "A moderator
  // moved you…" becomes a routine falsehood (D-5b2-2). One neutral copy
  // serves both movers. Read off comment-stripped code, so a comment that
  // quotes the old wording is not a finding, and case-insensitive, so a
  // lower-cased revert inside a sentence is.
  assert.doesNotMatch(
    STATE_CODE,
    /moderator moved you/i,
    'state.tsx still carries "A moderator moved you…" — a sweep move would blame a moderator nobody was',
  );
  // Not vacuous: the neutral copy is really there, in the move handler, so
  // the absence above cannot pass by the handler having been deleted.
  assert.ok(
    MOVE_HANDLER.includes("You were moved to"),
    'the move handler carries no "You were moved to" notice — the absence check above would pass vacuously',
  );
});

test("🔴 state.tsx reads the nonce attribute THROUGH the constant, never by a literal", () => {
  // The key is a manual cross-repo contract, and this is the client's single
  // copy of it. A literal index would pass today and drift silently later.
  // The gate would go inactive on every seat with nothing failing, because a
  // missing nonce is, by design, the old ladder.
  assert.ok(
    STATE_CODE.includes("attributes?.[CONN_NONCE_ATTRIBUTE]"),
    "state.tsx no longer reads `attributes?.[CONN_NONCE_ATTRIBUTE]`",
  );
  assert.doesNotMatch(
    STATE_CODE,
    /(["'`])conn\1/,
    'state.tsx carries a literal "conn" — read the attribute through CONN_NONCE_ATTRIBUTE',
  );
  assert.doesNotMatch(
    STATE_CODE,
    /attributes\??\.conn\b/,
    "state.tsx reads `attributes.conn` by name — read it through CONN_NONCE_ATTRIBUTE",
  );
  // And the constant is movePolicy's, not a local shadow of it.
  assert.match(
    STATE_CODE,
    /import\s*\{[^}]*\bCONN_NONCE_ATTRIBUTE\b[^}]*\}\s*from\s*"\.\/movePolicy";/,
    "state.tsx does not import CONN_NONCE_ATTRIBUTE from ./movePolicy",
  );
  assert.doesNotMatch(
    STATE_CODE,
    /\bCONN_NONCE_ATTRIBUTE\s*=/,
    "state.tsx declares its own CONN_NONCE_ATTRIBUTE, shadowing movePolicy's",
  );
});

test("🔴 the moved-elsewhere arm runs after the disarm and returns BEFORE the unknown-channel test", () => {
  // A sibling that is being evicted must (1) go through the shared block that
  // cancels the rejoin loop and strips the old room's listeners, because its
  // own rejoin of `from` with `forceDisconnect` kicks the moved seat; and (2)
  // leave before the arms that put the DESTINATION on the card with a Rejoin,
  // because that Rejoin re-races the moved seat too. Placed after the
  // `unknown-channel` test, a sibling that cannot resolve the destination
  // would be told a moderator moved IT, which is false.
  const moved = MOVE_HANDLER.indexOf('"moved-elsewhere"');
  const unknown = MOVE_HANDLER.indexOf('decision.reason === "unknown-channel"');
  assert.ok(moved >= 0, "#handleVoiceMove has no moved-elsewhere arm");
  assert.ok(unknown >= 0, "#handleVoiceMove has no unknown-channel test");
  assert.ok(
    moved < unknown,
    "the moved-elsewhere arm is tested AFTER unknown-channel — a sibling is told it was moved",
  );
  for (const stmt of [
    "this.room()?.removeAllListeners();",
    "this.disconnect();",
  ]) {
    const at = MOVE_HANDLER.indexOf(stmt);
    assert.ok(
      at >= 0 && at < moved,
      `\`${stmt}\` does not run before the moved-elsewhere arm — the sibling's rejoin loop stays armed`,
    );
  }
  const arm = MOVE_HANDLER.slice(moved, unknown);
  assert.ok(
    arm.includes("return;"),
    "the moved-elsewhere arm does not return — it falls through into the destination card",
  );
  assert.ok(
    !arm.includes("this.#setChannel("),
    "the moved-elsewhere arm puts a channel on the card — its Rejoin would re-race the moved seat",
  );
});

test("🔴 the moved-elsewhere arm retires all three marker fields before it returns", () => {
  // Otherwise the marker outlives the arm. A repeat of the event, or the
  // NEXT move of the other connection inside the notice window, would then
  // read the same fresh marker and run this arm again, carding a second
  // "moved on another device" for one move. Worse, a later move that really
  // does name this connection's nonce finds the old marker still standing.
  // Deleting all three clears together keeps the equal-count scan above
  // green, because it only checks that the three fields are written on
  // the same NUMBER of paths. This scan pins the clears to the arm itself.
  //
  // Anchored on the clears and the arm's first `return;`, never on the
  // notice copy or the call that raises it. Those can change without
  // changing what this arm must retire.
  const moved = MOVE_HANDLER.indexOf('decision.reason === "moved-elsewhere"');
  const unknown = MOVE_HANDLER.indexOf('decision.reason === "unknown-channel"');
  assert.ok(
    moved >= 0 && unknown > moved,
    "no moved-elsewhere arm found ahead of the unknown-channel test — the clear scan would read the wrong span",
  );
  const arm = MOVE_HANDLER.slice(moved, unknown);
  const returnAt = arm.indexOf("return;");
  assert.ok(returnAt >= 0, "the moved-elsewhere arm does not return");
  for (const clear of [
    "this.#lastInvoluntaryChannelId = undefined;",
    "this.#lastInvoluntaryLeftAt = undefined;",
    "this.#lastInvoluntaryConnNonce = undefined;",
  ]) {
    const at = arm.indexOf(clear);
    assert.ok(
      at >= 0 && at < returnAt,
      `the moved-elsewhere arm does not run \`${clear}\` before its \`return;\` — the marker survives the arm and a repeat of the event re-triggers it`,
    );
  }
});

/**
 * The balanced `{…}` or `(…)` group that opens at `source[openAt]`, including
 * both delimiters, or `""` if it never closes. Crude on purpose, like
 * `stripComments`: it does not know about strings, so it is only pointed at
 * spans with no brace or paren inside a string literal.
 */
function balancedGroup(source: string, openAt: number): string {
  const open = source[openAt];
  const close = open === "{" ? "}" : open === "(" ? ")" : undefined;
  if (close === undefined) return "";
  let depth = 0;
  for (let i = openAt; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0)
      return source.slice(openAt, i + 1);
  }
  return "";
}

test("🔴 the moved-elsewhere notice is a SNACKBAR, and `onErr` is only the fallback", () => {
  // This device may be an idle desktop that handed its call off to a phone
  // on purpose. An `error2` modal would sit on its screen until the user
  // came back and treat a deliberate handoff as a failure. The modal is only
  // for a `Voice` built with no snackbar controller, so the move is still
  // said out loud there. Swapping the two branches, or replacing the
  // snackbar call with `onErr`, is a few tokens, passes tsc and every other
  // test here, and puts the modal back on every seat.
  //
  // Sliced the same way as the clear scan above. Anchored on the branch, the
  // call and `message: notice`, never on the notice copy.
  const moved = MOVE_HANDLER.indexOf('decision.reason === "moved-elsewhere"');
  const unknown = MOVE_HANDLER.indexOf('decision.reason === "unknown-channel"');
  assert.ok(
    moved >= 0 && unknown > moved,
    "no moved-elsewhere arm found ahead of the unknown-channel test — the snackbar scan would read the wrong span",
  );
  const arm = MOVE_HANDLER.slice(moved, unknown);
  const returnAt = arm.indexOf("return;");
  assert.ok(returnAt >= 0, "the moved-elsewhere arm does not return");

  const branch = /if \(this\.#snackbar\) \{/.exec(arm);
  assert.ok(
    branch && branch.index < returnAt,
    "the moved-elsewhere arm has no `if (this.#snackbar) {` branch before its `return;` — the notice has no snackbar path",
  );
  const thenAt = branch.index + branch[0].length - 1;
  const thenBlock = balancedGroup(arm, thenAt);
  assert.ok(
    thenBlock.length > 0,
    "the `if (this.#snackbar)` block never closes — the scan below would read nothing",
  );
  const afterThen = arm.slice(thenAt + thenBlock.length);
  const elseMatch = /^\s*else\s*\{/.exec(afterThen);
  assert.ok(
    elseMatch,
    "the `if (this.#snackbar)` branch has no `else { … }` — with no controller the notice is never shown",
  );
  const elseBlock = balancedGroup(afterThen, elseMatch[0].length - 1);
  assert.ok(elseBlock.length > 0, "the `else` block never closes");

  // The snackbar call, inside the branch that proved the controller exists.
  const showAt = thenBlock.indexOf("this.#snackbar.show(");
  assert.ok(
    showAt >= 0,
    "`this.#snackbar.show(` is not inside the `if (this.#snackbar)` block — a seat with a snackbar no longer gets one",
  );
  const showCall = balancedGroup(
    thenBlock,
    showAt + "this.#snackbar.show".length,
  );
  assert.match(
    showCall,
    /\bmessage:\s*notice\b/,
    `the snackbar is not shown with \`message: notice\` — saw \`${showCall}\``,
  );

  // `onErr` only in the fallback, and only after the snackbar call.
  const onErrs = arm.split("this.onErr(").length - 1;
  const onErrsInElse = elseBlock.split("this.onErr(").length - 1;
  assert.ok(
    onErrsInElse >= 1,
    "the `else` fallback does not call `this.onErr(` — with no controller the move is said to nobody",
  );
  assert.equal(
    onErrs,
    onErrsInElse,
    `the moved-elsewhere arm calls \`this.onErr(\` ${onErrs} times but only ${onErrsInElse} of them are in the \`else\` of \`if (this.#snackbar)\` — a seat WITH a snackbar gets the modal`,
  );
  assert.ok(
    arm.indexOf("this.onErr(") > thenAt + showAt,
    "`this.onErr(` appears ahead of the snackbar call in the moved-elsewhere arm",
  );
});

/**
 * The `Voice` class, from its declaration to the first column-0 `}` after
 * it. Members are indented, so that line is the class's own closing brace.
 */
const VOICE_CLASS = (() => {
  const at = STATE_CODE.search(/^(export )?class Voice\b/m);
  if (at < 0) return "";
  const end = STATE_CODE.slice(at).search(/^\}$/m);
  return end < 0 ? "" : STATE_CODE.slice(at, at + end + 1);
})();

test("🔴 Voice.setSnackbar is what assigns #snackbar", () => {
  // The only way the controller gets in. Without this writer `#snackbar` is
  // `undefined` for the life of the instance, and the arm above falls back
  // to the modal on every seat while every scan of the arm stays green.
  // `Voice` must be found AND must hold the move handler, or the slice
  // drifted and the scan below would read the wrong span.
  assert.ok(
    VOICE_CLASS.includes("#handleVoiceMove(move:"),
    "no `class Voice` body holding #handleVoiceMove found in state.tsx — the setSnackbar scan would read the wrong span",
  );
  const setter = /^ {2}setSnackbar\((\w+)[^)]*\)\s*\{/m.exec(VOICE_CLASS);
  assert.ok(setter, "Voice has no `setSnackbar(` method");
  const body = balancedGroup(VOICE_CLASS, setter.index + setter[0].length - 1);
  assert.ok(
    body.includes(`this.#snackbar = ${setter[1]};`),
    `Voice.setSnackbar does not assign its argument to \`this.#snackbar\` — saw \`${body}\``,
  );
  // And it is the only writer, so nothing else can swap the controller out.
  assert.equal(
    (STATE_CODE.match(/this\.#snackbar =(?!=)/g) ?? []).length,
    1,
    "`this.#snackbar` is written somewhere other than Voice.setSnackbar",
  );
});

const INDEX_URL = new URL("../../src/index.tsx", import.meta.url);

test("🔴 VoiceContext hands Voice the SAME snackbar controller SnackbarProvider renders", () => {
  // The test above proves the setter assigns; this proves anything calls it,
  // with the controller that is actually on screen. tsc covers part of it now
  // that the prop and the setter parameter are both required: dropping the
  // prop at the mount site, or `setSnackbar(undefined)`, no longer compiles.
  // It does NOT cover deleting the render effect (the prop just goes unread),
  // or `snackbar={new SnackbarController()}` in `src/index.tsx`: a second
  // controller that no `SnackbarProvider` renders, so every notice is queued
  // into nothing and the modal fallback never fires either. Both are silent,
  // so both are pinned here.
  const at = STATE_CODE.search(/^export function VoiceContext\(/m);
  assert.ok(at >= 0, "no `export function VoiceContext(` found in state.tsx");
  const paramsAt = at + "export function VoiceContext".length;
  const params = balancedGroup(STATE_CODE, paramsAt);
  assert.ok(params.length > 0, "VoiceContext's parameter list never closes");
  const afterParams = STATE_CODE.slice(paramsAt + params.length);
  const bodyOpen = /^\s*\{/.exec(afterParams);
  assert.ok(bodyOpen, "VoiceContext's body does not follow its parameters");
  const body = balancedGroup(afterParams, bodyOpen[0].length - 1);
  assert.ok(
    body.includes("new Voice("),
    "the VoiceContext body found does not construct a Voice — the scan below would read the wrong span",
  );
  const effect = "createRenderEffect(() => voice.setSnackbar(props.snackbar));";
  assert.equal(
    body.split(effect).length - 1,
    1,
    `expected \`${effect}\` exactly once in VoiceContext — without it #snackbar stays undefined and every notice is a modal`,
  );
  assert.equal(
    (STATE_CODE.match(/\.setSnackbar\(/g) ?? []).length,
    1,
    "state.tsx calls `.setSnackbar(` somewhere other than VoiceContext's render effect",
  );

  // The mount site. Read here rather than at module scope, so a missing file
  // fails this test alone. Comments stripped, so a commented-out line cannot
  // satisfy it.
  const index = stripComments(readFileSync(INDEX_URL, "utf8"));
  assert.equal(
    index.split("new SnackbarController(").length - 1,
    1,
    "src/index.tsx must construct exactly one SnackbarController — a second one handed to VoiceContext is a queue nobody renders",
  );
  for (const site of [
    "const snackbarController = new SnackbarController();",
    "<VoiceContext snackbar={snackbarController}>",
    "<SnackbarProvider controller={snackbarController}>",
  ])
    assert.ok(
      index.includes(site),
      `src/index.tsx no longer contains \`${site}\` — VoiceContext and SnackbarProvider may not share one controller`,
    );
});

test("🔴 SnackbarController is imported TYPE-ONLY, so state.tsx takes no runtime edge to the Snackbar module", () => {
  // A value import of the Snackbar module from here is a runtime import
  // edge, and state.tsx sits under half the UI package already. A cycle
  // through it breaks the page with a module-scope TDZ error that tsc, the
  // suite and `vite build` all pass. `import type` is erased and cannot. An
  // inline `import { type X }` is NOT the same under `verbatimModuleSyntax`,
  // which keeps the empty import as a side-effect import, so only the
  // statement-level `import type` form passes.
  const imports = [
    ...STATE_CODE.matchAll(
      /^import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)";/gm,
    ),
  ];
  const snackbarModule = imports.filter((m) => /\/Snackbar$/.test(m[3]));
  assert.ok(
    snackbarModule.length > 0,
    "state.tsx imports nothing from the Snackbar module — the type scan would pass vacuously",
  );
  for (const m of snackbarModule)
    assert.ok(
      m[1] !== undefined,
      `state.tsx has a VALUE import from ${m[3]}: \`${m[0]}\` — use \`import type\``,
    );
  const named = imports.filter((m) => /\bSnackbarController\b/.test(m[2]));
  assert.equal(
    named.length,
    1,
    `expected exactly one import of SnackbarController, saw ${named.length}`,
  );
  assert.match(
    named[0][0],
    /^import\s+type\s*\{\s*SnackbarController\s*\}/,
    `SnackbarController is not imported with \`import type { SnackbarController }\` — saw \`${named[0][0]}\``,
  );
});

test("🔴 state.tsx is SUBSCRIBED to the move event, exactly once, with its remover", () => {
  // Everything above this line decides what to do with an event nobody is
  // listening for unless this one statement exists. Deleting the
  // `client.addListener(…)` is a ONE-TOKEN revert that takes the whole
  // feature dead — a moved member lands in no call at all, which is the
  // shipped bug this slice exists to repair — and it was measured to leave
  // the entire suite green and `tsc` clean, because the handler stays "used"
  // by the `onCleanup` remover below it. So the subscription is pinned here,
  // where nothing else can see it.
  //
  // And it was not hypothetical. The AFK side subscribed to
  // `"userMoveVoiceChannel"`, a name stoat.js no longer emits: the emitter's
  // catch-all `string` overload compiled it, every scan here (then pinned to
  // that literal) was green, and the handler was dead (FE1-1). So the name
  // goes through the `VOICE_MOVE_REQUESTED` constant, which `satisfies keyof
  // Events` checks at compile time, and the test after this one checks it
  // against what stoat.js really emits.
  const subscribes =
    STATE_CODE.match(
      /client\.addListener\(\s*VOICE_MOVE_REQUESTED,\s*handler\s*\)/g,
    ) ?? [];
  assert.equal(
    subscribes.length,
    1,
    `expected exactly 1 \`client.addListener(VOICE_MOVE_REQUESTED, handler)\`, saw ${subscribes.length} — at 0 the move handler is dead code and a moved member lands nowhere; above 1 the move is handled twice and two connects race`,
  );
  // Any other subscription to the same event is the same double-handling,
  // whatever it is called.
  const anySubscribe =
    STATE_CODE.match(/\.(?:addListener|on|once)\(\s*VOICE_MOVE_REQUESTED\b/g) ??
    [];
  assert.equal(
    anySubscribe.length,
    1,
    `expected exactly 1 subscription to VOICE_MOVE_REQUESTED in state.tsx, saw ${anySubscribe.length}`,
  );
  // Paired with its remover, inside `onCleanup`. An app-lifetime listener
  // that survives a client swap re-fires the handler on a client this state
  // no longer belongs to.
  const unsubscribes =
    STATE_CODE.match(
      /client\.removeListener\(\s*VOICE_MOVE_REQUESTED,\s*handler\s*\)/g,
    ) ?? [];
  assert.equal(
    unsubscribes.length,
    1,
    `expected exactly 1 \`client.removeListener(VOICE_MOVE_REQUESTED, handler)\`, saw ${unsubscribes.length}`,
  );
  assert.ok(
    /onCleanup\([\s\S]{0,120}?client\.removeListener\(\s*VOICE_MOVE_REQUESTED,\s*handler\s*\)/.test(
      STATE_CODE,
    ),
    "the VOICE_MOVE_REQUESTED remover is no longer inside an onCleanup — the listener outlives the effect that bound it",
  );
  // The subscribed `handler` is the one that reaches `#handleVoiceMove`, typed
  // with the SDK's payload, and nothing else calls the handler.
  const subscribeAt = STATE_CODE.search(
    /client\.addListener\(\s*VOICE_MOVE_REQUESTED,\s*handler\s*\)/,
  );
  const binding = STATE_CODE.slice(0, subscribeAt).lastIndexOf(
    "const handler =",
  );
  assert.ok(
    binding >= 0 &&
      STATE_CODE.slice(binding, subscribeAt).replace(/\s+/g, " ").trim() ===
        "const handler = (move: VoiceMoveRequest) => void this.#handleVoiceMove(move);",
    `the subscribed \`handler\` is not \`(move: VoiceMoveRequest) => void this.#handleVoiceMove(move)\` declared right above the subscription — saw \`${STATE_CODE.slice(Math.max(binding, 0), subscribeAt).trim()}\``,
  );
  assert.equal(
    (STATE_CODE.match(/this\.#handleVoiceMove\(/g) ?? []).length,
    1,
    "#handleVoiceMove is called from somewhere other than the VOICE_MOVE_REQUESTED listener",
  );
  // The retired name is gone from the store's CODE, in any quoting. Comments
  // are excluded on purpose: they may name it to explain what went wrong,
  // and the backend's wire event `UserMoveVoiceChannel` keeps its own name.
  // (`stripComments` only drops whole-line and block comments, so the retired
  // name in a trailing `//` comment still fails here; that is conservative.)
  assert.doesNotMatch(
    STATE_CODE,
    /(["'`])userMoveVoiceChannel\1/,
    'state.tsx code carries a "userMoveVoiceChannel" literal — stoat.js no longer emits that event, so anything keyed on it is dead (FE1-1)',
  );
});

test("🔴 VOICE_MOVE_REQUESTED names the event stoat.js actually emits for UserMoveVoiceChannel", () => {
  // `satisfies keyof Events` proves the name is SOME declared event, not that
  // it is the one the move arrives as. A rename on one side only (the SDK's
  // emit, or this constant to another declared event) compiles on both sides
  // and leaves the listener deaf. So the two literals are compared here.
  //
  // Read lazily and failing loudly, like the stoat.js section below: stoat.js
  // is a submodule, and an unread SDK is an unchecked contract, not a pass.
  const declarations = [
    ...STATE_CODE.matchAll(
      /^const VOICE_MOVE_REQUESTED = "([^"]+)" satisfies keyof Events;$/gm,
    ),
  ];
  assert.equal(
    declarations.length,
    1,
    `expected exactly 1 \`const VOICE_MOVE_REQUESTED = "…" satisfies keyof Events;\` in state.tsx, saw ${declarations.length}`,
  );
  assert.equal(
    (STATE_CODE.match(/\bVOICE_MOVE_REQUESTED\s*=/g) ?? []).length,
    1,
    "VOICE_MOVE_REQUESTED is declared or assigned more than once in state.tsx",
  );
  const v1Url = new URL("../../../stoat.js/src/events/v1.ts", import.meta.url);
  let v1: string;
  try {
    v1 = stripComments(readFileSync(v1Url, "utf8"));
  } catch (error) {
    throw new Error(
      `stoat.js submodule not checked out: cannot read ${v1Url.pathname} (${(error as Error).message}). Run \`git submodule update --init packages/stoat.js\`; this contract is unchecked until then.`,
    );
  }
  const moveCase =
    /case "UserMoveVoiceChannel": \{[\s\S]*?\bbreak;/.exec(v1)?.[0] ?? "";
  const emitted = [
    ...moveCase.matchAll(
      /client\.emit\(\s*"([^"]+)" satisfies keyof Events\s*,/g,
    ),
  ].map((m) => m[1]);
  assert.equal(
    emitted.length,
    1,
    `expected stoat.js's UserMoveVoiceChannel case to emit exactly once through \`client.emit("…" satisfies keyof Events, …)\`, saw ${JSON.stringify(emitted)}`,
  );
  assert.equal(
    declarations[0][1],
    emitted[0],
    `state.tsx listens for "${declarations[0][1]}" but stoat.js emits the move as "${emitted[0]}" — the move handler is dead`,
  );
});

test("🔴 connect() forwards its `opts` to #connectAttempt", () => {
  // The other one-token revert, and the quieter of the two. `opts` is an
  // OPTIONAL third parameter, so dropping it at the call site — `(channel,
  // auth)` — is accepted by tsc without a murmur and leaves every test here
  // green. What it silently deletes is the move's pre-connect budget: the
  // 45 s MLS deadline (`MLS_REQUEST_DEADLINE_MS`) goes back in front of a
  // 10 s token, so the token is dead before `room.connect()` is reached; and
  // `isMove` goes false, so the entrance chime plays at a user who did not
  // choose to join anything. Both were measured green on this tree.
  //
  // The fourth argument is the latched refusal the move token stepped past
  // (S1 / F4). It is optional too, so dropping it is just as silent: M3 then
  // never re-reads the latch when it drops that token, and a dropped-token
  // move dials `join_call` into a channel the server has refused instead of
  // answering from the latch.
  const forwards =
    STATE_CODE.match(
      /this\.#connectAttempt\(\s*channel,\s*auth,\s*opts,\s*latchedReason,?\s*\)/g,
    ) ?? [];
  assert.equal(
    forwards.length,
    1,
    `expected connect() to call this.#connectAttempt(channel, auth, opts, latchedReason), saw ${forwards.length} such calls — without \`opts\` the move's pre-connect budget is silently dropped and the 10 s token dies behind the 45 s MLS deadline; without \`latchedReason\` M3 cannot fall back on the latch (F4)`,
  );
  assert.equal(
    (STATE_CODE.match(/this\.#connectAttempt\(/g) ?? []).length,
    1,
    "#connectAttempt is called from somewhere other than connect() — that call skips the refusal latch and the marker clears connect() runs first",
  );
});

// --- Textual contract against stoat.js --------------------------------------
//
// The event's token, URL, nonce and device reach `#handleVoiceMove` through
// stoat.js's re-emit of `UserMoveVoiceChannel` as `voiceMoveRequested`, and
// stoat.js has no tests of its own. `connNonce: undefined` there passes tsc
// and every test above, because every test in this file builds the world by
// hand and the MOVE_WORLD scan only sees `move.connNonce`, whatever it holds.
// Nothing fails, and the gate goes inactive on every seat. A missing nonce is,
// by design, the old ladder, so the P-1 hole reopens with no signal anywhere.
// The same holds for every other field: `token: undefined` silently turns
// every move into the tokenless join, `url: undefined` does the same, and a
// `deviceId` that is not the wire's blanks or forges step 1. So all seven
// mappings are pinned here, exactly and once each, where the submodule is
// read (FE1-3).
//
// 🔴 The read is LAZY, and only the tests below call it. stoat.js is a git
// submodule, and in a tree where it was never checked out the file is simply
// not there. Read at module scope, that one missing file failed the whole
// spec as a single file-level error and hid every test above, none of which
// reads stoat.js. Now exactly these tests FAIL, with a message that names the
// cause, and the rest still run. It is a failure and never a skip: an unread
// stoat.js is an unchecked contract, not a passing one.
const STOAT_EVENTS_URL = new URL(
  "../../../stoat.js/src/events/v1.ts",
  import.meta.url,
);
let stoatEventsCodeMemo: string | undefined;

/** stoat.js's v1 event handler, comments stripped; throws if it is absent. */
function stoatEventsCode(): string {
  if (stoatEventsCodeMemo === undefined) {
    let source: string;
    try {
      source = readFileSync(STOAT_EVENTS_URL, "utf8");
    } catch (error) {
      throw new Error(
        `stoat.js submodule not checked out: cannot read ${STOAT_EVENTS_URL.pathname} (${(error as Error).message}). Run \`git submodule update --init packages/stoat.js\`; this contract is unchecked until then.`,
      );
    }
    stoatEventsCodeMemo = stripComments(source);
  }
  return stoatEventsCodeMemo;
}

/** The `UserMoveVoiceChannel` case of stoat.js's v1 handler, or `""`. */
function stoatMoveCase(): string {
  return (
    /case "UserMoveVoiceChannel": \{[\s\S]*?\bbreak;/.exec(
      stoatEventsCode(),
    )?.[0] ?? ""
  );
}

/**
 * The exact emit statement the case must open with. `satisfies keyof Events`
 * is part of it on purpose: `emit` has a catch-all `string` overload, so a
 * stale or misspelled event name compiles and leaves every listener deaf.
 */
const STOAT_MOVE_EMIT =
  'client.emit("voiceMoveRequested" satisfies keyof Events, {';

/** Every `key: value,` line of the object the case emits, in order. */
function stoatMoveEmitted(moveCase: string) {
  return [
    ...(
      /client\.emit\("voiceMoveRequested" satisfies keyof Events, \{([\s\S]*?)\n\s*\}\);/.exec(
        moveCase,
      )?.[1] ?? ""
    ).matchAll(/^\s*(\w+):\s*(.+?),\s*$/gm),
  ].map((m) => [m[1], m[2].trim()] as const);
}

/**
 * The seven mappings, right-hand sides EXACT. `|| undefined` on every
 * optional field so consumers have one absent value to test: an absent key,
 * an explicit null and an empty string all arrive as `undefined`.
 */
const STOAT_MOVE_MAPPING: readonly (readonly [string, string, string])[] = [
  ["node", "event.node", "the node NAME, kept for wire parity"],
  [
    "url",
    "event.url || undefined",
    "without it every move takes the tokenless join",
  ],
  [
    "deviceId",
    "event.device_id || undefined",
    "anything else blanks or forges the step-1 device test on every seat",
  ],
  [
    "connNonce",
    "event.conn_nonce || undefined",
    "anything else blanks or forges the nonce gate on every seat",
  ],
  ["from", "event.from", "the source the whole ladder addresses against"],
  ["to", "event.to", "the destination every arm names"],
  [
    "token",
    "event.token || undefined",
    "without it every move takes the tokenless join, and a forged value is redeemed",
  ],
];

test("🔴 FE1-3 — stoat.js re-emits the move as voiceMoveRequested with all seven fields mapped exactly, once each", () => {
  const STOAT_EVENTS_CODE = stoatEventsCode();
  const STOAT_MOVE_CASE = stoatMoveCase();
  const STOAT_MOVE_EMITTED = stoatMoveEmitted(STOAT_MOVE_CASE);
  // Non-vacuous first: an empty case or object would pass every scan below.
  assert.equal(
    (STOAT_EVENTS_CODE.match(/case "UserMoveVoiceChannel":/g) ?? []).length,
    1,
    "expected exactly one UserMoveVoiceChannel case in stoat.js's v1 handler",
  );
  assert.equal(
    STOAT_MOVE_CASE.split(STOAT_MOVE_EMIT).length - 1,
    1,
    `stoat.js's UserMoveVoiceChannel case does not emit exactly once through \`${STOAT_MOVE_EMIT}\` — every scan below would pass vacuously`,
  );
  // The pre-merge name is gone from the case: an emit under the old name
  // would feed the dead listener's shape (FE1-1) and not the merged handler.
  assert.equal(
    STOAT_MOVE_CASE.includes('"userMoveVoiceChannel"'),
    false,
    'stoat.js\'s UserMoveVoiceChannel case still mentions "userMoveVoiceChannel"',
  );
  assert.ok(
    STOAT_MOVE_EMITTED.length > 0,
    "no `key: value,` lines found in the emitted voiceMoveRequested object",
  );
  // Each key exactly once, with exactly its right-hand side. In an object
  // literal a later duplicate WINS, so a second `connNonce: undefined,` below
  // a correct one would blank it.
  for (const [key, value, why] of STOAT_MOVE_MAPPING) {
    const values = STOAT_MOVE_EMITTED.filter(([k]) => k === key).map(
      ([, v]) => v,
    );
    assert.equal(
      values.length,
      1,
      `expected exactly one \`${key}:\` in the emitted voiceMoveRequested object, saw ${JSON.stringify(values)}`,
    );
    assert.equal(
      values[0],
      value,
      `\`${key}\` must be exactly \`${value}\` (${why}); saw \`${key}: ${values[0]}\``,
    );
  }
  // And nothing else: an eighth key is a field no consumer was reviewed for.
  assert.deepEqual(
    STOAT_MOVE_EMITTED.map(([k]) => k).sort(),
    STOAT_MOVE_MAPPING.map(([k]) => k).sort(),
    `the emitted voiceMoveRequested object has keys ${JSON.stringify(STOAT_MOVE_EMITTED.map(([k]) => k))}`,
  );
});

test("🔴 stoat.js's wire type for UserMoveVoiceChannel declares its four optional fields optional", () => {
  // The other half of the map. Without the declarations the handler cannot
  // read `event.conn_nonce` (or the rest) at all, and the natural fix for the
  // resulting tsc error is to delete the read. `token` and `url` are optional
  // on the merged backend, which leaves them out whenever it has nothing to
  // send; declaring either required would teach the client to trust a value
  // that is often absent.
  const member =
    /type: "UserMoveVoiceChannel";([\s\S]*?)\n\s*\}/.exec(
      stoatEventsCode(),
    )?.[1] ?? "";
  const declares = (line: string) =>
    new RegExp(`^\\s*${line.replace("?", "\\?")}\\s*$`, "m").test(member);
  for (const required of ["node: string;", "from: string;", "to: string;"])
    assert.ok(
      declares(required),
      `no \`${required}\` in stoat.js's UserMoveVoiceChannel wire type — the declaration scan would pass vacuously`,
    );
  for (const optional of [
    "token?: string;",
    "url?: string;",
    "device_id?: string;",
    "conn_nonce?: string;",
  ])
    assert.ok(
      declares(optional),
      `stoat.js's UserMoveVoiceChannel wire type no longer declares \`${optional}\``,
    );
});
