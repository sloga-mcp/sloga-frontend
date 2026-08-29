/**
 * Native screen-share system audio — the renderer half.
 *
 * Design: acutest-desktop `discord-features-plans/windows-wasapi-screenshare-audio.md`
 * (rev 8). **Section 3.6 is the normative statement of the liveness/ownership
 * contract**; this file implements the renderer side of its tables and the
 * comments cite the tables rather than paraphrasing them.
 *
 * WHY THIS EXISTS. `restrictOwnAudio` — the shipped fix — was MEASURED to be a
 * complete no-op on every current Windows engine we can reach, including our
 * own WebView2: the constraint is accepted, `getSettings().restrictOwnAudio`
 * reports false, and the tone it is supposed to remove stays at +148 dB. So a
 * "share system audio" tick today re-broadcasts the whole call, everyone
 * else's voices included, back into the call. The replacement captures
 * "everything except our own process tree" natively in the shell, which is
 * echo safety by CONSTRUCTION rather than by filter.
 *
 * SHARED WITH THE LINUX FEATURE by design. `state.tsx` sees one interface;
 * the Windows body invokes the shell and consumes a binary `Channel`, the
 * Linux body (its own slice 1) does getUserMedia device matching. Two
 * contracts are stated up front because they differ:
 *
 *  (a) THE RETURNED TRACK'S LIFETIME ends when the native feed dies — but on
 *      Windows the DOM `"ended"` event does NOT fire for it.
 *      `MediaStreamTrack.stop()` sets `readyState` without dispatching an
 *      event (per spec the event fires only when a track ends for reasons
 *      OTHER than `stop()`), and a `MediaStreamAudioDestinationNode` track
 *      never ends on its own. livekit binds its auto-unpublish to that DOM
 *      event, so on Windows that net is unreachable and a consumer who
 *      registers an `"ended"` listener to detect death gets dead code. The
 *      Windows guarantee is that `teardownScreenAudio()` runs and the
 *      publication is EXPLICITLY unpublished.
 *  (b) THE CAPTURE-MODE PARAMETER is in the interface from day one
 *      (`"system"` | `{ includePid }`) with only `"system"` implemented, so
 *      slice 2's window-share audio is not an interface change.
 */

import { CONFIGURATION, tauriInvoke } from "@revolt/common";

import {
  type Timings,
  FLAG_SENTINEL,
  HEADER_BYTES,
  WIRE_VERSION,
  evaluateLiveness,
  readHeader,
  validateTimings,
} from "./screenAudioWire";

/** Slice 2 gets `{ includePid }`; slice 1 implements `"system"` only. */
export type ScreenAudioMode = "system" | { includePid: number };

/**
 * Stable failure codes.
 *
 * 🔴 This module emits CODES, never English. It is shared with the Linux
 * feature, so copy written here would have to be duplicated there; and the
 * client's user-facing strings are lingui macros with ~70 catalogs behind
 * them, which a raw literal in a cross-platform module silently bypasses.
 * `state.tsx` owns the mapping to localized copy, and slice 3's copy matrix
 * owns the final wording.
 */
export type ScreenAudioFailure =
  /** The shell refused to start: OS too old, no exclusion root, env kill. */
  | { kind: "start"; code: string }
  /** The capture died mid-share. */
  | { kind: "died"; reason: string }
  /** The E2EE transform was not attached to this publication. */
  | { kind: "not-encrypted" }
  /** The graph could not be built after the shell had already started. */
  | { kind: "graph" };

/** What the host (`Voice`) must be able to do on our behalf. */
export interface ScreenAudioHost {
  /**
   * Unpublish the ScreenShareAudio publication if one exists. Must be
   * idempotent and must never throw — it is called from a death path.
   *
   * 🔴 The host must resolve the publication by TRACK, not by source. A death
   * during the publish window finds no publication by source (livekit
   * registers it only after `negotiate()` returns), and neither does a
   * teardown landing inside `republishAllTracks`'s unpublish/republish
   * window — which is how every full reconnect works. In both cases an
   * unpublish-by-source silently no-ops, and because the DOM `"ended"` event
   * is unreachable for our track (contract (a) above) livekit's auto-unpublish
   * net cannot clean up after it either.
   */
  unpublish(): Promise<void>;
  /** Loud, user-visible failure. Never silent: a silent zombie is the one
   *  outcome this whole protocol exists to prevent. */
  report(failure: ScreenAudioFailure): void;
}

export interface ScreenAudioCapture {
  /** The track to publish. */
  track: MediaStreamTrack;
  /** The shell's session token, stamped on every tick and disown. */
  generation: number;
}

/** Section 3.6.2's states, verbatim. */
type State = "IDLE" | "STARTING" | "LIVE" | "EXPECTED_STOP" | "DEAD";

interface StartResult {
  generation: number;
  format: { rate: number; channels: number; bits: number };
  timings: Timings;
}

interface ProbeResult {
  available: boolean;
  reason?: string;
  format: { rate: number; channels: number; bits: number };
  timings: Timings;
  /** §11.9's recorded verdict — read by the lighting gate, never by the share. */
  exclusion?: { check: string; conclusivelyPassed: boolean; detail?: string };
}

