/**
 * The WebKit sender hold (plan D7) — when a local publication on a
 * script-transform engine may stop being paused. Pure and dependency-free for
 * the house reason: `state.tsx` cannot be loaded by `node --test`, so the rule
 * lives here, is pinned by `webkitSenderHold.test.ts`, and `state.tsx` keeps
 * only the wiring (the `"webkit-hold"` gate reason, owner ruling R1).
 *
 * 🔴 Why there is a hold at all. On Chromium an RTP sender with no transform
 * attached sends NOTHING. On WebKit it sends PLAINTEXT (measured, plan
 * §2.2/§2.4). livekit attaches the transform as the sender is created, so the
 * gaps are the senders made outside `LocalSenderCreated` (additional/backup
 * codec senders), a `handleSender` that throws, and the worker passing frames
 * through unencrypted while the identity is not `enable`d. So on iOS every
 * local publication is born paused through the existing `pauseUpstream` gate,
 * and this module decides when it may resume: for EVERY sender of the
 * publication, including `simulcastCodecs` senders, the worker has acked an
 * ENCODE transform for that `trackId`; the worker has enabled the local
 * identity; and the worker has acked the CURRENT local key.
 *
 * The acks come from the patched livekit worker (C7) in livekit's own
 * `{kind, data}` envelope:
 *   - `slogaSetKeyAck`        `{identity, keyIndex, ok}` after every `setKey`
 *   - `slogaTransformAttached` `{trackId, kind: "encode" | "decode"}`
 * Neither carries key material, and nothing parsed here keeps any field it
 * does not name.
 *
 * 🔴 ONE-WAY, like the decode witness. The verdict can only withhold a
 * release. It never lifts any other gate reason, and on a non-script-transform
 * engine it says "release" only for ITS reason: Chromium never asserts
 * `"webkit-hold"`, so nothing changes on Windows, Linux or Android (R3).
 */

/**
 * How long a caller waits for the worker to ack a `setKey` before the local
 * key counts as NOT installed. A lost ack must end in a loud failure, not a
 * call that hangs in "installing".
 */
export const KEY_ACK_TIMEOUT_MS = 5_000;

/**
 * Upper bound on an injected timeout. Browsers store the delay as a signed
 * 32-bit int, and anything above it overflows to fire IMMEDIATELY — a wait
 * that times out at once, every time, which is a false red rather than a
 * leak, but still not the timeout anyone asked for.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Whether this platform's WebRTC sends plaintext from a sender that has no
 * transform. Only iOS (WKWebView, `RTCRtpScriptTransform`). Strict equality on
 * Capacitor's platform string: everything else is a Chromium engine here.
 */
export function isScriptTransformEngine(platform: string): boolean {
  return platform === "ios";
}

