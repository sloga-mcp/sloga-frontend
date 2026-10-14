/**
 * Run with:
 *
 *     node --test --conditions=browser components/chatWindows/chatWindowsStore.test.ts
 *
 * (`--conditions=browser` matters: without it Node resolves solid-js's server
 * build, whose stores do not notify, and the reactivity case would pass or
 * fail for the wrong reason.)
 *
 * The chat-window layout: which channel sits in which window, the active tab,
 * window ids, and the device-local persistence the host restores windows
 * from. Every case builds its own model over a fake `localStorage`; a seeded
 * random walk checks the invariants after every operation and across reloads.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createComputed, createRoot } from "solid-js";

import {
  type ChatWin,
  type ChatWindowsStorage,
  FRIENDS_WINDOW_ID,
  STORAGE_KEY,
  chatWindows,
  closeTab,
  createChatWindowsModel,
  openConversation,
  parseLayout,
  resetChatWindows,
  windowOf,
} from "./chatWindowsStore.ts";

type FakeStorage = ChatWindowsStorage & { data: Map<string, string> };

function fakeStorage(initial?: unknown): FakeStorage {
  const data = new Map<string, string>();
  if (initial !== undefined) {
    data.set(
      STORAGE_KEY,
      typeof initial === "string" ? initial : JSON.stringify(initial),
    );
  }
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

/** The windows as plain data (the store hands out proxies). */
function plain(model: ReturnType<typeof createChatWindowsModel>): ChatWin[] {
  return JSON.parse(JSON.stringify(model.chatWindows.windows()));
}

function idNumber(id: string): number {
  return Number(id.slice(2));
}

/** Every invariant the contract pins; throws with the layout on a breach. */
function assertInvariants(windows: ChatWin[]) {
  const where = JSON.stringify(windows);
  const channels = new Set<string>();
  const ids = new Set<string>();
  for (const w of windows) {
    assert.match(w.id, /^w-[1-9]\d*$/, where);
    assert.ok(!ids.has(w.id), `duplicate window id ${w.id}: ${where}`);
    ids.add(w.id);
    assert.ok(w.tabs.length > 0, `empty window ${w.id}: ${where}`);
    assert.ok(
      w.active !== undefined && w.tabs.includes(w.active),
      `active not a tab in ${w.id}: ${where}`,
    );
    for (const tab of w.tabs) {
      assert.ok(!channels.has(tab), `channel ${tab} in two places: ${where}`);
      channels.add(tab);
    }
  }
}

describe("openConversation", () => {
  it("creates the first window when there is none, without a focus request", () => {
    const m = createChatWindowsModel(fakeStorage());
    const focus: string[] = [];
    m.onFocusRequest((w, c) => focus.push(`${w}:${c}`));

    assert.equal(m.openConversation("a"), "w-1");
    assert.deepEqual(plain(m), [{ id: "w-1", tabs: ["a"], active: "a" }]);
    assert.equal(m.windowOf("a"), "w-1");
    assert.deepEqual(focus, []);
  });

  it("appends to the first window and asks to raise it", () => {
    const m = createChatWindowsModel(fakeStorage());
    m.openConversation("a");
    m.moveTab("a", "new"); // w-1 goes, w-2 holds a
    m.openConversation("b"); // first window is now w-2
    m.moveTab("b", "new"); // w-3 holds b
    const focus: string[] = [];
    m.onFocusRequest((w, c) => focus.push(`${w}:${c}`));

    assert.equal(m.openConversation("c"), "w-2");
    assert.deepEqual(plain(m), [
      { id: "w-2", tabs: ["a", "c"], active: "c" },
      { id: "w-3", tabs: ["b"], active: "b" },
    ]);
    assert.deepEqual(focus, ["w-2:c"]);
  });

  it("an open tab is focused, not duplicated, and its window returned", () => {
    const m = createChatWindowsModel(fakeStorage());
    m.openConversation("a");
    m.openConversation("b");
    const second = m.moveTab("b", "new");
    m.openConversation("c"); // lands in w-1 with a
    const focus: string[] = [];
    m.onFocusRequest((w, c) => focus.push(`${w}:${c}`));

    assert.equal(m.openConversation("a"), "w-1");
    assert.equal(m.openConversation("b"), second);
    assert.deepEqual(plain(m), [
      { id: "w-1", tabs: ["a", "c"], active: "a" },
      { id: second, tabs: ["b"], active: "b" },
    ]);
    assert.deepEqual(focus, ["w-1:a", `${second}:b`]);
    assertInvariants(plain(m));
  });

  it("rejects a missing channel id instead of opening an empty tab", () => {
    const m = createChatWindowsModel(fakeStorage());
    assert.throws(() => m.openConversation(""), TypeError);
    assert.throws(
      () => m.openConversation(undefined as unknown as string),
      TypeError,
    );
    assert.throws(() => m.moveTab("", "new"), TypeError);
    assert.deepEqual(plain(m), []);
  });

  it("an unsubscribed or throwing listener does not stop the others", () => {
    const m = createChatWindowsModel(fakeStorage());
    m.openConversation("a");
    const seen: string[] = [];
    const error = console.error;
    console.error = () => {};
    try {
      const off = m.onFocusRequest(() => seen.push("gone"));
      m.onFocusRequest(() => {
        throw new Error("boom");
      });
      m.onFocusRequest((w, c) => seen.push(`${w}:${c}`));
      off();
      m.openConversation("a");
    } finally {
      console.error = error;
    }
    assert.deepEqual(seen, ["w-1:a"]);
  });
});