interface CommandError {
  code: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Module state. ONE session at a time, and the listeners below are registered
// ONCE at module scope rather than per share: a per-share listener accumulates
// one handler per share, each closing over a stale session.
// ---------------------------------------------------------------------------

interface Session {
  generation: number;
  host: ScreenAudioHost;
  context: AudioContext;
  node: AudioWorkletNode;
  destination: MediaStreamAudioDestinationNode;
  track: MediaStreamTrack;
  channel: TauriChannel;
  timings: Timings;
  /** Set the instant `publishTrack` is called — it decides whether a death
   *  REFUSES a pending publish or UNPUBLISHES a live one. */
  publishCalled: boolean;
  /** Last frame delivered to the main thread, `performance.now()`. */
  lastFrameDeliveredAt: number;
  /** Last worklet tick or heartbeat delivered to the main thread. */
  lastTickDeliveredAt: number;
  lastReceivedSeq: number;
  /** Loops 7 and 8, armed only in LIVE. */
  watchdogsArmed: boolean;
  /** Coalescing state for loop 6 — a backlog collapses to ONE invoke. */
  relayInFlight: boolean;
  relayPending: boolean;
}

let state: State = "IDLE";
let session: Session | undefined;
/**
 * Deaths seen before `session` exists, keyed by generation (0 = "before we
 * knew our own generation").
 *
 * 🔴 §3.6.3: `STARTING` is entered at the CALL and G is only known when
 * `start` RESOLVES — but the danger window is LONGER than that. `session` is
 * not assigned until the worklet module has been fetched and the graph built,
 * which is another IPC and a network-or-disk read. A death landing anywhere in
 * that span must be LATCHED, or `captureScreenAudio` returns a track, the
 * share goes `LIVE`, and the ≤100 ms captured under a stale exclusion root is
 * DRAINED into the encoder instead of discarded — the other participants'
 * decrypted voices, under the sharer's own key.
 *
 * The sentinel does not cover this window either: the Tauri JS `Channel`
 * initializes `onmessage` to a no-op and dispatches in-order messages
 * immediately, so a sentinel arriving before the handler is installed is
 * silently consumed. Hence `channel.onmessage` is installed BEFORE
 * `screen_audio_start` is invoked, and the generation is adopted into a
 * module variable the instant `start` resolves.
 */
let pendingDeaths: number[] = [];
/** Non-zero from the moment `start` resolves until `session` is assigned. */
let adoptedGeneration = 0;
let awaitingGeneration = false;
/**
 * Set by any stop path that arrives while we are still building the graph.
 * §3.6.3's "any stop path" row has to mean something in that sub-state too,
 * or a socket drop during `addModule` leaves the shell capturing the desktop
 * with nothing owning it.
 */
let startCancelled = false;

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

let probeCache: Promise<ProbeResult | undefined> | undefined;

function isWindowsShell(): boolean {
  if (typeof navigator === "undefined") return false;
  // The shell is a WebView2 host, so the UA carries Windows; the Tauri bridge
  // is what distinguishes it from a web tab on the same OS.
  return /Windows/i.test(navigator.userAgent);
}

/** Resolved value, so the capability check never has to await in a gesture. */
let probeResult: ProbeResult | undefined;
let probeSettled = false;

function probe(): Promise<ProbeResult | undefined> {
  const invoke = tauriInvoke();
  if (!invoke) return Promise.resolve(undefined);
  if (!probeCache) {
    probeCache = invoke<ProbeResult>("screen_audio_probe")
      .catch((error) => {
        // An old shell has no such command; a new one that fails the probe is
        // reporting a real incapability. Both mean "not available", and
        // neither is worth surfacing — the share proceeds without system
        // audio.
        console.warn("[screen-audio] probe failed", error);
        return undefined;
      })
      .then((result) => {
        probeResult = result;
        probeSettled = true;
        return result;
      });
  }
  return probeCache;
}

/**
 * Warm the capability answer well before anyone clicks Share.
 *
 * 🔴 This exists so [`screenAudioSupported`] never has to block. It is called
 * from the room-join path, which is minutes of wall clock before a share in
 * the normal case and still a whole connect in the fast case.
 */
export function primeScreenAudioProbe(): void {
  if (!CONFIGURATION.ENABLE_WIN_NATIVE_SCREEN_AUDIO) return;
  if (!isWindowsShell()) return;
  void probe();
}

/**
 * 🔴 Should the browser's "Also share system audio" checkbox be REMOVED?
 *
 * This is deliberately SYNCHRONOUS and deliberately NOT the same question as
 * "can we run the native capture". Fusing them is a silent regression in the
 * direction of the original bug: if the probe has not answered — and room join,
 * where it is primed, is the busiest moment for both the shell and the
 * renderer — a fused answer of `false` does not merely skip the native
 * capture, it hands the user back the checkbox. They tick it, and the
 * measured-no-op `restrictOwnAudio` loopback re-broadcasts every other
 * participant's voice into the call: the exact echo this design exists to
 * eliminate, on the exact shell it exists to fix.
 *
 * So the checkbox is suppressed on what is knowable WITHOUT waiting: the build
 * flag, the platform, and the presence of a Tauri bridge. A shell that then
 * turns out to be incapable gives a SILENT share, which §9 already names as
 * the acceptable degrade — not a loopback share.
 */
export function screenAudioPickerAudioSuppressed(): boolean {
  if (!CONFIGURATION.ENABLE_WIN_NATIVE_SCREEN_AUDIO) return false;
  if (!isWindowsShell()) return false;
  // A Tauri bridge is what distinguishes the desktop shell from a web tab on
  // Windows; without it the browser checkbox is the only source there is.
  return !!tauriInvoke();
}

/**
 * Can the native capture actually run? Build flag AND platform AND the shell's
 * own probe (which also carries the `SLOGA_NO_SCREEN_AUDIO=1` escape).
 *
 * 🔴 BOUNDED, because this sits on the user-gesture path immediately before
 * `getDisplayMedia`. An unbounded await here is not merely slow: exceed the
 * transient-activation window and `getDisplayMedia` rejects for lost
 * activation, which breaks SCREENSHARING ENTIRELY on that shell rather than
 * just its audio — and a probe that never resolves would leave the share
 * button doing nothing at all, permanently, since the promise is cached.
 *
 * An unsettled probe answers "no", which is safe HERE precisely because the
 * checkbox question is answered separately above: the degrade is a silent
 * share, never a loopback one.
 */
export async function screenAudioSupported(): Promise<boolean> {
  if (!screenAudioPickerAudioSuppressed()) return false;
  if (probeSettled) return !!probeResult?.available;
  const raced = await Promise.race([
    probe(),
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), 200),
    ),
  ]);
  return !!raced?.available;
}

