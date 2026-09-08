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
  /**
   * Every LOCAL publication is on the SFU's record as GCM (vacuous when we
   * publish nothing). The observed status above witnesses the worker's
   * cryptor, not the declaration receivers arm their cryptors from: a mic
   * publish still in flight when E2EE was enabled lands declared NONE, the
   * worker still says "encrypted", and every peer disarms for us and hears
   * nothing while this chip read green (desktop 0.57.0, 2026-09-06). The
   * session re-declares such publications; until it has, the chip must
   * not vouch for them. Derived by `localPublicationsEncrypted`.
   */
  localPublicationsEncrypted: boolean;
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
 * encryption over TRACK-PUBLISHING participants AND every local publication
 * declared GCM to the SFU, (c) every roster member user-verified. Neither gate alone is green; either's absence drops to
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
  if (!mediaObserved || !inputs.localPublicationsEncrypted) {
    // (a) holds but (b) not yet satisfied for a publishing participant, or
    // one of OUR OWN publications is not on record as GCM — bounded amber
    // (the session arms the 10 s escalation → loud, R2-2, and republishes
    // the local declaration).
    return "resecuring";
  }

  // Verification gate (c).
  const allVerified = inputs.rosterVerified.every((v) => v);
  return allVerified ? "e2ee" : "e2ee_unverified";
}

/**
 * ME-10 terminal-loud (slice 6.5): the call FAILED to secure — the banner
 * offers the blocking Leave / Stay-unencrypted choice, plus Reset encryption
 * on a store-owner mismatch.
 *
 * Two shapes count. `negotiating` is the original one: retry exhaustion or a
 * loud failure while the verdict was still pending. `mode === undefined` with
 * a latched error is the same state seen one step earlier: a refusal thrown
 * inside establish() (the store-owner mismatch is exactly this) fails the
 * session before it ever emits a mode verdict, so the UI's mode signal still
 * reads undefined — requiring `negotiating` made the banner, and with it the
 * only Reset-encryption control in a call, unreachable on precisely the
 * install it was built for. The latched-error requirement keeps this off
 * web/plaintext calls: their chip also reads not_encrypted (open-group
 * attribution, no session), but nothing ever latches there.
 *
 * A loud verdict that lands AFTER the mode reached `e2ee` is folded into the
 * first shape by the session, not widened here: `loudModeFallback` drops the
 * mode back to `negotiating` (re-asserting the negotiating publish gate in
 * lockstep), so the same banner, the same "Stay unencrypted" / Leave escape
 * and the same `confirmPlaintext` guard serve it.
 */
