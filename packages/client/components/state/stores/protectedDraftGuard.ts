/**
 * Protected channels: the Draft store's protected-channel lookup (W4 lane
 * A7, plan D9d/D9e).
 *
 * `Draft.addFile` must refuse files for a Protected channel, but the Draft
 * store has no client handle. A module-level resolver closes that gap: the
 * bridge seam (B5) and the client wiring (C5) install one backed by
 * `client.isProtectedChannel`, and `addFile` asks `isProtectedForDraft`.
 *
 * UX only. With no resolver installed the answer is `false`, so `addFile`
 * behaves as today; the real never-plaintext guard is `sendDraft`'s own
 * `client.isProtectedChannel(channelId)` check, which refuses files before
 * any pop or upload (D9e). A resolver that throws answers `true` (refusing a
 * file is the safe direction).
 *
 * Kept free of imports so `node --test` can load it.
 */

/** Whether a channel is protected (server flag or local pin). */
export type ProtectedChannelResolver = (channelId: string) => boolean;

let resolver: ProtectedChannelResolver | null = null;

/**
 * Install the resolver, replacing any previous one; `null` uninstalls it
 * (logout, client teardown).
 * @param fn The lookup, or null
 */
export function setProtectedChannelResolver(
  fn: ProtectedChannelResolver | null,
): void {
  resolver = fn;
}

/**
 * Whether the Draft store should treat `channelId` as protected.
 * @param channelId Channel id
 * @returns false with no resolver installed; true when the resolver throws
 */
export function isProtectedForDraft(channelId: string): boolean {
  const fn = resolver;
  if (!fn) return false;
  try {
    return !!fn(channelId);
  } catch {
    return true;
  }
}
