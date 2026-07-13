/**
 * The §3.4 call-mode transition machine + the §4.4 dual-gated chip + the ctl
 * payload parser — the PURE, session-independent core of slice 6.5's downgrade
 * UX, extracted from `mlsCallSession`/`state.tsx` so every transition and the
 * chip precedence table are unit-testable in isolation (the house no-vitest
 * split; this module must stay dependency-free so `node --test` can load it).
 *
 * Nothing here performs I/O or touches a Room: `callModeTransition` returns the
 * NEXT mode + the EFFECTS the session must run; `chipState` derives the visible
 * indicator from a snapshot of inputs; `parseCtlPayload` validates a received
 * ctl-announce (default-closed forward-compat). The session owns the imperative
 * glue (native confirm dialog, pause gate, announce courier, timers).
 */

// ---- Call mode (the §3.4 state machine) ------------------------------------

export type CallMode =
  // Session exists, no verdict yet — publishing GATED (`negotiating` reason).
  | { kind: "negotiating" }
  // Not an E2EE call (feature/toggle off) — publishing normal, no chrome (L4).
  | { kind: "off" }
  // Enabled, roster consistent, publishing encrypted.
  | { kind: "e2ee" }
  // Non-enrolled present (post grace) — publishing PAUSED, banner shown.
  | { kind: "mixed" }
  // A confirmed plaintext window is open; `localConfirmed` is THIS device's.
  | { kind: "interlude"; localConfirmed: boolean }
  // Terminal joiner-side A3 refusal (auto-leave).
  | { kind: "call_full" };

/**
 * The events that drive the machine. Each is a RESOLVED fact (e.g.
 * `local_confirm` fires only AFTER the native dialog returned Ok) — the pure
 * function never awaits.
 */
export type CallModeEvent =
  // The session settled: not an E2EE call (feature/toggle off, legacy server).
  | { type: "verdict_plaintext" }
  // Enable completed (pause→setE2EEEnabled(true)→resume all done).
  | { type: "enabled" }
  // A non-enrolled participant is present past the classification grace.
  | { type: "mix_detected" }
  // The last non-enrolled participant left (drives T2 / T6 after hysteresis).
  | { type: "mix_cleared" }
  // This device's user confirmed plaintext in the native dialog (T3 / T5).
  | { type: "local_confirm" }
  // A verified member announced plaintext for this call (T4). Never resumes.
  | { type: "remote_announce" }
  // join_intent returned MlsCallFull (T7 — joiner side only).
  | { type: "call_full" }
  // A control-plane re-establish (desync/poison/rejoin) — keeps the mode.
  | { type: "resecure" };

/** An effect the session must perform after a transition (imperative glue). */
export type CallModeEffect =
  // Assert / release the named publish-gate reason (R2-7 reason-scoped gate).
  | { do: "pause"; reason: "negotiating" | "mixed" | "enable-window" }
  | { do: "resume"; reason: "negotiating" | "mixed" | "enable-window" }
  // Flip the LiveKit Room E2EE mode. `false` only ever after a native confirm.
  | { do: "set_e2ee"; enabled: boolean }
  // Courier the group-encrypted mode announcement (best-effort; ME-4/ME-12).
  | { do: "announce" }
  // Start the 15 s re-upgrade hysteresis (T2 warm resume / T6 successor).
  | { do: "schedule_reupgrade"; viaSuccessor: boolean }
  // Cancel a pending re-upgrade (a participant bounced back in).
  | { do: "cancel_reupgrade" }
  // Auto-leave the SFU (T7) — deferred by the session (never sync in-callback).
  | { do: "auto_leave" };

export interface CallModeTransition {
  mode: CallMode;
  effects: CallModeEffect[];
}

/**
 * The §3.4 transition function. `mode` is the current mode; `event` a resolved
 * fact; returns the next mode + the effects to run. Total + deterministic —
 * every (mode, event) pair is handled (unknown pairs are no-ops that keep the
 * mode, so a spurious event never corrupts state).
 *
 * Invariants encoded here (gate-checklist / audit folds):
 *  - The ONLY path to `interlude` (a plaintext window) is `local_confirm`
 *    (T3/T5) or `remote_announce` (T4); `remote_announce` sets
 *    `localConfirmed:false` so it NEVER resumes publishing (I1).
 *  - `local_confirm`'s effect order is `set_e2ee(false)` BEFORE `resume`
 *    (no encrypted frame to keyless peers; no plaintext under an encrypted
 *    flag) — the session performs them in array order.
 *  - The enable branch is MODE-GATED (ME-6): only `negotiating`/`e2ee`/`mixed`
 *    accept `enabled`; an `interlude` NEVER warm-enables the old group — its
 *    sole exit is `mix_cleared` → T6 successor.
 *  - `call_full` is terminal (T7); further events keep it.
 */
