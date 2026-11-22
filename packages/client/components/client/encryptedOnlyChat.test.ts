// Unit spec for what the chat page shows under Encrypted-only chats. Run
// with Node's built-in runner from packages/client:
//   node --test --conditions=browser components/client/encryptedOnlyChat.test.ts
// Declared test count: 8 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: the whole-chat panel and the read-only group, over the whole input
// space against an expectation written here as plain facts, not as the
// policy's chain; the "Not encrypted" row label at its edges; a stored
// refusal read back as the same side the error words read; and the outbox
// row's actions.
//
// Point `ENCRYPTED_ONLY_CHAT_UNDER_TEST` at another copy of the module to
// check that instead.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  DM_PAUSED_SEND_ERROR,
  ENCRYPTION_REQUIRED_SEND_ERROR_PREFIX,
  FIRST_FILE_NEEDS_TEXT_SEND_ERROR,
  describeSendError,
  sendRefusalSide,
} from "../state/stores/draftSendError.ts";
import {
  type ChannelKind,
  type DeviceState,
  type PeerFlag,
  type PlainWriteInput,
} from "./encryptedOnlyPolicy.ts";

type Chat = typeof import("./encryptedOnlyChat.ts");

const override = process.env.ENCRYPTED_ONLY_CHAT_UNDER_TEST;
const {
  chatPanelFor,
  draftRowActions,
  notEncryptedRow,
  plainGroupUnderLatch,
  refusalErrorOf,
} = (await import(
  override
    ? pathToFileURL(resolve(override)).href
    : new URL("./encryptedOnlyChat.ts", import.meta.url).href
)) as Chat;

const CHANNELS: ChannelKind[] = ["dm", "group", "saved", "server"];
const PEER_FLAGS: PeerFlag[] = ["on", "off", "absent"];
const DEVICES: DeviceState[] = ["ready", "not-set-up", "web"];
const BOOLS = [false, true];

/** Every input the chat page can see; the advert decides nothing. */
function* inputs(): Generator<PlainWriteInput> {
  for (const latched of BOOLS)
    for (const channel of CHANNELS)
      for (const peerFlag of PEER_FLAGS)
        for (const peerRemembered of BOOLS)
          for (const groupMarked of BOOLS)
            for (const groupRemembered of BOOLS)
              for (const device of DEVICES)
                for (const encrypted of BOOLS)
                  yield {
                    latched,
                    channel,
                    peerFlag,
                    peerRemembered,
                    groupMarked,
                    groupRemembered,
                    device,
                    encrypted,
                    advert: "enforced",
                  };
}

const base: PlainWriteInput = {
  latched: true,
  channel: "dm",
  peerFlag: "absent",
  peerRemembered: false,
  groupMarked: false,
  groupRemembered: false,
  device: "ready",
  encrypted: false,
  advert: "enforced",
};

test("panel: only a latched account, only a DM or group, only where this device cannot encrypt", () => {
  let panels = 0;
  for (const input of inputs()) {
    const conversation = input.channel === "dm" || input.channel === "group";
    const expected =
      input.latched && conversation && input.device === "web"
        ? "open-app"
        : input.latched && conversation && input.device === "not-set-up"
          ? "setup"
          : null;
    assert.equal(chatPanelFor(input, true), expected, JSON.stringify(input));
    if (expected) panels++;

    // Until the status is read an app shows the chat; the website never waits
    assert.equal(
      chatPanelFor(input, false),
      expected === "open-app" ? "open-app" : null,
      JSON.stringify(input),
    );
  }
  // 2 channels x 2 devices x 3 x 2 x 2 x 2 x 2 latched combinations
  assert.equal(panels, 2 * 2 * 3 * 2 * 2 * 2 * 2);
});

test("panel: named cases", () => {
  assert.equal(chatPanelFor({ ...base, device: "web" }, true), "open-app");
  assert.equal(
    chatPanelFor({ ...base, channel: "group", device: "not-set-up" }, true),
    "setup",
  );
  // A send this device would encrypt still gets the panel off a ready device
  assert.equal(
    chatPanelFor({ ...base, device: "not-set-up", encrypted: true }, true),
    "setup",
  );
  assert.equal(chatPanelFor({ ...base, encrypted: true }, true), null);
  assert.equal(
    chatPanelFor({ ...base, channel: "saved", device: "web" }, true),
    null,
  );
  assert.equal(
    chatPanelFor({ ...base, channel: "server", device: "web" }, true),
    null,
  );
  // The other person's setting is the composer's business, not a panel
  assert.equal(
    chatPanelFor(
      { ...base, latched: false, peerFlag: "on", device: "web" },
      true,
    ),
    null,
  );
});

