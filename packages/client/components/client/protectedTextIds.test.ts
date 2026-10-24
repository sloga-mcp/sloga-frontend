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
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
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
