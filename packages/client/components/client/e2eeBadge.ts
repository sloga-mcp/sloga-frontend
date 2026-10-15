/**
 * Encryption badge for a DM or group conversation (chat windows plan D5).
 *
 * Pure so the composer indicator and the chat-window badge read one
 * decision and can never disagree. It fails closed: "encrypted" comes ONLY
 * from the native send mode `"encrypt"` (pinned keys + sticky marker, the
 * one local-truth state), never from a default, a server hint or
 * `channelTrust` (which counts blocked/downgraded as encrypted).
 *
 * Inputs:
 * - `mode`: the `E2EEBridge.sendModes` entry for the conversation (peer user
 *   id for a DM, channel id for a group); undefined until primed.
 * - `selfEnabled`: E2EE enabled AND published on THIS device (the
 *   composer's `selfE2EEEnabled`).
 * - `peerAdvertises`: the DM peer's server-advertised opt-in. A HINT only:
 *   a server could lie about it, so it can reach "pending" but never
 *   "encrypted".
 * - `e2eeLoaded`: this device's E2EE status is known (native status read,
 *   or no native layer at all, which is known off). `selfEnabled` only
 *   counts once this is true.
 *
 * | mode            | isGroup | loaded | self | peer | badge         | composer today  |
 * |-----------------|---------|--------|------|------|---------------|-----------------|
 * | encrypt         | any     | any    | any  | any  | encrypted     | encrypt         |
 * | blocked         | any     | any    | any  | any  | warning       | blocked         |
 * | peer_downgraded | any     | any    | any  | any  | warning       | peer_downgraded |
 * | plaintext       | group   | any    | any  | any  | not_encrypted | (none)          |
 * | plaintext       | DM      | no     | any  | any  | null          | (none) [1]      |
 * | plaintext       | DM      | yes    | yes  | yes  | pending       | pending         |
 * | plaintext       | DM      | yes    | yes  | no   | not_encrypted | unencrypted     |
 * | plaintext       | DM      | yes    | no   | any  | not_encrypted | (none)          |
 * | undefined       | any     | no     | any  | any  | null          | (none)          |
 * | undefined       | any     | yes    | no   | any  | not_encrypted | (none)          |
 * | undefined       | any     | yes    | yes  | any  | null          | (none)          |
 *
 * A known send mode wins over everything else because it is the native
 * verdict the send path itself uses. With the mode unknown, E2EE known to be
 * off on this device still answers "not_encrypted"; anything else unknown is
 * null (not loaded / not primed yet). A plaintext DM with the device status
 * unknown is null rather than "not_encrypted": with both sides opted in the
 * first send establishes a session, so "pending" might be the truth.
 *
 * [1] Unreachable from the hook (an unloaded status reads as self off). The
 * pure composer view below treats `selfEnabled` as false until loaded so the
 * two stay consistent on every input.
 */

export type E2EESendMode =
  | "encrypt"
  | "blocked"
  | "plaintext"
  | "peer_downgraded";

export type E2EEBadge = "encrypted" | "not_encrypted" | "pending" | "warning";

export type E2EEBadgeInput = {
  mode?: E2EESendMode;
  isGroup: boolean;
  selfEnabled: boolean;
  peerAdvertises: boolean;
  e2eeLoaded: boolean;
};

export function e2eeBadgeFor(i: E2EEBadgeInput): E2EEBadge | null {
  switch (i.mode) {
    case "encrypt":
      return "encrypted";
    case "blocked":
    case "peer_downgraded":
      return "warning";
    case "plaintext":
      if (i.isGroup) return "not_encrypted";
      if (!i.e2eeLoaded) return null;
      return i.selfEnabled && i.peerAdvertises ? "pending" : "not_encrypted";
    case undefined:
      if (!i.e2eeLoaded) return null;
      return i.selfEnabled ? null : "not_encrypted";
    default: {
      // A new native mode must be classified here, not fall through as safe
      const exhaustive: never = i.mode;
      void exhaustive;
      return null;
    }
  }
}

/** The composer's indicator states (`Composition.tsx` `e2eeMode`) */
export type ComposerE2EEMode =
  | "encrypt"
  | "blocked"
  | "peer_downgraded"
  | "pending"
  | "unencrypted"
  | undefined;

/**
 * The composer indicator, derived FROM the badge so the two cannot disagree.
 * It only adds the two distinctions the composer draws that the badge does
 * not: which warning (they clear through different flows), and the red
 * "unencrypted" mismatch (this device opted in, the DM peer has not) versus
 * no indicator at all.
 */
export function composerE2EEModeFor(i: E2EEBadgeInput): ComposerE2EEMode {
  switch (e2eeBadgeFor(i)) {
    case "encrypted":
      return "encrypt";
    case "warning":
      return i.mode === "peer_downgraded" ? "peer_downgraded" : "blocked";
    case "pending":
      return "pending";
    case "not_encrypted":
      return !i.isGroup &&
        i.mode === "plaintext" &&
        i.e2eeLoaded &&
        i.selfEnabled
        ? "unencrypted"
        : undefined;
    default:
      return undefined;
  }
}
