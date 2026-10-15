/**
 * Where the import entry points lead. Pure, so the branches are spec'd under
 * `node --test` (`importSource.test.ts`).
 */
import type { ImportSource } from "stoat.js";

/**
 * The one import action the create/join fan-outs offer: none, Discord's own
 * modal, or the picker (`import_source` with no source) that lists Discord
 * and every other source the instance has ready.
 */
export type ImportAction = "none" | "discord" | "picker";

/**
 * Which import action the create/join fan-outs show. Never more than one:
 * their actions row does not wrap, and a fourth button pushes the primary
 * ones off the dialog.
 * @param discordEnabled Whether the instance offers the Discord import
 * @param anySourceEnabled Whether any other-platform import can be offered
 */
export function importActionFor(
  discordEnabled: boolean,
  anySourceEnabled: boolean,
): ImportAction {
  if (anySourceEnabled) return "picker";
  return discordEnabled ? "discord" : "none";
}

/** A row on the import picker: Discord, or another platform. */
export type PickerEntry = "discord" | ImportSource;

/**
 * Rows of the import picker, in order: Discord first when the instance
 * offers it, then the other sources as given.
 * @param discordEnabled Whether the instance offers the Discord import
 * @param sources Other sources the picker can offer, in display order
 */
export function pickerEntries(
  discordEnabled: boolean,
  sources: readonly ImportSource[],
): PickerEntry[] {
  return discordEnabled ? ["discord", ...sources] : [...sources];
}
