// Unit spec for the screen-share tile's audio badge (Android screen share
// slice 4, Design section 7) - run with Node's built-in runner, from
// packages/client:
//   node --test --conditions=browser components/rtc/shareAudioBadge.test.ts
//
// Why this exists: before slice 4 the tile asked components-core whether the
// `ScreenShareAudio` source was muted, and its observer answers
// `pub?.isMuted ?? true`. A share with NO audio publication therefore read as
// "muted": every audio-less share carried the grey `no_sound` badge, and the
// Retroid tester reported a share that was "muted, can't unmute". The first
// half is the full truth table of `shareAudioBadge.ts`, the import-free leaf
// that now decides the badge. The second half pins
// `ParticipantTile.tsx`, which `node --test` cannot load (Solid JSX,
// livekit), to feeding that leaf from a real publication lookup, re-reading
// it on `voice.sharePubVersion()`, and rendering each answer as intended.
//
// The pins are matched as TEXT after `codeOf` (`sourcePins.harness.ts`), with
// its known limits: dead code satisfies a pin, and an equivalent rewrite of a
// pinned statement breaks one. `ParticipantTile.tsx` cannot be put through
// `codeOf` whole: the JSX text `You're sharing your screen` holds an
// apostrophe the lexer reads as a quote, and from there on it loses its
// place. So every pin below lexes only from a unique head on (`bodyFrom`),
// or counts exact text in the raw file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type ShareAudioBadge, shareAudioBadge } from "./shareAudioBadge.ts";
import {
  bodyFrom,
  closerOf,
  codeOf,
  countWired,
  stringsOf,
  wiredAsserter,
} from "./sourcePins.harness.ts";

/** One row: the three inputs, and the badge they must give. */
type Row = [
  hasAudioPub: boolean,
  pubMuted: boolean,
  userMuted: boolean,
  badge: ShareAudioBadge,
];

/** Every combination of the three inputs, exactly once. */
const TRUTH_TABLE: readonly Row[] = [
  // No audio publication: nothing to unmute, so never a mute badge, whatever
  // the viewer or a (meaningless) publisher mute says.
  [false, false, false, "no-audio"],
  [false, false, true, "no-audio"],
  [false, true, false, "no-audio"],
  [false, true, true, "no-audio"],
  // Audio is published.
  [true, false, false, "none"],
  [true, false, true, "user-muted"],
  [true, true, false, "muted"],
  [true, true, true, "user-muted"],
];

test("shareAudioBadge: the full truth table, all 8 rows", () => {
  const seen = new Set<string>();
  for (const [hasAudioPub, pubMuted, userMuted, badge] of TRUTH_TABLE) {
    const key = `${hasAudioPub}/${pubMuted}/${userMuted}`;
    assert.ok(!seen.has(key), `duplicate row ${key}`);
    seen.add(key);
    assert.equal(
      shareAudioBadge({ hasAudioPub, pubMuted, userMuted }),
      badge,
      `hasAudioPub=${hasAudioPub} pubMuted=${pubMuted} userMuted=${userMuted}`,
    );
  }
  // The table is exhaustive, so a row cannot be dropped unnoticed.
  assert.equal(seen.size, 8);
});

test("shareAudioBadge: no audio publication gives no-audio, even if the viewer muted the sharer", () => {
  // The Retroid report: a badge that looks like a mute on a share that has
  // no audio is a mute the viewer can never undo. The viewer's own per-user
  // mute must not resurrect it either: it would claim the viewer is
  // silencing a track that does not exist.
  for (const pubMuted of [false, true]) {
    assert.equal(
      shareAudioBadge({ hasAudioPub: false, pubMuted, userMuted: true }),
      "no-audio",
      `pubMuted=${pubMuted}`,
    );
  }
});

test("shareAudioBadge: the viewer's own mute beats the publisher's mute", () => {
  // The viewer can only act on their own mute, so it is the one shown when
  // both apply: they still have to unmute locally to hear anything once the
  // publisher unmutes.
  assert.equal(
    shareAudioBadge({ hasAudioPub: true, pubMuted: true, userMuted: true }),
    "user-muted",
  );
});

