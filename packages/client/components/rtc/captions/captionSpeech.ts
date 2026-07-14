/**
 * On-device text-to-speech for spoken caption narration (captions phase 2).
 *
 * Speaks translated caption text aloud on the LISTENER's device via the
 * browser's SpeechSynthesis API. Unlike SpeechRecognition (the STT side), this
 * is on-device, free, AND broadly available — including Tauri WebView2 and
 * Android System WebView — so narration works on every shell the caption text
 * can reach. No audio ever leaves the device.
 *
 * The same pluggable-seam shape as the STT engine: `CaptionVoice` is the
 * contract, `WebSpeechCaptionVoice` the default; a cloud TTS (higher-quality
 * voices) can implement the same interface later.
 */

export interface CaptionVoice {
  /** Whether this synthesizer can run in the current environment. */
  readonly supported: boolean;
  /** Queue `text` to be spoken in `lang` (BCP-47 / Google Translate code). */
  speak(text: string, lang: string): void;
  /** Stop and drop anything queued/speaking. */
  cancel(): void;
}

/** Whether the browser SpeechSynthesis API is available in this shell. */
export function speechSynthesisSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

export class WebSpeechCaptionVoice implements CaptionVoice {
  readonly supported = speechSynthesisSupported();

  #rate: number;

  constructor(opts?: { rate?: number }) {
    this.#rate = opts?.rate ?? 1;
  }

  speak(text: string, lang: string) {
    if (!this.supported) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.lang = lang || "en";
    utterance.rate = this.#rate;
    const voice = this.#pickVoice(utterance.lang);
    if (voice) utterance.voice = voice;

    window.speechSynthesis.speak(utterance);
  }

  cancel() {
    if (this.supported) window.speechSynthesis.cancel();
  }

  /**
   * Best matching installed voice for `lang`; `undefined` lets the browser pick
   * its default for the utterance language. `getVoices()` can be empty until
   * voices finish loading async — that's fine, we just fall back to the default.
   */
  #pickVoice(lang: string): SpeechSynthesisVoice | undefined {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return undefined;
    const target = lang.toLowerCase();
    const primary = target.split("-")[0];
    return (
      voices.find((v) => v.lang.toLowerCase() === target) ??
      voices.find((v) => v.lang.toLowerCase().startsWith(primary))
    );
  }
}
