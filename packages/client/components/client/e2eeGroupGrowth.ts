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
 * Whether a group-growth preflight fetches a user's key bundle. Each fetch
 * spends one of that user's one-time keys, so only where native would
 * otherwise answer `needs_bundle`: a member with no Active pinned device,
 * or an Active device without an active session. Self skips the local
 * device and needs no other device (own-device fan-out may be empty). A
 * user with an identity-changed device is skipped: native refuses the send
 * with `peer_identity_changed` whatever bundle it is given.
 */
export function groupGrowthNeedsBundle(
  devices: {
    device_id: string;
    status: string;
    has_active_session: boolean;
  }[],
  isSelf: boolean,
  localDeviceId: string | null | undefined,
): boolean {
  if (devices.some((d) => d.status === "identity_changed")) return false;
  const active = devices.filter(
    (d) => d.status === "active" && !(isSelf && d.device_id === localDeviceId),
  );
  if (!isSelf && active.length === 0) return true;
  return active.some((d) => !d.has_active_session);
}
