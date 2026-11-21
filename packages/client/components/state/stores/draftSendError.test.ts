/**
 * Run with:
 *
 *     node --conditions=browser --test components/state/stores/draftSendError.test.ts
 *
 * Covers the reason stored on a failed outbox entry. A send refused with
 * `DirectMessagesPaused` used to show "The server rejected the message
 * (DirectMessagesPaused)", untranslated and meaningless to the sender; it now
 * stores `DM_PAUSED_SEND_ERROR`, which `DraftMessage` swaps for translated
 * copy. Every other reason must stay exactly as it was.
 *
 * Known-bad control: point `DRAFT_SEND_ERROR_UNDER_TEST` at a module holding
 * the pre-fix `describeSendError` (from `Draft.ts` at 6f8404db, exported, plus
 * the marker constant) and the two "DirectMessagesPaused" specs fail.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const override = process.env.DRAFT_SEND_ERROR_UNDER_TEST;
const {
  DM_PAUSED_SEND_ERROR,
  FIRST_FILE_NEEDS_TEXT_SEND_ERROR,
  PEER_CHANGED_SIDE,
  canRetrySendAsIs,
  describeSendError,
  encryptionRequiredSendError,
  sendRefusalSide,
} = (await import(
  override
    ? pathToFileURL(resolve(override)).href
    : new URL("./draftSendError.ts", import.meta.url).href
)) as typeof import("./draftSendError.ts");

/** Same shape as the error stoat.js throws when the app's guard refuses */
class EncryptedOnlyBlockedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "EncryptedOnlyBlockedError";
    this.reason = reason;
  }
}

describe("describeSendError", () => {
  it("the marker is the server's error type", () => {
    assert.equal(DM_PAUSED_SEND_ERROR, "DirectMessagesPaused");
  });

  // stoat-api throws the failed response's body TEXT
  it("a DirectMessagesPaused body string maps to the marker", () => {
    assert.equal(
      describeSendError('{"type":"DirectMessagesPaused"}'),
      DM_PAUSED_SEND_ERROR,
    );
  });

  it("a DirectMessagesPaused body object maps to the marker", () => {
    assert.equal(
      describeSendError({ type: "DirectMessagesPaused" }),
      DM_PAUSED_SEND_ERROR,
    );
  });

  it("any other error type keeps the generic reason", () => {
    assert.equal(
      describeSendError(
        JSON.stringify({
          type: "MissingPermission",
          permission: "SendMessage",
        }),
      ),
      "The server rejected the message (MissingPermission)",
    );
    assert.equal(
      describeSendError({ type: "Blocked" }),
      "The server rejected the message (Blocked)",
    );
  });

  it("non-JSON bodies, Errors and empty throws are unchanged", () => {
    assert.equal(
      describeSendError("<html>502 Bad Gateway</html>"),
      "The server returned an error",
    );
    assert.equal(describeSendError(new Error("offline")), "offline");
    assert.equal(describeSendError(undefined), "Unknown error");
  });
});

