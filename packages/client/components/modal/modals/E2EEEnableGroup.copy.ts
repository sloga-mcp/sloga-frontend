import type { GroupGrowthOutcome } from "@revolt/client/e2ee";

/**
 * Pure decisions behind the "Encrypt this group" modal, kept out of the
 * component so they run under `node --test` (lingui macros do not). The
 * component maps each notice to its translated copy.
 *
 * The notice names are the native tags they come from, so a reader can
 * trace each one back to the refusal that produced it.
 */
export type EnableGroupNotice =
  /** Another growth dialog is open, or a decline locked this group's prompt */
  | "busy"
  /** The member set changed while the system dialog was open */
  | "roster_changed"
  /** Enable on an already-encrypted group with a different roster (D1) */
  | "roster_mismatch"
  /** This device is not an active member of the group's encryption */
  | "self_user_id"
  /** This install's E2EE store is enrolled to another account */
  | "mls_store_owned_by_another_account";

/**
 * What the modal does next:
 * - `close`: encryption is on;
 * - `stay`: keep the modal open with the button re-enabled, showing
 *   `notice` inline (null = show nothing; a decline is silent);
 * - `error`: not one of ours, hand it to `showError` as before.
 */
export type EnableGroupStep =
  | { kind: "close" }
  | { kind: "stay"; notice: EnableGroupNotice | null }
  | { kind: "error" };

const STAY_SILENT: EnableGroupStep = { kind: "stay", notice: null };

/** Map a resolved `enableGroupEncryption` outcome to the next step */
export function enableGroupOutcomeStep(
  outcome: GroupGrowthOutcome,
): EnableGroupStep {
  switch (outcome) {
    case "ok":
      return { kind: "close" };
    // The user pressed Cancel on the system dialog: nothing was written
    // natively, so nothing changes here either. No toast.
    case "declined":
      return STAY_SILENT;
    case "busy":
      return { kind: "stay", notice: "busy" };
    default: {
      // A value outside the union means the bridge broke its contract, so
      // nothing proves the enable went through. Closing would read as
      // success; keep the modal open, silently, and let the user retry
      // (a confirmed enable with the same roster resumes natively).
      const exhaustive: never = outcome;
      void exhaustive;
      return STAY_SILENT;
    }
  }
}

/** The `invalid_argument` fields this modal explains inline */
const INLINE_FIELDS = new Set<string>([
  "roster_changed",
  "roster_mismatch",
  "self_user_id",
]);

/**
 * Map a thrown `enableGroupEncryption` error to the next step.
 *
 * Errors cross the IPC seam as `type`-tagged objects (`#rethrow` parses the
 * Capacitor JSON back into one), so the tag is matched, as
 * `E2EEGroupPlaintextConfirm`'s `isStateChanged` does. Anything unrecognised
 * is `error`: the modal keeps today's loud `showError` path.
 */
export function enableGroupErrorStep(error: unknown): EnableGroupStep {
  if (typeof error !== "object" || error === null) return { kind: "error" };
  const native = error as { type?: unknown; field?: unknown };

  // The contract resolves these two instead of throwing. If one is thrown
  // anyway it must still never toast: a decline is silent.
  if (native.type === "declined") return STAY_SILENT;
  if (native.type === "busy") return { kind: "stay", notice: "busy" };

  if (
    native.type === "invalid_argument" &&
    typeof native.field === "string" &&
    INLINE_FIELDS.has(native.field)
  ) {
    return {
      kind: "stay",
      notice: native.field as EnableGroupNotice,
    };
  }

  // Matched on the tag alone. `storeOwnerMismatch` (rtc/e2eeStoreOwner.ts)
  // also requires both ids because it guards a destructive reset; this
  // notice shows no id and offers no action.
  if (native.type === "mls_store_owned_by_another_account") {
    return { kind: "stay", notice: "mls_store_owned_by_another_account" };
  }

  return { kind: "error" };
}

/**
 * The label a member is listed under: `username#discriminator` (unique on
 * the server, so harder to impersonate than a display name), else the bare
 * username, else a short id.
 */
export function memberLabel(
  id: string,
  user?: { username?: string; discriminator?: string } | null,
): string {
  const username = user?.username;
  if (!username) return id.slice(0, 8);
  return user?.discriminator ? `${username}#${user.discriminator}` : username;
}
