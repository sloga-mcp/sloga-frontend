#!/usr/bin/env python3
"""Mutation-verify the RTC/MLS specs.

    packages/client/scripts/rtc-mutations.py [--list] [--only ID[,ID...]]

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
#: No entry targets `state.tsx` any more — wave 1 moved everything a mutation
#: could reach into `publishGateEpisode.ts`, and the seam wave moved the
#: verdict DERIVATION into `pauseVerdict.ts` (see `VERDICT` below). What is
#: LEFT in `state.tsx` is WIRING, and it is still unreachable here: that
#: `beginDrive` is passed as
#: `coalescingSweeper`'s FOURTH positional argument (a three-argument call
#: still compiles and silently degrades drive scope to no scope), that the
#: `EpisodeDeps` thunks are bound to the right room, and that `scheduleConfirm`
#: is a `setTimeout` rather than a microtask. A mutation cannot reach any of
#: it, because `node --test` cannot import the file. Recorded here rather than
#: as an `expect="green"` entry, which would be an admission dressed as a
#: measurement.
#:
#: 🔴 ZERO entries carry `file=STATE`, and the wave-1 fix round ADDED to what
#: that leaves unmeasured. `#gateGen` plus the per-sweeper `stillCurrent`
#: closure (`gen === this.#gateGen && this.room() === room`, captured when the
#: sweeper is BUILT) is now the only thing keeping a sweep parked on an awaited
#: livekit op from spending publications in the NEXT call's episode. The
#: `publishGateEpisode.ts` specs pin what the episode DOES when `stillCurrent()`
#: answers false; nothing pins that the closure ANSWERS false for a disposed
#: sweeper, and nothing in this table can. Do not paper over it with a
#: source-text assertion: a `grep -qF` over a file no runner can load does not
#: converge — one comment line defeats it. Closing this needs a further
#: extraction or a live leg, not another entry here.
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
REJOIN_POLICY_SPEC = "components/rtc/mlsRejoinPolicy.test.ts"
INBOUND_BUFFER_SPEC = "components/client/mlsInboundBuffer.test.ts"
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
        mutated = mutated.replace(search, replace)
    path.write_text(mutated, encoding="utf-8")
    return original


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()

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
        search="""        detaching = publication.pauseUpstream();""",
        replace="""        detaching = publication.resumeUpstream();""",
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
        search="""      this.#joinedGeneration = this.#establishGeneration;
""",
        replace="""      this.#joinedGeneration = this.#establishGeneration;
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
        search="""    observedEncrypted: observedEncryptionMap(publishing, (identity) =>
      sources.observedEncryption(identity),
    ),""",
        replace="""    observedEncrypted: observedEncryptionMap(publishing, () => true),""",
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
        search="""      this.#welcomeCurrency = {
        groupId: outcome.group_id,
        epoch: outcome.epoch,
        generation: this.#establishGeneration,
      };""",
        replace="""      this.#toActive();""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
    ),
    Mutation(
        id="welcome-active-before-currency",
        what="the adopt block goes active AND records the check, so the session is green — and the enable can empty the gate — before the DS has said whether the Welcome is current",
        file=SESSION,
        # Re-measured 2026-09-26 (fix pass 1): killed by 17 of 33: C1, C1r, C3,
        # C3b, C4, C6, C7, C8, C9, R1a, R1b, R1c, C1r+, E1, E2, E3 and E4.
        search="""      this.#welcomeCurrency = {
        groupId: outcome.group_id,
        epoch: outcome.epoch,
        generation: this.#establishGeneration,
      };""",
        replace="""      this.#toActive();
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
        what="the caught-up install is judged on the install counter and the fence alone, not on OUR send key's epoch (LDA-M1): an install that left our send key on the older epoch still reads as installed, and the session goes green publishing under a key a removed member holds",
        file=SESSION,
        # Measured 2026-09-26 (fix pass 1): killed by E2 alone (1 of 33).
        search="""      this.#installEpoch === epoch &&
      this.#ownSendKeyEpoch === epoch
    );""",
        replace="""      this.#installEpoch === epoch
    );""",
        specs=[DRAINFAIL_SPEC],
        must_red=[DRAINFAIL_SPEC],
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
        search="""const tokens = this.#deps.startupWipeTokens ?? startupWipedChannels;""",
        replace="""const tokens = startupWipedChannels;""",
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


if __name__ == "__main__":
    sys.exit(main())
