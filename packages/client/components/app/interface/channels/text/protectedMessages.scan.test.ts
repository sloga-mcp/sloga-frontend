// Spec for the Protected channel rules in Messages.tsx (W4 lane C7), run with
// Node's built-in runner from packages/client:
//   node --conditions=browser --test components/app/interface/channels/text/protectedMessages.scan.test.ts
//
// Messages.tsx imports Solid, the client context and the UI kit, so Node
// cannot load it. Its pure helpers sit in one marked region
// (`// protected-pure:begin` .. `// protected-pure:end`) with no imports;
// this spec cuts that region out, strips the types with Node's own stripper
// and runs the real source. The wiring around it (which call sites use the
// helpers) is checked by scanning the file.
//
// Point `PROTECTED_MESSAGES_FILE` at another copy (a known-bad control) to
// check that instead; it must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  dividerAfter,
  nativeHistoryInput,
} from "../../../../client/protectedRowPolicy.ts";
import { historyFloorNotice } from "../../../../client/protectedShield.ts";
import type {
  HistoryStop,
  TextChannelState,
} from "../../../../client/protectedTextTypes";
import { restorableForTrust, splitUntrusted } from "./e2eeTranscriptTrust.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath =
  process.env.PROTECTED_MESSAGES_FILE || join(here, "Messages.tsx");
const source = readFileSync(sourcePath, "utf8");

const BEGIN = "// protected-pure:begin";
const END = "// protected-pure:end";

const EXPORTS = [
  "protectedTranscriptOf",
  "transcriptTrustFor",
  "rowsWithoutView",
  "timelineDisplayName",
  "sameLocalDay",
  "planTimelineMarkers",
  // S4 (W4 lane U3)
  "latestFloorOnly",
  "timelineTone",
  "pageEndsHistory",
  "pageStalled",
  "keylessView",
  "walkAfterPage",
  "verifiedHistoryOf",
  "historyVisibleOption",
  "planBoundaryDivider",
  // S4 fix lane FXU
  "floorAnchoredTo",
  "walkOnInitialLoad",
  "rowsOfChannel",
  "newestFirst",
  "reloadAfterEmptied",
  // S4 second fix round, lane FX2U
  "floorRowOf",
] as const;

async function loadRegion(): Promise<Record<string, unknown>> {
  const from = source.indexOf(BEGIN);
  const to = source.indexOf(END);
  assert.ok(from !== -1 && to > from, "protected-pure region missing");
  const region = source.slice(from, to);
  assert.ok(!/^\s*import\s/m.test(region), "the region must not import");
  const js =
    stripTypeScriptTypes(region, { mode: "strip" }) +
    `\nexport { ${EXPORTS.join(", ")} };\n`;
  const dir = mkdtempSync(join(tmpdir(), "w4c1-C7-"));
  const out = join(dir, "protectedMessagesPure.mjs");
  writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}

const mod = await loadRegion();
const fn = <T>(name: (typeof EXPORTS)[number]) => {
  assert.equal(typeof mod[name], "function", `${name} missing`);
  return mod[name] as T;
};

type Trust = "not_e2ee" | "plaintext" | "unconfirmed" | "encrypted" | "unknown";
type Marker = { atMs: number; id: string };
type Plan = {
  before: Marker[][];
  beforeDate: Marker[][];
  breaksTail: boolean[];
  trailing: Marker[];
};

const protectedTranscriptOf = fn<
  (type: string | undefined, protectedOrPinned: boolean) => boolean
>("protectedTranscriptOf");
const transcriptTrustFor =
  fn<(p: boolean, dm: Trust) => Trust>("transcriptTrustFor");
const rowsWithoutView =
  fn<
    <T extends { id: string }>(rows: T[], has: (id: string) => boolean) => T[]
  >("rowsWithoutView");
const timelineDisplayName = fn<
  (names: (string | null | undefined)[], fallback: string) => string
>("timelineDisplayName");
const sameLocalDay = fn<(a: number, b: number) => boolean>("sameLocalDay");
const planTimelineMarkers = fn<
  (
    markers: Marker[],
    messagesAtMs: number[],
    atStart: boolean,
    atEnd: boolean,
    sameDay: (a: number, b: number) => boolean,
  ) => Plan
>("planTimelineMarkers");

/**
 * Body of the function whose header matches: the first `{` after the
 * balanced parameter list, to its matching `}`. (Return types with braces
 * are not supported; none of the scanned functions has one.)
 */
function bodyOf(header: RegExp): string {
  const m = header.exec(source);
  assert.ok(m, `missing ${header}`);
  let j = source.indexOf("(", m.index);
  let parens = 0;
  for (; j < source.length; j++) {
    if (source[j] === "(") parens++;
    else if (source[j] === ")" && --parens === 0) break;
  }
  const start = source.indexOf("{", j);
  let depth = 0;
  for (let k = start; k < source.length; k++) {
    if (source[k] === "{") depth++;
    else if (source[k] === "}" && --depth === 0) {
      return source.slice(start, k + 1);
    }
  }
  assert.fail(`unbalanced ${header}`);
}

