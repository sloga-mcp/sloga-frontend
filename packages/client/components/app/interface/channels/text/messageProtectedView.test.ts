// Spec for `messageProtectedView.ts` (S4 W4-3 lane U2, design 9.3 / 9.5):
// which body a Protected channel row shows, and the notes under a decrypted
// one. Every call uses the arguments `Message.tsx` passes: the bridge's
// view, whether this device runs the protected text plane, the SDK row, and
// whether the row is foreign to the list (fix lane FXU, audit A1).
//
// The last section covers the two R-W4-20 blocks this lane filled, in files
// Node cannot load: the composer's reply preview (`Composition.tsx`, read as
// text) and the toast tone (`NotificationsWorker.tsx`, its pure function run
// from a type-stripped copy).
//
// Run: node --conditions=browser --test \
//   components/app/interface/channels/text/messageProtectedView.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import { okViewNotes } from "../../../../client/protectedTextMessages.ts";
import {
  type ProtectedOkView,
  plainRenderable,
  protectedRowBody,
  protectedRowNotes,
  protectedRowScope,
  protectedViewClass,
  replyTargetShown,
} from "./messageProtectedView.ts";

/** A row the verified reveal restored: it has text and a file to leak. */
const FULL_ROW = {
  content: "server text",
  attachments: [{ _id: "file" }],
};

/** A stripped row: the reveal is gone, or never happened. */
const EMPTY_ROW = {};

function okView(over: Partial<ProtectedOkView> = {}): ProtectedOkView {
  return {
    status: "ok",
    text: "decrypted",
    replies: [],
    senderVerified: true,
    tsSkew: false,
    cid: "c",
    filesUnsupported: 0,
    timingUnverified: false,
    belowBoundary: false,
    historySender: false,
    ...over,
  };
}

/** Views that must never reach the ordinary path, with their label. */
const NEVER_ORDINARY: [string, unknown][] = [
  ["no view (null)", null],
  ["no view (undefined)", undefined],
  ["pending", { status: "pending" }],
  ["checking", { status: "checking" }],
  ["ok", okView()],
  ["marker", { status: "marker", kind: "unencrypted_row" }],
  ["marker without a kind", { status: "marker" }],
  ["an unknown status", { status: "weird" }],
  ["a near-miss of plain", { status: "Plain" }],
  ["a status that is not a string", { status: true }],
  ["no status", {}],
];

/** A row of the list's own channel, as `Message.tsx` passes it. */
const body = (view: unknown, capable: boolean, row: unknown) =>
  protectedRowBody(view as never, capable, row as never, false);

/** The same call for a row that names another channel than its list. */
const foreignBody = (view: unknown, capable: boolean, row: unknown) =>
  protectedRowBody(view as never, capable, row as never, true);

// ---- The ordinary path -------------------------------------------------------

test("U2: only a plain view reaches the ordinary message path", () => {
  // Every input the function takes, crossed: the body is `ordinary` exactly
  // when the view is a literal `plain`, the row has something restored and
  // carries no `encrypted`, and the row is not foreign. Nothing else is.
  const rows: [unknown, boolean][] = [
    [FULL_ROW, true],
    [{ content: "x" }, true],
    [{ systemMessage: { type: "user_joined" } }, true],
    [EMPTY_ROW, false],
    [{ ...FULL_ROW, encrypted: { v: 1 } }, false],
    [null, false],
    [undefined, false],
  ];
  const views: [string, unknown][] = [
    ["plain", { status: "plain" }],
    ...NEVER_ORDINARY,
  ];
  let ordinary = 0;
  let cases = 0;
  for (const capable of [true, false]) {
    for (const foreign of [false, true]) {
      for (const [label, view] of views) {
        for (const [row, renderable] of rows) {
          const got = (foreign ? foreignBody : body)(view, capable, row).kind;
          const want = label === "plain" && renderable && !foreign;
          cases++;
          ordinary += got === "ordinary" ? 1 : 0;
          assert.equal(
            got === "ordinary",
            want,
            `${label}, capable ${capable}, foreign ${foreign}, row ${JSON.stringify(row)}: ${got}`,
          );
        }
      }
    }
  }
  assert.equal(cases, 2 * 2 * 12 * 7);
  // Three renderable rows, two values of capable: nothing else was ordinary.
  assert.equal(ordinary, 6);
});

