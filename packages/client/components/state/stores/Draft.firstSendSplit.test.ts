/**
 * Run with:
 *
 *     node --conditions=browser --test components/state/stores/Draft.firstSendSplit.test.ts
 *
 * Encrypted-only chats, the send path of `./Draft.ts`:
 * - the first message of an encryptable conversation that has files goes
 *   out as two messages, the text first and the files after it;
 * - a plain attachment upload asks `client.plainWriteGuard` before any byte
 *   leaves, and an encrypted one never asks;
 * - an entry refused for not being encrypted may be retried, and the retry
 *   runs every check again; files waiting for a text message are not
 *   retried;
 * - a peer that may no longer be Encrypted-only reaches the composer;
 * - files that follow plain text tell preparation so (`textWentPlain`).
 *
 * `./Draft.ts` is loaded through the `module.registerHooks` substitution
 * `./draftUpload.test.ts` documents. Every import of the module under test
 * is substituted (the pure siblings by re-exporting the real modules), so
 * the copy under test may live anywhere.
 *
 * Known-bad control: set `DRAFT_SPLIT_UNDER_TEST` to an absolute path of
 * another copy of `Draft.ts` (the one at 761b9231, or a mutant of this one)
 * and the specs it breaks fail.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { canRetrySendAsIs } from "./draftSendError.ts";

const UNDER_TEST = process.env.DRAFT_SPLIT_UNDER_TEST
  ? pathToFileURL(process.env.DRAFT_SPLIT_UNDER_TEST).href
  : new URL("./Draft.ts", import.meta.url).href;

const real = (rel: string) =>
  `export * from ${JSON.stringify(new URL(rel, import.meta.url).href)};`;

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
      CHUNKED_UPLOAD_THRESHOLD: 1000,
      MAX_ATTACHMENTS: 5,
      MAX_REPLIES: 5,
    };
    let n = 0;
    export const insecureUniqueId = () => "file-" + ++n;`,
  "stoat.js": `export class Message {} export const API = {};
    export class Channel {} export class Client {}
    export class EncryptedOnlyBlockedError extends Error {
      constructor(reason) {
        super(reason);
        this.name = "EncryptedOnlyBlockedError";
        this.reason = reason;
      }
    }`,
  ulid: `let n = 0; export const ulid = () => "key-" + ++n;`,
  "./Layout": `export const LAYOUT_SECTIONS = {};`,
  "./chunkedUpload": `export async function uploadFileChunked() {
    globalThis.__m3SplitEvents.push("chunked");
    return "chunked-id";
  }`,
  "./draftSendError.ts": real("./draftSendError.ts"),
  "./protectedDraftGuard.ts": real("./protectedDraftGuard.ts"),
  "../../client/protectedSendError.ts": real(
    "../../client/protectedSendError.ts",
  ),
  "../../client/protectedShield.ts": real("../../client/protectedShield.ts"),
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS && context.parentURL === UNDER_TEST) {
      return { url: `draft-split-test:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("draft-split-test:")) {
      return {
        format: "module",
        shortCircuit: true,
        source: STUBS[url.slice("draft-split-test:".length)],
      };
    }
    return nextLoad(url, context);
  },
});

/** Everything the module under test did, in order */
const events: string[] = [];
/** The options of each attachment preparation, in order */
const prepareOptions: unknown[] = [];
(globalThis as unknown as { __m3SplitEvents: string[] }).__m3SplitEvents =
  events;

/** An XMLHttpRequest that always answers 200 with a fresh attachment id */
let autumnIds = 0;
class FakeXHR extends EventTarget {
  upload = new EventTarget();
  readyState = 0;
  status = 0;
  response: unknown = null;
  timeout = 0;
  responseType = "";
  open() {}
  setRequestHeader() {}
  send() {
    events.push("xhr");
    queueMicrotask(() => {
      this.readyState = 4;
      this.status = 200;
      this.response = { id: `autumn-${++autumnIds}` };
      this.dispatchEvent(new Event("loadend"));
    });
  }
}
(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR;
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "node" },
  configurable: true,
});

const {
  Draft,
  FIRST_FILE_NEEDS_TEXT_SEND_ERROR,
  FirstFileNeedsTextError,
  isFirstFileNeedsText,
} = await import(UNDER_TEST);

