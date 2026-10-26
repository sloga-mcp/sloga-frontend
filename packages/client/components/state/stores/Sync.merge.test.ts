/**
 * Run with:
 *
 *     node --conditions=browser --test components/state/stores/Sync.merge.test.ts
 *
 * Covers how `./Sync.ts` merges a remote copy of a synchronised key.
 *
 * The bug this exists for: `merge()` compared the remote revision against
 * `this.ts(key)`, and a device updated to a client that adds a new key has NO
 * revision for it. `State.hydrate()` (`../index.tsx`) runs the revision map
 * on disk through `clean()`, which keeps only known keys with a truthy
 * revision, and `setStore("sync", ...)` then replaces the default map
 * (which has the new key at 0) wholesale. So `ts > undefined` was false,
 * `ts !== undefined` was true, the empty default differed from the remote
 * data, and the device `touch`ed: it uploaded its empty default with a newer
 * revision, wiping the key on every device. The "upgraded device" specs
 * below rebuild exactly that state through the real `clean()` and a real
 * solid store, and assert the precondition before trusting the outcome.
 *
 * `./Sync.ts` is loaded through `module.registerHooks`, as
 * `./Draft.editing.test.ts` documents: its value imports of `"."`, `".."`
 * and the sibling type modules cannot load under Node, so they are stood in
 * for. Bare packages are re-exported from this spec's own resolution, so a
 * copy of `Sync.ts` outside the worktree loads too. `import.meta.env` is a
 * Vite `define`, undefined under Node, so `{ DEV: false }` is APPENDED to the
 * module source (no line of it is rewritten).
 *
 * Known-bad control: point `SYNC_UNDER_TEST` at an absolute path to another
 * `Sync.ts`. The one at 0d81d2e9 fails the upgraded-device specs (it touches
 * instead of adopting), and a copy of this one with the old comparison
 * restored in `syncMergeDecision` fails the decision specs as well. The
 * `forget()` specs fail on 0d81d2e9 (no such method) and on a copy whose
 * `forget()` does nothing. The owner, `reset()` and stale-fetch specs fail on
 * 0d81d2e9 (none of it exists), on a copy whose `reset()` writes the default
 * without the sync block (it queues an upload), and on a copy whose
 * `initialSync` lost its stale-response check. The signed-out and
 * same-account specs also fail on a copy that checks only the owner and
 * ignores `isCurrent`: the owner does not change in either.
 *
 * The "theme" specs fail on ab7455e7 (no theme key) and on a copy that
 * uploads the device-local fields, adopts a remote copy without keeping
 * them, queues an upload for an edit to one, merges a copy in another
 * format, never seeds an account, counts the Material You fields under the
 * Sloga preset when seeding, or leaves `untracked()`'s block behind.
 *
 * The "older client" specs fail on 1dcdd1b4 (the copy without `style` and
 * the backgrounds is adopted as is), on a copy that fills the missing fields
 * even with no revision or overwrites fields the copy does carry, and on a
 * copy that uploads newer fields this device never knew (a just-updated
 * device then wipes a peer's picks with its defaults).
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { createStore, unwrap } from "solid-js/store";

const UNDER_TEST = process.env.SYNC_UNDER_TEST
  ? pathToFileURL(process.env.SYNC_UNDER_TEST).href
  : new URL("./Sync.ts", import.meta.url).href;

const reexport = (names: string, specifier: string) =>
  `export { ${names} } from ${JSON.stringify(import.meta.resolve(specifier))};`;

const STUBS: Record<string, string> = {
  "lodash.isequal": reexport("default", "lodash.isequal"),
  "solid-js": reexport("batch", "solid-js"),
  "@solid-primitives/set": reexport("ReactiveSet", "@solid-primitives/set"),
  "stoat.js": `export class Client {}`,
  "..": `export class State {}`,
  ".": `export class AbstractStore {
    constructor(state, key) { this.state = state; this.key = key; }
    getKey() { return this.key; }
    get() { return this.state.get(this.key); }
    set(...args) { this.state.set(this.key, ...args); }
  }`,
  "./FriendGroups": `export const TypeFriendGroups = undefined;`,
  "./Friends": `export const TypeFriends = undefined;`,
  "./HomeLayout": `export const TypeHomeLayout = undefined;`,
  "./NotificationOptions": `export const TypeNotificationOptions = undefined;`,
  "./Ordering": `export const TypeOrdering = undefined;`,
  "./ReleaseNotes": `export const TypeReleaseNotes = undefined;`,
  "./Theme": `export const TypeTheme = undefined;`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS && context.parentURL === UNDER_TEST) {
      return { url: `sync-merge-test:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("sync-merge-test:")) {
      return {
        format: "module",
        shortCircuit: true,
        source: STUBS[url.slice("sync-merge-test:".length)],
      };
    }
    const loaded = nextLoad(url, context);
    if (url !== UNDER_TEST) return loaded;
    return {
      ...loaded,
      source: `${String(loaded.source)}\n;import.meta.env ??= { DEV: false };\n`,
    };
  },
});

const mod = await import(UNDER_TEST);
const { Sync } = mod;

type Decision = "adopt" | "touch" | "noop";
type Decide = (
  remoteTs: number,
  localTs: number | undefined,
  sameData: () => boolean,
) => Decision;

function decide(...args: Parameters<Decide>): Decision {
  assert.equal(
    typeof mod.syncMergeDecision,
    "function",
    "the module under test exports no syncMergeDecision",
  );
  return (mod.syncMergeDecision as Decide)(...args);
}

const same = () => true;
const differs = () => false;

describe("syncMergeDecision()", () => {
  it("adopts remote data when this device has no revision for the key", () => {
    for (const local of [undefined, 0]) {
      for (const remote of [1, 1_000, Date.now() + 60_000]) {
        assert.equal(decide(remote, local, differs), "adopt", `${local}`);
        assert.equal(decide(remote, local, same), "adopt", `${local}`);
      }
    }
  });

  it("touches an older remote only when the data differs", () => {
    assert.equal(decide(1_000, 5_000, differs), "touch");
    assert.equal(decide(1_000, 5_000, same), "noop");
  });

  it("adopts a newer remote", () => {
    assert.equal(decide(9_000, 5_000, differs), "adopt");
    assert.equal(decide(9_000, 5_000, same), "adopt");
  });

  it("does nothing for the revision it already has", () => {
    assert.equal(decide(5_000, 5_000, differs), "noop");
    assert.equal(decide(5_000, 5_000, same), "noop");
  });
});

/** A stand-in theme default; Sync only compares against whatever it is */
const THEME_DEFAULT = {
  preset: "stoat",
  presetMigrated: true,
  mode: "dark",
  style: "modern",
  slogaSurfaceDark: "",
  slogaSurfaceLight: "",
  // a default the device never set: none of the newer fields is known
  knownFields: [] as string[],
  slogaAccent: "#5470ec",
  m3Accent: "#5470ec",
  m3Contrast: 0,
  m3Variant: "tonal_spot",
  interfaceFont: "Inter",
  monospaceFont: "Fira Code",
  blur: true,
  railAccent: "#f59e0b",
  messageSize: 14,
  messageGroupSpacing: 12,
  messageAvatarSize: 36,
};

