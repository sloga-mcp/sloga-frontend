// Unit spec for gameLookup. Run with Node's built-in runner from
// packages/client:
//   node --test --conditions=browser src/interface/channels/text/gameLookup.test.ts
// Declared test count: 17 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: the composer's `/game`, `/wowitem` and `/champion` commands. The
// privacy gate is the load-bearing part: a lookup sends what the user typed
// to the server, so in a DM or group it may run only when the native layer
// says the conversation is exactly "plaintext". Every other answer, a
// missing answer and an error must fail closed with ZERO requests.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type FetchLike,
  type GameCommand,
  gameLookupAllowed,
  gameLookupErrorOutcome,
  parseGameCommand,
  pickerIndexAfterKey,
  readGameLookupResults,
  runGameLookup,
} from "./gameLookup.ts";

/**
 * Fake fetch that records every call and answers with a fixed response
 */
function countingFetch(
  status = 200,
  body: unknown = [
    {
      title: "Portal 2",
      subtitle: "Valve",
      url: "https://store.steampowered.com/app/620",
    },
  ],
) {
  const calls: { input: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ input, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { calls, fetchImpl };
}

const PORTAL: GameCommand = { source: "steam", query: "portal 2" };

function lookup(
  channelType: string,
  getSendMode: (() => Promise<string | null | undefined>) | undefined,
  fetchImpl: FetchLike,
  command: GameCommand = PORTAL,
) {
  return runGameLookup({
    channelType,
    getSendMode,
    fetchImpl,
    baseURL: "https://api.example",
    authHeader: ["X-Session-Token", "token"],
    command,
  });
}

test("parses each command to its source", () => {
  assert.deepEqual(parseGameCommand("/game helldivers"), {
    source: "steam",
    query: "helldivers",
  });
  assert.deepEqual(parseGameCommand("/wowitem Thunderfury"), {
    source: "wow",
    query: "Thunderfury",
  });
  assert.deepEqual(parseGameCommand("/champion ahri"), {
    source: "lol",
    query: "ahri",
  });
});

test("command word is case-insensitive; the query keeps its case", () => {
  assert.deepEqual(parseGameCommand("/GAME Portal"), {
    source: "steam",
    query: "Portal",
  });
  assert.deepEqual(parseGameCommand("/WoWItem Ashkandi"), {
    source: "wow",
    query: "Ashkandi",
  });
});

test("extra spaces are trimmed and collapsed", () => {
  assert.deepEqual(parseGameCommand("   /game    portal     2   "), {
    source: "steam",
    query: "portal 2",
  });
  assert.deepEqual(parseGameCommand("/champion\tmiss\n fortune"), {
    source: "lol",
    query: "miss fortune",
  });
});

test("a command with nothing after it parses with an empty query", () => {
  assert.deepEqual(parseGameCommand("/game"), { source: "steam", query: "" });
  assert.deepEqual(parseGameCommand("/game    "), {
    source: "steam",
    query: "",
  });
  assert.deepEqual(parseGameCommand("/champion"), {
    source: "lol",
    query: "",
  });
});

test("other text is not a lookup command", () => {
  assert.equal(parseGameCommand("/gamex portal"), null);
  assert.equal(parseGameCommand("/gamex"), null);
  assert.equal(parseGameCommand("/games portal"), null);
  assert.equal(parseGameCommand("/wowitems x"), null);
  assert.equal(parseGameCommand("/roll 1d20"), null);
  assert.equal(parseGameCommand("game portal"), null);
  assert.equal(parseGameCommand("hello /game portal"), null);
  assert.equal(parseGameCommand("/ game portal"), null);
  assert.equal(parseGameCommand(""), null);
});

test("gate: server channels are allowed without asking the native layer", async () => {
  let asked = 0;
  const getSendMode = async () => {
    asked++;
    return "encrypt";
  };
  assert.equal(await gameLookupAllowed("TextChannel", getSendMode), true);
  assert.equal(await gameLookupAllowed("Thread", getSendMode), true);
  assert.equal(await gameLookupAllowed("TextChannel", undefined), true);
  assert.equal(asked, 0);
});

test("gate: a plaintext DM or group is allowed", async () => {
  assert.equal(
    await gameLookupAllowed("DirectMessage", async () => "plaintext"),
    true,
  );
  assert.equal(await gameLookupAllowed("Group", async () => "plaintext"), true);
});

test("gate: any other DM or group mode is denied", async () => {
  for (const type of ["DirectMessage", "Group"]) {
    for (const mode of [
      "encrypt",
      "e2ee",
      "blocked",
      "peer_downgraded",
      "pending",
      "Plaintext",
      "",
    ]) {
      assert.equal(
        await gameLookupAllowed(type, async () => mode),
        false,
        `${type} ${mode}`,
      );
    }
  }
});

test("gate: an unloaded mode is denied", async () => {
  for (const type of ["DirectMessage", "Group"]) {
    assert.equal(await gameLookupAllowed(type, async () => undefined), false);
    assert.equal(await gameLookupAllowed(type, async () => null), false);
    // No native layer at all (web): nothing to prove the chat is plaintext
    assert.equal(await gameLookupAllowed(type, undefined), false);
  }
});

test("gate: a send-mode error is denied", async () => {
  for (const type of ["DirectMessage", "Group"]) {
    assert.equal(
      await gameLookupAllowed(type, () =>
        Promise.reject(new Error("native layer unreachable")),
      ),
      false,
    );
    assert.equal(
      await gameLookupAllowed(type, () => {
        throw new Error("thrown before a promise");
      }),
      false,
    );
  }
});

test("gate: saved messages and unknown types are denied", async () => {
  const plaintext = async () => "plaintext";
  assert.equal(await gameLookupAllowed("SavedMessages", plaintext), false);
  assert.equal(await gameLookupAllowed("VoiceChannel", plaintext), false);
  assert.equal(await gameLookupAllowed("", plaintext), false);
});

test("a denied lookup makes zero requests", async () => {
  const denied: [
    string,
    (() => Promise<string | null | undefined>) | undefined,
  ][] = [
    ["DirectMessage", async () => "encrypt"],
    ["DirectMessage", async () => "e2ee"],
    ["Group", async () => "blocked"],
    ["DirectMessage", async () => undefined],
    ["Group", async () => null],
    ["DirectMessage", undefined],
    ["DirectMessage", () => Promise.reject(new Error("boom"))],
    ["Group", () => Promise.reject(new Error("boom"))],
    ["SavedMessages", async () => "plaintext"],
  ];

  const { calls, fetchImpl } = countingFetch();
  for (const [type, getSendMode] of denied) {
    assert.deepEqual(await lookup(type, getSendMode, fetchImpl), {
      kind: "denied",
    });
  }
  assert.equal(calls.length, 0);
});

test("an allowed lookup makes one authenticated GET", async () => {
  const { calls, fetchImpl } = countingFetch();
  const outcome = await lookup("TextChannel", undefined, fetchImpl, {
    source: "wow",
    query: "thunder fury&x=1",
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].input);
  assert.equal(url.origin + url.pathname, "https://api.example/lookup/games");
  assert.equal(url.searchParams.get("source"), "wow");
  assert.equal(url.searchParams.get("q"), "thunder fury&x=1");
  assert.equal(url.searchParams.get("x"), null);
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(calls[0].init.headers, { "X-Session-Token": "token" });

  assert.deepEqual(outcome, {
    kind: "results",
    results: [
      {
        title: "Portal 2",
        subtitle: "Valve",
        url: "https://store.steampowered.com/app/620",
      },
    ],
  });

  const dm = countingFetch();
  await lookup("DirectMessage", async () => "plaintext", dm.fetchImpl);
  assert.equal(dm.calls.length, 1);
});

test("an empty query makes zero requests", async () => {
  const { calls, fetchImpl } = countingFetch();
  assert.deepEqual(
    await lookup("TextChannel", undefined, fetchImpl, {
      source: "steam",
      query: "",
    }),
    { kind: "empty-query" },
  );
  assert.equal(calls.length, 0);
});

test("errors map to busy, disabled or failed", async () => {
  assert.deepEqual(gameLookupErrorOutcome(429, { type: "InSlowmode" }), {
    kind: "busy",
  });
  assert.deepEqual(
    gameLookupErrorOutcome(400, { type: "InSlowmode", retry_after: 3 }),
    { kind: "busy" },
  );
  assert.deepEqual(gameLookupErrorOutcome(429, undefined), { kind: "busy" });
  assert.deepEqual(gameLookupErrorOutcome(400, { type: "FeatureDisabled" }), {
    kind: "disabled",
  });
  for (const type of ["IsBot", "FailedValidation", "InvalidOperation"]) {
    assert.deepEqual(gameLookupErrorOutcome(400, { type }), {
      kind: "failed",
    });
  }
  assert.deepEqual(gameLookupErrorOutcome(500, "<html>"), { kind: "failed" });

  const busy = countingFetch(429, { type: "InSlowmode", retry_after: 12 });
  assert.deepEqual(await lookup("TextChannel", undefined, busy.fetchImpl), {
    kind: "busy",
  });

  const thrown: FetchLike = () => Promise.reject(new TypeError("offline"));
  assert.deepEqual(await lookup("TextChannel", undefined, thrown), {
    kind: "failed",
  });

  const notAList = countingFetch(200, { title: "x" });
  assert.deepEqual(await lookup("TextChannel", undefined, notAList.fetchImpl), {
    kind: "failed",
  });
});

test("results keep only well-formed http(s) entries, at most 5", () => {
  assert.equal(readGameLookupResults({}), null);
  assert.deepEqual(readGameLookupResults([]), []);

  const many = Array.from({ length: 8 }, (_, i) => ({
    title: `Game ${i}`,
    subtitle: null,
    url: `https://store.steampowered.com/app/${i}`,
  }));
  assert.equal(readGameLookupResults(many)!.length, 5);

  assert.deepEqual(
    readGameLookupResults([
      null,
      "x",
      { title: "", url: "https://a.example" },
      { title: "No url" },
      { title: "Script", url: "javascript:alert(1)" },
      { title: "Command", url: "/game portal" },
      { title: "Spaced", url: "https://a.example/x y" },
      { title: "Ok", subtitle: "", url: "http://b.example/1" },
      { title: "Sub", subtitle: 5, url: "https://c.example" },
    ]),
    [
      { title: "Ok", subtitle: null, url: "http://b.example/1" },
      { title: "Sub", subtitle: null, url: "https://c.example" },
    ],
  );
});

test("picker selection wraps with the arrow keys", () => {
  assert.equal(pickerIndexAfterKey(0, "ArrowDown", 3), 1);
  assert.equal(pickerIndexAfterKey(2, "ArrowDown", 3), 0);
  assert.equal(pickerIndexAfterKey(0, "ArrowUp", 3), 2);
  assert.equal(pickerIndexAfterKey(1, "ArrowUp", 3), 0);
  assert.equal(pickerIndexAfterKey(1, "Enter", 3), 1);
  assert.equal(pickerIndexAfterKey(0, "ArrowDown", 0), 0);
});
