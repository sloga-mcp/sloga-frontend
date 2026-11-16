// Unit spec for the Slim view call screen rules: run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/ui/components/features/voice/slimCall/slimCallPolicy.test.ts
// Declared test count: 22 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: the call screen is up only for a direct message or group call in
// Slim view that is not minimised; a server channel, a channel that is not
// known yet and an unknown type never get it; `slimCallOwnsTiles` gives the
// same answer on every row; the minimised flag is cleared by leaving the call
// or by a channel change and is otherwise left as it was; the video layout
// applies only to a direct call with the two sides' camera tiles and a camera
// on, the other side fills the screen, and a picked tile swaps the two.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nextSlimCallMinimised,
  slimCallOwnsTiles,
  slimCallShown,
  slimCallVideoLayout,
} from "./slimCallPolicy.ts";

type CallInput = Parameters<typeof slimCallShown>[0];
type MinimisedInput = Parameters<typeof nextSlimCallMinimised>[0];

/** A direct message call in Slim view with the call screen up */
const UP: CallInput = {
  slim: true,
  inCall: true,
  channelType: "DirectMessage",
  minimised: false,
};

// Kept as its own list on purpose: the spec must not read the allowed types
// out of the module it is checking
const CONVERSATION_TYPES = ["DirectMessage", "Group"];

// Server channels. A server voice channel reports "TextChannel" (it is a text
// channel with voice turned on); "VoiceChannel" is the older name for one.
const SERVER_TYPES = ["TextChannel", "VoiceChannel"];

// Saved Notes, which has no calls, then strings that are not a channel type
// or only look like one
const OTHER_TYPES = [
  "SavedMessages",
  "",
  " ",
  "directmessage",
  "DIRECTMESSAGE",
  "Direct Message",
  "DirectMessage ",
  " DirectMessage",
  "DirectMessages",
  "DM",
  "group",
  "GROUP",
  "Groups",
  "GroupChannel",
  "Unknown",
  "undefined",
  "null",
  "true",
];

const EVERY_TYPE: (string | undefined)[] = [
  undefined,
  ...CONVERSATION_TYPES,
  ...SERVER_TYPES,
  ...OTHER_TYPES,
];

/** Every combination of the three flags (8) for every channel type (23) */
function everyInput(): CallInput[] {
  const out: CallInput[] = [];
  for (const channelType of EVERY_TYPE) {
    for (let bits = 0; bits < 8; bits++) {
      out.push({
        slim: (bits & 1) !== 0,
        inCall: (bits & 2) !== 0,
        minimised: (bits & 4) !== 0,
        channelType,
      });
    }
  }
  return out;
}

/** A row as text for a failure message, with a missing type shown as null */
function label(input: CallInput): string {
  return JSON.stringify({ ...input, channelType: input.channelType ?? null });
}

/** Asserts that none of the rows shows the call screen */
function assertNeverShown(rows: CallInput[], expectedRows: number) {
  assert.equal(rows.length, expectedRows);
  for (const input of rows) {
    assert.equal(slimCallShown(input), false, label(input));
  }
}

// ---------------------------------------------------------------------------
// slimCallShown
// ---------------------------------------------------------------------------

test("a direct message call in Slim view shows the call screen", () => {
  assert.equal(slimCallShown(UP), true);
});

test("a group call in Slim view shows the call screen", () => {
  assert.equal(slimCallShown({ ...UP, channelType: "Group" }), true);
});

test("the whole table has exactly two true rows", () => {
  assert.equal(EVERY_TYPE.length, 23);

  const all = everyInput();
  assert.equal(all.length, 184);

  const shown: CallInput[] = [];
  for (const input of all) {
    const answer = slimCallShown(input);
    assert.equal(typeof answer, "boolean", label(input));
    if (answer) shown.push(input);
  }

  assert.deepEqual(shown, [
    {
      slim: true,
      inCall: true,
      minimised: false,
      channelType: "DirectMessage",
    },
    { slim: true, inCall: true, minimised: false, channelType: "Group" },
  ]);
});

test("outside Slim view it is never shown", () => {
  assert.equal(slimCallShown({ ...UP, slim: false }), false);
  assert.equal(
    slimCallShown({ ...UP, slim: false, channelType: "Group" }),
    false,
  );

  assertNeverShown(
    everyInput().filter((input) => !input.slim),
    92,
  );
});

