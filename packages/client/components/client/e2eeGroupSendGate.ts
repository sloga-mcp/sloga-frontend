/**
 * The group send gate for a device with no record of the group (the
 * `group_unconfirmed` / `group_unestablished` verdicts of
 * `e2ee_send_mode_group`) — pure and dependency-free so `node --test` can
 * load it (the house no-vitest split). `e2ee.ts` owns the native calls, the
 * device-listing fetches and the cache; this module only decides.
 *
 * Why this exists: a group row is created only by enabling the group here,
 * an inbound `group_enable`, or a backup restore. A new own device, a wiped
 * store, or a device that missed `group_enable` used to get a plain
 * `plaintext` verdict for an ENCRYPTED group, and the send fell through to
 * an ordinary plaintext POST: a leak and a silent non-delivery at once. The
 * native layer now reports that case as `group_unconfirmed` (no evidence) or
 * `group_unestablished` (encrypted traffic for the group reached this
 * device), and nothing here maps either one to a send without consent —
 * except an unconfirmed group the server listings PROVE nobody encrypts.
 *
 * Threat model: this protects an honest server combined with client state
 * loss. A malicious server can still pass the proof for a fresh device
 * (empty listings, withheld `group_enable`); only local pinned state resists
 * that, and a fresh device has none. Server-sourced signals only ever skip a
 * prompt — they never touch an existing row (a row always wins natively).
 *
 * Every malformed input fails CLOSED: an unknown verdict is "invalid" (the
 * caller throws), a malformed listing counts as "has devices", and a clock
 * or budget that cannot be compared decides "not_proven".
 */

/** Whether server listings prove no other party to the group has E2EE. */
export type PlaintextProof = "proven" | "not_proven";

export type GroupSendDecision =
  | "plaintext"
  | "encrypt"
  | "confirm_unconfirmed"
  | "confirm_unestablished"
  | "blocked"
  | "peer_downgraded"
  | "invalid";

/** How long a device listing result may stand in for a fresh fetch. */
export const PROOF_TTL_MS = 300_000;

/**
 * Most listings one proof may fetch. A larger group is not worth the
 * request budget: it decides "not_proven" and the user confirms once.
 */
export const MAX_UNCACHED_LISTINGS = 40;

/** Listings the proof may spend per 10 s rate-limit window. */
export const PROBE_WINDOW_CAP = 30;

/** One user's listing result; errors are never cached (no entry written). */
export type ProofCacheEntry = { hasDevices: boolean; at: number };

export type ProofCache = ReadonlyMap<string, ProofCacheEntry>;

/**
 * The verdict's `mode`, or null when the verdict is not a plain object
 * carrying an OWN string `mode` (an inherited `mode` is not the native
 * answer, and a throwing getter is not a verdict).
 */
function modeOf(verdict: unknown): string | null {
  if (typeof verdict !== "object" || verdict === null) return null;
  if (Array.isArray(verdict)) return null;
  try {
    if (!Object.prototype.hasOwnProperty.call(verdict, "mode")) return null;
    const mode = (verdict as { mode?: unknown }).mode;
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}

/**
 * What a group send may do with this native verdict. `group_unconfirmed`
 * sends plaintext only with a "proven" proof; `group_unestablished` always
 * asks (the device has seen encrypted traffic, so no listing can prove the
 * group is unencrypted). Anything unrecognized is "invalid", never a send.
 */
export function groupSendDecision(
  verdict: unknown,
  proof: PlaintextProof | null,
): GroupSendDecision {
  switch (modeOf(verdict)) {
    case "plaintext":
      return "plaintext";
    case "encrypt":
      return "encrypt";
    case "blocked":
      return "blocked";
    case "peer_downgraded":
      return "peer_downgraded";
    case "group_unconfirmed":
      return proof === "proven" ? "plaintext" : "confirm_unconfirmed";
    case "group_unestablished":
      return "confirm_unestablished";
    default:
      return "invalid";
  }
}

/**
 * Where a group's history comes from. A rowless group (both new verdicts)
 * has no local transcript to restore, so its history is the server's — the
 * same as a plaintext group. Everything else, unknown verdicts included,
 * stays on the local store (never pulls server plaintext into a
 * conversation that may be encrypted).
 */
export function historySource(verdict: unknown): "server" | "local" {
  switch (modeOf(verdict)) {
    case "plaintext":
    case "group_unconfirmed":
    case "group_unestablished":
      return "server";
    default:
      return "local";
  }
}

/**
 * Whether one user's device listing shows an E2EE device. For our own user
 * the listing includes this device, which says nothing about the group, so
 * it is filtered out by `selfDeviceId` (unknown → any device counts). A
 * listing that is not an array counts as "has devices".
 */
export function listingHasDevices(
  userId: string,
  selfId: string,
  selfDeviceId: string | null,
  listing: readonly { device_id: string }[],
): boolean {
  if (!Array.isArray(listing)) return true;
  if (userId !== selfId || selfDeviceId === null) return listing.length > 0;
  return listing.some((device) => device?.device_id !== selfDeviceId);
}

/**
 * Plans the plaintext proof for an unconfirmed group: decide from the
 * advertised flags and the cache when they suffice, otherwise name the
 * listings to fetch — all of them or none (a partial fetch spends budget
 * and can never prove anything).
 *
 * `advertised` is the cached `User.e2eeEnabled` hint. It short-circuits for
 * OTHER members only; our own flag is set by this device's enrollment and
 * says nothing about our other devices. An entry is fresh while
 * `0 <= now - at < PROOF_TTL_MS`; one dated in the future (the clock moved
 * back) is refetched rather than trusted for longer than the TTL.
 */
export function planProof(input: {
  selfId: string;
  selfDeviceId: string | null;
  otherIds: readonly string[];
  advertised: ReadonlySet<string>;
  cache: ProofCache;
  now: number;
  windowBudget: number;
}): { decided: PlaintextProof } | { fetch: string[] } {
  const { selfId, cache, now } = input;
  if (input.selfDeviceId === null) return { decided: "not_proven" };

  const others = [...new Set(input.otherIds)].filter((id) => id !== selfId);
  if (others.some((id) => input.advertised.has(id))) {
    return { decided: "not_proven" };
  }

  const uncached: string[] = [];
  for (const id of [selfId, ...others]) {
    const entry = cache.get(id);
    const elapsed = entry ? now - entry.at : NaN;
    if (entry && elapsed >= 0 && elapsed < PROOF_TTL_MS) {
      if (entry.hasDevices) return { decided: "not_proven" };
    } else {
      uncached.push(id);
    }
  }

  if (!uncached.length) return { decided: "proven" };
  // Written so a NaN budget also refuses (a comparison with NaN is false).
  if (
    !(uncached.length <= MAX_UNCACHED_LISTINGS) ||
    !(uncached.length <= input.windowBudget)
  ) {
    return { decided: "not_proven" };
  }
  return { fetch: uncached };
}
