/**
 * Run with:
 *
 *     node --conditions=browser --test components/rtc/overlay/protocol.test.ts
 *
 * The `--conditions=browser` flag is NOT optional in this repo's Solid tests:
 * without it Node resolves solid-js's SERVER build, whose `createEffect` is a
 * deliberate no-op, and effect-based assertions fail against correct code with
 * an ordinary-looking value diff. This particular suite is pure functions and
 * would pass either way — the flag is here so one invocation covers this file
 * and the reactive ones together, and so nobody "fixes" the product after
 * running it the other way.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  type OverlayDeviceState,
  type OverlayRosterEntry,
  collapseParticipants,
  overlayInCall,
  parseOverlayMsg,
} from "./protocol.ts";

/** The real stripper's rule: identities are `{user_id}:{device_id}`. */
const strip = (identity: string) => identity.split(":")[0];

const roster = (...ids: string[]): OverlayRosterEntry[] =>
  ids.map((id) => ({ userId: id, name: `user-${id}`, self: false }));

const device = (
  identity: string,
  speaking: boolean,
  muted: boolean,
): OverlayDeviceState => ({ identity, speaking, muted });

describe("collapseParticipants", () => {
  it("strips the device suffix so a device-qualified identity matches", () => {
    const result = collapseParticipants(
      roster("alice"),
      [device("alice:desktop-1", true, false)],
      strip,
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].id, "alice");
    assert.equal(result[0].speaking, true);
  });

  it("is idempotent for bare (non-E2EE) identities", () => {
    const result = collapseParticipants(
      roster("alice"),
      [device("alice", true, false)],
      strip,
    );

    assert.equal(result[0].id, "alice");
    assert.equal(result[0].speaking, true);
  });

  it("collapses a multi-device user to ONE entry", () => {
    const result = collapseParticipants(
      roster("alice"),
      [device("alice:laptop", false, true), device("alice:phone", false, true)],
      strip,
    );

    assert.equal(result.length, 1);
  });

  it("ORs speaking across devices", () => {
    const result = collapseParticipants(
      roster("alice"),
      [device("alice:laptop", false, true), device("alice:phone", true, false)],
      strip,
    );

    assert.equal(result[0].speaking, true);
  });

  it("ANDs muted across devices — the talking phone wins over the muted laptop", () => {
    // The case the operator choice exists for: a muted idle laptop plus an
    // actively-talking phone must NOT render a mic_off badge next to a
    // pulsing speaking ring.
    const result = collapseParticipants(
      roster("alice"),
      [device("alice:laptop", false, true), device("alice:phone", true, false)],
      strip,
    );

    assert.equal(result[0].muted, false);
    assert.equal(result[0].speaking, true);
  });

  it("reports muted only when EVERY device is muted", () => {
    const result = collapseParticipants(
      roster("alice"),
      [device("alice:laptop", false, true), device("alice:phone", false, true)],
      strip,
    );

    assert.equal(result[0].muted, true);
  });

  it("keeps a roster user with no live device, reported silent", () => {
    // Joined the channel, media not up yet. Showing them silent is right;
    // dropping someone who is in the channel is not.
    const result = collapseParticipants(roster("alice", "bob"), [], strip);

    assert.deepEqual(
      result.map((p) => p.id),
      ["alice", "bob"],
    );
    assert.equal(result[0].speaking, false);
    assert.equal(result[0].muted, false);
  });

  it("ignores LiveKit participants who are not on the roster", () => {
    const result = collapseParticipants(
      roster("alice"),
      [device("alice:d1", false, false), device("ghost:d1", true, false)],
      strip,
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].id, "alice");
  });

  it("preserves roster order", () => {
    const result = collapseParticipants(
      roster("c", "a", "b"),
      [device("a:d", true, false)],
      strip,
    );

    assert.deepEqual(
      result.map((p) => p.id),
      ["c", "a", "b"],
    );
  });

  it("never lets a raw device-qualified id cross the wire", () => {
    const result = collapseParticipants(
      roster("alice"),
      [device("alice:desktop-1", true, false)],
      strip,
    );

    assert.ok(!result.some((p) => p.id.includes(":")));
  });
});

