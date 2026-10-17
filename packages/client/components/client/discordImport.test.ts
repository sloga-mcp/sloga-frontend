/**
 * Run with:
 *
 *     node --conditions=browser --test components/client/discordImport.test.ts
 *
 * Covers the import store's other-platform additions: parsing
 * `features.import_sources` out of the root config probe, the per-source
 * accessors, `kindToSource` / `sourceLabel`, and `trackDiscordImport` learning
 * a job's kind at tracking time (so another platform's job never reads as a
 * Discord one). It also pins the parts Discord users rely on: the probe's
 * `import_discord` flags, and a kind-less `trackDiscordImport(jobId)`.
 *
 * `./discordImport.ts` imports `@revolt/common` (a path alias Node cannot
 * resolve) for the API URL, so that one specifier is swapped for a fixed
 * configuration via `module.registerHooks`, the approach
 * `../common/lib/appOrigin.test.ts` uses. The hook matches only an import from
 * the exact module under test; if it stops matching, the dynamic import below
 * throws and this file fails loudly. `fetch` and `localStorage` are stubbed
 * per spec.
 *
 * Known-bad control: set `DISCORD_IMPORT_UNDER_TEST` to the path of a copy of
 * `discordImport.ts` (kept next to it, so `solid-js` still resolves) with a
 * defect, and the matching specs fail.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const UNDER_TEST = process.env.DISCORD_IMPORT_UNDER_TEST
  ? pathToFileURL(process.env.DISCORD_IMPORT_UNDER_TEST).href
  : new URL("./discordImport.ts", import.meta.url).href;

const COMMON_STUB = "discordimport-test:common";
const API_URL = "https://api-host.test/api";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@revolt/common" && context.parentURL === UNDER_TEST) {
      return { url: COMMON_STUB, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === COMMON_STUB) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export const CONFIGURATION = { DEFAULT_API_URL: ${JSON.stringify(API_URL)} };`,
      };
    }

    return nextLoad(url, context);
  },
});

/** In-memory `localStorage`, so persistence is observable. */
const storage = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
  key: () => null,
  get length() {
    return storage.size;
  },
};

/** Requests the stubbed `fetch` saw. */
const fetched: string[] = [];

/**
 * Make `fetch` answer every request with `body` as JSON (or throw, or answer
 * a non-OK status).
 */
function stubFetch(
  body: unknown,
  mode: "ok" | "status" | "throw" = "ok",
): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    fetched.push(String(url));
    if (mode === "throw") throw new TypeError("network down");
    return {
      ok: mode === "ok",
      json: async () => body,
    };
  };
}

// The first `importSources()` read primes the one-time probe, so the fixture
// it sees must be in place before the module is ever used.
const STOAT_BOT = "https://stoat.example/bot/add?app=importer";
const FLUXER_BOT = "https://fluxer.example/oauth/importer";
stubFetch({
  features: {
    import_discord: true,
    import_discord_stickers: "123456789012345678",
    import_sources: {
      stoat: { add_bot_url: STOAT_BOT },
      fluxer: { add_bot_url: FLUXER_BOT },
      discord: { add_bot_url: "https://discord.example/bot" },
    },
  },
});

// Dynamic, so the hooks above are installed first.
const store: typeof import("./discordImport.ts") = await import(UNDER_TEST);

// ---------------------------------------------------------------- parsing --

