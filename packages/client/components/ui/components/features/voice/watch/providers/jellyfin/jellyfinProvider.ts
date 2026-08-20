/**
 * Jellyfin provider (plan §5): a `<video>` fed by hls.js from the item's
 * transcoding stream, driven through the same `Provider` surface the sync
 * controller uses for YouTube. Created ONCE per session and never detached
 * (a detached `<video>` is paused by the HTML spec).
 *
 * The media is fetched by THIS viewer from THEIR Jellyfin (through the
 * shell's transport) — no Sloga server is on the path.
 *
 * Two facts from §7.1 shape this:
 * - a seek PAST the transcoder's head restarts ffmpeg (~4-5 s), during
 *   which the element sits in `buffering`; the corrector must not read that
 *   as a new drift and seek again. So `hardSeekMs` is 1500 (as planned) AND
 *   the provider reports `buffering` (a "no opinion" state) through the
 *   whole rebuffer, and OVERSHOOTS each seek by its learned cost so it lands
 *   on the line rather than behind it.
 * - playstate reporting is mandatory or the server keeps transcoding for a
 *   departed viewer — the store owns that (it has the timers); the provider
 *   exposes the raw currentTime and a stop hook.
 */
// hls.js is TYPE-only at the module top so it never lands in the main
// bundle: it is ~600 KB and only ever needed once a Jellyfin session
// actually plays. `loadHls()` dynamic-imports it into its own chunk; the
// provider is constructed with the resolved constructor (see the store's
// `#startJellyfin`), keeping the flag-dark path weightless.
import type HlsType from "hls.js";
import type { ErrorData } from "hls.js";

import type { Provider, ProviderCapabilities, ProviderStatus } from "../provider";

/** The hls.js class type (static members + constructor). */
type HlsCtor = typeof HlsType;

/** Lazy-load hls.js as its own chunk. */
export async function loadHls(): Promise<HlsCtor> {
  const mod = await import("hls.js");
  return mod.default;
}

export interface JellyfinProviderOptions {
  /** The hls.js constructor, resolved via `loadHls()` before construction. */
  Hls: HlsCtor;
  /** Fetchable master.m3u8 URL (already through the shell transport). */
  hlsUrl: string;
  /** Known runtime in ms (from the item), for the duration bar before load. */
  runtimeMs: number;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  /** Called when the element enters `error` with a fatal hls.js failure. */
  onFatal?: (detail: string) => void;
}

/** Cap on the post-seek hold: past this a stuck seek stops blocking the
 * corrector so it can re-converge (a wedged transcode shouldn't freeze sync
 * forever). Comfortably above the ~5 s worst-case rebuffer measured in §7.1. */
const POST_SEEK_HOLD_CAP_MS = 8000;

const CAPABILITIES: ProviderCapabilities = {
  // Fractional playbackRate on a <video> is effective (probe §7.1).
  rateNudge: true,
  // An HLS seek can rebuffer (up to ~5 s past the transcoder head); prefer
  // a nudge for anything under this, hard-seek only past it.
  hardSeekMs: 1500,
};

export class JellyfinProvider implements Provider {
  readonly capabilities = CAPABILITIES;
  readonly element: HTMLVideoElement;

