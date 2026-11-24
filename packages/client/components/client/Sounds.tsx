import { createContext, JSXElement, useContext } from "solid-js";

// The file, not the `@revolt/rtc` barrel: the barrel pulls in the voice
// store, which imports this package back.
import { RING_FALLBACK_MS, ringDurationMs } from "@revolt/rtc/incomingCall";
import { serverCallRingSecs } from "@revolt/rtc/serverRingLength";
import { Sounds, TypeSounds, useState } from "@revolt/state";
import { Settings } from "@revolt/state/stores/Settings";
import { streamerModeHides } from "@revolt/state/streamer";

import deafenSound from "../../scripts/assets_fallback/sounds/deafen.ogg";
import muteSound from "../../scripts/assets_fallback/sounds/mute.ogg";
import streamEndSound from "../../scripts/assets_fallback/sounds/stream_end.ogg";
import streamStartSound from "../../scripts/assets_fallback/sounds/stream_start.ogg";
import streamViewerJoinSound from "../../scripts/assets_fallback/sounds/stream_viewer_join.ogg";
import streamViewerLeaveSound from "../../scripts/assets_fallback/sounds/stream_viewer_leave.ogg";
import undeafenSound from "../../scripts/assets_fallback/sounds/undeafen.ogg";
import unmuteSound from "../../scripts/assets_fallback/sounds/unmute.ogg";
import userMovedSound from "../../scripts/assets_fallback/sounds/user_moved.ogg";

/**
 * A controller class for making sure sounds are managed in one place and to prevent undesirable sound overlaps
 */
type ToneNote = {
  freq: number;
  startTime: number;
  duration: number;
  type?: OscillatorType;
};

/**
 * 5 message sound presets (received + sent variants for each).
 * Index 0 = variant 1, etc.
 */
const MESSAGE_PRESETS: {
  received: ToneNote[];
  sent: ToneNote[];
  label: string;
}[] = [
  {
    label: "Ascend",
    received: [
      { freq: 520, startTime: 0, duration: 0.12 },
      { freq: 780, startTime: 0.1, duration: 0.18 },
    ],
    sent: [{ freq: 900, startTime: 0, duration: 0.08 }],
  },
  {
    label: "Chime",
    received: [
      { freq: 880, startTime: 0, duration: 0.1 },
      { freq: 1100, startTime: 0.09, duration: 0.1 },
      { freq: 1320, startTime: 0.18, duration: 0.2 },
    ],
    sent: [
      { freq: 1320, startTime: 0, duration: 0.08 },
      { freq: 1100, startTime: 0.07, duration: 0.08 },
    ],
  },
  {
    label: "Bubble",
    received: [
      { freq: 400, startTime: 0, duration: 0.05 },
      { freq: 600, startTime: 0.04, duration: 0.05 },
      { freq: 800, startTime: 0.08, duration: 0.12 },
    ],
    sent: [
      { freq: 800, startTime: 0, duration: 0.05 },
      { freq: 600, startTime: 0.04, duration: 0.06 },
    ],
  },
  {
    label: "Soft Bell",
    received: [
      { freq: 660, startTime: 0, duration: 0.6 },
      { freq: 990, startTime: 0.05, duration: 0.55 },
    ],
    sent: [{ freq: 990, startTime: 0, duration: 0.45 }],
  },
  {
    label: "Pop",
    received: [
      { freq: 300, startTime: 0, duration: 0.03 },
      { freq: 700, startTime: 0.02, duration: 0.06 },
    ],
    sent: [{ freq: 700, startTime: 0, duration: 0.04 }],
  },
];

type RingtonePreset = {
  label: string;
  incoming: ToneNote[];
  outgoing: ToneNote[];
  interval: number; // seconds between repeat cycles
};

