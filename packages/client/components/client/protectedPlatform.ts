/**
 * Protected channels: which shells may run the text plane (S7 lane C4, plan
 * D9 / D10, RR-1, RR-6, Step 0 fold 1).
 *
 * W4 ran the text plane on the Tauri main window only. S7 adds Electron
 * (Linux) and Android, each behind a native capability AND the server's
 * protected-channels advert. The bridge (`e2ee.ts`, lane C3) cannot be
 * loaded under `node --test`, so every decision it needs here is a pure
 * function over facts it already holds:
 *
 * - `structuralState`: may this window run the text plane at all, and must
 *   the routing index be treated as NOT ready (hold) while an input is still
 *   unknown. A hold keeps MLS envelopes in the pre-index buffer; they never
 *   reach the call path for an id in the index.
 * - `reduceFlag`: the tri-state server flag (RR-1). Sticky on FAILED
 *   refreshes only; a successful `off` replaces an earlier `on`.
 * - `storeOwnerAllows`: the A8 store-owner check. Tauri keeps W4's latch
 *   (UNKNOWN is allowed); Electron and Android fail closed on UNKNOWN.
 * - `mapTextInvokeError`: `unavailable` from the 3 dialog commands is
 *   retryable, so it becomes `busy` (D7, no lockout).
 * - `protectedPlatformTag`: the one-line `[protected]` startup log. It
 *   starts with `PROTECTED_PLATFORM_MARKER`, which the dist check greps for.
 *
 * Every unexpected runtime value (a transport, probe state or flag outside
 * its type) answers the closed result.
 *
 * Pure module: no imports, no side effects, no key material, no user data.
 */

/** Grepped in the built bundle; keep this literal unchanged. */
export const PROTECTED_PLATFORM_MARKER = "sloga:s7-protected-platform:v1";

export type ShellTransportKind = "tauri" | "electron" | "capacitor" | "web";

/** The server's protected-channels advert as this bridge knows it. */
export type FlagState = "on" | "off" | "unknown";

/** What the Android plugin's `textCapability()` resolves. */
export type AndroidTextCapability = {
  protocol: number;
  listenerBridge: boolean;
};

/** The Android `textCapability()` probe, awaited once per bridge. */
export type AndroidProbe =
  | { state: "pending" }
  | { state: "failed" }
  | { state: "ok"; value: AndroidTextCapability };

/** `#checkStoreOwner`'s result: unknown until it completes. */
export type StoreOwnerCheck =
  | { state: "unknown" }
  | { state: "known"; owner: string | null };

/** The inputs of `structuralState`, every one a fact the bridge holds. */
export interface StructuralInput {
  transport: ShellTransportKind;
  /** `Capacitor.getPlatform()`, or "" off Capacitor. */
  platform: string;
  /** `slogaShell.e2ee.protectedText`; undefined when the shell lacks it. */
  electronProtocol: number | undefined;
  /** The Android probe; null off Android. */
  androidProbe: AndroidProbe | null;
  popout: boolean;
  overlay: boolean;
  flag: FlagState;
}

/** The only text-plane protocol this client speaks. */
const TEXT_PROTOCOL = 1;

/** Not structural: today's call path, byte for byte. */
function closed(): { structural: boolean; hold: boolean } {
  return { structural: false, hold: false };
}

/** A new shell whose native side is capable: the flag decides. */
function byFlag(flag: FlagState): { structural: boolean; hold: boolean } {
  switch (flag) {
    case "on":
      return { structural: true, hold: false };
    case "unknown":
      return { structural: true, hold: true };
    case "off":
      return closed();
    default: {
      const exhaustive: never = flag;
      void exhaustive;
      return closed();
    }
  }
}

/** The Android leg: iOS, a missing / failed / foreign probe are closed. */
function androidState(i: StructuralInput): {
  structural: boolean;
  hold: boolean;
} {
  if (i.platform !== "android") return closed();
  const probe = i.androidProbe;
  if (probe === null || typeof probe !== "object") return closed();
  switch (probe.state) {
    case "pending":
      return { structural: true, hold: true };
    case "failed":
      return closed();
    case "ok":
      if (
        probe.value?.protocol !== TEXT_PROTOCOL ||
        probe.value.listenerBridge !== true
      ) {
        return closed();
      }
      return byFlag(i.flag);
    default: {
      const exhaustive: never = probe;
      void exhaustive;
      return closed();
    }
  }
}

/**
 * Plan D9: may this window run the text plane, and is routing on hold.
 * - popout or overlay: closed;
 * - tauri: structural, never held, the flag is NOT consulted (W4);
 * - electron: `protectedText === 1`, then the flag;
 * - capacitor: Android only; a pending probe holds, a failed one is closed,
 *   an ok one needs protocol 1 and the WebMessageListener bridge, then the
 *   flag;
 * - web: closed.
 *
 * The flag: `on` structural, `unknown` structural + hold, `off` closed.
 * `hold` is never true while `structural` is false.
 * @param i The bridge's current facts
 * @returns `{ structural, hold }`
 */
