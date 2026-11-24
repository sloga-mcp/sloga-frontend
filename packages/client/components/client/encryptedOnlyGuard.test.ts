// Unit spec for the Encrypted-only plain write guard. Run with Node's
// built-in runner from packages/client:
//   node --test --conditions=browser components/client/encryptedOnlyGuard.test.ts
// Declared test count: 27 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: the policy input is gathered correctly from a client for direct
// messages, groups, Saved Notes and server channels; the guard throws
// `EncryptedOnlyBlockedError` with the policy's reason for every blocked
// kind and stays silent where a plain write is allowed; the server saying
// "on" sets the latch and "off" leaves it; peers and groups seen with the
// flag are remembered, on `ready`, per event and at write time.
//
// The latch module keeps state per account for the life of the process, so
// every test signs in as a new account id over an emptied fake storage.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { Channel, Client, PlainWriteKind } from "stoat.js";
import { EncryptedOnlyBlockedError } from "stoat.js";

import { encryptionRequiredSide } from "./apiErrorType.ts";
import {
  advertOf,
  buildPlainWriteInput,
  channelKindOf,
  checkPlainWrite,
  deviceStateOf,
  dmPeerId,
  installPlainWriteGuard,
  noteEvent,
  peerTurnedOff,
  syncOnReady,
} from "./encryptedOnlyGuard.ts";
import {
  bindLatchAccount,
  confirmPeerChanged,
  isLatched,
  isSeen,
  rememberSeen,
  seenIds,
  setLatch,
} from "./encryptedOnlyLatch.ts";
import { NON_SEND_KINDS } from "./encryptedOnlyPolicy.ts";

const PEER = "01PEERAAAAAAAAAAAAAAAAAAAA";
const PEER2 = "01PEERBBBBBBBBBBBBBBBBBBBB";
const DM = "01DMAAAAAAAAAAAAAAAAAAAAAA";
const GROUP = "01GROUPAAAAAAAAAAAAAAAAAAA";
const SAVED = "01SAVEDAAAAAAAAAAAAAAAAAAA";
const TEXT = "01TEXTAAAAAAAAAAAAAAAAAAAA";
const SERVER = "01SERVERAAAAAAAAAAAAAAAAAA";

const ALL_KINDS: PlainWriteKind[] = ["send", ...NON_SEND_KINDS];

const items = new Map<string, string>();

beforeEach(() => {
  items.clear();
  bindLatchAccount(undefined);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
  });
});

let accounts = 0;

/** A new account id, so no latch state carries over between tests. */
function newAccount(): string {
  accounts += 1;
  return `01ME${String(accounts).padStart(22, "0")}`;
}

type FakeUser = { id: string; e2eeOnly: boolean; flags?: number };
type FakeChannel = {
  id: string;
  type: string;
  serverId?: string;
  recipientIds?: Set<string>;
  e2eeOnly: boolean;
};
type Listener = (...args: unknown[]) => void;

type Fake = {
  client: Client;
  me: string;
  users: Map<string, FakeUser>;
  channels: Map<string, FakeChannel>;
  /** Fire the client's `ready` */
  ready(): void;
  /** Deliver one socket event */
  event(event: unknown): void;
  /** Number of listeners per name */
  listeners: { ready: Listener[]; event: Listener[] };
  dm: Channel;
  group: Channel;
  saved: Channel;
  text: Channel;
};

/** An app's encryption adapter, as far as the guard reads it. */
function bridge(
  status:
    | { enabled: boolean; published: boolean; device_id?: string | null }
    | undefined,
  modes: Record<string, string> = {},
) {
  return {
    status: new Map(status ? [["state", status]] : []),
    sendModes: new Map(Object.entries(modes)),
  };
}

const READY = { enabled: true, published: true, device_id: "01DEVICE" };

