/**
 * YouTube provider (plan §4): the official embed in an `<iframe>`, driven
 * over raw postMessage (`youtubeWire.ts`). No third-party script enters
 * the document — `script-src 'self'` in every shell would block it anyway
 * — and the iframe is created ONCE and never detached (plan §2.1): a
 * detached iframe loses its browsing context and reloads on re-append.
 *
 * De-staling: `infoDelivery.currentTime` arrives every ~264 ms, so
 * `status().currentTimeMs` extrapolates `last + (now − receivedAt) × rate`
 * while the player reports PLAYING — otherwise the corrector's 250 ms dead
 * band would flap on report staleness alone.
 */
import type { Provider, ProviderCapabilities, ProviderStatus } from "./provider.ts";
import {
  commandMessage,
  listeningMessage,
  parseYouTubeMessage,
  providerStateFromYt,
  stuckStateTracker,
  trackStuckState,
  YOUTUBE_EMBED_ORIGIN,
  youtubeEmbedUrl,
  youtubeErrorText,
  type YouTubeCommand,
} from "./youtubeWire.ts";

let nextId = 1;

export interface YouTubeProviderOptions {
  videoId: string;
  /** Host gets the YouTube bar (it IS the control surface); viewers don't. */
  controls: boolean;
  /** Start playing on load (the session is playing); default true. */
  autoplay?: boolean;
  /** Start muted (autoplay fallback). */
  mute?: boolean;
  volume: number;
  muted: boolean;
  /** HOST ONLY (plan §7.3 4f): play as part of this playlist so the embed
   * auto-advances on `ended`. Host-local — never in the session. */
  listId?: string;
}

const CAPABILITIES: ProviderCapabilities = {
  // Probe 0(a): fractional setPlaybackRate is accepted and effective.
  rateNudge: true,
  // Seeks cost 22-30 ms with no rebuffer — cheap enough to prefer over a
  // 30 s nudge for anything past ~700 ms.
  hardSeekMs: 700,
};

export class YouTubeProvider implements Provider {
  readonly capabilities = CAPABILITIES;
  readonly element: HTMLIFrameElement;

