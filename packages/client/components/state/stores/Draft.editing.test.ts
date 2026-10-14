/**
 * Run with:
 *
 *     node --conditions=browser --test components/state/stores/Draft.editing.test.ts
 *
 * Covers the per-channel editing state and the composer registry in
 * `./Draft.ts`. Both used to be single global slots (`editingMessageId` and
 * `_setNodeReplacement`), which was harmless with one composer on screen and
 * wrong as soon as chat windows put several on screen at once: ArrowUp in one
 * window edited a message in another, and a closing composer unregistered
 * whichever one had mounted last.
 *
 * `./Draft.ts` is loaded through the same `module.registerHooks` substitution
 * `./draftUpload.test.ts` documents, with one difference: the store is a REAL
 * `solid-js/store` and `batch` / `createSignal` are the real ones, so the
 * reactivity specs below exercise actual subscriptions rather than a stand-in.
 *
 * Known-bad control: point `DRAFT_EDITING_UNDER_TEST` at an absolute path to a
 * copy of another `Draft.ts` (e.g. the one at 0d81d2e9, or a mutant of this
 * one) and the specs it breaks fail.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { createEffect, createRoot } from "solid-js";
import { createStore } from "solid-js/store";

const UNDER_TEST = process.env.DRAFT_EDITING_UNDER_TEST
  ? pathToFileURL(process.env.DRAFT_EDITING_UNDER_TEST).href
  : new URL("./Draft.ts", import.meta.url).href;

// The real import also names the types Accessor/Setter, which Node's type
// stripping keeps as value imports, so they are stood in for and the values
// re-exported from the real module
const SOLID_URL = import.meta.resolve("solid-js");

const STUBS: Record<string, string> = {
  "solid-js": `export { batch, createSignal } from ${JSON.stringify(SOLID_URL)};
    export const Accessor = undefined;
    export const Setter = undefined;`,
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
  "./Layout": `export const LAYOUT_SECTIONS = { MENTION_REPLY: "mention" };`,
  "./chunkedUpload": `export async function uploadFileChunked() {
    throw new Error("chunked path not under test");
  }`,
  "./draftSendError.ts": `export const describeSendError = String;`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS && context.parentURL === UNDER_TEST) {
      return { url: `draft-editing-test:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("draft-editing-test:")) {
      return {
        format: "module",
        shortCircuit: true,
        source: STUBS[url.slice("draft-editing-test:".length)],
      };
    }
    return nextLoad(url, context);
  },
});

const { Draft } = await import(UNDER_TEST);

type Replacement = readonly [string | "_focus"] | undefined;

/** A real Draft over a real solid store */
function makeDraft() {
  const probe = new Draft({} as never);
  const [store, setStore] = createStore({ draft: probe.default() });
  const state = {
    get: (key: "draft") => store[key],
    set: (...args: unknown[]) =>
      (setStore as unknown as (...args: unknown[]) => void)(...args),
    layout: { getSectionState: () => true },
  };
  return new Draft(state as never);
}

/** Just enough of a Message for the editing API */
function message(channelId: string, id: string, content?: string) {
  return { id, channelId, content, authorId: "someone-else" };
}

/** A composer setter that records what it was given */
function composer() {
  const calls: Replacement[] = [];
  const setter = (value: Replacement) => {
    calls.push(value);
    return value;
  };
  return { setter, calls };
}

describe("clean()", () => {
  it("drops the legacy global editing fields and any edit in progress", () => {
    const cleaned = makeDraft().clean({
      drafts: { a: { content: "hello" } },
      outbox: {},
      editingMessageId: "m1",
      editingMessageContent: "old text",
      editing: { a: { id: "m2", content: "x" } },
    } as never);

    assert.deepEqual(cleaned, {
      drafts: { a: { content: "hello" } },
      outbox: {},
      editing: {},
    });
  });
});

