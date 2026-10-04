/**
 * Run with:
 *
 *     node --conditions=browser --test components/state/stores/draftUpload.test.ts
 *
 * Covers how `Draft.sendDraft` reports a failed attachment upload, and the
 * attach-time snapshot in `cacheFile`. Before these existed a failed upload
 * showed "Uploading file ... 100%" next to "Failed to send" with the reason
 * thrown away, which sent a whole investigation looking at the server for a
 * request that had died on the phone.
 *
 * `./Draft.ts` reaches the whole app through its imports (`"."` -> `State`,
 * `@revolt/common`, extensionless sibling modules), so those specifiers are
 * swapped for minimal stand-ins via `module.registerHooks`, the same approach
 * `./keybinds.test.ts` documents. Only imports whose parent is the module
 * under test are substituted; `./Draft.ts` itself loads from disk.
 *
 * Known-bad control: point `DRAFT_UNDER_TEST` at a copy of the pre-fix
 * `Draft.ts` (in this directory) and the error/progress/snapshot specs fail.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it, mock } from "node:test";

const UNDER_TEST = process.env.DRAFT_UNDER_TEST ?? "./Draft.ts";
const PARENT_SUFFIX = `/state/stores/${UNDER_TEST.replace(/^\.\//, "")}`;

const STUBS: Record<string, string> = {
  // The real import also names the types Accessor/Setter, which Node's type
  // stripping keeps as value imports, so solid-js is stood in for as well
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
    export class Channel {} export class Client {}`,
  ulid: `let n = 0; export const ulid = () => "key-" + ++n;`,
  "./Layout": `export const LAYOUT_SECTIONS = {};`,
  "./chunkedUpload": `export async function uploadFileChunked() {
    throw new Error("chunked path not under test");
  }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier in STUBS &&
      typeof context.parentURL === "string" &&
      context.parentURL.endsWith(PARENT_SUFFIX)
    ) {
      return { url: `draft-test:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("draft-test:")) {
      return {
        format: "module",
        shortCircuit: true,
        source: STUBS[url.slice("draft-test:".length)],
      };
    }
    return nextLoad(url, context);
  },
});

type Outcome =
  | { kind: "status"; status: number; response?: unknown }
  | { kind: "network" }
  | { kind: "dropped" }
  | { kind: "timeout" };

/** What the next XHR will do once `send` is called */
let nextOutcome: Outcome = { kind: "status", status: 200 };
/** Bodies the fake XHR was asked to send */
const sentBodies: FormData[] = [];

/**
 * Just enough XMLHttpRequest for `sendDraft`: upload progress/load events and
 * the request's own timeout/error/loadend, fired in the order browsers use.
 */
class FakeXHR extends EventTarget {
  upload = new EventTarget();
  readyState = 0;
  status = 0;
  response: unknown = null;
  timeout = 0;
  responseType = "";
  open() {
    this.readyState = 1;
  }
  setRequestHeader() {}
  send(body: FormData) {
    sentBodies.push(body);
    const outcome = nextOutcome;
    queueMicrotask(() => {
      if (outcome.kind === "status") {
        const progress = new Event("progress") as Event & {
          lengthComputable: boolean;
          loaded: number;
          total: number;
        };
        progress.lengthComputable = true;
        progress.loaded = 50;
        progress.total = 100;
        this.upload.dispatchEvent(progress);
        this.upload.dispatchEvent(new Event("load"));
        this.readyState = 4;
        this.status = outcome.status;
        this.response = outcome.response ?? null;
        this.dispatchEvent(new Event("load"));
      } else {
        // "dropped": the body went out in full, then the connection died
        // before a response (proxy error page without CORS, reset, ...)
        if (outcome.kind === "dropped") {
          this.upload.dispatchEvent(new Event("load"));
        }
        this.readyState = 4;
        this.dispatchEvent(
          new Event(outcome.kind === "timeout" ? "timeout" : "error"),
        );
      }
      this.dispatchEvent(new Event("loadend"));
    });
  }
}

(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR;

/** Pretend to be the Android app (snapshots on) or a desktop (off) */
function setUserAgent(userAgent: string) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent },
    configurable: true,
  });
}
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; 25057RN09E Build/AQ3A; wv) AppleWebKit/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0";
setUserAgent(ANDROID_UA);

const { Draft } = await import(UNDER_TEST);

