import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type HomeBlockId,
  type TypeHomeLayout,
  applyDrop,
  cleanHomeLayout,
  DEFAULT_COLUMN,
  defaultHomeLayout,
  HOME_BLOCKS,
  mergeVisibleOrder,
  moveBlock,
  setBlockHidden,
  shownBlocks,
} from "./homeLayoutRules.ts";

const all = new Set<HomeBlockId>(HOME_BLOCKS);

describe("cleanHomeLayout", () => {
  it("gives the default layout for nothing usable", () => {
    for (const input of [undefined, null, 1, "x", [], {}, { main: "x" }]) {
      assert.deepEqual(cleanHomeLayout(input), defaultHomeLayout());
    }
  });

  it("puts every card in exactly one column", () => {
    const layout = defaultHomeLayout();
    const placed = [...layout.main, ...layout.side];
    assert.equal(placed.length, HOME_BLOCKS.length);
    assert.equal(new Set(placed).size, HOME_BLOCKS.length);
    for (const id of layout.side) assert.equal(DEFAULT_COLUMN[id], "side");
  });

  it("drops unknown ids, prototype names and duplicates; first place wins", () => {
    const clean = cleanHomeLayout({
      main: ["friends", "nope", "__proto__", "toString", "friends", 7],
      side: ["friends", "unread"],
      hidden: ["unread", "unread", "constructor"],
    });
    assert.equal(clean.main[0], "friends");
    assert.equal(clean.main.filter((id) => id === "friends").length, 1);
    assert.ok(!clean.main.includes("unread"));
    assert.deepEqual(clean.side.slice(0, 1), ["unread"]);
    assert.deepEqual(clean.hidden, ["unread"]);
  });

  it("appends cards missing from both columns to their default column", () => {
    const clean = cleanHomeLayout({ main: ["import"], side: ["happening"] });
    assert.deepEqual(clean.main[0], "import");
    assert.deepEqual(clean.side[0], "happening");
    // the rest follow in catalogue order
    assert.deepEqual(
      clean.main.slice(1),
      HOME_BLOCKS.filter(
        (id) => DEFAULT_COLUMN[id] === "main" && id !== "happening",
      ),
    );
  });

  it("is a fixed point", () => {
    const inputs: unknown[] = [
      undefined,
      { main: ["friends", "nope"], side: ["unread", "friends"], hidden: ["x"] },
      { main: [], side: [], hidden: ["staff", "staff"] },
      defaultHomeLayout(),
    ];
    for (const input of inputs) {
      const once = cleanHomeLayout(input);
      assert.deepEqual(cleanHomeLayout(once), once);
    }
  });

  it("only scans a bounded number of entries", () => {
    const flood = Array.from({ length: 100_000 }, () => "nope");
    flood.push("friends");
    const clean = cleanHomeLayout({ main: flood });
    // "friends" sat past the scan limit, so it lands in its default column
    assert.ok(clean.side.includes("friends"));
  });
});

describe("shownBlocks", () => {
  it("leaves out hidden and unavailable cards, keeping order", () => {
    const layout: TypeHomeLayout = {
      ...defaultHomeLayout(),
      hidden: ["mentions"],
    };
    const shown = shownBlocks(layout, "main", (id) => id !== "cipher");
    assert.ok(!shown.includes("mentions"));
    assert.ok(!shown.includes("cipher"));
    assert.deepEqual(
      shown,
      layout.main.filter((id) => id !== "mentions" && id !== "cipher"),
    );
  });
});

describe("mergeVisibleOrder", () => {
  it("keeps undrawn cards right after the drawn card they followed", () => {
    const column: HomeBlockId[] = ["welcome", "happening", "cipher", "unread"];
    const shown = new Set<HomeBlockId>(["happening", "unread"]);
    assert.deepEqual(
      mergeVisibleOrder(column, ["unread", "happening"], shown),
      ["welcome", "unread", "happening", "cipher"],
    );
  });

  it("re-anchors undrawn cards whose anchor left the column", () => {
    const column: HomeBlockId[] = ["happening", "cipher", "unread"];
    const shown = new Set<HomeBlockId>(["happening", "unread"]);
    assert.deepEqual(mergeVisibleOrder(column, ["unread"], shown), [
      "cipher",
      "unread",
    ]);
  });
});

