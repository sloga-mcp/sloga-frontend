/**
 * Encrypted-only chats: gathers the facts the policy decides from
 * (`encryptedOnlyPolicy.ts`) out of a live client, and installs the client's
 * plain write guard.
 *
 * The guard runs before every request that writes unencrypted content into
 * a channel. For a send it only runs when the encryption adapter did not
 * take the message, so a send that reaches it is an unencrypted send.
 *
 * It also keeps this device's latch and memory (`encryptedOnlyLatch.ts`) fed:
 * - the server saying this account is Encrypted-only sets the latch; the
 *   server saying it is not, or saying nothing, changes nothing;
 * - a peer or group seen with the flag is remembered: one pass over the
 *   cache on every `ready`, then only what each event names.
 *
 * The latch and the memory are keyed by `latchAccountId`, and the latch is
 * read with `latchedForClient` (see `encryptedOnlyLatch.ts`).
 *
 * Nothing here imports the encryption bridge: the adapter is read through
 * the two maps it exposes (`status`, `sendModes`), so `node --test` loads
 * this file (`encryptedOnlyGuard.test.ts`).
 */
import { createSignal } from "solid-js";

import type { Channel, Client, PlainWriteKind } from "stoat.js";
import { EncryptedOnlyBlockedError } from "stoat.js";

import {
  forgetSeen,
  isSeen,
  latchAccountId,
  latchedForClient,
  noteServerFlag,
  rememberSeen,
} from "./encryptedOnlyLatch.ts";
import {
  type Advert,
  type ChannelKind,
  type DeviceState,
  type PeerFlag,
  type PlainWriteInput,
  guardReason,
} from "./encryptedOnlyPolicy.ts";

/**
 * The parts of the encryption bridge (`E2EEBridge` in e2ee.ts) read here.
 * Both are reactive maps there, so a read inside a computation tracks.
 */
type AdapterView = {
  /** Native status under the key "state"; unset until first resolved */
  status?: {
    get(
      key: "state",
    ):
      | { enabled?: unknown; published?: unknown; device_id?: unknown }
      | undefined;
  };
  /** Last send mode per direct message peer id or group channel id */
  sendModes?: { get(key: string): string | undefined };
};

function adapterOf(client: Client): AdapterView | undefined {
  const adapter: unknown = client.e2ee;
  return typeof adapter === "object" && adapter !== null
    ? (adapter as AdapterView)
    : undefined;
}

/**
 * Peers whose update said `e2ee_only: false` in so many words, per client.
 * Kept for the life of the client only: after a reload the flag reads as
 * never stated, which keeps a remembered peer blocked.
 */
const turnedOff = new WeakMap<Client, Set<string>>();

// Created on first use, not at load: specs that bundle a stand-in for
// solid-js load this module without ever reading it
let turnedOffSignal: ReturnType<typeof createSignal<number>> | undefined;
const turnedOffVersion = () => (turnedOffSignal ??= createSignal(0))[0]();
const setTurnedOffVersion = (next: (value: number) => number) =>
  (turnedOffSignal ??= createSignal(0))[1](next);

function setTurnedOff(client: Client, userId: string, off: boolean): void {
  let ids = turnedOff.get(client);
  if (!ids) {
    if (!off) return;
    ids = new Set();
    turnedOff.set(client, ids);
  }

  if (ids.has(userId) === off) return;
  if (off) ids.add(userId);
  else ids.delete(userId);
  setTurnedOffVersion((value) => value + 1);
}

/**
 * Whether a peer explicitly turned Encrypted-only off while this client was
 * running. Tracked read.
 * @param client Client
 * @param userId Peer
 * @returns Whether an update said `false`
 */
export function peerTurnedOff(client: Client, userId: string): boolean {
  turnedOffVersion();
  return turnedOff.get(client)?.has(userId) === true;
}

/** The account whose latch and memory this client uses. */
function accountOf(client: Client): string | undefined {
  return latchAccountId(client.user?.id);
}

/** This client's own account, by the Ready id or the bound session id. */
function isSelf(client: Client, userId: string): boolean {
  return userId === client.user?.id || userId === accountOf(client);
}

/** Bit of `User.flags` set on a deleted account (stoat.js `UserFlags`). */
const DELETED_FLAG = 2;

function deletedFlag(flags: unknown): boolean {
  return typeof flags === "number" && (flags & DELETED_FLAG) !== 0;
}

