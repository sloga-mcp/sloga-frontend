// Unit spec for the answer policy. Run with Node's built-in runner from
// packages/client:
//   node --test --conditions=browser components/rtc/answerPolicy.test.ts
// Declared test count: 26 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: "connect" is the only verdict that may lead to a join, so the spec
// pins the full truth table and then, separately, the exact set of rows that
// answer "connect". A locked phone never connects, a server channel in Slim
// view never connects, and a press that will not join never asks for an
// unlock. `isCallEnded` reads both shapes a rejected join arrives in (the raw
// JSON text and a parsed body) and nothing else.
// `driveAnswer` is pinned by the order of the effects it calls: each test
// compares the whole list of calls, so an effect that runs early, late, twice
// or not at all fails it. The lock is asked again after an unlock, the join
// starts in the same turn as the verdict, and the ring comes down only after
// the join has connected or the server has said the ring is over.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AnswerDecision,
  answerDecision,
  driveAnswer,
  isCallEnded,
} from "./answerPolicy.ts";

/** The two channel types that can ring, so the only ones Answer may join. */
const CALL_TYPES = ["DirectMessage", "Group"] as const;

/**
 * Every other channel type the client knows, plus strings that are not a
 * channel type at all. A wrong-case name must not pass for the real one.
 */
const OTHER_TYPES = [
  "SavedMessages",
  "TextChannel",
  "VoiceChannel",
  "Thread",
  "Forum",
  "",
  "directmessage",
  "group",
] as const;

const ALL_TYPES = [...CALL_TYPES, ...OTHER_TYPES];

/** An obviously fake server id. */
const SERVER_ID = "01FAKESERVER0000000000000A";

const SERVER_IDS = [undefined, SERVER_ID] as const;
const FLAGS = [false, true] as const;

/**
 * The truth table, written out by hand. One row per combination of server,
 * Slim view and lock; `call` is the verdict for a direct message or group and
 * `other` the verdict for every other channel type.
 *
 * A direct message or group never has a server, so the three `server: true`
 * rows under `call` cannot come from a real channel. They are pinned anyway
 * so the answer for a malformed one is known: Slim view refuses it, and
 * outside Slim view it follows the lock like any other call.
 */
const TABLE: readonly {
  server: boolean;
  slim: boolean;
  locked: boolean;
  call: AnswerDecision;
  other: AnswerDecision;
}[] = [
  {
    server: false,
    slim: false,
    locked: false,
    call: "connect",
    other: "not_a_call",
  },
  {
    server: false,
    slim: false,
    locked: true,
    call: "unlock_first",
    other: "not_a_call",
  },
  {
    server: false,
    slim: true,
    locked: false,
    call: "connect",
    other: "not_a_call",
  },
  {
    server: false,
    slim: true,
    locked: true,
    call: "unlock_first",
    other: "not_a_call",
  },
  {
    server: true,
    slim: false,
    locked: false,
    call: "connect",
    other: "not_a_call",
  },
  {
    server: true,
    slim: false,
    locked: true,
    call: "unlock_first",
    other: "not_a_call",
  },
  {
    server: true,
    slim: true,
    locked: false,
    call: "blocked_slim",
    other: "blocked_slim",
  },
  {
    server: true,
    slim: true,
    locked: true,
    call: "blocked_slim",
    other: "blocked_slim",
  },
];

/** One line naming a combination, for assertion messages and row lists. */
function describeRow(
  channelType: string,
  serverId: string | undefined,
  slim: boolean,
  locked: boolean,
): string {
  return [
    channelType === "" ? "(empty)" : channelType,
    serverId ? "server" : "no server",
    slim ? "slim" : "full",
    locked ? "locked" : "unlocked",
  ].join(" / ");
}

/**
 * Every combination of channel type, server, Slim view and lock, built from
 * the value lists and not from `TABLE`, so a row missing from the table
 * cannot also go missing here.
 */
function everyCombination(): {
  channelType: string;
  serverId: string | undefined;
  slim: boolean;
  locked: boolean;
}[] {
  const rows = [];
  for (const channelType of ALL_TYPES) {
    for (const serverId of SERVER_IDS) {
      for (const slim of FLAGS) {
        for (const locked of FLAGS) {
          rows.push({ channelType, serverId, slim, locked });
        }
      }
    }
  }
  return rows;
}