type Row = Record<string, unknown>;
type Data = { drafts: Record<string, Row>; outbox: Record<string, Row[]> };

/** A real Draft over a fake path-setting state */
function makeDraft() {
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
  };
  const draft = new Draft(state as never);
  draft.hydrate();
  return { draft, data };
}

const CHANNEL = "dm-1";
const REPLIES = [{ id: "m-0", mention: false }];

type Sent = { data: Row; key: string };

/**
 * A direct message channel whose sends are recorded
 * @param answer What each send does, by position (default: accepted)
 */
function makeChannel(
  answer: (n: number) => Promise<unknown> | unknown = () => 0,
) {
  const sent: Sent[] = [];
  const channel = {
    id: CHANNEL,
    type: "DirectMessage",
    sendMessage: async (data: Row, key: string) => {
      const n = sent.length;
      sent.push({ data: structuredClone(data), key });
      events.push(`send:${n + 1}`);
      await answer(n);
      return { id: `sent-${n + 1}` };
    },
  };
  return { channel, sent };
}

type AdapterOptions = {
  /** Answer of the split query (default true) */
  split?: boolean | (() => boolean);
  /** What attachment preparation gives back, by call (default: ids) */
  prepare?: (call: number, files: number) => string[] | null;
  /** Ids of sent messages the adapter sent encrypted (default: all) */
  encrypted?: (id: string) => boolean;
};

/** A client with an E2EE adapter */
function makeClient(
  options: AdapterOptions = {},
  guard?: (kind: string) => void,
) {
  let prepares = 0;
  return {
    isProtectedChannel: () => false,
    configuration: { features: { autumn: { url: "https://autumn.test" } } },
    authenticationHeader: ["X-Session-Token", "test"],
    plainWriteGuard: guard
      ? (_channel: unknown, kind: string) => {
          events.push(`guard:${kind}`);
          guard(kind);
        }
      : undefined,
    e2ee: {
      willSplitFirstSend: (_channel: unknown, draft: Row) => {
        events.push(
          `willSplit:${draft.content ? "text" : "no-text"}:${
            (draft.files as unknown[] | undefined)?.length ?? 0
          }`,
        );
        const split = options.split ?? true;
        return typeof split === "function" ? split() : split;
      },
      prepareDraftAttachments: async (
        _channel: unknown,
        items: unknown[],
        given?: unknown,
      ) => {
        events.push(`prepare:${items.length}`);
        prepareOptions.push(given);
        const call = prepares++;
        return options.prepare
          ? options.prepare(call, items.length)
          : items.map((_, i) => `e2ee-${call}-${i}`);
      },
      isEncryptedMessage: (id: string) =>
        options.encrypted ? options.encrypted(id) : true,
    },
  };
}

/** A client with no adapter (the website, or a device without encryption) */
function makePlainClient(guard?: (kind: string) => void) {
  const { e2ee: _e2ee, ...rest } = makeClient({}, guard);
  return rest;
}

const smallFile = (name = "notes.txt") =>
  new File(["hello"], name, { type: "text/plain" });
const bigFile = () =>
  new File([new Uint8Array(2000)], "big.bin", { type: "text/plain" });

/** A draft holding text (optional), a reply and files */
async function compose(
  draft: InstanceType<typeof Draft>,
  content: string | undefined,
  files: File[] = [smallFile()],
) {
  for (const file of files) await draft.addFile(CHANNEL, file);
  draft.setDraft(CHANNEL, {
    ...draft.getDraft(CHANNEL),
    content,
    replies: REPLIES,
  });
  return draft.getDraft(CHANNEL).files as string[];
}

const blocked = (reason: string) =>
  Object.assign(new Error(reason), {
    name: "EncryptedOnlyBlockedError",
    reason,
  });

const uploads = () =>
  events.filter((event) => event === "xhr" || event === "chunked");

beforeEach(() => {
  events.length = 0;
  prepareOptions.length = 0;
});

