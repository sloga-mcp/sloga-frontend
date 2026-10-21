/**
 * Recognise links and paths that name a conversation (a DM or a group), so
 * chat-windows mode can open them as a chat-window tab instead of in main.
 *
 * Import-free so `node --test` can load it; whether the id really is a DM or
 * a group is the caller's check, against its client.
 */

/**
 * A DM or group path, `/channel/<id>` with an optional message id; server
 * channel paths start with `/server/` and never match.
 */
export const CONVERSATION_PATH_RE: RegExp =
  /^\/channel\/([0-9A-HJKMNP-TV-Z]{26})(?:\/[0-9A-HJKMNP-TV-Z]{26})?$/;

/** The channel id of a conversation path, or undefined. */
export function conversationIdFromPath(path: string): string | undefined {
  return CONVERSATION_PATH_RE.exec(path)?.[1];
}

/**
 * The channel id of a link to a conversation itself, `/channel/<id>`:
 * `href` resolved against `base` (the page's URL) must stay on `base`'s
 * origin. Query and fragment are ignored.
 *
 * A link to a message in it, `/channel/<id>/<message id>` (reply quotes,
 * forwarded-from, pins, search results), is NOT one: a chat-window tab
 * cannot jump to a message, so those keep main's navigation, which can.
 */
export function bareConversationIdFromHref(
  href: string,
  base: string,
): string | undefined {
  let url: URL;
  let origin: string;
  try {
    url = new URL(href, base);
    origin = new URL(base).origin;
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  const id = conversationIdFromPath(url.pathname);
  return id && url.pathname === `/channel/${id}` ? id : undefined;
}
