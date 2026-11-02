// Spec for the pure decisions in `useProtectedChannel.ts` (W4 lane B6), run
// with Node's built-in runner:
//   node --conditions=browser --test components/client/useProtectedChannel.test.ts
//
// The hooks module imports the client context (`index.tsx`), so Node cannot
// import it directly. This spec loads a COPY: Node's own type stripper
// removes the types, the `"."` import is replaced by a stub, and every other
// import is pointed at the real module (A2's shield, A3's policy,
// `windowCtx.ts`, Solid). The pure functions under test are therefore the
// real source, evaluated against the real A2 shield.
//
// Point `PROTECTED_HOOK_FILE` at another copy (a known-bad control) to load
// that instead; it must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { explainShield, shieldInputsFromView } from "./protectedShield.ts";
import type { ProtectedChannelView } from "./protectedTextTypes";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath =
  process.env.PROTECTED_HOOK_FILE ?? join(here, "useProtectedChannel.ts");
const source = readFileSync(sourcePath, "utf8");

function loadCopy(): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "w4b-B6-"));
  const stub = join(dir, "client-stub.mjs");
  writeFileSync(
    stub,
    "export const useClient = () => () => undefined;\n" +
      "export const useE2EE = () => undefined;\n",
  );
  const map: Record<string, string> = {
    ".": pathToFileURL(stub).href,
    "solid-js": import.meta.resolve("solid-js"),
  };
  let js = stripTypeScriptTypes(source, { mode: "strip" });
  js = js.replace(
    /(from\s+)(["'])([^"']+)\2/g,
    (_m, kw: string, q: string, spec: string) => {
      const target =
        map[spec] ??
        (spec.startsWith("./") ? pathToFileURL(join(here, spec)).href : spec);
      return `${kw}${q}${target}${q}`;
    },
  );
  const out = join(dir, "useProtectedChannel.mjs");
  writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}

const mod = await loadCopy();
const fn = <T>(name: string) => {
  assert.equal(typeof mod[name], "function", `export ${name} missing`);
  return mod[name] as T;
};

const protectedUiOf = fn<(b: unknown) => unknown>("protectedUiOf");
const serverProtectedOf =
  fn<(p: boolean, s: boolean) => boolean>("serverProtectedOf");
const tauriE2eeOffOf =
  fn<
    (i: {
      tauri: boolean;
      bridgePresent: boolean;
      capable: boolean;
      status: { enabled: boolean; published: boolean } | undefined;
    }) => boolean
  >("tauriE2eeOffOf");
const shieldRecheckInMs =
  fn<(v: Partial<ProtectedChannelView> | null, now: number) => number | null>(
    "shieldRecheckInMs",
  );
const shouldRunOpenLifecycle = fn<
  (i: {
    windowCtxId: string;
    channelType: string | undefined;
    protectedOrPinned: boolean;
  }) => boolean
>("shouldRunOpenLifecycle");
const rawProtectedRead =
  fn<(id: string, body: unknown) => { apply: boolean; value?: unknown }>(
    "rawProtectedRead",
  );
const readChannelProtectedFlag = fn<
  (client: unknown, id: string) => Promise<void>
>("readChannelProtectedFlag");

const ID = "01J000000000000000000000AB";

function fakeClient(answer: () => Promise<unknown>) {
  const applied: [string, unknown, boolean][] = [];
  const gets: string[] = [];
  return {
    applied,
    gets,
    client: {
      api: {
        get: (path: string) => {
          gets.push(path);
          return answer();
        },
      },
      applyProtectedFlag: (id: string, value: unknown, full: boolean) => {
        applied.push([id, value, full]);
      },
    },
  };
}

describe("protectedUiOf", () => {
  const full = () => ({
    protectedTextCapable: () => true,
    protectedOpen: () => {},
    protectedClose: () => {},
    protectedChannels: new Map(),
    protectedViews: new Map(),
    protectedTimelineMarkers: new Map(),
  });
  it("accepts a bridge with the whole surface", () => {
    const b = full();
    assert.equal(protectedUiOf(b), b);
  });
  it("rejects an absent bridge or a missing member", () => {
    assert.equal(protectedUiOf(undefined), null);
    assert.equal(protectedUiOf(null), null);
    for (const key of Object.keys(full())) {
      const b: Record<string, unknown> = full();
      delete b[key];
      assert.equal(protectedUiOf(b), null, key);
    }
  });
});

describe("serverProtected uses the strip latch (W4a audit HIGH 1)", () => {
  it("is true only for protected and not stripped", () => {
    assert.equal(serverProtectedOf(true, false), true);
    assert.equal(serverProtectedOf(true, true), false);
    assert.equal(serverProtectedOf(false, false), false);
    assert.equal(serverProtectedOf(false, true), false);
  });
  it("a stripped pinned channel reaches A2 step 1 (unverified)", () => {
    const e = explainShield(
      shieldInputsFromView(
        null,
        {
          serverProtected: serverProtectedOf(true, true),
          locallyPinned: true,
          capable: true,
        },
        0,
      ),
    );
    assert.deepEqual(e, {
      state: "unverified",
      step: "1",
      notice: "flag_stripped",
    });
  });
});

describe("tauriE2eeOffOf (notice only)", () => {
  const base = {
    tauri: true,
    bridgePresent: true,
    capable: false,
    status: { enabled: false, published: false },
  };
  it("Tauri, incapable, E2EE off or unpublished → true", () => {
    assert.equal(tauriE2eeOffOf(base), true);
    assert.equal(
      tauriE2eeOffOf({ ...base, status: { enabled: true, published: false } }),
      true,
    );
  });
  it("anything else → false", () => {
    assert.equal(tauriE2eeOffOf({ ...base, tauri: false }), false);
    assert.equal(tauriE2eeOffOf({ ...base, bridgePresent: false }), false);
    assert.equal(tauriE2eeOffOf({ ...base, capable: true }), false);
    assert.equal(tauriE2eeOffOf({ ...base, status: undefined }), false);
    assert.equal(
      tauriE2eeOffOf({ ...base, status: { enabled: true, published: true } }),
      false,
    );
  });
});

describe("shieldRecheckInMs", () => {
  it("times the step 6 grace from rosterMismatchSinceMs", () => {
    assert.equal(
      shieldRecheckInMs({ rosterMismatchSinceMs: 1_000 }, 11_000),
      50_000,
    );
    assert.equal(
      shieldRecheckInMs({ rosterMismatchSinceMs: 1_000 }, 61_000),
      null,
    );
    assert.equal(shieldRecheckInMs({ rosterMismatchSinceMs: null }, 0), null);
    assert.equal(shieldRecheckInMs(null, 0), null);
  });
});

describe("shouldRunOpenLifecycle (D27, choice 7)", () => {
  const main = {
    windowCtxId: "main",
    channelType: "TextChannel",
    protectedOrPinned: true,
  };
  it("runs in the main window for a protected text channel", () => {
    assert.equal(shouldRunOpenLifecycle(main), true);
  });
  it("never in a chat window", () => {
    assert.equal(
      shouldRunOpenLifecycle({ ...main, windowCtxId: "chat-1" }),
      false,
    );
  });
  it("never for an unprotected or non-text channel", () => {
    assert.equal(
      shouldRunOpenLifecycle({ ...main, protectedOrPinned: false }),
      false,
    );
    for (const t of ["DirectMessage", "Group", "Thread", "Forum", undefined]) {
      assert.equal(shouldRunOpenLifecycle({ ...main, channelType: t }), false);
    }
  });
});

describe("rawProtectedRead", () => {
  it("only a body for this id applies", () => {
    assert.deepEqual(rawProtectedRead(ID, { _id: ID, protected: true }), {
      apply: true,
      value: true,
    });
    assert.deepEqual(rawProtectedRead(ID, { _id: ID }), {
      apply: true,
      value: undefined,
    });
    for (const b of [null, undefined, "x", [], { _id: "OTHER" }, {}]) {
      assert.deepEqual(rawProtectedRead(ID, b), { apply: false });
    }
  });
});

describe("readChannelProtectedFlag: applyProtectedFlag after EVERY raw GET", () => {
  it("protected: true → apply(id, true, full)", async () => {
    const f = fakeClient(async () => ({ _id: ID, protected: true }));
    await readChannelProtectedFlag(f.client, ID);
    assert.deepEqual(f.gets, [`/channels/${ID}`]);
    assert.deepEqual(f.applied, [[ID, true, true]]);
  });
  it("a full object without the flag → apply(id, undefined, full) (strip)", async () => {
    const f = fakeClient(async () => ({ _id: ID, name: "x" }));
    await readChannelProtectedFlag(f.client, ID);
    assert.deepEqual(f.applied, [[ID, undefined, true]]);
  });
  it("protected: false → apply(id, false, full)", async () => {
    const f = fakeClient(async () => ({ _id: ID, protected: false }));
    await readChannelProtectedFlag(f.client, ID);
    assert.deepEqual(f.applied, [[ID, false, true]]);
  });
  it("a failed or foreign read never applies and never rejects", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const answer of [
        () => Promise.reject(new Error("404")),
        async () => ({ _id: "OTHER", protected: false }),
        async () => null,
      ]) {
        const f = fakeClient(answer);
        await readChannelProtectedFlag(f.client, ID);
        assert.deepEqual(f.applied, []);
      }
    } finally {
      console.warn = warn;
    }
  });
});

