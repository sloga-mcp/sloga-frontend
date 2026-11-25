// Spec for `protectedHistoryWalk.ts` (S4-W4 lane L1w): the history walk's
// trigger table, the probe rule, the commit shape native takes, and the walk
// loop driven through fake ports (a small model of the server's link pages
// and of native `e2ee_text_history_import` at desktop b688f121). Nothing here
// talks to a server or to native.
//
// Run from packages/client:
//   node --conditions=browser --test components/client/protectedHistoryWalk.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ProbeSource,
  WalkGroupView,
  WalkPorts,
} from "./protectedHistoryWalk.ts";
import {
  WALK_MAX_BRIDGE_TARGETS,
  WALK_MAX_HOLDERS,
  WALK_MAX_LINK_ROWS,
  WALK_MAX_PROBES,
  WALK_MAX_START_BUMPS,
  commitForNative,
  isMissingCommandError,
  pickProbes,
  runWalk,
  walkTrigger,
} from "./protectedHistoryWalk.ts";
import type {
  EncryptedPayload,
  HistoryImportStep,
  HistoryImported,
  HistoryLinkWire,
  HistoryStop,
  NativeError,
} from "./protectedTextTypes.ts";

const G = "a".repeat(64);
const P = "b".repeat(64);
const OTHER = "c".repeat(64);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function unknownEpoch(
  epoch: number,
  current: number,
  extra: Record<string, unknown> = {},
): NativeError {
  return {
    type: "unknown_epoch",
    group_id: G,
    epoch,
    oldest_held: null,
    current,
    removed_self: false,
    ...extra,
  } as NativeError;
}

function view(extra: Partial<WalkGroupView> = {}): WalkGroupView {
  return { state: "active", verdict: "ok", groupId: G, epoch: 50, ...extra };
}

function enc(groupId: string, epoch: number): EncryptedPayload {
  return {
    v: 1,
    group_id: groupId,
    epoch,
    sender_device_id: "d".repeat(32),
    nonce: "n",
    ciphertext: "c",
    sig: "s",
  };
}

function row(
  id: string,
  authorId: string,
  groupId: string,
  epoch: number,
): ProbeSource {
  return { id, authorId, nonce: `cid-${id}`, encrypted: enc(groupId, epoch) };
}

function link(
  groupId: string,
  epoch: number,
  writer: string,
  prev?: { groupId: string; epoch: number },
): HistoryLinkWire {
  return {
    group_id: groupId,
    epoch,
    prev_group_id: prev?.groupId ?? groupId,
    prev_epoch: prev?.epoch ?? epoch - 1,
    nonce: "n",
    ciphertext: "c",
    writer_user_id: writer,
    writer_device_id: "d".repeat(32),
    signature: "s",
  };
}

function commitRow(groupId: string, epoch: number): Record<string, unknown> {
  return {
    group_id: groupId,
    epoch,
    committer: { user_id: "U1", device_id: "D1" },
    commit: `commit-${epoch}`,
    added: [{ user_id: "U2", device_id: "D2" }],
    removed: [],
    created_at: 1_790_000_000_000 + epoch,
  };
}

const key = (groupId: string, epoch: number) => `${groupId}:${epoch}`;

interface LogLine {
  level: "warn" | "error";
  msg: string;
  ids: Record<string, string | number>;
}

interface Call {
  groupId: string;
  session: string | null;
  steps: HistoryImportStep[];
}

interface WorldOptions {
  /** The server's stored links. */
  links?: HistoryLinkWire[];
  /** Rows per link page (an epoch is never split). */
  pageSize?: number;
  /** Stored commit rows by `group:epoch`; absent = pruned. */
  commits?: Map<string, unknown>;
  /** The paged message history. */
  rows?: ProbeSource[];
  /** Native: the holders that can start a session. */
  held?: (groupId: string, epoch: number) => boolean;
  /** Native: the holder whose link carries a held epoch. */
  anchor?: { groupId: string; epoch: number };
  /** Native: a stop met while processing that holder. */
  stops?: Map<string, string>;
  /** Native: the predecessor of a group and the epoch its bridge names. */
  bridges?: Map<string, { groupId: string; epoch: number }>;
  /** Native: epoch 0 of this group is the channel's genesis. */
  genesisGroup?: string;
  /** Native: rejections thrown by the next import calls, in order. */
  throws?: unknown[];
  /** Native: refusals reported with the answer of the first call. */
  refusals?: HistoryImported["refused"];
}