export function callModeTransition(
  mode: CallMode,
  event: CallModeEvent,
): CallModeTransition {
  const keep = (): CallModeTransition => ({ mode, effects: [] });

  // Terminal.
  if (mode.kind === "call_full" || mode.kind === "off") {
    // `off` still accepts a late `mix_detected`? No — an off call negotiated
    // plaintext for a NON-E2EE call; there is no group. Stay put.
    return keep();
  }

  switch (event.type) {
    case "call_full":
      // T7 — joiner-side only; terminal + auto-leave (deferred).
      return { mode: { kind: "call_full" }, effects: [{ do: "auto_leave" }] };

    case "verdict_plaintext":
      // T0a — feature/toggle off ⇒ release the negotiating gate, no chrome.
      return {
        mode: { kind: "off" },
        effects: [{ do: "resume", reason: "negotiating" }],
      };

    case "enabled":
      // T0b — enable completed. MODE-GATED (ME-6): never from an interlude.
      if (
        mode.kind === "negotiating" ||
        mode.kind === "e2ee" ||
        mode.kind === "mixed"
      ) {
        return { mode: { kind: "e2ee" }, effects: [] };
      }
      return keep();

    case "mix_detected":
      // T0c / T1 — a non-enrolled participant (post-grace). PAUSE + banner.
      // Already mixed/interlude ⇒ no-op (the pause is already asserted).
      if (mode.kind === "negotiating") {
        // Swap the negotiating gate for the mixed gate (both keep us paused).
        return {
          mode: { kind: "mixed" },
          effects: [
            { do: "pause", reason: "mixed" },
            { do: "resume", reason: "negotiating" },
            { do: "cancel_reupgrade" },
          ],
        };
      }
      if (mode.kind === "e2ee") {
        return {
          mode: { kind: "mixed" },
          effects: [
            { do: "pause", reason: "mixed" },
            { do: "cancel_reupgrade" },
          ],
        };
      }
      // In an interlude, a NEW non-enrolled participant does not change the
      // mode — the interlude already tolerates plaintext; cancel any pending
      // re-upgrade so we don't resume-encrypt while a mix persists.
      if (mode.kind === "interlude") {
        return { mode, effects: [{ do: "cancel_reupgrade" }] };
      }
      return keep();

    case "mix_cleared":
      // The last non-enrolled participant left. From `mixed` (nobody
      // confirmed): T2 warm resume after hysteresis. From `interlude`
      // (plaintext was live): T6 fresh-successor re-upgrade after hysteresis.
      if (mode.kind === "mixed") {
        return {
          mode,
          effects: [{ do: "schedule_reupgrade", viaSuccessor: false }],
        };
      }
      if (mode.kind === "interlude") {
        return {
          mode,
          effects: [{ do: "schedule_reupgrade", viaSuccessor: true }],
        };
      }
      return keep();

    case "local_confirm":
      // T3 / T5 — the user confirmed plaintext (native dialog already Ok).
      // set_e2ee(false) STRICTLY before resume. Announce is best-effort.
      // Reachable from `mixed` (T3) or `interlude(localConfirmed:false)` (T5).
      if (
        mode.kind === "mixed" ||
        (mode.kind === "interlude" && !mode.localConfirmed)
      ) {
        return {
          mode: { kind: "interlude", localConfirmed: true },
          effects: [
            { do: "set_e2ee", enabled: false },
            { do: "resume", reason: "mixed" },
            // A confirmed plaintext interlude must release EVERY session-held
            // gate reason (re-verify MED-B): a failed `#enable` deliberately
            // leaves `enable-window` held (fail-closed), and without this the
            // user who just confirmed "resume unencrypted" stays paused
            // forever. Releasing an un-held reason is a no-op.
            { do: "resume", reason: "enable-window" },
            { do: "announce" },
            { do: "cancel_reupgrade" },
          ],
        };
      }
      // ME-10 terminal-loud escape: a call that FAILED to secure (retry
      // exhaustion / loud failure while still `negotiating`) may be resumed
      // as plaintext by the SAME native-confirmed path — "Stay unencrypted".
      // No explicit `negotiating` resume: the session's mode lockstep releases
      // that gate AFTER these effects run (E2EE-off still strictly first);
      // `enable-window` (held by a failed enable) IS released explicitly
      // (re-verify MED-B). The caller gates reachability on a
      // failed/re-securing/latched-loud session.
      if (mode.kind === "negotiating") {
        return {
          mode: { kind: "interlude", localConfirmed: true },
          effects: [
            { do: "set_e2ee", enabled: false },
            { do: "resume", reason: "enable-window" },
            { do: "announce" },
            { do: "cancel_reupgrade" },
          ],
        };
      }
      return keep();

    case "remote_announce":
      // T4 — a verified member announced plaintext. Publishing STAYS PAUSED
      // (an announce can never open the local plaintext path); only re-words
      // the banner. Reachable from `mixed` only (an already-interlude member
      // ignores a duplicate announce).
      if (mode.kind === "mixed") {
        return {
          mode: { kind: "interlude", localConfirmed: false },
          effects: [{ do: "cancel_reupgrade" }],
        };
      }
      return keep();

    case "resecure":
      // A control-plane re-establish keeps the CallMode (the machine rides
      // above group identity). The session's own pause-through-re-secure logic
      // handles the gate EXCEPT in interlude(localConfirmed:true), where the
      // user keeps publishing plaintext (their authorization came from the
      // user, not from group state).
      return keep();
  }
}