/** Fields Sync keeps on the device (`DEVICE_LOCAL_THEME_FIELDS`) */
const DEVICE_LOCAL = [
  "blur",
  "messageSize",
  "messageGroupSpacing",
  "messageAvatarSize",
];

/** The newer theme fields (`themeFields.ts`), in its order */
const NEWER = ["style", "slogaSurfaceDark", "slogaSurfaceLight"];

const KEYS = {
  theme: {
    empty: THEME_DEFAULT,
    // same device-local fields as the default, so the generic specs below
    // can compare whole copies
    remote: {
      ...THEME_DEFAULT,
      preset: "you",
      mode: "light",
      m3Accent: "#8c5fd3",
      m3Variant: "vibrant",
      railAccent: "#54ecc1",
      interfaceFont: "Atkinson Hyperlegible",
      // from a device that has every newer field, so it uploads them all
      knownFields: ["style", "slogaSurfaceDark", "slogaSurfaceLight"],
    },
  },
  friends: {
    empty: { favourites: [], collapsed: [] },
    remote: { favourites: ["u1"], collapsed: ["online"] },
  },
  "friend-groups": {
    empty: { groups: [], members: {} },
    remote: {
      groups: [{ id: "g1", name: "Raid night", order: 0 }],
      members: { g1: ["u1", "u2"] },
    },
  },
} as const;

type Key = keyof typeof KEYS;

/**
 * A real Sync over a real solid store, standing in for `State`
 * @param key The synchronised key under test
 * @param local That key's local data
 * @param diskRevision The revision map `State.hydrate()` found on disk, if any
 */
