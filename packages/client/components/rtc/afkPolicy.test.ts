// Unit spec for the AFK-channel client rules (AFK plan A7, 2026-09-21).
//   node --test --conditions=browser components/rtc/afkPolicy.test.ts
//
// Focus: the designation predicate never fires on an undesignated server, the
// publish accessors fold AFK in even though the permission bits say yes (the
// D2 consequence — `havePermission("Speak")` stays true in the AFK channel),
// the toggle guard refuses only the ENABLING direction, the join plan
// reproduces the four lines it replaced, and the permission-fall classifier
// tells an AFK user the truth instead of blaming a moderator.
//
// 🔴 Every assertion calls the production function. Nothing here re-types the
// rule it is checking — a spec that restates the logic passes a revert.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type PermissionFallReason,
  afkJoinPlan,
  isAfkChannel,
  permissionFallReasons,
  publishToggleRefusal,
  voicePublishPermission,
} from "./afkPolicy.ts";

const CHANNEL = "01JAFKCHANNELAAAAAAAAAAAAA";
const OTHER = "01JOTHERCHANNELAAAAAAAAAAA";

test("the designation is pointer identity against the server's AFK channel", () => {
  assert.equal(isAfkChannel(CHANNEL, CHANNEL), true);
  assert.equal(isAfkChannel(OTHER, CHANNEL), false);
});

test("no designation never reads as AFK, whatever the channel", () => {
  // The shipped bug this replaces was name-keyed; the replacement must be
  // inert on every server that has not designated a channel.
  assert.equal(isAfkChannel(undefined, CHANNEL), false);
  assert.equal(isAfkChannel("", CHANNEL), false);
});

test("undefined === undefined must not report the user AFK", () => {
  // Before a channel is known AND with no designation, a bare `===` would be
  // true. This is the one input that makes both guards load-bearing.
  assert.equal(isAfkChannel(undefined, undefined), false);
  assert.equal(isAfkChannel(CHANNEL, undefined), false);
});

test("AFK denies the publish accessor even with the permission bit granted", () => {
  // 🔴 The backend gate is deliberately outside the permission calculus, so
  // `havePermission` is TRUE here — for the server owner it is true by
  // short-circuit and can never be anything else. If this ever passes with
  // the AFK term removed, the owner gets a working mic button in the AFK
  // channel and an opaque SFU refusal when they press it.
  assert.equal(
    voicePublishPermission({
      hasChannel: true,
      isPrivateChannel: false,
      isAfkChannel: true,
      havePermission: true,
    }),
    false,
  );
});

test("outside the AFK channel the permission bit still decides", () => {
  for (const havePermission of [true, false]) {
    assert.equal(
      voicePublishPermission({
        hasChannel: true,
        isPrivateChannel: false,
        isAfkChannel: false,
        havePermission,
      }),
      havePermission,
    );
  }
});

test("DMs and groups always publish; no channel never does", () => {
  assert.equal(
    voicePublishPermission({
      hasChannel: true,
      isPrivateChannel: true,
      isAfkChannel: false,
      havePermission: false,
    }),
    true,
  );
  assert.equal(
    voicePublishPermission({
      hasChannel: false,
      isPrivateChannel: false,
      isAfkChannel: false,
      havePermission: true,
    }),
    false,
  );
});

test("the toggle guard refuses an enable in the AFK channel", () => {
  // The defect being removed: join muted, press Unmute, you are live. The
  // guard is what makes the flag survive past the join handler.
  assert.equal(
    publishToggleRefusal({
      enabling: true,
      isAfkChannel: true,
      permitted: false,
    }),
    "afk",
  );
});

test("the toggle guard never refuses a disable", () => {
  // 🔴 Turning something OFF must always work, or a designation change mid-
  // share would trap the sharer hot with a dead stop button.
  for (const isAfk of [true, false]) {
    for (const permitted of [true, false]) {
      assert.equal(
        publishToggleRefusal({
          enabling: false,
          isAfkChannel: isAfk,
          permitted,
        }),
        undefined,
      );
    }
  }
});

test("AFK is reported ahead of a plain permission denial", () => {
  // In the AFK channel the accessor is false too, so both rules apply. Saying
  // "denied" would tell the user they lack a permission they in fact hold.
  assert.equal(
    publishToggleRefusal({
      enabling: true,
      isAfkChannel: true,
      permitted: true,
    }),
    "afk",
  );
});

test("a missing permission outside AFK reports denied, and a granted one passes", () => {
  assert.equal(
    publishToggleRefusal({
      enabling: true,
      isAfkChannel: false,
      permitted: false,
    }),
    "denied",
  );
  assert.equal(
    publishToggleRefusal({
      enabling: true,
      isAfkChannel: false,
      permitted: true,
    }),
    undefined,
  );
});

