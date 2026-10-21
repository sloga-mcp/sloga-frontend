/**
 * Pure decisions behind the Home page: which cards show, when a dismissed
 * card comes back, and which streamer data is safe to render. Kept free of
 * Solid, lingui and the client so `node --test` can load it.
 */
import type { SaleStatus } from "../../../components/app/interface/settings/user/cipherCheckout";

/** How long the X on the Cipher banner hides it */
export const CIPHER_BANNER_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

/** localStorage key: epoch ms when the Cipher banner was last dismissed */
export const CIPHER_BANNER_KEY = "sloga.home.cipherBannerHiddenAt";

/** localStorage key: release ("0.69") whose What's New card was dismissed */
export const WHATS_NEW_KEY = "sloga.home.whatsNewDismissed";

/** Most streamer tiles the Home row shows; "See all" has the rest */
export const HOME_STREAMER_LIMIT = 8;

/**
 * A stored timestamp, or undefined when it is missing or not a positive
 * whole number of milliseconds
 */
export function parseStoredTime(
  raw: string | null | undefined,
): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Whether the Cipher banner shows.
 *
 * Fails closed: it needs a build that may link to payments, a sale the public
 * counter reports as open (unknown, closed and sold out all hide it), a
 * viewer without a Cipher badge, and no dismissal within the snooze window.
 * A dismissal stamped in the future (a clock change) counts as just now.
 */
export function showCipherBanner(input: {
  allowsLinks: boolean;
  sale: SaleStatus | undefined;
  hasCipher: boolean;
  hiddenAt: number | undefined;
  now: number;
}): boolean {
  if (!input.allowsLinks || input.sale !== "open" || input.hasCipher) {
    return false;
  }
  if (input.hiddenAt === undefined) return true;
  return (
    input.now - Math.min(input.hiddenAt, input.now) >= CIPHER_BANNER_SNOOZE_MS
  );
}

/**
 * The release a version belongs to: "0.69.2" and "0.69.0-rc.1" are both
 * "0.69". Undefined when the string is not a version.
 */
export function releaseOf(version: string | undefined): string | undefined {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/.exec(version ?? "");
  return match ? `${Number(match[1])}.${Number(match[2])}` : undefined;
}

/**
 * Whether the What's New card shows: only in the release its highlights were
 * written for (so a later release that forgot to update them shows nothing
 * rather than old news), and only until it is dismissed for that release.
 */
export function showWhatsNew(input: {
  appVersion: string;
  highlightsRelease: string;
  dismissed: string | null | undefined;
}): boolean {
  const release = releaseOf(input.appVersion);
  return (
    release !== undefined &&
    release === input.highlightsRelease &&
    input.dismissed !== release
  );
}

/** Whether the welcome tiles show: someone with no servers or no friends yet */
export function isNewUser(serverCount: number, friendCount: number): boolean {
  return serverCount === 0 || friendCount === 0;
}

/** A linked channel as far as the Home tile reads it */
export type TileConnection = {
  platform: string;
  live?: boolean;
  live_title?: string;
  /**
   * Not sent by any server yet. Phase 2 adds a stream thumbnail; until then
   * the tile never offers its back face.
   */
  live_thumbnail?: unknown;
};

/**
 * The channel a tile is about: the first live one, otherwise the first one.
 * Undefined when the streamer has linked nothing.
 */
export function primaryConnection<T extends TileConnection>(
  connections: readonly T[] | undefined,
): T | undefined {
  if (!Array.isArray(connections) || connections.length === 0) return undefined;
  return connections.find((c) => c?.live === true) ?? connections[0];
}

/** Hosts a stream thumbnail may be loaded from */
export const THUMBNAIL_HOSTS: readonly string[] = [
  "static-cdn.jtvnw.net",
  "i.ytimg.com",
];

/**
 * A live channel's thumbnail URL when it is safe to put in an `<img>`:
 * `https:` on a known platform CDN, no credentials, and only while the
 * channel is live. Anything else (absent today) is undefined, which hides
 * the flip button.
 */
export function streamThumbnail(
  connection: TileConnection | undefined,
): string | undefined {
  if (!connection || connection.live !== true) return undefined;
  const raw = connection.live_thumbnail;
  if (typeof raw !== "string" || raw.length > 2048) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    return undefined;
  }
  if (url.port !== "" || !THUMBNAIL_HOSTS.includes(url.hostname)) {
    return undefined;
  }
  return url.href;
}

/** Most rows each "Jump back in" card shows */
export const JUMP_UNREAD_LIMIT = 4;
export const JUMP_VOICE_LIMIT = 4;
export const JUMP_EVENT_LIMIT = 3;

/**
 * Most events Home asks the cross-server upcoming route for. It returns them
 * soonest first, so a few spare cover events the card later drops.
 */
export const JUMP_EVENT_FETCH_LIMIT = 20;

/**
 * Servers whose calendars Home asks about when the server has no
 * cross-server upcoming route (an older backend). That fallback is one
 * request per server, and they share the "events" rate limit (30 per 10 s)
 * with the calendar page.
 */
export const JUMP_EVENT_SERVER_LIMIT = 10;

/** Calendar requests in flight at once */
export const JUMP_EVENT_CONCURRENCY = 2;

/** How far ahead Upcoming looks */
export const JUMP_EVENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** How long fetched calendars are reused before Home asks again */
export const JUMP_EVENT_CACHE_MS = 5 * 60 * 1000;