const TILE_FILE = "ParticipantTile.tsx";

const TILE_SOURCE = readFileSync(
  new URL(
    "../ui/components/features/voice/callCard/ParticipantTile.tsx",
    import.meta.url,
  ),
  "utf8",
);

/** How often `text` occurs, character for character, in the raw tile file. */
function rawCount(text: string): number {
  return TILE_SOURCE.split(text).length - 1;
}

/** The inside of the tile's `shareAudio` memo, put through `codeOf`. */
function shareAudioMemo(): string {
  return bodyFrom(
    TILE_FILE,
    TILE_SOURCE,
    "const shareAudio = createMemo(() => {",
  );
}

/** The screen-share branch of the tile's overlay icons: its `<Switch>`. */
function shareBadgeSwitch(): string {
  return bodyFrom(TILE_FILE, TILE_SOURCE, "{isScreenShare() ? (");
}

/** The argument list of every `useIsMuted(` call in the tile. */
function useIsMutedArguments(): string[] {
  const head = "useIsMuted(";
  const out: string[] = [];
  for (
    let at = TILE_SOURCE.indexOf(head);
    at !== -1;
    at = TILE_SOURCE.indexOf(head, at + 1)
  ) {
    const code = codeOf(TILE_SOURCE.slice(at));
    const openAt = head.length - 1;
    out.push(code.slice(openAt + 1, closerOf(code, openAt)));
  }
  return out;
}

test("source pin: the pinned slices of ParticipantTile.tsx lex cleanly", () => {
  // A lexer that lost its place would keep comments as code, and a
  // commented-out copy could then satisfy a pin. A quoted string never holds
  // a newline, and the Switch's JSX comments must be gone.
  for (const [what, code] of [
    ["the shareAudio memo", shareAudioMemo()],
    ["the share badge Switch", shareBadgeSwitch()],
  ]) {
    for (const { quote, text } of stringsOf(code))
      if (quote !== "`")
        assert.ok(!text.includes("\n"), `${what}: ${quote}${text}${quote}`);
  }
  assert.ok(rawCount("The viewer muted this sharer") > 0);
  assert.ok(!shareBadgeSwitch().includes("Theviewermutedthissharer"));
});

test("source pin: the tile's badge is computed by shareAudioBadge", () => {
  // The precedence the truth table above proves (no audio before any mute,
  // the viewer's mute before the publisher's) lives only in the leaf. A
  // badge picked inline in the tile would run untested while every row
  // above stays green.
  assert.equal(
    rawCount(`import { shareAudioBadge } from "@revolt/rtc/shareAudioBadge";`),
    1,
  );
  const assertInMemo = wiredAsserter(
    `${TILE_FILE}'s shareAudio memo`,
    shareAudioMemo(),
  );
  assertInMemo("the badge call", "return shareAudioBadge({");
  // The per-user mute is keyed by USER id, the key the context menu writes
  // and RoomAudioManager reads, so the badge matches what is silenced.
  assertInMemo(
    "the viewer's own mute",
    `userMuted: state.voice.getScreenShareMuted(
      participantUserId(participant.identity),
    )`,
  );
});

test("source pin: hasAudioPub comes from getTrackPublication, never a mute observer", () => {
  // The bug this slice fixes: components-core's mute observer answers
  // `pub?.isMuted ?? true`, so it cannot tell "no audio track" from "muted".
  // Deriving hasAudioPub from it (`!useIsMuted(...)()`, or anything built on
  // it) brings back the Retroid tester's "muted, can't unmute" badge on every
  // audio-less share. Only a publication lookup can see the absence.
  const assertInMemo = wiredAsserter(
    `${TILE_FILE}'s shareAudio memo`,
    shareAudioMemo(),
  );
  assertInMemo(
    "the publication lookup",
    "const pub = participant.getTrackPublication(Track.Source.ScreenShareAudio);",
  );
  assertInMemo("hasAudioPub", "hasAudioPub: pub !== undefined,");
  // Without a publication there is no publisher mute; the leaf ignores it
  // then, but it must never default to true the way the observer does.
  assertInMemo("pubMuted", "pubMuted: pub?.isMuted ?? false,");
});

