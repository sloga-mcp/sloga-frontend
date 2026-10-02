/**
 * Which layout a forum's post list renders in: Modern (preview cards),
 * Classic (Discourse-style rows) or ClassicPlus (phpBB-style table).
 *
 * The choice resolves in order: the user's personal override for this forum
 * (device-local, kept in Settings as a map of forum id to layout), then the
 * forum's default as set by moderators, then Modern. Both inputs can carry
 * junk — a settings blob written by a newer client, or a layout name a future
 * server adds — so every step validates and an unknown value falls through to
 * the next rather than reaching a renderer that has no branch for it.
 *
 * Imports stoat.js for types only, so the module loads under node's native
 * TypeScript type-stripping without a Client.
 */
import type { ForumLayout } from "stoat.js";

export type { ForumLayout };

/** Every layout, in menu order */
export const FORUM_LAYOUTS: readonly ForumLayout[] = [
  "Modern",
  "Classic",
  "ClassicPlus",
];

/** Layout used when neither the user nor the forum picked a valid one. */
const FALLBACK_LAYOUT: ForumLayout = "Modern";

/**
 * Whether a value is a layout this client can render.
 * @param value Arbitrary value, e.g. straight out of persisted settings
 */
export function isForumLayout(value: unknown): value is ForumLayout {
  return (
    typeof value === "string" &&
    (FORUM_LAYOUTS as readonly string[]).includes(value)
  );
}

/**
 * Personal override for this forum, else the forum's default, else Modern.
 * An invalid override (e.g. a stale string from an older build) is skipped
 * in favor of the forum default, not treated as a choice.
 * @param override User's saved layout for this forum, if any
 * @param forumDefault Forum channel's `defaultLayout`, if known
 */
export function resolveLayout(
  override?: ForumLayout,
  forumDefault?: ForumLayout,
): ForumLayout {
  if (isForumLayout(override)) return override;
  if (isForumLayout(forumDefault)) return forumDefault;
  return FALLBACK_LAYOUT;
}

/**
 * Settings validator: keeps only string keys whose value is a known layout;
 * anything else → {}
 *
 * Reads own enumerable keys only, so nothing inherited from a prototype is
 * copied. `__proto__` is skipped explicitly: a JSON-parsed blob can carry it
 * as an own key, and assigning it would hit the prototype setter instead of
 * storing an entry.
 * @param value Persisted `forum:layout` value, of unknown shape
 */
export function cleanLayoutOverrides(
  value: unknown,
): Record<string, ForumLayout> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const source = value as Record<string, unknown>;
  const out: Record<string, ForumLayout> = {};
  for (const forumId of Object.keys(source)) {
    if (forumId === "__proto__") continue;

    const layout = source[forumId];
    if (isForumLayout(layout)) out[forumId] = layout;
  }

  return out;
}

/**
 * Whether the post has a reply beyond its starter (used when stats are
 * unavailable): the starter's id equals the post id, so a last message with
 * any other id is a reply.
 *
 * Reads the stored `lastMessageId`, which the server updates on a lagging
 * queue and never rolls back on delete: a just-posted reply may not show yet,
 * and a post whose only reply was deleted still reads as replied. Good enough
 * to pick "replied" over "posted" copy; never a count.
 * @param post Post id and its stored last message id, if any
 */
export function hasReplies(post: {
  id: string;
  lastMessageId?: string;
}): boolean {
  return !!post.lastMessageId && post.lastMessageId !== post.id;
}
