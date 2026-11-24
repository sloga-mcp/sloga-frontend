// Run from packages/client:
//   node --test --conditions=browser src/sentryScrub.test.ts
// Declared test count: 17 (the runner exits 0 when it finds no tests at all,
// so compare this against its pass count).
//
// Known-bad control: set SENTRY_SCRUB_UNDER_TEST to the path of a changed
// copy of sentryScrub.ts (for example one whose scrubUrl returns its input)
// and the specs that name a token fail.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const underTest: typeof import("./sentryScrub.ts") = await import(
  process.env.SENTRY_SCRUB_UNDER_TEST
    ? pathToFileURL(process.env.SENTRY_SCRUB_UNDER_TEST).href
    : new URL("./sentryScrub.ts", import.meta.url).href
);

const { scrubBreadcrumb, scrubEvent, scrubUrl } = underTest;

// Shaped like a real token, and easy to search a result for
const TOKEN = "s3cretTok_en-0123456789abcdef";

/** Every address shape that carries a token in its path */
const TOKEN_PATHS = [
  "/login/passkey/recover/",
  "/login/reset/",
  "/login/verify/",
  "/login/delete/",
  "/auth/account/verify/",
];

describe("scrubUrl", () => {
  // Fails if: a token stays in a bare path, for any of the token routes
  it("replaces the token of every token route in a bare path", () => {
    for (const path of TOKEN_PATHS) {
      assert.equal(scrubUrl(`${path}${TOKEN}`), `${path}[token]`);
    }
  });

  // Fails if: a token stays when the address is absolute, or the query and
  // the hash after it are lost or read as part of the token
  it("works on absolute addresses and keeps the query and the hash", () => {
    for (const path of TOKEN_PATHS) {
      assert.equal(
        scrubUrl(`https://app.example.test${path}${TOKEN}?from=mail#top`),
        `https://app.example.test${path}[token]?from=mail#top`,
      );
      assert.equal(
        scrubUrl(`https://app.example.test${path}${TOKEN}#top`),
        `https://app.example.test${path}[token]#top`,
      );
      assert.equal(scrubUrl(`${path}${TOKEN}/`), `${path}[token]/`);
    }
  });

  // Fails if: a token inside a sentence (a console line, an error message)
  // gets through, or only the first of two is replaced
  it("finds every token inside longer text", () => {
    // A token runs to the next `/`, `?`, `#`, quote or space: punctuation
    // right after one would go with it, which errs on the safe side
    const text = `Navigated from /login/reset/${TOKEN} to https://app.example.test/login/verify/${TOKEN} then failed`;
    const scrubbed = scrubUrl(text);

    assert.equal(scrubbed.includes(TOKEN), false);
    assert.equal(
      scrubbed,
      "Navigated from /login/reset/[token] to https://app.example.test/login/verify/[token] then failed",
    );
  });

  // Fails if: the OAuth handoff code stays in the address, or other query
  // values are dropped with it
  it("drops the code of an OAuth redirect and nothing else", () => {
    assert.equal(
      scrubUrl(`https://app.example.test/login/oauth?code=${TOKEN}`),
      "https://app.example.test/login/oauth?code=[token]",
    );
    assert.equal(
      scrubUrl(`/login/oauth?state=abc&code=${TOKEN}&next=home#x`),
      "/login/oauth?state=abc&code=[token]&next=home#x",
    );
  });

  // Fails if: an address with no token is changed (a wrong pattern would
  // then hide ordinary addresses in every report)
  it("leaves addresses with no token alone", () => {
    for (const text of [
      "",
      "/",
      "/login/auth",
      "/login/reset",
      "/login/reset/",
      "/login/passkey/recover",
      "/login/passkey/recover?x=1",
      "/login/passkey/create/invitecode",
      "/login/create/invitecode",
      "/login/oauth",
      "/login/oauth?error=denied",
      "/server/01ABC/channel/01DEF",
      "https://app.example.test/server/01ABC/channel/01DEF?code=abc",
      "https://api.example.test/auth/account/verify",
      "a line of text with no address in it",
    ]) {
      assert.equal(scrubUrl(text), text, text);
    }
  });

  // Fails if: scrubbing twice changes the result (a breadcrumb is scrubbed
  // when recorded and again with its event)
  it("gives the same result when run again", () => {
    for (const path of TOKEN_PATHS) {
      const once = scrubUrl(`https://app.example.test${path}${TOKEN}?a=1`);
      assert.equal(scrubUrl(once), once);
    }
    const oauth = scrubUrl(`/login/oauth?code=${TOKEN}`);
    assert.equal(scrubUrl(oauth), oauth);
  });

  // Fails if: a token stays when the fixed part of the path is typed in
  // another letter case, which the app router opens just the same
  it("finds the token routes in any letter case", () => {
    for (const path of TOKEN_PATHS) {
      const upper = path.toUpperCase();
      assert.equal(scrubUrl(`${upper}${TOKEN}`), `${upper}[token]`);
    }
    assert.equal(
      scrubUrl(`https://app.example.test/Login/Reset/${TOKEN}?a=1`),
      "https://app.example.test/Login/Reset/[token]?a=1",
    );
    assert.equal(
      scrubUrl(`/Login/OAuth?state=abc&Code=${TOKEN}`),
      "/Login/OAuth?state=abc&Code=[token]",
    );
  });
});

