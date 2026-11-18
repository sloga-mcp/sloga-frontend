/**
 * Paints the coverage map for the face-tracked look: a small canvas that
 * says, for every spot on the face, how much of each part of the look
 * belongs there. A shader samples it; it is never shown.
 *
 * Layout: two square tiles side by side, each as wide as the canvas is tall.
 * The background is opaque black, which means "nothing here".
 *
 * - Left tile:  red = skin (where smoothing applies), green = lips,
 *               blue = blush.
 * - Right tile: red = shade on the upper eyelids.
 *
 * Coordinates: the geometry is in video UV (origin top-left, 0..1 on both
 * axes). Both tiles cover the same rect of the video, `geometry.box`, so a
 * point (x, y) lands in a tile at
 *
 *   tx = (x - box.x) / box.w * tile size
 *   ty = (y - box.y) / box.h * tile size
 *
 * plus one tile width on x for the right tile. Row 0 of the canvas is the
 * top of the face: nothing is flipped here.
 *
 * Soft edges are made by going over each edge with a few wide, partly
 * see-through black lines, which wear the coverage down toward the edge.
 * `ctx.filter` and shadows are not used: not every web view has the first,
 * and both are slow. The shader's bilinear sampling of this small map
 * softens the rest.
 *
 * The black lines would wipe the other colours under them, so the order of
 * the parts matters: skin first (nothing else is on the tile yet), then the
 * lips (they sit inside a hole in the skin, where red is already gone), and
 * the blush last (it has no lines).
 *
 * This runs many times a second on the main thread, so a paint allocates
 * nothing: every shape is traced into the context's own path, and the two
 * gradients are made once and placed with a transform.
 */
import {
  type GlamBox,
  type GlamGeometry,
  type GlamPoint,
  GLAM_MAP_HEIGHT,
  GLAM_MAP_WIDTH,
} from "./glamPolicy";

/** The side of one tile, in canvas pixels. */
const TILE = GLAM_MAP_HEIGHT;
/** Where the right tile starts on x. */
const RIGHT_TILE_X = TILE;

// One colour per part, so that adding one part never changes another. The
// blush is pure blue too; its colour lives in the gradient made below.
const RED = "rgb(255,0,0)";
const GREEN = "rgb(0,255,0)";
const BLACK = "rgb(0,0,0)";

/**
 * One pass over an edge: the line width in tile pixels and how much of the
 * coverage under the line it removes. Half of the width falls on the inside
 * of the edge, so a 14 px line softens 7 px.
 */
type FeatherPass = readonly [width: number, alpha: number];

// Widest first. What is left of the coverage, from the inside out to the
// edge: skin 65%, 36%, 14% over 7 px; lips 60%, 30% over 3 px; lids 65%,
// 36% over 2 px. The eye, brow and mouth holes in the skin grow by the same
// amount, which keeps the smoothing off the lashes and the lip line.
const SKIN_FEATHER: readonly FeatherPass[] = [
  [14, 0.35],
  [9, 0.45],
  [4, 0.6],
];
const LIPS_FEATHER: readonly FeatherPass[] = [
  [6, 0.4],
  [3, 0.5],
];
const LIDS_FEATHER: readonly FeatherPass[] = [
  [4, 0.35],
  [2, 0.45],
];

/** Blush at the centre of a spot; it falls to nothing at the spot's radius. */
const BLUSH_CENTRE_ALPHA = 0.9;
/**
 * The lid shade is full at the lash line and falls to `LID_FAR_ALPHA` at
 * this many times the distance from the lash row to the row above it. The
 * band ends near 1, so its far edge keeps roughly half of the shade.
 */
const LID_RAMP_REACH = 1.5;
const LID_FAR_ALPHA = 0.25;
/** A lid band thinner than this (in tile pixels) is filled flat: no direction to ramp along. */
const LID_MIN_RAMP_PX = 1;

const tileX = (x: number, box: GlamBox): number => ((x - box.x) / box.w) * TILE;
const tileY = (y: number, box: GlamBox): number => ((y - box.y) / box.h) * TILE;

/** A ring can be drawn when it has an area and every point lands on a finite pixel. */
function ringUsable(ring: readonly GlamPoint[], box: GlamBox): boolean {
  if (ring.length < 3) return false;
  for (let i = 0; i < ring.length; i++) {
    if (
      !Number.isFinite(tileX(ring[i].x, box)) ||
      !Number.isFinite(tileY(ring[i].y, box))
    ) {
      return false;
    }
  }
  return true;
}

function ringsUsable(
  rings: readonly (readonly GlamPoint[])[],
  box: GlamBox,
): boolean {
  for (let i = 0; i < rings.length; i++) {
    if (!ringUsable(rings[i], box)) return false;
  }
  return true;
}

