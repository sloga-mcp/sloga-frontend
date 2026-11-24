/**
 * Protected channels S4: what the bridge (`e2ee.ts`) does with the history
 * policy the text manager reports, and how it reads the text section of a
 * backup result.
 *
 * The policy half decides the ONE thing in the app that lets a plaintext
 * row of a protected channel render with its server text: the verified
 * reveal (`Client.revealPreProtectRows`, R-W4-3). A reveal is set only when
 * the manager says the policy is verified, the boundary is a well-formed
 * ULID, `pre_history` is `kept`, a usable time limit exists, the local pin
 * agrees and the channel is neither conflicted nor wiped. Everything else
 * reveals nothing, and takes an earlier reveal back.
 *
 * The SDK has no call that only clears a reveal, so taking one back goes
 * through the wipe purge: the cached plaintext rows up to the boundary are
 * dropped and the channel takes no reveal for the rest of the session. That
 * is the fail-closed direction; the rows come back stripped on a refetch.
 *
 * Pure: no Solid, no SDK runtime, no `e2ee.ts`; loadable by `node --test`.
 */
import { ulidTimeMs } from "./protectedRowPolicy.ts";
import type { PreHistorySetting } from "./protectedTextTypes.ts";

/** The manager's `onHistoryPolicy` payload (`protectedTextTypes.ts`). */
export type HistoryPolicy = {
  verified: boolean;
  boundary: string | null;
  preHistory: PreHistorySetting | null;
  timeLimit: number | null;
};

/** The stoat.js pin record (`ProtectedPinHistory`). */
export type PinHistory = { boundary: string; wiped: boolean };

/** The stoat.js reveal (`PreProtectReveal`). */
export type HistoryReveal = { boundary: string; timeLimit: number };

/** What the bridge knows about a channel before it acts on a policy. */
export type HistorySeamState = {
  /** The server's `history_setting` advert as the bridge holds it. */
  historySetting: boolean;
  /** The local pin's history, if one was written. */
  pinned: PinHistory | null;
  /** Boundary of the reveal held for this channel, if any. */
  revealed: string | null;
  /** The SDK latched a reveal conflict for the channel. */
  conflicted: boolean;
  /** The SDK saw the channel's pre-protect history wiped. */
  wiped: boolean;
};

/** Why a policy reveals nothing. */
export type HistoryRefusal =
  | "flag_off"
  | "unverified"
  | "pre_history_unknown"
  | "no_boundary"
  | "malformed_boundary"
  | "no_time_limit"
  | "wiped"
  | "pin_mismatch"
  | "pin_rollback"
  | "channel_conflicted"
  | "channel_wiped";

/**
 * What to do for one policy. `reveal` is set only together with `pin` and a
 * null `refusal`; `purge` is the wipe purge, or the withdrawal of a reveal
 * that is held while the policy no longer allows one.
 */
export type HistoryPolicyActions = {
  refusal: HistoryRefusal | null;
  pin: PinHistory | null;
  reveal: HistoryReveal | null;
  purge: { boundary: string | null } | null;
  /** Worth an error line (a mismatch, a rollback, a malformed boundary). */
  loud: boolean;
};

function isUlid(id: unknown): id is string {
  return typeof id === "string" && ulidTimeMs(id) !== null;
}

/** Same rule as the SDK's reveal: a safe integer, not negative. */
function isTimeLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Decide what one reported policy does. Never throws; an input it cannot
 * read is "unverified".
 * @param p The manager's policy for the channel
 * @param state What the bridge holds for the channel right now
 */
export function historyPolicyActions(
  p: HistoryPolicy,
  state: HistorySeamState,
): HistoryPolicyActions {
  // Nothing is revealed: take back a held reveal, otherwise do nothing.
  const refuse = (refusal: HistoryRefusal, loud = false) => ({
    refusal,
    pin: null,
    reveal: null,
    purge:
      typeof state.revealed === "string"
        ? { boundary: isUlid(state.revealed) ? state.revealed : null }
        : null,
    loud,
  });

  if (state.historySetting !== true) return refuse("flag_off");
  if (typeof p !== "object" || p === null || p.verified !== true) {
    return refuse("unverified");
  }

  const boundary = isUlid(p.boundary) ? p.boundary : null;
  const malformed = p.boundary != null && boundary === null;
  const pinned = state.pinned;

  if (p.preHistory === "wiped") {
    const mismatch =
      boundary !== null && pinned !== null && pinned.boundary !== boundary;
    const writePin =
      boundary !== null &&
      !mismatch &&
      !(pinned !== null && pinned.wiped === true);
    return {
      refusal: "wiped",
      pin: writePin ? { boundary, wiped: true } : null,
      reveal: null,
      // Once per session: the SDK keeps the channel wiped after the first.
      purge: state.wiped !== false ? null : { boundary },
      loud: mismatch || malformed,
    };
  }

  if (p.preHistory !== "kept") return refuse("pre_history_unknown");
  if (p.boundary == null) return refuse("no_boundary");
  if (boundary === null) return refuse("malformed_boundary", true);
  if (pinned !== null && pinned.boundary !== boundary) {
    return refuse("pin_mismatch", true);
  }
  if (typeof state.revealed === "string" && state.revealed !== boundary) {
    return refuse("pin_mismatch", true);
  }
  // The pin already says wiped: `kept` after it is a rollback.
  if (pinned !== null && pinned.wiped !== false) {
    return refuse("pin_rollback", true);
  }
  if (!isTimeLimit(p.timeLimit)) return refuse("no_time_limit");
  if (state.conflicted !== false) return refuse("channel_conflicted");
  if (state.wiped !== false) return refuse("channel_wiped");

  return {
    refusal: null,
    pin: { boundary, wiped: false },
    reveal: { boundary, timeLimit: p.timeLimit },
    purge: null,
    loud: false,
  };
}