/** A real Draft over a fake path-setting state */
function makeDraft() {
  const data: Record<string, unknown> = { drafts: {}, outbox: {} };
  const state = {
    get: () => data,
    set: (_key: string, ...path: unknown[]) => {
      const value = path.pop();
      let target = data as Record<string, unknown>;
      for (const segment of path.slice(0, -1)) {
        target = (target[segment as string] ??= {}) as Record<string, unknown>;
      }
      target[path[path.length - 1] as string] = value;
    },
  };
  return new Draft(state as never);
}

const client = {
  configuration: { features: { autumn: { url: "https://autumn.test" } } },
  authenticationHeader: ["X-Session-Token", "test"],
};

function makeChannel(sendMessage: () => Promise<unknown> = async () => ({})) {
  return { id: "channel-1", sendMessage };
}

/** A picked file whose every read fails, like the Xiaomi gallery URI */
class UnreadableFile extends File {
  override async arrayBuffer(): Promise<ArrayBuffer> {
    throw new DOMException("The file could not be read", "NotReadableError");
  }
}

async function attachAndSend(
  file: File,
  outcome: Outcome,
  sendMessage?: () => Promise<unknown>,
) {
  const draft = makeDraft();
  const channel = makeChannel(sendMessage);
  await draft.addFile(channel.id, file);
  const [fileId] = draft.getDraft(channel.id).files;
  const cached = draft.getFile(fileId);
  nextOutcome = outcome;
  await draft.sendDraft(client as never, channel as never);
  const [entry] = draft.getPendingMessages(channel.id);
  return { draft, cached, entry };
}

const textFile = () =>
  new File(["hello"], "notes.txt", { type: "text/plain", lastModified: 1 });