describe("per-channel editing", () => {
  it("editing a message touches only that message's channel", () => {
    const draft = makeDraft();
    draft.setEditingMessage(message("a", "m1", "first"));

    assert.equal(draft.getEditingMessageId("a"), "m1");
    assert.equal(draft.getEditingMessageContent("a"), "first");
    assert.equal(draft.getEditingMessageId("b"), undefined);
    assert.equal(draft.getEditingMessageContent("b"), undefined);
  });

  it("the newest-message marker and stopping are scoped to their channel", () => {
    const draft = makeDraft();
    draft.setEditingMessage(message("a", "m1", "first"));
    draft.setEditingMessage(true, "b");

    assert.equal(draft.getEditingMessageId("b"), true);
    assert.equal(draft.getEditingMessageContent("b"), undefined);
    assert.equal(draft.getEditingMessageId("a"), "m1");

    draft.setEditingMessage(undefined, "b");
    assert.equal(draft.getEditingMessageId("b"), undefined);
    assert.equal(draft.getEditingMessageId("a"), "m1");
    assert.equal(draft.getEditingMessageContent("a"), "first");
  });

  it("replacing an edit does not carry the previous message's text over", () => {
    const draft = makeDraft();
    draft.setEditingMessage(message("a", "m1", "first"));
    draft.setEditingMessageContent("a", "first, edited");
    draft.setEditingMessage(true, "a");

    assert.equal(draft.getEditingMessageId("a"), true);
    assert.equal(draft.getEditingMessageContent("a"), undefined);
  });

  it("editor text goes to its own channel and is ignored once the edit ended", () => {
    const draft = makeDraft();
    draft.setEditingMessage(message("a", "m1", "first"));
    draft.setEditingMessage(message("b", "m2", "second"));
    draft.setEditingMessageContent("a", "first, edited");

    assert.equal(draft.getEditingMessageContent("a"), "first, edited");
    assert.equal(draft.getEditingMessageContent("b"), "second");

    draft.setEditingMessageContent("c", "nowhere");
    assert.equal(draft.getEditingMessageId("c"), undefined);
    assert.equal(draft.getEditingMessageContent("c"), undefined);
  });

  it("reads are reactive, and a change in one channel does not wake another", () => {
    const draft = makeDraft();
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];

    const dispose = createRoot((dispose) => {
      createEffect(() => seenA.push(draft.getEditingMessageId("a")));
      createEffect(() => seenB.push(draft.getEditingMessageContent("b")));
      return dispose;
    });

    draft.setEditingMessage(message("a", "m1", "first"));
    draft.setEditingMessage(true, "a");
    draft.setEditingMessage(message("b", "m2", "second"));
    draft.setEditingMessage(undefined, "a");

    dispose();
    assert.deepEqual(seenA, [undefined, "m1", true, undefined]);
    assert.deepEqual(seenB, [undefined, "second"]);
  });
});