export function isTerminalLoud(
  mode: CallMode | undefined,
  chip: ChipState,
  latchedError: boolean,
): boolean {
  if (chip !== "not_encrypted") return false;
  if (mode?.kind === "negotiating") return true;
  return mode === undefined && latchedError;
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

/**
 * What opened a §4.4 rotation window, which decides how long it stays
 * "known" (`rotationWindowMs`):
 *  - `grace` — an Add-driven local key install: the sender keeps the old key
 *    for the Add-grace, then everyone needs the commit to propagate;
 *  - `immediate` — a Remove-driven / first / fail-safe install: only the
 *    propagation settle;
 *  - `arbitration` — this member just SUBMITTED a commit for epoch N+1 and
 *    is awaiting the DS verdict. Whoever wins that epoch, its keys are not
 *    installed here yet, and if the winner is another member's Remove it
 *    switches its send key IMMEDIATELY on winning while OUR copy of the
 *    winning commit sits queued behind the per-group lock until our own
 *    submit returns 409 Lost. The loser therefore eats the winner's
 *    new-index frames BEFORE it can have processed the commit — and the two
 *    windows above are opened by that very processing, so they can never
 *    cover it. Measured live 2026-09-06 on a three-party call with member
 *    churn: the member that lost three leave-grace Remove races latched a
 *    terminal NOT-ENCRYPTED chip with no error of its own, while it kept
 *    decrypting everyone and everyone kept decrypting it.
 */
export type RotationWindowOpener = "grace" | "immediate" | "arbitration";

export interface RotationWindowBounds {
  /** The Add-grace the sender holds the old key for (`ADD_GRACE_MS`). */
  addGraceMs: number;
  /** Commit-propagation settle past any grace (`ROTATION_SETTLE_MS`). */
  settleMs: number;
  /** The bound on one submit round trip (`SUBMIT_TIMEOUT_MS`). */
  submitTimeoutMs: number;
}

/**
 * How long a rotation window stays known, by what opened it. An
 * `arbitration` window must outlast the submit round trip plus the inline
 * rebase that follows a Lost, so it is sized to the submit bound plus the
 * settle; the install that ends the rotation re-opens the window with its
 * own (shorter) `grace`/`immediate` length, so the long window never
 * outlives the rotation it covers by more than the settle.
 */
export function rotationWindowMs(
  opened: RotationWindowOpener,
  bounds: RotationWindowBounds,
): number {
  switch (opened) {
    case "grace":
      return bounds.addGraceMs + bounds.settleMs;
    case "immediate":
      return bounds.settleMs;
    case "arbitration":
      return bounds.submitTimeoutMs + bounds.settleMs;
  }
}

/**
 * The mode a session drops to when a LOUD verdict latches, or null to keep
 * the current mode.
 *
 * Only `e2ee` moves: a loud latch there (a failed commit, a media-plane
 * missing key outside every window, a destroyed envelope, a failed
 * self-enrolment re-check) left the chip red with NO banner and no way out —
 * `isTerminalLoud` renders the Leave / Stay-unencrypted banner for
 * `negotiating` (or no verdict yet) only, and `confirmPlaintext` guards its
 * terminal escape on `negotiating` too. Dropping to `negotiating` through the
 * session's `#setMode` also re-asserts the negotiating publish gate, so the
 * banner's "your audio and video stay paused" is true (fail-closed, I3): a
 * session that can no longer vouch for the group must not keep publishing as
 * if it could.
 *
 * Every other mode keeps: `negotiating`/`undefined` already render the
 * terminal banner; `mixed` and `interlude` carry their own banners whose
 * buttons run the same native-confirmed plaintext path; `off` is a plain
 * voice call and `call_full` is terminal.
 */
export function loudModeFallback(mode: CallMode): CallMode | null {
  return mode.kind === "e2ee" ? { kind: "negotiating" } : null;
}

/**
 * The mode label a session may WRITE while a loud verdict is latched.
 *
 * `loudModeFallback` covers the ENTRY into loud: it drops `e2ee` to
 * `negotiating` so the terminal banner and its Leave / Stay-unencrypted
 * escape render. The mode machine keeps running underneath, though, and any
 * `mix_detected` → `mix_cleared` cycle under the latch (a peer's leave +
 * rejoin, a browser peer joining and leaving) ends in the T2 warm resume,
 * which wrote `e2ee` back — publish gate empty, chip still red from the
 * latched error, `isTerminalLoud` false, `confirmPlaintext` refusing.
 * Measured live 2026-09-07 on the L3 receiver after the publisher's rejoin:
 * red chip, no banner, no way out but leaving the call, and the pause the
 * banner had promised silently lifted.
 *
 * So while latched, `e2ee` is unreachable: it folds to `negotiating`, whose
 * `#setMode` lockstep re-asserts the negotiating publish gate (the banner's
 * "your audio and video stay paused" is true again) and whose shape
 * `isTerminalLoud` renders. Every other label passes: `mixed` and `interlude`
 * carry their own banners with the same native-confirmed escape, `off` is a
 * plain call, `call_full` is terminal. A red chip therefore always has a
 * banner with an escape — by construction, not by the order timers happen to
 * fire.
 */
export function modeUnderLoudLatch(
  next: CallMode,
  loudLatched: boolean,
): CallMode {
  return loudLatched && next.kind === "e2ee" ? { kind: "negotiating" } : next;
}

/**
 * Where a loud latch came from. Only a MEDIA latch — a LiveKit
 * `encryptionError` or a native frame-key error, classified outside every
 * rotation window or escalated from a re-securing that never resolved — can
 * heal (`loudHealVerdict`). A CONTROL latch (a failed join ladder, a
 * destroyed envelope, local publications the SFU keeps recording as
 * plaintext, a terminal session failure) says nothing a later epoch could
 * disprove; it stays terminal until the group re-establishes or the call ends.
 */
export type LoudLatchOrigin = "media" | "control";

/**
 * What the session knows NOW about one device whose frames the latch could
 * have come from: the device the error named when the worker's message
 * carried one, else every remote device that was in the call at latch time
 * (LiveKit's worker re-wraps its `CryptorError` into a plain `Error` before
 * posting it, and only the MissingKey message embeds the identity — the
 * decoy/withheld-key failure reads `InvalidKey: Decryption failed: …`).
 */
export interface LoudHealPeer {
  /** The device (its primary or any screen leg) is in the SFU right now. */
  present: boolean;
  /** It was observed ADDED to the MLS roster after the latch was set. */
  readdedAfterLatch: boolean;
  /**
   * It publishes at least one track now and NONE of them existed at latch
   * time. New tracks decrypt at the new key index, which the install's
   * `setKey` re-validated, so a persisting failure re-emits inside the
   * settle. A device publishing nothing is neither gone nor re-keyed.
   */
  sidsAllNew: boolean;
}

/** The witnesses a latched session must hold before its loud latch may heal. */
export interface LoudHealInputs {
  origin: LoudLatchOrigin;
  /** Epoch-keys-applied counter at the moment the latch was set. */
  latchedInstallSeq: number;
  /** The same counter now — a strictly larger value means a new epoch's keys. */
  installSeq: number;
  /**
   * A media-plane error the install did not supersede: a hard error (the key
   * itself wrong) at or after the reference taken BEFORE the installer ran,
   * or a missing key for a pair no install has covered
   * (`MediaErrorLedger.errorSince`).
   */
  errorSinceInstall: boolean;
  /**
   * The settle has run since BOTH the last key install and the latest
   * observed re-Add of a PRESENT witness (`latestPresentAddedAt`). Leg 9 of
   * the 2026-09-07 sitting: a probe armed by the Remove epoch's install fired
   * the instant its own reconcile observed the rejoiner's Add, before one
   * frame under the new key had been judged, and healed over a key that was
   * still wrong.
   */
  settleElapsed: boolean;
  /** A FRESH reconcile reported neither non-enrolled nor pending identities. */
  rosterConsistent: boolean;
  /**
   * Every device the failure could have come from. Empty means the latch
   * has no witness at all (no remote was present) and must hold.
   */
  peers: readonly LoudHealPeer[];
  /**
   * The latch's ORIGINATING error was a decode missing key, and this side has
   * since pushed that exact pair to the worker in an install STRICTLY AFTER
   * the latch (`pairFilledAtSeq > latchedInstallSeq`).
   *
   * That `setKey` calls `resetKeyStatus` for the index the failure named, so
   * the index is live again and any surviving failure re-emits inside the
   * settle — which `errorSinceInstall` catches above. It is the one witness a
   * BYSTANDER latch can ever produce: a missing key names its participant, so
   * `peers` is the device that raised it, and a bystander never leaves and
   * never re-publishes, which is why leg 3a stayed red for the whole call.
   *
   * Strictly-after is what the reverted attempt got wrong: it asked whether
   * the pair had EVER been pushed, which is true from the moment the install
   * posts — and the worker raises a missing key precisely BECAUSE that
   * `setKey` had not been processed yet, so the clause was already true at
   * latch time and healed the latch it was meant to judge.
   *
   * It ALSO requires that the sender has no OTHER index still unfilled
   * (`MediaErrorLedger.unfilledPairs`). Re-validating the index the latch
   * named proves nothing if the sender has since moved on to another we never
   * got: `errorSinceInstall` cannot see that peer, because the ledger's
   * advance rule forgives the later pair, and the worker emits nothing more
   * after silencing an index. Without that second half this clause substitutes
   * for the peer witness in exactly the case the peer witness exists for
   * (media-E2EE review, 2026-09-08).
   */
  originatingPairRefilled?: boolean;
}

/**
 * Whether a loud latch may heal. `heal` ONLY when the group RE-KEYED past the
 * failure, the media plane stayed clean through the settle, the roster is
 * consistent, and the FAILING PEER'S situation provably changed. Anything
 * short of that is `hold`, and the latch stays terminal exactly as before.
 *
 * A mere recovery (the missing key arriving, `noteEncryptionRecovered`) still
 * never heals — R1 of the 2026-09-07 L3 leg, kept on purpose: it proves
 * nothing about why frames failed.
 *
 * Why the peer-scoped witness (media-E2EE review, 2026-09-07): the LiveKit
 * worker emits ONE error for a key index and then marks it invalid, after
 * which every frame at that index is dropped SILENTLY; a new epoch's install
 * re-validates only the index it installs. A peer still sending at an OLD
 * index after the re-key therefore produces zero errors and zero decrypts —
 * the exact class the latch exists for — so "no error since the install" on
 * its own would heal over silently dropped media. It is sufficient only once
 * EVERY device the failure could have come from is gone, or was re-added
 * after the latch and publishes only tracks that did not exist at latch time
 * (those decrypt at the fresh index; if they fail, the error re-emits inside
 * the settle and holds). When the error named its device the set is that one
 * device; otherwise it is every remote present at latch time — the same set
 * in a 1:1 call. No device at all: hold.
 *
 * Both chip planes are required (invariant 11): control (a verified commit
 * installed a new epoch, the roster matches the SFU set) and media (no decrypt
 * error through the settle, the failing peer's frames gone or re-keyed). A
 * hostile DS cannot mint the witness — the keys come from a natively verified
 * commit, the roster must match the SFU set, the errors are local truth.
 */
/**
 * The latest observed re-Add among the PRESENT witnesses of a media latch
 * (0 when none). The heal settle must run from it as well as from the last
 * key install; an absent witness does not count — its frames are gone.
 */
export function latestPresentAddedAt(
  witnesses: readonly { present: boolean; addedAt?: number }[],
): number {
  let latest = 0;
  for (const w of witnesses) {
    if (w.present && w.addedAt !== undefined && w.addedAt > latest) {
      latest = w.addedAt;
    }
  }
  return latest;
}

export function loudHealVerdict(inputs: LoudHealInputs): "heal" | "hold" {
  if (inputs.origin !== "media") return "hold";
  if (inputs.installSeq <= inputs.latchedInstallSeq) return "hold";
  if (inputs.errorSinceInstall) return "hold";
  if (!inputs.settleElapsed) return "hold";
  if (!inputs.rosterConsistent) return "hold";
  if (inputs.peers.length === 0) return "hold";
  // Behind the empty-witness hold, never in front of it.
  if (inputs.originatingPairRefilled) return "heal";
  return inputs.peers.every(
    (peer) => !peer.present || (peer.readdedAfterLatch && peer.sidsAllNew),
  )
    ? "heal"
    : "hold";
}

// ---- media-plane errors vs. the heal's install reference --------------------

/**
 * The key-pair id `<livekit identity>@<key index>` a frame key or a worker
 * error refers to. A screen leg is its own pair: native emits a `:screen`
 * entry for every member (`mlsCallKeys.ts`) and the worker keys a leg's
 * cryptor under the leg's identity.
 */
export function keyPairId(identity: string, keyIndex: number): string {
  return `${identity}@${keyIndex}`;
}

/** The worker's key ring (livekit-client default `keyringSize`). */
export const WORKER_KEYRING_SIZE = 16;

/**
 * What a media-plane error says about the key it failed at. The worker posts
 * `${reason}: ${message}` as a plain `Error` (`setupCryptorErrorEvents`); the
 * decode path's MissingKey — `missing key at index N for participant X` — is
 * the one shape that names both halves of the pair. The worker raises it only
 * while it holds NO key at that index, and the pair's `setKey` resets the
 * index's failure count (`resetKeyStatus`), so an install of that pair
 * provably supersedes it. Everything else — InvalidKey (the key it holds is
 * wrong), the encode path's missing key, a native key-path failure — reports
 * a key that stays wrong until the next epoch: `hard`. An index outside the
 * ring is not a key pair at all (a plaintext frame's last byte read as an
 * index; the worker's failure count for it is `NaN`, so it re-emits every
 * frame): `hard` too.
 */
export type MediaErrorClass =
  | { kind: "missing_key"; identity: string; pair: string }
  | { kind: "hard" };

export function classifyMediaError(error: unknown): MediaErrorClass {
  const message =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown }).message
      : undefined;
  const missing =
    typeof message === "string"
      ? /^MissingKey: missing key at index (\d+) for participant (\S+)/.exec(
          message,
        )
      : null;
  if (!missing) return { kind: "hard" };
  const index = Number(missing[1]);
  if (index >= WORKER_KEYRING_SIZE) return { kind: "hard" };
  return {
    kind: "missing_key",
    identity: missing[2],
    pair: keyPairId(missing[2], index),
  };
}

