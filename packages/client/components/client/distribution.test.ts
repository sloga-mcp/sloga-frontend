// Unit spec for the distribution-channel decision — run with Node's built-in
// runner:
//   node --conditions=browser --test components/client/distribution.test.ts
// Focus: iOS must resolve to the App Store whatever the plugin says (it has no
// AppFlavor plugin, and a missing plugin otherwise reads as a sideload APK),
// and Android must fail closed to Play for anything but an explicit sideload
// or foss.
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveChannel } from "./distribution.ts";

test("the browser is web", () => {
  assert.equal(
    resolveChannel({ native: false, platform: "web", pluginAvailable: false }),
    "web",
  );
  assert.equal(
    resolveChannel({
      native: false,
      platform: "web",
      pluginAvailable: false,
      reported: "sideload",
    }),
    "web",
  );
});

test("iOS is the App Store without the plugin", () => {
  assert.equal(
    resolveChannel({ native: true, platform: "ios", pluginAvailable: false }),
    "appstore",
  );
});

test("iOS is the App Store with the plugin and any reported value", () => {
  for (const reported of [
    undefined,
    "sideload",
    "play",
    "fdroid",
    "foss",
    "",
  ]) {
    for (const pluginAvailable of [true, false]) {
      assert.equal(
        resolveChannel({
          native: true,
          platform: "ios",
          pluginAvailable,
          reported,
        }),
        "appstore",
        `reported=${String(reported)} plugin=${pluginAvailable}`,
      );
    }
  }
});

test("Android without the plugin is a pre-split sideload APK", () => {
  assert.equal(
    resolveChannel({
      native: true,
      platform: "android",
      pluginAvailable: false,
    }),
    "sideload",
  );
});

test("Android without the plugin is sideload whatever it reports", () => {
  assert.equal(
    resolveChannel({
      native: true,
      platform: "android",
      pluginAvailable: false,
      reported: "foss",
    }),
    "sideload",
  );
});

test("Android reporting sideload is sideload", () => {
  assert.equal(
    resolveChannel({
      native: true,
      platform: "android",
      pluginAvailable: true,
      reported: "sideload",
    }),
    "sideload",
  );
});

test("Android reporting foss is foss", () => {
  assert.equal(
    resolveChannel({
      native: true,
      platform: "android",
      pluginAvailable: true,
      reported: "foss",
    }),
    "foss",
  );
});

test("Android fails closed to Play for anything else", () => {
  for (const reported of [
    undefined,
    "play",
    "fdroid",
    "Sideload",
    "Foss",
    "",
  ]) {
    assert.equal(
      resolveChannel({
        native: true,
        platform: "android",
        pluginAvailable: true,
        reported,
      }),
      "play",
      `reported=${String(reported)}`,
    );
  }
});
