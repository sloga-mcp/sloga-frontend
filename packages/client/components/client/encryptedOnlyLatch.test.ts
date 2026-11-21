// Unit spec for the Encrypted-only latch. Run with Node's built-in runner
// from packages/client:
//   node --test --conditions=browser components/client/encryptedOnlyLatch.test.ts
// Declared test count: 34 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: the storage keys and values are exact; the server saying "on" sets
// the latch; the server saying "off" or nothing never clears it and reports
// the mismatch; only `clearLatch` clears; the latch, its time and the memory
// of peers and groups survive a reload; a corrupted memory list reads as
// empty; storage that is missing or throws never reaches the caller, and a
// value this page already knows keeps holding; the memory is parsed only
// when the stored string changes; the bound session account keeps a client
// latched whatever Ready says; confirming a changed peer forgets it.
//
// The module keeps state for the page's life, so a "reload" is a fresh copy
// (`fresh`, a query-string import Node keys as a new module) over the same
// fake storage.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { createComputed, createRoot } from "solid-js";

import type * as Latch from "./encryptedOnlyLatch.ts";

const ME = "01USERAAAAAAAAAAAAAAAAAAAA";
const OTHER = "01USERBBBBBBBBBBBBBBBBBBBB";
const PEER = "01PEERAAAAAAAAAAAAAAAAAAAA";
const GROUP = "01GROUPAAAAAAAAAAAAAAAAAAA";

const LATCH_KEY = `e2ee-only:${ME}`;
const AT_KEY = `e2ee-only-at:${ME}`;
const SEEN_KEY = `e2ee-only-seen:${ME}`;

/** The fake `localStorage`: its contents and which calls throw. */
const store = {
  items: new Map<string, string>(),
  throwGet: false,
  throwSet: false,
  throwRemove: false,
};

const fakeStorage = {
  getItem(key: string): string | null {
    if (store.throwGet) throw new Error("getItem refused");
    return store.items.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    if (store.throwSet) throw new Error("quota exceeded");
    store.items.set(key, String(value));
  },
  removeItem(key: string): void {
    if (store.throwRemove) throw new Error("removeItem refused");
    store.items.delete(key);
  },
};

function installStorage(value: unknown): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value,
  });
}

beforeEach(() => {
  store.items.clear();
  store.throwGet = false;
  store.throwSet = false;
  store.throwRemove = false;
  installStorage(fakeStorage);
});

let copies = 0;

/** A copy of the module with its own state: a page load. */
async function fresh(): Promise<typeof Latch> {
  copies += 1;
  return (await import(
    `./encryptedOnlyLatch.ts?copy=${copies}`
  )) as typeof Latch;
}

// ---------------------------------------------------------------------------
// Keys and the plain transitions
// ---------------------------------------------------------------------------

test("the storage keys are the pinned ones", async () => {
  const latch = await fresh();
  assert.equal(latch.latchKey("abc"), "e2ee-only:abc");
  assert.equal(latch.seenKey("abc"), "e2ee-only-seen:abc");
  assert.equal(latch.latchedAtKey("abc"), "e2ee-only-at:abc");
  assert.equal(latch.LATCH_ON, "1");
});

test("the latch is off until something sets it", async () => {
  const latch = await fresh();
  assert.equal(latch.isLatched(ME), false);
  assert.equal(latch.latchedAt(ME), null);
  assert.deepEqual(latch.seenIds(ME), []);
  assert.equal(store.items.size, 0);
});

test("setLatch stores exactly 1 and the time beside it", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1700000000000);

  assert.equal(latch.isLatched(ME), true);
  assert.equal(latch.latchedAt(ME), 1700000000000);
  assert.equal(store.items.get(LATCH_KEY), "1");
  assert.equal(store.items.get(AT_KEY), "1700000000000");
  assert.equal(store.items.size, 2);
});

test("setting a latch that is already on keeps the first time", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1000);
  latch.setLatch(ME, 2000);
  assert.equal(latch.noteServerFlag(ME, true, 3000), false);

  assert.equal(latch.latchedAt(ME), 1000);
  assert.equal(store.items.get(AT_KEY), "1000");
});

