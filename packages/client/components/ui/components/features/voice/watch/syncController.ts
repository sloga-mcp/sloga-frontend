/**
 * Watch-together drift corrector (plan §3). Pure — no Solid, no DOM, no
 * timers — so it runs under `node --test` with a fake clock and a fake
 * provider:
 *   node --test components/ui/components/features/voice/watch/syncController.test.ts
 *
 * Runs on every VIEWER (the host is ground truth and never corrects
 * itself). Once per tick (~500 ms) the caller hands in a snapshot — the
 * session as last received, the provider's de-staled position and state,
 * both clocks — plus the controller's own carried state, and gets back the
 * list of provider actions to issue and the next carried state.
 *
 * The whole sync contract is one formula:
 *   expected_position(now) = position_ms + (playing ? (now − position_at) × rate : 0)
 * with `now` on the SERVER clock (local + offset). Everything below is
 * how a player is coaxed onto that line without flapping.
 */

/** Rate in thousandths (1000 = 1.0×) — the wire model has no floats. */
export const RATE_NORMAL = 1000;

/** What the corrector needs to know about the session (server-stamped). */
export interface SyncSession {
  playing: boolean;
  positionMs: number;
  /** SERVER unix-ms when `positionMs` was true. */
  positionAt: number;
  ratePermille: number;
}

/**
 * Provider state vocabulary. `buffering`, `cued`, `unstarted` and `idle`
 * are "no opinion" — the corrector neither reads them as paused nor issues
 * play() on them (a stalled viewer must not be told to play; a cued YouTube
 * embed must not be read as "the user paused").
 */
export type ProviderState =
  | "idle"
  | "unstarted"
  | "cued"
  | "buffering"
  | "playing"
  | "paused"
  | "ended"
  | "error";

export interface ProviderCapabilities {
  /** Fractional `setRate` works (true for YouTube AND HLS — probe 0(a)). */
  rateNudge: boolean;
  /**
   * Drift beyond which we hard-seek instead of nudging: YouTube seeks cost
   * 22-30 ms with no rebuffer (~700 ms), an HLS seek rebuffers (1500 ms).
   */
  hardSeekMs: number;
}

export interface ProviderSnapshot {
  state: ProviderState;
  /** De-staled position in ms, or null when unknown (not loaded yet). */
  currentTimeMs: number | null;
  /** The rate the provider is currently running at (thousandths). */
  ratePermille: number;
  capabilities: ProviderCapabilities;
}

export interface SyncSnapshot {
  session: SyncSession;
  provider: ProviderSnapshot;
  /** Local monotonic-ish clock (performance.now or Date.now — just be consistent). */
  nowLocalMs: number;
  /** `nowLocalMs` translated to the server clock (`+ offset`). */
  nowServerMs: number;
}

export type SyncAction =
  | { type: "seek"; ms: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "setRate"; permille: number };

/** State the corrector carries between ticks. */
export interface SyncState {
  /**
   * A play/pause we issued and are waiting on. Reconciliation of
   * playing-ness is suppressed until the provider reports the target state
   * or `LATCH_TIMEOUT_MS` elapses (measured: pause → state 2 takes ~1 s via
   * buffering; a 300 ms debounce would re-issue or reverse it mid-flight).
   */
  pending: { kind: "play" | "pause"; sinceLocalMs: number } | null;
  /** Currently nudging (rate ≠ session rate) — hysteresis back to 1.0. */
  nudging: boolean;
  /** Last hard seek we issued (local ms); holds off a second one briefly. */
  lastSeekLocalMs: number | null;
  /** Last seek-only correction for non-nudging providers (3 s hysteresis). */
  lastSoftSeekLocalMs: number | null;
}

export const INITIAL_SYNC_STATE: SyncState = {
  pending: null,
  nudging: false,
  lastSeekLocalMs: null,
  lastSoftSeekLocalMs: null,
};

/** Give a provider this long to report a play/pause before we try again. */
export const LATCH_TIMEOUT_MS = 1500;
/** Inside this band we do nothing at all. */
export const DEAD_BAND_MS = 250;
/** Nudging stops (rate back to session rate) once inside this. */
export const NUDGE_DONE_MS = 100;
/** Proportional nudge: ±drift/10 s, clamped to ±10 %. */
export const NUDGE_GAIN_PER_MS = 1 / 10_000;
export const NUDGE_MAX = 0.1;
/** Non-nudging providers seek only past this, then wait this long. */
export const SOFT_SEEK_MS = 1000;
export const SOFT_SEEK_HYSTERESIS_MS = 3000;
/** After a hard seek, the provider needs a moment to report the new position. */
export const POST_SEEK_HOLD_MS = 800;

/** The sync contract, on the server clock. */
export function expectedPosition(session: SyncSession, nowServerMs: number): number {
  if (!session.playing) return session.positionMs;
  const elapsed = Math.max(0, nowServerMs - session.positionAt);
  return session.positionMs + (elapsed * session.ratePermille) / RATE_NORMAL;
}

