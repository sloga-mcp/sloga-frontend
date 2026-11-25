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
// the caller fetches. An entry with no rows is refused only when it does not
// hold the whole channel (R-W4-43): a list emptied below its history has no
// row to page from, while a channel that really is empty restores as it is.
// `restorableForList` is the list's own step after the cache: a protected or
// pinned list never restores an entry with no rows.
import assert from "node:assert/strict";
import { test } from "node:test";

import { restorableEntry, restorableForList } from "./messageCacheLive.ts";

/** The shape MessageCache stores, reduced to what the guards read plus one
 * unrelated field, so identity is checked on a real object, not a copy. */
type Entry = { messages: { id: string }[]; atStart: boolean; atEnd: boolean };

const IDS = ["01MSG0001", "01MSG0002", "01MSG0003"];

function entryOf(ids: readonly string[], atStart = false): Entry {
  return { messages: ids.map((id) => ({ id })), atStart, atEnd: true };
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
  // Holding the whole channel does not excuse a purged row
  assert.equal(restorableEntry(entryOf(IDS, true), has), undefined);
});

test("an entry whose only purged message is the last one is not restorable", () => {
  const entry = entryOf(IDS);
  const { has } = recordingHas([IDS[0], IDS[1]]);

  assert.equal(restorableEntry(entry, has), undefined);
});

test("FX3U: an empty entry that does not hold the whole channel is not restorable, and has is not consulted", () => {
  const entry = entryOf([], false);
  const { has, calls } = recordingHas(IDS);

  assert.equal(restorableEntry(entry, has), undefined);
  assert.deepEqual(calls, []);
  // Whatever it says about the other end
  for (const atEnd of [true, false]) {
    assert.equal(
      restorableEntry({ messages: [], atStart: false, atEnd }, has),
      undefined,
    );
  }
  // Only a literal true says the whole channel is held
  assert.equal(restorableEntry({ messages: [] }, has), undefined);
  for (const atStart of [undefined, null, 1, "true"]) {
    assert.equal(
      restorableEntry({ messages: [], atStart: atStart as never }, has),
      undefined,
    );
  }
});

test("FX3U: an empty whole-channel entry restores", () => {
  const { has, calls } = recordingHas([]);

  for (const atEnd of [true, false]) {
    const entry: Entry = { messages: [], atStart: true, atEnd };
    assert.equal(restorableEntry(entry, has), entry);
  }
  assert.deepEqual(calls, []);
});

test("FX2U: an entry with a single live message is still restored", () => {
  const { has, calls } = recordingHas(IDS);

  for (const atStart of [false, true]) {
    const entry = entryOf([IDS[0]], atStart);
    assert.equal(restorableEntry(entry, has), entry);
  }
  assert.deepEqual(calls, [IDS[0], IDS[0]]);
});

// The load in Messages.tsx, reduced to what decides a request: the cache
// hands back an entry or nothing, the list's own step may refuse it, nothing
// means one fetch, and an empty page marks the start of the conversation.
// Leaving stores the list again with its position.
function visitor(protectedOrPinned: boolean) {
  const { has } = recordingHas([]);
  let cached: Entry | undefined;
  let fetches = 0;
  const visit = () => {
    const restored = restorableForList(
      restorableEntry(cached, has),
      protectedOrPinned,
    );
    cached = undefined;
    let atStart: boolean;
    let rows: { id: string }[];
    if (restored) {
      rows = restored.messages;
      atStart = restored.atStart;
    } else {
      fetches++;
      rows = [];
      atStart = rows.length === 0;
    }
    cached = { messages: rows, atStart, atEnd: true };
    return { rows: rows.length, atStart };
  };
  return { visit, fetches: () => fetches };
}

test("FX3U: an ordinary channel that is really empty is fetched once and restored on every later visit", () => {
  const { visit, fetches } = visitor(false);

  assert.deepEqual(visit(), { rows: 0, atStart: true });
  assert.equal(fetches(), 1);
  // Away and back, many times: the empty whole-channel entry is restored,
  // start card and all, with no further request
  for (let round = 0; round < 50; round++) {
    assert.deepEqual(visit(), { rows: 0, atStart: true });
  }
  assert.equal(fetches(), 1);
});

test("FX3U: a protected channel that is really empty fetches once per visit, never in a loop", () => {
  const { visit, fetches } = visitor(true);

  assert.deepEqual(visit(), { rows: 0, atStart: true });
  assert.equal(fetches(), 1);
  assert.deepEqual(visit(), { rows: 0, atStart: true });
  assert.equal(fetches(), 2);
});

test("FX3U: a protected or pinned list never restores an empty entry", () => {
  for (const atStart of [true, false]) {
    assert.equal(restorableForList(entryOf([], atStart), true), undefined);
    // Anything but a literal false counts as protected
    assert.equal(
      restorableForList(entryOf([], atStart), undefined as never),
      undefined,
    );
  }
  // An entry with rows is restored as the same object
  const entry = entryOf(IDS, true);
  assert.equal(restorableForList(entry, true), entry);
  const one = entryOf([IDS[0]]);
  assert.equal(restorableForList(one, true), one);
  assert.equal(restorableForList<Entry>(undefined, true), undefined);
});

test("FX3U: an ordinary list takes the cached entry as it is, empty or not", () => {
  for (const atStart of [true, false]) {
    const empty = entryOf([], atStart);
    assert.equal(restorableForList(empty, false), empty);
    const full = entryOf(IDS, atStart);
    assert.equal(restorableForList(full, false), full);
  }
  assert.equal(restorableForList<Entry>(undefined, false), undefined);
});

test("FX3U: a wipe that emptied a protected list whose start was loaded is fetched again, not restored blank", () => {
  // The entry as the list stores it after the purge: no rows, and the
  // `atStart` it had before the wipe
  const wiped: Entry = { messages: [], atStart: true, atEnd: true };
  const { has } = recordingHas([]);

  // The cache alone would hand it back ...
  const fromCache = restorableEntry(wiped, has);
  assert.equal(fromCache, wiped);
  // ... the protected list refuses it, an ordinary list keeps it
  assert.equal(restorableForList(fromCache, true), undefined);
  assert.equal(restorableForList(fromCache, false), wiped);
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