describe("first message with files is split", () => {
  it("decides the split before any preparation or upload, and sends the text alone first", async () => {
    const { draft } = makeDraft();
    const fileIds = await compose(draft, "see attached");
    const { channel, sent } = makeChannel();

    await draft.sendDraft(makeClient() as never, channel as never);

    assert.deepEqual(events, [
      "willSplit:text:1",
      "send:1",
      "prepare:1",
      "send:2",
    ]);
    assert.deepEqual(sent[0].data, {
      content: "see attached",
      replies: REPLIES,
    });
    assert.equal(sent[1].data.content, undefined, "the text is sent once");
    assert.equal(sent[1].data.replies, undefined, "the reply rides the text");
    assert.deepEqual(sent[1].data.e2eeAttachments, ["e2ee-0-0"]);
    assert.equal(sent[1].data.attachments, undefined);
    assert.notEqual(sent[0].key, sent[1].key, "each message has its own key");
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
    assert.equal(draft.getFile(fileIds[0]), undefined, "files are released");
  });

  it("shows two rows while the text is in flight, then a files-only row", async () => {
    const { draft } = makeDraft();
    const fileIds = await compose(draft, "see attached");
    let acceptText!: () => void;
    let acceptFiles!: () => void;
    const { channel, sent } = makeChannel(
      (n) =>
        new Promise<void>((resolve) => {
          if (n === 0) acceptText = resolve;
          else acceptFiles = resolve;
        }),
    );

    const sending = draft.sendDraft(makeClient() as never, channel as never);
    await new Promise((resolve) => setImmediate(resolve));

    const [textRow, filesRow, ...rest] = draft.getPendingMessages(CHANNEL);
    assert.equal(rest.length, 0);
    assert.equal(textRow.content, "see attached");
    assert.deepEqual(textRow.replies, REPLIES);
    assert.equal(textRow.files, undefined);
    assert.equal(textRow.idempotencyKey, sent[0].key);
    assert.equal(filesRow.content, undefined);
    assert.deepEqual(filesRow.files, fileIds);
    assert.notEqual(filesRow.idempotencyKey, textRow.idempotencyKey);
    assert.deepEqual(uploads(), [], "nothing uploads before the text is in");
    assert.ok(!events.some((event) => event.startsWith("prepare")));

    acceptText();
    await new Promise((resolve) => setImmediate(resolve));

    const [onlyRow, ...others] = draft.getPendingMessages(CHANNEL);
    assert.equal(others.length, 0);
    assert.equal(onlyRow.content, undefined, "the text is out of the outbox");
    assert.deepEqual(onlyRow.files, fileIds);
    assert.equal(onlyRow.textWent, "encrypted");

    acceptFiles();
    await sending;
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
  });

  it("a retry after the text was accepted never sends the text again", async () => {
    const { draft } = makeDraft();
    const fileIds = await compose(draft, "see attached");
    const { channel, sent } = makeChannel();
    const client = makeClient({
      // The first preparation after the text fails; later ones work
      prepare: (call, files) => {
        if (call === 0) throw new Error("blob upload failed");
        return Array.from({ length: files }, (_, i) => `e2ee-${call}-${i}`);
      },
      // After the text went, the conversation is established
      split: () => sent.length === 0,
    });

    await assert.rejects(
      draft.sendDraft(client as never, channel as never),
      /blob upload failed/,
    );

    assert.equal(sent.length, 1, "only the text went");
    assert.deepEqual(uploads(), [], "a throw never falls to a plain upload");
    const [failed, ...rest] = draft.getPendingMessages(CHANNEL);
    assert.equal(rest.length, 0);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "blob upload failed");
    assert.equal(failed.content, undefined, "persisted as files only");
    assert.deepEqual(failed.files, fileIds);

    // What a reload keeps of this entry: nothing, so no text to resend
    assert.deepEqual(draft.clean(draft.get()).outbox[CHANNEL], []);

    let retryError: unknown;
    draft.retrySend(
      client as never,
      channel as never,
      failed.idempotencyKey,
      (error: unknown) => (retryError = error),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(retryError, undefined);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].data.content, undefined);
    assert.deepEqual(sent[1].data.e2eeAttachments, ["e2ee-1-0"]);
    assert.equal(
      sent.filter((message) => message.data.content).length,
      1,
      "the text went exactly once",
    );
    assert.ok(
      !events.some((event) => event.startsWith("willSplit:no-text")),
      "the files half is not asked for text",
    );
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
  });

  it("a plain answer from preparation after encrypted text stops the send", async () => {
    const { draft } = makeDraft();
    const fileIds = await compose(draft, "see attached");
    const { channel, sent } = makeChannel();
    let guardCalls = 0;
    const client = makeClient({ prepare: () => null }, () => guardCalls++);

    await assert.rejects(draft.sendDraft(client as never, channel as never));

    assert.equal(sent.length, 1, "the files message is not sent");
    assert.deepEqual(uploads(), [], "no plain upload");
    assert.equal(guardCalls, 0, "it stops before the plain path is reached");
    const [failed] = draft.getPendingMessages(CHANNEL);
    assert.equal(failed.status, "failed");
    assert.equal(failed.content, undefined);
    assert.deepEqual(failed.files, fileIds);

    // And again on a retry of the files half
    draft.retrySend(client as never, channel as never, failed.idempotencyKey);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.deepEqual(uploads(), []);
    assert.equal(draft.getPendingMessages(CHANNEL)[0].status, "failed");
  });

  it("text that went out plain (peer unreachable) lets the files go as before, guard first", async () => {
    const { draft } = makeDraft();
    await compose(draft, "see attached");
    const { channel, sent } = makeChannel();
    const client = makeClient(
      { prepare: () => null, encrypted: () => false },
      () => {},
    );

    await draft.sendDraft(client as never, channel as never);

    assert.deepEqual(events, [
      "willSplit:text:1",
      "send:1",
      "prepare:1",
      "guard:upload",
      "xhr",
      "send:2",
    ]);
    assert.deepEqual(sent[1].data.attachments, ["autumn-" + autumnIds]);
    assert.equal(sent[1].data.content, undefined);
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
    assert.deepEqual(
      prepareOptions,
      [{ textWentPlain: true }],
      "preparation is told the text went plain",
    );
  });

  it("files after encrypted text, and an ordinary send, do not say the text went plain", async () => {
    const { draft } = makeDraft();
    await compose(draft, "see attached");
    const { channel } = makeChannel();
    await draft.sendDraft(makeClient() as never, channel as never);
    assert.deepEqual(prepareOptions, [{ textWentPlain: false }]);

    prepareOptions.length = 0;
    await compose(draft, "again");
    await draft.sendDraft(
      makeClient({ split: false }) as never,
      channel as never,
    );
    assert.deepEqual(prepareOptions, [{ textWentPlain: false }]);
  });

  it("a refused text send uploads nothing; a retry runs every check again and is refused again", async () => {
    const { draft } = makeDraft();
    const fileIds = await compose(draft, "see attached");
    const { channel, sent } = makeChannel(() => {
      throw blocked("sender");
    });
    const client = makeClient();

    await draft.sendDraft(client as never, channel as never);

    assert.deepEqual(events, ["willSplit:text:1", "send:1"]);
    const [failed, ...rest] = draft.getPendingMessages(CHANNEL);
    assert.equal(rest.length, 0, "back to one row");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "EncryptionRequired:sender");
    assert.equal(failed.content, "see attached");
    assert.deepEqual(failed.files, fileIds);

    events.length = 0;
    let retryError: unknown = "not called";
    draft.retrySend(
      client as never,
      channel as never,
      failed.idempotencyKey,
      (error: unknown) => (retryError = error),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      events,
      ["willSplit:text:1", "send:2"],
      "the retry decides again and its text is refused again",
    );
    assert.deepEqual(uploads(), [], "still nothing uploaded");
    assert.equal(sent.length, 2, "the text was tried again, nothing else");
    assert.equal(retryError, "not called", "a refusal row, not a throw");
    const [again, ...others] = draft.getPendingMessages(CHANNEL);
    assert.equal(others.length, 0);
    assert.equal(again.status, "failed");
    assert.equal(again.error, "EncryptionRequired:sender");
    assert.equal(again.content, "see attached");
  });

  it("a peer that may no longer be Encrypted-only reaches the composer; after a confirm the row is retried", async () => {
    const { draft } = makeDraft();
    await compose(draft, "hello", []);
    let confirmed = false;
    const { channel, sent } = makeChannel(() => {
      if (!confirmed) throw blocked("peer-changed");
    });
    const client = makeClient();

    await assert.rejects(draft.sendDraft(client as never, channel as never), {
      name: "EncryptedOnlyBlockedError",
      reason: "peer-changed",
    });
    const [failed] = draft.getPendingMessages(CHANNEL);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "EncryptionRequired:peer-changed");

    confirmed = true;
    let retryError: unknown = "not called";
    draft.retrySend(
      client as never,
      channel as never,
      failed.idempotencyKey,
      (error: unknown) => (retryError = error),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(retryError, "not called");
    assert.equal(sent.length, 2);
    assert.equal(sent[1].data.content, "hello");
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
  });

  it("the peer-changed refusal of a split text reaches the composer too", async () => {
    const { draft } = makeDraft();
    await compose(draft, "see attached");
    const { channel } = makeChannel(() => {
      throw blocked("peer-changed");
    });

    await assert.rejects(
      draft.sendDraft(makeClient() as never, channel as never),
      { reason: "peer-changed" },
    );
    assert.deepEqual(uploads(), []);
    const [failed, ...rest] = draft.getPendingMessages(CHANNEL);
    assert.equal(rest.length, 0);
    assert.equal(failed.error, "EncryptionRequired:peer-changed");
  });

  it("a fail-closed E2EE error on the text reaches the caller", async () => {
    const { draft } = makeDraft();
    await compose(draft, "see attached");
    const { channel } = makeChannel(() => {
      throw Object.assign(new Error("No usable device"), {
        name: "E2EESendError",
      });
    });

    await assert.rejects(
      draft.sendDraft(makeClient() as never, channel as never),
      { name: "E2EESendError" },
    );
    assert.deepEqual(uploads(), []);
    const [failed, ...rest] = draft.getPendingMessages(CHANNEL);
    assert.equal(rest.length, 0);
    assert.equal(failed.error, "No usable device");
    assert.equal(failed.content, "see attached");
  });

  it("a first send with files and no text is refused with the marker", async () => {
    const { draft } = makeDraft();
    const fileIds = await compose(draft, undefined);
    const { channel, sent } = makeChannel();

    let thrown: unknown;
    await draft
      .sendDraft(makeClient() as never, channel as never)
      .catch((error: unknown) => (thrown = error));

    assert.ok(thrown instanceof FirstFileNeedsTextError);
    assert.equal(isFirstFileNeedsText(thrown), true);
    assert.equal((thrown as Error).message, FIRST_FILE_NEEDS_TEXT_SEND_ERROR);
    assert.equal(FIRST_FILE_NEEDS_TEXT_SEND_ERROR, "FirstFileNeedsText");
    assert.deepEqual(events, ["willSplit:no-text:1"]);
    assert.equal(sent.length, 0);
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
    const back = draft.getDraft(CHANNEL);
    assert.deepEqual(back.files, fileIds, "the files are back in the composer");
    assert.deepEqual(back.replies, REPLIES);
    assert.ok(draft.getFile(fileIds[0]), "and still cached");
  });

  it("a retried files-only entry that is now a first send fails with the marker", async () => {
    const { draft, data } = makeDraft();
    const fileIds = await compose(draft, undefined);
    draft.popDraft(CHANNEL);
    data.outbox[CHANNEL] = [
      { idempotencyKey: "old", status: "failed", files: fileIds },
    ];
    const { channel, sent } = makeChannel();

    let retryError: unknown;
    draft.retrySend(
      makeClient() as never,
      channel as never,
      "old",
      (error: unknown) => (retryError = error),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(isFirstFileNeedsText(retryError), true);
    const [failed] = draft.getPendingMessages(CHANNEL);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, FIRST_FILE_NEEDS_TEXT_SEND_ERROR);
    assert.equal(isFirstFileNeedsText(failed.error), true);
    assert.equal(isFirstFileNeedsText("Unknown error"), false);
    assert.equal(sent.length, 0);
    assert.deepEqual(uploads(), []);
  });

  it("an entry with the marker is not retried: nothing is asked or sent until text is added", async () => {
    const { draft, data } = makeDraft();
    const fileIds = await compose(draft, undefined);
    draft.popDraft(CHANNEL);
    data.outbox[CHANNEL] = [
      {
        idempotencyKey: "old",
        status: "failed",
        files: fileIds,
        error: FIRST_FILE_NEEDS_TEXT_SEND_ERROR,
      },
    ];
    const { channel, sent } = makeChannel();

    let retryError: unknown;
    draft.retrySend(
      makeClient() as never,
      channel as never,
      "old",
      (error: unknown) => (retryError = error),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(isFirstFileNeedsText(retryError), true);
    assert.deepEqual(events, [], "nothing asked");
    assert.equal(sent.length, 0);
    const [still] = draft.getPendingMessages(CHANNEL);
    assert.equal(still.status, "failed", "kept, so it can be removed");
    assert.equal(still.error, FIRST_FILE_NEEDS_TEXT_SEND_ERROR);
    assert.equal(canRetrySendAsIs(FIRST_FILE_NEEDS_TEXT_SEND_ERROR), false);
  });

  it("preparation's first-file refusal with no text is the same marker, in one form", async () => {
    const { draft, data } = makeDraft();
    const fileIds = await compose(draft, undefined);
    const { channel, sent } = makeChannel();
    const client = makeClient({
      // The query answered before the adapter's state had loaded
      split: false,
      prepare: () => {
        throw Object.assign(new Error("Add a message"), {
          name: "E2EESendError",
          kind: "first_file",
        });
      },
    });

    let thrown: unknown;
    await draft
      .sendDraft(client as never, channel as never)
      .catch((error: unknown) => (thrown = error));

    assert.ok(thrown instanceof FirstFileNeedsTextError, String(thrown));
    assert.equal(sent.length, 0);
    assert.deepEqual(uploads(), []);
    assert.deepEqual(draft.getDraft(CHANNEL).files, fileIds, "files back");

    // The same on a retried entry: the row carries the marker
    draft.popDraft(CHANNEL);
    data.outbox[CHANNEL] = [
      { idempotencyKey: "old", status: "failed", files: fileIds },
    ];
    let retryError: unknown;
    draft.retrySend(
      client as never,
      channel as never,
      "old",
      (error: unknown) => (retryError = error),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(isFirstFileNeedsText(retryError), true);
    assert.equal(
      draft.getPendingMessages(CHANNEL)[0].error,
      FIRST_FILE_NEEDS_TEXT_SEND_ERROR,
    );
  });

  it("splits after all when preparation says no text was tried first", async () => {
    const { draft } = makeDraft();
    await compose(draft, "see attached");
    const { channel, sent } = makeChannel();
    const client = makeClient({
      // The query answered before the adapter's state had loaded
      split: false,
      prepare: (call, files) => {
        if (call === 0) {
          throw Object.assign(new Error("first file"), {
            name: "E2EESendError",
            kind: "first_file",
          });
        }
        return Array.from({ length: files }, (_, i) => `e2ee-${call}-${i}`);
      },
    });

    await draft.sendDraft(client as never, channel as never);

    assert.deepEqual(events, [
      "willSplit:text:1",
      "prepare:1",
      "send:1",
      "prepare:1",
      "send:2",
    ]);
    assert.deepEqual(sent[0].data, {
      content: "see attached",
      replies: REPLIES,
    });
    assert.equal(sent[1].data.content, undefined);
    assert.deepEqual(sent[1].data.e2eeAttachments, ["e2ee-1-0"]);
    assert.deepEqual(uploads(), []);
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
  });

  it("a split query that throws sends nothing and puts the draft back", async () => {
    const { draft } = makeDraft();
    const fileIds = await compose(draft, "see attached");
    const { channel, sent } = makeChannel();
    const client = makeClient({
      split: () => {
        throw new Error("status unknown");
      },
    });

    await assert.rejects(
      draft.sendDraft(client as never, channel as never),
      /status unknown/,
    );
    assert.equal(sent.length, 0);
    assert.deepEqual(uploads(), []);
    assert.deepEqual(draft.getDraft(CHANNEL).files, fileIds);
    assert.equal(draft.getDraft(CHANNEL).content, "see attached");
  });
});

