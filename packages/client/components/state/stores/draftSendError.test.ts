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
const { DM_PAUSED_SEND_ERROR, describeSendError } = (await import(
  override
    ? pathToFileURL(resolve(override)).href
    : new URL("./draftSendError.ts", import.meta.url).href
)) as typeof import("./draftSendError.ts");

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
