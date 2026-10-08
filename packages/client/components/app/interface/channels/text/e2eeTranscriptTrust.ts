/**
 * In an encrypted DM or group, only messages this device decrypted itself
 * (the trusted set) may appear in the transcript. Anything else is replaced
 * by a "message hidden" marker, because a row that slips through looks
 * exactly like a decrypted one.
 *
 * The live filter in Messages.tsx enforces that for messages that arrive
 * while the view is open. MessageCache is a second way in: it appends every
 * messageCreate to the saved list of a channel nobody is viewing, then hands
 * that list back on the next mount without a fetch. A restored entry must
 * therefore be re-checked against the trusted set before it is used.
 *
 * When the conversation's send mode is not known yet ("unknown"), a restore
 * fails closed: the entry is refused and the caller refetches. That refetch
 * goes through fetchLocalHistory, which only returns trusted rows, so nothing
 * is lost. No marker is counted in that case, since the refetch decides what
 * was dropped. The live filter must NOT treat "unknown" as encrypted, though.
 * Doing so would hide every message in a plaintext DM whose mode has not been
 * settled, and a plaintext DM is the normal state for a peer without E2EE.
 *
 * `pending` is a label the composer derives for display. It is never a
 * sendModes value, so it has no trust case here. `serverActionsBlocked`
 * re-derives it the way the composer does, because Edit and React must stop
 * in that state too.
 */

/** Trust level of the transcript being rendered. */
export type ConversationTrust =
  | "not_e2ee"
  | "plaintext"
  | "encrypted"
  | "unknown";

/** The values e2ee `sendModes` can hold for a conversation. */
type SendMode = "encrypt" | "blocked" | "plaintext" | "peer_downgraded";

/**
 * Not a DM or group, or no E2EE on this device: "not_e2ee". No conversation
 * key (a DM whose peer cannot be derived) or no mode recorded yet: "unknown".
 * A plaintext verdict: "plaintext". Encrypt, blocked and peer_downgraded are
 * all "encrypted": blocked and downgraded conversations still only render
 * rows this device decrypted.
 */
export function conversationTrust(input: {
  hasE2EE: boolean;
  isConversation: boolean;
  conversationId: string | undefined;
  mode: SendMode | undefined;
}): ConversationTrust {
  if (!input.hasE2EE || !input.isConversation) return "not_e2ee";
  if (!input.conversationId) return "unknown";
  switch (input.mode) {
    case "plaintext":
      return "plaintext";
    case "encrypt":
    case "blocked":
    case "peer_downgraded":
      return "encrypted";
    default:
      return "unknown";
  }
}

/**
 * Keeps the trusted rows, in their original order, in a new array.
 * `hiddenVisible` counts the dropped rows that are not system messages;
 * dropped system rows are removed without a marker.
 */
export function splitUntrusted<
  T extends { id: string; systemMessage?: unknown },
>(
  messages: readonly T[],
  isTrusted: (id: string) => boolean,
): { trusted: T[]; hiddenVisible: number } {
  const trusted: T[] = [];
  let hiddenVisible = 0;
  for (const message of messages) {
    if (isTrusted(message.id)) {
      trusted.push(message);
    } else if (!message.systemMessage) {
      hiddenVisible++;
    }
  }
  return { trusted, hiddenVisible };
}

/**
 * Decides whether a cached entry may be restored as is. For "not_e2ee" and
 * "plaintext" the entry comes back unchanged. For "encrypted" and "unknown"
 * it comes back only if every row is trusted; otherwise it is refused
 * (undefined, so the caller refetches). A refused "encrypted" entry reports
 * how many non-system rows were untrusted; a refused "unknown" entry reports
 * 0, because the refetch decides what is shown.
 */
export function restorableForTrust<
  T extends { messages: readonly { id: string; systemMessage?: unknown }[] },
>(
  entry: T | undefined,
  trust: ConversationTrust,
  isTrusted: (id: string) => boolean,
): { entry: T | undefined; hiddenVisible: number } {
  if (!entry) return { entry: undefined, hiddenVisible: 0 };
  if (trust === "not_e2ee" || trust === "plaintext") {
    return { entry, hiddenVisible: 0 };
  }
  const { trusted, hiddenVisible } = splitUntrusted(entry.messages, isTrusted);
  if (trusted.length === entry.messages.length) {
    return { entry, hiddenVisible: 0 };
  }
  return {
    entry: undefined,
    hiddenVisible: trust === "encrypted" ? hiddenVisible : 0,
  };
}

