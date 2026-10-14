// Unit spec for the encrypted group include flights — run with Node's
// built-in runner:
//   node --conditions=browser --test components/modal/modals/includeFlight.test.ts
// Focus: one flight per group + friend pair. A second begin joins instead of
// starting another run, a committing flight is never dropped from outside, a
// failure stays until dismissed, only a half-done failure can be retried,
// and a modal mounting for the friend finds the flight it has to show.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type IncludeFlightEvent,
  IncludeFlights,
  includeFlightKey,
  includeFlights,
} from "./includeFlight.ts";

const KEY = includeFlightKey("G1", "U1");

function recorded(flights: IncludeFlights) {
  const events: IncludeFlightEvent[] = [];
  flights.subscribe((event) => events.push(event));
  return events;
}

test("key: channel id, then user id", () => {
  assert.equal(includeFlightKey("G1", "U1"), "G1:U1");
  assert.notEqual(includeFlightKey("G1", "U2"), includeFlightKey("G2", "U1"));
});

test("begin: a fresh pair starts committing and owns the run", () => {
  const flights = new IncludeFlights();
  const events = recorded(flights);
  assert.equal(flights.get(KEY), undefined);
  assert.equal(flights.begin("G1", "U1"), true);
  assert.deepEqual(flights.get(KEY), {
    channelId: "G1",
    userId: "U1",
    phase: "committing",
    retrying: false,
  });
  assert.deepEqual(events, [{ key: KEY, type: "committing" }]);
});

test("begin: a second confirm for the same pair joins, never runs twice", () => {
  const flights = new IncludeFlights();
  flights.begin("G1", "U1");
  const events = recorded(flights);
  assert.equal(flights.begin("G1", "U1"), false);
  assert.equal(flights.get(KEY)?.phase, "committing");
  assert.deepEqual(events, []);
  // Other pairs are independent.
  assert.equal(flights.begin("G1", "U2"), true);
  assert.equal(flights.begin("G2", "U1"), true);
});

test("begin: a failed pair offers no fresh include", () => {
  for (const kind of ["half_done", "terminal"] as const) {
    const flights = new IncludeFlights();
    flights.begin("G1", "U1");
    flights.fail(KEY, kind);
    assert.equal(flights.begin("G1", "U1"), false);
    assert.deepEqual(flights.get(KEY), {
      channelId: "G1",
      userId: "U1",
      phase: "failed",
      kind,
    });
  }
});

test("fail: committing becomes failed with its kind", () => {
  for (const kind of ["half_done", "terminal"] as const) {
    const flights = new IncludeFlights();
    flights.begin("G1", "U1");
    const events = recorded(flights);
    assert.equal(flights.fail(KEY, kind), true);
    assert.deepEqual(flights.get(KEY), {
      channelId: "G1",
      userId: "U1",
      phase: "failed",
      kind,
    });
    assert.deepEqual(events, [{ key: KEY, type: "failed", kind }]);
  }
});

test("fail: only from committing", () => {
  const flights = new IncludeFlights();
  assert.equal(flights.fail(KEY, "half_done"), false);
  assert.equal(flights.get(KEY), undefined);

  flights.begin("G1", "U1");
  flights.fail(KEY, "terminal");
  // A late failure can't turn a terminal one back into a retryable one.
  assert.equal(flights.fail(KEY, "half_done"), false);
  assert.equal(flights.get(KEY)?.phase, "failed");
  assert.equal(
    (flights.get(KEY) as { kind?: string } | undefined)?.kind,
    "terminal",
  );
});

test("succeed: committing is dropped with a done event", () => {
  const flights = new IncludeFlights();
  flights.begin("G1", "U1");
  const events = recorded(flights);
  assert.equal(flights.succeed(KEY), true);
  assert.equal(flights.get(KEY), undefined);
  assert.deepEqual(events, [{ key: KEY, type: "done" }]);
  // The pair can be included again later.
  assert.equal(flights.begin("G1", "U1"), true);
});

test("succeed: never from failed or absent", () => {
  const flights = new IncludeFlights();
  assert.equal(flights.succeed(KEY), false);
  flights.begin("G1", "U1");
  flights.fail(KEY, "half_done");
  assert.equal(flights.succeed(KEY), false);
  assert.equal(flights.get(KEY)?.phase, "failed");
});