/** Adds a closed ring to the context's current path. `offsetX` picks the tile. */
function traceRing(
  ctx: CanvasRenderingContext2D,
  ring: readonly GlamPoint[],
  box: GlamBox,
  offsetX: number,
): void {
  for (let i = 0; i < ring.length; i++) {
    const x = offsetX + tileX(ring[i].x, box);
    const y = tileY(ring[i].y, box);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * Softens every edge of the current path by wearing the coverage down
 * toward it. Leaves the context ready to add colour again.
 */
function featherPath(
  ctx: CanvasRenderingContext2D,
  passes: readonly FeatherPass[],
): void {
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = BLACK;
  for (let i = 0; i < passes.length; i++) {
    ctx.lineWidth = passes[i][0];
    ctx.globalAlpha = passes[i][1];
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "lighter";
}

export class GlamMaskPainter {
  /** `GLAM_MAP_WIDTH` x `GLAM_MAP_HEIGHT`. Hand it to the shader as a texture source. */
  readonly canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D | undefined;
  // Both gradients are drawn in their own unit space and placed with a
  // transform at paint time, so one of each serves every spot and lid.
  /** Centre at the origin, radius 1. */
  #blushFill: CanvasGradient | undefined;
  /** From x = 0 (the lash line) to x = 1. */
  #lidFill: CanvasGradient | undefined;

  constructor() {
    const canvas = document.createElement("canvas");
    canvas.width = GLAM_MAP_WIDTH;
    canvas.height = GLAM_MAP_HEIGHT;
    this.canvas = canvas;

    // No alpha: the map is opaque by design. Nothing reads pixels back, so
    // the canvas may stay on the GPU, where the upload to a texture is cheap.
    const ctx =
      canvas.getContext("2d", { willReadFrequently: false, alpha: false }) ??
      canvas.getContext("2d") ??
      undefined;
    this.#ctx = ctx;
    if (!ctx) return;

    const blush = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    blush.addColorStop(0, `rgba(0,0,255,${BLUSH_CENTRE_ALPHA})`);
    blush.addColorStop(1, "rgba(0,0,255,0)");
    this.#blushFill = blush;

    const lid = ctx.createLinearGradient(0, 0, 1, 0);
    lid.addColorStop(0, "rgba(255,0,0,1)");
    lid.addColorStop(1, `rgba(255,0,0,${LID_FAR_ALPHA})`);
    this.#lidFill = lid;

    // A canvas that fell back to one with alpha starts out see-through.
    this.#clear(ctx);
  }

  /**
   * Repaints both tiles from one set of face geometry. `aspect` = width /
   * height of the video; it is needed only for the blush, whose radius is in
   * frame heights.
   *
   * A part with a coordinate that is not a finite number is left out. A box
   * with no area leaves the whole map black.
   */
  paint(geometry: GlamGeometry, aspect: number): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    this.#clear(ctx);

    const box = geometry.box;
    if (
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !Number.isFinite(box.w) ||
      !Number.isFinite(box.h) ||
      !(box.w > 0) ||
      !(box.h > 0)
    ) {
      return;
    }

    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    this.#enterTile(ctx, 0);
    this.#paintSkin(ctx, geometry, box);
    this.#paintLips(ctx, geometry, box);
    this.#paintBlush(ctx, geometry, box, aspect);
    ctx.restore();

    this.#enterTile(ctx, RIGHT_TILE_X);
    for (let i = 0; i < geometry.lids.length; i++) {
      this.#paintLid(ctx, geometry.lids[i], box);
    }
    ctx.restore();

    ctx.globalCompositeOperation = "source-over";
  }

  /** Shrinks the canvas to nothing so its memory is released at once. Painting after this does nothing. */
  dispose(): void {
    this.#ctx = undefined;
    this.#blushFill = undefined;
    this.#lidFill = undefined;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  /** Everything opaque black, with the drawing state back to its defaults. */
  #clear(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = BLACK;
    ctx.fillRect(0, 0, GLAM_MAP_WIDTH, GLAM_MAP_HEIGHT);
  }

  /**
   * Keeps what follows inside one tile, so a shape that runs past the box
   * cannot spill into the neighbour, and switches to adding colour. The
   * caller ends the tile with `ctx.restore()`.
   */
  #enterTile(ctx: CanvasRenderingContext2D, offsetX: number): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(offsetX, 0, TILE, TILE);
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
  }

  /**
   * The face oval with the eyes, brows and mouth taken out.
   *
   * The holes are painted over in black instead of being left out with an
   * even-odd fill. On a turned head a hole can overlap another or poke out
   * of the oval, and even-odd would turn those places into skin. Painting
   * black is safe because nothing else is on the tile yet.
   *
   * When any hole cannot be drawn there is no skin at all: no smoothing is
   * better than smoothing over an eye.
   */
  #paintSkin(
    ctx: CanvasRenderingContext2D,
    geometry: GlamGeometry,
    box: GlamBox,
  ): void {
    if (!ringUsable(geometry.skin, box)) return;
    if (!ringsUsable(geometry.cutouts, box)) return;

    ctx.beginPath();
    traceRing(ctx, geometry.skin, box, 0);
    ctx.fillStyle = RED;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < geometry.cutouts.length; i++) {
      traceRing(ctx, geometry.cutouts[i], box, 0);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = BLACK;
    ctx.fill();

    // The path still holds the holes; with the oval added it has every edge.
    traceRing(ctx, geometry.skin, box, 0);
    featherPath(ctx, SKIN_FEATHER);
  }

  /**
   * The outer lip ring with the mouth opening taken out, the same way as
   * the skin. The black here lands where the skin has no red left (the
   * mouth is one of its holes), give or take the outer 3 px, where the skin
   * is already faded to almost nothing.
   */
  #paintLips(
    ctx: CanvasRenderingContext2D,
    geometry: GlamGeometry,
    box: GlamBox,
  ): void {
    if (!ringUsable(geometry.lips, box)) return;
    if (!ringUsable(geometry.lipsInner, box)) return;

    ctx.beginPath();
    traceRing(ctx, geometry.lips, box, 0);
    ctx.fillStyle = GREEN;
    ctx.fill();

    ctx.beginPath();
    traceRing(ctx, geometry.lipsInner, box, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = BLACK;
    ctx.fill();

    traceRing(ctx, geometry.lips, box, 0);
    featherPath(ctx, LIPS_FEATHER);
  }

  /**
   * Two soft spots. A spot is round on the face, but a tile stretches the
   * box to a square, so in tile pixels it is an ellipse: the radius is
   * `r / aspect / box.w` tiles wide and `r / box.h` tiles tall.
   */
  #paintBlush(
    ctx: CanvasRenderingContext2D,
    geometry: GlamGeometry,
    box: GlamBox,
    aspect: number,
  ): void {
    const fill = this.#blushFill;
    if (!fill) return;
    for (let i = 0; i < geometry.blush.length; i++) {
      const spot = geometry.blush[i];
      const cx = tileX(spot.x, box);
      const cy = tileY(spot.y, box);
      const rx = (spot.r / aspect / box.w) * TILE;
      const ry = (spot.r / box.h) * TILE;
      if (
        !Number.isFinite(cx) ||
        !Number.isFinite(cy) ||
        !Number.isFinite(rx) ||
        !Number.isFinite(ry) ||
        !(rx > 0) ||
        !(ry > 0)
      ) {
        continue;
      }
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx, ry);
      ctx.fillStyle = fill;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
    }
  }

  /**
   * One upper-lid band, strongest at the lash line and fading toward the
   * crease.
   *
   * The first half of the ring runs along the lash line and the second half
   * comes back along the row above it, so the line from the middle of the
   * first half to the middle of the second is the way the shade fades.
   */
  #paintLid(
    ctx: CanvasRenderingContext2D,
    ring: readonly GlamPoint[],
    box: GlamBox,
  ): void {
    if (!ringUsable(ring, box)) return;

    const half = ring.length >> 1;
    let lashX = 0;
    let lashY = 0;
    let aboveX = 0;
    let aboveY = 0;
    for (let i = 0; i < ring.length; i++) {
      if (i < half) {
        lashX += ring[i].x;
        lashY += ring[i].y;
      } else {
        aboveX += ring[i].x;
        aboveY += ring[i].y;
      }
    }
    const fromX = RIGHT_TILE_X + tileX(lashX / half, box);
    const fromY = tileY(lashY / half, box);
    const alongX =
      (RIGHT_TILE_X + tileX(aboveX / (ring.length - half), box) - fromX) *
      LID_RAMP_REACH;
    const alongY =
      (tileY(aboveY / (ring.length - half), box) - fromY) * LID_RAMP_REACH;
    const reach = Math.hypot(alongX, alongY);

    ctx.beginPath();
    traceRing(ctx, ring, box, RIGHT_TILE_X);

    const fill = this.#lidFill;
    if (fill && Number.isFinite(reach) && reach >= LID_MIN_RAMP_PX) {
      // The path is already fixed in canvas pixels; the transform only
      // places the gradient: x = 0 at the lash line, x = 1 at the far end.
      ctx.save();
      ctx.transform(alongX, alongY, -alongY, alongX, fromX, fromY);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = RED;
      ctx.fill();
    }

    featherPath(ctx, LIDS_FEATHER);
  }
}