test("truth table: every channel type, server, Slim view and lock combination", () => {
  // The table must hold each of the eight combinations exactly once, or a
  // duplicated row would hide a missing one.
  const combinations = new Set(
    TABLE.map((row) => `${row.server}|${row.slim}|${row.locked}`),
  );
  assert.equal(TABLE.length, 8);
  assert.equal(combinations.size, 8);

  let checked = 0;
  for (const row of TABLE) {
    const serverId = row.server ? SERVER_ID : undefined;
    for (const channelType of CALL_TYPES) {
      assert.equal(
        answerDecision({
          channelType,
          serverId,
          slim: row.slim,
          locked: row.locked,
        }),
        row.call,
        describeRow(channelType, serverId, row.slim, row.locked),
      );
      checked++;
    }
    for (const channelType of OTHER_TYPES) {
      assert.equal(
        answerDecision({
          channelType,
          serverId,
          slim: row.slim,
          locked: row.locked,
        }),
        row.other,
        describeRow(channelType, serverId, row.slim, row.locked),
      );
      checked++;
    }
  }

  // Ten channel types by eight combinations. A loop that ran over nothing
  // would otherwise pass.
  assert.equal(checked, 80);
});

test("connect is answered in exactly the six rows the rules allow", () => {
  const rows = everyCombination();
  assert.equal(rows.length, 80);

  const connects = rows
    .filter((row) => answerDecision(row) === "connect")
    .map((row) =>
      describeRow(row.channelType, row.serverId, row.slim, row.locked),
    );

  assert.deepEqual(connects, [
    "DirectMessage / no server / full / unlocked",
    "DirectMessage / no server / slim / unlocked",
    "DirectMessage / server / full / unlocked",
    "Group / no server / full / unlocked",
    "Group / no server / slim / unlocked",
    "Group / server / full / unlocked",
  ]);
});

test("a locked phone never connects", () => {
  let checked = 0;
  for (const row of everyCombination()) {
    if (!row.locked) continue;
    assert.notEqual(
      answerDecision(row),
      "connect",
      describeRow(row.channelType, row.serverId, row.slim, row.locked),
    );
    checked++;
  }
  assert.equal(checked, 40);

  // The ordinary case: a direct message or group ringing a locked phone
  // unlocks first, in Slim view and out of it.
  for (const channelType of CALL_TYPES) {
    for (const slim of FLAGS) {
      assert.equal(
        answerDecision({ channelType, slim, locked: true }),
        "unlock_first",
        describeRow(channelType, undefined, slim, true),
      );
    }
  }
});

test("a server channel in Slim view never connects, whatever its type", () => {
  let checked = 0;
  for (const channelType of ALL_TYPES) {
    for (const locked of FLAGS) {
      assert.equal(
        answerDecision({
          channelType,
          serverId: SERVER_ID,
          slim: true,
          locked,
        }),
        "blocked_slim",
        describeRow(channelType, SERVER_ID, true, locked),
      );
      checked++;
    }
  }
  assert.equal(checked, 20);
});

test("Slim view by itself blocks nothing: a direct message or group still answers", () => {
  for (const channelType of CALL_TYPES) {
    assert.equal(
      answerDecision({ channelType, slim: true, locked: false }),
      "connect",
      channelType,
    );
    assert.equal(
      answerDecision({
        channelType,
        serverId: undefined,
        slim: true,
        locked: false,
      }),
      "connect",
      channelType,
    );
  }
});

test("a press that will not join does not ask for an unlock", () => {
  // The lock is the last rule. Unlocking the phone for a channel that is
  // then refused would be an unlock for nothing.
  for (const channelType of OTHER_TYPES) {
    assert.equal(
      answerDecision({ channelType, slim: false, locked: true }),
      "not_a_call",
      channelType,
    );
    assert.equal(
      answerDecision({
        channelType,
        serverId: SERVER_ID,
        slim: false,
        locked: true,
      }),
      "not_a_call",
      channelType,
    );
  }
  for (const channelType of ALL_TYPES) {
    assert.equal(
      answerDecision({
        channelType,
        serverId: SERVER_ID,
        slim: true,
        locked: true,
      }),
      "blocked_slim",
      channelType,
    );
  }
});

