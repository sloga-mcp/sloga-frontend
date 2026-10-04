#!/usr/bin/env python3
"""Mutation-verify the RTC/MLS specs.

    packages/client/scripts/rtc-mutations.py [--list] [--preflight] [--only ID[,ID...]]

A green suite is weak evidence on this branch: five of the six defects six
`media-e2ee-reviewer` rounds found passed a green gate, and three of them were
introduced by the previous round's own fix. The specs' job is to stop a FIXED
defect coming back, and this list is the only evidence they can do it.

Each mutation re-introduces exactly one reviewed failure mode by an EXACT
string replacement in a source file, runs the spec files that should catch it,
and reverts. A mutation whose search string is not found is a HARD ERROR, not a
skip: a mutation that silently fails to apply leaves the suite green and reads
as "uncaught", which is the same silent pass `rtc-gate.sh` exists to kill.

Judged on the runner's OWN exit status — never a grep of its summary, never
through a pipe (`cmd | tail` makes `$?` tail's).

🔴 AND AN EXIT STATUS IS NOT ENOUGH ON ITS OWN, exactly as in `rtc-gate.sh`.
Until 2026-09-10 `run_specs` returned `proc.returncode != 0` and nothing else,
so this runner could not tell "the specs caught the defect" from "the mutated
file no longer LOADS". Demonstrated by the wave-1 audit: a syntax error
injected into a sandboxed module gives `exit=1, tests 1, fail 1`, which the old
runner printed as `OK: expected red, specs went red`. A future retarget landing
a `replace` that is not valid TS, or that renames an export the spec imports,
would have reported OK forever while asserting nothing — in the file that is
this branch's primary evidence device. So every mutant run is now also read for
its COUNTERS: the executed `tests` (and `skipped`) must equal the count the
same spec produced on the UNMUTATED tree, `pass + fail + skipped` must account
for all of them, and a red must carry `fail > 0`. Anything else is a PROBLEM —
never a catch. See `judge()`.

The baseline counts are MEASURED at the start of every run, not committed here:
a pinned number in this file would be a second thing to keep in sync with
`rtc-gate.sh`'s EXPECTED table, and the property wanted is "the mutant ran the
same suite as the baseline", which only the live baseline can state.

Exit 0 iff every mutation marked `expect="red"` turned its specs red ON
ASSERTIONS with the full suite executing, and every mutation marked
`expect="green"` left them green the same way.

Exit 96 if another run of this script is already mutating the same worktree —
it REFUSES rather than queues; see `exclusive_run_lock`.

Exit 95, before anything is written or run, if any entry in the table would
not apply exactly once; see `preflight`. `--preflight` runs only that check.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

CLIENT = Path(__file__).resolve().parent.parent
RTC = CLIENT / "components" / "rtc"
NODE = "node"

SESSION = "mlsCallSession.ts"
POLICY = "mlsCallModePolicy.ts"
HARNESS = "mlsCallSession.harness.ts"
#: Wave 1 moved everything a mutation could reach into
#: `publishGateEpisode.ts`, and the seam wave moved the verdict DERIVATION
#: into `pauseVerdict.ts` (see `VERDICT` below). What is LEFT in `state.tsx`
#: is WIRING. Only the `state-*` entries at the end of this table reach any of
#: it (see the next paragraph), and the publish-gate wiring is still
#: unreachable here: that `beginDrive` is passed as
#: `coalescingSweeper`'s FOURTH positional argument (a three-argument call
#: still compiles and silently degrades drive scope to no scope), that the
#: `EpisodeDeps` thunks are bound to the right room, and that `scheduleConfirm`
#: is a `setTimeout` rather than a microtask. A mutation cannot reach any of
#: it, because `node --test` cannot import the file. Recorded here rather than
#: as an `expect="green"` entry, which would be an admission dressed as a
#: measurement.
#:
#: 🔴 The ONLY entries that carry `file=STATE` are entries whose id starts
#: with `state-`, and `preflight` refuses any other: the call-view
#: suggestions block (wave 7) and the Android screen-leg block at the end of
#: this table (screen-share flip wave 4c: `state-leg-*`,
#: `state-keyprovider-*`, `state-encryptedlegs-*`, `state-sfu-*`,
#: `state-trackpublished-*`, `state-pausegate-*`). They reach nothing but the
#: statements `stateWiring.test.ts` pins as TEXT — the voice-move and
#: chip-publication wiring, and since wave 4 the screen leg's roster inputs,
#: its stop and gate notices, the start path's mode re-reads and binding key
#: read, and the leg key fence and pushes: those source pins strip comments
#: before matching (`codeOf`, in
#: `sourcePins.harness.ts`), so unlike a `grep -qF` one comment line cannot
#: satisfy them, but the same text in dead code still would, and a pin proves
#: a statement is PRESENT, never what it does at runtime. Nothing else in
#: `state.tsx` is pinned, and the wave-1 fix round ADDED to what that leaves
#: unmeasured. `#gateGen` plus the per-sweeper `stillCurrent`
#: closure (`gen === this.#gateGen && this.room() === room`, captured when the
#: sweeper is BUILT) is now the only thing keeping a sweep parked on an awaited
#: livekit op from spending publications in the NEXT call's episode. The
#: `publishGateEpisode.ts` specs pin what the episode DOES when `stillCurrent()`
#: answers false; nothing pins that the closure ANSWERS false for a disposed
#: sweeper, and nothing in this table can. Do not paper over it with a
#: source-text assertion: a `grep -qF` over a file no runner can load does not
#: converge — one comment line defeats it — and even a comment-stripped pin
#: would hold the closure's TEXT, not that it answers false for a disposed
#: sweeper. Closing this needs a further extraction or a live leg, not
#: another entry here.
#:
#: 🔴 AND THE TWO VERDICT-READER ASSIGNMENTS, which is the residue the seam
#: wave did NOT close and must not be read as covered:
#:     this.callPauseDisproved = createMemo(readers.disproved);
#:     this.callPauseDisproofConfirmed = createMemo(readers.disproofConfirmed);
#: `pause-verdict-readers-transposed` pins the DERIVATION inside
#: `pauseVerdict.ts`; it cannot see these two writes. They are two same-typed
#: `Accessor<boolean>`s, transposable in one keystroke, and a swap was MEASURED
#: to pass the entire bare gate — tsc, prettier, eslint, every spec and both
#: scripts, exit 0 — while mapping `{value: true, confirmed: false}` to
#: `{ false, true }`. Since wave 3 the only runtime consumer of both readers is
#: `callBanner` (`state.tsx` feeds it `callPauseDisproved()` and
#: `callPauseDisproofConfirmed()`), whose fold is the symmetric AND
#: `pauseDisproved && pauseDisproofConfirmed`: the swap is banner-invisible
#: today — no PRESENT false-green to report — and a false-green for any
#: `disproved`-only reader, which is exactly what the wave-1 banner was.
#: Closing it needs ONE write instead of two, not another entry here.
#:
#: 🔴 AND THE TWO BORN-PAUSED WIRINGS (plan D0, wave 1, 2026-09-14), which
#: this table reaches no better than the rest of `state.tsx`:
#:  (i)  the `ParticipantEvent.LocalSenderCreated` registration — the listener
#:       body at the `LocalSenderCreated` emit — that builds ONE
#:       `GatedPublication` over the new track with
#:       `gatedPublicationFromSender` and hands it to `pauseAtBirth` under
#:       `this.#gateHeld`, then reports on the sweep's `unproven`. The
#:       `born-paused-*` entries below pin what `pauseAtBirth` and the adapter
#:       DO; nothing here can pin that the listener is registered at all, that
#:       its guard order is `room → isLocalTrack`, or that it reports on
#:       `unproven` rather than on an empty `proven`. Drop the registration
#:       and the hook is fully specified and never called.
#:  (ii) the publish-time kick in the `LocalTrackPublished` handler, which
#:       since wave 4 (final audit F1) is no longer unconditional. Wave 1 had
#:       made it a bare `#applyPublishGate(room)` on every publish so a
#:       born-paused publication whose gate emptied DURING its offer/answer
#:       (`{flag: true, sender.track: null}` under an empty gate, invisible to
#:       the 1→0 sweep and to `#reassertPublishGate`) got resumed by the only
#:       sweep that could see it; the audit found that empty-gate sweep also
#:       resumed every OTHER `{flag: true, quiet}` publication, the
#:       screen-share consent-pending pause included. Now: the
#:       `LocalSenderCreated` hook adds the track to the `#bornPaused` WeakSet
#:       ONLY when `pauseAtBirth` returned a sweep — the gate was HELD at the
#:       emit — whatever op that sweep then chose: a `pause`, a `repause`, or
#:       a `none` (`publishGateOp`: a sender whose transport had already
#:       closed reads `unpublished`; a quiet sender already under a true flag
#:       is left alone). The tag means "born under a held gate", not "a pause
#:       was issued"; the handler
#:       `delete`s the tag at `LocalTrackPublished` — consumed WHATEVER arm is
#:       then chosen, so it cannot outlive its publication and fire on a later
#:       republish of the same `LocalTrack` — and asks
#:       `publishKickAction({gateHeld, bornPaused})`: `"sweep"` runs the full
#:       `#applyPublishGate(room)` (held gate; pause/repause arms only, nothing
#:       resumed), `"resumeLanded"` runs
#:       `applyPublishGate([gatedPublicationFromSender({ source, sid, track },
#:       this.#consentHeld.has(pub.track))], this.#gateHeld, {})` over the
#:       landed publication ALONE — the empty-gate arm resumes ONLY the
#:       tagged track, and since wave 4 only when that track is not
#:       consent-held: the second argument is the born adapter's
#:       `consentHeld` flag, read from the `#consentHeld` WeakSet by the
#:       landed `pub.track` (xiv), and the `resume` arm returns null over a
#:       held publication. A pause the hook did not issue stays put ONLY
#:       because of that flag: the screen-share consent pause is a true
#:       flag over a quiet sender — the exact shape this arm resumes — and
#:       waves 1 through 3 resumed it here whenever a republish's
#:       offer/answer straddled a 1→0, ahead of the user's answer — and
#:       `"none"` touches nothing. After it, `#syncMicPipelineIfLanded(room,
#:       pub)` re-runs
#:       `#syncMicPipeline` when the landed track is the mic and the gate is
#:       empty. That is the F4 re-run (the D6 attach for a mic whose gate
#:       emptied mid-offer) but NOT only that: it fires on EVERY microphone
#:       landing under an empty gate — from the `"none"` arm as much as from
#:       `"resumeLanded"` — a plain non-E2EE join, a mic enabled after
#:       joining muted, a signal-reconnect republish; attach-at-publish on a
#:       plain call is intended, and `micPipelineAction` still decides (tune
#:       in place / none / attach) so an attached pipeline is only tuned.
#:       Before all of it, the `TrackEvent.UpstreamPaused` re-emit, which is
#:       what carries the server-side mute for the sid the answer just
#:       assigned. The `publish-kick-*` entries below pin what
#:       `publishKickAction` DECIDES; nothing here can pin that the tag is set
#:       only on a returned sweep (a held-gate emit), that it is deleted
#:       before the decision rather than on one arm only, that the
#:       `"resumeLanded"` op is built over `pub.track` with the landed
#:       `trackSid` rather than swept over the room, or that the mic re-run
#:       exists at all on either empty-gate arm. Restore the unconditional
#:       sweep and the consent-pending share goes on the wire ahead of its
#:       answer on every shell; restore the pre-wave-1 `size > 0` condition
#:       and the strand is back — both with every spec green.
#: AND THE TWO MIC-PIPELINE-DEFERRAL WIRINGS (plan D6, wave 2, 2026-09-14),
#: the same shape one wave later:
#:  (iii) the `micPipelineAction(...)` call inside `#syncMicPipeline`, after
#:       its `this.room() !== room` early return, that turns the pure decision
#:       into the branch taken — `"tune"` in place, `"none"` a plain return
#:       (the raw capture IS what the settings ask for; nothing to tear down),
#:       `"defer"` doing NOTHING (nothing stored; the wants are re-read when
#:       the edge fires), `"attach"` building the `VoiceAudioPipeline` and
#:       issuing `setProcessor` — plus the `gen = this.#connectGen` capture
#:       whose continuation `destroy()`s the pipeline when a `disconnect()`
#:       raced `init`. The `mic-pipeline-*` entries below pin what the
#:       decision SAYS; nothing here can pin that `#syncMicPipeline` asks it,
#:       that it feeds `this.#gateHeld()` rather than a constant, or that the
#:       `"defer"` arm really falls through to no attach. Bypass the call and
#:       the join-time RNNoise attach lands inside the held gate again, the
#:       1.4–2.8 s mirror window `setProcessor → replaceTrack(processed)`
#:       measured in rejoin-leak handoff §7.9, with every spec green.
#:  (iv) the re-run at the gate's single 1→0 edge: in `#resumeGate`, AFTER
#:       the awaited `#applyPublishGate(room)` sweep and only when
#:       `this.#publishGate.size === 0 && this.room() === room`, the
#:       fire-and-forget `this.#syncMicPipeline(room, this.#micPipelineWants())`
#:       that performs the deferred attach. Two things live here that no
#:       entry reaches: that the re-run EXISTS (drop it and a mic that joined
#:       under a held gate never gets its pipeline — a quality regression the
#:       user hears as "the noise filter is off", not a leak), and that it
#:       sits AFTER the sweep (plan F12 as corrected by the wave-2 audit: the
#:       `size === 0` re-check is only meaningful once the drive has settled,
#:       and an attach must not be issued while the sweep's own repause may
#:       still be mid-flight on the same sender; it is NOT a last-writer-wins
#:       race over the raw track — livekit's `mediaStreamTrack` getter
#:       prefers `processor.processedTrack` and `setProcessor` assigns
#:       `processor` before its `replaceTrack`, so either order converges
#:       on the processed track).
#: Same rule as above: no `expect="green"` entry and no `grep -qF` over a file
#: no runner can load. The live tier is what covers them, and on 2026-09-14 it
#: RAN (rejoin-leak handoff §7.10): wave 3's receiver-side frame tap and
#: reducer plus the subject's per-sender `getStats()` reads, in a `mixed` call,
#: two passes (`enhanced`, `browser`), 6/6 mic publishes under a held gate.
#: COVERED: (i) the hook — every sender read `packetsSent 0 / bytesSent 0` at
#: `localTrackPublished.entry`, at `resumeGate emptied:true` and at the resume
#: record itself, climbing only after the resume (subject-side counters; the
#: observer tap bound 40–240 ms late and proves only that nothing PERSISTED);
#: (iii)+(iv) D6 — `track.processorUpdate` +719 ms AFTER the gate-empty
#: (pass A); the `UpstreamPaused` re-emit — the peer-visible `mic_off` during
#: the hold (pass B, an operator DOM read). NOT covered: the empty-gate
#: `"resumeLanded"` arm of (ii) — in every episode the gate emptied AFTER the
#: publish had landed (the two consent republishes by ~55–64 ms, the other
#: four held to disconnect), so the mid-offer empty that arm exists for never
#: occurred and its resume never fired; the `"none"`-arm attach at publish
#: of (ii)'s mic re-run — all 6/6 landings were under a held gate, so every
#: kick read `"sweep"`, the one arm that never calls
#: `#syncMicPipelineIfLanded`, and the pass-A attach came +719 ms after the
#: gate-empty, from the 1→0 edge (iv), never from a landing (no
#: plain-call join, muted-join mic enable or signal-reconnect republish was
#: in the leg); and E2EE-on: the call was `mixed` throughout, so the seat
#: never ran `set_e2ee(true)`. Those three remain admitted here, not
#: measured, until an E2EE-on two-native-seat leg and a plain-call leg run.
#:
#: 🔴 AND THE WAVE-2 CHIP-SPLIT / ESCAPE WIRINGS (banner-honesty wave 2,
#: 2026-09-20), live-only for the same reason — `state.tsx` and the chip
#: component cannot be loaded by `node --test`:
#:  (v)   the `onEncryptionState` binding in `#buildMediaBinding`: ONE
#:        composite latch signal (`callEncryptionLatch`, `{ error, origin,
#:        mediaKeyed }`), written on `"loud"` under the `replaces` rule —
#:        `prev === undefined || prev.error === meta?.replaces
#:        ? { error, ...meta } : prev` — and cleared on `"clear"(error)`
#:        only when `prev.error === error` (identity-matched). The harness
#:        `#replay()` mirrors that rule VERBATIM and the session specs
#:        measure the MIRROR; nothing here can measure that `state.tsx`
#:        still implements it. Drop the `replaces` arm and a media→control
#:        upgrade leaves the OLD error latched under the old origin, every
#:        spec green. The two direct writers (store-owner mismatch,
#:        `sessionSetupDecision`'s `hold_loud`) write `{ error }` with no
#:        origin — row 2 of `chipState` — and no entry can see whether they
#:        still do.
#:  (vi)  the chip binding's `latch:` thunk inside the single
#:        `return chipStateFrom({` literal (`rtc-gate.sh` pins the literal,
#:        not the thunk): it narrows the composite latch to `{ origin,
#:        mediaKeyed }`. Hardcode `origin: "control"` there and every media
#:        latch reaches row 4's `cannot_verify` in the PRODUCT while
#:        `chipInputs.test.ts` and the session suite stay green —
#:        `harness-chip-origin-hardcoded` below pins the HARNESS copy of
#:        the same thunk, which is the most any entry can reach.
#:  (vii) the `confirmedVia: "app"` stamp in `#confirmNoSessionPlaintext`
#:        (the no-session in-app confirm). `interludeStickyAcrossResecure`
#:        is specified against `"app"` and `escape-app-interlude-sticky`
#:        pins the rule; whether THIS writer stamps it is unmeasured — drop
#:        the field and that interlude is permanently sticky across a
#:        re-secure. The stamp's OTHER consumer — the
#:        `confirmedVia !== "app"` conjunct on the ME-4 re-announce in
#:        `#onEpochAdvanced` (`mlsCallSession.ts`, the fix-pass F1 site) —
#:        IS measured: `escape-app-interlude-reannounces` below drops it and
#:        `mlsCallSession.escape.test.ts` spec 8 goes red.
#:  (viii) the `VoiceCallCardStatus.tsx` `label()` / `symbol()` /
#:        `variants.chip` arms for `cannot_verify`: `tsc` and the file's
#:        own `never` exhaustiveness check are what hold them; no spec
#:        renders the chip, and a Panda variant record is a bare object
#:        literal that applies NO style for a missing key rather than
#:        failing to compile.
#:
#: `chip-missing-frame-key-reads-keyed` was OWED here until the wave-2 fix
#: pass (2026-09-20) and deliberately NOT an entry before it: the harness's
#: `fakeInstaller.applyLocalKey` never threw `MissingLocalFrameKeyError`, so
#: the `#onRotationError` control latch that carries it could not be driven
#: from any spec, and an entry no spec can turn red is a green entry. The
#: seam (`world.failLocalKeyOnce(err)`) and the falsered spec ("the
#: missing-local-frame-key control latch reads mediaKeyed: false by
#: exclusion and never cannot_verify") landed together in that pass; the
#: entry now exists below, pinned `must_red` on that spec, which kills it at
#: both the emission deepEqual (`mediaKeyed: false`) and the chip assert.
#:
#: 🔴 AND THE WAVE-3 TWO-AXIS BANNER WIRINGS (banner-honesty wave 3,
#: 2026-09-20), live-only for the same reason — `state.tsx`, the banner
#: component and the watch overlay cannot be loaded by `node --test`:
#:  (ix)  the `callBanner()` accessor in `state.tsx`: it feeds
#:        `callBanner(...)` (`mlsCallModePolicy.ts`) with `hasSession:
#:        this.#mlsSession !== undefined`, `pauseDisproved:
#:        this.callPauseDisproved()` and `pauseDisproofConfirmed:
#:        this.callPauseDisproofConfirmed()` — the FIRST runtime consumer
#:        of the confirmed half. The `banner-*` entries below pin what the
#:        policy DOES with those three inputs; nothing here can pin that
#:        the accessor binds them rather than a literal (`hasSession:
#:        true` makes a session-less seat whose chip is NOT red — a plain
#:        call — read `securing` for its whole duration; the red table
#:        runs first, so the setup seats are the one thing it spares;
#:        transposing the two verdict readers is the same swap the
#:        "TWO VERDICT-READER ASSIGNMENTS" admission above records, now
#:        with a runtime consumer on BOTH halves).
#:  (x)   `VoiceCallDowngradeBanner.tsx`: Line A switches on
#:        `banner().kind`; Line B switches on the HELD pause clause — the
#:        raw `banner().pause` folded through `holdPauseClause` in ONE
#:        `createComputed`, with ONE `setTimeout(holdExpiresIn(state, now))`
#:        to re-evaluate when the hold lapses — and the direct
#:        `voice.callPauseDisproved()` `<Match>` is DELETED so there is one
#:        derivation. The `hold-*` entries pin what the fold DOES; nothing
#:        here can pin that the component feeds the fold rather than
#:        rendering `banner().pause` raw (the flash returns), that the
#:        timer is armed from `holdExpiresIn` rather than a literal, or
#:        that the `cannot_verify` / `terminal_loud` Rejoin action still calls
#:        `voice.connect(channel())` (the only in-call control that
#:        clears a keyed control latch). Nested JSX inside `<Trans>` and
#:        an unhedged pause claim are likewise no runner's to catch.
#:  (xi)  `WatchOverlay.tsx`'s single read, `bannerParksFloat(
#:        voice.callBanner())`: `banner-securing-parks` and
#:        `banner-disproved-does-not-park` pin the PREDICATE; whether the
#:        overlay asks it (rather than `!== "none"`, the round-5 defect
#:        that parked the player for a whole call) is unmeasured.
#:
#: 🔴 AND THE WAVE-4 CONSENT-HOLD WIRINGS (banner-honesty wave 4,
#: 2026-09-20), live-only for the same reason — `state.tsx` cannot be
#: loaded by `node --test`:
#:  (xii)  the `#consentHeld` `WeakSet` adds and deletes in
#:        `setScreenShareEnabled`. Keyed by the `LocalTrack` OBJECT
#:        (`shareTrack = localTrack.videoTrack`, the same object as
#:        `localTrack.track` for a ScreenShare publication, captured before
#:        the first await and fail-loud when absent), never by the
#:        publication or its sid:
#:        the E2EE-flip republish every escape press causes lands the SAME
#:        track under a NEW sid and a NEW publication, so a sid-keyed hold
#:        dies on it while the pause it names is still in force. The adds:
#:        `if (consentPending) this.#consentHeld.add(shareTrack)` right
#:        after `consentPending` is decided (before `setProcessor(shield)`
#:        / `screenAudioSupported` can let a 1→0 edge land); the idempotent
#:        re-add of `shareTrack` at the audio-branch consent pause; the
#:        re-add of `shareTrack` plus `audioTrack` at the ask-modal pause.
#:        The deletes: the consent callback's FIRST act releases the SHARE
#:        (before its own empty-gate direct resume); the audio track is
#:        released there ONLY when audio was GRANTED (`if (audioTrack &&
#:        audio)`) — declined, it stays held until the untick unpublish
#:        inside `callback` drops the object, so a 1→0 sweep landing in
#:        that window cannot resume an unmuted, upstream-paused
#:        getDisplayMedia audio track the user just refused. `onCancel`
#:        deletes both only AFTER `setScreenShareEnabled(false)` RESOLVES
#:        and KEEPS them when it rejects (it returns from its `catch` with
#:        the hold intact, `onErr` fired, `screenshare()` still true so the
#:        stop button stays the way out): livekit 2.15.13's
#:        `setTrackEnabled` awaits a pending `republishPromise` BEFORE it
#:        looks the publication up, so a rejecting republish rejects the
#:        cancel with the share still published and consent-paused, and a
#:        `finally` release would hand it to the next 1→0 sweep
#:        unconsented; deleting before the await would open the same
#:        window for the length of the unpublish. The GATE and EPISODE
#:        entries below pin what a held flag DOES; nothing here can pin
#:        that `state.tsx` still sets it, clears it at those two sites and
#:        no other, gates the audio release on the grant, keeps the hold
#:        on a rejected cancel, or keys it by the track — drop every add
#:        and the share streams pre-consent at the next 1→0 with every
#:        spec green.
#:  (xiii) `#sweepPublishGate` passing `(t) => this.#consentHeld.has(t)`
#:        into `gatedPublicationsFrom` on EVERY pass (the coalescing
#:        sweeper's closure is shared by every trigger; consulted only
#:        under an empty gate). `episode-consent-hold-not-stamped` pins
#:        what the adapter does with a predicate; drop the argument and the
#:        adapter's getter honestly reads `false`, every share resumes
#:        pre-consent at the next 1→0, and every spec is green.
#:  (xiv)  the `resumeLanded` arm of the `LocalTrackPublished` handler:
#:        `gatedPublicationFromSender({ source, sid, track },
#:        this.#consentHeld.has(pub.track))`.
#:        `episode-born-adapter-ignores-consent-flag` pins that the born
#:        adapter stamps its argument; pass nothing there and a republish
#:        whose offer/answer straddled a 1→0 (signal reconnect, declaration
#:        seam) re-tags the held share born-paused and resumes it ahead of
#:        its consent answer, every spec green.
STATE = "state.tsx"
GATE = "publishGate.ts"
EPISODE = "publishGateEpisode.ts"
VERDICT = "pauseVerdict.ts"
MIC_POLICY = "micPipelinePolicy.ts"
KICK_POLICY = "publishKickPolicy.ts"
WITNESS = "decodeWitnessListener.ts"
CHIP = "chipInputs.ts"
#: 🔴 Relative to `RTC`, like every other target here (`apply` reads
#: `RTC / mutation.file`) — NOT the `components/rtc/…` form the spec
#: constants use.
HOLD = "pauseClauseHold.ts"
TIMELINE = "mlsJoinTimeline.ts"
REJOIN_POLICY = "mlsRejoinPolicy.ts"
#: 🔴 NOT under `components/rtc`. `apply` and the restore in `main` both
#: address `RTC / mutation.file`, so a `components/client` module is named
#: relative to `RTC`, and the restore writes back to that same path.
INBOUND_BUFFER = "../client/mlsInboundBuffer.ts"
#: 🔴 Same form, same reason: relative to `RTC`, not `components/client/…`.
RESUME_KEEP = "../client/mlsResumeKeep.ts"

JOINRACE_SPEC = "components/rtc/mlsCallSession.joinrace.test.ts"
HEAL_SPEC = "components/rtc/mlsCallSession.heal.test.ts"
POLICY_SPEC = "components/rtc/mlsCallModePolicy.test.ts"
FALSERED_SPEC = "components/rtc/mlsCallSession.falsered.test.ts"
GATE_SPEC = "components/rtc/publishGate.test.ts"
EPISODE_SPEC = "components/rtc/publishGateEpisode.test.ts"
VERDICT_SPEC = "components/rtc/pauseVerdict.test.ts"
RESECURE_SPEC = "components/rtc/mlsCallSession.resecure.test.ts"
ESCAPE_SPEC = "components/rtc/mlsCallSession.escape.test.ts"
MIC_POLICY_SPEC = "components/rtc/micPipelinePolicy.test.ts"
KICK_POLICY_SPEC = "components/rtc/publishKickPolicy.test.ts"
WITNESS_SPEC = "components/rtc/decodeWitnessListener.test.ts"
CHIP_SPEC = "components/rtc/chipInputs.test.ts"
HOLD_SPEC = "components/rtc/pauseClauseHold.test.ts"
TIMELINE_SPEC = "components/rtc/mlsJoinTimeline.test.ts"
SESSION_TIMELINE_SPEC = "components/rtc/mlsCallSession.timeline.test.ts"
FLEET_SPEC = "components/rtc/mlsCallSession.fleet.test.ts"
GROUPSCOPE_SPEC = "components/rtc/mlsCallSession.groupscope.test.ts"
SERVEGUARD_SPEC = "components/rtc/mlsCallSession.serveguard.test.ts"
RESUME_SPEC = "components/rtc/mlsCallSession.resume.test.ts"
MAILBOX_SPEC = "components/rtc/mlsCallSession.mailbox.test.ts"
REJOIN_POLICY_SPEC = "components/rtc/mlsRejoinPolicy.test.ts"
INBOUND_BUFFER_SPEC = "components/client/mlsInboundBuffer.test.ts"
RESUME_KEEP_SPEC = "components/client/mlsResumeKeep.test.ts"
ALL_SPECS = [POLICY_SPEC, HEAL_SPEC, JOINRACE_SPEC]


@dataclass
class Mutation:
    id: str
    """The reviewed failure mode this re-introduces."""
    what: str
    file: str
    search: str
    replace: str
    specs: list[str] = field(default_factory=lambda: list(ALL_SPECS))
    #: "red"   — the specs MUST fail (the defect is caught)
    #: "green" — the specs must still pass (a deliberate non-assertion, with a
    #:           reason: the mutation is a UX/behaviour choice, not a posture)
    expect: str = "red"
    why_green: str = ""
    #: Specs that must go red INDIVIDUALLY, each judged on its own.
    #:
    #: 🔴 `specs` above is judged as a whole and `judge` returns on the FIRST
    #: non-green spec, so a spec listed there is invisible to the verdict
    #: whenever an earlier one already fails. A claim about a SPECIFIC spec —
    #: "this mutation proves the session harness runs the real assembly" — is
    #: therefore unprovable through `specs` and belongs here. Round 7 learned
    #: this the expensive way: it pinned three mutations to JOINRACE_SPEC
    #: alongside a CHIP_SPEC that always reddens, and the pin was measured
    #: inert.
    must_red: list[str] = field(default_factory=list)
    #: Further `(search, replace)` edits to the SAME `file`, applied after the
    #: first, each held to the same exactly-once rule.
    #:
    #: 🔴 For a defect that only exists as a CONJUNCTION. The stagger entry
    #: below re-introduces a timing (a short Welcome wait) together with the
    #: guards that made that timing harmless. When it was written (wave 1)
    #: each half alone left its spec green, so two separate entries would both
    #: have been "uncaught" and proved nothing about the defect; wave 1.5 added
    #: a guard and the entry a third edit (see its comment). Every edit is
    #: applied in memory and the file written once, so a stale anchor in any of
    #: them refuses before the tree is touched.
    also: list[tuple[str, str]] = field(default_factory=list)


MUTATIONS: list[Mutation] = []


# A mutant that HANGS is not a result. `node --test`'s own `--test-timeout`
# cannot fire on a loop that never yields to the event loop (a runaway
# `while`/`do-while` over awaited microtasks), so the only reliable bound is
# wall-clock on the process. Sized well above the slowest honest spec file —
# re-measured 2026-09-10: `mlsCallSession.joinrace.test.ts` at 1.6 s wall, next
# falsered 0.8 s — and well below anything a human would sit through.
#
# 🔴 NO ENTRY COUNT AND NO TOTAL RUNTIME ARE RECORDED HERE, deliberately. Every
# prose count this file has carried has been wrong within days: "15 s" and
# "20+ minutes" were out by an order of magnitude, "~55 s" was measured at a
# smaller table, and the "64 entries / 99 s" that replaced THAT was corrected
# to "66 / 107 s" in the very edit that appended two more entries and made it
# 68. A wave dispatched to purge stale counts shipped one. The run PRINTS its
# own entry count and wall time at the end, and `--list` derives the count from
# the table itself — read those, and do not re-add a number here.
SPEC_TIMEOUT_S = 120


#: The three things a spec run under a mutation can mean. `PROBLEM` is the one
#: this runner used to be unable to say, and it is NOT a catch: it is "this
#: mutation measured nothing, and the OK it would have printed is a lie".
GREEN = "green"
RED = "red"
PROBLEM = "problem"


def counter(out: str, name: str) -> int | None:
    """node:test's own summary counter, or None when it printed no summary.

    Same shape as `rtc-gate.sh`'s `counter()`, deliberately: the reporter's
    leading glyph is not ASCII and differs between reporters, so match "any run
    of non-alphanumerics" and anchor the number at end of line. Take the LAST
    match so nothing printed earlier can shadow the summary block.
    """
    found = re.findall(rf"^[^A-Za-z0-9]*{name} ([0-9]+)$", out, re.MULTILINE)
    return int(found[-1]) if found else None


@dataclass
class SpecResult:
    """One `node --test` run, read for BOTH its status and its counters."""

    spec: str
    returncode: int | None = None
    tests: int | None = None
    passed: int | None = None
    failed: int | None = None
    skipped: int | None = None
    timed_out: bool = False


def run_spec(spec: str) -> SpecResult:
    """Run one spec file. Never raises; a timeout is a result, not an error."""
    try:
        proc = subprocess.run(
            [NODE, "--test", "--conditions=browser", spec],
            cwd=CLIENT,
            capture_output=True,
            text=True,
            timeout=SPEC_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return SpecResult(spec, timed_out=True)
    out = f"{proc.stdout}\n{proc.stderr}"
    return SpecResult(
        spec,
        returncode=proc.returncode,
        tests=counter(out, "tests"),
        passed=counter(out, "pass"),
        failed=counter(out, "fail"),
        skipped=counter(out, "skipped"),
    )


#: spec path -> (tests, skipped) as measured on the unmutated tree, filled by
#: `baseline_green` before any mutation is applied. Every mutant run must
#: reproduce both numbers exactly; see `judge`.
BASELINE: dict[str, tuple[int, int]] = {}


def judge(specs: list[str]) -> tuple[str, str]:
    """GREEN / RED / PROBLEM for one mutant, with the sentence that says why.

    🔴 THIS IS THE HOLE THE WAVE-1 AUDIT FOUND. `proc.returncode != 0` alone
    cannot tell an assertion failure from a module that would not load, and a
    mutant that fails to load is the one shape that reads as a catch while
    asserting NOTHING. So a red is only a red when:

      * the run printed a summary at all (no summary means it died before the
        reporter, i.e. almost always a parse/import failure);
      * it EXECUTED the same number of tests as the baseline, and the same
        number of skips — fewer tests means the mutant stopped part of the
        suite from running, which is a broken mutation, not a caught defect;
      * `pass + fail + skipped` accounts for every executed test; and
      * `fail > 0`, i.e. an ASSERTION failed. A non-zero exit with `fail 0` is
        a process-level death dressed as a catch.

    Anything else is PROBLEM, which the caller counts as unexpected, exactly
    like a mutation that went green when it should have gone red.

    A spec set is walked in order and the first non-green spec decides, so a
    genuine catch still costs one spec run rather than all of them.
    """
    for spec in specs:
        want = BASELINE.get(spec)
        if want is None:  # only reachable if a caller skipped baseline_green
            return (PROBLEM, f"{spec} has no baseline count — refusing to judge")
        want_tests, want_skipped = want
        r = run_spec(spec)
        if r.timed_out:
            # Kept as a RED on purpose, and it is the one red not backed by an
            # assertion: a mutant that never terminates broke termination,
            # which no counter can describe and which no honest run can call
            # green. Said out loud rather than folded in silently.
            return (
                RED,
                f"{spec} TIMED OUT after {SPEC_TIMEOUT_S}s — the mutant broke "
                f"termination. Counted as caught, but NOT by an assertion.",
            )
        if r.tests is None or r.passed is None or r.failed is None or r.skipped is None:
            return (
                PROBLEM,
                f"{spec} printed no summary counters (exit {r.returncode}) — "
                f"the mutant almost certainly did not LOAD, so this entry "
                f"measured nothing.",
            )
        if r.tests != want_tests or r.skipped != want_skipped:
            return (
                PROBLEM,
                f"{spec} executed {r.tests} test(s)/{r.skipped} skipped, "
                f"baseline {want_tests}/{want_skipped} — the mutant did not "
                f"run the same suite, so a red here is not evidence.",
            )
        if r.passed + r.failed + r.skipped != r.tests:
            return (
                PROBLEM,
                f"{spec}: pass {r.passed} + fail {r.failed} + skipped "
                f"{r.skipped} != tests {r.tests} — the run did not account for "
                f"every test.",
            )
        if r.failed > 0:
            return (
                RED,
                f"{spec}: {r.failed} failing assertion(s) with all {r.tests} "
                f"test(s) executed",
            )
        if r.returncode != 0:
            return (
                PROBLEM,
                f"{spec} exited {r.returncode} with fail 0 — red without a "
                f"failing assertion, so it is not a catch.",
            )
    return (GREEN, f"all {len(specs)} spec file(s) green at full baseline counts")


def baseline_green(mutations: list[Mutation]) -> bool:
    """Every spec file any mutation relies on must pass on the UNMUTATED tree.

    Without this the run is vacuous in the dangerous direction: EVERY mutation
    expects RED, so a spec set already failing — for a reason having nothing to
    do with any mutation — makes every one of them report OK and the run prints
    "N run, 0 unexpected". Same silent-pass class `rtc-gate.sh` exists to kill.

    This used to lean partly on the one `expect="green"` entry as a canary.
    There is no green entry any more (wave 1 flipped the last one), so this
    function is now the ONLY thing standing between a broken spec file and a
    completely vacuous green run. Do not weaken it.

    It also RECORDS what it measured. `BASELINE` is what makes a mutant's own
    counters readable: without a number to compare against, "the specs went
    red" cannot be separated from "the file stopped loading". The numbers are
    measured here rather than committed, so there is nothing in this file to go
    stale against `rtc-gate.sh`'s EXPECTED table.
    """
    specs = sorted({spec for m in mutations for spec in [*m.specs, *m.must_red]})
    print(f"=============== baseline: {len(specs)} spec file(s) ===============")
    for spec in specs:
        r = run_spec(spec)
        if r.timed_out:
            print(f">>> BASELINE FAIL: {spec} timed out after {SPEC_TIMEOUT_S}s")
            return False
        if r.tests is None or r.passed is None or r.failed is None or r.skipped is None:
            print(
                f">>> BASELINE FAIL: {spec} printed no summary counters "
                f"(exit {r.returncode}) — refusing to run against an "
                f"unreadable baseline"
            )
            return False
        # `node --test` exits 0 on ZERO tests and an EMPTY spec file reports
        # `pass 1`, so the status alone would bless a suite that ran nothing.
        if r.tests == 0:
            print(f">>> BASELINE FAIL: {spec} EXECUTED ZERO TESTS (and exited 0)")
            return False
        if r.returncode != 0 or r.failed != 0:
            print(
                f">>> BASELINE FAIL: {spec} is not green before any mutation "
                f"(exit {r.returncode}, fail {r.failed})"
            )
            return False
        BASELINE[spec] = (r.tests, r.skipped)
        print(
            f"    {spec}: tests {r.tests} skipped {r.skipped} "
            f"— the pin every mutant must reproduce"
        )
    print(">>> BASELINE OK: every spec green on the unmutated tree")
    return True


@contextlib.contextmanager
def exclusive_run_lock() -> Iterator[None]:
    """Refuse to run while another run is mutating THIS worktree. Never waits.

    🔴 The second hole the wave-1 audit found: this script mutates SHARED
    SOURCE in the live worktree with no lock at all. Two concurrent runs
    interleave — run A applies its mutation, run B reads that mutated text as
    "original", reverts to it after its own mutation, and both then score
    someone else's defect as their own catch, or write a mutation back into the
    tree permanently. Every result from such a pair is unusable, and nothing in
    the output says so.

    REFUSES rather than queues, which is the whole point. Waiting would make
    the second run's baseline wrong in a way it cannot see (it would measure a
    tree the first run is busy mutating), and a run that silently sat for
    twenty minutes is a run somebody kills — which is the failure mode that
    leaves the worktree MUTATED. A refusal is loud, immediate and costs
    nothing.

    The lockfile lives in the system temp dir, keyed by the worktree path,
    NOT in the worktree: a lock inside the tree would show up as untracked dirt
    in exactly the `git status` this script's users are told to check after a
    run.

    A STALE lock is not cleaned up automatically, and that is deliberate too.
    This process removes its own lock on every exit path Python can see,
    Ctrl-C included, so a lock left behind means a run was killed OUTRIGHT
    mid-mutation — which is precisely the case where the worktree still holds
    somebody's mutation. Being made to look before deleting it is the point.
    """
    key = hashlib.sha1(str(CLIENT).encode("utf-8")).hexdigest()[:12]
    lock = Path(tempfile.gettempdir()) / f"rtc-mutations-{key}.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        try:
            held = lock.read_text(encoding="utf-8").strip()
        except OSError:
            held = "(unreadable)"
        print("################ MUTATIONS: REFUSING TO RUN ################")
        print(f"    another run holds {lock}")
        print(f"    {held}")
        print("    This script mutates shared source in the live worktree, so")
        print("    two runs would score one another's mutations. It refuses")
        print("    rather than waits.")
        print("    If that run is gone it was killed MID-MUTATION: check")
        print(f"    `git -C {CLIENT} status` and `git diff` for leftover")
        print("    mutated source FIRST, then delete the lockfile.")
        raise SystemExit(96)
    with os.fdopen(fd, "w") as fh:
        fh.write(
            f"pid {os.getpid()} started {datetime.now(timezone.utc).isoformat()} "
            f"worktree {CLIENT}\n"
        )
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            lock.unlink()


def apply(mutation: Mutation) -> str:
    path = RTC / mutation.file
    original = path.read_text(encoding="utf-8")
    mutated = original
    for search, replace in [(mutation.search, mutation.replace), *mutation.also]:
        count = mutated.count(search)
        if count == 0:
            raise SystemExit(
                f"MUTATION {mutation.id}: search string not found in "
                f"{mutation.file} — refusing to report a result.\n"
                f"  looked for: {search!r}"
            )
        if count > 1:
            raise SystemExit(
                f"MUTATION {mutation.id}: search string is ambiguous "
                f"({count} matches) in {mutation.file} — refusing to guess."
            )
        # 🔴 MFR-n3 (2026-09-27): every search begins at the START of a line.
        # "Exactly once" is not enough on its own: a search written for a line
        # at one indentation also matches, once, as the tail of a line nested
        # one level deeper, and then mutates a substring of a line it does not
        # name. Measured twice on this branch before it was a rule here: the
        # merge fix pass found `late-welcome-resets-latch` inserting a
        # mis-indented line and `repause-order-inverted` matching an 8-space
        # search inside a 10-space line, both through a check that lived
        # only in a scratch script. A search that needs only part of a line
        # carries the whole line's leading text instead.
        at = mutated.index(search)
        if at > 0 and mutated[at - 1] != "\n":
            line = mutated.count("\n", 0, at) + 1
            raise SystemExit(
                f"MUTATION {mutation.id}: search string starts mid-line "
                f"(line {line} of {mutation.file}, column "
                f"{at - mutated.rfind(chr(10), 0, at)}) — anchor it at the "
                f"start of its line; refusing to mutate a substring.\n"
                f"  looked for: {search!r}"
            )
        mutated = mutated.replace(search, replace)
    path.write_text(mutated, encoding="utf-8")
    return original


def preflight(mutations: list[Mutation]) -> list[str]:
    """Every reason an entry would measure nothing, found WITHOUT writing.

    🔴 `apply` refuses a search that is missing or ambiguous, but only when it
    reaches that entry, deep into a run with the entries before it already
    spent, and a table that has drifted in one place has usually drifted in
    several. The FE-2 merge retired voice-move's handler and left five
    searches matching nothing, found by a reviewer reading the table. So the
    whole table is checked up front, on every run, `--only` included, before
    the lock is taken or a spec runs: each entry's `search` and every `also`
    edit must occur exactly once in its target, applied in order in memory
    exactly as `apply` would, and must change the text. Its target must sit
    inside this client package, never the stoat.js submodule (D8: the suite
    does not mutate the submodule's tree), and every spec it names must exist.
    """
    problems: list[str] = []
    ids: set[str] = set()
    for m in mutations:
        if m.id in ids:
            problems.append(f"{m.id}: duplicate id")
        ids.add(m.id)
        if m.expect not in (RED, GREEN):
            problems.append(f"{m.id}: expect={m.expect!r} is neither red nor green")
        if not m.specs:
            problems.append(f"{m.id}: names no spec, so nothing can catch it")
        # The header's file=STATE rule, enforced rather than only stated.
        if m.file == STATE and not m.id.startswith("state-"):
            problems.append(
                f"{m.id}: targets {STATE}, which only `state-*` entries may "
                f"(see the file=STATE rule in the header)"
            )
        path = RTC / m.file
        if CLIENT.resolve() not in path.resolve().parents:
            problems.append(f"{m.id}: target {m.file} is outside {CLIENT}")
            continue
        try:
            original = path.read_text(encoding="utf-8")
        except OSError as e:
            problems.append(f"{m.id}: cannot read {m.file}: {e}")
            continue
        mutated = original
        for n, (search, replace) in enumerate([(m.search, m.replace), *m.also]):
            count = mutated.count(search)
            if count != 1:
                problems.append(
                    f"{m.id}: edit {n} occurs {count} time(s) in {m.file}, "
                    f"not exactly once: {search[:120]!r}"
                )
                break
            # The start-of-line rule `apply` enforces (MFR-n3), checked here
            # too: without it this passed twelve entries `apply` refuses.
            at = mutated.index(search)
            if at > 0 and mutated[at - 1] != "\n":
                problems.append(
                    f"{m.id}: edit {n} starts mid-line in {m.file}: "
                    f"{search[:120]!r}"
                )
                break
            if search == replace:
                problems.append(f"{m.id}: edit {n} replaces its search with itself")
            mutated = mutated.replace(search, replace)
        else:
            if mutated == original:
                problems.append(f"{m.id}: its edits leave {m.file} unchanged")
        for spec in [*m.specs, *m.must_red]:
            if not (CLIENT / spec).is_file():
                problems.append(f"{m.id}: spec {spec} does not exist")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--only", default="")
    #: Only the checks `preflight` makes, over the whole table; nothing is
    #: written and no spec runs, so it is safe beside any other lane.
    ap.add_argument("--preflight", action="store_true")
    args = ap.parse_args()

    if args.preflight or not args.list:
        problems = preflight(MUTATIONS)
        for p in problems:
            print(f">>> PREFLIGHT FAIL: {p}")
        if problems:
            print(f"################ MUTATIONS: {len(problems)} table problem(s), "
                  f"refusing to run ################")
            return 95
        if args.preflight:
            print(f">>> PREFLIGHT OK: all {len(MUTATIONS)} entries apply exactly once")
            return 0

    if args.list:
        for m in MUTATIONS:
            print(f"{m.id:<28} [{m.expect:>5}] {m.what}")
        # 🔴 DERIVED, and deliberately not written down in the prose above.
        # Every number this pair of scripts has committed to prose has gone
        # stale at least once — the runtime estimate twice, and `rtc-gate.sh`'s
        # worked example of "declares N top-level `test(`" once — while a tally
        # recomputed on every invocation cannot. If a count belongs in a
        # commit, it belongs in `rtc-gate.sh`'s EXPECTED table, where going
        # stale turns the gate RED instead of just misinforming a reader.
        tally: dict[str, int] = {}
        for m in MUTATIONS:
            tally[m.file] = tally.get(m.file, 0) + 1
        by_file = ", ".join(f"{n} {f}" for f, n in sorted(tally.items()))
        print()
        print(f"{len(MUTATIONS)} entries: {by_file}")
        return 0

    wanted = {s for s in args.only.split(",") if s}
    selected = [m for m in MUTATIONS if not wanted or m.id in wanted]
    if wanted:
        missing = wanted - {m.id for m in selected}
        if missing:
            raise SystemExit(f"no such mutation(s): {', '.join(sorted(missing))}")
    if not selected:
        raise SystemExit("no mutations selected — refusing to report a pass")

    started = time.monotonic()
    # The lock covers the BASELINE too: a concurrent run that is mid-mutation
    # makes this run's baseline a measurement of somebody else's defect.
    with exclusive_run_lock():
        if not baseline_green(selected):
            print("################ MUTATIONS: refusing to run ################")
            return 97

        failures: list[str] = []
        for i, m in enumerate(selected, 1):
            print(f"=============== [{i}/{len(selected)}] {m.id} ===============")
            print(f"    {m.what}")
            path = RTC / m.file
            original = apply(m)
            try:
                got, why = judge(m.specs)
                # Each `must_red` spec on its own — see the field's comment.
                # 🔴 INSIDE the try, while the mutation is still applied.
                # Judging after the `finally` runs the specs against the
                # RESTORED tree, where they are green by construction.
                pinned = [(spec, *judge([spec])) for spec in m.must_red]
            finally:
                path.write_text(original, encoding="utf-8")
            print(f"    {why}")
            unmet = [(spec, g, w) for spec, g, w in pinned if g != RED]
            for spec, g, w in unmet:
                print(f"    >>> but {spec} went {g}, and this mutation asserts "
                      f"that it must go red on its own: {w}")
            if got == PROBLEM:
                # NOT a catch, and deliberately not phrased as one: the entry
                # measured nothing, which is worse than a mutation that went
                # green, because it would have printed OK forever.
                print(f">>> PROBLEM: {m.id} measured nothing — see the line above")
                failures.append(f"{m.id} (PROBLEM: the mutant never ran the suite)")
                continue
            ok = got == m.expect and not unmet
            print(f">>> {'OK  ' if ok else 'FAIL'}: expected {m.expect}, specs went {got}")
            if not ok:
                failures.append(m.id)

    elapsed = time.monotonic() - started
    print()
    print(f"################ MUTATIONS: {len(selected)} run, "
          f"{len(failures)} unexpected ################")
    for f in failures:
        print(f"    unexpected: {f}")
    # Printed so the runtime estimate at SPEC_TIMEOUT_S can be re-derived
    # instead of guessed at; two earlier guesses were wrong by an order of
    # magnitude.
    print(f"    ({elapsed:.0f}s wall for {len(selected)} mutation(s))")
    return 1 if failures else 0


# --- The reviewed failure modes, one mutation each ---------------------------
#
# Each entry re-introduces exactly one defect a `media-e2ee-reviewer` round
# found on `fix/mls-joinrace-window` or on this branch. `expect="red"` means the
# specs MUST catch it.

MUTATIONS += [
    # ---- the deferred verdict itself ---------------------------------------
    Mutation(
        id="no-deferral",
        what="a decode missing key during an observed membership change is not held at all",
        file=SESSION,
        search="""    if (
      cls.kind === "missing_key" &&
      (this.#rotationWindow || this.#membershipChangeObserved())
    ) {""",
        replace="""    if (
      false &&
      (this.#rotationWindow || this.#membershipChangeObserved())
    ) {""",
    ),
    Mutation(
        id="rotation-arm-shadows-hold",
        what="a missing key INSIDE a rotation window takes the cancellable escalation instead of the hold",
        file=SESSION,
        search="""      cls.kind === "missing_key" &&
      (this.#rotationWindow || this.#membershipChangeObserved())""",
        replace="""      cls.kind === "missing_key" &&
      !this.#rotationWindow &&
      (this.#rotationWindow || this.#membershipChangeObserved())""",
    ),
    Mutation(
        id="advance-without-fill-resolves",
        what="the hold resolves on an install that ADVANCED past the index without FILLING it",
        file=SESSION,
        search="""        if (
          this.#mediaErrors.pairFilledAtSeq(hold.identity, pair) !== undefined
        ) {""",
        replace="""        if (!this.#mediaErrors.uncoveredPairs().includes(pair)) {""",
    ),
    Mutation(
        id="refreshing-deadline",
        what="a second error for the same pair walks the hold's bound forward",
        file=SESSION,
        search="""    if (this.#joinRaceHolds.has(pair)) return true; // the first deadline stands""",
        replace="""    const open = this.#joinRaceHolds.get(pair);
    if (open) {
      this.#cancelHoldTimer(open);
      open.remainingMs = JOIN_RACE_DEFER_MS;
      open.armedAt = performance.now();
      open.timer = this.#armHoldDeadline(pair, error, JOIN_RACE_DEFER_MS);
      return true;
    }""",
    ),
    Mutation(
        id="rearm-takes-fresh-bound",
        what="a suspended hold re-arms with a FRESH bound instead of its banked budget",
        file=SESSION,
        search="""          hold.timer = this.#armHoldDeadline(
            pair,
            hold.error,
            hold.remainingMs,
          );""",
        replace="""          hold.timer = this.#armHoldDeadline(
            pair,
            hold.error,
            JOIN_RACE_DEFER_MS,
          );""",
    ),
    Mutation(
        id="roster-resolve-without-sfu-conjunct",
        what="a sender out of the GROUP but still SFU-present and publishing resolves the hold",
        file=SESSION,
        search="""        if (
          readable &&
          !present.has(hold.identity) &&
          this.#lastRosterIdentities.size > 0 &&""",
        replace="""        if (
          readable &&
          this.#lastRosterIdentities.size > 0 &&""",
    ),
    # ---- the amber the deferral rests on ------------------------------------
    Mutation(
        id="amber-never-surfaced",
        what="an open join-race hold does not drive the chip amber",
        file=SESSION,
        search="""    const active = this.#joinRaceHolds.size > 0 || this.#resecure.size > 0;""",
        replace="""    const active = this.#resecure.size > 0;""",
    ),
    Mutation(
        id="amber-dropped-before-loud",
        what="the amber is dropped BEFORE the loud is reported, so the chip computes a green in between",
        file=SESSION,
        # Retargeted 2026-09-20 (banner-honesty wave 2): every `"loud"` now
        # rides with `{ origin, mediaKeyed }` (`LoudLatchMeta`). Same defect,
        # same two lines, three-argument emit.
        search="""    this.#media?.onEncryptionState?.("loud", error, { origin, mediaKeyed });
    // The strictest reading has now been taken about the MEDIA plane, so""",
        replace="""    this.#clearJoinRaceHolds();
    this.#media?.onEncryptionState?.("loud", error, { origin, mediaKeyed });
    // The strictest reading has now been taken about the MEDIA plane, so""",
    ),
    # ---- who may cancel what ------------------------------------------------
    Mutation(
        id="recovery-echo-cancels-hold",
        what="an SFU-declared encryption status cancels an open join-race hold",
        file=SESSION,
        search="""    if (!this.#hasLocalKey) return;
    // ...and a MEDIA-plane escalation is not this signal's to cancel at all.""",
        replace="""    if (!this.#hasLocalKey) return;
    this.#clearJoinRaceHolds();
    // ...and a MEDIA-plane escalation is not this signal's to cancel at all.""",
    ),
    Mutation(
        id="recovery-echo-force-clears",
        what="an SFU-declared encryption status force-clears every pending escalation",
        file=SESSION,
        search="""    if (!this.#hasLocalKey) return;
    // ...and a MEDIA-plane escalation is not this signal's to cancel at all.""",
        replace="""    if (!this.#hasLocalKey) return;
    this.#clearResecureTimer();
    // ...and a MEDIA-plane escalation is not this signal's to cancel at all.""",
    ),
    Mutation(
        id="token-blind-clear",
        what="#clearResecureTimer ignores the cancel token and clears every reason",
        file=SESSION,
        search="""      reason !== undefined ? [reason] : [...this.#resecure.keys()];""",
        replace="""      [...this.#resecure.keys()];""",
    ),
    Mutation(
        id="latch-force-clears-control",
        what="a media loud latch subsumes the control seam's escalation",
        file=SESSION,
        search="""    this.#clearResecureTimer("joiner");
    this.#clearResecureTimer("media");""",
        replace="""    this.#clearResecureTimer();""",
    ),
    Mutation(
        id="unscoped-joiner-clear",
        what="our own first key clears every escalation, not just the joiner one",
        file=SESSION,
        search="""    this.#clearResecureTimer("joiner");
    // ...and the errors it covered are re-judged now that we hold keys.""",
        replace="""    this.#clearResecureTimer();
    // ...and the errors it covered are re-judged now that we hold keys.""",
    ),
    # ---- the heal's witnesses ----------------------------------------------
    Mutation(
        id="heal-accepts-pre-latch-fill",
        what="the heal's refilled-pair witness asks whether the pair was EVER pushed, not pushed since the latch",
        file=SESSION,
        search="""        ) ?? -1) > this.#loudLatchedInstallSeq &&""",
        replace="""        ) ?? -1) >= 0 &&""",
    ),
    Mutation(
        id="heal-clause-jumps-empty-witness-hold",
        what="the refilled-pair clause runs IN FRONT of the empty-witness hold",
        file=POLICY,
        search="""  if (inputs.peers.length === 0) return "hold";
  if (inputs.unfilledElsewhere) return "hold";
  // Behind the empty-witness hold, never in front of it.
  if (inputs.originatingPairRefilled) return "heal";""",
        replace="""  if (inputs.originatingPairRefilled) return "heal";
  if (inputs.peers.length === 0) return "hold";
  if (inputs.unfilledElsewhere) return "hold";""",
    ),
    Mutation(
        id="heal-ignores-other-unfilled",
        what="the heal ignores an index a DIFFERENT present sender was silenced at",
        file=POLICY,
        search="""  if (inputs.unfilledElsewhere) return "hold";
  // Behind the empty-witness hold, never in front of it.""",
        replace="""  // Behind the empty-witness hold, never in front of it.""",
    ),
    Mutation(
        id="unfilled-counts-pre-first-key",
        what="unfilledPairs counts pairs heard before this device held any key of the group",
        file=POLICY,
        search="""      .filter(([pair, beforeFirstKey]) => !beforeFirstKey && !filled?.has(pair))""",
        replace="""      .filter(([pair]) => !filled?.has(pair))""",
    ),
    Mutation(
        id="first-fill-only-install-stamp",
        what="noteInstalled records only a pair's FIRST fill, so the bystander heal expires at the ring wrap",
        file=POLICY,
        search="""        if (!rec.pairs.has(pair)) advanced = true;
        rec.pairs.set(pair, installSeq);""",
        replace="""        if (!rec.pairs.has(pair)) {
          advanced = true;
          rec.pairs.set(pair, installSeq);
        }""",
    ),
]

# --- The false-red / false-pause fix (join-race legs, 2026-09-08) ------------
#
# `publishGate.ts` + `mlsCallSession.falsered.test.ts`. Group 1 is the pure
# decision, group 2 the sweep BODY (reachable as mutations only because the
# executor is injectable — `publishGate.test.ts` drives the real one against a
# fake of livekit's bookkeeping, including the DEFERRED `sender.track` write and
# the per-track FIFO mutex, rather than re-implementing the mapping), group 3 the
# session-level invariant and the loud's own reachability.

MUTATIONS += [
    # ---- the decision ------------------------------------------------------
    Mutation(
        id="gate-trusts-a-quiet-wire-under-a-cleared-flag",
        what="a detached sender is called proven quiet even with livekit's flag CLEARED — i.e. mid-attach (the fail-open the two-valued observable had)",
        file=GATE,
        search="""  return inputs.upstreamPaused ? "none" : "pause";""",
        replace="""  return "none";""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="gate-trusts-stale-pause-flag",
        what="a live sender whose pause FLAG says paused takes a bare pause, which early-returns (the original defect)",
        file=GATE,
        search="""    return inputs.upstreamPaused ? "repause" : "pause";""",
        replace="""    return "pause";""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="held-gate-resumes",
        what="the gate's sense is inverted — a held gate resumes publishing",
        file=GATE,
        search="""  if (!inputs.gateHeld) return "resume";""",
        replace="""  if (inputs.gateHeld) return "resume";""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="gate-pause-spams-an-unpublished-track",
        what="a publication with no sender is pause-called on every sweep, spamming livekit's unpublished-track warning",
        file=GATE,
        search="""  if (inputs.upstream === "unpublished") return "none";""",
        replace="""  if (inputs.upstream === "unpublished") return "pause";""",
        specs=[GATE_SPEC],
    ),
    # ---- the sweep body ----------------------------------------------------
    Mutation(
        id="repause-order-inverted",
        what="repause resumes twice instead of resume-then-pause, leaving the sender live",
        file=GATE,
        # Retargeted 2026-09-09 (wave 1): the repause arm's detach is now a
        # named promise with its own two catches, so the old
        # `await publication.pauseUpstream();` line no longer exists. Same
        # site, same defect — `detaching` is now fed by a RESUME.
        # Indentation corrected 2026-09-27 (merge fix pass, MFG): the line
        # sits at 10 spaces, so the 8-space search matched a substring of
        # it. The mutated file is byte-identical either way; the search now
        # names the whole line.
        search="""          detaching = publication.pauseUpstream();""",
        replace="""          detaching = publication.resumeUpstream();""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="repause-drops-the-gate-recheck",
        what="repause pauses even after the gate emptied, muting a healthy call with nothing left to resume it",
        file=GATE,
        # Retargeted 2026-09-09 (wave 1). `if (!gateHeld()) return null;` now
        # occurs twice in the file, so it cannot anchor on its own; the
        # comment banner immediately below it is the unique discriminator and
        # is itself load-bearing prose about this exact re-check.
        search="""        if (!gateHeld()) return null;
        // \U0001f534 THE ONE SITE""",
        replace="""        // \U0001f534 THE ONE SITE""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="sweep-swallows-a-failed-pause",
        what="the outer catch discards a read that threw, so a publication nothing could observe is reported as swept",
        file=GATE,
        # Retargeted 2026-09-09 (wave 1) at the SAME site — runOne's outer
        # catch — whose return grew the `issued` / `unreadable` fields. The
        # `what` is narrowed to match what wave 0 left reaching this catch:
        # both pausing arms now catch their own detach, so a failed pause no
        # longer lands here. Discarding it is still the same fail-open shape
        # (a publication that could not be observed reported as fine).
        search="""    return {
      kind: "unproven",
      name: publication.name,
      op,
      issued,
      unreadable: true,
    };
  }
}""",
        replace="""    return null;
  }
}""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="sweep-skips-the-post-condition",
        what="the sweep reports success without re-reading the wire",
        file=GATE,
        # Retargeted 2026-09-09 (wave 1): the unproven return grew `issued`.
        search="""    if (publication.upstream() !== "live") {
      return { kind: "proven", name: publication.name, op };
    }
    return { kind: "unproven", name: publication.name, op, issued };""",
        replace="""    return null;""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="sweep-awaits-inside-its-loop",
        what="ops are no longer all issued before the first await, so livekit's FIFO lock no longer reflects issue order",
        file=GATE,
        search="""    pending.push(
      runOne(
        publication,
        held,""",
        replace="""    await Promise.resolve();
    pending.push(
      runOne(
        publication,
        held,""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="resume-failure-folded-into-unproven",
        what="a resume that threw is reported as an unproven PAUSE, so a caller acting only on a held gate discards it — silently muted, no telemetry",
        file=GATE,
        search="""        try {
          await publication.resumeUpstream();
        } catch {
          return { kind: "failed", name: publication.name, op };
        }
        if (gateHeld()) return null; // the gate refilled under us
        // `unpublished` is not a failure: there is nothing to put back.
        return publication.upstream() === "quiet"
          ? { kind: "failed", name: publication.name, op }
          : null;""",
        replace="""        await publication.resumeUpstream();
        return null;""",
        specs=[GATE_SPEC],
    ),
    # ---- the live-lock bound (fourth review) -------------------------------
    Mutation(
        id="sweeper-nests-on-re-entry",
        what="the coalescing sweeper assigns its promise AFTER starting the run, so a re-entrant trigger sees no sweep in flight and starts its own — 3060 nested passes in 28 ms when this was first written",
        file=GATE,
        search="""      let settle!: () => void;
      let fail!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      active = done;
      drive().then(settle, fail);
      return done;""",
        replace="""      active = drive();
      return active;""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="sweeper-pass-cap-removed",
        what="a run whose every pass re-triggers is unbounded",
        file=GATE,
        search="""      } while (pending && --budget > 0);""",
        replace="""      } while (pending);""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="spent-repause-retried-forever",
        what="a repause that already failed is attempted again on every pass, re-attaching the sender each time — the live-lock's energy source",
        file=GATE,
        search="""        if (repauseSpent) break;""",
        replace="""        if (false && repauseSpent) break;""",
        specs=[GATE_SPEC],
    ),
    # ---- what may spend a publication, and what may cancel a sweep --------
    Mutation(
        id="any-unproven-spends-the-publication",
        what="a plain failed PAUSE lands in repauseFailed, so a publication the gate must keep sweeping is suppressed for the rest of the drive",
        file=GATE,
        # Retargeted 2026-09-09 (wave 1): the filter grew the `issued` and
        # `unreadable` conjuncts, and `repauseFailed` now feeds the
        # DRIVE-scoped `repausePending` rather than the permanent spend. The
        # permanent spend moved to `repauseThrew`, which is the entry below.
        search="""    repauseFailed: settled
      .filter(
        (r) =>
          r?.kind === "unproven" &&
          r.op === "repause" &&
          r.issued === true &&
          r.unreadable !== true,
      )
      .map((r) => r!.name),""",
        replace="""    repauseFailed: named("unproven"),""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="any-unproven-threw-spends-the-publication",
        what="a plain failed PAUSE marks the publication SPENT — a permanent per-episode disarm — so the gate never touches it again this episode: the 2026-09-08 defect re-armed at its new site",
        file=GATE,
        # New 2026-09-09 (wave 1). `repauseThrew` is the sole input to the
        # PERMANENT spend, so this — not `repauseFailed` above — is where the
        # 2026-09-08 fail-open now lives. Loosening the filter to "any
        # unproven" is exactly the "any op that threw" loosening the module
        # comment names as the invariant that must not be relaxed.
        search="""    repauseThrew: settled
      .filter(
        (r) =>
          r?.kind === "unproven" &&
          r.op === "repause" &&
          r.issued === true &&
          r.threw === true,
      )
      .map((r) => r!.name),""",
        replace="""    repauseThrew: named("unproven"),""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="held-gate-proves-nothing",
        what="a held-gate sweep stops reporting what it observed quiet, so a spent publication can never be un-spent",
        file=GATE,
        search="""    if (publication.upstream() !== "live") {
      return { kind: "proven", name: publication.name, op };
    }""",
        replace="""    if (publication.upstream() !== "live") return null;""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="pre-read-outside-the-try",
        what="the publication's state is read before runOne's try, so one torn-down track rejects the whole sweep and every other publication goes unswept",
        file=GATE,
        search="""  let op: PublishGateOp = "none";
  try {
    op = publishGateOp({
      gateHeld: held,
      upstreamPaused: publication.upstreamPaused,
      upstream: publication.upstream(),
    });""",
        replace="""  const op: PublishGateOp = publishGateOp({
    gateHeld: held,
    upstreamPaused: publication.upstreamPaused,
    upstream: publication.upstream(),
  });
  try {""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="drive-start-outside-the-try",
        what="`onDriveStart` runs before the drive's try, so a hook that throws leaves `active` set forever and every later sweep returns a promise that never settles — the gate stops sweeping and nothing says so",
        file=GATE,
        # New 2026-09-09 (wave 1). Recorded as a KNOWN GAP by the wave-0 audit
        # (this mutation was green then); `publishGateEpisode.test.ts`'s
        # extraction gave `beginDrive` a real caller and wave 1 specs the wedge,
        # so it is a measurement now rather than an admission.
        search="""  const drive = async (): Promise<void> => {
    try {
      onDriveStart();""",
        replace="""  const drive = async (): Promise<void> => {
    onDriveStart();
    try {""",
        # EPISODE_SPEC and not GATE_SPEC: measured 2026-09-09, the gate spec
        # stays 50/50 green under this mutation and only the episode spec's
        # "a throwing onDriveStart does not strand `active`" catches it. Naming
        # a spec that cannot reach a mutation is how an entry reports a vacuous
        # green, so the list says where the evidence actually is.
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="dropped-pass-is-silent",
        what="the cap discards a pending sweep without telling anyone, so the awaiting caller is told the work completed",
        file=GATE,
        search="""      if (pending) onDropped();""",
        replace="""""",
        specs=[GATE_SPEC],
    ),
    # ---- the consent hold (banner-honesty wave 4) ---------------------------
    #
    # The screen-share consent pause is the ONLY non-gate pause on a
    # publication the gate also pauses, and a 1→0 sweep's `resume` arm cannot
    # tell it from the gate's own. `GatedPublication.consentHeld` is how the
    # adapter says "not yours to lift"; `runOne`'s `resume` arm returns `null`
    # (the existing "not this sweep's promise" verdict) over it, ABOVE
    # `issued = true`, and the held-gate arms never consult it. Two walls,
    # one entry each; the `state.tsx` side that SETS the flag is header
    # admission (xii)–(xiv).
    Mutation(
        id="gate-resume-ignores-consent-hold",
        what="the `resume` arm drops its `consentHeld` check, so a 1→0 sweep resumes a screen share whose viewer-consent modal is still open — the share streams before the user answered",
        file=GATE,
        # The whole line INCLUDING its newline, so the replacement is empty and
        # `issued = true;` follows the comment block directly — a mutant that
        # still type-checks and still reads as the pre-wave-4 arm.
        search="""        if (publication.consentHeld === true) return null;
""",
        replace="""""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="gate-consent-hold-blocks-pause",
        what="the `consentHeld` check is HOISTED above the held-gate arms, so a consent-held share is never paused or repaused under a HELD gate — the hold, meant only to stop a resume, now stops the gate's own pause",
        file=GATE,
        # `switch (op) {` opens `runOne`'s arm dispatch and occurs ONCE in the
        # file, so it anchors alone; the early return is inserted at the
        # switch's own indentation. The `resume` arm's check stays (redundant
        # under the hoist) — the defect is the return BEFORE `pause`/`repause`.
        search="""    switch (op) {
""",
        replace="""    if (publication.consentHeld === true) return null;
    switch (op) {
""",
        specs=[GATE_SPEC],
    ),
    # ---- the session-level invariant ---------------------------------------
    Mutation(
        id="latch-skips-the-negotiating-fold",
        what="a loud verdict after the mode reached e2ee never folds back to negotiating, so the banner promises a pause over an empty gate",
        file=SESSION,
        search="""    const fallback = loudModeFallback(this.#callMode);
    if (fallback) this.#setModeChained(fallback);""",
        replace="""    const fallback = loudModeFallback(this.#callMode);
    if (false && fallback) this.#setModeChained(fallback!);""",
        specs=[FALSERED_SPEC],
    ),
    Mutation(
        id="setmode-lockstep-drops-the-pause",
        what="#setMode stops re-asserting the negotiating gate when the mode drops back",
        file=SESSION,
        search="""    if (mode.kind === "negotiating" && !wasNegotiating) {
      void this.#media?.pausePublishing?.("negotiating");""",
        replace="""    if (false && mode.kind === "negotiating" && !wasNegotiating) {
      void this.#media?.pausePublishing?.("negotiating");""",
        specs=[FALSERED_SPEC],
    ),
    Mutation(
        id="fold-lands-after-the-mixed-release",
        what="the T2 warm resume releases `mixed` before the fold asserts `negotiating`, emptying the gate for a microtask",
        file=SESSION,
        search="""    if (next.kind === "negotiating" && this.#callMode.kind !== "negotiating") {
      this.#setMode(next);
    }""",
        replace="""    if (false && next.kind === "negotiating") {
      this.#setMode(next);
    }""",
        specs=[FALSERED_SPEC],
    ),
    Mutation(
        id="harness-gate-unseeded",
        what="the harness starts with an EMPTY gate, so every pre-verdict pause assertion is vacuous",
        file=HARNESS,
        search="""  gate = new Set<PublishGateReason>(["negotiating"]);""",
        replace="""  gate = new Set<PublishGateReason>();""",
        specs=[FALSERED_SPEC],
    ),
    # ---- the residual, no longer a residual --------------------------------
    #
    # This entry was carried `expect="green"` with a `why_green` that was an
    # admission rather than a reason: the `GatedPublication` adapter lived
    # inline in `state.tsx`, which `node --test` cannot import (Solid, livekit,
    # `@revolt/client`), so no mutation could reach it — and TWO fifth-review
    # findings lived in exactly that region. Wave 1 extracted the adapter and
    # the whole episode state into `publishGateEpisode.ts`, which loads under
    # `node --test`. The flip to `expect="red"` below IS the measurement that
    # the blind spot closed; the admission is deleted rather than reworded.
    Mutation(
        id="wiring-upstream-always-quiet",
        what="the GatedPublication adapter reports every sender detached, which re-creates the 2026-09-08 defect AND disables the fail-closed report entirely (`upstream() === 'live'` becomes universally false, so the post-condition can never fire)",
        file=EPISODE,
        # Retargeted 2026-09-14 (born-paused wave 1): the three-valued read
        # moved out of the adapter body into the exported `upstreamOf`, which
        # BOTH adapters now call through one shared builder, so the old
        # 8-space window matches nothing. Same defect, same two lines, at
        # 2-space indent — and it now reaches the born-paused adapter as well,
        # because there is exactly one body to reach.
        search="""  if (!sender) return "unpublished";
  if (!sender.track) return "quiet";""",
        replace="""  if (!sender) return "unpublished";
  return "quiet";""",
        specs=[EPISODE_SPEC],
    ),
]

# --- The extracted episode (banner-honesty wave 1) ---------------------------
#
# `publishGateEpisode.ts` + `publishGateEpisode.test.ts`. Everything here was
# unreachable by any mutation until wave 1 moved it out of `state.tsx`: the
# livekit adapter, the confirm-then-report re-sweep, the four episode flags,
# the rule that populates the spend set, `callPauseDisproved`'s lifecycle, and
# the four scopes (drive / episode-start / episode-end / call) whose collapse
# has already shipped once in each direction.

MUTATIONS += [
    # ---- the four scopes ----------------------------------------------------
    Mutation(
        id="episode-pending-is-episode-scoped",
        what="`repausePending` is cleared at beginEpisode instead of beginDrive — the REJECTED design: mechanically a permanent per-name disarm, measured to leave the mic live and the name latched through the mirror window for the rest of the call",
        file=EPISODE,
        search="""  beginDrive(): void {
    this.#pending.clear();
  }""",
        replace="""  beginDrive(): void {
    // (cleared at beginEpisode instead)
  }""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-endepisode-forgets-a-dropped-pass",
        what="endEpisode also clears `sweepDropped`, so the next episode's first sweep reports a clean bill over a pass that never ran",
        file=EPISODE,
        search="""  endEpisode(): void {
    this.#spent.clear();
    this.#pending.clear();
    this.#cancelConfirm();""",
        replace="""  endEpisode(): void {
    this.#spent.clear();
    this.#pending.clear();
    this.#sweepDropped = false;
    this.#cancelConfirm();""",
        specs=[EPISODE_SPEC],
    ),
    # ---- what may be spent, and for how long -------------------------------
    Mutation(
        id="episode-spends-from-repause-failed",
        what="the PERMANENT per-episode spend is fed from `repauseFailed` instead of `repauseThrew`, disarming the gate over a failure a retry could have fixed — `state.tsx:3415`, the fifth-review finding this module exists to make unwritable",
        file=EPISODE,
        search="""    for (const name of result.repauseThrew) {
      this.#spent.add(name);""",
        replace="""    for (const name of result.repauseFailed) {
      this.#spent.add(name);""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-never-unspends",
        what="the `proven` un-spend is dropped, so one failed repause disarms the publication for the rest of the episode even after the wire settles quiet on its own",
        file=EPISODE,
        search="""    for (const name of result.proven) {
      this.#spent.delete(name);
      this.#pending.delete(name);
    }""",
        replace="""    void result.proven;""",
        specs=[EPISODE_SPEC],
    ),
    # ---- confirm before verdict --------------------------------------------
    Mutation(
        id="episode-reports-without-confirming",
        what="the FIRST unproven sweep withdraws the banner's pause claim and spends, with no confirming re-sweep — a verdict off a single observation taken microtasks after the op, i.e. the 2026-09-08 false red",
        file=EPISODE,
        search="""    if (!confirming && this.#requestConfirm()) return;""",
        replace="""    if (false && this.#requestConfirm()) return;""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-dropped-pass-clears",
        what="a quiet sweep that ran over a DROPPED pass is treated as a clean bill — it restores the pause claim instead of re-scheduling, reporting on work that never ran",
        file=EPISODE,
        search="""      if (dropped) {
        // This sweep did not see everything, so it is not a clean bill.
        if (!this.#requestConfirm())
          this.#deps.report("unproven", {
            publications: [],
            droppedPass: true,
            confirmBudgetExhausted: true,
          });
        return;
      }
""",
        replace="""""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-confirm-budget-never-restored",
        what="a sweep that proves quiet does not restore the consecutive-confirm budget, so a long healthy episode exhausts it and the next transient window is reported as a verdict off ONE unconfirmed observation",
        file=EPISODE,
        search="""      // Everything this pass saw is quiet, so the confirm chain has served its
      // purpose and the budget is whole again.
      this.#confirmRounds = 0;""",
        replace="""      // (budget not restored)""",
        specs=[EPISODE_SPEC],
    ),
    # ---- the stale-room guard ----------------------------------------------
    Mutation(
        id="episode-ignores-stillcurrent",
        what="`consume` acts on a sweep belonging to a DISPOSED call: it mutates the live episode's disarm sets and reports into the live UI",
        file=EPISODE,
        search="""    if (!this.#deps.stillCurrent()) return;
""",
        replace="""""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-unspends-before-the-room-check",
        what="the room check sits BELOW the `proven` un-spend, so an in-flight sweep for a disposed call un-spends in the live episode — `state.tsx:3380` exactly",
        file=EPISODE,
        search="""    if (!this.#deps.stillCurrent()) return;

    const confirming = this.#confirming;""",
        replace="""    for (const name of result.proven) {
      this.#spent.delete(name);
      this.#pending.delete(name);
    }
    if (!this.#deps.stillCurrent()) return;

    const confirming = this.#confirming;""",
        specs=[EPISODE_SPEC],
    ),
    # ---- the deferred confirm across a lifecycle boundary (wave-1 FIX A) ----
    #
    # `#requestConfirm`'s deferred closure justifies its first guard with "a
    # lifecycle boundary cleared the request while it was deferred". Only
    # `resetForCall` honoured that until the fix round: a confirm deferred in
    # episode 1 survived a 1→0 and a 0→1, passed both of the closure's landing
    # guards (the gate is held again, the call is unchanged) and armed the NEXT
    # episode's FIRST pass as confirming — which skips the confirm arm in
    # `consume` entirely. The measured consequence is a verdict AND a permanent
    # per-episode spend off ONE unconfirmed observation, which is the 2026-09-08
    # false red re-armed at the episode boundary. One entry per boundary,
    # because each boundary is a separate call site that can be dropped alone.
    #
    # 🔴 The third entry below is the IN-FLIGHT sibling, and it deliberately
    # shares its `search` window with the first: `beginEpisode` closes the
    # deferred path (`#cancelConfirm`) and the sweep path (`#confirming =
    # false`) with two adjacent statements, and each has to be droppable on its
    # own for the pair to be measured. Same window, different `replace`; both
    # still match exactly once, which `apply()` enforces. The window is the
    # three contiguous statements rather than the whole method body because
    # `this.#cancelConfirm();` alone occurs at all THREE lifecycle boundaries —
    # the ambiguity that would make this a hard error instead of a mutation.
    Mutation(
        id="episode-beginepisode-keeps-a-deferred-confirm",
        what="beginEpisode stops taking back an outstanding confirm, so a confirm deferred in the LAST episode arms this one's first pass as confirming — verdict and permanent spend off one unconfirmed observation",
        file=EPISODE,
        search="""    this.#cancelConfirm();
    this.#confirming = false;
    this.#confirmRounds = 0;""",
        replace="""    this.#confirming = false;
    this.#confirmRounds = 0;""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-endepisode-keeps-a-deferred-confirm",
        what="endEpisode stops taking back an outstanding confirm, so a request made under the gate that just drained stays outstanding — and blocks every later confirm in the call, since `#confirmScheduled` is the one-outstanding dedupe",
        file=EPISODE,
        # Retargeted 2026-09-10 (wave 2): `setPauseDisproved` grew a second
        # argument, which broke this anchor's last line. Re-anchored on the
        # METHOD SIGNATURE instead, which is both comment-free and free of any
        # call this module makes — the two things that have broken it so far.
        # `this.#cancelConfirm();` alone matches all THREE lifecycle
        # boundaries, so the signature is what disambiguates.
        search="""  endEpisode(): void {
    this.#spent.clear();
    this.#pending.clear();
    this.#cancelConfirm();""",
        replace="""  endEpisode(): void {
    this.#spent.clear();
    this.#pending.clear();""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-beginepisode-keeps-the-inflight-confirming-pass",
        what="beginEpisode stops DEMOTING the sweep already in flight, so a pass that armed `#confirming` in the LAST episode skips the confirm arm and verdicts in THIS one — the deferred-confirm defect's in-flight sibling, which `#cancelConfirm` alone does not close",
        file=EPISODE,
        search="""    this.#cancelConfirm();
    this.#confirming = false;
    this.#confirmRounds = 0;""",
        replace="""    this.#cancelConfirm();
    this.#confirmRounds = 0;""",
        specs=[EPISODE_SPEC],
    ),
    # ---- what restores the confirm budget (wave-1 FIX B) --------------------
    #
    # TWO entries, in opposite directions, because this line has exactly two
    # ways to be wrong and the specs must hold both walls:
    #
    #   too narrow — `result.unproven.length === 0`, the pre-fix condition. A
    #     spent publication is issued nothing, reads `live` at its
    #     post-condition and lands in `unproven` on every later pass, so the
    #     moment anything is spent that reset is UNREACHABLE: four rounds burn
    #     and a brand-new transient window on a DIFFERENT publication is
    #     verdicted off a single observation.
    #
    #   too wide — also excluding `#pending`. That set is DRIVE-scoped, so a
    #     trailing pass inside the very drive a live-lock is feeding would
    #     restore the bound that drive is burning: the unbounded confirm chain,
    #     verbatim. This one is the REJECTED alternative, and pinning a
    #     rejected design is worth more than pinning the accepted one — nothing
    #     else in the tree stops the next reader "simplifying" the asymmetry.
    Mutation(
        id="episode-budget-reset-ignores-a-spend",
        what="the consecutive-confirm budget resets on `unproven.length === 0` again instead of on ACTIONABLE unproven, which a single spend makes permanently unreachable",
        file=EPISODE,
        search="""    if (actionable.length === 0 && !dropped) this.#confirmRounds = 0;""",
        replace="""    if (result.unproven.length === 0 && !dropped) this.#confirmRounds = 0;""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-budget-reset-excludes-the-drive-set",
        what="the REJECTED widening: `#pending` is excluded from `actionable` too, so a trailing pass inside a live-locked drive restores the bound that drive is burning — the unbounded confirm chain back",
        file=EPISODE,
        search="""    const actionable = result.unproven.filter((n) => !this.#spent.has(n));""",
        replace="""    const actionable = result.unproven.filter(
      (n) => !this.#spent.has(n) && !this.#pending.has(n),
    );""",
        specs=[EPISODE_SPEC],
    ),
    # ---- the verdict's precondition (wave-1 FIX C) --------------------------
    Mutation(
        id="episode-verdict-fires-under-an-empty-gate",
        what="the `gateHeld()` guard before the verdict is bypassed, so a confirm deferred under a held gate that lands after the gate DRAINED writes `callPauseDisproved` true — where it latches, because every path back to false is itself gate- or boundary-conditioned",
        file=EPISODE,
        search="""    if (!this.#deps.gateHeld()) {""",
        replace="""    if (false) {""",
        specs=[EPISODE_SPEC],
    ),
    # ---- the budget at the episode boundary (wave-1 FIX D) ------------------
    Mutation(
        id="episode-endepisode-keeps-a-spent-budget",
        what="endEpisode leaves `#confirmRounds` where the last episode left it, so the resume sweep this very boundary drives runs on the PREVIOUS episode's exhausted counter and takes its first observation as a verdict",
        file=EPISODE,
        # Retargeted 2026-09-10 (wave 2), same cause as the sibling above.
        # 🔴 NO comment-free anchor exists here and the window was shrunk
        # instead. `this.#confirmRounds = 0;` followed by the withdrawal write
        # and a closing brace was BYTE-FOR-BYTE identical in `endEpisode` and
        # in `resetForCall` when this entry was written. It no longer is: wave
        # 2 inserted a two-line `// Per-episode, exactly like #confirmRounds…`
        # comment between them in `endEpisode`, and both sites gained
        # `#episodeConfirmRounds` and `#unprovenReports` clears. The shrink is
        # kept anyway — the shorter three-line window IS still identical at the
        # two sites (verified: 2 matches), so the comment lines remain the only
        # text that tells them apart —
        # dropping them would make this a hard error (2 matches), not a
        # mutation. What the shrink does buy: the window no longer reaches the
        # `setPauseDisproved` call at all, so the next change to that signature
        # cannot break it again.
        search="""    this.#cancelConfirm();
    // Consistent with both siblings: the resume sweep this boundary drives
    // must not run on the previous episode's counter.
    this.#confirmRounds = 0;""",
        replace="""    this.#cancelConfirm();""",
        specs=[EPISODE_SPEC],
    ),
    # ---- the verdict's CONFIDENCE (wave-2 W2-3) -----------------------------
    #
    # `setPauseDisproved` carries a SECOND argument because `true` is reachable
    # two ways that are not the same evidence: after a confirming re-sweep
    # actually ran (two observations a macrotask apart), and because the
    # consecutive-confirm budget was spent (ONE observation, taken microtasks
    # after a livekit op that may simply not have landed). `callPauseDisproved`
    # feeds `callBanner()`'s pause clause ONLY — it is not a `chipState`
    # input and the chip never reads it — so a consumer that cannot tell
    # them apart warns off the guess with the disproof's weight: the
    # 2026-09-08 false red one level up, on the banner's pause line.
    #
    # 🔴 THE FIRST TWO ENTRIES ARE A PAIR, IN OPPOSITE DIRECTIONS, and the
    # second is the reason the pair exists. A suite that only ever asserts
    # "unconfirmed here" is satisfied by hard-coding the flag false; one that
    # only ever asserts "confirmed here" is satisfied by hard-coding it true.
    # Both walls have to be pinned or the flag is decorative.
    Mutation(
        id="episode-budget-exhausted-verdict-claims-confirmed",
        what="the verdict reached because the confirm budget was SPENT claims `confirmed: true`, so a verdict off ONE unconfirmed observation reaches the chip with a confirmed disproof's weight — the 2026-09-08 false red one level up",
        file=EPISODE,
        # Mutates the CALL and not `const confirmed = confirming;`, on purpose:
        # this way `detail.confirmBudgetExhausted` still says "guess" while the
        # signal says "confirmed", which is exactly the drift the two consumers
        # are meant to be unable to have.
        search="""    this.#deps.setPauseDisproved({ value: true, confirmed });""",
        replace="""    this.#deps.setPauseDisproved({ value: true, confirmed: true });""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-confirmed-verdict-claims-unconfirmed",
        what="the POSITIVE counterpart: a verdict reached after a confirming re-sweep RAN claims `confirmed: false`. Without this entry the flag could be hard-coded false and every 'unconfirmed' assertion in the suite would stay green",
        file=EPISODE,
        search="""    this.#deps.setPauseDisproved({ value: true, confirmed });""",
        replace="""    this.#deps.setPauseDisproved({ value: true, confirmed: false });""",
        specs=[EPISODE_SPEC],
    ),
    # A WITHDRAWAL grades nothing — there is no claim to qualify — so FALSE is
    # always written FALSE/FALSE. FALSE/TRUE would read to a consumer as "a
    # CONFIRMED pause", which is the one thing this signal must never say: it
    # is a one-directional alarm, and "no live disproof" is not evidence of a
    # pause. One entry per call site, because each is separately gettable
    # wrong.
    Mutation(
        id="episode-quiet-arm-withdrawal-claims-confirmed",
        what="the quiet arm withdraws the disproof as `confirmed: true`, i.e. a proven-quiet wire is reported as a CONFIRMED pause rather than as the absence of a disproof",
        file=EPISODE,
        search="""      if (this.#deps.gateHeld())
        this.#deps.setPauseDisproved({ value: false, confirmed: false });""",
        replace="""      if (this.#deps.gateHeld())
        this.#deps.setPauseDisproved({ value: false, confirmed: true });""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-resetforcall-withdrawal-claims-confirmed",
        what="the CALL boundary withdraws the disproof as `confirmed: true`, so a brand-new call starts out asserting a confirmed pause nothing has observed",
        file=EPISODE,
        search="""    this.#sweepDropped = false;
    this.#confirmRounds = 0;
    this.#episodeConfirmRounds = 0;
    this.#unprovenReports = 0;
    this.#deps.setPauseDisproved({ value: false, confirmed: false });""",
        replace="""    this.#sweepDropped = false;
    this.#confirmRounds = 0;
    this.#episodeConfirmRounds = 0;
    this.#unprovenReports = 0;
    this.#deps.setPauseDisproved({ value: false, confirmed: true });""",
        specs=[EPISODE_SPEC],
    ),
    # 🔴 The two F3 bounds. Wave 0 shipped `CONFIRM_BUDGET` as "the" bound on
    # the self-driven confirm chain, and it bounds NOTHING once every unproven
    # name is spent: `actionable` filters out `#spent`, so `actionable.length
    # === 0` resets `#confirmRounds` on every pass BEFORE `#requestConfirm()`
    # is reached. Measured at 7d80b2d9: 201 confirming rounds with
    # CONFIRM_BUDGET = 4 in force, stopped only by the driver's own cap.
    # These two entries exist so a future edit cannot quietly restore that.
    Mutation(
        id="episode-confirm-ceiling-never-fires",
        what="the per-episode confirm ceiling is raised out of reach, restoring the unbounded self-driven confirm chain over a SPENT name that wave 0 shipped — the live-lock `CONFIRM_BUDGET` cannot bound because a spend resets it on every pass",
        file=EPISODE,
        search="""    if (this.#episodeConfirmRounds >= EPISODE_CONFIRM_CEILING) return false;""",
        replace="""    if (this.#episodeConfirmRounds >= Number.MAX_SAFE_INTEGER) return false;""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-unproven-report-budget-never-fires",
        what="the telemetry rate-limit is raised out of reach, so a held gate over a live wire emits one `console.error` per macrotask for the whole call — the half of the live-lock the ceiling does not cover",
        file=EPISODE,
        search="""    if (this.#unprovenReports <= UNPROVEN_REPORT_BUDGET) {""",
        replace="""    if (this.#unprovenReports <= Number.MAX_SAFE_INTEGER) {""",
        specs=[EPISODE_SPEC],
    ),
    # 🔴 NOT MUTATED, and recorded rather than hidden: `endEpisode`'s
    # withdrawal — the THIRD site writing the `{ value: false, confirmed:
    # false }` withdrawal. Its
    # three lines are byte-for-byte identical to `resetForCall`'s, so the only
    # text that could anchor it uniquely is the two-line body comment above it,
    # and this table already depends on that comment once
    # (`episode-endepisode-keeps-a-spent-budget`). The 1->0 site IS asserted by
    # the specs — "a WITHDRAWAL carries no confidence, on every path that
    # writes one" walks all three — so what is missing is a mutation proving
    # that assertion is live, not the assertion. Closing it needs the two sites
    # to stop being textually identical, which is a source change and not this
    # file's to make.

    # ---- the livekit adapter ------------------------------------------------
    Mutation(
        id="episode-adapter-snapshots-the-wire",
        what="`gatedPublicationsFrom` SNAPSHOTS the pause flag instead of exposing a getter, so the sweep's post-condition re-asserts its own pre-condition — deleting the only read in the stack that observes what the op actually did",
        file=EPISODE,
        # Retargeted 2026-09-14 (born-paused wave 1): the getter now exists
        # ONCE, inside the non-exported builder `gatedPublicationOf` that both
        # adapters call, at 4/6/4-space indentation; the old 6/8/6 window
        # matches nothing. Same defect at the same — now single — site.
        search="""    get upstreamPaused() {
      return track.isUpstreamPaused;
    },""",
        replace="""    upstreamPaused: track.isUpstreamPaused,""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-adapter-keeps-a-trackless-publication",
        what="a publication mid-republish (no `track`) is presented to the sweep anyway, so every read in the adapter dereferences undefined and one republish costs the whole sweep",
        file=EPISODE,
        search="""    if (!track) continue;""",
        replace="""    if (!track && false) continue;""",
        specs=[EPISODE_SPEC],
    ),

    # ---- the verdict readers -----------------------------------------------
    # 🔴 This module exists because of a MEASURED defect, not a hypothesis. The
    # remediation completion audit swapped the two derived accessors in
    # `state.tsx` and ran the whole bare gate: tsc, prettier, eslint, all specs
    # and both scripts returned exit 0 with zero failing checks. The swap maps
    # exactly one of the four verdict states -- `{value: true, confirmed:
    # false}`, an UNCONFIRMED disproof off a single budget-exhausted
    # observation -- to `{ false, true }` at every consumer. Under today's
    # only consumer, `callBanner`'s symmetric AND fold, that is invisible:
    # both pairs read `pause: "held"`, and no present false-green is claimed.
    # It IS a false-green for any `disproved`-only reader, which the wave-1
    # banner was; the guarantee these two entries pin is that the readers are
    # discriminated BY NAME. `state.tsx` can carry no spec and no entry;
    # extracting the derivation here is what lets these two exist at all.
    Mutation(
        id="pause-verdict-readers-transposed",
        what="the two verdict readers are swapped — an UNCONFIRMED disproof reaches every consumer as `{ false, true }`; invisible under today's symmetric AND fold, a false-green for any `disproved`-only reader",
        file=VERDICT,
        search="""    disproved: () => verdict().value,
    disproofConfirmed: () => verdict().confirmed,""",
        replace="""    disproved: () => verdict().confirmed,
    disproofConfirmed: () => verdict().value,""",
        specs=[VERDICT_SPEC],
    ),
    Mutation(
        id="pause-verdict-readers-eager",
        what="the readers snapshot the verdict at construction, so `state.tsx`'s memos read once outside any reactive scope and the banner freezes on the initial all-false verdict — a state-only spec would not catch this",
        file=VERDICT,
        search="""  return {
    disproved: () => verdict().value,
    disproofConfirmed: () => verdict().confirmed,
  };""",
        replace="""  const snapshot = verdict();
  return {
    disproved: () => snapshot.value,
    disproofConfirmed: () => snapshot.confirmed,
  };""",
        specs=[VERDICT_SPEC],
    ),
]

# --- The re-securing wedge (fix/mls-resecure-wedge, 2026-09-10) --------------
#
# `mlsCallSession.ts` + `mlsCallSession.resecure.test.ts`: someone leaves and
# rejoins an encrypted call and the chip loops on "Re-securing…" until the
# client is quit. Three groups, mirroring the spec's, then A11:
#
#   P1 — the join ladder recognising its own success. A Welcome adopted while
#     the ladder sits in an await resolves no wait, so without `#ladderJoined`
#     the ladder kept broadcasting intents AS A MEMBER and ended amber with no
#     owner. Each await the ladder can be suspended in has its own check, and
#     each check can be dropped alone, so each has its own entry. The
#     predicate is pinned from the other side as well: forced TRUE, it stops
#     an HONEST ladder, which only the guards can see.
#   P3 — the enrolment alarm re-arms with a re-establish instead of being
#     latch-once for the whole call.
#   the backstop — "re-securing" ends LOUD or with an OWNER, never in a green
#     of its own making. The owner term is wrong in both directions: too
#     strong (always held), the wedge is back (4a); too weak, the backstop
#     cuts a live ladder short (4b) or latches a `start()` still enrolling
#     (4c). The re-arm and the pending-owner term are pinned by 6a and 6e.
#   A11 — `#submitSuperseded`: a submit continuation whose group a
#     re-establish replaced acts on nothing. `#stageAndSubmit` checks it at
#     three sites: the submit's inner catch (a timeout or a reject, pinned by
#     6b and 6c), the post-classify check (every DS answer
#     `classifyArbitration` can read, pinned by 6d, 6f and 6g, its Won arm by
#     6d alone), and the post-submit outer catch (a throw after the submit
#     resolved, pinned by 6h).
#
# The last two entries mutate EXISTING code that wave 1 did not edit — the
# Welcome-adopt block in `#onEpochAdvanced` — because the fix sits beside it
# and its failure is the wedge's mirror image: a red that a late or foreign
# Welcome turns back into a green.
#
# The spec's guards (4b, 4c, 5, 5b, 5c, 6e) are green at the base commit by
# construction, so the entries in this block are their only evidence of being
# live: 4b and 4c through the owner-term pair, 5 through the forced-true
# predicate, 5b and 5c through the adopt-block pair, and 6e through
# `backstop-groupaction-owner-dropped`.

MUTATIONS += [
    # ---- P1: one entry per await the ladder can be suspended in ------------
    Mutation(
        id="p1-loop-head-check-removed",
        what="the ladder's loop-head check is dropped, so a Welcome adopted during the pre-join roster pin still has a MEMBER sign a join intent — the \"intent signed\" check still stops the broadcast, but only after the native signing call",
        file=SESSION,
        search="""      if (this.#ladderJoined(generation, "loop head")) return;
""",
        replace="""""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="p1-catch-check-removed",
        what="a MEMBER's failed intent signing reaches `#onLoud` again: a Welcome adopted while `callJoinIntent` was in flight, then a throw from it, is a false red on an encrypted call",
        file=SESSION,
        search="""        if (this.#ladderJoined(generation, "intent signing threw")) return;
""",
        replace="""""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="p1-signed-check-removed",
        what="a Welcome adopted during the signing call no longer stops the broadcast, so a MEMBER broadcasts the intent it signed before it joined",
        file=SESSION,
        search="""      if (this.#ladderJoined(generation, "intent signed")) return;
""",
        replace="""""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="p1-post-intent-check-removed",
        what="the DS's answer to an intent broadcast before the Welcome was adopted is acted on for a MEMBER: `not_found` tears down the group just joined, `feature_disabled` drops an encrypted call to plaintext, `call_full` refuses and auto-leaves a member",
        file=SESSION,
        search="""      if (this.#ladderJoined(generation, "intent answered")) return;
""",
        replace="""""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="p1-predicate-forced-true",
        what="`#joinedIn` answers true for every generation, so an UN-ADMITTED joiner's ladder stops at its loop head before its first intent: no admitter is ever asked, and the ladder's own red never comes",
        file=SESSION,
        search="""  #joinedIn(generation: number): boolean {
    return this.#joinedGeneration === generation;
  }""",
        replace="""  #joinedIn(generation: number): boolean {
    return true || this.#joinedGeneration === generation;
  }""",
        specs=[RESECURE_SPEC],
    ),
    # ---- P3: the alarm re-arms with the group ------------------------------
    Mutation(
        id="p3-reset-removed",
        what="`#resetGroupBuffers` stops resetting the enrolment alarm's latch-once flag, so a SECOND exhausted ladder after a re-establish is not latched by the alarm — the first red was cleared with the old group, and the second is silent amber until something else ends it",
        file=SESSION,
        # The one line on its own, and deliberately not the three-line window
        # around it: it occurs once in the file, and a window that included
        # `#armEnrolmentAssertion()` would hard-error on the benign reorder
        # recorded as known non-entry (b) below, instead of going on
        # measuring this defect.
        search="""    this.#enrolmentAlarmed = false;
""",
        replace="""""",
        specs=[RESECURE_SPEC],
    ),
    # ---- the backstop: armed, and never green ------------------------------
    Mutation(
        id="backstop-not-armed",
        what="`#toResecuring` no longer arms the backstop, so a re-securing nothing is left to end (removed while no longer in the SFU) stays amber until the 240 s enrolment deadline — the wedge",
        file=SESSION,
        search="""    this.#setState("resecuring");
    this.#armResecuringDeadline(reason);""",
        replace="""    this.#setState("resecuring");""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="backstop-promotes-to-active",
        what="the backstop resolves an ownerless re-securing to GREEN instead of latching loud — a timer-driven green is the \"green by default\" root cause, and `enrolmentVerdict` answers enrolled whenever the session is terminal",
        file=SESSION,
        search="""    console.error("[mls] re-securing backstop fired", error);
    this.#latchLoud(error, "control");""",
        replace="""    console.error("[mls] re-securing backstop fired", error);
    this.#toActive();""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="backstop-rearm-dropped",
        what="the backstop's owner arm returns WITHOUT re-arming, so a re-securing whose owner outlives the first bound is never looked at again — when that owner lets go without ending it, nothing latches it and the chip sits amber: the wedge, one bound later",
        file=SESSION,
        # The whole line, trailing comment included, so the deletion leaves no
        # orphaned comment. `#armResecuringDeadline` makes the same call at
        # four spaces, which this six-space window cannot match.
        search="""      this.#scheduleResecuringDeadline(); // same bound, same reason
""",
        replace="""""",
        specs=[RESECURE_SPEC],
    ),
    # ---- the backstop: the owner term, in both directions ------------------
    Mutation(
        id="backstop-owner-always-held",
        what="the backstop treats every re-securing as owned and re-arms forever, so a re-securing nothing is left to end never goes loud — the wedge, behind a timer that looks armed",
        file=SESSION,
        search="""    return (
      this.#establishInFlight ||
      this.#groupActionPending ||
""",
        replace="""    return (
      true ||
      this.#establishInFlight ||
      this.#groupActionPending ||
""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="backstop-ignores-live-owner",
        what="the backstop latches even while an owner holds the state, so a live re-establish ladder is cut short to a red at the first bound — 10 s into a ladder that runs 40",
        file=SESSION,
        search="""    if (this.#resecuringHasOwner()) {""",
        replace="""    if (false && this.#resecuringHasOwner()) {""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="backstop-gen0-owner-dropped",
        what="`start()`'s KeyPackage enrolment is no longer an owner, so a slow enrolment (a 429 wait) that the negotiating fail-safe shows amber latches loud before the first establish — a red that outlives the create that follows",
        file=SESSION,
        search="""      this.#groupActionPending ||
      this.#establishGeneration === 0
""",
        replace="""      this.#groupActionPending
""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="backstop-groupaction-owner-dropped",
        what="a scheduled or running group action is no longer an owner, so the backstop latches loud under a re-establish still suspended in its leave-clean, before its establish — `#establishInFlight` is still false there, so this is the one term that covers it",
        file=SESSION,
        # Three lines, starting one line ABOVE the term, so the window differs
        # from both neighbours: `backstop-owner-always-held` starts at
        # `return (` and `backstop-gen0-owner-dropped` at this very term.
        search="""      this.#establishInFlight ||
      this.#groupActionPending ||
      this.#establishGeneration === 0
""",
        replace="""      this.#establishInFlight ||
      this.#establishGeneration === 0
""",
        specs=[RESECURE_SPEC],
    ),
    # ---- A11: a superseded submit acts on nothing --------------------------
    #
    # `#submitSuperseded` guards `#stageAndSubmit` at three sites: a
    # re-establish can replace `#groupId` while the submit is on the wire, and
    # a continuation that re-secures, re-establishes, rebases or merges from
    # there hits the LIVE group.
    #
    #   inner catch — the submit timed out or was rejected. Pinned by 6b and
    #     6c through `a11-inner-guard-removed`.
    #   post-classify — the DS answered, and every arm of the switch after it
    #     acts on the live session. Pinned by 6d, 6f and 6g through
    #     `a11-post-classify-check-removed`, and its Won arm on its own by 6d
    #     through `a11-post-classify-won-exempt`. 6d's merge is there to take
    #     because native refuses the swap's leave-clean and so still holds
    #     GROUP and its staged commit; a stale Won let through would merge it.
    #   outer catch — a throw after the submit resolved: an unreadable body in
    #     `classifyArbitration`, `callCommitWon`, or the rebase. Pinned by 6h
    #     through `a11-outer-guard-removed`. The post-classify check cannot
    #     cover it: a 2xx with no body (`#apiMls` answers a 204
    #     `{kind: "ok", body: undefined}`) makes `classifyArbitration` throw on
    #     `res.body.result` BEFORE that check runs, so this guard is its only
    #     stop.
    #
    # The inner window starts at the `catch` line ABOVE the guard, and the
    # outer window runs on to the comment line BELOW it: the outer site's
    # guard line (six spaces) is a substring of the inner one's (eight), so
    # the six-space line alone matches twice and would hard-error. The
    # post-classify line passes `outcome`, so it matches neither.
    Mutation(
        id="a11-inner-guard-removed",
        what="a submit that timed out or was rejected after its group was replaced runs the timeout arm against the LIVE group: its pending commit is cleared, the session re-secured and a re-establish scheduled, all from a continuation that should act on nothing (6b the timeout, 6c the reject)",
        file=SESSION,
        search="""      } catch {
        if (this.#submitSuperseded(groupId)) return;
""",
        replace="""      } catch {
""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="a11-post-classify-check-removed",
        what="a DS answer for a submit whose group was replaced runs its arm against the LIVE group: a stale Won is merged onto the replaced group a failed leave-clean left in native (6d), a stale Lost clears the live group's pending commit, replays the winning commit and gap-refetches the live group (6f), and a stale `feature_disabled` drops an encrypted call to plaintext (6g)",
        file=SESSION,
        # The guard line alone, leaving the comment block above it in place,
        # so an edit to that comment cannot break this entry.
        search="""      if (this.#submitSuperseded(groupId, outcome.outcome)) return;
""",
        replace="""""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="a11-post-classify-won-exempt",
        what="the post-classify check lets a stale Won through, so a submit whose group was replaced still merges on it: `callCommitWon` runs for the replaced group, and when native still holds that group (a failed leave-clean is swallowed) `#lastOwnWon` is written onto the live session, where it outranks the inbound memo in `classifyLocalKeyInstall` (6d; the Lost and `feature_disabled` arms stay guarded)",
        file=SESSION,
        # Same window as `a11-post-classify-check-removed`, and a different
        # defect: one exempts a single arm instead of dropping the check. The
        # replacement is wrapped the way prettier would wrap it.
        search="""      if (this.#submitSuperseded(groupId, outcome.outcome)) return;
""",
        replace="""      if (
        outcome.outcome !== "won" &&
        this.#submitSuperseded(groupId, outcome.outcome)
      )
        return;
""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="a11-outer-guard-removed",
        what="a post-submit throw for a submit whose group was replaced runs the staging-failure arm against the LIVE group: pending commit cleared, re-secured, re-establish scheduled. A 2xx with no body makes `classifyArbitration` throw BEFORE the post-classify check, so this guard is its only stop (6h)",
        file=SESSION,
        # Unlike the post-classify entries, this window takes in the comment
        # line below the guard (see the block note above), so rewording that
        # comment hard-errors this entry. It fails loud, never silently.
        search="""      if (this.#submitSuperseded(groupId)) return;
      // Everything past the build""",
        replace="""      // Everything past the build""",
        specs=[RESECURE_SPEC],
    ),
    # ---- the Welcome-adopt block: a red stays red --------------------------
    Mutation(
        id="late-welcome-resets-latch",
        what="adopting a Welcome resets the rotation state, which clears the loud latch — so a Welcome arriving after the ladder already went red turns that red green",
        file=SESSION,
        # Placed in the adopt block rather than in `#toActive`. Both are a
        # one-line insertion; this one re-introduces the defect exactly where
        # a late Welcome enters, while one in `#toActive` would also run on the
        # creator path and on every honest join, and so redden the suite for
        # reasons that have nothing to do with a late Welcome.
        #
        # Re-anchored 2026-09-26 (late-drain guard, W2-M2). The adopt block
        # no longer calls `#toActive()`: it records a pending Welcome currency
        # check instead, and `#confirmWelcomeCurrency` goes active only on the
        # DS's answer. So the old two-line window matches nothing. The
        # insertion stays in the ADOPT block, right after the
        # `#joinedGeneration` write (a line that occurs once in the file), for
        # the reason above: it is where a late Welcome enters, while the
        # `#toActive()` that now follows the currency check runs on every
        # honest Welcome join as well. Same defect, same one-line insertion.
        # Measured after the re-anchor: resecure 5b and 3 go red (2 of 23).
        # Checked at the merge wave (2026-09-27): NOT moved. The merge took
        # the re-anchor above; the line still occurs once, in the adopt
        # block, and MS2's `#resumeAdopting` guard (below the currency
        # record) does not reach it. Re-measured: resecure 3 and 5b (2 of 23).
        # Re-anchored at the merge fix pass (2026-09-27, MFG). MWA-m1 moved
        # the `#joinedGeneration` write inside `if (this.#resumeAdopting !==
        # outcome.group_id)`, so the line is 8-space indented and the old
        # 6-space search still matched once, but as a SUBSTRING of it, and
        # inserted a mis-indented line. The insertion stays right after the
        # write, now inside the guard: that is where an ordinary Welcome,
        # the late one included, is adopted as a join, while a Welcome in a
        # resume's adopt window joins nothing and is the resume's to judge.
        # The stamp line above the write is taken too, so the search starts
        # at a line start and occurs once. Re-measured: resecure 3 and 5b (2
        # of 23), the same as the 6-space substring and as an unconditional
        # insertion after the `#groupId` write, so the guard does not change
        # what this entry measures.
        search="""        this.#joinTimeline?.stamp("welcomeAdopted");
        this.#joinedGeneration = this.#establishGeneration;
""",
        replace="""        this.#joinTimeline?.stamp("welcomeAdopted");
        this.#joinedGeneration = this.#establishGeneration;
        this.#resetRotationState();
""",
        specs=[RESECURE_SPEC],
    ),
    Mutation(
        id="foreign-welcome-adopted",
        what="`#onEpochAdvanced` adopts a Welcome `welcomeVerdict` refused — another group's, or a superseded generation's — so a foreign Welcome during a held intent stops a live ladder and reads as joined",
        file=SESSION,
        search="""      if (!verdict.adopt) {""",
        replace="""      if (false && !verdict.adopt) {""",
        specs=[RESECURE_SPEC],
    ),
    # 🔴 KNOWN NON-ENTRIES, recorded rather than silently absent. Each was
    # ruled out by the wave-1, wave-2 or wave-3 audit, and each would be wrong
    # to add. Entries for the backstop re-arm, its pending-owner term and the
    # A11 guards now exist: the wave-2 audit's findings 1 and 2, plus wave 3's
    # post-classify pair and outer-catch guard, covered by specs 6a–6h. Open
    # submit-race edges are recorded as follow-ups in the plan's F6, not here.
    #
    #   (a) `p1-exhaustion-check-removed` — the `"retries spent"` check after
    #       the loop. It is unreachable defensive code, kept deliberately: no
    #       schedule reaches it with the join complete. An entry deleting it
    #       could only ever go green, and "fixing" that by widening it until it
    #       reddens would measure some other check under this one's name.
    #
    #   (b) `p3-reset-after-arm` — moving `this.#enrolmentAlarmed = false;`
    #       below `#armEnrolmentAssertion()` in `#resetGroupBuffers`. The
    #       move only delays the periodic tick until the next direct
    #       `#assertSelfEnrolled` call, and every path after the reset either
    #       makes one (`#toActive`, the ladder's exhaustion), ends in `#onLoud`,
    #       or is ended by the re-securing backstop. Measured: no spec in the bare
    #       gate reddens, and the chip, the banner and the loud/clear stream are
    #       identical. The one difference is `state()` of a session already
    #       `failed`, which the committed order flips back to `resecuring` at the
    #       240 s deadline — pinning that would pin an accident, not a posture.
    #
    #   (c) redundant or log-only lines, each surviving on its own by design:
    #       `#setState`'s deadline cancel and the backstop's own "left
    #       resecuring" guard are a redundant pair; the `#establishInFlight`
    #       owner term is redundant because every `#establish` runs inside a
    #       group action; `#armResecuringDeadline`'s no-walk-forward guard has
    #       no caller that re-enters faster than the bound without an owner; and
    #       the drop / `welcome adopted` / `join ladder: joined` logs are log-only
    #       — the live leg's expected console lines are their check.
]

# --- Born paused (plan D0, wave 1, 2026-09-14) -------------------------------
#
# `publishGateEpisode.ts`'s second adapter (`gatedPublicationFromSender`, over
# the shared builder `gatedPublicationOf`) plus `pauseAtBirth`, the hook's only
# entry into the gate. Run 3 of the rejoin-leak legs measured why they exist:
# livekit creates the sender ALREADY carrying the live track and emits
# `LocalSenderCreated` one statement later, so the earliest pause the ordinary
# sweep could issue — at `LocalTrackPublished` — let the seat's first 1–4 RTP
# packets leave as plaintext on every publish under a held gate, and a
# republish inside the gate reopened the window for seconds.
#
# The specs are split across BOTH spec files: `publishGate.test.ts` drives the
# hook through `FakeLocalTrack.republish(hook)`, which models livekit assigning
# `track.sender` and emitting one statement later, on both wire models;
# `publishGateEpisode.test.ts` pins the adapter's name rule, the lazy sender
# read and the senderless input. Each entry lists the file(s) MEASURED to go
# red under it and no other — a spec that cannot reach a mutation is how an
# entry reports a vacuous green.
#
# Every entry targets `EPISODE`. The `state.tsx` half of D0 — the
# `LocalSenderCreated` registration, the publish-time kick (scoped by wave 4;
# its decision has its own section below) and the `UpstreamPaused` re-emit —
# is wiring no runner can load, and is recorded in the header admission above
# rather than as an entry.
#
# Where an entry lists BOTH files, both were measured red under it on
# 2026-09-14 with every test executing; `judge()` walks them in order and the
# first red decides, so the gate spec is the one that usually pays.

MUTATIONS += [
    Mutation(
        id="born-paused-adapter-reports-unpublished",
        what="the shared builder's `upstream` thunk reports every sender `unpublished`, so `publishGateOp` decides `none` for the born publication and nothing is issued at birth — the hook wired, silent, and the plaintext window back exactly as measured",
        file=EPISODE,
        search="""    upstream: (): UpstreamState => upstreamOf(track.sender),""",
        replace="""    upstream: (): UpstreamState => "unpublished",""",
        specs=[GATE_SPEC, EPISODE_SPEC],
    ),
    Mutation(
        id="born-paused-bare-pause",
        what="`pauseAtBirth` bypasses the per-publication policy with a bare `pauseUpstream()`, which early-returns on a republish's stale-true flag — so the republish inside a held gate, the seconds-long half of the measured window, is MISSED while the hook reports it proven",
        file=EPISODE,
        search="""  return applyPublishGate([pub], gateHeld, {});""",
        replace="""  void pub.pauseUpstream();
  return Promise.resolve({
    unproven: [],
    failed: [],
    repauseFailed: [],
    repauseThrew: [],
    proven: [pub.name],
  });""",
        specs=[GATE_SPEC, EPISODE_SPEC],
    ),
    Mutation(
        id="born-paused-flagless-detach",
        what="the born adapter's `pause` detaches through the sender without `track.pauseUpstream()`, so livekit's `_isUpstreamPaused` never flips and the gate's later `resume` — which early-returns on a cleared flag — can never re-attach it: that sender is mute for the rest of the call",
        file=EPISODE,
        search="""    () => track.pauseUpstream(),""",
        replace="""    () =>
      Promise.resolve(
        (
          track.sender as unknown as
            | { replaceTrack?(t: null): Promise<void> }
            | null
            | undefined
        )?.replaceTrack?.(null),
      ).then(() => undefined),""",
        specs=[GATE_SPEC, EPISODE_SPEC],
    ),
    Mutation(
        id="born-paused-ignores-the-gate",
        what="`pauseAtBirth` drops its `gateHeld()` guard, so a track born under an EMPTY gate is swept anyway — a resume sweep over a publication nothing asked to pause, emitting `UpstreamResumed` into `#reassertPublishGate` for nothing",
        file=EPISODE,
        search="""  if (!gateHeld()) return null;
  return applyPublishGate([pub], gateHeld, {});""",
        replace="""  return applyPublishGate([pub], gateHeld, {});""",
        specs=[GATE_SPEC, EPISODE_SPEC],
    ),
    Mutation(
        id="born-paused-name-collides-with-episode-key",
        what="the born publication takes the EPISODE KEY `${source}/${sid}` as its name instead of `${source}/${sid ?? 'no-sid'}#born`, so a first publish is named after a sid that does not exist yet and a republish after the publication the answer is about to REPLACE — and either collides with the key `consume` spends by",
        file=EPISODE,
        search="""    `${input.source}/${input.sid ?? "no-sid"}#born`,""",
        replace="""    `${input.source}/${input.sid}`,""",
        specs=[GATE_SPEC, EPISODE_SPEC],
    ),
    Mutation(
        id="born-adapter-captures-the-sender",
        what="the shared builder captures `track.sender` when the publication is BUILT and the thunk reads that constant, so once a republish swaps the sender the post-condition answers for a transceiver that no longer carries anything — `quiet` about a wire that is live on its successor",
        file=EPISODE,
        search="""  return {
    name,
    get upstreamPaused() {
      return track.isUpstreamPaused;
    },
    upstream: (): UpstreamState => upstreamOf(track.sender),""",
        replace="""  const sender = track.sender;
  return {
    name,
    get upstreamPaused() {
      return track.isUpstreamPaused;
    },
    upstream: (): UpstreamState => upstreamOf(sender),""",
        # EPISODE_SPEC only: measured 2026-09-14, `publishGate.test.ts` stays
        # green at its full count under this mutant (its fakes never swap the
        # sender between construction and the post-condition), and only "the
        # born adapter reads the CURRENT sender, never a captured one" catches
        # it. Naming a spec that cannot reach a mutation is how an entry
        # reports a vacuous green, so the list says where the evidence is.
        specs=[EPISODE_SPEC],
    ),
    # ---- the consent hold (banner-honesty wave 4) ---------------------------
    #
    # The adapter side of the two GATE entries above: `gatedPublicationOf`
    # exposes `consentHeld` as a LAZY getter over the predicate
    # `gatedPublicationsFrom` is handed (`state.tsx` passes its `WeakSet`
    # read), and `gatedPublicationFromSender` stamps the flag its caller
    # already knows (`resumeLanded` passes the same read; `pauseAtBirth`
    # passes nothing). Either one hard-coded false leaves `publishGate.ts`'s
    # check fully specified and never true — the share resumes pre-consent
    # with the GATE entries still red on their own spec.
    Mutation(
        id="episode-consent-hold-not-stamped",
        what="the adapter's `consentHeld` getter answers false regardless of the predicate it was handed, so the sweep's `resume` arm never sees a held share and lifts the consent pause at the next 1→0",
        file=EPISODE,
        search="""      return consentHeld?.() === true;""",
        replace="""      return false;""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-born-adapter-ignores-consent-flag",
        what="the born adapter stamps `consentHeld: false` whatever its caller passed, so the `resumeLanded` kick resumes a consent-held share whose republish straddled the 1→0 edge",
        file=EPISODE,
        search="""    () => consentHeld,""",
        replace="""    () => false,""",
        specs=[EPISODE_SPEC],
    ),
]


# --- Mic pipeline deferral (plan D6, wave 2, 2026-09-14) ---------------------
#
# `micPipelinePolicy.ts` is the pure decision `#syncMicPipeline` asks before it
# touches the mic's processor slot. Runs 1 and 3 of the rejoin-leak legs
# measured why it exists: the join-time RNNoise attach runs
# `LocalAudioTrack.setProcessor`, which in the pinned livekit-client 2.15.13
# does `await sender.replaceTrack(processedTrack)` on `trackChangeLock` — not
# the gate's `pauseUpstreamLock` — and emits `TrackProcessorUpdate` only AFTER
# that, so under a held gate the processed mic was on the wire for 1.4–2.8 s
# until the re-assert's `pauseUpstream()` landed. The decision is extracted so
# these two rules are reachable here; the wiring (`#syncMicPipeline` asking it,
# the `#resumeGate` re-run after the awaited sweep) is recorded in the header
# admission above, items (iii) and (iv), never as an entry.
#
# Both entries target `MIC_POLICY` and were measured red under
# `micPipelinePolicy.test.ts` alone on 2026-09-14 with all 4 tests executing.

MUTATIONS += [
    Mutation(
        id="mic-pipeline-attaches-under-a-held-gate",
        what="the held-gate arm returns `attach` instead of `defer`, so the join-time processor attach lands inside a held publish gate — reopening the mirror window `setProcessor → replaceTrack(processedTrack)` that measured 1.4–2.8 s of exposure on every join",
        file=MIC_POLICY,
        search="""  if (input.gateHeld) return "defer";""",
        replace="""  if (input.gateHeld) return "attach";""",
        specs=[MIC_POLICY_SPEC],
    ),
    Mutation(
        id="mic-pipeline-tune-loses-to-gate",
        what="the gate check is moved ABOVE the `hasPipeline` check, so a held gate defers even when a pipeline already exists — a mid-hold settings change on an existing pipeline is LOST for the whole hold instead of tuned in place (tuning is state-only and never touches the sender)",
        file=MIC_POLICY,
        search="""  if (input.hasPipeline) return "tune";
  if (input.wantsDefault) return "none";
  if (input.gateHeld) return "defer";""",
        replace="""  if (input.gateHeld) return "defer";
  if (input.hasPipeline) return "tune";
  if (input.wantsDefault) return "none";""",
        specs=[MIC_POLICY_SPEC],
    ),
]


# --- Publish-time kick scoping (final audit F1, wave 4, 2026-09-14) ----------
#
# `publishKickPolicy.ts` is the pure decision the `LocalTrackPublished` handler
# asks about the gate once a publication has landed. Wave 1 made that kick
# UNCONDITIONAL: the born-paused publication whose gate emptied DURING its
# offer/answer lands as `{flag: true, sender.track: null}` under an empty gate,
# invisible to the 1→0 sweep and to `#reassertPublishGate` (both read
# `trackPublications`, which did not hold it yet), so the publish-time sweep was
# the only thing left that could resume it. The final audit (F1) found the
# empty-gate sweep resumes EVERY `{flag: true, quiet}` publication, and the
# screen-share consent-pending pause — `pauseUpstream()` issued while the
# viewer-consent answer is still pending, on every shell — is one, so the
# sweep put the share on the wire ahead of its answer. The gate is not the
# only owner of `pauseUpstream()`, so "gate empty" cannot mean "resume
# everything quiet". The decision is extracted so its three arms are reachable
# here; the wiring (the `#bornPaused` tag and its consumption, the
# `"resumeLanded"` op over the landed publication alone,
# `#syncMicPipelineIfLanded`) is header admission item (ii), never an entry.
#
# All three entries target `KICK_POLICY` and were measured red under
# `publishKickPolicy.test.ts` alone on 2026-09-14 with all 4 tests executing.

MUTATIONS += [
    Mutation(
        id="publish-kick-sweeps-only-born",
        what="the gate check is moved BELOW the born check, so every born-paused track landing under a STILL-HELD gate (the common case: the gate held for the whole offer/answer, 6/6 publishes in the wave-3 leg) reads `resumeLanded` — a bare one-publication `applyPublishGate(..., {})` instead of the episode's coalescing `#applyPublishGate(room)`: the op still reads the held gate so it pauses rather than resumes, but it runs outside the per-drive `repauseSpent`/`repausePending` bookkeeping and the `stillCurrent` generation check, nothing else in the map is re-asserted on that publish, and `unproven` — the only report a held gate produces — is dropped, because that arm reports on `failed`",
        file=KICK_POLICY,
        search="""  if (input.gateHeld) return "sweep";
  if (input.bornPaused) return "resumeLanded";""",
        replace="""  if (input.bornPaused) return "resumeLanded";
  if (input.gateHeld) return "sweep";""",
        specs=[KICK_POLICY_SPEC],
    ),
    Mutation(
        id="publish-kick-resumes-everything",
        what="the born arm returns `sweep` instead of `resumeLanded`, so a born-paused publication landing under an empty gate runs the whole-map sweep instead of its own resume — every other `{flag: true, quiet}` publication in the map goes on the wire with it, the consent-pending screen share included when its born-paused native-audio track lands: wave 1's F1 regression, back on every shell through every born-paused landing",
        file=KICK_POLICY,
        search="""  if (input.bornPaused) return "resumeLanded";""",
        replace="""  if (input.bornPaused) return "sweep";""",
        specs=[KICK_POLICY_SPEC],
    ),
    Mutation(
        id="publish-kick-ignores-empty-gate",
        what="the last arm returns `resumeLanded` instead of `none`, so an empty gate issues the gate's resume over EVERY landing publication, tagged or not — the gate undoing a pause it never issued. In today's ordering it reaches no quiet wire (every non-gate `pauseUpstream()` owner — the consent-pending share pause, the ask-modal pause — fires AFTER its own publication has landed, and a republish lands with a live sender), so this is the F1 rule itself, `resume ONLY what the hook paused`: the first pause owner that runs before its publish, on any shell, is put on the wire by this arm",
        file=KICK_POLICY,
        search="""  return "none";""",
        replace="""  return "resumeLanded";""",
        specs=[KICK_POLICY_SPEC],
    ),
]


# --- Gate (d), the decode witness, and the chip's input assembly -------------
#
# From `fix/mls-decode-witness-exit-tally`. The 18 entries that branch shared
# with main are above, in main's form.

MUTATIONS += [
    Mutation(
        id="gate-d-removed",
        what="chipState ignores the decode witness entirely (green by default again)",
        file=POLICY,
        search="""  if (
    !mediaObserved ||
    !inputs.localPublicationsEncrypted ||
    !decodeWitnessed
  ) {""",
        replace="""  if (!mediaObserved || !inputs.localPublicationsEncrypted) {""",
    ),
    Mutation(
        id="witness-unavailable-is-green",
        what="a missing worker heartbeat is treated as a witness that passed",
        file=POLICY,
        search="""  const decodeWitnessed =
    inputs.decodeWitness.available &&
    inputs.decodeWitness.dropping.length === 0;""",
        replace="""  const decodeWitnessed =
    !inputs.decodeWitness.available ||
    inputs.decodeWitness.dropping.length === 0;""",
    ),
    Mutation(
        id="dropping-ignored",
        what="the gate checks only that a sample arrived, not what it said",
        file=POLICY,
        search="""  const decodeWitnessed =
    inputs.decodeWitness.available &&
    inputs.decodeWitness.dropping.length === 0;""",
        replace="""  const decodeWitnessed = inputs.decodeWitness.available;""",
    ),
    Mutation(
        id="empty-roster-vouches",
        what="an EMPTY verified roster reads as all-verified, manufacturing a green lock nobody verified",
        file=POLICY,
        search="""  const allVerified =
    inputs.rosterVerified.length > 0 && inputs.rosterVerified.every((v) => v);""",
        replace="""  const allVerified = inputs.rosterVerified.every((v) => v);""",
        specs=[POLICY_SPEC, CHIP_SPEC],
    ),
    Mutation(
        id="summarize-ignores-drops",
        what="summarizeDecodeWitness never reports a sender as dropping",
        file=POLICY,
        search="""      if (tally.dropped > 0) drop = true;""",
        replace="""      if (tally.dropped < 0) drop = true;""",
    ),
    Mutation(
        id="live-excuses-drop",
        what="a sender with ANY index getting through is excused its dropped one",
        file=POLICY,
        search="""    if (drop) dropping.push(participant.identity);
    if (ok) live.push(participant.identity);""",
        replace="""    if (drop && !ok) dropping.push(participant.identity);
    if (ok) live.push(participant.identity);""",
    ),
    Mutation(
        id="witness-arms-a-verdict",
        what="gate (d) is allowed to produce a red instead of only withholding green",
        file=POLICY,
        search="""  const decodeWitnessed =
    inputs.decodeWitness.available &&
    inputs.decodeWitness.dropping.length === 0;""",
        replace="""  const decodeWitnessed =
    inputs.decodeWitness.available &&
    inputs.decodeWitness.dropping.length === 0;
  if (inputs.decodeWitness.dropping.length > 0) return "not_encrypted";""",
    ),
    Mutation(
        id="witness-initial-available",
        what="the chip's witness signal starts AVAILABLE, so a call that never armed the witness reads green",
        file=WITNESS,
        search="""export const DECODE_WITNESS_INITIAL: DecodeWitness = DECODE_WITNESS_UNAVAILABLE;""",
        replace="""export const DECODE_WITNESS_INITIAL: DecodeWitness = {
  available: true,
  dropping: [],
  live: [],
};""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-never-goes-stale",
        what="the staleness comparison has its operands the wrong way round, so the witness never expires",
        file=WITNESS,
        search="""      if (now() - lastAt <= staleMs) return;""",
        replace="""      if (lastAt - now() <= staleMs) return;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-stale-threshold-widened",
        what="the staleness threshold is a hundred times the three-beat bound, so a dead worker holds its green for minutes",
        file=WITNESS,
        search="""export const DECODE_WITNESS_STALE_MS = 3 * DECODE_WITNESS_CHECK_MS;""",
        replace="""export const DECODE_WITNESS_STALE_MS = 300 * DECODE_WITNESS_CHECK_MS;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-teardown-keeps-standing",
        what="teardown leaves the last sample standing instead of writing UNAVAILABLE",
        file=WITNESS,
        search="""      onWitness(DECODE_WITNESS_UNAVAILABLE);
      stopped = true;
    },""",
        replace="""      stopped = true;
    },""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-kind-guard-presence-only",
        what="the message-kind guard checks that a kind is PRESENT, not that it is ours — livekit's own worker posts are read as witnesses",
        file=WITNESS,
        search="""  return isRecord(data) && data.kind === DECODE_WITNESS_KIND;""",
        replace="""  return isRecord(data) && data.kind !== undefined;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-malformed-promotes",
        what="a malformed sample is coerced to an EMPTY window, and summarizing an empty window returns available:true",
        file=WITNESS,
        search="""  if (!Array.isArray(participants)) return null;""",
        replace="""  if (!Array.isArray(participants)) return [];""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-clock-credited-before-write",
        what="the staleness clock is credited on message ARRIVAL, so a witness the chip never received still counts as a heartbeat",
        file=WITNESS,
        search="""      onWitness(summarizeDecodeWitness(participants));
      // 🔴 Credited AFTER the write, never before it.""",
        replace="""      lastAt = now();
      onWitness(summarizeDecodeWitness(participants));
      // 🔴 Credited AFTER the write, never before it.""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-stop-not-terminal",
        what="a sample arriving after teardown promotes the witness again",
        file=WITNESS,
        search="""    onMessage(data: unknown): void {
      if (stopped) return;""",
        replace="""    onMessage(data: unknown): void {""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-tick-not-terminal",
        what="the staleness sweep keeps writing after teardown",
        file=WITNESS,
        search="""    tick(): void {
      if (stopped) return;""",
        replace="""    tick(): void {""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-counts-may-be-negative",
        what="tally counts are merely finite, so {seen:-10, dropped:-10} summarizes to a CLEAN read",
        file=WITNESS,
        search="""const isCount = (value: unknown): value is number =>
  isInteger(value) && value >= 0;""",
        replace="""const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-drops-may-exceed-arrivals",
        what="a window claiming more frames thrown away than ever arrived is accepted",
        file=WITNESS,
        search="""      if (dropped > seen) return null;""",
        replace="""      if (false) return null;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-bad-entry-skipped",
        what="a malformed participant entry is SKIPPED rather than disqualifying the window, so garbage summarizes clean",
        file=WITNESS,
        search="""    if (!isRecord(entry)) return null;""",
        replace="""    if (!isRecord(entry)) continue;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-identity-unchecked",
        what="an entry with no identity is skipped instead of disqualifying the window",
        file=WITNESS,
        search="""    if (typeof identity !== "string") return null;""",
        replace="""    if (typeof identity !== "string") continue;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-indexes-unchecked",
        what="an entry with no indexes array is skipped instead of disqualifying the window",
        file=WITNESS,
        search="""    if (!Array.isArray(indexes)) return null;""",
        replace="""    if (!Array.isArray(indexes)) continue;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-bad-tally-skipped",
        what="a tally that is not an object is skipped, so a sender's real drops can be summarized away",
        file=WITNESS,
        search="""      if (!isRecord(tally)) return null;""",
        replace="""      if (!isRecord(tally)) continue;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-stop-latches-before-write",
        what="stop() latches before its write, so an undelivered UNAVAILABLE leaves the listener permanently inert",
        file=WITNESS,
        search="""      onWitness(DECODE_WITNESS_UNAVAILABLE);
      stopped = true;
    },""",
        replace="""      stopped = true;
      onWitness(DECODE_WITNESS_UNAVAILABLE);
    },""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-sweep-invariant-removed",
        what="the sweep interval may be slower than the staleness threshold, so a dead worker holds its green for most of it",
        file=WITNESS,
        search="""  if (!(staleMs >= 2 * checkMs)) {""",
        replace="""  if (false) {""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-skew-warning-silent",
        what="a worker posting a shape this build cannot read says nothing, and the staleness warning then blames the missing patch",
        file=WITNESS,
        search="""        if (isDecodeWitnessKind(data) && !skewWarned) {""",
        replace="""        if (false && !skewWarned) {""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-equality-ignores-drops",
        what="the signal comparator ignores WHO is dropping, so Solid skips the write and the chip freezes green",
        file=WITNESS,
        search="""    a.available === b.available &&
    a.dropping.length === b.dropping.length &&
    a.dropping.every((id, i) => id === b.dropping[i])""",
        replace="""    a.available === b.available""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-equality-ignores-identity",
        what="the comparator checks only the COUNT of dropping senders, not which ones",
        file=WITNESS,
        search="""    a.dropping.every((id, i) => id === b.dropping[i])""",
        replace="""    true""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-session-guard-removed",
        what="a disposed session's queued post writes the newer call's witness",
        file=WITNESS,
        search="""      if (!isCurrentSession()) return;""",
        replace="""      isCurrentSession();""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="chip-no-publishers-judged",
        what="gate (b) judges nobody, so a publisher LiveKit never vouched for reads green",
        file=CHIP,
        search="""  if (!room) return [];""",
        replace="""  if (room) return [];""",
        # Gate (b) is reachable from the session suite now that the
        # harness can express an unvouched-for publisher. `must_red`
        # so the claim is checked on its own rather than masked by
        # CHIP_SPEC, which reddens for this unconditionally.
        specs=[CHIP_SPEC, JOINRACE_SPEC],
        must_red=[JOINRACE_SPEC],
    ),
    Mutation(
        id="chip-own-screen-leg-judged",
        what="our own screen leg is judged, pinning the sharer's own device amber for the whole share",
        file=CHIP,
        search="""    ) {
      continue;
    }""",
        replace="""    ) {
      publishing.push(participant.identity);
    }""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-trackless-listener-judged",
        what="a participant publishing nothing is judged, though it never reports a status (FE-2)",
        file=CHIP,
        search="""    if (participant.publicationCount > 0) publishing.push(participant.identity);""",
        replace="""    publishing.push(participant.identity);""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-missing-status-defaults-encrypted",
        what="a publisher with no observed status is entered as ENCRYPTED — an absence read as a pass",
        file=CHIP,
        search="""    if (status !== undefined) observed.set(identity, status);""",
        replace="""    observed.set(identity, status ?? true);""",
        # Gate (b) is reachable from the session suite now that the
        # harness can express an unvouched-for publisher. `must_red`
        # so the claim is checked on its own rather than masked by
        # CHIP_SPEC, which reddens for this unconditionally.
        specs=[CHIP_SPEC, JOINRACE_SPEC],
        must_red=[JOINRACE_SPEC],
    ),
    Mutation(
        id="chip-local-declaration-assumed",
        what="our own publications are assumed declared GCM instead of being read from the SFU's record",
        file=CHIP,
        search="""    localPublicationsEncrypted: room
      ? localPublicationsEncrypted(room.localPublications)
      : true,""",
        replace="""    localPublicationsEncrypted: true,""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-roster-emptied",
        what="the verified roster is read as EMPTY, and [].every(v => v) manufactures a verified lock",
        file=CHIP,
        search="""    rosterVerified: sources.rosterVerified(),""",
        replace="""    rosterVerified: [],""",
        # JOINRACE too: measurably reachable from the session suite,
        # which is the standing proof that the harness runs the REAL
        # assembly rather than a copy of it. If it is ever reverted to
        # a hand-built literal this stops turning that suite red, and
        # the runner reports the unexpected "green" as a hard failure.
        specs=[CHIP_SPEC, JOINRACE_SPEC],
        must_red=[JOINRACE_SPEC],
    ),
    Mutation(
        id="chip-witness-literal",
        what="gate (d) is handed an available literal instead of the witness — round 4's CRITICAL, now reachable",
        file=CHIP,
        search="""    decodeWitness: sources.decodeWitness(),""",
        replace="""    decodeWitness: { available: true, dropping: [], live: [] },""",
        # JOINRACE too: measurably reachable from the session suite,
        # which is the standing proof that the harness runs the REAL
        # assembly rather than a copy of it. If it is ever reverted to
        # a hand-built literal this stops turning that suite red, and
        # the runner reports the unexpected "green" as a hard failure.
        specs=[CHIP_SPEC, JOINRACE_SPEC],
        must_red=[JOINRACE_SPEC],
    ),
    Mutation(
        id="chip-media-hold-ignored",
        what="a rotation-window media hold does not reach the chip",
        file=CHIP,
        search="""    resecuring: sessionState === "resecuring" || sources.mediaHold(),""",
        replace="""    resecuring: sessionState === "resecuring",""",
        # JOINRACE too: measurably reachable from the session suite,
        # which is the standing proof that the harness runs the REAL
        # assembly rather than a copy of it. If it is ever reverted to
        # a hand-built literal this stops turning that suite red, and
        # the runner reports the unexpected "green" as a hard failure.
        specs=[CHIP_SPEC, JOINRACE_SPEC],
        must_red=[JOINRACE_SPEC],
    ),
    Mutation(
        id="chip-latched-error-ignored",
        what="a latched structured error does not reach the chip",
        file=CHIP,
        # Retargeted 2026-09-20 (banner-honesty wave 2): the boolean
        # `latchedError` became `latch: ChipLatch | undefined` (origin +
        # keyed-ness). Same defect — the latch never reaches the chip.
        search="""    latch: sources.latch(),""",
        replace="""    latch: undefined,""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-has-session-assumed",
        what="a session is assumed to exist, so the ME-7 silent-fail guard degrades to a quiet amber",
        file=CHIP,
        search="""    hasSession: sources.hasSession(),""",
        replace="""    hasSession: true,""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-open-group-assumed-absent",
        what="the open-group probe is read as false, HIDING the chip entirely on a failed E2EE call",
        file=CHIP,
        search="""    channelHasOpenGroup: sources.channelHasOpenGroup(),""",
        replace="""    channelHasOpenGroup: false,""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-device-setup-assumed-done",
        what="the device-needs-setup fact is hardcoded false, silencing a never-enrolled device's chip",
        file=CHIP,
        search="""    deviceNeedsSetup: sources.deviceNeedsSetup(),""",
        replace="""    deviceNeedsSetup: false,""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-peer-encrypt-assumed",
        what="a peer is assumed able to encrypt, reddening a plain call on an unenrolled device",
        file=CHIP,
        search="""    peerCouldEncrypt: sources.peerCouldEncrypt(),""",
        replace="""    peerCouldEncrypt: true,""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-mode-assumed-e2ee",
        what="the call mode is assumed e2ee, so a negotiating call reads enabled and keyed",
        file=CHIP,
        search="""  const mode = sources.mode();""",
        replace="""  const mode = { kind: "e2ee" } as const;
  void sources.mode;""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-seam-reopened",
        what="the assembled inputs escape to the caller, which can then override any field",
        file=CHIP,
        search="""export function chipStateFrom(sources: ChipSources): ChipState {
  return chipState(chipInputsFrom(sources));
}""",
        replace="""export function chipStateFrom(sources: ChipSources): ChipState {
  return chipState({
    ...chipInputsFrom(sources),
    decodeWitness: { available: true, dropping: [], live: [] },
  });
}""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-observed-accessor-detached",
        what="the observed-status accessor is passed detached, losing its receiver",
        file=CHIP,
        search="""      (identity) => sources.observedEncryption(identity),""",
        replace="""      () => true,""",
        specs=[CHIP_SPEC],
    ),
    # Opt-in shares (final audit F2): nobody here subscribes an unwatched
    # share, so its GCM declaration is the only thing that can contradict a
    # "not NONE" status. Both halves of that one-way rule must stay pinned.
    Mutation(
        id="chip-share-declaration-not-none",
        what="an unwatched share passes on any declaration that is not NONE, so a missing field reads green",
        file=CHIP,
        search="""  return publications.some((pub) => pub.encryption !== ENCRYPTION_TYPE_GCM);""",
        replace="""  return publications.some((pub) => pub.encryption === 0);""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-share-contradiction-dropped",
        what="a non-GCM declaration on an all-unwatched-shares participant no longer forces the status false",
        file=CHIP,
        search="""    if (shareOnlyDeclarationContradicts(participant))
      observed.set(participant.identity, false);""",
        replace="""    if (shareOnlyDeclarationContradicts(participant)) continue;""",
        specs=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-session-state-assumed-active",
        what="the session state is assumed ACTIVE, so a FAILED session reads green",
        file=CHIP,
        search="""  const sessionState = sources.sessionState();""",
        replace="""  const sessionState = "active" as const;
  void sources.sessionState;""",
        specs=[CHIP_SPEC],
    ),
]


# --- Banner-honesty wave 2: the `cannot_verify` split and the escape ---------
#
# `mlsCallModePolicy.ts`: rows 3–5 of `chipState`'s order of record (the ONE
# rule that yields `cannot_verify` and the two conjuncts that keep it honest),
# `redBannerKind` (wave 3 moved the red guard there out of the former
# `callBannerState`; `callBanner` composes it, and since wave 5 it is the ONE
# loud rule — the harness's `terminalLoud()` reads `callBanner(...).kind`)
# giving the second loud value its own `cannot_verify` arm, and
# the `local_confirm` arms (`mixed` released from `negotiating`; the in-app
# `via: "app"` variant announcing nothing and minting a NON-sticky interlude).
# `mlsCallSession.ts`: `#latchLoud`'s `mediaKeyed` snapshot and its single
# upgrade emit, and `confirmPlaintext`'s routing around the native dialog.
# `mlsCallSession.harness.ts`: the harness's own latch feed, the canary that
# the session suite reads the session's origin rather than a copy of it.
# Every entry `expect="red"`; the wirings no spec can load are in the header
# admission (v)–(viii). The `MissingLocalFrameKeyError` entry was OWED at first
# (no harness seam); the wave-2 fix pass added `failLocalKeyOnce` and the
# falsered spec, and it is listed below, pinned `must_red`; wave 5 added its
# Remove-immediate twin (`rotation-immediate-local-key-reads-media`), the
# same exclusion driven through `applyKeys` rather than the Add-grace path.

MUTATIONS += [
    # ---- row 4 and its conjuncts --------------------------------------------
    Mutation(
        id="chip-cannot-verify-collapses-to-not-encrypted",
        what="row 4 answers `not_encrypted`, so a keyed control latch over a clean media plane claims a plaintext it cannot prove",
        file=POLICY,
        search="""    inputs.decodeWitness.dropping.length === 0
  ) {
    return "cannot_verify";
  }""",
        replace="""    inputs.decodeWitness.dropping.length === 0
  ) {
    return "not_encrypted";
  }""",
        specs=[POLICY_SPEC],
    ),
    Mutation(
        id="chip-cannot-verify-ignores-witness",
        what="row 4 drops the decode-witness conjunct, so a control latch softens to `cannot_verify` while a peer's frames are being discarded",
        file=POLICY,
        search="""    latch.mediaKeyed &&
    inputs.localPublicationsEncrypted &&
    inputs.decodeWitness.dropping.length === 0
  ) {""",
        replace="""    latch.mediaKeyed &&
    inputs.localPublicationsEncrypted
  ) {""",
        specs=[POLICY_SPEC],
    ),
    Mutation(
        id="chip-cannot-verify-ignores-media-keyed",
        what="row 4 drops the `mediaKeyed` conjunct, so an UN-keyed control latch (a spent first-join ladder, a media→control upgrade) reads `cannot_verify`",
        file=POLICY,
        search="""    latch?.origin === "control" &&
    latch.mediaKeyed &&""",
        replace="""    latch?.origin === "control" &&""",
        specs=[POLICY_SPEC],
    ),
    Mutation(
        id="banner-cannot-verify-collapses-to-terminal-loud",
        what="`redBannerKind` folds `cannot_verify` into `terminal_loud`: the chip loses its own copy and its Rejoin action, and the banner frames a plaintext the media plane may not have",
        file=POLICY,
        search="""  if (inputs.chip === "cannot_verify") return "cannot_verify";""",
        replace="""  if (inputs.chip === "cannot_verify") return "terminal_loud";""",
        specs=[POLICY_SPEC],
    ),
    Mutation(
        id="banner-state-cannot-verify-bannerless",
        what="`redBannerKind`'s red guard is not widened (wave 3 moved it there from `callBannerState`; `callBanner` composes it), so `cannot_verify` reads as 'not red' and gets NO banner",
        file=POLICY,
        search="""  if (inputs.chip === "cannot_verify") return "cannot_verify";
  if (inputs.chip !== "not_encrypted") return "none";""",
        replace="""  if (inputs.chip !== "not_encrypted") return "none";""",
        specs=[POLICY_SPEC],
    ),
    # ---- the escape's mode arms ---------------------------------------------
    Mutation(
        id="escape-negotiating-keeps-mixed-held",
        what="a terminal confirm from `negotiating` leaves `mixed` held (lane-3 C1): the banner says media is being sent while the gate still pauses it",
        file=POLICY,
        search="""      if (mode.kind === "negotiating") {
        return {
          mode: confirmed,
          effects: [
            { do: "set_e2ee", enabled: false },
            { do: "resume", reason: "mixed" },
            { do: "resume", reason: "enable-window" },""",
        replace="""      if (mode.kind === "negotiating") {
        return {
          mode: confirmed,
          effects: [
            { do: "set_e2ee", enabled: false },
            { do: "resume", reason: "enable-window" },""",
        specs=[POLICY_SPEC, ESCAPE_SPEC],
        must_red=[ESCAPE_SPEC],
    ),
    Mutation(
        id="escape-app-confirm-announces",
        what="the in-app confirm announces: `callAnnounce` is native-gated on a grant the in-app route never armed, so the announce is refused and a later T6 clear runs against nothing",
        file=POLICY,
        search="""      const announce: CallModeEffect[] =
        via === "app" ? [] : [{ do: "announce" }];""",
        replace="""      const announce: CallModeEffect[] = [{ do: "announce" }];""",
        specs=[POLICY_SPEC, ESCAPE_SPEC],
        must_red=[ESCAPE_SPEC],
    ),
    Mutation(
        id="escape-app-interlude-sticky",
        what="an APP-confirmed interlude is sticky across a re-secure, so the in-app route mints a permanent plaintext interlude the user is never asked about again",
        file=POLICY,
        # Anchored on `interludeStickyAcrossResecure`'s own conjunct — the rule
        # S:3507 / S:6026 consult — never on the dead `resecure` event arm.
        search="""    mode.localConfirmed &&
    mode.confirmedVia !== "app"
  );""",
        replace="""    mode.localConfirmed &&
    true
  );""",
        specs=[POLICY_SPEC, ESCAPE_SPEC],
        must_red=[ESCAPE_SPEC],
    ),
    # ---- the latch snapshot -------------------------------------------------
    Mutation(
        id="chip-upgrade-reads-keyed",
        what="the media→control upgrade emits `mediaKeyed: true`, so a plane the worker already reported broken softens to 'can't verify'",
        file=SESSION,
        search="""        this.#media?.onEncryptionState?.("loud", error, {
          origin: "control",
          mediaKeyed: false,
          replaces: previous,
        });""",
        replace="""        this.#media?.onEncryptionState?.("loud", error, {
          origin: "control",
          mediaKeyed: true,
          replaces: previous,
        });""",
        # The kill is the emission deepEqual in the joinrace upgrade spec (and
        # falsered fr7), not the chip canary: row 5 reads an upgrade
        # `not_encrypted` either way, so the chip alone cannot see this.
        specs=[JOINRACE_SPEC, FALSERED_SPEC],
        must_red=[JOINRACE_SPEC],
    ),
    Mutation(
        id="chip-media-latch-reads-control",
        what="every latch is emitted as CONTROL origin, so a media latch (frames failed to decrypt) can reach row 4 and read 'can't verify'",
        file=SESSION,
        search="""    this.#media?.onEncryptionState?.("loud", error, { origin, mediaKeyed });""",
        replace="""    this.#media?.onEncryptionState?.("loud", error, {
      origin: "control",
      mediaKeyed,
    });""",
        specs=[FALSERED_SPEC, JOINRACE_SPEC],
        must_red=[FALSERED_SPEC],
    ),
    Mutation(
        id="chip-plain-declaration-reads-keyed",
        what="the snapshot ignores `#localDeclarationPlain`, so the declaration-seam latch reads keyed while our own publications are on the SFU's record as plaintext",
        file=SESSION,
        search="""      this.#hasLocalKey &&
      !this.#localDeclarationPlain &&
      !(error instanceof MissingLocalFrameKeyError);""",
        replace="""      this.#hasLocalKey &&
      !(error instanceof MissingLocalFrameKeyError);""",
        specs=[JOINRACE_SPEC, FALSERED_SPEC],
        must_red=[JOINRACE_SPEC],
    ),
    Mutation(
        id="chip-missing-frame-key-reads-keyed",
        what="the snapshot drops the `MissingLocalFrameKeyError` exclusion, so a REMOVED leaf's control latch (both flags still true from the previous epoch's key) reads keyed and softens to 'can't verify'",
        file=SESSION,
        search="""      !this.#localDeclarationPlain &&
      !(error instanceof MissingLocalFrameKeyError);""",
        replace="""      !this.#localDeclarationPlain;""",
        # Driven through the harness's `failLocalKeyOnce` seam (wave-2 fix
        # pass, 2026-09-20). Killed by falsered's missing-local-frame-key spec
        # at BOTH the emission deepEqual (`mediaKeyed: false`) and the chip
        # assert (`not_encrypted`, never `cannot_verify`).
        specs=[FALSERED_SPEC],
        must_red=[FALSERED_SPEC],
        expect="red",
    ),
    Mutation(
        id="rotation-immediate-local-key-reads-media",
        what="the Remove-immediate install's catch routes to `#onMediaError`, so a REMOVED leaf's `MissingLocalFrameKeyError` takes the re-securing debounce as a MEDIA latch instead of the by-class control latch — amber over a device native just said is no sender",
        file=SESSION,
        # The four-line anchor (catch + close of `#applyEpoch`'s install): the
        # bare `this.#onRotationError(error);` line counts 2 — the Add-grace
        # deferred-local call carries it too — so the catch is matched with its
        # closing braces. Driven through `failLocalKeyOnce` on the IMMEDIATE
        # path (`applyKeys`); killed by falsered fr11 (wave 5) at the emission
        # deepEqual (`origin: "control", mediaKeyed: false`) and the
        # `negotiating` fold.
        search="""    } catch (error) {
      this.#onRotationError(error);
    }
  }
""",
        replace="""    } catch (error) {
      this.#onMediaError(error);
    }
  }
""",
        specs=[FALSERED_SPEC],
        must_red=[FALSERED_SPEC],
        expect="red",
    ),
    # ---- confirmPlaintext's routing -----------------------------------------
    Mutation(
        id="escape-declined-routes-to-app",
        what="a DECLINED native dialog falls through to the in-app confirm, so the user's 'No' resumes plaintext",
        file=SESSION,
        search="""      if ((e as { type?: string })?.type === "declined") return;
      return this.confirmLocalPlaintext();""",
        replace="""      void e;
      return this.confirmLocalPlaintext();""",
        specs=[ESCAPE_SPEC],
    ),
    Mutation(
        id="escape-no-group-returns-early",
        what="confirmPlaintext returns without a usable group (the pre-wave-2 early return), leaving 'Stay unencrypted' inert under a red chip",
        file=SESSION,
        search="""    if (groupId === null || !this.hasUsableGroup()) {
      return this.confirmLocalPlaintext();
    }""",
        replace="""    if (groupId === null || !this.hasUsableGroup()) {
      return;
    }""",
        specs=[ESCAPE_SPEC],
    ),
    # ---- the ME-4 re-announce's provenance test -----------------------------
    Mutation(
        id="escape-app-interlude-reannounces",
        what="the ME-4 epoch-advance re-announce ignores provenance, so an APP-confirmed interlude re-attempts the native announce on every epoch (refused `mls_not_confirmed` each time)",
        file=SESSION,
        # The exact conjunct line, dropped whole (newline included) so the
        # mutant is still well-formed TS: the `&&` chain closes on the
        # neighbouring conjuncts. Killed by escape spec 8: `announces()` reads
        # 2 (one per advance) against an asserted 0.
        search="""      this.#callMode.confirmedVia !== "app" &&
""",
        replace="",
        specs=[ESCAPE_SPEC],
        must_red=[ESCAPE_SPEC],
        expect="red",
    ),
    # ---- the harness's own latch feed ---------------------------------------
    Mutation(
        id="harness-chip-origin-hardcoded",
        what="the harness feeds every latch to the chip as CONTROL origin, so the session suite's media-latch `not_encrypted` reads would be measuring a hand-built origin rather than the session's",
        file=HARNESS,
        search="""        latch && {
          origin: latch.origin,
          mediaKeyed: latch.mediaKeyed ?? false,
        },""",
        replace="""        latch && {
          origin: "control",
          mediaKeyed: latch.mediaKeyed ?? false,
        },""",
        # Measured 2026-09-20: falsered AND joinrace each go red on their own
        # (a media latch fed as control reaches row 4 under the harness's keyed
        # snapshot and clean witness). Both pinned individually.
        specs=[FALSERED_SPEC, JOINRACE_SPEC],
        must_red=[FALSERED_SPEC, JOINRACE_SPEC],
    ),
]


# --- The two-axis banner and its pause-clause hold (banner-honesty wave 3) --
#
# `callBanner` (`mlsCallModePolicy.ts`) now answers `{ kind, pause }`:
# `redBannerKind` (the pre-wave-3 table, evaluated first and in full), then
# `securingReachable` for a chip it read as not red, then `pauseClauseFor`.
# `pauseClauseHold.ts` is the pure hysteresis the banner folds the pause
# clause through so a bouncing `disproved` reads as one warning. Both are
# loadable, so every rule below is reachable; the wirings that feed them
# (the `state.tsx` accessor, the component's fold and timer, the overlay's
# read) are header admission items (ix)–(xi), never entries.
#
# The six POLICY entries were measured red under `mlsCallModePolicy.test.ts`
# alone on 2026-09-20 with all 123 tests executing; the three HOLD entries
# under `pauseClauseHold.test.ts` alone with all 7 executing.

MUTATIONS += [
    # ---- the securing notice ------------------------------------------------
    Mutation(
        id="banner-securing-unreachable",
        what="`securingReachable` never answers true, so the pre-verdict join (mode undefined, or `negotiating` on a rejoin) shows NO banner while the gate is held — the user hears silence with nothing on screen saying why",
        file=POLICY,
        search="""    inputs.hasSession &&""",
        replace="""    false &&""",
        specs=[POLICY_SPEC],
    ),
    # ---- the pause clause -----------------------------------------------------
    Mutation(
        id="banner-disproof-raises-unconfirmed",
        what="the `disproved` row fires on `pauseDisproved` alone, so a budget-exhausted `{ value: true, confirmed: false }` observation raises the blocking 'may still be sending — leave to stop it' line over a wire the verdict never confirmed",
        file=POLICY,
        search="""  if (inputs.pauseDisproved && inputs.pauseDisproofConfirmed) {""",
        replace="""  if (inputs.pauseDisproved) {""",
        specs=[POLICY_SPEC],
    ),
    Mutation(
        id="banner-disproof-ignored",
        what="the `disproved` row is unreachable, so a CONFIRMED disproof (`{ true, true }`) still reads `held` and the banner keeps promising a pause over a live wire — the false red this slice exists to remove",
        file=POLICY,
        search="""  if (inputs.pauseDisproved && inputs.pauseDisproofConfirmed) {""",
        replace="""  if (false && inputs.pauseDisproofConfirmed) {""",
        specs=[POLICY_SPEC],
    ),
    Mutation(
        id="banner-hidden-carries-pause",
        what="a hidden banner (`kind: none`) carries a pause clause, so a transient `{ none, disproved }` parks the Watch Together float through `bannerParksFloat` with nothing rendered to say why",
        file=POLICY,
        # The guard line dropped whole (newline included) so the mutant is
        # still well-formed TS and `pauseClauseFor` falls straight into the
        # verdict test.
        search='  if (kind === "none") return "none";\n',
        replace="",
        specs=[POLICY_SPEC],
    ),
    # ---- what parks the float -------------------------------------------------
    Mutation(
        id="banner-securing-parks",
        what="`securing` parks the Watch Together float, so every join un-anchors the player behind a notice that has no control to clear it and is expected to resolve on its own",
        file=POLICY,
        search="""    banner.kind === "mixed" ||""",
        replace="""    banner.kind === "securing" ||
    banner.kind === "mixed" ||""",
        specs=[POLICY_SPEC],
    ),
    Mutation(
        id="banner-disproved-does-not-park",
        what="a `disproved` pause no longer parks the float, so the one line the user must not miss ('may still be sending — leave to stop it') can sit under the player",
        file=POLICY,
        search='    banner.pause === "disproved"',
        replace="""    false""",
        specs=[POLICY_SPEC],
    ),
    # ---- the pause-clause hold ------------------------------------------------
    Mutation(
        id="hold-never-expires",
        what="the hold window is unbounded, so one confirmed disproof keeps 'may still be sending' up for the rest of the call over a gate that has long since re-paused",
        file=HOLD,
        search="""export const PAUSE_DISPROOF_HOLD_MS = 15_000;""",
        replace="""export const PAUSE_DISPROOF_HOLD_MS = Number.MAX_SAFE_INTEGER;""",
        specs=[HOLD_SPEC],
    ),
    Mutation(
        id="hold-is-zero",
        what="the hold window is zero, so a `disproved` → quiet → `disproved` bounce flashes the blocking line at the verdict's own frequency — the flicker the hold exists to remove",
        file=HOLD,
        search="""export const PAUSE_DISPROOF_HOLD_MS = 15_000;""",
        replace="""export const PAUSE_DISPROOF_HOLD_MS = 0;""",
        specs=[HOLD_SPEC],
    ),
    Mutation(
        id="hold-survives-green",
        what="the hold ignores `kind: none`, so a banner that just went hidden — the call re-secured, the gate released 1→0 — keeps rendering 'may still be sending' for the rest of the window: a false red over a green call",
        file=HOLD,
        search="""  if (banner.kind === "none" || banner.pause === "none") {""",
        replace="""  if (banner.pause === "none") {""",
        specs=[HOLD_SPEC],
    ),
]


# --- The join timeline (join-latency plan, slice 0, wave 1, 2026-09-20) ------
#
# `mlsJoinTimeline.ts` is the pure recorder both seats stamp as the join
# ladder passes each stage; `mlsCallSession.ts` only wires it. The three
# recorder rules a misreading would silently corrupt — first occurrence wins,
# an untaken stamp reads null (never 0, which is also t0), totalMs is last
# minus first — are pinned under `mlsJoinTimeline.test.ts` alone. The session
# wiring is only as measurable as the harness reaches: the `keysInstalled`
# stamp inside `#onLocalKeyInstalled` is the one the timeline spec drives
# directly, so it is the one pinned; the rest of the joiner ladder and the
# admitter map are asserted as a sequence by `mlsCallSession.timeline.test.ts`
# and are not given entries here, because a dropped stamp elsewhere in that
# sequence is the same one-line defect and one pin is what proves the spec can
# see it. Every entry `expect="red"` and `must_red` on its own spec.

MUTATIONS += [
    # ---- the recorder's rules -----------------------------------------------
    Mutation(
        id="timeline-last-wins",
        what="a duplicate stamp name overwrites the first occurrence, so a retried stage reports the time of the retry and hides the very wait the timeline exists to measure",
        file=TIMELINE,
        search="""    if (this.#stamps.some((entry) => entry.name === name)) return;""",
        replace="""    this.#stamps = this.#stamps.filter((entry) => entry.name !== name);""",
        specs=[TIMELINE_SPEC],
        must_red=[TIMELINE_SPEC],
    ),
    Mutation(
        id="timeline-elapsed-zero",
        what="`elapsedTo` answers 0 for a stamp never taken, which is indistinguishable from t0 — a stage that never ran reads as 'reached instantly'",
        file=TIMELINE,
        search="""    return entry ? entry.ms : null;""",
        replace="""    return entry ? entry.ms : 0;""",
        specs=[TIMELINE_SPEC],
        must_red=[TIMELINE_SPEC],
    ),
    Mutation(
        id="timeline-total-first",
        what="`totalMs` reads the first stamp instead of last minus first, so every summary reports a 0 ms join whatever the ladder took",
        file=TIMELINE,
        search="""        ? roundTenth(stamps[stamps.length - 1].ms - stamps[0].ms)""",
        replace="""        ? roundTenth(stamps[0].ms)""",
        specs=[TIMELINE_SPEC],
        must_red=[TIMELINE_SPEC],
    ),
    # ---- the session's wiring -----------------------------------------------
    Mutation(
        id="timeline-drop-keys-installed",
        what="the `keysInstalled` stamp is not taken in `#onLocalKeyInstalled`, so the readout cannot attribute the wait between the welcome and the first local key — the stage the plan's levers are argued over",
        file=SESSION,
        # The stamp line dropped whole (newline included) so the mutant is
        # still well-formed TS. Killed by the timeline spec's keysInstalled
        # assertion on the summary.
        search="""    this.#joinTimeline?.stamp("keysInstalled");
""",
        replace="",
        specs=[SESSION_TIMELINE_SPEC],
        must_red=[SESSION_TIMELINE_SPEC],
    ),
]


# --- The late-drain guard (fix/mls-late-drain-guard, 2026-09-26) -------------
#
# L14c: a restarted page wipes its group and re-intents, and its mailbox drains
# LATE. Two defects rode that drain. W2-M1: a gap refetch the DS answered 404
# threw out of `#consume` and `#pump` as an unhandled rejection — the envelope
# never acked, retried or escalated, and the group id in Sentry. W2-M2: a stale
# Welcome, sealed to the earlier intent, was adopted at an old epoch and went
# green there. The fix is a pure policy (`mlsRefetchPolicy.ts`: the failure
# classification and the Welcome currency verdict) plus call-site edits in
# `mlsCallSession.ts`: `#gapRefetchInline` classifies its own failure, the
# `gap_refetch` arm retries a failed refetch, `#pump` catches per envelope,
# and the Welcome adopt block records a pending currency check that `#pump`
# runs under the lock before anything goes active.
#
# Placed HERE, mid-file and ahead of every rejoin-resume block, on purpose:
# that branch appends its blocks at the end of this file and adds constants to
# the list at the top, so this block and its own constants below stay out of
# both merge windows.
#
# Each entry is `must_red` on the ONE spec that owns the case that kills it.
# Almost all of them are the session's `mlsCallSession.drainfail.test.ts`;
# the three LD1 rule entries are `mlsRefetchPolicy.test.ts`. The case named on
# each entry is the one MEASURED red under it.
#
# 🔴 KNOWN NON-ENTRIES, recorded rather than silently absent:
#   (a) deleting `if (currentEpoch < welcomeEpoch) return "rejoin";` outright
#       is EQUIVALENT — `lag` goes negative, no page has a negative length,
#       and the contiguity rule rejoins anyway. The entry below makes the
#       line answer `"current"` instead, which is the defect it guards.
#   (b) the `welcomeEpoch`, `currentEpoch` and per-commit finiteness terms of
#       `welcomeCurrencyVerdict` are equivalent too (NaN arithmetic already
#       fails every later comparison into `"rejoin"`); only the `lagLimit`
#       term is live, and it has no entry here.

REFETCH_POLICY = "mlsRefetchPolicy.ts"
REFETCH_POLICY_SPEC = "components/rtc/mlsRefetchPolicy.test.ts"
DRAINFAIL_SPEC = "components/rtc/mlsCallSession.drainfail.test.ts"

MUTATIONS += [
    # ---- the gap refetch (W2-M1, LD-D2 / LD-D3) ------------------------------
    Mutation(
        id="refetch-catch-removed",
        what="`#gapRefetchInline` no longer catches its own fetch, so a DS 404 is never read as 'not a member': it falls through as a transient failure and the device keeps parking against a group the DS says it is not in, instead of re-securing and rejoining fresh",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by A1, A4b, A5, C9 and
        # E1 (5 of 33).
        search="""    let res: Awaited<ReturnType<E2EEBridge["mlsFetchCommits"]>>;
    try {
      res = await this.#deps.bridge.mlsFetchCommits(groupId, fromEpoch);
    } catch (error) {
      if (this.#terminal() || this.#groupId !== groupId) return;
      if (classifyRefetchFailure(error) === "transient") throw error;
      // LD-D2: a 404 is the DS saying this device is not in the group. It is
      // unauthenticated, so not `#onRemovedSelf`: re-secure now (the gate
      // holds) and rejoin fresh, as the join-intent 404 and receiver lag do.
      console.warn("[mls] gap refetch: not a member of the call group");
      this.#resecureAndRejoin(
        "gap refetch: the delivery service does not list this device",
        "rejoin_fresh:refetch_not_member",
      );
      return;
    }
""",
        replace="""    const res = await this.#deps.bridge.mlsFetchCommits(groupId, fromEpoch);
""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="refetch-404-as-caught-up",
        what="a gap refetch the DS answered 404 returns as if caught up: nothing re-secures, nothing rejoins, and the envelope is dropped from the drain unacked — the device goes on publishing at an epoch the group has left",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by A1, A4b, C9 and E1
        # (4 of 33).
        search="""      console.warn("[mls] gap refetch: not a member of the call group");
      this.#resecureAndRejoin(
        "gap refetch: the delivery service does not list this device",
        "rejoin_fresh:refetch_not_member",
      );
      return;
""",
        replace="""      return;
""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="refetch-failure-uncounted",
        what="the `gap_refetch` arm ignores a FAILED refetch: the mailbox envelope is neither acked nor re-queued, so it sits until something else happens to drain, and the park bound it should count against never escalates",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by A2 and A3 (2 of 33).
        search="""        if (await this.#gapRefetchFailed(envelope, action.fromEpoch))
          this.#scheduleRetry(envelope);
""",
        replace="""        await this.#gapRefetchFailed(envelope, action.fromEpoch);
""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="refetch-short-ok-as-caught-up",
        what="an `ok` refetch whose page stops short of `current_epoch` is taken as caught up (LDP-m3), so the envelope that asked for it is dropped from the drain with the group still ahead",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by A3 (1 of 33): its
        # short-`ok` leg.
        search="""    if (reached < res.body.current_epoch) {""",
        replace="""    if (false && reached < res.body.current_epoch) {""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="refetch-group-capture-removed",
        what="`#gapRefetchInline` re-reads nothing after its awaits: a refetch that settles after its group was replaced acts on the NEW group — its failure retries the old group's envelope into the new one, and its commits and verdicts land there",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by A5 alone (1 of 33).
        # All four post-await group checks, each reduced to its terminal
        # check — i.e. the capture is gone. The two 4-space copies are
        # identical, so each is matched with a neighbouring CODE line.
        # 🔴 A5 drives the CATCH's check (a failure settling after the group
        # was replaced). The three checks on the `ok` path are dropped with
        # it but have no case of their own: not measured separately.
        search="""    } catch (error) {
      if (this.#terminal() || this.#groupId !== groupId) return;
      if (classifyRefetchFailure(error) === "transient") throw error;""",
        replace="""    } catch (error) {
      if (this.#terminal()) return;
      if (classifyRefetchFailure(error) === "transient") throw error;""",
        also=[
            (
                """    if (this.#terminal() || this.#groupId !== groupId) return;
    if (res.kind === "feature_disabled") {""",
                """    if (this.#terminal()) return;
    if (res.kind === "feature_disabled") {""",
            ),
            (
                """      if (this.#terminal() || this.#groupId !== groupId) return;
      await this.#consume(this.#synthEnvelope(info)); // INLINE (we hold the lock)
    }
    if (this.#terminal() || this.#groupId !== groupId) return;""",
                """      if (this.#terminal()) return;
      await this.#consume(this.#synthEnvelope(info)); // INLINE (we hold the lock)
    }
    if (this.#terminal()) return;""",
            ),
        ],
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    # ---- the drain's backstop (LD-D4, LDP-M4) ---------------------------------
    Mutation(
        id="pump-catch-removed",
        what="`#pump` has no per-envelope catch again: one throwing drain step escapes as an unhandled rejection (group id and all, into Sentry), and the rest of the batch waits for the next enqueue",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by B1, B2 and B3 (3 of
        # 33), each on the escaped rejection.
        search="""            try {
              await this.#consume(env);
            } catch (error) {
              // Backstop (LD-D4): one throwing step never escapes the pump
              // as an unhandled rejection, and never stops the batch.
              this.#onDrainStepThrew(env, error);
            }
""",
        replace="""            await this.#consume(env);
""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="pump-catch-breaks-batch",
        what="the per-envelope catch ends the pump instead of moving on, so one throwing step strands every envelope queued behind it until something else enqueues",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by B1 and B3 (2 of 33).
        # `return`, not `break`: a `break` leaves only the inner loop, and the
        # outer one re-takes the lock and drains on — which is not the defect.
        search="""              this.#onDrainStepThrew(env, error);
""",
        replace="""              this.#onDrainStepThrew(env, error);
              return;
""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="pump-catch-retries-after-ack",
        what="a step that threw AFTER its envelope was acked is retried like any other (LDP-M4): the ack's side effects are not replayable, so the retry acts on a half-applied envelope instead of latching loud at once",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by B3 alone (1 of 33).
        search="""    if (this.#seen.has(envelope.id)) {
      this.#latchLoud(new Error(ENCRYPTION_UNCONFIRMED), "control");
      return;
    }
""",
        replace="",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="drain-retry-cap-removed",
        what="a drain step that keeps throwing is retried forever: `MAX_ENVELOPE_RETRIES` never latches, so the call sits in whatever state the throw left it, with nothing loud",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by B2 alone (1 of 33).
        search="""    if (retries >= MAX_ENVELOPE_RETRIES) {
      this.#latchLoud(new Error(ENCRYPTION_UNCONFIRMED), "control");""",
        replace="""    if (false && retries >= MAX_ENVELOPE_RETRIES) {
      this.#latchLoud(new Error(ENCRYPTION_UNCONFIRMED), "control");""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    # ---- the Welcome currency check (W2-M2, LD-D5 as folded) ------------------
    Mutation(
        id="welcome-currency-skipped",
        what="the adopt block goes active on the Welcome alone and records no currency check — the pre-fix code: a late-drained Welcome sealed to an earlier intent is green at its stale epoch (L14c)",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by 24 of 33: B3, C1,
        # C1b, C1r, C2, C2b, C3, C3b, C4, C6, C7, C7b, C8, C9, D1, and all
        # nine fix-pass cases (R1a, R1b, R1c, C1r+, E1, E2, E3, E4, N1).
        # Re-anchored at the merge fix pass (2026-09-27, MFG). MWA-m1 moved
        # the currency record, with the `welcomeAdopted` stamp and the
        # `#joinedGeneration` write, inside `if (this.#resumeAdopting !==
        # outcome.group_id)`, so the block is 8-space indented and the old
        # search matched nothing. Same edit, same site: an ordinary Welcome
        # (the only kind that records the check) goes active instead.
        # Re-measured: killed by the same 24 of 33, and by 4 of 68 resume
        # cases ((w) tail non-ok and short, (z18), (z19)).
        search="""        this.#welcomeCurrency = {
          groupId: outcome.group_id,
          epoch: outcome.epoch,
          generation: this.#establishGeneration,
        };""",
        replace="""        this.#toActive();""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="welcome-active-before-currency",
        what="the adopt block goes active AND records the check, so the session is green — and the enable can empty the gate — before the DS has said whether the Welcome is current",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by 17 of 33: C1, C1r, C3,
        # C3b, C4, C6, C7, C8, C9, R1a, R1b, R1c, C1r+, E1, E2, E3 and E4.
        # Re-anchored at the merge fix pass (2026-09-27, MFG), for the reason
        # on `welcome-currency-skipped` above: the block is now 8-space
        # indented inside the `#resumeAdopting` guard. Same edit, same site.
        # Re-measured: killed by 23 of 33, not the 17 above: A1, A2, A3, B3,
        # C1, C1r, C2, C2b, C3, C3b, C4, C6, C7, C8, C9, R1a, R1b, R1c, C1r+,
        # E1, E2, E3 and E4. Also red in escape, heal, joinrace, resecure,
        # resume (13 of 68), serveguard and timeline.
        search="""        this.#welcomeCurrency = {
          groupId: outcome.group_id,
          epoch: outcome.epoch,
          generation: this.#establishGeneration,
        };""",
        replace="""        this.#toActive();
        this.#welcomeCurrency = {
          groupId: outcome.group_id,
          epoch: outcome.epoch,
          generation: this.#establishGeneration,
        };""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="welcome-currency-404-kept",
        what="a currency check the DS answers 404 keeps the adoption and goes green, instead of discarding it and rejoining fresh",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by C2 and D1 (2 of 33).
        search="""        if (classifyRefetchFailure(error) === "not_member") {
          this.#welcomeCurrencyRejoin(
            "the delivery service does not list this device",
          );
          return null;
        }""",
        replace="""        if (classifyRefetchFailure(error) === "not_member") {
          this.#toActive();
          return null;
        }""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="currency-transient-rejoins",
        what="a currency check whose transient failures outlast the backoff REJOINS instead of latching loud (LDP-M5): intent + claim + commits added to a DS that is already failing — the 2026-09-06 429 storm's shape",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by C3b alone (1 of 33).
        search="""        if (wait === undefined) {
          this.#welcomeCurrencyLoud("the delivery service did not answer");""",
        replace="""        if (wait === undefined) {
          this.#welcomeCurrencyRejoin("the delivery service did not answer");""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="currency-deadline-removed",
        what="the currency check's own deadline does nothing (LDP-M3): a check the DS never answers holds the session non-active for good, and since `#joinedGeneration` disarmed the enrolment backstop, nothing ends it loud",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by C6 alone (1 of 33).
        search="""      check.expired = true;
      check.wake?.();
      this.#welcomeCurrencyLoud("the check reached its deadline");""",
        replace="""      void check;""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="currency-record-not-cleared",
        what="the pending currency record outlives its check (LDP-M3), so `#pump` re-runs the check after every later envelope — a GET per commit for the rest of the call, each one able to re-secure a healthy session",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by 7 of 33: A1, A2, A3,
        # B3, C4, C9 and D1.
        search="""      if (this.#welcomeCurrency === pending) this.#welcomeCurrency = null;
""",
        replace="",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="currency-generation-unchecked",
        what="a currency check whose establish generation was superseded under it still acts: its late verdict goes active, rejoins or latches against the NEW generation's join",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by C8 alone (1 of 33).
        search="""      this.#groupId === check.pending.groupId &&
      this.#establishGeneration === check.pending.generation
    );""",
        replace="""      this.#groupId === check.pending.groupId
    );""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="currency-native-verdict-skipped",
        what="a catch-up is taken as landed without asking native (LDP-M6): commits the drain applied short, or not at all, still go green at the DS's epoch",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by C1b alone (1 of 33).
        search="""        caughtUp =
          state.epoch === currentEpoch &&""",
        replace="""        caughtUp =
          true ||
          state.epoch === currentEpoch &&""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="currency-not-owner",
        what="a currency check in flight no longer owns a re-securing, so the backstop latches loud at its first bound while the check is still waiting on the DS — a false red over a join about to go green",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by C9 alone (1 of 33).
        search="""    if (this.#welcomeCurrencyCheck !== null) return true;
""",
        replace="",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    # ---- LD3-R1: the caught-up key before the enable --------------------------
    Mutation(
        id="catchup-activates-before-key-install",
        what="a catch-up goes active and kicks the enable with no install of the confirmed epoch's keys (the code LD5 stopped on), so when the catch-up applied a Remove the gate empties under the Welcome epoch's send key — one the removed member still holds (locked decision 3) — and the caught-up keys arrive only after",
        file=SESSION,
        # Measured at LD7 (24 cases): C1r alone, at its sampled gate monitor
        # (`staleGreens`). Re-measured 2026-09-26 (fix pass 1): killed by 6 of
        # 33: C1r, R1a, R1b, R1c, C1r+ and E2.
        # Kept beside `catchup-install-reorder` below rather than replaced by
        # it: this is the install SKIPPED outright, that one the install run
        # AFTER going active — two defects, each with its own kill.
        # 🔴 One other form was MEASURED and is not an entry: dropping the
        # `#lastInbound` memo clear in `#installCaughtUpKeys`. At LD7 it was
        # killed by C1 and C1r on the LOUD path (the install takes Add-grace,
        # `installed` reads false, the check latches — fail-closed, not this
        # defect). Re-measured at fix pass 1: killed by 7 of 33 (C1, C1r, R1a,
        # R1b, R1c, C1r+, E2); the path was not re-diagnosed.
        search="""      const installed = await this.#installCaughtUpKeys(groupId, currentEpoch);""",
        replace="""      const installed = true;""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    # ---- fix pass 1: LDA-M1, LDA-m1, LDA-m2, LDA-n1 ---------------------------
    #
    # Each entry below was SURVIVING (or had no case) at the audit; the drain
    # spec's R1*/C1r+/E*/N1 cases were written to kill it, and each count is
    # measured, not inferred.
    #
    # 🔴 KNOWN NON-ENTRY: the `#ownSendKeyEpoch` assignment in the Add-grace
    # timer's fire (`#scheduleGraceLocal`). Dropping it can only make
    # `#installCaughtUpKeys` read false and latch LOUD: a false red, never a
    # stale-key green. Measured 2026-09-26: the drain spec stays 33/33 green
    # under it (LDF3 proved it vacuous the same way). A must-red entry on it
    # would pin a failure mode that fails closed, so there is none.
    Mutation(
        id="catchup-install-reorder",
        what="a catch-up goes active BEFORE the confirmed epoch's keys install (LDA-m1): the install still runs, but while it is pending the session is green and the enable can empty the gate under the Welcome epoch's send key — one a member the catch-up removed still holds (locked decision 3)",
        file=SESSION,
        # At LD7 this form SURVIVED (the install landed before the kicked
        # enable). The harness's `holdKeyInstall` now keeps it pending.
        # Measured 2026-09-26 (fix pass 1): killed by 4 of 33: R1b, R1c,
        # C1r+ and E2.
        search="""      const installed = await this.#installCaughtUpKeys(groupId, currentEpoch);""",
        replace="""      this.#toActive();
      const installed = await this.#installCaughtUpKeys(groupId, currentEpoch);""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="own-send-key-epoch-unchecked",
        what="the caught-up install is judged on the install counter and the fence alone, not on OUR send key's epoch (LDA-M1, FA-B1): an install that left our send key on the older epoch still reads as installed, and the session — a late-drained Welcome's catch-up, or a resume — goes green publishing under a key a removed member holds",
        file=SESSION,
        # Measured 2026-09-26 (fix pass 1): killed by E2 alone (1 of 33).
        # 🔴 FOLDED at the merge wave (2026-09-27). The rejoin-resume branch
        # carried `resume-own-key-epoch-unchecked`, the same search (plus a
        # final newline) and the same replace against its verbatim copy of
        # `#installCaughtUpKeys`. The merge kept ONE body with two callers
        # (`#confirmWelcomeCurrency` and the resume's `#catchUp`), so the
        # two ids mutated one line; they are one entry now, pinned on both
        # specs, and each spec was measured to kill it ON ITS OWN: drainfail
        # E2 (1 of 33), resume (u) "FA-B1, LDA-M1" (1 of 63).
        search="""      this.#installEpoch === epoch &&
      this.#ownSendKeyEpoch === epoch
    );""",
        replace="""      this.#installEpoch === epoch
    );""",
        specs=[DRAINFAIL_SPEC, RESUME_SPEC],
        must_red=[DRAINFAIL_SPEC, RESUME_SPEC],
    ),
    Mutation(
        id="currency-expired-flag-dropped",
        what="a re-secure started from inside a currency check (its own catch-up hit a 404) no longer expires the check (LDA-m2), so the check resumes after the rejoin was scheduled and goes active on the discarded adoption",
        file=SESSION,
        # Measured 2026-09-26 (fix pass 1): killed by E1 alone (1 of 33).
        search="""    if (this.#welcomeCurrencyCheck) this.#welcomeCurrencyCheck.expired = true;
""",
        replace="",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="currency-failed-term-dropped",
        what="a currency check on a `failed` session may still act (LDA-m2): a Welcome from an earlier intent, adopted late after the session failed, runs its check and can revive the failed session",
        file=SESSION,
        # Measured 2026-09-26 (fix pass 1): killed by E3 alone (1 of 33).
        search="""      !this.#terminal() &&
      this.#state !== "failed" &&
""",
        replace="""      !this.#terminal() &&
""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="synthetic-retry-guard-dropped",
        what="a synthetic envelope's failed refetch is re-queued like a mailbox envelope (LDA-m2) instead of going back to the inline caller that fed it (the currency check's catch-up), which then never learns its catch-up failed and does not end loud",
        file=SESSION,
        # Measured 2026-09-26 (fix pass 1): killed by E4 alone (1 of 33).
        search="""      if (envelope.id.startsWith("mls-synth:")) throw error;
""",
        replace="",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="dispose-wake-dropped",
        what="`dispose` no longer wakes a currency check in its backoff wait (LDA-n1): the wait's timer is cleared, so the pump continuation never settles on a closed session",
        file=SESSION,
        # Measured 2026-09-26 (fix pass 1): killed by N1 alone (1 of 33).
        # 🔴 N1 is a PROXY: it observes that the check's deadline timer is
        # cleared after dispose, not the never-settling pump promise itself,
        # which the harness cannot see.
        search="""    this.#welcomeCurrencyCheck?.wake?.();
""",
        replace="",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    # ---- the pure rules (LD1), one entry per rule -----------------------------
    Mutation(
        id="refetch-404-anchor-dropped",
        what="the 404 match is unanchored, so any refetch failure whose message merely CONTAINS 404 — a group id, an epoch, a 5xx body — is read as 'not a member' and tears the call down into a fresh rejoin",
        file=REFETCH_POLICY,
        # Measured 2026-09-26: killed by 4 of 39: the three anchor cases and the
        # non-MLS transport's 404.
        search=r"""const NOT_MEMBER_MESSAGE = /^E2EE MLS \S+ \S+ failed: 404$/;""",
        replace=r"""const NOT_MEMBER_MESSAGE = /404/;""",
        specs=[REFETCH_POLICY_SPEC],
        must_red=[REFETCH_POLICY_SPEC],
    ),
    Mutation(
        id="currency-contiguity-dropped",
        what="a currency page is accepted on its LENGTH alone, so a page with a gap or a duplicate epoch reads `catch_up` and the session applies a history that does not lead to the DS's epoch",
        file=REFETCH_POLICY,
        # Measured 2026-09-26: killed by 4 of 39: the duplicate, gap,
        # out-of-order and starts-at-the-Welcome cases.
        search="""    commits.length === lag &&
    commits.every((commit, index) => commit.epoch === welcomeEpoch + 1 + index)""",
        replace="""    commits.length === lag""",
        specs=[REFETCH_POLICY_SPEC],
        must_red=[REFETCH_POLICY_SPEC],
    ),
    Mutation(
        id="currency-stale-welcome-as-current",
        what="a Welcome AHEAD of the DS's current epoch (`currentEpoch < welcomeEpoch`) reads `current`, so an adoption the DS has no history for goes green",
        file=REFETCH_POLICY,
        # Measured 2026-09-26: killed by 2 of 39: the two DS-behind-the-Welcome
        # cases.
        # Not a deletion: deleting the line is equivalent (non-entry (a) in
        # the block note).
        search="""  if (currentEpoch < welcomeEpoch) return "rejoin";""",
        replace="""  if (currentEpoch < welcomeEpoch) return "current";""",
        specs=[REFETCH_POLICY_SPEC],
        must_red=[REFETCH_POLICY_SPEC],
    ),
]


# --- Rejoin resume, wave 1: fleet, group scoping, inbound buffer -------------
#
# The harness now models N seats against one delivery service
# (`newFleet`), which is what lets a rejoin served by EVERY member be stated
# at all: the stagger entry below is the defect class the one-seat world could
# not express. The session gained a per-page startup-wipe token dep and a
# group-scope check at the head of `#consume`; the bridge gained a pure pre-sink
# hold for MLS envelopes (`components/client/mlsInboundBuffer.ts`). Each entry
# is judged on the ONE spec that owns it, and `must_red` on that spec alone.

MUTATIONS += [
    # ---- the fleet --------------------------------------------------------
    #
    # The fire-time §4.8 re-check alone now has its own single-edit entry,
    # `fire-time-recheck-removed` (wave 1.5, below), killed by the fleet case
    # that replays a stale rejoin intent after the re-add. What held it back in
    # wave 1 — a serve at leaf >= 6 kicking the re-seated member at REAL
    # constants (fleet F4 finding, 2026-09-25) — was a live defect, and wave
    # 1.5's epoch-keyed `#removedAtEpoch` guard is its fix.
    #
    # 🔴 That guard closes the whole class this entry models, so the entry
    # carries a THIRD edit that bypasses it (W15P-M3); without it this would no
    # longer be the defect. Measured 2026-09-25 under the ORIGINAL two-edit
    # form (the short retry and the fire-time block gone, the guard intact):
    # every no-kick assertion in the fleet spec holds, the stagger proof
    # included — the guard alone refuses the serve, which is the parked-wave
    # class closed. The fleet spec still goes red, but only on three timeline
    # PRECONDITIONS the 1 500 ms retry moves, none of them a kick: "leaf 6
    # watching PEER leave and rejoin…" (`not between the two`), "a second
    # rejoin intent while a member's own Remove is in flight…" (`PEER's re-add
    # had not landed`) and "a stale rejoin intent sent AFTER the re-add…"
    # (`every member refused at schedule time`). So the two-edit form gets no
    # entry: it is not green, and its red is not the defect.
    Mutation(
        id="rejoin-stagger-refire",
        what="a higher leaf's staggered rejoin serve fires after the live member was re-seated and stages a Remove of it — the Welcome wait short enough for the re-add to land inside the stagger, the fire-time §4.8 re-check gone, and the removed-at-epoch guard bypassed",
        file=SESSION,
        # ALL THREE edits, in one entry (see `also` on the dataclass). The
        # third bypasses the removed-at-epoch guard at its one decision point,
        # which serves both its early exit and its check under the lock.
        search="""const JOINER_RETRY_MS = 10_000;""",
        replace="""const JOINER_RETRY_MS = 1_500;""",
        also=[
            (
                """    // §4.8 re-check at FIRE time (the stagger can outlast the schedule-time
    // check): a re-add that landed during our delay makes this serve stale.
    if (
      rejoinServeAction({
        addedAtMs:
          this.#recentAdds.get(`${request.user_id}:${request.device_id}`) ??
          null,
        nowMs: Date.now(),
      }) === "refuse_recent_add"
    ) {
      return;
    }
""",
                "",
            ),
            (
                """    if (serveTargetStillStale({ scheduledAtEpoch, removedAtEpoch })) {""",
                """    if (true) {""",
            ),
        ],
        specs=[FLEET_SPEC],
        must_red=[FLEET_SPEC],
    ),
    Mutation(
        id="wipe-token-dep-ignored",
        what="the session spends the module-level startup-wipe token instead of its page's own, so a reloaded page shares one Set with every other session and skips the wipe its fresh page owes",
        file=SESSION,
        # Re-anchored 2026-09-27 (MFR-m1 fix pass, MRG): the search now
        # carries its line's indentation, the one entry the start-of-line
        # rule in `apply` refused. Same line, same edit; re-measured killed
        # by the same 2 of 31 fleet cases ("each page has its own
        # startup-wipe token", "no lockout").
        search="""    const tokens = this.#deps.startupWipeTokens ?? startupWipedChannels;
""",
        replace="""    const tokens = startupWipedChannels;
""",
        specs=[FLEET_SPEC],
        must_red=[FLEET_SPEC],
    ),
    # ---- group scoping ------------------------------------------------------
    Mutation(
        id="group-scope-check-removed",
        what="an envelope for a group other than the live one runs the live group's arms — a drained removed-self, successor or gap for a group we left transitions, refetches or acks against OUR call",
        file=SESSION,
        search="""      envelope.group_id !== liveGroup
    ) {""",
        replace="""      false
    ) {""",
        specs=[GROUPSCOPE_SPEC],
        must_red=[GROUPSCOPE_SPEC],
    ),
    Mutation(
        id="ctl-exempt-from-scope",
        what="`mls_ctl` joins the Welcome exemption from group scoping, so another group's ctl-announce skips the check and drives OUR mode machine",
        file=SESSION,
        search="""      envelope.content_type !== "mls_welcome" &&
""",
        replace="""      envelope.content_type !== "mls_welcome" &&
      envelope.content_type !== "mls_ctl" &&
""",
        specs=[GROUPSCOPE_SPEC],
        must_red=[GROUPSCOPE_SPEC],
    ),
    # ---- the inbound buffer -------------------------------------------------
    Mutation(
        id="inbound-commit-routes-olm",
        what="`inboundRoute` sends `mls_commit` to the Olm path, so a drained commit is decrypted as Olm, fails, and is acked away before the call that needed it exists",
        file=INBOUND_BUFFER,
        # The case label dropped whole (newline included), so `mls_commit`
        # falls through to `default` and the mutant is still well-formed TS.
        search="""    case "mls_commit":
""",
        replace="",
        specs=[INBOUND_BUFFER_SPEC],
        must_red=[INBOUND_BUFFER_SPEC],
    ),
    Mutation(
        id="inbound-drain-empty",
        what="`drain()` empties the hold and hands the sink nothing, so every envelope held before the session registered is lost locally while still queued server-side",
        file=INBOUND_BUFFER,
        search="""    return held;""",
        replace="""    return [];""",
        specs=[INBOUND_BUFFER_SPEC],
        must_red=[INBOUND_BUFFER_SPEC],
    ),
    Mutation(
        id="inbound-dedup-removed",
        what="the hold keeps a repeated envelope id twice, so a live push that the connect-time drain repeats reaches the session twice",
        file=INBOUND_BUFFER,
        search="""    if (this.#ids.has(id)) return "duplicate";
""",
        replace="",
        specs=[INBOUND_BUFFER_SPEC],
        must_red=[INBOUND_BUFFER_SPEC],
    ),
]


# --- Rejoin resume, wave 1.5: the stagger kick -------------------------------
#
# In a call of seven or more, the member at leaf >= 6 fires its staggered
# rejoin serve after the rejoiner's re-add, and the fire-time §4.8 check reads
# add observations a non-admitting member only records on its periodic
# reconcile — so it removed the live, re-seated member. The fix is a monotonic
# epoch-keyed fact: `#removedAtEpoch` (the highest epoch at which a commit of
# the live group removed each identity), written from every inbound commit and
# from this member's own won Removes, cleared only with every scheduled serve,
# and read UNDER the lock by `serveTargetStillStale` immediately before the
# serve stages its Remove. Each entry below breaks one leg of that argument
# and is `must_red` on the spec that owns the case proving the leg; which
# fleet case kills which entry is recorded on the entry.

MUTATIONS += [
    # ---- the fact's writers -------------------------------------------------
    Mutation(
        id="removed-at-epoch-not-recorded",
        what="inbound commits no longer record the identities they removed, so a member that did not win the Remove has no fact to refuse a late serve with, and leaf >= 6 kicks the re-seated member again",
        file=SESSION,
        # Killed by the phase sweep (14 of its phases), the eight-member case,
        # the leave-and-return case and the lock-race case.
        search="""    if (outcome.group_id === this.#groupId) {
      this.#noteRemovedAtEpoch(outcome.removed, outcome.epoch);
    }
""",
        replace="",
        specs=[FLEET_SPEC],
        must_red=[FLEET_SPEC],
    ),
    Mutation(
        id="own-won-remove-not-recorded",
        what="a member's OWN won Remove is not recorded (it never comes back inbound), so a second serve it armed while that Remove was in flight, anchored before it, removes the re-seated member",
        file=SESSION,
        # Killed by the case with a second rejoin intent while the member's
        # own Remove is in flight.
        search="""          if (kind === "remove" && groupId === this.#groupId) {
            this.#noteRemovedAtEpoch(commit.removed, commit.epoch);
          }
""",
        replace="",
        specs=[FLEET_SPEC],
        must_red=[FLEET_SPEC],
    ),
    Mutation(
        id="removed-at-epoch-deleted-on-leave",
        what="a participant leaving the SFU deletes its removed-at-epoch fact, so a rejoiner seen leaving and returning between its Remove and its re-add is served again by a late stagger",
        file=SESSION,
        # Killed by the case where leaf 6 watches PEER leave and rejoin the
        # SFU between its Remove and its re-add.
        search="""    this.#rejoinServed.delete(identity); // nor a pending re-Add
""",
        replace="""    this.#rejoinServed.delete(identity); // nor a pending re-Add
    this.#removedAtEpoch.delete(identity);
""",
        specs=[FLEET_SPEC],
        must_red=[FLEET_SPEC],
    ),
    # ---- the check ----------------------------------------------------------
    Mutation(
        id="serve-stale-check-bypassed",
        what="`serveTargetStillStale` always answers stale, so every late serve removes whatever leaf it finds — the fresh re-add included",
        file=REJOIN_POLICY,
        search="""  return i.removedAtEpoch === null || i.removedAtEpoch <= i.scheduledAtEpoch;""",
        replace="""  return true;""",
        # Both, each on its own: the policy spec pins the rule, and the fleet
        # (phase sweep, eight-member, leave-and-return, own-Remove-in-flight
        # and lock-race cases) proves the session's decision rests on it.
        specs=[REJOIN_POLICY_SPEC, FLEET_SPEC],
        must_red=[REJOIN_POLICY_SPEC, FLEET_SPEC],
    ),
    Mutation(
        id="stale-check-outside-lock",
        what="only the early exit before the roster read checks the fact, not the check inside the Remove's build step under the lock — a serve whose drain applies the Remove AND the re-add while it waits for the lock removes the fresh leaf",
        file=SESSION,
        # The in-`build` copy alone (8-space indent, trailing ` {`); the
        # early exit (` return;`) is kept. Killed by the lock-race case.
        search="""        if (this.#serveTargetFresh(request, scheduledAtEpoch)) {
          throw Object.assign(new Error("mls_serve_target_fresh"), {
            type: "mls_serve_target_fresh",
          });
        }
""",
        replace="",
        specs=[FLEET_SPEC],
        must_red=[FLEET_SPEC],
    ),
    # ---- the old §4.8 belt --------------------------------------------------
    Mutation(
        id="fire-time-recheck-removed",
        what="the fire-time §4.8 re-check is gone, so a stale rejoin re-broadcast arriving AFTER the re-add — anchored after the Remove, which the removed-at-epoch guard therefore cannot refuse — is served by every member that observed the re-add only while its stagger ran, and the re-seated member is removed",
        file=SESSION,
        # The single edit wave 1 could not give a killer to. Killed by the
        # case that replays a stale rejoin intent after the re-add.
        search="""    // §4.8 re-check at FIRE time (the stagger can outlast the schedule-time
    // check): a re-add that landed during our delay makes this serve stale.
    if (
      rejoinServeAction({
        addedAtMs:
          this.#recentAdds.get(`${request.user_id}:${request.device_id}`) ??
          null,
        nowMs: Date.now(),
      }) === "refuse_recent_add"
    ) {
      return;
    }
""",
        replace="",
        specs=[FLEET_SPEC],
        must_red=[FLEET_SPEC],
    ),
]


# --- Rejoin resume, wave 1.5 fix pass: the serve's other legs ----------------
#
# The guard's anchor, and what a serve does once it holds the lock. A serve
# that has fired gets past every check made outside the lock and then waits
# for it; three checks run in the Remove's `build`, immediately before
# `callRemove`, and each refuses a case the other two cannot see
# (`mlsCallSession.serveguard.test.ts` holds one case per check). Only a serve
# that passes all three notes a served rejoin and warns that it is removing.

MUTATIONS += [
    # ---- the anchor ---------------------------------------------------------
    Mutation(
        id="serve-anchor-zero",
        what="a serve is anchored at epoch 0 instead of the epoch that showed the stale leaf, so once a device has been removed ONCE every later serve for it reads that old Remove as newer, is refused, and the device's next wipe-rejoin is never served — locked out of the call's encryption",
        file=SESSION,
        # The other direction of the removed-at-epoch guard: the wave-1.5
        # entries above that break it make it refuse too little, this one
        # too much. Killed by the no-lockout case (a second wipe-rejoin after
        # a settled first).
        search="""      scheduledAtEpoch = state.epoch;
""",
        replace="""      scheduledAtEpoch = 0;
""",
        specs=[FLEET_SPEC],
        must_red=[FLEET_SPEC],
    ),
    # ---- the checks under the lock ------------------------------------------
    Mutation(
        id="serve-generation-check-removed",
        what="a serve waiting on the lock across a re-entry into the SAME group id is not refused on the establish generation: the reset cleared the removed-at-epoch facts, so the re-entry's leaf for the target reads as stale and is removed",
        file=SESSION,
        # The in-`build` generation refusal alone, anchored on its log line
        # (the group check below throws the same error). Killed by the
        # serve-guard re-entry case.
        search="""        if (scheduledGeneration !== this.#establishGeneration) {
          console.info("[mls] serve was scheduled for an earlier establish", {
            target: `${request.user_id}:${request.device_id}`,
            scheduledGeneration,
            liveGeneration: this.#establishGeneration,
          });
          throw Object.assign(new Error("mls_serve_target_fresh"), {
            type: "mls_serve_target_fresh",
          });
        }
""",
        replace="",
        specs=[SERVEGUARD_SPEC],
        must_red=[SERVEGUARD_SPEC],
    ),
    Mutation(
        id="serve-group-check-removed",
        what="a serve that builds between a reset and the next establish (`#groupId` moved, the generation not yet bumped) is not refused on the group, and goes on to stage a Remove against whatever group is live",
        file=SESSION,
        # The in-`build` group refusal alone, anchored on its log line; the
        # early exit's `request.group_id !== this.#groupId` outside the lock
        # is kept. Killed by the serve-guard reset-gap case.
        search="""        if (request.group_id !== this.#groupId) {
          console.info("[mls] serve was scheduled for another group", {
            target: `${request.user_id}:${request.device_id}`,
            group: request.group_id,
            liveGroup: this.#groupId,
          });
          throw Object.assign(new Error("mls_serve_target_fresh"), {
            type: "mls_serve_target_fresh",
          });
        }
""",
        replace="",
        specs=[SERVEGUARD_SPEC],
        must_red=[SERVEGUARD_SPEC],
    ),
    # ---- what only a staging serve does -------------------------------------
    Mutation(
        id="serve-note-outside-lock",
        what="a serve notes the served rejoin and warns that it is removing BEFORE it takes the lock, so one the check under the lock then refuses has already extended the target's admit-grace and logged a removal it never staged",
        file=SESSION,
        # Two edits: the note and the warning leave the `build` closure and
        # go back ahead of `#stageAndSubmit`, where they sat before the fix.
        # Killed by the serve-guard epoch case (the probe sees the note) and
        # by the fleet's lock-race case (the warning at fire time).
        search="""        // From here the device is CONNECTED and about to be MLS-absent until
        // its next intent lands an Add: keep it pending across that gap (the
        // other members learn the same thing from the roster diff in
        // `#reconcileOnce`). Only a serve that goes on to stage notes it: a
        // refused one removes nothing, so it must extend no admit-grace.
        this.#noteRejoinServed(
          `${request.user_id}:${request.device_id}`,
          Date.now(),
        );
        console.warn(
          `[mls] removing stale leaf for rejoin: ${request.user_id}:${request.device_id}`,
        );
""",
        replace="",
        also=[
            (
                """    this.#stagingFor = `${request.user_id}:${request.device_id}`;
    try {
      await this.#stageAndSubmit(async () => {
""",
                """    this.#noteRejoinServed(
      `${request.user_id}:${request.device_id}`,
      Date.now(),
    );
    console.warn(
      `[mls] removing stale leaf for rejoin: ${request.user_id}:${request.device_id}`,
    );
    this.#stagingFor = `${request.user_id}:${request.device_id}`;
    try {
      await this.#stageAndSubmit(async () => {
""",
            ),
        ],
        specs=[SERVEGUARD_SPEC, FLEET_SPEC],
        must_red=[SERVEGUARD_SPEC, FLEET_SPEC],
    ),
]


# --- Rejoin resume, wave 2: the resume foundations ---------------------------
#
# Wave 2 was inert in the session (`resumePrefetch` was accepted and ignored
# until wave 3, whose entries follow this block), so what is measured here is
# the three pure modules wave 3 stands on, each loadable, so each rule is
# reachable: `resumeDecision` and `recencyValid` in `mlsRejoinPolicy.ts` (the
# go/no-go and the recency record's validity); `KeptLocalGroups` and
# `prefetchResume` in `components/client/mlsResumeKeep.ts` (keep, claim,
# hand-back, cleanup, and the read-only prefetch); and `mlsHoldVerdict` in
# `mlsInboundBuffer.ts` (what the bridge does with an MLS envelope before a
# sink exists). Every entry is
# `must_red` on the ONE spec that owns its rule. The bridge (`e2ee.ts`) and
# host (`state.tsx`) wiring cannot be loaded by `node --test` and has no
# entry.

MUTATIONS += [
    # ---- resumeDecision ------------------------------------------------------
    #
    # Rules 2 to 8, 9's upper bound, and 10's length check and contiguity
    # each have an entry (6, 8, 9's upper bound and 10's length since the
    # wave-2 fix pass, audit W2-m3). NOT entered here, and not claimed to be
    # measured by this table: rule 1 (`p === null`). Dropping it does not
    # resume anything: the next rule to read `p` throws on `null`, so the
    # mutant is a crash in the caller, not the defect the rule exists for.
    Mutation(
        id="resume-ignores-open-group",
        what="`resumeDecision` drops rule 4, so a resume proceeds whatever group the DS's open-group GET names, or none at all — the DS verdict the resume rests on (D2) is never consulted, and a moved or hostile DS's answer is resumed over",
        file=REJOIN_POLICY,
        # The rule's line dropped whole (newline included) so the mutant is
        # still well-formed TS.
        search="""  if (!(p.openGroupId !== null && p.openGroupId === p.groupId)) return "join";
""",
        replace="",
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    Mutation(
        id="resume-ignores-pending-commit",
        what="`resumeDecision` drops rule 7, so a device with its own commit still pending natively resumes, and the next inbound commit poisons the group it just resumed (audit B3)",
        file=REJOIN_POLICY,
        search="""  if (p.pendingCommit !== null) return "join";
""",
        replace="",
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    Mutation(
        id="resume-ignores-startup",
        what="`resumeDecision` drops rule 2, so a rejoin-fresh, poisoned-successor or re-upgrade establish — all sharing the 409/rejoin route — adopts held state instead of re-enrolling (audit M6, R2-m7)",
        file=REJOIN_POLICY,
        search="""  if (!isStartup) return "join";
""",
        replace="",
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    Mutation(
        id="resume-ignores-prefetch-age",
        what="`resumeDecision` drops rule 3 on BOTH sides, so a prefetch of any age resumes — one gathered before a long stall, or one a clock that ran backwards makes read as from the future — on a DS verdict that may be long stale (R2-m1)",
        file=REJOIN_POLICY,
        # Both lines, so no dead `ageMs` is left behind.
        search="""  const ageMs = nowMs - p.fetchedAtMs;
  if (!(ageMs >= 0 && ageMs <= LOCAL_GROUP_KEEP_MS)) return "join";
""",
        replace="",
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    Mutation(
        id="resume-ignores-channel-binding",
        what="`resumeDecision` drops rule 5, so a resume is bound to neither the channel the GET was made for nor the channel native holds the group for — a group held for one channel is resumed into another (the T-15 binding on this route, R2-m1)",
        file=REJOIN_POLICY,
        # Rule 5 is TWO lines and the entry drops both (see `also`): the
        # defect its name states is the binding gone. Measured 2026-09-26 on
        # a copy of the tree: dropping EITHER line alone is also red on the
        # policy spec (one failing case each), so neither half is unpinned —
        # but this entry cannot see a future spec edit that loses one half's
        # case while keeping the other's.
        search="""  if (p.queriedChannelId !== intendedChannelId) return "join";
""",
        replace="",
        also=[
            (
                """  if (p.localChannelId !== intendedChannelId) return "join";
""",
                "",
            ),
        ],
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    Mutation(
        id="resume-ignores-contiguity",
        what="`resumeDecision` keeps rule 10's length check but drops its contiguity loop, so a commit list of the right LENGTH is accepted whatever epochs it carries — a hostile DS padding or reordering the list passes on the count alone (R-W2-5)",
        file=REJOIN_POLICY,
        # The LOOP, not the length check: the length check alone is the
        # pre-R-W2-5 rule, and dropping it too would measure a different
        # (grosser) defect under this name.
        search="""  for (let i = 0; i < p.commits.length; i++) {
    if (p.commits[i].epoch !== p.localEpoch + 1 + i) return "join";
  }
""",
        replace="",
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    # ---- resumeDecision, the wave-2 fix pass (audit W2-m3) -------------------
    #
    # The four rules the wave-2 table left unpinned. The auditor killed each
    # by hand; these entries make that a standing measurement.
    Mutation(
        id="resume-ignores-local-state",
        what="`resumeDecision` drops rule 6, so a group native holds as POISONED, or one whose own roster no longer names this device, is resumed — a device the group removed adopts it as if it were still a member",
        file=REJOIN_POLICY,
        # The rule is ONE line with both conjuncts, dropped whole. Measured
        # 2026-09-26 on a copy of the tree: dropping EITHER conjunct alone is
        # also red on the policy spec (one failing case each), so neither half
        # is unpinned.
        search="""  if (!(p.localState === "active" && p.selfInLocalRoster)) return "join";
""",
        replace="",
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    Mutation(
        id="resume-ignores-own-commit",
        what="`resumeDecision` drops rule 8, so a fetched commit this device authored and never merged is accepted for catch-up as though a peer sent it — the other half of audit B3",
        file=REJOIN_POLICY,
        search="""  if (p.commits.some((c) => c.committerIsSelf)) return "join";
""",
        replace="",
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    Mutation(
        id="resume-lag-bound-inclusive",
        what="rule 9's upper bound admits `RESUME_MAX_LAG` itself, so a held group exactly at the lag the live session calls desync is caught up by a resume instead of abandoned for a clean join",
        file=REJOIN_POLICY,
        # The boundary, not the whole bound: `<=` is the smallest edit that
        # breaks it, and the spec's lag-12 case kills it. Dropping the bound
        # outright is grosser and is killed by the same case.
        search="""  if (!(lag >= 0 && lag < RESUME_MAX_LAG)) return "join";""",
        replace="""  if (!(lag >= 0 && lag <= RESUME_MAX_LAG)) return "join";""",
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    Mutation(
        id="resume-ignores-commit-count",
        what="`resumeDecision` drops rule 10's length check and keeps the contiguity loop, so a DS returning FEWER commits than the lag passes as long as the ones it did send are in order — the resume catches up short of the current epoch (audit M4)",
        file=REJOIN_POLICY,
        # The length line alone; `resume-ignores-contiguity` above drops the
        # loop alone. Each half of rule 10 is pinned by its own entry.
        search="""  if (p.commits.length !== lag) return "join";
""",
        replace="",
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    # 🔴 NOT AN ENTRY, and recorded rather than silently absent: dropping
    # `lag >= 0` from rule 9 alone (`lag < RESUME_MAX_LAG` kept). It is an
    # EQUIVALENT mutant — rule 10's `commits.length !== lag` already refuses a
    # negative lag, because no list has a negative length — so every input
    # answers the same and no spec can turn it red (measured by the lane that
    # wrote the spec, 2026-09-25). An entry for it could only ever be
    # `expect="green"`, an admission dressed as a measurement. The conjunct
    # stays in the source as the rule's own statement of intent.
    Mutation(
        id="recency-always-valid",
        what="`recencyValid` answers true for any record — absent, naming another group, or of any age — so a hostile DS can steer a resume into an OLDER group this device still holds, and whatever a dead page left on disk is resumable forever (D7, audit M1)",
        file=REJOIN_POLICY,
        search="""  if (rec === null || rec.groupId !== groupId) return false;
  const ageMs = nowMs - rec.at;
  return ageMs >= 0 && ageMs <= LOCAL_GROUP_KEEP_MS;""",
        replace="""  return true;""",
        specs=[REJOIN_POLICY_SPEC],
        must_red=[REJOIN_POLICY_SPEC],
    ),
    # ---- the kept-group registry --------------------------------------------
    Mutation(
        id="keep-handback-rearms-full-ms",
        what="a handed-back claim re-arms its keep timer for the keep's FULL `ms` from now instead of the time left to its ORIGINAL deadline, so every claim a superseded prefetch hands back stretches the keep, and repeated claims hold a hung-up call's group on disk indefinitely (R2-B1)",
        file=RESUME_KEEP,
        # Two edits: `keep` records its `ms` on the entry, and `handBack`
        # re-arms with it. The past-deadline branch is kept, so this measures
        # the re-arm duration alone. (A literal `10_000` in place of
        # `remaining` would also drop that branch, and — the spec keeps at
        # 5 000 ms — re-arm at twice the keep: a grosser defect than this
        # one's name.)
        search="""    this.#byChannel.set(channelId, entry);
    this.#arm(entry, ms);""",
        replace="""    this.#byChannel.set(channelId, entry);
    (entry as unknown as { ms: number }).ms = ms;
    this.#arm(entry, ms);""",
        also=[
            (
                """        this.#arm(entry, remaining);""",
                """        this.#arm(entry, (entry as unknown as { ms: number }).ms);""",
            ),
        ],
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-release-keeps-entry",
        what="`release` leaves the entry tracked, so a group the session ADOPTED is still deleted under the call — by its keep timer, or by a later hand-back of its claim re-arming that timer (R2-B1 gap 1)",
        file=RESUME_KEEP,
        # Anchored with the comment line above it: `this.#deleteEntries(
        # groupId);` alone also occurs in `keep`, `cleanup` and `#delete`.
        # Rewording that comment hard-errors this entry; it fails loud, never
        # silently.
        search="""    // the group afterwards; a later keep of it starts a fresh entry.
    this.#deleteEntries(groupId);""",
        replace="""    // the group afterwards; a later keep of it starts a fresh entry.
    void groupId;""",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-claim-ignores-inflight",
        what="`claim` grants a group whose cleanup has already started, so a superseding connect resumes a group that is halfway off the disk",
        file=RESUME_KEEP,
        search="""    if (this.isInFlight(entry.groupId)) return null;
""",
        replace="",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-recency-ignores-inflight",
        what="`recencyCandidate` offers a group whose cleanup is in flight, so a resume with no kept entry to claim (a Ctrl+R) adopts a group the native delete is removing",
        file=RESUME_KEEP,
        search="""    if (rec === null || this.isInFlight(rec.groupId)) return null;""",
        replace="""    if (rec === null) return null;""",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-cleanup-keeps-recency",
        what="`cleanup` leaves the group's recency record behind, so a group deleted from disk — by expiry, a superseded or refused keep, discard-all or a leave — is still offered as a recency candidate (R2-B1 gaps 3 and 4)",
        file=RESUME_KEEP,
        search="""      clearResumeRecordsForGroup(this.#deps.storage, groupId);
      await this.#deps.deleteLocal(groupId);""",
        replace="""      await this.#deps.deleteLocal(groupId);""",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="prefetch-abort-no-handback",
        what="the prefetch's abort listener does not hand the claim back, so a superseded connect's claim stays taken: the kept group's timer is never re-armed, the superseding connect cannot claim it, and it is neither resumed nor deleted until the page dies (R2-B1 gap 2)",
        file=RESUME_KEEP,
        search="""    if (claim !== null) deps.kept.handBack(claim.token);""",
        replace="""    void claim;""",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    # ---- the kept-group registry, the wave-2 fix pass ------------------------
    #
    # W2-m3's fifth pin (the prefetch's failure-path cleanup), then the W2-m1 /
    # W2-m2 / F1-R1 changes: `release` reporting an in-flight group,
    # `recencyCandidate` refusing a group a live entry names, `discardChannel`,
    # and `cleanup` handing a later caller the pending delete.
    Mutation(
        id="prefetch-giveup-no-cleanup",
        what="the prefetch's failure path returns `null` without cleaning its candidate, so a group an old shell, a non-ok commits fetch or a failed recency check gave up on stays on disk for the join path's create to trip over (W2-m3)",
        file=RESUME_KEEP,
        # The awaited cleanup line alone; its `try`/`catch` is left with an
        # empty body, which is still well-formed.
        search="""      await deps.kept.cleanup(groupId);
""",
        replace="",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-release-ignores-inflight",
        what="`release` answers true while the group's cleanup is in flight, so an adopter is told the group is its own while the native delete is removing it (W2-m2)",
        file=RESUME_KEEP,
        search="""    return !this.isInFlight(groupId);""",
        replace="""    return true;""",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-recency-ignores-entries",
        what="`recencyCandidate` offers a group a live keep entry still names, so a resume adopts it with no claim and that entry's timer deletes it under the call (W2-m2)",
        file=RESUME_KEEP,
        # The line alone: `#hasEntry(rec.groupId)` also occurs in
        # `discardChannel`, as a ternary, which this window cannot match.
        search="""    if (this.#hasEntry(rec.groupId)) return null;
""",
        replace="",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-discard-channel-skips-claimed",
        what="`discardChannel` cleans only UNCLAIMED entries for the channel, so a group a null prefetch left claimed survives the join path's discard and is still on disk when the create runs (W2-m1)",
        file=RESUME_KEEP,
        search="""      if (entry.channelId === channelId) groups.add(entry.groupId);""",
        replace="""      if (entry.channelId === channelId && entry.claimToken === null)
        groups.add(entry.groupId);""",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-discard-channel-skips-inflight",
        what="`discardChannel` does not route a group whose delete is already running through `cleanup`, so `cleanup`'s pending path never drops what still names the group: a record on ANOTHER channel naming it survives the discard, and can offer the group as a recency candidate once its delete settles (F1-R1). Since fix pass 2 the WAIT on that delete is `#withPending`'s, so this no longer settles early",
        file=RESUME_KEEP,
        # Anchored with the comment line above it: the bare `const pending =
        # [...groups].map(...)` line also occurs in `discardAll`.
        search="""    // A group whose delete is pending gets that delete back from `cleanup`.
    const pending = [...groups].map((g) => this.cleanup(g));""",
        replace="""    // A group whose delete is pending gets that delete back from `cleanup`.
    const pending = [...groups]
      .filter((g) => !this.isInFlight(g))
      .map((g) => this.cleanup(g));""",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-cleanup-ignores-pending",
        what="`cleanup` of a group whose delete is already running starts a SECOND native delete instead of returning the pending one, and the first one's settling clears the in-flight mark while the second still runs (F1-R1)",
        file=RESUME_KEEP,
        search="""    if (pending !== undefined) {""",
        replace="""    if (pending !== undefined && false) {""",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    # The next line was unreached by any keep-spec case when the entries above
    # were written (dropped alone, it left the spec green); the spec gained a
    # case for it, and this entry pins it.
    Mutation(
        id="keep-cleanup-pending-keeps-recency",
        what="`cleanup` of a group whose delete is already running leaves the records naming it, so a record written while the delete runs outlives it and the deleted group can be offered as a recency candidate afterwards (F1-R1)",
        file=RESUME_KEEP,
        # Two lines: `clearResumeRecordsForGroup(this.#deps.storage,
        # groupId);` alone also occurs in `#delete` (the path
        # `keep-cleanup-keeps-recency` breaks), so the pending path's
        # `return pending;` is what tells them apart.
        search="""      clearResumeRecordsForGroup(this.#deps.storage, groupId);
      return pending;""",
        replace="""      return pending;""",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    # 🔴 RETIRED, and recorded rather than silently absent:
    # `keep-discard-channel-skips-running` (fix pass, 2026-09-26) dropped
    # `discardChannel`'s wait on a record's group whose delete was running
    # while ANOTHER channel's entry named it. Fix pass 2 made that wait dead
    # code and deleted it, so the anchor is gone. Two changes made it dead: a
    # keep of a group whose delete is pending is now refused (W2R-n1), so an
    # entry can name an in-flight group only through the re-entry the keep
    # spec builds (a delete started from inside `keep`); and `#withPending`
    # makes every discard wait on EVERY delete pending at the call (W2R-m1),
    # whatever does or does not still name the group. That wait is pinned by
    # `keep-discard-waits-attributable-only` below.
    # ---- the kept-group registry, fix pass 2 (W2R-m1, W2R-n1) --------------
    Mutation(
        id="keep-discard-waits-attributable-only",
        what="`discardAll` and `discardChannel` wait only on the cleanups they started, not on every delete already pending, so a discard resolves while a delete it cannot attribute (a keep expiry, a hand-back past its deadline, a superseded keep or a prefetch's give-up, all of which drop the group's entries and records when they start) is still running natively, and a join can race it (W2R-m1)",
        file=RESUME_KEEP,
        search="""    return [...new Set([...started, ...this.#pending.values()])];""",
        replace="""    return started;""",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-accepts-inflight-keep",
        what="`keep` of a group whose delete is pending creates an entry anyway, so the entry outlives that delete and is claimable once it settles, naming a group no longer on disk (W2R-n1)",
        file=RESUME_KEEP,
        # The refusal block dropped whole (newline included); the comment
        # above it is left, and the keep falls through to its normal path.
        # Re-anchored 2026-09-26 (resume wave 3): `keep` now answers whether
        # it kept, so the refusal's `return;` is `return false;`. Same block,
        # same defect.
        search="""    if (this.isInFlight(groupId)) {
      console.info("[mls] keep refused: the group's delete is pending", {
        groupId,
        channelId,
      });
      return false;
    }
""",
        replace="",
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    # ---- the pre-sink hold verdict ------------------------------------------
    Mutation(
        id="hold-verdict-ignores-disabled",
        what="a disabled bridge still HOLDS MLS envelopes before a sink exists, so a later call is handed envelopes this bridge will never ack (W1R-m4)",
        file=INBOUND_BUFFER,
        search="""  if (i.enabled === false) return "drop";
""",
        replace="",
        specs=[INBOUND_BUFFER_SPEC],
        must_red=[INBOUND_BUFFER_SPEC],
    ),
    Mutation(
        id="hold-verdict-ignores-device",
        what="an envelope addressed to ANOTHER device of this account is held and handed to this device's session when its sink registers (W1R-m1)",
        file=INBOUND_BUFFER,
        search="""  if (i.ownDeviceId && i.ownDeviceId !== i.recipientDeviceId) return "drop";
""",
        replace="",
        specs=[INBOUND_BUFFER_SPEC],
        must_red=[INBOUND_BUFFER_SPEC],
    ),
]


# --- Rejoin resume, wave 3: the resume itself --------------------------------
#
# The session now RESUMES. The startup establish (and only it) reads the
# host's prefetch, bounded by `RESUME_PREFETCH_WAIT_MS`; on a `"resume"`
# decision it adopts the held group (only if `releaseKeptGroup` answers
# true), clears the group's native downgrade grant, catches the fetched
# commits up under the lock, checks native, and goes active with an explicit
# key install — no intent, no create, no commit. Anything short of that takes
# the join path in its binding order: abort the prefetch, clean up the
# candidate (step 6), discard the channel's kept groups (both bounded by
# `KEPT_DISCARD_WAIT_MS`, LOUD past it, never the ladder), then today's
# ladder. A hang-up KEEPS its group for `LOCAL_GROUP_KEEP_MS` (grant cleared
# first), `keep` answers whether it kept, and a `removed_self` dropped while
# another group action runs is recorded and re-checked against native when
# that action ends.
#
# Most entries are `must_red` on `mlsCallSession.resume.test.ts`, which runs
# the REAL `KeptLocalGroups` and `prefetchResume` behind the harness bridge,
# so the registry and prefetch entries below are reachable from it too. Each
# entry names the case(s) measured to kill it, and lists only the spec files
# measured red under it.

MUTATIONS += [
    # ---- the resume branch --------------------------------------------------
    Mutation(
        id="resume-always-join",
        what="the startup establish reads every decision as `join`, so a reload or a hang-up → rejoin inside the keep abandons the held group and re-enrols through today's ladder — the 11 s rejoin this wave removes",
        file=SESSION,
        search="""    if (prefetch === null || decision !== "resume") {""",
        replace="""    if (true) {""",
        # Killed by 41 of the resume spec's 63 cases (re-measured at the
        # merge wave, 2026-09-27; 18 of 36 at wave 3). The wave-3 eighteen:
        # every case that expects a resume ((a), (a′, i′), (b), (b′), (d)'s
        # lag-11 half, (e′) moot, (f), (g), the (i′) re-keep and racing
        # connects, (i″), (q)), every one whose setup resumes first ((h′),
        # (m)), and the ones that assert the step-6 order against a candidate
        # that now never reaches adoption ((e, e″), (e′, e″), (h), (t)). Since
        # then: both (u), both (v), all seven (w), (x), (y), (z1)–(z9) and
        # (z14), each of which drives a candidate through the adopt.
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-keys-install-dropped",
        what="the resume no longer installs the current epoch's keys explicitly, so a catch-up that processed nothing (native fired no keys-changed) goes active with the new worker holding no frame key",
        file=SESSION,
        # Re-anchored 2026-09-26 (resume fix pass, FA-B1). The explicit
        # install was an un-awaited `void this.onLocalKeysChanged(groupId,
        # prefetch.currentEpoch);` AFTER `#toActive()`; that line is gone.
        # The install is now awaited inside `#catchUp`, before anything goes
        # active, through `#installCaughtUpKeys`, whose answer decides
        # between active and the fallback. Same defect, expressed at the new
        # site: the install is skipped and read as done. Distinct from
        # `resume-install-fail-goes-active` below (there the install RUNS and
        # its answer is ignored) and the resume twin of the late-drain
        # branch's `catchup-activates-before-key-install` (whose anchor
        # names `currentEpoch`, not `confirmed`, so the two never collide).
        # Killed by 14 resume cases before the fix pass, (a) first: a resume
        # that applied nothing never installs the current epoch's key, and
        # the seat's mode never reaches `e2ee`.
        # Re-measured at the re-anchor: killed by 18 of 49 resume cases, (a)
        # first; the four new install cases ((u) ×2, (v) ×2) among them.
        search="""      const installed = await this.#installCaughtUpKeys(groupId, confirmed);
""",
        replace="""      const installed = true;
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-startup-check-dropped",
        what="every establish that holds a prefetch takes the resume branch, not only the one `start()` names, so a rejoin-fresh, successor or re-upgrade establish re-reads the startup's prefetch and runs its abort, release and discard (audit M6)",
        file=SESSION,
        # The `startup` PARAMETER, which only `start()` passes true: dropping
        # it is the defect. `resumeDecision`'s own `isStartup` rule (fed
        # `#startupEstablish`) still answers `join` for a re-establish, so no
        # resume happens — what the (m) case catches is the join path's
        # abort, release and discard running on an establish that is not the
        # startup's.
        search="""    if (startup && this.#deps.resumePrefetch !== undefined) {""",
        replace="""    if (this.#deps.resumePrefetch !== undefined) {""",
        # Killed by (m) and (h′): each asserts that a re-establish takes no
        # abort, no `releaseKeptGroup` and no `discardKeptForChannel`.
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- the removed-self record (resume plan step 4, R2-M3) ----------------
    Mutation(
        id="removed-self-record-replayed-blindly",
        what="a `removed_self` dropped mid-action is replayed when the action ends without asking native, so a removal the resume made moot — native still lists this device — tears down the group the device just resumed",
        file=SESSION,
        search="""    void this.#confirmRemovedSelf(record);""",
        replace="""    void record;
    this.#scheduleGroupAction(() => this.#onRemovedSelf(), "removed_self");""",
        # Killed by the two (e′) cases that act at the action's end: the moot
        # one (the replay tears the resumed group down) and the
        # acted-on one (its `acting on a removal dropped mid-action` line is
        # the re-check's, which the replay skips). The (e″) cases stay green
        # by design: step 6 forgets the record before any action ends, so
        # there is nothing left to replay.
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="removed-self-record-never-acted-on",
        what="the record of a `removed_self` dropped mid-action is never taken when the action ends, so a device the group removed while its join ladder waited stays in a group native no longer seats it in",
        file=SESSION,
        search="""        this.#actOnRemovedSelfRecord();
""",
        replace="",
        # Killed by the same two (e′) cases from the other side: the acted-on
        # one (the group is never left, and the device never re-intents) and
        # the moot one (the re-check's `moot` line never comes).
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="step6-forget-dropped",
        what="step 6 no longer forgets the candidate's removed-self record, before or after its delete, so a removal dropped during the resume survives the cleanup and is acted on against the fallback that re-entered the SAME DS group id (R2-M3)",
        file=SESSION,
        # Both sites in `#joinWithoutResume`, each anchored on its
        # neighbouring line: the call before the delete and the one after
        # it are the same text. Both are dropped, as the wave-3 audit
        # measured it (W3-m1); a single-site drop is not measured here.
        # Killed by (e, e″) and (e′, e″).
        search="""      this.#forgetRemovedSelf(candidate);
      await this.#awaitJoinPathDelete(""",
        replace="""      await this.#awaitJoinPathDelete(""",
        also=[
            (
                """      this.#forgetRemovedSelf(candidate);
      if (this.#pendingIdentityFetch === candidate) {""",
                """      if (this.#pendingIdentityFetch === candidate) {""",
            ),
        ],
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- the join path (Wave-3 folds, binding order) ------------------------
    Mutation(
        id="join-path-skips-abort",
        what="the join path no longer aborts the prefetch, so an abandoned prefetch keeps running under the fallback: its claim is never handed back and its `giveUp` can delete the group the fallback joined under the same DS group id (W2R-M1)",
        file=SESSION,
        # The 4-space call with its next line: the two `"stop"` exits in
        # `#startupResume` carry the same call at 6 spaces, which contains
        # the bare 4-space line as a substring.
        search="""    this.#deps.abortResumePrefetch?.();
    const live = () =>""",
        replace="""    const live = () =>""",
        # Killed by the 7 resume cases that assert the join path's abort:
        # (d), (e, e″), (h), (j), both (p) and (r).
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="join-path-skips-discard",
        what="the join path no longer discards the channel's kept groups, so a group a null prefetch left on disk (claimed elsewhere) is still there when the ladder creates or joins the same group id (W2-m1)",
        file=SESSION,
        search="""    await this.#awaitJoinPathDelete(
      this.#deps.bridge.discardKeptForChannel(this.#deps.channelId),
      "the channel's kept local groups",
    );
""",
        replace="",
        # Killed by 6 resume cases: the null-prefetch (p), (r), (s), (j)'s
        # byte-for-byte prefix, (l)'s stale record and (i′)'s in-flight
        # expiry.
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="discard-timeout-falls-through",
        what="a join-path delete that did not finish inside `KEPT_DISCARD_WAIT_MS` is logged and the ladder runs anyway, re-entering a group id whose local delete is still running — the fallback's group can be deleted under it",
        file=SESSION,
        search="""      throw new Error(
        `MLS call join refused: deleting ${what} did not finish — joining ` +
          `now could re-enter a group whose local delete is still running.`,
      );
""",
        replace="",
        # Killed by (s) alone: not loud at the bound, and the ladder runs.
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- adoption -------------------------------------------------------------
    Mutation(
        id="adopt-ignores-release-false",
        what="the resume adopts even when `releaseKeptGroup` answers false, so a candidate whose delete is already in flight is adopted and deleted under the call (W2-m2)",
        file=SESSION,
        search="""    if (!this.#deps.bridge.releaseKeptGroup(groupId)) {""",
        replace="""    if (!(this.#deps.bridge.releaseKeptGroup(groupId) || true)) {""",
        # Killed by (t) alone: the in-flight candidate is adopted (its grant
        # clear runs) instead of taking step 6.
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-release-never-called",
        what="`releaseKeptGroup` is never called, at the adopt or at step 6, so the kept entry the resume adopted keeps its timer and deletes the live group under the call (R2-B1)",
        file=SESSION,
        # Both call sites, and the adopt no longer refuses either: never
        # called means never answered.
        search="""    if (!this.#deps.bridge.releaseKeptGroup(groupId)) {""",
        replace="""    if (false) {""",
        also=[
            (
                """      this.#deps.bridge.releaseKeptGroup(candidate);
""",
                "",
            ),
        ],
        # Killed by 4 resume cases: (a) and (a′, i′) assert the adopt's
        # release, (j) the step-6 release in its byte-for-byte prefix, and
        # (t) the adoption of an in-flight candidate.
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-skips-grant-clear",
        what="the resume adopts without clearing the group's native downgrade grant, so a Ctrl+R after a confirmed downgrade enables on the dead page's grant (W2-M3)",
        file=SESSION,
        search="""    try {
      await this.#deps.bridge.callClearDowngrade(groupId);
    } catch (error) {
      console.warn("[mls] resume: downgrade grant clear failed", error);
      const miss: ResumeMiss = { cause: "grant_clear_failed" };
      return (
        this.#loudVeto(groupId, miss) ??
        this.#noResume(generation, groupId, miss)
      );
    }
""",
        replace="",
        # Killed by (q) (enabled on a live grant) and (a) (the clear's place
        # between the release and the key install).
        # Re-anchored 2026-09-26 (resume fix pass, FA-m3): the failed clear
        # no longer returns `#joinWithoutResume` directly but through
        # `#noResume`, which logs the fallback cause first and then takes the
        # same join path. Only the catch's return changed; the whole
        # try/catch is still dropped, so the adopt still skips the clear.
        # Re-measured at the re-anchor: killed by (a) and (q), 2 of 49.
        # Re-anchored 2026-09-27 (MFR-m1 fix pass, MRG): the catch now asks
        # `#loudVeto` before `#noResume`, and the try/catch moved into
        # `#resumeAdopt` at the same indentation. The whole try/catch is
        # still dropped. Re-measured: killed by 14 of 75, (a), (q), (z6),
        # (z7), (z15)–(z17), (z19)–(z24) and (z26): the cases that drive
        # their verdict from inside the clear lose that await with it.
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- dispose: keep vs discard -------------------------------------------
    Mutation(
        id="dispose-discard-ignored",
        what="`dispose({ discard: true })` (sign-out) keeps the group like a hang-up and writes its recency record, so a signed-out device's call group stays on disk and resumable",
        file=SESSION,
        search="""    if (opts?.discard) {""",
        replace="""    if (false) {""",
        # Killed by the resume spec's discarding hang-up (its direct
        # `dispose({ discard: true })` half is kept and recorded) and by the
        # mailbox spec's sign-out hang-up. Each pinned on its own.
        specs=[RESUME_SPEC, MAILBOX_SPEC],
        must_red=[RESUME_SPEC, MAILBOX_SPEC],
    ),
    Mutation(
        id="keep-skips-grant-clear",
        what="a hang-up keeps its group without clearing the native downgrade grant, so the kept row keeps the grant alive for the channel's next call (R2-M1)",
        file=SESSION,
        search="""    void this.#deps.bridge
      .callClearDowngrade(groupId)
      .catch((error: unknown) => {
        console.warn("[mls] downgrade grant clear at hang-up failed", error);
      });
""",
        replace="",
        # Killed by (i″) and by the mailbox spec's same-page hang-up → rejoin
        # case. Each pinned on its own.
        specs=[RESUME_SPEC, MAILBOX_SPEC],
        must_red=[RESUME_SPEC, MAILBOX_SPEC],
    ),
    # ---- the rejoin serve's roster read (W15R-m1) ---------------------------
    Mutation(
        id="serve-rejoin-no-postawait-recheck",
        what="`#serveRejoin` no longer re-checks generation and group after its `callState` await, so a read that straddled a re-establish or a group change retires or schedules against the LIVE group's reservations and ledger",
        file=SESSION,
        # The check occurs TWICE (the read's success path and its catch), so
        # each is anchored with the line above it and both are dropped.
        search="""      const state = await this.#deps.bridge.callState(this.#groupId);
      if (this.#serveOutlivedRead(request, scheduledGeneration)) return;
""",
        replace="""      const state = await this.#deps.bridge.callState(this.#groupId);
""",
        also=[
            (
                """    } catch {
      if (this.#serveOutlivedRead(request, scheduledGeneration)) return;
""",
                """    } catch {
""",
            ),
        ],
        # Killed by all four of the serve-guard spec's straddling reads
        # (answers or throws, after a same-group re-entry or a reset gap).
        specs=[SERVEGUARD_SPEC],
        must_red=[SERVEGUARD_SPEC],
    ),
    # ---- the prefetch and the kept-group registry ---------------------------
    Mutation(
        id="resume-fetch-failure-reads-caught-up",
        what="a failed commits fetch (the DS's 404, a 500) is read as nothing missed, so the prefetch hands the session a resumable candidate at the device's own epoch instead of cleaning it up — a DS that refuses the catch-up gets a resume at a stale epoch",
        file=RESUME_KEEP,
        search="""    const fetched = await deps.fetchCommits(candidate, state.epoch + 1, signal);""",
        replace="""    const fetched = await deps
      .fetchCommits(candidate, state.epoch + 1, signal)
      .catch(() => ({
        kind: "ok" as const,
        body: { commits: [] as C[], current_epoch: state.epoch },
      }));""",
        # The harness runs the REAL `prefetchResume`, and a 404 reaches it the
        # way `#apiMls` delivers one: THROWN (`requestFetchCommits`). So the
        # defect is that rejection read as an empty, current list. Killed by
        # both (c) cases, the 404 and the 500.
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="prefetch-giveup-ignores-abort",
        what="an aborted prefetch's `giveUp` still cleans its candidate up, so a prefetch the join path abandoned can delete the group the fallback just joined under the same DS group id (W2S-m1)",
        file=RESUME_KEEP,
        search="""    if (signal?.aborted) return null;
""",
        replace="",
        # Killed by the keep spec's two abort cases (before the reads, during
        # the commits fetch), by the resume spec's racing connects (i′) and
        # by one mailbox case. Each pinned on its own. The mailbox spec used
        # to HANG under this mutant past `SPEC_TIMEOUT_S`; the wave-3 fix
        # pass (W3-m2) made it fail on an assertion in seconds instead, so
        # it is listed now.
        specs=[RESUME_KEEP_SPEC, RESUME_SPEC, MAILBOX_SPEC],
        must_red=[RESUME_KEEP_SPEC, RESUME_SPEC, MAILBOX_SPEC],
    ),
    Mutation(
        id="keep-returns-true-always",
        what="`keep` answers true on both refusals, so a hang-up whose keep was refused writes a recency record naming a group that is already on its way off the disk",
        file=RESUME_KEEP,
        search="""      return false;
    }
    if (this.#refused) {
      this.#cleanupLogged(groupId, "keep refused");
      return false;
    }""",
        replace="""      return true;
    }
    if (this.#refused) {
      this.#cleanupLogged(groupId, "keep refused");
      return true;
    }""",
        # Killed by 9 keep-spec cases (every asserted refusal), by the resume
        # spec's sign-out case and by the mailbox spec's sign-out hang-up (a
        # keep after the sign-out answers true). Each pinned on its own.
        specs=[RESUME_KEEP_SPEC, RESUME_SPEC, MAILBOX_SPEC],
        must_red=[RESUME_KEEP_SPEC, RESUME_SPEC, MAILBOX_SPEC],
    ),
    Mutation(
        id="discard-channel-ignores-entries",
        what="`discardChannel` deletes its record's group even when ANOTHER channel's live keep entry names it, deleting a group that entry is still keeping (W2S-m2)",
        file=RESUME_KEEP,
        search="""      rec !== null && !this.#hasEntry(rec.groupId) ? rec.groupId : null;""",
        replace="""      rec !== null ? rec.groupId : null;""",
        # Killed by the keep spec's W2S-m2 case (the other channel's entry
        # NOT mid-delete, claimed or not), which the wave-2 spec lacked.
        specs=[RESUME_KEEP_SPEC],
        must_red=[RESUME_KEEP_SPEC],
    ),
    Mutation(
        id="keep-consumed-per-group",
        what="the registry marks a released (adopted) group consumed by GROUP ID instead of dropping its entry, so a later keep of that group — the next hang-up after a resume — never expires and the group outlives its keep (R2-B1 gap 1)",
        file=RESUME_KEEP,
        # Not a session edit: the session holds no keep state at all (its
        # only keep-side act is the `keepLocalGroup` call in `dispose`). The
        # state is `KeptLocalGroups`', and this is the defect the R2-B1
        # re-check named ("per keep ENTRY, not per group, else a later keep
        # of G never expires"), built at its two sites: `release` marks the
        # group, and `#expire` refuses a marked group's timer.
        search="""    this.#deleteEntries(groupId);
    return !this.isInFlight(groupId);""",
        replace="""    this.#deleteEntries(groupId);
    ((this as unknown as { consumed?: Set<string> }).consumed ??=
      new Set()).add(groupId);
    return !this.isInFlight(groupId);""",
        also=[
            (
                """    if (entry.timer !== slot || !this.#entries.has(entry)) return;""",
                """    if (entry.timer !== slot || !this.#entries.has(entry)) return;
    if (
      (this as unknown as { consumed?: Set<string> }).consumed?.has(
        entry.groupId,
      )
    )
      return;""",
            ),
        ],
        # Killed by the resume spec's (i′) "resume, then hang up" (the new
        # keep never expires) and by the keep spec's release case ("a later
        # keep of that group expires normally"). Each pinned on its own.
        specs=[RESUME_SPEC, RESUME_KEEP_SPEC],
        must_red=[RESUME_SPEC, RESUME_KEEP_SPEC],
    ),
]


# --- Rejoin resume, final-audit fix pass: install, tail, veto, fence ---------
#
# The final cross-cutting audit (2026-09-26) found the resume going active
# BEFORE its keys installed (FA-B1: a keys-changed for an intermediate epoch
# landing mid-catch-up turns the explicit install into an Add-grace one, and
# the gate opens on a send key a member the catch-up removed still holds), and
# a commit dropped as another group's between the prefetch GET and the adopt
# never retried (FA-M1: the seat publishes one epoch behind). The fix: the
# install is awaited under `#catchUp`'s lock and judged by
# `#installCaughtUpKeys` (the install counter moved, the fence is ours, and
# OUR send key is at the confirmed epoch) before anything goes active, and a
# failed install falls back; a non-terminal foreign drop of the candidate is
# recorded in `#resumeForeignDrops` and buys ONE tail fetch before the final
# native check, whose failure falls back. The audit also found the W1-m1 veto
# unpinned (FA-m2), and the fix pass fenced a stale keys-changed push of a
# deleted candidate's old incarnation (`#staleKeysFence`, FAF-S2).
#
# Appended here, after the wave-3 block, on purpose: the late-drain branch's
# block sits mid-file (ahead of the wave-1 block), so the end of the file
# keeps these entries out of its merge window.
#
# Every entry is `must_red` on the resume spec, and the cases named are the
# ones measured red under it.

MUTATIONS += [
    # ---- FA-B1: the install before active -----------------------------------
    Mutation(
        id="resume-active-before-install",
        what="the resume goes active BEFORE the caught-up keys install (FA-B1): the install still runs, but while it is pending the session is green and a reconcile can empty the gate under the send key of an epoch a member the catch-up removed still holds (locked decision 3)",
        file=SESSION,
        # The resume twin of the late-drain branch's `catchup-install-reorder`
        # (different anchor: `confirmed`, not `currentEpoch`).
        # Measured 2026-09-26: killed by 4 of 49: both (u) FA-B1 cases (the
        # interleave, whose sampled monitor sees the gate open on the older
        # send key, and the LDA-M1 shape) and both (v) install failures.
        search="""      const installed = await this.#installCaughtUpKeys(groupId, confirmed);
""",
        replace="""      this.#toActive();
      const installed = await this.#installCaughtUpKeys(groupId, confirmed);
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # `resume-own-key-epoch-unchecked` was here. FOLDED at the merge wave
    # (2026-09-27) into the late-drain block's `own-send-key-epoch-unchecked`,
    # which now pins BOTH `DRAINFAIL_SPEC` and `RESUME_SPEC`: after the merge
    # there is one `#installCaughtUpKeys`, and the two entries mutated the
    # same bytes with the same replace. The resume half of it — (u) "FA-B1,
    # LDA-M1" kills it on its own — is recorded on that entry.
    Mutation(
        id="resume-install-fail-goes-active",
        what="a caught-up install that failed its checks is ignored and the resume goes active anyway, instead of falling back to the join ladder: green on a group whose frame key is missing or older than the confirmed epoch",
        file=SESSION,
        # Measured 2026-09-26: killed by 3 of 49: (u) "FA-B1, LDA-M1" and
        # both (v) install failures.
        # Re-anchored at the merge wave (2026-09-27). The merge brought the
        # late-drain branch's `#confirmWelcomeCurrency`, the second caller of
        # the one `#installCaughtUpKeys`, and it opens its own check with the
        # same `if (!installed) {` line, so the bare line matched TWICE. The
        # search now takes the resume-only warn line that follows it. Same
        # edit, same site. Re-measured: killed by 4 of 63: (u) "FA-B1,
        # LDA-M1", both (v), and (z14) (a failed install never stamps
        # `resumed`, which this mutant lets the resume reach).
        search="""      if (!installed) {
        console.warn("[mls] resume: the caught-up keys did not install", {
""",
        replace="""      if (!installed && false) {
        console.warn("[mls] resume: the caught-up keys did not install", {
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- FA-M1: a commit dropped between the prefetch GET and the adopt -----
    Mutation(
        id="resume-foreign-drop-unrecorded",
        what="a non-terminal foreign drop of the startup's candidate is not recorded (FA-M1), so a commit that landed between the prefetch GET and the adopt is never fetched: the resume confirms at the prefetch's epoch and the seat publishes one epoch behind the group until something else heals it",
        file=SESSION,
        # Measured 2026-09-26: killed by 4 of 49: (w) FA-M1 (one tail GET
        # catches the seat up), both (w) tail failures (non-ok, short) and
        # (w) F1. The same four as `resume-tail-skipped` below: the record is
        # read only by the tail's condition, so the two are behaviourally
        # equivalent today. Both are kept, one per half (the write, the read),
        # so a later second reader of the record cannot leave either unpinned.
        search="""        if (!foreign.ack && this.#startupEstablish) {
          this.#resumeForeignDrops.add(envelope.group_id);
        }
""",
        replace="",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-tail-skipped",
        what="the recorded foreign drop never triggers the tail fetch (FA-M1): the record is kept and cleared but nothing reads it, so the resume confirms at the prefetch's epoch with the dropped commit missing",
        file=SESSION,
        # Measured 2026-09-26: killed by the same 4 of 49 as
        # `resume-foreign-drop-unrecorded` above.
        search="""      if (this.#resumeForeignDrops.has(groupId)) {
        const tail = await this.#catchUpTail(p, stale);
""",
        replace="""      if (this.#resumeForeignDrops.has(groupId) && false) {
        const tail = await this.#catchUpTail(p, stale);
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-tail-failure-kept",
        what="a tail fetch that failed (a throw, a non-ok answer, a 404, a short or lagging page) is ignored and the resume goes on at the prefetch's epoch, instead of falling back: active behind the DS on exactly the path that knows it missed a commit",
        file=SESSION,
        # Measured 2026-09-26: killed by 3 of 49: both (w) tail failures
        # (non-ok, short) and (w) F1.
        search="""        if ("cause" in tail) return tail;
        confirmed = tail.epoch;
""",
        replace="""        if (!("cause" in tail)) confirmed = tail.epoch;
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- FA-m2: the W1-m1 veto ----------------------------------------------
    Mutation(
        id="w1m1-veto-disabled",
        what="the resume no longer vetoes on a LOUD foreign drop of its candidate (W1-m1): an envelope of the group the drain destroyed is gone for good, and the resume goes active on a group state that is missing it",
        file=SESSION,
        # Unpinned until the fix pass: the final audit disabled this veto and
        # every spec stayed green (FA-m2).
        # Measured 2026-09-26: killed by (x) W1-m1 alone (1 of 49).
        search="""      if (this.#loudForeignDrops.has(groupId)) {
""",
        replace="""      if (this.#loudForeignDrops.has(groupId) && false) {
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- FAF-S2: the stale keys-changed fence --------------------------------
    Mutation(
        id="resume-stale-push-unfenced",
        what="a keys-changed push of a startup-deleted group's old incarnation, landing after the join ladder re-entered the same group id, is acted on: `#installEpoch` was reset, so it passes the epoch check, reads frame keys from the deleted row, and the clean rejoin ends in re-securing and loud. Every startup delete is fenced: the resume candidate its fallback deleted (pre-existing on the `catch_up_stopped` fallback; FAF-S2), the kept groups the join path's discard deletes, and the groups the NON-resume startup's `#startupWipe` deletes (FAR-m2)",
        file=SESSION,
        # Measured 2026-09-26: killed by 3 of 49: (w) F1, F2 and F3.
        # Re-anchored at the merge wave (2026-09-27). MS2 item 5 (FAR-m2)
        # turned `#staleKeysFence` from one `{ groupId, epoch }` record, its
        # floor frozen when the delete began, into a Set of fenced group ids
        # whose floor is read from `#startupAppliedEpochs` when the push
        # lands, so the check is now `floor !== undefined && epoch <= floor`
        # and the old line matches nothing. Same defect: the fence never
        # drops a push. Re-measured: killed by 9 of 63: (w) F1, F2 and F3,
        # (z1), and (z9)–(z13).
        # `what` widened at the merge fix pass (2026-09-27, MFG; MWA-n3): it
        # named only the resume candidate, while the line guards every
        # fenced group. Re-measured: the same 9 of 68, (z10) and (z11) being
        # the `#startupWipe` cases.
        search="""    if (floor !== undefined && epoch <= floor) {
""",
        replace="""    if (false) {
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
]


# --- Rejoin resume, merge wave: MS2 items and FAR-m3 --------------------------
#
# The merge with main (the late-drain guard, `b1c39d6e`) put the resume and
# the late drain in one session, and MS2 closed where they meet: a failed gap
# refetch under a catch-up commit is a stop, never clean (item 1); a Welcome
# adopted inside the resume's adopt window arms no currency check (item 2); a
# re-secure raised by the drain inside that window vetoes the resume (item 3,
# LDA-n3); the `retry` arm never re-queues a catch-up's synthetic (item 4, LD
# note 8); the stale-keys fence reads its floor live and covers every startup
# delete, `#startupWipe` included (item 5, FAR-m2); `resumed` is stamped only
# once the resume stands (item 6, FAR-n1). FAR-m3 pinned three rules the resume
# already had and no entry reached: the foreign-apply floor, the tail's lag
# bound from the HELD epoch, and the tail's own-commit rule.
#
# Every entry is `must_red` on the resume spec, whose (z1)–(z14) cases were
# written for these rules; each count below is measured, with the full suite
# loaded, against the 63-case spec. Two PAIRS are equivalent today — the same
# kill for the same reason — and both halves are kept because each guards a
# different line (the flag's write and its read), so a second reader of either
# flag cannot leave one of them unpinned: `resume-adopt-welcome-arms-currency`
# / `resume-adopting-never-set` (z6), and `catch-up-synthetic-requeued` /
# `resume-catching-up-never-set` (z8). The first pair was split at the merge
# fix pass (MWA-m1 widened the guard `#resumeAdopting` is read by);
# `resume-adopting-never-set` now pairs with
# `resume-adopt-welcome-guard-bypassed` in the fix-pass block below.
#
# 🔴 Two entries pin a CLASSIFICATION, not a fail-open:
# `catch-up-refetch-failure-uncounted` and `resume-tail-refetch-reason-lost`.
# Under either the resume still falls back (a rethrow ends it
# `catch_up_threw`, a mislabel `tail_failed`/`not_applied`); what they break is
# the cause the fallback's log line and `resumeJoinCause` report, which MS2
# item 1 made part of the contract.

MUTATIONS += [
    # ---- FAR-m3: the three resume rules no entry reached --------------------
    Mutation(
        id="resume-foreign-apply-floor-unrecorded",
        what="a commit of a startup group applied as ANOTHER group's (a post-GET commit drained before the adopt, or one native applied while the group's delete ran) is not recorded in `#startupAppliedEpochs` (FAR-m3): the fence floor misses that epoch, and after the fallback re-enters the same group id, native's keys-changed for it passes the fence and reads frame keys from the deleted row",
        file=SESSION,
        # Measured 2026-09-27: killed by 6 of 63: (z1) (the lag-0 foreign
        # apply must fence at C+1) and (z9)–(z13) (every floor an apply
        # raised during a delete).
        search="""      if (foreign.kind === "processed") this.#noteStartupApplied(foreign);
""",
        replace="",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-tail-held-lag-unbounded",
        what="the resume tail is held only to `lag >= 0` from native's epoch, not to `RESUME_MAX_LAG` from the HELD epoch (FAR-m3): a tail that carries the group past the lag the live session calls desync is applied, so a resume catches up further than the prefetch itself was allowed to",
        file=SESSION,
        # Measured 2026-09-27: killed by (z2) alone (1 of 63).
        search="""    if (!(lag >= 0 && current - p.localEpoch < RESUME_MAX_LAG)) {
""",
        replace="""    if (!(lag >= 0)) {
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-tail-own-commit-applied",
        what="a tail page carrying a commit of this device's own is applied (FAR-m3): the prefetch's own-commit rule does not hold for the tail, and the resume re-applies a commit native already staged as ours",
        file=SESSION,
        # Measured 2026-09-27: killed by (z3) alone (1 of 63).
        search="""      return failed("own_commit", { from, current });
""",
        replace="",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- MS2 item 1: a failed gap refetch is not clean ----------------------
    Mutation(
        id="catch-up-refetch-failure-uncounted",
        what="a gap refetch that failed under a resume catch-up commit is not counted, so `#consumeCatchUp` cannot tell it from any other throw and rethrows it: the resume ends `catch_up_threw` instead of `catch_up_stopped` / `tail_failed` (`gap_refetch_failed`) (MS2 item 1; fail-closed, the cause is what breaks)",
        file=SESSION,
        # Measured 2026-09-27: killed by (z4) and (z5) (2 of 63).
        search="""      this.#gapRefetchFailures++;
""",
        replace="",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-tail-refetch-reason-lost",
        what="the resume tail reports a failed gap refetch under one of its commits as `not_applied` (MS2 item 1; fail-closed, the reason is what breaks)",
        file=SESSION,
        # Measured 2026-09-27: killed by (z5) alone (1 of 63).
        search="""          result === "gap_refetch_failed" ? result : "not_applied",
""",
        replace="""          "not_applied",
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- MS2 item 2: the resume's adopt arms no currency check --------------
    Mutation(
        id="resume-adopt-welcome-arms-currency",
        what="a Welcome for the candidate adopted INSIDE the resume's adopt window records a Welcome currency check (MS2 item 2): `#pump` runs it beside the resume, and its `#toActive()` can go active on a verdict the resume has not reached",
        file=SESSION,
        # Measured 2026-09-27: killed by (z6) alone (1 of 63).
        # Re-anchored at the merge fix pass (2026-09-27, MFG). MWA-m1 removed
        # the set-then-null guard this entry deleted: the record is now
        # written only inside `if (this.#resumeAdopting !==
        # outcome.group_id)`. Same defect, re-introduced as an insertion: the
        # record is written for EVERY adopted Welcome, just before the wait
        # resolves, so an adopt-window Welcome arms the check (an ordinary
        # one writes the same record twice). The stamp and `#joinedGeneration`
        # stay guarded; those are the MWA-m1 entries' to pin. Re-measured:
        # killed by (z6) alone (1 of 68). No longer equivalent to
        # `resume-adopting-never-set` (the block note).
        search="""      if (verdict.resolveWait) this.#welcomeWait?.resolve(true);
""",
        replace="""      this.#welcomeCurrency = {
        groupId: outcome.group_id,
        epoch: outcome.epoch,
        generation: this.#establishGeneration,
      };
      if (verdict.resolveWait) this.#welcomeWait?.resolve(true);
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-adopting-never-set",
        what="`#resumeAdopting` is never set at the adopt, so the Welcome arm's guard never matches and a Welcome adopted inside the adopt window arms a currency check beside the resume (MS2 item 2), and stamps `welcomeAdopted` and writes `#joinedGeneration`, which outlive a fallback (MWA-m1)",
        file=SESSION,
        # Measured 2026-09-27: killed by (z6) alone (1 of 63). Equivalent
        # today to `resume-adopt-welcome-arms-currency` (the block note).
        # Re-measured at the merge fix pass (2026-09-27, MFG): killed by
        # (z6), (z15) and (z16) (3 of 68), since MWA-m1's guard now covers
        # the stamp and `#joinedGeneration` as well. Equivalent today to
        # `resume-adopt-welcome-guard-bypassed`, no longer to
        # `resume-adopt-welcome-arms-currency` (the block note).
        search="""    this.#groupId = groupId;
    this.#resumeAdopting = groupId;
""",
        replace="""    this.#groupId = groupId;
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- MS2 item 3: a re-secure inside the adopt window vetoes (LDA-n3) ----
    Mutation(
        id="resume-active-over-resecure",
        what="a re-secure raised inside the adopt window (a DS 404 on a gap refetch the drain ran) no longer vetoes the resume — only a terminal session does — so it goes active over `resecuring`, and the fresh rejoin the 404 asked for, dropped by the single-flight, never runs: green on a group the DS may no longer list this device in (MS2 item 3, LDA-n3)",
        file=SESSION,
        # Measured 2026-09-27: killed by (z7) alone (1 of 63).
        search="""    if (this.#state === "resecuring") {
      console.warn("[mls] resume vetoed""",
        replace="""    if (this.#terminal()) {
      console.warn("[mls] resume vetoed""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- MS2 item 4: a catch-up synthetic is never re-queued (LD note 8) ----
    Mutation(
        id="catch-up-synthetic-requeued",
        what="the drain's `retry` arm re-queues a resume catch-up's synthetic (LD note 8): the catch-up already stopped on it and fell back, possibly into the SAME group id, and the re-queued old commit drains into the new incarnation (MS2 item 4)",
        file=SESSION,
        # Measured 2026-09-27: killed by (z8) alone (1 of 63). Equivalent
        # today to `resume-catching-up-never-set` (the block note).
        search="""        if (!(this.#resumeCatchingUp && envelope.id.startsWith("mls-synth:")))
          this.#scheduleRetry(envelope);
""",
        replace="""        this.#scheduleRetry(envelope);
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-catching-up-never-set",
        what="`#resumeCatchingUp` is never set under `#catchUp`'s lock, so the `retry` arm's guard never recognises a catch-up's synthetic and re-queues it into the fallback (MS2 item 4)",
        file=SESSION,
        # Measured 2026-09-27: killed by (z8) alone (1 of 63). Equivalent
        # today to `catch-up-synthetic-requeued` (the block note).
        search="""    this.#resumeCatchingUp = true;
""",
        replace="",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- MS2 item 5 (FAR-m2): the stale-keys fence --------------------------
    Mutation(
        id="stale-fence-floor-frozen-at-delete",
        what="a fenced group's applies never raise its floor, not even one the delete raced (the deleted incarnation's), so the floor stays where the fence found it and that apply's keys-changed passes the fence after the ladder re-enters the group id (MS2 item 5, FAR-m2: the floor is read live)",
        file=SESSION,
        # Measured 2026-09-27: killed by (z11) alone (1 of 63). Only
        # `#startupWipe` fences a group BEFORE its delete is awaited; the
        # resume fallback fences after the candidate's delete, so (z9)'s
        # raced apply still counts under this mutant.
        search="""    if (fenced && outcome.group_id === this.#groupId) return;
""",
        replace="""    if (fenced) return;
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="stale-fence-counts-new-incarnation",
        what="once the ladder re-enters a fenced group id, the NEW incarnation's applies still raise the floor its own keys-changed is checked against, so the fence drops the new incarnation's legitimate pushes (MS2 item 5, FAR-m2: never drop a new incarnation's push)",
        file=SESSION,
        # Measured 2026-09-27: killed by 14 of 63 resume cases ((e, e″),
        # (e′, e″), (h), (w) F1–F3, (z1)–(z3), (z9)–(z13)) and by the mailbox
        # spec's W1 (1 of 13). Each pinned on its own.
        search="""    if (fenced && outcome.group_id === this.#groupId) return;
""",
        replace="",
        specs=[RESUME_SPEC, MAILBOX_SPEC],
        must_red=[RESUME_SPEC, MAILBOX_SPEC],
    ),
    Mutation(
        id="startup-wipe-unfenced",
        what="the NON-resume startup's `#startupWipe` no longer fences the groups it deletes, so native's keys-changed for a commit the old incarnation applied, landing after the ladder re-enters the same group id, reads frame keys from the deleted row: re-securing, then loud (MS2 item 5, FAR-m2)",
        file=SESSION,
        # Measured 2026-09-27: killed by (z10) and (z11) (2 of 63).
        search="""        // still raises the floor (`#noteStartupApplied`).
        this.#staleKeysFence.add(groupId);
""",
        replace="""        // still raises the floor (`#noteStartupApplied`).
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-fallback-discard-unfenced",
        what="the resume's fallback (`#joinWithoutResume`) fences nothing — neither the candidate it deleted nor the kept groups the discard deletes — so an old incarnation's in-flight keys-changed reaches the new one after the ladder re-enters the same group id (MS2 item 5, FAR-m2)",
        file=SESSION,
        # Measured 2026-09-27: killed by 7 of 63: (w) F1, F2 and F3, (z1),
        # (z9), (z12) and (z13).
        search="""    for (const groupId of this.#startupAppliedEpochs.keys()) {
      this.#staleKeysFence.add(groupId);
    }
""",
        replace="",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="stale-fence-floor-pruned-at-window",
        what="the startup window's close clears a FENCED group's floor with every other entry, so an old push landing after the establish returned finds no floor and passes the fence (MS2 item 5, FAR-m2: a fenced floor outlives the window)",
        file=SESSION,
        # Measured 2026-09-27: killed by (z13) alone (1 of 63).
        search="""          if (!this.#staleKeysFence.has(groupId)) {
            this.#startupAppliedEpochs.delete(groupId);
          }
""",
        replace="""          this.#startupAppliedEpochs.delete(groupId);
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- MS2 item 6 (FAR-n1): `resumed` only once the resume stands ---------
    Mutation(
        id="resume-stamped-before-install",
        what="`resumed` is stamped before the caught-up keys install again (FAR-n1, the pre-fix order): a resume that fails its install check still leaves a `resumed` stamp on the fallback's timeline, and a resume's `resumed` time excludes the install",
        file=SESSION,
        # Both halves of the move: the stamp leaves `#startupResume` (after
        # the install check and the veto) and returns ahead of the install in
        # `#catchUp`. Measured 2026-09-27: killed by (a) (the stamp chain
        # `keysInstalled < resumed`) and (z14) (2 of 63).
        # Re-anchored 2026-09-27 (MFR-m1 fix pass, MRG): MFR-m1 put the
        # `latchedBefore` read (`ownLatch`) between the `catchUpDone` stamp
        # and the install, so the second edit carries that line and still
        # stamps `resumed` right after `catchUpDone`, ahead of the install.
        # Re-measured: killed by (a) and (z14), 2 of 75.
        search="""    this.#joinTimeline?.stamp("resumed");
    const epoch = outcome.epoch;
""",
        replace="""    const epoch = outcome.epoch;
""",
        also=[
            (
                """      this.#joinTimeline?.stamp("catchUpDone");
      const latchedBefore = this.#loudLatched;
""",
                """      this.#joinTimeline?.stamp("catchUpDone");
      this.#joinTimeline?.stamp("resumed");
      const latchedBefore = this.#loudLatched;
""",
            ),
        ],
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
]


# --- Rejoin resume, merge fix pass: the adopt window (MWA-m1, n1, n2) --------
#
# The merge-wave audit found what the resume's adopt window leaves behind for
# the join ladder and for a later Welcome. MWA-m1: a Welcome adopted inside
# the window wrote `#joinedGeneration` (and stamped `welcomeAdopted`), so on a
# fallback the ladder read itself joined and stopped before its first intent,
# a silent amber wedge; all three writes, the currency record included, now
# sit inside `if (this.#resumeAdopting !== outcome.group_id)`. MWA-n1: the
# veto now fires on `failed` or the loud latch, ahead of the re-secure check,
# and STOPS (`#resumeStopped`, `loud_during_adopt`) rather than falling back,
# because the fallback's reset clears the latch. MWA-n2: the three resets
# that close the window (success, `#noResume`, `#resumeStopped`) were
# unpinned or pinned only incidentally.
#
# Every entry is `must_red` on the resume spec, whose (z15)–(z19) were written
# for these rules; each count is measured, with the full suite loaded, against
# the 68-case spec. `resume-adopt-welcome-guard-bypassed` is equivalent today
# to `resume-adopting-never-set` (z6, z15, z16): the guard's read and the
# flag's write, both kept for the reason in the merge-wave block's note.
#
# 🔴 KNOWN NON-ENTRY, recorded rather than silently absent:
# `resume-veto-ignores-failed` — the veto reading only the latch
# (`if (this.#loudLatched)`, dropping `this.#state === "failed" ||`). Measured
# green in every session spec. It cannot redden: the only writer of `failed`
# is `#onLoud`, which latches in the same step, so inside the adopt window
# `failed` never comes without the latch. The term stays as defence against
# a future writer of `failed` that does not latch. Re-measured 2026-09-27
# (MFR-m1 fix pass, MRG) on the veto's new home, `#loudVeto`'s
# `if (!this.#loudLatched) return null;`: green in all 12 session specs.
#
# 🔴 THREE MORE KNOWN NON-ENTRIES since the MFR-m1 fix pass (MFR-n2):
# `resume-success-keeps-adopt-window`, `resume-fallback-keeps-adopt-window`
# and `resume-stop-keeps-adopt-window`, each dropping one of the three resets
# listed above. Retired, not lost: `#startupResume` now runs the whole window
# (`#resumeAdopt`) inside a `try/finally` that clears `#resumeAdopting` on
# every exit, so each dropped reset is re-done by the `finally` before
# `#startupResume` returns. Measured 2026-09-27 against the 75-case resume
# spec and the 11 other session specs: all three green everywhere. The
# success and stop resets are followed only by synchronous code, then the
# `await`'s own resumption into the `finally`. The fallback's reset leaves
# the flag set for longer, across
# `#joinWithoutResume`'s bounded delete of that same candidate; the ladder's
# create, intent and Welcome back all run in `#establishWithGeneration`
# after `#startupResume` has returned, so none of them sees it. What pins
# the window closing now is the `finally` itself:
# `resume-adopt-window-finally-reset-dropped` below. The three resets stay in
# the session as the exits' own bookkeeping; the `finally` is the guarantee.

MUTATIONS += [
    # ---- MWA-m1: an adopt-window Welcome leaves nothing for the ladder ------
    Mutation(
        id="resume-adopt-welcome-marks-joined",
        what="a Welcome adopted inside the resume's adopt window writes `#joinedGeneration` (MWA-m1): on a fallback the join ladder reads itself joined at its loop head and stops before its first intent, amber with no owner and nothing loud, a silent wedge",
        file=SESSION,
        # Measured 2026-09-27 (merge fix pass): killed by (z15) and (z16) (2
        # of 68).
        search="""      if (this.#resumeAdopting !== outcome.group_id) {
""",
        replace="""      this.#joinedGeneration = this.#establishGeneration;
      if (this.#resumeAdopting !== outcome.group_id) {
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-adopt-welcome-stamps-adopted",
        what="a Welcome adopted inside the resume's adopt window stamps `welcomeAdopted` (MWA-m1): the first stamp wins, so after a fallback the join timeline reports the adopt-window Welcome, ahead of the fallback's own create, instead of the Welcome that joined (telemetry, not a fail-open)",
        file=SESSION,
        # Measured 2026-09-27 (merge fix pass): killed by (z16) alone (1 of
        # 68), whose `createRouted < welcomeAdopted` is the check.
        search="""      if (this.#resumeAdopting !== outcome.group_id) {
""",
        replace="""      this.#joinTimeline?.stamp("welcomeAdopted");
      if (this.#resumeAdopting !== outcome.group_id) {
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-adopt-welcome-guard-bypassed",
        what="the adopt-window guard always passes, so a Welcome for the candidate adopted inside the resume's adopt window stamps, writes `#joinedGeneration` and records a currency check: MWA-m1's wedge and MS2 item 2's second path to active, together",
        file=SESSION,
        # Measured 2026-09-27 (merge fix pass): killed by (z6), (z15) and
        # (z16) (3 of 68). Equivalent today to `resume-adopting-never-set`
        # (the block note).
        search="""      if (this.#resumeAdopting !== outcome.group_id) {
""",
        replace="""      if (true) {
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- MWA-n1: a loud verdict inside the window vetoes, and stays loud ----
    Mutation(
        id="resume-veto-ignores-loud-latch",
        what="the adopt-window veto reads only `failed`, not the loud latch (MWA-n1): a `#latchLoud` raised inside the window vetoes nothing, and the resume goes `#toActive` over it, active while the latch holds",
        file=SESSION,
        # Measured 2026-09-27 (merge fix pass): killed by (z17) and (z19) (2
        # of 68). Its twin on the `failed` term is the non-entry in the
        # block note.
        # Re-anchored 2026-09-27 (MFR-m1 fix pass, MRG): the veto moved into
        # `#loudVeto` as an early `return null`, so the mutant drops the
        # latch term there. Same meaning, and wider reach, since every miss
        # out of the window now asks the same veto. Re-measured: killed by 8
        # of 75, (z17), (z19)–(z24) and (z26).
        search="""    if (this.#state !== "failed" && !this.#loudLatched) return null;
""",
        replace="""    if (this.#state !== "failed") return null;
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-loud-veto-falls-back",
        what="a loud veto inside the adopt window falls back to the join ladder (`#noResume`) instead of stopping (MWA-n1): the fallback's `#resetGroupBuffers` clears the latch, so the loud verdict is dropped and the ladder runs as if it never happened",
        file=SESSION,
        # Measured 2026-09-27 (merge fix pass): killed by (z17) and (z19) (2
        # of 68). The cause stays `loud_during_adopt`, so only the path is
        # mutated, not the log line.
        # Re-anchored 2026-09-27 (MFR-m1 fix pass, MRG): the stop is now
        # `#loudVeto`'s one return. `#loudVeto` has no `generation`, so the
        # mutant passes `#establishGeneration`, which is the resume's own
        # while the veto can run (a superseded resume stops before it). The
        # promise it returns is non-null, so every caller takes it as the
        # veto's answer and awaits the fallback. Re-measured: killed by 7 of
        # 75, (z17) and (z19)–(z24).
        search="""    return this.#resumeStopped(groupId, { cause: "loud_during_adopt", detail });
""",
        replace="""    return this.#noResume(this.#establishGeneration, groupId, {
      cause: "loud_during_adopt",
      detail,
    }) as never;
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
]


# --- Rejoin resume, MFR-m1 fix pass: a loud latch wins over a miss ----------
#
# The merge-fix re-audit (MFR-m1) found the loud veto consulted only after a
# CLEAN catch-up: a latch raised inside the adopt window followed by a
# catch-up, tail or install miss took `#noResume`, whose fallback reset
# CLEARS the latch, so a hostile-DS signal went red to amber and the ladder
# ran over it. Now every miss out of the window (the grant clear, the
# catch-up, its tail, the install check) asks `#loudVeto` first, except a
# latch the miss raised itself: `ResumeMiss.ownLatch`, set when the resume's
# own key install first raises the latch (a missing local frame key, spec
# (v)), which the fallback's fresh join is the recovery for. MFR-n2 put the
# window in a `try/finally`, so a throw out of it closes it too; that retired
# the three per-exit reset mutants (the previous block's note).
#
# Every entry is `must_red` on the resume spec, whose (z20)–(z26) were
# written for these rules ((z25), a miss with no latch still falls back,
# passes on the pre-fix session by design and is pinned by the older
# fallback entries). Each count is measured, with the full suite loaded,
# against the 75-case spec.

MUTATIONS += [
    # ---- MFR-m1: the loud veto runs before any miss's fallback -------------
    Mutation(
        id="resume-miss-falls-back-over-loud-latch",
        what="a catch-up, tail or install miss out of the adopt window falls back without asking the loud veto (MFR-m1, the pre-fix precedence): the fallback's reset clears a latch raised inside the window, so the seat goes red to amber and the ladder runs over a hostile-DS signal",
        file=SESSION,
        # Measured 2026-09-27 (MFR-m1 fix pass, MRG): killed by (z20),
        # (z21), (z22) and (z23), 4 of 75.
        search="""      const vetoed = outcome.ownLatch ? null : this.#loudVeto(groupId, outcome);
      return vetoed ?? this.#noResume(generation, groupId, outcome);
""",
        replace="""      return this.#noResume(generation, groupId, outcome);
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-grant-clear-miss-falls-back-over-loud-latch",
        what="a failed downgrade-grant clear falls back without asking the loud veto (MFR-m1): a latch standing when the clear fails is cleared by the fallback's reset instead of stopping loud",
        file=SESSION,
        # Measured 2026-09-27 (MFR-m1 fix pass, MRG): killed by (z24) alone,
        # 1 of 75. (z24)'s latch fires just before the adoption, so it pins
        # the grant-clear path's precedence, not a latch raised mid-clear.
        search="""      return (
        this.#loudVeto(groupId, miss) ??
        this.#noResume(generation, groupId, miss)
      );
""",
        replace="""      return this.#noResume(generation, groupId, miss);
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- MFR-m1: only the install's own latch may fall back ----------------
    Mutation(
        id="resume-own-latch-vetoes",
        what="`ownLatch` is ignored, so the latch the resume's own key install raises (a missing local frame key) vetoes too: the seat stops loud where the fallback's fresh join was its recovery, a permanent red for a local fault",
        file=SESSION,
        # Measured 2026-09-27 (MFR-m1 fix pass, MRG): killed by (v) (the
        # install's missing frame key) and (z23) (its second half: the
        # install's latch alone falls back and reaches e2ee), 2 of 75.
        search="""      const vetoed = outcome.ownLatch ? null : this.#loudVeto(groupId, outcome);
""",
        replace="""      const vetoed = this.#loudVeto(groupId, outcome);
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    Mutation(
        id="resume-own-latch-claims-any-latch",
        what="`ownLatch` is set by any latch standing after the install, not only one the install raised: a latch raised inside the window before the install, then an install miss, falls back and the reset clears it (MFR-m1 through the exception)",
        file=SESSION,
        # Measured 2026-09-27 (MFR-m1 fix pass, MRG): killed by (z22) and
        # (z23), 2 of 75.
        search="""          ownLatch: !latchedBefore && this.#loudLatched,
""",
        replace="""          ownLatch: this.#loudLatched,
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
    # ---- MFR-n2: every exit, a throw included, closes the adopt window -----
    Mutation(
        id="resume-adopt-window-finally-reset-dropped",
        what="the adopt window's `finally` no longer clears `#resumeAdopting` (MFR-n2): a throw out of the window skips every exit's own reset, so a later Welcome back into the same group id is read as an adopt-window Welcome and never checked current",
        file=SESSION,
        # Measured 2026-09-27 (MFR-m1 fix pass, MRG): killed by (z26) alone,
        # 1 of 75. (z26) reddens inside its `welcomeBack` step (the seat is
        # `resecuring`), before its named assertion; the count is the same.
        search="""      // exits keep their own resets, which run first; a throw skips them.
      this.#resumeAdopting = null;
    }
""",
        replace="""      // exits keep their own resets, which run first; a throw skips them.
    }
""",
        specs=[RESUME_SPEC],
        must_red=[RESUME_SPEC],
    ),
]


# --- Opt-in screen shares (call-view suggestions, wave 5, audit F3) ----------
#
# A remote screen share is subscribed only once its identity is WATCHED. The
# media-e2ee final audit found the enforcement had no mutation coverage at
# all: deleting the watch check from `RoomAudioManager`'s video effect brought
# back blanket share subscription with every gate green. The decisions now
# live in `screenShareWatchPolicy.ts` (pure, spec'd), and
# `RoomAudioManager.tsx` — which `node --test` cannot load — is held to
# calling them by the SOURCE PINS at the end of
# `screenShareWatchPolicy.test.ts`. So a `file=AUDIO_MANAGER` entry below is
# killed by a pin, not by running the effect: what it proves is that the pin
# notices the wiring change, and the policy entries prove the functions it
# pins are themselves held by assertions. The pins strip comments before
# matching, so commenting a call out does not satisfy them; the same text in
# dead code (`if (false) { ... }`) would, and nothing here measures that.
#
# 🔴 No entry touches the cryptor-disarm sweep, even transiently: the pins
# assert its inputs (`tracks()` / `videoTracks()`) stay unfiltered, but that
# rule is not mutation-tested here.

#: Relative to `RTC`, like every other target (`apply` reads
#: `RTC / mutation.file`).
AUDIO_MANAGER = "components/RoomAudioManager.tsx"
WATCH_POLICY = "screenShareWatchPolicy.ts"
RECORDER = "callRecorder.ts"
WATCH_POLICY_SPEC = "components/rtc/screenShareWatchPolicy.test.ts"
RECORDER_SPEC = "components/rtc/callRecorder.test.ts"

MUTATIONS += [
    # ---- the wiring in RoomAudioManager.tsx (killed by the source pins) -----
    Mutation(
        id="watch-audio-gate-dropped",
        what="the audio memo filters inline again without the watch check, so every remote screen share's audio is subscribed and played whether or not anyone pressed Watch",
        file=AUDIO_MANAGER,
        search="""    return remoteAudioToPlay(tracks(), watched, {
      isLocal: (track) => isLocal(track.participant),
      isAudio: (track) => track.publication.kind === Track.Kind.Audio,
      addressee: (track) => whisperTarget(track.publication.trackName),
      localUserId: myUserId,
      watchPub: watchPubOf,
    });
""",
        replace="""    return tracks().filter((track) => {
      if (isLocal(track.participant)) return false;
      if (track.publication.kind !== Track.Kind.Audio) return false;
      const addressee = whisperTarget(track.publication.trackName);
      if (addressee && addressee !== myUserId()) return false;
      return true;
    });
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-audio-view-neutered",
        what="the audio memo still calls `remoteAudioToPlay`, but hands it a watch view that calls every track a microphone, so the watch gate passes all share audio",
        file=AUDIO_MANAGER,
        search="""      watchPub: watchPubOf,
""",
        replace="""      watchPub: (track) => ({ ...watchPubOf(track), source: "microphone" }),
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-audio-subscribes-unfiltered",
        what="the audio subscribe effect requests every track in the UNFILTERED list instead of the gated memo, so unwatched share audio is subscribed",
        file=AUDIO_MANAGER,
        # Two anchors, so the debug `console.info` between them is free to go:
        # `const tracks = filteredTracks();` alone also opens the normalizer
        # effect, hence the `createEffect` line in front of it.
        search="""  createEffect(() => {
    const tracks = filteredTracks();
""",
        replace="""  createEffect(() => {
""",
        also=[
            (
                """    for (const track of tracks) {
""",
                """    for (const track of tracks()) {
""",
            ),
        ],
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-camera-effect-takes-shares",
        what="the camera effect subscribes every remote video, screen shares included, so unwatched share video is pulled down alongside the cameras",
        file=AUDIO_MANAGER,
        search="""    for (const track of nonShareVideoToSubscribe(filteredVideoTracks())) {
""",
        replace="""    for (const track of filteredVideoTracks()) {
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-share-video-ungated",
        what="the watched-share video effect subscribes every remote screen share (the audit's F3 deletion), so share video flows before anyone presses Watch",
        file=AUDIO_MANAGER,
        search="""    for (const track of watchedShareVideoToSubscribe(
      filteredVideoTracks(),
      watched,
      watchPubOf,
    )) {
""",
        replace="""    for (const track of filteredVideoTracks().filter((track) =>
      isShareSource(track.source),
    )) {
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-share-video-watch-set-ignored",
        what="the watched-share video effect still calls the policy, but with a watch set of everyone publishing video, so every remote share counts as watched",
        file=AUDIO_MANAGER,
        search="""      filteredVideoTracks(),
      watched,
      watchPubOf,
""",
        replace="""      filteredVideoTracks(),
      new Set(filteredVideoTracks().map((t) => t.participant.identity)),
      watchPubOf,
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-unsubscribe-backstop-dropped",
        what="the explicit-unsubscribe backstop never selects anything, so a share some other path made desired while unwatched stays subscribed and is re-requested on every resume",
        file=AUDIO_MANAGER,
        search="""    for (const { publication } of sharesToUnsubscribe(pubs, watched)) {
""",
        replace="""    for (const { publication } of pubs.filter(() => false)) {
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-reconcile-sees-no-transition",
        what="the watch-transition effect reconciles the previous set against itself, so Stop watching never unsubscribes the share and a re-Watch never re-requests its audio",
        file=AUDIO_MANAGER,
        search="""      for (const change of reconcileShareSubscriptions(prev, next, pubs)) {
""",
        replace="""      for (const change of reconcileShareSubscriptions(prev, prev, pubs)) {
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    # ---- the decisions in screenShareWatchPolicy.ts --------------------------
    Mutation(
        id="watch-policy-watched-check-flipped",
        what="`shouldSubscribeRemote` subscribes a share only when its identity is NOT watched: every unwatched share flows and a Watch press cuts it off",
        file=WATCH_POLICY,
        search="""  return watched.has(pub.identity);
""",
        replace="""  return !watched.has(pub.identity);
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-policy-unsubscribe-check-flipped",
        what="`sharesToUnsubscribe` selects WATCHED shares instead of unwatched ones, so the backstop tears down what the viewer chose and keeps what they did not",
        file=WATCH_POLICY,
        search="""    if (pub.isSelfLeg || !watched.has(pub.identity)) out.push(pub);
""",
        replace="""    if (pub.isSelfLeg || watched.has(pub.identity)) out.push(pub);
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-policy-audio-gate-dropped",
        what="`remoteAudioToPlay` keeps every remote audio track that is not a whisper to someone else, so unwatched share audio (and our own leg's) is subscribed and played",
        file=WATCH_POLICY,
        search="""    return shouldSubscribeRemote(reads.watchPub(ref), watched);
""",
        replace="""    return true;
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-policy-share-video-gate-dropped",
        what="`watchedShareVideoToSubscribe` returns every share-source reference without the watch check, so all remote share video is subscribed",
        file=WATCH_POLICY,
        search="""      isShareSource(ref.source) &&
      shouldSubscribeRemote(watchPub(ref), watched),
""",
        replace="""      isShareSource(ref.source),
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    Mutation(
        id="watch-policy-camera-takes-shares",
        what="`nonShareVideoToSubscribe` returns every video reference, so the camera effect subscribes screen shares too, watched or not",
        file=WATCH_POLICY,
        search="""  return refs.filter((ref) => !isShareSource(ref.source));
""",
        replace="""  return [...refs];
""",
        specs=[WATCH_POLICY_SPEC],
        must_red=[WATCH_POLICY_SPEC],
    ),
    # ---- the recorder's watch-set getter (callRecorder.ts) -------------------
    Mutation(
        id="recorder-watch-set-ignored",
        what="the recorder asks the policy about a watch set that always contains the sender, so every share's audio the SFU pushes is mixed into the recording, watched or not",
        file=RECORDER,
        search="""      this.#watchedShares(),
""",
        replace="""      new Set([identity]),
""",
        specs=[RECORDER_SPEC],
        must_red=[RECORDER_SPEC],
    ),
    Mutation(
        id="recorder-watch-set-snapshotted",
        what="the recorder reads the watch set once at construction, so a Watch or Stop watching during a recording never moves that share into or out of the mix",
        file=RECORDER,
        search="""    this.#watchedShares = watchedShares;
""",
        replace="""    const snapshot = watchedShares();
    this.#watchedShares = () => snapshot;
""",
        specs=[RECORDER_SPEC],
        must_red=[RECORDER_SPEC],
    ),
]


# --- Voice moves and chip publications (call-view suggestions, wave 7) ------
#
# Both reviewers of waves 5-6 found that the `state.tsx` wiring of four fixes
# could be undone by a one-token edit with every gate green: F1 (a device the
# user's own other session kicked must not follow that session's move), F4
# (a dropped move token answers from the refusal latch it bypassed), S1 (only
# some latched refusals may be bypassed) and F2 (the chip's share-only
# contradiction reads each remote publication's desired/subscribed state and
# re-derives when it flips). The decisions live in `voiceMovePolicy.ts` and
# `chipInputs.ts`, whose own specs hold them (the `move-policy-*` and
# `chip-pubs-*` entries); `state.tsx` is held to CALLING them by the source
# pins in `stateWiring.test.ts` (the `state-*` entries), which is the same
# arrangement as the `watch-*` entries above: a `file=STATE` entry is killed
# by a pin noticing the text changed, not by running the code, and dead code
# carrying the pinned text would not be noticed.

#: Relative to `RTC`, like every other target (`apply` reads
#: `RTC / mutation.file`).
VOICE_MOVE_POLICY = "voiceMovePolicy.ts"
#: The move ladder `moveDecision` (AFK) that the FE-2 merge made the ONLY
#: follow rule. Its spec also holds the `state.tsx` pins over the handler
#: that feeds it (the state-pin half), so several `state-*` entries name it.
#: 🔴 By far the slowest spec any entry names (it sweeps millions of worlds),
#: and an entry pays for it once per listing in `specs` and `must_red`. No
#: number here, for the reason given at `SPEC_TIMEOUT_S`.
MOVE_POLICY = "movePolicy.ts"
MOVE_POLICY_SPEC = "components/rtc/movePolicy.test.ts"
STATE_WIRING_SPEC = "components/rtc/stateWiring.test.ts"
VOICE_MOVE_SPEC = "components/rtc/voiceMovePolicy.test.ts"

MUTATIONS += [
    # ---- the wiring in state.tsx (killed by the source pins) ----------------
    #
    # FE-2 retargeted the three F1 entries below from voice-move's
    # `#followMove` / `shouldObeyMove` pair, which the AFK merge retired (D3),
    # to the one merged handler `#handleVoiceMove`. The failure mode each
    # re-introduces is unchanged: the verdict "this token was minted for THIS
    # connection" stops being computed from this connection's identity. It now
    # feeds `moveDecision` (movePolicy.ts), so `movePolicy.test.ts`'s
    # state-pin half must see each one too.
    Mutation(
        id="state-move-token-check-bypassed",
        what="`#handleVoiceMove` hands `moveDecision` a constant `tokenForThisConnection: true`, so a device the user's own other session removed follows that session's move back into the call (F1)",
        file=STATE,
        search="""      tokenForThisConnection: forThisConnection,
""",
        replace="""      tokenForThisConnection: true,
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-move-token-wrong-identity",
        what="`#handleVoiceMove` checks the move's token against the bare user id instead of the identity this connection last held, so a token minted for another session's identity reads as this connection's (F1)",
        file=STATE,
        search="""      expectedIdentity: this.#lastLocalIdentity ?? "",
""",
        replace="""      expectedIdentity: this.getClient()?.user?.id ?? "",
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-move-verdict-or-true",
        what="`#handleVoiceMove`'s token verdict gains an appended `|| true`, so every move reads as minted for this connection and a device the user's own other session removed follows that session's move (F1; the pinned text is still there, as a prefix)",
        file=STATE,
        search="""      expectedIdentity: this.#lastLocalIdentity ?? "",
      to: move.to,
    });
""",
        replace="""      expectedIdentity: this.#lastLocalIdentity ?? "",
      to: move.to,
    }) || true;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-last-identity-gen-guard-dropped",
        what="the connected listener records `#lastLocalIdentity` without its generation check, so a superseded Room connecting late overwrites the identity the move rule compares against (F1)",
        file=STATE,
        search="""      if (gen === this.#connectGen)
        this.#lastLocalIdentity = room.localParticipant.identity;
""",
        replace="""      this.#lastLocalIdentity = room.localParticipant.identity;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-last-identity-suffix",
        what="the connected listener records only the user-id part of the identity (`.split(\":\")[0]`), so a token minted for another session's `user:device` identity is compared against the bare user id (F1; the pinned text is still there, as a prefix)",
        file=STATE,
        search="""        this.#lastLocalIdentity = room.localParticipant.identity;
""",
        replace="""        this.#lastLocalIdentity = room.localParticipant.identity.split(":")[0];
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-last-identity-written-at-connect",
        what="`#lastLocalIdentity` is also written when the Room is created, from the bare user id, so it names an identity the connection never held until (and unless) it connects (F1)",
        file=STATE,
        search="""      this.#setRoom(room);
      this.#setChannel(channel);
      this.#setState("CONNECTING");
""",
        replace="""      this.#setRoom(room);
      this.#setChannel(channel);
      this.#lastLocalIdentity = this.getClient()?.user?.id;
      this.#setState("CONNECTING");
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-f4-latch-reads-joinblocked",
        what="the decision after M3 reads the latch through `joinBlocked`, which answers \"in-flight\" inside the attempt, so `answer_latch` is unreachable and a dropped move token joins past a refusal that still holds (F4)",
        file=STATE,
        search="""        bypassedRefusal !== undefined && this.#refusalLatchHolds(channel),
""",
        replace="""        bypassedRefusal !== undefined && this.joinBlocked(channel) === "refused",
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-f4-latch-helper-sees-in-flight",
        what="`#refusalLatchHolds` passes the in-flight channel, so it reads \"in-flight\" for the attempt asking and never \"refused\": `answer_latch` is unreachable again (F4)",
        file=STATE,
        search="""    return this.#joinBlockedWith(channel, undefined) === "refused";
""",
        replace="""    return this.#joinBlockedWith(channel, this.joinPending()) === "refused";
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-joinblockedwith-reads-pending",
        what="`#joinBlockedWith` looks the in-flight attempt up itself instead of using what its caller passed, so `#refusalLatchHolds` reads \"in-flight\" inside the attempt and `answer_latch` is unreachable again (D1/F4)",
        file=STATE,
        search="""      inFlightChannelId,
      latch,
""",
        replace="""      inFlightChannelId: this.joinPending(),
      latch,
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-joinblocked-drops-in-flight",
        what="the public `joinBlocked` passes no in-flight channel, so a join affordance stays live while its own attempt is in flight (D1)",
        file=STATE,
        search="""    return this.#joinBlockedWith(channel, this.joinPending());
""",
        replace="""    return this.#joinBlockedWith(channel, undefined);
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-f4-answer-latch-joins",
        what="the `answer_latch` arm drops the token and falls through to the normal join instead of answering from the latch, so a refusal the move bypassed is joined past anyway (F4)",
        file=STATE,
        search="""        this.disconnect();
        this.onErr(new Error(this.#joinRefusalText(channel, bypassedRefusal!)));
        return false;
""",
        replace="""        auth = undefined;
        break;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-latch-bypass-any-reason",
        what="`connect()` lets a move token past ANY latched refusal, not only the ones `moveBypassesRefusalLatch` allows, so a move steps past a device or encryption refusal (S1)",
        file=STATE,
        search="""        auth &&
        opts?.moveLatchBypass &&
        moveBypassesRefusalLatch(latchedReason)
""",
        replace="""        auth &&
        opts?.moveLatchBypass
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-latch-bypass-without-token",
        what="`connect()` honors `moveLatchBypass` with no move token in hand, so a caller passing the option steps past a latched refusal on its own (S1)",
        file=STATE,
        search="""        auth &&
        opts?.moveLatchBypass &&
""",
        replace="""        opts?.moveLatchBypass &&
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-chip-publications-inline-desired",
        what="the chip's remote publications are mapped inline again with `desired: true`, so an unwatched share never reads undesired and F2's share-only contradiction is off for every participant",
        file=STATE,
        search="""                  publications: chipPublicationsOf(
                    p.trackPublications.values(),
                  ),
""",
        replace="""                  publications: [...p.trackPublications.values()].map(
                    (pub) => ({
                      source: pub.source,
                      desired: true,
                      subscribed: pub.isSubscribed,
                      encryption: pub.trackInfo?.encryption,
                    }),
                  ),
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-chip-subscription-listener-removed",
        what="nothing listens for `trackSubscriptionStatusChanged`, so Stop watching flips `isDesired` without re-deriving the chip, which keeps reading the stale state (F2)",
        file=STATE,
        search="""    room.addListener("trackSubscriptionStatusChanged", () => {
      if (this.room() !== room) return;
      this.#setChipPublicationsVersion((v) => v + 1);
    });
""",
        replace="",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-chip-reconnect-bump-removed",
        what="the `reconnected` listener no longer bumps the chip's publication version, so a subscription change whose event `SignalResumed` discarded never re-derives the chip (F2)",
        file=STATE,
        search="""      this.#seedLiveRemoteShares(room);
      // The same discard can eat a `trackSubscriptionStatusChanged` (below).
      this.#setChipPublicationsVersion((v) => v + 1);
""",
        replace="""      this.#seedLiveRemoteShares(room);
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-chip-version-read-removed",
        what="`callEncryptionChip()` no longer reads the publication version, so the bumps above re-run nothing and the chip keeps a stale desired/subscribed reading (F2)",
        file=STATE,
        search="""    this.#chipPublicationsVersion();
    const room = this.room();
""",
        replace="""    const room = this.room();
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-move-event-name-unchecked",
        what="the move event's name loses `satisfies keyof Events`, so a misspelling (or an SDK rename) registers a listener that never fires and no move is ever followed, with tsc green",
        file=STATE,
        search="""const VOICE_MOVE_REQUESTED = "voiceMoveRequested" satisfies keyof Events;
""",
        replace="""const VOICE_MOVE_REQUESTED: string = "voiceMoveRequested";
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    # ---- the decisions in voiceMovePolicy.ts --------------------------------
    #
    # RETIRED by FE-2: `move-policy-disconnected-token-dropped` and
    # `move-policy-reconnecting-token-ignored`. Both edited `shouldObeyMove`,
    # which the AFK merge deleted (D3) along with `moveTokenForConnection`; the
    # rule they guarded (a dropped or reconnecting seat follows a move only
    # with proof it is the seat addressed, F1) is now `moveDecision`'s steps 4
    # and 5 in movePolicy.ts. The `move-decision-*` entries below re-introduce
    # the same failure there: `move-decision-step4-device-match`,
    # `move-decision-bare-identity-proves-seat` and
    # `move-decision-tokenless-marker-proves-seat`.
    Mutation(
        id="move-policy-dropped-token-always-joins",
        what="`moveAuthDecision` ignores `latchStillRefused` and joins normally with any dropped token, so a move whose token M3 rejected joins past the refusal latch it bypassed (F4, fail open)",
        file=VOICE_MOVE_POLICY,
        search="""  return input.latchStillRefused ? "answer_latch" : "join";
""",
        replace="""  return "join";
""",
        specs=[VOICE_MOVE_SPEC],
        must_red=[VOICE_MOVE_SPEC],
    ),
    Mutation(
        id="move-policy-dropped-token-always-answers",
        what="`moveAuthDecision` ignores `latchStillRefused` and answers from the latch for every dropped token, so a move into a channel whose latch has cleared is refused (F4, fail closed but wrong)",
        file=VOICE_MOVE_POLICY,
        search="""  return input.latchStillRefused ? "answer_latch" : "join";
""",
        replace="""  return "answer_latch";
""",
        specs=[VOICE_MOVE_SPEC],
        must_red=[VOICE_MOVE_SPEC],
    ),
    Mutation(
        id="move-policy-bypass-allowlist-widened",
        what="the move bypass allowlist gains `DeviceNotRegistered`, so a move token steps past a device refusal that no moderator can waive (S1)",
        file=VOICE_MOVE_POLICY,
        search="""  "MissingPermission",
  "CannotJoinCall",
]);
""",
        replace="""  "MissingPermission",
  "CannotJoinCall",
  "DeviceNotRegistered",
]);
""",
        specs=[VOICE_MOVE_SPEC],
        must_red=[VOICE_MOVE_SPEC],
    ),
    # ---- the F2 mapping in chipInputs.ts ------------------------------------
    Mutation(
        id="chip-pubs-desired-constant",
        what="`chipPublicationsOf` maps every publication as desired, so an unwatched share never reads undesired and F2's share-only contradiction never applies",
        file=CHIP,
        search="""    desired: pub.isDesired,
""",
        replace="""    desired: true,
""",
        specs=[CHIP_SPEC],
        must_red=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-pubs-subscribed-dropped",
        what="`chipPublicationsOf` drops `subscribed`, so F2 reads every publication as unsubscribed",
        file=CHIP,
        search="""    subscribed: pub.isSubscribed,
""",
        replace="",
        specs=[CHIP_SPEC],
        must_red=[CHIP_SPEC],
    ),
    Mutation(
        id="chip-pubs-encryption-defaulted",
        what="`chipPublicationsOf` defaults a missing declaration to GCM, so a share whose `trackInfo.encryption` was dropped reads as declared encrypted",
        file=CHIP,
        search="""    encryption: pub.trackInfo?.encryption,
  }));
""",
        replace="""    encryption: pub.trackInfo?.encryption ?? 1,
  }));
""",
        specs=[CHIP_SPEC],
        must_red=[CHIP_SPEC],
    ),
]


# --- The AFK x voice-move client merge (FE-2) ---------------------------------
#
# The merge replaced voice-move's `#followMove` / `shouldObeyMove` with AFK's
# `moveDecision` ladder behind one handler, `#handleVoiceMove`, and added a
# client-side gate (a move never joins a channel whose age, password or
# spoiler check this member has not passed on this device), a tokenless `join`
# arm, the SEC5-1 recompute (M3 drops a token not minted for the identity the
# attempt requests), and the member surfaces' refusal copy. Most entries here
# are a lane's known-bad control carried over verbatim, and every one was run
# red on each spec in its `must_red` before it was added. As above, a
# `file=STATE` entry (and every surface entry) is killed by a source pin
# noticing the text changed, not by running the code.
#
# D8: nothing here touches the stoat.js submodule. The FE1-2 redaction pin's
# control (`console.debug("[S->C]", event)` in the SDK's two log sites) runs
# once, in place, outside this suite; `preflight` refuses any target outside
# this package.

#: Relative to `RTC`, like every other target (`apply` reads
#: `RTC / mutation.file`), so the files outside `components/rtc` climb out.
IDLE_POLICY = "idlePolicy.ts"
CALL_MODERATION_POLICY = "callModerationPolicy.ts"
SOURCE_PINS_HARNESS = "sourcePins.harness.ts"
MEMBER_GATE = "../../src/interface/channels/memberGate.ts"
USER_CONTEXT_MENU = "../app/menus/UserContextMenu.tsx"
SERVER_SIDEBAR = "../../src/interface/navigation/channels/ServerSidebar.tsx"
VOICE_CHANNEL_PREVIEW = "../ui/components/features/voice/VoiceChannelPreview.tsx"
CHANNEL_OVERVIEW = "../app/interface/settings/channel/Overview.tsx"
IDLE_POLICY_SPEC = "components/rtc/idlePolicy.test.ts"
CALL_MODERATION_SPEC = "components/rtc/callModerationPolicy.test.ts"
VOICE_REJOIN_SPEC = "components/rtc/voiceRejoinPolicy.test.ts"
#: Source pins over the member surfaces a move starts from: the member
#: menu, the sidebar's drag-to-move and the voice channel preview's drag.
MOVE_SURFACE_PINS_SPEC = "components/rtc/moveSurfacePins.test.ts"
#: 🔴 Carries one OPT-IN skip (the backend literal cross-check) whenever
#: `SLOGA_BACKEND_DIR` is unset. `baseline_green` records it and every mutant
#: must reproduce it, so the skip neither hides a catch nor counts as one.
MEMBER_GATE_SPEC = "src/interface/channels/memberGate.test.ts"
AFK_CHANNEL_SETTINGS_SPEC = "src/lib/afkChannelSettings.test.ts"

MUTATIONS += [
    # ---- the move handler and M3 in state.tsx (source pins) -----------------
    Mutation(
        id="state-move-gated-block-cards",
        what="the gated-destination block puts the destination on the call card, so its Rejoin (an ordinary join) walks straight past the age, password or spoiler check (FE2A-1 a)",
        file=STATE,
        search="""        this.#replacedLeftAt = undefined;
        const destinationName = destination.name;
""",
        replace="""        this.#replacedLeftAt = undefined;
        this.#setChannel(destination);
        const destinationName = destination.name;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-member-gate-default-open",
        what="the member gate's default answers 'not gated', so a Voice built before `setMemberGate` runs follows a move into any checked channel (FE2A-1 b, fail open)",
        file=STATE,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""  #memberGate: (channel: Channel) => boolean = () => true;""",
        replace="""  #memberGate: (channel: Channel) => boolean = () => false;""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-member-gate-unwired",
        what="VoiceContext never calls `setMemberGate`, so the handler asks the default and never the member's real unlocks: every move is refused as gated (FE2A-1 c)",
        file=STATE,
        search="""  voice.setMemberGate((channel) =>
    isChannelGatedForMember(
      channel,
      (key) => state.layout.getSectionState(key, false),
      LAYOUT_SECTIONS.MATURE,
    ),
  );
""",
        replace="""""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-member-gate-inverted",
        what="the handler inverts the member gate, so a move follows exactly into the channels whose check this member has NOT passed (FE2A-1 d)",
        file=STATE,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""    const gated = destination !== undefined && this.#memberGate(destination);""",
        replace="""    const gated = destination !== undefined && !this.#memberGate(destination);""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-move-gated-block-falls-through",
        what="the gated-destination block loses its `return`, so after the refusal it falls through to the card batch and the destination lands on the card (FE2A-1)",
        file=STATE,
        search="""          ),
        );
        return;
      }
      // Every other arm resolved""",
        replace="""          ),
        );
      }
      // Every other arm resolved""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-move-gated-constant-false",
        what="the handler's gate verdict is a constant `false`, so no move is ever refused for a checked destination (FE0-3)",
        file=STATE,
        search="""    const gated = destination !== undefined && this.#memberGate(destination);
""",
        replace="""    const gated = false;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-move-destination-gated-false",
        what="`moveDecision` is handed `destinationGated: false`, so the gate's verdict is computed and then thrown away (FE0-3)",
        file=STATE,
        search="""      destinationGated: gated,
""",
        replace="""      destinationGated: false,
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-m3-join-keeps-token",
        what="M3's `join` arm no longer drops the token, so a device-qualified attempt dials with a bare token it did not mint (SEC5-1, FE2A-4 a)",
        file=STATE,
        search="""        auth = undefined;
        preConnectDeadlineAt = undefined;
""",
        replace="""        preConnectDeadlineAt = undefined;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-m3-join-keeps-budget",
        what="M3's `join` arm drops the token but keeps the move's pre-connect budget, so an ordinary join runs under the 3 s clamp meant for a ticking token and trips a spurious `hold_loud` (C3)",
        file=STATE,
        search="""        auth = undefined;
        preConnectDeadlineAt = undefined;
""",
        replace="""        auth = undefined;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-m3-identity-always-bare",
        what="M3's expected identity is always the bare user id, so a device seat keeps a bare token and connects as an identity it did not ask for (SEC5-1)",
        file=STATE,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""              ? `${selfUserId}:${e2eeDeviceId}`
""",
        replace="""              ? selfUserId
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-premintedauth-hoisted",
        what="`preMintedAuth` is computed above M3's switch, so a token M3 dropped still reads as pre-minted and the session-device writes treat an ordinary join as the server's identity (C3)",
        file=STATE,
        search="""    switch (authDecision) {
      case "use":
        break;
      case "join":
        // The dropped token takes its clock with it: this attempt mints its
        // own token below, after setup, like any other join.
        auth = undefined;
        preConnectDeadlineAt = undefined;
        break;
      case "answer_latch":
        // No await separates this from the generation check after the
        // device enumeration, so this cannot fail today. It stays so that
        // an await added above can never raise a superseded attempt's
        // refusal over the newer call.
        if (gen !== this.#connectGen) return false;
        // `connect()` has already left the previous call; `disconnect()`
        // releases the worker and provider constructed above (no Room
        // exists yet). `latchStillRefused` implies `bypassedRefusal`.
        this.disconnect();
        this.onErr(new Error(this.#joinRefusalText(channel, bypassedRefusal!)));
        return false;
      default: {
        const exhaustive: never = authDecision;
        return exhaustive;
      }
    }

    /**
     * TRUE when this attempt connects with a token it did not mint — a move
     * whose token M3 kept. Kept distinct from `isMove` deliberately: that one
     * asks whether this attempt STARTED as a move, this one asks whether the
     * identity we present is the SERVER's choice rather than ours, which is
     * the question both `#sessionDeviceId` writes turn on. Read only after
     * M3: a dropped token is an ordinary join, identity and all.
     */
    const preMintedAuth = auth !== undefined;
""",
        replace="""    const preMintedAuth = auth !== undefined;
    switch (authDecision) {
      case "use":
        break;
      case "join":
        // The dropped token takes its clock with it: this attempt mints its
        // own token below, after setup, like any other join.
        auth = undefined;
        preConnectDeadlineAt = undefined;
        break;
      case "answer_latch":
        // No await separates this from the generation check after the
        // device enumeration, so this cannot fail today. It stays so that
        // an await added above can never raise a superseded attempt's
        // refusal over the newer call.
        if (gen !== this.#connectGen) return false;
        // `connect()` has already left the previous call; `disconnect()`
        // releases the worker and provider constructed above (no Room
        // exists yet). `latchStillRefused` implies `bypassedRefusal`.
        this.disconnect();
        this.onErr(new Error(this.#joinRefusalText(channel, bypassedRefusal!)));
        return false;
      default: {
        const exhaustive: never = authDecision;
        return exhaustive;
      }
    }

    /**
     * TRUE when this attempt connects with a token it did not mint — a move
     * whose token M3 kept. Kept distinct from `isMove` deliberately: that one
     * asks whether this attempt STARTED as a move, this one asks whether the
     * identity we present is the SERVER's choice rather than ours, which is
     * the question both `#sessionDeviceId` writes turn on. Read only after
     * M3: a dropped token is an ordinary join, identity and all.
     */
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-m3-extra-auth-write",
        what="a second write to `auth` after M3, so the keep/drop decision is no longer the only place the dialed token is chosen (SEC5-1, FE2A-4)",
        file=STATE,
        search="""    const preMintedAuth = auth !== undefined;
""",
        replace="""    if (bypassedRefusal !== undefined) auth ??= undefined;
    const preMintedAuth = auth !== undefined;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-m3-decision-conditional",
        what="`moveAuthDecision` runs only inside an `if`, so an attempt reaching the dial without passing it keeps whatever token it holds (SEC5-1, FE2A-4)",
        file=STATE,
        search="""    const authDecision = moveAuthDecision({
""",
        replace="""    let authDecision: ReturnType<typeof moveAuthDecision> = "use";
    if (auth) authDecision = moveAuthDecision({
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-tokenless-arm-latch-bypass",
        what="the tokenless `join` arm passes `moveLatchBypass: true`, so a move with no token steps past a latched refusal the moment `connect()`'s `auth &&` guard is relaxed (D4, S1)",
        file=STATE,
        search="""        attempt = this.connect(destination);
""",
        replace="""        attempt = this.connect(destination, undefined, {
          moveLatchBypass: true,
        });
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-tokenless-arm-budget",
        what="the tokenless `join` arm passes the move's pre-connect budget, so an ordinary join that mints its own token runs under the clamp meant for a ticking one (D2)",
        file=STATE,
        search="""        attempt = this.connect(destination);
""",
        replace="""        attempt = this.connect(destination, undefined, {
          movePreConnectBudgetMs: MOVE_PRECONNECT_BUDGET_MS,
        });
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-d5-retry-under-budget",
        what="the D5 retry after a failed token arm runs under the move budget, so the one plain join meant to recover a dead token is clamped as if it held one (D5)",
        file=STATE,
        search="""          joined = await this.connect(destination);
""",
        replace="""          joined = await this.connect(destination, undefined, {
            movePreConnectBudgetMs: MOVE_PRECONNECT_BUDGET_MS,
          });
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-token-arm-no-latch-bypass",
        what="the token arm stops passing `moveLatchBypass`, so a moderator's move into a channel the member was refused answers from the latch instead of joining (S1)",
        file=STATE,
        search="""            moveLatchBypass: true,
""",
        replace="""""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-move-releases-join-refusal",
        what="the handler releases the destination's join-refusal latch before joining, so a refusal the tokenless join should have answered from is cleared for every later join too (D4)",
        file=STATE,
        search="""    const startedAt = Date.now();
""",
        replace="""    this.#releaseJoinRefusal(destination.id);
    const startedAt = Date.now();
""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-attempt-drops-latched-reason",
        what="`connect()` stops handing `#connectAttempt` the latched reason, so a dropped move token can no longer answer from the refusal it bypassed (F4)",
        file=STATE,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""      return await this.#connectAttempt(channel, auth, opts, latchedReason);""",
        replace="""      return await this.#connectAttempt(channel, auth, opts);""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC, VOICE_REJOIN_SPEC],
    ),
    Mutation(
        id="state-identity-is-device-constant",
        what="the handler reports every identity as device-qualified, so a bare seat with a fresh marker and a matching bare token follows a move its sibling session was kicked for (FE2A-2)",
        file=STATE,
        search="""    const identityIsDevice = (this.#lastLocalIdentity ?? "").includes(":");
""",
        replace="""    const identityIsDevice = true;
""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-move-handler-logs-error",
        what="the handler logs the token arm's error object, whose LiveKit signal URL carries `access_token=` (FE2A-12)",
        file=STATE,
        search="""    } catch {
      // D5: one plain join""",
        replace="""    } catch (error) {
      console.error("[rtc] move failed", error);
      // D5: one plain join""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-move-listener-legacy-name",
        what="the move listener subscribes to `\"userMoveVoiceChannel\"`, which stoat.js no longer emits, so no move is ever followed and tsc stays green through `as never` (FE1-1)",
        file=STATE,
        search="""      client.addListener(VOICE_MOVE_REQUESTED, handler);
""",
        replace="""      client.addListener("userMoveVoiceChannel" as never, handler);
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-move-listener-doubled",
        what="the move listener is registered twice, so every move event is handled twice",
        file=STATE,
        search="""      client.addListener(VOICE_MOVE_REQUESTED, handler);
""",
        replace="""      client.addListener(VOICE_MOVE_REQUESTED, handler);
      client.addListener(VOICE_MOVE_REQUESTED, handler);
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="state-move-event-name-legacy",
        what="the move event constant names `\"userMoveVoiceChannel\"`, the retired event, so the listener never fires (FE1-1; tsc also catches this one, the mutation suite does not run tsc)",
        file=STATE,
        search="""const VOICE_MOVE_REQUESTED = "voiceMoveRequested" satisfies keyof Events;""",
        replace="""const VOICE_MOVE_REQUESTED = "userMoveVoiceChannel" satisfies keyof Events;""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC, MOVE_POLICY_SPEC],
    ),
    # ---- the move ladder in movePolicy.ts -----------------------------------
    Mutation(
        id="move-decision-step4-device-match",
        what="step 4 goes back to the device match: a fresh marker on a seat whose token was not minted for it follows the move a sibling session was kicked for (F1, D1)",
        file=MOVE_POLICY,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""  const labelMatches = nonceGate ? nonceMatches : tokenProvesSeat;""",
        replace="""  const labelMatches = nonceGate ? nonceMatches : deviceMatches;""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="move-decision-bare-identity-proves-seat",
        what="the token proof drops the device-qualified identity conjunct, so a bare seat's fresh marker plus a bare token follows a move with a live mic (FE2A-2)",
        file=MOVE_POLICY,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""    !!world.token && world.tokenForThisConnection && world.lastIdentityIsDevice;""",
        replace="""    !!world.token && world.tokenForThisConnection;""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="move-decision-tokenless-marker-proves-seat",
        what="the token proof drops `!!world.token`, so a fresh marker with no token at all counts as proof and a tokenless seat joins (FE2WA-2)",
        file=MOVE_POLICY,
        search="""    !!world.token && world.tokenForThisConnection && world.lastIdentityIsDevice;""",
        replace="""    world.tokenForThisConnection && world.lastIdentityIsDevice;""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="move-decision-gate-ignored",
        what="the ladder ignores the destination's gate, so a move follows into a channel whose age, password or spoiler check this member has not passed (FE0-3)",
        file=MOVE_POLICY,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""  const gatedDestination = world.destinationKnown && world.destinationGated;""",
        replace="""  const gatedDestination = false;""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="move-decision-gate-not-over-carded-arms",
        what="a gated destination no longer replaces the carded fail-loud arms, so `unverified-session` / `stale-notice` put a checked channel on the card and its Rejoin walks past the check (FE0-3)",
        file=MOVE_POLICY,
        search="""    gatedDestination
      ? { action: "fail-loud", reason: "gated-destination" }
      : { action: "fail-loud", reason };""",
        replace="""    false
      ? { action: "fail-loud", reason: "gated-destination" }
      : { action: "fail-loud", reason };""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="move-decision-tokenless-moves",
        what="the tokenless tail answers `move` with an empty token and URL instead of an ordinary `join`, so a move event without a token dials an empty URL instead of joining (D2)",
        file=MOVE_POLICY,
        search="""    return { action: "join", to: world.to };""",
        replace="""    return { action: "move", url: world.url ?? "", token: world.token ?? "", to: world.to };""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="move-decision-foreign-token-moves",
        what="the token arm stops requiring the token be this connection's, so a token minted for another identity is passed through and dialed (FE2WA-9)",
        file=MOVE_POLICY,
        search="""      world.token &&
      world.tokenForThisConnection &&
""",
        replace="""      world.token &&
""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="move-decision-negative-marker-age-fresh",
        what="a marker stamped in the future (negative age) counts as fresh, so a clock skew makes a stale drop follow the move (FE2WA-3)",
        file=MOVE_POLICY,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""    markerAgeMs >= 0 &&""",
        replace="""    markerAgeMs >= -Infinity &&""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="move-decision-negative-replaced-age-fresh",
        what="a replaced connection stamped in the future counts as fresh, so the S-a record matches under clock skew (FE2WA-3)",
        file=MOVE_POLICY,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""      replacedAgeMs >= 0 &&""",
        replace="""      replacedAgeMs >= -Infinity &&""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    Mutation(
        id="move-decision-empty-from-acts",
        what="an event with an empty `from` is no longer ignored, so a move naming no source channel is acted on (FE2WA-4)",
        file=MOVE_POLICY,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""  if (!world.from)""",
        replace="""  if (false)""",
        specs=[MOVE_POLICY_SPEC],
        must_red=[MOVE_POLICY_SPEC],
    ),
    # ---- the token check in voiceMovePolicy.ts (SEC5-1) ---------------------
    Mutation(
        id="move-policy-token-usable-ignores-identity",
        what="`moveTokenUsable` stops comparing the token's `sub` with the identity this attempt would request, so a bare token is used by a device seat (SEC5-1, FE2A-4 b)",
        file=VOICE_MOVE_POLICY,
        search="""  return claims.sub === input.expectedIdentity && claims.room === input.to;
""",
        replace="""  return claims.room === input.to;
""",
        specs=[VOICE_MOVE_SPEC],
        must_red=[VOICE_MOVE_SPEC],
    ),
    Mutation(
        id="move-policy-token-usable-ignores-room",
        what="`moveTokenUsable` stops comparing the token's room with the destination, so a token for another room counts as this move's (SEC5-1, FE2A-4 c)",
        file=VOICE_MOVE_POLICY,
        search="""  return claims.sub === input.expectedIdentity && claims.room === input.to;
""",
        replace="""  return claims.sub === input.expectedIdentity;
""",
        specs=[VOICE_MOVE_SPEC],
        must_red=[VOICE_MOVE_SPEC],
    ),
    # ---- the idle latch, the moderation offer, the member gate --------------
    Mutation(
        id="idle-latch-drops-not-owner",
        what="the idle beacon's latch set loses `NotOwner`, so a 403 for a foreign or stale session is retried with backoff instead of stopping this connection's beacon",
        file=IDLE_POLICY,
        search="""  "NotAVoiceChannel",
  "NotOwner",
];
""",
        replace="""  "NotAVoiceChannel",
];
""",
        specs=[IDLE_POLICY_SPEC],
        must_red=[IDLE_POLICY_SPEC],
    ),
    Mutation(
        id="call-moderation-moves-bots",
        what="`canOfferMove` ignores `isBot`, so the menu offers Move for a bot and every press is refused with IsBot",
        file=CALL_MODERATION_POLICY,
        search="""  if (subject.isBot) return false;
""",
        replace="""""",
        specs=[CALL_MODERATION_SPEC],
        must_red=[CALL_MODERATION_SPEC],
    ),
    Mutation(
        id="member-gate-thread-ungated",
        what="`channelHasClientGate` answers `false` for a thread, so a thread under a checked parent can be made the AFK channel and the sweep moves members past the parent's check (FE2A-1)",
        file=MEMBER_GATE,
        search="""  if (channel.isThread) return true;
""",
        replace="""  if (channel.isThread) return false;
""",
        specs=[MEMBER_GATE_SPEC],
        must_red=[MEMBER_GATE_SPEC],
    ),
    Mutation(
        id="member-gate-skips-gate-source",
        what="`isChannelGatedForMember` reads the thread's own flags and unlocks instead of its parent's, so a thread under a checked parent reads as ungated (FE2A-1)",
        file=MEMBER_GATE,
        search="""  const source = gateSource(channel);
""",
        replace="""  const source = channel;
""",
        specs=[MEMBER_GATE_SPEC],
        must_red=[MEMBER_GATE_SPEC],
    ),
    # ---- the member surfaces a move starts from (source pins) ---------------
    Mutation(
        id="move-menu-self-filter-removed",
        what="the self Move menu stops filtering out gated channels, so a member can move themselves into a channel whose check they have not passed (D7)",
        file=USER_CONTEXT_MENU,
        search="""      props.user.self
        ? channels.filter(""",
        replace="""      false
        ? channels.filter(""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-menu-gate-filter-applied-to-all",
        what="the member's own gate filter is applied to moving OTHERS too, so a moderator cannot move someone into a channel the moderator has not unlocked (D7)",
        file=USER_CONTEXT_MENU,
        search="""      props.user.self
        ? channels.filter(""",
        replace="""      true
        ? channels.filter(""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-menu-isbot-false",
        what="the menu tells the moderation policy no subject is a bot, so Move is offered for bots (B4)",
        file=USER_CONTEXT_MENU,
        search="""        isBot: !!props.user.bot,""",
        replace="""        isBot: false,""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-menu-logs-error",
        what="the refused-move handler logs the raw error object beside its kind",
        file=USER_CONTEXT_MENU,
        search="""    console.error("Voice move refused:", kind);""",
        replace="""    console.error("Voice move refused:", kind, err);""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-menu-others-copy-drift",
        what="the moving-others refusal copy drifts from the FROZEN map (FE2A-9)",
        file=USER_CONTEXT_MENU,
        search="""        return t`Bots can't be moved between voice channels.`;""",
        replace="""        return t`Bots can't be moved between voice channels!`;""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-menu-self-others-swapped",
        what="the self and others refusal maps are swapped, so a member moving themselves is told about 'them' (FE2A-9)",
        file=USER_CONTEXT_MENU,
        search="""      message: self ? selfMoveRefusal(kind) : otherMoveRefusal(kind),""",
        replace="""      message: self ? otherMoveRefusal(kind) : selfMoveRefusal(kind),""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-menu-self-copy-drift",
        what="the moving-self refusal copy drifts from the FROZEN map (FE2A-9)",
        file=USER_CONTEXT_MENU,
        search="""        return t`You can only move yourself from the device that's in the call.`;""",
        replace="""        return t`You can only move yourself from the device that's in the call!`;""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-menu-refusal-signs-out",
        what="a `not-authenticated` move refusal signs the member out, though it only means the move came from another device",
        file=USER_CONTEXT_MENU,
        search="""    console.error("Voice move refused:", kind);
""",
        replace="""    console.error("Voice move refused:", kind);
    if (kind === "not-authenticated") void client().logout();
""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-sidebar-gate-fails-open",
        what="the sidebar reads a missing unlock key as unlocked, so every checked channel reads as passed (fail open)",
        file=SERVER_SIDEBAR,
        search="""    (key) => state.layout.getSectionState(key, false),
    LAYOUT_SECTIONS.MATURE,
  );
}""",
        replace="""    (key) => state.layout.getSectionState(key, true),
    LAYOUT_SECTIONS.MATURE,
  );
}""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-sidebar-own-gate-copy",
        what="the sidebar grows its own `gateSource` call beside the shared member gate, a second copy of the rule that can drift",
        file=SERVER_SIDEBAR,
        search="""function isGatedFor(
""",
        replace="""const legacyGateSource = (c: Channel) => gateSource(c);
function isGatedFor(
""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-sidebar-drop-logs-error",
        what="the drag-to-move refusal logs the raw error object instead of its kind (B3)",
        file=SERVER_SIDEBAR,
        search="""        console.warn("[voice-move] drag-to-move refused:", kind);""",
        replace="""        console.warn("[voice-move] drag-to-move refused:", err);""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-sidebar-others-shows-self-copy",
        what="the sidebar's moving-others `not-connected` copy speaks to the mover about themselves (FE2A-9)",
        file=SERVER_SIDEBAR,
        search="""        return t`They're not in a voice call you can move them from.`;""",
        replace="""        return t`You're not in a voice call you can move from.`;""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-sidebar-self-copy-drift",
        what="the sidebar's moving-self refusal copy drifts from the FROZEN map (FE2A-9)",
        file=SERVER_SIDEBAR,
        search="""          return t`Couldn't move you to that channel.`;""",
        replace="""          return t`Couldn't move you to that channel!`;""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="move-drag-isbot-false",
        what="the voice-channel drag tells `canDragParticipant` no participant is a bot, so bots can be dragged and every drop is refused (B4)",
        file=VOICE_CHANNEL_PREVIEW,
        search="""      isBot: !!user().user?.bot,""",
        replace="""      isBot: false,""",
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    Mutation(
        id="source-pins-string-literal-always-true",
        what="the pin harness calls every argument a string literal, so `assertLogsOnly` passes a handler that logs an error object",
        file=SOURCE_PINS_HARNESS,
        search="""export function isStringLiteral(code: string): boolean {
  return (
""",
        replace="""export function isStringLiteral(code: string): boolean {
  return true || (
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="source-pins-console-calls-unseen",
        what="the pin harness finds no console calls at all, so every log-only pin passes vacuously",
        file=SOURCE_PINS_HARNESS,
        search='  return [...code.matchAll(/(?<![\\w$.])console\\.[\\w$]+\\(/g)].map((m) => {\n',
        replace='  return [...code.matchAll(/(?<![\\w$.])CONSOLE\\.[\\w$]+\\(/g)].map((m) => {\n',
        specs=[MOVE_SURFACE_PINS_SPEC],
        must_red=[MOVE_SURFACE_PINS_SPEC],
    ),
    # ---- the AFK channel's check rules in Overview.tsx ----------------------
    Mutation(
        id="afk-settings-spoiler-uncaught",
        what="the spoiler toggle loses its catch, so a refused save is an unhandled rejection with nothing shown",
        file=CHANNEL_OVERVIEW,
        search="""    } catch (error) {
      setSpoilerFailed(true);
      showError(error);
    } finally {
      setSpoilerSaving(false);""",
        replace="""    } finally {
      setSpoilerSaving(false);""",
        specs=[AFK_CHANNEL_SETTINGS_SPEC],
        must_red=[AFK_CHANNEL_SETTINGS_SPEC],
    ),
    Mutation(
        id="afk-settings-password-uncaught",
        what="the password save loses its catch, so a refused save is an unhandled rejection with nothing shown",
        file=CHANNEL_OVERVIEW,
        search="""    } catch (error) {
      setPwFailed(true);
      showError(error);
    } finally {
      setPwSaving(false);""",
        replace="""    } finally {
      setPwSaving(false);""",
        specs=[AFK_CHANNEL_SETTINGS_SPEC],
        must_red=[AFK_CHANNEL_SETTINGS_SPEC],
    ),
    Mutation(
        id="afk-settings-password-flag-stuck",
        what="the password save clears its saving flag inside the try, so a throw leaves the button disabled for good",
        file=CHANNEL_OVERVIEW,
        search="""    } catch (error) {
      setPwFailed(true);
      showError(error);
    } finally {
      setPwSaving(false);
    }""",
        replace="""      setPwSaving(false);
    } catch (error) {
      setPwFailed(true);
      showError(error);
    }""",
        specs=[AFK_CHANNEL_SETTINGS_SPEC],
        must_red=[AFK_CHANNEL_SETTINGS_SPEC],
    ),
    Mutation(
        id="afk-settings-gate-rule-inverted",
        what="the AFK-channel-can't-gain-a-check rule is inverted, so every OTHER channel's checks are disabled and the AFK channel's are open",
        file=CHANNEL_OVERVIEW,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""  const afkBlocksGate = (gateIsOn: boolean) => isDesignatedAfk() && !gateIsOn;""",
        replace="""  const afkBlocksGate = (gateIsOn: boolean) => !isDesignatedAfk() && !gateIsOn;""",
        specs=[AFK_CHANNEL_SETTINGS_SPEC],
        must_red=[AFK_CHANNEL_SETTINGS_SPEC],
    ),
    Mutation(
        id="afk-settings-make-afk-ungated",
        what="Make AFK Channel is enabled on a checked channel, so the backend refusal is the only thing stopping it",
        file=CHANNEL_OVERVIEW,
        # Re-anchored at MERGE-2 (2026-09-29, M2G): `apply` refuses a search
        # that starts mid-line (MFR-n3), so the search and replace now carry
        # the line's leading text. Same line, same edit: the mutated file is
        # byte-identical to the old mid-line form.
        search="""              isDisabled={afkSaving() || gateBlocksAfk()}""",
        replace="""              isDisabled={afkSaving()}""",
        specs=[AFK_CHANNEL_SETTINGS_SPEC],
        must_red=[AFK_CHANNEL_SETTINGS_SPEC],
    ),
    Mutation(
        id="afk-settings-mature-ungated",
        what="Mark as Mature stays enabled on the AFK channel",
        file=CHANNEL_OVERVIEW,
        # Retargeted 2026-10-04: main 4f48d894 nested the mature control two spaces deeper.
        search="""              isDisabled={afkBlocksGate(props.channel.mature)}
""",
        replace="""""",
        specs=[AFK_CHANNEL_SETTINGS_SPEC],
        must_red=[AFK_CHANNEL_SETTINGS_SPEC],
    ),
    Mutation(
        id="afk-settings-afk-rule-inverted",
        what="the checked-channel-can't-be-AFK rule is inverted, so only the current AFK channel is blocked from being made AFK",
        file=CHANNEL_OVERVIEW,
        search="""    !isDesignatedAfk() && channelHasClientGate(props.channel);""",
        replace="""    isDesignatedAfk() && channelHasClientGate(props.channel);""",
        specs=[AFK_CHANNEL_SETTINGS_SPEC],
        must_red=[AFK_CHANNEL_SETTINGS_SPEC],
    ),
    Mutation(
        id="afk-settings-notice-untranslated",
        what="the AFK-channel notice beside the spoiler control leaves its `<Trans>`, so it is never translated",
        file=CHANNEL_OVERVIEW,
        search="""          <Show when={afkBlocksGate(props.channel.isSpoiler)}>
            <Text>
              <Trans>""",
        replace="""          <Show when={afkBlocksGate(props.channel.isSpoiler)}>
            <Text>
              <span>""",
        specs=[AFK_CHANNEL_SETTINGS_SPEC],
        must_red=[AFK_CHANNEL_SETTINGS_SPEC],
    ),
    # The stripper fix's own guard: under the old `/\/\*[\s\S]*?\*\//g`
    # stripper this write sat inside the deleted span and every spec stayed
    # green.
    Mutation(
        id="afk-settings-null-pointer-late-in-overview",
        what="Remove Password also writes `afk_channel_id: null`, the 200 that changes nothing, in the part of Overview.tsx the old regex comment stripper deleted from `accept=\"image/*\"` on",
        file=CHANNEL_OVERVIEW,
        # Retargeted 2026-10-04: main 4f48d894 nested the password controls two spaces deeper.
        search="""                  setPwInput("");
                  setChannelPassword();
""",
        replace="""                  setPwInput("");
                  void props.channel.server?.edit({ afk_channel_id: null } as never);
                  setChannelPassword();
""",
        specs=[AFK_CHANNEL_SETTINGS_SPEC],
        must_red=[AFK_CHANNEL_SETTINGS_SPEC],
    ),
]


# --- The Android screen-share flip: leg lifecycle, leg grace, leg keys -------
#
# Wave 2 of the screen-share flip (G2). Four groups, one namespace each:
#
#  - `leg-*`: the leg lifecycle leaf `androidLegStartPolicy.ts` (stop
#    coalescing, the "not stopped" reading of a failed or hung native stop,
#    the connect generation, the JS-side group binding, FX1's stop on a key
#    cleared mid-connect) and the SOURCE PINS that hold the plugin wrapper
#    `androidScreenShare.ts` to delegating to it. A `file=ANDROID_SHARE`
#    entry is killed by the pin spec ("holds no live copy of the
#    lifecycle"), not by running the wrapper, which `node --test` cannot
#    load; the pins strip comments, so the same text in dead code would
#    still satisfy them.
#  - `grace-*`: the admit-grace decisions in `mlsAdmitGracePolicy.ts`
#    (`legOwnerPresent` with FX2's empty-owner guard, `admitGraceLedgerResets`,
#    `shouldRearmAdmitGrace`). Where the session spec also notices, it is
#    listed in `must_red` as MEASURED, not assumed: every `grace-*` entry was
#    run with `mlsCallSession.leggrace.test.ts` pinned, and the six that list
#    only the policy spec left it GREEN (the FX2 guard, the dropped
#    localIdentity, the suffix slice, the reset ignoring isLeg, the re-arm
#    ignoring legPublished, the re-arm honoring admitInProgress). The session
#    spec does not drive those shapes; the policy spec alone holds them.
#  - `session-*`: the call sites in `mlsCallSession.ts` (the settle loop's
#    bill THEN reset, the fail-closed `seenPublished`, the expiry's re-arm
#    inputs). Every one is pinned on `mlsCallSession.leggrace.test.ts`, which
#    holds them by source pins AND by behavior through the session harness.
#    None keys on `const isLeg = isScreenLeg(identity);` or the billing line
#    alone: both occur twice in the file.
#  - `keys-*`: F7's clear of the stale leg key on a legless epoch in
#    `mlsCallKeys.ts`.
#
# Nothing here keys on `state.tsx`, whose "different group" wording is stale.

#: Relative to `RTC`, like every other target (`apply` reads
#: `RTC / mutation.file`).
LEG_POLICY = "androidLegStartPolicy.ts"
ANDROID_SHARE = "androidScreenShare.ts"
ADMIT_GRACE_POLICY = "mlsAdmitGracePolicy.ts"
CALL_KEYS = "mlsCallKeys.ts"
LEG_POLICY_SPEC = "components/rtc/androidLegStartPolicy.test.ts"
ADMIT_GRACE_SPEC = "components/rtc/mlsAdmitGracePolicy.test.ts"
LEGGRACE_SPEC = "components/rtc/mlsCallSession.leggrace.test.ts"
CALL_KEYS_SPEC = "components/rtc/mlsCallKeys.test.ts"

MUTATIONS += [
    # ---- the leg lifecycle leaf ---------------------------------------------
    Mutation(
        id="leg-1a",
        what="concurrent leg stops no longer coalesce onto the one in flight, so each caller drives its own bridge stop",
        file=LEG_POLICY,
        search="""    if (this.#stopPromise) return this.#stopPromise;
""",
        replace="""    if (false) return this.#stopPromise;
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-1b",
        what="a settled leg stop stays memoized, so every later stop returns the old result and never reaches the bridge",
        file=LEG_POLICY,
        search="""    const attempt = this.#doStop().finally(() => {
      this.#stopPromise = undefined;
    });
""",
        replace="""    const attempt = this.#doStop();
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-2a",
        what="a rejected or hung native stop marks the leg down, so a share still on the wire reads as stopped",
        file=LEG_POLICY,
        search="""    } catch {
""",
        replace="""    } catch {
      this.#active = false;
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-2b",
        what="the native stop loses its timeout, so a stop that never settles hangs the caller forever",
        file=LEG_POLICY,
        search="""      await withTimeout(
        this.#bridge.stop(),
        this.#stopTimeoutMs,
        "screen share stop timed out",
      );
""",
        replace="""      await this.#bridge.stop();
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    # ---- the re-key bound (screen-share flip wave 4d, R11) ------------------
    # `setFrameKey` awaits the native re-key under `withTimeout`, so a push
    # that never settles REJECTS, which is the callers' fail-closed stop,
    # instead of hanging the provider's rotation with the leg still
    # encrypting under the previous epoch's key. `leg-rekey-timeout-dropped`
    # removes a timeout and must still finish: the spec bounds the hung push
    # itself (`settlesWithin(hung, 500)`), so the mutant fails an assertion
    # in about a second instead of riding out `SPEC_TIMEOUT_S`. Measured
    # 2026-10-04: `-unbounded` is held by the source pin's range check alone
    # (every behavior spec passes its own short bound, so none sees the
    # default), and `-swallowed` by behavior alone (the pin strips comments
    # and whitespace, and its text still matches inside the `try`).
    Mutation(
        id="leg-rekey-timeout-dropped",
        what="the native re-key loses its timeout, so a push that never settles hangs the rotation and leaves the leg on the old epoch's key",
        file=LEG_POLICY,
        search="""    await withTimeout(
      this.#bridge.setFrameKey({
        keyB64: key.keyB64,
        keyIndex: key.keyIndex,
        epoch: key.epoch,
      }),
      this.#frameKeyTimeoutMs,
      "screen share re-key timed out",
    );
""",
        replace="""    await this.#bridge.setFrameKey({
      keyB64: key.keyB64,
      keyIndex: key.keyIndex,
      epoch: key.epoch,
    });
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-rekey-timeout-swallowed",
        what="a re-key timeout is caught and the push resolves, so the caller never stops the leg and it keeps the old key silently",
        file=LEG_POLICY,
        search="""    await withTimeout(
      this.#bridge.setFrameKey({
        keyB64: key.keyB64,
        keyIndex: key.keyIndex,
        epoch: key.epoch,
      }),
      this.#frameKeyTimeoutMs,
      "screen share re-key timed out",
    );
""",
        replace="""    try {
      await withTimeout(
        this.#bridge.setFrameKey({
          keyB64: key.keyB64,
          keyIndex: key.keyIndex,
          epoch: key.epoch,
        }),
        this.#frameKeyTimeoutMs,
        "screen share re-key timed out",
      );
    } catch (e) {
      if (e instanceof Error && e.message === "screen share re-key timed out")
        return;
      throw e;
    }
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-rekey-timeout-unbounded",
        what="the app's default re-key bound is ten minutes, so a hung native push leaves the old key live far longer than a stop may take",
        file=LEG_POLICY,
        search="""export const FRAME_KEY_TIMEOUT_MS = 5_000;
""",
        replace="""export const FRAME_KEY_TIMEOUT_MS = 600_000;
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-rekey-timeout-unwired",
        what="the constructor drops its re-key bound, so every push races a timer that fires at once and a healthy re-key fails closed",
        file=LEG_POLICY,
        search="""    this.#frameKeyTimeoutMs = frameKeyTimeoutMs;
""",
        replace="",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-3a-stale-check",
        what="a connect resolving after its share was stopped still marks the leg active",
        file=LEG_POLICY,
        search="""    if (generation !== this.#connectGeneration) return;
    this.#active = true;
""",
        replace="""    this.#active = true;
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-3a-nativeStopped-bump",
        what="a native stopped event no longer orphans the connect in flight, so its resolution resurrects active()",
        file=LEG_POLICY,
        search="""    const wasActive = this.#active;
    this.#active = false;
    // Definitively down: orphan any connect still in flight so its
    // resolution cannot flip `#active` back on.
    this.#connectGeneration++;
""",
        replace="""    const wasActive = this.#active;
    this.#active = false;
    // Definitively down: orphan any connect still in flight so its
    // resolution cannot flip `#active` back on.
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-3b",
        what="a completed stop() no longer orphans the connect in flight, so its resolution brings the leg back up",
        file=LEG_POLICY,
        search="""    if (generation !== this.#connectGeneration) return;
    // Definitively down (native resolved the stop): orphan any connect still
    // in flight, as [nativeStopped] does.
    this.#connectGeneration++;
""",
        replace="""    if (generation !== this.#connectGeneration) return;
    // Definitively down (native resolved the stop): orphan any connect still
    // in flight, as [nativeStopped] does.
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-3c",
        what="a stale stop resolution is no longer generation-checked, so it stops the NEXT share",
        file=LEG_POLICY,
        search="""    if (generation !== this.#connectGeneration) return;
    // Definitively down (native resolved the stop): orphan any connect still
    // in flight, as [nativeStopped] does.
    this.#connectGeneration++;
""",
        replace="""    // Definitively down (native resolved the stop): orphan any connect still
    // in flight, as [nativeStopped] does.
    this.#connectGeneration++;
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-3d",
        what="a native stopped event announces even when the leg was already down, so the stop event and the stop resolution announce twice",
        file=LEG_POLICY,
        search="""    if (wasActive) this.#announce.stopped(reason ?? "error");
""",
        replace="""    if (true) this.#announce.stopped(reason ?? "error");
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-3d-x-doStop-active",
        what="a stop on an inactive leg still runs the active-leg teardown, so a stale connect is not orphaned and announces a user stop",
        file=LEG_POLICY,
        search="""    if (this.#active) {
      this.#active = false;
      this.#announce.stopped("user");
""",
        replace="""    if (true) {
      this.#active = false;
      this.#announce.stopped("user");
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-4a",
        what="a key from another MLS group is pushed to the leg instead of refused",
        file=LEG_POLICY,
        search="""    if (key.groupId !== this.#e2eeGroupId)
""",
        replace="""    if (false)
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-4b",
        what="a plaintext share keeps the previous share's group binding, so it accepts the old group's key",
        file=LEG_POLICY,
        search="""    this.#e2eeGroupId = e2ee?.groupId;
""",
        replace="""    if (e2ee) this.#e2eeGroupId = e2ee.groupId;
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-4c",
        what="the leg's group is bound only AFTER connect resolves, so a key pushed during connect is checked against the wrong group",
        file=LEG_POLICY,
        search="""    this.#e2eeGroupId = e2ee?.groupId;
    const generation = ++this.#connectGeneration;
    await publish(
      e2ee && {
        keyB64: e2ee.keyB64,
        keyIndex: e2ee.keyIndex,
        epoch: e2ee.epoch,
      },
    );
""",
        replace="""    const generation = ++this.#connectGeneration;
    await publish(
      e2ee && {
        keyB64: e2ee.keyB64,
        keyIndex: e2ee.keyIndex,
        epoch: e2ee.epoch,
      },
    );
    this.#e2eeGroupId = e2ee?.groupId;
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-4d",
        what="setFrameKey hands the whole key, groupId included, across the bridge",
        file=LEG_POLICY,
        # Wave 4d retarget: the push now sits inside the re-key `withTimeout`
        # (R11). Same defect, new anchor; the bound is left in place.
        search="""      this.#bridge.setFrameKey({
        keyB64: key.keyB64,
        keyIndex: key.keyIndex,
        epoch: key.epoch,
      }),
""",
        replace="""      this.#bridge.setFrameKey(key),
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-4d-x-publish-arg",
        what="the connect hands the whole key, groupId included, to publish",
        file=LEG_POLICY,
        search="""      e2ee && {
        keyB64: e2ee.keyB64,
        keyIndex: e2ee.keyIndex,
        epoch: e2ee.epoch,
      },
""",
        replace="""      e2ee,
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-c1-inactive-noop",
        what="a key pushed to an inactive leg reaches the bridge instead of being a silent no-op",
        file=LEG_POLICY,
        search="""    if (!this.#active) return;
""",
        replace="",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-c1-missing-reason-error",
        what="a native stopped event with no reason announces a user stop instead of an error",
        file=LEG_POLICY,
        search="""    if (wasActive) this.#announce.stopped(reason ?? "error");
""",
        replace="""    if (wasActive) this.#announce.stopped(reason ?? "user");
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-fx1-cleared-key-stops",
        what="an E2EE leg whose key was cleared during connect is left running under a key nothing current backs (FX1)",
        file=LEG_POLICY,
        search="""  if (!current) return { kind: "stop" };
""",
        replace="""  if (!current) return { kind: "none" };
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    # ---- the plugin wrapper, held to delegating by source pins ---------------
    Mutation(
        id="leg-pin-stopPromise-field",
        what="the wrapper grows its own stop memo beside the leaf's",
        file=ANDROID_SHARE,
        search="""  #listeners: { remove: () => Promise<void> }[] = [];
""",
        replace="""  #stopPromise: Promise<void> | undefined;
  #listeners: { remove: () => Promise<void> }[] = [];
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-pin-x-active-field",
        what="the wrapper grows its own active flag beside the leaf's",
        file=ANDROID_SHARE,
        search="""  #ready: Promise<void>;
""",
        replace="""  #ready: Promise<void>;
  #active = false;
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-pin-x-eager-announcer",
        what="the started announcer binds `onStarted` at construction, so a handler set later is never called",
        file=ANDROID_SHARE,
        search="""      started: () => this.onStarted?.(),
""",
        replace="""      started: this.onStarted ?? (() => {}),
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-pin-x-stop-bypass",
        what="the wrapper's stop() resolves without asking the leaf, so nothing stops",
        file=ANDROID_SHARE,
        search="""    return this.#core.stop();
""",
        replace="""    return Promise.resolve();
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-pin-x-reason-dropped",
        what="the native stopped listener drops the plugin's reason",
        file=ANDROID_SHARE,
        search="""        this.#core.nativeStopped(data.reason);
""",
        replace="""        this.#core.nativeStopped(undefined);
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-pin-x-bridge-stop-stub",
        what="the bridge handed to the leaf stubs the native stop, so the projection never ends",
        file=ANDROID_SHARE,
        search="""      stop: () => plugin!.stop(),
""",
        replace="""      stop: () => Promise.resolve(),
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-pin-x-full-key-to-plugin",
        what="the plugin connect is handed the caller's full key, groupId included, instead of the bridge-shaped one",
        file=ANDROID_SHARE,
        search="""        audio: false,
        e2ee,
""",
        replace="""        audio: false,
        e2ee: options.e2ee,
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    # ---- the admit-grace decisions ------------------------------------------
    Mutation(
        id="grace-fx2-empty-owner-guard-removed",
        what="a malformed `::screen` leg (empty owner) reads as present against an empty localIdentity (FX2)",
        file=ADMIT_GRACE_POLICY,
        search="""  return owner !== "" && (sfu.includes(owner) || owner === localIdentity);
""",
        replace="""  return sfu.includes(owner) || owner === localIdentity;
""",
        specs=[ADMIT_GRACE_SPEC],
        must_red=[ADMIT_GRACE_SPEC],
    ),
    Mutation(
        id="grace-owner-local-identity-dropped",
        what="the sharer's OWN leg reads as an orphan, so this device's leg loses its grace first",
        file=ADMIT_GRACE_POLICY,
        search="""  return owner !== "" && (sfu.includes(owner) || owner === localIdentity);
""",
        replace="""  return owner !== "" && sfu.includes(owner);
""",
        specs=[ADMIT_GRACE_SPEC],
        must_red=[ADMIT_GRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="grace-owner-presence-always-true",
        what="every well-formed leg reads as owner-present, so an orphan leg keeps re-arming",
        file=ADMIT_GRACE_POLICY,
        search="""  return owner !== "" && (sfu.includes(owner) || owner === localIdentity);
""",
        replace="""  return owner !== "";
""",
        specs=[ADMIT_GRACE_SPEC],
        must_red=[ADMIT_GRACE_SPEC, LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="grace-owner-is-raw-leg",
        what="the owner is the leg identity itself, so no leg ever finds its owner",
        file=ADMIT_GRACE_POLICY,
        search="""  const owner = stripLeg(leg);
""",
        replace="""  const owner = leg;
""",
        specs=[ADMIT_GRACE_SPEC],
        must_red=[ADMIT_GRACE_SPEC, LEGGRACE_SPEC],
    ),
    Mutation(
        id="grace-owner-naive-suffix-slice",
        what="the owner is a suffix slice instead of the identity grammar, so a device leg's owner is misread",
        file=ADMIT_GRACE_POLICY,
        search="""  const owner = stripLeg(leg);
""",
        replace="""  const owner = leg.slice(0, -":screen".length);
""",
        specs=[ADMIT_GRACE_SPEC],
        must_red=[ADMIT_GRACE_SPEC],
    ),
    Mutation(
        id="grace-reset-ignores-isLeg",
        what="the published-leg ledger reset applies to primaries too",
        file=ADMIT_GRACE_POLICY,
        search="""  return i.isLeg && i.legPublished;
""",
        replace="""  return i.legPublished;
""",
        specs=[ADMIT_GRACE_SPEC],
        must_red=[ADMIT_GRACE_SPEC],
    ),
    Mutation(
        id="grace-reset-ignores-legPublished",
        what="every leg's ledger resets, published or not, so a churned leg never exhausts",
        file=ADMIT_GRACE_POLICY,
        search="""  return i.isLeg && i.legPublished;
""",
        replace="""  return i.isLeg;
""",
        specs=[ADMIT_GRACE_SPEC],
        # Wave 4c retarget: LEGGRACE_SPEC dropped, measured GREEN (25/25) under C6 —
        # a leg is never pending, so its ledger decides no verdict; the policy
        # spec alone kills it (3 failing of 36). See the wave-4 WEAKENED record.
        must_red=[ADMIT_GRACE_SPEC],
    ),
    Mutation(
        id="grace-reset-never",
        what="no ledger ever resets, so a phone that shares over and over runs out of grace (E2-2)",
        file=ADMIT_GRACE_POLICY,
        search="""  return i.isLeg && i.legPublished;
""",
        replace="""  return false;
""",
        specs=[ADMIT_GRACE_SPEC],
        # Wave 4c retarget: LEGGRACE_SPEC dropped, measured GREEN (25/25) under C6 —
        # a leg is never pending, so its ledger decides no verdict; the policy
        # spec alone kills it (3 failing of 36). See the wave-4 WEAKENED record.
        must_red=[ADMIT_GRACE_SPEC],
    ),
    Mutation(
        id="grace-rearm-leg-branch-removed",
        what="a leg re-arms on the primary-only admit signal, which is always false for it, so a slow leg lapses (E2-3)",
        file=ADMIT_GRACE_POLICY,
        search="""  if (i.isLeg) return !i.legPublished && i.legOwnerPresent;
""",
        replace="",
        specs=[ADMIT_GRACE_SPEC],
        # Wave 4c retarget: LEGGRACE_SPEC dropped, measured GREEN (25/25) under C6 —
        # a leg's window decides no verdict, so a lapsed slow leg is inert, not
        # loud; the policy spec alone kills it (5 failing of 36). See the wave-4
        # WEAKENED record.
        must_red=[ADMIT_GRACE_SPEC],
    ),
    Mutation(
        id="grace-rearm-leg-ignores-legPublished",
        what="a published leg keeps re-arming while its owner is present",
        file=ADMIT_GRACE_POLICY,
        search="""  if (i.isLeg) return !i.legPublished && i.legOwnerPresent;
""",
        replace="""  if (i.isLeg) return i.legOwnerPresent;
""",
        specs=[ADMIT_GRACE_SPEC],
        must_red=[ADMIT_GRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="grace-rearm-leg-ignores-owner",
        what="an orphan unpublished leg keeps re-arming",
        file=ADMIT_GRACE_POLICY,
        search="""  if (i.isLeg) return !i.legPublished && i.legOwnerPresent;
""",
        replace="""  if (i.isLeg) return !i.legPublished;
""",
        specs=[ADMIT_GRACE_SPEC],
        must_red=[ADMIT_GRACE_SPEC, LEGGRACE_SPEC],
    ),
    Mutation(
        id="grace-rearm-leg-honors-admitInProgress",
        what="a leg also re-arms on the admit signal, so a published or orphan leg can be held open by it",
        file=ADMIT_GRACE_POLICY,
        search="""  if (i.isLeg) return !i.legPublished && i.legOwnerPresent;
""",
        replace="""  if (i.isLeg) return (!i.legPublished && i.legOwnerPresent) || i.admitInProgress;
""",
        specs=[ADMIT_GRACE_SPEC],
        must_red=[ADMIT_GRACE_SPEC],
    ),
    Mutation(
        id="grace-rearm-leg-rule-for-primaries",
        what="a primary is judged by the leg rule, so its admit signal is ignored",
        file=ADMIT_GRACE_POLICY,
        search="""  if (i.isLeg) return !i.legPublished && i.legOwnerPresent;
""",
        replace="""  if (true) return !i.legPublished && i.legOwnerPresent;
""",
        specs=[ADMIT_GRACE_SPEC],
        must_red=[ADMIT_GRACE_SPEC, LEGGRACE_SPEC],
    ),
    # ---- the session's call sites -------------------------------------------
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-ca-reset-before-bill",
        what="the settle loop resets the ledger BEFORE billing, so the stretch just billed survives the reset (C-a)",
        file=SESSION,
        search="""        if (settled.billMs > 0) this.#billAdmitGrace(identity, settled.billMs);
        entry.pendingSince = settled.pendingSince;
        // Bill THEN reset:""",
        replace="""        // Bill THEN reset:""",
        also=[
            (
                """        if (admitGraceLedgerResets({ isLeg, legPublished: seenPublished }))
          this.#admitGraceUsed.delete(identity);
      }
    }
""",
                """        if (admitGraceLedgerResets({ isLeg, legPublished: seenPublished }))
          this.#admitGraceUsed.delete(identity);
        if (settled.billMs > 0) this.#billAdmitGrace(identity, settled.billMs);
        entry.pendingSince = settled.pendingSince;
      }
    }
""",
            ),
        ],
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-m3-absent-reads-published",
        what="an absent unpublishedLegs accessor reads as \"nothing unpublished\", so the reset fails open (C-b, M3)",
        file=SESSION,
        search="""      const unpublishedLegs = media.unpublishedLegs?.();""",
        replace="""      const unpublishedLegs = media.unpublishedLegs?.() ?? [];""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-leg-takes-admit-signal",
        what="the expiry feeds a leg the primary-only admit signal",
        file=SESSION,
        search="""      admitInProgress: isLeg ? false : this.#admitInProgress(identity),""",
        replace="""      admitInProgress: this.#admitInProgress(identity),""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-old-rearm-restored",
        what="the expiry re-arms on the old primary-only admit signal instead of the leg-aware decision",
        file=SESSION,
        search="""    if (this.#rearmAdmitGrace(identity, entry, stillEnrolling)) return;""",
        replace="""    if (this.#rearmAdmitGrace(identity, entry, this.#admitInProgress(identity)))
      return;""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    Mutation(
        id="session-owner-always-present",
        what="every leg reads as owner-present at the expiry, so an orphan leg keeps re-arming",
        file=SESSION,
        search="""      legOwnerPresent:
        isLeg &&
        media !== null &&""",
        replace="""      legOwnerPresent:
        isLeg ||
        media !== null &&""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    Mutation(
        id="session-primary-never-rearms",
        what="the expiry feeds every identity a false admit signal, so a primary mid-admit lapses (C-e)",
        file=SESSION,
        search="""      admitInProgress: isLeg ? false : this.#admitInProgress(identity),""",
        replace="""      admitInProgress: false,""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    Mutation(
        id="session-primary-always-rearms",
        what="the expiry feeds every primary a true admit signal, so a primary nothing is admitting re-arms (C-e)",
        file=SESSION,
        search="""      admitInProgress: isLeg ? false : this.#admitInProgress(identity),""",
        replace="""      admitInProgress: !isLeg,""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-m1-e2ee-witness-dropped",
        what="in an e2ee call a leg nothing witnessed encrypted still resets its ledger (C-b, M1)",
        file=SESSION,
        search="""          !unpublishedLegs.includes(identity) &&
          (!e2ee || encryptedLegs.has(identity));""",
        replace="""          !unpublishedLegs.includes(identity);""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-m4-sfu-presence-dropped",
        what="a leg already gone from the SFU set still resets its ledger (C-b, M4)",
        file=SESSION,
        search="""          sfuNow.has(identity) &&
""",
        replace="",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-reset-dropped",
        what="the settle loop never forgives a published leg's spent grace (E2-2)",
        file=SESSION,
        search="""          this.#admitGraceUsed.delete(identity);""",
        replace="""          void identity;""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-local-identity-dropped",
        what="the expiry's owner check ignores this device, so the sharer's own leg reads as an orphan",
        file=SESSION,
        search="""          media.localIdentity() ?? "",""",
        replace="""          "",""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-m7-e2ee-const-false",
        what="the settle loop treats every call as plaintext, so an unwitnessed leg resets in an e2ee call (C-b, M7)",
        file=SESSION,
        search="""      const e2ee = this.#callMode.kind === "e2ee";""",
        replace="""      const e2ee = false;""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-expiry-legpublished-inverted",
        what="the expiry hands the re-arm decision `legPublished` inverted, so a published leg re-arms and an unpublished one lapses",
        file=SESSION,
        search="""      legPublished: !unpublished,""",
        replace="""      legPublished: unpublished,""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # WEAKENED (wave 4c): see the WEAKENED ASSERTIONS block below
    Mutation(
        id="session-expiry-absent-accessor-reads-unpublished",
        what="at the expiry an absent unpublishedLegs accessor reads every leg as unpublished, so a binding with no accessor re-arms legs (fails open)",
        file=SESSION,
        search="""      isLeg && (media?.unpublishedLegs?.() ?? []).includes(identity);""",
        replace="""      isLeg && (media?.unpublishedLegs?.() ?? [identity]).includes(identity);""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # ---- the leg key on a legless epoch (F7) --------------------------------
    Mutation(
        id="keys-legless-clear",
        what="an epoch with no screen-leg entry keeps the superseded leg key instead of clearing it (F7)",
        file=CALL_KEYS,
        search="""    if (!entry) {
      // Clear the stale key so a later start refuses on "no key".
      this.#lastLocalScreenKey = undefined;
""",
        replace="""    if (!entry) {
      // Clear the stale key so a later start refuses on "no key".
""",
        specs=[CALL_KEYS_SPEC],
        must_red=[CALL_KEYS_SPEC],
    ),
]


# --- The Android screen-share flip, wave 4 (F-W3-2): roster, leaf, keys, state
#
# Wave 4c of the screen-share flip (G2). One namespace per target, as above:
#
#  - `roster-*`: C6 in `mlsRosterPolicy.ts` — the inert-leg skip (a leg with
#    ZERO publications whose owner is present, or is this device, is in
#    neither list), its placement below the bare-identity rule, a leg never
#    `pending`, and rule 2(a)'s owner fold. Killed by `rosterReconcile.test.ts`
#    and, where `must_red` says so, by the session-level F-W3-2 / steady-state
#    orphan specs in `mlsCallSession.leggrace.test.ts` — every listed spec was
#    MEASURED red on its own.
#  - `session-*` (two): the session's own inputs to that skip — the
#    `unpublishedLegs` default an absent accessor gets, and the SFU set it
#    hands `reconcileRoster`.
#  - `leg-*` / `share-*`: C7 in `androidLegStartPolicy.ts` (the stop notices
#    `nativeStopNotice` / `gateStopNotice` / `staleExitNotice`, `stopping()`,
#    a revoke reaching the announcer, the awaited bridge push, every field of
#    the post-connect key compare, the group-mismatch stop) and the plugin
#    wrapper
#    `androidScreenShare.ts`, held to delegating by the leaf spec's SOURCE
#    PINS (`node --test` cannot load the wrapper).
#  - `keys-*`: the leg send key's ordering in `mlsCallKeys.ts` — recorded
#    BEFORE the push, both pushes awaited, cleared by `resetForGroup`; and
#    (4c-fix) pushed only AFTER the post-import fence re-check and the
#    primary's local publish, skipped as unchanged only on all four fields.
#  - `state-*`: C9 in `state.tsx`, killed ONLY by the source pins in
#    `stateWiring.test.ts` (see the `file=STATE` rule in the header). Every
#    such kill proves the pinned TEXT changed, never what the code does at
#    runtime. The leg's runtime behavior there is left to the emulator re-run
#    owed after wave 4c (plan § "Wave 3 re-run"), not measured by this table.
#
# 🔴 WEAKENED ASSERTIONS (wave 4c, measured at b6f85aa0 + the 4c-i specs; the
# runs are `w4scratch/w4_G2_m0_sectionE_pre.log` and `w4_G2_sbE.log`). Under C6
# a screen leg is never `pending` and its admit-grace ledger decides no
# verdict, so the leggrace BEHAVIORAL specs that used to kill these entries
# went vacuous (T2, wave 4b). What each is held by now:
#  - `grace-reset-never`, `grace-reset-ignores-legPublished`,
#    `grace-rearm-leg-branch-removed`: GREEN on leggrace (25/25) — retargeted
#    to `mlsAdmitGracePolicy.test.ts` alone (3, 3 and 5 failing of 36). The
#    POLICY decision is still pinned; that it matters to a call is not.
#  - `grace-owner-presence-always-true`, `grace-owner-is-raw-leg`,
#    `grace-rearm-leg-ignores-owner`: still on LEGGRACE_SPEC, but killed ONLY
#    by the expiry-orphan spec ("an orphan leg (its owner gone when its window
#    expires) is loud"), through the expiry TIMING gap; the steady-state
#    orphan specs are green under all three. Equivalent under C6 (a leg's
#    window decides no verdict); kept rather than deleted.
#  - `session-m1-e2ee-witness-dropped`, `session-m3-absent-reads-published`,
#    `session-m4-sfu-presence-dropped`, `session-m7-e2ee-const-false`,
#    `session-reset-dropped`, `session-ca-reset-before-bill`,
#    `session-local-identity-dropped`, `session-leg-takes-admit-signal`,
#    `session-expiry-legpublished-inverted`,
#    `session-expiry-absent-accessor-reads-unpublished`,
#    `session-old-rearm-restored`: BEHAVIORAL -> PIN. Each is now killed only
#    by a leggrace SOURCE PIN over `mlsCallSession.ts` (the C-a, C-b and
#    C-d/C-e pin tests, plus "the expiry no longer re-arms on the primary-only
#    admit signal"); no behavioral spec reddens. The retirement of the leg
#    admit-grace windows is the recorded follow-up that removes this code.
# The last two groups' 14 entries each carry a one-line `# WEAKENED (wave 4c)`
# marker; the first group's three say so in their own retarget comments.

ROSTER_POLICY = "mlsRosterPolicy.ts"
ROSTER_SPEC = "components/rtc/rosterReconcile.test.ts"

MUTATIONS += [
    # ---- C6: the inert-leg skip in reconcileRoster --------------------------
    Mutation(
        id="roster-skip-removed",
        what="the inert-leg skip is gone, so a force-unpublished leg with its owner present lands in nonEnrolled and the call goes mixed (F-W3-2a)",
        file=ROSTER_POLICY,
        search="""    if (
      isScreenLeg(id) &&
      unpublished.has(id) &&
      (rawSfu.has(stripLeg(id)) || stripLeg(id) === localIdentity)
    ) {
      continue;
    }
""",
        replace="",
        specs=[ROSTER_SPEC, LEGGRACE_SPEC],
        must_red=[ROSTER_SPEC, LEGGRACE_SPEC],
    ),
    Mutation(
        id="roster-owner-check-dropped",
        what="an unpublished leg is inert whatever its owner, so an ORPHAN unpublished leg goes quiet",
        file=ROSTER_POLICY,
        search="""      (rawSfu.has(stripLeg(id)) || stripLeg(id) === localIdentity)
""",
        replace="""      true
""",
        specs=[ROSTER_SPEC, LEGGRACE_SPEC],
        must_red=[ROSTER_SPEC, LEGGRACE_SPEC],
    ),
    Mutation(
        id="roster-owner-local-dropped",
        what="this device's own unpublished leg is not inert (its owner is deleted from rawSfu), so the sharer accuses itself",
        file=ROSTER_POLICY,
        search="""      (rawSfu.has(stripLeg(id)) || stripLeg(id) === localIdentity)
""",
        replace="""      rawSfu.has(stripLeg(id))
""",
        specs=[ROSTER_SPEC],
        must_red=[ROSTER_SPEC],
    ),
    Mutation(
        id="roster-unpublished-check-dropped",
        what="every unfolded leg with its owner present is inert, so a leg PUBLISHING plaintext goes quiet",
        file=ROSTER_POLICY,
        search="""      unpublished.has(id) &&
""",
        replace="",
        specs=[ROSTER_SPEC],
        must_red=[ROSTER_SPEC],
    ),
    Mutation(
        id="roster-skip-to-pending",
        what="the inert leg is reported pending instead of neither (the rejected A2 design: a hostile SFU holds pending forever)",
        file=ROSTER_POLICY,
        search="""      (rawSfu.has(stripLeg(id)) || stripLeg(id) === localIdentity)
    ) {
      continue;
    }
""",
        replace="""      (rawSfu.has(stripLeg(id)) || stripLeg(id) === localIdentity)
    ) {
      pending.push(id);
      continue;
    }
""",
        specs=[ROSTER_SPEC, LEGGRACE_SPEC],
        must_red=[ROSTER_SPEC, LEGGRACE_SPEC],
    ),
    Mutation(
        id="roster-ingrace-legs",
        what="a graced leg is pending again, so an orphan or plaintext-publishing leg inside its window is not loud",
        file=ROSTER_POLICY,
        search="""    const inGrace = graced.has(id) && !isScreenLeg(id);
""",
        replace="""    const inGrace = graced.has(id);
""",
        specs=[ROSTER_SPEC],
        must_red=[ROSTER_SPEC],
    ),
    Mutation(
        id="roster-skip-above-bare",
        what="the inert-leg skip runs above the bare-identity rule, so an unpublished BARE leg with its owner present goes quiet (audit #12)",
        file=ROSTER_POLICY,
        # Code-only anchors (4c-fix): the main search removes the skip block
        # and the `also` edit re-inserts it above the bare-identity rule. The
        # skip's explanatory comment stays where it is, so rewording it cannot
        # break this entry.
        search="""    if (
      isScreenLeg(id) &&
      unpublished.has(id) &&
      (rawSfu.has(stripLeg(id)) || stripLeg(id) === localIdentity)
    ) {
      continue;
    }
""",
        replace="",
        also=[
            (
                """    if (!isDeviceQualified(id)) {
""",
                """    if (
      isScreenLeg(id) &&
      unpublished.has(id) &&
      (rawSfu.has(stripLeg(id)) || stripLeg(id) === localIdentity)
    ) {
      continue;
    }
    if (!isDeviceQualified(id)) {
""",
            ),
        ],
        specs=[ROSTER_SPEC],
        must_red=[ROSTER_SPEC],
    ),
    Mutation(
        id="roster-skip-drops-isScreenLeg",
        what="the skip no longer asks isScreenLeg, so a PRIMARY named in unpublishedLegs goes quiet (e2ee #1)",
        file=ROSTER_POLICY,
        search="""      isScreenLeg(id) &&
      unpublished.has(id) &&
""",
        replace="""      unpublished.has(id) &&
""",
        specs=[ROSTER_SPEC],
        must_red=[ROSTER_SPEC],
    ),
    Mutation(
        id="roster-owner-by-user",
        what="the skip's owner test compares the USER id, so a leg of another device of the same user reads as owner-present (e2ee #4)",
        file=ROSTER_POLICY,
        search="""      (rawSfu.has(stripLeg(id)) || stripLeg(id) === localIdentity)
""",
        replace="""      ([...rawSfu].some((p) => !isScreenLeg(p) && p.split(":")[0] === id.split(":")[0]) || id.split(":")[0] === localIdentity.split(":")[0])
""",
        specs=[ROSTER_SPEC],
        must_red=[ROSTER_SPEC],
    ),
    Mutation(
        id="roster-fold-ignores-owner",
        what="rule 2(a) folds a leg onto an ABSENT owner, so a steady-state orphan leg is never reported",
        file=ROSTER_POLICY,
        search="""    if (!rawSfu.has(owner) && owner !== localIdentity) return identity;
""",
        replace="",
        specs=[ROSTER_SPEC, LEGGRACE_SPEC],
        must_red=[ROSTER_SPEC, LEGGRACE_SPEC],
    ),
    Mutation(
        id="roster-orphan-unpublished-inert",
        what="the skip drops its owner test as a whole, so a steady-state ORPHAN unpublished leg is inert instead of loud (§5.4)",
        file=ROSTER_POLICY,
        search="""    if (
      isScreenLeg(id) &&
      unpublished.has(id) &&
      (rawSfu.has(stripLeg(id)) || stripLeg(id) === localIdentity)
    ) {
      continue;
    }
""",
        replace="""    if (isScreenLeg(id) && unpublished.has(id)) {
      continue;
    }
""",
        # Behaviorally the same defect as `roster-owner-check-dropped` (same
        # reds in both specs); kept as the whole-block form the steady-state
        # orphan specs were written against.
        specs=[ROSTER_SPEC, LEGGRACE_SPEC],
        must_red=[ROSTER_SPEC, LEGGRACE_SPEC],
    ),
    # ---- the session's inputs to the skip -----------------------------------
    Mutation(
        id="session-unpublished-fail-open",
        what="an absent unpublishedLegs accessor reads as every participant unpublished, so a binding that cannot vouch hides every leg (fails open)",
        file=SESSION,
        search="""        unpublishedLegs: media.unpublishedLegs?.() ?? [],
""",
        replace="""        unpublishedLegs: media.unpublishedLegs?.() ?? media.sfuParticipants(),
""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    Mutation(
        id="session-orphan-owner-synthesized",
        what="the session adds every leg's owner to the SFU set it hands reconcileRoster, so an orphan leg always finds its owner",
        file=SESSION,
        search="""    const result = reconcileRoster(
      media.sfuParticipants(),
""",
        replace="""    const result = reconcileRoster(
      [...media.sfuParticipants(), ...media.sfuParticipants().map(stripLeg)],
""",
        specs=[LEGGRACE_SPEC],
        must_red=[LEGGRACE_SPEC],
    ),
    # ---- C7: the stop notices -----------------------------------------------
    Mutation(
        id="leg-notice-revoked-silenced",
        what="a native revoke maps to no notice, so the sharer is never told why the share ended",
        file=LEG_POLICY,
        search="""        : "revoked";
""",
        replace="""        : "none";
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-notice-revoked-under-mute",
        what="a revoke toasts even when the primary lost publishing too, doubling the moderator-mute toast",
        file=LEG_POLICY,
        search="""      return primary.canPublish === false || primary.inAfkChannel
""",
        replace="""      return primary.inAfkChannel
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-notice-revoked-in-afk",
        what="a revoke toasts in the AFK channel when the leg's revoke beats the primary's, doubling the AFK toast (audit #5)",
        file=LEG_POLICY,
        search="""      return primary.canPublish === false || primary.inAfkChannel
""",
        replace="""      return primary.canPublish === false
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-notice-system-toasts",
        what="a system stop (the notification's Stop) toasts the connection copy for a stop the user took",
        file=LEG_POLICY,
        search="""    case "user":
    case "system":
      return "none";
    case "disconnected":
""",
        replace="""    case "user":
      return "none";
    case "system":
    case "disconnected":
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-gate-cancel-tap-toasts",
        what="a gate pulse after a cancelling tap still answers gate-start, toasting a start the user cancelled",
        file=LEG_POLICY,
        search="""    w.startingFor !== undefined &&
    w.startingFor === w.currentGeneration
""",
        replace="""    w.startingFor !== undefined
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-gate-inflight-retoast",
        what="a second gate reason during the teardown toasts gate-share again",
        file=LEG_POLICY,
        search="""  if (w.active && !w.stopInFlight) return "gate-share";
""",
        replace="""  if (w.active) return "gate-share";
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-gate-disconnected-toasts",
        what="a gate stop while the Room is not connected toasts, on top of the native connection notice",
        file=LEG_POLICY,
        search="""  if (!w.roomConnected) return "none";
""",
        replace="",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-stale-exit-silenced",
        what="a stale-but-not-cancelled start exits silently again: the user consents and nothing happens (R7)",
        file=LEG_POLICY,
        search="""    ? "gate-start"
    : "none";
""",
        replace="""    ? "none"
    : "none";
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-stale-exit-cancelled-toasts",
        what="a CANCELLED start's stale exit answers gate-start, so a tap or a gate pulse toasts twice",
        file=LEG_POLICY,
        search="""  return startAttemptStale(world) && !startAttemptCancelled(world)
""",
        replace="""  return startAttemptStale(world)
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    # ---- C7: stopping(), the revoke announce, the key push and compare -------
    Mutation(
        id="leg-stopping-false",
        what="stopping() never reads true, so a second gate reason during a stop toasts again",
        file=LEG_POLICY,
        search="""    return this.#stopPromise !== undefined;
""",
        replace="""    return false;
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-stopping-memo-sticks",
        what="the stop memo is never cleared, so stopping() stays true after the stop settles (same edit as leg-1b's effect, pinned through stopping())",
        file=LEG_POLICY,
        search="""      this.#stopPromise = undefined;
""",
        replace="",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-revoked-unannounced",
        what="a native revoke is never announced, so the share UI stays on Stop sharing",
        file=LEG_POLICY,
        search="""    if (wasActive) this.#announce.stopped(reason ?? "error");
""",
        replace="""    if (wasActive && reason !== "revoked")
      this.#announce.stopped(reason ?? "error");
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-bridge-setframekey-unawaited",
        what="the leaf pushes the key across the bridge un-awaited, so a refused push never reaches the caller's fail-closed stop",
        file=LEG_POLICY,
        # Wave 4d retarget: the push is now awaited through the re-key
        # `withTimeout` (R11), so the `await` dropped is that one.
        search="""    await withTimeout(
      this.#bridge.setFrameKey({
""",
        replace="""    void withTimeout(
      this.#bridge.setFrameKey({
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-key-material-compare-dropped",
        what="the post-connect compare ignores the key material, so a re-keyed same-index key is never pushed",
        file=LEG_POLICY,
        search="""    current.keyB64 === connectedWith.keyB64
""",
        replace="""    true
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-key-index-compare-dropped",
        what="the post-connect compare ignores the key index, so an index-only move is never pushed (4c-i LT spec)",
        file=LEG_POLICY,
        search="""    current.keyIndex === connectedWith.keyIndex &&
""",
        replace="""    true &&
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="leg-key-group-mismatch-pushes",
        what="the post-connect compare pushes a key from a DIFFERENT group onto the leg instead of stopping it, so a leg connected under a superseded group stays live on a key it cannot be fenced onto (E2EE N11)",
        file=LEG_POLICY,
        search="""  if (current.groupId !== connectedWith.groupId) return { kind: "stop" };
""",
        replace="""  if (current.groupId !== connectedWith.groupId) return { kind: "push", key: current };
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    # ---- C10: the plugin wrapper, held to delegating by source pins ----------
    Mutation(
        id="leg-pin-x-stopping-copy",
        what="the wrapper answers stopping() from its own copy instead of the leaf's",
        file=ANDROID_SHARE,
        search="""    return this.#core.stopping();
""",
        replace="""    return this.#stopping;
""",
        also=[
            (
                """  #ready: Promise<void>;
""",
                """  #ready: Promise<void>;
  #stopping = false;
""",
            ),
        ],
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    Mutation(
        id="share-plugin-setframekey-voided",
        what="the bridge's setFrameKey swallows the plugin's promise, so a native refusal resolves as a landed push",
        file=ANDROID_SHARE,
        search="""      setFrameKey: (k) => plugin!.setFrameKey(k),
""",
        replace="""      setFrameKey: async (k) => {
        void plugin!.setFrameKey(k);
      },
""",
        specs=[LEG_POLICY_SPEC],
        must_red=[LEG_POLICY_SPEC],
    ),
    # ---- the leg send key in mlsCallKeys.ts ----------------------------------
    Mutation(
        id="keys-screen-apply-unawaited",
        what="applyLocalKey does not await the leg key update, so a rotation reports installed before the phone took it",
        file=CALL_KEYS,
        search="""    await this.#applyLocalScreenKey(frameKeys, localIdentity);
""",
        replace="""    void this.#applyLocalScreenKey(frameKeys, localIdentity);
""",
        specs=[CALL_KEYS_SPEC],
        must_red=[CALL_KEYS_SPEC],
    ),
    Mutation(
        id="keys-screen-listener-unawaited",
        what="the leg key listener is called un-awaited, so the push's outcome is lost",
        file=CALL_KEYS,
        search="""    await this.onLocalScreenKey?.(key);
""",
        replace="""    void this.onLocalScreenKey?.(key);
""",
        specs=[CALL_KEYS_SPEC],
        must_red=[CALL_KEYS_SPEC],
    ),
    Mutation(
        id="keys-screen-record-after-push",
        what="the leg key is recorded only AFTER the push, so a leg started during the push is handed the superseded key",
        file=CALL_KEYS,
        search="""    this.#lastLocalScreenKey = key;
""",
        replace="",
        also=[
            (
                """    await this.onLocalScreenKey?.(key);
""",
                """    await this.onLocalScreenKey?.(key);
    this.#lastLocalScreenKey = key;
""",
            ),
        ],
        specs=[CALL_KEYS_SPEC],
        must_red=[CALL_KEYS_SPEC],
    ),
    Mutation(
        id="keys-reset-keeps-screen-key",
        what="resetForGroup keeps the leg key, so a start after a re-establish is handed the old group's key",
        file=CALL_KEYS,
        search="""    this.#fence = undefined;
    this.#lastLocalScreenKey = undefined;
""",
        replace="""    this.#fence = undefined;
""",
        specs=[CALL_KEYS_SPEC],
        must_red=[CALL_KEYS_SPEC],
    ),
    # ---- 4c-fix: where applyLocalKey pushes the leg key (E2EE N23/N22/N20) ---
    # The first two MOVE the push: the main search removes it from the end of
    # `applyLocalKey` and the `also` edit re-inserts it higher up, applied in
    # that order in memory (see `apply`), so each moved line exists exactly
    # once in the mutant.
    Mutation(
        id="keys-screen-push-before-admits-recheck",
        what="applyLocalKey pushes the leg key before the post-import fence re-check, so an install overtaken during its import pushes and records the superseded epoch's leg key (N23)",
        file=CALL_KEYS,
        search="""    await this.#applyLocalScreenKey(frameKeys, localIdentity);
""",
        replace="",
        also=[
            (
                """    const imported = await this.#import(entries);
""",
                """    const imported = await this.#import(entries);
    await this.#applyLocalScreenKey(frameKeys, localIdentity);
""",
            ),
        ],
        specs=[CALL_KEYS_SPEC],
        must_red=[CALL_KEYS_SPEC],
    ),
    Mutation(
        id="keys-screen-push-before-local-publish",
        what="applyLocalKey pushes the leg key before publishing the primary's local key, so a stalled leg bridge holds back the primary's forward-secrecy switch (N22)",
        file=CALL_KEYS,
        search="""    await this.#applyLocalScreenKey(frameKeys, localIdentity);
""",
        replace="",
        also=[
            (
                """    this.#publish(imported, "local");
""",
                """    await this.#applyLocalScreenKey(frameKeys, localIdentity);
    this.#publish(imported, "local");
""",
            ),
        ],
        specs=[CALL_KEYS_SPEC],
        must_red=[CALL_KEYS_SPEC],
    ),
    Mutation(
        id="keys-screen-idempotence-epoch-only",
        what="the leg key's skip-if-unchanged check compares the epoch only (N20)",
        file=CALL_KEYS,
        search="""      previous.groupId === key.groupId &&
      previous.epoch === key.epoch &&
      previous.keyIndex === key.keyIndex &&
      previous.keyB64 === key.keyB64
""",
        replace="""      previous.epoch === key.epoch
""",
        specs=[CALL_KEYS_SPEC],
        must_red=[CALL_KEYS_SPEC],
    ),
    # ---- C9 (state.tsx): the roster inputs and the trackPublished kick -------
    Mutation(
        id="state-leg-unpublished-widened",
        what="unpublishedLegs also takes every participant not declaring encryption, so a leg publishing plaintext is hidden as inert (e2ee #2)",
        file=STATE,
        search="""            (p) => isScreenLeg(p.identity) && p.trackPublications.size === 0,
""",
        replace="""            (p) =>
              isScreenLeg(p.identity) && p.trackPublications.size === 0 || !p.isEncrypted,
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-encryptedlegs-widened",
        what="encryptedLegs takes every leg, encrypted or not, so a plaintext leg folds onto its owner",
        file=STATE,
        search="""          .filter((p) => isScreenLeg(p.identity) && p.isEncrypted)
""",
        replace="""          .filter((p) => isScreenLeg(p.identity))
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-sfu-drops-legs",
        what="sfuParticipants leaves the screen legs out, so no roster ever judges a leg",
        file=STATE,
        search="""        ...[...room.remoteParticipants.values()].map((p) => p.identity),
      ],
""",
        replace="""        ...[...room.remoteParticipants.values()]
          .filter((p) => !isScreenLeg(p.identity))
          .map((p) => p.identity),
      ],
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-sfu-drops-local",
        what="sfuParticipants leaves this device out, so the roster's local-identity handling never sees it",
        file=STATE,
        search="""        room.localParticipant.identity,
        ...[...room.remoteParticipants.values()].map((p) => p.identity),
""",
        replace="""        ...[...room.remoteParticipants.values()].map((p) => p.identity),
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-trackpublished-reconcile-dropped",
        what="trackPublished no longer kicks a reconcile, so a leg that publishes plaintext stays hidden until the next tick (e2ee #3)",
        file=STATE,
        search="""      void this.#mlsSession?.reconcileNow();
""",
        replace="",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-trackpublished-leg-early-return",
        what="the trackPublished listener returns early for a screen leg, so a leg's publish never kicks the reconcile (e2ee F3)",
        file=STATE,
        search="""    room.addListener("trackPublished", (pub, participant) => {
""",
        replace="""    room.addListener("trackPublished", (pub, participant) => {
      if (isScreenLeg(participant.identity)) return;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    # ---- C9: #pauseGate's notice ---------------------------------------------
    Mutation(
        id="state-leg-gate-after-stop",
        what="the gate notice is sampled AFTER the stop bumped the generation, so a gate-start is never told",
        file=STATE,
        search="""    const notice = gateStopNotice({
""",
        replace="""    void this.#stopAndroidLeg();
    const notice = gateStopNotice({
""",
        also=[
            (
                """    void this.#stopAndroidLeg();
    await this.#applyPublishGate(room);
""",
                """    await this.#applyPublishGate(room);
""",
            ),
        ],
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-pausegate-toast-before-sweep",
        what="the gate toast fires before the primary's pause sweep, ahead of the reactive fallout it should follow (e2ee F4)",
        file=STATE,
        search="""    await this.#applyPublishGate(room);
    if (notice === "gate-start") this.onErr(new Error(LEG_GATE_START_NOTICE));
    else if (notice === "gate-share")
      this.onErr(new Error(LEG_GATE_SHARE_NOTICE));
""",
        replace="""    if (notice === "gate-start") this.onErr(new Error(LEG_GATE_START_NOTICE));
    else if (notice === "gate-share")
      this.onErr(new Error(LEG_GATE_SHARE_NOTICE));
    await this.#applyPublishGate(room);
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-pausegate-sweep-unawaited",
        what="the primary's pause sweep is no longer awaited before the gate toast",
        file=STATE,
        search="""    await this.#applyPublishGate(room);
    if (notice === "gate-start") this.onErr(new Error(LEG_GATE_START_NOTICE));
""",
        replace="""    void this.#applyPublishGate(room);
    if (notice === "gate-start") this.onErr(new Error(LEG_GATE_START_NOTICE));
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    # ---- C9: the stop notices' copy and routing ------------------------------
    Mutation(
        id="state-leg-onstopped-inline",
        what="onStopped maps the reason inline instead of through nativeStopNotice, so a revoke under a mute or in the AFK channel toasts twice",
        file=STATE,
        search="""      const text = this.#legStopNoticeMessage(
        nativeStopNotice(reason, {
          canPublish: this.room()?.localParticipant.permissions?.canPublish,
          inAfkChannel: this.isAfkChannel,
        }),
      );
""",
        replace="""      const text =
        reason === "user" || reason === "system"
          ? undefined
          : this.#legStopNoticeMessage(
              reason === "disconnected"
                ? "connection"
                : reason === "error"
                  ? "encryption"
                  : "revoked",
            );
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-revoked-connect-unmapped",
        what="a revoke-cancelled connect is never matched, so the raw bridge string reaches the toast",
        file=STATE,
        search="""    if (message === "connect_failed: revoked") {
""",
        replace="""    if (message === "connect_failed: revoked-unmapped") {
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-revoked-connect-unsuppressed",
        what="the start's catch toasts the no-notice marker too, so a revoke the primary's toast explains toasts twice (code #3)",
        file=STATE,
        search="""        if (notice !== NO_LEG_NOTICE) this.onErr(notice);
""",
        replace="""        this.onErr(notice);
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-revoked-substring-match",
        what="the revoke is matched as a substring, so any connect failure merely containing it is silenced (e2ee F6)",
        file=STATE,
        search="""    if (message === "connect_failed: revoked") {
""",
        replace="""    if (
      typeof message === "string" &&
      message.includes("connect_failed: revoked")
    ) {
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-no-notice-undefined",
        what="the no-notice marker is undefined, so a literal undefined rejection is silenced too (code #4)",
        file=STATE,
        search="""const NO_LEG_NOTICE = Symbol("no-leg-notice");
""",
        replace="""const NO_LEG_NOTICE = undefined;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-notice-copy-swapped",
        what="gate-share shows the revoked copy",
        file=STATE,
        search="""      case "gate-share":
        return LEG_GATE_SHARE_NOTICE;
""",
        replace="""      case "gate-share":
        return LEG_REVOKED_NOTICE;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    # ---- C9: the leg key fence's two catches (4b-fix) ------------------------
    Mutation(
        id="state-leg-keysync-stop-dropped",
        what="a failed post-connect key push no longer stops the leg, so it keeps publishing under the old key (e2ee F1)",
        file=STATE,
        search="""      const spoken = leg.stopping() || !leg.active();
      await this.#stopAndroidLeg();
""",
        replace="""      const spoken = leg.stopping() || !leg.active();
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-keysync-stop-gated-on-active",
        what="the post-connect catch stops the leg only while it reads active(), so a leg still stopping is left to its old key",
        file=STATE,
        search="""      await this.#stopAndroidLeg();
      if (!spoken || leg.active())
""",
        replace="""      if (leg.active()) await this.#stopAndroidLeg();
      if (!spoken || leg.active())
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-rotation-stop-dropped",
        what="a failed rotation push no longer stops the leg, so it keeps publishing under a key a removed member holds (e2ee F1)",
        file=STATE,
        search="""            const spoken = leg.stopping() || !leg.active();
            await this.#stopAndroidLeg();
""",
        replace="""            const spoken = leg.stopping() || !leg.active();
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-rotation-stop-gated-on-spoken",
        what="the rotation catch stops the leg only when nothing spoke for it, so a stop that is already failing is never retried",
        file=STATE,
        search="""            await this.#stopAndroidLeg();
            if (!spoken || leg.active())
""",
        replace="""            if (!spoken) await this.#stopAndroidLeg();
            if (!spoken || leg.active())
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-rotation-toast-narrowed",
        what="the rotation catch's toast drops the still-active arm, so a FAILED stop leaves a live share untold",
        file=STATE,
        search="""            await this.#stopAndroidLeg();
            if (!spoken || leg.active())
""",
        replace="""            await this.#stopAndroidLeg();
            if (!spoken)
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-keysync-toast-narrowed",
        what="the post-connect catch's toast drops the still-active arm, so a FAILED stop leaves a live share untold",
        file=STATE,
        search="""      await this.#stopAndroidLeg();
      if (!spoken || leg.active())
""",
        replace="""      await this.#stopAndroidLeg();
      if (!spoken)
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-spoken-after-stop",
        what="the post-connect catch reads spoken AFTER its own stop, so it always reads spoken and a failure nobody explained is untold",
        file=STATE,
        search="""      const spoken = leg.stopping() || !leg.active();
      await this.#stopAndroidLeg();
""",
        replace="""      await this.#stopAndroidLeg();
      const spoken = leg.stopping() || !leg.active();
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-spoken-narrowed",
        what="the rotation catch's spoken drops stopping(), so a push into a leg #pauseGate is stopping toasts on top of gate-share",
        file=STATE,
        search="""            const spoken = leg.stopping() || !leg.active();
""",
        replace="""            const spoken = !leg.active();
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-sync-toast-unsuppressed",
        what="the post-connect catch's spoken drops stopping(), so a sync failing into a stopping leg toasts on top of gate-share",
        file=STATE,
        search="""      const spoken = leg.stopping() || !leg.active();
      await this.#stopAndroidLeg();
""",
        replace="""      const spoken = !leg.active();
      await this.#stopAndroidLeg();
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-catch-rethrows",
        what="the rotation listener's catch rethrows instead of resolving, so a failed leg push fails the rotation itself",
        file=STATE,
        search="""              );
          }
        };
        this.#e2eeWorker = new E2EEWorker();
""",
        replace="""              );
            throw new Error("screen leg key push failed");
          }
        };
        this.#e2eeWorker = new E2EEWorker();
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    # ---- C9: the leg key pushes (4b-fix2) ------------------------------------
    Mutation(
        id="state-leg-keysync-call-dropped",
        what="the start path never syncs the leg key after connect, so a rotation during connect leaves the leg on the old key",
        file=STATE,
        search="""      await this.#syncLegKeyAfterConnect(activeLeg, e2eeKey);
""",
        replace="",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-keysync-push-skipped",
        what="the post-connect sync decides push but never pushes",
        file=STATE,
        search="""      await leg.setFrameKey(action.key);
""",
        replace="",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-rotation-setframekey-unawaited",
        what="the rotation listener pushes the leg key un-awaited, so a failed push never reaches its fail-closed catch",
        file=STATE,
        search="""            await leg.setFrameKey({
""",
        replace="""            void leg.setFrameKey({
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-rotation-guard-inverted",
        what="the rotation listener skips every LIVE leg, so a rotation never re-keys a share",
        file=STATE,
        search="""          if (!leg?.active()) return;
""",
        replace="""          if (leg?.active()) return;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-rotation-skip-stopping",
        what="the rotation listener skips a STOPPING leg, which a failed stop leaves live on the old key",
        file=STATE,
        search="""          if (!leg?.active()) return;
""",
        replace="""          if (!leg?.active() || leg.stopping()) return;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    # ---- C9: the start path's binding key read (4b-fix3; anchor per fix4) ----
    Mutation(
        id="state-leg-start-e2ee-branch-skipped",
        what="the start never takes the keyed branch, so an E2EE call starts a KEYLESS leg",
        file=STATE,
        search="""      if (modeAtConnect?.kind === "e2ee") {
        const key = this.#mlsKeyProvider?.lastLocalScreenKey();
""",
        replace="""      if (false) {
        const key = this.#mlsKeyProvider?.lastLocalScreenKey();
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-start-key-undefined",
        what="connect is handed no key, so an E2EE call starts a plaintext leg",
        file=STATE,
        search="""        e2ee: e2eeKey,
""",
        replace="""        e2ee: undefined,
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-start-group-check-dropped",
        what="the binding read takes a key from a superseded group",
        file=STATE,
        search="""          !key ||
          key.groupId !== this.#mlsSession.groupId()
        ) {
""",
        replace="""          !key
        ) {
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-start-active-check-dropped",
        what="the binding read takes a key while the session is not active",
        file=STATE,
        search="""          this.#mlsSession?.state() !== "active" ||
          !key ||
""",
        replace="""          !key ||
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-start-key-fields-swapped",
        what="the binding read hands connect the key index as the epoch and the epoch as the index",
        file=STATE,
        search="""          keyIndex: key.keyIndex,
          epoch: key.epoch,
""",
        replace="""          keyIndex: key.epoch,
          epoch: key.keyIndex,
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-start-early-return-before-sync",
        what="an encrypted start returns between connect and the key sync, so a rotation during connect is never pushed",
        file=STATE,
        search="""        e2ee: e2eeKey,
      });
""",
        replace="""        e2ee: e2eeKey,
      });
      if (e2eeKey) return;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-keyprovider-rewired",
        what="a second key provider replaces the wired one, so the rotation listener sits on an orphan provider",
        file=STATE,
        search="""        };
        this.#e2eeWorker = new E2EEWorker();
""",
        replace="""        };
        this.#mlsKeyProvider = new MlsKeyProvider();
        this.#e2eeWorker = new E2EEWorker();
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-keyprovider-listener-gated",
        what="the rotation listener is wired only behind the async native probe, so a call joined before it lands has none",
        file=STATE,
        search="""        const provider = this.#mlsKeyProvider;
        provider.onLocalScreenKey = async (key) => {
""",
        replace="""        if (nativeScreenShareAvailable()) {
        const provider = this.#mlsKeyProvider;
        provider.onLocalScreenKey = async (key) => {
""",
        also=[
            (
                """        };
        this.#e2eeWorker = new E2EEWorker();
""",
                """        };
        }
        this.#e2eeWorker = new E2EEWorker();
""",
            ),
        ],
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    # ---- C9: the mode re-reads (4b-fix4, 4c-i adjacency pin) -----------------
    Mutation(
        id="state-leg-start-e2ee-stale-mode",
        what="the keyed branch asks the TAP-time mode instead of the pre-connect one: an EQUIVALENT mutant, since the pre-connect kind check has already refused any mode whose kind moved since the tap, so it cannot start a keyless leg; killed by the stateWiring source pin alone (pin-only)",
        file=STATE,
        search="""      if (modeAtConnect?.kind === "e2ee") {
""",
        replace="""      if (mode?.kind === "e2ee") {
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-postsheet-stale-mode",
        what="the post-sheet refusal asks the TAP-time mode, so a re-upgrade during the sheet passes it",
        file=STATE,
        search="""    if (modeNow?.kind !== mode?.kind || this.#androidLegRefusedNow(modeNow)) {
""",
        replace="""    if (modeNow?.kind !== mode?.kind || this.#androidLegRefusedNow(mode)) {
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-postsheet-kind-check-dropped",
        what="the post-sheet refusal follows a mode that changed during the sheet instead of refusing",
        file=STATE,
        search="""    if (modeNow?.kind !== mode?.kind || this.#androidLegRefusedNow(modeNow)) {
""",
        replace="""    if (this.#androidLegRefusedNow(modeNow)) {
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-preclaim-recheck-dropped",
        what="no refusal between the tier sheet and the claim, so a gate added during the sheet costs an OS consent and drops the start (audit #3)",
        file=STATE,
        search="""    const modeNow = this.callMode();
    if (modeNow?.kind !== mode?.kind || this.#androidLegRefusedNow(modeNow)) {
      this.onErr(new Error(SHARE_UNAVAILABLE_NOW));
      return;
    }
""",
        replace="",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-preconnect-kind-check-dropped",
        what="the pre-connect re-read follows a mode that changed since the tap instead of refusing",
        file=STATE,
        search="""        modeAtConnect?.kind !== mode?.kind ||
        (modeAtConnect?.kind !== "e2ee" &&
          !this.#legPlaintextAuthorized(modeAtConnect))
""",
        replace="""        modeAtConnect?.kind !== "e2ee" &&
        !this.#legPlaintextAuthorized(modeAtConnect)
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-preconnect-await-before-read",
        what="an await slips in between the post-mint stale exit and the pre-connect mode read, so the mode can move after the stale check",
        file=STATE,
        search="""      const modeAtConnect = this.callMode();
""",
        replace="""      await Promise.resolve();
      const modeAtConnect = this.callMode();
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-preconnect-tapmode",
        what="the pre-connect re-read is replaced by the TAP-time mode, so the kind check compares the tap mode with itself and a call that became encrypted during consent starts a keyless leg (E2EE N30)",
        file=STATE,
        search="""      const modeAtConnect = this.callMode();
""",
        replace="""      const modeAtConnect = mode;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-preconnect-refusal-no-stop",
        what="the pre-connect refusal returns without stopping the leg, leaving consent and the FGS held",
        file=STATE,
        search="""      ) {
        await this.#stopAndroidLeg();
        this.onErr(new Error(SHARE_UNAVAILABLE_NOW));
""",
        replace="""      ) {
        this.onErr(new Error(SHARE_UNAVAILABLE_NOW));
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-plaintext-authorizes-negotiating",
        what="a negotiating call may start a keyless leg",
        file=STATE,
        search="""      case "negotiating":
      case "mixed":
      case "call_full":
      case "e2ee":
        return false;
""",
        replace="""      case "negotiating":
        return true;
      case "mixed":
      case "call_full":
      case "e2ee":
        return false;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-plaintext-authorizes-mixed",
        what="a mixed (paused) call may start a keyless leg",
        file=STATE,
        search="""      case "mixed":
      case "call_full":
      case "e2ee":
        return false;
""",
        replace="""      case "mixed":
        return true;
      case "call_full":
      case "e2ee":
        return false;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
    Mutation(
        id="state-leg-plaintext-authorizes-unconfirmed",
        what="an UNCONFIRMED plaintext interlude (a remote's announce) may start a keyless leg",
        file=STATE,
        search="""        return mode.localConfirmed;
""",
        replace="""        return true;
""",
        specs=[STATE_WIRING_SPEC],
        must_red=[STATE_WIRING_SPEC],
    ),
]



if __name__ == "__main__":
    sys.exit(main())