test("without a call it is never shown", () => {
  assert.equal(slimCallShown({ ...UP, inCall: false }), false);
  assert.equal(
    slimCallShown({ ...UP, inCall: false, channelType: "Group" }),
    false,
  );

  assertNeverShown(
    everyInput().filter((input) => !input.inCall),
    92,
  );
});

test("a minimised call screen is not shown", () => {
  assert.equal(slimCallShown({ ...UP, minimised: true }), false);
  assert.equal(
    slimCallShown({ ...UP, minimised: true, channelType: "Group" }),
    false,
  );

  assertNeverShown(
    everyInput().filter((input) => input.minimised),
    92,
  );
});

test("a server channel never shows it, a server voice channel included", () => {
  assert.equal(slimCallShown({ ...UP, channelType: "TextChannel" }), false);
  assert.equal(slimCallShown({ ...UP, channelType: "VoiceChannel" }), false);

  assertNeverShown(
    everyInput().filter(
      (input) =>
        input.channelType !== undefined &&
        SERVER_TYPES.includes(input.channelType),
    ),
    16,
  );
});

test("a channel that is not known yet never shows it", () => {
  assert.equal(slimCallShown({ ...UP, channelType: undefined }), false);

  assertNeverShown(
    everyInput().filter((input) => input.channelType === undefined),
    8,
  );
});

test("an unknown type, or one that only looks right, never shows it", () => {
  for (const channelType of OTHER_TYPES) {
    assert.equal(slimCallShown({ ...UP, channelType }), false, channelType);
  }

  assertNeverShown(
    everyInput().filter(
      (input) =>
        input.channelType !== undefined &&
        OTHER_TYPES.includes(input.channelType),
    ),
    144,
  );
});

// ---------------------------------------------------------------------------
// slimCallOwnsTiles
// ---------------------------------------------------------------------------

test("slimCallOwnsTiles gives the same answer as slimCallShown on every row", () => {
  let owned = 0;
  for (const input of everyInput()) {
    const owns = slimCallOwnsTiles(input);
    assert.equal(typeof owns, "boolean", label(input));
    assert.equal(owns, slimCallShown(input), label(input));
    if (owns) owned++;
  }

  // Both answers were seen, so the loop did not compare false with false only
  assert.equal(owned, 2);
});

test("the card and the picture-in-picture keep their tiles unless the call screen is up", () => {
  assert.equal(slimCallOwnsTiles(UP), true);
  assert.equal(slimCallOwnsTiles({ ...UP, channelType: "Group" }), true);

  assert.equal(slimCallOwnsTiles({ ...UP, slim: false }), false);
  assert.equal(slimCallOwnsTiles({ ...UP, inCall: false }), false);
  assert.equal(slimCallOwnsTiles({ ...UP, minimised: true }), false);
  assert.equal(slimCallOwnsTiles({ ...UP, channelType: undefined }), false);
  assert.equal(slimCallOwnsTiles({ ...UP, channelType: "TextChannel" }), false);
  assert.equal(
    slimCallOwnsTiles({ ...UP, channelType: "VoiceChannel" }),
    false,
  );
});

// ---------------------------------------------------------------------------
// nextSlimCallMinimised
// ---------------------------------------------------------------------------

test("the minimised flag: the whole table", () => {
  const table: [MinimisedInput, boolean][] = [
    [{ minimised: false, inCall: false, channelChanged: false }, false],
    [{ minimised: false, inCall: false, channelChanged: true }, false],
    [{ minimised: false, inCall: true, channelChanged: false }, false],
    [{ minimised: false, inCall: true, channelChanged: true }, false],
    [{ minimised: true, inCall: false, channelChanged: false }, false],
    [{ minimised: true, inCall: false, channelChanged: true }, false],
    [{ minimised: true, inCall: true, channelChanged: false }, true],
    [{ minimised: true, inCall: true, channelChanged: true }, false],
  ];

  for (const [input, expected] of table) {
    const answer = nextSlimCallMinimised(input);
    assert.equal(typeof answer, "boolean", JSON.stringify(input));
    assert.equal(answer, expected, JSON.stringify(input));
  }
});

test("leaving the call clears the minimised flag", () => {
  assert.equal(
    nextSlimCallMinimised({
      minimised: true,
      inCall: false,
      channelChanged: false,
    }),
    false,
  );
  assert.equal(
    nextSlimCallMinimised({
      minimised: true,
      inCall: false,
      channelChanged: true,
    }),
    false,
  );
});

test("a channel change clears the minimised flag", () => {
  assert.equal(
    nextSlimCallMinimised({
      minimised: true,
      inCall: true,
      channelChanged: true,
    }),
    false,
  );
});