/**
 * Where a write into this channel goes.
 * @param channel Channel
 * @returns The kind; a channel that is neither a known type nor in a server
 * is held to the direct message rules
 */
export function channelKindOf(channel: Channel): ChannelKind {
  switch (channel.type) {
    case "SavedMessages":
      return "saved";
    case "Group":
      return "group";
    case "DirectMessage":
      return "dm";
    default:
      // A type this app does not know: only a server's channel is exempt,
      // as on the server. Anything else is held as a direct message, so it
      // fails closed.
      return channel.serverId ? "server" : "dm";
  }
}

/**
 * The other user of a direct message.
 * @param client Client
 * @param channel Channel
 * @returns Their id, or `undefined` outside a direct message
 */
export function dmPeerId(client: Client, channel: Channel): string | undefined {
  if (channel.type !== "DirectMessage") return undefined;

  for (const id of channel.recipientIds?.values() ?? []) {
    if (!isSelf(client, id)) return id;
  }
  return undefined;
}

/**
 * This device: the website (no encryption adapter in this window), an app
 * where encryption is not set up, or an app where it is on, published and
 * has a device id (the same rule as the bridge's `#deviceReady`). A status
 * that has not resolved yet reads as not set up.
 * @param client Client
 * @returns The device state
 */
export function deviceStateOf(client: Client): DeviceState {
  const adapter = adapterOf(client);
  if (!adapter) return "web";

  const status = adapter.status?.get("state");
  return status?.enabled === true &&
    status.published === true &&
    !!status.device_id
    ? "ready"
    : "not-set-up";
}

/**
 * What the server advertises about the feature.
 * @param client Client
 * @returns The advert
 */
export function advertOf(client: Client): Advert {
  const only: unknown = (
    client.configuration as
      | { features?: { e2ee?: { only?: unknown } } }
      | undefined
  )?.features?.e2ee?.only;

  if (typeof only !== "object" || only === null) return "absent";
  return (only as { enforced?: unknown }).enforced === true
    ? "enforced"
    : "not-enforced";
}

/**
 * Gather the facts for a write into a channel. The one place the policy
 * input is built, for the guard and the encryption bridge alike. Reads only;
 * every read is tracked where its source is reactive.
 *
 * `encrypted` is the adapter's last known send mode for the conversation
 * and is true only for "encrypt". Unknown, or no adapter, is false. The
 * guard does not use it.
 * @param client Client
 * @param channel Channel
 * @returns The policy input
 */
export function buildPlainWriteInput(
  client: Client,
  channel: Channel,
): PlainWriteInput {
  const me = accountOf(client);
  const kind = channelKindOf(channel);
  const peerId = dmPeerId(client, channel);
  const peer = peerId ? client.users.get(peerId) : undefined;

  let peerFlag: PeerFlag = "absent";
  if (peer?.e2eeOnly === true) peerFlag = "on";
  else if (peerId && peerTurnedOff(client, peerId)) peerFlag = "off";

  const modeKey = kind === "dm" ? peerId : channel.id;
  const mode = modeKey ? adapterOf(client)?.sendModes?.get(modeKey) : undefined;

  return {
    latched: latchedForClient(client.user?.id),
    channel: kind,
    peerFlag,
    peerRemembered: isSeen(me, peerId),
    groupMarked: kind === "group" && channel.e2eeOnly === true,
    groupRemembered: kind === "group" && isSeen(me, channel.id),
    device: deviceStateOf(client),
    encrypted: mode === "encrypt",
    advert: advertOf(client),
  };
}

/** Feed the latch from this account's own flag. Only "on" changes it. */
function syncOwnFlag(client: Client): void {
  const user = client.user;
  if (user) noteServerFlag(accountOf(client), user.e2eeOnly === true);
}

/** Remember the peer or group of one channel if it carries the flag now. */
function noteChannel(client: Client, channel: Channel): void {
  const me = accountOf(client);
  if (!me) return;

  if (channel.type === "Group") {
    if (channel.e2eeOnly === true) rememberSeen(me, channel.id);
    return;
  }

  const peerId = dmPeerId(client, channel);
  if (peerId && client.users.get(peerId)?.e2eeOnly === true) {
    rememberSeen(me, peerId);
  }
}

/**
 * The one pass over the cache, run on every `ready`: the own flag, every
 * known user with the flag, every marked group.
 * @param client Client
 */
