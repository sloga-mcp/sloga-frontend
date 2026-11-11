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
 * The first `held_elsewhere` refusal for a (user, device), kept across
 * connections and reloads: a twin that reconnects inside the in-connection
 * retry window resets its per-connection strikes, so only this instant
 * lets a later refusal count as the second. Same keying and failure rules
 * as the state above.
 */
export function heldStrikeKey(userId: string, deviceId: string): string {
  return `sloga.e2ee.heldStrike.v1:${userId}:${deviceId}`;
}

/** When the first refusal was seen, or null when absent or malformed. */
export function readHeldStrike(
  storage: DeviceSharedStorage | null,
  userId: string,
  deviceId: string,
): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(heldStrikeKey(userId, deviceId));
    if (raw === null) return null;
    const at = (JSON.parse(raw) as { at?: unknown } | null)?.at;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

export function writeHeldStrike(
  storage: DeviceSharedStorage | null,
  userId: string,
  deviceId: string,
  at: number,
): void {
  try {
    storage?.setItem(heldStrikeKey(userId, deviceId), JSON.stringify({ at }));
  } catch {
    // Best effort: the in-memory first strike still counts this run.
  }
}

export function clearHeldStrike(
  storage: DeviceSharedStorage | null,
  userId: string,
  deviceId: string,
): void {
  try {
    storage?.removeItem(heldStrikeKey(userId, deviceId));
  } catch {
    // Best effort, as above.
  }
}

/**
 * Sticky "this device was shared" record for a (user, device): written
 * whenever `deviceShared` is raised and kept through "Not now" and accepted
 * claims, because the other install can still be using the device after
 * this one wins the claim again. Only a split (ours, or the twin leaving)
 * or a wipe ends it. Same keying and failure rules as above.
 */
export function wasSharedKey(userId: string, deviceId: string): string {
  return `sloga.e2ee.wasShared.v1:${userId}:${deviceId}`;
}

export function readWasShared(
  storage: DeviceSharedStorage | null,
  userId: string,
  deviceId: string,
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(wasSharedKey(userId, deviceId));
    if (raw === null) return false;
    const at = (JSON.parse(raw) as { at?: unknown } | null)?.at;
    return typeof at === "number" && Number.isFinite(at);
  } catch {
    return false;
  }
}

export function writeWasShared(
  storage: DeviceSharedStorage | null,
  userId: string,
  deviceId: string,
  at: number,
): void {
  try {
    storage?.setItem(wasSharedKey(userId, deviceId), JSON.stringify({ at }));
  } catch {
    // Best effort: the in-memory record still holds for this run.
  }
}

export function clearWasShared(
  storage: DeviceSharedStorage | null,
  userId: string,
  deviceId: string,
): void {
  try {
    storage?.removeItem(wasSharedKey(userId, deviceId));
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
