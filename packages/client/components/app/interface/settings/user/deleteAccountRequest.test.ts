/**
 * Run with:
 *
 *     node --conditions=browser --test components/app/interface/settings/user/deleteAccountRequest.test.ts
 *
 * The account deletion request from Settings (`./deleteAccountRequest.ts`,
 * used by `ManageAccount` in `./Account.tsx`). What goes wrong without each:
 *
 * - the ticketless try comes first, so Google / Apple sign-in accounts (whose
 *   password is unusable) are never sent to a password prompt they can't pass;
 * - only 401 / 403 fall back to the prompt: a 400 (still owns servers), a 429,
 *   a 5xx or a network error would fail again with a ticket, and asking for a
 *   password there reads as "wrong password" and hides the real error;
 * - a cancelled prompt is quiet: no "check your email" notice, which would
 *   sign the user out for a request that was never sent;
 * - the ticketless request keeps the HTTP status (the API client drops it)
 *   and sends no MFA ticket.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DeleteAccountRequestError,
  deleteRequestStatus,
  isOwnedServersRefusal,
  needsTicketFallback,
  postDeleteAccountTicketless,
  requestAccountDeletion,
} from "./deleteAccountRequest.ts";

/** Deps with call counters; `ticketless` and `withTicket` are scripted */
function harness(opts: {
  ticketless: () => Promise<void>;
  withTicket?: () => Promise<boolean>;
}) {
  const calls = { ticketless: 0, withTicket: 0 };
  return {
    calls,
    deps: {
      ticketless: () => {
        calls.ticketless++;
        return opts.ticketless();
      },
      withTicket: () => {
        calls.withTicket++;
        return (opts.withTicket ?? (() => Promise.resolve(true)))();
      },
      statusOf: deleteRequestStatus,
    },
  };
}

const httpError = (status: number, type?: string) =>
  new DeleteAccountRequestError(status, "", type);

describe("requestAccountDeletion", () => {
  it("ticketless 204: requested, no fallback", async () => {
    const { calls, deps } = harness({ ticketless: () => Promise.resolve() });
    assert.equal(await requestAccountDeletion(deps), "requested");
    assert.deepEqual(calls, { ticketless: 1, withTicket: 0 });
  });

  for (const status of [401, 403]) {
    it(`${status}: falls back to the MFA prompt`, async () => {
      const { calls, deps } = harness({
        ticketless: () => Promise.reject(httpError(status, "NotPrivileged")),
      });
      assert.equal(await requestAccountDeletion(deps), "requested");
      assert.deepEqual(calls, { ticketless: 1, withTicket: 1 });
    });
  }

  it("fallback cancelled: cancelled, never requested", async () => {
    const { calls, deps } = harness({
      ticketless: () => Promise.reject(httpError(403, "NotPrivileged")),
      withTicket: () => Promise.resolve(false),
    });
    assert.equal(await requestAccountDeletion(deps), "cancelled");
    assert.deepEqual(calls, { ticketless: 1, withTicket: 1 });
  });

  it("fallback request fails: rethrown", async () => {
    const failure = { type: "InvalidOperation" };
    const { deps } = harness({
      ticketless: () => Promise.reject(httpError(401)),
      withTicket: () => Promise.reject(failure),
    });
    await assert.rejects(requestAccountDeletion(deps), (e) => e === failure);
  });

  for (const [status, type] of [
    [400, "InvalidOperation"],
    [429, undefined],
    [500, "InternalError"],
  ] as const) {
    it(`${status}: rethrown, fallback NOT called`, async () => {
      const error = httpError(status, type);
      const { calls, deps } = harness({
        ticketless: () => Promise.reject(error),
      });
      await assert.rejects(requestAccountDeletion(deps), (e) => e === error);
      assert.deepEqual(calls, { ticketless: 1, withTicket: 0 });
    });
  }

  it("network error (no status): rethrown, fallback NOT called", async () => {
    const error = new TypeError("Failed to fetch");
    const { calls, deps } = harness({
      ticketless: () => Promise.reject(error),
    });
    await assert.rejects(requestAccountDeletion(deps), (e) => e === error);
    assert.deepEqual(calls, { ticketless: 1, withTicket: 0 });
  });

  it("a thrown body that only looks like a 403 does not fall back", async () => {
    // The API client throws raw bodies; only our own error carries a status.
    const error = { status: 403, type: "NotPrivileged" };
    const { calls, deps } = harness({
      ticketless: () => Promise.reject(error),
    });
    await assert.rejects(requestAccountDeletion(deps), (e) => e === error);
    assert.deepEqual(calls, { ticketless: 1, withTicket: 0 });
  });
});

