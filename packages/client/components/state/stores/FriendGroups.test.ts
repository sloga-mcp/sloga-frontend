/**
 * Run with:
 *
 *     node --conditions=browser --test components/state/stores/FriendGroups.test.ts
 *
 * Covers the custom friend groups store in `./FriendGroups.ts`: the caps on
 * names and group count, rename / remove / move, membership, and `clean()`
 * repairing whatever local storage or another device hands it.
 *
 * As in `./Draft.editing.test.ts`, the store runs over a REAL `solid-js/store`
 * so its writes go through the same merge-versus-replace rules the app's
 * state uses; only `AbstractStore` and `State` are stood in for.
 *
 * Known-bad control: point `FRIEND_GROUPS_UNDER_TEST` at an absolute path to
 * a mutant copy of `FriendGroups.ts` (say, one whose `remove` keeps the
 * member list) and the specs it breaks fail.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { createEffect, createRoot } from "solid-js";
import { createStore } from "solid-js/store";

const UNDER_TEST = process.env.FRIEND_GROUPS_UNDER_TEST
  ? pathToFileURL(process.env.FRIEND_GROUPS_UNDER_TEST).href
  : new URL("./FriendGroups.ts", import.meta.url).href;

// resolved here so a control copy outside the tree still gets the real Solid
const SOLID_URL = import.meta.resolve("solid-js");

const STUBS: Record<string, string> = {
  "solid-js": `export { batch } from ${JSON.stringify(SOLID_URL)};`,
  ".": `export class AbstractStore {
    constructor(state, key) { this.state = state; this.key = key; }
    getKey() { return this.key; }
    get() { return this.state.get(this.key); }
    set(...args) { this.state.set(this.key, ...args); }
  }`,
  "..": `export class State {}`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS && context.parentURL === UNDER_TEST) {
      return { url: `friend-groups-test:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("friend-groups-test:")) {
      return {
        format: "module",
        shortCircuit: true,
        source: STUBS[url.slice("friend-groups-test:".length)],
      };
    }
    return nextLoad(url, context);
  },
});

const { FriendGroups } = await import(UNDER_TEST);

// the cap is pinned here rather than read off the module, so a control copy
// without the export still runs these specs (and fails them)
const MAX_MEMBERS = 1000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The n-th of a run of distinct, valid user ULIDs */
function ulid(n: number): string {
  let tail = "";
  for (let i = 0; i < 16; i++) {
    tail = CROCKFORD[n % 32] + tail;
    n = Math.floor(n / 32);
  }
  return "01ARZ3NDEK" + tail;
}

const U1 = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const U2 = ulid(2);
const U3 = ulid(3);

type Group = { id: string; name: string; order: number };
type Data = { groups: Group[]; members: Record<string, string[]> };

/** A real FriendGroups over a real solid store */
function makeStore(initial?: Data) {
  const probe = new FriendGroups({} as never);
  const [store, setStore] = createStore({
    "friend-groups": (initial ?? probe.default()) as Data,
  });
  const state = {
    get: (key: "friend-groups") => store[key],
    set: (...args: unknown[]) =>
      (setStore as unknown as (...args: unknown[]) => void)(...args),
  };
  const groups = new FriendGroups(state as never);
  return {
    groups,
    /** Plain copy of the live data */
    data: (): Data => JSON.parse(JSON.stringify(store["friend-groups"])),
    /** Write the whole key the way State.hydrate and Sync.merge do */
    replace: (value: Data) => setStore("friend-groups", value),
  };
}

/** The store with the named groups created, in order */
function withGroups(...names: string[]) {
  const made = makeStore();
  const ids = names.map((name) => {
    const id = made.groups.create(name);
    assert.equal(typeof id, "string");
    return id as string;
  });
  return { ...made, ids };
}

/** clean() through a throwaway store */
function clean(input: unknown): Data {
  return makeStore().groups.clean(input as never);
}