/**
 * The media-plane error record the heal probe judges against its install
 * reference (`errorSinceInstall`). Two ledgers, because the worker's two
 * failure shapes mean different things after a re-key:
 *
 *  - A HARD error marks its key index invalid — one error, then silent drops
 *    (failureTolerance 0) — until a `setKey` for that index re-validates it:
 *    the next epoch's install, or LiveKit's own replay of every key it knows
 *    on each worker `enable` ack (a remote publish, a reconnect). Either
 *    way a peer still failing there re-emits on its next frame, which lands
 *    after the reference and holds — fail-closed for this ledger, and a
 *    re-set of an already-set pair changes no missing-key record (the slot
 *    was never empty). Its stamp is compared against a reference taken
 *    BEFORE the installer
 *    runs. `MlsKeyProvider.#install` awaits `importKey` per entry after each
 *    `onSetEncryptionKey` post, and an InvalidKey landing between those
 *    awaits used to be stamped before a reference taken after the install
 *    resolved: the index went silent and the probe healed over it 10 s later
 *    (media-E2EE review of `9e5fa880`). With the reference ahead of the
 *    install, every error during it counts — conservative by construction.
 *    Stamps and reference come from one MONOTONIC clock (`performance.now`):
 *    a wall clock stepping back between the two would re-open the window.
 *  - A MISSING key names its sender and is superseded by the next install of
 *    that SENDER that COMPLETES after it was observed: the worker processed
 *    the frame before the `setKey` message or it would not have raised
 *    MissingKey, and the `setKey` resets the index. Superseding by identity
 *    rather than by exact pair is deliberate: a device joined by Welcome
 *    hears the members' frames at epoch E before it holds any key and
 *    installs E+1 first (native snapshots `previous` only across a commit it
 *    applied itself), so `P@E` would never be covered and every later latch
 *    on that device would hold for the life of the group — the R2 heal inert
 *    on exactly the receiver role the live legs use (review of e2163ead,
 *    H1). The install proves this side holds the sender's current index;
 *    whether its older-index frames were lost is the SID witness's question.
 *    Time-ordered, not "ever installed": a missing key that lands AFTER the
 *    sender's install completed and names an index that install did NOT set
 *    is an index this side never got — the one local sign that a commit was
 *    withheld from it (re-review, M1) — and stands until an install of that
 *    sender that ADVANCES us (fills a slot we did not hold) proves we caught
 *    up. A replay of keys we already hold, which LiveKit performs on every
 *    worker `enable` ack, is not catching up and supersedes nothing. One that names a pair the sender's
 *    latest install DID set is the join race whenever it lands: the worker
 *    raises MissingKey only while the slot is empty, `setKey` fills it and
 *    no path ever empties a slot again for the life of the worker, so the
 *    frame was judged before the worker processed that `setKey` — superseded
 *    (second re-review, the exact discriminator). A missing key for a sender
 *    never installed at all is one at an index this side does not hold, its
 *    index silenced after the one error: it holds the heal while the sender
 *    is still in the SFU (`errorSince`'s `present`), regardless of when it
 *    landed, and stops mattering once the sender is gone.
 *  - The worker holds no ack for `setKey`: a `deriveKeys` failure inside the
 *    worker leaves the slot empty with nothing posted, and the one MissingKey
 *    it would have answered is treated as superseded here. Only malformed key
 *    material reaches that path (the §4.2 HKDF import guards it); a worker
 *    that acknowledges `setKey` should gate `noteInstalled` on the ack.
 */
