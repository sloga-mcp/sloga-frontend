// Unit spec for Protected channels text group ids (W4 lane A4) — run with
// Node's built-in runner:
//   node --test --conditions=browser components/client/protectedTextIds.test.ts
// Focus: `textGroupId` must equal the server's and native's derivation byte
// for byte (design 3.1), so it is pinned ALWAYS to the design 5.5 vectors in
// the in-repo fixture `__fixtures__/protected/design-5-5-group-ids.json`; an
// extra test checks that fixture against the pinned design copy
// (`/home/mcp/w4-notes/`, override with `W4_NOTES_DIR`; it skips, loudly,
// when absent). A
// wrong id would route a text envelope to the call session. The generation
// cap is 63 (64 refused), and the index must cover exactly generations 0..63
// of every added channel, atomically and idempotently.
// S2 (OR-7): `addReported` indexes a native/server-reported id (v2, or
// g up to 65535) without deriving it; the router must see it exactly like a
// v1 id, and an indexed id is never re-routed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { routeMls } from "./protectedRouter.ts";
import {
  MAX_REPORTED_GENERATION,
  MAX_TEXT_GENERATION,
  TEXT_GROUP_ID_CONTEXT,
  TextIdIndex,
  textGroupId,
} from "./protectedTextIds.ts";