describe("applyDrop", () => {
  it("moves a card between columns whichever drop is reported first", () => {
    const start = defaultHomeLayout();
    const shown = all;
    const mainAfter = start.main.filter((id) => id !== "happening");
    const sideAfter = ["happening", ...start.side];

    const sideFirst = applyDrop(
      applyDrop(start, "side", sideAfter, shown),
      "main",
      mainAfter,
      shown,
    );
    const mainFirst = applyDrop(
      applyDrop(start, "main", mainAfter, shown),
      "side",
      sideAfter,
      shown,
    );

    for (const result of [sideFirst, mainFirst]) {
      assert.deepEqual(result.main, mainAfter);
      assert.deepEqual(result.side, sideAfter);
      assert.deepEqual(cleanHomeLayout(result), result);
    }
  });

  it("between the two drops nothing is duplicated, and clean repairs a lost card", () => {
    const start = defaultHomeLayout();
    const half = applyDrop(
      start,
      "main",
      start.main.filter((id) => id !== "happening"),
      all,
    );
    const placed = [...half.main, ...half.side];
    assert.equal(new Set(placed).size, placed.length);
    assert.ok(!placed.includes("happening"));
    assert.ok(cleanHomeLayout(half).main.includes("happening"));
  });

  it("gives the same result when the layout is cleaned after each drop", () => {
    // the store cleans after every drop; both report orders must still agree
    for (const [id, from] of [
      ["happening", "main"],
      ["friends", "side"],
    ] as const) {
      const start = defaultHomeLayout();
      const to = from === "main" ? "side" : "main";
      const fromAfter = start[from].filter((entry) => entry !== id);
      const toAfter = [start[to][0], id, ...start[to].slice(1)];

      const step = (
        layout: TypeHomeLayout,
        column: "main" | "side",
        ids: string[],
      ) => cleanHomeLayout(applyDrop(layout, column, ids, all));

      const originFirst = step(step(start, from, fromAfter), to, toAfter);
      const targetFirst = step(step(start, to, toAfter), from, fromAfter);

      for (const result of [originFirst, targetFirst]) {
        assert.deepEqual(result[from], fromAfter);
        assert.deepEqual(result[to], toAfter);
      }
    }
  });

  it("ignores unknown ids in a drop", () => {
    const start = defaultHomeLayout();
    const result = applyDrop(start, "side", ["nope", ...start.side], all);
    assert.deepEqual(result.side, start.side);
  });
});

describe("moveBlock", () => {
  const layout: TypeHomeLayout = {
    main: ["happening", "cipher", "unread", "mentions"],
    side: ["friends"],
    hidden: [],
  };
  const shown = new Set<HomeBlockId>([
    "happening",
    "unread",
    "mentions",
    "friends",
  ]);

  it("steps over undrawn cards", () => {
    assert.deepEqual(moveBlock(layout, "unread", "up", shown).main, [
      "unread",
      "happening",
      "cipher",
      "mentions",
    ]);
    assert.deepEqual(moveBlock(layout, "happening", "down", shown).main, [
      "cipher",
      "unread",
      "happening",
      "mentions",
    ]);
  });

  it("does nothing at either end", () => {
    assert.equal(moveBlock(layout, "happening", "up", shown), layout);
    assert.equal(moveBlock(layout, "mentions", "down", shown), layout);
  });

  it("moves to the end of the other column", () => {
    const moved = moveBlock(layout, "unread", "other", shown);
    assert.deepEqual(moved.main, ["happening", "cipher", "mentions"]);
    assert.deepEqual(moved.side, ["friends", "unread"]);
  });
});

describe("setBlockHidden", () => {
  it("hides and unhides without touching the columns", () => {
    const start = defaultHomeLayout();
    const hidden = setBlockHidden(start, "discover", true);
    assert.deepEqual(hidden.hidden, ["discover"]);
    assert.deepEqual(hidden.main, start.main);
    assert.equal(setBlockHidden(hidden, "discover", true), hidden);
    assert.deepEqual(setBlockHidden(hidden, "discover", false).hidden, []);
  });
});
