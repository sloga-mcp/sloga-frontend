/** The three mutually exclusive microphone modes (`Voice.setMicrophoneMode`). */
export type MicMode = "openMic" | "vad" | "pushToTalk";

/**
 * The mode the persisted voice settings select. Push to talk outranks voice
 * activity, the same precedence `Voice.clean()` applies to old data that has
 * both set.
 */
export function micModeOf(settings: {
  vadEnabled: boolean;
  pushToTalk: boolean;
}): MicMode {
  if (settings.pushToTalk) return "pushToTalk";
  if (settings.vadEnabled) return "vad";
  return "openMic";
}

/** Everything a mid-call mode switch decides from. */
export type MicModeSwitchInputs = {
  /** The mode just selected. */
  next: MicMode;
  /** The user's own intent: `micOn && !deafen`. */
  intentOn: boolean;
  /** An aside is in progress; the whisper owns the room mic until it ends. */
  whispering: boolean;
  /** `publishToggleRefusal` would refuse enabling the mic (AFK, no Speak). */
  publishRefused: boolean;
  /** A push-to-talk key is held right now (`#pttHeld`). */
  pttHeld: boolean;
};

export type MicModeSwitchPlan = {
  /** Whether the voice-activity gate runs from now on. */
  vad: "start" | "stop";
  /** Whether the desktop shell's global push-to-talk hook stays armed. */
  nativePtt: "arm" | "disarm";
  /** What happens to the published microphone this instant. */
  mic: "on" | "off" | "keep";
  /**
   * What the room mic returns to when a whisper in progress ends, replacing
   * the state saved when it began; `undefined` keeps the saved one. Read only
   * while whispering.
   */
  afterWhisper: boolean | undefined;
};

/**
 * What switching the microphone mode in the middle of a call does.
 *
 * Before this existed a switch did nothing until the next join: the
 * voice-activity gate is started only by `connect()`, and the push-to-talk
 * handlers return early once `pushToTalk` is off. So push to talk -> voice
 * activity left the microphone muted for the rest of the call (the user
 * spoke, nothing opened it, and their key no longer did either), open mic ->
 * voice activity left it hot, and voice activity -> push to talk left the gate
 * opening it on every word.
 *
 * Pure so each of those is pinned by a spec rather than by a live call.
 *
 * - **Voice activity** keeps the microphone as it is. The gate takes over from
 *   its first tick: it closes a hot mic after its silence countdown and opens
 *   a shut one on speech, and it already defers to the user's mute, deafen
 *   and whisper.
 * - **Push to talk** mutes unless the key is down right now. A switch made
 *   mid-hold leaves the mic for that hold's release to close.
 * - **Open mic** turns the microphone on when the user wants it on, nothing
 *   is suppressing it, and publishing is allowed; it mutes when the user does
 *   not want it on. A whisper or a refused publish leaves it alone: the
 *   whisper restores the room mic itself when it ends, and a refused enable is
 *   off already.
 *
 * A whisper saves the room mic's state when it begins and restores it when it
 * ends, so a switch made mid-whisper also rewrites what it restores
 * (`afterWhisper`). Left alone, the restore would undo the switch: Open Mic ->
 * push to talk mid-whisper turned the mic back on, hot, with no key held, and
 * push to talk -> Open Mic left it off while the button read live.
 */
export function micModeSwitchPlan(
  inputs: MicModeSwitchInputs,
): MicModeSwitchPlan {
  switch (inputs.next) {
    case "vad":
      // The gate opens and closes the mic itself once the whisper is over.
      return {
        vad: "start",
        nativePtt: "disarm",
        mic: "keep",
        afterWhisper: undefined,
      };
    case "pushToTalk":
      return {
        vad: "stop",
        nativePtt: "arm",
        mic: inputs.pttHeld ? "keep" : "off",
        afterWhisper: false,
      };
    case "openMic":
      if (!inputs.intentOn) {
        return {
          vad: "stop",
          nativePtt: "disarm",
          mic: "off",
          afterWhisper: false,
        };
      }
      return {
        vad: "stop",
        nativePtt: "disarm",
        mic: inputs.whispering || inputs.publishRefused ? "keep" : "on",
        afterWhisper: !inputs.publishRefused,
      };
  }
}
