// Unit spec for E2EE trusted-row adoption - run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeTrustedRow.test.ts
// (pure functions, so the browser condition is not load-bearing here - it is
// kept so one invocation can cover the reactive suites beside it.)
// Focus: a row that is not yet trusted evicts a cached object under its id
// (a forged pre-decrypt `Message` event) exactly once and BEFORE getOrCreate,
// so the decrypted shape is what gets created; an already-trusted row is
// never evicted; id and data reach getOrCreate unchanged; and isNew is
// `live && the object is created` (nothing cached under the id after evict).
// trustEncryptedId (the seed path) evicts a cached object under an id that is
// not yet trusted exactly once and BEFORE trusting it, so a forged object
// cached before the seed can never be adopted later as already trusted.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adoptTrustedRow,
  isTrustedId,
  trustEncryptedId,
} from "./e2eeTrustedRow.ts";

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

interface TrustRig {
  collection: { has(id: string): boolean };
  trusted: Set<string>;
  present: Set<string>;
  /** Each evict, with whether the id was already trusted when it ran. */
  evicts: [string, boolean][];
  evict: (id: string) => void;
}

/** A fake collection for the seed path; `cached` decides if ID is present. */
function trustRig(cached: boolean): TrustRig {
  const present = new Set<string>(cached ? [ID] : []);
  const trusted = new Set<string>();
  const evicts: [string, boolean][] = [];
  return {
    present,
    trusted,
    evicts,
    collection: { has: (id) => present.has(id) },
    evict(id) {
      evicts.push([id, trusted.has(id)]);
      present.delete(id);
    },
  };
}

test("(11) trustEncryptedId untrusted + cached: evict once, before trust", () => {
  const r = trustRig(true);
  trustEncryptedId(r.collection, r.trusted, ID, r.evict);
  assert.deepEqual(r.evicts, [[ID, false]]);
  assert.equal(r.trusted.has(ID), true);
  assert.equal(r.present.has(ID), false);
});

test("(12) trustEncryptedId untrusted + not cached: no evict, trusted", () => {
  const r = trustRig(false);
  trustEncryptedId(r.collection, r.trusted, ID, r.evict);
  assert.deepEqual(r.evicts, []);
  assert.equal(r.trusted.has(ID), true);
});

test("(13) trustEncryptedId already trusted + cached: no evict, object kept", () => {
  const r = trustRig(true);
  r.trusted.add(ID);
  trustEncryptedId(r.collection, r.trusted, ID, r.evict);
  assert.deepEqual(r.evicts, []);
  assert.equal(r.trusted.has(ID), true);
  assert.equal(r.present.has(ID), true);
});

test("(14) trustEncryptedId evict throws: propagates, id stays untrusted", () => {
  const r = trustRig(true);
  const boom = new Error("evict failed");
  assert.throws(
    () =>
      trustEncryptedId(r.collection, r.trusted, ID, () => {
        throw boom;
      }),
    (e) => e === boom,
  );
  assert.equal(r.trusted.has(ID), false);
});

test("(15) trustEncryptedId twice: the trusted object is not evicted again", () => {
  const r = trustRig(true);
  trustEncryptedId(r.collection, r.trusted, ID, r.evict);
  r.present.add(ID); // the trusted decrypted object is now cached
  trustEncryptedId(r.collection, r.trusted, ID, r.evict);
  assert.deepEqual(r.evicts, [[ID, false]]);
  assert.equal(r.present.has(ID), true);
});

/**
 * A caching fake shaped like `MessageCollection.getOrCreate`: it returns the
 * object cached under `id` unchanged, else creates one from `data`.
 */
function caching() {
  const objects = new Map<string, Row>();
  return {
    objects,
    collection: {
      has: (id: string) => objects.has(id),
      getOrCreate(id: string, data: never, isNew: boolean) {
        void isNew;
        const cached = objects.get(id);
        if (cached) return cached;
        const row: Row = {
          id,
          content: (data as { content: string }).content,
        };
        objects.set(id, row);
        return row;
      },
    },
    evict: (id: string) => {
      objects.delete(id);
    },
  };
}

