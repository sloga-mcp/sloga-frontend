/**
 * Run with:
 *
 *     node --conditions=browser --test components/state/stores/protectedDraft.scan.test.ts
 *
 * Protected channels (W4 lane C5, plan D9d/D9e/D10, W4b audit M2/M4): the
 * never-plaintext rules of `./Draft.ts`. Source scans (S*) pin the order of
 * the guards in the text; behaviour specs (B*) load the file through the
 * `module.registerHooks` substitution `./draftUpload.test.ts` documents
 * (every import of the module under test is a stand-in, except the draft
 * guard, which is the real module shared with this spec).
 *
 * Known-bad control: set `PROTECTED_DRAFT_UNDER_TEST` to an absolute path of
 * another copy of `Draft.ts` (the one at 7a1e03ca, or a mutant of this one)
 * and the specs it breaks fail. The copy may live anywhere: all of its
 * relative imports are substituted.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ProtectedSendError } from "../../client/protectedSendError.ts";
import { protectedNoticeForError } from "../../client/protectedShield.ts";
import {
  isProtectedForDraft,
  setProtectedChannelResolver,
} from "./protectedDraftGuard.ts";

const UNDER_TEST = process.env.PROTECTED_DRAFT_UNDER_TEST
  ? pathToFileURL(process.env.PROTECTED_DRAFT_UNDER_TEST).href
  : new URL("./Draft.ts", import.meta.url).href;

const RAW = readFileSync(fileURLToPath(UNDER_TEST), "utf8");

// ---- source helpers --------------------------------------------------------

/** Drop block and line comments (no `//` inside strings in this file) */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const SRC = stripComments(RAW);

/**
 * Body of the class member whose signature matches `re`, braces included
 * @param src Source
 * @param re Signature pattern
 * @returns Body text
 */
function member(src: string, re: RegExp): string {
  const m = re.exec(src);
  assert.ok(m, `member ${re} not found`);
  const start = src.indexOf("{", m.index + m[0].length);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`member ${re} has no closing brace`);
}

const count = (src: string, needle: string) => src.split(needle).length - 1;

/** Index of `needle` in `src`, failing when absent */
function at(src: string, needle: string): number {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, `${JSON.stringify(needle)} not found`);
  return i;
}

