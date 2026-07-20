import { ReactiveMap } from "@solid-primitives/map";
import type { Room } from "livekit-client";

import { createCaptionEngine } from "./captionEngine";
import type { CaptionEngine, CaptionResult } from "./speechCaptionEngine";

/** A caption currently displayed for one call participant. */
export interface CaptionEntry {
  /** Recognized text in the speaker's own language. */
  text: string;
  /** True once the utterance is finalized (interim results update in place). */
  isFinal: boolean;
  /** BCP-47 language the speaker was recognized in (for translation). */
  sourceLang: string;
}

/** LiveKit data-channel topic caption packets travel on. */
const CAPTION_TOPIC = "captions";
/** Wire format version — receivers ignore packets they don't understand. */
const WIRE_VERSION = 1;
/** Clear a finalized caption this long after its last update. */
const FINAL_LINGER_MS = 6000;
/** Clear a stalled interim caption if no further update arrives. */
const INTERIM_TIMEOUT_MS = 8000;
/**
 * Hard cap on caption length (outgoing and ingested). Bounds a hostile/oversized
 * remote packet from overflowing the tile, and keeps text under the
 * translate-endpoint limit. Utterances longer than this are simply truncated.
 */
const MAX_CAPTION_CHARS = 240;

interface WireCaption {
  v: number;
  t: string;
  f: boolean;
  l: string;
}

/**
 * Live call captions: runs the local speech recognizer, broadcasts the
 * speaker's transcript over a LiveKit data channel, and ingests remote
 * participants' transcripts into a reactive per-identity map the UI renders
 * (translating on the receiving end via the existing message-translation path).
 *
 * PRIVACY: recognition sends mic audio to the browser's speech vendor and the
 * transcript travels over an UNENCRYPTED data channel (LiveKit E2EE covers
 * media frames, not data packets). The controller therefore never publishes on
 * an E2EE call — the caller gates `setLocalPublishing` on call mode.
 */
export class LiveCaptions {
  /** identity -> latest caption; reactive so participant tiles re-render. */
  readonly entries = new ReactiveMap<string, CaptionEntry>();

  #room: Room | undefined;
  #engine: CaptionEngine | undefined;
  #localIdentity = "";
  #localLang = "en-US";
  #publishing = false;
  #dataHandler: ((payload: Uint8Array, ...rest: unknown[]) => void) | undefined;
  #clearTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #encoder = new TextEncoder();
  #decoder = new TextDecoder();

  /** This device's LiveKit identity — lets the narrator skip my own captions. */
  get localIdentity(): string {
    return this.#localIdentity;
  }

  #clampText(text: string): string {
    return text.length > MAX_CAPTION_CHARS
      ? text.slice(0, MAX_CAPTION_CHARS)
      : text;
  }

  /**
   * Bind to a connected Room and begin ingesting remote captions. Local
   * broadcasting stays off until `setLocalPublishing(true, …)`.
   */
  attach(room: Room, localIdentity: string) {
    this.detach();
    this.#room = room;
    this.#localIdentity = localIdentity;
    this.#dataHandler = (
      payload: Uint8Array,
      participant?: unknown,
      _kind?: unknown,
      topic?: unknown,
    ) => {
      if (topic !== CAPTION_TOPIC) return;
      const identity = (participant as { identity?: string } | undefined)
        ?.identity;
      if (!identity) return;
      this.#ingest(identity, payload);
    };
    room.on("dataReceived", this.#dataHandler as never);
  }

  /** Unbind and clear all caption state. Safe to call repeatedly. */
  detach() {
    this.stopLocal();
    if (this.#room && this.#dataHandler) {
      this.#room.off("dataReceived", this.#dataHandler as never);
    }
    for (const timer of this.#clearTimers.values()) clearTimeout(timer);
    this.#clearTimers.clear();
    this.entries.clear();
    this.#room = undefined;
    this.#dataHandler = undefined;
  }

  /**
   * Enable/disable broadcasting the local speaker's captions. `lang` is the
   * speaker's spoken language (BCP-47). No-op if the engine is unsupported.
   */
  setLocalPublishing(enabled: boolean, lang: string) {
    this.#localLang = lang || "en-US";
    if (enabled) this.#startLocal();
    else this.stopLocal();
  }

  #startLocal() {
    const engine = (this.#engine ??= createCaptionEngine());
    if (!engine.supported) return;
    // start() re-targets the language if already running.
    engine.start(this.#localLang, (result) => this.#onLocalResult(result));
    this.#publishing = true;
  }

  stopLocal() {
    if (!this.#publishing) return;
    this.#publishing = false;
    this.#engine?.stop();
    this.#clearEntry(this.#localIdentity);
  }

  #onLocalResult(result: CaptionResult) {
    const text = this.#clampText(result.text);
    // Mirror my own caption locally so I can see what's being broadcast.
    this.#apply(this.#localIdentity, {
      text,
      isFinal: result.isFinal,
      sourceLang: this.#localLang,
    });
    const room = this.#room;
    if (!room) return;
    const wire: WireCaption = {
      v: WIRE_VERSION,
      t: text,
      f: result.isFinal,
      l: this.#localLang,
    };
    try {
      // Interim packets are lossy (superseded by the next); finals are reliable
      // so a completed utterance always lands.
      void Promise.resolve(
        room.localParticipant.publishData(
          this.#encoder.encode(JSON.stringify(wire)),
          { reliable: result.isFinal, topic: CAPTION_TOPIC },
        ),
      ).catch(() => {
        // Best-effort: a dropped interim is corrected by the next result.
      });
    } catch {
      // publishData can throw synchronously before the channel is ready.
    }
  }

  #ingest(identity: string, payload: Uint8Array) {
    let wire: WireCaption;
    try {
      wire = JSON.parse(this.#decoder.decode(payload)) as WireCaption;
    } catch {
      return;
    }
    if (wire?.v !== WIRE_VERSION || typeof wire.t !== "string") return;
    this.#apply(identity, {
      text: wire.t,
      isFinal: !!wire.f,
      sourceLang: typeof wire.l === "string" ? wire.l : "und",
    });
  }

  #apply(identity: string, entry: CaptionEntry) {
    const text = this.#clampText(entry.text);
    if (!text.trim()) {
      this.#clearEntry(identity);
      return;
    }
    this.entries.set(identity, { ...entry, text });
    const prev = this.#clearTimers.get(identity);
    if (prev) clearTimeout(prev);
    this.#clearTimers.set(
      identity,
      setTimeout(
        () => this.#clearEntry(identity),
        entry.isFinal ? FINAL_LINGER_MS : INTERIM_TIMEOUT_MS,
      ),
    );
  }

  #clearEntry(identity: string) {
    const timer = this.#clearTimers.get(identity);
    if (timer) {
      clearTimeout(timer);
      this.#clearTimers.delete(identity);
    }
    this.entries.delete(identity);
  }
}