export class MediaErrorLedger {
  /** `-Infinity` until an error lands: "no error yet" must never read as at-or-after a reference of 0. */
  #hardErrorAt = -Infinity;
  /** Missing-key pairs no install has covered yet, by the time observed. */
  #missing = new Map<string, { identity: string; at: number }>();
  /**
   * Per sender since the last `reset`: every key pair this side has pushed to
   * the worker (which mirrors the worker's FILLED ring slots — `setKeySet`
   * only ever assigns, the auto-ratchet is off at `ratchetWindowSize: 0`, and
   * nothing empties a slot), and when it last filled a slot it did not
   * already hold.
   */
  #installed = new Map<
    string,
    { advancedAt: number; pairs: Map<string, number> }
  >();
  /**
   * Every missing-key pair EVER observed, by sender — never swept by the
   * advance rule, so `unfilledPairs` can answer "is this sender still sending
   * at an index we do not hold?" exactly.
   *
   * `#missing` cannot answer it. Its supersession forgives a pair once an
   * install ADVANCED us for that sender (`at <= advancedAt`), which exists for
   * the Welcome joiner that heard `P@E` before holding any key and can never
   * fill that slot (H1) — but it also forgives the index a sender is
   * CURRENTLY using when we are two epochs behind it. Then `errorSince` reads
   * clean while the worker drops that peer's every frame at an index it
   * marked invalid, which is precisely the silent drop the heal's peer
   * witness exists to catch (media-E2EE review, 2026-09-08).
   */
  #everMissing = new Map<string, Set<string>>();

