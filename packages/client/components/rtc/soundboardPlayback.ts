import { CONFIGURATION } from "@revolt/common";

/**
 * Live inputs the playback reads on every trigger. Passed by the Voice store
 * so the class owns no reactive state of its own.
 */
export interface SoundboardContext {
  /** True iff this client is currently in the call for `channelId`. */
  isActiveChannel: (channelId: string) => boolean;
  /** Whether the local user is deafened (soundboard is part of the call mix). */
  deafened: () => boolean;
  /** Call output volume (unclamped / boost-capable, like the call audio). */
  outputVolume: () => number;
  /** The user's chosen output device (undefined → default device). */
  outputDeviceId: () => string | undefined;
}

/** Cap simultaneous playbacks so a burst of triggers can't wall-of-noise. */
const MAX_CONCURRENT = 4;
/** Bounded decoded-clip cache (LRU-ish by insertion order). */
const CACHE_LIMIT = 32;

/**
 * Client-local soundboard playback. A received `SoundboardSound` trigger for
 * the call we're in is fetched from Autumn, decoded once, and played through
 * Web Audio into the SAME output device the call audio is on — mixed into the
 * call, honouring deafen and output volume.
 *
 * The clip NEVER touches the LiveKit/SFU media path or the call's MLS E2EE:
 * soundboard sounds are public per-server assets. Device routing uses a
 * dedicated graph per sound (decodedBuffer → GainNode → MediaStreamDestination
 * → short-lived HTMLAudioElement.setSinkId) rather than AudioContext.setSinkId,
 * so it works on browsers/WebViews that lack the newer context-level API and
 * never moves the app's UI chimes onto the call device (plan BLOCKER-1). Where
 * `setSinkId` is unavailable (e.g. Android WebView 109) it falls back to the
 * default device — which is where the call audio lands there anyway.
 */
export class SoundboardPlayback {
  #ctx?: AudioContext;
  #buffers = new Map<string, AudioBuffer>();
  #pending = new Map<string, Promise<AudioBuffer>>();
  #active = new Set<HTMLAudioElement>();

  constructor(private readonly context: SoundboardContext) {
    // Unlock the AudioContext on the first user gesture so a RECEIVED sound
    // (which arrives without a local gesture) is not autoplay-blocked. Same
    // pattern as the app SoundController; joining a call is itself a gesture,
    // so the context is running well before any trigger lands.
    const unlock = () => {
      this.#getCtx();
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("click", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  #getCtx(): AudioContext {
    if (!this.#ctx || this.#ctx.state === "closed") {
      this.#ctx = new AudioContext();
    }
    if (this.#ctx.state === "suspended") {
      void this.#ctx.resume();
    }
    return this.#ctx;
  }

  async #loadBuffer(soundId: string): Promise<AudioBuffer> {
    const cached = this.#buffers.get(soundId);
    if (cached) return cached;

    const inflight = this.#pending.get(soundId);
    if (inflight) return inflight;

    const load = (async () => {
      const res = await fetch(
        `${CONFIGURATION.DEFAULT_MEDIA_URL}/soundboard/${soundId}`,
      );
      if (!res.ok) throw new Error(`sound fetch ${res.status}`);
      const bytes = await res.arrayBuffer();
      const buffer = await this.#getCtx().decodeAudioData(bytes);

      if (this.#buffers.size >= CACHE_LIMIT) {
        const oldest = this.#buffers.keys().next().value;
        if (oldest) this.#buffers.delete(oldest);
      }
      this.#buffers.set(soundId, buffer);
      return buffer;
    })();

    this.#pending.set(soundId, load);
    try {
      return await load;
    } finally {
      this.#pending.delete(soundId);
    }
  }

  /**
   * Handle a received soundboard trigger. Plays only if we are in the call
   * for `channelId` and not deafened (all scoping lives here — the store
   * subscribes app-lifetime, so this survives leave/rejoin).
   */
  handleTrigger(detail: { channelId: string; soundId: string }): void {
    if (!this.context.isActiveChannel(detail.channelId)) return;
    if (this.context.deafened()) return;
    if (this.#active.size >= MAX_CONCURRENT) return;
    void this.#play(detail.soundId);
  }

  async #play(soundId: string): Promise<void> {
    let buffer: AudioBuffer;
    try {
      buffer = await this.#loadBuffer(soundId);
    } catch {
      return;
    }
    // Re-check after the await: deafen/cap/channel may have changed.
    if (this.context.deafened()) return;
    if (this.#active.size >= MAX_CONCURRENT) return;

    const ctx = this.#getCtx();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = this.context.outputVolume();
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(dest);

    const el = new Audio();
    el.srcObject = dest.stream;
    this.#applySink(el);
    this.#active.add(el);

    const done = () => {
      this.#active.delete(el);
      try {
        source.disconnect();
        gain.disconnect();
        dest.disconnect();
      } catch {
        /* already torn down */
      }
      el.srcObject = null;
    };
    source.onended = done;
    void el.play().catch(done);
    source.start();
  }

  #applySink(el: HTMLAudioElement): void {
    const deviceId = this.context.outputDeviceId();
    if (deviceId && "setSinkId" in el) {
      // setSinkId is not in older lib.dom typings; best-effort.
      (el as unknown as { setSinkId(id: string): Promise<void> })
        .setSinkId(deviceId)
        .catch(() => {
          /* unsupported / device gone → stays on default */
        });
    }
  }

  /** Re-point in-flight playbacks at a newly-selected output device. Future
   *  playbacks pick it up automatically (device is read per play). */
  refreshOutputDevice(): void {
    for (const el of this.#active) {
      this.#applySink(el);
    }
  }
}