test("the server saying on sets the latch", async () => {
  const latch = await fresh();
  assert.equal(latch.noteServerFlag(ME, true, 5000), false);

  assert.equal(latch.isLatched(ME), true);
  assert.equal(latch.latchedAt(ME), 5000);
  assert.equal(store.items.get(LATCH_KEY), "1");
});

test("the server saying off never clears, and reports the mismatch", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1000);

  assert.equal(latch.noteServerFlag(ME, false), true);
  assert.equal(latch.isLatched(ME), true);
  assert.equal(latch.latchedAt(ME), 1000);
  assert.equal(store.items.get(LATCH_KEY), "1");
  assert.equal(store.items.get(AT_KEY), "1000");
});

test("the server saying nothing never clears either", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1000);

  assert.equal(latch.noteServerFlag(ME, undefined), true);
  assert.equal(latch.noteServerFlag(ME, null), true);
  assert.equal(latch.isLatched(ME), true);
  assert.equal(store.items.get(LATCH_KEY), "1");
});

test("off or nothing from the server with the latch off does nothing", async () => {
  const latch = await fresh();

  assert.equal(latch.noteServerFlag(ME, false), false);
  assert.equal(latch.noteServerFlag(ME, undefined), false);
  assert.equal(latch.isLatched(ME), false);
  assert.equal(store.items.size, 0);
});

test("only clearLatch clears, and it keeps the memory", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1000);
  latch.rememberSeen(ME, PEER);

  latch.clearLatch(ME);

  assert.equal(latch.isLatched(ME), false);
  assert.equal(latch.latchedAt(ME), null);
  assert.equal(store.items.has(LATCH_KEY), false);
  assert.equal(store.items.has(AT_KEY), false);
  assert.equal(latch.isSeen(ME, PEER), true);
  assert.equal(latch.noteServerFlag(ME, false), false);
});

test("the server saying on after a clear sets it again with a new time", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1000);
  latch.clearLatch(ME);

  latch.noteServerFlag(ME, true, 9000);

  assert.equal(latch.isLatched(ME), true);
  assert.equal(latch.latchedAt(ME), 9000);
  assert.equal(store.items.get(AT_KEY), "9000");
});

test("each account has its own latch and memory", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1000);
  latch.rememberSeen(ME, PEER);

  assert.equal(latch.isLatched(OTHER), false);
  assert.equal(latch.latchedAt(OTHER), null);
  assert.equal(latch.isSeen(OTHER, PEER), false);

  latch.clearLatch(OTHER);
  assert.equal(latch.isLatched(ME), true);
});

test("no account id reads as off and writes nothing", async () => {
  const latch = await fresh();
  latch.setLatch(undefined, 1000);
  latch.setLatch("", 1000);
  latch.rememberSeen(undefined, PEER);
  latch.rememberSeen(ME, "");
  latch.rememberSeen(ME, undefined);
  latch.forgetSeen("", PEER);
  latch.clearLatch(undefined);

  assert.equal(latch.noteServerFlag(undefined, true), false);
  assert.equal(latch.isLatched(undefined), false);
  assert.equal(latch.isLatched(""), false);
  assert.equal(latch.latchedAt(undefined), null);
  assert.equal(latch.isSeen(undefined, PEER), false);
  assert.equal(latch.isSeen(ME, undefined), false);
  assert.deepEqual(latch.seenIds(undefined), []);
  assert.equal(store.items.size, 0);
});

// ---------------------------------------------------------------------------
// Memory of peers and groups
// ---------------------------------------------------------------------------

test("remember, ask and forget, stored as a JSON list", async () => {
  const latch = await fresh();
  latch.rememberSeen(ME, PEER);
  latch.rememberSeen(ME, GROUP);
  latch.rememberSeen(ME, PEER);

  assert.equal(latch.isSeen(ME, PEER), true);
  assert.equal(latch.isSeen(ME, GROUP), true);
  assert.equal(latch.isSeen(ME, "someone-else"), false);
  assert.deepEqual(latch.seenIds(ME), [PEER, GROUP]);
  assert.deepEqual(JSON.parse(store.items.get(SEEN_KEY)!), [PEER, GROUP]);

  latch.forgetSeen(ME, PEER);

  assert.equal(latch.isSeen(ME, PEER), false);
  assert.equal(latch.isSeen(ME, GROUP), true);
  assert.deepEqual(JSON.parse(store.items.get(SEEN_KEY)!), [GROUP]);

  // Forgetting something unknown changes nothing
  latch.forgetSeen(ME, "someone-else");
  assert.deepEqual(JSON.parse(store.items.get(SEEN_KEY)!), [GROUP]);
});

