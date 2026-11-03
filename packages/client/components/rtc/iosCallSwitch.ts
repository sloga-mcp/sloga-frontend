/**
 * The server-side kill switch for encrypted calls on iPhone (plan D14, audit
 * M7). PURE and dependency-free so the rule is pinned by its own spec instead
 * of living in `state.tsx`, which `node --test` cannot load.
 *
 * WHY THIS EXISTS. Whether an iOS build can encrypt calls at all is decided
 * at build time. If a shipped iOS build turns out to be broken, this switch
 * lets the server put every iPhone back on honest, non-encrypted calls
 * without waiting on an App Store release. The server advertises it in the
 * root config route, `GET /`, as `features.ios_call_e2ee` (a boolean; an
 * older server omits it). {@link fetchIosCallSwitchValue} fetches that raw
 * value and the caller passes it to {@link iosCallSwitch} as `serverValue`.
 *
 * 🔴 Never read it from `client.configuration`. The controller assigns a
 * local stub there (`Controller.ts`), so the SDK never fetches `GET /` and
 * the key is absent for good: the switch would read "on" forever and could
 * never be turned off (Stage 5 B1; the same trap as
 * `components/client/protectedChannelsFlag.ts`, plan F13 there).
 *
 * THE RULES (each one is load-bearing; changing one is a design change):
 *
 * 1. GLOBAL for iOS. One server value for every iPhone. It is never per user
 *    and never per channel, so there is no user or channel input. Every other
 *    platform (`android`, `web`, the desktop shells) always reads "on": the
 *    switch does not exist for them.
 *
 * 2. Read ONCE, at call start. The caller snapshots the verdict when the call
 *    begins and keeps it for the life of that call. A config change mid-call
 *    takes effect on the next call, never by flipping a live call.
 *
 * 3. "off" only ever leads to a LOUD outcome. The caller feeds it into the
 *    readiness reason `"paused"` (`e2eeDeviceReadiness.ts`), which the chip
 *    and `VoiceCallDowngradeBanner.tsx` show to everyone in the call as a
 *    non-encrypted call. It never produces a quiet plaintext call and never
 *    releases the publish gate by itself.
 *
 * 4. ON when the value is absent or unreachable. Only a strict boolean
 *    `false` turns it off. `undefined` (an older server, a failed or not yet
 *    loaded config), `null`, the string `"false"`, `0`, and anything else all
 *    read "on". So a config the client cannot reach can never quietly turn
 *    encryption off. "on" means only "the server has not paused it": whether
 *    this build and device can actually encrypt is still decided by the
 *    shell and device checks (`iosMediaE2EEReady`), so the default is
 *    "on if built", never more than that.
 *
 * 5. Never reuses an earlier per-channel plaintext consent. A call moved to
 *    plaintext by this switch is its own loud state with its own reason; a
 *    "Turn off encryption" the user clicked in some earlier call (memory
 *    `feedback_mixed_call_plaintext_consent_per_rejoin`) must not carry over
 *    to make it quiet. This module's half of that rule: it reads only
 *    `platform` and `serverValue`, and has no consent input at all. The spec
 *    pins that it reads nothing else.
 *
 * 6. Does NOT ride `e2eeCallsEnabled`. That setting is folded into the shell
 *    term in `state.tsx` and would tell the user "encrypted calls aren't
 *    available on this device", which is false here. The switch has its own
 *    readiness reason and copy instead.
 */

export type IosCallSwitch = "on" | "off";

/**
 * The switch verdict for one call. `platform` is the Capacitor platform
 * string (`"ios"` on iPhone); `serverValue` is the raw
 * `features.ios_call_e2ee` value from {@link fetchIosCallSwitchValue}, or
 * `undefined` when the config is missing or unreachable.
 */
export function iosCallSwitch(input: {
  platform: string;
  serverValue: unknown;
}): IosCallSwitch {
  if (input.platform !== "ios") return "on";
  return input.serverValue === false ? "off" : "on";
}

