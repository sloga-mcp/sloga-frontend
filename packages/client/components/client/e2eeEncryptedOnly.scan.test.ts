// Spec for the Encrypted-only rules in `e2ee.ts`. Run with Node's built-in
// runner from packages/client:
//   node --conditions=browser --test components/client/e2eeEncryptedOnly.scan.test.ts
// Declared test count: 23 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// `e2ee.ts` cannot load under Node (Solid, the native bridge, stoat.js), so
// it is checked two ways:
//
// - The helpers that decide (`#refusePlainFallback`, `#refusePlaintextExit`,
//   `willSplitFirstSend`, the peer memory, the no-usable-device note and the
//   error classes) are cut out of the real file, stripped of their types and
//   run in a small stand-in class around the real latch, policy and guard
//   modules. That runs the code itself, not a copy of it.
// - The send paths that call them are too large to run, so their wiring is
//   pinned by reading the source with comments removed.
//
// Point `E2EE_SCAN_FILE` at another copy to check that instead. Known-bad
// controls: `e2ee.ts` at commit 761b9231, before any of this existed, fails
// every test; the first uncommitted send path on top of it (no shared
// builder, no no-device note, no peer-changed reason) fails all but the
// downgrade source test, which pins code these fixes did not change.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import { describeSendError } from "../state/stores/draftSendError.ts";
import {
  ENCRYPTED_ONLY_BLOCKED_ERROR_NAME,
  encryptionRequiredSide,
} from "./apiErrorType.ts";
import {
  buildPlainWriteInput,
  noteEvent,
  peerTurnedOff,
} from "./encryptedOnlyGuard.ts";
import {
  bindLatchAccount,
  confirmPeerChanged,
  forgetSeen,
  isSeen,
  latchAccountId,
  latchedForClient,
  rememberSeen,
  setLatch,
} from "./encryptedOnlyLatch.ts";
import {
  type PlainWriteInput,
  decidePlainWrite,
  reasonFor,
} from "./encryptedOnlyPolicy.ts";

const SCAN_FILE =
  process.env.E2EE_SCAN_FILE || new URL("./e2ee.ts", import.meta.url);
const SOURCE = readFileSync(SCAN_FILE, "utf8");
const ERRORS_SOURCE = readFileSync(
  new URL("../i18n/errors.ts", import.meta.url),
  "utf8",
);

// The latch keeps its state in `localStorage`
const items = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  },
});

// ---- Reading the source -----------------------------------------------------

/** Index just past the string or comment that starts at `i`, or `i`. */
function skipQuiet(text: string, i: number): number {
  const c = text[i];
  const next = text[i + 1];
  if (c === "/" && next === "/") {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length : end;
  }
  if (c === "/" && next === "*") return text.indexOf("*/", i + 2) + 2;
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1;
    while (j < text.length && text[j] !== c) {
      if (text[j] === "\\") j++;
      j++;
    }
    return j + 1;
  }
  return i;
}

/**
 * The raw text that starts with `head` (which must occur exactly once and
 * end with the `{` that opens the block) through the matching `}`.
 */
function rawBlock(head: string): string {
  const found = SOURCE.split(head).length - 1;
  assert.equal(found, 1, `e2ee.ts must contain this exactly once: ${head}`);
  const start = SOURCE.indexOf(head);
  let depth = 0;
  for (let i = start + head.length - 1; i < SOURCE.length; i++) {
    const past = skipQuiet(SOURCE, i);
    if (past !== i) {
      i = past - 1;
    } else if (SOURCE[i] === "{") {
      depth++;
    } else if (SOURCE[i] === "}" && --depth === 0) {
      return SOURCE.slice(start, i + 1);
    }
  }
  assert.fail(`e2ee.ts: ${head} is never closed`);
}

/** `text` without comments, every run of whitespace as one space. */
function codeOf(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const past = skipQuiet(text, i);
    if (past === i) {
      out += c;
    } else {
      if (c !== "/") out += text.slice(i, past);
      else out += " ";
      i = past - 1;
    }
  }
  return out.replace(/\s+/g, " ");
}