/** A small model of the server and of native's session rules. */
function world(opts: WorldOptions = {}) {
  const links = opts.links ?? [];
  const pageSize = opts.pageSize ?? 200;
  const throws = [...(opts.throws ?? [])];
  const calls: Call[] = [];
  const logs: LogLine[] = [];
  const linkCalls: { groupId: string; before: number | null }[] = [];
  const pins: { userId: string; deviceId: string }[] = [];
  const sessions = new Map<
    string,
    {
      groupId: string;
      expected: { groupId: string; epoch: number };
      staged: { group_id: string; epoch: number }[];
    }
  >();
  let pinAnswer = true;
  let refusals = opts.refusals ?? [];

  const ports: WalkPorts = {
    async links(groupId, before) {
      linkCalls.push({ groupId, before });
      const below = links
        .filter(
          (l) =>
            l.group_id === groupId && (before === null || l.epoch < before),
        )
        .sort((a, b) => b.epoch - a.epoch);
      const page: HistoryLinkWire[] = [];
      for (const l of below) {
        const sameEpoch = below.filter((o) => o.epoch === l.epoch).length;
        const open = page.some((o) => o.epoch === l.epoch);
        if (!open && page.length > 0 && page.length + sameEpoch > pageSize) {
          break;
        }
        page.push(l);
      }
      return page.length === 0 ? "end" : page;
    },
    async commit(groupId, epoch) {
      return opts.commits?.get(key(groupId, epoch)) ?? null;
    },
    async probeRows() {
      return opts.rows ?? [];
    },
    async importSteps(groupId, session, steps) {
      calls.push({ groupId, session, steps });
      if (throws.length > 0) throw throws.shift();
      const rows = steps.reduce((n, s) => n + s.candidates.length, 0);
      if (rows > 200) throw { type: "invalid_argument", field: "steps" };
      if (steps.some((s) => (s.probes ?? []).length > 3)) {
        throw { type: "invalid_argument", field: "probes" };
      }
      let id = session;
      let held = id === null ? undefined : sessions.get(id);
      if (held !== undefined && held.groupId !== groupId) held = undefined;
      if (held === undefined) {
        const first = steps[0];
        if (first === undefined || first.holder_group_id !== groupId) {
          throw { type: "invalid_argument", field: "steps" };
        }
        if (!(opts.held ?? (() => true))(groupId, first.holder_epoch)) {
          throw { type: "invalid_argument", field: "holder_epoch" };
        }
        id = `s${sessions.size + 1}`;
        held = {
          groupId,
          expected: { groupId, epoch: first.holder_epoch },
          staged: [],
        };
      }
      // All or nothing: work on a copy, keep it only on an answer
      let expected = held.expected;
      let staged = [...held.staged];
      const imported: { group_id: string; epoch: number }[] = [];
      let end: { stop: string | null } | null = null;
      for (const step of steps) {
        if (end !== null) break;
        const g = step.holder_group_id;
        const e = step.holder_epoch;
        if (g !== expected.groupId || e !== expected.epoch) {
          throw { type: "invalid_argument", field: "steps" };
        }
        if (staged.length > 0 && (step.probes ?? []).length > 0) {
          imported.push(...staged);
          staged = [];
        }
        const stop = opts.stops?.get(key(g, e));
        if (stop !== undefined) end = { stop };
        else if (e === 0 && g === opts.genesisGroup) end = { stop: "genesis" };
        else if (step.candidates.length === 0) end = { stop: "missing" };
        else if (opts.anchor?.groupId === g && opts.anchor.epoch === e) {
          imported.push(...staged);
          staged = [];
          end = { stop: null };
        } else {
          const bridge = opts.bridges?.get(g);
          if (e === 0 && bridge === undefined) end = { stop: "invalid" };
          else {
            expected =
              e === 0 && bridge !== undefined
                ? bridge
                : { groupId: g, epoch: e - 1 };
            staged.push({ group_id: expected.groupId, epoch: expected.epoch });
          }
        }
      }
      if (end === null) {
        sessions.set(id as string, { groupId, expected, staged });
      }
      const refused = refusals;
      refusals = [];
      return {
        session: id as string,
        need_more: end === null,
        imported,
        floor:
          end === null
            ? null
            : { group_id: expected.groupId, epoch: expected.epoch },
        stopped: (end?.stop ?? null) as HistoryStop | null,
        refused,
      };
    },
    async pin(userId, deviceId) {
      pins.push({ userId, deviceId });
      return pinAnswer;
    },
    log(level, msg, ids) {
      logs.push({ level, msg, ids });
    },
  };
  return {
    ports,
    calls,
    logs,
    linkCalls,
    pins,
    setPinAnswer(v: boolean) {
      pinAnswer = v;
    },
    holders: () =>
      calls.flatMap((c) =>
        c.steps.map((s) => key(s.holder_group_id, s.holder_epoch)),
      ),
  };
}

/** One candidate per holder epoch `from` down to `to`, group G. */
function chain(from: number, to: number, writer = "W1"): HistoryLinkWire[] {
  const out: HistoryLinkWire[] = [];
  for (let e = from; e >= to; e -= 1) out.push(link(G, e, writer));
  return out;
}

// ---------------------------------------------------------------------------
// walkTrigger
// ---------------------------------------------------------------------------

test("walkTrigger: truth table", () => {
  const walk = (missingEpoch: number) => ({
    kind: "walk",
    groupId: G,
    missingEpoch,
  });
  const cases: [string, NativeError, WalkGroupView, unknown][] = [
    [
      "removed_self wins over everything",
      unknownEpoch(3, 50, { removed_self: true }),
      view(),
      { kind: "removed_self" },
    ],
    [
      "removed_self on a left group",
      unknownEpoch(60, 50, { removed_self: true }),
      view({ state: "left" }),
      { kind: "removed_self" },
    ],
    ["below current, active", unknownEpoch(3, 50), view(), walk(3)],
    [
      "below current, any state",
      unknownEpoch(3, 50),
      view({ state: "poisoned", verdict: "poisoned" }),
      walk(3),
    ],
    [
      "below current, another held group",
      unknownEpoch(3, 50),
      view({ groupId: OTHER }),
      walk(3),
    ],
    [
      "above current, active",
      unknownEpoch(51, 50),
      view(),
      { kind: "catch_up" },
    ],
    [
      "above current, superseded",
      unknownEpoch(51, 50),
      view({ verdict: "no_group" }),
      walk(51),
    ],
    [
      "above current, left",
      unknownEpoch(51, 50),
      view({ state: "left", verdict: "no_group" }),
      walk(51),
    ],
    [
      "above current, joining",
      unknownEpoch(51, 50),
      view({ state: "joining", verdict: "joining" }),
      { kind: "none" },
    ],
    [
      "above current, poisoned",
      unknownEpoch(51, 50),
      view({ state: "poisoned", verdict: "poisoned" }),
      { kind: "none" },
    ],
    [
      "above current, another group, not a known predecessor",
      unknownEpoch(51, 50),
      view({ groupId: OTHER }),
      { kind: "none" },
    ],
    [
      "above current, a known predecessor",
      unknownEpoch(51, 50),
      view({ groupId: OTHER, predecessor: true }),
      walk(51),
    ],
    [
      "the current epoch itself",
      unknownEpoch(50, 50),
      view(),
      { kind: "none" },
    ],
    [
      "nothing held (current -1), active",
      unknownEpoch(0, -1),
      view(),
      { kind: "catch_up" },
    ],
    [
      "an older shell without removed_self",
      unknownEpoch(3, 50, { removed_self: undefined }),
      view(),
      walk(3),
    ],
    [
      "a removed_self that is not a literal true",
      unknownEpoch(3, 50, { removed_self: "true" }),
      view(),
      walk(3),
    ],
    [
      "an epoch that is not an integer",
      unknownEpoch(3.5, 50),
      view(),
      { kind: "none" },
    ],
    ["a negative epoch", unknownEpoch(-1, 50), view(), { kind: "none" }],
    [
      "group not found, not a known predecessor",
      { type: "mls_group_not_found", group_id: G },
      view({ groupId: OTHER, rowEpoch: 4 }),
      { kind: "none" },
    ],
    [
      "group not found, a known predecessor",
      { type: "mls_group_not_found", group_id: G },
      view({ groupId: OTHER, predecessor: true, rowEpoch: 4 }),
      walk(4),
    ],
    [
      "group not found, a predecessor but no row epoch",
      { type: "mls_group_not_found", group_id: G },
      view({ groupId: OTHER, predecessor: true }),
      { kind: "none" },
    ],
    [
      "another error",
      { type: "mls_poisoned_epoch", group_id: G, epoch: 3 },
      view(),
      { kind: "none" },
    ],
    ["a declined dialog", { type: "declined" }, view(), { kind: "none" }],
  ];
  for (const [name, err, group, want] of cases) {
    assert.deepEqual(walkTrigger(err, group), want, name);
  }
  assert.deepEqual(
    walkTrigger(null as unknown as NativeError, view()),
    { kind: "none" },
    "not an error object",
  );
});