const SEND_DRAFT = () => member(SRC, /\n {2}async sendDraft\(/);
const SEND_PROTECTED = () =>
  member(SRC, /\n {2}private async sendProtectedDraft\(/);
const ADD_FILE = () =>
  member(SRC, /\n {2}addFile\(channelId: string, file: File\)/);
const BIND = () => member(SRC, /\n {2}bindClient\(client: Client\)/);

// ---- S: source scans -------------------------------------------------------

describe("protected Draft source scans", () => {
  it("S1 (C-C5a): sendDraft's protected check is its first statement, before pop/upload/prepare", () => {
    assert.match(
      SEND_DRAFT(),
      /^\{\s*if \(client\.isProtectedChannel\(channel\.id\)\) \{\s*return this\.sendProtectedDraft\(\s*client,\s*channel,\s*existingDraft,\s*retryOf,?\s*\);\s*\}/,
      "first statement routes protected channels away",
    );
    const guard = at(SEND_DRAFT(), "client.isProtectedChannel(channel.id)");
    for (const later of [
      "this.popDraft(",
      "prepareDraftAttachments",
      "uploadFileChunked(",
      "new XMLHttpRequest()",
      "channel.sendMessage(",
    ]) {
      assert.ok(guard < at(SEND_DRAFT(), later), `guard precedes ${later}`);
    }
    assert.equal(count(SEND_DRAFT(), "isProtectedChannel"), 1);
  });

  it("S2: the protected path never uploads and refuses files before the pop", () => {
    for (const forbidden of [
      "prepareDraftAttachments",
      "uploadFileChunked",
      "XMLHttpRequest",
      "autumn",
      "attachments:",
      "e2eeAttachments",
    ]) {
      assert.equal(count(SEND_PROTECTED(), forbidden), 0, `no ${forbidden}`);
    }
    const files = at(SEND_PROTECTED(), "if (draft.files?.length) {");
    const refuse = at(
      SEND_PROTECTED(),
      'new StoatSdk.ProtectedFieldRefusedClient("attachments")',
    );
    const outbox = at(SEND_PROTECTED(), 'this.set("outbox", channel.id, [');
    const pop = at(SEND_PROTECTED(), "this.popDraft(channel.id)");
    const send = at(SEND_PROTECTED(), "channel.sendMessage(");
    assert.ok(files < refuse && refuse < outbox, "files refused first");
    assert.ok(outbox < pop, "outbox entry exists before the pop");
    assert.ok(pop < send, "popped before the send");
    assert.match(
      SEND_PROTECTED(),
      /const draft = existingDraft \?\? this\.getDraft\(channel\.id\);/,
      "read, not popped",
    );
    assert.match(
      SEND_PROTECTED(),
      /await channel\.sendMessage\(\{ content, replies \}, idempotencyKey\);/,
      "text and replies only",
    );
  });

  it("S3 (C-C5b): addFile refuses protected channels before queueing and again before admitting", () => {
    assert.match(
      ADD_FILE(),
      /^\{\s*if \(isProtectedForDraft\(channelId\)\) \{\s*console\.warn\([^;]*\);\s*return Promise\.resolve\(\);\s*\}/,
      "first statement refuses",
    );
    assert.ok(
      at(ADD_FILE(), "isProtectedForDraft(channelId)") <
        at(ADD_FILE(), "this.attachQueue.then("),
    );
    const recheck = ADD_FILE().lastIndexOf("isProtectedForDraft(channelId)");
    assert.ok(
      at(ADD_FILE(), "await this.cacheFile(") < recheck &&
        recheck < at(ADD_FILE(), "this.setDraft(channelId"),
      "re-checked after the read, before the draft takes the file",
    );
    assert.equal(count(ADD_FILE(), "isProtectedForDraft(channelId)"), 2);
  });

  it("S4: the resolver is installed once per client, from both send paths", () => {
    assert.match(
      BIND(),
      /if \(this\.boundClient === client\) return;\s*this\.boundClient = client;/,
    );
    assert.match(
      BIND(),
      /setProtectedChannelResolver\(\(channelId\) =>\s*client\.isProtectedChannel\(channelId\),?\s*\);/,
    );
    assert.equal(count(SRC, "setProtectedChannelResolver("), 1, "one site");
    assert.equal(count(SRC, "setProtectedChannelResolver(null"), 0);
    assert.match(SEND_DRAFT(), /this\.bindClient\(client\);/);
    assert.match(SEND_PROTECTED(), /^\{\s*this\.bindClient\(client\);/);
  });

  it("S5 (C-C5c): a protected retry reuses retryOf as the key, never a fresh ulid", () => {
    assert.match(
      SEND_PROTECTED(),
      /const idempotencyKey = retryOf \?\? ulid\(\);/,
    );
    assert.equal(count(SEND_PROTECTED(), "ulid()"), 1);
    assert.equal(count(SEND_PROTECTED(), "idempotencyKey = "), 1);
  });

  it("S6 (C-C5d/e/f): one copy per rejection: undelivered → composer, else failed entry; always rethrown", () => {
    const m = /\} catch \(error\) \{([\s\S]*?)\n {4}\}/.exec(SEND_PROTECTED());
    assert.ok(m, "the send has a catch");
    const body = m[1];
    assert.match(
      body,
      /const undelivered = !retryOf && protectedSendUndelivered\(error\);/,
      "only a fresh key can be known undelivered",
    );
    assert.match(
      body,
      /if \(\s*undelivered &&\s*!existingDraft &&\s*this\.restoreProtectedText\(channel\.id, content, replies\)\s*\) \{\s*this\.cancelSend\(channel, idempotencyKey\);\s*\} else \{\s*this\.markProtectedFailed\(\s*channel\.id,\s*idempotencyKey,\s*error,\s*undelivered,?\s*\);\s*\}/,
      "restore + delete, or failed entry under the same key",
    );
    assert.equal(count(body, "restoreProtectedText("), 1);
    assert.equal(count(body, "cancelSend("), 1);
    assert.match(body, /throw error;\s*$/, "rethrow is the last statement");
    const restore = member(SRC, /\n {2}private restoreProtectedText\(/);
    assert.match(restore, /if \(current\.content\) return false;/);
    assert.match(restore, /this\.setDraft\(channelId, \{/);
    assert.match(restore, /this\.replaceNode\(channelId, \[content\]\);/);
    assert.match(restore, /return true;\s*\}$/);
  });

  it("S9: undelivered is decided from the failure cause, unknown by default", () => {
    const fn = member(SRC, /\nfunction protectedSendUndelivered\(/);
    assert.match(
      fn,
      /const failure = protectedFailureOf\(error\);\s*if \(!failure\) return false;/,
    );
    assert.match(
      fn,
      /if \(source === "server" \|\| source === "native"\) return true;/,
    );
    assert.match(fn, /UNDELIVERED_CLIENT_REASONS\.has\(reason\)/);
    assert.equal(count(fn, '"transport"'), 0, "transport is never undelivered");
    const reasons =
      /const UNDELIVERED_CLIENT_REASONS = new Set\(\[([\s\S]*?)\]\);/.exec(SRC);
    assert.ok(reasons);
    for (const unknown of ["maybe_unsent", "unexpected_error", "unexpected"]) {
      assert.equal(
        count(reasons[1], `"${unknown}"`),
        0,
        `${unknown} is unknown`,
      );
    }
    const of = member(SRC, /\nfunction protectedFailureOf\(/);
    assert.match(of, /if \(isProtectedSendError\(error\)\) \{/);
  });

  it("S10: the bridge contract S9 relies on (B4 encryptAndSend, B5 handleProtectedSend)", () => {
    // After the first POST, encryptAndSend only throws TRANSPORT (bytes kept,
    // unknown), or a refusal / maybe_unsent / re-secure failure after deleting
    // the stored bytes. A new throw there must be re-classified here first.
    const B4 = stripComments(
      readFileSync(
        fileURLToPath(
          new URL("../../client/protectedTextMessages.ts", import.meta.url),
        ),
        "utf8",
      ),
    );
    const send = member(B4, /\nexport async function encryptAndSend\(/);
    const afterPost = send.slice(at(send, "let answer = await post();"));
    const throws = afterPost.match(/throw [^;]+;/g) ?? [];
    assert.deepEqual([...new Set(throws)].sort(), [
      "throw TRANSPORT;",
      'throw clientFailure("maybe_unsent");',
      "throw serverFailure(action.status, action.type, lastBody);",
      "throw toFailure(e);",
    ]);
    assert.match(afterPost, /deleteEntry\(port, k\);\s*throw toFailure\(e\);/);
    assert.match(
      afterPost,
      /deleteEntry\(port, k\);[\s\S]{0,300}throw serverFailure\(/,
    );
    for (const helper of [
      /\n {2}const pause = async/,
      /\n {2}const resend = async/,
    ]) {
      const h = member(send, helper);
      assert.deepEqual(
        [...new Set(h.match(/throw [^;]+;/g))],
        ["throw TRANSPORT;"],
      );
    }
    // B5 wraps every rejection, including anything thrown after delivery,
    // whose cause then is not a TextFlowFailure (counted unknown above).
    const B5 = stripComments(
      readFileSync(
        fileURLToPath(new URL("../../client/e2ee.ts", import.meta.url)),
        "utf8",
      ),
    );
    const hps = member(B5, /\n {2}async handleProtectedSend\(/);
    assert.match(
      hps,
      /\} catch \(error\) \{\s*throw toProtectedSendError\(error\);\s*\}\s*\}$/,
    );
  });

  it("S7: setProtectedOutboxKeys is registered; the accessor throws until hydrate", () => {
    assert.match(
      BIND(),
      /e2ee\?\.setProtectedOutboxKeys\?\.\(\(\) => this\.outboxKeys\(\)\);/,
    );
    assert.equal(count(SRC, "setProtectedOutboxKeys?.("), 1, "one site");
    const keys = member(
      SRC,
      /\n {2}private outboxKeys\(\): ReadonlySet<string>/,
    );
    assert.match(
      keys,
      /^\{\s*if \(!this\.outboxLoaded\) \{\s*throw new Error\(/,
    );
    assert.match(
      member(SRC, /\n {2}hydrate\(\): void/),
      /this\.outboxLoaded = true;/,
    );
    assert.match(SRC, /private outboxLoaded = false;/);
  });

  it("S11: failed protected entries show their notice kind; retry reuses the entry's key", () => {
    const text = (rel: string) =>
      stripComments(
        readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
      );
    const view = text("../../app/interface/channels/text/DraftMessage.tsx");
    assert.match(
      view,
      /import \{ noticeCopy \} from "@revolt\/client\/protectedCopy";/,
    );
    assert.match(
      view,
      /<Show\s+when=\{props\.draft\.status === "failed" && props\.draft\.protectedNotice\}\s*>\s*\{\(kind\) => \(\s*<SendError>\s*\{noticeCopy\(kind\(\), props\.draft\.protectedNoticeMax \?\? null\)\}/,
    );
    const menu = text("../../app/menus/DraftMessageContextMenu.tsx");
    assert.match(
      menu,
      /state\.draft\.retrySend\(\s*client\(\),\s*channel,\s*props\.draft\.idempotencyKey,/,
    );
    const failed = member(SRC, /\n {2}private markProtectedFailed\(/);
    assert.match(
      failed,
      /error: undefined,\s*protectedNotice: notice,\s*protectedNoticeMax: max,/,
    );
  });

  it("S8: clean() keeps a text entry's key across a reload", () => {
    const clean = member(SRC, /\n {2}clean\(input: Partial<TypeDraft>\)/);
    assert.match(clean, /idempotencyKey: message\.idempotencyKey,/);
    assert.match(clean, /content: message\.content,/);
  });
});

// ---- B: behaviour ----------------------------------------------------------

const GUARD_URL = new URL("./protectedDraftGuard.ts", import.meta.url).href;

const STUBS: Record<string, string> = {
  "solid-js": `export const Accessor = undefined;
    export const Setter = undefined;
    export const batch = (fn) => fn();
    export function createSignal(value) {
      return [() => value, (next) => (value = next)];
    }`,
  ".": `export class AbstractStore {
    constructor(state, key) { this.state = state; this.key = key; }
    get() { return this.state.get(this.key); }
    set(...args) { this.state.set(this.key, ...args); }
  }`,
  "..": `export class State {}`,
  "@revolt/common": `
    export const CONFIGURATION = {
      CHUNKED_UPLOAD_THRESHOLD: 90_000_000,
      MAX_ATTACHMENTS: 2,
      MAX_REPLIES: 5,
    };
    let n = 0;
    export const insecureUniqueId = () => "file-" + ++n;`,
  "stoat.js": `export class Message {} export const API = {};
    export class Channel {} export class Client {}
    export class ProtectedFieldRefusedClient extends Error {
      constructor(field) {
        super("ProtectedFieldRefusedClient: " + field);
        this.name = "ProtectedFieldRefusedClient";
        this.field = field;
      }
    }`,
  ulid: `let n = 0; export const ulid = () => "key-" + ++n;`,
  "./Layout": `export const LAYOUT_SECTIONS = {};`,
  "./chunkedUpload": `export async function uploadFileChunked() {
    globalThis.__protectedDraftUploads = (globalThis.__protectedDraftUploads ?? 0) + 1;
    throw new Error("chunked path not under test");
  }`,
  "./draftSendError.ts": `export const describeSendError = (e) =>
    "described:" + (e && e.message);`,
  "../../client/protectedSendError.ts": `export * from ${JSON.stringify(
    new URL("../../client/protectedSendError.ts", import.meta.url).href,
  )};`,
  "../../client/protectedShield.ts": `export * from ${JSON.stringify(
    new URL("../../client/protectedShield.ts", import.meta.url).href,
  )};`,
  "./protectedDraftGuard.ts": `export * from ${JSON.stringify(GUARD_URL)};`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS && context.parentURL === UNDER_TEST) {
      return { url: `protected-draft-test:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("protected-draft-test:")) {
      return {
        format: "module",
        shortCircuit: true,
        source: STUBS[url.slice("protected-draft-test:".length)],
      };
    }
    return nextLoad(url, context);
  },
});

/** Every XMLHttpRequest the module under test constructs */
let xhrs = 0;
(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = class {
  constructor() {
    xhrs++;
    throw new Error("no upload may start");
  }
};
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "node" },
  configurable: true,
});
(globalThis as unknown as { Image: unknown }).Image = class {};
URL.createObjectURL = () => "blob:test";
URL.revokeObjectURL = () => {};

const { Draft } = await import(UNDER_TEST);

type Outbox = Record<string, Record<string, unknown>[]>;
type Data = { drafts: Record<string, Record<string, unknown>>; outbox: Outbox };

/** A real Draft over a fake path-setting state */
function makeDraft(hydrated = true) {
  const data: Data = { drafts: {}, outbox: {} };
  const state = {
    get: () => data,
    set: (_key: string, ...path: unknown[]) => {
      const value = path.pop();
      let target = data as unknown as Record<string, unknown>;
      for (const segment of path.slice(0, -1)) {
        target = (target[segment as string] ??= {}) as Record<string, unknown>;
      }
      target[path[path.length - 1] as string] = value;
    },
    layout: { getSectionState: () => false },
  };
  const draft = new Draft(state as never);
  if (hydrated) draft.hydrate();
  return { draft, data };
}

/** A fake client: `protectedIds` decides `isProtectedChannel` */
function makeClient(protectedIds: string[]) {
  const registered: (() => ReadonlySet<string>)[] = [];
  let prepared = 0;
  const client = {
    isProtectedChannel: (id: string) => protectedIds.includes(id),
    configuration: { features: { autumn: { url: "https://autumn.test" } } },
    authenticationHeader: ["X-Session-Token", "test"],
    e2ee: {
      setProtectedOutboxKeys: (accessor: () => ReadonlySet<string>) => {
        registered.push(accessor);
      },
      prepareDraftAttachments: async () => {
        prepared++;
        return null;
      },
    },
  };
  return { client, registered, prepared: () => prepared };
}

type Sent = { data: Record<string, unknown>; key: string; outbox: unknown };

/** A channel whose send records its arguments and the outbox at that moment */
function makeChannel(
  id: string,
  data: Data,
  outcome: () => Promise<unknown> = async () => ({}),
) {
  const sent: Sent[] = [];
  return {
    sent,
    channel: {
      id,
      sendMessage: (body: Record<string, unknown>, key: string) => {
        sent.push({
          data: body,
          key,
          outbox: structuredClone(data.outbox[id] ?? []),
        });
        return outcome();
      },
    },
  };
}

/** An Error with the given name (the SDK's refusal classes) */
function named(name: string) {
  return Object.assign(new Error(name), { name });
}

/** The notice the real mapping gives a send failure */
function noticeOf(failure: unknown) {
  const ui = protectedNoticeForError(failure, { op: "send" });
  assert.equal(ui.kind, "notice");
  return ui.kind === "notice" ? ui.notice : null;
}

const P = "protected-1";
const PLAIN = "plain-1";

afterEach(() => setProtectedChannelResolver(null));

describe("protected Draft behaviour", () => {
  it("B1 (C-C5a): files in a protected draft are refused with nothing popped, uploaded or prepared", async () => {
    const { draft, data } = makeDraft();
    const { client, prepared } = makeClient([P]);
    const { channel, sent } = makeChannel(P, data);
    data.drafts[P] = { content: "hello", files: ["file-x"] };
    const before = { xhrs, uploads: uploads() };

    await assert.rejects(
      draft.sendDraft(client as never, channel as never),
      (error: Error & { field?: string }) =>
        error.name === "ProtectedFieldRefusedClient" &&
        error.field === "attachments",
    );
    assert.deepEqual(data.drafts[P], { content: "hello", files: ["file-x"] });
    assert.equal(sent.length, 0);
    assert.equal(prepared(), 0, "prepareDraftAttachments never ran");
    assert.equal(xhrs, before.xhrs, "no Autumn upload");
    assert.equal(uploads(), before.uploads, "no chunked upload");
    assert.deepEqual(data.outbox[P] ?? [], []);
  });

  it("B2: protected text creates the outbox entry before the pop and keeps one key", async () => {
    const { draft, data } = makeDraft();
    const { client } = makeClient([P]);
    const { channel, sent } = makeChannel(P, data);
    data.drafts[P] = { content: "hello", replies: [] };

    await draft.sendDraft(client as never, channel as never);

    assert.equal(sent.length, 1);
    const [{ data: body, key, outbox }] = sent;
    assert.deepEqual(Object.keys(body).sort(), ["content", "replies"]);
    assert.equal(body.content, "hello");
    assert.deepEqual(outbox, [
      { idempotencyKey: key, content: "hello", replies: [], status: "sending" },
    ]);
    assert.equal(data.drafts[P].content, "", "popped");
    assert.deepEqual(data.outbox[P], [], "delivered entry removed");
  });

  it("B3 (C-C5d, C-C5f): known undelivered: text back in the composer, entry deleted, rethrown", async () => {
    for (const make of [
      () =>
        new ProtectedSendError({
          source: "server",
          status: 403,
          type: "NotSeated",
          body: null,
        }),
      () =>
        new ProtectedSendError({
          source: "native",
          error: { type: "not_seated" },
        }),
      () =>
        new ProtectedSendError({ source: "client", reason: "flag_stripped" }),
      () => new ProtectedSendError(named("ProtectedChannelUnavailable")),
      () => named("ProtectedChannelUnavailable"), // the SDK, web shell
    ]) {
      const { draft, data } = makeDraft();
      const { client } = makeClient([P]);
      const error = make();
      const { channel } = makeChannel(P, data, () => Promise.reject(error));
      const replies = [{ id: "m1", mention: false }];
      data.drafts[P] = { content: "secret", replies };

      await assert.rejects(
        draft.sendDraft(client as never, channel as never),
        (thrown: unknown) => thrown === error,
      );
      assert.equal(data.drafts[P].content, "secret", "text restored");
      assert.deepEqual(data.drafts[P].replies, replies, "replies restored");
      assert.deepEqual(data.outbox[P], [], "exactly one copy: no entry");
    }
  });

  it("B10 (C-C5e): unknown outcome: failed entry under the same key, composer NOT refilled", async () => {
    for (const [make, notice] of [
      [() => new ProtectedSendError({ source: "transport" }), "network_error"],
      [
        () =>
          new ProtectedSendError({ source: "client", reason: "maybe_unsent" }),
        "maybe_unsent",
      ],
      [
        () =>
          new ProtectedSendError({
            source: "client",
            reason: "unexpected_error",
          }),
        "maybe_unsent",
      ],
      // thrown after delivery (the row was stored, the SDK cache failed)
      [() => new ProtectedSendError(new TypeError("x")), "maybe_unsent"],
      [() => ({ some: "record" }), "maybe_unsent"],
    ] as const) {
      const { draft, data } = makeDraft();
      const { client } = makeClient([P]);
      const error = make();
      const { channel, sent } = makeChannel(P, data, () =>
        Promise.reject(error),
      );
      data.drafts[P] = { content: "maybe sent", replies: [] };

      await assert.rejects(
        draft.sendDraft(client as never, channel as never),
        (thrown: unknown) => thrown === error,
      );
      assert.equal(data.drafts[P].content, "", "not put back in the composer");
      assert.equal(data.outbox[P].length, 1);
      const [entry] = data.outbox[P];
      assert.equal(entry.idempotencyKey, sent[0].key, "same key kept");
      assert.equal(entry.content, "maybe sent");
      assert.equal(entry.status, "failed");
      assert.equal(entry.error, undefined, "no error text stored");
      assert.equal(entry.protectedNotice, notice);
    }
  });

  it("B4: an undelivered send never overwrites text typed meanwhile; the entry keeps it", async () => {
    const { draft, data } = makeDraft();
    const { client } = makeClient([P]);
    const failure = { source: "native", error: { type: "not_seated" } };
    const { channel } = makeChannel(P, data, async () => {
      data.drafts[P] = { content: "typed meanwhile" };
      throw new ProtectedSendError(failure);
    });
    data.drafts[P] = { content: "first" };

    await assert.rejects(draft.sendDraft(client as never, channel as never));
    assert.equal(data.drafts[P].content, "typed meanwhile");
    const [entry] = data.outbox[P];
    assert.equal(entry.content, "first", "text kept in the outbox");
    assert.equal(entry.status, "failed");
    assert.equal(entry.protectedNotice, noticeOf(failure));
  });

  it("B5 (C-C5c): a protected retry sends under the same key; its failure stays on the entry", async () => {
    const { draft, data } = makeDraft();
    const { client } = makeClient([P]);
    let next: unknown = new ProtectedSendError({ source: "transport" });
    const { channel, sent } = makeChannel(P, data, async () => {
      if (next) throw next;
      return {};
    });
    data.drafts[P] = { content: "again" };

    await assert.rejects(draft.sendDraft(client as never, channel as never));
    const key = sent[0].key;
    assert.equal(data.drafts[P].content, "", "unknown: not restored");

    // A retried key is never "known undelivered": an earlier attempt under
    // it may still be pending in the bridge, so even a refusal keeps it
    const refusal = {
      source: "server",
      status: 403,
      type: "NotSeated",
      body: null,
    };
    next = new ProtectedSendError(refusal);
    const errors: unknown[] = [];
    draft.retrySend(client as never, channel as never, key, (e: unknown) =>
      errors.push(e),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent[1].key, key, "same key on retry");
    assert.equal(errors.length, 1, "retry failure surfaced");
    assert.equal(data.outbox[P].length, 1);
    assert.equal(data.outbox[P][0].idempotencyKey, key);
    assert.equal(data.outbox[P][0].status, "failed");
    assert.equal(data.outbox[P][0].protectedNotice, noticeOf(refusal));
    assert.equal(data.drafts[P].content, "", "retry never refills composer");

    next = null;
    draft.retrySend(client as never, channel as never, key);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent[2].key, key);
    assert.deepEqual(data.outbox[P], [], "delivered on the same key");
  });

  it("B6: non-protected sends keep today's path (fresh key, upload path, swallow)", async () => {
    const { draft, data } = makeDraft();
    const { client, prepared } = makeClient([P]);
    const failing = makeChannel(PLAIN, data, () =>
      Promise.reject(new Error("boom")),
    );
    data.drafts[PLAIN] = { content: "plain" };

    await draft.sendDraft(client as never, failing.channel as never);
    assert.equal(prepared(), 1, "the shared E2EE gate still runs");
    assert.equal(data.drafts[PLAIN].content, "", "popped, not restored");
    const [entry] = data.outbox[PLAIN];
    assert.equal(entry.status, "failed");
    assert.equal(entry.error, "described:boom");
    assert.notEqual(entry.idempotencyKey, undefined);
  });

  it("B7: the resolver is installed by the first send and answers from the client", async () => {
    const { draft, data } = makeDraft();
    const { client } = makeClient([P]);
    assert.equal(isProtectedForDraft(P), false, "nothing installed yet");
    const { channel } = makeChannel(PLAIN, data);
    data.drafts[PLAIN] = { content: "hi" };
    await draft.sendDraft(client as never, channel as never);
    assert.equal(isProtectedForDraft(P), true);
    assert.equal(isProtectedForDraft(PLAIN), false);
  });

  it("B8 (C-C5b): addFile admits nothing to a protected channel", async () => {
    const { draft, data } = makeDraft();
    const { client } = makeClient([P]);
    draft.bindClient(client as never);

    await draft.addFile(P, new File(["x"], "x.txt"));
    assert.equal(data.drafts[P]?.files, undefined);

    await draft.addFile(PLAIN, new File(["y"], "y.txt"));
    assert.equal(
      (data.drafts[PLAIN].files as string[]).length,
      1,
      "plain still attaches",
    );
  });

  it("B9: outbox keys are registered once per client and throw until hydrate", () => {
    const { draft, data } = makeDraft(false);
    const first = makeClient([P]);
    draft.bindClient(first.client as never);
    draft.bindClient(first.client as never);
    assert.equal(first.registered.length, 1, "once per client");

    const [accessor] = first.registered;
    assert.throws(() => accessor(), /outbox not loaded/);

    data.outbox[P] = [{ idempotencyKey: "k1", content: "a", status: "unsent" }];
    data.outbox[PLAIN] = [
      { idempotencyKey: "k2", content: "b", status: "failed" },
    ];
    draft.hydrate();
    assert.deepEqual([...accessor()].sort(), ["k1", "k2"]);

    const second = makeClient([]);
    draft.bindClient(second.client as never);
    assert.equal(second.registered.length, 1, "a new client re-registers");
    assert.equal(isProtectedForDraft(P), false, "resolver follows the client");
  });
});

/** Chunked uploads attempted so far (the stand-in counts them) */
function uploads(): number {
  return (
    (globalThis as unknown as { __protectedDraftUploads?: number })
      .__protectedDraftUploads ?? 0
  );
}
