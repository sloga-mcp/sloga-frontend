// Unit spec for the outgoing-ring policy. Run with Node's built-in runner:
//   node --test --conditions=browser components/rtc/outgoingRingPolicy.test.ts
// Focus: the caller rings exactly when their join opens a DM/Group call and
// that join was not an Answer, every signalled end of ringing (answer,
// cancel) maps to a stop, the caller only ever hangs up by itself in a
// direct message that this device opened and that nobody else has joined,
// someone who answered into an empty call is taken out of it after a short
// grace, and neither of those two decisions acts on a missing or malformed
// fact.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import {
  type AnswererAloneOutcome,
  type CallerRingOutcome,
  ANSWER_ALONE_GRACE_MS,
  answererAloneOutcome,
  CALLER_HANGUP_GRACE_MS,
  callerRingOutcome,
  isRingableChannelType,
  outgoingRingOnVoiceJoin,
  outgoingRingOnVoiceLeave,
} from "./outgoingRingPolicy.ts";

const CHANNEL_TYPES = [
  "DirectMessage",
  "Group",
  "TextChannel",
  "VoiceChannel",
  "SavedMessages",
];
const BOOLS = [false, true];

test("only DM and Group channels are ringable", () => {
  assert.equal(isRingableChannelType("DirectMessage"), true);
  assert.equal(isRingableChannelType("Group"), true);
  // Server voice channels summon no one — joining one must never ring, which
  // was easy to get wrong because the SAME join event fires for them.
  assert.equal(isRingableChannelType("VoiceChannel"), false);
  assert.equal(isRingableChannelType("TextChannel"), false);
  assert.equal(isRingableChannelType("SavedMessages"), false);
});

test("our join that opens the call rings the outgoing leg", () => {
  for (const channelType of ["DirectMessage", "Group"] as const) {
    assert.equal(
      outgoingRingOnVoiceJoin({
        channelType,
        joinerIsSelf: true,
        selfIsParticipant: true,
        participantCount: 1,
        joinedAsAnswer: false,
      }),
      "play",
      channelType,
    );
  }
});

test("our join into an ongoing call is answering, not calling", () => {
  // Answering must stop any ring (this is the path that kills the INCOMING
  // ring when we accept) — playing the outgoing ring here would ring INTO
  // the live call.
  assert.equal(
    outgoingRingOnVoiceJoin({
      channelType: "DirectMessage",
      joinerIsSelf: true,
      selfIsParticipant: true,
      participantCount: 2,
      joinedAsAnswer: false,
    }),
    "stop",
  );
});

test("our own join that reports an empty roster stops the ring and never starts one", () => {
  // The roster is read after the join was applied, so it should hold at
  // least us. Only a roster of exactly one counts as opening a call. If it
  // reads as empty, our join is treated like any join that did not open a
  // call: a stop in a ringable channel, and nothing anywhere else.
  let checked = 0;
  for (const channelType of CHANNEL_TYPES) {
    for (const selfIsParticipant of BOOLS) {
      const input = {
        channelType,
        joinerIsSelf: true,
        selfIsParticipant,
        participantCount: 0,
        joinedAsAnswer: false,
      };
      assert.equal(
        outgoingRingOnVoiceJoin(input),
        isRingableChannelType(channelType) ? "stop" : "none",
        JSON.stringify(input),
      );
      checked++;
    }
  }
  assert.equal(checked, 10);
});

test("the callee answering stops the outgoing ring", () => {
  // Their join arrives with us already in the roster: participantCount 2 in
  // a DM, more in a group call.
  assert.equal(
    outgoingRingOnVoiceJoin({
      channelType: "DirectMessage",
      joinerIsSelf: false,
      selfIsParticipant: true,
      participantCount: 2,
      joinedAsAnswer: false,
    }),
    "stop",
  );
  // A later joiner of an ongoing group call also lands here — stop must be
  // the action (a harmless no-op), never "play".
  assert.equal(
    outgoingRingOnVoiceJoin({
      channelType: "Group",
      joinerIsSelf: false,
      selfIsParticipant: true,
      participantCount: 3,
      joinedAsAnswer: false,
    }),
    "stop",
  );
});