test("the memory does not depend on the latch", async () => {
  const latch = await fresh();
  latch.rememberSeen(ME, PEER);

  assert.equal(latch.isLatched(ME), false);
  assert.equal(latch.isSeen(ME, PEER), true);
  assert.equal(store.items.has(LATCH_KEY), false);
});

test("a corrupted memory list reads as empty and does not throw", async () => {
  for (const raw of [
    "{not json",
    "",
    "null",
    "42",
    '"' + PEER + '"',
    '{"' + PEER + '":true}',
  ]) {
    store.items.set(SEEN_KEY, raw);
    const latch = await fresh();

    assert.equal(latch.isSeen(ME, PEER), false, raw);
    assert.deepEqual(latch.seenIds(ME), [], raw);
  }

  // Entries that are not ids are dropped, the rest is kept
  store.items.set(SEEN_KEY, JSON.stringify([1, null, "", PEER, { a: 1 }]));
  const latch = await fresh();
  assert.deepEqual(latch.seenIds(ME), [PEER]);

  // The next write puts a clean list back
  store.items.set(SEEN_KEY, "{not json");
  latch.rememberSeen(ME, GROUP);
  assert.deepEqual(JSON.parse(store.items.get(SEEN_KEY)!), [GROUP]);
});

// ---------------------------------------------------------------------------
// Reload and other windows
// ---------------------------------------------------------------------------

test("the latch, its time and the memory survive a reload", async () => {
  const before = await fresh();
  before.setLatch(ME, 1234);
  before.rememberSeen(ME, PEER);
  before.rememberSeen(ME, GROUP);

  const after = await fresh();

  assert.equal(after.isLatched(ME), true);
  assert.equal(after.latchedAt(ME), 1234);
  assert.equal(after.isSeen(ME, PEER), true);
  assert.equal(after.isSeen(ME, GROUP), true);
  assert.equal(after.noteServerFlag(ME, false), true);
  assert.equal(after.isLatched(ME), true);
});

test("a cleared latch stays cleared after a reload", async () => {
  const before = await fresh();
  before.setLatch(ME, 1234);
  before.clearLatch(ME);

  const after = await fresh();
  assert.equal(after.isLatched(ME), false);
  assert.equal(after.latchedAt(ME), null);
});

test("only the exact value 1 counts as on", async () => {
  for (const raw of ["0", "true", "", " 1", "11", "on"]) {
    store.items.set(LATCH_KEY, raw);
    const latch = await fresh();
    assert.equal(latch.isLatched(ME), false, JSON.stringify(raw));
  }
});

test("a latch with no readable time counts every message as newer", async () => {
  for (const raw of [undefined, "", "soon", "NaN", "-5", "Infinity"]) {
    store.items.clear();
    store.items.set(LATCH_KEY, "1");
    if (raw !== undefined) store.items.set(AT_KEY, raw);

    const latch = await fresh();
    assert.equal(latch.isLatched(ME), true);
    assert.equal(latch.latchedAt(ME), 0, String(raw));
  }
});

test("a latch set in another window is seen, and one removed there is not", async () => {
  const latch = await fresh();
  assert.equal(latch.isLatched(ME), false);

  // Another window turns it on
  store.items.set(LATCH_KEY, "1");
  store.items.set(AT_KEY, "777");
  assert.equal(latch.isLatched(ME), true);
  assert.equal(latch.latchedAt(ME), 777);

  // Storage losing the key does not unlatch this page
  store.items.clear();
  assert.equal(latch.isLatched(ME), true);
  assert.equal(latch.latchedAt(ME), 777);
  assert.equal(latch.noteServerFlag(ME, false), true);

  // The memory follows storage while storage works
  latch.rememberSeen(ME, PEER);
  store.items.set(SEEN_KEY, JSON.stringify([GROUP]));
  assert.equal(latch.isSeen(ME, PEER), false);
  assert.equal(latch.isSeen(ME, GROUP), true);
});