describe("parseImportSources", () => {
  const { parseImportSources } = store;

  it("reads anything that is not an object as every source dark", () => {
    for (const raw of [undefined, null, "stoat", 42, true, [], [{}]])
      assert.deepEqual(parseImportSources(raw), {}, JSON.stringify(raw));
  });

  it("reads a stoat-only feature as stoat only", () => {
    assert.deepEqual(
      parseImportSources({ stoat: { add_bot_url: STOAT_BOT } }),
      { stoat: { add_bot_url: STOAT_BOT } },
    );
  });

  it("ignores unknown keys and unknown fields", () => {
    assert.deepEqual(
      parseImportSources({
        stoat: { add_bot_url: STOAT_BOT, extra: 1 },
        discord: { add_bot_url: "https://discord.example/bot" },
        guilded: { add_bot_url: "https://guilded.example/bot" },
      }),
      { stoat: { add_bot_url: STOAT_BOT } },
    );
  });

  it("drops a source whose entry is malformed", () => {
    for (const stoat of [
      null,
      STOAT_BOT,
      [],
      {},
      { add_bot_url: "" },
      { add_bot_url: 5 },
      { bot_user_id: "@importer:stoat.example" },
    ])
      assert.deepEqual(
        parseImportSources({ stoat }),
        {},
        `stoat: ${JSON.stringify(stoat)}`,
      );
  });

  it("refuses a bot URL that is not absolute http(s)", () => {
    for (const add_bot_url of [
      "javascript:alert(1)",
      "data:text/html,<p>hi</p>",
      "/bot/add",
      "stoat.example/bot",
      "ftp://stoat.example/bot",
    ]) {
      assert.deepEqual(
        parseImportSources({ stoat: { add_bot_url } }),
        {},
        add_bot_url,
      );
      assert.deepEqual(
        parseImportSources({ fluxer: { add_bot_url } }),
        {},
        add_bot_url,
      );
    }
    assert.deepEqual(
      parseImportSources({ stoat: { add_bot_url: "http://stoat.test/bot" } }),
      { stoat: { add_bot_url: "http://stoat.test/bot" } },
    );
  });

  it("reads fluxer by bot URL and matrix by bot user id", () => {
    assert.deepEqual(
      parseImportSources({
        fluxer: { add_bot_url: FLUXER_BOT },
        matrix: { bot_user_id: "@importer:matrix.example" },
      }),
      {
        fluxer: { add_bot_url: FLUXER_BOT },
        matrix: { bot_user_id: "@importer:matrix.example" },
      },
    );
    for (const matrix of [{ bot_user_id: "" }, { add_bot_url: STOAT_BOT }, {}])
      assert.deepEqual(parseImportSources({ matrix }), {});
  });
});

// ------------------------------------------------------------------ probe --