test("a call we are not in is the incoming side's business", () => {
  // Someone ringing US must not touch the outgoing leg — the incoming ring
  // and popup are NotificationsWorker's own path.
  assert.equal(
    outgoingRingOnVoiceJoin({
      channelType: "DirectMessage",
      joinerIsSelf: false,
      selfIsParticipant: false,
      participantCount: 1,
      joinedAsAnswer: false,
    }),
    "none",
  );
});

test("server voice channel joins never ring, even our own solo join", () => {
  assert.equal(
    outgoingRingOnVoiceJoin({
      channelType: "VoiceChannel",
      joinerIsSelf: true,
      selfIsParticipant: true,
      participantCount: 1,
      joinedAsAnswer: false,
    }),
    "none",
  );
});

test("our Answer join that leaves us alone stops the ring instead of starting one", () => {
  // The caller hung up between our press and our join, so the roster holds
  // only us. Without the answer flag this is exactly the "we opened the call"
  // shape, and the answerer would hear an outgoing ring.
  for (const channelType of ["DirectMessage", "Group"]) {
    assert.equal(
      outgoingRingOnVoiceJoin({
        channelType,
        joinerIsSelf: true,
        selfIsParticipant: true,
        participantCount: 1,
        joinedAsAnswer: true,
      }),
      "stop",
      channelType,
    );
  }
});

test("our Answer join is a stop for every roster size", () => {
  let checked = 0;
  for (const channelType of ["DirectMessage", "Group"]) {
    for (const selfIsParticipant of BOOLS) {
      for (const participantCount of [0, 1, 2, 3, 10]) {
        const input = {
          channelType,
          joinerIsSelf: true,
          selfIsParticipant,
          participantCount,
          joinedAsAnswer: true,
        };
        assert.equal(
          outgoingRingOnVoiceJoin(input),
          "stop",
          JSON.stringify(input),
        );
        checked++;
      }
    }
  }
  assert.equal(checked, 20);
});