/** The code of the one method that starts with `head`. */
function bodyOf(head: string): string {
  return codeOf(rawBlock(head));
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function at(body: string, needle: string): number {
  const index = body.indexOf(needle);
  assert.notEqual(index, -1, `missing: ${needle}`);
  return index;
}

const DM_SEND = `async handleDirectMessageSend(
    channel: Channel,
    data: E2EEDataMessageSend,
  ): Promise<Message | null> {`;
const GROUP_SEND = `async handleGroupMessageSend(
    channel: Channel,
    data: E2EEDataMessageSend,
  ): Promise<Message | null> {`;
const PREPARE = `async prepareDraftAttachments(
    channel: Channel,
    items: E2EEDraftFile[],
    options?: { textWentPlain?: boolean },
  ): Promise<string[] | null> {`;
const WILL_SPLIT = `willSplitFirstSend(
    channel: Channel,
    draft: { content?: string; files?: readonly unknown[] },
  ): boolean {`;

// ---- The stand-in class -----------------------------------------------------

type User = { id?: string; e2eeOnly?: boolean; e2eeEnabled?: boolean };
type Chan = {
  id: string;
  type: string;
  recipientIds: Set<string>;
  e2eeOnly: boolean;
  serverId?: string;
};
type Thrown = Error & { kind?: string; reason?: string };

interface Shim {
  status: Map<string, unknown>;
  sendModes: Map<string, string>;
  facts(channel: Chan): PlainWriteInput;
  refusePlain(channel: Chan): void;
  refuseExit(channel: Chan | undefined): void;
  note(channel: Chan, peerId?: string): void;
  deleted(userId: string): void;
  noDevice(peerId: string): void;
  devicesChanged(peerId: string): void;
  setDmMode(peerId: string, mode: string): void;
  encryptable(peerId: string, mode: string | undefined): boolean;
  willSplitFirstSend(
    channel: Chan,
    draft: { content?: string; files?: readonly unknown[] },
  ): boolean;
  peerEncryptedOnlyState(channel: Chan): string;
}

interface Cut {
  Shim: new (client: unknown) => Shim;
  E2EESendError: new (...args: never[]) => Error;
  E2EEEncryptedOnlyError: new (...args: never[]) => Error;
  E2EEPeerChangedError: new (...args: never[]) => Error;
  ENCRYPTED_ONLY_COPY: Record<string, string>;
}

let cut: Cut | undefined;

/** e2ee.ts's own classes and members, built once. Throws on the control. */
function load(): Cut {
  if (cut) return cut;

  // `E2EESendError` itself declares `kind` in its constructor's parameter
  // list, which Node cannot strip, so the stand-in below takes its place;
  // its kinds are pinned as text further down.
  const classes = [
    `const ENCRYPTED_ONLY_COPY: Record<BlockReason, string> = {`,
    `export class E2EEEncryptedOnlyError extends E2EESendError {`,
    `export class E2EEPeerChangedError extends E2EEEncryptedOnlyError {`,
  ]
    .map((head) => rawBlock(head).replace(/^export /, "") + ";")
    .join("\n");

  const members = [
    `#peerOf(channel: Channel): string | undefined {`,
    `#deviceReady(): boolean {`,
    `#latchAccount(): string | undefined {`,
    `#peerMustEncrypt(peerId: string): boolean {`,
    `#noteEncryptedOnly(channel: Channel, peerId?: string): void {`,
    `#onPeerDeleted(userId: string): void {`,
    `#noUsableDeviceKey(peerId: string): string | undefined {`,
    `#noteNoUsableDevice(peerId: string): void {`,
    `#forgetNoUsableDevice(peerId: string): void {`,
    `#setDmMode(peerId: string, mode: ComposerE2EEMode): void {`,
    `#plainFacts(channel: Channel): PlainWriteInput {`,
    `#refusePlainFallback(channel: Channel): void {`,
    `#refusePlaintextExit(channel: Channel | undefined): void {`,
    `#firstSendEncryptable(
    peerId: string,
    mode: ComposerE2EEMode | undefined,
  ): boolean {`,
    WILL_SPLIT,
    `peerEncryptedOnlyState(
    channel: Channel,
  ): "on" | "turned-off" | "remembered" | "none" {`,
  ]
    .map(rawBlock)
    .join("\n");

  const source = `class E2EESendError extends Error {
    constructor(message, kind) {
      super(message);
      this.kind = kind;
      this.name = "E2EESendError";
    }
  }
  ${classes}
  class Shim {
    status = new Map();
    sendModes = new Map();
    #client;
    #noUsableDevice = new Set();
    constructor(client) { this.#client = client; }
    facts(channel) { return this.#plainFacts(channel); }
    refusePlain(channel) { return this.#refusePlainFallback(channel); }
    refuseExit(channel) { return this.#refusePlaintextExit(channel); }
    note(channel, peerId) { return this.#noteEncryptedOnly(channel, peerId); }
    deleted(userId) { return this.#onPeerDeleted(userId); }
    noDevice(peerId) { return this.#noteNoUsableDevice(peerId); }
    devicesChanged(peerId) { return this.#forgetNoUsableDevice(peerId); }
    setDmMode(peerId, mode) { return this.#setDmMode(peerId, mode); }
    encryptable(peerId, mode) {
      return this.#firstSendEncryptable(peerId, mode);
    }
    ${members}
  }`;

  const js =
    stripTypeScriptTypes(source, { mode: "strip" }) +
    "\nreturn { Shim, E2EESendError, E2EEEncryptedOnlyError, E2EEPeerChangedError, ENCRYPTED_ONLY_COPY };";
  cut = new Function(
    "isSeen",
    "rememberSeen",
    "forgetSeen",
    "latchAccountId",
    "latchedForClient",
    "buildPlainWriteInput",
    "peerTurnedOff",
    "decidePlainWrite",
    "reasonFor",
    "ENCRYPTED_ONLY_BLOCKED_ERROR_NAME",
    js,
  )(
    isSeen,
    rememberSeen,
    forgetSeen,
    latchAccountId,
    latchedForClient,
    buildPlainWriteInput,
    peerTurnedOff,
    decidePlainWrite,
    reasonFor,
    ENCRYPTED_ONLY_BLOCKED_ERROR_NAME,
  ) as Cut;
  return cut;
}

const PEER = "01PEERAAAAAAAAAAAAAAAAAAAA";
const READY = { enabled: true, published: true, device_id: "d1" };

let accounts = 0;

/** A fresh account id. */
function account(): string {
  return `01SELF${String(++accounts).padStart(20, "0")}`;
}

/**
 * A bridge stand-in for a fresh account, with one known peer. No session
 * account is bound unless `session` is given.
 */
function world(
  peer: User = {},
  opts: { ready?: boolean; session?: string; readyId?: string | null } = {},
) {
  const me = opts.session ?? account();
  bindLatchAccount(opts.session);
  const readyId = opts.readyId === null ? undefined : (opts.readyId ?? me);
  const users = new Map<string, User>([[PEER, { id: PEER, ...peer }]]);
  const client: Record<string, unknown> = {
    user: readyId === undefined ? undefined : { id: readyId },
    users,
    channels: new Map(),
    configuration: undefined,
  };
  const shim = new (load().Shim)(client);
  // The guard reads the adapter's status and send modes off `client.e2ee`
  client.e2ee = shim;
  if (opts.ready !== false) shim.status.set("state", READY);
  const chan = (type: string, id: string, e2eeOnly = false): Chan => ({
    id,
    type,
    recipientIds: new Set(type === "SavedMessages" ? [me] : [me, PEER]),
    e2eeOnly,
    // A server's channel says so; the guard holds anything else as a DM
    ...(type === "TextChannel"
      ? { serverId: "01SERVERAAAAAAAAAAAAAAAAAA" }
      : {}),
  });
  return {
    me,
    readyId,
    client,
    shim,
    peer: users.get(PEER)!,
    dm: chan("DirectMessage", "01DMAAAAAAAAAAAAAAAAAAAAAA"),
    group: chan("Group", "01GROUPAAAAAAAAAAAAAAAAAAA"),
    saved: chan("SavedMessages", "01SAVEDAAAAAAAAAAAAAAAAAAA"),
    server: chan("TextChannel", "01TEXTAAAAAAAAAAAAAAAAAAAA"),
    chan,
  };
}

/** An update for the peer, as the guard reads it from the socket. */
function peerUpdate(w: ReturnType<typeof world>, e2eeOnly: boolean): void {
  noteEvent(w.client as never, {
    type: "UserUpdate",
    id: PEER,
    data: { e2ee_only: e2eeOnly },
  });
}

/** What `run` throws; fails when it returns. */
function thrownBy(run: () => void): Thrown {
  try {
    run();
  } catch (error) {
    return error as Thrown;
  }
  assert.fail("expected a throw, and the call returned");
}

/** Asserts a refusal of the Encrypted-only kind with this reason. */
function assertRefused(error: Thrown, reason: string): void {
  const { E2EESendError, E2EEEncryptedOnlyError } = load();
  assert.ok(error instanceof E2EEEncryptedOnlyError, String(error));
  assert.ok(error instanceof E2EESendError, "still a send error");
  assert.equal(error.name, "EncryptedOnlyBlockedError");
  assert.equal(error.reason, reason);
  assert.ok(error.message.length > 20, "says something to a person");
  // What the failed-message row stores
  assert.equal(describeSendError(error), `EncryptionRequired:${reason}`);
  if (reason !== "peer-changed") {
    assert.equal(encryptionRequiredSide(error), reason);
  }
}

/** Asserts the peer-changed refusal, never read as `recipient`. */
function assertPeerChanged(error: Thrown): void {
  assert.ok(error instanceof load().E2EEPeerChangedError, String(error));
  assert.equal(error.kind, "peer_changed");
  assertRefused(error, "peer-changed");
  assert.notEqual(describeSendError(error), "EncryptionRequired:recipient");
}

// ---- The decision, run from the real members --------------------------------

test("without the latch and with an ordinary peer or group, an unencrypted send is let through everywhere", () => {
  const w = world();
  assert.equal(latchedForClient(w.me), false);
  for (const channel of [w.dm, w.group, w.saved, w.server]) {
    assert.equal(w.shim.refusePlain(channel), undefined, channel.type);
  }
  const lonely = w.chan("DirectMessage", "01DMBBBBBBBBBBBBBBBBBBBBBB");
  lonely.recipientIds = new Set([w.me]);
  assert.equal(w.shim.refusePlain(lonely), undefined, "a DM with no peer");
});

test("under the latch an unencrypted DM or group send throws with reason sender, and the marker reads it", () => {
  const w = world();
  setLatch(w.me);
  assertRefused(
    thrownBy(() => w.shim.refusePlain(w.dm)),
    "sender",
  );
  assertRefused(
    thrownBy(() => w.shim.refusePlain(w.group)),
    "sender",
  );
  assert.equal(thrownBy(() => w.shim.refusePlain(w.dm)).kind, "encrypted_only");
});

test("under the latch Saved Notes and server channels are untouched", () => {
  const w = world();
  setLatch(w.me);
  assert.equal(w.shim.refusePlain(w.saved), undefined);
  assert.equal(w.shim.refusePlain(w.server), undefined);
});

test("under the latch a device that cannot encrypt is refused with reason setup", () => {
  const w = world({}, { ready: false });
  setLatch(w.me);
  assertRefused(
    thrownBy(() => w.shim.refusePlain(w.dm)),
    "setup",
  );
  w.shim.status.set("state", { ...READY, published: false });
  assertRefused(
    thrownBy(() => w.shim.refusePlain(w.group)),
    "setup",
  );
});

test("a peer whose flag is on is refused with reason recipient, without the latch and without the opt-in hint", () => {
  const w = world({ e2eeOnly: true, e2eeEnabled: false });
  assert.equal(w.shim.facts(w.dm).peerFlag, "on");
  assertRefused(
    thrownBy(() => w.shim.refusePlain(w.dm)),
    "recipient",
  );
});

test("a remembered peer whose flag is now missing gives the peer-changed refusal, never recipient", () => {
  const w = world({ e2eeOnly: true });
  assert.equal(isSeen(w.me, PEER), false);
  w.shim.note(w.dm, PEER);
  assert.equal(isSeen(w.me, PEER), true, "remembered");

  // The server stops sending the field: nothing said it was turned off
  w.peer.e2eeOnly = false;
  const facts = w.shim.facts(w.dm);
  assert.equal(facts.peerFlag, "absent");
  assert.equal(facts.peerRemembered, true);
  assertPeerChanged(thrownBy(() => w.shim.refusePlain(w.dm)));
  assert.equal(w.shim.peerEncryptedOnlyState(w.dm), "remembered");
});

test("a peer never seen with the flag is not remembered by a look", () => {
  const w = world({ e2eeOnly: false, e2eeEnabled: true });
  w.shim.note(w.dm, PEER);
  assert.equal(isSeen(w.me, PEER), false);
  assert.equal(w.shim.peerEncryptedOnlyState(w.dm), "none");
});

test("an explicit false gives the same refusal and the turned-off state, and a confirm lets one send through", () => {
  const w = world({ e2eeOnly: true });
  w.shim.note(w.dm, PEER);
  w.peer.e2eeOnly = false;
  peerUpdate(w, false);

  assert.equal(w.shim.facts(w.dm).peerFlag, "off");
  assert.equal(w.shim.peerEncryptedOnlyState(w.dm), "turned-off");
  assertPeerChanged(thrownBy(() => w.shim.refusePlain(w.dm)));

  confirmPeerChanged(PEER, w.readyId);
  assert.equal(isSeen(w.me, PEER), false, "forgotten");
  assert.equal(w.shim.peerEncryptedOnlyState(w.dm), "none");
  assert.equal(w.shim.refusePlain(w.dm), undefined);
});

test("the turned-off state needs an explicit false; the flag on again is on", () => {
  const w = world({ e2eeOnly: true });
  w.shim.note(w.dm, PEER);
  assert.equal(w.shim.peerEncryptedOnlyState(w.dm), "on");
  w.peer.e2eeOnly = false;
  assert.equal(w.shim.peerEncryptedOnlyState(w.dm), "remembered");
  peerUpdate(w, false);
  assert.equal(w.shim.peerEncryptedOnlyState(w.dm), "turned-off");
  w.peer.e2eeOnly = true;
  peerUpdate(w, true);
  assert.equal(w.shim.peerEncryptedOnlyState(w.dm), "on");
});

test("a deleted peer is forgotten, not turned off; the account itself is left alone", () => {
  const w = world({ e2eeOnly: true });
  w.shim.note(w.dm, PEER);
  rememberSeen(w.me, w.me);
  w.peer.e2eeOnly = false;
  w.shim.noDevice(PEER);

  w.shim.deleted(PEER);
  assert.equal(isSeen(w.me, PEER), false, "forgotten");
  assert.equal(w.shim.peerEncryptedOnlyState(w.dm), "none");
  assert.equal(w.shim.refusePlain(w.dm), undefined, "no confirmation asked");
  assert.equal(w.shim.facts(w.dm).peerFlag, "absent");

  w.shim.deleted(w.me);
  assert.equal(isSeen(w.me, w.me), true, "own id: nothing happens");
  forgetSeen(w.me, w.me);
});

test("under the latch a peer that turned the flag off is still refused as sender, never offered a confirmation", () => {
  const w = world({ e2eeOnly: true });
  w.shim.note(w.dm, PEER);
  w.peer.e2eeOnly = false;
  peerUpdate(w, false);
  setLatch(w.me);
  const error = thrownBy(() => w.shim.refusePlain(w.dm));
  assertRefused(error, "sender");
  assert.equal(error instanceof load().E2EEPeerChangedError, false);
});

test("a marked group is refused with reason group, is remembered, and stays refused once the mark is gone", () => {
  const w = world();
  const marked = w.chan("Group", "01GROUPBBBBBBBBBBBBBBBBBBB", true);
  assertRefused(
    thrownBy(() => w.shim.refusePlain(marked)),
    "group",
  );
  assert.equal(
    isSeen(w.me, marked.id),
    false,
    "a refusal alone remembers nothing",
  );
  w.shim.note(marked);
  assert.equal(isSeen(w.me, marked.id), true);

  marked.e2eeOnly = false;
  assertRefused(
    thrownBy(() => w.shim.refusePlain(marked)),
    "group",
  );
  // Another group is unaffected
  assert.equal(w.shim.refusePlain(w.group), undefined);
});

test("every decision is the policy module's, from the guard's one builder, for each channel kind, latch, peer and group state", () => {
  for (const latched of [false, true]) {
    for (const ready of [false, true]) {
      for (const peerState of ["plain", "on", "remembered"] as const) {
        for (const marked of [false, true]) {
          const w = world({ e2eeOnly: peerState === "on" }, { ready: ready });
          if (peerState === "remembered") rememberSeen(w.me, PEER);
          if (latched) setLatch(w.me);
          // A cached "encrypt" never makes an unencrypted write count as one
          w.shim.sendModes.set(PEER, "encrypt");
          const group = w.chan("Group", w.group.id, marked);
          w.shim.sendModes.set(group.id, "encrypt");
          for (const channel of [w.dm, group, w.saved, w.server]) {
            const facts = w.shim.facts(channel);
            assert.deepEqual(facts, {
              ...buildPlainWriteInput(w.client as never, channel as never),
              encrypted: false,
            });
            assert.equal(facts.latched, latched);
            assert.equal(facts.device, ready ? "ready" : "not-set-up");
            const decision = decidePlainWrite(facts);
            const label = `${channel.type} latched=${latched} ready=${ready} peer=${peerState} marked=${marked}`;
            if (decision === "allow-plain") {
              assert.equal(w.shim.refusePlain(channel), undefined, label);
            } else {
              const error = thrownBy(() => w.shim.refusePlain(channel));
              assert.equal(error.reason, reasonFor(decision, facts), label);
              assert.equal(
                error instanceof load().E2EEPeerChangedError,
                decision === "confirm-peer-changed",
                label,
              );
            }
          }
        }
      }
    }
  }
});

test("the latch and the memory are the stored session's account, whatever Ready says", () => {
  const session = account();
  const other = account();

  // Ready names nobody: the session account's latch still holds
  let w = world({}, { session, readyId: null });
  setLatch(session);
  assertRefused(
    thrownBy(() => w.shim.refusePlain(w.dm)),
    "sender",
  );
  assertRefused(
    thrownBy(() => w.shim.refuseExit(w.dm)),
    "sender",
  );

  // Ready names another account: still latched, memory on the session
  w = world({ e2eeOnly: true }, { session, readyId: other });
  assertRefused(
    thrownBy(() => w.shim.refusePlain(w.dm)),
    "sender",
  );
  w.shim.note(w.dm, PEER);
  assert.equal(isSeen(session, PEER), true);
  assert.equal(isSeen(other, PEER), false);

  // Nothing bound: the Ready account is used
  bindLatchAccount(undefined);
  w = world({ e2eeOnly: true });
  w.shim.note(w.dm, PEER);
  assert.equal(isSeen(w.me, PEER), true);
});

// ---- The three ways out of encryption ----------------------------------------

test("without the latch the downgrade guard does nothing; under it, it throws for a DM, a group and an unknown group", () => {
  const w = world();
  assert.equal(w.shim.refuseExit(w.dm), undefined);
  assert.equal(w.shim.refuseExit(w.group), undefined);
  assert.equal(w.shim.refuseExit(undefined), undefined);

  setLatch(w.me);
  assertRefused(
    thrownBy(() => w.shim.refuseExit(w.dm)),
    "sender",
  );
  assertRefused(
    thrownBy(() => w.shim.refuseExit(w.group)),
    "sender",
  );
  assertRefused(
    thrownBy(() => w.shim.refuseExit(undefined)),
    "sender",
  );
  assertRefused(
    thrownBy(() =>
      w.shim.refuseExit(w.chan("Group", "01GROUPCCCCCCCCCCCCCCCCCCC", true)),
    ),
    "group",
  );
});

test("source: downgrade, accepting a peer downgrade and acknowledging group plaintext run the guard before anything else, and each native command has one caller", () => {
  const downgrade = bodyOf(
    `async downgradeConversation(channel: Channel): Promise<void> {`,
  );
  assert.ok(
    downgrade.startsWith(
      `async downgradeConversation(channel: Channel): Promise<void> { this.#refusePlaintextExit(channel);`,
    ),
    "first statement of downgradeConversation",
  );

  const confirm = bodyOf(
    `async confirmPeerDowngrade(channel: Channel, accept: boolean): Promise<void> {`,
  );
  assert.ok(
    confirm.startsWith(
      `async confirmPeerDowngrade(channel: Channel, accept: boolean): Promise<void> { if (accept) this.#refusePlaintextExit(channel);`,
    ),
    "first statement of confirmPeerDowngrade, for accept only",
  );

  const acknowledge = bodyOf(`async acknowledgeGroupPlaintext(
    conversationId: string,
    expected: "unconfirmed" | "unestablished",
  ): Promise<void> {`);
  assert.ok(
    at(
      acknowledge,
      `this.#refusePlaintextExit(this.#groupChannel(conversationId));`,
    ) < at(acknowledge, `await`),
    "before the first await of acknowledgeGroupPlaintext",
  );

  const code = codeOf(SOURCE);
  for (const [command, owner] of [
    [`"e2ee_downgrade"`, downgrade],
    [`"e2ee_confirm_peer_downgrade"`, confirm],
    [`"e2ee_acknowledge_group_plaintext"`, acknowledge],
  ] as const) {
    const calls = code.match(
      new RegExp(`#invoke(<[^>(]*>)?\\(\\s*${command}`, "g"),
    );
    assert.equal(calls?.length, 1, `${command} is invoked from one place`);
    assert.equal(count(owner, command), 1, `${command}: in the guarded method`);
  }
});

// ---- The first message with files ---------------------------------------------

test("willSplitFirstSend is true exactly for a draft with files to a DM that a text message would encrypt", () => {
  const w = world({ e2eeEnabled: true });
  const files = { content: "hi", files: ["f1"] };
  w.shim.sendModes.set(PEER, "plaintext");

  assert.equal(w.shim.willSplitFirstSend(w.dm, files), true);
  assert.equal(
    w.shim.willSplitFirstSend(w.dm, { files: ["f1"] }),
    true,
    "no text: still true, the caller asks for a message",
  );

  assert.equal(w.shim.willSplitFirstSend(w.dm, { content: "hi" }), false);
  assert.equal(
    w.shim.willSplitFirstSend(w.dm, { content: "hi", files: [] }),
    false,
  );
  for (const other of [w.group, w.saved, w.server]) {
    assert.equal(w.shim.willSplitFirstSend(other, files), false, other.type);
  }

  for (const mode of ["encrypt", "blocked", "peer_downgraded"]) {
    w.shim.sendModes.set(PEER, mode);
    assert.equal(w.shim.willSplitFirstSend(w.dm, files), false, mode);
  }
  w.shim.sendModes.delete(PEER);
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), false, "mode unknown");
  w.shim.sendModes.set(PEER, "plaintext");

  w.shim.status.set("state", { ...READY, enabled: false });
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), false, "device off");
  w.shim.status.delete("state");
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), false, "no status");
  w.shim.status.set("state", READY);

  w.peer.e2eeEnabled = false;
  assert.equal(
    w.shim.willSplitFirstSend(w.dm, files),
    false,
    "peer has it off",
  );
});