function fake(
  options: {
    own?: boolean;
    peer?: boolean;
    groupMarked?: boolean;
    e2ee?: unknown;
    only?: unknown;
  } = {},
): Fake {
  const me = newAccount();
  const users = new Map<string, FakeUser>([
    [me, { id: me, e2eeOnly: options.own === true }],
    [PEER, { id: PEER, e2eeOnly: options.peer === true }],
  ]);
  const channels = new Map<string, FakeChannel>([
    [
      DM,
      {
        id: DM,
        type: "DirectMessage",
        recipientIds: new Set([me, PEER]),
        e2eeOnly: false,
      },
    ],
    [
      GROUP,
      {
        id: GROUP,
        type: "Group",
        recipientIds: new Set([me, PEER, PEER2]),
        e2eeOnly: options.groupMarked === true,
      },
    ],
    [SAVED, { id: SAVED, type: "SavedMessages", e2eeOnly: false }],
    [
      TEXT,
      { id: TEXT, type: "TextChannel", serverId: SERVER, e2eeOnly: false },
    ],
  ]);

  const listeners = { ready: [] as Listener[], event: [] as Listener[] };
  const drop = (list: Listener[], listener: Listener) => {
    const at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
  };
  const client = {
    user: users.get(me),
    users,
    channels,
    configuration: {
      features:
        options.only === undefined ? {} : { e2ee: { only: options.only } },
    },
    e2ee: options.e2ee,
    plainWriteGuard: undefined,
    on(name: string, listener: Listener) {
      if (name === "ready") listeners.ready.push(listener);
    },
    off(name: string, listener: Listener) {
      if (name === "ready") drop(listeners.ready, listener);
    },
    events: {
      on(name: string, listener: Listener) {
        if (name === "event") listeners.event.push(listener);
      },
      off(name: string, listener: Listener) {
        if (name === "event") drop(listeners.event, listener);
      },
    },
  };

  return {
    client: client as unknown as Client,
    me,
    users,
    channels,
    listeners,
    ready: () => listeners.ready.forEach((listener) => listener()),
    event: (event) => listeners.event.forEach((listener) => listener(event)),
    dm: channels.get(DM) as unknown as Channel,
    group: channels.get(GROUP) as unknown as Channel,
    saved: channels.get(SAVED) as unknown as Channel,
    text: channels.get(TEXT) as unknown as Channel,
  };
}

/** The reason the guard refuses with, or `null` when it lets the write by. */
function refusal(
  f: Fake,
  channel: Channel,
  kind: PlainWriteKind,
): string | null {
  try {
    checkPlainWrite(f.client, channel, kind);
    return null;
  } catch (error) {
    assert.ok(
      error instanceof EncryptedOnlyBlockedError,
      `threw something else: ${String(error)}`,
    );
    return error.reason;
  }
}

/** Assert one outcome for every kind of write into a channel. */
function allKinds(f: Fake, channel: Channel, expected: string | null): void {
  for (const kind of ALL_KINDS) {
    assert.equal(refusal(f, channel, kind), expected, `kind ${kind}`);
  }
}

// ---------------------------------------------------------------------------
// Gathering the input
// ---------------------------------------------------------------------------

test("a plain direct message on the website gathers the defaults", () => {
  const f = fake();
  assert.deepEqual(buildPlainWriteInput(f.client, f.dm), {
    latched: false,
    channel: "dm",
    peerFlag: "absent",
    peerRemembered: false,
    groupMarked: false,
    groupRemembered: false,
    device: "web",
    encrypted: false,
    advert: "absent",
  });
});

test("a direct message reads the peer flag, the latch, the device and the verdict by peer id", () => {
  const f = fake({
    peer: true,
    e2ee: bridge(READY, { [PEER]: "encrypt", [DM]: "plaintext" }),
    only: { available: true, enforced: true },
  });
  setLatch(f.me);

  assert.deepEqual(buildPlainWriteInput(f.client, f.dm), {
    latched: true,
    channel: "dm",
    peerFlag: "on",
    peerRemembered: false,
    groupMarked: false,
    groupRemembered: false,
    device: "ready",
    encrypted: true,
    advert: "enforced",
  });
  assert.equal(dmPeerId(f.client, f.dm), PEER);
});

test("a group reads its mark and the verdict by channel id, never a member's flag", () => {
  const f = fake({
    peer: true,
    groupMarked: true,
    e2ee: bridge(READY, { [GROUP]: "encrypt", [PEER]: "plaintext" }),
    only: { available: true, enforced: false },
  });

  assert.deepEqual(buildPlainWriteInput(f.client, f.group), {
    latched: false,
    channel: "group",
    peerFlag: "absent",
    peerRemembered: false,
    groupMarked: true,
    groupRemembered: false,
    device: "ready",
    encrypted: true,
    advert: "not-enforced",
  });
  assert.equal(dmPeerId(f.client, f.group), undefined);
});