describe("moveTab", () => {
  function threeTabs() {
    const m = createChatWindowsModel(fakeStorage());
    m.openConversation("a");
    m.openConversation("b");
    m.openConversation("c");
    return m;
  }

  it('"new" pops the tab into a new window at the given position', () => {
    const m = threeTabs();
    const id = m.moveTab("c", "new", { at: { left: 300, top: 120 } });
    assert.equal(id, "w-2");
    assert.deepEqual(plain(m), [
      { id: "w-1", tabs: ["a", "b"], active: "b" },
      { id: "w-2", tabs: ["c"], active: "c", at: { left: 300, top: 120 } },
    ]);
  });

  it('"new" drops a non-finite position', () => {
    const m = threeTabs();
    m.moveTab("a", "new", { at: { left: Number.NaN, top: 1 } });
    assert.equal(plain(m)[1].at, undefined);
  });

  it("moving the last tab out removes its window; ids are not reused", () => {
    const m = threeTabs();
    const popped = m.moveTab("c", "new");
    assert.equal(m.moveTab("c", "w-1", { index: 0 }), "w-1");
    assert.deepEqual(plain(m), [
      { id: "w-1", tabs: ["c", "a", "b"], active: "c" },
    ]);
    assert.equal(m.windowOf("c"), "w-1");

    // Popping the only tab of a window out again gives a fresh id.
    const again = m.moveTab("c", "new");
    const third = m.moveTab("c", "new");
    assert.equal(popped, "w-2");
    assert.equal(again, "w-3");
    assert.equal(third, "w-4");
    assert.deepEqual(
      plain(m).map((w) => w.id),
      ["w-1", "w-4"],
    );
  });

  it("inserts at the index in another window, clamped, appending by default", () => {
    const m = threeTabs();
    const w2 = m.moveTab("c", "new");
    m.moveTab("a", w2, { index: 0 });
    assert.deepEqual(plain(m)[1].tabs, ["a", "c"]);
    m.moveTab("b", w2, { index: 99 }); // w-1 empties and goes
    assert.deepEqual(plain(m), [
      { id: w2, tabs: ["a", "c", "b"], active: "b" },
    ]);
    m.openConversation("d");
    m.moveTab("d", "new");
    m.moveTab("d", w2, { index: -5 });
    assert.deepEqual(plain(m)[0].tabs, ["d", "a", "c", "b"]);
    m.moveTab("d", "new");
    m.moveTab("d", w2);
    assert.deepEqual(plain(m)[0].tabs, ["a", "c", "b", "d"]);
    assertInvariants(plain(m));
  });

  it("reorders within a window by the rendered drop slot", () => {
    const m = threeTabs(); // a b c
    m.moveTab("a", "w-1", { index: 2 }); // dropped before c
    assert.deepEqual(plain(m)[0].tabs, ["b", "a", "c"]);
    m.moveTab("c", "w-1", { index: 0 });
    assert.deepEqual(plain(m)[0].tabs, ["c", "b", "a"]);
    m.moveTab("c", "w-1", { index: 3 }); // to the end
    assert.deepEqual(plain(m)[0], {
      id: "w-1",
      tabs: ["b", "a", "c"],
      active: "c",
    });
  });

  it("a one-tab window dropped on itself keeps its place in the window order", () => {
    const m = threeTabs();
    m.moveTab("a", "new"); // w-2
    m.moveTab("a", "w-2", { index: 0 });
    m.moveTab("b", "w-2"); // w-2: a b, w-1: c
    m.moveTab("c", "w-1", { index: 1 });
    assert.deepEqual(
      plain(m).map((w) => w.id),
      ["w-1", "w-2"],
    );
  });

  it("a target that has gone leaves an open tab alone", () => {
    const m = threeTabs();
    assert.equal(m.moveTab("b", "w-9", { index: 0 }), "w-1");
    assert.deepEqual(plain(m), [
      { id: "w-1", tabs: ["a", "b", "c"], active: "c" },
    ]);
    // A channel open nowhere gets a window of its own instead.
    const id = m.moveTab("z", "w-9");
    assert.equal(id, "w-2");
    assert.equal(m.windowOf("z"), "w-2");
  });
});

