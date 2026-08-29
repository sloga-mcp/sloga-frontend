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

/** Slice 2 gets `{ includePid }`; slice 1 implements `"system"` only. */
export type ScreenAudioMode = "system" | { includePid: number };

/** What the host (`Voice`) must be able to do on our behalf. */
export interface ScreenAudioHost {
  /**
   * Unpublish the ScreenShareAudio publication if one exists. Must be
   * idempotent and must never throw — it is called from a death path.
   */
  unpublish(): Promise<void>;
  /** Loud, user-visible failure. Never silent: a silent zombie is the one
   *  outcome this whole protocol exists to prevent. */
  toast(message: string): void;
}

export interface ScreenAudioCapture {
  /** The track to publish. */
  track: MediaStreamTrack;
  /** The shell's session token, stamped on every tick and disown. */
  generation: number;
}

/** Section 3.6.2's states, verbatim. */
type State = "IDLE" | "STARTING" | "LIVE" | "EXPECTED_STOP" | "DEAD";

/** Section 3.6.5, handed over by the shell rather than restated here — every
 *  restatement of a derived number is a place for two copies to diverge, and
 *  the design shipped a stale one twice for exactly that reason. */
interface Timings {
  tickCadenceMs: number;
  quantaPerTick: number;
  frameWatchdogMs: number;
  relayWatchdogMs: number;
  heartbeatQuanta: number;
  jitterTargetMs: number;
  frameMs: number;
}

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
}