test("(16) forged object cached before the seed is evicted, never adopted", () => {
  // Sanity check of the fake: trusting the id with no eviction (the hazard)
  // makes a later trusted adopt hand back the forged object.
  const bad = caching();
  const badForged: Row = { id: ID, content: "forged" };
  bad.objects.set(ID, badForged);
  const badTrusted = new Set<string>([ID]);
  const badOut = adoptTrustedRow(
    bad.collection,
    ID,
    DATA,
    true,
    badTrusted.has(ID),
    bad.evict,
  );
  assert.equal(badOut, badForged);

  // The seed path: the forged object is evicted by trustEncryptedId, so the
  // later adopt with alreadyTrusted=true creates the decrypted shape.
  const c = caching();
  const forged: Row = { id: ID, content: "forged" };
  c.objects.set(ID, forged);
  const trusted = new Set<string>();
  trustEncryptedId(c.collection, trusted, ID, c.evict);
  assert.equal(trusted.has(ID), true);
  assert.equal(c.objects.has(ID), false);
  const out = adoptTrustedRow(
    c.collection,
    ID,
    DATA,
    true,
    trusted.has(ID),
    c.evict,
  );
  assert.notEqual(out, forged);
  assert.deepEqual(out, { id: ID, content: "decrypted" });
  assert.equal(c.objects.get(ID), out);
});

/** Seeds ID on an empty collection, then caches a forged object under it. */
function seededThenForged() {
  const c = caching();
  const evicted: string[] = [];
  const evict = (id: string) => {
    evicted.push(id);
    c.evict(id);
  };
  const trusted = new Set<string>();
  const seedOnly = new Set<string>();
  trustEncryptedId(c.collection, trusted, ID, evict);
  seedOnly.add(ID);
  assert.deepEqual(evicted, []);
  const forged: Row = { id: ID, content: "forged" };
  c.objects.set(ID, forged);
  return { c, evicted, evict, trusted, seedOnly, forged };
}

test("(17) seed-trusted id: a forged object cached later is evicted", () => {
  // Contrast: `trusted.has(ID)` alone treats the seeded id as already
  // trusted and hands back the forged object (the hole).
  const hole = seededThenForged();
  const holeOut = adoptTrustedRow(
    hole.c.collection,
    ID,
    DATA,
    true,
    hole.trusted.has(ID),
    hole.evict,
  );
  assert.equal(holeOut, hole.forged);
  assert.deepEqual(hole.evicted, []);

  const s = seededThenForged();
  const out = adoptTrustedRow(
    s.c.collection,
    ID,
    DATA,
    true,
    isTrustedId(s.trusted, s.seedOnly, ID),
    s.evict,
  );
  assert.deepEqual(s.evicted, [ID]);
  assert.notEqual(out, s.forged);
  assert.deepEqual(out, { id: ID, content: "decrypted" });
  assert.equal(s.c.objects.get(ID), out);
});

test("(18) after the first inject, a re-adopt keeps the same trusted object", () => {
  const s = seededThenForged();
  const first = adoptTrustedRow(
    s.c.collection,
    ID,
    DATA,
    true,
    isTrustedId(s.trusted, s.seedOnly, ID),
    s.evict,
  );
  s.seedOnly.delete(ID);
  assert.deepEqual(first, { id: ID, content: "decrypted" });
  assert.deepEqual(s.evicted, [ID]);

  assert.equal(isTrustedId(s.trusted, s.seedOnly, ID), true);
  const second = adoptTrustedRow(
    s.c.collection,
    ID,
    { _id: ID, content: "re-fetched" },
    false,
    isTrustedId(s.trusted, s.seedOnly, ID),
    s.evict,
  );
  assert.equal(second, first);
  assert.deepEqual(s.evicted, [ID]);
});

/**
 * Seeds ID, then caches a forged object under it, in a caching fake whose
 * getOrCreate fires a `messageCreate` listener synchronously when it creates
 * a live object, as `MessageCollection.getOrCreate` does. The listener
 * records what `isTrustedId` answers at the moment it fires.
 */
