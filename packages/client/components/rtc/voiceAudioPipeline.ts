import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from "livekit-client";

import { CONFIGURATION } from "@revolt/common";

/**
 * Base URL the RNNoise worklet assets are served from. Self-hosted worklet
 * assets (public/rnnoise/) — never a CDN: external script origins are blocked
 * by the desktop shell CSP (slice 6.2b) and violate the no-CDN policy
 * everywhere else. Must be absolute — AudioWorklet.addModule resolves against
 * the document, but the URL is also fetched from within LiveKit's audio
 * context with no base of its own.
 */
function rnnoiseAssetBase(): string {
  return new URL(
    CONFIGURATION.RNNOISE_WORKLET_CDN_URL ||
      `${import.meta.env.BASE_URL}rnnoise/`,
    window.location.origin,
  ).href;
}

/** AudioContexts that already have the DenoiserWorklet module registered —
 *  addModule with a name that's already registered throws. */
const workletLoaded = new WeakSet<AudioContext>();

/** One fetch of the wasm binary per page load; reset on failure so a
 *  transient error (e.g. offline at join) can retry on the next enable. */
let wasmBinary: Promise<ArrayBuffer> | undefined;

async function loadDenoiseAssets(ctx: AudioContext): Promise<ArrayBuffer> {
  const base = rnnoiseAssetBase();
  if (!workletLoaded.has(ctx)) {
    await ctx.audioWorklet.addModule(new URL("DenoiserWorklet.js", base).href);
    workletLoaded.add(ctx);
  }
  if (!wasmBinary) {
    wasmBinary = fetch(new URL("rnnoise.wasm", base).href).then(
      async (resp) => {
        if (!resp.ok) throw new Error(`rnnoise.wasm fetch: ${resp.status}`);
        return resp.arrayBuffer();
      },
    );
    wasmBinary.catch(() => (wasmBinary = undefined));
  }
  return wasmBinary;
}

/**
 * The one processor allowed in the mic track's single LiveKit processor slot:
 * capture → [DenoiserWorklet (RNNoise)] → GainNode → destination. Both stages
 * are live-tunable mid-call (`setDenoiseEnabled` / `setGain`) so settings
 * changes apply without republishing, and neither steals the slot from the
 * other (the old separate Denoise/Gain processors were mutually exclusive).
 *
 * The worklet stage is created lazily on first enable and taken out of the
 * graph entirely when disabled (an unconnected worklet node isn't rendered),
 * so a gain-only pipeline pays no denoise latency. The vendored worklet
 * resamples context-rate ↔ 48 kHz internally (see public/rnnoise/PROVENANCE).
 */
export class VoiceAudioPipeline implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  name = "voice-audio-pipeline";
  processedTrack?: MediaStreamTrack;

  #denoise: boolean;
  #gainPercent: number;

  #ctx: AudioContext | undefined;
  #source: MediaStreamAudioSourceNode | undefined;
  #denoiseNode: AudioWorkletNode | undefined;
  #gainNode: GainNode | undefined;
  #dest: MediaStreamAudioDestinationNode | undefined;

  /** Serializes graph mutations: livekit's init/restart (device switch) can
   *  race our own mid-call toggles; interleaving them corrupts the graph. */
  #chain: Promise<void> = Promise.resolve();

  constructor(opts: { denoise: boolean; gainPercent: number }) {
    this.#denoise = opts.denoise;
    this.#gainPercent = opts.gainPercent;
  }

  #enqueue<T>(op: () => Promise<T> | T): Promise<T> {
    const run = this.#chain.then(op);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async init(opts: AudioProcessorOptions) {
    await this.#enqueue(() => this.#build(opts));
  }

  /** livekit calls this with the NEW capture track on device switch /
   *  unmute-restart, then re-reads processedTrack — full rebuild is safe. */
  async restart(opts: AudioProcessorOptions) {
    await this.#enqueue(() =>
      this.#build({ ...opts, audioContext: opts.audioContext ?? this.#ctx! }),
    );
  }

  async destroy() {
    await this.#enqueue(() => this.#teardown());
  }

  /**
   * Live-enable/disable the RNNoise stage. First enable on a call loads the
   * worklet + wasm; rejects (leaving denoise off, audio flowing) if the
   * assets fail — callers decide the fallback.
   */
  setDenoiseEnabled(enable: boolean): Promise<void> {
    return this.#enqueue(async () => {
      if (enable) await this.#ensureDenoiseNode();
      this.#denoise = enable;
      this.#rewire();
    });
  }

  /** Live-update input gain (percent, 100 = unity), with a short ramp to
   *  avoid zipper noise while the settings slider drags. */
  setGain(gainPercent: number) {
    this.#gainPercent = gainPercent;
    if (this.#gainNode && this.#ctx) {
      this.#gainNode.gain.setTargetAtTime(
        gainPercent / 100,
        this.#ctx.currentTime,
        0.02,
      );
    }
  }

  get denoiseEnabled(): boolean {
    return this.#denoise && !!this.#denoiseNode;
  }

  async #build(opts: AudioProcessorOptions) {
    if (!opts.audioContext || !opts.track) {
      throw new Error("audioContext and track are required");
    }
    this.#teardown();
    const ctx = opts.audioContext;
    this.#ctx = ctx;
    this.#source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.#gainNode = ctx.createGain();
    this.#gainNode.gain.value = this.#gainPercent / 100;
    this.#dest = ctx.createMediaStreamDestination();
    if (this.#denoise) {
      await this.#ensureDenoiseNode();
    }
    this.#rewire();
    this.processedTrack = this.#dest.stream.getAudioTracks()[0];
  }

  async #ensureDenoiseNode() {
    if (this.#denoiseNode || !this.#ctx) return;
    const rnnoiseBuffer = await loadDenoiseAssets(this.#ctx);
    // structured-clone (not transfer) of the cached buffer — reusable.
    this.#denoiseNode = new AudioWorkletNode(this.#ctx, "DenoiserWorklet", {
      processorOptions: { rnnoiseBuffer },
      numberOfInputs: 1,
      numberOfOutputs: 1,
    });
  }

  #rewire() {
    if (!this.#source || !this.#gainNode || !this.#dest) return;
    this.#source.disconnect();
    this.#denoiseNode?.disconnect();
    this.#gainNode.disconnect();
    let head: AudioNode = this.#source;
    if (this.#denoise && this.#denoiseNode) {
      head.connect(this.#denoiseNode);
      head = this.#denoiseNode;
    }
    head.connect(this.#gainNode);
    this.#gainNode.connect(this.#dest);
  }

  #teardown() {
    // The worklet frees its wasm state on DESTROY and is single-use after —
    // a rebuild creates a fresh node.
    this.#denoiseNode?.port.postMessage({ message: "DESTROY" });
    this.#denoiseNode?.port.close();
    this.#denoiseNode?.disconnect();
    this.#source?.disconnect();
    this.#gainNode?.disconnect();
    this.#denoiseNode = undefined;
    this.#source = undefined;
    this.#gainNode = undefined;
    this.#dest = undefined;
    this.processedTrack = undefined;
  }
}