describe("overlayInCall", () => {
  const room = {};

  it("is true for a live call", () => {
    assert.equal(overlayInCall(room, "CONNECTED"), true);
  });

  it("is FALSE on the LiveKit drop path, where room() is still set", () => {
    // The audit's blocker finding: `room.addListener("disconnected")` only
    // sets the state — it does not clear the room. Watching room() alone
    // leaves the overlay floating over the game after a Wi-Fi drop.
    assert.equal(overlayInCall(room, "DISCONNECTED"), false);
  });

  it("is false after a manual hangup, which clears room() and returns to READY", () => {
    assert.equal(overlayInCall(undefined, "READY"), false);
  });

  it("is false when idle and never joined", () => {
    assert.equal(overlayInCall(undefined, "READY"), false);
  });

  it("stays true while connecting, so the window is up before the first frame", () => {
    assert.equal(overlayInCall(room, "CONNECTING"), true);
  });

  it("stays true while RECONNECTING even though the room is gone", () => {
    // The auto-rejoin loop re-enters through connect(), whose leading
    // disconnect() clears room(). Gating on the room here would shut the
    // overlay window and reopen it on every retry, over the user's game.
    assert.equal(overlayInCall(undefined, "RECONNECTING"), true);
  });

  it("stays true while RECONNECTING with a room still attached", () => {
    // The first tick after the drop, before the loop's teardown runs.
    assert.equal(overlayInCall(room, "RECONNECTING"), true);
  });

  it("goes false once the rejoin loop gives up into DISCONNECTED", () => {
    // What bounds the reconnecting window: MAX_REJOIN_ATTEMPTS exhausted
    // leaves the channel asserted but the state DISCONNECTED, and the worker
    // sends `bye` off this edge.
    assert.equal(overlayInCall(undefined, "DISCONNECTED"), false);
  });
});

describe("parseOverlayMsg", () => {
  const config = {
    opacity: 0.85,
    scale: 1,
    displayMode: "avatars-names" as const,
    showLatency: false,
    corner: "top-left" as const,
  };

  it("accepts a well-formed state message", () => {
    const msg = parseOverlayMsg({
      v: 1,
      type: "state",
      seq: 3,
      participants: [],
      config,
    });

    assert.equal(msg?.type, "state");
  });

  it("accepts hello and bye", () => {
    assert.equal(parseOverlayMsg({ v: 1, type: "hello" })?.type, "hello");
    assert.equal(parseOverlayMsg({ v: 1, type: "bye" })?.type, "bye");
  });

  it("ignores an unknown version (forward compat, never throws)", () => {
    assert.equal(
      parseOverlayMsg({
        v: 2,
        type: "state",
        seq: 1,
        participants: [],
        config,
      }),
      undefined,
    );
  });

  it("ignores an unknown type", () => {
    assert.equal(parseOverlayMsg({ v: 1, type: "something-new" }), undefined);
  });

  it("ignores structurally broken state messages", () => {
    assert.equal(parseOverlayMsg({ v: 1, type: "state" }), undefined);
    assert.equal(
      parseOverlayMsg({ v: 1, type: "state", seq: 1, participants: [] }),
      undefined,
    );
    assert.equal(
      parseOverlayMsg({
        v: 1,
        type: "state",
        seq: "1",
        participants: [],
        config,
      }),
      undefined,
    );
  });

  it("ignores non-objects without throwing", () => {
    assert.equal(parseOverlayMsg(undefined), undefined);
    assert.equal(parseOverlayMsg(null), undefined);
    assert.equal(parseOverlayMsg("state"), undefined);
    assert.equal(parseOverlayMsg(7), undefined);
  });
});
