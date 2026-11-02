import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from "livekit-client";

import { CONFIGURATION } from "@revolt/common";

import {
  VOICE_PITCH_DEFAULT,
  clampVoicePitch,
  voicePitchIsActive,
} from "./voicePitch";
import {
  VOICE_TONE_PRESET_DEFAULT,
  VoiceTonePresetId,
  connectChain,
  createToneStage,
  voiceTonePreset,
} from "./voiceTonePresets";

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

/** Contexts that already have the pitch worklet module registered. */
const pitchWorkletLoaded = new WeakSet<AudioContext>();

/** Self-hosted like the RNNoise assets, for the same CSP / no-CDN reasons. */
async function loadPitchWorklet(ctx: AudioContext): Promise<void> {
  if (pitchWorkletLoaded.has(ctx)) return;
  await ctx.audioWorklet.addModule(
    new URL(
      `${import.meta.env.BASE_URL}voice-pitch/VoicePitchWorklet.js`,
      window.location.origin,
    ).href,
  );
  pitchWorkletLoaded.add(ctx);
}

/**
 * The one processor allowed in the mic track's single LiveKit processor slot:
 * capture → [DenoiserWorklet (RNNoise)] → [voice changer pitch] →
 * [voice shaper] → GainNode → destination. Every stage is live-tunable
 * mid-call (`setDenoiseEnabled` / `setPitch` / `setTonePreset` / `setGain`)
 * so settings changes apply without
 * republishing, and none of them steals the slot from the others (the old
 * separate Denoise/Gain processors were mutually exclusive, and a third
 * processor for the shaper would have made it three ways exclusive).
 *
 * The worklet stage is created lazily on first enable and taken out of the
 * graph entirely when disabled (an unconnected worklet node isn't rendered),
 * so a gain-only pipeline pays no denoise latency. The vendored worklet
 * resamples context-rate ↔ 48 kHz internally (see public/rnnoise/PROVENANCE).
 *
 * The pitch stage (`voicePitch.ts`) works like the worklet stage: created
 * on first use and wired past at 0 semitones. If its worklet fails to load,
 * the other stages keep running without it.
 *
 * The shaper stage is exactly one preset's node chain (`voiceTonePresets.ts`);
 * `off` contributes no nodes at all. Switching presets tears the old chain
 * out before the new one goes in, so two presets can never run at once.
 */
