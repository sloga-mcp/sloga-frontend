/**
 * The camera background processor as LiveKit sees it: a `TrackProcessor` that
 * delegates to the real processor but whose `init` and `restart` NEVER reject
 * and never hang, and which has something other than the camera picture to
 * offer as `processedTrack` when the real processor cannot run.
 *
 * Why. LiveKit reads `processedTrack` and silently uses the raw camera track
 * when it is undefined (the `mediaStreamTrack` getter, `setProcessor`, and
 * the restart on unmute all do), and an `init` rejection inside
 * `createLocalTracks` leaves the capture open and can re-acquire the camera.
 * Both end with an unprocessed picture on the sender. A background is a
 * privacy control, so when the segmenter cannot start (rejects, produces no
 * live output, or takes longer than the timeout) this guard records `failed`
 * and exposes a black-frame track instead; the controller reads `failed` and
 * reports a background failure.
 *
 * Extracted from `cameraEffects.ts` so `node --test` can load it (the house
 * no-vitest split): the real processor, the black source and the timers are
 * all injected, and livekit is imported for types only.
 *
 * Residual: where the black source cannot be created `processedTrack` is
 * undefined after a failure. `failed` is still set, so the controller still
 * reports the failure and the caller still turns the camera off.
 */
import type {
  ProcessorOptions,
  Room,
  Track,
  TrackProcessor,
} from "livekit-client";

/** How long one init or restart of the real processor may take. */
export const CAMERA_PROCESSOR_START_TIMEOUT_MS = 12_000;

type StartOptions = ProcessorOptions<Track.Kind.Video>;

/** What the guard needs from the processor it wraps. */
export interface GuardedProcessor {
  name: string;
  processedTrack?: MediaStreamTrack;
  init(opts: StartOptions): Promise<void>;
  restart(opts: StartOptions): Promise<void>;
  destroy(): Promise<void>;
  onPublish?: (room: Room) => Promise<void>;
  onUnpublish?: () => Promise<void>;
}

/** A live video track that only ever shows black, and how to end it. */
export interface BlackFrameSource {
  track: MediaStreamTrack;
  stop(): void;
}

export interface CameraProcessorGuardDeps<I extends GuardedProcessor> {
  /**
   * Builds the real processor. Called lazily on the first start, inside the
   * guard, so a build failure takes the same black-frame path as an init
   * failure.
   */
  build: () => I;
  /** Returns undefined where a black track cannot be produced. */
  createBlackSource: () => BlackFrameSource | undefined;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Defaults to {@link CAMERA_PROCESSOR_START_TIMEOUT_MS}. */
  timeoutMs?: number;
}

type StartOutcome = { ok: true } | { ok: false; error: unknown };

export class CameraProcessorGuard<
  I extends GuardedProcessor,
