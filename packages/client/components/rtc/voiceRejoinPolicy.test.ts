// Specs for the voice auto-rejoin policy — run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/voiceRejoinPolicy.test.ts
//
// These pin the decisions that stranded a call on "Disconnected" forever on a
// healthy network (observed live 2026-08-22). The subtle one is the deny-list
// DIRECTION: an unrecognised reason must recover, because the reason that
// actually killed that call — STATE_MISMATCH, from LiveKit's connection
// reconcile watchdog rather than from its retry policy — is exactly the kind
// of code an allow-list would have omitted.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DisconnectReason } from "livekit-client";

import {
  MAX_REJOIN_ATTEMPTS,
  NO_REJOIN_DISCONNECT_REASONS,
  REJOIN_DELAYS_MS,
  rejoinDelayMs,
  shouldAutoRejoin,
  totalRejoinWindowMs,
} from "./voiceRejoinPolicy.ts";

const world = (over: Partial<Parameters<typeof shouldAutoRejoin>[0]> = {}) => ({
  state: "CONNECTED",
  reason: DisconnectReason.STATE_MISMATCH as DisconnectReason | undefined,
  ...over,
});

// --- what must recover -----------------------------------------------------

test("STATE_MISMATCH rejoins — the reason that caused the original wedge", () => {
  // The watchdog's terminal path: 3 failed transport probes 4 s apart, then
  // handleDisconnect(STATE_MISMATCH). It never enters the retry policy, so
  // nothing below the app recovers this on its own.
  assert.equal(shouldAutoRejoin(world()), true);
});

test("a missing reason rejoins", () => {
  // The SDK omits a reason on some transport closes. From a call the user was
  // mid-way through, "no reason given" is a dead socket far more often than a
  // deliberate ending.
  assert.equal(shouldAutoRejoin(world({ reason: undefined })), true);
});

test("server-side deaths the user did not ask for rejoin", () => {
  for (const reason of [
    DisconnectReason.SERVER_SHUTDOWN,
    DisconnectReason.SIGNAL_CLOSE,
    DisconnectReason.MIGRATION,
    DisconnectReason.JOIN_FAILURE,
  ])
    assert.equal(shouldAutoRejoin(world({ reason })), true, String(reason));
});

test("an UNKNOWN future reason rejoins — the deny-list points this way on purpose", () => {
  // An allow-list would silently stop recovering the day LiveKit adds a code.
  // 9999 stands in for that future value.
  assert.equal(
    shouldAutoRejoin(world({ reason: 9999 as DisconnectReason })),
    true,
  );
});

// --- what must NOT recover -------------------------------------------------

test("every deliberate ending stays disconnected", () => {
  for (const reason of NO_REJOIN_DISCONNECT_REASONS)
    assert.equal(shouldAutoRejoin(world({ reason })), false, String(reason));
});

test("a hang-up does not rejoin", () => {
  assert.equal(
    shouldAutoRejoin(world({ reason: DisconnectReason.CLIENT_INITIATED })),
    false,
  );
});

test("being kicked does not rejoin", () => {
  // Rejoining a removal would fight a moderator, and land the user back in a
  // room they were just ejected from.
  assert.equal(
    shouldAutoRejoin(world({ reason: DisconnectReason.PARTICIPANT_REMOVED })),
    false,
  );
});

test("a join from another device does not rejoin — it would fight for the identity", () => {
  assert.equal(
    shouldAutoRejoin(world({ reason: DisconnectReason.DUPLICATE_IDENTITY })),
    false,
  );
});

test("a closed or deleted room does not rejoin", () => {
  assert.equal(
    shouldAutoRejoin(world({ reason: DisconnectReason.ROOM_CLOSED })),
    false,
  );
  assert.equal(
    shouldAutoRejoin(world({ reason: DisconnectReason.ROOM_DELETED })),
    false,
  );
});

// --- the CONNECTED gate ----------------------------------------------------

test("a FAILING INITIAL JOIN is never rejoined, whatever the reason", () => {
  // A join that never succeeds also emits `disconnected`. Looping on it would
  // retry a call the user never got into, and swallow the error that
  // connect()'s catch exists to surface.
  for (const state of ["CONNECTING", "READY", "DISCONNECTED", "RECONNECTING"])
    assert.equal(shouldAutoRejoin(world({ state })), false, state);
});

test("only a call the user was actually IN is recovered", () => {
  assert.equal(shouldAutoRejoin(world({ state: "CONNECTED" })), true);
  assert.equal(shouldAutoRejoin(world({ state: "READY" })), false);
});

// --- backoff ---------------------------------------------------------------

test("backoff follows the schedule, then repeats its last value", () => {
  REJOIN_DELAYS_MS.forEach((expected, i) =>
    assert.equal(rejoinDelayMs(i), expected),
  );
  const last = REJOIN_DELAYS_MS[REJOIN_DELAYS_MS.length - 1];
  assert.equal(rejoinDelayMs(REJOIN_DELAYS_MS.length), last);
  assert.equal(rejoinDelayMs(REJOIN_DELAYS_MS.length + 50), last);
});

test("backoff never returns undefined past the end of the table", () => {
  // The loop makes MAX_REJOIN_ATTEMPTS attempts against a shorter schedule, so
  // an unclamped index would hand setTimeout an undefined delay and collapse
  // the backoff to zero — a retry storm rather than a wait.
  for (let attempt = 0; attempt < MAX_REJOIN_ATTEMPTS; attempt++) {
    const delay = rejoinDelayMs(attempt);
    assert.equal(typeof delay, "number");
    assert.ok(delay > 0, `attempt ${attempt} produced ${delay}`);
  }
});

test("backoff is monotonic — no attempt waits less than the one before", () => {
  for (let attempt = 1; attempt < MAX_REJOIN_ATTEMPTS; attempt++)
    assert.ok(
      rejoinDelayMs(attempt) >= rejoinDelayMs(attempt - 1),
      `attempt ${attempt} waits less than ${attempt - 1}`,
    );
});

test("a negative attempt clamps to the first delay rather than the last", () => {
  assert.equal(rejoinDelayMs(-1), REJOIN_DELAYS_MS[0]);
});

// --- the bound -------------------------------------------------------------

test("the loop is bounded, so the card becomes actionable instead of spinning", () => {
  assert.ok(MAX_REJOIN_ATTEMPTS > 0);
  assert.ok(Number.isFinite(MAX_REJOIN_ATTEMPTS));
});

test("the whole window stays inside a couple of minutes", () => {
  // How long a user stares at "Reconnecting" before they get a Rejoin button.
  // A product bound, deliberately assertable: editing the schedule upward
  // should fail here rather than quietly stretching the wait.
  const total = totalRejoinWindowMs();
  assert.equal(total, 1_000 + 2_000 + 4_000 + 8_000 + 15_000 + 30_000 * 3);
  assert.ok(
    total <= 150_000,
    `rejoin window grew to ${total} ms — is that still acceptable to stare at?`,
  );
});