/**
 * The parts of the e2ee controller the conversation gate reads. The real
 * controller's `sendModes` and `status` ReactiveMaps fit this shape as they
 * are, so reads stay reactive. `published` is read only to mirror the
 * composer's "self enabled" rule for the pending state.
 */
export type TrustE2EE = {
  sendModes: { get(id: string): SendMode | undefined };
  status: {
    get(key: "state"): { enabled: boolean; published: boolean } | undefined;
  };
};

/** The parts of a stoat.js Channel the conversation gate reads. */
export type TrustChannel = {
  id: string;
  type: string;
  recipientIds?: { values(): Iterable<string> };
  recipient?: { e2eeEnabled?: boolean };
};

/**
 * Trust level of a channel, keyed the same way as the e2ee layer: the
 * channel id for a group, the other recipient's id for a DM. This is the
 * derivation Messages.tsx uses for its transcript, so every view of a
 * conversation agrees on its trust. No E2EE on this device is "not_e2ee".
 * E2EE present but no channel is "unknown", so a caller that lost its
 * channel fails closed instead of open.
 */
export function channelTrust(
  e2ee: TrustE2EE | undefined,
  channel: TrustChannel | undefined,
  selfId: string | undefined,
): ConversationTrust {
  if (!e2ee) return "not_e2ee";
  if (!channel) return "unknown";
  const isGroup = channel.type === "Group";
  const isDM = channel.type === "DirectMessage";
  const conversationId = isGroup
    ? channel.id
    : isDM
      ? [...(channel.recipientIds?.values() ?? [])].find((id) => id !== selfId)
      : undefined;
  return conversationTrust({
    hasE2EE: true,
    isConversation: isGroup || isDM,
    conversationId,
    mode: conversationId ? e2ee.sendModes.get(conversationId) : undefined,
  });
}

/**
 * Whether actions that send new user content to the server (Edit, React,
 * poll votes, reservations) must be withheld in this conversation. Rows
 * that are already on the server stay deletable, pinnable and so on; this
 * only stops new content from leaving the device in plaintext.
 *
 * - "encrypted": blocked. The server must never see new content here.
 * - "unknown": blocked while E2EE is enabled on this device or its status
 *   has not loaded yet (one IPC call at boot), since the mode may still
 *   settle to encrypted. With E2EE turned off the controller never records a
 *   send mode, so "unknown" would never clear; blocking it there would take
 *   Edit and React away from every DM for good, and nothing could be
 *   encrypted anyway, so it is allowed.
 * - "plaintext": blocked only in the composer's pending state, where the
 *   next new message would try to encrypt but an edit would still go out in
 *   plaintext.
 * - "not_e2ee": allowed. Web, server channels and devices without E2EE.
 */
export function serverActionsBlocked(
  e2ee: TrustE2EE | undefined,
  channel: TrustChannel | undefined,
  selfId: string | undefined,
): boolean {
  if (!e2ee) return false;
  switch (channelTrust(e2ee, channel, selfId)) {
    case "encrypted":
      return true;
    case "unknown":
      return e2ee.status.get("state")?.enabled !== false;
    case "plaintext":
      return composerPending(e2ee, channel);
    case "not_e2ee":
      return false;
  }
}

/**
 * The composer's "pending" label for a plaintext conversation, mirrored from
 * `e2eeMode()` in src/interface/channels/text/Composition.tsx:
 * - :141 `if (isGroup()) return undefined;` (groups never show pending)
 * - :146-147 `if (mode === "plaintext" && selfE2EEEnabled())` then
 *   `peerE2EEEnabled() ? "pending" : "unencrypted"`
 * - :109-112 `selfE2EEEnabled`: status "state" enabled AND published
 * - :115-117 `peerE2EEEnabled`: `channel.recipient?.e2eeEnabled`
 * The caller has already established the plaintext mode.
 */
function composerPending(
  e2ee: TrustE2EE,
  channel: TrustChannel | undefined,
): boolean {
  if (channel?.type !== "DirectMessage") return false;
  const state = e2ee.status.get("state");
  return (
    !!state?.enabled && !!state?.published && !!channel.recipient?.e2eeEnabled
  );
}
