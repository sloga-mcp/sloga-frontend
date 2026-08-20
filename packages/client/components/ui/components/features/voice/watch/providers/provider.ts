/**
 * Watch-together playback provider interface (plan §2). Each provider owns
 * ONE player element that lives inside the app-level player host and is
 * never detached (plan §2.1); the sync controller drives it through this
 * surface without knowing which provider it is.
 *
 * Positions are ms; rates are thousandths (1000 = 1.0×), matching the wire.
 */
import type { ProviderCapabilities, ProviderState } from "../syncController.ts";

export type { ProviderCapabilities, ProviderState };

export interface ProviderStatus {
  state: ProviderState;
  /** De-staled position: `lastReported + (now − receivedAt) × effectiveRate`
   * while playing. Null until the player has reported once. */
  currentTimeMs: number | null;
  /** Duration in ms, when known. */
  durationMs: number | null;
  ratePermille: number;
  /** Provider-specific human-readable error, if `state === "error"`. */
  error: string | null;
  /** Title the provider learned (YouTube `videoData.title`). */
  title: string | null;
  /** The id the player is ACTUALLY playing, when the provider knows it
   * (YouTube `videoData.video_id`) — how a host's playlist auto-advance is
   * observed (plan §7.3 4f). Null elsewhere. */
  videoId: string | null;
  muted: boolean;
  /** 0..100 */
  volume: number;
}

export interface Provider {
  readonly capabilities: ProviderCapabilities;
  /** The element to place into the player host. Created once per provider. */
  readonly element: HTMLElement;
  /** Current status snapshot (cheap; called every tick). */
  status(): ProviderStatus;
  /** Subscribe to status changes (state / title / error / duration) — NOT
   * every position tick. Returns an unsubscribe. */
  onChange(listener: (status: ProviderStatus) => void): () => void;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  setRate(permille: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
  /**
   * True while the provider is rebuffering because WE just seeked, capped in
   * time. The viewer sync loop suppresses position correction while this is
   * set, so a transcode restart (an HLS seek past the transcoder head costs
   * ~4-5 s — plan §7.1) is not read as fresh drift and re-seeked forever.
   * Absent/false on providers whose seeks are cheap (YouTube).
   */
  postSeekHold?(): boolean;
  /**
   * `Date.now()` of the moment the underlying player first became able to
   * accept commands (YouTube `onReady`, `<video>` first `loadedmetadata`),
   * or null while it is still booting. The "Tap to start" rule measures its
   * grace for the `idle` state from this, so a slow embed boot doesn't
   * flash the prompt (plan §7.2b item 7). Absent = treat as ready.
   */
  readyAtMs?(): number | null;
}
