// Rules for the history parts of the Protected channel settings page (S4;
// design 9.5, 4.9 "S4", plan O-5): protecting a channel that already has
// messages, the "new members can read earlier messages" setting and the wipe
// of the earlier unprotected messages.
//
// No imports: `ProtectedChannelSettings.tsx` cannot load under Node, so what
// it decides about these parts is decided here and
// `protectedHistorySettings.test.ts` runs it directly.
//
// Three things hold throughout:
// - nothing is offered unless the server advertises the history setting, the
//   user is the owner and native's state is loaded and verified;
// - the setting shown is the one native verified, never the server's and
//   never the one a click asked for;
// - a wipe is never a default. The option starts unticked each time the
//   protect form opens, is read from that form only, and nothing here ever
//   reads a stored value for it.
//
// Fix round W4: a protect that went through with something left out has an
// outcome of its own (`protectOutcomeKind`), the wipe progress shows only
// once native says `wiped`, and the page asks for one verify per channel
// when native has not loaded it (`historyVerifyStep`). The checking line
// that follows an ask ends on a timer of its own (`historyCheckWaitMs`).

// ---------------------------------------------------------------------------
// Protect form (a channel that already has messages)
// ---------------------------------------------------------------------------

/**
 * The protect form's wipe option. `wipeTicked` is the checkbox while the
 * form is open; `wipeArmed` is that tick carried into the seat picker after
 * "Continue". Both are false whenever the form opens.
 */
export interface ProtectDraft {
  open: boolean;
  wipeTicked: boolean;
  wipeArmed: boolean;
}

export type ProtectDraftEvent =
  /** "Protect this channel": the form opens, always unticked. */
  | { type: "open" }
  /** The checkbox changed. */
  | { type: "tick"; checked: unknown }
  /** "Continue": the form closes and the picker opens. */
  | { type: "continue" }
  /** "Cancel", a channel switch, or the picker could not open. */
  | { type: "cancel" }
  /** The protect call went through. */
  | { type: "done" };

/** A closed form with nothing ticked. Takes no input: nothing is restored. */
export function newProtectDraft(): ProtectDraft {
  return { open: false, wipeTicked: false, wipeArmed: false };
}

/**
 * The next form state. A tick counts only while the form is open and only
 * as a literal `true`; "Continue" arms the wipe only from a tick made in
 * the form it closes. Anything unknown closes the form unticked.
 */
export function protectDraftStep(
  draft: ProtectDraft,
  event: ProtectDraftEvent,
): ProtectDraft {
  switch (event.type) {
    case "open":
      return { open: true, wipeTicked: false, wipeArmed: false };
    case "tick":
      if (draft.open !== true) return newProtectDraft();
      return {
        open: true,
        wipeTicked: event.checked === true,
        wipeArmed: false,
      };
    case "continue":
      return {
        open: false,
        wipeTicked: false,
        wipeArmed: draft.open === true && draft.wipeTicked === true,
      };
    case "cancel":
    case "done":
      return newProtectDraft();
    default: {
      const _exhaustive: never = event;
      return newProtectDraft();
    }
  }
}

/**
 * The `opts` of `ProtectedUiApi.protect`. Undefined for a channel without
 * messages (or with the history setting off): the call is then the one made
 * before S4, with no fourth argument. `wipe` is true only for an armed tick.
 */
export function protectOpts(i: {
  withHistory: unknown;
  wipeArmed: unknown;
}): { withHistory: true; wipe: boolean } | undefined {
  if (i.withHistory !== true) return undefined;
  return { withHistory: true, wipe: i.wipeArmed === true };
}

// ---------------------------------------------------------------------------
// History section (a protected channel)
// ---------------------------------------------------------------------------

/**
 * Native's history values for the channel, as the page reads them from the
 * bridge's view (`nativeHistoryInput` plus the held list's `history` line).
 */