test("willSplitFirstSend counts an Encrypted-only or remembered peer without the opt-in hint, and changes nothing", () => {
  const w = world({ e2eeOnly: true });
  const files = { content: "hi", files: ["f1"] };
  w.shim.sendModes.set(PEER, "plaintext");
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), true);
  assert.equal(isSeen(w.me, PEER), false, "a query remembers nothing");

  w.shim.note(w.dm, PEER);
  w.peer.e2eeOnly = false;
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), true, "remembered");
  assert.equal(w.shim.encryptable(PEER, "plaintext"), true);
  assert.equal(w.shim.encryptable(PEER, "encrypt"), false);
});

test("a peer an attempt found with no usable device: first sends in a row stay ordinary until its devices change or the chat is encrypted", () => {
  const w = world({ e2eeEnabled: true });
  const files = { content: "hi", files: ["f1"] };
  w.shim.sendModes.set(PEER, "plaintext");
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), true, "before");

  w.shim.noDevice(PEER);
  for (let send = 1; send <= 3; send++) {
    assert.equal(w.shim.willSplitFirstSend(w.dm, files), false, `send ${send}`);
    assert.equal(
      w.shim.willSplitFirstSend(w.dm, { files: ["f1"] }),
      false,
      `send ${send} without text: not asked for a message`,
    );
    assert.equal(w.shim.encryptable(PEER, "plaintext"), false);
  }

  // Per account: another account on this page is not affected
  bindLatchAccount(account());
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), true, "other account");
  bindLatchAccount(undefined);
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), false);

  // The peer's devices changed
  w.shim.devicesChanged(PEER);
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), true, "devices changed");

  // The chat read as encrypted, then plain again
  w.shim.noDevice(PEER);
  w.shim.setDmMode(PEER, "plaintext");
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), false, "still held");
  w.shim.setDmMode(PEER, "encrypt");
  assert.equal(w.shim.sendModes.get(PEER), "encrypt");
  w.shim.setDmMode(PEER, "plaintext");
  assert.equal(w.shim.willSplitFirstSend(w.dm, files), true, "after encrypt");

  // A refusal for an Encrypted-only account is unchanged by the note
  w.shim.noDevice(PEER);
  setLatch(w.me);
  assertRefused(
    thrownBy(() => w.shim.refusePlain(w.dm)),
    "sender",
  );
});