/** What the bridge hands `applyHistoryPolicy` (all on the SDK client). */
export interface HistorySeamPorts {
  /** `protectedFlag().historySetting`. */
  historySetting(): boolean;
  /** `client.protectedPins.historyOf`. */
  pinned(channelId: string): PinHistory | null | undefined;
  /** `client.protectedHistory.revealOf`. */
  revealed(channelId: string): HistoryReveal | null | undefined;
  /** `client.protectedHistory.isConflicted`. */
  conflicted(channelId: string): boolean;
  /** `client.protectedHistory.isWiped`. */
  wiped(channelId: string): boolean;
  /** `client.protectedPins.setHistory`; false = the pin disagrees. */
  setHistory(channelId: string, history: PinHistory): boolean;
  /** `client.revealPreProtectRows`. */
  reveal(channelId: string, reveal: HistoryReveal): void;
  /** `client.purgePreProtectRows`. */
  purge(channelId: string, boundary: string | null): void;
  /** An error line; it carries a reason and the channel id, nothing else. */
  log(line: string): void;
}

export type HistorySeamOutcome =
  | "revealed"
  | "wiped"
  | "withdrawn"
  | "conflict"
  | "none"
  | "failed";

/**
 * Act on one reported policy. With the history flag off and no reveal set
 * it reads the flag and the reveal and touches nothing else. Never
 * throws: a port that throws ends in `failed`, with a held reveal purged.
 * @param ports The SDK calls, as the bridge wires them
 * @param channelId Channel id
 * @param p The manager's policy for the channel
 */