describe("plain uploads ask the guard first", () => {
  it("the single-request upload asks before the request", async () => {
    const { draft } = makeDraft();
    await compose(draft, "hi");
    const { channel, sent } = makeChannel();

    await draft.sendDraft(makePlainClient(() => {}) as never, channel as never);

    assert.deepEqual(events, ["guard:upload", "xhr", "send:1"]);
    assert.equal(sent[0].data.content, "hi");
  });

  it("a refusal uploads nothing and fails the entry with the marker", async () => {
    const { draft } = makeDraft();
    const fileIds = await compose(draft, "hi", [smallFile(), bigFile()]);
    const { channel, sent } = makeChannel();
    const client = makePlainClient(() => {
      throw blocked("recipient");
    });

    await draft.sendDraft(client as never, channel as never);

    assert.deepEqual(events, ["guard:upload"]);
    assert.equal(sent.length, 0);
    const [failed] = draft.getPendingMessages(CHANNEL);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "EncryptionRequired:recipient");
    assert.deepEqual(failed.files, fileIds);
  });

  it("the chunked upload asks before it starts", async () => {
    const { draft } = makeDraft();
    await compose(draft, "hi", [bigFile()]);
    const { channel, sent } = makeChannel();

    await draft.sendDraft(makePlainClient(() => {}) as never, channel as never);

    assert.deepEqual(events, ["guard:upload", "chunked", "send:1"]);
    assert.deepEqual(sent[0].data.attachments, ["chunked-id"]);
  });

  it("an encrypted upload never asks", async () => {
    const { draft } = makeDraft();
    await compose(draft, "hi");
    const { channel, sent } = makeChannel();
    const client = makeClient({ split: false }, () => {
      throw blocked("sender");
    });

    await draft.sendDraft(client as never, channel as never);

    assert.deepEqual(events, ["willSplit:text:1", "prepare:1", "send:1"]);
    assert.deepEqual(sent[0].data.e2eeAttachments, ["e2ee-0-0"]);
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
  });
});