function world(
  key: Key,
  local: unknown,
  diskRevision?: Record<string, number>,
) {
  // the theme is always there, as in State: initialSync reads it to decide
  // whether to seed the account with it
  const [store, setStore] = createStore<Record<string, unknown>>({
    sync: new Sync({} as never).default(),
    theme: structuredClone(KEYS.theme.empty),
    [key]: structuredClone(local),
  });

  const stub = (k: Key) => ({
    clean: (input: unknown) => input,
    get: () => store[k],
    default: () => structuredClone(KEYS[k].empty),
  });

  const state: Record<string, unknown> = {
    get: (k: string) => store[k],
    // State.write(): every write touches the key if it is syncable, passing
    // the field when the write names one
    set: (...args: unknown[]) => {
      (setStore as unknown as (...args: unknown[]) => void)(...args);
      sync.touchIfSyncable(args[0] as string, args[1]);
    },
    theme: stub("theme"),
    [key]: stub(key),
  };

  const sync = new Sync(state as never);
  state.sync = sync;

  // State.hydrate(): the disk copy goes through clean() and then setStore
  if (diskRevision) {
    setStore("sync", sync.clean({ revision: diskRevision }));
  }

  const revisions = () =>
    (store.sync as { revision: Record<string, number | undefined> }).revision;

  return {
    sync,
    state,
    data: () => structuredClone(unwrap(store[key])) as Record<string, unknown>,
    revision: () => revisions()[key],
  };
}

/** The revision map an older client left on disk, without the key */
function olderDisk(key: Key) {
  const disk: Record<string, number> = {
    ordering: 4_000,
    notifications: 4_000,
    "release-notes": 4_000,
    friends: 4_000,
  };
  delete disk[key];
  return disk;
}

for (const key of Object.keys(KEYS) as Key[]) {
  const { empty, remote } = KEYS[key];

  describe(`Sync.merge() for "${key}"`, () => {
    it("an upgraded device with no revision adopts the remote data and does not touch", () => {
      const w = world(key, empty, olderDisk(key));
      // the precondition the bug needs: hydrate left no revision for the key
      assert.equal(w.revision(), undefined);

      w.sync.merge(1_000, key, JSON.stringify(remote));

      assert.equal(w.sync.shouldSync, false, "queued the empty default");
      assert.deepEqual(w.data(), remote);
      assert.equal(w.revision(), 1_000);

      // the sync block is spent on the adopting write, so a later local
      // edit still goes out
      (w.state.set as (...args: unknown[]) => void)(key, empty);
      assert.equal(w.sync.shouldSync, true);
    });

    it("a fresh device (default revision 0) adopts the remote data", () => {
      const w = world(key, empty);
      w.sync.merge(1_000, key, JSON.stringify(remote));

      assert.deepEqual(w.data(), remote);
      assert.equal(w.revision(), 1_000);
      assert.equal(w.sync.shouldSync, false);
    });

    it("an older remote with different data is touched, keeping local data", () => {
      const w = world(key, remote, { ...olderDisk(key), [key]: 5_000 });
      w.sync.merge(1_000, key, JSON.stringify(empty));

      assert.deepEqual(w.data(), remote);
      assert.equal(w.sync.shouldSync, true);
      assert.ok((w.revision() ?? 0) > 5_000);
    });

    it("an older remote with equal data does nothing", () => {
      const w = world(key, remote, { ...olderDisk(key), [key]: 5_000 });
      w.sync.merge(1_000, key, JSON.stringify(remote));

      assert.deepEqual(w.data(), remote);
      assert.equal(w.sync.shouldSync, false);
      assert.equal(w.revision(), 5_000);
    });

    it("a newer remote is adopted", () => {
      const w = world(key, empty, { ...olderDisk(key), [key]: 5_000 });
      w.sync.merge(9_000, key, JSON.stringify(remote));

      assert.deepEqual(w.data(), remote);
      assert.equal(w.revision(), 9_000);
      assert.equal(w.sync.shouldSync, false);
    });
  });
}

describe('"friend-groups" registration', () => {
  it("is in the default revision map", () => {
    assert.equal(new Sync({} as never).default().revision["friend-groups"], 0);
  });

  it("clean() keeps its revision", () => {
    const sync = new Sync({} as never);
    assert.deepEqual(
      sync.clean({ revision: { "friend-groups": 7, unknown: 3 } }).revision,
      { "friend-groups": 7 },
    );
  });

  it("initialSync fetches it and adopts it on an upgraded device", async () => {
    const w = world(
      "friend-groups",
      KEYS["friend-groups"].empty,
      olderDisk("friend-groups"),
    );
    let asked: string[] = [];
    const client = {
      api: {
        post: async (_route: string, body: { keys: string[] }) => {
          asked = body.keys;
          return {
            "friend-groups": [
              1_000,
              JSON.stringify(KEYS["friend-groups"].remote),
            ],
          };
        },
      },
    };

    await w.sync.initialSync(client as never);

    assert.ok(asked.includes("friend-groups"));
    assert.deepEqual(w.data(), KEYS["friend-groups"].remote);
    assert.equal(w.sync.shouldSync, false);
  });

  it("a live settings event for it is merged", () => {
    const w = world(
      "friend-groups",
      KEYS["friend-groups"].empty,
      olderDisk("friend-groups"),
    );
    w.sync.consumeEvent({
      "friend-groups": [1_000, JSON.stringify(KEYS["friend-groups"].remote)],
    });

    assert.deepEqual(w.data(), KEYS["friend-groups"].remote);
    assert.equal(w.sync.shouldSync, false);
  });
});