test("only the send mode encrypt counts as an encrypted verdict", () => {
  const modes = ["plaintext", "blocked", "peer_downgraded", "unconfirmed"];
  for (const mode of modes) {
    const f = fake({ e2ee: bridge(READY, { [PEER]: mode, [GROUP]: mode }) });
    const dm = buildPlainWriteInput(f.client, f.dm);
    const group = buildPlainWriteInput(f.client, f.group);
    assert.equal(dm.encrypted, false, mode);
    assert.equal(group.encrypted, false, mode);
  }

  const unknown = fake({ e2ee: bridge(READY) });
  const input = buildPlainWriteInput(unknown.client, unknown.dm);
  assert.equal(input.encrypted, false);
});

test("Saved Notes and server channels get their own kinds; an unknown channel outside a server is held as a direct message", () => {
  const f = fake({ groupMarked: true });
  assert.equal(channelKindOf(f.saved), "saved");
  assert.equal(channelKindOf(f.text), "server");
  assert.equal(channelKindOf(f.dm), "dm");
  assert.equal(channelKindOf(f.group), "group");

  for (const type of ["VoiceChannel", "Thread", "Forum"]) {
    assert.equal(
      channelKindOf({ id: "x", type, serverId: SERVER } as never),
      "server",
      type,
    );
  }
  assert.equal(channelKindOf({ id: "x", type: undefined } as never), "dm");

  // The mark and the memory are a group's only, even if another channel
  // came with the field or shares a remembered id
  f.channels.get(TEXT)!.e2eeOnly = true;
  f.channels.get(DM)!.e2eeOnly = true;
  items.set(`e2ee-only-seen:${f.me}`, JSON.stringify([TEXT, DM]));
  assert.equal(buildPlainWriteInput(f.client, f.dm).groupMarked, false);
  assert.equal(buildPlainWriteInput(f.client, f.dm).groupRemembered, false);
  const input = buildPlainWriteInput(f.client, f.text);
  assert.equal(input.channel, "server");
  assert.equal(input.groupMarked, false);
  assert.equal(input.groupRemembered, false);
});

test("the device is the website without an adapter, not set up until enabled, published and with a device id", () => {
  const device = (e2ee: unknown) => deviceStateOf(fake({ e2ee }).client);

  // The bridge's own rule: no device id, not ready
  for (const device_id of [undefined, null, ""]) {
    assert.equal(
      device(bridge({ enabled: true, published: true, device_id })),
      "not-set-up",
      String(device_id),
    );
  }

  assert.equal(device(undefined), "web");
  assert.equal(device(bridge(undefined)), "not-set-up");
  assert.equal(
    device(bridge({ enabled: false, published: false })),
    "not-set-up",
  );
  assert.equal(
    device(bridge({ enabled: true, published: false })),
    "not-set-up",
  );
  assert.equal(
    device(bridge({ enabled: false, published: true })),
    "not-set-up",
  );
  assert.equal(device(bridge(READY)), "ready");
});

test("the advert reads absent, enforced or not enforced", () => {
  assert.equal(advertOf(fake().client), "absent");
  assert.equal(advertOf(fake({ only: null }).client), "absent");
  assert.equal(
    advertOf(fake({ only: { available: false, enforced: true } }).client),
    "enforced",
  );
  assert.equal(
    advertOf(fake({ only: { available: true, enforced: false } }).client),
    "not-enforced",
  );
  assert.equal(advertOf({ configuration: undefined } as never), "absent");
});