describe("create()", () => {
  it("trims the name and appends the group at the end", () => {
    const { groups, data } = makeStore();
    const a = groups.create("  Raid team ");
    const b = groups.create("Work");

    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.notEqual(a, b);
    assert.deepEqual(groups.ordered(), [
      { id: a, name: "Raid team", order: 0 },
      { id: b, name: "Work", order: 1 },
    ]);
    assert.deepEqual(data().members, { [a]: [], [b]: [] });
  });

  it("rejects empty, whitespace-only and non-string names", () => {
    const { groups, data } = makeStore();

    assert.equal(groups.create(""), null);
    assert.equal(groups.create("   \t\n"), null);
    assert.equal(groups.create(undefined as never), null);
    assert.equal(groups.create(42 as never), null);
    assert.deepEqual(data(), { groups: [], members: {} });
  });

  it("allows 40 characters after trimming and rejects 41", () => {
    const { groups } = makeStore();

    assert.equal(typeof groups.create(` ${"a".repeat(40)} `), "string");
    assert.equal(groups.create("a".repeat(41)), null);
  });

  it("counts characters, not UTF-16 units", () => {
    const { groups } = makeStore();
    const emoji = "\u{1F3AE}";

    const id = groups.create(emoji.repeat(40));
    assert.equal(typeof id, "string");
    assert.equal(groups.ordered()[0].name, emoji.repeat(40));
    assert.equal(groups.create(emoji.repeat(41)), null);
  });

  it("stops at 50 groups", () => {
    const { groups } = makeStore();
    for (let i = 0; i < 50; i++) {
      assert.equal(typeof groups.create(`Group ${i}`), "string");
    }

    assert.equal(groups.create("One too many"), null);
    assert.equal(groups.ordered().length, 50);

    // room again once one is gone
    groups.remove(groups.ordered()[10].id);
    assert.equal(typeof groups.create("Back under"), "string");
    assert.equal(groups.ordered().length, 50);
  });
});

describe("rename()", () => {
  it("renames with the same rules as create", () => {
    const { groups, ids } = withGroups("Old");
    const [id] = ids;

    assert.equal(groups.rename(id, "  New  "), true);
    assert.equal(groups.ordered()[0].name, "New");

    assert.equal(groups.rename(id, "   "), false);
    assert.equal(groups.rename(id, "b".repeat(41)), false);
    assert.equal(groups.ordered()[0].name, "New");
  });

  it("returns false for an unknown group and changes nothing", () => {
    const { groups, data } = withGroups("Only");
    const before = data();

    assert.equal(groups.rename("not-a-group", "Name"), false);
    assert.deepEqual(data(), before);
  });
});

describe("remove()", () => {
  it("drops the group and its members, and renumbers the rest", () => {
    const { groups, ids, data } = withGroups("A", "B", "C");
    const [a, b, c] = ids;
    groups.assign(b, U1, true);
    groups.assign(c, U1, true);

    groups.remove(b);

    assert.deepEqual(groups.ordered(), [
      { id: a, name: "A", order: 0 },
      { id: c, name: "C", order: 1 },
    ]);
    assert.equal(b in data().members, false);
    assert.deepEqual(groups.membersOf(b), []);
    assert.equal(groups.isMember(b, U1), false);
    assert.deepEqual(groups.groupsOf(U1), [c]);
  });

  it("ignores an unknown group", () => {
    const { groups, data } = withGroups("A");
    const before = data();

    groups.remove("missing");
    assert.deepEqual(data(), before);
  });
});