test("the join plan keeps the microphone down in the AFK channel", () => {
  // All eight (deafened, micOn) x AFK combinations: under AFK nothing wants
  // the mic, the pipeline is not attached and the camera is forced off.
  for (const deafened of [true, false]) {
    for (const micOn of [true, false]) {
      const plan = afkJoinPlan({ isAfkChannel: true, deafened, micOn });
      assert.deepEqual(plan, {
        wantMic: false,
        attachMicPipeline: false,
        forceCameraOff: true,
      });
    }
  }
});

test("outside the AFK channel the join plan is the pre-AFK behavior", () => {
  assert.deepEqual(
    afkJoinPlan({ isAfkChannel: false, deafened: false, micOn: true }),
    { wantMic: true, attachMicPipeline: true, forceCameraOff: false },
  );
  // Deafen still wins, and so does an explicit mute — AFK added a term, it
  // did not replace the persisted pre-call state.
  assert.equal(
    afkJoinPlan({ isAfkChannel: false, deafened: true, micOn: true }).wantMic,
    false,
  );
  assert.equal(
    afkJoinPlan({ isAfkChannel: false, deafened: false, micOn: false }).wantMic,
    false,
  );
});

const fall = (
  isAfkChannel: boolean,
  edges: Partial<Parameters<typeof permissionFallReasons>[0]> = {},
): PermissionFallReason[] =>
  permissionFallReasons({
    prevCanPublish: true,
    nowCanPublish: false,
    prevCanSubscribe: true,
    nowCanSubscribe: true,
    isAfkChannel,
    ...edges,
  });

test("an AFK publish revocation is not blamed on a moderator", () => {
  // 🔴 Under AFK the publish grant falls for everyone who enters, so the
  // shipped copy would tell every AFK member a moderator muted them.
  assert.deepEqual(fall(true), ["afk-publish"]);
  assert.deepEqual(fall(false), ["moderator-mute"]);
});

test("a rising or absent edge says nothing", () => {
  // The initial grant arrives as a change from undefined; a re-grant is not
  // an interruption.
  assert.deepEqual(
    fall(true, { prevCanPublish: undefined, nowCanPublish: true }),
    [],
  );
  assert.deepEqual(
    fall(false, { prevCanPublish: false, nowCanPublish: true }),
    [],
  );
  assert.deepEqual(
    fall(false, { prevCanPublish: true, nowCanPublish: true }),
    [],
  );
});

// --- Textual contract against state.tsx -----------------------------------
//
// `state.tsx` is ~9.8k lines and its class cannot be instantiated here (Solid
// signals, livekit `Room`, stoat.js client), so the wiring itself is
// unreachable by `node --test`. These checks are the cheapest honest
// substitute: they hold the production file to CALLING the rules above rather
// than re-implementing them, and to PASSING them the designation rather than a
// constant — the two failure modes that let a revert ship green. They are not
// a substitute for a live call — see the report.
const STATE = readFileSync(new URL("./state.tsx", import.meta.url), "utf8");