test("a remembered peer and a remembered group are read from this account's memory only", () => {
  const f = fake();
  const other = fake();
  // Same peer and group ids, remembered by another account on this device
  items.set(`e2ee-only-seen:${other.me}`, JSON.stringify([PEER, GROUP]));

  assert.equal(buildPlainWriteInput(f.client, f.dm).peerRemembered, false);
  assert.equal(buildPlainWriteInput(f.client, f.group).groupRemembered, false);

  items.set(`e2ee-only-seen:${f.me}`, JSON.stringify([PEER, GROUP]));
  const dm = buildPlainWriteInput(f.client, f.dm);
  assert.equal(dm.peerRemembered, true);
  assert.equal(dm.peerFlag, "absent");
  assert.equal(dm.groupRemembered, false);

  const group = buildPlainWriteInput(f.client, f.group);
  assert.equal(group.groupRemembered, true);
  assert.equal(group.groupMarked, false);
  assert.equal(group.peerRemembered, false);
});

test("only an update that says false makes the peer flag off", () => {
  const f = fake({ peer: true });
  installPlainWriteGuard(f.client);

  // A full object without the field says nothing
  f.users.get(PEER)!.e2eeOnly = false;
  f.event({ type: "UserRelationship", user: { _id: PEER }, status: "Friend" });
  f.event({ type: "UserUpdate", id: PEER, data: { online: true } });
  f.event({ type: "UserRelationship", user: { _id: PEER, e2ee_only: false } });
  assert.equal(buildPlainWriteInput(f.client, f.dm).peerFlag, "absent");
  assert.equal(peerTurnedOff(f.client, PEER), false);

  f.event({ type: "UserUpdate", id: PEER, data: { e2ee_only: false } });
  assert.equal(buildPlainWriteInput(f.client, f.dm).peerFlag, "off");
  assert.equal(peerTurnedOff(f.client, PEER), true);

  // Turned back on: the cached flag wins and the "off" is dropped
  f.event({ type: "UserUpdate", id: PEER, data: { e2ee_only: true } });
  assert.equal(peerTurnedOff(f.client, PEER), false);
  f.users.get(PEER)!.e2eeOnly = true;
  assert.equal(buildPlainWriteInput(f.client, f.dm).peerFlag, "on");
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test("with nothing set every kind of write passes everywhere", () => {
  for (const e2ee of [undefined, bridge(undefined), bridge(READY)]) {
    const f = fake({ e2ee });
    for (const channel of [f.dm, f.group, f.saved, f.text]) {
      allKinds(f, channel, null);
    }
    assert.deepEqual(seenIds(f.me), []);
    assert.equal(isLatched(f.me), false);
  }
});

test("under the latch the website is told to open the app, for every kind", () => {
  const f = fake();
  setLatch(f.me);
  allKinds(f, f.dm, "open-app");
  allKinds(f, f.group, "open-app");
  allKinds(f, f.saved, null);
  allKinds(f, f.text, null);
});

test("under the latch a device without encryption is told to set it up", () => {
  for (const status of [undefined, { enabled: true, published: false }]) {
    const f = fake({ e2ee: bridge(status) });
    setLatch(f.me);
    allKinds(f, f.dm, "setup");
    allKinds(f, f.group, "setup");
    allKinds(f, f.saved, null);
    allKinds(f, f.text, null);
  }
});

test("under the latch a ready device refuses with sender, and a marked group with group", () => {
  const f = fake({ e2ee: bridge(READY) });
  setLatch(f.me);
  allKinds(f, f.dm, "sender");
  allKinds(f, f.group, "sender");

  const marked = fake({ e2ee: bridge(READY), groupMarked: true });
  setLatch(marked.me);
  allKinds(marked, marked.group, "group");
  allKinds(marked, marked.dm, "sender");
});

test("without the latch a flagged peer refuses with recipient and a marked group with group", () => {
  for (const e2ee of [undefined, bridge(READY)]) {
    const f = fake({ peer: true, groupMarked: true, e2ee });
    allKinds(f, f.dm, "recipient");
    allKinds(f, f.group, "group");
    allKinds(f, f.saved, null);
    allKinds(f, f.text, null);
    assert.equal(isLatched(f.me), false);
  }

  // A flagged member does not make an unmarked group refuse
  const unmarked = fake({ peer: true });
  allKinds(unmarked, unmarked.group, null);
});

test("an encrypted verdict never lets an unencrypted write through", () => {
  const f = fake({
    peer: true,
    groupMarked: true,
    e2ee: bridge(READY, { [PEER]: "encrypt", [GROUP]: "encrypt" }),
  });
  allKinds(f, f.dm, "recipient");
  allKinds(f, f.group, "group");

  setLatch(f.me);
  allKinds(f, f.dm, "sender");
});

test("a remembered peer or group keeps refusing after the flag is gone", () => {
  const f = fake({ peer: true, groupMarked: true });
  installPlainWriteGuard(f.client);
  f.ready();
  assert.equal(isSeen(f.me, PEER), true);
  assert.equal(isSeen(f.me, GROUP), true);

  // The server stops stating either flag: the peer waits for the user's
  // confirmation, never as a plain recipient refusal
  f.users.get(PEER)!.e2eeOnly = false;
  f.channels.get(GROUP)!.e2eeOnly = false;
  allKinds(f, f.dm, "peer-changed");
  allKinds(f, f.group, "group");

  // An explicit "off" asks the same way
  f.event({ type: "UserUpdate", id: PEER, data: { e2ee_only: false } });
  allKinds(f, f.dm, "peer-changed");

  // Confirming on the website forgets the peer: the next send is ordinary
  confirmPeerChanged(PEER, f.me);
  assert.equal(isSeen(f.me, PEER), false);
  allKinds(f, f.dm, null);
  allKinds(f, f.group, "group");

  // Back on: remembered again at the next write
  f.users.get(PEER)!.e2eeOnly = true;
  allKinds(f, f.dm, "recipient");
  assert.equal(isSeen(f.me, PEER), true);
});

test("a deleted account's update forgets the peer and never reads as turned off", () => {
  const f = fake({ peer: true });
  installPlainWriteGuard(f.client);
  f.ready();
  assert.equal(isSeen(f.me, PEER), true);

  // Deletion clears the flag in the same update
  f.users.get(PEER)!.e2eeOnly = false;
  f.event({
    type: "UserUpdate",
    id: PEER,
    data: { flags: 2, e2ee_only: false },
  });
  assert.equal(peerTurnedOff(f.client, PEER), false);
  assert.equal(isSeen(f.me, PEER), false);
  assert.equal(buildPlainWriteInput(f.client, f.dm).peerFlag, "absent");

  // The cache already holds the deletion and the flag comes on its own
  const g = fake({ peer: true });
  installPlainWriteGuard(g.client);
  g.ready();
  g.users.get(PEER)!.e2eeOnly = false;
  g.users.get(PEER)!.flags = 2 | 4;
  g.event({ type: "UserUpdate", id: PEER, data: { e2ee_only: false } });
  assert.equal(peerTurnedOff(g.client, PEER), false);
  assert.equal(isSeen(g.me, PEER), false);

  // An already turned off peer that is then deleted loses the "off"
  const h = fake({ peer: true });
  installPlainWriteGuard(h.client);
  h.ready();
  h.event({ type: "UserUpdate", id: PEER, data: { e2ee_only: false } });
  assert.equal(peerTurnedOff(h.client, PEER), true);
  h.event({ type: "UserRelationship", user: { _id: PEER, flags: 2 } });
  assert.equal(peerTurnedOff(h.client, PEER), false);
  assert.equal(isSeen(h.me, PEER), false);

  // Other flags are not a deletion
  const s = fake({ peer: true });
  installPlainWriteGuard(s.client);
  s.ready();
  s.event({ type: "UserUpdate", id: PEER, data: { flags: 1 | 4 } });
  s.event({ type: "UserUpdate", id: PEER, data: { e2ee_only: false } });
  assert.equal(peerTurnedOff(s.client, PEER), true);
  assert.equal(isSeen(s.me, PEER), true);
});

test("the bound session account keeps the client latched when Ready names no one or someone else", () => {
  for (const readyUser of [undefined, { id: PEER2, e2eeOnly: false }]) {
    const f = fake({ e2ee: bridge(READY) });
    setLatch(f.me);
    bindLatchAccount(f.me);
    (f.client as { user?: unknown }).user = readyUser;

    // The session account is never taken for the peer
    assert.equal(dmPeerId(f.client, f.dm), PEER);
    const input = buildPlainWriteInput(f.client, f.dm);
    assert.equal(input.latched, true);
    allKinds(f, f.dm, "sender");
    allKinds(f, f.saved, null);
  }

  // Memory is read and written under the session account
  const g = fake({ peer: true });
  bindLatchAccount(g.me);
  (g.client as { user?: unknown }).user = { id: PEER2, e2eeOnly: false };
  assert.equal(refusal(g, g.dm, "send"), "recipient");
  assert.deepEqual(seenIds(g.me), [PEER]);
  assert.deepEqual(seenIds(PEER2), []);

  rememberSeen(g.me, GROUP);
  assert.equal(buildPlainWriteInput(g.client, g.group).groupRemembered, true);

  // Unbound, the Ready account is the one read
  bindLatchAccount(undefined);
  assert.equal(buildPlainWriteInput(g.client, g.group).groupRemembered, false);
});

test("uninstalling removes both listeners and keeps the guard on the client", () => {
  const f = fake({ own: true, peer: true });
  const uninstall = installPlainWriteGuard(f.client);
  assert.equal(typeof uninstall, "function");
  uninstall();

  assert.equal(f.listeners.ready.length, 0);
  assert.equal(f.listeners.event.length, 0);
  f.ready();
  f.event({ type: "UserUpdate", id: PEER2, data: { e2ee_only: true } });
  assert.equal(isLatched(f.me), false);
  assert.deepEqual(seenIds(f.me), []);

  // A late write from the replaced client is still checked
  assert.equal(typeof f.client.plainWriteGuard, "function");
  assert.throws(
    () => f.client.plainWriteGuard!(f.dm, "send"),
    EncryptedOnlyBlockedError,
  );
});

test("the refusal is the SDK's error and reads as an encryption refusal", () => {
  const f = fake({ peer: true });
  installPlainWriteGuard(f.client);
  const guard = f.client.plainWriteGuard;
  assert.equal(typeof guard, "function");

  assert.throws(
    () => guard!(f.dm, "upload"),
    (error: unknown) => {
      assert.ok(error instanceof EncryptedOnlyBlockedError);
      assert.equal(error.name, "EncryptedOnlyBlockedError");
      assert.equal(error.reason, "recipient");
      assert.equal(encryptionRequiredSide(error), "recipient");
      return true;
    },
  );
  assert.doesNotThrow(() => guard!(f.text, "upload"));
  assert.doesNotThrow(() => guard!(f.saved, "send"));
});

// ---------------------------------------------------------------------------
// Feeding the latch and the memory
// ---------------------------------------------------------------------------

test("installing registers one ready listener and one event listener and nothing else", () => {
  const f = fake({ own: true, peer: true });
  installPlainWriteGuard(f.client);
  assert.equal(f.listeners.ready.length, 1);
  assert.equal(f.listeners.event.length, 1);

  // Nothing is read or written before the first ready
  assert.equal(isLatched(f.me), false);
  assert.deepEqual(seenIds(f.me), []);
  assert.equal(items.size, 0);
});

test("the server saying on at ready sets the latch", () => {
  const f = fake({ own: true });
  installPlainWriteGuard(f.client);
  assert.equal(isLatched(f.me), false);

  f.ready();
  assert.equal(isLatched(f.me), true);
  assert.equal(items.get(`e2ee-only:${f.me}`), "1");
  allKinds(f, f.dm, "open-app");
});

test("the server saying off, or nothing, never clears the latch", () => {
  const f = fake({ own: false });
  installPlainWriteGuard(f.client);
  setLatch(f.me);

  f.ready();
  assert.equal(isLatched(f.me), true);

  f.event({ type: "UserUpdate", id: f.me, data: { e2ee_only: false } });
  f.event({ type: "UserUpdate", id: f.me, data: { online: true } });
  f.ready();
  assert.equal(isLatched(f.me), true);
  assert.equal(items.get(`e2ee-only:${f.me}`), "1");

  // A write re-reads the cached flag too, and that does not clear it either
  allKinds(f, f.dm, "open-app");
  assert.equal(isLatched(f.me), true);
});

test("an update turning this account's flag on sets the latch, and so does the cached flag at write time", () => {
  const f = fake();
  installPlainWriteGuard(f.client);
  f.ready();
  assert.equal(isLatched(f.me), false);

  f.event({ type: "UserUpdate", id: f.me, data: { e2ee_only: true } });
  assert.equal(isLatched(f.me), true);
  // The own account is never remembered as a peer
  assert.deepEqual(seenIds(f.me), []);

  // No event at all: the flag only landed in the cache
  const quiet = fake();
  installPlainWriteGuard(quiet.client);
  quiet.users.get(quiet.me)!.e2eeOnly = true;
  assert.equal(refusal(quiet, quiet.dm, "send"), "open-app");
  assert.equal(isLatched(quiet.me), true);
});

test("ready remembers flagged users and marked groups in one pass, and nothing else", () => {
  const f = fake({ own: true, peer: true, groupMarked: true });
  f.users.set(PEER2, { id: PEER2, e2eeOnly: false });
  // A flag on anything but a group is not a mark
  f.channels.get(TEXT)!.e2eeOnly = true;
  f.channels.get(DM)!.e2eeOnly = true;

  syncOnReady(f.client);
  assert.deepEqual(seenIds(f.me).sort(), [GROUP, PEER].sort());

  // Signed out: nothing to key the memory by, and nothing throws
  const signedOut = fake({ peer: true });
  (signedOut.client as { user?: unknown }).user = undefined;
  syncOnReady(signedOut.client);
  checkPlainWrite(signedOut.client, signedOut.text, "send");
  assert.deepEqual(seenIds(signedOut.me), []);
});

test("events remember the user or group they name", () => {
  const f = fake();
  installPlainWriteGuard(f.client);

  f.event({ type: "UserUpdate", id: PEER, data: { e2ee_only: true } });
  assert.deepEqual(seenIds(f.me), [PEER]);

  f.event({
    type: "UserRelationship",
    user: { _id: PEER2, e2ee_only: true },
    status: "Friend",
  });
  assert.equal(isSeen(f.me, PEER2), true);

  f.event({ type: "ChannelUpdate", id: GROUP, data: { e2ee_only: true } });
  assert.equal(isSeen(f.me, GROUP), true);

  const created = "01GROUPBBBBBBBBBBBBBBBBBBB";
  const viaBulk = "01GROUPCCCCCCCCCCCCCCCCCCC";
  const groupCreate = (id: string) => ({
    type: "ChannelCreate",
    _id: id,
    channel_type: "Group",
    e2ee_only: true,
  });
  f.event(groupCreate(created));
  f.event({ type: "Bulk", v: [groupCreate(viaBulk)] });
  assert.equal(isSeen(f.me, created), true);
  assert.equal(isSeen(f.me, viaBulk), true);

  // Not groups, not flagged, or not events at all
  const before = seenIds(f.me).length;
  const flagged = { e2ee_only: true };
  f.event({ type: "ChannelUpdate", id: TEXT, data: flagged });
  f.event({ type: "ChannelUpdate", id: DM, data: flagged });
  f.event({ type: "ChannelUpdate", id: "01UNKNOWN", data: flagged });
  f.event({ ...groupCreate("01TEXTB"), channel_type: "TextChannel" });
  f.event({ type: "ChannelCreate", _id: "01GROUPD", channel_type: "Group" });
  f.event({ type: "UserUpdate", id: "01PEERC", data: { e2ee_only: "true" } });
  f.event({ type: "UserUpdate", data: { e2ee_only: true } });
  f.event({ type: "Bulk", v: "nope" });
  f.event(null);
  f.event("UserUpdate");
  noteEvent(f.client, undefined);
  assert.equal(seenIds(f.me).length, before);
});

test("a write remembers a peer or group whose flag is on at that moment; one account's latch and memory never reach another", () => {
  const f = fake({ peer: true, groupMarked: true });
  // No ready and no event: the flags are only in the cache
  assert.equal(refusal(f, f.dm, "send"), "recipient");
  assert.deepEqual(seenIds(f.me), [PEER]);
  assert.equal(refusal(f, f.group, "poll"), "group");
  assert.deepEqual(seenIds(f.me).sort(), [GROUP, PEER].sort());

  setLatch(f.me);
  allKinds(f, f.dm, "open-app");

  // The next account on this device, same peer and group
  const next = fake();
  assert.equal(isLatched(next.me), false);
  assert.deepEqual(seenIds(next.me), []);
  allKinds(next, next.dm, null);
  allKinds(next, next.group, null);
});