describe("membership", () => {
  it("assign adds once and removes, and the reads agree", () => {
    const { groups, ids } = withGroups("A", "B");
    const [a, b] = ids;

    groups.assign(a, U1, true);
    groups.assign(a, U1, true);
    groups.assign(a, U2, true);
    groups.assign(b, U1, true);

    assert.deepEqual(groups.membersOf(a), [U1, U2]);
    assert.equal(groups.isMember(a, U2), true);
    assert.equal(groups.isMember(b, U2), false);
    assert.deepEqual(groups.groupsOf(U1), [a, b]);
    assert.deepEqual(groups.groupsOf(U3), []);

    groups.assign(a, U1, false);
    groups.assign(a, U1, false);
    assert.deepEqual(groups.membersOf(a), [U2]);
    assert.deepEqual(groups.groupsOf(U1), [b]);
  });

  it("assign to an unknown group, or with no user, writes nothing", () => {
    const { groups, ids, data } = withGroups("A");
    const before = data();

    groups.assign("missing", U1, true);
    groups.assign(ids[0], "", true);
    groups.assign(ids[0], undefined as never, true);
    assert.deepEqual(data(), before);
  });

  it("groupsOf follows the display order", () => {
    const { groups, ids } = withGroups("A", "B", "C");
    const [a, b, c] = ids;
    for (const id of ids) groups.assign(id, U1, true);

    groups.move(c, 0);
    assert.deepEqual(groups.groupsOf(U1), [c, a, b]);
  });

  it("membersOf hands out a copy", () => {
    const { groups, ids } = withGroups("A");
    groups.assign(ids[0], U1, true);

    groups.membersOf(ids[0]).push("intruder");
    assert.deepEqual(groups.membersOf(ids[0]), [U1]);
  });

  it("reads never reach the prototype chain", () => {
    const { groups } = withGroups("A");

    for (const key of ["constructor", "toString", "__proto__"]) {
      assert.deepEqual(groups.membersOf(key), []);
      assert.equal(groups.isMember(key, U1), false);
    }
  });

  it("a member list left behind for a deleted group is never reported", () => {
    const { groups, ids, data, replace } = withGroups("A");
    replace({
      groups: data().groups,
      members: { [ids[0]]: [], ghost: [U1] },
    });

    assert.deepEqual(groups.membersOf("ghost"), []);
    assert.equal(groups.isMember("ghost", U1), false);
    assert.deepEqual(groups.groupsOf(U1), []);
    groups.assign("ghost", U2, true);
    assert.deepEqual(data().members.ghost, [U1]);
  });

  it("assign takes only user ULIDs", () => {
    const { groups, ids, data } = withGroups("A");
    const before = data();

    for (const bad of [
      "user-1",
      U1.toLowerCase(),
      "I" + U1.slice(1),
      U1 + "0",
    ]) {
      assert.equal(groups.assign(ids[0], bad, true), false);
    }
    assert.deepEqual(data(), before);

    assert.equal(groups.assign(ids[0], U1, true), true);
    assert.equal(groups.assign("missing", U1, true), false);
  });

  it("assign refuses to grow a group past the cap", () => {
    const { groups, ids, data, replace } = withGroups("A");
    const full = Array.from({ length: MAX_MEMBERS }, (_, i) => ulid(i + 100));
    replace({ groups: data().groups, members: { [ids[0]]: full } });

    assert.equal(groups.assign(ids[0], U1, true), false);
    assert.equal(groups.isMember(ids[0], U1), false);
    assert.equal(groups.membersOf(ids[0]).length, MAX_MEMBERS);

    // already in, and taking someone out, still work at the cap
    assert.equal(groups.assign(ids[0], full[0], true), true);
    assert.equal(groups.assign(ids[0], full[0], false), true);
    assert.equal(groups.assign(ids[0], U1, true), true);
    assert.equal(groups.membersOf(ids[0]).length, MAX_MEMBERS);
  });
});

describe("move()", () => {
  it("moves to the front, the end and the middle, renumbering", () => {
    const { groups, ids } = withGroups("A", "B", "C", "D");
    const [a, b, c, d] = ids;
    const order = () => groups.ordered().map((g: Group) => g.id);

    groups.move(c, 0);
    assert.deepEqual(order(), [c, a, b, d]);

    groups.move(c, 3);
    assert.deepEqual(order(), [a, b, d, c]);

    groups.move(a, 2);
    assert.deepEqual(order(), [b, d, a, c]);

    assert.deepEqual(
      groups.ordered().map((g: Group) => g.order),
      [0, 1, 2, 3],
    );
  });

  it("clamps out-of-range targets and ignores bad input", () => {
    const { groups, ids, data } = withGroups("A", "B", "C");
    const [a, b, c] = ids;
    const order = () => groups.ordered().map((g: Group) => g.id);

    groups.move(a, 99);
    assert.deepEqual(order(), [b, c, a]);

    groups.move(a, -5);
    assert.deepEqual(order(), [a, b, c]);

    groups.move(c, 1.7);
    assert.deepEqual(order(), [a, c, b]);

    const before = data();
    groups.move(a, Number.NaN);
    groups.move("missing", 0);
    groups.move(a, 0);
    assert.deepEqual(data(), before);
  });
});