describe('"theme" sync', () => {
  const theme = KEYS.theme;
  const set = (w: ReturnType<typeof world>) =>
    w.state.set as (...args: unknown[]) => void;

  /** A client recording uploads and answering the fetch with `response` */
  function recorder(response: Record<string, [number, string]> = {}) {
    const sent: Record<string, unknown>[] = [];
    let asked: string[] = [];
    const client = {
      api: {
        post: async (route: string, body: Record<string, unknown>) => {
          if (route === "/sync/settings/fetch") {
            asked = body.keys as string[];
            return response;
          }
          sent.push(body);
        },
      },
    };
    return { client: client as never, sent, asked: () => asked };
  }

  it("is registered: default revision, clean() and the fetch", async () => {
    const sync = new Sync({} as never);
    assert.equal(sync.default().revision.theme, 0);
    assert.deepEqual(sync.clean({ revision: { theme: 7 } }).revision, {
      theme: 7,
    });

    const w = world("theme", theme.empty);
    const r = recorder();
    await w.sync.initialSync(r.client);
    assert.ok(r.asked().includes("theme"));
  });

  it("a theme set on one device reaches another on its next sign-in", async () => {
    // desktop: an edit, uploaded
    const desktop = world("theme", theme.empty, { theme: 5_000 });
    set(desktop)("theme", "slogaAccent", "#ff0000");
    set(desktop)("theme", "mode", "light");
    set(desktop)("theme", "messageSize", 20);
    const up = recorder();
    await desktop.sync.save(up.client);
    const [ts, data] = [
      up.sent[0].timestamp as number,
      up.sent[0].theme as string,
    ];

    // phone: never synced the theme, smaller text of its own
    const phone = world(
      "theme",
      { ...structuredClone(theme.empty), messageSize: 12 },
      olderDisk("theme"),
    );
    await phone.sync.initialSync(recorder({ theme: [ts, data] }).client);

    const got = phone.data();
    assert.equal(got.slogaAccent, "#ff0000");
    assert.equal(got.mode, "light");
    assert.equal(got.messageSize, 12, "took the desktop's text size");
    assert.equal(phone.revision(), ts);
    assert.equal(phone.sync.shouldSync, false, "echoed the theme back");
  });

  it("uploads without the device-local fields", async () => {
    const w = world("theme", theme.empty, { theme: 5_000 });
    set(w)("theme", { ...structuredClone(theme.remote), messageSize: 20 });
    assert.equal(w.sync.shouldSync, true);

    const r = recorder();
    await w.sync.save(r.client);

    const uploaded = JSON.parse(r.sent[0].theme as string);
    for (const field of DEVICE_LOCAL) {
      assert.ok(!(field in uploaded), `uploaded ${field}`);
    }
    assert.ok(!("knownFields" in uploaded), "uploaded knownFields");
    assert.equal(uploaded.m3Accent, theme.remote.m3Accent);
    assert.equal(uploaded.presetMigrated, true);
    // the store itself keeps them
    assert.equal(w.data().messageSize, 20);
  });

  it("adopting a remote copy keeps this device's sizes and blur", () => {
    const local = {
      ...structuredClone(theme.empty),
      blur: false,
      messageSize: 20,
      messageGroupSpacing: 4,
      messageAvatarSize: 48,
    };
    const w = world("theme", local, { theme: 5_000 });

    // a copy that carries device-local fields of its own still loses them
    w.sync.merge(
      9_000,
      "theme",
      JSON.stringify({ ...theme.remote, blur: true, messageSize: 11 }),
    );

    const data = w.data();
    for (const field of DEVICE_LOCAL) {
      assert.equal(data[field], local[field as keyof typeof local], field);
    }
    assert.equal(data.m3Accent, theme.remote.m3Accent);
    assert.equal(data.mode, "light");
    assert.equal(w.revision(), 9_000);
    assert.equal(w.sync.shouldSync, false);
  });

  it("an older remote differing only in device-local fields is left alone", () => {
    const local = { ...structuredClone(theme.remote), messageSize: 20 };
    const w = world("theme", local, { theme: 5_000 });

    w.sync.merge(1_000, "theme", JSON.stringify(syncedPart(theme.remote)));

    assert.equal(w.sync.shouldSync, false, "re-uploaded an equal theme");
    assert.equal(w.revision(), 5_000);
  });

  it("editing a device-local field queues nothing; a synced field does", () => {
    const w = world("theme", theme.empty, { theme: 5_000 });
    set(w)("theme", "messageSize", 18);
    set(w)("theme", "messageAvatarSize", 40);
    set(w)("theme", "messageGroupSpacing", 2);
    set(w)("theme", "blur", false);
    assert.equal(w.sync.shouldSync, false);
    assert.equal(w.revision(), 5_000);

    set(w)("theme", "slogaAccent", "#ff0000");
    assert.equal(w.sync.shouldSync, true);
    assert.ok((w.revision() ?? 0) > 5_000);
  });

  it("ignores a remote copy in another format (Revite's theme key)", () => {
    const w = world("theme", theme.remote, { theme: 5_000 });
    const revite = { "appearance:theme:base": "light", custom: {} };

    for (const copy of [revite, null, [], "x", { ...theme.remote }]) {
      if (copy !== null && typeof copy === "object" && "preset" in copy) {
        delete (copy as Record<string, unknown>).presetMigrated;
      }
      const merged = w.sync.merge(9_000, "theme", JSON.stringify(copy));
      assert.equal(merged, false, JSON.stringify(copy));
    }

    assert.deepEqual(w.data(), theme.remote);
    assert.equal(w.revision(), 5_000);
    assert.equal(w.sync.shouldSync, false);
  });

  describe("first sync on an account with no theme copy", () => {
    it("seeds it from a device whose theme was customized", async () => {
      const w = world("theme", theme.remote, olderDisk("theme"));
      assert.equal(w.revision(), undefined, "precondition: never synced");

      const r = recorder();
      await w.sync.initialSync(r.client);
      assert.equal(w.sync.shouldSync, true);

      await w.sync.save(r.client);
      assert.deepEqual(
        JSON.parse(r.sent[0].theme as string),
        syncedPart(theme.remote),
      );
    });

    it("seeds nothing from a device on the default theme", async () => {
      // sizes are not part of the account's theme, so changing them alone
      // does not count as customizing it
      const w = world(
        "theme",
        { ...structuredClone(theme.empty), messageSize: 20, blur: false },
        olderDisk("theme"),
      );
      await w.sync.initialSync(recorder().client);
      assert.equal(w.sync.shouldSync, false);
    });

    it("seeds nothing from an untouched install with the legacy m3 accent", async () => {
      const legacy = { ...structuredClone(theme.empty), m3Accent: "#FF5733" };
      const w = world("theme", legacy, olderDisk("theme"));
      await w.sync.initialSync(recorder().client);
      assert.equal(w.sync.shouldSync, false);

      // the same accent under Material You is on screen, so it counts
      const you = world(
        "theme",
        { ...legacy, preset: "you" },
        olderDisk("theme"),
      );
      await you.sync.initialSync(recorder().client);
      assert.equal(you.sync.shouldSync, true);
    });

    it("treats a copy in another format as no copy", async () => {
      const w = world("theme", theme.remote, olderDisk("theme"));
      const r = recorder({
        theme: [9_000, JSON.stringify({ "appearance:theme:base": "light" })],
      });
      await w.sync.initialSync(r.client);

      assert.deepEqual(w.data(), theme.remote);
      assert.equal(w.sync.shouldSync, true);
    });

    it("an account that has a copy is adopted, not seeded over", async () => {
      const w = world("theme", theme.remote, olderDisk("theme"));
      const r = recorder({
        theme: [1_000, JSON.stringify(syncedPart(theme.empty))],
      });
      await w.sync.initialSync(r.client);

      assert.deepEqual(w.data(), theme.empty);
      assert.equal(w.revision(), 1_000);
      assert.equal(w.sync.shouldSync, false);
    });
  });

  describe("a copy from an older client", () => {
    /** As a client from before `style` and the backgrounds uploads it */
    function older(data: Record<string, unknown>) {
      const copy = syncedPart(data);
      delete copy.style;
      delete copy.slogaSurfaceDark;
      delete copy.slogaSurfaceLight;
      return copy;
    }

    const customized = {
      ...structuredClone(theme.empty),
      style: "classic",
      slogaSurfaceDark: "#000000",
      slogaSurfaceLight: "#f7f5f0",
      knownFields: [...NEWER],
    };

    /**
     * The store here merges writes, so a field missing from the adopted copy
     * would survive in it whatever merge() did; the real clean() fills every
     * missing field with its default. So read what clean() is handed.
     */
    function spyClean(w: ReturnType<typeof world>) {
      const seen: { input: Record<string, unknown> } = { input: {} };
      (w.state.theme as { clean: (input: unknown) => unknown }).clean = (
        input,
      ) => (seen.input = input as Record<string, unknown>);
      return seen;
    }

    it("keeps this device's style and backgrounds, and takes the rest", () => {
      const w = world("theme", customized, { theme: 5_000 });
      const seen = spyClean(w);
      w.sync.merge(9_000, "theme", JSON.stringify(older(theme.remote)));

      const data = seen.input;
      assert.equal(data.style, "classic");
      assert.equal(data.slogaSurfaceDark, "#000000");
      assert.equal(data.slogaSurfaceLight, "#f7f5f0");
      assert.equal(data.mode, theme.remote.mode);
      assert.equal(data.m3Accent, theme.remote.m3Accent);
      assert.equal(w.revision(), 9_000);
      assert.equal(w.sync.shouldSync, false);
    });

    it("a copy that carries them wins as usual", () => {
      const w = world("theme", customized, { theme: 5_000 });
      const seen = spyClean(w);
      w.sync.merge(
        9_000,
        "theme",
        JSON.stringify(syncedPart({ ...theme.remote, slogaSurfaceDark: "" })),
      );

      const data = seen.input;
      assert.equal(data.style, "modern");
      assert.equal(data.slogaSurfaceDark, "");
    });

    it("a device that never synced takes it as is", () => {
      const w = world("theme", customized, olderDisk("theme"));
      assert.equal(w.revision(), undefined, "precondition: never synced");

      const seen = spyClean(w);
      w.sync.merge(1_000, "theme", JSON.stringify(older(theme.remote)));
      const cleaned = seen.input;

      assert.equal(cleaned.mode, theme.remote.mode, "precondition: merged");
      assert.ok(!("style" in cleaned), "kept a never-synced device's style");
      assert.ok(!("slogaSurfaceDark" in cleaned));
      assert.ok(!("slogaSurfaceLight" in cleaned));
      assert.deepEqual(cleaned.knownFields, [], "knows fields it never had");
    });

    it("adopting a copy that carries a field makes it known here", () => {
      const w = world("theme", theme.empty, { theme: 5_000 });
      const seen = spyClean(w);
      w.sync.merge(9_000, "theme", JSON.stringify(syncedPart(theme.remote)));
      assert.deepEqual(seen.input.knownFields, NEWER);
    });

    it("a field this device only has the default for is not uploaded", async () => {
      const w = world("theme", theme.empty, { theme: 5_000 });
      set(w)("theme", "mode", "light");
      const r = recorder();
      await w.sync.save(r.client);

      const uploaded = JSON.parse(r.sent[0].theme as string);
      assert.equal(uploaded.mode, "light", "precondition: uploaded");
      for (const field of NEWER) {
        assert.ok(!(field in uploaded), `uploaded the default ${field}`);
      }
    });

    it("a picked value is uploaded even when it equals the default", async () => {
      const w = world(
        "theme",
        { ...structuredClone(theme.empty), knownFields: ["style"] },
        { theme: 5_000 },
      );
      set(w)("theme", "mode", "light");
      const r = recorder();
      await w.sync.save(r.client);

      const uploaded = JSON.parse(r.sent[0].theme as string);
      assert.equal(uploaded.style, "modern");
      assert.ok(!("slogaSurfaceDark" in uploaded));
    });

    it("a device that updated after adopting an older copy cannot wipe a peer's picks", async () => {
      // the peer picked Classic on black, and synced it
      const peer = world("theme", customized, { theme: 5_000 });

      // this device adopted an older client's copy (none of the fields),
      // then updated: clean() gave it the defaults, and none is known
      const updated = world("theme", theme.empty, { theme: 6_000 });
      set(updated)("theme", "mode", "light");
      const r = recorder();
      await updated.sync.save(r.client);
      const [ts, data] = [r.sent[0].timestamp as number, r.sent[0].theme];

      const seen = spyClean(peer);
      peer.sync.merge(ts, "theme", data as string);

      assert.equal(seen.input.mode, "light", "precondition: adopted");
      assert.equal(seen.input.style, "classic");
      assert.equal(seen.input.slogaSurfaceDark, "#000000");
      assert.equal(seen.input.slogaSurfaceLight, "#f7f5f0");
      assert.deepEqual(seen.input.knownFields, NEWER);
    });

    it("the backgrounds do not count towards seeding under Material You", () => {
      const view = mod.seedView("theme", {
        ...customized,
        preset: "you",
      }) as Record<string, unknown>;
      assert.ok(!("slogaSurfaceDark" in view));
      assert.ok(!("slogaSurfaceLight" in view));
      assert.equal(view.style, "classic");

      const sloga = mod.seedView("theme", customized) as Record<
        string,
        unknown
      >;
      assert.equal(sloga.slogaSurfaceDark, "#000000");
    });
  });

  describe("untracked()", () => {
    it("writes without a revision or an upload, and a later edit still goes out", () => {
      const w = world("theme", theme.empty, olderDisk("theme"));
      w.sync.untracked("theme", () => set(w)("theme", "mode", "light"));

      assert.equal(w.data().mode, "light");
      assert.equal(w.revision(), undefined);
      assert.equal(w.sync.shouldSync, false);

      // the account's copy then wins on a fresh device
      w.sync.merge(1_000, "theme", JSON.stringify(syncedPart(theme.remote)));
      assert.equal(w.data().mode, theme.remote.mode);

      set(w)("theme", "mode", "dark");
      assert.equal(w.sync.shouldSync, true);
    });

    it("spends the block even when the write throws or does not touch", () => {
      const w = world("theme", theme.empty, olderDisk("theme"));
      assert.throws(() =>
        w.sync.untracked("theme", () => {
          throw new Error("write failed");
        }),
      );
      w.sync.untracked("theme", () => {});

      set(w)("theme", "mode", "light");
      assert.equal(w.sync.shouldSync, true);
    });
  });
});