test("U2: a checking view is the checking line, whatever the row holds", () => {
  for (const capable of [true, false]) {
    for (const row of [FULL_ROW, EMPTY_ROW, { content: "x" }, null]) {
      assert.deepEqual(body({ status: "checking" }, capable, row), {
        kind: "checking",
      });
    }
  }
});

test("U2: an unknown status is the red error marker, never a body", () => {
  for (const view of [
    { status: "weird" },
    { status: "Plain" },
    { status: "checking " },
    { status: true },
    {},
  ]) {
    for (const capable of [true, false]) {
      assert.deepEqual(body(view, capable, FULL_ROW), {
        kind: "marker",
        marker: "error",
      });
    }
  }
});

test("U2: a missing or pending view waits, and never shows the row", () => {
  for (const view of [null, undefined, { status: "pending" }]) {
    assert.deepEqual(body(view, true, FULL_ROW), {
      kind: "marker",
      marker: "pending",
    });
    // Without the protected text plane the row would never decrypt.
    assert.deepEqual(body(view, false, FULL_ROW), {
      kind: "marker",
      marker: "not_available",
    });
    // Only a literal `true` counts as capable.
    assert.deepEqual(body(view, 1 as never, FULL_ROW), {
      kind: "marker",
      marker: "not_available",
    });
  }
});

test("U2: a marker view keeps its kind; one without a usable kind is the error marker", () => {
  for (const capable of [true, false]) {
    assert.deepEqual(
      body({ status: "marker", kind: "replay" }, capable, FULL_ROW),
      { kind: "marker", marker: "replay" },
    );
    for (const kind of [undefined, null, "", 7, {}]) {
      assert.deepEqual(body({ status: "marker", kind }, capable, FULL_ROW), {
        kind: "marker",
        marker: "error",
      });
    }
  }
});

test("U2: an ok view is the decrypted view itself, whatever the row holds", () => {
  const view = okView({ text: "hello" });
  for (const row of [FULL_ROW, EMPTY_ROW, null]) {
    const got = body(view, true, row);
    assert.equal(got.kind, "ok");
    assert.equal(got.kind === "ok" && got.view, view);
  }
});

// ---- plainRenderable ---------------------------------------------------------

test("U2: a plain view of an empty row falls back to the checking line", () => {
  for (const row of [
    EMPTY_ROW,
    null,
    undefined,
    { content: "" },
    { content: undefined, attachments: undefined },
    { content: null, attachments: null },
    { attachments: [] },
    { content: "", attachments: [] },
    // Fields the reveal does not restore are not something to show.
    { replyIds: ["x"], masquerade: { name: "n" }, interactions: {} },
    { reactions: new Map([["x", new Set(["u"])]]), mentionIds: ["u"] },
    // A restored field that is empty or absent is nothing either.
    { embeds: [], components: [] },
    { systemMessage: null, forwarded: null, poll: null, softres: null },
    {
      embeds: undefined,
      components: undefined,
      systemMessage: undefined,
      forwarded: undefined,
      poll: undefined,
      softres: undefined,
    },
    // Never a truthy non-string or a non-array.
    { content: 1 },
    { content: ["x"] },
    { attachments: "file" },
    { attachments: { length: 1 } },
    { embeds: "embed" },
    { embeds: { length: 1 } },
    { components: true },
    // Never a truthy value that is not an object.
    { systemMessage: "joined" },
    { forwarded: true },
    { poll: 1 },
    { softres: ["x"] },
  ]) {
    assert.equal(plainRenderable(row as never), false, JSON.stringify(row));
    assert.deepEqual(
      body({ status: "plain" }, true, row),
      { kind: "checking" },
      JSON.stringify(row),
    );
  }
});