test("read-only group: latched, ready, a group nobody marked and that does not send encrypted", () => {
  let count = 0;
  for (const input of inputs()) {
    const expected =
      input.latched &&
      input.channel === "group" &&
      input.device === "ready" &&
      !input.encrypted &&
      !input.groupMarked &&
      !input.groupRemembered;
    assert.equal(plainGroupUnderLatch(input), expected, JSON.stringify(input));
    if (expected) count++;
  }
  // peer flag x peer remembered are free
  assert.equal(count, 3 * 2);

  const group: PlainWriteInput = { ...base, channel: "group" };
  assert.equal(plainGroupUnderLatch(group), true);
  assert.equal(plainGroupUnderLatch({ ...group, groupMarked: true }), false);
  assert.equal(
    plainGroupUnderLatch({ ...group, groupRemembered: true }),
    false,
  );
  assert.equal(plainGroupUnderLatch({ ...group, encrypted: true }), false);
  assert.equal(plainGroupUnderLatch({ ...group, latched: false }), false);
  assert.equal(plainGroupUnderLatch({ ...group, device: "web" }), false);
  assert.equal(plainGroupUnderLatch(base), false);
});

test("row label: every unencrypted message under the latch, and nothing else", () => {
  let labelled = 0;
  for (const latched of BOOLS)
    for (const conversation of BOOLS)
      for (const encrypted of BOOLS)
        for (const system of BOOLS) {
          const row = { latched, conversation, encrypted, system };
          const expected = latched && conversation && !encrypted && !system;
          assert.equal(notEncryptedRow(row), expected, JSON.stringify(row));
          if (expected) labelled++;
        }
  assert.equal(labelled, 1);

  // No send time is read: a message the server dates before the latch is
  // labelled all the same
  const old = {
    latched: true,
    conversation: true,
    encrypted: false,
    system: false,
    createdAtMs: 0,
    latchedAt: Date.now(),
  };
  assert.equal(notEncryptedRow(old), true);
});

test("refusal: a stored marker reads back as the side the error words read", () => {
  for (const side of [
    "sender",
    "recipient",
    "group",
    "member",
    "setup",
    "open-app",
    "peer-changed",
  ]) {
    const stored = ENCRYPTION_REQUIRED_SEND_ERROR_PREFIX + side;
    const error = refusalErrorOf(stored);
    assert.ok(error, side);
    assert.equal(sendRefusalSide(error), side);
    // The marker the store writes for that error is the one read here
    assert.equal(describeSendError(error), stored);
  }

  // A side from a newer build still reads as a refusal
  assert.equal(
    sendRefusalSide(
      refusalErrorOf(ENCRYPTION_REQUIRED_SEND_ERROR_PREFIX + "future"),
    ),
    "sender",
  );
});

test("refusal: anything else is not a refusal", () => {
  for (const stored of [
    undefined,
    "",
    DM_PAUSED_SEND_ERROR,
    FIRST_FILE_NEEDS_TEXT_SEND_ERROR,
    "The server rejected the message (MissingPermission)",
    "EncryptionRequired",
  ]) {
    assert.equal(refusalErrorOf(stored), undefined, String(stored));
  }
});

test("outbox row: files waiting for text are never retried as they are", () => {
  assert.deepEqual(draftRowActions(FIRST_FILE_NEEDS_TEXT_SEND_ERROR), {
    retry: false,
    refused: true,
  });
  assert.deepEqual(
    draftRowActions(ENCRYPTION_REQUIRED_SEND_ERROR_PREFIX + "recipient"),
    { retry: true, refused: true },
  );
  assert.deepEqual(
    draftRowActions(ENCRYPTION_REQUIRED_SEND_ERROR_PREFIX + "peer-changed"),
    { retry: true, refused: true },
  );
});

test("outbox row: other failures keep today's menu", () => {
  for (const stored of [
    undefined,
    DM_PAUSED_SEND_ERROR,
    "Unknown error",
    "The server rejected the message (MissingPermission)",
  ]) {
    assert.deepEqual(
      draftRowActions(stored),
      { retry: true, refused: false },
      String(stored),
    );
  }
});