describe("scrubBreadcrumb", () => {
  // Fails if: a navigation breadcrumb keeps the token in `from` or `to`
  it("cleans the from and to of a navigation breadcrumb", () => {
    const crumb = {
      category: "navigation",
      data: {
        from: `/login/passkey/recover/${TOKEN}`,
        to: `/login/reset/${TOKEN}?x=1`,
      },
    };

    const scrubbed = scrubBreadcrumb(crumb);

    assert.deepEqual(scrubbed, {
      category: "navigation",
      data: {
        from: "/login/passkey/recover/[token]",
        to: "/login/reset/[token]?x=1",
      },
    });
    assert.equal(JSON.stringify(scrubbed).includes(TOKEN), false);
  });

  // Fails if: a request breadcrumb keeps the token in `url`, or a console
  // breadcrumb keeps it in `message`; or other data is lost
  it("cleans the url of a request breadcrumb and the message", () => {
    const request = scrubBreadcrumb({
      category: "fetch",
      data: {
        method: "POST",
        url: `https://api.example.test/auth/account/verify/${TOKEN}`,
        status_code: 200,
      },
    });
    assert.deepEqual(request.data, {
      method: "POST",
      url: "https://api.example.test/auth/account/verify/[token]",
      status_code: 200,
    });

    const line = scrubBreadcrumb({
      category: "console",
      message: `opened /login/verify/${TOKEN}`,
    });
    assert.equal(line.message, "opened /login/verify/[token]");
  });

  // Fails if: a console breadcrumb is cleaned in its message but still
  // carries the logged address in `data.arguments`
  it("cleans the logged arguments of a console breadcrumb", () => {
    const payload = { kept: true };
    const scrubbed = scrubBreadcrumb({
      category: "console",
      message: `opened /login/reset/${TOKEN} [object Object]`,
      data: {
        logger: "console",
        arguments: ["opened", `/login/reset/${TOKEN}`, payload, 5],
      },
    });

    assert.equal(JSON.stringify(scrubbed).includes(TOKEN), false);
    assert.deepEqual(scrubbed.data, {
      logger: "console",
      arguments: ["opened", "/login/reset/[token]", payload, 5],
    });
  });

  // Fails if: the breadcrumb given is changed in place, or a breadcrumb
  // with no data, or with data that is not text, throws
  it("returns a copy and takes any shape", () => {
    const crumb = { data: { to: `/login/reset/${TOKEN}` } };
    scrubBreadcrumb(crumb);
    assert.equal(crumb.data.to, `/login/reset/${TOKEN}`);

    assert.deepEqual(scrubBreadcrumb({}), {});
    assert.deepEqual(scrubBreadcrumb({ category: "ui.click" } as never), {
      category: "ui.click",
    });
    assert.deepEqual(scrubBreadcrumb({ data: { to: 5, url: null } }), {
      data: { to: 5, url: null },
    });
  });
});