export interface HistoryNativeInput {
  verified: unknown;
  historySetting: unknown;
  boundary: unknown;
  preHistory: unknown;
}

export interface HistorySectionInput {
  /** The page's owner check. */
  isOwner: unknown;
  /** `protectedFlag().historySetting`. */
  flag: unknown;
  /** A protected channel on a device that runs the text plane. */
  canAct: unknown;
  /** Null while the state is not loaded. */
  native: HistoryNativeInput | null | undefined;
  /** The server's `protected_history.wipe`: progress text only. */
  serverWipe: unknown;
  /** An owner call or an unresolved publish is running. */
  busy: unknown;
  /** A stored, unresolved list change waits (a recovery included). */
  storedChange: unknown;
}

/** What the server says about a wipe; `count` is its number or null. */
export type WipeProgress =
  | { kind: "none" }
  | { kind: "requested" }
  | { kind: "done"; count: number | null };

export type HistorySectionModel =
  | { kind: "none" }
  | {
      kind: "owner";
      /** `checked` is native's verified setting. */
      toggle: { checked: boolean; disabled: boolean };
      /** The plan O-5 line, shown while history is hidden. */
      removalNote: boolean;
      /**
       * Native holds a boundary and says the earlier messages were kept:
       * they stay readable to everyone in the channel, so the "hidden"
       * description must not say otherwise (R-W4-36).
       */
      earlierKept: boolean;
      wipe: { offered: boolean; disabled: boolean };
      progress: WipeProgress;
    };

const NONE: HistorySectionModel = { kind: "none" };

/** The server's wipe state as progress; anything unreadable is `none`. */
export function wipeProgress(serverWipe: unknown): WipeProgress {
  if (typeof serverWipe !== "object" || serverWipe === null) {
    return { kind: "none" };
  }
  const w = serverWipe as { state?: unknown; count?: unknown };
  if (w.state === "requested") return { kind: "requested" };
  if (w.state === "done") {
    const ok =
      typeof w.count === "number" &&
      Number.isSafeInteger(w.count) &&
      w.count >= 0;
    return { kind: "done", count: ok ? (w.count as number) : null };
  }
  return { kind: "none" };
}

/**
 * Which history controls the page offers. Nothing at all unless the server
 * advertises the setting, the user is the owner, the channel is protected
 * on a capable device and native's state is loaded, verified and carries a
 * known `history` line. The toggle and the wipe are disabled unless the
 * page is known to be idle. The wipe is offered from native's values alone
 * (`pre_history: "kept"` and a boundary). The server's wipe state only
 * picks the progress line, and only once native says `wiped` (audit B8):
 * the progress never shows beside the wipe button, and never for a wipe
 * the owner did not sign.
 */
export function historySectionModel(
  i: HistorySectionInput,
): HistorySectionModel {
  if (i.isOwner !== true || i.flag !== true || i.canAct !== true) return NONE;
  const n = i.native;
  if (typeof n !== "object" || n === null || n.verified !== true) return NONE;
  if (n.historySetting !== "visible" && n.historySetting !== "hidden") {
    return NONE;
  }
  const visible = n.historySetting === "visible";
  const idle = i.busy === false && i.storedChange === false;
  const boundary = typeof n.boundary === "string" && n.boundary.length > 0;
  const kept = boundary && n.preHistory === "kept";
  const wiped = boundary && n.preHistory === "wiped";
  return {
    kind: "owner",
    toggle: { checked: visible, disabled: !idle },
    removalNote: !visible,
    earlierKept: kept,
    wipe: { offered: kept, disabled: !idle },
    progress: wiped ? wipeProgress(i.serverWipe) : { kind: "none" },
  };
}

/**
 * A click on the history toggle that asked for `asked`. `shown` is what the
 * box shows afterwards: still the verified setting (the page puts it back,
 * since the checkbox flips itself on a click). `request` is the value to
 * send, or null when nothing may be sent: no section, disabled, not a
 * boolean, or no change.
 */