/** A server or conversation as far as the Unread card reads it */
export type UnreadCandidate = {
  /** Whether the rail shows it as unread */
  unread: boolean;
  /** Muted servers raise no badge on the rail, so none here either */
  muted: boolean;
  /** Mentions (and direct messages) go first */
  mention: boolean;
};

/**
 * What the Unread card lists: the rail's unread items, mentions first, then
 * in the order the rail shows them (callers pass conversations before
 * servers, as the rail does).
 */
export function pickUnreads<T extends UnreadCandidate>(
  items: readonly T[],
  limit = JUMP_UNREAD_LIMIT,
): T[] {
  const open = items.filter((item) => item.unread && !item.muted);
  return [
    ...open.filter((item) => item.mention),
    ...open.filter((item) => !item.mention),
  ].slice(0, limit);
}

/** A voice channel and who is in it */
export type VoiceRoomCandidate = {
  channelId: string;
  participantIds: readonly string[];
};

/**
 * Voice channels with friends in them, busiest first. The viewer is never
 * counted, and the call the viewer is already in is left out.
 */
export function pickVoiceRooms<T extends VoiceRoomCandidate>(
  rooms: readonly T[],
  friendIds: ReadonlySet<string>,
  options: {
    viewerId?: string;
    currentChannelId?: string;
    limit?: number;
  } = {},
): { room: T; friendIds: string[] }[] {
  return rooms
    .filter((room) => room.channelId !== options.currentChannelId)
    .map((room) => ({
      room,
      friendIds: room.participantIds.filter(
        (id) => id !== options.viewerId && friendIds.has(id),
      ),
    }))
    .filter((entry) => entry.friendIds.length > 0)
    .sort((a, b) => b.friendIds.length - a.friendIds.length)
    .slice(0, options.limit ?? JUMP_VOICE_LIMIT);
}

/** A calendar series and its occurrence starts (ms epoch) */
export type OccurrenceRow<E> = {
  event: E;
  occurrences: readonly number[];
};

/** The parts of an event the Upcoming card decides on */
export type UpcomingCandidate = { id: string; cancelled: boolean };

/**
 * The next events to show: not cancelled, not started yet, soonest first,
 * and one entry per event so a daily series cannot fill the card.
 */
export function pickUpcoming<E extends UpcomingCandidate>(
  rows: readonly OccurrenceRow<E>[],
  now: number,
  limit = JUMP_EVENT_LIMIT,
): { event: E; start: number }[] {
  const next = new Map<string, { event: E; start: number }>();
  for (const row of rows) {
    if (row.event.cancelled) continue;
    for (const start of row.occurrences) {
      if (!Number.isFinite(start) || start < now) continue;
      const seen = next.get(row.event.id);
      if (!seen || start < seen.start) {
        next.set(row.event.id, { event: row.event, start });
      }
    }
  }
  return [...next.values()]
    .sort(
      (a, b) =>
        a.start - b.start ||
        (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0),
    )
    .slice(0, limit);
}

/**
 * Ask each server for its calendar, a few at a time. A server that fails is
 * skipped; "FeatureDisabled" means events are off everywhere, so nothing
 * more is asked.
 */
export async function collectEvents<E>(
  serverIds: readonly string[],
  fetchServer: (serverId: string) => Promise<OccurrenceRow<E>[]>,
  concurrency = JUMP_EVENT_CONCURRENCY,
): Promise<OccurrenceRow<E>[]> {
  const queue = [...new Set(serverIds)];
  const out: OccurrenceRow<E>[] = [];
  let disabled = false;

  const worker = async () => {
    while (!disabled && queue.length > 0) {
      const serverId = queue.shift()!;
      try {
        out.push(...(await fetchServer(serverId)));
      } catch (error) {
        if ((error as { type?: string } | null)?.type === "FeatureDisabled") {
          disabled = true;
        }
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, queue.length)) },
      worker,
    ),
  );
  return out;
}

/**
 * Upcoming events from the cross-server route, or from `fanOut` (asking
 * servers a few at a time) when the route resolves `undefined` because the
 * server does not have it. "FeatureDisabled" means events are off, so there
 * is nothing to show; any other failure is thrown so nothing gets cached.
 */
export async function upcomingRows<T>(
  fetchUpcoming: () => Promise<T[] | undefined>,
  fanOut: () => Promise<T[]>,
): Promise<T[]> {
  let rows: T[] | undefined;
  try {
    rows = await fetchUpcoming();
  } catch (error) {
    if ((error as { type?: string } | null)?.type === "FeatureDisabled") {
      return [];
    }
    throw error;
  }
  return rows === undefined ? fanOut() : rows;
}

/** Link that opens one event occurrence on its server's calendar */
export function eventLink(serverId: string, eventId: string, start: number) {
  return `/server/${serverId}/events?event=${encodeURIComponent(eventId)}&at=${start}`;
}

/**
 * The occurrence a calendar link asks for, or undefined when the query is
 * not one. `at` is optional; without it the event's first occurrence opens.
 */
export function parseEventLink(query: {
  event?: unknown;
  at?: unknown;
}): { eventId: string; start?: number } | undefined {
  const eventId = query.event;
  if (typeof eventId !== "string" || !/^[0-9A-Z]{26}$/.test(eventId)) {
    return undefined;
  }
  const at = typeof query.at === "string" ? query.at : "";
  const start = /^\d{1,15}$/.test(at) ? Number(at) : undefined;
  return { eventId, start };
}
