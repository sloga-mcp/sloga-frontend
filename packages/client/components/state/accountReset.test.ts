/**
 * Run with:
 *
 *     node --conditions=browser --test components/state/accountReset.test.ts
 *
 * Covers `./accountReset.ts`: the synced friend stores and theme, their
 * revisions and
 * the chat-window layout belong to the account recorded as `Sync.owner`, and
 * a different account signing in gets them reset before any sync runs.
 *
 * Both `./accountReset.ts` and the real `./stores/Sync.ts` are loaded through
 * `module.registerHooks`, as `./stores/Sync.merge.test.ts` documents. Their
 * app imports are stood in for: `localforage` records the disk writes and
 * `../chatWindows/chatWindowsStore` counts the resets. `State` is a real
 * solid store whose `set` touches syncable keys, as `State.write()` does.
 *
 * Known-bad control: point `ACCOUNT_RESET_UNDER_TEST` (or `SYNC_UNDER_TEST`)
 * at an absolute path to another copy. A copy whose `ensureAccountOwner`
 * never resets, or resets the friend stores but not the theme, fails the
 * account-switch specs; one that also resets for an
 * unknown owner fails the upgrade spec; one that resets for the same owner
 * fails the same-account spec. A copy that writes the reset data before
 * `sync` (the order this file had before the crash-order fix) fails the
 * write-order spec, and one without `shouldPersistKey`, or whose helper lets
 * the popout write `sync` or a synced store, fails the popout specs. A
 * `Sync.ts` whose `reset()` drops the sync block fails "queues nothing",
 * and one whose `initialSync` lost its stale-response check fails the
 * late-response spec.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { createStore, unwrap } from "solid-js/store";

const underTest = (env: string | undefined, sibling: string) =>
  env ? pathToFileURL(env).href : new URL(sibling, import.meta.url).href;

const RESET_URL = underTest(
  process.env.ACCOUNT_RESET_UNDER_TEST,
  "./accountReset.ts",
);
const SYNC_URL = underTest(process.env.SYNC_UNDER_TEST, "./stores/Sync.ts");

const reexport = (names: string, specifier: string) =>
  `export { ${names} } from ${JSON.stringify(import.meta.resolve(specifier))};`;

/** What the stand-ins observed, reset before every spec */
type Observed = {
  writes: { key: string; value: unknown }[];
  chatResets: number;
  chatResetThrows: boolean;
};
const observed: Observed = {
  writes: [],
  chatResets: 0,
  chatResetThrows: false,
};
(globalThis as Record<string, unknown>).__accountResetSpec = observed;