describe("closeTab / closeWindow / setActive", () => {
  it("closing the active tab activates its right neighbour, else its left", () => {
    const m = createChatWindowsModel(fakeStorage());
    for (const c of ["a", "b", "c", "d"]) m.openConversation(c);
    m.setActive("w-1", "b");
    m.closeTab("b");
    assert.equal(plain(m)[0].active, "c");
    m.setActive("w-1", "d");
    m.closeTab("d");
    assert.equal(plain(m)[0].active, "c");
    m.closeTab("a"); // not active: unchanged
    assert.deepEqual(plain(m), [{ id: "w-1", tabs: ["c"], active: "c" }]);
  });

  it("closing the last tab removes the window; unknown ids are ignored", () => {
    const m = createChatWindowsModel(fakeStorage());
    m.openConversation("a");
    m.closeTab("nope");
    m.closeWindow("w-7");
    assert.equal(plain(m).length, 1);
    m.closeTab("a");
    assert.deepEqual(plain(m), []);
    assert.equal(m.windowOf("a"), undefined);
    assert.equal(m.openConversation("a"), "w-2");
  });

  it("closeWindow drops its tabs, which can then open elsewhere", () => {
    const m = createChatWindowsModel(fakeStorage());
    m.openConversation("a");
    m.openConversation("b");
    m.moveTab("b", "new");
    m.closeWindow("w-1");
    assert.equal(m.windowOf("a"), undefined);
    assert.deepEqual(plain(m), [{ id: "w-2", tabs: ["b"], active: "b" }]);
    assert.equal(m.openConversation("a"), "w-2");
  });

  it("setActive only accepts a tab of that window", () => {
    const m = createChatWindowsModel(fakeStorage());
    m.openConversation("a");
    m.openConversation("b");
    m.moveTab("b", "new");
    m.setActive("w-1", "b");
    m.setActive("w-9", "a");
    assert.deepEqual(plain(m), [
      { id: "w-1", tabs: ["a"], active: "a" },
      { id: "w-2", tabs: ["b"], active: "b" },
    ]);
  });
});