// ---- The §4.4 dual-gated chip ----------------------------------------------

export type ChipState =
  | "none"
  | "e2ee"
  | "e2ee_unverified"
  | "resecuring"
  | "not_encrypted";

/** A snapshot of everything the chip derivation reads. */
export interface ChipInputs {
  /** No session at all (non-capable shell / never constructed). */
  hasSession: boolean;
  /** The session lifecycle state (when `hasSession`). */
  sessionState?:
    | "starting"
    | "active"
    | "plaintext"
    | "resecuring"
    | "failed"
    | "closed";
  /** The §3.4 call mode (when `hasSession`). */
  mode?: CallMode;
  /** LiveKit E2EE mode is on + our first local send-key is installed. */
  e2eeEnabled: boolean;
  hasLocalKey: boolean;
  /** A rotation-window RE-SECURING is active (media-plane debounce). */
  resecuring: boolean;
  /** A structured call-encryption error is latched. */
  latchedError: boolean;
  /**
   * The current SFU participants WITH ≥1 published track (FE-2: only these
   * ever report a LiveKit encryption status; trackless listeners are covered
   * by MLS membership + verification, not gate (b)).
   */
  publishingIdentities: readonly string[];
  /** LiveKit's observed per-participant encryption status (identity → bool). */
  observedEncrypted: ReadonlyMap<string, boolean>;
  /** The VERIFIED MLS roster: every member's `user_verified` flag. */
  rosterVerified: readonly boolean[];
  /** The channel has an open MLS group (the probe result — FE-7). */
  channelHasOpenGroup: boolean;
  /** This shell can do media E2EE (capable + toggle on). */
  capableAndEnabled: boolean;
}

/**
 * Derive the §4.4 chip. DUAL-GATED green (invariant 11 / amendment A1):
 * (a) native control-plane health, (b) LiveKit-observed per-participant
 * encryption over TRACK-PUBLISHING participants, (c) every roster member
 * user-verified. Neither gate alone is green; either's absence drops to
 * resecuring/not_encrypted (fail-closed). Server flags can never promote.
 * Precedence: not_encrypted > resecuring > e2ee_unverified > e2ee > none.
 */
