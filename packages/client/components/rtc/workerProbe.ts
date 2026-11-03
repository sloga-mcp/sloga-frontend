/**
 * The app-start probe of the E2EE worker (plan D8, audit M5). This is the pure
 * core; `state.tsx` owns only the wiring, which has to construct the shipped
 * `E2EEWorker`. It is split out for the house reason: `state.tsx` pulls in
 * Solid, LiveKit and the bridge and cannot be loaded by `node --test`, so a
 * rule worth pinning has to live here (same rule as `decodeWitnessListener`).
 *
 * Why a probe at all. Media E2EE capability is decided SYNCHRONOUSLY, at Room
 * construction and at KeyPackage pre-publish, and flipping a call to
 * "unsupported" after that would contradict the existing fail-safe. On iOS the
 * question "can this device's worker actually transform frames?" is answered
 * only by running the worker. So once per app life, before anything reads the
 * capability predicate, this constructs the shipped worker, sends it the same
 * `init` livekit's `E2EEManager.setup` sends, and waits for two things:
 *
 *   1. livekit's `initAck` reply: the worker loaded and its message loop runs;
 *   2. a `slogaDecodeWitness` heartbeat whose `data.rte === "function"`: the
 *      patched worker reports `typeof self.RTCTransformEvent`, so a worker that
 *      has no script-transform event cannot pass.
 *
 * 🔴 Fail closed on every other path. "pass" needs BOTH replies before the
 * timeout. A timeout, an `error` event, a `makeWorker` throw, a heartbeat with
 * any other `rte` (including a pre-`rte` patch, which posts none), a livekit
 * `error` reply, a throw from the worker API, or a bad timeout value all give
 * "fail". Before a probe settles, {@link workerProbeResult} says "pending",
 * which the predicate (`iosMediaE2EEReady`) reads as "not ready". Neither
 * "pending" nor "fail" can ever become "pass" without both replies.
 *
 * 🔴 Never posts a key. The only message sent is `init`, carrying Sloga's
 * key-provider options (the same object `MlsKeyProvider` hands livekit:
 * `sharedKey:false`, `ratchetWindowSize:0`, `failureTolerance:0`, merged over
 * livekit's defaults). No `setKey`, no `enable`, no `encode`/`decode`.
 *
 * 🔴 Always terminates the probe worker, on every settle path. The patched
 * worker starts a one-second `setInterval` at module scope, so a probe worker
 * left alive would post heartbeats for the life of the app.
 *
 * Cached for the app's life: the first settled result is the answer until the
 * app restarts. While a probe is in flight, every caller gets the same promise
 * (one worker, one timer). A "fail" is not retried; the honest copy is "not
 * available on this device", never plaintext.
 */

/** What the capability predicate reads. "pending" = not settled = not ready. */
export type WorkerProbeResult = "pending" | "pass" | "fail";

/** How long the worker has to reply with both `initAck` and a heartbeat. */
export const WORKER_PROBE_TIMEOUT_MS = 5_000;

/** livekit's init request kind (`E2EEManager.setup`). */
export const WORKER_INIT_KIND = "init";

/** livekit's reply to `init` (the worker's `case 'init'`). */
export const WORKER_INIT_ACK_KIND = "initAck";

/** livekit's worker error reply kind. Seen during a probe, it fails it. */
export const WORKER_ERROR_KIND = "error";

/**
 * The patched worker's heartbeat kind. It must match the worker's
 * `postMessage({ kind: 'slogaDecodeWitness', ... })` exactly, and
 * `DECODE_WITNESS_KIND` in `decodeWitnessListener.ts`. Declared here rather
 * than imported so this module stays dependency-free.
 */
export const WORKER_HEARTBEAT_KIND = "slogaDecodeWitness";

/**
 * The init's `loglevel`. livekit sends `workerLogger.getLevel()` (a loglevel
 * number), and the worker passes it straight to `setLevel`, which THROWS on
 * anything that is not a level, before the ack is posted. 3 = WARN, so the
 * probe worker's "worker initialized" info line stays quiet.
 */
export const WORKER_PROBE_LOGLEVEL = 3;

