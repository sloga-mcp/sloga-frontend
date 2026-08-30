/**
 * The PHONE quality table (screen-leg plan §7.4 / §0.7) — deliberately NOT
 * the desktop ladder: single VP8 layer, no simulcast, no backup codec, so the
 * desktop names would promise rungs a phone cannot hold while decoding the
 * call grid in the WebView next to this encoder (§8 thermal).
 *
 * Pure module (no Capacitor, no env) so the invariants are testable under
 * `node --test`: the plugin surface lives in `androidScreenShare.ts`.
 */
import type { AndroidScreenShareTierName } from "@revolt/state/stores/Voice";

/** One rung of the phone table. */
export interface AndroidScreenShareTier {
  /** Stable key, also the sheet's selection value. */
  name: AndroidScreenShareTierName;
  /** Capture long side in px — the short side follows the real display. */
  longSide: number;
  fps: number;
  maxBitrateKbps: number;
  degradation: "maintain-framerate" | "balanced" | "maintain-resolution";
}

/**
 * Long sides are capped so a portrait 20:9 panel never trips voice-ingress's
 * PIXEL-AREA rule, whose remedy is DISCONNECT (with slice 1's leg-aware
 * branch it ejects the LEG, never the member). Default is the middle rung on
 * purpose — see the module docstring.
 */
export const ANDROID_SCREEN_SHARE_TIERS: readonly AndroidScreenShareTier[] = [
  {
    name: "dataSaver",
    longSide: 720,
    fps: 15,
    maxBitrateKbps: 1500,
    degradation: "maintain-framerate",
  },
  {
    name: "default",
    longSide: 1080,
    fps: 30,
    maxBitrateKbps: 3000,
    degradation: "balanced",
  },
  {
    name: "high",
    longSide: 1440,
    fps: 30,
    maxBitrateKbps: 5000,
    degradation: "maintain-resolution",
  },
];