describe("composer registry", () => {
  it("replaceNode reaches only the named channel's composer", () => {
    const draft = makeDraft();
    const a = composer();
    const b = composer();
    draft.registerNodeReplacement("a", a.setter);
    draft.registerNodeReplacement("b", b.setter);

    assert.equal(draft.replaceNode("a", ["_focus"]), true);
    assert.deepEqual(a.calls, [["_focus"]]);
    assert.deepEqual(b.calls, []);

    assert.equal(draft.replaceNode("c", ["_focus"]), false);
    assert.equal(draft.hasNodeReplacement("a"), true);
    assert.equal(draft.hasNodeReplacement("c"), false);
  });

  it("replaceNode(undefined) targets the composer focused last", () => {
    const draft = makeDraft();
    const a = composer();
    const b = composer();
    draft.registerNodeReplacement("a", a.setter);
    draft.registerNodeReplacement("b", b.setter);
    draft.noteComposerFocus("a");

    assert.equal(draft.replaceNode(undefined, ["user-1"]), true);
    assert.deepEqual(a.calls, [["user-1"]]);
    assert.deepEqual(b.calls, []);
  });

  it("replaceNode(undefined) falls back to the window's earlier focus, then to none", () => {
    const draft = makeDraft();
    assert.equal(draft.hasNodeReplacement(), false);
    assert.equal(draft.replaceNode(undefined, ["user-1"]), false);

    const a = composer();
    const b = composer();
    const offA = draft.registerNodeReplacement("a", a.setter);
    const offB = draft.registerNodeReplacement("b", b.setter);

    // never focused: there is no window to attribute either composer to
    assert.equal(draft.replaceNode(undefined, ["user-1"]), false);
    assert.equal(draft.hasNodeReplacement(undefined, "main"), false);
    assert.deepEqual(a.calls, []);
    assert.deepEqual(b.calls, []);

    // focused composer has gone away
    draft.noteComposerFocus("a");
    draft.noteComposerFocus("b");
    offB();
    assert.equal(draft.replaceNode(undefined, ["user-2"]), true);
    assert.deepEqual(a.calls, [["user-2"]]);
    assert.deepEqual(b.calls, []);

    offA();
    assert.equal(draft.hasNodeReplacement(), false);
    assert.equal(draft.replaceNode(undefined, ["user-3"]), false);
  });

  it("replaceNode(undefined) never reaches a composer focused in another window", () => {
    const draft = makeDraft();
    const main = composer();
    const chat = composer();
    draft.registerNodeReplacement("server-channel", main.setter);
    draft.registerNodeReplacement("dm", chat.setter);
    draft.noteComposerFocus("dm", "w1");

    // main's composer never took focus, w1's did, most recently overall
    assert.equal(draft.replaceNode(undefined, ["user-1"], "main"), false);
    assert.equal(draft.replaceNode(undefined, ["user-1"]), false);
    assert.deepEqual(chat.calls, []);
    assert.deepEqual(main.calls, []);
    assert.equal(draft.hasNodeReplacement(undefined, "main"), false);
    assert.equal(draft.hasNodeReplacement("dm", "main"), false);

    draft.noteComposerFocus("server-channel");
    draft.noteComposerFocus("dm", "w1");
    assert.equal(draft.replaceNode(undefined, ["user-2"], "main"), true);
    assert.equal(draft.replaceNode(undefined, ["user-3"], "w1"), true);
    assert.deepEqual(main.calls, [["user-2"]]);
    assert.deepEqual(chat.calls, [["user-3"]]);
    assert.equal(draft.hasNodeReplacement("server-channel", "main"), true);
    assert.equal(draft.hasNodeReplacement("server-channel", "w1"), false);
    assert.equal(draft.hasNodeReplacement(undefined, "w1"), true);
    assert.equal(draft.hasNodeReplacement(undefined, "w2"), false);
  });

  it("a window stops reaching a channel once that channel's composer unmounts", () => {
    const draft = makeDraft();
    const mainDm = composer();
    const offMainDm = draft.registerNodeReplacement("dm", mainDm.setter);
    draft.noteComposerFocus("dm", "main");

    // the DM moves into a chat window and main navigates away from it
    const chatDm = composer();
    draft.registerNodeReplacement("dm", chatDm.setter);
    offMainDm();

    assert.equal(draft.replaceNode(undefined, ["user-1"], "main"), false);
    assert.equal(draft.hasNodeReplacement(undefined, "main"), false);
    assert.deepEqual(chatDm.calls, []);
    assert.deepEqual(mainDm.calls, []);
  });

  it("a stale unregister does not drop a re-registration's focus", () => {
    const draft = makeDraft();
    const a = composer();
    const offFirst = draft.registerNodeReplacement("a", a.setter);
    offFirst();
    draft.registerNodeReplacement("a", a.setter);
    draft.noteComposerFocus("a", "w1");
    offFirst();

    assert.equal(draft.replaceNode(undefined, ["user-1"], "w1"), true);
    assert.deepEqual(a.calls, [["user-1"]]);
  });

  it("the newest composer for a channel wins, and unregister removes only its own", () => {
    const draft = makeDraft();
    const older = composer();
    const newer = composer();
    const offOlder = draft.registerNodeReplacement("a", older.setter);
    const offNewer = draft.registerNodeReplacement("a", newer.setter);

    draft.replaceNode("a", ["_focus"]);
    assert.deepEqual(newer.calls, [["_focus"]]);
    assert.deepEqual(older.calls, []);

    // the older composer closing must not take the newer one with it
    offOlder();
    offOlder();
    draft.replaceNode("a", ["_focus"]);
    assert.deepEqual(newer.calls, [["_focus"], ["_focus"]]);
    assert.deepEqual(older.calls, []);

    offNewer();
    assert.equal(draft.hasNodeReplacement("a"), false);
  });

  it("a stale unregister does not remove a re-registration of the same setter", () => {
    const draft = makeDraft();
    const a = composer();
    const offFirst = draft.registerNodeReplacement("a", a.setter);
    offFirst();
    draft.registerNodeReplacement("a", a.setter);
    offFirst();

    assert.equal(draft.replaceNode("a", ["_focus"]), true);
    assert.deepEqual(a.calls, [["_focus"]]);
  });

  it("hasNodeReplacement() is reactive", () => {
    const draft = makeDraft();
    const seen: boolean[] = [];
    const dispose = createRoot((dispose) => {
      createEffect(() => seen.push(draft.hasNodeReplacement()));
      return dispose;
    });

    const off = draft.registerNodeReplacement("a", composer().setter);
    off();

    dispose();
    assert.deepEqual(seen, [false, true, false]);
  });

  it("hasNodeReplacement(_, ctxId) reacts to focus as well as registration", () => {
    const draft = makeDraft();
    const seen: boolean[] = [];
    const dispose = createRoot((dispose) => {
      createEffect(() => seen.push(draft.hasNodeReplacement(undefined, "w1")));
      return dispose;
    });

    const off = draft.registerNodeReplacement("a", composer().setter);
    draft.noteComposerFocus("a", "w1");
    off();

    dispose();
    // registered but not yet focused in w1, then focused, then unmounted
    assert.deepEqual(seen, [false, false, true, false]);
  });

  it("registering from inside an effect does not subscribe it to other registrations", () => {
    const draft = makeDraft();
    let runs = 0;
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        runs++;
        draft.registerNodeReplacement("a", composer().setter);
        draft.noteComposerFocus("a");
      });
      return dispose;
    });

    draft.registerNodeReplacement("b", composer().setter);
    draft.noteComposerFocus("b");
    draft.noteComposerFocus("a", "w1");
    draft.replaceNode(undefined, ["_focus"]);

    dispose();
    assert.equal(runs, 1);
  });

  it("addReply focuses the composer of the reply's channel", () => {
    const draft = makeDraft();
    const a = composer();
    const b = composer();
    draft.registerNodeReplacement("a", a.setter);
    draft.registerNodeReplacement("b", b.setter);
    draft.noteComposerFocus("b");

    draft.addReply(message("a", "m1", "hi"), "self");

    assert.deepEqual(a.calls, [["_focus"]]);
    assert.deepEqual(b.calls, []);
    assert.deepEqual(draft.getDraft("a").replies, [
      { id: "m1", mention: true },
    ]);
  });
});
