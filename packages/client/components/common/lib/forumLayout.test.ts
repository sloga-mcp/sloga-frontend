// Specs for the forum layout helpers (menu order, validation, resolution
// order, settings cleaning, reply detection) — run with Node's built-in
// runner:
//   node --conditions=browser --test components/common/lib/forumLayout.test.ts
//
// All specs are pure. The module imports stoat.js for types only, so no
// Client is constructed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type ForumLayout,
  cleanLayoutOverrides,
  FORUM_LAYOUTS,
  hasReplies,
  isForumLayout,
  resolveLayout,
} from "./forumLayout.ts";

/**
 * A layout name this client cannot render, smuggled past the type checker the
 * way a stale settings blob or a newer server would.
 * @param value Unknown layout name
 */
function junk(value: string): ForumLayout {
  return value as ForumLayout;
}

describe("FORUM_LAYOUTS", () => {
  it("lists every layout in menu order", () => {
    assert.deepEqual([...FORUM_LAYOUTS], ["Modern", "Classic", "ClassicPlus"]);
  });
});

describe("isForumLayout", () => {
  it("accepts each of the three layouts", () => {
    for (const layout of ["Modern", "Classic", "ClassicPlus"]) {
      assert.equal(isForumLayout(layout), true, layout);
    }
  });

  it("rejects case variants and near misses", () => {
    for (const value of [
      "modern",
      "MODERN",
      "classic",
      "classicplus",
      "CLASSICPLUS",
      "Classic+",
      "Classic Plus",
      " Modern",
      "Modern ",
      "",
    ]) {
      assert.equal(isForumLayout(value), false, JSON.stringify(value));
    }
  });

  it("rejects non-strings", () => {
    for (const value of [
      undefined,
      null,
      0,
      1,
      true,
      {},
      [],
      ["Modern"],
      { toString: () => "Modern" },
      new String("Modern"),
      Symbol("Modern"),
    ]) {
      assert.equal(isForumLayout(value), false, String(value));
    }
  });
});

describe("resolveLayout", () => {
  it("prefers the personal override over the forum default", () => {
    assert.equal(resolveLayout("Classic", "ClassicPlus"), "Classic");
    assert.equal(resolveLayout("Modern", "Classic"), "Modern");
    assert.equal(resolveLayout("ClassicPlus", "Modern"), "ClassicPlus");
  });

  it("uses the override alone when the forum default is unknown", () => {
    assert.equal(resolveLayout("ClassicPlus", undefined), "ClassicPlus");
    assert.equal(resolveLayout("ClassicPlus"), "ClassicPlus");
  });

  it("falls back to the forum default when there is no override", () => {
    assert.equal(resolveLayout(undefined, "Classic"), "Classic");
    assert.equal(resolveLayout(undefined, "ClassicPlus"), "ClassicPlus");
  });

  it("skips a stale override string in favor of the forum default", () => {
    assert.equal(resolveLayout(junk("Grid"), "ClassicPlus"), "ClassicPlus");
    assert.equal(resolveLayout(junk("classic"), "ClassicPlus"), "ClassicPlus");
    assert.equal(resolveLayout(junk(""), "Classic"), "Classic");
  });

  it("falls back to Modern when the forum default is stale", () => {
    assert.equal(resolveLayout(undefined, junk("Gallery")), "Modern");
    assert.equal(resolveLayout(junk("Grid"), junk("Gallery")), "Modern");
  });

  it("falls back to Modern when both are undefined", () => {
    assert.equal(resolveLayout(), "Modern");
    assert.equal(resolveLayout(undefined, undefined), "Modern");
  });

  it("never returns a value outside FORUM_LAYOUTS", () => {
    const inputs: (ForumLayout | undefined)[] = [
      undefined,
      junk("Grid"),
      junk(""),
      ...FORUM_LAYOUTS,
    ];
    for (const override of inputs) {
      for (const forumDefault of inputs) {
        const layout = resolveLayout(override, forumDefault);
        assert.ok(
          FORUM_LAYOUTS.includes(layout),
          `${String(override)} / ${String(forumDefault)} -> ${layout}`,
        );
      }
    }
  });
});