// ---------------------------------------------------------------------------
// pickProbes
// ---------------------------------------------------------------------------

const HOLDER = { groupId: G, epoch: 7 };
const NOBODY: ReadonlySet<string> = new Set();

test("pickProbes: four authors give three probes", () => {
  const probes = pickProbes(
    [
      row("04", "A4", G, 7),
      row("01", "A1", G, 7),
      row("03", "A3", G, 7),
      row("02", "A2", G, 7),
    ],
    HOLDER,
    NOBODY,
  );
  assert.equal(probes.length, 3);
  assert.deepEqual(
    probes.map((p) => p.message_id),
    ["01", "02", "03"],
  );
  assert.equal(WALK_MAX_PROBES, 3);
});

test("pickProbes: one author twice gives one probe", () => {
  const probes = pickProbes(
    [row("02", "A1", G, 7), row("01", "A1", G, 7)],
    HOLDER,
    NOBODY,
  );
  assert.deepEqual(
    probes.map((p) => [p.message_id, p.author_user_id]),
    [["01", "A1"]],
  );
  // A second author still gets the freed slot
  const two = pickProbes(
    [row("01", "A1", G, 7), row("02", "A1", G, 7), row("03", "A2", G, 7)],
    HOLDER,
    NOBODY,
  );
  assert.deepEqual(
    two.map((p) => p.message_id),
    ["01", "03"],
  );
});

test("pickProbes: an excluded writer is never chosen", () => {
  const rows = [
    row("01", "W1", G, 7),
    row("02", "A1", G, 7),
    row("03", "W2", G, 7),
    row("04", "A2", G, 7),
    row("05", "A3", G, 7),
  ];
  const probes = pickProbes(rows, HOLDER, new Set(["W1", "W2"]));
  assert.deepEqual(
    probes.map((p) => p.author_user_id),
    ["A1", "A2", "A3"],
  );
  assert.deepEqual(pickProbes(rows.slice(0, 1), HOLDER, new Set(["W1"])), []);
});

test("pickProbes: a row of another epoch or group is skipped", () => {
  const probes = pickProbes(
    [
      row("01", "A1", G, 6),
      row("02", "A2", G, 8),
      row("03", "A3", P, 7),
      row("04", "A4", G, 7),
    ],
    HOLDER,
    NOBODY,
  );
  assert.deepEqual(
    probes.map((p) => p.message_id),
    ["04"],
  );
});

test("pickProbes: oldest id first, encrypted passed as received, unusable rows skipped", () => {
  const newest = row("09", "A1", G, 7);
  const oldest = row("01", "A2", G, 7);
  const rows: ProbeSource[] = [
    newest,
    { id: "02", authorId: "A3", nonce: null, encrypted: enc(G, 7) },
    { id: "03", authorId: "A4", nonce: "cid", encrypted: null },
    { id: "", authorId: "A5", nonce: "cid", encrypted: enc(G, 7) },
    { id: "04", authorId: "", nonce: "cid", encrypted: enc(G, 7) },
    null as unknown as ProbeSource,
    oldest,
  ];
  const before = JSON.stringify(rows);
  const probes = pickProbes(rows, HOLDER, NOBODY);
  assert.deepEqual(probes, [
    {
      message_id: "01",
      author_user_id: "A2",
      nonce: "cid-01",
      encrypted: oldest.encrypted,
    },
    {
      message_id: "09",
      author_user_id: "A1",
      nonce: "cid-09",
      encrypted: newest.encrypted,
    },
  ]);
  // The same object, not a copy; the input is not reordered
  assert.equal(probes[0]?.encrypted, oldest.encrypted);
  assert.equal(JSON.stringify(rows), before);
  // The same input gives the same answer whatever its order
  assert.deepEqual(pickProbes([...rows].reverse(), HOLDER, NOBODY), probes);
});

// ---------------------------------------------------------------------------
// commitForNative
// ---------------------------------------------------------------------------

test("commitForNative: copies the wire fields and nothing else", () => {
  const intents = [{ signed: "intent" }];
  const reasons = [{ user_id: "U3", device_id: "D3", reason: "kick" }];
  const out = commitForNative({
    ...commitRow(G, 9),
    removed: [{ user_id: "U3", device_id: "D3", extra: 1 }],
    rejoin_intents: intents,
    removed_reasons: reasons,
    _id: "server-only",
    winning: true,
  });
  assert.deepEqual(out, {
    group_id: G,
    epoch: 9,
    committer: { user_id: "U1", device_id: "D1" },
    commit: "commit-9",
    added: [{ user_id: "U2", device_id: "D2" }],
    removed: [{ user_id: "U3", device_id: "D3" }],
    rejoin_intents: intents,
    removed_reasons: reasons,
    created_at: 1_790_000_000_009,
  });
  // The signed entries are the server's objects, not rebuilt
  assert.equal(
    (out as { rejoin_intents: unknown[] }).rejoin_intents[0],
    intents[0],
  );
  const bare = commitForNative({ ...commitRow(G, 9), created_at: undefined });
  assert.deepEqual(Object.keys(bare ?? {}).sort(), [
    "added",
    "commit",
    "committer",
    "epoch",
    "group_id",
    "removed",
  ]);
});

