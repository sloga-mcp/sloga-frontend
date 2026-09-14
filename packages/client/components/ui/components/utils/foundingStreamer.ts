import { User, UserBadges } from "stoat.js";

/**
 * Founding Streamer name color.
 *
 * The single definition in the frontend: every surface that paints a
 * Founding Streamer's name or accent must read it from here, never inline the
 * hex. Names get it through `DisplayName`, as the last color fallback.
 */
export const FOUNDING_STREAMER_COLOUR = "#8B5CF6";

/**
 * Whether this user carries the Founding Streamer badge.
 *
 * The bit itself has exactly one definition per repo — `UserBadges` in
 * stoat.js — so it is tested through the enum and never hard-coded here.
 *
 * Deliberately tolerant of a missing user and a missing `badges` field: in a
 * large server's member list `member.user` is genuinely undefined on the first
 * paint, and a row that threw there would take the whole list with it.
 *
 * This is NOT the staff check. Staff (`isSlogaStaff`) keep their own brand
 * treatment and its priority; neither predicate implies the other.
 */
export function isFoundingStreamer(user?: User | null): boolean {
  return ((user?.badges ?? 0) & UserBadges.FoundingStreamer) !== 0;
}
