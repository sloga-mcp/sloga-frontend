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
 * Under push to talk it worked when the mic was captured and published,
 * whatever the talk key did: reading `isMicrophoneEnabled` there would report
 * every muted Unmute as a failure, and so would a live one (key held) whose
 * key was released before the publish landed. Either wrote `micOn = false`,
 * played the mute sound for an Unmute click, and joined the next call with no
 * mic. Otherwise it worked when the mic is live.
 */
export function micEnableTook(input: {
  /** The persisted setting, read when the turn-on finished. */
  pushToTalk: boolean;
  /** `isMicrophoneEnabled`: published and not muted. */
  live: boolean;
  /** A microphone publication with a track exists, muted or not. */
  captured: boolean;
}): boolean {
  return input.pushToTalk ? input.captured : input.live;
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
 *
 * Muted or Deafened, the talk key does nothing: the user's own mute outranks
 * it, as it outranks voice activity (`vadGatePolicy.ts`). It used to open the
 * mic anyway, so a Muted user went on the wire while the button read Muted.
 */
export function pttPressOpens(input: {
  held: boolean;
  whispering: boolean;
  micLive: boolean;
  /** Muted or Deafened (`!micOn || deafen`). */
  userMuted: boolean;
}): boolean {
  return input.held && !input.whispering && !input.micLive && !input.userMuted;
}

/**
 * Whether a live turn-on under push to talk may stay live once it has landed.
 * When this is false the caller mutes it again.
 *
 * A talk-key release mutes through livekit, and livekit's disable waits for
 * its own publish in flight for 10 s at most
 * (`waitForPendingPublicationOfSource`, 2.15.13). While that publish is still
 * in `getUserMedia`, on a mic-permission prompt, there is nothing to wait for
 * yet. The disable gives up, and the capture lands LIVE after the key went up.
 * The same goes for a Mute pressed, or a whisper begun, while it was landing.
 * Read after the landing, so it sees all three.
 *
 * Outside push to talk the mic mode decides, and this leaves the mic alone.
 */
export function pttLiveStays(input: {
  pushToTalk: boolean;
  held: boolean;
  whispering: boolean;
  /** Muted or Deafened, for a caller whose own write is not one. */
  userMuted: boolean;
}): boolean {
  if (!input.pushToTalk) return true;
  return input.held && !input.whispering && !input.userMuted;
}

/**
 * Whether a window losing focus mutes the microphone.
 *
 * A DOM key-up goes only to the focused window, so a release made after
 * alt-tabbing away mid-hold never arrives, and the mic stayed live until the
 * user came back and pressed the key again. The blur is the last edge there
 * will be, so it counts as the release.
 *
 * The one exception is a hold the desktop shell's native hook delivered
 * (`ptt:down`): the hook sends `ptt:up` for every down it sent, so that
 * release is still coming. An ARMED hook is not enough. It is blind while a
 * Sloga window has focus (`ptt.rs`), and only sends `ptt:up` for a down it
 * saw, so a hold begun in Sloga and alt-tabbed away from gets no release
 * from it either (Alt+Tab moves the key repeat to Tab, so the hook never
 * sees the talk key go down).
 */
export function pttBlurMutes(input: {
  pushToTalk: boolean;
  /** `#pttHeld` as it was before the blur cleared it. */
  held: boolean;
  /** The native hook delivered this hold's `ptt:down`. */
  nativeSawHold: boolean;
}): boolean {
  return input.pushToTalk && input.held && !input.nativeSawHold;
}

/**
 * Whether the user muted or deafened while a live turn-on was landing.
 *
 * Only a CHANGE counts, from what was read when the turn-on began. Each
 * caller writes its own `micOn` / `deafen` once the turn-on returns (Unmute
 * still reads `micOn` false, Undeafen still reads `deafen` true), so the
 * current values alone would read every Unmute as Muted.
 */
export function mutedWhileLanding(
  before: { micOn: boolean; deafen: boolean },
  after: { micOn: boolean; deafen: boolean },
): boolean {
  return (before.micOn && !after.micOn) || (!before.deafen && after.deafen);
}

/**
 * How long push to talk's muted capture may wait on `getUserMedia`: the
 * figure livekit uses for a disable waiting on its own pending publish.
 */
export const MUTED_CAPTURE_TIMEOUT_MS = 10_000;

/** The rejection {@link captureWithin} gives up with. */
export class MicCaptureTimeoutError extends Error {
  constructor(ms: number) {
    super(`The microphone capture did not finish within ${ms} ms`);
    this.name = "MicCaptureTimeoutError";
  }
}

/** Whether `error` is {@link captureWithin} giving up. */
export function isMicCaptureTimeout(error: unknown): boolean {
  return error instanceof MicCaptureTimeoutError;
}

/**
 * `capture`, given up on after `ms`.
 *
 * Push to talk's muted publish holds every Mute, Deafen and talk-key write
 * behind it. Its capture can wait on a mic-permission prompt for as long as
 * the prompt is open, and every one of those writes waited with it. After `ms`
 * this rejects with {@link MicCaptureTimeoutError}, so they go through.
 *
 * The capture itself cannot be cancelled. If it resolves anyway, its tracks go
 * to `stop` and never reach the caller, so a late capture is never published:
 * there is no second track, and nothing goes live. A late rejection is
 * swallowed. `capture` is handed `expired`, true once this has given up, so
 * it can skip work that only made sense for a capture still wanted (a retry,
 * or a change to shared state).
 */
export function captureWithin<T>(
  capture: (expired: () => boolean) => Promise<T[]>,
  ms: number,
  stop: (track: T) => void,
): Promise<T[]> {
  let late = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      late = true;
      reject(new MicCaptureTimeoutError(ms));
    }, ms);
    capture(() => late).then(
      (tracks) => {
        if (late) {
          for (const track of tracks) stop(track);
          return;
        }
        clearTimeout(timer);
        resolve(tracks);
      },
      (error) => {
        if (late) return;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
