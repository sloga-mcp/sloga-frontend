import { type Accessor, type Setter, batch, createSignal } from "solid-js";

import type { Room } from "livekit-client";

import { CONFIGURATION } from "@revolt/common";
import { setKeybindSuppression } from "@revolt/keybinds/suppress";
import { participantUserId } from "@revolt/ui/components/features/voice/participantIdentity";

/**
 * Remote desktop control during screen share — the renderer half.
 *
 * # What this module is, and what it deliberately is not
 *
 * It routes OPAQUE SEALED BYTES between the LiveKit data channel and native,
 * and it never parses a packet or sees a key. Sealing and opening both happen
 * in the desktop shell under a key derived from an ephemeral X25519 exchange
 * that this code only ever handles the *public* halves of.
 *
 * That is not a stylistic choice. `e2ee_rc_open_apply` takes sealed bytes and
 * nothing else, enforced by `build.rs` in the shell, because a plaintext
 * entry point would be reachable from ANY renderer code execution — stored
 * XSS, a compromised dependency, attached DevTools, the debug dev-origin
 * capability — with the crypto fully intact and never consulted, turning an
 * in-renderer bug into unattended keyboard-and-mouse control. So the AEAD
 * *is* the authorization for injection.
 *
 * # What this feature may NOT claim, and this UI must not imply
 *
 * 1. It is **not** protected against the Sloga server, and a compromised
 *    sharer-side renderer — this code — is cryptographically equivalent to a
 *    hostile server here, because the peer's public key necessarily crosses
 *    this hop. The approved public wording lives in
 *    `REMOTE_CONTROL_CLAIM_MSG` and concedes keystroke timing in the same
 *    sentence as confidentiality. Do not paraphrase it upward.
 * 2. The controller has **no authenticated feedback channel** in v1: the
 *    sharer→controller key is derived and immediately discarded, and the SFU
 *    grant is minted for the controller identity only, so a sharer→controller
 *    packet would be silently dropped by the SFU anyway. Nothing here can
 *    substantiate "you are in control". The video track is the primary
 *    signal; `secure_desktop` / `foreground_elevated` / `authenticated` from
 *    `rc_status` describe the SHARER'S machine and are only meaningful on the
 *    sharer's own side.
 */

/** LiveKit data-channel topic. Matches the shell's wire format. */
const RC_TOPIC = "rc";

/** Header field values, mirrored from the shell's `remote_control.rs`. */
const STREAM_RELIABLE = 1;
const STREAM_LOSSY = 2;

/**
 * Full-state keyframe cadence. The shell treats a gap in keyframes as the
 * ONLY sustain signal — a trickle of motion does not hold a session up — and
 * revokes after 10 s of silence, so this must keep running while idle.
 */
const KEYFRAME_INTERVAL_MS = 250;

/**
 * Sharer-side grant heartbeat cadence. The server's grace is 8 s per beat
 * (16 s at accept), and each beat RESETS the deadline to now + 8 s rather
 * than extending it — so a cadence equal to the grace is a knife edge where
 * one late tick expires the grant mid-session. Half the grace means a whole
 * tick can be lost (timer jitter, event-loop stall, one failed POST) and the
 * next one still lands inside the window. The route's bucket is 30 per 10 s.
 */
const HEARTBEAT_INTERVAL_MS = 4_000;

/**
 * How long heartbeats may keep the grant alive BEFORE the session has
 * authenticated. Covers the sharer reading the native `RcArm` dialog (native
 * caps it at 60 s) plus handshake-to-first-opened-packet slack. After this,
 * an unauthenticated session stops being heartbeated and the server's 8 s /
 * 16 s grace destroys the grant — see #startHeartbeat for why that gate
 * exists at all.
 */
const HEARTBEAT_AUTH_GRACE_MS = 75_000;

/**
 * Client-side offer expiry, matching the server's shipped
 * `REMOTE_CONTROL_OFFER_TTL_SECS` and native's pending-offer lifetime.
 *
 * Exported for the sharer side too (slice 1): an offer to someone who can
 * never accept — anyone not on the desktop app — is answered by nothing at
 * all, so the OUTBOUND side needs the same number to notice.
 */
export const REMOTE_CONTROL_OFFER_TTL_MS = 90_000;

/**
 * The approved claim wording, pinned verbatim. Rendered where a user decides
 * whether to hand over their machine.
 */
export const REMOTE_CONTROL_CLAIM =
  "Remote control input is end-to-end encrypted between the two participants' devices. " +
  "The Sloga server and the media server relay it and cannot read it, and no other " +
  "participant in the call can read or forge it. Packet sizes are padded to fixed " +
  "buckets, but the timing of your keystrokes and mouse activity is visible to the " +
  "server. The server introduces the two parties and is trusted to do so honestly: " +
  "this feature is not protected against a compromised Sloga server.";

// The letterbox-aware coordinate mapping lives in its own dependency-free
// leaf so Node's test runner can exercise it without Solid, LiveKit or the
// path aliases — see remoteControlMapping.ts and its spec.
export {
  classifyKey,
  isEditableTarget,
  isPanicCombo,
  normalizeToContentBox,
  wheelNotches,
} from "./remoteControlMapping";

import { releaseCause } from "./remoteControlMapping";

type Invoke = (command: string, args?: unknown) => Promise<unknown>;

function tauriInvoke(): Invoke | undefined {
  return (
    window as unknown as {
      __TAURI__?: { core?: { invoke?: Invoke } };
    }
  ).__TAURI__?.core?.invoke;
}

/**
 * Name WHY the server refused an offer, not merely that it did.
 *
 * Most refusals in `assert_offer_predicate` share one status, so the status
 * alone cannot separate `FeatureDisabled` from "sharer is not publishing
 * screen video" from `NotInVoiceChannel` — all three are 400, and they point
 * at three completely different things to go and fix (an operator flag, a
 * stale voice-ingress, a call that is not what it looks like). Only
 * `MissingPermission` (403) and the two conflict cases (409) stand out on
 * status. Refusals are also half the matrix: B1/B2/B3/B5/B6/B8 are all "must
 * be refused" legs, and a leg that cannot tell WHICH refusal it got has not
 * really been observed.
 *
 * The tag is `type`; `FailedValidation` and `MissingPermission` carry their
 * detail in `error` / `permission`.
 */
async function refusalReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      type?: string;
      error?: string;
      permission?: string;
    };
    const detail = body.error ?? body.permission;
    if (!body.type) return "no reason given";
    return detail ? `${body.type}: ${detail}` : body.type;
  } catch {
    // A refusal with no JSON body is still a refusal worth reporting.
    return "no reason given";
  }
}

export type RcDisplay = {
  device: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  dpi: number;
  aspect: number;
};

export type RcStatus = {
  session?: {
    sessionId: string;
    channelId: string;
    authenticated: boolean;
    calibrated: boolean;
    paused: boolean;
    pauseReasons: string[];
    revoked?: string;
    packetsOpened: number;
    eventsInjected: number;
    heldKeys: number;
    heldButtons: number;
    msUntilExpiry: number;
    display: string;
    controllerDisplay: string;
  };
  controller?: {
    sessionId: string;
    channelId: string;
    packetsSealed: number;
    msUntilExpiry: number;
  };
  hook: { hotkey_registered: boolean };
  secureDesktop: boolean;
  foregroundElevated: boolean;
  supported: boolean;
};

/**
 * A peer this machine has been told to remember, so their offer-time native
 * dialog is skipped. Ids and timestamps only — native never stored a
 * username, and inventing one here would put a server-asserted string into
 * the list whose whole job is letting the user recognise what they approved.
 */
export type RcTrustedPeer = {
  userId: string;
  /** Device-qualified: `"{user}:{device}"`. The trust is bound to it. */
  identity: string;
  /** Unix SECONDS, not milliseconds — these come from Rust's `SystemTime`. */
  grantedUtc: number;
  lastUsedUtc: number;
};

