/**
 * Voice/LiveKit participant identities have been DEVICE-QUALIFIED since E2EE
 * slice 6.1/6.4 — the SFU identity is `"{user_id}:{device_id}"` so media frame
 * keys can be matched per device. Resolving a Sloga user for DISPLAY (name /
 * avatar / per-user settings) must therefore use the USER id only: passing the
 * raw device-qualified identity to `useUser` finds no user and the tile falls
 * back to "Unknown User".
 *
 * Non-E2EE / not-yet-provisioned calls carry a bare `user_id` with no
 * `:device_id`, so this is idempotent — safe to apply everywhere a participant
 * identity is turned into a user. Keep the FULL `participant.identity` for
 * track/keying paths; only strip for display lookups.
 */
export function participantUserId(identity: string): string {
  return identity.split(":")[0];
}