/**
 * The §11.9 verdict, for the LIGHTING gate and for the live legs. Never gates
 * the share: an inconclusive check blocks lighting, not sharing.
 */
export function screenAudioExclusionStatus():
  | { check: string; conclusivelyPassed: boolean; detail?: string }
  | undefined {
  return probeResult?.exclusion;
}

// ---------------------------------------------------------------------------
// The Tauri binary Channel
// ---------------------------------------------------------------------------

interface TauriChannel {
  onmessage: (message: ArrayBuffer) => void;
  /**
   * Public in `@tauri-apps/api` 2.5.0: it does
   * `Reflect.deleteProperty(window, '_' + this.id)`, removing the only strong
   * root holding the callback and therefore the only thing keeping the
   * channel's private `#pendingMessages` array alive.
   */
  cleanupCallback?: () => void;
}

interface TauriChannelCtor {
  new (): TauriChannel;
}

function tauriChannelCtor(): TauriChannelCtor | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window as {
      __TAURI__?: { core?: { Channel?: TauriChannelCtor } };
    }
  ).__TAURI__?.core?.Channel;
}

// ---------------------------------------------------------------------------
// Death, from the shell
// ---------------------------------------------------------------------------

interface TauriEventApi {
  event: {
    listen<T>(
      name: string,
      handler: (event: { payload: T }) => void,
    ): Promise<() => void>;
  };
}

let deathListenerRegistered = false;

/**
 * Registered ONCE at module scope and dispatching BY GENERATION.
 *
 * 🔴 Both halves matter. Per-share registration accumulates one handler per
 * share, each closing over a stale session. And dispatching on current state
 * rather than on the generation kills the wrong share: the shell's drop-guard
 * fires on ANY capture-thread exit including a SUPERSEDE, so an old session's
 * guard emits a died-event into a renderer that is already STARTING or LIVE on
 * the new one.
 */
async function ensureDeathListener(): Promise<boolean> {
  if (deathListenerRegistered) return true;
  const tauri = (window as { __TAURI__?: TauriEventApi }).__TAURI__;
  if (!tauri?.event) return false;
  try {
    // 🔴 AWAITED. `listen()` is an async IPC, so returning before it resolves
    // means the shell can start capturing with no subscription in place — and
    // the first share of a session is exactly when that happens.
    await tauri.event.listen<{ generation: number; reason: string }>(
      "screen-audio-died",
      (event) => onShellDeath(event.payload.generation, event.payload.reason),
    );
    deathListenerRegistered = true;
    return true;
  } catch (error) {
    console.error("[screen-audio] death listener failed to register", error);
    return false;
  }
}

function onShellDeath(generation: number, reason: string) {
  if (!session) {
    // 🔴 Latch, never drop. Before `start` resolves we do not yet know our
    // generation, so everything is kept; after it resolves but before the
    // graph exists we know it and can filter. Either way the machine is in
    // `STARTING` and the death is ours to honor.
    if (
      awaitingGeneration ||
      (adoptedGeneration && generation === adoptedGeneration)
    ) {
      pendingDeaths.push(generation);
      lastDeathReason = reason;
    }
    return;
  }
  if (generation !== session.generation) return;
  die({ kind: "died", reason });
}

let lastDeathReason = "";

// ---------------------------------------------------------------------------
// Loops 7 and 8 — the two watchdogs, behind the quiescence barrier
// ---------------------------------------------------------------------------

/**
 * 🔴 `MessageChannel`, NOT `setTimeout(…, 0)`.
 *
 * A `setTimeout` macrotask is also a throttled timer, so on a minimized
 * sharer — the modal state for someone sharing their screen — the barrier
 * would fire at ~1 Hz and then ~1/min past the ~5-minute intensive-throttling
 * boundary, and these two loops would detect death LATER than the mechanism
 * they replaced.
 */
let barrierChannel: MessageChannel | undefined;
let barrierScheduled = false;
let arrivals = 0;
let barrierArmedAt = 0;

function noteArrival() {
  arrivals++;
  armBarrier();
}

function armBarrier() {
  if (barrierScheduled) return;
  if (!barrierChannel) {
    barrierChannel = new MessageChannel();
    barrierChannel.port1.onmessage = onBarrier;
    barrierChannel.port1.start();
  }
  barrierScheduled = true;
  barrierArmedAt = arrivals;
  barrierChannel.port2.postMessage(0);
}

function onBarrier() {
  barrierScheduled = false;
  // Not quiet yet — more arrived while this task was queued. Re-arm rather
  // than evaluate, or a backlog drain would compare a fresh tick against a
  // two-second-old frame stamp and tear down a stall that is survivable.
  if (arrivals !== barrierArmedAt) {
    armBarrier();
    return;
  }
  evaluateWatchdogs();
}

