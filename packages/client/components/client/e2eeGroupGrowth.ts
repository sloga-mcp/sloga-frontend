/**
 * Pure decisions behind native-confirm-gated group growth (turning
 * encryption on for a group, or including a member), kept out of `e2ee.ts`
 * so they run under `node --test`. Import-free on purpose. `e2ee.ts`
 * re-exports everything here.
 */

/**
 * How a native-confirm-gated group growth ended. Before an encrypted
 * group's audience grows, the shells show a NATIVE OS dialog the webview
 * cannot draw or answer. `declined` (the user pressed Cancel) and `busy`
 * (another growth dialog is open, or a recent decline locked this group's
 * prompt) are answers, not failures: nothing was written natively, so they
 * resolve and the caller shows no error toast. Every other refusal still
 * throws its typed native error.
 */
export type GroupGrowthOutcome = "ok" | "declined" | "busy";

/**
 * The outcome a native group-growth rejection resolves as, or null when it
 * is a real failure the caller rethrows. Read defensively: the IPC hands
 * back untyped values.
 */
export function groupGrowthOutcomeOf(
  error: unknown,
): Exclude<GroupGrowthOutcome, "ok"> | null {
  const type =
    typeof error === "object" && error !== null
      ? (error as { type?: unknown }).type
      : undefined;
  if (type === "declined") return "declined";
  if (type === "busy") return "busy";
  return null;
}

/**
 * Labels for the native growth dialog's member lines: user id to
 * `username#discriminator` (unique on the server, so harder to imitate
 * than a display name), else the bare username. A user with neither is
 * left out and the dialog shows the bare id. Labels only: the member list,
 * count and trust status come from native code, which also sanitizes
 * these strings.
 */
export function groupGrowthDisplayNames(
  userIds: Iterable<string>,
  lookup: (
    userId: string,
  ) => { username?: string; discriminator?: string } | undefined,
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const id of userIds) {
    const user = lookup(id);
    const username = user?.username;
    if (!username) continue;
    names[id] = user.discriminator
      ? `${username}#${user.discriminator}`
      : username;
  }
  return names;
}

/** The parts of native `GroupState` the roster rule reads */
export type GroupRosterState = {
  encrypted_since: number | null;
  members: { user_id: string; status: string }[];
};

/**
 * The roster an enable asserts (group growth m3). A group native already
 * holds as encrypted accepts only a re-send of its own Active set (any
 * other roster is refused `roster_mismatch`; growth goes through include),
 * so that roster comes from native `group_state`, not from the displayed
 * members. A group with no native state (fresh) or a downgraded one
 * (re-enable: the audience becomes exactly what the user confirms) keeps
 * `requested`.
 */
export function groupEnableRoster(
  state: GroupRosterState | null,
  requested: string[],
): string[] {
  if (typeof state?.encrypted_since !== "number") return requested;
  if (!Array.isArray(state.members)) return requested;
  return state.members
    .filter((m) => m.status === "active")
    .map((m) => m.user_id);
}

/**
 * The ids an enable's native dialog may list, for its `displayNames`: the
 * roster it asserts plus every member in native `group_state`. A
 * re-enable's "will stop receiving" lines name members who are in the
 * native state but not in the roster; left out, those lines show a bare id.
 */
export function groupEnableNamedIds(
  roster: Iterable<string>,
  state: GroupRosterState | null,
): Set<string> {
  const ids = new Set(roster);
  if (Array.isArray(state?.members)) {
    for (const m of state.members) {
      if (typeof m?.user_id === "string") ids.add(m.user_id);
    }
  }
  return ids;
}

/**
 * Whether a group-growth preflight fetches a user's key bundle. Each fetch
 * spends one of that user's one-time keys, so only where native would
 * otherwise answer `needs_bundle`, or cannot ask for one:
 * - self while `selfUnpinned` (a reconcile reported own devices not yet
 *   pinned): native pins own devices only from a self bundle and never
 *   answers `needs_bundle` for self, so this fetches whatever `devices`
 *   holds;
 * - a member with no Active pinned device (none at all, or all revoked);
 * - an Active device without an active session.
 * Self skips the local device and needs no other device (own-device
 * fan-out may be empty). Otherwise a user with an identity-changed device
 * is skipped: native refuses the send with `peer_identity_changed`
 * whatever bundle it is given.
 */
export function groupGrowthNeedsBundle(
  devices: {
    device_id: string;
    status: string;
    has_active_session: boolean;
  }[],
  isSelf: boolean,
  localDeviceId: string | null | undefined,
  selfUnpinned: boolean,
): boolean {
  if (isSelf && selfUnpinned) return true;
  if (devices.some((d) => d.status === "identity_changed")) return false;
  const active = devices.filter(
    (d) => d.status === "active" && !(isSelf && d.device_id === localDeviceId),
  );
  if (!isSelf && active.length === 0) return true;
  return active.some((d) => !d.has_active_session);
}
