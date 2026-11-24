// Pins for the Sloga hunks in `patches/livekit-client@2.15.13.patch` (iOS call
// E2EE phase 2, contract C-W3-1) — run with Node's built-in runner, from
// packages/client:
//   node --test --conditions=browser components/rtc/livekitPatchHunks.test.ts
//
// Two layers, because either can drift on its own:
//  1. the PATCH TEXT, which is what `pnpm install` applies on every machine;
//  2. the INSTALLED dist files, found the way Vite finds them, and RUN: the
//     worker bundle is imported behind the globals a browser worker has, and a
//     `Room` with E2EE is built from the esm bundle behind two stubs
//     (`window`, `RTCRtpScriptTransform`).
//
// Only the esm page bundle, the esm worker and the d.ts types are patched. The
// umd bundle and the CJS worker (`require` builds) are NOT: the resolution
// pins below fail if Vite would ever hand the client one of them.
//
// Every hunk test fails on the 7de02a68 patch, whose only Sloga hunk is the
// decode witness. The invariants (lock hash, Vite resolution, the source of a
// sender's transform `trackId`, which state.tsx derives per sender) are not
// hunks and pass there by design.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

// ---- the patch text -----------------------------------------------------

const root = new URL("../../../../", import.meta.url);
const patchText = readFileSync(
  new URL("patches/livekit-client@2.15.13.patch", root),
  "utf8",
);

const WORKER = "dist/livekit-client.e2ee.worker.mjs";
const ESM = "dist/livekit-client.esm.mjs";
const TYPES_DTS = "dist/src/e2ee/types.d.ts";
const KEY_PROVIDER_DTS = "dist/src/e2ee/KeyProvider.d.ts";

interface FileDiff {
  /** Only the `+` lines, prefix stripped. */
  added: string;
  /** The new side of every hunk (context + added), hunks split by "@@". */
  newSide: string;
}

function parsePatch(text: string): Map<string, FileDiff> {
  const out = new Map<string, FileDiff>();
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split("\n");
    const file = /^a\/(\S+) b\//.exec(lines[0])?.[1];
    if (!file) continue;
    const added: string[] = [];
    const newSide: string[] = [];
    let inHunk = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith("@@")) {
        inHunk = true;
        newSide.push("@@");
      } else if (!inHunk) {
        continue;
      } else if (line.startsWith("+")) {
        added.push(line.slice(1));
        newSide.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        newSide.push(line.slice(1));
      }
    }
    out.set(file, { added: added.join("\n"), newSide: newSide.join("\n") });
  }
  return out;
}

const diffs = parsePatch(patchText);

