/**
 * Selects the right on-device speech-to-text engine for the current shell and
 * exposes the shell's caption-BROADCAST capability to the controller + UI.
 *
 * Two engines implement the shared `CaptionEngine` contract:
 *  - `WebSpeechCaptionEngine` — real desktop Chrome/Edge (Web Speech API).
 *  - `CapacitorSpeechCaptionEngine` — the Android app (native `SpeechRecognizer`).
 *
 * The web engine's constructor exists inside the Tauri/Capacitor webviews but
 * cannot run there (see `webSpeechSupported`), which is why Android needs the
 * native engine. RECEIVING remote captions and narrating them via
 * SpeechSynthesis work on every shell regardless of the engine here.
 */

import {
  CapacitorSpeechCaptionEngine,
  capacitorSpeechSupported,
} from "./capacitorSpeechCaptionEngine";
import type { CaptionEngine } from "./speechCaptionEngine";
import {
  WebSpeechCaptionEngine,
  webSpeechSupported,
} from "./speechCaptionEngine";

/** Which STT engine (if any) can broadcast captions in this shell. */
export type CaptionSttEngineKind = "web" | "android" | "none";

export function captionSttEngineKind(): CaptionSttEngineKind {
  // Native first: on the Android app the web check is already false, but being
  // explicit keeps the precedence obvious if a future shell reports both.
  if (capacitorSpeechSupported()) return "android";
  if (webSpeechSupported()) return "web";
  return "none";
}

/**
 * Whether THIS shell can broadcast the local speaker's captions at all. Drives
 * the caption controller's start gate and the settings "not supported" notice.
 * Receiving/translating/narrating do not depend on this.
 */
export function captionBroadcastSupported(): boolean {
  return captionSttEngineKind() !== "none";
}

/** The engine for this shell; a no-broadcast shell still gets a (dormant) web engine. */
export function createCaptionEngine(): CaptionEngine {
  return capacitorSpeechSupported()
    ? new CapacitorSpeechCaptionEngine()
    : new WebSpeechCaptionEngine();
}