export function syncOnReady(client: Client): void {
  const me = accountOf(client);
  if (!me || !client.user) return;

  syncOwnFlag(client);

  for (const user of client.users.values()) {
    if (!isSelf(client, user.id) && user.e2eeOnly === true) {
      rememberSeen(me, user.id);
    }
  }

  for (const channel of client.channels.values()) {
    if (channel.type === "Group" && channel.e2eeOnly === true) {
      rememberSeen(me, channel.id);
    }
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * One user's `e2ee_only` as an event stated it.
 * @param partial The event carries only changed fields, so a literal
 * `false` is an explicit "turned off"; a full object omits the field
 * @param deleted The account is deleted: deletion clears the flag, which is
 * not the peer turning it off, so the peer is forgotten instead
 */
function noteUserFlag(
  client: Client,
  userId: unknown,
  value: unknown,
  partial: boolean,
  deleted: boolean,
): void {
  const me = accountOf(client);
  if (!me || typeof userId !== "string" || userId === "") return;

  if (isSelf(client, userId)) {
    if (value === true) noteServerFlag(me, true);
    return;
  }

  if (deleted) {
    setTurnedOff(client, userId, false);
    forgetSeen(me, userId);
    return;
  }

  if (value === true) {
    rememberSeen(me, userId);
    setTurnedOff(client, userId, false);
  } else if (value === false && partial) {
    setTurnedOff(client, userId, true);
  }
}

/**
 * Read one socket event for the flags it names. Touches only the user or
 * channel in the event.
 * @param client Client
 * @param event The event as the server sent it
 */
export function noteEvent(client: Client, event: unknown): void {
  switch (field(event, "type")) {
    case "Bulk": {
      const events = field(event, "v");
      if (Array.isArray(events)) {
        for (const item of events) noteEvent(client, item);
      }
      return;
    }
    case "UserUpdate": {
      const id = field(event, "id");
      const data = field(event, "data");
      // The cache may already hold the deletion if the client ran first
      const cached =
        typeof id === "string" ? client.users.get(id)?.flags : undefined;
      noteUserFlag(
        client,
        id,
        field(data, "e2ee_only"),
        true,
        deletedFlag(field(data, "flags")) || deletedFlag(cached),
      );
      return;
    }
    case "UserRelationship": {
      const user = field(event, "user");
      noteUserFlag(
        client,
        field(user, "_id"),
        field(user, "e2ee_only"),
        false,
        deletedFlag(field(user, "flags")),
      );
      return;
    }
    case "ChannelCreate": {
      const id = field(event, "_id");
      if (
        field(event, "channel_type") === "Group" &&
        field(event, "e2ee_only") === true &&
        typeof id === "string"
      ) {
        rememberSeen(accountOf(client), id);
      }
      return;
    }
    case "ChannelUpdate": {
      const id = field(event, "id");
      if (
        field(field(event, "data"), "e2ee_only") === true &&
        typeof id === "string" &&
        client.channels.get(id)?.type === "Group"
      ) {
        rememberSeen(accountOf(client), id);
      }
      return;
    }
  }
}

/**
 * The guard itself: refuse an unencrypted write the policy does not allow.
 * @param client Client
 * @param channel Where the write goes
 * @param kind What is about to be written
 * @throws EncryptedOnlyBlockedError with the policy's reason
 */
export function checkPlainWrite(
  client: Client,
  channel: Channel,
  kind: PlainWriteKind,
): void {
  // Whatever the cache says right now counts, even if no event named it
  syncOwnFlag(client);
  noteChannel(client, channel);

  const reason = guardReason(kind, buildPlainWriteInput(client, channel));
  if (reason) throw new EncryptedOnlyBlockedError(reason);
}

/**
 * Install the plain write guard on a client and keep the latch and the
 * memory fed from it. Call once, right after the client is created and
 * before it can make a request.
 * @param client Client
 * @returns Removes the two listeners, for when the client is replaced. The
 * guard itself stays on the client, so a late write from it is still checked.
 */
export function installPlainWriteGuard(client: Client): () => void {
  // A one-off check of the current facts at each write, not a tracked scope
  client.plainWriteGuard = (channel, kind) =>
    checkPlainWrite(client, channel, kind);

  const onReady = () => syncOnReady(client);
  const onEvent = (event: unknown) => noteEvent(client, event);
  client.on("ready", onReady);
  client.events.on("event", onEvent);

  return () => {
    client.off("ready", onReady);
    client.events.off("event", onEvent);
  };
}
