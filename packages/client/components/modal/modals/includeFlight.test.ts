// Unit spec for the encrypted group include flights — run with Node's
// built-in runner:
//   node --conditions=browser --test components/modal/modals/includeFlight.test.ts
// Focus: one flight per group + friend pair. A second begin joins instead of
// starting another run, a committing flight is never dropped from outside, a
// failure stays until dismissed, every failure but a terminal one can be
// retried (a Cancel on the native confirm dialog included), and a modal
// mounting for the friend finds the flight it has to show.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TERMINAL_INCLUDE_ERROR_TYPES,
  isTerminalIncludeError,
} from "../../client/groupInclude.ts";

import {
  type IncludeFailureKind,
  type IncludeFlightEvent,
  IncludeFlights,
  includeFailureForError,
  includeFailureForOutcome,
  includeFlightKey,
  includeFlights,
} from "./includeFlight.ts";

const KEY = includeFlightKey("G1", "U1");

/** Every failure kind; the loops below run over all of them. */
const KINDS = [
  "half_done",
  "declined",
  "terminal",
] as const satisfies readonly IncludeFailureKind[];

// A kind added to IncludeFailureKind but not to KINDS fails tsc here.
type MissingKind = Exclude<IncludeFailureKind, (typeof KINDS)[number]>;
const noMissingKind: [MissingKind] extends [never] ? true : never = true;
void noMissingKind;

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
  for (const kind of KINDS) {
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
  for (const kind of KINDS) {
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
  assert.equal(flights.fail(KEY, "declined"), false);
  assert.equal(flights.get(KEY)?.phase, "failed");
  assert.equal(
    (flights.get(KEY) as { kind?: string } | undefined)?.kind,
    "terminal",
  );
});

test("fail: a detail rides on the flight and the event", () => {
  const flights = new IncludeFlights();
  flights.begin("G1", "U1");
  const events = recorded(flights);
  assert.equal(flights.fail(KEY, "half_done", "busy"), true);
  assert.deepEqual(flights.get(KEY), {
    channelId: "G1",
    userId: "U1",
    phase: "failed",
    kind: "half_done",
    detail: "busy",
  });
  assert.deepEqual(events, [
    { key: KEY, type: "failed", kind: "half_done", detail: "busy" },
  ]);
  // A Retry from it drops the detail: it described the attempt that failed.
  assert.equal(flights.retry(KEY), true);
  assert.equal(
    (flights.get(KEY) as { detail?: string } | undefined)?.detail,
    undefined,
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
    retried: "half_done",
  });
  assert.deepEqual(events, [{ key: KEY, type: "committing" }]);
  // A second Retry while that one runs joins it.
  assert.equal(flights.retry(KEY), false);
  // And it can fail again, and be retried again.
  assert.equal(flights.fail(KEY, "half_done"), true);
  assert.equal(flights.retry(KEY), true);
});

test("retry: a declined include goes back to committing and prompts again", () => {
  const flights = new IncludeFlights();
  flights.begin("G1", "U1");
  flights.fail(KEY, "declined");
  const events = recorded(flights);
  assert.equal(flights.retry(KEY), true);
  assert.deepEqual(flights.get(KEY), {
    channelId: "G1",
    userId: "U1",
    phase: "committing",
    retrying: true,
    retried: "declined",
  });
  assert.deepEqual(events, [{ key: KEY, type: "committing" }]);
  // Declined again on the new prompt: still retryable, as often as it takes.
  assert.equal(flights.fail(KEY, "declined"), true);
  assert.equal(flights.retry(KEY), true);
  assert.equal(flights.succeed(KEY), true);
});

test("retry: allowed from every kind but terminal", () => {
  for (const kind of KINDS) {
    const flights = new IncludeFlights();
    flights.begin("G1", "U1");
    flights.fail(KEY, kind);
    assert.equal(flights.retry(KEY), kind !== "terminal", kind);
    assert.equal(
      flights.get(KEY)?.phase,
      kind === "terminal" ? "failed" : "committing",
      kind,
    );
  }
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

  for (const kind of KINDS) {
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

test("declined: not a terminal include error, so Retry stays [m8]", () => {
  assert.ok(!TERMINAL_INCLUDE_ERROR_TYPES.includes("declined"));
  assert.ok(!TERMINAL_INCLUDE_ERROR_TYPES.includes("busy"));
  assert.equal(isTerminalIncludeError({ type: "declined" }), false);
  assert.equal(isTerminalIncludeError({ type: "busy" }), false);
});

test("outcome: declined is its own retryable kind, busy is retryable", () => {
  assert.deepEqual(includeFailureForOutcome("declined"), { kind: "declined" });
  assert.deepEqual(includeFailureForOutcome("busy"), {
    kind: "half_done",
    detail: "busy",
  });
  // An outcome this build does not know is never a success, nor terminal.
  assert.deepEqual(includeFailureForOutcome("later" as unknown as "busy"), {
    kind: "half_done",
  });
});

test("error: a declined or busy throw is still that outcome", () => {
  assert.deepEqual(includeFailureForError({ type: "declined" }), {
    kind: "declined",
  });
  assert.deepEqual(includeFailureForError({ type: "busy" }), {
    kind: "half_done",
    detail: "busy",
  });
  // Wrapped the way addGroupMemberEncrypted wraps native errors.
  assert.deepEqual(
    includeFailureForError(Object.assign(new Error("x"), { type: "declined" })),
    { kind: "declined" },
  );
});

test("error: the native growth gate's refusals keep their copy", () => {
  for (const field of [
    "roster_changed",
    "roster_mismatch",
    "self_user_id",
  ] as const) {
    assert.deepEqual(
      includeFailureForError({ type: "invalid_argument", field }),
      { kind: "half_done", detail: field },
      field,
    );
  }
  // Another invalid_argument field is a plain half-done failure.
  assert.deepEqual(
    includeFailureForError({ type: "invalid_argument", field: "user_id" }),
    { kind: "half_done" },
  );
  assert.deepEqual(
    includeFailureForError({
      type: "mls_store_owned_by_another_account",
      owner_user_id: "A",
      requested_user_id: "B",
    }),
    { kind: "terminal", detail: "other_account" },
  );
});

test("error: terminal only for the native tags a Retry can't fix", () => {
  for (const type of TERMINAL_INCLUDE_ERROR_TYPES) {
    assert.deepEqual(includeFailureForError({ type }), { kind: "terminal" });
  }
  for (const error of [
    new Error("network"),
    { type: "needs_bundle" },
    { type: "include_in_flight" },
    null,
    undefined,
    "text",
  ]) {
    assert.deepEqual(includeFailureForError(error), { kind: "half_done" });
  }
  const throwing = {
    get type(): string {
      throw new Error("getter");
    },
  };
  assert.deepEqual(includeFailureForError(throwing), { kind: "half_done" });
});

test("includeFlights: one shared store", () => {
  assert.ok(includeFlights instanceof IncludeFlights);
});