function evaluateWatchdogs() {
  const active = session;
  if (!active || !active.watchdogsArmed || state !== "LIVE") return;

  const now = performance.now();
  // 🔴 DELIVERY stamps, both taken at the SAME instant, and never the
  // worklet's `currentTime` or its generation index: worklet generation
  // cadence is not interrupted by a main-thread wedge, so a rule written
  // against it is dead code with the mitigating machinery present and inert.
  const framesStaleFor = now - active.lastFrameDeliveredAt;
  const ticksStaleFor = now - active.lastTickDeliveredAt;

  // §3.6.4 invariant 2 as a three-way decision, in `screenAudioWire.ts` so it
  // is unit-tested rather than asserted here.
  switch (evaluateLiveness(framesStaleFor, ticksStaleFor, active.timings)) {
    case "wedged":
      // Both stamps stale: nothing was delivered because nothing was RUNNING.
      // Slice 0 measured this recovering — one silent gap, 2.1 s of stale
      // audio discarded, back at target within ~608 ms — so tearing down here
      // kills a share that was about to fix itself.
      return;
    case "producer-dead":
      // Loop 7 — frames stale while ticks are FRESH: the main thread is
      // running its own tasks and our audio graph is alive, so the producer or
      // the transport died. The feed is continuous BY CONSTRUCTION (the shell
      // synthesizes silence for capture gaps and a gated session still emits
      // the keepalive), so this means death, never quiet audio. It is also the
      // ONLY detector of a wedged Tauri channel fetch, whose rejection is
      // swallowed by a bare `.catch` in the injected JS while `Channel::send`
      // keeps returning Ok.
      die({ kind: "died", reason: "no frames from the capture" });
      return;
    case "graph-dead":
      // Loop 8 — ticks stale while frames are FRESH: frames keep arriving and
      // look healthy while our audio render thread has died (context
      // suspended, sink error, endpoint loss). Before tick generation moved
      // onto the audio thread both signals shared a thread and this failure
      // could not be seen at all.
      die({ kind: "died", reason: "the audio graph stopped running" });
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function workletUrl(): string {
  // Absolute: `addModule` resolves against the worklet scope, not the
  // document. Self-hosted under public/ — the shell CSP is `script-src
  // 'self'` and blocks any external script origin.
  return new URL(
    `${import.meta.env.BASE_URL}screen-audio/ScreenAudioWorklet.js`,
    window.location.origin,
  ).href;
}

/**
 * Start the native capture and build the publish graph.
 *
 * On success the state machine is in `STARTING`: the death branch is ARMED
 * (a shell death during the publish window must latch and refuse the publish
 * — that window spans an SDP negotiation, hundreds of milliseconds and
 * unbounded on a congested link, with frames already forwarding), while the
 * ownership assertion is suppressed because nothing is published yet.
 *
 * Every error exit stops what it started.
 */
export async function captureScreenAudio(options: {
  mode: ScreenAudioMode;
  host: ScreenAudioHost;
}): Promise<ScreenAudioCapture | undefined> {
  if (options.mode !== "system") {
    // Slice 2. The parameter exists so this is a capability answer rather
    // than an interface change later.
    return undefined;
  }
  if (state !== "IDLE") {
    console.warn("[screen-audio] refusing to start over an existing session");
    return undefined;
  }
  const invoke = tauriInvoke();
  const ChannelCtor = tauriChannelCtor();
  if (!invoke || !ChannelCtor) return undefined;

  // 🔴 AWAITED. `listen()` is itself an async IPC, so a fire-and-forget
  // registration may not exist when the shell begins capturing — and on the
  // first share of a session that is exactly when it would be needed. A
  // registration failure is a START failure, not a silent degrade: without it
  // the whole shell-death branch is dead for the session with nothing
  // observable anywhere.
  if (!(await ensureDeathListener())) {
    options.host.report({ kind: "start", code: "no-death-listener" });
    return undefined;
  }

  state = "STARTING";
  awaitingGeneration = true;
  adoptedGeneration = 0;
  startCancelled = false;
  pendingDeaths = [];

  // 🔴 The handler is installed BEFORE the invoke. The Tauri JS `Channel`
  // initializes `onmessage` to a no-op and dispatches in-order messages
  // immediately, so anything delivered before this assignment — INCLUDING a
  // terminal sentinel — is silently swallowed. The object already exists, so
  // this costs nothing; the alternative loses the shell's death signal on both
  // transports for the whole graph-construction window.
  const channel: TauriChannel = new ChannelCtor();
  let adopted: Session | undefined;
  channel.onmessage = (message) => {
    if (adopted) onFrame(adopted, message);
    else onEarlyFrame(message);
  };

  let started: StartResult;
  try {
    started = await invoke<StartResult>("screen_audio_start", { channel });
  } catch (error) {
    // §3.6.3's `screen_audio_start rejects` row: back to IDLE, report, and the
    // share continues SILENT. Leaving the machine in STARTING here is what an
    // earlier revision did, and it never recovered.
    state = "IDLE";
    awaitingGeneration = false;
    releaseRawChannel(channel);
    const failure = error as Partial<CommandError>;
    options.host.report({ kind: "start", code: failure.code ?? "unknown" });
    return undefined;
  }

  const generation = started.generation;
  awaitingGeneration = false;
  adoptedGeneration = generation;

  // The latch. A death that landed before we knew our own generation is kept
  // unfiltered (generation 0 in the buffer means "unknown yet"), so this
  // covers both halves of the window.
  const abandon = () => {
    pendingDeaths = [];
    lastDeathReason = "";
    adoptedGeneration = 0;
    state = "IDLE";
    releaseRawChannel(channel);
    // 🔴 ONE verb, and it carries the generation.
    //
    // `stop` is generation-scoped on the shell side for the same reason
    // `disown` is: this returns the machine to `IDLE` synchronously while the
    // IPC is still in flight, so a user who re-shares immediately would
    // otherwise have their NEW capture killed by this stale stop landing in
    // `CAPTURING(G′)`. Sending `disown` as well would be a second verb with
    // the same effect and one more row to keep consistent.
    void invoke("screen_audio_stop", { generation }).catch(() => undefined);
  };
  if (pendingDeaths.length > 0) {
    abandon();
    options.host.report({ kind: "died", reason: lastDeathReason || "start" });
    return undefined;
  }
  if (startCancelled) {
    // A stop path ran while `start` was in flight. Not a failure — the user
    // or the room ended it — so no report, but the shell must still be told.
    abandon();
    return undefined;
  }

  // 🔴 Pin the rate. A bare `new AudioContext()` adopts the DEFAULT OUTPUT
  // DEVICE's rate while the shell sends 48 kHz, so a sharer on a 44.1 kHz
  // endpoint has a worklet consuming 44 100 frames/s from a 48 000 frames/s
  // producer: viewers hear the share ~8.8 % sharp and the jitter buffer grows
  // ~3.9 s of latency per minute until the age discard fires. NOTHING in this
  // design detects that — the frame watchdog sees a healthy feed and the tick
  // keeps arriving.
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: started.format.rate });
  } catch (error) {
    // A throwing constructor happens AFTER the shell has already spawned the
    // capture, so it is a STARTING-state failure that must run teardown — not
    // an unhandled rejection that leaks a live capture.
    console.error("[screen-audio] AudioContext construction failed", error);
    abandon();
    options.host.report({ kind: "graph" });
    return undefined;
  }

  try {
    await context.audioWorklet.addModule(workletUrl());
    // 🔴 Re-check after EVERY await: a death or a stop path can land while the
    // worklet module is being fetched, and without this the graph is built,
    // the share goes LIVE, and the only remaining detector is loop 7 at
    // N > 2430 ms — by which time frames captured under a stale exclusion root
    // have been drained into the encoder rather than discarded.
    if (pendingDeaths.length > 0 || startCancelled) {
      await context.close().catch(() => undefined);
      const died = pendingDeaths.length > 0;
      abandon();
      if (died) {
        options.host.report({
          kind: "died",
          reason: lastDeathReason || "start",
        });
      }
      return undefined;
    }
    // The context is created after the picker interaction, which is browser
    // chrome and grants no page activation — sticky activation "usually"
    // covering it is not a design guarantee.
    if (context.state !== "running") await context.resume();
    if (pendingDeaths.length > 0 || startCancelled) {
      await context.close().catch(() => undefined);
      const died = pendingDeaths.length > 0;
      abandon();
      if (died) {
        options.host.report({
          kind: "died",
          reason: lastDeathReason || "start",
        });
      }
      return undefined;
    }

    const timings = validateTimings(started.timings);
    const node = new AudioWorkletNode(context, "ScreenAudioWorklet", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [started.format.channels],
      processorOptions: {
        channels: started.format.channels,
        sampleRate: started.format.rate,
        jitterTargetMs: timings.jitterTargetMs,
        quantaPerTick: timings.quantaPerTick,
        heartbeatQuanta: timings.heartbeatQuanta,
      },
    });
    const destination = context.createMediaStreamDestination();
    node.connect(destination);

    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error("destination node produced no audio track");

    const active: Session = {
      generation,
      host: options.host,
      context,
      node,
      destination,
      track,
      channel,
      timings,
      publishCalled: false,
      lastFrameDeliveredAt: performance.now(),
      lastTickDeliveredAt: performance.now(),
      lastReceivedSeq: 0,
      watchdogsArmed: false,
      relayInFlight: false,
      relayPending: false,
    };
    session = active;
    // The handler installed before the invoke now routes to the real session
    // rather than to the early-frame buffer.
    adopted = active;
    node.port.onmessage = (event) => onWorkletMessage(active, event.data);

    if (context.state !== "running") {
      throw new Error(`AudioContext is ${context.state}, not running`);
    }

    return { track, generation };
  } catch (error) {
    console.error("[screen-audio] graph construction failed", error);
    session = undefined;
    adopted = undefined;
    await context.close().catch(() => undefined);
    abandon();
    options.host.report({ kind: "graph" });
    return undefined;
  }
}