test("an empty server id is no server", () => {
  // stoat.js reads a channel's server the same way (`if (this.serverId)`),
  // so an empty string must not turn a direct message into a server channel.
  for (const channelType of CALL_TYPES) {
    assert.equal(
      answerDecision({ channelType, serverId: "", slim: true, locked: false }),
      "connect",
      channelType,
    );
    assert.equal(
      answerDecision({ channelType, serverId: "", slim: true, locked: true }),
      "unlock_first",
      channelType,
    );
  }
});

test("a lock state that is not a boolean counts as locked", () => {
  // The lock state is asked from the device at the moment of the press. If
  // that answer comes back as anything but `false`, the phone is treated as
  // locked: an unreadable lock state must never read as an unlocked phone.
  for (const locked of [undefined, null, 0, "", "false", "no", {}]) {
    for (const channelType of CALL_TYPES) {
      assert.equal(
        answerDecision({
          channelType,
          slim: false,
          locked: locked as unknown as boolean,
        }),
        "unlock_first",
        `${channelType} / locked = ${JSON.stringify(locked)}`,
      );
    }
  }
});

test("isCallEnded: the server's CallEnded body, parsed or as raw text", () => {
  // stoat.js rejects a failed join with the response body as a string.
  assert.equal(isCallEnded('{"type":"CallEnded"}'), true);
  assert.equal(isCallEnded('{"type":"CallEnded","location":"x"}'), true);
  assert.equal(isCallEnded(' {"type": "CallEnded"}\n'), true);

  // An already-parsed body reads the same.
  assert.equal(isCallEnded({ type: "CallEnded" }), true);
  assert.equal(isCallEnded({ type: "CallEnded", location: "x" }), true);
});

test("isCallEnded: another error type is not the ring ending", () => {
  for (const type of [
    "NotAVoiceChannel",
    "MissingPermission",
    "CannotJoinCall",
    "LiveKitUnavailable",
    "FailedValidation",
    "callended",
    "CALLENDED",
    "CallEnded ",
    "CallEndedEarly",
    "",
  ]) {
    assert.equal(isCallEnded({ type }), false, `object ${type}`);
    assert.equal(isCallEnded(JSON.stringify({ type })), false, `text ${type}`);
  }
});

test("isCallEnded: text that is not a CallEnded body", () => {
  // The bare word is not a response body.
  assert.equal(isCallEnded("CallEnded"), false);
  assert.equal(isCallEnded('"CallEnded"'), false);
  assert.equal(isCallEnded("type: CallEnded"), false);
  assert.equal(isCallEnded(""), false);
  assert.equal(isCallEnded("null"), false);
  // Cut-off JSON, for example a connection dropped mid-body.
  assert.equal(isCallEnded('{"type":"CallEnded"'), false);
  // A proxy's error page, even one that happens to hold the body's text.
  assert.equal(isCallEnded("<html><body>502 Bad Gateway</body></html>"), false);
  assert.equal(
    isCallEnded('<html><body>{"type":"CallEnded"}</body></html>'),
    false,
  );
  // The type must be the body's own, not a nested or listed one.
  assert.equal(isCallEnded('{"error":{"type":"CallEnded"}}'), false);
  assert.equal(isCallEnded('[{"type":"CallEnded"}]'), false);
  assert.equal(isCallEnded('["CallEnded"]'), false);
  assert.equal(isCallEnded('{"type":123}'), false);
  assert.equal(isCallEnded('{"type":null}'), false);
  assert.equal(isCallEnded('{"kind":"CallEnded"}'), false);
});