test("commitForNative: a row that fails the shape is null", () => {
  const good = commitRow(G, 9);
  const bad: unknown[] = [
    null,
    undefined,
    "row",
    [],
    { ...good, group_id: 7 },
    { ...good, group_id: "" },
    { ...good, epoch: "9" },
    { ...good, epoch: -1 },
    { ...good, epoch: 1.5 },
    { ...good, committer: null },
    { ...good, committer: { user_id: "U1" } },
    { ...good, commit: 5 },
    { ...good, added: undefined },
    { ...good, added: "none" },
    { ...good, added: [{ user_id: "U2" }] },
    { ...good, removed: [null] },
    { ...good, rejoin_intents: {} },
    { ...good, removed_reasons: "x" },
  ];
  for (const candidate of bad) {
    assert.equal(commitForNative(candidate), null, JSON.stringify(candidate));
  }
  assert.notEqual(commitForNative(good), null);
});

test("commitForNative: created_at as a string, a fraction, a negative and 2^53 is dropped", () => {
  const dropped: unknown[] = [
    "1790000000000",
    1790000000000.5,
    -1,
    2 ** 53,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    true,
  ];
  for (const value of dropped) {
    const logs: LogLine[] = [];
    const out = commitForNative(
      { ...commitRow(G, 9), created_at: value },
      (level, msg, ids) => logs.push({ level, msg, ids }),
    );
    assert.notEqual(out, null, `${String(value)}: the commit is kept`);
    assert.equal(
      Object.hasOwn(out ?? {}, "created_at"),
      false,
      `${String(value)}: created_at must not reach native`,
    );
    assert.deepEqual(
      logs,
      [
        {
          level: "error",
          msg: "history walk: commit created_at dropped",
          ids: { group_id: G, epoch: 9 },
        },
      ],
      `${String(value)}: dropped loud, ids only`,
    );
  }
  for (const value of [0, 1, 1_790_000_000_000, 2 ** 53 - 1]) {
    const logs: LogLine[] = [];
    const out = commitForNative(
      { ...commitRow(G, 9), created_at: value },
      (level, msg, ids) => logs.push({ level, msg, ids }),
    );
    assert.equal(out?.created_at, value);
    assert.deepEqual(logs, []);
  }
});

// ---------------------------------------------------------------------------
// runWalk
// ---------------------------------------------------------------------------

test("runWalk: a multi-page walk keeps going while need_more and ends anchored", async () => {
  // Held 0..10 and 20 upward: holder 20 starts, holder 11 anchors on 10
  const w = world({
    links: chain(25, 1),
    pageSize: 4,
    anchor: { groupId: G, epoch: 11 },
    // A probe at epoch 17 commits the staged 19..17 while more is needed
    rows: [row("01", "A1", G, 17)],
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });

  assert.deepEqual(result.end, { kind: "anchored" });
  // The last page also holds 10 and 9: native ignores steps past the end
  assert.deepEqual(
    w.holders(),
    [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9].map((e) => key(G, e)),
  );
  assert.equal(w.calls.length, 3, "one call per link page");
  assert.deepEqual(
    w.calls.map((c) => c.session),
    [null, "s1", "s1"],
  );
  assert.deepEqual(
    w.calls.map((c) => c.groupId),
    [G, G, G],
  );
  // The first page asks below holder 21, then below the lowest epoch seen
  assert.deepEqual(w.linkCalls, [
    { groupId: G, before: 21 },
    { groupId: G, before: 17 },
    { groupId: G, before: 13 },
  ]);
  assert.deepEqual(
    result.imported,
    [19, 18, 17, 16, 15, 14, 13, 12, 11].map((epoch) => ({
      group_id: G,
      epoch,
    })),
  );
  assert.deepEqual(result.refused, []);
  assert.deepEqual(w.logs, []);
});

test("runWalk: links are sent as the server gave them, each step with its own holder's", async () => {
  const links = [
    link(G, 5, "W1"),
    link(G, 5, "W2"),
    link(G, 4, "W1"),
    link(G, 3, "W3"),
  ];
  const w = world({ links, anchor: { groupId: G, epoch: 3 } });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 5 });
  assert.deepEqual(result.end, { kind: "anchored" });
  const steps = w.calls.flatMap((c) => c.steps);
  assert.equal(steps.length, 3);
  assert.equal(steps[0]?.candidates.length, 2);
  // Identity: the very objects, never rebuilt
  assert.equal(steps[0]?.candidates[0], links[0]);
  assert.equal(steps[0]?.candidates[1], links[1]);
  assert.equal(steps[1]?.candidates[0], links[2]);
  assert.equal(steps[2]?.candidates[0], links[3]);
});

test("runWalk: a link row of another group or outside the asked page is never sent", async () => {
  const good = link(G, 5, "W1");
  const pages: (HistoryLinkWire[] | "end")[] = [
    [good, link(P, 5, "W1"), link(G, 9, "W1"), null as never],
    "end",
  ];
  const w = world({ anchor: { groupId: G, epoch: 5 } });
  w.ports.links = async () => pages.shift() ?? "end";
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 5 });
  assert.deepEqual(result.end, { kind: "anchored" });
  assert.deepEqual(w.calls[0]?.steps[0]?.candidates, [good]);
  assert.deepEqual(w.logs, [
    {
      level: "error",
      msg: "history walk: link rows outside the page dropped",
      ids: { group_id: G, before: 6, dropped: 3 },
    },
  ]);
});

test("runWalk: stops on missing with an empty-candidate step", async () => {
  // Links exist for holders 20..16 only
  const w = world({ links: chain(20, 16), pageSize: 10 });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(result.end, {
    kind: "stopped",
    stop: "missing",
    floor: { group_id: G, epoch: 15 },
  });
  const steps = w.calls.flatMap((c) => c.steps);
  assert.equal(steps.at(-1)?.holder_epoch, 15);
  assert.deepEqual(steps.at(-1)?.candidates, []);
  assert.equal(steps.length, 6, "nothing is sent below the empty step");
});

test("runWalk: a gap inside a page is an empty-candidate step too", async () => {
  const w = world({ links: [...chain(20, 18), ...chain(16, 10)] });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.equal(result.end.kind, "stopped");
  assert.deepEqual(
    w.holders(),
    [20, 19, 18, 17].map((e) => key(G, e)),
  );
  assert.deepEqual(w.calls[0]?.steps[3]?.candidates, []);
});

