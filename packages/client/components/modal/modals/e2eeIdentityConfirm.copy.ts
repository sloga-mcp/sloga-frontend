import type { IdentityConfirmOutcome } from "@revolt/client/e2ee";

/**
 * Pure decisions behind the "Verify security" and "Security identity
 * changed" modals, kept out of the components so they run under
 * `node --test` (lingui macros do not). Each component maps a notice to its
 * translated copy.
 *
 * On the native shells both "Mark as verified" and "Accept new identity"
 * open a system dialog the webview cannot draw, dismiss or answer; these
 * steps say what the modal does with its answer.
 */
export type IdentityConfirmNotice =
  /** Another system dialog is open, or a recent decline locked this prompt */
  | "busy"
  /** The keys shown in the system dialog are no longer the pinned ones */
  | "keys_changed";

/**
 * What the modal does next:
 * - `confirmed`: the native commit went through; do what the modal did on
 *   success before the system dialog existed (refetch, close when done);
 * - `stay`: keep the modal open with its buttons re-enabled, re-read the
 *   native state when `refetch` is set, and show `notice` inline (null =
 *   show nothing; a decline is silent);
 * - `error`: not one of ours, hand it to `showError` as before.
 */
export type IdentityConfirmStep =
  | { kind: "confirmed" }
  | { kind: "stay"; refetch: boolean; notice: IdentityConfirmNotice | null }
  | { kind: "error" };

const STAY_SILENT: IdentityConfirmStep = {
  kind: "stay",
  refetch: false,
  notice: null,
};

const STAY_BUSY: IdentityConfirmStep = {
  kind: "stay",
  refetch: false,
  notice: "busy",
};

// The device list on screen shows the keys native refused, so re-read it
// before the user looks again
const STAY_KEYS_CHANGED: IdentityConfirmStep = {
  kind: "stay",
  refetch: true,
  notice: "keys_changed",
};

/**
 * Map a resolved `markVerified` / `acceptIdentityChange` outcome to the
 * next step
 */
export function identityConfirmOutcomeStep(
  outcome: IdentityConfirmOutcome,
): IdentityConfirmStep {
  switch (outcome) {
    case "ok":
      return { kind: "confirmed" };
    // The user pressed Cancel on the system dialog: nothing was written
    // natively, so nothing changes here either. No refetch, no toast.
    case "declined":
      return STAY_SILENT;
    case "busy":
      return STAY_BUSY;
    case "keys_changed":
      return STAY_KEYS_CHANGED;
    default: {
      // A value outside the union means the bridge broke its contract, so
      // nothing proves the commit went through. Treating it as confirmed
      // would read as success (and closes the identity-change modal); keep
      // the modal open, silently, and let the user retry.
      const exhaustive: never = outcome;
      void exhaustive;
      return STAY_SILENT;
    }
  }
}

/**
 * Map a thrown `markVerified` / `acceptIdentityChange` error to the next
 * step.
 *
 * The contract resolves `declined`, `busy` and `keys_changed` instead of
 * throwing them. If one is thrown anyway (a bridge that kept the native
 * error) it must still never toast: matched on the `type` tag, as
 * `E2EEEnableGroup.copy.ts` does. Anything else is `error`, the loud
 * `showError` path.
 */
export function identityConfirmErrorStep(error: unknown): IdentityConfirmStep {
  if (typeof error !== "object" || error === null) return { kind: "error" };
  const native = error as { type?: unknown; field?: unknown };

  if (native.type === "declined") return STAY_SILENT;
  if (native.type === "busy") return STAY_BUSY;
  if (native.type === "invalid_argument" && native.field === "keys_changed") {
    return STAY_KEYS_CHANGED;
  }

  return { kind: "error" };
}

/**
 * Whether the modal re-reads the native state after this step: on success
 * (the device list changed) and when native refused stale keys. Never on a
 * decline (nothing changed) or a plain `busy`.
 */
export function identityConfirmRefetches(step: IdentityConfirmStep): boolean {
  switch (step.kind) {
    case "confirmed":
      return true;
    case "stay":
      return step.refetch;
    case "error":
      return false;
    default: {
      const exhaustive: never = step;
      void exhaustive;
      return false;
    }
  }
}

/**
 * Whether the verify modal offers "Mark as verified" for a device: only an
 * Active pin whose identity binding is signature-proven, the same condition
 * the native verify preview enforces before any dialog. An identity-changed
 * device goes through the accept path first, and a revoked one is gone.
 */
export function offersMarkVerified(device: {
  status: string;
  binding_verified: boolean;
}): boolean {
  return device.status === "active" && device.binding_verified === true;
}
