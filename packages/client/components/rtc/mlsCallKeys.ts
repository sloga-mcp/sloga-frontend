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
 *  3. `getKeys()` is OVERRIDDEN to serve only the current install set, because
 *     LiveKit replays it into the worker behind our back and the base class's
 *     answer goes stale after sixteen epochs. See the override for the full
 *     account — it is a send-path invariant, not a tidiness measure.
 *  4. Every path that could leave this device publishing under a key it should
 *     not is LOUD, never silent: an epoch with no entry for us throws rather
 *     than reporting the send key installed, and an install the group has
 *     already moved past is refused by the `(group, epoch)` fence.
 */
import { type KeyInfo, BaseKeyProvider } from "livekit-client";

import type { MlsFrameKey, MlsFrameKeys } from "@revolt/client";

import type { LegSendKey } from "./androidLegStartPolicy";

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
 * The send key handed to this device's native screen leg (§5.1/§5.2):
 * `keyB64` (32 bytes of raw HKDF material, unpadded standard base64),
 * `keyIndex` (the LiveKit keyring index, `epoch mod 16`), `epoch` (the fence
 * a stale push is caught by) and `groupId` (the group the epoch counts
 * under — epochs are only comparable within one group, so consumers must
 * treat a cross-group key as unrelatable, neither newer nor older, and fail
 * closed rather than compare).
 *
 * ONE canonical declaration, aliased from the policy leaf rather than
 * restated: the bridge shape and the start policy derive from the same type,
 * so a field added here cannot silently go un-fenced on the way to native.
 */
export type LocalScreenKey = LegSendKey;

/**
 * This device's SCREEN LEG entry for the current epoch (Android plan §5.1).
 *
 * e2ee-core derives one leg key per roster MEMBER, so `frameKeys.keys` carries
 * a `{user}:{device}:screen` entry for everybody. Only OUR OWN is a send key;
 * every other member's is a receive key installed as an ordinary remote —
 * `remoteInstallEntries` filters on the exact local identity, so our own leg
 * entry falls through into the remote set too. That is harmless and left
 * alone: the phone never subscribes to its own leg (§0.9), so the key is
 * simply never used on the receive side.
 *
 * Read from `keys` (the CURRENT epoch) and never from `previous`: the leg is a
 * SENDER, and handing a sender an old epoch's key is exactly the invariant-7
 * regression `remoteInstallEntries` excludes the local identity to prevent.
 */