test("source pin: the shareAudio memo reads sharePubVersion()", () => {
  // `participant` is a plain livekit object, not a Solid signal, so without
  // this read the memo runs once at mount and never sees the audio
  // publication arrive (an Android share's audio publishes after its video)
  // or leave: a share that gains audio keeps its "no audio" badge, and one
  // that loses it keeps a stale mute badge. The read must be INSIDE the memo
  // to subscribe it, and FIRST: below an early return such as
  // `if (!pub) return "no-audio";` it would go unread in exactly the
  // no-publication case, and the badge would never see the audio arrive.
  const memo = shareAudioMemo();
  const assertInMemo = wiredAsserter(`${TILE_FILE}'s shareAudio memo`, memo);
  assertInMemo("the version read", "void voice.sharePubVersion();");
  assert.ok(
    memo.startsWith(codeOf("void voice.sharePubVersion();")),
    `${TILE_FILE}: the shareAudio memo must read sharePubVersion() first`,
  );
});

test("source pin: no useIsMuted call observes ScreenShareAudio", () => {
  // The same observer as above, reached a different way: any
  // `useIsMuted({ source: Track.Source.ScreenShareAudio })` in the tile is a
  // second, wrong answer to "is the share audio muted", and the Retroid
  // report is what it shows on an audio-less share.
  const calls = useIsMutedArguments();
  // Not vacuous: the tile still observes its microphone this way.
  assert.ok(
    calls.some((args) => args.includes("source:Track.Source.Microphone")),
    `${TILE_FILE}: no useIsMuted call for the microphone found`,
  );
  for (const args of calls)
    assert.ok(
      !args.includes("ScreenShareAudio"),
      `${TILE_FILE}: useIsMuted observes share audio: useIsMuted(${args})`,
    );
  // The memo's lookup is the tile's only use of the share-audio source, so a
  // mute observer built on it any other way (a track reference, a helper)
  // cannot slip past the check above.
  assert.equal(
    rawCount("Track.Source.ScreenShareAudio"),
    1,
    `${TILE_FILE} must name Track.Source.ScreenShareAudio exactly once, in the shareAudio memo`,
  );
});

test("source pin: the no-audio tooltip msgid is exact and used once", () => {
  // The msgid is in en/messages.po byte for byte. lingui replaces the
  // literal with a hash at build time, so a reworded string has no catalog
  // entry and renders as its hash, in every language including English.
  assert.equal(rawCount("This screen share has no audio"), 1);
  assert.equal(
    countWired(
      shareBadgeSwitch(),
      "content: t`This screen share has no audio`,",
    ),
    1,
    `${TILE_FILE}: the no-audio tooltip must render this msgid exactly once`,
  );
});

test("source pin: user-muted is red, muted is grey, no-audio is a different glyph", () => {
  // Unchanged from before slice 4 for shares that have audio: the viewer's
  // own mute is the red `no_sound`, the publisher's the grey one. A share
  // with no audio gets `volume_mute` and a tooltip instead, so it never
  // reads as a mute to undo (the Retroid report). "none" renders nothing,
  // so the Switch has these three Matches and no fallback.
  const code = shareBadgeSwitch();
  const assertInSwitch = wiredAsserter(`${TILE_FILE}'s share badge`, code);
  assert.ok(code.startsWith("<Switch>"), `${TILE_FILE}: ${code}`);
  assert.equal(code.split("<Match").length - 1, 3);
  assertInSwitch(
    "the red user-muted badge",
    `<Match when={shareAudio() === "user-muted"}>
      <Symbol size={18} color="var(--md-sys-color-error)">
        no_sound
      </Symbol>
    </Match>`,
  );
  assertInSwitch(
    "the grey muted badge",
    `<Match when={shareAudio() === "muted"}>
      <Symbol size={18}>no_sound</Symbol>
    </Match>`,
  );
  assertInSwitch(
    "the no-audio badge",
    `<Match when={shareAudio() === "no-audio"}>
      <Symbol
        size={18}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t\`This screen share has no audio\`,
          },
        }}
      >
        volume_mute
      </Symbol>
    </Match>`,
  );
});
