/**
 * What the in-chat invite card (`./Invite.tsx`) shows for an invite code.
 *
 * # Why this is a separate module
 *
 * `Invite.tsx` reaches `solid-js`, lingui, tanstack-query and `@revolt/ui`, so
 * nothing declared inside it is loadable by `node --test`. This module imports
 * only `ulid` and an import-free sibling, and the card keeps the composition.
 */
import { decodeTime } from "ulid";

import { apiErrorType } from "../../../../../client/apiErrorType.ts";

/**
 * The fields of stoat.js's `PublicChannelInvite` / `ServerPublicInvite` the
 * card reads. Declared structurally so the spec can build one without a
 * client; `type` stands in for `instanceof ServerPublicInvite`.
 */
export interface InviteSource {
  type: string;
  serverId?: string;
  serverName?: string;
  serverFlags?: number;
  memberCount?: number;
  serverIcon?: { previewUrl?: string };
  serverBanner?: { originalUrl?: string };
}

export type InviteBadge = "official" | "verified";

export type InviteCardView =
  | { kind: "loading" }
  | { kind: "invalid" }
  | {
      kind: "server";
      serverId: string;
      name: string;
      iconUrl?: string;
      bannerUrl?: string;
      badge?: InviteBadge;
      memberCount: number;
      /**
       * When the server was created (ms since epoch), from its ULID
       */
      establishedAt?: number;
      /**
       * The user is already a member, so the button opens the server
       */
      joined: boolean;
    };

/**
 * Server flags as the sidebar reads them: bit 1 is an official server, bit 2
 * a verified one. Official wins if both are set, and unknown bits show nothing.
 */
export function inviteBadge(
  flags: number | undefined,
): InviteBadge | undefined {
  if (!flags) return undefined;
  if (flags & 1) return "official";
  if (flags & 2) return "verified";
  return undefined;
}

/**
 * Creation time of a ULID, or undefined if the id is not one
 */
export function ulidTime(id: string): number | undefined {
  try {
    return decodeTime(id);
  } catch {
    return undefined;
  }
}

/**
 * Decide what the card shows.
 *
 * A failed fetch (expired, revoked or mistyped code) and an invite that is not
 * a server invite both render the invalid state: before this, the card showed
 * an empty avatar and a Join button that threw on `join()`.
 *
 * @param status tanstack-query status of the invite fetch
 * @param invite the fetched invite, when `status` is "success"
 * @param isMember whether the user is already in a server
 */
export function inviteCardView(
  status: "pending" | "error" | "success",
  invite: InviteSource | undefined,
  isMember: (serverId: string) => boolean,
): InviteCardView {
  if (status === "pending") return { kind: "loading" };
  if (
    status === "error" ||
    !invite ||
    invite.type !== "Server" ||
    !invite.serverId
  ) {
    return { kind: "invalid" };
  }

  return {
    kind: "server",
    serverId: invite.serverId,
    name: invite.serverName ?? "",
    iconUrl: invite.serverIcon?.previewUrl,
    bannerUrl: invite.serverBanner?.originalUrl,
    badge: inviteBadge(invite.serverFlags),
    memberCount: invite.memberCount ?? 0,
    establishedAt: ulidTime(invite.serverId),
    joined: isMember(invite.serverId),
  };
}

/**
 * "Oct 2024" in the app locale (`i18n.locale`, which may use `_`), for the
 * card's "Est." line
 */
export function formatEstablished(
  at: number,
  locale: string | undefined,
): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    year: "numeric",
  };
  try {
    return new Intl.DateTimeFormat(
      (locale ?? "en").replace(/_/g, "-"),
      options,
    ).format(at);
  } catch {
    return new Intl.DateTimeFormat("en", options).format(at);
  }
}

/**
 * tanstack-query `retry` for the invite fetch. An API answer (`NotFound` for a
 * bad code, a ban, a rate limit) is final, so it shows at once instead of after
 * three retries; a network failure is retried twice.
 */
export function retryInviteFetch(
  failureCount: number,
  error: unknown,
): boolean {
  if (apiErrorType(error) !== undefined) return false;
  return failureCount < 2;
}