/**
 * What the picker must say once "remember this person" is in play, in
 * addition to `REMOTE_CONTROL_CLAIM` and never instead of it.
 *
 * 🔴 THIS IS A SECURITY STATEMENT. The pinned §0.2 claim is unchanged and
 * still true — the crypto did not move — but the *number of OS
 * confirmations* did, from two to one, and plan §0.2's corollary is explicit
 * that a mode which changes what is true must change its own text rather than
 * let the existing wording keep asserting the old property. So this is a
 * SEPARATE string, deliberately not a paraphrase of the claim in either
 * direction.
 *
 * It describes what someone could do rather than what a protocol guarantees,
 * because that is what a person deciding this can actually weigh.
 *
 * Reviewed 2026-07-29. Two things came out of that and are now load-bearing:
 * the survivor is the STRONGER dialog (it arms, and it carries the code), so
 * staying silent about that under-claimed a trade a user might otherwise
 * decline; and the note has to hold when Express Connect is also on, where
 * the dialog that stays is the click-time one and has no code.
 */
export const REMOTE_CONTROL_TRUST_NOTE =
  "Remembering someone removes one of the two system confirmations Sloga " +
  "shows on this computer. One still stands every time, before any of their " +
  "input reaches you — the one that shows the verification code and starts " +
  "the session. There is one fewer moment to stop. If Express Connect is on, " +
  "the one that stays is the one you see when you click, and it has no code. " +
  "Only remember people you would hand your keyboard to in person; remove " +
  "them in Settings under Security & Privacy.";

/**
 * What the app must say wherever Express Connect is on, in addition to
 * `REMOTE_CONTROL_CLAIM` and never instead of it.
 *
 * 🔴 THIS IS A SECURITY STATEMENT — the same standing as
 * `REMOTE_CONTROL_TRUST_NOTE`, and it matters more, because this mode
 * removes the OS-drawn verification code.
 *
 * The pinned §0.2 claim already says the server introduces the two parties
 * and is trusted to do so honestly, so nothing in it becomes FALSE here.
 * What changes is that the one mechanism by which two humans could ever
 * *notice* a wrong introduction — comparing a code neither endpoint's
 * renderer chose — is gone. That has to be said out loud rather than left
 * for a reader to infer from an unchanged paragraph.
 *
 * Note the missing code costs the same thing against a compromised sharer
 * RENDERER as against a hostile server: §0.2 pairs them deliberately,
 * because the peer's public key necessarily crosses the renderer. The string
 * says "Sloga's word" rather than "the server's word" for exactly that
 * reason — to a user those are one thing, and it covers both halves without
 * a lecture about renderers.
 *
 * Reviewed 2026-07-29. Two claims were WRONG and must not come back:
 *
 *   - "asks you once instead of twice" — express applies only to an
 *     already-remembered peer, and such a peer was ALREADY at one dialog.
 *     The count does not change. What changes is WHEN: click time, so the
 *     sharer does not have to return to the machine after the peer answers.
 *   - "no way to notice if it is wrong" — a SAS is still derived and still
 *     rendered behind Verify. What is lost is the OS copy, the only one a
 *     compromised renderer cannot choose, plus the prompt to compare it.
 */
export const REMOTE_CONTROL_EXPRESS_NOTE =
  "Express Connect is on. For people you have already remembered, Sloga asks " +
  "you once when you click, instead of once after they answer. That is the " +
  "same number of confirmations — what it buys is not having to come back to " +
  "your computer. What it costs is the check: no code can exist before they " +
  "answer, so the system confirmation shows none. The code in the Sloga " +
  "window is drawn by the app itself, so it cannot help if the app has been " +
  "tampered with — either way you are taking Sloga's word for who you were " +
  "connected to. People you have not remembered still go through every step.";

/** An inbound offer, rendered as an accept/decline prompt. */
export type RcOffer = {
  channelId: string;
  offerId: string;
  sharerId: string;
  sharerEphemeralPub: string;
  rcSessionId: string;
  /**
   * The input class the sharer pinned on the offer (`kbm` or `gamepad`),
   * and the control-protocol version their build speaks. Both are relayed
   * verbatim by the server and handed straight to native, which binds the
   * class into the key transcript and refuses a version skew BEFORE the
   * dedup burn. Absent means `kbm` / v1 — the set of builds that predate
   * the fields — so an old sharer is refused legibly rather than armed
   * against a transcript that can never match.
   */
  inputClass?: string;
  protocolVersion?: number;
};

/**
 * What the local user is doing right now. `"sharing"` and `"controlling"` are
 * both reachable at once in principle (different calls), but the product
 * offers one capture surface, so the store holds one of each at most.
 */
export type RcSharerPhase =
  /** Offer sent; the target has not answered. */
  | "offered"
  /** Accepted and armed, but §5(C) calibration is unconfirmed. */
  | "calibrating"
  /** Full control. */
  | "active";

export type RcControllerPhase =
  /** We accepted; the sharer has not answered their `RcArm` dialog yet. */
  | "waiting"
  /** The sharer armed and we are sending input. */
  | "active";

type PendingEvent =
  | { kind: "move"; x: number; y: number }
  | { kind: "button"; button: number; down: boolean; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; code: string; down: boolean; repeat?: boolean }
  | { kind: "text"; text: string }
  | { kind: "releaseAll" };

export class RemoteControl {
  // -- capability -------------------------------------------------------

  #supported: boolean | undefined;