export function historyToggleClick(
  model: HistorySectionModel,
  asked: unknown,
): { shown: boolean; request: boolean | null } {
  if (model.kind !== "owner") return { shown: false, request: null };
  const shown = model.toggle.checked;
  if (model.toggle.disabled || typeof asked !== "boolean" || asked === shown) {
    return { shown, request: null };
  }
  return { shown, request: asked };
}

/** Whether a click on the wipe button may send the wipe. */
export function wipeClickAllowed(model: HistorySectionModel): boolean {
  return model.kind === "owner" && model.wipe.offered && !model.wipe.disabled;
}

// ---------------------------------------------------------------------------
// Failures with an inline line of their own
// ---------------------------------------------------------------------------

export type HistoryFailureKind =
  | "protect_busy"
  | "wipe_refused"
  | "clock_behind";

const HISTORY_FAILURES: readonly HistoryFailureKind[] = [
  "protect_busy",
  "wipe_refused",
  "clock_behind",
];

/**
 * The kind of a rejected history call that has copy of its own
 * (`{ source: "client", reason }` from the bridge's owner flows), or null:
 * the page then shows what it shows for any other failed owner action.
 */
export function historyFailureKind(err: unknown): HistoryFailureKind | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { source?: unknown; reason?: unknown };
  if (e.source !== "client" || typeof e.reason !== "string") return null;
  const at = HISTORY_FAILURES.indexOf(e.reason as HistoryFailureKind);
  return at === -1 ? null : HISTORY_FAILURES[at];
}

// ---------------------------------------------------------------------------
// A protect that went through with something left out (R-W4-35, audit B7)
// ---------------------------------------------------------------------------

/**
 * - `members_pending`: the channel is protected with the owner alone; the
 *   picked members were not added.
 * - `members_unconfirmed`: the channel is protected and the member step
 *   rejected, but the seat list read afterwards is not the owner alone (or
 *   was not readable): nothing is claimed about who is seated (RB2).
 * - `wipe_not_done`: the channel is protected; the wipe that was ticked was
 *   not performed.
 * - `wipe_not_done_members_pending` / `wipe_not_done_members_unconfirmed`:
 *   both at once (RB3).
 */
export type ProtectOutcomeKind =
  | "members_pending"
  | "members_unconfirmed"
  | "wipe_not_done"
  | "wipe_not_done_members_pending"
  | "wipe_not_done_members_unconfirmed";

/** The owner flow's reason for each outcome. */
const PROTECT_OUTCOMES: readonly (readonly [string, ProtectOutcomeKind])[] = [
  ["protected_members_pending", "members_pending"],
  ["protected_members_unconfirmed", "members_unconfirmed"],
  ["wipe_not_done", "wipe_not_done"],
  ["wipe_not_done_members_pending", "wipe_not_done_members_pending"],
  ["wipe_not_done_members_unconfirmed", "wipe_not_done_members_unconfirmed"],
];

/**
 * The outcome of a rejected protect call when the rejection means "the
 * channel is protected now" (`{ source: "client", reason }` from the
 * bridge's owner flow), or null: the protect failed, or failed for a cause
 * this build does not know, and the page shows what it shows for any failed
 * owner action. Only the five exact reasons count.
 */