test("U2: a plain row with content or attachments renders what it has", () => {
  for (const row of [
    { content: "hi" },
    { content: " " },
    { attachments: [{ _id: "f" }] },
    { content: "", attachments: [{ _id: "f" }] },
    FULL_ROW,
  ]) {
    assert.equal(plainRenderable(row), true, JSON.stringify(row));
    for (const capable of [true, false]) {
      assert.deepEqual(body({ status: "plain" }, capable, row), {
        kind: "ordinary",
      });
    }
  }
});

test("FXU: a plain row with any one restored field renders as an ordinary message", () => {
  // Each field the verified reveal puts back, alone on the row (audit C3):
  // a join/leave/pin row, an embed-only row and a forwarded row have no
  // content and no attachments.
  const rows: [string, object][] = [
    ["content", { content: "hi" }],
    ["attachments", { attachments: [{ _id: "f" }] }],
    ["systemMessage", { systemMessage: { type: "user_joined", id: "u" } }],
    ["embeds", { embeds: [{ type: "Website" }] }],
    ["forwarded", { forwarded: { content: "" } }],
    ["poll", { poll: { question: "q" } }],
    ["softres", { softres: { title: "t" } }],
    ["components", { components: [{ type: 1 }] }],
  ];
  assert.equal(rows.length, 8);
  for (const [field, row] of rows) {
    assert.equal(plainRenderable(row), true, field);
    for (const capable of [true, false]) {
      assert.deepEqual(
        body({ status: "plain" }, capable, row),
        { kind: "ordinary" },
        field,
      );
    }
    // The same row is never ordinary under any other view, or with
    // `encrypted` on it.
    assert.deepEqual(body({ status: "checking" }, true, row), {
      kind: "checking",
    });
    assert.equal(plainRenderable({ ...row, encrypted: { v: 1 } }), false);
  }
});

test("U2: a row carrying encrypted is never an ordinary message", () => {
  for (const encrypted of [{ v: 1 }, null, "", 0, false]) {
    const row = { ...FULL_ROW, encrypted };
    assert.equal(plainRenderable(row), false);
    assert.deepEqual(body({ status: "plain" }, true, row), {
      kind: "checking",
    });
  }
  assert.equal(plainRenderable({ ...FULL_ROW, encrypted: undefined }), true);
});

// ---- The list's channel (fix lane FXU, audit A1) --------------------------------

/** `client.isProtectedChannel` for a client that holds exactly `held`. */
const holds =
  (...held: string[]) =>
  (id: string) =>
    held.includes(id);

/** The call `Message.tsx` makes: both SDK answers, the list's only with a list. */
const scope = (
  encrypted: unknown,
  rowChannelId: string | undefined,
  listChannelId: string | undefined,
  isProtected: (id: string) => boolean,
) =>
  protectedRowScope({
    encrypted,
    rowChannelId,
    listChannelId,
    rowHeld: isProtected(rowChannelId as string),
    listHeld: listChannelId !== undefined && isProtected(listChannelId),
  });

test("FXU: a Protected list makes every row of its channel a Protected row", () => {
  // The list's channel is protected: the row is Protected with or without
  // `encrypted`.
  assert.equal(scope(undefined, "X", "X", holds("X")), "protected");
  assert.equal(scope({ v: 1 }, "X", "X", holds("X")), "protected");
  // Neither channel is held: only `encrypted` makes a Protected row.
  assert.equal(scope(undefined, "Y", "Y", holds()), "open");
  assert.equal(scope({ v: 1 }, "Y", "Y", holds()), "protected");
  assert.equal(scope(null, "Y", "Y", holds()), "protected");
  // Fails closed: any truthy answer from the SDK counts as held.
  assert.equal(scope(undefined, "Y", "Y", (() => 1) as never), "protected");
  assert.equal(scope(undefined, "Y", "Y", (() => 0) as never), "open");
  // The list's answer alone is enough, and it is not read without a list.
  const only = (listChannelId: string | undefined, listHeld: boolean) =>
    protectedRowScope({
      encrypted: undefined,
      rowChannelId: "X",
      listChannelId,
      rowHeld: false,
      listHeld,
    });
  assert.equal(only("X", true), "protected");
  assert.equal(only("X", false), "open");
  assert.equal(only(undefined, true), "open");
});