> implements TrackProcessor<Track.Kind.Video> {
  /** The real processor, once it could be built. Tunes go through it. */
  inner: I | undefined;
  /** The real processor is not running; `processedTrack` is the black track. */
  failed = false;
  /** Why, while `failed`. */
  error: unknown;
  /** The RAW camera track last handed over by LiveKit. */
  source: MediaStreamTrack | undefined;

  #deps: CameraProcessorGuardDeps<I>;
  #black: BlackFrameSource | undefined;
  #started = false;
  /**
   * The one retry a failure is allowed has been spent. Cleared by a successful
   * start, so each new failure gets one retry of its own.
   */
  #retried = false;
  /** Bumped by every start, timeout and destroy: a start can tell it was overtaken. */
  #run = 0;
  /** Bumped by every start only: a late start can tell whether a newer one owns `inner`. */
  #starts = 0;

  constructor(deps: CameraProcessorGuardDeps<I>) {
    this.#deps = deps;
  }

  get name(): string {
    return this.inner?.name ?? "background-processor";
  }

  /**
   * The real output while running, the black track while failed. After a
   * completed init this is never the camera picture and, as long as a black
   * source can be created, never undefined.
   */
  get processedTrack(): MediaStreamTrack | undefined {
    if (this.failed) return this.#black?.track;
    return this.inner?.processedTrack ?? this.#black?.track;
  }

  /**
   * Never rejects. A second call (LiveKit re-running `createLocalTracks`)
   * restarts the real processor instead of initializing it twice.
   */
  async init(opts: StartOptions): Promise<void> {
    await this.#start(opts);
  }

  /**
   * LiveKit calls this on unmute and on a device switch. Never rejects. After
   * a failure the real start is retried ONCE (the assets may have been
   * unreachable only briefly); after that the black track stays until the
   * processor is removed.
   */
  async restart(opts: StartOptions): Promise<void> {
    if (this.failed) {
      if (this.#retried) {
        this.source = opts.track;
        this.#ensureBlack();
        return;
      }
      this.#retried = true;
    }
    await this.#start(opts);
  }

  async #start(opts: StartOptions): Promise<void> {
    const run = ++this.#run;
    const startNo = ++this.#starts;
    this.source = opts.track;

    let inner: I;
    let work: Promise<StartOutcome>;
    try {
      inner = this.inner ??= this.#deps.build();
      // The real processor's own restart is destroy + init, and its destroy
      // is a no-op for an init that never completed, so restart is safe after
      // a failure as well as after a successful run.
      const pending = this.#started ? inner.restart(opts) : inner.init(opts);
      this.#started = true;
      work = pending.then(
        (): StartOutcome => ({ ok: true }),
        (error: unknown): StartOutcome => ({ ok: false, error }),
      );
    } catch (error) {
      this.#fail(error);
      return;
    }

    let timer: unknown;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = this.#deps.setTimeout(
        () => resolve("timeout"),
        this.#deps.timeoutMs ?? CAMERA_PROCESSOR_START_TIMEOUT_MS,
      );
    });
    const outcome = await Promise.race([work, timedOut]);
    this.#deps.clearTimeout(timer);

    if (outcome === "timeout") {
      // A start that never settles must not hold the camera publish (or the
      // unmute) forever. Give up on it: black now, and bump the run token so
      // the real processor, if it does come up later, is freed, not adopted.
      if (run === this.#run) {
        this.#run++;
        this.#fail(new Error("camera processor start timed out"));
      }
      void work.then((late) => this.#freeIfUnowned(inner, startNo, late));
      return;
    }

    if (run !== this.#run) {
      // destroy() ran while the real processor was starting. Its own teardown
      // was a no-op then, so free what this start built.
      await this.#freeIfUnowned(inner, startNo, outcome);
      return;
    }

    if (!outcome.ok) {
      this.#fail(outcome.error);
      return;
    }
    if (inner.processedTrack?.readyState !== "live") {
      this.#fail(new Error("camera processor produced no live output track"));
      return;
    }
    this.failed = false;
    this.error = undefined;
    this.#retried = false;
    this.#black?.stop();
    this.#black = undefined;
  }

  /**
   * Destroy what an overtaken start built, unless a newer start has taken
   * `inner` over (that start's restart tears the old pipeline down itself,
   * and destroying here would kill the new one).
   */
  async #freeIfUnowned(inner: I, startNo: number, outcome: StartOutcome) {
    if (!outcome.ok || startNo !== this.#starts) return;
    await inner.destroy().catch(() => {});
  }

  #fail(error: unknown) {
    this.failed = true;
    this.error = error;
    this.#ensureBlack();
  }

  #ensureBlack() {
    if (this.#black?.track.readyState === "live") return;
    this.#black?.stop();
    this.#black = this.#deps.createBlackSource();
  }

  /**
   * Stops the black source and destroys the real processor. Safe mid-start:
   * the start in flight sees the bumped run token and frees what it built.
   * The stopped black track stays readable so `processedTrack` does not fall
   * back to undefined on a guard LiveKit still holds.
   */
  async destroy(): Promise<void> {
    this.#run++;
    this.#black?.stop();
    await this.inner?.destroy().catch(() => {});
  }

  // LiveKit calls onPublish when a track carrying a processor is published
  // (and on every processor update). The background wrapper defines neither
  // hook today; they are forwarded so a library update cannot lose them here.
  async onPublish(room: Room): Promise<void> {
    await this.inner?.onPublish?.(room);
  }

  async onUnpublish(): Promise<void> {
    await this.inner?.onUnpublish?.();
  }
}