describe("setFriendsOpen", () => {
  it("opens a closed friends window without a focus request", () => {
    const m = createChatWindowsModel(fakeStorage());
    const focus: string[] = [];
    m.onFocusRequest((w, c) => focus.push(`${w}:${c}`));

    m.setFriendsOpen(true);
    assert.equal(m.chatWindows.friendsOpen(), true);
    assert.deepEqual(focus, []);
  });

  it("asks to raise a friends window that is already open", () => {
    const m = createChatWindowsModel(fakeStorage());
    m.setFriendsOpen(true);
    const focus: [string, string][] = [];
    m.onFocusRequest((w, c) => focus.push([w, c]));

    m.setFriendsOpen(true);
    assert.equal(m.chatWindows.friendsOpen(), true);
    assert.deepEqual(focus, [[FRIENDS_WINDOW_ID, ""]]);
    assert.equal(FRIENDS_WINDOW_ID, "friends");
    assert.doesNotMatch(FRIENDS_WINDOW_ID, /^w-/);
  });

  it("closing, open or not, never asks for focus", () => {
    const m = createChatWindowsModel(fakeStorage());
    const focus: string[] = [];
    m.onFocusRequest((w, c) => focus.push(`${w}:${c}`));

    m.setFriendsOpen(false);
    m.setFriendsOpen(true);
    m.setFriendsOpen(false);
    m.setFriendsOpen(false);
    assert.equal(m.chatWindows.friendsOpen(), false);
    assert.deepEqual(focus, []);
  });
});

describe("persistence", () => {
  it("round-trips windows, friendsOpen and the id counter", () => {
    const storage = fakeStorage();
    const a = createChatWindowsModel(storage);
    a.openConversation("a");
    a.openConversation("b");
    a.moveTab("b", "new", { at: { left: 10, top: 20 } });
    a.setFriendsOpen(true);
    a.setActive("w-1", "a");

    const b = createChatWindowsModel(storage);
    assert.deepEqual(plain(b), plain(a));
    assert.equal(b.chatWindows.friendsOpen(), true);
    assert.equal(b.windowOf("b"), "w-2");

    b.setFriendsOpen(false);
    assert.equal(
      createChatWindowsModel(storage).chatWindows.friendsOpen(),
      false,
    );
  });

  it("ids stay monotonic across a reload, even after every window closed", () => {
    const storage = fakeStorage();
    const a = createChatWindowsModel(storage);
    a.openConversation("a");
    a.moveTab("a", "new");
    a.moveTab("a", "new"); // w-3
    a.closeTab("a");
    assert.deepEqual(plain(a), []);

    const b = createChatWindowsModel(storage);
    assert.equal(b.openConversation("x"), "w-4");
  });

  it("starts empty on missing, unparsable or wrong-shaped data", () => {
    for (const raw of [
      undefined,
      "{not json",
      "null",
      "42",
      '"str"',
      "[]",
      JSON.stringify({ windows: "nope" }),
      JSON.stringify({ windows: [null, 1, "w-1", { tabs: ["a"] }] }),
    ]) {
      const m = createChatWindowsModel(fakeStorage(raw));
      assert.deepEqual(plain(m), [], String(raw));
      assert.equal(m.chatWindows.friendsOpen(), false, String(raw));
      assert.equal(m.openConversation("a"), "w-1", String(raw));
    }
  });

  it("drops bad entries and re-establishes every invariant", () => {
    const m = createChatWindowsModel(
      fakeStorage({
        nextId: 2, // lower than the ids below: bumped past them
        friendsOpen: "yes", // not a boolean: closed
        windows: [
          { id: "w-3", tabs: ["a", "b", "a", 7, ""], active: "zz" },
          { id: "w-3", tabs: ["c"] }, // duplicate id
          { id: "x-1", tabs: ["d"] }, // malformed id
          { id: "w-01", tabs: ["d"] }, // malformed id
          { id: "w-5", tabs: ["b", "e"], active: "b", at: { left: "1" } },
          { id: "w-8", tabs: ["a"] }, // only a channel already placed
          { id: "w-6", tabs: "f", active: "f" },
          { id: "w-7", tabs: ["g"], at: { left: 5, top: -40 } },
        ],
      }),
    );
    assert.deepEqual(plain(m), [
      { id: "w-3", tabs: ["a", "b"], active: "a" },
      { id: "w-5", tabs: ["e"], active: "e" },
      { id: "w-7", tabs: ["g"], active: "g", at: { left: 5, top: -40 } },
    ]);
    assertInvariants(plain(m));
    assert.equal(m.chatWindows.friendsOpen(), false);
    // w-8 was dropped but its id still counts: never reissued.
    m.closeWindow("w-3");
    assert.equal(m.moveTab("a", "new"), "w-9");
  });

  it("caps an oversized stored layout", () => {
    const windows = Array.from({ length: 80 }, (_, i) => ({
      id: `w-${i + 1}`,
      tabs: Array.from({ length: 300 }, (_, j) => `c${i}-${j}`),
    }));
    const m = createChatWindowsModel(fakeStorage({ nextId: 1, windows }));
    const loaded = plain(m);
    assert.equal(loaded.length, 50);
    assert.ok(loaded.every((w) => w.tabs.length === 200));
    // Ids of windows past the cap still count: never reissued.
    assert.equal(m.moveTab("new-tab", "new"), "w-81");
  });

  it("keeps working when storage throws on read or write", () => {
    const broken: ChatWindowsStorage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
    };
    const m = createChatWindowsModel(broken);
    assert.equal(m.openConversation("a"), "w-1");
    assert.equal(m.windowOf("a"), "w-1");
    const none = createChatWindowsModel();
    assert.equal(none.openConversation("a"), "w-1");
  });

  it("a huge stored id or counter is dropped, so new ids never stall", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const m = createChatWindowsModel(
      fakeStorage({
        nextId: big,
        windows: [
          { id: `w-${big}`, tabs: ["a"] },
          { id: "w-1000000001", tabs: ["b"] }, // one past the cap
          { id: "w-4", tabs: ["c"] },
        ],
      }),
    );
    assert.deepEqual(plain(m), [{ id: "w-4", tabs: ["c"], active: "c" }]);
    const first = m.moveTab("a", "new");
    const second = m.moveTab("b", "new");
    assert.equal(first, "w-5");
    assert.equal(second, "w-6");
    assertInvariants(plain(m));

    // The cap itself is still a valid id.
    const atCap = parseLayout(
      JSON.stringify({ windows: [{ id: "w-1000000000", tabs: ["a"] }] }),
    );
    assert.deepEqual(
      atCap.windows.map((w) => w.id),
      ["w-1000000000"],
    );
    assert.equal(atCap.nextId, 1_000_000_001);
  });

  it("parseLayout never lets the counter fall behind an id", () => {
    const layout = parseLayout(
      JSON.stringify({ nextId: 2.5, windows: [{ id: "w-12", tabs: ["a"] }] }),
    );
    assert.equal(layout.nextId, 13);
  });
});