describe("isOwnedServersRefusal", () => {
  it("matches InvalidOperation from either request path", () => {
    assert.equal(
      isOwnedServersRefusal(httpError(400, "InvalidOperation")),
      true,
    );
    // The API client throws the raw body string on the ticketed path.
    assert.equal(
      isOwnedServersRefusal('{"type":"InvalidOperation","location":"x"}'),
      true,
    );
  });

  it("matches nothing else", () => {
    for (const error of [
      httpError(400),
      httpError(403, "NotPrivileged"),
      httpError(429),
      '{"type":"InvalidCredentials"}',
      "<html>Bad Gateway</html>",
      new TypeError("Failed to fetch"),
      undefined,
      null,
    ]) {
      assert.equal(isOwnedServersRefusal(error), false, String(error));
    }
  });
});

describe("needsTicketFallback", () => {
  it("is exactly 401 and 403", () => {
    for (const status of [401, 403])
      assert.equal(needsTicketFallback(status), true);
    for (const status of [undefined, 200, 204, 400, 404, 429, 500, 502]) {
      assert.equal(needsTicketFallback(status), false, String(status));
    }
  });
});

describe("postDeleteAccountTicketless", () => {
  type Call = { url: string; init?: RequestInit };

  function fakeFetch(response: () => Response) {
    const calls: Call[] = [];
    const fn = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(response());
    }) as typeof fetch;
    return { calls, fn };
  }

  const headers = { "X-Session-Token": "tok" };

  it("POSTs to /auth/account/delete with the session headers, no ticket", async () => {
    const { calls, fn } = fakeFetch(() => new Response(null, { status: 204 }));
    await postDeleteAccountTicketless(fn, "https://api.test", headers);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.test/auth/account/delete");
    assert.equal(calls[0].init?.method, "POST");
    const sent = calls[0].init?.headers as Record<string, string>;
    assert.equal(sent["X-Session-Token"], "tok");
    assert.equal(
      Object.keys(sent).some((key) => key.toLowerCase() === "x-mfa-ticket"),
      false,
    );
  });

  it("keeps the status and the API error type", async () => {
    const { fn } = fakeFetch(
      () =>
        new Response(JSON.stringify({ type: "NotPrivileged" }), {
          status: 403,
          statusText: "Forbidden",
        }),
    );
    await assert.rejects(
      postDeleteAccountTicketless(fn, "https://api.test", headers),
      (e) => {
        assert.ok(e instanceof DeleteAccountRequestError);
        assert.equal(deleteRequestStatus(e), 403);
        assert.equal(e.type, "NotPrivileged");
        return true;
      },
    );
  });

  it("a 401 with an empty body (session guard) still has its status", async () => {
    const { fn } = fakeFetch(() => new Response("", { status: 401 }));
    await assert.rejects(
      postDeleteAccountTicketless(fn, "https://api.test", headers),
      (e) => {
        assert.equal(deleteRequestStatus(e), 401);
        assert.equal((e as DeleteAccountRequestError).type, undefined);
        assert.equal((e as Error).message, "HTTP 401");
        return true;
      },
    );
  });

  it("a 429 without a type keeps its status and no type", async () => {
    const { fn } = fakeFetch(
      () =>
        new Response(JSON.stringify({ retry_after: 5000 }), { status: 429 }),
    );
    await assert.rejects(
      postDeleteAccountTicketless(fn, "https://api.test", headers),
      (e) => {
        assert.equal(deleteRequestStatus(e), 429);
        assert.equal((e as DeleteAccountRequestError).type, undefined);
        return true;
      },
    );
  });

  it("a rejected fetch propagates with no status", async () => {
    const failure = new TypeError("Failed to fetch");
    const fn = (() => Promise.reject(failure)) as typeof fetch;
    await assert.rejects(
      postDeleteAccountTicketless(fn, "https://api.test", headers),
      (e) => e === failure && deleteRequestStatus(e) === undefined,
    );
  });
});