export function applyHistoryPolicy(
  ports: HistorySeamPorts,
  channelId: string,
  p: HistoryPolicy,
): HistorySeamOutcome {
  try {
    const flagOn = ports.historySetting() === true;
    const set = ports.revealed(channelId) ?? null;
    if (!flagOn && set === null) return "none";

    const conflicted = ports.conflicted(channelId) !== false;
    const wiped = ports.wiped(channelId) !== false;
    // The SDK keeps a reveal's record after a wipe or a conflict but no
    // longer honours it: that one is not held, and needs no taking back.
    const held = set !== null && !conflicted && !wiped ? set : null;
    if (!flagOn && held === null) return "none";

    const actions = historyPolicyActions(p, {
      historySetting: flagOn,
      pinned: flagOn ? (ports.pinned(channelId) ?? null) : null,
      revealed: held === null ? null : held.boundary,
      conflicted,
      wiped,
    });
    if (actions.loud) {
      ports.log(
        `[protected] history policy refused (${actions.refusal}) ${channelId}`,
      );
    }

    if (actions.reveal !== null && actions.pin !== null) {
      // Already held as is: nothing to write or reconcile again.
      if (
        held !== null &&
        held.boundary === actions.reveal.boundary &&
        held.timeLimit === actions.reveal.timeLimit
      ) {
        return "revealed";
      }
      if (ports.setHistory(channelId, actions.pin) !== true) {
        ports.log(`[protected] history pin refused ${channelId}`);
        if (held !== null) ports.purge(channelId, held.boundary);
        return "conflict";
      }
      ports.reveal(channelId, actions.reveal);
      if (ports.conflicted(channelId) !== false) {
        ports.log(`[protected] history reveal conflict ${channelId}`);
        return "conflict";
      }
      return "revealed";
    }

    if (
      actions.pin !== null &&
      ports.setHistory(channelId, actions.pin) !== true
    ) {
      ports.log(`[protected] history pin refused ${channelId}`);
    }
    if (actions.purge !== null) {
      ports.purge(channelId, actions.purge.boundary);
      return actions.refusal === "wiped" ? "wiped" : "withdrawn";
    }
    return actions.refusal === "wiped" ? "wiped" : "none";
  } catch {
    try {
      ports.log(`[protected] history policy failed ${channelId}`);
      if (
        (ports.revealed(channelId) ?? null) !== null &&
        ports.wiped(channelId) === false
      ) {
        ports.purge(channelId, null);
      }
    } catch {
      // nothing further to take back
    }
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// What the manager reads from the bridge, and the bridge from the manager
// ---------------------------------------------------------------------------

/** Extra manager dep: the local pin's history for the row policy. */
export interface ProtectedHistorySeamDeps {
  pinHistory(channelId: string): PinHistory | null;
}

/**
 * The SDK's two one-way latches for a channel, as the manager's
 * `preHistoryState` dep answers them (R-W4-26: a conflicted or wiped
 * channel's plaintext rows are red). Never throws. A latch that is not the
 * literal `false` reads as set; a missing SDK state or a read that throws
 * reads as conflicted, so nothing renders as ordinary on an unknown state.
 * @param history `client.protectedHistory`
 * @param channelId Channel id
 */
export function preHistoryStateOf(
  history:
    | {
        isConflicted(channelId: string): boolean;
        isWiped(channelId: string): boolean;
      }
    | null
    | undefined,
  channelId: string,
): { conflicted: boolean; wiped: boolean } {
  try {
    if (!history) return { conflicted: true, wiped: false };
    return {
      conflicted: history.isConflicted(channelId) !== false,
      wiped: history.isWiped(channelId) !== false,
    };
  } catch {
    return { conflicted: true, wiped: false };
  }
}

/** Extra port member, beside `formatsV2`: the `history_setting` advert. */
export interface ProtectedHistoryPort {
  historySetting(): boolean;
}

/** The S4 owner calls and the walk, as the UI reaches them on the manager. */
export interface ProtectedHistoryManagerApi {
  protect(
    channelId: string,
    seats: string[],
    deviceCap: number,
    opts?: { withHistory: boolean; wipe: boolean },
  ): Promise<void>;
  setHistoryVisible(channelId: string, visible: boolean): Promise<void>;
  wipeHistory(channelId: string): Promise<void>;
  walkHistory(channelId: string): void;
}

/**
 * The manager as its S4 surface, or null while it does not carry all of
 * it. A manager without `setHistoryVisible`, `wipeHistory` and
 * `walkHistory` is the S2 one, whose `protect` ignores `opts`.
 */
export function historyManagerOf(
  manager: unknown,
): ProtectedHistoryManagerApi | null {
  if (typeof manager !== "object" || manager === null) return null;
  const m = manager as Record<string, unknown>;
  for (const name of [
    "protect",
    "setHistoryVisible",
    "wipeHistory",
    "walkHistory",
  ]) {
    if (typeof m[name] !== "function") return null;
  }
  return manager as ProtectedHistoryManagerApi;
}

// ---------------------------------------------------------------------------
// Backup (design 8.5, R-W4-12)
// ---------------------------------------------------------------------------

export type BackupTextTruncated = "none" | "oldest" | "all";

/** The text section of a restore, as the UI reads it. */
export type RestoreTextSummary = {
  /** Epochs restored; null when the report does not say (0 or older shell). */
  epochs: number | null;
  truncated: BackupTextTruncated | null;
  /**
   * `partial`: some history keys were left out; `all`: nothing of the text
   * section was restored.
   */
  skipped: "none" | "partial" | "all";
};

function textTruncatedOf(value: unknown): BackupTextTruncated | null {
  return value === "none" || value === "oldest" || value === "all"
    ? value
    : null;
}

/**
 * `BackupBundle.text_truncated`, or null when the bundle has no text
 * section (or comes from a shell that does not report one).
 */
export function bundleTextTruncated(
  bundle: unknown,
): BackupTextTruncated | null {
  if (typeof bundle !== "object" || bundle === null) return null;
  return textTruncatedOf((bundle as Record<string, unknown>).text_truncated);
}

/**
 * The three `text_*` keys of a native `RestoreReport`. A report without
 * them (an older shell, iOS's null, a legacy republish payload) reads
 * `{ epochs: null, truncated: null, skipped: "none" }`.
 * @param report What the native restore answered
 */
export function restoreTextSummary(report: unknown): RestoreTextSummary {
  if (typeof report !== "object" || report === null) {
    return { epochs: null, truncated: null, skipped: "none" };
  }
  const r = report as Record<string, unknown>;
  const epochs =
    typeof r.text_epochs === "number" &&
    Number.isSafeInteger(r.text_epochs) &&
    r.text_epochs >= 0
      ? r.text_epochs
      : null;
  const truncated = textTruncatedOf(r.text_truncated);
  // R-W4-12: skipped with `text_truncated` = partial, without = all.
  const skipped =
    r.text_skipped !== true ? "none" : truncated !== null ? "partial" : "all";
  return { epochs, truncated, skipped };
}
