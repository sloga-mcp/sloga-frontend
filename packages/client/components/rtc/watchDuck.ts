import { type Participant, type Room, RoomEvent } from "livekit-client";

import {
  duckDecision,
  duckTracker,
  type DuckTracker,
} from "@revolt/ui/components/features/voice/watch/duckPolicy";

/**
 * Movie ducking for watch-together (plan §7.3 4d) — the `Attenuation`
 * shape, but for OUR OWN player instead of other applications: LiveKit's
 * active-speaker list says when someone REMOTE is talking, the pure
 * `duckPolicy` decides the multiplier + hold, and the callback hands the
 * multiplier to the watch store, which composes it with the user's volume
 * at its one application seam.
 *
 * Remote speakers only, deliberately (rev-2 finding 2): with speakers + an
 * open mic, the movie's own audio makes LiveKit mark the LOCAL participant
 * an active speaker — ducking on that is a feedback pump.
 */
export class WatchDuck {
  #enabled: () => boolean;
  #apply: (mult: number) => void;
  #room: Room | undefined;
  #remoteSpeaking = false;
  #tracker: DuckTracker = duckTracker();
  #applied = 1;
  #holdTimer: ReturnType<typeof setTimeout> | undefined;

  #onSpeakers = (speakers: Participant[]) => {
    this.#remoteSpeaking = speakers.some((p) => !p.isLocal);
    this.#evaluate();
  };

  constructor(enabled: () => boolean, apply: (mult: number) => void) {
    this.#enabled = enabled;
    this.#apply = apply;
  }

  /** Follow a room's active speakers. Detaches from any previous room. */
  attach(room: Room) {
    this.detach();
    this.#room = room;
    room.on(RoomEvent.ActiveSpeakersChanged, this.#onSpeakers);
    this.#onSpeakers(room.activeSpeakers);
  }

  /** Stop following and lift the duck immediately. */
  detach() {
    this.#room?.off(RoomEvent.ActiveSpeakersChanged, this.#onSpeakers);
    this.#room = undefined;
    this.#remoteSpeaking = false;
    this.#tracker = duckTracker();
    this.#cancelHold();
    this.#emit(1);
  }

  /** Re-evaluate after the preference toggled (on → duck now if talking;
   * off → lift immediately, no hold). */
  refresh() {
    this.#evaluate();
  }

  #evaluate() {
    const now = Date.now();
    const r = duckDecision(this.#tracker, {
      enabled: this.#room !== undefined && this.#enabled(),
      remoteSpeaking: this.#remoteSpeaking,
      nowMs: now,
    });
    this.#tracker = r.tracker;
    this.#cancelHold();
    if (r.tracker.holdUntilMs !== null && !this.#remoteSpeaking) {
      // Nobody talking but the hold is live: re-check when it lapses so the
      // lift doesn't wait for the next speaker event.
      this.#holdTimer = setTimeout(() => {
        this.#holdTimer = undefined;
        this.#evaluate();
      }, Math.max(0, r.tracker.holdUntilMs - now));
    }
    this.#emit(r.mult);
  }

  #cancelHold() {
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = undefined;
  }

  #emit(mult: number) {
    if (mult === this.#applied) return;
    this.#applied = mult;
    this.#apply(mult);
  }
}