test("FXU: a row that names another channel than its Protected list is foreign", () => {
  // The audit's row: list X is protected, the row names Z, which is not.
  // Keyed on the row's own channel alone it was an ordinary message.
  assert.equal(scope(undefined, "Z", "X", holds("X")), "foreign");
  assert.equal(scope({ v: 1 }, "Z", "X", holds("X")), "foreign");
  assert.equal(scope(undefined, undefined, "X", holds("X")), "foreign");
  // A row of a protected channel shown in another list, protected or not.
  assert.equal(scope(undefined, "X", "Y", holds("X")), "foreign");
  assert.equal(scope(undefined, "X", "W", holds("X", "W")), "foreign");
  // A row carrying `encrypted` in a list of another channel.
  assert.equal(scope({ v: 1 }, "Z", "Y", holds()), "foreign");
  // Nothing held and no `encrypted`: the old behaviour, an ordinary row.
  assert.equal(scope(undefined, "Z", "Y", holds()), "open");
});

test("FXU: without a list the row's own channel decides, and no row is foreign", () => {
  assert.equal(scope(undefined, "X", undefined, holds("X")), "protected");
  assert.equal(scope({ v: 1 }, "Y", undefined, holds()), "protected");
  assert.equal(scope(undefined, "Y", undefined, holds("X")), "open");
  assert.equal(scope(undefined, undefined, undefined, holds("X")), "open");
});

test("FXU: a foreign row is the red error marker whatever its view and its row", () => {
  const views: unknown[] = [
    { status: "plain" },
    okView({ text: "decrypted" }),
    { status: "checking" },
    { status: "pending" },
    { status: "marker", kind: "sent_before_join" },
    null,
    undefined,
  ];
  for (const view of views) {
    for (const capable of [true, false]) {
      for (const row of [FULL_ROW, EMPTY_ROW, null]) {
        assert.deepEqual(foreignBody(view, capable, row), {
          kind: "marker",
          marker: "error",
        });
      }
    }
  }
  // Fails closed: anything but a literal `false` is foreign.
  for (const loose of [undefined, null, 0, "", "no"]) {
    assert.deepEqual(
      protectedRowBody({ status: "plain" }, true, FULL_ROW, loose as never),
      { kind: "marker", marker: "error" },
    );
  }
  // The control: the same call with `false` is the ordinary row.
  assert.deepEqual(body({ status: "plain" }, true, FULL_ROW), {
    kind: "ordinary",
  });
});

test("FXU: a Protected row previews only a reply target of the shown channel", () => {
  const shown = (
    protectedRow: boolean,
    listChannelId: string | undefined,
    targetChannelId: string | undefined,
  ) => replyTargetShown({ protectedRow, listChannelId, targetChannelId });

  assert.equal(shown(true, "X", "X"), true);
  // A cached row of another channel, or no cached row at all.
  assert.equal(shown(true, "X", "Z"), false);
  assert.equal(shown(true, "X", undefined), false);
  assert.equal(shown(true, undefined, undefined), false);
  assert.equal(shown(true, undefined, "X"), false);
  // Anything but a literal `false` is a Protected row.
  assert.equal(shown(1 as never, "X", "Z"), false);
  assert.equal(shown(undefined as never, "X", "Z"), false);
  // Rows outside Protected channels keep the legacy preview.
  assert.equal(shown(false, "Y", "Z"), true);
  assert.equal(shown(false, "Y", undefined), true);
});

// ---- The reply preview's sort -------------------------------------------------

test("U2: a reply target is sorted from its view alone", () => {
  assert.deepEqual(protectedViewClass({ status: "plain" }, true), {
    kind: "plain",
  });
  assert.deepEqual(protectedViewClass({ status: "checking" }, true), {
    kind: "checking",
  });
  assert.deepEqual(protectedViewClass(null, true), {
    kind: "marker",
    marker: "pending",
  });
  assert.deepEqual(protectedViewClass(null, false), {
    kind: "marker",
    marker: "not_available",
  });
  assert.deepEqual(protectedViewClass({ status: "weird" } as never, true), {
    kind: "marker",
    marker: "error",
  });
  const view = okView();
  const sorted = protectedViewClass(view, true);
  assert.equal(sorted.kind === "ok" && sorted.view, view);
});