describe("sends that are not split are unchanged", () => {
  it("an established conversation sends text and files as one message", async () => {
    const { draft } = makeDraft();
    await compose(draft, "hi");
    const { channel, sent } = makeChannel();

    await draft.sendDraft(
      makeClient({ split: false }) as never,
      channel as never,
    );

    assert.deepEqual(events, ["willSplit:text:1", "prepare:1", "send:1"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].data.content, "hi");
    assert.deepEqual(sent[0].data.replies, REPLIES);
    assert.deepEqual(sent[0].data.e2eeAttachments, ["e2ee-0-0"]);
  });

  it("a text-only send is not asked about a split", async () => {
    const { draft } = makeDraft();
    await compose(draft, "hi", []);
    const { channel, sent } = makeChannel();

    await draft.sendDraft(makeClient() as never, channel as never);

    assert.deepEqual(events, ["prepare:0", "send:1"]);
    assert.equal(sent[0].data.content, "hi");
  });

  it("an adapter without the query, and no guard, sends as before", async () => {
    const { draft } = makeDraft();
    await compose(draft, "hi");
    const { channel, sent } = makeChannel();
    const client = makeClient({ prepare: () => null });
    delete (client.e2ee as { willSplitFirstSend?: unknown }).willSplitFirstSend;

    await draft.sendDraft(client as never, channel as never);

    assert.deepEqual(events, ["prepare:1", "xhr", "send:1"]);
    assert.equal(sent[0].data.content, "hi");
    assert.equal((sent[0].data.attachments as string[]).length, 1);
  });
});

