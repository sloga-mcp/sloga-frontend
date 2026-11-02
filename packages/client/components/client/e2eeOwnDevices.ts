/**
 * The "Your devices" list and device-removal counts (multi-device plan D7).
 * Pure, so `node --test` covers it. Input is the server's OWN-account
 * `GET /e2ee/devices/{self}` listing, which is unsigned display data: the
 * view never feeds a trust decision.
 */

export type OwnDeviceView = {
  deviceId: string;
  isThisDevice: boolean;
  sessionName: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
  /** Never claimed after its first publication (an orphan, D5 crash). */
  neverSeen: boolean;
};

/** A device last seen within this long of its creation counts as never seen. */
export const NEVER_SEEN_WINDOW_MS = 60_000;

/**
 * `remaining_devices` from `DELETE /e2ee/keys/{id}`: the account's device
 * count after the delete. Null for anything but a non-negative integer,
 * including an old server's empty 204, so a caller that clears the
 * account-wide opt-in flag at 0 keeps it on every doubt.
 */
export function parseRemainingDevices(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { remaining_devices?: unknown }).remaining_devices;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * True when the device was never seen after it was created: no last-seen
 * time, or one within `NEVER_SEEN_WINDOW_MS` of its creation. A missing or
 * unparseable creation time compares as NaN, so it is not "never seen".
 */
export function isNeverSeen(
  createdAt: string | null,
  lastSeenAt: string | null,
): boolean {
  if (lastSeenAt == null) return true;
  const created = createdAt == null ? NaN : Date.parse(createdAt);
  return Date.parse(lastSeenAt) - created <= NEVER_SEEN_WINDOW_MS;
}

/** The listing row's `session_name` for one device, or null. */
export function sessionNameOf(
  listing: unknown,
  deviceId: string,
): string | null {
  if (!Array.isArray(listing)) return null;
  for (const row of listing) {
    if (stringField(row, "device_id") === deviceId) {
      return stringField(row, "session_name");
    }
  }
  return null;
}

/**
 * Map the own listing to views: this device first, then the rest newest
 * first by `created_at` (unknown creation times last). Rows without a
 * string `device_id` are dropped, and so is a repeated id.
 */
export function toOwnDeviceViews(
  listing: unknown,
  myDeviceId: string | null,
): OwnDeviceView[] {
  if (!Array.isArray(listing)) return [];
  const seen = new Set<string>();
  const views: OwnDeviceView[] = [];
  for (const row of listing) {
    const deviceId = stringField(row, "device_id");
    if (!deviceId || seen.has(deviceId)) continue;
    seen.add(deviceId);
    const createdAt = stringField(row, "created_at");
    const lastSeenAt = stringField(row, "last_seen_at");
    views.push({
      deviceId,
      isThisDevice: deviceId === myDeviceId,
      sessionName: stringField(row, "session_name"),
      createdAt,
      lastSeenAt,
      neverSeen: isNeverSeen(createdAt, lastSeenAt),
    });
  }
  return views.sort((a, b) => {
    if (a.isThisDevice !== b.isThisDevice) return a.isThisDevice ? -1 : 1;
    const newer = createdTime(b);
    const older = createdTime(a);
    if (newer === older) return 0;
    return newer > older ? 1 : -1;
  });
}

function createdTime(view: OwnDeviceView): number {
  const time = view.createdAt == null ? NaN : Date.parse(view.createdAt);
  return Number.isNaN(time) ? -Infinity : time;
}

function stringField(row: unknown, key: string): string | null {
  if (typeof row !== "object" || row === null) return null;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}
