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
 *  5. iOS only (phase 2, D2 + R3): `rawKeyBytes` mode hands the worker the
 *     raw HKDF bytes instead of a `CryptoKey` (the patched livekit imports
 *     them inside the worker), and the local send key counts as installed only
 *     once the worker has acked it. Without the option every Chromium shell
 *     (Windows, Linux, Android) keeps the `CryptoKey` path exactly as before.
 *  6. D15: nothing here (or anywhere under `components/`) asks livekit to
 *     ratchet a key. The worker's ratchet reply carries a `CryptoKey`, which
 *     WebKit may fail to clone; `ratchetWindowSize: 0` plus that absence keep
 *     the path unreachable, and the spec scans for it.
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
 * Native returned an epoch with no frame key for THIS device.
 *
 * Typed rather than a bare `Error` because the session treats it differently
 * from every other failure on the rotation path: it is not transient and not
 * worth retrying — native has affirmatively said this device is not a sender
 * at this epoch, which is the shape a REMOVED leaf takes — so it terminates
 * the call's encrypted mode instead of taking the re-securing debounce.
 */
export class MissingLocalFrameKeyError extends Error {
  readonly epoch: number;

  readonly groupId: string;

  constructor(groupId: string, epoch: number) {
    super(
      `MLS frame keys carried no entry for this device at epoch ${epoch} ` +
        `(group ${groupId}) — refusing to report the local send key installed`,
    );
    this.name = "MissingLocalFrameKeyError";
    this.groupId = groupId;
    this.epoch = epoch;
  }
}

/**
 * The E2EE worker did not confirm this device's send key (iOS raw-bytes mode
 * only): the ack came back `ok: false`, never came (timeout), or the ack wait
 * itself failed.
 *
 * Thrown from `applyLocalKey` AFTER the key was posted, so a Remove-driven
 * switch still reaches the worker as early as it can; what the throw refuses
 * is the CLAIM that the local send key is installed. On WebKit a `setKey` the
 * worker could not import leaves the encoder on the PREVIOUS key, so resolving
 * here would report a rotation done while this device still publishes under
 * a key a removed member holds. Carries no key material and no identity.
 */
export class LocalKeyAckError extends Error {
  readonly epoch: number;

  readonly groupId: string;

  readonly keyIndex: number;

  constructor(groupId: string, epoch: number, keyIndex: number) {
    super(
      `the E2EE worker did not confirm this device's send key at epoch ` +
        `${epoch} (index ${keyIndex}, group ${groupId}) — refusing to report ` +
        `the local send key installed`,
    );
    this.name = "LocalKeyAckError";
    this.groupId = groupId;
    this.epoch = epoch;
    this.keyIndex = keyIndex;
  }
}

/** Constructor options for {@link MlsKeyProvider}. */
export interface MlsKeyProviderOptions {
  /**
   * iOS only (D2): hand the worker raw HKDF bytes (`KeyInfo.keyBytes`) on
   * every install AND every replay, instead of a `CryptoKey` it may not be
   * able to clone. Requires `awaitKeyAck`; the constructor throws without it.
   */
  rawKeyBytes?: boolean;
  /**
   * Resolve `true` once the worker acks `setKey` for `(identity, keyIndex)`,
   * `false` on a failed ack or a timeout (`WorkerAckTracker.waitKeyAck`).
   * Called for the LOCAL identity in the same task that posts its key, BEFORE
   * the post. Only consulted when `rawKeyBytes` is set: Chromium shells get no
   * ack gating (R3), so passing it without `rawKeyBytes` changes nothing.
   * Called unbound.
   */
  awaitKeyAck?: (identity: string, keyIndex: number) => Promise<boolean>;
}

/**
 * Zero every `keyBytes` in `dropped` that no key in `served` still uses.
 *
 * The check is by array IDENTITY, and it is what makes zeroing safe: a replay
 * posts whatever `getKeys()` holds, so zeroing an array that is still served
 * would make the next replay hand the worker a key of zeros. Every install
 * creates fresh arrays, so a dropped one is normally never served, but the
 * rule is stated here instead of relying on that.
 */