test("abandon: nobody added, dropped with its message", () => {
  const flights = new IncludeFlights();
  flights.begin("G1", "U1");
  const events = recorded(flights);
  assert.equal(flights.abandon(KEY, "Network error"), true);
  assert.equal(flights.get(KEY), undefined);
  assert.deepEqual(events, [
    { key: KEY, type: "abandoned", message: "Network error" },
  ]);

  // Never from failed: that friend may already be in the group.
  flights.begin("G1", "U1");
  flights.fail(KEY, "half_done");
  assert.equal(flights.abandon(KEY, "x"), false);
  assert.equal(flights.get(KEY)?.phase, "failed");
});

test("retry: a half-done failure goes back to committing", () => {
  const flights = new IncludeFlights();
  flights.begin("G1", "U1");
  flights.fail(KEY, "half_done");
  const events = recorded(flights);
  assert.equal(flights.retry(KEY), true);
  assert.deepEqual(flights.get(KEY), {
    channelId: "G1",
    userId: "U1",
    phase: "committing",
    retrying: true,
  });
  assert.deepEqual(events, [{ key: KEY, type: "committing" }]);
  // A second Retry while that one runs joins it.
  assert.equal(flights.retry(KEY), false);
  // And it can fail again, and be retried again.
  assert.equal(flights.fail(KEY, "half_done"), true);
  assert.equal(flights.retry(KEY), true);
});

test("retry: never from terminal, committing or absent", () => {
  const flights = new IncludeFlights();
  assert.equal(flights.retry(KEY), false);
  assert.equal(flights.get(KEY), undefined);

  flights.begin("G1", "U1");
  assert.equal(flights.retry(KEY), false);
  assert.equal(flights.get(KEY)?.phase, "committing");

  flights.fail(KEY, "terminal");
  assert.equal(flights.retry(KEY), false);
  assert.equal(flights.get(KEY)?.phase, "failed");
});

test("dismiss: a failure is dropped, a committing flight is never cut", () => {
  const flights = new IncludeFlights();
  assert.equal(flights.dismiss(KEY), false);

  flights.begin("G1", "U1");
  assert.equal(flights.dismiss(KEY), false);
  assert.equal(flights.get(KEY)?.phase, "committing");

  for (const kind of ["half_done", "terminal"] as const) {
    flights.fail(KEY, kind);
    const events = recorded(flights);
    assert.equal(flights.dismiss(KEY), true);
    assert.equal(flights.get(KEY), undefined);
    assert.deepEqual(events, [{ key: KEY, type: "dismissed" }]);
    flights.begin("G1", "U1");
  }
});

test("pickFor: the friend's failed flight first, then a committing one", () => {
  const flights = new IncludeFlights();
  assert.equal(flights.pickFor("U1"), undefined);

  flights.begin("G1", "U2");
  assert.equal(flights.pickFor("U1"), undefined);

  flights.begin("G1", "U1");
  flights.begin("G2", "U1");
  assert.equal(flights.pickFor("U1"), includeFlightKey("G1", "U1"));

  flights.fail(includeFlightKey("G2", "U1"), "half_done");
  assert.equal(flights.pickFor("U1"), includeFlightKey("G2", "U1"));

  flights.dismiss(includeFlightKey("G2", "U1"));
  flights.succeed(includeFlightKey("G1", "U1"));
  assert.equal(flights.pickFor("U1"), undefined);
  assert.equal(flights.pickFor("U2"), includeFlightKey("G1", "U2"));
});

test("subscribe: unsubscribe stops events; a throwing listener can't starve the rest", () => {
  const flights = new IncludeFlights();
  const seen: string[] = [];
  const original = console.error;
  console.error = () => {};
  try {
    flights.subscribe(() => {
      throw new Error("listener");
    });
    const off = flights.subscribe((event) => seen.push(event.type));
    flights.begin("G1", "U1");
    off();
    flights.fail(KEY, "half_done");
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, ["committing"]);
  assert.equal(flights.get(KEY)?.phase, "failed");
});

test("includeFlights: one shared store", () => {
  assert.ok(includeFlights instanceof IncludeFlights);
});
