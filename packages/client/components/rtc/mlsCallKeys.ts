/**
 * MlsKeyProvider — media E2EE key provider (slice 6.3).
 *
 * Productionizes the 6.0 spike's `SpikeKeyProvider` (now deleted). Installs
 * the NATIVE-derived, per-sender frame keys — the documented invariant-6
 * egress (plan §7.2) — into the LiveKit E2EE worker.
 *
 * Two correctness rules the whole media plane rests on:
 *
 *  1. Each `frame_key` is 32 bytes of raw HKDF key MATERIAL, imported as
 *     `'HKDF'` — NEVER an AES-GCM `CryptoKey`. The worker's `deriveKeys`
 *     runs its own HKDF (fixed public salt `"LKFrameEncryptionKey"`) over the
 *     material to get the effective AES-128-GCM key; handing it an AES-GCM
 *     key throws `InvalidAccessError` on every `setKey` and drops all frames
 *     (audit HIGH, §4.2 — the exact failure the 6.0 spike proved is avoided).
 *  2. MLS epochs are the ONLY rotation mechanism: `sharedKey:false`
 *     (per-participant keys), `ratchetWindowSize:0` + `failureTolerance:0`
 *     (LiveKit's sframe self-ratchet disabled) so a "ratcheted" key can never
 *     diverge from MLS-derived truth (§1.5).
 */
import { BaseKeyProvider } from "livekit-client";

import type { MlsFrameKey, MlsFrameKeys } from "@revolt/client";

/** Decode unpadded standard base64 (native emits `STANDARD_NO_PAD`). */
function base64ToBytes(b64: string): Uint8Array {
  // `atob` is lenient about padding, but pad defensively for strict engines.
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Order the entries for installation: previous-epoch first (they occupy the
 * old keyring indices so lagging receivers keep decrypting the old epoch),
 * then current-epoch remotes, then the current-epoch LOCAL entry LAST —
 * because the local participant's `setKey` IS the send-index switch (§1.5),
 * it must be the final `onSetEncryptionKey` call.
 */
export function orderForInstall(
  frameKeys: MlsFrameKeys,
  localIdentity: string,
): MlsFrameKey[] {
  const previous = frameKeys.previous ?? [];
  const current = frameKeys.keys;
  const remotes = current.filter((k) => k.livekit_identity !== localIdentity);
  const local = current.filter((k) => k.livekit_identity === localIdentity);
  return [...previous, ...remotes, ...local];
}

export class MlsKeyProvider extends BaseKeyProvider {
  /** Identities that currently hold a key (reconnect / test hygiene). */
  #applied = new Set<string>();

  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 });
  }

  /**
   * Install the native-derived frame keys for the current epoch (+ the
   * previous epoch during an Add-grace rotation overlap). `localIdentity` is
   * the LiveKit token identity `"{user_id}:{device_id}"` (6.1
   * device-qualified). Idempotent: safe to call on every epoch change and on
   * every LiveKit reconnect.
   *
   * Hygiene (§4.2): LiveKit 2.15.13 exposes NO key-deletion API, so a removed
   * leaf's `ParticipantKeyHandler` lingers until the call ends (the
   * documented §7.2 residual — the worker is terminated at call end). What we
   * CAN enforce, and do: (a) install only the current(+previous) epoch keys
   * native returns, never an older set; (b) never reassert a since-removed
   * sender's key (it simply is not in the native set); (c) the RTC layer
   * re-invokes native for the CURRENT set on reconnect rather than trusting
   * LiveKit's stale `getKeys()` replay — so a just-removed member can never
   * resume being sent on an old-epoch key still held by since-departed
   * members (invariant 7 edge).
   */
  async applyKeys(
    frameKeys: MlsFrameKeys,
    localIdentity: string,
  ): Promise<void> {
    const ordered = orderForInstall(frameKeys, localIdentity);
    const live = new Set<string>();
    for (const entry of ordered) {
      const material = await crypto.subtle.importKey(
        "raw",
        base64ToBytes(entry.frame_key_b64),
        "HKDF",
        false,
        ["deriveBits", "deriveKey"],
      );
      // BaseKeyProvider.onSetEncryptionKey(keyMaterial, identity, keyIndex).
      this.onSetEncryptionKey(
        material,
        entry.livekit_identity,
        entry.key_index,
      );
      live.add(entry.livekit_identity);
    }
    this.#applied = live;
  }

  /** Identities currently keyed (current + previous epoch senders). */
  appliedIdentities(): ReadonlySet<string> {
    return this.#applied;
  }
}
