import { createEffect, createMemo } from "solid-js";
import { AudioTrack, useTracks } from "solid-livekit-components";

import { getTrackReferenceId, isLocal } from "@livekit/components-core";
import { Key } from "@solid-primitives/keyed";
import { RemoteTrackPublication, Track } from "livekit-client";

import { useState } from "@revolt/state";

import { useVoice } from "../state";

export function RoomAudioManager() {
  const voice = useVoice();
  const state = useState();

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
    tracks().filter(
      (track) =>
        !isLocal(track.participant) &&
        track.publication.kind === Track.Kind.Audio,
    ),
  );

  const filteredVideoTracks = createMemo(() =>
    videoTracks().filter((track) => !isLocal(track.participant)),
  );

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
        {(track) => (
          <AudioTrack
            trackRef={track()}
            volume={
              state.voice.outputVolume *
              (track().source === Track.Source.ScreenShareAudio
                ? state.voice.getScreenShareVolume(track().participant.identity)
                : state.voice.getUserVolume(track().participant.identity))
            }
            muted={
              (track().source === Track.Source.ScreenShareAudio
                ? state.voice.getScreenShareMuted(track().participant.identity)
                : state.voice.getUserMuted(track().participant.identity)) ||
              voice.deafen()
            }
            enableBoosting
          />
        )}
      </Key>
    </div>
  );
}