test("no join event plays the ring while joinedAsAnswer is set", () => {
  let checked = 0;
  for (const channelType of CHANNEL_TYPES) {
    for (const joinerIsSelf of BOOLS) {
      for (const selfIsParticipant of BOOLS) {
        for (const participantCount of [0, 1, 2, 3, 10]) {
          const input = {
            channelType,
            joinerIsSelf,
            selfIsParticipant,
            participantCount,
            joinedAsAnswer: true,
          };
          assert.notEqual(
            outgoingRingOnVoiceJoin(input),
            "play",
            JSON.stringify(input),
          );
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 100);
});

test("joinedAsAnswer only matters for our own join into a ringable channel", () => {
  // A remote join, and any join in a channel that rings nobody, must answer
  // the same with the flag on or off.
  let checked = 0;
  for (const channelType of CHANNEL_TYPES) {
    for (const joinerIsSelf of BOOLS) {
      if (joinerIsSelf && isRingableChannelType(channelType)) continue;
      for (const selfIsParticipant of BOOLS) {
        for (const participantCount of [1, 2, 3]) {
          const input = {
            channelType,
            joinerIsSelf,
            selfIsParticipant,
            participantCount,
          };
          assert.equal(
            outgoingRingOnVoiceJoin({ ...input, joinedAsAnswer: true }),
            outgoingRingOnVoiceJoin({ ...input, joinedAsAnswer: false }),
            JSON.stringify(input),
          );
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 48);
});

test("our own leave cancels the outgoing ring", () => {
  assert.equal(
    outgoingRingOnVoiceLeave({
      channelType: "DirectMessage",
      leaverIsSelf: true,
    }),
    "stop",
  );
  assert.equal(
    outgoingRingOnVoiceLeave({ channelType: "Group", leaverIsSelf: true }),
    "stop",
  );
});

test("remote leaves and non-ringable channels leave the ring alone", () => {
  assert.equal(
    outgoingRingOnVoiceLeave({
      channelType: "DirectMessage",
      leaverIsSelf: false,
    }),
    "none",
  );
  assert.equal(
    outgoingRingOnVoiceLeave({
      channelType: "VoiceChannel",
      leaverIsSelf: true,
    }),
    "none",
  );
});

const RING_MS = 45_000;

/** A direct-message call this device opened that is still ringing. */
const RINGING = {
  channelType: "DirectMessage",
  openedCall: true,
  joinedAsAnswer: false,
  remoteEverJoined: false,
  rejoining: false,
  elapsedMs: 0,
  ringMs: RING_MS,
  declined: false,
};

/** Times before the ring length has passed, and times at or after it. */
const BEFORE_RING_END = [0, 1, RING_MS - 1];
const AT_OR_AFTER_RING_END = [RING_MS, RING_MS + 1, RING_MS * 10];
const ALL_TIMES = [...BEFORE_RING_END, ...AT_OR_AFTER_RING_END];

/** Values that are not the boolean true. Several of them are truthy. */
const NOT_TRUE = [undefined, null, false, 0, "", NaN, 1, "true", "yes", {}, []];

/** Values that are not the boolean false. Several of them are falsy. */
const NOT_FALSE = [undefined, null, 0, "", NaN, true, 1, "false", "no", {}, []];

/** Values that are not a ring length: not a finite number above zero. */
const BAD_RING_MS = [
  0,
  -0,
  -1,
  -RING_MS,
  NaN,
  Infinity,
  -Infinity,
  undefined,
  null,
  "45000",
  true,
  {},
];

/** Values that are not an elapsed time: not a finite number of at least 0. */
const BAD_ELAPSED_MS = [
  -1,
  -0.5,
  -RING_MS,
  NaN,
  Infinity,
  -Infinity,
  undefined,
  null,
  "0",
  "45000",
  true,
  {},
];

/**
 * Calls `callerRingOutcome` with facts of any type. The real caller is type
 * checked, but a value that was never set still arrives as undefined at run
 * time, and the decision has to hold then too.
 */
function callerOutcomeOf(input: Record<string, unknown>): CallerRingOutcome {
  return callerRingOutcome(
    input as unknown as Parameters<typeof callerRingOutcome>[0],
  );
}

/** A copy of the facts with one key left out altogether. */
function without(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([name]) => name !== key),
  );
}

/** The same for `answererAloneOutcome`. */
function answererOutcomeOf(
  input: Record<string, unknown>,
): AnswererAloneOutcome {
  return answererAloneOutcome(
    input as unknown as Parameters<typeof answererAloneOutcome>[0],
  );
}

test("a ringing direct-message call waits, then hangs up when the ring length is reached", () => {
  assert.equal(callerRingOutcome({ ...RINGING, elapsedMs: 0 }), "wait");
  assert.equal(
    callerRingOutcome({ ...RINGING, elapsedMs: RING_MS - 1 }),
    "wait",
  );
  // The boundary itself is a hang-up: the ring may run for ringMs, not longer.
  assert.equal(
    callerRingOutcome({ ...RINGING, elapsedMs: RING_MS }),
    "hangup_no_answer",
  );
  assert.equal(
    callerRingOutcome({ ...RINGING, elapsedMs: RING_MS + 1 }),
    "hangup_no_answer",
  );
});

test("the ring length is the one passed in, not a fixed 45 s", () => {
  assert.equal(
    callerRingOutcome({ ...RINGING, ringMs: 5_000, elapsedMs: 4_999 }),
    "wait",
  );
  assert.equal(
    callerRingOutcome({ ...RINGING, ringMs: 5_000, elapsedMs: 5_000 }),
    "hangup_no_answer",
  );
  assert.equal(
    callerRingOutcome({ ...RINGING, ringMs: 120_000, elapsedMs: 45_000 }),
    "wait",
  );
  assert.equal(
    callerRingOutcome({ ...RINGING, ringMs: 120_000, elapsedMs: 119_999 }),
    "wait",
  );
  assert.equal(
    callerRingOutcome({ ...RINGING, ringMs: 120_000, elapsedMs: 120_000 }),
    "hangup_no_answer",
  );
});

test("the caller's grace is ten seconds and is added by whoever passes ringMs", () => {
  assert.equal(CALLER_HANGUP_GRACE_MS, 10_000);

  // Passed the bare ring length, the decision hangs up at the ring length.
  // It adds nothing of its own.
  assert.equal(
    callerRingOutcome({ ...RINGING, ringMs: RING_MS, elapsedMs: RING_MS }),
    "hangup_no_answer",
  );

  // Passed the ring length plus the grace, it waits through the grace.
  const withGrace = RING_MS + CALLER_HANGUP_GRACE_MS;
  assert.equal(
    callerRingOutcome({ ...RINGING, ringMs: withGrace, elapsedMs: RING_MS }),
    "wait",
  );
  assert.equal(
    callerRingOutcome({
      ...RINGING,
      ringMs: withGrace,
      elapsedMs: withGrace - 1,
    }),
    "wait",
  );
  assert.equal(
    callerRingOutcome({ ...RINGING, ringMs: withGrace, elapsedMs: withGrace }),
    "hangup_no_answer",
  );
});

test("a decline hangs up at once and is reported as a decline, not a timeout", () => {
  for (const elapsedMs of ALL_TIMES) {
    assert.equal(
      callerRingOutcome({ ...RINGING, declined: true, elapsedMs }),
      "hangup_declined",
      String(elapsedMs),
    );
  }
});

test("declined counts only when it is exactly true", () => {
  // A truthy value that is not the boolean true is not a decline. The ring
  // then ends only the way an undeclined ring does, by running out.
  let checked = 0;
  for (const declined of NOT_TRUE) {
    for (const elapsedMs of BEFORE_RING_END) {
      const input = { ...RINGING, declined, elapsedMs };
      assert.equal(callerOutcomeOf(input), "wait", inspect(input));
      checked++;
    }
    for (const elapsedMs of AT_OR_AFTER_RING_END) {
      const input = { ...RINGING, declined, elapsedMs };
      assert.equal(callerOutcomeOf(input), "hangup_no_answer", inspect(input));
      checked++;
    }
  }
  assert.equal(checked, NOT_TRUE.length * 6);
});

test("someone having joined beats a decline", () => {
  // A decline that arrives after the call was answered must not end it.
  for (const elapsedMs of ALL_TIMES) {
    assert.equal(
      callerRingOutcome({
        ...RINGING,
        remoteEverJoined: true,
        declined: true,
        elapsedMs,
      }),
      "none",
      String(elapsedMs),
    );
  }
});

test("an answered call is never ended by the ring length", () => {
  for (const elapsedMs of AT_OR_AFTER_RING_END) {
    assert.equal(
      callerRingOutcome({ ...RINGING, remoteEverJoined: true, elapsedMs }),
      "none",
      String(elapsedMs),
    );
  }
});

test("a group call never hangs up by itself", () => {
  let checked = 0;
  for (const openedCall of BOOLS) {
    for (const joinedAsAnswer of BOOLS) {
      for (const remoteEverJoined of BOOLS) {
        for (const rejoining of BOOLS) {
          for (const declined of BOOLS) {
            for (const elapsedMs of ALL_TIMES) {
              const input = {
                channelType: "Group",
                openedCall,
                joinedAsAnswer,
                remoteEverJoined,
                rejoining,
                declined,
                elapsedMs,
                ringMs: RING_MS,
              };
              assert.equal(
                callerRingOutcome(input),
                "none",
                JSON.stringify(input),
              );
              checked++;
            }
          }
        }
      }
    }
  }
  assert.equal(checked, 192);
});

test("only the exact direct-message channel type can hang up", () => {
  // A ring that has run out, and a declined one, in anything that is not
  // exactly "DirectMessage".
  const types = [
    "Group",
    "TextChannel",
    "VoiceChannel",
    "SavedMessages",
    "directmessage",
    "DirectMessage ",
    "DM",
    "",
    undefined,
    null,
    true,
    {},
  ];
  let checked = 0;
  for (const channelType of types) {
    for (const declined of BOOLS) {
      for (const elapsedMs of ALL_TIMES) {
        const input = { ...RINGING, channelType, declined, elapsedMs };
        assert.equal(callerOutcomeOf(input), "none", inspect(input));
        checked++;
      }
    }
  }
  assert.equal(checked, types.length * 12);
});

test("a call this device did not open never hangs up", () => {
  // Every other fact says "ringing caller": not an answer, nobody else has
  // joined, not rejoining. Without openedCall being true that is not enough,
  // whether the ring has run out or the other side declined.
  let checked = 0;
  for (const openedCall of [false, undefined]) {
    for (const declined of BOOLS) {
      for (const elapsedMs of ALL_TIMES) {
        const input = { ...RINGING, openedCall, declined, elapsedMs };
        assert.equal(callerOutcomeOf(input), "none", inspect(input));
        checked++;
      }
    }
  }
  assert.equal(checked, 24);

  // The key being absent altogether is the same as undefined.
  for (const declined of BOOLS) {
    for (const elapsedMs of ALL_TIMES) {
      const input = without({ ...RINGING, declined, elapsedMs }, "openedCall");
      assert.equal("openedCall" in input, false);
      assert.equal(callerOutcomeOf(input), "none", inspect(input));
      checked++;
    }
  }
  assert.equal(checked, 36);
});

test("openedCall counts only when it is exactly true", () => {
  let checked = 0;
  for (const openedCall of NOT_TRUE) {
    for (const declined of BOOLS) {
      for (const elapsedMs of ALL_TIMES) {
        const input = { ...RINGING, openedCall, declined, elapsedMs };
        assert.equal(callerOutcomeOf(input), "none", inspect(input));
        checked++;
      }
    }
  }
  assert.equal(checked, NOT_TRUE.length * 12);
});

test("an answered call that both sides dropped and rejoined is not hung up by either side", () => {
  // Both sides lost the call and rejoined by themselves. Once a side has
  // reconnected, its new call was not joined by answering, has nobody else
  // in it until the other side is back, and is no longer rejoining. The side
  // that first placed the call and the side that answered it look the same
  // here, and neither opened this call.
  const rejoinedAndAlone = {
    channelType: "DirectMessage",
    openedCall: false,
    joinedAsAnswer: false,
    remoteEverJoined: false,
    rejoining: false,
    ringMs: RING_MS,
  };
  for (const declined of BOOLS) {
    for (const elapsedMs of ALL_TIMES) {
      assert.equal(
        callerRingOutcome({ ...rejoinedAndAlone, declined, elapsedMs }),
        "none",
        `${declined} ${elapsedMs}`,
      );
    }
  }
  // While a side is still rejoining the answer is the same, even if its
  // openedCall were wrongly left true from the call that dropped.
  for (const openedCall of BOOLS) {
    for (const declined of BOOLS) {
      for (const elapsedMs of ALL_TIMES) {
        assert.equal(
          callerRingOutcome({
            ...rejoinedAndAlone,
            openedCall,
            rejoining: true,
            declined,
            elapsedMs,
          }),
          "none",
          `${openedCall} ${declined} ${elapsedMs}`,
        );
      }
    }
  }
});

test("an automatic rejoin never hangs up", () => {
  // Alone, declined, and long past the ring length: still nothing, because a
  // rejoin is not a new ring.
  for (const declined of BOOLS) {
    for (const elapsedMs of ALL_TIMES) {
      assert.equal(
        callerRingOutcome({ ...RINGING, rejoining: true, declined, elapsedMs }),
        "none",
        `${declined} ${elapsedMs}`,
      );
    }
  }
});

test("a call we answered never hangs up", () => {
  for (const declined of BOOLS) {
    for (const elapsedMs of ALL_TIMES) {
      assert.equal(
        callerRingOutcome({
          ...RINGING,
          joinedAsAnswer: true,
          declined,
          elapsedMs,
        }),
        "none",
        `${declined} ${elapsedMs}`,
      );
    }
  }
});

test("a flag that is missing never hangs up", () => {
  // Each of the three flags has to be the boolean false before a hang-up is
  // possible. Left undefined, or absent, it must not be read as false.
  let checked = 0;
  for (const flag of ["joinedAsAnswer", "remoteEverJoined", "rejoining"]) {
    for (const declined of BOOLS) {
      for (const elapsedMs of ALL_TIMES) {
        const input = { ...RINGING, [flag]: undefined, declined, elapsedMs };
        assert.equal(callerOutcomeOf(input), "none", inspect(input));

        const absent = without(input, flag);
        assert.equal(flag in absent, false);
        assert.equal(callerOutcomeOf(absent), "none", inspect(absent));
        checked++;
      }
    }
  }
  assert.equal(checked, 36);
});

test("a flag that is not exactly false never hangs up", () => {
  let checked = 0;
  for (const flag of ["joinedAsAnswer", "remoteEverJoined", "rejoining"]) {
    for (const value of NOT_FALSE) {
      for (const declined of BOOLS) {
        for (const elapsedMs of ALL_TIMES) {
          const input = { ...RINGING, [flag]: value, declined, elapsedMs };
          assert.equal(callerOutcomeOf(input), "none", inspect(input));
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 3 * NOT_FALSE.length * 12);
});

test("a ring length that is not a finite number above zero never hangs up and never waits", () => {
  let checked = 0;
  for (const ringMs of BAD_RING_MS) {
    for (const declined of BOOLS) {
      for (const elapsedMs of ALL_TIMES) {
        const input = { ...RINGING, ringMs, declined, elapsedMs };
        assert.equal(callerOutcomeOf(input), "none", inspect(input));
        checked++;
      }
    }
  }
  assert.equal(checked, BAD_RING_MS.length * 12);
});

test("an elapsed time that is not a finite number of at least zero never hangs up and never waits", () => {
  let checked = 0;
  for (const elapsedMs of BAD_ELAPSED_MS) {
    for (const declined of BOOLS) {
      for (const ringMs of [5_000, RING_MS, 120_000]) {
        const input = { ...RINGING, ringMs, declined, elapsedMs };
        assert.equal(callerOutcomeOf(input), "none", inspect(input));
        checked++;
      }
    }
  }
  assert.equal(checked, BAD_ELAPSED_MS.length * 6);
});

test("the full truth table of callerRingOutcome", () => {
  const T = true;
  const F = false;
  // Columns: openedCall, joinedAsAnswer, remoteEverJoined, rejoining,
  // declined, then the answer in a direct message before the ring length has
  // passed, and the answer at or after it. Every other channel type answers
  // "none" for the whole row.
  const rows: [
    boolean,
    boolean,
    boolean,
    boolean,
    boolean,
    CallerRingOutcome,
    CallerRingOutcome,
  ][] = [
    [T, F, F, F, F, "wait", "hangup_no_answer"],
    [T, F, F, F, T, "hangup_declined", "hangup_declined"],
    [T, F, F, T, F, "none", "none"],
    [T, F, F, T, T, "none", "none"],
    [T, F, T, F, F, "none", "none"],
    [T, F, T, F, T, "none", "none"],
    [T, F, T, T, F, "none", "none"],
    [T, F, T, T, T, "none", "none"],
    [T, T, F, F, F, "none", "none"],
    [T, T, F, F, T, "none", "none"],
    [T, T, F, T, F, "none", "none"],
    [T, T, F, T, T, "none", "none"],
    [T, T, T, F, F, "none", "none"],
    [T, T, T, F, T, "none", "none"],
    [T, T, T, T, F, "none", "none"],
    [T, T, T, T, T, "none", "none"],
    [F, F, F, F, F, "none", "none"],
    [F, F, F, F, T, "none", "none"],
    [F, F, F, T, F, "none", "none"],
    [F, F, F, T, T, "none", "none"],
    [F, F, T, F, F, "none", "none"],
    [F, F, T, F, T, "none", "none"],
    [F, F, T, T, F, "none", "none"],
    [F, F, T, T, T, "none", "none"],
    [F, T, F, F, F, "none", "none"],
    [F, T, F, F, T, "none", "none"],
    [F, T, F, T, F, "none", "none"],
    [F, T, F, T, T, "none", "none"],
    [F, T, T, F, F, "none", "none"],
    [F, T, T, F, T, "none", "none"],
    [F, T, T, T, F, "none", "none"],
    [F, T, T, T, T, "none", "none"],
  ];

  // The table has to list each of the thirty-two flag combinations once.
  const seen = new Set(rows.map((row) => row.slice(0, 5).join(",")));
  assert.equal(seen.size, 32);
  assert.equal(rows.length, 32);

  let checked = 0;
  for (const [
    openedCall,
    joinedAsAnswer,
    remoteEverJoined,
    rejoining,
    declined,
    before,
    atOrAfter,
  ] of rows) {
    for (const channelType of CHANNEL_TYPES) {
      const direct = channelType === "DirectMessage";
      const cases: [number[], CallerRingOutcome][] = [
        [BEFORE_RING_END, direct ? before : "none"],
        [AT_OR_AFTER_RING_END, direct ? atOrAfter : "none"],
      ];
      for (const [times, expected] of cases) {
        for (const elapsedMs of times) {
          const input = {
            channelType,
            openedCall,
            joinedAsAnswer,
            remoteEverJoined,
            rejoining,
            declined,
            elapsedMs,
            ringMs: RING_MS,
          };
          assert.equal(
            callerRingOutcome(input),
            expected,
            JSON.stringify(input),
          );
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 32 * CHANNEL_TYPES.length * 6);
});

/** Someone who pressed Answer and has been alone since connecting. */
const ANSWERED_ALONE = {
  joinedAsAnswer: true,
  remoteEverJoined: false,
  elapsedMs: 0,
};

/** Times before the alone grace has passed, and times at or after it. */
const BEFORE_GRACE_END = [0, 1, ANSWER_ALONE_GRACE_MS - 1];
const AT_OR_AFTER_GRACE_END = [
  ANSWER_ALONE_GRACE_MS,
  ANSWER_ALONE_GRACE_MS + 1,
  ANSWER_ALONE_GRACE_MS * 10,
];
const ALL_GRACE_TIMES = [...BEFORE_GRACE_END, ...AT_OR_AFTER_GRACE_END];

test("someone who answered into an empty call waits out the grace, then leaves", () => {
  assert.equal(ANSWER_ALONE_GRACE_MS, 8_000);

  assert.equal(answererAloneOutcome({ ...ANSWERED_ALONE }), "wait");
  assert.equal(
    answererAloneOutcome({ ...ANSWERED_ALONE, elapsedMs: 7_999 }),
    "wait",
  );
  // The boundary itself is a hang-up.
  assert.equal(
    answererAloneOutcome({ ...ANSWERED_ALONE, elapsedMs: 8_000 }),
    "hangup_ended",
  );
  assert.equal(
    answererAloneOutcome({ ...ANSWERED_ALONE, elapsedMs: 8_001 }),
    "hangup_ended",
  );
});

test("the full truth table of answererAloneOutcome", () => {
  const T = true;
  const F = false;
  // Columns: joinedAsAnswer, remoteEverJoined, then the answer before the
  // grace has passed, and the answer at or after it.
  const rows: [boolean, boolean, AnswererAloneOutcome, AnswererAloneOutcome][] =
    [
      [T, F, "wait", "hangup_ended"],
      [T, T, "none", "none"],
      [F, F, "none", "none"],
      [F, T, "none", "none"],
    ];

  const seen = new Set(rows.map((row) => row.slice(0, 2).join(",")));
  assert.equal(seen.size, 4);
  assert.equal(rows.length, 4);

  let checked = 0;
  for (const [joinedAsAnswer, remoteEverJoined, before, atOrAfter] of rows) {
    const cases: [number[], AnswererAloneOutcome][] = [
      [BEFORE_GRACE_END, before],
      [AT_OR_AFTER_GRACE_END, atOrAfter],
    ];
    for (const [times, expected] of cases) {
      for (const elapsedMs of times) {
        const input = { joinedAsAnswer, remoteEverJoined, elapsedMs };
        assert.equal(
          answererAloneOutcome(input),
          expected,
          JSON.stringify(input),
        );
        checked++;
      }
    }
  }
  assert.equal(checked, 24);
});

test("a call that was not joined by pressing Answer is never ended for being empty", () => {
  // A caller alone in a call is ringing. That is callerRingOutcome's case,
  // with its own, longer clock.
  let checked = 0;
  for (const joinedAsAnswer of NOT_TRUE) {
    for (const elapsedMs of ALL_GRACE_TIMES) {
      const input = { ...ANSWERED_ALONE, joinedAsAnswer, elapsedMs };
      assert.equal(answererOutcomeOf(input), "none", inspect(input));
      checked++;
    }
  }
  assert.equal(checked, NOT_TRUE.length * 6);

  for (const elapsedMs of ALL_GRACE_TIMES) {
    const input = without({ ...ANSWERED_ALONE, elapsedMs }, "joinedAsAnswer");
    assert.equal("joinedAsAnswer" in input, false);
    assert.equal(answererOutcomeOf(input), "none", inspect(input));
    checked++;
  }
  assert.equal(checked, NOT_TRUE.length * 6 + 6);
});

test("an answerer who has had company, or whose company is unknown, is never taken out", () => {
  let checked = 0;
  for (const remoteEverJoined of NOT_FALSE) {
    for (const elapsedMs of ALL_GRACE_TIMES) {
      const input = { ...ANSWERED_ALONE, remoteEverJoined, elapsedMs };
      assert.equal(answererOutcomeOf(input), "none", inspect(input));
      checked++;
    }
  }
  assert.equal(checked, NOT_FALSE.length * 6);

  for (const elapsedMs of ALL_GRACE_TIMES) {
    const input = without({ ...ANSWERED_ALONE, elapsedMs }, "remoteEverJoined");
    assert.equal("remoteEverJoined" in input, false);
    assert.equal(answererOutcomeOf(input), "none", inspect(input));
    checked++;
  }
  assert.equal(checked, NOT_FALSE.length * 6 + 6);
});

test("an answerer's elapsed time that is not a finite number of at least zero never hangs up and never waits", () => {
  let checked = 0;
  for (const elapsedMs of BAD_ELAPSED_MS) {
    const input = { ...ANSWERED_ALONE, elapsedMs };
    assert.equal(answererOutcomeOf(input), "none", inspect(input));
    checked++;
  }
  assert.equal(checked, BAD_ELAPSED_MS.length);

  // Nothing set at all.
  assert.equal(answererOutcomeOf({}), "none");
  assert.equal(callerOutcomeOf({}), "none");
});