// ---------------------------------------------------------------------------
// Storage that fails
// ---------------------------------------------------------------------------

test("a set that cannot be stored still holds for the session", async () => {
  store.throwSet = true;
  const latch = await fresh();

  assert.doesNotThrow(() => latch.setLatch(ME, 1000));
  assert.doesNotThrow(() => latch.rememberSeen(ME, PEER));

  assert.equal(latch.isLatched(ME), true);
  assert.equal(latch.latchedAt(ME), 1000);
  assert.equal(latch.isSeen(ME, PEER), true);
  assert.deepEqual(latch.seenIds(ME), [PEER]);
  assert.equal(latch.noteServerFlag(ME, false), true);
  assert.equal(store.items.size, 0);

  // Nothing was stored, so a reload starts without it
  const reloaded = await fresh();
  assert.equal(reloaded.isLatched(ME), false);
  assert.equal(reloaded.isSeen(ME, PEER), false);
});

test("once storage works again the next write stores what was held", async () => {
  store.throwSet = true;
  const latch = await fresh();
  latch.noteServerFlag(ME, true, 1000);
  latch.rememberSeen(ME, PEER);

  store.throwSet = false;
  latch.noteServerFlag(ME, true, 2000);
  latch.rememberSeen(ME, GROUP);

  assert.equal(store.items.get(LATCH_KEY), "1");
  assert.equal(store.items.get(AT_KEY), "1000");
  assert.deepEqual(JSON.parse(store.items.get(SEEN_KEY)!), [PEER, GROUP]);

  const reloaded = await fresh();
  assert.equal(reloaded.isLatched(ME), true);
  assert.equal(reloaded.latchedAt(ME), 1000);
  assert.equal(reloaded.isSeen(ME, PEER), true);
});

test("reads that throw keep what the page already knows", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1000);
  latch.rememberSeen(ME, PEER);
  assert.equal(latch.isSeen(ME, PEER), true);

  store.throwGet = true;

  assert.doesNotThrow(() => latch.isLatched(ME));
  assert.equal(latch.isLatched(ME), true);
  assert.equal(latch.latchedAt(ME), 1000);
  assert.equal(latch.isSeen(ME, PEER), true);
  assert.equal(latch.noteServerFlag(ME, false), true);

  // A page that never knew reads as off without throwing
  const blind = await fresh();
  assert.doesNotThrow(() => blind.isLatched(ME));
  assert.equal(blind.isLatched(ME), false);
  assert.equal(blind.latchedAt(ME), null);
  assert.equal(blind.isSeen(ME, PEER), false);
  assert.deepEqual(blind.seenIds(ME), []);
});

test("with no localStorage at all nothing throws and the session holds", async () => {
  installStorage(undefined);
  const latch = await fresh();

  assert.equal(latch.isLatched(ME), false);
  assert.doesNotThrow(() => latch.noteServerFlag(ME, true, 1000));
  assert.doesNotThrow(() => latch.rememberSeen(ME, PEER));
  assert.equal(latch.isLatched(ME), true);
  assert.equal(latch.latchedAt(ME), 1000);
  assert.equal(latch.isSeen(ME, PEER), true);

  assert.doesNotThrow(() => latch.forgetSeen(ME, PEER));
  assert.equal(latch.isSeen(ME, PEER), false);

  assert.doesNotThrow(() => latch.clearLatch(ME));
  assert.equal(latch.isLatched(ME), false);
});

test("a clear that cannot remove the key holds, and removes it later", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1000);

  store.throwRemove = true;
  assert.doesNotThrow(() => latch.clearLatch(ME));

  // The key is still there, and this page does not latch itself again
  assert.equal(store.items.get(LATCH_KEY), "1");
  assert.equal(latch.isLatched(ME), false);
  assert.equal(latch.latchedAt(ME), null);
  assert.equal(latch.noteServerFlag(ME, false), false);

  store.throwRemove = false;
  assert.equal(latch.isLatched(ME), false);
  assert.equal(store.items.has(LATCH_KEY), false);
  assert.equal(store.items.has(AT_KEY), false);

  // A later set is a real one
  latch.setLatch(ME, 2000);
  assert.equal(latch.isLatched(ME), true);
  assert.equal(latch.latchedAt(ME), 2000);
});

