/**
 * The worker that hosts Whisper. Everything expensive happens here.
 *
 * ## Why inference must not run on the main thread
 *
 * ONNX Runtime here is SINGLE-THREADED wasm (no COOP/COEP → no
 * SharedArrayBuffer), and every decode step is a synchronous wasm call. On a
 * machine slower than realtime, running that in the page blocks the UI for
 * seconds per utterance, back to back — reported from the field on 2026-08-10
 * as "the app freezes, then crashes and reopens" (the webview renderer dying
 * under sustained saturation). The dev boxes this shipped from run
 * whisper-tiny faster than realtime, so no solo test ever showed it. A worker
 * turns "machine too slow" into "transcript lags", which is the correct
 * failure, and a worker crash takes the transcription instead of the app.
 *
 * ## Everything is same-origin, deliberately
 *
 * transformers.js fetches models from huggingface.co by default, and
 * onnxruntime-web separately fetches its own `.wasm` runtime from a jsDelivr
 * CDN. Both are third-party requests made while a private call is in progress,
 * and the second one is also blocked outright by the desktop shell's CSP (see
 * `voiceAudioPipeline.ts`). Both are pointed at our own origin below, and a
 * transcription session should make no cross-origin request at all — that is a
 * verifiable property, and it is meant to be verified. Relative URLs resolve
 * against this worker's own script origin, so the paths mean the same thing
 * they meant on the main thread.
 *
 * ## The version pin is load-bearing — do not casually bump it
 *
 * Verified working end to end in Chrome 2026-07-31: model fetched from our own
 * origin, session created, live speech transcribed and attributed, on
 * `@huggingface/transformers` 3.8.1 with onnxruntime-web 1.22.
 *
 * **4.x does not work here.** With 4.2.0 (onnxruntime-web 1.26.0-dev) session
 * creation dies in an ORT graph-optimisation pass — `qdq_actions.cc:137
 * TransposeDQWeightsForMatMulNBits Missing required scale`. That was
 * reproduced across q8, int8, uint8 AND unquantised fp32 weights, and with the
 * optimiser disabled, basic, and on the WebGPU provider: nine combinations,
 * one identical error. The same files load fine under onnxruntime-node, so it
 * is the web runtime rather than the model.
 *
 * **Two traps cost hours here, and will again.**
 *
 * 1. Vite pre-bundles dependencies. After changing the transformers version,
 *    the page keeps being served the OLD pre-bundle until vite re-optimises on
 *    the next server start — so 3.8.1 appeared to fail with a spurious `both
 *    async and sync fetching of the wasm failed` while the page was in fact
 *    still running 4.2.0. **Restart the dev server after touching this
 *    dependency, and confirm "Re-optimizing dependencies" in its output.**
 * 2. The vendored ORT runtime under {@link ORT_WASM_BASE} must come from the
 *    EXACT version resolved here. The pnpm store keeps old copies, so a bare
 *    `find` for an onnxruntime-web dist happily returns the wrong one.
 */

import { env, pipeline } from "@huggingface/transformers";

import { purgeHtmlFromModelCache } from "./modelCache.ts";
import { cleanTranscript } from "./transcriptText.ts";
import type {
  TranscriptionWorkerRequest,
  TranscriptionWorkerResponse,
  WhisperModel,
} from "./transcriptionWorkerProtocol.ts";

/** Where the vendored model and the ONNX runtime are served from, same-origin. */
const MODEL_BASE = "/models/";
const ORT_WASM_BASE = "/models/ort/";

type Pipeline = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text: string }>;

let asr: Pipeline | undefined;
let loading: Promise<void> | undefined;
/** Serialises inference: one model instance cannot run two jobs at once. */
let queue: Promise<unknown> = Promise.resolve();

function post(message: TranscriptionWorkerResponse): void {
  self.postMessage(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function load(model: WhisperModel): Promise<void> {
  // Same-origin, both of them. See the header.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODEL_BASE;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = ORT_WASM_BASE;
    // No cross-origin isolation here (COOP/COEP would break cross-origin
    // media), so SharedArrayBuffer is unavailable and threads cannot be
    // used. Say so explicitly rather than relying on a silent fallback.
    env.backends.onnx.wasm.numThreads = 1;
  }

  // A browser that once got the app's HTML page back for a model file keeps
  // it in transformers.js's cache and would fail on it forever. Drop such
  // entries first; `modelCache.ts` has the history.
  await purgeHtmlFromModelCache(
    typeof caches === "undefined" ? undefined : caches,
    MODEL_BASE,
  );

  const total = { bytes: 0, loaded: 0 };
  asr = (await pipeline("automatic-speech-recognition", model, {
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
    progress_callback: (report: {
      status: string;
      loaded?: number;
      total?: number;
    }) => {
      if (report.status !== "progress") return;
      total.loaded = report.loaded ?? 0;
      total.bytes = report.total ?? 0;
      if (total.bytes > 0) {
        post({ type: "load-progress", fraction: total.loaded / total.bytes });
      }
    },
  })) as unknown as Pipeline;
}

async function transcribe(
  job: Extract<TranscriptionWorkerRequest, { type: "transcribe" }>,
): Promise<string | undefined> {
  if (!asr) throw new Error("The transcription model is not loaded.");

  const result = await asr(job.pcm, {
    task: "transcribe",
    // Undefined lets the model detect; a hint is faster and more accurate.
    language: job.language || undefined,
  });

  // The model never says "I heard nothing" — it invents a plausible short
  // phrase instead. `transcriptText.ts` explains why this check exists here
  // rather than as a confidence threshold.
  return cleanTranscript(result.text ?? "", job.spokenMs);
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data as TranscriptionWorkerRequest;

  switch (message.type) {
    case "load":
      // Concurrent callers share one load rather than racing two downloads,
      // and a failed load is not cached, or the feature is dead until the
      // client builds a fresh worker (which it does — belt and braces).
      loading ??= load(message.model).catch((error) => {
        loading = undefined;
        throw error;
      });
      loading.then(
        () => post({ type: "load-done" }),
        (error) => post({ type: "load-error", message: describe(error) }),
      );
      break;

    case "transcribe": {
      const { id } = message;
      // Keep the chain alive through failures: one bad utterance must not
      // stop the rest of the call from being transcribed.
      queue = queue.then(
        () =>
          transcribe(message).then(
            (text) => post({ type: "transcribe-done", id, text }),
            (error) =>
              post({ type: "transcribe-error", id, message: describe(error) }),
          ),
        () => undefined,
      );
      break;
    }
  }
};
