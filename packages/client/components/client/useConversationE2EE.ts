import { type Accessor, createMemo } from "solid-js";

import type { Channel } from "stoat.js";

import { useE2EE } from ".";
import { type E2EEBadge, e2eeBadgeFor } from "./e2eeBadge.ts";

/**
 * Reactive encryption badge for a conversation, read from the same sources
 * the composer uses (`Composition.tsx` `e2eeMode`). Read-only: it never
 * primes or reconciles a send mode. Whoever opens the conversation does that
 * (the chat-window host primes on tab creation), and until then the badge
 * stays null, never "encrypted".
 */
export function useConversationE2EE(
  channel: Accessor<Channel | undefined>,
): Accessor<E2EEBadge | null> {
  // Undefined on builds with no native E2EE layer (web, the friends popout):
  // E2EE is then known to be off on this device
  const e2ee = useE2EE();

  const badge = createMemo(() => {
    const ch = channel();
    if (!ch) return null;

    const isGroup = ch.type === "Group";
    if (ch.type !== "DirectMessage" && !isGroup) {
      // Server channels, threads and saved messages can never be E2EE
      return "not_encrypted";
    }

    // The `sendModes` key: the peer user id for a DM, the channel id for a
    // group. A DM whose recipient hasn't resolved yet has no answer
    const conversationId = isGroup ? ch.id : ch.recipient?.id;
    if (!conversationId) return null;

    const state = e2ee?.status.get("state");
    return e2eeBadgeFor({
      mode: e2ee?.sendModes.get(conversationId),
      isGroup,
      selfEnabled: !!state?.enabled && !!state?.published,
      peerAdvertises: !isGroup && !!ch.recipient?.e2eeEnabled,
      e2eeLoaded: !e2ee || !!state,
    });
  });

  return badge;
}