  #id = `sloga-watch-${nextId++}`;
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
  /** Last reported position + when, for de-staling. */
  #lastReportMs: number | null = null;
  #lastReportAt = 0;
  /** Stuck-state repair (bug §7.2a A — see trackStuckState). */
  #stuck = stuckStateTracker();
  #ready = false;
  /** When `onReady` landed — the "Tap to start" idle-grace anchor. */
  #readyAt: number | null = null;
  /** Commands issued before `onReady` are replayed once it lands. */
  #queue: string[] = [];
  #onMessage = (e: MessageEvent) => {
    if (e.origin !== YOUTUBE_EMBED_ORIGIN) return;
    if (e.source !== this.element.contentWindow) return;
    const parsed = parseYouTubeMessage(e.data, this.#id);
    switch (parsed.kind) {
      case "ready": {
        this.#ready = true;
        if (this.#readyAt === null) this.#readyAt = Date.now();
        for (const msg of this.#queue) this.#post(msg);
        this.#queue = [];
        break;
      }
      case "error": {
        this.#update({ state: "error", error: youtubeErrorText(parsed.code) });
        break;
      }
      case "info": {
        // A missed `ready` must not park the idle-grace forever: the first
        // infoDelivery proves the player is up just as well.
        if (this.#readyAt === null) this.#readyAt = Date.now();
        const i = parsed.info;
        const patch: Partial<ProviderStatus> = {};
        if (i.currentTimeMs != null) {
          this.#lastReportMs = i.currentTimeMs;
          this.#lastReportAt = performance.now();
        }
        if (i.durationMs != null) patch.durationMs = i.durationMs;
        if (i.playbackRate != null) patch.ratePermille = Math.round(i.playbackRate * 1000);
        if (i.muted != null) patch.muted = i.muted;
        if (i.volume != null) patch.volume = i.volume;
        if (i.title != null) patch.title = i.title;
        if (i.videoId != null) patch.videoId = i.videoId;
        if (i.playerState != null) {
          const s = providerStateFromYt(i.playerState);
          if (s) patch.state = s;
        }
        // `playerState` rides infoDelivery only ON CHANGE, so a missed
        // transition leaves the merged state claiming unstarted/cued while
        // the clock advances — and the corrector then never acts (§7.2a A).
        {
          const claimed = patch.state ?? this.#status.state;
          const repaired = trackStuckState(this.#stuck, claimed, i.currentTimeMs);
          this.#stuck = repaired.tracker;
          if (repaired.state !== claimed) patch.state = repaired.state;
        }
        this.#update(patch);
        break;
      }
      default:
        break;
    }
  };

  constructor(opts: YouTubeProviderOptions) {
    const f = document.createElement("iframe");
    f.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.title = "YouTube player";
    f.style.cssText = "width:100%;height:100%;border:0;display:block;background:#000";
    f.src = youtubeEmbedUrl({
      videoId: opts.videoId,
      origin: location.origin,
      autoplay: opts.autoplay !== false,
      controls: opts.controls,
      mute: opts.mute || opts.muted,
      ...(opts.listId ? { listId: opts.listId } : {}),
    });
    f.addEventListener("load", () => {
      // Handshake: YouTube starts streaming infoDelivery for our id.
      this.#post(listeningMessage(this.#id));
    });
    this.element = f;
    this.#status.volume = opts.volume;
    this.#status.muted = opts.muted;
    window.addEventListener("message", this.#onMessage);
    // Initial volume/mute once the player is up (queued until ready).
    this.#cmd("setVolume", [opts.volume]);
    if (opts.muted || opts.mute) this.#cmd("mute");
  }

  status(): ProviderStatus {
    let currentTimeMs = this.#lastReportMs;
    if (currentTimeMs != null && this.#status.state === "playing") {
      const elapsed = performance.now() - this.#lastReportAt;
      currentTimeMs += (elapsed * this.#status.ratePermille) / 1000;
    }
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
    this.#cmd("playVideo");
  }
  pause() {
    this.#cmd("pauseVideo");
  }
  seek(ms: number) {
    this.#cmd("seekTo", [Math.max(0, ms) / 1000, true]);
    // The next infoDelivery will carry the landed time; until then report
    // the target so the corrector's post-seek hold sees progress.
    this.#lastReportMs = ms;
    this.#lastReportAt = performance.now();
  }
  setRate(permille: number) {
    this.#cmd("setPlaybackRate", [permille / 1000]);
  }
  setVolume(volume: number) {
    this.#cmd("setVolume", [Math.max(0, Math.min(100, Math.round(volume)))]);
  }
  setMuted(muted: boolean) {
    this.#cmd(muted ? "mute" : "unMute");
  }

  dispose() {
    window.removeEventListener("message", this.#onMessage);
    this.#listeners.clear();
    try {
      this.#post(commandMessage(this.#id, "stopVideo"));
    } catch {
      /* iframe may be gone */
    }
    this.element.remove();
  }

  #cmd(func: YouTubeCommand, args: unknown[] = []) {
    const msg = commandMessage(this.#id, func, args);
    if (!this.#ready) {
      this.#queue.push(msg);
      return;
    }
    this.#post(msg);
  }

  #post(msg: string) {
    this.element.contentWindow?.postMessage(msg, YOUTUBE_EMBED_ORIGIN);
  }

  #update(patch: Partial<ProviderStatus>) {
    const before = this.#status;
    const after = { ...before, ...patch };
    this.#status = after;
    const changed =
      before.state !== after.state ||
      before.error !== after.error ||
      before.title !== after.title ||
      before.videoId !== after.videoId ||
      before.durationMs !== after.durationMs ||
      before.muted !== after.muted ||
      before.volume !== after.volume ||
      before.ratePermille !== after.ratePermille;
    if (changed) for (const l of this.#listeners) l(this.status());
  }
}
