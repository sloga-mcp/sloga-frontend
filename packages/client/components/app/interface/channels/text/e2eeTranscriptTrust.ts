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
 * sendModes value, so it has no case here.
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