/**
 * A frame that arrived before the graph existed.
 *
 * Only the SENTINEL matters here — audio has nowhere to go yet, and dropping
 * it costs at most the few milliseconds before the worklet is up. The sentinel
 * is latched exactly like a died-event so the start path can refuse.
 */
function onEarlyFrame(message: ArrayBuffer) {
  const header = readHeader(message);
  if (!header || header.version !== WIRE_VERSION) return;
  if (!(header.flags & FLAG_SENTINEL)) return;
  if (adoptedGeneration && header.generation !== adoptedGeneration) return;
  pendingDeaths.push(header.generation);
  if (!lastDeathReason) lastDeathReason = "sentinel";
}

/** Release a channel we never handed to a session. */
function releaseRawChannel(channel: TauriChannel) {
  channel.onmessage = () => undefined;
  try {
    channel.cleanupCallback?.();
  } catch {
    /* older api surface */
  }
}

// ---------------------------------------------------------------------------
// Frames and ticks
// ---------------------------------------------------------------------------

function onFrame(active: Session, message: ArrayBuffer) {
  if (session !== active) return;
  const header = readHeader(message);
  if (!header || header.version !== WIRE_VERSION) return;
  // 🔴 The sentinel carries a generation for the same reason the died-event
  // does: on a supersede the OLD capture thread's drop-guard sends its
  // terminal sentinel on the OLD channel, whose `window._<id>` closure is
  // still installed, so a handler dispatching on current state would kill the
  // NEW share instantly.
  if (header.generation !== active.generation) return;

  if (state === "EXPECTED_STOP" || state === "DEAD" || state === "IDLE") return;

  active.lastFrameDeliveredAt = performance.now();
  active.lastReceivedSeq = header.seq;
  noteArrival();

  if (header.flags & FLAG_SENTINEL) {
    die({ kind: "died", reason: "sentinel" });
    return;
  }

  // Transfer rather than copy: the payload is 1920 bytes at 100/s, and the
  // main thread is the exact resource this whole liveness design protects.
  active.node.port.postMessage(
    { type: "pcm", buffer: message, offset: HEADER_BYTES, seq: header.seq },
    [message],
  );
}