describe("a peer an attempt found with no usable device", () => {
  // An adapter that follows the bridge's first-send rules: a text-only send
  // that tries to encrypt and finds no usable device notes it for the page,
  // and while the note holds nothing is split or held back for text. The
  // bridge's own rules are pinned in `e2eeEncryptedOnly.scan.test.ts`.
  function staleHintClient() {
    const state = { noDevice: false };
    const client = makeClient({}, () => {});
    Object.assign(client.e2ee, {
      willSplitFirstSend: (_channel: unknown, draft: Row) => {
        events.push(`willSplit:${draft.content ? "text" : "no-text"}`);
        return !state.noDevice;
      },
      prepareDraftAttachments: async (
        _channel: unknown,
        items: unknown[],
        options?: { textWentPlain?: boolean },
      ) => {
        events.push(`prepare:${items.length}`);
        prepareOptions.push(options);
        if (items.length && !state.noDevice && !options?.textWentPlain) {
          throw Object.assign(new Error("first file"), {
            name: "E2EESendError",
            kind: "first_file",
          });
        }
        return null;
      },
      isEncryptedMessage: () => false,
    });
    return { client, state };
  }

  it("several sends in a row stay ordinary: one split at most, never asked for text", async () => {
    const { draft } = makeDraft();
    const { client, state } = staleHintClient();
    const { channel, sent } = makeChannel((n) => {
      // The text-only attempt finds no usable device and goes plain
      if (!sent[n].data.attachments) state.noDevice = true;
    });

    await compose(draft, "first");
    await draft.sendDraft(client as never, channel as never);
    await compose(draft, "second");
    await draft.sendDraft(client as never, channel as never);
    await compose(draft, undefined);
    await draft.sendDraft(client as never, channel as never);
    await compose(draft, undefined);
    await draft.sendDraft(client as never, channel as never);

    assert.deepEqual(
      sent.map((message) => [
        message.data.content ?? "",
        (message.data.attachments as string[] | undefined)?.length ?? 0,
      ]),
      [
        ["first", 0],
        ["", 1],
        ["second", 1],
        ["", 1],
        ["", 1],
      ],
      "the first send splits; every later one is a single message",
    );
    assert.equal(uploads().length, 4);
    assert.deepEqual(prepareOptions, [
      { textWentPlain: true },
      { textWentPlain: false },
      { textWentPlain: false },
      { textWentPlain: false },
    ]);
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
    assert.deepEqual(draft.getDraft(CHANNEL).files ?? [], []);
  });
});