test("a forget that cannot be stored holds for the session", async () => {
  const latch = await fresh();
  latch.rememberSeen(ME, PEER);
  latch.rememberSeen(ME, GROUP);

  store.throwSet = true;
  assert.doesNotThrow(() => latch.forgetSeen(ME, PEER));

  assert.equal(latch.isSeen(ME, PEER), false);
  assert.equal(latch.isSeen(ME, GROUP), true);
  assert.deepEqual(JSON.parse(store.items.get(SEEN_KEY)!), [PEER, GROUP]);

  // Remembering it again undoes the held forget
  latch.rememberSeen(ME, PEER);
  assert.equal(latch.isSeen(ME, PEER), true);

  latch.forgetSeen(ME, PEER);
  store.throwSet = false;
  latch.rememberSeen(ME, "third");
  assert.deepEqual(JSON.parse(store.items.get(SEEN_KEY)!), [GROUP, "third"]);
});

test("the memory is parsed again only when the stored string changes", async () => {
  store.items.set(SEEN_KEY, JSON.stringify([PEER]));
  const latch = await fresh();

  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parses += 1;
    return parse(...args);
  }) as typeof JSON.parse;

  try {
    for (let i = 0; i < 50; i++) {
      assert.equal(latch.isSeen(ME, PEER), true);
      assert.equal(latch.isSeen(ME, GROUP), false);
    }
    assert.equal(parses, 1);

    // Another window writes: picked up on the next read
    store.items.set(SEEN_KEY, JSON.stringify([GROUP]));
    assert.equal(latch.isSeen(ME, PEER), false);
    assert.equal(latch.isSeen(ME, GROUP), true);
    assert.equal(parses, 2);

    // A write from this page drops the cache; the next read parses it once
    latch.rememberSeen(ME, PEER);
    for (let i = 0; i < 10; i++) {
      assert.equal(latch.isSeen(ME, PEER), true);
      assert.equal(latch.isSeen(ME, GROUP), true);
    }
    assert.equal(parses, 3);
  } finally {
    JSON.parse = parse;
  }
});

// ---------------------------------------------------------------------------
// The bound session account
// ---------------------------------------------------------------------------

test("unbound, a client reads the Ready account only", async () => {
  const latch = await fresh();
  assert.equal(latch.latchAccountId(ME), ME);
  assert.equal(latch.latchAccountId(undefined), undefined);
  assert.equal(latch.latchAccountId(""), undefined);
  assert.equal(latch.latchedForClient(ME), false);

  latch.setLatch(ME, 1000);
  assert.equal(latch.latchedForClient(ME), true);
  assert.equal(latch.latchedForClient(OTHER), false);
  assert.equal(latch.latchedForClient(undefined), false);
});

test("a latched session account holds with a missing or different Ready id", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1000);
  latch.bindLatchAccount(ME);

  assert.equal(latch.latchedForClient(ME), true);
  assert.equal(latch.latchedForClient(undefined), true);
  assert.equal(latch.latchedForClient(""), true);
  assert.equal(latch.latchedForClient(OTHER), true);

  // Memory and latch keys follow the session account, not the Ready id
  assert.equal(latch.latchAccountId(undefined), ME);
  assert.equal(latch.latchAccountId(OTHER), ME);
});

test("either account latched is enough", async () => {
  const latch = await fresh();
  latch.bindLatchAccount(ME);
  assert.equal(latch.latchedForClient(OTHER), false);
  assert.equal(latch.latchedForClient(undefined), false);

  // Only the Ready account is latched
  latch.setLatch(OTHER, 1000);
  assert.equal(latch.latchedForClient(OTHER), true);
  assert.equal(latch.latchedForClient(undefined), false);
  assert.equal(latch.latchedForClient(ME), false);

  latch.clearLatch(OTHER);
  latch.setLatch(ME, 2000);
  assert.equal(latch.latchedForClient(OTHER), true);
});