function seededForgedListening() {
  const objects = new Map<string, Row>();
  const trusted = new Set<string>();
  const seedOnly = new Set<string>();
  const seen: boolean[] = [];
  const evicted: string[] = [];
  const collection = {
    has: (id: string) => objects.has(id),
    getOrCreate(id: string, data: never, isNew: boolean) {
      const cached = objects.get(id);
      if (cached) return cached;
      const row: Row = {
        id,
        content: (data as { content: string }).content,
      };
      objects.set(id, row);
      if (isNew) seen.push(isTrustedId(trusted, seedOnly, id));
      return row;
    },
  };
  const evict = (id: string) => {
    evicted.push(id);
    objects.delete(id);
  };
  trustEncryptedId(collection, trusted, ID, evict);
  seedOnly.add(ID);
  const forged: Row = { id: ID, content: "forged" };
  objects.set(ID, forged);
  return {
    objects,
    trusted,
    seedOnly,
    seen,
    evicted,
    collection,
    evict,
    forged,
  };
}

test("(19) messageCreate listener sees the id trusted when beforeCreate flips it", () => {
  const s = seededForgedListening();
  const out = adoptTrustedRow(
    s.collection,
    ID,
    DATA,
    true,
    isTrustedId(s.trusted, s.seedOnly, ID),
    s.evict,
    (id) => {
      s.seedOnly.delete(id);
      s.trusted.add(id);
    },
  );
  assert.deepEqual(s.seen, [true]);
  assert.deepEqual(s.evicted, [ID]);
  assert.notEqual(out, s.forged);
  assert.deepEqual(out, { id: ID, content: "decrypted" });
  assert.equal(s.objects.get(ID), out);

  // Contrast: clearing seed-only AFTER the adopt is too late - the listener
  // has already fired and saw the id untrusted.
  const late = seededForgedListening();
  adoptTrustedRow(
    late.collection,
    ID,
    DATA,
    true,
    isTrustedId(late.trusted, late.seedOnly, ID),
    late.evict,
  );
  late.seedOnly.delete(ID);
  assert.deepEqual(late.seen, [false]);
});

test("(20) beforeCreate runs once, after evict, before getOrCreate", () => {
  for (const cached of [true, false]) {
    for (const trusted of [true, false]) {
      const order: string[] = [];
      const present = new Set<string>(cached ? [ID] : []);
      const collection = {
        has: (id: string) => present.has(id),
        getOrCreate(id: string, data: never, isNew: boolean) {
          void data;
          void isNew;
          order.push(`getOrCreate:${id}`);
          return id;
        },
      };
      adoptTrustedRow(
        collection,
        ID,
        DATA,
        true,
        trusted,
        (id) => {
          order.push(`evict:${id}`);
          present.delete(id);
        },
        (id) => order.push(`beforeCreate:${id}`),
      );
      const label = `cached=${cached} trusted=${trusted}`;
      const evicts = cached && !trusted ? [`evict:${ID}`] : [];
      assert.deepEqual(
        order,
        [...evicts, `beforeCreate:${ID}`, `getOrCreate:${ID}`],
        label,
      );
    }
  }

  // A throwing beforeCreate propagates and getOrCreate never runs.
  const order: string[] = [];
  const boom = new Error("beforeCreate failed");
  const present = new Set<string>([ID]);
  assert.throws(
    () =>
      adoptTrustedRow(
        {
          has: (id: string) => present.has(id),
          getOrCreate(id: string) {
            order.push(`getOrCreate:${id}`);
            return id;
          },
        },
        ID,
        DATA,
        true,
        false,
        (id) => {
          order.push(`evict:${id}`);
          present.delete(id);
        },
        () => {
          throw boom;
        },
      ),
    (e) => e === boom,
  );
  assert.deepEqual(order, [`evict:${ID}`]);
});

test("(21) isTrustedId: trusted and not seed-only", () => {
  for (const inTrusted of [true, false]) {
    for (const inSeedOnly of [true, false]) {
      const trusted = new Set<string>(inTrusted ? [ID] : []);
      const seedOnly = new Set<string>(inSeedOnly ? [ID] : []);
      const label = `trusted=${inTrusted} seedOnly=${inSeedOnly}`;
      assert.equal(
        isTrustedId(trusted, seedOnly, ID),
        inTrusted && !inSeedOnly,
        label,
      );
      assert.equal(isTrustedId(trusted, seedOnly, "01HZOTHERID"), false, label);
    }
  }
});
