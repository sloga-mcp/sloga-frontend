/**
 * How an incoming call is shown while the app is on screen: over the whole
 * screen, or as a banner at the top that leaves the chat usable. Pure, so it
 * is unit-testable in isolation.
 *
 * The choice is a per-device setting with three values. "auto" is what the
 * app did before the setting existed: full screen in Slim view, a banner
 * otherwise. "full" and "banner" are the user's own choice and win over
 * that.
 *
 * One rule sits above the setting: a locked phone always gets the full
 * screen. The banner leaves the chat behind it readable, and nothing of a
 * chat may show on a lock screen, so no value of the setting can ask for a
 * banner there. Whoever reads the lock state decides what a doubt means (the
 * ring popup reads every doubt as locked); this module only takes the answer.
 */
export type RingStyle = "auto" | "full" | "banner";

/** Every value the setting may hold. The first is the default. */
export const RING_STYLES: readonly RingStyle[] = ["auto", "full", "banner"];

/** Whether a stored value is one of the three. Anything else is not kept. */
export function isRingStyle(value: unknown): value is RingStyle {
  return (
    typeof value === "string" &&
    (RING_STYLES as readonly string[]).includes(value)
  );
}

/**
 * Whether the ring covers the whole screen. An unknown style reads as
 * "auto".
 */
export function ringFullScreen(input: {
  locked: boolean;
  slim: boolean;
  style: unknown;
}): boolean {
  if (input.locked) return true;
  if (input.style === "full") return true;
  if (input.style === "banner") return false;
  return input.slim;
}

/**
 * The value to store when the user flips the setting's switch, given what
 * the switch shows now. It is always an explicit choice, never "auto", so a
 * later change of Slim view does not undo it.
 */
export function ringStyleAfterToggle(fullScreenNow: boolean): RingStyle {
  return fullScreenNow ? "banner" : "full";
}
