/**
 * The §3.4 call-mode transition machine + the §4.4 dual-gated chip + the ctl
 * payload parser — the PURE, session-independent core of slice 6.5's downgrade
 * UX, extracted from `mlsCallSession`/`state.tsx` so every transition and the
 * chip precedence table are unit-testable in isolation (the house no-vitest
 * split; this module must stay dependency-free so `node --test` can load it —
 * the one import below is TYPE-ONLY and is erased, so nothing is loaded).
 *
 * Nothing here performs I/O or touches a Room: `callModeTransition` returns the
 * NEXT mode + the EFFECTS the session must run; `chipState` derives the visible
 * indicator from a snapshot of inputs; `parseCtlPayload` validates a received
 * ctl-announce (default-closed forward-compat). The session owns the imperative
 * glue (native confirm dialog, pause gate, announce courier, timers).
 */

import type { CallEncryptionReadiness } from "./e2eeDeviceReadiness.ts";

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
  /**
   * The channel has an open MLS group — the FE-7 probe, answered ONCE at
   * connect and never re-asked. That staleness is why it cannot be the only
   * term below.
   */
  channelHasOpenGroup: boolean;
  /**
   * This shell COULD encrypt calls and this install is not set up for it —
   * `encryptionSetupAvailable(readiness)`. A LOCAL fact, so unlike the probe
   * it is always current. Without it a never-enrolled desktop that joined
   * before the group opened stayed on chip `none` for the whole call — silent
   * on the side whose media is in the clear, while every peer paused behind
   * the mixed banner naming it (media-e2ee-reviewer, HIGH-4).
   */
  deviceNeedsSetup: boolean;
  /**
   * At least one OTHER participant is device-qualified on the SFU, i.e.
   * someone here can encrypt. LIVE — re-read on every participants-version
   * bump — which is what makes it usable where the open-group probe is not.
   *
   * It is what keeps `deviceNeedsSetup` from shouting on a call where nobody
   * is encrypting: `shellSupported` is true on every Tauri desktop and every
   * native Android build, not just the platforms media E2EE has shipped on,
   * so an unqualified local term would have put a red chip and an
   * undismissable strip on EVERY call for every install that never turned
   * encryption on — including plain calls with nothing to downgrade
   * (media-e2ee-reviewer round 3, finding 2).
   */
  peerCouldEncrypt: boolean;
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
  // NO SESSION. Two independent reasons this is a downgrade rather than a
  // quiet plain call, and either is enough:
  //
  //  (a) the channel HAS an open group — someone is encrypting and we are not.
  //      Covers ME-7/R2-4 (a capable shell whose session failed to construct,
  //      a downgrade the user can't see) and the §0.2 #9 self-attribution for
  //      a shell that can never encrypt. The old `capableAndEnabled` split of
  //      this arm is gone: both halves always returned the same chip, and the
  //      BANNER is what needs them told apart (`callBannerState` reads the
  //      readiness).
  //  (b) this device could encrypt, is not set up here, and someone else in
  //      the call CAN encrypt. Local and live, so unlike (a) it cannot go
  //      stale when the group opens after the probe answered — and unlike an
  //      unqualified local term it says nothing on a call where there is no
  //      encryption to be left out of.
  if (
    !inputs.hasSession &&
    (inputs.channelHasOpenGroup ||
      (inputs.deviceNeedsSetup && inputs.peerCouldEncrypt))
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

// ---- Which banner a chip must carry (the no-dead-end invariant) ------------

/**
 * The banner the call card renders, or `none`.
 *
 * - `mixed` / `interlude` — the §3.4 downgrade states. Publishing is paused
 *   (mixed) or explicitly resumed in plaintext (interlude); the escape is
 *   "Turn off encryption" / "Resume unencrypted".
 * - `device_not_set_up` — this shell COULD encrypt calls but this install is
 *   not set up for the signed-in account: never enrolled, wiped, or holding a
 *   device the server refuses. The cause and the remedy are the DEVICE's, so
 *   it does not borrow the call-failure copy. Whether publishing is paused
 *   differs by cause (see `callEncryptionCapable`), which is why the caller —
 *   not this rule — decides whether to offer the plaintext release.
 * - `device_unsupported` — this shell can never encrypt calls (a browser, an
 *   unaudited build). Nothing to set up; the escape is Leave.
 * - `terminal_loud` — ME-10: the DEVICE is fine and the CALL failed to secure.
 *   Publishing is held by the `negotiating` gate; the escape is Leave / Stay
 *   unencrypted (plus Reset encryption on a store-owner mismatch). Requires a
 *   LATCHED error, because that is what makes its copy — "your audio and video
 *   stay paused" — true.
 * - `unencrypted_notice` — the honest floor: a red chip nothing above claimed,
 *   with nothing latched, so no pause may be promised and no release offered.
 *   Unreachable today (every red chip on a `ready` device latches); it exists
 *   so the backstop cannot lie the way the previous one did.
 */
export type CallBannerKind =
  | "none"
  | "mixed"
  | "interlude"
  | "terminal_loud"
  | "device_not_set_up"
  | "device_unsupported"
  | "unencrypted_notice";

export interface CallBannerInputs {
  /** The §4.4 chip, from `chipState`. */
  chip: ChipState;
  /** The §3.4 call mode (undefined before any verdict). */
  mode: CallMode | undefined;
  /**
   * A structured call-encryption error is latched.
   *
   * Load-bearing, not decoration: on every reachable path the latch and the
   * held `negotiating` gate are asserted together (`sessionSetupDecision`'s
   * `hold_loud`, `#onLoud`), so it is the term that decides whether a banner
   * may claim publishing is paused. It was accepted and ignored once, which
   * is exactly how a red strip came to promise a pause over a live mic
   * (media-e2ee-reviewer, MEDIUM-1).
   */
  latchedError: boolean;
  /**
   * WHY this device is or is not encrypting, from `e2eeDeviceReadiness` —
   * the whole four-valued reason, deliberately not a boolean. Collapsing it
   * made `unsupported` ("this app can't encrypt calls", a POSITIVE fact) the
   * fallback for "we don't know", which is the most reassuring and least
   * actionable thing to say to someone whose call just failed
   * (media-e2ee-reviewer, F4).
   */
  readiness: CallEncryptionReadiness;
}

/**
 * THE INVARIANT: `chipState(x) === "not_encrypted"` implies
 * `callBannerState(...) !== "none"`, for every readiness. A red chip always
 * carries a banner and an escape — enforced by an exhaustive spec over the
 * chip's whole input space, not by inspection.
 *
 * It did not hold before. `isTerminalLoud` requires a latched error, and the
 * chip's two NO-SESSION branches (ME-7 "capable, no session, open group" and
 * the §0.2 #9 self-attribution) latch nothing — nobody attempted encryption,
 * so nothing could fail. Those were read as attribution rather than failure and
 * deliberately given no banner. For a browser that reading is right; for a
 * desktop install that could encrypt and simply is not set up it is a downgrade
 * with a one-click remedy the user is never shown, which is the §7.4
 * observation this closes.
 *
 * 🔴 The invariant is about the chip, and the chip is not the whole story: both
 * no-session branches are gated on `channelHasOpenGroup`, a server probe run
 * ONCE at connect. A device that cannot encrypt, alone in a channel with no
 * group yet, gets chip `none` and therefore no banner from this rule — so a
 * device that must not go quiet has to stay E2EE-CAPABLE and latch, which puts
 * its chip red through `latchedError` with no probe involved. That is what
 * `callEncryptionCapable` does for `owned_elsewhere`, and it is the reason it
 * is not simply "not an E2EE call". The remaining case — a never-enrolled
 * install (`needs_setup`) in a channel whose group opens after the probe
 * answered — is pre-existing on main and recorded as a follow-up, with a spec
 * below that pins the gap rather than letting it hide.
 */
export function callBannerState(inputs: CallBannerInputs): CallBannerKind {
  const mode = inputs.mode?.kind;
  if (mode === "mixed") return "mixed";
  if (mode === "interlude") return "interlude";
  if (inputs.chip !== "not_encrypted") return "none";

  // The device arms outrank the loud one: when the reason this call is not
  // encrypted is the device, saying "this call could not be secured" and
  // offering only a per-call escape sends the user round the loop again on
  // their next call.
  switch (inputs.readiness) {
    case "unsupported":
      return "device_unsupported";
    case "needs_setup":
    case "owned_elsewhere":
      return "device_not_set_up";
    case "ready":
      break;
  }

  // A `ready` device with a red chip is a CALL failure. Everything left lands
  // here — the two `isTerminalLoud` shapes, the `call_full` auto-leave, and any
  // red state a future change invents — so nothing can return `none` from here
  // by omission. `isTerminalLoud` is still the name for the two shapes it
  // always covered (`callTerminalLoud`), not the gate for this.
  //
  // The latch is what makes the loud copy true. Every reachable red chip on a
  // `ready` device has one: `sessionSetupDecision` latches on every
  // capable-but-sessionless arm, `#onLoud` latches before `call_full`, and a
  // session that reached `failed` came through `#onLoud`. An unlatched one
  // would mean no gate is held, so it gets the floor instead of a promise.
  return inputs.latchedError ? "terminal_loud" : "unencrypted_notice";
}

/**
 * Whether the banner's plaintext release would release anything.
 *
 * With a session the session owns it (`confirmPlaintext`). Without one it is
 * the R2-4 hold, whose terms `canConfirmNoSessionPlaintext` checks; the two
 * here stand in for all of them, because the hold latches the error and
 * asserts the `negotiating` gate in the same step and the only thing that
 * empties the gate is `#confirmNoSessionPlaintext`, which flips the mode to a
 * confirmed interlude — a different banner.
 *
 * Keeps the button off the banners where nothing is paused (a never-enrolled
 * device, a shell that cannot encrypt), where pressing it is a silent no-op,
 * and off `call_full`, which is terminal in the session so `confirmPlaintext`
 * returns immediately. Lives here rather than on `Voice` because it is the
 * rule that decides whether a user is offered a plaintext downgrade, and the
 * Voice class cannot be loaded under `node --test`.
 */
export interface PlaintextReleaseInputs {
  mode: CallMode | undefined;
  hasSession: boolean;
  /** The call's connect-time capability snapshot. */
  e2eeCapable: boolean;
  latchedError: boolean;
}

export function plaintextReleaseAvailable(
  inputs: PlaintextReleaseInputs,
): boolean {
  const mode = inputs.mode?.kind;
  if (mode === "call_full") return false;
  if (inputs.hasSession) {
    // With a session the session owns the release — but only where it has
    // something to release. `mixed` and `interlude` are its own downgrade
    // states and `negotiating` holds the gate; anything else needs the latch
    // that proves a gate is held, or `confirmPlaintext` returns immediately
    // and the button is the silent no-op this rule exists to prevent.
    return (
      mode === "mixed" ||
      mode === "interlude" ||
      mode === "negotiating" ||
      inputs.latchedError
    );
  }
  return inputs.e2eeCapable && inputs.latchedError;
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
  /** Any media-plane error (LiveKit or native key path) since that install. */
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
  return inputs.peers.every(
    (peer) => !peer.present || (peer.readdedAfterLatch && peer.sidsAllNew),
  )
    ? "heal"
    : "hold";
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