export function chipState(inputs: ChipInputs): ChipState {
  const mode = inputs.mode?.kind;

  // ---- not_encrypted (loud) — highest precedence -------------------------
  if (
    mode === "mixed" ||
    mode === "interlude" ||
    mode === "call_full" ||
    inputs.sessionState === "failed" ||
    inputs.latchedError
  ) {
    return "not_encrypted";
  }
  // Capable-but-failed construction in an E2EE-known call (ME-7/R2-4): a
  // toggle-on capable shell with NO session but a channel that HAS an open
  // group must not read as a quiet plain call — it is a downgrade the user
  // can't see. (The session-present latched-error case is caught above.)
  if (
    !inputs.hasSession &&
    inputs.capableAndEnabled &&
    inputs.channelHasOpenGroup
  ) {
    return "not_encrypted";
  }
  // Toggle-OFF self in a channel whose call IS E2EE (§0.2 #9 self-attribution):
  // no session (we didn't attempt), capable shell present but calls disabled.
  if (
    !inputs.hasSession &&
    !inputs.capableAndEnabled &&
    inputs.channelHasOpenGroup
  ) {
    return "not_encrypted";
  }

  // ---- none — no session / not an E2EE call / still starting -------------
  if (
    !inputs.hasSession ||
    inputs.sessionState === "starting" ||
    inputs.sessionState === "plaintext" ||
    mode === "off"
  ) {
    return "none";
  }

  // Native control-plane gate (a): active + enabled + first key + not
  // resecuring + no latched error.
  const nativeHealthy =
    inputs.sessionState === "active" &&
    mode === "e2ee" &&
    inputs.e2eeEnabled &&
    inputs.hasLocalKey;

  // ---- resecuring (amber, bounded) ---------------------------------------
  if (inputs.sessionState === "resecuring" || inputs.resecuring) {
    return "resecuring";
  }
  if (!nativeHealthy) {
    // Enabled-but-not-yet-fully-healthy (e.g. mid-negotiation with an open
    // group): amber, not green. `negotiating` mode lands here.
    return "resecuring";
  }

  // Media-plane gate (b): every TRACK-PUBLISHING participant observed
  // encrypted. A missing entry is NOT green (fail-closed). No publishers yet
  // (everyone muted) ⇒ (b) is vacuously satisfied — (a)+(c) carry it.
  const mediaObserved = inputs.publishingIdentities.every(
    (identity) => inputs.observedEncrypted.get(identity) === true,
  );
  if (!mediaObserved) {
    // (a) holds but (b) not yet satisfied for a publishing participant —
    // bounded amber (the session arms the 10 s escalation → loud, R2-2).
    return "resecuring";
  }

  // Verification gate (c).
  const allVerified = inputs.rosterVerified.every((v) => v);
  return allVerified ? "e2ee" : "e2ee_unverified";
}

// ---- ctl-announce payload parsing (default-closed forward-compat) ----------

/** The one recognised ctl semantics: a mode change to plaintext (§3.4). */
export interface CtlModeAnnounce {
  kind: "mode";
  mode: "plaintext";
  channelId: string;
  groupId: string;
}

/**
 * Parse a received ctl payload (ME-15 forward-compat, default-closed): the
 * ONLY actionable message is `{v:1, kind:"mode", mode:"plaintext", …}`.
 * Unknown `v`/`kind`, malformed JSON, or any mode other than exactly
 * `"plaintext"` returns null — a quiet no-op, never an action (there is NO
 * `mode:"e2ee"` trigger; re-upgrade is automatic-only). The caller
 * additionally checks the channel/group binding against the live call.
 */
export function parseCtlPayload(raw: string): CtlModeAnnounce | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) return null;
  if (obj.kind !== "mode") return null;
  if (obj.mode !== "plaintext") return null;
  if (typeof obj.channel_id !== "string" || typeof obj.group_id !== "string") {
    return null;
  }
  return {
    kind: "mode",
    mode: "plaintext",
    channelId: obj.channel_id,
    groupId: obj.group_id,
  };
}

// ---- LiveKit encryptionError classification (the §4.4 loud-state debounce) --

/**
 * Classify a LiveKit `encryptionError`: a missing key INSIDE a known rotation
 * window (an epoch change we are mid-processing, or within the Add-grace) is
 * `resecuring` (transient, bounded); the same error OUTSIDE a known window is
 * immediately `loud`. Clean rotations never flap because a correctly-graced
 * rotation produces no missing-key error.
 *
 * `awaitingFirstKey` (6.7b fix, found in the on-device Android×desktop
 * proof): a joiner that connects to the SFU while existing members are
 * ALREADY publishing encrypted frames receives those frames BEFORE its
 * Welcome resolves and its first key installs — LiveKit raises missing-key
 * `encryptionError`s that are EXPECTED join-in-progress noise, not a
 * media-plane failure. Classifying them loud latched the session terminally
 * (`#latchLoud` is by design not cleared by a later successful join), wedging
 * every rejoin/mid-call join whose admit takes longer than the first inbound
 * encrypted frame — near-certain on a real network (an on-device Android
 * admitter takes seconds); desktop↔desktop on one machine admits sub-second,
 * which is why the 6.4–6.6 desktop proofs never hit it. The window is
 * BOUNDED exactly like a rotation window: the caller arms the same
 * `RESECURE_ESCALATE_MS` escalation, so a join that never completes still
 * goes loud; the chip stays amber throughout (never green — chip gate (a)
 * requires the first local key) and the publish gate holds (no plaintext can
 * escape while re-securing).
 */
export function classifyEncryptionError(
  inRotationWindow: boolean,
  awaitingFirstKey: boolean,
): "resecuring" | "loud" {
  return inRotationWindow || awaitingFirstKey ? "resecuring" : "loud";
}
