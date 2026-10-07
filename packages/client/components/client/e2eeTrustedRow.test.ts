// Unit spec for E2EE trusted-row adoption - run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeTrustedRow.test.ts
// (pure functions, so the browser condition is not load-bearing here - it is
// kept so one invocation can cover the reactive suites beside it.)
// Focus: a row that is not yet trusted evicts a cached object under its id
// (a forged pre-decrypt `Message` event) exactly once and BEFORE getOrCreate,
// so the decrypted shape is what gets created; an already-trusted row is
// never evicted; id and data reach getOrCreate unchanged; and isNew is
// `live && the object is created` (nothing cached under the id after evict).
import assert from "node:assert/strict";
import { test } from "node:test";

import { adoptTrustedRow } from "./e2eeTrustedRow.ts";

interface Row {
  id: string;
  content: string;
}

type Call =
  | ["has", string]
  | ["evict", string]
  | ["getOrCreate", string, unknown, boolean];

interface Harness {
  collection: {
    has(id: string): boolean;
    getOrCreate(id: string, data: never, isNew: boolean): Row;
  };
  evict: (id: string) => void;
  calls: Call[];
  created: Row;
}

const ID = "01HZENVELOPEID";
const DATA = { _id: ID, content: "decrypted", channel: "01HZCHANNEL" };

/**
 * A fake collection; `cached` decides whether ID starts out present. `evict`
 * really removes the id, so `has` answers false afterwards, as the real
 * collection does.
 */
function harness(cached: boolean): Harness {
  const calls: Call[] = [];
  const created: Row = { id: ID, content: "decrypted" };
  const present = new Set<string>(cached ? [ID] : []);
  return {
    calls,
    created,
    collection: {
      has(id) {
        calls.push(["has", id]);
        return present.has(id);
      },
      getOrCreate(id, data, isNew) {
        calls.push(["getOrCreate", id, data, isNew]);
        return created;
      },
    },
    evict(id) {
      calls.push(["evict", id]);
      present.delete(id);
    },
  };
}

const names = (calls: Call[]) => calls.map((c) => c[0]);

/** The single getOrCreate call; fails unless there is exactly one. */
function onlyGetOrCreate(h: Harness, label: string) {
  const goc = h.calls.filter((c) => c[0] === "getOrCreate");
  assert.equal(goc.length, 1, label);
  return goc[0] as ["getOrCreate", string, unknown, boolean];
}

test("(1) not trusted + cached: evict then getOrCreate, returns its value", () => {
  const h = harness(true);
  const out = adoptTrustedRow(h.collection, ID, DATA, true, false, h.evict);
  assert.equal(out, h.created);
  const order = names(h.calls).filter((n) => n !== "has");
  assert.deepEqual(order, ["evict", "getOrCreate"]);
  assert.deepEqual(
    h.calls.find((c) => c[0] === "evict"),
    ["evict", ID],
  );
});

test("(2) not trusted + not cached: no evict", () => {
  const h = harness(false);
  const out = adoptTrustedRow(h.collection, ID, DATA, true, false, h.evict);
  assert.equal(out, h.created);
  assert.ok(!names(h.calls).includes("evict"));
  assert.deepEqual(
    names(h.calls).filter((n) => n !== "has"),
    ["getOrCreate"],
  );
});

test("(3) trusted + cached: no evict", () => {
  const h = harness(true);
  const out = adoptTrustedRow(h.collection, ID, DATA, false, true, h.evict);
  assert.equal(out, h.created);
  assert.ok(!names(h.calls).includes("evict"));
  assert.deepEqual(
    names(h.calls).filter((n) => n !== "has"),
    ["getOrCreate"],
  );
});

test("(4) trusted + not cached: no evict", () => {
  const h = harness(false);
  const out = adoptTrustedRow(h.collection, ID, DATA, false, true, h.evict);
  assert.equal(out, h.created);
  assert.ok(!names(h.calls).includes("evict"));
  assert.deepEqual(
    names(h.calls).filter((n) => n !== "has"),
    ["getOrCreate"],
  );
});

test("(5) id and data reach getOrCreate unchanged; isNew = live && created", () => {
  for (const cached of [true, false]) {
    for (const trusted of [true, false]) {
      for (const live of [true, false]) {
        const h = harness(cached);
        adoptTrustedRow(h.collection, ID, DATA, live, trusted, h.evict);
        const label = `cached=${cached} trusted=${trusted} live=${live}`;
        const goc = onlyGetOrCreate(h, label);
        assert.equal(goc[1], ID, label);
        assert.equal(goc[2], DATA, label);
        // Created iff nothing is cached once eviction has run: absent from
        // the start, or present but untrusted (and so evicted).
        const creates = !cached || !trusted;
        assert.equal(goc[3], live && creates, label);
      }
    }
  }
});

test("(6) evict runs exactly once, only for an untrusted cached row", () => {
  for (const cached of [true, false]) {
    for (const trusted of [true, false]) {
      for (const live of [true, false]) {
        const h = harness(cached);
        adoptTrustedRow(h.collection, ID, DATA, live, trusted, h.evict);
        const evicts = h.calls.filter((c) => c[0] === "evict").length;
        const label = `cached=${cached} trusted=${trusted} live=${live}`;
        assert.equal(evicts, cached && !trusted ? 1 : 0, label);
      }
    }
  }
});

test("(7) forged cached (untrusted, present) + live: evict once, then isNew true", () => {
  const h = harness(true);
  const out = adoptTrustedRow(h.collection, ID, DATA, true, false, h.evict);
  assert.equal(out, h.created);
  const order = names(h.calls).filter((n) => n !== "has");
  assert.deepEqual(order, ["evict", "getOrCreate"]);
  const evictAt = h.calls.findIndex((c) => c[0] === "evict");
  const gocAt = h.calls.findIndex((c) => c[0] === "getOrCreate");
  assert.ok(evictAt >= 0 && evictAt < gocAt);
  assert.equal(onlyGetOrCreate(h, "forged")[3], true);
});

test("(8) trusted + present + live: no evict, isNew false", () => {
  const h = harness(true);
  adoptTrustedRow(h.collection, ID, DATA, true, true, h.evict);
  assert.ok(!names(h.calls).includes("evict"));
  assert.equal(onlyGetOrCreate(h, "trusted present")[3], false);
});

test("(9) trusted + absent + live: no evict, isNew true", () => {
  const h = harness(false);
  adoptTrustedRow(h.collection, ID, DATA, true, true, h.evict);
  assert.ok(!names(h.calls).includes("evict"));
  assert.equal(onlyGetOrCreate(h, "trusted absent")[3], true);
});

test("(10) live false: isNew false in every state", () => {
  for (const cached of [true, false]) {
    for (const trusted of [true, false]) {
      const h = harness(cached);
      adoptTrustedRow(h.collection, ID, DATA, false, trusted, h.evict);
      const label = `cached=${cached} trusted=${trusted}`;
      assert.equal(onlyGetOrCreate(h, label)[3], false, label);
    }
  }
});