describe("scrubEvent", () => {
  // Fails if: the page address of an event, its referrer or its
  // transaction name keeps a token
  it("cleans the request url, the referrer and the transaction", () => {
    const event = {
      event_id: "abc",
      transaction: `/login/delete/${TOKEN}`,
      request: {
        url: `https://app.example.test/login/passkey/recover/${TOKEN}`,
        headers: {
          Referer: `https://app.example.test/login/oauth?code=${TOKEN}`,
          "User-Agent": "test",
        },
      },
    };

    const scrubbed = scrubEvent(event);

    assert.deepEqual(scrubbed, {
      event_id: "abc",
      transaction: "/login/delete/[token]",
      request: {
        url: "https://app.example.test/login/passkey/recover/[token]",
        headers: {
          Referer: "https://app.example.test/login/oauth?code=[token]",
          "User-Agent": "test",
        },
      },
    });
    assert.equal(JSON.stringify(scrubbed).includes(TOKEN), false);
    // The event given is not changed
    assert.equal(event.request.url.includes(TOKEN), true);
  });

  // Fails if: breadcrumbs already on the event are sent as they are
  it("cleans every breadcrumb on the event", () => {
    const scrubbed = scrubEvent({
      breadcrumbs: [
        {
          category: "navigation",
          data: { from: "/", to: `/login/reset/${TOKEN}` },
        },
        { category: "console", message: `at /login/verify/${TOKEN}` },
        { category: "ui.click", message: "button" },
      ],
    });

    assert.equal(JSON.stringify(scrubbed).includes(TOKEN), false);
    assert.equal(scrubbed.breadcrumbs.length, 3);
    assert.deepEqual(scrubbed.breadcrumbs[2], {
      category: "ui.click",
      message: "button",
    });
  });

  // Fails if: the message of an event, or the text of an exception on it
  // (an error message that quotes the page address), keeps a token
  it("cleans the message and the text of every exception", () => {
    const event = {
      message: `Could not load /login/verify/${TOKEN}`,
      exception: {
        values: [
          {
            type: "Error",
            value: `Failed at https://app.example.test/login/reset/${TOKEN}`,
          },
          {
            type: "TypeError",
            value: `bad redirect /login/oauth?code=${TOKEN}&next=home`,
          },
          { type: "Error", value: "no address here" },
        ],
      },
    };

    const scrubbed = scrubEvent(event);

    assert.deepEqual(scrubbed, {
      message: "Could not load /login/verify/[token]",
      exception: {
        values: [
          {
            type: "Error",
            value: "Failed at https://app.example.test/login/reset/[token]",
          },
          {
            type: "TypeError",
            value: "bad redirect /login/oauth?code=[token]&next=home",
          },
          { type: "Error", value: "no address here" },
        ],
      },
    });
    assert.equal(JSON.stringify(scrubbed).includes(TOKEN), false);
    // The event given is not changed
    assert.equal(event.exception.values[0].value.includes(TOKEN), true);
  });

  // Fails if: a stack frame keeps the page address (with its token) as the
  // file it names, in `filename` or in `abs_path`; or the rest of a frame
  // is lost
  it("cleans the filename and abs_path of every stack frame", () => {
    const page = `https://app.example.test/login/passkey/recover/${TOKEN}`;
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: {
              frames: [
                { filename: page, abs_path: page, lineno: 3, in_app: true },
                {
                  filename: "https://app.example.test/assets/index.js",
                  function: "run",
                },
                { abs_path: `/login/delete/${TOKEN}` },
              ],
            },
          },
        ],
      },
    };

    const scrubbed = scrubEvent(event);
    const clean = "https://app.example.test/login/passkey/recover/[token]";

    assert.deepEqual(scrubbed.exception.values[0].stacktrace.frames, [
      { filename: clean, abs_path: clean, lineno: 3, in_app: true },
      {
        filename: "https://app.example.test/assets/index.js",
        function: "run",
      },
      { abs_path: "/login/delete/[token]" },
    ]);
    assert.equal(JSON.stringify(scrubbed).includes(TOKEN), false);
    // The event given is not changed
    assert.equal(event.exception.values[0].stacktrace.frames[0].filename, page);
  });

  // Fails if: an exception with no values, no text, no stack or no frames
  // throws, or comes back in another shape
  it("takes an exception of any shape", () => {
    for (const event of [
      { exception: {} },
      { exception: { values: [] } },
      { exception: { values: [{}] } },
      { exception: { values: [{ type: "Error", stacktrace: {} }] } },
      { exception: { values: [{ stacktrace: { frames: [{}] } }] } },
      { message: "" },
    ]) {
      assert.deepEqual(scrubEvent(event), event, JSON.stringify(event));
    }
  });

  // Fails if: an event with no request, or a lower-case referrer header,
  // throws or is skipped
  it("takes an event with no request and any case of the header name", () => {
    assert.deepEqual(scrubEvent({}), {});
    assert.deepEqual(scrubEvent({ event_id: "abc" } as never), {
      event_id: "abc",
    });
    assert.deepEqual(
      scrubEvent({
        request: { headers: { referer: `/login/reset/${TOKEN}` } },
      }),
      { request: { headers: { referer: "/login/reset/[token]" } } },
    );
  });
});