/** Clamp a proportional nudge to the allowed band and quantize to permille. */
export function nudgeRateFor(driftMs: number, baseRatePermille: number): number {
  const raw = -driftMs * NUDGE_GAIN_PER_MS; // ahead (drift > 0) → slow down
  const factor = 1 + Math.max(-NUDGE_MAX, Math.min(NUDGE_MAX, raw));
  return Math.round(baseRatePermille * factor);
}

export interface ReconcileResult {
  actions: SyncAction[];
  state: SyncState;
  /** Provider − expected, ms; null when the provider position is unknown. */
  driftMs: number | null;
  expectedMs: number;
}

const NO_OPINION: ReadonlySet<ProviderState> = new Set([
  "idle",
  "unstarted",
  "cued",
  "buffering",
]);

export function reconcile(snap: SyncSnapshot, prev: SyncState): ReconcileResult {
  const { session, provider, nowLocalMs, nowServerMs } = snap;
  const actions: SyncAction[] = [];
  const state: SyncState = { ...prev };
  const expectedMs = expectedPosition(session, nowServerMs);

  // Provider not usable yet / broken: nothing to do (UI shows the state).
  if (provider.state === "error" || provider.currentTimeMs == null) {
    return { actions, state, driftMs: null, expectedMs };
  }

  // --- Latch: resolve or expire a pending play/pause ----------------------
  if (state.pending) {
    const target = state.pending.kind === "play" ? "playing" : "paused";
    if (provider.state === target) {
      state.pending = null;
    } else if (nowLocalMs - state.pending.sinceLocalMs > LATCH_TIMEOUT_MS) {
      state.pending = null; // give up waiting; re-evaluate below
    }
  }

  // --- Playing-ness --------------------------------------------------------
  // Only opinionated provider states count. A stalled (buffering) viewer is
  // never told to play; a cued embed is never read as "user paused".
  const opinionated = !NO_OPINION.has(provider.state);
  if (!state.pending && opinionated) {
    const localPlaying = provider.state === "playing";
    if (session.playing && !localPlaying && provider.state !== "ended") {
      actions.push({ type: "play" });
      state.pending = { kind: "play", sinceLocalMs: nowLocalMs };
    } else if (!session.playing && localPlaying) {
      actions.push({ type: "pause" });
      state.pending = { kind: "pause", sinceLocalMs: nowLocalMs };
    }
  }

  // --- Position ------------------------------------------------------------
  const driftMs = provider.currentTimeMs - expectedMs;
  const abs = Math.abs(driftMs);
  const recentlySeeked =
    state.lastSeekLocalMs != null && nowLocalMs - state.lastSeekLocalMs < POST_SEEK_HOLD_MS;

  if (recentlySeeked) {
    // Let the provider report the landed position before judging again.
  } else if (abs > provider.capabilities.hardSeekMs) {
    actions.push({ type: "seek", ms: Math.max(0, Math.round(expectedMs)) });
    state.lastSeekLocalMs = nowLocalMs;
    if (state.nudging) {
      actions.push({ type: "setRate", permille: session.ratePermille });
      state.nudging = false;
    }
    // YouTube's seekTo from cued/unstarted starts playback: re-assert pause
    // right after a seek while the session is paused (plan §3).
    if (!session.playing && !state.pending) {
      actions.push({ type: "pause" });
      state.pending = { kind: "pause", sinceLocalMs: nowLocalMs };
    }
  } else if (provider.capabilities.rateNudge) {
    // Nudging only makes sense while both sides are running.
    if (session.playing && provider.state === "playing") {
      if (abs > DEAD_BAND_MS) {
        const permille = nudgeRateFor(driftMs, session.ratePermille);
        if (permille !== provider.ratePermille) {
          actions.push({ type: "setRate", permille });
        }
        state.nudging = true;
      } else if (state.nudging && abs < NUDGE_DONE_MS) {
        actions.push({ type: "setRate", permille: session.ratePermille });
        state.nudging = false;
      }
    } else if (state.nudging) {
      actions.push({ type: "setRate", permille: session.ratePermille });
      state.nudging = false;
    }
  } else if (abs > SOFT_SEEK_MS) {
    const held =
      state.lastSoftSeekLocalMs != null &&
      nowLocalMs - state.lastSoftSeekLocalMs < SOFT_SEEK_HYSTERESIS_MS;
    if (!held) {
      actions.push({ type: "seek", ms: Math.max(0, Math.round(expectedMs)) });
      state.lastSoftSeekLocalMs = nowLocalMs;
      state.lastSeekLocalMs = nowLocalMs;
    }
  }

  // --- Host rate (1.25× etc.) is session state, applied when not nudging ---
  if (!state.nudging && provider.ratePermille !== session.ratePermille && !recentlySeeked) {
    // Avoid duplicating a setRate already queued above.
    if (!actions.some((a) => a.type === "setRate")) {
      actions.push({ type: "setRate", permille: session.ratePermille });
    }
  }

  return { actions, state, driftMs, expectedMs };
}
