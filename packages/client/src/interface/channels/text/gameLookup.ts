/**
 * Composer game lookups: `/game`, `/wowitem` and `/champion`.
 *
 * Pure logic only (no Solid, no lingui), so `node --test` can load it. The
 * composer parses the command, asks the privacy gate, calls the lookup
 * route, then lets the user pick a result whose URL is sent as an ordinary
 * message; the server's embed pipeline turns that URL into a game card.
 */

/**
 * Upstream a lookup searches, as named by `GET /lookup/games?source=`
 */
export type GameLookupSource = "steam" | "wow" | "lol";

/**
 * A parsed lookup command
 */
export interface GameCommand {
  source: GameLookupSource;

  /**
   * Search text, trimmed with runs of whitespace collapsed. Empty when the
   * command was typed with nothing after it.
   */
  query: string;
}

/**
 * One lookup result, as returned by the route
 */
export interface GameLookupResult {
  title: string;
  subtitle: string | null;
  url: string;
}

/**
 * Most results the picker shows (the route also returns at most 5)
 */
export const MAX_GAME_LOOKUP_RESULTS = 5;

/**
 * A command word followed by whitespace or the end of the text. `/gamex`
 * does not match, so it falls through to the normal send path.
 */
const COMMAND_RE = /^\/(game|wowitem|champion)(?:\s+([\s\S]*))?$/i;

/**
 * Parse a lookup command out of composer text.
 * @param text Composer text
 * @returns The command, or null when the text is not a lookup command
 */
export function parseGameCommand(text: string): GameCommand | null {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return null;

  let source: GameLookupSource;
  switch (match[1].toLowerCase()) {
    case "game":
      source = "steam";
      break;
    case "wowitem":
      source = "wow";
      break;
    case "champion":
      source = "lol";
      break;
    default:
      return null;
  }

  const query = (match[2] ?? "").trim().replace(/\s+/g, " ");
  return { source, query };
}

/**
 * Reads the authoritative E2EE send mode of the conversation (the native
 * `sendModeNowFor`). May throw; a throw counts as "not plaintext".
 */
export type SendModeGetter = () => Promise<string | null | undefined>;

/**
 * Server channels: never end-to-end encrypted, so lookups are allowed
 */
const SERVER_CHANNEL_TYPES = new Set(["TextChannel", "Thread"]);

/**
 * Conversations that can be end-to-end encrypted
 */
const PRIVATE_CHANNEL_TYPES = new Set(["DirectMessage", "Group"]);

/**
 * Whether a channel type is a DM or group (which may be encrypted)
 * @param channelType Channel type
 */
export function isPrivateConversation(channelType: string): boolean {
  return PRIVATE_CHANNEL_TYPES.has(channelType);
}

/**
 * Privacy gate for lookups, copied from the composer's `sendInteraction`
 * and made stricter: a lookup sends what the user typed to the server, so
 * it must never run inside an encrypted conversation.
 *
 * - Server channels are allowed.
 * - DMs and groups are allowed only when the native layer says the
 *   conversation is exactly `"plaintext"`. Any other mode, a missing mode
 *   (null, undefined, or no native layer to ask) and a thrown error all
 *   fail closed.
 * - Every other channel type (saved messages, anything unknown) is refused.
 * @param channelType Channel type
 * @param getSendMode Authoritative send-mode reader, if this platform has one
 * @returns Whether a lookup may be sent
 */
export async function gameLookupAllowed(
  channelType: string,
  getSendMode: SendModeGetter | undefined,
): Promise<boolean> {
  if (SERVER_CHANNEL_TYPES.has(channelType)) return true;
  if (!PRIVATE_CHANNEL_TYPES.has(channelType)) return false;
  if (!getSendMode) return false;

  try {
    return (await getSendMode()) === "plaintext";
  } catch {
    return false;
  }
}

/**
 * The slice of `fetch` the lookup needs, so a spec can count calls
 */
export type FetchLike = (
  input: string,
  init: { method: "GET"; headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * How a lookup ended
 */
export type GameLookupOutcome =
  | { kind: "denied" }
  | { kind: "empty-query" }
  | { kind: "results"; results: GameLookupResult[] }
  | { kind: "busy" }
  | { kind: "disabled" }
  | { kind: "failed" };

/**
 * Keep only well-formed results whose URL is http(s), at most 5. The picked
 * URL is sent as a message, so anything else is dropped rather than sent.
 * @param body Response body
 * @returns Results, or null when the body is not a list
 */
export function readGameLookupResults(
  body: unknown,
): GameLookupResult[] | null {
  if (!Array.isArray(body)) return null;

  const results: GameLookupResult[] = [];
  for (const entry of body) {
    if (!entry || typeof entry !== "object") continue;
    const { title, subtitle, url } = entry as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim()) continue;
    if (typeof url !== "string" || !/^https?:\/\/\S+$/i.test(url)) continue;
    results.push({
      title,
      subtitle: typeof subtitle === "string" && subtitle ? subtitle : null,
      url,
    });
    if (results.length >= MAX_GAME_LOOKUP_RESULTS) break;
  }

  return results;
}

/**
 * Map a failed response to an outcome. `InSlowmode` (and a bare 429) means
 * lookups are busy: the user's window or the shared upstream budget.
 * @param status HTTP status
 * @param body Parsed error body, if any
 */
export function gameLookupErrorOutcome(
  status: number,
  body: unknown,
): GameLookupOutcome {
  const type =
    body && typeof body === "object"
      ? (body as { type?: unknown }).type
      : undefined;

  if (type === "InSlowmode" || status === 429) return { kind: "busy" };
  if (type === "FeatureDisabled") return { kind: "disabled" };
  return { kind: "failed" };
}

/**
 * Run a lookup: the privacy gate first, then (only if allowed and the query
 * is not empty) one request to `GET /lookup/games`. A denied lookup makes
 * no request at all. Never throws.
 */
export async function runGameLookup(options: {
  channelType: string;
  getSendMode: SendModeGetter | undefined;
  fetchImpl: FetchLike;
  baseURL: string;
  authHeader: readonly [string, string];
  command: GameCommand;
}): Promise<GameLookupOutcome> {
  const { fetchImpl, command } = options;

  if (!(await gameLookupAllowed(options.channelType, options.getSendMode))) {
    return { kind: "denied" };
  }

  if (!command.query) return { kind: "empty-query" };

  const params = new URLSearchParams({
    source: command.source,
    q: command.query,
  });

  try {
    const [authName, authValue] = options.authHeader;
    const response = await fetchImpl(
      `${options.baseURL}/lookup/games?${params.toString()}`,
      { method: "GET", headers: { [authName]: authValue } },
    );

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        /* no body */
      }
      return gameLookupErrorOutcome(response.status, body);
    }

    const results = readGameLookupResults(await response.json());
    return results ? { kind: "results", results } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * Picker selection after a key press; wraps at both ends.
 * @param index Current selection
 * @param key `KeyboardEvent.key`
 * @param count Number of results
 */
export function pickerIndexAfterKey(
  index: number,
  key: string,
  count: number,
): number {
  if (count <= 0) return 0;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  return index;
}