const STUBS: Record<string, Record<string, string>> = {
  [RESET_URL]: {
    localforage: `export default {
      setItem: async (key, value) => {
        globalThis.__accountResetSpec.writes.push({ key, value });
        return value;
      },
    };`,
    "../chatWindows/chatWindowsStore": `export function resetChatWindows() {
      const o = globalThis.__accountResetSpec;
      if (o.chatResetThrows) throw new Error("chat windows unavailable");
      o.chatResets++;
    }`,
  },
  [SYNC_URL]: {
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
  },
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? "";
    if (STUBS[parent] && specifier in STUBS[parent]) {
      return {
        url: `account-reset-test:${encodeURIComponent(parent)}|${specifier}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("account-reset-test:")) {
      const [parent, specifier] = url
        .slice("account-reset-test:".length)
        .split("|");
      return {
        format: "module",
        shortCircuit: true,
        source: STUBS[decodeURIComponent(parent)][specifier],
      };
    }
    const loaded = nextLoad(url, context);
    if (url !== SYNC_URL && url !== RESET_URL) return loaded;
    return {
      ...loaded,
      source: `${String(loaded.source)}\n;import.meta.env ??= { DEV: false };\n`,
    };
  },
});

const resetModule = await import(RESET_URL);
const { ensureAccountOwner, resetAccountLocalState } = resetModule;
const { Sync } = await import(SYNC_URL);

/** A stand-in theme; Sync only needs its own format marker and the sizes */
const THEME = {
  preset: "stoat",
  presetMigrated: true,
  mode: "dark",
  slogaAccent: "#5470ec",
  blur: true,
  messageSize: 14,
  messageGroupSpacing: 12,
  messageAvatarSize: 36,
};

const DEFAULTS = {
  friends: { favourites: [], collapsed: [] },
  "friend-groups": { groups: [], members: {} },
  "home-layout": { main: ["unread"], side: ["friends"], hidden: [] },
  theme: THEME,
};

const ACCOUNT_A = {
  friends: { favourites: ["friend-of-a"], collapsed: ["online"] },
  "friend-groups": {
    groups: [{ id: "g1", name: "A's raid night", order: 0 }],
    members: { g1: ["friend-of-a"] },
  },
  "home-layout": { main: ["friends"], side: ["unread"], hidden: ["unread"] },
  theme: { ...THEME, mode: "light", slogaAccent: "#ff5733" },
};

const ACCOUNT_B = {
  friends: { favourites: ["friend-of-b"], collapsed: [] },
  "friend-groups": {
    groups: [{ id: "g9", name: "B's book club", order: 0 }],
    members: { g9: ["friend-of-b"] },
  },
  "home-layout": { main: ["unread", "friends"], side: [], hidden: [] },
  theme: { ...THEME, slogaAccent: "#9bf088" },
};

type Key = keyof typeof DEFAULTS;
const KEYS = Object.keys(DEFAULTS) as Key[];

/**
 * A device last used by `owner`, holding `data` with revisions at 5_000
 * @param owner Recorded owner, if any
 * @param data Friend stores on the device
 */
function device(owner: string | undefined, data = ACCOUNT_A) {
  const [store, setStore] = createStore<Record<string, unknown>>({
    sync: new Sync({} as never).default(),
    ...structuredClone(data),
  });

  const state: Record<string, unknown> = {
    get: (k: string) => store[k],
    // State.write(): every write touches the key if it is syncable
    set: (...args: unknown[]) => {
      (setStore as unknown as (...args: unknown[]) => void)(...args);
      sync.touchIfSyncable(args[0] as string, args[1]);
    },
  };
  for (const key of KEYS) {
    state[key] = {
      clean: (input: unknown) => input,
      get: () => store[key],
      default: () => structuredClone(DEFAULTS[key]),
    };
  }

  const sync = new Sync(state as never);
  state.sync = sync;

  // State.hydrate(): the disk copy goes through clean() and then setStore
  setStore(
    "sync",
    sync.clean({
      revision: {
        ordering: 4_000,
        friends: 5_000,
        "friend-groups": 5_000,
        "home-layout": 5_000,
        theme: 5_000,
      },
      owner,
    }),
  );

  // a local edit to each friend store, still waiting to upload
  const set = state.set as (...args: unknown[]) => void;
  for (const key of KEYS) set(key, structuredClone(data[key]));
  observed.writes.length = 0;

  return {
    state,
    sync,
    data: (key: Key) => structuredClone(unwrap(store[key])),
    revision: (key: string) =>
      (store.sync as { revision: Record<string, number | undefined> }).revision[
        key
      ],
  };
}

/** What the next save() would upload */
async function nextUpload(d: ReturnType<typeof device>) {
  const sent: Record<string, unknown>[] = [];
  if (d.sync.shouldSync) {
    await d.sync.save({
      api: { post: async (_: string, body: never) => sent.push(body) },
    } as never);
  }
  return sent;
}

beforeEach(() => {
  observed.writes.length = 0;
  observed.chatResets = 0;
  observed.chatResetThrows = false;
});

describe("ensureAccountOwner()", () => {
  it("a different account gets the friend stores reset, with nothing uploaded", async () => {
    const d = device("user-a");
    assert.equal(d.sync.shouldSync, true, "precondition: A's edits queued");
    const revisionsBefore = d.revision("friends");

    assert.equal(ensureAccountOwner(d.state, "user-b"), true);

    for (const key of KEYS) {
      assert.deepEqual(d.data(key), DEFAULTS[key], `${key} kept A's data`);
      assert.equal(d.revision(key), undefined, `${key} kept A's revision`);
    }
    assert.ok(revisionsBefore);
    assert.equal(d.sync.owner, "user-b");
    assert.equal(observed.chatResets, 1);
    assert.deepEqual(await nextUpload(d), [], "queued an upload to B");

    // the other synced stores are left alone
    assert.equal(d.revision("ordering"), 4_000);
  });

  it("B's own remote copy is then adopted as is, not overwritten", async () => {
    const d = device("user-a");
    ensureAccountOwner(d.state, "user-b");

    for (const key of KEYS) {
      d.sync.merge(1_000, key, JSON.stringify(ACCOUNT_B[key]));
      assert.deepEqual(d.data(key), ACCOUNT_B[key]);
    }
    assert.deepEqual(await nextUpload(d), []);
  });

  it("writes cleared revisions under the old owner, then the data, then the new owner", () => {
    const d = device("user-a");
    ensureAccountOwner(d.state, "user-b");

    type DiskSync = { owner?: string; revision: Record<string, unknown> };
    const keys = observed.writes.map((w) => w.key);
    assert.equal(keys[0], "sync", `first write: ${keys}`);
    const first = observed.writes[0].value as DiskSync;
    assert.equal(first.owner, "user-a", "cleared revisions under a new owner");
    for (const key of KEYS) assert.equal(first.revision[key], undefined, key);

    const last = observed.writes.length - 1;
    assert.equal(keys[last], "sync", `last write: ${keys}`);
    assert.equal((observed.writes[last].value as DiskSync).owner, "user-b");
    for (const key of KEYS) {
      const at = keys.indexOf(key);
      assert.ok(at > 0 && at < last, `${key} at ${at}: ${keys}`);
      assert.deepEqual(observed.writes[at].value, DEFAULTS[key]);
    }
  });

  it("leaves a usable disk wherever a crash cuts the writes off", () => {
    const d = device("user-a");
    ensureAccountOwner(d.state, "user-b");
    const writes = [...observed.writes];

    type DiskSync = { owner?: string; revision: Record<string, unknown> };
    for (let n = 0; n <= writes.length; n++) {
      // what A's session left on disk, then the first n writes
      const disk: Record<string, unknown> = {
        ...structuredClone(ACCOUNT_A),
        sync: {
          revision: {
            ordering: 4_000,
            friends: 5_000,
            "friend-groups": 5_000,
            theme: 5_000,
          },
          owner: "user-a",
        },
      };
      for (const w of writes.slice(0, n)) disk[w.key] = w.value;
      const sync = disk.sync as DiskSync;
      const at = `after ${n} of ${writes.map((w) => w.key)}`;

      for (const key of KEYS) {
        if (sync.owner !== "user-a") {
          // the new owner keeps whatever is on disk: it must be no-one's
          assert.deepEqual(disk[key], DEFAULTS[key], `A's ${key} for B, ${at}`);
        }
        if (sync.revision[key] !== undefined) {
          // a live revision must still cover A's own data, or A signing back
          // in would upload the defaults over A's remote copy
          assert.deepEqual(
            disk[key],
            ACCOUNT_A[key],
            `defaults revised, ${at}`,
          );
        }
      }
    }
  });

  it("the same account keeps its data and its queued edits", async () => {
    const d = device("user-a");

    assert.equal(ensureAccountOwner(d.state, "user-a"), true);

    for (const key of KEYS) {
      assert.deepEqual(d.data(key), ACCOUNT_A[key]);
    }
    assert.equal(observed.chatResets, 0);
    assert.deepEqual(observed.writes, []);
    const sent = await nextUpload(d);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].friends, JSON.stringify(ACCOUNT_A.friends));
  });

  it("an unknown owner (upgraded device) is recorded without a reset", () => {
    const d = device(undefined);
    const before = d.revision("friend-groups");

    assert.equal(ensureAccountOwner(d.state, "user-a"), true);

    assert.equal(d.sync.owner, "user-a");
    assert.deepEqual(d.data("friend-groups"), ACCOUNT_A["friend-groups"]);
    assert.equal(d.revision("friend-groups"), before);
    assert.equal(observed.chatResets, 0);
    assert.equal(d.sync.shouldSync, true);
  });

  it("refuses without a user id and changes nothing", () => {
    for (const id of [undefined, ""]) {
      const d = device("user-a");
      assert.equal(ensureAccountOwner(d.state, id), false);
      assert.equal(d.sync.owner, "user-a");
      assert.deepEqual(d.data("friends"), ACCOUNT_A.friends);
      assert.equal(observed.chatResets, 0);
    }
  });

  it("a failed reset leaves the old owner, so the next session resets again", () => {
    const d = device("user-a");
    observed.chatResetThrows = true;

    assert.throws(() => ensureAccountOwner(d.state, "user-b"));
    assert.equal(d.sync.owner, "user-a");

    observed.chatResetThrows = false;
    assert.equal(ensureAccountOwner(d.state, "user-b"), true);
    assert.equal(observed.chatResets, 1);
    assert.equal(d.sync.owner, "user-b");
  });
});

