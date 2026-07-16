/**
 * On-device speech-to-text for live call captions on the Android app.
 *
 * The Android System WebView exposes `webkitSpeechRecognition` but cannot
 * actually run it (no speech backend), so `WebSpeechCaptionEngine` silently
 * fails there — captions could only be RECEIVED, never broadcast. This engine
 * bridges to the native `SpeechToText` Capacitor plugin (see
 * `SpeechToTextPlugin.kt`), which drives the platform `SpeechRecognizer`,
 * preferring the on-device recognizer. It implements the SAME `CaptionEngine`
 * contract as the web engine, so the caption controller and UI are unchanged.
 *
 * PRIVACY: with the on-device recognizer, mic audio and the transcript stay on
 * the phone — stronger than the web path (which streams audio to Google). Only
 * the caption text crosses the bridge, and it still rides the unencrypted
 * LiveKit data channel, so the E2EE gate in `CaptionPublisher` is unchanged.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import { Capacitor, registerPlugin } from "@capacitor/core";

import type { CaptionEngine, CaptionResult } from "./speechCaptionEngine";

/**
 * Whether native on-device caption STT can run in this shell: the Android app
 * (Capacitor native) with the `SpeechToText` plugin registered. `isPluginAvailable`
 * is a synchronous registry check, so `supported` stays a plain boolean like the
 * web engine. (Whether a speech model is actually installed for the chosen
 * language is only known at `start()` — the plugin emits `unsupported` then.)
 */
export function capacitorSpeechSupported(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "android" &&
    Capacitor.isPluginAvailable("SpeechToText")
  );
}

/** Native `SpeechToText` plugin surface (see android `SpeechToTextPlugin.kt`). */
interface SpeechToTextPlugin {
  /** Begin continuous recognition in `lang` (BCP-47). Idempotent. */
  start(options: { lang: string }): Promise<void>;
  /** Stop recognition and release the recognizer. */
  stop(): Promise<void>;
  /** Whether on-device recognition can run in this install. */
  available(): Promise<{ available: boolean }>;
  /** Interim transcript for the current utterance. */
  addListener(
    eventName: "partialResult",
    listenerFunc: (event: { text: string }) => void,
  ): Promise<PluginListenerHandle>;
  /** A finalized utterance. */
  addListener(
    eventName: "finalResult",
    listenerFunc: (event: { text: string }) => void,
  ): Promise<PluginListenerHandle>;
  /** A terminal error (`not-allowed` / `unsupported`). */
  addListener(
    eventName: "error",
    listenerFunc: (event: { error: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export class CapacitorSpeechCaptionEngine implements CaptionEngine {
  readonly supported = capacitorSpeechSupported();

  #plugin = registerPlugin<SpeechToTextPlugin>("SpeechToText");
  #active = false;
  #lang = "en-US";
  #onResult: ((result: CaptionResult) => void) | undefined;
  #handles: PluginListenerHandle[] = [];

  start(lang: string, onResult: (result: CaptionResult) => void) {
    if (!this.supported) return;
    this.#lang = lang || "en-US";
    this.#onResult = onResult;
    if (this.#active) {
      // Already running: re-target the language for the next utterance.
      void this.#plugin.start({ lang: this.#lang }).catch(() => undefined);
      return;
    }
    this.#active = true;
    void this.#spinUp();
  }

  async #spinUp() {
    try {
      const partial = await this.#plugin.addListener("partialResult", (e) =>
        this.#emit(e?.text, false),
      );
      const final = await this.#plugin.addListener("finalResult", (e) =>
        this.#emit(e?.text, true),
      );
      const error = await this.#plugin.addListener("error", () => {
        // A terminal native error (permissions / unsupported): stop trying so
        // we don't spin. Receiving remote captions is unaffected.
        this.stop();
      });
      // If stop() ran while listeners were being attached, unwind immediately.
      if (!this.#active) {
        void partial.remove();
        void final.remove();
        void error.remove();
        return;
      }
      this.#handles.push(partial, final, error);
      await this.#plugin.start({ lang: this.#lang });
    } catch {
      // Bridge/registration failure — treat as unsupported for this session.
      this.#active = false;
    }
  }

  #emit(text: string | undefined, isFinal: boolean) {
    if (!this.#active) return;
    const trimmed = (text ?? "").trim();
    if (trimmed) this.#onResult?.({ text: trimmed, isFinal });
  }

  stop() {
    if (!this.#active) return;
    this.#active = false;
    this.#onResult = undefined;
    const handles = this.#handles;
    this.#handles = [];
    for (const handle of handles) void handle.remove();
    void this.#plugin.stop().catch(() => undefined);
  }
}