  /**
   * Whether this shell can do remote control at all.
   *
   * A COMMAND PROBE, not a shell guess. `nativeE2EEAvailable()` is the
   * obvious candidate and is wrong: it is true on Android (Capacitor) and on
   * the Electron/Linux shell, neither of which has any of these commands, so
   * using it lights the affordance where the handshake dead-ends — the target
   * accepts, nothing exists to answer with, and the sharer sits at
   * "connecting…" until the 90 s offer TTL, having spent a native consent
   * click on nothing. `rc_status().supported` is false on non-Windows by
   * construction, and an ACL denial or a missing command throws, which is
   * also "no".
   *
   * `ENABLE_REMOTE_CONTROL` is checked FIRST and is a release gate, not a
   * capability probe: the command probe answers "can this shell inject
   * input", which is true of every published Windows build, so it cannot by
   * itself keep an unfinished feature dark. Checking it here rather than at
   * each affordance covers the inbound direction too — `setLocalUser`
   * returns early, and both handshake commands fail closed without it.
   */
  async supported(): Promise<boolean> {
    // THE SERVER'S OWN FLAG, checked ahead of the memo and never folded into
    // it. `remote_control` is a per-instance operator switch
    // (`RevoltFeatures`, delta `routes/root.rs`), and until slice 5's exit
    // obligation was met the client could not see it at all: a build with the
    // affordance lit showed "Give control" against a flag-off instance and
    // dead-ended at `FeatureDisabled` (400) with nothing explaining why.
    //
    // Deliberately `=== false` rather than falsy: `undefined` means the
    // config has not been read yet (it is fetched once at boot), and treating
    // "not yet known" as "off" would hide the affordance permanently on a
    // slow config fetch — a worse failure than the one being fixed, and one
    // that fails CLOSED silently. The server refuses the offer regardless, so
    // this gate is about honesty in the UI, not about enforcement.
    if (this.serverEnabled() === false) return false;
    if (this.#supported !== undefined) return this.#supported;
    if (!CONFIGURATION.ENABLE_REMOTE_CONTROL) return (this.#supported = false);
    const invoke = tauriInvoke();
    if (!invoke) return (this.#supported = false);
    try {
      const status = (await invoke("rc_status")) as RcStatus;
      return (this.#supported = !!status?.supported);
    } catch {
      return (this.#supported = false);
    }
  }

  // -- reactive state ---------------------------------------------------

  /** Inbound offer awaiting this user's accept/decline. */
  readonly offer;
  readonly #setOffer;

  /** This user is giving control of their own machine. */
  readonly sharing;
  readonly #setSharing;

  /** This user is driving someone else's machine. */
  readonly controlling;
  readonly #setControlling;

  /** Last native status snapshot, polled while a session is live. */
  readonly status;
  readonly #setStatus;

  /** Terminal/latched problem to surface, e.g. a failed handshake. */
  readonly error;
  readonly #setError;

  /**
   * A "pass the controller" handoff is mid-flight (slice 1).
   *
   * There is a REAL control gap between releasing one turn and arming the
   * next — §1 says a handoff is necessarily teardown-and-re-offer, so for a
   * moment nobody is driving and `sharing()` is legitimately `undefined`.
   * Without this flag that gap reads as "the session just ended": the
   * sharer panel unmounts and the give-control picker pops back, which is
   * both a flash of the wrong UI and a lie about what is happening. The
   * plan is explicit that the gap must be shown, not hidden (§4).
   */
  readonly handingOff;
  readonly #setHandingOff;

  constructor() {
    [this.offer, this.#setOffer] = createSignal<RcOffer | undefined>();
    [this.sharing, this.#setSharing] = createSignal<
      | {
          channelId: string;
          rcSessionId: string;
          controllerId: string;
          controllerName: string;
          /**
           * The server's id for the outstanding offer, from the offer
           * route's response. Both `RemoteControlAccepted` and
           * `RemoteControlDeclined` carry it, and matching on it is what
           * stops a stale offer's response acting on the session that
           * replaced it.
           */
          offerId?: string;
          grantId?: string;
          display: string;
          phase: RcSharerPhase;
          sas?: string;
        }
      | undefined
    >();
    [this.controlling, this.#setControlling] = createSignal<
      | {
          channelId: string;
          rcSessionId: string;
          sharerId: string;
          sharerName: string;
          /**
           * From the ACCEPT response — the release route is grant-addressed
           * and permits either party, so holding it is what lets a
           * controller-side teardown be recorded as one. Optional: an older
           * server (or an unreadable body) leaves it unset and teardown falls
           * back to the sharer-driven path.
           */
          grantId?: string;
          phase: RcControllerPhase;
          sas?: string;
        }
      | undefined
    >();
    [this.status, this.#setStatus] = createSignal<RcStatus | undefined>();
    [this.error, this.#setError] = createSignal<string | undefined>();
    [this.captureActive, this.#setCaptureActive] = createSignal(false);
    [this.localTyping, this.#setLocalTyping] = createSignal(false);
    [this.serverEnabled, this.#setServerEnabled] = createSignal<
      boolean | undefined
    >();
    // Explicit type param, like every other signal here: an inferred one
    // makes the untyped class field circular (TS7022).
    [this.handingOff, this.#setHandingOff] = createSignal<boolean>(false);
  }

  // -- room binding (LiveKit) -------------------------------------------

  #room?: Room;
  #dataHandler?: (...args: unknown[]) => void;
  #localIdentity?: string;

  /**
   * Bind to a connected room. Mirrors `LiveCaptions.attach` deliberately,
   * including the explicit `off` in `detach` — that is the only
   * `dataReceived` precedent in the repo and the one §2 names as the
   * permitted JS-side filter shape.
   */
  attach(room: Room, localIdentity: string) {
    this.detach();
    this.#room = room;
    this.#localIdentity = localIdentity;
    this.#dataHandler = (
      payload: unknown,
      participant?: unknown,
      _kind?: unknown,
      topic?: unknown,
    ) => {
      // THE FILTER'S BOUNDARY, and it is narrow on purpose: `topic` and
      // `participant.identity` come from the LiveKit event object and are
      // server-attested, which is what makes reading them a *filter* rather
      // than a state mutation. NOTHING is read from the payload bytes — not
      // the header, not the session id. Unauthenticated bytes may not
      // influence any decision here.
      if (topic !== RC_TOPIC) return;
      const identity = (participant as { identity?: string } | undefined)
        ?.identity;
      if (!identity) return;
      // Never open our own bytes. The SFU does not echo a sender its own
      // packets, so this only fires if one is looped back to us — which is
      // the shape of the self-forgery oracle §2 C-A is about, and the
      // cheapest possible place to refuse it is before the IPC.
      if (identity === this.#localIdentity) return;
      const sharing = this.sharing();
      if (!sharing) return;
      // `participantUserId`, not a hand-rolled split: SFU identities are
      // device-qualified (`{user_id}:{device_id}`) since media E2EE, and that
      // helper is the one place that knows the format.
      if (participantUserId(identity) !== sharing.controllerId) return;
      void this.#openApply(payload as Uint8Array);
    };
    room.on("dataReceived", this.#dataHandler as never);
  }

  /** Unbind. Safe to call repeatedly. */
  detach() {
    if (this.#room && this.#dataHandler) {
      this.#room.off("dataReceived", this.#dataHandler as never);
    }
    this.#room = undefined;
    this.#dataHandler = undefined;
    this.#localIdentity = undefined;
    this.stopCapture("disconnected");
  }

  /**
   * Hand sealed bytes to native. Fire-and-forget by design: a WebView2
   * `invoke` costs ~5 ms p50 and 15-37 ms p99, so awaiting one before
   * accepting the next packet would serialise the injection path behind the
   * transport rather than behind the work.
   */
  async #openApply(payload: Uint8Array) {
    const invoke = tauriInvoke();
    if (!invoke) return;
    try {
      await invoke("e2ee_rc_open_apply", payload);
    } catch {
      // A packet that fails to open is dropped SILENTLY, with no
      // user-visible and no metric effect — otherwise a hostile SFU has an
      // oracle and an unbounded IPC amplifier. Diagnostics live in
      // `rc_status`, which is read-only.
    }
  }

  // ===================================================================
  // Capture — the controller's side
  // ===================================================================

  #rafHandle?: number;
  #inFlight: Record<number, boolean> = {
    [STREAM_RELIABLE]: false,
    [STREAM_LOSSY]: false,
  };
  #pendingReliable: PendingEvent[] = [];
  #pendingMotion?: { x: number; y: number; seq: number };
  #motionSeq = 0;
  /**
   * Bumped by `startCapture`; the surface's cleanup only stops the capture it
   * itself started.
   *
   * Toggling focus swaps the tile between two DIFFERENT `TrackLoop`s, and
   * Solid mounts the new one before disposing the old one — so without this
   * the new surface's `startCapture` early-returns ("already active") and the
   * old surface's cleanup then stops the capture the new one is relying on.
   * The result is a mounted, correctly-stacked, fully-wired surface that
   * silently discards every event: "control looks granted, the indicator
   * lights up, and nothing moves", which is verbatim the failure §6 exists to
   * prevent, and nothing recovers it short of a new session.
   */
  #captureGeneration = 0;
  #buttonMask = 0;
  #pressedKeys = new Set<string>();
  #lastKeyframe = 0;
  #sharerIdentity?: string;

  /**
   * Whether a capture surface is currently mounted and armed. A SIGNAL
   * rather than a plain field: components gate on it (PiP is blocked while
   * it is true), and a non-reactive read there would leave the call card
   * flipping to PiP mid-session — which is the one place the controller
   * would be driving a cropped view of a desktop they cannot fully see.
   */
  readonly captureActive: Accessor<boolean>;
  readonly #setCaptureActive: Setter<boolean>;

  /**
   * The capture surface is mounted but keyboard forwarding is suspended
   * because focus sits in one of the controller's OWN editables. A signal so
   * the controller panel can say so — the live matrix's finding was not just
   * that local typing went remote, but that NOTHING said which mode the
   * keyboard was in.
   */
  readonly localTyping: Accessor<boolean>;
  readonly #setLocalTyping: Setter<boolean>;

  /** Reported by the capture surface's `focusin` tracking. */
  setLocalTyping(value: boolean) {
    this.#setLocalTyping(value);
  }

  /**
   * Whether THIS INSTANCE has remote control switched on server-side
   * (`RevoltFeatures.remote_control`). `undefined` until the config has been
   * read. A SIGNAL, so an affordance gated on it re-evaluates when the
   * config lands rather than latching whatever was true at first render.
   */
  readonly serverEnabled: Accessor<boolean | undefined>;
  readonly #setServerEnabled: Setter<boolean | undefined>;

  /** Set from `client.configuration` once it is available. */
  setServerEnabled(value: boolean | undefined) {
    this.#setServerEnabled(value);
  }

  /**
   * Start capturing. Suppresses this client's own keybinds for the duration
   * — see `@revolt/keybinds/suppress` for why that is a global flag checked
   * inside `keybindFilter` rather than `stopPropagation` alone.
   */
  startCapture(sharerIdentity: string): number {
    const generation = ++this.#captureGeneration;
    // Re-arming an already-active capture is NORMAL, not a no-op to skip: a
    // focus toggle mounts the replacement surface before disposing the old
    // one, so this runs with capture still live and must hand back a fresh
    // generation so the outgoing surface's cleanup is ignored.
    this.#setCaptureActive(true);
    this.#sharerIdentity = sharerIdentity;
    this.#buttonMask = 0;
    this.#pressedKeys.clear();
    this.#pendingReliable = [];
    this.#pendingMotion = undefined;
    this.#lastKeyframe = 0;
    setKeybindSuppression(true);
    if (this.#rafHandle !== undefined) cancelAnimationFrame(this.#rafHandle);
    const pump = () => {
      if (!this.captureActive() || generation !== this.#captureGeneration)
        return;
      this.#flush();
      this.#rafHandle = requestAnimationFrame(pump);
    };
    this.#rafHandle = requestAnimationFrame(pump);
    return generation;
  }

  /**
   * Stop capturing and release everything held.
   *
   * The release-all is not optional and not merely tidy: `SendInput`'s
   * key-down state lives in the OS, so a swallowed `keyup` — Alt+Tab gives a
   * keydown for Alt and never a keyup — leaves a modifier physically down on
   * SOMEONE ELSE'S machine, reachable with no attacker at all.
   */
  stopCapture(_reason: string, generation?: number) {
    // A caller that names a generation only stops the capture IT started.
    // Without this the outgoing tile's `onCleanup` — which runs AFTER the
    // replacement has already mounted and re-armed — tears down the live
    // capture and leaves a fully-wired surface that discards every event.
    if (generation !== undefined && generation !== this.#captureGeneration) {
      return;
    }
    if (!this.captureActive()) {
      setKeybindSuppression(false);
      return;
    }
    this.#setCaptureActive(false);
    if (this.#rafHandle !== undefined) cancelAnimationFrame(this.#rafHandle);
    this.#rafHandle = undefined;
    // Best-effort, and deliberately fire-and-forget: if this packet never
    // lands, the sharer's own native watchdog releases held input on the
    // packet gap. The renderer is the untrusted party here — this is
    // politeness, the watchdog is the guarantee.
    this.#pendingReliable.push({ kind: "releaseAll" });
    this.#buttonMask = 0;
    this.#pressedKeys.clear();
    // Through the SAME single-flight path `#flush` uses. Firing it directly
    // while a keyframe seal is still in flight publishes two reliable packets
    // whose `publishData` promises resolve independently — so they can land
    // out of order, and a gap in the reliable counter is by definition a loud
    // teardown on the sharer.
    //
    // Consequence worth naming: if a seal IS in flight, `#drain` returns
    // without sending and the pump is already cancelled, so this release-all
    // is DROPPED rather than deferred. That is the fire-and-forget contract
    // above — the sharer's watchdog releases held input on the ~1 s packet
    // gap. Do not "fix" it by bypassing the single flight; a reliable-stream
    // gap tears the session down for everyone, which is strictly worse than
    // a one-second wait for the same release.
    void this.#drain(STREAM_RELIABLE, true);
    setKeybindSuppression(false);
    this.#sharerIdentity = undefined;
  }

  /** Queue one event. Motion is coalesced; everything else is ordered. */
  queue(event: PendingEvent) {
    if (!this.captureActive()) return;
    if (event.kind === "move") {
      // Only the newest position matters — motion is idempotent and
      // absolute, which is the whole reason it may ride the lossy stream.
      // `motionSeq` belongs to the MOTION path and is advanced HERE, not per
      // seal. Bumping it on every packet made the reliable stream — which
      // carries no motion — race the lossy one inside a single frame: the
      // ordered reliable packet is applied first, the sharer's motion
      // high-water mark moves past the concurrent `Move`, and the move is
      // dropped as stale. The pointer then freezes during exactly the drags
      // and typing runs where it matters, and §5(C) calibration degrades,
      // since motion is the only thing that injects there.
      this.#pendingMotion = { x: event.x, y: event.y, seq: ++this.#motionSeq };
      return;
    }
    if (event.kind === "button") {
      this.#buttonMask = event.down
        ? this.#buttonMask | (1 << event.button)
        : this.#buttonMask & ~(1 << event.button);
    }
    if (event.kind === "key") {
      if (event.down) this.#pressedKeys.add(event.code);
      else this.#pressedKeys.delete(event.code);
    }
    if (event.kind === "releaseAll") {
      this.#buttonMask = 0;
      this.#pressedKeys.clear();
    }
    this.#pendingReliable.push(event);
  }

  #flush() {
    const now = performance.now();
    // Lossy: motion only, one packet per frame at most.
    if (this.#pendingMotion) void this.#drain(STREAM_LOSSY, false);
    // Reliable: never dropped, never reordered. If a seal is still in
    // flight the events keep accumulating into the next batch rather than
    // being sent out of order — the sharer's replay window treats a gap in
    // the reliable counter as tampering and tears the session down.
    const dueKeyframe = now - this.#lastKeyframe >= KEYFRAME_INTERVAL_MS;
    if (this.#pendingReliable.length > 0 || dueKeyframe) {
      this.#lastKeyframe = now;
      void this.#drain(STREAM_RELIABLE, true);
    }
  }

  /**
   * Single-flight gate for one stream. THE ONLY WAY a packet is sent.
   *
   * Every caller goes through here rather than checking `#inFlight` at the
   * call site: a second concurrent `#send` on the reliable stream publishes
   * two packets whose `publishData` promises settle independently, so they
   * can arrive out of order — and a gap in the reliable counter is, by
   * definition in §2, unambiguous tampering and a loud teardown.
   */
  async #drain(stream: number, keyframe: boolean) {
    if (this.#inFlight[stream]) return;
    await this.#send(stream, keyframe);
  }

  async #send(stream: number, keyframe: boolean) {
    const invoke = tauriInvoke();
    const controlling = this.controlling();
    const room = this.#room;
    if (!invoke || !controlling || !room) return;

    const motion = this.#pendingMotion;
    const events: PendingEvent[] =
      stream === STREAM_LOSSY
        ? motion
          ? [{ kind: "move", x: motion.x, y: motion.y }]
          : []
        : this.#pendingReliable;
    // The motion sequence this packet declares. Reliable packets carry no
    // motion, so they repeat the last one rather than advancing it — see
    // `queue`.
    const motionSeq =
      stream === STREAM_LOSSY && motion ? motion.seq : this.#motionSeq;
    if (stream === STREAM_LOSSY) this.#pendingMotion = undefined;
    else this.#pendingReliable = [];
    if (events.length === 0 && !keyframe) return;

    this.#inFlight[stream] = true;
    try {
      // The absolute button mask and pressed-key set ride EVERY packet, so a
      // lost or withheld "up" self-heals on the next one — that is what
      // closes the attack where the SFU drops exactly the `mouseup` and
      // leaves a button stuck down on the sharer's desktop.
      //
      // No sequence number: native assigns it per stream. A caller-chosen
      // one is (key, nonce) reuse, so the parameter does not exist.
      const sealed = (await invoke("e2ee_rc_seal", {
        sessionId: controlling.rcSessionId,
        stream,
        keyframe,
        batch: {
          motionSeq,
          buttonMask: this.#buttonMask,
          pressedKeys: [...this.#pressedKeys],
          events,
        },
      })) as number[];
      await room.localParticipant.publishData(new Uint8Array(sealed), {
        reliable: stream === STREAM_RELIABLE,
        topic: RC_TOPIC,
        // Scope the fan-out. A metadata and scale control, NOT a security
        // one — the SFU still routes every packet.
        destinationIdentities: this.#sharerIdentity
          ? [this.#sharerIdentity]
          : undefined,
      });
    } catch (err) {
      // A seal that fails means the native session is gone (expired, ended,
      // revoked). Stop rather than spin: there is no return channel to tell
      // us why, so the honest response is to stop claiming to be in control.
      this.#setError(String(err));
      this.endControlling("seal_failed");
    } finally {
      this.#inFlight[stream] = false;
    }
  }

  // ===================================================================
  // Handshake
  // ===================================================================

  /**
   * Record this device's own authenticated user id with native, once, at
   * login.
   *
   * Both handshake commands fail CLOSED until this is set. It is what stops
   * a hostile server supplying BOTH halves of the key-derivation transcript:
   * the controller's `controllerId` must be this device's own id and never
   * the server-asserted `target_id` from the offer event.
   */
  async setLocalUser(userId: string) {
    const invoke = tauriInvoke();
    if (!invoke || !(await this.supported())) return;
    try {
      await invoke("e2ee_rc_set_local_user", { userId });
    } catch (err) {
      this.#setError(String(err));
    }
  }

  // -- per-peer trust (slice 6 part 2) ----------------------------------
  //
  // Read and revoke only. There is deliberately no `trust()` here to match:
  // a renderer able to write that list could grant itself a way past the
  // `RcGive` dialog, so the grant happens inside core on the far side of
  // that dialog returning true. Revocation is safe in this direction
  // because it can only ever REMOVE authority.

  /** Remembered peers, for Settings → Security & Privacy. */
  async trustedPeers(): Promise<RcTrustedPeer[]> {
    const invoke = tauriInvoke();
    if (!invoke) return [];
    try {
      return (await invoke("rc_trusted_peers")) as RcTrustedPeer[];
    } catch (err) {
      // Surfaced rather than swallowed: an empty list is the one answer this
      // screen must never give by accident, because it reads as "nobody is
      // remembered" — which is exactly the reassurance a failed read cannot
      // substantiate.
      this.#setError(String(err));
      return [];
    }
  }

  /** Forget one peer, putting their native dialog back. */
  async revokeTrust(userId: string): Promise<boolean> {
    const invoke = tauriInvoke();
    if (!invoke) return false;
    try {
      return (await invoke("rc_revoke_trust", { userId })) as boolean;
    } catch (err) {
      this.#setError(String(err));
      return false;
    }
  }

  /** Forget everyone. Returns how many rows went. */
  async revokeAllTrust(): Promise<number> {
    const invoke = tauriInvoke();
    if (!invoke) return 0;
    try {
      return (await invoke("rc_revoke_all_trust")) as number;
    } catch (err) {
      this.#setError(String(err));
      return 0;
    }
  }

  // -- Express Connect (slice 6 part 3) ---------------------------------
  //
  // Same shape as trust and for the same reason: reading and switching OFF
  // are commands, switching ON is a native dialog inside core. A renderer
  // that could set this flag could remove one of the two confirmations
  // standing between it and the keyboard.

  /** Is Express Connect on for this device? Off on any failure. */
  async expressEnabled(): Promise<boolean> {
    const invoke = tauriInvoke();
    if (!invoke) return false;
    try {
      return (await invoke("rc_express_status")) as boolean;
    } catch {
      // Deliberately silent AND false: an unreadable flag must never read as
      // "on", and a settings row that cannot resolve its own state is not
      // worth an error banner.
      return false;
    }
  }

  /**
   * Ask native to show the Express Connect opt-in. Returns the resulting
   * state, which is `false` if the user declined the dialog.
   */
  async enableExpress(): Promise<boolean> {
    const invoke = tauriInvoke();
    if (!invoke) return false;
    try {
      return (await invoke("rc_express_enable")) as boolean;
    } catch (err) {
      this.#setError(String(err));
      return false;
    }
  }

  /** Turn Express Connect off. No dialog — this only adds friction back. */
  async disableExpress(): Promise<void> {
    const invoke = tauriInvoke();
    if (!invoke) return;
    try {
      await invoke("rc_express_disable");
    } catch (err) {
      this.#setError(String(err));
    }
  }

  /** Monitors, for §5's display selector. */
  async displays(): Promise<RcDisplay[]> {
    const invoke = tauriInvoke();
    if (!invoke) return [];
    try {
      const info = (await invoke("rc_displays")) as { displays: RcDisplay[] };
      return info.displays ?? [];
    } catch {
      return [];
    }
  }

  /** Poll native state. The only source the sharer-side UI may trust. */
  async refreshStatus() {
    const invoke = tauriInvoke();
    if (!invoke) return;
    let status: RcStatus;
    try {
      status = (await invoke("rc_status")) as RcStatus;
    } catch {
      // Leave the previous snapshot rather than inventing one.
      return;
    }
    this.#setStatus(status);

    // RECONCILE AGAINST NATIVE, because native can end a session without
    // telling the renderer: the anti-cheat interlock fires mid-session, the
    // panic key fires, the display topology changes, the max lifetime
    // expires, the indicator gets hidden. All of those revoke natively and
    // none of them is a server event. Without this the panel keeps saying
    // "they can control this computer" and offering "take back control" for
    // a session that stopped existing — §4's own description of the failure
    // to avoid, the UI lying about who has access to the machine.
    const sharing = this.sharing();
    if (sharing && sharing.phase !== "offered") {
      const native = status.session;
      if (
        !native ||
        native.sessionId !== sharing.rcSessionId ||
        native.revoked
      ) {
        this.#setError(native?.revoked ?? "session_ended");
        void this.endSharing(native?.revoked ?? "native_revoked");
        return;
      }
      // Keep the renderer's phase honest about calibration too — native is
      // the authority on it, not the click that requested it.
      if (native.calibrated && sharing.phase === "calibrating") {
        this.#setSharing({ ...sharing, phase: "active" });
      }
    }

    // The controller's phase advances on the one thing it can actually
    // observe: packets have been sealed and published. That is precisely
    // "your input is being sent" and nothing stronger — it does not mean the
    // sharer armed, and it certainly does not mean anything landed.
    //
    // The alternative was to leave the phase at "waiting" forever, which the
    // review rightly called out: the honesty rule forbids claiming "you are
    // in control", it does not license telling a working session that its
    // input is not being delivered.
    const controlling = this.controlling();
    if (
      controlling &&
      controlling.phase === "waiting" &&
      (status.controller?.packetsSealed ?? 0) > 0
    ) {
      this.#setControlling({ ...controlling, phase: "active" });
    }
  }

  /**
   * SHARER, step 1: consent natively, then post the offer.
   *
   * The native `RcGive` dialog runs first and mints both opaque values. They
   * are UNPADDED STANDARD base64 of exactly 32 bytes, which is what the
   * shipped server pins with `require_opaque_32` — passed through
   * byte-for-byte, never re-encoded.
   */
  async offerControl(args: {
    apiBase: string;
    authHeader: [string, string];
    channelId: string;
    sharerId: string;
    controllerId: string;
    /**
     * The peer's FULL device-qualified LiveKit identity, from the
     * server-attested participant object — not the bare user id. Per-peer
     * trust is bound to it, so passing the user id here would silently widen
     * "remember this person on this machine" into "remember them on any
     * machine". Native refuses a pair whose halves disagree and refuses a
     * bare id outright, so the failure is a dialog that keeps appearing
     * rather than one that stops.
     */
    controllerIdentity: string;
    controllerName: string;
    display: string;
    /**
     * REQUEST that native remember this peer. It grants nothing on its own:
     * it changes the copy of the native `RcGive` dialog, and the row is
     * written inside core only after that dialog returns true. There is no
     * command that writes the trust list, deliberately.
     */
    remember: boolean;
  }): Promise<boolean> {
    const invoke = tauriInvoke();
    if (!invoke) return false;
    this.#setError(undefined);
    try {
      const minted = (await invoke("e2ee_rc_offer", {
        channelId: args.channelId,
        sharerId: args.sharerId,
        controllerId: args.controllerId,
        controllerIdentity: args.controllerIdentity,
        targetDisplay: args.controllerName,
        remember: args.remember,
        // Under Express Connect the native dialog raised HERE is the arming
        // one, so it has to state what `RcArm` would have: which monitor is
        // being handed over and how long the session may run. Native resolves
        // both — `display` is looked up in the real monitor list and the
        // label composed in Rust, exactly as `e2ee_rc_start` does — and then
        // PINS them. Arming later with anything else is refused, which is
        // what makes the one dialog a user reads in that mode binding rather
        // than decorative.
        //
        // Both values must match what `armSession` passes or the arm fails
        // closed. `durationMs: 0` means "native's default", and it is the
        // same 0 sent there; see the note on `armSession`.
        display: args.display,
        durationMs: 0,
      })) as {
        rcSessionId: string;
        sharerEphemeralPub: string;
        inputClass: string;
        protocolVersion: number;
      };

      // RAW FETCH, not the typed stoat-api client: it sends `{}` for routes
      // it does not know, which would silently drop the ephemeral public and
      // leave the server rejecting a body that looks fine from here.
      const response = await fetch(
        `${args.apiBase}/channels/${args.channelId}/control/offer`,
        {
          method: "POST",
          headers: {
            [args.authHeader[0]]: args.authHeader[1],
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            target: args.controllerId,
            sharer_ephemeral_pub: minted.sharerEphemeralPub,
            rc_session_id: minted.rcSessionId,
            // Both from the command's RETURN, never from an argument this
            // side holds: core pins the class on the offer, and the class
            // the far end binds into its transcript has to be the one the
            // native dialog described. The version is what lets the far
            // end refuse a skew at accept with a legible message instead
            // of deriving a key that cannot match and presenting as a MITM
            // ten seconds later.
            input_class: minted.inputClass,
            protocol_version: minted.protocolVersion,
          }),
        },
      );
      if (!response.ok) {
        // The native ephemeral must not outlive an offer the server never
        // accepted — otherwise a retry could be answered with a peer public
        // for a session nobody agreed to.
        await invoke("e2ee_rc_cancel", { rcSessionId: minted.rcSessionId });
        this.#setError(
          `offer rejected (${response.status} ${await refusalReason(response)})`,
        );
        return false;
      }
      // KEEP THE OFFER ID. Both response events are matched against it, and
      // without it they can only be matched on channel — which makes a stale
      // offer's decline tear down the live session that replaced it, and a
      // stale ACCEPT arm the current session with the wrong peer key.
      // Offers survive server-side to their 90 s TTL, so "cancel, offer
      // someone else" leaves exactly that stale offer outstanding.
      const offer = (await response.json().catch(() => undefined)) as
        | { offer_id?: string }
        | undefined;
      this.#setSharing({
        channelId: args.channelId,
        offerId: offer?.offer_id,
        rcSessionId: minted.rcSessionId,
        controllerId: args.controllerId,
        controllerName: args.controllerName,
        display: args.display,
        phase: "offered",
      });
      return true;
    } catch (err) {
      this.#setError(String(err));
      return false;
    }
  }

  /**
   * "Pass the controller" (slice 1): end the current turn, then offer the
   * next one.
   *
   * 🔴 THIS IS NOT A TRANSFER, and it cannot be made into one. Every layer
   * binds a session to exactly one controller identity permanently — the
   * controller id is inside the HKDF transcript, `(channel, rc_session_id)`
   * is burned role-agnostically at arm, the offer ephemeral is single-use,
   * and the server refuses a second grant while one is live. So a handoff
   * is necessarily release → fresh offer → fresh `RcArm`, with a brief gap
   * where nobody is driving. `handingOff()` exists to SHOW that gap rather
   * than paper over it.
   *
   * Each turn therefore still costs one native dialog on this machine. That
   * is the feature's safety, not an oversight: nothing may hand someone
   * else the keyboard without the owner's OS-level yes.
   *
   * 🔴 Deliberately does NOT wait for a `RemoteControlEnded` caused by our
   * own release. The current grant can end by another path FIRST — the
   * controller leaves, the screenshare stops, the reaper fires — in which
   * case Ended is already in the past and our `DELETE` returns `NotFound`.
   * Blocking on a self-caused Ended would deadlock on an event that has
   * already happened. `endSharing` swallows the DELETE result for exactly
   * this reason, so "already ended" and "we ended it" both fall through to
   * the offer.
   *
   * Returns whether the NEXT turn was successfully offered. A `false` leaves
   * no session live: the previous turn really did end. The queue position is
   * untouched, so the caller can simply offer again — this never auto-
   * retries, because a retry re-runs `e2ee_rc_offer` and puts a SECOND
   * native dialog on screen unannounced. A race with a still-tearing-down
   * grant (the server answers the offer `409 RemoteControlGrantActive`)
   * surfaces as an error the streamer can act on with one click, which is
   * recoverable without being startling.
   */
  async passControlTo(args: {
    apiBase: string;
    authHeader: [string, string];
    channelId: string;
    sharerId: string;
    controllerId: string;
    controllerIdentity: string;
    controllerName: string;
    display: string;
    remember: boolean;
  }): Promise<boolean> {
    // One handoff at a time. Two overlapping rotations would release the
    // session the other just offered.
    if (this.handingOff()) return false;

    const current = this.sharing();
    if (current && current.controllerId === args.controllerId) {
      // Tearing down a live session and spending a native dialog to arrive
      // exactly where it started. `nextInQueue` already returns undefined
      // for the sole-member case; this is the backstop for the tile menu.
      this.#setError(undefined);
      return false;
    }

    this.#setHandingOff(true);
    try {
      if (current) await this.endSharing("turn_ended");
      return await this.offerControl(args);
    } finally {
      this.#setHandingOff(false);
    }
  }

  #offerTimer?: ReturnType<typeof setTimeout>;

  /**
   * An inbound offer arrived. Rendered as an accept/decline prompt, and
   * auto-dismissed at the server's own TTL.
   *
   * The expiry is not cosmetic. `RemoteControlDeclined` is private to the
   * SHARER, so a target whose offer was cancelled or expired is told nothing
   * — and answering a dead offer is expensive in a way a user cannot see: it
   * shows a real `RcAccept` OS dialog, derives a key, and **burns
   * `(channel, rc_session_id)` in the replay dedup**, all before the PUT
   * comes back 404. The retry of that session id is then permanently
   * refused. `incomingCall.ts` already sets the precedent for a client-side
   * timeout on a server-lifetimed prompt.
   */
  presentOffer(offer: RcOffer) {
    if (this.#offerTimer) clearTimeout(this.#offerTimer);
    this.#setOffer(offer);
    this.#offerTimer = setTimeout(
      () => this.dismissOffer(),
      REMOTE_CONTROL_OFFER_TTL_MS,
    );
  }

  /** Clear a prompt without answering (the offer expires server-side). */
  dismissOffer() {
    if (this.#offerTimer) clearTimeout(this.#offerTimer);
    this.#offerTimer = undefined;
    this.#setOffer(undefined);
  }

  /**
   * CONTROLLER: answer an offer.
   *
   * `controllerId` is **this device's own authenticated user id**, never
   * `target_id` from the offer event, even though every other field here
   * legitimately does come from that event. That field is server-asserted;
   * echoing it back lets the server supply both halves of the key
   * transcript, and a redirected session then derives and runs silently
   * under a name the sharer never picked. Native refuses a mismatch, so the
   * symptom is a hard error rather than a subtle one — but only if the right
   * value is passed.
   */
  async respondToOffer(args: {
    apiBase: string;
    authHeader: [string, string];
    offer: RcOffer;
    localUserId: string;
    sharerName: string;
    accept: boolean;
  }): Promise<boolean> {
    const invoke = tauriInvoke();
    this.#setOffer(undefined);
    const url = `${args.apiBase}/channels/${args.offer.channelId}/control/offers/${args.offer.offerId}/respond`;
    const headers = {
      [args.authHeader[0]]: args.authHeader[1],
      "Content-Type": "application/json",
    };

    if (!args.accept || !invoke) {
      // A decline is a real, server-recorded signal, unlike the incoming-call
      // ring's purely local dismissal — the sharer is waiting on it.
      await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ accept: false }),
      }).catch(() => undefined);
      return false;
    }

    this.#setError(undefined);
    try {
      // No `sharerDisplay`: slice 6 removed the controller's native
      // `RcAccept` dialog, which was the only thing that name reached, so
      // native no longer takes it. The Accept button that led here IS the
      // consent on this side now — see `ConfirmRequest` in e2ee-core for why
      // that is sound, and note it leaves the SHARER's two OS dialogs
      // untouched, which is where the §0.2 floor actually lives.
      const accepted = (await invoke("e2ee_rc_accept", {
        channelId: args.offer.channelId,
        sharerId: args.offer.sharerId,
        controllerId: args.localUserId,
        sharerEphemeralPub: args.offer.sharerEphemeralPub,
        rcSessionId: args.offer.rcSessionId,
        // Straight from the offer event. Native binds the class into its
        // half of the transcript and checks the version FIRST — a skew is
        // refused here, before the session id is burned, with an error that
        // names which side has to update. Absent is `kbm` / v1.
        inputClass: args.offer.inputClass,
        offerProtocolVersion: args.offer.protocolVersion,
      })) as {
        controllerEphemeralPub: string;
        sas: string;
        protocolVersion: number;
        inputClass: string;
      };

      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          accept: true,
          controller_ephemeral_pub: accepted.controllerEphemeralPub,
          // Echoed from what native actually BOUND, not from the offer: the
          // class is the one field the server relays, so it is the one a
          // relay can flip, and the sharer compares this against the class
          // its own offer pinned. The version lets the sharer refuse a skew
          // before its arming dialog.
          protocol_version: accepted.protocolVersion,
          input_class: accepted.inputClass,
        }),
      });
      if (!response.ok) {
        await invoke("rc_end", {
          sessionId: args.offer.rcSessionId,
          reason: "respond_rejected",
        });
        this.#setError(`accept rejected (${response.status})`);
        return false;
      }
      // The accept response carries the grant id (`RemoteControlRespondResponse`)
      // and this side used to DISCARD it, which is why the controller never
      // called the release route and every controller-side teardown reached
      // the audit as the SHARER's — see `endControlling`. Best-effort: an
      // unreadable body must not fail an accept that the server took.
      let grantId: string | undefined;
      try {
        grantId = ((await response.json()) as { grant_id?: string }).grant_id;
      } catch {
        /* older server, or an empty body — teardown falls back to the sharer path */
      }
      this.#setControlling({
        channelId: args.offer.channelId,
        rcSessionId: args.offer.rcSessionId,
        sharerId: args.offer.sharerId,
        sharerName: args.sharerName,
        grantId,
        // NOT "active": the sharer still has to answer their own `RcArm`
        // dialog, and nothing tells us when they do. Until then input is
        // sealed and sent and simply not injected, so a UI that claimed
        // control here would be claiming something it cannot substantiate.
        phase: "waiting",
        sas: accepted.sas,
      });
      return true;
    } catch (err) {
      this.#setError(String(err));
      return false;
    }
  }

  /**
   * SHARER, step 2: the controller accepted. Arm through the native `RcArm`
   * dialog, which displays the verification code and is what actually turns
   * injection on.
   *
   * A renderer that never calls this cannot inject. A renderer that calls it
   * with a SUBSTITUTED peer public gets a session whose code does not match
   * the controller's — which is exactly why the code is rendered inside the
   * OS dialog and not only in a webview panel.
   */
  async armSession(args: {
    grantId: string;
    controllerEphemeralPub: string;
    /**
     * From `RemoteControlAccepted`, relayed verbatim. Native checks the
     * version and compares the class against the offer's pin BEFORE the
     * `RcArm` dialog and before the dedup burn, so a skew or a flipped
     * class costs neither a prompt nor a spent session id. Absent means
     * v1 / `kbm`.
     */
    controllerProtocolVersion?: number;
    controllerInputClass?: string;
    /**
     * 🔴 Must be the SAME value `offerControl` sent, and `sharing.display`
     * must still be the display it sent. Under Express Connect the offer
     * dialog stated both, native pinned the labels it composed from them, and
     * `rc_arm` refuses a session whose terms have moved — which is the point:
     * that dialog is the only one the user reads in that mode, so it has to
     * bind. Both paths send 0, meaning "native's default"; if a duration
     * picker ever lands, it has to be chosen before the OFFER, not here.
     */
    durationMs: number;
  }): Promise<boolean> {
    const invoke = tauriInvoke();
    const sharing = this.sharing();
    if (!invoke || !sharing) return false;
    // The grant was minted at ACCEPT with 16 s of grace, and `e2ee_rc_start`
    // blocks on a human reading the `RcArm` dialog for up to 60 s. The
    // heartbeat must therefore already be running while the dialog is up, or
    // every sharer who actually reads it comes back to a reaped grant and a
    // controller whose packets are silently dropped. Pre-authentication
    // beats are bounded by HEARTBEAT_AUTH_GRACE_MS — see #startHeartbeat.
    this.#startHeartbeat(args.grantId);
    try {
      const started = (await invoke("e2ee_rc_start", {
        rcSessionId: sharing.rcSessionId,
        controllerEphemeralPub: args.controllerEphemeralPub,
        controllerDisplay: sharing.controllerName,
        display: sharing.display,
        durationMs: args.durationMs,
        controllerProtocolVersion: args.controllerProtocolVersion,
        controllerInputClass: args.controllerInputClass,
      })) as { sas: string; calibrated: boolean };
      batch(() => {
        this.#setSharing({
          ...sharing,
          grantId: args.grantId,
          // §5(C): armed, but only pointer motion injects until the sharer
          // confirms the pointer is landing on the screen they are actually
          // sharing. Native enforces that; this is the UI's mirror of it.
          //
          // …unless native already calibrated the session itself, which it
          // does when this machine has exactly ONE monitor: the gate exists
          // to catch a two-monitor sharer confirming the screen they are not
          // sharing, and with one display there is no second screen to have
          // picked. Read from `started`, not from a monitor count taken
          // here — native's answer is the one that was true while it held
          // the arm, and it is the same enumeration the topology watchdog
          // will revoke against if a second monitor appears.
          phase: started.calibrated ? "active" : "calibrating",
          sas: started.sas,
        });
      });
      return true;
    } catch (err) {
      // Declined, timed out, replayed, peer key rejected — all terminal, and
      // the offer is spent either way. Journalled natively; surfaced here.
      //
      // Torn down through `endSharing` rather than by clearing the signal:
      // that stops the pre-arm heartbeat (every extra beat extends a grant
      // whose session will never authenticate), zeroizes the native pending
      // record, and RELEASES THE SERVER GRANT — which the server has already
      // minted by the time this event arrives, and which would otherwise sit
      // holding `can_publish_data` for the controller until it expired.
      this.#setError(String(err));
      // The grant id arrives with the accept, so record it before tearing
      // down or `endSharing` has nothing to release.
      this.#setSharing({ ...sharing, grantId: args.grantId });
      await this.endSharing("arm_failed");
      return false;
    }
  }

  /** §5(C): the sharer confirms (or rejects) the display calibration. */
  async confirmCalibration(confirmed: boolean) {
    const invoke = tauriInvoke();
    const sharing = this.sharing();
    if (!invoke || !sharing) return;
    if (!confirmed) {
      await this.endSharing("calibration_rejected");
      return;
    }
    // Advance ONLY if native accepted. `rc_calibrate` returns false when
    // there is no matching session — which is exactly the case where saying
    // "they can control this computer" would be a lie, because the session
    // was revoked between arming and this click.
    let accepted = false;
    try {
      accepted = (await invoke("rc_calibrate", {
        sessionId: sharing.rcSessionId,
        confirmed: true,
      })) as boolean;
    } catch (err) {
      this.#setError(String(err));
    }
    if (accepted) {
      this.#setSharing({ ...sharing, phase: "active" });
    } else {
      this.#setError("session_ended");
      await this.endSharing("calibration_no_session");
    }
  }

  // -- heartbeat --------------------------------------------------------

  #heartbeat?: ReturnType<typeof setInterval>;
  #heartbeatCtx?: { apiBase: string; authHeader: [string, string] };

  /** Supply the credentials the heartbeat needs. Called on connect. */
  setApiContext(ctx: { apiBase: string; authHeader: [string, string] }) {
    this.#heartbeatCtx = ctx;
  }

  /**
   * Keep the SFU capability alive — but once the session has had its chance
   * to authenticate, ONLY while native reports it actually has.
   *
   * The authenticated gate is the whole point. The grant is minted at
   * accept, before any packet has ever opened, and it is per-IDENTITY rather
   * than per-topic, so "accept an offer, then let the handshake fail" would
   * otherwise be a supported way to acquire a data-publish capability
   * reaching every topic in the room — including `"captions"` — without ever
   * controlling anything. Withholding the heartbeat lets the shipped
   * 8 s / 16 s grace destroy it with no new backend work.
   *
   * But the gate cannot be unconditional, because authentication is on the
   * far side of a HUMAN: the sharer reads the `RcArm` dialog (60 s cap),
   * then the controller's first packet has to open. So beats are allowed
   * before authentication for a fixed window from accept
   * (HEARTBEAT_AUTH_GRACE_MS), and the strict gate takes over after it. The
   * accept-then-fail capability therefore lives at most ~grace + 16 s, and
   * only while THIS renderer keeps beating for it — a sharer whose client
   * dies stops extending anything, and an arm that fails, is declined, or
   * times out stops the heartbeat on the spot.
   */
  #startHeartbeat(grantId: string) {
    this.#stopHeartbeat();
    const graceUntil = Date.now() + HEARTBEAT_AUTH_GRACE_MS;
    this.#heartbeat = setInterval(() => {
      void (async () => {
        const ctx = this.#heartbeatCtx;
        if (!this.sharing() || !ctx) return this.#stopHeartbeat();
        await this.refreshStatus();
        // refreshStatus reconciles against native and may have ended the
        // session (and this heartbeat) itself — re-read before extending a
        // grant that endSharing is in the middle of releasing.
        const sharing = this.sharing();
        if (!sharing) return;
        const session = this.status()?.session;
        if (!session?.authenticated && Date.now() > graceUntil) return;
        await fetch(
          `${ctx.apiBase}/channels/${sharing.channelId}/control/heartbeat`,
          {
            method: "POST",
            headers: { [ctx.authHeader[0]]: ctx.authHeader[1] },
          },
        ).catch(() => undefined);
      })();
      void grantId;
    }, HEARTBEAT_INTERVAL_MS);
  }

  #stopHeartbeat() {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  // -- teardown ---------------------------------------------------------

  /** Sharer: take back control. */
  async endSharing(reason: string) {
    const invoke = tauriInvoke();
    const sharing = this.sharing();
    this.#stopHeartbeat();
    this.#setSharing(undefined);
    if (!sharing) return;
    if (invoke) {
      // An offer that never became a session is a PENDING record in the
      // shell, not an injector record — `rc_end` cannot see it, so only
      // `e2ee_rc_cancel` destroys and zeroizes the ephemeral private. §2
      // requires that on decline; without it the key survives to the 90 s
      // offer TTL after the target has already said no.
      if (sharing.phase === "offered") {
        await invoke("e2ee_rc_cancel", {
          rcSessionId: sharing.rcSessionId,
        }).catch(() => undefined);
      }
      await invoke("rc_end", {
        sessionId: sharing.rcSessionId,
        reason,
      }).catch(() => undefined);
    }
    const ctx = this.#heartbeatCtx;
    if (ctx && sharing.grantId) {
      // Carry the teardown cause so the audit can say WHY the session ended
      // — the live matrix found five materially different events (revoke,
      // panic, connection loss, …) all collapsing into `released` at this
      // route. `releaseCause` maps onto the server's fixed vocabulary and
      // returns undefined for "default by role"; the server re-validates
      // against its own allowlist either way.
      const cause = releaseCause(reason);
      const query = cause ? `?cause=${encodeURIComponent(cause)}` : "";
      await fetch(
        `${ctx.apiBase}/channels/${sharing.channelId}/control/${sharing.grantId}${query}`,
        {
          method: "DELETE",
          headers: { [ctx.authHeader[0]]: ctx.authHeader[1] },
        },
      ).catch(() => undefined);
    }
  }

  /** Controller: release control. */
  async endControlling(reason: string) {
    const invoke = tauriInvoke();
    const controlling = this.controlling();
    this.stopCapture(reason);
    this.#setControlling(undefined);
    if (!controlling) return;
    if (invoke) {
      await invoke("rc_end", {
        sessionId: controlling.rcSessionId,
        reason,
      }).catch(() => undefined);
    }
    const ctx = this.#heartbeatCtx;
    // RELEASE FROM THIS SIDE TOO. The old comment here said "the controller
    // has no grant id" and skipped the call — but the id comes back in the
    // controller's OWN accept response, and the route explicitly permits
    // either party. The cost of skipping it was measured on 08-04: a
    // controller pressing "Release control" produced `revoked_by_sharer` in
    // the audit, because the only client that ever called the route was the
    // sharer's, reacting to the session going quiet. `released_by_controller`
    // was unreachable — a vocabulary entry nothing could produce.
    //
    // Correctness does not DEPEND on this (ending natively drops the sealing
    // key and the sharer's heartbeat stops, so the capability dies inside the
    // 16 s grace either way) — the audit's honesty does.
    if (ctx && controlling.grantId) {
      const cause = releaseCause(reason);
      const query = cause ? `?cause=${encodeURIComponent(cause)}` : "";
      await fetch(
        `${ctx.apiBase}/channels/${controlling.channelId}/control/${controlling.grantId}${query}`,
        {
          method: "DELETE",
          headers: { [ctx.authHeader[0]]: ctx.authHeader[1] },
        },
      ).catch(() => undefined);
    }
  }

  /**
   * `RemoteControlEnded` from the server. A server message may END a session
   * and never sustain one, so this is honoured unconditionally in the one
   * direction it is allowed to act in.
   */
  onServerEnded(
    channelId: string,
    sharerId: string,
    reason: string,
    localUserId?: string,
  ) {
    const sharing = this.sharing();
    // `RemoteControlEnded` is a CHANNEL-TOPIC event, so it fans out to every
    // `ViewChannel` subscriber, and §0.7 permits several sharers per call.
    // Without the `sharerId` check, any other person's session ending in this
    // channel tears down yours — and in a large server channel that is most
    // of the time.
    if (
      sharing &&
      sharing.channelId === channelId &&
      sharerId === localUserId
    ) {
      void this.endSharing(`server:${reason}`);
    }
    const controlling = this.controlling();
    if (
      controlling &&
      controlling.channelId === channelId &&
      controlling.sharerId === sharerId
    ) {
      void this.endControlling(`server:${reason}`);
    }
  }

  /**
   * The controller's video feed stopped being trustworthy — unsubscribed by
   * the visibility observer, track ended, muted, or the tile unmounted.
   *
   * An IMMEDIATE hard pause, not a warning. `VideoTrack`'s observer calls
   * `setSubscribed(false)` below 80% visibility after 3 s, which freezes the
   * last frame with no `ended`, no `pause` and no `stalled` event — so
   * scrolling the participant strip would otherwise leave the controller
   * happily injecting against a still image of a desktop that has moved on.
   * Blind control is worse than no control.
   */
  onFeedLost(reason: string, generation?: number) {
    if (!this.captureActive()) return;
    this.stopCapture(`feed_lost:${reason}`, generation);
  }

  /** The local user's `Ctrl+Shift+Alt+Q`, from a focused Sloga window. */
  async panic() {
    const invoke = tauriInvoke();
    // Native anchor first: it revokes inside native rather than in renderer
    // state, so it holds even if this code is compromised. Renderer-reachable
    // is acceptable in this ONE direction — it can only ever stop control.
    if (invoke) await invoke("rc_panic_local").catch(() => undefined);
    // On a controller machine there is no sharer session for `rc_panic_local`
    // to stop, so the meaningful local action is to stop sending.
    if (this.controlling()) await this.endControlling("panic_key");
    if (this.sharing()) await this.endSharing("panic_key");
  }
}
