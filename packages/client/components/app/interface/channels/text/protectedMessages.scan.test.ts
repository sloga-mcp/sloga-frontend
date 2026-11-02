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