// ---------------------------------------------------------------------------
// Source scan of the hooks themselves (they cannot run under Node)
// ---------------------------------------------------------------------------

/** The body of `export function <name>(` up to the next top-level export. */
function bodyOf(name: string): string {
  const decl = new RegExp(`export (async )?function ${name}\\(`, "g");
  const all = [...source.matchAll(decl)];
  assert.equal(all.length, 1, `${name}: ${all.length} definitions`);
  const start = all[0].index;
  const next = source
    .slice(start + 1)
    .search(/\n(\/\*\*|export |const |function |type )/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

describe("hook structure (scan)", () => {
  it("read-only hooks send nothing and run no lifecycle", () => {
    for (const name of [
      "useProtectedShield",
      "useProtectedMessage",
      "useProtectedTimeline",
    ]) {
      const b = bodyOf(name);
      for (const bad of [
        "api.get",
        "readChannelProtectedFlag",
        "protectedOpen",
        "protectedClose",
        "setInterval",
      ]) {
        assert.ok(!b.includes(bad), `${name} contains ${bad}`);
      }
    }
  });
  it("the shield is A2's, fed by serverProtectedOf with the strip latch", () => {
    const b = bodyOf("useProtectedShield");
    assert.match(b, /explainShield\(\s*shieldInputsFromView\(/);
    assert.match(
      b,
      /serverProtectedOf\(\s*[^;]*isProtected[^;]*isProtectedFlagStripped\(id\)/,
    );
    assert.ok(!/verdict/.test(source), "shield logic reimplemented here");
  });
  it("the lifecycle is gated, reads now + every 60 s, and closes", () => {
    const b = bodyOf("useProtectedChannelOpen");
    assert.match(b, /shouldRunOpenLifecycle\(/);
    assert.match(b, /useWindowCtx\(\)\.id/);
    assert.match(b, /protectedOpen\(id\)/);
    assert.match(b, /protectedClose\(id\)/);
    assert.match(b, /setInterval\(read, REFRESH_INTERVAL_MS\)/);
    assert.match(b, /readChannelProtectedFlag\(c, id\)/);
  });
  it("the only raw channel GET is readChannelProtectedFlag's", () => {
    const hits = source.match(/api\.get\(/g) ?? [];
    assert.equal(hits.length, 1);
    assert.ok(bodyOf("readChannelProtectedFlag").includes("api.get("));
  });
});
