/**
 * How a native rejection on the Capacitor seam reaches its caller, and the
 * one call-plane mapping on top of it (iOS call E2EE phase 2: plan D10, W3
 * MUST 3, ruling R14). Pure and dependency-free apart from the protector
 * copy, so `node --test` can load it; CapacitorTransport's `#rethrow` in
 * `e2ee.ts` only calls `nativeRejectError`.
 *
 * Both plugins (Android `E2eePlugin.kt`, iOS `E2eePlugin.swift`) reject with
 * the core's scrubbed error JSON as the message (`{"type": ...}`), so the
 * page gets back the SAME typed objects the desktop IPC rejects with. That
 * `type` must survive the trip intact: `mlsCallSession` decides what a failed
 * `callConfirmDowngrade` means from `type === "declined"` alone (R14), and on
 * iOS a `declined` there also covers a dialog that could not be shown.
 */
import { protectorSendErrorCopy } from "./e2eeProtectorCopy.ts";

/**
 * The MLS call-plane commands, as the iOS command table routes them
 * (`E2eeCommands.swift`): the 22 `.call` names, which run on the separate
 * call worker, plus `e2ee_call_confirm_downgrade`, which has its own plugin
 * method. `e2eeCallPlaneIos.test.ts` checks this list against that table.
 */
export const CALL_PLANE_COMMANDS: ReadonlySet<string> = new Set([
  "e2ee_call_create",
  "e2ee_call_join_intent",
  "e2ee_call_verify_join_intent",
  "e2ee_call_admit",
  "e2ee_call_process",
  "e2ee_call_commit_won",
  "e2ee_call_commit_lost",
  "e2ee_call_pending_commit_epoch",
  "e2ee_call_leave_cleanup",
  "e2ee_call_local_groups",
  "e2ee_call_heartbeat",
  "e2ee_call_remove",
  "e2ee_call_state",
  "e2ee_call_roster_identities",
  "e2ee_call_frame_keys",
  "e2ee_call_announce",
  "e2ee_call_clear_downgrade",
  "e2ee_call_non_enrolled",
  "e2ee_pin_call_identities",
  "e2ee_mls_publish_key_packages",
  "e2ee_mls_replenish",
  "e2ee_mls_expire_key_packages",
  "e2ee_call_confirm_downgrade",
]);

export function isCallPlaneCommand(command: string): boolean {
  return CALL_PLANE_COMMANDS.has(command);
}

/**
 * A call-plane command failed because the phone is locked: the iOS keychain
 * item that seals the store is `WhenUnlockedThisDeviceOnly`, and the core
 * rejects `{ type: "protector_locked" }` while it cannot be read (plan D10).
 * The store is intact. The call must not carry on as if encrypted: the
 * session's existing failure paths (a failed join, a latched loud error, a
 * drain step that is retried and never acked) take it, and this error gives
 * them readable copy (`e2eeProtectorCopy.ts`) instead of a bare tag. `type`
 * stays `"protector_locked"`, so every `type` check downstream
 * (`classifyEnvelopeError`, the R14 decline check) reads it exactly as it
 * read the plain object.
 */
export class CallProtectorLockedError extends Error {
  readonly type = "protector_locked" as const;

  constructor(message: string) {
    super(message);
    this.name = "CallProtectorLockedError";
  }
}

/**
 * The plugin rejection as the typed object its message carries, or the
 * original error when the message is not a JSON object with a `type`
 * (a Capacitor "not implemented", a transport failure).
 */
export function parseNativeReject(error: unknown): unknown {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string" || !message.startsWith("{")) return error;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return error;
  }
  return parsed !== null && typeof parsed === "object" && "type" in parsed
    ? parsed
    : error;
}

/**
 * What CapacitorTransport throws for a rejected `command`: the parsed typed
 * object, except that a call-plane command rejected `protector_locked`
 * becomes a `CallProtectorLockedError`. Every other command keeps the plain
 * object, because the text send paths read their own locked-phone copy from
 * it and `protectorSendErrorCopy` ignores Error instances. Plain `protector`
 * is left as it is on every command: it is not specific to a locked phone,
 * and the desktop and Android shells produce it too.
 *
 * @param command The `e2ee_*` name, or undefined for a plugin method that
 *   carries none (attachment transfer, backup dialogs).
 * @param platform `Capacitor.getPlatform()`, for the copy.
 */
export function nativeRejectError(
  command: string | undefined,
  error: unknown,
  platform: string,
): unknown {
  const parsed = parseNativeReject(error);
  if (command === undefined || !isCallPlaneCommand(command)) return parsed;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Object.prototype.toString.call(parsed) === "[object Error]" ||
    (parsed as { type?: unknown }).type !== "protector_locked"
  ) {
    return parsed;
  }
  const copy = protectorSendErrorCopy(parsed, platform);
  return copy === null ? parsed : new CallProtectorLockedError(copy);
}