/** Text between two literal anchors. */
function between(from: string, to: string): string {
  const a = source.indexOf(from);
  assert.ok(a !== -1, `missing anchor ${from}`);
  const b = source.indexOf(to, a + from.length);
  assert.ok(b !== -1, `missing anchor ${to}`);
  return source.slice(a, b + to.length);
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

// Local-time stamps, so the day logic holds in every time zone.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();
const mk = (id: string, atMs: number): Marker => ({ id, atMs });
const ids = (list: Marker[]) => list.map((m) => m.id);

// ---------------------------------------------------------------------------
// C-C7a: protected rows never go through the DM untrusted-row path
// ---------------------------------------------------------------------------

describe("protected transcript vs the DM untrusted-row path", () => {
  it("only a server text channel is a protected transcript", () => {
    assert.equal(protectedTranscriptOf("TextChannel", true), true);
    assert.equal(protectedTranscriptOf("TextChannel", false), false);
    assert.equal(protectedTranscriptOf("DirectMessage", true), false);
    assert.equal(protectedTranscriptOf("Group", true), false);
    assert.equal(protectedTranscriptOf(undefined, true), false);
  });

  it("C-C7a: a protected transcript reads not_e2ee whatever the DM derivation says", () => {
    const all: Trust[] = [
      "not_e2ee",
      "plaintext",
      "unconfirmed",
      "encrypted",
      "unknown",
    ];
    for (const dm of all) {
      assert.equal(transcriptTrustFor(true, dm), "not_e2ee");
      // Any other channel keeps the DM derivation unchanged
      assert.equal(transcriptTrustFor(false, dm), dm);
    }
  });

  it("C-C7a: a restored protected entry with no DM-trusted row is kept whole, nothing hidden", () => {
    // Protected rows are never in the DM trusted set (plan D2), and one
    // has no `encrypted` at all: it must still render (Message.tsx shows
    // the red unencrypted_row marker), not be hidden or counted.
    const entry = {
      messages: [{ id: "01P3" }, { id: "01P2" }, { id: "01P1" }],
      atEnd: true,
    };
    const trust = transcriptTrustFor(true, "encrypted");
    const restored = restorableForTrust(entry, trust, () => false);
    assert.equal(restored.entry, entry);
    assert.equal(restored.hiddenVisible, 0);
    // The same rows on the DM path would all be dropped: the guard matters.
    assert.equal(splitUntrusted(entry.messages, () => false).trusted.length, 0);
  });

  it("C-C7a: currentTrust routes through the protected guard; channelTrust has no other caller", () => {
    const body = bodyOf(/function currentTrust\(\): ConversationTrust/);
    assert.match(
      body,
      /transcriptTrustFor\(\s*protectedTranscript\(\),\s*channelTrust\(/,
    );
    assert.equal(count(source, "channelTrust("), 1);
    assert.match(
      bodyOf(/function encryptedConversation\(\): boolean/),
      /currentTrust\(\) === "encrypted"/,
    );
    assert.match(
      bodyOf(/function onMessage\(message: MessageInterface\)/),
      /if \(encryptedConversation\(\) && !e2ee\?\.isEncryptedMessage/,
    );
  });

  it("noteDroppedPlaintext keeps only its three DM call sites, each behind the DM trust", () => {
    assert.equal(count(source, "noteDroppedPlaintext("), 3);
    assert.match(
      source,
      /if \(restoreHidden \+ mergeHidden > 0 && atEnd\(\)\) \{\s*e2ee\?\.noteDroppedPlaintext/,
    );
    assert.match(
      source,
      /if \(mergeHidden > 0\) \{\s*e2ee\?\.noteDroppedPlaintext/,
    );
    assert.match(
      source,
      /encryptedConversation\(\) && !e2ee\?\.isEncryptedMessage\(message\.id\)\) \{[\s\S]{0,600}?e2ee\?\.noteDroppedPlaintext/,
    );
  });

  it("the protected helpers never consult the DM trusted set", () => {
    const region = source.slice(source.indexOf(BEGIN), source.indexOf(END));
    assert.ok(!region.includes("isEncryptedMessage"));
    assert.ok(
      !bodyOf(/function decryptRestoredProtectedRows\(/).includes(
        "isEncryptedMessage",
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// C-C7b: cache restore re-requests decrypt for rows without a view
// ---------------------------------------------------------------------------

describe("cache restore decrypt", () => {
  it("rowsWithoutView keeps order and treats any view (pending too) as present", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const views = new Map<string, unknown>([
      ["b", { status: "pending" }],
      ["d", { status: "marker", kind: "replay" }],
    ]);
    const out = rowsWithoutView(rows, (id) => views.get(id) !== undefined);
    assert.deepEqual(
      out.map((r) => r.id),
      ["a", "c"],
    );
    assert.equal(out[0], rows[0]);
    assert.deepEqual(
      rowsWithoutView(rows, () => true),
      [],
    );
  });

  it("C-C7b: the restore branch hands view-less rows to the bridge on a protected channel", () => {
    const branch = between("if (useExistingState) {", "} else {");
    assert.match(branch, /messages = existingState\.messages;/);
    assert.match(
      branch,
      /if \(protectedTranscript\(\)\) \{\s*decryptRestoredProtectedRows\(messages\);\s*\}/,
    );
  });

  it("C-C7b: one batched decryptProtectedHistory call per restore, rows without a view only", () => {
    const body = bodyOf(/function decryptRestoredProtectedRows\(/);
    assert.equal(count(body, "decryptProtectedHistory"), 1);
    assert.match(
      body,
      /c\.e2ee\?\.decryptProtectedHistory\?\.\(props\.channel, missing\)/,
    );
    assert.match(body, /const missing = rowsWithoutView\(/);
    assert.match(body, /protectedUiOf\(c\.e2ee\)\?\.protectedViews/);
    assert.match(body, /if \(!missing\.length\) return;/);
    assert.ok(!/\bfor\s*\(|\.forEach\(/.test(body), "never one call per row");
    // A failure is logged with ids only and never throws into the load
    assert.match(body, /catch \{\s*console\.error\("\[protected\]/);
  });
});

// ---------------------------------------------------------------------------
// C-C7c: ArrowUp-to-edit disabled on a protected or pinned channel
// ---------------------------------------------------------------------------

describe("ArrowUp edit", () => {
  it("C-C7c: the edit request resolves to nothing on a protected or pinned channel", () => {
    const effect = between(
      "() => state.draft.getEditingMessageId(props.channel.id),",
      "state.draft.setEditingMessage(undefined, channelId);",
    );
    const guard = effect.indexOf(
      'protectedActionsBlocked(protectedOrPinned(), "edit")',
    );
    assert.ok(guard !== -1, "ArrowUp edit is not gated on protected");
    const find = effect.indexOf("messages().find(");
    assert.ok(find > guard, "the gate must come before the lookup");
    assert.match(
      effect.slice(guard, find),
      /^protectedActionsBlocked\(protectedOrPinned\(\), "edit"\)\s*\? undefined\s*:\s*$/,
    );
    // The gate uses the SDK predicate as is (fails closed)
    assert.match(
      bodyOf(/function protectedOrPinned\(\): boolean/),
      /return client\(\)\.isProtectedChannel\(props\.channel\.id\);/,
    );
  });
});

// ---------------------------------------------------------------------------
// Timeline markers
// ---------------------------------------------------------------------------

describe("timeline marker placement", () => {
  const M0 = at(10, 12); // newest
  const M1 = at(10, 11);
  const M2 = at(10, 9); // oldest

  it("no markers: nothing placed, no chain broken", () => {
    const p = planTimelineMarkers([], [M0, M1, M2], true, true, sameLocalDay);
    assert.deepEqual(p.before, [[], [], []]);
    assert.deepEqual(p.beforeDate, [[], [], []]);
    assert.deepEqual(p.breaksTail, [false, false, false]);
    assert.deepEqual(p.trailing, []);
  });

  it("a marker between two messages sits under the older one and breaks the newer one's chain", () => {
    const x = mk("x", at(10, 11, 30));
    const p = planTimelineMarkers([x], [M0, M1, M2], true, true, sameLocalDay);
    assert.deepEqual(p.before.map(ids), [[], ["x"], []]);
    assert.deepEqual(p.breaksTail, [true, false, false]);
  });

  it("a marker at a message's own time sits right after that message", () => {
    const x = mk("x", M1);
    const p = planTimelineMarkers([x], [M0, M1, M2], true, true, sameLocalDay);
    assert.deepEqual(p.before.map(ids), [[], ["x"], []]);
    assert.deepEqual(p.breaksTail, [true, false, false]);
  });

  it("newer than every loaded message: shown only at the end", () => {
    const x = mk("x", at(10, 13));
    const end = planTimelineMarkers([x], [M0, M1], true, true, sameLocalDay);
    assert.deepEqual(end.before.map(ids), [["x"], []]);
    const mid = planTimelineMarkers([x], [M0, M1], true, false, sameLocalDay);
    assert.deepEqual(mid.before.map(ids), [[], []]);
    assert.deepEqual(mid.trailing, []);
  });

  it("older than every loaded message: shown only at the start", () => {
    const x = mk("x", at(10, 8));
    const start = planTimelineMarkers([x], [M0, M1], true, true, sameLocalDay);
    assert.deepEqual(ids(start.trailing), ["x"]);
    const mid = planTimelineMarkers([x], [M0, M1], false, true, sameLocalDay);
    assert.deepEqual(mid.trailing, []);
    assert.deepEqual(mid.before.map(ids), [[], []]);
  });

  it("no messages: markers show only when the whole conversation is loaded", () => {
    const x = mk("x", at(10, 8));
    const y = mk("y", at(10, 9));
    assert.deepEqual(
      ids(planTimelineMarkers([x, y], [], true, true, sameLocalDay).trailing),
      ["y", "x"],
    );
    assert.deepEqual(
      planTimelineMarkers([x, y], [], false, true, sameLocalDay).trailing,
      [],
    );
    assert.deepEqual(
      planTimelineMarkers([x, y], [], true, false, sameLocalDay).trailing,
      [],
    );
  });

  it("across a day boundary a marker stays on its own day", () => {
    const newDay = at(11, 10);
    const oldDay = at(10, 10);
    const early = mk("early", at(11, 1)); // day 11, before the day-11 message
    const late = mk("late", at(10, 20)); // day 10, after the day-10 message
    const p = planTimelineMarkers(
      [late, early],
      [newDay, oldDay],
      true,
      true,
      sameLocalDay,
    );
    // Under the day-11 divider, then the day-10 message's own slot
    assert.deepEqual(p.beforeDate.map(ids), [["early"], []]);
    assert.deepEqual(p.before.map(ids), [[], ["late"]]);
    assert.deepEqual(p.breaksTail, [true, false]);
  });

  it("orders newest first, keeps arrival order on equal times, drops non-finite times", () => {
    const a = mk("a", at(10, 10));
    const b = mk("b", at(10, 10));
    const c = mk("c", at(10, 11, 30));
    const bad = mk("bad", Number.NaN);
    const p = planTimelineMarkers(
      [a, bad, c, b],
      [M0, M2],
      true,
      true,
      sameLocalDay,
    );
    // Built newest first, the list is reversed for display: a, b, c.
    assert.deepEqual(p.before.map(ids), [[], ["c", "b", "a"]]);
    const placed = [...p.before.flat(), ...p.beforeDate.flat(), ...p.trailing];
    assert.equal(placed.length, 3);
    assert.equal(new Set(placed).size, 3);
  });

  it("every marker is placed at most once", () => {
    const markers = [8, 9, 10, 11, 12, 13].map((h) => mk(`h${h}`, at(10, h)));
    for (const [s, e] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const p = planTimelineMarkers(markers, [M0, M1, M2], s, e, sameLocalDay);
      const placed = [
        ...p.before.flat(),
        ...p.beforeDate.flat(),
        ...p.trailing,
      ];
      assert.equal(new Set(placed).size, placed.length);
      assert.ok(placed.length <= markers.length);
    }
  });
});

describe("timeline marker rendering", () => {
  it("names: nickname, then display name, then the id-free fallback", () => {
    assert.equal(timelineDisplayName(["Nick", "Display"], "A member"), "Nick");
    assert.equal(timelineDisplayName([null, "Display"], "A member"), "Display");
    assert.equal(
      timelineDisplayName(["  ", undefined], "A member"),
      "A member",
    );
    assert.equal(timelineDisplayName([], "A member"), "A member");
  });

  it("the row resolves names like system messages and never interpolates an id", () => {
    const row = bodyOf(/function ProtectedTimelineRow\(/);
    assert.match(
      row,
      /timelineCopy\(\s*props\.marker,\s*timelineDisplayName\(/,
    );
    assert.match(row, /\[member\?\.nickname, user\?\.displayName\]/);
    assert.match(row, /t`A member`/);
    const call = row.slice(row.indexOf("timelineDisplayName("));
    assert.ok(
      !/userId|deviceId|groupId/.test(call.slice(0, call.indexOf(");"))),
    );
  });

  it("markers come from useProtectedTimeline and are planned only on a protected transcript", () => {
    assert.match(
      source,
      /const protectedTimeline = useProtectedTimeline\(\(\) => props\.channel\.id\);/,
    );
    // One call (the definition reads `planTimelineMarkers<M ...>(`)
    assert.equal(count(source, "planTimelineMarkers("), 1);
    assert.match(
      source,
      /const timeline = protectedTranscript\(\)\s*\? planTimelineMarkers\(\s*protectedTimeline\(\),/,
    );
    assert.match(
      source,
      /<Match when=\{local\.t === 3\}>\s*<ProtectedTimelineRow/,
    );
  });

  it("styled() is only called with string tags", () => {
    for (const m of source.matchAll(/\bstyled\(\s*([^,\s]+)/g)) {
      assert.match(m[1], /^"/, `styled(${m[1]}, ...) at module scope`);
    }
  });
});

// ---------------------------------------------------------------------------
// S4 (W4 lane U3): paging end, boundary divider, history floor, walk trigger
// ---------------------------------------------------------------------------

type FloorMarker = {
  id: string;
  atMs: number;
  kind?: string;
  channelId?: string;
};
type VerifiedHistory = {
  historyVisible: boolean;
  divider: { boundary: string; preHistory: "kept" | "wiped" } | null;
} | null;
type DividerPlan = {
  below: string | null;
  preHistory: "kept" | "wiped";
} | null;
type WalkInput = {
  protectedChannel: boolean;
  historyFlag: boolean;
  historyWalk: string | undefined;
  rows: number;
  keylessRows: boolean;
  floorKnown: boolean;
};

const pageEndsHistory =
  fn<(count: number, limit: number, protectedChannel: boolean) => boolean>(
    "pageEndsHistory",
  );
const pageStalled =
  fn<
    (
      ids: string[],
      cursor: string | undefined,
      direction: "older" | "newer",
      protectedChannel: boolean,
    ) => boolean
  >("pageStalled");
const keylessView = fn<(view: unknown) => boolean>("keylessView");
const walkAfterPage = fn<(i: WalkInput) => boolean>("walkAfterPage");
const latestFloorOnly =
  fn<(markers: FloorMarker[]) => FloorMarker[]>("latestFloorOnly");
const timelineTone =
  fn<(kind: string, floorTone: string | null | undefined) => "quiet" | "loud">(
    "timelineTone",
  );
const verifiedHistoryOf =
  fn<
    (
      native: ReturnType<typeof nativeHistoryInput> | undefined,
      historySetting: unknown,
      pin: { boundary: string; wiped: boolean } | null | undefined,
      latch: { conflicted: boolean; wiped: boolean },
    ) => VerifiedHistory
  >("verifiedHistoryOf");
const historyVisibleOption = fn<
  (history: { historyVisible: boolean } | null | undefined) => {
    historyVisible?: true;
  }
>("historyVisibleOption");
const planBoundaryDivider = fn<
  (i: {
    idsNewestFirst: string[];
    divider: { boundary: string; preHistory: "kept" | "wiped" } | null;
    atStart: boolean;
    atEnd: boolean;
    dividerAfter: typeof dividerAfter;
  }) => DividerPlan
>("planBoundaryDivider");
const floorAnchoredTo =
  fn<(marker: { atMs: number; kind?: string }, rowAtMs: number) => boolean>(
    "floorAnchoredTo",
  );
const walkOnInitialLoad =
  fn<
    (i: {
      protectedChannel: boolean;
      historyFlag: boolean;
      historyWalk: string | undefined;
    }) => boolean
  >("walkOnInitialLoad");
const rowsOfChannel =
  fn<
    <T extends { channelId?: string }>(
      rows: readonly T[],
      channelId: string,
      protectedOrPinned: boolean,
    ) => T[]
  >("rowsOfChannel");
const newestFirst =
  fn<<T extends { id: string }>(lists: readonly T[][]) => T[]>("newestFirst");
const reloadAfterEmptied =
  fn<
    (i: {
      protectedOrPinned: boolean;
      before: number;
      after: number;
      fetching: boolean;
      reloads: number;
    }) => boolean
  >("reloadAfterEmptied");
const floorRowOf =
  fn<
    (
      marker: { atMs: number; kind?: string },
      messagesAtMs: readonly number[],
    ) => number
  >("floorRowOf");
const planFloorMarkers = planTimelineMarkers as unknown as (
  markers: FloorMarker[],
  messagesAtMs: number[],
  atStart: boolean,
  atEnd: boolean,
  sameDay: (a: number, b: number) => boolean,
) => {
  before: FloorMarker[][];
  beforeDate: FloorMarker[][];
  breaksTail: boolean[];
  trailing: FloorMarker[];
};

// Well-formed ULIDs that sort by `n`
const ulid = (n: number) =>
  "01HZZZZZZZZZZZZZZZZZZZ" + String(n).padStart(4, "0");
const NO_LATCH = { conflicted: false, wiped: false };
const BOUNDARY = ulid(30);

/** A native state the row policy calls verified, with the given changes. */
function nativeState(over: Record<string, unknown> = {}): TextChannelState {
  return {
    channel_id: "C",
    group_id: "G",
    generation: 1,
    epoch: 5,
    state: "active",
    members: [],
    seat_list: { version: 3 },
    self_seated: true,
    roster_matches_list: true,
    update_due: false,
    update_required: false,
    verdict: "ok",
    history_setting: "visible",
    history_boundary: BOUNDARY,
    pre_history: "kept",
    history_time_limit: 1_700_000_000_000,
    ...over,
  } as unknown as TextChannelState;
}

/** The production chain: the view's native state to what the list may show. */
function shown(
  native: TextChannelState | null,
  o: {
    seatListError?: string | null;
    pin?: { boundary: string; wiped: boolean } | null;
    latch?: { conflicted: boolean; wiped: boolean };
  } = {},
): VerifiedHistory {
  return verifiedHistoryOf(
    nativeHistoryInput(native, { seatListError: o.seatListError ?? null }),
    native?.history_setting,
    o.pin ?? null,
    o.latch ?? NO_LATCH,
  );
}

const plan = (
  loaded: number[],
  divider: { boundary: string; preHistory: "kept" | "wiped" } | null,
  atStart: boolean,
  atEnd: boolean,
) =>
  planBoundaryDivider({
    idsNewestFirst: loaded.map(ulid),
    divider,
    atStart,
    atEnd,
    dividerAfter,
  });

describe("S4 paging end", () => {
  it("U3: an ordinary channel ends paging on a short page", () => {
    assert.equal(pageEndsHistory(49, 50, false), true);
    assert.equal(pageEndsHistory(1, 50, false), true);
    assert.equal(pageEndsHistory(0, 50, false), true);
    assert.equal(pageEndsHistory(29, 30, false), true);
    // Only a literal true takes the protected rule
    assert.equal(pageEndsHistory(49, 50, 1 as unknown as boolean), true);
  });

  it("U3: a protected channel pages on after a short page", () => {
    assert.equal(pageEndsHistory(49, 50, true), false);
    assert.equal(pageEndsHistory(1, 50, true), false);
    assert.equal(pageEndsHistory(12, 30, true), false);
  });

  it("U3: a protected channel ends paging on an empty page", () => {
    assert.equal(pageEndsHistory(0, 50, true), true);
    assert.equal(pageEndsHistory(0, 30, true), true);
  });

  it("U3: a full page never ends paging", () => {
    for (const p of [true, false]) {
      assert.equal(pageEndsHistory(50, 50, p), false);
      assert.equal(pageEndsHistory(30, 30, p), false);
      assert.equal(pageEndsHistory(60, 50, p), false);
    }
  });

  it("U3: a protected page that brings nothing beyond its cursor is stalled", () => {
    const cursor = ulid(20);
    // Backward: something older than the cursor is progress
    assert.equal(
      pageStalled([ulid(20), ulid(25)], cursor, "older", true),
      true,
    );
    assert.equal(pageStalled([ulid(20)], cursor, "older", true), true);
    assert.equal(
      pageStalled([ulid(25), ulid(19)], cursor, "older", true),
      false,
    );
    // Forward: something newer is
    assert.equal(
      pageStalled([ulid(20), ulid(15)], cursor, "newer", true),
      true,
    );
    assert.equal(
      pageStalled([ulid(15), ulid(21)], cursor, "newer", true),
      false,
    );
    // Never for an empty page, an ordinary channel or a fetch with no cursor
    assert.equal(pageStalled([], cursor, "older", true), false);
    assert.equal(pageStalled([ulid(25)], cursor, "older", false), false);
    assert.equal(pageStalled([ulid(25)], undefined, "older", true), false);
    assert.equal(
      pageStalled([ulid(25)], cursor, "older", 1 as unknown as boolean),
      false,
    );
  });

  it("U3: backward paging of a protected channel always terminates", () => {
    // The decisions of caseFetchUpwards, one request per trigger: stop on a
    // stalled or ending page, else move the cursor to the oldest row.
    const page = (server: (before: string) => string[], from: string) => {
      let cursor = from;
      let requests = 0;
      while (requests < 10_000) {
        const ids = server(cursor);
        requests++;
        if (
          pageStalled(ids, cursor, "older", true) ||
          pageEndsHistory(ids.length, 50, true)
        ) {
          break;
        }
        cursor = [...ids, cursor].sort()[0];
      }
      return { requests, cursor };
    };

    // Every row stripped still comes back as a row: 120 of them in pages
    // the server's filter cut short, then one empty page.
    const rows = Array.from({ length: 120 }, (_, i) => ulid(i + 1));
    const honest = (size: number) => (before: string) =>
      rows
        .filter((id) => id < before)
        .slice(-size)
        .reverse();
    for (const size of [50, 7, 1]) {
      const out = page(honest(size), ulid(121));
      assert.equal(out.cursor, ulid(1));
      assert.equal(out.requests, Math.ceil(120 / size) + 1);
    }

    // A server that answers every request with the same rows, or with rows
    // that are not older, gets one request and no more.
    assert.equal(page(() => [ulid(121), ulid(130)], ulid(121)).requests, 1);
    assert.equal(page(() => [ulid(500)], ulid(121)).requests, 1);
    const same = [ulid(90), ulid(80)];
    assert.equal(page(() => same, ulid(121)).requests, 2);
  });

  it("U3: all four paging sites decide through pageEndsHistory", () => {
    // The definition and four calls
    assert.equal(count(source, "pageEndsHistory("), 5);
    assert.ok(!/\.length < (INITIAL_)?FETCH_LIMIT/.test(source));
    assert.match(
      bodyOf(/async function caseInitialLoad\(/),
      /!useExistingState &&\s*pageEndsHistory\(\s*messages\.length,\s*INITIAL_FETCH_LIMIT,\s*protectedTranscript\(\),\s*\)\s*\) \{\s*setStart\(true\);/,
    );
    assert.match(
      bodyOf(/async function caseJumpToBottom\(/),
      /if \(\s*pageEndsHistory\(messages\.length, FETCH_LIMIT, protectedTranscript\(\)\)\s*\) \{\s*setStart\(true\);\s*\} else \{\s*setStart\(false\);/,
    );

    const up = bodyOf(/async function caseFetchUpwards\(/);
    assert.match(up, /const protectedPage = protectedTranscript\(\);/);
    assert.match(
      up,
      /const stalled = pageStalled\(\s*result\.messages\.map\(\(message\) => message\.id\),\s*oldest,\s*"older",\s*protectedPage,\s*\);/,
    );
    assert.match(
      up,
      /if \(\s*stalled \|\|\s*pageEndsHistory\(result\.messages\.length, FETCH_LIMIT, protectedPage\)\s*\) \{\s*setStart\(true\);/,
    );
    assert.match(up, /before: oldest,/);
    assert.match(up, /if \(result\.messages\.length && !stalled\) \{/);

    const down = bodyOf(/async function caseFetchDownwards\(/);
    assert.match(down, /const protectedPage = protectedTranscript\(\);/);
    assert.match(
      down,
      /const stalled = pageStalled\(\s*result\.messages\.map\(\(message\) => message\.id\),\s*newest,\s*"newer",\s*protectedPage,\s*\);/,
    );
    assert.match(
      down,
      /if \(\s*stalled \|\|\s*pageEndsHistory\(result\.messages\.length, FETCH_LIMIT, protectedPage\)\s*\) \{\s*setEnd\(true\);/,
    );
    assert.match(down, /after: newest,/);
    assert.match(down, /if \(result\.messages\.length && !stalled\) \{/);
  });

  it("U3: one page request per trigger, and none without a row to page from", () => {
    for (const [header, guard] of [
      [
        /async function caseFetchUpwards\(/,
        /const oldest = messages\(\)\.slice\(-1\)\[0\]\?\.id;\s*if \(oldest === undefined\) return;/,
      ],
      [
        /async function caseFetchDownwards\(/,
        /const newest = messages\(\)\[0\]\?\.id;\s*if \(newest === undefined\) return;/,
      ],
    ] as const) {
      const body = bodyOf(header);
      assert.equal(count(body, "fetchMessagesWithUsers("), 1);
      assert.ok(!/\bwhile\s*\(|\bfor\s*\(|\bdo\s*\{/.test(body), "no loop");
      assert.ok(!/caseFetch(Upwards|Downwards)\(/.test(body));
      assert.match(body, guard);
      // The guard comes before the fetch is announced
      assert.ok(body.search(guard) < body.indexOf("setFetching("));
    }
  });
});

describe("S4 history walk trigger", () => {
  const base: WalkInput = {
    protectedChannel: true,
    historyFlag: true,
    historyWalk: "idle",
    rows: 50,
    keylessRows: false,
    floorKnown: false,
  };
  const every = (over: Partial<WalkInput>) => {
    const out: boolean[] = [];
    for (const keylessRows of [true, false]) {
      for (const floorKnown of [true, false]) {
        out.push(walkAfterPage({ ...base, keylessRows, floorKnown, ...over }));
      }
    }
    return out;
  };

  it("U3: a backward page asks for a walk when the last one has to be retried", () => {
    assert.deepEqual(every({ historyWalk: "retry_later" }), [
      true,
      true,
      true,
      true,
    ]);
  });

  it("U3: no walk is asked while one is running", () => {
    assert.deepEqual(every({ historyWalk: "running" }), [
      false,
      false,
      false,
      false,
    ]);
  });

  it("U3: no walk with the history flag off or outside a protected channel", () => {
    for (const historyWalk of ["retry_later", "idle"]) {
      assert.ok(!every({ historyWalk, historyFlag: false }).includes(true));
      assert.ok(
        !every({ historyWalk, protectedChannel: false }).includes(true),
      );
      assert.ok(
        !every({
          historyWalk,
          historyFlag: "true" as unknown as boolean,
        }).includes(true),
      );
    }
  });

  it("U3: rows without a key ask for a walk only until a floor is known", () => {
    assert.equal(walkAfterPage({ ...base, keylessRows: true }), true);
    assert.equal(
      walkAfterPage({ ...base, keylessRows: true, floorKnown: true }),
      false,
    );
    assert.equal(walkAfterPage({ ...base, keylessRows: false }), false);
    assert.equal(
      walkAfterPage({ ...base, keylessRows: false, floorKnown: true }),
      false,
    );
  });

  it("U3: an empty page, an unknown walk state or a missing view asks for nothing", () => {
    assert.ok(!every({ historyWalk: "retry_later", rows: 0 }).includes(true));
    assert.ok(!every({ historyWalk: undefined }).includes(true));
    assert.ok(!every({ historyWalk: "zz_future" }).includes(true));
  });

  it("U3: only the gray key-missing views count as rows without a key", () => {
    assert.equal(
      keylessView({ status: "marker", kind: "sent_before_join" }),
      true,
    );
    assert.equal(keylessView({ status: "marker", kind: "unknown_key" }), true);
    for (const kind of [
      "removed_self",
      "decrypt_failed",
      "unverified_sender",
      "unencrypted_row",
      "error",
    ]) {
      assert.equal(keylessView({ status: "marker", kind }), false);
    }
    for (const status of ["pending", "ok", "plain", "checking"]) {
      assert.equal(keylessView({ status, kind: "sent_before_join" }), false);
    }
    assert.equal(keylessView(undefined), false);
    assert.equal(keylessView(null), false);
  });

  it("U3: walkHistory is requested once per backward page, by walkHistoryAfterPage", () => {
    // Two callers in the file: this one, and the initial load (FXU, C4)
    assert.equal(count(source, "walkHistory("), 2);
    assert.equal(
      count(bodyOf(/function walkHistoryAfterPage\(/), "walkHistory("),
      1,
    );
    // The definition and one call
    assert.equal(count(source, "walkHistoryAfterPage("), 2);

    const helper = bodyOf(/function walkHistoryAfterPage\(/);
    assert.match(helper, /const wanted = walkAfterPage\(\{/);
    assert.match(helper, /if \(wanted\) ui\.walkHistory\(channelId\);/);
    assert.match(
      helper,
      /historyFlag: ui\.protectedFlag\(\)\.historySetting === true,/,
    );
    assert.match(
      helper,
      /historyWalk: ui\.protectedChannels\.get\(channelId\)\?\.historyWalk,/,
    );
    assert.match(helper, /protectedChannel: protectedTranscript\(\),/);
    assert.match(helper, /rows: page\.length,/);
    assert.match(helper, /keylessView\(ui\.protectedViews\.get\(row\.id\)\)/);
    assert.match(
      helper,
      /floorKnown: protectedTimeline\(\)\.some\(\s*\(marker\) => marker\.kind === "history_floor",/,
    );
    assert.ok(!/\bwhile\s*\(|\bfor\s*\(/.test(helper));

    const up = bodyOf(/async function caseFetchUpwards\(/);
    const call = up.indexOf("walkHistoryAfterPage(result.messages)");
    assert.ok(call !== -1, "not called from backward paging");
    assert.ok(call > up.indexOf("if (preempted()) return;"));
    assert.match(
      up,
      /if \(!stalled\) walkHistoryAfterPage\(result\.messages\);/,
    );
  });
});

describe("S4 history floor marker", () => {
  const M0 = at(10, 12); // newest
  const M1 = at(10, 9); // oldest
  const floor = (id: string, atMs: number, channelId = "C"): FloorMarker => ({
    id,
    atMs,
    kind: "history_floor",
    channelId,
  });
  const other = (id: string, kind: string, atMs: number): FloorMarker => ({
    id,
    atMs,
    kind,
    channelId: "C",
  });
  const placed = (p: ReturnType<typeof planFloorMarkers>) =>
    [...p.before.flat(), ...p.beforeDate.flat(), ...p.trailing].map(
      (m) => m.id,
    );

  it("U3: only the latest history floor of a channel is placed", () => {
    const markers = [
      floor("f1", at(10, 9, 30)),
      other("dev", "new_device", at(10, 10)),
      floor("f2", at(10, 10, 30)),
      other("gone", "forced_removal", at(10, 11)),
      floor("f3", at(10, 11, 30)),
    ];
    const p = planFloorMarkers(markers, [M0, M1], true, true, sameLocalDay);
    assert.deepEqual(placed(p), ["f3", "gone", "dev"]);

    // Latest by arrival, not by time: a later stop replaces an earlier one
    const back = [floor("late", at(10, 11)), floor("early", at(10, 10))];
    assert.deepEqual(
      placed(planFloorMarkers(back, [M0, M1], true, true, sameLocalDay)),
      ["early"],
    );
  });

  it("U3: floors of different channels are kept apart, and other markers are never dropped", () => {
    const list = [
      floor("a1", 1, "A"),
      other("d1", "new_device", 2),
      floor("b1", 3, "B"),
      other("d2", "new_device", 4),
      floor("a2", 5, "A"),
      { id: "bare", atMs: 6 },
    ];
    assert.deepEqual(
      latestFloorOnly(list).map((m) => m.id),
      ["d1", "b1", "d2", "a2", "bare"],
    );
    assert.deepEqual(latestFloorOnly([]), []);
    const one = [floor("only", 1)];
    assert.deepEqual(latestFloorOnly(one), one);
  });

  // R-W4-32: the manager raises the floor marker 1 ms after the newest
  // loaded row at or below the floor epoch. It raises none until such a row
  // is loaded, and raises it again, later, when a newer such row is. So the
  // marker's time is a row's time + 1, never a clock time.
  const R3 = at(10, 12); // newest, readable
  const R2 = at(10, 11); // readable
  const R1 = at(10, 10); // newest row at or below the floor
  const R0 = at(10, 9); // below the floor too
  const WINDOWS = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const;

  it("FXU: the history floor sits directly after the newest loaded row at or below it", () => {
    for (const [atStart, atEnd] of WINDOWS) {
      const p = planFloorMarkers(
        [floor("floor", R1 + 1)],
        [R3, R2, R1, R0],
        atStart,
        atEnd,
        sameLocalDay,
      );
      // The list is built newest first: what is pushed before row R1 shows
      // right below it, between R1 and the first readable row R2.
      assert.deepEqual(p.before.map(ids), [[], [], ["floor"], []]);
      assert.deepEqual(p.breaksTail, [false, true, false, false]);
      assert.deepEqual(p.beforeDate.map(ids), [[], [], [], []]);
      assert.deepEqual(p.trailing, []);
    }
    // Never under the newest message, where a clock time used to put it
    // (and only with the end of the conversation loaded).
    const end = planFloorMarkers(
      [floor("floor", R1 + 1)],
      [R3, R2, R1, R0],
      true,
      true,
      sameLocalDay,
    );
    assert.deepEqual(end.before[0], []);
  });

  it("FXU: a floor on the newest loaded row shows wherever the loaded window ends", () => {
    // The user paged back: the window ends at the floor row, the newer
    // rows are not loaded. The marker belongs to that row and shows.
    for (const [atStart, atEnd] of WINDOWS) {
      const p = planFloorMarkers(
        [floor("floor", R1 + 1)],
        [R1, R0],
        atStart,
        atEnd,
        sameLocalDay,
      );
      assert.deepEqual(p.before.map(ids), [["floor"], []]);
    }
    // A floor that is not this row's (its row is newer and not loaded)
    // waits for the end of the conversation like any other marker.
    for (const late of [R1 + 2, R1 + 60_000, R3 + 1]) {
      const mid = planFloorMarkers(
        [floor("floor", late)],
        [R1, R0],
        true,
        false,
        sameLocalDay,
      );
      assert.deepEqual(mid.before.map(ids), [[], []], String(late - R1));
      const end = planFloorMarkers(
        [floor("floor", late)],
        [R1, R0],
        true,
        true,
        sameLocalDay,
      );
      assert.deepEqual(end.before.map(ids), [["floor"], []]);
    }
    // Only a history floor is anchored: a device marker at the same time
    // still belongs to rows that are not loaded.
    const dev = planFloorMarkers(
      [other("dev", "new_device", R1 + 1)],
      [R1, R0],
      true,
      false,
      sameLocalDay,
    );
    assert.deepEqual(dev.before.map(ids), [[], []]);

    assert.equal(floorAnchoredTo(floor("f", R1 + 1), R1), true);
    assert.equal(floorAnchoredTo(floor("f", R1), R1), true);
    assert.equal(floorAnchoredTo(floor("f", R1 + 2), R1), false);
    assert.equal(floorAnchoredTo(floor("f", R1 - 1), R1), false);
    assert.equal(floorAnchoredTo(floor("f", Number.NaN), R1), false);
    assert.equal(floorAnchoredTo(other("d", "new_device", R1 + 1), R1), false);
    assert.equal(floorAnchoredTo({ atMs: R1 + 1 }, R1), false);
  });

  it("FXU: a floor raised again for a newer row moves there, and the older line goes", () => {
    // First only R0 was loaded, then R1 (also at or below the floor) came
    // in: the manager appends a second marker with the later time.
    const markers = [floor("first", R0 + 1), floor("again", R1 + 1)];
    const p = planFloorMarkers(
      markers,
      [R3, R2, R1, R0],
      true,
      true,
      sameLocalDay,
    );
    assert.deepEqual(p.before.map(ids), [[], [], ["again"], []]);
    assert.deepEqual(placed(p), ["again"]);
    // Before that second marker the line sat on R0.
    const early = planFloorMarkers(
      markers.slice(0, 1),
      [R3, R2, R1, R0],
      true,
      true,
      sameLocalDay,
    );
    assert.deepEqual(early.before.map(ids), [[], [], [], ["first"]]);
  });

  it("FXU: a floor whose row is not in the loaded window is not drawn inside it", () => {
    // The floor row is older than everything loaded: only at the start of
    // the conversation (the row left the window), never between rows.
    const older = [floor("floor", R0 - 3_600_000 + 1)];
    for (const [atStart, atEnd] of WINDOWS) {
      const p = planFloorMarkers(older, [R3, R2], atStart, atEnd, sameLocalDay);
      assert.deepEqual(p.before.map(ids), [[], []]);
      assert.deepEqual(ids(p.trailing), atStart ? ["floor"] : []);
    }
    // No marker at all (no row at or below the floor is loaded yet):
    // nothing is placed and no chain is broken.
    const none = planFloorMarkers([], [R3, R2], true, true, sameLocalDay);
    assert.deepEqual(placed(none), []);
    assert.deepEqual(none.breaksTail, [false, false]);
  });

  it("FXU: a history floor keeps its time order against device and removal markers", () => {
    // Different times: newest first in the plan
    const mixed = [
      other("dev", "new_device", at(10, 10)),
      floor("floor", at(10, 10, 30)),
      other("gone", "forced_removal", at(10, 11)),
    ];
    const p = planFloorMarkers(mixed, [M0, M1], true, true, sameLocalDay);
    assert.deepEqual(p.before.map(ids), [[], ["gone", "floor", "dev"]]);
    assert.deepEqual(p.breaksTail, [true, false]);

    // Equal times: arrival order once the list is reversed for display
    const t = at(10, 10);
    for (const order of [
      ["dev", "floor", "gone"],
      ["floor", "gone", "dev"],
      ["gone", "dev", "floor"],
    ]) {
      const same = order.map((id) =>
        id === "floor"
          ? floor(id, t)
          : other(id, id === "dev" ? "new_device" : "forced_removal", t),
      );
      const q = planFloorMarkers(same, [M0, M1], true, true, sameLocalDay);
      assert.deepEqual(q.before[1].map((m) => m.id).reverse(), order);
    }

    // A floor at a message's own time sits right after that message
    const own = planFloorMarkers(
      [floor("floor", M1)],
      [M0, M1],
      true,
      true,
      sameLocalDay,
    );
    assert.deepEqual(own.before.map(ids), [[], ["floor"]]);
  });

  // RC4: a readable row can be as close as 1 ms above the floor row, so
  // the marker's time alone (row time + 1) would put the line above it.
  const NEAR = R1 + 1; // readable, in the marker's own millisecond

  it("FX2U: the anchored row of a floor is the newest row 1 ms before it, and only a floor has one", () => {
    const rows = [R3, NEAR, R1, R0];
    assert.equal(floorRowOf(floor("f", R1 + 1), rows), 2);
    assert.equal(floorRowOf(floor("f", R0 + 1), rows), 3);
    assert.equal(floorRowOf(floor("f", R3 + 1), rows), 0);
    // The row that shares the marker's time is not its row
    assert.equal(floorRowOf(floor("f", R3), rows), -1);
    assert.equal(floorRowOf(floor("f", R1 + 2), [R3, R1, R0]), -1);
    // Its row is not loaded
    assert.equal(floorRowOf(floor("f", R2 + 1), rows), -1);
    assert.equal(floorRowOf(floor("f", R1 + 1), []), -1);
    assert.equal(floorRowOf(floor("f", Number.NaN), rows), -1);
    // Two rows in one millisecond: the newer one (first in the list)
    assert.equal(floorRowOf(floor("f", R1 + 1), [R3, R1, R1, R0]), 1);
    // No other marker is anchored to a row
    assert.equal(floorRowOf(other("d", "new_device", R1 + 1), rows), -1);
    assert.equal(floorRowOf({ atMs: R1 + 1 }, rows), -1);
  });

  it("FX2U: a readable row within 1 ms of the floor row does not take the floor line", () => {
    for (const [atStart, atEnd] of WINDOWS) {
      const p = planFloorMarkers(
        [floor("floor", R1 + 1)],
        [R3, NEAR, R1, R0],
        atStart,
        atEnd,
        sameLocalDay,
      );
      // Directly before the floor row R1, between it and the readable row
      assert.deepEqual(p.before.map(ids), [[], [], ["floor"], []]);
      assert.deepEqual(p.breaksTail, [false, true, false, false]);
      assert.deepEqual(p.beforeDate.map(ids), [[], [], [], []]);
      assert.deepEqual(p.trailing, []);

      // The same with the readable row as the newest loaded one (k = 0)
      const top = planFloorMarkers(
        [floor("floor", R1 + 1)],
        [NEAR, R1, R0],
        atStart,
        atEnd,
        sameLocalDay,
      );
      assert.deepEqual(top.before.map(ids), [[], ["floor"], []]);
      assert.deepEqual(top.breaksTail, [true, false, false]);
      assert.deepEqual(placed(top), ["floor"]);
    }
    // Only a history floor is moved to a row: a device marker at the same
    // time keeps its place by time, above the readable row.
    const dev = planFloorMarkers(
      [other("dev", "new_device", R1 + 1)],
      [R3, NEAR, R1, R0],
      true,
      true,
      sameLocalDay,
    );
    assert.deepEqual(dev.before.map(ids), [[], ["dev"], [], []]);
    assert.deepEqual(dev.breaksTail, [true, false, false, false]);
  });

  it("FX2U: a floor at its row keeps the time order among that row's other markers", () => {
    const p = planFloorMarkers(
      [
        other("gone", "forced_removal", R1),
        floor("floor", R1 + 1),
        other("dev", "new_device", R1 + 30_000),
      ],
      [R2, R1, R0],
      true,
      true,
      sameLocalDay,
    );
    assert.deepEqual(p.before.map(ids), [[], ["dev", "floor", "gone"], []]);
    assert.deepEqual(p.breaksTail, [true, false, false]);
    // Equal times: arrival order once reversed, as for every marker
    for (const order of [
      ["dev", "floor"],
      ["floor", "dev"],
    ]) {
      const same = order.map((id) =>
        id === "floor" ? floor(id, R1 + 1) : other(id, "new_device", R1 + 1),
      );
      const q = planFloorMarkers(same, [R2, R1, R0], true, true, sameLocalDay);
      assert.deepEqual(q.before[1].map((m) => m.id).reverse(), order);
      assert.deepEqual(placed(q).sort(), ["dev", "floor"]);
    }
  });

  it("FX2U: a floor whose row ends a day stays at that row, not under the next day's divider", () => {
    // The floor row is the last millisecond of the 10th, so the marker's
    // time is the first of the 11th, the day of the newer row.
    const late = at(11, 0) - 1;
    const p = planFloorMarkers(
      [floor("floor", late + 1)],
      [at(11, 9), late],
      true,
      true,
      sameLocalDay,
    );
    assert.deepEqual(p.before.map(ids), [[], ["floor"]]);
    assert.deepEqual(p.beforeDate.map(ids), [[], []]);
    assert.deepEqual(p.breaksTail, [true, false]);
  });

  it("U3: an unknown stop reads loud, hidden and missing history read quiet", () => {
    const tone = (stop: string) =>
      timelineTone(
        "history_floor",
        historyFloorNotice(stop as HistoryStop).tone,
      );
    assert.equal(tone("hidden"), "quiet");
    assert.equal(tone("missing"), "quiet");
    assert.equal(tone("genesis"), "quiet");
    for (const stop of [
      "invalid",
      "anchor_mismatch",
      "conflict",
      "unanchored",
    ]) {
      assert.equal(tone(stop), "loud");
    }
    assert.equal(tone("zz_future_stop"), "loud");
    // A tone this list does not know, or none, is loud too
    assert.equal(timelineTone("history_floor", "zz_future_tone"), "loud");
    assert.equal(timelineTone("history_floor", undefined), "loud");
    assert.equal(timelineTone("history_floor", null), "loud");
    // No other marker is ever loud
    assert.equal(timelineTone("new_device", "loud"), "quiet");
    assert.equal(timelineTone("forced_removal", null), "quiet");
  });

  it("U3: the floor row takes its tone from historyFloorNotice and names no member", () => {
    assert.ok(!source.includes("S4-W4-0 placeholder"));

    const row = bodyOf(/function ProtectedTimelineRow\(/);
    assert.match(
      row,
      /timelineTone\(\s*marker\.kind,\s*marker\.kind === "history_floor"\s*\? historyFloorNotice\(marker\.stop\)\.tone\s*: null,\s*\)/,
    );
    assert.match(row, /tone=\{tone\(\)\}/);
    assert.match(row, /timelineGlyph\(props\.marker\.kind, tone\(\)\)/);
    assert.match(
      row,
      /const userId = marker\.kind === "history_floor" \? undefined : marker\.userId;/,
    );
    assert.match(
      row,
      /const user = userId \? c\.users\.get\(userId\) : undefined;/,
    );

    assert.match(
      bodyOf(/function timelineGlyph\(/),
      /case "history_floor":\s*return tone === "loud" \? "gpp_bad" : "key_off";/,
    );

    // Both tones are styled; an omitted key would apply no style at all
    const styles = source.slice(source.indexOf("const TimelineRow = styled("));
    assert.match(
      styles,
      /tone: \{\s*quiet: \{\s*fontStyle: "italic",\s*color: "var\(--md-sys-color-outline\)",\s*\},\s*loud: \{\s*fontStyle: "normal",\s*color: "var\(--md-sys-color-error\)",\s*\},\s*\},/,
    );
  });
});

describe("S4 verified history state", () => {
  const NO_BOUNDARY = { history_boundary: undefined, pre_history: undefined };

  it("U3: a verified state shows its boundary and its history setting", () => {
    assert.deepEqual(shown(nativeState()), {
      historyVisible: true,
      divider: { boundary: BOUNDARY, preHistory: "kept" },
    });
    assert.deepEqual(shown(nativeState({ pre_history: "wiped" })), {
      historyVisible: true,
      divider: { boundary: BOUNDARY, preHistory: "wiped" },
    });
    // A channel protected while empty has no boundary and no divider
    assert.deepEqual(shown(nativeState(NO_BOUNDARY)), {
      historyVisible: true,
      divider: null,
    });
  });

  it("U3: an unverified, missing or conflicted state shows no divider and no history wording", () => {
    // Not loaded
    assert.equal(shown(null), null);
    // The last list verify failed
    assert.equal(
      shown(nativeState(), { seatListError: "seat_list_invalid" }),
      null,
    );
    // The list on hand is signed by a signer the user has not accepted
    assert.equal(shown(nativeState({ verdict: "owner_changed" })), null);
    // A verdict this build does not know
    assert.equal(shown(nativeState({ verdict: "zz_future" })), null);
    // No list held
    assert.equal(shown(nativeState({ seat_list: null })), null);
    // The SDK holds the channel conflicted
    assert.equal(
      shown(nativeState(), { latch: { conflicted: true, wiped: false } }),
      null,
    );
    // An input that only claims to be verified is not
    for (const verified of [false, "true", 1, undefined]) {
      assert.equal(
        verifiedHistoryOf(
          {
            verified: verified as boolean,
            boundary: BOUNDARY,
            preHistory: "kept",
            timeLimit: 0,
          },
          "visible",
          null,
          NO_LATCH,
        ),
        null,
      );
    }
    assert.equal(verifiedHistoryOf(undefined, "visible", null, NO_LATCH), null);
  });

  it("U3: a wipe record the verified list does not confirm shows nothing, a verified wipe says wiped", () => {
    const wipedLatch = { conflicted: false, wiped: true };
    assert.equal(shown(nativeState(), { latch: wipedLatch }), null);
    assert.equal(shown(nativeState(NO_BOUNDARY), { latch: wipedLatch }), null);
    assert.deepEqual(
      shown(nativeState({ pre_history: "wiped" }), { latch: wipedLatch })
        ?.divider,
      { boundary: BOUNDARY, preHistory: "wiped" },
    );

    // The pin: another boundary, or wiped while the list says kept
    assert.equal(
      shown(nativeState(), { pin: { boundary: ulid(31), wiped: false } }),
      null,
    );
    assert.equal(
      shown(nativeState(), { pin: { boundary: BOUNDARY, wiped: true } }),
      null,
    );
    assert.equal(
      shown(nativeState(NO_BOUNDARY), {
        pin: { boundary: BOUNDARY, wiped: false },
      }),
      null,
    );
    assert.deepEqual(
      shown(nativeState(), { pin: { boundary: BOUNDARY, wiped: false } })
        ?.divider,
      { boundary: BOUNDARY, preHistory: "kept" },
    );
    assert.deepEqual(
      shown(nativeState({ pre_history: "wiped" }), {
        pin: { boundary: BOUNDARY, wiped: true },
      })?.divider,
      { boundary: BOUNDARY, preHistory: "wiped" },
    );
  });

  it("U3: the history wording follows the verified setting as it is now", () => {
    assert.deepEqual(historyVisibleOption(shown(nativeState())), {
      historyVisible: true,
    });
    // Left out, not false: the option is absent on every other state
    for (const history of [
      shown(nativeState({ history_setting: "hidden" })),
      shown(nativeState({ history_setting: undefined })),
      shown(nativeState({ history_setting: true })),
      shown(nativeState(), { seatListError: "seat_list_invalid" }),
      shown(nativeState({ verdict: "owner_changed" })),
      shown(nativeState(), { latch: { conflicted: true, wiped: false } }),
      shown(nativeState(), { latch: { conflicted: false, wiped: true } }),
      shown(null),
      undefined,
      { historyVisible: "true" as unknown as boolean },
    ]) {
      const opts = historyVisibleOption(history);
      assert.deepEqual(opts, {});
      assert.ok(!("historyVisible" in opts));
    }
  });

  it("U3: the divider and the wording read the verified state through nativeHistoryInput", () => {
    assert.equal(count(source, "nativeHistoryInput("), 1);
    // The definition and one call
    assert.equal(count(source, "verifiedHistoryOf("), 2);
    const hook = bodyOf(/function useVerifiedHistory\(/);
    assert.match(
      hook,
      /return verifiedHistoryOf\(\s*nativeHistoryInput\(view\.native, \{ seatListError: view\.seatListError \}\),\s*view\.native\?\.history_setting,\s*c\.protectedPins\.historyOf\(id\) \?\? null,\s*\{\s*conflicted: c\.protectedHistory\.isConflicted\(id\),\s*wiped: c\.protectedHistory\.isWiped\(id\),\s*\},\s*\);/,
    );
    assert.match(
      hook,
      /const view = protectedUiOf\(c\.e2ee\)\?\.protectedChannels\.get\(id\);\s*if \(!view\) return null;/,
    );

    // The divider: only on a protected transcript, only from the hook
    assert.match(
      source,
      /const verifiedHistory = useVerifiedHistory\(\(\) =>\s*protectedTranscript\(\) \? props\.channel\.id : undefined,\s*\);/,
    );
    assert.equal(count(source, "planBoundaryDivider("), 2);
    assert.match(
      source,
      /const boundary = protectedTranscript\(\)\s*\? planBoundaryDivider\(\{\s*idsNewestFirst: arr\.map\(\(message\) => message\.id\),\s*divider: verifiedHistory\(\)\?\.divider \?\? null,\s*atStart: atStart\(\),\s*atEnd: atEnd\(\),\s*dividerAfter,\s*\}\)\s*: null;/,
    );

    // The wording: the third argument of the one timelineCopy call
    assert.equal(count(source, "timelineCopy("), 1);
    const row = bodyOf(/function ProtectedTimelineRow\(/);
    assert.match(
      row,
      /const history = useVerifiedHistory\(\(\) => props\.marker\.channelId\);/,
    );
    assert.match(row, /historyVisibleOption\(history\(\)\),\s*\);/);
    assert.ok(!/historyVisible: true/.test(row));
  });
});

describe("S4 boundary divider placement", () => {
  const kept = { boundary: BOUNDARY, preHistory: "kept" } as const;
  const wiped = { boundary: BOUNDARY, preHistory: "wiped" } as const;
  const flags = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const;

  it("U3: with rows on both sides the divider sits directly below the newest row at or below the boundary", () => {
    for (const [s, e] of flags) {
      // The boundary row itself is loaded
      assert.deepEqual(plan([50, 40, 30, 20, 10], kept, s, e), {
        below: ulid(30),
        preHistory: "kept",
      });
      // It is not: the newest row below it
      assert.deepEqual(plan([50, 40, 25, 20, 10], kept, s, e), {
        below: ulid(25),
        preHistory: "kept",
      });
      assert.deepEqual(plan([31, 29], kept, s, e), {
        below: ulid(29),
        preHistory: "kept",
      });
    }
  });

  it("U3: with every row at or below the boundary the divider needs the end of the conversation", () => {
    for (const s of [true, false]) {
      assert.deepEqual(plan([30, 20, 10], kept, s, true), {
        below: ulid(30),
        preHistory: "kept",
      });
      assert.deepEqual(plan([20, 10], wiped, s, true), {
        below: ulid(20),
        preHistory: "wiped",
      });
      // A newer row at or below the boundary may still be unloaded
      assert.equal(plan([30, 20, 10], kept, s, false), null);
      assert.equal(plan([20, 10], kept, s, false), null);
      assert.equal(plan([20, 10], wiped, s, false), null);
    }
  });

  it("U3: with every row above the boundary there is no kept divider", () => {
    for (const [s, e] of flags) {
      assert.equal(plan([50, 40, 31], kept, s, e), null);
      assert.equal(plan([], kept, s, e), null);
    }
  });

  it("U3: after a wipe with no row at or below the boundary the divider sits at the top once paging ended", () => {
    for (const e of [true, false]) {
      assert.deepEqual(plan([50, 40, 31], wiped, true, e), {
        below: null,
        preHistory: "wiped",
      });
      assert.deepEqual(plan([], wiped, true, e), {
        below: null,
        preHistory: "wiped",
      });
      // Backward paging has not ended
      assert.equal(plan([50, 40, 31], wiped, false, e), null);
      assert.equal(plan([], wiped, false, e), null);
    }
    // A row at or below the boundary is still loaded: under that row
    assert.deepEqual(plan([50, 40, 20], wiped, true, true), {
      below: ulid(20),
      preHistory: "wiped",
    });
    // A boundary that is not a ULID has no divider anywhere
    const bad = { boundary: "not-a-ulid", preHistory: "wiped" } as const;
    assert.equal(plan([50, 40], bad, true, true), null);
    assert.equal(plan([], { ...bad, boundary: "" }, true, true), null);
  });

  it("U3: no divider while the state is not verified", () => {
    const loaded = [50, 40, 30, 20, 10];
    for (const history of [
      shown(null),
      shown(nativeState(), { seatListError: "seat_list_invalid" }),
      shown(nativeState({ verdict: "owner_changed" })),
      shown(nativeState({ seat_list: null })),
      shown(nativeState(), { latch: { conflicted: true, wiped: false } }),
      shown(nativeState(), { latch: { conflicted: false, wiped: true } }),
      shown(nativeState({ pre_history: "wiped" }), {
        seatListError: "seat_list_invalid",
      }),
    ]) {
      for (const [s, e] of flags) {
        assert.equal(plan(loaded, history?.divider ?? null, s, e), null);
        assert.equal(plan([], history?.divider ?? null, s, e), null);
      }
    }
    // The same rows with the verified state do get one
    assert.notEqual(
      plan(loaded, shown(nativeState())?.divider ?? null, true, true),
      null,
    );
    // A kind this list does not know is never drawn
    assert.equal(
      plan(
        loaded,
        { boundary: BOUNDARY, preHistory: "zz" as unknown as "kept" },
        true,
        true,
      ),
      null,
    );
  });

  it("U3: the divider entry is pushed right under its row and rendered through MessageDivider", () => {
    const memo = between(
      "const messagesWithTail = createMemo<ListEntry[]>(() => {",
      "return messagesWithTail.reverse();",
    );
    // The list is built newest first: what is pushed before a row shows
    // below it. Markers of the newer side first, then the divider, then
    // the row.
    const markers = memo.indexOf(
      "pushTimelineMarkers(timeline?.before[index]);",
    );
    const push = memo.search(
      /if \(boundary && boundary\.below === message\.id\) \{\s*pushBoundaryDivider\(\);\s*\}/,
    );
    const row = memo.indexOf(
      'if (message.author?.relationship === "Blocked") {',
    );
    assert.ok(markers !== -1 && push !== -1 && row !== -1);
    assert.ok(markers < push && push < row, "the divider is not under its row");
    assert.equal(count(memo, "pushBoundaryDivider()"), 2);

    // At the top: after everything else was pushed
    const top = memo.search(
      /if \(boundary && boundary\.below === null\) \{\s*pushBoundaryDivider\(\);\s*\}/,
    );
    assert.ok(top > memo.indexOf("pushTimelineMarkers(timeline?.trailing);"));
    assert.ok(top > memo.lastIndexOf("createBlockedMessageCount();"));

    // Blocked rows stay on their side, and the row under it starts a chain
    assert.match(
      memo,
      /const pushBoundaryDivider = \(\) => \{\s*if \(!boundary\) return;\s*createBlockedMessageCount\(\);\s*messagesWithTail\.push\(/,
    );
    assert.match(
      memo,
      /if \(boundary && next && boundary\.below === next\.id\) \{\s*tail = false;/,
    );

    // Its own entry kind: never the date or unread divider, never stripped
    assert.match(
      memo,
      /t: 4,\s*kind: "protected_boundary",\s*preHistory: boundary\.preHistory,/,
    );
    assert.match(memo, /if \(messagesWithTail\[0\]\?\.t === 1\) \{/);
    assert.match(
      source,
      /<Match when=\{local\.t === 4\}>\s*<MessageDivider\s*protectedBoundary=\{\(other as ListEntry & \{ t: 4 \}\)\.preHistory\}\s*\/>/,
    );
    assert.equal(count(source, "protectedBoundary="), 1);
    assert.match(
      source,
      /<Match when=\{local\.t === 1\}>\s*<MessageDivider \{\.\.\.\(other as ListEntry & \{ t: 1 \}\)\} \/>/,
    );
  });
});

// ---------------------------------------------------------------------------
// S4 fix lane FXU: rows of another channel (A1), list order (A5), the walk
// retry on load (C4), the emptied list (C5), the divider label (C11)
// ---------------------------------------------------------------------------

describe("FXU rows of another channel", () => {
  const row = (id: string, channelId?: string) => ({ id, channelId });

  it("FXU: a protected list keeps only rows that name its own channel", () => {
    // The audit's page: the server answers `GET /channels/X/messages` with
    // a row whose channel is Z.
    const page = [row("3", "X"), row("2", "Z"), row("1", "X")];
    assert.deepEqual(
      rowsOfChannel(page, "X", true).map((r) => r.id),
      ["3", "1"],
    );
    // A row with no channel at all is not this channel's.
    assert.deepEqual(rowsOfChannel([row("1"), row("2", "X")], "X", true), [
      row("2", "X"),
    ]);
    assert.deepEqual(rowsOfChannel([row("1", "Z")], "X", true), []);
    assert.deepEqual(rowsOfChannel([], "X", true), []);
    // The kept rows are the same objects, in the same order.
    assert.equal(rowsOfChannel(page, "X", true)[0], page[0]);
  });

  it("FXU: an ordinary channel keeps its rows as they came", () => {
    const page = [row("3", "Y"), row("2", "Z"), row("1", "Y")];
    assert.deepEqual(rowsOfChannel(page, "Y", false), page);
    // Only a literal true takes the protected rule
    assert.deepEqual(rowsOfChannel(page, "Y", 1 as unknown as boolean), page);
  });

  it("FX2U: every fetch site checks pre-emption before it filters rows", () => {
    // RC3: the filter logs the rows it drops, so a load that was
    // pre-empted by a channel switch must stop before it runs.
    for (const header of [
      /async function caseInitialLoad\(/,
      /async function caseFetchUpwards\(/,
      /async function caseFetchDownwards\(/,
      /async function caseJumpToBottom\(/,
      /async function caseJumpToMessage\(/,
    ]) {
      const body = bodyOf(header);
      const check = body.indexOf("if (preempted())");
      const filter = body.indexOf("ownRows(");
      assert.ok(check !== -1, `${header} has no pre-emption check`);
      assert.ok(filter !== -1, `${header} lists unfiltered rows`);
      assert.ok(check < filter, `${header} filters before the check`);
      assert.equal(count(body, "if (preempted())"), 1);
      assert.equal(count(body, "ownRows("), 1);
    }
  });

  it("FX3U: a cached list is restored only through the cache guard and the list's own step, and an empty page marks the start", () => {
    // RC1 as narrowed by R-W4-43: the cache hands an entry back only through
    // restorableEntry (messageCacheLive.test.ts: no rows = restorable only
    // with `atStart`), which reads the position the list stored ...
    const cacheSource = readFileSync(join(here, "MessageCache.tsx"), "utf8");
    assert.match(
      cacheSource,
      /type ChannelState = \{\s*messages: Message\[\];\s*atStart: boolean;/,
    );
    assert.match(
      source,
      /cache!\.manage\(channel, \{\s*messages: messages\(\),\s*atStart: atStart\(\),/,
    );
    // ... and the list drops an empty entry on a protected or pinned channel
    // before anything else reads it (restorableForList, same spec file)
    assert.match(
      source,
      /import \{ restorableForList \} from "\.\/messageCacheLive";/,
    );
    assert.equal(count(source, "cache!.unmanage("), 1);
    assert.equal(count(source, "restorableForList("), 1);
    assert.match(
      bodyOf(/async function caseInitialLoad\(/),
      /const restored = restorableForTrust\(\s*restorableForList\(\s*cache!\.unmanage\(props\.channel\) \?\? undefined,\s*protectedOrPinned\(\),\s*\),\s*currentTrust\(\),\s*isTrustedMessage,\s*\);\s*const existingState = restored\.entry;/,
    );
    assert.match(
      cacheSource,
      /unmanage\(channel\) \{\s*if \(cache\[channel\.id\]\) \{\s*const state = cache\[channel\.id\];\s*delete cache\[channel\.id\];/,
    );
    assert.match(
      cacheSource,
      /return restorableEntry\(state, \(id\) => messages\.has\(id\)\);/,
    );
    assert.ok(!/return state\b/.test(cacheSource));

    // ... and with no entry the load fetches, once, and an empty page is
    // the start of the conversation (the start card), not another request
    const initial = bodyOf(/async function caseInitialLoad\(/);
    assert.match(
      initial,
      /const useExistingState = existingState && !nearby;\s*if \(useExistingState\) \{\s*messages = existingState\.messages;/,
    );
    assert.equal(count(initial, "fetchMessagesWithUsers("), 1);
    assert.match(
      initial,
      /else if \(\s*!useExistingState &&\s*pageEndsHistory\(\s*messages\.length,\s*INITIAL_FETCH_LIMIT,\s*protectedTranscript\(\),\s*\)\s*\) \{\s*setStart\(true\);/,
    );
    assert.ok(!initial.includes("caseInitialLoad("));
    assert.ok(!initial.includes("reloadIfEmptied("));
    // An empty page ends history on every kind of channel
    for (const protectedOrPinned of [true, false]) {
      assert.equal(pageEndsHistory(0, 50, protectedOrPinned), true);
    }
  });

  it("FXU: every fetch and the cache restore go through the row filter", () => {
    const own = bodyOf(/function ownRows\(rows: MessageInterface\[\]\)/);
    assert.match(
      own,
      /const kept = rowsOfChannel\(rows, channelId, protectedOrPinned\(\)\);/,
    );
    assert.match(own, /return kept;/);
    // Logged by count, never the rows
    assert.match(own, /count: rows\.length - kept\.length,/);
    assert.ok(!/\.content|\.id\b/.test(own.replace("props.channel.id", "")));

    // The definition and five calls: the initial load (fetch and restore),
    // both paging directions, both jumps
    assert.equal(count(source, "ownRows("), 6);
    assert.equal(count(source, "fetchMessagesWithUsers("), 5);

    const initial = bodyOf(/async function caseInitialLoad\(/);
    assert.match(initial, /messages = ownRows\(messages\);/);
    // After either branch produced the rows, before anything reads them
    assert.ok(
      initial.indexOf("messages = ownRows(messages);") >
        initial.indexOf(".then(({ messages }) => messages);"),
    );
    assert.ok(
      initial.indexOf("messages = ownRows(messages);") <
        initial.indexOf("messages.findIndex("),
    );

    for (const header of [
      /async function caseFetchUpwards\(/,
      /async function caseFetchDownwards\(/,
    ]) {
      const body = bodyOf(header);
      const filter = body.indexOf(
        "result.messages = ownRows(result.messages);",
      );
      assert.ok(filter !== -1, `${header} lists unfiltered rows`);
      // Before the page is judged or listed
      assert.ok(filter < body.indexOf("const stalled = pageStalled("));
    }

    for (const header of [
      /async function caseJumpToBottom\(/,
      /async function caseJumpToMessage\(/,
    ]) {
      const body = bodyOf(header);
      assert.match(body, /const fetched = await props\.channel/);
      assert.match(body, /const messages = ownRows\(fetched\.messages\);/);
      assert.equal(count(body, "fetched.messages"), 1);
    }

    // A live row is listed only for its own channel (as before)
    assert.match(
      bodyOf(/function onMessage\(message: MessageInterface\)/),
      /^\{\s*if \(message\.channelId === props\.channel\.id\) \{/,
    );
  });

  it("FXU: each row is rendered with the channel of its list", () => {
    assert.match(
      source,
      /<Entry\s*\{\.\.\.entry\}\s*listChannelId=\{props\.channel\.id\}/,
    );
    const entry = bodyOf(/function Entry\(/);
    assert.match(
      entry,
      /<Message\s*\{\.\.\.\(other as ListEntry & \{ t: 0 \}\)\}\s*listChannelId=\{local\.listChannelId\}/,
    );
    assert.match(entry, /splitProps\(props, \[\s*"t",\s*"listChannelId",/);
    assert.equal(count(source, "<Message\n"), 1);
  });
});

describe("FXU list order", () => {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const rows = (...n: number[]) => n.map((i) => ({ id: ulid(i) }));

  it("FXU: rows are listed newest first by id, whatever order they came in", () => {
    // The audit's jump page: an injected row at or below the boundary
    // comes first in the server's order.
    const page = rows(10, 42, 41, 40);
    assert.deepEqual(ids(newestFirst([page])), ids(rows(42, 41, 40, 10)));
    // Several lists become one
    assert.deepEqual(
      ids(newestFirst([rows(5, 9), rows(7), []])),
      ids(rows(9, 7, 5)),
    );
    assert.deepEqual(newestFirst([]), []);
    // The inputs are left alone
    assert.deepEqual(ids(page), ids(rows(10, 42, 41, 40)));
    // With the sorted list the divider is under the right row
    const plan = planBoundaryDivider({
      idsNewestFirst: ids(newestFirst([page])),
      divider: { boundary: ulid(30), preHistory: "kept" },
      atStart: false,
      atEnd: false,
      dividerAfter,
    });
    assert.deepEqual(plan, { below: ulid(10), preHistory: "kept" });
  });

  it("FXU: every setter that takes fetched rows sorts them", () => {
    assert.match(
      bodyOf(/function setMessagesSafely\(/),
      /^\{\s*setMessages\(newestFirst\(messagesArr\)\);\s*\}$/,
    );
    // No fetched list is stored as it came
    assert.equal(count(source, "setMessages(messages)"), 0);
    assert.ok(!source.includes("result.messages.reverse()"));

    // The jump load (initial load around a message)
    assert.match(
      bodyOf(/async function caseInitialLoad\(/),
      /else \{\s*setMessagesSafely\(messages\);\s*\}/,
    );
    assert.match(
      bodyOf(/async function caseJumpToMessage\(/),
      /setMessagesSafely\(messages\);/,
    );
    assert.match(
      bodyOf(/async function caseFetchUpwards\(/),
      /setMessagesSafely\(messages\(\), result\.messages\);/,
    );
    assert.match(
      bodyOf(/async function caseFetchDownwards\(/),
      /setMessagesSafely\(result\.messages, messages\(\)\);/,
    );
    // A live row on a protected or pinned channel is placed by its id
    assert.match(
      bodyOf(/function onMessage\(message: MessageInterface\)/),
      /if \(protectedOrPinned\(\)\) \{\s*setMessagesSafely\(\[message\], messages\(\)\);\s*\} else \{\s*setMessages\(\[message, \.\.\.messages\(\)\]\);/,
    );
  });
});

describe("FXU history walk retry on load", () => {
  const base = {
    protectedChannel: true,
    historyFlag: true,
    historyWalk: "retry_later" as string | undefined,
  };

  it("FXU: an initial load asks for the walk only when the last one has to be retried", () => {
    assert.equal(walkOnInitialLoad(base), true);
    for (const historyWalk of ["idle", "running", "zz_future", undefined]) {
      assert.equal(walkOnInitialLoad({ ...base, historyWalk }), false);
    }
  });

  it("FXU: no walk on load with the history flag off or outside a protected channel", () => {
    assert.equal(walkOnInitialLoad({ ...base, historyFlag: false }), false);
    assert.equal(
      walkOnInitialLoad({ ...base, protectedChannel: false }),
      false,
    );
    assert.equal(
      walkOnInitialLoad({ ...base, historyFlag: "true" as unknown as boolean }),
      false,
    );
    assert.equal(
      walkOnInitialLoad({ ...base, protectedChannel: 1 as unknown as boolean }),
      false,
    );
  });

  it("FXU: the walk is asked once per initial load, after the load, never in a loop", () => {
    const helper = bodyOf(/function walkHistoryOnLoad\(/);
    assert.match(helper, /const wanted = walkOnInitialLoad\(\{/);
    assert.equal(count(helper, "walkHistory("), 1);
    assert.match(helper, /if \(wanted\) ui\.walkHistory\(channelId\);/);
    assert.match(
      helper,
      /historyFlag: ui\.protectedFlag\(\)\.historySetting === true,/,
    );
    assert.match(
      helper,
      /historyWalk: ui\.protectedChannels\.get\(channelId\)\?\.historyWalk,/,
    );
    assert.match(helper, /protectedChannel: protectedTranscript\(\),/);
    assert.ok(!/\bwhile\s*\(|\bfor\s*\(/.test(helper));
    // A failure is logged with the channel id only
    assert.match(helper, /catch \{\s*console\.error\("\[protected\]/);

    // The definition and one call, from the initial load, once the load is
    // over. Not from an effect, a memo or a paging path.
    assert.equal(count(source, "walkHistoryOnLoad("), 2);
    const initial = bodyOf(/async function caseInitialLoad\(/);
    const call = initial.indexOf("walkHistoryOnLoad();");
    assert.ok(call !== -1, "not called from the initial load");
    assert.ok(
      call >
        initial.indexOf(
          "collectedMessages = undefined;\n\n      // One marker",
        ),
    );
    assert.ok(call > initial.lastIndexOf("setMessagesSafely("));
    assert.ok(call < initial.indexOf("} catch {"));
    assert.ok(!/\bwhile\s*\(|\bdo\s*\{/.test(initial));
    assert.ok(!/caseInitialLoad\(/.test(initial));
  });
});

describe("FXU emptied list", () => {
  // A protected or pinned list: the only kind that reloads (R-W4-43)
  const idle = {
    protectedOrPinned: true,
    before: 3,
    after: 0,
    fetching: false,
    reloads: 0,
  };
  const guarded = (i: {
    before: number;
    after: number;
    fetching: boolean;
    reloads: number;
  }) => reloadAfterEmptied({ protectedOrPinned: true, ...i });

  it("FX3U: an ordinary channel: deleting the last listed row does not reload", () => {
    const ordinary = { ...idle, protectedOrPinned: false };
    assert.equal(reloadAfterEmptied(ordinary), false);
    // Whatever the counts, the fetch state and the budget say
    for (const before of [1, 2, 3, 150]) {
      for (const reloads of [0, 1]) {
        assert.equal(
          reloadAfterEmptied({ ...ordinary, before, reloads }),
          false,
        );
      }
    }
    // Only a literal true is a protected or pinned list
    for (const value of [undefined, null, 1, "true"]) {
      assert.equal(
        reloadAfterEmptied({ ...idle, protectedOrPinned: value as never }),
        false,
      );
    }
    // The same delete on a protected or pinned list does reload
    assert.equal(reloadAfterEmptied(idle), true);

    // The list passes what the SDK says about its own channel, read at the
    // delete, and the helper has no other way to a load
    const helper = bodyOf(/function reloadIfEmptied\(before: number\)/);
    assert.match(
      helper,
      /reloadAfterEmptied\(\{\s*protectedOrPinned: protectedOrPinned\(\),/,
    );
    assert.equal(count(helper, "caseInitialLoad("), 1);
    assert.match(
      bodyOf(/function protectedOrPinned\(\): boolean/),
      /^\{\s*return client\(\)\.isProtectedChannel\(props\.channel\.id\);\s*\}$/,
    );
    // The gate is the first thing the rule reads
    assert.match(
      bodyOf(/function reloadAfterEmptied\(i: \{/),
      /^\{\s*if \(i\.protectedOrPinned !== true\) return false;/,
    );
  });

  it("FXU: a delete that empties the list asks for a fresh load", () => {
    assert.equal(reloadAfterEmptied(idle), true);
    assert.equal(reloadAfterEmptied({ ...idle, before: 1 }), true);
    // Rows are left, or none were listed before
    assert.equal(reloadAfterEmptied({ ...idle, after: 1 }), false);
    assert.equal(reloadAfterEmptied({ ...idle, before: 0 }), false);
    assert.equal(reloadAfterEmptied({ ...idle, before: Number.NaN }), false);
  });

  it("FXU: no reload while a fetch is running", () => {
    assert.equal(reloadAfterEmptied({ ...idle, fetching: true }), false);
    // Anything but a literal false counts as fetching
    assert.equal(
      reloadAfterEmptied({ ...idle, fetching: undefined as never }),
      false,
    );
  });

  it("FXU: a list that keeps being emptied reloads once, not in a loop", () => {
    // The decisions of `reloadIfEmptied`: a server that answers every load
    // with rows which are then deleted again.
    let reloads = 0;
    let requests = 0;
    let listed = 3;
    for (let round = 0; round < 1_000; round++) {
      const before = listed;
      listed = 0;
      if (guarded({ before, after: listed, fetching: false, reloads })) {
        reloads++;
        requests++;
        listed = 3;
      }
    }
    assert.equal(requests, 1);

    // A channel that is really empty: the one reload brings nothing, and a
    // later delete finds no listed row to start from.
    reloads = 0;
    requests = 0;
    listed = 3;
    for (let round = 0; round < 1_000; round++) {
      const before = listed;
      listed = 0;
      if (guarded({ before, after: listed, fetching: false, reloads })) {
        reloads++;
        requests++;
      }
    }
    assert.equal(requests, 1);
    // Even with the budget back, an empty list asks for nothing
    assert.equal(
      guarded({ before: 0, after: 0, fetching: false, reloads: 0 }),
      false,
    );
    assert.equal(reloadAfterEmptied({ ...idle, reloads: 1 }), false);
    assert.equal(reloadAfterEmptied({ ...idle, reloads: 7 }), false);
  });

  it("FXU: both delete handlers reload an emptied list, and only a channel switch or a live row gives the reload back", () => {
    const helper = bodyOf(/function reloadIfEmptied\(before: number\)/);
    assert.match(
      helper,
      /const wanted = reloadAfterEmptied\(\{\s*protectedOrPinned: protectedOrPinned\(\),\s*before,\s*after: messages\(\)\.length,\s*fetching: fetching\(\) !== undefined,\s*reloads: emptiedReloads,\s*\}\);/,
    );
    assert.match(
      helper,
      /if \(!wanted\) return;\s*emptiedReloads\+\+;\s*caseInitialLoad\(\);/,
    );

    // The definition and the two delete handlers
    assert.equal(count(source, "reloadIfEmptied("), 3);
    for (const header of [
      /function onMessageDelete\(message: \{ id: string; channelId: string \}\)/,
      /function onMessageDeleteBulk\(/,
    ]) {
      const body = bodyOf(header);
      assert.match(
        body,
        /const before = messages\(\)\.length;\s*setMessages\(\(messages\) =>[\s\S]{0,200}?\);\s*reloadIfEmptied\(before\);/,
      );
    }
    // Never from an effect or the list memo
    assert.ok(
      !between(
        "const messagesWithTail = createMemo<ListEntry[]>(() => {",
        "return messagesWithTail.reverse();",
      ).includes("reloadIfEmptied"),
    );

    // The budget: spent in the helper, given back in two places only
    assert.equal(count(source, "emptiedReloads++"), 1);
    assert.equal(count(source, "emptiedReloads = 0;"), 3);
    assert.match(
      source,
      /\(channel\) => \{\s*emptiedReloads = 0;\s*caseInitialLoad\(props\.highlightedMessageId\(\)\);/,
    );
    assert.match(
      bodyOf(/function onMessage\(message: MessageInterface\)/),
      /emptiedReloads = 0;\s*if \(collectedMessages\) \{/,
    );
    // The load itself never gives it back
    assert.ok(
      !bodyOf(/async function caseInitialLoad\(/).includes("emptiedReloads"),
    );
  });
});

describe("FXU boundary divider label", () => {
  const divider = readFileSync(
    join(
      here,
      "../../../../ui/components/features/messaging/elements/MessageDivider.tsx",
    ),
    "utf8",
  );

  it("FXU: the boundary label stays on one line and ends in an ellipsis", () => {
    const from = divider.indexOf('const Boundary = styled("span", {');
    assert.ok(from !== -1, "missing the Boundary label");
    const label = divider.slice(from, divider.indexOf("\n});", from));
    for (const rule of [
      /whiteSpace: "nowrap",/,
      /textOverflow: "ellipsis",/,
      /overflow: "hidden",/,
      /minWidth: 0,/,
      /maxWidth: "100%",/,
    ]) {
      assert.match(label, rule);
    }
    // String tags only (a styled component at module scope is a blank page)
    for (const m of divider.matchAll(/\bstyled\(\s*([^,\s]+)/g)) {
      assert.match(m[1], /^"/, `styled(${m[1]}, ...)`);
    }
    assert.ok(!divider.includes("use:floating"));
  });

  it("FXU: the boundary divider is a separator named by its label", () => {
    assert.match(
      divider,
      /role=\{props\.protectedBoundary \? "separator" : undefined\}/,
    );
    assert.match(
      divider,
      /aria-label=\{\s*props\.protectedBoundary\s*\? dividerCopy\(props\.protectedBoundary\)\s*: undefined\s*\}/,
    );
    // The label itself is still the copy function's, nothing new
    assert.match(
      divider,
      /\{\(boundary\) => <Boundary>\{dividerCopy\(boundary\(\)\)\}<\/Boundary>\}/,
    );
    assert.equal(count(divider, "dividerCopy("), 2);
    assert.ok(!/\bt`|<Trans>(?!NEW)/.test(divider));
  });
});