test("isCallEnded: values that are not an API error", () => {
  assert.equal(isCallEnded(null), false);
  assert.equal(isCallEnded(undefined), false);
  assert.equal(isCallEnded(new Error("CallEnded")), false);
  assert.equal(isCallEnded(new TypeError("Failed to fetch")), false);
  assert.equal(isCallEnded({ type: 123 }), false);
  assert.equal(isCallEnded({ type: null }), false);
  assert.equal(isCallEnded({ type: ["CallEnded"] }), false);
  assert.equal(isCallEnded({ type: { type: "CallEnded" } }), false);
  assert.equal(isCallEnded({ error: { type: "CallEnded" } }), false);
  assert.equal(isCallEnded({ name: "CallEnded" }), false);
  assert.equal(isCallEnded({ message: "CallEnded" }), false);
  assert.equal(isCallEnded({}), false);
  assert.equal(isCallEnded([{ type: "CallEnded" }]), false);
  assert.equal(isCallEnded(["CallEnded"]), false);
  assert.equal(isCallEnded(0), false);
  assert.equal(isCallEnded(42), false);
  assert.equal(isCallEnded(true), false);
});

/** The effects `driveAnswer` takes. */
type AnswerEffects = Parameters<typeof driveAnswer>[0];

/**
 * The verdict for a ringing direct message outside Slim view: the real
 * policy with the channel and Slim facts bound, the way a caller binds them.
 */
function decideForDm(locked: boolean): AnswerDecision {
  return answerDecision({ channelType: "DirectMessage", slim: false, locked });
}

/**
 * A full set of effects that writes every call to `log`, in the order the
 * calls are made. An effect given in `parts` answers for itself. The rest
 * answer the plain case: an unlocked phone, a ringing direct message, an
 * unlock that works and a join that connects.
 */
function rig(
  parts: Partial<AnswerEffects> = {},
  log: string[] = [],
): { fx: AnswerEffects; log: string[] } {
  const fx: AnswerEffects = {
    isLocked() {
      log.push("isLocked");
      return parts.isLocked ? parts.isLocked() : Promise.resolve(false);
    },
    decide(locked) {
      log.push(`decide(${String(locked)})`);
      return parts.decide ? parts.decide(locked) : decideForDm(locked);
    },
    ensureUnlocked() {
      log.push("ensureUnlocked");
      return parts.ensureUnlocked
        ? parts.ensureUnlocked()
        : Promise.resolve(true);
    },
    connect() {
      log.push("connect");
      return parts.connect ? parts.connect() : Promise.resolve(true);
    },
    onEnded() {
      log.push("onEnded");
      parts.onEnded?.();
    },
    dismiss(reason) {
      log.push(`dismiss(${reason})`);
      parts.dismiss?.(reason);
    },
  };
  return { fx, log };
}

/**
 * An effect that gives the next of `answers` each time it is called, and the
 * last one from then on.
 */
function eachTime<T>(...answers: (() => T)[]): () => T {
  let calls = 0;
  return () => answers[Math.min(calls++, answers.length - 1)]();
}

/** A promise that rejects with `reason`, whatever kind of value that is. */
function rejects<T>(reason: unknown): Promise<T> {
  return new Promise<T>((_resolve, reject) => reject(reason));
}

/** A value of the wrong type, for an effect that does not keep its promise. */
function wrong<T>(value: unknown): T {
  return value as T;
}

/** The calls of a press that asked the lock, was told to unlock and did. */
const UNLOCKED_THEN_ASKED_AGAIN = [
  "isLocked",
  "decide(true)",
  "ensureUnlocked",
  "isLocked",
] as const;

test("driveAnswer: an unlocked phone joins, then the ring comes down as answered", async () => {
  const { fx, log } = rig();

  assert.equal(await driveAnswer(fx), "joined");
  assert.deepEqual(log, [
    "isLocked",
    "decide(false)",
    "connect",
    "dismiss(answered)",
  ]);
});

