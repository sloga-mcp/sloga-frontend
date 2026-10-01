/**
 * What to call a channel in user-facing copy: a forum post, a thread, or a
 * plain channel.
 *
 * Forum posts and threads share the channel type "Thread"; only the parent
 * tells them apart. `Channel.isForumPost` reads `parent?.type`, so it is false
 * whenever the parent channel is not cached, which would label a forum post a
 * thread. When the parent is missing, applied forum tags stand in for it: only
 * forum posts carry tags. A tagless post with an uncached parent still reads
 * as a thread; nothing on the channel itself can tell the two apart.
 *
 * Returns a key, never a label: callers pick a literal i18n string per noun,
 * so translations are never assembled from an interpolated word.
 *
 * Imports stoat.js for types only, so the module loads under node's native
 * TypeScript type-stripping without a Client.
 */
import type { Channel } from "stoat.js";

/** Noun a channel goes by in user-facing copy. */
export type ChannelNoun = "post" | "thread" | "channel";

/** Minimal structural input, so the rules can be exercised without a Client. */
export interface ChannelNounInput {
  /** `Channel["type"]`; forum posts and threads are both "Thread" */
  type: string;
  /** `parent?.type` when the parent channel is cached, else undefined */
  parentType?: string;
  /** Number of forum tags applied to the channel */
  appliedTagCount: number;
}

/**
 * Noun for a channel described by its type, its parent's type (if cached)
 * and its applied tag count.
 * @param c Channel facts the decision rests on
 */
export function channelNoun(c: ChannelNounInput): ChannelNoun {
  if (c.type !== "Thread") return "channel";

  if (c.parentType !== undefined) {
    return c.parentType === "Forum" ? "post" : "thread";
  }

  return c.appliedTagCount > 0 ? "post" : "thread";
}

/**
 * Noun for a stoat.js channel; reads `type`, `parent?.type` and
 * `appliedTags.length`.
 * @param channel Channel to name
 */
export function channelNounOf(channel: Channel): ChannelNoun {
  return channelNoun({
    type: channel.type,
    parentType: channel.parent?.type,
    appliedTagCount: channel.appliedTags.length,
  });
}
