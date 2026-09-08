import { createEffect, createMemo, onCleanup } from "solid-js";
import { AudioTrack, useTracks } from "solid-livekit-components";

import { getTrackReferenceId, isLocal } from "@livekit/components-core";
import { Key } from "@solid-primitives/keyed";
import {
  RemoteAudioTrack,
  RemoteTrackPublication,
  Track,
} from "livekit-client";

import { useState } from "@revolt/state";
import {
  isScreenLeg,
  participantUserId,
  stripLeg,
} from "@revolt/ui/components/features/voice/participantIdentity";

import { TrackNormalizer, ensureNormalizerWorklet } from "../audioNormalizer";
import {
  type RemotePublicationEncryption,
  cryptorDisarmIdentities,
  resolveCryptorControl,
} from "../plaintextCryptorPolicy";
import { useVoice } from "../state";
import { identityUserId, whisperTarget } from "../whisperPermissions";

export function RoomAudioManager() {
  const voice = useVoice();
  const state = useState();

  const myUserId = () => {
    const identity = voice.room()?.localParticipant.identity;
    return identity ? identityUserId(identity) : undefined;
  };

  const tracks = useTracks(
    [
      Track.Source.Microphone,
      Track.Source.ScreenShareAudio,
      Track.Source.Unknown,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: false,
    },
  );

  // Subscribe to remote video tracks (camera + screen share) so they are received
  const videoTracks = useTracks(
    [
      Track.Source.Camera,
      Track.Source.ScreenShare,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: false,
    },
  );

  const filteredTracks = createMemo(() =>
    tracks().filter((track) => {
      if (isLocal(track.participant)) return false;
      if (track.publication.kind !== Track.Kind.Audio) return false;
      // Whisper tracks addressed to someone else: the SFU already refuses us
      // the subscription, but don't even try — a permission gap must not
      // become audible here, and the retry churn is pointless.
      const addressee = whisperTarget(track.publication.trackName);
      if (addressee && addressee !== myUserId()) return false;
      return true;
    }),
  );

  // Receiving-side whisper indicator: the first whisper track addressed to
  // us that is actually flowing. Cleared when it goes away. Skip entirely
  // until our own identity is known — during connect/teardown it is
  // undefined, and `whisperTarget(...) === undefined` would tag a plain
  // (non-whisper) mic track as an incoming whisper.
  createEffect(() => {
    const me = myUserId();
    const whisper = me
      ? filteredTracks().find(
          (track) => whisperTarget(track.publication.trackName) === me,
        )
      : undefined;
    voice.noteIncomingWhisper(whisper?.participant.identity);
  });

  const filteredVideoTracks = createMemo(() =>
    videoTracks().filter((track) => {
      if (isLocal(track.participant)) return false;
      // The publishing phone never subscribes to its OWN screen leg (plan
      // §0.9/§7.3a): the leg is a REMOTE participant here, so without this
      // the sharer's device downloads its own full-rate stream just to show
      // its screen showing its screen. By DEVICE, not user — another of our
      // devices' legs is a genuine remote share.
      const identity = track.participant.identity;
      if (
        isScreenLeg(identity) &&
        stripLeg(identity) === voice.room()?.localParticipant.identity
      )
        return false;
      return true;
    }),
  );

  // ---- Incoming-voice normalization (rtc/audioNormalizer.ts) -------------
  //
  // Per remote MIC track, inserts [meter, AGC gain, limiter] into livekit's
  // shared web-audio graph via `setWebAudioPlugins`. Microphone source ONLY:
  // `Track.Source.ScreenShareAudio` and `Track.Source.Unknown` are excluded
  // on purpose — normalization is a speech tool, and an AGC riding game
  // audio or music pumps on every loud moment (§2.4 of the plan).
  //
  // Keyed by trackSid, compared by track OBJECT: a reconnect swaps the track
  // under the same sid without remounting anything here, so object identity
  // is what detects "this sid needs re-wiring" (the same mechanism that
  // motivated webAudioMix itself).
  const normalizers = new Map<
    string,
    { normalizer: TrackNormalizer; track: RemoteAudioTrack }
  >();
  /** Worklet load result per context; a failed load disables the feature for
   *  that call rather than half-wiring a graph (§5 fail-safe). */
  const workletLoads = new WeakMap<AudioContext, Promise<boolean>>();
  let pluginApiWarned = false;

  const loadWorklet = (context: AudioContext): Promise<boolean> => {
    let load = workletLoads.get(context);
    if (!load) {
      load = ensureNormalizerWorklet(context).then(
        () => true,
        (error) => {
          console.warn(
            "[rtc] normalizer worklet failed to load; incoming-voice normalization is off for this call",
            error,
          );
          return false;
        },
      );
      workletLoads.set(context, load);
    }
    return load;
  };

  const removeNormalizer = (sid: string) => {
    const entry = normalizers.get(sid);
    if (!entry) return;
    normalizers.delete(sid);
    // Order matters: hand the SDK its plain graph back FIRST (this rewires
    // synchronously), then disconnect our nodes. The other way round leaves
    // the SDK holding disposed nodes until the next attach.
    try {
      entry.track.setWebAudioPlugins([]);
    } catch {
      // The track may already be gone; its graph went with it.
    }
    entry.normalizer.dispose();
  };

  /** Set on unmount so an in-flight worklet load cannot re-populate the map
   *  after the final sweep has run. */
  let wiringDisposed = false;

  const attachNormalizer = async (
    context: AudioContext,
    publication: RemoteTrackPublication,
    track: RemoteAudioTrack,
    sid: string,
    strength: number,
    manualGain: number,
  ) => {
    if (!(await loadWorklet(context))) return;
    // Re-check the world after the await — each guard has a concrete trace:
    // component unmounted; the call ended or a new call replaced the context;
    // the setting flipped off; a reconnect swapped the track under this sid
    // (publication.track is the arbiter of "current", not the map); the
    // track ended outright.
    if (wiringDisposed) return;
    if (voice.callAudioContext() !== context) return;
    if (!state.voice.audioNormalization) return;
    if (publication.track !== track) return;
    if (track.mediaStreamTrack.readyState === "ended") return;
    const existing = normalizers.get(sid);
    if (existing) {
      // A competing attach already wired this exact track: done. A stale
      // entry for a PREVIOUS track object loses to us (we just proved our
      // track is the publication's current one).
      if (existing.track === track) return;
      removeNormalizer(sid);
    }
    const normalizer = new TrackNormalizer(context, { strength, manualGain });
    normalizers.set(sid, { normalizer, track });
    track.setWebAudioPlugins(normalizer.nodes);
  };

  createEffect(() => {
    const context = voice.callAudioContext();
    const enabled = state.voice.audioNormalization && context !== undefined;
    const strength = state.voice.audioNormalizationStrength;
    const outputVolume = state.voice.outputVolume;
    const tracks = filteredTracks();

    if (!enabled) {
      for (const sid of [...normalizers.keys()]) removeNormalizer(sid);
      return;
    }

    const seen = new Set<string>();
    for (const ref of tracks) {
      if (ref.source !== Track.Source.Microphone) continue;
      const publication = ref.publication;
      const track = publication.track;
      if (!(track instanceof RemoteAudioTrack)) continue;
      if (typeof track.setWebAudioPlugins !== "function") {
        // §5 fail-safe: the plugin surface is @internal in livekit's typings,
        // so a future SDK bump may remove it. Raw path, feature off, loudly.
        if (!pluginApiWarned) {
          pluginApiWarned = true;
          console.warn(
            "[rtc] livekit-client no longer exposes setWebAudioPlugins; incoming-voice normalization is unavailable",
          );
        }
        continue;
      }

      const sid = publication.trackSid;
      seen.add(sid);
      // Same key the <AudioTrack> volume prop uses below: the bare USER id,
      // matching what the per-user slider writes — SFU identities are
      // device-qualified on encrypted calls.
      const manualGain =
        outputVolume *
        state.voice.getUserVolume(participantUserId(ref.participant.identity));

      const existing = normalizers.get(sid);
      if (existing && existing.track === track) {
        existing.normalizer.setStrength(strength);
        existing.normalizer.setManualGain(manualGain);
        continue;
      }
      // First sight of this sid, or a reconnect swapped the track object.
      removeNormalizer(sid);
      void attachNormalizer(
        context!,
        publication as RemoteTrackPublication,
        track,
        sid,
        strength,
        manualGain,
      );
    }

    for (const sid of [...normalizers.keys()]) {
      if (!seen.has(sid)) removeNormalizer(sid);
    }
  });

  onCleanup(() => {
    wiringDisposed = true;
    for (const sid of [...normalizers.keys()]) removeNormalizer(sid);
  });
  // ------------------------------------------------------------------------

  // ---- Plaintext cryptor disarm (rtc/plaintextCryptorPolicy.ts) ----------
  //
  // The Room is built E2EE-capable even on plaintext calls (see connect() in
  // state.tsx), and livekit installs its decode transform on EVERY subscribed
  // remote track while arming the per-participant cryptor from
  // `trackInfo.encryption !== NONE` — a rule that misreads a missing field as
  // "encrypted" and then silently destroys every frame from a plaintext
  // publisher: packets arrive with zero loss, zero samples decode, the peer
  // is inaudible (the 2026-08-30 silent-Linux-peer signature). Assert the
  // state we know instead of trusting that comparison: force the cryptor OFF
  // for every participant whose publications declare plaintext.
  //
  // Re-asserted on EVERY run on purpose: livekit re-arms from its own
  // TrackPublished handler and its Connected sweep, and both fire alongside
  // the track-list changes that re-run this effect — a disarm-once would
  // quietly lose the next round.
  let cryptorSurfaceWarned = false;
  let cryptorManagerMissingWarned = false;
  let cryptorControlThrewWarned = false;
  let lastDisarmed = "";
  let lastEncryptionEvidence = "";
  const cryptorDisarmSweep = () => {
    const room = voice.room();
    if (!room) return;
    const publications: RemotePublicationEncryption[] = [];
    for (const ref of [...tracks(), ...videoTracks()]) {
      if (isLocal(ref.participant)) continue;
      publications.push({
        participantIdentity: ref.participant.identity,
        encryption: ref.publication.trackInfo?.encryption,
      });
    }
    // Logged (on change) so a live leg can capture the ACTUAL arm-time
    // encryption values — the one measurement that distinguishes "field was
    // missing" from "the SFU stamped a non-zero type" if a peer is ever
    // silent again despite this sweep.
    const evidence = JSON.stringify(
      publications.map((p) => [p.participantIdentity, p.encryption ?? null]),
    );
    if (evidence !== lastEncryptionEvidence) {
      lastEncryptionEvidence = evidence;
      console.info("[rtc] remote publication encryption", evidence);
    }
    const disarm = cryptorDisarmIdentities(publications);
    if (disarm.length === 0) return;
    const probe = resolveCryptorControl(room);
    if (probe.kind === "no-manager") {
      // A Room built without the `e2ee` option has no manager, no transform,
      // and nothing to disarm — benign. But when the option WAS passed a
      // manager must exist: its absence means an SDK bump renamed the
      // @internal field, and the arming transform is likely still installed
      // with no way to reach it. That must be loud, not the benign branch.
      //
      // `callE2EERoomArmed()`, not `callE2EECapable()`: those stopped being
      // the same thing when a provider/worker construction failure became a
      // loud hold rather than a capability drop, and reading the wrong one
      // fires an "SDK renamed the field" alarm at a call whose SDK is fine.
      if (voice.callE2EERoomArmed() && !cryptorManagerMissingWarned) {
        cryptorManagerMissingWarned = true;
        console.warn(
          "[rtc] Room was built E2EE-capable but no e2eeManager was found; cannot disarm the frame cryptor for plaintext publishers — their audio/video may not decode",
        );
      }
      return;
    }
    if (probe.kind === "unsupported") {
      // Same posture as the setWebAudioPlugins fail-safe below: the surface
      // is @internal, an SDK bump may remove it — then plaintext peers may go
      // silent again and we say so, rather than reaching in quietly.
      if (!cryptorSurfaceWarned) {
        cryptorSurfaceWarned = true;
        console.warn(
          "[rtc] livekit-client no longer exposes e2eeManager.setParticipantCryptorEnabled; cannot disarm the frame cryptor for plaintext publishers — their audio/video may not decode",
        );
      }
      return;
    }
    for (const identity of disarm) {
      try {
        probe.control(false, identity);
      } catch (error) {
        // Unreachable today (the worker exists whenever the manager does),
        // but a future SDK throw must not kill this effect — or the interval
        // below — while leaving the rest of the sweep unasserted.
        if (!cryptorControlThrewWarned) {
          cryptorControlThrewWarned = true;
          console.warn(
            "[rtc] setParticipantCryptorEnabled threw; plaintext publishers may not decode",
            error,
          );
        }
      }
    }
    const summary = disarm.join(",");
    if (summary !== lastDisarmed) {
      lastDisarmed = summary;
      console.info(
        "[rtc] frame cryptor disarmed for plaintext publishers",
        disarm,
      );
    }
  };
  createEffect(cryptorDisarmSweep);
  // Safety net for EVENTLESS info updates: for an already-known publication,
  // `RemoteParticipant.updateInfo` rewrites `trackInfo` via
  // `publication.updateInfo(ti)` without emitting any room event
  // (TrackPublished fires only for new sids) — so an encryption field that
  // settles AFTER the arm would never re-run the effect in an otherwise
  // quiet call, and the cryptor would stay armed for the call's whole life.
  // A slow re-check costs pure reads plus at most one worker postMessage per
  // disarmed identity; signal reads outside a computation are plain reads,
  // so this tracks nothing.
  const cryptorRecheck = setInterval(cryptorDisarmSweep, 5_000);
  onCleanup(() => clearInterval(cryptorRecheck));
  // ------------------------------------------------------------------------

  createEffect(() => {
    const tracks = filteredTracks();
    console.info("[rtc] filtered tracks", filteredTracks());
    for (const track of tracks) {
      (track.publication as RemoteTrackPublication).setSubscribed(true);
      console.info(track.publication);
    }
  });

  // Subscribe to remote video tracks so screen share and camera are received
  createEffect(() => {
    for (const track of filteredVideoTracks()) {
      (track.publication as RemoteTrackPublication).setSubscribed(true);
    }
  });

  return (
    <div style={{ display: "none" }}>
      <Key each={filteredTracks()} by={(item) => getTrackReferenceId(item)}>
        {(track) => {
          // Per-user settings are keyed by USER id (what the context menu
          // writes), never the device-qualified SFU identity.
          const settingsUserId = () =>
            participantUserId(track().participant.identity);
          const effectiveVolume = () =>
            state.voice.outputVolume *
            (track().source === Track.Source.ScreenShareAudio
              ? state.voice.getScreenShareVolume(settingsUserId())
              : state.voice.getUserVolume(settingsUserId()));
          return (
            <AudioTrack
              trackRef={track()}
              // Never hand the SDK an exact 0: its attach()/connectWebAudio
              // restore volume under `if (this.elementVolume)`, so a stored 0
              // would silently come back at FULL volume on the next re-wire
              // (reconnect). Zero is expressed as `muted` below — the
              // setEnabled path, which unsubscribes server-side and cannot be
              // resurrected by a falsy guard. The floor is -80 dB: inaudible,
              // but truthy.
              volume={Math.max(effectiveVolume(), 0.0001)}
              muted={
                (track().source === Track.Source.ScreenShareAudio
                  ? state.voice.getScreenShareMuted(settingsUserId())
                  : state.voice.getUserMuted(settingsUserId())) ||
                effectiveVolume() === 0 ||
                voice.deafen()
              }
              enableBoosting
            />
          );
        }}
      </Key>
    </div>
  );
}