test("driveAnswer: a lock query that fails, or answers anything but false, counts as locked", async () => {
  const failures: [string, () => Promise<boolean>][] = [
    ["rejects", () => rejects(new Error("keyguard query failed"))],
    [
      "throws",
      () => {
        throw new Error("no keyguard service");
      },
    ],
    ["undefined", () => Promise.resolve(wrong<boolean>(undefined))],
    ["null", () => Promise.resolve(wrong<boolean>(null))],
    ["0", () => Promise.resolve(wrong<boolean>(0))],
    ["empty text", () => Promise.resolve(wrong<boolean>(""))],
    ["the text false", () => Promise.resolve(wrong<boolean>("false"))],
  ];

  for (const [name, isLocked] of failures) {
    // The unlock is refused, so the press stops right after the first
    // verdict and the log shows what that verdict was decided on.
    const { fx, log } = rig({
      isLocked,
      ensureUnlocked: () => Promise.resolve(false),
    });

    assert.equal(await driveAnswer(fx), "unlock_cancelled", name);
    assert.deepEqual(log, ["isLocked", "decide(true)", "ensureUnlocked"], name);
  }
});

test("driveAnswer: a blocked verdict ends the press and nothing else runs", async () => {
  for (const verdict of ["blocked_slim", "not_a_call"] as const) {
    for (const locked of [false, true]) {
      const { fx, log } = rig({
        isLocked: () => Promise.resolve(locked),
        decide: () => verdict,
      });

      assert.equal(await driveAnswer(fx), "blocked", `${verdict} / ${locked}`);
      assert.deepEqual(
        log,
        ["isLocked", `decide(${locked})`],
        `${verdict} / ${locked}`,
      );
    }
  }

  // The same through the real policy: a server channel in Slim view, and a
  // channel that cannot ring, both on a locked phone. Neither asks for an
  // unlock.
  const bound: [string, (locked: boolean) => AnswerDecision][] = [
    [
      "server channel in Slim view",
      (locked) =>
        answerDecision({
          channelType: "TextChannel",
          serverId: SERVER_ID,
          slim: true,
          locked,
        }),
    ],
    [
      "saved messages",
      (locked) =>
        answerDecision({ channelType: "SavedMessages", slim: false, locked }),
    ],
  ];
  for (const [name, decide] of bound) {
    const { fx, log } = rig({ isLocked: () => Promise.resolve(true), decide });

    assert.equal(await driveAnswer(fx), "blocked", name);
    assert.deepEqual(log, ["isLocked", "decide(true)"], name);
  }

  // Only the exact verdict "connect" joins. A verdict the driver does not
  // know is no permission to join.
  for (const verdict of [undefined, null, "", "Connect", "join", true]) {
    const { fx, log } = rig({ decide: () => wrong<AnswerDecision>(verdict) });

    assert.equal(await driveAnswer(fx), "blocked", JSON.stringify(verdict));
    assert.deepEqual(log, ["isLocked", "decide(false)"]);
  }
});

test("driveAnswer: an unlock that is cancelled or fails leaves the ring as it is", async () => {
  const unlocks: [string, () => Promise<boolean>][] = [
    ["false", () => Promise.resolve(false)],
    ["rejects", () => rejects(new Error("unlock dismissed"))],
    [
      "throws",
      () => {
        throw new Error("no activity to unlock from");
      },
    ],
    ["undefined", () => Promise.resolve(wrong<boolean>(undefined))],
    ["1", () => Promise.resolve(wrong<boolean>(1))],
    ["the text true", () => Promise.resolve(wrong<boolean>("true"))],
  ];

  for (const [name, ensureUnlocked] of unlocks) {
    // The lock would read as open if it were asked again, so only the
    // unlock's own answer stands between this press and a join.
    const { fx, log } = rig({
      isLocked: eachTime(
        () => Promise.resolve(true),
        () => Promise.resolve(false),
      ),
      ensureUnlocked,
    });

    assert.equal(await driveAnswer(fx), "unlock_cancelled", name);
    // No second lock query, no join, and the ring is not touched.
    assert.deepEqual(log, ["isLocked", "decide(true)", "ensureUnlocked"], name);
  }
});

test("driveAnswer: after an unlock the lock is asked again and decided again", async () => {
  const { fx, log } = rig({
    isLocked: eachTime(
      () => Promise.resolve(true),
      () => Promise.resolve(false),
    ),
  });

  assert.equal(await driveAnswer(fx), "joined");
  assert.deepEqual(log, [
    ...UNLOCKED_THEN_ASKED_AGAIN,
    "decide(false)",
    "connect",
    "dismiss(answered)",
  ]);
});