describe("attach-time snapshot", () => {
  it("replaces the picked file with an in-memory copy of the same bytes", async () => {
    const original = textFile();
    const draft = makeDraft();
    await draft.addFile("channel-1", original);
    const [fileId] = draft.getDraft("channel-1").files;
    const { file, readError } = draft.getFile(fileId);

    assert.notEqual(file, original, "the original handle must not be kept");
    assert.equal(file.name, "notes.txt");
    assert.equal(file.type, "text/plain");
    assert.equal(file.lastModified, 1);
    assert.equal(await file.text(), "hello");
    assert.equal(readError, undefined);
  });

  it("keeps the original and records why when the read fails", async () => {
    const original = new UnreadableFile(["x"], "IMG_1.jpg", {
      type: "text/plain",
    });
    const draft = makeDraft();
    await draft.addFile("channel-1", original);
    const [fileId] = draft.getDraft("channel-1").files;
    const { file, readError } = draft.getFile(fileId);

    assert.equal(file, original);
    assert.match(readError, /NotReadableError/);
  });

  it("leaves desktop picks alone", async () => {
    setUserAgent(DESKTOP_UA);
    try {
      const original = textFile();
      const draft = makeDraft();
      await draft.addFile("channel-1", original);
      const [fileId] = draft.getDraft("channel-1").files;

      assert.equal(draft.getFile(fileId).file, original);
    } finally {
      setUserAgent(ANDROID_UA);
    }
  });

  // Bounded: without the fix this hangs forever instead of failing
  it(
    "a preview that never loads doesn't block later attachments",
    { timeout: 5_000 },
    async () => {
      // An Image whose load never settles, like a stalled content URI read
      class StalledImage {
        onload: (() => void) | null = null;
        onerror: ((error: unknown) => void) | null = null;
        width = 0;
        height = 0;
        set src(_value: string) {}
      }
      const g = globalThis as unknown as { Image?: unknown };
      const previous = g.Image;
      g.Image = StalledImage;
      mock.timers.enable({ apis: ["setTimeout"] });

      try {
        const draft = makeDraft();
        const first = draft.addFile(
          "channel-1",
          new File(["jpeg"], "stalled.jpg", { type: "image/jpeg" }),
        );
        const second = draft.addFile("channel-1", textFile());

        // Let the snapshot read finish and the preview start, then let the
        // preview's time limit pass
        for (let i = 0; i < 5; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        mock.timers.tick(30_000);

        await first;
        await second;
        const files = draft
          .getDraft("channel-1")
          .files.map((id: string) => draft.getFile(id));
        assert.deepEqual(
          files.map((entry: { file: File }) => entry.file.name),
          ["stalled.jpg", "notes.txt"],
        );
        assert.equal(files[0].dimensions, undefined);
      } finally {
        mock.timers.reset();
        g.Image = previous;
      }
    },
  );

  it("keeps pick order and skips files past the attachment limit", async () => {
    const draft = makeDraft();
    const picked = ["a", "b", "c"].map(
      (name) => new File([name], `${name}.txt`, { type: "text/plain" }),
    );
    // The composer fires these without awaiting, all at once
    await Promise.all(picked.map((file) => draft.addFile("channel-1", file)));
    const files = draft
      .getDraft("channel-1")
      .files.map((id: string) => draft.getFile(id).file);

    assert.deepEqual(
      files.map((file: File) => file.name),
      ["a.txt", "b.txt", "c.txt"],
    );
    // MAX_ATTACHMENTS is 2 in the stub: the third is never sent from this
    // draft, so it must not be held in memory
    assert.notEqual(files[0], picked[0]);
    assert.notEqual(files[1], picked[1]);
    assert.equal(files[2], picked[2]);
  });
});

describe("failed uploads say why", () => {
  it("a network failure names the device side and the read error", async () => {
    const { cached, entry } = await attachAndSend(
      new UnreadableFile(["x"], "IMG_1.jpg", { type: "text/plain" }),
      { kind: "network" },
    );

    assert.equal(entry.status, "failed");
    assert.match(entry.error, /failed before reaching the server/);
    assert.match(entry.error, /NotReadableError/);
    assert.notEqual(
      cached.uploadProgress[0](),
      1,
      "a failed upload must not read 100%",
    );
    assert.equal(cached.uploadProcessing[0](), false);
  });

  it("an HTTP error carries the status", async () => {
    const { cached, entry } = await attachAndSend(textFile(), {
      kind: "status",
      status: 500,
    });

    assert.equal(entry.status, "failed");
    assert.match(entry.error, /HTTP 500/);
    // The body did go out in full here, so bytes-sent may honestly read 1;
    // what must not survive is the "processing on the server" state
    assert.equal(cached.uploadProcessing[0](), false);
  });

  it("a connection lost after the body went out doesn't blame the device", async () => {
    const { entry } = await attachAndSend(textFile(), { kind: "dropped" });

    assert.equal(entry.status, "failed");
    assert.match(entry.error, /lost its connection after the file was sent/);
    assert.doesNotMatch(entry.error, /before reaching the server/);
  });

  it("a timeout says it timed out", async () => {
    const { entry } = await attachAndSend(textFile(), { kind: "timeout" });

    assert.equal(entry.status, "failed");
    assert.match(entry.error, /timed out/);
  });

  // stoat-api's req() throws the failed response's body TEXT, so these throw
  // exactly that: a string, never a parsed object
  it("a rejected send reports the server's error type", async () => {
    const { entry } = await attachAndSend(
      textFile(),
      { kind: "status", status: 200, response: { id: "autumn-1" } },
      async () => {
        throw JSON.stringify({
          type: "MissingPermission",
          permission: "UploadFiles",
        });
      },
    );

    assert.equal(entry.status, "failed");
    assert.equal(
      entry.error,
      "The server rejected the message (MissingPermission)",
    );
  });

  it("a non-JSON error body is not dumped into the chat", async () => {
    const { entry } = await attachAndSend(
      textFile(),
      { kind: "status", status: 200, response: { id: "autumn-1" } },
      async () => {
        throw "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>";
      },
    );

    assert.equal(entry.status, "failed");
    assert.equal(entry.error, "The server returned an error");
  });
});

describe("successful uploads", () => {
  it("upload the snapshot, reach 100% and clear the outbox", async () => {
    sentBodies.length = 0;
    const { draft, cached, entry } = await attachAndSend(textFile(), {
      kind: "status",
      status: 200,
      response: { id: "autumn-1" },
    });

    assert.equal(entry, undefined, "the outbox entry is removed on success");
    assert.equal(cached.uploadProgress[0](), 1);
    assert.equal(draft.getPendingMessages("channel-1").length, 0);
    const sent = sentBodies[0].get("file") as File;
    assert.equal(sent, cached.file, "the upload sends the cached snapshot");
    assert.equal(await sent.text(), "hello");
  });
});