export function structuralState(i: StructuralInput): {
  structural: boolean;
  hold: boolean;
} {
  if (i.popout || i.overlay) return closed();
  switch (i.transport) {
    case "tauri":
      return { structural: true, hold: false };
    case "electron":
      if (i.electronProtocol !== TEXT_PROTOCOL) return closed();
      return byFlag(i.flag);
    case "capacitor":
      return androidState(i);
    case "web":
      return closed();
    default: {
      const exhaustive: never = i.transport;
      void exhaustive;
      return closed();
    }
  }
}

/** An event in the flag's life within one bridge. */
export type FlagEvent =
  | { kind: "seed"; value: "on" | "off" | null }
  | { kind: "fetch_ok"; enabled: boolean }
  | { kind: "fetch_failed" }
  | { kind: "timeout" };

/**
 * The tri-state flag reducer (RR-1, Final scoped look 4/5).
 * - `seed`: the persisted last-known value; none is `unknown`.
 * - `fetch_ok`: the server's answer wins, so `off` replaces `on`.
 * - `fetch_failed`: unchanged (a known `on` stays `on`).
 * - `timeout`: `unknown` becomes `off`; a known value stays.
 * @param prev The current state
 * @param ev What happened
 * @returns The next state
 */
export function reduceFlag(prev: FlagState, ev: FlagEvent): FlagState {
  switch (ev.kind) {
    case "seed":
      if (ev.value === "on") return "on";
      if (ev.value === "off") return "off";
      return "unknown";
    case "fetch_ok":
      return ev.enabled === true ? "on" : "off";
    case "fetch_failed":
      return prev;
    case "timeout":
      return prev === "unknown" ? "off" : prev;
    default: {
      const exhaustive: never = ev;
      void exhaustive;
      return prev;
    }
  }
}

/**
 * The A8 store-owner condition of `protectedTextCapable()` (Step 0 fold 1).
 * - tauri: W4's latch; only a KNOWN foreign owner refuses.
 * - electron / capacitor: the check must have completed with this account
 *   or no owner (fresh store); UNKNOWN is not capable.
 * - web: never.
 * @param transport The bridge's transport
 * @param check The store-owner check for this bridge
 * @param userId The signed-in user's id; null while unknown
 * @returns Whether the store owner allows the text plane
 */
export function storeOwnerAllows(
  transport: ShellTransportKind,
  check: StoreOwnerCheck,
  userId: string | null,
): boolean {
  switch (transport) {
    case "tauri":
      return !(
        check.state === "known" &&
        check.owner !== null &&
        check.owner !== userId
      );
    case "electron":
    case "capacitor":
      return (
        check.state === "known" &&
        (check.owner === null || check.owner === userId)
      );
    case "web":
      return false;
    default: {
      const exhaustive: never = transport;
      void exhaustive;
      return false;
    }
  }
}

/** The text commands that open a native dialog (D2 / D7). */
const DIALOG_COMMANDS: readonly string[] = [
  "e2ee_text_seat_list_sign",
  "e2ee_text_owner_confirm_change",
  "e2ee_text_owner_handover_sign",
];

/**
 * D7: a dialog command that could not show its prompt (`unavailable`) is
 * retryable, never a lockout, so `#textInvoke` sees `busy`. Every other
 * error, and every error from another command, passes through unchanged.
 * @param command The text command that failed
 * @param err What native rejected with
 * @returns The error `#textInvoke` rejects with
 */
export function mapTextInvokeError(command: string, err: unknown): unknown {
  if (!DIALOG_COMMANDS.includes(command)) return err;
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: unknown }).type === "unavailable"
  ) {
    return { type: "busy" };
  }
  return err;
}

/** The probe as a token for the tag. */
function probeToken(probe: AndroidProbe | null): string {
  if (probe === null || typeof probe !== "object") return "none";
  if (probe.state !== "ok") return String(probe.state);
  return `ok/protocol=${String(probe.value?.protocol)}/listener=${String(
    probe.value?.listenerBridge,
  )}`;
}

/**
 * The one-line startup tag `e2ee.ts` logs once per bridge with the
 * `[protected]` prefix. Platform facts and the verdict only; no ids.
 * @param i The bridge's current facts
 * @returns A string starting with `PROTECTED_PLATFORM_MARKER`
 */
export function protectedPlatformTag(i: StructuralInput): string {
  const { structural, hold } = structuralState(i);
  return (
    `${PROTECTED_PLATFORM_MARKER}` +
    ` transport=${String(i.transport)}` +
    ` platform=${i.platform === "" ? "-" : String(i.platform)}` +
    ` electronProtocol=${String(i.electronProtocol)}` +
    ` probe=${probeToken(i.androidProbe)}` +
    ` popout=${String(i.popout)}` +
    ` overlay=${String(i.overlay)}` +
    ` flag=${String(i.flag)}` +
    ` structural=${String(structural)}` +
    ` hold=${String(hold)}`
  );
}
