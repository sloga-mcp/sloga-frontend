/**
 * Protected channels: the server's feature advert (W4 lane A6, plan D13).
 *
 * The node advertises the feature in the root config route, `GET /`:
 *
 *   { features: { protected_channels: {
 *       enabled: bool, default_device_cap: u32, formats_v2: bool,
 *       history_setting: bool, ios: bool } } }
 *
 * (backend `crates/delta/src/routes/root.rs` `ProtectedChannelsFeature`;
 * `enabled` is already the effective value, i.e. false unless E2EE is on as
 * well; `default_device_cap` 0 means unlimited; `formats_v2` (S2) is the
 * configured value, advertised even with growth off, and absent on an S1
 * server; `history_setting` (S4) is the configured value too, not tied to
 * `enabled` or `formats_v2` by the server, and absent before S4; `ios` is
 * not read here.)
 *
 * Fetched raw through `client.api.get("/")`. **Never read it from
 * `client.configuration`:** the controller pre-assigns a local stub there, so
 * the SDK never fetches `GET /` and the key would be absent for good (plan
 * F13).
 *
 * Parsing fails closed: an absent, malformed or failed advert is
 * `{ enabled: false, defaultDeviceCap: null, formatsV2: false,
 * historySetting: false }`. Unknown extra keys are tolerated (additive
 * server changes). The flag gates growth UI (protect, adding seats),
 * KeyPackage pre-publish (D12) and, through `historySetting`, the S4 history
 * writes and controls (R-W4-9); it never gates the shield, markers,
 * refusals, decrypt, or sends to an existing Protected channel, so "off" is
 * always the safe answer here.
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
  return {
    enabled: false,
    defaultDeviceCap: null,
    formatsV2: false,
    historySetting: false,
  };
}

/** Set once the unusable history advert was logged (one line per load). */
let historyWithoutV2Logged = false;

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
 *
 * `formats_v2` is read on its own (OR-12): only the boolean `true` is true.
 * Absent (an S1 server) or malformed is `false`, and it never turns the
 * flag off or changes `enabled` / `defaultDeviceCap`. A malformed advert
 * stays fully off whatever `formats_v2` says.
 *
 * `history_setting` (S4) is read the same strict way and moves none of the
 * other three fields. `historySetting` is true only when the server says
 * `true` AND `enabled` AND `formatsV2` are both true: a history setting is
 * a v2 list field, so without v2 the client could not sign one, and with
 * growth off nothing is offered. The server advertises the three keys
 * independently, so `history_setting` without `formats_v2` can really
 * arrive; that case is logged once.
 * @param raw The `features.protected_channels` value, as received
 * @returns The flag; all off when malformed
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

  // Strict: "true", 1 or an object is not `true`; never a reason to go off.
  const formatsV2 = raw.formats_v2 === true;

  // Strict again; malformed or absent is false and nothing else moves.
  const advertised = raw.history_setting === true;
  const historySetting = advertised && enabled && formatsV2;
  if (advertised && !formatsV2 && !historyWithoutV2Logged) {
    historyWithoutV2Logged = true;
    console.warn(
      "[protected] the server advertises history_setting without formats_v2: the history setting stays off",
    );
  }

  return { enabled, defaultDeviceCap: cap, formatsV2, historySetting };
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
