// Unit spec for the MessageCache restore guard, run with Node's built-in
// runner from packages/client:
//   node --conditions=browser --test components/app/interface/channels/text/messageCacheLive.test.ts
//
// MessageCache keeps a channel's Message objects when its view unmounts and
// hands them back on the next mount without fetching. stoat.js purges a left
// or deleted server's messages from `client.messages`, and bulk deletes never
// reach MessageCache at all. A restored entry holding a purged Message renders
// blank rows. `restorableEntry` therefore hands an entry back only while every
// one of its message ids is still cached; anything else returns undefined so
// the caller fetches.
import assert from "node:assert/strict";
import { test } from "node:test";

import { restorableEntry } from "./messageCacheLive.ts";

/** The shape MessageCache stores, reduced to what the guard reads plus one
 * unrelated field, so identity is checked on a real object, not a copy. */
type Entry = { messages: { id: string }[]; atEnd: boolean };

const IDS = ["01MSG0001", "01MSG0002", "01MSG0003"];

function entryOf(ids: readonly string[]): Entry {
  return { messages: ids.map((id) => ({ id })), atEnd: true };
}

/** A `has` backed by a set of live ids that records every id it is asked. */
function recordingHas(live: readonly string[]) {
  const cached = new Set(live);
  const calls: string[] = [];
  const has = (id: string) => {
    calls.push(id);
    return cached.has(id);
  };
  return { has, calls };
}

test("an entry whose messages are all still cached is returned as the same object", () => {
  const entry = entryOf(IDS);
  const { has } = recordingHas(IDS);

  assert.equal(restorableEntry(entry, has), entry);
});

test("an entry with one purged message is not restorable", () => {
  const entry = entryOf(IDS);
  const { has } = recordingHas([IDS[0], IDS[2]]);

  assert.equal(restorableEntry(entry, has), undefined);
});

test("an entry whose only purged message is the last one is not restorable", () => {
  const entry = entryOf(IDS);
  const { has } = recordingHas([IDS[0], IDS[1]]);

  assert.equal(restorableEntry(entry, has), undefined);
});

test("an entry with no messages is returned without consulting has", () => {
  const entry = entryOf([]);
  const { has, calls } = recordingHas([]);

  assert.equal(restorableEntry(entry, has), entry);
  assert.deepEqual(calls, []);
});

test("a missing entry returns undefined without consulting has", () => {
  const { has, calls } = recordingHas(IDS);

  assert.equal(restorableEntry<Entry>(undefined, has), undefined);
  assert.deepEqual(calls, []);
});

test("has is consulted with every message id, in order, when all are live", () => {
  const entry = entryOf(IDS);
  const { has, calls } = recordingHas(IDS);

  assert.equal(restorableEntry(entry, has), entry);
  assert.deepEqual(calls, IDS);
});