function diffOf(file: string): FileDiff {
  const d = diffs.get(file);
  assert.ok(d, `the patch has no hunk in ${file}`);
  return d;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Optional `// …` comment lines between two pinned statements. */
const C = String.raw`(?:[ \t]*//[^\n]*\n)*`;

test("C-W3-1 #1 patch: postKey sends keyBytes with NO key field (esm + d.ts)", () => {
  const esm = diffOf(ESM).newSide;
  assert.match(
    esm,
    /onSetEncryptionKey\(key, participantIdentity, keyIndex, keyBytes\) \{\n\s*const keyInfo = \{\n\s*key,\n\s*participantIdentity,\n\s*keyIndex\n\s*\};\n\s*if \(keyBytes !== undefined\) \{\n\s*keyInfo\.keyBytes = keyBytes;\n\s*\}/,
    "esm onSetEncryptionKey carries keyBytes into the KeyInfo",
  );
  // The raw message's data literal is enumerated EXACTLY: no `key` member.
  assert.match(
    esm,
    /const msg = keyBytes !== undefined \? \{\n\s*kind: 'setKey',\n\s*data: \{\n\s*participantIdentity: participantIdentity,\n\s*isPublisher,\n\s*keyBytes,\n\s*keyIndex\n\s*\}\n\s*\} : \{\n\s*kind: 'setKey',\n\s*data: \{\n\s*participantIdentity: participantIdentity,\n\s*isPublisher,\n\s*key,\n\s*keyIndex\n\s*\}/,
    "esm postKey: keyBytes message without key, else today's message",
  );
  assert.match(
    diffOf(TYPES_DTS).newSide,
    // KeyInfo's member order; the hunk's context starts at `key: CryptoKey;`.
    /\n\s*key: CryptoKey;\n\s*participantIdentity\?: string;\n\s*keyIndex\?: number;\n(?:\s*\/\*\*[^\n]*\*\/\n)?\s*keyBytes\?: Uint8Array;\n\};\nexport type E2EEManagerOptions/,
    "KeyInfo.keyBytes?: Uint8Array",
  );
  assert.ok(
    diffOf(KEY_PROVIDER_DTS).added.includes(
      "protected onSetEncryptionKey(key: CryptoKey, participantIdentity?: string, keyIndex?: number, keyBytes?: Uint8Array): void;",
    ),
    "onSetEncryptionKey's optional 4th parameter is typed",
  );
});

test("C-W3-1 #2 patch: the worker imports keyBytes as HKDF material itself and flags raw mode", () => {
  const w = diffOf(WORKER).newSide;
  assert.match(
    w,
    /let slogaMaterial = data\.key;\n\s*if \(data\.keyBytes !== undefined\) \{\n\s*slogaRawKeys = true;\n\s*slogaMaterial = yield crypto\.subtle\.importKey\('raw', data\.keyBytes, 'HKDF', false, \['deriveBits', 'deriveKey'\]\);\n\s*\}/,
  );
  assert.ok(w.includes("yield setSharedKey(slogaMaterial, data.keyIndex);"));
  assert.ok(
    w.includes(
      "yield getParticipantKeyHandler(data.participantIdentity).setKey(slogaMaterial, data.keyIndex);",
    ),
  );
  assert.ok(w.includes("let slogaRawKeys = false;"));
});

test("C-W3-1 #3 patch: every setKey is acked from a finally, ok only after the key is set, no key material", () => {
  const w = diffOf(WORKER).newSide;
  assert.match(
    w,
    /let slogaKeyOk = false;\n\s*try \{[\s\S]*?\} finally \{\n\s*postMessage\(\{\n\s*kind: 'slogaSetKeyAck',\n\s*data: \{\n\s*identity: data\.participantIdentity,\n\s*keyIndex: data\.keyIndex,\n\s*ok: slogaKeyOk\n\s*\}\n\s*\}\);\n\s*\}\n\s*break;/,
  );
  assert.equal(
    w.match(/;\n\s*slogaKeyOk = true;/g)?.length,
    2,
    "ok:true is set right after each of the two key-setting awaits",
  );
  assert.match(
    w,
    /yield setSharedKey\(slogaMaterial, data\.keyIndex\);\n\s*slogaKeyOk = true;/,
  );
  assert.match(
    w,
    /\.setKey\(slogaMaterial, data\.keyIndex\);\n\s*slogaKeyOk = true;/,
  );
});

test("C-W3-1 #4 patch: setupTransform (every attach path) posts slogaTransformAttached", () => {
  const w = diffOf(WORKER).newSide;
  assert.ok(
    w.includes(
      "postMessage({ kind: 'slogaTransformAttached', data: { trackId: trackId, kind: operation } });",
    ),
  );
  assert.match(
    w,
    /workerLogger\.debug\('reuse transform', Object\.assign\(\{\}, this\.logContext\)\);\n\s*slogaNoteAttached\(trackId, operation\);\n\s*return;/,
    "the reuse branch acks (the transform is live)",
  );
  assert.match(
    w,
    /this\.trackId = trackId;\n\s*slogaNoteAttached\(trackId, operation\);\n\s*\}/,
    "a new transform acks once it is piped",
  );
});

// The decode witness hunks of 7de02a68 (the heartbeat block and the
// decodeFunction wrapper), hashed after `witnessBlocks`. The heartbeat's `rte`
// field is the ONE change allowed in them.
const WITNESS_7DE02A68_SHA256 =
  "3ffda05511b119b746b5dfcd3538a30c8fe45a35ce232f025eff829862f0a011";
const RTE_LINE_7DE02A68 =
  "  postMessage({ kind: 'slogaDecodeWitness', data: { participants: participants } });";
const RTE_LINE =
  "  postMessage({ kind: 'slogaDecodeWitness', data: { participants: participants, rte: typeof self.RTCTransformEvent } });";

function witnessBlocks(added: string): string {
  const a = added.indexOf("// --- Sloga: the decode witness");
  const aEnd = added.indexOf("}, 1000);", a);
  const b = added.indexOf("    // Sloga decode witness.");
  const bTail = "  slogaInnerDecode(encodedFrame, controller) {";
  const bEnd = added.indexOf(bTail, b);
  assert.ok(a >= 0 && aEnd > a && b >= 0 && bEnd > b, "witness hunks found");
  return `${added.slice(a, aEnd + "}, 1000);".length)}\n--\n${added.slice(b, bEnd + bTail.length)}`;
}

test("C-W3-1 #5 patch: the heartbeat gains rte; the decode-witness hunks are otherwise 7de02a68's, byte for byte", () => {
  const blocks = witnessBlocks(diffOf(WORKER).added);
  assert.equal(blocks.split(RTE_LINE).length - 1, 1, "rte heartbeat line");
  assert.equal(
    sha256(blocks.replace(RTE_LINE, RTE_LINE_7DE02A68)),
    WITNESS_7DE02A68_SHA256,
    "nothing else in the witness hunks changed",
  );
});

test("C-W3-1 #6 patch: additional-codec senders are refused with an e2eeManager (both paths)", () => {
  const esm = diffOf(ESM).newSide;
  assert.match(
    esm,
    new RegExp(
      String.raw`publishAdditionalCodecForTrack\(track, videoCodec, options\) \{\n\s*return __awaiter\(this, void 0, void 0, function\* \(\) \{\n\s*var _a;\n${C}\s*if \(this\.engine && this\.engine\.e2eeManager\) \{\n[^\n]*\n[^\n]*\n[^\n]*\n\s*return;\n\s*\}`,
    ),
    "esm publishAdditionalCodecForTrack: first statement refuses",
  );
  assert.match(
    esm,
    new RegExp(
      String.raw`createSimulcastSender\(track, simulcastTrack, opts, encodings\) \{\n\s*return __awaiter\(this, void 0, void 0, function\* \(\) \{\n${C}\s*if \(this\.e2eeManager\) \{\n[^\n]*\n\s*return;\n\s*\}`,
    ),
    "esm createSimulcastSender: first statement refuses",
  );
});

test("C-W3-1 #7 patch: a throwing handleSender is caught and emitted as an EncryptionError", () => {
  assert.match(
    diffOf(ESM).newSide,
    new RegExp(
      String.raw`ParticipantEvent\.LocalSenderCreated, \(sender, track\) => __awaiter\(this, void 0, void 0, function\* \(\) \{\n${C}\s*try \{\n\s*this\.setupE2EESender\(track, sender\);\n\s*\} catch \(e\) \{\n\s*const slogaErr = new Error\('sloga: handleSender failed: ' \+[^\n]*\n[^\n]*\n\s*this\.emit\(EncryptionEvent\.EncryptionError, slogaErr\);\n\s*\}\n\s*\}\)\);`,
    ),
  );
});

test("C-W3-1 #8 patch: ticks are taken at receipt; a stale armed switch drops encode frames (8000 ms)", () => {
  const w = diffOf(WORKER).newSide;
  assert.ok(w.includes("const SLOGA_KEY_TICK_STALE_MS = 8000;"));
  assert.ok(w.includes("let slogaLastTickAt = undefined;"), "unarmed");
  assert.ok(
    w.includes(
      "return slogaLastTickAt !== undefined && performance.now() - slogaLastTickAt > SLOGA_KEY_TICK_STALE_MS;",
    ),
  );
  assert.match(
    w,
    new RegExp(
      String.raw`onmessage = ev => \{\n${C}\s*if \(ev\.data && ev\.data\.kind === 'slogaKeyTick'\) \{\n\s*slogaLastTickAt = performance\.now\(\);\n\s*return;\n\s*\}\n\s*messageQueue\.run\(`,
    ),
    "the tick is recorded before (outside) the message queue",
  );
  assert.match(
    w,
    new RegExp(
      String.raw`encodeFunction\(encodedFrame, controller\) \{\n${C}\s*if \(slogaKeyTickStale\(\)\) \{\n\s*return;\n\s*\}\n\s*return __awaiter`,
    ),
    "the drop is the first statement of encodeFunction (before any passthrough)",
  );
});

test("C-W3-1 #9 patch: in raw-key mode the ratchet reply carries NO key material", () => {
  // The raw-mode reply is posted and returned BEFORE livekit's message (which
  // carries `ratchetResult`) is built; its data literal is enumerated exactly.
  assert.match(
    diffOf(WORKER).newSide,
    new RegExp(
      String.raw`function emitRatchetedKeys\(ratchetResult, participantIdentity, keyIndex\) \{\n${C}\s*if \(slogaRawKeys\) \{\n\s*postMessage\(\{\n\s*kind: "ratchetKey",\n\s*data: \{\n\s*participantIdentity,\n\s*keyIndex\n\s*\}\n\s*\}\);\n\s*return;\n\s*\}\n\s*const msg = \{`,
    ),
  );
});

test("patch header: the unpatched require/CJS builds are named, and have no hunk", () => {
  const header = patchText.slice(0, patchText.indexOf("diff --git "));
  assert.match(
    header,
    /NOT patched \(not used by Sloga, pinned by livekitPatchHunks\.test\.ts\):\ndist\/livekit-client\.umd\.js and dist\/livekit-client\.e2ee\.worker\.js/,
  );
  assert.deepEqual(
    [...diffs.keys()].sort(),
    [ESM, WORKER, KEY_PROVIDER_DTS, TYPES_DTS].sort(),
    "hunks only in the esm bundle, the esm worker and the d.ts types",
  );
});

test("invariant: the lock's patchedDependencies hash is this patch's sha256", () => {
  const lock = readFileSync(new URL("pnpm-lock.yaml", root), "utf8");
  const hash = sha256(patchText);
  const pinned =
    /^patchedDependencies:\n(?: {2}.*\n)*? {2}livekit-client@2\.15\.13: ([0-9a-f]{64})$/m.exec(
      lock,
    )?.[1];
  assert.equal(pinned, hash, "patchedDependencies entry");
  const refs = [
    ...lock.matchAll(/livekit-client@2\.15\.13\(patch_hash=([0-9a-f]{64})\)/g),
  ];
  assert.ok(refs.length > 0, "the lock references the patched build");
  for (const r of refs) assert.equal(r[1], hash, "every patch_hash reference");
});

// ---- the installed dist: harness ----------------------------------------

const g = globalThis as unknown as Record<string, unknown>;

/** Records what livekit hands a script transform (the iOS sender path). */
class FakeScriptTransform {
  static made: { worker: unknown; options: Record<string, unknown> }[] = [];
  constructor(worker: unknown, options: Record<string, unknown>) {
    FakeScriptTransform.made.push({ worker, options });
  }
}

// What a browser worker has, for the worker bundle; what isE2EESupported()
// and E2EEManager read, for the page bundles.
g.self = globalThis;
g.window ??= globalThis;
g.onmessage ??= null;
g.RTCRtpScriptTransform = FakeScriptTransform;
g.MediaStreamTrack ??= class FakeMediaStreamTrack {};

interface WorkerMessage {
  kind: string;
  data: Record<string, unknown>;
}

const workerPosts: WorkerMessage[] = [];
g.postMessage = (m: unknown) => {
  workerPosts.push(m as WorkerMessage);
};

function posted(
  kind: string,
  pred: (d: Record<string, unknown>) => boolean = () => true,
): () => WorkerMessage | undefined {
  return () => workerPosts.find((m) => m.kind === kind && pred(m.data ?? {}));
}

async function waitFor<T>(
  what: string,
  find: () => T | undefined,
  ms = 3000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = find();
    if (v !== undefined) return v;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const workerUrl = import.meta.resolve("livekit-client/e2ee-worker");
let workerInstance = 0;

interface LoadedWorker {
  send(kind: string, data?: unknown): void;
  heartbeat: () => void;
  onrtctransform: unknown;
}

/**
 * A FRESH module instance of the installed worker bundle (its state is module
 * scope). Its once-a-second heartbeat is captured instead of scheduled.
 */
async function loadWorker(withTransformEvent: boolean): Promise<LoadedWorker> {
  const realSetInterval = g.setInterval;
  let heartbeat: (() => void) | undefined;
  g.setInterval = (fn: () => void) => {
    heartbeat = fn;
    return 0;
  };
  if (withTransformEvent) {
    g.RTCTransformEvent = function RTCTransformEvent() {};
  } else {
    delete g.RTCTransformEvent;
  }
  g.onrtctransform = undefined;
  try {
    await import(`${workerUrl}?instance=${++workerInstance}`);
  } finally {
    g.setInterval = realSetInterval;
  }
  const handler = g.onmessage as (ev: { data: unknown }) => void;
  assert.equal(typeof handler, "function", "the worker installed onmessage");
  assert.ok(heartbeat, "the worker scheduled its heartbeat");
  return {
    send: (kind, data) => handler({ data: { kind, data } }),
    heartbeat,
    onrtctransform: g.onrtctransform,
  };
}

const KEY_PROVIDER_OPTIONS = {
  sharedKey: false,
  ratchetSalt: "LKFrameEncryptionKey",
  ratchetWindowSize: 0,
  failureTolerance: 0,
  keyringSize: 16,
};

async function initWorker(w: LoadedWorker): Promise<void> {
  w.send("init", {
    keyProviderOptions: KEY_PROVIDER_OPTIONS,
    loglevel: "silent",
  });
  await waitFor("initAck", posted("initAck"));
}

const testKeyBytes = () => new Uint8Array(32).map((_, i) => i + 1);

const hkdf = (bytes: Uint8Array) =>
  crypto.subtle.importKey("raw", bytes, "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);

const ack = (identity: unknown, keyIndex: number) =>
  posted(
    "slogaSetKeyAck",
    (d) => d.identity === identity && d.keyIndex === keyIndex,
  );

// ---- the installed dist: worker -------------------------------------------

test("C-W3-1 #2 #3 dist worker: keyBytes are imported IN the worker and acked; the CryptoKey path is acked too", async () => {
  workerPosts.length = 0;
  const w = await loadWorker(false);
  await initWorker(w);
  w.send("setKey", {
    participantIdentity: "me",
    isPublisher: true,
    keyBytes: testKeyBytes(),
    keyIndex: 3,
  });
  const raw = await waitFor("raw-key ack", ack("me", 3));
  assert.deepEqual(raw.data, { identity: "me", keyIndex: 3, ok: true });
  w.send("setKey", {
    participantIdentity: "peer",
    isPublisher: false,
    key: await hkdf(testKeyBytes()),
    keyIndex: 1,
  });
  const ck = await waitFor("CryptoKey ack", ack("peer", 1));
  assert.deepEqual(ck.data, { identity: "peer", keyIndex: 1, ok: true });
});

test("C-W3-1 #3 dist worker: a setKey that sets nothing, or throws, is acked ok:false", async () => {
  workerPosts.length = 0;
  const w = await loadWorker(false);
  await initWorker(w);
  w.send("setKey", {
    isPublisher: false,
    keyBytes: testKeyBytes(),
    keyIndex: 2,
  });
  const none = await waitFor("no-identity ack", ack(undefined, 2));
  assert.deepEqual(none.data, { identity: undefined, keyIndex: 2, ok: false });

  // An import that throws: acked, then livekit's own rejection is unchanged
  // (it escapes the message queue unhandled, as it always did).
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const rejections: unknown[] = [];
  process.on("unhandledRejection", (e) => rejections.push(e));
  try {
    w.send("setKey", {
      participantIdentity: "me",
      isPublisher: true,
      keyBytes: "not key bytes",
      keyIndex: 4,
    });
    const bad = await waitFor("throwing-import ack", ack("me", 4));
    assert.deepEqual(bad.data, { identity: "me", keyIndex: 4, ok: false });
    await waitFor("the original rejection", () => rejections[0]);
  } finally {
    process.removeAllListeners("unhandledRejection");
    for (const l of saved) process.on("unhandledRejection", l);
  }
});

interface Frame {
  data: ArrayBuffer;
  timestamp: number;
  getMetadata(): { synchronizationSource: number };
}

test("C-W3-1 #4 #8 dist worker: attaches are acked; the first tick arms a dead-man that DROPS stale encode frames", async () => {
  workerPosts.length = 0;
  const w = await loadWorker(false);
  await initWorker(w);
  w.send("enable", { enabled: true, participantIdentity: "me" });
  await waitFor(
    "enable reply",
    posted("enable", (d) => d.participantIdentity === "me"),
  );
  w.send("setKey", {
    participantIdentity: "me",
    isPublisher: true,
    keyBytes: testKeyBytes(),
    keyIndex: 5,
  });
  await waitFor("key ack", ack("me", 5));

  const out: Frame[] = [];
  let feed: ReadableStreamDefaultController<Frame> | undefined;
  const readable = new ReadableStream<Frame>({
    start(c) {
      feed = c;
    },
  });
  const writable = new WritableStream<Frame>({
    write(f) {
      out.push(f);
    },
  });
  w.send("encode", {
    readableStream: readable,
    writableStream: writable,
    trackId: "local-track-1",
    participantIdentity: "me",
    isReuse: false,
  });
  const enc = await waitFor(
    "encode attach",
    posted("slogaTransformAttached", (d) => d.trackId === "local-track-1"),
  );
  assert.deepEqual(enc.data, { trackId: "local-track-1", kind: "encode" });
  w.send("decode", {
    readableStream: new ReadableStream(),
    writableStream: new WritableStream(),
    trackId: "remote-track-1",
    participantIdentity: "peer",
    isReuse: false,
  });
  const dec = await waitFor(
    "decode attach",
    posted("slogaTransformAttached", (d) => d.trackId === "remote-track-1"),
  );
  assert.deepEqual(dec.data, { trackId: "remote-track-1", kind: "decode" });

  const frame = (timestamp: number): Frame => ({
    data: new Uint8Array([0xaa, 1, 2, 3, 4, 5, 6, 7]).buffer,
    timestamp,
    getMetadata: () => ({ synchronizationSource: 7 }),
  });
  const arrived = (ts: number) => () => out.find((f) => f.timestamp === ts);
  let now = 1_000_000;
  let nowCalls = 0;
  const realNow = Object.getOwnPropertyDescriptor(performance, "now");
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: () => {
      nowCalls += 1;
      return now;
    },
  });
  try {
    assert.ok(feed);
    // Unarmed (no tick yet): encrypted under the raw key and sent.
    feed.enqueue(frame(1));
    const f1 = await waitFor("frame 1", arrived(1));
    assert.equal(
      f1.data.byteLength,
      8 + 16 + 12 + 2,
      "AES-GCM tag + IV + trailer",
    );
    assert.equal(
      new Uint8Array(f1.data)[f1.data.byteLength - 1],
      5,
      "key index",
    );

    w.send("slogaKeyTick", { at: 123 });
    now += 8000; // exactly the bound: not yet stale
    feed.enqueue(frame(2));
    await waitFor("frame 2", arrived(2));

    now += 1; // stale
    const before = nowCalls;
    feed.enqueue(frame(3));
    await waitFor("frame 3 reached the cryptor", () =>
      nowCalls > before ? true : undefined,
    );
    w.send("slogaKeyTick", { at: 456 }); // resumes
    feed.enqueue(frame(4));
    await waitFor("frame 4", arrived(4));
    assert.deepEqual(
      out.map((f) => f.timestamp),
      [1, 2, 4],
      "frame 3 was dropped, never passed through",
    );
  } finally {
    if (realNow) Object.defineProperty(performance, "now", realNow);
    else delete (performance as unknown as Record<string, unknown>).now;
  }
});

test("C-W3-1 #5 #4 dist worker: the heartbeat gains rte and nothing else; onrtctransform acks its attach", async () => {
  workerPosts.length = 0;
  const plain = await loadWorker(false);
  plain.heartbeat();
  assert.deepEqual(posted("slogaDecodeWitness")()?.data, {
    participants: [],
    rte: "undefined",
  });
  workerPosts.length = 0;
  const st = await loadWorker(true);
  try {
    await initWorker(st);
    workerPosts.length = 0;
    st.heartbeat();
    assert.deepEqual(posted("slogaDecodeWitness")()?.data, {
      participants: [],
      rte: "function",
    });
    assert.equal(typeof st.onrtctransform, "function");
    (st.onrtctransform as (ev: unknown) => void)({
      transformer: {
        options: {
          kind: "encode",
          participantIdentity: "me",
          trackId: "local-track-9",
        },
        readable: new ReadableStream(),
        writable: new WritableStream(),
      },
    });
    const att = await waitFor(
      "onrtctransform attach",
      posted("slogaTransformAttached", (d) => d.trackId === "local-track-9"),
    );
    assert.deepEqual(att.data, { trackId: "local-track-9", kind: "encode" });
  } finally {
    delete g.RTCTransformEvent;
  }
});

test("C-W3-1 #9 dist worker: under raw keys the ratchet reply has no key material; the CryptoKey path keeps livekit's", async () => {
  workerPosts.length = 0;
  const raw = await loadWorker(false);
  await initWorker(raw);
  raw.send("setKey", {
    participantIdentity: "me",
    isPublisher: true,
    keyBytes: testKeyBytes(),
    keyIndex: 0,
  });
  await waitFor("raw ack", ack("me", 0));
  raw.send("ratchetRequest", { participantIdentity: "me", keyIndex: 0 });
  const reply = await waitFor("raw ratchet reply", posted("ratchetKey"));
  assert.deepEqual(
    reply.data,
    { participantIdentity: "me", keyIndex: 0 },
    "identity and index only: no CryptoKey, no chain key",
  );

  workerPosts.length = 0;
  const ck = await loadWorker(false);
  await initWorker(ck);
  ck.send("setKey", {
    participantIdentity: "me",
    isPublisher: true,
    key: await hkdf(testKeyBytes()),
    keyIndex: 0,
  });
  await waitFor("CryptoKey ack", ack("me", 0));
  ck.send("ratchetRequest", { participantIdentity: "me", keyIndex: 0 });
  const reply2 = await waitFor("CryptoKey ratchet reply", posted("ratchetKey"));
  const result2 = reply2.data.ratchetResult as Record<string, unknown>;
  assert.ok(
    result2.cryptoKey instanceof CryptoKey,
    "livekit's reply, unchanged",
  );
});

// ---- the installed dist: what Vite resolves -------------------------------

// Vite 5.4.19, `resolveExportsOrImports` + resolve.exports: for an ESM import
// on a web target the condition set is the one below (no "require", no
// "node"), and the FIRST key of the exports entry, in object order, that is in
// the set wins. A package with no `exports` falls back to DEFAULT_MAIN_FIELDS.
const VITE_WEB_CONDITIONS = new Set([
  "default",
  "import",
  "browser",
  "module",
  "production",
  "development",
]);
const VITE_MAIN_FIELDS = ["browser", "module", "jsnext:main", "jsnext"];

function pickExport(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) {
    for (const e of entry) {
      const r = pickExport(e);
      if (r) return r;
    }
    return undefined;
  }
  if (entry && typeof entry === "object") {
    for (const [condition, value] of Object.entries(entry)) {
      if (!VITE_WEB_CONDITIONS.has(condition)) continue;
      const r = pickExport(value);
      if (r) return r;
    }
  }
  return undefined;
}