const RINGTONE_PRESETS: RingtonePreset[] = [
  {
    label: "Classic",
    incoming: [
      { freq: 480, startTime: 0, duration: 0.4 },
      { freq: 480, startTime: 0.5, duration: 0.4 },
    ],
    outgoing: [{ freq: 440, startTime: 0, duration: 0.5 }],
    interval: 2.0,
  },
  {
    label: "Digital",
    incoming: [
      { freq: 660, startTime: 0, duration: 0.1 },
      { freq: 880, startTime: 0.12, duration: 0.1 },
      { freq: 1100, startTime: 0.24, duration: 0.15 },
    ],
    outgoing: [
      { freq: 660, startTime: 0, duration: 0.1 },
      { freq: 880, startTime: 0.12, duration: 0.1 },
    ],
    interval: 1.5,
  },
  {
    label: "Marimba",
    incoming: [
      { freq: 523, startTime: 0, duration: 0.18 },
      { freq: 659, startTime: 0.2, duration: 0.18 },
      { freq: 784, startTime: 0.4, duration: 0.18 },
      { freq: 659, startTime: 0.6, duration: 0.25 },
    ],
    outgoing: [
      { freq: 523, startTime: 0, duration: 0.18 },
      { freq: 659, startTime: 0.2, duration: 0.22 },
    ],
    interval: 2.0,
  },
  {
    label: "Pulse",
    incoming: [
      { freq: 800, startTime: 0, duration: 0.08 },
      { freq: 800, startTime: 0.15, duration: 0.08 },
      { freq: 800, startTime: 0.3, duration: 0.08 },
    ],
    outgoing: [{ freq: 600, startTime: 0, duration: 0.12 }],
    interval: 1.2,
  },
  {
    label: "Melody",
    incoming: [
      { freq: 523, startTime: 0, duration: 0.12 },
      { freq: 659, startTime: 0.13, duration: 0.12 },
      { freq: 784, startTime: 0.26, duration: 0.12 },
      { freq: 1047, startTime: 0.39, duration: 0.3 },
    ],
    outgoing: [
      { freq: 523, startTime: 0, duration: 0.12 },
      { freq: 659, startTime: 0.13, duration: 0.2 },
    ],
    interval: 2.2,
  },
  {
    label: "Retro",
    incoming: [
      { freq: 440, startTime: 0, duration: 0.05, type: "square" },
      { freq: 880, startTime: 0.06, duration: 0.05, type: "square" },
      { freq: 440, startTime: 0.12, duration: 0.05, type: "square" },
      { freq: 880, startTime: 0.18, duration: 0.05, type: "square" },
    ],
    outgoing: [
      { freq: 440, startTime: 0, duration: 0.08, type: "square" },
      { freq: 660, startTime: 0.1, duration: 0.08, type: "square" },
    ],
    interval: 1.5,
  },
  {
    label: "Jazz",
    incoming: [
      { freq: 466, startTime: 0, duration: 0.15 },
      { freq: 587, startTime: 0.16, duration: 0.15 },
      { freq: 698, startTime: 0.32, duration: 0.15 },
      { freq: 587, startTime: 0.48, duration: 0.25 },
    ],
    outgoing: [
      { freq: 466, startTime: 0, duration: 0.15 },
      { freq: 698, startTime: 0.16, duration: 0.2 },
    ],
    interval: 2.0,
  },
  {
    label: "Zen",
    incoming: [
      { freq: 432, startTime: 0, duration: 1.1 },
      { freq: 648, startTime: 0.5, duration: 1.0 },
    ],
    outgoing: [{ freq: 432, startTime: 0, duration: 1.2 }],
    interval: 3.5,
  },
  {
    label: "Urgent",
    incoming: [
      { freq: 800, startTime: 0, duration: 0.06 },
      { freq: 600, startTime: 0.07, duration: 0.06 },
      { freq: 800, startTime: 0.14, duration: 0.06 },
      { freq: 600, startTime: 0.21, duration: 0.06 },
      { freq: 800, startTime: 0.28, duration: 0.06 },
      { freq: 600, startTime: 0.35, duration: 0.06 },
    ],
    outgoing: [
      { freq: 700, startTime: 0, duration: 0.06 },
      { freq: 500, startTime: 0.07, duration: 0.06 },
      { freq: 700, startTime: 0.14, duration: 0.06 },
    ],
    interval: 1.0,
  },
  {
    label: "Chime Ring",
    incoming: [
      { freq: 1047, startTime: 0, duration: 0.2 },
      { freq: 784, startTime: 0.1, duration: 0.2 },
      { freq: 880, startTime: 0.25, duration: 0.35 },
    ],
    outgoing: [
      { freq: 1047, startTime: 0, duration: 0.15 },
      { freq: 880, startTime: 0.2, duration: 0.25 },
    ],
    interval: 2.0,
  },
];

