/**
 * Visibility / eligibility policy for watch-together (plan §2). Pure — no
 * Solid, no DOM — so it runs under `node --test` without the
 * `--conditions=browser` dance the reactive files need:
 *   node --test components/ui/components/features/voice/watch/watchPolicy.test.ts
 *
 * The actions-bar button, the overlay and the player host all sit behind
 * these two functions, so the ENABLE_WATCH_TOGETHER flag passed in here is
 * the single point that darkens the lot (the minigamePolicy shape).
 */

/** Everything the overlay-visibility rule reads, already unwrapped from signals. */
export interface WatchOverlayInputs {
  /** `CONFIGURATION.ENABLE_WATCH_TOGETHER` — build-time gate, default off. */
  enabled: boolean;
  /** `voice.state() === "CONNECTED"`. */
  connected: boolean;
  /** A session exists for THE CALL WE ARE IN (not some other device's call). */
  hasSession: boolean;
  /** Theater mode hides all chrome; the overlay is chrome. The player host
   * (audio) is NOT hidden by this — only our overlay is. */
  immersive: boolean;
}

/** The overlay (our chrome over the participant area) exists iff all hold. */
export function watchOverlayVisible(i: WatchOverlayInputs): boolean {
  return i.enabled && i.connected && i.hasSession && !i.immersive;
}

/** Everything the "Watch together" button rule reads. */
export interface WatchStartInputs {
  enabled: boolean;
  connected: boolean;
  /**
   * `channel.havePermission("UseWatchTogether")` for server channels; DMs
   * and group DMs pass `true` (the server does not consult the bit there —
   * remote-control table rule).
   */
  hasPermission: boolean;
  /** A session already exists → the button becomes "open the overlay", not start. */
  hasSession: boolean;
}

/** Whether the actions-bar button is shown at all. */
export function watchButtonVisible(i: WatchStartInputs): boolean {
  return i.enabled && i.connected && (i.hasPermission || i.hasSession);
}

/** Whether pressing it may START a session (vs. just revealing one). */
export function watchCanStart(i: WatchStartInputs): boolean {
  return i.enabled && i.connected && i.hasPermission && !i.hasSession;
}

/**
 * Host-unreachable rule (plan §1): the session TTL expiring fans no event,
 * so a viewer that has seen no update for this long while the session says
 * `playing` shows a banner and re-fetches; a 404 then clears it.
 */
export const HOST_UNREACHABLE_AFTER_MS = 60_000;

export function hostUnreachable(i: {
  playing: boolean;
  lastUpdateLocalMs: number | null;
  nowLocalMs: number;
}): boolean {
  if (!i.playing || i.lastUpdateLocalMs == null) return false;
  return i.nowLocalMs - i.lastUpdateLocalMs > HOST_UNREACHABLE_AFTER_MS;
}

/**
 * Autoplay-blocked rule (plan §2.1 "Tap to start"): we asked the provider
 * to play and, past a grace window, it still reports a state that means
 * "not even trying". `idle` belongs in that set (§7.2a bug B): a
 * late-joining viewer whose embed never emitted a playerState at all sits
 * there — without it they stare at a frozen player with no affordance.
 * `buffering` stays out (still trying), `playing` obviously, and `error`
 * has its own surface. `ended` means it played; not a block.
 *
 * The `idle` grace is anchored on the provider's ready moment when it
 * reports one (§7.2b item 7): a slow (>3 s) iframe boot sits in `idle`
 * through no fault of autoplay, and flashing the prompt there is noise.
 * A never-ready player still prompts, just after the longer boot grace —
 * tapping replays the queued play() once the player does come up, and a
 * player that never comes up at all ends in `error`, not here.
 */
/**
 * Environment-pause rule (plan §7.2c finding 1): Chrome pauses a MUTED
 * video in a hidden/unfocused tab. On the host that pause used to be
 * written as host truth — a muted host switching tabs paused the movie for
 * the whole call. A pause that arrives while the document is hidden cannot
 * be host intent (a hidden tab cannot be clicked), so it is classified as
 * the browser suspending the player: the session keeps playing, heartbeats
 * extrapolate the position, and the host rejoins the session timeline when
 * the tab is shown again.
 *
 * Accepted miss: a hardware media-key pause routed to a hidden tab would
 * also be classified environmental. Media keys route to audible tabs and
 * this pause only fires on muted playback, so the overlap is negligible —
 * and the old behavior (every tab switch pauses everyone) was worse.
 */
export function pauseIsEnvironmental(i: {
  isHost: boolean;
  providerState: string;
  documentHidden: boolean;
  /** The SESSION is playing (a pause agreeing with a paused session is moot). */
  sessionPlaying: boolean;
}): boolean {
  return i.isHost && i.sessionPlaying && i.providerState === "paused" && i.documentHidden;
}

/**
 * Handoff detection (§7.3 4a): the SAME session arriving under a new host.
 * A different session id is a new session — the provider rebuild resets
 * everything anyway — and the very first update (no previous session) is
 * never a transition. The store resets its host-only residue (nudge rate,
 * host opinion, scrub tracker, write queue, tap state, suspension latch)
 * exactly when this returns true.
 */
