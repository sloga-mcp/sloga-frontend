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
 * The remote-facing install entries: the previous epoch's REMOTE senders (they
 * occupy the old keyring indices so a lagging receiver keeps decrypting the old
 * epoch) followed by the current epoch's REMOTE senders. Installing these never
 * touches our own send index.
 *
 * The LOCAL identity is deliberately excluded from `previous[]` (slice 6.4): the
 * native egress derives `previous` over the CURRENT roster (mod.rs:1394-1399),
 * so it INCLUDES the local device's own previous-epoch key. Installing that key
 * would set our send index back to the previous epoch — harmless on an
 * Add-driven rotation but, on a Remove-driven one, it re-affirms a send key the
 * just-removed member still holds for a moment (the invariant-7 window C1
 * closes). We never need our own previous key (we don't decrypt ourselves), so
 * the local identity is only ever installed at the CURRENT epoch, LAST.
 */
export function remoteInstallEntries(
  frameKeys: MlsFrameKeys,
  localIdentity: string,
): MlsFrameKey[] {
  const previousRemotes = (frameKeys.previous ?? []).filter(
    (k) => k.livekit_identity !== localIdentity,
  );
  const currentRemotes = frameKeys.keys.filter(
    (k) => k.livekit_identity !== localIdentity,
  );
  return [...previousRemotes, ...currentRemotes];
}

/**
 * The current-epoch LOCAL send-key entry(ies) — installing this IS the
 * send-index switch (§1.5), so it is always the LAST `onSetEncryptionKey` call.
 * On an Add-driven rotation the session defers this behind the ≤2 s Add-grace
 * (`applyLocalKey`); everywhere else it rides `applyKeys` immediately.
 */
export function localInstallEntries(
  frameKeys: MlsFrameKeys,
  localIdentity: string,
): MlsFrameKey[] {
  return frameKeys.keys.filter((k) => k.livekit_identity === localIdentity);
}

/**
 * Full install order: previous(remote-only) → current remotes → current LOCAL
 * last. The local participant's `setKey` IS the send-index switch (§1.5), so it
 * must be the final call.
 */
export function orderForInstall(
  frameKeys: MlsFrameKeys,
  localIdentity: string,
): MlsFrameKey[] {
  return [
    ...remoteInstallEntries(frameKeys, localIdentity),
    ...localInstallEntries(frameKeys, localIdentity),
  ];
}

export class MlsKeyProvider extends BaseKeyProvider {
  /** Identities that currently hold a key (reconnect / test hygiene). */
  #applied = new Set<string>();

  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 });
  }

  /** Import one entry's raw HKDF material and push it to the worker. */
  async #install(entries: MlsFrameKey[]): Promise<string[]> {
    const installed: string[] = [];
    for (const entry of entries) {
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
      installed.push(entry.livekit_identity);
    }
    return installed;
  }

  /**
   * Install the native-derived frame keys for the current epoch (+ the
   * previous epoch's remote senders during a rotation overlap), INCLUDING the
   * local send key last. `localIdentity` is the LiveKit token identity
   * `"{user_id}:{device_id}"` (6.1 device-qualified). Idempotent: safe to call
   * on every epoch change and on every LiveKit reconnect.
   *
   * This is the IMMEDIATE install mode (§1.5): Remove-driven rotations (switch
   * the send key at once so a removed member is locked out), the FIRST key of a
   * group, the fail-safe on an unclassifiable epoch, and reconnect re-assert.
   * An Add-driven rotation instead uses `applyRemoteKeys` now + a deferred
   * `applyLocalKey` after the Add-grace (the session owns that timing — slice
   * 6.4 step 4; the provider only exposes the two halves).
   *
   * Hygiene (§4.2): LiveKit 2.15.13 exposes NO key-deletion API, so a removed
   * leaf's `ParticipantKeyHandler` lingers until the call ends (the
   * documented §7.2 residual — the worker is terminated at call end). What we
   * CAN enforce, and do: (a) install only the current(+previous) epoch keys
   * native returns, never an older set; (b) never reassert a since-removed
   * sender's key (it simply is not in the native set); (c) never re-install our
   * OWN previous-epoch key (excluded from `remoteInstallEntries`), so a
   * Remove-immediate can never transiently regress our send index; (d) the RTC
   * layer re-invokes native for the CURRENT set on reconnect rather than
   * trusting LiveKit's stale `getKeys()` replay (invariant 7 edge).
   */
  async applyKeys(
    frameKeys: MlsFrameKeys,
    localIdentity: string,
  ): Promise<void> {
    await this.applyRemoteKeys(frameKeys, localIdentity);
    await this.applyLocalKey(frameKeys, localIdentity);
  }

  /**
   * Install previous(remote-only) + current REMOTE senders — everything EXCEPT
   * the local send key, so the send index is left untouched. The Add-grace path
   * (§1.5): remotes are keyed now while we keep publishing on the old local key
   * (already installed from the previous epoch's `applyLocalKey`) for ≤2 s so
   * lagging receivers advance to the new epoch before we switch.
   */
  async applyRemoteKeys(
    frameKeys: MlsFrameKeys,
    localIdentity: string,
  ): Promise<void> {
    const installed = await this.#install(
      remoteInstallEntries(frameKeys, localIdentity),
    );
    const live = new Set(installed);
    // Keep the record of an already-installed local key: during an Add-grace we
    // are still publishing on it — it is live, just not re-installed here.
    if (this.#applied.has(localIdentity)) live.add(localIdentity);
    this.#applied = live;
  }

  /**
   * Install the current-epoch LOCAL send key — THE send-index switch (§1.5),
   * always the final `onSetEncryptionKey`. Immediate rotations call it inline
   * via `applyKeys`; Add-driven rotations call it after the epoch-fenced grace.
   */
  async applyLocalKey(
    frameKeys: MlsFrameKeys,
    localIdentity: string,
  ): Promise<void> {
    const installed = await this.#install(
      localInstallEntries(frameKeys, localIdentity),
    );
    if (installed.length) this.#applied.add(localIdentity);
  }

  /** Identities currently keyed (current + previous epoch senders). */
  appliedIdentities(): ReadonlySet<string> {
    return this.#applied;
  }
}