/** How long call start waits for `GET /` before reading the switch ON. */
export const IOS_CALL_SWITCH_FETCH_TIMEOUT_MS = 3_000;

/** Largest delay a browser timer honours; anything above fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

export interface IosCallSwitchFetchDeps<H = unknown> {
  /** `GET /`: the root config body, as received. */
  fetchRoot: () => Promise<unknown>;
  setTimeout: (callback: () => void, ms: number) => H;
  clearTimeout: (handle: H) => void;
  /** Defaults to {@link IOS_CALL_SWITCH_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `body.features.ios_call_e2ee`, raw; `undefined` when not reachable. */
function switchValueFromRoot(body: unknown): unknown {
  try {
    if (!isRecord(body)) return undefined;
    const features = body.features;
    if (!isRecord(features)) return undefined;
    return features.ios_call_e2ee;
  } catch {
    // A throwing getter on a hostile or broken body is "unreachable".
    return undefined;
  }
}

/**
 * Fetch `GET /` and return the raw `features.ios_call_e2ee` value, for
 * {@link iosCallSwitch}'s `serverValue`. Bounded: waits at most `timeoutMs`
 * (default 3 s) so a slow or dead root route cannot stall call start.
 *
 * NEVER REJECTS. A throw (sync or async), a timeout, a non-object body, a
 * body without `features`, or a missing key all resolve `undefined`, which
 * reads ON (rule 4). The value is returned RAW, not coerced: only a strict
 * `false` may turn the switch off, and `iosCallSwitch` is the one place that
 * decides that.
 *
 * The timer functions are called unbound, so the window globals can be
 * passed straight in (a call through the deps bag would hand them
 * `this === deps`, which a browser rejects with "Illegal invocation").
 */
export function fetchIosCallSwitchValue<H>(
  deps: IosCallSwitchFetchDeps<H>,
): Promise<unknown> {
  const setTimer = deps.setTimeout;
  const clearTimer = deps.clearTimeout;
  const timeoutMs = deps.timeoutMs ?? IOS_CALL_SWITCH_FETCH_TIMEOUT_MS;
  // Written so NaN fails it too. An unusable bound is read as unreachable
  // (ON) rather than risking a wait that never ends.
  if (!(timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
    return Promise.resolve(undefined);
  }

  return new Promise<unknown>((resolve) => {
    let settled = false;
    let timer: { handle: H } | undefined;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      const pending = timer;
      timer = undefined;
      if (pending) {
        try {
          clearTimer(pending.handle);
        } catch {
          // A timer that cannot be cleared fires into a settled no-op.
        }
      }
      resolve(value);
    };

    let request: Promise<unknown>;
    try {
      request = Promise.resolve(deps.fetchRoot());
    } catch {
      finish(undefined);
      return;
    }
    // Handlers attached BEFORE the timer, so a late rejection after a
    // timeout (or after a timer failure) is never unhandled.
    request.then(
      (body) => finish(switchValueFromRoot(body)),
      () => finish(undefined),
    );

    try {
      timer = { handle: setTimer(() => finish(undefined), timeoutMs) };
    } catch {
      finish(undefined);
    }
  });
}

/**
 * Whether this call is OFFERED media encryption: the shell can do it
 * (`shellSupported`, the `shellMediaE2EESupported` predicate) AND the server
 * has not paused it. The ONE combined helper the call, the prejoin hook and
 * Settings all use, so the three can never disagree about whether a call
 * will be encrypted.
 *
 * 🔴 Not a readiness input. Its result must never be passed to
 * `callEncryptionReadiness` as `shellSupported`: the readiness takes the
 * shell term and `pausedByServer` SEPARATELY, so a paused iPhone reads
 * `"paused"` (its own loud copy) and never `"unsupported"`, which would tell
 * the user "encrypted calls aren't available on this device" (rule 6).
 */
export function callMediaE2EEOffered(
  shellSupported: boolean,
  sw: IosCallSwitch,
): boolean {
  return shellSupported === true && sw === "on";
}
