// Unit spec for the Founding Streamer badge check — run with Node's built-in
// runner:
//   node --conditions=browser --test components/ui/components/utils/foundingStreamer.test.ts
// `--conditions=browser` is required: `foundingStreamer.ts` imports
// `UserBadges` from stoat.js at RUNTIME (the bit has exactly one definition
// per repo and is never hard-coded), so the package has to resolve, not just
// type-check.
//
// Color precedence (masquerade, brand, role, personal, then this fallback)
// lives in `resolveNameLayers` and is pinned in `nameLayers.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { User } from "stoat.js";
import { UserBadges } from "stoat.js";

import {
  FOUNDING_STREAMER_COLOUR,
  isFoundingStreamer,
} from "./foundingStreamer.ts";

/**
 * Minimal stand-in for a User: only `badges` is ever reached.
 */
const user = (badges?: number) => ({ badges }) as unknown as User;

test("other badges do not count as the Founding Streamer badge", () => {
  const staff = user(
    UserBadges.Developer | UserBadges.Founder | UserBadges.PlatformModeration,
  );
  assert.equal(isFoundingStreamer(staff), false);
});

test("the badge counts when held alongside others", () => {
  const both = user(UserBadges.Developer | UserBadges.FoundingStreamer);
  assert.equal(isFoundingStreamer(both), true);
});

test("isFoundingStreamer tolerates every empty input", () => {
  assert.equal(isFoundingStreamer(), false);
  assert.equal(isFoundingStreamer(null), false);
  assert.equal(isFoundingStreamer(undefined), false);
  assert.equal(isFoundingStreamer(user(undefined)), false);
  assert.equal(isFoundingStreamer(user(0)), false);
  assert.equal(isFoundingStreamer(user(UserBadges.FoundingStreamer)), true);
});

test("the badge is bit 2048", () => {
  assert.equal(UserBadges.FoundingStreamer, 2048);
});

test("the color constant is the pinned violet", () => {
  assert.equal(FOUNDING_STREAMER_COLOUR, "#8B5CF6");
});
