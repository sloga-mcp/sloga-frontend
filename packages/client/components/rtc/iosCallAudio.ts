/**
 * The page side of the iOS call audio-session bracket (R5, W3 MUST 2). The
 * native half is the `SlogaCallAudio` Capacitor plugin
 * (`ios/App/SlogaE2ee/Sources/SlogaE2ee/CallAudioSession.swift`), which holds
 * the app's AVAudioSession active as a voice call between `start` and `stop`.
 * This is the pure core; `state.tsx` owns only the wiring (it injects the
 * plugin's `start`/`stop`), split out for the house reason: `state.tsx` pulls
 * in Solid, LiveKit and the bridge and cannot be loaded by `node --test`.
 *
 * Used on EVERY iOS call, plaintext ones included: the Release build declares
 * `UIBackgroundModes = [audio]`, and Guideline 2.5.4 requires that mode to be
 * used for its purpose and only for it. Android keeps VoiceCallService.
 *
 * The bracket:
 *   - `callLive`: the call went live. Starts the session unless this bracket
 *     already holds it, so a second `callLive` is one `start`.
 *   - `callEnded`: the call is over. Stops the session if this bracket holds
 *     it; without a held session it is a no-op. 🔴 The CALLER guarantees it
 *     runs only after the room disconnected and its tracks stopped: a `stop`
 *     while WebKit still captures can take the session away from that
 *     capture (CallAudioSession.swift header).
 *   - `interruptionEnded`: an interruption (a phone call, an alarm) is over
 *     while the call is live. The system deactivated the session, but the
 *     plugin does not observe interruptions and still believes it is active,
 *     so a bare `start` would be a no-op. Hence `stop` then `start`. If the
 *     bracket does not hold the session (an earlier `start` failed) there is
 *     nothing to stop and it only retries `start`. Not live: a no-op.
 *
 * `held` mirrors the plugin's own `active` flag: a `start` that rejects leaves
 * the plugin inactive (so `held` stays false and the next `callLive` or
 * `interruptionEnded` tries again), and a `stop` that rejects leaves it active
 * (so `held` stays true and the next `callEnded` tries again). The plugin
 * resolves a stop that hit `isBusy`, since the session went inactive anyway.
 *
 * 🔴 Serialised: every op waits until the previous one settled, then reads
 * the state. Two interleaved ops would each read a stale `held`, e.g. a
 * `callEnded` issued while `start` is in flight would skip its `stop`, and the
 * session (and the app, in the background) would stay alive after the call.
 *
 * 🔴 Never throws: a reject, a synchronous throw from the injected function,
 * or a throwing `onFailure` handler never reaches the caller, which is call
 * teardown. A failure goes to `onFailure` as a {@link CallAudioFailure} and
 * the queue keeps going. Nothing here is logged.
 */

/**
 * `unavailable`: the plugin is not there or not armed (the bridge guard did
 * not install, or Capacitor has no such plugin). `audio_session_failed`: the
 * plugin ran and AVAudioSession refused, or the reject is not one this module
 * recognises.
 */
export type CallAudioFailure = "audio_session_failed" | "unavailable";

export interface CallAudioBracket {
  callLive(): Promise<void>;
  callEnded(): Promise<void>;
  interruptionEnded(): Promise<void>;
}

/**
 * Every reject code the plugin can produce, mapped. The `call_audio_*` codes
 * are CallAudioSession.swift's `Failure` enum (the plugin sets message and
 * code to the same fixed string); the spec reads that enum and fails on a code
 * missing here. `UNIMPLEMENTED` / `UNAVAILABLE` are Capacitor's own
 * `ExceptionCode`s for a plugin that is not registered on this platform.
 */
export const CALL_AUDIO_REJECT_CODES: ReadonlyMap<string, CallAudioFailure> =
  new Map<string, CallAudioFailure>([
    ["call_audio_unavailable", "unavailable"],
    ["call_audio_category_failed", "audio_session_failed"],
    ["call_audio_insufficient_priority", "audio_session_failed"],
    ["call_audio_activate_failed", "audio_session_failed"],
    ["call_audio_deactivate_failed", "audio_session_failed"],
    ["UNIMPLEMENTED", "unavailable"],
    ["UNAVAILABLE", "unavailable"],
  ]);

/**
 * Maps a `start`/`stop` rejection to a {@link CallAudioFailure}. Reads the
 * error's `code`, then its `message` (Capacitor copies both from the native
 * reject). Anything unrecognised, including a non-object, is
 * `audio_session_failed`: a failure that cannot be classified is still a
 * failure.
 */
export function callAudioFailure(reason: unknown): CallAudioFailure {
  if (typeof reason !== "object" || reason === null) {
    return "audio_session_failed";
  }
  try {
    for (const field of ["code", "message"] as const) {
      const value = (reason as Record<string, unknown>)[field];
      if (typeof value === "string") {
        const mapped = CALL_AUDIO_REJECT_CODES.get(value);
        if (mapped !== undefined) return mapped;
      }
    }
  } catch {
    // A throwing getter on a foreign error object: unclassifiable.
  }
  return "audio_session_failed";
}

const noop = () => {};

export function createCallAudioBracket(deps: {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onFailure: (f: CallAudioFailure) => void;
}): CallAudioBracket {
  /** Between `callLive` and `callEnded`. */
  let live = false;
  /** This bracket's last successful op was a `start` (mirrors the plugin). */
  let held = false;
  /** The settled-or-pending end of the queue. Never rejects. */
  let tail: Promise<void> = Promise.resolve();

  const report = (reason: unknown) => {
    try {
      deps.onFailure(callAudioFailure(reason));
    } catch {
      // The handler's own bug must not reach call teardown or stall the queue.
    }
  };

  /** Runs one native op; true when it resolved. Never rejects. */
  const attempt = async (op: () => Promise<void>): Promise<boolean> => {
    try {
      await op();
      return true;
    } catch (reason) {
      report(reason);
      return false;
    }
  };

  const startNow = async () => {
    if (await attempt(() => deps.start())) held = true;
  };

  /** True when the session is released (or nothing was held). */
  const stopNow = async (): Promise<boolean> => {
    if (!held) return true;
    if (!(await attempt(() => deps.stop()))) return false;
    held = false;
    return true;
  };

  const enqueue = (step: () => Promise<void>): Promise<void> => {
    tail = tail.then(step).then(noop, report);
    return tail;
  };

  return {
    callLive: () =>
      enqueue(async () => {
        live = true;
        if (!held) await startNow();
      }),
    callEnded: () =>
      enqueue(async () => {
        live = false;
        await stopNow();
      }),
    interruptionEnded: () =>
      enqueue(async () => {
        if (!live) return;
        if (!(await stopNow())) return;
        await startNow();
      }),
  };
}
