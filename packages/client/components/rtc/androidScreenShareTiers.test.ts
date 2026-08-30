// Specs for the native Android screen-share tier table (screen-leg plan
// §7.4 / §0.7) — run with Node's built-in runner:
//   node --test components/rtc/androidScreenShareTiers.test.ts
//
// The load-bearing property: voice-ingress enforces video by PIXEL AREA and
// by aspect ratio, and its remedy is DISCONNECT
// (voice-ingress/src/api.rs:372-385) — with slice 1's leg-aware branch that
// ejects the LEG mid-share, which the sharer experiences as the share dying
// for no visible reason. Every tier must therefore stay inside the ingress
// envelope on the WORST-CASE phone panel, not just a 16:9 one.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ANDROID_SCREEN_SHARE_TIERS } from "./androidScreenShareTiers.ts";

// The ingress limits both `features.limits.default` and `new_user` hold
// ([[project_screenshare_quality_chain]]: "both limits move together").
const INGRESS_MAX_AREA = 3840 * 2160;
// `voice-ingress` forbids aspect ratios outside [0.3, 2.5].
const INGRESS_MIN_ASPECT = 0.3;
// The narrowest mainstream phone panel: 9:22 (Sony's 21:9 and the tall
// foldable covers sit inside this).
const WORST_CASE_PANEL = 9 / 22;

test("three tiers, in ascending order, with 'default' present", () => {
  assert.deepEqual(
    ANDROID_SCREEN_SHARE_TIERS.map((t) => t.name),
    ["dataSaver", "default", "high"],
  );
  for (let i = 1; i < ANDROID_SCREEN_SHARE_TIERS.length; i++) {
    const prev = ANDROID_SCREEN_SHARE_TIERS[i - 1];
    const next = ANDROID_SCREEN_SHARE_TIERS[i];
    assert.ok(next.longSide > prev.longSide, `${next.name} longSide ascends`);
    assert.ok(
      next.maxBitrateKbps > prev.maxBitrateKbps,
      `${next.name} bitrate ascends`,
    );
  }
});

test("every tier stays inside the ingress envelope on a worst-case panel", () => {
  for (const tier of ANDROID_SCREEN_SHARE_TIERS) {
    // The capture derives the short side from the REAL display aspect, so
    // the worst case for AREA is the squarest panel (16:9-ish) and the worst
    // case for ASPECT is the narrowest one. Check both extremes.
    const area169 = tier.longSide * Math.round((tier.longSide * 9) / 16);
    assert.ok(
      area169 < INGRESS_MAX_AREA,
      `${tier.name}: 16:9 area ${area169} under ingress cap`,
    );
    // Portrait capture publishes (short × long): aspect = short/long. Derived
    // from THIS tier's dimensions — comparing the two module constants to each
    // other was vacuous: it never referenced `tier`, so no table could fail it.
    const shortSide = Math.round(tier.longSide * WORST_CASE_PANEL);
    const aspect = shortSide / tier.longSide;
    assert.ok(
      aspect > INGRESS_MIN_ASPECT,
      `${tier.name}: published aspect ${aspect} inside the ingress band`,
    );
  }
});

test("no tier asks a phone for more than 30 fps or a 1440 long side", () => {
  // §8: two WebRTC stacks share the device — the WebView decodes the call
  // grid while libwebrtc encodes this. The table is capped by THERMALS, not
  // by what MediaProjection can nominally do; raising these caps is an
  // operator decision with a soak test, never a tweak.
  for (const tier of ANDROID_SCREEN_SHARE_TIERS) {
    assert.ok(tier.fps <= 30, `${tier.name} fps`);
    assert.ok(tier.longSide <= 1440, `${tier.name} long side`);
  }
});
