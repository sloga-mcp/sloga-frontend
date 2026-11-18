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
 * The face-tracked look (`setGlam`) swaps the final pass for a second
 * program that also reads a coverage map on unit 2. While the look is off,
 * faded out, unavailable or still waiting for its first coverage map, a draw
 * uses the plain final program and touches nothing the look added. The
 * look's program is compiled the first time the look is asked for, so a
 * call that never turns it on never pays for it. A look that fails to
 * compile, or whose draws leave a GL error, is switched off on its own
 * (`glamAvailable`); the rest of the stage carries on.
 *
 * Consumers copy from `canvas` with `drawImage()` in the same task as
 * `draw()` and capture their OWN 2D canvas. Nothing captures this canvas, so
 * a lost context here can fail open without touching the published track.
 */
import { type ToneConfig, meanLuma } from "./cameraTonePolicy";
import {
  type GlamBox,
  type GlamLevels,
  type GlamWarp,
  glamFailureText,
} from "./glamPolicy";

/** What the face-tracked look needs for the next draws. */
export interface GlamStageInput {
  /** 0..1 amounts for each part of the look. */
  levels: GlamLevels;
  /** 0..1; multiplies every level and the warp. 0 = the look is not drawn. */
  presence: number;
  warp: GlamWarp;
  /** The video UV rect the coverage map covers. */
  box: GlamBox;
  /** Width / height of the video. */
  aspect: number;
  /**
   * The coverage map when it was repainted for this frame; null keeps the
   * last upload. Opaque, two tiles side by side, row 0 = the top of the box.
   */
  map: TexImageSource | null;
}

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

/**
 * Upper bounds applied in `setGlam`; the policy owns the real ranges. The
 * two warp bounds also keep the warp from folding the picture over itself.
 */
const MAX_GLAM_EYE = 0.2;
const MAX_GLAM_SLIM = 0.12;
const MAX_GLAM_WARM = 0.15;
/** Limits for values the shader divides by. Radii are in frame heights. */
const MIN_GLAM_RADIUS = 1e-4;
const MAX_GLAM_RADIUS = 1;
const MIN_GLAM_BOX_SIDE = 1e-6;
const MIN_GLAM_ASPECT = 0.1;
const MAX_GLAM_ASPECT = 10;
/** How many error codes are read when clearing the GL error queue. */
const MAX_ERRORS_DRAINED = 8;

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
 * Final pass with the face-tracked look. Replaces FINAL_SOURCE for a draw
 * only while the look is active; everything FINAL_SOURCE does is repeated
 * here with the same maths, so switching programs changes nothing else.
 *
 * Coordinates. `vUv` is the framebuffer coordinate: (0, 0) is the BOTTOM
 * left of the canvas. Every texture in the stage keeps the image's top row
 * at v = 0, so `uv = (vUv.x, 1 - vUv.y)` is the video UV with its origin at
 * the TOP left and y pointing down. That is the space the landmarks, the
 * face box and the warp points are given in, so they are used as they come:
 * the single flip on the first line of main() is the only one. Distances
 * are taken with x multiplied by the aspect ratio, which puts both axes in
 * frame heights (the unit of every radius).
 *
 * Warp. This shader picks, for each output pixel, where to read the source.
 * To make the picture content move along a direction, it reads from the
 * opposite side: `uv - move`. To make an eye look larger, it reads closer to
 * the eye's centre. All shifts are summed from the unwarped position, faded
 * to nothing over the last 3% before a frame edge, and limited to half the
 * distance to the nearest edge on each axis, so a read never leaves 0..1 and
 * no clamped streak can appear.
 *
 * One warped position is used for all three textures, which keeps the
 * smoothing and the makeup glued to the reshaped face.
 *
 * Coverage map (unit 2). Two tiles side by side: left R = skin, G = lips,
 * B = blush; right R = upper lids. The map is uploaded without a flip, so
 * its row 0 (the top of the face box) is at v = 0 and the tile-local
 * position `(warped - box.xy) / box.wh` indexes a tile directly. Each tile
 * is read half a texel inside its own border so bilinear filtering never
 * mixes in the neighbouring tile. Outside the box the coverage is zero.
 *
 * Makeup is relative to the pixel it lands on, so it holds up on light and
 * dark skin: the lid shade multiplies, blush and lips use a soft-light blend
 * (black stays black, highlights stay highlights) mixed in by coverage.
 */