describe("clean()", () => {
  it("turns anything that isn't the right shape into the default", () => {
    for (const input of [null, undefined, 42, "x", [], { groups: "no" }]) {
      assert.deepEqual(clean(input), { groups: [], members: {} });
    }
  });

  it("drops malformed groups and keeps the first of a duplicated id", () => {
    const cleaned = clean({
      groups: [
        null,
        7,
        { name: "No id" },
        { id: 5, name: "Numeric id", order: 0 },
        { id: "has space", name: "Bad id", order: 0 },
        { id: "__proto__", name: "Prototype", order: 0 },
        { id: "x".repeat(65), name: "Long id", order: 0 },
        { id: "no-name", order: 0 },
        { id: "blank", name: "   ", order: 0 },
        { id: "numeric-name", name: 12, order: 0 },
        { id: "a", name: "First", order: 0 },
        { id: "a", name: "Second", order: 1 },
      ],
    });

    assert.deepEqual(cleaned, {
      groups: [{ id: "a", name: "First", order: 0 }],
      members: { a: [] },
    });
  });

  it("trims names and cuts long ones to 40 characters", () => {
    const emoji = "\u{1F3AE}";
    const cleaned = clean({
      groups: [
        { id: "a", name: "  padded  ", order: 0 },
        { id: "b", name: "c".repeat(60), order: 1 },
        // the cut lands just after a space, which is trimmed off
        { id: "c", name: `${"d".repeat(39)} tail`, order: 2 },
        { id: "d", name: emoji.repeat(45), order: 3 },
      ],
    });

    assert.deepEqual(
      cleaned.groups.map((g) => g.name),
      ["padded", "c".repeat(40), "d".repeat(39), emoji.repeat(40)],
    );
  });

  it("sorts by order, puts groups without one last and renumbers", () => {
    const cleaned = clean({
      groups: [
        { id: "late", name: "Late", order: 10 },
        { id: "none-1", name: "None 1" },
        { id: "early", name: "Early", order: -3 },
        { id: "nan", name: "NaN", order: Number.NaN },
        { id: "tie-1", name: "Tie 1", order: 4 },
        { id: "tie-2", name: "Tie 2", order: 4 },
        { id: "str", name: "String", order: "1" },
      ],
    });

    assert.deepEqual(cleaned.groups, [
      { id: "early", name: "Early", order: 0 },
      { id: "tie-1", name: "Tie 1", order: 1 },
      { id: "tie-2", name: "Tie 2", order: 2 },
      { id: "late", name: "Late", order: 3 },
      { id: "none-1", name: "None 1", order: 4 },
      { id: "nan", name: "NaN", order: 5 },
      { id: "str", name: "String", order: 6 },
    ]);
  });

  it("keeps the first 50 groups in display order", () => {
    const groups = Array.from({ length: 60 }, (_, i) => ({
      id: `g-${i}`,
      name: `Group ${i}`,
      // stored back to front
      order: 59 - i,
    }));
    const cleaned = clean({ groups });

    assert.equal(cleaned.groups.length, 50);
    assert.equal(cleaned.groups[0].id, "g-59");
    assert.equal(cleaned.groups[49].id, "g-10");
    assert.deepEqual(Object.keys(cleaned.members).length, 50);
    assert.equal("g-9" in cleaned.members, false);
  });

  it("repairs member lists", () => {
    const cleaned = clean({
      groups: [
        { id: "a", name: "A", order: 0 },
        { id: "b", name: "B", order: 1 },
        { id: "c", name: "C", order: 2 },
      ],
      members: {
        a: [U1, U1, "", 5, null, { id: U2 }, U3],
        b: U1,
        ghost: [U1],
      },
    });

    assert.deepEqual(cleaned.members, {
      a: [U1, U3],
      b: [],
      c: [],
    });
  });

  it("drops members when the members field is not a record", () => {
    for (const members of [null, [U1], "a"]) {
      const cleaned = clean({
        groups: [{ id: "a", name: "A", order: 0 }],
        members,
      });
      assert.deepEqual(cleaned.members, { a: [] });
    }
  });

  it("does not read members off the prototype chain", () => {
    const input = JSON.parse(
      `{"groups":[{"id":"constructor","name":"C","order":0}],
        "members":{"__proto__":{"constructor":["01ARZ3NDEKTSV4RRFFQ69G5FAV"]}}}`,
    );
    const cleaned = clean(input);

    assert.deepEqual(cleaned.members, { constructor: [] });
    assert.equal(Object.getPrototypeOf(cleaned.members), Object.prototype);

    const inherited = clean({
      groups: [{ id: "a", name: "A", order: 0 }],
      members: Object.create({ a: [U1] }),
    });
    assert.deepEqual(inherited.members, { a: [] });
  });

  it("keeps only uppercase Crockford ULIDs as members", () => {
    const cleaned = clean({
      groups: [{ id: "a", name: "A", order: 0 }],
      members: {
        a: [
          "user-1",
          U1.toLowerCase(),
          U1.slice(0, 25),
          U1 + "0",
          "I" + U1.slice(1),
          "L" + U1.slice(1),
          "O" + U1.slice(1),
          "U" + U1.slice(1),
          " " + U1.slice(1),
          U1.slice(0, 25) + "\n",
          U2,
        ],
      },
    });

    assert.deepEqual(cleaned.members, { a: [U2] });
  });

  it("keeps the first MAX members of a group, in order", () => {
    const list = Array.from({ length: MAX_MEMBERS + 5 }, (_, i) => ulid(i));
    const cleaned = clean({
      groups: [{ id: "a", name: "A", order: 0 }],
      members: { a: [list[0], ...list] },
    });

    assert.deepEqual(cleaned.members.a, list.slice(0, MAX_MEMBERS));
    assert.deepEqual(clean(cleaned), cleaned);
  });

  it("looks no further than ten times the cap into a member list", () => {
    const junk = Array.from({ length: MAX_MEMBERS * 10 }, () => "junk");
    const cleaned = clean({
      groups: [{ id: "a", name: "A", order: 0 }],
      members: { a: [...junk, U1] },
    });

    assert.deepEqual(cleaned.members, { a: [] });
  });

  it("cleans a hostile 200k-entry member list quickly and within the cap", () => {
    // 5,000 distinct ids repeated, with junk mixed in: quadratic dedupe
    // over this takes seconds
    const hostile: unknown[] = Array.from({ length: 200_000 }, (_, i) =>
      i % 7 === 0 ? (i % 2 ? "not-a-ulid" : i) : ulid(i % 5000),
    );
    const input = {
      groups: [
        { id: "a", name: "A", order: 0 },
        { id: "b", name: "B", order: 1 },
      ],
      members: { a: hostile, b: hostile },
    };
    const store = makeStore().groups;

    const start = performance.now();
    const cleaned = store.clean(input as never);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 200, `clean() took ${elapsed.toFixed(1)} ms`);
    for (const id of ["a", "b"]) {
      assert.ok(cleaned.members[id].length <= MAX_MEMBERS);
      assert.equal(
        new Set(cleaned.members[id]).size,
        cleaned.members[id].length,
      );
    }
  });

  it("is a fixed point, and leaves what the store writes unchanged", () => {
    const messy = {
      groups: [
        { id: "b", name: ` ${"n".repeat(50)}`, order: 9 },
        { id: "a", name: "A " },
        { id: "a", name: "dup", order: 0 },
      ],
      members: { a: [U1, U1, "u"], ghost: [U2] },
    };
    const once = clean(messy);
    assert.deepEqual(clean(once), once);

    const { groups, ids, data } = withGroups("A", "B", "C");
    groups.assign(ids[0], U1, true);
    groups.assign(ids[2], U2, true);
    groups.move(ids[2], 0);
    groups.rename(ids[1], "Renamed");
    groups.remove(ids[0]);

    assert.deepEqual(groups.clean(data()), data());
  });
});

describe("reactivity", () => {
  it("ordered() and isMember() re-run on change", () => {
    const { groups, ids } = withGroups("A");
    const [a] = ids;
    const names: string[][] = [];
    const member: boolean[] = [];

    const dispose = createRoot((dispose) => {
      createEffect(() =>
        names.push(groups.ordered().map((g: Group) => g.name)),
      );
      createEffect(() => member.push(groups.isMember(a, U1)));
      return dispose;
    });

    groups.assign(a, U1, true);
    groups.create("B");
    groups.move(a, 1);
    groups.assign(a, U1, false);
    groups.assign(a, U1, true);
    groups.remove(a);

    dispose();
    assert.deepEqual(names, [["A"], ["A", "B"], ["B", "A"], ["B"]]);
    // reruns on unrelated group changes are fine; every flip must be seen
    const flips = member.filter(
      (value, i) => i === 0 || value !== member[i - 1],
    );
    assert.deepEqual(flips, [false, true, false, true, false]);
  });
});