type PackageJson = Record<string, unknown>;

function viteEntry(pkg: PackageJson, subpath: string): string | undefined {
  const exp = pkg.exports;
  if (exp !== undefined) {
    const subpathMap =
      typeof exp === "object" &&
      exp !== null &&
      !Array.isArray(exp) &&
      Object.keys(exp).some((k) => k.startsWith("."));
    if (subpathMap) {
      return pickExport((exp as Record<string, unknown>)[subpath]);
    }
    return subpath === "." ? pickExport(exp) : undefined;
  }
  if (subpath !== ".") return undefined;
  for (const field of VITE_MAIN_FIELDS) {
    const value = pkg[field];
    if (typeof value === "string") return value;
  }
  return typeof pkg.main === "string" ? pkg.main : undefined;
}

/** The package named `name`, found by walking up from a file it resolved to. */
function packageAt(
  fileUrl: string,
  name: string,
): { pkg: PackageJson; dir: URL } {
  let dir = new URL("./", fileUrl);
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(new URL("package.json", dir), "utf8"),
      ) as PackageJson;
      if (pkg.name === name) return { pkg, dir };
    } catch {
      // no package.json at this level
    }
    dir = new URL("../", dir);
  }
  assert.fail(`no package.json for ${name} above ${fileUrl}`);
}

