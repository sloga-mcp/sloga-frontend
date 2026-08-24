/**
 * Gamepad-leg logic for the couch co-op latency gate (§2.6 part 2).
 * DEV INSTRUMENTATION — gated behind `VITE_CFG_RC_GAMEPAD_LEG` at its call
 * sites; this module is pure logic (no DOM, no timers) so the mapping
 * invariants can be tested directly.
 *
 * The wire shape and the W3C→XInput table MIRROR the native harness
 * (`src-tauri/ui/rc-harness.html`) and the sharer's decoder, and the tests
 * below pin the two ways a naive capture loop kills a live session:
 *
 *   - `0x0800` is the single reserved gap in XInput's 16 button bits, and
 *     W3C standard-mapping index 11 is D-pad Left in spirit (R3 here) — the
 *     obvious `mask |= pressed << i` sets it, the sharer REFUSES the decode
 *     (masking would inject a different button than the guest pressed), and
 *     the session tears down on the first press of that button.
 *   - a `motionSeq` that does not STRICTLY advance is a silent stall, not a
 *     degradation: a pad frame carries its entire state under that number
 *     and the sharer applies it only when strictly newer. The caller owns
 *     the counter; this module only shapes frames.
 */

/** One complete virtual-pad state — the native `RcPadFrame` wire shape. */
export type PadFrame = {
  /** XInput `wButtons` mask. `0x0800` is reserved and must never be set. */
  buttons: number;
  /** Analog triggers, 0–255. */
  leftTrigger: number;
  rightTrigger: number;
  /** Stick axes, −32768…32767. XInput has UP positive; W3C has down positive. */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
};

export const NEUTRAL_PAD: PadFrame = Object.freeze({
  buttons: 0,
  leftTrigger: 0,
  rightTrigger: 0,
  lx: 0,
  ly: 0,
  rx: 0,
  ry: 0,
});

/**
 * W3C standard-mapping button index → XInput `wButtons` bit.
 *
 * An explicit table because the obvious `mask |= pressed << i` sets
 * `0x0800` — the one undefined bit — which the sharer refuses as tampering.
 * Indices 6 and 7 are the analog triggers and deliberately have no bit.
 * Index 16 (Guide) is FORWARDED on purpose: the Game Bar is pad-reachable
 * surface (§3), and pretending otherwise is what would make the consent
 * copy dishonest.
 */
export const XINPUT_BIT: Readonly<Record<number, number>> = Object.freeze({
  0: 0x1000, // A
  1: 0x2000, // B
  2: 0x4000, // X
  3: 0x8000, // Y
  4: 0x0100, // LB
  5: 0x0200, // RB
  8: 0x0020, // Back
  9: 0x0010, // Start
  10: 0x0040, // L3
  11: 0x0080, // R3
  12: 0x0001, // D-pad up
  13: 0x0002, // D-pad down
  14: 0x0004, // D-pad left
  15: 0x0008, // D-pad right
  16: 0x0400, // Guide
});

/** Every bit the decoder accepts; `0x0800` is the reserved hole. */
export const PAD_BUTTON_DEFINED = 0xf7ff;

/** XInput bit → human name, for probe sample labels and the readout. */
export const XINPUT_NAME: Readonly<Record<number, string>> = Object.freeze({
  0x1000: "A",
  0x2000: "B",
  0x4000: "X",
  0x8000: "Y",
  0x0100: "LB",
  0x0200: "RB",
  0x0020: "Back",
  0x0010: "Start",
  0x0040: "L3",
  0x0080: "R3",
  0x0001: "Up",
  0x0002: "Down",
  0x0004: "Left",
  0x0008: "Right",
  0x0400: "Guide",
});

/** The slice of `Gamepad` this module reads, so tests need no DOM. */
export type PadInput = {
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
};

const axis16 = (v: number) =>
  Math.max(-32768, Math.min(32767, Math.round((v || 0) * 32767)));

const trigger8 = (v: number) =>
  Math.max(0, Math.min(255, Math.round((v || 0) * 255)));

/**
 * Read a live Gamepad into the wire shape.
 *
 * Y axes are INVERTED: the W3C spec has down positive, XInput has up
 * positive. Triggers come from button values 6/7 (analog on the standard
 * mapping), scaled to XInput's 0–255.
 */
export function readPad(gp: PadInput): PadFrame {
  let buttons = 0;
  gp.buttons.forEach((b, i) => {
    const bit = XINPUT_BIT[i];
    if (b.pressed && bit !== undefined) buttons |= bit;
  });
  return {
    buttons,
    leftTrigger: trigger8(gp.buttons[6]?.value ?? 0),
    rightTrigger: trigger8(gp.buttons[7]?.value ?? 0),
    lx: axis16(gp.axes[0] ?? 0),
    // Inversion happens INSIDE the clamp, not after it: `-axis16(-1.0001)`
    // is `-(-32768)` = 32768, one past i16, and native refuses the frame.
    // `|| 0` folds the `-0` a centered stick would otherwise produce — it
    // serializes identically but fails strict equality in tests and diffs.
    ly: axis16(-(gp.axes[1] ?? 0)) || 0,
    rx: axis16(gp.axes[2] ?? 0),
    ry: axis16(-(gp.axes[3] ?? 0)) || 0,
  };
}

/**
 * Names of buttons that went DOWN between two masks — the probe arms on
 * these. Releases and holds are not actuations and produce nothing.
 */
export function pressedEdges(prev: number, next: number): string[] {
  const rising = next & ~prev;
  const names: string[] = [];
  for (const [bit, name] of Object.entries(XINPUT_NAME)) {
    if (rising & Number(bit)) names.push(name);
  }
  return names;
}