// ---- Row notes ----------------------------------------------------------------

/**
 * The notes for every combination of the four flags, written out by hand
 * (S = sender verified, T = timing unverified, B = below the boundary,
 * H = history sender). The sender note is the "(history)" one when H is set
 * or the timing is unverified.
 */
const NOTE_MATRIX: [boolean, boolean, boolean, boolean, string[]][] = [
  // S     T      B      H
  [true, false, false, false, []],
  [true, false, false, true, []],
  [true, false, true, false, ["below_boundary"]],
  [true, false, true, true, ["below_boundary"]],
  [true, true, false, false, ["timing_unverified"]],
  [true, true, false, true, ["timing_unverified"]],
  [true, true, true, false, ["timing_unverified", "below_boundary"]],
  [true, true, true, true, ["timing_unverified", "below_boundary"]],
  [false, false, false, false, ["sender_unverified"]],
  [false, false, false, true, ["sender_unverified_history"]],
  [false, false, true, false, ["sender_unverified", "below_boundary"]],
  [false, false, true, true, ["sender_unverified_history", "below_boundary"]],
  [
    false,
    true,
    false,
    false,
    ["sender_unverified_history", "timing_unverified"],
  ],
  [
    false,
    true,
    false,
    true,
    ["sender_unverified_history", "timing_unverified"],
  ],
  [
    false,
    true,
    true,
    false,
    ["sender_unverified_history", "timing_unverified", "below_boundary"],
  ],
  [
    false,
    true,
    true,
    true,
    ["sender_unverified_history", "timing_unverified", "below_boundary"],
  ],
];

const matrixView = (s: boolean, t: boolean, b: boolean, h: boolean) =>
  okView({
    senderVerified: s,
    timingUnverified: t,
    belowBoundary: b,
    historySender: h,
  });

test("U2: row notes for all sixteen flag combinations, in display order", () => {
  assert.equal(NOTE_MATRIX.length, 16);
  const seen = new Set<string>();
  for (const [s, t, b, h, want] of NOTE_MATRIX) {
    seen.add(`${s}${t}${b}${h}`);
    const view = matrixView(s, t, b, h);
    assert.deepEqual(protectedRowNotes(view), want, `S${s} T${t} B${b} H${h}`);
    // They are the bridge's notes, not a second opinion.
    assert.deepEqual(protectedRowNotes(view), okViewNotes(view));
  }
  assert.equal(seen.size, 16);
});

test("U2: the history sender note needs historySender or unverified timing", () => {
  for (const b of [true, false]) {
    const notes = protectedRowNotes(matrixView(false, false, b, false));
    assert.ok(notes.includes("sender_unverified"));
    assert.ok(!notes.includes("sender_unverified_history"));
  }
  // A verified sender carries no sender note at all.
  for (const [s, t, b, h] of NOTE_MATRIX) {
    if (!s) continue;
    const notes = protectedRowNotes(matrixView(s, t, b, h));
    assert.ok(!notes.includes("sender_unverified"));
    assert.ok(!notes.includes("sender_unverified_history"));
  }
});

test("U2: the below-boundary note shows exactly when belowBoundary is set", () => {
  for (const [s, t, b, h] of NOTE_MATRIX) {
    const notes = protectedRowNotes(matrixView(s, t, b, h));
    assert.equal(
      notes.includes("below_boundary"),
      b,
      `S${s} T${t} B${b} H${h}`,
    );
  }
});

test("U2: the history sender note is never dropped or downgraded", () => {
  for (const [s, t, b, h] of NOTE_MATRIX) {
    if (s || !(h || t)) continue;
    const notes = protectedRowNotes(matrixView(s, t, b, h));
    assert.equal(notes[0], "sender_unverified_history");
    assert.ok(!notes.includes("sender_unverified"));
  }
});