function onWorkletMessage(
  active: Session,
  message: { type: string; seq: number },
) {
  if (session !== active) return;
  if (state === "EXPECTED_STOP" || state === "DEAD" || state === "IDLE") return;
  active.lastTickDeliveredAt = performance.now();
  // 🔴 A heartbeat SCHEDULES THE BARRIER like any other arrival. Defining the
  // barrier over "the last arrival of either kind" while making the heartbeat
  // a third kind on the same port is a reading under which it never schedules
  // anything.
  noteArrival();
  if (message.type === "tick") relayTick(active);
}

/**
 * Loop 6. The relay is a TASK, not a timer, so Chromium's ~1 Hz throttling of
 * a minimized window cannot slow it — while a wedged main thread still fails
 * to relay, which is exactly the meaning the shell's credit needs.
 *
 * A backlog collapses to ONE invoke carrying the newest state: a wedge of
 * length W at interval I would otherwise drain W/I queued ticks into
 * back-to-back invokes on a main thread already draining W x 100 frame
 * messages.
 */
function relayTick(active: Session) {
  if (active.relayInFlight) {
    active.relayPending = true;
    return;
  }
  const invoke = tauriInvoke();
  if (!invoke) return;
  active.relayInFlight = true;
  void invoke("screen_audio_tick", {
    generation: active.generation,
    lastReceivedSeq: active.lastReceivedSeq,
  })
    .catch(() => undefined)
    .finally(() => {
      active.relayInFlight = false;
      // 🔴 Also gated on STATE, not just on session identity. §3.6.2 stops
      // loops 5/6 in `EXPECTED_STOP` precisely so a stalled teardown lets the
      // shell's credit EXPIRE — that credit is the only backstop left under an
      // unowned capture. A re-fire queued before step 0 would buy it one more
      // CREDIT period.
      if (
        active.relayPending &&
        session === active &&
        (state === "STARTING" || state === "LIVE")
      ) {
        active.relayPending = false;
        relayTick(active);
      }
    });
}

// ---------------------------------------------------------------------------
// Publish handshake with the host
// ---------------------------------------------------------------------------

/**
 * Call IMMEDIATELY before `publishTrack`, with no `await` in between.
 *
 * Returns false when a death has already latched, in which case the publish
 * must be REFUSED. Because JavaScript is single-threaded and there is no
 * suspension point between this returning true and the publish call, no death
 * can interleave — which is what makes the two `STARTING` death rows
 * distinguishable at all.
 */
export function beginScreenAudioPublish(): boolean {
  if (state !== "STARTING" || !session) return false;
  session.publishCalled = true;
  return true;
}

/**
 * Call after `publishTrack` RESOLVES. Returns false if a death landed during
 * the publish window, in which case the caller must unpublish — by then
 * `negotiate()` has returned and the track is on the wire, so there is no
 * publish left to refuse and returning early would leave a live
 * ScreenShareAudio publication on the SFU against local state `DEAD`.
 */
export function finishScreenAudioPublish(): boolean {
  if (state !== "STARTING" || !session) return false;
  state = "LIVE";
  session.watchdogsArmed = true;
  // Arm the barrier now: in a silent call the first arrival after this may be
  // a tick 250 ms away, and the watchdogs should already be live.
  noteArrival();
  return true;
}

/**
 * The E2EE transform assertion. `lk_e2ee` is a livekit INTERNAL with no public
 * surface, read through this one helper.
 *
 * 🔴 RE-VERIFY ON EVERY livekit-client BUMP. Pinned at 2.15.13:
 * `const E2EE_FLAG = 'lk_e2ee'`, set on the sender in `handleSender`, which
 * opens `if (E2EE_FLAG in sender || !this.worker) return` — a fresh sender
 * with a dead worker is skipped IN SILENCE. That silence is why a vacuous
 * check here would be worse than none: the failure is that the whole
 * system-audio capture goes to the SFU as PLAINTEXT while the signaling still
 * stamps GCM at participant level, so receivers fail-decrypt and drop, and the
 * symptom is "the far end hears nothing" — indistinguishable from a quiet
 * desktop.
 *
 * 🔴 Assert PER PUBLICATION, not once per share: livekit's full-reconnect
 * `republishAllTracks` unpublishes and republishes ScreenShareAudio, building
 * a NEW `RTCRtpSender`.
 *
 * This is a DETECTOR, not a preventer, and it does not close the window:
 * `LocalSenderCreated` fires INSIDE `negotiate()` while `LocalTrackPublished`
 * is emitted after it returns, so if the worker is dead the encoder can begin
 * emitting plaintext as soon as the answer is applied — tens to low hundreds
 * of milliseconds of server-visible plaintext media before we can react.
 */
export function screenAudioSenderEncrypted(
  sender: RTCRtpSender | undefined,
): boolean {
  if (!sender) return false;
  return "lk_e2ee" in sender;
}

