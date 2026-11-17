/**
 * Camera tone stage: one WebGL2 context that draws a camera frame with the
 * low light lift, the brightness multiply and the whole-frame touch up
 * smoothing applied. Browser-only (no node spec can load it).
 *
 * Per-frame pipeline:
 *   source frame → source texture (unit 0)
 *     → [smooth > 0] pass A: horizontal edge-preserving blur, half resolution
 *     → [smooth > 0] pass B: vertical edge-preserving blur, half resolution
 *     → final pass, full resolution, default framebuffer:
 *         mix(original, smoothed, smooth) → low light → brightness
 *
 * Orientation: the source is uploaded WITHOUT `UNPACK_FLIP_Y_WEBGL`, so every
 * texture in here keeps the image's top row at v = 0. The blur passes and the
 * luma downsample sample with plain framebuffer coordinates, which keeps that
 * layout in the intermediate targets, and the final pass flips v exactly once.
 * The output is upright and never mirrored (u is not touched anywhere).
 *
 * Texture units: 0 = source, 1 = a half-resolution blur target. `draw()` and
 * `sampleLuma()` set every piece of state they depend on (framebuffer,
 * viewport, program, both units) and leave the default framebuffer bound.
 *
 * The neutral config ({ lowLightGain: 1, brightness: 1, smooth: 0 }) skips the
 * blur passes and both shader branches, so the final pass is a plain copy.
 *
 * Consumers copy from `canvas` with `drawImage()` in the same task as
 * `draw()` and capture their OWN 2D canvas. Nothing captures this canvas, so
 * a lost context here can fail open without touching the published track.
 */
import { type ToneConfig, meanLuma } from "./cameraTonePolicy";

/** Edge of the square target `sampleLuma()` reads back. */
const LUMA_SIZE = 16;

/**
 * How many draws after a build, a rebuild or a resize end with a
 * `gl.getError()`. The call waits for the GPU, so it is not made on every
 * frame; a driver that rejects the upload or a pass does so from the start.
 */
const CHECKED_DRAWS = 3;

/** Upper bounds applied in `setConfig`; the policy owns the real ranges. */
const MAX_GAIN = 4;
const MAX_BRIGHTNESS = 4;

/** Fullscreen triangle from `gl_VertexID`; no buffers, no attributes. */
const VERTEX_SOURCE = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * One direction of the separable edge-preserving blur: nine taps, a Gaussian
 * falloff over distance multiplied by a falloff over the luma difference to
 * the center tap, so edges (eyes, hairline, glasses) keep their contrast.
 */
const BLUR_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uStep;
in vec2 vUv;
out vec4 outColor;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float SPATIAL = 0.08;
const float RANGE = 60.0;
void main() {
  vec3 center = texture(uTex, vUv).rgb;
  float centerLuma = dot(center, LUMA);
  vec3 sum = center;
  float total = 1.0;
  for (int i = 1; i <= 4; i++) {
    float fi = float(i);
    float spatial = fi * fi * SPATIAL;
    vec3 a = texture(uTex, vUv + uStep * fi).rgb;
    vec3 b = texture(uTex, vUv - uStep * fi).rgb;
    float da = dot(a, LUMA) - centerLuma;
    float db = dot(b, LUMA) - centerLuma;
    float wa = exp(-(spatial + da * da * RANGE));
    float wb = exp(-(spatial + db * db * RANGE));
    sum += a * wa + b * wb;
    total += wa + wb;
  }
  outColor = vec4(sum / total, 1.0);
}
`;

/**
 * Final pass. Low light works on luma: `1 - (1 - l)^gain` has slope `gain` at
 * black and lands on 1 at white, so shadows get the full gain and highlights
 * roll off instead of clipping. A mild gamma lift scaled by `gain - 1` follows.
 * The color is scaled by the luma ratio, and a channel that would pass 1 is
 * pulled toward gray at the same luma rather than clipped.
 */
const FINAL_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform sampler2D uSmoothed;
uniform float uSmooth;
uniform float uGain;
uniform float uBrightness;
in vec2 vUv;
out vec4 outColor;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float GAMMA_LIFT = 0.15;
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 color = texture(uSource, uv).rgb;
  if (uSmooth > 0.0) {
    color = mix(color, texture(uSmoothed, uv).rgb, uSmooth);
  }
  if (uGain > 1.0) {
    float luma = dot(color, LUMA);
    float lifted = 1.0 - pow(max(1.0 - luma, 0.0), uGain);
    lifted = pow(lifted, 1.0 / (1.0 + GAMMA_LIFT * (uGain - 1.0)));
    vec3 scaled = color * (lifted / max(luma, 0.0001));
    float peak = max(scaled.r, max(scaled.g, scaled.b));
    if (peak > 1.0) {
      scaled = mix(vec3(lifted), scaled, (1.0 - lifted) / (peak - lifted));
    }
    color = scaled;
  }
  outColor = vec4(color * uBrightness, 1.0);
}
`;