describe("cleanLayoutOverrides", () => {
  it("keeps every valid entry", () => {
    assert.deepEqual(
      cleanLayoutOverrides({
        forumA: "Modern",
        forumB: "Classic",
        forumC: "ClassicPlus",
      }),
      { forumA: "Modern", forumB: "Classic", forumC: "ClassicPlus" },
    );
  });

  it("drops entries whose value is not a layout", () => {
    assert.deepEqual(
      cleanLayoutOverrides({
        good: "Classic",
        lower: "classic",
        plus: "Classic+",
        empty: "",
        nil: null,
        num: 1,
        obj: { layout: "Modern" },
        arr: ["Modern"],
        bool: true,
      }),
      { good: "Classic" },
    );
  });

  it("returns {} for null, arrays and primitives", () => {
    for (const value of [
      undefined,
      null,
      [],
      ["Modern"],
      [["forumA", "Modern"]],
      "Modern",
      "",
      0,
      42,
      true,
      false,
    ]) {
      assert.deepEqual(cleanLayoutOverrides(value), {}, JSON.stringify(value));
    }
  });

  it("ignores keys inherited from a prototype", () => {
    const value = Object.create({ inherited: "Classic" }) as Record<
      string,
      unknown
    >;
    value.own = "ClassicPlus";

    const cleaned = cleanLayoutOverrides(value);
    assert.deepEqual(cleaned, { own: "ClassicPlus" });
    assert.equal(Object.hasOwn(cleaned, "inherited"), false);
    assert.equal(cleaned.inherited, undefined);
  });

  it("skips an own __proto__ key without polluting Object.prototype", () => {
    const parsed: unknown = JSON.parse(
      '{"__proto__": {"polluted": "Classic"}, "forumA": "Modern"}',
    );
    // JSON.parse stores __proto__ as a plain own key, never the prototype
    assert.equal(Object.hasOwn(parsed as object, "__proto__"), true);

    const cleaned = cleanLayoutOverrides(parsed);
    assert.deepEqual(cleaned, { forumA: "Modern" });
    assert.equal(Object.getPrototypeOf(cleaned), Object.prototype);
    assert.equal(Object.hasOwn(cleaned, "__proto__"), false);
    assert.equal(
      (cleaned as Record<string, unknown>).polluted,
      undefined,
      "cleaned object inherits nothing new",
    );
    assert.equal(
      ({} as Record<string, unknown>).polluted,
      undefined,
      "Object.prototype untouched",
    );
  });

  it("skips an own __proto__ key even when its value is a layout", () => {
    const parsed: unknown = JSON.parse(
      '{"__proto__": "Classic", "forumA": "ClassicPlus"}',
    );

    const cleaned = cleanLayoutOverrides(parsed);
    assert.deepEqual(cleaned, { forumA: "ClassicPlus" });
    assert.equal(Object.hasOwn(cleaned, "__proto__"), false);
  });

  it("returns a fresh object, never the input", () => {
    const input = { forumA: "Classic" };

    const cleaned = cleanLayoutOverrides(input);
    assert.notEqual(cleaned, input);
    assert.deepEqual(cleaned, input);

    cleaned.forumB = "Modern";
    assert.deepEqual(input, { forumA: "Classic" });
  });

  it("returns a distinct {} on each call", () => {
    const first = cleanLayoutOverrides(null);
    const second = cleanLayoutOverrides(null);
    assert.notEqual(first, second);
  });
});

describe("hasReplies", () => {
  it("is false when lastMessageId is missing", () => {
    assert.equal(hasReplies({ id: "post1" }), false);
    assert.equal(hasReplies({ id: "post1", lastMessageId: undefined }), false);
  });

  it("is false when lastMessageId is empty", () => {
    assert.equal(hasReplies({ id: "post1", lastMessageId: "" }), false);
  });

  it("is false when the last message is the starter", () => {
    assert.equal(hasReplies({ id: "post1", lastMessageId: "post1" }), false);
  });

  it("is true when the last message is any other message", () => {
    assert.equal(hasReplies({ id: "post1", lastMessageId: "reply1" }), true);
    assert.equal(hasReplies({ id: "post1", lastMessageId: "post2" }), true);
  });
});