const DISCONNECT_PRESETS: {
  label: string;
  notes: ToneNote[];
  volume?: number;
}[] = [
  {
    label: "Drop",
    notes: [
      { freq: 600, startTime: 0, duration: 0.08 },
      { freq: 400, startTime: 0.07, duration: 0.08 },
      { freq: 250, startTime: 0.14, duration: 0.12 },
    ],
  },
  {
    label: "Fade Out",
    notes: [
      { freq: 520, startTime: 0, duration: 0.35 },
      { freq: 380, startTime: 0.1, duration: 0.3 },
    ],
    volume: 0.2,
  },
  {
    label: "Thud",
    notes: [
      { freq: 180, startTime: 0, duration: 0.15, type: "triangle" },
      { freq: 120, startTime: 0.08, duration: 0.2, type: "triangle" },
    ],
    volume: 0.35,
  },
  {
    label: "Descend",
    notes: [
      { freq: 880, startTime: 0, duration: 0.08 },
      { freq: 660, startTime: 0.08, duration: 0.08 },
      { freq: 440, startTime: 0.16, duration: 0.08 },
      { freq: 330, startTime: 0.24, duration: 0.12 },
    ],
  },
  {
    label: "Soft Pop",
    notes: [
      { freq: 500, startTime: 0, duration: 0.04 },
      { freq: 300, startTime: 0.03, duration: 0.07 },
    ],
    volume: 0.2,
  },
];

export { DISCONNECT_PRESETS, MESSAGE_PRESETS, RINGTONE_PRESETS };

/** Which call ringtone is sounding: being called, or calling */
export type RingtoneKind = "incoming" | "outgoing";

/** Length of the fade that ends a ringtone, so it does not stop on a click */
const RINGTONE_FADE_SECS = 0.05;

export class SoundController {
  readonly soundState: Sounds;
  readonly settingsState: Settings;
  /** Reads how long a call rings, in milliseconds, when a ringtone starts */
  readonly #ringLengthMs: () => number;

  node?: HTMLAudioElement;
  #audioCtx?: AudioContext;
  #ringtoneGain?: GainNode;
  #ringtoneTimer?: ReturnType<typeof setTimeout>;
  #ringtoneKind?: RingtoneKind;

  lastPlayedSound?: keyof TypeSounds;

  constructor(
    soundState: Sounds,
    settingsState: Settings,
    ringLengthMs: () => number = () => RING_FALLBACK_MS,
  ) {
    this.soundState = soundState;
    this.settingsState = settingsState;
    this.#ringLengthMs = ringLengthMs;

    this.isPlaying = this.isPlaying.bind(this);
    this.canPlay = this.canPlay.bind(this);
    this.playSound = this.playSound.bind(this);

    // Unlock AudioContext on first user gesture so event-triggered sounds work
    const unlock = () => {
      this.#getCtx();
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("click", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  /**
   * Get whether a sound is currently being played by the sound controller
   *
   * @returns Whether a sound is currently playing
   */
  isPlaying(): boolean {
    return this.node?.paused ?? false;
  }

  /**
   * Get whether a sound can be played right now
   *
   * @param newSound Sound to check for playability
   * @returns Whether the sound passed is playable currently
   */
  canPlay(newSound: keyof TypeSounds): boolean {
    // Never let a sound turned off play
    if (!this.soundState.enabled(newSound)) {
      return false;
    }

    // Streamer Mode can mute all event sounds (previews use force=true)
    if (streamerModeHides(this.settingsState, "sounds")) {
      return false;
    }

    // Always let the sound play if nothing is currently playing
    if (!this.isPlaying()) {
      return true;
    }

    // If there are any cases where you don't want sound collisions, put them here.
    // None for now.
    return true;
  }

  /**
   * Get or create the shared AudioContext, resuming it if suspended
   */
  #getCtx(): AudioContext {
    if (!this.#audioCtx || this.#audioCtx.state === "closed") {
      this.#audioCtx = new AudioContext();
    }
    if (this.#audioCtx.state === "suspended") {
      this.#audioCtx.resume();
    }
    return this.#audioCtx;
  }

  /**
   * Play a short synthesized tone via Web Audio API
   */
  #playTone(notes: ToneNote[], volume = 0.25): void {
    try {
      const ctx = this.#getCtx();
      for (const { freq, startTime, duration, type } of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = type ?? "sine";
        osc.frequency.setValueAtTime(freq, ctx.currentTime + startTime);
        gain.gain.setValueAtTime(volume, ctx.currentTime + startTime);
        gain.gain.exponentialRampToValueAtTime(
          0.001,
          ctx.currentTime + startTime + duration,
        );
        osc.start(ctx.currentTime + startTime);
        osc.stop(ctx.currentTime + startTime + duration + 0.01);
      }
    } catch {
      // AudioContext may be unavailable in some environments
    }
  }

  /**
   * Get the active message preset (1-indexed, clamped to valid range)
   */
  #getPreset() {
    const variant = this.settingsState.getValue("sounds:message_variant") ?? 4;
    const idx = Math.max(
      0,
      Math.min(MESSAGE_PRESETS.length - 1, (variant as number) - 1),
    );
    return MESSAGE_PRESETS[idx];
  }