export class VoiceAudioPipeline implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  name = "voice-audio-pipeline";
  processedTrack?: MediaStreamTrack;

  #denoise: boolean;
  #gainPercent: number;
  #tonePreset: VoiceTonePresetId;
  #pitchSemitones: number;

  #ctx: AudioContext | undefined;
  #source: MediaStreamAudioSourceNode | undefined;
  #denoiseNode: AudioWorkletNode | undefined;
  #pitchNode: AudioWorkletNode | undefined;
  #toneNodes: AudioNode[] = [];
  #gainNode: GainNode | undefined;
  #dest: MediaStreamAudioDestinationNode | undefined;

  /** Serializes graph mutations: livekit's init/restart (device switch) can
   *  race our own mid-call toggles; interleaving them corrupts the graph. */
  #chain: Promise<void> = Promise.resolve();

  constructor(opts: {
    denoise: boolean;
    gainPercent: number;
    tonePreset?: VoiceTonePresetId;
    pitchSemitones?: number;
  }) {
    this.#denoise = opts.denoise;
    this.#gainPercent = opts.gainPercent;
    this.#tonePreset = opts.tonePreset ?? VOICE_TONE_PRESET_DEFAULT;
    this.#pitchSemitones = clampVoicePitch(
      opts.pitchSemitones ?? VOICE_PITCH_DEFAULT,
    );
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

  /**
   * Live-switch the voice shaper. The previous preset's nodes are dropped
   * from the graph before the new ones are built, so there is never more
   * than one shaper in the chain. A no-op when the preset is unchanged.
   */
  setTonePreset(preset: VoiceTonePresetId): Promise<void> {
    return this.#enqueue(() => {
      if (preset === this.#tonePreset) return;
      this.#tonePreset = preset;
      if (!this.#ctx) return;
      this.#rebuildToneStage();
      this.#rewire();
    });
  }

  /**
   * Live-set the voice changer pitch, in semitones (0 = off). The first
   * non-zero value on a call loads the worklet. If that fails it warns and
   * rejects, with pitch not applied and audio flowing; the wanted value is
   * kept, so the next settings change or a rebuild (device switch) retries.
   * Once the stage is in the graph, moving the slider only updates its
   * parameter.
   */
  setPitch(semitones: number): Promise<void> {
    return this.#enqueue(async () => {
      const wasWired = this.#pitchStageWired();
      this.#pitchSemitones = clampVoicePitch(semitones);
      // Not built (before init, or after a failed build / destroy): the
      // value is picked up by the next #build. Never grow a graph LiveKit
      // has not adopted.
      if (!this.#source) return;
      if (voicePitchIsActive(this.#pitchSemitones)) {
        await this.#ensurePitchNodeOrWarn();
        this.#applyPitchParam();
      }
      if (wasWired !== this.#pitchStageWired()) this.#rewire();
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

  get tonePreset(): VoiceTonePresetId {
    return this.#tonePreset;
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
    try {
      if (this.#denoise) {
        await this.#ensureDenoiseNode();
      }
    } catch (error) {
      // A rejected build is never adopted by LiveKit and nothing else will
      // destroy it: drop the half-built graph so a queued tune (setPitch
      // guards on #source) cannot wire a live mic into it.
      this.#teardown();
      throw error;
    }
    if (voicePitchIsActive(this.#pitchSemitones)) {
      // Unlike denoise, a pitch load failure must not fail the whole attach:
      // the noise filter, shaper and gain still apply without it.
      try {
        await this.#ensurePitchNodeOrWarn();
        this.#applyPitchParam();
      } catch {
        // Warned; pitch stays unwired until a later retry.
      }
    }
    this.#rebuildToneStage();
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

  /** Create the pitch worklet node once per build. A failure is logged —
   *  the settings row still shows the chosen pitch, so the console is where
   *  "why is my voice normal?" gets answered — and rethrown. */
  async #ensurePitchNodeOrWarn() {
    const ctx = this.#ctx;
    if (this.#pitchNode || !ctx || !this.#source) return;
    try {
      await loadPitchWorklet(ctx);
      // Defensive: the graph this node is for must still be the current one.
      if (this.#ctx !== ctx || !this.#source) return;
      this.#pitchNode = new AudioWorkletNode(ctx, "VoicePitchShift", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: "explicit",
        outputChannelCount: [1],
      });
    } catch (error) {
      console.warn("[voice changer] pitch worklet unavailable:", error);
      throw error;
    }
  }

  /** Push `#pitchSemitones` to the worklet with a short glide, so dragging
   *  the slider sweeps rather than steps. */
  #applyPitchParam() {
    const param = this.#pitchNode?.parameters.get("semitones");
    if (!param || !this.#ctx) return;
    param.setTargetAtTime(this.#pitchSemitones, this.#ctx.currentTime, 0.03);
  }

  #pitchStageWired(): boolean {
    return !!this.#pitchNode && voicePitchIsActive(this.#pitchSemitones);
  }

  /** Drop the current shaper nodes and build the ones for `#tonePreset`.
   *  Leaves them unconnected — `#rewire` threads the whole graph. */
  #rebuildToneStage() {
    for (const node of this.#toneNodes) node.disconnect();
    this.#toneNodes = this.#ctx
      ? createToneStage(this.#ctx, voiceTonePreset(this.#tonePreset))
      : [];
  }

  #rewire() {
    if (!this.#source || !this.#gainNode || !this.#dest) return;
    this.#source.disconnect();
    this.#denoiseNode?.disconnect();
    this.#pitchNode?.disconnect();
    for (const node of this.#toneNodes) node.disconnect();
    this.#gainNode.disconnect();
    let head: AudioNode = this.#source;
    if (this.#denoise && this.#denoiseNode) {
      head.connect(this.#denoiseNode);
      head = this.#denoiseNode;
    }
    if (this.#pitchNode && this.#pitchStageWired()) {
      head.connect(this.#pitchNode);
      head = this.#pitchNode;
    }
    connectChain(head, this.#toneNodes, this.#gainNode);
    this.#gainNode.connect(this.#dest);
  }

  #teardown() {
    // The worklet frees its wasm state on DESTROY and is single-use after —
    // a rebuild creates a fresh node.
    this.#denoiseNode?.port.postMessage({ message: "DESTROY" });
    this.#denoiseNode?.port.close();
    this.#denoiseNode?.disconnect();
    // "stop" lets the pitch worklet return false from `process` and be
    // collected; a rebuild creates a fresh node.
    this.#pitchNode?.port.postMessage("stop");
    this.#pitchNode?.port.close();
    this.#pitchNode?.disconnect();
    this.#source?.disconnect();
    for (const node of this.#toneNodes) node.disconnect();
    this.#gainNode?.disconnect();
    this.#denoiseNode = undefined;
    this.#pitchNode = undefined;
    this.#source = undefined;
    this.#toneNodes = [];
    this.#gainNode = undefined;
    this.#dest = undefined;
    this.processedTrack = undefined;
  }
}