test("driveAnswer: a phone still locked after the unlock does not join", async () => {
  const stillLocked: [string, () => Promise<boolean>][] = [
    ["locked again", () => Promise.resolve(true)],
    ["second lock query rejects", () => rejects(new Error("query failed"))],
    ["second lock query unreadable", () => Promise.resolve(wrong<boolean>({}))],
  ];

  for (const [name, second] of stillLocked) {
    // The unlock says it worked, and the lock still reads as locked.
    const { fx, log } = rig({
      isLocked: eachTime(() => Promise.resolve(true), second),
      ensureUnlocked: () => Promise.resolve(true),
    });

    assert.equal(await driveAnswer(fx), "unlock_cancelled", name);
    // The unlock is asked for once, never a second time, and nothing joins.
    assert.deepEqual(log, [...UNLOCKED_THEN_ASKED_AGAIN, "decide(true)"], name);
  }
});

test("driveAnswer: a blocked verdict after the unlock does not join", async () => {
  for (const fresh of ["blocked_slim", "not_a_call"] as const) {
    // The first verdict asks for an unlock. By the time the phone is open
    // the facts have changed and the fresh verdict refuses.
    const { fx, log } = rig({
      isLocked: eachTime(
        () => Promise.resolve(true),
        () => Promise.resolve(false),
      ),
      decide: eachTime<AnswerDecision>(
        () => "unlock_first",
        () => fresh,
      ),
    });

    assert.equal(await driveAnswer(fx), "blocked", fresh);
    assert.deepEqual(log, [...UNLOCKED_THEN_ASKED_AGAIN, "decide(false)"]);
  }
});

test("driveAnswer: the join starts in the same turn as the connect verdict", async () => {
  for (const startsLocked of [false, true]) {
    const log: string[] = [];
    let verdictGiven = false;
    const firstAnswers = eachTime(
      () => startsLocked,
      () => false,
    );

    const { fx } = rig(
      {
        // Once the verdict is "connect" the phone locks again. A driver that
        // asked the lock once more before joining would see it, and the log
        // would show the extra query.
        isLocked: () => Promise.resolve(verdictGiven ? true : firstAnswers()),
        decide(locked) {
          const verdict = decideForDm(locked);
          if (verdict === "connect") {
            verdictGiven = true;
            // Runs as soon as the current turn ends. If anything is awaited
            // between the verdict and the join, this lands before "connect".
            queueMicrotask(() => log.push("turn over"));
          }
          return verdict;
        },
      },
      log,
    );

    assert.equal(await driveAnswer(fx), "joined", `locked: ${startsLocked}`);
    assert.deepEqual(
      log,
      [
        ...(startsLocked
          ? [...UNLOCKED_THEN_ASKED_AGAIN, "decide(false)"]
          : ["isLocked", "decide(false)"]),
        "connect",
        "turn over",
        "dismiss(answered)",
      ],
      `locked: ${startsLocked}`,
    );
  }
});

test("driveAnswer: the ring stays up until the join has connected", async () => {
  let settle: (joined: boolean) => void = () => {};
  const joining = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const { fx, log } = rig({ connect: () => joining });

  const pressed = driveAnswer(fx);

  // Give everything that can run before the join settles the time to run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(log, ["isLocked", "decide(false)", "connect"]);

  settle(true);
  assert.equal(await pressed, "joined");
  assert.deepEqual(log, [
    "isLocked",
    "decide(false)",
    "connect",
    "dismiss(answered)",
  ]);
});

test("driveAnswer: a join that does not connect is a failure and the ring stays up", async () => {
  // False is the store refusing the join or a newer join taking its place.
  // The other values are a join that did not say it connected.
  for (const joined of [false, undefined, null, 1, "true", {}]) {
    const { fx, log } = rig({
      connect: () => Promise.resolve(wrong<boolean>(joined)),
    });

    assert.equal(await driveAnswer(fx), "failed", JSON.stringify(joined));
    assert.deepEqual(
      log,
      ["isLocked", "decide(false)", "connect"],
      JSON.stringify(joined),
    );
  }
});