export function isHostTransition(i: {
  prevId: string | undefined;
  prevHostId: string | undefined;
  nextId: string;
  nextHostId: string;
}): boolean {
  return (
    i.prevId !== undefined &&
    i.prevId === i.nextId &&
    i.prevHostId !== undefined &&
    i.prevHostId !== i.nextHostId
  );
}

/** A suspended host rejoins the session timeline only once its tab is
 * shown again — issuing play() while still hidden just fights the browser. */
export function shouldResumeSuspendedHost(i: {
  suspended: boolean;
  documentHidden: boolean;
  sessionPlaying: boolean;
}): boolean {
  return i.suspended && i.sessionPlaying && !i.documentHidden;
}

/**
 * Host write governor (§7.2c open observation: a paused-idle-hidden host
 * wrote ~1/1.25 s against a 5 s heartbeat design). Whatever provider
 * pathology drives such a loop — a flapping state transition re-asserting
 * what the session already says, a jittering clock re-triggering the
 * paused-scrub path — every one of them composes a PATCH that tells the
 * server nothing it doesn't already know. So the rule sits on the write
 * itself: a KEYED write (a transition, a scrub, a rate change) whose body
 * is a no-op against the session's own timeline is not sent. Heartbeats
 * (an empty override) always go — they carry the TTL refresh and the
 * host-liveness signal — and a `media` change always goes (it is never
 * derivable from the timeline). This bounds the steady-state write rate to
 * the heartbeat by construction, independent of what the embed does.
 */
export const HOST_WRITE_NOOP_POSITION_MS = 1000;

export function hostWriteIsNoop(i: {
  /** An empty override (the 5 s heartbeat) — always sent. */
  isHeartbeat: boolean;
  /** The write carries a media swap / learned title — always sent. */
  hasMedia: boolean;
  /** The composed body. */
  playing: boolean;
  positionMs: number;
  ratePermille: number;
  /** The session as we know it. */
  sessionPlaying: boolean;
  sessionRatePermille: number;
  /** Where the session timeline is right now (`expectedPosition(session, serverNow)`). */
  sessionExpectedMs: number;
}): boolean {
  if (i.isHeartbeat || i.hasMedia) return false;
  if (i.playing !== i.sessionPlaying) return false;
  if (i.ratePermille !== i.sessionRatePermille) return false;
  return Math.abs(i.positionMs - i.sessionExpectedMs) <= HOST_WRITE_NOOP_POSITION_MS;
}

/**
 * Paused-scrub stability gate (same observation, the trigger side): the
 * host tick writes a position while paused so viewers' timelines follow a
 * scrub of the embed's own bar. A REAL scrub is a jump that then holds
 * still; a clock that keeps moving (or oscillates) while the state claims
 * `paused` is a provider contradiction, not a scrub — writing it would
 * chase the pathology one PATCH per tick, and the heartbeat carries the
 * position anyway. So the candidate position must be >1 s away from the
 * session's AND stable across two consecutive ticks (same reading ± report
 * jitter) before it is written.
 */
export interface PausedScrubTracker {
  lastReadMs: number | null;
}

export const pausedScrubTracker = (): PausedScrubTracker => ({ lastReadMs: null });

export const PAUSED_SCRUB_MIN_DELTA_MS = 1000;
export const PAUSED_SCRUB_JITTER_MS = 100;

export function pausedScrubWrite(
  t: PausedScrubTracker,
  currentTimeMs: number | null,
  sessionPositionMs: number,
): { tracker: PausedScrubTracker; write: boolean } {
  if (currentTimeMs == null) return { tracker: { lastReadMs: null }, write: false };
  const moved = Math.abs(currentTimeMs - sessionPositionMs) > PAUSED_SCRUB_MIN_DELTA_MS;
  const stable =
    t.lastReadMs != null && Math.abs(currentTimeMs - t.lastReadMs) <= PAUSED_SCRUB_JITTER_MS;
  return { tracker: { lastReadMs: currentTimeMs }, write: moved && stable };
}

export const AUTOPLAY_GRACE_MS = 3000;
export const IDLE_BOOT_GRACE_MS = 12_000;

export function needsTapToStart(i: {
  /** The SESSION says playing (the host's truth, not our player's). */
  sessionPlaying: boolean;
  /** When we last issued play() ourselves; null = we never asked. */
  playAskedAtMs: number | null;
  nowLocalMs: number;
  providerState: string;
  /**
   * When the provider became ready (`Provider.readyAtMs()`): a number once
   * ready, null while booting, undefined for providers that don't report
   * readiness (legacy behavior — grace from `playAskedAtMs` alone).
   */
  readyAtMs?: number | null;
}): boolean {
  if (!i.sessionPlaying || i.playAskedAtMs == null) return false;
  if (i.providerState === "idle" && i.readyAtMs !== undefined) {
    if (i.readyAtMs === null) {
      // Still booting: only the long grace may prompt (bug-B backstop).
      return i.nowLocalMs - i.playAskedAtMs > IDLE_BOOT_GRACE_MS;
    }
    return i.nowLocalMs - Math.max(i.playAskedAtMs, i.readyAtMs) > AUTOPLAY_GRACE_MS;
  }
  if (i.nowLocalMs - i.playAskedAtMs <= AUTOPLAY_GRACE_MS) return false;
  return (
    i.providerState === "cued" ||
    i.providerState === "unstarted" ||
    i.providerState === "paused" ||
    i.providerState === "idle"
  );
}