describe("an entry refused for not being encrypted", () => {
  it("a retry runs the send again: refused again while the cause holds, sent once it is gone", async () => {
    const { draft } = makeDraft();
    await compose(draft, "hi", []);
    let refuse = true;
    const { channel, sent } = makeChannel(() => {
      if (refuse) {
        throw JSON.stringify({ type: "EncryptionRequired", side: "recipient" });
      }
    });
    const client = makePlainClient();

    await draft.sendDraft(client as never, channel as never);
    const [failed] = draft.getPendingMessages(CHANNEL);
    assert.equal(failed.error, "EncryptionRequired:recipient");

    const retry = async () => {
      const [entry] = draft.getPendingMessages(CHANNEL);
      draft.retrySend(client as never, channel as never, entry.idempotencyKey);
      await new Promise((resolve) => setImmediate(resolve));
    };

    await retry();
    assert.equal(sent.length, 2, "the retry was a real attempt");
    const [still, ...rest] = draft.getPendingMessages(CHANNEL);
    assert.equal(rest.length, 0);
    assert.equal(still.status, "failed");
    assert.equal(still.error, "EncryptionRequired:recipient", "marker kept");

    refuse = false;
    await retry();
    assert.equal(sent.length, 3);
    assert.equal(sent[2].data.content, "hi");
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
  });

  it("keeps its refusal across a reload; other failures become unsent as before", () => {
    const { draft } = makeDraft();
    const cleaned = draft.clean({
      drafts: {},
      outbox: {
        [CHANNEL]: [
          {
            idempotencyKey: "a",
            status: "failed",
            content: "secret",
            error: "EncryptionRequired:sender",
          },
          {
            idempotencyKey: "b",
            status: "failed",
            content: "other",
            error: "Upload timed out",
          },
          { idempotencyKey: "c", status: "failed", content: "odd", error: 7 },
        ],
      },
    } as never).outbox[CHANNEL];

    assert.deepEqual(cleaned, [
      {
        idempotencyKey: "a",
        content: "secret",
        status: "failed",
        error: "EncryptionRequired:sender",
      },
      { idempotencyKey: "b", content: "other", status: "unsent" },
      { idempotencyKey: "c", content: "odd", status: "unsent" },
    ]);
  });

  it("another failure is still retried", async () => {
    const { draft } = makeDraft();
    await compose(draft, "hi", []);
    let fail = true;
    const { channel, sent } = makeChannel(() => {
      if (fail) throw new Error("network");
    });
    const client = makePlainClient();

    await draft.sendDraft(client as never, channel as never);
    const [failed] = draft.getPendingMessages(CHANNEL);
    assert.equal(failed.error, "network");

    fail = false;
    draft.retrySend(client as never, channel as never, failed.idempotencyKey);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sent.length, 2);
    assert.equal(draft.getPendingMessages(CHANNEL).length, 0);
  });
});
