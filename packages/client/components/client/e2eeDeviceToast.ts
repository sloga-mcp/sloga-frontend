/**
 * Own-device toasts (multi-device plan D7). When another install starts
 * using encryption on this account, the bridge records it in
 * `ownDeviceAdded`; `E2EEDeviceToastWorker` shows each new device once.
 *
 * The decisions live here, free of Solid and lingui, so
 * `e2eeDeviceToast.test.ts` loads this module under Node. The copy itself is
 * in the worker, which maps each `DeviceToast` to its string.
 */
import type { OwnDeviceAddedEntry } from "./e2ee";

/** The fields of an `ownDeviceAdded` entry the toast reads. */
export type DeviceToastEntry = Pick<
  OwnDeviceAddedEntry,
  "splitFrom" | "sessionName"
>;

/**
 * Which toast a new own device gets.
 * - `split`: another of the user's apps became a separate device (the event
 *   carried `split_from`);
 * - `added`: encryption was set up on another device, named by its session
 *   when the server listing had one.
 */
export type DeviceToast =
  | { kind: "split" }
  | { kind: "added"; sessionName: string | null };

/** The longest session name a toast shows, in code points. */
export const TOAST_SESSION_NAME_MAX = 64;

/**
 * Whether a code point is dropped from a session name: C0 and C1 controls,
 * zero-width and directional marks, bidi embeddings, overrides and isolates,
 * and the byte order mark. The name is chosen by whoever signed in, so it
 * must not be able to reorder or hide the copy around it.
 * @param code Code point
 * @returns Whether to drop it
 */
function isHiddenCodePoint(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * A session name as a toast shows it: hidden code points dropped,
 * whitespace collapsed, at most `TOAST_SESSION_NAME_MAX` code points (cut
 * with an ellipsis). Null when nothing printable is left.
 * @param raw The session name from the own device listing
 * @returns The name to show, or null for the unnamed copy
 */
export function toastSessionName(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const visible = Array.from(raw)
    .filter((char) => !isHiddenCodePoint(char.codePointAt(0)!))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!visible) return null;
  const chars = Array.from(visible);
  if (chars.length <= TOAST_SESSION_NAME_MAX) return visible;
  return (
    chars
      .slice(0, TOAST_SESSION_NAME_MAX - 1)
      .join("")
      .trimEnd() + "…"
  );
}

/**
 * The toast for one new own device. Only a non-empty `splitFrom` selects the
 * split copy: anything else gets the "Not you?" warning, the safe side.
 * @param entry The device's `ownDeviceAdded` entry
 * @returns The toast to show
 */
export function deviceToastFor(entry: DeviceToastEntry): DeviceToast {
  if (typeof entry.splitFrom === "string" && entry.splitFrom !== "")
    return { kind: "split" };
  return { kind: "added", sessionName: toastSessionName(entry.sessionName) };
}

/**
 * The entries of the bridge's `ownDeviceAdded` map not shown yet, recorded
 * as shown. Each device id shows once, whatever its entry later holds.
 * @param shown Device ids already shown (updated)
 * @param entries The map's entries, by device id
 * @returns The toasts to show, in map order
 */
export function takeNewDeviceToasts(
  shown: Set<string>,
  entries: Iterable<[string, DeviceToastEntry]>,
): DeviceToast[] {
  const fresh: DeviceToast[] = [];
  for (const [deviceId, entry] of entries) {
    if (shown.has(deviceId)) continue;
    shown.add(deviceId);
    fresh.push(deviceToastFor(entry));
  }
  return fresh;
}