/**
 * A theme copy as another device uploads it: no device-local fields, and only
 * the newer fields that device knows (`themeFields.ts`)
 */
function syncedPart(data: Record<string, unknown>) {
  const copy = structuredClone(data);
  const known = (copy.knownFields as string[] | undefined) ?? [];
  for (const field of NEWER) if (!known.includes(field)) delete copy[field];
  for (const field of DEVICE_LOCAL) delete copy[field];
  delete copy.knownFields;
  return copy;
}

describe("Sync.forget()", () => {
  /** A world with a "friends" edit and a "friend-groups" edit both queued */
  function queued() {
    const w = world("friend-groups", KEYS["friend-groups"].empty, {
      ...olderDisk("friend-groups"),
      "friend-groups": 5_000,
    });
    const set = w.state.set as (...args: unknown[]) => void;
    set("friends", structuredClone(KEYS.friends.remote));
    set("friend-groups", structuredClone(KEYS["friend-groups"].remote));
    assert.equal(w.sync.shouldSync, true);

    const sent: Record<string, unknown>[] = [];
    const client = {
      api: {
        post: async (route: string, body: Record<string, unknown>) => {
          assert.equal(route, "/sync/settings/set");
          sent.push(body);
        },
      },
    };
    return { ...w, sent, client };
  }

  it("drops a queued key from the next upload and keeps the others", async () => {
    const w = queued();
    const before = w.revision();

    w.sync.forget(["friend-groups"]);
    assert.equal(w.sync.shouldSync, true, "dropped the other queued key");

    await w.sync.save(w.client as never);

    assert.equal(w.sent.length, 1);
    assert.ok(!("friend-groups" in w.sent[0]), "uploaded a forgotten key");
    assert.equal(w.sent[0].friends, JSON.stringify(KEYS.friends.remote));
    // save() stamps the keys it sends; a forgotten key is not one of them
    assert.equal(w.revision(), before);
    assert.equal(w.sync.shouldSync, false);
  });

  it("leaves nothing to save once every queued key is forgotten", () => {
    const w = queued();
    w.sync.forget(["friends", "friend-groups"]);
    assert.equal(w.sync.shouldSync, false);
  });

  it("is a no-op for keys that are not queued", async () => {
    const w = queued();
    w.sync.forget(["ordering", "notifications"]);

    await w.sync.save(w.client as never);

    assert.deepEqual(Object.keys(w.sent[0]).sort(), [
      "friend-groups",
      "friends",
      "timestamp",
    ]);
  });
});

