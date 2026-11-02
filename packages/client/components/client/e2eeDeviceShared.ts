/**
 * Durable "this app shares its encryption identity with another of your
 * apps" state (multi-device plan D5/D6). The bridge raises it after two
 * `held_elsewhere` claim refusals or a detected divergence; it must survive
 * a reload so the Settings card stays until the user splits or dismisses.
 *
 * Keyed by user AND device id: a split, a wipe or a different account on
 * the same install reads a different key, so a stale entry never applies.
 * Storage failures (disabled, sandboxed, quota) read as "nothing stored"
 * and writes are best effort.
 */

export type DeviceSharedState = {
  via: "held_elsewhere" | "diverged";
  at: number;
};

export type DeviceSharedStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function deviceSharedKey(userId: string, deviceId: string): string {
  return `sloga.e2ee.deviceShared.v1:${userId}:${deviceId}`;
}

/** The stored state, or null when absent, unreadable or malformed. */
export function readDeviceShared(
  storage: DeviceSharedStorage | null,
  userId: string,
  deviceId: string,
): DeviceSharedState | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(deviceSharedKey(userId, deviceId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return asDeviceShared(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeDeviceShared(
  storage: DeviceSharedStorage | null,
  userId: string,
  deviceId: string,
  state: DeviceSharedState,
): void {
  try {
    storage?.setItem(
      deviceSharedKey(userId, deviceId),
      JSON.stringify({ via: state.via, at: state.at }),
    );
  } catch {
    // Best effort: the in-memory signal still stands for this run.
  }
}

export function clearDeviceShared(
  storage: DeviceSharedStorage | null,
  userId: string,
  deviceId: string,
): void {
  try {
    storage?.removeItem(deviceSharedKey(userId, deviceId));
  } catch {
    // Best effort, as above.
  }
}

/**
 * The state to keep when `next` is raised over `current`: a refused claim
 * (`held_elsewhere`) outranks a divergence, and a standing state keeps its
 * original instant.
 */
export function mergeDeviceShared(
  current: DeviceSharedState | null | undefined,
  next: DeviceSharedState,
): DeviceSharedState {
  if (!current) return next;
  if (current.via === "diverged" && next.via === "held_elsewhere") return next;
  return current;
}

function asDeviceShared(value: unknown): DeviceSharedState | null {
  if (typeof value !== "object" || value === null) return null;
  const { via, at } = value as { via?: unknown; at?: unknown };
  if (via !== "held_elsewhere" && via !== "diverged") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { via, at };
}
