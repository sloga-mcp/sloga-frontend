/**
 * How a request to turn the microphone ON publishes it.
 *
 * - `live`: published and unmuted, the way livekit's `setMicrophoneEnabled`
 *   does it.
 * - `muted`: published, or kept, MUTED. The capture, the publication and the
 *   mic pipeline all exist, and only the talk key unmutes it.
 */
export type MicEnable = "live" | "muted";

/**
 * Whether turning the microphone on means turning it on LIVE.
 *
 * Push to talk's rule is "muted unless the key is held", and every path that
 * turns the mic on used to break it: the join, Unmute, Undeafen and a
 * whisper's restore all published a live microphone, which stayed live until
 * the first press and release of the talk key. Under push to talk with no key
 * held the mic is published muted instead.
 *
 * Muted, not left unpublished. Publishing at the first press would cost that
 * press a capture and an offer/answer (the first words are lost), and a
 * release that lands before the publish does would leave the mic live. A
 * muted publication also carries the RNNoise / shaper / gain pipeline from
 * the start, so the first press sounds like every later one.
 *
 * Push to talk outranks voice activity, as `Voice.clean()` does for old data
 * that has both set, so `vadEnabled` is not an input.
 */
export function micEnableMode(input: {
  /** The persisted setting, read at the moment the mic is turned on. */
  pushToTalk: boolean;
  /** A talk key is down right now (`#pttHeld`). */
  pttHeld: boolean;
}): MicEnable {
  return input.pushToTalk && !input.pttHeld ? "muted" : "live";
}

/**
 * Whether a turn-on worked, which is what `micOn` is reconciled to.
 *
 * A live turn-on worked when the mic is live. A muted one worked when the mic
 * was captured and published: reading `isMicrophoneEnabled` there would
 * report every push-to-talk unmute as a failure and write `micOn = false`.
 */
export function micEnableTook(input: {
  mode: MicEnable;
  /** `isMicrophoneEnabled`: published and not muted. */
  live: boolean;
  /** A microphone publication with a track exists, muted or not. */
  captured: boolean;
}): boolean {
  return input.mode === "muted" ? input.captured : input.live;
}

/**
 * Whether a talk-key press opens the microphone, read once any muted publish
 * still in flight has landed.
 *
 * That publish (the join's, or an Unmute's) takes a capture and an
 * offer/answer. A press made during it has to wait, and the key can be
 * released before it lands: opening anyway would leave the mic live with no
 * key held. A whisper keeps the room mic shut, and a mic that is already live
 * needs nothing.
 */
export function pttPressOpens(input: {
  held: boolean;
  whispering: boolean;
  micLive: boolean;
}): boolean {
  return input.held && !input.whispering && !input.micLive;
}