/**
 * Sloga's key-provider options as `MlsKeyProvider.getOptions()` returns them:
 * `{ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 }` merged
 * over livekit's `KEY_PROVIDER_DEFAULTS` (`ratchetSalt`, `keyringSize`).
 */
export const WORKER_PROBE_KEY_PROVIDER_OPTIONS = Object.freeze({
  sharedKey: false,
  ratchetSalt: "LKFrameEncryptionKey",
  ratchetWindowSize: 0,
  failureTolerance: 0,
  keyringSize: 16,
});

/** The subset of `Worker` the probe uses. */
export interface ProbeWorker {
  postMessage(m: unknown): void;
  addEventListener(
    t: "message" | "error",
    f: (ev: { data?: unknown }) => void,
  ): void;
  terminate(): void;
}

export interface WorkerProbeDeps<H> {
  /** Constructs the SHIPPED e2ee worker. It may throw. */
  makeWorker: () => ProbeWorker;
  setTimeout: (callback: () => void, ms: number) => H;
  clearTimeout: (handle: H) => void;
  /** Defaults to {@link WORKER_PROBE_TIMEOUT_MS}. Must be finite and > 0. */
  timeoutMs?: number;
}

let settled: "pass" | "fail" | undefined;
let inFlight: Promise<"pass" | "fail"> | undefined;
/**
 * Bumped by {@link resetWorkerProbeForTest}. A probe from an earlier
 * generation that settles late must not write the newer generation's cache.
 */
let generation = 0;

/** The cached result. "pending" until a probe has settled. */
export function workerProbeResult(): WorkerProbeResult {
  return settled ?? "pending";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Run the probe, or join the one in flight, or return the cached result.
 * Never rejects.
 */
export function runWorkerProbe<H>(
  deps: WorkerProbeDeps<H>,
): Promise<"pass" | "fail"> {
  if (settled !== undefined) return Promise.resolve(settled);
  if (inFlight !== undefined) return inFlight;

  const mine = generation;
  const promise = new Promise<"pass" | "fail">((resolve) => {
    let done = false;
    let worker: ProbeWorker | undefined;
    let timer: { handle: H } | undefined;
    let acked = false;
    let transformable = false;

    const finish = (result: "pass" | "fail"): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) {
        try {
          deps.clearTimeout(timer.handle);
        } catch {
          // The timer callback checks `done`, so a failed clear is harmless.
        }
      }
      if (worker !== undefined) {
        try {
          worker.terminate();
        } catch {
          // Nothing else to do; the result stands.
        }
      }
      if (mine === generation) {
        settled = result;
        inFlight = undefined;
      }
      resolve(result);
    };

    const onMessage = (ev: { data?: unknown }): void => {
      if (done) return;
      const message = isRecord(ev) ? ev.data : undefined;
      if (!isRecord(message)) return;
      switch (message.kind) {
        case WORKER_INIT_ACK_KIND:
          acked = true;
          break;
        case WORKER_HEARTBEAT_KIND: {
          const body = message.data;
          if (!isRecord(body) || body.rte !== "function") {
            finish("fail");
            return;
          }
          transformable = true;
          break;
        }
        case WORKER_ERROR_KIND:
          finish("fail");
          return;
        default:
          return;
      }
      if (acked && transformable) finish("pass");
    };

    const timeoutMs = deps.timeoutMs ?? WORKER_PROBE_TIMEOUT_MS;
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
      finish("fail");
      return;
    }

    try {
      worker = deps.makeWorker();
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", () => finish("fail"));
      timer = { handle: deps.setTimeout(() => finish("fail"), timeoutMs) };
      worker.postMessage({
        kind: WORKER_INIT_KIND,
        data: {
          keyProviderOptions: { ...WORKER_PROBE_KEY_PROVIDER_OPTIONS },
          loglevel: WORKER_PROBE_LOGLEVEL,
        },
      });
    } catch {
      finish("fail");
    }
  });

  // A probe that settled inside the executor (a `makeWorker` throw, a bad
  // timeout) has already written `settled`; do not leave a stale in-flight.
  if (settled === undefined && mine === generation) inFlight = promise;
  return promise;
}

/** Specs only: forget the cached result and any in-flight probe. */
export function resetWorkerProbeForTest(): void {
  generation += 1;
  settled = undefined;
  inFlight = undefined;
}