function scrubKeyBytes(
  dropped: Iterable<KeyInfo>,
  served: readonly KeyInfo[],
): void {
  const live = new Set<Uint8Array>();
  for (const info of served) {
    if (info.keyBytes !== undefined) live.add(info.keyBytes);
  }
  for (const info of dropped) {
    if (info.keyBytes !== undefined && !live.has(info.keyBytes)) {
      info.keyBytes.fill(0);
    }
  }
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
 */
function retainedKeyMap(
  provider: BaseKeyProvider,
): Map<string, KeyInfo> | undefined {
  const map = (provider as unknown as { keyInfoMap?: unknown }).keyInfoMap;
  return map instanceof Map ? (map as Map<string, KeyInfo>) : undefined;
}

/**
 * The ids the base class is still retaining, or `undefined` if its map is no
 * longer reachable. Ids only — a handle on the live map would hand every
 * importer a mutable grip on the `CryptoKey`s the prune exists to shed.
 *
 * Exported for the spec, which asserts the map really does shrink: if a LiveKit
 * upgrade renames the field, the prune silently becomes a no-op, and that spec
 * is what turns the silence into a CI failure.
 */
export function retainedKeyIds(
  provider: BaseKeyProvider,
): string[] | undefined {
  const map = retainedKeyMap(provider);
  return map ? [...map.keys()] : undefined;
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

  /**
   * iOS raw-bytes mode (D2). Fixed at construction: a provider that switched
   * modes mid-call would replay a set whose entries disagree on whether the
   * worker gets bytes or a `CryptoKey`.
   */
  readonly #rawKeyBytes: boolean;

  /** The local key's ack wait; set exactly when `#rawKeyBytes` is. */
  readonly #awaitKeyAck:
    | ((identity: string, keyIndex: number) => Promise<boolean>)
    | undefined;

  constructor(options: MlsKeyProviderOptions = {}) {
    // Fail closed BEFORE anything is built: raw bytes with no ack wait would
    // report the send key installed on nothing but the post, which is the
    // claim the ack exists to back.
    const rawKeyBytes = options.rawKeyBytes === true;
    const awaitKeyAck = options.awaitKeyAck;
    if (rawKeyBytes && typeof awaitKeyAck !== "function") {
      throw new TypeError(
        "MlsKeyProvider: rawKeyBytes requires awaitKeyAck — the local send " +
          "key may only count as installed once the worker acks it",
      );
    }
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 });
    this.#rawKeyBytes = rawKeyBytes;
    this.#awaitKeyAck = rawKeyBytes ? awaitKeyAck : undefined;
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
   *
   * In raw-bytes mode the main-thread import stays, as VALIDATION (D2): bytes
   * the main thread cannot import as HKDF material are refused here, before
   * any of the set is posted, exactly as on Chromium. Each entry then carries
   * its own fresh copy of the bytes, which `#publish` hands the worker and the
   * replay set keeps; copies of a set that fails part-way are zeroed.
   */
  async #import(entries: MlsFrameKey[]): Promise<InstalledKey[]> {
    const imported: InstalledKey[] = [];
    // The entry being imported right now (raw mode), so a throw from its own
    // import zeroes it too, not only the entries already done.
    let inFlight: Uint8Array[] = [];
    try {
      for (const entry of entries) {
        if (!entry.livekit_identity) {
          // Checked HERE, where nothing has been published yet. The base
          // class throws on a keyless identity under `sharedKey:false`, and it
          // throws from inside `onSetEncryptionKey` — i.e. from the middle of
          // `#publish`, after the replay slot has been assigned, which is the
          // one way `#publish` could leave the replay set describing keys the
          // worker never got.
          throw new Error(
            `MLS frame key at index ${entry.key_index} carried no LiveKit identity`,
          );
        }
        const raw = base64ToBytes(entry.frame_key_b64);
        // Copied BEFORE the import: the copy is what the worker gets, and
        // nothing the import does to its argument can reach it.
        const keyBytes = this.#rawKeyBytes ? new Uint8Array(raw) : undefined;
        if (keyBytes !== undefined) inFlight = [raw, keyBytes];
        const material = await crypto.subtle.importKey(
          "raw",
          raw,
          "HKDF",
          false,
          ["deriveBits", "deriveKey"],
        );
        const info: InstalledKey = {
          key: material,
          participantIdentity: entry.livekit_identity,
          keyIndex: entry.key_index,
        };
        if (keyBytes !== undefined) {
          raw.fill(0);
          info.keyBytes = keyBytes;
          inFlight = [];
        }
        imported.push(info);
      }
    } catch (error) {
      for (const bytes of inFlight) bytes.fill(0);
      scrubKeyBytes(imported, []);
      throw error;
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
   *
   * Raw-bytes mode passes each entry's `keyBytes` as the 4th argument, which
   * the patched livekit carries on the emitted `KeyInfo`; `E2EEManager.postKey`
   * then sends `keyBytes` and no `CryptoKey`. The replay reads the SAME
   * `InstalledKey` objects through `getKeys()` and goes through the same
   * `postKey`, so a replay carries the bytes too. The arrays of the set this
   * replaces are zeroed once the new set is posted (`postMessage` copies
   * synchronously, so nothing still in flight refers to them).
   */
  #publish(infos: InstalledKey[], slot: "remotes" | "local"): void {
    const outgoing =
      slot === "remotes" ? this.#replayRemotes : this.#replayLocal;
    if (slot === "remotes") this.#replayRemotes = infos;
    else this.#replayLocal = infos;
    for (const info of infos) {
      if (this.#rawKeyBytes) {
        this.onSetEncryptionKey(
          info.key,
          info.participantIdentity,
          info.keyIndex,
          info.keyBytes,
        );
        continue;
      }
      // BaseKeyProvider.onSetEncryptionKey(keyMaterial, identity, keyIndex).
      this.onSetEncryptionKey(
        info.key,
        info.participantIdentity,
        info.keyIndex,
      );
    }
    this.#pruneRetainedKeys();
    scrubKeyBytes(outgoing, this.getKeys());
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
    const served = this.getKeys();
    const live = new Set(served.map(retainedId));
    const pruned: KeyInfo[] = [];
    for (const [id, info] of [...retained]) {
      if (live.has(id)) continue;
      retained.delete(id);
      pruned.push(info);
    }
    // Raw mode: the base class's record shares the replay entry's array, so
    // this is normally already zero; it is zeroed here too in case not.
    scrubKeyBytes(pruned, served);
  }

  /**
   * The egress's epoch, or a fail-closed throw.
   *
   * An egress with no usable epoch cannot be fenced, and admitting it unfenced
   * would be worse than refusing it: the fence would stay parked on the older
   * epoch, so every LATER superseded install would be admitted too — a
   * malformed field would switch the fence off rather than pass through it.
   * Native types this as a required number and `#applyLocalScreenKey` already
   * trusts the per-entry copy of it, so a missing one is a broken bridge, and
   * the session's re-securing debounce is where a broken bridge belongs.
   */
  #epochOf(frameKeys: MlsFrameKeys): number {
    if (!Number.isFinite(frameKeys.epoch)) {
      throw new Error(
        `MLS frame keys carried no usable epoch (${String(frameKeys.epoch)}) ` +
          `for group ${frameKeys.group_id}`,
      );
    }
    return frameKeys.epoch;
  }

  /**
   * Whether an install may proceed, given what is already in force.
   *
   * Within one group the rule is monotonic: an equal epoch is an idempotent
   * re-assert (the Add-grace's deferred local install rides one), a lower one
   * has been superseded and must do nothing.
   *
   * 🔴 The GROUP half is deliberately weaker, and the session owns it. A
   * different group resets rather than compares, because epochs only count
   * within one group and a cross-group number is neither newer nor older — but
   * that means the provider trusts ARRIVAL ORDER to say which group is
   * current, so a late install for an abandoned group would replace a live
   * one's keys. Nothing can reach that today: the session re-checks
   * `groupId !== this.#groupId` after its fetch, and `#resetRotationState`
   * cancels the grace timer before any group swap. A caller that wants the
   * provider to enforce it must hand it the authoritative group id; this fence
   * restates the EPOCH invariant only.
   */
  #admits(groupId: string, epoch: number): boolean {
    const fence = this.#fence;
    if (!fence) return true;
    if (fence.groupId !== groupId) {
      this.resetForGroup();
      return true;
    }
    return epoch >= fence.epoch;
  }

  /** Record the epoch now in force (see `#admits`). */
  #stamp(groupId: string, epoch: number): void {
    this.#fence = { groupId, epoch };
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
    const dropped = this.getKeys();
    this.#replayRemotes = [];
    this.#replayLocal = [];
    this.#fence = undefined;
    this.#lastLocalScreenKey = undefined;
    this.#pruneRetainedKeys();
    // Raw mode: nothing is served any more, so every dropped array is zeroed.
    scrubKeyBytes(dropped, this.getKeys());
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
   *
   * Raw-bytes mode: every entry carries its `keyBytes`, and every replay site
   * (`initAck`, `enable`, `SignalConnected`) hands the entry itself to
   * `postKey`, so a replay posts the bytes exactly as the install did, never
   * a `CryptoKey` alone.
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
    const epoch = this.#epochOf(frameKeys);
    if (!this.#admits(frameKeys.group_id, epoch)) return;
    const imported = await this.#import(
      remoteInstallEntries(frameKeys, localIdentity),
    );
    // Re-check across the import: `#import` awaits, so a newer epoch may have
    // installed while we were deriving this one.
    if (!this.#admits(frameKeys.group_id, epoch)) {
      scrubKeyBytes(imported, []);
      return;
    }
    // Replace the remote replay set wholesale rather than merging: a sender
    // removed at this epoch is absent from the imported set, and that absence
    // is exactly what stops LiveKit re-installing their key on the next ack.
    this.#publish(imported, "remotes");
    this.#stamp(frameKeys.group_id, epoch);
  }

  /**
   * Install the current-epoch LOCAL send key — THE send-index switch (§1.5),
   * always the final `onSetEncryptionKey`. Immediate rotations call it inline
   * via `applyKeys`; Add-driven rotations call it after the epoch-fenced grace.
   *
   * Raw-bytes mode (iOS, D2): resolves only once the worker has acked the new
   * local key, and throws {@link LocalKeyAckError} if it does not (`ok:
   * false`, a timeout, a failed wait). Remote keys are not ack-gated.
   */
  async applyLocalKey(
    frameKeys: MlsFrameKeys,
    localIdentity: string,
  ): Promise<void> {
    const epoch = this.#epochOf(frameKeys);
    if (!this.#admits(frameKeys.group_id, epoch)) return;
    const entries = localInstallEntries(frameKeys, localIdentity);
    if (entries.length === 0) {
      // 🔴 FAIL LOUD, TERMINALLY. An egress with no entry for us means native
      // does not count this device as a sender in the current epoch — the shape
      // a removed leaf takes. Resolving here would report the send key
      // installed (`#onLocalKeyInstalled` → `#hasLocalKey = true`, re-secure
      // escalation cancelled, chip green) while the worker keeps publishing
      // under the PREVIOUS epoch's key — the one every member of the group that
      // just removed us holds.
      //
      // The TYPE matters as much as the throw: the session routes this one
      // error past the re-securing debounce (which any remote's encrypted
      // status would clear inside 10 s, and which keeps publishing meanwhile)
      // to a paused, non-clearable terminus. `#replayLocal` is left untouched
      // so the replay keeps mirroring what the worker actually has.
      throw new MissingLocalFrameKeyError(frameKeys.group_id, epoch);
    }
    const imported = await this.#import(entries);
    if (!this.#admits(frameKeys.group_id, epoch)) {
      scrubKeyBytes(imported, []);
      return;
    }
    // 🔴 Raw mode (R13a): the ack wait is registered HERE, in the same task
    // as the post and BEFORE it. `waitKeyAck` withdraws any earlier ack for
    // the pair when it registers (indices repeat every 16 epochs), so a wait
    // started after the post could miss the fresh ack, and one started after
    // an `await` could be satisfied by nothing newer than the post.
    const acks = this.#registerKeyAcks(imported);
    this.#publish(imported, "local");
    this.#stamp(frameKeys.group_id, epoch);
    await this.#applyLocalScreenKey(frameKeys, localIdentity);
    await this.#confirmKeyAcks(acks, frameKeys.group_id, epoch);
  }

  /**
   * Start one ack wait per local entry (raw mode; none otherwise). Each wait
   * settles to a plain boolean: a rejecting or throwing `awaitKeyAck` counts
   * as "not acked", never as an unhandled rejection or an install that skips
   * the post.
   */
  #registerKeyAcks(
    infos: InstalledKey[],
  ): { keyIndex: number; acked: Promise<boolean> }[] {
    const awaitKeyAck = this.#awaitKeyAck;
    if (!this.#rawKeyBytes || awaitKeyAck === undefined) return [];
    return infos.map((info) => {
      let acked: Promise<boolean>;
      try {
        acked = Promise.resolve(
          awaitKeyAck(info.participantIdentity, info.keyIndex),
        ).then(
          (ok) => ok === true,
          () => false,
        );
      } catch {
        acked = Promise.resolve(false);
      }
      return { keyIndex: info.keyIndex, acked };
    });
  }

  /**
   * Claim the local key installed only if the worker acked every local
   * entry; otherwise throw {@link LocalKeyAckError}. The key stays posted and
   * replayable either way: the replay set mirrors what was SENT, and the
   * throw takes the session's media-error path.
   */
  async #confirmKeyAcks(
    acks: { keyIndex: number; acked: Promise<boolean> }[],
    groupId: string,
    epoch: number,
  ): Promise<void> {
    for (const { keyIndex, acked } of acks) {
      if (!(await acked)) throw new LocalKeyAckError(groupId, epoch, keyIndex);
    }
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
    if (!entry) {
      // Clear the stale key so a later start refuses on "no key".
      this.#lastLocalScreenKey = undefined;
      return;
    }
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
}