const GLAM_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform sampler2D uSmoothed;
uniform sampler2D uMap;
uniform float uSmooth;
uniform float uGain;
uniform float uBrightness;
uniform vec4 uBox;
uniform float uAspect;
uniform float uPresence;
uniform float uGlamSmooth;
uniform float uLips;
uniform float uBlush;
uniform float uLid;
uniform float uEye;
uniform float uSlim;
uniform float uWarm;
uniform vec3 uEyes[2];
uniform vec4 uJaw[4];
uniform float uJawR[4];
in vec2 vUv;
out vec4 outColor;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float GAMMA_LIFT = 0.15;
const float EDGE_FADE = 0.03;
const vec3 LIP_TINT = vec3(0.80, 0.14, 0.24);
const vec3 BLUSH_TINT = vec3(0.90, 0.25, 0.32);
const vec3 LID_TINT = vec3(0.36, 0.25, 0.20);
const vec3 WARM_TINT = vec3(1.0, 0.72, 0.40);
float bump(vec2 delta, float radius) {
  float t = min(length(delta) / radius, 1.0);
  float f = 1.0 - t * t;
  return f * f;
}
vec3 softLight(vec3 base, vec3 tint) {
  return (1.0 - 2.0 * tint) * base * base + 2.0 * tint * base;
}
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 scale = vec2(uAspect, 1.0);
  vec2 shift = vec2(0.0);
  for (int i = 0; i < 2; i++) {
    vec2 toCenter = uEyes[i].xy - uv;
    shift += toCenter * (uEye * bump(toCenter * scale, uEyes[i].z));
  }
  for (int i = 0; i < 4; i++) {
    float reach = bump((uv - uJaw[i].xy) * scale, uJawR[i]);
    float amount = uSlim * uJawR[i] * reach;
    shift -= vec2(uJaw[i].z / uAspect, uJaw[i].w) * amount;
  }
  vec2 room = min(uv, 1.0 - uv);
  shift *= uPresence * smoothstep(0.0, EDGE_FADE, min(room.x, room.y));
  shift = clamp(shift, -0.5 * room, 0.5 * room);
  vec2 warped = uv + shift;

  vec2 local = (warped - uBox.xy) / uBox.zw;
  float inside = step(0.0, min(local.x, local.y))
    * step(max(local.x, local.y), 1.0);
  vec2 texel = 1.0 / vec2(textureSize(uMap, 0));
  vec2 inTile = clamp(local, 0.0, 1.0);
  vec2 tile = vec2(
    mix(0.5 * texel.x, 0.5 - 0.5 * texel.x, inTile.x),
    mix(0.5 * texel.y, 1.0 - 0.5 * texel.y, inTile.y));
  float cover = inside * uPresence;
  vec3 face = texture(uMap, tile).rgb * cover;
  float lid = texture(uMap, tile + vec2(0.5, 0.0)).r * cover;

  vec3 color = texture(uSource, warped).rgb;
  float smoothing = max(uSmooth, uGlamSmooth * face.r);
  color = mix(color, texture(uSmoothed, warped).rgb, smoothing);
  color = mix(color, color * LID_TINT, uLid * lid);
  color = mix(color, softLight(color, BLUSH_TINT), uBlush * face.b);
  color = mix(color, softLight(color, LIP_TINT), uLips * face.g);
  color = min(color * (1.0 + uWarm * face.r * WARM_TINT), 1.0);

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

/** A level between 0 and `max`; anything that is not a number counts as 0. */
function levelOr0(value: number, max: number): number {
  return Math.min(max, Math.max(0, finiteOr(value, 0)));
}

