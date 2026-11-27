/**
 * Run with:
 *
 *     node --conditions=browser --test components/app/interface/settings/_layout/searchMatch.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type SettingsSearchItem,
  findRanges,
  fold,
  searchSettings,
  splitByRanges,
} from "./searchMatch.ts";

const INDEX: SettingsSearchItem[] = [
  { page: "account", label: "Account Info", isPage: true },
  { page: "account", label: "Password" },
  { page: "account", label: "Authenticator App", keywords: "2fa mfa" },
  { page: "appearance", label: "Appearance", isPage: true, keywords: "theme" },
  { page: "appearance", label: "Dark" },
  { page: "appearance", label: "Show message timestamps" },
  { page: "voice", label: "Voice", isPage: true },
  { page: "voice", label: "Push to Talk" },
  { page: "voice", label: "Push to Talk Key" },
  { page: "video", label: "Video", isPage: true },
  { page: "video", label: "Camera Quality" },
];

describe("fold", () => {
  it("keeps the length of the input", () => {
    for (const text of ["Ünïcödé", "İstanbul", "Straße", "😀 emoji", "ÅÄÖ"]) {
      assert.equal(fold(text).length, text.length, text);
    }
  });

  it("lowercases and strips accents", () => {
    assert.equal(fold("Éclair"), "eclair");
    assert.equal(fold("Ünïcödé"), "unicode");
  });
});

describe("findRanges", () => {
  it("finds every occurrence and merges overlaps", () => {
    assert.deepEqual(findRanges("Push to Talk Key", ["t"]), [
      [5, 6],
      [8, 9],
    ]);
    assert.deepEqual(findRanges("aaaa", ["aa", "aaa"]), [[0, 4]]);
  });

  it("matches across case and accents", () => {
    assert.deepEqual(findRanges("Café Sounds", ["cafe"]), [[0, 4]]);
  });
});

describe("splitByRanges", () => {
  it("rebuilds the label exactly", () => {
    const label = "Show message timestamps";
    // "mes" also occurs inside "times", overlapping "time": one span
    const parts = splitByRanges(label, findRanges(label, ["mes", "time"]));
    assert.equal(parts.map((part) => part.text).join(""), label);
    assert.deepEqual(
      parts.filter((part) => part.hit).map((part) => part.text),
      ["mes", "times"],
    );
  });
});

describe("searchSettings", () => {
  it("returns nothing for an empty query", () => {
    assert.deepEqual(searchSettings(INDEX, "   "), []);
  });

  it("groups setting hits under their page", () => {
    const groups = searchSettings(INDEX, "push");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].page, "voice");
    assert.equal(groups[0].header?.label, "Voice");
    assert.deepEqual(
      groups[0].rows.map((row) => row.label),
      ["Push to Talk", "Push to Talk Key"],
    );
  });

  it("needs every word, from the label, page or keywords", () => {
    assert.deepEqual(
      searchSettings(INDEX, "voice key")[0].rows.map((row) => row.label),
      ["Push to Talk Key"],
    );
    assert.deepEqual(searchSettings(INDEX, "voice camera"), []);
  });

  it("finds hidden keywords without highlighting them", () => {
    const [group] = searchSettings(INDEX, "2fa");
    assert.equal(group.page, "account");
    assert.deepEqual(group.rows, [{ label: "Authenticator App", ranges: [] }]);
  });

  it("a page match shows the page with no rows", () => {
    const [group] = searchSettings(INDEX, "theme");
    assert.equal(group.page, "appearance");
    assert.deepEqual(group.rows, []);
  });

  it("skips pages the sidebar hides", () => {
    const groups = searchSettings(INDEX, "a", (page) => page !== "account");
    assert.ok(groups.every((group) => group.page !== "account"));
  });

  it("ranks a label that starts with the word first", () => {
    assert.equal(searchSettings(INDEX, "video")[0].page, "video");
    assert.equal(searchSettings(INDEX, "dark")[0].page, "appearance");
  });
});
