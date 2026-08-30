/**
 * Pure decisions for voice auto-rejoin after the transport dies.
 *
 * Split out of `state.tsx` for the same reason as `androidLegStartPolicy` and
 * `mlsDrainPolicy`: the interesting cases are a disconnect REASON arriving at
 * a particular moment in the call's life, and they are untestable while the
 * decision lives inside a class that needs a live Room, a client and a native
 * bridge to construct.
 *
 * The failure this exists to end (observed live 2026-08-22, and worth stating
 * precisely because the obvious reading is wrong): LiveKit's retry policy did
 * NOT give up — it never ran. `DefaultReconnectPolicy` allows ten attempts
 * over ~44 s, but a separate connection-reconcile watchdog probes the
 * transport every 4 s and, on the third consecutive failure, calls
 * `handleDisconnect` with `STATE_MISMATCH`. That path is terminal: it emits
 * `disconnected` and never enters the retry policy at all. Three probes at 4 s
 * is the twelve seconds that looked like "three retries".
 *
 * So the room gets the recovery the app's own websocket already has —
 * `Controller.ts` retries unbounded with backoff capped at 15 s, which is why
 * the page stayed responsive while the call stayed dead.
 */
import { DisconnectReason } from "livekit-client";

/**
 * Disconnect reasons that mean the call ended ON PURPOSE — hung up, removed,
 * superseded by a join from another device, or the room itself closed.
 *
 * This is a DENY-list rather than an allow-list on purpose. Every other
 * reason — state mismatch, signal close, server shutdown, migration, timeout,
 * and whatever the SDK adds next — is a transport death the user never asked
 * for, and the safe default for an unrecognised reason is to recover rather
 * than to strand someone on a dead call. An allow-list would silently stop
 * rejoining the day LiveKit introduces a new failure code.
 */
export const NO_REJOIN_DISCONNECT_REASONS = new Set<DisconnectReason>([
  DisconnectReason.CLIENT_INITIATED,
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.ROOM_CLOSED,
  DisconnectReason.USER_UNAVAILABLE,
  DisconnectReason.USER_REJECTED,
  DisconnectReason.SIP_TRUNK_FAILURE,
]);

/**
 * Backoff between automatic rejoin attempts; the last value repeats.
 *
 * Each attempt is a full REST join + room connect, so the tail is
 * deliberately slow — but a visibility/online edge short-circuits the wait,
 * so a user coming back to a recovered network never sits out a 30 s sleep.
 */
export const REJOIN_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * Stop auto-rejoining after this many consecutive failures and fall back to
 * the actionable DISCONNECTED card (Rejoin button) — a server that keeps
 * refusing the join should not be hammered forever.
 */
export const MAX_REJOIN_ATTEMPTS = 8;

export interface RejoinWorld {
  /**
   * Voice state at the moment the room reported `disconnected`. Only a call
   * the user was actually IN is auto-rejoined.
   */
  state: string;
  /** LiveKit's reason; `undefined` when the SDK reports none. */
  reason: DisconnectReason | undefined;
}

/**
 * Should an unexpected `disconnected` be recovered from, or left alone?
 *
 * The `CONNECTED` gate is what keeps a FAILING INITIAL JOIN out of the loop:
 * a join that never succeeds also emits `disconnected`, and rejoining it
 * would retry a call the user never got into while swallowing the error that
 * `connect()`'s catch is there to surface. A plain hang-up never even reaches
 * here — `disconnect()` strips the listeners first — so the deny-list is
 * about the ends that arrive from the SERVER.
 *
 * An absent reason recovers. The SDK omits it on some transport closes, and
 * "no reason given" from a room the user was mid-call in is far more likely
 * to be a dead socket than a deliberate ending.
 */
export function shouldAutoRejoin(world: RejoinWorld): boolean {
  if (world.state !== "CONNECTED") return false;
  if (world.reason === undefined) return true;
  return !NO_REJOIN_DISCONNECT_REASONS.has(world.reason);
}

/**
 * How long to wait before attempt `attempt` (0-based).
 *
 * Clamps rather than running off the end of the schedule: the loop may make
 * more attempts than the table has entries, and the final value repeating is
 * the intended shape.
 */
export function rejoinDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), REJOIN_DELAYS_MS.length - 1);
  return REJOIN_DELAYS_MS[index];
}

/**
 * Total time the loop spends trying before it gives up, in ms. Not used by
 * the loop itself — it exists so the bound is assertable, because "how long
 * does a user stare at Reconnecting before they get a button" is a product
 * question that should fail a test when someone edits the schedule.
 */
export function totalRejoinWindowMs(): number {
  let total = 0;
  for (let attempt = 0; attempt < MAX_REJOIN_ATTEMPTS; attempt++)
    total += rejoinDelayMs(attempt);
  return total;
}