describe("Sync owner", () => {
  it("is absent by default", () => {
    assert.ok(!("owner" in new Sync({} as never).default()));
  });

  it("clean() keeps a user id and leaves out anything else", () => {
    const sync = new Sync({} as never);
    const id = "01HZXKJ6V8Q4M3T7B9C2D5E0FA";
    assert.equal(sync.clean({ revision: {}, owner: id }).owner, id);
    const longest = "x".repeat(64);
    assert.equal(sync.clean({ revision: {}, owner: longest }).owner, longest);

    for (const owner of ["", "x".repeat(65), 42, null, {}, undefined]) {
      const clean = sync.clean({ revision: {}, owner } as never);
      assert.ok(!("owner" in clean), JSON.stringify(owner));
    }
  });

  it("setOwner() records it without queuing an upload", () => {
    const w = world("friends", KEYS.friends.empty);
    assert.equal(w.sync.owner, undefined);
    w.sync.setOwner("u-a");
    assert.equal(w.sync.owner, "u-a");
    assert.equal(w.sync.shouldSync, false);
  });
});

describe("Sync.reset()", () => {
  for (const key of Object.keys(KEYS) as Key[]) {
    it(`puts "${key}" back as never synced, with no upload queued`, () => {
      const { empty, remote } = KEYS[key];
      const w = world(key, empty, { ...olderDisk(key), [key]: 5_000 });
      const set = w.state.set as (...args: unknown[]) => void;
      set(key, structuredClone(remote));
      assert.equal(w.sync.shouldSync, true);

      w.sync.reset([key]);

      assert.deepEqual(w.data(), empty);
      assert.equal(w.revision(), undefined);
      assert.equal(w.sync.shouldSync, false, "queued an upload");

      // the next account's remote copy is adopted, not overwritten
      w.sync.merge(1_000, key, JSON.stringify(remote));
      assert.deepEqual(w.data(), remote);
      assert.equal(w.sync.shouldSync, false);

      // and the sync block is spent: a real edit still goes out
      set(key, structuredClone(empty));
      assert.equal(w.sync.shouldSync, true);
    });
  }
});