function allFinite(values: Float32Array): boolean {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

/** Where the look's uniforms live in its program. */
interface GlamUniforms {
  smooth: WebGLUniformLocation | null;
  gain: WebGLUniformLocation | null;
  brightness: WebGLUniformLocation | null;
  box: WebGLUniformLocation | null;
  aspect: WebGLUniformLocation | null;
  presence: WebGLUniformLocation | null;
  glamSmooth: WebGLUniformLocation | null;
  lips: WebGLUniformLocation | null;
  blush: WebGLUniformLocation | null;
  lid: WebGLUniformLocation | null;
  eye: WebGLUniformLocation | null;
  slim: WebGLUniformLocation | null;
  warm: WebGLUniformLocation | null;
  eyes: WebGLUniformLocation | null;
  jaw: WebGLUniformLocation | null;
  jawRadius: WebGLUniformLocation | null;
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

  /**
   * Null until the look is first asked for on this build, and when its
   * shader did not compile or link.
   */
  #glamProgram: WebGLProgram | null = null;
  #glamUniforms: GlamUniforms | null = null;
  #mapTexture: WebGLTexture | null = null;
  /**
   * True once this build has tried to compile the look's program: one try
   * per build, whatever the outcome.
   */
  #glamCompileTried = false;
  /**
   * The latest try to compile or link the look's program failed. Kept until
   * the next try, which a later build makes only if the look is asked for.
   */
  #glamBuildFailed = false;
  /** A draw with the look left a GL error. Kept across rebuilds. */
  #glamDrawFailed = false;
  #glamLogged = false;
  /** Why the look cannot be drawn, for the diagnostic readout; "" if it can. */
  #glamFailure = "";
  /** What last stopped the plain draws, for the same readout; "" if nothing. */
  #lastError = "";
  /** True from a build until a coverage map is uploaded. */
  #needsGlamMap = true;
  /**
   * Draws WITH the look left that end with a `gl.getError()`. Counted apart
   * from #drawsToCheck because the look usually starts long after the first
   * frames of a build.
   */
  #glamDrawsToCheck = 0;
  /**
   * True once the look has passed its checked draws on this build. From
   * then on a resize does not hold the look back: the resize changes the
   * blur targets, not the look's program.
   */
  #glamProven = false;
  #lastDrawUsedGlam = false;

  /** True when the stored values below describe a look worth drawing. */
  #glamOn = false;
  #glamPresence = 0;
  #glamAspect = 1;
  #glamSmooth = 0;
  #glamLips = 0;
  #glamBlush = 0;
  #glamLid = 0;
  #glamEye = 0;
  #glamSlim = 0;
  #glamWarm = 0;
  /** x, y, w, h in video UV. */
  readonly #glamBox = new Float32Array(4);
  /** Two eyes: x, y, r. */
  readonly #glamEyes = new Float32Array(6);
  /** Four pushes: x, y, dx, dy. */
  readonly #glamJaw = new Float32Array(16);
  readonly #glamJawRadius = new Float32Array(4);

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
      this.#lastError = "a blur target is incomplete after a resize";
    }
    // New targets, new upload size: the next draws are checked again. The
    // look's own count is left alone; only a build starts it over.
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
   * Stores the face-tracked look for the next draws and uploads its coverage
   * map when one is given. `null`, a presence of 0, every level at 0, or a
   * value the shader cannot use (not a number, an empty box) all mean the
   * next draws are the plain ones.
   *
   * The map is uploaded as it is, without a flip: the stage never sets
   * `UNPACK_FLIP_Y_WEBGL` or `UNPACK_PREMULTIPLY_ALPHA_WEBGL`, so the map's
   * row 0 lands at v = 0 like the top row of the camera frame, and its
   * opaque channels arrive unchanged.
   *
   * The first call that stores a usable look compiles the look's program,
   * which can take a while on a slow device. If that fails, `glamAvailable`
   * is false when this returns. Never throws for that.
   */
  setGlam(input: GlamStageInput | null): void {
    if (this.#destroyed) return;
    if (!input) {
      this.#glamOn = false;
      return;
    }
    if (input.map) this.#uploadGlamMap(input.map);
    this.#glamOn = this.#storeGlam(input);
    // While the stage waits for a rebuild nothing can be compiled; the
    // rebuild compiles the program itself if the look is still on then.
    if (this.#glamOn && !this.#lost && !this.#needsRebuild) {
      this.#ensureGlamProgram();
    }
  }

  /**
   * False once the look cannot be drawn on this device: its shader did not
   * compile or link, or a draw with it left a GL error. The stage keeps
   * drawing without it.
   *
   * True does not promise the look works: the shader is only compiled when
   * a usable look is first stored, so read this again after `setGlam`.
   */
  get glamAvailable(): boolean {
    return !this.#glamBuildFailed && !this.#glamDrawFailed;
  }

  /**
   * Why `glamAvailable` is false, as text for the diagnostic readout:
   * `shader "<what the compiler or the linker said>"` or
   * `draw error 0x<the GL error code>`. "" while the look is available.
   */
  get glamFailure(): string {
    return this.#glamFailure;
  }

  /**
   * What last made the plain draws stop until a rebuild (a GL error in a
   * checked draw, a blur target that could not be resized, a rebuild that
   * threw), as text for the same readout. "" when nothing has. Cleared by a
   * rebuild that succeeds.
   */
  get lastError(): string {
    return this.#lastError;
  }

  /**
   * True while a usable look is stored: the last `setGlam` was given one and
   * the stage has not been destroyed. This is what was asked for, not what
   * is drawn: it stays true while the look waits for its coverage map or for
   * the checked plain draws, and it does not look at `glamAvailable`. A
   * caller that skips the stage for a neutral tone config must still draw
   * it while this is true.
   */
  get glamWanted(): boolean {
    return this.#glamOn;
  }

  /**
   * True until a coverage map has been uploaded since the last build. A
   * rebuild after a context loss starts from an empty map, so the caller
   * repaints and sends the map again while this is true. No draw uses the
   * look while this is true: the warp without its makeup would show.
   */
  get needsGlamMap(): boolean {
    return this.#needsGlamMap;
  }

  /**
   * Whether the last `draw()` drew the look. False when it drew nothing,
   * and for a frame drawn plain because the look was held back (no coverage
   * map yet, or the plain path still being checked after a build).
   */
  get lastDrawUsedGlam(): boolean {
    return this.#lastDrawUsedGlam;
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
    this.#lastDrawUsedGlam = false;
    if (this.#destroyed || this.#lost || this.#needsRebuild) return false;
    if (gl.isContextLost()) return false;
    if (!sourceHasPixels(source)) return false;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#sourceTexture);
    // A throw here (closed frame, tainted source) leaves #hasFrame as it was.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.#hasFrame = true;

    const smooth = this.#smooth;
    // The look waits for its coverage map: without one the warp would move
    // the eyes and the jaw with no makeup on them. On a fresh build it also
    // waits until the plain path has passed its checked draws, so an error
    // during one of its own first draws can only be the look's own. Once it
    // has passed those, a resize does not hold it back again (the picture
    // would lose the look for a few frames on every rotation); an error in
    // the checked draws after a resize stops the whole stage either way.
    const useGlam =
      this.#glamOn &&
      this.#glamProgram !== null &&
      this.#glamUniforms !== null &&
      !this.#glamDrawFailed &&
      !this.#needsGlamMap &&
      (this.#drawsToCheck === 0 || this.#glamProven);
    // The look smooths the skin from the same blurred copy.
    if (smooth > 0 || (useGlam && this.#glamSmooth > 0)) {
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
    if (useGlam) {
      this.#useGlamProgram(smooth);
    } else {
      gl.useProgram(this.#finalProgram);
      gl.uniform1f(this.#finalSmooth, smooth);
      gl.uniform1f(this.#finalGain, this.#gain);
      gl.uniform1f(this.#finalBrightness, this.#brightness);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (this.#drawsToCheck > 0) {
      this.#drawsToCheck--;
      // Anything in the error queue counts, a leftover from the build
      // included: a stage that cannot be trusted draws nothing.
      const code = gl.getError();
      if (code !== gl.NO_ERROR) {
        this.#needsRebuild = true;
        this.#hasFrame = false;
        this.#lastError = `draw error 0x${code.toString(16)}`;
        return false;
      }
    } else if (useGlam && this.#glamDrawsToCheck > 0) {
      this.#glamDrawsToCheck--;
      const code = gl.getError();
      if (code !== gl.NO_ERROR) {
        // The plain path was clean before the look joined in, so the look
        // takes the blame and this frame is drawn again without it. A lost
        // context is nobody's fault and is handled like any other loss.
        if (gl.isContextLost() || !this.#redrawWithoutGlam(smooth, code)) {
          this.#needsRebuild = true;
          this.#hasFrame = false;
          return false;
        }
        return true;
      }
      if (this.#glamDrawsToCheck === 0) this.#glamProven = true;
    }
    this.#lastDrawUsedGlam = useGlam;
    return true;
  }

  /**
   * Compiles and links the look's program if this build has not tried yet.
   * Called when a usable look is stored, and at the end of a build while one
   * is. Never throws: a failure is logged once and leaves `glamAvailable`
   * false. Leaves no program selected.
   */
  #ensureGlamProgram(): void {
    const gl = this.#gl;
    if (this.#glamCompileTried || this.#glamDrawFailed) return;
    if (gl.isContextLost()) return;
    this.#glamCompileTried = true;
    let vertex: WebGLShader | null = null;
    try {
      vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE, "vertex");
      const glam = linkProgram(gl, vertex, GLAM_SOURCE, "glam");
      this.#glamProgram = glam;
      const at = (name: string) => gl.getUniformLocation(glam, name);
      this.#glamUniforms = {
        smooth: at("uSmooth"),
        gain: at("uGain"),
        brightness: at("uBrightness"),
        box: at("uBox"),
        aspect: at("uAspect"),
        presence: at("uPresence"),
        glamSmooth: at("uGlamSmooth"),
        lips: at("uLips"),
        blush: at("uBlush"),
        lid: at("uLid"),
        eye: at("uEye"),
        slim: at("uSlim"),
        warm: at("uWarm"),
        eyes: at("uEyes"),
        jaw: at("uJaw"),
        jawRadius: at("uJawR"),
      };
      // Same units as the plain final pass, plus the coverage map on unit 2.
      gl.useProgram(glam);
      gl.uniform1i(at("uSource"), 0);
      gl.uniform1i(at("uSmoothed"), 1);
      gl.uniform1i(at("uMap"), 2);
      gl.useProgram(null);
      this.#glamBuildFailed = false;
      if (!this.#glamDrawFailed) this.#glamFailure = "";
    } catch (error) {
      gl.deleteProgram(this.#glamProgram);
      this.#glamProgram = null;
      this.#glamUniforms = null;
      if (gl.isContextLost()) {
        // A context lost half way is not the shader's fault: the next build
        // gets its own try.
        this.#glamCompileTried = false;
      } else {
        this.#glamBuildFailed = true;
        // The compiler's own words, without this file's prefix in front.
        this.#glamFailure = `shader "${glamFailureText(
          error instanceof Error
            ? error.message.replace("Camera tone stage: ", "")
            : error,
        )}"`;
        this.#logGlam("the face-tracked look is unavailable", error);
      }
    } finally {
      gl.deleteShader(vertex);
    }
  }

  /**
   * Selects the look's program for the final pass and sends everything it
   * reads. Leaves unit 0 active, with the coverage map bound on unit 2.
   */
  #useGlamProgram(smooth: number): void {
    const gl = this.#gl;
    const uniforms = this.#glamUniforms;
    if (!uniforms) return;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.#mapTexture);
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(this.#glamProgram);
    gl.uniform1f(uniforms.smooth, smooth);
    gl.uniform1f(uniforms.gain, this.#gain);
    gl.uniform1f(uniforms.brightness, this.#brightness);
    gl.uniform4fv(uniforms.box, this.#glamBox);
    gl.uniform1f(uniforms.aspect, this.#glamAspect);
    gl.uniform1f(uniforms.presence, this.#glamPresence);
    gl.uniform1f(uniforms.glamSmooth, this.#glamSmooth);
    gl.uniform1f(uniforms.lips, this.#glamLips);
    gl.uniform1f(uniforms.blush, this.#glamBlush);
    gl.uniform1f(uniforms.lid, this.#glamLid);
    gl.uniform1f(uniforms.eye, this.#glamEye);
    gl.uniform1f(uniforms.slim, this.#glamSlim);
    gl.uniform1f(uniforms.warm, this.#glamWarm);
    gl.uniform3fv(uniforms.eyes, this.#glamEyes);
    gl.uniform4fv(uniforms.jaw, this.#glamJaw);
    gl.uniform1fv(uniforms.jawRadius, this.#glamJawRadius);
  }

  /**
   * After a draw with the look left a GL error: gives up on the look, clears
   * the error queue and draws the final pass again with the plain program
   * (the source and the blur targets of this frame are still in place).
   * False when that draw fails too. `code` is the GL error the draw left.
   */
  #redrawWithoutGlam(smooth: number, code: number): boolean {
    const gl = this.#gl;
    this.#glamDrawFailed = true;
    this.#glamFailure = `draw error 0x${code.toString(16)}`;
    this.#logGlam("a draw with the face-tracked look left a GL error");
    for (let i = 0; i < MAX_ERRORS_DRAINED; i++) {
      if (gl.getError() === gl.NO_ERROR) break;
    }
    gl.useProgram(this.#finalProgram);
    gl.uniform1f(this.#finalSmooth, smooth);
    gl.uniform1f(this.#finalGain, this.#gain);
    gl.uniform1f(this.#finalBrightness, this.#brightness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return gl.getError() === gl.NO_ERROR;
  }

  /** Says once, for the life of the stage, why the look is not drawn. */
  #logGlam(reason: string, error?: unknown): void {
    if (this.#glamLogged) return;
    this.#glamLogged = true;
    console.warn(`Camera tone stage: ${reason}`, error ?? "");
  }

  /** Replaces the coverage map. Leaves unit 0 active. */
  #uploadGlamMap(map: TexImageSource): void {
    const gl = this.#gl;
    if (this.#lost || this.#needsRebuild || !this.#mapTexture) return;
    if (gl.isContextLost() || !sourceHasPixels(map)) return;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.#mapTexture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, map);
      if (this.#needsGlamMap) {
        // The first real map on this build: the first draw that reads it is
        // checked, however many draws with the look were checked before.
        this.#glamDrawsToCheck = Math.max(this.#glamDrawsToCheck, 1);
        this.#needsGlamMap = false;
      }
    } catch (error) {
      // The texture keeps what it had; the caller's frame goes on.
      this.#logGlam("the coverage map could not be uploaded", error);
    } finally {
      gl.activeTexture(gl.TEXTURE0);
    }
  }

  /**
   * Copies the look into the fields `#useGlamProgram` sends. False when
   * there is nothing to draw or a value could not be used.
   */
  #storeGlam(input: GlamStageInput): boolean {
    const presence = levelOr0(input.presence, 1);
    const aspect = input.aspect;
    if (!(presence > 0) || !Number.isFinite(aspect) || !(aspect > 0)) {
      return false;
    }
    const { levels, warp, box } = input;
    this.#glamPresence = presence;
    this.#glamAspect = Math.min(
      MAX_GLAM_ASPECT,
      Math.max(MIN_GLAM_ASPECT, aspect),
    );
    this.#glamSmooth = levelOr0(levels.smooth, 1);
    this.#glamLips = levelOr0(levels.lips, 1);
    this.#glamBlush = levelOr0(levels.blush, 1);
    this.#glamLid = levelOr0(levels.lid, 1);
    this.#glamEye = levelOr0(levels.eye, MAX_GLAM_EYE);
    this.#glamSlim = levelOr0(levels.slim, MAX_GLAM_SLIM);
    this.#glamWarm = levelOr0(levels.warm, MAX_GLAM_WARM);
    const anyLevel =
      this.#glamSmooth > 0 ||
      this.#glamLips > 0 ||
      this.#glamBlush > 0 ||
      this.#glamLid > 0 ||
      this.#glamEye > 0 ||
      this.#glamSlim > 0 ||
      this.#glamWarm > 0;
    if (!anyLevel) return false;

    const radius = (r: number): number =>
      Math.min(MAX_GLAM_RADIUS, Math.max(MIN_GLAM_RADIUS, r));
    const glamBox = this.#glamBox;
    glamBox[0] = box.x;
    glamBox[1] = box.y;
    glamBox[2] = box.w;
    glamBox[3] = box.h;
    const eyes = this.#glamEyes;
    for (let i = 0; i < 2; i++) {
      const eye = warp.eyes[i];
      eyes[i * 3] = eye.x;
      eyes[i * 3 + 1] = eye.y;
      eyes[i * 3 + 2] = radius(eye.r);
    }
    const jaw = this.#glamJaw;
    const jawRadius = this.#glamJawRadius;
    for (let i = 0; i < 4; i++) {
      const push = warp.jaw[i];
      jaw[i * 4] = push.x;
      jaw[i * 4 + 1] = push.y;
      jaw[i * 4 + 2] = Math.min(1, Math.max(-1, push.dx));
      jaw[i * 4 + 3] = Math.min(1, Math.max(-1, push.dy));
      jawRadius[i] = radius(push.r);
    }
    // `Math.min` / `Math.max` pass NaN through, so one sweep catches it all.
    if (
      !allFinite(glamBox) ||
      !allFinite(eyes) ||
      !allFinite(jaw) ||
      !allFinite(jawRadius)
    ) {
      return false;
    }
    return glamBox[2] >= MIN_GLAM_BOX_SIDE && glamBox[3] >= MIN_GLAM_BOX_SIDE;
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
    } catch (error) {
      this.#release();
      this.#lost = true;
      this.#lastError = `rebuild "${glamFailureText(error)}"`;
      return false;
    }
    this.#lost = false;
    this.#needsRebuild = false;
    this.#lastError = "";
    return true;
  }

  /** Frees everything, including the context this stage owns. Idempotent. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#hasFrame = false;
    this.#glamOn = false;
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
    // The uploaded coverage map went with the context.
    this.#needsGlamMap = true;
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

    // The coverage map starts as one black texel (no coverage anywhere), so
    // the sampler on unit 2 is complete before the first real map arrives.
    // `#createTexture` binds on unit 1; blur target B goes back there after.
    this.#mapTexture = this.#createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#blurTextureB);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.#mapTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    gl.activeTexture(gl.TEXTURE0);
    this.#needsGlamMap = true;

    this.#drawsToCheck = CHECKED_DRAWS;
    this.#glamDrawsToCheck = CHECKED_DRAWS;
    this.#glamProven = false;

    // The look's program is not part of a build unless the look is on right
    // now (a rebuild in the middle of a call that uses it). Last, and on its
    // own: a driver that rejects the look's shader still gets all the rest.
    this.#glamCompileTried = false;
    if (this.#glamOn) this.#ensureGlamProgram();
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
    gl.deleteTexture(this.#mapTexture);
    gl.deleteProgram(this.#glamProgram);
    this.#mapTexture = null;
    this.#glamProgram = null;
    this.#glamUniforms = null;
    this.#glamCompileTried = false;
    this.#needsGlamMap = true;
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