export function protectOutcomeKind(err: unknown): ProtectOutcomeKind | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { source?: unknown; reason?: unknown };
  if (e.source !== "client") return null;
  for (const [reason, kind] of PROTECT_OUTCOMES) {
    if (e.reason === reason) return kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// One verify per channel native has not loaded (audit C6, re-review RB9)
// ---------------------------------------------------------------------------

/** How long the checking line may show for one ask. */
export const HISTORY_CHECK_LINE_MS = 20_000;

export interface HistoryVerifyInput {
  channelId: unknown;
  /** The page's owner check. */
  isOwner: unknown;
  /** `protectedFlag().historySetting`. */
  flag: unknown;
  /** A protected channel on a device that runs the text plane. */
  canAct: unknown;
  /** `historySectionModel(...).kind`. */
  modelKind: unknown;
  /**
   * Whether native's state for the channel is loaded at all: the bridge's
   * view of the channel exists and carries native's state.
   */
  nativeLoaded: unknown;
  /** `Date.now()`, read when the input is built. */
  now: unknown;
}

/** The channels this page instance already asked for, with when. */
export type HistoryVerifyAsks = ReadonlyMap<string, number>;

/**
 * The channel id when the history section could show here if native's
 * state allowed it (owner, history flag on, a protected channel this device
 * can act on); else null.
 */
function verifyChannel(i: HistoryVerifyInput): string | null {
  if (typeof i.channelId !== "string" || i.channelId.length === 0) return null;
  if (i.isOwner !== true || i.flag !== true || i.canAct !== true) return null;
  return i.channelId;
}

/**
 * Whether the page asks the bridge for one refresh of the channel now
 * (`retryNow`), and the asks to remember. It asks when the history section
 * could show (owner, history flag on, a protected channel this device can
 * act on), its model is `none` and native has not loaded the channel
 * (`nativeLoaded` exactly false). A channel native has loaded whose model
 * is `none` for another reason (an unverified list, a setting this build
 * does not know) is never asked for (RB9): a refresh would not change it.
 * Only ONCE per channel for the life of `asks`: the page keeps `asks` for
 * as long as it is mounted, so switching away and back, or a state that
 * stays unloaded, never asks again. With the flag off it never asks.
 */
export function historyVerifyStep(
  asks: HistoryVerifyAsks,
  i: HistoryVerifyInput,
): { asks: HistoryVerifyAsks; ask: boolean } {
  const id = verifyChannel(i);
  if (id === null || i.modelKind !== "none" || asks.has(id)) {
    return { asks, ask: false };
  }
  if (i.nativeLoaded !== false) return { asks, ask: false };
  const at = typeof i.now === "number" && Number.isFinite(i.now) ? i.now : 0;
  const next = new Map(asks);
  next.set(id, at);
  return { asks: next, ask: true };
}

/**
 * Whether the "Checking" line shows in place of the history section: only
 * after this page asked for the channel, only while native's state for it
 * is not loaded, and for at most `HISTORY_CHECK_LINE_MS` after the ask. A
 * state that is loaded but not verified is not "checking": the page shows
 * nothing there, as before.
 */
export function historyCheckingShown(
  asks: HistoryVerifyAsks,
  i: HistoryVerifyInput,
): boolean {
  const id = verifyChannel(i);
  if (id === null || i.modelKind !== "none") return false;
  if (i.nativeLoaded !== false) return false;
  const at = asks.get(id);
  if (at === undefined) return false;
  if (typeof i.now !== "number" || !Number.isFinite(i.now)) return false;
  const waited = i.now - at;
  return waited >= 0 && waited < HISTORY_CHECK_LINE_MS;
}

/**
 * How long from `now` until the checking line of `channelId` ends, for the
 * page's one timer: `HISTORY_CHECK_LINE_MS` after the ask, whatever else
 * redraws the page in between (RB6). Null when there is nothing to wait
 * for: the channel was not asked for, the time is up, or an input is not
 * usable. Never more than `HISTORY_CHECK_LINE_MS` and never 0.
 */
export function historyCheckWaitMs(
  asks: HistoryVerifyAsks,
  channelId: unknown,
  now: unknown,
): number | null {
  if (typeof channelId !== "string") return null;
  if (typeof now !== "number" || !Number.isFinite(now)) return null;
  const at = asks.get(channelId);
  if (at === undefined) return null;
  const waited = now - at;
  if (waited < 0 || waited >= HISTORY_CHECK_LINE_MS) return null;
  return HISTORY_CHECK_LINE_MS - waited;
}