  /**
   * Get the active disconnect preset (1-indexed, clamped to valid range)
   */
  #getDisconnectPreset() {
    const variant =
      this.settingsState.getValue("sounds:disconnect_variant") ?? 1;
    const idx = Math.max(
      0,
      Math.min(DISCONNECT_PRESETS.length - 1, (variant as number) - 1),
    );
    return DISCONNECT_PRESETS[idx];
  }

  /**
   * Get the active ringtone preset (1-indexed, clamped to valid range)
   */
  #getRingtonePreset() {
    const variant = this.settingsState.getValue("sounds:ringtone_variant") ?? 1;
    const idx = Math.max(
      0,
      Math.min(RINGTONE_PRESETS.length - 1, (variant as number) - 1),
    );
    return RINGTONE_PRESETS[idx];
  }

  /**
   * Which ringtone is sounding now: "incoming" (we are being called),
   * "outgoing" (we are calling), or undefined when none is. Not reactive;
   * read it at the moment you act, e.g. to stop only the incoming ring.
   * @returns The kind, or undefined
   */
  ringtoneKind(): RingtoneKind | undefined {
    return this.#ringtoneKind;
  }

  /**
   * Stop any currently looping ringtone
   */
  stopRingtone() {
    this.#ringtoneKind = undefined;
    if (this.#ringtoneTimer !== undefined) {
      clearTimeout(this.#ringtoneTimer);
      this.#ringtoneTimer = undefined;
    }
    if (this.#ringtoneGain) {
      try {
        this.#ringtoneGain.disconnect();
      } catch {
        /* ignore */
      }
      this.#ringtoneGain = undefined;
    }
  }

  /**
   * How long a ringtone may sound, in milliseconds. A reader that throws or
   * answers something unusable must not cost the ring itself, so that reads
   * as the default ring length.
   */
  #ringMs(): number {
    try {
      const read = this.#ringLengthMs();
      if (Number.isFinite(read) && read > 0) return read;
    } catch {
      // keep the default
    }
    return RING_FALLBACK_MS;
  }

  /**
   * Play a looping synthesized ringtone via Web Audio API.
   * Uses the shared (gesture-unlocked) AudioContext — a fresh context would
   * start suspended under autoplay policy and ring silently.
   *
   * The ringtone ends by itself at the ring length, counted from this call.
   * No note is scheduled to start at or after that point and the output
   * fades out just before it. A timer then drops the ringtone, which also
   * covers an audio clock that started late because the context was still
   * suspended.
   */
  #playRingtone(
    kind: RingtoneKind,
    notes: ToneNote[],
    interval: number,
    volume = 0.3,
  ): void {
    this.stopRingtone();
    const ringMs = this.#ringMs();
    const ringSecs = ringMs / 1000;
    try {
      const ctx = this.#getCtx();
      const master = ctx.createGain();
      master.connect(ctx.destination);
      this.#ringtoneGain = master;
      this.#ringtoneKind = kind;
      const endsAt = ctx.currentTime + ringSecs;
      master.gain.setValueAtTime(1, endsAt - RINGTONE_FADE_SECS);
      master.gain.linearRampToValueAtTime(0, endsAt);
      this.#ringtoneTimer = setTimeout(() => this.stopRingtone(), ringMs);
      // Every ring that starts before the ring length; none for an interval
      // that is not a positive number.
      const rings = interval > 0 ? Math.ceil(ringSecs / interval) : 0;
      for (let ring = 0; ring < rings; ring++) {
        const offset = ring * interval;
        for (const { freq, startTime, duration, type } of notes) {
          if (offset + startTime >= ringSecs) continue;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(master);
          osc.type = type ?? "sine";
          osc.frequency.setValueAtTime(
            freq,
            ctx.currentTime + offset + startTime,
          );
          gain.gain.setValueAtTime(
            volume,
            ctx.currentTime + offset + startTime,
          );
          gain.gain.exponentialRampToValueAtTime(
            0.001,
            ctx.currentTime + offset + startTime + duration,
          );
          osc.start(ctx.currentTime + offset + startTime);
          osc.stop(ctx.currentTime + offset + startTime + duration + 0.01);
        }
      }
    } catch {
      // AudioContext may be unavailable
    }
  }

  /**
   * Play a sound, following the rules of sound playability unless force is true
   *
   * @param sound The sound to play
   * @param force Bypass canPlay check
   * @returns Whether the sound played
   */
  playSound(sound: keyof TypeSounds, force?: boolean): boolean {
    if (!force && !this.canPlay(sound)) {
      return false;
    }
    switch (sound) {
      case "deafen": {
        this.node = new Audio(deafenSound);
        break;
      }
      case "message": {
        this.#playTone(this.#getPreset().received);
        this.lastPlayedSound = sound;
        return true;
      }
      case "messageSent": {
        this.#playTone(this.#getPreset().sent, 0.18);
        this.lastPlayedSound = sound;
        return true;
      }
      case "mute": {
        this.node = new Audio(muteSound);
        break;
      }
      case "ringtoneIncoming": {
        const rp = this.#getRingtonePreset();
        this.#playRingtone("incoming", rp.incoming, rp.interval);
        this.lastPlayedSound = sound;
        return true;
      }
      case "ringtoneOutgoing": {
        const rp = this.#getRingtonePreset();
        this.#playRingtone("outgoing", rp.outgoing, rp.interval, 0.2);
        this.lastPlayedSound = sound;
        return true;
      }
      case "streamEnd": {
        this.node = new Audio(streamEndSound);
        break;
      }
      case "streamStart": {
        this.node = new Audio(streamStartSound);
        break;
      }
      case "streamViewerJoin": {
        this.node = new Audio(streamViewerJoinSound);
        break;
      }
      case "streamViewerLeave": {
        this.node = new Audio(streamViewerLeaveSound);
        break;
      }
      case "undeafen": {
        this.node = new Audio(undeafenSound);
        break;
      }
      case "unmute": {
        this.node = new Audio(unmuteSound);
        break;
      }
      case "userJoinVoice": {
        this.#playTone([
          { freq: 400, startTime: 0, duration: 0.05 },
          { freq: 600, startTime: 0.04, duration: 0.05 },
          { freq: 800, startTime: 0.08, duration: 0.12 },
        ]);
        this.lastPlayedSound = sound;
        return true;
      }
      case "userLeaveVoice": {
        const dp = this.#getDisconnectPreset();
        this.#playTone(dp.notes, dp.volume);
        this.lastPlayedSound = sound;
        return true;
      }
      case "userMoved": {
        this.node = new Audio(userMovedSound);
        break;
      }
    }
    this.stopRingtone();
    this.lastPlayedSound = sound;
    this.node.play();
    return true;
  }
}

const soundContext = createContext(null! as SoundController);

export function SoundContext(props: { children: JSXElement }) {
  const { sounds, settings } = useState();

  // Read on every ring rather than once: the server's advertised length
  // arrives after this provider mounts (see `serverRingLength.ts`).
  const controller = new SoundController(sounds, settings, () =>
    ringDurationMs(serverCallRingSecs()),
  );

  return (
    <soundContext.Provider value={controller}>
      {props.children}
    </soundContext.Provider>
  );
}

export function useSound(): SoundController {
  return useContext(soundContext);
}