describe("resetAccountLocalState()", () => {
  it("resets the friend stores and chat windows without an upload", async () => {
    const d = device("user-a");
    resetAccountLocalState(d.state);

    for (const key of KEYS) assert.deepEqual(d.data(key), DEFAULTS[key]);
    assert.equal(observed.chatResets, 1);
    assert.deepEqual(await nextUpload(d), []);
  });
});

describe("shouldPersistKey()", () => {
  const SYNCED = Object.keys(new Sync({} as never).default().revision);

  /** The module under test's helper, failing clearly when it is missing */
  function persists(key: string, isPopout: boolean): boolean {
    assert.equal(
      typeof resetModule.shouldPersistKey,
      "function",
      "the module under test exports no shouldPersistKey",
    );
    return resetModule.shouldPersistKey(key, isPopout, SYNCED);
  }

  it("the friends popout writes neither sync nor any synchronised store", () => {
    // precondition: the list State passes in is Sync's full revision map
    for (const key of ["friends", "friend-groups", "theme", "ordering"]) {
      assert.ok(SYNCED.includes(key), `${key} missing from ${SYNCED}`);
    }
    for (const key of [...SYNCED, "sync"]) {
      assert.equal(persists(key, true), false, key);
    }
  });

  it("the friends popout still writes its device-local keys", () => {
    for (const key of ["auth", "settings", "layout", "draft"]) {
      assert.equal(persists(key, true), true, key);
    }
  });

  it("every other window writes every key", () => {
    for (const key of [...SYNCED, "sync", "auth", "settings", "layout"]) {
      assert.equal(persists(key, false), true, key);
    }
  });
});

describe("a late settings fetch from the previous account", () => {
  it("is dropped once another account has signed in", async () => {
    const d = device("user-a");
    let respond!: () => void;
    const answered = new Promise<void>((resolve) => (respond = resolve));
    const clientA = {
      api: {
        post: async () => {
          await answered;
          return Object.fromEntries(
            KEYS.map((key) => [key, [9_000, JSON.stringify(ACCOUNT_A[key])]]),
          );
        },
      },
    };

    // A's first sync is still in flight when B signs in on the same device
    const pending = d.sync.initialSync(clientA as never);
    ensureAccountOwner(d.state, "user-b");
    respond();
    await pending;

    for (const key of KEYS) {
      assert.deepEqual(d.data(key), DEFAULTS[key], `${key} took A's data`);
      assert.equal(d.revision(key), undefined);
    }
    assert.deepEqual(await nextUpload(d), []);
  });
});
