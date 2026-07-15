/**
 * On-device speech-to-text for live call captions.
 *
 * The engine is a thin, swappable seam: `CaptionEngine` is the contract the
 * caption controller talks to, and `WebSpeechCaptionEngine` is the default
 * zero-cost implementation backed by the browser's Web Speech API
 * (`SpeechRecognition`). A cloud recognizer (Deepgram / Whisper / …) can
 * implement the same contract later without touching the controller or UI.
 *
 * PRIVACY: the Web Speech API streams microphone audio to the browser vendor's
 * speech service (Google, in Chromium) for recognition. Callers must therefore
 * keep captions OFF on E2EE calls — see `LiveCaptions`.
 */

export interface CaptionResult {
  /** Best-effort transcript so far for the current utterance. */
  text: string;
  /** True once the recognizer has finalized this utterance. */
  isFinal: boolean;
}

export interface CaptionEngine {
  /** Whether this engine can run in the current environment. */
  readonly supported: boolean;
  /**
   * Start continuous recognition in `lang` (BCP-47, e.g. "en-US"). Interim and
   * final results are delivered to `onResult`. Re-targets the language if
   * already running.
   */
  start(lang: string, onResult: (result: CaptionResult) => void): void;
  /** Stop recognition and release the recognizer's microphone. */
  stop(): void;
}

// --- Minimal Web Speech typings (absent from lib.dom on some TS targets) ----

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * Whether *broadcasting* on-device Web Speech captions actually works in this
 * shell — in practice, real desktop Chrome/Edge only.
 *
 * The `SpeechRecognition` constructor being present is necessary but NOT
 * sufficient. The Tauri desktop WebView2 and the Android Capacitor System
 * WebView are both Chromium and expose the constructor, yet Chromium only ships
 * the Google speech backend (and its API key) in genuine browser builds — inside
 * an embedded webview `start()` yields no `onresult`, errors `network`, and the
 * engine's restart loop silently backs off to nothing. Gating on the
 * constructor alone therefore made the settings UI advertise caption
 * broadcasting those shells can't deliver (no "unsupported" note, a toggle that
 * produces silence). We additionally require that we are NOT inside a native
 * webview shell, reusing the same Tauri/Capacitor probe the OAuth flow uses.
 *
 * This gate is BROADCAST-only: receiving remote captions and narrating them via
 * SpeechSynthesis still work in every shell (see `captionSpeech.ts`).
 */
export function webSpeechSupported(): boolean {
  return getRecognitionCtor() !== undefined && !inNativeWebviewShell();
}

/**
 * True inside the Tauri (desktop) or Capacitor (Android) webview, where the Web
 * Speech recognition service is unreachable despite the constructor existing.
 * Mirrors `FlowLogin`'s embedded-webview check (Google likewise refuses OAuth
 * from these shells).
 */
function inNativeWebviewShell(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as {
    __TAURI__?: unknown;
    Capacitor?: { isNativePlatform?: () => boolean };
  };
  return !!(win.__TAURI__ || win.Capacitor?.isNativePlatform?.());
}

/**
 * Web Speech API recognizer. Continuous recognition drops out periodically
 * (vendor-imposed cap, and on sustained silence); while active we transparently
 * restart on `onend` so a single `start()` behaves like an always-on stream for
 * the duration of a call.
 */
export class WebSpeechCaptionEngine implements CaptionEngine {
  readonly supported = webSpeechSupported();

  #recognition: SpeechRecognitionLike | undefined;
  #active = false;
  #lang = "en-US";
  #onResult: ((result: CaptionResult) => void) | undefined;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive restarts that produced no result — drives restart backoff. */
  #failures = 0;

  start(lang: string, onResult: (result: CaptionResult) => void) {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    this.#lang = lang || "en-US";
    this.#onResult = onResult;
    if (this.#active) {
      // Already running: re-target the language for the next utterance/restart.
      if (this.#recognition) this.#recognition.lang = this.#lang;
      return;
    }
    this.#active = true;
    this.#failures = 0;
    this.#spinUp(Ctor);
  }

  #spinUp(Ctor: SpeechRecognitionCtor) {
    const rec = new Ctor();
    rec.lang = this.#lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      // Any recognition means the service is reachable — reset the backoff.
      this.#failures = 0;
      let interim = "";
      let sawFinal = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          const text = transcript.trim();
          if (text) this.#onResult?.({ text, isFinal: true });
          sawFinal = true;
        } else {
          interim += transcript;
        }
      }
      const text = interim.trim();
      if (text && !sawFinal) this.#onResult?.({ text, isFinal: false });
    };

    rec.onerror = (event) => {
      // "no-speech" / "aborted" are benign; `onend` restarts if still active.
      // A permission / service error is terminal — stop trying.
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {
        this.#active = false;
      }
    };

    rec.onend = () => {
      if (!this.#active) return;
      // Exponential backoff on a failing loop: a shell where the constructor
      // exists but the endpoint is unreachable (offline, or a WebView that
      // errors "network" instead of "not-allowed") would otherwise respawn
      // every 250 ms forever. `onresult` resets `#failures`, so a working
      // recognizer keeps the fast ~250 ms restart; a broken one decays to a
      // ~30 s poll that still self-heals when connectivity returns.
      this.#failures++;
      const delay = Math.min(250 * 2 ** (this.#failures - 1), 30000);
      clearTimeout(this.#restartTimer);
      this.#restartTimer = setTimeout(() => {
        if (this.#active) this.#spinUp(Ctor);
      }, delay);
    };

    this.#recognition = rec;
    try {
      rec.start();
    } catch {
      // start() throws if invoked while already started — safe to ignore.
    }
  }

  stop() {
    this.#active = false;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    const rec = this.#recognition;
    this.#recognition = undefined;
    this.#onResult = undefined;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        // ignore
      }
    }
  }
}
