import { createResource } from "solid-js";

import type { E2EEBridge } from "@revolt/client";
import { useClient } from "@revolt/client";
import { useState } from "@revolt/state";

/**
 * Pre-join mode probe (slice 6.5 §3.4 / A3, judgment call 4). Answers "what
 * mode will THIS call use?" before joining, from a single cheap read-only probe
 * (`GET /mls/channels/<id>/open_group`) + local capability, with a process-wide
 * cache so the three pre-join surfaces (channel header, call card, channel
 * page) share ONE request per channel and a `feature_disabled` verdict stops
 * all probing (with `media_e2ee_enabled` FALSE for the whole slice, that means
 * zero steady-state traffic).
 *
 * `mode`:
 *  - "e2ee-open"   — the channel already has an open E2EE group (the call IS
 *                    encrypted). `full` when it is at the roster cap (A3).
 *  - "will-e2ee"   — no open group, but WE would negotiate E2EE (capable +
 *                    enrolled + toggle on).
 *  - "self-plain"  — the call is (or would be) E2EE but WE will join
 *                    unencrypted (web / toggle off / not enrolled) — the §0.2
 *                    #9 self-attribution.
 *  - "plain"       — a normal, non-E2EE call.
 */
export type PrejoinMode =
  | { mode: "e2ee-open"; memberCount: number; full: boolean }
  | { mode: "will-e2ee" }
  | { mode: "self-plain" }
  | { mode: "plain" };

/** A3(b) product cap mirror (client display only). */
const MAX_E2EE_CALL_MEMBERS = 100;

/** Process-wide probe cache (FE-11): channelId → result + timestamp. */
const cache = new Map<
  string,
  { at: number; value: { group_id: string; member_count: number } | null }
>();
const CACHE_TTL_MS = 10_000;
/** Once the server reports the feature off, stop probing entirely (FE-11). */
let featureOff = false;

/**
 * The reactive pre-join mode for a channel. `deps` supplies the channel id and
 * a version that bumps on voice-participant change so the probe refreshes.
 */
export function useCallPrejoinMode(
  deps: () => { channelId: string; version: number } | undefined,
) {
  const client = useClient();
  const state = useState();

  const [resource] = createResource(deps, async (input) => {
    const bridge = client()?.e2ee as E2EEBridge | undefined;
    // WE would negotiate encryption only when the shell can push keys AND the
    // device is enrolled AND "Encrypt my calls" is on (gate F4 — a toggle-OFF
    // desktop must classify `self-plain` for an open group, not `e2ee-open`:
    // it will join unencrypted and BE the downgrade cause, §0.2 #9).
    const wouldEncrypt =
      !!bridge?.nativeKeyPushAvailable() &&
      !!bridge.status.get("state")?.published &&
      state.voice.e2eeCallsEnabled;

    if (featureOff) {
      return classify(null, wouldEncrypt);
    }

    // Probe (cached). BRIDGE-INDEPENDENT (gate F4/FE-11): a plain
    // authenticated fetch against the API, so the WEB shell probes too and
    // can show the "you'll join unencrypted" self-attribution for an E2EE
    // call. 404 / feature-off / any error ⇒ null (a plain call).
    const cached = cache.get(input.channelId);
    let open: { group_id: string; member_count: number } | null;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      open = cached.value;
    } else {
      open = await probeOpenGroup(client(), input.channelId);
      cache.set(input.channelId, { at: Date.now(), value: open });
    }
    return classify(open, wouldEncrypt);
  });

  return resource;
}

/** Raw authenticated probe of `GET /mls/channels/<id>/open_group` — works on
 *  every shell (the desktop bridge's `mlsOpenGroup` is the same fetch). */
async function probeOpenGroup(
  client: ReturnType<ReturnType<typeof useClient>>,
  channelId: string,
): Promise<{ group_id: string; member_count: number } | null> {
  try {
    const [authHeader, authValue] = client.authenticationHeader;
    const response = await fetch(
      `${client.options.baseURL}/mls/channels/${channelId}/open_group`,
      { headers: { [authHeader]: authValue } },
    );
    if (!response.ok) return null;
    return (await response.json()) as {
      group_id: string;
      member_count: number;
    };
  } catch {
    return null;
  }
}

function classify(
  open: { group_id: string; member_count: number } | null,
  wouldEncrypt: boolean,
): PrejoinMode {
  if (open) {
    // The call IS E2EE. Either we join it encrypted, or (web/off/not enrolled)
    // we would be the downgrade cause.
    if (!wouldEncrypt) return { mode: "self-plain" };
    return {
      mode: "e2ee-open",
      memberCount: open.member_count,
      full: open.member_count >= MAX_E2EE_CALL_MEMBERS,
    };
  }
  return wouldEncrypt ? { mode: "will-e2ee" } : { mode: "plain" };
}

/** Mark the media-E2EE feature as off process-wide (called on a probe that
 *  returns feature_disabled — future probes short-circuit). Exposed for the
 *  bridge's probe to flag; a no-op today since `mlsOpenGroup` maps feature-off
 *  to null, but kept as the explicit hook FE-11 asks for. */
export function markMediaE2EEFeatureOff(): void {
  featureOff = true;
}