/**
 * Crude comment stripper, the same shape the sibling AFK spec uses. Every scan
 * below has to read code, not prose: the block itself quotes both the old
 * name-keyed expression and the exact property value it pins, and `state.tsx`
 * is free to quote them back when it explains why they went. A scan that
 * cannot tell the warning from the offense fires on its own documentation.
 *
 * It cuts deep — `state.tsx` is around 62% comment by character, so most of
 * the file goes. That is why the count below is pinned rather than just
 * bounded: if a stray `/*` inside a string literal ever swallows a live
 * region, the sites disappear with it and the count is what notices.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const STATE_CODE = stripComments(STATE);

test("state.tsx calls the extracted rules instead of restating them", () => {
  for (const fn of [
    "isAfkChannel(",
    "voicePublishPermission(",
    "publishToggleRefusal(",
    "afkJoinPlan(",
    "permissionFallReasons(",
  ]) {
    assert.ok(
      STATE_CODE.includes(fn),
      `state.tsx no longer calls ${fn} — the rule was inlined or dropped`,
    );
  }
});

test("the name-keyed AFK check is gone from state.tsx", () => {
  // The shipped implementation was `channel.name?.toLowerCase() === "afk"`.
  // Renaming any channel granted the behavior; renaming the real one removed
  // it. If this string ever comes back, the server designation is being
  // second-guessed by a string compare.
  // Comments stripped: the replacement is entitled to quote the expression it
  // removed, and this scan must not fire on that explanation.
  assert.ok(
    !/toLowerCase\(\)\s*===\s*"afk"/.test(STATE_CODE),
    'state.tsx still name-checks for "afk"',
  );
});

test("every publish entry point consults the guard", () => {
  // Five `publishToggleRefusal` call sites: toggleMute, toggleCamera,
  // toggleScreenshare, toggleDeafen and `#applyMicMode` (a mid-call switch to
  // Open Mic must not unmute into AFK either). The fourth is not decoration —
  // pressing Unmute WHILE DEAFENED never enters toggleMute's body, it
  // delegates to toggleDeafen, so a three-site guard has a door in it. The
  // pre-AFK code had zero AFK references in any of them, which is why one
  // click defeated the whole feature.
  const calls = STATE_CODE.match(/publishToggleRefusal\(\{/g) ?? [];
  assert.equal(
    calls.length,
    5,
    `expected 5 guard call sites, saw ${calls.length}`,
  );
});

// --- The property value, not just the identifier ----------------------------
//
// 🔴 Flipping one token at `state.tsx:5303` — `isAfkChannel: this.isAfkChannel`
// to `isAfkChannel: false` — puts the shipped bug back exactly as it was: join
// muted, press Unmute, you are live. That revert was run against this tree and
// it passed EVERYTHING. All of the specs above, the full 1765-test suite, `tsc`
// and `vite build` all stayed green on it. The scans above stay green too: the
// identifier is still in the file because the accessor at `:8728` still calls
// the rule, and the call-site count is still four because no call site was
// touched. The guard travels as a PROPERTY VALUE, and until now no assertion
// read one. The live two-seat call that would have caught it is out of scope,
// so these two checks are the only thing standing there.
//
// Both halves are needed. The value check is what closes the hole, and it goes
// on covering a ninth site the day one is added, with no edit here. The count
// check covers the other way to lose a site — deleting the property outright
// leaves every surviving value correct, and would leave the value check with
// nothing to object to. Adding a site is meant to fail the count until the
// number is bumped on purpose; that is the prompt to check the new site got
// the accessor and not a constant.
//
// (The line numbers in the paragraph above are those of the tree the revert
// was run against; the list below is the one to re-derive.)
//
// Nine sites, re-derive with `grep -n isAfkChannel state.tsx`. Eight were
// present at `16734940`: 3213, 3415, 6023, 6075, 6234, 7385, 9517, 9536 —
// plus the import at `:114`, the accessor at `:9498` and its single call at
// `:9500`, which carry no `isAfkChannel:`. The ninth is Wave 5b-2's idle
// world (`isAfkChannel: this.isAfkChannel`, handed to `idleStep`), bumped
// here on purpose (finding I-5); `idlePolicy.test.ts` pins that it is the
// idle world's. The idle types live in `idlePolicy.ts`, so no inline
// `isAfkChannel: boolean` type annotation in `state.tsx` is captured below as
// the value `boolean`.
const AFK_PROPERTY_VALUES = [
  ...STATE_CODE.matchAll(/isAfkChannel\s*:\s*([^,\n]+)/g),
].map((match) => match[1].trim());

test("🔴 no isAfkChannel property in state.tsx is wired to a constant", () => {
  for (const value of AFK_PROPERTY_VALUES) {
    assert.equal(
      value,
      "this.isAfkChannel",
      `a state.tsx isAfkChannel property reads \`${value}\` — anything but the accessor pins the flag to a constant and the channel stops being AFK`,
    );
  }
});

test("all ten isAfkChannel property sites are still present", () => {
  // A site removed rather than falsified: every remaining value passes the
  // check above, and the consumer of the deleted one silently loses the flag.
  // The ninth is the idle world's (Wave 5b-2, I-5); the tenth is
  // `#applyMicMode`'s publish guard (the mid-call microphone-mode switch).
  assert.equal(
    AFK_PROPERTY_VALUES.length,
    10,
    `expected 10 isAfkChannel property sites, saw ${AFK_PROPERTY_VALUES.length}`,
  );
});

test("deafen is independent of AFK", () => {
  // AFK revokes publish, never subscribe — an AFK user who loses canSubscribe
  // really was deafened.
  assert.deepEqual(
    fall(true, { prevCanSubscribe: true, nowCanSubscribe: false }),
    ["afk-publish", "moderator-deafen"],
  );
  assert.deepEqual(
    fall(false, {
      prevCanPublish: true,
      nowCanPublish: true,
      prevCanSubscribe: true,
      nowCanSubscribe: false,
    }),
    ["moderator-deafen"],
  );
});