/**
 * What to do when [`screenAudioSenderEncrypted`] says no.
 *
 * 🔴 The two states take DIFFERENT edges and the difference is load-bearing:
 *
 * - In `STARTING` this is a **death**. The publish window spans an SDP
 *   negotiation — hundreds of milliseconds, unbounded on a congested link —
 *   and the failure must LATCH so a publish that has not been issued yet is
 *   REFUSED rather than completed. Routing it through the ordinary stop path
 *   instead would enter `EXPECTED_STOP`, where the death branch is suppressed,
 *   and the publish would go ahead: the whole system-audio capture on the wire
 *   as plaintext while the signaling still stamps GCM.
 * - In `LIVE` there is a live publication, so the correct act is to UNPUBLISH
 *   FIRST — stop the plaintext sender — and then tear down normally.
 *
 * Both fail LOUD. The caller does nothing but report; the state transition and
 * the teardown belong here so the two edges cannot drift apart.
 */
export function screenAudioEncryptionFailed(): void {
  if (state === "STARTING") {
    // `die()` latches (so `beginScreenAudioPublish`/`finishScreenAudioPublish`
    // both refuse), discards the worklet queue, unpublishes if the publish was
    // already issued, tears down and reports.
    die({ kind: "not-encrypted" });
    return;
  }
  if (state === "LIVE") {
    const host = session?.host;
    // 🔴 UNPUBLISH FIRST, then report. Teardown's step 2 is the unpublish and
    // step 0 disarms before it, so the plaintext sender stops before anything
    // user-facing happens; reporting first would leave it producing while a
    // modal opened.
    void teardownScreenAudio().finally(() =>
      host?.report({ kind: "not-encrypted" }),
    );
  }
}

/** True while a session exists that the caller is expected to be publishing. */
export function screenAudioActive(): boolean {
  return state === "STARTING" || state === "LIVE";
}

export function screenAudioGeneration(): number | undefined {
  return session?.generation;
}

// ---------------------------------------------------------------------------
// Death and teardown
// ---------------------------------------------------------------------------

/** Every `→ DEAD` row in section 3.6.3 lands here. */
function die(failure: ScreenAudioFailure) {
  // Section 3.6.2: the death branch is SUPPRESSED in IDLE, EXPECTED_STOP and
  // DEAD. IDLE's cell reads "suppressed", not "n/a" — the died-event is
  // delivered asynchronously and can land after teardown already returned the
  // machine to IDLE, and an implementer who wrote
  // `if (state === 'EXPECTED_STOP') return` toasts a failure the user did not
  // have, one state later.
  if (state !== "STARTING" && state !== "LIVE") return;

  const active = session;
  state = "DEAD";
  if (!active) {
    // `STARTING` with no session yet: an in-flight `captureScreenAudio` is
    // still building the graph and would otherwise carry on and publish. Not
    // reachable today — `onShellDeath` latches rather than dying while there
    // is no session, and the E2EE path needs a publication — but it is one
    // new call site away from being live, and the cost of the flag is nothing.
    startCancelled = true;
    state = "IDLE";
    return;
  }

  active.watchdogsArmed = false;
  // 🔴 UNCONDITIONAL on every death. The sentinel carries no cause and the
  // died-event carries a generation but no cause, so we cannot tell a stale
  // exclusion root from any other death — and draining the deaths we cannot
  // attribute means draining the one that matters: up to 100 ms captured while
  // the exclusion named a dead process, i.e. the other participants' decrypted
  // voices, re-encrypted under this sharer's own key and delivered to the
  // whole call.
  discardWorkletQueue(active);
  stopTicking(active);
  releaseChannel(active);

  const host = active.host;
  // 🔴 A `→ DEAD` teardown does NOT re-enter EXPECTED_STOP: that state
  // suppresses the death branch, so re-entering step 0 from inside the death
  // path would suppress the discard rule from the one place it must never be,
  // and `DEAD → IDLE` would become unreachable.
  void runTeardownSteps(active, active.publishCalled).finally(() => {
    if (session === active) {
      session = undefined;
      state = "IDLE";
    }
  });

  host.report(failure);
}

function discardWorkletQueue(active: Session) {
  try {
    active.node.port.postMessage({ type: "discard" });
  } catch {
    /* the port is gone; nothing left to discard */
  }
}

function stopTicking(active: Session) {
  try {
    active.node.port.postMessage({ type: "stop-ticks" });
  } catch {
    /* the port is gone; the loops died with it */
  }
}

function releaseChannel(active: Session) {
  // Stop forwarding, then release the page-side buffer. `cleanupCallback()`
  // removes the only strong root (`window._<id>`), which makes the channel and
  // its private `#pendingMessages` collectable — insufficient on its own, so
  // it is done IN ADDITION to reaching step 5, which is what drops the Rust
  // side and lets the JS side's own cleanup run.
  active.channel.onmessage = () => undefined;
  try {
    active.channel.cleanupCallback?.();
  } catch {
    /* older api surface; step 5 still releases it */
  }
}

/**
 * Steps 1-5 of `teardownScreenAudio()`.
 *
 * 🔴 Each step runs under its OWN guard, so one rejecting step cannot strand
 * the rest. Without that rule the natural implementation is a plain sequential
 * `await` chain, and a rejecting `unpublish` — routine on a dropping socket —
 * never closes the AudioContext; repeated share/untick cycles then exhaust
 * Chromium's per-page context cap and ALL call audio dies, the voice pipeline
 * included. The shell's supersede rule self-heals only the NATIVE session; a
 * leaked renderer AudioContext has no supersede.
 */
