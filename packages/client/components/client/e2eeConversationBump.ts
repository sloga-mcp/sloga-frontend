/**
 * Conversation-list bump for the E2EE decrypt path (`#handleEnvelope` in
 * `e2ee.ts`) - pure and dependency-free so `node --test` can load it (the
 * house no-vitest split).
 *
 * Why this exists: encrypted messages never pass through the server's normal
 * message path - the server only relays per-device envelopes and never sees
 * a channel message - so it never moves `last_message_id` or counts unreads
 * for them. The client is the only party that can order and count encrypted
 * conversations, and it can only do so after a decrypt. This module decides,
 * from a decrypt outcome and the history rows just injected, whether that
 * decrypt should bump the conversation (`Channel.noteEncryptedMessage`), and
 * with which origin.
 *
 * Only a real text message bumps. A control message (group_enable,
 * roster_add, downgrade) carries no conversation content, and marker rows
 * (gap, tampered, identity change ...) are local annotations, so neither may
 * reorder the list or add to the unread count. A decrypt outcome that LACKS
 * the `control` field is treated as unknown and does not bump: fail closed.
 *
 * `live` is deliberately NOT the signal: after a reload, history rows that
 * are re-injected also arrive as `live`, so keying off it would re-count old
 * messages. The signal is this decrypt's own outcome id matched against an
 * injected `text` row.
 *
 * Origin: `own` when the message is ours, sent from another of our devices
 * (no unread, no reopen); otherwise `incoming` with `reopen` so a closed DM
 * reappears locally.
 */

/**
 * The bump for one decrypt, or null when it must not bump. Non-null only
 * when `outcome.kind === "message"`, `outcome` HAS a `control` key whose
 * value is null, and `rows` contains a row with `id === outcome.id` and
 * `kind === "text"`. `hasAttachments` is true when that row carries a
 * non-empty `attachments` array.
 */
export function decryptBump(
  outcome: {
    kind: string;
    id: string;
    own_message?: boolean;
    control?: string | null;
  },
  rows: { id: string; kind: string; attachments?: unknown[] }[],
): {
  id: string;
  origin: "incoming" | "own";
  hasAttachments: boolean;
  reopen: boolean;
} | null {
  if (!outcome || outcome.kind !== "message") return null;
  // a missing key is unknown, not "no control": fail closed
  if (!("control" in outcome) || outcome.control !== null) return null;
  if (!Array.isArray(rows)) return null;

  const row = rows.find((r) => r?.id === outcome.id);
  if (!row || row.kind !== "text") return null;

  const own = outcome.own_message === true;
  return {
    id: outcome.id,
    origin: own ? "own" : "incoming",
    hasAttachments:
      Array.isArray(row.attachments) && row.attachments.length > 0,
    reopen: !own,
  };
}
