// Unit spec for the Home page decisions — run with Node's built-in runner:
//   node --conditions=browser --test src/interface/home/homeHub.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CIPHER_BANNER_SNOOZE_MS,
  isNewUser,
  parseStoredTime,
  primaryConnection,
  releaseOf,
  showCipherBanner,
  showWhatsNew,
  streamThumbnail,
} from "./homeHub.ts";

const NOW = 1_800_000_000_000;
const open = {
  allowsLinks: true,
  sale: "open" as const,
  hasCipher: false,
  hiddenAt: undefined,
  now: NOW,
};

test("the Cipher banner shows for a non-member while the sale is open", () => {
  assert.equal(showCipherBanner(open), true);
});

test("the Cipher banner hides unless every condition holds", () => {
  assert.equal(showCipherBanner({ ...open, allowsLinks: false }), false);
  assert.equal(showCipherBanner({ ...open, sale: undefined }), false);
  assert.equal(showCipherBanner({ ...open, sale: "closed" }), false);
  assert.equal(showCipherBanner({ ...open, sale: "soldOut" }), false);
  assert.equal(showCipherBanner({ ...open, hasCipher: true }), false);
});

test("dismissing the Cipher banner hides it for the snooze window", () => {
  const hidden = (ago: number) =>
    showCipherBanner({ ...open, hiddenAt: NOW - ago });
  assert.equal(hidden(0), false);
  assert.equal(hidden(CIPHER_BANNER_SNOOZE_MS - 1), false);
  assert.equal(hidden(CIPHER_BANNER_SNOOZE_MS), true);
  assert.equal(CIPHER_BANNER_SNOOZE_MS, 14 * 24 * 60 * 60 * 1000);
});

test("a dismissal stamped in the future counts as just now", () => {
  assert.equal(
    showCipherBanner({ ...open, hiddenAt: NOW + 10 * CIPHER_BANNER_SNOOZE_MS }),
    false,
  );
});

test("stored timestamps must be positive whole numbers", () => {
  assert.equal(parseStoredTime("1800000000000"), 1_800_000_000_000);
  for (const raw of [
    null,
    undefined,
    "",
    "0",
    "-5",
    "1.5",
    "abc",
    "1e9",
    " 12",
  ]) {
    assert.equal(parseStoredTime(raw), undefined, String(raw));
  }
  assert.equal(parseStoredTime("9".repeat(30)), undefined);
});

test("versions map to their release", () => {
  assert.equal(releaseOf("0.69.0"), "0.69");
  assert.equal(releaseOf("0.69.3"), "0.69");
  assert.equal(releaseOf("0.69"), "0.69");
  assert.equal(releaseOf("0.69.0-rc.1"), "0.69");
  assert.equal(releaseOf("1.02.0"), "1.2");
  for (const v of ["", undefined, "v0.69.0", "latest", "0", "0.69.0.1"]) {
    assert.equal(releaseOf(v), undefined, String(v));
  }
});

test("What's New shows in its own release until dismissed", () => {
  const card = (appVersion: string, dismissed?: string | null) =>
    showWhatsNew({ appVersion, highlightsRelease: "0.69", dismissed });
  assert.equal(card("0.69.0"), true);
  assert.equal(card("0.69.2", null), true);
  assert.equal(card("0.69.0", "0.68"), true);
  assert.equal(card("0.69.1", "0.69"), false);
  assert.equal(card("0.68.0"), false);
  assert.equal(card("0.70.0"), false);
  assert.equal(card("garbage"), false);
});

test("the welcome tiles are for accounts with no servers or no friends", () => {
  assert.equal(isNewUser(0, 0), true);
  assert.equal(isNewUser(0, 4), true);
  assert.equal(isNewUser(3, 0), true);
  assert.equal(isNewUser(3, 4), false);
});

test("a tile is about the first live channel, else the first channel", () => {
  const a = { platform: "Twitch" };
  const b = { platform: "YouTube", live: true };
  const c = { platform: "Kick", live: true };
  assert.equal(primaryConnection([a, b, c]), b);
  assert.equal(primaryConnection([a, { platform: "Kick", live: false }]), a);
  assert.equal(primaryConnection([]), undefined);
  assert.equal(primaryConnection(undefined), undefined);
});

test("no thumbnail field means no back face", () => {
  assert.equal(streamThumbnail(undefined), undefined);
  assert.equal(streamThumbnail({ platform: "Twitch", live: true }), undefined);
});

test("thumbnails load only from platform CDNs over https while live", () => {
  const live = (live_thumbnail: unknown, live = true) =>
    streamThumbnail({ platform: "Twitch", live, live_thumbnail });

  assert.equal(
    live("https://static-cdn.jtvnw.net/previews-ttv/live_user_x-440x248.jpg"),
    "https://static-cdn.jtvnw.net/previews-ttv/live_user_x-440x248.jpg",
  );
  assert.equal(
    live("https://i.ytimg.com/vi/abc/hqdefault_live.jpg"),
    "https://i.ytimg.com/vi/abc/hqdefault_live.jpg",
  );
  assert.equal(
    live("https://static-cdn.jtvnw.net/x.jpg", false),
    undefined,
    "offline",
  );

  for (const bad of [
    "http://static-cdn.jtvnw.net/x.jpg",
    "https://evil.example/x.jpg",
    "https://static-cdn.jtvnw.net.evil.example/x.jpg",
    "https://user:pw@static-cdn.jtvnw.net/x.jpg",
    "https://static-cdn.jtvnw.net:8443/x.jpg",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "//static-cdn.jtvnw.net/x.jpg",
    "not a url",
    "https://static-cdn.jtvnw.net/" + "a".repeat(2100),
    42,
    null,
    {},
  ]) {
    assert.equal(live(bad), undefined, String(bad).slice(0, 60));
  }
});