test("staying in the same call leaves the flag as it was", () => {
  assert.equal(
    nextSlimCallMinimised({
      minimised: true,
      inCall: true,
      channelChanged: false,
    }),
    true,
  );
  assert.equal(
    nextSlimCallMinimised({
      minimised: false,
      inCall: true,
      channelChanged: false,
    }),
    false,
  );
});

test("a call after a minimised one starts with the call screen up", () => {
  // Minimised during a call: the card has it
  let minimised = true;
  assert.equal(slimCallShown({ ...UP, minimised }), false);

  // Hanging up clears the flag, so the next call is shown again
  minimised = nextSlimCallMinimised({
    minimised,
    inCall: false,
    channelChanged: false,
  });
  assert.equal(minimised, false);
  assert.equal(slimCallShown({ ...UP, minimised }), true);

  // Minimised again, then moved straight into a call on another channel
  // without a moment out of a call in between
  minimised = nextSlimCallMinimised({
    minimised: true,
    inCall: true,
    channelChanged: true,
  });
  assert.equal(minimised, false);
  assert.equal(slimCallShown({ ...UP, channelType: "Group", minimised }), true);
});

type LayoutTile = Parameters<typeof slimCallVideoLayout>[0]["tiles"][number];

/** The other side's camera tile, camera on */
const THEM: LayoutTile = {
  own: false,
  liveVideo: true,
  screenShare: false,
  focused: false,
};
/** This device's camera tile, camera off */
const ME: LayoutTile = {
  own: true,
  liveVideo: false,
  screenShare: false,
  focused: false,
};

test("video layout: the other side fills the screen, in either tile order", () => {
  assert.deepEqual(
    slimCallVideoLayout({ channelType: "DirectMessage", tiles: [THEM, ME] }),
    { main: 0, corner: 1 },
  );
  assert.deepEqual(
    slimCallVideoLayout({ channelType: "DirectMessage", tiles: [ME, THEM] }),
    { main: 1, corner: 0 },
  );
});

test("video layout: only my camera on still puts the other side in the large box", () => {
  assert.deepEqual(
    slimCallVideoLayout({
      channelType: "DirectMessage",
      tiles: [
        { ...ME, liveVideo: true },
        { ...THEM, liveVideo: false },
      ],
    }),
    { main: 1, corner: 0 },
  );
});

test("video layout: a picked tile fills the screen and the other takes the corner", () => {
  assert.deepEqual(
    slimCallVideoLayout({
      channelType: "DirectMessage",
      tiles: [THEM, { ...ME, focused: true }],
    }),
    { main: 1, corner: 0 },
  );
  assert.deepEqual(
    slimCallVideoLayout({
      channelType: "DirectMessage",
      tiles: [{ ...THEM, focused: true }, ME],
    }),
    { main: 0, corner: 1 },
  );
});

test("video layout: both cameras off keeps the plain arrangement", () => {
  assert.equal(
    slimCallVideoLayout({
      channelType: "DirectMessage",
      tiles: [{ ...THEM, liveVideo: false }, ME],
    }),
    null,
  );
});

test("video layout: a group, a server channel and an unknown channel keep the plain arrangement", () => {
  for (const channelType of [
    "Group",
    "TextChannel",
    "SavedMessages",
    undefined,
  ])
    assert.equal(
      slimCallVideoLayout({ channelType, tiles: [THEM, ME] }),
      null,
      String(channelType),
    );
});

test("video layout: anything but the two sides' camera tiles keeps the plain arrangement", () => {
  const dm = "DirectMessage";
  // Alone, waiting for the other side
  assert.equal(
    slimCallVideoLayout({
      channelType: dm,
      tiles: [{ ...ME, liveVideo: true }],
    }),
    null,
  );
  // A third tile
  assert.equal(
    slimCallVideoLayout({ channelType: dm, tiles: [THEM, ME, THEM] }),
    null,
  );
  // A screen share among the two
  assert.equal(
    slimCallVideoLayout({
      channelType: dm,
      tiles: [{ ...THEM, screenShare: true }, ME],
    }),
    null,
  );
  // Two tiles of the same side
  assert.equal(
    slimCallVideoLayout({ channelType: dm, tiles: [THEM, THEM] }),
    null,
  );
  assert.equal(
    slimCallVideoLayout({
      channelType: dm,
      tiles: [{ ...ME, liveVideo: true }, ME],
    }),
    null,
  );
  assert.equal(slimCallVideoLayout({ channelType: dm, tiles: [] }), null);
});