// Design 5.1 `channel_id` and the 5.5 vectors, copied in-repo (always present).
const VECTORS = JSON.parse(
  readFileSync(
    new URL(
      "./__fixtures__/protected/design-5-5-group-ids.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  context: string;
  formula_line: string;
  channel_id: string;
  group_id_g0: string;
  group_id_g1: string;
};
const CHANNEL = VECTORS.channel_id;
const GROUP_ID_G0 = VECTORS.group_id_g0;
const GROUP_ID_G1 = VECTORS.group_id_g1;
const OTHER_CHANNEL = "01HZXCCCCCCCCCCCCCCCCCCCCC";

const NOTES = process.env.W4_NOTES_DIR ?? "/home/mcp/w4-notes";
const DESIGN = join(NOTES, "w4_design.md");
const SKIP = existsSync(DESIGN) ? false : `design copy not found: ${DESIGN}`;

/** The fenced block right after `<!-- tv:NAME -->` (design 5 reading rule). */
function vector(doc: string, name: string): string {
  const re = new RegExp(
    `<!-- tv:${name} -->\\s*\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``,
  );
  const m = re.exec(doc);
  assert.ok(m, `vector tv:${name} not found`);
  return m[1];
}

/** An independent node:crypto derivation, for ids outside the vectors. */
function nodeId(channelId: string, generation: number): string {
  return createHash("sha256")
    .update(`sloga-text-group-v1\n${channelId}\n${generation}`, "utf8")
    .digest("hex");
}

test("constants: cap 63 and the wire context literal", () => {
  assert.equal(MAX_TEXT_GENERATION, 63);
  assert.equal(TEXT_GROUP_ID_CONTEXT, "sloga-text-group-v1");
  assert.equal(TEXT_GROUP_ID_CONTEXT, VECTORS.context);
  assert.equal(
    VECTORS.formula_line,
    `"${TEXT_GROUP_ID_CONTEXT}" LF channel_id LF decimal(g)`,
  );
});

test("design 5.5 vectors (fixture): generations 0 and 1", async () => {
  assert.match(GROUP_ID_G0, /^[0-9a-f]{64}$/);
  assert.match(GROUP_ID_G1, /^[0-9a-f]{64}$/);
  assert.equal(await textGroupId(CHANNEL, 0), GROUP_ID_G0);
  assert.equal(await textGroupId(CHANNEL, 1), GROUP_ID_G1);
});

test(
  "design 5.5 vectors (parsed from the pinned design copy)",
  { skip: SKIP },
  async () => {
    const doc = readFileSync(DESIGN, "utf8");
    const inputs = vector(doc, "inputs");
    const ch = /^channel_id = (\S+)$/m.exec(inputs);
    assert.ok(ch, "channel_id not found in tv:inputs");
    assert.equal(ch[1], CHANNEL);
    assert.ok(
      doc.includes(`"${TEXT_GROUP_ID_CONTEXT}" LF channel_id LF decimal(g)`),
      "design 3.1 formula no longer names the context literal",
    );
    const g0 = vector(doc, "group_id_g0");
    const g1 = vector(doc, "group_id_g1");
    assert.equal(g0, GROUP_ID_G0);
    assert.equal(g1, GROUP_ID_G1);
    assert.equal(await textGroupId(ch[1], 0), g0);
    assert.equal(await textGroupId(ch[1], 1), g1);
  },
);

test("every generation 0..63: 64 lowercase hex, distinct, matches node:crypto", async () => {
  const seen = new Set<string>();
  for (let g = 0; g <= MAX_TEXT_GENERATION; g++) {
    const id = await textGroupId(CHANNEL, g);
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.equal(id, nodeId(CHANNEL, g));
    seen.add(id);
  }
  assert.equal(seen.size, 64);
  assert.notEqual(await textGroupId(OTHER_CHANNEL, 0), GROUP_ID_G0);
});

test("generation bounds: 63 accepted; 64 and non-integers refused", async () => {
  assert.equal(await textGroupId(CHANNEL, 63), nodeId(CHANNEL, 63));
  for (const g of [64, 65, -1, 1.5, Number.NaN, Infinity, 2 ** 32 - 1]) {
    await assert.rejects(textGroupId(CHANNEL, g), RangeError, `g = ${g}`);
  }
});

test("channel id must be a ULID (native parity)", async () => {
  for (const bad of [
    "",
    CHANNEL.toLowerCase(),
    CHANNEL.slice(1),
    `${CHANNEL}0`,
    "01J9Z3K4M5N6P7Q8R9S0T1V2WI", // I, L, O, U are outside Crockford base32
    "01J9Z3K4M5N6P7Q8R9S0T1V2WL",
    "01J9Z3K4M5N6P7Q8R9S0T1V2WO",
    "01J9Z3K4M5N6P7Q8R9S0T1V2WU",
    `${CHANNEL.slice(0, 25)}\n`,
  ]) {
    await assert.rejects(textGroupId(bad, 0), RangeError, JSON.stringify(bad));
  }
});

test("index: covers exactly generations 0..63 of an added channel", async () => {
  const index = new TextIdIndex();
  assert.equal(index.has(GROUP_ID_G0), false);
  assert.equal(index.get(GROUP_ID_G0), null);

  await index.addChannel(CHANNEL);
  assert.deepEqual(index.get(GROUP_ID_G0), {
    channelId: CHANNEL,
    generation: 0,
  });
  assert.deepEqual(index.get(GROUP_ID_G1), {
    channelId: CHANNEL,
    generation: 1,
  });
  for (let g = 0; g <= MAX_TEXT_GENERATION; g++) {
    const id = nodeId(CHANNEL, g);
    assert.equal(index.has(id), true, `g = ${g}`);
    assert.deepEqual(index.get(id), { channelId: CHANNEL, generation: g });
  }
  assert.equal(index.has(nodeId(CHANNEL, 64)), false);
  assert.equal(index.has(nodeId(OTHER_CHANNEL, 0)), false);
  assert.equal(index.has(GROUP_ID_G0.toUpperCase()), false);

  await index.addChannel(OTHER_CHANNEL);
  assert.deepEqual(index.get(nodeId(OTHER_CHANNEL, 63)), {
    channelId: OTHER_CHANNEL,
    generation: 63,
  });
  assert.equal(index.get(GROUP_ID_G0)?.channelId, CHANNEL);
});

test("index: get returns a copy", async () => {
  const index = new TextIdIndex();
  await index.addChannel(CHANNEL);
  const ref = index.get(GROUP_ID_G0);
  assert.ok(ref);
  ref.channelId = OTHER_CHANNEL;
  ref.generation = 5;
  assert.deepEqual(index.get(GROUP_ID_G0), {
    channelId: CHANNEL,
    generation: 0,
  });
});

test("index: ids enter together, only once addChannel resolves", async () => {
  const index = new TextIdIndex();
  const work = index.addChannel(CHANNEL);
  assert.equal(index.has(GROUP_ID_G0), false);
  await work;
  assert.equal(index.has(GROUP_ID_G0), true);
});

test("index: repeat and concurrent addChannel share one promise", async () => {
  const index = new TextIdIndex();
  const a = index.addChannel(CHANNEL);
  const b = index.addChannel(CHANNEL);
  assert.equal(a, b);
  await a;
  assert.equal(index.addChannel(CHANNEL), a);
});

test("index: an invalid channel rejects, indexes nothing, may be retried", async () => {
  const index = new TextIdIndex();
  const first = index.addChannel("not-a-ulid");
  await assert.rejects(first, RangeError);
  const second = index.addChannel("not-a-ulid");
  assert.notEqual(second, first);
  await assert.rejects(second, RangeError);
  assert.equal(index.has(nodeId("not-a-ulid", 0)), false);
});

test("index: ready flips only on markReady, independent of adds", async () => {
  const index = new TextIdIndex();
  assert.equal(index.ready, false);
  await index.addChannel(CHANNEL);
  assert.equal(index.ready, false);
  index.markReady();
  assert.equal(index.ready, true);
  index.markReady();
  assert.equal(index.ready, true);
  await index.addChannel(OTHER_CHANNEL);
  assert.equal(index.has(nodeId(OTHER_CHANNEL, 0)), true);
  assert.equal(index.ready, true);
});

// ---------------------------------------------------------------------------
// S2 reported ids (OR-7)
// ---------------------------------------------------------------------------

// Native v2 ids of CHANNEL (`e2ee-core/src/mls/text/formats.rs` @876c034
// `TV2_GROUP_ID_G*`, design 5.8 tv2). Opaque here: the webview never derives
// a v2 id (no salt parsing, OR-7); they only prove a real id shape indexes.
const NATIVE_CHANNEL = "01J9Z3K4M5N6P7Q8R9S0T1V2W3";
const TV2_G0 =
  "6036022873e9088d763291333fd3aad4eed2efa4ad97edc74349494d0fa24ac3";
const TV2_G1 =
  "f5d67f0df1e16b362c46ede8a927a8cb63b95ddca63822da6d691475b56fe81f";
const TV2_G64 =
  "787025fd12b11b64a85630a1fa261c420d919691633a6ab349a51173c671eb95";
const TV2_G65535 =
  "c6e859ede61183b2d91d57c50484667f004a96e931dc5cbc38d614674ae5e4c3";
const OWN_DEVICE = "00112233445566778899aabbccddeeff";

/**
 * `routeMls` with the bag `e2ee.ts` `#protectedRouteEnvelope` /
 * `#protectedRouteJoinRequest` pass (structural Tauri main window, no
 * platform hold, manager ready, an envelope addressed to this device).
 */
function routeFor(
  index: TextIdIndex,
  groupId: string,
  kind: "envelope" | "join_request" = "envelope",
) {
  return routeMls({
    structural: true,
    indexReady: index.ready, // `&& !platform.hold`, hold false here
    inIndex: index.has(groupId),
    managerReady: true,
    kind,
    recipientDeviceId: kind === "envelope" ? OWN_DEVICE : null,
    ownDeviceId: OWN_DEVICE,
  });
}

test("S2 constants: reported cap 65535, the v1 cap stays 63", () => {
  assert.equal(MAX_REPORTED_GENERATION, 65535);
  assert.equal(MAX_TEXT_GENERATION, 63);
  assert.equal(NATIVE_CHANNEL, CHANNEL);
});

test("addReported: a native v2 id is indexed and routed exactly like a v1 id", async () => {
  const index = new TextIdIndex();
  await index.addChannel(CHANNEL);
  index.markReady();
  assert.equal(routeFor(index, TV2_G0), "call");

  index.addReported(TV2_G0, CHANNEL, 0);
  assert.equal(index.has(TV2_G0), true);
  assert.deepEqual(index.get(TV2_G0), { channelId: CHANNEL, generation: 0 });
  assert.equal(routeFor(index, TV2_G0), "text");
  assert.equal(routeFor(index, TV2_G0, "join_request"), "text");
  // The v1 id of the same generation keeps routing to the same channel.
  assert.equal(routeFor(index, GROUP_ID_G0), "text");
  assert.deepEqual(index.get(GROUP_ID_G0), {
    channelId: CHANNEL,
    generation: 0,
  });
  // A reported id is held before ready, like a v1 id.
  const early = new TextIdIndex();
  early.addReported(TV2_G1, CHANNEL, 1);
  assert.equal(routeFor(early, TV2_G1), "pre_index_hold");
  assert.equal(early.ready, false);
  early.markReady();
  assert.equal(routeFor(early, TV2_G1), "text");
  // get returns a copy for a reported id too.
  const ref = index.get(TV2_G0);
  assert.ok(ref);
  ref.channelId = OTHER_CHANNEL;
  assert.deepEqual(index.get(TV2_G0), { channelId: CHANNEL, generation: 0 });
});

test("addReported: g > 63 reported ids are routed, with their generation", () => {
  const index = new TextIdIndex();
  index.markReady();
  const v1g64 = nodeId(CHANNEL, 64);
  assert.equal(routeFor(index, v1g64), "call");
  index.addReported(v1g64, CHANNEL, 64);
  index.addReported(TV2_G64, CHANNEL, 64);
  index.addReported(TV2_G65535, CHANNEL, MAX_REPORTED_GENERATION);
  assert.equal(routeFor(index, v1g64), "text");
  assert.equal(routeFor(index, TV2_G64), "text");
  assert.equal(routeFor(index, TV2_G65535, "join_request"), "text");
  assert.deepEqual(index.get(TV2_G64), { channelId: CHANNEL, generation: 64 });
  assert.deepEqual(index.get(TV2_G65535), {
    channelId: CHANNEL,
    generation: 65535,
  });
});

test("addReported: a group id that is not 64 lowercase hex is refused", () => {
  const index = new TextIdIndex();
  index.markReady();
  for (const bad of [
    TV2_G0.slice(1), // 63 chars
    `${TV2_G0}0`, // 65 chars
    TV2_G0.toUpperCase(),
    `A${TV2_G0.slice(1)}`, // one uppercase char
    `g${TV2_G0.slice(1)}`, // non-hex
    `${TV2_G0.slice(1)}\n`,
    ` ${TV2_G0.slice(1)}`,
    "",
  ]) {
    assert.throws(
      () => index.addReported(bad, CHANNEL, 0),
      RangeError,
      JSON.stringify(bad),
    );
    assert.equal(index.has(bad), false, JSON.stringify(bad));
    assert.equal(routeFor(index, bad), "call");
  }
  for (const bad of [null, undefined, 42]) {
    assert.throws(
      () => index.addReported(bad as unknown as string, CHANNEL, 0),
      RangeError,
    );
  }
});

test("addReported: a channel id that is not a ULID is refused", () => {
  const index = new TextIdIndex();
  for (const bad of [
    "",
    CHANNEL.toLowerCase(),
    CHANNEL.slice(1),
    `${CHANNEL}0`,
    "01J9Z3K4M5N6P7Q8R9S0T1V2WI",
    "01J9Z3K4M5N6P7Q8R9S0T1V2WU",
    `${CHANNEL.slice(0, 25)}\n`,
  ]) {
    assert.throws(
      () => index.addReported(TV2_G0, bad, 0),
      RangeError,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => index.addReported(TV2_G0, null as unknown as string, 0),
    RangeError,
  );
  assert.equal(index.has(TV2_G0), false);
});

test("addReported: generation 65536, -1, 1.5 and non-integers are refused", () => {
  const index = new TextIdIndex();
  for (const g of [
    65536,
    -1,
    1.5,
    Number.NaN,
    Infinity,
    2 ** 32,
    "5" as unknown as number,
  ]) {
    assert.throws(
      () => index.addReported(TV2_G0, CHANNEL, g),
      RangeError,
      `g = ${String(g)}`,
    );
  }
  assert.equal(index.has(TV2_G0), false);
  index.addReported(TV2_G0, CHANNEL, 0);
  index.addReported(TV2_G65535, CHANNEL, 65535);
  assert.equal(index.get(TV2_G65535)?.generation, 65535);
});

test("addReported: a conflicting mapping throws and the old mapping still routes", async () => {
  const index = new TextIdIndex();
  await index.addChannel(CHANNEL);
  index.markReady();
  index.addReported(TV2_G64, CHANNEL, 64);

  // Same reported id, another channel / another generation.
  assert.throws(() => index.addReported(TV2_G64, OTHER_CHANNEL, 64), Error);
  assert.throws(() => index.addReported(TV2_G64, CHANNEL, 65), Error);
  assert.deepEqual(index.get(TV2_G64), { channelId: CHANNEL, generation: 64 });
  assert.equal(routeFor(index, TV2_G64), "text");

  // A report that claims an eagerly derived v1 id for anything else.
  assert.throws(() => index.addReported(GROUP_ID_G0, OTHER_CHANNEL, 0), Error);
  assert.throws(() => index.addReported(GROUP_ID_G1, CHANNEL, 0), Error);
  assert.throws(() => index.addReported(GROUP_ID_G0, CHANNEL, 70), Error);
  assert.deepEqual(index.get(GROUP_ID_G0), {
    channelId: CHANNEL,
    generation: 0,
  });
  assert.deepEqual(index.get(GROUP_ID_G1), {
    channelId: CHANNEL,
    generation: 1,
  });
  assert.equal(routeFor(index, GROUP_ID_G0), "text");

  // The other order: an eager derive refuses an id a report already holds
  // for something else (rejects, indexes nothing of that channel).
  const other0 = nodeId(OTHER_CHANNEL, 0);
  index.addReported(other0, CHANNEL, 99);
  await assert.rejects(index.addChannel(OTHER_CHANNEL), /group id collision/);
  assert.deepEqual(index.get(other0), { channelId: CHANNEL, generation: 99 });
  assert.equal(index.has(nodeId(OTHER_CHANNEL, 1)), false);
});

test("addReported: the same mapping again is a no-op, also over a v1 id", async () => {
  const index = new TextIdIndex();
  index.addReported(TV2_G1, CHANNEL, 1);
  index.addReported(TV2_G1, CHANNEL, 1);
  assert.deepEqual(index.get(TV2_G1), { channelId: CHANNEL, generation: 1 });

  // A reported id that is the channel's own v1 id at that generation (a v1
  // list): before and after the eager derive, no collision either way.
  index.addReported(GROUP_ID_G0, CHANNEL, 0);
  await index.addChannel(CHANNEL);
  index.addReported(GROUP_ID_G1, CHANNEL, 1);
  for (let g = 0; g <= MAX_TEXT_GENERATION; g++) {
    assert.deepEqual(index.get(nodeId(CHANNEL, g)), {
      channelId: CHANNEL,
      generation: g,
    });
  }
  assert.equal(index.ready, false);
});

test("reported ids leave the v1 derivation and the 5.5 vectors unchanged", async () => {
  const index = new TextIdIndex();
  index.addReported(TV2_G0, CHANNEL, 0);
  index.addReported(TV2_G1, CHANNEL, 1);
  await index.addChannel(CHANNEL);
  assert.equal(await textGroupId(CHANNEL, 0), GROUP_ID_G0);
  assert.equal(await textGroupId(CHANNEL, 1), GROUP_ID_G1);
  assert.notEqual(GROUP_ID_G0, TV2_G0);
  assert.notEqual(GROUP_ID_G1, TV2_G1);
  assert.deepEqual(index.get(GROUP_ID_G0), {
    channelId: CHANNEL,
    generation: 0,
  });
  assert.deepEqual(index.get(TV2_G0), { channelId: CHANNEL, generation: 0 });
  // The v1 derivation keeps its own cap (the eager index stays 0..63).
  await assert.rejects(textGroupId(CHANNEL, 64), RangeError);
  assert.equal(index.has(nodeId(CHANNEL, 64)), false);
});