async function runTeardownSteps(active: Session, unpublish: boolean) {
  const invoke = tauriInvoke();

  // Step 1: disown — ISSUED, NOT AWAITED. It gates nothing. "`.catch()`ed"
  // addresses rejection, not a hang, and a queued dispatch on a wedged event
  // loop can wait forever.
  void invoke?.("screen_audio_disown", { generation: active.generation }).catch(
    () => undefined,
  );

  // Step 2
  if (unpublish) {
    // 🔴 BOUNDED, not merely caught. Invariant 3's rule is "fire-and-forget,
    // or await under a short timeout" — because a guard that only handles
    // REJECTION does nothing about a HANG, and this call can hang: livekit's
    // `unpublishTrack` awaits `pendingPublishPromises` and then
    // `engine.negotiate()`, both of which sit on a dead PeerConnection after a
    // socket drop. An unbounded await here means step 4 never runs, and a few
    // drops later Chromium's per-page AudioContext cap is exhausted and ALL
    // call audio dies — the same failure the per-step guards exist to prevent,
    // reached through the hang door instead of the reject door.
    await settleWithin(active.host.unpublish(), 2_000, "unpublish");
  }

  // Step 3
  try {
    active.track.stop();
  } catch (error) {
    console.error("[screen-audio] destination track stop failed", error);
  }

  // Step 4
  try {
    active.node.disconnect();
    active.destination.disconnect();
    await active.context.close();
  } catch (error) {
    console.error("[screen-audio] AudioContext close failed", error);
  }

  // Step 5. Reaching this is load-bearing twice over: it stops the capture,
  // and dropping the shell's `Channel` is what makes the page-side callback
  // eligible for `cleanupCallback()`'s removal. Bounded for the same reason as
  // step 2 — if this one hangs, the machine is pinned in `EXPECTED_STOP` for
  // the life of the page and every subsequent share is silent with no
  // user-visible cause.
  if (invoke) {
    await settleWithin(
      invoke("screen_audio_stop", { generation: active.generation }),
      2_000,
      "stop",
    );
  }
}

/**
 * Await a promise, but never longer than `ms`. Rejections and timeouts are
 * both logged and swallowed: this is a teardown, and no step may gate the
 * next.
 */
async function settleWithin(
  work: Promise<unknown>,
  ms: number,
  what: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch((error) => {
        console.error(`[screen-audio] ${what} failed`, error);
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(`[screen-audio] ${what} did not settle within ${ms}ms`);
          resolve();
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The ONE choke point every stop path calls: the toggle's disable branch, the
 * ask-modal untick and cancel, the video track's `"ended"`, every error exit
 * in the capture helper, call leave, `disconnect()`, and
 * `RoomEvent.Disconnected`.
 *
 * Idempotent, and a no-op with no toast when there is no session —
 * `Disconnected` in particular fires on paths where teardown has already run,
 * including livekit's own `pagehide` / `beforeunload` / page-freeze handlers.
 */
export async function teardownScreenAudio(): Promise<void> {
  if (state === "EXPECTED_STOP") return;
  const active = session;
  if (!active) {
    // 🔴 `STARTING` with no session yet is the graph-construction window, and
    // a stop path landing there has to MEAN something: without this the
    // `disconnected` handler is a complete no-op while the shell is already
    // capturing, `captureScreenAudio` goes on to build the graph and publish
    // into a dead room, and livekit sits on its 15 s
    // `waitUntilEngineConnected` timeout — fifteen seconds of unowned desktop
    // capture, with the relay refreshing the shell's credit throughout.
    if (state === "STARTING") startCancelled = true;
    // Nothing else is armed. Deliberately NO IPC here: a dark build must not
    // talk to a shell that has no such command, and there is no session to
    // stop.
    return;
  }
  if (state === "IDLE" || state === "DEAD") return;

  // Step 0: DISARM, locally and synchronously. No IPC. This step cannot fail,
  // and it must precede the disown — otherwise the shell's terminal response
  // arrives at a still-armed renderer and toasts a failure the user did not
  // have on EVERY clean stop.
  state = "EXPECTED_STOP";
  active.watchdogsArmed = false;
  stopTicking(active);
  releaseChannel(active);

  await runTeardownSteps(active, true);

  if (session === active) {
    session = undefined;
    state = "IDLE";
  }
}

interface ScreenAudioDiagnostics {
  state: State;
  generation: number;
  /** 🔴 L13's discriminator. Once §11.7 retired "the audio engine went idle",
   *  the two surviving causes — the relay was throttled, or the audio render
   *  thread died — present IDENTICALLY at the shell-side tick counter. These
   *  two stamps are what separates them. */
  sinceFrameMs: number;
  sinceTickMs: number;
  lastReceivedSeq: number;
  /** §11.9's recorded verdict, so the lighting gate can be read from the same
   *  place as everything else. */
  exclusion?: { check: string; conclusivelyPassed: boolean; detail?: string };
}

export function screenAudioDiagnostics(): ScreenAudioDiagnostics | undefined {
  if (!session) return undefined;
  const now = performance.now();
  return {
    state,
    generation: session.generation,
    sinceFrameMs: now - session.lastFrameDeliveredAt,
    sinceTickMs: now - session.lastTickDeliveredAt,
    lastReceivedSeq: session.lastReceivedSeq,
    exclusion: probeResult?.exclusion,
  };
}

/**
 * 🔴 A REACHABLE debug surface, because two module-scope exports in a minified
 * bundle are not one.
 *
 * L13 requires both delivery stamps in its recorded output and §11.9's verdict
 * gates lighting, and neither can be read from devtools against a bundled
 * dist without this. Installed only when the build flag is lit, so a dark
 * build adds no global; read-only, and it exposes counters and a verdict —
 * never audio, never a track, never a key.
 */
if (
  typeof window !== "undefined" &&
  CONFIGURATION.ENABLE_WIN_NATIVE_SCREEN_AUDIO
) {
  (window as unknown as { __slogaScreenAudio?: unknown }).__slogaScreenAudio = {
    diagnostics: screenAudioDiagnostics,
    exclusion: screenAudioExclusionStatus,
    supported: screenAudioSupported,
    pickerAudioSuppressed: screenAudioPickerAudioSuppressed,
  };
}
