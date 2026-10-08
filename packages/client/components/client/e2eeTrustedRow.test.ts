// Unit spec for E2EE trusted-row adoption - run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeTrustedRow.test.ts
// (pure functions, so the browser condition is not load-bearing here - it is
// kept so one invocation can cover the reactive suites beside it.)
// Focus: a row that is not yet trusted evicts a cached object under its id
// (a forged pre-decrypt `Message` event) exactly once and BEFORE getOrCreate,
// so the decrypted shape is what gets created; an already-trusted row is
// never evicted; and id, data and isNew reach getOrCreate unchanged.
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

/** A fake collection; `cached` decides what `has` answers for ID. */
function harness(cached: boolean): Harness {
  const calls: Call[] = [];
  const created: Row = { id: ID, content: "decrypted" };
  return {
    calls,
    created,
    collection: {
      has(id) {
        calls.push(["has", id]);
        return cached && id === ID;
      },
      getOrCreate(id, data, isNew) {
        calls.push(["getOrCreate", id, data, isNew]);
        return created;
      },
    },
    evict(id) {
      calls.push(["evict", id]);
    },
  };
}

const names = (calls: Call[]) => calls.map((c) => c[0]);

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

test("(5) id, data and isNew reach getOrCreate unchanged", () => {
  for (const cached of [true, false]) {
    for (const trusted of [true, false]) {
      for (const isNew of [true, false]) {
        const h = harness(cached);
        adoptTrustedRow(h.collection, ID, DATA, isNew, trusted, h.evict);
        const goc = h.calls.filter((c) => c[0] === "getOrCreate");
        const label = `cached=${cached} trusted=${trusted} isNew=${isNew}`;
        assert.equal(goc.length, 1, label);
        assert.equal(goc[0][1], ID, label);
        assert.equal(goc[0][2], DATA, label);
        assert.equal(goc[0][3], isNew, label);
      }
    }
  }
});

test("(6) evict runs exactly once, only for an untrusted cached row", () => {
  for (const cached of [true, false]) {
    for (const trusted of [true, false]) {
      for (const isNew of [true, false]) {
        const h = harness(cached);
        adoptTrustedRow(h.collection, ID, DATA, isNew, trusted, h.evict);
        const evicts = h.calls.filter((c) => c[0] === "evict").length;
        const label = `cached=${cached} trusted=${trusted} isNew=${isNew}`;
        assert.equal(evicts, cached && !trusted ? 1 : 0, label);
      }
    }
  }
});