test("driveAnswer: a CallEnded refusal reports the ring as over, then takes it down", async () => {
  // The raw response text is what the client really rejects with. A parsed
  // body reads the same.
  for (const refusal of ['{"type":"CallEnded"}', { type: "CallEnded" }]) {
    const { fx, log } = rig({ connect: () => rejects(refusal) });

    assert.equal(await driveAnswer(fx), "ended", JSON.stringify(refusal));
    assert.deepEqual(
      log,
      ["isLocked", "decide(false)", "connect", "onEnded", "dismiss(ended)"],
      JSON.stringify(refusal),
    );
  }

  // The same after an unlock.
  const { fx, log } = rig({
    isLocked: eachTime(
      () => Promise.resolve(true),
      () => Promise.resolve(false),
    ),
    connect: () => rejects('{"type":"CallEnded"}'),
  });

  assert.equal(await driveAnswer(fx), "ended");
  assert.deepEqual(log, [
    ...UNLOCKED_THEN_ASKED_AGAIN,
    "decide(false)",
    "connect",
    "onEnded",
    "dismiss(ended)",
  ]);
});

test("driveAnswer: any other refused or broken join is a failure and the ring stays up", async () => {
  const unreadable = {
    get type(): string {
      throw new Error("unreadable");
    },
  };
  const joins: [string, () => Promise<boolean>][] = [
    ["network error", () => rejects(new TypeError("Failed to fetch"))],
    ["plain error", () => rejects(new Error("CallEnded"))],
    ["another type, text", () => rejects('{"type":"MissingPermission"}')],
    ["another type, parsed", () => rejects({ type: "CannotJoinCall" })],
    ["the bare word", () => rejects("CallEnded")],
    ["a proxy page", () => rejects("<html>502 Bad Gateway</html>")],
    ["undefined", () => rejects(undefined)],
    ["null", () => rejects(null)],
    ["a refusal that cannot be read", () => rejects(unreadable)],
    [
      "throws before any promise",
      () => {
        throw new Error("no voice store");
      },
    ],
  ];

  for (const [name, connect] of joins) {
    const { fx, log } = rig({ connect });

    assert.equal(await driveAnswer(fx), "failed", name);
    assert.deepEqual(log, ["isLocked", "decide(false)", "connect"], name);
  }
});

test("driveAnswer: a throwing onEnded or dismiss does not change the result", async () => {
  const boom = () => {
    throw new Error("the ring could not be taken down");
  };

  const joined = rig({ dismiss: boom });
  assert.equal(await driveAnswer(joined.fx), "joined");
  assert.deepEqual(joined.log, [
    "isLocked",
    "decide(false)",
    "connect",
    "dismiss(answered)",
  ]);

  const ended: [string, Partial<AnswerEffects>][] = [
    // A throwing onEnded must not keep the ring up: dismiss still runs.
    ["onEnded throws", { onEnded: boom }],
    ["dismiss throws", { dismiss: boom }],
    ["both throw", { onEnded: boom, dismiss: boom }],
  ];
  for (const [name, parts] of ended) {
    const { fx, log } = rig({
      ...parts,
      connect: () => rejects('{"type":"CallEnded"}'),
    });

    assert.equal(await driveAnswer(fx), "ended", name);
    assert.deepEqual(
      log,
      ["isLocked", "decide(false)", "connect", "onEnded", "dismiss(ended)"],
      name,
    );
  }
});

test("driveAnswer: a decision that throws starts no join and does not reject", async () => {
  const boom = (): AnswerDecision => {
    throw new Error("no such channel");
  };

  const first = rig({ decide: boom });
  assert.equal(await driveAnswer(first.fx), "failed");
  assert.deepEqual(first.log, ["isLocked", "decide(false)"]);

  // The same when it is the decision after the unlock that throws.
  const second = rig({
    isLocked: eachTime(
      () => Promise.resolve(true),
      () => Promise.resolve(false),
    ),
    decide: eachTime<AnswerDecision>(() => "unlock_first", boom),
  });
  assert.equal(await driveAnswer(second.fx), "failed");
  assert.deepEqual(second.log, [...UNLOCKED_THEN_ASKED_AGAIN, "decide(false)"]);
});
