// Specs for the channel noun helper (post / thread / channel) — run with
// Node's built-in runner:
//   node --conditions=browser --test components/common/lib/channelNoun.test.ts
//
// All specs are pure. `channelNounOf` is fed plain objects shaped like the
// three stoat.js fields it reads, so no Client is constructed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Channel } from "stoat.js";

import { channelNoun, channelNounOf } from "./channelNoun.ts";

/**
 * Fake stoat.js channel exposing only what `channelNounOf` reads.
 * @param type Channel type
 * @param parentType Cached parent's type, or undefined for no cached parent
 * @param tagCount Number of applied forum tags
 */
function fakeChannel(
  type: string,
  parentType: string | undefined,
  tagCount: number,
): Channel {
  return {
    type,
    parent: parentType === undefined ? undefined : { type: parentType },
    appliedTags: Array.from({ length: tagCount }, (_, i) => `tag${i}`),
  } as unknown as Channel;
}

describe("channelNoun", () => {
  it("calls every non-thread type a channel", () => {
    for (const type of [
      "TextChannel",
      "Forum",
      "Group",
      "DirectMessage",
      "SavedMessages",
    ]) {
      assert.equal(channelNoun({ type, appliedTagCount: 0 }), "channel", type);
    }
  });

  it("ignores parent and tags on a non-thread type", () => {
    assert.equal(
      channelNoun({
        type: "TextChannel",
        parentType: "Forum",
        appliedTagCount: 3,
      }),
      "channel",
    );
    assert.equal(channelNoun({ type: "Forum", appliedTagCount: 2 }), "channel");
  });

  it("calls a thread under a cached forum parent a post", () => {
    assert.equal(
      channelNoun({ type: "Thread", parentType: "Forum", appliedTagCount: 0 }),
      "post",
    );
    assert.equal(
      channelNoun({ type: "Thread", parentType: "Forum", appliedTagCount: 2 }),
      "post",
    );
  });

  it("lets a cached text parent win over applied tags", () => {
    assert.equal(
      channelNoun({
        type: "Thread",
        parentType: "TextChannel",
        appliedTagCount: 0,
      }),
      "thread",
    );
    assert.equal(
      channelNoun({
        type: "Thread",
        parentType: "TextChannel",
        appliedTagCount: 3,
      }),
      "thread",
    );
  });

  it("calls an orphan thread with tags a post", () => {
    assert.equal(channelNoun({ type: "Thread", appliedTagCount: 1 }), "post");
    assert.equal(channelNoun({ type: "Thread", appliedTagCount: 5 }), "post");
  });

  it("calls an orphan thread without tags a thread", () => {
    assert.equal(channelNoun({ type: "Thread", appliedTagCount: 0 }), "thread");
  });
});

describe("channelNounOf", () => {
  it("calls non-thread channels a channel", () => {
    for (const type of ["TextChannel", "Forum", "Group", "DirectMessage"]) {
      assert.equal(channelNounOf(fakeChannel(type, undefined, 0)), "channel");
    }
  });

  it("reads the cached parent's type", () => {
    assert.equal(channelNounOf(fakeChannel("Thread", "Forum", 0)), "post");
    assert.equal(
      channelNounOf(fakeChannel("Thread", "TextChannel", 2)),
      "thread",
    );
  });

  it("falls back to the applied tag count with no cached parent", () => {
    assert.equal(channelNounOf(fakeChannel("Thread", undefined, 1)), "post");
    assert.equal(channelNounOf(fakeChannel("Thread", undefined, 0)), "thread");
  });
});
