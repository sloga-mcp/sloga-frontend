/**
 * How long a call rings, as the server advertises it (Slim M2).
 *
 * The node sends its effective ring length, in seconds, in the root config
 * route `GET /`:
 *
 *   { features: { livekit: { call_ring_duration: number } } }
 *
 * (backend `crates/delta/src/routes/root.rs` `VoiceFeature`; the value is
 * already the one the server applies.)
 *
 * Fetched raw through `client.api.get("/")`, as `protectedChannelsFlag.ts`
 * does. **Never read it from `client.configuration`:** the controller
 * pre-assigns a local stub there, so the SDK never fetches `GET /` and the
 * key would be absent for good.
 *
 * `serverCallRingSecs()` is undefined until an answer carries a finite
 * number. Every reader passes it through `ringDurationMs` (`incomingCall.ts`),
 * which owns the 5 to 120 s window and the 45 s fallback, so this module does
 * not range-check. A failed request never throws and never clears a value
 * the server already gave; an answer without a usable value reads as "not
 * advertised" (undefined).
 *
 * Leaf module: imports only `solid-js`, loadable by `node --test`.
 */
import { type Accessor, createSignal } from "solid-js";

/** How long one `GET /` may take before it counts as failed. */
export const ROOT_FETCH_TIMEOUT_MS = 15_000;

/**
 * The part of the SDK API client this module uses. The stoat.js `Client`'s
 * `api` satisfies it (the spec pins that at compile time).
 */
export interface RootConfigApi {
  get(path: "/"): Promise<unknown>;
}

/** A non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `features.livekit.call_ring_duration` from a `GET /` body.
 * @param root The whole root config, as received
 * @returns The advertised seconds when they are a finite number, else
 * undefined
 */
export function parseCallRingSecs(root: unknown): number | undefined {
  if (!isRecord(root)) return undefined;
  const features = root.features;
  if (!isRecord(features)) return undefined;
  const livekit = features.livekit;
  if (!isRecord(livekit)) return undefined;
  const secs = livekit.call_ring_duration;
  return typeof secs === "number" && Number.isFinite(secs) ? secs : undefined;
}

/** What `fetchRoot` answers for an error or a passed deadline. */
const FAILED = Symbol("failed");

/**
 * `GET /`, bounded. Never rejects, and a synchronous throw from `get` counts
 * as a failure too. An answer that arrives after the deadline is dropped.
 * @param api The SDK client's `api`
 * @param timeoutMs How long the request may take
 * @returns The body, or `FAILED`
 */
async function fetchRoot(
  api: RootConfigApi,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof FAILED>((resolve) => {
    timer = setTimeout(() => resolve(FAILED), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => api.get("/"))
        .catch((): typeof FAILED => FAILED),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One store of the advertised ring length and its loader. */
export interface ServerRingLength {
  /** The advertised seconds; undefined until an answer carries them */
  secs: Accessor<number | undefined>;
  /**
   * Fetch `GET /` and store its ring length. Never rejects. Only one
   * request at a time: a call while one is pending returns that one.
   */
  load(api: RootConfigApi): Promise<void>;
}

/**
 * A fresh store. The app uses the module's single instance below; specs
 * build their own.
 * @param timeoutMs How long a request may take before it counts as failed
 * @returns The store
 */
export function createServerRingLength(
  timeoutMs = ROOT_FETCH_TIMEOUT_MS,
): ServerRingLength {
  const [secs, setSecs] = createSignal<number | undefined>(undefined);
  let pending: Promise<void> | undefined;

  function load(api: RootConfigApi): Promise<void> {
    if (pending) return pending;
    const attempt = fetchRoot(api, timeoutMs)
      .then((body) => {
        if (body !== FAILED) setSecs(parseCallRingSecs(body));
      })
      .catch(() => {
        // Never rejects: a failure keeps what is known.
      })
      .finally(() => {
        if (pending === attempt) pending = undefined;
      });
    pending = attempt;
    return attempt;
  }

  return { secs, load };
}

const store = createServerRingLength();

/**
 * The server's advertised ring length in seconds, or undefined until it is
 * known. Reactive. Read it only as `ringDurationMs(serverCallRingSecs())`.
 * @returns The advertised seconds, or undefined
 */
export function serverCallRingSecs(): number | undefined {
  return store.secs();
}

/**
 * Fetch the advertised ring length into `serverCallRingSecs`. Never rejects
 * and never throws; not meant to be awaited by startup.
 * @param api The SDK client's `api`
 * @returns Settles when the attempt is over
 */
export function loadServerCallRingSecs(api: RootConfigApi): Promise<void> {
  return store.load(api);
}