// A send refused for not being encrypted, by the server (`EncryptionRequired`
// with a `side`) or by the app's guard or the encryption bridge before any
// request (`EncryptedOnlyBlockedError` with a `reason`). The row needs the
// side for its copy. A retry is allowed: it runs every check again, so it
// cannot go out unencrypted where that is refused. Files waiting for a text
// message are the one stored reason that is not retried as is.
//
// Known-bad control: run with `DRAFT_SEND_ERROR_UNDER_TEST` pointing at this
// module as of d9dd3de2 and the first four specs in this block fail; at the
// FW2 send path (before the peer-changed side and the retry rule) the retry,
// peer-changed and first-file specs fail.
describe("encryption-required sends", () => {
  it("the server's body keeps its side, as a string or parsed", () => {
    for (const side of ["sender", "recipient", "group", "member"] as const) {
      const body = { type: "EncryptionRequired", side };
      for (const thrown of [JSON.stringify(body), body]) {
        const stored = describeSendError(thrown);
        assert.equal(stored, `EncryptionRequired:${side}`);
        assert.deepEqual(encryptionRequiredSendError(stored), {
          kind: "encryption-required",
          side,
        });
        assert.equal(sendRefusalSide(thrown), side);
      }
    }
  });

  it("the guard's error keeps its reason and never shows it raw", () => {
    for (const reason of [
      "sender",
      "recipient",
      "group",
      "setup",
      "open-app",
    ] as const) {
      const stored = describeSendError(new EncryptedOnlyBlockedError(reason));
      assert.notEqual(stored, reason);
      assert.deepEqual(encryptionRequiredSendError(stored), {
        kind: "encryption-required",
        side: reason,
      });
    }
  });

  it("a peer that may no longer be Encrypted-only is its own side, never recipient", () => {
    assert.equal(PEER_CHANGED_SIDE, "peer-changed");
    const thrown = new EncryptedOnlyBlockedError("peer-changed");
    assert.equal(sendRefusalSide(thrown), "peer-changed");
    const stored = describeSendError(thrown);
    assert.equal(stored, "EncryptionRequired:peer-changed");
    assert.deepEqual(encryptionRequiredSendError(stored), {
      kind: "encryption-required",
      side: "peer-changed",
    });
    assert.equal(canRetrySendAsIs(stored), true, "retried after a confirm");

    // Only the app raises it: a server body naming it is not trusted as one
    assert.equal(
      sendRefusalSide({ type: "EncryptionRequired", side: "peer-changed" }),
      "sender",
    );
  });

  it("an unknown or missing side is still a refusal", () => {
    for (const thrown of [
      '{"type":"EncryptionRequired"}',
      '{"type":"EncryptionRequired","side":"device"}',
      { type: "EncryptionRequired", side: 7 },
      new EncryptedOnlyBlockedError("something-new"),
    ]) {
      const stored = describeSendError(thrown);
      assert.equal(
        encryptionRequiredSendError(stored)?.kind,
        "encryption-required",
      );
    }
    // A side written by a newer build
    assert.deepEqual(encryptionRequiredSendError("EncryptionRequired:later"), {
      kind: "encryption-required",
      side: "sender",
    });
  });

  it("every refusal for not being encrypted may be retried, and keeps its marker", () => {
    for (const side of [
      "sender",
      "recipient",
      "group",
      "member",
      "setup",
      "open-app",
      "peer-changed",
      "later",
    ]) {
      const stored = `EncryptionRequired:${side}`;
      assert.equal(canRetrySendAsIs(stored), true, stored);
      assert.ok(encryptionRequiredSendError(stored), stored);
    }
  });

  it("files waiting for a text message are not retried as is", () => {
    assert.equal(FIRST_FILE_NEEDS_TEXT_SEND_ERROR, "FirstFileNeedsText");
    assert.equal(canRetrySendAsIs(FIRST_FILE_NEEDS_TEXT_SEND_ERROR), false);
    assert.equal(
      encryptionRequiredSendError(FIRST_FILE_NEEDS_TEXT_SEND_ERROR),
      undefined,
    );
  });

  it("every other stored reason can be retried", () => {
    for (const stored of [
      undefined,
      "",
      "offline",
      DM_PAUSED_SEND_ERROR,
      "Unknown error",
      "The server returned an error",
      "The server rejected the message (MissingPermission)",
      // The old text for this error, from an entry stored before this build
      "The server rejected the message (EncryptionRequired)",
      "EncryptionRequired",
      "recipient",
    ]) {
      assert.equal(encryptionRequiredSendError(stored), undefined);
      assert.equal(canRetrySendAsIs(stored), true);
    }
  });

  it("an Error that only mentions the type is not a refusal", () => {
    assert.equal(
      describeSendError(new Error("EncryptionRequired")),
      "EncryptionRequired",
    );
    const named = new Error("recipient");
    named.name = "E2EESendError";
    assert.equal(describeSendError(named), "recipient");
    assert.equal(
      describeSendError({ type: "EncryptionRequiredish", side: "sender" }),
      "The server rejected the message (EncryptionRequiredish)",
    );
    const reasonless = new Error("peer-changed");
    assert.equal(sendRefusalSide(reasonless), undefined);
  });
});