export type SlogaWorkerAck =
  | { kind: "setKeyAck"; identity: string; keyIndex: number; ok: boolean }
  | { kind: "transformAttached"; trackId: string; dir: "encode" | "decode" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * A livekit key index: a non-negative integer. Sloga's are `epoch mod 16`;
 * the frame trailer stores one byte. The upper bound is not checked here — an
 * out-of-range index would simply never match a key the caller is waiting on.
 */
const isKeyIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Parse one worker message into an ack, or `undefined` if it is not one.
 *
 * 🔴 Strict, field by field. `ok` must be the boolean `true`/`false`: the
 * strings `"true"`/`"false"` and `1`/`0` are rejected, because a truthy read
 * turns a failed import into "key installed". An empty identity or trackId is
 * rejected too — it is exactly the case that makes livekit's `handleSender`
 * throw, and an ack for it can only be a skewed worker. A message that is ours
 * by kind but wrong by shape is NOT an ack: absence of a yes is a no.
 */
export function parseSlogaWorkerAck(data: unknown): SlogaWorkerAck | undefined {
  if (!isRecord(data)) return undefined;
  const body = data.data;
  if (!isRecord(body)) return undefined;
  if (data.kind === "slogaSetKeyAck") {
    const { identity, keyIndex, ok } = body;
    if (!isIdentity(identity)) return undefined;
    if (!isKeyIndex(keyIndex)) return undefined;
    if (typeof ok !== "boolean") return undefined;
    return { kind: "setKeyAck", identity, keyIndex, ok };
  }
  if (data.kind === "slogaTransformAttached") {
    const { trackId, kind } = body;
    if (!isIdentity(trackId)) return undefined;
    if (kind !== "encode" && kind !== "decode") return undefined;
    return { kind: "transformAttached", trackId, dir: kind };
  }
  return undefined;
}

export interface WorkerAckTracker {
  /** Feed every worker message (`MessageEvent.data`); non-acks are ignored. */
  onMessage(data: unknown): void;
  /** An ENCODE transform has been acked for `trackId`. */
  attached(trackId: string): boolean;
  /**
   * A NEW sender is taking over `trackId`: drop its encode-attached record,
   * so {@link WorkerAckTracker.attached} is false until a new encode ack
   * arrives. livekit's transform `trackId` is the `mediaStreamID`, which a
   * republish keeps, so without this the OLD sender's ack would release the
   * new sender before its own transform exists — plaintext on WebKit.
   *
   * 🔴 Ordering contract (acks carry no sequence number, so this module
   * cannot tell an old ack from a new one). The caller calls this
   * SYNCHRONOUSLY in its `LocalSenderCreated` handling, before livekit's
   * `handleSender` posts anything to the worker for the new sender; and the
   * patched worker posts `slogaTransformAttached` only AFTER it has set the
   * transform up. Worker messages arrive in order, so every ack delivered
   * after this call is then for a transform set up after it. The residual
   * case: an ack the worker posted for the PREVIOUS sender that is still
   * queued on the main thread when this runs would count. That needs the
   * old sender's transform to have been set up within one message-queue
   * drain of the republish; the caller must not rely on it being impossible
   * if it ever replaces senders back to back.
   */
  forgetTrack(trackId: string): void;
  /**
   * The latest ack for this identity and index was `ok: true`, and no
   * {@link WorkerAckTracker.waitKeyAck} for it has started since.
   */
  keyAcked(identity: string, keyIndex: number): boolean;
  /**
   * Wait for the worker to ack a key the caller has JUST posted. `true` on an
   * `ok: true` ack; `false` on `ok: false`, on timeout, or on
   * {@link WorkerAckTracker.reset}.
   *
   * 🔴 It waits for a FRESH ack and withdraws any earlier one for the same
   * pair. livekit indexes are `epoch mod 16`, so epoch 19 reuses epoch 3's
   * slot, and the ack from epoch 3 says nothing about epoch 19's key —
   * resolving on it would claim "installed" while the worker still encrypts
   * under a key this device should no longer hold. The consequence for the
   * caller: call this in the same task that posted the key (before any
   * `await`). The worker's reply is a separate message event, so it cannot
   * arrive before that; if the caller yields first and the ack lands in
   * between, the wait times out and fails LOUD, never open.
   */
  waitKeyAck(identity: string, keyIndex: number): Promise<boolean>;
  /** New Room or new worker: forget every ack; pending waits resolve false. */
  reset(): void;
}

export interface WorkerAckTrackerDeps {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  timeoutMs?: number;
}

interface PendingWait {
  identity: string;
  keyIndex: number;
  handle: unknown;
  settle: (ok: boolean) => void;
}

/**
 * Build the tracker. Its methods are closures, so `tracker.attached` and
 * `tracker.keyAcked` can be handed to {@link senderHoldVerdict} unbound.
 */
export function createWorkerAckTracker(
  deps: WorkerAckTrackerDeps,
): WorkerAckTracker {
  // 🔴 Taken out of the bag and called UNBOUND. Production passes the window
  // globals straight in, and `deps.setTimeout(fn, ms)` would call them with
  // `this === deps`, which a browser rejects with "Illegal invocation" — the
  // first key wait on the device would throw.
  const setTimer = deps.setTimeout;
  const clearTimer = deps.clearTimeout;
  const timeoutMs = deps.timeoutMs ?? KEY_ACK_TIMEOUT_MS;
  // One guard, written so NaN fails it too (every comparison with NaN is
  // false). Infinity and anything past a browser timer's range fail the
  // upper bound.
  if (!(timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
    throw new RangeError(
      `webkit sender hold: key-ack timeout must be in (0, ${MAX_TIMER_MS}] ` +
        `ms (got ${timeoutMs}); a wait that never times out hangs the call ` +
        `instead of failing loud`,
    );
  }

  const encodeAttached = new Set<string>();
  /** identity → keyIndex → the latest ack's `ok`. Nested: no separator. */
  const acks = new Map<string, Map<number, boolean>>();
  const pending = new Set<PendingWait>();

  const setAck = (identity: string, keyIndex: number, ok: boolean) => {
    let byIndex = acks.get(identity);
    if (!byIndex) {
      byIndex = new Map();
      acks.set(identity, byIndex);
    }
    byIndex.set(keyIndex, ok);
  };

  const keyAcked = (identity: string, keyIndex: number): boolean =>
    acks.get(identity)?.get(keyIndex) === true;

  const attached = (trackId: string): boolean => encodeAttached.has(trackId);

  return {
    attached,
    keyAcked,

    forgetTrack(trackId: string): void {
      encodeAttached.delete(trackId);
    },

    onMessage(data: unknown): void {
      const ack = parseSlogaWorkerAck(data);
      if (!ack) return;
      if (ack.kind === "transformAttached") {
        // A decode transform with the same id is the receive side; it says
        // nothing about what this device sends.
        if (ack.dir === "encode") encodeAttached.add(ack.trackId);
        return;
      }
      setAck(ack.identity, ack.keyIndex, ack.ok);
      for (const wait of [...pending]) {
        if (wait.identity === ack.identity && wait.keyIndex === ack.keyIndex) {
          wait.settle(ack.ok);
        }
      }
    },

    waitKeyAck(identity: string, keyIndex: number): Promise<boolean> {
      // No parsed ack can ever carry these, so the wait could only time out.
      if (!isIdentity(identity) || !isKeyIndex(keyIndex)) {
        return Promise.resolve(false);
      }
      acks.get(identity)?.delete(keyIndex);
      return new Promise<boolean>((resolve) => {
        const wait: PendingWait = {
          identity,
          keyIndex,
          handle: undefined,
          settle: (ok) => {
            if (!pending.delete(wait)) return;
            clearTimer(wait.handle);
            resolve(ok);
          },
        };
        pending.add(wait);
        wait.handle = setTimer(() => wait.settle(false), timeoutMs);
      });
    },

    reset(): void {
      encodeAttached.clear();
      acks.clear();
      for (const wait of [...pending]) wait.settle(false);
    },
  };
}

// --- the worker's enable replies (Stage 6 MINOR 1) ----------------------------

/** The worker's `enable` reply, `{kind:"enable", data:{participantIdentity, enabled}}`. */
function workerEnableReply(
  data: unknown,
): { identity: string; enabled: boolean } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { kind, data: body } = data as { kind?: unknown; data?: unknown };
  if (kind !== "enable" || typeof body !== "object" || body === null)
    return undefined;
  const { participantIdentity, enabled } = body as {
    participantIdentity?: unknown;
    enabled?: unknown;
  };
  if (typeof participantIdentity !== "string" || participantIdentity === "")
    return undefined;
  if (typeof enabled !== "boolean") return undefined;
  return { identity: participantIdentity, enabled };
}

/**
 * ONE call worker's `enable` replies, by identity: the hold verdict's
 * `localIdentityEnabled` term (R2, D7.3).
 *
 * 🔴 One per worker, never reused. A single map shared across workers was
 * emptied only by the old worker's unbind; a teardown that threw before it
 * carried the last call's `local → true` into the next call, whose identity
 * is the same `user:device`, so the NEW worker's senders were released before
 * it had processed `enable` — plaintext on WebKit. A ledger is written only
 * by its own worker's listener, and once closed nothing writes it again, so a
 * late message from a dead worker cannot repopulate it either.
 */
export interface WorkerEnableLedger {
  /** The replies recorded so far; live, and empty once closed. */
  readonly enabled: ReadonlyMap<string, boolean>;
  /** Feed every worker message (`MessageEvent.data`); non-enable ones are ignored. */
  record(data: unknown): void;
  /** The worker is gone: empty the ledger; every later `record` is ignored. */
  close(): void;
}

/**
 * The enable replies when no worker is bound: none. Typed read-only and
 * never written by this module; no ledger is backed by it.
 */
export const NO_WORKER_ENABLED: ReadonlyMap<string, boolean> = new Map();

/** A fresh, empty ledger for one newly bound worker. */
export function createWorkerEnableLedger(): WorkerEnableLedger {
  const replies = new Map<string, boolean>();
  let closed = false;
  return {
    enabled: replies,
    record(data: unknown): void {
      if (closed) return;
      const reply = workerEnableReply(data);
      if (reply) replies.set(reply.identity, reply.enabled);
    },
    close(): void {
      closed = true;
      replies.clear();
    },
  };
}

export interface SenderHoldInput {
  scriptTransformEngine: boolean;
  /** Every sender of ONE local publication, incl. `simulcastCodecs` senders. */
  senderTrackIds: readonly string[];
  attached: (trackId: string) => boolean;
  /** The worker's `enable` reply for the local identity. */
  localIdentityEnabled: boolean;
  /** The current local send key. */
  localKey: { identity: string; keyIndex: number } | undefined;
  keyAcked: (identity: string, keyIndex: number) => boolean;
}

export type SenderHoldVerdict =
  | { release: true }
  | {
      release: false;
      reason:
        | "no_senders"
        | "transform_unacked"
        | "not_enabled"
        | "key_unacked";
    };

/** A predicate that throws is a predicate that did not say yes. */
const says = (ask: () => boolean): boolean => {
  try {
    return ask() === true;
  } catch {
    return false;
  }
};

/**
 * May this ONE local publication resume? Run it for every current local
 * publication; the `"webkit-hold"` reason is released only when all of them
 * release.
 *
 * 🔴 Every term is checked against strict `true`, including the engine flag:
 * release-by-default is reserved for an engine flag that is exactly `false`,
 * so a wiring slip that hands in `undefined` holds instead of reading as
 * "Chromium". And the sender check covers EVERY sender: an SFU quality update
 * that adds an h264 sender makes the list grow, and the new, unacked sender
 * puts the publication back on hold until its own transform ack arrives.
 */
export function senderHoldVerdict(input: SenderHoldInput): SenderHoldVerdict {
  if (input.scriptTransformEngine === false) return { release: true };
  const { senderTrackIds } = input;
  if (senderTrackIds.length === 0) {
    return { release: false, reason: "no_senders" };
  }
  for (const trackId of senderTrackIds) {
    if (!says(() => input.attached(trackId))) {
      return { release: false, reason: "transform_unacked" };
    }
  }
  if (input.localIdentityEnabled !== true) {
    return { release: false, reason: "not_enabled" };
  }
  const key = input.localKey;
  if (!key || !says(() => input.keyAcked(key.identity, key.keyIndex))) {
    return { release: false, reason: "key_unacked" };
  }
  return { release: true };
}

// --- the review's assembly ----------------------------------------------------
//
// 🔴 Why this is here. The verdict above judges ONE publication; WHICH
// senders get judged, and with what key and enable state, used to be
// assembled inline in `state.tsx`'s `#reviewWebkitHold`, pinned only by
// source text. Every term of that assembly is a release path: drop the born
// set and an unlisted sender goes unjudged; read the wrong key entry and an
// old ack releases; skip a publication and its sender is never asked about.
// So the assembly is a pure function of plain data, and `state.tsx` keeps
// only the reads from livekit objects and the gate calls.

/** One local track, read off livekit by the caller. `ref` is handed back. */
export interface WebkitHoldTrack<T = unknown> {
  /** The caller's own handle (the `LocalTrack`), returned in `endedBorn`. */
  ref: T;
  /** `track.mediaStreamID`: the transform `trackId` livekit passes (R15). */
  mediaStreamID: string;
  /** `track.mediaStreamTrack?.readyState === "ended"`. */
  ended: boolean;
  /**
   * The codecs of `simulcastCodecs` entries that HAVE a sender, in the
   * Map's iteration order (`[]` for audio, or a video track with none).
   */
  codecSenders: readonly string[];
}

export interface WebkitHoldState<T = unknown> {
  scriptTransformEngine: boolean;
  /** `room.localParticipant.identity`. */
  localIdentity: string;
  /**
   * `pub.track` of every local publication, in `trackPublications` order;
   * `undefined` where the publication has no track.
   */
  publications: readonly (WebkitHoldTrack<T> | undefined)[];
  /** Tracks whose sender was created and that are not listed yet. */
  born: readonly WebkitHoldTrack<T>[];
  /** The key provider's `getKeys()`; `undefined` when there is no provider. */
  providerKeys:
    | readonly { participantIdentity: string; keyIndex: number }[]
    | undefined;
  /** The worker's `enable` replies, by identity. */
  workerEnabled: ReadonlyMap<string, boolean>;
  attached: (trackId: string) => boolean;
  keyAcked: (identity: string, keyIndex: number) => boolean;
}

export interface WebkitHoldInputs<T = unknown> {
  /** One verdict input per listed publication, then per live born sender. */
  inputs: SenderHoldInput[];
  /** Born tracks whose capture ENDED: the caller drops them from `born`. */
  endedBorn: T[];
}

/**
 * The marker in an additional-codec sender's id. Such a sender is created
 * outside `LocalSenderCreated`, so livekit never gives it a transform (and
 * the patch refuses to create one under an e2eeManager, D7.1).
 */
const CODEC_SENDER_MARK = "#codec:";

/**
 * Every sender id of one local track: its `mediaStreamID`, then one id per
 * additional-codec sender. `[]` for no track.
 */
export function webkitSenderTrackIds(
  track: Pick<WebkitHoldTrack, "mediaStreamID" | "codecSenders"> | undefined,
): string[] {
  if (!track) return [];
  return [
    track.mediaStreamID,
    ...track.codecSenders.map(
      (codec) => `${track.mediaStreamID}${CODEC_SENDER_MARK}${codec}`,
    ),
  ];
}

/**
 * Build the verdict inputs for one review of the R1 hold, from plain data.
 * Reproduces `#reviewWebkitHold`'s assembly, with one deliberate tightening:
 *
 *  - judged: every listed publication's track (a trackless publication
 *    yields an input with NO senders, which holds), then every born track
 *    whose capture has not ended. Ended born tracks are not judged and are
 *    returned in `endedBorn` for the caller to prune. A LISTED track is
 *    judged whether or not it ended, exactly as before.
 *  - local key: the LAST `providerKeys` entry whose identity is EXACTLY the
 *    local identity (the provider serves the local key last; a
 *    `{local}:screen` leg entry is a different identity and never matches).
 *  - enabled: the worker's reply for the local identity, strictly `true`.
 *  - 🔴 tightened: an additional-codec sender's id is never `attached`,
 *    whatever an ack says. The inline code relied on "no worker ack can
 *    carry that id"; nothing in the parser enforced it. Now it holds by
 *    construction.
 */
export function webkitHoldInputs<T>(
  state: WebkitHoldState<T>,
): WebkitHoldInputs<T> {
  const local = state.localIdentity;
  let localKey: SenderHoldInput["localKey"];
  for (const key of state.providerKeys ?? []) {
    if (key.participantIdentity === local) {
      localKey = { identity: key.participantIdentity, keyIndex: key.keyIndex };
    }
  }
  const attached = (trackId: string): boolean =>
    !trackId.includes(CODEC_SENDER_MARK) && state.attached(trackId);
  const endedBorn: T[] = [];
  const judged: (WebkitHoldTrack<T> | undefined)[] = [...state.publications];
  for (const track of state.born) {
    if (track.ended) endedBorn.push(track.ref);
    else judged.push(track);
  }
  const localIdentityEnabled = state.workerEnabled.get(local) === true;
  return {
    endedBorn,
    inputs: judged.map((track) => ({
      scriptTransformEngine: state.scriptTransformEngine,
      senderTrackIds: webkitSenderTrackIds(track),
      attached,
      localIdentityEnabled,
      localKey,
      keyAcked: state.keyAcked,
    })),
  };
}

/**
 * Whether the review releases the R1 hold: EVERY input releases. An empty
 * list releases, as the inline loop did — with nothing listed and nothing
 * born nothing can send, and the next sender re-asserts the hold at its own
 * birth (`#webkitHoldAtBirth`), so that guarantee rests on that call site.
 */
export function webkitHoldReleased(
  inputs: readonly SenderHoldInput[],
): boolean {
  return inputs.every((input) => senderHoldVerdict(input).release);
}

// --- the hold's bound ---------------------------------------------------------

/**
 * How long the R1 hold may stand on a connected Room before it is a failure.
 * Unbounded, one sender whose transform ack never arrives silences this
 * iPhone for the rest of the call, behind a chip that can still read green:
 * a silent failure, which the design forbids. Same budget as a key ack.
 */
export const WEBKIT_HOLD_BOUND_MS = KEY_ACK_TIMEOUT_MS;

/**
 * Has the hold stood too long? Only on a connected Room (`roomConnected`
 * strictly `true`): before connect, and while reconnecting, nothing can be
 * acked, and the bound must not fire. On a connected Room an unreadable
 * clock (NaN, ±Infinity) counts as overdue — `NaN >= bound` is false, so a
 * naive comparison would quietly restore the unbounded hold.
 */
export function webkitHoldOverdue(input: {
  heldSinceMs: number;
  nowMs: number;
  roomConnected: boolean;
}): boolean {
  if (input.roomConnected !== true) return false;
  const { heldSinceMs, nowMs } = input;
  if (!Number.isFinite(heldSinceMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - heldSinceMs >= WEBKIT_HOLD_BOUND_MS;
}