export function localScreenLegEntry(
  frameKeys: MlsFrameKeys,
  localIdentity: string,
): MlsFrameKey | undefined {
  return frameKeys.keys.find(
    (k) => k.livekit_identity === `${localIdentity}:screen`,
  );
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

/**
 * A key this provider actually installed. `KeyInfo` makes `participantIdentity`
 * and `keyIndex` optional because the base class also serves a `sharedKey`
 * provider; we run `sharedKey:false`, where the worker treats a keyless entry
 * as a hard error (`e2ee.worker.ts` — "no participant Id was provided"). Naming
 * that in the TYPE means `tsc` carries the invariant instead of a spec.
 */
export type InstalledKey = KeyInfo & {
  participantIdentity: string;
  keyIndex: number;
};

/** The base class's map key for an installed entry (`KeyProvider.ts:37`). */
function retainedId(info: InstalledKey): string {
  return `${info.participantIdentity}-${info.keyIndex}`;
}

/**
 * `BaseKeyProvider`'s retained key map — TypeScript-`private`, but plainly
 * reachable at runtime — reached through this ONE accessor.
 *
 * It exists so `#pruneRetainedKeys` can drop material the provider no longer
 * serves. The map is write-only from the library's side once `getKeys()` is
 * overridden (nothing else reads it), so pruning it changes no behavior; what
 * it buys is that a call's older epochs stop sitting in main-thread memory as
 * `deriveKey`-capable `CryptoKey`s whose derivation salt is a public constant.
 *
 * Exported for the spec, which asserts the map really does shrink: if a LiveKit
 * upgrade renames the field this returns `undefined`, the prune silently
 * becomes a no-op, and that spec is what turns the silence into a CI failure.
 */
export function retainedKeyMap(
  provider: BaseKeyProvider,
): Map<string, KeyInfo> | undefined {
  const map = (provider as unknown as { keyInfoMap?: unknown }).keyInfoMap;
  return map instanceof Map ? (map as Map<string, KeyInfo>) : undefined;
}

export class MlsKeyProvider extends BaseKeyProvider {
  /**
   * The current epoch's REMOTE install set, in `orderForInstall` order, kept
   * verbatim as the `KeyInfo` records handed to LiveKit. Replaced wholesale on
   * every `applyRemoteKeys`, which is what drops a since-removed sender.
   */
  #replayRemotes: InstalledKey[] = [];

  /**
   * The LOCAL send key currently in force — the one the encoder is publishing
   * under. Replaced only by `applyLocalKey`, so it survives an Add-grace
   * `applyRemoteKeys` (during which we ARE still sending on the old key).
   */
  #replayLocal: InstalledKey[] = [];

  /**
   * `(group, epoch)` of the newest install in force — the monotonic fence.
   *
   * `onLocalKeysChanged` is driven fire-and-forget from the native push and is
   * not serialized, and it awaits `callFrameKeys` before installing. Two pushes
   * in quick succession (an Add at N+1, a Remove at N+2) can therefore have
   * their IPC replies land out of order, and N+1's continuation would then
   * install AFTER N+2 — walking the send index back onto an epoch the member
   * N+2 removed still holds. The session fences this at its own end too; this
   * is the invariant restated where the keys actually change hands, so no
   * future caller can reintroduce it.
   */
  #fence: { groupId: string; epoch: number } | undefined;

  /**
   * This device's current screen-leg send key (Android plan §5.2).
   *
   * THE ONLY place leg key material is held in JS. It is kept here rather than
   * in `rtc/state.tsx` because this is the one layer that sees `MlsFrameKeys`
   * at all — and, more importantly, because every rule that decides WHEN the
   * local send key becomes current (the ≤2 s Add-grace deferral, the NEW-1
   * epoch fence, the Remove-immediate switch, an equal-epoch re-assert) already
   * terminates in `applyLocalKey`. Reading the leg key anywhere else means
   * re-deriving those rules, and getting them wrong means the phone encrypts
   * under a key a just-removed member still holds.
   */
  #lastLocalScreenKey: LocalScreenKey | undefined;

  /**
   * Notified whenever this device's leg send key changes — the Android branch
   * forwards it to `plugin.setFrameKey` (slice 3).
   *
   * 🔴 The listener OWNS its failure. It is awaited inside `applyLocalKey`, so
   * a rotation does not report the local key installed until the phone has
   * taken the new one — that ordering is the whole point on a Remove-driven
   * rotation. A listener that cannot push MUST stop the leg (`plugin.stop()` +
   * a toast) and resolve: a leg left running on the previous epoch's key is
   * readable by the member who was just removed. If it rejects instead, the
   * rejection reaches the session's media-error path and the call goes loud —
   * a deliberate backstop, not the intended path.
   */
  onLocalScreenKey?: (key: LocalScreenKey) => void | Promise<void>;

  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 });
  }

  /**
   * The leg send key for the CURRENT epoch, or undefined before the first
   * local install. Read by the Android publisher at `plugin.connect()` time,
   * which is why it is exposed rather than only pushed: a leg starting
   * mid-call has to be handed the key that is already current, and there is no
   * rotation event to wait for.
   */
  lastLocalScreenKey(): LocalScreenKey | undefined {
    return this.#lastLocalScreenKey;
  }

  /**
   * Import each entry's raw HKDF material. Touches NOTHING else — no key
   * reaches the worker here.
   *
   * Importing the whole set before publishing any of it is deliberate.
   * `importKey` yields to the event loop, so posting inside this loop would
   * leave the worker holding keys the replay set does not list yet, and a
   * replay landing in that gap would re-post the PREVIOUS set on top of them.
   * It also makes an install atomic: an entry that fails to import means the
   * worker took none of them, rather than a half-keyed epoch nobody records.
   */
  async #import(entries: MlsFrameKey[]): Promise<InstalledKey[]> {
    const imported: InstalledKey[] = [];
    for (const entry of entries) {
      const material = await crypto.subtle.importKey(
        "raw",
        base64ToBytes(entry.frame_key_b64),
        "HKDF",
        false,
        ["deriveBits", "deriveKey"],
      );
      imported.push({
        key: material,
        participantIdentity: entry.livekit_identity,
        keyIndex: entry.key_index,
      });
    }
    return imported;
  }

  /**
   * Hand an imported set to LiveKit and record it as the replayable one — ONE
   * synchronous block, so `getKeys()` can never describe a worker state that
   * has not happened yet, or miss one that has.
   *
   * `onSetEncryptionKey` reaches the worker synchronously (the base class emits
   * `SetKey`, which `E2EEManager` turns straight into a `postMessage`), and a
   * worker message is a macrotask; nothing between these statements yields, so
   * no replay can observe the two halves disagreeing.
   */
  #publish(infos: InstalledKey[], slot: "remotes" | "local"): void {
    if (slot === "remotes") this.#replayRemotes = infos;
    else this.#replayLocal = infos;
    for (const info of infos) {
      // BaseKeyProvider.onSetEncryptionKey(keyMaterial, identity, keyIndex).
      this.onSetEncryptionKey(
        info.key,
        info.participantIdentity,
        info.keyIndex,
      );
    }
    this.#pruneRetainedKeys();
  }

  /**
   * Drop everything the base class retained that `getKeys()` no longer serves
   * (§7.2 residual). The worker's own keyring cannot be pruned — LiveKit
   * exposes no deletion API and never destroys a `ParticipantKeyHandler` — but
   * the main-thread copy can be, and after the `getKeys()` override nothing
   * reads it, so keeping a since-removed sender's material there buys nothing.
   */
  #pruneRetainedKeys(): void {
    const retained = retainedKeyMap(this);
    if (!retained) return;
    const live = new Set(this.getKeys().map(retainedId));
    for (const id of [...retained.keys()]) {
      if (!live.has(id)) retained.delete(id);
    }
  }

  /**
   * Whether an install may proceed, given what is already in force.
   *
   * A DIFFERENT group resets rather than compares: epochs only count within one
   * group, so a cross-group number is neither newer nor older and the old
   * group's keys must simply go. Within one group the rule is monotonic —
   * an equal epoch is an idempotent re-assert (the Add-grace's deferred local
   * install rides one), a lower one has been superseded and must do nothing.
   *
   * An egress with no usable epoch is ADMITTED, not refused: this fence is
   * defense in depth behind the session's own `#installEpoch` check, and a
   * fence that wedged rotation on a malformed field would be worse than the
   * race it guards.
   */
  #admits(frameKeys: MlsFrameKeys): boolean {
    const fence = this.#fence;
    if (!fence) return true;
    if (fence.groupId !== frameKeys.group_id) {
      this.resetForGroup();
      return true;
    }
    if (!Number.isFinite(frameKeys.epoch)) return true;
    return frameKeys.epoch >= fence.epoch;
  }

  /** Record the epoch now in force (see `#admits`). */
  #stamp(frameKeys: MlsFrameKeys): void {
    if (!Number.isFinite(frameKeys.epoch)) return;
    this.#fence = { groupId: frameKeys.group_id, epoch: frameKeys.epoch };
  }

  /**
   * Drop every key held for the OUTGOING group — called when the group is
   * being REPLACED (`#resetRotationState`: a re-establish, a poisoned
   * successor, a removed-self rejoin), and from `#admits` when an install
   * arrives for a different group.
   *
   * Without this the provider outlives the group it describes: through the
   * whole negotiating window `getKeys()` would keep serving the old group's
   * local send key — the one the members who just removed us hold — and every
   * `enable` ack would re-arm the encoder onto it. The publish gate stands in
   * front of that, but not holding the key is the stronger control.
   */
  resetForGroup(): void {
    this.#replayRemotes = [];
    this.#replayLocal = [];
    this.#fence = undefined;
    this.#lastLocalScreenKey = undefined;
    this.#pruneRetainedKeys();
  }

  /**
   * The key set LiveKit is allowed to replay into the worker — ALWAYS the
   * CURRENT install set, never a sixteen-epoch history.
   *
   * 🔴 This override is a send-path invariant. `E2EEManager` re-posts
   * `keyProvider.getKeys()` into the worker on its own schedule, with no way
   * for us to veto it: on EVERY worker `enable` ack (and an `enable` is posted
   * for every remote `TrackPublished` and for every remote publication on each
   * `ConnectionState.Connected`), and on every `SignalConnected`. So a peer
   * unmuting, a screenshare starting, or any reconnect re-runs the whole list
   * through `setKey`. (There is a third site, the `initAck` replay, which is
   * dead in 2.15.13 — it is gated on a worker flag that is declared `false`
   * and never assigned. Treat the list as "at least these", not exhaustive:
   * the override has to hold whatever a future version adds.)
   *
   * Each replayed `setKey` for OUR identity runs `setKeyFromMaterial`, which
   * assigns `currentKeyIndex = keyIndex`, and the encoder encrypts under
   * `cryptoKeyRing[currentKeyIndex]`. The LAST local entry in this list
   * therefore decides which key this device publishes under.
   *
   * `BaseKeyProvider` cannot be trusted to order that list. It stores into a
   * `Map` keyed `` `${identity}-${keyIndex}` ``, and `Map.set` on an existing
   * key keeps the ORIGINAL insertion position. Once the 16-slot keyring has
   * wrapped (epoch >= 16) the local identity's entries are frozen at
   * `local-0 … local-15`, so `super.getKeys()` ends on `local-15` forever —
   * epoch 15's material. From epoch 16 on, the first replay would drop this
   * device back onto that key: a member removed at epoch 16-30 still holds it
   * and could read the media (locked decision 7), while a member added after
   * epoch 15 never had it and goes loud with `MissingKey ... at index 15`. The
   * removed member's side is the silent one, which is the dangerous direction.
   *
   * Serving the current set instead fixes both halves at once: the local key
   * is LAST and current (matching `orderForInstall`, so a replay lands exactly
   * where a fresh install would), and a since-removed sender is simply absent
   * — the old replay re-installed those too (part of the §7.2 residual) and
   * reset every stale index's failure count along the way.
   *
   * The `override` keyword is deliberate: if a LiveKit upgrade renames or
   * drops `getKeys`, `tsc` fails here instead of silently restoring the
   * replay.
   */
  override getKeys(): InstalledKey[] {
    return [...this.#replayRemotes, ...this.#replayLocal];
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
   * group, the fail-safe on an unclassifiable epoch, and the equal-epoch
   * re-assert the session allows.
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
   * Remove-immediate can never transiently regress our send index; (d) never
   * let LiveKit's own `getKeys()` replay reinstate an older epoch behind our
   * back — `getKeys()` is overridden to serve the CURRENT set only (invariant
   * 7 edge). Nothing re-invokes native on reconnect: the sole driver of an
   * install is the native epoch-change push (`state.tsx`'s
   * `onCallKeysChanged` → `mlsCallSession.onLocalKeysChanged`), so the
   * override is what covers the reconnect path, not a re-fetch; (e) never
   * install an epoch the group has moved past, nor keep a replaced group's
   * keys (`#admits` / `resetForGroup`); (f) drop the base class's retained
   * copy of everything no longer served (`#pruneRetainedKeys`).
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
    if (!this.#admits(frameKeys)) return;
    const imported = await this.#import(
      remoteInstallEntries(frameKeys, localIdentity),
    );
    // Re-check across the import: `#import` awaits, so a newer epoch may have
    // installed while we were deriving this one.
    if (!this.#admits(frameKeys)) return;
    // Replace the remote replay set wholesale rather than merging: a sender
    // removed at this epoch is absent from the imported set, and that absence
    // is exactly what stops LiveKit re-installing their key on the next ack.
    this.#publish(imported, "remotes");
    this.#stamp(frameKeys);
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
    if (!this.#admits(frameKeys)) return;
    const entries = localInstallEntries(frameKeys, localIdentity);
    if (entries.length === 0) {
      // 🔴 FAIL LOUD. An egress with no entry for us means native does not
      // count this device as a sender in the current epoch — the shape a
      // removed leaf takes. Resolving here would report the send key installed
      // (`#onLocalKeyInstalled` → `#hasLocalKey = true`, re-secure escalation
      // cancelled, chip green) while the worker keeps publishing under the
      // PREVIOUS epoch's key — the one every member of the group that just
      // removed us holds. Throwing routes to the session's `#onMediaError`,
      // the fail-closed path (§4.2), and leaves `#replayLocal` untouched so the
      // replay keeps mirroring what the worker actually has.
      throw new Error(
        "MLS frame keys carried no entry for this device at epoch " +
          `${frameKeys.epoch} — refusing to report the local send key installed`,
      );
    }
    const imported = await this.#import(entries);
    if (!this.#admits(frameKeys)) return;
    this.#publish(imported, "local");
    this.#stamp(frameKeys);
    await this.#applyLocalScreenKey(frameKeys, localIdentity);
  }

  /**
   * Update + push this device's screen-leg send key (§5.2).
   *
   * Called from `applyLocalKey` and NOWHERE ELSE — deliberately not from
   * `applyRemoteKeys`. During an Add-grace we install remotes at the new epoch
   * while still publishing on the OLD local key for up to 2 s; pushing the new
   * leg key there would switch the phone's send key ahead of the WebView's,
   * and lagging receivers would lose the share for exactly the window the
   * grace exists to cover.
   */
  async #applyLocalScreenKey(
    frameKeys: MlsFrameKeys,
    localIdentity: string,
  ): Promise<void> {
    const entry = localScreenLegEntry(frameKeys, localIdentity);
    if (!entry) return;
    const key: LocalScreenKey = {
      keyB64: entry.frame_key_b64,
      keyIndex: entry.key_index,
      epoch: entry.epoch,
      groupId: frameKeys.group_id,
    };
    const previous = this.#lastLocalScreenKey;
    // Recorded BEFORE the push, and that is correct rather than optimistic:
    // this field answers "what key should the leg be using now", which is the
    // current epoch's whether or not the push landed. A failed push means the
    // listener stops the leg, so nothing is running under the stale key — and
    // a leg started afterwards must be handed THIS key, not the old one.
    this.#lastLocalScreenKey = key;
    // Idempotent: an equal-epoch re-assert re-installs the primary but must
    // not churn the bridge (each push crosses into native and re-keys the
    // sender cryptor).
    if (
      previous &&
      previous.groupId === key.groupId &&
      previous.epoch === key.epoch &&
      previous.keyIndex === key.keyIndex &&
      previous.keyB64 === key.keyB64
    ) {
      return;
    }
    await this.onLocalScreenKey?.(key);
  }

  /**
   * Identities currently keyed (current + previous epoch senders) — DERIVED
   * from the replay set rather than tracked alongside it. Two independent
   * records of "what the worker holds" is the exact shape of the bug the
   * `getKeys()` override exists to fix.
   */
  appliedIdentities(): ReadonlySet<string> {
    return new Set(this.getKeys().map((info) => info.participantIdentity));
  }
}