test("runWalk: stops on hidden", async () => {
  const w = world({
    links: chain(20, 1),
    stops: new Map([[key(G, 18), "hidden"]]),
    anchor: { groupId: G, epoch: 11 },
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(result.end, {
    kind: "stopped",
    stop: "hidden",
    floor: { group_id: G, epoch: 18 },
  });
  assert.equal(w.calls.length, 1);
});

test("runWalk: stops on conflict", async () => {
  const w = world({
    links: chain(20, 1),
    pageSize: 2,
    stops: new Map([[key(G, 15), "conflict"]]),
    anchor: { groupId: G, epoch: 11 },
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(result.end, {
    kind: "stopped",
    stop: "conflict",
    floor: { group_id: G, epoch: 15 },
  });
  assert.equal(w.calls.length, 3, "the walk ends with the stop");
});

test("runWalk: genesis at holder epoch 0 is a stop, with no commits sent", async () => {
  const commits = new Map<string, unknown>([
    [key(G, 1), commitRow(G, 1)],
    [key(G, 0), commitRow(G, 0)],
  ]);
  const w = world({ links: chain(2, 1), genesisGroup: G, commits });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 2 });
  assert.deepEqual(result.end, {
    kind: "stopped",
    stop: "genesis",
    floor: { group_id: G, epoch: 0 },
  });
  const steps = w.calls.flatMap((c) => c.steps);
  assert.deepEqual(
    steps.map((s) => s.holder_epoch),
    [2, 1, 0],
  );
  assert.equal(steps[2]?.commit, null);
  assert.equal(steps[2]?.prev_commit, null);
  assert.deepEqual(steps[2]?.candidates, []);
});

test("runWalk: unanchored ends retry_later, not a stop", async () => {
  const w = world({
    links: chain(20, 1),
    stops: new Map([[key(G, 16), "unanchored"]]),
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(result.end, { kind: "retry_later", reason: "unanchored" });
  assert.deepEqual(
    w.logs.map((l) => [l.level, l.msg]),
    [["warn", "history walk: unanchored"]],
  );
});

test("runWalk: a stop this build does not know is a stop, never anchored", async () => {
  const w = world({
    links: chain(20, 1),
    stops: new Map([[key(G, 19), "frozen"]]),
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(result.end, {
    kind: "stopped",
    stop: "frozen",
    floor: { group_id: G, epoch: 19 },
  });
  assert.deepEqual(
    w.logs.map((l) => [l.level, l.msg]),
    [["error", "history walk: unknown stop"]],
  );
});

test("runWalk: an answer it cannot read never ends anchored", async () => {
  const answers: unknown[] = [
    undefined,
    null,
    {},
    { session: "s", need_more: false, imported: [], refused: [] },
    {
      session: "s",
      need_more: false,
      imported: [],
      refused: [],
      stopped: undefined,
    },
    { session: "s", need_more: 0, imported: [], refused: [], stopped: null },
    { session: 1, need_more: false, imported: [], refused: [], stopped: null },
    {
      session: "s",
      need_more: false,
      imported: [{ group_id: G }],
      refused: [],
      stopped: null,
    },
    {
      session: "s",
      need_more: false,
      imported: [],
      refused: [{}],
      stopped: null,
    },
    { session: "s", need_more: false, imported: [], stopped: null },
  ];
  for (const answer of answers) {
    const w = world({ links: chain(20, 1) });
    w.ports.importSteps = async () => answer as HistoryImported;
    const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
    assert.deepEqual(
      result.end,
      { kind: "retry_later", reason: "transport" },
      JSON.stringify(answer),
    );
  }
  // A stop wins over a contradicting need_more: false is not needed for it
  const w = world({ links: chain(20, 1) });
  w.ports.importSteps = async () => ({
    session: "s",
    need_more: true,
    imported: [],
    floor: null,
    stopped: "invalid",
    refused: [],
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(result.end, {
    kind: "stopped",
    stop: "invalid",
    floor: null,
  });
});

test("runWalk: a bridge hop continues in the predecessor group", async () => {
  const bridge = link(G, 0, "W1", { groupId: P, epoch: 7 });
  const links = [...chain(2, 1), bridge, link(P, 7, "W2"), link(P, 6, "W2")];
  const commits = new Map<string, unknown>([
    [key(G, 0), commitRow(G, 0)],
    [key(P, 7), commitRow(P, 7)],
    [key(P, 6), commitRow(P, 6)],
  ]);
  const w = world({
    links,
    commits,
    bridges: new Map([[G, { groupId: P, epoch: 7 }]]),
    anchor: { groupId: P, epoch: 6 },
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 2 });

  assert.deepEqual(result.end, { kind: "anchored" });
  assert.deepEqual(w.holders(), [
    key(G, 2),
    key(G, 1),
    key(G, 0),
    key(P, 7),
    key(P, 6),
  ]);
  // The session stays the starting group's; the bridge ends its call
  assert.deepEqual(
    w.calls.map((c) => [c.groupId, c.session, c.steps.length]),
    [
      [G, null, 3],
      [G, "s1", 2],
    ],
  );
  const steps = w.calls.flatMap((c) => c.steps);
  assert.equal(steps[2]?.candidates[0], bridge);
  assert.equal(steps[2]?.commit, null, "holder 0 sends no commit");
  assert.equal(steps[2]?.prev_commit, null);
  assert.equal(steps[3]?.commit?.epoch, 7);
  assert.equal(steps[3]?.prev_commit?.epoch, 6);
  assert.deepEqual(w.linkCalls, [
    { groupId: G, before: 3 },
    { groupId: P, before: 8 },
  ]);
  assert.deepEqual(result.imported, [
    { group_id: G, epoch: 1 },
    { group_id: G, epoch: 0 },
    { group_id: P, epoch: 7 },
    { group_id: P, epoch: 6 },
  ]);
});

test("runWalk: bridge candidates that disagree: a refused position is not followed", async () => {
  // One writer names a wrong predecessor epoch; native follows the other
  const links = [
    link(G, 1, "W1"),
    link(G, 0, "EVIL", { groupId: P, epoch: 9 }),
    link(G, 0, "W1", { groupId: P, epoch: 7 }),
    link(G, 0, "W9", { groupId: G, epoch: 4 }),
    link(P, 9, "EVIL"),
    link(P, 7, "W2"),
  ];
  const w = world({
    links,
    bridges: new Map([[G, { groupId: P, epoch: 7 }]]),
    anchor: { groupId: P, epoch: 7 },
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 1 });
  assert.deepEqual(result.end, { kind: "anchored" });
  // The wrong guess (P:9, then the empty P:8) was refused whole
  assert.deepEqual(w.holders(), [
    key(G, 1),
    key(G, 0),
    key(P, 9),
    key(P, 8),
    key(P, 7),
  ]);
  assert.equal(w.calls.length, 3);
  assert.equal(WALK_MAX_BRIDGE_TARGETS, 5);

  // No candidate names a predecessor: nothing to follow
  const lost = world({
    links: [link(G, 0, "W9", { groupId: G, epoch: 4 })],
    bridges: new Map([[G, { groupId: P, epoch: 7 }]]),
  });
  const none = await runWalk(lost.ports, { groupId: G, holderEpoch: 0 });
  assert.deepEqual(none.end, { kind: "retry_later", reason: "argument" });
});

test("runWalk: an identity pin retry re-sends identical steps once", async () => {
  const pinError = {
    type: "identity_pin_required",
    user_id: "U9",
    device_id: "D9",
  };
  const w = world({
    links: chain(20, 1),
    pageSize: 3,
    anchor: { groupId: G, epoch: 15 },
  });
  // The second call asks for a pin (a session is open by then)
  const real = w.ports.importSteps;
  let n = 0;
  const snapshots: string[] = [];
  w.ports.importSteps = async (groupId, session, steps) => {
    n += 1;
    snapshots.push(JSON.stringify({ groupId, session, steps }));
    if (n === 2) {
      w.calls.push({ groupId, session, steps });
      throw pinError;
    }
    return real(groupId, session, steps);
  };

  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(result.end, { kind: "anchored" });
  assert.deepEqual(w.pins, [{ userId: "U9", deviceId: "D9" }]);
  assert.equal(w.calls.length, 3);
  // The retry: the same session and the very same steps, byte for byte
  assert.equal(w.calls[2]?.steps, w.calls[1]?.steps);
  assert.equal(w.calls[2]?.session, w.calls[1]?.session);
  assert.equal(w.calls[2]?.session, "s1");
  assert.equal(snapshots[2], snapshots[1]);
  assert.notEqual(snapshots[1], snapshots[0]);
});

test("runWalk: a second pin request, or a pin that fails, ends retry_later pin", async () => {
  const pinError = {
    source: "native",
    error: { type: "identity_pin_required", user_id: "U9", device_id: "D9" },
  };
  const twice = world({ links: chain(20, 1), throws: [pinError, pinError] });
  const a = await runWalk(twice.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(a.end, { kind: "retry_later", reason: "pin" });
  assert.equal(twice.pins.length, 1, "pinned once");
  assert.equal(twice.calls.length, 2, "re-sent once");

  const failed = world({ links: chain(20, 1), throws: [pinError] });
  failed.setPinAnswer(false);
  const b = await runWalk(failed.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(b.end, { kind: "retry_later", reason: "pin" });
  assert.equal(failed.calls.length, 1, "not re-sent");

  const thrown = world({ links: chain(20, 1), throws: [pinError] });
  thrown.ports.pin = async () => {
    throw new Error("listing fetch failed");
  };
  const c = await runWalk(thrown.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(c.end, { kind: "retry_later", reason: "pin" });

  const nameless = world({
    links: chain(20, 1),
    throws: [{ type: "identity_pin_required" }],
  });
  const d = await runWalk(nameless.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(d.end, { kind: "retry_later", reason: "pin" });
  assert.equal(nameless.pins.length, 0);
});

test("runWalk: a refused start holder is stepped up, at most three times", async () => {
  const w = world({
    links: chain(30, 1),
    held: (_g, epoch) => epoch === 22,
    anchor: { groupId: G, epoch: 21 },
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(result.end, { kind: "anchored" });
  assert.deepEqual(
    w.calls.map((c) => [c.session, c.steps[0]?.holder_epoch]),
    [
      [null, 20],
      [null, 21],
      [null, 22],
    ],
  );

  const never = world({ links: chain(30, 1), held: () => false });
  const lost = await runWalk(never.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(lost.end, { kind: "retry_later", reason: "argument" });
  assert.deepEqual(
    never.calls.map((c) => c.steps[0]?.holder_epoch),
    [20, 21, 22, 23],
  );
  assert.equal(WALK_MAX_START_BUMPS, 3);

  // Only on the first call: later it is a lost session, not a wrong start
  const later = world({ links: chain(30, 1), pageSize: 2 });
  const real = later.ports.importSteps;
  let n = 0;
  later.ports.importSteps = async (groupId, session, steps) => {
    n += 1;
    if (n === 2) throw { type: "invalid_argument", field: "holder_epoch" };
    return real(groupId, session, steps);
  };
  const gone = await runWalk(later.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(gone.end, { kind: "retry_later", reason: "argument" });
  assert.equal(n, 2);
});

test("runWalk: never more than 200 rows or 3 probes in a call", async () => {
  // 280 holders, 5 candidates each, 6 authors per epoch, pages larger than
  // a call may carry
  const links: HistoryLinkWire[] = [];
  const rows: ProbeSource[] = [];
  for (let e = 300; e >= 1; e -= 1) {
    for (let c = 1; c <= 5; c += 1) links.push(link(G, e, `W${c}`));
    for (let a = 1; a <= 6; a += 1) {
      rows.push(row(`${String(e).padStart(4, "0")}-${a}`, `A${a}`, G, e));
    }
  }
  const w = world({
    links,
    rows,
    pageSize: 430,
    anchor: { groupId: G, epoch: 21 },
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 300 });

  assert.deepEqual(result.end, { kind: "anchored" });
  const expected: string[] = [];
  for (let e = 300; e >= 21; e -= 1) expected.push(key(G, e));
  assert.deepEqual(w.holders().slice(0, 280), expected);
  let most = 0;
  for (const call of w.calls) {
    const count = call.steps.reduce((n, s) => n + s.candidates.length, 0);
    assert.ok(count <= 200, `a call carried ${count} link rows`);
    most = Math.max(most, count);
    for (const step of call.steps) {
      const probes = step.probes ?? [];
      assert.ok(probes.length <= 3, `a step carried ${probes.length} probes`);
      assert.equal(probes.length, 3, "three are there to send");
      assert.equal(new Set(probes.map((p) => p.author_user_id)).size, 3);
      for (const probe of probes) {
        assert.equal(probe.encrypted.epoch, step.holder_epoch);
      }
    }
  }
  assert.equal(most, 200, "a call is filled up to the cap, not past it");
  assert.ok(w.calls.length >= 7, "1400 rows need at least seven calls");
  assert.equal(WALK_MAX_LINK_ROWS, 200);

  // One holder with more candidates than a call may carry: nothing is cut
  const flood: HistoryLinkWire[] = [];
  for (let c = 0; c < 201; c += 1) flood.push(link(G, 9, `W${c}`));
  const f = world({ links: flood, pageSize: 500 });
  const refusedToSend = await runWalk(f.ports, { groupId: G, holderEpoch: 9 });
  assert.deepEqual(refusedToSend.end, {
    kind: "retry_later",
    reason: "argument",
  });
  assert.equal(f.calls.length, 0);
});

test("runWalk: probes exclude the writers of the step above, not of the same step", async () => {
  // Holder 10's candidates (by W1) carried epoch 9's keys; holder 9's own
  // candidates are by W2
  const links = [link(G, 10, "W1"), link(G, 9, "W2"), link(G, 8, "W3")];
  const rows = [
    row("01", "W1", G, 10),
    row("02", "W1", G, 9),
    row("03", "W2", G, 9),
    row("04", "A1", G, 9),
    row("05", "W2", G, 8),
    row("06", "W3", G, 8),
  ];
  // Two calls: holders 10 and 9, then holder 8
  const w = world({
    links,
    rows,
    pageSize: 2,
    anchor: { groupId: G, epoch: 8 },
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 10 });
  assert.deepEqual(result.end, { kind: "anchored" });
  const authors = w.calls
    .flatMap((c) => c.steps)
    .map((s) => (s.probes ?? []).map((p) => p.author_user_id));
  assert.deepEqual(authors, [
    // The first step has no step above: nobody is excluded
    ["W1"],
    // W1 wrote the candidate that carried epoch 9's keys
    ["W2", "A1"],
    // W2 wrote the one that carried epoch 8's (the exclusion crosses calls)
    ["W3"],
  ]);
});

test("runWalk: each step carries the commit into its holder and the one before", async () => {
  const commits = new Map<string, unknown>([
    [key(G, 6), commitRow(G, 6)],
    [key(G, 5), { ...commitRow(G, 5), created_at: 12.5, extra: "x" }],
    // The server answered with the row of another epoch
    [key(G, 4), commitRow(G, 3)],
    [key(G, 3), "garbage"],
  ]);
  const w = world({
    links: chain(6, 4),
    commits,
    anchor: { groupId: G, epoch: 4 },
  });
  let commitCalls = 0;
  const real = w.ports.commit;
  w.ports.commit = async (groupId, epoch) => {
    commitCalls += 1;
    return real(groupId, epoch);
  };
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 6 });
  assert.deepEqual(result.end, { kind: "anchored" });
  const steps = w.calls.flatMap((c) => c.steps);
  assert.deepEqual(
    steps.map((s) => [s.holder_epoch, s.commit?.epoch, s.prev_commit?.epoch]),
    [
      [6, 6, 5],
      [5, 5, undefined],
      [4, undefined, undefined],
    ],
  );
  assert.equal(steps[0]?.commit?.created_at, 1_790_000_000_006);
  const five = steps[0]?.prev_commit ?? {};
  assert.equal(Object.hasOwn(five, "created_at"), false);
  assert.equal(Object.hasOwn(five, "extra"), false);
  assert.equal(steps[1]?.prev_commit, null);
  assert.equal(commitCalls, 4, "an epoch's commit is fetched once");
  assert.deepEqual(
    w.logs.map((l) => [l.level, l.msg, l.ids.epoch]),
    [
      ["error", "history walk: commit created_at dropped", 5],
      ["error", "history walk: stored commit is of another epoch", 4],
      ["error", "history walk: stored commit unreadable", 3],
    ],
  );
});

test("runWalk: a failed fetch or a failed bridge call ends retry_later transport", async () => {
  const start = { groupId: G, holderEpoch: 20 };
  const want = { kind: "retry_later", reason: "transport" };

  const a = world({ links: chain(20, 1) });
  a.ports.links = async () => "failed";
  assert.deepEqual((await runWalk(a.ports, start)).end, want);
  assert.equal(a.calls.length, 0);

  const b = world({ links: chain(20, 1) });
  b.ports.links = async () => {
    throw new Error("offline");
  };
  assert.deepEqual((await runWalk(b.ports, start)).end, want);

  const c = world({ links: chain(20, 1) });
  c.ports.commit = async () => {
    throw new Error("offline");
  };
  assert.deepEqual((await runWalk(c.ports, start)).end, want);
  assert.equal(c.calls.length, 0);

  const d = world({ links: chain(20, 1) });
  d.ports.probeRows = async () => {
    throw new Error("offline");
  };
  assert.deepEqual((await runWalk(d.ports, start)).end, want);

  const e = world({ links: chain(20, 1), throws: [new Error("ipc closed")] });
  assert.deepEqual((await runWalk(e.ports, start)).end, want);

  const f = world({
    links: chain(20, 1),
    throws: [{ type: "mls_group_not_found", group_id: G }],
  });
  assert.deepEqual((await runWalk(f.ports, start)).end, want);
  assert.deepEqual(f.logs.at(-1)?.ids.type, "mls_group_not_found");

  const g = world({ links: chain(20, 1) });
  g.ports.links = async () => ({ links: [] }) as never;
  assert.deepEqual((await runWalk(g.ports, start)).end, want);

  // A later page failing keeps what was imported before it
  const h = world({
    links: chain(20, 1),
    pageSize: 2,
    rows: [row("01", "A1", G, 19)],
  });
  const pages = h.ports.links;
  let n = 0;
  h.ports.links = async (groupId, before) => {
    n += 1;
    return n === 3 ? "failed" : pages(groupId, before);
  };
  const partial = await runWalk(h.ports, start);
  assert.deepEqual(partial.end, want);
  assert.deepEqual(partial.imported, [{ group_id: G, epoch: 19 }]);
});

test("runWalk: a refused call ends retry_later argument, and a bad start never calls native", async () => {
  for (const field of ["steps", "probes", "group_id", "holder_group"]) {
    const w = world({
      links: chain(20, 1),
      throws: [{ type: "invalid_argument", field }],
    });
    const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
    assert.deepEqual(result.end, { kind: "retry_later", reason: "argument" });
    assert.equal(w.calls.length, 1, field);
    assert.equal(w.logs.at(-1)?.ids.field, field);
  }
  const bad: { groupId: string; holderEpoch: number }[] = [
    { groupId: "", holderEpoch: 3 },
    { groupId: G, holderEpoch: -1 },
    { groupId: G, holderEpoch: 1.5 },
    { groupId: G, holderEpoch: Number.NaN },
    { groupId: 7 as unknown as string, holderEpoch: 3 },
  ];
  for (const start of bad) {
    const w = world({ links: chain(20, 1) });
    const result = await runWalk(w.ports, start);
    assert.deepEqual(result.end, { kind: "retry_later", reason: "argument" });
    assert.equal(w.calls.length, 0);
    assert.equal(w.linkCalls.length, 0);
  }
});

test("runWalk: every refused candidate is reported and logged loud, ids and reason only", async () => {
  const w = world({
    links: chain(20, 1),
    anchor: { groupId: G, epoch: 18 },
    refusals: [
      {
        type: "history_link_invalid",
        group_id: G,
        epoch: 20,
        reason: "bad_writer_sig",
      },
      { type: "history_link_invalid", group_id: G, epoch: 19, reason: "aead" },
    ],
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(result.end, { kind: "anchored" });
  assert.deepEqual(result.refused, [
    {
      type: "history_link_invalid",
      group_id: G,
      epoch: 20,
      reason: "bad_writer_sig",
    },
    { type: "history_link_invalid", group_id: G, epoch: 19, reason: "aead" },
  ]);
  assert.deepEqual(w.logs, [
    {
      level: "error",
      msg: "history walk: link refused",
      ids: { group_id: G, epoch: 20, reason: "bad_writer_sig" },
    },
    {
      level: "error",
      msg: "history walk: link refused",
      ids: { group_id: G, epoch: 19, reason: "aead" },
    },
  ]);
});

test("runWalk: ports that always ask for more cannot loop forever", async () => {
  let calls = 0;
  let holders = 0;
  const ports: WalkPorts = {
    async links(groupId, before) {
      const top = (before ?? 0) - 1;
      const page: HistoryLinkWire[] = [];
      for (let e = top; e > top - 200 && e >= 0; e -= 1) {
        page.push(link(groupId, e, "W1"));
      }
      return page.length === 0 ? "end" : page;
    },
    async commit() {
      return null;
    },
    async probeRows() {
      return [];
    },
    async importSteps(_groupId, _session, steps) {
      calls += 1;
      holders += steps.length;
      return {
        session: "s",
        need_more: true,
        imported: [],
        floor: null,
        stopped: null,
        refused: [],
      };
    },
    async pin() {
      return true;
    },
    log() {},
  };
  const result = await runWalk(ports, { groupId: G, holderEpoch: 9000 });
  assert.deepEqual(result.end, { kind: "retry_later", reason: "unanchored" });
  assert.equal(holders, 2000);
  assert.equal(calls, 10);
  assert.equal(WALK_MAX_HOLDERS, 2000);
});

// ---------------------------------------------------------------------------
// Older shells (R-W4-33)
// ---------------------------------------------------------------------------

/** Rejections an S2-era shell gives for a command it does not have. */
const MISSING_COMMAND: unknown[] = [
  new TypeError("window.__TAURI__.invoke is not a function"),
  new TypeError("native.e2eeTextHistoryImport is not a function"),
  "Command e2ee_text_history_import not found",
  "not implemented",
  "UNIMPLEMENTED",
  new Error("command e2ee_text_history_import not found"),
  { message: "Unimplemented method" },
  { code: "UNIMPLEMENTED" },
  { type: "invalid_argument", field: "command" },
  { source: "native", error: { type: "invalid_argument", field: "command" } },
];

/** Everything else, typed native errors with a telling text included. */
const NOT_MISSING_COMMAND: unknown[] = [
  null,
  undefined,
  7,
  "",
  "ipc closed",
  new Error("ipc closed"),
  // A TypeError that names no missing command (RA4)
  new TypeError("Failed to fetch"),
  new TypeError("Cannot read properties of undefined (reading 'invoke')"),
  new TypeError(""),
  {},
  { message: 404 },
  { type: "invalid_argument", field: "steps" },
  { type: "invalid_argument", field: "holder_epoch" },
  { type: "mls_group_not_found", message: "group not found" },
  { type: "internal", message: "not implemented" },
  { type: "internal", code: "UNIMPLEMENTED" },
  { source: "client", reason: "disposed" },
  { source: "transport" },
  { source: "native", error: { type: "unknown_epoch" } },
  { source: "native", error: { type: "internal", message: "not found" } },
];

test("isMissingCommandError: the missing-command answers, and nothing typed otherwise", () => {
  for (const e of MISSING_COMMAND) {
    assert.equal(isMissingCommandError(e), true, JSON.stringify(e) ?? `${e}`);
  }
  for (const e of NOT_MISSING_COMMAND) {
    assert.equal(isMissingCommandError(e), false, JSON.stringify(e) ?? `${e}`);
  }
});

test("runWalk: a missing import command ends unsupported, not a retry, after one call", async () => {
  for (const thrown of MISSING_COMMAND) {
    const label = JSON.stringify(thrown) ?? `${thrown}`;
    const w = world({ links: chain(20, 1), throws: [thrown] });
    const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
    assert.deepEqual(result.end, { kind: "unsupported" }, label);
    assert.equal(w.calls.length, 1, label);
    assert.deepEqual(result.imported, [], label);
    assert.equal(w.pins.length, 0, label);
    const last = w.logs.at(-1);
    assert.equal(last?.level, "error", label);
    assert.equal(last?.msg, "history walk: import command missing", label);
  }
  // The typed `invalid_argument{command}` on the FIRST call is not read as
  // a refused start holder: no second session is tried.
  const w = world({
    links: chain(20, 1),
    throws: [
      { type: "invalid_argument", field: "command" },
      { type: "invalid_argument", field: "command" },
    ],
  });
  const result = await runWalk(w.ports, { groupId: G, holderEpoch: 20 });
  assert.deepEqual(result.end, { kind: "unsupported" });
  assert.equal(w.calls.length, 1);
  // Any other failure of the bridge call stays a retry, a TypeError that
  // names no missing command included (RA4).
  for (const thrown of [
    new Error("ipc closed"),
    { type: "internal" },
    new TypeError("Failed to fetch"),
  ]) {
    const other = world({ links: chain(20, 1), throws: [thrown] });
    assert.deepEqual(
      (await runWalk(other.ports, { groupId: G, holderEpoch: 20 })).end,
      { kind: "retry_later", reason: "transport" },
    );
  }
});
