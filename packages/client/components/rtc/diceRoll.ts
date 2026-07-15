/**
 * Shared dice-roll helpers.
 *
 * Lives in the (low-level) rtc layer so BOTH the in-chat message renderer
 * (`@revolt/app` DiceRollMessage) and the in-call overlay (Voice store +
 * call card) can read the same flag/format without a circular import — app
 * already depends on rtc, never the other way around.
 */

/**
 * DiceRoll message flag (bit 4). Server-assigned only: the regular send path
 * rejects client-supplied flag values above 7, so a message carrying this bit
 * is a guaranteed-authentic server-side roll (mirrors delta `MessageFlags`).
 */
export const FLAG_DICE_ROLL = 1 << 4;

/**
 * Whether a message is a server-generated dice roll.
 */
export function isDiceRollMessage(flags: number, content?: string) {
  return (flags & FLAG_DICE_ROLL) === FLAG_DICE_ROLL && !!content;
}

/**
 * Server roll content format (stable, produced by delta's dice engine):
 * 🎲 `2d6+3` → [4, 5] + 3 = **12**
 * 🎲 `1d20+5` → [20] + 5 = **25** — Natural 20! 🎉
 */
const RE_DICE_SUMMARY = /^🎲 `([^`]+)` → .+ = \*\*(-?\d+)\*\*(?: — (.+))?$/;

export interface DiceRollSummary {
  /** The rolled notation, e.g. `1d20` or `2d6+3`. */
  notation: string;
  /** The final total, as printed by the server. */
  total: string;
  /** Natural 20 / natural 1 on a single kept d20, if any. */
  natural?: "crit" | "fumble";
}

/**
 * Pull the headline (notation + total + crit/fumble) out of a server roll's
 * content. Returns undefined if the content isn't a recognisable roll — the
 * caller can then skip the overlay. Mirrors DiceRollMessage's crit detection
 * (the natural-20 suffix contains "20").
 */
export function summariseDiceRoll(content: string): DiceRollSummary | undefined {
  const match = RE_DICE_SUMMARY.exec(content);
  if (!match) return undefined;

  const [, notation, total, suffix] = match;
  const natural = suffix
    ? suffix.includes("20")
      ? ("crit" as const)
      : ("fumble" as const)
    : undefined;

  return { notation, total, natural };
}