  #hls: HlsType | null = null;
  #listeners = new Set<(s: ProviderStatus) => void>();
  #status: ProviderStatus = {
    state: "idle",
    currentTimeMs: null,
    durationMs: null,
    ratePermille: 1000,
    error: null,
    title: null,
    videoId: null,
    muted: false,
    volume: 100,
  };
  /** Whether OUR seek is in flight — the corrector's post-seek hold pairs
   * with this so a transcode rebuffer isn't read as fresh drift. */
  #seeking = false;
  /** Learned seek cost (ms of wall time from seek issue to playing again),
   * EMA — used to overshoot the next seek so it lands on the line. */
  #seekCostMs = 0;
  #seekStartedAt = 0;
  /** First `loadedmetadata` — the "Tap to start" idle-grace anchor. */
  #readyAt: number | null = null;
  #onFatal?: (detail: string) => void;

  constructor(opts: JellyfinProviderOptions) {
    const Hls = opts.Hls;
    const Events = Hls.Events;
    this.#onFatal = opts.onFatal;
    const v = document.createElement("video");
    v.playsInline = true;
    v.controls = false;
    v.autoplay = opts.autoplay;
    v.volume = clampVol(opts.volume) / 100;
    v.muted = opts.muted;
    v.style.cssText = "width:100%;height:100%;display:block;background:#000;object-fit:contain";
    this.element = v;
    this.#status.volume = clampVol(opts.volume);
    this.#status.muted = opts.muted;
    this.#status.durationMs = opts.runtimeMs > 0 ? opts.runtimeMs : null;

    v.addEventListener("loadedmetadata", () => {
      if (this.#readyAt === null) this.#readyAt = Date.now();
      if (Number.isFinite(v.duration) && v.duration > 0) {
        this.#update({ durationMs: Math.round(v.duration * 1000) });
      }
    });
    // A rejected autoplay play() leaves the element paused with no further
    // events — without these two the state parks in `buffering` (readyState
    // was < 3 at the last recompute), which the corrector treats as "still
    // trying" and "Tap to start" never fires (§7.2b item 8). Once buffered,
    // recompute lands on `paused` and both surfaces work.
    v.addEventListener("loadeddata", () => this.#recompute());
    v.addEventListener("canplay", () => this.#recompute());
    v.addEventListener("play", () => this.#recompute());
    v.addEventListener("playing", () => {
      if (this.#seeking) {
        this.#seeking = false;
        const cost = performance.now() - this.#seekStartedAt;
        // EMA, clamped so a first huge cost doesn't pin overshoot forever.
        this.#seekCostMs = this.#seekCostMs === 0 ? cost : this.#seekCostMs * 0.6 + cost * 0.4;
        this.#seekCostMs = Math.min(this.#seekCostMs, 6000);
      }
      this.#recompute();
    });
    v.addEventListener("pause", () => this.#recompute());
    v.addEventListener("waiting", () => this.#recompute());
    v.addEventListener("seeking", () => this.#recompute());
    v.addEventListener("seeked", () => this.#recompute());
    v.addEventListener("ended", () => this.#update({ state: "ended" }));
    v.addEventListener("ratechange", () =>
      this.#update({ ratePermille: Math.round(v.playbackRate * 1000) }),
    );
    v.addEventListener("volumechange", () =>
      this.#update({ volume: Math.round(v.volume * 100), muted: v.muted }),
    );
    v.addEventListener("error", () => {
      const detail = v.error ? `media error ${v.error.code}` : "media error";
      this.#update({ state: "error", error: detail });
      this.#onFatal?.(detail);
    });

    if (Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: false, backBufferLength: 30, maxBufferLength: 30 });
      this.#hls = hls;
      hls.on(Events.ERROR, (_e, data: ErrorData) => {
        // Non-fatal noise (bufferSeekOverHole, bufferAppendNoProgress,
        // aborted loads on seek) is expected under a live transcode — §7.1;
        // only fatal errors surface.
        if (!data.fatal) return;
        const detail = `${data.type}: ${data.details}`;
        this.#update({ state: "error", error: detail });
        this.#onFatal?.(detail);
      });
      hls.loadSource(opts.hlsUrl);
      hls.attachMedia(v);
    } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari/native fallback (no TranscodeReasons/segment control, but it
      // plays). WebView2 prefers hls.js; this is a safety net.
      v.src = opts.hlsUrl;
    } else {
      this.#update({ state: "error", error: "HLS unsupported in this build" });
      this.#onFatal?.("HLS unsupported");
    }

    if (opts.autoplay) void v.play().catch(() => this.#recompute());
  }

  status(): ProviderStatus {
    const v = this.element;
    const currentTimeMs = Number.isFinite(v.currentTime) ? Math.round(v.currentTime * 1000) : this.#status.currentTimeMs;
    return { ...this.#status, currentTimeMs };
  }

  onChange(listener: (s: ProviderStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  readyAtMs(): number | null {
    return this.#readyAt;
  }

  play() {
    void this.element.play().catch(() => this.#recompute());
  }
  pause() {
    this.element.pause();
  }
  seek(ms: number) {
    const target = Math.max(0, ms) / 1000;
    // Overshoot by the learned seek cost while playing so the ffmpeg
    // restart lands us on the expected line instead of behind it (§7.1).
    const overshoot = this.#status.state === "playing" ? this.#seekCostMs / 1000 : 0;
    this.#seeking = true;
    this.#seekStartedAt = performance.now();
    const dur = Number.isFinite(this.element.duration) ? this.element.duration : Infinity;
    this.element.currentTime = Math.min(target + overshoot, dur - 0.5 || target + overshoot);
  }
  setRate(permille: number) {
    this.element.playbackRate = permille / 1000;
  }
  setVolume(volume: number) {
    this.element.volume = clampVol(volume) / 100;
  }
  setMuted(muted: boolean) {
    this.element.muted = muted;
  }

  /** True while OUR seek is rebuffering — the store pairs this with the
   * corrector's post-seek hold so a transcode restart isn't re-seeked. */
  isSeeking(): boolean {
    return this.#seeking;
  }

  /** Provider-interface hold: true while OUR seek rebuffers, capped so a
   * genuinely stuck seek eventually lets the corrector re-converge. */
  postSeekHold(): boolean {
    return this.#seeking && performance.now() - this.#seekStartedAt < POST_SEEK_HOLD_CAP_MS;
  }

  dispose() {
    this.#listeners.clear();
    try {
      this.element.pause();
      this.element.removeAttribute("src");
      this.#hls?.destroy();
    } catch {
      /* already gone */
    }
    this.#hls = null;
    this.element.remove();
  }

  #recompute() {
    const v = this.element;
    let state: ProviderStatus["state"];
    if (this.#status.state === "error") state = "error";
    else if (v.ended) state = "ended";
    else if (this.#seeking || v.seeking || v.readyState < 3) state = "buffering";
    else if (v.paused) state = "paused";
    else state = "playing";
    this.#update({ state });
  }

  #update(patch: Partial<ProviderStatus>) {
    const before = this.#status;
    const after = { ...before, ...patch };
    this.#status = after;
    const changed =
      before.state !== after.state ||
      before.error !== after.error ||
      before.durationMs !== after.durationMs ||
      before.muted !== after.muted ||
      before.volume !== after.volume ||
      before.ratePermille !== after.ratePermille;
    if (changed) for (const l of this.#listeners) l(this.status());
  }
}

function clampVol(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}