describe("the root config probe", () => {
  it("reads import_sources from the same GET / as the Discord flags", async () => {
    // Primed at the first read; give the probe's promise chain a turn.
    assert.deepEqual(store.importSources(), {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(fetched, [`${API_URL}/`], "exactly one probe of GET /");
    assert.deepEqual(store.importSources(), {
      stoat: { add_bot_url: STOAT_BOT },
      fluxer: { add_bot_url: FLUXER_BOT },
    });
    // The Discord flags ride the same response, unchanged.
    assert.equal(store.importDiscordEnabled(), true);
    assert.equal(store.importDiscordStickerClientId(), "123456789012345678");
    // Reading again never probes again.
    store.importSourceEnabled("stoat");
    assert.equal(fetched.length, 1);
  });

  it("offers only the sources this build can import from", () => {
    assert.equal(store.importSourceEnabled("stoat"), true);
    // Advertised, but release 1 has no Fluxer screen.
    assert.equal(store.importSourceEnabled("fluxer"), false);
    assert.equal(store.importSourceEnabled("matrix"), false);
    assert.equal(store.anyImportSourceEnabled(), true);
  });

  it("hands out the advertised bot URLs", () => {
    assert.equal(store.importSourceBotUrl("stoat"), STOAT_BOT);
    assert.equal(store.importSourceBotUrl("fluxer"), FLUXER_BOT);
    assert.equal(store.importSourceBotUrl("matrix"), undefined);
  });

  it("fails closed: every failure mode reads as no sources", async () => {
    const cases: [unknown, "ok" | "status" | "throw"][] = [
      [{ features: { import_discord: true } }, "ok"],
      [{ features: { import_sources: "stoat" } }, "ok"],
      [{ features: { import_sources: null } }, "ok"],
      [{ features: null }, "ok"],
      [null, "ok"],
      [{ features: { import_sources: { stoat: {} } } }, "status"],
      [{}, "throw"],
    ];
    for (const [body, mode] of cases) {
      stubFetch(body, mode);
      const flags = await store.fetchImportDiscordFlags();
      assert.deepEqual(
        flags.importSources,
        {},
        `${mode}: ${JSON.stringify(body)}`,
      );
    }
  });

  it("keeps the Discord flags exactly as before", async () => {
    stubFetch({
      features: {
        import_discord: true,
        import_discord_stickers: "42",
        import_sources: { stoat: { add_bot_url: STOAT_BOT } },
      },
    });
    assert.deepEqual(await store.fetchImportDiscordFlags(), {
      enabled: true,
      stickerClientId: "42",
      importSources: { stoat: { add_bot_url: STOAT_BOT } },
    });

    stubFetch({ features: { import_discord_stickers: "" } });
    assert.deepEqual(await store.fetchImportDiscordFlags(), {
      enabled: false,
      stickerClientId: undefined,
      importSources: {},
    });

    stubFetch({}, "status");
    assert.deepEqual(await store.fetchImportDiscordFlags(), {
      enabled: false,
      importSources: {},
    });
  });
});

// ------------------------------------------------------------------ kinds --

describe("kindToSource and sourceLabel", () => {
  it("maps the source kinds and nothing else", () => {
    assert.equal(store.kindToSource("StoatServer"), "stoat");
    assert.equal(store.kindToSource("FluxerServer"), "fluxer");
    assert.equal(store.kindToSource("MatrixSpace"), "matrix");
    for (const kind of [
      undefined,
      "Template",
      "Stickers",
      "",
      "stoat",
      "StoatServers",
      "Bogus",
    ])
      assert.equal(store.kindToSource(kind), undefined, String(kind));
  });

  it("names the sources as proper nouns", () => {
    assert.equal(store.sourceLabel("stoat"), "Stoat");
    assert.equal(store.sourceLabel("fluxer"), "Fluxer");
    assert.equal(store.sourceLabel("matrix"), "Matrix");
  });
});

// --------------------------------------------------------------- tracking --

describe("trackDiscordImport", () => {
  it("leaves a Discord POST's view exactly as before (no kind)", () => {
    store.trackDiscordImport("job-discord");
    const view = store.discordImportView();
    assert.deepEqual(view, {
      jobId: "job-discord",
      status: "Queued",
      stage: "",
      done: 0,
      total: 0,
    });
    assert.ok(view && !("kind" in view), "no kind key at all");
    assert.equal(store.trackedImportSource(), undefined);
    assert.equal(storage.get("discord_import:job_id"), "job-discord");
  });

  it("sets the kind at tracking time when given", () => {
    store.trackDiscordImport("job-stoat", "StoatServer");
    assert.deepEqual(store.discordImportView(), {
      jobId: "job-stoat",
      status: "Queued",
      stage: "",
      kind: "StoatServer",
      done: 0,
      total: 0,
    });
    assert.equal(store.trackedImportSource(), "stoat");
    assert.equal(storage.get("discord_import:job_id"), "job-stoat");
  });

  it("keeps the kind through progress, complete and failed events", () => {
    store.trackDiscordImport("job-a", "StoatServer");
    store.applyDiscordImportProgress({
      jobId: "job-a",
      stage: "Channels",
      done: 2,
      total: 9,
    });
    assert.equal(store.discordImportView()?.kind, "StoatServer");
    store.applyDiscordImportComplete({
      jobId: "job-a",
      serverId: "srv",
      inviteCode: "inv",
    });
    assert.equal(store.discordImportView()?.kind, "StoatServer");
    assert.equal(store.trackedImportSource(), "stoat");

    store.trackDiscordImport("job-b", "FluxerServer");
    store.applyDiscordImportFailed({ jobId: "job-b", error: "nope" });
    assert.equal(store.discordImportView()?.kind, "FluxerServer");
    assert.equal(store.trackedImportSource(), "fluxer");
  });

  it("reports no other-platform source for Discord kinds", () => {
    for (const kind of ["Template", "Stickers"]) {
      store.trackDiscordImport(`job-${kind}`, kind);
      assert.equal(store.discordImportView()?.kind, kind);
      assert.equal(store.trackedImportSource(), undefined, kind);
    }
    store.clearDiscordImport();
    assert.equal(store.trackedImportSource(), undefined);
  });
});