describe("resetChatWindows", () => {
  it("closes every window and the friends window and deletes the saved layout", () => {
    const storage = fakeStorage();
    const m = createChatWindowsModel(storage);
    m.openConversation("a");
    m.openConversation("b");
    m.moveTab("b", "new");
    m.setFriendsOpen(true);
    assert.ok(storage.data.has(STORAGE_KEY));
    const focus: string[] = [];
    m.onFocusRequest((w, c) => focus.push(`${w}:${c}`));

    let runs = 0;
    const dispose = createRoot((dispose) => {
      createComputed(() => {
        void m.chatWindows.windows().length;
        m.chatWindows.friendsOpen();
        runs++;
      });
      return dispose;
    });
    m.reset();
    dispose();

    assert.deepEqual(plain(m), []);
    assert.equal(m.chatWindows.friendsOpen(), false);
    assert.equal(m.windowOf("a"), undefined);
    assert.equal(storage.data.has(STORAGE_KEY), false);
    assert.ok(runs > 1, "the reset notified subscribers");

    // The next account on this device loads nothing.
    const next = createChatWindowsModel(storage);
    assert.deepEqual(plain(next), []);
    assert.equal(next.chatWindows.friendsOpen(), false);

    // In this session ids carry on (no live name reused) and the host's
    // listener still hears focus requests.
    assert.equal(m.openConversation("c"), "w-3");
    m.openConversation("c");
    assert.deepEqual(focus, ["w-3:c"]);
    assertInvariants(plain(m));
  });

  it("clears without removeItem, and when storage throws", () => {
    const data = new Map<string, string>();
    const noRemove: ChatWindowsStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
    };
    const m = createChatWindowsModel(noRemove);
    m.openConversation("a");
    m.setFriendsOpen(true);
    m.reset();
    const reloaded = createChatWindowsModel(noRemove);
    assert.deepEqual(plain(reloaded), []);
    assert.equal(reloaded.chatWindows.friendsOpen(), false);

    const throwing: ChatWindowsStorage = {
      getItem: () => null,
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {
        throw new Error("SecurityError");
      },
    };
    const t = createChatWindowsModel(throwing);
    t.openConversation("a");
    assert.doesNotThrow(() => t.reset());
    assert.deepEqual(plain(t), []);
  });

  it("the module-level export resets the app instance", () => {
    openConversation("module-reset");
    resetChatWindows();
    assert.equal(windowOf("module-reset"), undefined);
    assert.equal(chatWindows.windows().length, 0);
    assert.equal(chatWindows.friendsOpen(), false);
  });
});

