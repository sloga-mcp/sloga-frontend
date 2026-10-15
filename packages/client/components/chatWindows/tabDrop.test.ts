/**
 * Run with:
 *
 *     node --test --conditions=browser components/chatWindows/tabDrop.test.ts
 *
 * The tab strip's drag-and-drop decisions (plan D7): which drags a strip
 * accepts, which drops move a tab, how long a drag stays reported, the drop
 * slot, and when a drag tears a tab off into a new window.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { DRAG_CLOSE_MAX_DEFER_MS } from "./hostPlan.ts";
import {
  DROPPED_DRAG_TTL_MS,
  TAB_DRAG_PREFIX,
  acceptsTabDrag,
  beginTabDrag,
  dropIndex,
  droppedTab,
  endTabDrag,
  endTabDragOnRemoval,
  insideAnyWindow,
  markTabDropped,
  parseTabDragPayload,
  tabDragLive,
  tabDragPayload,
  tabDragSource,
  tearOffAt,
} from "./tabDrop.ts";

afterEach(() => endTabDrag());

describe("payload", () => {
  it("round-trips a channel id", () => {
    assert.equal(tabDragPayload("01ABC"), "sloga-tab:01ABC");
    assert.equal(parseTabDragPayload(tabDragPayload("01ABC")), "01ABC");
  });

  it("rejects anything that is not a tab payload", () => {
    for (const text of [
      undefined,
      null,
      42,
      "",
      "01ABC",
      "sloga-tab:",
      "Sloga-tab:01ABC",
      " sloga-tab:01ABC",
      "sloga-tab:01 ABC",
      "sloga-tab:01ABC\n",
      TAB_DRAG_PREFIX + "x".repeat(129),
    ]) {
      assert.equal(parseTabDragPayload(text), null, String(text));
    }
    assert.equal(
      parseTabDragPayload(TAB_DRAG_PREFIX + "x".repeat(128)),
      "x".repeat(128),
    );
  });
});

describe("drag source", () => {
  it("records, reads and forgets the drag", () => {
    assert.equal(tabDragSource(), null);
    beginTabDrag("c1", "w-1");
    assert.deepEqual(tabDragSource(), { channelId: "c1", windowId: "w-1" });
    endTabDrag("c1");
    assert.equal(tabDragSource(), null);
  });

  it("a late dragend for an older drag leaves a newer one alone", () => {
    beginTabDrag("c1", "w-1");
    beginTabDrag("c2", "w-2");
    endTabDrag("c1");
    assert.deepEqual(tabDragSource(), { channelId: "c2", windowId: "w-2" });
    endTabDrag();
    assert.equal(tabDragSource(), null);
  });
});

describe("acceptsTabDrag (dragover)", () => {
  it("refuses every drag while no tab drag is recorded", () => {
    assert.equal(acceptsTabDrag(["text/plain"]), false);
    assert.equal(acceptsTabDrag(["text/plain", "text/html"]), false);
  });

  it("accepts a text drag while a tab drag is recorded", () => {
    beginTabDrag("c1", "w-1");
    assert.equal(acceptsTabDrag(["text/plain"]), true);
    assert.equal(acceptsTabDrag(["text/html", "text/plain"]), true);
  });

  it("refuses files, other types and no types even mid-drag", () => {
    beginTabDrag("c1", "w-1");
    assert.equal(acceptsTabDrag(["Files"]), false);
    assert.equal(acceptsTabDrag(["text/uri-list"]), false);
    assert.equal(acceptsTabDrag([]), false);
    assert.equal(acceptsTabDrag(null), false);
    assert.equal(acceptsTabDrag(undefined), false);
  });

  it("reads a DOMStringList-like types object", () => {
    beginTabDrag("c1", "w-1");
    const list = { 0: "text/plain", length: 1 } as ArrayLike<string>;
    assert.equal(acceptsTabDrag(list), true);
  });
});

describe("droppedTab (drop)", () => {
  it("moves the tab the payload and the source both name", () => {
    beginTabDrag("c1", "w-1");
    assert.equal(droppedTab(tabDragPayload("c1")), "c1");
  });

  it("ignores a payload with no drag recorded (another app or instance)", () => {
    assert.equal(droppedTab(tabDragPayload("c1")), null);
  });

  it("ignores a payload naming a different tab than the source", () => {
    beginTabDrag("c1", "w-1");
    assert.equal(droppedTab(tabDragPayload("c2")), null);
  });

  it("ignores plain text mid-drag", () => {
    beginTabDrag("c1", "w-1");
    assert.equal(droppedTab("c1"), null);
    assert.equal(droppedTab(""), null);
    assert.equal(droppedTab(undefined), null);
  });
});

describe("drop mark (drop taken, dragend still to come)", () => {
  it("keeps reporting the source but accepts and moves nothing more", () => {
    beginTabDrag("c1", "w-1");
    assert.equal(tabDragLive(), true);
    assert.equal(markTabDropped("c1", 1000), true);

    // The host still sees the drag, so the emptied source window stays
    assert.deepEqual(tabDragSource(1000), { channelId: "c1", windowId: "w-1" });
    assert.equal(tabDragLive(), false);
    assert.equal(acceptsTabDrag(["text/plain"]), false);
    assert.equal(droppedTab(tabDragPayload("c1")), null);
  });

  it("marks only the live drag it names, once", () => {
    assert.equal(markTabDropped("c1", 1000), false);
    beginTabDrag("c1", "w-1");
    assert.equal(markTabDropped("c2", 1000), false);
    assert.equal(tabDragLive(), true);
    assert.equal(markTabDropped("c1", 1000), true);
    assert.equal(markTabDropped("c1", 1001), false);
  });

  it("the source tab's dragend ends a dropped drag", () => {
    beginTabDrag("c1", "w-1");
    markTabDropped("c1", 1000);
    endTabDrag("c1");
    assert.equal(tabDragSource(1000), null);
    assert.equal(tabDragLive(), false);
  });

  it("a late dragend of an older drag leaves a newer live one alone", () => {
    beginTabDrag("c1", "w-1");
    markTabDropped("c1", 1000);
    beginTabDrag("c2", "w-2");
    assert.equal(tabDragLive(), true);
    endTabDrag("c1");
    assert.deepEqual(tabDragSource(1000), { channelId: "c2", windowId: "w-2" });
    assert.equal(acceptsTabDrag(["text/plain"]), true);
    assert.equal(droppedTab(tabDragPayload("c2")), "c2");
  });

  it("a new drag replaces a dropped one whose dragend never came", () => {
    beginTabDrag("c1", "w-1");
    markTabDropped("c1", 1000);
    beginTabDrag("c1", "w-2");
    assert.equal(tabDragLive(), true);
    assert.equal(acceptsTabDrag(["text/plain"]), true);
    assert.deepEqual(tabDragSource(1000), { channelId: "c1", windowId: "w-2" });
  });

  it("a dropped drag is reported for DROPPED_DRAG_TTL_MS at most", () => {
    beginTabDrag("c1", "w-1");
    markTabDropped("c1", 1000);
    assert.notEqual(tabDragSource(1000 + DROPPED_DRAG_TTL_MS - 1), null);
    assert.equal(tabDragSource(1000 + DROPPED_DRAG_TTL_MS), null);
    // Expired for good, not just hidden at that instant
    assert.equal(tabDragSource(1000), null);
    assert.equal(markTabDropped("c1", 1000), false);
  });

  it("a live drag never expires (the pointer may be held down)", () => {
    beginTabDrag("c1", "w-1");
    assert.notEqual(tabDragSource(Number.MAX_SAFE_INTEGER), null);
    assert.equal(tabDragLive(), true);
  });

  it("expires before the host stops waiting for the drag on its own", () => {
    assert.ok(DROPPED_DRAG_TTL_MS > 0);
    assert.ok(DROPPED_DRAG_TTL_MS < DRAG_CLOSE_MAX_DEFER_MS);
  });
});

describe("endTabDragOnRemoval (tab cleanup)", () => {
  it("a tab closed mid-drag ends the drag", () => {
    beginTabDrag("c1", "w-1");
    endTabDragOnRemoval("c1", false);
    assert.equal(tabDragSource(), null);
    assert.equal(acceptsTabDrag(["text/plain"]), false);
  });

  it("a tab gone with its window before any drop ends the drag", () => {
    beginTabDrag("c1", "w-1");
    endTabDragOnRemoval("c1", true);
    assert.equal(tabDragSource(), null);
  });

  it("a tab the drop moved keeps the drag until its dragend", () => {
    beginTabDrag("c1", "w-1");
    markTabDropped("c1", 1000);
    endTabDragOnRemoval("c1", true);
    assert.deepEqual(tabDragSource(1000), { channelId: "c1", windowId: "w-1" });
    assert.equal(tabDragLive(), false);
    endTabDrag("c1");
    assert.equal(tabDragSource(1000), null);
  });

  it("a dropped tab closed before its dragend ends the drag", () => {
    beginTabDrag("c1", "w-1");
    markTabDropped("c1", 1000);
    endTabDragOnRemoval("c1", false);
    assert.equal(tabDragSource(1000), null);
  });

  it("another tab leaving its strip does not touch the drag", () => {
    beginTabDrag("c1", "w-1");
    endTabDragOnRemoval("c2", false);
    assert.deepEqual(tabDragSource(), { channelId: "c1", windowId: "w-1" });
    assert.equal(tabDragLive(), true);
  });
});

describe("dropIndex", () => {
  // Three 100px tabs from x = 10: middles at 60, 160, 260.
  const tabs = [
    { left: 10, width: 100 },
    { left: 110, width: 100 },
    { left: 210, width: 100 },
  ];

  it("lands before the first tab whose middle is right of x", () => {
    assert.equal(dropIndex(tabs, 0), 0);
    assert.equal(dropIndex(tabs, 59), 0);
    assert.equal(dropIndex(tabs, 60), 1);
    assert.equal(dropIndex(tabs, 159), 1);
    assert.equal(dropIndex(tabs, 160), 2);
    assert.equal(dropIndex(tabs, 259), 2);
  });

  it("lands at the end past the last middle", () => {
    assert.equal(dropIndex(tabs, 260), 3);
    assert.equal(dropIndex(tabs, 5000), 3);
  });

  it("an empty strip or a bad x lands at the end", () => {
    assert.equal(dropIndex([], 50), 0);
    assert.equal(dropIndex(tabs, Number.NaN), 3);
    assert.equal(dropIndex(tabs, Number.POSITIVE_INFINITY), 3);
  });
});

describe("tearOffAt (dragend)", () => {
  // Main at (0,0) 1200x800; a chat window at (1300,100) 600x500.
  const main = { left: 0, top: 0, width: 1200, height: 800 };
  const chat = { left: 1300, top: 100, width: 600, height: 500 };
  const windows = [main, chat];

  it("tears off only when nothing accepted the drop", () => {
    assert.deepEqual(tearOffAt("none", 2500, 300, windows), {
      left: 2460,
      top: 280,
    });
    for (const effect of ["move", "copy", "link", undefined, null]) {
      assert.equal(tearOffAt(effect, 2500, 300, windows), null, String(effect));
    }
  });

  it("released inside the main window: no tear-off (Escape, refused drop)", () => {
    assert.equal(tearOffAt("none", 500, 300, windows), null);
    assert.equal(tearOffAt("none", 0, 0, windows), null);
    assert.equal(tearOffAt("none", 1199, 799, windows), null);
  });

  it("released inside a chat window: no tear-off", () => {
    assert.equal(tearOffAt("none", 1300, 100, windows), null);
    assert.equal(tearOffAt("none", 1600, 400, windows), null);
  });

  it("released outside every window: tears off", () => {
    // Right of main's right edge, in the gap before the chat window
    assert.deepEqual(tearOffAt("none", 1200, 300, windows), {
      left: 1160,
      top: 280,
    });
    // Below the chat window
    assert.deepEqual(tearOffAt("none", 1600, 600, windows), {
      left: 1560,
      top: 580,
    });
    // No windows known at all
    assert.deepEqual(tearOffAt("none", 500, 300, []), { left: 460, top: 280 });
  });

  it("rounds fractional screen coordinates", () => {
    assert.deepEqual(tearOffAt("none", 2500.6, 300.2, windows), {
      left: 2461,
      top: 280,
    });
  });

  it("keeps negative positions (a monitor left of or above the primary)", () => {
    assert.deepEqual(tearOffAt("none", -1000, -50, windows), {
      left: -1040,
      top: -70,
    });
  });

  it("refuses non-finite coordinates", () => {
    assert.equal(tearOffAt("none", Number.NaN, 300, []), null);
    assert.equal(tearOffAt("none", 500, Number.POSITIVE_INFINITY, []), null);
  });
});

describe("insideAnyWindow", () => {
  const rect = { left: 10, top: 20, width: 100, height: 50 };

  it("is inclusive at the top-left edge and exclusive at the bottom-right", () => {
    assert.equal(insideAnyWindow(10, 20, [rect]), true);
    assert.equal(insideAnyWindow(109, 69, [rect]), true);
    assert.equal(insideAnyWindow(110, 40, [rect]), false);
    assert.equal(insideAnyWindow(50, 70, [rect]), false);
    assert.equal(insideAnyWindow(9, 40, [rect]), false);
  });

  it("an empty or non-finite rect covers nothing", () => {
    for (const bad of [
      { ...rect, width: 0 },
      { ...rect, height: -5 },
      { ...rect, left: Number.NaN },
      { ...rect, width: Number.POSITIVE_INFINITY },
    ]) {
      assert.equal(insideAnyWindow(50, 40, [bad]), false, JSON.stringify(bad));
    }
  });
});
