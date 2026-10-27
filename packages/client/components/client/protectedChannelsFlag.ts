/**
 * Protected channels: the server's feature advert (W4 lane A6, plan D13).
 *
 * The node advertises the feature in the root config route, `GET /`:
 *
 *   { features: { protected_channels: { enabled: bool, default_device_cap: u32 } } }
 *
 * (backend `crates/delta/src/routes/root.rs` `ProtectedChannelsFeature`;
 * `enabled` is already the effective value, i.e. false unless E2EE is on as
 * well; `default_device_cap` 0 means unlimited.)
 *
 * Fetched raw through `client.api.get("/")`. **Never read it from
 * `client.configuration`:** the controller pre-assigns a local stub there, so
 * the SDK never fetches `GET /` and the key would be absent for good (plan
 * F13).
 *
 * Parsing fails closed: an absent, malformed or failed advert is
 * `{ enabled: false, defaultDeviceCap: null }`. Unknown extra keys are
 * tolerated (additive server changes). The flag gates growth UI (protect,
 * adding seats) and KeyPackage pre-publish only (D12); it never gates the
 * shield, markers, refusals, decrypt, or sends to an existing Protected
 * channel, so "off" is always the safe answer here.
 *
 * Pure: no Solid / SDK runtime imports, loadable by `node --test`.
 */
import type { ProtectedChannelsFlag } from "./protectedTextTypes";

/** Largest value the server's `u32` can carry. */
const U32_MAX = 4_294_967_295;

/**
 * The part of the SDK client this module uses. The stoat.js `Client`
 * satisfies it (the spec pins that at compile time).
 */
export interface ProtectedFlagClient {
  readonly api: {
    get(path: "/"): Promise<unknown>;
  };
}

/** A fresh "off" flag (never a shared object a caller could mutate). */
function flagOff(): ProtectedChannelsFlag {
  return { enabled: false, defaultDeviceCap: null };
}

/** A non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse `features.protected_channels` from the root config.
 *
 * Well-formed means: a plain object whose `enabled` is a boolean and whose
 * `default_device_cap` is an integer in `0..=u32::MAX`. Anything else turns
 * the whole flag off; a valid `enabled: true` with a broken cap is still off.
 * @param raw The `features.protected_channels` value, as received
 * @returns The flag; `{ enabled: false, defaultDeviceCap: null }` when malformed
 */
export function parseProtectedChannelsFeature(
  raw: unknown,
): ProtectedChannelsFlag {
  if (!isRecord(raw)) return flagOff();

  const enabled = raw.enabled;
  if (typeof enabled !== "boolean") return flagOff();

  const cap = raw.default_device_cap;
  if (
    typeof cap !== "number" ||
    !Number.isInteger(cap) ||
    cap < 0 ||
    cap > U32_MAX
  ) {
    return flagOff();
  }

  return { enabled, defaultDeviceCap: cap };
}

/**
 * Fetch `GET /` and parse the protected channels advert. Never rejects: a
 * failed request, a non-object body or a missing key is the "off" flag.
 * @param client Anything with the SDK's `api.get("/")`
 * @returns The parsed flag
 */
export async function fetchProtectedChannelsFlag(
  client: ProtectedFlagClient,
): Promise<ProtectedChannelsFlag> {
  let body: unknown;
  try {
    body = await client.api.get("/");
  } catch {
    return flagOff();
  }

  if (!isRecord(body)) return flagOff();
  const features = body.features;
  if (!isRecord(features)) return flagOff();
  return parseProtectedChannelsFeature(features.protected_channels);
}