interface CommandError {
  code: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Wire format. Must match `screen-audio/src/frame.rs`.
// ---------------------------------------------------------------------------

const HEADER_BYTES = 24;
const WIRE_VERSION = 1;
const FLAG_SENTINEL = 1 << 0;

interface FrameHeader {
  version: number;
  flags: number;
  generation: number;
  seq: number;
}

function readHeader(buffer: ArrayBuffer): FrameHeader | undefined {
  if (buffer.byteLength < HEADER_BYTES) return undefined;
  const view = new DataView(buffer);
  return {
    version: view.getUint16(0, true),
    flags: view.getUint16(2, true),
    generation: view.getUint32(4, true),
    // Safe as a Number: at 100 frames/s a 2^53 sequence is ~2.8 million years.
    seq: Number(view.getBigUint64(8, true)),
  };
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
 * Died-events that arrived while `screen_audio_start` was still in flight, so
 * before we could adopt a generation.
 *
 * Section 3.6.3: `STARTING` is entered at the CALL and G is only known when
 * `start` RESOLVES, so a died-event landing in that window must be latched
 * against the generation `start` is about to return, never dropped as stale.
 */
let pendingDeaths: number[] = [];
let awaitingGeneration = false;

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

async function probe(): Promise<ProbeResult | undefined> {
  const invoke = tauriInvoke();
  if (!invoke) return undefined;
  if (!probeCache) {
    probeCache = invoke<ProbeResult>("screen_audio_probe").catch((error) => {
      // An old shell has no such command; a new one that fails the probe is
      // reporting a real incapability. Both mean "not available", and neither
      // is worth a toast — the share proceeds without system audio.
      console.warn("[screen-audio] probe failed", error);
      return undefined;
    });
  }
  return probeCache;
}

/**
 * The single capability choke point: build flag AND platform AND the shell's
 * own probe (which also carries the `SLOGA_NO_SCREEN_AUDIO=1` escape).
 *
 * 🔴 Callers must key `audio: false` into getDisplayMedia on THIS, never on
 * whether the user wants screen audio. The two are different questions and
 * conflating them resurrects the measured-broken browser loopback on the one
 * shell this feature fixes.
 */
export async function screenAudioSupported(): Promise<boolean> {
  if (!CONFIGURATION.ENABLE_WIN_NATIVE_SCREEN_AUDIO) return false;
  if (!isWindowsShell()) return false;
  const result = await probe();
  return !!result?.available;
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
function ensureDeathListener() {
  if (deathListenerRegistered) return;
  const tauri = (window as { __TAURI__?: TauriEventApi }).__TAURI__;
  if (!tauri?.event) return;
  deathListenerRegistered = true;
  void tauri.event
    .listen<{ generation: number; reason: string }>(
      "screen-audio-died",
      (event) => onShellDeath(event.payload.generation, event.payload.reason),
    )
    .catch((error) => {
      deathListenerRegistered = false;
      console.error("[screen-audio] death listener failed to register", error);
    });
}

function onShellDeath(generation: number, reason: string) {
  if (awaitingGeneration && !session) {
    // Section 3.6.3: latch it against the generation `start` is about to
    // return. Dropping it as stale is how a share publishes frames captured
    // after its producer died.
    pendingDeaths.push(generation);
    return;
  }
  if (!session || generation !== session.generation) return;
  die(`screen audio stopped (${reason})`);
}

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

  const framesStale = framesStaleFor > active.timings.frameWatchdogMs;
  const ticksStale = ticksStaleFor > active.timings.relayWatchdogMs;

  // 🔴 §3.6.4 invariant 2, stated as the three-way decision it actually is —
  // BOTH loops are conditioned on the other's freshness, not just loop 8.
  //
  // Both stale is a MAIN-THREAD WEDGE: nothing was delivered because nothing
  // was running, and slice 0 measured that state as survivable (a 2 s wedge
  // produced one silent gap, 2.1 s of stale audio discarded, and the queue
  // back at target within ~608 ms, with no permanent latency growth). Tearing
  // down there kills a share that was about to recover on its own.
  //
  // The quiescence barrier already makes this hard to observe — arrivals
  // refresh both stamps before the barrier is ever scheduled — but the
  // invariant is not "unreachable in practice", it is a rule, and the loop
  // that would violate it is the one whose trip is a teardown.
  if (framesStale && ticksStale) return;

  if (framesStale) {
    // Loop 7 — frames stale while ticks are FRESH: the main thread is running
    // its own tasks and our audio graph is alive, so the producer or the
    // transport died. The feed is continuous BY CONSTRUCTION — the shell
    // synthesizes silence for capture gaps and a gated session still emits the
    // keepalive — so this unambiguously means death, never quiet audio. It is
    // also the ONLY detector of a wedged Tauri channel fetch, whose rejection
    // is swallowed by a bare `.catch` in the injected JS while
    // `Channel::send` keeps returning Ok.
    die("screen audio stopped (no frames from the capture)");
    return;
  }

  if (ticksStale) {
    // Loop 8 — ticks stale while frames are FRESH: frames keep arriving and
    // look healthy while our audio render thread has died (context suspended,
    // sink error, endpoint loss). Before tick generation moved onto the audio
    // thread both signals shared a thread and this failure could not be seen
    // at all.
    die("screen audio stopped (the audio graph stopped running)");
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

  ensureDeathListener();

  state = "STARTING";
  awaitingGeneration = true;
  pendingDeaths = [];

  const channel: TauriChannel = new ChannelCtor();
  let started: StartResult;
  try {
    started = await invoke<StartResult>("screen_audio_start", { channel });
  } catch (error) {
    // Section 3.6.3's `screen_audio_start rejects` row: back to IDLE, toast,
    // and the share continues SILENT. Leaving the machine in STARTING here is
    // what an earlier revision did, and it never recovered.
    state = "IDLE";
    awaitingGeneration = false;
    channel.cleanupCallback?.();
    const failure = error as Partial<CommandError>;
    options.host.toast(startFailureMessage(failure));
    return undefined;
  }

  const generation = started.generation;
  awaitingGeneration = false;

  // The latch: a death that arrived before we knew our own generation.
  if (pendingDeaths.includes(generation)) {
    pendingDeaths = [];
    state = "IDLE";
    channel.cleanupCallback?.();
    void invoke("screen_audio_stop").catch(() => undefined);
    options.host.toast("Screen audio could not start.");
    return undefined;
  }
  pendingDeaths = [];

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
    state = "EXPECTED_STOP";
    channel.cleanupCallback?.();
    void invoke("screen_audio_disown", { generation }).catch(() => undefined);
    void invoke("screen_audio_stop").catch(() => undefined);
    state = "IDLE";
    options.host.toast("Screen audio could not start.");
    return undefined;
  }

  try {
    await context.audioWorklet.addModule(workletUrl());
    // The context is created after the picker interaction, which is browser
    // chrome and grants no page activation — sticky activation "usually"
    // covering it is not a design guarantee.
    if (context.state !== "running") await context.resume();

    const node = new AudioWorkletNode(context, "ScreenAudioWorklet", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [started.format.channels],
      processorOptions: {
        channels: started.format.channels,
        sampleRate: started.format.rate,
        jitterTargetMs: started.timings.jitterTargetMs,
        quantaPerTick: started.timings.quantaPerTick,
        heartbeatQuanta: started.timings.heartbeatQuanta,
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
      timings: started.timings,
      publishCalled: false,
      lastFrameDeliveredAt: performance.now(),
      lastTickDeliveredAt: performance.now(),
      lastReceivedSeq: 0,
      watchdogsArmed: false,
      relayInFlight: false,
      relayPending: false,
    };
    session = active;

    channel.onmessage = (message) => onFrame(active, message);
    node.port.onmessage = (event) => onWorkletMessage(active, event.data);

    if (context.state !== "running") {
      throw new Error(`AudioContext is ${context.state}, not running`);
    }

    return { track, generation };
  } catch (error) {
    console.error("[screen-audio] graph construction failed", error);
    session = undefined;
    state = "EXPECTED_STOP";
    channel.cleanupCallback?.();
    void invoke("screen_audio_disown", { generation }).catch(() => undefined);
    await context.close().catch(() => undefined);
    void invoke("screen_audio_stop").catch(() => undefined);
    state = "IDLE";
    options.host.toast("Screen audio could not start.");
    return undefined;
  }
}

function startFailureMessage(error: Partial<CommandError>): string {
  switch (error.code) {
    case "no-root":
      // The multi-instance case, named so it is diagnosable from a user
      // report rather than landing as an unrecognizable capability loss.
      return "Screen audio is unavailable in this window. If you are running a second copy of Sloga, only the first one can share system audio.";
    case "unsupported":
      return "This version of Windows cannot share system audio natively.";
    case "disabled-by-env":
      return "Screen audio is disabled on this machine.";
    default:
      return "Screen audio could not start; sharing without it.";
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
    die("screen audio stopped");
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
      if (active.relayPending && session === active) {
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
  const message = "Screen audio could not be encrypted and was stopped.";
  if (state === "STARTING") {
    // `die()` latches (so `beginScreenAudioPublish`/`finishScreenAudioPublish`
    // both refuse), discards the worklet queue, unpublishes if the publish was
    // already issued, tears down and toasts.
    die(message);
    return;
  }
  if (state === "LIVE") {
    const host = session?.host;
    // Teardown's step 2 IS the unpublish, and step 0 disarms first so the
    // shell's terminal response cannot arrive at an armed renderer.
    void teardownScreenAudio().finally(() => host?.toast(message));
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
function die(message: string) {
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

  host.toast(message);
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
    try {
      await active.host.unpublish();
    } catch (error) {
      console.error("[screen-audio] unpublish failed", error);
    }
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
  // eligible for `cleanupCallback()`'s removal.
  try {
    await invoke?.("screen_audio_stop");
  } catch (error) {
    console.error("[screen-audio] stop failed", error);
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
  if (!active || state === "IDLE" || state === "DEAD") {
    // Nothing armed. Still ask the shell to stop, in case a session outlived
    // a renderer that lost track of it — the command is idempotent and
    // answers Ok on an unknown generation.
    const invoke = tauriInvoke();
    if (invoke && state === "IDLE") {
      void invoke("screen_audio_stop").catch(() => undefined);
    }
    return;
  }

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

/** Diagnostics for the live legs — L13 cannot separate "the relay was
 *  throttled" from "the audio render thread died" without both stamps. */
export function screenAudioDiagnostics():
  | {
      state: State;
      generation: number;
      sinceFrameMs: number;
      sinceTickMs: number;
      lastReceivedSeq: number;
    }
  | undefined {
  if (!session) return undefined;
  const now = performance.now();
  return {
    state,
    generation: session.generation,
    sinceFrameMs: now - session.lastFrameDeliveredAt,
    sinceTickMs: now - session.lastTickDeliveredAt,
    lastReceivedSeq: session.lastReceivedSeq,
  };
}