test("binding follows sign-in and sign-out, and a computation re-runs on it", async () => {
  const latch = await fresh();
  latch.setLatch(ME, 1000);
  const runs: string[] = [];

  const dispose = createRoot((dispose) => {
    createComputed(() => {
      runs.push(
        `${latch.latchAccountId(undefined) ?? "-"}:` +
          `${latch.latchedForClient(undefined) ? "on" : "off"}`,
      );
    });
    return dispose;
  });

  latch.bindLatchAccount(ME);
  latch.bindLatchAccount(ME);
  latch.bindLatchAccount(OTHER);
  latch.bindLatchAccount(undefined);
  latch.bindLatchAccount("");
  dispose();

  assert.deepEqual(runs, ["-:off", `${ME}:on`, `${OTHER}:off`, "-:off"]);
  assert.equal(latch.latchAccountId(OTHER), OTHER);
  // Binding stores nothing
  assert.deepEqual([...store.items.keys()].sort(), [AT_KEY, LATCH_KEY].sort());
});

test("confirmPeerChanged forgets the peer for the client's account only", async () => {
  const latch = await fresh();
  latch.rememberSeen(ME, PEER);
  latch.rememberSeen(ME, GROUP);
  latch.rememberSeen(OTHER, PEER);

  // Bound: the session account's memory, whatever Ready said
  latch.bindLatchAccount(ME);
  latch.confirmPeerChanged(PEER, OTHER);
  assert.equal(latch.isSeen(ME, PEER), false);
  assert.equal(latch.isSeen(ME, GROUP), true);
  assert.equal(latch.isSeen(OTHER, PEER), true);
  assert.deepEqual(JSON.parse(store.items.get(SEEN_KEY)!), [GROUP]);

  // Unbound: the Ready account's
  latch.bindLatchAccount(undefined);
  latch.confirmPeerChanged(PEER, OTHER);
  assert.equal(latch.isSeen(OTHER, PEER), false);

  // Nobody to key it by: nothing happens
  latch.rememberSeen(ME, PEER);
  latch.confirmPeerChanged(PEER);
  assert.equal(latch.isSeen(ME, PEER), true);
});

test("confirmPeerChanged does nothing while the client is latched", async () => {
  const latch = await fresh();
  latch.rememberSeen(ME, PEER);
  latch.setLatch(ME, 1000);
  latch.bindLatchAccount(ME);

  latch.confirmPeerChanged(PEER, ME);
  latch.confirmPeerChanged(PEER, undefined);
  latch.confirmPeerChanged(PEER, OTHER);
  assert.equal(latch.isSeen(ME, PEER), true);
});

// ---------------------------------------------------------------------------
// Reactivity
// ---------------------------------------------------------------------------

test("a computation that reads the latch or the memory re-runs on a change", async () => {
  const latch = await fresh();
  const seen: string[] = [];

  const dispose = createRoot((dispose) => {
    createComputed(() => {
      seen.push(
        `${latch.isLatched(ME) ? "on" : "off"}:${latch.latchedAt(ME)}:` +
          `${latch.isSeen(ME, PEER) ? "peer" : "-"}`,
      );
    });
    return dispose;
  });

  assert.deepEqual(seen, ["off:null:-"]);

  latch.noteServerFlag(ME, true, 1000);
  assert.deepEqual(seen.slice(1), ["on:1000:-"]);

  // Nothing changed: no run
  latch.noteServerFlag(ME, false);
  latch.noteServerFlag(ME, true, 2000);
  latch.setLatch(ME, 3000);
  assert.equal(seen.length, 2);

  latch.rememberSeen(ME, PEER);
  assert.deepEqual(seen.slice(2), ["on:1000:peer"]);
  latch.rememberSeen(ME, PEER);
  assert.equal(seen.length, 3);

  latch.forgetSeen(ME, PEER);
  assert.deepEqual(seen.slice(3), ["on:1000:-"]);
  latch.forgetSeen(ME, PEER);
  assert.equal(seen.length, 4);

  latch.clearLatch(ME);
  assert.deepEqual(seen.slice(4), ["off:null:-"]);

  dispose();
  latch.setLatch(ME, 4000);
  assert.equal(seen.length, 5);
});