test("source: prepareDraftAttachments refuses before every return that hands files to plain storage, and asks for text only when no text went plain", () => {
  const body = bodyOf(PREPARE);
  assert.equal(count(body, `return null`), 3, "three returns of null");

  // Not a DM or a group: Saved Notes and servers, untouched
  assert.equal(
    count(
      body,
      `if (channel.type !== "DirectMessage" && !isGroup) return null;`,
    ),
    1,
  );
  // No peer: refused when there are files
  assert.equal(
    count(
      body,
      `if (!conversationId) { if (items.length) this.#refusePlainFallback(channel); return null; }`,
    ),
    1,
  );
  // An unencrypted verdict with files: the first-file rule (skipped when
  // the caller says its text went plain), then the policy, then the null
  const gate = `if (mode === "plaintext" && items.length) { if ( !isGroup && options?.textWentPlain !== true && this.#firstSendEncryptable(conversationId, mode) ) { throw new E2EESendError( "Add a message to send with your first file.", "first_file", ); } this.#refusePlainFallback(channel); } if (mode === "plaintext" || !items.length) return null;`;
  assert.equal(count(body, gate), 1, "the gate sits directly on the return");
  assert.ok(
    at(body, gate) < at(body, `"e2ee_attachment_recipients"`),
    "before anything is encrypted or uploaded",
  );
  assert.equal(
    count(
      body,
      `this.#noteEncryptedOnly(channel, isGroup ? undefined : conversationId);`,
    ),
    1,
    "a flagged peer or group is remembered here",
  );
  assert.equal(count(codeOf(SOURCE), `#firstSendFellBack`), 0, "no page set");
});

