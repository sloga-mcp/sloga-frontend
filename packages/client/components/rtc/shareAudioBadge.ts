/**
 * Which audio badge a screen-share tile shows (Android screen share slice 4,
 * Design section 7), kept import-free so `node --test` can load it.
 *
 * The caller computes the three inputs from the Room's publications for the
 * sharing participant: whether a `ScreenShareAudio` publication exists, and
 * if so whether the publisher muted it, plus the local viewer's own per-user
 * mute for that sharer. `ParticipantTile` re-reads them whenever
 * `voice.sharePubVersion()` changes (bumped on track published, unpublished,
 * muted and unmuted), so the badge follows a publication that arrives or
 * leaves mid-share. That wiring is the tile's job, not this leaf's.
 *
 * Why this exists: before slice 4 the tile asked components-core whether the
 * `ScreenShareAudio` source was muted, and its observer answers
 * `pub?.isMuted ?? true`. A share with NO audio publication therefore read as
 * "muted", and every audio-less share (every Android share until now, and any
 * desktop or web share started without audio) carried the grey `no_sound`
 * badge. Viewers took that as a mute they could undo and could not (the
 * Retroid tester's "muted, can't unmute" report). The caller must therefore
 * derive `hasAudioPub` from an actual publication lookup, never from that
 * observer, which cannot tell "absent" from "muted".
 */

/**
 * The tile's screen-share audio badge.
 *
 * - `"none"`: audio is published and playing for this viewer; no badge.
 * - `"user-muted"`: the local viewer muted this sharer's audio themselves
 *   (the red `no_sound` badge, unchanged from before slice 4).
 * - `"muted"`: the publisher muted their share audio (the grey `no_sound`
 *   badge, unchanged from before slice 4 for shares that have audio).
 * - `"no-audio"`: the share has no audio track at all. Grey icon with the
 *   tooltip "This screen share has no audio"; never presented as a mute.
 */
export type ShareAudioBadge = "none" | "user-muted" | "muted" | "no-audio";

/**
 * Pick the badge for one screen-share tile.
 *
 * Precedence, first match wins:
 *
 * 1. `!hasAudioPub` gives `"no-audio"`. There is nothing to unmute, so the
 *    badge must not look like a mute. This deliberately outranks the
 *    viewer's own mute: before slice 4 the tile showed the red "by-user"
 *    badge whenever the viewer had muted the sharer, even with no audio
 *    publication at all, which claims the viewer is silencing a track that
 *    does not exist. The per-user preference is kept in voice state, so if
 *    the sharer later publishes audio the next re-read shows "user-muted".
 *    `pubMuted` is meaningless without a publication and is ignored here.
 * 2. `userMuted` gives `"user-muted"`. The viewer's own choice is the one
 *    they can act on, so it outranks the publisher's mute: if both apply,
 *    the viewer still has to unmute locally to hear anything.
 * 3. `pubMuted` gives `"muted"`: the publisher muted it; the viewer can do
 *    nothing about that.
 * 4. Otherwise `"none"`.
 */
export function shareAudioBadge(w: {
  hasAudioPub: boolean;
  pubMuted: boolean;
  userMuted: boolean;
}): ShareAudioBadge {
  if (!w.hasAudioPub) return "no-audio";
  if (w.userMuted) return "user-muted";
  if (w.pubMuted) return "muted";
  return "none";
}