describe("reactivity", () => {
  it("windows() is tracked, and a window keeps its identity as tabs change", () => {
    const m = createChatWindowsModel(fakeStorage());
    m.openConversation("a");
    const seen: number[] = [];
    let friends = 0;
    const dispose = createRoot((dispose) => {
      createComputed(() => {
        seen.push(
          m.chatWindows.windows().reduce((n, w) => n + w.tabs.length, 0),
        );
      });
      createComputed(() => {
        m.chatWindows.friendsOpen();
        friends++;
      });
      return dispose;
    });
    const before = m.chatWindows.windows()[0];
    m.openConversation("b");
    m.setActive("w-1", "a");
    m.setFriendsOpen(true);
    assert.equal(m.chatWindows.windows()[0], before);
    assert.equal(m.chatWindows.windows()[0].active, "a");
    assert.deepEqual(seen.slice(0, 2), [1, 2]);
    assert.equal(friends, 2);
    dispose();
  });
});

describe("invariants under a random walk", () => {
  // A small deterministic PRNG (mulberry32), so a failure reproduces.
  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("holds after every operation and across reloads", () => {
    for (const seed of [1, 2, 3, 42, 1337]) {
      const random = rng(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
      const channels = ["a", "b", "c", "d", "e", "f"];
      const storage = fakeStorage();
      let m = createChatWindowsModel(storage);
      let highest = 0;

      for (let step = 0; step < 400; step++) {
        const ids = plain(m).map((w) => w.id);
        const op = Math.floor(random() * 8);
        const channel = pick(channels);
        let returned: string | undefined;
        if (op === 0 || op === 1) returned = m.openConversation(channel);
        else if (op === 2) returned = m.moveTab(channel, "new");
        else if (op === 3) {
          returned = m.moveTab(channel, pick([...ids, "w-999"]), {
            index: Math.floor(random() * 6) - 1,
          });
        } else if (op === 4) m.closeTab(channel);
        else if (op === 5 && ids.length) m.closeWindow(pick(ids));
        else if (op === 6 && ids.length) m.setActive(pick(ids), channel);
        else m = createChatWindowsModel(storage); // reload

        const windows = plain(m);
        assertInvariants(windows);
        if (returned !== undefined) {
          assert.equal(
            m.windowOf(channel),
            returned,
            `seed ${seed} step ${step}`,
          );
        }
        for (const w of windows) {
          // A window id is either one seen before or a brand-new, higher one.
          if (!ids.includes(w.id)) {
            assert.ok(idNumber(w.id) > highest, `seed ${seed}: reused ${w.id}`);
          }
          highest = Math.max(highest, idNumber(w.id));
        }
        // What was persisted reloads to the same layout.
        assert.deepEqual(plain(createChatWindowsModel(storage)), windows);
      }
    }
  });
});

describe("module-level instance", () => {
  it("loads without localStorage and serves the contract exports", () => {
    const id = openConversation("module-smoke");
    assert.match(id, /^w-\d+$/);
    assert.equal(windowOf("module-smoke"), id);
    assert.ok(chatWindows.windows().some((w) => w.id === id));
    closeTab("module-smoke");
    assert.equal(windowOf("module-smoke"), undefined);
  });
});