  /** Whether `pair` from `identity` is answered by an install since. */
  #superseded(identity: string, pair: string, at: number): boolean {
    const rec = this.#installed.get(identity);
    if (!rec) return false;
    // A pair we have pushed: that ring slot has been full ever since, and the
    // worker raises MissingKey only for an EMPTY slot, so the frame was judged
    // before it processed that setKey.
    if (rec.pairs.has(pair)) return true;
    // Otherwise only an install that ADVANCED us — filled a slot we did not
    // hold — proves we caught up with the sender. LiveKit re-pushes every key
    // it already knows on each worker `enable` ack; such a replay changes
    // nothing about the index that was missing and must not supersede it.
    return at <= rec.advancedAt;
  }

  /** Record a media-plane error observed at `now` (monotonic clock). */
  noteError(error: unknown, now: number): MediaErrorClass {
    const cls = classifyMediaError(error);
    if (cls.kind === "hard") this.#hardErrorAt = now;
    else {
      const seen = this.#everMissing.get(cls.identity) ?? new Set<string>();
      seen.add(cls.pair);
      this.#everMissing.set(cls.identity, seen);
      if (!this.#superseded(cls.identity, cls.pair, now)) {
        this.#missing.set(cls.pair, { identity: cls.identity, at: now });
      }
    }
    return cls;
  }

  /**
   * Record the entries an install pushed to the worker, completing at
   * `completedAt` (the same monotonic clock as the error stamps).
   */
  noteInstalled(
    entries: readonly { livekit_identity: string; key_index: number }[],
    completedAt: number,
    installSeq = 0,
  ): void {
    const bySender = new Map<string, Set<string>>();
    for (const entry of entries) {
      const pairs = bySender.get(entry.livekit_identity) ?? new Set<string>();
      pairs.add(keyPairId(entry.livekit_identity, entry.key_index));
      bySender.set(entry.livekit_identity, pairs);
    }
    for (const [identity, pairs] of bySender) {
      const rec = this.#installed.get(identity) ?? {
        advancedAt: -Infinity,
        pairs: new Map<string, number>(),
      };
      let advanced = false;
      for (const pair of pairs) {
        if (!rec.pairs.has(pair)) {
          rec.pairs.set(pair, installSeq);
          advanced = true;
        }
      }
      if (advanced) rec.advancedAt = completedAt;
      this.#installed.set(identity, rec);
    }
    for (const [pair, record] of this.#missing) {
      if (this.#superseded(record.identity, pair, record.at)) {
        this.#missing.delete(pair);
      }
    }
  }

  /**
   * Whether an error the install at `installRef` did not supersede stands: a
   * hard error at or after the reference, or a missing key for a sender no
   * install has covered that is still `present` in the SFU.
   */
  errorSince(
    installRef: number,
    present: (identity: string) => boolean = () => true,
  ): boolean {
    if (this.#hardErrorAt >= installRef) return true;
    for (const record of this.#missing.values()) {
      if (present(record.identity)) return true;
    }
    return false;
  }

  /**
   * Whether this side has pushed this EXACT pair to the worker, and the
   * install sequence at which it first did (`undefined` if never).
   *
   * This is the only fact that answers a missing key at that index, and it is
   * deliberately narrower than `#superseded`: that rule also accepts an
   * install which merely ADVANCED us past the index (`at <= advancedAt`),
   * which is right for `errorSince` — where `loudHealVerdict`'s peer witness
   * still has to clear — and WRONG anywhere it is the only test. The worker
   * marks an index invalid after one failure (`failureTolerance: 0`) and
   * drops every later frame at it SILENTLY; only a `setKey` for that exact
   * index calls `resetKeyStatus` and re-validates it, and with the ring at 16
   * slots nothing rewrites it for sixteen epochs. A sender two epochs ahead
   * of us therefore satisfies `advancedAt` while its frames keep being
   * dropped at an index we never filled (media-E2EE review, 2026-09-08).
   */
  pairFilledAtSeq(identity: string, pair: string): number | undefined {
    return this.#installed.get(identity)?.pairs.get(pair);
  }

  /**
   * Pairs this sender has failed at that this side has STILL not filled —
   * indexes the worker marked invalid and that only a `setKey` for that exact
   * index re-validates. Non-empty means the sender may be sending into one of
   * them right now, silently dropped, with no further error to prove it.
   *
   * Deliberately not derived from `#missing`: see `#everMissing`.
   */
  unfilledPairs(identity: string): string[] {
    const seen = this.#everMissing.get(identity);
    if (!seen) return [];
    const filled = this.#installed.get(identity)?.pairs;
    return [...seen].filter((pair) => !filled?.has(pair));
  }

  /** The missing-key pairs still uncovered by an install (diagnostics). */
  uncoveredPairs(): string[] {
    return [...this.#missing.keys()];
  }

  /** Forget the hard-error stamp (a healed latch). */
  forgetHardError(): void {
    this.#hardErrorAt = -Infinity;
  }

  /** Forget everything: the group, and with it every key index, is replaced. */
  reset(): void {
    this.#hardErrorAt = -Infinity;
    this.#missing.clear();
    this.#installed.clear();
    this.#everMissing.clear();
  }
}

/**
 * What the session does when a FRESH reconcile reports a non-enrolled
 * participant (the roster is not consistent), by the current mode:
 *
 *  - `declare` — declare the mix: assert the `mixed` publish pause and set
 *    the `mixed` label (the 6.4 `#onMixDetected` mechanics), so the banner
 *    names the participant and offers the native-confirmed downgrade. From
 *    `e2ee` this is T1. From `negotiating` it is T0c — a JOINER that lands in
 *    a call which already holds a non-enrolled participant. That case used to
 *    be gated on "E2EE already enabled", which a joiner never is (enable
 *    waits for a consistent roster), so it sat in `negotiating` forever:
 *    publishing paused by the negotiating gate, chip amber, no banner, no
 *    way to consent to plaintext — parked muted behind a chip. From `mixed`
 *    it re-declares (idempotent).
 *  - `transition` — run `mix_detected` through the machine: in an interlude
 *    the mode does not change and only a pending re-upgrade is cancelled.
 *  - `ignore` — `off` (a plain voice call has no group to be consistent
 *    with) and `call_full` (terminal, auto-leaving).
 */
export function mixDetectedAction(
  mode: CallMode,
): "declare" | "transition" | "ignore" {
  switch (mode.kind) {
    case "negotiating":
    case "e2ee":
    case "mixed":
      return "declare";
    case "interlude":
      return "transition";
    case "off":
    case "call_full":
      return "ignore";
  }
}