test("source: the DM send refuses before each of its three unencrypted returns, and notes a peer found with no usable device", () => {
  const body = bodyOf(DM_SEND);
  assert.equal(count(body, `return null`), 3, "three returns of null");
  for (const exit of [
    // No peer
    `this.#refusePlainFallback(channel); return null; } this.#noteEncryptedOnly(channel, peerId);`,
    // No attempt to encrypt
    `if (!(await this.#shouldInitiate(peerId, data))) { this.#refusePlainFallback(channel); return null; } opportunistic = true;`,
    // The attempt found no usable device
    `if (!result) { this.#noteNoUsableDevice(peerId); this.#refusePlainFallback(channel); return null; }`,
    // Its verdict is cached through the one writer that ends the note
    `this.#setDmMode(peerId, this.#composerMode(verdict));`,
  ]) {
    assert.equal(count(body, exit), 1, exit);
  }

  const code = codeOf(SOURCE);
  // One writer of the note; the readers and clearers are all known
  assert.equal(count(code, `this.#noteNoUsableDevice(`), 1);
  assert.equal(count(code, `this.#noUsableDevice.add(`), 1);
  assert.equal(count(code, `this.#noUsableDevice.clear();`), 2);
  assert.equal(
    count(
      bodyOf(`async #wipeLocalStore(): Promise<void> {`),
      `this.#noUsableDevice.clear();`,
    ),
    1,
    "cleared on a wipe",
  );
  assert.ok(
    codeOf(rawBlock(`client.on("ready", () => {`)).includes(
      `this.#noUsableDevice.clear();`,
    ),
    "cleared on ready",
  );
  assert.equal(count(code, `this.#forgetNoUsableDevice(event.user_id);`), 2);
  assert.equal(
    count(
      code,
      `} else { this.#forgetNoUsableDevice(event.user_id); void this.#onDeviceCreate(event.user_id); }`,
    ),
    1,
    "a peer's new device",
  );
  assert.equal(
    count(
      code,
      `case "E2EEDeviceDelete": this.#forgetNoUsableDevice(event.user_id);`,
    ),
    1,
    "a deleted device",
  );
  // Every direct message mode write goes through `#setDmMode`
  assert.equal(count(code, `this.#setDmMode(`), 5);
  assert.equal(count(code, `this.sendModes.set(`), 2, "setDmMode + groups");
});