test("U2: each note at most once, the sender note first and the boundary note last", () => {
  const order = [
    "sender_unverified",
    "sender_unverified_history",
    "timing_unverified",
    "below_boundary",
  ];
  for (const [s, t, b, h] of NOTE_MATRIX) {
    const notes = protectedRowNotes(matrixView(s, t, b, h));
    assert.equal(new Set(notes).size, notes.length);
    const ranks = notes.map((n) => order.indexOf(n));
    assert.ok(ranks.every((r) => r >= 0));
    assert.deepEqual(
      ranks,
      [...ranks].sort((x, y) => x - y),
    );
  }
});

test("U2: only a literal true sets a note flag", () => {
  // An older shell sends no `timing_unverified`; a truthy non-boolean is
  // not a flag, and a non-true `senderVerified` is unverified.
  const loose = okView({
    senderVerified: 1 as never,
    timingUnverified: "yes" as never,
    belowBoundary: 1 as never,
    historySender: {} as never,
  });
  assert.deepEqual(protectedRowNotes(loose), ["sender_unverified"]);
  const absent = { status: "ok", text: "", replies: [], cid: "c" };
  assert.deepEqual(protectedRowNotes(absent as never), ["sender_unverified"]);
});

// ---- R-W4-20: the composer reply preview and the toast tone --------------------

/** Code without comments, so prose never counts. */
function code(s: string): string {
  return s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `missing: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `missing end ${end} after ${start}`);
  return src.slice(a, b + end.length);
}

const COMPOSITION = readFileSync(
  new URL(
    "../../../../../src/interface/channels/text/Composition.tsx",
    import.meta.url,
  ),
  "utf8",
);
const NOTIFICATIONS = readFileSync(
  new URL("../../../../client/NotificationsWorker.tsx", import.meta.url),
  "utf8",
);

/**
 * The composer preview's `text()` with its view and copy functions swapped
 * for stubs: it is a closure over those and `props`, nothing else.
 */
function composerReplyText(): (view: unknown) => unknown {
  const preview = between(
    COMPOSITION,
    "function ProtectedReplyPreview(props: {\n  messageId: string;",
    "\n}\n",
  );
  const fn = between(preview, "const text = () => {", "\n  };\n");
  const src = stripTypeScriptTypes(code(fn)).replace("const text =", "return");
  return (view: unknown) =>
    new Function("view", "messageCopy", "markerCopy", "rowStateCopy", src)(
      () => view,
      { pending: () => "<pending>" },
      (kind: string) => `<marker ${kind}>`,
      (kind: string) => `<state ${kind}>`,
    )();
}

test("U2: the composer reply preview never shows the text of a checking or plain row", () => {
  const text = composerReplyText();
  assert.equal(text({ status: "checking" }), "<state checking>");
  // A plain target names its author only: no line, no server text.
  assert.equal(text({ status: "plain" }), "");
  assert.equal(text(null), "<pending>");
  assert.equal(text({ status: "pending" }), "<pending>");
  assert.equal(text({ status: "marker", kind: "replay" }), "<marker replay>");
  assert.equal(text({ status: "weird" }), "<pending>");
  assert.equal(text(okView({ text: "a\nb" })), "a b");

  // The function reads the view and the copy functions, never the row.
  const preview = code(
    between(
      COMPOSITION,
      "function ProtectedReplyPreview(props: {\n  messageId: string;",
      "\n}\n",
    ),
  );
  const fn = between(preview, "const text = () => {", "\n  };\n");
  assert.doesNotMatch(fn, /props|message\b|\.content|attachments/);
  assert.doesNotMatch(COMPOSITION, /S4-W4-0 placeholder/);
});

test("U2: both history toasts are alerts, like every other protected toast", () => {
  const fn = between(NOTIFICATIONS, "function protectedToastIsAlert(", "\n}\n");
  const isAlert = new Function(
    `${stripTypeScriptTypes(fn)}\nreturn protectedToastIsAlert;`,
  )() as (kind: string) => boolean;
  for (const kind of [
    "history_mismatch",
    "history_too_large",
    "owner_notice",
    "unsolicited_welcome",
    "a_kind_this_build_does_not_know",
  ]) {
    assert.equal(isAlert(kind), true, kind);
  }
  assert.doesNotMatch(NOTIFICATIONS, /S4-W4-0 placeholder/);
});