/**
 * Downsample for the luma meter: each output pixel averages a 4x4 grid of
 * bilinear taps spread over its cell. That is 64 taps per axis over the whole
 * frame, each blending up to four texels: a regular sparse sample of a camera
 * frame, not a true box average. Enough for a mean; fine detail between taps
 * is not counted.
 */
const LUMA_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uSource;
in vec2 vUv;
out vec4 outColor;
const float CELL = 1.0 / ${LUMA_SIZE}.0;
void main() {
  vec3 sum = vec3(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 offset = (vec2(float(x), float(y)) - 1.5) * 0.25 * CELL;
      sum += texture(uSource, vUv + offset).rgb;
    }
  }
  outColor = vec4(sum / 16.0, 1.0);
}
`;

let supported: boolean | undefined;

/** WebGL2 available (probe on a throwaway canvas; cache the answer; never throws). */
export function toneStageSupported(): boolean {
  if (supported !== undefined) return supported;
  try {
    if (typeof document === "undefined") {
      supported = false;
      return supported;
    }
    const gl = document.createElement("canvas").getContext("webgl2");
    supported = gl !== null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    supported = false;
  }
  return supported;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`Camera tone stage: no shader (${label})`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(
      `Camera tone stage: ${label} shader failed to compile: ${log}`,
    );
  }
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vertex: WebGLShader,
  fragmentSource: string,
  label: string,
): WebGLProgram {
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, label);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(fragment);
    throw new Error(`Camera tone stage: no program (${label})`);
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // The program keeps what it needs; the shader object can go either way.
  gl.detachShader(program, fragment);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    throw new Error(
      `Camera tone stage: ${label} program failed to link: ${log}`,
    );
  }
  return program;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Whether the source has pixels to upload. A video element before its first
 * frame reports 0x0, and uploading it would leave an empty source texture.
 */
function sourceHasPixels(source: TexImageSource): boolean {
  if ("videoWidth" in source) {
    return source.videoWidth > 0 && source.videoHeight > 0;
  }
  if ("displayWidth" in source) {
    return source.displayWidth > 0 && source.displayHeight > 0;
  }
  if ("naturalWidth" in source) {
    return source.naturalWidth > 0 && source.naturalHeight > 0;
  }
  return source.width > 0 && source.height > 0;
}

export class CameraToneStage {
  /**
   * The stage's output. `drawImage(stage.canvas)` is only valid in the SAME
   * task as the `draw()` that produced the frame: the drawing buffer is not
   * preserved and is cleared once the browser presents it. Do not call
   * `captureStream()` on this canvas; the consumer captures its own 2D canvas
   * and copies from this one, so a lost context never needs a sender operation.
   */
  readonly canvas: HTMLCanvasElement;

  onContextLost: (() => void) | undefined;
  onContextRestored: (() => void) | undefined;

  readonly #gl: WebGL2RenderingContext;
  /** Re-acquired on every build: the object from before a loss is stale. */
  #loseContext: WEBGL_lose_context | null = null;
  readonly #lumaPixels = new Uint8Array(LUMA_SIZE * LUMA_SIZE * 4);

  #blurProgram: WebGLProgram | null = null;
  #finalProgram: WebGLProgram | null = null;
  #lumaProgram: WebGLProgram | null = null;

  #blurTex: WebGLUniformLocation | null = null;
  #blurStep: WebGLUniformLocation | null = null;
  #finalSmooth: WebGLUniformLocation | null = null;
  #finalGain: WebGLUniformLocation | null = null;
  #finalBrightness: WebGLUniformLocation | null = null;

  #sourceTexture: WebGLTexture | null = null;
  #blurTextureA: WebGLTexture | null = null;
  #blurTextureB: WebGLTexture | null = null;
  #lumaTexture: WebGLTexture | null = null;
  #blurFramebufferA: WebGLFramebuffer | null = null;
  #blurFramebufferB: WebGLFramebuffer | null = null;
  #lumaFramebuffer: WebGLFramebuffer | null = null;

  #halfWidth = 1;
  #halfHeight = 1;

  #gain = 1;
  #brightness = 1;
  #smooth = 0;

  /** True from a context loss until a `rebuild()` succeeds. */
  #lost = false;
  /** True when a resize left a blur target unusable; `rebuild()` clears it. */
  #needsRebuild = false;
  /** True once the source texture holds a frame from the current context. */
  #hasFrame = false;
  /** Draws left that end with a `gl.getError()`; see CHECKED_DRAWS. */
  #drawsToCheck = 0;
  #destroyed = false;

  /** Throws if WebGL2 is unavailable. */
  constructor() {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("Camera tone stage: WebGL2 is unavailable");
    this.canvas = canvas;
    this.#gl = gl;
    try {
      this.#build();
    } catch (error) {
      this.#release();
      this.#loseContext?.loseContext();
      throw error;
    }
    canvas.addEventListener("webglcontextlost", this.#handleLost);
    canvas.addEventListener("webglcontextrestored", this.#handleRestored);
  }

  /** Resizes the output and the half-resolution blur targets. */
  resize(width: number, height: number): void {
    if (this.#destroyed) return;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const w = Math.floor(width);
    const h = Math.floor(height);
    if (w <= 0 || h <= 0) return;
    const canvas = this.canvas;
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    // While lost there is nothing to resize; `rebuild()` reads the canvas size.
    if (this.#lost || this.#needsRebuild || this.#gl.isContextLost()) return;
    this.#allocateBlurTargets();
    // A failed allocation (out of memory, over the size limit) would make the
    // blur passes render garbage: stop drawing until `rebuild()` succeeds.
    if (
      !this.#isComplete(this.#blurFramebufferA) ||
      !this.#isComplete(this.#blurFramebufferB)
    ) {
      this.#needsRebuild = true;
      this.#hasFrame = false;
    }
    // New targets, new upload size: the next draws are checked again.
    this.#drawsToCheck = CHECKED_DRAWS;
  }

  /** Stores the values the next `draw()` sends as uniforms. */
  setConfig(c: ToneConfig): void {
    this.#gain = Math.min(MAX_GAIN, Math.max(1, finiteOr(c.lowLightGain, 1)));
    this.#brightness = Math.min(
      MAX_BRIGHTNESS,
      Math.max(0, finiteOr(c.brightness, 1)),
    );
    this.#smooth = Math.min(1, Math.max(0, finiteOr(c.smooth, 0)));
  }

  /**
   * Draws one frame. Returns false, with nothing drawn, when the context is
   * lost, when the stage needs a `rebuild()`, or when the source has no pixels
   * yet.
   *
   * Also returns false when one of the first draws after a build, a rebuild
   * or a resize left a GL error behind (an upload or a pass that failed
   * without throwing). The canvas may then hold a black or partial frame, so
   * the caller must not copy it, and every later draw is refused until a
   * `rebuild()` succeeds.
   */
  draw(source: TexImageSource): boolean {
    const gl = this.#gl;
    if (this.#destroyed || this.#lost || this.#needsRebuild) return false;
    if (gl.isContextLost()) return false;
    if (!sourceHasPixels(source)) return false;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#sourceTexture);
    // A throw here (closed frame, tainted source) leaves #hasFrame as it was.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.#hasFrame = true;

    const smooth = this.#smooth;
    if (smooth > 0) {
      gl.useProgram(this.#blurProgram);
      gl.viewport(0, 0, this.#halfWidth, this.#halfHeight);

      // Pass A: source (unit 0) → blur target A, horizontal.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#blurFramebufferA);
      gl.uniform1i(this.#blurTex, 0);
      gl.uniform2f(this.#blurStep, 1 / this.#halfWidth, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Pass B: blur target A (unit 1) → blur target B, vertical.
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.#blurTextureA);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#blurFramebufferB);
      gl.uniform1i(this.#blurTex, 1);
      gl.uniform2f(this.#blurStep, 0, 1 / this.#halfHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Final pass: source (unit 0) + blur target B (unit 1) → the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.#blurTextureB);
    gl.activeTexture(gl.TEXTURE0);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.#finalProgram);
    gl.uniform1f(this.#finalSmooth, smooth);
    gl.uniform1f(this.#finalGain, this.#gain);
    gl.uniform1f(this.#finalBrightness, this.#brightness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (this.#drawsToCheck > 0) {
      this.#drawsToCheck--;
      // Anything in the error queue counts, a leftover from the build
      // included: a stage that cannot be trusted draws nothing.
      if (gl.getError() !== gl.NO_ERROR) {
        this.#needsRebuild = true;
        this.#hasFrame = false;
        return false;
      }
    }
    return true;
  }

  /** Mean luma 0..1 of the LAST drawn source frame, from a 16x16 downsample; undefined if unavailable. */
  sampleLuma(): number | undefined {
    const gl = this.#gl;
    if (this.#destroyed || this.#lost || this.#needsRebuild) return undefined;
    if (!this.#hasFrame || gl.isContextLost()) return undefined;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#lumaFramebuffer);
    gl.viewport(0, 0, LUMA_SIZE, LUMA_SIZE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#sourceTexture);
    gl.useProgram(this.#lumaProgram);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const pixels = this.#lumaPixels;
    gl.readPixels(
      0,
      0,
      LUMA_SIZE,
      LUMA_SIZE,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // A context lost during the read leaves the buffer untouched.
    if (gl.isContextLost()) return undefined;
    return meanLuma(pixels);
  }

  /** Recreate GL resources after a restore. False if it cannot. */
  rebuild(): boolean {
    if (this.#destroyed || this.#gl.isContextLost()) return false;
    // Handles from before a loss are dead; deleting them is a no-op.
    this.#release();
    this.#hasFrame = false;
    try {
      this.#build();
    } catch {
      this.#release();
      this.#lost = true;
      return false;
    }
    this.#lost = false;
    this.#needsRebuild = false;
    return true;
  }

  /** Frees everything, including the context this stage owns. Idempotent. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#hasFrame = false;
    this.canvas.removeEventListener("webglcontextlost", this.#handleLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.#handleRestored,
    );
    this.onContextLost = undefined;
    this.onContextRestored = undefined;
    this.#release();
    // Listeners are already gone and the handlers check #destroyed, so this
    // loss is never reported to the consumer.
    this.#loseContext?.loseContext();
  }

  #handleLost = (event: Event): void => {
    // Without preventDefault the browser never restores the context.
    event.preventDefault();
    if (this.#destroyed) return;
    this.#lost = true;
    this.#hasFrame = false;
    this.onContextLost?.();
  };

  #handleRestored = (): void => {
    if (this.#destroyed) return;
    // Still marked lost: the consumer decides whether to call `rebuild()`.
    this.onContextRestored?.();
  };

  /** Creates every GL object. Throws on failure; the caller releases. */
  #build(): void {
    const gl = this.#gl;

    // First, so a failed build can still release the context it holds.
    this.#loseContext = gl.getExtension("WEBGL_lose_context");

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE, "vertex");
    try {
      this.#blurProgram = linkProgram(gl, vertex, BLUR_SOURCE, "blur");
      this.#finalProgram = linkProgram(gl, vertex, FINAL_SOURCE, "final");
      this.#lumaProgram = linkProgram(gl, vertex, LUMA_SOURCE, "luma");
    } finally {
      gl.deleteShader(vertex);
    }

    this.#blurTex = gl.getUniformLocation(this.#blurProgram, "uTex");
    this.#blurStep = gl.getUniformLocation(this.#blurProgram, "uStep");
    this.#finalSmooth = gl.getUniformLocation(this.#finalProgram, "uSmooth");
    this.#finalGain = gl.getUniformLocation(this.#finalProgram, "uGain");
    this.#finalBrightness = gl.getUniformLocation(
      this.#finalProgram,
      "uBrightness",
    );

    // Sampler bindings that never change: source on unit 0, blur on unit 1.
    gl.useProgram(this.#finalProgram);
    gl.uniform1i(gl.getUniformLocation(this.#finalProgram, "uSource"), 0);
    gl.uniform1i(gl.getUniformLocation(this.#finalProgram, "uSmoothed"), 1);
    gl.useProgram(this.#lumaProgram);
    gl.uniform1i(gl.getUniformLocation(this.#lumaProgram, "uSource"), 0);
    gl.useProgram(null);

    this.#sourceTexture = this.#createTexture();
    this.#blurTextureA = this.#createTexture();
    this.#blurTextureB = this.#createTexture();
    this.#lumaTexture = this.#createTexture();

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.#lumaTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      LUMA_SIZE,
      LUMA_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );

    this.#blurFramebufferA = this.#createFramebuffer(this.#blurTextureA);
    this.#blurFramebufferB = this.#createFramebuffer(this.#blurTextureB);
    this.#lumaFramebuffer = this.#createFramebuffer(this.#lumaTexture);

    this.#allocateBlurTargets();

    this.#assertComplete(this.#blurFramebufferA, "blur A");
    this.#assertComplete(this.#blurFramebufferB, "blur B");
    this.#assertComplete(this.#lumaFramebuffer, "luma");

    this.#drawsToCheck = CHECKED_DRAWS;
  }

  /** Whether the framebuffer can be drawn to. Rebinds the default one. */
  #isComplete(framebuffer: WebGLFramebuffer | null): boolean {
    if (!framebuffer) return false;
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return status === gl.FRAMEBUFFER_COMPLETE;
  }

  #assertComplete(framebuffer: WebGLFramebuffer, label: string): void {
    if (!this.#isComplete(framebuffer)) {
      throw new Error(`Camera tone stage: ${label} framebuffer is incomplete`);
    }
  }

  /**
   * (Re)allocates both half-resolution targets for the current canvas size.
   * Leaves blur target B on unit 1, unit 0 active, default framebuffer bound.
   */
  #allocateBlurTargets(): void {
    const gl = this.#gl;
    const halfWidth = Math.max(1, (this.canvas.width + 1) >> 1);
    const halfHeight = Math.max(1, (this.canvas.height + 1) >> 1);
    this.#halfWidth = halfWidth;
    this.#halfHeight = halfHeight;

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.#blurTextureA);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      halfWidth,
      halfHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindTexture(gl.TEXTURE_2D, this.#blurTextureB);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      halfWidth,
      halfHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.activeTexture(gl.TEXTURE0);
  }

  /** New texture with the params video-sized (non-power-of-two) frames need. */
  #createTexture(): WebGLTexture {
    const gl = this.#gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("Camera tone stage: no texture");
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  #createFramebuffer(texture: WebGLTexture): WebGLFramebuffer {
    const gl = this.#gl;
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error("Camera tone stage: no framebuffer");
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return framebuffer;
  }

  /** Deletes every GL object this stage holds. Safe to call repeatedly. */
  #release(): void {
    const gl = this.#gl;
    gl.deleteFramebuffer(this.#blurFramebufferA);
    gl.deleteFramebuffer(this.#blurFramebufferB);
    gl.deleteFramebuffer(this.#lumaFramebuffer);
    gl.deleteTexture(this.#sourceTexture);
    gl.deleteTexture(this.#blurTextureA);
    gl.deleteTexture(this.#blurTextureB);
    gl.deleteTexture(this.#lumaTexture);
    gl.deleteProgram(this.#blurProgram);
    gl.deleteProgram(this.#finalProgram);
    gl.deleteProgram(this.#lumaProgram);
    this.#blurFramebufferA = null;
    this.#blurFramebufferB = null;
    this.#lumaFramebuffer = null;
    this.#sourceTexture = null;
    this.#blurTextureA = null;
    this.#blurTextureB = null;
    this.#lumaTexture = null;
    this.#blurProgram = null;
    this.#finalProgram = null;
    this.#lumaProgram = null;
    this.#blurTex = null;
    this.#blurStep = null;
    this.#finalSmooth = null;
    this.#finalGain = null;
    this.#finalBrightness = null;
  }
}