test("source: the group send refuses before its unencrypted return; the latch, memory and facts come from the shared modules", () => {
  const body = bodyOf(GROUP_SEND);
  assert.equal(count(body, `return null`), 2, "two returns of null");
  assert.equal(count(body, `if (channel.type !== "Group") return null;`), 1);
  assert.equal(
    count(body, `this.#refusePlainFallback(channel); return null; }`),
    1,
  );
  assert.equal(count(body, `this.#noteEncryptedOnly(channel);`), 1);

  const initiate = bodyOf(`async #shouldInitiate(
    peerId: string,
    data: { attachments?: string[] | null },
  ): Promise<boolean> {`);
  assert.equal(
    count(
      initiate,
      `if ( !this.#client.users.get(peerId)?.e2eeEnabled && !this.#peerMustEncrypt(peerId) ) { return false; }`,
    ),
    1,
  );
  assert.equal(
    count(initiate, `?.e2eeEnabled) return false;`),
    0,
    "the hint alone no longer decides",
  );

  // The kinds the composer and the draft path tell these refusals by
  const sendError = bodyOf(`export class E2EESendError extends Error {`);
  for (const kind of [`"encrypted_only"`, `"peer_changed"`, `"first_file"`]) {
    assert.equal(count(sendError, `| ${kind}`), 1, kind);
  }

  const code = codeOf(SOURCE);
  // A deleted account's update forgets the peer; no other update handler
  assert.equal(
    count(
      code,
      `client.on("userUpdate", (user) => { if ((user.flags & UserFlags.Deleted) === UserFlags.Deleted) { this.#onPeerDeleted(user.id); } });`,
    ),
    1,
  );
  assert.equal(count(code, `client.on("userUpdate"`), 1);
  assert.equal(count(code, `this.#onPeerDeleted(`), 1);
  // The latch is the client's (session or Ready account), the memory the
  // latch account's, the facts the guard module's
  assert.equal(count(code, `isLatched(`), 0);
  assert.equal(count(code, `latchedForClient(this.#client.user?.id)`), 1);
  assert.equal(count(code, `latchAccountId(this.#client.user?.id)`), 1);
  assert.equal(count(code, `buildPlainWriteInput(this.#client, channel)`), 1);
  assert.equal(count(code, `#plainWriteFacts`), 0);
  assert.equal(count(code, `#peerTurnedOff`), 0);
  for (const call of [`isSeen(`, `rememberSeen(`, `forgetSeen(`]) {
    for (const index of code.split(call).slice(1).keys()) {
      const after = code.split(call)[index + 1];
      assert.ok(
        after.startsWith("this.#latchAccount(),") ||
          after.startsWith("account,"),
        `${call} reads the latch account (${call}${after.slice(0, 30)})`,
      );
    }
  }
});

test("the English of each refusal is the translated copy in errors.ts", () => {
  const { ENCRYPTED_ONLY_COPY } = load();
  assert.deepEqual(Object.keys(ENCRYPTED_ONLY_COPY).sort(), [
    "group",
    "open-app",
    "peer-changed",
    "recipient",
    "sender",
    "setup",
  ]);
  for (const [reason, english] of Object.entries(ENCRYPTED_ONLY_COPY)) {
    assert.equal(
      count(ERRORS_SOURCE, `t\`${english}\``),
      1,
      `${reason}: errors.ts translates "${english}"`,
    );
  }
  assert.equal(
    ENCRYPTED_ONLY_COPY["peer-changed"],
    "This person may no longer use Encrypted-only chats. If you send anyway, your message may not be encrypted.",
  );
  assert.equal(
    ENCRYPTED_ONLY_COPY.group,
    "This group is encrypted. Send from a device where encryption is set up.",
  );
  assert.equal(
    count(ERRORS_SOURCE, "t`Add a message to send with your first file.`"),
    1,
  );
  assert.equal(
    count(SOURCE, `"Add a message to send with your first file."`),
    1,
  );
  assert.equal(count(SOURCE, "turned off Encrypted-only"), 0);
});