describe("Sync.initialSync() stale responses", () => {
  /** A client whose settings fetch resolves when the spec says so */
  function deferredClient(data: Record<string, [number, string]>) {
    let respond!: () => void;
    const answered = new Promise<void>((resolve) => (respond = resolve));
    const client = {
      api: {
        post: async () => {
          await answered;
          return data;
        },
      },
    };
    return { client: client as never, respond };
  }

  const groups = KEYS["friend-groups"];
  const response: Record<string, [number, string]> = {
    "friend-groups": [1_000, JSON.stringify(groups.remote)],
  };

  it("drops a response that lands after the owner changed", async () => {
    const w = world("friend-groups", groups.empty);
    w.sync.setOwner("u-a");
    const { client, respond } = deferredClient(response);

    const pending = w.sync.initialSync(client);
    w.sync.setOwner("u-b");
    respond();
    await pending;

    assert.deepEqual(w.data(), groups.empty, "adopted the old account's data");
    assert.equal(w.revision(), 0);
    assert.equal(w.sync.shouldSync, false);
  });

  it("drops a response once its session is no longer current", async () => {
    const w = world("friend-groups", groups.empty);
    w.sync.setOwner("u-a");
    const { client, respond } = deferredClient(response);
    let current = true;

    const pending = w.sync.initialSync(client, () => current);
    current = false;
    respond();
    await pending;

    assert.deepEqual(w.data(), groups.empty, "adopted an ended session's data");
    assert.equal(w.revision(), 0);
  });

  it("drops a signed-out session's response and keeps the local edits", async () => {
    const w = world("friend-groups", groups.empty, {
      ...olderDisk("friend-groups"),
      "friend-groups": 5_000,
    });
    w.sync.setOwner("u-a");
    const set = w.state.set as (...args: unknown[]) => void;
    set("friend-groups", structuredClone(groups.remote));
    const edited = w.revision();
    assert.equal(w.sync.shouldSync, true, "precondition: an edit queued");

    // a newer remote copy, which a current session would adopt
    const { client, respond } = deferredClient({
      "friend-groups": [Date.now() + 60_000, JSON.stringify(groups.empty)],
    });
    let signedIn = true;
    const pending = w.sync.initialSync(client, () => signedIn);
    // sign-out keeps the owner; only the session ends
    signedIn = false;
    respond();
    await pending;

    assert.equal(w.sync.owner, "u-a");
    assert.deepEqual(w.data(), groups.remote, "an ended session overwrote");
    assert.equal(w.revision(), edited);
    assert.equal(w.sync.shouldSync, true, "dropped the queued edit");
  });

  it("the same account signing out and in merges only the new session's response", async () => {
    const w = world("friend-groups", groups.empty);
    w.sync.setOwner("u-a");
    let session = 1;

    const first = deferredClient({
      "friend-groups": [Date.now() + 60_000, JSON.stringify(groups.empty)],
    });
    const pending1 = w.sync.initialSync(first.client, () => session === 1);

    // same account again: the owner is unchanged, the session is not
    session = 2;
    const second = deferredClient(response);
    const pending2 = w.sync.initialSync(second.client, () => session === 2);
    second.respond();
    await pending2;

    assert.deepEqual(w.data(), groups.remote);
    assert.equal(w.revision(), 1_000);

    // the first session's fetch lands last, with a newer revision
    first.respond();
    await pending1;

    assert.equal(w.sync.owner, "u-a");
    assert.deepEqual(w.data(), groups.remote, "the ended session's data won");
    assert.equal(w.revision(), 1_000);
    assert.equal(w.sync.shouldSync, false);
  });

  it("merges a response for the same, current session", async () => {
    const w = world("friend-groups", groups.empty);
    w.sync.setOwner("u-a");
    const { client, respond } = deferredClient(response);

    const pending = w.sync.initialSync(client, () => true);
    respond();
    await pending;

    assert.deepEqual(w.data(), groups.remote);
    assert.equal(w.revision(), 1_000);
  });
});