const esmUrl = import.meta.resolve("livekit-client");
const requireHere = createRequire(import.meta.url);

test("invariant: Vite gives the client livekit's esm bundle and esm worker, never the umd/CJS builds", () => {
  const vite = requireHere("vite/package.json") as { version: string };
  assert.match(vite.version, /^5\./, "the resolution rule above is Vite 5's");
  const config = readFileSync(
    new URL("../../vite.config.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    config,
    /\b(conditions|mainFields)\b/,
    "vite.config.ts changes resolution: re-derive this pin",
  );
  const { pkg: lk } = packageAt(esmUrl, "livekit-client");
  // Only these two subpaths exist, so no deep import can reach dist/*.js.
  assert.deepEqual(Object.keys(lk.exports as object), [".", "./e2ee-worker"]);
  assert.equal(viteEntry(lk, "."), "./dist/livekit-client.esm.mjs");
  assert.equal(
    viteEntry(lk, "./e2ee-worker"),
    "./dist/livekit-client.e2ee.worker.mjs",
  );
  // The files this spec drives are those same two.
  assert.match(esmUrl, /\/livekit-client\.esm\.mjs$/);
  assert.match(workerUrl, /\/livekit-client\.e2ee\.worker\.mjs$/);
});

test("invariant: the client's @livekit dependents resolve to ESM, so they import (never require) livekit-client", () => {
  for (const name of [
    "@livekit/components-core",
    "@livekit/track-processors",
  ]) {
    const { pkg, dir } = packageAt(import.meta.resolve(name), name);
    const entry = viteEntry(pkg, ".");
    assert.ok(entry && /\.mjs$/.test(entry), `${name}: Vite picks ${entry}`);
    const source = readFileSync(new URL(entry, dir), "utf8");
    assert.doesNotMatch(source, /require\(\s*["']livekit-client["']\s*\)/);
  }
});

// ---- the installed dist: the esm page bundle ------------------------------

interface Emitter {
  on(event: string, f: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): boolean;
}

interface RoomLike extends Emitter {
  engine: {
    createSimulcastSender(...args: unknown[]): Promise<unknown>;
  };
  localParticipant: Emitter & {
    identity: string;
    publishAdditionalCodecForTrack(
      track: unknown,
      codec: string,
      options: unknown,
    ): Promise<unknown>;
  };
}

interface KeyProviderLike {
  onSetEncryptionKey(
    key: CryptoKey,
    participantIdentity?: string,
    keyIndex?: number,
    keyBytes?: Uint8Array,
  ): void;
  getKeys(): Record<string, unknown>[];
}

interface LiveKit {
  Room: new (options: Record<string, unknown>) => RoomLike;
  BaseKeyProvider: new (options: Record<string, unknown>) => KeyProviderLike;
  RoomEvent: { EncryptionError: string };
  ParticipantEvent: { LocalSenderCreated: string };
  setLogLevel(level: string): void;
}

// The bundle Vite resolves (pinned above); the umd build is not patched.
const bundles: [string, () => Promise<LiveKit>][] = [
  ["esm", async () => (await import(esmUrl)) as LiveKit],
];

test("C-W3-1 #1 dist d.ts: the installed types carry KeyInfo.keyBytes and the 4th parameter", () => {
  const types = readFileSync(new URL("src/e2ee/types.d.ts", esmUrl), "utf8");
  assert.match(
    types,
    /export type KeyInfo = \{\n\s*key: CryptoKey;\n\s*participantIdentity\?: string;\n\s*keyIndex\?: number;\n(?:\s*\/\*\*[^\n]*\*\/\n)?\s*keyBytes\?: Uint8Array;\n\};/,
  );
  const provider = readFileSync(
    new URL("src/e2ee/KeyProvider.d.ts", esmUrl),
    "utf8",
  );
  assert.ok(
    provider.includes(
      "protected onSetEncryptionKey(key: CryptoKey, participantIdentity?: string, keyIndex?: number, keyBytes?: Uint8Array): void;",
    ),
  );
});

function makeRoom(lk: LiveKit, e2ee: boolean) {
  const posts: WorkerMessage[] = [];
  const worker = {
    postMessage: (m: unknown) => posts.push(m as WorkerMessage),
    onmessage: null,
    onerror: null,
  };
  const keyProvider = new lk.BaseKeyProvider({
    sharedKey: false,
    ratchetWindowSize: 0,
    failureTolerance: 0,
  });
  const room = new lk.Room(
    e2ee
      ? { e2ee: { keyProvider, worker }, dynacast: true }
      : { dynacast: true },
  );
  return { room, keyProvider, posts };
}

for (const [name, load] of bundles) {
  test(`C-W3-1 #1 dist ${name}: a KeyInfo with keyBytes posts keyBytes and NO key; without, today's message`, async () => {
    const lk = await load();
    lk.setLogLevel("silent");
    const { keyProvider, posts } = makeRoom(lk, true);
    const material = await hkdf(testKeyBytes());
    const bytes = testKeyBytes();
    keyProvider.onSetEncryptionKey(material, "alice", 3, bytes);
    const raw = posts[posts.length - 1];
    assert.equal(raw?.kind, "setKey");
    assert.deepEqual(Object.keys(raw.data).sort(), [
      "isPublisher",
      "keyBytes",
      "keyIndex",
      "participantIdentity",
    ]);
    assert.equal(raw.data.keyBytes, bytes);
    assert.equal(raw.data.keyIndex, 3);
    const aliceInfo = keyProvider
      .getKeys()
      .find((k) => k.participantIdentity === "alice");
    assert.equal(aliceInfo?.keyBytes, bytes, "the replay set keeps the bytes");

    keyProvider.onSetEncryptionKey(material, "bob", 1);
    assert.deepEqual(posts[posts.length - 1], {
      kind: "setKey",
      data: {
        participantIdentity: "bob",
        isPublisher: false,
        key: material,
        keyIndex: 1,
      },
    });
    const bobInfo = keyProvider
      .getKeys()
      .find((k) => k.participantIdentity === "bob");
    assert.ok(
      bobInfo && !("keyBytes" in bobInfo),
      "Chromium KeyInfo unchanged",
    );
  });

  test(`C-W3-1 #7 dist ${name}: a throwing handleSender reaches RoomEvent.EncryptionError`, async () => {
    const lk = await load();
    lk.setLogLevel("silent");
    const { room } = makeRoom(lk, true);
    const errors: Error[] = [];
    room.on(lk.RoomEvent.EncryptionError, (e) => errors.push(e as Error));
    // Before connect the local identity is "", so livekit's handleSender
    // throws; unpatched, that was a swallowed rejection and no transform.
    room.localParticipant.emit(
      lk.ParticipantEvent.LocalSenderCreated,
      {},
      { isLocal: true, mediaStreamID: "local-track-1" },
    );
    const err = await waitFor("encryption error", () => errors[0]);
    assert.match(
      err.message,
      /^sloga: handleSender failed: local identity needs to be known/,
    );
  });

  test(`C-W3-1 #6 dist ${name}: no additional-codec sender while the room has an e2eeManager`, async () => {
    const lk = await load();
    lk.setLogLevel("silent");
    const track = { kind: "video", isLocal: true };
    const simulcastTrack = { mediaStreamTrack: {} };
    const enc = makeRoom(lk, true);
    assert.equal(
      await enc.room.localParticipant.publishAdditionalCodecForTrack(
        track,
        "vp9",
        {},
      ),
      undefined,
    );
    assert.equal(
      await enc.room.engine.createSimulcastSender(
        track,
        simulcastTrack,
        { videoCodec: "vp9" },
        [],
      ),
      undefined,
    );
    // Control: WITHOUT an e2eeManager livekit's own path still runs (here it
    // throws, the track being unpublished / no WebRTC in node).
    const plain = makeRoom(lk, false);
    await assert.rejects(
      plain.room.localParticipant.publishAdditionalCodecForTrack(
        track,
        "vp9",
        {},
      ),
      /not published/,
    );
    await assert.rejects(
      plain.room.engine.createSimulcastSender(
        track,
        simulcastTrack,
        { videoCodec: "vp9" },
        [],
      ),
    );
  });

  test(`invariant dist ${name}: a sender's transform trackId is LocalTrack.mediaStreamID`, async () => {
    const lk = await load();
    lk.setLogLevel("silent");
    const { room } = makeRoom(lk, true);
    room.localParticipant.identity = "me";
    FakeScriptTransform.made.length = 0;
    const sender: Record<string, unknown> = {};
    room.localParticipant.emit(lk.ParticipantEvent.LocalSenderCreated, sender, {
      isLocal: true,
      mediaStreamID: "first-track-id",
      mediaStreamTrack: { id: "restarted-track-id" },
    });
    const made = await waitFor(
      "script transform",
      () => FakeScriptTransform.made[0],
    );
    assert.deepEqual(made.options, {
      kind: "encode",
      participantIdentity: "me",
      trackId: "first-track-id",
      codec: undefined,
    });
    assert.ok(sender.transform instanceof FakeScriptTransform);
  });
}
